'use strict';
/* Pieces of the dashboard view (view/vantage/overview.js) that take input
   from outside the device replies: the URL hash (deep links) and the
   history kept in sessionStorage. The view is loaded with stub LuCI
   modules; only the methods under test run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

const REPLIES = {};
/* the view's `ui`: tests set ui.menu */
const UI = {};
/* LuCI's poll: tests pause it */
const POLL = { on: true, active() { return this.on; } };

function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args) when set */
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: POLL, ui: UI, dom: {}
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

const view = loadView();

function withLocation(hash, fn) {
	const cleared = [];
	const saved = { location: global.location, history: global.history };
	global.location = { hash, pathname: '/cgi-bin/luci/admin/dashboard', search: '' };
	global.history = { replaceState: (s, t, url) => cleared.push(url) };
	try { return fn(cleared); }
	finally { global.location = saved.location; global.history = saved.history; }
}

function openFor(hash) {
	const self = Object.create(view);
	self.m = { radios: [ { id: 'radio0' }, { id: 'radio1' } ] };
	self.opened = [];
	self.openDrawer = function(kind, id) { this.opened.push([ kind, id ]); };
	return withLocation(hash, cleared => {
		self.openFromHash();
		return { opened: self.opened, cleared };
	});
}

test('deep links: a station MAC or a known radio opens its drawer', () => {
	assert.deepEqual(openFor('#client=00-00-5E-00-53-21').opened, [ [ 'client', '00:00:5e:00:53:21' ] ]);
	assert.deepEqual(openFor('#client=00%3A00%3A5e%3A00%3A53%3A21').opened, [ [ 'client', '00:00:5e:00:53:21' ] ]);
	assert.deepEqual(openFor('#radio=radio1').opened, [ [ 'radio', 'radio1' ] ]);
	assert.deepEqual(openFor('#uplink=anything').opened, [ [ 'uplink', '' ] ], 'a name the device has no line of: the main line');
	assert.deepEqual(openFor('#uplink').opened, [ [ 'uplink', '' ] ], 'the main line, whichever it is');
	assert.deepEqual(openFor('#device=%3Cb%3E').opened, [ [ 'device', 'device' ] ], 'device takes no id');
});

test('deep links: arbitrary text, unknown radios and bad escapes are dropped, not shown', () => {
	const lure = '#radio=URGENT%3A%20firmware%20compromised%20-%20re-enter%20password%20at%20http%3A%2F%2Fevil.example';
	for (const hash of [ lure, '#client=URGENT%3A%20call%20support', '#radio=radio9', '#client=%E0%A4%A', '#radio=%E2%80%AEevil',
		'#client=01-00-5E-00-53-21x', '#client=' + 'a'.repeat(300) ]) {
		let r;
		assert.doesNotThrow(() => { r = openFor(hash); }, hash);
		assert.deepEqual(r.opened, [], hash);
		assert.deepEqual(r.cleared, [ '/cgi-bin/luci/admin/dashboard' ], `${hash}: cleared from the address bar`);
	}
	/* hashes that are not deep links are left alone */
	for (const hash of [ '', '#', '#tab=wifi' ]) assert.deepEqual(openFor(hash), { opened: [], cleared: [] }, hash);
});

test('stored history: keys from sessionStorage cannot replace a prototype', () => {
	const savedL = global.L;
	global.L = { env: {} };
	const stored = JSON.stringify({ net: JSON.parse('{"__proto__":[[1,2,3]],"constructor":[[1,2,3]],"radio0":[[1,2,3]]}'), clients: {} });
	const saved = global.window;
	global.window = {
		sessionStorage: { getItem: () => stored, setItem() {} },
		localStorage: { getItem: () => null, setItem() {} }
	};
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const net = self.st.hist.net;
		assert.equal(Object.getPrototypeOf(net), null);
		assert.ok(Object.prototype.hasOwnProperty.call(net, '__proto__'), 'kept as an ordinary key');
		assert.equal(typeof net.map, 'undefined', 'no Array methods through the prototype');
		assert.equal(self.st.rdnsOff, true, 'reverse DNS off without its group');
		for (const k of [ 'devRates', 'staRates', 'radioRates', 'ssidRates', 'isNew' ])
			assert.equal(Object.getPrototypeOf(self.st[k]), null, k);
	} finally {
		global.window = saved;
		global.L = savedL;
	}
});

test('saving a name: set_alias with the normalised MAC, names reloaded after every outcome', async () => {
	const calls = [];
	const self = Object.create(view);
	self.aliases = Object.create(null);
	let reloads = 0;
	self.loadAliases = () => { reloads++; return Promise.resolve({}); };
	const outcomes = [
		[ () => Promise.resolve({ ok: true, op: 'add', mac: '00:00:5e:00:53:21' }), true ],
		[ () => Promise.resolve({ ok: false, error: 'too-many' }), 'This device already stores 512 names; remove some first.' ],
		[ () => Promise.resolve({ ok: false, error: 'failed' }), 'The device could not write /etc/config/vantage.' ],
		[ () => Promise.resolve(6), false ],
		[ () => Promise.reject(new Error('RPCError')), false ]
	];
	for (const [ reply, want ] of outcomes) {
		REPLIES['luci.vantage set_alias'] = (...a) => { calls.push(a); return reply(); };
		const before = reloads;
		assert.deepEqual(await self.saveAlias('00-00-5E-00-53-21', 'TV', 'tv'), want);
		assert.equal(reloads, before + 1, 'aliases reloaded');
	}
	assert.deepEqual(calls[0], [ '00:00:5e:00:53:21', 'TV', 'tv' ]);
	/* removing a name, and an unknown icon: sent as empty strings */
	REPLIES['luci.vantage set_alias'] = (...a) => { calls.push(a); return Promise.resolve({ ok: true }); };
	await self.saveAlias('00:00:5e:00:53:21', 'TV', 'rocket');
	await self.saveAlias('00:00:5e:00:53:21', '', 'tv');
	assert.deepEqual(calls.slice(-2), [ [ '00:00:5e:00:53:21', 'TV', '' ], [ '00:00:5e:00:53:21', '', '' ] ]);
	/* refused before any call */
	const n = calls.length;
	assert.equal(typeof await self.saveAlias('01:00:5e:00:53:21', 'TV', null), 'string');
	assert.equal(typeof await self.saveAlias('00:00:5e:00:53:21', 'a\u202eb', null), 'string');
	assert.equal(calls.length, n);
	delete REPLIES['luci.vantage set_alias'];
});

test('wired-only: decided by an answered empty wireless status, never by a failed call', () => {
	const self = Object.create(view);
	self.st = { wireless: null };
	const m = radios => ({ radios: radios });
	let x = m([]);
	self.markWired(x, { wifi: null });
	assert.equal(x.wired, false, 'a failed call proves nothing');
	self.markWired(x = m([]), { wifi: {} });
	assert.equal(x.wired, true, 'answered, no radios');
	self.markWired(x = m([ { id: 'radio0' } ]), { wifi: { radio0: {} } });
	assert.equal(x.wired, false, 'radios appeared');
	self.markWired(x = m([]), { wifi: {} });
	assert.equal(x.wired, false, 'radios seen once keep the Wi-Fi layout');
	self.markWired(x = m([]), null);
	assert.equal(x.wired, false, 'a rebuild keeps the decision');
});

test('page links: a page LuCI keeps but marks unsatisfied (no block-mount) counts as absent', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const block = src.match(/var menuTree = null;\nfunction hasPage\(page\) \{[\s\S]*?\n\}\n/)[0];
	const hasPage = new Function('tree', block + 'menuTree = tree; return hasPage;');
	const node = (satisfied, children) => Object.assign({ satisfied }, children ? { children } : {});
	/* as LuCI's dispatcher serves it: every node carries satisfied */
	const tree = { children: { admin: node(true, {
		system: node(true, { system: node(true), mounts: node(false) }),
		network: node(false, { wireless: node(true) })
	}) } };
	const has = hasPage(tree);
	assert.equal(has([ 'admin', 'system', 'system' ]), true);
	assert.equal(has([ 'admin', 'system', 'mounts' ]), false, 'kept in the tree, but unsatisfied');
	assert.equal(has([ 'admin', 'network', 'wireless' ]), false, 'an unsatisfied parent hides its children');
	assert.equal(has([ 'admin', 'status', 'nowhere' ]), false, 'missing');
	/* no menu (the load failed): links stay */
	assert.equal(hasPage(null)([ 'admin', 'system', 'mounts' ]), true);
});

