use aya_ebpf::{
    helpers::{bpf_ktime_get_coarse_ns, bpf_loop},
    maps::{Array, Queue},
    programs::TcContext,
};
use core::ffi::c_void;
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, GlobalConfig, PORT_FREE_BIT,
    PORT_QUEUED_BIT, SessionEvent4, SessionEvent6,
};

use crate::parsing::ipv6_eq;
use crate::{
    BPF_F_MARK_MANGLED_0, BPF_F_PSEUDO_HDR, BPF_NOEXIST, CSUM_FIELD_U16,
    CSUM_FIELD_U32, FREE_EVEN_V4, FREE_EVEN_V6, FREE_ODD_V4, FREE_ODD_V6, GC_FLAGS,
    INBOUND_BINDINGS_V4, INBOUND_BINDINGS_V6, IPV4_CSUM_OFFSET, LAST_SEEN_INTERVAL_SEC,
    OUTBOUND_BINDINGS_V4, OUTBOUND_BINDINGS_V6, PORT_FLAGS, PORT_FREE_V4, PORT_FREE_V6,
    RESERVED_V4, RESERVED_V6, SESSION_EVENTS_V4, SESSION_EVENTS_V6, UDP_CSUM_OFFSET,
};

pub const EGRESS_ALLOC_PRIMARY: usize = 4;
pub const EGRESS_ALLOC_FALLBACK: usize = 4;
pub const FRAG_ALLOC_PRIMARY: usize = 4;
pub const FRAG_ALLOC_FALLBACK: usize = 4;
pub const FRAG6_ALLOC_PRIMARY: usize = 4;
pub const FRAG6_ALLOC_FALLBACK: usize = 4;

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
pub fn port_state_unqueue(map: &Array<u8>, port: u16) {
    if let Some(p) = map.get_ptr_mut(port as u32) {
        unsafe {
            *p = flowcone_common::port_state_on_unqueue(*p);
        }
    }
}

#[inline(always)]
pub fn port_state_bound(map: &Array<u8>, port: u16) {
    if let Some(p) = map.get_ptr_mut(port as u32) {
        unsafe {
            *p = flowcone_common::port_state_on_bound(*p);
        }
    }
}

#[inline(always)]
pub fn queue_push(q: &Queue<u16>, state: &Array<u8>, port: u16) {
    if let Some(p) = state.get_ptr_mut(port as u32) {
        unsafe {
            if *p & PORT_QUEUED_BIT != 0 {
                return;
            }
            *p |= PORT_QUEUED_BIT;
        }
    } else {
        return;
    }
    if q.push(&port, 0).is_err() {
        let _ = PORT_FLAGS.set(0, &1, 0);
        if let Some(p) = state.get_ptr_mut(port as u32) {
            unsafe {
                *p = flowcone_common::port_state_on_unqueue(*p);
            }
        }
    }
}

#[inline(always)]
pub fn release_port_v4(port: u16) {
    if let Some(p) = PORT_FREE_V4.get_ptr_mut(port as u32) {
        unsafe {
            *p |= PORT_FREE_BIT;
            if *p & PORT_QUEUED_BIT != 0 {
                return;
            }
        }
    } else {
        return;
    }
    if (port & 1) == 0 {
        queue_push(&FREE_EVEN_V4, &PORT_FREE_V4, port);
    } else {
        queue_push(&FREE_ODD_V4, &PORT_FREE_V4, port);
    }
}

#[inline(always)]
pub fn release_port_v6(port: u16) {
    if let Some(p) = PORT_FREE_V6.get_ptr_mut(port as u32) {
        unsafe {
            *p |= PORT_FREE_BIT;
            if *p & PORT_QUEUED_BIT != 0 {
                return;
            }
        }
    } else {
        return;
    }
    if (port & 1) == 0 {
        queue_push(&FREE_EVEN_V6, &PORT_FREE_V6, port);
    } else {
        queue_push(&FREE_ODD_V6, &PORT_FREE_V6, port);
    }
}

#[inline(always)]
pub fn claim_port_v4(port: u16, in_val: &BindingValue4) -> bool {
    if port_is_reserved(&RESERVED_V4, port) {
        return false;
    }
    INBOUND_BINDINGS_V4
        .insert(&port, in_val, BPF_NOEXIST)
        .is_ok()
}

#[inline(always)]
pub fn claim_port_v6(port: u16, in_val: &BindingValue6) -> bool {
    if port_is_reserved(&RESERVED_V6, port) {
        return false;
    }
    INBOUND_BINDINGS_V6
        .insert(&port, in_val, BPF_NOEXIST)
        .is_ok()
}

#[inline(always)]
pub fn pop_and_claim_v4(q: &Queue<u16>, in_val: &BindingValue4) -> Result<Option<u16>, ()> {
    let port = match q.pop() {
        Ok(Some(port)) => port,
        _ => return Err(()),
    };
    port_state_unqueue(&PORT_FREE_V4, port);
    if claim_port_v4(port, in_val) {
        port_state_bound(&PORT_FREE_V4, port);
        return Ok(Some(port));
    }
    port_state_bound(&PORT_FREE_V4, port);
    Ok(None)
}

#[inline(always)]
pub fn pop_and_claim_v6(q: &Queue<u16>, in_val: &BindingValue6) -> Result<Option<u16>, ()> {
    let port = match q.pop() {
        Ok(Some(port)) => port,
        _ => return Err(()),
    };
    port_state_unqueue(&PORT_FREE_V6, port);
    if claim_port_v6(port, in_val) {
        port_state_bound(&PORT_FREE_V6, port);
        return Ok(Some(port));
    }
    port_state_bound(&PORT_FREE_V6, port);
    Ok(None)
}

