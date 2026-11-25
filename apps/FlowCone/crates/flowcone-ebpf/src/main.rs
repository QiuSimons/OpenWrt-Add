#![no_std]
#![no_main]
#![feature(asm_experimental_arch)]
// `#[classifier]` expands to a `pub extern "C" fn(*mut __sk_buff)` wrapper that
// calls `TcContext::from_ptr`.
#![allow(clippy::not_unsafe_ptr_arg_deref)]

mod engine;
mod parsing;

use aya_ebpf::{
    EbpfContext,
    bindings::{__sk_buff, BPF_F_RECOMPUTE_CSUM, TC_ACT_SHOT, TC_ACT_UNSPEC},
    helpers::bpf_get_smp_processor_id,
    macros::{classifier, map},
    maps::{Array, HashMap, LruHashMap, PerCpuArray, ProgramArray, RingBuf},
    programs::TcContext,
};
use core::mem;
use flowcone_common::{
    BindingValue4, BindingValue6, ETH_P_IP, ETH_P_IPV6, EndpointKey4, EndpointKey6,
    FRAG_MAP_ENTRIES, FragKey4, FragKey6, FragValue4, FragValue6, GlobalConfig, IPPROTO_DSTOPTS,
    IPPROTO_FRAGMENT, IPPROTO_ICMP, IPPROTO_ICMPV6, IPPROTO_UDP, MAX_BINDINGS, PORT_BITMAP_SLOTS,
    PORT_STATE_ENTRIES, SESSION_EVENT_RINGBUF_BYTES, csum_replace, format_wan_frag_id,
    format_wan_ip_id,
};

use engine::{
    fixup_csum_v4, fixup_csum_v6, fixup_l3_id_v4, fixup_l3_v4, get_or_create_mapping_v4,
    get_or_create_mapping_v6, ipv6_addr_diff, is_short_lived_port, lookup_inbound_v4,
    lookup_inbound_v6, lookup_outbound_v4, lookup_outbound_v6, now_sec, port_reserved_state,
};
use parsing::{
    FragExtHdr, Ipv4Hdr, Ipv6Hdr, Ipv6L4, L2Info, UdpHdr, bypass_special_udp4, bypass_special_udp6,
    copy_ipv6, ensure_linear, ipv6_eq, ipv6_fragment_offset, locate_ipv6_l4, locate_ipv6_nexthdr,
    parse_header_ref_mut, parse_l2, pull_up_to,
};

pub const BPF_F_PSEUDO_HDR: u64 = 0x10;
pub const BPF_F_MARK_MANGLED_0: u64 = 0x20;
pub const BPF_F_IPV6: u64 = 0x80;
pub const CSUM_FIELD_U16: u64 = 2;
pub const CSUM_FIELD_U32: u64 = 4;
pub const IPV4_CSUM_OFFSET: usize = 10;
pub const UDP_CSUM_OFFSET: usize = 6;

pub const BPF_ANY: u64 = 0;
pub const BPF_NOEXIST: u64 = 1;
pub const BPF_F_NO_COMMON_LRU: u32 = 2;

pub const FRAG_TIMEOUT_SEC: u32 = 10;
pub const LAST_SEEN_INTERVAL_SEC: u32 = 1;

pub const TARGET_INGRESS: u32 = 0;
pub const TARGET_EGRESS: u32 = 1;

pub const TARGET_DISPATCH: u32 = 0;
pub const TARGET_FAMILY_V4: u32 = 1;
pub const TARGET_FAMILY_V6: u32 = 2;

pub const TARGET_ALLOC_V4: u32 = 0;
pub const TARGET_ALLOC_V6: u32 = 1;
pub const TARGET_FRAG_EGRESS_ALLOC: u32 = 2;

#[unsafe(link_section = "license")]
#[used]
static LICENSE: [u8; 4] = *b"GPL\0";

#[inline(always)]
fn get_mark(ctx: &TcContext) -> u32 {
    unsafe { (*(ctx.as_ptr() as *const __sk_buff)).mark }
}

#[inline(always)]
fn prepare_packet(ctx: &TcContext) -> Option<(&'static GlobalConfig, L2Info)> {
    let cfg = get_config()?;
    if cfg.bypass_mark_mask != 0 && (get_mark(ctx) & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
        return None;
    }
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    // Linearize up to L2 + VLAN/PPPoE headers without comparing pointers via
    // subtraction.
    let min_l2 = if cfg.l2_len == 14 { 32 } else { 2 };
    pull_up_to(ctx, &mut data, &mut data_end, min_l2);
    let l2 = unsafe { parse_l2(data, data_end, cfg.l2_len) }?;
    Some((cfg, l2))
}

/// Double-buffered config: ACTIVE_CONFIG selects one of two immutable slots.
#[map]
pub static CONFIG: Array<GlobalConfig> = Array::with_max_entries(2, 0);

#[map]
pub static ACTIVE_CONFIG: Array<u32> = Array::with_max_entries(1, 0);

#[inline(always)]
pub fn get_config() -> Option<&'static GlobalConfig> {
    let active = *ACTIVE_CONFIG.get(0)? & 1;
    CONFIG.get(active)
}

/// Tail-call targets for TC dispatchers. Slots `[0, 1, 2]` correspond to
/// `[TARGET_DISPATCH, TARGET_FAMILY_V4, TARGET_FAMILY_V6]`.
#[map]
pub static INGRESS_TARGET: ProgramArray = ProgramArray::with_max_entries(3, 0);
#[map]
pub static EGRESS_TARGET: ProgramArray = ProgramArray::with_max_entries(3, 0);
/// Slow-path outbound port allocation tail-call targets `[TARGET_ALLOC_V4,
/// TARGET_ALLOC_V6]`.
#[map]
pub static EGRESS_ALLOC_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);
#[map]
pub static FRAG_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);
#[map]
pub static FRAG6_TARGET: ProgramArray = ProgramArray::with_max_entries(3, 0);
#[map]
pub static ICMP_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);
#[map]
pub static ICMP6_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);

#[map]
pub static WAN_IP_ID: PerCpuArray<u32> = PerCpuArray::with_max_entries(1, 0);
#[map]
pub static WAN_FRAG_ID: PerCpuArray<u32> = PerCpuArray::with_max_entries(1, 0);
/// Per-CPU handoff (`ip_rel | (udp_rel << 16) | (frag_rel << 32)`) across
/// egress allocation tail calls.
#[map]
pub static EGRESS_SCRATCH: PerCpuArray<u64> = PerCpuArray::with_max_entries(1, 0);
#[inline(always)]
pub fn alloc_wan_ip_id() -> u16 {
    let cpu = unsafe { bpf_get_smp_processor_id() };
    if let Some(ptr) = WAN_IP_ID.get_ptr_mut(0) {
        unsafe {
            let next = (*ptr).wrapping_add(1);
            *ptr = next;
            format_wan_ip_id(next, cpu)
        }
    } else {
        format_wan_ip_id(0, cpu)
    }
}

#[inline(always)]
pub fn alloc_wan_frag_id() -> u32 {
    let cpu = unsafe { bpf_get_smp_processor_id() };
    if let Some(ptr) = WAN_FRAG_ID.get_ptr_mut(0) {
        unsafe {
            let next = (*ptr).wrapping_add(1);
            *ptr = next;
            format_wan_frag_id(next, cpu)
        }
    } else {
        format_wan_frag_id(0, cpu)
    }
}

#[map]
pub static FRAG_IN_V4: LruHashMap<FragKey4, FragValue4> =
    LruHashMap::with_max_entries(FRAG_MAP_ENTRIES, BPF_F_NO_COMMON_LRU);
#[map]
pub static FRAG_OUT_V4: LruHashMap<FragKey4, FragValue4> =
    LruHashMap::with_max_entries(FRAG_MAP_ENTRIES, BPF_F_NO_COMMON_LRU);

#[map]
pub static FRAG_IN_V6: LruHashMap<FragKey6, FragValue6> =
    LruHashMap::with_max_entries(FRAG_MAP_ENTRIES, BPF_F_NO_COMMON_LRU);
#[map]
pub static FRAG_OUT_V6: LruHashMap<FragKey6, FragValue6> =
    LruHashMap::with_max_entries(FRAG_MAP_ENTRIES, BPF_F_NO_COMMON_LRU);

#[map]
pub static OUTBOUND_BINDINGS_V4: HashMap<EndpointKey4, BindingValue4> =
    HashMap::with_max_entries(MAX_BINDINGS, 0);

#[map]
pub static INBOUND_BINDINGS_V4: HashMap<u16, BindingValue4> =
    HashMap::with_max_entries(MAX_BINDINGS, 0);

#[map]
pub static OUTBOUND_BINDINGS_V6: HashMap<EndpointKey6, BindingValue6> =
    HashMap::with_max_entries(MAX_BINDINGS, 0);

#[map]
pub static INBOUND_BINDINGS_V6: HashMap<u16, BindingValue6> =
    HashMap::with_max_entries(MAX_BINDINGS, 0);

/// Session creation ring buffers consumed by daemon.
#[map]
pub static SESSION_EVENTS_V4: RingBuf = RingBuf::with_byte_size(SESSION_EVENT_RINGBUF_BYTES, 0);

#[map]
pub static SESSION_EVENTS_V6: RingBuf = RingBuf::with_byte_size(SESSION_EVENT_RINGBUF_BYTES, 0);

#[map]
pub static GC_FLAGS: Array<u32> = Array::with_max_entries(1, 0);

/// Reservation epoch state array (`bit 0` = reserved, bits `1..=15` = epoch)
/// for host UDP ports.
#[map]
pub static RESERVED_V4: Array<u16> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