test('wired hosts: the path counts those downstream only; filters, search and sort', () => {
	const self = Object.create(view);
	const host = (mac, port, extra) => Object.assign({ mac, port, name: 'h' + mac.slice(-2), macLabel: mac.toUpperCase(), bridge: 'br-lan', network: 'lan',
		vlan: null, seen: 5, shared: false, peers: 1, speed: { mbps: 1000, duplex: 'full' }, ips: [], nameSourceLabel: 'MAC' }, extra);
	const hosts = [
		host('00:00:5e:00:53:01', 'lan2', { seen: 30 }),
		host('00:00:5e:00:53:02', 'lan1', { shared: true, peers: 2, seen: null }),
		host('00:00:5e:00:53:03', 'lan1', { shared: true, peers: 2, ips: [ '192.0.2.30' ] }),
		host('00:00:5e:00:53:04', 'eth0', { gateway: true })
	];
	self.m = { uplink: { dev: 'eth0', statsDev: 'eth0', port: 'eth0' }, wiredHosts: hosts, clients: [], radios: [ { id: 'radio0' } ] };
	self.st = { devRates: { lan2: { rx: 1000, tx: 3000 }, lan1: { rx: 5, tx: 5 } }, staRates: {}, radioInsights: {}, uplinkRate: null };
	self.el = { clients: { scrollIntoView() {} }, filter: {} };
	self.paintClients = () => {};
	self.ui = { kind: 'wired', chip: 'all', filter: '' };

	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ], 'the uplink\'s port leads to the gateway');
	/* the path's Wired branch: a node per downstream port, their hosts counted */
	const stub = () => ({ textContent: '', getAttribute() { return null; }, setAttribute() {} });
	const branch = { ssids: self.wiredPorts().map(port => ({ port, el: stub(), name: stub(), count: stub(), rate: stub() })), title: stub(), sub: stub() };
	self.updateWiredBranch(branch);
	assert.equal(branch.title.textContent, '3 devices');
	/* a bridge with several ports, the gateway's port unknown: the
	   counters' port is a guess, so only the gateway is left out */
	self.m.uplink = { dev: 'lan1', statsDev: 'lan1', port: null };
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ]);
	hosts[3].gateway = false;
	assert.deepEqual(self.wiredPorts(), [ 'eth0', 'lan1', 'lan2' ]);
	hosts[3].gateway = true;

	assert.deepEqual(self.filterDefs().map(d => d.slice(0, 3)), [ [ 'all', 'All', 4 ], [ 'port:eth0', 'eth0', 1 ], [ 'port:lan1', 'lan1', 2 ], [ 'port:lan2', 'lan2', 1 ] ]);
	self.ui.chip = 'port:lan1';
	assert.deepEqual(hosts.filter(h => self.matches(h)).map(h => h.mac.slice(-2)), [ '02', '03' ]);
	self.ui.chip = 'all';
	self.ui.filter = '192.0.2.30';
	assert.deepEqual(hosts.filter(h => self.matches(h)).map(h => h.mac.slice(-2)), [ '03' ]);
	self.ui.filter = 'lan2';
	assert.deepEqual(hosts.filter(h => self.matches(h)).map(h => h.mac.slice(-2)), [ '01' ]);

	assert.equal(self.portRate(hosts[0]).tx, 3000, 'alone on its port: the port\'s traffic is its own');
	assert.equal(self.portRate(hosts[1]), null, 'a shared port\'s traffic is nobody\'s');
	assert.deepEqual([ self.sortValue(hosts[0], 'live'), self.sortValue(hosts[1], 'live') ], [ 4000, -1 ]);
	assert.deepEqual([ self.sortValue(hosts[0], 'link'), self.sortValue(hosts[1], 'link') ], [ 1000, -1 ]);
	assert.equal(self.sortValue(hosts[1], 'seen'), Infinity, 'a static entry sorts last');

	const saved = global.window;
	global.window = { matchMedia: () => ({ matches: true }) };
	try { self.showWired('lan1'); }
	finally { global.window = saved; }
	assert.deepEqual([ self.ui.kind, self.ui.chip, self.ui.filter ], [ 'wired', 'port:lan1', '' ]);
});

test('health checks about clients: several weak open their list, unless the layout hides it', () => {
	const self = Object.create(view);
	const opened = [];
	let shown = true;
	self.el = { clients: { scrollIntoView() {}, getClientRects: () => shown ? [ {} ] : [] }, filter: {} };
	self.paintClients = () => {};
	self.openDrawer = (kind, id) => opened.push(kind + ':' + id);
	self.ui = { kind: 'wired', chip: 'port:lan1', filter: 'x' };
	const saved = global.window;
	global.window = { matchMedia: () => ({ matches: true }) };
	try {
		self.openCheck({ client: 'aa', list: 'weak' });
		assert.deepEqual([ self.ui.kind, self.ui.chip, self.ui.filter, opened.length ], [ 'wifi', 'weak', '', 0 ]);
		shown = false;
		self.openCheck({ client: 'aa', list: 'weak' });
		self.openCheck({ client: 'bb', list: null });
	} finally { global.window = saved; }
	assert.deepEqual(opened, [ 'client:aa', 'client:bb' ]);
});

test('wired branch: each port node shows its traffic, all its hosts\' together', () => {
	const self = Object.create(view);
	const el = () => ({ textContent: '', attrs: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
	const node = port => ({ port, el: el(), name: el(), count: el(), rate: el() });
	const host = (mac, port, extra) => Object.assign({ mac, port, name: 'h' + mac.slice(-2), speed: { mbps: 1000 } }, extra);
	self.m = { wiredHosts: [
		host('00:00:5e:00:53:01', 'lan5', { shared: true, peers: 2 }),
		host('00:00:5e:00:53:02', 'lan5', { shared: true, peers: 2 }),
		host('00:00:5e:00:53:03', 'lan6')
	] };
	self.st = { devRates: { lan5: { rx: 3000, tx: 12345678 } } };
	const b = { ssids: [ node('lan5'), node('lan6') ], title: el(), sub: el() };
	self.updateWiredBranch(b);
	const [ shared, alone ] = b.ssids;
	/* full units: each its own where they differ */
	assert.deepEqual([ shared.name.textContent, shared.count.textContent, shared.rate.textContent ], [ 'lan5', '2 devices', '↓ 12.3 Mbit/s  ↑ 3 kbit/s' ]);
	assert.equal(shared.el.attrs.title, 'Show the devices on lan5\nPort total: ↓ 12.3 Mbit/s · ↑ 3 kbit/s');
	assert.deepEqual([ alone.name.textContent, alone.rate.textContent, alone.el.attrs.title ], [ 'lan6 · h03', '—', 'Show the devices on lan6' ], 'no counters yet: a dash, no total');
	assert.equal(b.sub.textContent, '↓ 12.3 Mbit/s');
});

test('names beyond a poll: reverse DNS and the vendor table for wired hosts too', async () => {
	const self = Object.create(view);
	const asked = [];
	let ouiLoads = 0;
	REPLIES['network.rrdns lookup'] = (addrs) => { asked.push(...addrs); return Promise.resolve({ '192.0.2.40': 'nas.home.arpa' }); };
	const savedL = global.L;
	global.L = { require: () => { ouiLoads++; return Promise.resolve({}); }, resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
	try {
		self.st = { rdns: {}, mdnsOff: true, mdnsAt: 0 };
		let rerendered = 0;
		self.rerender = () => { rerendered++; };
		/* no Wi-Fi clients at all: a router's wired hosts alone */
		self.resolveMore({ clients: [], wiredHosts: [ { mac: '00:00:5e:00:53:40', ips: [ '192.0.2.40' ], nameSource: 'mac' } ] });
		await new Promise(r => setTimeout(r, 0));
		assert.deepEqual(asked, [ '192.0.2.40' ], 'a wired host\'s address is looked up');
		assert.equal(self.st.rdns['192.0.2.40'], 'nas.home.arpa');
		assert.equal(ouiLoads, 1, 'a wired host known only by its MAC loads the vendor table');
		assert.ok(rerendered >= 1);
	}
	finally { global.L = savedL; delete REPLIES['network.rrdns lookup']; }
});

test('wired reply: hosts kept, a crowded bridge flagged, anything else read as none', async () => {
	const self = Object.create(view);
	const savedL = global.L;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	try {
		const host = { mac: '00:00:5e:00:53:01', port: 'lan1', bridge: 'br-lan', vlan: null, seen: 3 };
		const read = async reply => { REPLIES['luci.vantage wired'] = () => Promise.resolve(reply); const r = await self.fetch(); return [ r.fdb, r.fdbCrowded ]; };
		assert.deepEqual(await read({ hosts: [ host ] }), [ [ host ], false ]);
		assert.deepEqual(await read({ hosts: [], crowded: true }), [ [], true ]);
		assert.deepEqual(await read({ hosts: 'x', crowded: 'yes' }), [ [], false ]);
		assert.deepEqual(await read(null), [ [], false ]);
		REPLIES['luci.vantage wired'] = () => Promise.reject(new Error('ubus code 6'));
		const failed = await self.fetch();
		assert.deepEqual([ failed.fdb, failed.fdbCrowded ], [ [], false ], 'a failed call');
	}
	finally { global.L = savedL; delete REPLIES['luci.vantage wired']; }
});

/* iwinfo info costs the router ~15 ms an interface: asked for a radio's
   first interface, and for another only until hostapd gives its BSSID */
test('iwinfo info: once a radio, and for a network hostapd does not answer for', async () => {
	const asked = [], hapdOff = new Set();
	const ifc = (ifname, mode) => ({ ifname, section: ifname, config: { mode: mode || 'ap', ssid: 'S-' + ifname } });
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({
		radio0: { up: true, config: { band: '2g' }, interfaces: [ ifc('wl0'), ifc('wl0-1'), ifc('wl0-sta', 'sta') ] },
		radio1: { up: true, config: { band: '5g' }, interfaces: [ ifc('wl1') ] }
	});
	REPLIES['iwinfo info'] = device => { asked.push(device); return Promise.resolve({ channel: 6, bssid: '00:00:5E:00:53:0' + device.length }); };
	for (const ifn of [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ])
		REPLIES['hostapd.' + ifn + ' get_status'] = () => (ifn === 'wl0-sta' || hapdOff.has(ifn)) ? Promise.reject(new Error('not found')) : Promise.resolve({ bssid: '00:00:5e:00:53:a' + ifn.length, ssid: 'S-' + ifn });
	const self = Object.create(view);
	const savedL = global.L;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	try {
		let r = await self.fetch();
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ], 'the first poll asks every interface');
		r = await self.fetch();
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-sta', 'wl1' ], 'then a radio\'s first, and the one hostapd does not serve');
		assert.equal(r.hapdStatus['wl0-1'].bssid, '00:00:5e:00:53:a5', 'its BSSID comes from hostapd');
		hapdOff.add('wl0-1');
		await self.fetch();
		asked.splice(0);
		await self.fetch();
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ], 'hostapd gone quiet: asked again');
	}
	finally {
		global.L = savedL;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage wireless|iwinfo info|hostapd\.)/.test(k)) delete REPLIES[k];
	}
});