#[repr(C)]
pub struct PortAllocCtx4 {
    pub in_val: BindingValue4,
    pub primary: u32,
    pub index: u32,
    pub parity: u8,
    pub saw_stale: u8,
    pub result: u16,
}

#[repr(C)]
pub struct PortAllocCtx6 {
    pub in_val: BindingValue6,
    pub primary: u32,
    pub index: u32,
    pub parity: u8,
    pub saw_stale: u8,
    pub result: u16,
}

#[inline(never)]
pub unsafe extern "C" fn alloc_cb_v4(_index: u32, ctx: *mut c_void) -> i64 {
    let c = unsafe { &mut *(ctx as *mut PortAllocCtx4) };
    let primary = c.index < c.primary;
    let q = if primary {
        if c.parity == 0 {
            &FREE_EVEN_V4
        } else {
            &FREE_ODD_V4
        }
    } else if c.parity == 0 {
        &FREE_ODD_V4
    } else {
        &FREE_EVEN_V4
    };

    match pop_and_claim_v4(q, &c.in_val) {
        Ok(Some(port)) => {
            c.result = port;
            1
        }
        Ok(None) => {
            c.saw_stale = 1;
            c.index += 1;
            0
        }
        Err(()) => {
            if primary {
                c.index = c.primary;
                0
            } else {
                1
            }
        }
    }
}

#[inline(never)]
pub unsafe extern "C" fn alloc_cb_v6(_index: u32, ctx: *mut c_void) -> i64 {
    let c = unsafe { &mut *(ctx as *mut PortAllocCtx6) };
    let primary = c.index < c.primary;
    let q = if primary {
        if c.parity == 0 {
            &FREE_EVEN_V6
        } else {
            &FREE_ODD_V6
        }
    } else if c.parity == 0 {
        &FREE_ODD_V6
    } else {
        &FREE_EVEN_V6
    };

    match pop_and_claim_v6(q, &c.in_val) {
        Ok(Some(port)) => {
            c.result = port;
            1
        }
        Ok(None) => {
            c.saw_stale = 1;
            c.index += 1;
            0
        }
        Err(()) => {
            if primary {
                c.index = c.primary;
                0
            } else {
                1
            }
        }
    }
}

#[inline(always)]
pub fn alloc_port_v4<const PRIMARY: usize, const FALLBACK: usize>(
    pref: u16,
    min: u16,
    max: u16,
    in_val: &BindingValue4,
) -> Option<u16> {
    if pref >= min && pref <= max && claim_port_v4(pref, in_val) {
        port_state_bound(&PORT_FREE_V4, pref);
        return Some(pref);
    }
    let mut ctx = PortAllocCtx4 {
        in_val: *in_val,
        primary: PRIMARY as u32,
        index: 0,
        parity: (pref & 1) as u8,
        saw_stale: 0,
        result: 0,
    };
    unsafe {
        bpf_loop(
            (PRIMARY + FALLBACK) as u32,
            alloc_cb_v4 as *const () as *mut c_void,
            &mut ctx as *mut PortAllocCtx4 as *mut c_void,
            0,
        );
    }
    if ctx.result != 0 {
        Some(ctx.result)
    } else {
        if ctx.saw_stale != 0 {
            let _ = PORT_FLAGS.set(0, &1, 0);
        }
        None
    }
}

#[inline(always)]
pub fn alloc_port_v6<const PRIMARY: usize, const FALLBACK: usize>(
    pref: u16,
    min: u16,
    max: u16,
    in_val: &BindingValue6,
) -> Option<u16> {
    if pref >= min && pref <= max && claim_port_v6(pref, in_val) {
        port_state_bound(&PORT_FREE_V6, pref);
        return Some(pref);
    }
    let mut ctx = PortAllocCtx6 {
        in_val: *in_val,
        primary: PRIMARY as u32,
        index: 0,
        parity: (pref & 1) as u8,
        saw_stale: 0,
        result: 0,
    };
    unsafe {
        bpf_loop(
            (PRIMARY + FALLBACK) as u32,
            alloc_cb_v6 as *const () as *mut c_void,
            &mut ctx as *mut PortAllocCtx6 as *mut c_void,
            0,
        );
    }
    if ctx.result != 0 {
        Some(ctx.result)
    } else {
        if ctx.saw_stale != 0 {
            let _ = PORT_FLAGS.set(0, &1, 0);
        }
        None
    }
}

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
            let old_port = u16::from_be((*val).port);
            let _ = OUTBOUND_BINDINGS_V4.remove(&ep_key);
            if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(&old_port)
                && (*in_val).ip == src_ip
                && (*in_val).port == src_port
            {
                let _ = INBOUND_BINDINGS_V4.remove(&old_port);
                release_port_v4(old_port);
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
    let alloc = alloc_port_v4::<PRIMARY, FALLBACK>(pref, cfg.min_port4, cfg.max_port4, &in_val)?;
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
            let old_port = u16::from_be((*val).port);
            let _ = OUTBOUND_BINDINGS_V6.remove(&ep_key);
            if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(&old_port)
                && ipv6_eq(&(*in_val).ip, &src_ip)
                && (*in_val).port == src_port
            {
                let _ = INBOUND_BINDINGS_V6.remove(&old_port);
                release_port_v6(old_port);
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
    let alloc = alloc_port_v6::<PRIMARY, FALLBACK>(pref, cfg.min_port6, cfg.max_port6, &in_val)?;
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
