use aya_ebpf::{helpers::bpf_ktime_get_coarse_ns, maps::Array, programs::TcContext};
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, GlobalConfig, SessionEvent4,
    SessionEvent6,
};

use crate::parsing::ipv6_eq;
use crate::{
    BITMAP_EVEN_V4, BITMAP_EVEN_V6, BITMAP_ODD_V4, BITMAP_ODD_V6, BPF_F_MARK_MANGLED_0,
    BPF_NOEXIST, CSUM_FIELD_U16, CSUM_FIELD_U32, GC_FLAGS, INBOUND_BINDINGS_V4,
    INBOUND_BINDINGS_V6, IPV4_CSUM_OFFSET, LAST_SEEN_INTERVAL_SEC, OUTBOUND_BINDINGS_V4,
    OUTBOUND_BINDINGS_V6, PORT_FLAGS, RESERVED_V4, RESERVED_V6, SESSION_EVENTS_V4,
    SESSION_EVENTS_V6, UDP_CSUM_OFFSET,
};

pub const EGRESS_ALLOC_PRIMARY: usize = 4;
pub const EGRESS_ALLOC_FALLBACK: usize = 2;
pub const FRAG_ALLOC_PRIMARY: usize = 4;
pub const FRAG_ALLOC_FALLBACK: usize = 2;
pub const FRAG6_ALLOC_PRIMARY: usize = 4;
pub const FRAG6_ALLOC_FALLBACK: usize = 2;

#[inline(always)]
pub fn now_sec() -> u32 {
    (unsafe { bpf_ktime_get_coarse_ns() } / 1_000_000_000) as u32
}

#[inline(always)]
pub fn is_short_lived_port(dst_port: u16) -> bool {
    dst_port == 53
}

#[inline(always)]
pub fn push_event_v4(key: &EndpointKey4, port: u16, flags: u16) {
    let event = SessionEvent4 {
        key: *key,
        port,
        _pad: flags,
    };
    if SESSION_EVENTS_V4.output(&event, 0).is_err() {
        let _ = GC_FLAGS.set(0, &1, 0);
    }
}

#[inline(always)]
pub fn push_event_v6(key: &EndpointKey6, port: u16, flags: u16) {
    let event = SessionEvent6 {
        key: *key,
        port,
        _pad: [flags, 0, 0],
    };
    if SESSION_EVENTS_V6.output(&event, 0).is_err() {
        let _ = GC_FLAGS.set(0, &1, 0);
    }
}

/// Fix up the IPv4 header and UDP checksums after an address/port rewrite.
/// Must be the last packet access: the helpers may linearize the skb.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
pub fn fixup_csum_v4(
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
    if ctx
        .skb
        .l3_csum_replace(l3_off, old_ip as u64, new_ip as u64, CSUM_FIELD_U32)
        .is_err()
    {
        return false;
    }

    let l4_off = udp_off - data + UDP_CSUM_OFFSET;

    // Note: BPF_F_PSEUDO_HDR is omitted to avoid kernel -EINVAL on VLAN / PPPoE encapsulation (skb->protocol != ETH_P_IP).
    // BPF_F_MARK_MANGLED_0 preserves 0x0000 UDP checksums (RFC 768 disabled) without corruption, and converts folded 0 to 0xffff.
    ctx.skb
        .l4_csum_replace(
            l4_off,
            old_ip as u64,
            new_ip as u64,
            BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U32,
        )
        .is_ok()
        && (old_port == new_port
            || ctx
                .skb
                .l4_csum_replace(
                    l4_off,
                    old_port as u64,
                    new_port as u64,
                    BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U16,
                )
                .is_ok())
}

/// Fix up IPv4 header checksum for non-initial fragments.
#[inline(always)]
pub fn fixup_l3_v4(ctx: &TcContext, data: usize, ip_off: usize, old_ip: u32, new_ip: u32) -> bool {
    ctx.skb
        .l3_csum_replace(
            ip_off - data + IPV4_CSUM_OFFSET,
            old_ip as u64,
            new_ip as u64,
            CSUM_FIELD_U32,
        )
        .is_ok()
}

