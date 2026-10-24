use aya::maps::{Array, HashMap, MapData};
use flowcone_common::{BindingValue4, BindingValue6, EndpointKey4, EndpointKey6, GlobalConfig};

pub struct SessionManager {
    config_map: Array<MapData, GlobalConfig>,
    ob_map4: HashMap<MapData, EndpointKey4, BindingValue4>,
    ib_map4: HashMap<MapData, u16, BindingValue4>,
    bm_map4: Array<MapData, u8>,
    ob_map6: HashMap<MapData, EndpointKey6, BindingValue6>,
    ib_map6: HashMap<MapData, u16, BindingValue6>,
    bm_map6: Array<MapData, u8>,
    // Persistent scratch buffers to avoid heap allocations in GC loop
    expired_v4: Vec<(EndpointKey4, u16)>,
    expired_v6: Vec<(EndpointKey6, u16)>,
    orphan_ports: Vec<u16>,
}

#[inline]
fn clear_family_mappings<K: aya::Pod, V: aya::Pod>(
    ob_map: &mut HashMap<MapData, K, V>,
    ib_map: &mut HashMap<MapData, u16, V>,
    bm_map: &mut Array<MapData, u8>,
) {
    let keys: Vec<K> = ob_map.keys().filter_map(|r| r.ok()).collect();
    for k in keys {
        let _ = ob_map.remove(&k);
    }
    let ports: Vec<u16> = ib_map.keys().filter_map(|r| r.ok()).collect();
    for p in ports {
        let _ = ib_map.remove(&p);
        let _ = bm_map.set(p as u32, 0, 0);
    }
}

trait ConeBinding: aya::Pod + Copy {
    type Key: aya::Pod + Copy + PartialEq;
    fn port_be(&self) -> u16;
    fn last_seen(&self) -> u64;
    fn make_key(&self) -> Self::Key;
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
}

fn sweep_family<V: ConeBinding>(
    ob_map: &mut HashMap<MapData, V::Key, V>,
    ib_map: &mut HashMap<MapData, u16, V>,
    bm_map: &mut Array<MapData, u8>,
    expired_buf: &mut Vec<(V::Key, u16)>,
    orphan_buf: &mut Vec<u16>,
    now_ns: u64,
    timeout_ns: u64,
) -> usize {
    // Find expired outbound bindings. The inbound lookup is only needed for
    // an outbound entry that already looks expired.
    expired_buf.clear();
    for (key, val) in ob_map.iter().flatten() {
        if now_ns.saturating_sub(val.last_seen()) <= timeout_ns {
            continue;
        }
        let port_be = val.port_be();
        let port_host = u16::from_be(port_be);
        let ib_last = ib_map
            .get(&port_host, 0)
            .map(|iv| iv.last_seen())
            .unwrap_or(0);
        if now_ns.saturating_sub(ib_last) > timeout_ns {
            expired_buf.push((key, port_be));
        }
    }

    let mut swept = 0;
    for &(key, port_be) in expired_buf.iter() {
        let port_host = u16::from_be(port_be);

        if let Ok(cur_val) = ob_map.get(&key, 0) {
            let cur_ib_last = ib_map
                .get(&port_host, 0)
                .map(|iv| iv.last_seen())
                .unwrap_or(0);
            if now_ns.saturating_sub(cur_val.last_seen().max(cur_ib_last)) <= timeout_ns {
                continue;
            }
        }

        let _ = ob_map.remove(&key);
        let _ = ib_map.remove(&port_host);
        let _ = bm_map.set(port_host as u32, 0, 0);
        swept += 1;
    }

    // Sweep orphaned inbound bindings (with 2s grace period)
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
        let _ = ib_map.remove(&port);
        let _ = bm_map.set(port as u32, 0, 0);
        swept += 1;
    }

    swept
}

impl SessionManager {
    pub fn new(
        config_map: Array<MapData, GlobalConfig>,
        ob_map4: HashMap<MapData, EndpointKey4, BindingValue4>,
        ib_map4: HashMap<MapData, u16, BindingValue4>,
        bm_map4: Array<MapData, u8>,
        ob_map6: HashMap<MapData, EndpointKey6, BindingValue6>,
        ib_map6: HashMap<MapData, u16, BindingValue6>,
        bm_map6: Array<MapData, u8>,
    ) -> Self {
        Self {
            config_map,
            ob_map4,
            ib_map4,
            bm_map4,
            ob_map6,
            ib_map6,
            bm_map6,
            expired_v4: Vec::with_capacity(256),
            expired_v6: Vec::with_capacity(256),
            orphan_ports: Vec::with_capacity(64),
        }
    }

    pub fn set_config(&mut self, cfg: GlobalConfig) {
        let _ = self.config_map.set(0, cfg, 0);
    }

    pub fn clear_v4_mappings(&mut self) {
        clear_family_mappings(&mut self.ob_map4, &mut self.ib_map4, &mut self.bm_map4);
    }

    pub fn clear_v6_mappings(&mut self) {
        clear_family_mappings(&mut self.ob_map6, &mut self.ib_map6, &mut self.bm_map6);
    }

    pub fn sweep_expired(&mut self, now_ns: u64, timeout_ns: u64) -> (usize, usize) {
        let swept_v4 = sweep_family(
            &mut self.ob_map4,
            &mut self.ib_map4,
            &mut self.bm_map4,
            &mut self.expired_v4,
            &mut self.orphan_ports,
            now_ns,
            timeout_ns,
        );

        let swept_v6 = sweep_family(
            &mut self.ob_map6,
            &mut self.ib_map6,
            &mut self.bm_map6,
            &mut self.expired_v6,
            &mut self.orphan_ports,
            now_ns,
            timeout_ns,
        );

        (swept_v4, swept_v6)
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
        };
        let _ = self.config_map.set(0, empty_cfg, 0);
    }
}
