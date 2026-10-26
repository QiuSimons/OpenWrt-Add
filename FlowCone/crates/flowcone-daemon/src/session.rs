use aya::maps::{Array, HashMap, MapData, MapError, Queue};
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, GlobalConfig, MAX_BINDINGS,
    SessionEvent4, SessionEvent6,
};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

type Expiry4 = Reverse<(u64, EndpointKey4, u16, u8)>;
type Expiry6 = Reverse<(u64, EndpointKey6, u16, u8)>;

const GC_QUEUE_DRAIN_MAX: usize = 8192;
const GC_EXPIRY_STRIKE_NS: u64 = 1_000_000_000;
const GC_EXPIRY_MAX_PER_TICK: usize = 1024;

/// Parse local UDP ports from /proc/net/udp[6]. Only state 07 (unconnected,
/// i.e. a bound/listening service) is reserved; connected client sockets are
/// not.
fn parse_proc_udp_ports(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let mut it = line.split_whitespace();
        let _sl = it.next();
        let Some(local) = it.next() else { continue };
        let Some(_remote) = it.next() else { continue };
        let Some(state) = it.next() else { continue };
        if state != "07" {
            continue;
        }
        let Some((_, port_hex)) = local.rsplit_once(':') else {
            continue;
        };
        if let Ok(port) = u16::from_str_radix(port_hex, 16)
            && port != 0
        {
            out.push(port);
        }
    }
    out
}

pub struct SessionManager {
    config_map: Array<MapData, GlobalConfig>,
    active_map: Array<MapData, u32>,
    ob_map4: HashMap<MapData, EndpointKey4, BindingValue4>,
    ib_map4: HashMap<MapData, u16, BindingValue4>,
    ob_map6: HashMap<MapData, EndpointKey6, BindingValue6>,
    ib_map6: HashMap<MapData, u16, BindingValue6>,
    events4: Queue<MapData, SessionEvent4>,
    events6: Queue<MapData, SessionEvent6>,
    gc_flags: Array<MapData, u32>,
    free_state4: Array<MapData, u8>,
    free_state6: Array<MapData, u8>,
    reserved4: Array<MapData, u8>,
    reserved6: Array<MapData, u8>,
    free_even4: Queue<MapData, u16>,
    free_odd4: Queue<MapData, u16>,
    free_even6: Queue<MapData, u16>,
    free_odd6: Queue<MapData, u16>,
    port_flags: Array<MapData, u32>,
    pool_enable_v4: bool,
    pool_enable_v6: bool,
    min_port: u16,
    max_port: u16,
    freed_ports: Vec<u16>,
    // Expiry scheduler: one heap entry per live session. A due entry is
    // revalidated against last_seen before it is deleted, so a packet that
    // arrives between scheduling and expiry simply reschedules the session.
    heap4: BinaryHeap<Expiry4>,
    heap6: BinaryHeap<Expiry6>,
    // Reused only by the rare full sweep path (lost queue notification).
    expired_v4: Vec<(EndpointKey4, u16)>,
    expired_v6: Vec<(EndpointKey6, u16)>,
    orphan_ports: Vec<u16>,
    lost_notifications: bool,
}

#[inline]
fn clear_family_mappings<K: aya::Pod, V: aya::Pod>(
    ob_map: &mut HashMap<MapData, K, V>,
    ib_map: &mut HashMap<MapData, u16, V>,
) -> Vec<u16> {
    let keys: Vec<K> = ob_map.keys().filter_map(|r| r.ok()).collect();
    for k in keys {
        let _ = ob_map.remove(&k);
    }
    let ports: Vec<u16> = ib_map.keys().filter_map(|r| r.ok()).collect();
    for p in ports.iter() {
        let _ = ib_map.remove(p);
    }
    ports
}

trait ConeBinding: aya::Pod + Copy {
    type Key: aya::Pod + Copy + PartialEq;
    fn port_be(&self) -> u16;
    fn last_seen(&self) -> u64;
    fn make_key(&self) -> Self::Key;
    fn matches_key(&self, key: &Self::Key) -> bool;
}

impl ConeBinding for BindingValue4 {
    type Key = EndpointKey4;
    #[inline(always)]
    fn port_be(&self) -> u16 {
        self.port
    }
    #[inline(always)]
    fn last_seen(&self) -> u64 {
        self.last_seen
    }
    #[inline(always)]
    fn make_key(&self) -> EndpointKey4 {
        EndpointKey4 {
            ip: self.ip,
            port: self.port,
            _pad: 0,
        }
    }

