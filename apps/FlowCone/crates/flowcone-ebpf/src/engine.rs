use aya_ebpf::{
    helpers::{bpf_csum_diff, bpf_ktime_get_coarse_ns},
    maps::{Array, HashMap},
    programs::TcContext,
};
use flowcone_common::{
    BINDING_FLAG_SHORT_LIVED, BindingValue4, BindingValue6, EndpointKey4, EndpointKey6,
    GlobalConfig, SessionEvent4, SessionEvent6,
};

use crate::parsing::{copy_ipv6, ipv6_eq};
use crate::{
    BITMAP_EVEN_V4, BITMAP_EVEN_V6, BITMAP_ODD_V4, BITMAP_ODD_V6, BPF_F_IPV6, BPF_F_MARK_MANGLED_0,
    BPF_F_PSEUDO_HDR, BPF_NOEXIST, CSUM_FIELD_U16, CSUM_FIELD_U32, GC_FLAGS, INBOUND_BINDINGS_V4,
    INBOUND_BINDINGS_V6, IPV4_CSUM_OFFSET, LAST_SEEN_INTERVAL_SEC, OUTBOUND_BINDINGS_V4,
    OUTBOUND_BINDINGS_V6, PORT_FLAGS, RESERVED_V4, RESERVED_V6, SESSION_EVENTS_V4,
    SESSION_EVENTS_V6, UDP_CSUM_OFFSET,
};

const EEXIST_ERR: i32 = -17;

#[inline(always)]
pub fn now_sec() -> u32 {
    flowcone_common::monotonic_ns_to_sec(unsafe { bpf_ktime_get_coarse_ns() })
}

#[inline(always)]
pub fn is_short_lived_port(dst_port: u16) -> bool {
    dst_port == 53
}

#[inline(always)]
fn pack_port_meta(port_be: u16, meta: u16) -> u32 {
    let pb = port_be.to_ne_bytes();
    let mb = meta.to_ne_bytes();
    u32::from_ne_bytes([pb[0], pb[1], mb[0], mb[1]])
}

#[inline(always)]
fn unpack_port_meta(word: u32) -> (u16, u16) {
    let b = word.to_ne_bytes();
    (
        u16::from_ne_bytes([b[0], b[1]]),
        u16::from_ne_bytes([b[2], b[3]]),
    )
}

#[inline(always)]
unsafe fn atomic_load_u32(ptr: *const u32) -> u32 {
    unsafe { core::ptr::read_volatile(ptr) }
}

/// 32-bit BPF `cmpxchg32_32` (`BPF_ATOMIC | BPF_W | BPF_CMPXCHG`), providing
/// atomic compare-and-swap and full barrier semantics across CPUs.
#[inline(always)]
unsafe fn atomic_cmpxchg_u32(ptr: *mut u32, expected: u32, new_val: u32) -> u32 {
    let mut prev = expected;
    unsafe {
        core::arch::asm!(
            "w0 = cmpxchg32_32({p} + 0, w0, w2)",
            p = in(reg) ptr,
            inout("r0") prev,
            in("r2") new_val,
            options(nostack),
        );
    }
    prev
}

#[inline(always)]
pub fn push_event_v4(key: &EndpointKey4, port: u16, flags: u16) {
    if let Some(mut entry) = SESSION_EVENTS_V4.reserve::<SessionEvent4>(0) {
        let p = entry.as_mut_ptr();
        unsafe {
            (*p).key.ip = key.ip;
            (*p).key.port = key.port;
            (*p).key._pad = 0;
            (*p).port = port;
            (*p).flags = flags;
        }
        entry.submit(0);
    } else {
        let _ = GC_FLAGS.set(0, &1, 0);
    }
}

