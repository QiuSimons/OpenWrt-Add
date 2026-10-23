use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const FW4_USER_PATH: &str = "/etc/firewall4.user";
const FW4_CHAIN_PRE_SRCNAT_DIR: &str = "/usr/share/nftables.d/chain-pre/srcnat";
const FW4_CHAIN_PRE_SRCNAT_FILE: &str = "/usr/share/nftables.d/chain-pre/srcnat/10-flowcone.nft";
const FW4_CHAIN_PRE_FORWARD_DIR: &str = "/usr/share/nftables.d/chain-pre/forward";
const FW4_CHAIN_PRE_FORWARD_FILE: &str = "/usr/share/nftables.d/chain-pre/forward/10-flowcone.nft";

const FLOWCONE_TAG_START: &str = "# --- flowcone start ---";
const FLOWCONE_TAG_END: &str = "# --- flowcone end ---";

/// Check if hardware flow offload is enabled in nftables flowtables.
/// Hardware Flow Offloading (PPE/DSA/ASIC) bypasses the CPU and TC egress entirely,
/// causing private IP leakage and broken NAT.
pub fn check_hardware_offload_warning() {
    if let Ok(out) = Command::new("nft")
        .args(["list", "flowtables"])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if text.contains("flags offload") {
                eprintln!(
                    "flowcone: WARNING: Hardware Flow Offloading (`flags offload`) is detected!\n\
                     Hardware offloading directs packets through the switch ASIC/PPE, bypassing CPU TC egress.\n\
                     This will cause private IP leakage and broken NAT.\n\
                     Please disable Hardware Offloading in OpenWrt ('uci set firewall.@defaults[0].flow_offloading_hw=0 && uci commit firewall && fw4 reload')."
                );
            }
        }
    }
}

/// Generate IPv4 srcnat exemption rule.
/// Skips masquerade for private IPv4 source traffic on WAN interface.
pub fn generate_fw4_srcnat_rule_v4(iface: &str) -> String {
    format!(
        "oifname \"{iface}\" meta nfproto ipv4 meta l4proto udp ip saddr {{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 }} counter return comment \"flowcone\""
    )
}

/// Generate IPv6 srcnat exemption rule (NAT66).
/// If masquerade is enabled, exemptions cover all IPv6 UDP; otherwise only ULA (fc00::/7).
pub fn generate_fw4_srcnat_rule_v6(iface: &str, is_masq: bool) -> String {
    if is_masq {
        format!(
            "oifname \"{iface}\" meta nfproto ipv6 meta l4proto udp counter return comment \"flowcone\""
        )
    } else {
        format!(
            "oifname \"{iface}\" meta nfproto ipv6 meta l4proto udp ip6 saddr fc00::/7 counter return comment \"flowcone\""
        )
    }
}

/// Generate IPv4 srcnat exemption rule for 'ip' family table (e.g. iptables-nft 'table ip nat').
pub fn generate_srcnat_rule_ip(iface: &str) -> String {
    format!(
        "oifname \"{iface}\" meta l4proto udp ip saddr {{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 }} counter return comment \"flowcone\""
    )
}

/// Generate IPv6 srcnat exemption rule for 'ip6' family table (e.g. iptables-nft 'table ip6 nat').
pub fn generate_srcnat_rule_ip6(iface: &str, is_masq: bool) -> String {
    if is_masq {
        format!(
            "oifname \"{iface}\" meta l4proto udp counter return comment \"flowcone\""
        )
    } else {
        format!(
            "oifname \"{iface}\" meta l4proto udp ip6 saddr fc00::/7 counter return comment \"flowcone\""
        )
    }
}

/// Generate forward rules to accept inbound packets marked with FLOWCONE_MARK.
pub fn generate_fw4_forward_rules() -> Vec<String> {
    vec![
        "meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\"".to_string(),
    ]
}

