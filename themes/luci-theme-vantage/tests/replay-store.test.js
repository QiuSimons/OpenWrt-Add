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
