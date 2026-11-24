#![no_std]
#![no_main]
#![feature(asm_experimental_arch)]
#![allow(clippy::not_unsafe_ptr_arg_deref)]

pub mod engine;
pub mod parsing;

use aya_ebpf::{
    EbpfContext,
    bindings::{__sk_buff, TC_ACT_SHOT, TC_ACT_UNSPEC},
    macros::{classifier, map},
    maps::{Array, HashMap, LruHashMap, ProgramArray, RingBuf},
    programs::TcContext,
};
use core::mem;
use flowcone_common::{
    BindingValue4, BindingValue6, ETH_P_IP, ETH_P_IPV6, EndpointKey4, EndpointKey6,
    FRAG_MAP_ENTRIES, FragKey4, FragKey6, FragValue4, FragValue6, GlobalConfig, IPPROTO_ICMP,
    IPPROTO_ICMPV6, IPPROTO_UDP, MAX_BINDINGS, PORT_BITMAP_SLOTS, PORT_STATE_ENTRIES,
    SESSION_EVENT_RINGBUF_BYTES, csum_replace,
};

pub use engine::{
    EGRESS_ALLOC_FALLBACK, EGRESS_ALLOC_PRIMARY, FRAG_ALLOC_FALLBACK, FRAG_ALLOC_PRIMARY,
    FRAG6_ALLOC_FALLBACK, FRAG6_ALLOC_PRIMARY, fixup_csum_v4, fixup_csum_v6, fixup_l3_v4,
    get_or_create_mapping_v4, get_or_create_mapping_v6, is_short_lived_port, now_sec,
    port_is_reserved,
};
pub use parsing::{
    Ipv4Hdr, Ipv6Hdr, Ipv6L4, UdpHdr, bypass_special_udp4, bypass_special_udp6, ipv6_eq,
    ipv6_fragment_offset, locate_ipv6_l4, locate_ipv6_nexthdr, parse_header, parse_header_at,
    parse_header_at_mut, parse_header_mut, parse_header_ref, parse_header_ref_mut, parse_l2,
    read_be16, read_be32, read_u8,
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
pub const BPF_F_NO_PREALLOC: u32 = 1;
pub const BPF_F_NO_COMMON_LRU: u32 = 2;

pub const FRAG_TIMEOUT_SEC: u32 = 10;
pub const LAST_SEEN_INTERVAL_SEC: u32 = 1;

pub const FRAG6_TARGET_INGRESS: u32 = 0;
pub const FRAG6_TARGET_EGRESS: u32 = 1;

#[unsafe(link_section = "license")]
#[used]
static LICENSE: [u8; 4] = *b"GPL\0";

#[inline(always)]
fn get_mark(ctx: &TcContext) -> u32 {
    unsafe { (*(ctx.as_ptr() as *const __sk_buff)).mark }
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

/// Tail-call targets for TC dispatchers.
#[map]
pub static INGRESS_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);
#[map]
pub static EGRESS_TARGET: ProgramArray = ProgramArray::with_max_entries(1, 0);
#[map]
pub static FRAG_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);

#[map]
pub static FRAG6_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);
#[map]
pub static ICMP_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);
#[map]
pub static ICMP6_TARGET: ProgramArray = ProgramArray::with_max_entries(2, 0);

#[map]
pub static WAN_IP_ID: Array<u32> = Array::with_max_entries(1, 0);
#[map]
pub static WAN_FRAG_ID: Array<u32> = Array::with_max_entries(1, 0);

#[inline(always)]
pub fn alloc_wan_ip_id() -> u16 {
    if let Some(ptr) = WAN_IP_ID.get_ptr_mut(0) {
        unsafe {
            let inc: u32 = 1;
            core::arch::asm!(
                "lock *(u32 *)({p} + 0) += {inc}",
                p = in(reg) ptr,
                inc = in(reg) inc,
            );
            let val = (*ptr) as u16;
            if val == 0 { 1 } else { val }
        }
    } else {
        1
    }
}