#[inline(always)]
pub fn push_event_v6(key: &EndpointKey6, port: u16, flags: u16) {
    if let Some(mut entry) = SESSION_EVENTS_V6.reserve::<SessionEvent6>(0) {
        let p = entry.as_mut_ptr();
        unsafe {
            copy_ipv6(&mut (*p).key.ip, &key.ip);
            (*p).key.port = key.port;
            (*p).key._pad = 0;
            (*p).port = port;
            (*p).flags = flags;
        }
        entry.submit(0);
    } else {
        let _ = GC_FLAGS.set(0, &1, 0);
    }
}

#[inline(always)]
fn push_port_exhausted_v4() {
    if let Some(mut entry) = SESSION_EVENTS_V4.reserve::<SessionEvent4>(0) {
        let p = entry.as_mut_ptr();
        unsafe {
            // Non-zero flags sentinel on port=0 prevents LLVM from coalescing
            // writes into memset.
            p.cast::<u64>().write_volatile(0);
            p.cast::<u32>()
                .add(2)
                .write_volatile(u32::from_ne_bytes([0, 0, 0x00, 0x80]));
        }
        entry.submit(0);
    } else {
        let _ = GC_FLAGS.set(0, &1, 0);
    }
}

#[inline(always)]
fn push_port_exhausted_v6() {
    if let Some(mut entry) = SESSION_EVENTS_V6.reserve::<SessionEvent6>(0) {
        let p = entry.as_mut_ptr() as *mut u64;
        unsafe {
            core::ptr::write_volatile(p, 0);
            core::ptr::write_volatile(p.add(1), 0);
            core::ptr::write_volatile(p.add(2), u64::from_ne_bytes([0, 0, 0, 0, 0, 0, 0x00, 0x80]));
        }
        entry.submit(0);
    } else {
        let _ = GC_FLAGS.set(0, &1, 0);
    }
}

#[inline(always)]
pub fn ipv6_addr_diff(old_ip: &[u8; 16], new_ip: &[u8; 16]) -> Option<u32> {
    let mut old_w = [0u32; 4];
    let mut new_w = [0u32; 4];
    let mut i = 0;
    while i < 4 {
        old_w[i] = u32::from_ne_bytes([
            old_ip[i * 4],
            old_ip[i * 4 + 1],
            old_ip[i * 4 + 2],
            old_ip[i * 4 + 3],
        ]);
        new_w[i] = u32::from_ne_bytes([
            new_ip[i * 4],
            new_ip[i * 4 + 1],
            new_ip[i * 4 + 2],
            new_ip[i * 4 + 3],
        ]);
        i += 1;
    }
    let diff = unsafe { bpf_csum_diff(old_w.as_mut_ptr(), 16, new_w.as_mut_ptr(), 16, 0) };
    if diff < 0 { None } else { Some(diff as u32) }
}

