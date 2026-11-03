'use strict';
/* Data layer: CPU, memory breakdown, counters, uplink resolution, the
   assembled model. Fixtures are synthetic (documentation MAC/IP ranges)
   but keep the shapes of the real ubus replies of an ipq53xx AP. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const model = load('vantage.model');

test('parseStat: aggregate and per-core idle/total', () => {
	const s = model.parseStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 60 0 20 400 20 0 0 0\ncpu1 40 0 30 400 30 0 0 0\nintr 1 2\n');
	assert.deepEqual(s.all, { idle: 850, total: 1000 });
	assert.equal(s.cores.length, 2);
	assert.deepEqual(s.cores[1], { idle: 430, total: 500 });
	assert.equal(model.parseStat('garbage'), null);
	assert.equal(model.parseStat(null), null);
});

test('cpuUsage: percent from deltas, per core, null without progress', () => {
	const a = model.parseStat('cpu  100 0 0 900 0 0 0 0\ncpu0 50 0 0 450\ncpu1 50 0 0 450\n');
	const b = model.parseStat('cpu  150 0 0 950 0 0 0 0\ncpu0 100 0 0 450\ncpu1 50 0 0 500\n');
	const u = model.cpuUsage(a, b);
	assert.equal(u.pct, 50);
	assert.deepEqual(u.cores, [ 100, 0 ]);
	assert.equal(model.cpuUsage(a, a), null);
	assert.equal(model.cpuUsage(null, b), null);
});

test('memory: one bar of In use / Cache (reclaimable) / Free adding up to total', () => {
	const m = model.memory({ total: 1000, free: 300, available: 600, buffered: 10, cached: 200, shared: 5 });
	assert.equal(m.used, 400);
	assert.equal(m.cache, 300);
	assert.equal(m.free, 300);
	assert.equal(m.availPct, 60);
	assert.deepEqual(m.segments.map(s => s.label), [ 'In use', 'Cache (reclaimable)', 'Free' ]);
	assert.equal(m.segments.reduce((a, s) => a + s.bytes, 0), 1000);
	assert.equal(Math.round(m.segments.reduce((a, s) => a + s.pct, 0)), 100);
});

test('memory: without available, free + buffered + cached stands in', () => {
	const m = model.memory({ total: 1000, free: 300, buffered: 50, cached: 150 });
	assert.equal(m.available, 500);
	assert.equal(m.used, 500);
	assert.equal(m.cache, 200);
});

test('memory: inconsistent numbers are clamped, junk gives null', () => {
	const m = model.memory({ total: 1000, free: 1200, available: 900 });
	assert.equal(m.free, 1000);
	assert.equal(m.available, 1000);
	assert.equal(m.used, 0);
	assert.equal(model.memory({ total: 0 }), null);
	assert.equal(model.memory(null), null);
	/* available below free: never a negative cache segment */
	const n = model.memory({ total: 1000, free: 400, available: 300 });
	assert.equal(n.cache, 0);
	assert.equal(n.used, 600);
});

test('swap only when configured; mounts in bytes', () => {
	assert.equal(model.swap({ total: 0, free: 0 }), null);
	assert.deepEqual(model.swap({ total: 100, free: 25 }), { total: 100, free: 25, used: 75, usedPct: 75 });
	const r = model.mount({ total: 100, free: 90, used: 10, avail: 80 }, 'root');
	assert.equal(r.total, 102400);
	assert.equal(r.used, 10240);
	assert.equal(r.free, 81920);
	assert.equal(r.usedPct, 10);
	assert.equal(model.mount({}, 'x'), null);
});

test('counterRate: states and bit/s', () => {
	assert.equal(model.counterRate(null, { at: 1, rx: 0, tx: 0 }).state, 'first');
	assert.equal(model.counterRate({ at: 1000, rx: 0, tx: 0 }, { at: 1500, rx: 10, tx: 10 }).state, 'skip');
	assert.equal(model.counterRate({ at: 0, rx: 100, tx: 0 }, { at: 5000, rx: 50, tx: 0 }).state, 'reset');
	const r = model.counterRate({ at: 0, rx: 0, tx: 1000 }, { at: 5000, rx: 5000, tx: 1000 });
	assert.equal(r.state, 'ok');
	assert.equal(r.rx, 8000);
	assert.equal(r.tx, 0);
});

test('rates: keeps only present keys, skip keeps the old base', () => {
	const a = model.rates(null, { x: { rx: 0, tx: 0 }, y: { rx: 0, tx: 0 } }, 0);
	assert.deepEqual(Object.keys(a.rates), []);
	const b = model.rates(a.next, { x: { rx: 1000, tx: 0 } }, 500);
	assert.deepEqual(Object.keys(b.next), [ 'x' ]);
	assert.equal(b.next.x.at, 0);   /* too close: base kept */
	const c = model.rates(b.next, { x: { rx: 1000, tx: 0 } }, 1000);
	assert.equal(c.rates.x.rx, 8000);
});