pub fn generate_fw4_user_block(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) -> String {
    let mut lines = Vec::new();
    lines.push(FLOWCONE_TAG_START.to_string());
    if enable_v4 {
        let r4 = generate_fw4_srcnat_rule_v4(iface);
        lines.push(format!("nft insert rule inet fw4 srcnat {} 2>/dev/null || true", r4));
    }
    if enable_v6 {
        let r6 = generate_fw4_srcnat_rule_v6(iface, is_v6_masq);
        lines.push(format!("nft insert rule inet fw4 srcnat {} 2>/dev/null || true", r6));
    }
    for fwd in generate_fw4_forward_rules() {
        lines.push(format!("nft insert rule inet fw4 forward {} 2>/dev/null || true", fwd));
    }
    lines.push(FLOWCONE_TAG_END.to_string());
    lines.join("\n") + "\n"
}

pub fn generate_standalone_script(iface: &str) -> String {
    format!(
        "table inet flowcone {{\n\
         \x20   chain forward {{\n\
         \x20       type filter hook forward priority filter - 1; policy accept;\n\
         \x20       meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\"\n\
         \x20   }}\n\
         \x20   chain srcnat {{\n\
         \x20       type nat hook postrouting priority srcnat - 1; policy accept;\n\
         \x20       oifname \"{iface}\" meta l4proto udp ip saddr {{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 }} counter return comment \"flowcone\"\n\
         \x20   }}\n\
         }}\n"
    )
}

/// Check if OpenWrt's `table inet fw4` exists in the system
pub fn has_table_inet_fw4() -> bool {
    Command::new("nft")
        .args(["list", "table", "inet", "fw4"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Parse nftables rules text to detect if IPv6 masquerade is enabled
pub fn parse_has_ipv6_masq(nft_output: &str) -> bool {
    for line in nft_output.lines() {
        let trimmed = line.trim();
        if trimmed.contains("masquerade")
            && (trimmed.contains("nfproto ipv6")
                || trimmed.contains("meta nfproto 10")
                || trimmed.contains("ip6")
                || trimmed.contains("ipv6"))
            && !trimmed.contains("nfproto ipv4")
        {
            return true;
        }
    }
    false
}

/// Check if system nftables has IPv6 masquerade enabled
pub fn is_ipv6_masq_enabled() -> bool {
    let args: &[&str] = if has_table_inet_fw4() {
        &["list", "table", "inet", "fw4"]
    } else {
        &["list", "ruleset"]
    };
    if let Ok(out) = Command::new("nft").args(args).output()
        && out.status.success()
    {
        let text = String::from_utf8_lossy(&out.stdout);
        return parse_has_ipv6_masq(&text);
    }
    false
}

/// Parse nftables chain output with handles and return handles matching flowcone rules
/// Strictly checks for comment "flowcone" to avoid deleting user or 3rd party rules.
#[allow(dead_code)]
pub fn find_rule_handles_to_delete(chain_output: &str, _is_srcnat: bool) -> Vec<u64> {
    let mut handles = Vec::new();
    for line in chain_output.lines() {
        let trimmed = line.trim();
        if trimmed.contains("comment \"flowcone\"") {
            if let Some(idx) = trimmed.rfind("# handle ") {
                let handle_str = &trimmed[idx + "# handle ".len()..];
                if let Ok(h) = handle_str.trim().parse::<u64>() {
                    handles.push(h);
                }
            }
        }
    }
    handles
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
pub fn parse_nft_base_chains(output: &str) -> Vec<NftBaseChain> {
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
            if !current_chain.is_empty() {
                current_chain.clear();
            }
        }
    }

    chains
}

pub fn get_existing_base_chains() -> Vec<NftBaseChain> {
    if let Ok(out) = Command::new("nft").args(["list", "chains"]).output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            return parse_nft_base_chains(&text);
        }
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
pub fn find_all_flowcone_rules(ruleset_output: &str) -> Vec<RuleToDelete> {
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
                if let Ok(h) = handle_str.trim().parse::<u64>() {
                    if !current_family.is_empty() && !current_table.is_empty() && !current_chain.is_empty() {
                        rules.push(RuleToDelete {
                            family: current_family.clone(),
                            table: current_table.clone(),
                            chain: current_chain.clone(),
                            handle: h,
                        });
                    }
                }
            }
        } else if trimmed == "}" {
            if !current_chain.is_empty() {
                current_chain.clear();
            }
        }
    }
    rules
}

