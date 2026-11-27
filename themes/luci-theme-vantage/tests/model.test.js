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
	const b = model.parseStat('cpu  250 0 0 1050 0 0 0 0\ncpu0 200 0 0 450\ncpu1 50 0 0 600\n');
	const u = model.cpuUsage(a, b);
	assert.equal(u.pct, 50);
	assert.deepEqual(u.cores, [ 100, 0 ]);
	assert.equal(model.cpuUsage(a, a), null);
	assert.equal(model.cpuUsage(null, b), null);
});

test('cpuUsage: samples under a second apart give no reading (#101: the page load\'s own burst)', () => {
	const a = model.parseStat('cpu  100 0 0 900 0 0 0 0\ncpu0 50 0 0 450\ncpu1 50 0 0 450\n');
	/* 2 cores: 200 ticks make a second */
	const short = model.parseStat('cpu  290 0 0 909 0 0 0 0\ncpu0 145 0 0 455\ncpu1 145 0 0 454\n');
	const second = model.parseStat('cpu  290 0 0 910 0 0 0 0\ncpu0 145 0 0 455\ncpu1 145 0 0 455\n');
	assert.equal(model.cpuUsage(a, short), null, '199 ticks on 2 cores');
	assert.equal(Math.round(model.cpuUsage(a, second).pct), 95, '200 ticks');
	const one = model.parseStat('cpu  100 0 0 900 0 0 0 0\ncpu0 100 0 0 900\n');
	assert.equal(model.cpuUsage(one, model.parseStat('cpu  150 0 0 949 0 0 0 0\ncpu0 150 0 0 949\n')), null, '99 ticks on 1 core');
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

test('build: the storage list names its entries (root, tmp); a device without a root has /tmp alone', () => {
	const info = { root: { total: 100, used: 10, free: 90, avail: 80 }, tmp: { total: 50, used: 1, free: 49 } };
	assert.deepEqual(model.build({ info }).device.storage.map(s => [ s.key, s.label, s.total ]), [ [ 'root', 'Root (overlay)', 102400 ], [ 'tmp', 'Temporary (RAM)', 51200 ] ]);
	assert.deepEqual(model.build({ info: { tmp: info.tmp } }).device.storage.map(s => s.key), [ 'tmp' ]);
	assert.deepEqual(model.build({ info: { root: { total: 0 }, tmp: info.tmp } }).device.storage.map(s => s.key), [ 'tmp' ]);
	assert.deepEqual(model.build({ info: { root: info.root } }).device.storage.map(s => s.key), [ 'root' ]);
	assert.equal(model.mount(info.root, 'x').key, null, 'no key unless one is given');
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

test('line: the fastest link the port and its partner both offer, null where netifd does not know', () => {
	const fast = [ '10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F' ], gig = fast.concat([ '1000baseT-F' ]), multi = gig.concat([ '2500baseT-F' ]);
	const at = (supported, partner) => model.resolveUplink(IFACES, Object.assign({}, DEVS, {
		eth0: Object.assign({}, DEVS.eth0, { speed: '100F', 'link-supported': supported, 'link-partner-advertising': partner })
	}), [ 'phy2g-ap0', 'phy6g-ap0' ]).linkMax;
	assert.equal(at(fast, multi), 100, 'a Fast Ethernet port');
	assert.equal(at(multi, fast), 100, 'a 100 Mbit/s hand-off');
	assert.equal(at(multi, gig), 1000);
	assert.equal(at(multi, multi), 2500);
	assert.equal(at([ '1000baseX-F', '2500baseX-F' ], [ '1000baseT-F' ]), 1000, 'by speed, whatever the medium is called');
	/* unknown: a list missing or empty (no autonegotiation), no speed in common, junk */
	for (const [ a, b ] of [ [ undefined, undefined ], [ multi, undefined ], [ undefined, multi ], [ [], [] ], [ multi, [] ], [ [], multi ],
		[ [ '10baseT-F' ], [ '1000baseT-F' ] ], [ 'x', multi ], [ [ null, 5, 'fast', '0baseT-F', 'base' ], multi ] ])
		assert.equal(at(a, b), null, JSON.stringify([ a, b ]));
	/* the bridge's own lists are not the port's */
	const br = model.resolveUplink(IFACES, Object.assign({}, DEVS, { 'br-lan': Object.assign({}, DEVS['br-lan'], { 'link-supported': fast, 'link-partner-advertising': fast }) }), [ 'phy2g-ap0', 'phy6g-ap0' ]);
	assert.deepEqual([ br.dev, br.linkMax ], [ 'eth0', null ]);
	assert.equal(model.line({ interface: 'wan', device: 'pppoe-wan' }, {}, []).linkMax, null, 'a device netifd lists nothing for');
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
	/* its device is a tunnel's (ip6tnl), yet it competes as the line's
	   IPv4 by its metric: ahead of an LTE backup at 30 */
	const lte = { interface: 'lte', up: true, proto: 'qmi', l3_device: 'wwan0', metric: 30, route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.9' } ] };
	const u = model.resolveUplink([ lte,
		{ interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth1', l3_device: 'eth1', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] },
		{ interface: 'wan6_4', up: true, proto: 'dslite', l3_device: 'ds-wan6_4', route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] }
	], { 'ds-wan6_4': { devtype: 'ip6tnl', type: 'tunnel' } });
	assert.deepEqual([ u.iface, u.tunnel ], [ 'wan6', null ]);
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
	/* a default in another table (policy routing) does not compete; in
	   table 254 (main) it does. Not a tunnel: those rank after real lines */
	const pbr = { interface: 'lte', up: true, proto: 'qmi', l3_device: 'wwan0', metric: 1, route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.9', table: 100 } ] };
	assert.equal(model.resolveUplink([ ...ifaces, pbr ], {}).iface, 'usb');
	assert.equal(model.resolveUplink([ ...ifaces, { ...pbr, route: [ { ...pbr.route[0], table: undefined } ], ip4table: '100' } ], {}).iface, 'usb');
	assert.equal(model.resolveUplink([ ...ifaces, { ...pbr, route: [ { ...pbr.route[0], table: 254 } ] } ], {}).iface, 'lte');
	/* a full-tunnel VPN in the main table with a better metric rides over usb */
	const vpn = { interface: 'vpn', up: true, proto: 'wireguard', l3_device: 'wg0', metric: 1, route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0', table: 254 } ] };
	assert.equal(model.resolveUplink([ ...ifaces, vpn ], {}).iface, 'usb');
});

/* Other lines to the internet (#88): every other up interface with a
   default route in the main table, one per L3 device, never a tunnel */
const wanIf = (name, dev, metric, extra) => ({ interface: name, up: true, proto: 'dhcp', device: dev, l3_device: dev, metric,
	'ipv4-address': [ { address: '203.0.113.' + (metric + 2), mask: 29 } ], 'dns-server': [ '203.0.113.53' ],
	route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.' + (metric + 1) } ], ...extra });
const LAN = { interface: 'lan', up: true, proto: 'static', device: 'br-lan', l3_device: 'br-lan', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ], route: [] };
const lines = (ifaces, devs) => {
	const main = model.resolveUplink(ifaces, devs || {});
	return [ main, ...model.extraUplinks(ifaces, devs || {}, [], main) ];
};

test('extraUplinks: failover by metric, the backup line beside the main one with the same fields', () => {
	const devs = { eth1: { devtype: 'ethernet', speed: '1000F', carrier: true, statistics: { rx_bytes: 5, tx_bytes: 6 } },
		eth2: { devtype: 'dsa', 'hw-tc-offload': true, conduit: 'eth0', speed: '2500F', carrier: true }, eth0: {} };
	const ifaces = [ LAN, wanIf('wanb', 'eth2', 20), wanIf('wan', 'eth1', 10) ];
	for (const list of [ ifaces, [ ...ifaces ].reverse() ]) {
		const [ main, ...extra ] = lines(list, devs);
		assert.equal(main.iface, 'wan');
		assert.equal(main.metric, 10);
		assert.deepEqual(extra.map(x => x.iface), [ 'wanb' ]);
		const x = extra[0];
		assert.deepEqual([ x.l3dev, x.dev, x.statsDev, x.proto, x.up, x.carrier, x.metric, x.gateway ], [ 'eth2', 'eth2', 'eth0', 'dhcp', true, true, 20, '203.0.113.21' ]);
		assert.deepEqual(x.speed, { mbps: 2500, duplex: 'full' });
		assert.deepEqual([ x.ipv4, x.ipv6, x.dns, x.defaultRoute ], [ [ '203.0.113.22/29' ], [], [ '203.0.113.53' ], true ]);
		assert.deepEqual(model.networks(list, [ main, ...extra ]).map(n => n.name), [ 'lan' ], 'neither line is a local network');
	}
	/* several backups in the kernel's order */
	const three = lines([ LAN, wanIf('lte', 'wwan0', 30), wanIf('wanb', 'eth2', 20), wanIf('wan', 'eth1', 10) ]);
	assert.deepEqual(three.map(x => x.iface), [ 'wan', 'wanb', 'lte' ]);
	/* nothing routed: the fallback pick has no other lines */
	assert.deepEqual(model.extraUplinks([ LAN, { interface: 'wan', up: true, device: 'eth1' } ], {}, [], model.resolveUplink([ LAN ], {})), []);
	assert.deepEqual(model.extraUplinks(ifaces, {}, [], null), []);
});

test('extraUplinks: two lines with equal metrics (mwan3) are both lines, wan the main one by name', () => {
	const [ main, ...extra ] = lines([ wanIf('isp2', 'eth2', 0), wanIf('wan', 'eth1', 0), LAN ]);
	assert.equal(main.iface, 'wan');
	assert.deepEqual(extra.map(x => x.iface), [ 'isp2' ]);
});

test('extraUplinks: wan6 on wan\'s device, or a PPPoE line\'s IPv6 alias, is part of that line', () => {
	const wan6 = { interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth1', l3_device: 'eth1', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] };
	assert.deepEqual(lines([ wan6, wanIf('wan', 'eth1', 0), LAN ]).map(x => x.iface), [ 'wan' ]);
	/* an IPv6-only line on a device of its own is a line */
	assert.deepEqual(lines([ { ...wan6, interface: 'isp6', device: 'eth2', l3_device: 'eth2' }, wanIf('wan', 'eth1', 0) ]).map(x => x.iface), [ 'wan', 'isp6' ]);
});

test('extraUplinks: a DS-Lite softwire, a full-tunnel VPN and a tunnel device ride over the line', () => {
	const wan6 = { interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth1', l3_device: 'eth1', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] };
	const dslite = { interface: 'wan6_4', up: true, proto: 'dslite', l3_device: 'ds-wan6_4', route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] };
	const ds = lines([ { interface: 'wan', up: true, proto: 'dhcp', device: 'eth1' }, wan6, dslite ]);
	assert.deepEqual(ds.map(x => x.iface), [ 'wan6' ]);
	/* WireGuard with allowed_ips 0.0.0.0/0: its default route (no next
	   hop, metric above wan's) is the tunnel's, not a second WAN */
	const vpn = { interface: 'vpn', up: true, proto: 'wireguard', l3_device: 'wg0', metric: 5, 'ipv4-address': [ { address: '203.0.113.99', mask: 32 } ],
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] };
	const wan = wanIf('wan', 'eth1', 0);
	const full = lines([ LAN, wan, vpn ]);
	assert.deepEqual(full.map(x => x.iface), [ 'wan' ]);
	assert.deepEqual(model.networks([ LAN, wan, vpn ], full).map(n => n.name), [ 'lan', 'vpn' ], 'the VPN stays a network');
	for (const proto of [ 'openvpn', 'gre', 'vti', 'xfrm', '6in4', 'ipip' ])
		assert.deepEqual(lines([ wan, { ...vpn, proto } ]).map(x => x.iface), [ 'wan' ], proto);
	/* L2TP is also an ISP's access: a line */
	assert.deepEqual(lines([ wan, { ...vpn, proto: 'l2tp', l3_device: 'l2tp-isp2' } ]).map(x => x.iface), [ 'wan', 'vpn' ]);
	/* an unmanaged tunnel (proto none) told by its device */
	assert.deepEqual(lines([ wan, { ...vpn, proto: 'none', l3_device: 'tun0' } ], { tun0: { devtype: 'tun' } }).map(x => x.iface), [ 'wan' ]);
});

test('extraUplinks: a WAN that is down, or routed in another table, is no line', () => {
	const down = { ...wanIf('wanb', 'eth2', 20), up: false };
	const ifaces = [ LAN, wanIf('wan', 'eth1', 10), down ];
	const l = lines(ifaces);
	assert.deepEqual(l.map(x => x.iface), [ 'wan' ]);
	assert.deepEqual(model.networks(ifaces, l).map(n => [ n.name, n.up ]), [ [ 'lan', true ], [ 'wanb', false ] ], 'a down WAN reads like any down network');
	/* policy routing: a default in a table of its own */
	const own = wanIf('wanb', 'eth2', 20, { route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.21', table: 100 } ] });
	assert.deepEqual(lines([ LAN, wanIf('wan', 'eth1', 10), own ]).map(x => x.iface), [ 'wan' ]);
	assert.deepEqual(lines([ LAN, wanIf('wan', 'eth1', 10), { ...own, route: [ { ...own.route[0], table: undefined } ], ip4table: 'wanb' } ]).map(x => x.iface), [ 'wan' ]);
	assert.deepEqual(lines([ LAN, wanIf('wan', 'eth1', 10), { ...own, route: [ { ...own.route[0], table: 'main' } ] } ]).map(x => x.iface), [ 'wan', 'wanb' ]);
});

test('extraUplinks: two PPPoE lines (#56), usb by metric the main one, wan beside it, each IPv6 alias part of its line', () => {
	const pppoe = (name, metric, addr) => ({ interface: name, up: true, proto: 'pppoe', device: 'eth0', l3_device: 'pppoe-' + name, metric,
		'ipv4-address': [ { address: addr, mask: 32 } ], route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.1', source: '0.0.0.0/0' } ] });
	const alias = (name, of) => ({ interface: name, up: true, proto: 'dhcpv6', device: '@' + of, l3_device: 'pppoe-' + of, metric: 0,
		route: [ { target: '::', mask: 0, nexthop: '2001:db8::1' } ] });
	const ifaces = [
		{ ...LAN, route: [ { target: '198.51.100.0', mask: 24 } ] },
		{ interface: 'mao', up: true, proto: 'dhcp', l3_device: 'eth0', metric: 0, route: [] },
		pppoe('wan', 20, '203.0.113.20'), alias('wan6', 'wan'),
		pppoe('usb', 10, '203.0.113.10'), alias('usb6', 'usb')
	];
	for (const list of [ ifaces, [ ...ifaces ].reverse() ]) {
		const l = lines(list);
		assert.deepEqual(l.map(x => [ x.iface, x.l3dev, x.metric ]), [ [ 'usb', 'pppoe-usb', 10 ], [ 'wan', 'pppoe-wan', 20 ] ]);
		assert.deepEqual(model.networks(list, l).map(n => n.name), [ 'lan', 'mao' ]);
	}
	/* the model: the main line first in uplinks, the others out of networks */
	const m = model.build({ ifaces, devs: {} });
	assert.equal(m.uplinks[0], m.uplink);
	assert.deepEqual(m.uplinks.map(x => x.iface), [ 'usb', 'wan' ]);
	assert.deepEqual(m.networks.map(n => n.name), [ 'lan', 'mao' ]);
	assert.deepEqual(model.build({}).uplinks, []);
});

test('extraUplinks: a backup on a bridge VLAN takes the port its gateway was learned on, else the VLAN\'s own counters', () => {
	const eth = carrier => ({ devtype: 'ethernet', carrier, speed: '1000F', statistics: { rx_bytes: 1, tx_bytes: 1 } });
	const devs = { 'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'lan3', 'lan4' ] },
		lan1: eth(true), lan2: eth(true), lan3: eth(false), lan4: eth(true), eth1: eth(true),
		'br-lan.1': { devtype: 'vlan' }, 'br-lan.20': { devtype: 'vlan', carrier: true, statistics: { rx_bytes: 9, tx_bytes: 9 } } };
	const ifaces = [
		{ interface: 'lan', up: true, proto: 'static', device: 'br-lan.1', l3_device: 'br-lan.1', route: [] },
		wanIf('wan', 'eth1', 10),
		wanIf('wanb', 'br-lan.20', 20)
	];
	/* the gateway's port unknown: the VLAN's counters, not lan1's */
	let [ main, b ] = model.build({ ifaces, devs }).uplinks;
	assert.deepEqual([ main.dev, main.statsDev ], [ 'eth1', 'eth1' ]);
	assert.deepEqual([ b.iface, b.dev, b.statsDev, b.port, b.speed ], [ 'wanb', 'br-lan.20', 'br-lan.20', null, null ]);
	/* the bridge learned the backup's gateway on lan4 */
	const gw = '00:00:5e:00:53:c9';
	const m = model.build({ ifaces, devs, hints: { [gw.toUpperCase()]: { ipaddrs: [ '203.0.113.21' ] } },
		fdb: [ { mac: gw, port: 'lan4', bridge: 'br-lan', vlan: 20, seen: 3 } ] });
	[ main, b ] = m.uplinks;
	assert.deepEqual([ b.dev, b.statsDev, b.port ], [ 'lan4', 'lan4', 'lan4' ]);
	assert.deepEqual(b.speed, { mbps: 1000, duplex: 'full' });
	assert.equal(m.wiredHosts.find(h => h.mac === gw).gateway, false, 'the main line\'s gateway only');
	/* a LAN host (VLAN 1 of the same bridge, on lan2) with that address gives the line no port: alone (an idle
	   backup line's gateway is in no hint), and beside the gateway, whose port the line keeps */
	const liar = '00:00:5e:00:53:66', other = { mac: liar, port: 'lan2', bridge: 'br-lan', vlan: 1, seen: 1 }, hop = { ipaddrs: [ '203.0.113.21' ] };
	const there = { mac: gw, port: 'lan4', bridge: 'br-lan', vlan: 20, seen: 3 };
	assert.equal(model.build({ ifaces, devs, hints: { [liar.toUpperCase()]: hop }, fdb: [ other ] }).uplinks[1].port, null);
	assert.equal(model.build({ ifaces, devs, hints: { [liar.toUpperCase()]: hop }, fdb: [ there, other ] }).uplinks[1].port, null);
	for (const hints of [ { [gw.toUpperCase()]: hop, [liar.toUpperCase()]: hop }, { [liar.toUpperCase()]: hop, [gw.toUpperCase()]: hop } ])
		assert.equal(model.build({ ifaces, devs, hints, fdb: [ there, other ] }).uplinks[1].port, 'lan4');
	/* a bridge with one wired port still leads to it */
	const one = { ...devs, 'br-wan': { type: 'bridge', 'bridge-members': [ 'lan3' ] } };
	assert.equal(model.build({ ifaces: [ ifaces[1], wanIf('wanb', 'br-wan', 20) ], devs: one }).uplinks[1].dev, 'lan3');
});

test('extraUplinks: IPv6 on the device a PPPoE line runs over is part of that line, its addresses and DNS too', () => {
	const ifaces = [ LAN,
		{ interface: 'wan', up: true, proto: 'pppoe', device: 'eth0.7', l3_device: 'pppoe-wan', 'ipv4-address': [ { address: '203.0.113.5', mask: 32 } ],
			'dns-server': [ '203.0.113.53' ], route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] },
		{ interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth0.7', l3_device: 'eth0.7', 'ipv6-address': [ { address: '2001:db8:7::5', mask: 64 } ],
			'dns-server': [ '2001:db8:7::53' ], route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] }
	];
	const m = model.build({ ifaces, devs: { 'eth0.7': { devtype: 'vlan' } } });
	assert.deepEqual(m.uplinks.map(x => x.iface), [ 'wan' ]);
	const u = m.uplink;
	assert.deepEqual([ u.l3dev, u.ipv4, u.ipv6, u.dns, u.ifaces ], [ 'pppoe-wan', [ '203.0.113.5/32' ], [ '2001:db8:7::5/64' ], [ '203.0.113.53', '2001:db8:7::53' ], [ 'wan', 'wan6' ] ]);
	assert.deepEqual(m.networks.map(n => n.name), [ 'lan' ]);
	/* wan6 on wan's own device, the common router: its IPv6 on wan's line */
	const plain = model.resolveUplink([ wanIf('wan', 'eth1', 0), { ...ifaces[2], device: 'eth1', l3_device: 'eth1' } ], {});
	assert.deepEqual([ plain.iface, plain.ipv6, plain.ifaces ], [ 'wan', [ '2001:db8:7::5/64' ], [ 'wan', 'wan6' ] ]);
	/* an IPv4 line on that device is not merged (#56 keeps two PPPoE sessions on eth0) */
	assert.deepEqual(lines([ ifaces[1], wanIf('wanb', 'eth0.7', 20) ]).map(x => x.iface), [ 'wan', 'wanb' ]);
});

test('a line\'s delegated IPv6 prefix: its own and wan6\'s, each once, only what reads as a prefix', () => {
	const wan6 = (prefix, extra) => ({ interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth1', l3_device: 'eth1', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ], 'ipv6-prefix': prefix, ...extra });
	const pd = { address: '2001:db8:1200::', mask: 56, preferred: 3600, valid: 7200, class: 'wan6', assigned: { lan: { address: '2001:db8:1200::', mask: 60 } } };
	/* wan6 is part of wan's line: the prefix is the line's */
	const u = model.resolveUplink([ wanIf('wan', 'eth1', 0), wan6([ pd ]), LAN ], {});
	assert.deepEqual([ u.iface, u.ifaces, u.prefix6 ], [ 'wan', [ 'wan', 'wan6' ], [ '2001:db8:1200::/56' ] ]);
	/* an IPv6-only line has its own; two prefixes, one of them twice */
	const only = model.resolveUplink([ wan6([ pd, { address: '2001:db8:3400::', mask: 48 }, pd ]) ], {});
	assert.deepEqual(only.prefix6, [ '2001:db8:1200::/56', '2001:db8:3400::/48' ]);
	/* a backup line keeps its own apart from the main one's */
	const [ main, backup ] = lines([ wanIf('wan', 'eth1', 0), wan6([ pd ]), wanIf('wanb', 'eth2', 20, { 'ipv6-prefix': [ { address: '2001:db8:5600::', mask: 60 } ] }) ]);
	assert.deepEqual([ main.prefix6, backup.prefix6 ], [ [ '2001:db8:1200::/56' ], [ '2001:db8:5600::/60' ] ]);
	/* none: an empty list, as netifd sends it, or no list at all */
	assert.deepEqual(model.resolveUplink([ wanIf('wan', 'eth1', 0), wan6([]) ], {}).prefix6, []);
	assert.deepEqual(model.resolveUplink([ wanIf('wan', 'eth1', 0) ], {}).prefix6, []);
	/* not a prefix: no entry, never text made of it */
	const junk = [ null, 'x', {}, { address: '2001:db8::', mask: '56' }, { address: '2001:db8::', mask: 0 }, { address: '2001:db8::', mask: 129 }, { address: '2001:db8::', mask: 56.5 },
		{ address: '<b>2001:db8::</b>', mask: 56 }, { address: '203.0.113.0', mask: 24 }, { address: '2001:db8::%eth0', mask: 56 }, { address: 'abcd', mask: 16 },
		{ address: '2001:db8:' + '0:'.repeat(20), mask: 56 }, { address: [ '2001:db8::' ], mask: 56 }, { mask: 56 } ];
	assert.deepEqual(model.resolveUplink([ wanIf('wan', 'eth1', 0), wan6(junk) ], {}).prefix6, []);
	assert.deepEqual(model.resolveUplink([ wanIf('wan', 'eth1', 0), wan6('2001:db8::/56') ], {}).prefix6, []);
});

test('extraUplinks: two lines on DSA ports of one switch keep their own counters; one line keeps the conduit\'s', () => {
	const dsa = { devtype: 'dsa', 'hw-tc-offload': true, conduit: 'eth0' };
	const devs = { wan: dsa, lan4: dsa, eth0: {}, eth1: {} };
	const two = model.build({ ifaces: [ LAN, wanIf('wan', 'wan', 10), wanIf('wanb', 'lan4', 20) ], devs }).uplinks;
	assert.deepEqual(two.map(x => [ x.dev, x.statsDev ]), [ [ 'wan', 'wan' ], [ 'lan4', 'lan4' ] ]);
	assert.deepEqual(model.build({ ifaces: [ LAN, wanIf('wan', 'wan', 10) ], devs }).uplinks.map(x => x.statsDev), [ 'eth0' ]);
	/* the main line on the conduit itself: the backup port counts its own */
	assert.deepEqual(model.build({ ifaces: [ LAN, wanIf('wan', 'eth0', 10), wanIf('wanb', 'lan4', 20) ], devs }).uplinks.map(x => x.statsDev), [ 'eth0', 'lan4' ]);
	/* conduits of their own: both substituted */
	const apart = { ...devs, lan4: { ...dsa, conduit: 'eth1' } };
	assert.deepEqual(model.build({ ifaces: [ LAN, wanIf('wan', 'wan', 10), wanIf('wanb', 'lan4', 20) ], devs: apart }).uplinks.map(x => x.statsDev), [ 'eth0', 'eth1' ]);
});

test('a line\'s rate leaves out the VLANs of this device\'s own networks on its device (#166)', () => {
	const s = { rx_bytes: 0, tx_bytes: 0 };
	const vlan = { type: 'VLAN', devtype: 'vlan', statistics: s };
	const devs = {
		eth0: { devtype: 'ethernet', statistics: s }, 'eth0.1': vlan, 'eth0.3': vlan, 'eth0.9': vlan, 'eth1.3': vlan,
		named: { type: '8021q', devtype: 'vlan', parent: 'eth0', statistics: s },
		/* no VLAN (a macvlan names a parent too), no counters, and one that is down */
		mv0: { type: 'macvlan', devtype: 'macvlan', parent: 'eth0', statistics: s }, 'eth0.7': { type: 'VLAN', devtype: 'vlan' }, 'eth0.8': vlan,
		'br-lan': { type: 'bridge', 'bridge-members': [ 'eth0.1' ], statistics: s }
	};
	const net = (name, dev, proto) => ({ interface: name, up: true, proto: proto || 'static', device: dev, l3_device: dev, route: [] });
	/* an untagged WAN on the device the LAN's VLANs are on: a switch's CPU port */
	const ifaces = [ LAN, wanIf('wan', 'eth0', 10), net('iot', 'eth0.3'), net('cams', 'named'), net('trunk', 'eth0.9', 'none'), net('other', 'eth1.3'),
		net('mv', 'mv0'), net('quiet', 'eth0.7'), { ...net('off', 'eth0.8'), up: false } ];
	const up = model.build({ ifaces, devs }).uplink;
	assert.deepEqual([ up.statsDev, up.minus.slice().sort() ], [ 'eth0', [ 'eth0.1', 'eth0.3', 'named' ] ],
		'through its bridge, by its name and by its parent; not an unmanaged one, not another device\'s, no macvlan, none without counters or down');
	/* every line has its own: a second one on eth1 leaves eth1.3 out */
	const two = model.build({ ifaces: ifaces.concat([ wanIf('wanb', 'eth1', 20) ]), devs: { ...devs, eth1: { devtype: 'ethernet', statistics: s } } }).uplinks;
	assert.deepEqual(two.map(x => [ x.iface, x.minus.slice().sort() ]), [ [ 'wan', [ 'eth0.1', 'eth0.3', 'named' ] ], [ 'wanb', [ 'eth1.3' ] ] ]);
	/* PPPoE on eth0: counted on the device under the session, which carries the LAN's VLANs too */
	const ppp = model.build({ ifaces: [ LAN, net('iot', 'eth0.3'), { ...wanIf('wan', 'eth0', 10), proto: 'pppoe', l3_device: 'pppoe-wan' } ], devs: { ...devs, 'pppoe-wan': { statistics: s } } }).uplink;
	assert.deepEqual([ ppp.statsDev, ppp.minus.slice().sort() ], [ 'eth0', [ 'eth0.1', 'eth0.3' ] ]);
	const rates = { eth0: { rx: 900, tx: 880 }, 'eth0.1': { rx: 50, tx: 600 }, 'eth0.3': { rx: 20, tx: 150 }, named: { rx: 10, tx: 30 } };
	assert.deepEqual(model.lineRate(up, rates), { rx: 820, tx: 100 });
	assert.equal(model.lineRate(up, { ...rates, named: undefined }), null, 'none while one of them has no rate');
	assert.deepEqual(model.lineRate(up, { ...rates, 'eth0.1': { rx: 5000, tx: 5000 } }), { rx: 0, tx: 0 }, 'never below zero');
	/* nothing to take off: the device's own rate, as before */
	const plain = model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 10) ], devs: { ...devs, eth1: { statistics: s } } }).uplink;
	assert.deepEqual(plain.minus, []);
	assert.equal(model.lineRate(plain, { eth1: rates.eth0 }), rates.eth0);
	assert.equal(model.lineRate(plain, {}), null);
	assert.equal(model.lineRate(null, rates), null);
	/* an access point's trunk: the VLANs beside its LAN are bridged on to its Wi-Fi and counted once on the port, whether
	   that network is unmanaged here or has an address of its own */
	for (const proto of [ 'none', 'static', 'dhcp' ]) {
		const ap = model.build({ ifaces: [ { ...LAN, route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.254' } ] }, net('iot', 'br-iot', proto) ], devs: {
			eth0: { devtype: 'ethernet', carrier: true, statistics: s }, 'eth0.3': vlan,
			'br-lan': { type: 'bridge', 'bridge-members': [ 'eth0' ], statistics: s }, 'br-iot': { type: 'bridge', 'bridge-members': [ 'eth0.3' ], statistics: s }
		} }).uplink;
		assert.deepEqual([ ap.statsDev, ap.minus ], [ 'eth0', [] ], proto);
	}
	/* nor a line counted on a bridge itself (several wired ports, the gateway's unknown): its VLANs are the bridge's */
	const onBridge = model.lineVlans({ statsDev: 'br-lan', dev: 'br-lan', l3dev: 'br-lan' }, { 'br-lan': { type: 'bridge', statistics: s }, 'br-lan.10': vlan }, [ net('ten', 'br-lan.10') ]);
	assert.deepEqual(onBridge, []);
});

/* private and shared addresses are built from numbers: the tree holds
   documentation addresses only (check_private_addresses.js) */
test('lineNat: a router\'s line with a private or a shared address, and nothing else', () => {
	const ip = (...o) => o.join('.');
	const line = (ipv4, isWan) => ({ iface: 'wan', isWan: isWan !== false, ipv4 });
	const kind = (...o) => model.lineNat(line([ ip(...o) + '/24' ]));
	/* RFC 1918, to the edges of each block */
	for (const o of [ [ 10, 0, 0, 1 ], [ 10, 255, 255, 254 ], [ 172, 16, 0, 1 ], [ 172, 31, 255, 254 ], [ 192, 168, 0, 1 ], [ 192, 168, 255, 254 ] ])
		assert.equal(kind(...o), 'private', ip(...o));
	/* RFC 6598 */
	for (const o of [ [ 100, 64, 0, 1 ], [ 100, 100, 1, 2 ], [ 100, 127, 255, 254 ] ]) assert.equal(kind(...o), 'shared', ip(...o));
	/* their neighbours, public addresses, the documentation blocks the demo uses, other special ones */
	for (const o of [ [ 9, 255, 255, 254 ], [ 11, 0, 0, 1 ], [ 172, 15, 255, 254 ], [ 172, 32, 0, 1 ], [ 192, 167, 0, 1 ], [ 192, 169, 0, 1 ], [ 100, 63, 255, 254 ], [ 100, 128, 0, 1 ],
		[ 203, 0, 113, 5 ], [ 198, 51, 100, 5 ], [ 192, 0, 2, 5 ], [ 192, 0, 0, 2 ], [ 169, 254, 1, 1 ], [ 127, 0, 0, 1 ] ])
		assert.equal(kind(...o), null, ip(...o));
	/* an access point's uplink is its LAN: private by design, no note */
	assert.equal(model.lineNat(line([ ip(192, 168, 1, 2) + '/24' ], false)), null);
	assert.equal(model.resolveUplink(IFACES.map(i => i.interface === 'lan' ? { ...i, 'ipv4-address': [ { address: ip(192, 168, 1, 2), mask: 24 } ] } : i), DEVS, []).isWan, false);
	/* through the model: a router's wan, with or without the prefix length */
	const wan = model.resolveUplink([ wanIf('wan', 'eth1', 0, { 'ipv4-address': [ { address: ip(10, 0, 0, 2), mask: 24 } ] }), LAN ], {});
	assert.deepEqual([ wan.isWan, model.lineNat(wan) ], [ true, 'private' ]);
	assert.equal(model.lineNat(line([ ip(100, 64, 0, 2) ])), 'shared');
	/* every address of the line must be one: a modem's management address beside a public one is no NAT */
	assert.equal(model.lineNat(line([ '203.0.113.5/24', ip(192, 168, 100, 2) + '/24' ])), null);
	assert.equal(model.lineNat(line([ ip(192, 168, 100, 2) + '/24', '203.0.113.5/24' ])), null);
	assert.equal(model.lineNat(line([ ip(10, 0, 0, 2) + '/24', ip(100, 64, 0, 2) + '/24' ])), 'private', 'the first one names it');
	/* no IPv4 address (an IPv6-only line), junk, no line */
	for (const x of [ line([]), line(undefined), line([ 'x' ]), line([ null ]), line([ ip(10, 0, 0, 256) ]), line([ '2001:db8::1/64' ]), null, undefined, {} ])
		assert.equal(model.lineNat(x), null, JSON.stringify(x));
});

test('resolveUplink: DS-Lite at metric 0 is the IPv4 way out before an LTE backup, shown as its IPv6 line', () => {
	const wan6 = { interface: 'wan6', up: true, proto: 'dhcpv6', device: 'eth1', l3_device: 'eth1', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] };
	const ds = metric => ({ interface: 'wan6_4', up: true, proto: 'dslite', l3_device: 'ds-wan6_4', metric, route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] });
	const lte = wanIf('lte', 'wwan0', 30);
	const m = model.build({ ifaces: [ LAN, wan6, ds(0), lte ], devs: {} });
	assert.deepEqual(m.uplinks.map(x => [ x.iface, x.dev, x.metric ]), [ [ 'wan6', 'eth1', 0 ], [ 'lte', 'wwan0', 30 ] ]);
	assert.equal(m.uplink.gateway, 'fe80::1');
	assert.ok(m.networks.some(n => n.name === 'wan6_4'), 'the softwire is no line of its own');
	/* the softwire's metric above the backup's: LTE takes IPv4 */
	assert.deepEqual(lines([ LAN, wan6, ds(40), lte ]).map(x => x.iface), [ 'lte', 'wan6' ]);
	/* no IPv6 line to show it on: the softwire itself */
	assert.equal(model.resolveUplink([ LAN, ds(0) ], {}).iface, 'wan6_4');
});

test('a full-tunnel VPN rides over the line: the kernel\'s routes decide, without them a lower metric only', () => {
	const vpn = { interface: 'vpn', up: true, proto: 'wireguard', l3_device: 'wg0', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] };
	const devs = { wg0: { devtype: 'wireguard' } };
	const ride = m => [ m.uplinks.map(x => x.iface), m.uplink.tunnel && m.uplink.tunnel.iface, m.networks.map(n => n.name) ];
	/* below the line's metric: on the line, not a network, not a line */
	const one = model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 20), vpn ], devs });
	assert.deepEqual(ride(one), [ [ 'wan' ], 'vpn', [ 'lan' ] ]);
	assert.deepEqual(one.uplink.tunnel, { iface: 'vpn', proto: 'wireguard', dev: 'wg0', metric: 10 });
	/* the same metric: netifd's list cannot tell which route the kernel kept */
	const tie = [ LAN, wanIf('wan', 'eth1', 0), { ...vpn, metric: 0 } ];
	assert.deepEqual(ride(model.build({ ifaces: tie, devs })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* the kernel's table tells: it kept the tunnel's, or the line's */
	assert.deepEqual(ride(model.build({ ifaces: tie, devs, routes: [ { family: 4, dev: 'wg0', metric: 0 } ] })), [ [ 'wan' ], 'vpn', [ 'lan' ] ]);
	assert.deepEqual(ride(model.build({ ifaces: tie, devs, routes: [ { family: 4, dev: 'eth1', metric: 0 } ] })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* the kernel overrules netifd's metrics, and no default is an answer */
	assert.deepEqual(ride(model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 20), vpn ], devs, routes: [ { family: 4, dev: 'eth1', metric: 20 } ] })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	assert.deepEqual(ride(model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 20), vpn ], devs, routes: [] })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* load balanced over several next hops: no tunnel */
	assert.deepEqual(ride(model.build({ ifaces: tie, devs, routes: [ { family: 4, dev: null, metric: 0 } ] })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* IPv4's route decides while there is one, not IPv6's */
	assert.deepEqual(ride(model.build({ ifaces: tie, devs, routes: [ { family: 4, dev: 'eth1', metric: 0 }, { family: 6, dev: 'wg0', metric: 1024 } ] })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* an IPv4 VPN over an IPv6-only line rides it, with the kernel's answer or without */
	const v6line = { interface: 'wan6', up: true, proto: 'dhcpv6', l3_device: 'eth1', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] };
	assert.deepEqual(ride(model.build({ ifaces: [ LAN, v6line, { ...vpn, metric: 0 } ], devs })), [ [ 'wan6' ], 'vpn', [ 'lan' ] ]);
	assert.deepEqual(ride(model.build({ ifaces: [ LAN, v6line, { ...vpn, metric: 0 } ], devs, routes: [ { family: 4, dev: 'wg0', metric: 0 }, { family: 6, dev: 'eth1', metric: 1024 } ] })), [ [ 'wan6' ], 'vpn', [ 'lan' ] ]);
	/* a VPN daemon's own default (OpenVPN on tun0, netifd's interface without routes): the kernel names it */
	const ovpn = { interface: 'ovpn', up: true, proto: 'none', l3_device: 'tun0', device: 'tun0' };
	const od = model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 0), ovpn ], devs: { tun0: { devtype: 'tun' } }, routes: [ { family: 4, dev: 'tun0', metric: 0 } ] });
	assert.deepEqual(ride(od), [ [ 'wan' ], 'ovpn', [ 'lan' ] ]);
	assert.equal(od.uplink.tunnel.proto, null, 'proto none is not shown');
	/* the kernel names a device that is no tunnel: nothing rides */
	assert.deepEqual(ride(model.build({ ifaces: tie, devs, routes: [ { family: 4, dev: 'br-lan', metric: 0 } ] })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* a backup VPN (a higher metric) and a VPN in its own table stay networks */
	assert.deepEqual(ride(model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 20), { ...vpn, metric: 30 } ], devs })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	assert.deepEqual(ride(model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 20), { ...vpn, ip4table: '100' } ], devs })), [ [ 'wan' ], null, [ 'lan', 'vpn' ] ]);
	/* several lines: on the main one; the others stay lines */
	const two = model.build({ ifaces: [ LAN, wanIf('wan', 'eth1', 10), wanIf('wanb', 'eth2', 20), { ...vpn, metric: 0 } ], devs: {} });
	assert.deepEqual(ride(two), [ [ 'wan', 'wanb' ], 'vpn', [ 'lan' ] ]);
	assert.equal(two.uplinks[1].tunnel, undefined);
	/* told by its device, with proto none */
	const tun = model.resolveUplink([ wanIf('wan', 'eth1', 20), { ...vpn, proto: 'none', l3_device: 'tun0' } ], { tun0: { devtype: 'tun' } });
	assert.deepEqual([ tun.iface, tun.tunnel && tun.tunnel.dev ], [ 'wan', 'tun0' ]);
	/* alone, the VPN is the line, with nothing riding on it */
	const alone = model.resolveUplink([ LAN, vpn ], {});
	assert.deepEqual([ alone.iface, alone.tunnel ], [ 'vpn', null ]);
});