const IFACES = [
	{ interface: 'loopback', up: true, l3_device: 'lo', device: 'lo' },
	{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', proto: 'static', uptime: 100,
	  'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ],
	  route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ], 'dns-server': [ '192.0.2.1' ] }
];
const DEVS = {
	'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'phy6g-ap0', 'eth0', 'phy2g-ap0' ] },
	'eth0': { devtype: 'ethernet', speed: '2500F', carrier: true, statistics: { rx_bytes: 1, tx_bytes: 2 } },
	'phy2g-ap0': { up: true }, 'phy6g-ap0': { up: true }
};

test('resolveUplink: AP bridge -> wired member, gateway and addresses', () => {
	const u = model.resolveUplink(IFACES, DEVS, [ 'phy2g-ap0', 'phy6g-ap0' ]);
	assert.equal(u.iface, 'lan');
	assert.equal(u.dev, 'eth0');
	assert.equal(u.isWan, false);
	assert.deepEqual(u.speed, { mbps: 2500, duplex: 'full' });
	assert.equal(u.gateway, '192.0.2.1');
	assert.deepEqual(u.ipv4, [ '192.0.2.10/24' ]);
	assert.equal(model.resolveUplink([], {}), null);
});

test('resolveUplink: router prefers wan, DSA offload uses conduit', () => {
	const u = model.resolveUplink([ ...IFACES, { interface: 'wan', up: true, l3_device: 'wan', device: 'wan',
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.1' } ] } ],
		{ wan: { devtype: 'dsa', 'hw-tc-offload': true, conduit: 'eth1' }, eth1: {} });
	assert.equal(u.iface, 'wan');
	assert.equal(u.isWan, true);
	assert.equal(u.statsDev, 'eth1');
});

test('resolveUplink: AP default route wins over unmanaged WAN interfaces', () => {
	const wan = [ 'wan', 'wan6' ].map(name => ({
		interface: name, up: true, device: 'eth0', proto: 'none', route: []
	}));
	for (const ifaces of [ [ ...wan, ...IFACES ], [ ...IFACES, ...wan ] ]) {
		const u = model.resolveUplink(ifaces, DEVS);
		assert.equal(u.iface, 'lan');
		assert.equal(u.isWan, false);
		assert.equal(u.gateway, '192.0.2.1');
		assert.deepEqual(u.dns, [ '192.0.2.1' ]);
		assert.deepEqual(u.ipv4, [ '192.0.2.10/24' ]);
		assert.equal(u.l3dev, 'br-lan');
		assert.equal(u.dev, 'eth0');
	}
});

test('resolveUplink: routed wan6 wins over an unrouted wan and LAN', () => {
	const lan = { ...IFACES[1], route: [ { target: '192.0.2.0', mask: 24 } ] };
	const u = model.resolveUplink([ IFACES[0], lan,
		{ interface: 'wan', up: true, device: 'eth1' },
		{ interface: 'wan6', up: true, device: 'eth1',
			route: [ { target: '::', mask: 0, nexthop: '2001:db8::1' } ] }
	], {});
	assert.equal(u.iface, 'wan6');
	assert.equal(u.isWan, true);
	assert.equal(u.gateway, '2001:db8::1');
});

test('resolveUplink: an IPv4 default route beats an IPv6-only one, whatever the metrics', () => {
	const u = model.resolveUplink([ ...IFACES,
		{ interface: 'wan6', up: true, device: 'eth1', metric: 0,
			route: [ { target: '::', mask: 0, nexthop: '2001:db8::1' } ] }
	], {});
	assert.equal(u.iface, 'lan');
	assert.equal(u.gateway, '192.0.2.1');
});

test('resolveUplink: a DS-Lite or MAP-E softwire shows the IPv6 line, not the tunnel', () => {
	for (const proto of [ 'dslite', 'map', '464xlat' ]) {
		const u = model.resolveUplink([ ...IFACES.slice(0, 1),
			{ interface: 'wan', up: true, proto: 'dhcp', device: 'eth1' },
			{ interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth1', l3_device: 'eth1',
				route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] },
			{ interface: 'wan6_4', up: true, proto, l3_device: proto === 'map' ? 'map-wan6_4' : 'ds-wan6_4',
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] }
		], {});
		assert.equal(u.iface, 'wan6', proto);
		assert.equal(u.dev, 'eth1');
		assert.equal(u.gateway, 'fe80::1');
	}
});