    fn matches_key(&self, key: &EndpointKey4) -> bool {
        self.ip == key.ip && self.port == key.port
    }
}

impl ConeBinding for BindingValue6 {
    type Key = EndpointKey6;
    #[inline(always)]
    fn port_be(&self) -> u16 {
        self.port
    }
    #[inline(always)]
    fn last_seen(&self) -> u64 {
        self.last_seen
    }
    #[inline(always)]
    fn make_key(&self) -> EndpointKey6 {
        EndpointKey6 {
            ip: self.ip,
            port: self.port,
            _pad: [0; 3],
        }
    }

    fn matches_key(&self, key: &EndpointKey6) -> bool {
        self.ip == key.ip && self.port == key.port
    }
}

/// Full-table reconciliation after a lost queue notification.
fn sweep_family<V: ConeBinding>(
    ob_map: &mut HashMap<MapData, V::Key, V>,
    ib_map: &mut HashMap<MapData, u16, V>,
    expired_buf: &mut Vec<(V::Key, u16)>,
    orphan_buf: &mut Vec<u16>,
    freed_ports: &mut Vec<u16>,
    now_ns: u64,
    timeout_ns: u64,
) -> usize {
    expired_buf.clear();
    for (key, val) in ob_map.iter().flatten() {
        if now_ns.saturating_sub(val.last_seen()) <= timeout_ns {
            continue;
        }
        let port_host = u16::from_be(val.port_be());
        let ib_last = match ib_map.get(&port_host, 0) {
            Ok(iv) if iv.matches_key(&key) => iv.last_seen(),
            _ => 0,
        };
        if now_ns.saturating_sub(ib_last) > timeout_ns {
            expired_buf.push((key, port_host));
        }
    }

    let mut swept = 0;
    for &(key, port_host) in expired_buf.iter() {
        // Revalidate after collecting. A datapath refresh between the first
        // scan and this point wins; the entry is kept.
        if let Ok(cur_val) = ob_map.get(&key, 0) {
            let cur_ib_last = match ib_map.get(&port_host, 0) {
                Ok(iv) if iv.matches_key(&key) => iv.last_seen(),
                _ => 0,
            };
            if now_ns.saturating_sub(cur_val.last_seen().max(cur_ib_last)) <= timeout_ns {
                continue;
            }
        }
        let _ = ob_map.remove(&key);
        if ib_map
            .get(&port_host, 0)
            .map(|iv| iv.matches_key(&key))
            .unwrap_or(false)
            && ib_map.remove(&port_host).is_ok()
        {
            freed_ports.push(port_host);
            swept += 1;
        }
    }

    orphan_buf.clear();
    for (port_host, in_val) in ib_map.iter().flatten() {
        if now_ns.saturating_sub(in_val.last_seen()) <= 2_000_000_000 {
            continue;
        }
        let ep_key = in_val.make_key();
        let is_orphan = match ob_map.get(&ep_key, 0) {
            Ok(ob) => u16::from_be(ob.port_be()) != port_host,
            Err(_) => true,
        };
        if is_orphan {
            orphan_buf.push(port_host);
        }
    }
    for &port in orphan_buf.iter() {
        if ib_map.remove(&port).is_ok() {
            freed_ports.push(port);
            swept += 1;
        }
    }

    swept
}

