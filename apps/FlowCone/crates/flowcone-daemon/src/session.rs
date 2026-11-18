use aya::maps::{Array, HashMap, MapData, Queue, RingBuf};
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, FragKey4, FragKey6, FragValue4,
    FragValue6, GlobalConfig, MAX_BINDINGS, PORT_FREE_BIT, PORT_QUEUED_BIT, SessionEvent4,
    SessionEvent6, port_state_on_release,
};
use std::cmp::Reverse;
use std::collections::BinaryHeap;

type Expiry4 = Reverse<(u32, EndpointKey4, u16)>;
type Expiry6 = Reverse<(u32, EndpointKey6, u16)>;

const GC_QUEUE_DRAIN_MAX: usize = 32768;
const GC_EXPIRY_MAX_PER_TICK: usize = 1024;

/// Queries listening UDP service ports via NETLINK_INET_DIAG binary interface.
fn scan_netlink_udp_ports(family: u8) -> Option<Vec<u16>> {
    use rustix::net::{AddressFamily, Protocol, SocketFlags, SocketType, recv, send, socket_with};
    use std::num::NonZeroU32;
    use std::time::Duration;

    let proto = Protocol::from_raw(NonZeroU32::new(4)?);
    let sock = socket_with(
        AddressFamily::NETLINK,
        SocketType::RAW,
        SocketFlags::CLOEXEC,
        Some(proto),
    )
    .ok()?;

    let _ = rustix::net::sockopt::set_socket_timeout(
        &sock,
        rustix::net::sockopt::Timeout::Recv,
        Some(Duration::from_millis(100)),
    );

    // 72-byte netlink dump request: 16-byte nlmsghdr + 56-byte inet_diag_req_v2
    let mut req = [0u8; 72];
    req[0..4].copy_from_slice(&(72u32).to_ne_bytes());
    req[4..6].copy_from_slice(&(20u16).to_ne_bytes()); // SOCK_DIAG_BY_FAMILY
    req[6..8].copy_from_slice(&(0x0001u16 | 0x0004u16).to_ne_bytes()); // NLM_F_REQUEST | NLM_F_DUMP
    req[8..12].copy_from_slice(&(1u32).to_ne_bytes()); // nlmsg_seq
    req[16] = family;
    req[17] = 17; // IPPROTO_UDP
    req[20..24].copy_from_slice(&(1u32 << 7).to_ne_bytes()); // TCP_CLOSE (listening UDP)

    send(&sock, &req, rustix::net::SendFlags::empty()).ok()?;

    let mut buf = [0u8; 8192];
    let mut ports = Vec::new();
    'recv_loop: loop {
        let (n, _) = recv(&sock, &mut buf, rustix::net::RecvFlags::empty()).ok()?;
        if n == 0 {
            break;
        }
        let mut offset = 0;
        while offset + 16 <= n {
            let nlmsg_len =
                u32::from_ne_bytes(buf[offset..offset + 4].try_into().unwrap()) as usize;
            let nlmsg_type = u16::from_ne_bytes(buf[offset + 4..offset + 6].try_into().unwrap());
            if nlmsg_len < 16 || offset + nlmsg_len > n {
                break;
            }
            if nlmsg_type == 2 {
                // NLMSG_ERROR: request rejected or unsupported protocol; fallback to procfs
                return None;
            }
            if nlmsg_type == 3 {
                // NLMSG_DONE: multi-part dump finished normally
                break 'recv_loop;
            }
            if nlmsg_type == 20 {
                let payload = &buf[offset + 16..offset + nlmsg_len];
                if payload.len() >= 72 && payload[1] == 7 {
                    let sport = u16::from_be_bytes([payload[4], payload[5]]);
                    if sport != 0 {
                        ports.push(sport);
                    }
                }
            }
            offset += (nlmsg_len + 3) & !3; // NLMSG_ALIGN
        }
    }
    if ports.is_empty() { None } else { Some(ports) }
}

/// Parses listening UDP service ports from Netlink INET_DIAG with procfs fallback.
pub fn scan_local_udp_ports(family: u8, procfs_path: &str) -> Option<Vec<u16>> {
    if let Some(mut ports) = scan_netlink_udp_ports(family) {
        ports.sort_unstable();
        ports.dedup();
        return Some(ports);
    }
    let text = std::fs::read_to_string(procfs_path).ok()?;
    let mut ports = parse_proc_udp_ports(&text);
    ports.sort_unstable();
    ports.dedup();
    Some(ports)
}

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

