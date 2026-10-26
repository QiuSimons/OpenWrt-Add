#![no_std]
#![no_main]

use aya_ebpf::{
    bindings::{TC_ACT_SHOT, TC_ACT_UNSPEC},
    helpers::bpf_ktime_get_coarse_ns,
    macros::{classifier, map},
    maps::{Array, HashMap, LruHashMap, ProgramArray, Queue},
    programs::TcContext,
};
use core::mem;
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, FragKey4, FragKey6, FragValue4,
    FragValue6, GlobalConfig, MAX_BINDINGS, PORT_QUEUE_ENTRIES, PORT_STATE_ENTRIES,
    SESSION_EVENT_ENTRIES, SessionEvent4, SessionEvent6,
};

const IPPROTO_ICMP: u8 = 1;
const IPPROTO_UDP: u8 = 17;
const IPPROTO_HOPOPTS: u8 = 0;
const IPPROTO_ROUTING: u8 = 43;
const IPPROTO_FRAGMENT: u8 = 44;
const IPPROTO_DSTOPTS: u8 = 60;

const BPF_F_PSEUDO_HDR: u64 = 0x10;
const BPF_F_MARK_MANGLED_0: u64 = 0x20;
const CSUM_FIELD_U16: u64 = 2;
const CSUM_FIELD_U32: u64 = 4;
const IPV4_CSUM_OFFSET: usize = 10;
const UDP_CSUM_OFFSET: usize = 6;

const BPF_ANY: u64 = 0;
const BPF_NOEXIST: u64 = 1;
const BPF_F_NO_PREALLOC: u32 = 1;

#[unsafe(link_section = "license")]
#[used]
static LICENSE: [u8; 4] = *b"GPL\0";

/// Double-buffered config: ACTIVE_CONFIG selects one of two immutable slots.
#[map]
static CONFIG: Array<GlobalConfig> = Array::with_max_entries(2, 0);

#[map]
static ACTIVE_CONFIG: Array<u32> = Array::with_max_entries(1, 0);

/// Tail-call targets for the tiny A/B dispatchers. The real FlowCone program
/// is loaded once and is never attached directly; the dispatchers are the
/// only TCX links.
#[map]
static INGRESS_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);
#[map]
static EGRESS_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);
#[map]
static FRAG_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);
#[map]
static ICMP_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);
#[map]
static ICMP6_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);

const FRAG_ENTRIES: u32 = 1024;
const FRAG_TIMEOUT_NS: u64 = 30_000_000_000;

#[map]
static FRAG_IN_V4: LruHashMap<FragKey4, FragValue4> = LruHashMap::with_max_entries(FRAG_ENTRIES, 0);
#[map]
static FRAG_OUT_V4: LruHashMap<FragKey4, FragValue4> =
    LruHashMap::with_max_entries(FRAG_ENTRIES, 0);

#[map]
static FRAG_IN_V6: LruHashMap<FragKey6, FragValue6> = LruHashMap::with_max_entries(FRAG_ENTRIES, 0);
#[map]
static FRAG_OUT_V6: LruHashMap<FragKey6, FragValue6> =
    LruHashMap::with_max_entries(FRAG_ENTRIES, 0);

#[map]
static OUTBOUND_BINDINGS_V4: HashMap<EndpointKey4, BindingValue4> =
    HashMap::with_max_entries(MAX_BINDINGS, BPF_F_NO_PREALLOC);

#[map]
static INBOUND_BINDINGS_V4: HashMap<u16, BindingValue4> =
    HashMap::with_max_entries(MAX_BINDINGS, BPF_F_NO_PREALLOC);

#[map]
static OUTBOUND_BINDINGS_V6: HashMap<EndpointKey6, BindingValue6> =
    HashMap::with_max_entries(MAX_BINDINGS, BPF_F_NO_PREALLOC);

#[map]
static INBOUND_BINDINGS_V6: HashMap<u16, BindingValue6> =
    HashMap::with_max_entries(MAX_BINDINGS, BPF_F_NO_PREALLOC);

/// Session-create notifications for the user-space expiry scheduler.
#[map]
static SESSION_EVENTS_V4: Queue<SessionEvent4> = Queue::with_max_entries(SESSION_EVENT_ENTRIES, 0);

#[map]
static SESSION_EVENTS_V6: Queue<SessionEvent6> = Queue::with_max_entries(SESSION_EVENT_ENTRIES, 0);

#[map]
static GC_FLAGS: Array<u32> = Array::with_max_entries(1, 0);

/// Port pool: one state byte per port plus two parity queues. The byte marks
/// whether the port is still queued; BPF_NOEXIST is the authoritative claim.
#[map]
static PORT_FREE_V4: Array<u8> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

#[map]
static PORT_FREE_V6: Array<u8> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

/// Ports bound by local UDP services (DNS, WireGuard, IPsec, proxy, ...).
/// Reserve both families conservatively so FlowCone never steals a WAN
/// service port via port preservation.
#[map]
static RESERVED_V4: Array<u8> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

#[map]
static RESERVED_V6: Array<u8> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

#[map]
static FREE_EVEN_V4: Queue<u16> = Queue::with_max_entries(PORT_QUEUE_ENTRIES, 0);

#[map]
static FREE_ODD_V4: Queue<u16> = Queue::with_max_entries(PORT_QUEUE_ENTRIES, 0);

#[map]
static FREE_EVEN_V6: Queue<u16> = Queue::with_max_entries(PORT_QUEUE_ENTRIES, 0);

#[map]
static FREE_ODD_V6: Queue<u16> = Queue::with_max_entries(PORT_QUEUE_ENTRIES, 0);

#[map]
static PORT_FLAGS: Array<u32> = Array::with_max_entries(1, 0);

#[repr(C, packed)]
struct Ipv4Hdr {
    ver_ihl: u8,
    tos: u8,
    tot_len: u16,
    id: u16,
    frag_off: u16,
    ttl: u8,
    protocol: u8,
    check: u16,
    src_addr: u32,
    dst_addr: u32,
}

#[repr(C, packed)]
struct Ipv6Hdr {
    ver_tc_fl: u32,
    payload_len: u16,
    next_hdr: u8,
    hop_limit: u8,
    src_addr: [u8; 16],
    dst_addr: [u8; 16],
}

#[repr(C, packed)]
struct UdpHdr {
    src_port: u16,
    dst_port: u16,
    len: u16,
    check: u16,
}

const ETH_P_IP: u16 = 0x0800;
const ETH_P_IPV6: u16 = 0x86dd;
const ETH_P_8021Q: u16 = 0x8100;
const ETH_P_8021AD: u16 = 0x88a8;
const ETH_P_PPPOE: u16 = 0x8864;
const PPP_IPV4: u16 = 0x0021;
const PPP_IPV6: u16 = 0x0057;

#[derive(Clone, Copy)]
struct L2Info {
    proto: u16,
    ip_off: usize,
}

#[inline(always)]
fn read_u8(p: usize) -> u8 {
    unsafe { *(p as *const u8) }
}