test('build: lines past the four shown beside the main one stay networks', () => {
	const ifaces = [ LAN ].concat([ 1, 2, 3, 4, 5, 6, 7 ].map(n => wanIf('wan' + (n > 1 ? n : ''), 'eth' + n, n * 10)));
	const m = model.build({ ifaces, devs: {} });
	assert.equal(model.MAX_LINES, 4);
	assert.deepEqual(m.uplinks.map(x => x.iface), [ 'wan', 'wan2', 'wan3', 'wan4', 'wan5' ]);
	assert.deepEqual(m.networks.map(n => n.name), [ 'lan', 'wan6', 'wan7' ]);
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

test('buildDate: a plausible number of seconds since 1970, as text or number; anything else is no date', () => {
	/* procd hands over OPENWRT_BUILD_DATE as text */
	assert.equal(model.buildDate('1790000000'), 1790000000);
	assert.equal(model.buildDate(1790000000), 1790000000);
	assert.equal(model.buildDate('1577836800'), 1577836800, '2020-01-01, the earliest taken');
	assert.equal(model.buildDate('4102444799'), 4102444799);
	/* a custom build's other text, a date in another form, and what is no time a firmware was built */
	for (const v of [ 'r31337-abcdef0123', 'v5.1.0', '2026-09-21', '2026-09-21 14:13:20', 'Mon Sep 21 2026', '20260921', '1790000000 ', ' 1790000000', '1790000000.5', '1.79e9', '0x6ab1f600',
		'1790000000000', '1577836799', '4102444800', '0', '', '-1790000000', 1790000000.5, 0, -1, NaN, Infinity, 1790000000000, null, undefined, true, {}, [ '1790000000' ] ])
		assert.equal(model.buildDate(v), null, JSON.stringify(v));
	/* through the model */
	const board = builddate => ({ release: { description: 'OpenWrt 25.12.3 r1', version: '25.12.3', builddate } });
	assert.equal(model.build({ board: board('1790000000') }).device.built, 1790000000);
	assert.equal(model.build({ board: board('r31337-abcdef0123') }).device.built, null);
	assert.equal(model.build({ board: { release: {} } }).device.built, null);
	assert.equal(model.build({}).device.built, null);
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

test('parseIPv6: the eight groups of an address whatever its spelling; anything else is none', () => {
	const ten = [ 0x2001, 0xdb8, 1, 0, 0, 0, 0, 0x10 ];
	for (const s of [ '2001:db8:1::10', '2001:db8:1:0::10', '2001:0db8:1::10', '2001:db8:1::0010', '2001:db8:0001::10', '2001:db8:1:0:0:0:0:10',
		'2001:db8:1:0:0:0::10', '2001:0db8:0001:0000:0000:0000:0000:0010', '2001:DB8:1::10', '2001:0DB8:1:0:0:0:0:10' ])
		assert.deepEqual(model.parseIPv6(s), ten, s);
	assert.deepEqual(model.parseIPv6('2001:db8:1::11'), [ 0x2001, 0xdb8, 1, 0, 0, 0, 0, 0x11 ], 'another address');
	assert.deepEqual(model.parseIPv6('2001:db8::1:10'), [ 0x2001, 0xdb8, 0, 0, 0, 0, 1, 0x10 ], 'the groups in their places');
	assert.deepEqual(model.parseIPv6('2001:db8::'), [ 0x2001, 0xdb8, 0, 0, 0, 0, 0, 0 ]);
	assert.deepEqual(model.parseIPv6('::1'), [ 0, 0, 0, 0, 0, 0, 0, 1 ]);
	assert.deepEqual(model.parseIPv6('::'), [ 0, 0, 0, 0, 0, 0, 0, 0 ]);
	assert.deepEqual(model.parseIPv6('2001:db8::ffff:FFFF'), [ 0x2001, 0xdb8, 0, 0, 0, 0, 0xffff, 0xffff ]);
	for (const s of [ '', ':', ':::', '::::', '1:2:3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '::1:2:3:4:5:6:7:8', '1::2::3',
		':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:', '2001:db8:1:::10', '2001:db8::12345', '2001:db8::g', '2001:db8::-1', '2001:db8::0x1', '2001:db8::1 ', ' 2001:db8::1',
		'2001:db8::1%br-lan', '[2001:db8::1]', '2001:db8::1/64', '::ffff:192.0.2.1', '192.0.2.1', 'NaN', null, undefined, 7, NaN, {}, [ '::1' ] ])
		assert.equal(model.parseIPv6(s), null, JSON.stringify(s));
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
	assert.equal(phone.name, 'Private device 53:02');
	assert.equal(phone.plainName, 'Private device', 'for where the MAC is shown beside it');
	assert.equal(printer.plainName, printer.name);
	assert.equal(phone.isPrivate, true);
	assert.equal(phone.secondary, '02:00:5E:00:53:02');
	assert.equal(phone.gen, 'Wi-Fi 7');
	assert.equal(phone.rx.label, '576 Mbit/s · 160 MHz · EHT');
	assert.equal(phone.level.level, 'crit');
});

/* the survey: the noise floor every poll for 1.5-2.5 ms a radio, where
   iwinfo info costs 15-22 ms; luci.vantage survey sends it as a signed
   byte, rpcd's iwinfo survey (1.0.19) sent some as an unsigned one */
test('surveyNoise: the radio\'s channel, a signed byte, 0 as none', () => {
	const sv = [ { mhz: 2412, noise: 0 }, { mhz: 2437, noise: 146 }, { mhz: 5180, noise: -95 }, { mhz: 5975, noise: 135 }, { mhz: 5200, noise: 300 } ];
	assert.equal(model.surveyNoise(sv, 2437), -110, 'ath12k: 146 is -110 dBm');
	assert.equal(model.surveyNoise(sv, 5180), -95, 'already signed');
	assert.equal(model.surveyNoise(sv, 2412), null, '0: none');
	assert.equal(model.surveyNoise(sv, 5200), null, 'out of range');
	assert.equal(model.surveyNoise(sv, 2462), null, 'no entry for the channel');
	assert.equal(model.surveyNoise(sv, 0), null);
	assert.equal(model.surveyNoise(null, 2437), null);
});

test('build: the survey\'s noise floor wins, on the channel hostapd reports', () => {
	const r = raw();
	r.survey = { 'phy2g-ap0': [ { mhz: 2437, noise: 164 }, { mhz: 2462, noise: 160 } ] };
	assert.equal(model.build(r).radios[0].noise, -92, 'iwinfo info said -87');
	r.hapdStatus = { 'phy2g-ap0': { freq: 2462, channel: 11, bssid: '00:00:5e:00:53:aa' } };
	assert.equal(model.build(r).radios[0].noiseRaw, -96, 'moved to channel 11 before iwinfo info knew');
	r.survey = { 'phy2g-ap0': [ { mhz: 2462, noise: 0 } ] };
	assert.equal(model.build(r).radios[0].noise, -87, 'nothing there: iwinfo info\'s');
	r.survey = { 'phy6g-ap0': [ { mhz: 5975, noise: 135 } ] };
	const m = model.build(r);
	assert.equal(m.radios[1].noise, null, 'ath12k\'s placeholder stays unknown');
	assert.equal(m.radios[1].noiseRaw, -121, 'and is shown as one');
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
		[ '00:00:5e:00:53:02', 'Unknown device 53:02', 'lan2', 'lan', 10, 2, 2, true, 2500, false ],
		[ '00:00:5e:00:53:03', 'NAS', 'lan2', 'lan', null, 40, 2, true, 2500, false ],
		[ '00:00:5e:00:53:09', 'Unknown device 53:09', 'wan', null, null, 5, 1, false, 1000, true ]
	], 'the latest entry per MAC, a learned one before a static one; Wi-Fi ports and stations left out');
	assert.deepEqual(m.wiredHosts.map(h => h.plainName), [ 'desk', 'Unknown device', 'NAS', 'Unknown device' ]);
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

/* The gateway is the one plausible holder of the next hop's address in the host hints (macOf): any device gets its
   MAC listed under any address with one ARP request. Bridge entries here are as the plugin gives them: each has a
   bridge, and a port that is in no bridge (a router's wan) has none at all */
test('build: among the hosts that hold the gateway\'s address, the bridges\' entries say which one is the gateway', () => {
	const eth = { devtype: 'ethernet', speed: '1000F', carrier: true };
	const devs = { 'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'phy0-ap0' ] }, lan1: eth, lan2: eth, wan: eth, 'phy0-ap0': { devtype: 'wlan' } };
	const GW = '00:00:5e:00:53:01', LIAR = '00:00:5e:00:53:66', STA = '00:00:5e:00:53:20', MADEUP = '00:00:5e:00:53:99';
	const U = m => m.toUpperCase();
	const flags = m => m.wiredHosts.map(h => [ h.mac, h.gateway ]);
	const orders = (a, b, hop) => [ { [U(a)]: hop, [U(b)]: hop }, { [U(b)]: hop, [U(a)]: hop } ];

	/* a router: the LAN on a bridge, the line on a port of its own, so the bridges have no entry for the gateway */
	const lan = { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] };
	const wan = { interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '198.51.100.2', mask: 24 } ],
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '198.51.100.1' } ] };
	const hop = { ipaddrs: [ '198.51.100.1' ] }, onLan = { mac: LIAR, port: 'lan1', bridge: 'br-lan', seen: 1 };
	/* a LAN host with the address, listed after the gateway or before it: a host of the LAN, and the line stays */
	for (const hints of orders(GW, LIAR, hop)) {
		const m = model.build({ ifaces: [ lan, wan ], devs, hints, fdb: [ onLan ] });
		assert.deepEqual([ flags(m), m.uplink.iface, m.uplink.port ], [ [ [ LIAR, false ] ], 'wan', 'wan' ]);
	}
	/* a line whose far end has no MAC (PPPoE: no hint ever lists its peer): a host of a bridge is never its gateway, by the device's kind or its name */
	const ppp = Object.assign({}, wan, { proto: 'pppoe', l3_device: 'pppoe-wan' });
	for (const kind of [ { devtype: 'ppp', carrier: true }, { carrier: true } ])
		assert.deepEqual(flags(model.build({ ifaces: [ lan, ppp ], devs: Object.assign({ 'pppoe-wan': kind }, devs), hints: { [U(LIAR)]: hop }, fdb: [ onLan ] })), [ [ LIAR, false ] ]);
	/* a known limit, as in 1.0.20: alone with the address of an Ethernet line whose gateway no hint lists, a host
	   heard elsewhere is believed. The bridges of a wire's other VLANs hear the real gateway in just that way (below) */
	assert.deepEqual(flags(model.build({ ifaces: [ lan, wan ], devs, hints: { [U(LIAR)]: hop }, fdb: [ onLan ] })), [ [ LIAR, true ] ]);

	/* an access point: gateway and hosts share the bridge the line leaves through */
	const ap = [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ],
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ];
	const gwHop = { ipaddrs: [ '192.0.2.1' ] }, gwRow = { mac: GW, port: 'lan2', bridge: 'br-lan', seen: 1 }, liarRow = { mac: LIAR, port: 'lan1', bridge: 'br-lan', seen: 1 };
	const A = (hints, fdb, more) => model.build(Object.assign({ ifaces: ap, devs, hints, fdb }, more));
	const got = m => [ m.uplink.port, flags(m) ];
	/* one holder: the gateway and its port, as before */
	assert.deepEqual(got(A({ [U(GW)]: gwHop }, [ gwRow, liarRow ])), [ 'lan2', [ [ GW, true ], [ LIAR, false ] ] ]);
	/* two the line's bridge hears: neither, and no port is said to lead to the gateway */
	for (const hints of orders(GW, LIAR, gwHop))
		assert.deepEqual(got(A(hints, [ gwRow, liarRow ])), [ null, [ [ GW, false ], [ LIAR, false ] ] ]);
	/* a MAC no bridge has heard (made up as the sender of an ARP request) beside the gateway, which the line's bridge hears: the gateway */
	for (const hints of orders(GW, MADEUP, gwHop))
		assert.deepEqual(got(A(hints, [ gwRow ])), [ 'lan2', [ [ GW, true ] ] ]);
	/* a station of this device's own SSID with the address, beside the gateway or in its place: never the gateway */
	const wifi = { radio0: { up: true, config: { band: '2g', channel: '1', htmode: 'HE20' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] } };
	const air = { wifi, assoc: { 'phy0-ap0': [ { mac: U(STA), signal: -50 } ] } }, staRow = { mac: STA, port: 'phy0-ap0', bridge: 'br-lan', seen: 1 };
	for (const hints of orders(GW, STA, gwHop)) {
		const s = A(hints, [ gwRow, staRow ], air);
		assert.deepEqual([ got(s), s.clients.length ], [ [ 'lan2', [ [ GW, true ] ] ], 1 ]);
	}
	assert.deepEqual(got(A({ [U(STA)]: gwHop }, [ gwRow, staRow ], air)), [ null, [ [ GW, false ] ] ]);

	/* the far end of this device's own client or mesh interface is in that interface's station list, and many routers
	   answer for their address from the MAC their radio uses. It is no station of an access point interface: still a
	   holder, so a wired host of the same bridge with the address is one of two, and is not flagged in either order */
	const linked = Object.assign({}, devs, { 'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan1', 'phy0-link0' ] }, 'phy0-link0': { devtype: 'wlan', carrier: true } });
	for (const mode of [ 'sta', 'mesh' ]) {
		const more = { wifi: { radio0: { up: true, config: { band: '5g' }, interfaces: [ { ifname: 'phy0-link0', config: { ssid: 'bh', mode, network: [ 'lan' ] } } ] } },
			assoc: { 'phy0-link0': [ { mac: U(GW), signal: -50 } ] } };
		for (const hints of orders(GW, LIAR, gwHop))
			assert.deepEqual(flags(model.build(Object.assign({ ifaces: ap, devs: linked, hints, fdb: [ { mac: GW, port: 'phy0-link0', bridge: 'br-lan', seen: 1 }, liarRow ] }, more))), [ [ LIAR, false ] ], mode);
	}

	/* two bridges on one wire (a guest VLAN beside the LAN): the gateway's MAC is on both, and the entry kept for
	   the host list is the one heard last, the guest bridge's here. The gateway all the same, and the uplink is the
	   port of its entry on the line's bridge, not of the one kept */
	const trunk = Object.assign({ 'br-guest': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan2.20' ] }, 'lan2.20': { devtype: 'vlan', carrier: true } }, devs);
	const both2 = [ { mac: GW, port: 'lan2', bridge: 'br-lan', seen: 9 }, { mac: GW, port: 'lan2.20', bridge: 'br-guest', seen: 1 } ];
	const wire = model.build({ ifaces: ap, devs: trunk, hints: { [U(GW)]: gwHop }, fdb: both2 });
	assert.deepEqual([ wire.uplink.port, wire.wiredHosts.map(h => [ h.mac, h.bridge, h.gateway ]) ], [ 'lan2', [ [ GW, 'br-guest', true ] ] ]);
	/* a host of the guest bridge with the address: the gateway is the one the line's bridge hears */
	for (const hints of orders(GW, LIAR, gwHop)) {
		const guest = model.build({ ifaces: ap, devs: trunk, hints, fdb: both2.concat([ { mac: LIAR, port: 'lan2.20', bridge: 'br-guest', seen: 1 } ]) });
		assert.deepEqual([ guest.uplink.port, guest.wiredHosts.map(h => [ h.mac, h.gateway ]) ], [ 'lan2', [ [ GW, true ], [ LIAR, false ] ] ]);
	}

	/* the line on a VLAN of a bridge (br-lan.10), entries with their VLAN: the gateway is in the line's VLAN */
	const tagged = Object.assign({ 'br-lan.10': { devtype: 'vlan', carrier: true }, 'br-lan.20': { devtype: 'vlan', carrier: true } }, devs);
	const mgmt = [ Object.assign({}, ap[0], { l3_device: 'br-lan.10', device: 'br-lan.10' }),
		{ interface: 'guest', up: true, l3_device: 'br-lan.20', device: 'br-lan.20', 'ipv4-address': [ { address: '203.0.113.1', mask: 24 } ], route: [] } ];
	const in10 = { mac: GW, port: 'lan2', bridge: 'br-lan', vlan: 10, seen: 1 }, in20 = { mac: LIAR, port: 'lan1', bridge: 'br-lan', vlan: 20, seen: 1 };
	const V = (hints, fdb) => model.build({ ifaces: mgmt, devs: tagged, hints, fdb });
	assert.deepEqual(got(V({ [U(GW)]: gwHop }, [ in10 ])), [ 'lan2', [ [ GW, true ] ] ]);
	/* a host in another VLAN of that bridge with the address: not on the line, beside the gateway or alone */
	for (const hints of orders(GW, LIAR, gwHop))
		assert.deepEqual(got(V(hints, [ in10, in20 ])), [ 'lan2', [ [ GW, true ], [ LIAR, false ] ] ]);
	assert.deepEqual(got(V({ [U(LIAR)]: gwHop }, [ in10, in20 ])), [ null, [ [ GW, false ], [ LIAR, false ] ] ]);
	/* entries without a VLAN (a bridge that does not filter): on the line */
	assert.deepEqual(got(V({ [U(GW)]: gwHop }, [ gwRow ])), [ 'lan2', [ [ GW, true ] ] ]);
	/* the line on the bridge itself, the guests on its VLAN 20: an entry in VLAN 20 is the guest network's */
	const untagged = [ ap[0], mgmt[1] ];
	for (const hints of orders(GW, LIAR, gwHop))
		assert.deepEqual(got(model.build({ ifaces: untagged, devs: tagged, hints, fdb: [ gwRow, in20 ] })), [ 'lan2', [ [ GW, true ], [ LIAR, false ] ] ]);

	/* no attacker: the line on a device that is no bridge, while a bridge on the same wire hears the gateway
	   (management on eth0.99, eth0 itself in br-lan). The one holder is the gateway, as in 1.0.20 */
	const split = { 'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'eth0' ] }, eth0: eth, 'eth0.99': { devtype: 'vlan', carrier: true } };
	const own = [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', route: [] }, Object.assign({}, ap[0], { interface: 'mgmt', l3_device: 'eth0.99', device: 'eth0.99' }) ];
	const n2 = model.build({ ifaces: own, devs: split, hints: { [U(GW)]: gwHop }, fdb: [ { mac: GW, port: 'eth0', bridge: 'br-lan', seen: 1 } ] });
	assert.deepEqual([ n2.uplink.iface, flags(n2) ], [ 'mgmt', [ [ GW, true ] ] ]);
});

/* the next hop is found by its value, as an access point's address is (holders) */
test('build: an IPv6 gateway is the one host hint that holds the next hop, however either is spelled', () => {
	const devs = { 'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2' ] },
		lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' }, lan2: { devtype: 'ethernet', carrier: true, speed: '2500F' } };
	const GW = '00:00:5e:00:53:01', OTHER = '00:00:5e:00:53:66';
	const fdb = [ { mac: GW, port: 'lan2', bridge: 'br-lan', seen: 1 }, { mac: OTHER, port: 'lan1', bridge: 'br-lan', seen: 1 } ];
	const build = (nexthop, hints) => {
		const m = model.build({ ifaces: [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv6-address': [ { address: '2001:db8::10', mask: 64 } ],
			route: [ { target: '::', mask: 0, nexthop } ] } ], devs, hints, fdb });
		return [ m.uplink.port, m.wiredHosts.map(h => h.gateway) ];
	};
	const at = (mac, v6) => ({ [mac.toUpperCase()]: { ip6addrs: [ v6 ] } });
	for (const [ hop, hint ] of [ [ '2001:db8::1', '2001:db8::1' ], [ '2001:db8::1', '2001:DB8::1' ], [ '2001:db8::1', '2001:0db8:0:0:0:0:0:1' ], [ '2001:db8:0::1', '2001:db8::0001' ],
		[ '2001:DB8:0:0:0:0:0:1', '2001:db8::1' ] ])
		assert.deepEqual(build(hop, at(GW, hint)), [ 'lan2', [ true, false ] ], hop + ' / ' + hint);
	/* a second holder in another spelling counts as one: two on the line's bridge, neither */
	assert.deepEqual(build('2001:db8::1', Object.assign(at(GW, '2001:db8::1'), at(OTHER, '2001:0DB8::1'))), [ null, [ false, false ] ]);
	/* another address, or text that is none: no gateway, and nothing throws */
	for (const hint of [ '2001:db8::2', '2001:db8::1:0', '2001:db8:::1', '' ]) assert.deepEqual(build('2001:db8::1', at(GW, hint)), [ null, [ false, false ] ], hint);
	assert.deepEqual(build('2001:db8:::1', at(GW, '2001:db8:::1')), [ null, [ false, false ] ]);
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

/* review of 1.0.16 */
const up = (name, proto, dev, target, extra) => Object.assign({ interface: name, up: true, proto, device: dev, l3_device: dev,
	route: [ { target, mask: 0, nexthop: target === '::' ? '::' : '192.0.2.1' } ] }, extra);

test('a metric tie goes to the line the kernel takes, and the other line stays', () => {
	const ifaces = [ up('wan', 'dhcp', 'eth1', '0.0.0.0'), up('wanb', 'dhcp', 'eth2', '0.0.0.0') ];
	const kernel = [ { family: 4, dev: 'eth2', metric: 0 } ];
	const main = model.resolveUplink(ifaces, {}, [], null, kernel);
	assert.equal(main.iface, 'wanb');
	assert.deepEqual(model.extraUplinks(ifaces, {}, [], main, null, kernel).map(x => x.iface), [ 'wan' ]);
	assert.equal(model.resolveUplink(ifaces, {}, [], null, null).iface, 'wan', 'no answer: by name, as before');
	/* the metric still decides first */
	const lower = [ up('wan', 'dhcp', 'eth1', '0.0.0.0', { metric: 10 }), up('wanb', 'dhcp', 'eth2', '0.0.0.0', { metric: 20 }) ];
	lower.forEach(i => { i.route[0].metric = i.metric; });
	assert.equal(model.resolveUplink(lower, {}, [], null, [ { family: 4, dev: 'eth2', metric: 20 } ]).iface, 'wan');
});

test('6rd, 6in4 and 6to4 IPv6 belongs to the IPv4 line, not the local networks', () => {
	for (const proto of [ '6rd', '6in4', '6to4' ]) {
		const dev = `${proto}-wan6`, ifaces = [ up('wan', 'dhcp', 'eth1', '0.0.0.0'), up('wan6', proto, dev, '::', { 'ipv6-address': [ { address: '2001:db8::2', mask: 64 } ] }),
			{ interface: 'lan', up: true, proto: 'static', device: 'br-lan', l3_device: 'br-lan' } ];
		const kernel = [ { family: 4, dev: 'eth1', metric: 0 }, { family: 6, dev, metric: 0 } ];
		const main = model.resolveUplink(ifaces, {}, [], null, kernel);
		assert.equal(main.iface, 'wan', proto);
		assert.deepEqual(main.ifaces, [ 'wan', 'wan6' ], proto);
		assert.ok(main.ipv6.includes('2001:db8::2/64'), proto);
		assert.equal(main.tunnel, null, `${proto} is not a VPN`);
		assert.deepEqual(model.extraUplinks(ifaces, {}, [], main, null, kernel), [], proto);
		assert.deepEqual(model.networks(ifaces, [ main ]).map(n => n.name), [ 'lan' ], proto);
	}
});

test('with two lines, 6rd stays where it was: there is no telling which it rides', () => {
	const ifaces = [ up('wan', 'dhcp', 'eth1', '0.0.0.0'), up('wanb', 'dhcp', 'eth2', '0.0.0.0'), up('wanb6', '6rd', '6rd-wanb', '::') ];
	const main = model.resolveUplink(ifaces, {}, [], null, null);
	assert.deepEqual(main.ifaces, [ 'wan' ]);
	assert.deepEqual(model.networks(ifaces, [ main ].concat(model.extraUplinks(ifaces, {}, [], main))).map(n => n.name), [ 'wanb6' ]);
});

test('a WireGuard IPv6 default is still not part of the line', () => {
	const ifaces = [ up('wan', 'dhcp', 'eth1', '0.0.0.0'), up('wg0', 'wireguard', 'wg0', '::') ];
	const main = model.resolveUplink(ifaces, {}, [], null, [ { family: 4, dev: 'eth1', metric: 0 } ]);
	assert.deepEqual(main.ifaces, [ 'wan' ]);
});

test('PPPoE counts on the port under the session, which offloaded downloads do pass (#92)', () => {
	const devs = { eth1: { devtype: 'ethernet', statistics: { rx_bytes: 9e9, tx_bytes: 1e9 } }, 'pppoe-wan': { statistics: { rx_bytes: 1e3, tx_bytes: 1e9 } } };
	const ifaces = [ { interface: 'wan', up: true, proto: 'pppoe', device: 'eth1', l3_device: 'pppoe-wan', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ];
	const x = model.resolveUplink(ifaces, devs, [], null, null);
	assert.equal(x.statsDev, 'eth1');
	assert.equal(x.l3dev, 'pppoe-wan');
	assert.equal(x.stats.rx_bytes, 9e9);
	/* the port's counters unknown: the session's, as before */
	assert.equal(model.resolveUplink(ifaces, { 'pppoe-wan': devs['pppoe-wan'] }, [], null, null).statsDev, 'pppoe-wan');
	/* DHCP on a port is unchanged */
	assert.equal(model.resolveUplink([ up('wan', 'dhcp', 'eth1', '0.0.0.0') ], devs, [], null, null).statsDev, 'eth1');
});

test('two PPPoE sessions on one port keep their own counters', () => {
	const pppoe = (name, metric) => ({ interface: name, up: true, proto: 'pppoe', device: 'eth0', l3_device: 'pppoe-' + name, metric,
		route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1', metric } ] });
	const m = model.build({ ifaces: [ pppoe('wan', 10), pppoe('wanb', 20) ], devs: { eth0: { devtype: 'ethernet', statistics: { rx_bytes: 9 } },
		'pppoe-wan': { statistics: { rx_bytes: 1 } }, 'pppoe-wanb': { statistics: { rx_bytes: 2 } } } });
	assert.deepEqual(m.uplinks.map(x => x.statsDev), [ 'pppoe-wan', 'pppoe-wanb' ]);
	assert.deepEqual(m.uplinks.map(x => x.stats.rx_bytes), [ 1, 2 ], 'and their own totals in the drawer');
});

test('PPPoE on a DSA port stays on that port: the conduit carries the other ports too', () => {
	const devs = { wan: { devtype: 'dsa', 'hw-tc-offload': true, conduit: 'eth0' }, eth0: {}, 'pppoe-wan': {} };
	const ifaces = [ { interface: 'wan', up: true, proto: 'pppoe', device: 'wan', l3_device: 'pppoe-wan', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ];
	assert.equal(model.resolveUplink(ifaces, devs, [], null, null).statsDev, 'wan');
});

/* #110: on a router the uplink is the WAN; a station's IPv4 address is in
   its own network's subnet (the SSID's 'lan'), not the WAN's */
test('build: on a router, stations keep their LAN IPv4 address (not only IPv6)', () => {
	const r = raw();
	r.ifaces = [
		{ interface: 'loopback', up: true, l3_device: 'lo', device: 'lo' },
		{ interface: 'wan', up: true, l3_device: 'eth1', device: 'eth1', proto: 'dhcp', uptime: 100,
		  'ipv4-address': [ { address: '203.0.113.10', mask: 24 } ],
		  route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ], 'dns-server': [ '203.0.113.1' ] },
		{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', proto: 'static', uptime: 100,
		  'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ] }
	];
	r.devs = Object.assign({}, DEVS, { eth1: { devtype: 'ethernet', speed: '1000F', carrier: true, statistics: { rx_bytes: 1, tx_bytes: 2 } } });
	r.hints = { '00:00:5E:00:53:01': { name: 'office-printer', ipaddrs: [ '192.0.2.44' ], ip6addrs: [ '2001:db8::44' ] } };
	const m = model.build(r);
	assert.equal(m.uplink.iface, 'wan', 'a router: the WAN is the uplink');
	const printer = m.clients.filter(c => c.mac === '00:00:5e:00:53:01')[0];
	assert.deepEqual(printer.ips, [ '192.0.2.44', '2001:db8::44' ]);
	/* a network without an IPv4 address of its own: the uplink's, as before */
	r.ifaces[2]['ipv4-address'] = [];
	r.ifaces[1]['ipv4-address'] = [ { address: '192.0.2.200', mask: 24 } ];
	assert.deepEqual(model.build(r).clients.filter(c => c.mac === '00:00:5e:00:53:01')[0].ips[0], '192.0.2.44');
});

/* ------------------------------------------- paired access points (#127)
   vantage.collector report: what the paired access points report only
   adds entries marked `ap`; this device's own view never changes. */

const AP1 = '0123456789abcdef', AP2 = 'fedcba9876543210';
const HALL_MAC = '02:00:5e:10:00:01', GW_MAC = '00:00:5e:00:53:fe';
/* a router: lan bridge (lan1 leads to ap-hall, lan2), one Wi-Fi
   network, the WAN and its gateway */
function router(collector, extra) {
	return Object.assign({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] }
		],
		devs: {
			'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'phy0-ap0' ], macaddr: '00:00:5e:00:53:f0' },
			lan1: { devtype: 'ethernet', speed: '1000F', carrier: true, macaddr: '00:00:5e:00:53:f0' },
			lan2: { devtype: 'ethernet', speed: '1000F', carrier: true, macaddr: '00:00:5e:00:53:f0' },
			wan: { devtype: 'ethernet', speed: '1000F', carrier: true, macaddr: '00:00:5e:00:53:f1' },
			'phy0-ap0': { devtype: 'wlan', macaddr: '00:00:5e:00:53:f2' }
		},
		wifi: { radio0: { up: true, config: { band: '5g', channel: '36', htmode: 'HE80' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] } },
		iwinfo: { 'phy0-ap0': { bssid: '00:00:5E:00:53:F2', channel: 36, frequency: 5180 } },
		assoc: { 'phy0-ap0': [ { mac: '00:00:5E:00:53:01', signal: -50, rx: { rate: 866700, bytes: 10 }, tx: { rate: 866700, bytes: 20 } } ] },
		hints: {
			'00:00:5E:00:53:01': { name: 'laptop', ipaddrs: [ '192.0.2.101' ] },
			'00:00:5E:00:53:21': { name: 'phone', ipaddrs: [ '192.0.2.121' ] },
			'00:00:5E:00:53:31': { name: 'printer', ipaddrs: [ '192.0.2.131' ] },
			'00:00:5E:00:53:FE': { ipaddrs: [ '203.0.113.1' ] }
		},
		fdb: [
			{ mac: HALL_MAC, port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-lan', seen: 2 },
			{ mac: '00:00:5e:00:53:32', port: 'lan2', bridge: 'br-lan', seen: 2 }
		],
		collector
	}, extra);
}
const ssid = (ifname, band, freq, bssid) => ({ ifname, bssid, ssid: 'Home', freq, channel: band === '2g' ? 6 : 36, band });
function report(extra) {
	return Object.assign({ name: 'OpenWrt', model: 'Example AP', uptime: 3600, mac: HALL_MAC,
		ssids: [ ssid('phy1-ap0', '5g', 5180, '02:00:5e:10:00:11'), ssid('phy0-ap0', '2g', 2437, '02:00:5e:10:00:10') ],
		stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -61, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000, connected: 120 } ],
		wired: [ { mac: '00:00:5e:00:53:41', port: 'lan3', speed: 100, rx: 4000, tx: 9000 }, { mac: '00:00:5e:00:53:42', port: 'lan3', speed: 100, rx: null, tx: null } ] }, extra);
}
const ap = (id, name, rep, extra) => Object.assign({ id, name, addr: '192.0.2.10', state: 'ok', error: null, age: 3, report: rep }, extra);
/* this device's entries, without what a paired access point may add */
const own = m => ({ clients: m.clients.filter(c => !c.ap), wired: m.wiredHosts.filter(h => !h.ap).map(h => { const x = Object.assign({}, h); delete x.behind; return x; }) });

test('collector: the report is checked again here: ids, the pairing name, states, ranges, junk dropped', () => {
	for (const r of [ undefined, null, 'x', [], {}, { aps: 'x' }, { aps: [] } ]) assert.deepEqual(model.collectorAps(r), [], JSON.stringify(r));
	const aps = model.collectorAps({ aps: [
		ap(AP1, 'ap-hall', report({ name: 'Evil‮', model: 'm'.repeat(80),
			ssids: [ ssid('phy1-ap0', 'x', 5180, 'junk'), { ifname: 'bad name', ssid: 'X' }, ssid('phy1-ap0', '2g', 2412), { ifname: 'phy2-ap0', ssid: 'Guest\u0007', freq: 5955 },
				ssid(':wired', '5g', 5180), ssid('a'.repeat(16), '5g', 5180) ],
			stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: 0, rxRate: -1, txRate: 'x', rx: -5, tx: 1e15, connected: -1 },
				{ mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -40 }, { mac: '00:00:5e:00:53:22', ifname: 'nowhere' },
				{ mac: '01:00:5e:00:53:01', ifname: 'phy1-ap0' }, { mac: 'junk', ifname: 'phy1-ap0' }, null ],
			wired: [ { mac: '00:00:5e:00:53:41', port: 'lan3', speed: -1 }, { mac: '00:00:5e:00:53:42', port: 'lan 3' }, { mac: '00:00:5e:00:53:43' } ] })),
		ap(AP1, 'twice', report()),
		ap('ABCDEF0123456789', 'upper', report()),
		ap('0123', 'short', report()),
		ap(AP2, '-bad name', report(), { addr: '999.1.1.1', state: 'weird', error: 'boom', age: -1 }),
		ap('1111111111111111', 'ap-den', report(), { state: 'offline', age: 90, addr: '2001:db8::10' }),
		ap('2222222222222222', 'ap-loft', null, { state: 'ok', addr: 'http://example.com/' }),
		ap('3333333333333333', 'ap-shed', null, { state: 'error', error: 'hostkey' }),
		ap('4444444444444444', 'ap-barn', null, { state: 'offline', error: 'unreachable', age: null }),
		ap('5555555555555555', 'ap-yard', null, { state: 'offline', error: 'hostkey' }),
		ap('6666666666666666', 'ap-roof', null, { state: 'error', error: 'missing' }),
		ap('7777777777777777', 'ap-gate', report(), { state: 'ok', error: 'timeout' })
	] });
	assert.deepEqual(aps.map(a => [ a.id, a.name, a.addr, a.state, a.error, a.age ]), [
		[ AP1, 'ap-hall', '192.0.2.10', 'ok', null, 3 ],
		[ AP2, AP2, null, 'error', 'invalid', null ],
		[ '1111111111111111', 'ap-den', '2001:db8::10', 'offline', null, 90 ],
		[ '2222222222222222', 'ap-loft', null, 'error', 'invalid', 3 ],
		[ '3333333333333333', 'ap-shed', '192.0.2.10', 'error', 'hostkey', 3 ],
		[ '4444444444444444', 'ap-barn', '192.0.2.10', 'offline', 'unreachable', null ],
		[ '5555555555555555', 'ap-yard', '192.0.2.10', 'offline', null, 3 ],
		[ '6666666666666666', 'ap-roof', '192.0.2.10', 'error', 'missing', 3 ],
		[ '7777777777777777', 'ap-gate', '192.0.2.10', 'ok', null, 3 ]
	], 'a bad or repeated id is dropped; a bad name is the id; ok without a report is an error; offline says why it could not be reached; ok stands whatever the last fetch said');
	const a = aps[0];
	assert.equal(a.info.name, 'Evil�', 'what it calls itself is only a detail, made safe');
	assert.equal(Array.from(a.info.model).length, 64);
	assert.deepEqual(a.nodes.map(n => [ n.id, n.ssid, n.bssid, n.band, n.clients ]), [
		[ 'phy1-ap0', 'Home', null, '5g', 0 ], [ 'phy2-ap0', 'Guest�', null, '6g', 0 ]
	], 'one node per interface (a netdev name: no colon, 15 characters), the band from the frequency when unknown');
	assert.deepEqual(a.sta, [ { mac: '00:00:5e:00:53:21', node: 'phy1-ap0', signal: null, rxRate: null, txRate: null, rxPhy: null, txPhy: null, rx: null, tx: null, connected: null } ]);
	assert.deepEqual(a.hosts, [ { mac: '00:00:5e:00:53:41', port: 'lan3', speed: null, rx: null, tx: null } ]);
	assert.deepEqual([ a.clients, a.wired, a.rate ], [ 0, 0, null ], 'counted by build(), from what it gives it');
	for (const x of aps.slice(1, 7)) assert.deepEqual([ x.nodes, x.sta, x.hosts, x.clients, x.wired ], [ [], [], [], 0, 0 ], x.id + ': not reporting, nothing of its report');
	assert.equal(aps[2].info.model, 'Example AP', 'an offline one still has what it called itself');
});

