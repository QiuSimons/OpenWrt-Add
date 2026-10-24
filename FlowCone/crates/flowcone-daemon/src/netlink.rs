use rustix::event::{PollFd, PollFlags, poll};
use rustix::fd::{BorrowedFd, OwnedFd};
use rustix::net::{
    AddressFamily, SocketFlags, SocketType, bind, netlink::SocketAddrNetlink, recv, send,
    socket_with,
};
use rustix::time::Timespec;
use std::time::Duration;

#[inline(always)]
fn read_u16_ne(buf: &[u8], off: usize) -> u16 {
    u16::from_ne_bytes([buf[off], buf[off + 1]])
}

#[inline(always)]
fn read_u32_ne(buf: &[u8], off: usize) -> u32 {
    u32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetlinkError {
    Socket,
    Send,
    Recv,
    Protocol,
}

/// One local address of an interface, as reported by RTM_GETADDR.
pub(crate) struct IfaceAddr {
    pub(crate) family: u8,
    pub(crate) flags: u32,
    pub(crate) scope: u8,
    pub(crate) addr: [u8; 16],
}

const IFA_F_SECONDARY: u32 = 0x01;
const IFA_F_DADFAILED: u32 = 0x08;
const IFA_F_DEPRECATED: u32 = 0x20;
const IFA_F_TENTATIVE: u32 = 0x40;
const IFA_F_PERMANENT: u32 = 0x80;

/// Dump the local addresses of `ifindex` (0 = both families in one request).
///
/// IFA_LOCAL wins over IFA_ADDRESS, so a point-to-point WAN reports the local
/// end rather than the peer; IFA_FLAGS supersedes the u8 header field.
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

    let _ = rustix::net::sockopt::set_socket_timeout(
        &sock,
        rustix::net::sockopt::Timeout::Recv,
        Some(std::time::Duration::from_secs(1)),
    );

    let mut req_bytes = [0u8; 24];
    req_bytes[0..4].copy_from_slice(&(24u32).to_ne_bytes());
    req_bytes[4..6].copy_from_slice(&(22u16).to_ne_bytes()); // RTM_GETADDR
    req_bytes[6..8].copy_from_slice(&(0x0301u16).to_ne_bytes()); // REQUEST | ROOT | MATCH
    req_bytes[8..12].copy_from_slice(&(1u32).to_ne_bytes());
    req_bytes[12..16].copy_from_slice(&(0u32).to_ne_bytes());
    req_bytes[16] = family;
    req_bytes[20..24].copy_from_slice(&ifindex.to_ne_bytes());

    if send(&sock, &req_bytes, rustix::net::SendFlags::empty()).is_err() {
        return Err(NetlinkError::Send);
    }

    let mut addrs = Vec::new();
    let mut buf = [0u8; 32768];
    loop {
        let (n, _) = recv(&sock, &mut buf, rustix::net::RecvFlags::empty())
            .map_err(|_| NetlinkError::Recv)?;
        if n == 0 {
            break;
        }

        let mut offset = 0;
        while offset + 16 <= n {
            let nlmsg_len = read_u32_ne(&buf, offset) as usize;
            let nlmsg_type = read_u16_ne(&buf, offset + 4);

            if nlmsg_type == 2 {
                return Err(NetlinkError::Protocol);
            }
            if nlmsg_type == 3 {
                return Ok(addrs);
            }
            if nlmsg_type == 20 && offset + 24 <= n {
                let ifa_family = buf[offset + 16];
                let mut flags = buf[offset + 18] as u32;
                let ifa_scope = buf[offset + 19];
                let ifa_index = read_u32_ne(&buf, offset + 20);
                if (family == 0 || ifa_family == family) && ifa_index == ifindex {
                    let mut rta_offset = offset + 24;
                    let end = (offset + nlmsg_len).min(n);
                    let mut local = None;
                    let mut address = None;
                    while rta_offset + 4 <= end {
                        let rta_len = read_u16_ne(&buf, rta_offset) as usize;
                        let rta_type = read_u16_ne(&buf, rta_offset + 2);
                        if rta_len < 4 {
                            break;
                        }
                        let payload = rta_offset + 4;
                        let payload_len = rta_len - 4;
                        if rta_type == 8 && payload_len >= 4 && payload + 4 <= end {
                            flags = read_u32_ne(&buf, payload);
                        } else if (rta_type == 1 || rta_type == 2) && payload + payload_len <= end {
                            let mut addr = [0u8; 16];
                            let len = payload_len.min(16);
                            addr[..len].copy_from_slice(&buf[payload..payload + len]);
                            if rta_type == 2 {
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
fn pick_global_v4(addrs: &[IfaceAddr]) -> Option<[u8; 4]> {
    addrs
        .iter()
        .find(|a| a.family == 2 && a.scope == 0 && a.flags & IFA_F_SECONDARY == 0)
        .map(|a| [a.addr[0], a.addr[1], a.addr[2], a.addr[3]])
}

/// Pick a global unicast IPv6 address, preferring a permanent one.
fn pick_gua_v6(addrs: &[IfaceAddr]) -> Option<[u8; 16]> {
    let mut fallback = None;
    for a in addrs {
        // 2000::/3 only: ULA (fc00::/7) is not a WAN address even though it
        // is global scope.
        if a.family != 10 || a.scope != 0 || (a.addr[0] & 0xe0) != 0x20 {
            continue;
        }
        if a.flags & (IFA_F_SECONDARY | IFA_F_DADFAILED | IFA_F_DEPRECATED | IFA_F_TENTATIVE) != 0 {
            continue;
        }
        if a.flags & IFA_F_PERMANENT != 0 {
            return Some(a.addr);
        }
        fallback = fallback.or(Some(a.addr));
    }
    fallback
}

/// Global addresses of one interface.
pub(crate) struct IfaceAddrs {
    pub(crate) v4: Option<[u8; 4]>,
    pub(crate) v6: Option<[u8; 16]>,
}

/// Global addresses of an interface, from one rtnetlink dump.
pub fn get_iface_addrs(ifindex: u32) -> Result<IfaceAddrs, NetlinkError> {
    let addrs = dump_iface_addrs(ifindex, 0)?;
    Ok(IfaceAddrs {
        v4: pick_global_v4(&addrs),
        v6: pick_gua_v6(&addrs),
    })
}

/// Detect L2 header length for interface.
/// Returns 14 for Ethernet (ARPHRD_ETHER = 1), 0 for PPP (512), NONE (65534), RAWIP (519), etc.
pub fn get_iface_l2_len(ifname: &str) -> u32 {
    let type_path = format!("/sys/class/net/{}/type", ifname);
    let Ok(content) = std::fs::read_to_string(type_path) else {
        return 14;
    };
    let Ok(dev_type) = content.trim().parse::<u16>() else {
        return 14;
    };
    if dev_type == 1 { 14 } else { 0 }
}

/// rtnetlink multicast groups: link state and IPv4/IPv6 address changes.
const RTNLGRP_LINK: u32 = 1;
const RTNLGRP_IPV4_IFADDR: u32 = 5;
const RTNLGRP_IPV6_IFADDR: u32 = 9;

/// Subscription to rtnetlink link/address notifications.
pub struct EventMonitor {
    sock: OwnedFd,
}

impl EventMonitor {
    pub fn new() -> Result<Self, NetlinkError> {
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

    /// Wait for a notification, a wake pipe byte or the timeout.
    pub fn wait(&self, wake: BorrowedFd<'_>, timeout: Duration) -> bool {
        let ts = Timespec {
            tv_sec: timeout.as_secs() as i64,
            tv_nsec: timeout.subsec_nanos() as i64,
        };
        let mut fds = [
            PollFd::new(&self.sock, PollFlags::IN),
            PollFd::new(&wake, PollFlags::IN),
        ];

        match poll(&mut fds, Some(&ts)) {
            Ok(n) if n > 0 => {
                if fds[0].revents().contains(PollFlags::IN) {
                    // Drain the socket, otherwise the next poll returns at once.
                    let mut buf = [0u8; 4096];
                    while let Ok((n, _)) =
                        recv(&self.sock, &mut buf, rustix::net::RecvFlags::DONTWAIT)
                    {
                        if n == 0 {
                            break;
                        }
                    }
                }
                true
            }
            _ => false,
        }
    }
}

/// Read the kernel ifindex of an interface (`None` if it does not exist).
pub fn get_ifindex(ifname: &str) -> Option<u32> {
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
        // ULA is outside 2000::/3 and link-local is link scope.
        assert_eq!(pick_gua_v6(&[addr(2, 10, 0, 0)]), None);
        let addrs = [
            addr(10, 0xfd, IFA_F_PERMANENT, 0),
            addr(10, 0xfe, IFA_F_PERMANENT, 0x20),
        ];
        assert_eq!(pick_gua_v6(&addrs), None);
    }

    #[test]
    fn test_pick_gua_v6_prefers_permanent() {
        // Secondary, tentative and deprecated are skipped; permanent wins.
        let addrs = [
            addr(10, 0x24, 0x00, 0),
            addr(10, 0x25, IFA_F_SECONDARY, 0),
            addr(10, 0x26, IFA_F_TENTATIVE, 0),
            addr(10, 0x27, IFA_F_DEPRECATED, 0),
            addr(10, 0x28, IFA_F_PERMANENT, 0),
        ];
        let picked = pick_gua_v6(&addrs).expect("a GUA");
        assert_eq!(picked[0], 0x28);

        let only_permanent = [addr(10, 0x24, 0x00, 0), addr(10, 0x28, IFA_F_PERMANENT, 0)];
        assert_eq!(pick_gua_v6(&only_permanent).unwrap()[0], 0x28);
    }

    #[test]
    fn test_pick_global_v4() {
        // The first non-secondary global address wins.
        let addrs = [
            addr(2, 10, IFA_F_SECONDARY, 0),
            addr(2, 10, 0, 0),
            addr(2, 100, 0, 0),
        ];
        let picked = pick_global_v4(&addrs).expect("an IPv4 address");
        assert_eq!(picked, [10, 0, 0, 0]);
        assert_eq!(pick_global_v4(&[addr(2, 10, 0, 0x20)]), None);
    }

    #[test]
    fn test_get_ifindex_loopback() {
        // lo always exists and has ifindex 1.
        assert_eq!(get_ifindex("lo"), Some(1));
        assert_eq!(get_ifindex("does-not-exist-xyz"), None);
    }
}