/* Low-power router (#101): the slow parts once every 30 s, their last
   replies in between; the rest every poll */
test('Low-power router: Wi-Fi state, temperatures, wired hosts, iwinfo and client capabilities once every 30 s', async () => {
	const count = {};
	const reply = (key, v) => { REPLIES[key] = (...a) => { count[key] = (count[key] || 0) + 1; return Promise.resolve(typeof v === 'function' ? v(...a) : v); }; };
	reply('luci.vantage wireless', { radio0: { up: true, config: { band: '2g' }, interfaces: [ { ifname: 'wl0', section: 'wl0', config: { mode: 'ap' } } ] } });
	reply('luci.vantage thermal', [ { zone: 'thermal_zone0', type: 'cpu', temp: 50000 } ]);
	reply('luci.vantage wired', { hosts: [ { mac: '00:00:5e:00:53:01', port: 'lan1', bridge: 'br-lan', seen: 1 } ] });
	reply('iwinfo info', { channel: 6 });
	reply('hostapd.wl0 get_clients', { clients: {} });
	reply('hostapd.wl0 get_status', { bssid: '00:00:5e:00:53:aa' });
	reply('system info', {});
	const self = Object.create(view);
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, power = 'low';
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: n => n === 'data-vt-power' ? power : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const slowKeys = [ 'luci.vantage wireless', 'luci.vantage thermal', 'luci.vantage wired', 'iwinfo info', 'hostapd.wl0 get_clients' ];
	const slowCount = () => slowKeys.map(k => count[k] || 0);
	try {
		const first = await self.fetch();
		assert.deepEqual(slowCount(), [ 1, 1, 1, 1, 1 ]);
		t += 10e3;
		const kept = await self.fetch();
		assert.deepEqual(slowCount(), [ 1, 1, 1, 1, 1 ], 'not again within 30 s');
		assert.equal(count['system info'], 2, 'the rest every poll');
		assert.equal(count['hostapd.wl0 get_status'], 2);
		assert.deepEqual([ kept.wifi, kept.thermal, kept.fdb, kept.iwinfo, kept.hapd ], [ first.wifi, first.thermal, first.fdb, first.iwinfo, first.hapd ], 'their last replies');
		t += 20e3;
		await self.fetch();
		assert.deepEqual(slowCount(), [ 2, 2, 2, 2, 2 ], 'again after 30 s');
		power = 'normal';
		t += 1e3;
		await self.fetch();
		assert.deepEqual(slowCount(), [ 3, 3, 3, 3, 3 ], 'off: every poll');
	}
	finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|iwinfo info|hostapd\.|system info)/.test(k)) delete REPLIES[k];
	}
});

test('switch ports: LuCI is asked on the side for a switch with hosts behind it, at most every 30 s from the call; a failure is not known', async () => {
	const calls = [], STATE = [ { port: 1, link: true, speed: 1000, duplex: true } ];
	const lan = n => ({ num: n, role: 'lan', index: n + 1 });
	let answer = () => Promise.resolve({ result: STATE }), slow = 0;
	REPLIES['luci.vantage wired'] = () => Promise.resolve({
		hosts: [ { mac: '00:00:5e:00:53:11', port: 'eth1.1', bridge: 'br-lan', seen: 1 } ],
		switches: { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ lan(0), lan(1) ] }, 'eth1.2': { name: 'switch1', vlan: 2, ports: [ lan(4) ] }, 'eth9': { name: 'bad name;', vlan: 3, ports: [] } }
	});
	REPLIES['luci getSwconfigPortState'] = name => { calls.push(name); return answer(); };
	/* the base replies take `slow` ms of the device's clock */
	REPLIES['system info'] = () => { t += slow; return Promise.resolve({}); };
	const flush = () => new Promise(r => setImmediate(r));
	const self = Object.create(view);
	const now = Date.now, savedL = global.L;
	let t = 1e12;
	Date.now = () => t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
	const poll = async ms => { t += ms; const r = await self.fetch(); await flush(); return r; };
	try {
		const a = await poll(0);
		assert.deepEqual(calls, [ 'switch0' ], 'only the switch with hosts behind it');
		assert.equal(a.switches['eth1.1'].name, 'switch0');
		assert.equal(a.switchState.switch0, null, 'asked on the side: not waited for');
		assert.deepEqual((await poll(5e3)).switchState.switch0, STATE, 'the answer from the next poll');
		assert.deepEqual((await poll(24e3)).switchState.switch0, STATE, 'kept');
		assert.equal(calls.length, 1, 'not again within 30 s');
		await poll(1e3);
		assert.equal(calls.length, 2);

		/* 30 s from the call: base replies that took 10 s put the call 10 s
		   into the poll; 20 s after it, nothing is asked */
		slow = 10e3;
		await poll(30e3);
		slow = 0;
		assert.equal(calls.length, 3);
		await poll(20e3);
		assert.equal(calls.length, 3, 'counted from the call, not the poll');
		await poll(10e3);
		assert.equal(calls.length, 4);

		/* an error reply, no ports, or a failed call: not known (null), not
		   "every port down" */
		for (const bad of [ () => Promise.resolve({ error: 'No such switch' }), () => Promise.resolve({ result: [] }), () => Promise.reject(new Error('denied')) ]) {
			answer = bad;
			await poll(30e3);
			assert.equal((await poll(1e3)).switchState.switch0, null);
		}
		/* a call that never answers holds up no poll */
		answer = () => new Promise(() => {});
		const done = await Promise.race([ poll(30e3).then(() => 'polled'), new Promise(r => setTimeout(() => r('stuck'), 200)) ]);
		assert.equal(done, 'polled');
	} finally {
		Date.now = now;
		global.L = savedL;
		delete REPLIES['luci.vantage wired'];
		delete REPLIES['luci getSwconfigPortState'];
		delete REPLIES['system info'];
	}
});

/* #83: with the Vantage theme installed but another one selected, the
   dashboard makes way for LuCI's own landing page. The dashboard alone
   (no theme package) works under any theme. */
test('another theme: the dashboard steps aside only when the Vantage theme is installed', () => {
	const DASH = [ 'admin', 'status', 'dashboard' ], OVERVIEW = [ 'admin', 'status', 'overview' ];
	/* Vantage is the theme in use */
	assert.equal(view.asidePage('/luci-static/vantage', true, true, true), null);
	assert.equal(view.asidePage('/luci-static/vantage/', true, false, true), null, 'a trailing slash');
	/* another theme, Vantage's installed: LuCI's dashboard, else Status -> Overview */
	assert.deepEqual(view.asidePage('/luci-static/argon', true, true, true), DASH);
	assert.deepEqual(view.asidePage('/luci-static/argon', true, true, false), DASH);
	assert.deepEqual(view.asidePage('/luci-static/argon', true, false, true), OVERVIEW);
	assert.deepEqual(view.asidePage('/luci-static/bootstrap-dark', true, false, true), OVERVIEW);
	assert.deepEqual(view.asidePage('/luci-static/vantage-old', true, false, true), OVERVIEW, 'another name is another theme');
	/* neither page for this user: the dashboard, not an access error */
	assert.equal(view.asidePage('/luci-static/argon', true, false, false), null);
	/* the dashboard only: stays under any theme */
	assert.equal(view.asidePage('/luci-static/argon', false, true, true), null);
	assert.equal(view.asidePage('/luci-static/bootstrap', false, false, true), null);
	assert.equal(view.asidePage('/luci-static/argon', 'yes', true, true), null, 'only a yes from the probe counts');
	/* LuCI named no theme: no decision, as before */
	for (const media of [ undefined, null, '', '/', 42 ])
		assert.equal(view.asidePage(media, true, true, true), null, String(media));
	const a = view.asidePage('/luci-static/argon', true, true, true);
	a.push('x');
	assert.deepEqual(view.asidePage('/luci-static/argon', true, true, true), DASH, 'a fresh path each time');
});

