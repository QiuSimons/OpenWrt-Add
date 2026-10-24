//! OpenWrt fw4 integration: rule text, chain-pre includes and the
//! `/etc/firewall4.user` fallback.

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

pub(crate) const FW4_USER_PATH: &str = "/etc/firewall4.user";
pub(crate) const FW4_NFTABLES_D_DIR: &str = "/usr/share/nftables.d";
pub(crate) const FW4_CHAIN_PRE_SRCNAT_DIR: &str = "/usr/share/nftables.d/chain-pre/srcnat";
pub(crate) const FW4_CHAIN_PRE_SRCNAT_FILE: &str =
    "/usr/share/nftables.d/chain-pre/srcnat/10-flowcone.nft";
pub(crate) const FW4_CHAIN_PRE_FORWARD_DIR: &str = "/usr/share/nftables.d/chain-pre/forward";
pub(crate) const FW4_CHAIN_PRE_FORWARD_FILE: &str =
    "/usr/share/nftables.d/chain-pre/forward/10-flowcone.nft";

pub(crate) const FLOWCONE_TAG_START: &str = "# --- flowcone start ---";
pub(crate) const FLOWCONE_TAG_END: &str = "# --- flowcone end ---";

/// Check if hardware flow offload is enabled in nftables flowtables.
/// Hardware Flow Offloading (PPE/DSA/ASIC) bypasses the CPU and TC egress entirely,
/// causing private IP leakage and broken NAT.
pub(crate) fn check_hardware_offload_warning() {
    let Ok(out) = Command::new("nft").args(["list", "flowtables"]).output() else {
        return;
    };
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

/// IPv4 source set of the srcnat exemption, matching is_private_ipv4().
pub(crate) fn v4_src_set() -> String {
    flowcone_common::INTERNAL_V4_PREFIXES.join(", ")
}

/// Generate IPv4 srcnat exemption rule.
/// Skips masquerade for private IPv4 source traffic on WAN interface.
pub(crate) fn generate_fw4_srcnat_rule_v4(iface: &str) -> String {
    format!(
        "oifname \"{iface}\" meta nfproto ipv4 meta l4proto udp ip saddr {{ {} }} counter return comment \"flowcone\"",
        v4_src_set()
    )
}

/// Generate IPv6 srcnat exemption rule (NAT66).
/// If masquerade is enabled, exemptions cover all IPv6 UDP; otherwise only ULA (fc00::/7).
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

/// Generate forward rules to accept inbound packets marked with FLOWCONE_MARK.
pub(crate) fn generate_fw4_forward_rules() -> Vec<String> {
    vec!["meta mark & 0x40000000 == 0x40000000 counter accept comment \"flowcone\"".to_string()]
}

pub(crate) fn generate_fw4_user_block(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) -> String {
    let mut lines = Vec::new();
    lines.push(FLOWCONE_TAG_START.to_string());
    // fw4 runs this file with /bin/sh, so the rule has to be one quoted word:
    // an unquoted `&` (meta mark & 0x40000000) would start a background job.
    if enable_v4 {
        let r4 = generate_fw4_srcnat_rule_v4(iface);
        lines.push(format!(
            "nft 'insert rule inet fw4 srcnat {}' 2>/dev/null || true",
            r4
        ));
    }
    if enable_v6 {
        let r6 = generate_fw4_srcnat_rule_v6(iface, is_v6_masq);
        lines.push(format!(
            "nft 'insert rule inet fw4 srcnat {}' 2>/dev/null || true",
            r6
        ));
    }
    if enable_v4 || enable_v6 {
        for fwd in generate_fw4_forward_rules() {
            lines.push(format!(
                "nft 'insert rule inet fw4 forward {}' 2>/dev/null || true",
                fwd
            ));
        }
    }
    lines.push(FLOWCONE_TAG_END.to_string());
    lines.join("\n") + "\n"
}

/// Check if OpenWrt's `table inet fw4` exists in the system
pub(crate) fn has_table_inet_fw4() -> bool {
    Command::new("nft")
        .args(["list", "table", "inet", "fw4"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Parse nftables rules text to detect if IPv6 masquerade is enabled
pub(crate) fn parse_has_ipv6_masq(nft_output: &str) -> bool {
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
pub(crate) fn is_ipv6_masq_enabled() -> bool {
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

pub(crate) fn update_firewall4_user_file(
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

pub(crate) fn clean_firewall4_user_file() {
    if let Ok(current) = fs::read_to_string(FW4_USER_PATH) {
        let cleaned = strip_fw4_user_block(&current);
        let _ = fs::write(FW4_USER_PATH, cleaned.trim());
    }
}

pub(crate) fn update_chain_pre_files(
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

    if enable_v4 || enable_v6 {
        let fwd_content = generate_fw4_forward_rules().join("\n") + "\n";
        let _ = fs::write(FW4_CHAIN_PRE_FORWARD_FILE, fwd_content);
    } else {
        let _ = fs::remove_file(FW4_CHAIN_PRE_FORWARD_FILE);
    }
}

pub(crate) fn clean_chain_pre_files() {
    let _ = fs::remove_file(FW4_CHAIN_PRE_SRCNAT_FILE);
    let _ = fs::remove_file(FW4_CHAIN_PRE_FORWARD_FILE);
}

/// Insert statements for `table inet fw4`.
pub(crate) fn build_fw4_insert_script(
    iface: &str,
    enable_v4: bool,
    enable_v6: bool,
    is_v6_masq: bool,
) -> String {
    let mut script = String::new();
    if enable_v4 {
        script.push_str(&format!(
            "insert rule inet fw4 srcnat {}\n",
            generate_fw4_srcnat_rule_v4(iface)
        ));
    }
    if enable_v6 {
        script.push_str(&format!(
            "insert rule inet fw4 srcnat {}\n",
            generate_fw4_srcnat_rule_v6(iface, is_v6_masq)
        ));
    }
    if enable_v4 || enable_v6 {
        for fwd in generate_fw4_forward_rules() {
            script.push_str(&format!("insert rule inet fw4 forward {}\n", fwd));
        }
    }
    script
}

/// Prefer /usr/share/nftables.d/chain-pre (loaded natively by fw4); the
/// /etc/firewall4.user fallback would inject the same rules twice.
pub(crate) fn use_chain_pre() -> bool {
    // Probe the directory fw4 scans: on a fresh install the chain-pre/<chain>
    // subdirectories do not exist yet (update_chain_pre_files creates them).
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
        // no uci, or the option is unset: fw4 defaults to enabled
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_fw4_user_block() {
        let inc = generate_fw4_user_block("eth1", true, true, false);
        assert!(inc.contains(FLOWCONE_TAG_START));
        assert!(inc.contains(&format!(
            "oifname \"eth1\" meta nfproto ipv4 meta l4proto udp ip saddr {{ {} }}",
            flowcone_common::INTERNAL_V4_PREFIXES.join(", ")
        )));
        assert!(inc.contains("meta mark & 0x40000000 == 0x40000000"));
        // Every nft invocation must be one single-quoted word, otherwise
        // /bin/sh splits the rule at `&` and the insert never happens.
        for line in inc.lines().filter(|l| l.starts_with("nft ")) {
            assert!(
                line.starts_with("nft '") && line.contains("' 2>/dev/null || true"),
                "unquoted nft invocation: {line}"
            );
        }
        assert!(inc.contains("ip6 saddr fc00::/7"));
        assert!(inc.contains(FLOWCONE_TAG_END));
    }

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

    #[test]
    fn test_build_fw4_insert_script() {
        let both = build_fw4_insert_script("eth1", true, true, false);
        assert!(both.contains("insert rule inet fw4 srcnat oifname \"eth1\" meta nfproto ipv4"));
        assert!(both.contains("ip6 saddr fc00::/7"));
        assert!(both.contains("insert rule inet fw4 forward meta mark & 0x40000000"));
        assert_eq!(both.lines().count(), 3);

        let v4_only = build_fw4_insert_script("eth1", true, false, false);
        assert_eq!(v4_only.lines().count(), 2);
        assert!(!v4_only.contains("nfproto ipv6"));

        // masq6 detected: the v6 exemption must match all IPv6, not ULA only
        let v6_masq = build_fw4_insert_script("eth1", false, true, true);
        assert_eq!(v6_masq.lines().count(), 2);
        assert!(v6_masq.contains("meta nfproto ipv6 meta l4proto udp counter return"));
        assert!(!v6_masq.contains("fc00::/7"));

        assert!(build_fw4_insert_script("eth1", false, false, false).is_empty());
    }
}