test('resolveUplink: multi-WAN picks the lowest metric, not the name (#56)', () => {
	/* two PPPoE uplinks, usb preferred by metric; their IPv6 aliases keep
	   metric 0, the modem links have no default route */
	const pppoe = (name, metric, addr) => ({ interface: name, up: true, proto: 'pppoe', device: 'eth0', l3_device: 'pppoe-' + name, metric,
		'ipv4-address': [ { address: addr, mask: 32 } ], route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.1', source: '0.0.0.0/0' } ] });
	const alias = (name, of) => ({ interface: name, up: true, proto: 'dhcpv6', device: '@' + of, l3_device: 'pppoe-' + of, metric: 0,
		route: [ { target: '::', mask: 0, nexthop: '2001:db8::1' } ] });
	const ifaces = [
		{ ...IFACES[1], route: [ { target: '192.0.2.0', mask: 24 } ] },
		{ interface: 'mao', up: true, proto: 'dhcp', l3_device: 'eth0', metric: 0, route: [] },
		pppoe('wan', 20, '203.0.113.20'), alias('wan6', 'wan'),
		pppoe('usb', 10, '203.0.113.10'), alias('usb6', 'usb')
	];
	for (const list of [ ifaces, [ ...ifaces ].reverse() ]) {
		const u = model.resolveUplink(list, {});
		assert.equal(u.iface, 'usb');
		assert.equal(u.l3dev, 'pppoe-usb');
		assert.deepEqual(u.ipv4, [ '203.0.113.10/32' ]);
		assert.deepEqual(model.networks(list, u).map(n => n.name), [ 'lan', 'mao', 'wan' ]);
	}
	/* a metric on the route itself beats the interface's */
	const routeMetric = ifaces.map(i => i.interface === 'wan' ? { ...i, route: [ { ...i.route[0], metric: 5 } ] } : i);
	assert.equal(model.resolveUplink(routeMetric, {}).iface, 'wan');
	/* equal metrics: the name decides, as before */
	const tie = ifaces.map(i => i.interface === 'usb' ? { ...i, metric: 20 } : i);
	assert.equal(model.resolveUplink(tie, {}).iface, 'wan');
	/* a default in another table (a VPN's own, for policy routing) does not compete */
	const vpn = { interface: 'vpn', up: true, proto: 'wireguard', l3_device: 'wg0', metric: 1, route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0', table: 100 } ] };
	assert.equal(model.resolveUplink([ ...ifaces, vpn ], {}).iface, 'usb');
	assert.equal(model.resolveUplink([ ...ifaces, { ...vpn, route: [ { ...vpn.route[0], table: undefined } ], ip4table: '100' } ], {}).iface, 'usb');
	assert.equal(model.resolveUplink([ ...ifaces, { ...vpn, route: [ { ...vpn.route[0], table: 254 } ] } ], {}).iface, 'vpn');
});

test('resolveUplink: an IPv6 metric of 0 counts as 1024, as the kernel stores it', () => {
	const v6 = (name, metric) => ({ interface: name, up: true, device: 'eth' + metric, metric, route: [ { target: '::', mask: 0, nexthop: '2001:db8::1' } ] });
	assert.equal(model.resolveUplink([ v6('backup6', 0), v6('wan6', 100) ], {}).iface, 'wan6');
	assert.equal(model.resolveUplink([ v6('backup6', 2000), v6('wan6', 0) ], {}).iface, 'wan6');
});

test('resolveUplink: no default route retains WAN and first-up fallbacks', () => {
	const lan = { interface: 'lan', up: true, device: 'br-lan' };
	const wan = { interface: 'wan', up: true, device: 'eth1' };
	const down = { interface: 'wan6', up: false, device: 'eth2',
		route: [ { target: '::', mask: 0, nexthop: '2001:db8::1' } ] };
	const u = model.resolveUplink([ lan, wan, down ], {});
	assert.equal(u.iface, 'wan');
	assert.equal(u.isWan, true);
	assert.equal(u.gateway, null);
	assert.equal(u.defaultRoute, false);
	assert.equal(model.resolveUplink([ down, lan ], {}).iface, 'lan');
});

test('resolveUplink: a tunnel\'s default route without a next hop is still a default route', () => {
	const u = model.resolveUplink([
		{ interface: 'wan', up: true, l3_device: 'eth1',
			route: [ { target: '203.0.113.10', mask: 32, nexthop: '198.51.100.1' } ] },
		{ interface: 'vpn', up: true, l3_device: 'wg0',
			route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] }
	], {});
	assert.equal(u.iface, 'vpn');
	assert.equal(u.gateway, null);
	assert.equal(u.defaultRoute, true);
});

test('networks: other interfaces, not loopback or the uplink, one per device', () => {
	const ifaces = [
		{ interface: 'wan6', up: true, l3_device: 'eth1', proto: 'dhcpv6' },
		{ interface: 'wan', up: true, l3_device: 'eth1', proto: 'dhcp' },
		{ interface: 'loopback', up: true, l3_device: 'lo' },
		{ interface: 'vpn', up: true, l3_device: 'wg0', proto: 'wireguard', 'ipv4-address': [ { address: '203.0.113.1', mask: 24 } ] },
		{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', proto: 'static', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ] },
		{ interface: 'lan6', up: true, l3_device: 'br-lan', proto: 'dhcpv6' },
		{ interface: 'guest', up: false, device: 'br-guest', proto: 'static' },
		null, { up: true }
	];
	const up = model.resolveUplink(ifaces, {});
	assert.equal(up.iface, 'wan');
	assert.deepEqual(model.networks(ifaces, up), [
		{ name: 'guest', proto: 'static', dev: 'br-guest', up: false, ipv4: null },
		{ name: 'lan', proto: 'static', dev: 'br-lan', up: true, ipv4: '198.51.100.1/24' },
		{ name: 'vpn', proto: 'wireguard', dev: 'wg0', up: true, ipv4: '203.0.113.1/24' }
	]);
	assert.deepEqual(model.networks(null, null), []);
});

test('temps: hottest first, millidegrees to degrees, implausible readings left out', () => {
	assert.deepEqual(model.temps([
		{ zone: 'thermal_zone0', type: 'cpu-thermal', temp: 52100 },
		{ zone: 'thermal_zone1', type: '', temp: 77800 },
		{ zone: 'thermal_zone2', type: 'x', temp: 200000 },
		{ zone: 'thermal_zone3', type: 'y', temp: '60000' },
		{ zone: 'thermal_zone4', type: 'z', temp: NaN },
		{ zone: 'thermal_zone5', type: 'cold', temp: -45000 },
		null
	]), [ { name: 'thermal_zone1', celsius: 77.8 }, { name: 'cpu-thermal', celsius: 52.1 } ]);
	assert.deepEqual(model.temps(null), []);
});

test('deviceModel: board_name beats a reference-design model string', () => {
	assert.equal(model.deviceModel({ model: 'Qualcomm Technologies, Inc. IPQ5332/RDP442/AP-MI01.3', board_name: 'zyxel,nwa50be' }), 'Zyxel NWA50BE');
	assert.equal(model.deviceModel({ model: 'Example Router X1', board_name: 'example,x1' }), 'Example Router X1');
	assert.equal(model.deviceModel({}), null);
});

test('hintAddrs: IPv4 outside the uplink subnets is dropped', () => {
	const ips = model.hintAddrs({ ipaddrs: [ '192.0.2.44', '198.51.100.9', 'x' ], ip6addrs: [ 'fe80::1' ] }, [ '192.0.2.10/24' ]);
	assert.deepEqual(ips, [ '192.0.2.44', 'fe80::1' ]);
});

test('hintAddrs: at most 8 addresses per device (SEC-001)', () => {
	const v6 = Array.from({ length: 50 }, (_, i) => '2001:db8::' + (i + 1).toString(16));
	const ips = model.hintAddrs({ ipaddrs: [ '192.0.2.44' ], ip6addrs: v6 }, [ '192.0.2.10/24' ]);
	assert.equal(ips.length, 8);
	assert.equal(ips[0], '192.0.2.44');
});

/* a two-radio AP: 2.4 GHz with two SSIDs, 6 GHz with one */
function raw() {
	return {
		board: { hostname: 'ap-test', model: 'Qualcomm Technologies, Inc. IPQ5332/RDP442', board_name: 'zyxel,nwa50be',
			release: { description: 'OpenWrt 25.12.3 r1', version: '25.12.3' } },
		info: { uptime: 5000, load: [ 65536, 0, 0 ], memory: { total: 1000, free: 300, available: 600 },
			root: { total: 100, used: 10, free: 90, avail: 80 }, tmp: { total: 50, used: 1, free: 49 }, swap: { total: 0, free: 0 } },
		ifaces: IFACES,
		devs: DEVS,
		wifi: {
			radio0: { up: true, config: { band: '2g', channel: '6', htmode: 'EHT20', txpower: 30 },
				iwinfo: { noise: -109, frequency: 2437, channel: 6, txpower: 19 },
				interfaces: [
					{ section: 'a', ifname: 'phy2g-ap0', config: { ssid: 'Home', encryption: 'sae-mixed', network: [ 'lan' ] }, iwinfo: {} },
					{ section: 'b', ifname: 'phy2g-ap1', config: { ssid: 'Legacy', encryption: 'psk2', network: [ 'lan' ] }, iwinfo: {} }
				] },
			radio1: { up: true, config: { band: '6g', channel: '5', htmode: 'EHT160' },
				iwinfo: { noise: -121, frequency: 5975 },
				interfaces: [ { section: 'c', ifname: 'phy6g-ap0', config: { ssid: 'Home', encryption: 'sae', network: [ 'lan' ] }, iwinfo: {} } ] }
		},
		iwinfo: {
			'phy2g-ap0': { channel: 6, center_chan1: 6, frequency: 2437, txpower: 19, noise: -87, htmode: 'EHT20' },
			'phy6g-ap0': { channel: 5, center_chan1: 15, frequency: 5975, txpower: 21, noise: -121, htmode: 'EHT160' }
		},
		assoc: {
			'phy2g-ap1': [ { mac: '00:00:5E:00:53:01', signal: -50, connected_time: 60, inactive: 100,
				rx: { rate: 1000, mhz: 20, bytes: 10, packets: 1 }, tx: { rate: 1000, mhz: 20, bytes: 20, packets: 100, failed: 1 } } ],
			'phy6g-ap0': [ { mac: '02:00:5E:00:53:02', signal: -81, noise: -121, connected_time: 999, inactive: 0,
				rx: { rate: 576400, mhz: 160, eht: true, mcs: 3, nss: 2, bytes: 5, packets: 5 }, tx: { rate: 720600, mhz: 160, eht: true, bytes: 7, packets: 5000, failed: 10 } } ]
		},
		hapd: {
			'phy2g-ap1': { clients: { '00:00:5e:00:53:01': { ht: true, signature: 'wifi4|probe:0,1,wps:Office_Printer_9|assoc:0,1' } } }
		},
		hints: { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.44' ], ip6addrs: [] } },
		aliases: {}
	};
}

test('build: radios, SSIDs and stations with names, bands and generations', () => {
	const m = model.build(raw());
	assert.equal(m.device.model, 'Zyxel NWA50BE');
	assert.equal(m.device.memory.used, 400);
	assert.equal(m.uplink.dev, 'eth0');
	assert.deepEqual(m.radios.map(r => [ r.id, r.band, r.width, r.clients, r.gen ]), [ [ 'radio0', '2g', 20, 1, 'Wi-Fi 7' ], [ 'radio1', '6g', 160, 1, 'Wi-Fi 7' ] ]);
	assert.equal(m.radios[0].noise, -87);
	assert.equal(m.radios[1].noise, null, 'ath12k placeholder noise is unknown, not a number');
	assert.equal(m.radios[1].spectrum.centre, 6025);
	assert.deepEqual(m.ssids.map(s => [ s.ssid, s.security.short, s.clients ]), [ [ 'Home', 'WPA2/3', 0 ], [ 'Legacy', 'WPA2', 1 ], [ 'Home', 'WPA3', 1 ] ]);

	const [ printer, phone ] = m.clients;
	assert.equal(printer.name, 'Office Printer 9');
	assert.equal(printer.nameSource, 'wps');
	assert.equal(printer.icon, 'printer');
	assert.equal(printer.secondary, '192.0.2.44');
	assert.equal(printer.gen, 'Wi-Fi 4');
	assert.equal(printer.legacyOnRadio, true);
	assert.equal(m.radios[0].legacy, 1);
	assert.equal(phone.name, 'Private device · …00:53:02');
	assert.equal(phone.isPrivate, true);
	assert.equal(phone.secondary, '02:00:5E:00:53:02');
	assert.equal(phone.gen, 'Wi-Fi 7');
	assert.equal(phone.rx.label, '576 Mbit/s · 160 MHz · EHT');
	assert.equal(phone.level.level, 'crit');
});

test('build: user alias wins over every other source', () => {
	const r = raw();
	r.aliases = { '00:00:5e:00:53:01': { sid: 'cfg01', name: 'Hall printer', icon: 'printer' } };
	const c = model.build(r).clients[0];
	assert.equal(c.name, 'Hall printer');
	assert.equal(c.nameSource, 'alias');
	assert.equal(c.aliasSid, 'cfg01');
});

test('build: plugin-shaped wireless data (no iwinfo part) takes BSSID and SSID from iwinfo info', () => {
	const r = raw();
	for (const radio of Object.values(r.wifi)) { delete radio.iwinfo; radio.interfaces.forEach(i => { delete i.iwinfo; }); }
	r.iwinfo['phy2g-ap1'] = { ssid: 'Legacy', bssid: '02:00:5E:00:53:A1' };
	r.iwinfo['phy6g-ap0'].bssid = '02:00:5E:00:53:A2';
	const m = model.build(r);
	assert.deepEqual(m.ssids.map(s => s.bssid), [ '', '02:00:5E:00:53:A1', '02:00:5E:00:53:A2' ]);
	assert.equal(m.radios[0].channel, 6);
	assert.equal(m.radios[1].freq, 5975);
	assert.equal(m.clients.length, 2);
});

test('build: mDNS names only when uncontested, below DHCP host names', () => {
	const r = raw();
	r.hints['00:00:5E:00:53:01'] = { ipaddrs: [ '192.0.2.44' ], ip6addrs: [] };
	r.hints['02:00:5E:00:53:02'] = { ipaddrs: [ '192.0.2.45' ], ip6addrs: [] };
	r.hapd = {};
	r.mdns = { '192.0.2.44': 'printer-mdns', '192.0.2.45': 'phone-mdns' };
	let [ a, b ] = model.build(r).clients;
	assert.deepEqual([ a.nameSource, a.name, b.nameSource, b.name ], [ 'mdns', 'printer-mdns', 'mdns', 'phone-mdns' ]);

	/* the DHCP host name of the station's own MAC outranks mDNS */
	r.hints['00:00:5E:00:53:01'].name = 'printer-dhcp';
	a = model.build(r).clients[0];
	assert.deepEqual([ a.nameSource, a.name ], [ 'dhcp', 'printer-dhcp' ]);
	delete r.hints['00:00:5E:00:53:01'].name;

	/* one name announced for both stations' addresses labels neither */
	r.mdns = { '192.0.2.44': 'Dads-iPhone', '192.0.2.45': 'Dads-iPhone' };
	[ a, b ] = model.build(r).clients;
	assert.notEqual(a.nameSource, 'mdns');
	assert.notEqual(b.nameSource, 'mdns');

	/* an address both stations claim in their hints names neither */
	r.hints['02:00:5E:00:53:02'].ipaddrs = [ '192.0.2.44' ];
	r.mdns = { '192.0.2.44': 'printer-mdns' };
	[ a, b ] = model.build(r).clients;
	assert.notEqual(a.nameSource, 'mdns');
	assert.notEqual(b.nameSource, 'mdns');
});

test('build: empty or broken replies give an empty model, not an exception', () => {
	const m = model.build({ wifi: { radio0: null }, assoc: { x: 'nope' }, info: 'junk' });
	assert.deepEqual(m.clients, []);
	assert.equal(m.uplink, null);
	assert.equal(m.device.memory, null);
	assert.deepEqual(model.build(undefined).radios, []);
});

test('groupSsids: same name and security across radios is one network', () => {
	const g = model.groupSsids([
		{ id: 'a', ssid: 'Home', security: { short: 'WPA3' }, band: '2g', radio: 'r0', clients: 1, up: true },
		{ id: 'b', ssid: 'Home', security: { short: 'WPA3' }, band: '6g', radio: 'r1', clients: 2, up: true },
		{ id: 'c', ssid: 'Home', security: { short: 'WPA2' }, band: '2g', radio: 'r0', clients: 0, up: true }
	]);
	assert.equal(g.length, 2);
	assert.deepEqual(g[0].bands, [ '2g', '6g' ]);
	assert.equal(g[0].clients, 3);
});

test('sampleClock: same device sample is skipped, drift uses device spacing', () => {
	const a = model.sampleClock(null, 10000, 500);
	assert.deepEqual(a, { at: 10000, local: 500 });
	/* normal: browser time */
	assert.deepEqual(model.sampleClock(a, 15020, 505), { at: 15020, local: 505 });
	/* the same snapshot again: dt 0 -> counterRate 'skip' */
	const s = model.sampleClock(a, 15020, 500);
	assert.equal(s.at, 10000);
	assert.equal(model.counterRate({ at: 10000, rx: 0, tx: 0 }, { at: s.at, rx: 5, tx: 5 }).state, 'skip');
	/* reply arrived 10 s later but the device advanced 5 s */
	assert.deepEqual(model.sampleClock(a, 20000, 505), { at: 15000, local: 505 });
	/* no localtime: browser time */
	assert.deepEqual(model.sampleClock(a, 12000, undefined), { at: 12000, local: null });
});

test('build: wired hosts from luci.vantage wired, one per MAC, Wi-Fi ports and stations left out', () => {
	const m = model.build({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '198.51.100.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.1' } ] }
		],
		devs: { lan1: { speed: '1000F', carrier: true }, lan2: { speed: '2500F', carrier: true }, wan: { speed: '1000F' }, 'phy2g-ap0': { devtype: 'wlan' } },
		wifi: { radio0: { up: true, config: { band: '2g', channel: '1', htmode: 'HE20' }, interfaces: [ { ifname: 'phy2g-ap0', config: { ssid: 'Home', mode: 'ap' } } ] } },
		assoc: { 'phy2g-ap0': [ { mac: '00:00:5E:00:53:20', signal: -50 } ] },
		hints: {
			'00:00:5E:00:53:01': { name: 'desk', ipaddrs: [ '192.0.2.10', '203.0.113.9' ] },
			'00:00:5E:00:53:09': { ipaddrs: [ '198.51.100.1' ] }
		},
		aliases: { '00:00:5e:00:53:03': { name: 'NAS', sid: 'cfg01' } },
		fdb: [
			{ mac: '00:00:5e:00:53:01', port: 'lan1', bridge: 'br-lan', seen: 3 },
			{ mac: '00:00:5e:00:53:02', port: 'lan2', bridge: 'br-lan', seen: 9 },
			{ mac: '00:00:5e:00:53:03', port: 'lan2', bridge: 'br-lan', seen: null },
			{ mac: '00:00:5e:00:53:02', port: 'lan2', bridge: 'br-lan', vlan: 10, seen: 2 },
			{ mac: '00:00:5e:00:53:03', port: 'lan2', bridge: 'br-lan', seen: 40 },
			{ mac: '00:00:5e:00:53:04', port: 'phy2g-ap0', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:20', port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:09', port: 'wan', bridge: null, seen: 5 },
			{ mac: 'junk', port: 'lan1' }, null, { mac: '00:00:5e:00:53:05', port: 7 }
		]
	});
	assert.deepEqual(m.wiredHosts.map(h => [ h.mac, h.name, h.port, h.network, h.vlan, h.seen, h.peers, h.shared, h.speed && h.speed.mbps, h.gateway ]), [
		[ '00:00:5e:00:53:01', 'desk', 'lan1', 'lan', null, 3, 1, false, 1000, false ],
		[ '00:00:5e:00:53:02', 'Device · …00:53:02', 'lan2', 'lan', 10, 2, 2, true, 2500, false ],
		[ '00:00:5e:00:53:03', 'NAS', 'lan2', 'lan', null, 40, 2, true, 2500, false ],
		[ '00:00:5e:00:53:09', 'Device · …00:53:09', 'wan', null, null, 5, 1, false, 1000, true ]
	], 'the latest entry per MAC, a learned one before a static one; Wi-Fi ports and stations left out');
	assert.deepEqual(m.wiredHosts[0].ips, [ '192.0.2.10' ], 'addresses in the subnets of the bridge\'s network');
	assert.deepEqual(m.wiredHosts[3].ips, [ '198.51.100.1' ], 'a host off any bridge network: the uplink\'s subnets');
	assert.equal(m.clients.length, 1);
	assert.deepEqual(model.build({}).wiredHosts, []);
});