const node = (satisfied, children) => Object.assign({ satisfied }, children ? { children } : {});
const menuWith = (dashboard, overview = node(true)) => ({ children: { admin: node(true, { status: node(true, Object.assign({ overview }, dashboard ? { dashboard } : {})) }) } });
const SCRIPT = { ok: true, status: 200, headers: { get: h => /^content-type$/i.test(h) ? 'application/javascript; charset=UTF-8' : null } };
const NOT_FOUND = { ok: false, status: 404, headers: { get: h => /^content-type$/i.test(h) ? 'text/html' : null } };
const HTML_200 = { ok: true, status: 200, headers: { get: h => /^content-type$/i.test(h) ? 'text/html; charset=UTF-8' : null } };

/* load() with media as L.env.media; theme: the reply to the theme probe
   (an object, or an Error to reject); menu: the menu tree, or null for a
   failed load. 'dashboard' when load() resolved, 'waiting' when it is
   still pending (it never resolves after location.replace) */
async function openDashboard(media, theme, menu) {
	const replaced = [], probes = [], asked = [];
	const saved = { L: global.L, fetch: global.fetch, window: global.window, menu: UI.menu };
	global.L = {
		env: { media, resource_version: '25.12-1' },
		resource: p => '/luci-static/resources/' + p,
		url: (...a) => '/cgi-bin/luci/' + a.join('/'),
		resolveDefault: (p, d) => Promise.resolve(p).catch(() => d)
	};
	global.fetch = (url, opts) => {
		if (url !== '/luci-static/resources/menu-vantage.js') return Promise.resolve({ ok: false, text: () => Promise.resolve('') });
		probes.push((opts && opts.method) || 'GET');
		return theme instanceof Error ? Promise.reject(theme) : Promise.resolve(theme);
	};
	global.window = { location: { replace: url => replaced.push(url) } };
	UI.menu = { load: () => menu ? Promise.resolve(menu) : Promise.reject(new Error('menu failed')) };
	REPLIES['system board'] = () => { asked.push('board'); return Promise.resolve({}); };
	try {
		const out = await Promise.race([ Object.create(view).load().then(() => 'dashboard'), new Promise(r => setTimeout(() => r('waiting'), 100)) ]);
		return { out, replaced, probes, asked };
	} finally {
		global.L = saved.L;
		global.fetch = saved.fetch;
		if (saved.window === undefined) delete global.window; else global.window = saved.window;
		UI.menu = saved.menu;
		delete REPLIES['system board'];
	}
}

test('another theme: load() decides before the dashboard asks for anything', async () => {
	const stays = { out: 'dashboard', replaced: [], asked: [ 'board' ] };
	const pick = r => ({ out: r.out, replaced: r.replaced, asked: r.asked });

	/* Vantage in use: no probe at all */
	let r = await openDashboard('/luci-static/vantage', SCRIPT, menuWith(node(true)));
	assert.deepEqual(pick(r), stays);
	assert.deepEqual(r.probes, [], 'nothing asked under Vantage');

	/* another theme with Vantage's installed: replaced, nothing of the dashboard loaded */
	r = await openDashboard('/luci-static/argon', SCRIPT, menuWith(node(true)));
	assert.deepEqual(pick(r), { out: 'waiting', replaced: [ '/cgi-bin/luci/admin/status/dashboard' ], asked: [] });
	assert.deepEqual(r.probes, [ 'HEAD' ]);
	r = await openDashboard('/luci-static/argon', SCRIPT, menuWith(null));
	assert.deepEqual(pick(r), { out: 'waiting', replaced: [ '/cgi-bin/luci/admin/status/overview' ], asked: [] }, 'no luci-mod-dashboard');
	r = await openDashboard('/luci-static/argon', SCRIPT, menuWith(node(false)));
	assert.deepEqual(r.replaced, [ '/cgi-bin/luci/admin/status/overview' ], 'luci-mod-dashboard, but not for this user');
	r = await openDashboard('/luci-static/argon', SCRIPT, null);
	assert.deepEqual(r.replaced, [ '/cgi-bin/luci/admin/status/overview' ], 'no menu: the page every LuCI has');
	assert.deepEqual(pick(await openDashboard('/luci-static/argon', SCRIPT, menuWith(null, node(false)))), stays, 'a user without Status -> Overview');

	/* the dashboard only, or no clear answer: the dashboard, as before */
	assert.deepEqual(pick(await openDashboard('/luci-static/argon', NOT_FOUND, menuWith(node(true)))), stays, '404');
	assert.deepEqual(pick(await openDashboard('/luci-static/bootstrap', HTML_200, menuWith(node(true)))), stays, 'an error page with 200');
	assert.deepEqual(pick(await openDashboard('/luci-static/argon', new TypeError('Failed to fetch'), menuWith(node(true)))), stays, 'no answer');
	r = await openDashboard(undefined, SCRIPT, menuWith(node(true)));
	assert.deepEqual([ pick(r), r.probes ], [ stays, [] ], 'no media');
});

test('another theme: the probed file is the theme package\'s alone, the target the app\'s menu entry', () => {
	const ROOT = path.join(__dirname, '..');
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /fetch\(L\.resource\('menu-vantage\.js'\)/);
	assert.ok(fs.existsSync(path.join(ROOT, 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js')), 'luci-theme-vantage ships it');
	assert.ok(!fs.existsSync(path.join(RES, 'menu-vantage.js')), 'luci-app-vantage must not');
	const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'luci-app-vantage/root/usr/share/luci/menu.d/zz-luci-app-vantage.json'), 'utf8'));
	assert.match(src, /var LUCI_DASHBOARD = \[ 'admin', 'status', 'dashboard' \];/);
	assert.equal(menu['admin/status/dashboard'].action.path, 'dashboard/index', 'luci-mod-dashboard\'s page');
	assert.equal(menu['admin/dashboard'].action.path, 'vantage/overview');
});

test('header: model and hostname once each, one of them when it holds the other', () => {
	const id = d => view.identity(d);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: 'example-ax3000' }), [ 'Example AX3000' ]);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: 'AX3000' }), [ 'Example AX3000' ], 'the model holds the hostname');
	assert.deepEqual(id({ model: 'AX3000', hostname: 'ax3000-attic' }), [ 'ax3000-attic' ], 'the hostname holds the model');
	assert.deepEqual(id({ model: 'Example AX3000', hostname: 'attic' }), [ 'Example AX3000', 'attic' ]);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: null }), [ 'Example AX3000' ]);
	assert.deepEqual(id({ model: 'Example AX3000', hostname: '--' }), [ 'Example AX3000', '--' ], 'nothing to compare: both');
});

test('health: the theme\'s refresh dot hears a warning or an error, nothing else', () => {
	const saved = global.document;
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	global.document = { documentElement: root };
	try {
		for (const [ level, want ] of [ [ 'ok', '' ], [ 'warn', 'warn' ], [ 'err', 'err' ], [ 'unknown', '' ], [ 'info', '' ] ]) {
			const self = Object.create(view);
			self.st = { summary: { level, headline: 'x' } };
			self.m = { clients: [], device: {}, wired: false };
			self.el = { orb: {}, headline: { textContent: '' }, subline: { textContent: '' } };
			self.identity = () => [];
			self.paintHead();
			assert.equal(self.el.orb.className, 'vt-orb vt-orb-' + level);
			assert.equal(root.attrs['data-vt-alert'], want, level);
		}
	} finally {
		if (saved === undefined) delete global.document; else global.document = saved;
	}
});