/// Added and removed ports between two sorted, deduplicated lists.
fn reserved_delta(previous: &[u16], current: &[u16]) -> (Vec<u16>, Vec<u16>) {
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut i = 0;
    let mut j = 0;
    while i < previous.len() && j < current.len() {
        match previous[i].cmp(&current[j]) {
            std::cmp::Ordering::Less => {
                removed.push(previous[i]);
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                added.push(current[j]);
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                i += 1;
                j += 1;
            }
        }
    }
    if i < previous.len() {
        removed.extend_from_slice(&previous[i..]);
    }
    if j < current.len() {
        added.extend_from_slice(&current[j..]);
    }
    (added, removed)
}

pub struct SessionManager {
    config_map: Array<MapData, GlobalConfig>,
    active_map: Array<MapData, u32>,
    ob_map4: HashMap<MapData, EndpointKey4, BindingValue4>,
    ib_map4: HashMap<MapData, u16, BindingValue4>,
    ob_map6: HashMap<MapData, EndpointKey6, BindingValue6>,
    ib_map6: HashMap<MapData, u16, BindingValue6>,
    frag_in4: HashMap<MapData, FragKey4, FragValue4>,
    frag_out4: HashMap<MapData, FragKey4, FragValue4>,
    frag_in6: HashMap<MapData, FragKey6, FragValue6>,
    frag_out6: HashMap<MapData, FragKey6, FragValue6>,
    events4: RingBuf<MapData>,
    events6: RingBuf<MapData>,
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
    // Expiry scheduler min-heaps.
    heap4: BinaryHeap<Expiry4>,
    heap6: BinaryHeap<Expiry6>,
    // Pre-allocated buffers for full-table sweeps.
    expired_v4: Vec<(EndpointKey4, u16)>,
    expired_v6: Vec<(EndpointKey6, u16)>,
    orphan_ports: Vec<u16>,
    reserved4_ports: Vec<u16>,
    reserved6_ports: Vec<u16>,
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

fn clear_map<K: aya::Pod, V: aya::Pod>(map: &mut HashMap<MapData, K, V>) {
    let keys: Vec<K> = map.keys().filter_map(|r| r.ok()).collect();
    for key in keys {
        let _ = map.remove(&key);
    }
}

trait ConeBinding: aya::Pod + Copy {
    type Key: aya::Pod + Copy + PartialEq;
    fn port_be(&self) -> u16;
    fn last_seen(&self) -> u32;
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
    fn last_seen(&self) -> u32 {
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
    fn last_seen(&self) -> u32 {
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
    now: u32,
    timeout: u32,
) -> usize {
    expired_buf.clear();
    for (key, val) in ob_map.iter().flatten() {
        if now.saturating_sub(val.last_seen()) <= timeout {
            continue;
        }
        let port_host = u16::from_be(val.port_be());
        let ib_last = match ib_map.get(&port_host, 0) {
            Ok(iv) if iv.matches_key(&key) => iv.last_seen(),
            _ => 0,
        };
        if now.saturating_sub(ib_last) > timeout {
            expired_buf.push((key, port_host));
        }
    }

    let mut swept = 0;
    for &(key, port_host) in expired_buf.iter() {
        // Revalidate against datapath refresh.
        if let Ok(cur_val) = ob_map.get(&key, 0) {
            let cur_ib_last = match ib_map.get(&port_host, 0) {
                Ok(iv) if iv.matches_key(&key) => iv.last_seen(),
                _ => 0,
            };
            if now.saturating_sub(cur_val.last_seen().max(cur_ib_last)) <= timeout {
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
        if now.saturating_sub(in_val.last_seen()) <= 2 {
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

/// Collection of eBPF maps used by SessionManager.
pub struct SessionMaps {
    pub config_map: Array<MapData, GlobalConfig>,
    pub active_map: Array<MapData, u32>,
    pub ob_map4: HashMap<MapData, EndpointKey4, BindingValue4>,
    pub ib_map4: HashMap<MapData, u16, BindingValue4>,
    pub ob_map6: HashMap<MapData, EndpointKey6, BindingValue6>,
    pub ib_map6: HashMap<MapData, u16, BindingValue6>,
    pub frag_in4: HashMap<MapData, FragKey4, FragValue4>,
    pub frag_out4: HashMap<MapData, FragKey4, FragValue4>,
    pub frag_in6: HashMap<MapData, FragKey6, FragValue6>,
    pub frag_out6: HashMap<MapData, FragKey6, FragValue6>,
    pub events4: RingBuf<MapData>,
    pub events6: RingBuf<MapData>,
    pub gc_flags: Array<MapData, u32>,
    pub free_state4: Array<MapData, u8>,
    pub free_state6: Array<MapData, u8>,
    pub reserved4: Array<MapData, u8>,
    pub reserved6: Array<MapData, u8>,
    pub free_even4: Queue<MapData, u16>,
    pub free_odd4: Queue<MapData, u16>,
    pub free_even6: Queue<MapData, u16>,
    pub free_odd6: Queue<MapData, u16>,
    pub port_flags: Array<MapData, u32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ExpiryStep {
    Keep { deadline: u32 },
    Drop,
}

/// Calculates expiry action for binding.
#[inline]
fn expiry_step(now: u32, timeout: u32, seen: Option<u32>) -> ExpiryStep {
    match seen {
        Some(last) if now.saturating_sub(last) <= timeout => ExpiryStep::Keep {
            deadline: last.saturating_add(timeout),
        },
        _ => ExpiryStep::Drop,
    }
}

struct FamilyPortPool<'a> {
    even: &'a mut Queue<MapData, u16>,
    odd: &'a mut Queue<MapData, u16>,
    free_state: &'a mut Array<MapData, u8>,
    reserved_ports: &'a [u16],
    port_flags: &'a mut Array<MapData, u32>,
}

impl SessionManager {
    pub fn new(maps: SessionMaps) -> Self {
        let SessionMaps {
            config_map,
            active_map,
            ob_map4,
            ib_map4,
            ob_map6,
            ib_map6,
            frag_in4,
            frag_out4,
            frag_in6,
            frag_out6,
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
        } = maps;
        Self {
            config_map,
            active_map,
            ob_map4,
            ib_map4,
            ob_map6,
            ib_map6,
            frag_in4,
            frag_out4,
            frag_in6,
            frag_out6,
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
            reserved4_ports: Vec::new(),
            reserved6_ports: Vec::new(),
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

    fn sync_family_reserved(
        reserved_ports: &mut Vec<u16>,
        current: &[u16],
        reserved_map: &mut Array<MapData, u8>,
        free_state: &mut Array<MapData, u8>,
        ib_map_contains: impl Fn(u16) -> bool,
        to_release: &mut Vec<u16>,
    ) -> bool {
        let (added, removed) = reserved_delta(reserved_ports, current);
        if added.is_empty() && removed.is_empty() {
            return false;
        }
        for port in added {
            let _ = reserved_map.set(port as u32, &1, 0);
            let _ = free_state.set(port as u32, &0, 0);
        }
        for port in removed {
            let _ = reserved_map.set(port as u32, &0, 0);
            if !ib_map_contains(port) {
                to_release.push(port);
            }
        }
        *reserved_ports = current.to_vec();
        true
    }

    /// Applies updated local listening UDP ports to reserved maps.
    pub fn apply_reserved_ports(&mut self, ports4: Option<&[u16]>, ports6: Option<&[u16]>) {
        let mut to_release = Vec::new();
        if let Some(ports) = ports4 {
            Self::sync_family_reserved(
                &mut self.reserved4_ports,
                ports,
                &mut self.reserved4,
                &mut self.free_state4,
                |p| self.ib_map4.get(&p, 0).is_ok(),
                &mut to_release,
            );
            for p in to_release.drain(..) {
                self.release_port4(p);
            }
        }
        if let Some(ports) = ports6 {
            Self::sync_family_reserved(
                &mut self.reserved6_ports,
                ports,
                &mut self.reserved6,
                &mut self.free_state6,
                |p| self.ib_map6.get(&p, 0).is_ok(),
                &mut to_release,
            );
            for p in to_release.drain(..) {
                self.release_port6(p);
            }
        }
    }

    /// Synchronizes reserved local UDP service ports from Netlink or /proc/net/udp[6].
    pub fn reserve_local_ports(&mut self) {
        let p4 = scan_local_udp_ports(2, "/proc/net/udp");
        let p6 = scan_local_udp_ports(10, "/proc/net/udp6");
        self.apply_reserved_ports(p4.as_deref(), p6.as_deref());
    }

    fn init_family_pool(min_port: u16, max_port: u16, pool: &mut FamilyPortPool<'_>) {
        Self::drain_queue(pool.even);
        Self::drain_queue(pool.odd);
        let mut p = min_port;
        loop {
            let q = if (p & 1) == 0 {
                &mut *pool.even
            } else {
                &mut *pool.odd
            };
            if q.push(&p, 0).is_err() {
                let _ = pool.port_flags.set(0, &1, 0);
                break;
            }
            let _ = pool
                .free_state
                .set(p as u32, &(PORT_FREE_BIT | PORT_QUEUED_BIT), 0);
            if p == max_port {
                break;
            }
            p += 1;
        }
    }

    pub fn init_port_pool(&mut self, enable_v4: bool, enable_v6: bool) {
        self.pool_enable_v4 = enable_v4;
        self.pool_enable_v6 = enable_v6;
        if !self.pool_ready() {
            return;
        }
        if enable_v4 {
            let mut pool = FamilyPortPool {
                even: &mut self.free_even4,
                odd: &mut self.free_odd4,
                free_state: &mut self.free_state4,
                reserved_ports: &self.reserved4_ports,
                port_flags: &mut self.port_flags,
            };
            Self::init_family_pool(self.min_port, self.max_port, &mut pool);
        }
        if enable_v6 {
            let mut pool = FamilyPortPool {
                even: &mut self.free_even6,
                odd: &mut self.free_odd6,
                free_state: &mut self.free_state6,
                reserved_ports: &self.reserved6_ports,
                port_flags: &mut self.port_flags,
            };
            Self::init_family_pool(self.min_port, self.max_port, &mut pool);
        }
    }

    fn release_family_port(port: u16, min_port: u16, max_port: u16, pool: &mut FamilyPortPool<'_>) {
        if port < min_port || port > max_port {
            return;
        }
        if pool.reserved_ports.binary_search(&port).is_ok() {
            return;
        }
        let state = pool.free_state.get(&(port as u32), 0).unwrap_or(0);
        let (needs_push, new_state) = port_state_on_release(state);
        if !needs_push {
            if new_state != state {
                let _ = pool.free_state.set(port as u32, &new_state, 0);
            }
            return;
        }
        let q = if (port & 1) == 0 {
            &mut *pool.even
        } else {
            &mut *pool.odd
        };
        if q.push(&port, 0).is_err() {
            let _ = pool.port_flags.set(0, &1, 0);
            let _ = pool
                .free_state
                .set(port as u32, &(state | PORT_FREE_BIT), 0);
        } else {
            let _ = pool.free_state.set(port as u32, &new_state, 0);
        }
    }

    fn release_port4(&mut self, port: u16) {
        let mut pool = FamilyPortPool {
            even: &mut self.free_even4,
            odd: &mut self.free_odd4,
            free_state: &mut self.free_state4,
            reserved_ports: &self.reserved4_ports,
            port_flags: &mut self.port_flags,
        };
        Self::release_family_port(port, self.min_port, self.max_port, &mut pool);
    }

    fn release_port6(&mut self, port: u16) {
        let mut pool = FamilyPortPool {
            even: &mut self.free_even6,
            odd: &mut self.free_odd6,
            free_state: &mut self.free_state6,
            reserved_ports: &self.reserved6_ports,
            port_flags: &mut self.port_flags,
        };
        Self::release_family_port(port, self.min_port, self.max_port, &mut pool);
    }

    fn rebuild_family_ports(
        min_port: u16,
        max_port: u16,
        ib_keys: impl Iterator<Item = u16>,
        pool: &mut FamilyPortPool<'_>,
    ) {
        let mut in_use = [0u64; 1024];
        for key in ib_keys {
            in_use[(key as usize) / 64] |= 1u64 << ((key as usize) % 64);
        }
        Self::drain_queue(pool.even);
        Self::drain_queue(pool.odd);
        let mut p = min_port;
        loop {
            let is_used = (in_use[(p as usize) / 64] & (1u64 << ((p as usize) % 64))) != 0;
            if is_used {
                let _ = pool.free_state.set(p as u32, &0, 0);
            } else if pool.reserved_ports.binary_search(&p).is_err() {
                let _ = pool
                    .free_state
                    .set(p as u32, &(PORT_FREE_BIT | PORT_QUEUED_BIT), 0);
                let q = if (p & 1) == 0 {
                    &mut *pool.even
                } else {
                    &mut *pool.odd
                };
                if q.push(&p, 0).is_err() {
                    let _ = pool.free_state.set(p as u32, &0, 0);
                    let _ = pool.port_flags.set(0, &1, 0);
                    return;
                }
            } else {
                let _ = pool.free_state.set(p as u32, &0, 0);
            }
            if p == max_port {
                break;
            }
            p += 1;
        }
    }

    fn rebuild_family4(&mut self) {
        if !self.pool_enable_v4 || !self.pool_ready() {
            return;
        }
        let mut pool = FamilyPortPool {
            even: &mut self.free_even4,
            odd: &mut self.free_odd4,
            free_state: &mut self.free_state4,
            reserved_ports: &self.reserved4_ports,
            port_flags: &mut self.port_flags,
        };
        Self::rebuild_family_ports(
            self.min_port,
            self.max_port,
            self.ib_map4.keys().flatten(),
            &mut pool,
        );
    }

    fn rebuild_family6(&mut self) {
        if !self.pool_enable_v6 || !self.pool_ready() {
            return;
        }
        let mut pool = FamilyPortPool {
            even: &mut self.free_even6,
            odd: &mut self.free_odd6,
            free_state: &mut self.free_state6,
            reserved_ports: &self.reserved6_ports,
            port_flags: &mut self.port_flags,
        };
        Self::rebuild_family_ports(
            self.min_port,
            self.max_port,
            self.ib_map6.keys().flatten(),
            &mut pool,
        );
    }

    fn rebuild_port_queues(&mut self) {
        if self.port_flags.get(&0, 0).unwrap_or(0) != 0 {
            let _ = self.port_flags.set(0, &0, 0);
            if self.pool_enable_v4 {
                self.rebuild_family4();
            }
            if self.pool_enable_v6 {
                self.rebuild_family6();
            }
        }
    }

    /// Atomically updates active GlobalConfig via double-buffering.
    pub fn set_config(&mut self, cfg: GlobalConfig) -> bool {
        let active = self.active_map.get(&0, 0).unwrap_or(0) & 1;
        let next = 1 - active;
        if self.config_map.set(next, &cfg, 0).is_err() {
            return false;
        }
        self.active_map.set(0, &next, 0).is_ok()
    }

    pub fn clear_v4_mappings(&mut self) {
        let ports = clear_family_mappings(&mut self.ob_map4, &mut self.ib_map4);
        for p in ports {
            self.release_port4(p);
        }
        // Flush fragment translation caches.
        clear_map(&mut self.frag_in4);
        clear_map(&mut self.frag_out4);
        self.heap4.clear();
    }

    pub fn clear_v6_mappings(&mut self) {
        let ports = clear_family_mappings(&mut self.ob_map6, &mut self.ib_map6);
        for p in ports {
            self.release_port6(p);
        }
        clear_map(&mut self.frag_in6);
        clear_map(&mut self.frag_out6);
        self.heap6.clear();
    }

    #[inline]
    fn schedule4(&mut self, deadline: u32, key: EndpointKey4, port: u16) {
        if self.heap4.len() < MAX_BINDINGS as usize {
            self.heap4.push(Reverse((deadline, key, port)));
        } else {
            self.lost_notifications = true;
        }
    }

    #[inline]
    fn schedule6(&mut self, deadline: u32, key: EndpointKey6, port: u16) {
        if self.heap6.len() < MAX_BINDINGS as usize {
            self.heap6.push(Reverse((deadline, key, port)));
        } else {
            self.lost_notifications = true;
        }
    }

    pub fn event_fds(&self) -> (std::os::fd::RawFd, std::os::fd::RawFd) {
        use std::os::fd::AsRawFd;
        (self.events4.as_raw_fd(), self.events6.as_raw_fd())
    }

    pub fn drain_events(&mut self, now: u32, timeout: u32) -> usize {
        let mut drained = 0;
        if self.pool_enable_v4 {
            while drained < GC_QUEUE_DRAIN_MAX {
                let ev = if let Some(item) = self.events4.next() {
                    if item.len() >= std::mem::size_of::<SessionEvent4>() {
                        Some(unsafe {
                            std::ptr::read_unaligned(item.as_ptr() as *const SessionEvent4)
                        })
                    } else {
                        None
                    }
                } else {
                    break;
                };
                if let Some(ev) = ev {
                    let ev_timeout = if ev.is_short_lived() {
                        flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                    } else {
                        timeout
                    };
                    self.schedule4(now.saturating_add(ev_timeout), ev.key, ev.port);
                    drained += 1;
                }
            }
        }
        if self.pool_enable_v6 {
            let limit = drained + GC_QUEUE_DRAIN_MAX;
            while drained < limit {
                let ev = if let Some(item) = self.events6.next() {
                    if item.len() >= std::mem::size_of::<SessionEvent6>() {
                        Some(unsafe {
                            std::ptr::read_unaligned(item.as_ptr() as *const SessionEvent6)
                        })
                    } else {
                        None
                    }
                } else {
                    break;
                };
                if let Some(ev) = ev {
                    let ev_timeout = if ev.is_short_lived() {
                        flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                    } else {
                        timeout
                    };
                    self.schedule6(now.saturating_add(ev_timeout), ev.key, ev.port);
                    drained += 1;
                }
            }
        }
        drained
    }

    fn expiry_tick(&mut self, now: u32, timeout: u32) -> (usize, usize, bool) {
        let mut swept4 = 0;
        let mut swept6 = 0;
        let mut processed4 = 0;

        while processed4 < GC_EXPIRY_MAX_PER_TICK {
            let Some(Reverse((deadline, key, port))) = self.heap4.peek().copied() else {
                break;
            };
            if deadline >= now {
                break;
            }
            self.heap4.pop();

            let ob = self.ob_map4.get(&key, 0);
            let ob_matches = matches!(&ob, Ok(val) if u16::from_be(val.port) == port);
            let mut seen = None;
            let ib_matches;

            let item_timeout = if let Ok(val) = &ob {
                if val.is_short_lived() {
                    flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                } else {
                    timeout
                }
            } else if let Ok(iv) = self.ib_map4.get(&port, 0) {
                if iv.is_short_lived() {
                    flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                } else {
                    timeout
                }
            } else {
                timeout
            };

            if ob_matches && let Ok(val) = ob {
                if now.saturating_sub(val.last_seen) <= item_timeout {
                    // Outbound active; skip inbound check (RFC 4787).
                    self.schedule4(val.last_seen.saturating_add(item_timeout), key, port);
                    processed4 += 1;
                    continue;
                }
                seen = Some(val.last_seen);
                let ib = self.ib_map4.get(&port, 0);
                ib_matches = matches!(&ib, Ok(iv) if iv.matches_key(&key));
                if ib_matches && let Ok(iv) = ib {
                    seen = Some(val.last_seen.max(iv.last_seen));
                }
            } else {
                let ib = self.ib_map4.get(&port, 0);
                ib_matches = matches!(&ib, Ok(iv) if iv.matches_key(&key));
                if ib_matches && let Ok(iv) = ib {
                    seen = Some(iv.last_seen);
                }
            }
            if !ob_matches {
                if ib_matches {
                    if let Some(t) = seen.filter(|t| now.saturating_sub(*t) <= item_timeout) {
                        self.schedule4(t.saturating_add(item_timeout), key, port);
                    } else if self.ib_map4.remove(&port).is_ok() {
                        self.release_port4(port);
                        swept4 += 1;
                    }
                }
            } else {
                match expiry_step(now, item_timeout, seen) {
                    ExpiryStep::Keep { deadline } => {
                        self.schedule4(deadline, key, port);
                    }
                    ExpiryStep::Drop => {
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
                }
            }
            processed4 += 1;
        }

        let mut processed6 = 0;
        while processed6 < GC_EXPIRY_MAX_PER_TICK {
            let Some(Reverse((deadline, key, port))) = self.heap6.peek().copied() else {
                break;
            };
            if deadline >= now {
                break;
            }
            self.heap6.pop();

            let ob = self.ob_map6.get(&key, 0);
            let ob_matches = matches!(&ob, Ok(val) if u16::from_be(val.port) == port);
            let mut seen = None;
            let ib_matches;

            let item_timeout = if let Ok(val) = &ob {
                if val.is_short_lived() {
                    flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                } else {
                    timeout
                }
            } else if let Ok(iv) = self.ib_map6.get(&port, 0) {
                if iv.is_short_lived() {
                    flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                } else {
                    timeout
                }
            } else {
                timeout
            };

            if ob_matches && let Ok(val) = ob {
                if now.saturating_sub(val.last_seen) <= item_timeout {
                    // Outbound active; skip inbound check (RFC 4787).
                    self.schedule6(val.last_seen.saturating_add(item_timeout), key, port);
                    processed6 += 1;
                    continue;
                }
                seen = Some(val.last_seen);
                let ib = self.ib_map6.get(&port, 0);
                ib_matches = matches!(&ib, Ok(iv) if iv.matches_key(&key));
                if ib_matches && let Ok(iv) = ib {
                    seen = Some(val.last_seen.max(iv.last_seen));
                }
            } else {
                let ib = self.ib_map6.get(&port, 0);
                ib_matches = matches!(&ib, Ok(iv) if iv.matches_key(&key));
                if ib_matches && let Ok(iv) = ib {
                    seen = Some(iv.last_seen);
                }
            }
            if !ob_matches {
                if ib_matches {
                    if let Some(t) = seen.filter(|t| now.saturating_sub(*t) <= item_timeout) {
                        self.schedule6(t.saturating_add(item_timeout), key, port);
                    } else if self.ib_map6.remove(&port).is_ok() {
                        self.release_port6(port);
                        swept6 += 1;
                    }
                }
            } else {
                match expiry_step(now, item_timeout, seen) {
                    ExpiryStep::Keep { deadline } => {
                        self.schedule6(deadline, key, port);
                    }
                    ExpiryStep::Drop => {
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
                }
            }
            processed6 += 1;
        }

        let backlog4 = processed4 == GC_EXPIRY_MAX_PER_TICK
            && self.heap4.peek().is_some_and(|Reverse((d, ..))| *d < now);
        let backlog6 = processed6 == GC_EXPIRY_MAX_PER_TICK
            && self.heap6.peek().is_some_and(|Reverse((d, ..))| *d < now);

        (swept4, swept6, backlog4 || backlog6)
    }

    fn rebuild_heaps(&mut self, timeout: u32) {
        self.heap4.clear();
        self.heap6.clear();
        if self.pool_enable_v4 {
            let mut entries4 = Vec::new();
            for (key, val) in self.ob_map4.iter().flatten() {
                let port = u16::from_be(val.port_be());
                let ib_last = self
                    .ib_map4
                    .get(&port, 0)
                    .ok()
                    .filter(|iv| iv.matches_key(&key))
                    .map(|iv| iv.last_seen())
                    .unwrap_or(0);
                let item_timeout = if val.is_short_lived() {
                    flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                } else {
                    timeout
                };
                let deadline = val.last_seen().max(ib_last).saturating_add(item_timeout);
                if entries4.len() < MAX_BINDINGS as usize {
                    entries4.push(Reverse((deadline, key, port)));
                } else {
                    self.lost_notifications = true;
                    break;
                }
            }
            self.heap4 = BinaryHeap::from(entries4);
        }

        if self.pool_enable_v6 {
            let mut entries6 = Vec::new();
            for (key, val) in self.ob_map6.iter().flatten() {
                let port = u16::from_be(val.port_be());
                let ib_last = self
                    .ib_map6
                    .get(&port, 0)
                    .ok()
                    .filter(|iv| iv.matches_key(&key))
                    .map(|iv| iv.last_seen())
                    .unwrap_or(0);
                let item_timeout = if val.is_short_lived() {
                    flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                } else {
                    timeout
                };
                let deadline = val.last_seen().max(ib_last).saturating_add(item_timeout);
                if entries6.len() < MAX_BINDINGS as usize {
                    entries6.push(Reverse((deadline, key, port)));
                } else {
                    self.lost_notifications = true;
                    break;
                }
            }
            self.heap6 = BinaryHeap::from(entries6);
        }
    }

    /// Performs periodic session expiry and event ring buffer draining.
    pub fn gc_tick(&mut self, now: u32, timeout: u32) -> (usize, usize, bool) {
        self.drain_events(now, timeout);
        let (mut swept4, mut swept6, has_backlog) = self.expiry_tick(now, timeout);

        let flag = self.gc_flags.get(&0, 0).unwrap_or(0);
        if flag != 0 || self.lost_notifications {
            let _ = self.gc_flags.set(0, &0, 0);
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
                    now,
                    timeout,
                );
                self.freed_ports.sort_unstable();
                self.freed_ports.dedup();
                for i in 0..self.freed_ports.len() {
                    let p = self.freed_ports[i];
                    self.release_port4(p);
                }
                self.freed_ports.clear();
            }
            if self.pool_enable_v6 {
                self.freed_ports.clear();
                swept6 += sweep_family(
                    &mut self.ob_map6,
                    &mut self.ib_map6,
                    &mut self.expired_v6,
                    &mut self.orphan_ports,
                    &mut self.freed_ports,
                    now,
                    timeout,
                );
                self.freed_ports.sort_unstable();
                self.freed_ports.dedup();
                for i in 0..self.freed_ports.len() {
                    let p = self.freed_ports[i];
                    self.release_port6(p);
                }
                self.freed_ports.clear();
            }
            self.rebuild_heaps(timeout);
        }

        self.rebuild_port_queues();
        (swept4, swept6, has_backlog)
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
            frag_epoch: 0,
        };
        let _ = self.set_config(empty_cfg);
    }
}

#[cfg(test)]
mod port_parser_tests {
    use super::{ExpiryStep, expiry_step, parse_proc_udp_ports, reserved_delta};

    #[test]
    fn reserved_delta_tracks_started_and_stopped_services() {
        let previous = [53, 5353, 51820];
        let current = [53, 51820, 60000];
        let (added, removed) = reserved_delta(&previous, &current);
        assert_eq!(added, vec![60000]);
        assert_eq!(removed, vec![5353]);
    }

    #[test]
    fn expiry_step_treats_zero_as_a_valid_timestamp() {
        let cases = [
            (10, 120, Some(0), ExpiryStep::Keep { deadline: 120 }),
            (0, 120, Some(0), ExpiryStep::Keep { deadline: 120 }),
            (130, 120, Some(0), ExpiryStep::Drop),
            (200, 120, Some(100), ExpiryStep::Keep { deadline: 220 }),
            (230, 120, Some(100), ExpiryStep::Drop),
            (10, 120, None, ExpiryStep::Drop),
        ];
        for (now, timeout, seen, want) in cases {
            assert_eq!(expiry_step(now, timeout, seen), want);
        }
    }

    #[test]
    fn parses_listening_and_skips_connected() {
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n 0: 00000000:1450 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n 1: 0100007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n 2: 0100007F:C000 0100007F:0035 01 00000000:00000000 00:00000000 00000000  0 0 1 1\n";
        let ports = parse_proc_udp_ports(text);
        assert!(ports.contains(&0x1450));
        assert!(ports.contains(&0x35));
        assert!(!ports.contains(&0xC000));
    }

    #[test]
    fn test_scan_local_udp_ports_procfs_fallback() {
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_proc_net_udp");
        let content = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n 0: 00000000:1450 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n";
        let _ = std::fs::write(&temp_file, content);
        // Valid file parsed correctly via parse_proc_udp_ports
        let text = std::fs::read_to_string(&temp_file).unwrap();
        let ports = parse_proc_udp_ports(&text);
        assert_eq!(ports, vec![0x1450]);
        let _ = std::fs::remove_file(&temp_file);
    }
}
