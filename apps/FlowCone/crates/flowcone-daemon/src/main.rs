mod btf;
mod config;
mod data_plane;
mod firewall;
mod netlink;
mod session;

use aya::maps::{Array, HashMap, MapData, Queue};
use aya::{EbpfLoader, VerifierLogLevel};
use data_plane::DataPlane;
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, FragKey4, FragKey6, FragValue4,
    FragValue6, GlobalConfig, SessionEvent4, SessionEvent6,
};
use session::{SessionManager, SessionMaps};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Safety net for link loss the ifindex cannot reveal (index reuse, ...).
const REATTACH_INTERVAL: Duration = Duration::from_secs(30);

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
/// A poisoned control-plane lock means a thread panicked while holding
/// shared state. Fail fast instead of silently skipping config/GC forever.
fn lock_or_exit<'a, T>(mutex: &'a Mutex<T>, what: &str) -> std::sync::MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(_) => {
            eprintln!("flowcone: {what} mutex poisoned; exiting");
            std::process::exit(1);
        }
    }
}

struct ShutdownNotifier {
    running: Mutex<bool>,
    condvar: Condvar,
}

impl ShutdownNotifier {
    fn new() -> Self {
        Self {
            running: Mutex::new(true),
            condvar: Condvar::new(),
        }
    }

    fn wait_timeout(&self, timeout: Duration) -> bool {
        let guard = self.running.lock().unwrap();
        if !*guard {
            return false;
        }
        let (guard, _) = self.condvar.wait_timeout(guard, timeout).unwrap();
        *guard
    }

    fn notify_shutdown(&self) {
        let mut guard = self.running.lock().unwrap();
        *guard = false;
        self.condvar.notify_all();
    }
}

/// Install the signal handlers. They own their pipe ends, so a handler only
/// touches an atomic and write(2); both are async-signal-safe.
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