/* #164: a network whose passwords (or RADIUS) give a station its VLAN. hostapd makes an interface for each VLAN,
   luci.vantage wireless names them, and iwinfo lists the stations on one under it alone */
test('a network\'s VLAN interfaces: their stations are the network\'s clients, and no wired hosts', () => {
	const sta = (n, bytes) => ({ mac: '00:00:5E:00:53:0' + n, signal: -50 - n, rx: { rate: 866700, bytes }, tx: { rate: 866700, bytes: bytes * 2 } });
	const wifi = { radio0: { up: true, config: { band: '5g', channel: '36', htmode: 'HE80' }, interfaces: [
		{ ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] }, vlans: [ 'wlan0.1', 'vl-iot', 'wlan0.1', 'phy0-ap1', 'bad name', 5 ] },
		{ ifname: 'phy0-ap1', config: { ssid: 'Guest', mode: 'ap', network: [ 'lan' ] }, vlans: 'wlan0.9' } ] } };
	assert.deepEqual({ ...model.wifiVlans(wifi) }, { 'phy0-ap0': [ 'wlan0.1', 'vl-iot' ] }, 'names of devices, each once, none a network\'s own interface');
	assert.deepEqual(Object.keys(model.wifiVlans(null)), []);
	const many = { radio0: { interfaces: [ { ifname: 'a', vlans: Array.from({ length: 20 }, (_, i) => 'a.' + i) }, { ifname: 'b', vlans: Array.from({ length: 20 }, (_, i) => 'b.' + i) } ] } };
	assert.deepEqual(Object.values(model.wifiVlans(many)).map(l => l.length), [ 20, 12 ], '32 in all');
	const m = model.build(router(null, {
		wifi,
		ifaces: router(null).ifaces.concat([ { interface: 'iot', up: true, l3_device: 'br-iot', device: 'br-iot', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ], route: [] } ]),
		assoc: { 'phy0-ap0': [ sta(1, 10) ], 'wlan0.1': [ sta(5, 100) ], 'vl-iot': [ sta(6, 1000), { mac: 'junk' } ], 'wlan0.9': [ sta(9, 1) ] },
		hapd: { 'phy0-ap0': { clients: { '00:00:5e:00:53:05': { he: true, wmm: true } } } },
		hints: Object.assign({}, router(null).hints, { '00:00:5E:00:53:05': { name: 'camera', ipaddrs: [ '198.51.100.5', '192.0.2.105', '203.0.113.9' ] } }),
		/* the bridges learn them on those interfaces: a name of hostapd's choosing is no Ethernet port */
		fdb: router(null).fdb.concat([ { mac: '00:00:5e:00:53:05', port: 'wlan0.1', bridge: 'br-iot', seen: 1 }, { mac: '00:00:5e:00:53:06', port: 'vl-iot', bridge: 'br-iot', seen: 1 },
			/* and one that is no station (a device behind a client there): heard on a Wi-Fi port, so no wired host either */
			{ mac: '00:00:5e:00:53:77', port: 'vl-iot', bridge: 'br-iot', seen: 1 } ])
	}));
	assert.deepEqual(m.clients.map(c => [ c.mac, c.ssid, c.ifname, c.vlanIf ]), [
		[ '00:00:5e:00:53:01', 'Home', 'phy0-ap0', null ], [ '00:00:5e:00:53:05', 'Home', 'phy0-ap0', 'wlan0.1' ], [ '00:00:5e:00:53:06', 'Home', 'phy0-ap0', 'vl-iot' ]
	], 'under its network; one named for a network that does not list it is nobody\'s');
	const cam = m.clients[1];
	assert.deepEqual([ cam.name, cam.ips, cam.caps.he, cam.wmm, cam.rxBytes, cam.txBytes, cam.signal ], [ 'camera', [ '198.51.100.5', '192.0.2.105' ], true, true, 100, 200, -55 ],
		'an address on any network of this device, what hostapd knows of it, its own counters');
	assert.deepEqual(m.ssids.map(x => [ x.ifname, x.vlans, x.clients ]), [ [ 'phy0-ap0', [ 'wlan0.1', 'vl-iot' ], 3 ], [ 'phy0-ap1', [], 0 ] ]);
	assert.deepEqual([ m.radios[0].clients, m.radios[0].ifnames ], [ 3, [ 'phy0-ap0', 'phy0-ap1' ] ], 'counted on the radio; its interfaces are the networks\' own');
	assert.deepEqual(m.wiredHosts.map(h => h.mac).sort(), [ HALL_MAC, '00:00:5e:00:53:31', '00:00:5e:00:53:32' ].sort(), 'and none of them a wired host');
	/* without the plugin's list (1.2.0's, a driver cfg80211 does not see) nothing changes: a name of hostapd's choosing
	   is an Ethernet port again */
	const plain = model.build(router(null, { assoc: { 'phy0-ap0': [ sta(1, 10) ], 'wlan0.1': [ sta(5, 100) ] }, fdb: router(null).fdb.concat([ { mac: '00:00:5e:00:53:77', port: 'vl-iot', bridge: 'br-lan', seen: 1 } ]) }));
	assert.deepEqual(plain.clients.map(c => [ c.mac, c.vlanIf ]), [ [ '00:00:5e:00:53:01', null ] ]);
	assert.ok(plain.wiredHosts.some(h => h.mac === '00:00:5e:00:53:77'));
});

