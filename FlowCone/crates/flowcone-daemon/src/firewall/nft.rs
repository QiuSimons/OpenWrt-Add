//! nftables command channel, rule discovery and the standalone table used on
//! systems without fw4.

use std::io::Write;
use std::process::{Command, Stdio};

use super::fw4::{generate_fw4_srcnat_rule_v4, generate_fw4_srcnat_rule_v6, v4_src_set};

/// Generate IPv4 srcnat exemption rule for 'ip' family table (e.g. iptables-nft 'table ip nat').
pub(crate) fn generate_srcnat_rule_ip(iface: &str) -> String {
    format!(
        "oifname \"{iface}\" meta l4proto udp ip saddr {{ {} }} counter return comment \"flowcone\"",
        v4_src_set()
    )
}

/// Generate IPv6 srcnat exemption rule for 'ip6' family table (e.g. iptables-nft 'table ip6 nat').
pub(crate) fn generate_srcnat_rule_ip6(iface: &str, is_masq: bool) -> String {
    if is_masq {
        format!("oifname \"{iface}\" meta l4proto udp counter return comment \"flowcone\"")
    } else {
        format!(
            "oifname \"{iface}\" meta l4proto udp ip6 saddr fc00::/7 counter return comment \"flowcone\""
        )
    }
}

pub(crate) fn generate_standalone_script(iface: &str) -> String {
    format!(
        "table inet flowcone {{\n\
         \x20   chain forward {{\n\
         \x20       type filter hook forward priority filter - 1; policy accept;\n\
         \x20       meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\"\n\
         \x20   }}\n\
         \x20   chain srcnat {{\n\
         \x20       type nat hook postrouting priority srcnat - 1; policy accept;\n\
         \x20       oifname \"{iface}\" meta l4proto udp ip saddr {{ {} }} counter return comment \"flowcone\"\n\
         \x20   }}\n\
         }}\n",
        v4_src_set()
    )
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
pub(crate) fn build_primary_insert_script(
    iface: &str,
    chains: &[&NftBaseChain],
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) -> String {
    let mut script = String::new();
    for c in chains {
        match c.family.as_str() {
            "inet" => {
                if enable_v4 {
                    script.push_str(&format!(
                        "insert rule inet {} {} {}\n",
                        c.table,
                        c.name,
                        generate_fw4_srcnat_rule_v4(iface)
                    ));
                }
                if enable_v6 {
                    script.push_str(&format!(
                        "insert rule inet {} {} {}\n",
                        c.table,
                        c.name,
                        generate_fw4_srcnat_rule_v6(iface, is_v6_masq)
                    ));
                }
            }
            "ip" if enable_v4 => script.push_str(&format!(
                "insert rule ip {} {} {}\n",
                c.table,
                c.name,
                generate_srcnat_rule_ip(iface)
            )),
            "ip6" if enable_v6 => script.push_str(&format!(
                "insert rule ip6 {} {} {}\n",
                c.table,
                c.name,
                generate_srcnat_rule_ip6(iface, is_v6_masq)
            )),
            _ => {}
        }
    }
    script
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
        assert!(
            script.contains(
                "meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\""
            )
        );
        assert!(script.contains(&format!(
            "oifname \"eth1\" meta l4proto udp ip saddr {{ {} }}",
            flowcone_common::INTERNAL_V4_PREFIXES.join(", ")
        )));
        assert!(script.contains("comment \"flowcone\""));
    }

    #[test]
    fn test_generate_srcnat_rule_ip_and_ip6() {
        let set = flowcone_common::INTERNAL_V4_PREFIXES.join(", ");
        let r_ip = generate_srcnat_rule_ip("eth0");
        assert_eq!(
            r_ip,
            format!(
                "oifname \"eth0\" meta l4proto udp ip saddr {{ {set} }} counter return comment \"flowcone\""
            )
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

    #[test]
    fn test_build_primary_insert_script() {
        let inet = NftBaseChain {
            family: "inet".to_string(),
            table: "fw4".to_string(),
            name: "srcnat".to_string(),
            hook: "postrouting".to_string(),
            chain_type: "nat".to_string(),
            prio: "srcnat".to_string(),
        };
        let ip6 = NftBaseChain {
            family: "ip6".to_string(),
            table: "nat".to_string(),
            name: "POSTROUTING".to_string(),
            hook: "postrouting".to_string(),
            chain_type: "nat".to_string(),
            prio: "srcnat".to_string(),
        };
        let chains = vec![&inet, &ip6];
        let script = build_primary_insert_script("eth0", &chains, true, true, true);
        assert!(script.contains("insert rule inet fw4 srcnat oifname \"eth0\" meta nfproto ipv4"));
        assert!(script.contains(
            "insert rule ip6 nat POSTROUTING oifname \"eth0\" meta l4proto udp counter return"
        ));
        assert_eq!(script.lines().count(), 3);
    }
}