#[inline(always)]
pub fn fixup_csum_v6(
    ctx: &TcContext,
    data: usize,
    udp_off: usize,
    old_ip: &[u8; 16],
    new_ip: &[u8; 16],
    old_port: u16,
    new_port: u16,
) -> bool {
    let l4_off = udp_off - data + UDP_CSUM_OFFSET;

    let mut i = 0;
    while i < 4 {
        let f = u32::from_ne_bytes([
            old_ip[i * 4],
            old_ip[i * 4 + 1],
            old_ip[i * 4 + 2],
            old_ip[i * 4 + 3],
        ]);
        let t = u32::from_ne_bytes([
            new_ip[i * 4],
            new_ip[i * 4 + 1],
            new_ip[i * 4 + 2],
            new_ip[i * 4 + 3],
        ]);
        if ctx
            .skb
            .l4_csum_replace(
                l4_off,
                f as u64,
                t as u64,
                BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U32,
            )
            .is_err()
        {
            return false;
        }
        i += 1;
    }

    old_port == new_port
        || ctx
            .skb
            .l4_csum_replace(
                l4_off,
                old_port as u64,
                new_port as u64,
                BPF_F_MARK_MANGLED_0 | CSUM_FIELD_U16,
            )
            .is_ok()
}

#[inline(always)]
pub fn port_is_reserved(reserved: &Array<u8>, port: u16) -> bool {
    reserved.get(port as u32).copied().unwrap_or(0) != 0
}

#[inline(always)]
pub fn bitmap_set_bit(map: &Array<u64>, slot: u32, mask: u64) {
    if let Some(p) = map.get_ptr_mut(slot) {
        unsafe {
            core::arch::asm!(
                "lock *(u64 *)({p} + 0) |= {mask}",
                p = in(reg) p,
                mask = in(reg) mask,
            );
        }
    }
}

#[inline(always)]
pub fn bitmap_clear_bit(map: &Array<u64>, slot: u32, mask: u64) {
    if let Some(p) = map.get_ptr_mut(slot) {
        let neg = !mask;
        unsafe {
            core::arch::asm!(
                "lock *(u64 *)({p} + 0) &= {neg}",
                p = in(reg) p,
                neg = in(reg) neg,
            );
        }
    }
}

#[inline(always)]
pub fn release_port_v4(port: u16) {
    if port_is_reserved(&RESERVED_V4, port) {
        return;
    }
    let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(port);
    let map = if is_even {
        &BITMAP_EVEN_V4
    } else {
        &BITMAP_ODD_V4
    };
    bitmap_clear_bit(map, slot, mask);
}

#[inline(always)]
pub fn release_port_v6(port: u16) {
    if port_is_reserved(&RESERVED_V6, port) {
        return;
    }
    let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(port);
    let map = if is_even {
        &BITMAP_EVEN_V6
    } else {
        &BITMAP_ODD_V6
    };
    bitmap_clear_bit(map, slot, mask);
}

macro_rules! try_alloc_slot {
    (
        $map:expr,
        $reserved:expr,
        $inbound:expr,
        $in_val:expr,
        $slot:expr,
        $is_even:expr,
        $min:expr,
        $max:expr
    ) => {{
        let slot = $slot;
        let base_port = (slot * 128 + if $is_even { 0 } else { 1 }) as u16;
        let max_port_in_slot = base_port.saturating_add(126);
        let mut allocated = 0u16;

        if max_port_in_slot >= $min && base_port <= $max {
            if let Some(p) = $map.get_ptr_mut(slot) {
                let val = unsafe { *p };
                if val != !0u64 {
                    let mut mask_avail = !val;
                    if base_port < $min {
                        let low_invalid = (($min - base_port + 1) / 2) as u32;
                        if low_invalid < 64 {
                            mask_avail &= !((1u64 << low_invalid) - 1);
                        } else {
                            mask_avail = 0;
                        }
                    }
                    if max_port_in_slot > $max {
                        let high_valid = (($max - base_port) / 2) as u32;
                        if high_valid < 63 {
                            mask_avail &= (1u64 << (high_valid + 1)) - 1;
                        }
                    }

                    let mut probe = 0;
                    while probe < 4 && mask_avail != 0 {
                        let free_bit = mask_avail.trailing_zeros();
                        let mask = 1u64 << free_bit;
                        mask_avail &= !mask;
                        let port = base_port + (free_bit as u16 * 2);
                        unsafe {
                            core::arch::asm!(
                                "lock *(u64 *)({p} + 0) |= {mask}",
                                p = in(reg) p,
                                mask = in(reg) mask,
                            );
                        }

                        if !port_is_reserved($reserved, port)
                            && $inbound.insert(&port, $in_val, BPF_NOEXIST).is_ok()
                        {
                            allocated = port;
                            break;
                        }
                        probe += 1;
                    }
                }
            }
        }
        allocated
    }};
}

