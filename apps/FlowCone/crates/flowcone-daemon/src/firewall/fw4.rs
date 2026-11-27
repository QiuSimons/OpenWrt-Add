//! OpenWrt fw4 integration: rule text, liveness sets and persistence files.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;
use std::process::Command;

use super::netlink::NetlinkLivenessClient;
use super::nft::{
    SET_FWD4, SET_FWD6, SET_V4, SET_V6, generate_forward_rule_v4, generate_forward_rule_v6,
    generate_srcnat_rule_v4, generate_srcnat_rule_v6, nft_apply, nft_output, nft_table_exists,
    refresh_table_liveness, set_definitions,
};

pub(crate) const FW4_USER_PATH: &str = "/etc/firewall4.user";
pub(crate) const FW4_NFTABLES_D_DIR: &str = "/usr/share/nftables.d";
pub(crate) const FW4_CHAIN_PRE_SRCNAT_DIR: &str = "/usr/share/nftables.d/chain-pre/srcnat";
pub(crate) const FW4_CHAIN_PRE_SRCNAT_FILE: &str =
    "/usr/share/nftables.d/chain-pre/srcnat/10-flowcone.nft";
pub(crate) const FW4_CHAIN_PRE_FORWARD_DIR: &str = "/usr/share/nftables.d/chain-pre/forward";
pub(crate) const FW4_CHAIN_PRE_FORWARD_FILE: &str =
    "/usr/share/nftables.d/chain-pre/forward/10-flowcone.nft";

pub(crate) const SET_DEFS_DIR: &str = "/etc/nftables.d";
pub(crate) const SET_DEFS_FILE: &str = "/etc/nftables.d/flowcone.nft";

pub(crate) const FLOWCONE_TAG_START: &str = "# --- flowcone start ---";
pub(crate) const FLOWCONE_TAG_END: &str = "# --- flowcone end ---";

/// Check if hardware flow offload is enabled in nftables flowtables.
pub(crate) fn check_hardware_offload_warning() {
    let Ok(out) = Command::new("nft").args(["list", "flowtables"]).output() else {
        return;
    };
    if out.status.success() {
        let text = String::from_utf8_lossy(&out.stdout);
        if text.contains("flags offload") {
            eprintln!(
                "flowcone: warning: Hardware Flow Offloading (flags offload) is detected!\n\
                     Hardware offloading directs packets through the switch ASIC/PPE, bypassing CPU TC egress.\n\
                     This will cause private IP leakage and broken NAT.\n\
                     Please disable Hardware Offloading in OpenWrt ('uci set firewall.@defaults[0].flow_offloading_hw=0 && uci commit firewall && fw4 reload')."
            );
        }
    }
}

pub(crate) fn has_table_inet_fw4() -> bool {
    nft_table_exists("inet", "fw4")
}

