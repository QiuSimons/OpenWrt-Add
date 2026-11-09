//! nftables command channel, rule discovery and the standalone table used on
//! systems without fw4.

use super::FirewallConfig;
use super::fw4::LIVENESS_TIMEOUT_SEC;
use std::io::Write;
use std::process::{Command, Stdio};

use super::fw4::{
    SET_FWD4, SET_FWD6, SET_V4, SET_V6, generate_live_forward_rule_v4,
    generate_live_forward_rule_v6, generate_live_srcnat_rule_v4, generate_live_srcnat_rule_v6,
    set_definitions, v6_elements,
};

use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GenericTable {
    pub family: String,
    pub table: String,
    pub src_v4: bool,
    pub src_v6: bool,
    pub fwd_v4: bool,
    pub fwd_v6: bool,
}

static GENERIC_TABLES: Mutex<Vec<GenericTable>> = Mutex::new(Vec::new());

fn generic_lock() -> std::sync::MutexGuard<'static, Vec<GenericTable>> {
    match GENERIC_TABLES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) fn clear_generic_tables() {
    generic_lock().clear();
}

pub(crate) fn generic_tables_snapshot() -> Vec<GenericTable> {
    generic_lock().clone()
}

pub(crate) fn store_generic_tables(tables: Vec<GenericTable>) {
    *generic_lock() = tables;
}

fn collect_table(
    out: &mut Vec<GenericTable>,
    family: &str,
    table: &str,
    src_v4: bool,
    src_v6: bool,
    fwd_v4: bool,
    fwd_v6: bool,
) {
    if !(src_v4 || src_v6 || fwd_v4 || fwd_v6) {
        return;
    }
    if let Some(existing) = out
        .iter_mut()
        .find(|t| t.family == family && t.table == table)
    {
        existing.src_v4 |= src_v4;
        existing.src_v6 |= src_v6;
        existing.fwd_v4 |= fwd_v4;
        existing.fwd_v6 |= fwd_v6;
    } else {
        out.push(GenericTable {
            family: family.to_string(),
            table: table.to_string(),
            src_v4,
            src_v6,
            fwd_v4,
            fwd_v6,
        });
    }
}

pub(crate) fn collect_generic_tables(
    src_chains: &[&NftBaseChain],
    fwd_chains: &[&NftBaseChain],
    enable_v4: bool,
    enable_v6: bool,
) -> Vec<GenericTable> {
    let mut out = Vec::new();
    for c in src_chains {
        match c.family.as_str() {
            "inet" => collect_table(
                &mut out, "inet", &c.table, enable_v4, enable_v6, false, false,
            ),
            "ip" => collect_table(&mut out, "ip", &c.table, enable_v4, false, false, false),
            "ip6" => collect_table(&mut out, "ip6", &c.table, false, enable_v6, false, false),
            _ => {}
        }
    }
    for c in fwd_chains {
        match c.family.as_str() {
            "inet" => collect_table(
                &mut out, "inet", &c.table, false, false, enable_v4, enable_v6,
            ),
            "ip" => collect_table(&mut out, "ip", &c.table, false, false, enable_v4, false),
            "ip6" => collect_table(&mut out, "ip6", &c.table, false, false, false, enable_v6),
            _ => {}
        }
    }
    out
}

fn set_name(v6: bool, forward: bool) -> &'static str {
    match (v6, forward) {
        (false, false) => SET_V4,
        (true, false) => SET_V6,
        (false, true) => SET_FWD4,
        (true, true) => SET_FWD6,
    }
}

fn ensure_one_set(family: &str, table: &str, name: &str, v6: bool) -> bool {
    if nft_output(&["list", "set", family, table, name]).is_some() {
        return true;
    }
    let set_type = if v6 { "ipv6_addr" } else { "ipv4_addr" };
    let script =
        format!("add set {family} {table} {name} {{ type {set_type}; flags interval,timeout; }}\n");
    nft_apply(&script).is_ok()
}