#[map]
pub static RESERVED_V6: Array<u16> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

const BPF_F_MMAPABLE: u32 = 0x400;

/// Port allocation parity bitmaps (512 * 64 = 32768 ports per parity).
/// BPF_F_MMAPABLE enables userspace atomic operations via mmap.
#[map]
pub static BITMAP_EVEN_V4: Array<u64> = Array::with_max_entries(PORT_BITMAP_SLOTS, BPF_F_MMAPABLE);

#[map]
pub static BITMAP_ODD_V4: Array<u64> = Array::with_max_entries(PORT_BITMAP_SLOTS, BPF_F_MMAPABLE);

#[map]
pub static BITMAP_EVEN_V6: Array<u64> = Array::with_max_entries(PORT_BITMAP_SLOTS, BPF_F_MMAPABLE);

#[map]
pub static BITMAP_ODD_V6: Array<u64> = Array::with_max_entries(PORT_BITMAP_SLOTS, BPF_F_MMAPABLE);

#[map]
pub static PORT_FLAGS: Array<u32> = Array::with_max_entries(1, 0);

#[inline(always)]
fn parse_ipv4_hdr_bounds(
    ctx: &TcContext,
    data: &mut usize,
    data_end: &mut usize,
    ip_rel: usize,
) -> Option<(usize, u8, u16, u16, u32, u32)> {
    if !ensure_linear(ctx, data, data_end, ip_rel + 20) {
        return None;
    }
    let iph = unsafe { parse_header_ref_mut::<Ipv4Hdr>(*data + ip_rel, *data_end) }?;
    if (iph.ver_ihl >> 4) != 4 {
        return None;
    }
    let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
    if ihl < 20 {
        return None;
    }
    let tot_len = u16::from_be(iph.tot_len) as usize;
    if tot_len < ihl {
        return None;
    }
    Some((
        ihl,
        iph.protocol,
        u16::from_be(iph.frag_off),
        tot_len as u16,
        iph.src_addr,
        iph.dst_addr,
    ))
}

#[inline(always)]
fn locate_ipv6_udp_and_validate(
    ctx: &TcContext,
    data: &mut usize,
    data_end: &mut usize,
    ip_rel: usize,
    icmp_target_idx: u32,
    frag_target_idx: u32,
) -> Option<(usize, usize)> {
    if !ensure_linear(ctx, data, data_end, ip_rel + 40) {
        return None;
    }
    let iph = unsafe { parse_header_ref_mut::<Ipv6Hdr>(*data + ip_rel, *data_end) }?;
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
        return None;
    }
    let payload_len = u16::from_be(iph.payload_len) as usize;
    let nh = iph.next_hdr;
    if nh == IPPROTO_UDP {
        return Some((40, payload_len));
    }
    if nh == IPPROTO_ICMPV6 {
        unsafe {
            ICMP6_TARGET.tail_call(ctx, icmp_target_idx);
        }
        return None;
    }
    if nh == IPPROTO_FRAGMENT {
        unsafe {
            FRAG6_TARGET.tail_call(ctx, frag_target_idx);
        }
        return None;
    }

    // Pull extension header chain up to 256 bytes linearly if the packet is
    // paged.
    pull_up_to(ctx, data, data_end, ip_rel + 256);
    match unsafe { locate_ipv6_l4(*data, *data_end, ip_rel, nh) } {
        Ipv6L4::Udp(udp_rel) => Some((udp_rel - ip_rel, payload_len)),
        Ipv6L4::Fragment => {
            unsafe {
                FRAG6_TARGET.tail_call(ctx, frag_target_idx);
            }
            None
        }
        Ipv6L4::Icmp6(_) => {
            unsafe {
                ICMP6_TARGET.tail_call(ctx, icmp_target_idx);
            }
            None
        }
        Ipv6L4::NonUdp | Ipv6L4::Unsupported => None,
    }
}

#[inline(always)]
fn resolve_frag_v6_udp_rel(
    ctx: &TcContext,
    data: &mut usize,
    data_end: &mut usize,
    frag_rel: usize,
    next_hdr: u8,
) -> Option<usize> {
    if next_hdr == IPPROTO_UDP {
        return Some(frag_rel + 8);
    }
    if next_hdr == IPPROTO_DSTOPTS {
        if !ensure_linear(ctx, data, data_end, frag_rel + 10) {
            return None;
        }
        let dopt = unsafe { parse_header_ref_mut::<[u8; 2]>(*data + frag_rel + 8, *data_end) }?;
        let nh2 = dopt[0];
        let ext_len = (dopt[1] as usize + 1) * 8;
        if nh2 == IPPROTO_UDP {
            return Some(frag_rel + 8 + ext_len);
        }
    }
    None
}

#[inline(always)]
fn make_frag_key6(epoch: u32, src: &[u8; 16], dst: &[u8; 16], id: u32) -> FragKey6 {
    const _: () = assert!(core::mem::offset_of!(FragKey6, proto) == 36);
    const _: () = assert!(core::mem::offset_of!(FragKey6, _pad) == 37);
    const _: () = assert!(core::mem::offset_of!(FragKey6, epoch) == 40);
    let mut k = mem::MaybeUninit::<FragKey6>::uninit();
    let p = k.as_mut_ptr();
    unsafe {
        (*p).epoch = epoch;
        copy_ipv6(&mut (*p).src, src);
        copy_ipv6(&mut (*p).dst, dst);
        (*p).id = id;
        // Write `proto` + `_pad` as one aligned 32-bit word so LLVM does not
        // emit a 3-byte memset.
        (core::ptr::addr_of_mut!((*p).proto) as *mut u32).write(u32::from_ne_bytes([
            IPPROTO_UDP,
            0,
            0,
            0,
        ]));
        k.assume_init()
    }
}

#[inline(always)]
fn init_frag_value6(ip: &[u8; 16], wan_id: u32, now: u32) -> FragValue6 {
    let mut v = mem::MaybeUninit::<FragValue6>::uninit();
    let p = v.as_mut_ptr();
    unsafe {
        copy_ipv6(&mut (*p).ip, ip);
        (*p).wan_id = wan_id;
        (*p).last_seen = now;
        v.assume_init()
    }
}

#[inline(always)]
fn ingress_v4(ctx: &TcContext, cfg: &GlobalConfig, ip_rel: usize) -> i32 {
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some((ihl, proto, frag_off, tot_len, _src_ip, dst_ip)) =
        parse_ipv4_hdr_bounds(ctx, &mut data, &mut data_end, ip_rel)
    else {
        return TC_ACT_UNSPEC;
    };
    if dst_ip != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    if proto != IPPROTO_UDP {
        if proto == IPPROTO_ICMP && (frag_off & 0x3fff) == 0 {
            unsafe {
                ICMP_TARGET.tail_call(ctx, TARGET_INGRESS);
            }
        }
        return TC_ACT_UNSPEC;
    }
    // Check fragmentation before tot_len < ihl + 8 so 1..=7-byte trailing
    // fragments still tail-call.
    if (frag_off & 0x3fff) != 0 {
        unsafe {
            FRAG_TARGET.tail_call(ctx, TARGET_INGRESS);
        }
        return TC_ACT_UNSPEC;
    }
    if (tot_len as usize) < ihl + 8 {
        return TC_ACT_UNSPEC;
    }

    let udp_rel = ip_rel + ihl;
    if !ensure_linear(ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ext_port = u16::from_be(udph.dst_port);
    if ext_port < cfg.min_port4 || ext_port > cfg.max_port4 {
        return TC_ACT_UNSPEC;
    }

    if let Some(target) = lookup_inbound_v4(ext_port) {
        let new_dst_ip = unsafe { (*target).ip };
        let new_dst_port = unsafe { (*target).port };
        let now = now_sec();
        unsafe {
            if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
                (*target).last_seen = now;
            }
        }

        let old_dst_ip = iph.dst_addr;
        let old_dst_port = udph.dst_port;
        iph.dst_addr = new_dst_ip;
        udph.dst_port = new_dst_port;

        if !fixup_csum_v4(
            ctx,
            ip_rel,
            udp_rel,
            old_dst_ip,
            new_dst_ip,
            old_dst_port,
            new_dst_port,
        ) {
            return TC_ACT_SHOT;
        }

        let mark = get_mark(ctx);
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
    }
    TC_ACT_UNSPEC
}

#[inline(always)]
fn ingress_v6(ctx: &TcContext, cfg: &GlobalConfig, ip_rel: usize) -> i32 {
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(ctx, &mut data, &mut data_end, ip_rel + 40) {
        return TC_ACT_UNSPEC;
    }
    let Some(iph_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph_ro.ver_tc_fl) >> 28) != 6 || !ipv6_eq(&iph_ro.dst_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let Some((udp_from_ip, payload_len)) = locate_ipv6_udp_and_validate(
        ctx,
        &mut data,
        &mut data_end,
        ip_rel,
        TARGET_INGRESS,
        TARGET_INGRESS,
    ) else {
        return TC_ACT_UNSPEC;
    };
    if payload_len < (udp_from_ip - 40) + 8 {
        return TC_ACT_UNSPEC;
    }
    let udp_rel = ip_rel + udp_from_ip;
    if !ensure_linear(ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if udph.check == 0 {
        return TC_ACT_UNSPEC;
    }

    let ext_port = u16::from_be(udph.dst_port);
    if ext_port < cfg.min_port6 || ext_port > cfg.max_port6 {
        return TC_ACT_UNSPEC;
    }

    if let Some(target) = lookup_inbound_v6(ext_port) {
        let new_dst_ip = unsafe { (*target).ip };
        let new_dst_port = unsafe { (*target).port };
        let now = now_sec();
        unsafe {
            if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
                (*target).last_seen = now;
            }
        }

        let mut old_dst_ip = [0u8; 16];
        copy_ipv6(&mut old_dst_ip, &iph.dst_addr);
        let old_dst_port = udph.dst_port;
        copy_ipv6(&mut iph.dst_addr, &new_dst_ip);
        udph.dst_port = new_dst_port;

        if !fixup_csum_v6(
            ctx,
            udp_rel,
            &old_dst_ip,
            &new_dst_ip,
            old_dst_port,
            new_dst_port,
        ) {
            return TC_ACT_SHOT;
        }

        let mark = get_mark(ctx);
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
    }
    TC_ACT_UNSPEC
}

