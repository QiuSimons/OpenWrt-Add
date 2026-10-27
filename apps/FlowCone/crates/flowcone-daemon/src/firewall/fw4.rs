//! OpenWrt fw4 integration: rule text, liveness sets and persistence files.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use super::nft::nft_apply;

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

pub(crate) const SET_V4: &str = "flowcone_v4";
pub(crate) const SET_V6: &str = "flowcone_v6";
pub(crate) const SET_FWD4: &str = "flowcone_fwd4";
pub(crate) const SET_FWD6: &str = "flowcone_fwd6";

pub(crate) const LIVENESS_TIMEOUT_SEC: u64 = 15;

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
                "flowcone: WARNING: Hardware Flow Offloading (flags offload) is detected!\n\
                     Hardware offloading directs packets through the switch ASIC/PPE, bypassing CPU TC egress.\n\
                     This will cause private IP leakage and broken NAT.\n\
                     Please disable Hardware Offloading in OpenWrt ('uci set firewall.@defaults[0].flow_offloading_hw=0 && uci commit firewall && fw4 reload')."
            );
        }
    }
}

/// IPv4 source set of the srcnat exemption, matching is_private_ipv4().
pub(crate) fn v4_src_set() -> String {
    flowcone_common::INTERNAL_V4_PREFIXES.join(", ")
}

/// Inline srcnat rule for the generic-firewall path.
pub(crate) fn generate_fw4_srcnat_rule_v4(iface: &str) -> String {
    format!(
        "oifname \"{iface}\" meta nfproto ipv4 meta l4proto udp ip saddr {{ {} }} counter return comment \"flowcone\"",
        v4_src_set()
    )
}

/// Inline srcnat rule for the generic-firewall path.
pub(crate) fn generate_fw4_srcnat_rule_v6(iface: &str, is_masq: bool) -> String {
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

pub(crate) fn generate_fw4_forward_rules() -> Vec<String> {
    vec!["meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\"".to_string()]
}

pub(crate) fn has_table_inet_fw4() -> bool {
    Command::new("nft")
        .args(["list", "table", "inet", "fw4"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Detect IPv6 masquerade in ip6 or inet tables.
pub(crate) fn parse_has_ipv6_masq(nft_output: &str) -> bool {
    let mut family = "";
    for line in nft_output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("table ") {
            if let Some(rest) = trimmed.strip_prefix("table ") {
                family = rest.split_whitespace().next().unwrap_or("");
            }
            continue;
        }
        if !trimmed.contains("masquerade") {
            continue;
        }
        // nat6's partial masquerade covers TCP/ICMP only; FlowCone owns UDP.
        if trimmed.contains("flowcone-nat6-partial") {
            continue;
        }
        let has_v4 =
            family == "ip" || trimmed.contains("nfproto ipv4") || trimmed.contains("bcmfullcone4");
        let has_v6 = family == "ip6"
            || trimmed.contains("nfproto ipv6")
            || trimmed.contains("ip6 ")
            || trimmed.contains("ipv6")
            || trimmed.contains("bcmfullcone6");
        if has_v6 && !has_v4 {
            return true;
        }
    }
    false
}

pub(crate) fn is_ipv6_masq_enabled() -> bool {
    let Ok(out) = Command::new("nft").args(["list", "ruleset"]).output() else {
        return false;
    };
    if !out.status.success() {
        return false;
    }
    parse_has_ipv6_masq(&String::from_utf8_lossy(&out.stdout))
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
            result = format!("{}{}", before.trim_end(), after);
        } else {
            break;
        }
    }
    result
}

pub(crate) fn clean_firewall4_user_file() {
    if let Ok(current) = fs::read_to_string(FW4_USER_PATH) {
        let cleaned = strip_fw4_user_block(&current);
        let _ = fs::write(FW4_USER_PATH, cleaned.trim());
    }
}

/// Set definitions live inside table inet fw4. fw4 includes
/// /etc/nftables.d/*.nft inside the table before chains, so a rule loaded
/// from chain-pre can reference these sets even when no daemon is running.
pub(crate) fn set_definitions() -> String {
    format!(
        "set {} {{
    type ipv4_addr
    flags interval,timeout
}}

set {} {{
    type ipv6_addr
    flags interval,timeout
}}

set {} {{
    type ipv4_addr
    flags interval,timeout
}}

set {} {{
    type ipv6_addr
    flags interval,timeout
}}
",
        SET_V4, SET_V6, SET_FWD4, SET_FWD6
    )
}

pub(crate) fn write_fw4_set_definitions() -> bool {
    let _ = fs::create_dir_all(SET_DEFS_DIR);
    fs::write(SET_DEFS_FILE, set_definitions()).is_ok()
}

pub(crate) fn clean_fw4_set_definitions() {
    let _ = fs::remove_file(SET_DEFS_FILE);
}

