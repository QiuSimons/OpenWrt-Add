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

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BindingValue4 {
    pub ip: u32,
    pub port: u16,
    pub _pad: u16,
    pub last_seen: u32,
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

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for BindingValue6 {}

/// One new session notification consumed by the user-space expiry scheduler.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEvent4 {
    pub key: EndpointKey4,
    pub port: u16,
    pub _pad: u16,
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for SessionEvent4 {}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionEvent6 {
    pub key: EndpointKey6,
    pub port: u16,
    pub _pad: [u16; 3],
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for SessionEvent6 {}

/// Fragment cache key. id is kept in packet byte order; it is only a key.
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
    pub _pad: u32,
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
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for GlobalConfig {}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConfigStore {
    pub active: u32,
    pub slots: [GlobalConfig; 2],
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for ConfigStore {}

/// Non-routable IPv4 source ranges, as CIDR strings.
///
/// Must match is_private_ipv4(): the nftables srcnat exemption set is
/// generated from this list, so the eBPF SNAT gate and the firewall can never
/// drift apart. A range that is exempted from masquerade but not SNATed by the
/// eBPF program would leak the private source address.
#[cfg(not(target_arch = "bpf"))]
pub const INTERNAL_V4_PREFIXES: &[&str] = &[
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];

/// Check if an IPv4 source must not leave the WAN untranslated.
///
/// Covers the private/CGNAT subnets and the IANA special-purpose ranges
/// (RFC 6890). Expects the ip in raw packet byte representation.
#[inline(always)]
pub fn is_private_ipv4(raw_ip: u32) -> bool {
    let b = raw_ip.to_ne_bytes();

    match b[0] {
        // 0.0.0.0/8 ("this network"), 10.0.0.0/8, 127.0.0.0/8 (loopback)
        0 | 10 | 127 => true,
        // 100.64.0.0/10 (CGNAT, RFC 6598)
        100 => (64..=127).contains(&b[1]),
        // 169.254.0.0/16 (link-local)
        169 => b[1] == 254,
        // 172.16.0.0/12
        172 => (16..=31).contains(&b[1]),
        192 => match b[1] {
            // 192.0.0.0/24 (IETF protocol assignments), 192.0.2.0/24 (TEST-NET-1)
            0 => b[2] == 0 || b[2] == 2,
            // 192.88.99.0/24 (deprecated 6to4 relay anycast)
            88 => b[2] == 99,
            // 192.168.0.0/16
            168 => true,
            _ => false,
        },
        // 198.18.0.0/15 (benchmarking), 198.51.100.0/24 (TEST-NET-2)
        198 => (18..=19).contains(&b[1]) || (b[1] == 51 && b[2] == 100),
        // 203.0.113.0/24 (TEST-NET-3)
        203 => b[1] == 0 && b[2] == 113,
        // 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved) incl. 255.255.255.255
        224..=255 => true,
        _ => false,
    }
}

/// Check if IPv6 address belongs to Unique Local Address (ULA fc00::/7)
#[inline(always)]
pub fn is_ula_ipv6(addr: &[u8; 16]) -> bool {
    (addr[0] & 0xfe) == 0xfc
}

/// Check if IPv6 address is a valid routable internal unicast address (excluding link-local, multicast, loopback)
#[inline(always)]
pub fn is_routable_internal_ipv6(addr: &[u8; 16], allow_all_internal: bool) -> bool {
    // Multicast: ff00::/8
    if addr[0] == 0xff {
        return false;
    }
    // Link-Local: fe80::/10 (fe80..febf)
    if addr[0] == 0xfe && (addr[1] & 0xc0) == 0x80 {
        return false;
    }
    // ULA (fc00::/7) is never loopback or unspecified; accept immediately.
    if is_ula_ipv6(addr) {
        return true;
    }
    if !allow_all_internal {
        return false;
    }

    // Loopback / Unspecified: ::1 or ::
    u128::from_be_bytes(*addr) > 1
}

pub const MAX_BINDINGS: u32 = 65536;
/// Per-direction, per-family fragment cache capacity. Keep this the single
/// source of truth for the eBPF LRU maps.
pub const FRAG_MAP_ENTRIES: u32 = 1024;
/// Capacity in bytes for the session event ring buffers.
/// Must be a power of 2 and a multiple of page size (4096).
/// 262,144 bytes (256 KiB) holds ~10,000 session creation events.
pub const SESSION_EVENT_RINGBUF_BYTES: u32 = 262144;
/// One byte of state per port; 65536 entries cover the full u16 port space.
pub const PORT_STATE_ENTRIES: u32 = 65536;
/// Each parity queue can hold the whole pool; duplicates are skipped via the
/// per-port state, and a full queue sets a user-space rebuild flag.
pub const PORT_QUEUE_ENTRIES: u32 = 65536;

/// Packet mark set on DNAT-translated inbound packets. The daemon can override
/// this through GlobalConfig to avoid colliding with proxy/policy marks.
pub const DEFAULT_FLOWCONE_MARK: u32 = 0x40000000;

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

        // IANA special-purpose source ranges must not reach the WAN untranslated.
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
                is_private_ipv4(u32::from_ne_bytes(octets)),
                "expected {octets:?} to be treated as internal"
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
        assert_eq!(core::mem::size_of::<GlobalConfig>(), 56);
        assert_eq!(core::mem::align_of::<GlobalConfig>(), 4);
        assert_eq!(core::mem::size_of::<ConfigStore>(), 116);
        assert_eq!(core::mem::align_of::<ConfigStore>(), 4);
    }
}
