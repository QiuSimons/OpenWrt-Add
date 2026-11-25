use aya::maps::{Array, HashMap, IterableMap, MapData, RingBuf};
use flowcone_common::{
    BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, FragKey4, FragKey6, FragValue4,
    FragValue6, GlobalConfig, MAX_BINDINGS, SessionEvent4, SessionEvent6,
};
use rustix::fd::{AsFd, BorrowedFd, OwnedFd};
use rustix::mm::{MapFlags, ProtFlags};
use rustix::net::RecvFlags;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

/// Userspace atomic view of a BPF_F_MMAPABLE array map.
pub struct AtomicBitmap {
    mmap_ptr: *mut AtomicU64,
    len: usize,
    mmap_byte_len: usize,
    _array: Array<MapData, u64>,
}

unsafe impl Send for AtomicBitmap {}
unsafe impl Sync for AtomicBitmap {}

impl AtomicBitmap {
    pub fn new(array: Array<MapData, u64>) -> Result<Self, String> {
        let required = flowcone_common::PORT_BITMAP_SLOTS;
        if array.len() < required {
            return Err(format!(
                "BPF bitmap length {} smaller than required {}",
                array.len(),
                required
            ));
        }
        let len = required as usize;
        let min_bytes = len * std::mem::size_of::<u64>();
        let page_sz = rustix::param::page_size();
        let mmap_byte_len = (min_bytes + page_sz - 1) & !(page_sz - 1);
        let map_data = array.map();
        let map_fd = map_data.fd();
        let mmap_ptr = unsafe {
            rustix::mm::mmap(
                std::ptr::null_mut(),
                mmap_byte_len,
                ProtFlags::READ | ProtFlags::WRITE,
                MapFlags::SHARED,
                map_fd.as_fd(),
                0,
            )
            .map_err(|e| format!("failed to mmap BPF bitmap: {e:?}"))? as *mut AtomicU64
        };
        Ok(Self {
            mmap_ptr,
            len,
            mmap_byte_len,
            _array: array,
        })
    }

    #[inline(always)]
    pub fn fetch_and(&self, slot: u32, mask: u64, order: Ordering) -> u64 {
        assert!(
            (slot as usize) < self.len,
            "AtomicBitmap: slot {slot} out of bounds"
        );
        unsafe {
            let elem = &*self.mmap_ptr.add(slot as usize);
            elem.fetch_and(mask, order)
        }
    }

    #[inline(always)]
    pub fn fetch_or(&self, slot: u32, mask: u64, order: Ordering) -> u64 {
        assert!(
            (slot as usize) < self.len,
            "AtomicBitmap: slot {slot} out of bounds"
        );
        unsafe {
            let elem = &*self.mmap_ptr.add(slot as usize);
            elem.fetch_or(mask, order)
        }
    }

    #[inline(always)]
    pub fn store(&self, slot: u32, val: u64, order: Ordering) {
        assert!(
            (slot as usize) < self.len,
            "AtomicBitmap: slot {slot} out of bounds"
        );
        unsafe {
            let elem = &*self.mmap_ptr.add(slot as usize);
            elem.store(val, order);
        }
    }

    #[inline(always)]
    pub fn load(&self, slot: u32, order: Ordering) -> u64 {
        assert!(
            (slot as usize) < self.len,
            "AtomicBitmap: slot {slot} out of bounds"
        );
        unsafe {
            let elem = &*self.mmap_ptr.add(slot as usize);
            elem.load(order)
        }
    }
}

impl Drop for AtomicBitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = rustix::mm::munmap(self.mmap_ptr as *mut _, self.mmap_byte_len);
        }
    }
}

type Expiry4 = Reverse<(u32, EndpointKey4, u16)>;
type Expiry6 = Reverse<(u32, EndpointKey6, u16)>;

const GC_QUEUE_DRAIN_MAX: usize = 32768;
const GC_EXPIRY_MAX_PER_TICK: usize = 1024;

const AF_INET: u8 = 2;
const AF_INET6: u8 = 10;
const NETLINK_INET_DIAG: u32 = 4;
const SOCK_DIAG_BY_FAMILY: u16 = 20;
const NLM_F_REQUEST: u16 = 0x0001;
const NLM_F_DUMP: u16 = 0x0300;
const NLMSG_HDRLEN: usize = 16;
const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;

/// Reusable `NETLINK_INET_DIAG` scanner with per-family fallback to
/// `/proc/net/udp*`.
pub struct LocalUdpScanner {
    sock: Option<OwnedFd>,
    buf: Vec<u8>,
    seq: u32,
    disabled_v4: bool,
    disabled_v6: bool,
}

impl Default for LocalUdpScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalUdpScanner {
    pub fn new() -> Self {
        Self {
            sock: None,
            buf: vec![0u8; 32768],
            seq: 0,
            disabled_v4: false,
            disabled_v6: false,
        }
    }

    fn is_disabled(&self, family: u8) -> bool {
        match family {
            AF_INET => self.disabled_v4,
            AF_INET6 => self.disabled_v6,
            _ => true,
        }
    }

    fn mark_disabled(&mut self, family: u8) {
        match family {
            AF_INET => self.disabled_v4 = true,
            AF_INET6 => self.disabled_v6 = true,
            _ => {}
        }
    }