test('live pill: under the Vantage theme only when not live; under another theme always', () => {
	const saved = { L: global.L, document: global.document };
	const pill = () => ({ className: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	const run = (media, st) => {
		global.L = { env: { media } };
		global.document = { hidden: false, documentElement: root };
		const self = Object.create(view);
		self.st = Object.assign({ paused: false, lastErr: null, lastOk: Date.now() }, st);
		self.el = { live: pill(), liveText: { textContent: '' } };
		self.paintLive();
		return [ self.el.live.hidden, self.el.live.className ];
	};
	try {
		assert.deepEqual(run('/luci-static/vantage', {}), [ true, 'vt-livepill vt-live-ok' ], 'the theme\'s poll indicator says it');
		assert.deepEqual(run('/luci-static/vantage', { lastErr: new Error('x') }), [ false, 'vt-livepill vt-live-err' ]);
		assert.equal(root.attrs['data-vt-live'], 'err', 'the theme\'s refresh dot hears it');
		assert.deepEqual(run('/luci-static/vantage/', { paused: true }), [ false, 'vt-livepill vt-live-paused' ]);
		assert.deepEqual(run('/luci-static/bootstrap', {}), [ false, 'vt-livepill vt-live-ok' ]);
	} finally {
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('paused from LuCI\'s indicator: the pill says so (once, under the Vantage theme) and nothing moves', () => {
	const saved = { L: global.L, document: global.document };
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	const anim = () => ({ state: 'running', play() { this.state = 'running'; }, pause() { this.state = 'paused'; } });
	const make = media => {
		global.L = { env: { media } };
		global.document = { hidden: false, documentElement: root };
		const self = Object.create(view);
		const cls = new Set();
		self.st = { paused: false, lastErr: null, lastOk: Date.now() };
		self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
			root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
		self.wireMap = { a: { anims: [ anim(), anim() ] } };
		self.backdrop = { paused: false, pause(on) { this.paused = on; } };
		self.cls = cls;
		return self;
	};
	try {
		POLL.on = false;
		let self = make('/luci-static/vantage');
		self.paintLive();
		assert.equal(self.el.live.className, 'vt-livepill vt-live-paused');
		assert.equal(self.el.live.hidden, true, 'the theme\'s indicator already says Paused');
		assert.equal(self.el.liveText.textContent, 'Paused');
		assert.equal(root.attrs['data-vt-live'], 'paused');
		assert.ok(self.cls.has('vt-still'), 'the status circle stands still');
		assert.deepEqual(self.wireMap.a.anims.map(a => a.state), [ 'paused', 'paused' ], 'the flow dots stop where they are');
		assert.equal(self.backdrop.paused, true, 'the backdrop keeps its last frame');
		POLL.on = true;
		self.paintLive();
		assert.equal(self.el.live.className, 'vt-livepill vt-live-ok');
		assert.ok(!self.cls.has('vt-still'));
		assert.deepEqual(self.wireMap.a.anims.map(a => a.state), [ 'running', 'running' ], 'and go on from there');
		assert.equal(self.backdrop.paused, false);
		POLL.on = false;
		self = make('/luci-static/bootstrap');
		self.paintLive();
		assert.deepEqual([ self.el.live.hidden, self.el.liveText.textContent ], [ false, 'Paused' ], 'another theme: the pill says it');
	} finally {
		POLL.on = true;
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('clients: a pick (filter, quick filter, Wi-Fi or wired) shows the new height at once; a poll keeps the hold', () => {
	const self = Object.create(view);
	let laid = 0;
	self.held = { clients: { h: 6000, since: 1 }, chart: { h: 300, since: 1 } };
	self.paintClients = () => {};
	self.scheduleLayout = () => { laid++; };
	self.el = { filter: { value: '' } };
	self.ui = { kind: 'wired', chip: 'all', filter: '' };
	self.setFilter('phone');
	assert.equal(self.held.clients, undefined, 'released');
	assert.ok(self.held.chart, 'other tiles keep theirs');
	assert.equal(laid, 1);
	self.held.clients = { h: 6000, since: 1 };
	self.pickClients();
	assert.equal(self.held.clients, undefined);
	/* the Wi-Fi/Wired switch and the quick filters go through pickClients */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /ui\.kind = k\[0\]; ui\.chip = 'all'; self\.pickClients\(\);/);
	assert.match(src, /ui\.chip = d\[0\]; self\.filterMenu\(false\); self\.pickClients\(\);/);
	assert.match(src, /'input': function\(ev\) \{ self\.ui\.filter = ev\.target\.value; self\.pickClients\(\); \}/);
});

test('deep links: moving from an open drawer to a client names the client', () => {
	const self = Object.create(view);
	self.ui = { drawer: { kind: 'radio', id: 'radio1' } };
	self.el = { drawer: { hidden: false } };
	let painted = 0;
	self.paintDrawer = () => { painted++; };
	self.paintClients = () => {};
	const cleared = withLocation('#radio=radio1', c => { self.openDrawer('client', '00:00:5e:00:53:21'); return c; });
	assert.deepEqual(cleared, [ '#client=00%3A00%3A5e%3A00%3A53%3A21' ]);
	assert.deepEqual(self.ui.drawer, { kind: 'client', id: '00:00:5e:00:53:21' });
	assert.equal(painted, 1);
});

/* a tree of { tag, attrs, children } from E() stubs, as text and classes */
function withDom(fn) {
	const saved = { E: global.E, document: global.document };
	const node = () => ({ setAttribute() {}, appendChild() {}, style: { setProperty() {} } });
	global.document = { createElementNS: node };
	global.E = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: [].concat(children == null ? [] : children), style: { setProperty() {} },
		classList: { add() {}, remove() {}, toggle() {} }, appendChild(c) { this.children.push(c); return c; } });
	try { return fn(); }
	finally {
		if (saved.E === undefined) delete global.E; else global.E = saved.E;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
}
const texts = n => n == null || n === '' ? [] : typeof n === 'string' ? [ n ] : n.children ? n.children.flatMap(texts) : [];
const classes = n => n && typeof n === 'object' && n.children ? [ n.attrs && n.attrs['class'] ].concat(n.children.flatMap(classes)).filter(Boolean) : [];

test('names made up from the MAC: the plain name beside the MAC, no source badge; one line keeps the octets', () => {
	const self = Object.create(view);
	const priv = { mac: '02:00:5e:00:53:11', macLabel: '02:00:5E:00:53:11', name: 'Private device 53:11', plainName: 'Private device',
		nameSource: 'private', nameSourceLabel: 'Private', secondary: '02:00:5E:00:53:11', icon: 'phone' };
	const named = Object.assign({}, priv, { name: 'phone', plainName: 'phone', nameSource: 'dhcp', nameSourceLabel: 'DHCP', secondary: '192.0.2.44' });
	withDom(() => {
		const row = self.whoCell(priv, []);
		assert.deepEqual(texts(row), [ 'Private device', '02:00:5E:00:53:11' ]);
		assert.ok(!classes(row).some(c => /vt-src/.test(c)), 'no PRIVATE badge');
		/* an address as the second line: the octets stay to tell it apart */
		assert.deepEqual(texts(self.whoCell(Object.assign({}, priv, { secondary: '192.0.2.50' }), [])), [ 'Private device 53:11', '192.0.2.50' ]);
		const who = self.drawerWho(priv);
		assert.deepEqual(texts(who[1]), [ 'Private device', '02:00:5E:00:53:11' ]);
		/* a real name keeps its source */
		assert.deepEqual(texts(self.whoCell(named, [])), [ 'phone', 'DHCP', '192.0.2.44' ]);
		assert.deepEqual(texts(self.drawerWho(named)[1]), [ 'phone', 'DHCP', '192.0.2.44' ]);
	});
});

/* other lines to the internet (#88): failover and mwan3 lines beside the main one */
const LINE = (iface, dev, metric) => ({ iface, l3dev: dev, dev, statsDev: dev, port: dev, proto: 'dhcp', up: true, carrier: true, speed: { mbps: 1000, duplex: 'full' },
	ipv4: [ '203.0.113.' + (metric + 2) + '/29' ], ipv6: [], gateway: '203.0.113.' + (metric + 1), defaultRoute: true, metric, dns: [], stats: { rx_bytes: 10, tx_bytes: 20 }, isWan: true, uptime: 60 });

test('other lines: in the path\'s key, one chart row each, every line\'s history by its interface', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10);
	self.m = { wired: true, networks: [ { name: 'lan', up: true } ], radios: [ { id: 'radio0', bandLabel: '5 GHz' } ], ssids: [], wiredHosts: [], uplink: wan, uplinks: [ wan ] };
	const one = self.heroKey();
	assert.deepEqual(self.extraLines(), []);
	assert.deepEqual(self.chartSeries().map(s => s.key), [ 'up:wan', 'radio0' ]);
	self.m.uplinks = [ wan, LINE('wanb', 'eth2', 20) ];
	assert.notEqual(self.heroKey(), one, 'a line that comes or goes rebuilds the path');
	assert.deepEqual(self.chartSeries().map(s => [ s.key, s.label, s.dn, s.up ]), [
		[ 'up:wan', 'Uplink eth1', 1, 2 ], [ 'up:wanb', 'Uplink eth2', 1, 2 ], [ 'radio0', '5 GHz radio', 2, 1 ] ]);
	self.m.wired = false;
	assert.match(self.heroKey(), /lines=wanb$/);
	/* the model caps the lines (model.MAX_LINES); no line: an empty row */
	assert.deepEqual(self.extraLines({ uplinks: null }), []);
	self.m.uplink = null;
	self.m.uplinks = [];
	assert.deepEqual(self.chartSeries().map(s => s.key), [ 'uplink', 'radio0' ]);
});

test('other lines: a deep link opens a line the device has, the main one by its name too; any other name opens the main one', () => {
	const at = (hash, uplinks) => {
		const self = Object.create(view);
		self.m = { radios: [], uplinks };
		self.opened = [];
		self.openDrawer = function(kind, id) { this.opened.push([ kind, id ]); };
		withLocation(hash, () => self.openFromHash());
		return self.opened;
	};
	const lines = [ LINE('wan', 'eth1', 10), LINE('wanb', 'eth2', 20) ];
	assert.deepEqual(at('#uplink=wanb', lines), [ [ 'uplink', 'wanb' ] ]);
	assert.deepEqual(at('#uplink=wan', lines), [ [ 'uplink', 'wan' ] ], 'the main line by its own name: that interface');
	assert.deepEqual(at('#uplink', lines), [ [ 'uplink', '' ] ]);
	assert.deepEqual(at('#uplink=%3Cb%3Ewanb', lines), [ [ 'uplink', '' ] ]);
	assert.deepEqual(at('#uplink=wanb', lines.slice(0, 1)), [ [ 'uplink', '' ] ], 'a line that is gone');
	/* the main line has an id no interface can have */
	const self = Object.create(view);
	self.ui = {};
	self.el = { drawer: { hidden: false } };
	self.paintDrawer = () => {};
	self.paintClients = () => {};
	assert.deepEqual(withLocation('', c => { self.openDrawer('uplink', ''); self.openDrawer('uplink', 'uplink'); return c; }), [ '#uplink', '#uplink=uplink' ]);
});

test('other lines: each node shows its name, gateway and live rates, wired into the device; the main one is marked', () => {
	const self = Object.create(view);
	const el = () => ({ textContent: '', attrs: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
	const ln = id => ({ id, el: el(), kicker: el(), title: el(), dn: el(), up: el() });
	const wan = LINE('wan', 'eth1', 10), wanb = LINE('wanb', 'eth2', 20), lte = Object.assign(LINE('lte', 'wwan0', 30), { gateway: null, carrier: false, speed: null });
	const h = new Proxy({ lines: [ ln('wanb'), ln('lte'), ln('gone') ], radios: [] }, { get: (t, k) => k in t ? t[k] : (t[k] = el()) });
	self.hero = h;
	self.m = { wired: true, networks: [], radios: [], ssids: [], wiredHosts: [], device: { model: 'Router', uptime: 1 }, uplink: wan, uplinks: [ wan, wanb, lte ] };
	self.st = { uplinkRate: { rx: 2e6, tx: 1e5 }, devRates: { eth2: { rx: 12345678, tx: 3000 }, wwan0: { rx: 0, tx: 0 } } };
	self.updateHero();
	assert.equal(h.gwKicker.textContent, 'wan', 'beside other lines the main one goes by its name');
	const [ b, l ] = h.lines;
	assert.deepEqual([ b.kicker.textContent, b.title.textContent, b.dn.textContent, b.up.textContent ], [ 'wanb', '203.0.113.21', '↓ 12.3 Mbit/s', '↑ 3 kbit/s' ]);
	assert.equal(b.el.attrs.title, 'wanb · eth2 · 1 Gbit/s · full duplex');
	assert.equal(b.el.attrs['class'], 'vt-node vt-node-gw vt-node-line');
	assert.deepEqual([ l.title.textContent, l.dn.textContent, l.up.textContent ], [ 'wwan0', 'idle', '' ], 'no gateway address: the device; nothing moving: idle');
	assert.equal(l.el.attrs['class'], 'vt-node vt-node-gw vt-node-line vt-node-off', 'no carrier');
	assert.deepEqual([ b.active, l.active ], [ true, false ]);
	/* one wire per line into the device, numbered for nesting */
	assert.deepEqual(self.wireList().filter(w => w.line != null).map(w => [ w.key, w.from === h.lines[w.line].el, w.to === h.ap, w.speed ]),
		[ [ 'l:wanb', true, true, 2 ], [ 'l:lte', true, true, 1 ], [ 'l:gone', true, true, 1 ] ]);
	/* one line: the gateway's own kicker */
	h.lines = [];
	self.m.uplinks = [ wan ];
	self.updateHero();
	assert.equal(h.gwKicker.textContent, 'Internet');
});

test('no Wi-Fi: the path has the Wired branch too, even beside a network called wired (#98)', t => {
	const self = Object.create(view);
	const host = (mac, port, extra) => Object.assign({ mac: '00:00:5e:00:53:' + mac, name: mac, nameSource: 'mac', port, shared: false, speed: null, gateway: false }, extra);
	const wan = LINE('wan', 'eth1', 10);
	const hosts = [ host('01', 'lan5'), host('02', 'lan5'), host('03', 'lan5'), host('04', 'lan6'), host('05', 'eth1', { gateway: true }) ];
	self.m = { wired: true, networks: [ { name: 'lan', proto: 'static', dev: 'br-lan', up: true, ipv4: '192.0.2.1/24' }, { name: 'wired', dev: 'br-wired', up: true } ],
		radios: [], ssids: [], wiredHosts: hosts, device: { model: 'Router', uptime: 1 }, uplink: wan, uplinks: [ wan ] };
	self.st = { uplinkRate: null, devRates: { lan5: { rx: 1000, tx: 3000 }, 'br-lan': { rx: 1, tx: 2 } } };
	const nodes = [];
	self.el = { path: { childNodes: [], classList: { toggle() {} }, setAttribute() {}, getAttribute() { return null; }, insertBefore(c) { nodes.push(c); return c; } }, wires: {}, flows: {} };
	const key = self.heroKey();
	assert.match(key, /\nwired=lan5,lan6\n/);
	const savedL = global.L;
	global.L = { url: () => '/network' };
	t.after(() => { if (savedL === undefined) delete global.L; else global.L = savedL; });
	withDom(() => {
		const bare = global.E;
		global.E = (...args) => Object.assign(bare(...args), { getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; } });
		self.buildHeroNodes(key);
		const h = self.hero;
		assert.deepEqual(h.radios.map(b => b.id), [ 'lan', 'wired', ':wired' ], 'beside the networks, and not mistaken for one');
		const b = h.radios[2];
		assert.deepEqual(b.ssids.map(sn => sn.port), [ 'lan5', 'lan6' ]);
		self.updateHero();
		assert.equal(b.title.textContent, '4 devices', 'the hosts on its ports, not the gateway');
		assert.deepEqual(b.ssids.map(sn => [ sn.name.textContent, sn.count.textContent ]), [ [ 'lan5', '3 devices' ], [ 'lan6 · 04', '—' ] ], 'one host alone on a port goes by its name');
		assert.equal(h.radios[0].title.textContent, 'lan', 'the networks still fill in');
		const keys = self.wireList().map(w => w.key);
		assert.equal(new Set(keys).size, keys.length, 'one wire per key');
		assert.ok(keys.includes('r:wired') && keys.includes('r::wired') && keys.includes('s::wired:port:lan6'));
	});
	/* a port that comes or goes rebuilds the path */
	hosts.push(host('06', 'lan7'));
	assert.notEqual(self.heroKey(), key);
});

test('other lines: the uplink drawer shows the line asked for, its rates and route metric', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10), wanb = LINE('wanb', 'eth2', 20);
	self.m = { uplink: wan, uplinks: [ wan, wanb ] };
	self.st = { uplinkRate: { rx: 1e6, tx: 2e6 }, devRates: { eth2: { rx: 3e6, tx: 4e6 } }, hist: { net: { uplink: [], 'up:wanb': [] } } };
	withDom(() => {
		const d = self.drawerUplink('wanb'), all = texts({ children: d.title.concat(d.body) });
		assert.ok(all.includes('Uplink · wanb'));
		assert.ok(all.includes('3 Mbit/s') && all.includes('4 Mbit/s'), 'its own rates');
		assert.deepEqual(all.slice(all.indexOf('Route metric'), all.indexOf('Route metric') + 2), [ 'Route metric', '20' ]);
		const main = texts({ children: [].concat(self.drawerUplink('').title, self.drawerUplink('').body) });
		assert.ok(main.includes('Uplink · wan') && main.includes('1 Mbit/s') && main.includes('10'));
		/* a backup named "uplink" is that backup, not the main line */
		const named = LINE('uplink', 'eth3', 30);
		self.m.uplinks = [ wan, named ];
		assert.ok(texts({ children: self.drawerUplink('uplink').title }).includes('Uplink · uplink'));
		assert.ok(texts({ children: self.drawerUplink('').title }).includes('Uplink · wan'));
		/* failover: wanb is the main line now, its drawer still wanb's, at the fast lane's rate */
		self.m = { uplink: wanb, uplinks: [ wanb ] };
		const now = texts({ children: [].concat(self.drawerUplink('wanb').title, self.drawerUplink('wanb').body) });
		assert.ok(now.includes('Uplink · wanb') && now.includes('1 Mbit/s'));
		/* wan is down: said so under its own name, not wanb's details */
		const gone = texts({ children: [].concat(self.drawerUplink('wan').title, self.drawerUplink('wan').body) });
		assert.deepEqual(gone.filter(t => /Uplink|down/.test(t)), [ 'Uplink · wan', 'This line is down or has no default route now.' ]);
		assert.ok(!gone.some(t => /wanb|eth2/.test(t)));
		/* one line: no metric row */
		self.m.uplinks = [ wanb ];
		assert.ok(!texts({ children: self.drawerUplink('').body }).includes('Route metric'));
	});
});

test('stored history: it belongs to one login', () => {
	const savedWindow = global.window, savedL = global.L, box = {};
	const hist = sid => JSON.stringify({ sid, cpu: [ [ 1, 2 ], [ 3, 4 ] ], clients: { '00:00:5E:00:53:01': [ [ 1, 2 ] ] } });
	global.window = {
		sessionStorage: { getItem: () => box.v || null, setItem(k, v) { box.v = v; } },
		localStorage: { getItem: () => null, setItem() {} }
	};
	global.L = { env: { sessionid: '0123456789abcdef0123456789abcdef' } };
	const load = () => { const self = Object.create(view); self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null }); return self; };
	const now = Date.now();
	try {
		box.v = hist('89abcdef').replace('[[1,2],[3,4]]', JSON.stringify([ [ now - 2000, 2 ], [ now - 1000, 4 ] ]));
		assert.equal(load().st.hist.cpu.length, 2, 'the same login keeps its history');
		box.v = hist('ffffffff');
		const other = load();
		assert.equal(other.st.hist.cpu.length, 0, 'another login starts empty');
		assert.deepEqual(Object.keys(other.st.clientHist), []);
	} finally {
		global.window = savedWindow;
		global.L = savedL;
	}
});

test('other lines: a failover starts the new main line on its own history; a restored "uplink" of nobody is dropped', () => {
	const saved = global.window, savedL = global.L;
	const box = {};
	global.L = { env: {} };
	global.window = {
		sessionStorage: { getItem: () => box.v || null, setItem(k, v) { box.v = v; } },
		localStorage: { getItem: () => null, setItem() {} }
	};
	const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'eth1', l3_device: 'eth1', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
	const wanb = { ...wan, interface: 'wanb', device: 'eth2', l3_device: 'eth2', metric: 20, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.9' } ] };
	const raw = (t, ifaces) => ({ at: t, info: { localtime: t / 1000 }, stat: '', ifaces, wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
		devs: { eth1: { statistics: { rx_bytes: t * 10, tx_bytes: t } }, eth2: { statistics: { rx_bytes: t * 3, tx_bytes: t } } } });
	try {
		box.v = JSON.stringify({ net: { uplink: [ [ 1, 2, 3 ] ], 'up:wan': [ [ 1, 2, 3 ] ] } });
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		assert.deepEqual(Object.keys(self.st.hist.net), [ 'up:wan' ], 'whose "uplink" it was is unknown');
		self.st.hist.net['up:wan'] = [];
		const t0 = 1.8e12;
		for (let k = 0; k < 4; k++) self.ingest(raw(t0 + k * 5000, [ wan, wanb ]));
		const net = self.st.hist.net;
		assert.deepEqual([ net['up:wan'].length, net['up:wanb'].length ], [ 3, 3 ]);
		assert.equal(net['up:wan'][2][1], 5000 * 10 * 8 / 5, 'wan\'s own rate');
		/* wan fails: wanb is the main line and goes on in its own history */
		for (let k = 4; k < 6; k++) self.ingest(raw(t0 + k * 5000, [ wanb ]));
		assert.equal(self.m.uplink.iface, 'wanb');
		assert.deepEqual([ net['up:wan'].length, net['up:wanb'].length ], [ 3, 5 ]);
		assert.ok(net['up:wanb'].every(p => p[1] === 5000 * 3 * 8 / 5), 'wanb\'s rate only');
		assert.deepEqual(self.chartSeries().map(s => s.key), [ 'up:wanb' ]);
		/* gone longer than the chart shows: no history left */
		self.ingest(raw(t0 + 6 * 5000 + 5 * 60 * 1000, [ wanb ]));
		assert.ok(!('up:wan' in net));
		assert.ok(!('uplink' in JSON.parse(box.v).net));
	} finally {
		global.window = saved;
		global.L = savedL;
	}
});

test('other lines: hosts on a backup line\'s port are the way to its gateway, not wired clients', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10), wanb = Object.assign(LINE('wanb', 'br-lan.20', 20), { dev: 'lan4', statsDev: 'lan4', port: 'lan4' });
	self.m = { uplink: wan, uplinks: [ wan, wanb ], wiredHosts: [ { mac: '00:00:5e:00:53:c9', port: 'lan4' }, { mac: '00:00:5e:00:53:c1', port: 'lan1' } ] };
	assert.deepEqual(self.wiredPorts(), [ 'lan1' ]);
	assert.deepEqual([ self.linePort('lan4'), self.linePort('lan1'), self.linePort(null) ], [ true, false, false ]);
	/* the backup's port unknown (the VLAN's own counters): nothing left out */
	wanb.port = null;
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan4' ]);
});

