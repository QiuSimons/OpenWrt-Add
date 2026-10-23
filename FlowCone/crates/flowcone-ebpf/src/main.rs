#![no_std]
#![no_main]

mod bitmap;
mod csum;

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

#[inline(always)]
fn locate_ipv6_udp(data_end: usize, ip_off: usize, mut nh: u8) -> Option<usize> {
    let mut cur_off = ip_off + 40;
    let mut iter = 0;
    while iter < 4 {
        if nh == IPPROTO_UDP {
            return Some(cur_off);
        }
        if nh == 0 || nh == 43 || nh == 60 {
            if cur_off + 2 > data_end {
                return None;
            }
            let ext_hdr = unsafe { &*(cur_off as *const [u8; 2]) };
            nh = ext_hdr[0];
            let ext_len = (ext_hdr[1] as usize + 1) * 8;
            if cur_off + ext_len > data_end {
                return None;
            }
            cur_off += ext_len;
        } else if nh == 44 {
            if cur_off + 8 > data_end {
                return None;
            }
            let frag_hdr = unsafe { &*(cur_off as *const [u8; 8]) };
            nh = frag_hdr[0];
            let frag_off = u16::from_be_bytes([frag_hdr[2], frag_hdr[3]]);
            if (frag_off & 0xFFF9) != 0 {
                return None;
            }
            cur_off += 8;
        } else {
            return None;
        }
        iter += 1;
    }

    if nh == IPPROTO_UDP {
        Some(cur_off)
    } else {
        None
    }
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
                let ep = EndpointKey4 {
                    ip: new_dst_ip,
                    port: new_dst_port,
                    _pad: 0,
                };
                if let Some(ob) = OUTBOUND_BINDINGS_V4.get_ptr_mut(&ep) {
                    (*ob).last_seen = now;
                }
            }

            iph.check = csum::csum_replace4(iph.check, iph.dst_addr, new_dst_ip);
            if udph.check != 0 {
                let mut c = csum::csum_replace4(udph.check, iph.dst_addr, new_dst_ip);
                c = csum::csum_replace2(c, udph.dst_port, new_dst_port);
                if c == 0 {
                    c = 0xffff;
                }
                udph.check = c;
            }

            iph.dst_addr = new_dst_ip;
            udph.dst_port = new_dst_port;

            unsafe {
                let mark = (*ctx.skb.skb).mark;
                (*ctx.skb.skb).mark = mark | flowcone_common::FLOWCONE_MARK;
            }
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

        let udp_off = match locate_ipv6_udp(data_end, ip_off, iph.next_hdr) {
            Some(off) => off,
            None => return TC_ACT_UNSPEC,
        };

        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };
        let ext_port = u16::from_be(udph.dst_port);

        if let Some(target) = INBOUND_BINDINGS_V6.get_ptr_mut(&ext_port) {
            let new_dst_ip = unsafe { (*target).ip };
            let new_dst_port = unsafe { (*target).port };
            let now = unsafe { bpf_ktime_get_coarse_ns() };
            unsafe {
                (*target).last_seen = now;
                let ep = EndpointKey6 {
                    ip: new_dst_ip,
                    port: new_dst_port,
                    _pad: [0; 3],
                };
                if let Some(ob) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep) {
                    (*ob).last_seen = now;
                }
            }

            let mut csum = csum::csum_replace16(udph.check, &iph.dst_addr, &new_dst_ip);
            csum = csum::csum_replace2(csum, udph.dst_port, new_dst_port);
            if csum == 0 {
                csum = 0xffff;
            }
            udph.check = csum;

            iph.dst_addr = new_dst_ip;
            udph.dst_port = new_dst_port;

            unsafe {
                let mark = (*ctx.skb.skb).mark;
                (*ctx.skb.skb).mark = mark | flowcone_common::FLOWCONE_MARK;
            }
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
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };

        let src_port = udph.src_port;
        let ep_key = EndpointKey4 {
            ip: src_ip,
            port: src_port,
            _pad: 0,
        };

        let now = unsafe { bpf_ktime_get_coarse_ns() };

        let mapped_port = if let Some(val) = OUTBOUND_BINDINGS_V4.get_ptr_mut(&ep_key) {
            unsafe {
                (*val).last_seen = now;
                let p = (*val).port;
                let p_host = u16::from_be(p);
                if let Some(in_val) = INBOUND_BINDINGS_V4.get_ptr_mut(&p_host) {
                    (*in_val).last_seen = now;
                }
                p
            }
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
                    } else {
                        bitmap::mark_port_v4(alloc);
                    }
                }
                attempt += 1;
            }

            match allocated_port {
                Some(p) => p,
                None => return TC_ACT_SHOT,
            }
        };

        iph.check = csum::csum_replace4(iph.check, iph.src_addr, cfg.wan_ip4);
        if udph.check != 0 {
            let mut c = csum::csum_replace4(udph.check, iph.src_addr, cfg.wan_ip4);
            c = csum::csum_replace2(c, udph.src_port, mapped_port);
            if c == 0 {
                c = 0xffff;
            }
            udph.check = c;
        }

        iph.src_addr = cfg.wan_ip4;
        udph.src_port = mapped_port;
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

        let udp_off = match locate_ipv6_udp(data_end, ip_off, iph.next_hdr) {
            Some(off) => off,
            None => return TC_ACT_SHOT,
        };

        if udp_off + mem::size_of::<UdpHdr>() > data_end {
            return TC_ACT_UNSPEC;
        }

        let udph = unsafe { &mut *(udp_off as *mut UdpHdr) };

        let src_addr = iph.src_addr;
        let src_port = udph.src_port;
        let ep_key = EndpointKey6 {
            ip: src_addr,
            port: src_port,
            _pad: [0; 3],
        };

        let now = unsafe { bpf_ktime_get_coarse_ns() };

        let mapped_port = if let Some(val) = OUTBOUND_BINDINGS_V6.get_ptr_mut(&ep_key) {
            unsafe {
                (*val).last_seen = now;
                let p = (*val).port;
                let p_host = u16::from_be(p);
                if let Some(in_val) = INBOUND_BINDINGS_V6.get_ptr_mut(&p_host) {
                    (*in_val).last_seen = now;
                }
                p
            }
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
                    } else {
                        bitmap::mark_port_v6(alloc);
                    }
                }
                attempt += 1;
            }

            match allocated_port {
                Some(p) => p,
                None => return TC_ACT_SHOT,
            }
        };

        let mut csum = csum::csum_replace16(udph.check, &iph.src_addr, &cfg.wan_ip6);
        csum = csum::csum_replace2(csum, udph.src_port, mapped_port);
        if csum == 0 {
            csum = 0xffff;
        }
        udph.check = csum;

        iph.src_addr = cfg.wan_ip6;
        udph.src_port = mapped_port;
    }

    TC_ACT_UNSPEC
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe { core::hint::unreachable_unchecked() }
}