/// Strip `comment "..."` literals and unquoted `# ...` tail comments so rule
/// classifiers never match text inside comments.
fn strip_rule_comments(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.char_indices().peekable();
    let mut in_quotes = false;
    let mut escape = false;
    while let Some((idx, ch)) = chars.next() {
        if in_quotes {
            out.push(ch);
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_quotes = false;
            }
            continue;
        }
        if ch == '#' {
            break;
        }
        if ch == '"' {
            in_quotes = true;
            out.push(ch);
            continue;
        }
        if line[idx..].starts_with("comment \"") {
            let prev_ok =
                idx == 0 || line[..idx].ends_with(|c: char| c.is_whitespace() || c == ';');
            if prev_ok {
                for _ in 0.."comment \"".len() - 1 {
                    chars.next();
                }
                let mut esc = false;
                for (_, qch) in chars.by_ref() {
                    if esc {
                        esc = false;
                    } else if qch == '\\' {
                        esc = true;
                    } else if qch == '"' {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(ch);
    }
    out
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        let end = abs + needle.len();
        let left_ok = abs == 0
            || !haystack[..abs]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let right_ok = end == haystack.len()
            || !haystack[end..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if left_ok && right_ok {
            return true;
        }
        start = abs + needle.len();
    }
    false
}

/// Checks if a rule matches `wan_iface` via positive `oifname`/`oif` equality,
/// returning `(has_oif_constraint, matches_wan)`.
fn rule_oif_status(clean: &str, wan_iface: &str) -> (bool, bool) {
    let normalized = clean
        .replace('{', " { ")
        .replace('}', " } ")
        .replace(',', " ");
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let mut has_oif = false;
    let mut matches_wan = false;
    let quoted = format!("\"{}\"", wan_iface);

    for (i, tok) in tokens.iter().enumerate() {
        if *tok == "oif" || *tok == "oifname" {
            has_oif = true;
            let mut idx = i + 1;
            if tokens.get(idx) == Some(&"!=") {
                continue;
            }
            if tokens.get(idx) == Some(&"==") {
                idx += 1;
            }
            if tokens.get(idx) == Some(&"{") {
                idx += 1;
                while let Some(elem) = tokens.get(idx) {
                    if *elem == "}" {
                        break;
                    }
                    if *elem == quoted || *elem == wan_iface {
                        matches_wan = true;
                    }
                    idx += 1;
                }
            } else if let Some(next) = tokens.get(idx)
                && (*next == quoted || *next == wan_iface)
            {
                matches_wan = true;
            }
        }
    }
    (has_oif, matches_wan)
}

/// Detect IPv6 masquerade in ip6 or inet tables for the given WAN interface.
pub(crate) fn parse_has_ipv6_masq(nft_output: &str, wan_iface: &str) -> bool {
    let mut family = "";
    let mut table_name = "";
    let mut wan_chains: Vec<(String, String, String)> = Vec::new();
    let mut fw4_has_srcnat_dispatcher = false;

    // First pass: discover subchains jumped/goto'd from WAN oif rules per
    // (family, table).
    for line in nft_output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("table ") {
            let mut parts = rest.split_whitespace();
            family = parts.next().unwrap_or("");
            table_name = parts.next().unwrap_or("").trim_end_matches('{').trim();
            continue;
        }
        if table_name == "flowcone" || trimmed == "}" || trimmed.starts_with("chain ") {
            continue;
        }
        let clean = strip_rule_comments(trimmed);
        for kw in ["jump", "goto"] {
            let pattern = format!(" {} ", kw);
            if clean.contains(&pattern)
                && let Some(target_part) = clean.split(&pattern).nth(1)
            {
                let (has_oif, matches_wan) = rule_oif_status(&clean, wan_iface);
                let target_chain = target_part.split_whitespace().next().unwrap_or("").trim();
                let lower_target = target_chain.to_ascii_lowercase();
                if table_name == "fw4"
                    && has_oif
                    && (lower_target.starts_with("srcnat_")
                        || lower_target.starts_with("postrouting_"))
                {
                    fw4_has_srcnat_dispatcher = true;
                }
                if has_oif
                    && matches_wan
                    && !target_chain.is_empty()
                    && !wan_chains
                        .iter()
                        .any(|(f, t, c)| f == family && t == table_name && c == target_chain)
                {
                    wan_chains.push((
                        family.to_string(),
                        table_name.to_string(),
                        target_chain.to_string(),
                    ));
                }
            }
        }
    }

    family = "";
    table_name = "";
    let mut current_chain = "";
    for line in nft_output.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("table ") {
            let mut parts = rest.split_whitespace();
            family = parts.next().unwrap_or("");
            table_name = parts.next().unwrap_or("").trim_end_matches('{').trim();
            current_chain = "";
            continue;
        }
        if table_name == "flowcone" {
            continue;
        }
        if trimmed == "}" {
            current_chain = "";
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("chain ") {
            current_chain = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_end_matches('{')
                .trim();
            continue;
        }
        // Exclude FlowCone's own injected rules before stripping rule comments.
        if trimmed.contains("comment \"flowcone") || trimmed.contains("flowcone-nat6-partial") {
            continue;
        }
        let clean = strip_rule_comments(trimmed);
        let is_nat_action = contains_word(&clean, "masquerade") || contains_word(&clean, "snat");
        if !is_nat_action {
            continue;
        }

        let (has_oif, matches_wan) = rule_oif_status(&clean, wan_iface);
        if has_oif {
            if !matches_wan {
                continue;
            }
        } else {
            let is_base_postrouting = current_chain.eq_ignore_ascii_case("srcnat")
                || current_chain.eq_ignore_ascii_case("postrouting");
            let fallback_fw4_wan = table_name == "fw4"
                && !fw4_has_srcnat_dispatcher
                && (current_chain.eq_ignore_ascii_case("srcnat_wan")
                    || current_chain.eq_ignore_ascii_case("srcnat_wan6"));
            let is_wan_chain = wan_chains.iter().any(|(f, t, c)| {
                f == family && t == table_name && c.eq_ignore_ascii_case(current_chain)
            }) || fallback_fw4_wan
                || current_chain.eq_ignore_ascii_case(&format!("srcnat_{}", wan_iface));
            let lower_chain = current_chain.to_ascii_lowercase();
            let is_srcnat_subchain =
                lower_chain.starts_with("srcnat_") || lower_chain.starts_with("postrouting_");
            if is_srcnat_subchain && !is_wan_chain {
                continue;
            }
            if !is_base_postrouting && !is_wan_chain {
                continue;
            }
        }

        let has_v4_explicit = family == "ip"
            || clean.contains("nfproto ipv4")
            || clean.contains("ip saddr")
            || clean.contains("ip daddr")
            || clean.contains("ip protocol")
            || clean.contains("ip dscp")
            || clean.contains("ip ttl")
            || clean.contains("snat ip ")
            || clean.contains("bcmfullcone4");
        let has_v6_explicit = family == "ip6"
            || clean.contains("nfproto ipv6")
            || clean.contains("ip6 ")
            || contains_word(&clean, "ipv6")
            || clean.contains("snat ip6 ")
            || clean.contains("bcmfullcone6");
        if has_v6_explicit || (family == "inet" && !has_v4_explicit) {
            return true;
        }
    }
    false
}

pub(crate) fn is_ipv6_masq_enabled(wan_iface: &str) -> bool {
    if let Some(text) = nft_output(&["-t", "list", "ruleset"]) {
        return parse_has_ipv6_masq(&text, wan_iface);
    }
    nft_output(&["list", "ruleset"]).is_some_and(|text| parse_has_ipv6_masq(&text, wan_iface))
}

pub(crate) fn write_atomic_if_changed(path: &str, content: &str) -> bool {
    if let Ok(existing) = fs::read_to_string(path)
        && existing == content
    {
        return true;
    }
    let tmp_path = format!("{}.tmp.{}", path, std::process::id());
    if fs::write(&tmp_path, content).is_err() {
        return false;
    }
    if let Ok(meta) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp_path, meta.permissions());
    }
    if fs::rename(&tmp_path, path).is_err() {
        let _ = fs::remove_file(&tmp_path);
        return false;
    }
    true
}