test('build: a wired host on a bridge VLAN gets that VLAN\'s network and addresses', () => {
	const m = model.build({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan.10', device: 'br-lan.10', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '198.51.100.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.1' } ] }
		],
		devs: { lan1: { speed: '1000F', carrier: true }, wan: { speed: '1000F', carrier: true } },
		hints: { '00:00:5E:00:53:41': { ipaddrs: [ '192.0.2.41' ] } },
		fdb: [ { mac: '00:00:5e:00:53:41', port: 'lan1', bridge: 'br-lan', vlan: 10, seen: 2 } ]
	});
	assert.deepEqual([ m.wiredHosts[0].network, m.wiredHosts[0].ips ], [ 'lan', [ '192.0.2.41' ] ]);
});

test('build: an access point on a bridge with several ports takes the uplink where the gateway was learned', () => {
	const ifaces = [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ],
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ];
	const devs = {
		'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'lan3', 'phy0-ap0' ] },
		lan1: { devtype: 'ethernet', speed: '1000F', carrier: true }, lan2: { devtype: 'ethernet', speed: '2500F', carrier: true },
		lan3: { devtype: 'ethernet', carrier: false }, 'phy0-ap0': { devtype: 'wlan' }
	};
	const hints = { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.1' ] }, '00:00:5E:00:53:50': { ipaddrs: [ '192.0.2.50' ] } };
	const fdb = [ { mac: '00:00:5e:00:53:01', port: 'lan2', bridge: 'br-lan', seen: 1 }, { mac: '00:00:5e:00:53:50', port: 'lan1', bridge: 'br-lan', seen: 1 } ];
	const m = model.build({ ifaces, devs, hints, fdb });
	assert.deepEqual([ m.uplink.dev, m.uplink.port, m.uplink.statsDev, m.uplink.speed.mbps ], [ 'lan2', 'lan2', 'lan2', 2500 ], 'the gateway\'s port, its counters and link');
	assert.deepEqual(m.wiredHosts.map(h => [ h.port, h.gateway ]), [ [ 'lan2', true ], [ 'lan1', false ] ]);
	/* the gateway not learned: a port with a link, and no claim which one leads to it */
	const n = model.build({ ifaces, devs: Object.assign({}, devs, { lan1: { devtype: 'ethernet', carrier: false } }), hints, fdb: fdb.slice(1) });
	assert.deepEqual([ n.uplink.dev, n.uplink.port ], [ 'lan2', null ]);
	/* one wired member: that one leads to the gateway */
	assert.equal(model.resolveUplink(IFACES, DEVS).port, 'eth0');
});

