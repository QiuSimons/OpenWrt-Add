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
	assert.equal(phone.name, 'Private device 53:02');
	assert.equal(phone.plainName, 'Private device', 'for where the MAC is shown beside it');
	assert.equal(printer.plainName, printer.name);
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
