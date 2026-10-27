mod btf;
mod config;
mod firewall;
mod netlink;
mod session;

use aya::maps::{Array, HashMap, MapData, ProgramArray, Queue};
use aya::programs::links::LinkOrder;
use aya::programs::tc::{
    SchedClassifier, SchedClassifierLinkId, TcAttachOptions, TcAttachType, qdisc_add_clsact,
};
use aya::{EbpfLoader, VerifierLogLevel};
use flowcone_common::GlobalConfig;
use session::SessionManager;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Safety net for link loss the ifindex cannot reveal (index reuse, ...).
const REATTACH_INTERVAL: Duration = Duration::from_secs(30);

static EBPF_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/flowcone-ebpf.bin"));
static RUNNING: AtomicBool = AtomicBool::new(true);
static RESYNC_REQUESTED: AtomicBool = AtomicBool::new(false);
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

fn load_classifier(bpf: &mut aya::Ebpf, prog_name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    prog.load()?;
    Ok(())
}

fn attach_classifier(
    bpf: &mut aya::Ebpf,
    prog_name: &str,
    iface: &str,
    attach_type: TcAttachType,
    previous: &mut Option<SchedClassifierLinkId>,
    force_new: bool,
    log_success: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;

    let type_name = match attach_type {
        TcAttachType::Ingress => "ingress",
        TcAttachType::Egress => "egress",
        _ => "custom",
    };

    // bpf_link_update() is a no-op for a live link and fails with -ENOLINK once
    // the net_device is gone, so the old link is taken either way and only
    // updated while force_new is off (then the interface instance did not change).
    let old_link = previous
        .take()
        .and_then(|link_id| prog.take_link(link_id).ok());
    if let Some(link) = old_link
        && !force_new
        && let Ok(new_id) = prog.attach_to_link(link)
    {
        *previous = Some(new_id);
        return Ok(());
    }

    let link_id = match prog.attach_with_options(
        iface,
        attach_type,
        TcAttachOptions::TcxOrder(LinkOrder::last()),
    ) {
        Ok(id) => {
            if log_success {
                println!("flowcone: {} attached via TCX (last)", type_name);
            }
            id
        }
        Err(e) => {
            eprintln!("flowcone: TCX {} fallback to netlink: {:?}", type_name, e);
            prog.attach(iface, attach_type)?
        }
    };

    *previous = Some(link_id);
    Ok(())
}

fn loaded_program_id(bpf: &aya::Ebpf, prog_name: &str) -> Result<u32, Box<dyn std::error::Error>> {
    let prog: &SchedClassifier = bpf
        .program(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    Ok(prog.info()?.id())
}

fn attach_new_classifier(
    bpf: &mut aya::Ebpf,
    prog_name: &str,
    iface: &str,
    attach_type: TcAttachType,
) -> Result<SchedClassifierLinkId, Box<dyn std::error::Error>> {
    let prog: &mut SchedClassifier = bpf
        .program_mut(prog_name)
        .ok_or_else(|| format!("program {} not found", prog_name))?
        .try_into()?;
    let id = match prog.attach_with_options(
        iface,
        attach_type,
        TcAttachOptions::TcxOrder(LinkOrder::last()),
    ) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("flowcone: TCX dispatcher attach fallback: {:?}", e);
            prog.attach(iface, attach_type)?
        }
    };
    Ok(id)
}

fn detach_classifier(bpf: &mut aya::Ebpf, prog_name: &str, id: SchedClassifierLinkId) {
    if let Some(prog) = bpf.program_mut(prog_name)
        && let Ok(prog) = TryInto::<&mut SchedClassifier>::try_into(prog)
    {
        let _ = prog.take_link(id);
    }
}

fn tcx_is_tail(
    iface: &str,
    attach_type: TcAttachType,
    prog_id: u32,
) -> Result<bool, Box<dyn std::error::Error>> {
    let (_, programs) = SchedClassifier::query_tcx(iface, attach_type)?;
    Ok(programs.last().map(|p| p.id() == prog_id).unwrap_or(false))
}