/* #167, #164: a router whose VLANs are devices of their own (eth0.1, eth0.3: a switch's CPU port), and an access
   point that bridges each to a network of its own. The router hears the access point on eth0.1 and its IoT
   bridge, with the stations on it, on eth0.3 */
test('paired access points: the wire is the port or another VLAN of its device; an address the access point calls its own is no host', () => {
	const IOT_BR = '02:00:5e:10:00:03', FAR = '02:00:5e:10:00:04', STA = '00:00:5e:00:53:21', OTHER = '00:00:5e:00:53:33';
	const vlan = { type: 'VLAN', devtype: 'vlan', carrier: true };
	const build = (rep, fdb, more) => model.build(router({ aps: [ ap(AP1, 'ap-hall', rep) ] }, Object.assign({}, more, {
		ifaces: router(null).ifaces.concat([ { interface: 'iot', up: true, l3_device: 'br-iot', device: 'br-iot', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ], route: [] } ]),
		devs: Object.assign({}, router(null).devs, {
			'br-lan': { devtype: 'bridge', 'bridge-members': [ 'eth0.1', 'lan2', 'phy0-ap0' ], macaddr: '00:00:5e:00:53:f0' },
			'br-iot': { devtype: 'bridge', 'bridge-members': [ 'eth0.3' ], macaddr: '00:00:5e:00:53:f0' },
			eth0: { devtype: 'ethernet', carrier: true }, 'eth0.1': vlan, 'eth0.3': vlan
		}),
		fdb: [
			{ mac: HALL_MAC, port: 'eth0.1', bridge: 'br-lan', seen: 1 },
			{ mac: IOT_BR, port: 'eth0.3', bridge: 'br-iot', seen: 1 },
			{ mac: STA, port: 'eth0.3', bridge: 'br-iot', seen: 1 },
			{ mac: OTHER, port: 'eth0.3', bridge: 'br-iot', seen: 1 },
			{ mac: FAR, port: 'lan2', bridge: 'br-lan', seen: 1 }
		].concat(fdb || [])
	})));
	const listed = m => m.wiredHosts.map(h => [ h.mac, h.port, h.peers ]);
	/* a report from before 1.2.1 names one address: its bridges are hosts, as they were */
	const before = build(report({ wired: [], stations: [] }));
	assert.deepEqual(listed(before), [ [ HALL_MAC, 'eth0.1', 1 ], [ IOT_BR, 'eth0.3', 3 ], [ STA, 'eth0.3', 3 ], [ OTHER, 'eth0.3', 3 ], [ FAR, 'lan2', 1 ] ]);
	const m = build(report({ wired: [], macs: [ HALL_MAC, IOT_BR, FAR, '00:00:5e:00:53:f0', GW_MAC ] }));
	assert.deepEqual(listed(m), [ [ HALL_MAC, 'eth0.1', 1 ], [ OTHER, 'eth0.3', 1 ], [ FAR, 'lan2', 1 ] ],
		'its bridge on another VLAN of the wire is gone, and so is its station there; an address heard on another port stays');
	const sta = m.clients.filter(c => c.mac === STA)[0];
	assert.deepEqual([ sta.ap.name, sta.ap.node ], [ 'ap-hall', 'phy1-ap0' ], 'the station is the access point\'s');
	assert.deepEqual(m.wiredHosts.filter(h => h.mac === HALL_MAC).length, 1, 'and the access point itself stays, once');
	/* none is taken unseen: what is left out is named on the access point's own entry */
	assert.deepEqual(m.wiredHosts.filter(h => h.mac === HALL_MAC)[0].own, { id: AP1, name: 'ap-hall', macs: [ '02:00:5E:10:00:03' ] });
	assert.ok(m.wiredHosts.every(h => h.mac === HALL_MAC || !h.own) && before.wiredHosts.every(h => !h.own));
	/* A second access point on the same wire. Its own MAC is no one else's to claim; nor is an address that it reports
	   too, as its own or its station: a contested claim takes nothing */
	const DEN_MAC = '02:00:5e:10:00:09', den = (rep) => ap(AP2, 'ap-den', report(Object.assign({ mac: DEN_MAC, wired: [], stations: [] }, rep)));
	const two = (hallRep, denRep, fdb) => model.build(router({ aps: [ ap(AP1, 'ap-hall', report(Object.assign({ wired: [], stations: [] }, hallRep))), den(denRep) ] }, {
		devs: Object.assign({}, router(null).devs, { 'br-iot': { devtype: 'bridge', 'bridge-members': [ 'eth0.3' ] }, 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'eth0.1', 'lan2', 'phy0-ap0' ] },
			eth0: { devtype: 'ethernet', carrier: true }, 'eth0.1': vlan, 'eth0.3': vlan }),
		fdb: [ { mac: HALL_MAC, port: 'eth0.1', bridge: 'br-lan', seen: 1 }, { mac: DEN_MAC, port: 'eth0.1', bridge: 'br-lan', seen: 1 },
			{ mac: IOT_BR, port: 'eth0.3', bridge: 'br-iot', seen: 1 }, { mac: OTHER, port: 'eth0.3', bridge: 'br-iot', seen: 1 } ].concat(fdb || [])
	}));
	const both = (hallMacs, denRep) => two({ macs: hallMacs }, denRep).wiredHosts.map(h => h.mac);
	assert.deepEqual(both([ IOT_BR, OTHER ], {}), [ HALL_MAC, DEN_MAC ], 'the control: uncontested, both are its own');
	assert.deepEqual(both([ DEN_MAC, IOT_BR ], {}), [ HALL_MAC, DEN_MAC, OTHER ], 'another access point\'s MAC stays (and what it did not claim)');
	assert.deepEqual(both([ IOT_BR, OTHER ], { macs: [ OTHER ] }), [ HALL_MAC, DEN_MAC, OTHER ], 'two call it their own: it stays');
	/* #167 as 1.2.1 left it: each access point hears the other's bridge on the wire and lists it among its wired hosts,
	   which contested both claims, so both bridges stayed, each "behind" the other one. A wired host's claim contests none */
	assert.deepEqual(both([ IOT_BR, OTHER ], { wired: [ { mac: OTHER, port: 'lan2', speed: 100, rx: null, tx: null } ] }), [ HALL_MAC, DEN_MAC ], 'the other\'s wired host is its own all the same');
	const DEN_BR = '02:00:5e:10:00:0a', seenOn = (mac) => [ { mac, port: 'eth0.3', speed: 1000, rx: null, tx: null } ];
	const cross = two({ macs: [ HALL_MAC, IOT_BR ], wired: seenOn(DEN_BR).concat(seenOn(OTHER)) }, { macs: [ DEN_MAC, DEN_BR ], wired: seenOn(IOT_BR) },
		[ { mac: DEN_BR, port: 'eth0.3', bridge: 'br-iot', seen: 1 } ]);
	assert.deepEqual(cross.wiredHosts.map(h => [ h.mac, h.own ? h.own.macs : null, h.behind ? h.behind.name : null ]),
		[ [ HALL_MAC, [ '02:00:5E:10:00:03' ], null ], [ DEN_MAC, [ '02:00:5E:10:00:0A' ], null ], [ OTHER, null, 'ap-hall' ] ],
		'each bridge is on its own access point\'s entry; a host one of them lists keeps its note');
	assert.ok(cross.offline.every(c => c.mac !== IOT_BR && c.mac !== DEN_BR));
	assert.deepEqual(both([ IOT_BR, OTHER ], { stations: [ { mac: IOT_BR, ifname: 'phy1-ap0', signal: -60 } ] }), [ HALL_MAC, DEN_MAC ], 'the other\'s station is that station, as before');
	/* Pre-release review of 1.2.1. A name given to one of those addresses while it was listed as a device: it is there,
	   on the access point's entry, and not among the named devices that are not connected */
	const named = aliases => build(report({ wired: [], stations: [], macs: [ HALL_MAC, IOT_BR ] }), null, { aliases });
	const withName = named({ [IOT_BR]: { name: 'Camera', sid: 'cfg01' }, '00:00:5e:00:53:99': { name: 'Tablet', sid: 'cfg02' } });
	assert.deepEqual(withName.offline.map(c => c.name), [ 'Tablet' ], 'only the one that is nowhere');
	assert.ok(withName.wiredHosts.every(h => h.mac !== IOT_BR));
	/* An access point that is itself another one's station (a wireless link): its entry is that station, no wired host,
	   so there is nothing here to name its addresses on, and they stay listed */
	const linked = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ wired: [], stations: [], macs: [ HALL_MAC, IOT_BR ] })),
		den({ stations: [ { mac: HALL_MAC, ifname: 'phy1-ap0', signal: -60 } ] }) ] }, {
		devs: Object.assign({}, router(null).devs, { 'br-iot': { devtype: 'bridge', 'bridge-members': [ 'eth0.3' ] }, 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'eth0.1', 'lan2', 'phy0-ap0' ] },
			eth0: { devtype: 'ethernet', carrier: true }, 'eth0.1': vlan, 'eth0.3': vlan }),
		fdb: [ { mac: HALL_MAC, port: 'eth0.1', bridge: 'br-lan', seen: 1 }, { mac: DEN_MAC, port: 'eth0.1', bridge: 'br-lan', seen: 1 }, { mac: IOT_BR, port: 'eth0.3', bridge: 'br-iot', seen: 1 } ]
	}));
	assert.deepEqual(linked.clients.filter(c => c.mac === HALL_MAC).map(c => c.ap.name), [ 'ap-den' ], 'the control: it is ap-den\'s station');
	assert.deepEqual(linked.wiredHosts.map(h => [ h.mac, !!h.own ]), [ [ DEN_MAC, false ], [ IOT_BR, false ] ], 'its bridge is not taken unseen');
	/* an address it reports as its station and as its own: that station, once, and on no list of its own addresses */
	const twice = build(report({ wired: [], macs: [ HALL_MAC, STA, IOT_BR ] }));
	assert.equal(twice.clients.filter(c => c.mac === STA).length, 1);
	assert.deepEqual(twice.wiredHosts.filter(h => h.mac === HALL_MAC)[0].own.macs, [ '02:00:5E:10:00:03' ]);
	/* The wire stops short of a line's own port. A bridged WAN on eth0.2 beside the LAN's eth0.1: what is heard there is
	   upstream, and an access point on the LAN has none of it, as its own address or as its station */
	const MODEM = '00:00:5e:00:53:a7';
	const upstream = rep => model.build(router({ aps: [ ap(AP1, 'ap-hall', report(Object.assign({ wired: [], stations: [] }, rep))) ] }, {
		ifaces: [ router(null).ifaces[0], { interface: 'wan', up: true, l3_device: 'br-wan', device: 'br-wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
			route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] } ],
		devs: Object.assign({}, router(null).devs, { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'eth0.1', 'lan2', 'phy0-ap0' ] },
			'br-wan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'eth0.2' ] }, eth0: { devtype: 'ethernet', carrier: true }, 'eth0.1': vlan, 'eth0.2': vlan }),
		fdb: [ { mac: HALL_MAC, port: 'eth0.1', bridge: 'br-lan', seen: 1 }, { mac: MODEM, port: 'eth0.2', bridge: 'br-wan', seen: 1 }, { mac: GW_MAC, port: 'eth0.2', bridge: 'br-wan', seen: 1 } ]
	}));
	for (const rep of [ { macs: [ HALL_MAC, MODEM ] }, { stations: [ { mac: MODEM, ifname: 'phy1-ap0', signal: -60 } ] } ]) {
		const u = upstream(rep);
		assert.deepEqual([ u.uplink.port, u.wiredHosts.map(h => h.mac).sort(), u.clients.filter(c => c.mac === MODEM).length, u.wiredHosts.some(h => h.own) ],
			[ 'eth0.2', [ HALL_MAC, MODEM, GW_MAC ].sort(), 0, false ], JSON.stringify(Object.keys(rep)));
	}
	/* an address anyone could claim: never one this device has no wire for, the gateway's or its own */
	const gw = build(report({ wired: [], stations: [], macs: [ GW_MAC, OTHER ] }), [ { mac: GW_MAC, port: 'eth0.3', bridge: 'br-iot', seen: 1 } ]);
	assert.deepEqual(listed(gw).map(h => h[0]), [ HALL_MAC, IOT_BR, STA, FAR, GW_MAC ], 'the gateway stays; a host on its wire that it calls its own is taken at its word');
	const lost = model.build(Object.assign(router({ aps: [ ap(AP1, 'ap-hall', report({ wired: [], stations: [], macs: [ '00:00:5e:00:53:32' ] })) ] }), { fdb: router(null).fdb.filter(h => h.mac !== HALL_MAC) }));
	assert.ok(lost.wiredHosts.some(h => h.mac === '00:00:5e:00:53:32'), 'an access point this device does not hear has no wire');
	/* the checks of collectorAps: MACs of one device, each once, of the first 64 sent, and only from one that reports */
	const a = model.collectorAps({ aps: [
		ap(AP1, 'ap-hall', report({ macs: [ IOT_BR.toUpperCase(), IOT_BR, 'junk', '01:00:5e:00:53:01', null, FAR ].concat(Array.from({ length: 80 }, (_, i) => '02:00:5e:20:00:' + i.toString(16).padStart(2, '0'))) })),
		ap(AP2, 'ap-den', report({ macs: [ IOT_BR ] }), { state: 'offline' }), ap('1111111111111111', 'ap-old', report()) ] });
	assert.deepEqual([ a[0].macs.slice(0, 2), a[0].macs.length, a[1].macs, a[2].macs ], [ [ IOT_BR, FAR ], 60, [], [] ]);
});

test('collector: caps: 16 access points, 16 SSIDs, 256 stations each and 1024 in all, 128 wired hosts each', () => {
	const hex = (n, w) => n.toString(16).padStart(w, '0');
	const mac = n => '02:00:5e:' + hex(n >> 16 & 255, 2) + ':' + hex(n >> 8 & 255, 2) + ':' + hex(n & 255, 2);
	let n = 0;
	const many = Array.from({ length: 20 }, (x, i) => ap(hex(i + 1, 16), 'ap-' + i, report({
		ssids: Array.from({ length: 20 }, (y, k) => ssid('phy0-ap' + k, '5g', 5180)),
		stations: Array.from({ length: 300 }, () => ({ mac: mac(++n), ifname: 'phy0-ap0', signal: -50 })),
		wired: Array.from({ length: 200 }, () => ({ mac: mac(++n), port: 'lan1' }))
	})));
	const aps = model.collectorAps({ aps: many });
	assert.equal(aps.length, 16);
	assert.deepEqual(aps.slice(0, 5).map(a => [ a.nodes.length, a.sta.length, a.hosts.length ]), [ [ 16, 256, 128 ], [ 16, 256, 128 ], [ 16, 256, 128 ], [ 16, 256, 128 ], [ 16, 0, 128 ] ]);
	assert.equal(aps.reduce((s, a) => s + a.sta.length, 0), 1024);
	const m = model.build(router({ aps: many }));
	assert.equal(m.clients.filter(c => c.ap).length, 1024);
	assert.equal(m.wiredHosts.filter(h => h.ap).length, 16 * 128);
	assert.deepEqual([ m.accessPoints.reduce((s, a) => s + a.clients, 0), m.accessPoints.reduce((s, a) => s + a.wired, 0) ], [ 1024, 16 * 128 ]);
	assert.ok(m.accessPoints.every(a => !('sta' in a) && !('hosts' in a)), 'the reports themselves go no further than build()');
});

test('build: no paired access point (no reply, a failed call, none paired) changes nothing', () => {
	const base = model.build(router(undefined));
	assert.deepEqual(base.accessPoints, []);
	for (const c of [ null, {}, 'junk', [], { aps: [] }, { aps: 'x' }, { aps: [ null, { id: 'nope' } ] } ]) {
		const m = model.build(router(c));
		assert.deepEqual(m, base, JSON.stringify(c));
	}
	assert.ok(base.clients.concat(base.wiredHosts).every(c => !('ap' in c) && !('behind' in c)), 'no field of its own either');
});

test('build: a paired access point\'s stations and wired hosts are added, marked ap, with what it reports (rx from the device)', () => {
	const base = model.build(router(null));
	const m = model.build(router({ aps: [ ap(AP1, 'ap-hall', report()) ] }));
	assert.deepEqual(own(m), own(base), 'this device\'s own entries as they were');
	const c = m.clients.filter(x => x.ap)[0];
	assert.deepEqual([ c.mac, c.name, c.nameSource, c.ips, c.ssid, c.band, c.signal, c.level.level, c.connected ],
		[ '00:00:5e:00:53:21', 'phone', 'dhcp', [ '192.0.2.121' ], 'Home', '5g', -61, 'ok', 120 ], 'named and addressed by this device\'s host hints');
	assert.deepEqual(c.ap, { id: AP1, name: 'ap-hall', addr: '192.0.2.10', node: 'phy1-ap0', bssid: '02:00:5e:10:00:11', freq: 5180, channel: 36, rate: { rx: 8000, tx: 64000 } });
	assert.deepEqual([ c.rx.rate, c.rx.label, c.tx.rate, c.tx.label ], [ 72200, '72.2 Mbit/s', 144400, '144 Mbit/s' ], 'link rates in kbit/s, rx from the station');
	assert.deepEqual([ c.ifname, c.radio, c.ssidId, c.rxBytes, c.txBytes ], [ null, null, null, null, null ], 'no interface, radio or counters here');
	const by = Object.fromEntries(m.wiredHosts.filter(h => h.ap).map(h => [ h.mac, h ]));
	assert.deepEqual(Object.keys(by), [ '00:00:5e:00:53:41', '00:00:5e:00:53:42' ]);
	assert.deepEqual([ by['00:00:5e:00:53:41'].port, by['00:00:5e:00:53:41'].gateway, by['00:00:5e:00:53:41'].ap ],
		[ '', false, { id: AP1, name: 'ap-hall', addr: '192.0.2.10', port: 'lan3', speed: { mbps: 100, duplex: null }, rate: { rx: 4000, tx: 9000 } } ]);
	assert.equal(by['00:00:5e:00:53:42'].ap.rate, null, 'a shared port: no rate of its own');
	const a = m.accessPoints[0];
	assert.deepEqual([ a.name, a.clients, a.wired, a.rate ], [ 'ap-hall', 1, 2, { rx: 12000, tx: 73000 } ]);
	assert.deepEqual(a.nodes.map(n => [ n.id, n.band, n.clients ]), [ [ 'phy1-ap0', '5g', 1 ], [ 'phy0-ap0', '2g', 0 ] ]);
});

/* mDNS names only when uncontested (names.mdnsForStations): the entries a
   report adds are parties as this device's own are */
test('build: an address the hints give an entry of this device and an entry a report adds is named by mDNS for neither', () => {
	const X = '192.0.2.44';
	const build = (hints, collector, extra) => model.build(router(collector,
		Object.assign({ hints: Object.assign({}, router(null).hints, hints), mdns: { [X]: 'printer-mdns' } }, extra)));
	const holders = m => m.clients.concat(m.wiredHosts).filter(e => e.ips.indexOf(X) >= 0).map(e => [ e.mac, e.ap ? e.ap.name : null, e.nameSource ]);
	const neither = (m, own, added, what) => {
		assert.deepEqual(holders(m).map(e => e.slice(0, 2)), [ [ own, null ], [ added, 'ap-hall' ] ], what + ': both hold the address');
		for (const e of holders(m)) assert.notEqual(e[2], 'mdns', what + ': ' + e[0]);
	};
	/* a station of this device, and a station only the access point lists (on no port here) */
	const sta = { '00:00:5E:00:53:01': { ipaddrs: [ X ] }, '00:00:5E:00:53:21': { ipaddrs: [ X ] } };
	const stations = { aps: [ ap(AP1, 'ap-hall', report({ wired: [] })) ] };
	assert.deepEqual(holders(build(sta, null)), [ [ '00:00:5e:00:53:01', null, 'mdns' ] ], 'the control: nothing listed contests it');
	neither(build(sta, stations), '00:00:5e:00:53:01', '00:00:5e:00:53:21', 'two stations');
	/* a wired host of this device (lan2), and a wired host only the access point lists */
	const host = { '00:00:5E:00:53:32': { ipaddrs: [ X ] }, '00:00:5E:00:53:41': { ipaddrs: [ X ] } };
	assert.deepEqual(holders(build(host, null)), [ [ '00:00:5e:00:53:32', null, 'mdns' ] ], 'the control, wired');
	neither(build(host, { aps: [ ap(AP1, 'ap-hall', report({ stations: [] })) ] }), '00:00:5e:00:53:32', '00:00:5e:00:53:41', 'two wired hosts');
	/* the access point linked over Wi-Fi (WDS): what the bridge hears on that port is no wired host here */
	const wds = [ HALL_MAC, '00:00:5e:00:53:21' ].map(mac => ({ mac, port: 'phy0-ap0.sta1', bridge: 'br-lan', seen: 1 }));
	const linked = build(sta, stations, { fdb: wds });
	assert.deepEqual(linked.wiredHosts, [], 'neither is a wired host');
	neither(linked, '00:00:5e:00:53:01', '00:00:5e:00:53:21', 'over a Wi-Fi link');
	/* heard on a wired port instead it is this device's own entry, a party as before: kept on lan2, moved from the access point's lan1 */
	for (const port of [ 'lan2', 'lan1' ]) {
		const heard = build(sta, stations, { fdb: router(null).fdb.concat([ { mac: '00:00:5e:00:53:21', port, bridge: 'br-lan', seen: 2 } ]) });
		assert.deepEqual(holders(heard).map(e => e[0]), [ '00:00:5e:00:53:01', '00:00:5e:00:53:21' ], port);
		for (const e of holders(heard)) assert.notEqual(e[2], 'mdns', port + ': ' + e[0]);
	}
	/* a MAC the report lists that adds no entry (this device's own) is no party */
	const mine = build({ '00:00:5E:00:53:01': { ipaddrs: [ X ] }, '00:00:5E:00:53:F0': { ipaddrs: [ X ] } },
		{ aps: [ ap(AP1, 'ap-hall', report({ stations: [], wired: [ { mac: '00:00:5e:00:53:f0', port: 'lan3' } ] })) ] });
	assert.deepEqual(holders(mine), [ [ '00:00:5e:00:53:01', null, 'mdns' ] ]);
});

