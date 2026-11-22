'use strict';
const mkTmp = require('./tmpdir');
/* dev/replay/store.js: the uci overlay cannot reach Object.prototype and
   refuses names libuci refuses; plugins answer their objects; log text is
   kept free of control characters. Uses a small synthetic mirror. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, safe } = require('../dev/replay/store');

function mirror() {
	const dir = mkTmp('vantage-store-test-');
	fs.mkdirSync(path.join(dir, 'browser-2026-01-01T00-00-00-000Z'));
	const rows = [
		{ at: 1, object: 'uci', method: 'get', args: { config: 'network' }, result: [ 0, { values: {
			lan: { '.anonymous': false, '.type': 'interface', '.name': 'lan', '.index': 0, proto: 'static' } } } ] },
		{ at: 2, object: 'system', method: 'board', args: {}, result: [ 0, { hostname: 'ap', model: 'Demo' } ] }
	];
	fs.writeFileSync(path.join(dir, 'browser-2026-01-01T00-00-00-000Z', 'rpc.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
	return dir;
}

test('store: uci overlay is prototype-safe and validates names like libuci', () => {
	const s = new Store(mirror(), { synthetic: false });
	const INVAL = { result: [ 2 ] };
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: '__proto__', values: { zz: 'x' } }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'constructor', values: { zz: 'x' } }), INVAL);
	assert.deepEqual(s.call('uci', 'add', { config: '__proto__', type: 'x' }), INVAL);
	assert.deepEqual(s.call('uci', 'add', { config: 'network', type: 'x', name: 'prototype' }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: JSON.parse('{"__proto__":{"polluted":1}}') }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: { 'a.b': '1' } }), INVAL);
	assert.deepEqual(s.call('uci', 'delete', { config: 'network', section: 'lan', options: [ '__proto__' ] }), INVAL);
	assert.deepEqual(s.call('uci', 'rename', { config: 'network', section: 'lan', name: '__rt' }).result, [ 0 ], '__rt is a valid uci name');
	assert.deepEqual(s.call('uci', 'rename', { config: 'network', section: '__rt', name: 'lan' }).result, [ 0 ]);
	/* inherited names are not sections or options */
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'toString' }), { result: [ 4 ] });
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'hasOwnProperty' }), { result: [ 4 ] });
	assert.deepEqual(s.call('uci', 'get', { config: 'toString' }).result, [ 4 ]);
	assert.equal(s.uciGet('network', 'lan', 'constructor'), null);
	assert.equal(({}).zz, undefined);
	assert.equal(({}).polluted, undefined);
	/* ordinary use still works */
	const add = s.call('uci', 'add', { config: 'network', type: 'route', values: { target: 'x' } });
	assert.equal(add.result[0], 0);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: { mtu: 1500, dns: [ 'a', 'b' ] } }), { result: [ 0 ] });
	assert.equal(s.call('uci', 'changes', { config: 'network' }).result[1].changes.length, 6);   /* 2 renames, add, 3 values */
	s.call('uci', 'commit', { config: 'network' });
	assert.equal(s.uciGet('network', 'lan', 'mtu'), '1500');
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'dns' }), { result: [ 0, { value: [ 'a', 'b' ] } ] });
	assert.equal(s.uciSeed('__proto__', { x: {} }), false);
	assert.equal(s.uciSeed('extra', { main: { '.type': 'x', '.name': 'main', a: '1' } }), true);
	assert.equal(s.uciGet('extra', 'main', 'a'), '1');
});

test('store: plugins answer their objects and are listed', () => {
	const s = new Store(mirror(), { synthetic: false });
	const files = fs.readdirSync(path.join(__dirname, '../dev/replay')).filter(f => /-plugin\.js$/.test(f));
	for (const f of files) {
		const mod = require(path.join(__dirname, '../dev/replay', f));
		for (const o of Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ]) {
			assert.ok(s.plugins.has(o), o);
			assert.ok(s.list().includes(o), o + ' listed');
		}
	}
	assert.equal(new Store(mirror(), { synthetic: false, plugins: false }).plugins.size, 0);
});

