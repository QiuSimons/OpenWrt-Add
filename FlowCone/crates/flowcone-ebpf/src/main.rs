#![no_std]
#![no_main]

mod bitmap;

use aya_ebpf::{
    bindings::{TC_ACT_SHOT, TC_ACT_UNSPEC},
    helpers::bpf_ktime_get_coarse_ns,
    macros::{classifier, map},
    maps::{Array, HashMap},
    programs::TcContext,
};
use core::mem;
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, GlobalConfig, MAX_BINDINGS,
};

const IPPROTO_UDP: u8 = 17;
const IPPROTO_HOPOPTS: u8 = 0;
const IPPROTO_ROUTING: u8 = 43;
const IPPROTO_FRAGMENT: u8 = 44;
const IPPROTO_DSTOPTS: u8 = 60;

// bpf_l3/l4_csum_replace() flags (include/uapi/linux/bpf.h).
const BPF_F_PSEUDO_HDR: u64 = 0x10;
const BPF_F_MARK_MANGLED_0: u64 = 0x20;
const CSUM_FIELD_U16: u64 = 2;
const CSUM_FIELD_U32: u64 = 4;
const IPV4_CSUM_OFFSET: usize = 10; // offsetof(struct iphdr, check)
const UDP_CSUM_OFFSET: usize = 6; // offsetof(struct udphdr, check)

#[unsafe(link_section = "license")]
#[used]
static LICENSE: [u8; 4] = *b"GPL\0";

#[map]
static CONFIG: Array<GlobalConfig> = Array::with_max_entries(1, 0);

const BPF_F_NO_PREALLOC: u32 = 1;

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

#[repr(C, packed)]
struct EthHdr {
    dst: [u8; 6],
    src: [u8; 6],
    proto: u16,
}

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

/// IPv6 upper layer classification.
#[derive(Clone, Copy)]
enum Ipv6L4 {
    /// Offset of the UDP header.
    Udp(usize),
    /// Not UDP, or the header chain cannot be parsed.
    NonUdp,
    /// Non-atomic fragment of a UDP datagram.
    Fragment,
}

/// Walk the IPv6 extension headers and classify the upper layer protocol.
#[inline(always)]
fn locate_ipv6_l4(data_end: usize, ip_off: usize, mut nh: u8) -> Ipv6L4 {
    let mut cur_off = ip_off + 40;
    let mut iter = 0;
    let mut fragmented = false;
    while iter < 4 {
        if nh == IPPROTO_UDP {
            return if fragmented {
                Ipv6L4::Fragment
            } else {
                Ipv6L4::Udp(cur_off)
            };
        }
        if nh == IPPROTO_HOPOPTS || nh == IPPROTO_ROUTING || nh == IPPROTO_DSTOPTS {
            if cur_off + 2 > data_end {
                return if fragmented {
                    Ipv6L4::Fragment
                } else {
                    Ipv6L4::NonUdp
                };
            }
            let ext_hdr = unsafe { &*(cur_off as *const [u8; 2]) };
            nh = ext_hdr[0];
            let ext_len = (ext_hdr[1] as usize + 1) * 8;
            if cur_off + ext_len > data_end {
                return if fragmented {
                    Ipv6L4::Fragment
                } else {
                    Ipv6L4::NonUdp
                };
            }
            cur_off += ext_len;
        } else if nh == IPPROTO_FRAGMENT {
            if cur_off + 8 > data_end {
                return if fragmented {
                    Ipv6L4::Fragment
                } else {
                    Ipv6L4::NonUdp
                };
            }
            let frag_hdr = unsafe { &*(cur_off as *const [u8; 8]) };
            nh = frag_hdr[0];
            let frag_off = u16::from_be_bytes([frag_hdr[2], frag_hdr[3]]);
            // RFC 8200: behind a non-first fragment there is payload, not
            // headers. Only a transport protocol proves it is not UDP.
            if (frag_off & 0xFFF8) != 0 {
                return if nh == IPPROTO_UDP
                    || nh == IPPROTO_HOPOPTS
                    || nh == IPPROTO_ROUTING
                    || nh == IPPROTO_DSTOPTS
                    || nh == IPPROTO_FRAGMENT
                {
                    Ipv6L4::Fragment
                } else {
                    Ipv6L4::NonUdp
                };
            }
            // First fragment (M == 1): header present, not translatable.
            if (frag_off & 0x0001) != 0 {
                fragmented = true;
            }
            cur_off += 8;
        } else {
            return Ipv6L4::NonUdp;
        }
        iter += 1;
    }

    if nh == IPPROTO_UDP {
        if fragmented {
            Ipv6L4::Fragment
        } else {
            Ipv6L4::Udp(cur_off)
        }
    } else if fragmented {
        // Unknown transport while fragmented: fail closed.
        Ipv6L4::Fragment
    } else {
        Ipv6L4::NonUdp
    }
}