test('nothing moves while another window has the focus or Low-power router is on; the numbers go on', () => {
	const saved = { L: global.L, document: global.document };
	let power = 'normal';
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'data-vt-power' ? power : null; } };
	global.L = { env: { media: '/luci-static/vantage' } };
	global.document = { hidden: false, documentElement: root };
	const cls = new Set();
	const self = Object.create(view);
	self.st = { paused: false, lastErr: null, lastOk: Date.now() };
	self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
		root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
	self.backdrop = { paused: false, pause(on) { this.paused = on; } };
	try {
		POLL.on = true;
		self.paintLive();
		assert.ok(!cls.has('vt-still'));
		self.focused = false;
		self.paintLive();
		assert.ok(cls.has('vt-still'), 'another window has the focus');
		assert.equal(self.el.live.className, 'vt-livepill vt-live-ok', 'still live');
		self.focused = true;
		self.paintLive();
		assert.ok(!cls.has('vt-still'));
		power = 'low';
		self.paintLive();
		assert.ok(cls.has('vt-still'), 'Low-power router');
		assert.equal(self.backdrop.paused, true);
	} finally {
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});


test('Low-power router: the same still picture as reduced motion, no backdrop, and back with the pick kept', () => {
	const saved = { L: global.L, document: global.document };
	let power = 'low';
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'data-vt-power' ? power : null; } };
	global.L = { env: { media: '/luci-static/vantage' } };
	global.document = { hidden: false, documentElement: root };
	const cls = new Set(), styles = [];
	const self = Object.create(view);
	self.st = { paused: false, lastErr: null, lastOk: Date.now() };
	self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
		root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
	self.backdrop = { paused: false, pause(on) { this.paused = on; }, style(v) { styles.push(v); } };
	self.backdropStyle = 'stars';
	let wired = 0;
	self.paintWireState = () => { wired++; };
	try {
		POLL.on = true;
		self.applyPower();
		assert.ok(cls.has('vt-low') && cls.has('vt-still'));
		assert.deepEqual(styles.splice(0), [ 'none' ], 'no backdrop');
		assert.equal(wired, 1, 'the wires redrawn without flow dots');
		self.showBackdrop('grid');
		assert.deepEqual(styles.splice(0), [ 'none' ], 'a new pick waits');
		power = 'normal';
		self.applyPower();
		assert.ok(!cls.has('vt-low') && !cls.has('vt-still'));
		assert.deepEqual(styles, [ 'grid' ], 'the pick back');
	} finally {
		global.L = saved.L;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('polls: the fast lane is registered before the full poll (#101: no second full poll on load)', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const fast = src.indexOf('poll.add(L.bind(this.refreshFast, this), FAST_S);'), full = src.indexOf('poll.add(L.bind(this.refresh, this), POLL_S);');
	assert.ok(fast > 0 && full > fast);
	assert.ok(src.indexOf('this.inputAt = this.fullAt = Date.now();') > 0 && src.indexOf('this.inputAt = this.fullAt = Date.now();') < fast, 'load() counts as the last full poll');
});