#[inline(always)]
fn read_be16(p: usize) -> u16 {
    u16::from_be_bytes([read_u8(p), read_u8(p + 1)])
}

/// Parse the PPP protocol field (optional 0xff 0x03 address/control, optional
/// one-byte protocol compression). Returns the IP ethertype and header offset.
#[inline(always)]
fn parse_ppp(data: usize, data_end: usize, mut off: usize) -> Option<L2Info> {
    let _ = data;
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

/// Parse Ethernet, one/two VLAN tags, PPPoE session, or a bare PPP/IP frame.
/// l2_len is 0 for raw IP, 2 for PPP, 14 for Ethernet.
#[inline(always)]
fn parse_l2(data: usize, data_end: usize, l2_len: u32) -> Option<L2Info> {
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
            return parse_ppp(data, data_end, ip_off + 6);
        }
        if proto == ETH_P_IP || proto == ETH_P_IPV6 {
            return Some(L2Info { proto, ip_off });
        }
        return None;
    }

    if l2_len == 2 {
        return parse_ppp(data, data_end, data);
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

#[inline(always)]
fn now_ns() -> u64 {
    unsafe { bpf_ktime_get_coarse_ns() }
}

#[inline(always)]
fn is_multicast_or_broadcast_v4(raw_ip: u32) -> bool {
    let b = raw_ip.to_ne_bytes();
    b[0] == 0xff || (b[0] & 0xf0) == 0xe0
}

#[inline(always)]
fn is_link_local_v4(raw_ip: u32) -> bool {
    let b = raw_ip.to_ne_bytes();
    b[0] == 169 && b[1] == 254
}

/// DHCP client/relay and link-local/broadcast traffic must stay on the normal
/// firewall path. The nftables exemption is generated with the same guards.
#[inline(always)]
fn bypass_special_udp4(src: u32, dst: u32, sport: u16, dport: u16) -> bool {
    let sport = u16::from_be(sport);
    let dport = u16::from_be(dport);
    src == 0
        || sport == 67
        || sport == 68
        || dport == 67
        || dport == 68
        || is_multicast_or_broadcast_v4(dst)
        || is_link_local_v4(dst)
}

/// Fix up the IPv4 header and UDP checksums after an address/port rewrite.
/// Must be the last packet access: the helpers may linearize the skb.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn fixup_csum_v4(
    ctx: &TcContext,
    data: usize,
    ip_off: usize,
    udp_off: usize,
    old_ip: u32,
    new_ip: u32,
    old_port: u16,
    new_port: u16,
) -> bool {
    let l3_off = ip_off - data + IPV4_CSUM_OFFSET;
    let l4_off = udp_off - data + UDP_CSUM_OFFSET;

    ctx.skb
        .l3_csum_replace(l3_off, old_ip as u64, new_ip as u64, CSUM_FIELD_U32)
        .is_ok()
        && ctx
            .skb
            .l4_csum_replace(
                l4_off,
                old_ip as u64,
                new_ip as u64,
                BPF_F_PSEUDO_HDR | BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U32,
            )
            .is_ok()
        && ctx
            .skb
            .l4_csum_replace(
                l4_off,
                old_port as u64,
                new_port as u64,
                BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U16,
            )
            .is_ok()
}

/// Fix up only the IPv4 header checksum (non-first fragments have no UDP header).
#[inline(always)]
fn fixup_l3_v4(ctx: &TcContext, data: usize, ip_off: usize, old_ip: u32, new_ip: u32) -> bool {
    ctx.skb
        .l3_csum_replace(
            ip_off - data + IPV4_CSUM_OFFSET,
            old_ip as u64,
            new_ip as u64,
            CSUM_FIELD_U32,
        )
        .is_ok()
}

/// Fix up the UDP checksum for an IPv6 address/port rewrite.
#[inline(always)]
fn ipv6_eq(a: &[u8; 16], b: &[u8; 16]) -> bool {
    let p_a = a.as_ptr() as *const u64;
    let p_b = b.as_ptr() as *const u64;
    unsafe {
        core::ptr::read_unaligned(p_a) == core::ptr::read_unaligned(p_b)
            && core::ptr::read_unaligned(p_a.add(1)) == core::ptr::read_unaligned(p_b.add(1))
    }
}

#[inline(always)]
fn fixup_csum_v6(
    ctx: &TcContext,
    data: usize,
    udp_off: usize,
    old_ip: &[u8; 16],
    new_ip: &[u8; 16],
    old_port: u16,
    new_port: u16,
) -> bool {
    let l4_off = udp_off - data + UDP_CSUM_OFFSET;

    let p_old = old_ip.as_ptr() as *const u32;
    let p_new = new_ip.as_ptr() as *const u32;
    let mut i = 0;
    while i < 4 {
        let f = unsafe { core::ptr::read_unaligned(p_old.add(i)) };
        let t = unsafe { core::ptr::read_unaligned(p_new.add(i)) };
        if ctx
            .skb
            .l4_csum_replace(
                l4_off,
                f as u64,
                t as u64,
                BPF_F_PSEUDO_HDR | BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U32,
            )
            .is_err()
        {
            return false;
        }
        i += 1;
    }

    ctx.skb
        .l4_csum_replace(
            l4_off,
            old_port as u64,
            new_port as u64,
            BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U16,
        )
        .is_ok()
}

#[inline(always)]
fn push_event_v4(key: &EndpointKey4, port: u16) {
    let event = SessionEvent4 {
        key: *key,
        port,
        _pad: 0,
    };
    if SESSION_EVENTS_V4.push(event, 0).is_err() {
        let _ = GC_FLAGS.set(0, 1, 0);
    }
}

#[inline(always)]
fn push_event_v6(key: &EndpointKey6, port: u16) {
    let event = SessionEvent6 {
        key: *key,
        port,
        _pad: [0; 3],
    };
    if SESSION_EVENTS_V6.push(event, 0).is_err() {
        let _ = GC_FLAGS.set(0, 1, 0);
    }
}

#[inline(always)]
fn port_is_reserved(reserved: &Array<u8>, port: u16) -> bool {
    match reserved.get_ptr_mut(port as u32) {
        Some(p) => unsafe { *p != 0 },
        None => false,
    }
}

#[inline(always)]
fn port_state_clear(map: &Array<u8>, port: u16) {
    if let Some(p) = map.get_ptr_mut(port as u32) {
        unsafe {
            *p = 0;
        }
    }
}

#[inline(always)]
fn queue_push(q: &Queue<u16>, port: u16) {
    if q.push(port, 0).is_err() {
        let _ = PORT_FLAGS.set(0, 1, 0);
    }
}

#[inline(always)]
fn release_port_v4(port: u16) {
    if let Some(p) = PORT_FREE_V4.get_ptr_mut(port as u32) {
        unsafe {
            if *p != 0 {
                return;
            }
            *p = 1;
        }
    } else {
        return;
    }
    if (port & 1) == 0 {
        queue_push(&FREE_EVEN_V4, port);
    } else {
        queue_push(&FREE_ODD_V4, port);
    }
}