    fn ensure_socket(&mut self) -> Option<&OwnedFd> {
        if self.sock.is_none() {
            use rustix::io::Errno;
            use rustix::net::{AddressFamily, Protocol, SocketFlags, SocketType, socket_with};
            use std::num::NonZeroU32;
            use std::time::Duration;

            let proto = Protocol::from_raw(NonZeroU32::new(NETLINK_INET_DIAG)?);
            let sock = match socket_with(
                AddressFamily::NETLINK,
                SocketType::RAW,
                SocketFlags::CLOEXEC,
                Some(proto),
            ) {
                Ok(s) => s,
                Err(e) => {
                    if matches!(
                        e,
                        Errno::PROTONOSUPPORT | Errno::AFNOSUPPORT | Errno::OPNOTSUPP
                    ) {
                        self.disabled_v4 = true;
                        self.disabled_v6 = true;
                    }
                    return None;
                }
            };

            let _ = rustix::net::sockopt::set_socket_timeout(
                &sock,
                rustix::net::sockopt::Timeout::Recv,
                Some(Duration::from_millis(100)),
            );
            self.sock = Some(sock);
        }
        self.sock.as_ref()
    }

    /// Queries listening and connected UDP ports via `NETLINK_INET_DIAG`.
    pub fn scan_netlink_udp_ports(&mut self, family: u8) -> Option<Vec<u16>> {
        use rustix::io::Errno;
        use rustix::net::{SendFlags, send};

        if self.is_disabled(family) {
            return None;
        }
        let seq = self.seq.wrapping_add(1).max(1);
        self.seq = seq;

        let sock = self.ensure_socket()?;

        // 72-byte netlink dump request: 16-byte nlmsghdr + 56-byte
        // inet_diag_req_v2.
        let mut req = [0u8; 72];
        req[0..4].copy_from_slice(&(72u32).to_ne_bytes());
        req[4..6].copy_from_slice(&SOCK_DIAG_BY_FAMILY.to_ne_bytes());
        req[6..8].copy_from_slice(&(NLM_F_REQUEST | NLM_F_DUMP).to_ne_bytes());
        req[8..12].copy_from_slice(&seq.to_ne_bytes());
        req[16] = family;
        req[17] = 17; // IPPROTO_UDP
        req[20..24].copy_from_slice(&((1u32 << 1) | (1u32 << 7)).to_ne_bytes()); // TCP_ESTABLISHED | TCP_CLOSE

        loop {
            match send(sock, &req, SendFlags::empty()) {
                Ok(_) => break,
                Err(Errno::INTR) => continue,
                Err(_) => {
                    self.sock = None;
                    return None;
                }
            }
        }

        let mut ports = Vec::new();
        let mut done = false;
        'recv_loop: loop {
            let sock = self.sock.as_ref()?;
            let Ok(n) = crate::netlink::recv_netlink_msg(sock, &mut self.buf, RecvFlags::empty())
            else {
                // Drop socket after interrupted/timed-out dump so stale frames
                // cannot leak into the next call.
                self.sock = None;
                return None;
            };
            if n == 0 {
                break;
            }
            let mut offset = 0;
            while offset + NLMSG_HDRLEN <= n {
                let nlmsg_len =
                    u32::from_ne_bytes(self.buf[offset..offset + 4].try_into().unwrap()) as usize;
                let nlmsg_type =
                    u16::from_ne_bytes(self.buf[offset + 4..offset + 6].try_into().unwrap());
                let nlmsg_seq =
                    u32::from_ne_bytes(self.buf[offset + 8..offset + 12].try_into().unwrap());
                if nlmsg_len < NLMSG_HDRLEN || offset + nlmsg_len > n {
                    break;
                }
                if nlmsg_seq == seq {
                    if nlmsg_type == NLMSG_ERROR {
                        if nlmsg_len >= NLMSG_HDRLEN + 4 {
                            let err = i32::from_ne_bytes(
                                self.buf[offset + NLMSG_HDRLEN..offset + NLMSG_HDRLEN + 4]
                                    .try_into()
                                    .unwrap(),
                            );
                            if err != 0 {
                                let err = rustix::io::Errno::from_raw_os_error(-err);
                                if matches!(
                                    err,
                                    rustix::io::Errno::OPNOTSUPP
                                        | rustix::io::Errno::NOENT
                                        | rustix::io::Errno::AFNOSUPPORT
                                        | rustix::io::Errno::PROTONOSUPPORT
                                ) {
                                    self.mark_disabled(family);
                                }
                                return None;
                            }
                        } else {
                            return None;
                        }
                    } else if nlmsg_type == NLMSG_DONE {
                        done = true;
                        break 'recv_loop;
                    } else if nlmsg_type == SOCK_DIAG_BY_FAMILY {
                        let payload = &self.buf[offset + NLMSG_HDRLEN..offset + nlmsg_len];
                        if payload.len() >= 72 && (payload[1] == 1 || payload[1] == 7) {
                            let sport = u16::from_be_bytes([payload[4], payload[5]]);
                            if sport != 0 {
                                ports.push(sport);
                            }
                        }
                    }
                }
                offset += (nlmsg_len + 3) & !3;
            }
        }