test('build: an entry a report adds that alone holds an announced address is named by it, below its DHCP name; one name at two entries labels neither', () => {
	const hints = Object.assign({}, router(null).hints, { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.44' ] }, '00:00:5E:00:53:21': { ipaddrs: [ '192.0.2.45' ] },
		'00:00:5E:00:53:41': { ipaddrs: [ '192.0.2.46' ] } });
	const named = mdns => {
		const m = model.build(router({ aps: [ ap(AP1, 'ap-hall', report()) ] }, { hints, mdns }));
		return Object.fromEntries(m.clients.concat(m.wiredHosts).map(e => [ e.mac, [ e.nameSource, e.name ] ]));
	};
	let by = named({ '192.0.2.44': 'laptop-mdns', '192.0.2.45': 'phone-mdns', '192.0.2.46': 'nas-mdns' });
	assert.deepEqual(by['00:00:5e:00:53:01'], [ 'mdns', 'laptop-mdns' ], 'this device\'s station, as before');
	assert.deepEqual(by['00:00:5e:00:53:21'], [ 'mdns', 'phone-mdns' ], 'the access point\'s station');
	assert.deepEqual(by['00:00:5e:00:53:41'], [ 'mdns', 'nas-mdns' ], 'the access point\'s wired host');
	assert.equal(by['00:00:5e:00:53:42'][0], 'mac', 'no address, no name');
	/* the DHCP host name of its own MAC outranks mDNS */
	hints['00:00:5E:00:53:21'].name = 'phone-dhcp';
	assert.deepEqual(named({ '192.0.2.45': 'phone-mdns' })['00:00:5e:00:53:21'], [ 'dhcp', 'phone-dhcp' ]);
	delete hints['00:00:5E:00:53:21'].name;
	/* one name announced for this device's station and the access point's labels neither */
	by = named({ '192.0.2.44': 'Dads-iPhone', '192.0.2.45': 'Dads-iPhone' });
	assert.notEqual(by['00:00:5e:00:53:01'][0], 'mdns');
	assert.notEqual(by['00:00:5e:00:53:21'][0], 'mdns');
});

test('build: an access point listing a local station\'s, a local wired host\'s, this device\'s or the gateway\'s MAC adds nothing and changes nothing', () => {
	const base = model.build(router(null));
	const claims = [ '00:00:5e:00:53:01', '00:00:5e:00:53:32', '00:00:5e:00:53:f0', '00:00:5e:00:53:f1', '00:00:5e:00:53:f2', GW_MAC ];
	const m = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({
		stations: claims.map(mac => ({ mac, ifname: 'phy1-ap0', signal: -20, rxRate: 1, txRate: 1, rx: 1, tx: 1 })),
		wired: claims.map(mac => ({ mac, port: 'lan9', speed: 10, rx: 1, tx: 1 }))
	})) ] }));
	assert.equal(m.uplink.gateway, '203.0.113.1');
	assert.deepEqual(m.clients, base.clients, 'the local station keeps its signal, name and rates; nothing added');
	assert.deepEqual(m.wiredHosts, base.wiredHosts, 'nothing added, renamed, noted or removed');
	assert.ok(!m.clients.concat(m.wiredHosts).some(c => c.ap), 'no remote entry for any of them, never the gateway');
	assert.deepEqual([ m.accessPoints[0].clients, m.accessPoints[0].wired, m.accessPoints[0].rate, m.accessPoints[0].nodes.map(n => n.clients) ], [ 0, 0, null, [ 0, 0 ] ],
		'and its branch counts none of them: only what it was given');
});

/* an access point (this device) on one port: the gateway and the paired
   ap-hall are both heard on lan1 */
function apDevice(collector, extra) {
	return Object.assign({
		ifaces: [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.4', mask: 24 } ],
			route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'phy0-ap0' ], macaddr: '00:00:5e:00:53:f0' },
			lan1: { devtype: 'ethernet', speed: '1000F', carrier: true, macaddr: '00:00:5e:00:53:f0' }, 'phy0-ap0': { devtype: 'wlan' } },
		wifi: { radio0: { up: true, config: { band: '5g' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap' } } ] } },
		hints: { '00:00:5E:00:53:FE': { name: 'gateway', ipaddrs: [ '192.0.2.1' ] } },
		fdb: [
			{ mac: GW_MAC, port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: HALL_MAC, port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:f0', port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:21', port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-lan', seen: 1 }
		],
		collector
	}, extra);
}

test('build: a host heard on the port an access point\'s own MAC is heard on, that it lists as wired, gets a behind note and nothing else; never the gateway or this device', () => {
	const base = model.build(apDevice(null));
	const list = [ GW_MAC, '00:00:5e:00:53:f0', HALL_MAC, '00:00:5e:00:53:31' ];
	const m = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({ stations: [], wired: list.map(mac => ({ mac, port: 'lan2' })) })) ] }));
	assert.deepEqual(own(m), own(base), 'apart from the note, as before');
	const by = Object.fromEntries(m.wiredHosts.map(h => [ h.mac, h ]));
	assert.deepEqual(by['00:00:5e:00:53:31'].behind, { id: AP1, name: 'ap-hall', addr: '192.0.2.10', port: 'lan2', speed: null, rate: null });
	assert.deepEqual([ m.accessPoints[0].clients, m.accessPoints[0].wired ], [ 0, 1 ], 'its branch: the one host noted, not the gateway or this device it also listed');
	assert.equal(m.clients.filter(c => c.ap).length, 0);
	assert.equal(by[GW_MAC].gateway, true);
	for (const mac of [ GW_MAC, '00:00:5e:00:53:f0', HALL_MAC ]) assert.equal(by[mac].behind, undefined, mac);
	assert.deepEqual(m.wiredHosts.map(h => h.mac), base.wiredHosts.map(h => h.mac), 'the same hosts, in the same order');
	/* on a router, a host on another port than the access point's: no note */
	const r = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ wired: [ { mac: '00:00:5e:00:53:32', port: 'lan2' } ] })) ] }));
	assert.equal(r.wiredHosts.filter(h => h.mac === '00:00:5e:00:53:32')[0].behind, undefined);
});

test('build: apHosts names each access point by its MAC where this device hears it, its port with it; none for one heard nowhere or not alone', () => {
	const m = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({ stations: [], wired: [ { mac: '00:00:5e:00:53:31', port: 'lan2' } ] })) ] }));
	const port = m.wiredHosts.filter(h => h.mac === HALL_MAC)[0].port;
	assert.deepEqual({ ...m.apHosts }, { [HALL_MAC]: { id: AP1, name: 'ap-hall', port } });
	assert.equal(m.wiredHosts.filter(h => h.mac === HALL_MAC)[0].behind, undefined, 'its own entry gets no note');
	assert.deepEqual({ ...model.build(apDevice(null)).apHosts }, {});
	/* two paired under one MAC: neither is placed */
	assert.deepEqual({ ...model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({})), ap(AP2, 'ap-den', report({ mac: HALL_MAC })) ] })).apHosts }, {});
});

/* a router with wired access points: its bridge hears their stations on
   the access point's port; the one it reports as its station moves */
const roam = (mac, signal, ifname) => ({ mac, ifname: ifname || 'phy1-ap0', signal, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000, connected: 30 });

test('build: a wired host heard on an access point\'s port that it reports as its station becomes that station: the router\'s names, its signal and rates', () => {
	const base = model.build(router(null, { aliases: { '00:00:5e:00:53:31': { name: 'Office printer', sid: 'cfg01' } } }));
	const m = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -58) ], wired: [] })) ] },
		{ aliases: { '00:00:5e:00:53:31': { name: 'Office printer', sid: 'cfg01' } } }));
	assert.equal(m.wiredHosts.length, base.wiredHosts.length - 1, 'one wired host fewer');
	assert.equal(m.clients.length, base.clients.length + 1, 'one Wi-Fi client more');
	assert.ok(!m.wiredHosts.some(h => h.mac === '00:00:5e:00:53:31'));
	const c = m.clients.filter(x => x.mac === '00:00:5e:00:53:31')[0];
	assert.deepEqual([ c.name, c.nameSource, c.alias, c.aliasSid, c.ips ], [ 'Office printer', 'alias', 'Office printer', 'cfg01', [ '192.0.2.131' ] ], 'the router\'s own name and address');
	assert.deepEqual([ c.ap.id, c.ap.node, c.signal, c.rx.rate, c.tx.rate, c.ap.rate, c.connected, c.band ], [ AP1, 'phy1-ap0', -58, 72200, 144400, { rx: 8000, tx: 64000 }, 30, '5g' ]);
	assert.deepEqual(m.clients.filter(x => !x.ap), base.clients, 'this device\'s stations untouched');
	assert.deepEqual(m.wiredHosts.filter(h => h.mac !== HALL_MAC).map(h => h.mac), [ '00:00:5e:00:53:32' ], 'the rest stay');
	assert.deepEqual(m.wiredHosts.filter(h => h.mac === '00:00:5e:00:53:32'), base.wiredHosts.filter(h => h.mac === '00:00:5e:00:53:32'));
	assert.deepEqual([ m.accessPoints[0].clients, m.accessPoints[0].nodes[0].clients ], [ 1, 1 ]);
	/* a DHCP name, without an alias */
	const d = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -58) ] })) ] }));
	assert.deepEqual([ d.clients.filter(x => x.mac === '00:00:5e:00:53:31')[0].name, d.clients.filter(x => x.mac === '00:00:5e:00:53:31')[0].nameSource ], [ 'printer', 'dhcp' ]);
});

test('build: no move on another port, through an access point not reporting or with a MAC not its own alone, for the gateway, this device or a local station', () => {
	const moved = m => m.clients.filter(c => c.ap).map(c => c.mac);
	const sta = macs => report({ stations: macs.map(mac => roam(mac, -40)), wired: [] });
	/* the control */
	assert.deepEqual(moved(model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', sta([ '00:00:5e:00:53:31' ])) ] }))), [ '00:00:5e:00:53:31' ]);
	/* the router: 53:32 is on lan2, ap-hall on lan1; 53:01 is its own station */
	const r = model.build(router({ aps: [ ap(AP1, 'ap-hall', sta([ '00:00:5e:00:53:32', '00:00:5e:00:53:01' ])) ] }));
	assert.deepEqual(moved(r), []);
	assert.deepEqual([ r.clients, r.wiredHosts ], [ model.build(router(null)).clients, model.build(router(null)).wiredHosts ]);
	/* the access point: the gateway and this device's own bridge MAC on its port */
	const g = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', sta([ GW_MAC, '00:00:5e:00:53:f0', HALL_MAC ])) ] }));
	assert.deepEqual(moved(g), []);
	assert.deepEqual(g.wiredHosts, model.build(apDevice(null)).wiredHosts);
	for (const extra of [ { state: 'offline', age: 120 }, { state: 'error', error: 'timeout' }, { state: 'waiting', report: null } ])
		assert.deepEqual(moved(model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', sta([ '00:00:5e:00:53:31' ]), extra) ] }))), [], extra.state);
	/* its MAC: another's too, the gateway's, this device's */
	assert.deepEqual(moved(model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', sta([ '00:00:5e:00:53:31' ])), ap(AP2, 'ap-den', sta([])) ] }))), [], 'two claim one MAC');
	for (const mac of [ GW_MAC, '00:00:5e:00:53:f0' ])
		assert.deepEqual(moved(model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', Object.assign(sta([ '00:00:5e:00:53:31' ]), { mac })) ] }))), [], mac);
});

test('build: while no host hint gives the next hop a MAC, no host on the uplink\'s bridge is an access point\'s to move or note', () => {
	const sta = macs => report({ stations: macs.map(mac => roam(mac, -40)), wired: [] });
	const moved = m => m.clients.filter(c => c.ap).map(c => c.mac);
	const claim = { aps: [ ap(AP1, 'ap-hall', sta([ GW_MAC, '00:00:5e:00:53:31' ])) ] };
	for (const hints of [ {}, { '00:00:5E:00:53:FE': { name: 'gateway', ipaddrs: [ '192.0.2.254' ] } }, { '02:00:5E:10:00:01': { ipaddrs: [ '192.0.2.10' ] } } ]) {
		const base = model.build(apDevice(null, { hints }));
		const m = model.build(apDevice(claim, { hints }));
		assert.deepEqual(moved(m), [], JSON.stringify(hints));
		assert.deepEqual(m.wiredHosts, base.wiredHosts, 'the gateway\'s entry and the others as they were');
		const noted = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({ stations: [], wired: [ { mac: GW_MAC, port: 'lan2' } ] })) ] }, { hints }));
		assert.deepEqual(noted.wiredHosts.filter(h => h.behind).map(h => h.mac), [], 'no note either');
		/* the gateway itself paired: a host on the uplink's bridge is not its to claim either (portOf itself is unchanged) */
		const own = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', Object.assign(sta([ '00:00:5e:00:53:31' ]), { mac: GW_MAC })) ] }, { hints }));
		assert.deepEqual(moved(own), [], 'nor through an access point with the gateway\'s MAC');
	}
	/* the bridge under its own name, whatever that is, and under a VLAN of it */
	for (const [ bridge, l3, vlan ] of [ [ 'br.10', 'br.10', null ], [ 'br-lan', 'br-lan.10', 10 ] ]) {
		const d = apDevice(claim, { hints: {} });
		d.devs[bridge] = d.devs['br-lan'];
		d.ifaces[0].l3_device = d.ifaces[0].device = l3;
		d.fdb.forEach(h => { h.bridge = bridge; h.vlan = vlan; });
		assert.deepEqual(moved(model.build(d)), [], l3);
	}
	/* a second bridge on the same wire: the gateway's MAC heard last there is the gateway's all the same */
	const two = apDevice(null, { hints: {} });
	two.devs['br-guest'] = { devtype: 'bridge', 'bridge-members': [ 'lan1.20' ], macaddr: '00:00:5e:00:53:f0' };
	two.devs['lan1.20'] = { devtype: 'vlan', carrier: true, macaddr: '00:00:5e:00:53:f0' };
	two.fdb = two.fdb.concat([ GW_MAC, HALL_MAC ].map(mac => ({ mac, port: 'lan1.20', bridge: 'br-guest', seen: 0 })));
	assert.equal(model.build(two).wiredHosts.filter(h => h.mac === GW_MAC)[0].bridge, 'br-guest', 'the entry listed is the other bridge\'s');
	for (const rep of [ sta([ GW_MAC ]), report({ stations: [], wired: [ { mac: GW_MAC, port: 'lan2' } ] }) ]) {
		const t = model.build(Object.assign({}, two, { collector: { aps: [ ap(AP1, 'ap-hall', rep) ] } }));
		assert.deepEqual([ moved(t), t.wiredHosts.filter(h => h.behind).map(h => h.mac) ], [ [], [] ], 'two bridges on one wire');
	}
	/* known again: the gateway stays, the other host moves */
	assert.deepEqual(moved(model.build(apDevice(claim))), [ '00:00:5e:00:53:31' ]);
	/* no next hop at all: nothing is the gateway, the rules are as before */
	const noRoute = { hints: {}, ifaces: [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.4', mask: 24 } ], route: [] } ] };
	assert.deepEqual(moved(model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', sta([ '00:00:5e:00:53:31' ])) ] }, noRoute))), [ '00:00:5e:00:53:31' ]);
});

/* macOf's other way of not knowing: two hosts of the uplink's bridge hold the next hop */
test('build: with two hosts of the uplink\'s bridge at the next hop neither is the gateway, and neither is an access point\'s to move or note', () => {
	const moved = m => m.clients.filter(c => c.ap).map(c => c.mac);
	const hop = { ipaddrs: [ '192.0.2.1' ] };
	for (const hints of [ { '00:00:5E:00:53:FE': hop, '00:00:5E:00:53:31': hop }, { '00:00:5E:00:53:31': hop, '00:00:5E:00:53:FE': hop } ]) {
		const base = model.build(apDevice(null, { hints }));
		assert.deepEqual(base.wiredHosts.filter(h => h.gateway), [], 'unknown, rather than either');
		for (const mac of [ GW_MAC, '00:00:5e:00:53:31' ]) {
			const m = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam(mac, -40) ], wired: [] })) ] }, { hints }));
			assert.deepEqual([ moved(m), m.wiredHosts ], [ [], base.wiredHosts ], mac + ' as its station');
			const n = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({ stations: [], wired: [ { mac, port: 'lan2' } ] })) ] }, { hints }));
			assert.deepEqual(n.wiredHosts.filter(h => h.behind).map(h => h.mac), [], mac + ' as its wired host');
		}
	}
	/* one of the two a host of another bridge: the other is the gateway, and what is not the gateway moves as before */
	const d = apDevice({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam(GW_MAC, -40), roam('00:00:5e:00:53:21', -40) ], wired: [] })) ] },
		{ hints: { '00:00:5E:00:53:FE': hop, '00:00:5E:00:53:31': hop } });
	d.fdb.filter(h => h.mac === '00:00:5e:00:53:31')[0].bridge = 'br-guest';
	const k = model.build(d);
	assert.deepEqual([ k.wiredHosts.filter(h => h.gateway).map(h => h.mac), moved(k) ], [ [ GW_MAC ], [ '00:00:5e:00:53:21' ] ]);
});

test('build: a moved station goes to the access point that hears it best of those it is heard behind; the branch counts and the lists agree', () => {
	/* ap-den is on lan2 and hears 53:31 better, but this device hears 53:31 behind ap-hall */
	const den = Object.assign(report({ mac: '02:00:5e:10:00:02', stations: [ roam('00:00:5e:00:53:31', -40, 'phy0-ap0') ], wired: [] }));
	const fdb = router(null).fdb.concat([ { mac: '02:00:5e:10:00:02', port: 'lan2', bridge: 'br-lan', seen: 1 } ]);
	const m = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -70) ], wired: [] })), ap(AP2, 'ap-den', den) ] }, { fdb }));
	const c = m.clients.filter(x => x.mac === '00:00:5e:00:53:31')[0];
	assert.deepEqual([ c.ap.name, c.signal ], [ 'ap-hall', -70 ]);
	assert.equal(m.clients.filter(x => x.mac === '00:00:5e:00:53:31').length, 1, 'once');
	/* both behind ap-hall's port: the stronger one wins */
	const both = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -70) ], wired: [] })), ap(AP2, 'ap-den', den) ] },
		{ fdb: router(null).fdb.concat([ { mac: '02:00:5e:10:00:02', port: 'lan1', bridge: 'br-lan', seen: 1 } ]) }));
	assert.deepEqual(both.clients.filter(x => x.ap).map(x => [ x.mac, x.ap.name, x.signal ]), [ [ '00:00:5e:00:53:31', 'ap-den', -40 ] ]);
	/* a branch counts what it was given: the station is ap-den's alone; the list holds every MAC once */
	assert.deepEqual(both.accessPoints.map(a => [ a.clients, a.nodes.map(n => n.clients) ]), [ [ 0, [ 0, 0 ] ], [ 1, [ 0, 1 ] ] ]);
	const macs = both.clients.map(x => x.mac).concat(both.wiredHosts.map(h => h.mac));
	assert.equal(new Set(macs).size, macs.length);
});

test('build: an access point claiming the gateway\'s, this device\'s, another\'s or a local station\'s MAC as its own keeps its branch and notes nothing', () => {
	const hosts = { stations: [], wired: [ { mac: '00:00:5e:00:53:31', port: 'lan2' } ] };
	const noted = m => m.wiredHosts.filter(h => h.behind).map(h => h.mac);
	assert.deepEqual(noted(model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report(hosts)) ] }))), [ '00:00:5e:00:53:31' ], 'the control: its own MAC');
	for (const mac of [ GW_MAC, '00:00:5e:00:53:f0' ]) {
		const m = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report(Object.assign({ mac }, hosts))) ] }));
		assert.deepEqual([ m.accessPoints.length, noted(m) ], [ 1, [] ], mac);
	}
	const twice = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report(hosts)), ap(AP2, 'ap-den', report({ wired: [] })) ] }));
	assert.deepEqual([ twice.accessPoints.length, noted(twice) ], [ 2, [] ], 'two claim one MAC: neither');
	const sta = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ mac: '00:00:5e:00:53:01', wired: [ { mac: '00:00:5e:00:53:31', port: 'lan2' } ] })) ] }));
	assert.deepEqual(noted(sta), [], 'a local station\'s MAC is heard on no port');
});