#[inline(always)]
fn dispatch_tcx(ctx: &TcContext, targets: &'static ProgramArray) -> i32 {
    let Some((cfg, l2)) = prepare_packet(ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto == ETH_P_IP && cfg.enabled_v4 != 0 {
        unsafe {
            targets.tail_call(ctx, TARGET_FAMILY_V4);
        }
    } else if l2.proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        unsafe {
            targets.tail_call(ctx, TARGET_FAMILY_V6);
        }
    }
    TC_ACT_UNSPEC
}

#[inline(always)]
fn run_family<F>(ctx: &TcContext, expected_proto: u16, is_v6: bool, handler: F) -> i32
where
    F: FnOnce(&TcContext, &GlobalConfig, usize) -> i32,
{
    let Some((cfg, l2)) = prepare_packet(ctx) else {
        return TC_ACT_UNSPEC;
    };
    let enabled = if is_v6 {
        cfg.enabled_v6
    } else {
        cfg.enabled_v4
    };
    if l2.proto == expected_proto && enabled != 0 {
        return handler(ctx, cfg, l2.ip_rel);
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_ingress(ctx: TcContext) -> i32 {
    dispatch_tcx(&ctx, &INGRESS_TARGET)
}

#[classifier]
pub fn flowcone_ingress_v4(ctx: TcContext) -> i32 {
    run_family(&ctx, ETH_P_IP, false, ingress_v4)
}

#[classifier]
pub fn flowcone_ingress_v6(ctx: TcContext) -> i32 {
    run_family(&ctx, ETH_P_IPV6, true, ingress_v6)
}

#[inline(always)]
fn pack_scratch_offsets(ip_rel: usize, udp_rel: usize, frag_rel: usize) -> u64 {
    ((ip_rel as u64) & 0xfff)
        | (((udp_rel as u64) & 0xfff) << 16)
        | (((frag_rel as u64) & 0xfff) << 32)
}

#[inline(always)]
fn tail_call_scratch(
    ctx: &TcContext,
    targets: &'static ProgramArray,
    target: u32,
    ip_rel: usize,
    udp_rel: usize,
    frag_rel: usize,
) -> i32 {
    if let Some(p) = EGRESS_SCRATCH.get_ptr_mut(0) {
        unsafe {
            *p = pack_scratch_offsets(ip_rel, udp_rel, frag_rel);
        }
    } else {
        return TC_ACT_SHOT;
    }
    unsafe {
        targets.tail_call(ctx, target);
    }
    TC_ACT_SHOT
}

#[inline(always)]
fn tail_call_egress_alloc(ctx: &TcContext, ip_rel: usize, udp_rel: usize, target: u32) -> i32 {
    tail_call_scratch(ctx, &EGRESS_ALLOC_TARGET, target, ip_rel, udp_rel, 0)
}

#[inline(always)]
fn prepare_scratch_alloc(
    ctx: &TcContext,
    min_ip_hdr: usize,
) -> Option<(&'static GlobalConfig, usize, usize, usize, usize, usize)> {
    let cfg = get_config()?;
    let packed = *EGRESS_SCRATCH.get(0)?;
    let ip_rel = (packed & 0xfff) as usize;
    let udp_rel = ((packed >> 16) & 0xfff) as usize;
    let frag_rel = ((packed >> 32) & 0xfff) as usize;
    if udp_rel < ip_rel + min_ip_hdr {
        return None;
    }
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(ctx, &mut data, &mut data_end, udp_rel + 8) {
        return None;
    }
    Some((cfg, data, data_end, ip_rel, udp_rel, frag_rel))
}

#[inline(always)]
fn prepare_egress_alloc(
    ctx: &TcContext,
    min_ip_hdr: usize,
) -> Option<(&'static GlobalConfig, usize, usize, usize, usize)> {
    let (cfg, data, data_end, ip_rel, udp_rel, _) = prepare_scratch_alloc(ctx, min_ip_hdr)?;
    Some((cfg, data, data_end, ip_rel, udp_rel))
}

#[inline(always)]
fn rewrite_egress_v4(
    ctx: &TcContext,
    cfg: &GlobalConfig,
    data: usize,
    data_end: usize,
    ip_rel: usize,
    udp_rel: usize,
    mapped_port: u16,
) -> i32 {
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let old_src_ip = iph.src_addr;
    let src_port = udph.src_port;
    let new_src_ip = cfg.wan_ip4;
    iph.src_addr = new_src_ip;
    udph.src_port = mapped_port;

    if !fixup_csum_v4(
        ctx,
        ip_rel,
        udp_rel,
        old_src_ip,
        new_src_ip,
        src_port,
        mapped_port,
    ) {
        return TC_ACT_SHOT;
    }
    TC_ACT_UNSPEC
}

#[inline(always)]
fn rewrite_egress_v6(
    ctx: &TcContext,
    cfg: &GlobalConfig,
    data: usize,
    data_end: usize,
    ip_rel: usize,
    udp_rel: usize,
    mapped_port: u16,
) -> i32 {
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let mut src_addr = [0u8; 16];
    copy_ipv6(&mut src_addr, &iph.src_addr);
    let src_port = udph.src_port;
    copy_ipv6(&mut iph.src_addr, &cfg.wan_ip6);
    udph.src_port = mapped_port;

    if !fixup_csum_v6(ctx, udp_rel, &src_addr, &cfg.wan_ip6, src_port, mapped_port) {
        return TC_ACT_SHOT;
    }
    TC_ACT_UNSPEC
}

#[inline(always)]
fn egress_v4(ctx: &TcContext, cfg: &GlobalConfig, ip_rel: usize) -> i32 {
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some((ihl, proto, frag_off, tot_len, src_ip, _dst_ip)) =
        parse_ipv4_hdr_bounds(ctx, &mut data, &mut data_end, ip_rel)
    else {
        return TC_ACT_UNSPEC;
    };
    if proto != IPPROTO_UDP {
        if proto == IPPROTO_ICMP && (frag_off & 0x3fff) == 0 {
            unsafe {
                ICMP_TARGET.tail_call(ctx, TARGET_EGRESS);
            }
        }
        return TC_ACT_UNSPEC;
    }
    if src_ip == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(src_ip) {
        return TC_ACT_UNSPEC;
    }
    // Check fragmentation before tot_len < ihl + 8 so 1..=7-byte trailing
    // fragments never leak LAN IP.
    if (frag_off & 0x3fff) != 0 {
        unsafe {
            FRAG_TARGET.tail_call(ctx, TARGET_EGRESS);
        }
        return TC_ACT_SHOT;
    }
    if (tot_len as usize) < ihl + 8 {
        return TC_ACT_UNSPEC;
    }

    let udp_rel = ip_rel + ihl;
    if !ensure_linear(ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_SHOT;
    }
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let src_port = udph.src_port;

    if bypass_special_udp4(src_ip, iph.dst_addr, src_port, udph.dst_port) {
        return TC_ACT_UNSPEC;
    }

    let short_lived = is_short_lived_port(u16::from_be(udph.dst_port));
    if let Some(mapped_port) = lookup_outbound_v4(cfg, src_ip, src_port, now_sec(), short_lived) {
        return rewrite_egress_v4(ctx, cfg, data, data_end, ip_rel, udp_rel, mapped_port);
    }
    tail_call_egress_alloc(ctx, ip_rel, udp_rel, TARGET_ALLOC_V4)
}

#[inline(always)]
fn egress_v6(ctx: &TcContext, cfg: &GlobalConfig, ip_rel: usize) -> i32 {
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(ctx, &mut data, &mut data_end, ip_rel + 40) {
        return TC_ACT_UNSPEC;
    }
    let Some(iph_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph_ro.ver_tc_fl) >> 28) != 6 || ipv6_eq(&iph_ro.src_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let allow_all_internal = cfg.enabled_v6 > 1;
    if !flowcone_common::is_routable_internal_ipv6(&iph_ro.src_addr, allow_all_internal) {
        return TC_ACT_UNSPEC;
    }
    let Some((udp_from_ip, payload_len)) = locate_ipv6_udp_and_validate(
        ctx,
        &mut data,
        &mut data_end,
        ip_rel,
        TARGET_EGRESS,
        TARGET_EGRESS,
    ) else {
        return TC_ACT_UNSPEC;
    };
    if payload_len < (udp_from_ip - 40) + 8 {
        return TC_ACT_UNSPEC;
    }
    let udp_rel = ip_rel + udp_from_ip;
    if !ensure_linear(ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_SHOT;
    }
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };

    let mut src_addr = [0u8; 16];
    copy_ipv6(&mut src_addr, &iph.src_addr);
    let src_port = udph.src_port;
    if bypass_special_udp6(&src_addr, &iph.dst_addr, src_port, udph.dst_port) {
        return TC_ACT_UNSPEC;
    }
    if udph.check == 0 {
        return TC_ACT_UNSPEC;
    }

    let short_lived = is_short_lived_port(u16::from_be(udph.dst_port));
    if let Some(mapped_port) = lookup_outbound_v6(cfg, src_addr, src_port, now_sec(), short_lived) {
        return rewrite_egress_v6(ctx, cfg, data, data_end, ip_rel, udp_rel, mapped_port);
    }
    tail_call_egress_alloc(ctx, ip_rel, udp_rel, TARGET_ALLOC_V6)
}

#[classifier]
pub fn flowcone_tcx_egress(ctx: TcContext) -> i32 {
    dispatch_tcx(&ctx, &EGRESS_TARGET)
}

#[classifier]
pub fn flowcone_egress_v4(ctx: TcContext) -> i32 {
    run_family(&ctx, ETH_P_IP, false, egress_v4)
}

#[classifier]
pub fn flowcone_egress_v6(ctx: TcContext) -> i32 {
    run_family(&ctx, ETH_P_IPV6, true, egress_v6)
}

#[classifier]
pub fn flowcone_egress_alloc_v4(ctx: TcContext) -> i32 {
    let Some((cfg, data, data_end, ip_rel, udp_rel)) = prepare_egress_alloc(&ctx, 20) else {
        return TC_ACT_SHOT;
    };
    if cfg.enabled_v4 == 0 {
        return TC_ACT_UNSPEC;
    }
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let mapped_port = get_or_create_mapping_v4(
        cfg,
        iph.src_addr,
        udph.src_port,
        now_sec(),
        is_short_lived_port(u16::from_be(udph.dst_port)),
    );
    if mapped_port == 0 {
        // fw4 skips masquerade for RFC1918 sources on this path, so passing the
        // packet through would leak it un-NATed; drop instead.
        return TC_ACT_SHOT;
    }
    rewrite_egress_v4(&ctx, cfg, data, data_end, ip_rel, udp_rel, mapped_port)
}

#[classifier]
pub fn flowcone_egress_alloc_v6(ctx: TcContext) -> i32 {
    let Some((cfg, data, data_end, ip_rel, udp_rel)) = prepare_egress_alloc(&ctx, 40) else {
        return TC_ACT_SHOT;
    };
    if cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let mut src_addr = [0u8; 16];
    copy_ipv6(&mut src_addr, &iph.src_addr);
    let mapped_port = get_or_create_mapping_v6(
        cfg,
        src_addr,
        udph.src_port,
        now_sec(),
        is_short_lived_port(u16::from_be(udph.dst_port)),
    );
    if mapped_port == 0 {
        // Same as v4: do not let an un-NATed private source reach the WAN.
        return TC_ACT_SHOT;
    }
    rewrite_egress_v6(&ctx, cfg, data, data_end, ip_rel, udp_rel, mapped_port)
}

#[classifier]
pub fn flowcone_frag_v6_ingress(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto != ETH_P_IPV6 || cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(&ctx, &mut data, &mut data_end, ip_rel + 40) {
        return TC_ACT_UNSPEC;
    }
    pull_up_to(&ctx, &mut data, &mut data_end, ip_rel + 256);
    let ip_off = data + ip_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 || !ipv6_eq(&iph.dst_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph.payload_len) as usize;
    let Some(frag_rel) = (unsafe { ipv6_fragment_offset(data, data_end, ip_rel, iph.next_hdr) })
    else {
        return TC_ACT_UNSPEC;
    };
    if payload_len < (frag_rel - ip_rel - 40) + 8 {
        return TC_ACT_UNSPEC;
    }
    let Some(fh) = (unsafe { parse_header_ref_mut::<FragExtHdr>(data + frag_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let next_hdr = fh.next_hdr;
    if next_hdr != IPPROTO_UDP && next_hdr != IPPROTO_DSTOPTS {
        return TC_ACT_UNSPEC;
    }
    let frag_field = u16::from_be(fh.frag_off);
    let offset = frag_field & 0xfff8;
    let more = (frag_field & 1) != 0;
    let id = u32::from_be_bytes(fh.id);
    let key = make_frag_key6(cfg.frag_epoch, &iph.src_addr, &iph.dst_addr, id);
    let now = now_sec();

    if offset != 0 {
        if let Some(v_ptr) = FRAG_IN_V6.get_ptr_mut(&key) {
            let v = unsafe { *v_ptr };
            if now.saturating_sub(v.last_seen) <= FRAG_TIMEOUT_SEC {
                unsafe {
                    (*v_ptr).last_seen = now;
                }
                let mark = get_mark(&ctx);
                // Use skb.store with BPF_F_RECOMPUTE_CSUM so CHECKSUM_COMPLETE
                // skb->csum stays valid.
                if ctx
                    .skb
                    .store(ip_rel + 24, &v.ip, BPF_F_RECOMPUTE_CSUM as u64)
                    .is_err()
                {
                    return TC_ACT_SHOT;
                }
                ctx.skb.set_mark(mark | cfg.flowcone_mark);
            }
        }
        return TC_ACT_UNSPEC;
    }
    let Some(udp_rel) = resolve_frag_v6_udp_rel(&ctx, &mut data, &mut data_end, frag_rel, next_hdr)
    else {
        return TC_ACT_UNSPEC;
    };
    if payload_len < (udp_rel - ip_rel - 40) + 8 {
        return TC_ACT_UNSPEC;
    }
    if !ensure_linear(&ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if udph.check == 0 {
        return TC_ACT_UNSPEC;
    }
    let ext_port = u16::from_be(udph.dst_port);
    if ext_port < cfg.min_port6 || ext_port > cfg.max_port6 {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = lookup_inbound_v6(ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let mut new_dst_ip = [0u8; 16];
    copy_ipv6(&mut new_dst_ip, unsafe { &(*target).ip });
    let new_dst_port = unsafe { (*target).port };
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }
    let mut old_dst_ip = [0u8; 16];
    copy_ipv6(&mut old_dst_ip, &iph.dst_addr);
    let old_dst_port = udph.dst_port;
    copy_ipv6(&mut iph.dst_addr, &new_dst_ip);
    udph.dst_port = new_dst_port;
    if !fixup_csum_v6(
        &ctx,
        udp_rel,
        &old_dst_ip,
        &new_dst_ip,
        old_dst_port,
        new_dst_port,
    ) {
        return TC_ACT_SHOT;
    }
    if more {
        let value = init_frag_value6(&new_dst_ip, 0, now);
        let _ = FRAG_IN_V6.insert(&key, &value, BPF_ANY);
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

static ZERO_IP6: [u8; 16] = [0; 16];

#[inline(always)]
fn insert_frag_bypass_v6(cfg: &GlobalConfig, src: &[u8; 16], dst: &[u8; 16], id: u32, now: u32) {
    let key = make_frag_key6(cfg.frag_epoch, src, dst, id);
    let value = init_frag_value6(core::hint::black_box(&ZERO_IP6), 0, now);
    let _ = FRAG_OUT_V6.insert(&key, &value, BPF_ANY);
}

#[inline(always)]
fn insert_frag_out_v6(cfg: &GlobalConfig, src: &[u8; 16], dst: &[u8; 16], id_wan: u64, now: u32) {
    let id = (id_wan >> 32) as u32;
    let wan_id = id_wan as u32;
    let key = make_frag_key6(cfg.frag_epoch, src, dst, id);
    let value = init_frag_value6(&cfg.wan_ip6, wan_id, now);
    let _ = FRAG_OUT_V6.insert(&key, &value, BPF_ANY);
}

#[inline(never)]
fn rewrite_frag_v6_egress_first(
    ctx: &TcContext,
    cfg: &GlobalConfig,
    offsets: u64,
    mapped: u16,
    now: u32,
) -> i32 {
    let ip_rel = core::hint::black_box((offsets & 0xfff) as usize) & 0xfff;
    let udp_rel = core::hint::black_box(((offsets >> 16) & 0xfff) as usize) & 0xfff;
    let frag_rel = core::hint::black_box(((offsets >> 32) & 0xfff) as usize) & 0xfff;
    let wan_id = alloc_wan_frag_id();

    // Load original source IP via constant-size bpf_skb_load_bytes so LLVM
    // keeps a single 16-byte stack slot instead of spilling 16 separate byte
    // loads across header rewrites.
    let Ok(src_ip) = ctx.load::<[u8; 16]>(ip_rel + 8) else {
        return TC_ACT_SHOT;
    };

    let data = ctx.data();
    let data_end = ctx.data_end();
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    copy_ipv6(&mut iph.src_addr, &cfg.wan_ip6);

    let Some(fh) = (unsafe { parse_header_ref_mut::<FragExtHdr>(data + frag_rel, data_end) })
    else {
        return TC_ACT_SHOT;
    };
    let id = u32::from_be_bytes(fh.id);
    let more = (u16::from_be(fh.frag_off) & 1) != 0;
    fh.id = u32::to_be(wan_id).to_ne_bytes();

    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let old_sport = udph.src_port;
    udph.src_port = mapped;

    if !fixup_csum_v6(ctx, udp_rel, &src_ip, &cfg.wan_ip6, old_sport, mapped) {
        return TC_ACT_SHOT;
    }
    if more {
        // Defer loading untouched dst_addr until after fixup_csum_v6 to avoid
        // holding two 16-byte addresses across checksum helpers.
        let Ok(dst_ip) = ctx.load::<[u8; 16]>(ip_rel + 24) else {
            return TC_ACT_SHOT;
        };
        let id_wan = ((id as u64) << 32) | (wan_id as u64);
        insert_frag_out_v6(cfg, &src_ip, &dst_ip, id_wan, now);
    }
    TC_ACT_UNSPEC
}

const FRAG_FIRST_UNSPEC: u64 = 0;
const FRAG_FIRST_SHOT: u64 = 1;
const FRAG_FIRST_HIT: u64 = 2;
const FRAG_FIRST_ALLOC: u64 = 3;

/// Returns `FRAG_FIRST_UNSPEC`, `FRAG_FIRST_SHOT`, `(udp_rel << 32) |
/// (mapped << 16) | FRAG_FIRST_HIT`, or `(udp_rel << 32) | FRAG_FIRST_ALLOC`
/// so both `rewrite_frag_v6_egress_first` and any tail call run from the
/// top-level `flowcone_frag_v6_egress` frame rather than inside this subprogram.
#[inline(never)]
fn frag_v6_egress_first(
    ctx: &TcContext,
    cfg: &GlobalConfig,
    ip_rel: usize,
    frag_rel: usize,
) -> u64 {
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some(iph_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return FRAG_FIRST_SHOT;
    };
    let Some(fh_ro) = (unsafe { parse_header_ref_mut::<FragExtHdr>(data + frag_rel, data_end) })
    else {
        return FRAG_FIRST_SHOT;
    };
    let payload_len = u16::from_be(iph_ro.payload_len) as usize;
    let next_hdr = fh_ro.next_hdr;
    let frag_field = u16::from_be(fh_ro.frag_off);
    let more = (frag_field & 1) != 0;
    let id = u32::from_be_bytes(fh_ro.id);
    let mut src_ip = [0u8; 16];
    let mut dst_ip = [0u8; 16];
    copy_ipv6(&mut src_ip, &iph_ro.src_addr);
    copy_ipv6(&mut dst_ip, &iph_ro.dst_addr);
    let now = now_sec();

    let Some(udp_rel) = resolve_frag_v6_udp_rel(ctx, &mut data, &mut data_end, frag_rel, next_hdr)
    else {
        if more {
            insert_frag_bypass_v6(cfg, &src_ip, &dst_ip, id, now);
        }
        return FRAG_FIRST_UNSPEC;
    };
    if payload_len < (udp_rel - ip_rel - 40) + 8 {
        return FRAG_FIRST_UNSPEC;
    }
    if !ensure_linear(ctx, &mut data, &mut data_end, udp_rel + 8) {
        return FRAG_FIRST_SHOT;
    }
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return FRAG_FIRST_SHOT;
    };
    let src_port = udph.src_port;
    if bypass_special_udp6(&src_ip, &dst_ip, src_port, udph.dst_port) || udph.check == 0 {
        if more {
            insert_frag_bypass_v6(cfg, &src_ip, &dst_ip, id, now);
        }
        return FRAG_FIRST_UNSPEC;
    }
    let short_lived = is_short_lived_port(u16::from_be(udph.dst_port));
    if let Some(mapped) = lookup_outbound_v6(cfg, src_ip, src_port, now, short_lived) {
        return ((udp_rel as u64) << 32) | ((mapped as u64) << 16) | FRAG_FIRST_HIT;
    }
    ((udp_rel as u64) << 32) | FRAG_FIRST_ALLOC
}

#[classifier]
pub fn flowcone_frag_v6_egress_alloc(ctx: TcContext) -> i32 {
    let Some((cfg, data, data_end, ip_rel, udp_rel, frag_rel)) = prepare_scratch_alloc(&ctx, 40)
    else {
        return TC_ACT_SHOT;
    };
    if cfg.enabled_v6 == 0 || frag_rel < ip_rel + 40 || udp_rel < frag_rel + 8 {
        return TC_ACT_SHOT;
    }
    let Ok(src_ip) = ctx.load::<[u8; 16]>(ip_rel + 8) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(data + udp_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let now = now_sec();
    let mapped = get_or_create_mapping_v6(
        cfg,
        src_ip,
        udph.src_port,
        now,
        is_short_lived_port(u16::from_be(udph.dst_port)),
    );
    if mapped == 0 {
        return TC_ACT_SHOT;
    }
    rewrite_frag_v6_egress_first(
        &ctx,
        cfg,
        pack_scratch_offsets(ip_rel, udp_rel, frag_rel),
        mapped,
        now,
    )
}

#[inline(never)]
fn frag_v6_egress_cont(ctx: &TcContext, cfg: &GlobalConfig, ip_rel: usize, frag_rel: usize) -> i32 {
    if !ensure_linear(ctx, &mut ctx.data(), &mut ctx.data_end(), frag_rel + 8) {
        return TC_ACT_SHOT;
    }
    let data = ctx.data();
    let data_end = ctx.data_end();
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(data + ip_rel, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(fh) = (unsafe { parse_header_ref_mut::<FragExtHdr>(data + frag_rel, data_end) })
    else {
        return TC_ACT_SHOT;
    };
    let key = make_frag_key6(
        cfg.frag_epoch,
        &iph.src_addr,
        &iph.dst_addr,
        u32::from_be_bytes(fh.id),
    );
    let Some(v_ptr) = FRAG_OUT_V6.get_ptr_mut(&key) else {
        return TC_ACT_SHOT;
    };
    let v = unsafe { *v_ptr };
    let now = now_sec();
    if now.saturating_sub(v.last_seen) > FRAG_TIMEOUT_SEC {
        let _ = FRAG_OUT_V6.remove(&key);
        return TC_ACT_SHOT;
    }
    unsafe {
        (*v_ptr).last_seen = now;
    }
    if ipv6_eq(&v.ip, &[0; 16]) {
        return TC_ACT_UNSPEC;
    }
    let wan_id_be = u32::to_be(v.wan_id);
    if ctx
        .skb
        .store(ip_rel + 8, &v.ip, BPF_F_RECOMPUTE_CSUM as u64)
        .is_err()
        || ctx
            .skb
            .store(frag_rel + 4, &wan_id_be, BPF_F_RECOMPUTE_CSUM as u64)
            .is_err()
    {
        return TC_ACT_SHOT;
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_frag_v6_egress(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto != ETH_P_IPV6 || cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(&ctx, &mut data, &mut data_end, ip_rel + 40) {
        return TC_ACT_UNSPEC;
    }
    pull_up_to(&ctx, &mut data, &mut data_end, ip_rel + 256);
    let ip_off = data + ip_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
        return TC_ACT_UNSPEC;
    }
    let allow_all_internal = cfg.enabled_v6 > 1;
    if ipv6_eq(&iph.src_addr, &cfg.wan_ip6)
        || !flowcone_common::is_routable_internal_ipv6(&iph.src_addr, allow_all_internal)
    {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph.payload_len) as usize;
    let Some(frag_rel) = (unsafe { ipv6_fragment_offset(data, data_end, ip_rel, iph.next_hdr) })
    else {
        return TC_ACT_UNSPEC;
    };
    if payload_len < (frag_rel - ip_rel - 40) + 8 {
        return TC_ACT_UNSPEC;
    }
    let Some(fh) = (unsafe { parse_header_ref_mut::<FragExtHdr>(data + frag_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let next_hdr = fh.next_hdr;
    if next_hdr != IPPROTO_UDP && next_hdr != IPPROTO_DSTOPTS {
        return TC_ACT_UNSPEC;
    }
    let offset = u16::from_be(fh.frag_off) & 0xfff8;
    if offset == 0 {
        let res = frag_v6_egress_first(&ctx, cfg, ip_rel, frag_rel);
        return match res & 0xff {
            FRAG_FIRST_UNSPEC => TC_ACT_UNSPEC,
            FRAG_FIRST_HIT => rewrite_frag_v6_egress_first(
                &ctx,
                cfg,
                pack_scratch_offsets(ip_rel, (res >> 32) as usize, frag_rel),
                ((res >> 16) & 0xffff) as u16,
                now_sec(),
            ),
            FRAG_FIRST_ALLOC => tail_call_scratch(
                &ctx,
                &FRAG6_TARGET,
                TARGET_FRAG_EGRESS_ALLOC,
                ip_rel,
                (res >> 32) as usize,
                frag_rel,
            ),
            _ => TC_ACT_SHOT,
        };
    }
    frag_v6_egress_cont(&ctx, cfg, ip_rel, frag_rel)
}

/// Inbound IPv4 fragment NAT handler.
#[classifier]
pub fn flowcone_frag_v4_ingress(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto != ETH_P_IP || cfg.enabled_v4 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some((ihl, proto, frag_off, tot_len, src_addr, dst_addr)) =
        parse_ipv4_hdr_bounds(&ctx, &mut data, &mut data_end, ip_rel)
    else {
        return TC_ACT_UNSPEC;
    };
    if proto != IPPROTO_UDP || dst_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    let offset = frag_off & 0x1fff;
    let more = (frag_off & 0x2000) != 0;

    let ip_off = data + ip_rel;
    let Some(iph_ro) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let key = FragKey4 {
        epoch: cfg.frag_epoch,
        src: src_addr,
        dst: dst_addr,
        id: iph_ro.id,
        proto: IPPROTO_UDP,
        _pad: 0,
    };
    let now = now_sec();

    if offset != 0 {
        if let Some(v_ptr) = FRAG_IN_V4.get_ptr_mut(&key) {
            let v = unsafe { *v_ptr };
            if now.saturating_sub(v.last_seen) <= FRAG_TIMEOUT_SEC {
                unsafe {
                    (*v_ptr).last_seen = now;
                }
                let old = dst_addr;
                let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) })
                else {
                    return TC_ACT_UNSPEC;
                };
                iph.dst_addr = v.ip;
                if !fixup_l3_v4(&ctx, ip_rel, old, v.ip) {
                    return TC_ACT_SHOT;
                }
                let mark = get_mark(&ctx);
                ctx.skb.set_mark(mark | cfg.flowcone_mark);
            }
        }
        return TC_ACT_UNSPEC;
    }
    if !more || (tot_len as usize) < ihl + 8 {
        return TC_ACT_UNSPEC;
    }
    let udp_rel = ip_rel + ihl;
    if !ensure_linear(&ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ext_port = u16::from_be(udph.dst_port);
    if ext_port < cfg.min_port4 || ext_port > cfg.max_port4 {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = lookup_inbound_v4(ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let new_dst_ip = unsafe { (*target).ip };
    let new_dst_port = unsafe { (*target).port };
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }
    let old_dst_ip = iph.dst_addr;
    let old_dst_port = udph.dst_port;
    iph.dst_addr = new_dst_ip;
    udph.dst_port = new_dst_port;
    if !fixup_csum_v4(
        &ctx,
        ip_rel,
        udp_rel,
        old_dst_ip,
        new_dst_ip,
        old_dst_port,
        new_dst_port,
    ) {
        return TC_ACT_SHOT;
    }
    let value = FragValue4 {
        ip: new_dst_ip,
        wan_id: 0,
        _pad: 0,
        last_seen: now,
    };
    let _ = FRAG_IN_V4.insert(&key, &value, BPF_ANY);
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Outbound IPv4 fragment NAT handler.
#[classifier]
pub fn flowcone_frag_v4_egress(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto != ETH_P_IP || cfg.enabled_v4 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some((ihl, proto, frag_off, tot_len, src_ip, dst_ip)) =
        parse_ipv4_hdr_bounds(&ctx, &mut data, &mut data_end, ip_rel)
    else {
        return TC_ACT_UNSPEC;
    };
    if proto != IPPROTO_UDP || src_ip == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(src_ip) {
        return TC_ACT_UNSPEC;
    }
    let offset = frag_off & 0x1fff;
    let more = (frag_off & 0x2000) != 0;
    let ip_off = data + ip_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let id = iph.id;
    let now = now_sec();

    let make_frag_key = || FragKey4 {
        epoch: cfg.frag_epoch,
        src: src_ip,
        dst: dst_ip,
        id,
        proto: IPPROTO_UDP,
        _pad: 0,
    };

    if offset != 0 {
        let key = make_frag_key();
        let Some(v_ptr) = FRAG_OUT_V4.get_ptr_mut(&key) else {
            return TC_ACT_SHOT;
        };
        let v = unsafe { *v_ptr };
        if now.saturating_sub(v.last_seen) > FRAG_TIMEOUT_SEC {
            let _ = FRAG_OUT_V4.remove(&key);
            return TC_ACT_SHOT;
        }
        unsafe {
            (*v_ptr).last_seen = now;
        }
        if v.ip == 0 {
            return TC_ACT_UNSPEC;
        }
        let new_id = u16::to_be(v.wan_id);
        iph.src_addr = v.ip;
        iph.id = new_id;
        if !fixup_l3_v4(&ctx, ip_rel, src_ip, v.ip) || !fixup_l3_id_v4(&ctx, ip_rel, id, new_id) {
            return TC_ACT_SHOT;
        }
        return TC_ACT_UNSPEC;
    }
    if !more || (tot_len as usize) < ihl + 8 {
        return TC_ACT_UNSPEC;
    }
    let udp_rel = ip_rel + ihl;
    if !ensure_linear(&ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_SHOT;
    }
    let ip_off = data + ip_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let src_port = udph.src_port;
    if bypass_special_udp4(src_ip, dst_ip, src_port, udph.dst_port) {
        let key = make_frag_key();
        let value = FragValue4 {
            ip: 0,
            wan_id: 0,
            _pad: 0,
            last_seen: now,
        };
        let _ = FRAG_OUT_V4.insert(&key, &value, BPF_ANY);
        return TC_ACT_UNSPEC;
    }
    let mapped = get_or_create_mapping_v4(
        cfg,
        src_ip,
        src_port,
        now,
        is_short_lived_port(u16::from_be(udph.dst_port)),
    );
    if mapped == 0 {
        return TC_ACT_SHOT;
    }
    let old_sport = udph.src_port;
    let wan_id = alloc_wan_ip_id();
    let new_id = u16::to_be(wan_id);

    iph.src_addr = cfg.wan_ip4;
    iph.id = new_id;
    udph.src_port = mapped;
    if !fixup_csum_v4(
        &ctx,
        ip_rel,
        udp_rel,
        src_ip,
        cfg.wan_ip4,
        old_sport,
        mapped,
    ) || !fixup_l3_id_v4(&ctx, ip_rel, id, new_id)
    {
        return TC_ACT_SHOT;
    }

    let key = make_frag_key();
    let value = FragValue4 {
        ip: cfg.wan_ip4,
        wan_id,
        _pad: 0,
        last_seen: now,
    };
    let _ = FRAG_OUT_V4.insert(&key, &value, BPF_ANY);
    TC_ACT_UNSPEC
}

#[inline(always)]
fn csum_replace_ipv4_words(mut c: u16, old_ip: u32, new_ip: u32) -> u16 {
    let ob = old_ip.to_ne_bytes();
    let nb = new_ip.to_ne_bytes();
    c = csum_replace(
        c,
        u16::from_be_bytes([ob[0], ob[1]]),
        u16::from_be_bytes([nb[0], nb[1]]),
    );
    csum_replace(
        c,
        u16::from_be_bytes([ob[2], ob[3]]),
        u16::from_be_bytes([nb[2], nb[3]]),
    )
}

#[inline(always)]
fn csum_replace_ipv6_words(mut c: u16, old_ip: &[u8; 16], new_ip: &[u8; 16]) -> u16 {
    let mut i = 0usize;
    while i < 8 {
        let os = u16::from_be_bytes([old_ip[i * 2], old_ip[i * 2 + 1]]);
        let ns = u16::from_be_bytes([new_ip[i * 2], new_ip[i * 2 + 1]]);
        c = csum_replace(c, os, ns);
        i += 1;
    }
    c
}

struct Icmp4CsumUpdate {
    icmp_csum_off: usize,
    old_emb_ip: u32,
    new_emb_ip: u32,
    old_emb_check: u16,
    new_emb_check: u16,
    old_emb_port: u16,
    new_emb_port: u16,
    old_udp_csum: u16,
    new_udp_csum: u16,
}

#[inline(always)]
fn update_icmpv4_payload_csums(ctx: &TcContext, u: &Icmp4CsumUpdate) -> bool {
    ctx.skb
        .l4_csum_replace(
            u.icmp_csum_off,
            u.old_emb_ip as u64,
            u.new_emb_ip as u64,
            CSUM_FIELD_U32,
        )
        .is_ok()
        && ctx
            .skb
            .l4_csum_replace(
                u.icmp_csum_off,
                u.old_emb_check as u64,
                u.new_emb_check as u64,
                CSUM_FIELD_U16,
            )
            .is_ok()
        && ctx
            .skb
            .l4_csum_replace(
                u.icmp_csum_off,
                u.old_emb_port as u64,
                u.new_emb_port as u64,
                CSUM_FIELD_U16,
            )
            .is_ok()
        && ctx
            .skb
            .l4_csum_replace(
                u.icmp_csum_off,
                u.old_udp_csum as u64,
                u.new_udp_csum as u64,
                CSUM_FIELD_U16,
            )
            .is_ok()
}

/// Inbound ICMP error translation target (RFC 5508).
#[classifier]
pub fn flowcone_icmp_target(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto != ETH_P_IP || cfg.enabled_v4 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some((ihl, proto, frag_off, tot_len, _src_ip, dst_addr)) =
        parse_ipv4_hdr_bounds(&ctx, &mut data, &mut data_end, ip_rel)
    else {
        return TC_ACT_UNSPEC;
    };
    if proto != IPPROTO_ICMP || (frag_off & 0x3fff) != 0 || dst_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    let icmp_rel = ip_rel + ihl;
    let tot_len = tot_len as usize;
    if tot_len < ihl + 8 + 28 || !ensure_linear(&ctx, &mut data, &mut data_end, icmp_rel + 28) {
        return TC_ACT_UNSPEC;
    }
    let Some(icmp_hdr) = (unsafe { parse_header_ref_mut::<[u8; 8]>(data + icmp_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let ty = icmp_hdr[0];
    if ty != 3 && ty != 11 && ty != 12 {
        return TC_ACT_UNSPEC;
    }
    let emb_rel = icmp_rel + 8;
    let Some(emb_ro) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(data + emb_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let emb_ihl = (emb_ro.ver_ihl & 0x0f) as usize * 4;
    if (emb_ro.ver_ihl >> 4) != 4
        || emb_ro.protocol != IPPROTO_UDP
        || emb_ihl < 20
        || (u16::from_be(emb_ro.frag_off) & 0x1fff) != 0
        || emb_ro.src_addr != cfg.wan_ip4
    {
        return TC_ACT_UNSPEC;
    }
    let emb_udp_rel = emb_rel + emb_ihl;
    if ihl + 8 + emb_ihl + mem::size_of::<UdpHdr>() > tot_len
        || !ensure_linear(
            &ctx,
            &mut data,
            &mut data_end,
            emb_udp_rel + mem::size_of::<UdpHdr>(),
        )
    {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let emb_off = data + emb_rel;
    let emb_udp = data + emb_udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(emb_udp, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ext_port = u16::from_be(udph.src_port);
    if ext_port < cfg.min_port4 || ext_port > cfg.max_port4 {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = lookup_inbound_v4(ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let new_ip = unsafe { (*target).ip };
    let new_port = unsafe { (*target).port };
    let now = now_sec();
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }

    let old_emb_src = emb.src_addr;
    let old_emb_check = emb.check;
    let old_emb_sport = udph.src_port;
    let old_udp_csum = udph.check;

    iph.dst_addr = new_ip;
    emb.src_addr = new_ip;
    udph.src_port = new_port;

    let ec = csum_replace_ipv4_words(u16::from_be(old_emb_check), old_emb_src, new_ip);
    emb.check = u16::to_be(ec);

    let new_udp_csum = if old_udp_csum != 0 {
        let mut c = csum_replace_ipv4_words(u16::from_be(old_udp_csum), old_emb_src, new_ip);
        c = csum_replace(c, u16::from_be(old_emb_sport), u16::from_be(new_port));
        u16::to_be(c)
    } else {
        0
    };
    udph.check = new_udp_csum;

    let icmp_csum_off = icmp_rel + 2;
    let new_emb_check = emb.check;
    if !update_icmpv4_payload_csums(
        &ctx,
        &Icmp4CsumUpdate {
            icmp_csum_off,
            old_emb_ip: old_emb_src,
            new_emb_ip: new_ip,
            old_emb_check,
            new_emb_check,
            old_emb_port: old_emb_sport,
            new_emb_port: new_port,
            old_udp_csum,
            new_udp_csum,
        },
    ) || !fixup_l3_v4(&ctx, ip_rel, cfg.wan_ip4, new_ip)
    {
        return TC_ACT_SHOT;
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Outbound ICMP error translation target (RFC 5508 §4.1).
#[classifier]
pub fn flowcone_icmp_egress_target(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if l2.proto != ETH_P_IP || cfg.enabled_v4 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    let Some((ihl, proto, frag_off, tot_len, old_src, _dst_addr)) =
        parse_ipv4_hdr_bounds(&ctx, &mut data, &mut data_end, ip_rel)
    else {
        return TC_ACT_UNSPEC;
    };
    if proto != IPPROTO_ICMP || (frag_off & 0x3fff) != 0 {
        return TC_ACT_UNSPEC;
    }
    let src_is_private = flowcone_common::is_private_ipv4(old_src);
    if old_src != cfg.wan_ip4 && !src_is_private {
        return TC_ACT_UNSPEC;
    }
    let icmp_rel = ip_rel + ihl;
    let tot_len = tot_len as usize;
    if tot_len < ihl + 8 + 28 || !ensure_linear(&ctx, &mut data, &mut data_end, icmp_rel + 28) {
        return TC_ACT_UNSPEC;
    }
    let Some(icmp_hdr) = (unsafe { parse_header_ref_mut::<[u8; 8]>(data + icmp_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let ty = icmp_hdr[0];
    if ty != 3 && ty != 11 && ty != 12 {
        return TC_ACT_UNSPEC;
    }
    let emb_rel = icmp_rel + 8;
    let Some(emb_ro) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(data + emb_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let emb_ihl = (emb_ro.ver_ihl & 0x0f) as usize * 4;
    let old_emb_dst = emb_ro.dst_addr;
    if (emb_ro.ver_ihl >> 4) != 4
        || emb_ro.protocol != IPPROTO_UDP
        || emb_ihl < 20
        || (u16::from_be(emb_ro.frag_off) & 0x1fff) != 0
        || !flowcone_common::is_private_ipv4(old_emb_dst)
        || flowcone_common::is_private_ipv4(emb_ro.src_addr)
    {
        return TC_ACT_UNSPEC;
    }
    let emb_udp_rel = emb_rel + emb_ihl;
    if ihl + 8 + emb_ihl + mem::size_of::<UdpHdr>() > tot_len
        || !ensure_linear(
            &ctx,
            &mut data,
            &mut data_end,
            emb_udp_rel + mem::size_of::<UdpHdr>(),
        )
    {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let emb_off = data + emb_rel;
    let emb_udp = data + emb_udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(emb_udp, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let old_emb_dport = udph.dst_port;

    let ep_key = EndpointKey4 {
        ip: old_emb_dst,
        port: old_emb_dport,
        _pad: 0,
    };
    let Some(target) = OUTBOUND_BINDINGS_V4.get_ptr_mut(&ep_key) else {
        return TC_ACT_UNSPEC;
    };
    let target_ip = unsafe { (*target).ip };
    let mapped_port = unsafe { (*target).port };
    let target_meta = unsafe { (*target).reserved_meta() };
    let res_state = port_reserved_state(&RESERVED_V4, u16::from_be(mapped_port));
    if mapped_port == 0
        || target_ip != cfg.wan_ip4
        || !flowcone_common::binding_matches_reserved(res_state, target_meta)
    {
        return TC_ACT_UNSPEC;
    }
    let now = now_sec();
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }

    let old_emb_check = emb.check;
    let old_udp_csum = udph.check;

    if old_src != cfg.wan_ip4 {
        iph.src_addr = cfg.wan_ip4;
    }
    emb.dst_addr = cfg.wan_ip4;
    udph.dst_port = mapped_port;

    let ec = csum_replace_ipv4_words(u16::from_be(old_emb_check), old_emb_dst, cfg.wan_ip4);
    emb.check = u16::to_be(ec);

    let new_udp_csum = if old_udp_csum != 0 {
        let mut c = csum_replace_ipv4_words(u16::from_be(old_udp_csum), old_emb_dst, cfg.wan_ip4);
        c = csum_replace(c, u16::from_be(old_emb_dport), u16::from_be(mapped_port));
        u16::to_be(c)
    } else {
        0
    };
    udph.check = new_udp_csum;

    let icmp_csum_off = icmp_rel + 2;
    let new_emb_check = emb.check;
    if !update_icmpv4_payload_csums(
        &ctx,
        &Icmp4CsumUpdate {
            icmp_csum_off,
            old_emb_ip: old_emb_dst,
            new_emb_ip: cfg.wan_ip4,
            old_emb_check,
            new_emb_check,
            old_emb_port: old_emb_dport,
            new_emb_port: mapped_port,
            old_udp_csum,
            new_udp_csum,
        },
    ) || (old_src != cfg.wan_ip4 && !fixup_l3_v4(&ctx, ip_rel, old_src, cfg.wan_ip4))
    {
        return TC_ACT_SHOT;
    }
    TC_ACT_UNSPEC
}

/// Fallback ingress dispatcher.
#[classifier]
pub fn flowcone_tcx_ingress_a(ctx: TcContext) -> i32 {
    unsafe {
        INGRESS_TARGET.tail_call(&ctx, TARGET_DISPATCH);
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_ingress_b(ctx: TcContext) -> i32 {
    unsafe {
        INGRESS_TARGET.tail_call(&ctx, TARGET_DISPATCH);
    }
    TC_ACT_UNSPEC
}

/// Fallback egress dispatcher.
#[classifier]
pub fn flowcone_tcx_egress_a(ctx: TcContext) -> i32 {
    unsafe {
        EGRESS_TARGET.tail_call(&ctx, TARGET_DISPATCH);
    }
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_egress_b(ctx: TcContext) -> i32 {
    unsafe {
        EGRESS_TARGET.tail_call(&ctx, TARGET_DISPATCH);
    }
    TC_ACT_UNSPEC
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { core::hint::unreachable_unchecked() }
}

struct Icmp6CsumUpdate<'a> {
    icmp_csum_off: usize,
    old_outer_ip: &'a [u8; 16],
    new_outer_ip: &'a [u8; 16],
    outer_changed: bool,
    old_emb_ip: &'a [u8; 16],
    new_emb_ip: &'a [u8; 16],
    old_port: u16,
    new_port: u16,
    old_udp_csum: u16,
    new_udp_csum: u16,
}

#[inline(always)]
fn update_icmpv6_csums(ctx: &TcContext, u: &Icmp6CsumUpdate<'_>) -> bool {
    if u.outer_changed {
        let Some(outer_diff) = ipv6_addr_diff(u.old_outer_ip, u.new_outer_ip) else {
            return false;
        };
        if ctx
            .skb
            .l4_csum_replace(
                u.icmp_csum_off,
                0,
                outer_diff as u64,
                BPF_F_PSEUDO_HDR | BPF_F_IPV6,
            )
            .is_err()
        {
            return false;
        }
    }
    let Some(emb_diff) = ipv6_addr_diff(u.old_emb_ip, u.new_emb_ip) else {
        return false;
    };
    ctx.skb
        .l4_csum_replace(u.icmp_csum_off, 0, emb_diff as u64, 0)
        .is_ok()
        && (u.old_port == u.new_port
            || ctx
                .skb
                .l4_csum_replace(
                    u.icmp_csum_off,
                    u.old_port as u64,
                    u.new_port as u64,
                    CSUM_FIELD_U16,
                )
                .is_ok())
        && (u.old_udp_csum == u.new_udp_csum
            || ctx
                .skb
                .l4_csum_replace(
                    u.icmp_csum_off,
                    u.old_udp_csum as u64,
                    u.new_udp_csum as u64,
                    CSUM_FIELD_U16,
                )
                .is_ok())
}

#[classifier]
pub fn flowcone_icmp6_target(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if cfg.enabled_v6 == 0 || l2.proto != ETH_P_IPV6 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(&ctx, &mut data, &mut data_end, ip_rel + 40) {
        return TC_ACT_UNSPEC;
    }
    pull_up_to(&ctx, &mut data, &mut data_end, ip_rel + 256);
    let ip_off = data + ip_rel;
    let Some(iph_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph_ro.ver_tc_fl) >> 28) != 6 || !ipv6_eq(&iph_ro.dst_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph_ro.payload_len) as usize;
    let pkt_end_off = ip_rel + 40 + payload_len;
    let icmp_rel = if iph_ro.next_hdr == IPPROTO_ICMPV6 {
        ip_rel + 40
    } else {
        match unsafe {
            locate_ipv6_nexthdr(data, data_end, ip_rel, iph_ro.next_hdr, IPPROTO_ICMPV6)
        } {
            Some(rel) => rel,
            None => return TC_ACT_UNSPEC,
        }
    };
    if icmp_rel + 8 + 40 + 8 > pkt_end_off
        || !ensure_linear(&ctx, &mut data, &mut data_end, icmp_rel + 8 + 40)
    {
        return TC_ACT_UNSPEC;
    }
    let Some(icmp_hdr) = (unsafe { parse_header_ref_mut::<[u8; 8]>(data + icmp_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let ty = icmp_hdr[0];
    if ty != 1 && ty != 2 && ty != 3 && ty != 4 {
        return TC_ACT_UNSPEC;
    }
    let emb_rel = icmp_rel + 8;
    let emb_off = data + emb_rel;
    let Some(emb_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(emb_ro.ver_tc_fl) >> 28) != 6 || !ipv6_eq(&emb_ro.src_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let udp_rel = if emb_ro.next_hdr == IPPROTO_UDP {
        emb_rel + 40
    } else {
        match unsafe { locate_ipv6_nexthdr(data, data_end, emb_rel, emb_ro.next_hdr, IPPROTO_UDP) }
        {
            Some(rel) => rel,
            None => return TC_ACT_UNSPEC,
        }
    };
    if udp_rel + 8 > pkt_end_off || !ensure_linear(&ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let emb_off = data + emb_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };

    let ext_port = u16::from_be(udph.src_port);
    if ext_port < cfg.min_port6 || ext_port > cfg.max_port6 {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = lookup_inbound_v6(ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let mut new_ip = [0u8; 16];
    copy_ipv6(&mut new_ip, unsafe { &(*target).ip });
    let new_port = unsafe { (*target).port };
    let now = now_sec();
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }

    let mut old_ip = [0u8; 16];
    copy_ipv6(&mut old_ip, &emb.src_addr);
    let mut old_outer_dst = [0u8; 16];
    copy_ipv6(&mut old_outer_dst, &iph.dst_addr);
    let old_port = udph.src_port;
    let old_udp_csum = udph.check;
    let new_udp_csum = if old_udp_csum == 0 {
        0
    } else {
        let mut c = csum_replace_ipv6_words(u16::from_be(old_udp_csum), &old_ip, &new_ip);
        c = csum_replace(c, u16::from_be(old_port), u16::from_be(new_port));
        u16::to_be(c)
    };

    copy_ipv6(&mut iph.dst_addr, &new_ip);
    copy_ipv6(&mut emb.src_addr, &new_ip);
    udph.src_port = new_port;
    udph.check = new_udp_csum;

    let icmp_csum_off = icmp_rel + 2;
    if !update_icmpv6_csums(
        &ctx,
        &Icmp6CsumUpdate {
            icmp_csum_off,
            old_outer_ip: &old_outer_dst,
            new_outer_ip: &new_ip,
            outer_changed: true,
            old_emb_ip: &old_ip,
            new_emb_ip: &new_ip,
            old_port,
            new_port,
            old_udp_csum,
            new_udp_csum,
        },
    ) {
        return TC_ACT_SHOT;
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Outbound ICMPv6 error translation target (RFC 5508 §4.1).
#[classifier]
pub fn flowcone_icmp6_egress_target(ctx: TcContext) -> i32 {
    let Some((cfg, l2)) = prepare_packet(&ctx) else {
        return TC_ACT_UNSPEC;
    };
    if cfg.enabled_v6 == 0 || l2.proto != ETH_P_IPV6 {
        return TC_ACT_UNSPEC;
    }
    let ip_rel = l2.ip_rel;
    let mut data = ctx.data();
    let mut data_end = ctx.data_end();
    if !ensure_linear(&ctx, &mut data, &mut data_end, ip_rel + 40) {
        return TC_ACT_UNSPEC;
    }
    pull_up_to(&ctx, &mut data, &mut data_end, ip_rel + 256);
    let ip_off = data + ip_rel;
    let Some(iph_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph_ro.ver_tc_fl) >> 28) != 6 {
        return TC_ACT_UNSPEC;
    }
    let allow_all_internal = cfg.enabled_v6 > 1;
    let mut old_outer_src = [0u8; 16];
    copy_ipv6(&mut old_outer_src, &iph_ro.src_addr);
    let outer_is_wan = ipv6_eq(&old_outer_src, &cfg.wan_ip6);
    if !outer_is_wan
        && !flowcone_common::is_routable_internal_ipv6(&old_outer_src, allow_all_internal)
    {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph_ro.payload_len) as usize;
    let pkt_end_off = ip_rel + 40 + payload_len;
    let icmp_rel = if iph_ro.next_hdr == IPPROTO_ICMPV6 {
        ip_rel + 40
    } else {
        match unsafe {
            locate_ipv6_nexthdr(data, data_end, ip_rel, iph_ro.next_hdr, IPPROTO_ICMPV6)
        } {
            Some(rel) => rel,
            None => return TC_ACT_UNSPEC,
        }
    };
    if icmp_rel + 8 + 40 + 8 > pkt_end_off
        || !ensure_linear(&ctx, &mut data, &mut data_end, icmp_rel + 8 + 40)
    {
        return TC_ACT_UNSPEC;
    }
    let Some(icmp_hdr) = (unsafe { parse_header_ref_mut::<[u8; 8]>(data + icmp_rel, data_end) })
    else {
        return TC_ACT_UNSPEC;
    };
    let ty = icmp_hdr[0];
    if ty != 1 && ty != 2 && ty != 3 && ty != 4 {
        return TC_ACT_UNSPEC;
    }
    let emb_rel = icmp_rel + 8;
    let emb_off = data + emb_rel;
    let Some(emb_ro) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(emb_ro.ver_tc_fl) >> 28) != 6 {
        return TC_ACT_UNSPEC;
    }
    let mut old_emb_dst = [0u8; 16];
    copy_ipv6(&mut old_emb_dst, &emb_ro.dst_addr);
    // Embedded source is the remote peer (must be global unicast 2000::/3,
    // never ULA/LL/MC/loopback).
    if !flowcone_common::is_routable_internal_ipv6(&old_emb_dst, allow_all_internal)
        || (emb_ro.src_addr[0] & 0xe0) != 0x20
    {
        return TC_ACT_UNSPEC;
    }
    let udp_rel = if emb_ro.next_hdr == IPPROTO_UDP {
        emb_rel + 40
    } else {
        match unsafe { locate_ipv6_nexthdr(data, data_end, emb_rel, emb_ro.next_hdr, IPPROTO_UDP) }
        {
            Some(rel) => rel,
            None => return TC_ACT_UNSPEC,
        }
    };
    if udp_rel + 8 > pkt_end_off || !ensure_linear(&ctx, &mut data, &mut data_end, udp_rel + 8) {
        return TC_ACT_UNSPEC;
    }
    let ip_off = data + ip_rel;
    let emb_off = data + emb_rel;
    let udp_off = data + udp_rel;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let old_port = udph.dst_port;

    let mut ep_key = EndpointKey6 {
        ip: [0; 16],
        port: old_port,
        _pad: 0,
    };
    copy_ipv6(&mut ep_key.ip, &old_emb_dst);
    let Some(target) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep_key) else {
        return TC_ACT_UNSPEC;
    };
    let mut target_ip = [0u8; 16];
    copy_ipv6(&mut target_ip, unsafe { &(*target).ip });
    let mapped_port = unsafe { (*target).port };
    let target_meta = unsafe { (*target).reserved_meta() };
    let res_state = port_reserved_state(&RESERVED_V6, u16::from_be(mapped_port));
    if mapped_port == 0
        || !ipv6_eq(&target_ip, &cfg.wan_ip6)
        || !flowcone_common::binding_matches_reserved(res_state, target_meta)
    {
        return TC_ACT_UNSPEC;
    }
    let now = now_sec();
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }

    let old_udp_csum = udph.check;
    let new_udp_csum = if old_udp_csum == 0 {
        0
    } else {
        let mut c = csum_replace_ipv6_words(u16::from_be(old_udp_csum), &old_emb_dst, &cfg.wan_ip6);
        c = csum_replace(c, u16::from_be(old_port), u16::from_be(mapped_port));
        u16::to_be(c)
    };

    if !outer_is_wan {
        copy_ipv6(&mut iph.src_addr, &cfg.wan_ip6);
    }
    copy_ipv6(&mut emb.dst_addr, &cfg.wan_ip6);
    udph.dst_port = mapped_port;
    udph.check = new_udp_csum;

    let icmp_csum_off = icmp_rel + 2;
    if !update_icmpv6_csums(
        &ctx,
        &Icmp6CsumUpdate {
            icmp_csum_off,
            old_outer_ip: &old_outer_src,
            new_outer_ip: &cfg.wan_ip6,
            outer_changed: !outer_is_wan,
            old_emb_ip: &old_emb_dst,
            new_emb_ip: &cfg.wan_ip6,
            old_port,
            new_port: mapped_port,
            old_udp_csum,
            new_udp_csum,
        },
    ) {
        return TC_ACT_SHOT;
    }
    TC_ACT_UNSPEC
}