fn nft_set_exists(set: &str) -> bool {
    Command::new("nft")
        .args(["list", "set", "inet", "fw4", set])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn add_fw4_set(set: &str, family: &str) -> bool {
    let script = format!(
        "add set inet fw4 {} {{ type {}; flags interval,timeout; }}\n",
        set, family
    );
    nft_apply(&script).is_ok()
}

/// Ensure the four liveness sets exist in the live kernel table. They may not
/// exist on the first start or after a fw4 reload.
pub(crate) fn ensure_fw4_sets() -> bool {
    if !has_table_inet_fw4() {
        return false;
    }
    let mut ok = true;
    for (set, family) in [
        (SET_V4, "ipv4_addr"),
        (SET_V6, "ipv6_addr"),
        (SET_FWD4, "ipv4_addr"),
        (SET_FWD6, "ipv6_addr"),
    ] {
        if !nft_set_exists(set) && !add_fw4_set(set, family) {
            ok = false;
        }
    }
    ok
}

pub(crate) fn bypass_clause(mask: u32, val: u32) -> String {
    if mask == 0 {
        String::new()
    } else {
        format!(" meta mark & {:#x} != {:#x}", mask, val)
    }
}

/// Extra guards matching the eBPF bypass_special_udp4() checks.
fn special_v4_clause() -> &'static str {
    " ip saddr != 0.0.0.0/8 udp sport != { 67, 68 } udp dport != { 67, 68 } ip daddr != 255.255.255.255 ip daddr != 224.0.0.0/4 ip daddr != 169.254.0.0/16"
}

pub(crate) fn generate_live_srcnat_rule_v4(
    iface: &str,
    bypass_mask: u32,
    bypass_val: u32,
) -> String {
    format!(
        "oifname \"{iface}\" meta nfproto ipv4 meta l4proto udp ip saddr @{}{}{} counter return comment \"flowcone\"",
        SET_V4,
        bypass_clause(bypass_mask, bypass_val),
        special_v4_clause()
    )
}

pub(crate) fn generate_live_srcnat_rule_v6(
    iface: &str,
    bypass_mask: u32,
    bypass_val: u32,
) -> String {
    format!(
        "oifname \"{iface}\" meta nfproto ipv6 meta l4proto udp ip6 saddr @{}{} counter return comment \"flowcone\"",
        SET_V6,
        bypass_clause(bypass_mask, bypass_val)
    )
}

pub(crate) fn generate_live_forward_rule_v4(iface: &str, mark: u32) -> String {
    format!(
        "iifname \"{iface}\" meta mark & {:#x} == {:#x} ct state new ip saddr @{} counter accept comment \"flowcone\"",
        mark, mark, SET_FWD4
    )
}

pub(crate) fn generate_live_forward_rule_v6(iface: &str, mark: u32) -> String {
    format!(
        "iifname \"{iface}\" meta mark & {:#x} == {:#x} ct state new ip6 saddr @{} counter accept comment \"flowcone\"",
        mark, mark, SET_FWD6
    )
}

pub(crate) fn build_fw4_insert_script_live(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    _is_v6_masq: bool,
    mark: u32,
    bypass_mask: u32,
    bypass_val: u32,
) -> String {
    let mut script = String::new();
    if enable_v4 {
        script.push_str(&format!(
            "insert rule inet fw4 srcnat {}\n",
            generate_live_srcnat_rule_v4(iface, bypass_mask, bypass_val)
        ));
    }
    if enable_v6 {
        script.push_str(&format!(
            "insert rule inet fw4 srcnat {}\n",
            generate_live_srcnat_rule_v6(iface, bypass_mask, bypass_val)
        ));
    }
    if enable_v4 {
        script.push_str(&format!(
            "insert rule inet fw4 forward {}\n",
            generate_live_forward_rule_v4(iface, mark)
        ));
    }
    if enable_v6 {
        script.push_str(&format!(
            "insert rule inet fw4 forward {}\n",
            generate_live_forward_rule_v6(iface, mark)
        ));
    }
    script
}

