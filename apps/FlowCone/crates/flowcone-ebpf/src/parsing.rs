use core::mem;
use flowcone_common::{
    ETH_P_8021AD, ETH_P_8021Q, ETH_P_IP, ETH_P_IPV6, ETH_P_PPPOE, IPPROTO_DSTOPTS,
    IPPROTO_FRAGMENT, IPPROTO_HOPOPTS, IPPROTO_ICMPV6, IPPROTO_ROUTING, IPPROTO_UDP, PPP_IPV4,
    PPP_IPV6,
};
pub use flowcone_common::{Ipv6L4, L2Info};

#[repr(C, packed)]
pub struct Ipv4Hdr {
    pub ver_ihl: u8,
    pub tos: u8,
    pub tot_len: u16,
    pub id: u16,
    pub frag_off: u16,
    pub ttl: u8,
    pub protocol: u8,
    pub check: u16,
    pub src_addr: u32,
    pub dst_addr: u32,
}

#[repr(C, packed)]
pub struct Ipv6Hdr {
    pub ver_tc_fl: u32,
    pub payload_len: u16,
    pub next_hdr: u8,
    pub hop_limit: u8,
    pub src_addr: [u8; 16],
    pub dst_addr: [u8; 16],
}

#[repr(C, packed)]
pub struct UdpHdr {
    pub src_port: u16,
    pub dst_port: u16,
    pub len: u16,
    pub check: u16,
}

#[inline(always)]
pub fn parse_header_at<T>(ptr: usize, data_end: usize) -> Option<*const T> {
    if ptr + mem::size_of::<T>() > data_end {
        return None;
    }
    Some(ptr as *const T)
}

#[inline(always)]
pub fn parse_header_at_mut<T>(ptr: usize, data_end: usize) -> Option<*mut T> {
    if ptr + mem::size_of::<T>() > data_end {
        return None;
    }
    Some(ptr as *mut T)
}

/// Casts a slice of packet bytes to an immutable reference of type `T`.
///
/// # Safety
///
/// The caller must ensure `ptr` is properly aligned for `T` and dereferenceable
/// up to `data_end`.
#[inline(always)]
pub unsafe fn parse_header_ref<'a, T>(ptr: usize, data_end: usize) -> Option<&'a T> {
    let size = mem::size_of::<T>();
    if ptr > usize::MAX - size || ptr + size > data_end {
        return None;
    }
    Some(unsafe { &*(ptr as *const T) })
}

/// Casts a slice of packet bytes to a mutable reference of type `T`.
///
/// # Safety
///
/// The caller must ensure `ptr` is properly aligned for `T` and dereferenceable
/// up to `data_end`.
#[inline(always)]
pub unsafe fn parse_header_ref_mut<'a, T>(ptr: usize, data_end: usize) -> Option<&'a mut T> {
    let size = mem::size_of::<T>();
    if ptr > usize::MAX - size || ptr + size > data_end {
        return None;
    }
    Some(unsafe { &mut *(ptr as *mut T) })
}

#[inline(always)]
pub fn parse_header<T>(data_start: usize, data_end: usize, offset: usize) -> Option<*const T> {
    let size = mem::size_of::<T>();
    let target = data_start.checked_add(offset)?;
    if target > usize::MAX - size || target + size > data_end {
        return None;
    }
    Some(target as *const T)
}

#[inline(always)]
pub fn parse_header_mut<T>(data_start: usize, data_end: usize, offset: usize) -> Option<*mut T> {
    let size = mem::size_of::<T>();
    let target = data_start.checked_add(offset)?;
    if target > usize::MAX - size || target + size > data_end {
        return None;
    }
    Some(target as *mut T)
}

#[inline(always)]
pub fn read_u8(p: usize) -> u8 {
    unsafe { *(p as *const u8) }
}

#[inline(always)]
pub fn read_be16(p: usize) -> u16 {
    u16::from_be_bytes([read_u8(p), read_u8(p + 1)])
}

#[inline(always)]
pub fn read_be32(p: usize) -> u32 {
    u32::from_be_bytes([read_u8(p), read_u8(p + 1), read_u8(p + 2), read_u8(p + 3)])
}

