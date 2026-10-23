mod btf;
mod config;
mod firewall;
mod netlink;
mod session;

use aya::EbpfLoader;
use aya::maps::{Array, HashMap};
use aya::programs::links::LinkOrder;
use aya::programs::tc::{SchedClassifier, TcAttachOptions, TcAttachType, qdisc_add_clsact};
use flowcone_common::GlobalConfig;
use session::SessionManager;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::AsRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

static EBPF_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/flowcone-ebpf.bin"));
static RUNNING: AtomicBool = AtomicBool::new(true);
static SIGNAL_WRITE_FD: AtomicI32 = AtomicI32::new(-1);

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

fn signal_handler() {
    RUNNING.store(false, Ordering::SeqCst);
    let fd = SIGNAL_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let byte = [1u8];
        unsafe {
            let _ = rustix::io::write(std::os::fd::BorrowedFd::borrow_raw(fd), &byte);
        }
    }
}

fn setup_signals() {
    // SIGINT = 2, SIGTERM = 15
    let _ = unsafe { signal_hook_registry::register(2, signal_handler) };
    let _ = unsafe { signal_hook_registry::register(15, signal_handler) };
}

fn get_monotonic_coarse_ns() -> u64 {
    let ts = rustix::time::clock_gettime(rustix::time::ClockId::MonotonicCoarse);
    (ts.tv_sec as u64) * 1_000_000_000 + (ts.tv_nsec as u64)
}