#[inline(always)]
fn release_port_v6(port: u16) {
    if let Some(p) = PORT_FREE_V6.get_ptr_mut(port as u32) {
        unsafe {
            if *p != 0 {
                return;
            }
            *p = 1;
        }
    } else {
        return;
    }
    if (port & 1) == 0 {
        queue_push(&FREE_EVEN_V6, port);
    } else {
        queue_push(&FREE_ODD_V6, port);
    }
}

#[inline(always)]
fn claim_port_v4(port: u16, in_val: &BindingValue4) -> bool {
    if port_is_reserved(&RESERVED_V4, port) {
        return false;
    }
    INBOUND_BINDINGS_V4
        .insert(port, in_val, BPF_NOEXIST)
        .is_ok()
}

#[inline(always)]
fn claim_port_v6(port: u16, in_val: &BindingValue6) -> bool {
    if port_is_reserved(&RESERVED_V6, port) {
        return false;
    }
    INBOUND_BINDINGS_V6
        .insert(port, in_val, BPF_NOEXIST)
        .is_ok()
}

#[inline(always)]
fn pop_and_claim_v4(
    q: &Queue<u16>,
    min: u16,
    max: u16,
    in_val: &BindingValue4,
) -> Result<Option<u16>, ()> {
    let port = match q.pop() {
        Ok(Some(port)) => port,
        _ => return Err(()),
    };
    port_state_clear(&PORT_FREE_V4, port);
    if port >= min && port <= max && claim_port_v4(port, in_val) {
        return Ok(Some(port));
    }
    Ok(None)
}

#[inline(always)]
fn pop_and_claim_v6(
    q: &Queue<u16>,
    min: u16,
    max: u16,
    in_val: &BindingValue6,
) -> Result<Option<u16>, ()> {
    let port = match q.pop() {
        Ok(Some(port)) => port,
        _ => return Err(()),
    };
    port_state_clear(&PORT_FREE_V6, port);
    if port >= min && port <= max && claim_port_v6(port, in_val) {
        return Ok(Some(port));
    }
    Ok(None)
}

#[inline(always)]
fn alloc_port_v4(pref: u16, min: u16, max: u16, in_val: &BindingValue4) -> Option<u16> {
    if pref >= min && pref <= max && claim_port_v4(pref, in_val) {
        return Some(pref);
    }
    let parity = pref & 1;
    let (q1, q2) = if parity == 0 {
        (&FREE_EVEN_V4, &FREE_ODD_V4)
    } else {
        (&FREE_ODD_V4, &FREE_EVEN_V4)
    };
    let mut i = 0;
    while i < 4 {
        match pop_and_claim_v4(q1, min, max, in_val) {
            Ok(Some(port)) => return Some(port),
            Ok(None) => {}
            Err(()) => break,
        }
        i += 1;
    }
    i = 0;
    while i < 2 {
        match pop_and_claim_v4(q2, min, max, in_val) {
            Ok(Some(port)) => return Some(port),
            Ok(None) => {}
            Err(()) => break,
        }
        i += 1;
    }
    None
}

#[inline(always)]
fn alloc_port_v6(pref: u16, min: u16, max: u16, in_val: &BindingValue6) -> Option<u16> {
    if pref >= min && pref <= max && claim_port_v6(pref, in_val) {
        return Some(pref);
    }
    let parity = pref & 1;
    let (q1, q2) = if parity == 0 {
        (&FREE_EVEN_V6, &FREE_ODD_V6)
    } else {
        (&FREE_ODD_V6, &FREE_EVEN_V6)
    };
    let mut i = 0;
    while i < 4 {
        match pop_and_claim_v6(q1, min, max, in_val) {
            Ok(Some(port)) => return Some(port),
            Ok(None) => {}
            Err(()) => break,
        }
        i += 1;
    }
    i = 0;
    while i < 2 {
        match pop_and_claim_v6(q2, min, max, in_val) {
            Ok(Some(port)) => return Some(port),
            Ok(None) => {}
            Err(()) => break,
        }
        i += 1;
    }
    None
}

#[derive(Clone, Copy)]
enum Ipv6L4 {
    Udp(usize),
    Fragment,
    NonUdp,
    Unsupported,
}

/// Walk IPv6 extension headers and locate the upper-layer header.
#[inline(always)]
fn locate_ipv6_l4(data_end: usize, ip_off: usize, mut nh: u8) -> Ipv6L4 {
    let mut cur_off = ip_off + 40;
    let mut iter = 0;
    while iter < 4 {
        if nh == IPPROTO_UDP {
            return Ipv6L4::Udp(cur_off);
        }
        if nh == IPPROTO_HOPOPTS || nh == IPPROTO_DSTOPTS {
            if cur_off + 2 > data_end {
                return Ipv6L4::NonUdp;
            }
            let ext = unsafe { &*(cur_off as *const [u8; 2]) };
            nh = ext[0];
            let ext_len = (ext[1] as usize + 1) * 8;
            if cur_off + ext_len > data_end {
                return Ipv6L4::NonUdp;
            }
            cur_off += ext_len;
        } else if nh == IPPROTO_ROUTING {
            return Ipv6L4::Unsupported;
        } else if nh == IPPROTO_FRAGMENT {
            return Ipv6L4::Fragment;
        } else {
            return Ipv6L4::NonUdp;
        }
        iter += 1;
    }

    if nh == IPPROTO_UDP {
        Ipv6L4::Udp(cur_off)
    } else {
        Ipv6L4::Unsupported
    }
}