macro_rules! impl_alloc_port {
    (
        $fn_name:ident,
        $val_ty:ty,
        $even_map:ident,
        $odd_map:ident,
        $reserved_map:ident,
        $inbound_map:ident,
        $push_event:ident,
        $key_default:expr
    ) => {
        #[inline(never)]
        pub fn $fn_name(pref: u16, min: u16, max: u16, in_val: &$val_ty) -> u16 {
            if pref >= min && pref <= max {
                let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(pref);
                let map = if is_even { &$even_map } else { &$odd_map };
                let is_res = port_is_reserved(&$reserved_map, pref);
                if !is_res && $inbound_map.insert(&pref, in_val, BPF_NOEXIST).is_ok() {
                    bitmap_set_bit(map, slot, mask);
                    return pref;
                } else if is_res {
                    bitmap_set_bit(map, slot, mask);
                }
            }

            let pref_even = (pref & 1) == 0;
            let rnd = unsafe { aya_ebpf::helpers::bpf_get_prandom_u32() };
            let start_slot = rnd % flowcone_common::PORT_BITMAP_SLOTS;

            let primary_map = if pref_even { &$even_map } else { &$odd_map };
            let p0 = try_alloc_slot!(
                primary_map,
                &$reserved_map,
                $inbound_map,
                in_val,
                start_slot,
                pref_even,
                min,
                max
            );
            if p0 != 0 {
                return p0;
            }
            let p1 = try_alloc_slot!(
                primary_map,
                &$reserved_map,
                $inbound_map,
                in_val,
                (start_slot + 1) % flowcone_common::PORT_BITMAP_SLOTS,
                pref_even,
                min,
                max
            );
            if p1 != 0 {
                return p1;
            }

            let fallback_even = !pref_even;
            let fallback_map = if fallback_even { &$even_map } else { &$odd_map };
            let f0 = try_alloc_slot!(
                fallback_map,
                &$reserved_map,
                $inbound_map,
                in_val,
                start_slot,
                fallback_even,
                min,
                max
            );
            if f0 != 0 {
                return f0;
            }

            if let Some(p) = PORT_FLAGS.get_ptr_mut(0) {
                unsafe {
                    if *p == 0 {
                        *p = 1;
                        $push_event(&$key_default, 0, 0);
                    }
                }
            }
            0
        }
    };
}

impl_alloc_port!(
    alloc_port_v4,
    BindingValue4,
    BITMAP_EVEN_V4,
    BITMAP_ODD_V4,
    RESERVED_V4,
    INBOUND_BINDINGS_V4,
    push_event_v4,
    EndpointKey4 {
        ip: 0,
        port: 0,
        _pad: 0,
    }
);

impl_alloc_port!(
    alloc_port_v6,
    BindingValue6,
    BITMAP_EVEN_V6,
    BITMAP_ODD_V6,
    RESERVED_V6,
    INBOUND_BINDINGS_V6,
    push_event_v6,
    EndpointKey6 {
        ip: [0; 16],
        port: 0,
        _pad: [0; 3],
    }
);

#[inline(always)]
pub fn get_or_create_mapping_v4<const PRIMARY: usize, const FALLBACK: usize>(
    cfg: &GlobalConfig,
    src_ip: u32,
    src_port: u16,
    now: u32,
    is_short_lived: bool,
) -> Option<u16> {
    let ep_key = EndpointKey4 {
        ip: src_ip,
        port: src_port,
        _pad: 0,
    };

    if let Some(val) = OUTBOUND_BINDINGS_V4.get_ptr_mut(&ep_key) {
        unsafe {
            if (*val).ip == cfg.wan_ip4 {
                let cur_port = u16::from_be((*val).port);
                if port_is_reserved(&RESERVED_V4, cur_port) {
                    let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(cur_port);
                    let map = if is_even { &BITMAP_EVEN_V4 } else { &BITMAP_ODD_V4 };
                    bitmap_set_bit(map, slot, mask);
                    let _ = OUTBOUND_BINDINGS_V4.remove(&ep_key);
                    if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(&cur_port)
                        && (*in_val).ip == src_ip
                        && (*in_val).port == src_port
                    {
                        let _ = INBOUND_BINDINGS_V4.remove(&cur_port);
                    }
                } else {
                    if now.wrapping_sub((*val).last_seen) >= LAST_SEEN_INTERVAL_SEC {
                        (*val).last_seen = now;
                    }
                    if !is_short_lived
                        && ((*val)._pad & flowcone_common::BINDING_FLAG_SHORT_LIVED != 0)
                    {
                        (*val)._pad &= !flowcone_common::BINDING_FLAG_SHORT_LIVED;
                    }
                    return Some((*val).port);
                }
            } else {
                let old_port = u16::from_be((*val).port);
                let _ = OUTBOUND_BINDINGS_V4.remove(&ep_key);
                if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(&old_port) {
                    if (*in_val).ip == src_ip && (*in_val).port == src_port {
                        let _ = INBOUND_BINDINGS_V4.remove(&old_port);
                        release_port_v4(old_port);
                    }
                } else {
                    release_port_v4(old_port);
                }
            }
        }
    }

    let flags = if is_short_lived {
        flowcone_common::BINDING_FLAG_SHORT_LIVED
    } else {
        0
    };
    let pref = u16::from_be(src_port);
    let in_val = BindingValue4 {
        ip: src_ip,
        port: src_port,
        _pad: flags,
        last_seen: now,
    };
    let alloc = alloc_port_v4(pref, cfg.min_port4, cfg.max_port4, &in_val);
    if alloc == 0 {
        return None;
    }
    let m_port = u16::to_be(alloc);
    let new_val = BindingValue4 {
        ip: cfg.wan_ip4,
        port: m_port,
        _pad: flags,
        last_seen: now,
    };
    if OUTBOUND_BINDINGS_V4
        .insert(&ep_key, &new_val, BPF_NOEXIST)
        .is_ok()
    {
        push_event_v4(&ep_key, alloc, flags);
        Some(m_port)
    } else {
        let _ = INBOUND_BINDINGS_V4.remove(&alloc);
        release_port_v4(alloc);
        OUTBOUND_BINDINGS_V4
            .get_ptr_mut(&ep_key)
            .map(|val| unsafe { (*val).port })
    }
}