fn attach_tc_classifier(
    bpf: &mut aya::Ebpf,
    prog_name: &str,
    iface: &str,
    attach_type: TcAttachType,
) -> Result<(), Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    prog.load()?;

    let type_name = match attach_type {
        TcAttachType::Ingress => "ingress",
        TcAttachType::Egress => "egress",
        _ => "custom",
    };

    match prog.attach_with_options(
        iface,
        attach_type,
        TcAttachOptions::TcxOrder(LinkOrder::last()),
    ) {
        Ok(_) => {
            println!("flowcone: {} attached via TCX (last)", type_name);
        }
        Err(e) => {
            eprintln!("flowcone: TCX {} fallback to netlink: {:?}", type_name, e);
            prog.attach(iface, attach_type)?;
        }
    }
    Ok(())
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

    // Self-pipe for async-signal-safe shutdown notification
    let (sig_read_end, sig_write_end) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)?;
    SIGNAL_WRITE_FD.store(sig_write_end.as_raw_fd(), Ordering::SeqCst);
    setup_signals();
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
    let mut loader = EbpfLoader::new();
    if let Some(ref b) = btf {
        loader.btf(Some(b));
    }
    let mut bpf = loader.load(EBPF_BYTES)?;

    let session_mgr = Arc::new(Mutex::new(SessionManager::new(
        Array::try_from(bpf.take_map("CONFIG").ok_or("map CONFIG not found")?)?,
        HashMap::try_from(
            bpf.take_map("OUTBOUND_BINDINGS_V4")
                .ok_or("map OUTBOUND_BINDINGS_V4 not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("INBOUND_BINDINGS_V4")
                .ok_or("map INBOUND_BINDINGS_V4 not found")?,
        )?,
        Array::try_from(
            bpf.take_map("PORT_BITMAP_V4")
                .ok_or("map PORT_BITMAP_V4 not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("OUTBOUND_BINDINGS_V6")
                .ok_or("map OUTBOUND_BINDINGS_V6 not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("INBOUND_BINDINGS_V6")
                .ok_or("map INBOUND_BINDINGS_V6 not found")?,
        )?,
        Array::try_from(
            bpf.take_map("PORT_BITMAP_V6")
                .ok_or("map PORT_BITMAP_V6 not found")?,
        )?,
    )));

    let l2_len = netlink::get_iface_l2_len(&config.iface);
    if config.verbose {
        println!(
            "flowcone: detected L2 header length: {} bytes for interface {}",
            l2_len, config.iface
        );
    }

    let _ = qdisc_add_clsact(&config.iface);
    attach_tc_classifier(
        &mut bpf,
        "flowcone_tcx_ingress",
        &config.iface,
        TcAttachType::Ingress,
    )?;
    attach_tc_classifier(
        &mut bpf,
        "flowcone_tcx_egress",
        &config.iface,
        TcAttachType::Egress,
    )?;

    let ip_session = Arc::clone(&session_mgr);
    let ip_cfg = config.clone();
    let ip_notifier = Arc::clone(&notifier);
    let ip_thread = thread::spawn(move || {
        let mut last_ip4: u32 = 0;
        let mut last_ip6 = [0u8; 16];
        let mut last_effective_v6: u32 = 0;
        let mut applied_v4 = false;
        let mut applied_v6 = false;

        loop {
            let mut config_dirty = false;
            let mut resolved_ip4 = last_ip4;
            let mut resolved_ip6 = last_ip6;

            if ip_cfg.enable_v4 {
                match netlink::get_iface_ipv4(&ip_cfg.iface) {
                    Ok(Some(ip4_bytes)) => {
                        let ip4 = u32::from_ne_bytes(ip4_bytes);
                        if ip4 != last_ip4 {
                            println!(
                                "flowcone: WAN IPv4 updated to {}",
                                Ipv4Addr::from(ip4_bytes)
                            );
                            if last_ip4 != 0 {
                                println!("flowcone: flushing stale v4 mappings");
                                if let Ok(mut mgr) = ip_session.lock() {
                                    mgr.clear_v4_mappings();
                                }
                            }
                            last_ip4 = ip4;
                            resolved_ip4 = ip4;
                            config_dirty = true;
                        }
                    }
                    Ok(None) => {
                        if last_ip4 != 0 {
                            println!("flowcone: WAN interface lost IPv4");
                            last_ip4 = 0;
                            resolved_ip4 = 0;
                            config_dirty = true;
                        }
                    }
                    Err(e) => {
                        if ip_cfg.verbose {
                            eprintln!("flowcone: warning: transient netlink IPv4 query error: {:?}", e);
                        }
                    }
                }
            }

            if ip_cfg.enable_v6 {
                match netlink::get_iface_ipv6(&ip_cfg.iface) {
                    Ok(Some(ip6)) => {
                        if ip6 != last_ip6 {
                            println!("flowcone: WAN IPv6 updated to {}", Ipv6Addr::from(ip6));
                            if last_ip6 != [0u8; 16] {
                                println!("flowcone: flushing stale v6 mappings");
                                if let Ok(mut mgr) = ip_session.lock() {
                                    mgr.clear_v6_mappings();
                                }
                            }
                            last_ip6 = ip6;
                            resolved_ip6 = ip6;
                            config_dirty = true;
                        }
                    }
                    Ok(None) => {
                        if last_ip6 != [0u8; 16] {
                            println!("flowcone: WAN interface lost IPv6");
                            last_ip6 = [0u8; 16];
                            resolved_ip6 = [0u8; 16];
                            config_dirty = true;
                        }
                    }
                    Err(e) => {
                        if ip_cfg.verbose {
                            eprintln!("flowcone: warning: transient IPv6 query error: {:?}", e);
                        }
                    }
                }
            }

            if config_dirty {
                let effective_v6 = resolve_effective_v6(
                    ip_cfg.enable_v6,
                    resolved_ip6,
                    firewall::is_ipv6_masq_enabled(),
                );

                if effective_v6 != last_effective_v6 {
                    let desc = match effective_v6 {
                        0 => "disabled (no WAN IPv6 address)",
                        1 => "auto-adaptive (ULA NAT66 + Native GUA wire-speed routing)",
                        2 => "full NAT66 (masquerade detected in nftables fw4)",
                        _ => "custom",
                    };
                    println!("flowcone: IPv6 operational mode: {}", desc);
                    last_effective_v6 = effective_v6;
                }

                if let Ok(mut mgr) = ip_session.lock() {
                    let g_cfg = GlobalConfig {
                        wan_ip4: resolved_ip4,
                        bypass_mark_mask: ip_cfg.bypass_mark_mask,
                        bypass_mark_val: ip_cfg.bypass_mark_val,
                        l2_len,
                        wan_ip6: resolved_ip6,
                        min_port4: ip_cfg.min_port,
                        max_port4: ip_cfg.max_port,
                        min_port6: ip_cfg.min_port,
                        max_port6: ip_cfg.max_port,
                        enabled_v4: if ip_cfg.enable_v4 && resolved_ip4 != 0 {
                            1
                        } else {
                            0
                        },
                        enabled_v6: effective_v6,
                    };
                    mgr.set_config(g_cfg);
                }

                if ip_cfg.manage_nft {
                    let active_v4 = ip_cfg.enable_v4 && resolved_ip4 != 0;
                    let active_v6 = effective_v6 != 0;
                    if active_v4 != applied_v4 || active_v6 != applied_v6 {
                        firewall::sync_fw4_rules(
                            &ip_cfg.iface,
                            ip_cfg.min_port,
                            ip_cfg.max_port,
                            active_v4,
                            active_v6,
                            ip_cfg.verbose,
                        );
                        applied_v4 = active_v4;
                        applied_v6 = active_v6;
                    }
                }
            }

            let sleep_dur = Duration::from_secs(if resolved_ip4 != 0 { 5 } else { 1 });
            if !ip_notifier.wait_timeout(sleep_dur) {
                break;
            }
        }
    });

    let gc_session = Arc::clone(&session_mgr);
    let timeout_ns = config.timeout_sec * 1_000_000_000;
    let verbose = config.verbose;
    let gc_notifier = Arc::clone(&notifier);
    let gc_interval = Duration::from_secs(config.gc_interval_sec.max(1));

    let gc_thread = thread::spawn(move || {
        while gc_notifier.wait_timeout(gc_interval) {
            let now = get_monotonic_coarse_ns();
            if let Ok(mut mgr) = gc_session.lock() {
                let (v4_swept, v6_swept) = mgr.sweep_expired(now, timeout_ns);
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
    SIGNAL_WRITE_FD.store(-1, Ordering::SeqCst);
    notifier.notify_shutdown();

    if config.manage_nft {
        firewall::remove_rules(config.verbose);
    }

    if let Ok(mut mgr) = session_mgr.lock() {
        mgr.disable_fail_open();
    }

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