test('store: request-derived log text has no control characters', () => {
	assert.equal(safe('a\u001b]0;x\u0007b\n\u009b31m\u007f'), 'a\\x1b]0;x\\x07b\\x0a\\x9b31m\\x7f');
	const s = new Store(mirror(), { synthetic: false });
	const lines = [];
	const orig = console.error;
	console.error = (...a) => lines.push(a.join(' '));
	try { s.call('o\u001b]52;c;Y3VybA==\u0007', 'm\n[replay] apply (checked): FORGED', {}); }
	finally { console.error = orig; }
	assert.equal(lines.length, 1);
	assert.doesNotMatch(lines[0], /[\x00-\x1f\x7f-\x9f]/);
});

test('--wired: no radios, the uplink renamed wan, synthetic networks with growing counters', () => {
	const wired = require('../dev/replay/wired');
	const ok = data => ({ result: [ 0, data ] });
	assert.deepEqual(wired.transform('luci.vantage', 'wireless', {}, ok({ radio0: {} })), ok({}));
	assert.deepEqual(wired.transform('network.wireless', 'status', {}, ok({ radio0: {} })), ok({}));
	const dump = wired.transform('network.interface', 'dump', {}, ok({ interface: [
		{ interface: 'loopback', up: true, l3_device: 'lo' },
		{ interface: 'lan', up: true, l3_device: 'br-lan', proto: 'static', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] },
		{ interface: 'lan6', up: true, l3_device: 'br-lan' }
	] })).result[1].interface;
	assert.deepEqual(dump.map(i => i.interface), [ 'loopback', 'wan', ...wired.NETS.map(n => n.iface) ]);
	assert.equal(dump[1].l3_device, 'br-lan');
	const devs = () => wired.transform('network.device', 'status', {}, ok({ 'br-lan': {} })).result[1];
	const a = devs()['br-lan0'].statistics.tx_bytes;
	assert.ok(devs()['br-lan0'].statistics.tx_bytes >= a);
	assert.ok('br-lan' in devs());
	/* one device asked by name, errors: untouched */
	assert.deepEqual(wired.transform('network.device', 'status', { name: 'eth0' }, ok({ up: true })), ok({ up: true }));
	assert.deepEqual(wired.transform('luci.vantage', 'wireless', {}, { error: 'x' }), { error: 'x' });
	/* switch ports in the bridge, hosts on them, their names */
	assert.deepEqual(devs()['br-lan0']['bridge-members'], [ 'lan1', 'lan2' ]);
	assert.deepEqual([ devs().lan1.speed, devs().lan2.speed ], [ '1000F', '2500F' ]);
	const hosts = wired.transform('luci.vantage', 'wired', {}, ok({ hosts: [] })).result[1].hosts;
	assert.deepEqual(hosts.map(h => [ h.mac, h.port ]), wired.HOSTS.map(h => [ h[0], h[1] ]));
	assert.ok(hosts.every(h => /^00:00:5e:00:53:/.test(h.mac) && Number.isInteger(h.seen) && h.seen >= 0));
	const hints = wired.transform('luci-rpc', 'getHostHints', {}, ok({})).result[1];
	assert.deepEqual(hints['00:00:5E:00:53:B1'], { ipaddrs: [ '198.51.100.10' ], ip6addrs: [], name: 'desktop' });
});

