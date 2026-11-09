//! nftables integration.
//!
//! Live exemption rules reference timeout sets refreshed by the daemon.
//! If the daemon exits, the elements expire and normal firewall rules resume.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};

mod fw4;
mod netlink;
mod nft;

pub(crate) use fw4::*;
pub(crate) use nft::*;

static LAST_LAYER: AtomicU8 = AtomicU8::new(u8::MAX);

#[derive(Clone, Copy)]
pub(crate) struct FirewallConfig<'a> {
    pub iface: &'a str,
    pub enable_v4: bool,
    pub enable_v6: bool,
    pub is_v6_masq: bool,
    pub mark: u32,
    pub bypass_mask: u32,
    pub bypass_val: u32,
    pub verbose: bool,
}

fn report_layer(layer: u8, name: &str, verbose: bool) {
    if LAST_LAYER.swap(layer, Ordering::Relaxed) != layer || verbose {
        println!("flowcone: firewall rules persisted via {}", name);
    }
}

/// Sync firewall rules with the current address/protocol state.
/// Returns true only if the kernel transaction succeeded.
pub(crate) fn sync_fw4_rules(cfg: &FirewallConfig<'_>) -> bool {
    let FirewallConfig {
        iface,
        enable_v4,
        enable_v6,
        is_v6_masq,
        mark,
        bypass_mask,
        bypass_val,
        verbose,
    } = *cfg;
    check_hardware_offload_warning();

    let deletes = nft_ruleset_text()
        .map(|text| build_delete_script(&find_all_flowcone_rules(&text)))
        .unwrap_or_default();

    if has_table_inet_fw4() {
        clear_generic_tables();
        let native_includes = use_chain_pre();
        let set_file_ok = write_fw4_set_definitions();
        if !ensure_fw4_sets() {
            eprintln!("flowcone: error: could not create fw4 liveness sets");
            return false;
        }
        let body = build_fw4_insert_script_live(
            iface,
            enable_v4,
            enable_v6,
            mark,
            bypass_mask,
            bypass_val,
        );
        let ok = nft_apply_with_fallback(&deletes, &body, "inet fw4 rule sync");
        if ok {
            let chain_pre_ok = native_includes
                && update_chain_pre_files_live(
                    iface,
                    enable_v4,
                    enable_v6,
                    mark,
                    bypass_mask,
                    bypass_val,
                );
            if native_includes && set_file_ok && chain_pre_ok {
                clean_firewall4_user_file();
            } else {
                if native_includes && (!set_file_ok || !chain_pre_ok) {
                    eprintln!("flowcone: error: could not persist fw4 chain-pre rules");
                }
                clean_chain_pre_files();
                clean_firewall4_user_file();
            }
            refresh_fw4_liveness(enable_v4, enable_v6, is_v6_masq, verbose);
            if native_includes && set_file_ok && chain_pre_ok {
                report_layer(1, "fw4 chain-pre includes", verbose);
            } else {
                report_layer(2, "live fw4 rules (reload is recovered by SIGHUP)", verbose);
            }
        } else {
            eprintln!("flowcone: error: fw4 firewall sync failed");
        }
        if verbose {
            println!(
                "flowcone: synced inet fw4 rules (iface {}, v4={}, v6={}, masq6={}, mark {:#x})",
                iface, enable_v4, enable_v6, is_v6_masq, mark
            );
        }
        return ok;
    }

    let base_chains = get_existing_base_chains();
    let postrouting_nat_chains: Vec<&NftBaseChain> = base_chains
        .iter()
        .filter(|c| c.hook == "postrouting" && c.chain_type == "nat")
        .collect();
    let forward_filter_chains: Vec<&NftBaseChain> = base_chains
        .iter()
        .filter(|c| c.hook == "forward" && c.chain_type == "filter")
        .collect();

    let mut body = String::new();
    if nft_table_exists("inet", "flowcone") {
        body.push_str("delete table inet flowcone\n");
    }

    let standalone = postrouting_nat_chains.is_empty() && forward_filter_chains.is_empty();
    let mut generic_tables = Vec::new();
    if standalone {
        body.push_str(&generate_standalone_script_live(cfg));
    } else {
        generic_tables = collect_generic_tables(
            &postrouting_nat_chains,
            &forward_filter_chains,
            enable_v4,
            enable_v6,
        );
        if !ensure_generic_sets(&generic_tables) {
            eprintln!("flowcone: error: could not create generic firewall timeout sets");
            return false;
        }
        body.push_str(&build_generic_insert_script(
            iface,
            &postrouting_nat_chains,
            &forward_filter_chains,
            enable_v4,
            enable_v6,
            mark,
            bypass_mask,
            bypass_val,
        ));
    }

    let ok = nft_apply_with_fallback(&deletes, &body, "Linux firewall rule sync");
    if ok {
        if standalone {
            clear_generic_tables();
            refresh_standalone_liveness(enable_v4, enable_v6, is_v6_masq, verbose);
            report_layer(4, "standalone table inet flowcone", verbose);
        } else {
            store_generic_tables(generic_tables);
            report_layer(3, "existing nftables chains", verbose);
        }
    } else {
        eprintln!("flowcone: error: Linux firewall rule sync failed");
    }

    if verbose {
        println!(
            "flowcone: synced Linux firewall rules (iface {}, v4={}, v6={}, srcnat chains={}, forward chains={})",
            iface,
            enable_v4,
            enable_v6,
            postrouting_nat_chains.len(),
            forward_filter_chains.len()
        );
    }
    ok
}

/// Refresh liveness set timeouts.
pub(crate) fn refresh_liveness(
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
    verbose: bool,
) -> bool {
    match LAST_LAYER.load(Ordering::Relaxed) {
        1 | 2 => refresh_fw4_liveness(enable_v4, enable_v6, is_v6_masq, verbose),
        3 => refresh_generic_liveness(is_v6_masq, verbose),
        4 => refresh_standalone_liveness(enable_v4, enable_v6, is_v6_masq, verbose),
        _ => false,
    }
}

pub(crate) fn liveness_supported() -> bool {
    if LAST_LAYER.load(Ordering::Relaxed) == 3 && generic_liveness_supported() {
        return true;
    }
    has_table_inet_fw4() || nft_table_exists("inet", "flowcone")
}

pub(crate) fn remove_rules(verbose: bool) {
    clean_chain_pre_files();
    clean_firewall4_user_file();
    clean_fw4_set_definitions();
    delete_all_injected_rules(verbose);
    remove_generic_sets(verbose);

    if has_table_inet_fw4() {
        remove_fw4_sets();
    }

    let _ = Command::new("nft")
        .args(["delete", "table", "inet", "flowcone"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();

    if verbose {
        println!("flowcone: cleaned firewall rules");
    }
}
