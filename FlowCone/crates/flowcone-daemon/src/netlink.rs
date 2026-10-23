use rustix::net::{AddressFamily, SocketFlags, SocketType, recv, send, socket_with};


#[inline(always)]
fn read_u16_ne(buf: &[u8], off: usize) -> u16 {
    u16::from_ne_bytes([buf[off], buf[off + 1]])
}

#[inline(always)]
fn read_u32_ne(buf: &[u8], off: usize) -> u32 {
    u32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

#[inline(always)]
fn read_u32_bytes(buf: &[u8], off: usize) -> [u8; 4] {
    [buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetlinkError {
    SocketError,
    SendError,
    RecvError,
    ProtocolError,
}

/// Retrieve IPv4 address for an interface via Linux Netlink (RTM_GETADDR).
/// Correctly distinguishes IFA_LOCAL (local address) from IFA_ADDRESS (peer on P2P/PPPoE).
///
/// Returns:
/// - `Ok(Some(ip))` if a global IPv4 address is found
/// - `Ok(None)` if the netlink dump completed successfully (NLMSG_DONE) or interface doesn't exist,
///   confirming that the interface truly has no global IPv4 address
/// - `Err(NetlinkError)` if socket creation, send, or recv times out/fails (transient error).
pub fn get_iface_ipv4(ifname: &str) -> Result<Option<[u8; 4]>, NetlinkError> {
    let ifindex_str = match std::fs::read_to_string(format!("/sys/class/net/{}/ifindex", ifname)) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let target_ifindex: u32 = match ifindex_str.trim().parse() {
        Ok(idx) => idx,
        Err(_) => return Ok(None),
    };

    let sock = socket_with(
        AddressFamily::NETLINK,
        SocketType::RAW,
        SocketFlags::CLOEXEC,
        None,
    )
    .map_err(|_| NetlinkError::SocketError)?;

    let _ = rustix::net::sockopt::set_socket_timeout(
        &sock,
        rustix::net::sockopt::Timeout::Recv,
        Some(std::time::Duration::from_secs(1)),
    );

    let mut req_bytes = [0u8; 24];
    req_bytes[0..4].copy_from_slice(&(24u32).to_ne_bytes());
    req_bytes[4..6].copy_from_slice(&(22u16).to_ne_bytes()); // RTM_GETADDR
    req_bytes[6..8].copy_from_slice(&(0x0301u16).to_ne_bytes()); // NLM_F_REQUEST | NLM_F_ROOT | NLM_F_MATCH
    req_bytes[8..12].copy_from_slice(&(1u32).to_ne_bytes());
    req_bytes[12..16].copy_from_slice(&(0u32).to_ne_bytes());
    req_bytes[16] = 2; // AF_INET
    req_bytes[20..24].copy_from_slice(&target_ifindex.to_ne_bytes());

    if send(&sock, &req_bytes, rustix::net::SendFlags::empty()).is_err() {
        return Err(NetlinkError::SendError);
    }

    let mut buf = [0u8; 32768];
    loop {
        let (n, _) = recv(&sock, &mut buf, rustix::net::RecvFlags::empty())
            .map_err(|_| NetlinkError::RecvError)?;
        if n == 0 {
            break;
        }

        let mut offset = 0;
        while offset + 16 <= n {
            let nlmsg_len = read_u32_ne(&buf, offset) as usize;
            let nlmsg_type = read_u16_ne(&buf, offset + 4);

            if nlmsg_type == 2 {
                return Err(NetlinkError::ProtocolError);
            }
            if nlmsg_type == 3 {
                return Ok(None);
            }
            if nlmsg_type == 20 && offset + 16 + 8 <= n {
                let ifa_family = buf[offset + 16];
                let ifa_flags = buf[offset + 18];
                let ifa_scope = buf[offset + 19];
                let ifa_index = read_u32_ne(&buf, offset + 20);
                if ifa_family == 2 && ifa_index == target_ifindex && ifa_scope == 0 && (ifa_flags & 0x01) == 0 {
                    let mut rta_offset = offset + 24;
                    let end = (offset + nlmsg_len).min(n);
                    let mut ifa_local = None;
                    let mut ifa_address = None;
                    while rta_offset + 4 <= end {
                        let rta_len = read_u16_ne(&buf, rta_offset) as usize;
                        let rta_type = read_u16_ne(&buf, rta_offset + 2);
                        if rta_len < 4 {
                            break;
                        }
                        if rta_type == 2 && rta_offset + 8 <= end {
                            ifa_local = Some(read_u32_bytes(&buf, rta_offset + 4));
                        } else if rta_type == 1 && rta_offset + 8 <= end {
                            ifa_address = Some(read_u32_bytes(&buf, rta_offset + 4));
                        }
                        rta_offset += (rta_len + 3) & !3;
                    }
                    if let Some(ip) = ifa_local.or(ifa_address) {
                        return Ok(Some(ip));
                    }
                }
            }

            let aligned_len = (nlmsg_len + 3) & !3;
            if aligned_len == 0 || offset + aligned_len > n {
                break;
            }
            offset += aligned_len;
        }
    }

    Ok(None)
}

/// Detect L2 header length for interface.
/// Returns 14 for Ethernet (ARPHRD_ETHER = 1), 0 for PPP (512), NONE (65534), RAWIP (519), etc.
pub fn get_iface_l2_len(ifname: &str) -> u32 {
    let type_path = format!("/sys/class/net/{}/type", ifname);
    if let Ok(content) = std::fs::read_to_string(type_path) {
        if let Ok(dev_type) = content.trim().parse::<u16>() {
            if dev_type == 1 {
                return 14;
            } else {
                return 0;
            }
        }
    }
    14
}

/// Retrieve global IPv6 address from standard Linux /proc/net/if_inet6.
/// Returns `Ok(Some(ip))` if found, `Ok(None)` if file read succeeded but interface has no global IPv6,
/// or `Err(e)` on filesystem I/O error.
pub fn get_iface_ipv6(ifname: &str) -> Result<Option<[u8; 16]>, std::io::Error> {
    let content = std::fs::read_to_string("/proc/net/if_inet6")?;
    Ok(parse_proc_inet6(&content, ifname))
}

/// Pure parser function for /proc/net/if_inet6 lines (enables unit testing).
/// Filters out temporary (0x01, RFC 4941 privacy), tentative (0x40), failed (0x08), and deprecated (0x20).
/// Prefers permanent (0x80) global addresses.
pub fn parse_proc_inet6(content: &str, target_ifname: &str) -> Option<[u8; 16]> {
    let mut fallback = None;
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        let hex_addr = parts.next()?;
        let _ifindex = parts.next()?;
        let _plen = parts.next()?;
        let scope = parts.next()?;
        let flags_str = parts.next()?;
        let dev = parts.next()?;

        // scope 00 = global scope
        if dev == target_ifname && scope == "00" && hex_addr.len() == 32 {
            let flags = u8::from_str_radix(flags_str, 16).unwrap_or(0);
            // Skip IFA_F_TEMPORARY (0x01), IFA_F_DADFAILED (0x08), IFA_F_DEPRECATED (0x20), IFA_F_TENTATIVE (0x40)
            if (flags & 0x69) != 0 {
                continue;
            }

            let mut bytes = [0u8; 16];
            let mut valid = true;
            for i in 0..16 {
                if let Ok(b) = u8::from_str_radix(&hex_addr[i * 2..i * 2 + 2], 16) {
                    bytes[i] = b;
                } else {
                    valid = false;
                    break;
                }
            }
            if !valid {
                continue;
            }

            // Prefer permanent address (IFA_F_PERMANENT = 0x80)
            if (flags & 0x80) != 0 {
                return Some(bytes);
            } else if fallback.is_none() {
                fallback = Some(bytes);
            }
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_proc_inet6() {
        let sample = "\
00000000000000000000000000000001 01 80 10 80       lo
fe8000000000000002155dfffe123456 02 40 20 80     eth0
240e0123456789abcdef0123456789ad 03 40 00 01     eth1
240e0123456789abcdef0123456789ac 03 40 00 40     eth1
240e0123456789abcdef0123456789ab 03 40 00 80     eth1
";
        // 240e...ad has flag 0x01 (IFA_F_TEMPORARY, privacy extension) and should be skipped.
        // 240e...ac has flag 0x40 (IFA_F_TENTATIVE, DAD in progress) and should be skipped.
        // 240e...ab has flag 0x80 (permanent) and should be chosen.
        let res = parse_proc_inet6(sample, "eth1").expect("should find global IPv6 for eth1");
        assert_eq!(
            res,
            [
                0x24, 0x0e, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67,
                0x89, 0xab
            ]
        );

        assert_eq!(parse_proc_inet6(sample, "lo"), None); // scope 10 != 00
        assert_eq!(parse_proc_inet6(sample, "eth0"), None); // scope 20 != 00
    }
}