/// Loaded eBPF object plus the currently attached link ids.
///
/// The attached links are tiny A/B tail-call dispatchers. The real ingress/
/// egress implementation is loaded once and referenced by two ProgramArray
/// maps; both dispatchers call the same idempotent program, so a tail move can
/// attach B, switch, and remove A without a WAN gap or double NAT.
struct DataPlane {
    bpf: aya::Ebpf,
    iface: String,
    ingress: Option<SchedClassifierLinkId>,
    egress: Option<SchedClassifierLinkId>,
    ingress_ids: [u32; 2],
    egress_ids: [u32; 2],
    active: usize,
    tail_guard: bool,
    _ingress_target: ProgramArray<MapData>,
    _egress_target: ProgramArray<MapData>,
    _frag_target: ProgramArray<MapData>,
    _icmp_target: ProgramArray<MapData>,
    _icmp6_target: ProgramArray<MapData>,
}

fn load_target_map(
    bpf: &mut aya::Ebpf,
    map_name: &str,
    prog_name: &str,
) -> Result<ProgramArray<MapData>, Box<dyn std::error::Error>> {
    let mut map = ProgramArray::try_from(
        bpf.take_map(map_name)
            .ok_or_else(|| format!("map {map_name} not found"))?,
    )?;
    let prog: &SchedClassifier = bpf
        .program(prog_name)
        .ok_or_else(|| format!("program {prog_name} not found"))?
        .try_into()?;
    let fd = prog
        .fd()
        .map_err(|e| -> Box<dyn std::error::Error> { format!("{prog_name} fd: {e}").into() })?;
    map.set(0, fd, 0)
        .map_err(|e| -> Box<dyn std::error::Error> {
            format!("{prog_name} map set: {e}").into()
        })?;
    Ok(map)
}

impl DataPlane {
    fn disp_names(&self) -> (&'static str, &'static str) {
        if self.active == 0 {
            ("flowcone_tcx_ingress_a", "flowcone_tcx_egress_a")
        } else {
            ("flowcone_tcx_ingress_b", "flowcone_tcx_egress_b")
        }
    }