impl SessionManager {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config_map: Array<MapData, GlobalConfig>,
        active_map: Array<MapData, u32>,
        ob_map4: HashMap<MapData, EndpointKey4, BindingValue4>,
        ib_map4: HashMap<MapData, u16, BindingValue4>,
        ob_map6: HashMap<MapData, EndpointKey6, BindingValue6>,
        ib_map6: HashMap<MapData, u16, BindingValue6>,
        events4: Queue<MapData, SessionEvent4>,
        events6: Queue<MapData, SessionEvent6>,
        gc_flags: Array<MapData, u32>,
        free_state4: Array<MapData, u8>,
        free_state6: Array<MapData, u8>,
        reserved4: Array<MapData, u8>,
        reserved6: Array<MapData, u8>,
        free_even4: Queue<MapData, u16>,
        free_odd4: Queue<MapData, u16>,
        free_even6: Queue<MapData, u16>,
        free_odd6: Queue<MapData, u16>,
        port_flags: Array<MapData, u32>,
    ) -> Self {
        Self {
            config_map,
            active_map,
            ob_map4,
            ib_map4,
            ob_map6,
            ib_map6,
            events4,
            events6,
            gc_flags,
            free_state4,
            free_state6,
            reserved4,
            reserved6,
            free_even4,
            free_odd4,
            free_even6,
            free_odd6,
            port_flags,
            pool_enable_v4: false,
            pool_enable_v6: false,
            min_port: 0,
            max_port: 0,
            freed_ports: Vec::with_capacity(1024),
            heap4: BinaryHeap::with_capacity(MAX_BINDINGS as usize),
            heap6: BinaryHeap::with_capacity(MAX_BINDINGS as usize),
            expired_v4: Vec::with_capacity(1024),
            expired_v6: Vec::with_capacity(1024),
            orphan_ports: Vec::with_capacity(256),
            lost_notifications: false,
        }
    }

    pub fn configure_port_pool(&mut self, min_port: u16, max_port: u16) {
        if min_port == 0 || min_port > max_port {
            return;
        }
        self.min_port = min_port;
        self.max_port = max_port;
    }

    fn pool_ready(&self) -> bool {
        self.min_port != 0 && self.min_port <= self.max_port
    }

    fn drain_queue(q: &mut Queue<MapData, u16>) {
        while q.pop(0).is_ok() {}
    }

    fn set_range_state(state: &mut Array<MapData, u8>, min: u16, max: u16) {
        let mut p = min as u32;
        while p <= max as u32 {
            let _ = state.set(p, 1, 0);
            p += 1;
        }
    }

    fn set_reserved_state(state: &mut Array<MapData, u8>, ports: &[u16]) {
        for &port in ports {
            let _ = state.set(port as u32, 1, 0);
        }
    }

    /// Reserve UDP ports bound by local services (listening state 07) so
    /// port preservation cannot steal a router WAN service. Reserving is
    /// monotonic: a stopped service leaves its port reserved until restart.
    pub fn reserve_local_ports(&mut self) {
        let v4 = std::fs::read_to_string("/proc/net/udp")
            .map(|s| parse_proc_udp_ports(&s))
            .unwrap_or_default();
        let v6 = std::fs::read_to_string("/proc/net/udp6")
            .map(|s| parse_proc_udp_ports(&s))
            .unwrap_or_default();
        Self::set_reserved_state(&mut self.reserved4, &v4);
        Self::set_reserved_state(&mut self.reserved6, &v6);
    }

    fn init_family4(&mut self) {
        if !self.pool_ready() {
            return;
        }
        Self::drain_queue(&mut self.free_even4);
        Self::drain_queue(&mut self.free_odd4);
        Self::set_range_state(&mut self.free_state4, self.min_port, self.max_port);
        let mut p = self.min_port;
        loop {
            let q = if (p & 1) == 0 {
                &mut self.free_even4
            } else {
                &mut self.free_odd4
            };
            if q.push(p, 0).is_err() {
                let _ = self.port_flags.set(0, 1, 0);
                break;
            }
            if p == self.max_port {
                break;
            }
            p += 1;
        }
    }

    fn init_family6(&mut self) {
        if !self.pool_ready() {
            return;
        }
        Self::drain_queue(&mut self.free_even6);
        Self::drain_queue(&mut self.free_odd6);
        Self::set_range_state(&mut self.free_state6, self.min_port, self.max_port);
        let mut p = self.min_port;
        loop {
            let q = if (p & 1) == 0 {
                &mut self.free_even6
            } else {
                &mut self.free_odd6
            };
            if q.push(p, 0).is_err() {
                let _ = self.port_flags.set(0, 1, 0);
                break;
            }
            if p == self.max_port {
                break;
            }
            p += 1;
        }
    }

    pub fn init_port_pool(&mut self, enable_v4: bool, enable_v6: bool) {
        self.pool_enable_v4 = enable_v4;
        self.pool_enable_v6 = enable_v6;
        if enable_v4 {
            self.init_family4();
        }
        if enable_v6 {
            self.init_family6();
        }
    }

    fn release_port4(&mut self, port: u16) {
        if self.free_state4.get(&(port as u32), 0).unwrap_or(0) != 0 {
            return;
        }
        let _ = self.free_state4.set(port as u32, 1, 0);
        let q = if (port & 1) == 0 {
            &mut self.free_even4
        } else {
            &mut self.free_odd4
        };
        if q.push(port, 0).is_err() {
            let _ = self.port_flags.set(0, 1, 0);
        }
    }

    fn release_port6(&mut self, port: u16) {
        if self.free_state6.get(&(port as u32), 0).unwrap_or(0) != 0 {
            return;
        }
        let _ = self.free_state6.set(port as u32, 1, 0);
        let q = if (port & 1) == 0 {
            &mut self.free_even6
        } else {
            &mut self.free_odd6
        };
        if q.push(port, 0).is_err() {
            let _ = self.port_flags.set(0, 1, 0);
        }
    }

    fn rebuild_family4(&mut self) {
        if !self.pool_ready() {
            return;
        }
        Self::drain_queue(&mut self.free_even4);
        Self::drain_queue(&mut self.free_odd4);
        let mut p = self.min_port;
        loop {
            if self.free_state4.get(&(p as u32), 0).unwrap_or(0) != 0 {
                let q = if (p & 1) == 0 {
                    &mut self.free_even4
                } else {
                    &mut self.free_odd4
                };
                if q.push(p, 0).is_err() {
                    let _ = self.port_flags.set(0, 1, 0);
                    return;
                }
            }
            if p == self.max_port {
                break;
            }
            p += 1;
        }
    }

    fn rebuild_family6(&mut self) {
        if !self.pool_ready() {
            return;
        }
        Self::drain_queue(&mut self.free_even6);
        Self::drain_queue(&mut self.free_odd6);
        let mut p = self.min_port;
        loop {
            if self.free_state6.get(&(p as u32), 0).unwrap_or(0) != 0 {
                let q = if (p & 1) == 0 {
                    &mut self.free_even6
                } else {
                    &mut self.free_odd6
                };
                if q.push(p, 0).is_err() {
                    let _ = self.port_flags.set(0, 1, 0);
                    return;
                }
            }
            if p == self.max_port {
                break;
            }
            p += 1;
        }
    }

    fn rebuild_port_queues(&mut self) {
        if self.port_flags.get(&0, 0).unwrap_or(0) != 0 {
            let _ = self.port_flags.set(0, 0, 0);
            if self.pool_enable_v4 {
                self.rebuild_family4();
            }
            if self.pool_enable_v6 {
                self.rebuild_family6();
            }
        }
    }

    /// Publish a new immutable config slot, then atomically switch the active
    /// index. Readers can never observe a partially written GlobalConfig.
    pub fn set_config(&mut self, cfg: GlobalConfig) -> bool {
        let active = self.active_map.get(&0, 0).unwrap_or(0) & 1;
        let next = 1 - active;
        if self.config_map.set(next, cfg, 0).is_err() {
            return false;
        }
        if self.active_map.set(0, next, 0).is_err() {
            return false;
        }
        true
    }

    pub fn clear_v4_mappings(&mut self) {
        let ports = clear_family_mappings(&mut self.ob_map4, &mut self.ib_map4);
        for p in ports {
            self.release_port4(p);
        }
        self.heap4.clear();
    }

    pub fn clear_v6_mappings(&mut self) {
        let ports = clear_family_mappings(&mut self.ob_map6, &mut self.ib_map6);
        for p in ports {
            self.release_port6(p);
        }
        self.heap6.clear();
    }

    #[inline]
    fn schedule4(&mut self, deadline: u64, key: EndpointKey4, port: u16, strike: u8) {
        if self.heap4.len() < MAX_BINDINGS as usize {
            self.heap4.push(Reverse((deadline, key, port, strike)));
        } else {
            self.lost_notifications = true;
        }
    }

    #[inline]
    fn schedule6(&mut self, deadline: u64, key: EndpointKey6, port: u16, strike: u8) {
        if self.heap6.len() < MAX_BINDINGS as usize {
            self.heap6.push(Reverse((deadline, key, port, strike)));
        } else {
            self.lost_notifications = true;
        }
    }

    fn drain_events(&mut self, now: u64, timeout_ns: u64) -> usize {
        let mut drained = 0;
        if self.pool_enable_v4 {
            while drained < GC_QUEUE_DRAIN_MAX {
                match self.events4.pop(0) {
                    Ok(ev) => {
                        self.schedule4(now.saturating_add(timeout_ns), ev.key, ev.port, 0);
                        drained += 1;
                    }
                    Err(MapError::ElementNotFound) => break,
                    Err(_) => break,
                }
            }
        }
        if self.pool_enable_v6 {
            let limit = drained + GC_QUEUE_DRAIN_MAX;
            while drained < limit {
                match self.events6.pop(0) {
                    Ok(ev) => {
                        self.schedule6(now.saturating_add(timeout_ns), ev.key, ev.port, 0);
                        drained += 1;
                    }
                    Err(MapError::ElementNotFound) => break,
                    Err(_) => break,
                }
            }
        }
        drained
    }

    fn expiry_tick(&mut self, now: u64, timeout_ns: u64) -> (usize, usize) {
        let mut swept4 = 0;
        let mut swept6 = 0;
        let mut processed = 0;

        while processed < GC_EXPIRY_MAX_PER_TICK {
            let Some(Reverse((deadline, key, port, strike))) = self.heap4.peek().copied() else {
                break;
            };
            if deadline > now {
                break;
            }
            self.heap4.pop();

            let ob = self.ob_map4.get(&key, 0);
            let ib = self.ib_map4.get(&port, 0);
            let ob_matches = matches!(&ob, Ok(val) if u16::from_be(val.port) == port);
            let ib_matches = matches!(&ib, Ok(iv) if iv.matches_key(&key));
            let mut last = 0u64;
            if ob_matches && let Ok(val) = ob {
                last = val.last_seen;
            }
            if ib_matches && let Ok(iv) = ib {
                last = last.max(iv.last_seen);
            }
            if !ob_matches {
                if ib_matches && self.ib_map4.remove(&port).is_ok() {
                    self.release_port4(port);
                    swept4 += 1;
                }
            } else if last != 0 && now.saturating_sub(last) <= timeout_ns {
                self.schedule4(last.saturating_add(timeout_ns), key, port, 0);
            } else if last != 0 && strike == 0 {
                self.schedule4(now.saturating_add(GC_EXPIRY_STRIKE_NS), key, port, 1);
            } else {
                let ob_removed = self.ob_map4.remove(&key).is_ok();
                let ib_removed = if ib_matches {
                    self.ib_map4.remove(&port).is_ok()
                } else {
                    false
                };
                if ib_removed {
                    self.release_port4(port);
                }
                if ob_removed || ib_removed {
                    swept4 += 1;
                }
            }
            processed += 1;
        }

        processed = 0;
        while processed < GC_EXPIRY_MAX_PER_TICK {
            let Some(Reverse((deadline, key, port, strike))) = self.heap6.peek().copied() else {
                break;
            };
            if deadline > now {
                break;
            }
            self.heap6.pop();

            let ob = self.ob_map6.get(&key, 0);
            let ib = self.ib_map6.get(&port, 0);
            let ob_matches = matches!(&ob, Ok(val) if u16::from_be(val.port) == port);
            let ib_matches = matches!(&ib, Ok(iv) if iv.matches_key(&key));
            let mut last = 0u64;
            if ob_matches && let Ok(val) = ob {
                last = val.last_seen;
            }
            if ib_matches && let Ok(iv) = ib {
                last = last.max(iv.last_seen);
            }
            if !ob_matches {
                if ib_matches && self.ib_map6.remove(&port).is_ok() {
                    self.release_port6(port);
                    swept6 += 1;
                }
            } else if last != 0 && now.saturating_sub(last) <= timeout_ns {
                self.schedule6(last.saturating_add(timeout_ns), key, port, 0);
            } else if last != 0 && strike == 0 {
                self.schedule6(now.saturating_add(GC_EXPIRY_STRIKE_NS), key, port, 1);
            } else {
                let ob_removed = self.ob_map6.remove(&key).is_ok();
                let ib_removed = if ib_matches {
                    self.ib_map6.remove(&port).is_ok()
                } else {
                    false
                };
                if ib_removed {
                    self.release_port6(port);
                }
                if ob_removed || ib_removed {
                    swept6 += 1;
                }
            }
            processed += 1;
        }

        (swept4, swept6)
    }

    fn rebuild_heaps(&mut self, timeout_ns: u64) {
        self.heap4.clear();
        self.heap6.clear();
        if self.pool_enable_v4 {
            let mut pending4: Vec<(u64, EndpointKey4, u16)> = Vec::new();
            for (key, val) in self.ob_map4.iter().flatten() {
                let port = u16::from_be(val.port_be());
                let ib_last = self
                    .ib_map4
                    .get(&port, 0)
                    .ok()
                    .filter(|iv| iv.matches_key(&key))
                    .map(|iv| iv.last_seen())
                    .unwrap_or(0);
                let deadline = val.last_seen().max(ib_last).saturating_add(timeout_ns);
                pending4.push((deadline, key, port));
            }
            for (deadline, key, port) in pending4 {
                self.schedule4(deadline, key, port, 0);
            }
        }

        if self.pool_enable_v6 {
            let mut pending6: Vec<(u64, EndpointKey6, u16)> = Vec::new();
            for (key, val) in self.ob_map6.iter().flatten() {
                let port = u16::from_be(val.port_be());
                let ib_last = self
                    .ib_map6
                    .get(&port, 0)
                    .ok()
                    .filter(|iv| iv.matches_key(&key))
                    .map(|iv| iv.last_seen())
                    .unwrap_or(0);
                let deadline = val.last_seen().max(ib_last).saturating_add(timeout_ns);
                pending6.push((deadline, key, port));
            }
            for (deadline, key, port) in pending6 {
                self.schedule6(deadline, key, port, 0);
            }
        }
    }

    /// Process new-session notifications and due expiries. No full-map scan is
    /// performed unless a notification was lost.
    pub fn gc_tick(&mut self, now_ns: u64, timeout_ns: u64) -> (usize, usize) {
        self.drain_events(now_ns, timeout_ns);
        let (mut swept4, mut swept6) = self.expiry_tick(now_ns, timeout_ns);

        let flag = self.gc_flags.get(&0, 0).unwrap_or(0);
        if flag != 0 || self.lost_notifications {
            let _ = self.gc_flags.set(0, 0, 0);
            self.lost_notifications = false;
            self.heap4.clear();
            self.heap6.clear();
            if self.pool_enable_v4 {
                self.freed_ports.clear();
                swept4 += sweep_family(
                    &mut self.ob_map4,
                    &mut self.ib_map4,
                    &mut self.expired_v4,
                    &mut self.orphan_ports,
                    &mut self.freed_ports,
                    now_ns,
                    timeout_ns,
                );
                self.freed_ports.sort_unstable();
                self.freed_ports.dedup();
                let freed = core::mem::take(&mut self.freed_ports);
                for p in freed {
                    self.release_port4(p);
                }
            }
            if self.pool_enable_v6 {
                self.freed_ports.clear();
                swept6 += sweep_family(
                    &mut self.ob_map6,
                    &mut self.ib_map6,
                    &mut self.expired_v6,
                    &mut self.orphan_ports,
                    &mut self.freed_ports,
                    now_ns,
                    timeout_ns,
                );
                self.freed_ports.sort_unstable();
                self.freed_ports.dedup();
                let freed = core::mem::take(&mut self.freed_ports);
                for p in freed {
                    self.release_port6(p);
                }
            }
            self.rebuild_heaps(timeout_ns);
        }

        self.rebuild_port_queues();
        (swept4, swept6)
    }

    pub fn disable_fail_open(&mut self) {
        let empty_cfg = GlobalConfig {
            wan_ip4: 0,
            bypass_mark_mask: 0,
            bypass_mark_val: 0,
            l2_len: 0,
            wan_ip6: [0u8; 16],
            min_port4: 0,
            max_port4: 0,
            min_port6: 0,
            max_port6: 0,
            enabled_v4: 0,
            enabled_v6: 0,
            flowcone_mark: 0,
        };
        let _ = self.set_config(empty_cfg);
    }
}

#[cfg(test)]
mod port_parser_tests {
    use super::parse_proc_udp_ports;

    #[test]
    fn parses_listening_and_skips_connected() {
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n 0: 00000000:1450 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n 1: 0100007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n 2: 0100007F:C000 0100007F:0035 01 00000000:00000000 00:00000000 00000000  0 0 1 1\n";
        let ports = parse_proc_udp_ports(text);
        assert!(ports.contains(&0x1450));
        assert!(ports.contains(&0x35));
        assert!(!ports.contains(&0xC000));
    }
}