        if done { Some(ports) } else { None }
    }

    /// Parses local UDP service ports from `NETLINK_INET_DIAG` with procfs
    /// fallback.
    pub fn scan_local_udp_ports(&mut self, family: u8, procfs_path: &str) -> Option<Vec<u16>> {
        if let Some(mut ports) = self.scan_netlink_udp_ports(family) {
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
}

/// Extracts local UDP ports in listening (07) and connected (01) states from
/// procfs.
fn parse_proc_udp_ports(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let mut it = line.split_whitespace();
        let _sl = it.next();
        let Some(local) = it.next() else { continue };
        let Some(_remote) = it.next() else { continue };
        let Some(state) = it.next() else { continue };
        if state != "01" && state != "07" {
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

enum FamilyBitmap {
    Active(AtomicBitmap),
    /// Keeps disabled-family BPF map FDs alive while eBPF programs load and
    /// execute.
    Disabled {
        _array: Array<MapData, u64>,
    },
}

impl FamilyBitmap {
    fn new(array: Array<MapData, u64>, enabled: bool) -> Result<Self, String> {
        if enabled {
            AtomicBitmap::new(array).map(Self::Active)
        } else {
            Ok(Self::Disabled { _array: array })
        }
    }

    fn as_mut(&mut self) -> Option<&mut AtomicBitmap> {
        match self {
            Self::Active(bitmap) => Some(bitmap),
            Self::Disabled { .. } => None,
        }
    }
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
    reserved4: Array<MapData, u16>,
    reserved6: Array<MapData, u16>,
    bitmap_even4: FamilyBitmap,
    bitmap_odd4: FamilyBitmap,
    bitmap_even6: FamilyBitmap,
    bitmap_odd6: FamilyBitmap,
    port_flags: Array<MapData, u32>,
    pool_enable_v4: bool,
    pool_enable_v6: bool,
    min_port: u16,
    max_port: u16,
    freed_ports: Vec<u16>,
    // Expiry scheduler min-heaps, grown lazily on active sessions.
    heap4: BinaryHeap<Expiry4>,
    heap6: BinaryHeap<Expiry6>,
    expired_v4: Vec<(EndpointKey4, u16)>,
    expired_v6: Vec<(EndpointKey6, u16)>,
    orphan_ports: Vec<u16>,
    reserved4_ports: Vec<u16>,
    reserved6_ports: Vec<u16>,
    lost_notifications: bool,
}

fn clear_map<K: aya::Pod, V: aya::Pod>(map: &mut HashMap<MapData, K, V>) {
    let keys: Vec<K> = map.keys().filter_map(|r| r.ok()).collect();
    for key in keys {
        let _ = map.remove(&key);
    }
}

trait ConeBinding: aya::Pod + Copy {
    type Key: aya::Pod + Copy + PartialEq + Ord;
    fn port_be(&self) -> u16;
    fn last_seen(&self) -> u32;
    fn make_key(&self) -> Self::Key;
    fn matches_key(&self, key: &Self::Key) -> bool;
    fn is_short_lived(&self) -> bool;
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

    #[inline(always)]
    fn is_short_lived(&self) -> bool {
        self.is_short_lived()
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
            _pad: 0,
        }
    }

    fn matches_key(&self, key: &EndpointKey6) -> bool {
        self.ip == key.ip && self.port == key.port
    }

    #[inline(always)]
    fn is_short_lived(&self) -> bool {
        self.is_short_lived()
    }
}

#[inline(always)]
fn item_timeout_for<V: ConeBinding>(val: &V, timeout: u32) -> u32 {
    if val.is_short_lived() {
        flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
    } else {
        timeout
    }
}

/// Reconciles bindings and sweeps expired entries when ring buffer overflows.
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
        let item_timeout = item_timeout_for(&val, timeout);
        if now.saturating_sub(val.last_seen()) <= item_timeout {
            continue;
        }
        let port_host = u16::from_be(val.port_be());
        let ib_last = match ib_map.get(&port_host, 0) {
            Ok(iv) if iv.matches_key(&key) => iv.last_seen(),
            _ => 0,
        };
        if now.saturating_sub(ib_last) > item_timeout {
            expired_buf.push((key, port_host));
        }
    }

    let mut swept = 0;
    for &(key, port_host) in expired_buf.iter() {
        // Revalidate against datapath refresh.
        if let Ok(cur_val) = ob_map.get(&key, 0) {
            if u16::from_be(cur_val.port_be()) != port_host {
                if let Ok(iv) = ib_map.get(&port_host, 0)
                    && iv.matches_key(&key)
                    && now.saturating_sub(iv.last_seen()) > item_timeout_for(&iv, timeout)
                    && ib_map.remove(&port_host).is_ok()
                {
                    freed_ports.push(port_host);
                    swept += 1;
                }
                continue;
            }
            let item_timeout = item_timeout_for(&cur_val, timeout);
            let cur_ib = ib_map.get(&port_host, 0);
            let cur_ib_matches = matches!(&cur_ib, Ok(iv) if iv.matches_key(&key));
            let cur_ib_last = if cur_ib_matches && let Ok(iv) = &cur_ib {
                iv.last_seen()
            } else {
                0
            };
            if now.saturating_sub(cur_val.last_seen().max(cur_ib_last)) <= item_timeout {
                continue;
            }
            let _ = ob_map.remove(&key);
            if (cur_ib_matches && ib_map.remove(&port_host).is_ok())
                || ib_map.get(&port_host, 0).is_err()
            {
                freed_ports.push(port_host);
                swept += 1;
            }
            continue;
        }
        if let Ok(iv) = ib_map.get(&port_host, 0)
            && iv.matches_key(&key)
            && now.saturating_sub(iv.last_seen()) > item_timeout_for(&iv, timeout)
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
    pub reserved4: Array<MapData, u16>,
    pub reserved6: Array<MapData, u16>,
    pub bitmap_even4: Array<MapData, u64>,
    pub bitmap_odd4: Array<MapData, u64>,
    pub bitmap_even6: Array<MapData, u64>,
    pub bitmap_odd6: Array<MapData, u64>,
    pub port_flags: Array<MapData, u32>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ExpiryStep {
    Keep { deadline: u32 },
    Drop,
}

#[cfg_attr(not(test), allow(dead_code))]
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
    min_port: u16,
    max_port: u16,
    bitmap_even: &'a mut AtomicBitmap,
    bitmap_odd: &'a mut AtomicBitmap,
    reserved_ports: &'a [u16],
}

struct FamilyGcState<'a, V: ConeBinding> {
    ob_map: &'a mut HashMap<MapData, V::Key, V>,
    ib_map: &'a mut HashMap<MapData, u16, V>,
    heap: &'a mut BinaryHeap<Reverse<(u32, V::Key, u16)>>,
    lost_notifications: &'a mut bool,
    pool: FamilyPortPool<'a>,
}