test('build: the uplink port through a bridge VLAN, an IPv6 gateway, and a port with a link before one without', () => {
	const devs = {
		'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2' ] },
		'br-lan.10': { devtype: 'vlan', carrier: true },
		lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' }, lan2: { devtype: 'ethernet', carrier: true, speed: '2500F' }
	};
	/* the AP's address on VLAN 10 of the bridge; the gateway learned on lan2 */
	const ifaces = [ { interface: 'lan', up: true, l3_device: 'br-lan.10', device: 'br-lan.10', 'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ],
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ];
	const fdb = [ { mac: '00:00:5e:00:53:01', port: 'lan2', bridge: 'br-lan', vlan: 10, seen: 1 } ];
	const m = model.build({ ifaces, devs, hints: { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.1' ] } }, fdb });
	assert.deepEqual([ m.uplink.l3dev, m.uplink.dev, m.uplink.port, m.uplink.speed.mbps ], [ 'br-lan.10', 'lan2', 'lan2', 2500 ]);
	/* IPv6 only: the gateway is a link-local next hop the hints list under ip6addrs */
	const v6 = [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv6-address': [ { address: '2001:db8::10', mask: 64 } ],
		route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] } ];
	const n = model.build({ ifaces: v6, devs, hints: { '00:00:5E:00:53:01': { ip6addrs: [ 'fe80::1' ] } }, fdb: [ { mac: '00:00:5e:00:53:01', port: 'lan2', bridge: 'br-lan', seen: 1 } ] });
	assert.deepEqual([ n.uplink.dev, n.uplink.port, n.wiredHosts[0].gateway ], [ 'lan2', 'lan2', true ]);
	/* the gateway not learned: an unplugged Ethernet member loses to a switch port with a link */
	const dsa = { 'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'eth1', 'lan1' ] }, eth1: { devtype: 'ethernet', carrier: false }, lan1: { devtype: 'dsa', carrier: true } };
	assert.equal(model.resolveUplink(v6, dsa).dev, 'lan1');
});

test('switchOf: the switch ports behind a VLAN port, with their links once the switch has answered', () => {
	const lan = n => ({ num: n, role: 'lan', index: n + 1 });
	const map = { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ lan(0), lan(1), lan(2), lan(3) ] }, 'eth1.2': { name: 'switch0', vlan: 2, ports: [ { num: 4, role: 'wan', index: null } ] } };
	const port = (n, link, speed) => ({ port: n, link, speed, duplex: link, auto: link, rxflow: false, txflow: false });
	const state = { switch0: [ port(0, false, 0), port(1, true, 2500), port(2, true, 1000), port(3, true, 1000), port(4, false, 0), port(5, true, 10000) ] };
	const sw = model.switchOf(map, state, 'eth1.1');
	assert.deepEqual([ sw.name, sw.vlan, sw.up ], [ 'switch0', 1, 3 ]);
	assert.deepEqual(sw.ports.map(p => [ p.label, p.link, p.speed && p.speed.mbps ]), [ [ 'LAN 1', false, null ], [ 'LAN 2', true, 2500 ], [ 'LAN 3', true, 1000 ], [ 'LAN 4', true, 1000 ] ]);
	assert.deepEqual(model.switchOf(map, state, 'eth1.2').ports.map(p => p.label), [ 'Port 4' ], 'a role without a number: the switch\'s');
	/* board.json without numbers (GL.iNet): four "LAN" would not tell them apart */
	const plain = { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ 0, 1, 2, 3 ].map(n => ({ num: n, role: 'lan', index: null })) } };
	assert.deepEqual(model.switchOf(plain, state, 'eth1.1').ports.map(p => p.label), [ 'Port 0', 'Port 1', 'Port 2', 'Port 3' ]);
	/* not answered yet: links unknown, not down */
	const quiet = model.switchOf(map, {}, 'eth1.1');
	assert.deepEqual([ quiet.up, quiet.ports[1].link ], [ null, null ]);
	assert.deepEqual([ model.switchOf(map, { switch0: [] }, 'eth1.1').up ], [ null ], 'an empty answer: not known, not down');
	const odd = { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ { num: 1, role: 'lan x', index: 2 }, { num: 64, role: 'lan', index: 1 }, { num: -1 } ] } };
	assert.deepEqual(model.switchOf(odd, state, 'eth1.1').ports.map(p => p.label), [ 'Port 1' ], 'no role from an odd string; ports 0-63 only');
	const down = model.switchOf(map, { switch0: [ { port: 1, link: 'yes', speed: 1000 }, { port: 2, link: true, speed: 0 } ] }, 'eth1.1');
	assert.deepEqual(down.ports.slice(1, 3).map(p => [ p.link, p.speed ]), [ [ false, null ], [ true, null ] ], 'link only when true; no speed of 0');
	assert.deepEqual(model.switchOf({ x: { name: 'switch0', vlan: 3, ports: [ { num: 6 } ] } }, state, 'x').ports.map(p => p.label), [ 'Port 6' ]);
	/* anything else: no switch */
	for (const [ m, p ] of [ [ map, 'lan1' ], [ map, '__proto__' ], [ map, 'constructor' ], [ null, 'eth1.1' ], [ { 'eth1.1': { name: '../x', vlan: 1, ports: [] } }, 'eth1.1' ], [ { 'eth1.1': { name: 'switch0', vlan: '1' } }, 'eth1.1' ] ])
		assert.equal(model.switchOf(m, state, p), null, JSON.stringify(p));
});