#[classifier]
pub fn flowcone_tcx_ingress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let active = match ACTIVE_CONFIG.get(0) {
        Some(v) => *v & 1,
        None => 0,
    };
    let cfg = match CONFIG.get(active) {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };

    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }

    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    let ip_off = l2.ip_off;

    if l2.proto == ETH_P_IP && cfg.enabled_v4 == 1 {
        if ip_off + mem::size_of::<Ipv4Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv4Hdr) };
        if (iph.ver_ihl >> 4) != 4 {
            return TC_ACT_UNSPEC;
        }
        if iph.protocol == IPPROTO_ICMP {
            unsafe {
                ICMP_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_UNSPEC;
        }
        if iph.protocol != IPPROTO_UDP {
            return TC_ACT_UNSPEC;
        }
        if iph.dst_addr != cfg.wan_ip4 {
            return TC_ACT_UNSPEC;
        }

        let frag_off = u16::from_be(iph.frag_off);
        if (frag_off & 0x3fff) != 0 || (frag_off & 0x2000) != 0 {
            unsafe {
                FRAG_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_UNSPEC;
        }

        let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
        if ihl < 20 {
            return TC_ACT_UNSPEC;
        }
        let udp_off = ip_off + ihl;
        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        let ext_port = u16::from_be(udph.dst_port);

        if let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(ext_port) {
            let new_dst_ip = unsafe { (*target).ip };
            let new_dst_port = unsafe { (*target).port };
            let now = now_ns();
            unsafe {
                (*target).last_seen = now;
            }

            let old_dst_ip = iph.dst_addr;
            let old_dst_port = udph.dst_port;

            iph.dst_addr = new_dst_ip;
            udph.dst_port = new_dst_port;

            if !fixup_csum_v4(
                &ctx,
                data,
                ip_off,
                udp_off,
                old_dst_ip,
                new_dst_ip,
                old_dst_port,
                new_dst_port,
            ) {
                return TC_ACT_SHOT;
            }

            let mark = unsafe { (*ctx.skb.skb).mark };
            ctx.skb.set_mark(mark | cfg.flowcone_mark);
        }
    } else if l2.proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        let data = ctx.data();
        let data_end = ctx.data_end();
        if ip_off + mem::size_of::<Ipv6Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv6Hdr) };
        if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
            return TC_ACT_UNSPEC;
        }
        if !ipv6_eq(&iph.dst_addr, &cfg.wan_ip6) {
            return TC_ACT_UNSPEC;
        }
        if iph.next_hdr == 44 {
            unsafe {
                FRAG_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_UNSPEC;
        }
        if iph.next_hdr == 58 {
            unsafe {
                ICMP6_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_UNSPEC;
        }

        let udp_off = match locate_ipv6_l4(data_end, ip_off, iph.next_hdr) {
            Ipv6L4::Udp(off) => off,
            Ipv6L4::Fragment | Ipv6L4::NonUdp | Ipv6L4::Unsupported => {
                return TC_ACT_UNSPEC;
            }
        };

        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        if udph.check == 0 {
            return TC_ACT_UNSPEC;
        }

        let ext_port = u16::from_be(udph.dst_port);

        if let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(ext_port) {
            let new_dst_ip = unsafe { (*target).ip };
            let new_dst_port = unsafe { (*target).port };
            let now = now_ns();
            unsafe {
                (*target).last_seen = now;
            }

            let old_dst_ip = iph.dst_addr;
            let old_dst_port = udph.dst_port;

            iph.dst_addr = new_dst_ip;
            udph.dst_port = new_dst_port;

            if !fixup_csum_v6(
                &ctx,
                data,
                udp_off,
                &old_dst_ip,
                &new_dst_ip,
                old_dst_port,
                new_dst_port,
            ) {
                return TC_ACT_SHOT;
            }

            let mark = unsafe { (*ctx.skb.skb).mark };
            ctx.skb.set_mark(mark | cfg.flowcone_mark);
        }
    }

    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_egress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let active = match ACTIVE_CONFIG.get(0) {
        Some(v) => *v & 1,
        None => 0,
    };
    let cfg = match CONFIG.get(active) {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };

    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }

    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    let ip_off = l2.ip_off;

    if l2.proto == ETH_P_IP && cfg.enabled_v4 == 1 {
        if ip_off + mem::size_of::<Ipv4Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv4Hdr) };
        if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_UDP {
            return TC_ACT_UNSPEC;
        }

        let src_ip = iph.src_addr;
        if src_ip == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(src_ip) {
            return TC_ACT_UNSPEC;
        }

        let frag_off = u16::from_be(iph.frag_off);
        if (frag_off & 0x3fff) != 0 || (frag_off & 0x2000) != 0 {
            unsafe {
                FRAG_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_SHOT;
        }

        let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
        if ihl < 20 {
            return TC_ACT_UNSPEC;
        }
        let udp_off = ip_off + ihl;
        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_SHOT;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        let src_port = udph.src_port;

        if bypass_special_udp4(src_ip, iph.dst_addr, src_port, udph.dst_port) {
            return TC_ACT_UNSPEC;
        }

        let ep_key = EndpointKey4 {
            ip: src_ip,
            port: src_port,
            _pad: 0,
        };
        let now = now_ns();

        let mut mapped_port = None;
        if let Some(val) = OUTBOUND_BINDINGS_V4.get_ptr_mut(ep_key) {
            unsafe {
                if (*val).ip == cfg.wan_ip4 {
                    (*val).last_seen = now;
                    mapped_port = Some((*val).port);
                } else {
                    let old_port = u16::from_be((*val).port);
                    let _ = OUTBOUND_BINDINGS_V4.remove(ep_key);
                    if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(old_port)
                        && (*in_val).ip == src_ip
                        && (*in_val).port == src_port
                    {
                        let _ = INBOUND_BINDINGS_V4.remove(old_port);
                        release_port_v4(old_port);
                    }
                }
            }
        }

        let mapped_port = if let Some(p) = mapped_port {
            p
        } else {
            let pref = u16::from_be(src_port);
            let in_val = BindingValue4 {
                ip: src_ip,
                port: src_port,
                _pad: 0,
                last_seen: now,
            };
            let alloc = match alloc_port_v4(pref, cfg.min_port4, cfg.max_port4, &in_val) {
                Some(p) => p,
                None => return TC_ACT_SHOT,
            };
            let m_port = u16::to_be(alloc);
            let new_val = BindingValue4 {
                ip: cfg.wan_ip4,
                port: m_port,
                _pad: 0,
                last_seen: now,
            };
            if OUTBOUND_BINDINGS_V4
                .insert(ep_key, new_val, BPF_NOEXIST)
                .is_ok()
            {
                push_event_v4(&ep_key, alloc);
                m_port
            } else {
                let _ = INBOUND_BINDINGS_V4.remove(alloc);
                release_port_v4(alloc);
                match OUTBOUND_BINDINGS_V4.get_ptr_mut(ep_key) {
                    Some(val) => unsafe { (*val).port },
                    None => return TC_ACT_SHOT,
                }
            }
        };

        let old_src_ip = iph.src_addr;
        let new_src_ip = cfg.wan_ip4;

        iph.src_addr = new_src_ip;
        udph.src_port = mapped_port;

        if !fixup_csum_v4(
            &ctx,
            data,
            ip_off,
            udp_off,
            old_src_ip,
            new_src_ip,
            src_port,
            mapped_port,
        ) {
            return TC_ACT_SHOT;
        }
    } else if l2.proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        let data = ctx.data();
        let data_end = ctx.data_end();
        if ip_off + mem::size_of::<Ipv6Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv6Hdr) };
        if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
            return TC_ACT_UNSPEC;
        }
        if ipv6_eq(&iph.src_addr, &cfg.wan_ip6) {
            return TC_ACT_UNSPEC;
        }
        let allow_all_internal = cfg.enabled_v6 > 1;
        if !flowcone_common::is_routable_internal_ipv6(&iph.src_addr, allow_all_internal) {
            return TC_ACT_UNSPEC;
        }
        if iph.next_hdr == 44 {
            unsafe {
                FRAG_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_SHOT;
        }

        let udp_off = match locate_ipv6_l4(data_end, ip_off, iph.next_hdr) {
            Ipv6L4::Udp(off) => off,
            Ipv6L4::Fragment => {
                return TC_ACT_SHOT;
            }
            Ipv6L4::NonUdp => {
                return TC_ACT_UNSPEC;
            }
            Ipv6L4::Unsupported => {
                return TC_ACT_SHOT;
            }
        };

        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_SHOT;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        if udph.check == 0 {
            return TC_ACT_SHOT;
        }

        let src_addr = iph.src_addr;
        let src_port = udph.src_port;
        let ep_key = EndpointKey6 {
            ip: src_addr,
            port: src_port,
            _pad: [0; 3],
        };
        let now = now_ns();

        let mut mapped_port = None;
        if let Some(val) = OUTBOUND_BINDINGS_V6.get_ptr_mut(ep_key) {
            unsafe {
                if ipv6_eq(&(*val).ip, &cfg.wan_ip6) {
                    (*val).last_seen = now;
                    mapped_port = Some((*val).port);
                } else {
                    let old_port = u16::from_be((*val).port);
                    let _ = OUTBOUND_BINDINGS_V6.remove(ep_key);
                    if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(old_port)
                        && ipv6_eq(&(*in_val).ip, &src_addr)
                        && (*in_val).port == src_port
                    {
                        let _ = INBOUND_BINDINGS_V6.remove(old_port);
                        release_port_v6(old_port);
                    }
                }
            }
        }

        let mapped_port = if let Some(p) = mapped_port {
            p
        } else {
            let pref = u16::from_be(src_port);
            let in_val = BindingValue6 {
                ip: src_addr,
                port: src_port,
                _pad: [0; 3],
                last_seen: now,
            };
            let alloc = match alloc_port_v6(pref, cfg.min_port6, cfg.max_port6, &in_val) {
                Some(p) => p,
                None => return TC_ACT_SHOT,
            };
            let m_port = u16::to_be(alloc);
            let new_val = BindingValue6 {
                ip: cfg.wan_ip6,
                port: m_port,
                _pad: [0; 3],
                last_seen: now,
            };
            if OUTBOUND_BINDINGS_V6
                .insert(ep_key, new_val, BPF_NOEXIST)
                .is_ok()
            {
                push_event_v6(&ep_key, alloc);
                m_port
            } else {
                let _ = INBOUND_BINDINGS_V6.remove(alloc);
                release_port_v6(alloc);
                match OUTBOUND_BINDINGS_V6.get_ptr_mut(ep_key) {
                    Some(val) => unsafe { (*val).port },
                    None => return TC_ACT_SHOT,
                }
            }
        };

        let old_src_addr = iph.src_addr;
        let new_src_addr = cfg.wan_ip6;

        iph.src_addr = new_src_addr;
        udph.src_port = mapped_port;

        if !fixup_csum_v6(
            &ctx,
            data,
            udp_off,
            &old_src_addr,
            &new_src_addr,
            src_port,
            mapped_port,
        ) {
            return TC_ACT_SHOT;
        }
    }

    TC_ACT_UNSPEC
}

