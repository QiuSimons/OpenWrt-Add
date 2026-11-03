'use strict';
/* Firewall at a glance (vantage/fwglance.js): what a firewall config lets
   in from the internet, read the way fw4 reads it, and how the overview
   (view/vantage/firewall.js) words it. Each regression names the review
   finding it reproduces. Configs use documentation addresses only; the
   addresses that must be public or private are built from numbers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

const fw = load('vantage.fwglance');

/* [ [ type, { options } ], ... ] -> uci get values */
function cfg(list) {
	const out = {};
	list.forEach(([ type, opts ], i) => { out['cfg' + i] = Object.assign({ '.type': type, '.name': 'cfg' + i, '.index': i }, opts); });
	return out;
}

const ip = (...o) => o.join('.');
const PUBLIC = ip(5, 6, 7, 8);

/* a network.interface dump entry: up, with the IPv4 default route when
   `uplink`, and the given address */
function iface(name, address, extra) {
	return Object.assign({ interface: name, up: true, device: 'eth-' + name, l3_device: 'eth-' + name,
		route: extra && extra.uplink ? [ { target: '0.0.0.0', mask: 0 } ] : [],
		'ipv4-address': [ { address, mask: 24 } ] }, extra || {});
}

/* OpenWrt's stock firewall: lan, wan, and its default wan rules */
const STOCK = [
	[ 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', syn_flood: '1' } ],
	[ 'zone', { name: 'lan', network: [ 'lan' ], input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' } ],
	[ 'zone', { name: 'wan', network: [ 'wan', 'wan6' ], input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1', mtu_fix: '1' } ],
	[ 'forwarding', { src: 'lan', dest: 'wan' } ],
	[ 'rule', { name: 'Allow-DHCP-Renew', src: 'wan', proto: 'udp', dest_port: '68', target: 'ACCEPT', family: 'ipv4' } ],
	[ 'rule', { name: 'Allow-Ping', src: 'wan', proto: 'icmp', icmp_type: 'echo-request', family: 'ipv4', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-IGMP', src: 'wan', proto: 'igmp', family: 'ipv4', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-DHCPv6', src: 'wan', proto: 'udp', dest_port: '546', family: 'ipv6', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-MLD', src: 'wan', proto: 'icmp', src_ip: 'fe80::/10', icmp_type: [ '130/0', '131/0', '132/0', '143/0' ], family: 'ipv6', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-ICMPv6-Input', src: 'wan', proto: 'icmp', icmp_type: [ 'echo-request', 'echo-reply' ], limit: '1000/sec', family: 'ipv6', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-ICMPv6-Forward', src: 'wan', dest: '*', proto: 'icmp', icmp_type: [ 'echo-request' ], family: 'ipv6', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-IPSec-ESP', src: 'wan', dest: 'lan', proto: 'esp', target: 'ACCEPT' } ],
	[ 'rule', { name: 'Allow-ISAKMP', src: 'wan', dest: 'lan', dest_port: '500', proto: 'udp', target: 'ACCEPT' } ]
];

/* Codex's base: wan and lan with explicit policies, nothing open */
const BASE = [
	[ 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } ],
	[ 'zone', { name: 'wan', network: 'wan', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } ],
	[ 'zone', { name: 'lan', network: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' } ]
];
const withDefaults = (list, opts) => list.map(([ t, o ]) => [ t, t === 'defaults' ? Object.assign({}, o, opts) : o ]);
const codes = r => r.warnings.map(w => w.code + ':' + (w.name || w.iface || (w.zone ? w.zone + '>' + (w.dest || '') : '') || w.dest || w.option || ''));

test('fwglance: a stock router opens nothing; its default rules are standard housekeeping', () => {
	const r = fw.analyse(cfg(STOCK));
	assert.equal(r.routed, true);
	assert.deepEqual(r.internet, [ 'wan' ]);
	assert.deepEqual(r.open, []);
	assert.deepEqual(r.forwards, []);
	assert.equal(r.standard.length, 9, 'every default wan rule, IPsec passed on to lan included');
	assert.deepEqual(r.warnings, []);
	assert.equal(r.level, 'ok');
	const lan = r.zones.find(z => z.name === 'lan'), wan = r.zones.find(z => z.name === 'wan');
	assert.deepEqual(lan.to, [ 'wan' ]);
	assert.equal(wan.internet, true);
	assert.equal(lan.internet, false);
	assert.deepEqual(wan.networks, [ 'wan', 'wan6' ]);
	assert.deepEqual(r.outside, []);
	assert.deepEqual(r.defaults, { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' });
});

test('fwglance: open ports, forwards into the network and port forwards are listed', () => {
	const conf = cfg(STOCK.concat([
		[ 'rule', { name: 'SSH from office', src: 'wan', src_ip: '203.0.113.10', proto: 'tcp', dest_port: '22', target: 'ACCEPT' } ],
		[ 'rule', { name: 'Game', src: 'wan', proto: 'tcp udp', dest_port: '27015-27030', target: 'ACCEPT' } ],
		[ 'rule', { name: 'NAS from wan', src: 'wan', dest: 'lan', dest_port: '5001', proto: 'tcp', target: 'ACCEPT' } ],
		[ 'rule', { name: 'Blocked', src: 'wan', dest_port: '8080', target: 'REJECT' } ],
		[ 'rule', { name: 'No target does nothing', src: 'wan', dest_port: '9000' } ],
		[ 'redirect', { name: 'Web server', src: 'wan', src_dport: '443', dest: 'lan', dest_ip: '192.0.2.20', dest_port: '443', proto: 'tcp' } ],
		[ 'redirect', { name: 'Hairpin SNAT', src: 'lan', dest: 'wan', target: 'SNAT' } ]
	]));
	const r = fw.analyse(conf, [ iface('lan', '192.0.2.1') ]);
	assert.deepEqual(r.open.map(i => i.name), [ 'SSH from office', 'Game' ]);
	assert.deepEqual(r.open[0].from, { anywhere: false, only: [ '203.0.113.10' ], except: [] });
	assert.equal(r.open[0].family, 4, 'an IPv4 source makes the rule IPv4 only');
	assert.equal(r.open[1].portText, '27015-27030');
	assert.equal(r.open[1].family, null, 'both families');
	assert.deepEqual(r.forwards.map(i => i.name), [ 'NAS from wan', 'Web server' ]);
	const web = r.forwards[1];
	assert.equal(web.kind, 'redirect');
	assert.equal(web.host, '192.0.2.20');
	assert.equal(web.portText, '443');
	assert.equal(web.hostPort, '443');
	assert.equal(web.local, false);
	assert.equal(r.level, 'info', 'open but nothing risky: SSH is limited to one address');
	assert.deepEqual(r.warnings, []);
	/* without the dump the router's own addresses are unknown: so is
	   whether 192.0.2.20 is one of them, and 443 there could be its admin */
	const blind = fw.analyse(conf);
	assert.equal(blind.forwards[1].local, null);
	assert.deepEqual(codes(blind), [ 'admin-unsure:Web server' ]);
});

test('fwglance: the risky cases warn', () => {
	const risky = STOCK.map(([ t, o ]) => [ t, o.name === 'wan' && t === 'zone' ? Object.assign({}, o, { input: 'ACCEPT' }) : o ]).concat([
		[ 'forwarding', { src: 'wan', dest: 'lan' } ],
		[ 'rule', { name: 'Web admin', src: 'wan', proto: 'tcp', dest_port: '80 443', target: 'ACCEPT' } ],
		[ 'rule', { name: 'Anything from anywhere', src: '*', proto: 'all', target: 'ACCEPT' } ]
	]);
	const r = fw.analyse(cfg(risky));
	assert.deepEqual(codes(r).sort(),
		[ 'admin-open:Anything from anywhere', 'admin-open:Web admin', 'forward-into:wan>lan', 'input-accept:wan>' ]);
	assert.equal(r.warnings.find(w => w.code === 'forward-into').level, 'err');
	assert.equal(r.warnings.find(w => w.code === 'admin-open').level, 'warn');
	assert.deepEqual(r.warnings.map(w => w.level), [ 'err', 'err', 'warn', 'warn' ], 'errors first');
	assert.equal(r.level, 'err');
});

test('fwglance: what is switched off is listed and lets nothing in', () => {
	const r = fw.analyse(cfg(STOCK.concat([
		[ 'rule', { name: 'SSH (off)', src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT', enabled: '0' } ],
		[ 'redirect', { name: 'Camera (off)', src: 'wan', src_dport: '8554', dest: 'lan', dest_ip: '198.51.100.40', enabled: '0' } ],
		[ 'forwarding', { src: 'wan', dest: 'lan', enabled: '0' } ]
	])));
	assert.deepEqual(r.off.map(i => i.kind + ':' + (i.name || i.src + '>' + i.dest)), [ 'forwarding:wan>lan', 'rule:SSH (off)', 'redirect:Camera (off)' ]);
	assert.deepEqual(r.open, []);
	assert.deepEqual(r.forwards, []);
	assert.deepEqual(r.warnings, []);
	assert.deepEqual(r.zones.find(z => z.name === 'wan').to, [], 'an off forwarding forwards nothing');
});

test('fwglance: an access point without an internet-facing zone is unknown, not green', () => {
	const r = fw.analyse(cfg([
		[ 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } ],
		[ 'zone', { name: 'lan', network: 'lan', input: 'REJECT', output: 'ACCEPT' } ],
		[ 'rule', { name: 'Admin SSH', src: 'lan', proto: 'tcp', dest_port: '22', target: 'ACCEPT' } ],
		[ 'rule', { name: 'From any zone', src: '*', proto: 'tcp', dest_port: '22', target: 'ACCEPT' } ]
	]), [ iface('lan', ip(192, 168, 1, 2), { uplink: true }) ]);
	assert.equal(r.routed, false);
	assert.deepEqual(r.open, [], 'from lan is not from the internet');
	assert.deepEqual(r.warnings, [], 'without an internet side, src * says nothing either');
	assert.equal(r.level, 'unknown');
	assert.equal(r.zones[0].forward, 'REJECT', 'unset policies fall back to the defaults section');
	assert.deepEqual(r.zones[0].networks, [ 'lan' ]);
});

test('fwglance: junk in the config is ignored, never thrown on', () => {
	const r = fw.analyse({ a: null, b: 'x', c: { '.type': 'zone' }, d: { '.type': 'rule', src: 'wan', dest_port: 'abc', target: 'ACCEPT' } });
	assert.deepEqual(r.zones, []);
	assert.equal(r.routed, false);
	assert.doesNotThrow(() => fw.analyse(null));
	assert.deepEqual(fw.analyse(undefined).zones, []);
	assert.doesNotThrow(() => fw.analyse(cfg(STOCK), [ null, 'x', { interface: 'wan' }, { interface: 'lan', route: 'x', 'ipv4-address': [ null ] } ]));
});

test('fwglance: wan faces the internet without NAT too (public addresses, routed)', () => {
	const noNat = [
		[ 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } ],
		[ 'zone', { name: 'lan', network: 'lan', input: 'ACCEPT', forward: 'ACCEPT' } ],
		[ 'zone', { name: 'wan', network: [ 'wan' ], input: 'ACCEPT' } ],
		[ 'zone', { name: 'upstream', network: [ 'wan6' ], input: 'REJECT' } ],
		[ 'zone', { name: 'dmz', network: 'dmz', input: 'REJECT' } ]
	];
	const r = fw.analyse(cfg(noNat));
	assert.equal(r.routed, true);
	assert.deepEqual(r.internet, [ 'wan', 'upstream' ], 'by name, and by holding the wan6 network');
	assert.deepEqual(codes(r), [ 'input-accept:wan>' ]);
	assert.equal(r.zones.find(z => z.name === 'dmz').internet, false);
});

test('fwglance: an uplink is an interface with the default route and a public address', () => {
	const dump = [
		iface('isp', PUBLIC, { uplink: true }),
		iface('lan', ip(192, 168, 1, 1)),
		iface('down', PUBLIC, { uplink: true, up: false }),
		iface('cgnat', ip(100, 72, 0, 9), { uplink: true })
	];
	assert.deepEqual(fw.uplinks(dump), [ 'isp' ], 'up, default route, public address');
	/* an access point: its default route runs to the main router over a private address */
	assert.deepEqual(fw.uplinks([ iface('lan', ip(192, 168, 1, 2), { uplink: true }) ]), []);
	assert.deepEqual(fw.uplinks(null), []);
});

/* B19: the IANA IPv4 special-purpose registry, table-driven. Each entry
   whose "Globally Reachable" is False (and multicast) is not public,
   checked at its first and last address; the reachable entries, the
   neighbours of each block and ordinary unicast space are. The most
   specific entry decides. */
const REGISTRY = [
	/* [ first address octets, prefix, globally reachable ] */
	[ [ 0, 0, 0, 0 ], 8, false ],
	[ [ 0, 0, 0, 0 ], 32, false ],
	[ [ 10, 0, 0, 0 ], 8, false ],
	[ [ 100, 64, 0, 0 ], 10, false ],
	[ [ 127, 0, 0, 0 ], 8, false ],
	[ [ 169, 254, 0, 0 ], 16, false ],
	[ [ 172, 16, 0, 0 ], 12, false ],
	[ [ 192, 0, 0, 0 ], 24, false ],
	[ [ 192, 0, 0, 0 ], 29, false ],
	[ [ 192, 0, 0, 8 ], 32, false ],
	[ [ 192, 0, 0, 9 ], 32, true ],
	[ [ 192, 0, 0, 10 ], 32, true ],
	[ [ 192, 0, 0, 170 ], 32, false ],
	[ [ 192, 0, 0, 171 ], 32, false ],
	[ [ 192, 0, 2, 0 ], 24, false ],
	[ [ 192, 31, 196, 0 ], 24, true ],
	[ [ 192, 52, 193, 0 ], 24, true ],
	[ [ 192, 88, 99, 2 ], 32, false ],
	[ [ 192, 168, 0, 0 ], 16, false ],
	[ [ 192, 175, 48, 0 ], 24, true ],
	[ [ 198, 18, 0, 0 ], 15, false ],
	[ [ 198, 51, 100, 0 ], 24, false ],
	[ [ 203, 0, 113, 0 ], 24, false ],
	[ [ 224, 0, 0, 0 ], 4, false ],
	[ [ 240, 0, 0, 0 ], 4, false ],
	[ [ 255, 255, 255, 255 ], 32, false ]
];
const toNum = o => ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
const toIp = n => ip(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

test('fwglance: public addresses follow the IANA special-purpose registry (B19)', () => {
	/* the most specific entry for an address, null for ordinary space */
	const entry = n => REGISTRY.filter(([ o, len ]) => {
		const mask = len ? (0xffffffff << (32 - len)) >>> 0 : 0;
		return ((n & mask) >>> 0) === ((toNum(o) & mask) >>> 0);
	}).sort((a, b) => b[1] - a[1])[0] || null;
	for (const [ o, len, global ] of REGISTRY) {
		const first = toNum(o), last = (first + 2 ** (32 - len) - 1) >>> 0;
		for (const n of [ first, last ]) {
			const e = entry(n);
			assert.equal(fw.public4(toIp(n)), e[2], `${toIp(n)} (${o.join('.')}/${len})`);
		}
		for (const n of [ first - 1, last + 1 ]) {
			if (n < 0 || n > 0xffffffff) continue;
			const e = entry(n >>> 0);
			assert.equal(fw.public4(toIp(n >>> 0)), e ? e[2] : true, `neighbour ${toIp(n >>> 0)} of ${o.join('.')}/${len}`);
		}
	}
	assert.equal(fw.public4(ip(192, 88, 99, 2)), false, 'the 6a44 relay is not globally reachable');
	assert.equal(fw.public4(ip(192, 88, 99, 1)), true, 'the deprecated 6to4 /24 around it has no reachability entry');
	for (const a of [ PUBLIC, ip(1, 1, 1, 1), ip(223, 255, 255, 254) ]) assert.equal(fw.public4(a), true, a);
	for (const a of [ '300.1.1.1', '1..2.3', '1.2.3', 'x', '', null, ip(1, 2, 3, 4) + '.5' ]) assert.equal(fw.public4(a), false, String(a));
	/* and uplinks() uses it */
	assert.deepEqual(fw.uplinks([ iface('relay', ip(192, 88, 99, 2), { uplink: true }) ]), []);
});

test('fwglance: a zone holding the uplink faces the internet, whatever its name and without NAT', () => {
	const conf = cfg([
		[ 'defaults', { input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } ],
		[ 'zone', { name: 'lan', network: 'lan', input: 'ACCEPT' } ],
		[ 'zone', { name: 'outside', network: 'isp', input: 'ACCEPT' } ]
	]);
	assert.equal(fw.analyse(conf).routed, false, 'no masquerading, no wan name, no dump: unknown');
	const r = fw.analyse(conf, [ iface('isp', PUBLIC, { uplink: true }) ]);
	assert.deepEqual(r.internet, [ 'outside' ]);
	assert.deepEqual(codes(r), [ 'input-accept:outside>' ]);
	assert.equal(fw.analyse(conf, [ iface('lan', PUBLIC) ]).routed, false, 'lan has no default route');
	/* fw4 also matches a zone by device, and takes the zone an interface names itself */
	const byDev = cfg([ [ 'zone', { name: 'up', device: 'eth-isp', input: 'REJECT' } ] ]);
	assert.deepEqual(fw.analyse(byDev, [ iface('isp', PUBLIC, { uplink: true }) ]).internet, [ 'up' ]);
	const byWild = cfg([ [ 'zone', { name: 'up', device: 'eth-+', input: 'REJECT' } ] ]);
	assert.deepEqual(fw.analyse(byWild, [ iface('isp', PUBLIC, { uplink: true }) ]).internet, [ 'up' ]);
	const byData = cfg([ [ 'zone', { name: 'up', input: 'REJECT' } ] ]);
	assert.deepEqual(fw.analyse(byData, [ iface('isp', PUBLIC, { uplink: true, data: { zone: 'up' } }) ]).internet, [ 'up' ]);
});

/* ------------------------------------------------ A1: forwarding paths */

test('A1: a forwarding from * reaches lan from the internet: an error, not "nothing open" (CS M1, CX M1)', () => {
	const r = fw.analyse(cfg(BASE.concat([ [ 'forwarding', { src: '*', dest: 'lan' } ] ])));
	assert.deepEqual(codes(r), [ 'forward-into:*>lan' ]);
	assert.equal(r.level, 'err');
	assert.deepEqual(r.zones.find(z => z.name === 'wan').to, [ 'lan' ], 'wan forwards to lan through it');
	assert.deepEqual(r.anyTo, [ 'lan' ]);
	/* the path is the same for a routed IPv6 lan: an IPv6-only internet zone */
	const v6 = fw.analyse(cfg([
		[ 'defaults', { input: 'REJECT', forward: 'REJECT' } ],
		[ 'zone', { name: 'wan6', network: 'wan6', family: 'ipv6', input: 'REJECT', forward: 'REJECT' } ],
		[ 'zone', { name: 'lan', network: 'lan', input: 'ACCEPT', forward: 'ACCEPT' } ],
		[ 'forwarding', { src: '*', dest: 'lan' } ]
	]));
	assert.ok(codes(v6).includes('forward-into:*>lan'));
	/* into another internet-facing zone is not into your network */
	assert.deepEqual(codes(fw.analyse(cfg(STOCK.concat([ [ 'forwarding', { src: '*', dest: 'wan' } ] ])))), []);
	/* from * to * accepts everything */
	assert.deepEqual(codes(fw.analyse(cfg(BASE.concat([ [ 'forwarding', { src: '*', dest: '*' } ] ])))), [ 'forward-into:*>*' ]);
});

test('A1: defaults.forward ACCEPT lets the internet into every other zone (CS M1, CX M1)', () => {
	const r = fw.analyse(cfg(withDefaults(BASE, { forward: 'ACCEPT' })));
	assert.deepEqual(codes(r), [ 'default-forward:' ]);
	assert.equal(r.level, 'err');
	assert.equal(r.defaults.forward, 'ACCEPT');
	/* the zone's own forward policy only covers wan to wan: still REJECT */
	assert.equal(r.zones.find(z => z.name === 'wan').forward, 'REJECT');
	/* a stock router with only that changed */
	assert.deepEqual(codes(fw.analyse(cfg(withDefaults(STOCK, { forward: 'accept' })))), [ 'default-forward:' ]);
});

test('A1: an uplink in no zone meets the default policies (CS M1)', () => {
	const conf = withDefaults(STOCK, { input: 'ACCEPT', forward: 'ACCEPT' });
	const dump = [ iface('wan', PUBLIC, { uplink: true }), iface('wwan', ip(5, 6, 7, 9), { uplink: true }) ];
	const r = fw.analyse(cfg(conf), dump);
	assert.deepEqual(r.outside, [ { name: 'wwan', family: null, zone: false } ]);
	assert.deepEqual(codes(r).sort(), [ 'default-forward:', 'outside-input:wwan' ]);
	/* closed defaults: listed, nothing open */
	const closed = fw.analyse(cfg(STOCK), dump);
	assert.deepEqual(closed.outside.map(o => o.name), [ 'wwan' ]);
	assert.deepEqual(closed.warnings, []);
	assert.equal(closed.level, 'ok');
	/* an uplink alone makes a router, even without a zone for it */
	const bare = fw.analyse(cfg([ [ 'defaults', { input: 'ACCEPT' } ], [ 'zone', { name: 'lan', network: 'lan' } ] ]), [ iface('isp', PUBLIC, { uplink: true }) ]);
	assert.equal(bare.routed, true);
	assert.deepEqual(codes(bare), [ 'outside-input:isp' ]);
});

test('A1: without the interface dump, an accepting default input is a caution', () => {
	const conf = cfg(withDefaults(STOCK, { input: 'ACCEPT' }));
	const r = fw.analyse(conf, null);
	assert.deepEqual(codes(r), [ 'uplinks-unknown:' ]);
	assert.equal(r.level, 'warn');
	assert.deepEqual(codes(fw.analyse(conf, [ iface('wan', PUBLIC, { uplink: true }) ])), [], 'all uplinks zoned');
	assert.deepEqual(codes(fw.analyse(cfg(STOCK), null)), [], 'closed defaults need no dump');
});

test('A1: a zone restricted to one family leaves the other to the default policies', () => {
	const conf = withDefaults(STOCK, { input: 'ACCEPT' }).map(([ t, o ]) => [ t, t === 'zone' && o.name === 'wan' ? Object.assign({}, o, { family: 'ipv4' }) : o ]);
	const r = fw.analyse(cfg(conf), [ iface('wan', PUBLIC, { uplink: true }) ]);
	assert.deepEqual(r.outside, [ { name: 'wan', family: 6, zone: true } ]);
	assert.deepEqual(codes(r), [ 'outside-input:wan' ]);
	assert.equal(r.warnings[0].family, 6);
	/* another zone taking IPv6 on the same networks closes it */
	const both = fw.analyse(cfg(conf.concat([ [ 'zone', { name: 'wan6z', network: [ 'wan', 'wan6' ], family: 'ipv6', input: 'REJECT' } ] ])), [ iface('wan', PUBLIC, { uplink: true }) ]);
	assert.deepEqual(both.outside, []);
});

test('B18: policies fall back to the defaults section, then to DROP; fw4 reads them by prefix', () => {
	const r = fw.analyse(cfg([ [ 'zone', { name: 'wan', network: 'wan' } ] ]));
	assert.deepEqual([ r.zones[0].input, r.zones[0].output, r.zones[0].forward ], [ 'DROP', 'DROP', 'DROP' ]);
	assert.deepEqual(r.defaults, { input: 'DROP', output: 'DROP', forward: 'DROP' });
	const p = fw.analyse(cfg([ [ 'defaults', { input: 'rej' } ], [ 'zone', { name: 'wan', network: 'wan', input: 'acc', forward: 'Dr' } ] ]));
	assert.deepEqual([ p.zones[0].input, p.zones[0].forward, p.defaults.input ], [ 'ACCEPT', 'DROP', 'REJECT' ]);
	assert.deepEqual(codes(p), [ 'input-accept:wan>' ]);
	/* an empty value matches the first choice: accept */
	assert.equal(fw.analyse(cfg([ [ 'zone', { name: 'wan', network: 'wan', input: '' } ] ])).zones[0].input, 'ACCEPT');
	/* a value fw4 refuses in the defaults stops it before it loads any rules */
	const bad = fw.analyse(cfg(withDefaults(STOCK, { input: 'deny' })));
	assert.deepEqual(codes(bad), [ 'defaults-invalid:input' ]);
	assert.equal(bad.level, 'warn');
});

/* --------------------------------------- A5: protocols, ports, sources */

const wanRule = opts => fw.analyse(cfg(BASE.concat([ [ 'rule', Object.assign({ name: 'R', src: 'wan', target: 'ACCEPT' }, opts) ] ])));

test('A5: protocol spellings fw4 accepts include TCP, and the admin check sees them (CX M2, CS S3)', () => {
	for (const proto of [ '6', 'tcpudp', 'TCP', '!tcp', [ 'udp', 'tcp' ], 'tcp icmp' ]) {
		const r = wanRule({ proto, dest_port: '22' });
		assert.deepEqual(codes(r), [ 'admin-open:R' ], JSON.stringify(proto));
	}
	assert.deepEqual(wanRule({ dest_port: '22' }).open[0].proto, [ 'tcp', 'udp' ], 'unset is tcp and udp');
	assert.deepEqual(wanRule({ proto: 'tcpudp', dest_port: '22' }).open[0].proto, [ 'tcp', 'udp' ]);
	assert.deepEqual(wanRule({ proto: '17', dest_port: '22' }).warnings, [], 'UDP 22 is no SSH');
	assert.deepEqual(wanRule({ proto: '1' }).standard.map(i => i.proto), [ [ 'icmp' ] ], 'protocol 1 is ICMP: housekeeping');
	assert.deepEqual(wanRule({ proto: '58' }).standard.map(i => i.proto), [ [ 'ipv6-icmp' ] ]);
	assert.equal(wanRule({ proto: '58' }).standard[0].family, 6);
});

test('A5: with protocol all fw4 ignores the ports: every port is open (CX M2)', () => {
	const r = wanRule({ proto: 'all', dest_port: '8080' });
	assert.deepEqual(codes(r), [ 'admin-open:R' ]);
	assert.equal(r.open[0].portText, '', 'no port is shown as a restriction');
	assert.deepEqual(r.open[0].proto, [ 'all' ]);
	/* ports only apply to the tcp and udp parts of a list */
	const mixed = wanRule({ proto: 'gre tcp', dest_port: '8080' });
	assert.deepEqual(mixed.warnings, []);
	assert.equal(mixed.open[0].portText, '8080');
});

test('A5: all-address and negated sources are not restrictions; genuine allowlists are (CX M2, CS N3)', () => {
	for (const src_ip of [ '0.0.0.0/0', '::/0', '0.0.0.0/0.0.0.0', '!203.0.113.8', [ '0.0.0.0/0', '2001:db8::/32' ], [ '203.0.113.0/24', '!2001:db8::1' ] ]) {
		const r = wanRule({ proto: 'tcp', dest_port: '22', src_ip });
		assert.deepEqual(codes(r), [ 'admin-open:R' ], JSON.stringify(src_ip));
		assert.equal(r.open[0].from.anywhere, true, JSON.stringify(src_ip));
	}
	assert.deepEqual(wanRule({ proto: 'tcp', dest_port: '22', src_ip: '!203.0.113.8' }).open[0].from, { anywhere: true, only: [], except: [ '203.0.113.8' ] });
	for (const src_ip of [ '203.0.113.10', '2001:db8::/48', [ '203.0.113.0/24', '2001:db8::/48' ], [ '203.0.113.0/24', '!203.0.113.9' ], '198.51.100.1-198.51.100.9' ]) {
		const r = wanRule({ proto: 'tcp', dest_port: '22', src_ip });
		assert.deepEqual(r.warnings, [], JSON.stringify(src_ip));
		assert.equal(r.open[0].from.anywhere, false, JSON.stringify(src_ip));
	}
	/* a MAC on internet traffic is the upstream router's: no restriction */
	assert.deepEqual(codes(wanRule({ proto: 'tcp', dest_port: '22', src_mac: '00:00:5E:00:53:01' })), [ 'admin-open:R' ]);
	/* a network name stands for its addresses (from the dump) */
	const named = BASE.concat([ [ 'rule', { name: 'R', src: 'wan', target: 'ACCEPT', proto: 'tcp', dest_port: '22', src_ip: 'office' } ] ]);
	assert.deepEqual(fw.analyse(cfg(named), [ iface('office', '203.0.113.1') ]).warnings, []);
	assert.equal(fw.analyse(cfg(named), [ iface('lan', '192.0.2.1') ]).ignored[0].bad, 'src_ip', 'an unknown network: fw4 skips the rule');
});

test('A5: port lists with exclusions and ranges are read as fw4 matches them', () => {
	assert.deepEqual(codes(wanRule({ proto: 'tcp', dest_port: '!22' })), [ 'admin-open:R' ], 'everything but 22 still has 80 and 443');
	assert.deepEqual(wanRule({ proto: 'tcp', dest_port: '!22 !23 !80 !443' }).warnings, []);
	assert.deepEqual(codes(wanRule({ proto: 'tcp', dest_port: '1:1024' })), [ 'admin-open:R' ]);
	assert.deepEqual(wanRule({ proto: 'tcp', dest_port: '1-1024 !1-1024' }).warnings, []);
	const r = wanRule({ proto: 'tcp', dest_port: '1000-2000 !1500' });
	assert.equal(r.open[0].portText, '1000-2000');
	assert.equal(r.open[0].portsExcept, '1500');
	/* a port fw4 refuses skips the rule */
	assert.equal(wanRule({ proto: 'tcp', dest_port: '443-22' }).ignored[0].bad, 'dest_port');
	assert.equal(wanRule({ proto: 'tcp', dest_port: '70000' }).ignored[0].bad, 'dest_port');
});

test('B20: the address family is part of the description', () => {
	assert.equal(wanRule({ proto: 'tcp', dest_port: '22', family: 'ipv4' }).open[0].family, 4);
	assert.equal(wanRule({ proto: 'tcp', dest_port: '22', family: 'ipv6' }).open[0].family, 6);
	assert.equal(wanRule({ proto: 'tcp', dest_port: '22' }).open[0].family, null);
	assert.equal(wanRule({ proto: 'tcp', dest_port: '22', src_ip: '2001:db8::/48' }).open[0].family, 6, 'from the source');
	/* inherited from the zone */
	const z = fw.analyse(cfg([
		[ 'zone', { name: 'wan', network: 'wan', family: 'ipv6', input: 'REJECT' } ],
		[ 'rule', { name: 'R', src: 'wan', proto: 'tcp', dest_port: '8443', target: 'ACCEPT' } ],
		[ 'rule', { name: 'Clash', src: 'wan', proto: 'tcp', dest_port: '8444', family: 'ipv4', target: 'ACCEPT' } ]
	]));
	assert.equal(z.open[0].family, 6);
	assert.deepEqual(z.ignored.map(i => i.name + ':' + i.bad), [ 'Clash:family' ], 'fw4 skips a family the zone does not have');
});

/* ------------------------------------------------------- A6: redirects */

const wanRedirect = (opts, dump) => fw.analyse(cfg(BASE.concat([ [ 'redirect', Object.assign({ name: 'P', src: 'wan', proto: 'tcp' }, opts) ] ])), dump);

test('A6: any redirect target but SNAT is a DNAT (CX M3, CS N2)', () => {
	for (const target of [ 'ACCEPT', 'dnat', 'DNAT', 'drop', 'masquerade', 'acc' ]) {
		const r = wanRedirect({ src_dport: '443', dest_ip: '192.0.2.10', dest_port: '443', target }, [ iface('lan', '192.0.2.1') ]);
		assert.deepEqual(r.forwards.map(i => i.name), [ 'P' ], target);
		assert.equal(r.level, 'info', target);
	}
	assert.deepEqual(wanRedirect({ src_dport: '443', dest_ip: '192.0.2.10', target: 'snat' }).forwards, []);
	assert.equal(wanRedirect({ src_dport: '443', dest_ip: '192.0.2.10', target: 'bogus' }).ignored[0].bad, 'target');
});

test('A6: a redirect without dest_ip goes to the router itself; its admin port warns (CX M3, CS S2)', () => {
	const r = wanRedirect({ name: 'Router SSH', src_dport: '2222', dest_port: '22' });
	assert.deepEqual(r.forwards, []);
	assert.deepEqual(r.open.map(i => [ i.name, i.local, i.portText, i.hostPort ]), [ [ 'Router SSH', true, '2222', '22' ] ]);
	assert.deepEqual(codes(r), [ 'admin-open:Router SSH' ]);
	assert.equal(r.warnings[0].kind, 'redirect');
	/* the translated port decides */
	assert.deepEqual(wanRedirect({ src_dport: '22', dest_port: '2222' }).warnings, []);
	assert.deepEqual(codes(wanRedirect({ src_dport: '443' })), [ 'admin-open:P' ], 'no dest_port: the same port');
	assert.deepEqual(codes(wanRedirect({ dest_port: '22' })), [ 'admin-open:P' ], 'every port sent to 22');
	assert.deepEqual(wanRedirect({ dest_port: '8080' }).warnings, [], 'every port sent to 8080 only');
	assert.deepEqual(codes(wanRedirect({ proto: 'all', dest_port: '8080' })), [ 'admin-open:P' ], 'all protocols ignore the ports');
	assert.deepEqual(wanRedirect({ src_dport: '2222', dest_port: '22', src_ip: '203.0.113.7' }).warnings, [], 'limited to one address');
	/* a DNAT to one of the router's own addresses is local too */
	const own = wanRedirect({ src_dport: '2222', dest_ip: '192.0.2.1', dest_port: '22' }, [ iface('lan', '192.0.2.1') ]);
	assert.equal(own.open[0].local, true);
	assert.deepEqual(codes(own), [ 'admin-open:P' ]);
});

test('A6: fw4 skips a DNAT from * or without a source zone', () => {
	const any = wanRedirect({ src: '*', src_dport: '80', dest_ip: '192.0.2.10' });
	assert.deepEqual(any.forwards, []);
	assert.deepEqual(any.ignored.map(i => i.bad), [ 'src-any' ]);
	assert.equal(any.level, 'ok');
	const none = fw.analyse(cfg(BASE.concat([ [ 'redirect', { name: 'P', src_dport: '80', dest_ip: '192.0.2.10' } ] ])));
	assert.deepEqual(none.ignored.map(i => i.bad), [ 'src' ]);
	assert.equal(wanRedirect({ src_dport: '80', dest_ip: '!192.0.2.10' }).ignored[0].bad, 'dest_ip');
	assert.equal(wanRedirect({ src_dport: '80 443', dest_ip: '192.0.2.10' }).ignored[0].bad, 'src_dport', 'a redirect takes one port or range');
});

test('A6/B20: a redirect without family or address is IPv4, as fw4 keeps it', () => {
	assert.equal(wanRedirect({ src_dport: '443', dest_ip: '192.0.2.10' }).forwards[0].family, 4);
	assert.equal(wanRedirect({ src_dport: '443' }).open[0].family, 4);
	assert.equal(wanRedirect({ src_dport: '443', family: 'any' }).open[0].family, null);
	assert.equal(wanRedirect({ src_dport: '443', dest_ip: '2001:db8::10' }).forwards[0].family, 6);
});

/* -------------------------------------------------- A7: booleans, zones */

test('A7: one boolean parser, as fw4\'s: 0/off/false/no and 1/on/true/yes (CX M4, CS S5)', () => {
	for (const v of [ '0', 'off', 'false', 'no' ]) {
		const r = wanRule({ proto: 'tcp', dest_port: '22', enabled: v });
		assert.deepEqual([ r.open.length, r.off.length, r.warnings.length ], [ 0, 1, 0 ], v);
	}
	for (const v of [ '1', 'on', 'true', 'yes' ]) {
		assert.deepEqual(codes(wanRule({ proto: 'tcp', dest_port: '22', enabled: v })), [ 'admin-open:R' ], v);
		const z = fw.analyse(cfg([ [ 'zone', { name: 'outside', network: 'isp', input: 'ACCEPT', masq: v } ] ]));
		assert.deepEqual(z.internet, [ 'outside' ], 'masq ' + v);
		assert.deepEqual(codes(z), [ 'input-accept:outside>' ]);
	}
	assert.deepEqual(fw.analyse(cfg([ [ 'zone', { name: 'outside', network: 'isp', masq6: '1' } ] ])).internet, [ 'outside' ], 'masq6 alone');
	assert.deepEqual(fw.analyse(cfg([ [ 'zone', { name: 'outside', network: 'isp', masq: '0' } ] ])).internet, []);
	/* fw4 refuses anything else and skips the section */
	const yes = wanRule({ proto: 'tcp', dest_port: '22', enabled: 'Yes' });
	assert.deepEqual(yes.ignored.map(i => i.bad), [ 'enabled' ]);
	assert.deepEqual(yes.open, []);
});

test('A7: a switched-off wan zone leaves the default policies in charge (CX M4)', () => {
	const r = fw.analyse(cfg([
		[ 'defaults', { input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' } ],
		[ 'zone', { name: 'wan', network: 'wan', input: 'REJECT', enabled: '0' } ],
		[ 'rule', { name: 'SSH', src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT' } ]
	]));
	assert.deepEqual(r.zones, []);
	assert.deepEqual(r.off.map(i => i.kind + ':' + i.name), [ 'zone:wan' ]);
	assert.deepEqual(r.outside.map(o => o.name), [ 'wan' ]);
	assert.deepEqual(codes(r), [ 'outside-input:wan' ]);
	assert.equal(r.level, 'err');
	assert.deepEqual(r.ignored.map(i => i.name + ':' + i.bad), [ 'SSH:src' ], 'a rule naming a zone that is off is skipped');
	/* a zone fw4 skips for a bad value behaves the same */
	const bad = fw.analyse(cfg([
		[ 'defaults', { input: 'ACCEPT' } ],
		[ 'zone', { name: 'wan', network: 'wan', input: 'REJECT', masq: 'Yes' } ]
	]));
	assert.deepEqual(bad.ignored.map(i => i.kind + ':' + i.bad), [ 'zone:masq' ]);
	assert.deepEqual(codes(bad), [ 'outside-input:wan' ]);
	/* with the dump, only a network that is up counts */
	assert.deepEqual(fw.analyse(cfg([ [ 'defaults', { input: 'ACCEPT' } ], [ 'zone', { name: 'wan', network: 'wan', enabled: '0' } ], [ 'zone', { name: 'lan', network: 'lan', masq: '1' } ] ]),
		[ iface('lan', '192.0.2.1') ]).outside, []);
});

/* ------------------------------------------------------------- B1, B4 */

test('B1: IKE and ESP to the router are an opening; passed on to a host they are housekeeping (CS S1)', () => {
	for (const opts of [ { proto: 'udp', dest_port: '500 4500' }, { proto: 'esp' }, { proto: 'ah' }, { proto: 'udp', dest_port: '4500' } ]) {
		const r = wanRule(opts);
		assert.deepEqual(r.open.map(i => i.name), [ 'R' ], JSON.stringify(opts));
		assert.deepEqual(r.standard, []);
		assert.equal(r.level, 'info');
	}
	for (const opts of [ { proto: 'udp', dest_port: '500 4500', dest: 'lan' }, { proto: 'esp', dest: 'lan' }, { proto: 'esp', dest: '*' } ])
		assert.deepEqual(wanRule(opts).standard.map(i => i.name), [ 'R' ], JSON.stringify(opts));
	assert.deepEqual(wanRule({ proto: 'udp', dest_port: '68' }).standard.map(i => i.name), [ 'R' ], 'DHCP renewals stay housekeeping');
	assert.deepEqual(wanRule({ proto: 'udp', dest_port: '68 69' }).standard, [], 'one other port is an opening');
});

test('B4: an unrestricted accept rule from the internet into a zone warns like a forwarding (CS S4)', () => {
	for (const opts of [ { proto: 'all' }, {}, { proto: 'tcp' }, { proto: 'tcp', dest_port: '!22' }, { proto: 'all', src_ip: '0.0.0.0/0' } ]) {
		const r = wanRule(Object.assign({ dest: 'lan' }, opts));
		assert.deepEqual(codes(r), [ 'rule-into:R' ], JSON.stringify(opts));
		assert.equal(r.warnings[0].level, 'err');
		assert.equal(r.warnings[0].dest, 'lan');
	}
	assert.deepEqual(codes(wanRule({ dest: '*', proto: 'all' })), [ 'rule-into:R' ]);
	for (const opts of [ { proto: 'tcp', dest_port: '5001' }, { proto: 'all', src_ip: '203.0.113.10' }, { proto: 'all', dest_ip: '192.0.2.10' }, { proto: 'gre' } ])
		assert.deepEqual(wanRule(Object.assign({ dest: 'lan' }, opts)).warnings, [], JSON.stringify(opts));
});

/* ------------------------------------------------------------ B21 */

test('B21: includes are configured, and fw4 ignores a script without fw4_compatible (CX N4)', () => {
	const r = fw.analyse(cfg(STOCK.concat([
		[ 'include', { path: '/etc/firewall.user', type: 'script' } ],
		[ 'include', { path: '/etc/firewall.user', type: 'script', fw4_compatible: '1' } ],
		[ 'include', { path: '/usr/share/miniupnpd/firewall.include', type: 'script' } ],
		[ 'include', { path: '/etc/extra.nft', type: 'nftables', position: 'chain-append', chain: 'input_wan' } ],
		[ 'include', { path: '/etc/old.nft', enabled: '0' } ],
		[ 'include', { path: '/etc/odd.sh', type: 'script', fw4_compatible: '0' } ],
		[ 'include', { path: '/etc/bad.sh', position: 'table-append' } ]
	])));
	assert.deepEqual(r.includes.map(i => i.path), [ '/etc/firewall.user', '/usr/share/miniupnpd/firewall.include', '/etc/extra.nft' ]);
	assert.deepEqual(r.ignored.map(i => i.path + ':' + i.bad), [ '/etc/firewall.user:fw4_compatible', '/etc/odd.sh:fw4_compatible', '/etc/bad.sh:position' ]);
	assert.equal(r.level, 'ok', 'a file is a note, not a warning: what it opens is unknown');
	assert.deepEqual(fw.analyse(cfg(STOCK)).includes, []);
});

/* ---------------------------------------- 1.0.7 final check (Codex) */

const acceptIn = list => withDefaults(list, { input: 'ACCEPT' });
const zoneOpts = (list, name, opts) => list.map(([ t, o ]) => [ t, t === 'zone' && o.name === name ? Object.assign({}, o, opts) : o ]);
const LAN_DEV = Object.assign(iface('lan', '192.0.2.1'), { device: 'br-lan', l3_device: 'br-lan' });
const WAN_DEV = Object.assign(iface('wan', '198.51.100.2'), { device: 'eth1', l3_device: 'eth1' });
const MASQ = zoneOpts(BASE, 'wan', { masq: '1' });

test('S4: networks on one device are one to fw4: an alias of the wan device is in the wan zone (CX S4)', () => {
	/* a modem: wan holds the device, dynamic wan_4 the address and route */
	const modem = [ LAN_DEV, Object.assign(iface('wan', null), { device: 'wwan0', l3_device: 'wwan0' }),
		Object.assign(iface('wan_4', PUBLIC, { uplink: true }), { device: '@wan', l3_device: 'wwan0' }) ];
	for (const list of [ acceptIn(MASQ), MASQ ]) {
		const r = fw.analyse(cfg(list), modem);
		assert.deepEqual(r.outside, [], 'wan_4 arrives on wwan0, which the wan zone takes');
		assert.deepEqual(r.warnings, []);
		assert.equal(r.level, 'ok');
	}
	/* fw4 takes l3_device when set, else device; one without a device matches nothing */
	assert.deepEqual(fw.analyse(cfg(acceptIn(MASQ)), [ Object.assign(iface('wan', null), { device: 'wwan0', l3_device: null }),
		Object.assign(iface('wan_4', PUBLIC, { uplink: true }), { device: 'wwan0', l3_device: undefined }) ]).outside, []);
	/* a network the dump puts in a zone (data.zone) brings its device along */
	const byData = fw.analyse(cfg(acceptIn([ [ 'defaults', {} ], [ 'zone', { name: 'wan', input: 'REJECT', masq: '1' } ] ])),
		[ Object.assign(iface('wan', null), { device: 'wwan0', l3_device: 'wwan0', data: { zone: 'wan' } }),
			Object.assign(iface('wan_4', PUBLIC, { uplink: true }), { l3_device: 'wwan0' }) ]);
	assert.deepEqual(byData.outside, []);
	/* without the dump networks still compare by name */
	assert.deepEqual(fw.analyse(cfg(acceptIn(MASQ))).outside, []);
});

test('S4: zones split by family on one device take both families (CX S4)', () => {
	const split = [
		[ 'defaults', { input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' } ],
		[ 'zone', { name: 'lan', network: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' } ],
		[ 'zone', { name: 'wan', network: 'wan', family: 'ipv4', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT', masq: '1' } ],
		[ 'zone', { name: 'wan6', network: 'wan6', family: 'ipv6', input: 'REJECT', output: 'ACCEPT', forward: 'REJECT' } ]
	];
	const wan6 = Object.assign(iface('wan6', null), { device: 'eth1', l3_device: 'eth1', 'ipv6-address': [ { address: '2001:db8::2', mask: 64 } ] });
	const dump = [ LAN_DEV, Object.assign({}, WAN_DEV, { route: [ { target: '0.0.0.0', mask: 0 } ], 'ipv4-address': [ { address: PUBLIC, mask: 24 } ] }), wan6 ];
	const r = fw.analyse(cfg(split), dump);
	assert.deepEqual(r.outside, [], 'no complementary-family row: the other zone takes it on eth1');
	assert.deepEqual(r.warnings, []);
	assert.equal(r.level, 'ok');
	/* on separate devices each family the other zone does not take is outside */
	const apart = fw.analyse(cfg(split), [ LAN_DEV, dump[1], Object.assign({}, wan6, { device: 'eth2', l3_device: 'eth2' }) ]);
	assert.deepEqual(apart.outside, [ { name: 'wan', family: 6, zone: true }, { name: 'wan6', family: 4, zone: true } ]);
	assert.deepEqual(codes(apart), [ 'outside-input:wan', 'outside-input:wan6' ]);
	/* the other family must cover everything the zone takes, not just one network */
	const half = fw.analyse(cfg(acceptIn([ [ 'zone', { name: 'wan', network: [ 'wan', 'wan6' ], family: 'ipv4', input: 'REJECT' } ],
		[ 'zone', { name: 'v6', network: 'wan6', family: 'ipv6', input: 'REJECT' } ] ])));
	assert.deepEqual(half.outside, [ { name: 'wan', family: 6, zone: true } ]);
});

test('S4: device wildcards and exclusions still decide (CX S4)', () => {
	const wan = Object.assign(iface('wan', null), { device: 'wwan0', l3_device: 'wwan0' });
	const wan4 = Object.assign(iface('wan_4', PUBLIC, { uplink: true }), { device: '@wan', l3_device: 'wwan0' });
	const zone = opts => fw.analyse(cfg([ [ 'defaults', { input: 'ACCEPT', forward: 'REJECT' } ], [ 'zone', Object.assign({ name: 'wan', input: 'REJECT' }, opts) ] ]), [ LAN_DEV, wan, wan4 ]);
	assert.deepEqual(zone({ device: 'wwan+' }).outside, [], 'a wildcard takes wwan0');
	/* excluding wan_4 excludes its device: fw4 writes iifname "wwan*" iifname != "wwan0" */
	assert.deepEqual(codes(zone({ device: 'wwan+', network: '!wan_4' })), [ 'outside-input:wan_4' ]);
	assert.deepEqual(codes(zone({ device: 'eth+' })), [ 'outside-input:wan_4' ], 'a wildcard for other devices');
	assert.deepEqual(zone({ network: '!lan' }).outside, [], 'an exclusion alone takes every other device');
	assert.deepEqual(codes(zone({ device: 'ww+an' })), [ 'outside-input:wan_4' ], 'fw4 skips a wildcard not at the end');
});

const withSet = (set, rule) => fw.analyse(cfg(BASE.concat(set ? [ [ 'ipset', Object.assign({ name: 'mine', family: 'ipv4', entry: [ '203.0.113.5' ] }, set) ] ] : [],
	[ [ 'rule', Object.assign({ name: 'SSH', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'mine', target: 'ACCEPT' }, rule) ] ])));

const noVerdict = (r, why) => {
	assert.deepEqual(r.warnings, [], why);
	assert.equal(r.level, 'unknown', why);
};

test('S5: a set limits who connects only when it matches the source address (CX S5)', () => {
	/* fw4: tcp dport 22 ip daddr @mine accept: anyone may connect */
	const dst = withSet({ match: 'dest_ip' });
	assert.deepEqual(dst.open[0].from, { anywhere: true, only: [], except: [] });
	assert.deepEqual(codes(dst), [ 'admin-open:SSH' ]);
	for (const [ set, rule, why ] of [
		[ { match: 'dst_net' }, {}, 'a destination net set' ],
		[ { match: 'src_ip' }, { ipset: 'mine dst' }, 'a source set matched on the destination' ],
		[ { match: 'src_ip' }, { ipset: '!mine' }, 'a negated set' ],
		[ { match: 'src_mac' }, {}, 'a MAC set: the upstream router\'s' ],
		[ { match: 'dest_port' }, {}, 'a port set' ]
	]) {
		const r = withSet(set, rule);
		assert.equal(r.open[0].from.anywhere, true, why);
		assert.deepEqual(codes(r), [ 'admin-open:SSH' ], why);
		assert.deepEqual(r.complex, [], why);
	}
	for (const [ set, rule, why ] of [
		[ { match: 'src_ip' }, {}, 'a source address set' ],
		[ { match: 'ip' }, {}, 'unprefixed is the source' ],
		[ { match: 'dest_ip' }, { ipset: 'mine src' }, 'a destination set matched on the source' ],
		[ { match: [ 'src_net', 'dest_port' ] }, {}, 'a source and port set' ]
	]) {
		const r = withSet(set, rule);
		assert.deepEqual(r.open[0].from, { anywhere: false, only: [ '@mine' ], except: [] }, why);
		assert.deepEqual(r.warnings, [], why);
		assert.deepEqual(r.complex, [], why);
	}
	/* the set's family is the rule's, as fw4 infers it */
	assert.equal(withSet({ match: 'src_ip', family: 'ipv6', entry: [ '2001:db8::5' ] }).open[0].family, 6);
});

test('G2: a set this config does not define and enable may come from a service: no verdict, nothing unconfirmed about it (CX D3, F2, G2)', () => {
	for (const [ set, why ] of [
		[ null, 'a set this config does not define' ],
		[ { match: 'src_ip', enabled: '0' }, 'a set that is switched off' ],
		[ { match: 'src_ip', family: 'any' }, 'an address set fw4 refuses' ],
		[ { match: 'src_ip', maxelem: 'lots' }, 'a set with a value fw4 refuses' ],
		[ {}, 'a set without match types' ]
	]) {
		const r = withSet(set);
		assert.deepEqual(r.complex, [ { why: 'set', name: 'SSH', other: null } ], why);
		noVerdict(r, why);
		assert.deepEqual(r.unconfirmed, [], why + ': what it opens is unknown');
	}
});

const ROUTER = [ Object.assign({}, LAN_DEV, { 'ipv6-address': [ { address: '2001:db8::1', mask: 64 } ],
	'ipv6-prefix-assignment': [ { address: '2001:db8:1::', mask: 48, 'local-address': { address: '2001:db8:1::1', mask: 64 } } ] }), WAN_DEV ];

test('S6: a redirect to the router\'s own address counts as local however it is spelled (CX S6)', () => {
	for (const [ dest_ip, family ] of [ [ '192.0.2.1/32' ], [ '192.0.2.1/255.255.255.255' ], [ '192.0.2.1' ], [ '192.0.2.0-192.0.2.9' ],
		[ '2001:DB8:0:0::1', 'ipv6' ], [ '2001:db8::1/128', 'ipv6' ], [ '2001:db8:0:0:0:0:0:1', 'ipv6' ], [ '2001:db8:1::1', 'ipv6' ] ]) {
		const r = wanRedirect({ name: 'Router', src_dport: '2222', dest_ip, dest_port: '22', family }, ROUTER);
		assert.deepEqual(r.open.map(i => [ i.name, i.local ]), [ [ 'Router', true ] ], dest_ip);
		assert.deepEqual(r.forwards, [], dest_ip);
		assert.deepEqual(codes(r), [ 'admin-open:Router' ], dest_ip);
	}
	/* fw4 DNATs to the address masked to its prefix: 192.0.2.0, a host */
	for (const dest_ip of [ '192.0.2.1/24', '192.0.2.10', '2001:db8::10' ]) {
		const r = wanRedirect({ name: 'Host', src_dport: '2222', dest_ip, dest_port: '22' }, ROUTER);
		assert.deepEqual(r.forwards.map(i => [ i.name, i.local ]), [ [ 'Host', false ] ], dest_ip);
		assert.deepEqual(r.warnings, [], dest_ip);
	}
	/* a network name stands for its subnet: fw4 DNATs to its base */
	assert.equal(wanRedirect({ src_dport: '2222', dest_ip: 'lan', dest_port: '22' }, ROUTER).forwards[0].local, false);
	/* fw4 refuses a mask that is not contiguous in dest_ip */
	assert.deepEqual(wanRedirect({ src_dport: '2222', dest_ip: '192.0.2.1/255.0.255.255' }, ROUTER).ignored.map(i => i.bad), [ 'dest_ip' ]);
});

test('S6: without the dump a redirect\'s target stays unknown, and an admin port says so (CX S6)', () => {
	for (const dest_ip of [ '192.0.2.1/32', '192.0.2.1', 'lan' ]) {
		const r = wanRedirect({ name: 'Maybe', src_dport: '2222', dest_ip, dest_port: '22' });
		assert.deepEqual(r.forwards.map(i => [ i.name, i.local ]), [ [ 'Maybe', null ] ], dest_ip);
		assert.deepEqual(r.open, [], dest_ip);
		assert.deepEqual(codes(r), [ 'admin-unsure:Maybe' ], dest_ip);
		assert.equal(r.warnings[0].host, dest_ip);
		assert.equal(r.level, 'warn');
	}
	assert.deepEqual(wanRedirect({ src_dport: '8080', dest_ip: '192.0.2.1', dest_port: '8080' }).warnings, [], 'no admin port: listed only');
	assert.equal(wanRedirect({ src_dport: '2222', dest_port: '22' }).open[0].local, true, 'without dest_ip it is the router');
});

test('N1: a zone option fw4 refuses skips the zone; its networks meet the accepting default (CX N1)', () => {
	const dump = [ LAN_DEV, WAN_DEV ];
	for (const [ opts, bad ] of [
		[ { log: 'yes' }, 'log' ], [ { subnet: 'nonsense' }, 'subnet' ], [ { subnet: '192.0.2.0/24 nosuch' }, 'subnet' ],
		[ { masq_src: 'nosuchnet' }, 'masq_src' ], [ { masq_dest: '!192.0.002.1' }, 'masq_dest' ], [ { log_limit: '10/fortnight' }, 'log_limit' ],
		[ { extra: [ 'a', 'b' ] }, 'extra' ], [ { custom_chains: 'Yes' }, 'custom_chains' ], [ { helper: 'bogus' }, 'helper' ],
		[ { counter: 'maybe' }, 'counter' ], [ { mtu_fix: '2' }, 'mtu_fix' ], [ { masq_allow_invalid: 'y' }, 'masq_allow_invalid' ],
		[ { auto_helper: 'nope' }, 'auto_helper' ], [ { log: [ '1', '2' ] }, 'log' ]
	]) {
		const r = fw.analyse(cfg(acceptIn(zoneOpts(MASQ, 'wan', opts))), dump);
		assert.deepEqual(r.ignored.map(i => i.kind + ':' + i.bad), [ 'zone:' + bad ], JSON.stringify(opts));
		assert.deepEqual(codes(r), [ 'outside-input:wan' ], JSON.stringify(opts));
		assert.equal(r.level, 'err', JSON.stringify(opts));
	}
	for (const opts of [ { log: '1' }, { log: '0x10' }, { log_limit: '10/min' }, { helper: [ 'ftp', '!sip' ] }, { counter: 'off' },
		{ masq_src: [ '192.0.2.0/24', '!192.0.2.9' ] }, { masq_dest: 'lan' }, { extra: '-m comment' }, { mtu_fix: 'yes' } ]) {
		const r = fw.analyse(cfg(acceptIn(zoneOpts(MASQ, 'wan', opts))), dump);
		assert.deepEqual(r.ignored, [], JSON.stringify(opts));
		assert.equal(r.level, 'ok', JSON.stringify(opts));
	}
	/* the defaults section's numbers, limits and reject codes too */
	for (const opts of [ { synflood_burst: 'x' }, { synflood_rate: 'fast' }, { tcp_reject_code: 'icmp' }, { tcp_ecn: 'on' } ])
		assert.deepEqual(codes(fw.analyse(cfg(withDefaults(STOCK, opts)))).map(c => c.split(':')[0]), [ 'defaults-invalid' ], JSON.stringify(opts));
	assert.deepEqual(fw.analyse(cfg(withDefaults(STOCK, { synflood_rate: '50/s', any_reject_code: 'admin' }))).warnings, []);
});

test('N1: an internet zone with covered subnets gets no verdict (CX N1, D1)', () => {
	const dump = [ LAN_DEV, WAN_DEV ];
	/* fw4: meta nfproto ipv4 iifname "eth1" ip saddr 203.0.113.0/24 jump input_wan; where the rest goes
	   depends on the other zones and the order: this page does not follow it */
	for (const subnet of [ '203.0.113.0/24', 'wan', '!203.0.113.0/24', [ '0.0.0.0/0' ], [ '0.0.0.0/0', '::/0' ] ]) {
		for (const list of [ acceptIn(zoneOpts(MASQ, 'wan', { subnet })), zoneOpts(MASQ, 'wan', { subnet }) ]) {
			const r = fw.analyse(cfg(list), dump);
			assert.deepEqual(r.complex, [ { why: 'subnet', name: 'wan', other: null } ], JSON.stringify(subnet));
			noVerdict(r, JSON.stringify(subnet));
		}
	}
	/* a network name cannot be checked without the dump: the zone stays,
	   and the accepting default with unknown interfaces is a caution */
	const blind = fw.analyse(cfg(acceptIn(zoneOpts(MASQ, 'wan', { masq_src: 'office' }))));
	assert.deepEqual(blind.ignored, []);
	assert.deepEqual(codes(blind), [ 'uplinks-unknown:' ]);
	assert.notEqual(blind.level, 'ok');
});

/* ------------------------------------- 1.0.7 delta checks (Codex) */

const WAN6_DEV = { interface: 'wan6', up: true, device: 'eth1', l3_device: 'eth1', 'ipv6-address': [ { address: '2001:db8:5::2', mask: 64 } ] };
const zones = (defaults, ...list) => [ [ 'defaults', Object.assign({ output: 'ACCEPT', forward: 'REJECT' }, defaults) ] ].concat(list.map(z => [ 'zone', z ]));
const LANZ = { name: 'lan', network: 'lan', input: 'ACCEPT', output: 'ACCEPT', forward: 'ACCEPT' };

test('D2: a redirect goes to the first dest_ip address of its family, as fw4 DNATs it (CX D2)', () => {
	for (const [ extra, why ] of [
		[ { 'ipv4-address': [ { address: '192.0.2.1', mask: 24 }, { address: '192.0.2.2', mask: 32 } ] }, 'a later own address' ],
		[ { 'ipv6-address': [ { address: '2001:db8::1', mask: 128 } ] }, 'an own address of the other family' ]
	]) {
		const r = wanRedirect({ name: 'P', src_dport: '2222', dest_ip: 'lan', dest_port: '22', family: 'ipv4' }, [ Object.assign({}, LAN_DEV, extra), WAN_DEV ]);
		assert.deepEqual(r.forwards.map(i => [ i.name, i.local ]), [ [ 'P', false ] ], why);
		assert.deepEqual(r.warnings, [], why);
	}
	const own = Object.assign({}, LAN_DEV, { 'ipv4-address': [ { address: '192.0.2.1', mask: 32 }, { address: '192.0.2.2', mask: 24 } ] });
	assert.deepEqual(codes(wanRedirect({ name: 'P', src_dport: '2222', dest_ip: 'lan', dest_port: '22' }, [ own, WAN_DEV ])), [ 'admin-open:P' ]);
	/* both families: local when either one's target is the router */
	const v6own = Object.assign({}, LAN_DEV, { 'ipv6-address': [ { address: '2001:db8::1', mask: 128 } ] });
	assert.equal(wanRedirect({ src_dport: '2222', dest_ip: 'lan', dest_port: '22' }, [ v6own, WAN_DEV ]).open[0].local, true);
});

test('no verdict where this does not follow fw4: shared internet devices, covered subnets, sets (CX G1, G2, G3, D1, F1–F3)', () => {
	const dump = [ LAN_DEV, WAN_DEV, WAN6_DEV ];
	const why = r => r.complex.map(c => c.why + ':' + c.name + (c.other ? '/' + c.other : ''));
	for (const [ name, list, d, expected ] of [
		/* G3: a rejecting zone first takes all of eth1; wan's accept never applies */
		[ 'shadowing guard', zones({ input: 'REJECT' }, LANZ, { name: 'guard', device: 'eth1', input: 'REJECT' }, { name: 'wan', network: 'wan', input: 'ACCEPT' }), dump, [ 'shared:wan/guard' ] ],
		/* F1: an accepting catch-all takes what wan's subnet leaves */
		[ 'accepting catch-all', zones({ input: 'ACCEPT' }, LANZ, { name: 'wan', network: 'wan', subnet: '203.0.113.0/24', input: 'REJECT' }, { name: 'rest', device: 'eth1', input: 'ACCEPT' }), dump,
			[ 'subnet:wan', 'shared:wan/rest' ] ],
		/* G1: without the dump a device may be wan's */
		[ 'no dump, device zone', zones({ input: 'REJECT' }, LANZ, { name: 'rest', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', network: 'wan', input: 'REJECT' }), null, [ 'shared:wan/rest' ] ],
		/* F3: a wildcard device may take wan's network */
		[ 'no dump, wildcard', zones({ input: 'ACCEPT' }, { name: 'wan', network: 'wan', input: 'REJECT' }, { name: 'rest', device: 'eth+', input: 'REJECT' }), null, [ 'shared:wan/rest' ] ],
		/* a zone with covered subnets and no device takes them on every device */
		[ 'subnet-only zone', zones({ input: 'REJECT' }, { name: 'sources', subnet: '203.0.113.0/24', input: 'ACCEPT' }, LANZ, { name: 'wan', network: 'wan', input: 'REJECT', masq: '1' }), dump,
			[ 'subnet:sources' ] ],
		/* a catch-all takes every device it does not exclude */
		[ 'catch-all by exclusion', zones({ input: 'REJECT' }, LANZ, { name: 'wan', network: 'wan', input: 'REJECT' }, { name: 'all', network: '!lan', input: 'ACCEPT' }), dump, [ 'shared:wan/all' ] ],
		/* delta4 F1: device names compare as patterns, both ways */
		[ 'no dump, wildcard wan', zones({ input: 'REJECT' }, { name: 'rest', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: 'eth+', input: 'REJECT' }), null, [ 'shared:wan/rest' ] ],
		/* a wan naming no device takes every one it does not exclude */
		[ 'no dump, any-device wan', zones({ input: 'REJECT' }, { name: 'rest', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: '+', input: 'REJECT' }), null, [ 'shared:wan/rest' ] ],
		[ 'no dump, wan by exclusion', zones({ input: 'REJECT' }, { name: 'rest', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: '!lo', input: 'REJECT' }), null, [ 'shared:wan/rest' ] ],
		/* delta5 F1: fw4 makes an excluded '+' a device that never matches, not an exclusion of all */
		[ 'excluded + beside a wildcard', zones({ input: 'REJECT' }, { name: 'lan', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: [ 'eth+', '!+' ], input: 'REJECT' }), null, [ 'shared:wan/lan' ] ],
		[ 'excluded + beside a device', zones({ input: 'REJECT' }, { name: 'lan', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: [ 'eth1', '!+' ], input: 'REJECT' }), dump, [ 'shared:wan/lan' ] ],
		[ 'excluded + on the other zone', zones({ input: 'REJECT' }, { name: 'lan', device: [ '!+', 'eth+' ], input: 'ACCEPT' }, { name: 'wan', device: '!eth0', input: 'REJECT' }), dump, [ 'shared:wan/lan' ] ],
		/* a device the dump does not list (a VPN's) still exists */
		[ 'unlisted VPN device', zones({ input: 'REJECT' }, LANZ, { name: 'wan', network: 'wan', input: 'REJECT', masq: '1' },
			{ name: 'rest', device: 'tun0', input: 'ACCEPT' }, { name: 'vpn', device: 'tun+', input: 'REJECT', masq: '1' }), dump, [ 'shared:vpn/rest' ] ],
		/* G2/F2: a set's definition may come from a service, a stale section notwithstanding */
		[ 'set, stale section', BASE.concat([ [ 'ipset', { name: 'mine', match: 'dest_ip', enabled: '0' } ],
			[ 'rule', { name: 'Probe', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'mine', target: 'ACCEPT' } ] ]), dump, [ 'set:Probe' ] ],
		[ 'set on a port forward', BASE.concat([ [ 'redirect', { name: 'P', src: 'wan', proto: 'tcp', src_dport: '2222', dest_port: '22', ipset: 'nosuch' } ] ]), dump, [ 'set:P' ] ],
		[ 'set on a rule fw4 refuses', BASE.concat([ [ 'rule', { name: 'Odd', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'x', target: 'ACCEPT', enabled: 'Yes' } ] ]), dump, [ 'set:Odd' ] ]
	]) {
		const r = fw.analyse(cfg(list), d);
		assert.deepEqual(why(r), expected, name);
		noVerdict(r, name);
	}
	/* what it would warn about stays visible, unconfirmed */
	const guard = fw.analyse(cfg(zones({ input: 'REJECT' }, LANZ, { name: 'guard', device: 'eth1', input: 'REJECT' }, { name: 'wan', network: 'wan', input: 'ACCEPT' })), dump);
	assert.deepEqual(codes({ warnings: guard.unconfirmed }), [ 'input-accept:wan>' ]);
	const stale = fw.analyse(cfg(BASE.concat([ [ 'ipset', { name: 'mine', match: 'dest_ip', enabled: '0' } ],
		[ 'rule', { name: 'Probe', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'mine', target: 'ACCEPT' } ],
		[ 'rule', { name: 'Web', src: 'wan', proto: 'tcp', dest_port: '443', target: 'ACCEPT' } ] ])), dump);
	assert.deepEqual(codes({ warnings: stale.unconfirmed }), [ 'admin-open:Web' ], 'not the rule whose set is unknown');
	/* by section, not by name: another rule of the same name, or another unnamed one, stays */
	for (const name of [ 'Probe', undefined ]) {
		const twin = fw.analyse(cfg(BASE.concat([ [ 'rule', { name, src: 'wan', proto: 'tcp', dest_port: '443', ipset: 'nosuch', target: 'ACCEPT' } ],
			[ 'rule', { name, src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT' } ] ])), dump);
		assert.deepEqual(twin.unconfirmed.map(w => w.code + ':' + w.ports), [ 'admin-open:22' ], String(name));
	}
	assert.deepEqual(fw.analyse(cfg(STOCK), dump).unconfirmed, []);
});

test('ordinary setups keep their verdict', () => {
	const dump = [ LAN_DEV, WAN_DEV, WAN6_DEV ];
	const plain = (list, d, why) => { const r = fw.analyse(cfg(list), d); assert.deepEqual(r.complex, [], why); return r; };
	assert.equal(plain(STOCK, dump, 'stock').level, 'ok');
	assert.equal(plain(STOCK, null, 'stock, no dump').level, 'ok');
	/* one zone per family on the wan device */
	plain(zones({ input: 'ACCEPT' }, LANZ, { name: 'wan', network: 'wan', family: 'ipv4', input: 'REJECT', masq: '1' },
		{ name: 'wan6', network: 'wan6', family: 'ipv6', input: 'REJECT' }), dump, 'split families');
	/* a second uplink and a VLAN on their own devices; a VPN zone by device */
	const multi = [ LAN_DEV, WAN_DEV, Object.assign(iface('wanb', '203.0.113.2'), { device: 'eth2', l3_device: 'eth2' }),
		Object.assign(iface('iot', '198.51.100.1'), { device: 'br-lan.20', l3_device: 'br-lan.20' }) ];
	assert.equal(plain(zones({ input: 'REJECT' }, LANZ, { name: 'wan', network: [ 'wan', 'wanb' ], input: 'REJECT', masq: '1' },
		{ name: 'iot', network: 'iot', input: 'REJECT' }, { name: 'vpn', device: 'wg0', input: 'REJECT' }), multi, 'multi-WAN, VLAN, VPN').level, 'ok');
	/* covered subnets on a zone of its own device: not the internet's business */
	plain(zones({ input: 'REJECT' }, Object.assign({ subnet: '192.0.2.0/25' }, LANZ), { name: 'wan', network: 'wan', input: 'REJECT', masq: '1' }), dump, 'lan subnet');
	/* a set this config defines, on an internet rule */
	assert.equal(plain(BASE.concat([ [ 'ipset', { name: 'mine', match: 'src_ip', family: 'ipv4', entry: [ '203.0.113.5' ] } ],
		[ 'rule', { name: 'SSH', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'mine', target: 'ACCEPT' } ] ]), dump, 'defined set').level, 'info');
	/* a set on a rule from inside */
	plain(BASE.concat([ [ 'rule', { name: 'L', src: 'lan', proto: 'tcp', dest_port: '22', ipset: 'x', target: 'ACCEPT' } ] ]), dump, 'lan set');
	/* delta4b F1: an internet zone's exclusions keep it apart from the zone they leave out */
	const byDev = zones({ input: 'REJECT' }, { name: 'lan', device: 'eth0', input: 'ACCEPT' }, { name: 'wan', device: [ 'eth+', '!eth0' ], input: 'REJECT', masq: '1' });
	plain(byDev, dump, 'wan excludes lan');
	plain(byDev, null, 'wan excludes lan, no dump');
	plain(zones({ input: 'REJECT' }, { name: 'lan', device: 'eth0', input: 'ACCEPT' }, { name: 'wan', device: [ 'eth+', '!eth0+' ], input: 'REJECT', masq: '1' }), null, 'excluded prefix');
	plain(zones({ input: 'REJECT' }, { name: 'lan', device: 'eth0', input: 'ACCEPT' }, { name: 'wan', device: [ 'eth0', 'eth1', '!eth0' ], input: 'REJECT', masq: '1' }), null, 'listed and excluded');
	const vpn = fw.analyse(cfg(zones({ input: 'REJECT' }, LANZ, { name: 'wan', network: 'wan', input: 'REJECT', masq: '1' },
		{ name: 'mgmt', device: 'tun0', input: 'ACCEPT' }, { name: 'vpn', device: [ 'tun+', '!tun0' ], input: 'REJECT', masq: '1' })), dump);
	assert.deepEqual(vpn.complex, [], 'vpn excludes another tunnel');
	assert.equal(vpn.level, 'ok');
	/* an excluded '+' alone, or with '+', takes no device */
	plain(zones({ input: 'REJECT' }, { name: 'lan', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: '!+', input: 'REJECT', masq: '1' }), null, 'wan takes nothing');
	plain(zones({ input: 'REJECT' }, { name: 'lan', device: 'eth1', input: 'ACCEPT' }, { name: 'wan', device: [ '+', '!+' ], input: 'REJECT', masq: '1' }), dump, 'wan + and !+');
	/* what the exclusion leaves can still be shared */
	assert.deepEqual(fw.analyse(cfg(zones({ input: 'REJECT' }, { name: 'rest', device: 'eth+', input: 'ACCEPT' },
		{ name: 'wan', device: [ 'eth+', '!eth0' ], input: 'REJECT', masq: '1' })), dump).complex, [ { why: 'shared', name: 'wan', other: 'rest' } ]);
	/* an access point stays unknown for its own reason */
	const ap = plain([ [ 'zone', { name: 'lan', network: 'lan' } ] ], [ LAN_DEV ], 'access point');
	assert.equal(ap.routed, false);
});

/* ------------------------------------------------------- the overview */

/* view/vantage/firewall.js with stub LuCI modules; E() builds plain
   objects and text() reads them back. `replies` stand in for whole rpc
   calls: 'object method' -> () => Promise of what the call resolves to
   (the ubus reply data, as a declaration without `expect` returns it).
   With `rpc` the view gets that module instead (LuCI's own rpc.js). */
function loadView(replies, rpc) {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/firewall.js'), 'utf8');
	global.E = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: children == null ? [] : [].concat(children) });
	global.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
	global.fetch = () => Promise.reject(new Error('no fetch'));
	global.L = luciL();
	const stubs = {
		view: { extend: p => p },
		rpc: rpc ? rpc() : { declare: o => () => replies[o.object + ' ' + o.method]() },
		ui: { menu: { load: () => Promise.resolve({ children: {} }) } },
		'vantage.fwglance': fw
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(stubs[m[1]]);
	}
	return new Function(...params, src)(...values);
}

/* the parts of LuCI's L the view and rpc.js use */
function luciL() {
	return {
		env: {},
		url: (...p) => '/' + p.join('/'),
		resource: p => '/' + p,
		resolveDefault: (p, d) => Promise.resolve(p).catch(() => d),
		isObject: v => v != null && typeof v === 'object' && !Array.isArray(v),
		bind: (fn, self, ...args) => fn.bind(self, ...args),
		raise: (type, fmt, ...args) => { const e = new Error(fmt.format(...args)); e.name = type; throw e; }
	};
}

function text(n) {
	if (n == null || n === '') return '';
	if (typeof n === 'string') return n;
	const t = (n.children || []).map(text).join(n.tag && /^(div|p|header|section|h[1-4]|a)$/.test(n.tag) ? '\n' : '');
	return /vt-fg-row-name|vt-chip-title/.test(n.attrs && n.attrs.class) ? t + '\n' : t;
}

async function pageNode(values, dump) {
	const v = loadView({ 'uci get': () => Promise.resolve({ values }),
		'network.interface dump': () => dump == null ? Promise.reject(new Error('no dump')) : Promise.resolve({ interface: dump }) });
	return v.render(await v.load());
}
async function page(values, dump) { return text(await pageNode(values, dump)); }

test('overview: Codex\'s reproductions no longer read "Nothing is open"', async () => {
	const cases = {
		wildcardForwarding: BASE.concat([ [ 'forwarding', { src: '*', dest: 'lan' } ] ]),
		globalAcceptForward: withDefaults(BASE, { forward: 'ACCEPT' }),
		allWithIgnoredPort: BASE.concat([ [ 'rule', { name: 'All', src: 'wan', proto: 'all', dest_port: '8080', target: 'ACCEPT' } ] ]),
		routerRedirect: BASE.concat([ [ 'redirect', { name: 'Router SSH', src: 'wan', proto: 'tcp', src_dport: '2222', dest_port: '22' } ] ]),
		fallbackRedirectTarget: BASE.concat([ [ 'redirect', { name: 'Coerced', src: 'wan', proto: 'tcp', src_dport: '443', dest_ip: '192.0.2.10', dest_port: '443', target: 'ACCEPT' } ] ]),
		disabledWanWithDefaultAccept: [ [ 'defaults', { input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' } ], [ 'zone', { name: 'wan', network: 'wan', input: 'REJECT', enabled: '0' } ] ],
		ipsecToRouter: BASE.concat([ [ 'rule', { name: 'IKE', src: 'wan', proto: 'udp', dest_port: '500 4500', target: 'ACCEPT' } ] ])
	};
	for (const [ name, list ] of Object.entries(cases)) {
		const t = await page(cfg(list));
		assert.doesNotMatch(t, /Nothing is open/, name);
	}
	const fwdText = await page(cfg(cases.wildcardForwarding));
	assert.match(fwdText, /Any zone is forwarded into lan/);
	const defText = await page(cfg(cases.globalAcceptForward));
	assert.match(defText, /Forwarding is accepted by default/);
	assert.match(defText, /any zone \(default policy\)/);
	assert.doesNotMatch(defText, /forwards nowhere/);
	const all = await page(cfg(cases.allWithIgnoredPort));
	assert.match(all, /all protocols · from anywhere/);
	assert.doesNotMatch(all, /8080/);
	const ssh = await page(cfg(cases.routerRedirect));
	assert.match(ssh, /On this router\nRouter SSH\nIPv4 TCP 2222 · from anywhere\nrouter port 22/);
	assert.match(ssh, /Router admin open: Router SSH/);
	assert.match(await page(cfg(cases.fallbackRedirectTarget)), /192\.0\.2\.10:443/);
	assert.match(await page(cfg(cases.disabledWanWithDefaultAccept)), /wan is in no zone and accepts every connection/);
});

test('overview: descriptions carry the family, exceptions and configured includes (B20, B21)', async () => {
	const t = await page(cfg(BASE.concat([
		[ 'rule', { name: 'V4', src: 'wan', proto: 'tcp', dest_port: '8443', family: 'ipv4', target: 'ACCEPT' } ],
		[ 'rule', { name: 'V6', src: 'wan', proto: 'tcp', dest_port: '8443', family: 'ipv6', target: 'ACCEPT' } ],
		[ 'rule', { name: 'Except', src: 'wan', proto: 'tcp', dest_port: '22', src_ip: '!203.0.113.8', target: 'ACCEPT' } ],
		[ 'include', { path: '/etc/firewall.user', type: 'script' } ],
		[ 'include', { path: '/etc/extra.nft', type: 'nftables' } ]
	])));
	assert.match(t, /V4\nIPv4 TCP 8443/);
	assert.match(t, /V6\nIPv6 TCP 8443/);
	assert.match(t, /from anywhere except 203\.0\.113\.8/);
	assert.match(t, /Custom rule files are configured \(\/etc\/extra\.nft\)/);
	assert.match(t, /\/etc\/firewall\.user\ncustom rule file · ignored: not marked as compatible with firewall4/);
	assert.match(t, /Not in effect/);
});

test('B6: a failed read of the firewall config is an error, not the access point text (CS S6)', async () => {
	const v = loadView({ 'uci get': () => Promise.reject(new Error('Access denied')), 'network.interface dump': () => Promise.resolve({ interface: [] }) });
	const fwr = await v.load();
	assert.deepEqual(fwr, { error: true });
	const node = v.render(fwr);
	const t = text(node);
	assert.match(t, /Could not read the firewall configuration/);
	assert.doesNotMatch(t, /access point|Nothing is open/);
	assert.match(JSON.stringify(node), /vt-orb-err/);
	/* a failed interface dump is not an error: the page still reads the config */
	const v2 = loadView({ 'uci get': () => Promise.resolve({ values: cfg(STOCK) }), 'network.interface dump': () => Promise.reject(new Error('x')) });
	const r2 = await v2.load();
	assert.equal(r2.level, 'ok');
	assert.equal(r2.interfaces, false);
	/* an access point reads as unknown, with a neutral orb */
	const ap = loadView({ 'uci get': () => Promise.resolve({ values: cfg([ [ 'zone', { name: 'lan', network: 'lan' } ] ]) }), 'network.interface dump': () => Promise.resolve({ interface: [] }) });
	const apNode = ap.render(await ap.load());
	assert.match(text(apNode), /No internet-facing zone found/);
	assert.match(JSON.stringify(apNode), /vt-orb-unknown/);
});

/* ------------------------------------------- against fw4 itself (optional)

   The same regressions through the fw4 that ships (fw4.uc and its
   templates from the rootfs dump: $VANTAGE_ROOTFS or ../vantage-rootfs),
   under a host ucode binary ($UCODE, else `ucode` on PATH), with uci and
   ubus replaced by small doubles; skipped without either. Each case
   checks the ruleset fw4 writes for the opening (or its absence) the
   model reports. nft is never run: the copy calls /bin/false instead. */
const { spawnSync } = require('child_process');
const mkTmp = require('./tmpdir');

function findUcode() {
	for (const c of [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')))) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const ROOTFS = path.resolve(process.env.VANTAGE_ROOTFS || path.join(__dirname, '../../vantage-rootfs'));
const FW4 = path.join(ROOTFS, 'usr/share/ucode/fw4.uc');
const NO_FW4 = !UCODE ? 'no ucode binary (set UCODE=/path/to/ucode)' : !fs.existsSync(FW4) ? 'no fw4.uc in the rootfs dump (set VANTAGE_ROOTFS)' : false;

const UCI_DOUBLE = `let fs = require('fs');
let conf = json(fs.readfile(getenv('FW_CONF')));
return { cursor: () => ({
	load: () => true,
	foreach: function(c, t, cb) { for (let s in (conf[c] || [])) if (s['.type'] == t && cb(s) === false) break; return true; },
	get_all: function(c, sid) { for (let s in (conf[c] || [])) if (s['.name'] == sid) return s; return null; },
	get: function(c, sid, o) { for (let s in (conf[c] || [])) if (s['.name'] == sid) return o ? s[o] : s['.type']; return null; }
}) };
`;
const UBUS_DOUBLE = `let fs = require('fs');
let conf = json(fs.readfile(getenv('FW_CONF')));
return { connect: () => ({
	call: (o, m) => (o == 'network.interface' && m == 'dump') ? { interface: conf.dump || [] } : (o == 'service' ? {} : null),
	disconnect: () => null
}), error: () => 'double' };
`;

/* the ruleset fw4 writes for a config, or its error output */
function fw4Ruleset(values, dump) {
	const dir = mkTmp('vantage-fwglance-');
	const lib = path.join(dir, 'lib');
	fs.mkdirSync(lib);
	fs.writeFileSync(path.join(lib, 'fw4.uc'), fs.readFileSync(FW4, 'utf8')
		.replace(/"\/usr\/sbin\/nft"/g, '"/bin/false"').replace(/\/usr\/sbin\/nft -c/g, '/bin/false')
		.replace(/"\/var\/run\/fw4\.state"/, JSON.stringify(path.join(dir, 'fw4.state'))));
	fs.writeFileSync(path.join(lib, 'uci.uc'), UCI_DOUBLE);
	fs.writeFileSync(path.join(lib, 'ubus.uc'), UBUS_DOUBLE);
	const tpl = path.join(ROOTFS, 'usr/share/firewall4/templates/ruleset.uc');
	fs.writeFileSync(path.join(dir, 'render.uc'), `{% let fw4 = require("fw4"); fw4.load(false); include(${JSON.stringify(tpl)}, { fw4, type, exists, length, include }); %}`);
	const conf = { firewall: Object.keys(values).map(k => values[k]), dump: dump || [] };
	fs.writeFileSync(path.join(dir, 'conf.json'), JSON.stringify(conf));
	const args = [ '-T', '-L', lib ];
	const sys = path.join(path.dirname(UCODE), '../lib/ucode');
	if (fs.existsSync(sys)) args.push('-L', sys);
	const r = spawnSync(UCODE, args.concat(path.join(dir, 'render.uc')), { encoding: 'utf8', cwd: dir, env: Object.assign({}, process.env, { FW_CONF: path.join(dir, 'conf.json') }) });
	return r.stdout + r.stderr;
}

/* one chain's body from a ruleset */
function chain(rs, name) {
	const m = new RegExp('\\n\\tchain ' + name.replace(/[.*]/g, '\\$&') + ' \\{\\n([\\s\\S]*?)\\n\\t\\}').exec(rs);
	return m ? m[1] : '';
}

const DUMP = [ iface('lan', '192.0.2.1'), iface('wan', PUBLIC, { uplink: true }) ];

test('fw4 itself: the regressions\' openings are in the ruleset it writes', { skip: NO_FW4 }, () => {
	const cases = [
		[ 'A1 * forwarding', BASE.concat([ [ 'forwarding', { src: '*', dest: 'lan' } ] ]), 'forward-into',
			rs => /jump accept_to_lan comment "!fw4: Accept any to lan forwarding"/.test(chain(rs, 'forward')) ],
		[ 'A1 defaults.forward', withDefaults(BASE, { forward: 'ACCEPT' }), 'default-forward',
			rs => /policy accept;/.test(chain(rs, 'forward')) && /jump reject_to_wan/.test(chain(rs, 'forward_wan')) && /oifname "eth-wan"/.test(chain(rs, 'reject_to_wan')) ],
		[ 'A1 family-restricted zone', withDefaults(BASE, { input: 'ACCEPT' }).map(([ t, o ]) => [ t, o.name === 'wan' ? Object.assign({}, o, { family: 'ipv4' }) : o ]), 'outside-input',
			rs => /policy accept;/.test(chain(rs, 'input')) && /meta nfproto ipv4 iifname "eth-wan" jump input_wan/.test(chain(rs, 'input')) ],
		[ 'A5 proto 6', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: '6', dest_port: '22', target: 'ACCEPT' } ] ]), 'admin-open',
			rs => /tcp dport 22 counter accept comment "!fw4: R"/.test(chain(rs, 'input_wan')) ],
		[ 'A5 !tcp', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: '!tcp', dest_port: '22', target: 'ACCEPT' } ] ]), 'admin-open',
			rs => /tcp dport 22 counter accept comment "!fw4: R"/.test(chain(rs, 'input_wan')) ],
		[ 'A5 all ignores ports', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: 'all', dest_port: '8080', target: 'ACCEPT' } ] ]), 'admin-open',
			rs => /^\s*counter accept comment "!fw4: R"/m.test(chain(rs, 'input_wan')) ],
		[ 'A5 negated source', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: 'tcp', dest_port: '22', src_ip: '!203.0.113.8', target: 'ACCEPT' } ] ]), 'admin-open',
			rs => /ip saddr != 203\.0\.113\.8 tcp dport 22 counter accept/.test(chain(rs, 'input_wan')) ],
		[ 'A6 ACCEPT redirect', BASE.concat([ [ 'redirect', { name: 'P', src: 'wan', proto: 'tcp', src_dport: '443', dest_ip: '192.0.2.10', dest_port: '443', target: 'ACCEPT' } ] ]), null,
			rs => /dnat 192\.0\.2\.10:443 comment "!fw4: P"/.test(chain(rs, 'dstnat_wan')) && /ct status dnat accept/.test(chain(rs, 'forward_wan')) ],
		[ 'A6 local redirect', BASE.concat([ [ 'redirect', { name: 'P', src: 'wan', proto: 'tcp', src_dport: '2222', dest_port: '22' } ] ]), 'admin-open',
			rs => /tcp dport 2222 counter redirect to 22 comment "!fw4: P"/.test(chain(rs, 'dstnat_wan')) && /ct status dnat accept/.test(chain(rs, 'input_wan')) ],
		[ 'A6 wildcard DNAT', BASE.concat([ [ 'redirect', { name: 'P', src: '*', proto: 'tcp', src_dport: '80', dest_ip: '192.0.2.10' } ] ]), null,
			rs => !/!fw4: P"/.test(rs) && /must not have source '\*'/.test(rs) ],
		[ 'A7 disabled wan', [ [ 'defaults', { input: 'ACCEPT', forward: 'REJECT' } ], [ 'zone', { name: 'wan', network: 'wan', input: 'REJECT', enabled: '0' } ],
			[ 'rule', { name: 'R', src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT' } ] ], 'outside-input',
			rs => /policy accept;/.test(chain(rs, 'input')) && !/input_wan/.test(rs) && !/!fw4: R"/.test(rs) ],
		[ 'A7 masq on', [ [ 'zone', { name: 'outside', network: 'wan', input: 'ACCEPT', masq: 'on' } ] ], 'input-accept',
			rs => /masquerade/.test(chain(rs, 'srcnat_outside')) ],
		[ 'A7 enabled off', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT', enabled: 'off' } ] ]), null,
			rs => !/!fw4: R"/.test(rs) && /is disabled/.test(rs) ],
		[ 'A7 Yes refused', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: 'tcp', dest_port: '22', target: 'ACCEPT', enabled: 'Yes' } ] ]), null,
			rs => !/!fw4: R"/.test(rs) && /invalid value 'Yes'/.test(rs) ],
		[ 'B1 IKE to the router', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', proto: 'udp', dest_port: '500 4500', target: 'ACCEPT' } ] ]), null,
			rs => /udp dport \{ 500, 4500 \} counter accept comment "!fw4: R"/.test(chain(rs, 'input_wan')) ],
		[ 'B4 rule into lan', BASE.concat([ [ 'rule', { name: 'R', src: 'wan', dest: 'lan', proto: 'all', target: 'ACCEPT' } ] ]), 'rule-into',
			rs => /counter jump accept_to_lan comment "!fw4: R"/.test(chain(rs, 'forward_wan')) ],
		[ 'B18 unset policies', [ [ 'zone', { name: 'wan', network: 'wan' } ] ], null,
			rs => /policy drop;/.test(chain(rs, 'input')) && /jump drop_from_wan/.test(chain(rs, 'input_wan')) ]
	];
	for (const [ name, list, code, check ] of cases) {
		const values = cfg(list);
		const rs = fw4Ruleset(values, DUMP);
		assert.ok(check(rs), name + ':\n' + rs.slice(0, 4000));
		const r = fw.analyse(values, DUMP);
		if (code) assert.ok(r.warnings.some(w => w.code === code), name + ': model ' + codes(r));
		else assert.ok(!r.warnings.some(w => w.level === 'err'), name + ': model ' + codes(r));
	}
});

test('fw4 itself: the 1.0.7 final check\'s cases (CX S4, S5, S6, N1)', { skip: NO_FW4 }, () => {
	const LAN = LAN_DEV, WAN = WAN_DEV;
	const modem = [ LAN, Object.assign(iface('wan', null), { device: 'wwan0', l3_device: 'wwan0' }),
		Object.assign(iface('wan_4', PUBLIC, { uplink: true }), { device: '@wan', l3_device: 'wwan0' }) ];
	const split = [ LAN, Object.assign({}, WAN, { route: [ { target: '0.0.0.0', mask: 0 } ], 'ipv4-address': [ { address: PUBLIC, mask: 24 } ] }),
		Object.assign(iface('wan6', null), { device: 'eth1', l3_device: 'eth1', 'ipv6-address': [ { address: '2001:db8::2', mask: 64 } ] }) ];
	const SPLIT = [ [ 'defaults', { input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT' } ],
		[ 'zone', { name: 'lan', network: 'lan', input: 'ACCEPT' } ],
		[ 'zone', { name: 'wan', network: 'wan', family: 'ipv4', input: 'REJECT', masq: '1' } ],
		[ 'zone', { name: 'wan6', network: 'wan6', family: 'ipv6', input: 'REJECT' } ] ];
	const set = (match, ref) => MASQ.concat([ [ 'ipset', { name: 'mine', match, family: 'ipv4', entry: [ '203.0.113.5' ] } ],
		[ 'rule', { name: 'SSH', src: 'wan', proto: 'tcp', dest_port: '22', ipset: ref || 'mine', target: 'ACCEPT' } ] ]);
	const redirect = dest_ip => MASQ.concat([ [ 'redirect', { name: 'P', src: 'wan', proto: 'tcp', src_dport: '2222', dest_ip, dest_port: '22' } ] ]);
	const skipped = opts => [ acceptIn(zoneOpts(MASQ, 'wan', opts)), [ LAN, WAN ], 'outside-input',
		rs => /policy accept;/.test(chain(rs, 'input')) && !/input_wan/.test(rs) && /skipped due to invalid options/.test(rs) ];
	const cases = [
		[ 'S4 modem alias', acceptIn(MASQ), modem, null, rs => /iifname "wwan0" jump input_wan/.test(chain(rs, 'input')) ],
		[ 'S4 split families', SPLIT, split, null,
			rs => /meta nfproto ipv4 iifname "eth1" jump input_wan /.test(chain(rs, 'input')) && /meta nfproto ipv6 iifname "eth1" jump input_wan6/.test(chain(rs, 'input')) ],
		[ 'S4 excluded alias', [ [ 'defaults', { input: 'ACCEPT', forward: 'REJECT' } ], [ 'zone', { name: 'wan', device: 'wwan+', network: '!wan_4', input: 'REJECT' } ] ], modem, 'outside-input',
			rs => /iifname "wwan\*" iifname != "wwan0" jump input_wan/.test(chain(rs, 'input')) && /policy accept;/.test(chain(rs, 'input')) ],
		[ 'S5 destination set', set('dest_ip'), [ LAN, WAN ], 'admin-open', rs => /tcp dport 22 ip daddr @mine counter accept/.test(chain(rs, 'input_wan')) ],
		[ 'S5 source set as dst', set('src_ip', 'mine dst'), [ LAN, WAN ], 'admin-open', rs => /tcp dport 22 ip daddr @mine counter accept/.test(chain(rs, 'input_wan')) ],
		[ 'S5 source set', set('src_ip'), [ LAN, WAN ], null, rs => /tcp dport 22 ip saddr @mine counter accept/.test(chain(rs, 'input_wan')) ],
		[ 'S6 masked router address', redirect('192.0.2.1/32'), [ LAN, WAN ], 'admin-open',
			rs => /dnat 192\.0\.2\.1:22 comment "!fw4: P"/.test(chain(rs, 'dstnat_wan')) && /ct status dnat accept/.test(chain(rs, 'input_wan')) ],
		[ 'S6 prefix is the subnet base', redirect('192.0.2.1/24'), [ LAN, WAN ], null, rs => /dnat 192\.0\.2\.0:22 comment "!fw4: P"/.test(chain(rs, 'dstnat_wan')) ],
		[ 'S6 IPv6 spelling', MASQ.concat([ [ 'redirect', { name: 'P', src: 'wan', proto: 'tcp', family: 'ipv6', src_dport: '2222', dest_ip: '2001:DB8:0:0::1', dest_port: '22' } ] ]),
			[ Object.assign({}, LAN, { 'ipv6-address': [ { address: '2001:db8::1', mask: 64 } ] }), WAN ], 'admin-open',
			rs => /dnat \[2001:db8::1\]:22 comment "!fw4: P"/.test(chain(rs, 'dstnat_wan')) ],
		[ 'N1 log yes' ].concat(skipped({ log: 'yes' })),
		[ 'N1 invalid subnet' ].concat(skipped({ subnet: 'nonsense' })),
		[ 'N1 unknown masq_src network' ].concat(skipped({ masq_src: 'nosuchnet' })),
		[ 'N1 log_limit unit' ].concat(skipped({ log_limit: '10/fortnight' })),
		[ 'N1 extra as a list' ].concat(skipped({ extra: [ 'a', 'b' ] })),
		[ 'N1 custom_chains Yes' ].concat(skipped({ custom_chains: 'Yes' })),
		[ 'G3 shadowed wan', zones({ input: 'REJECT' }, LANZ, { name: 'guard', device: 'eth1', input: 'REJECT' }, { name: 'wan', network: 'wan', input: 'ACCEPT' }), [ LAN, WAN ], 'complex',
			rs => /iifname "eth1" jump input_guard.*\n(.*\n)*.*iifname "eth1" jump input_wan/.test(chain(rs, 'input')) && /jump reject_from_guard/.test(chain(rs, 'input_guard')) ],
		[ 'subnet-only zone', zones({ input: 'REJECT' }, { name: 'sources', subnet: '203.0.113.0/24', input: 'ACCEPT' }, LANZ, { name: 'wan', network: 'wan', input: 'REJECT', masq: '1' }), [ LAN, WAN ], 'complex',
			rs => /meta nfproto ipv4 ip saddr 203\.0\.113\.0\/24 jump input_sources/.test(chain(rs, 'input')) ],
		[ 'wan excludes lan', zones({ input: 'REJECT' }, { name: 'lan', device: 'eth0', input: 'ACCEPT' }, { name: 'wan', device: [ 'eth+', '!eth0' ], input: 'REJECT', masq: '1' }), [ LAN, WAN ], null,
			rs => /iifname "eth0" jump input_lan/.test(chain(rs, 'input')) && /iifname "eth\*" iifname != "eth0" jump input_wan/.test(chain(rs, 'input')) ],
		[ 'unlisted VPN device', zones({ input: 'REJECT' }, LANZ, { name: 'wan', network: 'wan', input: 'REJECT', masq: '1' },
			{ name: 'rest', device: 'tun0', input: 'ACCEPT' }, { name: 'vpn', device: 'tun+', input: 'REJECT', masq: '1' }), [ LAN, WAN ], 'complex',
			rs => /iifname "tun0" jump input_rest.*\n(.*\n)*.*iifname "tun\*" jump input_vpn/.test(chain(rs, 'input')) && /jump accept_from_rest/.test(chain(rs, 'input_rest')) ],
		[ 'N1 covered subnet', acceptIn(zoneOpts(MASQ, 'wan', { subnet: '203.0.113.0/24' })), [ LAN, WAN ], 'complex',
			rs => /policy accept;/.test(chain(rs, 'input')) && /meta nfproto ipv4 iifname "eth1" ip saddr 203\.0\.113\.0\/24 jump input_wan/.test(chain(rs, 'input')) ]
	];
	for (const [ name, list, dump, code, check ] of cases) {
		const values = cfg(list);
		const rs = fw4Ruleset(values, dump);
		assert.ok(check(rs), name + ':\n' + rs.slice(0, 4000));
		const r = fw.analyse(values, dump);
		if (code === 'complex') assert.ok(r.complex.length && !r.warnings.length, name + ': model ' + JSON.stringify(r.complex));
		else if (code) assert.ok(r.warnings.some(w => w.code === code), name + ': model ' + codes(r));
		else assert.deepEqual(r.warnings, [], name + ': model ' + codes(r));
		if (code !== 'complex') assert.deepEqual(r.complex, [], name);
	}
});

test('overview: the 1.0.7 final check\'s cases read as fw4 has them (CX S4, S5, S6, N1)', async () => {
	const modem = [ LAN_DEV, Object.assign(iface('wan', null), { device: 'wwan0', l3_device: 'wwan0' }),
		Object.assign(iface('wan_4', PUBLIC, { uplink: true }), { device: '@wan', l3_device: 'wwan0' }) ];
	const alias = await page(cfg(acceptIn(MASQ)), modem);
	assert.match(alias, /Nothing is open in your firewall rules/);
	assert.doesNotMatch(alias, /in no zone/);
	const dst = await page(cfg(MASQ.concat([ [ 'ipset', { name: 'mine', match: 'dest_ip', family: 'ipv4', entry: [ '198.51.100.2' ] } ],
		[ 'rule', { name: 'SSH', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'mine', target: 'ACCEPT' } ] ])), [ LAN_DEV, WAN_DEV ]);
	assert.match(dst, /Router admin open: SSH/);
	assert.match(dst, /SSH\nIPv4 TCP 22 · from anywhere/);
	assert.doesNotMatch(dst, /@mine/);
	const unknownSet = MASQ.concat([ [ 'rule', { name: 'SSH', src: 'wan', proto: 'tcp', dest_port: '22', ipset: 'mine', target: 'ACCEPT' } ] ]);
	const unk = await page(cfg(unknownSet), [ LAN_DEV, WAN_DEV ]);
	assert.match(unk, /This setup is beyond what this overview checks\nWhat is open depends on how firewall4 handles the set in SSH, which this page does not follow\. Check the firewall pages\./);
	assert.doesNotMatch(unk, /Router admin open|Nothing is open|Open from the internet|settings below/);
	assert.match(JSON.stringify(await pageNode(cfg(unknownSet), [ LAN_DEV, WAN_DEV ])), /vt-orb-unknown/);
	const masked = cfg(MASQ.concat([ [ 'redirect', { name: 'Router masked', src: 'wan', proto: 'tcp', src_dport: '2222', dest_ip: '192.0.2.1/32', dest_port: '22' } ] ]));
	const local = await page(masked, [ LAN_DEV, WAN_DEV ]);
	assert.match(local, /On this router\nRouter masked\nIPv4 TCP 2222 · from anywhere\nrouter port 22/);
	assert.match(local, /Router admin open: Router masked/);
	const blind = await page(masked);
	assert.match(blind, /Router masked may open the router's admin/);
	assert.match(blind, /to 192\.0\.2\.1\/32\. The interface list could not be read/);
	assert.match(blind, /Into your network\nRouter masked/);
	assert.doesNotMatch(blind, /Router admin open|Nothing is open/);
	const log = await page(cfg(acceptIn(zoneOpts(MASQ, 'wan', { log: 'yes' }))), [ LAN_DEV, WAN_DEV ]);
	assert.match(log, /wan is in no zone and accepts every connection/);
	assert.match(log, /Zone wan\nzone · ignored: option log has a value firewall4 refuses/);
	assert.doesNotMatch(log, /Nothing is open/);
	const sub = await page(cfg(acceptIn(zoneOpts(MASQ, 'wan', { subnet: '203.0.113.0/24' }))), [ LAN_DEV, WAN_DEV ]);
	assert.match(sub, /This setup is beyond what this overview checks\nWhat is open depends on how firewall4 handles the covered subnets of zone wan, which this page does not follow\./);
	assert.doesNotMatch(sub, /Nothing is open|Open from the internet|need attention/);
	assert.match(sub, /Zones\nGeneral Settings/);
	assert.doesNotMatch(sub, /settings below/, 'nothing to check');
	/* the warning it would give, as a setting to check */
	const open = cfg(acceptIn(zoneOpts(MASQ, 'wan', { subnet: '203.0.113.0/24', input: 'ACCEPT' })));
	const subOpen = await page(open, [ LAN_DEV, WAN_DEV ]);
	assert.match(subOpen, /which this page does not follow\. Check the firewall pages\. The settings below apply if traffic reaches them as configured\.\n+wan accepts every connection\n/);
	const node = JSON.stringify(await pageNode(open, [ LAN_DEV, WAN_DEV ]));
	assert.match(node, /"aria-label":"Settings to check"/);
	assert.doesNotMatch(node, /vt-chip-err/);
});

/* --------------------------- M1: ubus errors through LuCI's own rpc.js

   LuCI's rpc.js (from the rootfs dump; skipped without it) decodes the
   JSON-RPC frames a ubus call returns, so a status like [ 6 ] (permission
   denied) takes the same path as on a router, not a mocked rejection. */
const RPC_JS = path.join(ROOTFS, 'www/luci-static/resources/rpc.js');
const NO_RPC = fs.existsSync(RPC_JS) ? false : 'no rpc.js in the rootfs dump (set VANTAGE_ROOTFS)';

/* the view on LuCI's rpc.js; frames: 'object method' -> the reply's
   `result`, or a function of the request returning the whole frame */
async function rpcPage(frames) {
	const src = fs.readFileSync(RPC_JS, 'utf8');
	const request = {
		post: (url, msg) => Promise.resolve({ ok: true, status: 200, json: () => {
			const f = frames[msg.params[1] + ' ' + msg.params[2]];
			return typeof f === 'function' ? f(msg) : { jsonrpc: '2.0', id: msg.id, result: f };
		} })
	};
	const v = loadView(null, () => new Function('baseclass', 'request', src)({ extend: p => p }, request));
	const r = await v.load();
	const node = v.render(r);
	return { r, node, t: text(node) };
}

const PERMISSIVE = cfg(acceptIn(MASQ));

test('M1: ubus errors on the firewall config reach the error path, not the access point text (CX M1)', { skip: NO_RPC }, async () => {
	const okDump = [ 0, { interface: [ LAN_DEV, WAN_DEV ] } ];
	for (const [ uci, why ] of [
		[ [ 6 ], 'permission denied' ], [ [ 9 ], 'unspecified error' ], [ [ 4 ], 'not found' ], [ [ 0 ], 'no data' ],
		[ [ 0, { values: 'bad' } ], 'values not an object' ], [ [ 0, { values: [] } ], 'values a list' ], [ [ 0, {} ], 'no values' ],
		[ msg => ({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'Access denied' } }), 'a JSON-RPC error' ]
	]) {
		const { r, node, t } = await rpcPage({ 'uci get': uci, 'network.interface dump': okDump });
		assert.deepEqual(r, { error: true }, why);
		assert.match(t, /Could not read the firewall configuration/, why);
		assert.doesNotMatch(t, /No internet-facing zone|access point|Nothing is open/, why);
		assert.match(JSON.stringify(node), /vt-orb-err/, why);
	}
});

test('M1: ubus errors on the interface dump leave the uplinks unknown, never "Nothing is open" (CX M1)', { skip: NO_RPC }, async () => {
	for (const [ dump, why ] of [
		[ [ 9 ], 'unspecified error' ], [ [ 6 ], 'permission denied' ], [ [ 0 ], 'no data' ],
		[ [ 0, { interface: 'x' } ], 'interface not a list' ], [ [ 0, { interface: {} } ], 'interface an object' ], [ [ 0, {} ], 'no interface' ]
	]) {
		const { r, t } = await rpcPage({ 'uci get': [ 0, { values: PERMISSIVE } ], 'network.interface dump': dump });
		assert.equal(r.error, undefined, why);
		assert.equal(r.interfaces, false, why);
		assert.deepEqual(codes(r), [ 'uplinks-unknown:' ], why);
		assert.match(t, /The uplinks could not be checked/, why);
		assert.doesNotMatch(t, /Nothing is open/, why);
	}
});

test('M1: when both reads succeed through rpc.js the data is used as it is (CX M1)', { skip: NO_RPC }, async () => {
	/* an access point still reads as one */
	const ap = await rpcPage({ 'uci get': [ 0, { values: cfg([ [ 'defaults', { input: 'ACCEPT' } ], [ 'zone', { name: 'lan', network: 'lan' } ] ]) } ],
		'network.interface dump': [ 0, { interface: [ LAN_DEV ] } ] });
	assert.equal(ap.r.interfaces, true);
	assert.match(ap.t, /No internet-facing zone found/);
	assert.match(JSON.stringify(ap.node), /vt-orb-unknown/);
	/* an empty firewall config is a config, not an error */
	assert.match((await rpcPage({ 'uci get': [ 0, { values: {} } ], 'network.interface dump': [ 0, { interface: [] } ] })).t, /No internet-facing zone found/);
	/* a router whose uplink is zoned: nothing open is a true statement */
	const ok = await rpcPage({ 'uci get': [ 0, { values: PERMISSIVE } ],
		'network.interface dump': [ 0, { interface: [ LAN_DEV, Object.assign({}, WAN_DEV, { route: [ { target: '0.0.0.0', mask: 0 } ], 'ipv4-address': [ { address: PUBLIC, mask: 24 } ] }) ] } ] });
	assert.equal(ok.r.interfaces, true);
	assert.deepEqual(ok.r.warnings, []);
	assert.match(ok.t, /Nothing is open in your firewall rules/);
});

test('M1: both calls reject on a ubus error and have no `expect` default to fall back on (CX M1)', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/firewall.js'), 'utf8');
	const decls = [ ...src.matchAll(/rpc\.declare\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/g) ].map(m => m[1]);
	assert.equal(decls.length, 2);
	for (const d of decls) {
		assert.match(d, /\breject:\s*true\b/, d);
		assert.doesNotMatch(d, /\bexpect\b/, d);
	}
});
