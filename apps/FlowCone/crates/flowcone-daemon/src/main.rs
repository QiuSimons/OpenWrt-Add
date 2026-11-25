#[cfg(not(target_pointer_width = "64"))]
compile_error!(
    "FlowCone requires a 64-bit architecture (e.g. x86_64, aarch64, mips64, riscv64) for lock-free 64-bit atomic bitmaps shared with eBPF."
);

mod btf;
mod config;
mod data_plane;
mod firewall;
mod netlink;
mod session;

use aya::maps::{Array, HashMap, MapData, RingBuf};
use aya::{EbpfLoader, VerifierLogLevel};
use data_plane::DataPlane;
use firewall::FirewallManager;
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, FragKey4, FragKey6, FragValue4,
    FragValue6, GlobalConfig,
};
use session::{SessionManager, SessionMaps};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::{BorrowedFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rustix::event::{PollFd, PollFlags, poll};
use rustix::time::Timespec;

/// Interval for periodic TCX tail verification.
const REATTACH_INTERVAL: Duration = Duration::from_secs(30);

/// Interval for periodic local UDP service port reservation scans.
const RESERVE_SCAN_INTERVAL: Duration = Duration::from_secs(5);

macro_rules! take_map {
    ($bpf:expr, $name:literal, $ty:ty) => {
        <$ty>::try_from(
            $bpf.take_map($name)
                .ok_or(concat!("map ", $name, " not found"))?,
        )?
    };
}

static EBPF_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/flowcone-ebpf.bin"));
static RUNNING: AtomicBool = AtomicBool::new(true);
static RESYNC_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Installs async-signal-safe signal handlers.
fn setup_signals(sig_write: OwnedFd, wake_write: OwnedFd) {
    let sig_write = Arc::new(sig_write);
    let wake_write = Arc::new(wake_write);

    // SIGINT = 2, SIGTERM = 15
    for sig in [2, 15] {
        let sig_write = Arc::clone(&sig_write);
        let wake_write = Arc::clone(&wake_write);
        let handler = move || {
            RUNNING.store(false, Ordering::SeqCst);
            let _ = rustix::io::write(&*sig_write, &[1u8]);
            let _ = rustix::io::write(&*wake_write, &[1u8]);
        };
        let _ = unsafe { signal_hook_registry::register(sig, handler) };
    }

    // SIGHUP = 1: resync state/rules without dropping the mappings.
    let handler = move || {
        RESYNC_REQUESTED.store(true, Ordering::Relaxed);
        let _ = rustix::io::write(&*wake_write, &[1u8]);
    };
    let _ = unsafe { signal_hook_registry::register(1, handler) };
}

fn get_monotonic_coarse_ns() -> u64 {
    let ts = rustix::time::clock_gettime(rustix::time::ClockId::MonotonicCoarse);
    (ts.tv_sec as u64) * 1_000_000_000 + (ts.tv_nsec as u64)
}

pub fn resolve_effective_v6(enable_v6: bool, wan_ip6: [u8; 16], has_masq: bool) -> u32 {
    if !enable_v6 || wan_ip6 == [0u8; 16] {
        0
    } else if has_masq {
        2
    } else {
        1
    }
}

/// Applied configuration and interface state.
struct AppliedState {
    l2_len: u32,
    l2_known: bool,
    ip4: u32,
    ip6: [u8; 16],
    effective_v6: u32,
    v4_enabled: bool,
    v6_masq: bool,
    liveness: bool,
    ifindex: u32,
    present: bool,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = match config::parse_args() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    println!("flowcone: starting on interface {}", config.iface);
    println!(
        "flowcone: modes: v4={}, v6={}, port range {}-{}, timeout {}s",
        config.enable_v4, config.enable_v6, config.min_port, config.max_port, config.timeout_sec
    );

    // Shutdown notification self-pipe.
    let (sig_read_end, sig_write_end) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;

    // Worker wake self-pipe.
    let (wake_read_end, wake_write_end) = rustix::pipe::pipe_with(
        rustix::pipe::PipeFlags::CLOEXEC | rustix::pipe::PipeFlags::NONBLOCK,
    )?;

    // React to netlink link/address events instead of polling.
    let monitor = match netlink::EventMonitor::new() {
        Ok(monitor) => Some(monitor),
        Err(e) => {
            eprintln!(
                "flowcone: rtnetlink monitor unavailable ({:?}), falling back to polling",
                e
            );
            None
        }
    };
    setup_signals(sig_write_end, wake_write_end);

    let iface_path = format!("/sys/class/net/{}", config.iface);
    if !Path::new(&iface_path).exists() {
        println!(
            "flowcone: waiting for interface {} to be ready...",
            config.iface
        );
        let mut wait_fds = [PollFd::new(&sig_read_end, PollFlags::IN)];
        let wait_ts = Timespec {
            tv_sec: 0,
            tv_nsec: 500_000_000,
        };
        while RUNNING.load(Ordering::Relaxed) {
            if Path::new(&iface_path).exists() {
                println!("flowcone: interface {} is now ready", config.iface);
                break;
            }
            if matches!(poll(&mut wait_fds, Some(&wait_ts)), Ok(n) if n > 0 && wait_fds[0].revents().contains(PollFlags::IN))
            {
                break;
            }
        }
    }
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }

    let btf = btf::find_btf(config.btf_path.as_deref());

    // Try loading with verifier logs disabled first; on error retry with verbose logging.
    let verifier_log = std::env::var_os("FLOWCONE_VERIFIER_LOG").is_some();
    let mut bpf = {
        let mut loader = EbpfLoader::new();
        if let Some(ref b) = btf {
            loader.btf(b);
        }
        loader.verifier_log_level(if verifier_log {
            VerifierLogLevel::DEBUG
        } else {
            VerifierLogLevel::DISABLE
        });
        match loader.load(EBPF_BYTES) {
            Ok(bpf) => bpf,
            Err(first) => {
                eprintln!(
                    "flowcone: eBPF load without verifier log failed ({}), retrying with log",
                    first
                );
                let mut loader = EbpfLoader::new();
                if let Some(ref b) = btf {
                    loader.btf(b);
                }
                loader.verifier_log_level(VerifierLogLevel::VERBOSE);
                loader.load(EBPF_BYTES)?
            }
        }
    };

    let mut session_mgr = SessionManager::new(SessionMaps {
        config_map: take_map!(bpf, "CONFIG", Array<MapData, GlobalConfig>),
        active_map: take_map!(bpf, "ACTIVE_CONFIG", Array<MapData, u32>),
        ob_map4: take_map!(
            bpf,
            "OUTBOUND_BINDINGS_V4",
            HashMap<MapData, EndpointKey4, BindingValue4>
        ),
        ib_map4: take_map!(
            bpf,
            "INBOUND_BINDINGS_V4",
            HashMap<MapData, u16, BindingValue4>
        ),
        ob_map6: take_map!(
            bpf,
            "OUTBOUND_BINDINGS_V6",
            HashMap<MapData, EndpointKey6, BindingValue6>
        ),
        ib_map6: take_map!(
            bpf,
            "INBOUND_BINDINGS_V6",
            HashMap<MapData, u16, BindingValue6>
        ),
        frag_in4: take_map!(bpf, "FRAG_IN_V4", HashMap<MapData, FragKey4, FragValue4>),
        frag_out4: take_map!(bpf, "FRAG_OUT_V4", HashMap<MapData, FragKey4, FragValue4>),
        frag_in6: take_map!(bpf, "FRAG_IN_V6", HashMap<MapData, FragKey6, FragValue6>),
        frag_out6: take_map!(bpf, "FRAG_OUT_V6", HashMap<MapData, FragKey6, FragValue6>),
        events4: take_map!(bpf, "SESSION_EVENTS_V4", RingBuf<MapData>),
        events6: take_map!(bpf, "SESSION_EVENTS_V6", RingBuf<MapData>),
        gc_flags: take_map!(bpf, "GC_FLAGS", Array<MapData, u32>),
        reserved4: take_map!(bpf, "RESERVED_V4", Array<MapData, u16>),
        reserved6: take_map!(bpf, "RESERVED_V6", Array<MapData, u16>),
        bitmap_even4: take_map!(bpf, "BITMAP_EVEN_V4", Array<MapData, u64>),
        bitmap_odd4: take_map!(bpf, "BITMAP_ODD_V4", Array<MapData, u64>),
        bitmap_even6: take_map!(bpf, "BITMAP_EVEN_V6", Array<MapData, u64>),
        bitmap_odd6: take_map!(bpf, "BITMAP_ODD_V6", Array<MapData, u64>),
        port_flags: take_map!(bpf, "PORT_FLAGS", Array<MapData, u32>),
    })?;

    session_mgr.configure_port_pool(config.min_port, config.max_port);
    session_mgr.reserve_local_ports();
    session_mgr.init_port_pool(config.enable_v4, config.enable_v6);

    let initial_l2 = netlink::get_iface_l2_len(&config.iface);
    match initial_l2 {
        Some(l2_len) => {
            if config.verbose {
                println!(
                    "flowcone: detected L2 header length: {} bytes for interface {}",
                    l2_len, config.iface
                );
            }
        }
        None => eprintln!(
            "flowcone: interface {} TYPE unreadable; NAT stays disabled",
            config.iface
        ),
    }

    let mut data_plane = DataPlane::start(bpf, &config.iface)?;
    let mut firewall_mgr = FirewallManager::new();
    let start_ifindex = netlink::get_ifindex(&config.iface).unwrap_or(0);

    let mut applied = AppliedState {
        l2_len: initial_l2.unwrap_or(0),
        l2_known: initial_l2.is_some(),
        ip4: 0,
        ip6: [0u8; 16],
        effective_v6: 0,
        v4_enabled: false,
        v6_masq: false,
        liveness: false,
        ifindex: start_ifindex,
        present: start_ifindex != 0,
    };
    let mut frag_epoch: u32 = 0;
    let mut flush_v4 = false;
    let mut flush_v6 = false;
    let mut l2_warned = initial_l2.is_none();
    let mut last_attach_check = Instant::now();
    let mut last_reserve_scan = Instant::now();
    let mut last_liveness_refresh = Instant::now();
    let mut last_gc_run = Instant::now();
    let gc_base_interval = Duration::from_secs(config.gc_interval_sec.max(1));
    let mut gc_interval = gc_base_interval;
    let mut rng_state = get_monotonic_coarse_ns() ^ 0x9e3779b97f4a7c15;
    let mut has_net_event = true;
    let mut cur_ifindex;

    let (ev4_raw, ev6_raw) = session_mgr.event_fds();
    let ev4_fd = unsafe { BorrowedFd::borrow_raw(ev4_raw) };
    let ev6_fd = unsafe { BorrowedFd::borrow_raw(ev6_raw) };

    while RUNNING.load(Ordering::SeqCst) {
        // Calculate poll timeout based on nearest timer.
        let time_to_gc = gc_interval.saturating_sub(last_gc_run.elapsed());
        let time_to_reserve = RESERVE_SCAN_INTERVAL.saturating_sub(last_reserve_scan.elapsed());
        let time_to_attach = REATTACH_INTERVAL.saturating_sub(last_attach_check.elapsed());
        let time_to_liveness = if config.manage_nft && applied.liveness {
            Duration::from_secs(5).saturating_sub(last_liveness_refresh.elapsed())
        } else {
            Duration::from_secs(3600)
        };
        let mut next_wake = time_to_gc
            .min(time_to_reserve)
            .min(time_to_attach)
            .min(time_to_liveness);

        if monitor.is_none() {
            let has_wan_addr = (!config.enable_v4 || applied.ip4 != 0)
                && (!config.enable_v6 || applied.ip6 != [0u8; 16]);
            let fallback_poll = Duration::from_secs(if has_wan_addr { 5 } else { 1 });
            next_wake = next_wake.min(fallback_poll);
        }

        let next_wake = next_wake.clamp(Duration::from_millis(1), Duration::from_secs(60));
        let ts = Timespec {
            tv_sec: next_wake.as_secs() as i64,
            tv_nsec: next_wake.subsec_nanos() as i64,
        };

        use std::os::fd::AsFd;
        let mon_borrowed = monitor
            .as_ref()
            .map(|m| m.as_fd())
            .unwrap_or(sig_read_end.as_fd());
        let mut poll_fds = [
            PollFd::new(&sig_read_end, PollFlags::IN),
            PollFd::new(&wake_read_end, PollFlags::IN),
            PollFd::new(
                &ev4_fd,
                if config.enable_v4 {
                    PollFlags::IN
                } else {
                    PollFlags::empty()
                },
            ),
            PollFd::new(
                &ev6_fd,
                if config.enable_v6 {
                    PollFlags::IN
                } else {
                    PollFlags::empty()
                },
            ),
            PollFd::new(
                &mon_borrowed,
                if monitor.is_some() {
                    PollFlags::IN
                } else {
                    PollFlags::empty()
                },
            ),
        ];
        let poll_slice = if monitor.is_some() {
            &mut poll_fds[..5]
        } else {
            &mut poll_fds[..4]
        };

        match poll(poll_slice, Some(&ts)) {
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => {
                if !RUNNING.load(Ordering::SeqCst) {
                    break;
                }
            }
            Err(e) => {
                eprintln!("flowcone: poll error: {:?}", e);
                break;
            }
        }

        if poll_fds[0].revents().contains(PollFlags::IN) || !RUNNING.load(Ordering::SeqCst) {
            break;
        }

        if poll_fds[1].revents().contains(PollFlags::IN) {
            let mut buf = [0u8; 32];
            let mut eof = false;
            while let Ok(n) = rustix::io::read(&wake_read_end, &mut buf) {
                if n == 0 {
                    eof = true;
                    break;
                }
            }
            if eof {
                eprintln!("flowcone: wake pipe closed, exiting reactor");
                break;
            }
            has_net_event = true;
        }

        if monitor.is_some() && poll_fds[4].revents().contains(PollFlags::IN) {
            if let Some(ref m) = monitor {
                m.drain();
            }
            has_net_event = true;
        }

        let ev4_ready = poll_fds[2].revents().contains(PollFlags::IN);
        let ev6_ready = poll_fds[3].revents().contains(PollFlags::IN);
        if ev4_ready || ev6_ready {
            let now_sec = (get_monotonic_coarse_ns() / 1_000_000_000) as u32;
            let was_idle = session_mgr.is_idle();
            let drained = session_mgr.drain_events(now_sec, config.timeout_sec as u32);
            if ((was_idle && !session_mgr.is_idle()) || drained > 0)
                && gc_interval > gc_base_interval
            {
                gc_interval = gc_base_interval;
            }
        }

        if last_gc_run.elapsed() >= gc_interval {
            let now_sec = (get_monotonic_coarse_ns() / 1_000_000_000) as u32;
            let (v4_swept, v6_swept, backlog) =
                session_mgr.gc_tick(now_sec, config.timeout_sec as u32);
            if config.verbose && (v4_swept > 0 || v6_swept > 0) {
                println!(
                    "flowcone: swept {} v4 and {} v6 expired sessions",
                    v4_swept, v6_swept
                );
            }
            if backlog {
                gc_interval = Duration::from_millis(5);
            } else if session_mgr.is_idle() {
                gc_interval = Duration::from_secs(300);
            } else {
                rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
                let jitter_ms = ((rng_state >> 33) % 501) as i64 - 250;
                let target_ms = (gc_base_interval.as_millis() as i64 + jitter_ms).max(500) as u64;
                gc_interval = Duration::from_millis(target_ms);
            }
            last_gc_run = Instant::now();
        }

        if last_reserve_scan.elapsed() >= RESERVE_SCAN_INTERVAL {
            let p4 = session::scan_local_udp_ports(2, "/proc/net/udp");
            let p6 = session::scan_local_udp_ports(10, "/proc/net/udp6");
            session_mgr.apply_reserved_ports(p4.as_deref(), p6.as_deref());
            last_reserve_scan = Instant::now();
        }

        let resync = RESYNC_REQUESTED.swap(false, Ordering::Relaxed);
        let reattach_due = applied.present && last_attach_check.elapsed() >= REATTACH_INTERVAL;
        let has_wan_addr = (!config.enable_v4 || applied.ip4 != 0)
            && (!config.enable_v6 || applied.ip6 != [0u8; 16]);
        let needs_probe = has_net_event
            || resync
            || reattach_due
            || !applied.present
            || !applied.l2_known
            || !has_wan_addr;

        if needs_probe {
            has_net_event = false;
            let mut config_dirty = resync;
            let mut reattach = false;
            let mut force_new_attach = false;
            let mut notable = false;
            let mut resolved_ip4 = applied.ip4;
            let mut resolved_ip6 = applied.ip6;

            match netlink::get_iface_l2_len(&config.iface) {
                Some(l2) => {
                    if !applied.l2_known || applied.l2_len != l2 {
                        applied.l2_len = l2;
                        applied.l2_known = true;
                        l2_warned = false;
                        config_dirty = true;
                    }
                }
                None => {
                    if applied.l2_known {
                        applied.l2_known = false;
                        config_dirty = true;
                    }
                    if !l2_warned {
                        eprintln!(
                            "flowcone: interface {} TYPE unreadable; NAT stays disabled",
                            config.iface
                        );
                        l2_warned = true;
                    }
                }
            }

            cur_ifindex = netlink::get_ifindex(&config.iface).unwrap_or(0);
            let present = cur_ifindex != 0;
            if present && (!applied.present || cur_ifindex != applied.ifindex) {
                println!(
                    "flowcone: interface {} re-created (ifindex {} -> {}), re-attaching",
                    config.iface, applied.ifindex, cur_ifindex
                );
                reattach = true;
                force_new_attach = true;
                notable = true;
                config_dirty = true;
                last_attach_check = Instant::now();
            } else if present && reattach_due {
                last_attach_check = Instant::now();
                reattach = true;
            }
            applied.present = present;

            let cur_v4 = if applied.ip4 != 0 {
                Some(applied.ip4.to_ne_bytes())
            } else {
                None
            };
            let cur_v6 = if applied.ip6 != [0u8; 16] {
                Some(applied.ip6)
            } else {
                None
            };
            let iface_addrs = netlink::get_iface_addrs(cur_ifindex, cur_v4, cur_v6);
            if config.enable_v4 {
                match iface_addrs.as_ref().map(|a| a.v4) {
                    Ok(Some(ip4_bytes)) => {
                        let ip4 = u32::from_ne_bytes(ip4_bytes);
                        if ip4 != applied.ip4 {
                            println!(
                                "flowcone: WAN IPv4 updated to {}",
                                Ipv4Addr::from(ip4_bytes)
                            );
                            if applied.ip4 != 0 {
                                println!("flowcone: flushing stale v4 mappings");
                            }
                            flush_v4 = true;
                            frag_epoch = frag_epoch.wrapping_add(1);
                            applied.ip4 = ip4;
                            resolved_ip4 = ip4;
                            config_dirty = true;
                        }
                    }
                    Ok(None) => {
                        if applied.ip4 != 0 {
                            println!("flowcone: WAN interface lost IPv4");
                            flush_v4 = true;
                            frag_epoch = frag_epoch.wrapping_add(1);
                            applied.ip4 = 0;
                            resolved_ip4 = 0;
                            config_dirty = true;
                        }
                    }
                    Err(e) => {
                        if config.verbose {
                            eprintln!(
                                "flowcone: warning: transient netlink address query error: {:?}",
                                e
                            );
                        }
                    }
                }
            }

            if config.enable_v6 {
                match iface_addrs.as_ref().map(|a| a.v6) {
                    Ok(Some(ip6)) => {
                        if ip6 != applied.ip6 {
                            println!("flowcone: WAN IPv6 updated to {}", Ipv6Addr::from(ip6));
                            if applied.ip6 != [0u8; 16] {
                                println!("flowcone: flushing stale v6 mappings");
                            }
                            flush_v6 = true;
                            frag_epoch = frag_epoch.wrapping_add(1);
                            applied.ip6 = ip6;
                            resolved_ip6 = ip6;
                            config_dirty = true;
                        }
                    }
                    Ok(None) => {
                        if applied.ip6 != [0u8; 16] {
                            println!("flowcone: WAN interface lost IPv6");
                            flush_v6 = true;
                            frag_epoch = frag_epoch.wrapping_add(1);
                            applied.ip6 = [0u8; 16];
                            resolved_ip6 = [0u8; 16];
                            config_dirty = true;
                        }
                    }
                    Err(e) => {
                        if config.verbose {
                            eprintln!(
                                "flowcone: warning: transient netlink address query error: {:?}",
                                e
                            );
                        }
                    }
                }
            }

            if config_dirty {
                let is_v6_masq = firewall::is_ipv6_masq_enabled(&config.iface);
                let effective_v6 = if applied.l2_known {
                    resolve_effective_v6(config.enable_v6, resolved_ip6, is_v6_masq)
                } else {
                    0
                };

                if effective_v6 != applied.effective_v6 {
                    let desc = match effective_v6 {
                        0 => "disabled (no WAN IPv6 address)",
                        1 => "auto-adaptive (ULA NAT66 + Native GUA wire-speed routing)",
                        2 => "full NAT66 (masquerade detected in nftables)",
                        _ => "custom",
                    };
                    println!("flowcone: IPv6 operational mode: {}", desc);
                }

                let active_v4 = config.enable_v4 && resolved_ip4 != 0 && applied.l2_known;
                let shrinking =
                    (applied.v4_enabled && !active_v4) || (applied.effective_v6 > effective_v6);
                let mut stage_ok = true;
                let mut rules_staged = false;
                let fw_cfg = firewall::FirewallConfig {
                    iface: &config.iface,
                    enable_v4: active_v4,
                    enable_v6: effective_v6 != 0,
                    is_v6_masq,
                    mark: config.flowcone_mark,
                    bypass_mask: config.bypass_mark_mask,
                    bypass_val: config.bypass_mark_val,
                    verbose: config.verbose,
                };

                if config.manage_nft && shrinking {
                    stage_ok = firewall_mgr.sync_rules(&fw_cfg);
                    if !stage_ok {
                        eprintln!(
                            "flowcone: could not stage new firewall rules; keeping old data plane"
                        );
                        RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                    } else {
                        rules_staged = true;
                    }
                }

                if stage_ok {
                    let g_cfg = GlobalConfig {
                        wan_ip4: resolved_ip4,
                        bypass_mark_mask: config.bypass_mark_mask,
                        bypass_mark_val: config.bypass_mark_val,
                        l2_len: applied.l2_len,
                        wan_ip6: resolved_ip6,
                        min_port4: config.min_port,
                        max_port4: config.max_port,
                        min_port6: config.min_port,
                        max_port6: config.max_port,
                        enabled_v4: if active_v4 { 1 } else { 0 },
                        enabled_v6: effective_v6,
                        flowcone_mark: config.flowcone_mark,
                        frag_epoch,
                        timeout_sec: config.timeout_sec as u32,
                    };
                    let had_flush = flush_v4 || flush_v6;
                    let set_ok = if had_flush {
                        let ok = session_mgr.set_config(g_cfg);
                        if ok {
                            if flush_v4 {
                                session_mgr.clear_v4_mappings();
                            }
                            if flush_v6 {
                                session_mgr.clear_v6_mappings();
                            }
                            flush_v4 = false;
                            flush_v6 = false;
                        } else {
                            eprintln!("flowcone: could not publish pre-clear config");
                            RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                        }
                        ok
                    } else {
                        session_mgr.set_config(g_cfg)
                    };

                    if !set_ok {
                        eprintln!("flowcone: could not publish data-plane config");
                        RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                    } else if config.manage_nft {
                        let sync_ok = rules_staged || firewall_mgr.sync_rules(&fw_cfg);
                        if sync_ok {
                            applied.v4_enabled = active_v4;
                            applied.effective_v6 = effective_v6;
                            applied.v6_masq = is_v6_masq;
                            applied.liveness = firewall_mgr.liveness_supported();
                            firewall_mgr.refresh_liveness(
                                active_v4,
                                effective_v6 != 0,
                                is_v6_masq,
                                config.verbose,
                            );
                            last_liveness_refresh = Instant::now();
                        } else {
                            eprintln!("flowcone: firewall sync failed; will retry");
                            RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                        }
                    } else {
                        applied.v4_enabled = active_v4;
                        applied.effective_v6 = effective_v6;
                        applied.v6_masq = is_v6_masq;
                        applied.liveness = false;
                    }
                }
            }

            if reattach {
                let attached = if force_new_attach {
                    match data_plane.attach(true, false) {
                        Ok(()) => true,
                        Err(e) => {
                            eprintln!(
                                "flowcone: warning: re-attach on {} failed: {}; will retry on link update",
                                config.iface, e
                            );
                            if config.manage_nft {
                                firewall_mgr.remove_rules(config.verbose);
                            }
                            false
                        }
                    }
                } else {
                    match data_plane.ensure_last(config.verbose) {
                        Ok(_) => true,
                        Err(e) => {
                            eprintln!(
                                "flowcone: TCX tail rotation failed: {}; old links retained",
                                e
                            );
                            false
                        }
                    }
                };
                if attached {
                    applied.ifindex = cur_ifindex;
                    if notable {
                        println!(
                            "flowcone: TCX programs re-attached to {} (ifindex {})",
                            config.iface, cur_ifindex
                        );
                    } else if config.verbose {
                        println!(
                            "flowcone: TCX tail verified on {} (ifindex {})",
                            config.iface, cur_ifindex
                        );
                    }
                }
            }
        }

        if config.manage_nft
            && applied.liveness
            && last_liveness_refresh.elapsed() >= Duration::from_secs(5)
        {
            if !firewall_mgr.refresh_liveness(
                applied.v4_enabled,
                applied.effective_v6 != 0,
                applied.v6_masq,
                config.verbose,
            ) {
                if config.verbose {
                    eprintln!("flowcone: liveness refresh failed; scheduling resync");
                }
                RESYNC_REQUESTED.store(true, Ordering::Relaxed);
            }
            last_liveness_refresh = Instant::now();
        }
    }

    println!("flowcone: stopping");
    if config.manage_nft {
        firewall_mgr.remove_rules(config.verbose);
    }
    session_mgr.disable_fail_open();
    data_plane.detach();
    if config.verbose {
        println!("flowcone: detached TCX classifiers");
    }
    println!("flowcone: stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_effective_v6() {
        let dummy_ip = [
            0x24, 0x0e, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67,
            0x89, 0xab,
        ];
        let zero_ip = [0u8; 16];

        assert_eq!(resolve_effective_v6(false, dummy_ip, false), 0);
        assert_eq!(resolve_effective_v6(false, dummy_ip, true), 0);

        assert_eq!(resolve_effective_v6(true, zero_ip, false), 0);
        assert_eq!(resolve_effective_v6(true, zero_ip, true), 0);

        assert_eq!(resolve_effective_v6(true, dummy_ip, false), 1);
        assert_eq!(resolve_effective_v6(true, dummy_ip, true), 2);
    }
}