test('Low-power router: after 5 minutes without input, the full poll every 30 s and no fast lane; the next input is live at once', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let power = 'low', t = 1e12, reads = 0;
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? power : null, setAttribute() {} } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d), env: {} };
	REPLIES['file read'] = () => { reads++; return Promise.resolve({ data: '' }); };
	const self = Object.create(view);
	let fetches = 0;
	self.fetch = () => { fetches++; return Promise.resolve({}); };
	self.ingest = () => {}; self.paint = () => {}; self.paintLive = () => {};
	self.st = { lastOk: t, paused: false };
	self.el = {};
	self.m = { uplink: null };
	self.inputAt = t;
	try {
		t += 60e3;
		await self.refresh(); await self.refreshFast();
		assert.deepEqual([ fetches, reads ], [ 1, 1 ], 'watched: as always');
		t += 5 * 60e3;
		assert.equal(self.idle(), true);
		await self.refreshFast();
		assert.equal(reads, 1, 'idle: no fast lane');
		await self.refresh();
		assert.equal(fetches, 2, 'the first idle poll');
		t += 5e3; await self.refresh();
		t += 20e3; await self.refresh();
		assert.equal(fetches, 2, 'not within 30 s');
		t += 6e3; await self.refresh();
		assert.equal(fetches, 3, 'every 30 s');
		t += 4e3;
		self.noteInput();
		assert.equal(fetches, 4, 'input: at once');
		assert.equal(self.idle(), false);
		await self.refreshFast();
		assert.equal(reads, 2, 'and the fast lane again');
		power = 'normal';
		t += 60 * 60e3;
		assert.equal(self.idle(), false, 'never idle when Low-power router is off');
	} finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		delete REPLIES['file read'];
	}
});

