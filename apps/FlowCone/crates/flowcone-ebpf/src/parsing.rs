use aya_ebpf::programs::TcContext;
use core::mem;
pub use flowcone_common::{
    Ipv6L4, L2Info, ipv6_fragment_offset, locate_ipv6_l4, locate_ipv6_nexthdr, parse_l2,
};

#[repr(C, packed)]
#[derive(Clone, Copy)]
pub struct FragExtHdr {
    pub next_hdr: u8,
    pub reserved: u8,
    pub frag_off: u16,
    pub id: [u8; 4],
}

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

/// Ensures at least `need` bytes from `data` are linearly accessible in
/// `ctx.skb`, pulling paged data if necessary and refreshing `data`/`data_end`.
///
/// Uses direct `data + need <= data_end` comparison instead of `data_end -
/// data` so the Linux eBPF verifier tracks packet bounds without pointer
/// subtraction.
///
/// Any packet references derived from the old `data` pointer are invalidated if
/// `pull_data` runs and must be re-acquired afterwards.
#[inline(always)]
pub fn ensure_linear(ctx: &TcContext, data: &mut usize, data_end: &mut usize, need: usize) -> bool {
    if *data + need <= *data_end {
        return true;
    }
    if need > ctx.len() as usize {
        return false;
    }
    if ctx.skb.pull_data(need as u32).is_err() {
        return false;
    }
    *data = ctx.data();
    *data_end = ctx.data_end();
    *data + need <= *data_end
}

/// Speculatively linearizes up to `max_need` bytes (clamped to `ctx.len()`) so
/// variable-length headers (VLAN/PPPoE/IPv6 extensions) can be parsed without
/// failing on intentionally short packets.
#[inline(always)]
pub fn pull_up_to(ctx: &TcContext, data: &mut usize, data_end: &mut usize, max_need: usize) {
    if *data + max_need <= *data_end {
        return;
    }
    let pkt_len = ctx.len() as usize;
    let pull = if max_need > pkt_len {
        pkt_len
    } else {
        max_need
    };
    if pull > 0 {
        let _ = ctx.skb.pull_data(pull as u32);
        *data = ctx.data();
        *data_end = ctx.data_end();
    }
}

/// Copy a 16-byte IPv6 address using two 64-bit word moves so LLVM never emits
/// `memmove`.
#[inline(always)]
pub fn copy_ipv6(dst: &mut [u8; 16], src: &[u8; 16]) {
    let s = src.as_ptr() as *const u64;
    let d = dst.as_mut_ptr() as *mut u64;
    unsafe {
        core::ptr::write_unaligned(d, core::ptr::read_unaligned(s));
        core::ptr::write_unaligned(d.add(1), core::ptr::read_unaligned(s.add(1)));
    }
}

/// Casts a slice of packet bytes to a mutable reference of type `T`.
///
/// # Safety
///
/// The caller must ensure `ptr` is properly aligned for `T`, points to linear
/// packet memory within `[data, data_end)`, does not alias any other `&mut`
/// reference, and that `'a` does not outlive any subsequent `skb` helper that
/// may linearize or resize the packet buffer.
#[inline(always)]
pub unsafe fn parse_header_ref_mut<'a, T>(ptr: usize, data_end: usize) -> Option<&'a mut T> {
    let size = mem::size_of::<T>();
    if ptr > usize::MAX - size || ptr + size > data_end {
        return None;
    }
    Some(unsafe { &mut *(ptr as *mut T) })
}

/// Compare two IPv6 addresses without alignment assumptions or short-circuit
/// branches.
#[inline(always)]
pub fn ipv6_eq(a: &[u8; 16], b: &[u8; 16]) -> bool {
    let p_a = a.as_ptr() as *const u64;
    let p_b = b.as_ptr() as *const u64;
    unsafe {
        ((core::ptr::read_unaligned(p_a) ^ core::ptr::read_unaligned(p_b))
            | (core::ptr::read_unaligned(p_a.add(1)) ^ core::ptr::read_unaligned(p_b.add(1))))
            == 0
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