test('--multiwan: a backup WAN beside the recorded uplink, also on top of --wired, its counters growing', () => {
	const multiwan = require('../dev/replay/multiwan');
	const wired = require('../dev/replay/wired');
	const model = require('./luci-stub').load('vantage.model');
	const ok = data => ({ result: [ 0, data ] });
	const recorded = ok({ interface: [
		{ interface: 'loopback', up: true, l3_device: 'lo' },
		{ interface: 'lan', up: true, l3_device: 'br-lan', proto: 'static', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] }
	] });
	for (const dumpReply of [ recorded, wired.transform('network.interface', 'dump', {}, recorded) ]) {
		const dump = multiwan.transform('network.interface', 'dump', {}, dumpReply).result[1].interface;
		assert.deepEqual(dump.slice(-2).map(i => [ i.interface, i.l3_device ]), [ [ 'wanb', 'eth9' ], [ 'wanb6', 'eth9' ] ]);
		/* the recorded uplink stays the main line, wanb (and its wanb6) one more */
		const main = model.resolveUplink(dump, {});
		assert.ok(main.iface === 'lan' || main.iface === 'wan', main.iface);
		assert.deepEqual(model.extraUplinks(dump, {}, [], main).map(x => [ x.iface, x.metric, x.gateway ]), [ [ 'wanb', 20, multiwan.LINE.gateway ] ]);
		/* asked again: still one wanb */
		assert.equal(multiwan.transform('network.interface', 'dump', {}, ok({ interface: dump })).result[1].interface.filter(i => i.interface === 'wanb').length, 1);
	}
	const devs = () => multiwan.transform('network.device', 'status', {}, ok({ 'br-lan': {} })).result[1];
	/* a device none of the other modes uses (--big has eth1 under eth1.1) */
	const big = require('../dev/replay/big');
	assert.ok(!big.PORTS.some(p => p.dev === multiwan.LINE.dev || p.dev.split('.')[0] === multiwan.LINE.dev) && !wired.PORTS.some(p => p.dev === multiwan.LINE.dev));
	assert.ok(!Object.keys(big.transform('network.device', 'status', {}, ok({}), {}).result[1]).some(d => d === multiwan.LINE.dev || d.split('.')[0] === multiwan.LINE.dev));
	const a = devs().eth9.statistics;
	assert.ok('br-lan' in devs());
	assert.equal(devs().eth9.speed, '1000F');
	assert.ok(devs().eth9.statistics.rx_bytes >= a.rx_bytes && Number.isSafeInteger(a.rx_bytes));
	assert.ok(a.rx_bytes < 1e12, 'counted from the line\'s uptime, not from 1970');
	/* documentation addresses only; errors and one device by name untouched */
	const L = multiwan.LINE;
	assert.ok([ L.addr, L.gateway ].concat(L.dns).every(x => /^203\.0\.113\./.test(x)) && /^2001:db8:/.test(L.addr6));
	assert.deepEqual(multiwan.transform('network.device', 'status', { name: 'eth9' }, ok({ up: true })), ok({ up: true }));
	assert.deepEqual(multiwan.transform('network.interface', 'dump', {}, { error: 'x' }), { error: 'x' });
	assert.deepEqual(multiwan.transform('luci.vantage', 'wireless', {}, ok({ radio0: {} })), ok({ radio0: {} }));
});

test('synthetic: three documentation hosts on the recorded bridge\'s wired member, none without a bridge', () => {
	const { Synthetic } = require('../dev/replay/synthetic');
	const plugin = require('../dev/replay/vantage-plugin');
	const devs = { 'br-lan': { type: 'bridge', 'bridge-members': [ 'phy0-ap0', 'eth0' ] }, eth0: { devtype: 'ethernet' }, 'phy0-ap0': { devtype: 'wlan' } };
	const syn = new Synthetic({ data: (o, m) => (o === 'network.device' && m === 'status') ? devs : null });
	const orig = console.error;
	console.error = () => {};
	try {
		const hosts = plugin.wired(syn.fdb());
		assert.deepEqual(hosts.map(h => [ h.mac, h.port, h.bridge ]), [ 1, 2, 3 ].map(i => [ '00:00:5e:00:53:a' + i, 'eth0', 'br-lan' ]));
		assert.deepEqual(new Synthetic({ data: () => ({ eth0: {} }) }).fdb(), []);
	}
	finally { console.error = orig; }
});

