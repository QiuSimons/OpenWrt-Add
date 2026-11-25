use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::io::Errno;
use rustix::net::{
    AddressFamily, RecvFlags, SendFlags, SocketFlags, SocketType, bind, netlink::SocketAddrNetlink,
    recv, send, socket_with, sockopt,
};
use std::fmt;

const AF_INET: u8 = 2;
const AF_INET6: u8 = 10;
const RT_SCOPE_UNIVERSE: u8 = 0;

const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;
const RTM_NEWLINK: u16 = 16;
const RTM_DELLINK: u16 = 17;
const RTM_NEWADDR: u16 = 20;
const RTM_DELADDR: u16 = 21;
const RTM_GETADDR: u16 = 22;

const NLM_F_REQUEST: u16 = 0x0001;
const NLM_F_ROOT: u16 = 0x0100;
const NLM_F_MATCH: u16 = 0x0200;

const IFLA_IFNAME: u16 = 3;
const IFA_ADDRESS: u16 = 1;
const IFA_LOCAL: u16 = 2;
const IFA_FLAGS: u16 = 8;

const ARPHRD_ETHER: u16 = 1;

#[inline(always)]
fn read_u16_ne(buf: &[u8], off: usize) -> u16 {
    u16::from_ne_bytes([buf[off], buf[off + 1]])
}

#[inline(always)]
fn read_u32_ne(buf: &[u8], off: usize) -> u32 {
    u32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NetlinkError {
    Socket,
    Send,
    Recv,
    Protocol,
}

impl fmt::Display for NetlinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Socket => f.write_str("netlink socket creation failed"),
            Self::Send => f.write_str("netlink send failed"),
            Self::Recv => f.write_str("netlink receive failed"),
            Self::Protocol => f.write_str("netlink protocol error"),
        }
    }
}

impl std::error::Error for NetlinkError {}

/// Receive one netlink datagram cleanly handling `EINTR` and resizing if `MSG_TRUNC`.
pub(crate) fn recv_netlink_msg(
    sock: &OwnedFd,
    buf: &mut Vec<u8>,
    flags: RecvFlags,
) -> Result<usize, Errno> {
    loop {
        let peek_flags = flags | RecvFlags::PEEK | RecvFlags::TRUNC;
        match recv(sock, &mut buf[..], peek_flags) {
            Ok((needed, _)) => {
                if needed == 0 {
                    // Drain empty read cleanly.
                    loop {
                        match recv(sock, &mut buf[..], flags) {
                            Ok((n, _)) => return Ok(n),
                            Err(Errno::INTR) => continue,
                            Err(e) => return Err(e),
                        }
                    }
                }
                if needed > buf.len() {
                    buf.resize(needed, 0);
                }
                match recv(sock, &mut buf[..], flags) {
                    Ok((n, _)) => return Ok(n),
                    Err(Errno::INTR) => continue,
                    Err(e) => return Err(e),
                }
            }
            Err(Errno::INTR) => continue,
            Err(e) => return Err(e),
        }
    }
}

/// One local address of an interface, as reported by RTM_GETADDR.
pub(crate) struct IfaceAddr {
    pub(crate) family: u8,
    pub(crate) flags: u32,
    pub(crate) scope: u8,
    pub(crate) addr: [u8; 16],
}

const IFA_F_SECONDARY: u32 = 0x01;
/// IPv6 privacy addresses reuse the secondary-address bit.
const IFA_F_TEMPORARY: u32 = IFA_F_SECONDARY;
const IFA_F_DADFAILED: u32 = 0x08;
const IFA_F_DEPRECATED: u32 = 0x20;
const IFA_F_TENTATIVE: u32 = 0x40;
const IFA_F_PERMANENT: u32 = 0x80;