#[inline(always)]
pub fn alloc_wan_frag_id() -> u32 {
    if let Some(ptr) = WAN_FRAG_ID.get_ptr_mut(0) {
        unsafe {
            let inc: u32 = 1;
            core::arch::asm!(
                "lock *(u32 *)({p} + 0) += {inc}",
                p = in(reg) ptr,
                inc = in(reg) inc,
            );
            let val = *ptr;
            if val == 0 { 1 } else { val }
        }
    } else {
        1
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

/// Bitmap of ports reserved for host UDP services.
#[map]
pub static RESERVED_V4: Array<u8> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

#[map]
pub static RESERVED_V6: Array<u8> = Array::with_max_entries(PORT_STATE_ENTRIES, 0);

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

#[classifier]
pub fn flowcone_tcx_ingress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };

    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
        let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
            return TC_ACT_UNSPEC;
        };
        let udp_off = if iph.ver_ihl == 0x45 {
            ip_off + 20
        } else {
            if (iph.ver_ihl >> 4) != 4 {
                return TC_ACT_UNSPEC;
            }
            let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
            if ihl < 20 {
                return TC_ACT_UNSPEC;
            }
            ip_off + ihl
        };
        let proto = iph.protocol;
        if proto != IPPROTO_UDP {
            if proto == IPPROTO_ICMP && iph.dst_addr == cfg.wan_ip4 {
                unsafe {
                    ICMP_TARGET.tail_call(&ctx, 0);
                }
            }
            return TC_ACT_UNSPEC;
        }
        if iph.dst_addr != cfg.wan_ip4 {
            return TC_ACT_UNSPEC;
        }

        let tot_len = u16::from_be(iph.tot_len) as usize;
        let ihl = udp_off - ip_off;
        if tot_len < ihl + 8 {
            return TC_ACT_UNSPEC;
        }

        let frag_off = u16::from_be(iph.frag_off);
        if (frag_off & 0x3fff) != 0 {
            unsafe {
                FRAG_TARGET.tail_call(&ctx, 0);
            }
            return TC_ACT_UNSPEC;
        }

        let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
            return TC_ACT_UNSPEC;
        };
        let ext_port = u16::from_be(udph.dst_port);
        if ext_port < cfg.min_port4 || ext_port > cfg.max_port4 {
            return TC_ACT_UNSPEC;
        }
        if port_is_reserved(&RESERVED_V4, ext_port) {
            return TC_ACT_UNSPEC;
        }

        if let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(&ext_port) {
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

            let mark = get_mark(&ctx);
            ctx.skb.set_mark(mark | cfg.flowcone_mark);
        }
    } else if l2.proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        let data = ctx.data();
        let data_end = ctx.data_end();
        let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
            return TC_ACT_UNSPEC;
        };
        if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
            return TC_ACT_UNSPEC;
        }
        if !ipv6_eq(&iph.dst_addr, &cfg.wan_ip6) {
            return TC_ACT_UNSPEC;
        }

        let udp_off = if iph.next_hdr == IPPROTO_UDP {
            ip_off + 40
        } else {
            let nh = iph.next_hdr;
            if nh == 58 {
                unsafe {
                    ICMP6_TARGET.tail_call(&ctx, 0);
                }
                return TC_ACT_UNSPEC;
            }
            if nh == 44 {
                unsafe {
                    FRAG6_TARGET.tail_call(&ctx, FRAG6_TARGET_INGRESS);
                }
                return TC_ACT_UNSPEC;
            }
            match locate_ipv6_l4(data_end, ip_off, nh) {
                Ipv6L4::Udp(off) => off,
                Ipv6L4::Fragment => {
                    unsafe {
                        FRAG6_TARGET.tail_call(&ctx, FRAG6_TARGET_INGRESS);
                    }
                    return TC_ACT_UNSPEC;
                }
                Ipv6L4::Icmp6(_) => {
                    unsafe {
                        ICMP6_TARGET.tail_call(&ctx, 0);
                    }
                    return TC_ACT_UNSPEC;
                }
                Ipv6L4::NonUdp | Ipv6L4::Unsupported => return TC_ACT_UNSPEC,
            }
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
        if port_is_reserved(&RESERVED_V6, ext_port) {
            return TC_ACT_UNSPEC;
        }

        if let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(&ext_port) {
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

            let mark = get_mark(&ctx);
            ctx.skb.set_mark(mark | cfg.flowcone_mark);
        }
    }

    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_egress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };

    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
        let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
            return TC_ACT_UNSPEC;
        };
        if iph.protocol != IPPROTO_UDP {
            if iph.protocol == IPPROTO_ICMP {
                unsafe {
                    ICMP_TARGET.tail_call(&ctx, 1);
                }
            }
            return TC_ACT_UNSPEC;
        }
        let udp_off = if iph.ver_ihl == 0x45 {
            ip_off + 20
        } else {
            if (iph.ver_ihl >> 4) != 4 {
                return TC_ACT_UNSPEC;
            }
            let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
            if ihl < 20 {
                return TC_ACT_UNSPEC;
            }
            ip_off + ihl
        };

        let src_ip = iph.src_addr;
        if src_ip == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(src_ip) {
            return TC_ACT_UNSPEC;
        }

        let tot_len = u16::from_be(iph.tot_len) as usize;
        let ihl = udp_off - ip_off;
        if tot_len < ihl + 8 {
            return TC_ACT_UNSPEC;
        }

        let frag_off = u16::from_be(iph.frag_off);
        if (frag_off & 0x3fff) != 0 {
            unsafe {
                FRAG_TARGET.tail_call(&ctx, 1);
            }
            return TC_ACT_SHOT;
        }

        let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
            return TC_ACT_SHOT;
        };
        let src_port = udph.src_port;

        if bypass_special_udp4(src_ip, iph.dst_addr, src_port, udph.dst_port) {
            return TC_ACT_UNSPEC;
        }

        let mapped_port =
            match get_or_create_mapping_v4::<EGRESS_ALLOC_PRIMARY, EGRESS_ALLOC_FALLBACK>(
                cfg,
                src_ip,
                src_port,
                now_sec(),
                is_short_lived_port(u16::from_be(udph.dst_port)),
            ) {
                Some(p) => p,
                None => return TC_ACT_SHOT,
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
        let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
            return TC_ACT_UNSPEC;
        };
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
        let (udp_off, is_frag) = if iph.next_hdr == IPPROTO_UDP {
            (ip_off + 40, false)
        } else if iph.next_hdr == 44 {
            (0, true)
        } else if iph.next_hdr == IPPROTO_ICMPV6 {
            unsafe {
                ICMP6_TARGET.tail_call(&ctx, 1);
            }
            return TC_ACT_UNSPEC;
        } else {
            match locate_ipv6_l4(data_end, ip_off, iph.next_hdr) {
                Ipv6L4::Udp(off) => (off, false),
                Ipv6L4::Fragment => (0, true),
                Ipv6L4::Icmp6(_) => {
                    unsafe {
                        ICMP6_TARGET.tail_call(&ctx, 1);
                    }
                    return TC_ACT_UNSPEC;
                }
                Ipv6L4::NonUdp | Ipv6L4::Unsupported => return TC_ACT_UNSPEC,
            }
        };
        if is_frag {
            unsafe {
                FRAG6_TARGET.tail_call(&ctx, FRAG6_TARGET_EGRESS);
            }
            return TC_ACT_SHOT;
        }

        let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
            return TC_ACT_SHOT;
        };
        if udph.check == 0 {
            return TC_ACT_SHOT;
        }

        let src_addr = iph.src_addr;
        let src_port = udph.src_port;

        if bypass_special_udp6(&src_addr, &iph.dst_addr, src_port, udph.dst_port) {
            return TC_ACT_UNSPEC;
        }
        let mapped_port =
            match get_or_create_mapping_v6::<EGRESS_ALLOC_PRIMARY, EGRESS_ALLOC_FALLBACK>(
                cfg,
                src_addr,
                src_port,
                now_sec(),
                is_short_lived_port(u16::from_be(udph.dst_port)),
            ) {
                Some(p) => p,
                None => return TC_ACT_SHOT,
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

#[classifier]
pub fn flowcone_frag_v6_ingress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }
    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    if l2.proto != ETH_P_IPV6 || cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_off = l2.ip_off;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
        return TC_ACT_UNSPEC;
    }
    let Some(frag_off) = ipv6_fragment_offset(data_end, ip_off, iph.next_hdr) else {
        return TC_ACT_UNSPEC;
    };
    if frag_off + 8 > data_end {
        return TC_ACT_UNSPEC;
    }
    let next_hdr = read_u8(frag_off);
    if next_hdr != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    let frag_field = read_be16(frag_off + 2);
    let offset = frag_field & 0xfff8;
    let more = (frag_field & 1) != 0;
    let id = read_be32(frag_off + 4);
    if !ipv6_eq(&iph.dst_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let key = FragKey6 {
        epoch: cfg.frag_epoch,
        src: iph.src_addr,
        dst: iph.dst_addr,
        id,
        proto: next_hdr,
        _pad: [0; 3],
    };
    let now = now_sec();

    if offset != 0 {
        if let Some(v_ptr) = FRAG_IN_V6.get_ptr_mut(&key) {
            let v = unsafe { *v_ptr };
            if now.saturating_sub(v.last_seen) <= FRAG_TIMEOUT_SEC {
                unsafe {
                    (*v_ptr).last_seen = now;
                }
                iph.dst_addr = v.ip;
                let mark = get_mark(&ctx);
                ctx.skb.set_mark(mark | cfg.flowcone_mark);
            }
        }
        return TC_ACT_UNSPEC;
    }
    let udp_off = frag_off + 8;
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
    if port_is_reserved(&RESERVED_V6, ext_port) {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(&ext_port) else {
        return TC_ACT_UNSPEC;
    };
    let new_ip = unsafe { (*target).ip };
    let new_port = unsafe { (*target).port };
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }
    let old_ip = iph.dst_addr;
    let old_port = udph.dst_port;
    iph.dst_addr = new_ip;
    udph.dst_port = new_port;
    if !fixup_csum_v6(&ctx, data, udp_off, &old_ip, &new_ip, old_port, new_port) {
        return TC_ACT_SHOT;
    }
    let value = FragValue6 {
        ip: new_ip,
        wan_id: 0,
        last_seen: now,
    };
    if more {
        let _ = FRAG_IN_V6.insert(&key, &value, BPF_ANY);
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_frag_v6_egress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }
    let l2 = match parse_l2(data, data_end, cfg.l2_len) {
        Some(v) => v,
        None => return TC_ACT_UNSPEC,
    };
    if l2.proto != ETH_P_IPV6 || cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    let ip_off = l2.ip_off;
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
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
    let Some(frag_off) = ipv6_fragment_offset(data_end, ip_off, iph.next_hdr) else {
        return TC_ACT_UNSPEC;
    };
    if frag_off + 8 > data_end {
        return TC_ACT_UNSPEC;
    }
    let next_hdr = read_u8(frag_off);
    if next_hdr != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    let frag_field = read_be16(frag_off + 2);
    let offset = frag_field & 0xfff8;
    let more = (frag_field & 1) != 0;
    let id = read_be32(frag_off + 4);
    let key = FragKey6 {
        epoch: cfg.frag_epoch,
        src: src_ip,
        dst: iph.dst_addr,
        id,
        proto: next_hdr,
        _pad: [0; 3],
    };
    let now = now_sec();

    if offset != 0 {
        let Some(v_ptr) = FRAG_OUT_V6.get_ptr_mut(&key) else {
            return TC_ACT_SHOT;
        };
        let v = unsafe { *v_ptr };
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
        iph.src_addr = v.ip;
        let id_ptr = (frag_off + 4) as *mut u32;
        unsafe {
            core::ptr::write_unaligned(id_ptr, u32::to_be(v.wan_id));
        }
        let mark = get_mark(&ctx);
        ctx.skb.set_mark(mark | cfg.flowcone_mark);
        return TC_ACT_UNSPEC;
    }
    let udp_off = frag_off + 8;
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_SHOT;
    };
    if udph.check == 0 {
        return TC_ACT_SHOT;
    }
    let src_port = udph.src_port;
    if bypass_special_udp6(&src_ip, &iph.dst_addr, src_port, udph.dst_port) {
        let value = FragValue6 {
            ip: [0; 16],
            wan_id: 0,
            last_seen: now,
        };
        if more {
            let _ = FRAG_OUT_V6.insert(&key, &value, BPF_ANY);
        }
        return TC_ACT_UNSPEC;
    }
    let mapped = match get_or_create_mapping_v6::<FRAG6_ALLOC_PRIMARY, FRAG6_ALLOC_FALLBACK>(
        cfg,
        src_ip,
        src_port,
        now,
        is_short_lived_port(u16::from_be(udph.dst_port)),
    ) {
        Some(p) => p,
        None => return TC_ACT_SHOT,
    };
    let old_src = iph.src_addr;
    let old_sport = udph.src_port;
    let wan_id = alloc_wan_frag_id();
    let id_ptr = (frag_off + 4) as *mut u32;
    unsafe {
        core::ptr::write_unaligned(id_ptr, u32::to_be(wan_id));
    }
    iph.src_addr = cfg.wan_ip6;
    udph.src_port = mapped;
    if !fixup_csum_v6(
        &ctx,
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
        wan_id,
        last_seen: now,
    };
    if more {
        let _ = FRAG_OUT_V6.insert(&key, &value, BPF_ANY);
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Inbound IPv4 fragment NAT handler.
#[classifier]
pub fn flowcone_frag_v4_ingress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    if iph.dst_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    let frag_off = u16::from_be(iph.frag_off);
    let offset = frag_off & 0x1fff;
    let more = (frag_off & 0x2000) != 0;

    let key = FragKey4 {
        epoch: cfg.frag_epoch,
        src: iph.src_addr,
        dst: iph.dst_addr,
        id: iph.id,
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
                let old = iph.dst_addr;
                iph.dst_addr = v.ip;
                if !fixup_l3_v4(&ctx, data, ip_off, old, v.ip) {
                    return TC_ACT_SHOT;
                }
                let mark = get_mark(&ctx);
                ctx.skb.set_mark(mark | cfg.flowcone_mark);
            }
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
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ext_port = u16::from_be(udph.dst_port);
    if ext_port < cfg.min_port4 || ext_port > cfg.max_port4 {
        return TC_ACT_UNSPEC;
    }
    if port_is_reserved(&RESERVED_V4, ext_port) {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(&ext_port) else {
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
        wan_id: 0,
        _pad: 0,
        last_seen: now,
    };
    if more {
        let _ = FRAG_IN_V4.insert(&key, &value, BPF_ANY);
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Outbound IPv4 fragment NAT handler.
#[classifier]
pub fn flowcone_frag_v4_egress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_UDP {
        return TC_ACT_UNSPEC;
    }
    let src_ip = iph.src_addr;
    if src_ip == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(src_ip) {
        return TC_ACT_UNSPEC;
    }
    let frag_off = u16::from_be(iph.frag_off);
    let offset = frag_off & 0x1fff;
    let more = (frag_off & 0x2000) != 0;

    let key = FragKey4 {
        epoch: cfg.frag_epoch,
        src: src_ip,
        dst: iph.dst_addr,
        id: iph.id,
        proto: IPPROTO_UDP,
        _pad: 0,
    };
    let now = now_sec();

    if offset != 0 {
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
        let old_src = iph.src_addr;
        let old_id = iph.id;
        let new_id = u16::to_be(v.wan_id);
        iph.src_addr = v.ip;
        iph.id = new_id;
        if !fixup_l3_v4(&ctx, data, ip_off, old_src, v.ip) {
            return TC_ACT_SHOT;
        }
        let l3_csum_off = ip_off - data + IPV4_CSUM_OFFSET;
        let _ = ctx
            .skb
            .l3_csum_replace(l3_csum_off, old_id as u64, new_id as u64, CSUM_FIELD_U16);

        let mark = get_mark(&ctx);
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
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_SHOT;
    };
    let src_port = udph.src_port;
    if bypass_special_udp4(src_ip, iph.dst_addr, src_port, udph.dst_port) {
        let value = FragValue4 {
            ip: 0,
            wan_id: 0,
            _pad: 0,
            last_seen: now,
        };
        let _ = FRAG_OUT_V4.insert(&key, &value, BPF_ANY);
        return TC_ACT_UNSPEC;
    }
    let mapped = match get_or_create_mapping_v4::<FRAG_ALLOC_PRIMARY, FRAG_ALLOC_FALLBACK>(
        cfg,
        src_ip,
        src_port,
        now,
        is_short_lived_port(u16::from_be(udph.dst_port)),
    ) {
        Some(p) => p,
        None => return TC_ACT_SHOT,
    };
    let old_src = iph.src_addr;
    let old_sport = udph.src_port;
    let old_id = iph.id;
    let wan_id = alloc_wan_ip_id();
    let new_id = u16::to_be(wan_id);

    iph.src_addr = cfg.wan_ip4;
    iph.id = new_id;
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
    let l3_csum_off = ip_off - data + IPV4_CSUM_OFFSET;
    let _ = ctx
        .skb
        .l3_csum_replace(l3_csum_off, old_id as u64, new_id as u64, CSUM_FIELD_U16);

    let value = FragValue4 {
        ip: cfg.wan_ip4,
        wan_id,
        _pad: 0,
        last_seen: now,
    };
    let _ = FRAG_OUT_V4.insert(&key, &value, BPF_ANY);
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Inbound ICMP error translation target (RFC 5508).
#[classifier]
pub fn flowcone_icmp_target(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
    if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_ICMP || ihl < 20 {
        return TC_ACT_UNSPEC;
    }
    if iph.dst_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    let icmp_off = ip_off + ihl;
    let tot_len = u16::from_be(iph.tot_len) as usize;
    if tot_len < ihl + 8 + 28 || icmp_off + 36 > data_end {
        return TC_ACT_UNSPEC;
    }
    let Some(icmph) = (unsafe { parse_header_ref_mut::<[u8; 8]>(icmp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ty = icmph[0];
    if ty != 3 && ty != 11 && ty != 12 {
        return TC_ACT_UNSPEC;
    }
    let emb_off = icmp_off + 8;
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let emb_ihl = (emb.ver_ihl & 0x0f) as usize * 4;
    if (emb.ver_ihl >> 4) != 4 || emb.protocol != IPPROTO_UDP || emb_ihl < 20 {
        return TC_ACT_UNSPEC;
    }
    if emb.src_addr != cfg.wan_ip4 {
        return TC_ACT_UNSPEC;
    }
    let emb_udp = emb_off + emb_ihl;
    if ihl + 8 + emb_ihl + mem::size_of::<UdpHdr>() > tot_len
        || emb_udp + mem::size_of::<UdpHdr>() > data_end
    {
        return TC_ACT_UNSPEC;
    }
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(emb_udp, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ext_port = u16::from_be(udph.src_port);
    if ext_port < cfg.min_port4 || ext_port > cfg.max_port4 {
        return TC_ACT_UNSPEC;
    }
    if port_is_reserved(&RESERVED_V4, ext_port) {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(&ext_port) else {
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

    // Embedded IPv4 header checksum (RFC 1624).
    let mut ec = u16::from_be(old_emb_check);
    let ob = old_emb_src.to_ne_bytes();
    let nb = new_ip.to_ne_bytes();
    ec = csum_replace(
        ec,
        u16::from_be_bytes([ob[0], ob[1]]),
        u16::from_be_bytes([nb[0], nb[1]]),
    );
    ec = csum_replace(
        ec,
        u16::from_be_bytes([ob[2], ob[3]]),
        u16::from_be_bytes([nb[2], nb[3]]),
    );
    emb.check = if ec == 0 { 0xffff } else { u16::to_be(ec) };

    // Embedded UDP checksum.
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

    // Update outer ICMP checksum for changed embedded IP/UDP fields.
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
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Outbound ICMP error translation target (RFC 5508 §4.1).
#[classifier]
pub fn flowcone_icmp_egress_target(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ihl = (iph.ver_ihl & 0x0f) as usize * 4;
    if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_ICMP || ihl < 20 {
        return TC_ACT_UNSPEC;
    }
    let old_src = iph.src_addr;
    if old_src == cfg.wan_ip4 || !flowcone_common::is_private_ipv4(old_src) {
        return TC_ACT_UNSPEC;
    }
    let icmp_off = ip_off + ihl;
    let tot_len = u16::from_be(iph.tot_len) as usize;
    if tot_len < ihl + 8 + 28 || icmp_off + 36 > data_end {
        return TC_ACT_UNSPEC;
    }
    let Some(icmph) = (unsafe { parse_header_ref_mut::<[u8; 8]>(icmp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ty = icmph[0];
    if ty != 3 && ty != 11 && ty != 12 {
        return TC_ACT_UNSPEC;
    }
    let emb_off = icmp_off + 8;
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv4Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let emb_ihl = (emb.ver_ihl & 0x0f) as usize * 4;
    if (emb.ver_ihl >> 4) != 4 || emb.protocol != IPPROTO_UDP || emb_ihl < 20 {
        return TC_ACT_UNSPEC;
    }
    let old_emb_dst = emb.dst_addr;
    if old_emb_dst != old_src {
        return TC_ACT_UNSPEC;
    }
    let emb_udp = emb_off + emb_ihl;
    if ihl + 8 + emb_ihl + mem::size_of::<UdpHdr>() > tot_len
        || emb_udp + mem::size_of::<UdpHdr>() > data_end
    {
        return TC_ACT_UNSPEC;
    }
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
    let mapped_port = unsafe { (*target).port };
    let now = now_sec();
    unsafe {
        if now.wrapping_sub((*target).last_seen) >= LAST_SEEN_INTERVAL_SEC {
            (*target).last_seen = now;
        }
    }

    let old_emb_check = emb.check;
    let old_udp_csum = udph.check;

    iph.src_addr = cfg.wan_ip4;
    emb.dst_addr = cfg.wan_ip4;
    udph.dst_port = mapped_port;

    // Embedded IPv4 header checksum (RFC 1624).
    let mut ec = u16::from_be(old_emb_check);
    let ob = old_emb_dst.to_ne_bytes();
    let nb = cfg.wan_ip4.to_ne_bytes();
    ec = csum_replace(
        ec,
        u16::from_be_bytes([ob[0], ob[1]]),
        u16::from_be_bytes([nb[0], nb[1]]),
    );
    ec = csum_replace(
        ec,
        u16::from_be_bytes([ob[2], ob[3]]),
        u16::from_be_bytes([nb[2], nb[3]]),
    );
    emb.check = if ec == 0 { 0xffff } else { u16::to_be(ec) };

    // Embedded UDP checksum.
    let new_udp_csum = if old_udp_csum != 0 {
        let mut c = u16::from_be(old_udp_csum);
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
        c = csum_replace(c, u16::from_be(old_emb_dport), u16::from_be(mapped_port));
        if c == 0 { 0xffff } else { u16::to_be(c) }
    } else {
        0
    };
    udph.check = new_udp_csum;

    // Update outer ICMP checksum for changed embedded IP/UDP fields.
    let icmp_csum_off = icmp_off - data + 2;
    let new_emb_check = emb.check;
    if ctx
        .skb
        .l4_csum_replace(
            icmp_csum_off,
            old_emb_dst as u64,
            cfg.wan_ip4 as u64,
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
                old_emb_dport as u64,
                mapped_port as u64,
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

    if !fixup_l3_v4(&ctx, data, ip_off, old_src, cfg.wan_ip4) {
        return TC_ACT_SHOT;
    }
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// TCX dispatchers for atomic reload.
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
    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
    if ip_off + 40 > data_end {
        return TC_ACT_UNSPEC;
    }
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 || !ipv6_eq(&iph.dst_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph.payload_len) as usize;
    if payload_len < 56 {
        return TC_ACT_UNSPEC;
    }
    let icmp_off = if iph.next_hdr == 58 {
        ip_off + 40
    } else {
        match locate_ipv6_nexthdr(data_end, ip_off, iph.next_hdr, 58) {
            Some(off) => off,
            None => return TC_ACT_UNSPEC,
        }
    };
    if icmp_off + 8 > data_end {
        return TC_ACT_UNSPEC;
    }
    let ty = read_u8(icmp_off);
    if ty != 1 && ty != 2 && ty != 3 && ty != 4 {
        return TC_ACT_UNSPEC;
    }
    let emb_off = icmp_off + 8;
    if emb_off + 40 > data_end {
        return TC_ACT_UNSPEC;
    }
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(emb.ver_tc_fl) >> 28) != 6 || !ipv6_eq(&emb.src_addr, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let udp_off = if emb.next_hdr == IPPROTO_UDP {
        emb_off + 40
    } else {
        match locate_ipv6_nexthdr(data_end, emb_off, emb.next_hdr, IPPROTO_UDP) {
            Some(off) => off,
            None => return TC_ACT_UNSPEC,
        }
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let ext_port = u16::from_be(udph.src_port);
    if ext_port < cfg.min_port6 || ext_port > cfg.max_port6 {
        return TC_ACT_UNSPEC;
    }
    if port_is_reserved(&RESERVED_V6, ext_port) {
        return TC_ACT_UNSPEC;
    }
    let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(&ext_port) else {
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
                CSUM_FIELD_U32,
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
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}

/// Outbound ICMPv6 error translation target (RFC 5508 §4.1).
#[classifier]
pub fn flowcone_icmp6_egress_target(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();
    let cfg = match get_config() {
        Some(c) => c,
        None => return TC_ACT_UNSPEC,
    };
    if cfg.enabled_v6 == 0 {
        return TC_ACT_UNSPEC;
    }
    if cfg.bypass_mark_mask != 0 {
        let mark = get_mark(&ctx);
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
    if ip_off + 40 > data_end {
        return TC_ACT_UNSPEC;
    }
    let Some(iph) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(ip_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
        return TC_ACT_UNSPEC;
    }
    let payload_len = u16::from_be(iph.payload_len) as usize;
    if payload_len < 56 {
        return TC_ACT_UNSPEC;
    }
    let old_outer_src = iph.src_addr;
    if ipv6_eq(&old_outer_src, &cfg.wan_ip6) {
        return TC_ACT_UNSPEC;
    }
    let allow_all_internal = cfg.enabled_v6 > 1;
    if !flowcone_common::is_routable_internal_ipv6(&old_outer_src, allow_all_internal) {
        return TC_ACT_UNSPEC;
    }
    let icmp_off = if iph.next_hdr == 58 {
        ip_off + 40
    } else {
        match locate_ipv6_nexthdr(data_end, ip_off, iph.next_hdr, 58) {
            Some(off) => off,
            None => return TC_ACT_UNSPEC,
        }
    };
    if icmp_off + 8 > data_end {
        return TC_ACT_UNSPEC;
    }
    let ty = read_u8(icmp_off);
    if ty != 1 && ty != 2 && ty != 3 && ty != 4 {
        return TC_ACT_UNSPEC;
    }
    let emb_off = icmp_off + 8;
    if emb_off + 40 > data_end {
        return TC_ACT_UNSPEC;
    }
    let Some(emb) = (unsafe { parse_header_ref_mut::<Ipv6Hdr>(emb_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    if (u32::from_be(emb.ver_tc_fl) >> 28) != 6 {
        return TC_ACT_UNSPEC;
    }
    let old_emb_dst = emb.dst_addr;
    if !ipv6_eq(&old_emb_dst, &old_outer_src) {
        return TC_ACT_UNSPEC;
    }
    let udp_off = if emb.next_hdr == IPPROTO_UDP {
        emb_off + 40
    } else {
        match locate_ipv6_nexthdr(data_end, emb_off, emb.next_hdr, IPPROTO_UDP) {
            Some(off) => off,
            None => return TC_ACT_UNSPEC,
        }
    };
    let Some(udph) = (unsafe { parse_header_ref_mut::<UdpHdr>(udp_off, data_end) }) else {
        return TC_ACT_UNSPEC;
    };
    let old_port = udph.dst_port;

    let ep_key = EndpointKey6 {
        ip: old_emb_dst,
        port: old_port,
        _pad: [0; 3],
    };
    let Some(target) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep_key) else {
        return TC_ACT_UNSPEC;
    };
    let mapped_port = unsafe { (*target).port };
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
        let mut c = u16::from_be(old_udp_csum);
        let mut i = 0usize;
        while i < 8 {
            let os = u16::from_be_bytes([old_emb_dst[i * 2], old_emb_dst[i * 2 + 1]]);
            let ns = u16::from_be_bytes([cfg.wan_ip6[i * 2], cfg.wan_ip6[i * 2 + 1]]);
            c = csum_replace(c, os, ns);
            i += 1;
        }
        c = csum_replace(c, u16::from_be(old_port), u16::from_be(mapped_port));
        if c == 0 { 0xffff } else { u16::to_be(c) }
    };

    iph.src_addr = cfg.wan_ip6;
    emb.dst_addr = cfg.wan_ip6;
    udph.dst_port = mapped_port;
    udph.check = new_udp_csum;

    let icmp_csum_off = icmp_off - data + 2;
    let mut i = 0usize;
    while i < 4 {
        let oo = u32::from_ne_bytes([
            old_outer_src[i * 4],
            old_outer_src[i * 4 + 1],
            old_outer_src[i * 4 + 2],
            old_outer_src[i * 4 + 3],
        ]);
        let no = u32::from_ne_bytes([
            cfg.wan_ip6[i * 4],
            cfg.wan_ip6[i * 4 + 1],
            cfg.wan_ip6[i * 4 + 2],
            cfg.wan_ip6[i * 4 + 3],
        ]);
        let os = u32::from_ne_bytes([
            old_emb_dst[i * 4],
            old_emb_dst[i * 4 + 1],
            old_emb_dst[i * 4 + 2],
            old_emb_dst[i * 4 + 3],
        ]);
        if ctx
            .skb
            .l4_csum_replace(
                icmp_csum_off,
                oo as u64,
                no as u64,
                CSUM_FIELD_U32,
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
            mapped_port as u64,
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
    let mark = get_mark(&ctx);
    ctx.skb.set_mark(mark | cfg.flowcone_mark);
    TC_ACT_UNSPEC
}