    fn start(bpf: aya::Ebpf, iface: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let mut bpf = bpf;
        // Load the real programs once; they are tail-call targets, not links.
        load_classifier(&mut bpf, "flowcone_tcx_ingress").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_tcx_ingress: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_tcx_egress").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_tcx_egress: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_frag_target").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_frag_target: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_icmp_target").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_icmp_target: {e}").into()
            },
        )?;
        load_classifier(&mut bpf, "flowcone_icmp6_target").map_err(
            |e| -> Box<dyn std::error::Error> {
                format!("load target flowcone_icmp6_target: {e}").into()
            },
        )?;

        for name in [
            "flowcone_tcx_ingress_a",
            "flowcone_tcx_ingress_b",
            "flowcone_tcx_egress_a",
            "flowcone_tcx_egress_b",
        ] {
            load_classifier(&mut bpf, name).map_err(|e| -> Box<dyn std::error::Error> {
                format!("load dispatcher {name}: {e}").into()
            })?;
        }
        let ingress_target = load_target_map(&mut bpf, "INGRESS_TARGET", "flowcone_tcx_ingress")?;
        let egress_target = load_target_map(&mut bpf, "EGRESS_TARGET", "flowcone_tcx_egress")?;
        let frag_target = load_target_map(&mut bpf, "FRAG_TARGET", "flowcone_frag_target")?;
        let icmp_target = load_target_map(&mut bpf, "ICMP_TARGET", "flowcone_icmp_target")?;
        let icmp6_target = load_target_map(&mut bpf, "ICMP6_TARGET", "flowcone_icmp6_target")?;
        let mut data_plane = Self {
            bpf,
            iface: iface.to_string(),
            ingress: None,
            egress: None,
            ingress_ids: [0; 2],
            egress_ids: [0; 2],
            active: 0,
            tail_guard: false,
            _ingress_target: ingress_target,
            _egress_target: egress_target,
            _frag_target: frag_target,
            _icmp_target: icmp_target,
            _icmp6_target: icmp6_target,
        };
        data_plane.ingress_ids[0] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_ingress_a")?;
        data_plane.ingress_ids[1] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_ingress_b")?;
        data_plane.egress_ids[0] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_egress_a")?;
        data_plane.egress_ids[1] = loaded_program_id(&data_plane.bpf, "flowcone_tcx_egress_b")?;
        data_plane.attach(true, true)?;
        data_plane.tail_guard = true;
        Ok(data_plane)
    }

    /// (Re-)attach the active dispatcher pair without loading them again.
    fn attach(
        &mut self,
        force_new: bool,
        log_success: bool,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let iface = self.iface.clone();
        let _ = qdisc_add_clsact(&iface);
        let (in_name, out_name) = self.disp_names();
        attach_classifier(
            &mut self.bpf,
            in_name,
            &iface,
            TcAttachType::Ingress,
            &mut self.ingress,
            force_new,
            log_success,
        )?;
        attach_classifier(
            &mut self.bpf,
            out_name,
            &iface,
            TcAttachType::Egress,
            &mut self.egress,
            force_new,
            log_success,
        )?;
        Ok(())
    }

    /// Attach the inactive dispatcher pair at the tail, then remove the old
    /// pair. Both dispatchers tail-call the same idempotent target, so the
    /// overlap is safe and there is no WAN gap.
    fn rotate(&mut self, verbose: bool) -> Result<(), Box<dyn std::error::Error>> {
        let new = 1 - self.active;
        let (new_in_name, new_out_name) = if new == 0 {
            ("flowcone_tcx_ingress_a", "flowcone_tcx_egress_a")
        } else {
            ("flowcone_tcx_ingress_b", "flowcone_tcx_egress_b")
        };
        let (old_in_name, old_out_name) = self.disp_names();
        let iface = self.iface.clone();
        let _ = qdisc_add_clsact(&iface);

        let new_in =
            attach_new_classifier(&mut self.bpf, new_in_name, &iface, TcAttachType::Ingress)?;
        let new_out = match attach_new_classifier(
            &mut self.bpf,
            new_out_name,
            &iface,
            TcAttachType::Egress,
        ) {
            Ok(id) => id,
            Err(e) => {
                detach_classifier(&mut self.bpf, new_in_name, new_in);
                return Err(e);
            }
        };

        let old_in = self.ingress.replace(new_in);
        let old_out = self.egress.replace(new_out);
        self.active = new;
        if let Some(id) = old_in {
            detach_classifier(&mut self.bpf, old_in_name, id);
        }
        if let Some(id) = old_out {
            detach_classifier(&mut self.bpf, old_out_name, id);
        }
        if verbose {
            println!("flowcone: TCX dispatcher rotated A/B with zero WAN gap");
        }
        Ok(())
    }

    fn ensure_last(&mut self, verbose: bool) -> Result<bool, Box<dyn std::error::Error>> {
        if !self.tail_guard {
            return Ok(false);
        }
        let iface = self.iface.clone();
        let in_id = self.ingress_ids[self.active];
        let out_id = self.egress_ids[self.active];
        let ingress_tail = match tcx_is_tail(&iface, TcAttachType::Ingress, in_id) {
            Ok(v) => v,
            Err(e) => {
                if verbose {
                    eprintln!("flowcone: TCX ingress order query failed: {:?}", e);
                }
                self.tail_guard = false;
                return Ok(false);
            }
        };
        let egress_tail = match tcx_is_tail(&iface, TcAttachType::Egress, out_id) {
            Ok(v) => v,
            Err(e) => {
                if verbose {
                    eprintln!("flowcone: TCX egress order query failed: {:?}", e);
                }
                self.tail_guard = false;
                return Ok(false);
            }
        };
        if ingress_tail && egress_tail {
            return Ok(false);
        }
        if verbose {
            println!(
                "flowcone: TCX dispatcher no longer last (ingress_last={}, egress_last={}), rotating A/B",
                ingress_tail, egress_tail
            );
        }
        self.rotate(verbose)?;
        Ok(true)
    }
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
    let mut bpf = {
        let mut loader = EbpfLoader::new();
        if let Some(ref b) = btf {
            loader.btf(Some(b));
        }
        loader.verifier_log_level(VerifierLogLevel::DISABLE);
        match loader.load(EBPF_BYTES) {
            Ok(bpf) => bpf,
            Err(first) => {
                eprintln!(
                    "flowcone: eBPF load without verifier log failed ({}), retrying with log",
                    first
                );
                let mut loader = EbpfLoader::new();
                if let Some(ref b) = btf {
                    loader.btf(Some(b));
                }
                loader.verifier_log_level(VerifierLogLevel::VERBOSE);
                loader.load(EBPF_BYTES)?
            }
        }
    };

    let session_mgr = Arc::new(Mutex::new(SessionManager::new(
        Array::try_from(bpf.take_map("CONFIG").ok_or("map CONFIG not found")?)?,
        Array::try_from(
            bpf.take_map("ACTIVE_CONFIG")
                .ok_or("map ACTIVE_CONFIG not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("OUTBOUND_BINDINGS_V4")
                .ok_or("map OUTBOUND_BINDINGS_V4 not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("INBOUND_BINDINGS_V4")
                .ok_or("map INBOUND_BINDINGS_V4 not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("OUTBOUND_BINDINGS_V6")
                .ok_or("map OUTBOUND_BINDINGS_V6 not found")?,
        )?,
        HashMap::try_from(
            bpf.take_map("INBOUND_BINDINGS_V6")
                .ok_or("map INBOUND_BINDINGS_V6 not found")?,
        )?,
        Queue::try_from(
            bpf.take_map("SESSION_EVENTS_V4")
                .ok_or("map SESSION_EVENTS_V4 not found")?,
        )?,
        Queue::try_from(
            bpf.take_map("SESSION_EVENTS_V6")
                .ok_or("map SESSION_EVENTS_V6 not found")?,
        )?,
        Array::try_from(bpf.take_map("GC_FLAGS").ok_or("map GC_FLAGS not found")?)?,
        Array::try_from(
            bpf.take_map("PORT_FREE_V4")
                .ok_or("map PORT_FREE_V4 not found")?,
        )?,
        Array::try_from(
            bpf.take_map("PORT_FREE_V6")
                .ok_or("map PORT_FREE_V6 not found")?,
        )?,
        Array::try_from(
            bpf.take_map("RESERVED_V4")
                .ok_or("map RESERVED_V4 not found")?,
        )?,
        Array::try_from(
            bpf.take_map("RESERVED_V6")
                .ok_or("map RESERVED_V6 not found")?,
        )?,
        Queue::try_from(
            bpf.take_map("FREE_EVEN_V4")
                .ok_or("map FREE_EVEN_V4 not found")?,
        )?,
        Queue::try_from(
            bpf.take_map("FREE_ODD_V4")
                .ok_or("map FREE_ODD_V4 not found")?,
        )?,
        Queue::try_from(
            bpf.take_map("FREE_EVEN_V6")
                .ok_or("map FREE_EVEN_V6 not found")?,
        )?,
        Queue::try_from(
            bpf.take_map("FREE_ODD_V6")
                .ok_or("map FREE_ODD_V6 not found")?,
        )?,
        Array::try_from(
            bpf.take_map("PORT_FLAGS")
                .ok_or("map PORT_FLAGS not found")?,
        )?,
    )));
    if let Ok(mut mgr) = session_mgr.lock() {
        mgr.configure_port_pool(config.min_port, config.max_port);
        mgr.init_port_pool(config.enable_v4, config.enable_v6);
        mgr.reserve_local_ports();
    }

    let l2_len = netlink::get_iface_l2_len(&config.iface);
    if config.verbose {
        println!(
            "flowcone: detected L2 header length: {} bytes for interface {}",
            l2_len, config.iface
        );
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
            l2_len,
            ip4: 0,
            ip6: [0u8; 16],
            effective_v6: 0,
            v4_enabled: false,
            v6_masq: false,
            liveness: false,
            ifindex: start_ifindex,
            present: start_ifindex != 0,
        };
        let mut attach_timer = Instant::now();

        loop {
            let mut config_dirty = false;
            let mut reattach = false;
            let mut force_new_attach = false;
            let mut notable = false;
            let mut resolved_ip4 = applied.ip4;
            let mut resolved_ip6 = applied.ip6;

            // A re-created interface (PPPoE/WireGuard reconnect) lost its
            // links; the periodic check below covers what the ifindex cannot.
            let cur_ifindex = netlink::get_ifindex(&ip_cfg.iface).unwrap_or(0);
            let present = cur_ifindex != 0;
            if present && (!applied.present || cur_ifindex != applied.ifindex) {
                println!(
                    "flowcone: interface {} re-created (ifindex {} -> {}), re-attaching",
                    ip_cfg.iface, applied.ifindex, cur_ifindex
                );
                applied.l2_len = netlink::get_iface_l2_len(&ip_cfg.iface);
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
                                if let Ok(mut mgr) = ip_session.lock() {
                                    mgr.clear_v4_mappings();
                                }
                            }
                            applied.ip4 = ip4;
                            resolved_ip4 = ip4;
                            config_dirty = true;
                        }
                    }
                    Ok(None) => {
                        if applied.ip4 != 0 {
                            println!("flowcone: WAN interface lost IPv4");
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
                                if let Ok(mut mgr) = ip_session.lock() {
                                    mgr.clear_v6_mappings();
                                }
                            }
                            applied.ip6 = ip6;
                            resolved_ip6 = ip6;
                            config_dirty = true;
                        }
                    }
                    Ok(None) => {
                        if applied.ip6 != [0u8; 16] {
                            println!("flowcone: WAN interface lost IPv6");
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
                let effective_v6 = resolve_effective_v6(ip_cfg.enable_v6, resolved_ip6, is_v6_masq);

                if effective_v6 != applied.effective_v6 {
                    let desc = match effective_v6 {
                        0 => "disabled (no WAN IPv6 address)",
                        1 => "auto-adaptive (ULA NAT66 + Native GUA wire-speed routing)",
                        2 => "full NAT66 (masquerade detected in nftables)",
                        _ => "custom",
                    };
                    println!("flowcone: IPv6 operational mode: {}", desc);
                }

                let active_v4 = ip_cfg.enable_v4 && resolved_ip4 != 0;
                let shrinking =
                    (applied.v4_enabled && !active_v4) || (applied.effective_v6 > effective_v6);
                let mut stage_ok = true;
                let mut rules_staged = false;

                // On a shrink, stage the stricter rules before disabling the
                // data plane. On grow or SIGHUP, sync once after publishing.
                if ip_cfg.manage_nft && shrinking {
                    stage_ok = firewall::sync_fw4_rules(
                        &ip_cfg.iface,
                        ip_cfg.min_port,
                        ip_cfg.max_port,
                        active_v4,
                        effective_v6 != 0,
                        is_v6_masq,
                        ip_cfg.flowcone_mark,
                        ip_cfg.bypass_mark_mask,
                        ip_cfg.bypass_mark_val,
                        ip_cfg.verbose,
                    );
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
                    };
                    let set_ok = ip_session
                        .lock()
                        .map(|mut mgr| mgr.set_config(g_cfg))
                        .unwrap_or(false);
                    if !set_ok {
                        eprintln!("flowcone: could not publish data-plane config");
                        RESYNC_REQUESTED.store(true, Ordering::Relaxed);
                    } else if ip_cfg.manage_nft {
                        let sync_ok = rules_staged
                            || firewall::sync_fw4_rules(
                                &ip_cfg.iface,
                                ip_cfg.min_port,
                                ip_cfg.max_port,
                                active_v4,
                                effective_v6 != 0,
                                is_v6_masq,
                                ip_cfg.flowcone_mark,
                                ip_cfg.bypass_mark_mask,
                                ip_cfg.bypass_mark_val,
                                ip_cfg.verbose,
                            );
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
                if let Ok(mut dp) = ip_dp.lock() {
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
                if let Ok(mut mgr) = ip_session.lock() {
                    mgr.reserve_local_ports();
                }
                last_reserve_scan = Instant::now();
            }

            if ip_cfg.manage_nft && applied.liveness {
                let _ = firewall::refresh_liveness(
                    applied.v4_enabled,
                    applied.effective_v6 != 0,
                    applied.v6_masq,
                    ip_cfg.verbose,
                );
            }

            let sleep_dur = if ip_cfg.manage_nft && applied.liveness {
                Duration::from_secs(5)
            } else {
                Duration::from_secs(if resolved_ip4 != 0 { 5 } else { 1 })
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
    let timeout_ns = config.timeout_sec.saturating_mul(1_000_000_000);
    let verbose = config.verbose;
    let gc_notifier = Arc::clone(&notifier);
    let gc_interval = Duration::from_secs(config.gc_interval_sec.max(1));

    let gc_thread = thread::spawn(move || {
        while gc_notifier.wait_timeout(gc_interval) {
            let now = get_monotonic_coarse_ns();
            if let Ok(mut mgr) = gc_session.lock() {
                let (v4_swept, v6_swept) = mgr.gc_tick(now, timeout_ns);
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