pub(crate) fn ensure_generic_sets(tables: &[GenericTable]) -> bool {
    for t in tables {
        for (v6, src, fwd) in [(false, t.src_v4, t.fwd_v4), (true, t.src_v6, t.fwd_v6)] {
            if src && !ensure_one_set(&t.family, &t.table, set_name(v6, false), v6) {
                return false;
            }
            if fwd && !ensure_one_set(&t.family, &t.table, set_name(v6, true), v6) {
                return false;
            }
        }
    }
    true
}

fn strip_nfproto(rule: String, token: &str) -> String {
    rule.replacen(token, "", 1)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_generic_insert_script(
    iface: &str,
    src_chains: &[&NftBaseChain],
    fwd_chains: &[&NftBaseChain],
    enable_v4: bool,
    enable_v6: bool,
    mark: u32,
    bypass_mask: u32,
    bypass_val: u32,
) -> String {
    let mut script = String::new();
    for c in src_chains {
        match c.family.as_str() {
            "inet" => {
                if enable_v4 {
                    script.push_str(&format!(
                        "insert rule inet {} {} {}\n",
                        c.table,
                        c.name,
                        generate_live_srcnat_rule_v4(iface, bypass_mask, bypass_val)
                    ));
                }
                if enable_v6 {
                    script.push_str(&format!(
                        "insert rule inet {} {} {}\n",
                        c.table,
                        c.name,
                        generate_live_srcnat_rule_v6(iface, bypass_mask, bypass_val)
                    ));
                }
            }
            "ip" if enable_v4 => script.push_str(&format!(
                "insert rule ip {} {} {}\n",
                c.table,
                c.name,
                strip_nfproto(
                    generate_live_srcnat_rule_v4(iface, bypass_mask, bypass_val),
                    "meta nfproto ipv4 "
                )
            )),
            "ip6" if enable_v6 => script.push_str(&format!(
                "insert rule ip6 {} {} {}\n",
                c.table,
                c.name,
                strip_nfproto(
                    generate_live_srcnat_rule_v6(iface, bypass_mask, bypass_val),
                    "meta nfproto ipv6 "
                )
            )),
            _ => {}
        }
    }
    for c in fwd_chains {
        match c.family.as_str() {
            "inet" => {
                if enable_v4 {
                    script.push_str(&format!(
                        "insert rule inet {} {} {}\n",
                        c.table,
                        c.name,
                        generate_live_forward_rule_v4(iface, mark)
                    ));
                }
                if enable_v6 {
                    script.push_str(&format!(
                        "insert rule inet {} {} {}\n",
                        c.table,
                        c.name,
                        generate_live_forward_rule_v6(iface, mark)
                    ));
                }
            }
            "ip" if enable_v4 => script.push_str(&format!(
                "insert rule ip {} {} {}\n",
                c.table,
                c.name,
                generate_live_forward_rule_v4(iface, mark)
            )),
            "ip6" if enable_v6 => script.push_str(&format!(
                "insert rule ip6 {} {} {}\n",
                c.table,
                c.name,
                generate_live_forward_rule_v6(iface, mark)
            )),
            _ => {}
        }
    }
    script
}

/// Standalone NAT table used when the system has no nftables chains at all.
/// It contains liveness sets, the FlowCone UDP exemption, and a normal
/// masquerade fallback for TCP/ICMP and for the moments when the daemon is
/// down (the set elements expire and the maquerade path takes over).
pub(crate) fn generate_standalone_script_live(cfg: &FirewallConfig<'_>) -> String {
    let FirewallConfig {
        iface,
        enable_v4,
        enable_v6,
        is_v6_masq,
        mark,
        bypass_mask,
        bypass_val,
        ..
    } = *cfg;
    if !enable_v4 && !enable_v6 {
        return String::new();
    }
    let mut s = String::new();
    s.push_str("table inet flowcone {\n");
    s.push_str(&set_definitions());
    s.push_str("    chain forward {\n");
    s.push_str("        type filter hook forward priority filter - 1; policy accept;\n");
    if enable_v4 {
        s.push_str(&format!(
            "        {}\n",
            generate_live_forward_rule_v4(iface, mark)
        ));
    }
    if enable_v6 {
        s.push_str(&format!(
            "        {}\n",
            generate_live_forward_rule_v6(iface, mark)
        ));
    }
    s.push_str("    }\n");
    s.push_str("    chain srcnat {\n");
    s.push_str("        type nat hook postrouting priority srcnat - 1; policy accept;\n");
    if enable_v4 {
        s.push_str(&format!(
            "        {}\n",
            generate_live_srcnat_rule_v4(iface, bypass_mask, bypass_val)
        ));
        s.push_str(&format!(
            "        meta nfproto ipv4 ip saddr != 0.0.0.0/8 oifname \"{iface}\" counter masquerade comment \"flowcone\"\n"
        ));
    }
    if enable_v6 {
        s.push_str(&format!(
            "        {}\n",
            generate_live_srcnat_rule_v6(iface, bypass_mask, bypass_val)
        ));
        if is_v6_masq {
            s.push_str(&format!(
                "        meta nfproto ipv6 ip6 saddr != fe80::/10 oifname \"{iface}\" counter masquerade comment \"flowcone\"\n"
            ));
        } else {
            s.push_str(&format!(
                "        meta nfproto ipv6 ip6 saddr fc00::/7 oifname \"{iface}\" counter masquerade comment \"flowcone\"\n"
            ));
        }
    }
    s.push_str("    }\n");
    s.push_str("}\n");
    s
}

pub(crate) fn generic_liveness_supported() -> bool {
    !generic_tables_snapshot().is_empty()
}

fn refresh_generic_table_cli(t: &GenericTable, is_v6_masq: bool) -> bool {
    let mut script = String::new();
    if t.src_v4 {
        let elements = flowcone_common::INTERNAL_V4_PREFIXES
            .iter()
            .map(|p| format!("{} timeout {}s", p, LIVENESS_TIMEOUT_SEC))
            .collect::<Vec<_>>()
            .join(", ");
        script.push_str(&format!("flush set {} {} {}\n", t.family, t.table, SET_V4));
        script.push_str(&format!(
            "add element {} {} {} {{ {} }}\n",
            t.family, t.table, SET_V4, elements
        ));
    }
    if t.fwd_v4 {
        script.push_str(&format!(
            "flush set {} {} {}\n",
            t.family, t.table, SET_FWD4
        ));
        script.push_str(&format!(
            "add element {} {} {} {{ 0.0.0.0/0 timeout {}s }}\n",
            t.family, t.table, SET_FWD4, LIVENESS_TIMEOUT_SEC
        ));
    }
    if t.src_v6 {
        script.push_str(&format!("flush set {} {} {}\n", t.family, t.table, SET_V6));
        script.push_str(&format!(
            "add element {} {} {} {{ {} }}\n",
            t.family,
            t.table,
            SET_V6,
            v6_elements(is_v6_masq)
        ));
    }
    if t.fwd_v6 {
        script.push_str(&format!(
            "flush set {} {} {}\n",
            t.family, t.table, SET_FWD6
        ));
        script.push_str(&format!(
            "add element {} {} {} {{ ::/0 timeout {}s }}\n",
            t.family, t.table, SET_FWD6, LIVENESS_TIMEOUT_SEC
        ));
    }
    if script.is_empty() {
        return true;
    }
    nft_apply(&script).is_ok()
}

fn refresh_generic_table(t: &GenericTable, is_v6_masq: bool, verbose: bool) -> bool {
    let v4 = t.src_v4 || t.fwd_v4;
    let v6 = t.src_v6 || t.fwd_v6;
    // The netlink batch refreshes both the src and the forward set of an
    // enabled family. Only use it when the table actually has both; a table
    // with just one would fail every refresh and fall back to CLI anyway.
    let netlink_sets_match = t.src_v4 == t.fwd_v4 && t.src_v6 == t.fwd_v6;
    if t.family == "inet" && netlink_sets_match {
        match super::netlink::refresh_liveness_netlink(&t.table, v4, v6, is_v6_masq) {
            Ok(()) => return true,
            Err(e) if verbose => eprintln!(
                "flowcone: netlink generic liveness refresh failed for {} {} ({}), falling back to CLI",
                t.family, t.table, e
            ),
            Err(_) => {}
        }
    }
    refresh_generic_table_cli(t, is_v6_masq)
}

pub(crate) fn refresh_generic_liveness(is_v6_masq: bool, verbose: bool) -> bool {
    let tables = generic_tables_snapshot();
    if tables.is_empty() {
        return false;
    }
    for t in &tables {
        if !refresh_generic_table(t, is_v6_masq, verbose) {
            if verbose {
                eprintln!(
                    "flowcone: generic liveness refresh failed for {} {}",
                    t.family, t.table
                );
            }
            return false;
        }
    }
    true
}

pub(crate) fn remove_generic_sets(verbose: bool) {
    let tables = generic_tables_snapshot();
    for t in &tables {
        for (v6, src, fwd) in [(false, t.src_v4, t.fwd_v4), (true, t.src_v6, t.fwd_v6)] {
            if src {
                let _ = Command::new("nft")
                    .args(["delete", "set", &t.family, &t.table, set_name(v6, false)])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            if fwd {
                let _ = Command::new("nft")
                    .args(["delete", "set", &t.family, &t.table, set_name(v6, true)])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
    }
    clear_generic_tables();
    if verbose {
        println!("flowcone: removed generic liveness sets");
    }
}

/// Refresh the liveness set elements in the standalone table.
pub(crate) fn refresh_standalone_liveness(
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
    verbose: bool,
) -> bool {
    if !nft_table_exists("inet", "flowcone") {
        return false;
    }
    match super::netlink::refresh_liveness_netlink("flowcone", enable_v4, enable_v6, is_v6_masq) {
        Ok(()) => return true,
        Err(e) if verbose => {
            eprintln!(
                "flowcone: netlink standalone liveness refresh failed ({}), falling back to CLI",
                e
            );
        }
        Err(_) => {}
    }

    let mut script = String::new();
    if enable_v4 {
        let elements = flowcone_common::INTERNAL_V4_PREFIXES
            .iter()
            .map(|p| format!("{} timeout {}s", p, LIVENESS_TIMEOUT_SEC))
            .collect::<Vec<_>>()
            .join(", ");
        script.push_str(&format!("flush set inet flowcone {}\n", SET_V4));
        script.push_str(&format!(
            "add element inet flowcone {} {{ {} }}\n",
            SET_V4, elements
        ));
        script.push_str(&format!("flush set inet flowcone {}\n", SET_FWD4));
        script.push_str(&format!(
            "add element inet flowcone {} {{ 0.0.0.0/0 timeout {}s }}\n",
            SET_FWD4, LIVENESS_TIMEOUT_SEC
        ));
    }
    if enable_v6 {
        script.push_str(&format!("flush set inet flowcone {}\n", SET_V6));
        script.push_str(&format!(
            "add element inet flowcone {} {{ {} }}\n",
            SET_V6,
            v6_elements(is_v6_masq)
        ));
        script.push_str(&format!("flush set inet flowcone {}\n", SET_FWD6));
        script.push_str(&format!(
            "add element inet flowcone {} {{ ::/0 timeout {}s }}\n",
            SET_FWD6, LIVENESS_TIMEOUT_SEC
        ));
    }
    if script.is_empty() {
        return true;
    }
    match nft_apply(&script) {
        Ok(()) => true,
        Err(e) => {
            if verbose {
                eprintln!("flowcone: standalone liveness refresh failed: {}", e);
            }
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NftBaseChain {
    pub family: String,
    pub table: String,
    pub name: String,
    pub hook: String,
    pub chain_type: String,
    pub prio: String,
}

/// Parse nftables chains from `nft list chains` to find all base chains with hooks and types
pub(crate) fn parse_nft_base_chains(output: &str) -> Vec<NftBaseChain> {
    let mut chains = Vec::new();
    let mut current_family = String::new();
    let mut current_table = String::new();
    let mut current_chain = String::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("table ") {
            if let Some(brace_idx) = trimmed.find('{') {
                let table_part = trimmed[6..brace_idx].trim();
                let parts: Vec<&str> = table_part.split_whitespace().collect();
                if parts.len() >= 2 {
                    current_family = parts[0].to_string();
                    current_table = parts[1].to_string();
                }
            }
        } else if trimmed.starts_with("chain ") {
            if let Some(brace_idx) = trimmed.find('{') {
                let chain_part = trimmed[6..brace_idx].trim();
                current_chain = chain_part.to_string();
            }
        } else if trimmed.contains("hook ") && trimmed.contains("type ") {
            let mut chain_type = String::new();
            let mut hook = String::new();
            let mut prio = String::new();

            let tokens: Vec<&str> = trimmed
                .split(';')
                .next()
                .unwrap_or("")
                .split_whitespace()
                .collect();
            let mut i = 0;
            while i < tokens.len() {
                if tokens[i] == "type" && i + 1 < tokens.len() {
                    chain_type = tokens[i + 1].to_string();
                    i += 2;
                } else if tokens[i] == "hook" && i + 1 < tokens.len() {
                    hook = tokens[i + 1].to_string();
                    i += 2;
                } else if tokens[i] == "priority" && i + 1 < tokens.len() {
                    prio = tokens[i + 1..].join(" ");
                    break;
                } else {
                    i += 1;
                }
            }

            if !current_table.is_empty() && !current_chain.is_empty() && !hook.is_empty() {
                chains.push(NftBaseChain {
                    family: current_family.clone(),
                    table: current_table.clone(),
                    name: current_chain.clone(),
                    hook,
                    chain_type,
                    prio,
                });
            }
        } else if trimmed == "}" {
            current_chain.clear();
        }
    }

    chains
}

pub(crate) fn get_existing_base_chains() -> Vec<NftBaseChain> {
    let Ok(out) = Command::new("nft").args(["list", "chains"]).output() else {
        return Vec::new();
    };
    if out.status.success() {
        return parse_nft_base_chains(&String::from_utf8_lossy(&out.stdout));
    }
    Vec::new()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleToDelete {
    pub family: String,
    pub table: String,
    pub chain: String,
    pub handle: u64,
}

/// Find all flowcone injected rules across any tables and chains from `nft -a list ruleset`
pub(crate) fn find_all_flowcone_rules(ruleset_output: &str) -> Vec<RuleToDelete> {
    let mut rules = Vec::new();
    let mut current_family = String::new();
    let mut current_table = String::new();
    let mut current_chain = String::new();

    for line in ruleset_output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("table ") {
            if let Some(brace_idx) = trimmed.find('{') {
                let table_part = trimmed[6..brace_idx].trim();
                let parts: Vec<&str> = table_part.split_whitespace().collect();
                if parts.len() >= 2 {
                    current_family = parts[0].to_string();
                    current_table = parts[1].to_string();
                }
            }
        } else if trimmed.starts_with("chain ") {
            if let Some(brace_idx) = trimmed.find('{') {
                let chain_part = trimmed[6..brace_idx].trim();
                current_chain = chain_part.to_string();
            }
        } else if trimmed.contains("comment \"flowcone\"") {
            if let Some(idx) = trimmed.rfind("# handle ") {
                let handle_str = &trimmed[idx + "# handle ".len()..];
                if let Ok(h) = handle_str.trim().parse::<u64>()
                    && !current_family.is_empty()
                    && !current_table.is_empty()
                    && !current_chain.is_empty()
                {
                    rules.push(RuleToDelete {
                        family: current_family.clone(),
                        table: current_table.clone(),
                        chain: current_chain.clone(),
                        handle: h,
                    });
                }
            }
        } else if trimmed == "}" {
            current_chain.clear();
        }
    }
    rules
}

/// Run one nft transaction (`nft -f -` applies the file as one batch).
pub(crate) fn nft_apply(script: &str) -> Result<(), String> {
    if script.trim().is_empty() {
        return Ok(());
    }

    let mut child = Command::new("nft")
        .args(["-f", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn nft: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(script.as_bytes());
    }

    match child.wait_with_output() {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Err(format!("failed to wait for nft: {e}")),
    }
}

pub(crate) fn nft_output(args: &[&str]) -> Option<String> {
    let out = Command::new("nft").args(args).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        None
    }
}

/// `nft -a list ruleset` is the only way to enumerate rule handles.
pub(crate) fn nft_ruleset_text() -> Option<String> {
    nft_output(&["-a", "list", "ruleset"])
}

pub(crate) fn nft_table_exists(family: &str, table: &str) -> bool {
    Command::new("nft")
        .args(["list", "table", family, table])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Delete statements for already injected rules.
pub(crate) fn build_delete_script(rules: &[RuleToDelete]) -> String {
    let mut script = String::new();
    for r in rules {
        script.push_str(&format!(
            "delete rule {} {} {} handle {}\n",
            r.family, r.table, r.chain, r.handle
        ));
    }
    script
}

/// Apply `deletes + body`; retry without the deletes if a handle is gone.
pub(crate) fn nft_apply_with_fallback(deletes: &str, body: &str, what: &str) -> bool {
    match nft_apply(&format!("{deletes}{body}")) {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "flowcone: warning: {} transaction failed ({}), retrying without stale rule deletes",
                what, e
            );
            match nft_apply(body) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("flowcone: error: {} failed: {}", what, e);
                    false
                }
            }
        }
    }
}

/// Delete all injected flowcone rules from any table/chain in one transaction.
pub(crate) fn delete_all_injected_rules(verbose: bool) {
    let Some(text) = nft_ruleset_text() else {
        return;
    };
    let rules = find_all_flowcone_rules(&text);
    if verbose {
        for r in &rules {
            println!(
                "flowcone: removing rule from {} {} {} (handle {})",
                r.family, r.table, r.chain, r.handle
            );
        }
    }
    if let Err(e) = nft_apply(&build_delete_script(&rules)) {
        eprintln!("flowcone: warning: failed to delete injected rules: {}", e);
    }
}

/// Insert statements for the srcnat chains of a generic Linux firewall.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_all_flowcone_rules_multi_table() {
        let ruleset_sample = "\
table inet fw4 { # handle 42
	flowtable ft { # handle 534
		hook ingress priority filter
		devices = { \"br-lan\", \"eth1\" }
		counter
	}
	chain forward { # handle 2
		type filter hook forward priority filter; policy drop;
		meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\" # handle 95
		meta l4proto { tcp, udp } flow add @ft # handle 541
	}
	chain srcnat { # handle 19
		type nat hook postrouting priority srcnat; policy accept;
		oifname \"eth1\" meta nfproto ipv4 meta l4proto udp counter return comment \"flowcone\" # handle 96
		oifname \"eth1\" jump srcnat_wan # handle 590
	}
}
table ip nat { # handle 10
	chain POSTROUTING { # handle 1
		type nat hook postrouting priority srcnat; policy accept;
		oifname \"eth0\" meta l4proto udp counter return comment \"flowcone\" # handle 105
		oifname \"eth0\" counter masquerade # handle 106
	}
}
table ip6 nat { # handle 11
	chain POSTROUTING { # handle 1
		type nat hook postrouting priority srcnat; policy accept;
		oifname \"eth0\" meta l4proto udp counter return comment \"flowcone\" # handle 205
	}
}";
        let rules = find_all_flowcone_rules(ruleset_sample);
        assert_eq!(
            rules,
            vec![
                RuleToDelete {
                    family: "inet".to_string(),
                    table: "fw4".to_string(),
                    chain: "forward".to_string(),
                    handle: 95,
                },
                RuleToDelete {
                    family: "inet".to_string(),
                    table: "fw4".to_string(),
                    chain: "srcnat".to_string(),
                    handle: 96,
                },
                RuleToDelete {
                    family: "ip".to_string(),
                    table: "nat".to_string(),
                    chain: "POSTROUTING".to_string(),
                    handle: 105,
                },
                RuleToDelete {
                    family: "ip6".to_string(),
                    table: "nat".to_string(),
                    chain: "POSTROUTING".to_string(),
                    handle: 205,
                },
            ]
        );
    }

    fn chain(family: &str, table: &str, name: &str, hook: &str, kind: &str) -> NftBaseChain {
        NftBaseChain {
            family: family.to_string(),
            table: table.to_string(),
            name: name.to_string(),
            hook: hook.to_string(),
            chain_type: kind.to_string(),
            prio: String::new(),
        }
    }

    #[test]
    fn test_generic_rules_are_family_correct() {
        let inet_src = chain("inet", "fw4", "srcnat", "postrouting", "nat");
        let ip_src = chain("ip", "nat", "POSTROUTING", "postrouting", "nat");
        let ip6_src = chain("ip6", "nat", "POSTROUTING", "postrouting", "nat");
        let inet_fwd = chain("inet", "fw4", "forward", "forward", "filter");
        let ip_fwd = chain("ip", "filter", "FORWARD", "forward", "filter");
        let ip6_fwd = chain("ip6", "filter", "FORWARD", "forward", "filter");
        let src = vec![&inet_src, &ip_src, &ip6_src];
        let fwd = vec![&inet_fwd, &ip_fwd, &ip6_fwd];
        let script =
            build_generic_insert_script("eth0", &src, &fwd, true, true, 0x40000000, 0x8000, 0x8000);
        assert!(script.contains("ip saddr @flowcone_v4"));
        assert!(script.contains("255.0.0.0/8"));
        assert!(script.contains("169.254.0.0/16"));
        assert!(script.contains("224.0.0.0/4"));
        assert!(script.contains("udp sport != { 67, 68 }"));
        assert!(script.contains("meta mark & 0x40000000"));
        assert!(script.contains("ip6 saddr @flowcone_v6"));
        assert!(!script.contains("meta l4proto udp counter return"));
        let ip_rule = script
            .lines()
            .find(|l| l.contains("insert rule ip nat"))
            .expect("ip srcnat rule");
        assert!(!ip_rule.contains("meta nfproto"));
        let ip6_rule = script
            .lines()
            .find(|l| l.contains("insert rule ip6 nat"))
            .expect("ip6 srcnat rule");
        assert!(!ip6_rule.contains("meta nfproto"));
        let ip_fwd_rule = script
            .lines()
            .find(|l| l.contains("insert rule ip filter FORWARD"))
            .expect("ip forward rule");
        assert!(!ip_fwd_rule.contains("ip6 saddr"));
        assert!(ip_fwd_rule.contains("ip saddr @flowcone_fwd4"));
    }

    #[test]
    fn test_collect_generic_tables_merges_by_table() {
        let inet_src = chain("inet", "fw4", "srcnat", "postrouting", "nat");
        let inet_fwd = chain("inet", "fw4", "forward", "forward", "filter");
        let ip_src = chain("ip", "nat", "POSTROUTING", "postrouting", "nat");
        let tables = collect_generic_tables(&[&inet_src, &ip_src], &[&inet_fwd], true, true);
        assert_eq!(tables.len(), 2);
        let fw4 = tables.iter().find(|t| t.family == "inet").unwrap();
        assert!(fw4.src_v4 && fw4.src_v6 && fw4.fwd_v4 && fw4.fwd_v6);
        let ip = tables.iter().find(|t| t.family == "ip").unwrap();
        assert!(ip.src_v4 && !ip.src_v6 && !ip.fwd_v4 && !ip.fwd_v6);
    }

    #[test]
    fn test_parse_nft_base_chains() {
        let chains_sample = "\
table inet fw4 {
	chain input {
		type filter hook input priority filter; policy accept;
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
	chain srcnat {
		type nat hook postrouting priority srcnat; policy accept;
	}
	chain input_wan {
	}
}
table ip nat {
	chain POSTROUTING {
		type nat hook postrouting priority srcnat; policy accept;
	}
}
table ip filter {
	chain FORWARD {
		type filter hook forward priority filter; policy accept;
	}
}
table ip6 nat {
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
	}
}";
        let base_chains = parse_nft_base_chains(chains_sample);
        assert_eq!(base_chains.len(), 6);
        assert_eq!(
            base_chains[0],
            NftBaseChain {
                family: "inet".to_string(),
                table: "fw4".to_string(),
                name: "input".to_string(),
                hook: "input".to_string(),
                chain_type: "filter".to_string(),
                prio: "filter".to_string(),
            }
        );
        assert_eq!(
            base_chains[1],
            NftBaseChain {
                family: "inet".to_string(),
                table: "fw4".to_string(),
                name: "forward".to_string(),
                hook: "forward".to_string(),
                chain_type: "filter".to_string(),
                prio: "filter".to_string(),
            }
        );
        assert_eq!(
            base_chains[2],
            NftBaseChain {
                family: "inet".to_string(),
                table: "fw4".to_string(),
                name: "srcnat".to_string(),
                hook: "postrouting".to_string(),
                chain_type: "nat".to_string(),
                prio: "srcnat".to_string(),
            }
        );
        assert_eq!(
            base_chains[3],
            NftBaseChain {
                family: "ip".to_string(),
                table: "nat".to_string(),
                name: "POSTROUTING".to_string(),
                hook: "postrouting".to_string(),
                chain_type: "nat".to_string(),
                prio: "srcnat".to_string(),
            }
        );
        assert_eq!(
            base_chains[4],
            NftBaseChain {
                family: "ip".to_string(),
                table: "filter".to_string(),
                name: "FORWARD".to_string(),
                hook: "forward".to_string(),
                chain_type: "filter".to_string(),
                prio: "filter".to_string(),
            }
        );
        assert_eq!(
            base_chains[5],
            NftBaseChain {
                family: "ip6".to_string(),
                table: "nat".to_string(),
                name: "postrouting".to_string(),
                hook: "postrouting".to_string(),
                chain_type: "nat".to_string(),
                prio: "srcnat".to_string(),
            }
        );
    }

    #[test]
    fn test_build_delete_script() {
        let rules = vec![
            RuleToDelete {
                family: "inet".to_string(),
                table: "fw4".to_string(),
                chain: "srcnat".to_string(),
                handle: 42,
            },
            RuleToDelete {
                family: "ip".to_string(),
                table: "nat".to_string(),
                chain: "POSTROUTING".to_string(),
                handle: 7,
            },
        ];
        assert_eq!(
            build_delete_script(&rules),
            "delete rule inet fw4 srcnat handle 42\ndelete rule ip nat POSTROUTING handle 7\n"
        );
        assert!(build_delete_script(&[]).is_empty());
    }
}
