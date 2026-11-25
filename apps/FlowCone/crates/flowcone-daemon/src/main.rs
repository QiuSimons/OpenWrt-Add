#[cfg(not(target_pointer_width = "64"))]
compile_error!(
    "FlowCone requires a 64-bit architecture (e.g. x86_64, aarch64, riscv64) for lock-free 64-bit atomic bitmaps shared with eBPF."
);

mod btf;
mod config;
mod data_plane;
mod firewall;
mod netlink;
mod session;

use aya::maps::{Array, HashMap, MapData, RingBuf};
use aya::{Ebpf, EbpfError, EbpfLoader, VerifierLogLevel};
use config::CliAction;
use data_plane::DataPlane;
use firewall::FirewallManager;
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, FragKey4, FragKey6, FragValue4,
    FragValue6, GlobalConfig,
};
use session::{LocalUdpScanner, SessionManager, SessionMaps};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rustix::event::{PollFd, PollFlags, poll};
use rustix::time::Timespec;

const SIGINT: i32 = 2;
const SIGTERM: i32 = 15;
const SIGHUP: i32 = 1;

/// Interval for periodic TCX tail verification.
const REATTACH_INTERVAL: Duration = Duration::from_secs(30);

/// Interval for periodic local UDP service port reservation scans.
const RESERVE_SCAN_INTERVAL: Duration = Duration::from_secs(5);

/// Interval for liveness set timeout refreshes.
const LIVENESS_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// Backoff before retrying transient firewall/attach failures.
const RETRY_INTERVAL: Duration = Duration::from_secs(2);

macro_rules! take_map {
    ($bpf:expr, $name:literal, $ty:ty) => {
        <$ty>::try_from(
            $bpf.take_map($name)
                .ok_or(concat!("map ", $name, " not found"))?,
        )?
    };
}

static EBPF_BYTES: &[u8] =
    aya::include_bytes_aligned!(concat!(env!("OUT_DIR"), "/flowcone-ebpf.bin"));
static RUNNING: AtomicBool = AtomicBool::new(true);
static RESYNC_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Installs async-signal-safe signal handlers.
fn setup_signals(sig_write: OwnedFd, wake_write: OwnedFd) {
    let sig_write = Arc::new(sig_write);
    let wake_write = Arc::new(wake_write);

    for sig in [SIGINT, SIGTERM] {
        let sig_write = Arc::clone(&sig_write);
        let wake_write = Arc::clone(&wake_write);
        let handler = move || {
            RUNNING.store(false, Ordering::SeqCst);
            let _ = rustix::io::write(&*sig_write, &[1u8]);
            let _ = rustix::io::write(&*wake_write, &[1u8]);
        };
        let _ = unsafe { signal_hook_registry::register(sig, handler) };
    }

    // SIGHUP: resync state/rules without dropping mappings.
    let handler = move || {
        RESYNC_REQUESTED.store(true, Ordering::Relaxed);
        let _ = rustix::io::write(&*wake_write, &[1u8]);
    };
    let _ = unsafe { signal_hook_registry::register(SIGHUP, handler) };
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

fn shrink_disabled_family_maps<'a>(loader: &mut EbpfLoader<'a>, enable_v4: bool, enable_v6: bool) {
    let ring_min = (rustix::param::page_size() as u32).max(4096);
    if !enable_v4 {
        for name in [
            "OUTBOUND_BINDINGS_V4",
            "INBOUND_BINDINGS_V4",
            "FRAG_IN_V4",
            "FRAG_OUT_V4",
            "RESERVED_V4",
            "BITMAP_EVEN_V4",
            "BITMAP_ODD_V4",
        ] {
            loader.map_max_entries(name, 1);
        }
        loader.map_max_entries("SESSION_EVENTS_V4", ring_min);
    }
    if !enable_v6 {
        for name in [
            "OUTBOUND_BINDINGS_V6",
            "INBOUND_BINDINGS_V6",
            "FRAG_IN_V6",
            "FRAG_OUT_V6",
            "RESERVED_V6",
            "BITMAP_EVEN_V6",
            "BITMAP_ODD_V6",
        ] {
            loader.map_max_entries(name, 1);
        }
        loader.map_max_entries("SESSION_EVENTS_V6", ring_min);
    }
}