pub(crate) fn strip_fw4_user_block(content: &str) -> String {
    let mut result = content.to_string();
    while let (Some(start), Some(end)) = (
        result.find(FLOWCONE_TAG_START),
        result.find(FLOWCONE_TAG_END),
    ) {
        if start < end {
            let before = &result[..start];
            let after = &result[end + FLOWCONE_TAG_END.len()..];
            if after.is_empty() {
                let mut trimmed = before.trim_end().to_string();
                if !trimmed.is_empty() {
                    trimmed.push('\n');
                }
                result = trimmed;
            } else {
                result = format!("{}{}", before.trim_end(), after);
            }
        } else {
            break;
        }
    }
    result
}

pub(crate) fn clean_firewall4_user_file() {
    if let Ok(current) = fs::read_to_string(FW4_USER_PATH) {
        let cleaned = strip_fw4_user_block(&current);
        if cleaned != current {
            let _ = write_atomic_if_changed(FW4_USER_PATH, &cleaned);
        }
    }
}

pub(crate) fn write_fw4_set_definitions() -> bool {
    let _ = fs::create_dir_all(SET_DEFS_DIR);
    write_atomic_if_changed(SET_DEFS_FILE, &set_definitions())
}

pub(crate) fn clean_fw4_set_definitions() {
    let _ = fs::remove_file(SET_DEFS_FILE);
}