/// Compare two IPv6 addresses without alignment assumptions.
#[inline(always)]
pub fn ipv6_eq(a: &[u8; 16], b: &[u8; 16]) -> bool {
    let p_a = a.as_ptr() as *const u64;
    let p_b = b.as_ptr() as *const u64;
    unsafe {
        core::ptr::read_unaligned(p_a) == core::ptr::read_unaligned(p_b)
            && core::ptr::read_unaligned(p_a.add(1)) == core::ptr::read_unaligned(p_b.add(1))
    }
}

#[inline(always)]
pub fn is_multicast_or_broadcast_v4(raw_ip: u32) -> bool {
    let b = raw_ip.to_ne_bytes();
    b[0] == 0xff || (b[0] & 0xf0) == 0xe0
}

#[inline(always)]
pub fn is_link_local_v4(raw_ip: u32) -> bool {
    let b = raw_ip.to_ne_bytes();
    b[0] == 169 && b[1] == 254
}

pub const DHCP_SERVER_PORT_BE: u16 = 67u16.to_be();
pub const DHCP_CLIENT_PORT_BE: u16 = 68u16.to_be();
pub const DHCPV6_CLIENT_PORT_BE: u16 = 546u16.to_be();
pub const DHCPV6_SERVER_PORT_BE: u16 = 547u16.to_be();

#[inline(always)]
pub fn is_multicast_v6(addr: &[u8; 16]) -> bool {
    addr[0] == 0xff
}

#[inline(always)]
pub fn is_link_local_v6(addr: &[u8; 16]) -> bool {
    addr[0] == 0xfe && (addr[1] & 0xc0) == 0x80
}

/// Fast-path filter for DHCP, link-local, and broadcast traffic.
#[inline(always)]
pub fn bypass_special_udp4(src: u32, dst: u32, sport: u16, dport: u16) -> bool {
    src == 0
        || is_multicast_or_broadcast_v4(src)
        || is_link_local_v4(src)
        || sport == DHCP_SERVER_PORT_BE
        || sport == DHCP_CLIENT_PORT_BE
        || dport == DHCP_SERVER_PORT_BE
        || dport == DHCP_CLIENT_PORT_BE
        || is_multicast_or_broadcast_v4(dst)
        || is_link_local_v4(dst)
}

#[inline(always)]
pub fn bypass_special_udp6(src: &[u8; 16], dst: &[u8; 16], sport: u16, dport: u16) -> bool {
    sport == DHCPV6_CLIENT_PORT_BE
        || sport == DHCPV6_SERVER_PORT_BE
        || dport == DHCPV6_CLIENT_PORT_BE
        || dport == DHCPV6_SERVER_PORT_BE
        || is_multicast_v6(src)
        || is_link_local_v6(src)
        || is_multicast_v6(dst)
        || is_link_local_v6(dst)
}

/// Parse the PPP protocol field (optional 0xff 0x03 address/control, optional
/// one-byte protocol compression). Returns the IP ethertype and header offset.
#[inline(always)]
pub fn parse_ppp(data_end: usize, mut off: usize) -> Option<L2Info> {
    if off + 2 > data_end {
        return None;
    }
    if read_u8(off) == 0xff && off + 2 <= data_end && read_u8(off + 1) == 0x03 {
        off += 2;
    }
    if off + 2 > data_end {
        return None;
    }
    let b0 = read_u8(off);
    if (b0 & 1) != 0 {
        let proto = match b0 as u16 {
            0x21 => ETH_P_IP,
            0x57 => ETH_P_IPV6,
            _ => return None,
        };
        return Some(L2Info {
            proto,
            ip_off: off + 1,
        });
    }
    if off + 2 > data_end {
        return None;
    }
    let raw = read_be16(off);
    let proto = match raw {
        PPP_IPV4 => ETH_P_IP,
        PPP_IPV6 => ETH_P_IPV6,
        _ => return None,
    };
    Some(L2Info {
        proto,
        ip_off: off + 2,
    })
}