/// Delete all injected flowcone rules from any table/chain across the entire nftables ruleset
pub fn delete_all_injected_rules(verbose: bool) {
    if let Ok(out) = Command::new("nft").args(["-a", "list", "ruleset"]).output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let rules = find_all_flowcone_rules(&text);
            for r in rules {
                let res = Command::new("nft")
                    .args([
                        "delete",
                        "rule",
                        &r.family,
                        &r.table,
                        &r.chain,
                        "handle",
                        &r.handle.to_string(),
                    ])
                    .output();
                if let Ok(out) = res {
                    if !out.status.success() && verbose {
                        eprintln!(
                            "flowcone: warning: failed to delete handle {} in {} {} {}: {}",
                            r.handle,
                            r.family,
                            r.table,
                            r.chain,
                            String::from_utf8_lossy(&out.stderr)
                        );
                    }
                }
                if verbose {
                    println!(
                        "flowcone: removed rule from {} {} {} (handle {})",
                        r.family, r.table, r.chain, r.handle
                    );
                }
            }
        }
    }
}

/// Delete injected flowcone rules from inet fw4 chains (srcnat & forward)
pub fn delete_injected_fw4_rules(verbose: bool) {
    delete_all_injected_rules(verbose);
}

pub fn strip_fw4_user_block(content: &str) -> String {
    let mut result = content.to_string();
    while let (Some(start), Some(end)) = (
        result.find(FLOWCONE_TAG_START),
        result.find(FLOWCONE_TAG_END),
    ) {
        if start < end {
            let before = &result[..start];
            let after = &result[end + FLOWCONE_TAG_END.len()..];
            result = format!("{}{}", before.trim_end(), after);
        } else {
            break;
        }
    }
    result
}

pub fn update_firewall4_user_file(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) {
    let block = generate_fw4_user_block(iface, enable_v4, enable_v6, is_v6_masq);
    let current = fs::read_to_string(FW4_USER_PATH).unwrap_or_default();
    let stripped = strip_fw4_user_block(&current);

    let updated = if stripped.trim().is_empty() {
        format!("#!/bin/sh\n{}", block)
    } else {
        format!("{}\n\n{}", stripped.trim_end(), block)
    };

    let _ = fs::write(FW4_USER_PATH, updated);
}

pub fn clean_firewall4_user_file() {
    if let Ok(current) = fs::read_to_string(FW4_USER_PATH) {
        let cleaned = strip_fw4_user_block(&current);
        let _ = fs::write(FW4_USER_PATH, cleaned.trim());
    }
}

pub fn update_chain_pre_files(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) {
    let _ = fs::create_dir_all(FW4_CHAIN_PRE_SRCNAT_DIR);
    let _ = fs::create_dir_all(FW4_CHAIN_PRE_FORWARD_DIR);

    let mut srcnat_lines = Vec::new();
    if enable_v4 {
        srcnat_lines.push(generate_fw4_srcnat_rule_v4(iface));
    }
    if enable_v6 {
        srcnat_lines.push(generate_fw4_srcnat_rule_v6(iface, is_v6_masq));
    }

    if !srcnat_lines.is_empty() {
        let content = srcnat_lines.join("\n") + "\n";
        let _ = fs::write(FW4_CHAIN_PRE_SRCNAT_FILE, content);
    } else {
        let _ = fs::remove_file(FW4_CHAIN_PRE_SRCNAT_FILE);
    }

    let fwd_rules = generate_fw4_forward_rules();
    let fwd_content = fwd_rules.join("\n") + "\n";
    let _ = fs::write(FW4_CHAIN_PRE_FORWARD_FILE, fwd_content);
}