#[inline(always)]
fn read_be32(p: usize) -> u32 {
    u32::from_be_bytes([read_u8(p), read_u8(p + 1), read_u8(p + 2), read_u8(p + 3)])
}

#[inline(always)]
fn frag_v6_target(
    ctx: &TcContext,
    data: usize,
    data_end: usize,
    cfg: &GlobalConfig,
    ip_off: usize,
) -> i32 {
    if ip_off + 48 > data_end {
        return TC_ACT_UNSPEC;
    }
    let iph = unsafe { &mut *(ip_off as *mut Ipv6Hdr) };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 || iph.next_hdr != 44 {
        return TC_ACT_UNSPEC;
    }
    let next_hdr = unsafe { *((ip_off + 40) as *const u8) };
    if next_hdr != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    let frag_field = u16::from_be_bytes([unsafe { *((ip_off + 42) as *const u8) }, unsafe {
        *((ip_off + 43) as *const u8)
    }]);
    let offset = frag_field & 0xfff8;
    let more = (frag_field & 1) != 0;
    let id = read_be32(ip_off + 44);
    let ingress = ipv6_eq(&iph.dst_addr, &cfg.wan_ip6);
    let key = FragKey6 {
        src: iph.src_addr,
        dst: iph.dst_addr,
        id,
        proto: next_hdr,
        _pad: [0; 3],
    };
    let now = now_ns();

    if ingress {
        if offset != 0 {
            if let Some(v) = unsafe { FRAG_IN_V6.get(key) }
                && now.saturating_sub(v.last_seen) <= FRAG_TIMEOUT_NS
            {
                iph.dst_addr = v.ip;
                let mark = unsafe { (*ctx.skb.skb).mark };
                ctx.skb.set_mark(mark | cfg.flowcone_mark);
            }
            return TC_ACT_UNSPEC;
        }
        let udp_off = ip_off + 48;
        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }
        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        if udph.check == 0 {
            return TC_ACT_UNSPEC;
        }
        let ext_port = u16::from_be(udph.dst_port);
        let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(ext_port) else {
            return TC_ACT_UNSPEC;
        };
        let new_ip = unsafe { (*target).ip };
        let new_port = unsafe { (*target).port };
        unsafe {
            (*target).last_seen = now;
        }
        let old_ip = iph.dst_addr;
        let old_port = udph.dst_port;
        iph.dst_addr = new_ip;
        udph.dst_port = new_port;
        if !fixup_csum_v6(ctx, data, udp_off, &old_ip, &new_ip, old_port, new_port) {
            return TC_ACT_SHOT;
        }
        let value = FragValue6 {
            ip: new_ip,
            last_seen: now,
        };
        if more {
            let _ = FRAG_IN_V6.insert(key, value, BPF_ANY);
        }
        let mark = unsafe { (*ctx.skb.skb).mark };
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
        return TC_ACT_UNSPEC;
    }

    let src_ip = iph.src_addr;
    if ipv6_eq(&src_ip, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let allow_all_internal = cfg.enabled_v6 > 1;
    if !flowcone_common::is_routable_internal_ipv6(&src_ip, allow_all_internal) {
        return TC_ACT_UNSPEC;
    }
    if offset != 0 {
        let Some(v) = (unsafe { FRAG_OUT_V6.get(key) }) else {
            return TC_ACT_SHOT;
        };
        if now.saturating_sub(v.last_seen) > FRAG_TIMEOUT_NS {
            return TC_ACT_SHOT;
        }
        iph.src_addr = v.ip;
        let mark = unsafe { (*ctx.skb.skb).mark };
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
        return TC_ACT_UNSPEC;
    }
    let udp_off = ip_off + 48;
    if udp_off + mem::size_of::<UdpHdr>() > data_end {
        return TC_ACT_SHOT;
    }
    let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
    if udph.check == 0 {
        return TC_ACT_SHOT;
    }
    let src_port = udph.src_port;
    let ep_key = EndpointKey6 {
        ip: src_ip,
        port: src_port,
        _pad: [0; 3],
    };
    let mut mapped = None;
    if let Some(val) = OUTBOUND_BINDINGS_V6.get_ptr_mut(ep_key) {
        unsafe {
            if ipv6_eq(&(*val).ip, &cfg.wan_ip6) {
                (*val).last_seen = now;
                mapped = Some((*val).port);
            } else {
                let old_port = u16::from_be((*val).port);
                let _ = OUTBOUND_BINDINGS_V6.remove(ep_key);
                if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(old_port)
                    && ipv6_eq(&(*in_val).ip, &src_ip)
                    && (*in_val).port == src_port
                {
                    let _ = INBOUND_BINDINGS_V6.remove(old_port);
                    release_port_v6(old_port);
                }
            }
        }
    }
    let mapped = if let Some(p) = mapped {
        p
    } else {
        let pref = u16::from_be(src_port);
        let in_val = BindingValue6 {
            ip: src_ip,
            port: src_port,
            _pad: [0; 3],
            last_seen: now,
        };
        let alloc = match alloc_port_v6(pref, cfg.min_port6, cfg.max_port6, &in_val) {
            Some(p) => p,
            None => return TC_ACT_SHOT,
        };
        let m_port = u16::to_be(alloc);
        let new_val = BindingValue6 {
            ip: cfg.wan_ip6,
            port: m_port,
            _pad: [0; 3],
            last_seen: now,
        };
        if OUTBOUND_BINDINGS_V6
            .insert(ep_key, new_val, BPF_NOEXIST)
            .is_ok()
        {
            push_event_v6(&ep_key, alloc);
            m_port
        } else {
            let _ = INBOUND_BINDINGS_V6.remove(alloc);
            release_port_v6(alloc);
            match OUTBOUND_BINDINGS_V6.get_ptr_mut(ep_key) {
                Some(val) => unsafe { (*val).port },
                None => return TC_ACT_SHOT,
            }
        }
    };
    let old_src = iph.src_addr;
    let old_sport = udph.src_port;
    iph.src_addr = cfg.wan_ip6;
    udph.src_port = mapped;
    if !fixup_csum_v6(
        ctx,
        data,
        udp_off,
        &old_src,
        &cfg.wan_ip6,
        old_sport,
        mapped,
    ) {
        return TC_ACT_SHOT;
    }
    let value = FragValue6 {
        ip: cfg.wan_ip6,
        last_seen: now,
    };
    if more {
        let _ = FRAG_OUT_V6.insert(key, value, BPF_ANY);
    }
    let mark = unsafe { (*ctx.skb.skb).mark };
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// IPv4 fragment NAT target. Called by the main target through FRAG_TARGET.
/// First fragments create/use the normal UDP mapping; non-first fragments use
/// the fragment cache. Out-of-order non-first fragments are passed/dropped
/// until the first fragment teaches the cache.
#[classifier]
pub fn flowcone_frag_target(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let active = match ACTIVE_CONFIG.get(0) {
        Some(v) => *v & 1,
        None => 0,
    };
    let cfg = match CONFIG.get(active) {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }
    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    if l2.proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        return frag_v6_target(&ctx, data, data_end, cfg, l2.ip_off);
    }
    if l2.proto != ETH_P_IP || cfg.enabled_v4 != 1 {
        return TC_ACT_UNSPEC;
    }
    let ip_off = l2.ip_off;
    if ip_off + mem::size_of::<Ipv4Hdr>() > data_end {
        return TC_ACT_UNSPEC;
    }
    let iph = unsafe { &mut *(ip_off as *mut Ipv4Hdr) };
    if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    let frag_off = u16::from_be(iph.frag_off);
    let offset = frag_off & 0x1fff;
    let more = (frag_off & 0x2000) != 0;
    let ingress = iph.dst_addr == cfg.wan_ip4;

    if ingress {
        if offset != 0 {
            let key = FragKey4 {
                src: iph.src_addr,
                dst: iph.dst_addr,
                id: iph.id,
                proto: IPPROTO_UDP,
                _pad: 0,
            };
            let now = now_ns();
            if let Some(v) = unsafe { FRAG_IN_V4.get(key) }
                && now.saturating_sub(v.last_seen) <= FRAG_TIMEOUT_NS
            {
                let old = iph.dst_addr;
                iph.dst_addr = v.ip;
                if !fixup_l3_v4(&ctx, data, ip_off, old, v.ip) {
                    return TC_ACT_SHOT;
                }
                let mark = unsafe { (*ctx.skb.skb).mark };
                ctx.skb.set_mark(mark | cfg.flowcone_mark);
            }
            return TC_ACT_UNSPEC;
        }
        if !more {
            return TC_ACT_UNSPEC;
        }
        let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
        if ihl < 20 {
            return TC_ACT_UNSPEC;
        }
        let udp_off = ip_off + ihl;
        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }
        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        let ext_port = u16::from_be(udph.dst_port);
        let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(ext_port) else {
            return TC_ACT_UNSPEC;
        };
        let new_dst_ip = unsafe { (*target).ip };
        let new_dst_port = unsafe { (*target).port };
        let now = now_ns();
        unsafe {
            (*target).last_seen = now;
        }
        let key = FragKey4 {
            src: iph.src_addr,
            dst: iph.dst_addr,
            id: iph.id,
            proto: IPPROTO_UDP,
            _pad: 0,
        };
        let old_dst_ip = iph.dst_addr;
        let old_dst_port = udph.dst_port;
        iph.dst_addr = new_dst_ip;
        udph.dst_port = new_dst_port;
        if !fixup_csum_v4(
            &ctx,
            data,
            ip_off,
            udp_off,
            old_dst_ip,
            new_dst_ip,
            old_dst_port,
            new_dst_port,
        ) {
            return TC_ACT_SHOT;
        }
        let value = FragValue4 {
            ip: new_dst_ip,
            _pad: 0,
            last_seen: now,
        };
        if more {
            let _ = FRAG_IN_V4.insert(key, value, BPF_ANY);
        }
        let mark = unsafe { (*ctx.skb.skb).mark };
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
        return TC_ACT_UNSPEC;
    }

    // Egress direction.
    let src_ip = iph.src_addr;
    if src_ip == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(src_ip) {
        return TC_ACT_UNSPEC;
    }
    if offset != 0 {
        let key = FragKey4 {
            src: iph.src_addr,
            dst: iph.dst_addr,
            id: iph.id,
            proto: IPPROTO_UDP,
            _pad: 0,
        };
        let now = now_ns();
        let Some(v) = (unsafe { FRAG_OUT_V4.get(key) }) else {
            return TC_ACT_SHOT;
        };
        if now.saturating_sub(v.last_seen) > FRAG_TIMEOUT_NS {
            return TC_ACT_SHOT;
        }
        let old = iph.src_addr;
        iph.src_addr = v.ip;
        if !fixup_l3_v4(&ctx, data, ip_off, old, v.ip) {
            return TC_ACT_SHOT;
        }
        let mark = unsafe { (*ctx.skb.skb).mark };
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
        return TC_ACT_UNSPEC;
    }
    if !more {
        return TC_ACT_UNSPEC;
    }
    let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
    if ihl < 20 {
        return TC_ACT_UNSPEC;
    }
    let udp_off = ip_off + ihl;
    if udp_off + mem::size_of::<UdpHdr>() > data_end {
        return TC_ACT_SHOT;
    }
    let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
    let src_port = udph.src_port;
    if bypass_special_udp4(src_ip, iph.dst_addr, src_port, udph.dst_port) {
        return TC_ACT_UNSPEC;
    }
    let now = now_ns();
    let ep_key = EndpointKey4 {
        ip: src_ip,
        port: src_port,
        _pad: 0,
    };
    let mut mapped = None;
    if let Some(val) = OUTBOUND_BINDINGS_V4.get_ptr_mut(ep_key) {
        unsafe {
            if (*val).ip == cfg.wan_ip4 {
                (*val).last_seen = now;
                mapped = Some((*val).port);
            } else {
                let old_port = u16::from_be((*val).port);
                let _ = OUTBOUND_BINDINGS_V4.remove(ep_key);
                if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(old_port)
                    && (*in_val).ip == src_ip
                    && (*in_val).port == src_port
                {
                    let _ = INBOUND_BINDINGS_V4.remove(old_port);
                    release_port_v4(old_port);
                }
            }
        }
    }
    let mapped = if let Some(p) = mapped {
        p
    } else {
        let pref = u16::from_be(src_port);
        let in_val = BindingValue4 {
            ip: src_ip,
            port: src_port,
            _pad: 0,
            last_seen: now,
        };
        let alloc = match alloc_port_v4(pref, cfg.min_port4, cfg.max_port4, &in_val) {
            Some(p) => p,
            None => return TC_ACT_SHOT,
        };
        let m_port = u16::to_be(alloc);
        let new_val = BindingValue4 {
            ip: cfg.wan_ip4,
            port: m_port,
            _pad: 0,
            last_seen: now,
        };
        if OUTBOUND_BINDINGS_V4
            .insert(ep_key, new_val, BPF_NOEXIST)
            .is_ok()
        {
            push_event_v4(&ep_key, alloc);
            m_port
        } else {
            let _ = INBOUND_BINDINGS_V4.remove(alloc);
            release_port_v4(alloc);
            match OUTBOUND_BINDINGS_V4.get_ptr_mut(ep_key) {
                Some(val) => unsafe { (*val).port },
                None => return TC_ACT_SHOT,
            }
        }
    };
    let key = FragKey4 {
        src: src_ip,
        dst: iph.dst_addr,
        id: iph.id,
        proto: IPPROTO_UDP,
        _pad: 0,
    };
    let old_src = iph.src_addr;
    let old_sport = udph.src_port;
    iph.src_addr = cfg.wan_ip4;
    udph.src_port = mapped;
    if !fixup_csum_v4(
        &ctx,
        data,
        ip_off,
        udp_off,
        old_src,
        cfg.wan_ip4,
        old_sport,
        mapped,
    ) {
        return TC_ACT_SHOT;
    }
    let value = FragValue4 {
        ip: cfg.wan_ip4,
        _pad: 0,
        last_seen: now,
    };
    let _ = FRAG_OUT_V4.insert(key, value, BPF_ANY);
    let mark = unsafe { (*ctx.skb.skb).mark };
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