/// Fix up the IPv4 header and UDP checksums after an address/port rewrite.
///
/// Must be the last packet access: the helpers may linearize the skb. They
/// handle CHECKSUM_PARTIAL and CHECKSUM_COMPLETE (incl. skb->csum).
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
                // Keep an IPv4 0x0000 (no checksum) and fold a computed 0.
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

/// Fix up the UDP checksum for an IPv6 address/port rewrite; the pseudo
/// header is four u32 words.
///
/// The field is right for every ip_summed state, but 4 x u32 updates change
/// skb->csum where the kernel's replace16() would not (local delivery only).
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

#[classifier]
pub fn flowcone_tcx_ingress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let cfg = match CONFIG.get(0) {
        Some(c) => c,
        _ => return TC_ACT_UNSPEC,
    };

    // Optional proxy / policy-routing bypass mark
    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }

    let (proto, ip_off) = if cfg.l2_len == 14 {
        if data + mem::size_of::<EthHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }
        let eth = unsafe { &*(data as *const EthHdr) };
        (u16::from_be(eth.proto), data + 14)
    } else {
        if data + mem::size_of::<Ipv4Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }
        let ver = unsafe { (*(data as *const u8)) >> 4 };
        let p = if ver == 4 {
            ETH_P_IP
        } else if ver == 6 {
            ETH_P_IPV6
        } else {
            0
        };
        (p, data)
    };

    if proto == ETH_P_IP && cfg.enabled_v4 == 1 {
        // IPv4 DNAT
        if ip_off + mem::size_of::<Ipv4Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv4Hdr) };
        if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_UDP {
            return TC_ACT_UNSPEC;
        }

        if iph.dst_addr != cfg.wan_ip4 {
            return TC_ACT_UNSPEC;
        }

        // Ignore fragmented packets
        let frag_off = u16::from_be(iph.frag_off);
        if (frag_off & 0x3FFF) != 0 {
            return TC_ACT_UNSPEC;
        }

        let ihl = (iph.ver_ihl & 0x0F) as usize * 4;
        if ihl < 20 {
            return TC_ACT_UNSPEC;
        }

        let udp_off = ip_off + ihl;
        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        let ext_port = u16::from_be(udph.dst_port);

        if let Some(target) = INBOUND_BINDINGS_V4.get_ptr_mut(&ext_port) {
            let new_dst_ip = unsafe { (*target).ip };
            let new_dst_port = unsafe { (*target).port };
            let now = unsafe { bpf_ktime_get_coarse_ns() };
            unsafe {
                (*target).last_seen = now;
            }

            let old_dst_ip = iph.dst_addr;
            let old_dst_port = udph.dst_port;

            iph.dst_addr = new_dst_ip;
            udph.dst_port = new_dst_port;

            // The checksum fixups must be the last packet access.
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
            ctx.skb.set_mark(mark | flowcone_common::FLOWCONE_MARK);
        }
    } else if proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        // IPv6 DNAT
        if ip_off + mem::size_of::<Ipv6Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv6Hdr) };
        if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
            return TC_ACT_UNSPEC;
        }

        if iph.dst_addr != cfg.wan_ip6 {
            return TC_ACT_UNSPEC;
        }

        let udp_off = match locate_ipv6_l4(data_end, ip_off, iph.next_hdr) {
            Ipv6L4::Udp(off) => off,
            _ => return TC_ACT_UNSPEC,
        };

        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };

        // RFC 8200: a zero checksum is illegal, cannot be updated; leave it.
        if udph.check == 0 {
            return TC_ACT_UNSPEC;
        }

        let ext_port = u16::from_be(udph.dst_port);

        if let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(&ext_port) {
            let new_dst_ip = unsafe { (*target).ip };
            let new_dst_port = unsafe { (*target).port };
            let now = unsafe { bpf_ktime_get_coarse_ns() };
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
            ctx.skb.set_mark(mark | flowcone_common::FLOWCONE_MARK);
        }
    }

    TC_ACT_UNSPEC
}

