//! Firewall integration.
//!
//! Rules are applied through a single `nft -f -` transaction; persistence picks
//! the first mechanism that works on this system:
//!
//! 1. fw4 chain-pre includes (`/usr/share/nftables.d/chain-pre/*`) when
//!    `firewall4` ships them and `auto_includes` is on,
//! 2. the `/etc/firewall4.user` hook otherwise,
//! 3. a standalone `table inet flowcone` when there is no fw4 at all.
//!
//! The layer in use is logged when it changes.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};

mod fw4;
mod nft;

pub(crate) use fw4::*;
pub(crate) use nft::*;

/// Persistence layer used by the last sync.
static LAST_LAYER: AtomicU8 = AtomicU8::new(u8::MAX);

fn report_layer(layer: u8, name: &str, verbose: bool) {
    if LAST_LAYER.swap(layer, Ordering::Relaxed) != layer || verbose {
        println!("flowcone: firewall rules persisted via {}", name);
    }
}

/// Sync the firewall rules with the current address/protocol state, in one
/// transaction so no rule is missing in between.
pub(crate) fn sync_fw4_rules(
    iface: &str,
    min_port: u16,
    max_port: u16,
    enable_v4: bool,
    enable_v6: bool,
    verbose: bool,
) {
    check_hardware_offload_warning();
    let is_v6_masq = is_ipv6_masq_enabled();

    // Rules injected by an earlier run, from any table/chain.
    let deletes = nft_ruleset_text()
        .map(|text| build_delete_script(&find_all_flowcone_rules(&text)))
        .unwrap_or_default();

    if has_table_inet_fw4() {
        let native_includes = use_chain_pre();
        let body = build_fw4_insert_script(iface, enable_v4, enable_v6, is_v6_masq);
        nft_apply_with_fallback(&deletes, &body, "inet fw4 rule sync");

        if native_includes {
            update_chain_pre_files(iface, enable_v4, enable_v6, is_v6_masq);
            clean_firewall4_user_file();
        } else {
            clean_chain_pre_files();
            update_firewall4_user_file(iface, enable_v4, enable_v6, is_v6_masq);
        }

        if native_includes {
            report_layer(1, "fw4 chain-pre includes", verbose);
        } else {
            report_layer(2, "/etc/firewall4.user", verbose);
        }
        if verbose {
            println!(
                "flowcone: synced inet fw4 rules (iface {}, v4={}, v6={}, masq6={}, ports {}-{})",
                iface, enable_v4, enable_v6, is_v6_masq, min_port, max_port
            );
        }
        return;
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
        // nft does not flush a re-defined table, so delete it first.
        body.push_str("delete table inet flowcone\n");
    }

    let standalone = postrouting_nat_chains.is_empty() && forward_filter_chains.is_empty();
    if standalone {
        // No firewall: only the standalone table (forward accept) is needed.
        body.push_str(&generate_standalone_script(iface));
    } else {
        body.push_str(&build_primary_insert_script(
            iface,
            &postrouting_nat_chains,
            enable_v4,
            enable_v6,
            is_v6_masq,
        ));
        if enable_v4 || enable_v6 {
            for c in &forward_filter_chains {
                for fwd in generate_fw4_forward_rules() {
                    body.push_str(&format!(
                        "insert rule {} {} {} {}\n",
                        c.family, c.table, c.name, fwd
                    ));
                }
            }
        }
    }

    nft_apply_with_fallback(&deletes, &body, "Linux firewall rule sync");

    if standalone {
        report_layer(4, "standalone table inet flowcone", verbose);
    } else {
        report_layer(3, "existing nftables chains", verbose);
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
}

pub(crate) fn remove_rules(verbose: bool) {
    clean_chain_pre_files();
    clean_firewall4_user_file();
    delete_all_injected_rules(verbose);

    let _ = Command::new("nft")
        .args(["delete", "table", "inet", "flowcone"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output();

    if verbose {
        println!("flowcone: cleaned firewall rules");
    }
}