pub fn clean_chain_pre_files() {
    let _ = fs::remove_file(FW4_CHAIN_PRE_SRCNAT_FILE);
    let _ = fs::remove_file(FW4_CHAIN_PRE_FORWARD_FILE);
}

/// Synchronize firewall rules with current protocol and address state.
/// Called dynamically when WAN IPv4 or IPv6 state changes.
pub fn sync_fw4_rules(
    iface: &str,
    min_port: u16,
    max_port: u16,
    enable_v4: bool,
    enable_v6: bool,
    verbose: bool,
) {
    let is_fw4 = has_table_inet_fw4();

    if is_fw4 {
        check_hardware_offload_warning();
        delete_injected_fw4_rules(verbose);

        let is_v6_masq = is_ipv6_masq_enabled();

        if enable_v4 {
            let r4 = generate_fw4_srcnat_rule_v4(iface);
            let res = Command::new("nft")
                .args(["insert", "rule", "inet", "fw4", "srcnat"])
                .args(r4.split_whitespace())
                .output();
            if let Ok(out) = res {
                if !out.status.success() {
                    eprintln!(
                        "flowcone: error: failed to insert v4 srcnat rule: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                }
            }
        }

        if enable_v6 {
            let r6 = generate_fw4_srcnat_rule_v6(iface, is_v6_masq);
            let res = Command::new("nft")
                .args(["insert", "rule", "inet", "fw4", "srcnat"])
                .args(r6.split_whitespace())
                .output();
            if let Ok(out) = res {
                if !out.status.success() {
                    eprintln!(
                        "flowcone: error: failed to insert v6 srcnat rule: {}",
                        String::from_utf8_lossy(&out.stderr)
                    );
                }
            }
        }

        if enable_v4 || enable_v6 {
            for fwd in generate_fw4_forward_rules() {
                let res = Command::new("nft")
                    .args(["insert", "rule", "inet", "fw4", "forward"])
                    .args(fwd.split_whitespace())
                    .output();
                if let Ok(out) = res {
                    if !out.status.success() {
                        eprintln!(
                            "flowcone: error: failed to insert forward rule: {}",
                            String::from_utf8_lossy(&out.stderr)
                        );
                    }
                }
            }
        }

        update_chain_pre_files(iface, enable_v4, enable_v6, is_v6_masq);

        if Path::new("/etc").exists() {
            update_firewall4_user_file(iface, enable_v4, enable_v6, is_v6_masq);
        }

        if verbose {
            println!(
                "flowcone: synced inet fw4 rules (iface {}, v4={}, v6={}, ports {}-{})",
                iface, enable_v4, enable_v6, min_port, max_port
            );
        }
    } else {
        check_hardware_offload_warning();
        delete_all_injected_rules(verbose);

        let is_v6_masq = is_ipv6_masq_enabled();
        let base_chains = get_existing_base_chains();

        let postrouting_nat_chains: Vec<&NftBaseChain> = base_chains
            .iter()
            .filter(|c| c.hook == "postrouting" && c.chain_type == "nat")
            .collect();
        let forward_filter_chains: Vec<&NftBaseChain> = base_chains
            .iter()
            .filter(|c| c.hook == "forward" && c.chain_type == "filter")
            .collect();

        if !postrouting_nat_chains.is_empty() || !forward_filter_chains.is_empty() {
            let _ = Command::new("nft")
                .args(["delete", "table", "inet", "flowcone"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();

            for chain in postrouting_nat_chains {
                match chain.family.as_str() {
                    "inet" => {
                        if enable_v4 {
                            let r4 = generate_fw4_srcnat_rule_v4(iface);
                            let _ = Command::new("nft")
                                .args(["insert", "rule", &chain.family, &chain.table, &chain.name])
                                .args(r4.split_whitespace())
                                .output();
                        }
                        if enable_v6 {
                            let r6 = generate_fw4_srcnat_rule_v6(iface, is_v6_masq);
                            let _ = Command::new("nft")
                                .args(["insert", "rule", &chain.family, &chain.table, &chain.name])
                                .args(r6.split_whitespace())
                                .output();
                        }
                    }
                    "ip" => {
                        if enable_v4 {
                            let r4 = generate_srcnat_rule_ip(iface);
                            let _ = Command::new("nft")
                                .args(["insert", "rule", &chain.family, &chain.table, &chain.name])
                                .args(r4.split_whitespace())
                                .output();
                        }
                    }
                    "ip6" => {
                        if enable_v6 {
                            let r6 = generate_srcnat_rule_ip6(iface, is_v6_masq);
                            let _ = Command::new("nft")
                                .args(["insert", "rule", &chain.family, &chain.table, &chain.name])
                                .args(r6.split_whitespace())
                                .output();
                        }
                    }
                    _ => {}
                }
            }

            if enable_v4 || enable_v6 {
                let fwd_rules = generate_fw4_forward_rules();
                for chain in forward_filter_chains {
                    for fwd in &fwd_rules {
                        let _ = Command::new("nft")
                            .args(["insert", "rule", &chain.family, &chain.table, &chain.name])
                            .args(fwd.split_whitespace())
                            .output();
                    }
                }
            }

            if verbose {
                println!(
                    "flowcone: injected rules into existing Linux firewall chains (iface {}, v4={}, v6={})",
                    iface, enable_v4, enable_v6
                );
            }
        } else {
            let script = generate_standalone_script(iface);
            let child = Command::new("nft")
                .args(["-f", "-"])
                .stdin(Stdio::piped())
                .spawn();

            if let Ok(mut c) = child {
                if let Some(mut stdin) = c.stdin.take() {
                    let _ = stdin.write_all(script.as_bytes());
                }
                let _ = c.wait();
                if verbose {
                    println!(
                        "flowcone: applied standalone nftables rules (table inet flowcone on {})",
                        iface
                    );
                }
            }
        }
    }
}

pub fn remove_rules(verbose: bool) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_rules_script() {
        let script = generate_standalone_script("eth1");
        assert!(script.contains("table inet flowcone"));
        assert!(script.contains("priority filter - 1"));
        assert!(script.contains("priority srcnat - 1"));
        assert!(script.contains("meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\""));
        assert!(script.contains("oifname \"eth1\" meta l4proto udp ip saddr { 10.0.0.0/8"));
        assert!(script.contains("comment \"flowcone\""));
    }

    #[test]
    fn test_generate_srcnat_rule_ip_and_ip6() {
        let r_ip = generate_srcnat_rule_ip("eth0");
        assert_eq!(
            r_ip,
            "oifname \"eth0\" meta l4proto udp ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } counter return comment \"flowcone\""
        );
        let r_ip6_ula = generate_srcnat_rule_ip6("eth0", false);
        assert_eq!(
            r_ip6_ula,
            "oifname \"eth0\" meta l4proto udp ip6 saddr fc00::/7 counter return comment \"flowcone\""
        );
        let r_ip6_masq = generate_srcnat_rule_ip6("eth0", true);
        assert_eq!(
            r_ip6_masq,
            "oifname \"eth0\" meta l4proto udp counter return comment \"flowcone\""
        );
    }

    #[test]
    fn test_generate_fw4_user_block() {
        let inc = generate_fw4_user_block("eth1", true, true, false);
        assert!(inc.contains(FLOWCONE_TAG_START));
        assert!(inc.contains("oifname \"eth1\" meta nfproto ipv4 meta l4proto udp ip saddr { 10.0.0.0/8"));
        assert!(inc.contains("meta mark & 0x40000000 == 0x40000000"));
        assert!(inc.contains("ip6 saddr fc00::/7"));
        assert!(inc.contains(FLOWCONE_TAG_END));
    }

    #[test]
    fn test_generate_fw4_chain_pre_rules() {
        let srcnat_v4 = generate_fw4_srcnat_rule_v4("eth1");
        assert_eq!(
            srcnat_v4,
            "oifname \"eth1\" meta nfproto ipv4 meta l4proto udp ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } counter return comment \"flowcone\""
        );
        let srcnat_v6_ula = generate_fw4_srcnat_rule_v6("eth1", false);
        assert_eq!(
            srcnat_v6_ula,
            "oifname \"eth1\" meta nfproto ipv6 meta l4proto udp ip6 saddr fc00::/7 counter return comment \"flowcone\""
        );
        let srcnat_v6_masq = generate_fw4_srcnat_rule_v6("eth1", true);
        assert_eq!(
            srcnat_v6_masq,
            "oifname \"eth1\" meta nfproto ipv6 meta l4proto udp counter return comment \"flowcone\""
        );
        let fwds = generate_fw4_forward_rules();
        assert_eq!(
            fwds[0],
            "meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\""
        );
    }

    #[test]
    fn test_find_rule_handles_to_delete() {
        let sample_srcnat = "\
table inet fw4 {
        chain srcnat { # handle 19
                type nat hook postrouting priority srcnat; policy accept;
                udp sport 1024-65535 counter packets 0 bytes 0 return comment \"flowcone\" # handle 96
                udp sport 1024-65535 counter packets 2 bytes 508 return # handle 94
                oifname \"eth1\" jump srcnat_wan comment \"!fw4: Handle wan IPv4/IPv6 srcnat traffic\" # handle 86
                jump upnp_postrouting comment \"Hook into miniupnpd postrouting chain\" # handle 87
        }
}";
        let handles = find_rule_handles_to_delete(sample_srcnat, true);
        assert_eq!(handles, vec![96]);

        let sample_forward = "\
table inet fw4 {
        chain forward { # handle 2
                type filter hook forward priority filter; policy drop;
                meta mark & 0x40000000 == 0x40000000 counter packets 0 bytes 0 accept comment \"flowcone\" # handle 95
                meta mark 0x00004643 counter packets 1 bytes 50 accept # handle 97
                meta l4proto { tcp, udp } flow add @ft # handle 38
        }
}";
        let handles_fwd = find_rule_handles_to_delete(sample_forward, false);
        assert_eq!(handles_fwd, vec![95]);
    }

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
    fn test_parse_has_ipv6_masq() {
        let v4_only = "\
table inet fw4 {
        chain srcnat_wan {
                meta nfproto ipv4 masquerade comment \"!fw4: Masquerade IPv4 wan traffic\"
        }
}";
        assert!(!parse_has_ipv6_masq(v4_only));

        let v6_masq = "\
table inet fw4 {
        chain srcnat_wan {
                meta nfproto ipv4 masquerade comment \"!fw4: Masquerade IPv4 wan traffic\"
                meta nfproto ipv6 masquerade comment \"!fw4: Masquerade IPv6 wan traffic\"
        }
}";
        assert!(parse_has_ipv6_masq(v6_masq));
    }

    #[test]
    fn test_strip_fw4_user_block() {
        let original = "#!/bin/sh\n# custom rule\n# --- flowcone start ---\ninjected\n# --- flowcone end ---\n# footer\n";
        let stripped = strip_fw4_user_block(original);
        assert_eq!(stripped, "#!/bin/sh\n# custom rule\n# footer\n");

        let no_block = "#!/bin/sh\necho hi\n";
        assert_eq!(strip_fw4_user_block(no_block), no_block);
    }
}