#[inline(always)]
pub fn get_or_create_mapping_v6<const PRIMARY: usize, const FALLBACK: usize>(
    cfg: &GlobalConfig,
    src_ip: [u8; 16],
    src_port: u16,
    now: u32,
    is_short_lived: bool,
) -> Option<u16> {
    let ep_key = EndpointKey6 {
        ip: src_ip,
        port: src_port,
        _pad: [0; 3],
    };

    if let Some(val) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep_key) {
        unsafe {
            if ipv6_eq(&(*val).ip, &cfg.wan_ip6) {
                let cur_port = u16::from_be((*val).port);
                if port_is_reserved(&RESERVED_V6, cur_port) {
                    let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(cur_port);
                    let map = if is_even { &BITMAP_EVEN_V6 } else { &BITMAP_ODD_V6 };
                    bitmap_set_bit(map, slot, mask);
                    let _ = OUTBOUND_BINDINGS_V6.remove(&ep_key);
                    if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(&cur_port)
                        && ipv6_eq(&(*in_val).ip, &src_ip)
                        && (*in_val).port == src_port
                    {
                        let _ = INBOUND_BINDINGS_V6.remove(&cur_port);
                    }
                } else {
                    if now.wrapping_sub((*val).last_seen) >= LAST_SEEN_INTERVAL_SEC {
                        (*val).last_seen = now;
                    }
                    if !is_short_lived
                        && ((*val)._pad[0] & flowcone_common::BINDING_FLAG_SHORT_LIVED != 0)
                    {
                        (*val)._pad[0] &= !flowcone_common::BINDING_FLAG_SHORT_LIVED;
                    }
                    return Some((*val).port);
                }
            } else {
                let old_port = u16::from_be((*val).port);
                let _ = OUTBOUND_BINDINGS_V6.remove(&ep_key);
                if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(&old_port) {
                    if ipv6_eq(&(*in_val).ip, &src_ip) && (*in_val).port == src_port {
                        let _ = INBOUND_BINDINGS_V6.remove(&old_port);
                        release_port_v6(old_port);
                    }
                } else {
                    release_port_v6(old_port);
                }
            }
        }
    }

    let flags = if is_short_lived {
        flowcone_common::BINDING_FLAG_SHORT_LIVED
    } else {
        0
    };
    let pref = u16::from_be(src_port);
    let in_val = BindingValue6 {
        ip: src_ip,
        port: src_port,
        _pad: [flags, 0, 0],
        last_seen: now,
    };
    let alloc = alloc_port_v6(pref, cfg.min_port6, cfg.max_port6, &in_val);
    if alloc == 0 {
        return None;
    }
    let m_port = u16::to_be(alloc);
    let new_val = BindingValue6 {
        ip: cfg.wan_ip6,
        port: m_port,
        _pad: [flags, 0, 0],
        last_seen: now,
    };
    if OUTBOUND_BINDINGS_V6
        .insert(&ep_key, &new_val, BPF_NOEXIST)
        .is_ok()
    {
        push_event_v6(&ep_key, alloc, flags);
        Some(m_port)
    } else {
        let _ = INBOUND_BINDINGS_V6.remove(&alloc);
        release_port_v6(alloc);
        OUTBOUND_BINDINGS_V6
            .get_ptr_mut(&ep_key)
            .map(|val| unsafe { (*val).port })
    }
}