/// Dumps interface addresses for `ifindex` via RTM_GETADDR.
fn dump_iface_addrs(ifindex: u32, family: u8) -> Result<Vec<IfaceAddr>, NetlinkError> {
    if ifindex == 0 {
        return Ok(Vec::new());
    }

    let sock = socket_with(
        AddressFamily::NETLINK,
        SocketType::RAW,
        SocketFlags::CLOEXEC,
        None,
    )
    .map_err(|_| NetlinkError::Socket)?;

    let _ = sockopt::set_socket_timeout(
        &sock,
        sockopt::Timeout::Recv,
        Some(std::time::Duration::from_secs(1)),
    );

    let mut req_bytes = [0u8; 24];
    req_bytes[0..4].copy_from_slice(&(24u32).to_ne_bytes());
    req_bytes[4..6].copy_from_slice(&RTM_GETADDR.to_ne_bytes());
    req_bytes[6..8].copy_from_slice(&(NLM_F_REQUEST | NLM_F_ROOT | NLM_F_MATCH).to_ne_bytes());
    req_bytes[8..12].copy_from_slice(&(1u32).to_ne_bytes());
    req_bytes[12..16].copy_from_slice(&(0u32).to_ne_bytes());
    req_bytes[16] = family;
    req_bytes[20..24].copy_from_slice(&ifindex.to_ne_bytes());

    loop {
        match send(&sock, &req_bytes, SendFlags::empty()) {
            Ok(_) => break,
            Err(Errno::INTR) => continue,
            Err(_) => return Err(NetlinkError::Send),
        }
    }

    let mut addrs = Vec::new();
    let mut buf = vec![0u8; 8192];
    loop {
        let n = recv_netlink_msg(&sock, &mut buf, RecvFlags::empty())
            .map_err(|_| NetlinkError::Recv)?;
        if n == 0 {
            break;
        }

        let mut offset = 0;
        while offset + 16 <= n {
            let nlmsg_len = read_u32_ne(&buf, offset) as usize;
            let nlmsg_type = read_u16_ne(&buf, offset + 4);
            if nlmsg_len < 16 || offset + nlmsg_len > n {
                return Err(NetlinkError::Protocol);
            }

            if nlmsg_type == NLMSG_ERROR {
                if offset + 20 <= n {
                    let errno = i32::from_ne_bytes([
                        buf[offset + 16],
                        buf[offset + 17],
                        buf[offset + 18],
                        buf[offset + 19],
                    ]);
                    if errno == 0 {
                        offset += (nlmsg_len + 3) & !3;
                        continue;
                    }
                }
                return Err(NetlinkError::Protocol);
            }
            if nlmsg_type == NLMSG_DONE {
                return Ok(addrs);
            }
            if nlmsg_type == RTM_NEWADDR && offset + 24 <= n {
                let ifa_family = buf[offset + 16];
                let mut flags = buf[offset + 18] as u32;
                let ifa_scope = buf[offset + 19];
                let ifa_index = read_u32_ne(&buf, offset + 20);
                if (family == 0 || ifa_family == family) && ifa_index == ifindex {
                    let mut rta_offset = offset + 24;
                    let end = offset + nlmsg_len;
                    let mut local = None;
                    let mut address = None;
                    while rta_offset + 4 <= end {
                        let rta_len = read_u16_ne(&buf, rta_offset) as usize;
                        let rta_type = read_u16_ne(&buf, rta_offset + 2);
                        if rta_len < 4 || rta_offset + rta_len > end {
                            break;
                        }
                        let payload = rta_offset + 4;
                        let payload_len = rta_len - 4;
                        if rta_type == IFA_FLAGS && payload_len >= 4 {
                            flags = read_u32_ne(&buf, payload);
                        } else if rta_type == IFA_ADDRESS || rta_type == IFA_LOCAL {
                            let mut addr = [0u8; 16];
                            let len = payload_len.min(16);
                            addr[..len].copy_from_slice(&buf[payload..payload + len]);
                            if rta_type == IFA_LOCAL {
                                local = Some(addr);
                            } else {
                                address = Some(addr);
                            }
                        }
                        rta_offset += (rta_len + 3) & !3;
                    }
                    if let Some(addr) = local.or(address) {
                        addrs.push(IfaceAddr {
                            family: ifa_family,
                            flags,
                            scope: ifa_scope,
                            addr,
                        });
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

    Ok(addrs)
}

/// Pick the global IPv4 address of an interface.
/// Retains the current address if still valid to avoid flapping.
fn pick_global_v4(addrs: &[IfaceAddr], current: Option<[u8; 4]>) -> Option<[u8; 4]> {
    let mut current_tier = None;
    let mut best_primary = None;
    let mut best_secondary = None;

    for a in addrs {
        if a.family == AF_INET && a.scope == RT_SCOPE_UNIVERSE {
            let addr4 = [a.addr[0], a.addr[1], a.addr[2], a.addr[3]];
            let is_sec = a.flags & IFA_F_SECONDARY != 0;
            let tier = if is_sec { 1u8 } else { 0u8 };

            if Some(addr4) == current {
                current_tier = Some(tier);
            }

            if is_sec {
                best_secondary = Some(best_secondary.map_or(addr4, |b: [u8; 4]| b.min(addr4)));
            } else {
                best_primary = Some(best_primary.map_or(addr4, |b: [u8; 4]| b.min(addr4)));
            }
        }
    }

    let highest_available = if best_primary.is_some() {
        Some(0u8)
    } else if best_secondary.is_some() {
        Some(1u8)
    } else {
        None
    };

    if let (Some(c_tier), Some(h_tier)) = (current_tier, highest_available)
        && c_tier <= h_tier
    {
        return current;
    }

    best_primary.or(best_secondary)
}

/// Pick a global unicast IPv6 address: permanent first, then a non-temporary
/// dynamic address, then a privacy/temporary address.
/// Retains the current address if still valid in the highest available tier.
fn pick_gua_v6(addrs: &[IfaceAddr], current: Option<[u8; 16]>) -> Option<[u8; 16]> {
    let mut current_tier = None;
    let mut best_perm = None;
    let mut best_dyn = None;
    let mut best_temp = None;

    for a in addrs {
        if a.family != AF_INET6 || a.scope != RT_SCOPE_UNIVERSE || (a.addr[0] & 0xe0) != 0x20 {
            continue;
        }
        if a.flags & (IFA_F_DADFAILED | IFA_F_DEPRECATED | IFA_F_TENTATIVE) != 0 {
            continue;
        }

        let is_perm = a.flags & IFA_F_PERMANENT != 0;
        let is_temp = a.flags & IFA_F_TEMPORARY != 0;

        let tier = if is_perm {
            0u8
        } else if !is_temp {
            1u8
        } else {
            2u8
        };

        if Some(a.addr) == current {
            current_tier = Some(tier);
        }

        match tier {
            0 => best_perm = Some(best_perm.map_or(a.addr, |b: [u8; 16]| b.min(a.addr))),
            1 => best_dyn = Some(best_dyn.map_or(a.addr, |b: [u8; 16]| b.min(a.addr))),
            _ => best_temp = Some(best_temp.map_or(a.addr, |b: [u8; 16]| b.min(a.addr))),
        }
    }

    let highest_available = if best_perm.is_some() {
        Some(0u8)
    } else if best_dyn.is_some() {
        Some(1u8)
    } else if best_temp.is_some() {
        Some(2u8)
    } else {
        None
    };

    if let (Some(c_tier), Some(h_tier)) = (current_tier, highest_available)
        && c_tier <= h_tier
    {
        return current;
    }

    best_perm.or(best_dyn).or(best_temp)
}

/// Global addresses of one interface.
pub(crate) struct IfaceAddrs {
    pub(crate) v4: Option<[u8; 4]>,
    pub(crate) v6: Option<[u8; 16]>,
}

/// Global addresses of an interface, from one rtnetlink dump.
pub(crate) fn get_iface_addrs(
    ifindex: u32,
    cur_v4: Option<[u8; 4]>,
    cur_v6: Option<[u8; 16]>,
) -> Result<IfaceAddrs, NetlinkError> {
    let addrs = dump_iface_addrs(ifindex, 0)?;
    Ok(IfaceAddrs {
        v4: pick_global_v4(&addrs, cur_v4),
        v6: pick_gua_v6(&addrs, cur_v6),
    })
}

/// Detect L2 header length for interface.
/// Returns 14 for Ethernet (`ARPHRD_ETHER = 1`), 0 for PPP/NONE/RAWIP/TUN/WireGuard.
fn l2_len_for_arp_type(dev_type: u16) -> u32 {
    if dev_type == ARPHRD_ETHER { 14 } else { 0 }
}

pub(crate) fn get_iface_l2_len(ifname: &str) -> Option<u32> {
    let type_path = format!("/sys/class/net/{}/type", ifname);
    let content = std::fs::read_to_string(type_path).ok()?;
    let dev_type = content.trim().parse::<u16>().ok()?;
    Some(l2_len_for_arp_type(dev_type))
}

/// rtnetlink multicast groups: link state and IPv4/IPv6 address changes.
const RTNLGRP_LINK: u32 = 1;
const RTNLGRP_IPV4_IFADDR: u32 = 5;
const RTNLGRP_IPV6_IFADDR: u32 = 9;

fn msg_matches_target(msg: &[u8], target_ifindex: u32, target_ifname: &str) -> bool {
    if msg.len() < 24 {
        return true;
    }
    let nlmsg_type = read_u16_ne(msg, 4);
    let msg_ifindex = read_u32_ne(msg, 20);
    if target_ifindex != 0 && msg_ifindex == target_ifindex {
        return true;
    }
    if nlmsg_type == RTM_NEWLINK || nlmsg_type == RTM_DELLINK {
        // Check IFLA_IFNAME when waiting for interface creation or rename (ifindex == 0 or changed).
        let mut rta_off = 32; // 16 (nlmsghdr) + 16 (ifinfomsg)
        while rta_off + 4 <= msg.len() {
            let rta_len = read_u16_ne(msg, rta_off) as usize;
            let rta_type = read_u16_ne(msg, rta_off + 2);
            if rta_len < 4 || rta_off + rta_len > msg.len() {
                break;
            }
            if rta_type == IFLA_IFNAME {
                let raw = &msg[rta_off + 4..rta_off + rta_len];
                let name_bytes = raw.split(|&b| b == 0).next().unwrap_or(raw);
                if name_bytes == target_ifname.as_bytes() {
                    return true;
                }
            }
            rta_off += (rta_len + 3) & !3;
        }
        return false;
    }
    if nlmsg_type == RTM_NEWADDR || nlmsg_type == RTM_DELADDR {
        return target_ifindex == 0;
    }
    false
}

/// Subscription to rtnetlink link/address notifications.
pub(crate) struct EventMonitor {
    sock: OwnedFd,
}

impl EventMonitor {
    pub(crate) fn new() -> Result<Self, NetlinkError> {
        let sock = socket_with(
            AddressFamily::NETLINK,
            SocketType::RAW,
            SocketFlags::CLOEXEC,
            None,
        )
        .map_err(|_| NetlinkError::Socket)?;

        let groups = (1u32 << (RTNLGRP_LINK - 1))
            | (1u32 << (RTNLGRP_IPV4_IFADDR - 1))
            | (1u32 << (RTNLGRP_IPV6_IFADDR - 1));
        bind(&sock, &SocketAddrNetlink::new(0, groups)).map_err(|_| NetlinkError::Socket)?;

        Ok(Self { sock })
    }

    /// Drains all pending notifications and clears socket errors (`ENOBUFS`),
    /// returning `true` if any event affects `target_ifindex`/`target_ifname` or an overrun occurred.
    pub(crate) fn drain_relevant(&self, target_ifindex: u32, target_ifname: &str) -> bool {
        let mut relevant = false;
        let mut buf = vec![0u8; 4096];
        loop {
            match recv_netlink_msg(&self.sock, &mut buf, RecvFlags::DONTWAIT) {
                Ok(0) => break,
                Ok(n) => {
                    let mut offset = 0;
                    while offset + 16 <= n {
                        let nlmsg_len = read_u32_ne(&buf, offset) as usize;
                        if nlmsg_len < 16 || offset + nlmsg_len > n {
                            relevant = true;
                            break;
                        }
                        if msg_matches_target(
                            &buf[offset..offset + nlmsg_len],
                            target_ifindex,
                            target_ifname,
                        ) {
                            relevant = true;
                        }
                        let aligned = (nlmsg_len + 3) & !3;
                        if aligned == 0 {
                            break;
                        }
                        offset += aligned;
                    }
                }
                Err(Errno::NOBUFS) => {
                    // ENOBUFS clears sk_err; keep looping to drain queued messages and force resync.
                    relevant = true;
                }
                Err(Errno::AGAIN) => break,
                Err(_) => {
                    relevant = true;
                    break;
                }
            }
        }
        relevant
    }
}

impl AsFd for EventMonitor {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.sock.as_fd()
    }
}

/// Read the kernel ifindex of an interface (`None` if it does not exist).
pub(crate) fn get_ifindex(ifname: &str) -> Option<u32> {
    std::fs::read_to_string(format!("/sys/class/net/{}/ifindex", ifname))
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(family: u8, v: u8, flags: u32, scope: u8) -> IfaceAddr {
        let mut addr = [0u8; 16];
        addr[0] = v;
        IfaceAddr {
            family,
            flags,
            scope,
            addr,
        }
    }

    #[test]
    fn test_pick_gua_v6_skips_non_global() {
        assert_eq!(pick_gua_v6(&[addr(2, 10, 0, 0)], None), None);
        let addrs = [
            addr(10, 0xfd, IFA_F_PERMANENT, 0),
            addr(10, 0xfe, IFA_F_PERMANENT, 0x20),
        ];
        assert_eq!(pick_gua_v6(&addrs, None), None);
    }

    #[test]
    fn test_pick_gua_v6_prefers_permanent() {
        let addrs = [
            addr(10, 0x24, 0x00, 0),
            addr(10, 0x25, IFA_F_SECONDARY, 0),
            addr(10, 0x26, IFA_F_TENTATIVE, 0),
            addr(10, 0x27, IFA_F_DEPRECATED, 0),
            addr(10, 0x28, IFA_F_PERMANENT, 0),
        ];
        let picked = pick_gua_v6(&addrs, None).expect("a GUA");
        assert_eq!(picked[0], 0x28);

        let only_permanent = [addr(10, 0x24, 0x00, 0), addr(10, 0x28, IFA_F_PERMANENT, 0)];
        assert_eq!(pick_gua_v6(&only_permanent, None).unwrap()[0], 0x28);
    }

    #[test]
    fn test_pick_gua_v6_falls_back_to_temporary() {
        let only_temporary = [addr(10, 0x24, IFA_F_TEMPORARY, 0)];
        assert_eq!(pick_gua_v6(&only_temporary, None).unwrap()[0], 0x24);

        let mixed = [addr(10, 0x25, IFA_F_TEMPORARY, 0), addr(10, 0x26, 0, 0)];
        assert_eq!(pick_gua_v6(&mixed, None).unwrap()[0], 0x26);
    }

    #[test]
    fn test_pick_gua_v6_retains_current_and_prevents_flapping() {
        let mut a1 = [0u8; 16];
        a1[0] = 0x24;
        a1[15] = 1;
        let mut a2 = [0u8; 16];
        a2[0] = 0x24;
        a2[15] = 2;

        let list_order_1 = [
            IfaceAddr {
                family: 10,
                flags: 0,
                scope: 0,
                addr: a1,
            },
            IfaceAddr {
                family: 10,
                flags: 0,
                scope: 0,
                addr: a2,
            },
        ];
        let list_order_2 = [
            IfaceAddr {
                family: 10,
                flags: 0,
                scope: 0,
                addr: a2,
            },
            IfaceAddr {
                family: 10,
                flags: 0,
                scope: 0,
                addr: a1,
            },
        ];

        assert_eq!(pick_gua_v6(&list_order_1, None), Some(a1));
        assert_eq!(pick_gua_v6(&list_order_2, None), Some(a1));
        assert_eq!(pick_gua_v6(&list_order_1, Some(a2)), Some(a2));
        assert_eq!(pick_gua_v6(&list_order_2, Some(a2)), Some(a2));

        let mut perm = [0u8; 16];
        perm[0] = 0x24;
        perm[15] = 9;
        let with_perm = [
            IfaceAddr {
                family: 10,
                flags: 0,
                scope: 0,
                addr: a2,
            },
            IfaceAddr {
                family: 10,
                flags: IFA_F_PERMANENT,
                scope: 0,
                addr: perm,
            },
        ];
        assert_eq!(pick_gua_v6(&with_perm, Some(a2)), Some(perm));
    }

    #[test]
    fn test_pick_global_v4() {
        let addrs = [
            addr(2, 10, IFA_F_SECONDARY, 0),
            addr(2, 10, 0, 0),
            addr(2, 100, 0, 0),
        ];
        let picked = pick_global_v4(&addrs, None).expect("an IPv4 address");
        assert_eq!(picked, [10, 0, 0, 0]);
        assert_eq!(pick_global_v4(&[addr(2, 10, 0, 0x20)], None), None);

        let cur = [100, 0, 0, 0];
        assert_eq!(pick_global_v4(&addrs, Some(cur)), Some(cur));
    }

    #[test]
    fn test_l2_len_for_arp_type() {
        assert_eq!(super::l2_len_for_arp_type(1), 14);
        assert_eq!(super::l2_len_for_arp_type(512), 0);
        assert_eq!(super::l2_len_for_arp_type(772), 0);
        assert_eq!(super::l2_len_for_arp_type(65534), 0);
    }

    #[test]
    fn test_get_iface_l2_len_unknown_and_loopback() {
        assert_eq!(get_iface_l2_len("does-not-exist-xyz"), None);
        if std::path::Path::new("/sys/class/net/lo").exists() {
            assert_eq!(get_iface_l2_len("lo"), Some(0));
        }
    }

    #[test]
    fn test_get_ifindex_loopback() {
        assert_eq!(get_ifindex("lo"), Some(1));
        assert_eq!(get_ifindex("does-not-exist-xyz"), None);
    }

    #[test]
    fn test_msg_matches_target_filters_unrelated_ifaces() {
        let mut link_other = vec![0u8; 32 + 8];
        link_other[4..6].copy_from_slice(&RTM_NEWLINK.to_ne_bytes());
        link_other[20..24].copy_from_slice(&99u32.to_ne_bytes());
        link_other[32..34].copy_from_slice(&8u16.to_ne_bytes());
        link_other[34..36].copy_from_slice(&IFLA_IFNAME.to_ne_bytes());
        link_other[36..40].copy_from_slice(b"eth9");
        assert!(!msg_matches_target(&link_other, 5, "wan"));

        let mut link_wan = link_other.clone();
        link_wan[36..40].copy_from_slice(b"wan\0");
        assert!(msg_matches_target(&link_wan, 0, "wan"));
        assert!(msg_matches_target(&link_wan, 5, "wan"));

        let mut addr_other = [0u8; 24];
        addr_other[4..6].copy_from_slice(&RTM_NEWADDR.to_ne_bytes());
        addr_other[20..24].copy_from_slice(&99u32.to_ne_bytes());
        assert!(!msg_matches_target(&addr_other, 5, "wan"));
        addr_other[20..24].copy_from_slice(&5u32.to_ne_bytes());
        assert!(msg_matches_target(&addr_other, 5, "wan"));
    }
}