/// What the data plane and the firewall were last configured with.
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
    if env!("FLOWCONE_EBPF_STALE") == "1" {
        eprintln!(
            "flowcone: embedded eBPF object is older than crates/flowcone-ebpf/src/main.rs or flowcone-common; rebuild it and copy to crates/flowcone-daemon/ebpf/flowcone-ebpf.bin, or set FLOWCONE_EBPF_PATH"
        );
    }

    // Self-pipe for async-signal-safe shutdown notification
    let (sig_read_end, sig_write_end) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;

    // Second self-pipe: wakes the address/watch thread on SIGHUP and shutdown.
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
    let notifier = Arc::new(ShutdownNotifier::new());

    let iface_path = format!("/sys/class/net/{}", config.iface);
    if !Path::new(&iface_path).exists() {
        println!(
            "flowcone: waiting for interface {} to be ready...",
            config.iface
        );
        while RUNNING.load(Ordering::Relaxed) {
            if Path::new(&iface_path).exists() {
                println!("flowcone: interface {} is now ready", config.iface);
                break;
            }
            if !notifier.wait_timeout(Duration::from_millis(500)) {
                break;
            }
        }
    }
    if !RUNNING.load(Ordering::Relaxed) {
        return Ok(());
    }

    let btf = btf::find_btf(config.btf_path.as_deref());

    // Without the verifier log first: it does not fit aya's buffer (E2BIG).
    // On failure retry with the log so the verifier reason is reported.
    // FLOWCONE_VERIFIER_LOG=1 selects the DEBUG log for per-program loads,
    // which is the only way to diagnose a late load_classifier() failure.
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

    let session_mgr = Arc::new(Mutex::new(SessionManager::new(SessionMaps {
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
        events4: take_map!(bpf, "SESSION_EVENTS_V4", Queue<MapData, SessionEvent4>),
        events6: take_map!(bpf, "SESSION_EVENTS_V6", Queue<MapData, SessionEvent6>),
        gc_flags: take_map!(bpf, "GC_FLAGS", Array<MapData, u32>),
        free_state4: take_map!(bpf, "PORT_FREE_V4", Array<MapData, u8>),
        free_state6: take_map!(bpf, "PORT_FREE_V6", Array<MapData, u8>),
        reserved4: take_map!(bpf, "RESERVED_V4", Array<MapData, u8>),
        reserved6: take_map!(bpf, "RESERVED_V6", Array<MapData, u8>),
        free_even4: take_map!(bpf, "FREE_EVEN_V4", Queue<MapData, u16>),
        free_odd4: take_map!(bpf, "FREE_ODD_V4", Queue<MapData, u16>),
        free_even6: take_map!(bpf, "FREE_EVEN_V6", Queue<MapData, u16>),
        free_odd6: take_map!(bpf, "FREE_ODD_V6", Queue<MapData, u16>),
        port_flags: take_map!(bpf, "PORT_FLAGS", Array<MapData, u32>),
    })));
    {
        let mut mgr = lock_or_exit(&session_mgr, "session");
        mgr.configure_port_pool(config.min_port, config.max_port);
        mgr.init_port_pool(config.enable_v4, config.enable_v6);
        mgr.reserve_local_ports();
    }

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

    let data_plane = Arc::new(Mutex::new(DataPlane::start(bpf, &config.iface)?));
    let start_ifindex = netlink::get_ifindex(&config.iface).unwrap_or(0);

    let ip_session = Arc::clone(&session_mgr);
    let ip_dp = Arc::clone(&data_plane);
    let ip_cfg = config.clone();
    let ip_notifier = Arc::clone(&notifier);
    let ip_thread = thread::spawn(move || {
        let mut last_reserve_scan = Instant::now();
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
        let mut attach_timer = Instant::now();

        loop {
            let mut config_dirty = false;
            let mut reattach = false;
            let mut force_new_attach = false;
            let mut notable = false;
            let mut resolved_ip4 = applied.ip4;
            let mut resolved_ip6 = applied.ip6;

            match netlink::get_iface_l2_len(&ip_cfg.iface) {
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
                            ip_cfg.iface
                        );
                        l2_warned = true;
                    }
                }
            }

            // A re-created interface (PPPoE/WireGuard reconnect) lost its
            // links; the periodic check below covers what the ifindex cannot.
            let cur_ifindex = netlink::get_ifindex(&ip_cfg.iface).unwrap_or(0);
            let present = cur_ifindex != 0;
            if present && (!applied.present || cur_ifindex != applied.ifindex) {
                println!(
                    "flowcone: interface {} re-created (ifindex {} -> {}), re-attaching",
                    ip_cfg.iface, applied.ifindex, cur_ifindex
                );
                reattach = true;
                force_new_attach = true;
                notable = true;
                config_dirty = true;
                attach_timer = Instant::now();
            } else if present && attach_timer.elapsed() >= REATTACH_INTERVAL {
                attach_timer = Instant::now();
                reattach = true;
            }
            applied.present = present;

            // Explicit resync request (SIGHUP from the init script).
            let resync = RESYNC_REQUESTED.swap(false, Ordering::Relaxed);
            if resync {
                config_dirty = true;
            }

            // A failed query is transient, not "the interface lost its address".
            let iface_addrs = netlink::get_iface_addrs(cur_ifindex);

            if ip_cfg.enable_v4 {
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
                        if ip_cfg.verbose {
                            eprintln!(
                                "flowcone: warning: transient netlink address query error: {:?}",
                                e
                            );
                        }
                    }
                }
            }

            if ip_cfg.enable_v6 {
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
                        if ip_cfg.verbose {
                            eprintln!(
                                "flowcone: warning: transient netlink address query error: {:?}",
                                e
                            );
                        }
                    }
                }
            }

            if config_dirty {
                // Read the masquerade state once; the data plane and the
                // firewall rules must make the same decision.
                let is_v6_masq = firewall::is_ipv6_masq_enabled();
                let effective_v6 = if applied.l2_known {
                    resolve_effective_v6(ip_cfg.enable_v6, resolved_ip6, is_v6_masq)
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

                let active_v4 = ip_cfg.enable_v4 && resolved_ip4 != 0 && applied.l2_known;
                let shrinking =
                    (applied.v4_enabled && !active_v4) || (applied.effective_v6 > effective_v6);
                let mut stage_ok = true;
                let mut rules_staged = false;
                let fw_cfg = firewall::FirewallConfig {
                    iface: &ip_cfg.iface,
                    enable_v4: active_v4,
                    enable_v6: effective_v6 != 0,
                    is_v6_masq,
                    mark: ip_cfg.flowcone_mark,
                    bypass_mask: ip_cfg.bypass_mark_mask,
                    bypass_val: ip_cfg.bypass_mark_val,
                    verbose: ip_cfg.verbose,
                };

                // On a shrink, stage the stricter rules before disabling the
                // data plane. On grow or SIGHUP, sync once after publishing.
                if ip_cfg.manage_nft && shrinking {
                    stage_ok = firewall::sync_fw4_rules(&fw_cfg);
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
                        bypass_mark_mask: ip_cfg.bypass_mark_mask,
                        bypass_mark_val: ip_cfg.bypass_mark_val,
                        l2_len: applied.l2_len,
                        wan_ip6: resolved_ip6,
                        min_port4: ip_cfg.min_port,
                        max_port4: ip_cfg.max_port,
                        min_port6: ip_cfg.min_port,
                        max_port6: ip_cfg.max_port,
                        enabled_v4: if active_v4 { 1 } else { 0 },
                        enabled_v6: effective_v6,
                        flowcone_mark: ip_cfg.flowcone_mark,
                        frag_epoch,
                    };
                    let had_flush = flush_v4 || flush_v6;
                    let set_ok = if had_flush {
                        let ok = lock_or_exit(&ip_session, "session").set_config(g_cfg);
                        if ok {
                            if flush_v4 {
                                lock_or_exit(&ip_session, "session").clear_v4_mappings();
                            }
                            if flush_v6 {
                                lock_or_exit(&ip_session, "session").clear_v6_mappings();
                            }
                            flush_v4 = false;
                            flush_v6 = false;
                        } else {
                            eprintln!("flowcone: could not publish pre-clear config");
                            RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                        }
                        ok
                    } else {
                        lock_or_exit(&ip_session, "session").set_config(g_cfg)
                    };
                    if !set_ok {
                        eprintln!("flowcone: could not publish data-plane config");
                        RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                    } else if ip_cfg.manage_nft {
                        let sync_ok = rules_staged || firewall::sync_fw4_rules(&fw_cfg);
                        if sync_ok {
                            applied.v4_enabled = active_v4;
                            applied.effective_v6 = effective_v6;
                            applied.v6_masq = is_v6_masq;
                            applied.liveness = firewall::liveness_supported();
                            firewall::refresh_liveness(
                                active_v4,
                                effective_v6 != 0,
                                is_v6_masq,
                                ip_cfg.verbose,
                            );
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
                let mut attached = false;
                {
                    let mut dp = lock_or_exit(&ip_dp, "data-plane");
                    let result = if force_new_attach {
                        dp.attach(true, false)
                    } else {
                        dp.ensure_last(ip_cfg.verbose).map(|_| ())
                    };
                    match result {
                        Ok(()) => attached = true,
                        Err(e) => {
                            if force_new_attach {
                                eprintln!(
                                    "flowcone: re-attach on {} failed: {}; fail-closed (remove nft exemption)",
                                    ip_cfg.iface, e
                                );
                                if ip_cfg.manage_nft {
                                    firewall::remove_rules(ip_cfg.verbose);
                                }
                                std::process::exit(1);
                            } else {
                                // A/B rotation attaches the new pair first.
                                // On failure the old pair is still active, so
                                // this is a safe no-op until the next check.
                                eprintln!(
                                    "flowcone: TCX tail rotation failed: {}; old links retained",
                                    e
                                );
                            }
                        }
                    }
                }
                if attached {
                    applied.ifindex = cur_ifindex;
                    if notable {
                        println!(
                            "flowcone: TCX programs re-attached to {} (ifindex {})",
                            ip_cfg.iface, cur_ifindex
                        );
                    } else if ip_cfg.verbose {
                        println!(
                            "flowcone: TCX tail verified on {} (ifindex {})",
                            ip_cfg.iface, cur_ifindex
                        );
                    }
                }
            }

            if last_reserve_scan.elapsed() >= Duration::from_secs(30) {
                lock_or_exit(&ip_session, "session").reserve_local_ports();
                last_reserve_scan = Instant::now();
            }

            if ip_cfg.manage_nft
                && applied.liveness
                && !firewall::refresh_liveness(
                    applied.v4_enabled,
                    applied.effective_v6 != 0,
                    applied.v6_masq,
                    ip_cfg.verbose,
                )
            {
                // The sets can disappear on an fw4 reload; resync recreates
                // them instead of letting the exemption expire silently.
                if ip_cfg.verbose {
                    eprintln!("flowcone: liveness refresh failed; scheduling resync");
                }
                RESYNC_REQUESTED.store(true, Ordering::Relaxed);
            }

            let has_wan_addr = resolved_ip4 != 0 || resolved_ip6 != [0u8; 16];
            let sleep_dur = if ip_cfg.manage_nft && applied.liveness {
                Duration::from_secs(5)
            } else {
                Duration::from_secs(if has_wan_addr { 5 } else { 1 })
            };
            match monitor {
                Some(ref monitor) => {
                    monitor.wait(wake_read_end.as_fd(), sleep_dur);
                    // Drain the wake pipe (non blocking).
                    let mut buf = [0u8; 32];
                    while let Ok(n) = rustix::io::read(&wake_read_end, &mut buf) {
                        if n == 0 {
                            break;
                        }
                    }
                }
                None => {
                    if !ip_notifier.wait_timeout(sleep_dur) {
                        break;
                    }
                }
            }
            if !RUNNING.load(Ordering::Relaxed) {
                break;
            }
        }
    });

    let gc_session = Arc::clone(&session_mgr);
    let timeout = config.timeout_sec as u32;
    let verbose = config.verbose;
    let gc_notifier = Arc::clone(&notifier);
    let gc_interval = Duration::from_secs(config.gc_interval_sec.max(1));

    let gc_thread = thread::spawn(move || {
        while gc_notifier.wait_timeout(gc_interval) {
            let now = (get_monotonic_coarse_ns() / 1_000_000_000) as u32;
            {
                let mut mgr = lock_or_exit(&gc_session, "session");
                let (v4_swept, v6_swept) = mgr.gc_tick(now, timeout);
                if verbose && (v4_swept > 0 || v6_swept > 0) {
                    println!(
                        "flowcone: swept {} v4 and {} v6 expired sessions",
                        v4_swept, v6_swept
                    );
                }
            }
        }
    });

    let mut sig_buf = [0u8; 1];
    while RUNNING.load(Ordering::SeqCst) {
        match rustix::io::read(&sig_read_end, &mut sig_buf) {
            Ok(_) => break,
            Err(rustix::io::Errno::INTR) => {
                if !RUNNING.load(Ordering::SeqCst) {
                    break;
                }
            }
            Err(_) => break,
        }
    }

    println!("flowcone: stopping");
    notifier.notify_shutdown();

    if config.manage_nft {
        firewall::remove_rules(config.verbose);
    }

    lock_or_exit(&session_mgr, "session").disable_fail_open();

    let _ = ip_thread.join();
    let _ = gc_thread.join();

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

        // Disabled by config (false)
        assert_eq!(resolve_effective_v6(false, dummy_ip, false), 0);
        assert_eq!(resolve_effective_v6(false, dummy_ip, true), 0);

        // Enabled (true), but no WAN IPv6 address available
        assert_eq!(resolve_effective_v6(true, zero_ip, false), 0);
        assert_eq!(resolve_effective_v6(true, zero_ip, true), 0);

        // Enabled (true), Auto-adaptive mode:
        // Without masquerade in nftables -> Mode 1 (ULA NAT66 + Native GUA direct wire-speed)
        assert_eq!(resolve_effective_v6(true, dummy_ip, false), 1);
        // With masquerade in nftables -> Mode 2 (Full NAT66)
        assert_eq!(resolve_effective_v6(true, dummy_ip, true), 2);
    }
}
