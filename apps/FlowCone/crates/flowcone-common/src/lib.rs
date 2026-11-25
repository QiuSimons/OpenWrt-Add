#![no_std]

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct EndpointKey4 {
    pub ip: u32,
    pub port: u16,
    pub _pad: u16,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for EndpointKey4 {}

pub const BINDING_FLAG_SHORT_LIVED: u16 = 1;
pub const BINDING_EPOCH_MASK: u16 = !BINDING_FLAG_SHORT_LIVED;
pub const RESERVED_PORT_BIT: u16 = 1;
pub const DEFAULT_SHORT_LIVED_TIMEOUT_SEC: u32 = 5;

#[inline(always)]
pub fn reserved_state_is_reserved(state: u16) -> bool {
    (state & RESERVED_PORT_BIT) != 0
}

#[inline(always)]
pub fn reserved_state_next_added(state: u16) -> u16 {
    if (state & RESERVED_PORT_BIT) == 0 {
        state.wrapping_add(1)
    } else {
        state
    }
}

#[inline(always)]
pub fn reserved_state_next_removed(state: u16) -> u16 {
    if (state & RESERVED_PORT_BIT) != 0 {
        state.wrapping_add(1)
    } else {
        state
    }
}

#[inline(always)]
pub fn pack_binding_meta(short_lived: bool, res_state: u16) -> u16 {
    (res_state & BINDING_EPOCH_MASK)
        | if short_lived {
            BINDING_FLAG_SHORT_LIVED
        } else {
            0
        }
}

#[inline(always)]
pub fn update_binding_epoch(meta: u16, res_state: u16) -> u16 {
    (meta & BINDING_FLAG_SHORT_LIVED) | (res_state & BINDING_EPOCH_MASK)
}

#[inline(always)]
pub fn binding_matches_reserved(res_state: u16, meta: u16) -> bool {
    (res_state & RESERVED_PORT_BIT) == 0 && ((res_state ^ meta) & BINDING_EPOCH_MASK) == 0
}

macro_rules! impl_binding_meta {
    ($ty:ty) => {
        impl $ty {
            #[inline(always)]
            pub fn is_short_lived(&self) -> bool {
                self.meta & BINDING_FLAG_SHORT_LIVED != 0
            }

            #[inline(always)]
            pub fn reserved_meta(&self) -> u16 {
                self.meta
            }

            #[inline(always)]
            pub fn set_reserved_epoch(&mut self, res_state: u16) {
                self.meta = update_binding_epoch(self.meta, res_state);
            }

            #[inline(always)]
            pub fn clear_short_lived(&mut self) {
                self.meta &= !BINDING_FLAG_SHORT_LIVED;
            }
        }
    };
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BindingValue4 {
    pub ip: u32,
    pub port: u16,
    /// Bit 0: `BINDING_FLAG_SHORT_LIVED`; bits 1..=15: reservation epoch.
    pub meta: u16,
    pub last_seen: u32,
}

impl_binding_meta!(BindingValue4);

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for BindingValue4 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct EndpointKey6 {
    pub ip: [u8; 16],
    pub port: u16,
    pub _pad: u16,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for EndpointKey6 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BindingValue6 {
    pub ip: [u8; 16],
    pub port: u16,
    /// Bit 0: `BINDING_FLAG_SHORT_LIVED`; bits 1..=15: reservation epoch.
    pub meta: u16,
    pub last_seen: u32,
}

impl_binding_meta!(BindingValue6);

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for BindingValue6 {}

/// Session creation notification event.
/// `key.port` is in network byte order; `port` is allocated in host byte order.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEvent4 {
    pub key: EndpointKey4,
    pub port: u16,
    pub flags: u16,
}

impl SessionEvent4 {
    #[inline(always)]
    pub fn is_short_lived(&self) -> bool {
        self.flags & BINDING_FLAG_SHORT_LIVED != 0
    }
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for SessionEvent4 {}

/// Session creation notification event for IPv6.
/// `key.port` is in network byte order; `port` is allocated in host byte order.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEvent6 {
    pub key: EndpointKey6,
    pub port: u16,
    pub flags: u16,
}

impl SessionEvent6 {
    #[inline(always)]
    pub fn is_short_lived(&self) -> bool {
        self.flags & BINDING_FLAG_SHORT_LIVED != 0
    }
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for SessionEvent6 {}

/// IPv4 fragment cache key.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FragKey4 {
    pub src: u32,
    pub dst: u32,
    pub id: u16,
    pub proto: u8,
    pub _pad: u8,
    pub epoch: u32,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for FragKey4 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FragValue4 {
    pub ip: u32,
    pub wan_id: u16,
    pub _pad: u16,
    pub last_seen: u32,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for FragValue4 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FragKey6 {
    pub src: [u8; 16],
    pub dst: [u8; 16],
    pub id: u32,
    pub proto: u8,
    pub _pad: [u8; 3],
    pub epoch: u32,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for FragKey6 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FragValue6 {
    pub ip: [u8; 16],
    pub wan_id: u32,
    pub last_seen: u32,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for FragValue6 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GlobalConfig {
    pub wan_ip4: u32,
    pub bypass_mark_mask: u32,
    pub bypass_mark_val: u32,
    pub l2_len: u32, // 0 raw IP, 14 Ethernet (VLAN/PPPoE parsed from the frame)
    pub wan_ip6: [u8; 16],
    pub min_port4: u16,
    pub max_port4: u16,
    pub min_port6: u16,
    pub max_port6: u16,
    pub enabled_v4: u32,
    pub enabled_v6: u32,
    pub flowcone_mark: u32,
    pub frag_epoch: u32,
    pub timeout_sec: u32,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for GlobalConfig {}

/// Routable private IPv4 source ranges matching `is_private_ipv4()` (RFC 1918,
/// RFC 6598).
#[cfg(not(target_arch = "bpf"))]
pub const INTERNAL_V4_PREFIXES: &[&str] = &[
    "10.0.0.0/8",
    "100.64.0.0/10",
    "172.16.0.0/12",
    "192.168.0.0/16",
];

/// Checks if an IPv4 source address belongs to private or CGNAT ranges (RFC
/// 1918, RFC 6598). Expects `raw_ip` loaded from wire octets in native memory
/// order [b0, b1, b2, b3].
#[inline(always)]
pub fn is_private_ipv4(raw_ip: u32) -> bool {
    is_private_ipv4_octets(raw_ip.to_ne_bytes())
}

#[inline(always)]
pub fn is_private_ipv4_octets(b: [u8; 4]) -> bool {
    (b[0] == 192 && b[1] == 168)
        || b[0] == 10
        || (b[0] == 172 && (16..=31).contains(&b[1]))
        || (b[0] == 100 && (64..=127).contains(&b[1]))
}

/// Check if IPv6 address belongs to Unique Local Address (ULA fc00::/7)
#[inline(always)]
pub fn is_ula_ipv6(addr: &[u8; 16]) -> bool {
    (addr[0] & 0xfe) == 0xfc
}

/// Checks if an IPv6 address is a routable internal unicast source (ULA
/// fc00::/7, or GUA 2000::/3 if enabled).
#[inline(always)]
pub fn is_routable_internal_ipv6(addr: &[u8; 16], allow_all_internal: bool) -> bool {
    if is_ula_ipv6(addr) {
        return true;
    }
    if !allow_all_internal {
        return false;
    }

    (addr[0] & 0xe0) == 0x20
}

pub const MAX_BINDINGS: u32 = 65536;
pub const FRAG_MAP_ENTRIES: u32 = 4096;
pub const SESSION_EVENT_RINGBUF_BYTES: u32 = 524_288;
pub const PORT_STATE_ENTRIES: u32 = 65536;
pub const PORT_BITMAP_SLOTS: u32 = 512;

#[inline(always)]
pub fn port_to_bitmap_coords(port: u16) -> (bool, u32, u64) {
    let is_even = (port & 1) == 0;
    let idx = (port / 2) as u32;
    let slot = idx / 64;
    let bit = idx % 64;
    (is_even, slot, 1u64 << bit)
}

#[inline(always)]
pub fn bitmap_coords_to_port(is_even: bool, slot: u32, bit: u32) -> u16 {
    ((slot * 64 + bit) * 2 + if is_even { 0 } else { 1 }) as u16
}

/// Default packet mark applied to inbound DNAT-translated packets.
pub const DEFAULT_FLOWCONE_MARK: u32 = 0x00800000;

pub const IPPROTO_ICMP: u8 = 1;
pub const IPPROTO_UDP: u8 = 17;
pub const IPPROTO_HOPOPTS: u8 = 0;
pub const IPPROTO_ROUTING: u8 = 43;
pub const IPPROTO_FRAGMENT: u8 = 44;
pub const IPPROTO_DSTOPTS: u8 = 60;
pub const IPPROTO_ICMPV6: u8 = 58;

pub const ETH_P_IP: u16 = 0x0800;
pub const ETH_P_IPV6: u16 = 0x86dd;
pub const ETH_P_8021Q: u16 = 0x8100;
pub const ETH_P_8021AD: u16 = 0x88a8;
pub const ETH_P_PPPOE: u16 = 0x8864;
pub const PPP_IPV4: u16 = 0x0021;
pub const PPP_IPV6: u16 = 0x0057;

/// RFC 1624 incremental 16-bit one's complement checksum update.
/// In one's complement, 0x0000 is converted to 0xffff (RFC 768 / RFC 1624 §5).
#[inline(always)]
pub fn csum_replace(csum: u16, old: u16, new: u16) -> u16 {
    let mut sum = (!csum as u32) + (!old as u32) + new as u32;
    let mut i = 0;
    while i < 3 {
        sum = (sum & 0xffff) + (sum >> 16);
        i += 1;
    }
    let res = !(sum as u16);
    if res == 0 { 0xffff } else { res }
}

#[inline(always)]
pub fn format_wan_ip_id(counter: u32, cpu: u32) -> u16 {
    (((counter as u16) & 0x03ff) << 6) | ((cpu as u16) & 0x003f)
}

#[inline(always)]
pub fn format_wan_frag_id(counter: u32, cpu: u32) -> u32 {
    ((counter & 0x00ff_ffff) << 8) | (cpu & 0x0000_00ff)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct L2Info {
    pub proto: u16,
    /// IP header byte offset relative to packet `data`.
    pub ip_rel: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ipv6L4 {
    /// UDP header byte offset relative to packet `data`.
    Udp(usize),
    Fragment,
    /// ICMPv6 header byte offset relative to packet `data`.
    Icmp6(usize),
    NonUdp,
    Unsupported,
}

/// # Safety
/// `p` must point to a readable `u8` inside the packet or slice bounds.
#[inline(always)]
pub unsafe fn read_u8(p: usize) -> u8 {
    unsafe { *(p as *const u8) }
}

/// # Safety
/// `p..p + 2` must point to readable bytes inside the packet or slice bounds.
#[inline(always)]
pub unsafe fn read_be16(p: usize) -> u16 {
    unsafe { u16::from_be_bytes([read_u8(p), read_u8(p + 1)]) }
}

/// # Safety
/// `p..p + 4` must point to readable bytes inside the packet or slice bounds.
#[inline(always)]
pub unsafe fn read_be32(p: usize) -> u32 {
    unsafe { u32::from_be_bytes([read_u8(p), read_u8(p + 1), read_u8(p + 2), read_u8(p + 3)]) }
}

/// Parse the PPP protocol field (optional 0xff 0x03 address/control, optional
/// one-byte protocol compression). Returns the IP ethertype and header offset
/// relative to `data`.
///
/// # Safety `(data + rel)..data_end` must be valid readable packet memory (with
/// `data + rel <= data_end`).
#[inline(always)]
pub unsafe fn parse_ppp(data: usize, data_end: usize, mut rel: usize) -> Option<L2Info> {
    if data + rel + 2 > data_end {
        return None;
    }
    unsafe {
        if read_u8(data + rel) == 0xff && read_u8(data + rel + 1) == 0x03 {
            rel += 2;
        }
        if data + rel >= data_end {
            return None;
        }
        let b0 = read_u8(data + rel);
        if (b0 & 1) != 0 {
            let proto = match b0 as u16 {
                0x21 => ETH_P_IP,
                0x57 => ETH_P_IPV6,
                _ => return None,
            };
            return Some(L2Info {
                proto,
                ip_rel: rel + 1,
            });
        }
        if data + rel + 2 > data_end {
            return None;
        }
        let raw = read_be16(data + rel);
        let proto = match raw {
            PPP_IPV4 => ETH_P_IP,
            PPP_IPV6 => ETH_P_IPV6,
            _ => return None,
        };
        Some(L2Info {
            proto,
            ip_rel: rel + 2,
        })
    }
}

/// Parse Ethernet, VLAN tags, and PPPoE session, or handle bare IP frames (raw
/// IP, TUN, WireGuard, and PPP interfaces where the kernel already stripped the
/// PPP header). `l2_len` is 0 for bare IP, 14 for Ethernet.
///
/// # Safety `data..data_end` must be valid readable packet memory (with `data
/// <= data_end`).
#[inline(always)]
pub unsafe fn parse_l2(data: usize, data_end: usize, l2_len: u32) -> Option<L2Info> {
    unsafe {
        if l2_len == 14 {
            if data + 14 > data_end {
                return None;
            }
            let mut proto = read_be16(data + 12);
            let mut ip_rel = 14usize;
            let mut tags = 0;
            while (proto == ETH_P_8021Q || proto == ETH_P_8021AD) && tags < 2 {
                if data + ip_rel + 4 > data_end {
                    return None;
                }
                proto = read_be16(data + ip_rel + 2);
                ip_rel += 4;
                tags += 1;
            }
            if proto == ETH_P_PPPOE {
                if data + ip_rel + 6 > data_end {
                    return None;
                }
                return parse_ppp(data, data_end, ip_rel + 6);
            }
            if proto == ETH_P_IP || proto == ETH_P_IPV6 {
                return Some(L2Info { proto, ip_rel });
            }
            return None;
        }

        if data + 2 > data_end {
            return None;
        }
        let ver = read_u8(data) >> 4;
        let proto = match ver {
            4 => ETH_P_IP,
            6 => ETH_P_IPV6,
            _ => return None,
        };
        Some(L2Info { proto, ip_rel: 0 })
    }
}

#[inline(always)]
unsafe fn walk_ipv6_ext(
    data: usize,
    data_end: usize,
    ip_rel: usize,
    mut nh: u8,
) -> Option<(u8, usize, bool)> {
    let mut cur_rel = ip_rel + 40;
    let mut iter = 0;
    unsafe {
        while iter < 4 {
            if nh == IPPROTO_HOPOPTS || nh == IPPROTO_DSTOPTS || nh == IPPROTO_ROUTING {
                let cur_off = data + cur_rel;
                if cur_off + 2 > data_end {
                    return None;
                }
                let next = read_u8(cur_off);
                let ext_len = (read_u8(cur_off + 1) as usize + 1) * 8;
                if cur_off + ext_len > data_end {
                    return None;
                }
                nh = next;
                cur_rel += ext_len;
                iter += 1;
            } else {
                return Some((nh, cur_rel, false));
            }
        }
    }
    Some((nh, cur_rel, true))
}

/// Walk up to 4 Hop-by-Hop / Destination Options / Routing extension headers
/// and locate the upper-layer protocol or Fragment header. Returns byte offsets
/// relative to `data`.
///
/// # Safety
/// `(data + ip_rel + 40)..data_end` must lie within readable packet bounds.
#[inline(always)]
pub unsafe fn locate_ipv6_l4(data: usize, data_end: usize, ip_rel: usize, nh: u8) -> Ipv6L4 {
    let Some((final_nh, cur_rel, hit_limit)) =
        (unsafe { walk_ipv6_ext(data, data_end, ip_rel, nh) })
    else {
        return Ipv6L4::NonUdp;
    };
    match final_nh {
        IPPROTO_UDP => Ipv6L4::Udp(cur_rel),
        IPPROTO_ICMPV6 => Ipv6L4::Icmp6(cur_rel),
        IPPROTO_FRAGMENT => Ipv6L4::Fragment,
        _ if hit_limit => Ipv6L4::Unsupported,
        _ => Ipv6L4::NonUdp,
    }
}

/// Walk Hop-by-Hop / Destination Options / Routing headers to locate `target`,
/// returning its offset relative to `data`.
///
/// # Safety
/// `(data + ip_rel + 40)..data_end` must lie within readable packet bounds.
#[inline(always)]
pub unsafe fn locate_ipv6_nexthdr(
    data: usize,
    data_end: usize,
    ip_rel: usize,
    nh: u8,
    target: u8,
) -> Option<usize> {
    let (final_nh, cur_rel, _) = unsafe { walk_ipv6_ext(data, data_end, ip_rel, nh) }?;
    if final_nh == target {
        Some(cur_rel)
    } else {
        None
    }
}

/// Walk Hop-by-Hop / Destination Options / Routing headers until the Fragment
/// header, returning its offset relative to `data`.
///
/// # Safety
/// `(data + ip_rel + 40)..data_end` must lie within readable packet bounds.
#[inline(always)]
pub unsafe fn ipv6_fragment_offset(
    data: usize,
    data_end: usize,
    ip_rel: usize,
    nh: u8,
) -> Option<usize> {
    let (final_nh, cur_rel, _) = unsafe { walk_ipv6_ext(data, data_end, ip_rel, nh) }?;
    if final_nh == IPPROTO_FRAGMENT && data + cur_rel + 8 <= data_end {
        Some(cur_rel)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::{align_of, size_of};

    fn slice_bounds(buf: &[u8]) -> (usize, usize) {
        let start = buf.as_ptr() as usize;
        (start, start + buf.len())
    }

    #[test]
    fn test_private_ipv4() {
        let ip_192 = u32::from_ne_bytes([192, 168, 1, 100]);
        assert!(is_private_ipv4(ip_192));
        let ip_10 = u32::from_ne_bytes([10, 1, 2, 3]);
        assert!(is_private_ipv4(ip_10));
        let ip_172 = u32::from_ne_bytes([172, 20, 5, 6]);
        assert!(is_private_ipv4(ip_172));
        let ip_cgnat = u32::from_ne_bytes([100, 64, 1, 2]);
        assert!(is_private_ipv4(ip_cgnat));
        let ip_pub = u32::from_ne_bytes([8, 8, 8, 8]);
        assert!(!is_private_ipv4(ip_pub));

        for octets in [
            [0, 0, 0, 0],
            [127, 0, 0, 1],
            [169, 254, 1, 1],
            [192, 0, 0, 9],
            [192, 0, 2, 1],
            [192, 88, 99, 1],
            [198, 18, 0, 1],
            [198, 19, 255, 254],
            [198, 51, 100, 7],
            [203, 0, 113, 9],
            [224, 0, 0, 1],
            [239, 255, 255, 254],
            [240, 0, 0, 1],
            [255, 255, 255, 255],
        ] {
            assert!(
                !is_private_ipv4(u32::from_ne_bytes(octets)),
                "expected {octets:?} to NOT be treated as internal"
            );
        }

        for octets in [
            [1, 1, 1, 1],
            [8, 8, 4, 4],
            [100, 63, 255, 255],
            [100, 128, 0, 1],
            [169, 253, 255, 255],
            [172, 15, 255, 255],
            [172, 32, 0, 1],
            [192, 1, 0, 1],
            [192, 169, 0, 1],
            [198, 17, 255, 255],
            [198, 20, 0, 1],
            [203, 0, 114, 1],
            [223, 255, 255, 254],
        ] {
            assert!(
                !is_private_ipv4(u32::from_ne_bytes(octets)),
                "expected {octets:?} to stay public"
            );
        }
    }

    #[test]
    fn test_routable_internal_ipv6() {
        let mut ula = [0u8; 16];
        ula[0] = 0xfd;
        ula[15] = 1;
        assert!(is_routable_internal_ipv6(&ula, false));
        assert!(is_routable_internal_ipv6(&ula, true));

        let mut ll = [0u8; 16];
        ll[0] = 0xfe;
        ll[1] = 0x80;
        ll[15] = 1;
        assert!(!is_routable_internal_ipv6(&ll, false));
        assert!(!is_routable_internal_ipv6(&ll, true));

        let mut mc = [0u8; 16];
        mc[0] = 0xff;
        mc[1] = 0x02;
        mc[15] = 1;
        assert!(!is_routable_internal_ipv6(&mc, false));
        assert!(!is_routable_internal_ipv6(&mc, true));

        let mut loopback = [0u8; 16];
        loopback[15] = 1;
        assert!(!is_routable_internal_ipv6(&loopback, false));
        assert!(!is_routable_internal_ipv6(&loopback, true));

        let mut gua = [0u8; 16];
        gua[0] = 0x24;
        gua[1] = 0x0e;
        gua[15] = 1;
        assert!(!is_routable_internal_ipv6(&gua, false));
        assert!(is_routable_internal_ipv6(&gua, true));

        for (b0, b1, expected_all) in [
            (0x01, 0x00, false),
            (0x1f, 0xff, false),
            (0x20, 0x00, true),
            (0x3f, 0xff, true),
            (0x40, 0x00, false),
        ] {
            let mut pfx = [0u8; 16];
            pfx[0] = b0;
            pfx[1] = b1;
            pfx[15] = 1;
            assert!(!is_routable_internal_ipv6(&pfx, false));
            assert_eq!(is_routable_internal_ipv6(&pfx, true), expected_all);
        }
    }

    #[test]
    fn test_internal_v4_prefixes_match_matcher() {
        for pfx in INTERNAL_V4_PREFIXES {
            let (base, len) = pfx.split_once('/').unwrap();
            let mut octets = [0u8; 4];
            for (i, part) in base.split('.').enumerate() {
                octets[i] = part.parse().unwrap();
            }
            let base_raw = u32::from_ne_bytes(octets);
            let base_be = u32::from_be_bytes(octets);
            let host_bits = 32 - len.parse::<u32>().unwrap();
            let last_be = base_be | ((1u32 << host_bits) - 1);
            let last_raw = u32::from_ne_bytes(last_be.to_be_bytes());
            assert!(
                is_private_ipv4(base_raw),
                "{pfx}: first address not internal"
            );
            assert!(
                is_private_ipv4(last_raw),
                "{pfx}: last address not internal"
            );
        }
    }

    #[test]
    fn test_shared_pod_layouts() {
        use core::mem::offset_of;
        assert_eq!(size_of::<EndpointKey4>(), 8);
        assert_eq!(align_of::<EndpointKey4>(), 4);
        assert_eq!(size_of::<BindingValue4>(), 12);
        assert_eq!(align_of::<BindingValue4>(), 4);
        assert_eq!(offset_of!(BindingValue4, port), 4);
        assert_eq!(offset_of!(BindingValue4, meta), 6);
        assert_eq!(size_of::<EndpointKey6>(), 20);
        assert_eq!(align_of::<EndpointKey6>(), 2);
        assert_eq!(size_of::<BindingValue6>(), 24);
        assert_eq!(align_of::<BindingValue6>(), 4);
        assert_eq!(offset_of!(BindingValue6, port), 16);
        assert_eq!(offset_of!(BindingValue6, meta), 18);
        assert_eq!(size_of::<SessionEvent4>(), 12);
        assert_eq!(size_of::<SessionEvent6>(), 24);
        assert_eq!(size_of::<FragKey4>(), 16);
        assert_eq!(size_of::<FragValue4>(), 12);
        assert_eq!(size_of::<FragKey6>(), 44);
        assert_eq!(size_of::<FragValue6>(), 24);
        assert_eq!(size_of::<GlobalConfig>(), 60);
        assert_eq!(align_of::<GlobalConfig>(), 4);
    }

    #[test]
    fn test_format_wan_ip_id_no_collision() {
        for cpu in 0..64 {
            for counter in 0..2048 {
                let id = format_wan_ip_id(counter, cpu);
                assert_eq!(id & 0x003f, (cpu as u16) & 0x003f);
            }
        }
    }

    #[test]
    fn test_format_wan_frag_id_no_collision() {
        for cpu in 0..256 {
            for counter in [0, 1, 2, 0xff, 0x100, 0x7fff, 0x00ff_ffff, 0x0100_0000] {
                let id = format_wan_frag_id(counter, cpu);
                assert_eq!(id & 0x00ff, cpu & 0x00ff);
            }
        }
    }

    #[test]
    fn test_rfc1624_csum_replace() {
        let original_csum: u16 = 0x55aa;
        assert_eq!(csum_replace(original_csum, 0x1234, 0x1234), original_csum);
        assert_eq!(csum_replace(0xffff, 0x1234, 0x1234), 0xffff);

        let new_csum = csum_replace(original_csum, 0x0000, 0x5678);
        assert_ne!(new_csum, original_csum);
        let restored = csum_replace(new_csum, 0x5678, 0x0000);
        assert_eq!(restored, original_csum);
    }

    #[test]
    fn test_parse_l2_ethernet_pppoe_and_raw_ip() {
        let raw_v4 = [0x45, 0x00, 0x00, 0x28];
        let (s, e) = slice_bounds(&raw_v4);
        let l2_raw4 = unsafe { parse_l2(s, e, 0) }.expect("raw ipv4");
        assert_eq!(l2_raw4.proto, ETH_P_IP);
        assert_eq!(l2_raw4.ip_rel, 0);

        let raw_v6 = [0x60, 0x00, 0x00, 0x00];
        let (s, e) = slice_bounds(&raw_v6);
        let l2_raw6 = unsafe { parse_l2(s, e, 0) }.expect("raw ipv6");
        assert_eq!(l2_raw6.proto, ETH_P_IPV6);
        assert_eq!(l2_raw6.ip_rel, 0);

        let mut eth_v4 = [0u8; 14 + 20];
        eth_v4[12] = 0x08;
        eth_v4[13] = 0x00;
        let (s, e) = slice_bounds(&eth_v4);
        let l2_eth4 = unsafe { parse_l2(s, e, 14) }.expect("eth ipv4");
        assert_eq!(l2_eth4.proto, ETH_P_IP);
        assert_eq!(l2_eth4.ip_rel, 14);

        let mut vlan_v6 = [0u8; 18 + 40];
        vlan_v6[12] = 0x81;
        vlan_v6[13] = 0x00;
        vlan_v6[14] = 0x00;
        vlan_v6[15] = 100;
        vlan_v6[16] = 0x86;
        vlan_v6[17] = 0xdd;
        let (s, e) = slice_bounds(&vlan_v6);
        let l2_vlan = unsafe { parse_l2(s, e, 14) }.expect("vlan ipv6");
        assert_eq!(l2_vlan.proto, ETH_P_IPV6);
        assert_eq!(l2_vlan.ip_rel, 18);

        // Compressed 1-byte PPP protocol inside PPPoE session frame
        let mut pppoe_comp = [0u8; 14 + 6 + 1 + 20];
        pppoe_comp[12] = 0x88;
        pppoe_comp[13] = 0x64;
        pppoe_comp[20] = 0x21;
        let (s, e) = slice_bounds(&pppoe_comp);
        let l2_ppp = unsafe { parse_l2(s, e, 14) }.expect("pppoe compressed ipv4");
        assert_eq!(l2_ppp.proto, ETH_P_IP);
        assert_eq!(l2_ppp.ip_rel, 21);
    }

    #[test]
    fn test_locate_ipv6_l4_and_fragment_after_4_ext_headers() {
        let mut pkt_udp = [0u8; 40 + 8];
        let (s, e) = slice_bounds(&pkt_udp);
        assert_eq!(
            unsafe { locate_ipv6_l4(s, e, 0, IPPROTO_UDP) },
            Ipv6L4::Udp(40)
        );

        pkt_udp[40] = IPPROTO_UDP;
        pkt_udp[41] = 0;
        let (s, e) = slice_bounds(&pkt_udp);
        assert_eq!(
            unsafe { locate_ipv6_l4(s, e, 0, IPPROTO_HOPOPTS) },
            Ipv6L4::Udp(48)
        );
        assert_eq!(
            unsafe { locate_ipv6_l4(s, e, 0, IPPROTO_FRAGMENT) },
            Ipv6L4::Fragment
        );

        // 4 extension headers followed by Fragment header must still be
        // recognized as Fragment
        let mut pkt_4ext_frag = [0u8; 40 + 8 * 4 + 8];
        for i in 0..3 {
            pkt_4ext_frag[40 + i * 8] = IPPROTO_DSTOPTS;
        }
        pkt_4ext_frag[40 + 3 * 8] = IPPROTO_FRAGMENT;
        let (s, e) = slice_bounds(&pkt_4ext_frag);
        assert_eq!(
            unsafe { locate_ipv6_l4(s, e, 0, IPPROTO_HOPOPTS) },
            Ipv6L4::Fragment
        );
        assert_eq!(
            unsafe { ipv6_fragment_offset(s, e, 0, IPPROTO_HOPOPTS) },
            Some(40 + 32)
        );
    }

    #[test]
    fn test_locate_ipv6_nexthdr() {
        let mut pkt = [0u8; 40 + 8 + 8 + 8];
        pkt[40] = IPPROTO_ROUTING;
        pkt[41] = 0;
        pkt[48] = IPPROTO_ICMPV6;
        pkt[49] = 0;
        let (s, e) = slice_bounds(&pkt);
        assert_eq!(
            unsafe { locate_ipv6_nexthdr(s, e, 0, IPPROTO_HOPOPTS, IPPROTO_ICMPV6) },
            Some(56)
        );
        assert_eq!(
            unsafe { locate_ipv6_nexthdr(s, e, 0, IPPROTO_HOPOPTS, IPPROTO_UDP) },
            None
        );
    }

    #[test]
    fn test_reserved_epoch_state_machine() {
        let mut s = 0u16;
        assert!(!reserved_state_is_reserved(s));
        s = reserved_state_next_added(s);
        assert_eq!(s, 1);
        assert!(reserved_state_is_reserved(s));
        assert_eq!(reserved_state_next_added(s), 1);

        s = reserved_state_next_removed(s);
        assert_eq!(s, 2);
        assert!(!reserved_state_is_reserved(s));
        assert_eq!(reserved_state_next_removed(s), 2);

        let high = 0xfffeu16;
        let high_res = reserved_state_next_added(high);
        assert_eq!(high_res, 0xffff);
        assert!(reserved_state_is_reserved(high_res));
        let wrapped = reserved_state_next_removed(high_res);
        assert_eq!(wrapped, 0);
        assert!(!reserved_state_is_reserved(wrapped));
    }

    #[test]
    fn test_binding_meta_epoch_and_short_lived_flag() {
        let mut v4 = BindingValue4 {
            ip: 0x0a000001,
            port: 1234,
            meta: pack_binding_meta(true, 4),
            last_seen: 100,
        };
        assert!(v4.is_short_lived());
        assert!(binding_matches_reserved(4, v4.reserved_meta()));
        assert!(!binding_matches_reserved(5, v4.reserved_meta()));
        assert!(!binding_matches_reserved(6, v4.reserved_meta()));

        v4.clear_short_lived();
        assert!(!v4.is_short_lived());
        assert!(binding_matches_reserved(4, v4.reserved_meta()));

        v4.set_reserved_epoch(6);
        assert!(!v4.is_short_lived());
        assert!(binding_matches_reserved(6, v4.reserved_meta()));

        let mut v6 = BindingValue6 {
            ip: [0; 16],
            port: 5678,
            meta: pack_binding_meta(true, 10),
            last_seen: 200,
        };
        assert!(v6.is_short_lived());
        assert!(binding_matches_reserved(10, v6.reserved_meta()));
        assert!(!binding_matches_reserved(12, v6.reserved_meta()));
        v6.clear_short_lived();
        assert!(!v6.is_short_lived());
        assert!(binding_matches_reserved(10, v6.reserved_meta()));
    }

    #[test]
    fn test_bitmap_coords_roundtrip_all_ports() {
        for port in 0..=65535u16 {
            let (is_even, slot, mask) = port_to_bitmap_coords(port);
            assert!(slot < PORT_BITMAP_SLOTS);
            let bit = mask.trailing_zeros();
            assert_eq!(bitmap_coords_to_port(is_even, slot, bit), port);
        }
    }
}