fn load_ebpf_object(
    custom_btf: Option<&aya::Btf>,
    enable_v4: bool,
    enable_v6: bool,
    level: VerifierLogLevel,
) -> Result<Ebpf, EbpfError> {
    let mut loader = EbpfLoader::new();
    shrink_disabled_family_maps(&mut loader, enable_v4, enable_v6);
    if let Some(b) = custom_btf {
        loader.btf(b);
    } else {
        loader.btf_source(btf::load_kernel_btf_with);
    }
    loader.verifier_log_level(level);
    loader.load(EBPF_BYTES)
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
        Ok(CliAction::Run(c)) => c,
        Ok(CliAction::ExitOk) => return Ok(()),
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
        while RUNNING.load(Ordering::Relaxed) && !Path::new(&iface_path).exists() {
            let mon_fd = monitor
                .as_ref()
                .map(|m| m.as_fd())
                .unwrap_or(sig_read_end.as_fd());
            let mut wait_fds = [
                PollFd::new(&sig_read_end, PollFlags::IN),
                PollFd::new(
                    &mon_fd,
                    if monitor.is_some() {
                        PollFlags::IN | PollFlags::ERR
                    } else {
                        PollFlags::empty()
                    },
                ),
            ];
            let wait_slice = if monitor.is_some() {
                &mut wait_fds[..2]
            } else {
                &mut wait_fds[..1]
            };
            let wait_ts = if monitor.is_some() {
                Timespec {
                    tv_sec: 2,
                    tv_nsec: 0,
                }
            } else {
                Timespec {
                    tv_sec: 0,
                    tv_nsec: 500_000_000,
                }
            };
            if let Ok(n) = poll(wait_slice, Some(&wait_ts))
                && n > 0
            {
                if wait_slice[0].revents().contains(PollFlags::IN) {
                    break;
                }
                if let Some(ref m) = monitor
                    && wait_slice[1]
                        .revents()
                        .intersects(PollFlags::IN | PollFlags::ERR)
                {
                    let _ = m.drain_relevant(0, &config.iface);
                }
            }
        }
        if Path::new(&iface_path).exists() {
            println!("flowcone: interface {} is now ready", config.iface);
        }
    }
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }
    if let Some(ref m) = monitor {
        let _ = m.drain_relevant(0, &config.iface);
    }

    let verifier_log = std::env::var_os("FLOWCONE_VERIFIER_LOG").is_some();
    let mut bpf = {
        let custom_btf = btf::load_custom_btf(config.btf_path.as_deref())?;
        let first_level = if verifier_log {
            VerifierLogLevel::DEBUG
        } else {
            VerifierLogLevel::DISABLE
        };
        match load_ebpf_object(
            custom_btf.as_ref(),
            config.enable_v4,
            config.enable_v6,
            first_level,
        ) {
            Ok(bpf) => bpf,
            Err(first) => {
                eprintln!(
                    "flowcone: eBPF load without verifier log failed ({}), retrying with log",
                    first
                );
                load_ebpf_object(
                    custom_btf.as_ref(),
                    config.enable_v4,
                    config.enable_v6,
                    VerifierLogLevel::VERBOSE,
                )?
            }
        }
    };

    let mut session_mgr = SessionManager::new(
        SessionMaps {
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
        },
        config.enable_v4,
        config.enable_v6,
    )?;

    let mut udp_scanner = LocalUdpScanner::new();
    session_mgr.configure_port_pool(config.min_port, config.max_port);
    session_mgr.init_port_pool(config.enable_v4, config.enable_v6);
    session_mgr.reserve_local_ports(&mut udp_scanner);

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
    let mut retry_deadline: Option<Instant> = None;

    while RUNNING.load(Ordering::SeqCst) {
        // Calculate poll timeout based on nearest timer.
        let now_instant = Instant::now();
        let time_to_gc = gc_interval.saturating_sub(last_gc_run.elapsed());
        let time_to_reserve = RESERVE_SCAN_INTERVAL.saturating_sub(last_reserve_scan.elapsed());
        let time_to_attach = if applied.present {
            REATTACH_INTERVAL.saturating_sub(last_attach_check.elapsed())
        } else {
            Duration::from_secs(3600)
        };
        let time_to_liveness = if config.manage_nft
            && applied.liveness
            && (applied.v4_enabled || applied.effective_v6 != 0)
        {
            LIVENESS_REFRESH_INTERVAL.saturating_sub(last_liveness_refresh.elapsed())
        } else {
            Duration::from_secs(3600)
        };
        let time_to_retry = retry_deadline
            .map(|d| d.saturating_duration_since(now_instant))
            .unwrap_or(Duration::from_secs(3600));
        let mut next_wake = time_to_gc
            .min(time_to_reserve)
            .min(time_to_attach)
            .min(time_to_liveness)
            .min(time_to_retry);

        if monitor.is_none() {
            let has_wan_addr = (!config.enable_v4 || applied.ip4 != 0)
                && (!config.enable_v6 || applied.ip6 != [0u8; 16]);
            let fallback_poll = Duration::from_secs(if has_wan_addr { 5 } else { 1 });
            next_wake = next_wake.min(fallback_poll);
        }

        let immediate_probe = has_net_event
            || RESYNC_REQUESTED.load(Ordering::Relaxed)
            || retry_deadline.is_some_and(|d| now_instant >= d);
        let next_wake = if immediate_probe {
            Duration::ZERO
        } else {
            next_wake.clamp(Duration::from_millis(1), Duration::from_secs(60))
        };
        let ts = Timespec {
            tv_sec: next_wake.as_secs() as i64,
            tv_nsec: next_wake.subsec_nanos() as i64,
        };

        let (ev4_fd, ev6_fd) = session_mgr.event_fds();
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
                    PollFlags::IN | PollFlags::ERR
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

        if let Some(ref m) = monitor
            && poll_fds[4]
                .revents()
                .intersects(PollFlags::IN | PollFlags::ERR)
            && m.drain_relevant(applied.ifindex, &config.iface)
        {
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
            session_mgr.reserve_local_ports(&mut udp_scanner);
            last_reserve_scan = Instant::now();
        }

        let resync = RESYNC_REQUESTED.swap(false, Ordering::Relaxed);
        let retry_due = retry_deadline.is_some_and(|d| Instant::now() >= d);
        if retry_due {
            retry_deadline = None;
        }
        let reattach_due = applied.present && last_attach_check.elapsed() >= REATTACH_INTERVAL;
        let has_wan_addr = (!config.enable_v4 || applied.ip4 != 0)
            && (!config.enable_v6 || applied.ip6 != [0u8; 16]);
        let needs_probe = has_net_event
            || resync
            || retry_due
            || (!applied.present && monitor.is_none())
            || (!has_wan_addr && monitor.is_none());

        let mut rotated_on_probe = false;
        if needs_probe {
            has_net_event = false;
            let mut config_dirty = resync || retry_due;
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

            let cur_ifindex = netlink::get_ifindex(&config.iface).unwrap_or(0);
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
            } else if !present {
                applied.ifindex = 0;
            } else if reattach_due {
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
                        retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
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
                        retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
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
                let is_v6_masq =
                    if config.enable_v6 && resolved_ip6 != [0u8; 16] && applied.l2_known {
                        firewall::is_ipv6_masq_enabled(&config.iface)
                    } else {
                        false
                    };
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
                        retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
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
                    let clear_frag = frag_epoch == 0;
                    let had_flush = flush_v4 || flush_v6;
                    let set_ok = if had_flush {
                        let ok = session_mgr.set_config(g_cfg);
                        if ok {
                            if flush_v4 {
                                session_mgr.clear_v4_mappings(clear_frag);
                            }
                            if flush_v6 {
                                session_mgr.clear_v6_mappings(clear_frag);
                            }
                            flush_v4 = false;
                            flush_v6 = false;
                        } else {
                            eprintln!("flowcone: could not publish pre-clear config");
                            retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
                        }
                        ok
                    } else {
                        session_mgr.set_config(g_cfg)
                    };

                    if !set_ok {
                        eprintln!("flowcone: could not publish data-plane config");
                        retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
                    } else if config.manage_nft {
                        let sync_ok = rules_staged || firewall_mgr.sync_rules(&fw_cfg);
                        if sync_ok {
                            applied.v4_enabled = active_v4;
                            applied.effective_v6 = effective_v6;
                            applied.v6_masq = is_v6_masq;
                            applied.liveness =
                                firewall_mgr.liveness_supported(active_v4, effective_v6 != 0);
                            if applied.liveness {
                                if !firewall_mgr.refresh_liveness(
                                    active_v4,
                                    effective_v6 != 0,
                                    is_v6_masq,
                                    config.verbose,
                                ) {
                                    retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
                                }
                                last_liveness_refresh = Instant::now();
                            }
                        } else {
                            eprintln!("flowcone: firewall sync failed; will retry");
                            retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
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
                rotated_on_probe = true;
                let attached = if force_new_attach {
                    match data_plane.attach(true, false) {
                        Ok(()) => true,
                        Err(e) => {
                            eprintln!(
                                "flowcone: warning: re-attach on {} failed: {}; will retry",
                                config.iface, e
                            );
                            session_mgr.disable_fail_open();
                            if config.manage_nft {
                                firewall_mgr.remove_rules(config.verbose);
                            }
                            applied.v4_enabled = false;
                            applied.effective_v6 = 0;
                            applied.liveness = false;
                            retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
                            false
                        }
                    }
                } else {
                    match data_plane.ensure_last(config.verbose) {
                        Ok(()) => true,
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

        if reattach_due && !rotated_on_probe {
            last_attach_check = Instant::now();
            match data_plane.ensure_last(config.verbose) {
                Ok(()) => {
                    if config.verbose {
                        println!(
                            "flowcone: TCX tail verified on {} (ifindex {})",
                            config.iface, applied.ifindex
                        );
                    }
                }
                Err(e) => {
                    eprintln!(
                        "flowcone: TCX tail rotation failed: {}; old links retained",
                        e
                    );
                }
            }
        }

        if config.manage_nft
            && applied.liveness
            && (applied.v4_enabled || applied.effective_v6 != 0)
            && last_liveness_refresh.elapsed() >= LIVENESS_REFRESH_INTERVAL
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
                retry_deadline = Some(Instant::now() + RETRY_INTERVAL);
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

    #[test]
    fn test_ebpf_bytes_elf_and_alignment() {
        assert!(EBPF_BYTES.len() > 64);
        assert_eq!(&EBPF_BYTES[0..4], b"\x7fELF");
        assert_eq!((EBPF_BYTES.as_ptr() as usize) % 4, 0);
    }
}