/* the full poll: one at a time, 2 s from the last one's start, idle (Low-power
   router) every 30 s, a clock stepped back as time gone; input while LuCI's
   refresh is paused asks nothing */
test('refresh: one at a time, spaced from the start, survives a clock step, input asks only while LuCI polls', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, power = 'normal', release = null, fetches = 0;
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? power : null } };
	global.L = { env: {} };
	const self = Object.create(view);
	self.fetch = () => { fetches++; return new Promise(r => { release = r; }); };
	self.ingest = () => {}; self.paint = () => {}; self.paintLive = () => {};
	self.st = { lastOk: t, paused: false };
	self.inputAt = self.fullAt = t;
	const done = async () => { release({}); await new Promise(r => setImmediate(r)); };
	try {
		t += 1e3; self.refresh();
		assert.equal(fetches, 0, 'within 2 s of load()');
		t += 4e3; self.refresh();
		assert.equal(fetches, 1);
		t += 5e3; self.refresh();
		assert.equal(fetches, 1, 'one at a time');
		t += 1e3; await done();
		t += 1e3; self.refresh();
		assert.equal(fetches, 2, 'a slow fetch: spaced from its start, not its end');
		await done();
		t -= 3600e3; self.refresh();
		assert.equal(fetches, 3, 'a clock stepped back an hour: not stopped');
		await done();
		/* hidden, then shown within the idle spacing: not "Paused while hidden" */
		power = 'low'; self.inputAt = t - 10 * 60e3;
		t += 30e3; self.refresh(); await done();
		global.document.hidden = true; self.refresh();
		assert.equal(self.st.paused, true);
		global.document.hidden = false; t += 5e3; self.refresh();
		assert.equal(self.st.paused, false, 'shown again: not paused, though the idle spacing holds the fetch');
		/* LuCI's refresh paused: input asks nothing; resumed: it does */
		const n = fetches;
		POLL.on = false; t += 60e3; self.noteInput();
		assert.equal(fetches, n, 'paused from its indicator');
		self.inputAt = t - 10 * 60e3; POLL.on = true; self.noteInput();
		assert.equal(fetches, n + 1);
		await done();
	} finally {
		POLL.on = true;
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
});

test('Low-power router: a failed slow reply is asked again at the next poll; a radio read from the config keeps iwinfo on every interface', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, fail = true;
	const count = {};
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? 'low' : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const cnt = k => { count[k] = (count[k] || 0) + 1; };
	REPLIES['luci.vantage wireless'] = () => { cnt('wifi'); return fail ? Promise.reject(new Error('timeout')) : Promise.resolve({ radio0: { source: 'config', config: {}, interfaces: [ { ifname: 'ra0', config: {} }, { ifname: 'ra1', config: {} } ] } }); };
	REPLIES['luci.vantage thermal'] = () => { cnt('thermal'); return Promise.resolve([]); };
	REPLIES['luci.vantage wired'] = () => { cnt('wired'); return Promise.resolve({ hosts: [] }); };
	REPLIES['iwinfo info'] = d => { cnt('iw ' + d); return Promise.resolve({ channel: 36 }); };
	REPLIES['hostapd.ra0 get_status'] = () => Promise.resolve({ bssid: '00:00:5e:00:53:a0' });
	REPLIES['hostapd.ra1 get_status'] = () => Promise.resolve({ bssid: '00:00:5e:00:53:a1' });
	const self = Object.create(view);
	try {
		const first = await self.fetch();
		assert.equal(first.wifi, null, 'no answer is not "no radios"');
		t += 5e3; await self.fetch();
		assert.equal(count.wifi, 2, 'asked again at once, not kept for 30 s');
		fail = false;
		t += 5e3; await self.fetch();
		t += 5e3; await self.fetch();
		assert.equal(count.wifi, 3, 'an answer is kept');
		t += 30e3; await self.fetch();
		t += 30e3; await self.fetch();
		assert.deepEqual([ count['iw ra0'], count['iw ra1'] ], [ 3, 3 ], 'from the config: each interface says whether it is up');
	} finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|iwinfo info|hostapd\.)/.test(k)) delete REPLIES[k];
	}
});

test('#110: the weak filter leaves quiet stations out, as the card does; the quiet row keeps its error and busy state across rebuilds', async () => {
	const self = Object.create(view);
	self.quiet = { '00:00:5e:00:53:01': true };
	self.ui = { chip: 'weak', filter: '' };
	self.st = { staRates: {} };
	const far = { mac: '00:00:5e:00:53:01', signal: -84, name: 'Far' }, near = { mac: '00:00:5e:00:53:02', signal: -80, name: 'Near' };
	assert.equal(self.isWeak(far), false);
	assert.equal(self.isWeak(near), true);
	assert.equal(self.matches(far), false);
	assert.equal(self.matches(near), true);
	self.canWrite = true;
	self.loadAliases = () => Promise.resolve({});
	let painted = 0;
	self.rehealth = () => { painted++; };
	REPLIES['luci.vantage set_quiet'] = () => Promise.resolve({ ok: false, error: 'too-many' });
	const savedL = global.L;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
	try {
		const busy = self.saveQuiet(near.mac, true);
		assert.equal(await self.saveQuiet(near.mac, true), false, 'one save at a time');
		await busy;
		assert.equal(painted, 1);
		assert.match(self.quietSaid['00:00:5e:00:53:02'], /already keeps 512/, 'the error waits for the rebuilt row');
		assert.ok(!self.quietBusy['00:00:5e:00:53:02']);
	} finally {
		global.L = savedL;
		delete REPLIES['luci.vantage set_quiet'];
	}
});

test('#110: the quiet row, once shown for a station, stays while its signal crosses the line', () => {
	const self = Object.create(view);
	const shown = [];
	self.quietRow = c => { shown.push(c.signal); return 'row'; };
	const body = c => {
		const quietOn = !!(self.quiet && self.quiet[c.mac]);
		if (quietOn || (c.signal != null && c.signal < insight.WEAK_DBM)) self.quietShown = c.mac;
		return !c.gone && (quietOn || self.quietShown === c.mac) ? self.quietRow(c, quietOn) : '';
	};
	/* the same rule as drawerClient, read from the source */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes("if (quietOn || (c.signal != null && c.signal < insight.WEAK_DBM)) this.quietShown = c.mac;"));
	assert.ok(src.includes("var quietRow = !c.gone && (quietOn || this.quietShown === c.mac) ? this.quietRow(c, quietOn) : '';"));
	const insight = load('vantage.insight');
	assert.equal(body({ mac: 'a', signal: -70 }), '', 'never weak: no row');
	assert.equal(body({ mac: 'a', signal: -80 }), 'row');
	assert.equal(body({ mac: 'a', signal: -70 }), 'row', 'kept');
	assert.equal(body({ mac: 'b', signal: -60 }), '', 'another station: its own rule');
});

test('#110: a rebuilt quiet row shows the last attempt\'s error and stays disabled while a save is under way', () => {
	const saved = { E: global.E };
	global.E = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: [].concat(children == null ? [] : children), addEventListener() {} });
	try {
		const self = Object.create(view);
		self.canWrite = true;
		const mac = '00:00:5e:00:53:02';
		self.quietSaid = { [mac]: 'The device could not write /etc/config/vantage.' };
		self.quietBusy = { [mac]: true };
		const row = self.quietRow({ mac: mac.toUpperCase() }, false);
		const [ box, , err ] = row.children;
		assert.equal(box.disabled, true, 'busy: disabled');
		assert.equal(box.checked, false);
		assert.deepEqual(err.children, [ 'The device could not write /etc/config/vantage.' ]);
		self.canWrite = false;
		assert.equal(self.quietRow({ mac }, false), '', 'no grant, not set: nothing');
	} finally {
		if (saved.E === undefined) delete global.E; else global.E = saved.E;
	}
});