fn schedule_family<K: Ord>(
    heap: &mut BinaryHeap<Reverse<(u32, K, u16)>>,
    lost: &mut bool,
    deadline: u32,
    key: K,
    port: u16,
) {
    if heap.len() < (MAX_BINDINGS as usize) * 2 {
        heap.push(Reverse((deadline, key, port)));
    } else {
        *lost = true;
    }
}

impl SessionManager {
    pub fn new(maps: SessionMaps, enable_v4: bool, enable_v6: bool) -> Result<Self, String> {
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
            reserved4,
            reserved6,
            bitmap_even4,
            bitmap_odd4,
            bitmap_even6,
            bitmap_odd6,
            port_flags,
        } = maps;
        Ok(Self {
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
            reserved4,
            reserved6,
            bitmap_even4: FamilyBitmap::new(bitmap_even4, enable_v4)?,
            bitmap_odd4: FamilyBitmap::new(bitmap_odd4, enable_v4)?,
            bitmap_even6: FamilyBitmap::new(bitmap_even6, enable_v6)?,
            bitmap_odd6: FamilyBitmap::new(bitmap_odd6, enable_v6)?,
            port_flags,
            pool_enable_v4: enable_v4,
            pool_enable_v6: enable_v6,
            min_port: 0,
            max_port: 0,
            freed_ports: Vec::new(),
            heap4: BinaryHeap::new(),
            heap6: BinaryHeap::new(),
            expired_v4: Vec::new(),
            expired_v6: Vec::new(),
            orphan_ports: Vec::new(),
            reserved4_ports: Vec::new(),
            reserved6_ports: Vec::new(),
            lost_notifications: false,
        })
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

    fn sync_family_reserved<V: aya::Pod>(
        reserved_ports: &mut Vec<u16>,
        current: &[u16],
        reserved_map: &mut Array<MapData, u16>,
        ib_map: &mut HashMap<MapData, u16, V>,
        pool: &mut FamilyPortPool<'_>,
    ) {
        let (added, removed) = reserved_delta(reserved_ports, current);
        if added.is_empty() && removed.is_empty() {
            return;
        }
        for port in &added {
            let idx = *port as u32;
            let cur_state = reserved_map.get(&idx, 0).unwrap_or(0);
            let next_state = flowcone_common::reserved_state_next_added(cur_state);
            let _ = reserved_map.set(idx, &next_state, 0);
            let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(*port);
            let map = if is_even {
                &mut *pool.bitmap_even
            } else {
                &mut *pool.bitmap_odd
            };
            map.fetch_or(slot, mask, Ordering::Relaxed);
            let _ = ib_map.remove(port);
        }
        for port in &removed {
            // Drain any stale inbound entry before advancing to the unreserved
            // epoch.
            let _ = ib_map.remove(port);
            let idx = *port as u32;
            let cur_state = reserved_map.get(&idx, 0).unwrap_or(0);
            let next_state = flowcone_common::reserved_state_next_removed(cur_state);
            let _ = reserved_map.set(idx, &next_state, 0);
            if *port >= pool.min_port && *port <= pool.max_port && ib_map.get(port, 0).is_err() {
                Self::release_family_port(*port, pool);
            }
        }
        *reserved_ports = current.to_vec();
    }