#[classifier]
pub fn flowcone_tcx_egress(ctx: TcContext) -> i32 {
    let data = ctx.data();
    let data_end = ctx.data_end();

    let cfg = match CONFIG.get(0) {
        Some(c) => c,
        _ => return TC_ACT_UNSPEC,
    };

    // Optional proxy / policy-routing bypass mark
    if cfg.bypass_mark_mask != 0 {
        let mark = unsafe { (*ctx.skb.skb).mark };
        if (mark & cfg.bypass_mark_mask) == cfg.bypass_mark_val {
            return TC_ACT_UNSPEC;
        }
    }

    let (proto, ip_off) = if cfg.l2_len == 14 {
        if data + mem::size_of::<EthHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }
        let eth = unsafe { &*(data as *const EthHdr) };
        (u16::from_be(eth.proto), data + 14)
    } else {
        if data + mem::size_of::<Ipv4Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }
        let ver = unsafe { (*(data as *const u8)) >> 4 };
        let p = if ver == 4 {
            ETH_P_IP
        } else if ver == 6 {
            ETH_P_IPV6
        } else {
            0
        };
        (p, data)
    };

    if proto == ETH_P_IP && cfg.enabled_v4 == 1 {
        // IPv4 SNAT
        if ip_off + mem::size_of::<Ipv4Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv4Hdr) };
        if (iph.ver_ihl >> 4) != 4 || iph.protocol != IPPROTO_UDP {
            return TC_ACT_UNSPEC;
        }

        let src_ip = iph.src_addr;
        if src_ip == cfg.wan_ip4 {
            return TC_ACT_UNSPEC;
        }

        if !flowcone_common::is_private_ipv4(src_ip) {
            return TC_ACT_UNSPEC;
        }

        // Drop fragmented packets to prevent private IP leakage
        let frag_off = u16::from_be(iph.frag_off);
        if (frag_off & 0x3FFF) != 0 {
            return TC_ACT_SHOT;
        }

        let ihl = (iph.ver_ihl & 0x0F) as usize * 4;
        if ihl < 20 {
            return TC_ACT_UNSPEC;
        }

        let udp_off = ip_off + ihl;
        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            // Nothing to SNAT, so do not leak the private source.
            return TC_ACT_SHOT;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };

        let src_port = udph.src_port;
        let ep_key = EndpointKey4 {
            ip: src_ip,
            port: src_port,
            _pad: 0,
        };

        let now = unsafe { bpf_ktime_get_coarse_ns() };

        // An entry that belongs to a previous WAN address is dropped, so the
        // allocation path below re-creates it with the current one.
        let mut mapped_port = None;
        if let Some(val) = OUTBOUND_BINDINGS_V4.get_ptr_mut(&ep_key) {
            unsafe {
                if (*val).ip == cfg.wan_ip4 {
                    (*val).last_seen = now;
                    mapped_port = Some((*val).port);
                } else {
                    // The inbound slot belongs to the same endpoint; free it so
                    // the client keeps its port after the WAN address changed.
                    let old_port = u16::from_be((*val).port);
                    let _ = OUTBOUND_BINDINGS_V4.remove(&ep_key);
                    if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(&old_port) {
                        if (*in_val).ip == src_ip && (*in_val).port == src_port {
                            let _ = INBOUND_BINDINGS_V4.remove(&old_port);
                            bitmap::free_port_v4(old_port);
                        }
                    }
                }
            }
        }

        let mapped_port = if let Some(mapped_port) = mapped_port {
            mapped_port
        } else {
            let pref = u16::from_be(src_port);
            let mut allocated_port = None;

            let mut attempt: u32 = 0;
            while attempt < 2 {
                let seed = (src_ip ^ (src_port as u32))
                    .wrapping_add(attempt)
                    .wrapping_mul(0x9e3779b9);
                if let Some(alloc) = bitmap::alloc_port_v4(pref, cfg.min_port4, cfg.max_port4, seed)
                {
                    let m_port = u16::to_be(alloc);
                    let in_val = BindingValue4 {
                        ip: src_ip,
                        port: src_port,
                        _pad: 0,
                        last_seen: now,
                    };

                    if INBOUND_BINDINGS_V4.insert(&alloc, &in_val, 1).is_ok() {
                        let new_val = BindingValue4 {
                            ip: cfg.wan_ip4,
                            port: m_port,
                            _pad: 0,
                            last_seen: now,
                        };
                        if OUTBOUND_BINDINGS_V4.insert(&ep_key, &new_val, 1).is_ok() {
                            allocated_port = Some(m_port);
                            break;
                        } else {
                            // Rollback inbound slot on concurrent collision
                            let _ = INBOUND_BINDINGS_V4.remove(&alloc);
                            bitmap::free_port_v4(alloc);
                            if let Some(val) = OUTBOUND_BINDINGS_V4.get_ptr_mut(&ep_key) {
                                allocated_port = Some(unsafe { (*val).port });
                                break;
                            }
                        }
                    } else if INBOUND_BINDINGS_V4.get_ptr_mut(&alloc).is_none() {
                        // The slot was reserved by alloc_port_v4 but never
                        // inserted; keep the bit only if another CPU owns it.
                        bitmap::free_port_v4(alloc);
                    }
                }
                attempt += 1;
            }

            match allocated_port {
                Some(p) => p,
                None => return TC_ACT_SHOT,
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
    } else if proto == ETH_P_IPV6 && cfg.enabled_v6 != 0 {
        // IPv6 SNAT
        if ip_off + mem::size_of::<Ipv6Hdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let iph = unsafe { &mut *(ip_off as *mut Ipv6Hdr) };
        if (u32::from_be(iph.ver_tc_fl) >> 28) != 6 {
            return TC_ACT_UNSPEC;
        }

        if iph.src_addr == cfg.wan_ip6 {
            return TC_ACT_UNSPEC;
        }

        let allow_all_internal = cfg.enabled_v6 > 1;
        if !flowcone_common::is_routable_internal_ipv6(&iph.src_addr, allow_all_internal) {
            return TC_ACT_UNSPEC;
        }

        let udp_off = match locate_ipv6_l4(data_end, ip_off, iph.next_hdr) {
            Ipv6L4::Udp(off) => off,
            // Not UDP: pass through, like the IPv4 egress path.
            Ipv6L4::NonUdp => return TC_ACT_UNSPEC,
            // Fragmented UDP: no port to map, do not leak it.
            Ipv6L4::Fragment => return TC_ACT_SHOT,
        };

        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            // No readable header: do not leak the internal source.
            return TC_ACT_SHOT;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };

        // RFC 8200 forbids a zero checksum; it cannot be translated.
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

        let now = unsafe { bpf_ktime_get_coarse_ns() };

        // Same handling as the IPv4 path.
        let mut mapped_port = None;
        if let Some(val) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep_key) {
            unsafe {
                if (*val).ip == cfg.wan_ip6 {
                    (*val).last_seen = now;
                    mapped_port = Some((*val).port);
                } else {
                    let old_port = u16::from_be((*val).port);
                    let _ = OUTBOUND_BINDINGS_V6.remove(&ep_key);
                    if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(&old_port) {
                        if (*in_val).ip == src_addr && (*in_val).port == src_port {
                            let _ = INBOUND_BINDINGS_V6.remove(&old_port);
                            bitmap::free_port_v6(old_port);
                        }
                    }
                }
            }
        }

        let mapped_port = if let Some(mapped_port) = mapped_port {
            mapped_port
        } else {
            let pref = u16::from_be(src_port);
            let mut allocated_port = None;

            let mut attempt: u32 = 0;
            while attempt < 2 {
                let w0 = u32::from_ne_bytes([src_addr[0], src_addr[1], src_addr[2], src_addr[3]]);
                let w1 = u32::from_ne_bytes([src_addr[4], src_addr[5], src_addr[6], src_addr[7]]);
                let w2 = u32::from_ne_bytes([src_addr[8], src_addr[9], src_addr[10], src_addr[11]]);
                let w3 = u32::from_ne_bytes([src_addr[12], src_addr[13], src_addr[14], src_addr[15]]);
                let src_hash = w0 ^ w1 ^ w2 ^ w3 ^ (src_port as u32);
                let seed = src_hash.wrapping_add(attempt).wrapping_mul(0x9e3779b9);
                if let Some(alloc) = bitmap::alloc_port_v6(pref, cfg.min_port6, cfg.max_port6, seed)
                {
                    let m_port = u16::to_be(alloc);
                    let in_val = BindingValue6 {
                        ip: src_addr,
                        port: src_port,
                        _pad: [0; 3],
                        last_seen: now,
                    };

                    if INBOUND_BINDINGS_V6.insert(&alloc, &in_val, 1).is_ok() {
                        let new_val = BindingValue6 {
                            ip: cfg.wan_ip6,
                            port: m_port,
                            _pad: [0; 3],
                            last_seen: now,
                        };
                        if OUTBOUND_BINDINGS_V6.insert(&ep_key, &new_val, 1).is_ok() {
                            allocated_port = Some(m_port);
                            break;
                        } else {
                            // Rollback inbound slot on concurrent collision
                            let _ = INBOUND_BINDINGS_V6.remove(&alloc);
                            bitmap::free_port_v6(alloc);
                            if let Some(val) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep_key) {
                                allocated_port = Some(unsafe { (*val).port });
                                break;
                            }
                        }
                    } else if INBOUND_BINDINGS_V6.get_ptr_mut(&alloc).is_none() {
                        bitmap::free_port_v6(alloc);
                    }
                }
                attempt += 1;
            }

            match allocated_port {
                Some(p) => p,
                None => return TC_ACT_SHOT,
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

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { core::hint::unreachable_unchecked() }
}