test('build: a station two access points list goes to the one that hears it best; a wired host to the first; a station is no wired host', () => {
	const sta = (signal, ifname) => ({ mac: '00:00:5e:00:53:51', ifname: ifname || 'phy1-ap0', signal });
	const m = model.build(router({ aps: [
		ap(AP1, 'ap-hall', report({ stations: [ sta(-70) ], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan3' }, { mac: '00:00:5e:00:53:51', port: 'lan4' } ] })),
		ap(AP2, 'ap-den', report({ mac: '02:00:5e:10:00:02', stations: [ sta(-55, 'phy0-ap0') ], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan1' } ] }))
	] }));
	const remote = m.clients.filter(c => c.ap);
	assert.deepEqual(remote.map(c => [ c.mac, c.ap.name, c.band, c.signal ]), [ [ '00:00:5e:00:53:51', 'ap-den', '2g', -55 ] ]);
	assert.deepEqual(m.wiredHosts.filter(h => h.ap).map(h => [ h.mac, h.ap.name, h.ap.port ]), [ [ '00:00:5e:00:53:61', 'ap-hall', 'lan3' ] ]);
	assert.deepEqual(m.accessPoints.map(a => [ a.clients, a.wired ]), [ [ 0, 1 ], [ 1, 0 ] ], 'each branch counts what it was given, as the lists have it');
});

/* one entry a MAC, placed as above; every other access point that lists it stays named on it */
test('build: a client two access points report keeps its place and names the others (ap.also, behind.also); a single or a refuted claim is named nowhere', () => {
	const DEN_MAC = '02:00:5e:10:00:02', LOFT = '1111111111111111';
	const HALL = { id: AP1, name: 'ap-hall' }, DEN = { id: AP2, name: 'ap-den' };
	const hall = ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:51', -55) ], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan3' } ] }));
	const den = (stations, wired) => ap(AP2, 'ap-den', report({ mac: DEN_MAC, ssids: [ ssid('phy0-ap0', '2g', 2437, '00:00:5e:00:53:b0') ], stations, wired }));
	/* this device hears ap-hall on lan1 (the fixture) and, unless told otherwise, ap-den on lan2 */
	const build = (aps, rows) => model.build(router({ aps }, { fdb: router(null).fdb.concat((rows || [ [ DEN_MAC, 'lan2' ] ]).map(([ mac, port ]) => ({ mac, port, bridge: 'br-lan', seen: 1 }))) }));
	/* [ whose it is, the others named on it ] or, for a host of this device with a note, [ null, null, behind whom, the others ] */
	const at = (m, mac) => m.clients.concat(m.wiredHosts).filter(e => e.mac === mac).map(e =>
		(e.ap ? [ e.ap.name, e.ap.also || null ] : [ null, null ]).concat(e.behind ? [ e.behind.name, e.behind.also || null ] : []));
	const counts = m => m.accessPoints.map(a => [ a.clients, a.wired ]);
	const named = m => m.clients.concat(m.wiredHosts).filter(e => (e.ap && 'also' in e.ap) || (e.behind && 'also' in e.behind)).map(e => e.mac);

	/* the control: ap-den lists neither */
	const honest = build([ hall, den([], []) ]);
	assert.deepEqual([ at(honest, '00:00:5e:00:53:51'), at(honest, '00:00:5e:00:53:61'), counts(honest), named(honest) ],
		[ [ [ 'ap-hall', null ] ], [ [ 'ap-hall', null ] ], [ [ 1, 1 ], [ 0, 0 ] ], [] ], 'one claimant: no field of it');
	/* the hostile reply: ap-den lists ap-hall's station at -1 dBm and its wired host as a station without a signal. Placed as
	   before (the best signal; a station before a wired host), and ap-hall stays named on both */
	const taken = [ { mac: '00:00:5e:00:53:51', ifname: 'phy0-ap0', signal: -1, rx: 0, tx: 0, connected: 1 }, { mac: '00:00:5e:00:53:61', ifname: 'phy0-ap0' } ];
	for (const aps of [ [ hall, den(taken, []) ], [ den(taken, []), hall ] ]) {
		const m = build(aps);
		assert.deepEqual([ at(m, '00:00:5e:00:53:51'), at(m, '00:00:5e:00:53:61') ], [ [ [ 'ap-den', [ HALL ] ] ], [ [ 'ap-den', [ HALL ] ] ] ], aps[0].name + ' first');
		assert.deepEqual(m.clients.filter(c => c.ap).map(c => [ c.mac, c.signal ]), [ [ '00:00:5e:00:53:51', -1 ], [ '00:00:5e:00:53:61', null ] ]);
		assert.deepEqual(Object.fromEntries(m.accessPoints.map(a => [ a.name, [ a.clients, a.wired ] ])), { 'ap-hall': [ 0, 0 ], 'ap-den': [ 2, 0 ] }, 'the branches count as before');
	}
	/* a claim that loses is named as well: an equal signal, none, and a wired claim against a station */
	for (const s of [ roam('00:00:5e:00:53:51', -55, 'phy0-ap0'), { mac: '00:00:5e:00:53:51', ifname: 'phy0-ap0' } ])
		assert.deepEqual(at(build([ hall, den([ s ], []) ]), '00:00:5e:00:53:51'), [ [ 'ap-hall', [ DEN ] ] ]);
	assert.deepEqual(at(build([ hall, den([], [ { mac: '00:00:5e:00:53:51', port: 'lan9' } ]) ]), '00:00:5e:00:53:51'), [ [ 'ap-hall', [ DEN ] ] ]);
	/* two wired claims: the first in the list has the host, the other is named */
	const both = [ { mac: '00:00:5e:00:53:61', port: 'lan9', speed: 10 } ];
	assert.deepEqual(at(build([ hall, den([], both) ]), '00:00:5e:00:53:61'), [ [ 'ap-hall', [ DEN ] ] ]);
	assert.deepEqual(at(build([ den([], both), hall ]), '00:00:5e:00:53:61'), [ [ 'ap-den', [ HALL ] ] ]);
	/* three of them: each of the others once, in the order they lost; one that lists a MAC twice (station and wired host) is one */
	const loft = ap(LOFT, 'ap-loft', report({ mac: '00:00:5e:00:53:a3', stations: [ roam('00:00:5e:00:53:51', -40) ], wired: [ { mac: '00:00:5e:00:53:51', port: 'lan5' } ] }));
	const three = build([ hall, den([ roam('00:00:5e:00:53:51', -70, 'phy0-ap0') ], [ { mac: '00:00:5e:00:53:51', port: 'lan9' } ]), loft ]);
	assert.deepEqual(at(three, '00:00:5e:00:53:51'), [ [ 'ap-loft', [ DEN, HALL ] ] ]);
	assert.deepEqual(at(build([ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:51', -55) ], wired: [ { mac: '00:00:5e:00:53:51', port: 'lan3' } ] })) ]), '00:00:5e:00:53:51'),
		[ [ 'ap-hall', null ] ], 'its own station and wired host: no other');

	/* a wired host this device hears on the port it hears two access points on, listed as wired by both: it stays this
	   device's, the first has the note and its count, and the other is named */
	const lan1 = [ [ DEN_MAC, 'lan1' ], [ '00:00:5e:00:53:61', 'lan1' ] ];
	const noted = build([ hall, den([], both) ], lan1);
	assert.deepEqual([ at(noted, '00:00:5e:00:53:61'), counts(noted) ], [ [ [ null, null, 'ap-hall', [ DEN ] ] ], [ [ 1, 1 ], [ 0, 0 ] ] ]);
	assert.deepEqual(at(build([ den([], both), hall ], lan1), '00:00:5e:00:53:61'), [ [ null, null, 'ap-den', [ HALL ] ] ]);
	const third = ap(LOFT, 'ap-loft', report({ mac: '00:00:5e:00:53:a3', stations: [], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan5' } ] }));
	assert.deepEqual(at(build([ hall, den([], both), third ], lan1.concat([ [ '00:00:5e:00:53:a3', 'lan1' ] ])), '00:00:5e:00:53:61'),
		[ [ null, null, 'ap-hall', [ DEN, { id: LOFT, name: 'ap-loft' } ] ] ]);
	/* moved to the one that hears it best of the two it is heard behind: the other is named there too */
	const roamed = build([ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:61', -70) ], wired: [] })), den([ roam('00:00:5e:00:53:61', -40, 'phy0-ap0') ], []) ], lan1);
	assert.deepEqual(at(roamed, '00:00:5e:00:53:61'), [ [ 'ap-den', [ HALL ] ] ]);

	/* a claim this device's own bridge refutes is named nowhere: both MACs heard on ap-hall's port, ap-den on lan2 */
	const mine = [ [ DEN_MAC, 'lan2' ], [ '00:00:5e:00:53:51', 'lan1' ], [ '00:00:5e:00:53:61', 'lan1' ] ];
	for (const claim of [ den(taken, []), den([], [ { mac: '00:00:5e:00:53:51', port: 'lan9' }, { mac: '00:00:5e:00:53:61', port: 'lan9' } ]) ]) {
		const m = build([ hall, claim ], mine);
		assert.deepEqual([ at(m, '00:00:5e:00:53:51'), at(m, '00:00:5e:00:53:61'), named(m) ], [ [ [ 'ap-hall', null ] ], [ [ null, null, 'ap-hall', null ] ], [] ]);
	}
});

/* #130: an access point plugged into another is listed under it */
test('build: an access point heard on another\'s port, which the other lists as wired, goes under it; a claim alone, two that list each other, no nearest one or a ring do not', () => {
	const DEN = '02:00:5e:10:00:02', ATTIC = '02:00:5e:10:00:03', AP3 = '0011223344556677';
	const at = (...on) => router(null).fdb.concat(on.map(([ mac, port ]) => ({ mac, port, bridge: 'br-lan', seen: 1 })));
	const rep = (mac, wired) => report({ mac, stations: [], wired: (wired || []).map(m => ({ mac: m, port: 'lan4', speed: 1000 })) });
	const tree = (aps, fdb) => model.build(router({ aps }, { fdb })).accessPoints.map(a => [ a.name, a.depth, a.parent && a.parent.name ]);
	const hall = wired => ap(AP1, 'ap-hall', rep(HALL_MAC, wired)), den = wired => ap(AP2, 'ap-den', rep(DEN, wired)), attic = wired => ap(AP3, 'ap-attic', rep(ATTIC, wired));
	/* ap-den in ap-hall's lan4: this device hears both on lan1. Under its parent, whatever the pairing order */
	const m = model.build(router({ aps: [ den(), hall([ DEN ]) ] }, { fdb: at([ DEN, 'lan1' ]) }));
	assert.deepEqual(m.accessPoints.map(a => [ a.name, a.depth, a.parent ]), [ [ 'ap-hall', 0, null ], [ 'ap-den', 1, { id: AP1, name: 'ap-hall', port: 'lan4' } ] ]);
	/* as a host it stays what it was: this device's, on lan1, with the note */
	assert.deepEqual(m.wiredHosts.filter(h => h.mac === DEN).map(h => [ h.port, h.behind.name, !!h.ap ]), [ [ 'lan1', 'ap-hall', false ] ]);
	/* the claim alone moves nothing: ap-den is heard on lan2, or nowhere */
	assert.deepEqual(tree([ den(), hall([ DEN ]) ], at([ DEN, 'lan2' ])), [ [ 'ap-den', 0, null ], [ 'ap-hall', 0, null ] ]);
	assert.deepEqual(tree([ den(), hall([ DEN ]) ], at()), [ [ 'ap-den', 0, null ], [ 'ap-hall', 0, null ] ]);
	/* nor does a parent that is not reporting */
	assert.deepEqual(tree([ den(), ap(AP1, 'ap-hall', null, { state: 'offline', error: 'unreachable' }) ], at([ DEN, 'lan1' ])), [ [ 'ap-den', 0, null ], [ 'ap-hall', 0, null ] ]);
	/* a chain: ap-hall hears ap-attic through ap-den, and the nearest one has it */
	const all = at([ DEN, 'lan1' ], [ ATTIC, 'lan1' ]);
	assert.deepEqual(tree([ attic(), den([ ATTIC ]), hall([ DEN, ATTIC ]) ], all), [ [ 'ap-hall', 0, null ], [ 'ap-den', 1, 'ap-hall' ], [ 'ap-attic', 2, 'ap-den' ] ]);
	/* two on a switch behind ap-hall: both under it, in pairing order */
	assert.deepEqual(tree([ attic(), den(), hall([ DEN, ATTIC ]) ], all), [ [ 'ap-hall', 0, null ], [ 'ap-attic', 1, 'ap-hall' ], [ 'ap-den', 1, 'ap-hall' ] ]);
	/* two that list each other: neither is the other's */
	assert.deepEqual(tree([ hall([ DEN ]), den([ HALL_MAC ]) ], all), [ [ 'ap-hall', 0, null ], [ 'ap-den', 0, null ] ]);
	/* two list it and neither lists the other: no nearest one */
	assert.deepEqual(tree([ hall([ ATTIC ]), den([ ATTIC ]), attic() ], all), [ [ 'ap-hall', 0, null ], [ 'ap-den', 0, null ], [ 'ap-attic', 0, null ] ]);
	/* a ring of claims: none */
	assert.deepEqual(tree([ hall([ DEN ]), den([ ATTIC ]), attic([ HALL_MAC ]) ], all), [ [ 'ap-hall', 0, null ], [ 'ap-den', 0, null ], [ 'ap-attic', 0, null ] ]);
	/* without any of it: depth 0, no parent, the pairing order */
	assert.deepEqual(tree([ den(), hall() ], all), [ [ 'ap-den', 0, null ], [ 'ap-hall', 0, null ] ]);
});

test('build: an access point not reporting (waiting, offline, error) keeps its branch, with no SSIDs, stations, hosts or notes', () => {
	for (const extra of [ { state: 'waiting', report: null, age: null }, { state: 'offline', age: 120 }, { state: 'error', error: 'timeout' } ]) {
		const m = model.build(apDevice({ aps: [ ap(AP1, 'ap-hall', report({ wired: [ { mac: '00:00:5e:00:53:31', port: 'lan2' } ] }), extra) ] }));
		const a = m.accessPoints[0];
		assert.deepEqual([ a.state, a.nodes, a.clients, a.wired ], [ extra.state, [], 0, 0 ]);
		assert.ok(!m.clients.concat(m.wiredHosts).some(c => c.ap || c.behind), extra.state);
	}
});

/* #167: the far end of a mesh interface is another node of the mesh. It is listed with the stations, as a peer, and
   is no client of the radio; its interface still says how many it has */
test('build: a mesh interface\'s stations are peers, no clients', () => {
	const m = model.build({ wifi: { radio0: { up: true, config: { band: '5g' }, interfaces: [
		{ ifname: 'phy0-mesh0', config: { mesh_id: 'bh', mode: 'mesh', network: [ 'lan' ] } }, { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] } },
		assoc: { 'phy0-mesh0': [ { mac: '00:00:5E:00:53:41', signal: -60 }, { mac: '00:00:5E:00:53:43', signal: -61 } ], 'phy0-ap0': [ { mac: '00:00:5E:00:53:42', signal: -50 } ] } });
	assert.deepEqual(m.clients.map(c => [ c.ifname, c.peer ]).sort(), [ [ 'phy0-ap0', false ], [ 'phy0-mesh0', true ], [ 'phy0-mesh0', true ] ]);
	assert.deepEqual([ m.radios[0].clients, m.ssids.map(s => [ s.mode, s.clients ]) ], [ 1, [ [ 'mesh', 2 ], [ 'ap', 1 ] ] ]);
});

test('build: a gateway heard only over this device\'s own client, mesh or WDS link makes it the uplink; over an access point interface it does not', () => {
	const build = (port, mode, seen, assoc) => model.build({
		ifaces: [ { interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.4', mask: 24 } ],
			route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] } ],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'phy0-link0', 'phy0-ap0', 'phy0-ap0.sta1' ] }, lan1: { devtype: 'ethernet', carrier: false },
			'phy0-link0': { devtype: 'wlan', carrier: true }, 'phy0-ap0': { devtype: 'wlan' }, 'phy0-ap0.sta1': { devtype: 'wlan' } },
		wifi: { radio0: { up: true, config: { band: '5g' }, interfaces: [ { ifname: 'phy0-link0', config: { ssid: 'bh', mode } }, { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap' } } ] } },
		hints: { '02:00:5E:00:00:01': { ipaddrs: [ '192.0.2.1' ] } },
		assoc: assoc || {},
		fdb: [].concat(port).map((p, i) => ({ mac: '02:00:5e:00:00:01', port: p, bridge: 'br-lan', seen: (seen || [])[i] }))
	}).uplink;
	assert.equal(build('phy0-link0', 'mesh').port, 'phy0-link0', 'mesh');
	assert.equal(build('phy0-link0', 'sta').port, 'phy0-link0', 'client');
	assert.equal(build('phy0-ap0.sta1', 'ap').port, 'phy0-ap0.sta1', 'a WDS station of its access point interface');
	assert.equal(build('phy0-ap0', 'mesh').port, 'lan1', 'an access point interface: any station could send from the gateway\'s MAC');
	assert.equal(build('phy0-link0', 'ap').port, 'lan1', 'an access point interface by its mode');
	assert.equal(build('phy0-link0', 'adhoc').port, 'lan1');
	assert.equal(build([ 'phy0-ap0.sta1', 'phy0-link0' ], 'mesh', [ 50, 2 ]).port, 'phy0-link0', 'the one heard last');
	/* the far end of such a link is in that interface's station list, and
	   many routers answer for their address from the MAC their radio uses:
	   it is still the gateway */
	const PEER = [ { mac: '02:00:5E:00:00:01', signal: -50 } ];
	assert.equal(build('phy0-link0', 'mesh', null, { 'phy0-link0': PEER }).port, 'phy0-link0', 'a mesh peer');
	assert.equal(build('phy0-link0', 'sta', null, { 'phy0-link0': PEER }).port, 'phy0-link0', 'the access point this device is a client of');
	assert.equal(build('phy0-ap0.sta1', 'ap', null, { 'phy0-ap0': PEER }).port, 'phy0-ap0.sta1', 'a WDS station, listed by its access point interface');
	/* a plain station of an access point interface is one host using this device */
	assert.equal(build('phy0-ap0', 'mesh', null, { 'phy0-ap0': PEER }).port, 'lan1');
});

/* review F1: the port an access point is on is where this device hears its
   MAC. A MAC that is not the one this device knows at its address places
   it nowhere */
test('build: an access point whose address this device knows under another MAC moves and notes nothing', () => {
	/* lan2 has two plain wired hosts; ap-hall (192.0.2.10) is on lan1 */
	const fdb = router(null).fdb.concat([ { mac: '00:00:5e:00:53:33', port: 'lan2', bridge: 'br-lan', seen: 2 } ]);
	const known = { '02:00:5E:10:00:01': { name: 'ap-hall', ipaddrs: [ '192.0.2.10' ] } };
	const build = (mac, hints) => model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ mac,
		stations: [ roam('00:00:5e:00:53:33', -40) ], wired: [ { mac: '00:00:5e:00:53:32', port: 'lan4' } ] })) ] },
		{ fdb, hints: Object.assign({}, router(null).hints, hints) }));
	const taken = m => [ m.clients.filter(c => c.ap).map(c => c.mac), m.wiredHosts.filter(h => h.behind).map(h => h.mac) ];
	/* its own MAC, on lan1: neither host on lan2 is behind it */
	assert.deepEqual(taken(build(HALL_MAC, known)), [ [], [] ]);
	/* 53:32's MAC as its own would put it on lan2 */
	const lying = build('00:00:5e:00:53:32', known);
	assert.deepEqual(taken(lying), [ [], [] ], 'this device knows 192.0.2.10 as another MAC');
	assert.deepEqual([ lying.wiredHosts, lying.clients ], [ build(HALL_MAC, known).wiredHosts, build(HALL_MAC, known).clients ]);
	assert.deepEqual([ lying.accessPoints.length, lying.accessPoints[0].clients, lying.accessPoints[0].wired ], [ 1, 0, 0 ], 'its branch stays, empty');
	/* the address under its MAC among others (an old lease): known, and the same */
	const same = build('00:00:5e:00:53:32', { '00:00:5E:00:53:32': { ipaddrs: [ '192.0.2.10' ] }, '02:00:5E:10:00:01': { ipaddrs: [ '192.0.2.10' ] } });
	assert.deepEqual(taken(same)[0], [ '00:00:5e:00:53:33' ]);
	/* an address this device has no hint for: the other guards alone */
	assert.deepEqual(taken(build('00:00:5e:00:53:32', {}))[0], [ '00:00:5e:00:53:33' ]);
	/* an IPv6 address, whatever its case */
	const v6 = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ mac: '00:00:5e:00:53:32', stations: [ roam('00:00:5e:00:53:33', -40) ] }), { addr: '2001:db8::A' }) ] },
		{ fdb, hints: Object.assign({}, router(null).hints, { '02:00:5E:10:00:01': { ip6addrs: [ '2001:DB8::a' ] } }) }));
	assert.deepEqual(taken(v6), [ [], [] ]);
});

/* the same guard, by the address's value: an IPv6 address has many
   spellings, and the pairing keeps the one it was given */
test('build: an access point whose IPv6 address this device knows under another MAC moves and notes nothing, however either is spelled', () => {
	const fdb = router(null).fdb.concat([ { mac: '00:00:5e:00:53:33', port: 'lan2', bridge: 'br-lan', seen: 2 } ]);
	const build = (mac, addr, hints) => model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ mac,
		stations: [ roam('00:00:5e:00:53:33', -40) ], wired: [ { mac: '00:00:5e:00:53:32', port: 'lan4' } ] }), { addr }) ] },
		{ fdb, hints: Object.assign({}, router(null).hints, hints) }));
	const taken = m => [ m.clients.filter(c => c.ap).map(c => c.mac), m.wiredHosts.filter(h => h.behind).map(h => h.mac) ];
	const hall = v6 => ({ '02:00:5E:10:00:01': { name: 'ap-hall', ip6addrs: [ v6 ] } });
	const LIE = '00:00:5e:00:53:32', SHORT = '2001:db8:1::10';
	const spellings = [ '2001:db8:1:0::10', '2001:0db8:1::10', '2001:db8:1::0010', '2001:db8:0001::10', '2001:db8:1:0:0:0:0:10',
		'2001:0db8:0001:0000:0000:0000:0000:0010', '2001:DB8:1::10', '2001:DB8:0001:0:0:0:0:10' ];
	/* its own MAC, on lan1: neither host on lan2 is behind it */
	const honest = build(HALL_MAC, SHORT, hall(SHORT));
	assert.deepEqual(taken(honest), [ [], [] ]);
	/* 53:32's MAC as its own would put it on lan2: refused in the hint's spelling, and in any other */
	for (const addr of [ SHORT ].concat(spellings)) {
		const lying = build(LIE, addr, hall(SHORT));
		assert.deepEqual(taken(lying), [ [], [] ], addr);
		assert.deepEqual([ lying.wiredHosts, lying.clients ], [ honest.wiredHosts, honest.clients ], addr);
		assert.deepEqual([ lying.accessPoints.length, lying.accessPoints[0].clients, lying.accessPoints[0].wired ], [ 1, 0, 0 ], addr + ': its branch stays, empty');
	}
	/* the hint spelled otherwise than the access point's address, or both otherwise than each other */
	for (const hint of spellings) {
		assert.deepEqual(taken(build(LIE, SHORT, hall(hint))), [ [], [] ], 'hint ' + hint);
		assert.deepEqual(taken(build(LIE, '2001:db8:1:0::10', hall(hint))), [ [], [] ], 'both, hint ' + hint);
	}
	/* an IPv6 address the hints list among the IPv4 ones */
	assert.deepEqual(taken(build(LIE, '2001:db8:1:0::10', { '02:00:5E:10:00:01': { ipaddrs: [ '192.0.2.10', SHORT ] } })), [ [], [] ]);
	/* the address under its MAC among others, in another spelling: known, and the same */
	assert.deepEqual(taken(build(LIE, '2001:db8:1:0::10', { '00:00:5E:00:53:32': { ip6addrs: [ '2001:0DB8:1::10' ] }, '02:00:5E:10:00:01': { ip6addrs: [ SHORT ] } }))[0], [ '00:00:5e:00:53:33' ]);
	/* another address, or no hint for it: the other guards alone */
	for (const other of [ '2001:db8:1::11', '2001:db8:1::1', '2001:db8:10::1', '2001:db8::1:10', '2001:db8:1::10:0' ])
		assert.deepEqual(taken(build(LIE, SHORT, hall(other)))[0], [ '00:00:5e:00:53:33' ], other);
	assert.deepEqual(taken(build(LIE, '2001:db8:1:0::10', {}))[0], [ '00:00:5e:00:53:33' ]);
	/* text that is no address equals nothing, itself included, and nothing throws */
	const junk = { '02:00:5E:10:00:01': { ipaddrs: [ null, 7, {}, [ SHORT ] ], ip6addrs: [ '', ':::', '1:2:3', '2001:db8:1:::10', '2001:db8:1::10%lan', '::ffff:192.0.2.10', 'NaN:NaN:NaN:NaN:NaN:NaN:NaN:NaN', null ] } };
	for (const addr of [ SHORT, '1:2:3', ':::', '2001:db8:1:::10', '65535:0:0:0:0:0:0:1' ])
		assert.deepEqual(taken(build(LIE, addr, junk))[0], [ '00:00:5e:00:53:33' ], addr);
});

/* the gateway is the one plausible holder of the next hop (macOf): a MAC heard on the LAN bridge is none on a
   router's line, a paired access point's own MAC included */
test('build: a paired access point\'s MAC under the gateway\'s address in the hints is not the gateway: it keeps its port and what is behind it', () => {
	const hop = router(null).hints['00:00:5E:00:53:FE'];
	const sta31 = { aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -58) ], wired: [] })) ] };
	const honest = model.build(router(sta31));
	assert.deepEqual(honest.clients.filter(c => c.ap).map(c => c.mac), [ '00:00:5e:00:53:31' ], 'the control: 53:31, heard on its port, is its station');
	/* listed after the gateway's own key, as luci-rpc orders them: by the MAC's text */
	const m = model.build(router(sta31, { hints: Object.assign({}, router(null).hints, { '02:00:5E:10:00:01': hop }) }));
	assert.deepEqual(m.wiredHosts.map(h => [ h.mac, h.gateway ]), honest.wiredHosts.map(h => [ h.mac, h.gateway ]), 'no host of the LAN is the gateway');
	assert.deepEqual([ m.clients.filter(c => c.ap).map(c => c.mac), m.accessPoints[0].clients ], [ [ '00:00:5e:00:53:31' ], 1 ]);
	assert.equal(m.uplink.gateway, '203.0.113.1');
});

/* a host that moved to an access point's stations is no longer on the port */
test('build: after a move, the hosts left on the port are counted again: an access point alone on it has its link and traffic', () => {
	const base = model.build(router(null));
	const on = (m, port) => m.wiredHosts.filter(h => h.port === port).map(h => [ h.mac, h.peers, h.shared ]);
	assert.deepEqual(on(base, 'lan1'), [ [ HALL_MAC, 2, true ], [ '00:00:5e:00:53:31', 2, true ] ]);
	const m = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -58) ], wired: [] })) ] }));
	assert.deepEqual(on(m, 'lan1'), [ [ HALL_MAC, 1, false ] ], 'the access point alone');
	assert.deepEqual(on(m, 'lan2'), on(base, 'lan2'), 'another port as it was');
	/* three on the port, one moves: still shared, by two */
	const fdb = router(null).fdb.concat([ { mac: '00:00:5e:00:53:34', port: 'lan1', bridge: 'br-lan', seen: 3 } ]);
	const three = model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -58) ], wired: [] })) ] }, { fdb }));
	assert.deepEqual(on(three, 'lan1'), [ [ HALL_MAC, 2, true ], [ '00:00:5e:00:53:34', 2, true ] ]);
	/* nothing moved: nothing counted again (a host added behind it is on no port here) */
	const none = model.build(router({ aps: [ ap(AP1, 'ap-hall', report()) ] }));
	assert.deepEqual(on(none, 'lan1'), on(base, 'lan1'));
	assert.deepEqual(none.wiredHosts.filter(h => h.ap).map(h => [ h.peers, h.shared ]), [ [ 1, false ], [ 1, false ] ]);
});

/* review F7 */
test('build: an access point\'s stations take their addresses from any of this device\'s own networks; a moved host keeps the ones it had', () => {
	const sta71 = { aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:71', -50) ], wired: [] })) ] };
	const ips = raw => model.build(raw).clients.filter(c => c.mac === '00:00:5e:00:53:71')[0].ips;
	/* a guest network beside lan */
	const guest = router(sta71);
	guest.ifaces.push({ interface: 'guest', up: true, l3_device: 'br-guest', device: 'br-guest', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ], route: [] });
	guest.hints['00:00:5E:00:53:71'] = { name: 'visitor', ipaddrs: [ '198.51.100.71', '203.0.113.71', '192.0.2.71' ] };
	assert.deepEqual(ips(guest), [ '198.51.100.71', '192.0.2.71' ], 'lan\'s and guest\'s, not the WAN\'s');
	/* a LAN by another name */
	const home = router(sta71);
	home.ifaces[0].interface = 'home';
	home.hints['00:00:5E:00:53:71'] = { name: 'tablet', ipaddrs: [ '192.0.2.71', '203.0.113.71' ] };
	assert.deepEqual(ips(home), [ '192.0.2.71' ]);
	/* this device an access point: its uplink is the LAN its clients are on */
	const dev = apDevice(sta71);
	dev.hints['00:00:5E:00:53:71'] = { ipaddrs: [ '192.0.2.71' ] };
	dev.ifaces.push({ interface: 'vpn', up: true, l3_device: 'wg0', device: 'wg0', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ], route: [] });
	assert.deepEqual(ips(dev), [ '192.0.2.71' ]);
	/* a device on one plain port, its uplink, that the access point is on too */
	const plain = { ifaces: [ { interface: 'lan', up: true, l3_device: 'eth0', device: 'eth0', 'ipv4-address': [ { address: '192.0.2.4', mask: 24 } ], route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] },
		{ interface: 'vpn', up: true, l3_device: 'wg0', device: 'wg0', 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ], route: [] } ],
		devs: { eth0: { devtype: 'ethernet', carrier: true } }, hints: { '00:00:5E:00:53:71': { ipaddrs: [ '192.0.2.71' ] } }, collector: sta71 };
	assert.deepEqual(ips(plain), [ '192.0.2.71' ]);
	/* a moved host: the addresses and the name of its wired entry */
	const moving = router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ roam('00:00:5e:00:53:31', -58) ], wired: [] })) ] });
	moving.fdb = [ { mac: HALL_MAC, port: 'lan1', bridge: 'br-x', seen: 1 }, { mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-x', seen: 2 } ];
	moving.hints['00:00:5E:00:53:31'] = { name: 'printer', ipaddrs: [ '203.0.113.31' ] };
	const was = model.build(Object.assign({}, moving, { collector: null })).wiredHosts.filter(h => h.mac === '00:00:5e:00:53:31')[0];
	const now = model.build(moving).clients.filter(c => c.mac === '00:00:5e:00:53:31')[0];
	assert.deepEqual(was.ips, [ '203.0.113.31' ], 'on a bridge without a network of its own: the uplink\'s subnet, as 1.0.20 has it');
	assert.deepEqual([ now.ips, now.name, now.secondary, now.ap.id ], [ was.ips, was.name, was.secondary, AP1 ]);
});

/* ------------------------------------------------------------ WireGuard */

/* keys in a WireGuard key's form: 43 base64 characters and '=' */
const wgKey = c => c.repeat(43) + '=';
/* a peer as luci.wireguard getWgInstances gives one: `wg show all dump` split by tabs, so numbers are text */
const wgPeer = (c, extra) => Object.assign({ name: 'peer ' + c, public_key: wgKey(c), endpoint: '198.51.100.20:40321', allowed_ips: [ '192.0.2.200/32' ],
	latest_handshake: '1700000000', transfer_rx: '1000', transfer_tx: '2000', persistent_keepalive: 'off' }, extra);
