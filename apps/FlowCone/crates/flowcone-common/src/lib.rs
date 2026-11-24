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
pub const DEFAULT_SHORT_LIVED_TIMEOUT_SEC: u32 = 5;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BindingValue4 {
    pub ip: u32,
    pub port: u16,
    pub _pad: u16,
    pub last_seen: u32,
}

impl BindingValue4 {
    #[inline(always)]
    pub fn is_short_lived(&self) -> bool {
        self._pad & BINDING_FLAG_SHORT_LIVED != 0
    }
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for BindingValue4 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct EndpointKey6 {
    pub ip: [u8; 16],
    pub port: u16,
    pub _pad: [u16; 3],
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for EndpointKey6 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BindingValue6 {
    pub ip: [u8; 16],
    pub port: u16,
    pub _pad: [u16; 3],
    pub last_seen: u32,
}

impl BindingValue6 {
    #[inline(always)]
    pub fn is_short_lived(&self) -> bool {
        self._pad[0] & BINDING_FLAG_SHORT_LIVED != 0
    }
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for BindingValue6 {}

/// Session creation notification event.
/// `key.port` is in network byte order; `port` is allocated in host byte order.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEvent4 {
    pub key: EndpointKey4,
    pub port: u16,
    pub _pad: u16,
}

impl SessionEvent4 {
    #[inline(always)]
    pub fn is_short_lived(&self) -> bool {
        self._pad & BINDING_FLAG_SHORT_LIVED != 0
    }

    #[inline(always)]
    pub fn internal_port_host(&self) -> u16 {
        u16::from_be(self.key.port)
    }

    #[inline(always)]
    pub fn external_port_host(&self) -> u16 {
        self.port
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
    pub _pad: [u16; 3],
}

impl SessionEvent6 {
    #[inline(always)]
    pub fn is_short_lived(&self) -> bool {
        self._pad[0] & BINDING_FLAG_SHORT_LIVED != 0
    }

    #[inline(always)]
    pub fn internal_port_host(&self) -> u16 {
        u16::from_be(self.key.port)
    }

    #[inline(always)]
    pub fn external_port_host(&self) -> u16 {
        self.port
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

/// Routable private IPv4 source ranges matching `is_private_ipv4()` (RFC 1918, RFC 6598).
#[cfg(not(target_arch = "bpf"))]
pub const INTERNAL_V4_PREFIXES: &[&str] = &[
    "10.0.0.0/8",
    "100.64.0.0/10",
    "172.16.0.0/12",
    "192.168.0.0/16",
];

/// Checks if an IPv4 source address belongs to private or CGNAT ranges (RFC 1918, RFC 6598).
/// Expects `raw_ip` loaded from wire octets in native memory order [b0, b1, b2, b3].
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

/// Checks if an IPv6 address is a routable internal unicast source (ULA fc00::/7, or GUA 2000::/3 if enabled).
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
pub const SESSION_EVENT_RINGBUF_BYTES: u32 = 4194304;
pub const PORT_STATE_ENTRIES: u32 = 65536;
pub const PORT_QUEUE_ENTRIES: u32 = 65536;
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

pub const PORT_FREE_BIT: u8 = 1;
pub const PORT_QUEUED_BIT: u8 = 2;

/// Clears `PORT_QUEUED_BIT`.
#[inline(always)]
pub fn port_state_on_unqueue(state: u8) -> u8 {
    state & !PORT_QUEUED_BIT
}

/// Clears `PORT_FREE_BIT`.
#[inline(always)]
pub fn port_state_on_bound(state: u8) -> u8 {
    state & !PORT_FREE_BIT
}

/// Evaluates state on port release; returns `(needs_queue_push, new_state)`.
#[inline(always)]
pub fn port_state_on_release(state: u8) -> (bool, u8) {
    let next = state | PORT_FREE_BIT;
    if next & PORT_QUEUED_BIT != 0 {
        (false, next)
    } else {
        (true, next | PORT_QUEUED_BIT)
    }
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
    pub ip_off: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ipv6L4 {
    Udp(usize),
    Fragment,
    Icmp6(usize),
    NonUdp,
    Unsupported,
}

#[inline(always)]
pub fn parse_ppp_slice(data: &[u8], mut off: usize) -> Option<L2Info> {
    if off + 2 > data.len() {
        return None;
    }
    if data[off] == 0xff && off + 2 <= data.len() && data[off + 1] == 0x03 {
        off += 2;
    }
    if off + 2 > data.len() {
        return None;
    }
    let b0 = data[off];
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
    if off + 2 > data.len() {
        return None;
    }
    let raw = u16::from_be_bytes([data[off], data[off + 1]]);
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

#[inline(always)]
pub fn parse_l2_slice(data: &[u8], l2_len: u32) -> Option<L2Info> {
    if l2_len == 14 {
        if data.len() < 14 {
            return None;
        }
        let mut proto = u16::from_be_bytes([data[12], data[13]]);
        let mut ip_off = 14;
        let mut tags = 0;
        while (proto == ETH_P_8021Q || proto == ETH_P_8021AD) && tags < 2 {
            if ip_off + 4 > data.len() {
                return None;
            }
            proto = u16::from_be_bytes([data[ip_off + 2], data[ip_off + 3]]);
            ip_off += 4;
            tags += 1;
        }
        if proto == ETH_P_PPPOE {
            if ip_off + 6 > data.len() {
                return None;
            }
            return parse_ppp_slice(data, ip_off + 6);
        }
        if proto == ETH_P_IP || proto == ETH_P_IPV6 {
            return Some(L2Info { proto, ip_off });
        }
        return None;
    }

    if data.len() < 2 {
        return None;
    }
    let ver = data[0] >> 4;
    let proto = match ver {
        4 => ETH_P_IP,
        6 => ETH_P_IPV6,
        _ => return None,
    };
    Some(L2Info { proto, ip_off: 0 })
}

#[inline(always)]
pub fn locate_ipv6_l4_slice(data: &[u8], ip_off: usize, mut nh: u8) -> Ipv6L4 {
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
            if cur_off + 2 > data.len() {
                return Ipv6L4::NonUdp;
            }
            let next = data[cur_off];
            let ext_len = (data[cur_off + 1] as usize + 1) * 8;
            if cur_off + ext_len > data.len() {
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

#[inline(always)]
pub fn locate_ipv6_nexthdr_slice(
    data: &[u8],
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
            if cur_off + 2 > data.len() {
                return None;
            }
            let next = data[cur_off];
            let ext_len = (data[cur_off + 1] as usize + 1) * 8;
            if cur_off + ext_len > data.len() {
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

#[inline(always)]
pub fn ipv6_fragment_offset_slice(data: &[u8], ip_off: usize, mut nh: u8) -> Option<usize> {
    if nh == IPPROTO_FRAGMENT {
        let cur = ip_off + 40;
        if cur + 8 <= data.len() {
            return Some(cur);
        }
        return None;
    }
    let mut cur = ip_off + 40;
    let mut iter = 0;
    while iter < 4 {
        if nh == IPPROTO_FRAGMENT {
            if cur + 8 <= data.len() {
                return Some(cur);
            }
            return None;
        }
        if nh != IPPROTO_HOPOPTS && nh != IPPROTO_DSTOPTS && nh != IPPROTO_ROUTING {
            return None;
        }
        if cur + 2 > data.len() {
            return None;
        }
        let next = data[cur];
        let len = (data[cur + 1] as usize + 1) * 8;
        if cur + len > data.len() {
            return None;
        }
        nh = next;
        cur += len;
        iter += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_private_ipv4() {
        // 192.168.1.100 in native u32
        let ip_192 = u32::from_ne_bytes([192, 168, 1, 100]);
        assert!(is_private_ipv4(ip_192));

        // 10.1.2.3
        let ip_10 = u32::from_ne_bytes([10, 1, 2, 3]);
        assert!(is_private_ipv4(ip_10));

        // 172.20.5.6 (within 172.16.0.0/12)
        let ip_172 = u32::from_ne_bytes([172, 20, 5, 6]);
        assert!(is_private_ipv4(ip_172));

        // 100.64.1.2 (CGNAT RFC 6598)
        let ip_cgnat = u32::from_ne_bytes([100, 64, 1, 2]);
        assert!(is_private_ipv4(ip_cgnat));

        // 8.8.8.8 (Public)
        let ip_pub = u32::from_ne_bytes([8, 8, 8, 8]);
        assert!(!is_private_ipv4(ip_pub));

        // Non-private / special-purpose ranges must not be treated as internal LAN space.
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

        // Neighbouring public space must stay untouched.
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
        // ULA fd00::1
        let mut ula = [0u8; 16];
        ula[0] = 0xfd;
        ula[15] = 1;
        assert!(is_routable_internal_ipv6(&ula, false));
        assert!(is_routable_internal_ipv6(&ula, true));

        // Link-Local fe80::1 (Must be blocked)
        let mut ll = [0u8; 16];
        ll[0] = 0xfe;
        ll[1] = 0x80;
        ll[15] = 1;
        assert!(!is_routable_internal_ipv6(&ll, false));
        assert!(!is_routable_internal_ipv6(&ll, true));

        // Multicast ff02::1 (Must be blocked)
        let mut mc = [0u8; 16];
        mc[0] = 0xff;
        mc[1] = 0x02;
        mc[15] = 1;
        assert!(!is_routable_internal_ipv6(&mc, false));
        assert!(!is_routable_internal_ipv6(&mc, true));

        // Loopback ::1 (Must be blocked)
        let mut loopback = [0u8; 16];
        loopback[15] = 1;
        assert!(!is_routable_internal_ipv6(&loopback, false));
        assert!(!is_routable_internal_ipv6(&loopback, true));

        // GUA 240e:1234::1
        let mut gua = [0u8; 16];
        gua[0] = 0x24;
        gua[1] = 0x0e;
        gua[15] = 1;
        // False if allow_all_internal is false (ULA only mode)
        assert!(!is_routable_internal_ipv6(&gua, false));
        // True if allow_all_internal is true (GUA+ULA mode)
        assert!(is_routable_internal_ipv6(&gua, true));

        // Exact 2000::/3 boundaries and non-GUA exclusions
        let mut pfx_100 = [0u8; 16];
        pfx_100[0] = 0x01;
        pfx_100[15] = 1;
        assert!(!is_routable_internal_ipv6(&pfx_100, false));
        assert!(!is_routable_internal_ipv6(&pfx_100, true));

        let mut pfx_1fff = [0u8; 16];
        pfx_1fff[0] = 0x1f;
        pfx_1fff[1] = 0xff;
        pfx_1fff[15] = 1;
        assert!(!is_routable_internal_ipv6(&pfx_1fff, false));
        assert!(!is_routable_internal_ipv6(&pfx_1fff, true));

        let mut pfx_2000 = [0u8; 16];
        pfx_2000[0] = 0x20;
        pfx_2000[15] = 1;
        assert!(!is_routable_internal_ipv6(&pfx_2000, false));
        assert!(is_routable_internal_ipv6(&pfx_2000, true));

        let mut pfx_3fff = [0u8; 16];
        pfx_3fff[0] = 0x3f;
        pfx_3fff[1] = 0xff;
        pfx_3fff[15] = 1;
        assert!(!is_routable_internal_ipv6(&pfx_3fff, false));
        assert!(is_routable_internal_ipv6(&pfx_3fff, true));

        let mut pfx_4000 = [0u8; 16];
        pfx_4000[0] = 0x40;
        pfx_4000[15] = 1;
        assert!(!is_routable_internal_ipv6(&pfx_4000, false));
        assert!(!is_routable_internal_ipv6(&pfx_4000, true));
    }

    #[test]
    fn test_internal_v4_prefixes_match_matcher() {
        for pfx in INTERNAL_V4_PREFIXES {
            let (base, len) = pfx.split_once('/').unwrap();
            let mut octets = [0u8; 4];
            for (i, part) in base.split('.').enumerate() {
                octets[i] = part.parse().unwrap();
            }
            // The matcher is defined over raw packet bytes, i.e. network byte
            // order. Build the first and last address in that same order.
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
    fn test_global_config_layout() {
        assert_eq!(core::mem::size_of::<GlobalConfig>(), 60);
        assert_eq!(core::mem::align_of::<GlobalConfig>(), 4);
    }

    #[test]
    fn test_port_lifecycle_state_machine() {
        let initial = PORT_FREE_BIT | PORT_QUEUED_BIT;
        assert_eq!(initial, 0x03);

        let unqueued = port_state_on_unqueue(initial);
        assert_eq!(unqueued, PORT_FREE_BIT);

        let bound = port_state_on_bound(unqueued);
        assert_eq!(bound, 0);

        let (needs_push, released) = port_state_on_release(bound);
        assert!(needs_push);
        assert_eq!(released, PORT_FREE_BIT | PORT_QUEUED_BIT);

        // Port preservation flow: bound directly from initial state
        let preserved_bound = port_state_on_bound(initial);
        assert_eq!(preserved_bound, PORT_QUEUED_BIT);

        let stale_popped = port_state_on_unqueue(preserved_bound);
        assert_eq!(stale_popped, 0);

        let (needs_push, refreshed) = port_state_on_release(preserved_bound);
        assert!(!needs_push);
        assert_eq!(refreshed, PORT_FREE_BIT | PORT_QUEUED_BIT);

        // Duplicate release guard
        let (needs_push, dup_state) = port_state_on_release(PORT_FREE_BIT | PORT_QUEUED_BIT);
        assert!(!needs_push);
        assert_eq!(dup_state, PORT_FREE_BIT | PORT_QUEUED_BIT);
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
        // Identity: replacing with same value must yield same checksum
        let original_csum: u16 = 0x55aa;
        assert_eq!(csum_replace(original_csum, 0x1234, 0x1234), original_csum);
        assert_eq!(csum_replace(0xffff, 0x1234, 0x1234), 0xffff);

        // Replacing zero with a value, then reversing it, must yield original checksum
        let new_csum = csum_replace(original_csum, 0x0000, 0x5678);
        assert_ne!(new_csum, original_csum);
        let restored = csum_replace(new_csum, 0x5678, 0x0000);
        assert_eq!(restored, original_csum);
    }

    #[test]
    fn test_parse_l2_slice_ethernet_and_raw_ip() {
        let raw_v4 = [0x45, 0x00, 0x00, 0x28];
        let l2_raw4 = parse_l2_slice(&raw_v4, 0).expect("raw ipv4");
        assert_eq!(l2_raw4.proto, ETH_P_IP);
        assert_eq!(l2_raw4.ip_off, 0);

        let raw_v6 = [0x60, 0x00, 0x00, 0x00];
        let l2_raw6 = parse_l2_slice(&raw_v6, 0).expect("raw ipv6");
        assert_eq!(l2_raw6.proto, ETH_P_IPV6);
        assert_eq!(l2_raw6.ip_off, 0);

        let mut eth_v4 = [0u8; 14 + 20];
        eth_v4[12] = 0x08;
        eth_v4[13] = 0x00;
        let l2_eth4 = parse_l2_slice(&eth_v4, 14).expect("eth ipv4");
        assert_eq!(l2_eth4.proto, ETH_P_IP);
        assert_eq!(l2_eth4.ip_off, 14);

        let mut vlan_v6 = [0u8; 18 + 40];
        vlan_v6[12] = 0x81;
        vlan_v6[13] = 0x00;
        vlan_v6[14] = 0x00;
        vlan_v6[15] = 100;
        vlan_v6[16] = 0x86;
        vlan_v6[17] = 0xdd;
        let l2_vlan = parse_l2_slice(&vlan_v6, 14).expect("vlan ipv6");
        assert_eq!(l2_vlan.proto, ETH_P_IPV6);
        assert_eq!(l2_vlan.ip_off, 18);
    }

    #[test]
    fn test_locate_ipv6_l4_slice() {
        let mut pkt_udp = [0u8; 40 + 8];
        pkt_udp[6] = IPPROTO_UDP;
        let l4 = locate_ipv6_l4_slice(&pkt_udp, 0, IPPROTO_UDP);
        match l4 {
            Ipv6L4::Udp(off) => assert_eq!(off, 40),
            _ => panic!("expected UDP at offset 40"),
        }

        let mut pkt_hbh = [0u8; 40 + 8 + 8];
        pkt_hbh[40] = IPPROTO_UDP;
        pkt_hbh[41] = 0;
        let l4_hbh = locate_ipv6_l4_slice(&pkt_hbh, 0, IPPROTO_HOPOPTS);
        match l4_hbh {
            Ipv6L4::Udp(off) => assert_eq!(off, 48),
            _ => panic!("expected UDP at offset 48 after HBH"),
        }

        let l4_frag = locate_ipv6_l4_slice(&pkt_hbh, 0, IPPROTO_FRAGMENT);
        match l4_frag {
            Ipv6L4::Fragment => {}
            _ => panic!("expected Fragment"),
        }

        let mut pkt_routing = [0u8; 40 + 8 + 8];
        pkt_routing[40] = IPPROTO_UDP;
        pkt_routing[41] = 0;
        let l4_routing = locate_ipv6_l4_slice(&pkt_routing, 0, IPPROTO_ROUTING);
        match l4_routing {
            Ipv6L4::Udp(off) => assert_eq!(off, 48),
            _ => panic!("expected UDP at offset 48 after Routing header"),
        }
    }

    #[test]
    fn test_ipv6_fragment_offset_slice_routing() {
        let mut pkt = [0u8; 40 + 8 + 8];
        pkt[40] = IPPROTO_FRAGMENT;
        pkt[41] = 0;
        let off = ipv6_fragment_offset_slice(&pkt, 0, IPPROTO_ROUTING);
        assert_eq!(off, Some(48));
    }

    #[test]
    fn test_locate_ipv6_nexthdr_slice() {
        let mut pkt = [0u8; 40 + 8 + 8 + 8];
        // Hop-by-Hop at offset 40, length 8 bytes, next header = Routing (43)
        pkt[40] = IPPROTO_ROUTING;
        pkt[41] = 0;
        // Routing at offset 48, length 8 bytes, next header = ICMPv6 (58)
        pkt[48] = IPPROTO_ICMPV6;
        pkt[49] = 0;
        // ICMPv6 at offset 56
        let off = locate_ipv6_nexthdr_slice(&pkt, 0, IPPROTO_HOPOPTS, IPPROTO_ICMPV6);
        assert_eq!(off, Some(56));

        // Locate UDP (not present)
        let off_udp = locate_ipv6_nexthdr_slice(&pkt, 0, IPPROTO_HOPOPTS, IPPROTO_UDP);
        assert_eq!(off_udp, None);
    }

    #[test]
    fn test_multi_bit_slot_probing_simulation() {
        // Simulate a slot where low bits are blocked/reserved (< 1024)
        // Ensure probing finds the first valid bit in the slot
        let val: u64 = 0b0000_0111; // bits 0, 1, 2 occupied
        let mut mask_avail = !val;
        let mut tested_bits = [0u32; 64];
        let mut count = 0;
        let mut probe = 0;
        while probe < 64 && mask_avail != 0 {
            let free_bit = mask_avail.trailing_zeros();
            let mask = 1u64 << free_bit;
            mask_avail &= !mask;
            tested_bits[count] = free_bit;
            count += 1;
            probe += 1;
        }
        assert_eq!(tested_bits[0], 3);
        assert_eq!(count, 61);
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