/// Ensures liveness timeout sets exist in the kernel `inet fw4` table in one
/// transaction.
pub(crate) fn ensure_fw4_sets() -> bool {
    let Some(table_text) = nft_output(&["-t", "list", "table", "inet", "fw4"]) else {
        return false;
    };
    let mut script = String::new();
    for (set, family) in [
        (SET_V4, "ipv4_addr"),
        (SET_V6, "ipv6_addr"),
        (SET_FWD4, "ipv4_addr"),
        (SET_FWD6, "ipv6_addr"),
    ] {
        if !table_text.contains(&format!("set {set} ")) {
            script.push_str(&format!(
                "add set inet fw4 {} {{ type {}; flags interval,timeout; }}\n",
                set, family
            ));
        }
    }
    nft_apply(&script).is_ok()
}

pub(crate) fn build_fw4_insert_script(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    mark: u32,
    bypass_mask: u32,
    bypass_val: u32,
) -> String {
    let mut script = String::new();
    if enable_v4 {
        script.push_str(&format!(
            "insert rule inet fw4 srcnat {}\n",
            generate_srcnat_rule_v4(iface, bypass_mask, bypass_val)
        ));
    }
    if enable_v6 {
        script.push_str(&format!(
            "insert rule inet fw4 srcnat {}\n",
            generate_srcnat_rule_v6(iface, bypass_mask, bypass_val)
        ));
    }
    if enable_v4 {
        script.push_str(&format!(
            "insert rule inet fw4 forward {}\n",
            generate_forward_rule_v4(iface, mark)
        ));
    }
    if enable_v6 {
        script.push_str(&format!(
            "insert rule inet fw4 forward {}\n",
            generate_forward_rule_v6(iface, mark)
        ));
    }
    script
}