const WG_NOW = 1700000100;

test('wireguard: a reply as LuCI\'s plugin gives it: tunnels by name, numbers from text, the key only shortened', () => {
	const t = model.wireguard({
		wg1: { name: 'wg1', public_key: wgKey('Z'), listen_port: '51821', fwmark: 'off', peers: [] },
		wg0: { name: 'wg0', public_key: wgKey('Y'), listen_port: '51820', fwmark: '0x1', peers: [
			wgPeer('A', { name: ' phone ', allowed_ips: [ '192.0.2.200/32', '2001:db8:2::200/128' ], persistent_keepalive: '25' }),
			wgPeer('B', { name: undefined, endpoint: '(none)', allowed_ips: [], latest_handshake: '0', transfer_rx: '0', transfer_tx: '0' }),
			wgPeer('C', { name: null, endpoint: '[2001:db8::7]:51820' })
		] }
	}, WG_NOW);
	assert.deepEqual(t.map(x => [ x.name, x.port, x.peers.length ]), [ [ 'wg0', 51820, 3 ], [ 'wg1', 51821, 0 ] ]);
	/* the two with a session by label, then the one without a handshake */
	const [ c, a, b ] = t[0].peers;
	assert.deepEqual(a, { id: wgKey('A'), key: 'AAAAA…AAAAA=', name: 'phone', label: 'phone', endpoint: '198.51.100.20:40321',
		allowed: [ '192.0.2.200/32', '2001:db8:2::200/128' ], handshake: 1700000000, age: 100, state: 'recent', rx: 1000, tx: 2000, keepalive: 25 });
	assert.deepEqual([ c.name, c.label, c.endpoint, c.keepalive ], [ '', 'CCCCC…CCCCC=', '[2001:db8::7]:51820', null ], 'no description: the shortened key is its label');
	assert.deepEqual([ b.label, b.endpoint, b.allowed, b.handshake, b.age, b.state, b.rx, b.tx ], [ 'BBBBB…BBBBB=', null, [], 0, null, 'never', 0, 0 ]);
	/* numbers as numbers too (a stand-in, another version of the plugin) */
	const n = model.wireguard({ wg0: { listen_port: 51820, peers: [ wgPeer('A', { latest_handshake: 1700000000, transfer_rx: 5, transfer_tx: 7, persistent_keepalive: 25 }) ] } }, WG_NOW + 0.75);
	assert.deepEqual([ n[0].port, n[0].peers[0].handshake, n[0].peers[0].rx, n[0].peers[0].tx, n[0].peers[0].keepalive ], [ 51820, 1700000000, 5, 7, 25 ]);
	assert.equal(n[0].peers[0].age, 100, 'whole seconds, whatever the clock\'s fraction');
	/* the whole key is the peer's id and nowhere else */
	for (const p of t[0].peers) assert.ok(!JSON.stringify(Object.assign({}, p, { id: '' })).includes(p.id), p.label);
});

test('wireguard: a handshake ahead of this browser\'s clock is now, not in the future', () => {
	const peer = (c, hs) => ({ name: c, public_key: wgKey(c), endpoint: '(none)', allowed_ips: [], latest_handshake: String(hs), transfer_rx: '0', transfer_tx: '0', persistent_keepalive: 'off' });
	/* the browser is ten minutes behind the router: the newest handshake is the time it is, for every peer of every tunnel */
	const out = model.wireguard({ wg0: { peers: [ peer('A', 1700000600), peer('B', 1700000300) ] }, wg1: { peers: [ peer('C', 1700000000), peer('D', 0) ] } }, 1700000000);
	const by = Object.fromEntries(out.flatMap(t => t.peers).map(p => [ p.name, [ p.age, p.state ] ]));
	assert.deepEqual(by, { A: [ 0, 'recent' ], B: [ 300, 'stale' ], C: [ 600, 'stale' ], D: [ null, 'never' ] });
	/* a clock that is right, or ahead, is the clock: nothing is moved */
	assert.deepEqual(model.wireguard({ wg0: { peers: [ peer('A', 1700000600) ] } }, 1700000700)[0].peers.map(p => [ p.age, p.state ]), [ [ 100, 'recent' ] ]);
});

test('wireguard: no reply, junk and half a reply are no tunnels or less of one, never an error', () => {
	for (const r of [ undefined, null, 'x', 7, [], [ { name: 'wg0', peers: [] } ], {}, { wg0: 1, wg1: 'up', wg2: null, wg3: [], wg4: {} } ])
		assert.deepEqual(model.wireguard(r, WG_NOW), [], JSON.stringify(r));
	const t = model.wireguard({
		'bad name': { peers: [ wgPeer('A') ] }, [ 'a'.repeat(16) ]: { peers: [ wgPeer('A') ] }, '': { peers: [ wgPeer('A') ] },
		wg9: 'x', wg8: null, wg7: { listen_port: 'x', peers: 'x' }, wg6: { listen_port: '0', peers: [ null, 7, 'x', [], {} ] }, wg5: { listen_port: '65536' },
		wg0: { listen_port: '51820', peers: [
			wgPeer('A'), wgPeer('A', { name: 'the same key again' }),
			wgPeer('B', { public_key: 'B'.repeat(44) }), wgPeer('C', { public_key: wgKey('C') + '\n' }), wgPeer('D', { public_key: [ wgKey('D') ] }), wgPeer('E', { public_key: 'E'.repeat(42) + '=' }),
			wgPeer('F', { name: 'Evil‮name', endpoint: 'http://example.com/ x', allowed_ips: [ '192.0.2.1/32', '(none)', 7, null, 'a b/24', '192.0.2.0/24<', '2001:db8::/32' ],
				latest_handshake: '-5', transfer_rx: '1e9', transfer_tx: -1, persistent_keepalive: '70000' }),
			wgPeer('G', { name: 'n'.repeat(80), endpoint: 7, allowed_ips: 'x', latest_handshake: '17000000001700000000', transfer_rx: 1.5, transfer_tx: Infinity }),
			wgPeer('H', { name: 7, latest_handshake: String(WG_NOW + 500) })
		] }
	}, WG_NOW);
	assert.deepEqual(t.map(x => [ x.name, x.port, x.peers.length ]), [ [ 'wg0', 51820, 4 ], [ 'wg6', null, 0 ] ],
		'a tunnel is a name an interface can have with a list of peers; a port that is none is none');
	const by = Object.fromEntries(t[0].peers.map(p => [ p.id[0], p ]));
	assert.deepEqual(Object.keys(by).sort(), [ 'A', 'F', 'G', 'H' ], 'a peer needs a key in a key\'s form, once');
	assert.equal(by.A.name, 'peer A', 'the first of two with one key');
	assert.deepEqual([ by.F.name, by.F.endpoint, by.F.allowed, by.F.handshake, by.F.state, by.F.rx, by.F.tx, by.F.keepalive ],
		[ 'Evil�name', null, [ '192.0.2.1/32', '2001:db8::/32' ], 0, 'never', null, null, null ], 'text made safe; what is no address, time or count is none');
	assert.deepEqual([ Array.from(by.G.name).length, by.G.name.slice(-1), by.G.endpoint, by.G.allowed, by.G.handshake, by.G.rx, by.G.tx ], [ 48, '…', null, [], 0, null, null ]);
	assert.deepEqual([ by.H.name, by.H.label, by.H.age, by.H.state ], [ '', 'HHHHH…HHHHH=', 0, 'recent' ], 'a handshake ahead of this clock is now, not before');
	/* without a clock nothing is recent */
	assert.deepEqual(model.wireguard({ wg0: { peers: [ wgPeer('A') ] } }).map(x => x.peers.map(p => [ p.age, p.state ])), [ [ [ null, 'stale' ] ] ]);
	/* a key that is also an object's own: a tunnel like any other, nothing of the prototype's */
	assert.deepEqual(model.wireguard(JSON.parse('{"__proto__":{"peers":[]},"constructor":{"peers":[]}}'), WG_NOW).map(x => x.name), [ '__proto__', 'constructor' ]);
});

test('wireguard: caps: 8 tunnels, 128 peers each, 8 allowed IPs a peer', () => {
	const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	const key = n => b64[n >> 6 & 63] + b64[n & 63] + 'A'.repeat(41) + '=';
	const reply = {};
	for (let i = 0; i < 12; i++) reply['wg' + String(i).padStart(2, '0')] = { listen_port: String(51820 + i),
		peers: Array.from({ length: 200 }, (x, k) => wgPeer('A', { public_key: key(k), allowed_ips: Array.from({ length: 20 }, (y, j) => '192.0.2.' + j + '/32') })) };
	const t = model.wireguard(reply, WG_NOW);
	assert.deepEqual(t.map(x => x.name), [ 'wg00', 'wg01', 'wg02', 'wg03', 'wg04', 'wg05', 'wg06', 'wg07' ]);
	assert.ok(t.every(x => x.peers.length === 128 && x.peers.every(p => p.allowed.length === 8)));
});

test('wireguard: a peer is recent up to three minutes after its handshake, stale past that, never without one', () => {
	assert.equal(model.WG_RECENT_S, 180, 'WireGuard uses no session key older than 180 s, and makes a new handshake after 120 s while traffic flows');
	const at = ago => model.wireguard({ wg0: { peers: [ wgPeer('A', { latest_handshake: String(WG_NOW - ago) }) ] } }, WG_NOW)[0].peers[0];
	assert.deepEqual([ 0, 119, 125, 180, 181, 3600, 30 * 86400 ].map(s => at(s).state), [ 'recent', 'recent', 'recent', 'recent', 'stale', 'stale', 'stale' ]);
	assert.deepEqual([ at(47).age, at(181).age ], [ 47, 181 ]);
	assert.equal(model.wireguard({ wg0: { peers: [ wgPeer('A', { latest_handshake: '0' }) ] } }, WG_NOW)[0].peers[0].state, 'never');
});

test('wireguard: peers with a session first, by name; then by their last handshake; then those without one', () => {
	const order = (now, tablet) => model.wireguard({ wg0: { peers: [
		wgPeer('A', { name: 'never, b', latest_handshake: '0' }),
		wgPeer('B', { name: 'tablet', latest_handshake: String(tablet || WG_NOW - 110) }),
		wgPeer('C', { name: 'an hour ago', latest_handshake: String(WG_NOW - 3600) }),
		wgPeer('D', { name: 'Laptop', latest_handshake: String(WG_NOW - 5) }),
		wgPeer('E', { name: 'days ago', latest_handshake: String(WG_NOW - 3 * 86400) }),
		wgPeer('F', { name: undefined, latest_handshake: '0' }),
		wgPeer('G', { name: 'phone', latest_handshake: String(WG_NOW - 60) })
	] } }, now)[0].peers.map(p => p.label);
	assert.deepEqual(order(WG_NOW), [ 'Laptop', 'phone', 'tablet', 'an hour ago', 'days ago', 'FFFFF…FFFFF=', 'never, b' ]);
	/* the tablet makes its next handshake, the latest of all: nobody changes places for that */
	assert.deepEqual(order(WG_NOW + 20, WG_NOW + 10).slice(0, 3), [ 'Laptop', 'phone', 'tablet' ]);
	/* its session ran out instead: behind those that have one, ahead of older ones */
	assert.deepEqual(order(WG_NOW + 100).slice(0, 4), [ 'Laptop', 'phone', 'tablet', 'an hour ago' ]);
	assert.deepEqual(model.wireguard({ wg0: { peers: [ wgPeer('B', { latest_handshake: String(WG_NOW - 110) }) ] } }, WG_NOW + 100)[0].peers[0].state, 'stale');
});

test('wireguard: rates between two answers from the peers\' byte counters, as for any other counter', () => {
	const counters = (rx, tx) => {
		const out = {};
		for (const t of model.wireguard({ wg0: { peers: [ wgPeer('A', { transfer_rx: String(rx), transfer_tx: String(tx) }), wgPeer('B', { transfer_rx: 'x' }) ] } }, WG_NOW))
			for (const p of t.peers) if (p.rx != null && p.tx != null) out[t.name + ' ' + p.id] = { rx: p.rx, tx: p.tx };
		return out;
	};
	const k = 'wg0 ' + wgKey('A');
	const a = model.rates(null, counters(1000, 2000), 10000);
	assert.deepEqual(Object.keys(a.next), [ k ], 'a peer without a count has no rate');
	assert.deepEqual(Object.keys(a.rates), [], 'one answer is no rate');
	const b = model.rates(a.next, counters(1000 + 5000, 2000 + 250), 15000);
	assert.deepEqual(b.rates[k], { rx: 8000, tx: 400 }, 'bit/s: received from the peer, sent to it');
	/* the same answer again (between slow polls): no sample, the base stays */
	const same = model.rates(b.next, counters(6000, 2250), 15000);
	assert.deepEqual([ Object.keys(same.rates), same.next[k] ], [ [], b.next[k] ]);
	/* the interface restarted: its counters start over, no rate across that */
	assert.deepEqual(Object.keys(model.rates(b.next, counters(10, 20), 20000).rates), []);
});

/* ------------------------------------------ named devices that are offline */

/* the router above with ap-hall paired: a laptop on its own Wi-Fi, a
   printer and a host on its ports, a phone on ap-hall's Wi-Fi and two
   hosts on ap-hall's ports */
const NAMED = {
	'00:00:5e:00:53:01': { sid: 'cfg01', name: 'Laptop', icon: 'laptop' },
	'00:00:5e:00:53:31': { sid: 'cfg02', name: 'Printer', icon: 'printer' },
	'00:00:5e:00:53:21': { sid: 'cfg03', name: 'Phone', icon: 'phone' },
	'00:00:5e:00:53:41': { sid: 'cfg04', name: 'Hall TV', icon: 'tv' }
};
const AWAY = {
	'00:00:5e:00:53:c2': { sid: 'cfg10', name: 'workshop camera', icon: 'camera' },
	'00:00:5e:00:53:c1': { sid: 'cfg11', name: 'Den speaker', icon: null },
	'02:00:5e:00:53:c3': { sid: 'cfg12', name: 'Zoe\'s phone', icon: 'phone' },
	'00:00:5e:00:53:c4': { sid: 'cfg13', name: 'Den speaker', icon: 'speaker' }
};

test('build: named devices in neither list are offline, by name, with the name, icon and MAC their alias has', () => {
	const paired = { aps: [ ap(AP1, 'ap-hall', report()) ] };
	const plain = model.build(router(paired, { aliases: NAMED }));
	assert.deepEqual(plain.offline, [], 'every named device is in a list: a station, a wired host, an access point\'s station, its wired host');
	const m = model.build(router(paired, { aliases: Object.assign({}, AWAY, NAMED) }));
	assert.deepEqual(m.offline.map(c => [ c.mac, c.name, c.icon, c.secondary, c.nameSource, c.alias, c.aliasSid, c.offline ]), [
		[ '00:00:5e:00:53:c1', 'Den speaker', 'speaker', '00:00:5E:00:53:C1', 'alias', 'Den speaker', 'cfg11', true ],
		[ '00:00:5e:00:53:c4', 'Den speaker', 'speaker', '00:00:5E:00:53:C4', 'alias', 'Den speaker', 'cfg13', true ],
		[ '00:00:5e:00:53:c2', 'workshop camera', 'camera', '00:00:5E:00:53:C2', 'alias', 'workshop camera', 'cfg10', true ],
		[ '02:00:5e:00:53:c3', 'Zoe\'s phone', 'phone', '02:00:5E:00:53:C3', 'alias', 'Zoe\'s phone', 'cfg12', true ]
	], 'by name whatever its case, one name twice by MAC; an icon the alias lacks is guessed from the name, as for a connected device');
	assert.deepEqual(m.offline.map(c => [ c.plainName, c.macLabel, c.isPrivate, c.ips, c.vendor ]), [
		[ 'Den speaker', '00:00:5E:00:53:C1', false, [], null ], [ 'Den speaker', '00:00:5E:00:53:C4', false, [], null ],
		[ 'workshop camera', '00:00:5E:00:53:C2', false, [], null ], [ 'Zoe\'s phone', '02:00:5E:00:53:C3', true, [], null ] ]);
	/* in no other list, count or access point: the lists are as without them */
	const lists = x => [ x.clients, x.wiredHosts, x.accessPoints, x.radios, x.ssids ];
	assert.deepEqual(lists(m), lists(plain));
	assert.ok(!m.offline.some(c => 'port' in c || 'signal' in c || 'ap' in c), 'neither a station nor a wired host');
	/* a named device that comes back is in its list again and offline no more */
	const back = router(paired, { aliases: Object.assign({}, AWAY, NAMED) });
	back.assoc['phy0-ap0'].push({ mac: '02:00:5E:00:53:C3', signal: -60 });
	back.fdb.push({ mac: '00:00:5e:00:53:c2', port: 'lan2', bridge: 'br-lan', seen: 1 });
	assert.deepEqual(model.build(back).offline.map(c => c.mac), [ '00:00:5e:00:53:c1', '00:00:5e:00:53:c4' ]);
	/* without the access point its named clients are in no list here */
	assert.deepEqual(model.build(router(null, { aliases: NAMED })).offline.map(c => c.name), [ 'Hall TV', 'Phone' ]);
	/* no names, no list; a build without any input too */
	assert.deepEqual(model.build(router(paired)).offline, []);
	assert.deepEqual(model.build({}).offline, []);
});

test('build: an offline device\'s address is what the host hints still give; its vendor is looked up whatever its name', () => {
	const r = router(null, { aliases: AWAY, vendor: k => k === '00:00:5E' ? 'Example Corp' : null });
	/* a lease that has not run out, with an address outside this device's networks beside it */
	r.hints['00:00:5E:00:53:C1'] = { name: 'speaker-lease-name', ipaddrs: [ '192.0.2.61', '198.51.100.61' ] };
	const by = Object.fromEntries(model.build(r).offline.map(c => [ c.mac, c ]));
	const den = by['00:00:5e:00:53:c1'];
	assert.deepEqual([ den.name, den.nameSource, den.ips, den.secondary ], [ 'Den speaker', 'alias', [ '192.0.2.61' ], '00:00:5E:00:53:C1' ],
		'the alias stays its name, the MAC its second line; the address is beside them');
	assert.deepEqual(by['00:00:5e:00:53:c4'].ips, [], 'none where the hints have none');
	assert.deepEqual([ den.vendor, by['00:00:5e:00:53:c2'].vendor, by['02:00:5e:00:53:c3'].vendor ], [ 'Example Corp', 'Example Corp', null ], 'no vendor behind a private address');
	/* a connected device with a name keeps the vendor out of its entry, as before */
	const here = model.build(router(null, { aliases: NAMED, vendor: () => 'Example Corp' }));
	assert.equal(here.clients[0].vendor, null);
});

test('build: the offline list is bounded by the names the dashboard accepts; this device\'s own MACs and broken entries are never in it', () => {
	const names = load('vantage.names');
	const many = {};
	for (let i = 0; i < names.ALIAS_MAX + 40; i++)
		many['00:00:5e:01:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0')] = { sid: 'c' + i, name: 'Device ' + String(i).padStart(4, '0') };
	const m = model.build(router(null, { aliases: many }));
	assert.equal(m.offline.length, names.ALIAS_MAX);
	assert.deepEqual(m.offline.slice(0, 2).map(c => c.name), [ 'Device 0000', 'Device 0001' ]);
	const odd = model.build(router(null, { aliases: {
		'00:00:5e:00:53:f0': { sid: 'a', name: 'This router' },                /* br-lan's own MAC */
		'00:00:5E:00:53:C1': { sid: 'b', name: 'Not a key of the map' },       /* upper case: aliasMap never writes one */
		'not-a-mac': { sid: 'c', name: 'Junk' },
		'00:00:5e:00:53:c5': { sid: 'd', name: '' },                           /* no name: not a named device */
		'00:00:5e:00:53:c6': { sid: 'e', name: 'a‮b' },                   /* a name the dashboard refuses */
		'00:00:5e:00:53:c7': null,
		'00:00:5e:00:53:c8': { sid: 'f', name: 'Scanner', icon: 'rocket' }     /* an unknown icon: guessed */
	} }));
	assert.deepEqual(odd.offline.map(c => [ c.mac, c.name, c.icon ]), [ [ '00:00:5e:00:53:c8', 'Scanner', 'device' ] ]);
	for (const junk of [ null, 7, 'x', [ { name: 'A' } ] ]) assert.deepEqual(model.build(router(null, { aliases: junk })).offline, [], JSON.stringify(junk));
});

/* ------------------------------------------------------------ Ports tile */

/* devices as netifd's network.device status lists them: a port's driver names the link modes it supports */
const PORT_MODES = [ '10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F' ];
const ethDev = extra => Object.assign({ devtype: 'ethernet', type: 'Network device', up: true, carrier: true, speed: '1000F', 'link-supported': PORT_MODES }, extra);
const dsaDev = extra => Object.assign({ devtype: 'dsa', type: 'Network device', up: true, carrier: true, speed: '1000F', conduit: 'eth0', 'link-supported': PORT_MODES }, extra);
const portIds = list => list.map(p => p.id);

test('ports: a DSA router: the switch\'s ports and an adapter of its own, never the conduit', () => {
	const devs = {
		eth0: ethDev({ speed: '2500F' }),   /* the CPU's side of the switch: its ports name it */
		wan: dsaDev(), lan1: dsaDev(), lan2: dsaDev({ carrier: false, speed: undefined }), lan3: dsaDev({ speed: '100H' }), lan10: dsaDev(),
		eth1: ethDev({ speed: '2500F' }),   /* a second adapter with its own PHY */
		'br-lan': { devtype: 'bridge', type: 'bridge', up: true, carrier: true, speed: '1000F', 'link-supported': [], 'bridge-members': [ 'lan1', 'lan2', 'lan3', 'lan10', 'phy0-ap0' ] },
		'wan.35': { devtype: 'vlan', type: '8021q', up: true, carrier: true, speed: '1000F', 'link-supported': PORT_MODES },
		'pppoe-wan': { devtype: 'ppp', type: 'Network device', up: true, carrier: true },
		'phy0-ap0': { devtype: 'wlan', type: 'Network device', up: true, carrier: true },
		'phy1-ap0': { type: 'Network device', up: true, carrier: true },   /* ath12k: no devtype at all */
		lo: { type: 'Network device', up: true, carrier: true },
		wg0: { devtype: 'wireguard', type: 'wireguard', up: true, carrier: true },
		'gre4-site': { devtype: 'gre', type: 'tunnel', up: true, carrier: true },
		bond0: { devtype: 'bond', type: 'bonding', up: true, carrier: true, speed: '2000F', 'link-supported': [] }
	};
	const p = model.ports(devs, {}, {}, [ 'phy0-ap0', 'phy1-ap0' ], [], []);
	assert.deepEqual(portIds(p), [ 'eth1', 'lan1', 'lan2', 'lan3', 'lan10', 'wan' ], 'in name order, lan2 before lan10');
	assert.deepEqual(p.map(x => x.kind), [ 'eth', 'dsa', 'dsa', 'dsa', 'dsa', 'dsa' ]);
	assert.deepEqual(p.map(x => [ x.name, x.dev ]), p.map(x => [ x.id, x.id ]), 'a port goes by its device\'s name, and its hosts are that device\'s');
	/* the link and what was negotiated on it; none without one */
	assert.deepEqual(p.map(x => [ x.link, x.speed && x.speed.mbps, x.speed && x.speed.duplex ]),
		[ [ true, 2500, 'full' ], [ true, 1000, 'full' ], [ false, null, null ], [ true, 100, 'half' ], [ true, 1000, 'full' ], [ true, 1000, 'full' ] ]);
	assert.ok(p.every(x => x.sw === null && x.hosts === 0 && x.lines.length === 0));
	/* a switch whose ports are all down still names its conduit: netifd asks the kernel, not the link */
	assert.ok(!portIds(model.ports({ eth0: ethDev(), lan1: dsaDev({ carrier: false }) }, {}, {}, [], [], [])).includes('eth0'));
	/* without anyone naming it, the same device is a port of its own (a board with one adapter and no switch) */
	assert.deepEqual(portIds(model.ports({ eth0: ethDev() }, {}, {}, [], [], [])), [ 'eth0' ]);
	/* a cascaded switch: its conduit is a port of the first, and stays one */
	assert.deepEqual(portIds(model.ports({ eth0: ethDev(), lan1: dsaDev(), sw2p1: dsaDev({ conduit: 'lan1' }) }, {}, {}, [], [], [])), [ 'lan1', 'sw2p1' ]);
});

test('ports: an x86 box: every Ethernet adapter whose driver names a link mode; nothing virtual, nothing wireless', () => {
	const devs = {
		eth0: ethDev(), eth1: ethDev({ speed: '2500F' }), eth2: ethDev({ carrier: false, speed: undefined }), eth10: ethDev({ speed: '10000F' }),
		/* what netifd also calls ethernet: no link mode named by the driver (ethtool: "Not reported") */
		veth0: ethDev({ 'link-supported': [], speed: '10000F' }),
		tap0: ethDev({ 'link-supported': [], speed: '10F' }),
		eth5: ethDev({ 'link-supported': [], speed: undefined }),   /* a virtual machine's paravirtual adapter */
		eth6: { devtype: 'ethernet', up: true, carrier: true, speed: '1000F' },   /* no such list at all: cannot tell */
		eth7: ethDev({ 'link-supported': 'all' }),
		/* a vendor Wi-Fi driver that answers ethtool: wireless by its name, and one the wireless status names */
		ra0: ethDev(), apcli0: ethDev(),
		'br-lan': { devtype: 'bridge', type: 'bridge', up: true, carrier: true, 'link-supported': [], 'bridge-members': [ 'eth1', 'eth2', 'veth0' ] },
		'eth1.10': { devtype: 'vlan', type: 'VLAN', up: true, carrier: true, speed: '2500F', 'link-supported': PORT_MODES },
		/* a macvlan as netifd reports it: the kernel gives it no type, so "ethernet", with its parent's link modes */
		macvlan0: ethDev({ type: 'macvlan', parent: 'eth0' }),
		dummy0: { type: 'Network device', up: true, carrier: true },
		docker0: { devtype: 'bridge', type: 'bridge', up: true, carrier: false, 'link-supported': [] }
	};
	assert.deepEqual(portIds(model.ports(devs, {}, {}, [ 'apcli0' ], [], [])), [ 'eth0', 'eth1', 'eth2', 'eth10' ]);
	/* an access point with one port: one, and the view shows no tile for that */
	const ap = { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'eth0', 'phy0-ap0' ], 'link-supported': [] }, eth0: ethDev({ speed: '2500F' }), 'phy0-ap0': { up: true, carrier: true }, lo: { up: true } };
	assert.deepEqual(portIds(model.ports(ap, {}, {}, [ 'phy0-ap0' ], [], [])), [ 'eth0' ]);
	/* and stays one with a macvlan on that port: no tile for it */
	assert.deepEqual(portIds(model.ports(Object.assign({ macvlan0: ethDev({ type: 'macvlan', parent: 'eth0', speed: '2500F' }) }, ap), {}, {}, [ 'phy0-ap0' ], [], [])), [ 'eth0' ]);
});