test('--big: four radios, ten networks, 74 stations and six ports, one a switch VLAN; counters that add up', () => {
	const big = require('../dev/replay/big');
	const ok = data => ({ result: [ 0, data ] });
	const nf = { result: [ 4 ] };
	/* the recorded LAN gives the addresses their prefix and the gateway */
	big.transform('network.interface', 'dump', {}, ok({ interface: [
		{ interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.69', mask: 24 } ], route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] }
	] }));
	const wl = big.transform('luci.vantage', 'wireless', {}, ok({ radio0: {} })).result[1];
	assert.deepEqual(Object.keys(wl), [ 'radio0', 'radio1', 'radio2', 'radio3' ]);
	assert.deepEqual(Object.values(wl).map(r => r.config.band), [ '2g', '5g', '6g', '5g' ]);
	const ifs = Object.values(wl).flatMap(r => r.interfaces.map(i => i.ifname));
	assert.equal(ifs.length, 10);
	assert.deepEqual(big.transform('network.wireless', 'status', {}, nf), ok(wl), 'whatever the recording answered');
	/* stations per network, from iwinfo and hostapd alike */
	let n = 0;
	for (const f of ifs) {
		const st = big.transform('iwinfo', 'assoclist', { device: f }, nf).result[1].results;
		const hc = big.transform('hostapd.' + f, 'get_clients', {}, nf).result[1].clients;
		assert.deepEqual(st.map(s => s.mac.toLowerCase()).sort(), Object.keys(hc).sort(), f);
		assert.equal(big.transform('iwinfo', 'info', { device: f }, nf).result[1].channel, big.RADIOS.find(r => r.id === big.NETS.find(x => x[0] === f)[1]).channel);
		assert.equal(big.transform('hostapd.' + f, 'get_status', {}, nf).result[1].status, 'ENABLED');
		n += st.length;
	}
	assert.equal(n, 74);
	/* an interface it does not know, and one device by name: untouched */
	assert.deepEqual(big.transform('iwinfo', 'assoclist', { device: 'phy9-ap0' }, nf), nf);
	assert.deepEqual(big.transform('hostapd.phy9-ap0', 'get_clients', {}, nf), nf);
	assert.deepEqual(big.transform('network.device', 'status', { name: 'eth0' }, ok({ up: true })), ok({ up: true }));
	/* a network's counters are its stations' sums; eth0 carries most of
	   it, after the LAN's own; the counters only grow */
	const devs = big.transform('network.device', 'status', {}, ok({ eth0: { devtype: 'ethernet' }, 'br-lan': { type: 'bridge' } })).result[1];
	const sta = big.transform('iwinfo', 'assoclist', { device: 'phy1-ap0' }, nf).result[1].results;
	const tx = sta.reduce((a, s) => a + s.tx.bytes, 0);
	assert.ok(Math.abs(devs['phy1-ap0'].statistics.tx_bytes - tx) <= tx * 1e-3, 'the network sends what its stations get');
	assert.equal(devs['br-lan']['bridge-members'][0], 'eth0', 'the uplink port first');
	assert.deepEqual(big.PORTS.map(p => devs[p.dev].speed), [ '1000F', '2500F', '1000F', '100F', '2500F', '10000F' ]);
	assert.equal(devs['eth1.1'].devtype, 'vlan');
	const later = big.transform('network.device', 'status', {}, ok({})).result[1];
	assert.ok(later.eth0.statistics.rx_bytes >= devs.eth0.statistics.rx_bytes);
	assert.ok(Number.isSafeInteger(later.eth0.statistics.rx_bytes));
	/* hosts on the ports and the gateway on eth0, documentation values only */
	const wiredReply = big.transform('luci.vantage', 'wired', {}, ok({ hosts: [] })).result[1], hosts = wiredReply.hosts;
	assert.equal(hosts.length, 17);
	assert.deepEqual([ ...new Set(hosts.map(h => h.port)) ].sort(), [ 'eth0', 'eth1.1', 'lan1', 'lan2', 'lan3', 'lan4', 'lan5' ]);
	/* switch0 behind eth1.1, its link state from LuCI's call */
	assert.deepEqual(wiredReply.switches, { 'eth1.1': big.SWITCH });
	const state = big.transform('luci', 'getSwconfigPortState', { switch: 'switch0' }, nf).result[1].result;
	assert.deepEqual(state.filter(p => p.link).map(p => [ p.port, p.speed ]), [ [ 1, 2500 ], [ 2, 1000 ], [ 3, 1000 ], [ 5, 10000 ] ]);
	assert.deepEqual(big.transform('luci', 'getSwconfigPortState', { switch: 'switch1' }, nf), nf);
	const hints = big.transform('luci-rpc', 'getHostHints', {}, ok({})).result[1];
	assert.deepEqual(hints['00:00:5E:00:53:FE'], { name: 'router', ipaddrs: [ '192.0.2.1' ], ip6addrs: [] });
	const macs = Object.keys(hints).concat(hosts.map(h => h.mac), sta.map(s => s.mac));
	assert.ok(macs.every(m => /^(00:00:5e:00:53|02:00:5e:[0-9a-f]{2}:[0-9a-f]{2}):[0-9a-f]{2}$/i.test(m)), 'documentation MACs');
	assert.ok(Object.values(hints).every(h => h.ipaddrs.every(a => /^192\.0\.2\.\d+$/.test(a))), 'the recorded LAN\'s prefix');
});

/* the dashboard's Ports tile takes a device for a port when netifd calls it ethernet (or dsa) and its driver names
   the link modes it supports, as every real port's does: the synthetic ports of the modes carry them */
test('--wired, --multiwan, --big: the synthetic ports are ports to the dashboard (link modes), a VLAN and a bridge are not', () => {
	const wired = require('../dev/replay/wired'), multiwan = require('../dev/replay/multiwan'), big = require('../dev/replay/big');
	const model = require('./luci-stub').load('vantage.model');
	const ok = data => ({ result: [ 0, data ] });
	/* the recorded access point: a bridge of one Ethernet port and its Wi-Fi interfaces */
	const modes = [ '10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F', '2500baseT-F' ];
	const recorded = () => ok({ 'br-lan': { devtype: 'bridge', type: 'bridge', up: true, carrier: true, 'link-supported': [], 'bridge-members': [ 'eth0', 'phy0-ap0' ] },
		eth0: { devtype: 'ethernet', up: true, carrier: true, speed: '2500F', 'link-supported': modes }, 'phy0-ap0': { up: true, carrier: true }, lo: { up: true, carrier: true } });
	const ids = devs => model.ports(devs, {}, {}, [], [], []).map(p => p.id);
	assert.deepEqual(ids(recorded().result[1]), [ 'eth0' ], 'as recorded: one port, no tile');
	assert.deepEqual(wired.modes('1000F'), modes.slice(0, 5));
	assert.deepEqual(wired.modes('2500F'), modes);
	const w = wired.transform('network.device', 'status', {}, recorded()).result[1];
	assert.deepEqual(ids(w), [ 'eth0', 'lan1', 'lan2' ]);
	assert.deepEqual(ids(multiwan.transform('network.device', 'status', {}, recorded()).result[1]), [ 'eth0', 'eth9' ], 'a second line is a second port');
	assert.deepEqual(ids(multiwan.transform('network.device', 'status', {}, ok(w)).result[1]), [ 'eth0', 'eth9', 'lan1', 'lan2' ]);
	/* --big: five ports beside the uplink's, and switch0's four behind the VLAN eth1.1, which is no port itself */
	const b = big.transform('network.device', 'status', {}, recorded()).result[1];
	const reply = big.transform('luci.vantage', 'wired', {}, ok({ hosts: [] })).result[1];
	const state = { switch0: big.transform('luci', 'getSwconfigPortState', { switch: 'switch0' }, { result: [ 4 ] }).result[1].result };
	const ports = model.ports(b, reply.switches, state, big.NETS.map(n => n[0]), reply.hosts, []);
	assert.deepEqual(ports.map(p => p.name), [ 'eth0', 'lan1', 'lan2', 'lan3', 'lan4', 'lan5', 'LAN 1', 'LAN 2', 'LAN 3', 'LAN 4' ]);
	assert.deepEqual(ports.map(p => p.hosts), [ 1, 1, 1, 7, 1, 3, null, null, null, null ], 'three of the switch\'s ports have a link: whose the VLAN\'s hosts are is not known');
	assert.deepEqual(ports.slice(6).map(p => p.link), [ false, true, true, true ]);
	/* lan4, the port at 100 Mbit/s, counts receive errors that only grow; no other port counts any */
	const errors = d => ports.map(p => p.sw ? 0 : d[p.id].statistics.rx_errors);
	const first = errors(b), later = errors(big.transform('network.device', 'status', {}, recorded()).result[1]);
	assert.ok(first[4] > 0 && later[4] >= first[4] && Number.isInteger(first[4]));
	assert.deepEqual(first.filter((n, i) => i !== 4), [ 0, 0, 0, 0, 0, 0, 0, 0, 0 ]);
	assert.equal(ports[4].counters.rxErrors, first[4]);
});

test('--wg: two WireGuard tunnels in the form LuCI\'s plugin gives; sessions and counters that move; documentation values only', () => {
	const wg = require('../dev/replay/wg');
	const model = require('./luci-stub').load('vantage.model');
	const now = Math.floor(Date.now() / 1000);
	const r = wg.transform('luci.wireguard', 'getWgInstances', {}, null);
	assert.equal(r.result[0], 0);
	const data = r.result[1];
	assert.deepEqual(Object.keys(data), [ 'wg0', 'wg1' ]);
	/* as `wg show all dump` split by tabs: every field text, "(none)" and "off" for nothing, no key but the public ones */
	for (const [ name, t ] of Object.entries(data)) {
		assert.deepEqual(Object.keys(t), [ 'name', 'public_key', 'listen_port', 'fwmark', 'peers' ]);
		assert.deepEqual([ t.name, typeof t.listen_port, t.fwmark ], [ name, 'string', 'off' ]);
		for (const p of t.peers) {
			assert.deepEqual(Object.keys(p), [ 'name', 'public_key', 'endpoint', 'allowed_ips', 'latest_handshake', 'transfer_rx', 'transfer_tx', 'persistent_keepalive' ]);
			for (const k of [ 'public_key', 'endpoint', 'latest_handshake', 'transfer_rx', 'transfer_tx', 'persistent_keepalive' ]) assert.equal(typeof p[k], 'string', k);
			assert.match(p.public_key, /^[A-Za-z0-9+/]{43}=$/);
			/* the plugin lists allowed IPs only beside an endpoint */
			assert.equal(p.endpoint === '(none)', p.allowed_ips.length === 0);
		}
	}
	assert.doesNotMatch(JSON.stringify(data), /private|preshared|psk/i);
	/* what the dashboard makes of it: both tunnels, every state, a peer that goes by its key */
	const t = model.wireguard(data, now);
	assert.deepEqual(t.map(x => [ x.name, x.port, x.peers.length ]), [ [ 'wg0', 51820, 7 ], [ 'wg1', 51821, 1 ] ]);
	assert.deepEqual(t[0].peers.map(p => p.state), [ 'recent', 'recent', 'recent', 'stale', 'stale', 'never', 'never' ]);
	assert.deepEqual(t[0].peers.map(p => p.name), [ 'kitchen tablet', 'Mira phone', 'workshop laptop', 'Jonas phone', 'backup NAS at the cabin', 'guest laptop', '' ]);
	assert.ok(t[0].peers.length > 5, 'more than a tunnel lists before "+n more"');
	assert.equal(t[0].peers[6].label, t[0].peers[6].key);
	assert.deepEqual([ t[1].peers[0].state, t[1].peers[0].keepalive, t[1].peers[0].endpoint ], [ 'recent', 25, '[2001:db8:51::1]:51820' ]);
	/* a session makes a handshake every two minutes: never older than that, at any time */
	for (const dt of [ 0, 59, 119, 120, 3601, 86400 ])
		for (const x of model.wireguard(wg.instances(now + dt), now + dt)) for (const p of x.peers) if (p.state === 'recent') assert.ok(p.age < 120, p.label + ' +' + dt);
	/* counters only grow, and where traffic flows they do */
	const a = wg.instances(now), b = wg.instances(now + 10);
	const num = (d, i, k) => +d.wg0.peers[i][k];
	for (let i = 0; i < 7; i++) for (const k of [ 'transfer_rx', 'transfer_tx' ]) assert.ok(num(b, i, k) >= num(a, i, k) && Number.isSafeInteger(num(b, i, k)), i + ' ' + k);
	assert.ok(num(b, 0, 'transfer_tx') > num(a, 0, 'transfer_tx') && num(b, 1, 'transfer_rx') > num(a, 1, 'transfer_rx'));
	assert.deepEqual([ num(b, 2, 'transfer_rx') - num(a, 2, 'transfer_rx'), num(a, 5, 'transfer_rx'), num(a, 6, 'transfer_tx') ], [ 0, 0, 0 ], 'an idle session; peers that never came');
	/* documentation addresses, keys that are a hash of a label */
	const addrs = Object.values(data).flatMap(x => x.peers.flatMap(p => [ p.endpoint ].concat(p.allowed_ips))).filter(x => x !== '(none)');
	assert.ok(addrs.length > 10 && addrs.every(x => /^\[?(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|2001:db8:)/.test(x)), addrs.join(' '));
	assert.equal(data.wg0.peers[0].public_key, wg.key('wg0 peer 0'));
	/* the plugin's other methods and every other object are left as they are */
	const ok = { result: [ 0, { x: 1 } ] }, nf = { result: [ 4 ] };
	assert.equal(wg.transform('luci.wireguard', 'generateKeyPair', {}, nf), nf);
	assert.equal(wg.transform('network.interface', 'dump', {}, ok), ok);
	assert.equal(wg.transform('luci.vantage', 'getWgInstances', {}, ok), ok);
});