    /// Applies updated local listening UDP ports to reserved maps.
    pub fn apply_reserved_ports(&mut self, ports4: Option<&[u16]>, ports6: Option<&[u16]>) {
        if self.pool_enable_v4
            && let Some(ports) = ports4
            && let (Some(even), Some(odd)) = (self.bitmap_even4.as_mut(), self.bitmap_odd4.as_mut())
        {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: ports,
            };
            Self::sync_family_reserved(
                &mut self.reserved4_ports,
                ports,
                &mut self.reserved4,
                &mut self.ib_map4,
                &mut pool,
            );
        }
        if self.pool_enable_v6
            && let Some(ports) = ports6
            && let (Some(even), Some(odd)) = (self.bitmap_even6.as_mut(), self.bitmap_odd6.as_mut())
        {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: ports,
            };
            Self::sync_family_reserved(
                &mut self.reserved6_ports,
                ports,
                &mut self.reserved6,
                &mut self.ib_map6,
                &mut pool,
            );
        }
    }

    /// Synchronizes reserved local UDP service ports using a reusable scanner.
    pub fn reserve_local_ports(&mut self, scanner: &mut LocalUdpScanner) {
        let p4 = if self.pool_enable_v4 {
            scanner.scan_local_udp_ports(AF_INET, "/proc/net/udp")
        } else {
            None
        };
        let p6 = if self.pool_enable_v6 {
            scanner.scan_local_udp_ports(AF_INET6, "/proc/net/udp6")
        } else {
            None
        };
        self.apply_reserved_ports(p4.as_deref(), p6.as_deref());
    }

    fn init_family_pool(pool: &mut FamilyPortPool<'_>) {
        let mut even_slots = [!0u64; flowcone_common::PORT_BITMAP_SLOTS as usize];
        let mut odd_slots = [!0u64; flowcone_common::PORT_BITMAP_SLOTS as usize];

        let mut p = pool.min_port;
        while p <= pool.max_port {
            if pool.reserved_ports.binary_search(&p).is_err() {
                let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(p);
                if is_even {
                    even_slots[slot as usize] &= !mask;
                } else {
                    odd_slots[slot as usize] &= !mask;
                }
            }
            if p == pool.max_port {
                break;
            }
            p += 1;
        }

        for (slot, &val) in even_slots.iter().enumerate() {
            pool.bitmap_even.store(slot as u32, val, Ordering::Relaxed);
        }
        for (slot, &val) in odd_slots.iter().enumerate() {
            pool.bitmap_odd.store(slot as u32, val, Ordering::Relaxed);
        }
    }

    pub fn init_port_pool(&mut self, enable_v4: bool, enable_v6: bool) {
        self.pool_enable_v4 = enable_v4;
        self.pool_enable_v6 = enable_v6;
        if !self.pool_ready() {
            return;
        }
        if enable_v4 {
            self.init_family4_pool();
        }
        if enable_v6 {
            self.init_family6_pool();
        }
    }

    pub fn init_family4_pool(&mut self) {
        if !self.pool_enable_v4 || !self.pool_ready() {
            return;
        }
        if let (Some(even), Some(odd)) = (self.bitmap_even4.as_mut(), self.bitmap_odd4.as_mut()) {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: &self.reserved4_ports,
            };
            Self::init_family_pool(&mut pool);
        }
    }

    pub fn init_family6_pool(&mut self) {
        if !self.pool_enable_v6 || !self.pool_ready() {
            return;
        }
        if let (Some(even), Some(odd)) = (self.bitmap_even6.as_mut(), self.bitmap_odd6.as_mut()) {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: &self.reserved6_ports,
            };
            Self::init_family_pool(&mut pool);
        }
    }

    fn release_family_port(port: u16, pool: &mut FamilyPortPool<'_>) {
        if port < pool.min_port || port > pool.max_port {
            return;
        }
        let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(port);
        let map = if is_even {
            &mut *pool.bitmap_even
        } else {
            &mut *pool.bitmap_odd
        };
        if pool.reserved_ports.binary_search(&port).is_ok() {
            map.fetch_or(slot, mask, Ordering::Relaxed);
            return;
        }
        map.fetch_and(slot, !mask, Ordering::Relaxed);
    }

    fn release_port4(&mut self, port: u16) {
        if let (Some(even), Some(odd)) = (self.bitmap_even4.as_mut(), self.bitmap_odd4.as_mut()) {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: &self.reserved4_ports,
            };
            Self::release_family_port(port, &mut pool);
        }
    }

    fn release_port6(&mut self, port: u16) {
        if let (Some(even), Some(odd)) = (self.bitmap_even6.as_mut(), self.bitmap_odd6.as_mut()) {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: &self.reserved6_ports,
            };
            Self::release_family_port(port, &mut pool);
        }
    }

    fn reconcile_family_ports<V: ConeBinding>(
        ib_map: &HashMap<MapData, u16, V>,
        pool: &mut FamilyPortPool<'_>,
    ) {
        let mut active_ports = HashSet::new();
        for key in ib_map.keys().flatten() {
            if key >= pool.min_port && key <= pool.max_port {
                active_ports.insert(key);
                let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(key);
                let map = if is_even {
                    &mut *pool.bitmap_even
                } else {
                    &mut *pool.bitmap_odd
                };
                map.fetch_or(slot, mask, Ordering::Relaxed);
            }
        }

        for port in pool.reserved_ports {
            let (is_even, slot, mask) = flowcone_common::port_to_bitmap_coords(*port);
            let map = if is_even {
                &mut *pool.bitmap_even
            } else {
                &mut *pool.bitmap_odd
            };
            map.fetch_or(slot, mask, Ordering::Relaxed);
        }

        for parity in [true, false] {
            let map = if parity {
                &mut *pool.bitmap_even
            } else {
                &mut *pool.bitmap_odd
            };
            for slot in 0..flowcone_common::PORT_BITMAP_SLOTS {
                let cur = map.load(slot, Ordering::Relaxed);
                if cur == 0 {
                    continue;
                }
                let mut orphan_mask = 0u64;
                for bit in 0..64 {
                    let mask = 1u64 << bit;
                    if (cur & mask) != 0 {
                        let port = flowcone_common::bitmap_coords_to_port(parity, slot, bit);
                        if port >= pool.min_port
                            && port <= pool.max_port
                            && pool.reserved_ports.binary_search(&port).is_err()
                            && !active_ports.contains(&port)
                            && ib_map.get(&port, 0).is_err()
                        {
                            orphan_mask |= mask;
                        }
                    }
                }
                if orphan_mask != 0 {
                    // Pre-verify that no concurrent datapath allocation
                    // occurred before clearing.
                    let mut confirmed_orphan_mask = 0u64;
                    for bit in 0..64 {
                        let mask = 1u64 << bit;
                        if (orphan_mask & mask) != 0 {
                            let port = flowcone_common::bitmap_coords_to_port(parity, slot, bit);
                            if ib_map.get(&port, 0).is_err() {
                                confirmed_orphan_mask |= mask;
                            }
                        }
                    }
                    if confirmed_orphan_mask != 0 {
                        map.fetch_and(slot, !confirmed_orphan_mask, Ordering::Relaxed);
                    }
                }
            }
        }
    }

    fn rebuild_family4(&mut self) {
        if !self.pool_enable_v4 || !self.pool_ready() {
            return;
        }
        if let (Some(even), Some(odd)) = (self.bitmap_even4.as_mut(), self.bitmap_odd4.as_mut()) {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: &self.reserved4_ports,
            };
            Self::reconcile_family_ports(&self.ib_map4, &mut pool);
        }
    }

    fn rebuild_family6(&mut self) {
        if !self.pool_enable_v6 || !self.pool_ready() {
            return;
        }
        if let (Some(even), Some(odd)) = (self.bitmap_even6.as_mut(), self.bitmap_odd6.as_mut()) {
            let mut pool = FamilyPortPool {
                min_port: self.min_port,
                max_port: self.max_port,
                bitmap_even: even,
                bitmap_odd: odd,
                reserved_ports: &self.reserved6_ports,
            };
            Self::reconcile_family_ports(&self.ib_map6, &mut pool);
        }
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

    pub fn clear_v4_mappings(&mut self, clear_frag: bool) {
        clear_map(&mut self.ob_map4);
        clear_map(&mut self.ib_map4);
        if clear_frag {
            clear_map(&mut self.frag_in4);
            clear_map(&mut self.frag_out4);
        }
        self.heap4.clear();
        while self.events4.next().is_some() {}
        self.init_family4_pool();
    }

    pub fn clear_v6_mappings(&mut self, clear_frag: bool) {
        clear_map(&mut self.ob_map6);
        clear_map(&mut self.ib_map6);
        if clear_frag {
            clear_map(&mut self.frag_in6);
            clear_map(&mut self.frag_out6);
        }
        self.heap6.clear();
        while self.events6.next().is_some() {}
        self.init_family6_pool();
    }

    pub fn event_fds(&self) -> (BorrowedFd<'_>, BorrowedFd<'_>) {
        (self.events4.as_fd(), self.events6.as_fd())
    }

    pub fn drain_events(&mut self, now: u32, timeout: u32) -> usize {
        let mut drained = 0;
        let mut need_rebuild = false;
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
                    drained += 1;
                    if ev.port != 0 {
                        let ev_timeout = if ev.is_short_lived() {
                            flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                        } else {
                            timeout
                        };
                        schedule_family(
                            &mut self.heap4,
                            &mut self.lost_notifications,
                            now.saturating_add(ev_timeout),
                            ev.key,
                            ev.port,
                        );
                    } else {
                        need_rebuild = true;
                    }
                }
            }
        } else {
            while self.events4.next().is_some() {}
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
                    drained += 1;
                    if ev.port != 0 {
                        let ev_timeout = if ev.is_short_lived() {
                            flowcone_common::DEFAULT_SHORT_LIVED_TIMEOUT_SEC
                        } else {
                            timeout
                        };
                        schedule_family(
                            &mut self.heap6,
                            &mut self.lost_notifications,
                            now.saturating_add(ev_timeout),
                            ev.key,
                            ev.port,
                        );
                    } else {
                        need_rebuild = true;
                    }
                }
            }
        } else {
            while self.events6.next().is_some() {}
        }
        if need_rebuild {
            self.rebuild_port_queues();
        }
        drained
    }

    fn expiry_tick_family<V: ConeBinding>(
        state: &mut FamilyGcState<'_, V>,
        now: u32,
        timeout: u32,
    ) -> (usize, bool) {
        let mut swept = 0;
        let mut processed = 0;

        while processed < GC_EXPIRY_MAX_PER_TICK {
            let Some(Reverse((deadline, key, port))) = state.heap.peek().copied() else {
                break;
            };
            if deadline >= now {
                break;
            }
            state.heap.pop();

            if let Ok(val) = state.ob_map.get(&key, 0)
                && u16::from_be(val.port_be()) == port
            {
                let item_timeout = item_timeout_for(&val, timeout);
                if now.saturating_sub(val.last_seen()) <= item_timeout {
                    schedule_family(
                        state.heap,
                        state.lost_notifications,
                        val.last_seen().saturating_add(item_timeout),
                        key,
                        port,
                    );
                    processed += 1;
                    continue;
                }

                // Outbound expired; check inbound once before deletion (RFC
                // 4787).
                if let Ok(iv) = state.ib_map.get(&port, 0)
                    && iv.matches_key(&key)
                    && now.saturating_sub(iv.last_seen()) <= item_timeout
                {
                    schedule_family(
                        state.heap,
                        state.lost_notifications,
                        iv.last_seen().saturating_add(item_timeout),
                        key,
                        port,
                    );
                    processed += 1;
                    continue;
                }

                // Revalidate against datapath refresh once right before
                // removal.
                let cur_ob = state.ob_map.get(&key, 0);
                if let Ok(c) = &cur_ob {
                    if u16::from_be(c.port_be()) != port {
                        if let Ok(iv) = state.ib_map.get(&port, 0)
                            && iv.matches_key(&key)
                        {
                            let ib_timeout = item_timeout_for(&iv, timeout);
                            if now.saturating_sub(iv.last_seen()) > ib_timeout {
                                if state.ib_map.remove(&port).is_ok() {
                                    Self::release_family_port(port, &mut state.pool);
                                    swept += 1;
                                }
                            } else {
                                schedule_family(
                                    state.heap,
                                    state.lost_notifications,
                                    iv.last_seen().saturating_add(ib_timeout),
                                    key,
                                    port,
                                );
                            }
                        }
                        processed += 1;
                        continue;
                    }
                    let c_timeout = item_timeout_for(c, timeout);
                    if now.saturating_sub(c.last_seen()) <= c_timeout {
                        schedule_family(
                            state.heap,
                            state.lost_notifications,
                            c.last_seen().saturating_add(c_timeout),
                            key,
                            port,
                        );
                        processed += 1;
                        continue;
                    }
                }

                let cur_ib = state.ib_map.get(&port, 0);
                if let Ok(iv) = &cur_ib
                    && iv.matches_key(&key)
                {
                    let ib_timeout = item_timeout_for(iv, timeout);
                    if now.saturating_sub(iv.last_seen()) <= ib_timeout {
                        schedule_family(
                            state.heap,
                            state.lost_notifications,
                            iv.last_seen().saturating_add(ib_timeout),
                            key,
                            port,
                        );
                        processed += 1;
                        continue;
                    }
                }

                let ob_still_matches =
                    matches!(&cur_ob, Ok(c) if u16::from_be(c.port_be()) == port);
                let ib_still_matches = matches!(&cur_ib, Ok(iv) if iv.matches_key(&key));
                let ob_removed = ob_still_matches && state.ob_map.remove(&key).is_ok();
                let ib_removed = ib_still_matches && state.ib_map.remove(&port).is_ok();
                if ib_removed || (ob_removed && state.ib_map.get(&port, 0).is_err()) {
                    Self::release_family_port(port, &mut state.pool);
                    swept += 1;
                }
            } else if let Ok(iv) = state.ib_map.get(&port, 0)
                && iv.matches_key(&key)
            {
                let item_timeout = item_timeout_for(&iv, timeout);
                if now.saturating_sub(iv.last_seen()) <= item_timeout {
                    schedule_family(
                        state.heap,
                        state.lost_notifications,
                        iv.last_seen().saturating_add(item_timeout),
                        key,
                        port,
                    );
                } else if matches!(
                    state.ib_map.get(&port, 0),
                    Ok(cur) if cur.matches_key(&key)
                        && now.saturating_sub(cur.last_seen()) > item_timeout_for(&cur, timeout)
                ) && state.ib_map.remove(&port).is_ok()
                {
                    Self::release_family_port(port, &mut state.pool);
                    swept += 1;
                }
            }

            processed += 1;
        }

        let backlog = processed == GC_EXPIRY_MAX_PER_TICK
            && state.heap.peek().is_some_and(|Reverse((d, ..))| *d < now);
        (swept, backlog)
    }

    fn expiry_tick(&mut self, now: u32, timeout: u32) -> (usize, usize, bool) {
        let mut swept4 = 0;
        let mut swept6 = 0;
        let mut backlog4 = false;
        let mut backlog6 = false;

        if self.pool_enable_v4
            && let (Some(even), Some(odd)) = (self.bitmap_even4.as_mut(), self.bitmap_odd4.as_mut())
        {
            let mut state = FamilyGcState {
                ob_map: &mut self.ob_map4,
                ib_map: &mut self.ib_map4,
                heap: &mut self.heap4,
                lost_notifications: &mut self.lost_notifications,
                pool: FamilyPortPool {
                    min_port: self.min_port,
                    max_port: self.max_port,
                    bitmap_even: even,
                    bitmap_odd: odd,
                    reserved_ports: &self.reserved4_ports,
                },
            };
            (swept4, backlog4) = Self::expiry_tick_family(&mut state, now, timeout);
        }

        if self.pool_enable_v6
            && let (Some(even), Some(odd)) = (self.bitmap_even6.as_mut(), self.bitmap_odd6.as_mut())
        {
            let mut state = FamilyGcState {
                ob_map: &mut self.ob_map6,
                ib_map: &mut self.ib_map6,
                heap: &mut self.heap6,
                lost_notifications: &mut self.lost_notifications,
                pool: FamilyPortPool {
                    min_port: self.min_port,
                    max_port: self.max_port,
                    bitmap_even: even,
                    bitmap_odd: odd,
                    reserved_ports: &self.reserved6_ports,
                },
            };
            (swept6, backlog6) = Self::expiry_tick_family(&mut state, now, timeout);
        }

        (swept4, swept6, backlog4 || backlog6)
    }

    fn rebuild_heap_family<V: ConeBinding>(
        heap: &mut BinaryHeap<Reverse<(u32, V::Key, u16)>>,
        ob_map: &HashMap<MapData, V::Key, V>,
        ib_map: &HashMap<MapData, u16, V>,
        timeout: u32,
    ) {
        let mut vec = std::mem::take(heap).into_vec();
        vec.clear();
        for (key, val) in ob_map.iter().flatten() {
            let port = u16::from_be(val.port_be());
            let ib_last = ib_map
                .get(&port, 0)
                .ok()
                .filter(|iv| iv.matches_key(&key))
                .map(|iv| iv.last_seen())
                .unwrap_or(0);
            let item_timeout = item_timeout_for(&val, timeout);
            let deadline = val.last_seen().max(ib_last).saturating_add(item_timeout);
            vec.push(Reverse((deadline, key, port)));
        }
        *heap = BinaryHeap::from(vec);
    }

    fn rebuild_heaps(&mut self, timeout: u32) {
        if self.pool_enable_v4 {
            Self::rebuild_heap_family(&mut self.heap4, &self.ob_map4, &self.ib_map4, timeout);
        } else {
            self.heap4.clear();
        }
        if self.pool_enable_v6 {
            Self::rebuild_heap_family(&mut self.heap6, &self.ob_map6, &self.ib_map6, timeout);
        } else {
            self.heap6.clear();
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
            // Catch events emitted concurrently while scanning tables during
            // heap rebuild.
            self.drain_events(now, timeout);
            if self.pool_enable_v4 {
                self.rebuild_family4();
            }
            if self.pool_enable_v6 {
                self.rebuild_family6();
            }
        }

        self.rebuild_port_queues();
        (swept4, swept6, has_backlog)
    }

    pub fn is_idle(&self) -> bool {
        self.heap4.is_empty() && self.heap6.is_empty()
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
            timeout_sec: 0,
        };
        let _ = self.set_config(empty_cfg);
    }
}