/// Parse Ethernet, VLAN tags, and PPPoE session, or handle bare IP frames
/// (raw IP, TUN, WireGuard, and PPP interfaces where the kernel already stripped
/// the PPP header).
/// l2_len is 0 for bare IP, 14 for Ethernet.
#[inline(always)]
pub fn parse_l2(data: usize, data_end: usize, l2_len: u32) -> Option<L2Info> {
    if l2_len == 14 {
        if data + 14 > data_end {
            return None;
        }
        let mut proto = read_be16(data + 12);
        let mut ip_off = data + 14;
        let mut tags = 0;
        while (proto == ETH_P_8021Q || proto == ETH_P_8021AD) && tags < 2 {
            if ip_off + 4 > data_end {
                return None;
            }
            proto = read_be16(ip_off + 2);
            ip_off += 4;
            tags += 1;
        }
        if proto == ETH_P_PPPOE {
            if ip_off + 6 > data_end {
                return None;
            }
            return parse_ppp(data_end, ip_off + 6);
        }
        if proto == ETH_P_IP || proto == ETH_P_IPV6 {
            return Some(L2Info { proto, ip_off });
        }
        return None;
    }

    // Raw IP / TUN / WireGuard / RAWIP.
    if data + 2 > data_end {
        return None;
    }
    let ver = read_u8(data) >> 4;
    let proto = match ver {
        4 => ETH_P_IP,
        6 => ETH_P_IPV6,
        _ => return None,
    };
    Some(L2Info {
        proto,
        ip_off: data,
    })
}

/// Walk IPv6 extension headers and locate the upper-layer header.
#[inline(always)]
pub fn locate_ipv6_l4(data_end: usize, ip_off: usize, mut nh: u8) -> Ipv6L4 {
    let mut cur_off = ip_off + 40;
    let mut iter = 0;
    while iter < 4 {
        if nh == IPPROTO_UDP {
            return Ipv6L4::Udp(cur_off);
        }
        if nh == IPPROTO_ICMPV6 {
            return Ipv6L4::Icmp6(cur_off);
        }
        if nh == IPPROTO_HOPOPTS || nh == IPPROTO_DSTOPTS || nh == IPPROTO_ROUTING {
            if cur_off + 2 > data_end {
                return Ipv6L4::NonUdp;
            }
            let next = read_u8(cur_off);
            let ext_len = (read_u8(cur_off + 1) as usize + 1) * 8;
            if cur_off + ext_len > data_end {
                return Ipv6L4::NonUdp;
            }
            nh = next;
            cur_off += ext_len;
        } else if nh == IPPROTO_FRAGMENT {
            return Ipv6L4::Fragment;
        } else {
            return Ipv6L4::NonUdp;
        }
        iter += 1;
    }

    if nh == IPPROTO_UDP {
        Ipv6L4::Udp(cur_off)
    } else if nh == IPPROTO_ICMPV6 {
        Ipv6L4::Icmp6(cur_off)
    } else {
        Ipv6L4::Unsupported
    }
}

/// Walk IPv6 extension headers to locate a target next-header protocol.
#[inline(always)]
pub fn locate_ipv6_nexthdr(
    data_end: usize,
    ip_off: usize,
    mut nh: u8,
    target: u8,
) -> Option<usize> {
    let mut cur_off = ip_off + 40;
    let mut iter = 0;
    while iter < 4 {
        if nh == target {
            return Some(cur_off);
        }
        if nh == IPPROTO_HOPOPTS || nh == IPPROTO_DSTOPTS || nh == IPPROTO_ROUTING {
            if cur_off + 2 > data_end {
                return None;
            }
            let next = read_u8(cur_off);
            let ext_len = (read_u8(cur_off + 1) as usize + 1) * 8;
            if cur_off + ext_len > data_end {
                return None;
            }
            nh = next;
            cur_off += ext_len;
        } else {
            return None;
        }
        iter += 1;
    }
    if nh == target { Some(cur_off) } else { None }
}

/// Walk Hop-by-Hop / Destination Options headers until the fragment header.
#[inline(always)]
pub fn ipv6_fragment_offset(data_end: usize, ip_off: usize, mut nh: u8) -> Option<usize> {
    let mut cur = ip_off + 40;
    let mut iter = 0;
    while iter < 4 {
        if nh == IPPROTO_FRAGMENT {
            if cur + 8 <= data_end {
                return Some(cur);
            }
            return None;
        }
        if nh != IPPROTO_HOPOPTS && nh != IPPROTO_DSTOPTS && nh != IPPROTO_ROUTING {
            return None;
        }
        if cur + 2 > data_end {
            return None;
        }
        let next = read_u8(cur);
        let len = (read_u8(cur + 1) as usize + 1) * 8;
        if cur + len > data_end {
            return None;
        }
        nh = next;
        cur += len;
        iter += 1;
    }
    None
}