test('build: a host behind a switch VLAN has a switch port\'s link, not the CPU port\'s', () => {
	const lan = n => ({ num: n, role: 'lan', index: n + 1 });
	const switches = { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ lan(0), lan(1), lan(2), lan(3) ] } };
	const port = (n, link, speed) => ({ port: n, link, speed, duplex: true });
	const build = (state, fdb) => model.build({
		ifaces: [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] } ],
		devs: { 'eth1.1': { speed: '10000F', carrier: true }, lan5: { speed: '1000F', carrier: true } },
		switches, switchState: state, fdb: fdb || [
			{ mac: '00:00:5e:00:53:11', port: 'eth1.1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:12', port: 'lan5', bridge: 'br-lan', seen: 1 }
		]
	}).wiredHosts;
	const one = build({ switch0: [ port(0, false, 0), port(1, true, 2500), port(5, true, 10000) ] });
	assert.deepEqual(one.map(h => [ h.port, h.speed && h.speed.mbps, h.carrier, h.switchPort, !!h.switch ]), [ [ 'eth1.1', 2500, true, 'LAN 2', true ], [ 'lan5', 1000, true, null, false ] ],
		'one switch port with a link: the host is behind it');
	const three = build({ switch0: [ port(1, true, 2500), port(2, true, 1000), port(3, true, 1000) ] });
	assert.deepEqual([ three[0].speed, three[0].carrier, three[0].switchPort, three[0].switch.up ], [ null, true, null, 3 ], 'several: which one is not known');
	assert.deepEqual([ build({ switch0: [ port(1, false, 0) ] })[0].carrier ], [ false ], 'none with a link: down');
	assert.deepEqual([ build({})[0].speed, build({})[0].carrier ], [ null, true ], 'not answered: no speed, the port\'s carrier');
});