test('ports: a swconfig switch: its ports as the plugin maps them, each once; the CPU\'s side is none', () => {
	const lan = n => ({ num: n, role: 'lan', index: n });
	const switches = {
		'eth0.1': { name: 'switch0', vlan: 1, ports: [ lan(1), lan(2), lan(3), lan(4) ] },
		'eth0.2': { name: 'switch0', vlan: 2, ports: [ { num: 5, role: 'wan', index: null } ] },
		/* a guest VLAN on two of the LAN ports, tagged: the same ports again */
		'eth0.3': { name: 'switch0', vlan: 3, ports: [ lan(3), lan(4) ] }
	};
	const devs = { eth0: ethDev(), 'eth0.1': { devtype: 'vlan', up: true, carrier: true, speed: '1000F', 'link-supported': PORT_MODES }, 'eth0.2': { devtype: 'vlan', up: true, carrier: true, 'link-supported': PORT_MODES },
		eth1: ethDev({ speed: '2500F' }), 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'eth0.1' ], 'link-supported': [] } };
	const st = (n, link, speed, duplex) => ({ port: n, link, speed, duplex: duplex !== false });
	const state = { switch0: [ st(0, true, 1000), st(1, true, 1000), st(2, false, 0), st(3, true, 100, false), st(4, false, 0), st(5, true, 1000) ] };
	const hosts = [ { mac: '00:00:5e:00:53:11', port: 'eth0.1' }, { mac: '00:00:5e:00:53:12', port: 'eth0.1' }, { mac: '00:00:5e:00:53:13', port: 'eth1' } ];
	const p = model.ports(devs, switches, state, [], hosts, []);
	/* eth0 carries the switch (eth0.1, eth0.2): not a port; eth1 is one; then the switch's, by their labels */
	assert.deepEqual(portIds(p), [ 'eth1', 'switch0 1', 'switch0 2', 'switch0 3', 'switch0 4', 'switch0 5' ]);
	assert.deepEqual(p.map(x => x.name), [ 'eth1', 'LAN 1', 'LAN 2', 'LAN 3', 'LAN 4', 'Port 5' ]);
	assert.deepEqual(p.slice(1).map(x => [ x.kind, x.sw.name, x.sw.num, x.counters ]), [ 1, 2, 3, 4, 5 ].map(n => [ 'switch', 'switch0', n, null ]), 'a switch port has no counters here');
	assert.deepEqual(p.slice(1).map(x => [ x.link, x.speed && x.speed.mbps, x.speed && x.speed.duplex ]),
		[ [ true, 1000, 'full' ], [ false, null, null ], [ true, 100, 'half' ], [ false, null, null ], [ true, 1000, 'full' ] ]);
	/* two LAN ports have a link: which of them the VLAN's hosts are behind is not known */
	assert.deepEqual(p.map(x => [ x.dev, x.hosts ]), [ [ 'eth1', 1 ], [ null, null ], [ null, null ], [ 'eth0.3', 0 ], [ null, null ], [ 'eth0.2', 0 ] ],
		'the guest VLAN has one port with a link, the WAN VLAN one port at all');
	/* one with a link: the hosts are behind it, and a click lists the VLAN device's */
	const one = model.ports(devs, switches, { switch0: [ st(1, false, 0), st(2, true, 1000), st(3, false, 0), st(4, false, 0), st(5, true, 1000) ] }, [], hosts, []);
	assert.deepEqual(one.map(x => [ x.name, x.dev, x.hosts ]).slice(1, 3), [ [ 'LAN 1', null, null ], [ 'LAN 2', 'eth0.1', 2 ] ]);
	/* a switch that has not answered (it is asked only with hosts behind it): the ports, their links unknown */
	const quiet = model.ports(devs, switches, {}, [], hosts, []);
	assert.deepEqual(quiet.slice(1).map(x => [ x.name, x.link, x.speed ]), [ 'LAN 1', 'LAN 2', 'LAN 3', 'LAN 4', 'Port 5' ].map(n => [ n, null, null ]));
	assert.deepEqual(quiet.map(x => x.hosts), [ 1, null, null, null, null, 0 ]);
	/* the CPU's side untagged (the map names the device itself), and a second switch after the first */
	const two = model.ports({ eth0: ethDev(), eth1: ethDev() }, { eth0: { name: 'switch1', vlan: 1, ports: [ lan(2), lan(1) ] }, 'eth1.7': { name: 'switch0', vlan: 7, ports: [ lan(1) ] } }, {}, [], [], []);
	assert.deepEqual(portIds(two), [ 'switch0 1', 'switch1 1', 'switch1 2' ]);
	/* no map (a DSA device, an older plugin, a failed call): nothing of a switch, and no error */
	for (const none of [ null, undefined, [], 'x', { 'eth0.1': null }, { 'eth0.1': { name: '../x', vlan: 1, ports: [ lan(1) ] } } ])
		assert.ok(model.ports({ eth1: ethDev() }, none, state, [], [], []).every(x => !x.sw), JSON.stringify(none));
});

test('ports: the wired hosts learned on a port are counted on it, a paired access point\'s on none', () => {
	const devs = { eth0: ethDev(), lan1: dsaDev(), lan2: dsaDev(), lan3: dsaDev(), 'lan3.20': { devtype: 'vlan', up: true, carrier: true, 'link-supported': PORT_MODES } };
	const hosts = [ { mac: 'a', port: 'lan1' }, { mac: 'b', port: 'lan2' }, { mac: 'c', port: 'lan2' }, { mac: 'd', port: 'lan2' },
		{ mac: 'e', port: 'lan2', ap: { id: 'x', port: 'lan2' } },   /* behind an access point: its port there, not here */
		{ mac: 'f', port: 'lan3.20' },                                  /* on a VLAN of the port: listed under the VLAN device */
		{ mac: 'g', port: 'phy0-ap0' }, { mac: 'h' }, null, 'x' ];
	assert.deepEqual(model.ports(devs, {}, {}, [], hosts, []).map(p => [ p.id, p.hosts ]), [ [ 'lan1', 1 ], [ 'lan2', 3 ], [ 'lan3', 0 ] ]);
	for (const junk of [ null, undefined, 'x', {}, 7 ]) assert.deepEqual(model.ports(devs, {}, {}, [], junk, junk).map(p => p.hosts), [ 0, 0, 0 ]);
});

test('ports: errors, drops and collisions since boot, as counts; junk is none', () => {
	const devs = {
		eth0: ethDev({ statistics: { rx_bytes: 1e9, tx_bytes: 2e9, rx_errors: 12, tx_errors: 0, rx_dropped: 3, tx_dropped: 4, collisions: 7, rx_crc_errors: 12 } }),
		eth1: ethDev({ statistics: { rx_errors: -1, tx_errors: '5', rx_dropped: NaN, tx_dropped: null, collisions: Infinity } }),
		eth2: ethDev({ statistics: 'x' }), eth3: ethDev()
	};
	const zero = { rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0, collisions: 0 };
	assert.deepEqual(model.ports(devs, {}, {}, [], [], []).map(p => p.counters), [ { rxErrors: 12, txErrors: 0, rxDropped: 3, txDropped: 4, collisions: 7 }, zero, zero, zero ]);
});

test('ports: junk in, no ports out; 64 at most; a name is text made safe', () => {
	for (const junk of [ null, undefined, [], 'x', 7, { eth0: null }, { eth0: 'x' }, { eth0: [ ethDev() ] }, { eth0: { devtype: [ 'ethernet' ], 'link-supported': PORT_MODES } } ])
		assert.deepEqual(model.ports(junk, junk, junk, junk, junk, junk), [], JSON.stringify(junk));
	const many = {};
	for (let i = 1; i <= 70; i++) many['lan' + i] = dsaDev();
	const p = model.ports(many, {}, {}, [], [], []);
	assert.equal(p.length, model.MAX_PORTS);
	assert.deepEqual([ model.MAX_PORTS, p[0].id, p[63].id ], [ 64, 'lan1', 'lan64' ]);
	/* names that are object keys elsewhere, and one a kernel would take that no page should show as written */
	const odd = model.ports({ __proto__: null, constructor: ethDev(), toString: dsaDev(), ['x‮y']: ethDev() }, { hasOwnProperty: { name: 'switch0', vlan: 1, ports: [ { num: 1 } ] } }, {}, [], [ { port: 'constructor' }, { port: '__proto__' } ], []);
	assert.deepEqual(odd.map(x => [ x.id, x.name, x.hosts ]), [ [ 'constructor', 'constructor', 1 ], [ 'toString', 'toString', 0 ], [ 'x‮y', 'x�y', 0 ], [ 'switch0 1', 'Port 1', 0 ] ]);
});

/* a line to the internet as build() makes them, on a model of its own */
const portsOf = raw => { const m = model.build(raw); return { m, marks: m.ports.map(p => [ p.id, p.lines ]).filter(x => x[1].length) }; };
const route4 = hop => [ { target: '0.0.0.0', mask: 0, nexthop: hop } ];

test('build: a line to the internet marks the port it leaves through; a VLAN\'s and a PPPoE session\'s is the port under it', () => {
	const lan = { interface: 'lan', up: true, proto: 'static', device: 'br-lan', l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] };
	const bridge = { devtype: 'bridge', type: 'bridge', up: true, carrier: true, 'link-supported': [], 'bridge-members': [ 'lan1', 'lan2' ] };
	const base = { eth0: ethDev(), lan1: dsaDev(), lan2: dsaDev(), wan: dsaDev(), 'br-lan': bridge };
	/* a router: wan on its own port */
	let r = portsOf({ devs: base, ifaces: [ lan, { interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', route: route4('203.0.113.1') } ] });
	assert.deepEqual(portIds(r.m.ports), [ 'lan1', 'lan2', 'wan' ]);
	assert.deepEqual(r.marks, [ [ 'wan', [ 'wan' ] ] ]);
	/* hardware offload counts the line on the conduit: the mark stays on the port */
	r = portsOf({ devs: Object.assign({}, base, { wan: dsaDev({ 'hw-tc-offload': true }) }), ifaces: [ lan, { interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', route: route4('203.0.113.1') } ] });
	assert.deepEqual([ r.m.uplink.statsDev, r.marks ], [ 'eth0', [ [ 'wan', [ 'wan' ] ] ] ]);
	/* a VLAN on the port (wan.35), and PPPoE over that VLAN */
	const vlan = Object.assign({}, base, { 'wan.35': { devtype: 'vlan', up: true, carrier: true, 'link-supported': PORT_MODES }, 'pppoe-wan': { devtype: 'ppp', up: true, carrier: true } });
	r = portsOf({ devs: vlan, ifaces: [ lan, { interface: 'wan', up: true, proto: 'dhcp', device: 'wan.35', l3_device: 'wan.35', route: route4('203.0.113.1') } ] });
	assert.deepEqual(r.marks, [ [ 'wan', [ 'wan' ] ] ]);
	r = portsOf({ devs: vlan, ifaces: [ lan, { interface: 'wan', up: true, proto: 'pppoe', device: 'wan.35', l3_device: 'pppoe-wan', route: route4('203.0.113.1') } ] });
	assert.deepEqual([ r.m.uplink.port, r.m.uplink.statsDev, r.marks ], [ 'pppoe-wan', 'wan.35', [ [ 'wan', [ 'wan' ] ] ] ]);
	/* two lines: each port its own, by the line's name; wan6 on wan's device is part of wan's */
	r = portsOf({ devs: Object.assign({}, base, { eth1: ethDev() }), ifaces: [ lan,
		{ interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', metric: 10, route: route4('203.0.113.1') },
		{ interface: 'wan6', up: true, proto: 'dhcpv6', device: 'wan', l3_device: 'wan', metric: 10, route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] },
		{ interface: 'wanb', up: true, proto: 'dhcp', device: 'eth1', l3_device: 'eth1', metric: 20, route: route4('198.51.100.1') } ] });
	assert.deepEqual(r.marks, [ [ 'eth1', [ 'wanb' ] ], [ 'wan', [ 'wan' ] ] ]);
	/* a full-tunnel VPN is no line of its own, and a line over a tunnel or with no port leaves through none */
	r = portsOf({ devs: Object.assign({}, base, { wg0: { devtype: 'wireguard', up: true, carrier: true } }), ifaces: [ lan, { interface: 'vpn', up: true, proto: 'wireguard', device: 'wg0', l3_device: 'wg0', route: [ { target: '0.0.0.0', mask: 0 } ] } ] });
	assert.deepEqual(r.marks, []);
	/* a second line on a macvlan of the wan port: no port of its own, and its mark on the port it is on */
	r = portsOf({ devs: Object.assign({}, base, { wanb: ethDev({ type: 'macvlan', parent: 'wan' }) }), ifaces: [ lan,
		{ interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', metric: 10, route: route4('203.0.113.1') },
		{ interface: 'wanb', up: true, proto: 'dhcp', device: 'wanb', l3_device: 'wanb', metric: 20, route: route4('198.51.100.1') } ] });
	assert.deepEqual([ portIds(r.m.ports), r.marks ], [ [ 'lan1', 'lan2', 'wan' ], [ [ 'wan', [ 'wan', 'wanb' ] ] ] ]);
	/* no line at all (the device status failed, nothing is up) */
	assert.deepEqual(portsOf({ devs: base, ifaces: [ lan ] }).marks, []);
	/* every line down on a box whose LAN bridge has one wired port: the uplink falls back to lan, which is no line out */
	const two = { eth0: ethDev(), lan1: dsaDev(), wan: dsaDev({ carrier: false }), 'br-lan': Object.assign({}, bridge, { 'bridge-members': [ 'lan1' ] }) };
	r = portsOf({ devs: two, ifaces: [ lan, { interface: 'wan', up: false, proto: 'dhcp', device: 'wan' } ] });
	assert.deepEqual([ r.m.uplink.iface, r.m.uplink.port, r.m.uplink.defaultRoute, portIds(r.m.ports), r.marks ], [ 'lan', 'lan1', false, [ 'lan1', 'wan' ], [] ]);
	assert.deepEqual(model.build({}).ports, []);
});

test('build: on a bridge the mark is the port the gateway was learned on, never a guessed one; a swconfig VLAN\'s one port', () => {
	const hints = { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.1' ] } };
	const lan = { interface: 'lan', up: true, proto: 'dhcp', device: 'br-lan', l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.2', mask: 24 } ], route: route4('192.0.2.1') };
	/* an access point: its one wired port is the way out, and the hosts heard there are counted on it */
	const ap = { 'br-lan': { devtype: 'bridge', type: 'bridge', 'link-supported': [], 'bridge-members': [ 'eth0', 'phy0-ap0' ] }, eth0: ethDev({ speed: '2500F' }), 'phy0-ap0': { devtype: 'wlan', up: true, carrier: true } };
	let r = portsOf({ devs: ap, ifaces: [ lan ], hints, fdb: [ { mac: '00:00:5e:00:53:01', port: 'eth0', bridge: 'br-lan', seen: 1 }, { mac: '00:00:5e:00:53:21', port: 'eth0', bridge: 'br-lan', seen: 2 } ] });
	assert.deepEqual(r.m.ports.map(p => [ p.id, p.lines, p.hosts ]), [ [ 'eth0', [ 'lan' ], 2 ] ]);
	/* a switch in bridge mode: several wired ports, and nothing says where the gateway is */
	const sw = { 'br-lan': { devtype: 'bridge', type: 'bridge', 'link-supported': [], 'bridge-members': [ 'lan1', 'lan2', 'lan3' ] }, eth0: ethDev(), lan1: dsaDev(), lan2: dsaDev(), lan3: dsaDev() };
	r = portsOf({ devs: sw, ifaces: [ lan ] });
	assert.deepEqual([ r.m.uplink.dev, r.m.uplink.port, r.marks ], [ 'lan1', null, [] ], 'the line counts on a guessed member; no port is marked for it');
	/* the gateway learned on lan3 */
	r = portsOf({ devs: sw, ifaces: [ lan ], hints, fdb: [ { mac: '00:00:5e:00:53:01', port: 'lan3', bridge: 'br-lan', seen: 1 } ] });
	assert.deepEqual(r.marks, [ [ 'lan3', [ 'lan' ] ] ]);
	/* a swconfig router: wan is VLAN 2 of the switch, which has one port */
	const switches = { 'eth0.1': { name: 'switch0', vlan: 1, ports: [ 1, 2, 3, 4 ].map(n => ({ num: n, role: 'lan', index: n })) }, 'eth0.2': { name: 'switch0', vlan: 2, ports: [ { num: 5, role: 'wan', index: 1 } ] } };
	const old = { eth0: ethDev(), 'eth0.1': { devtype: 'vlan', up: true, carrier: true, 'link-supported': PORT_MODES }, 'eth0.2': { devtype: 'vlan', up: true, carrier: true, 'link-supported': PORT_MODES },
		'br-lan': { devtype: 'bridge', type: 'bridge', 'link-supported': [], 'bridge-members': [ 'eth0.1' ] } };
	const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'eth0.2', l3_device: 'eth0.2', route: route4('203.0.113.1') };
	r = portsOf({ devs: old, switches, switchState: {}, ifaces: [ wan ] });
	assert.deepEqual([ portIds(r.m.ports), r.marks ], [ [ 'switch0 1', 'switch0 2', 'switch0 3', 'switch0 4', 'switch0 5' ], [ [ 'switch0 5', [ 'wan' ] ] ] ]);
	assert.deepEqual(r.m.ports[4].name, 'WAN 1');
	/* and PPPoE over that VLAN */
	r = portsOf({ devs: Object.assign({}, old, { 'pppoe-wan': { devtype: 'ppp', up: true, carrier: true } }), switches, switchState: {}, ifaces: [ Object.assign({}, wan, { proto: 'pppoe', l3_device: 'pppoe-wan' }) ] });
	assert.deepEqual(r.marks, [ [ 'switch0 5', [ 'wan' ] ] ]);
	/* the wan port tagged in two VLANs (internet on 35, IPTV on 100): the line on either leaves through it */
	const tagged = { 'eth0.1': switches['eth0.1'], 'eth0.100': { name: 'switch0', vlan: 100, ports: [ { num: 5, role: 'wan', index: 1 } ] }, 'eth0.35': { name: 'switch0', vlan: 35, ports: [ { num: 5, role: 'wan', index: 1 } ] } };
	const both = { eth0: ethDev(), 'eth0.1': old['eth0.1'], 'eth0.100': old['eth0.2'], 'eth0.35': old['eth0.2'], 'br-lan': old['br-lan'] };
	r = portsOf({ devs: both, switches: tagged, switchState: {}, ifaces: [ Object.assign({}, wan, { device: 'eth0.35', l3_device: 'eth0.35' }) ] });
	assert.deepEqual([ r.marks, r.m.ports[4].dev ], [ [ [ 'switch0 5', [ 'wan' ] ] ], 'eth0.100' ]);
	/* a VLAN with several ports and no answer from the switch: which one is not known */
	const wide = Object.assign({}, switches, { 'eth0.2': { name: 'switch0', vlan: 2, ports: [ { num: 5, role: 'wan', index: 1 }, { num: 6, role: 'wan', index: 2 } ] } });
	assert.deepEqual(portsOf({ devs: old, switches: wide, switchState: {}, ifaces: [ wan ] }).marks, []);
	assert.deepEqual(portsOf({ devs: old, switches: wide, switchState: { switch0: [ { port: 5, link: false }, { port: 6, link: true, speed: 1000, duplex: true } ] }, ifaces: [ wan ] }).marks, [ [ 'switch0 6', [ 'wan' ] ] ], 'the one with a link');
});

/* #155: a paired access point's station carries its link as the access point saw it (rx_phy, tx_phy; sgi: HT and VHT's
   short guard interval only). The collector checked it; this device checks it again, field by field, and the link it
   shows for the station is built from it */
const sta21 = extra => Object.assign({ mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -61, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000, connected: 120 }, extra);
const phyOf = p => {
	const a = model.collectorAps({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ sta21({ rxPhy: p, txPhy: p }) ] })) ] })[0];
	assert.deepEqual(a.sta[0].txPhy, a.sta[0].rxPhy, 'the same check both ways');
	return a.sta[0].rxPhy;
};
const NO_FLAGS = { ht: false, vht: false, he: false, eht: false, short_gi: false };

test('collector: a station\'s link: width, MCS and streams in their ranges and whole, each else unknown', () => {
	assert.deepEqual(phyOf({ mhz: 1, mcs: 0, nss: 1 }), Object.assign({ mhz: 1, mcs: 0, nss: 1 }, NO_FLAGS), 'the lowest');
	assert.deepEqual(phyOf({ mhz: 640, mcs: 31, nss: 16 }), Object.assign({ mhz: 640, mcs: 31, nss: 16 }, NO_FLAGS), 'the highest');
	for (const [ field, bad ] of [ [ 'mhz', 0 ], [ 'mhz', 641 ], [ 'mhz', 80.5 ], [ 'mhz', '80' ], [ 'mhz', -20 ], [ 'mhz', Infinity ],
		[ 'mcs', -1 ], [ 'mcs', 32 ], [ 'mcs', 9.5 ], [ 'mcs', '9' ], [ 'mcs', null ],
		[ 'nss', 0 ], [ 'nss', 17 ], [ 'nss', 1.5 ], [ 'nss', '2' ], [ 'nss', true ] ]) {
		const p = Object.assign({ mhz: 80, mcs: 9, nss: 2 }, { [field]: bad });
		assert.deepEqual(phyOf(p), Object.assign({ mhz: 80, mcs: 9, nss: 2 }, NO_FLAGS, { [field]: null }), field + ' ' + String(bad));
	}
	for (const junk of [ null, 'fast', [ 80 ], 7, true ]) assert.equal(phyOf(junk), null, JSON.stringify(junk));
});

test('collector: a station\'s link: each flag its own and only when true; short GI is sgi, the report\'s word', () => {
	for (const f of [ 'ht', 'vht', 'he', 'eht' ])
		assert.deepEqual(phyOf({ mhz: 80, [f]: true }), Object.assign({ mhz: 80, mcs: null, nss: null }, NO_FLAGS, { [f]: true }), f);
	assert.deepEqual(phyOf({ mhz: 80, sgi: true }), Object.assign({ mhz: 80, mcs: null, nss: null }, NO_FLAGS, { short_gi: true }), 'sgi');
	/* not true: false, whatever else it is; and a short_gi the report does not send is not read */
	for (const v of [ 'yes', 1, 'true', {}, [ true ], null ])
		assert.deepEqual(phyOf({ mhz: 80, ht: v, vht: v, he: v, eht: v, sgi: v }), Object.assign({ mhz: 80, mcs: null, nss: null }, NO_FLAGS), JSON.stringify(v));
	assert.deepEqual(phyOf({ mhz: 80, short_gi: true }), Object.assign({ mhz: 80, mcs: null, nss: null }, NO_FLAGS));
});

test('build: a paired access point\'s station shows the link it reports, each way, where it reports one and a rate', () => {
	const wifi = load('vantage.wifi');
	const built = st => model.build(router({ aps: [ ap(AP1, 'ap-hall', report({ stations: [ sta21(st) ] })) ] })).clients.filter(x => x.ap)[0];
	const rxPhy = { mhz: 80, mcs: 9, nss: 2, ht: false, vht: true, he: false, eht: false, sgi: true };
	const txPhy = { mhz: 40, mcs: 7, nss: 1, ht: false, vht: false, he: true, eht: false, sgi: false };
	const c = built({ rxPhy, txPhy });
	assert.deepEqual(c.rx, wifi.phy({ rate: 72200, mhz: 80, mcs: 9, nss: 2, ht: false, vht: true, he: false, eht: false, short_gi: true }));
	assert.deepEqual(c.tx, wifi.phy({ rate: 144400, mhz: 40, mcs: 7, nss: 1, ht: false, vht: false, he: true, eht: false, short_gi: false }));
	assert.deepEqual([ c.rx.mhz, c.rx.mcs, c.rx.nss, c.rx.detail, c.tx.mhz, c.tx.mcs, c.tx.detail ], [ 80, 9, 2, 'MCS 9 · 2×2 · short GI', 40, 7, 'MCS 7 · 1×1' ]);
	/* one way only: the other is the rate alone, as without a link */
	const rxOnly = built({ rxPhy });
	assert.deepEqual([ rxOnly.rx.mhz, rxOnly.tx.mhz, rxOnly.tx.detail, rxOnly.tx.rate ], [ 80, null, '', 144400 ]);
	const txOnly = built({ txPhy });
	assert.deepEqual([ txOnly.rx.mhz, txOnly.rx.detail, txOnly.tx.mhz ], [ null, '', 40 ]);
	/* a link without a rate shows none: no width or MCS of a rate nobody reported */
	const noRate = built({ rxPhy, txPhy, rxRate: null, txRate: 0 });
	assert.deepEqual([ noRate.rx, noRate.tx ], [ null, null ]);
	/* no link at all: the rates alone, as before #155 */
	const none = built({});
	assert.deepEqual([ none.rx.mhz, none.rx.detail, none.tx.mhz, none.rx.rate ], [ null, '', null, 72200 ]);
});