/// Fix up the IPv4 header and UDP checksums after an address/port rewrite.
/// Must be the last packet access: the helpers may linearize the skb.
#[inline(always)]
pub fn fixup_csum_v4(
    ctx: &TcContext,
    ip_rel: usize,
    udp_rel: usize,
    old_ip: u32,
    new_ip: u32,
    old_port: u16,
    new_port: u16,
) -> bool {
    let l3_off = ip_rel + IPV4_CSUM_OFFSET;
    if ctx
        .skb
        .l3_csum_replace(l3_off, old_ip as u64, new_ip as u64, CSUM_FIELD_U32)
        .is_err()
    {
        return false;
    }

    let l4_off = udp_rel + UDP_CSUM_OFFSET;
    ctx.skb
        .l4_csum_replace(
            l4_off,
            old_ip as u64,
            new_ip as u64,
            BPF_F_MARK_MANGLED_0 | BPF_F_PSEUDO_HDR | CSUM_FIELD_U32,
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
pub fn fixup_l3_v4(ctx: &TcContext, ip_rel: usize, old_ip: u32, new_ip: u32) -> bool {
    ctx.skb
        .l3_csum_replace(
            ip_rel + IPV4_CSUM_OFFSET,
            old_ip as u64,
            new_ip as u64,
            CSUM_FIELD_U32,
        )
        .is_ok()
}

#[inline(always)]
pub fn fixup_l3_id_v4(ctx: &TcContext, ip_rel: usize, old_id: u16, new_id: u16) -> bool {
    ctx.skb
        .l3_csum_replace(
            ip_rel + IPV4_CSUM_OFFSET,
            old_id as u64,
            new_id as u64,
            CSUM_FIELD_U16,
        )
        .is_ok()
}

/// Fix up IPv6 UDP checksum using `bpf_csum_diff` + `BPF_F_IPV6` so
/// `CHECKSUM_COMPLETE` `skb->csum` is preserved (IPv6 has no L3 header
/// checksum).
#[inline(always)]
pub fn fixup_csum_v6(
    ctx: &TcContext,
    udp_rel: usize,
    old_ip: &[u8; 16],
    new_ip: &[u8; 16],
    old_port: u16,
    new_port: u16,
) -> bool {
    let l4_off = udp_rel + UDP_CSUM_OFFSET;
    let Some(diff) = ipv6_addr_diff(old_ip, new_ip) else {
        return false;
    };

    if ctx
        .skb
        .l4_csum_replace(
            l4_off,
            0,
            diff as u64,
            BPF_F_MARK_MANGLED_0 | BPF_F_PSEUDO_HDR | BPF_F_IPV6,
        )
        .is_err()
    {
        return false;
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
pub fn port_reserved_state(reserved: &Array<u16>, port: u16) -> u16 {
    reserved.get(port as u32).copied().unwrap_or(0)
}

#[inline(always)]
pub fn port_is_reserved(reserved: &Array<u16>, port: u16) -> bool {
    flowcone_common::reserved_state_is_reserved(port_reserved_state(reserved, port))
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
unsafe fn bitmap_clear_ptr(p: *mut u64, mask: u64) {
    let neg = !mask;
    unsafe {
        core::arch::asm!(
            "lock *(u64 *)({p} + 0) &= {neg}",
            p = in(reg) p,
            neg = in(reg) neg,
        );
    }
}

#[inline(always)]
pub fn bitmap_clear_bit(map: &Array<u64>, slot: u32, mask: u64) {
    if let Some(p) = map.get_ptr_mut(slot) {
        unsafe { bitmap_clear_ptr(p, mask) };
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

trait BindingOps: Copy {
    type Ip: Copy;
    fn new(ip: &Self::Ip, port: u16, meta: u16, last_seen: u32) -> Self;
    fn read_ip(val: *const Self) -> Self::Ip;
    fn write_ip(val: *mut Self, ip: &Self::Ip);
    fn port_meta_ptr(val: *mut Self) -> *mut u32;
    fn last_seen_ptr(val: *mut Self) -> *mut u32;
    fn reserved_meta_val(val: *const Self) -> u16;
}

impl BindingOps for BindingValue4 {
    type Ip = u32;
    #[inline(always)]
    fn new(ip: &u32, port: u16, meta: u16, last_seen: u32) -> Self {
        Self {
            ip: *ip,
            port,
            meta,
            last_seen,
        }
    }
    #[inline(always)]
    fn read_ip(val: *const Self) -> u32 {
        unsafe { (*val).ip }
    }
    #[inline(always)]
    fn write_ip(val: *mut Self, ip: &u32) {
        unsafe {
            (*val).ip = *ip;
        }
    }
    #[inline(always)]
    fn port_meta_ptr(val: *mut Self) -> *mut u32 {
        unsafe { (&mut (*val).port as *mut u16).cast::<u32>() }
    }
    #[inline(always)]
    fn last_seen_ptr(val: *mut Self) -> *mut u32 {
        unsafe { core::ptr::addr_of_mut!((*val).last_seen) }
    }
    #[inline(always)]
    fn reserved_meta_val(val: *const Self) -> u16 {
        unsafe { (*val).reserved_meta() }
    }
}

impl BindingOps for BindingValue6 {
    type Ip = [u8; 16];
    #[inline(always)]
    fn new(ip: &[u8; 16], port: u16, meta: u16, last_seen: u32) -> Self {
        let mut out = core::mem::MaybeUninit::<Self>::uninit();
        let p = out.as_mut_ptr();
        unsafe {
            copy_ipv6(&mut (*p).ip, ip);
            (*p).port = port;
            (*p).meta = meta;
            (*p).last_seen = last_seen;
            out.assume_init()
        }
    }
    #[inline(always)]
    fn read_ip(val: *const Self) -> [u8; 16] {
        let mut out = [0u8; 16];
        copy_ipv6(&mut out, unsafe { &(*val).ip });
        out
    }
    #[inline(always)]
    fn write_ip(val: *mut Self, ip: &[u8; 16]) {
        unsafe {
            copy_ipv6(&mut (*val).ip, ip);
        }
    }
    #[inline(always)]
    fn port_meta_ptr(val: *mut Self) -> *mut u32 {
        unsafe { (&mut (*val).port as *mut u16).cast::<u32>() }
    }
    #[inline(always)]
    fn last_seen_ptr(val: *mut Self) -> *mut u32 {
        unsafe { core::ptr::addr_of_mut!((*val).last_seen) }
    }
    #[inline(always)]
    fn reserved_meta_val(val: *const Self) -> u16 {
        unsafe { (*val).reserved_meta() }
    }
}

macro_rules! impl_pick_bitmap_port {
    ($fn_name:ident, $even_map:ident, $odd_map:ident) => {
        #[inline(never)]
        fn $fn_name(slot: u32, is_even: bool, min: u16, max: u16) -> u16 {
            let slot = slot & 0x1ff;
            let map = if is_even { &$even_map } else { &$odd_map };
            let base_port = (slot * 128 + if is_even { 0 } else { 1 }) as u16;
            let max_port_in_slot = base_port.saturating_add(126);

            if max_port_in_slot < min || base_port > max {
                return 0;
            }
            let Some(p) = map.get_ptr_mut(slot) else {
                return 0;
            };
            let val = unsafe { *p };
            if val == !0u64 {
                return 0;
            }
            let mut mask_avail = !val;
            if base_port < min {
                let low_invalid = ((min - base_port).div_ceil(2) as u32) & 63;
                mask_avail &= !((1u64 << low_invalid) - 1);
            }
            if max_port_in_slot > max {
                let high_limit = (((max - base_port) / 2 + 1) as u32) & 63;
                mask_avail &= (1u64 << high_limit) - 1;
            }
            if mask_avail == 0 {
                return 0;
            }
            let free_bit = mask_avail.trailing_zeros();
            let mask = 1u64 << free_bit;
            unsafe {
                core::arch::asm!(
                    "lock *(u64 *)({p} + 0) |= {mask}",
                    p = in(reg) p,
                    mask = in(reg) mask,
                );
            }
            base_port + (free_bit as u16 * 2)
        }
    };
}

impl_pick_bitmap_port!(pick_bitmap_port_v4, BITMAP_EVEN_V4, BITMAP_ODD_V4);
impl_pick_bitmap_port!(pick_bitmap_port_v6, BITMAP_EVEN_V6, BITMAP_ODD_V6);

macro_rules! impl_alloc_port {
    (
        $fn_name:ident,
        $exact_name:ident,
        $claim_name:ident,
        $val_ty:ty,
        $even_map:ident,
        $odd_map:ident,
        $reserved_map:ident,
        $inbound_map:ident,
        $pick_slot:ident,
        $push_exhausted:ident
    ) => {
        #[inline(never)]
        fn $exact_name(port: u16, min: u16, max: u16, in_val: &$val_ty) -> u32 {
            if port < min || port > max {
                return 0;
            }
            let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(port);
            let map = if is_even { &$even_map } else { &$odd_map };
            let res_state = port_reserved_state(&$reserved_map, port);
            if !flowcone_common::reserved_state_is_reserved(res_state) {
                let mut cand = *in_val;
                cand.set_reserved_epoch(res_state);
                if $inbound_map.insert(&port, &cand, BPF_NOEXIST).is_ok() {
                    bitmap_set_bit(map, slot, mask);
                    return ((res_state as u32) << 16) | (port as u32);
                }
            } else {
                bitmap_set_bit(map, slot, mask);
            }
            0
        }

        #[inline(never)]
        fn $claim_name(port: u16, in_val: &$val_ty) -> u32 {
            let res_state = port_reserved_state(&$reserved_map, port);
            if flowcone_common::reserved_state_is_reserved(res_state) {
                return 0;
            }
            let mut cand = *in_val;
            cand.set_reserved_epoch(res_state);
            match $inbound_map.insert(&port, &cand, BPF_NOEXIST) {
                Ok(()) => ((res_state as u32) << 16) | (port as u32),
                Err(err) => {
                    if err != EEXIST_ERR && !port_is_reserved(&$reserved_map, port) {
                        let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(port);
                        let map = if is_even { &$even_map } else { &$odd_map };
                        bitmap_clear_bit(map, slot, mask);
                    }
                    0
                }
            }
        }

        #[inline(never)]
        pub fn $fn_name(pref: u16, min: u16, max: u16, in_val: &$val_ty) -> u32 {
            if min == 0 || min > max {
                return 0;
            }
            let exact = $exact_name(pref, min, max, in_val);
            if exact != 0 {
                return exact;
            }

            let min_slot = (min as u32) / 128;
            let max_slot = (max as u32) / 128;
            let span = max_slot - min_slot + 1;

            let pref_even = (pref & 1) == 0;
            let rnd = unsafe { aya_ebpf::helpers::bpf_get_prandom_u32() };
            let start_off = rnd % span;

            let mut cand_port = 0u16;
            let mut step = 0u32;
            while step < 8 {
                let off = step & 3;
                let slot = (min_slot + ((start_off + off) % span)) & 0x1ff;
                let parity_even = pref_even ^ (step >= 4);
                cand_port = $pick_slot(slot, parity_even, min, max);
                if cand_port != 0 {
                    break;
                }
                step += 1;
            }

            if cand_port != 0 {
                let claimed = $claim_name(cand_port, in_val);
                if claimed != 0 {
                    return claimed;
                }
                // Rare race (newly-bound local socket or concurrent bit race):
                // try one opposite-parity fallback slot.
                let alt_slot = (min_slot + ((start_off + 4) % span)) & 0x1ff;
                let alt_port = $pick_slot(alt_slot, !pref_even, min, max);
                if alt_port != 0 {
                    let claimed = $claim_name(alt_port, in_val);
                    if claimed != 0 {
                        return claimed;
                    }
                }
            }

            if let Some(p) = PORT_FLAGS.get_ptr_mut(0) {
                unsafe {
                    if atomic_cmpxchg_u32(p, 0, 1) == 0 {
                        $push_exhausted();
                    }
                }
            }
            0
        }
    };
}

impl_alloc_port!(
    alloc_port_v4,
    try_alloc_exact_v4,
    claim_picked_port_v4,
    BindingValue4,
    BITMAP_EVEN_V4,
    BITMAP_ODD_V4,
    RESERVED_V4,
    INBOUND_BINDINGS_V4,
    pick_bitmap_port_v4,
    push_port_exhausted_v4
);

impl_alloc_port!(
    alloc_port_v6,
    try_alloc_exact_v6,
    claim_picked_port_v6,
    BindingValue6,
    BITMAP_EVEN_V6,
    BITMAP_ODD_V6,
    RESERVED_V6,
    INBOUND_BINDINGS_V6,
    pick_bitmap_port_v6,
    push_port_exhausted_v6
);

macro_rules! impl_lookup_inbound {
    ($fn_name:ident, $val_ty:ty, $reserved_map:ident, $inbound_map:ident, $release_fn:ident) => {
        #[inline(always)]
        pub fn $fn_name(ext_port: u16) -> Option<*mut $val_ty> {
            let target = $inbound_map.get_ptr_mut(&ext_port)?;
            let res_state = port_reserved_state(&$reserved_map, ext_port);
            if flowcone_common::reserved_state_is_reserved(res_state) {
                let _ = $inbound_map.remove(&ext_port);
                return None;
            }
            let meta = unsafe { (*target).reserved_meta() };
            if !flowcone_common::binding_matches_reserved(res_state, meta) {
                let _ = $inbound_map.remove(&ext_port);
                $release_fn(ext_port);
                return None;
            }
            Some(target)
        }
    };
}

impl_lookup_inbound!(
    lookup_inbound_v4,
    BindingValue4,
    RESERVED_V4,
    INBOUND_BINDINGS_V4,
    release_port_v4
);

impl_lookup_inbound!(
    lookup_inbound_v6,
    BindingValue6,
    RESERVED_V6,
    INBOUND_BINDINGS_V6,
    release_port_v6
);

enum OutboundInspect<V> {
    Missing,
    Busy,
    Valid(u16),
    Stale {
        val: *mut V,
        pm1: u32,
        cur_port: u16,
        ip_matches: bool,
        res_state: u16,
    },
}

#[inline(always)]
fn inspect_outbound_binding<K, V, IpEq>(
    ob_map: &HashMap<K, V>,
    reserved_map: &Array<u16>,
    ep_key: &K,
    wan_ip: &V::Ip,
    ip_eq: IpEq,
    now: u32,
    is_short_lived: bool,
) -> OutboundInspect<V>
where
    V: BindingOps,
    IpEq: FnOnce(&V::Ip, &V::Ip) -> bool,
{
    let Some(val) = ob_map.get_ptr_mut(ep_key) else {
        return OutboundInspect::Missing;
    };
    let pm_ptr = V::port_meta_ptr(val);
    let pm1 = unsafe { atomic_load_u32(pm_ptr) };
    let (cur_port_be, cur_meta) = unpack_port_meta(pm1);
    if cur_port_be == 0 {
        return OutboundInspect::Busy;
    }
    let cur_ip = V::read_ip(val);
    let pm2 = unsafe { atomic_load_u32(pm_ptr) };
    if pm2 != pm1 {
        return OutboundInspect::Busy;
    }
    let cur_port = u16::from_be(cur_port_be);
    let ip_matches = ip_eq(&cur_ip, wan_ip);
    let res_state = port_reserved_state(reserved_map, cur_port);
    if ip_matches && flowcone_common::binding_matches_reserved(res_state, cur_meta) {
        unsafe {
            if now.wrapping_sub(*V::last_seen_ptr(val)) >= LAST_SEEN_INTERVAL_SEC {
                *V::last_seen_ptr(val) = now;
            }
        }
        if !is_short_lived && (cur_meta & BINDING_FLAG_SHORT_LIVED) != 0 {
            let next_pm = pack_port_meta(cur_port_be, cur_meta & !BINDING_FLAG_SHORT_LIVED);
            let _ = unsafe { atomic_cmpxchg_u32(pm_ptr, pm1, next_pm) };
        }
        return OutboundInspect::Valid(cur_port_be);
    }
    OutboundInspect::Stale {
        val,
        pm1,
        cur_port,
        ip_matches,
        res_state,
    }
}

macro_rules! impl_get_or_create_mapping {
    (
        $fn_name:ident,
        $lookup_name:ident,
        $ip_ty:ty,
        $key_ty:ty,
        $val_ty:ty,
        $ob_map:ident,
        $ib_map:ident,
        $reserved_map:ident,
        $even_map:ident,
        $odd_map:ident,
        $alloc_fn:ident,
        $try_exact_fn:ident,
        $release_fn:ident,
        $push_event:ident,
        $make_key:expr,
        $ip_eq:expr,
        $wan_ip:ident,
        $min_port:expr,
        $max_port:expr
    ) => {
        #[inline(always)]
        pub fn $lookup_name(
            cfg: &GlobalConfig,
            src_ip: $ip_ty,
            src_port: u16,
            now: u32,
            is_short_lived: bool,
        ) -> Option<u16> {
            let ep_key: $key_ty = $make_key(&src_ip, src_port);
            match inspect_outbound_binding(
                &$ob_map,
                &$reserved_map,
                &ep_key,
                &cfg.$wan_ip,
                $ip_eq,
                now,
                is_short_lived,
            ) {
                OutboundInspect::Valid(port) => Some(port),
                _ => None,
            }
        }

        /// Returns the mapped UDP port in big-endian (`0` on failure /
        /// concurrent replacement).
        #[inline(never)]
        pub fn $fn_name(
            cfg: &GlobalConfig,
            src_ip: $ip_ty,
            src_port: u16,
            now: u32,
            is_short_lived: bool,
        ) -> u16 {
            let ep_key: $key_ty = $make_key(&src_ip, src_port);
            let wan_ip = &cfg.$wan_ip;
            let flags = if is_short_lived {
                BINDING_FLAG_SHORT_LIVED
            } else {
                0
            };

            let mut stale_val: *mut $val_ty = core::ptr::null_mut();
            let mut cur_port = 0u16;
            let mut ip_matches = false;
            let mut res_state = 0u16;
            let mut is_res = false;
            match inspect_outbound_binding(
                &$ob_map,
                &$reserved_map,
                &ep_key,
                wan_ip,
                $ip_eq,
                now,
                is_short_lived,
            ) {
                OutboundInspect::Valid(port) => return port,
                OutboundInspect::Busy => return 0,
                OutboundInspect::Stale {
                    val,
                    pm1,
                    cur_port: old_port,
                    ip_matches: old_ip_match,
                    res_state: old_res_state,
                } => {
                    let pm_ptr = <$val_ty as BindingOps>::port_meta_ptr(val);
                    // Atomically claim stale eviction (`port = 0`) so a losing
                    // CPU never deletes the winner's new entry in
                    // OUTBOUND_BINDINGS.
                    if unsafe { atomic_cmpxchg_u32(pm_ptr, pm1, 0) } != pm1 {
                        return 0;
                    }

                    is_res =
                        old_ip_match && flowcone_common::reserved_state_is_reserved(old_res_state);
                    if is_res {
                        let (is_even, slot, mask) =
                            flowcone_common::port_to_bitmap_coords(old_port);
                        let map = if is_even { &$even_map } else { &$odd_map };
                        bitmap_set_bit(map, slot, mask);
                    }
                    stale_val = val;
                    cur_port = old_port;
                    ip_matches = old_ip_match;
                    res_state = old_res_state;
                }
                OutboundInspect::Missing => {}
            }

            let pref = u16::from_be(src_port);
            let min_p = $min_port(cfg);
            let max_p = $max_port(cfg);
            let in_val = <$val_ty as BindingOps>::new(&src_ip, src_port, flags, now);
            let mut alloc_packed = $alloc_fn(pref, min_p, max_p, &in_val);

            if !stale_val.is_null() {
                // Clean up old inbound mapping after replacement attempt to
                // avoid ABA on cur_port reuse, then allow exact cur_port
                // reclaim if the replacement attempt failed (e.g. 1-port pool).
                if let Some(in_ptr) = $ib_map.get_ptr_mut(&cur_port) {
                    let in_ip = <$val_ty as BindingOps>::read_ip(in_ptr);
                    if unsafe { $ip_eq(&in_ip, &src_ip) && (*in_ptr).port == src_port }
                        && (!ip_matches
                            || !flowcone_common::binding_matches_reserved(
                                res_state,
                                <$val_ty as BindingOps>::reserved_meta_val(in_ptr),
                            ))
                    {
                        let _ = $ib_map.remove(&cur_port);
                        if !is_res {
                            $release_fn(cur_port);
                        }
                    }
                } else if !is_res {
                    $release_fn(cur_port);
                }

                if (alloc_packed as u16) == 0 {
                    alloc_packed = $try_exact_fn(cur_port, min_p, max_p, &in_val);
                }
                let alloc = alloc_packed as u16;
                if alloc == 0 {
                    let _ = $ob_map.remove(&ep_key);
                    return 0;
                }

                let m_port = u16::to_be(alloc);
                let new_meta =
                    flowcone_common::pack_binding_meta(is_short_lived, (alloc_packed >> 16) as u16);
                let pm_ptr = <$val_ty as BindingOps>::port_meta_ptr(stale_val);
                <$val_ty as BindingOps>::write_ip(stale_val, wan_ip);
                unsafe {
                    (*stale_val).last_seen = now;
                    let _ = atomic_cmpxchg_u32(pm_ptr, 0, pack_port_meta(m_port, new_meta));
                }
                $push_event(&ep_key, alloc, flags);
                return m_port;
            }

            let alloc = alloc_packed as u16;
            if alloc == 0 {
                return 0;
            }
            let m_port = u16::to_be(alloc);
            let new_val = <$val_ty as BindingOps>::new(
                wan_ip,
                m_port,
                flowcone_common::pack_binding_meta(is_short_lived, (alloc_packed >> 16) as u16),
                now,
            );
            if $ob_map.insert(&ep_key, &new_val, BPF_NOEXIST).is_ok() {
                $push_event(&ep_key, alloc, flags);
                m_port
            } else {
                let _ = $ib_map.remove(&alloc);
                $release_fn(alloc);
                let Some(val) = $ob_map.get_ptr_mut(&ep_key) else {
                    return 0;
                };
                let pm_ptr = <$val_ty as BindingOps>::port_meta_ptr(val);
                let (p, _) = unpack_port_meta(unsafe { atomic_load_u32(pm_ptr) });
                p
            }
        }
    };
}

impl_get_or_create_mapping!(
    get_or_create_mapping_v4,
    lookup_outbound_v4,
    u32,
    EndpointKey4,
    BindingValue4,
    OUTBOUND_BINDINGS_V4,
    INBOUND_BINDINGS_V4,
    RESERVED_V4,
    BITMAP_EVEN_V4,
    BITMAP_ODD_V4,
    alloc_port_v4,
    try_alloc_exact_v4,
    release_port_v4,
    push_event_v4,
    |ip: &u32, port| EndpointKey4 {
        ip: *ip,
        port,
        _pad: 0
    },
    |a: &u32, b: &u32| *a == *b,
    wan_ip4,
    |cfg: &GlobalConfig| cfg.min_port4,
    |cfg: &GlobalConfig| cfg.max_port4
);

impl_get_or_create_mapping!(
    get_or_create_mapping_v6,
    lookup_outbound_v6,
    [u8; 16],
    EndpointKey6,
    BindingValue6,
    OUTBOUND_BINDINGS_V6,
    INBOUND_BINDINGS_V6,
    RESERVED_V6,
    BITMAP_EVEN_V6,
    BITMAP_ODD_V6,
    alloc_port_v6,
    try_alloc_exact_v6,
    release_port_v6,
    push_event_v6,
    |ip: &[u8; 16], port| {
        let mut k = core::mem::MaybeUninit::<EndpointKey6>::uninit();
        let p = k.as_mut_ptr();
        unsafe {
            copy_ipv6(&mut (*p).ip, ip);
            (*p).port = port;
            core::ptr::write_volatile(&mut (*p)._pad, 0);
            k.assume_init()
        }
    },
    |a: &[u8; 16], b: &[u8; 16]| ipv6_eq(a, b),
    wan_ip6,
    |cfg: &GlobalConfig| cfg.min_port6,
    |cfg: &GlobalConfig| cfg.max_port6
);