#[cfg(test)]
mod port_parser_tests {
    use super::{ExpiryStep, LocalUdpScanner, expiry_step, parse_proc_udp_ports, reserved_delta};

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
    fn parses_listening_and_connected() {
        let text = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n 0: 00000000:1450 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n 1: 0100007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n 2: 0100007F:C000 0100007F:0035 01 00000000:00000000 00:00000000 00000000  0 0 1 1\n";
        let ports = parse_proc_udp_ports(text);
        assert!(ports.contains(&0x1450));
        assert!(ports.contains(&0x35));
        assert!(ports.contains(&0xC000));
    }

    #[test]
    fn test_scan_local_udp_ports_procfs_fallback() {
        let temp_dir = std::env::temp_dir();
        let temp_file = temp_dir.join("test_proc_net_udp");
        let content = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n 0: 00000000:1450 00000000:0000 07 00000000:00000000 00:00000000 00000000  0 0 1 1\n";
        let _ = std::fs::write(&temp_file, content);
        let text = std::fs::read_to_string(&temp_file).unwrap();
        let ports = parse_proc_udp_ports(&text);
        assert_eq!(ports, vec![0x1450]);
        let _ = std::fs::remove_file(&temp_file);
    }

    #[test]
    fn test_scan_netlink_udp_ports_live() {
        use std::net::UdpSocket;
        let socket = UdpSocket::bind("127.0.0.1:0").expect("bind test socket");
        let port = socket.local_addr().expect("local addr").port();

        let connected_socket = UdpSocket::bind("127.0.0.1:0").expect("bind connected socket");
        connected_socket
            .connect("127.0.0.1:53")
            .expect("connect socket");
        let conn_port = connected_socket.local_addr().expect("local addr").port();

        let mut scanner = LocalUdpScanner::new();
        if let Some(ports) = scanner.scan_netlink_udp_ports(2) {
            assert!(
                ports.contains(&port),
                "netlink should contain bound port {port}, got {ports:?}"
            );
            assert!(
                ports.contains(&conn_port),
                "netlink should contain connected port {conn_port}, got {ports:?}"
            );
        }
    }
}