fn remove_persisted(path: &str) -> bool {
    match fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

pub(crate) fn update_chain_pre_files(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    mark: u32,
    bypass_mask: u32,
    bypass_val: u32,
) -> bool {
    let mut ok = fs::create_dir_all(FW4_CHAIN_PRE_SRCNAT_DIR).is_ok();
    ok &= fs::create_dir_all(FW4_CHAIN_PRE_FORWARD_DIR).is_ok();

    let mut srcnat_lines = Vec::new();
    if enable_v4 {
        srcnat_lines.push(generate_srcnat_rule_v4(iface, bypass_mask, bypass_val));
    }
    if enable_v6 {
        srcnat_lines.push(generate_srcnat_rule_v6(iface, bypass_mask, bypass_val));
    }
    if !srcnat_lines.is_empty() {
        ok &= write_atomic_if_changed(FW4_CHAIN_PRE_SRCNAT_FILE, &(srcnat_lines.join("\n") + "\n"));
    } else {
        ok &= remove_persisted(FW4_CHAIN_PRE_SRCNAT_FILE);
    }

    let mut fwd_lines = Vec::new();
    if enable_v4 {
        fwd_lines.push(generate_forward_rule_v4(iface, mark));
    }
    if enable_v6 {
        fwd_lines.push(generate_forward_rule_v6(iface, mark));
    }
    if !fwd_lines.is_empty() {
        ok &= write_atomic_if_changed(FW4_CHAIN_PRE_FORWARD_FILE, &(fwd_lines.join("\n") + "\n"));
    } else {
        ok &= remove_persisted(FW4_CHAIN_PRE_FORWARD_FILE);
    }
    ok
}

/// Refreshes element timeouts in `inet fw4` liveness sets.
pub(crate) fn refresh_fw4_liveness(
    nl: &mut NetlinkLivenessClient,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
    verbose: bool,
) -> bool {
    refresh_table_liveness(
        nl, "inet", "fw4", enable_v4, enable_v4, enable_v6, enable_v6, is_v6_masq, verbose,
    )
}

pub(crate) fn remove_fw4_sets() {
    let Some(table_text) = nft_output(&["-t", "list", "table", "inet", "fw4"]) else {
        return;
    };
    let mut script = String::new();
    for set in [SET_V4, SET_V6, SET_FWD4, SET_FWD6] {
        if table_text.contains(&format!("set {set} ")) {
            script.push_str(&format!("delete set inet fw4 {}\n", set));
        }
    }
    let _ = nft_apply(&script);
}

pub(crate) fn clean_chain_pre_files() {
    let _ = fs::remove_file(FW4_CHAIN_PRE_SRCNAT_FILE);
    let _ = fs::remove_file(FW4_CHAIN_PRE_FORWARD_FILE);
}

pub(crate) fn use_chain_pre() -> bool {
    Path::new(FW4_NFTABLES_D_DIR).is_dir() && auto_includes_enabled()
}

pub(crate) fn auto_includes_enabled() -> bool {
    match Command::new("uci")
        .args(["get", "firewall.@defaults[0].auto_includes"])
        .output()
    {
        Ok(out) if out.status.success() => !matches!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "0" | "no" | "false" | "off" | "disabled"
        ),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_has_ipv6_masq_ignores_nat6_partial_and_comments() {
        let partial = "\
table ip6 nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oif \"eth1\" meta l4proto != udp masquerade comment \"flowcone-nat6-partial\"
        }
}";
        assert!(!parse_has_ipv6_masq(partial, "eth1"));

        let flowcone_own = "\
table inet fw4 {
        chain srcnat_wan {
                meta nfproto ipv6 ip6 saddr fc00::/7 oifname \"wan\" counter masquerade comment \"flowcone\"
        }
}";
        assert!(!parse_has_ipv6_masq(flowcone_own, "eth1"));

        let flowcone_table = "\
table ip6 flowcone {
        chain postrouting {
                meta nfproto ipv6 ip6 saddr != fe80::/10 oifname \"wan\" counter masquerade comment \"flowcone\"
        }
}";
        assert!(!parse_has_ipv6_masq(flowcone_table, "eth1"));

        // Negated oifname or comment mentioning ipv6 must not match.
        let comment_with_ipv6 = "\
table inet fw4 {
        chain srcnat {
                oifname != \"eth1\" masquerade
                oifname \"eth1\" ip protocol udp masquerade comment \"allow ipv6 bypass\"
        }
}";
        assert!(!parse_has_ipv6_masq(comment_with_ipv6, "eth1"));
    }

    #[test]
    fn test_parse_has_ipv6_masq() {
        let v4_only = "\
table inet fw4 {
        chain srcnat_wan {
                meta nfproto ipv4 masquerade comment \"!fw4: Masquerade IPv4 wan traffic\"
        }
}";
        assert!(!parse_has_ipv6_masq(v4_only, "eth1"));

        let v6_masq = "\
table inet fw4 {
        chain srcnat_wan {
                meta nfproto ipv4 masquerade comment \"!fw4: Masquerade IPv4 wan traffic\"
                meta nfproto ipv6 masquerade comment \"!fw4: Masquerade IPv6 wan traffic\"
        }
}";
        assert!(parse_has_ipv6_masq(v6_masq, "eth1"));

        let ip6_nat = "\
table ip6 nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oif \"eth1\" masquerade
        }
}";
        assert!(parse_has_ipv6_masq(ip6_nat, "eth1"));

        let inet_unqualified_masq = "\
table inet nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oif \"eth0\" masquerade
        }
}";
        assert!(parse_has_ipv6_masq(inet_unqualified_masq, "eth0"));
        assert!(!parse_has_ipv6_masq(inet_unqualified_masq, "eth1"));

        // Masquerade on another interface (e.g. VPN) must not trigger WAN v6
        // masq
        let other_iface_masq = "\
table inet fw4 {
        chain srcnat {
                type nat hook postrouting priority srcnat; policy accept;
                oifname \"vpn0\" counter packets 0 bytes 0 masquerade comment \"!fw4: Masquerade VPN traffic vpn0\"
                oifname \"eth1\" jump srcnat_wan
        }
        chain srcnat_wan {
                meta nfproto ipv4 masquerade comment \"!fw4: Masquerade IPv4 wan traffic\"
        }
}";
        assert!(!parse_has_ipv6_masq(other_iface_masq, "eth1"));

        // Custom WAN goto chain in table inet filter
        let custom_goto = "\
table inet myfw {
        chain post {
                type nat hook postrouting priority srcnat; policy accept;
                oifname \"pppoe-wan\" goto wan_snat
        }
        chain wan_snat {
                snat ip6 to 2001:db8::1
        }
}";
        assert!(parse_has_ipv6_masq(custom_goto, "pppoe-wan"));
        assert!(!parse_has_ipv6_masq(custom_goto, "eth1"));

        // Standard Linux iptables-nft uppercase POSTROUTING detection
        let linux_postrouting_masq = "\
table ip6 nat {
        chain POSTROUTING {
                type nat hook postrouting priority srcnat; policy accept;
                masquerade
        }
}";
        assert!(parse_has_ipv6_masq(linux_postrouting_masq, "eth1"));

        // Escaped quotes and empty comment string in comment stripping
        assert_eq!(
            strip_rule_comments("oifname \"eth1\" comment \"\\\"ipv6\\\"\" masquerade"),
            "oifname \"eth1\"  masquerade"
        );
        assert_eq!(
            strip_rule_comments("oifname \"eth1\" comment \"\" masquerade"),
            "oifname \"eth1\"  masquerade"
        );

        // `oifname ==` and brace set `{ ... }`, without bleeding into `iifname`
        let oif_eq_set = "\
table inet nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oifname == { \"eth1.10\", \"eth1\" } masquerade
        }
}";
        assert!(parse_has_ipv6_masq(oif_eq_set, "eth1"));
        assert!(!parse_has_ipv6_masq(oif_eq_set, "eth2"));

        let brace_no_bleed = "\
table inet nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oifname { \"vpn0\", \"tun0\" } iifname \"eth1\" masquerade
        }
}";
        assert!(!parse_has_ipv6_masq(brace_no_bleed, "eth1"));

        // Dual-WAN fw4: WAN1 uses IPv6 masq in srcnat_wan, WAN2 uses IPv4-only
        // in srcnat_wan2
        let dual_wan_fw4 = "\
table inet fw4 {
        chain srcnat {
                type nat hook postrouting priority srcnat; policy accept;
                oifname \"eth1\" jump srcnat_wan
                oifname \"eth2\" jump srcnat_wan2
        }
        chain srcnat_wan {
                masquerade
        }
        chain srcnat_wan2 {
                meta nfproto ipv4 masquerade
        }
}";
        assert!(parse_has_ipv6_masq(dual_wan_fw4, "eth1"));
        assert!(!parse_has_ipv6_masq(dual_wan_fw4, "eth2"));

        // `snat ip to ...` in inet table is IPv4-only
        let inet_snat4 = "\
table inet nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oifname \"eth1\" snat ip to 203.0.113.1
        }
}";
        assert!(!parse_has_ipv6_masq(inet_snat4, "eth1"));
    }

    #[test]
    fn test_strip_fw4_user_block() {
        let original = "#!/bin/sh\n# custom rule\n# --- flowcone start ---\ninjected\n# --- flowcone end ---\n# footer\n";
        let stripped = strip_fw4_user_block(original);
        assert_eq!(stripped, "#!/bin/sh\n# custom rule\n# footer\n");

        let eof_block = "#!/bin/sh\n# --- flowcone start ---\ninjected\n# --- flowcone end ---";
        assert_eq!(strip_fw4_user_block(eof_block), "#!/bin/sh\n");

        let no_block = "#!/bin/sh\necho hi\n";
        assert_eq!(strip_fw4_user_block(no_block), no_block);
    }

    #[test]
    fn test_live_rules_use_sets_and_new_state() {
        let r4 = generate_srcnat_rule_v4("eth1", 0, 0);
        assert!(r4.contains("ip saddr @flowcone_v4"));
        assert!(r4.contains("255.0.0.0/8"));
        assert!(!r4.contains("255.255.255.255"));
        let r6_srcnat = generate_srcnat_rule_v6("eth1", 0, 0);
        assert!(r6_srcnat.contains("ip6 saddr @flowcone_v6"));
        assert!(r6_srcnat.contains("udp sport != { 546, 547 }"));
        assert!(r6_srcnat.contains("ip6 daddr != ff00::/8"));
        assert!(r6_srcnat.contains("ip6 daddr != fe80::/10"));
        let r6 = generate_forward_rule_v6("eth1", 0x40000000);
        assert!(r6.contains("ct state new"));
        assert!(r6.contains("ip6 saddr @flowcone_fwd6"));
        assert!(r6.contains("iifname \"eth1\""));
    }

    #[test]
    fn test_set_definitions_parse() {
        let defs = set_definitions();
        assert!(defs.contains("set flowcone_v4"));
        assert!(defs.contains("set flowcone_v6"));
        assert!(defs.contains("set flowcone_fwd4"));
        assert!(defs.contains("set flowcone_fwd6"));
        assert!(defs.contains("flags interval,timeout"));
    }
}