#[inline(always)]
fn csum_fold(mut sum: u32) -> u16 {
    let mut i = 0;
    while i < 3 {
        sum = (sum & 0xffff) + (sum >> 16);
        i += 1;
    }
    !(sum as u16)
}

#[inline(always)]
fn csum_replace(csum: u16, old: u16, new: u16) -> u16 {
    let mut sum = (!csum as u32) + (!old as u32) + new as u32;
    let mut i = 0;
    while i < 3 {
        sum = (sum & 0xffff) + (sum >> 16);
        i += 1;
    }
    !(sum as u16)
}

/// IPv4 ICMP error translation target. Rewrites the outer destination and the
/// embedded UDP source using the inbound mapping, then updates the embedded
/// IPv4/UDP and outer ICMP checksums.
#[classifier]
pub fn flowcone_icmp_target(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let active = match ACTIVE_CONFIG.get(0) {
        Some(v) => *v & 1,
        None => 0,
    };
    let cfg = match CONFIG.get(active) {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }
    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    if l2.proto != ETH_P_IP || cfg.enabled_v4 != 1 {
        return TC_ACT_UNSPEC;
    }
    let ip_off = l2.ip_off;
    if ip_off + mem::size_of::<Ipv4Hdr>() + 8 > data_end {
        return TC_ACT_UNSPEC;
    }
    let iph = unsafe { &mut *(ip_off as *mut Ipv4Hdr) };
    let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
    if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_ICMP || ihl != 20 {
        return TC_ACT_UNSPEC;
    }
    if iph.dst_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    let icmp_off = ip_off + 20;
    let tot_len = u16::from_be(iph.tot_len) as usize;
    if tot_len < 56 || icmp_off + 36 > data_end {
        return TC_ACT_UNSPEC;
    }
    let icmp_len = tot_len - 20;
    let icmph = unsafe { &mut *(icmp_off as *mut [u8; 8]) };
    let ty = icmph[0];
    if ty != 3 && ty != 11 && ty != 12 {
        return TC_ACT_UNSPEC;
    }
    let emb_off = icmp_off + 8;
    if emb_off + 28 > data_end {
        return TC_ACT_UNSPEC;
    }
    let emb = unsafe { &mut *(emb_off as *mut Ipv4Hdr) };
    if (emb.ver_ihl >> 4) != 4 || emb.protocol != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    if emb.src_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    if (emb.ver_ihl & 0x0f) != 5 {
        return TC_ACT_UNSPEC;
    }
    let emb_udp = emb_off + 20;
    if emb_udp + mem::size_of::<UdpHdr>() > icmp_off + icmp_len {
        return TC_ACT_UNSPEC;
    }
    if emb_udp + mem::size_of::<UdpHdr>() > data_end {
        return TC_ACT_UNSPEC;
    }
    let udph = unsafe { &mut *(emb_udp as *mut UdpHdr) };
    let ext_port = u16::from_be(udph.src_port);
    let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let new_ip = unsafe { (*target).ip };
    let new_port = unsafe { (*target).port };
    let now = now_ns();
    unsafe {
        (*target).last_seen = now;
    }

    let old_emb_src = emb.src_addr;
    let old_emb_check = emb.check;
    let old_emb_sport = udph.src_port;
    let old_udp_csum = udph.check;
    iph.dst_addr = new_ip;
    emb.src_addr = new_ip;
    udph.src_port = new_port;

    // Embedded IPv4 header checksum.
    emb.check = 0;
    let mut sum = 0u32;
    let mut i = 0usize;
    while i < 10 {
        let p = (emb_off + i * 2) as *const u8;
        let w = u16::from_be_bytes([unsafe { *p }, unsafe { *p.add(1) }]);
        sum += w as u32;
        i += 1;
    }
    emb.check = u16::to_be(csum_fold(sum));

    // Embedded UDP checksum: only the pseudo-header source and source port changed.
    let new_udp_csum = if old_udp_csum != 0 {
        let mut c = u16::from_be(old_udp_csum);
        let ob = old_emb_src.to_ne_bytes();
        let nb = new_ip.to_ne_bytes();
        c = csum_replace(
            c,
            u16::from_be_bytes([ob[0], ob[1]]),
            u16::from_be_bytes([nb[0], nb[1]]),
        );
        c = csum_replace(
            c,
            u16::from_be_bytes([ob[2], ob[3]]),
            u16::from_be_bytes([nb[2], nb[3]]),
        );
        c = csum_replace(c, u16::from_be(old_emb_sport), u16::from_be(new_port));
        if c == 0 { 0xffff } else { u16::to_be(c) }
    } else {
        0
    };
    udph.check = new_udp_csum;

    // Outer ICMP checksum: update it from the changed embedded fields. This
    // avoids scanning a variable-length ICMP payload in eBPF.
    let icmp_csum_off = icmp_off - data + 2;
    let new_emb_check = emb.check;
    if ctx
        .skb
        .l4_csum_replace(
            icmp_csum_off,
            old_emb_src as u64,
            new_ip as u64,
            CSUM_FIELD_U32,
        )
        .is_err()
        || ctx
            .skb
            .l4_csum_replace(
                icmp_csum_off,
                old_emb_check as u64,
                new_emb_check as u64,
                CSUM_FIELD_U16,
            )
            .is_err()
        || ctx
            .skb
            .l4_csum_replace(
                icmp_csum_off,
                old_emb_sport as u64,
                new_port as u64,
                CSUM_FIELD_U16,
            )
            .is_err()
        || ctx
            .skb
            .l4_csum_replace(
                icmp_csum_off,
                old_udp_csum as u64,
                new_udp_csum as u64,
                CSUM_FIELD_U16,
            )
            .is_err()
    {
        return TC_ACT_SHOT;
    }

    if !fixup_l3_v4(&ctx, data, ip_off, cfg.wan_ip4, new_ip) {
        return TC_ACT_SHOT;
    }
    let mark = unsafe { (*ctx.skb.skb).mark };
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Tiny TCX dispatchers. They are the only attached links; A/B differ only by
/// program id so both can coexist during a zero-gap tail move. The target
/// program is idempotent, so both dispatchers may run it for one packet while
/// the handoff is in progress.
#[classifier]
pub fn flowcone_tcx_ingress_a(ctx: TcContext) -> i32 {
    unsafe {
        INGRESS_TARGET.tail_call(&ctx, 0);
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_ingress_b(ctx: TcContext) -> i32 {
    unsafe {
        INGRESS_TARGET.tail_call(&ctx, 0);
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_egress_a(ctx: TcContext) -> i32 {
    unsafe {
        EGRESS_TARGET.tail_call(&ctx, 0);
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_egress_b(ctx: TcContext) -> i32 {
    unsafe {
        EGRESS_TARGET.tail_call(&ctx, 0);
    }
    TC_ACT_UNSPEC
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { core::hint::unreachable_unchecked() }
}

#[classifier]
pub fn flowcone_icmp6_target(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let active = match ACTIVE_CONFIG.get(0) {
        Some(v) => *v & 1,
        None => 0,
    };
    let cfg = match CONFIG.get(active) {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }
    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    if l2.proto != ETH_P_IPV6 {
        return TC_ACT_UNSPEC;
    }
    let ip_off = l2.ip_off;
    if ip_off + 96 > data_end {
        return TC_ACT_UNSPEC;
    }
    let iph = unsafe { &mut *(ip_off as *mut Ipv6Hdr) };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6
        || iph.next_hdr != 58
        || !ipv6_eq(&iph.dst_addr, &cfg.wan_ip6)
    {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph.payload_len) as usize;
    if payload_len < 56 {
        return TC_ACT_UNSPEC;
    }
    let icmp_off = ip_off + 40;
    let ty = read_u8(icmp_off);
    if ty != 1 && ty != 2 && ty != 3 && ty != 4 {
        return TC_ACT_UNSPEC;
    }
    let emb_off = icmp_off + 8;
    if emb_off + 48 > data_end {
        return TC_ACT_UNSPEC;
    }
    let emb = unsafe { &mut *(emb_off as *mut Ipv6Hdr) };
    if (u32::from_be(emb.ver_tc_fl) >> 28) != 6
        || emb.next_hdr != IPPROTO_UDP
        || !ipv6_eq(&emb.src_addr, &cfg.wan_ip6)
    {
        return TC_ACT_UNSPEC;
    }
    let udp_off = emb_off + 40;
    let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
    let ext_port = u16::from_be(udph.src_port);
    let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let new_ip = unsafe { (*target).ip };
    let new_port = unsafe { (*target).port };
    unsafe {
        (*target).last_seen = now_ns();
    }

    let old_ip = emb.src_addr;
    let old_outer_dst = iph.dst_addr;
    let old_port = udph.src_port;
    let old_udp_csum = udph.check;
    let new_udp_csum = if old_udp_csum == 0 {
        0
    } else {
        let mut c = u16::from_be(old_udp_csum);
        let mut i = 0usize;
        while i < 8 {
            let os = u16::from_be_bytes([old_ip[i * 2], old_ip[i * 2 + 1]]);
            let ns = u16::from_be_bytes([new_ip[i * 2], new_ip[i * 2 + 1]]);
            c = csum_replace(c, os, ns);
            i += 1;
        }
        c = csum_replace(c, u16::from_be(old_port), u16::from_be(new_port));
        if c == 0 { 0xffff } else { u16::to_be(c) }
    };

    iph.dst_addr = new_ip;
    emb.src_addr = new_ip;
    udph.src_port = new_port;
    udph.check = new_udp_csum;

    let icmp_csum_off = icmp_off - data + 2;
    let mut i = 0usize;
    while i < 4 {
        let oo = u32::from_ne_bytes([
            old_outer_dst[i * 4],
            old_outer_dst[i * 4 + 1],
            old_outer_dst[i * 4 + 2],
            old_outer_dst[i * 4 + 3],
        ]);
        let no = u32::from_ne_bytes([
            new_ip[i * 4],
            new_ip[i * 4 + 1],
            new_ip[i * 4 + 2],
            new_ip[i * 4 + 3],
        ]);
        let os = u32::from_ne_bytes([
            old_ip[i * 4],
            old_ip[i * 4 + 1],
            old_ip[i * 4 + 2],
            old_ip[i * 4 + 3],
        ]);
        if ctx
            .skb
            .l4_csum_replace(
                icmp_csum_off,
                oo as u64,
                no as u64,
                BPF_F_PSEUDO_HDR | CSUM_FIELD_U32,
            )
            .is_err()
        {
            return TC_ACT_SHOT;
        }
        if ctx
            .skb
            .l4_csum_replace(icmp_csum_off, os as u64, no as u64, CSUM_FIELD_U32)
            .is_err()
        {
            return TC_ACT_SHOT;
        }
        i += 1;
    }
    if ctx
        .skb
        .l4_csum_replace(
            icmp_csum_off,
            old_port as u64,
            new_port as u64,
            CSUM_FIELD_U16,
        )
        .is_err()
        || ctx
            .skb
            .l4_csum_replace(
                icmp_csum_off,
                old_udp_csum as u64,
                new_udp_csum as u64,
                CSUM_FIELD_U16,
            )
            .is_err()
    {
        return TC_ACT_SHOT;
    }
    let mark = unsafe { (*ctx.skb.skb).mark };
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}