pub(crate) fn update_chain_pre_files_live(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    mark: u32,
    bypass_mask: u32,
    bypass_val: u32,
) {
    let _ = fs::create_dir_all(FW4_CHAIN_PRE_SRCNAT_DIR);
    let _ = fs::create_dir_all(FW4_CHAIN_PRE_FORWARD_DIR);

    let mut srcnat_lines = Vec::new();
    if enable_v4 {
        srcnat_lines.push(generate_live_srcnat_rule_v4(iface, bypass_mask, bypass_val));
    }
    if enable_v6 {
        srcnat_lines.push(generate_live_srcnat_rule_v6(iface, bypass_mask, bypass_val));
    }
    if !srcnat_lines.is_empty() {
        let _ = fs::write(FW4_CHAIN_PRE_SRCNAT_FILE, srcnat_lines.join("\n") + "\n");
    } else {
        let _ = fs::remove_file(FW4_CHAIN_PRE_SRCNAT_FILE);
    }

    let mut fwd_lines = Vec::new();
    if enable_v4 {
        fwd_lines.push(generate_live_forward_rule_v4(iface, mark));
    }
    if enable_v6 {
        fwd_lines.push(generate_live_forward_rule_v6(iface, mark));
    }
    if !fwd_lines.is_empty() {
        let _ = fs::write(FW4_CHAIN_PRE_FORWARD_FILE, fwd_lines.join("\n") + "\n");
    } else {
        let _ = fs::remove_file(FW4_CHAIN_PRE_FORWARD_FILE);
    }
}

pub(crate) fn v6_elements(is_masq: bool) -> &'static str {
    if is_masq {
        // GUA plus ULA. eBPF excludes link-local, multicast and loopback
        // sources itself, so no unrelated traffic is NATed.
        "2000::/3 timeout 15s, fc00::/7 timeout 15s"
    } else {
        "fc00::/7 timeout 15s"
    }
}

/// Refresh the kernel timeout of the liveness elements. The rule references
/// the set, but the set is empty unless this is called: a crashed daemon
/// therefore loses the exemption within LIVENESS_TIMEOUT_SEC.
pub(crate) fn refresh_fw4_liveness(
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
    verbose: bool,
) -> bool {
    let mut script = String::new();
    if enable_v4 {
        let elements = flowcone_common::INTERNAL_V4_PREFIXES
            .iter()
            .map(|p| format!("{} timeout {}s", p, LIVENESS_TIMEOUT_SEC))
            .collect::<Vec<_>>()
            .join(", ");
        script.push_str(&format!(
            "add element inet fw4 {} {{ {} }}\n",
            SET_V4, elements
        ));
        script.push_str(&format!(
            "add element inet fw4 {} {{ 0.0.0.0/0 timeout {}s }}\n",
            SET_FWD4, LIVENESS_TIMEOUT_SEC
        ));
    }
    if enable_v6 {
        script.push_str(&format!(
            "add element inet fw4 {} {{ {} }}\n",
            SET_V6,
            v6_elements(is_v6_masq)
        ));
        script.push_str(&format!(
            "add element inet fw4 {} {{ ::/0 timeout {}s }}\n",
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
                eprintln!("flowcone: liveness refresh failed: {}", e);
            }
            false
        }
    }
}

pub(crate) fn remove_fw4_sets() {
    let mut script = String::new();
    for set in [SET_V4, SET_V6, SET_FWD4, SET_FWD6] {
        script.push_str(&format!("delete set inet fw4 {}\n", set));
    }
    let _ = nft_apply(&script);
}

/// Remove generated chain-pre include files.
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
    fn test_generate_fw4_chain_pre_rules() {
        let set = flowcone_common::INTERNAL_V4_PREFIXES.join(", ");
        let srcnat_v4 = generate_fw4_srcnat_rule_v4("eth1");
        assert_eq!(
            srcnat_v4,
            format!(
                "oifname \"eth1\" meta nfproto ipv4 meta l4proto udp ip saddr {{ {set} }} counter return comment \"flowcone\""
            )
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
    fn test_parse_has_ipv6_masq_ignores_nat6_partial() {
        let partial = "\
table ip6 nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oif \"eth1\" meta l4proto != udp masquerade comment \"flowcone-nat6-partial\"
        }
}";
        assert!(!parse_has_ipv6_masq(partial));
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

        let ip6_nat = "\
table ip6 nat {
        chain postrouting {
                type nat hook postrouting priority srcnat; policy accept;
                oif \"eth1\" masquerade
        }
}";
        assert!(parse_has_ipv6_masq(ip6_nat));
    }

    #[test]
    fn test_strip_fw4_user_block() {
        let original = "#!/bin/sh\n# custom rule\n# --- flowcone start ---\ninjected\n# --- flowcone end ---\n# footer\n";
        let stripped = strip_fw4_user_block(original);
        assert_eq!(stripped, "#!/bin/sh\n# custom rule\n# footer\n");

        let no_block = "#!/bin/sh\necho hi\n";
        assert_eq!(strip_fw4_user_block(no_block), no_block);
    }
    #[test]
    fn test_live_rules_use_sets_and_new_state() {
        let r4 = generate_live_srcnat_rule_v4("eth1", 0, 0);
        assert!(r4.contains("ip saddr @flowcone_v4"));
        assert!(r4.contains("ip saddr != 0.0.0.0/8"));
        let r6 = generate_live_forward_rule_v6("eth1", 0x40000000);
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
