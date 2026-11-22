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

function loadView(dom) {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args) when set */
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: POLL, ui: UI, dom: dom || {}
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

/* iwinfo info costs the router 15-22 ms an interface: asked for a radio's
   first interface, and for another only until hostapd gives its BSSID;
   each reading stands for 30 s, unless the interface's state moves (its
   channel in hostapd's status, its radio in luci.vantage wireless) */
test('iwinfo info: once a radio, and for a network hostapd does not answer for; kept 30 s unless the state moves', async () => {
	const asked = [], hapdOff = new Set(), chan = {};
	let radioUp = true;
	const ifc = (ifname, mode) => ({ ifname, section: ifname, config: { mode: mode || 'ap', ssid: 'S-' + ifname } });
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({
		radio0: { up: true, config: { band: '2g' }, interfaces: [ ifc('wl0'), ifc('wl0-1'), ifc('wl0-sta', 'sta') ] },
		radio1: { up: radioUp, config: { band: '5g' }, interfaces: [ ifc('wl1') ] }
	});
	REPLIES['iwinfo info'] = device => { asked.push(device); return Promise.resolve({ channel: 6, bssid: '00:00:5E:00:53:0' + device.length }); };
	for (const ifn of [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ])
		REPLIES['hostapd.' + ifn + ' get_status'] = () => (ifn === 'wl0-sta' || hapdOff.has(ifn)) ? Promise.reject(new Error('not found')) : Promise.resolve({ bssid: '00:00:5e:00:53:a' + ifn.length, ssid: 'S-' + ifn, channel: chan[ifn] || 1 });
	const self = Object.create(view);
	const savedL = global.L, now = Date.now;
	let t = 1e12;
	Date.now = () => t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const poll = async ms => { t += ms; return self.fetch(); };
	try {
		let r = await poll(0);
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-1', 'wl0-sta', 'wl1' ], 'the first poll asks every interface');
		r = await poll(5e3);
		assert.deepEqual(asked.splice(0), [], 'then nothing for 30 s');
		assert.equal(r.iwinfo.wl0.channel, 6, 'the reading stands');
		assert.equal(r.hapdStatus['wl0-1'].bssid, '00:00:5e:00:53:a5', 'its BSSID comes from hostapd');
		assert.equal(r.iwinfo['wl0-1'], undefined, 'and not from its first poll\'s iwinfo, kept');
		assert.equal(r.iwinfo['wl0-sta'].channel, 6, 'one hostapd does not serve keeps its reading');
		await poll(25e3);
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-sta', 'wl1' ], 'after 30 s: a radio\'s first, and the one hostapd does not serve');
		/* hostapd reports wl1 on another channel: asked at the next poll */
		chan.wl1 = 44;
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [], 'the new status is this poll\'s');
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [ 'wl1' ], 'the channel moved: wl1 again');
		/* its radio goes down: asked at once */
		radioUp = false;
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [ 'wl1' ], 'the radio went down: wl1 again');
		await poll(5e3);
		assert.deepEqual(asked.splice(0), [], 'and kept again');
		hapdOff.add('wl0-1');
		await poll(5e3);
		await poll(5e3);
		/* 30 s have passed for wl0 and wl0-sta as well */
		assert.deepEqual(asked.splice(0).sort(), [ 'wl0', 'wl0-1', 'wl0-sta' ], 'hostapd gone quiet: asked again');
	}
	finally {
		global.L = savedL; Date.now = now;
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
	reply('luci.vantage survey', [ { mhz: 2437, noise: -110 } ]);
	reply('iwinfo survey', [ { mhz: 2437, noise: 146 } ]);
	reply('hostapd.wl0 get_clients', { clients: {} });
	reply('hostapd.wl0 get_status', { bssid: '00:00:5e:00:53:aa' });
	reply('system info', {});
	const self = Object.create(view);
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, power = 'low';
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: n => n === 'data-vt-power' ? power : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const slowKeys = [ 'luci.vantage wireless', 'luci.vantage thermal', 'luci.vantage wired', 'luci.vantage survey', 'hostapd.wl0 get_clients' ];
	const slowCount = () => slowKeys.map(k => count[k] || 0);
	try {
		const first = await self.fetch();
		assert.deepEqual(slowCount(), [ 1, 1, 1, 1, 1 ]);
		t += 10e3;
		const kept = await self.fetch();
		assert.deepEqual(slowCount(), [ 1, 1, 1, 1, 1 ], 'not again within 30 s');
		assert.equal(count['system info'], 2, 'the rest every poll');
		assert.equal(count['hostapd.wl0 get_status'], 2);
		assert.deepEqual([ kept.wifi, kept.thermal, kept.fdb, kept.iwinfo, kept.hapd, kept.survey ], [ first.wifi, first.thermal, first.fdb, first.iwinfo, first.hapd, first.survey ], 'their last replies');
		assert.equal(count['iwinfo info'], 1);
		t += 20e3;
		await self.fetch();
		assert.deepEqual(slowCount(), [ 2, 2, 2, 2, 2 ], 'again after 30 s');
		assert.equal(count['iwinfo info'], 2);
		power = 'normal';
		t += 1e3;
		const off = await self.fetch();
		assert.deepEqual(slowCount(), [ 3, 3, 3, 3, 3 ], 'off: every poll');
		assert.equal(count['iwinfo info'], 2, 'iwinfo info on its own 30 s');
		assert.deepEqual(off.survey.wl0, [ { mhz: 2437, noise: -110 } ], 'the survey every poll');
		assert.equal(count['iwinfo survey'], undefined, 'never rpcd\'s iwinfo survey, which crashes rpcd on drivers other than nl80211\'s (#124)');
	}
	finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired|survey)|iwinfo (info|survey)|hostapd\.|system info)/.test(k)) delete REPLIES[k];
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

test('health: the theme\'s tab title hears how many checks warn or err, with the level and never without it', () => {
	const saved = global.document;
	const root = { attrs: {}, set: [], setAttribute(k, v) { this.attrs[k] = v; this.set.push(k); } };
	global.document = { documentElement: root };
	const insight = load('vantage.insight');
	const paint = summary => {
		const self = Object.create(view);
		self.st = { summary };
		self.m = { clients: [], device: {}, wired: false };
		self.el = { orb: {}, headline: { textContent: '' }, subline: { textContent: '' } };
		self.identity = () => [];
		root.set = [];
		self.paintHead();
		return [ root.attrs['data-vt-alert'], root.attrs['data-vt-alert-count'] ];
	};
	const check = level => ({ level });
	try {
		/* as insight.summary counts them: the warnings and the errors, not the notes */
		assert.deepEqual(paint(insight.summary([ check('ok'), check('warn'), check('info'), check('warn') ])), [ 'warn', '2' ]);
		assert.deepEqual(paint(insight.summary([ check('warn'), check('err'), check('err') ])), [ 'err', '3' ]);
		assert.deepEqual(paint(insight.summary([ check('err') ])), [ 'err', '1' ]);
		assert.deepEqual(root.set, [ 'data-vt-alert', 'data-vt-alert-count' ], 'both at every paint, so one never outlives the other');
		/* all fine: both empty, so the theme's title is the page's again */
		assert.deepEqual(paint(insight.summary([ check('ok'), check('info') ])), [ '', '' ]);
		assert.deepEqual(paint(insight.summary([])), [ '', '' ]);
		/* no count without a level, and none that is not above zero */
		assert.deepEqual(paint({ level: 'ok', count: 4, headline: 'x' }), [ '', '' ]);
		assert.deepEqual(paint({ level: 'warn', count: 0, headline: 'x' }), [ 'warn', '' ]);
		assert.deepEqual(paint({ level: 'warn', headline: 'x' }), [ 'warn', '' ]);
		assert.deepEqual(paint({ level: 'warn', count: '<b>', headline: 'x' }), [ 'warn', '' ]);
	} finally {
		if (saved === undefined) delete global.document; else global.document = saved;
	}
	/* the theme reads these two names (menu-vantage.js updateTitle, watchAlert) */
	const theme = fs.readFileSync(path.join(RES, '..', '..', '..', '..', 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js'), 'utf8');
	assert.ok(theme.includes("alertMark(this.root.getAttribute('data-vt-alert'), this.root.getAttribute('data-vt-alert-count'))"));
	assert.ok(theme.includes("attributeFilter: [ 'data-vt-alert', 'data-vt-alert-count' ]"));
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
	const saved = { L: global.L, document: global.document, window: global.window };
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
	/* the flow dots are compositor animations, paused and played with the
	   motion; the pulses (the ring, the beat) stand paused and the clock
	   (tickMotion) moves them while it runs, and stops when nothing may move */
	const anim = () => ({ state: 'running', play() { this.state = 'running'; }, pause() { this.state = 'paused'; } });
	const pulse = () => ({ currentTime: 0, playState: 'paused' });
	const frames = [], timers = [];
	global.window = { requestAnimationFrame: fn => frames.push(fn), setTimeout: fn => timers.push(fn), dispatchEvent() {} };
	const make = media => {
		global.L = { env: { media } };
		global.document = { hidden: false, documentElement: root };
		const self = Object.create(view);
		const cls = new Set();
		self.st = { paused: false, lastErr: null, lastOk: Date.now() };
		self.el = { live: { className: '', hidden: false, setAttribute() {} }, liveText: { textContent: '' },
			root: { classList: { toggle: (c, on) => on ? cls.add(c) : cls.delete(c) } } };
		self.wireMap = { a: { anims: [ anim(), anim() ], steps: [], speed: 1 } };
		self.clock = { anims: [ { a: pulse(), dur: 5000, at: 0 } ], raf: 0, timer: 0, last: 0 };
		self.backdrop = { paused: false, pause(on) { this.paused = on; }, wants() { return false; }, period() { return 50; }, frame() { return false; } };
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
		assert.equal(frames.length, 0, 'the clock does not start');
		self.tickMotion(100);
		assert.deepEqual([ frames.length, timers.length, self.clock.anims[0].a.currentTime ], [ 0, 0, 0 ], 'a tick moves nothing and asks for no frame');
		assert.equal(self.backdrop.paused, true, 'the backdrop keeps its last frame');
		POLL.on = true;
		self.paintLive();
		assert.equal(self.el.live.className, 'vt-livepill vt-live-ok');
		assert.ok(!self.cls.has('vt-still'));
		assert.deepEqual(self.wireMap.a.anims.map(a => a.state), [ 'running', 'running' ], 'and go on from there');
		assert.equal(frames.length, 1, 'the clock starts');
		frames.pop()(100);
		frames.pop() && assert.fail('a tick asks for its next frame through a timer, not at once');
		assert.equal(timers.length, 1, 'the next frame waits for the clock');
		self.tickMotion(150);
		assert.equal(self.clock.anims[0].a.currentTime, 50, 'the pulse goes on from there, 50 ms a tick');
		assert.equal(self.backdrop.paused, false);
		POLL.on = false;
		self = make('/luci-static/bootstrap');
		self.paintLive();
		assert.deepEqual([ self.el.live.hidden, self.el.liveText.textContent ], [ false, 'Paused' ], 'another theme: the pill says it');
	} finally {
		POLL.on = true;
		global.L = saved.L;
		if (saved.window === undefined) delete global.window; else global.window = saved.window;
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

/* a node of the path as updateHero writes to it */
const pathEl = () => ({ textContent: '', attrs: {}, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
const pathHero = lines => new Proxy({ lines: lines || [], radios: [] }, { get: (t, k) => k in t ? t[k] : (t[k] = pathEl()) });
const LAN = { name: 'lan', proto: 'static', dev: 'br-lan', up: true, ipv4: '192.0.2.1/24' };

test('other lines: each node shows its name, its own address and live rates, wired into the device; the main one is marked', () => {
	const self = Object.create(view);
	const el = pathEl;
	const ln = id => ({ id, el: el(), kicker: el(), title: el(), dn: el(), up: el() });
	const wan = LINE('wan', 'eth1', 10), wanb = LINE('wanb', 'eth2', 20), lte = Object.assign(LINE('lte', 'wwan0', 30), { ipv4: [], gateway: null, carrier: false, speed: null });
	const h = pathHero([ ln('wanb'), ln('lte'), ln('gone') ]);
	self.hero = h;
	self.m = { wired: true, networks: [ LAN ], radios: [], ssids: [], wiredHosts: [], device: { model: 'Router', uptime: 1 }, uplink: wan, uplinks: [ wan, wanb, lte ] };
	self.st = { uplinkRate: { rx: 2e6, tx: 1e5 }, devRates: { eth2: { rx: 12345678, tx: 3000 }, wwan0: { rx: 0, tx: 0 } } };
	self.updateHero();
	assert.equal(h.gwKicker.textContent, 'wan', 'beside other lines the main one goes by its name');
	assert.deepEqual([ h.gwTitle.textContent, h.gw.attrs.title ], [ '203.0.113.12', 'Gateway 203.0.113.11' ], 'the main line: its own address, the gateway in the tooltip');
	const [ b, l ] = h.lines;
	assert.deepEqual([ b.kicker.textContent, b.title.textContent, b.dn.textContent, b.up.textContent ], [ 'wanb', '203.0.113.22', '↓ 12.3 Mbit/s', '↑ 3 kbit/s' ]);
	assert.equal(b.el.attrs.title, 'wanb · eth2 · 1 Gbit/s · full duplex · Gateway 203.0.113.21');
	assert.equal(b.el.attrs['class'], 'vt-node vt-node-gw vt-node-line');
	assert.deepEqual([ l.title.textContent, l.el.attrs.title, l.dn.textContent, l.up.textContent ], [ 'wwan0', 'lte · wwan0', 'idle', '' ], 'no address and no gateway: the device; nothing moving: idle');
	assert.equal(l.el.attrs['class'], 'vt-node vt-node-gw vt-node-line vt-node-off', 'no carrier');
	assert.deepEqual([ b.active, l.active ], [ true, false ]);
	/* one wire per line into the device, numbered for nesting */
	assert.deepEqual(self.wireList().filter(w => w.line != null).map(w => [ w.key, w.from === h.lines[w.line].el, w.to === h.ap, w.speed ]),
		[ [ 'l:wanb', true, true, 2 ], [ 'l:lte', true, true, 1 ], [ 'l:gone', true, true, 1 ] ]);
	/* a line with an address and no gateway (a point-to-point modem): its address, and no gateway in the tooltip */
	self.m.uplinks = [ wan, wanb, Object.assign({}, lte, { ipv4: [ '203.0.113.32/30' ] }) ];
	self.updateHero();
	assert.deepEqual([ l.title.textContent, l.el.attrs.title ], [ '203.0.113.32', 'lte · wwan0' ]);
	/* one line: the gateway's own kicker */
	h.lines = [];
	self.m.uplinks = [ wan ];
	self.updateHero();
	assert.equal(h.gwKicker.textContent, 'Internet');
});

test('the path: a line shows its own address and this device its LAN address; an access point shows its gateway as before (#88)', () => {
	const run = (m, lines) => {
		const self = Object.create(view), h = pathHero(lines);
		self.hero = h;
		self.m = Object.assign({ wired: true, networks: [ LAN ], radios: [], ssids: [], wiredHosts: [], device: { model: 'Router', uptime: 1 } }, m);
		self.st = { uplinkRate: null, devRates: {} };
		self.updateHero();
		return h;
	};
	const node = h => [ h.gwKicker.textContent, h.gwTitle.textContent, h.gwSub.textContent, h.gw.getAttribute('title'), h.apAddr.textContent ];
	const ln = id => ({ id, el: pathEl(), kicker: pathEl(), title: pathEl(), dn: pathEl(), up: pathEl() });

	/* one line: its own address where the gateway was, the gateway in the tooltip, this device at its LAN address */
	const wan = Object.assign(LINE('wan', 'eth1', 10), { dns: [ '198.51.100.53' ] });
	assert.deepEqual(node(run({ uplink: wan, uplinks: [ wan ] })), [ 'Internet', '203.0.113.12', 'DNS 198.51.100.53', 'Gateway 203.0.113.11', '192.0.2.1' ]);

	/* two lines of one provider end at one gateway: told apart by their own addresses */
	const a = Object.assign(LINE('wan', 'pppoe-wan', 10), { proto: 'pppoe', ipv4: [ '198.51.100.7/32' ], gateway: '203.0.113.1' });
	const b = Object.assign(LINE('wan2', 'pppoe-wan2', 20), { proto: 'pppoe', ipv4: [ '198.51.100.9/32' ], gateway: '203.0.113.1' });
	const two = run({ uplink: a, uplinks: [ a, b ] }, [ ln('wan2') ]);
	assert.deepEqual([ two.gwTitle.textContent, two.lines[0].title.textContent ], [ '198.51.100.7', '198.51.100.9' ]);
	assert.deepEqual([ two.gw.attrs.title, two.lines[0].el.attrs.title ], [ 'Gateway 203.0.113.1', 'wan2 · pppoe-wan2 · 1 Gbit/s · full duplex · Gateway 203.0.113.1' ]);
	assert.equal(two.apAddr.textContent, '192.0.2.1');

	/* no network called lan: the first one that is up; none with an address: a dash, never the line's again */
	const nets = [ { name: 'guest', up: false, ipv4: '192.0.2.129/25' }, { name: 'home', up: true, ipv4: '192.0.2.65/26' } ];
	assert.equal(run({ uplink: wan, uplinks: [ wan ], networks: nets }).apAddr.textContent, '192.0.2.65');
	assert.equal(run({ uplink: wan, uplinks: [ wan ], networks: [] }).apAddr.textContent, '—');
	/* a LAN by another name beside a container bridge that sorts before it: the network the SSIDs and wired hosts are on */
	const beside = [ { name: 'docker', up: true, ipv4: '198.51.100.1/24' }, { name: 'home', up: true, ipv4: '192.0.2.65/26' }, { name: 'iot', up: true, ipv4: '192.0.2.129/26' } ];
	const at = extra => run(Object.assign({ uplink: wan, uplinks: [ wan ], networks: beside }, extra)).apAddr.textContent;
	assert.equal(at({}), '198.51.100.1', 'nothing known of any: the first that is up, as before');
	assert.equal(at({ wiredHosts: [ { mac: '00:00:5e:00:53:01', network: 'home' }, { mac: '00:00:5e:00:53:02', network: null } ] }), '192.0.2.65', 'its wired hosts');
	assert.equal(at({ ssids: [ { networks: [ 'home' ], clients: 0 } ] }), '192.0.2.65', 'an SSID on it, without clients');
	assert.equal(at({ ssids: [ { networks: [ 'iot' ], clients: 1 }, { networks: [ 'home' ], clients: 4 } ], wiredHosts: [ { network: 'iot' } ] }), '192.0.2.65', 'the one with more on it');
	assert.equal(at({ ssids: [ { networks: [ 'gone', 7 ], clients: 9 } ], wiredHosts: [ { network: 'gone' } ] }), '198.51.100.1', 'a network that is not there counts for nothing');
	assert.equal(at({ networks: beside.concat(LAN), wiredHosts: [ { network: 'home' } ] }), '192.0.2.1', 'lan by its name, whatever is on the others');

	/* a line without an IPv4 address of its own: its gateway, as before */
	const v6 = Object.assign(LINE('wan', 'eth1', 10), { ipv4: [], gateway: 'fe80::1' });
	assert.deepEqual(node(run({ uplink: v6, uplinks: [ v6 ] })), [ 'Internet', 'fe80::1', 'Reachability not probed', null, '—' ]);
	/* the same node over two polls: the line loses its address, and the tooltip goes with it */
	const again = Object.create(view), kept = pathHero();
	again.hero = kept;
	again.st = { uplinkRate: null, devRates: {} };
	again.m = { wired: true, networks: [ LAN ], radios: [], ssids: [], wiredHosts: [], device: { model: 'Router', uptime: 1 }, uplink: wan, uplinks: [ wan ] };
	again.updateHero();
	assert.equal(kept.gw.getAttribute('title'), 'Gateway 203.0.113.11');
	again.m = Object.assign({}, again.m, { uplink: v6, uplinks: [ v6 ] });
	again.updateHero();
	assert.deepEqual(node(kept), [ 'Internet', 'fe80::1', 'Reachability not probed', null, '—' ]);
	/* a gateway this device knows by name (a bridged WAN): the name under the line's own address, not instead of it */
	const named = { mac: '00:00:5e:00:53:fe', name: 'isp-box', nameSource: 'dhcp', port: 'wan', gateway: true };
	assert.deepEqual(node(run({ uplink: wan, uplinks: [ wan ], wiredHosts: [ named ] })).slice(0, 4), [ 'Internet', '203.0.113.12', 'isp-box', 'Gateway 203.0.113.11' ]);

	/* an access point: one line that is no WAN. The gateway by its name and address, its own address on its node, no tooltip */
	const lan = Object.assign(LINE('lan', 'br-lan', 0), { isWan: false, ipv4: [ '192.0.2.4/24' ], gateway: '192.0.2.1' });
	const gw = { mac: '00:00:5e:00:53:fe', name: 'home-router', nameSource: 'dhcp', port: 'lan1', gateway: true };
	assert.deepEqual(node(run({ wired: false, uplink: lan, uplinks: [ lan ], networks: [], wiredHosts: [ gw ] })), [ 'Gateway', 'home-router', '192.0.2.1', null, '192.0.2.4' ]);
	assert.deepEqual(node(run({ wired: false, uplink: lan, uplinks: [ lan ], networks: [], wiredHosts: [] })), [ 'Gateway', '192.0.2.1', 'Reachability not probed', null, '192.0.2.4' ]);
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

test('uplink drawer: the delegated IPv6 prefix among the addresses, as text; no row where there is none', () => {
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10);
	self.m = { uplink: wan, uplinks: [ wan ] };
	self.st = { uplinkRate: null, devRates: {}, hist: { net: {} } };
	withDom(() => {
		/* the rows of the details: [ label, the text of its value ] */
		const rows = () => {
			const out = [];
			(function walk(n) {
				if (!n || typeof n !== 'object') return;
				if (n.attrs && n.attrs['class'] === 'vt-kv') out.push([ texts(n.children[0]).join(''), texts(n.children[1]).join('') ]);
				else (n.children || []).forEach(walk);
			})({ children: self.drawerUplink('').body });
			return out;
		};
		const labels = () => rows().map(r => r[0]);
		assert.ok(!labels().includes('IPv6 prefix'), 'a line the model gave no list');
		wan.prefix6 = [];
		assert.ok(!labels().includes('IPv6 prefix'));
		wan.prefix6 = [ '2001:db8:1200::/56', '2001:db8:3400::/48' ];
		assert.deepEqual(rows().filter(r => r[0] === 'IPv6 prefix'), [ [ 'IPv6 prefix', '2001:db8:1200::/56\n2001:db8:3400::/48' ] ]);
		const at = labels().indexOf('IPv6 prefix');
		assert.deepEqual(labels().slice(at - 1, at + 2), [ 'IPv6', 'IPv6 prefix', 'Gateway' ]);
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

/* #101: the CPU tile shows the browser's last reading of this router
   (local storage, the router's origin's: every tab), if under ten
   minutes old, while the first measurement runs; not a dash */
/* the device's details, with LuCI's url() for its page links */
function deviceDrawer(t, st, device) {
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	t.after(() => { global.L = savedL; });
	const self = Object.create(view);
	self.m = { device: Object.assign({ model: 'Example AP', hostname: 'ap-hall', load: [ 65536, 32768, 0 ], memory: null }, device) };
	self.st = st;
	self.cpuShown = () => null;
	return withDom(() => texts({ children: self.drawerDevice().body }));
}

test('device drawer: every temperature sensor has a row, the hottest first; no section without one', t => {
	const model = load('vantage.model');
	const temps = model.temps([ { zone: 'thermal_zone0', type: 'cpu-thermal', temp: 52100 }, { zone: 'thermal_zone1', type: 'wifi-phy0', temp: 77800 }, { zone: 'thermal_zone2', temp: 41400 } ]);
	const all = deviceDrawer(t, { temps });
	assert.deepEqual(all.slice(all.indexOf('Temperature')), [ 'Temperature', 'wifi-phy0', '78\u00a0°C', 'cpu-thermal', '52\u00a0°C', 'thermal_zone2', '41\u00a0°C' ]);
	/* a sensor without a name still has its row */
	const unnamed = deviceDrawer(t, { temps: [ { name: '', celsius: 30 } ] });
	assert.deepEqual(unnamed.slice(unnamed.indexOf('Temperature')), [ 'Temperature', 'Sensor', '30\u00a0°C' ]);
	/* a device without sensors, or before the first answer: nothing */
	for (const st of [ { temps: [] }, {} ]) assert.ok(!deviceDrawer(t, st).includes('Temperature'));
	/* a long name without a hyphen breaks inside its column (app.css) */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8'), css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8');
	assert.match(src, /section\(_\('Temperature'\), [^\n]*\n[^\n]*\n[^\n]*\], 'vt-dsec-temps'\)/);
	assert.match(css, /\.vt-app \.vt-dsec-temps dt \{ overflow-wrap: anywhere; \}/);
});

test('CPU: the last reading stands in for ten minutes while the first is measured', () => {
	const savedWindow = global.window, savedL = global.L, box = {};
	global.window = {
		sessionStorage: { getItem: () => null, setItem() {} },
		localStorage: { getItem: k => k === 'vantage.cpu.v1' ? box.v || null : null, setItem(k, v) { if (k === 'vantage.cpu.v1') box.v = v; } }
	};
	global.L = { env: { sessionid: '0123456789abcdef0123456789abcdef' } };
	const load = () => { const self = Object.create(view); self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null }); return self; };
	const put = v => { box.v = JSON.stringify(v); };
	const now = Date.now();
	try {
		put({ pct: 12.5, cores: [ 10, null ], t: now - 9 * 60e3 });
		const held = load().st;
		assert.deepEqual(held.cpu, { pct: 12.5, cores: [ 10, null ], t: now - 9 * 60e3 });
		assert.equal(held.cores, 2);
		put({ pct: 12.5, cores: [ 10, 15 ], t: now - 11 * 60e3 });
		assert.equal(load().st.cpu, null, 'older than ten minutes');
		for (const bad of [ { pct: 120, cores: [], t: now }, { pct: 5, cores: [ 'x' ], t: now }, { pct: 5, cores: {}, t: now }, { pct: 5, cores: [], t: now + 60000 }, { pct: 5, cores: [] }, 'junk' ]) {
			put(bad);
			assert.equal(load().st.cpu, null, JSON.stringify(bad));
		}
		/* a reading is kept for the next page, at most every 10 s */
		box.v = null;
		const self = load();
		const stat = (busy, idle) => 'cpu  ' + busy + ' 0 0 ' + idle + ' 0 0 0 0 0 0\ncpu0 ' + busy + ' 0 0 ' + idle + ' 0 0 0 0 0 0\n';
		const raw = (t, st) => ({ at: t, info: { localtime: t / 1000 }, stat: st, ifaces: [], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {}, devs: {} });
		self.ingest(raw(1.8e12, stat(100, 900)));
		assert.equal(box.v || null, null, 'nothing measured yet');
		self.ingest(raw(1.8e12 + 5000, stat(150, 1050)));
		const kept = JSON.parse(box.v);
		assert.deepEqual([ Math.round(kept.pct), kept.cores.map(Math.round) ], [ 25, [ 25 ] ]);
		assert.ok(Math.abs(kept.t - Date.now()) < 5000);
		self.ingest(raw(1.8e12 + 10000, stat(300, 1100)));
		assert.equal(Math.round(JSON.parse(box.v).pct), 25, 'not again within 10 s');
		assert.equal(Math.round(self.st.cpu.pct), 75, 'though shown');
		assert.deepEqual(load().st.cpu.pct, kept.pct, 'and shown on the next page');
	} finally {
		global.window = savedWindow;
		global.L = savedL;
	}
});

/* the first reading takes two samples a second apart: the second is
   asked 1.1 s after the first, not at the 2 s lane's next tick */
test('CPU: 0 % until the first reading, its second sample a second after the first', async () => {
	const savedWindow = global.window, savedL = global.L, savedDoc = global.document, timers = [];
	/* ticks a call: under a second's worth (100) gives no reading */
	let ticks = 100;
	const steps = [ 0, 60, 150, 150 ];
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
		setTimeout: (f, ms) => { timers.push(ms); return timers.length; } };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { env: {}, resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['file read'] = () => { ticks += steps.shift() || 150; return Promise.resolve('cpu  ' + ticks + ' 0 0 0 0 0 0 0 0 0\ncpu0 ' + ticks + ' 0 0 0 0 0 0 0 0 0\n'); };
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		self.el = { root: {} };
		self.m = { uplink: null };
		self.fastLive = () => true;
		self.idle = () => false;
		self.paintFast = () => {};
		assert.equal(self.cpuShown(), null, 'no sample from the router: a dash');
		await self.refreshFast();
		assert.deepEqual(timers, [ 1100 ], 'the first sample: the second asked in 1.1 s');
		assert.deepEqual(self.cpuShown(), { pct: 0, cores: [ 0 ] }, 'until then 0 %, not a dash');
		await self.refreshFast();
		assert.deepEqual(timers, [ 1100 ], 'one timer at a time');
		self.cpuSoon = 0;
		await self.refreshFast();
		assert.ok(self.st.cpu && self.st.cpuMeasured, 'a reading');
		assert.equal(self.cpuShown(), self.st.cpu);
		/* the lane's tick and the early sample share a call in flight */
		let calls = 0;
		const saved = REPLIES['file read'];
		REPLIES['file read'] = (...a) => { calls++; return saved(...a); };
		await Promise.all([ self.refreshFast(), self.refreshFast() ]);
		assert.equal(calls, 1, 'one call for both');
		await self.refreshFast();
		assert.equal(calls, 2, 'and the next one after it');
		await self.refreshFast();
		assert.deepEqual(timers, [ 1100 ], 'and none once measured');
	} finally {
		global.window = savedWindow; global.L = savedL;
		if (savedDoc === undefined) delete global.document; else global.document = savedDoc;
		delete REPLIES['file read'];
	}
});

test('uplink drawer: a router\'s line with a private or a shared address says so in one plain note; no health check does', () => {
	const ip = (...o) => o.join('.');
	const self = Object.create(view);
	const wan = LINE('wan', 'eth1', 10);
	self.m = { uplink: wan, uplinks: [ wan ] };
	self.st = { uplinkRate: null, devRates: {}, hist: { net: {} } };
	withDom(() => {
		const notes = () => {
			const body = self.drawerUplink('').body, found = [];
			(function walk(n) {
				if (!n || typeof n !== 'object') return;
				if (n.attrs && /(^| )vt-note( |$)/.test(n.attrs['class'] || '')) found.push([ n.attrs['class'], texts(n).join('') ]);
				(n.children || []).forEach(walk);
			})({ children: body });
			return found;
		};
		assert.deepEqual(notes(), [], 'a documentation address, as in the demo');
		wan.ipv4 = [ ip(192, 168, 1, 2) + '/24' ];
		assert.deepEqual(notes(), [ [ 'vt-note vt-note-info', 'This line has a private address (' + ip(192, 168, 1, 2) + '): another router, or the provider, translates addresses in front of this one (double NAT). ' +
			'Port forwards can be reached from the internet only where that one passes them on.' ] ]);
		wan.ipv4 = [ ip(100, 64, 12, 34) + '/24' ];
		assert.deepEqual(notes(), [ [ 'vt-note vt-note-info', 'This line has a shared address (' + ip(100, 64, 12, 34) + '): the provider translates addresses for many customers (carrier-grade NAT). ' +
			'Port forwards cannot be reached from the internet over IPv4.' ] ]);
		/* an access point's uplink: nothing */
		wan.ipv4 = [ ip(192, 168, 1, 2) + '/24' ];
		wan.isWan = false;
		assert.deepEqual(notes(), []);
	});
	/* information only: the same line raises no check and no count */
	const insight = load('vantage.insight'), m = { device: { load: [ 0 ], storage: [] }, wired: true,
		uplink: Object.assign(LINE('wan', 'eth1', 10), { ipv4: [ ip(100, 64, 12, 34) + '/24' ] }) };
	const checks = insight.health(m, { cpu: { pct: 5, cores: [ 5 ] } });
	assert.deepEqual(checks.map(c => [ c.id, c.level ]), [ [ 'uplink', 'ok' ], [ 'cpu', 'ok' ] ]);
	assert.deepEqual([ insight.summary(checks).count, insight.summary(checks).level ], [ 0, 'ok' ]);
	assert.doesNotMatch(JSON.stringify(checks), /NAT|private|shared/);
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
	let power = 'normal', unfocused = 'still';
	const root = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'data-vt-power' ? power : k === 'data-vt-unfocused' ? unfocused : null; } };
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
		/* Motion when not in focus (#131), the theme's Appearance */
		unfocused = 'moving';
		self.paintLive();
		assert.ok(!cls.has('vt-still'), 'on without the focus when picked');
		unfocused = 'still';
		self.paintLive();
		assert.ok(cls.has('vt-still'));
		self.focused = true;
		self.paintLive();
		assert.ok(!cls.has('vt-still'));
		power = 'low';
		self.paintLive();
		assert.ok(cls.has('vt-still'), 'Low-power router');
		assert.equal(self.backdrop.paused, true);
		unfocused = 'moving';
		self.focused = false;
		self.paintLive();
		assert.ok(cls.has('vt-still'), 'Low-power router stops it whatever the focus');
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

test('Speed units: fmt reads the pick and a built page is painted again at once', () => {
	const fmt = load('vantage.fmt');
	const saved = { document: global.document };
	let units = 'bytes';
	global.document = { hidden: false, documentElement: { getAttribute: k => (k === 'data-vt-units' ? units : null) } };
	const self = Object.create(view);
	let painted = 0;
	self.rehealth = () => { painted++; };
	try {
		self.applyUnits();
		assert.equal(fmt.bits(8e6), '1 MB/s');
		assert.equal(painted, 0, 'before the first build there is nothing to paint');
		self.el = { root: {} };
		units = 'bits';
		self.applyUnits();
		assert.equal(fmt.bits(8e6), '8 Mbit/s');
		assert.equal(painted, 1, 'the health cards\' texts and the whole page: no wait for the next poll');
		units = 'nonsense';
		self.applyUnits();
		assert.equal(fmt.bits(8e6), '8 Mbit/s', 'anything but bytes reads as bits');
	} finally {
		fmt.setSpeedUnits('bits');
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
	}
	/* every rate axis rounds in the unit its labels show, and the short
	   rates under a paired access point follow it */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const rehealth = src.slice(src.indexOf('\trehealth: function() {'), src.indexOf('\n\t},', src.indexOf('\trehealth: function() {')));
	assert.ok(rehealth.includes('st.health = insight.health(') && rehealth.includes('this.paint();'), 'rehealth makes the cards\' texts again and paints');
	assert.equal(src.split('scale: bitsLabel').length, src.split('scale: bitsLabel, ceil: rateCeil').length, 'no rate sparkline without it');
	assert.equal(src.split('scale: bitsLabel, ceil: rateCeil').length, 5, 'the four of them: the radio tiles and the details of a client, a radio and the uplink');
	assert.ok(src.includes('series.chartGeom(style, sd.peak, su.peak, rateUnit())'));
	assert.ok(src.includes('bps /= rateUnit();'));
	/* the theme's event reaches the page, and a reload starts in the unit picked:
	   it is set before the first texts are made */
	assert.ok(src.includes("window.addEventListener('vantage:units', function() { self.applyUnits(); });"));
	assert.ok(src.indexOf('\t\tthis.applyUnits();\n\t\tthis.ingest(data.raw);') > 0, 'before the first ingest');
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

/* luci-rpc getHostHints reads the leases and the ARP table: every 30 s,
   and for the three polls after a station or wired host first appears */
test('client details: the Radio row prints a dash for a channel that is not known and makes up no width', t => withFakeDom(() => {
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	t.after(() => { global.L = savedL; });
	const m = apModel(null), sta = m.clients[0], radio = m.radios[0];
	const self = Object.assign(Object.create(dview), { m, st: { staRates: {}, devRates: {}, clientHist: {}, gone: [] }, ui: {}, el: {}, quiet: {}, canWrite: false });
	const row = () => {
		const n = new FNode('x');
		append(n, self.drawerClient(sta.mac).body);
		return n.find('vt-kv').filter(r => r.children[0].textContent === 'Radio')[0].children[1].textContent;
	};
	assert.deepEqual([ radio.id, radio.channel, radio.width ], [ 'radio0', 36, 80 ]);
	assert.equal(row(), 'radio0 · channel 36 · 80 MHz', 'as before where both are known');
	/* the channel is not known (a radio that is down, a driver that gives none): the tiles' dash */
	for (const channel of [ null, 0, undefined ]) {
		radio.channel = channel;
		assert.equal(row(), 'radio0 · —', String(channel));
	}
	radio.width = null;
	assert.equal(row(), 'radio0 · —');
	/* the width alone is not known (an htmode the model cannot read) */
	radio.channel = 36;
	assert.equal(row(), 'radio0 · channel 36');
	assert.doesNotMatch(row(), /channel 0|20 MHz/);
	/* a radio the device no longer reports: its name, as before */
	sta.radio = 'radio9';
	assert.equal(row(), 'radio9');
}));

test('host hints: every 30 s, and again for three polls when a station or host is new', async () => {
	let hints = 0, stations = [ { mac: '00:00:5e:00:53:01' } ];
	REPLIES['luci-rpc getHostHints'] = () => { hints++; return Promise.resolve({ '00:00:5e:00:53:01': { name: 'one' } }); };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({ radio0: { up: true, config: {}, interfaces: [ { ifname: 'wl0', config: { mode: 'ap' } } ] } });
	REPLIES['iwinfo assoclist'] = () => Promise.resolve(stations);
	const self = Object.create(view);
	const savedL = global.L, now = Date.now;
	let t = 1e12;
	Date.now = () => t;
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	const poll = async ms => { t += ms; return self.fetch(); };
	try {
		let r = await poll(0);
		assert.equal(hints, 1);
		r = await poll(5e3);
		assert.equal(hints, 1, 'kept');
		assert.equal(r.hints['00:00:5e:00:53:01'].name, 'one', 'the last reply');
		await poll(25e3);
		assert.equal(hints, 2, 'again after 30 s');
		stations = stations.concat([ { mac: '00:00:5e:00:53:02' } ]);
		await poll(5e3);
		assert.equal(hints, 2, 'the new station is this poll\'s');
		/* a failed call spends none of the three */
		const ok = REPLIES['luci-rpc getHostHints'];
		REPLIES['luci-rpc getHostHints'] = () => { hints++; return Promise.reject(new Error('timeout')); };
		const failed = await poll(5e3);
		assert.equal(failed.hints['00:00:5e:00:53:01'].name, 'one', 'the last reply kept');
		REPLIES['luci-rpc getHostHints'] = ok;
		await poll(5e3); await poll(5e3); await poll(5e3);
		assert.equal(hints, 6, 'then three answered polls in a row');
		await poll(5e3);
		assert.equal(hints, 6, 'and kept again');
	}
	finally {
		global.L = savedL; Date.now = now;
		for (const k of Object.keys(REPLIES)) if (/^(luci-rpc getHostHints|luci\.vantage wireless|iwinfo assoclist)/.test(k)) delete REPLIES[k];
	}
});

/* a pulse CSS cancelled since the last step (the dot's state changed) is
   dropped, not stepped: a time written to it would bring it back, paused,
   with nothing left to stop it (review of 1.0.19) */
test('device details: the firmware\'s build date with its age, where system board has a date; else no row', t => {
	const savedL = global.L, realNow = Date.now;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	/* 2026-11-19 12:00 UTC */
	Date.now = () => Date.UTC(2026, 10, 19, 12);
	t.after(() => { global.L = savedL; Date.now = realNow; });
	const self = Object.create(view);
	self.st = {};
	self.cpuShown = () => null;
	const rows = built => {
		self.m = { device: { model: 'Example AP', hostname: 'ap-hall', firmware: 'OpenWrt 25.12.3 r1', load: [ 0, 0, 0 ], memory: null, built } };
		return withDom(() => texts({ children: self.drawerDevice().body }));
	};
	/* built 2026-09-21 14:13:20 UTC: 58 days and some hours before */
	const all = rows(1790000000), at = all.indexOf('Firmware built');
	assert.deepEqual(all.slice(at - 2, at + 4), [ 'Firmware', 'OpenWrt 25.12.3 r1', 'Firmware built', '2026-09-21', '58 days ago', 'Kernel' ]);
	assert.deepEqual(rows(Date.UTC(2024, 2, 11) / 1000).filter((x, i, l) => l[i - 1] === 'Firmware built' || l[i - 2] === 'Firmware built'), [ '2024-03-11', '2 years ago' ]);
	assert.deepEqual(rows(Date.UTC(2026, 10, 19, 3) / 1000).filter((x, i, l) => l[i - 1] === 'Firmware built' || l[i - 2] === 'Firmware built'), [ '2026-11-19', 'today' ]);
	/* a build stamped ahead of this browser's clock: the date, no age */
	const ahead = rows(Date.UTC(2026, 11, 24) / 1000), i = ahead.indexOf('Firmware built');
	assert.deepEqual(ahead.slice(i, i + 3), [ 'Firmware built', '2026-12-24', 'Kernel' ]);
	/* no date (a custom build's other text is null in the model): no row, and nothing else moves */
	for (const none of [ null, undefined ]) {
		const bare = rows(none);
		assert.ok(!bare.includes('Firmware built'));
		assert.deepEqual(bare.slice(bare.indexOf('Firmware'), bare.indexOf('Firmware') + 3), [ 'Firmware', 'OpenWrt 25.12.3 r1', 'Kernel' ]);
	}
	/* the page asks nobody about it */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.doesNotMatch(src.slice(src.indexOf('builtRow: function'), src.indexOf('handleKey: function')), /fetch|XMLHttpRequest|rpc\.|call[A-Z]\w*\(/);
});

test('motion clock: a cancelled pulse is dropped, not stepped', () => {
	const live = { playState: 'paused', currentTime: 0 }, gone = { playState: 'idle', currentTime: null };
	const self = Object.create(view);
	self.clock = { anims: [ { a: live, dur: 1000, at: 0 }, { a: gone, dur: 1000, at: 0 } ] };
	self.wireMap = {};
	const saved = global.window;
	global.window = { dispatchEvent() {} };
	try {
		self.stepMotion(50, 1000);
		assert.equal(live.currentTime, 50);
		assert.equal(gone.currentTime, null, 'not written: it stays cancelled');
		assert.deepEqual(self.clock.anims.map(x => x.a), [ live ]);
	} finally { global.window = saved; }
});

/* #132: by live traffic the rows changed places at every poll */
test('client table: by name until a header is clicked, and the pick is kept for this browser', () => {
	const savedWindow = global.window, savedL = global.L, box = {};
	global.L = { env: {} };
	global.window = {
		sessionStorage: { getItem: () => null, setItem() {} },
		localStorage: { getItem: k => k === 'vantage.sort.v1' ? box.v || null : null, setItem(k, v) { if (k === 'vantage.sort.v1') box.v = v; } }
	};
	const load = () => {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		self.paintClients = () => {};
		return self;
	};
	const byName = { wifi: { key: 'name', dir: 1 }, wired: { key: 'name', dir: 1 } };
	try {
		let self = load();
		assert.deepEqual(self.ui.sorts, byName);
		self.setSort('live');
		assert.deepEqual(self.ui.sorts.wifi, { key: 'live', dir: -1 }, 'the busiest first');
		self.setSort('live');
		assert.deepEqual(self.ui.sorts.wifi, { key: 'live', dir: 1 }, 'a second click turns it round');
		self.ui.kind = 'wired';
		self.setSort('seen');
		assert.deepEqual(load().ui.sorts, { wifi: { key: 'live', dir: 1 }, wired: { key: 'seen', dir: 1 } }, 'kept, each list its own');
		/* another tab, opened before those picks, changes one list: the other's pick stays */
		const other = load();
		box.v = JSON.stringify({ wifi: { key: 'signal', dir: -1 }, wired: { key: 'seen', dir: 1 } });
		other.ui.kind = 'wired';
		other.setSort('link');
		assert.deepEqual(load().ui.sorts, { wifi: { key: 'signal', dir: -1 }, wired: { key: 'link', dir: -1 } });
		/* the header's click goes through setSort, the table is in the pick's order, and the
		   backdrop and a pick made while the page is open follow Motion when not in focus (#131) */
		const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
		assert.ok(src.includes("'click': function() { self.setSort(c[0]); }"));
		assert.ok(src.includes("var so = ui.sorts[ui.kind];") && src.includes("var va = self.sortValue(a, so.key), vb = self.sortValue(b, so.key);"));
		assert.ok(src.includes("{ external: true, unfocused: movesUnfocused }"));
		assert.ok(src.includes("window.addEventListener('vantage:unfocused', function() { self.paintLive(); });"));
		/* a stored pick the list has no column for, or no direction: by name */
		box.v = JSON.stringify({ wifi: { key: 'seen', dir: 1 }, wired: { key: 'link', dir: 2 } });
		assert.deepEqual(load().ui.sorts, byName);
		box.v = '[';
		assert.deepEqual(load().ui.sorts, byName, 'not JSON');
	} finally {
		global.window = savedWindow;
		global.L = savedL;
	}
});

/* ------------------------------------------- paired access points (#127) */

/* a small DOM: elements as LuCI's E() and dom.content() build them, text
   nodes as strings; enough for the path, the list cells and the drawers */
class FNode {
	constructor(tag) {
		this.tag = tag; this.attrs = {}; this.childNodes = []; this.on = {}; this.text = null;
		this.style = { setProperty(k, v) { this[k] = v; } };
		const self = this;
		this.classList = {
			add(c) { const l = (self.attrs.class || '').split(' ').filter(Boolean); if (!l.includes(c)) l.push(c); self.attrs.class = l.join(' '); },
			remove(c) { self.classList.toggle(c, false); },
			toggle(c, on) { const l = (self.attrs.class || '').split(' ').filter(x => x && x !== c); if (on) l.push(c); self.attrs.class = l.join(' '); },
			contains(c) { return (self.attrs.class || '').split(' ').includes(c); }
		};
	}
	get children() { return this.childNodes.filter(n => n instanceof FNode); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	appendChild(n) { this.childNodes.push(n); return n; }
	insertBefore(n, ref) { const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); return n; }
	removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); return n; }
	addEventListener(t, f) { this.on[t] = f; }
	get textContent() { return this.text != null ? this.text : this.childNodes.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
	set textContent(v) { this.text = String(v); this.childNodes = []; }
	/* every element below, this one first */
	all() { return [ this ].concat(...this.children.map(c => c.all())); }
	find(cls) { return this.all().filter(n => (n.attrs.class || '').split(' ').includes(cls)); }
	html() {
		const a = Object.keys(this.attrs).sort().map(k => ' ' + k + '=' + JSON.stringify(this.attrs[k])).join('');
		return '<' + this.tag + a + '>' + (this.text != null ? JSON.stringify(this.text) : '') + this.childNodes.map(n => typeof n === 'string' ? JSON.stringify(n) : n.html()).join('') + '</' + this.tag + '>';
	}
}
function append(n, ch) { [].concat(ch).forEach(c => { if (c instanceof FNode) n.appendChild(c); else if (c != null) n.childNodes.push(String(c)); }); }
const fdom = { content(el, ch) { el.childNodes = []; el.text = null; append(el, ch); } };
const dview = loadView(fdom);
function withFakeDom(fn) {
	const saved = { E: global.E, document: global.document, window: global.window };
	global.E = (tag, attrs, children) => {
		const n = new FNode(tag);
		for (const [ k, v ] of Object.entries(attrs || {})) if (typeof v === 'function') n.on[k] = v; else if (v != null) n.setAttribute(k, v);
		if (Array.isArray(children)) append(n, children);
		else if (children != null) n.innerHTML = String(children);
		return n;
	};
	global.document = { createElementNS: (ns, tag) => new FNode(tag) };
	global.window = { matchMedia: () => ({ matches: true }) };
	try { return fn(); }
	finally { Object.assign(global, saved); }
}

const AP_ID = '0123456789abcdef';
/* a router with one Wi-Fi network, two stations, a host on lan2 and one
   behind ap-hall on lan1, and its WAN */
function apModel(collector, heard) {
	const model = load('vantage.model');
	const m = model.build({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.10' } ] }
		],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'phy0-ap0' ] }, lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' },
			lan2: { devtype: 'ethernet', carrier: true, speed: '1000F' }, wan: { devtype: 'ethernet', carrier: true, speed: '1000F' }, 'phy0-ap0': { devtype: 'wlan' } },
		wifi: { radio0: { up: true, config: { band: '5g', channel: '36', htmode: 'HE80' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] } },
		assoc: { 'phy0-ap0': [ { mac: '00:00:5E:00:53:01', signal: -50 }, { mac: '00:00:5E:00:53:02', signal: -80 } ] },
		hints: { '00:00:5E:00:53:31': { name: 'printer', ipaddrs: [ '192.0.2.131' ] }, '00:00:5E:00:53:21': { name: 'phone', ipaddrs: [ '192.0.2.121' ] } },
		fdb: [ { mac: '02:00:5e:10:00:01', port: 'lan1', bridge: 'br-lan', seen: 1 }, { mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:32', port: 'lan2', bridge: 'br-lan', seen: 1 } ].concat(heard || []),
		collector
	});
	m.wired = false;
	return m;
}
/* ap-hall at the gateway's address: a branch, never the gateway */
const hall = (extra, report) => Object.assign({ id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', state: 'ok', error: null, age: 3, report: Object.assign({
	name: 'OpenWrt', model: 'Example AP', uptime: 3600, mac: '02:00:5e:10:00:01',
	ssids: [ { ifname: 'phy1-ap0', bssid: '02:00:5e:10:00:11', ssid: 'Hall', freq: 5180, channel: 36, band: '5g' } ],
	stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -88, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000, connected: 60 } ],
	wired: [ { mac: '00:00:5e:00:53:31', port: 'lan2', speed: 1000 }, { mac: '00:00:5e:00:53:41', port: 'lan3', speed: 100, rx: 4000, tx: 9000 } ] }, report) }, extra);

function hero(m) {
	const self = Object.create(dview);
	self.m = m;
	self.st = { devRates: {}, radioRates: {}, ssidRates: {}, staRates: {}, uplinkRate: null };
	self.el = { path: new FNode('div'), wires: new FNode('svg'), flows: new FNode('div') };
	self.el.path.appendChild(self.el.wires);
	self.el.path.appendChild(self.el.flows);
	self.buildHeroNodes(self.heroKey());
	self.updateHero();
	return self;
}

test('paired access points: without one the path has nothing new: no mesh class, no rows, no branch, no wider nodes', () => withFakeDom(() => {
	const self = hero(apModel(null));
	const path = self.el.path;
	assert.equal(path.getAttribute('class'), 'vt-path');
	assert.doesNotMatch(path.html(), /vt-leaf|vt-node-peer|vt-branches-label|vt-path-mesh|vt-path-sib/);
	const ssid = path.find('vt-node-ssid').filter(n => n.textContent.startsWith('Home'))[0];
	assert.equal(ssid.find('vt-node-body')[0].children.length, 2, 'the SSID node: its name and its dots, no rows');
	assert.doesNotMatch(self.heroKey(), /aps=/);
	assert.equal(self.wireList().filter(w => w.elbow).length, 0);
}));

/* #130: the router hears ap-den on ap-hall's port, and ap-hall lists it on its lan4 */
test('paired access points: one plugged into another is under it: its branch further in, its wire from that one, the port in its tooltip', () => withFakeDom(() => {
	const DEN_ID = 'fedcba9876543210', DEN_MAC = '02:00:5e:10:00:02';
	const den = hall({ id: DEN_ID, name: 'ap-den', addr: '192.0.2.11' }, { mac: DEN_MAC, stations: [], wired: [] });
	const heard = [ { mac: DEN_MAC, port: 'lan1', bridge: 'br-lan', seen: 1 } ];
	const self = hero(apModel({ aps: [ den, hall({}, { wired: [ { mac: DEN_MAC, port: 'lan4', speed: 1000 } ] }) ] }, heard));
	const path = self.el.path, peers = path.find('vt-node-peer');
	assert.deepEqual(path.find('vt-branch-peer').map(w => [ w.find('vt-node-title')[0].textContent, w.getAttribute('class') ]),
		[ [ 'ap-hall', 'vt-branch vt-branch-peer' ], [ 'ap-den', 'vt-branch vt-branch-peer vt-branch-d1' ] ], 'after its parent, whatever the pairing order');
	assert.match(peers[1].getAttribute('title'), /\nWired to ap-hall on lan4(\n|$)/);
	assert.doesNotMatch(peers[0].getAttribute('title'), /Wired to/);
	assert.deepEqual(self.wireList().filter(w => /^r::ap:/.test(w.key)).map(w => [ w.key, w.from === self.hero.ap, w.from === peers[0], !!w.elbow ]),
		[ [ 'r::ap:' + AP_ID, true, false, false ], [ 'r::ap:' + DEN_ID, false, true, false ] ], 'from the one it is plugged into');
	assert.match(self.heroKey(), new RegExp('aps=' + AP_ID + '=[^;]*;' + DEN_ID + '<' + AP_ID + '='), 'a change of parent rebuilds the path');
	/* not listed by ap-hall: a branch of this device, as before */
	const flat = hero(apModel({ aps: [ den, hall() ] }, heard));
	assert.doesNotMatch(flat.el.path.html(), /vt-branch-d\d|Wired to/);
	assert.deepEqual(flat.wireList().filter(w => /^r::ap:/.test(w.key)).map(w => w.from === flat.hero.ap), [ true, true ]);
	assert.doesNotMatch(flat.heroKey(), /</);
}));

test('paired access points: a branch each with the pairing name and the address as text, rows only under the mesh class; never the gateway or a relabel', () => withFakeDom(() => {
	const self = hero(apModel({ aps: [ hall() ] }));
	const path = self.el.path;
	assert.equal(path.getAttribute('class'), 'vt-path vt-path-mesh', 'a router (WAN uplink): no sibling layout');
	const peer = path.find('vt-node-peer')[0];
	assert.deepEqual(peer.find('vt-node-body')[0].children.map(n => n.textContent), [ 'Access point', 'ap-hall', '192.0.2.10', 'up 1h 0m', '1 client · 2 wired', '↓ 73.0  ↑ 12.0 kbit/s' ]);
	assert.match(peer.getAttribute('title'), /Calls itself OpenWrt\nExample AP\n192\.0\.2\.10/, 'what it calls itself only as a detail');
	assert.ok(!path.all().some(n => n.tag === 'a' && /ap-hall|192\.0\.2\.10/.test(n.html())), 'no link to the access point');
	assert.deepEqual([ self.hero.gwKicker.textContent, self.hero.gwTitle.textContent, self.hero.gw.getAttribute('title') ], [ 'Internet', '203.0.113.2', 'Gateway 192.0.2.10' ],
		'the internet node stays the line\'s (its own address, the gateway in the tooltip: #88), with an access point at the gateway\'s address too');
	assert.equal(path.find('vt-node-ap')[0].find('vt-node-kicker')[0].textContent, 'This access point', 'no "This router"');
	/* its SSID: the station's row by this device's name for it */
	const rows = path.find('vt-leaf-row');
	assert.deepEqual(rows.map(r => r.children.map(c => c.textContent)), [
		/* this device's SSID: rows too, with an access point paired */
		[ 'Unknown device 53:01', '', '-50', '', '' ],
		[ 'Unknown device 53:02', '', '-80', '', '' ],
		/* ap-hall's SSID and its wired hosts, the busiest first */
		[ 'phone', '192.0.2.121', '-88', '↓64.0k', '↑8.00k' ],
		[ 'Unknown device 53:41', '', '100 Mbit/s', '↓9.00k', '↑4.00k' ],
		[ 'printer', '192.0.2.131', '1 Gbit/s', '', '' ]
	]);
	assert.match(self.heroKey(), new RegExp('\\naps=' + AP_ID + '=s:phy1-ap0,w$'));
}));

test('paired access points: one not reporting is dimmed with its state, without SSIDs or rows', () => withFakeDom(() => {
	for (const [ extra, text, more ] of [ [ { state: 'waiting', age: null, report: null }, 'Waiting for its first report' ],
		/* offline: why, where the collector says; when it last reported in the tooltip */
		[ { state: 'offline', error: 'unreachable', age: 120, report: null }, 'Not reachable over SSH', 'Offline · last report 2 min ago' ],
		[ { state: 'offline', error: 'timeout', age: null, report: null }, 'Did not answer in time', 'Offline' ],
		[ { state: 'offline', age: 120 }, 'Offline · last report 2 min ago' ], [ { state: 'offline', age: null }, 'Offline' ],
		[ { state: 'error', error: 'hostkey' }, 'Host key changed: pair again' ], [ { state: 'error', error: 'denied' }, 'Refused this device\'s key' ],
		[ { state: 'error', error: 'missing', report: null }, 'Vantage add-on not installed on it', 'Vantage\'s access point add-on is not installed on it' ],
		[ { state: 'error', error: 'unreachable' }, 'Not reachable over SSH' ], [ { state: 'error', error: 'timeout' }, 'Did not answer in time' ],
		[ { state: 'error', error: 'invalid' }, 'Sent a report that could not be read' ] ]) {
		const self = hero(apModel({ aps: [ hall(extra) ] }));
		const peer = self.el.path.find('vt-node-peer')[0];
		assert.match(peer.getAttribute('class'), /vt-node-off/);
		assert.equal(peer.find('vt-node-body')[0].children[4].textContent, text);
		assert.deepEqual(peer.getAttribute('title').split('\n').slice(0, more ? 2 : 1), more ? [ text, more ] : [ text ]);
		assert.equal(peer.find('vt-node-body')[0].children[5].textContent, '', 'no rates');
		const branch = self.el.path.find('vt-branch-peer')[0];
		assert.equal(branch.find('vt-node-ssid').length + branch.find('vt-leaf-row').length, 0, extra.state);
		assert.equal(self.m.clients.filter(c => c.ap).length, 0);
	}
}));

test('paired access points: on an access point their wires come from the gateway, an elbow only where it passes below this device', () => withFakeDom(() => {
	const m = apModel({ aps: [ hall() ] });
	m.uplink = Object.assign({}, m.uplink, { isWan: false });
	const self = hero(m);
	assert.match(self.el.path.getAttribute('class'), /vt-path-sib/);
	const w = self.wireList().filter(x => x.elbow)[0];
	assert.ok(w && w.from === self.hero.gw && w.alt === self.hero.ap);
	const wires = load('vantage.wires');
	const at = { gw: { l: 0, r: 150, t: 50, b: 100, cy: 75 }, ap: { l: 300, r: 480, t: 50, b: 110, cy: 80 } };
	/* the choice drawWires makes, on the rects it measures */
	const pick = to => (to.l > at.gw.r && to.cy > at.ap.b) ? 'elbow' : 'curve';
	assert.equal(pick({ l: 600, r: 800, t: 200, b: 260, cy: 230 }), 'elbow');
	assert.equal(pick({ l: 600, r: 800, t: 50, b: 110, cy: 80 }), 'curve', 'beside the device: it would cross it');
	assert.equal(pick({ l: 34, r: 300, t: 400, b: 460, cy: 430 }), 'curve', 'stacked (a phone)');
	assert.match(wires.elbow(at.gw, { l: 600, t: 200, b: 260, cy: 230 }).d, /^M24\.0 100\.0V220\.0Q/);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes('var elbow = !!w.elbow && rect(w.to).l > rect(w.from).r && rect(w.to).cy > rect(w.alt).b;'), 'the same rule as drawWires');
}));

test('paired access points: chips per access point id and one for this device, by what each lists; a host noted behind one is still on its port', () => {
	const self = Object.create(view);
	const m = apModel({ aps: [ hall({}, { stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -88 }, { mac: '00:00:5e:00:53:22', ifname: 'phy1-ap0', signal: -60 } ] }),
		hall({ id: 'fedcba9876543210', name: 'ap-den', state: 'offline' }, { mac: '02:00:5e:10:00:02' }) ] });
	self.m = m;
	self.st = { staRates: {}, devRates: {} };
	self.el = { clients: { scrollIntoView() {} }, filter: {} };
	self.paintClients = () => {};
	self.ui = { kind: 'wifi', chip: 'all', filter: '' };
	const defs = () => self.filterDefs().map(d => d.slice(0, 3));
	assert.deepEqual(defs().filter(d => d[0] === 'here' || /^ap:/.test(d[0])), [ [ 'here', 'This device', 2 ], [ 'ap:' + AP_ID, 'Via ap-hall', 2 ] ], 'none for one without stations');
	const ids = list => list.filter(c => self.matches(c)).map(c => c.mac.slice(-2));
	self.ui.chip = 'ap:' + AP_ID;
	assert.deepEqual(ids(m.clients), [ '21', '22' ]);
	self.ui.chip = 'here';
	assert.deepEqual(ids(m.clients), [ '01', '02' ]);
	self.ui.chip = 'all';
	self.ui.filter = 'ap-hall';
	assert.deepEqual(ids(m.clients), [ '21', '22' ], 'found by the access point\'s name');
	self.ui.filter = '192.0.2.10';
	assert.deepEqual(ids(m.clients), [ '21', '22' ], 'and its address');
	self.ui.filter = '';

	self.ui.kind = 'wired';
	assert.deepEqual(defs(), [ [ 'all', 'All', 4 ], [ 'port:lan1', 'lan1', 2 ], [ 'port:lan2', 'lan2', 1 ], [ 'here', 'This device', 3 ], [ 'ap:' + AP_ID, 'Via ap-hall', 2 ] ],
		'the noted host counts on its port and here; the added one on no port');
	self.ui.chip = 'port:lan1';
	assert.deepEqual(ids(m.wiredHosts), [ '01', '31' ]);
	self.ui.chip = 'ap:' + AP_ID;
	assert.deepEqual(ids(m.wiredHosts), [ '31', '41' ], 'added, or heard here behind it');
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ], 'no port for an added host');

	/* the branch opens the list it has entries in */
	const saved = global.window;
	global.window = { matchMedia: () => ({ matches: true }) };
	try {
		self.showAp(AP_ID);
		assert.deepEqual([ self.ui.kind, self.ui.chip ], [ 'wifi', 'ap:' + AP_ID ]);
		self.showAp('fedcba9876543210');
		assert.deepEqual([ self.ui.kind, self.ui.chip ], [ 'wired', 'ap:fedcba9876543210' ]);
	} finally { global.window = saved; }
});

test('paired access points: a host moved from the wired list to an access point\'s station: its branch, the chips and both lists agree', () => withFakeDom(() => {
	/* the printer, heard on lan1 behind ap-hall, is one of its stations */
	const stations = [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -60 }, { mac: '00:00:5e:00:53:31', ifname: 'phy1-ap0', signal: -58, rx: 1000, tx: 2000 } ];
	const before = apModel({ aps: [ hall({}, { stations: stations.slice(0, 1) }) ] });
	const m = apModel({ aps: [ hall({}, { stations }) ] });
	assert.deepEqual([ m.clients.length, m.wiredHosts.length ], [ before.clients.length + 1, before.wiredHosts.length - 1 ]);
	const self = hero(m);
	self.ui = { kind: 'wifi', chip: 'all', filter: '' };
	const chip = id => self.filterDefs().filter(d => d[0] === id)[0];
	assert.deepEqual(chip('ap:' + AP_ID).slice(0, 3), [ 'ap:' + AP_ID, 'Via ap-hall', 2 ]);
	assert.deepEqual(chip('all')[2], m.clients.length);
	self.ui.chip = 'ap:' + AP_ID;
	assert.deepEqual(m.clients.filter(c => self.matches(c)).map(c => c.name), [ 'phone', 'printer' ]);
	/* its branch: 2 clients, the printer's row on its SSID by the router's name */
	const peer = self.el.path.find('vt-node-peer')[0];
	assert.equal(peer.find('vt-node-body')[0].children[4].textContent, '2 clients · 1 wired', 'as the chips: the printer is a client now');
	const ssid = self.el.path.find('vt-branch-peer')[0].find('vt-node-ssid')[0];
	assert.deepEqual(ssid.find('vt-leaf-name').map(n => n.textContent), [ 'printer', 'phone' ]);
	assert.equal(ssid.find('vt-node-sub')[0].textContent, '2 clients');
	/* the wired list: lan1 keeps ap-hall itself, the printer is gone from it */
	self.ui = { kind: 'wired', chip: 'all', filter: '' };
	assert.deepEqual(self.filterDefs().map(d => d.slice(0, 3)).filter(d => /^(all|port:|here|ap:)/.test(d[0])),
		[ [ 'all', 'All', 3 ], [ 'port:lan1', 'lan1', 1 ], [ 'port:lan2', 'lan2', 1 ], [ 'here', 'This device', 2 ], [ 'ap:' + AP_ID, 'Via ap-hall', 1 ] ]);
	assert.deepEqual(self.wiredPorts(), [ 'lan1', 'lan2' ]);
	assert.ok(!m.wiredHosts.some(h => h.mac === '00:00:5e:00:53:31'));
}));

/* review F2, F3: a branch shows what the model gave its access point, as
   the lists and the chips do, never what the access point reports */
test('paired access points: a MAC an access point claims that stayed this device\'s, or went to another, is no row or count of its branch', () => withFakeDom(() => {
	const claim = (mac, signal) => ({ mac, ifname: 'phy1-ap0', signal, rxRate: 72200, txRate: 144400, rx: 8000, tx: 64000 });
	/* this device's own station and a host on lan2 (ap-hall is on lan1), with strong signals */
	const m = apModel({ aps: [ hall({}, { stations: [ claim('00:00:5e:00:53:01', -20), claim('00:00:5e:00:53:32', -21), claim('00:00:5e:00:53:21', -60) ],
		wired: [ { mac: '00:00:5e:00:53:32', port: 'lan9', speed: 10, rx: 1, tx: 1 }, { mac: '00:00:5e:00:53:02', port: 'lan9' } ] }) ] });
	const self = hero(m);
	const branch = self.el.path.find('vt-branch-peer')[0], peer = branch.find('vt-node-peer')[0];
	assert.deepEqual(branch.find('vt-leaf-row').map(r => r.children.map(c => c.textContent)), [ [ 'phone', '192.0.2.121', '-60', '↓64.0k', '↑8.00k' ] ]);
	assert.equal(peer.find('vt-node-body')[0].children[4].textContent, '1 client');
	assert.equal(peer.find('vt-node-body')[0].children[5].textContent, '↓ 64.0  ↑ 8 kbit/s', 'its traffic: its one station\'s');
	assert.equal(branch.find('vt-node-ssid').length, 1, 'no wired node: no host is behind it');
	self.ui = { kind: 'wifi', chip: 'all', filter: '' };
	assert.deepEqual(self.filterDefs().filter(d => /^ap:/.test(d[0])).map(d => d.slice(1, 3)), [ [ 'Via ap-hall', 1 ] ], 'the chip agrees');
	assert.doesNotMatch(self.heroKey(), /,w$/);

	/* a station two list: under the one that hears it best, once */
	const two = apModel({ aps: [ hall({}, { stations: [ claim('00:00:5e:00:53:51', -70) ], wired: [] }),
		hall({ id: 'fedcba9876543210', name: 'ap-den' }, { mac: '02:00:5e:10:00:02', stations: [ claim('00:00:5e:00:53:51', -50) ], wired: [] }) ] });
	const both = hero(two);
	const branches = both.el.path.find('vt-branch-peer');
	assert.deepEqual(branches.map(b => b.find('vt-leaf-row').length), [ 0, 1 ]);
	assert.deepEqual(branches.map(b => b.find('vt-node-peer')[0].find('vt-node-body')[0].children[4].textContent), [ '0 clients', '1 client' ]);
	assert.deepEqual(branches.map(b => b.find('vt-node-ssid')[0].find('vt-node-sub')[0].textContent), [ '0 clients', '1 client' ]);
	both.ui = { kind: 'wifi', chip: 'all', filter: '' };
	assert.deepEqual(both.filterDefs().filter(d => /^ap:/.test(d[0])).map(d => d.slice(1, 3)), [ [ 'Via ap-den', 1 ] ]);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.doesNotMatch(src, /\ba\.(sta|hosts)\b/, 'the view never reads a report\'s own lists');
}));

/* review F4: insight.presence (insight.test.js) needs to know which access
   points are reporting now */
test('paired access points: presence is told which ones report now', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const calls = [ ...src.matchAll(/insight\.presence\(([\s\S]*?)\);\n/g) ].map(m => m[1].replace(/\s+/g, ' '));
	assert.deepEqual(calls, [ "st.presence, m.clients, now, GONE_KEEP_MS, m.accessPoints.filter(function(a) { return a.state === 'ok'; }).map(function(a) { return a.id; })" ]);
});

/* review F5 */
test('paired access points: an SSID node and the wired node never share an id, whatever the interface is called', () => withFakeDom(() => {
	const ssid = ifname => ({ ifname, ssid: 'Hall', freq: 5180, channel: 36, band: '5g' });
	const key = report => Object.assign(Object.create(dview), { m: apModel({ aps: [ hall({}, report) ] }) }).heroKey();
	const two = key({ ssids: [ ssid('x'), ssid('w') ], stations: [], wired: [] });
	const wired = key({ ssids: [ ssid('x') ], stations: [], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan3' } ] });
	assert.deepEqual([ two.split('\n').pop(), wired.split('\n').pop() ], [ 'aps=' + AP_ID + '=s:x,s:w', 'aps=' + AP_ID + '=s:x,w' ]);
	const self = hero(apModel({ aps: [ hall({}, { ssids: [ ssid('w'), ssid(':wired'), ssid('wired') ], stations: [], wired: [ { mac: '00:00:5e:00:53:61', port: 'lan3' } ] }) ] }));
	assert.deepEqual(self.m.accessPoints[0].nodes.map(n => n.id), [ 'w', 'wired' ], 'no interface has a colon in its name');
	const keys = self.wireList().map(w => w.key);
	assert.equal(new Set(keys).size, keys.length, 'one wire a key');
	assert.deepEqual(keys.filter(k => k.includes(':ap:')), [ 'r::ap:' + AP_ID, 's::ap:' + AP_ID + ':s:w', 's::ap:' + AP_ID + ':s:wired', 's::ap:' + AP_ID + ':w' ]);
	assert.deepEqual(self.el.path.find('vt-branch-peer')[0].find('vt-ssid-name').map(n => n.textContent), [ '5 GHz Hall', '5 GHz Hall', 'Wired' ]);
}));

/* review F8 (names): a pairing name has up to 63 characters */
test('paired access points: a long name is cut in the list\'s pill and link cell, whole in their titles', () => withFakeDom(() => {
	const long = 'a' + 'b'.repeat(62);
	const self = Object.create(dview);
	self.m = apModel({ aps: [ hall({ name: long }) ] });
	self.st = { staRates: {}, devRates: {} };
	const added = self.m.wiredHosts.filter(h => h.ap)[0], noted = self.m.wiredHosts.filter(h => h.behind)[0];
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const cells = tree(self.wiredCells(added, 0));
	const pill = cells.find('vt-pill-ap')[0], link = cells.find('vt-phy-ap')[0];
	assert.deepEqual([ pill.textContent, pill.getAttribute('title') ], [ 'via ' + long, 'Wired to ' + long + ', port lan3' ]);
	assert.equal(link.textContent, long + ' · lan3');
	assert.equal(cells.find('vt-td-link')[0].getAttribute('title'), 'Port lan3 of ' + long);
	assert.equal(tree(self.wiredCells(noted, 0)).find('vt-pill-ap')[0].getAttribute('title'), 'Behind ' + long + ', its port lan2');
	const css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8');
	/* the link cell's line is a flex row elsewhere: a block here, or no ellipsis shows */
	assert.match(css, /\.vt-app \.vt-phy\.vt-phy-ap \{ display: block;/);
	for (const cls of [ 'vt-pill-ap', 'vt-phy.vt-phy-ap', 'vt-net-via' ]) {
		const body = (new RegExp('\\.vt-app \\.' + cls.replace(/\./g, '\\.') + ' \\{([^}]*)\\}').exec(css) || [])[1] || '';
		for (const decl of [ 'max-width: 150px;', 'overflow: hidden;', 'text-overflow: ellipsis;' ]) assert.ok(body.includes(decl), cls + ': ' + decl);
	}
}));

test('paired access points: their stations in no warning, picture or head count, and their rates are theirs', () => withFakeDom(() => {
	const self = Object.create(dview);
	/* its station on 2.4 GHz, this device's on 5 GHz */
	const m = apModel({ aps: [ hall({}, { ssids: [ { ifname: 'phy1-ap0', ssid: 'Hall', freq: 2437, channel: 6, band: '2g' } ] }) ] });
	self.m = m;
	self.quiet = {};
	const remote = m.clients.filter(c => c.ap)[0];
	assert.equal(remote.signal, -88);
	assert.equal(self.isWeak(remote), false);
	assert.equal(self.isWeak(m.clients.filter(c => c.mac === '00:00:5e:00:53:02')[0]), true);
	assert.deepEqual(self.signalPicture()[0].children.map(n => [ n.getAttribute('class'), n.style.width ]), [ [ 'vt-dist-4', '50.00%' ], [ 'vt-dist-1', '50.00%' ] ]);
	assert.deepEqual(self.bandPicture()[0].children.map(n => [ n.getAttribute('class'), n.style.width ]), [ [ 'vt-chip-band vt-band-5g', '100.00%' ] ], 'no 2.4 GHz of the access point\'s');
	self.st = { summary: { level: 'ok', headline: 'x' } };
	self.el = { orb: {}, headline: new FNode('div'), subline: new FNode('div') };
	self.board = {};
	global.document.documentElement = { setAttribute() {} };
	self.paintHead();
	assert.match(self.el.subline.textContent, /2 clients$/, 'this device\'s two, not the access point\'s');
}));

test('paired access points: the list and the drawers show the address as text and link to no other host', t => withFakeDom(() => {
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	t.after(() => { global.L = savedL; });
	const self = Object.create(dview);
	const m = apModel({ aps: [ hall() ] });
	self.m = m;
	self.st = { staRates: { '00:00:5e:00:53:21': { rx: 8000, tx: 64000 } }, devRates: {}, clientHist: {}, gone: [] };
	self.ui = {};
	self.el = {};
	self.quiet = {};
	self.canWrite = false;
	const remote = m.clients.filter(c => c.ap)[0];
	const added = m.wiredHosts.filter(h => h.ap)[0], noted = m.wiredHosts.filter(h => h.behind)[0];
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const client = tree(self.drawerClient(remote.mac).body);
	assert.match(client.textContent, /Connected to ap-hall, a paired access point/);
	assert.match(client.textContent, /Access pointap-hall192\.0\.2\.10/);
	assert.match(client.textContent, /To device144 Mbit\/sFrom device72\.2 Mbit\/s/);
	assert.doesNotMatch(client.html(), /vt-quiet/, 'no quiet row: it is in no warning');
	const wired = tree(self.drawerWired(added).body);
	assert.match(wired.textContent, /Access pointap-hall192\.0\.2\.10Portlan3/);
	const local = tree(self.drawerWired(noted).body);
	assert.match(local.textContent, /Portlan1/, 'heard here: its own port');
	assert.match(local.textContent, /Access pointap-hallits port lan2/);
	assert.ok(local.all().some(n => n.tag === 'a'), 'this device\'s own page link stays');
	for (const t of [ client, wired, tree(self.clientCells(remote, 0)), tree(self.wiredCells(added, 0)) ])
		assert.ok(!t.all().some(n => n.tag === 'a'), 'no link on a paired access point\'s entry');
	const cells = tree(self.wiredCells(noted, 0));
	assert.ok(cells.find('vt-pill').some(p => p.textContent === 'behind ap-hall' && p.getAttribute('title') === 'Behind ap-hall, its port lan2'));
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.doesNotMatch(src, /\.(hostname|host|port|protocol|pathname)\s*=[^=]/, 'no address put into a link');
	/* one link leaves the router, and it is a constant: the changelog ("What's new", below) */
	assert.deepEqual(src.match(/'href': [^,}]+, 'target': '_blank'/g), [ "'href': NEWS_URL, 'target': '_blank'" ]);
	assert.equal(src.split('_blank').length - 1, 1, 'no other link opens a new tab');
}));

/* the model keeps the other access points that list an entry on it (ap.also,
   behind.also): named in the entry's details, nowhere else */
test('paired access points: an entry another one reports too names it in its details only: one line, as text, not in the list or on the path', t => withFakeDom(() => {
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	t.after(() => { global.L = savedL; });
	const DEN_ID = 'fedcba9876543210', DEN = { id: DEN_ID, name: 'ap-den' };
	/* ap-den hears ap-hall's station too, weaker, and lists the same wired host */
	const den = hall({ id: DEN_ID, name: 'ap-den', addr: '192.0.2.11' }, { mac: '02:00:5e:10:00:02',
		ssids: [ { ifname: 'phy0-ap0', bssid: '00:00:5e:00:53:b0', ssid: 'Den', freq: 2437, channel: 6, band: '2g' } ],
		stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy0-ap0', signal: -95 } ], wired: [ { mac: '00:00:5e:00:53:41', port: 'lan9', speed: 10 } ] });
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const page = m => Object.assign(Object.create(dview), { m, st: { staRates: {}, devRates: {}, clientHist: {}, gone: [] }, ui: {}, el: {}, quiet: {}, canWrite: false });
	const parts = m => ({ remote: m.clients.filter(c => c.ap)[0], added: m.wiredHosts.filter(h => h.ap)[0], noted: m.wiredHosts.filter(h => h.behind)[0] });
	const drawers = (self, e) => [ tree(self.drawerClient(e.remote.mac).body), tree(self.drawerWired(e.added).body), tree(self.drawerWired(e.noted).body) ];
	const lines = n => n.all().filter(s => s.tag === 'small' && /^Also reported by /.test(s.textContent));
	const rows = (self, e) => [ tree(self.clientCells(e.remote, 0)).html(), tree(self.wiredCells(e.added, 0)).html(), tree(self.wiredCells(e.noted, 0)).html() ];

	/* one access point: no line anywhere */
	const one = apModel({ aps: [ hall() ] });
	for (const d of drawers(page(one), parts(one))) assert.doesNotMatch(d.textContent, /Also reported/);

	const m = apModel({ aps: [ hall(), den ] }), e = parts(m), self = page(m);
	assert.deepEqual([ e.remote.ap.name, e.remote.ap.also, e.added.ap.name, e.added.ap.also ], [ 'ap-hall', [ DEN ], 'ap-hall', [ DEN ] ], 'placed as with one, the other kept by the model');
	/* a host of this device noted as behind ap-hall: the model's field for another that lists it there (tests/model.test.js) */
	e.noted.behind.also = [ DEN ];
	const [ client, wired, local ] = drawers(self, e);
	assert.match(client.textContent, /Access pointap-hall192\.0\.2\.10Also reported by ap-denBSSID/, 'under the access point it is on');
	assert.match(wired.textContent, /Access pointap-hall192\.0\.2\.10Also reported by ap-denPortlan3/);
	assert.match(local.textContent, /Access pointap-hallits port lan2Also reported by ap-den/);
	for (const d of [ client, wired, local ]) {
		assert.deepEqual(lines(d).map(s => s.childNodes), [ [ 'Also reported by ap-den' ] ], 'one line, a text node');
		assert.equal(d.textContent.split('Also reported').length, 2, 'once');
	}
	/* several: their names in the model's order, joined; a name is text whatever it holds */
	e.remote.ap.also = [ DEN, { id: '1111111111111111', name: 'ap-loft' }, { id: '2222222222222222', name: '<b>attic</b>' } ];
	const many = tree(self.drawerClient(e.remote.mac).body);
	assert.deepEqual(lines(many).map(s => s.childNodes), [ [ 'Also reported by ap-den, ap-loft, <b>attic</b>' ] ]);
	assert.ok(!many.all().some(n => n.tag === 'b'), 'no element made of a name');
	/* an empty or broken field: no line */
	for (const junk of [ [], null, 'ap-den', {} ]) {
		e.remote.ap.also = junk;
		assert.deepEqual(lines(tree(self.drawerClient(e.remote.mac).body)), [], JSON.stringify(junk));
	}

	/* the list rows and the path are as without the field */
	e.remote.ap.also = [ DEN ];
	const withAlso = rows(self, e), path = hero(m).el.path.html();
	for (const r of withAlso.concat([ path ])) assert.doesNotMatch(r, /Also reported/);
	delete e.remote.ap.also; delete e.added.ap.also; delete e.noted.behind.also;
	assert.deepEqual(rows(self, e), withAlso, 'the rows');
	assert.equal(hero(m).el.path.html(), path, 'the path');
}));

test('paired access points: the report rides the slow poll; a failed call is none, never the last answer', async () => {
	const saved = { L: global.L, document: global.document, now: Date.now };
	let t = 1e12, reply = { aps: [ { id: AP_ID } ] }, low = false, asked = 0;
	Date.now = () => t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? (low ? 'low' : null) : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({});
	REPLIES['luci.vantage thermal'] = () => Promise.resolve([]);
	REPLIES['luci.vantage wired'] = () => Promise.resolve({ hosts: [] });
	REPLIES['vantage.collector report'] = () => { asked++; return reply ? Promise.resolve(reply) : Promise.reject(new Error('XHR request timed out')); };
	REPLIES['session access'] = (scope, object, fn) => Promise.resolve(scope === 'access-group' && object === 'luci-app-vantage-aps-view' && fn === 'read');
	const self = Object.create(view);
	try {
		assert.deepEqual((await self.fetch()).collector, reply);
		reply = null;
		t += 5e3;
		assert.equal((await self.fetch()).collector, null, 'failed: no access points, not the last answer');
		reply = { aps: [] };
		low = true;
		t += 30e3;
		const a = await self.fetch();
		t += 5e3;
		const b = await self.fetch();
		assert.deepEqual([ a.collector, b.collector, asked ], [ reply, reply, 3 ], 'Low-power router: once a slow poll, kept until the next');
		reply = null;
		t += 30e3;
		assert.equal((await self.fetch()).collector, null);
		t += 5e3;
		assert.equal((await self.fetch()).collector, null, 'and none until the next slow poll answers');
		for (const junk of [ 'x', [ 1 ] ]) {
			reply = junk; low = false; t += 5e3;
			assert.equal((await self.fetch()).collector, null, JSON.stringify(junk));
		}
	} finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|vantage\.collector|session access)/.test(k)) delete REPLIES[k];
	}
});

/* The add-on's call must not be able to hold up the dashboard. fetch() with
   the test's timers and clock: nothing here waits for real */
async function collectorPolls(fn) {
	const saved = { L: global.L, document: global.document, now: Date.now, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
	const c = { t: 1e12, timers: [], seq: 0, asked: 0, calls: [], assoc: 0, answer: null, may: true, probed: 0 };
	Date.now = () => c.t;
	global.setTimeout = (f, ms) => { const id = ++c.seq; c.timers.push({ id, f, at: c.t + ms }); return id; };
	global.clearTimeout = id => { c.timers = c.timers.filter(x => x.id !== id); };
	/* promise callbacks run, then the timers that are due ms later, then promise callbacks again */
	c.flush = () => new Promise(r => setImmediate(r));
	c.advance = async ms => {
		await c.flush();
		c.t += ms;
		for (const x of c.timers.filter(x => x.at <= c.t)) { c.timers = c.timers.filter(y => y !== x); x.f(); }
		await c.flush();
	};
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({ radio0: { up: true, config: { band: '5g' }, interfaces: [ { ifname: 'phy0-ap0', section: 'a', config: { mode: 'ap', ssid: 'Home' } } ] } });
	REPLIES['luci.vantage thermal'] = () => Promise.resolve([]);
	REPLIES['luci.vantage wired'] = () => Promise.resolve({ hosts: [ { mac: '00:00:5e:00:53:31', port: 'lan1', bridge: 'br-lan', seen: 1 } ] });
	REPLIES['iwinfo assoclist'] = () => { c.assoc++; return Promise.resolve([ { mac: '00:00:5E:00:53:01', signal: -50 } ]); };
	/* c.answer: a reply for a call that answers at once; null for one that stays out until the test settles it (c.calls) */
	REPLIES['vantage.collector report'] = () => {
		c.asked++;
		return c.answer ? c.answer() : new Promise((resolve, reject) => { c.calls.push({ resolve, reject }); });
	};
	/* c.may: whether the login has the add-on's read group (rpcd answers false for a group that is not there);
	   c.probed: the questions about that group (LuCI's WireGuard group is asked about too, once: its own tests) */
	REPLIES['session access'] = (scope, object, fn) => { if (object === 'luci-app-vantage-aps-view') c.probed++; return Promise.resolve(scope === 'access-group' && object === 'luci-app-vantage-aps-view' && fn === 'read' && c.may); };
	c.self = Object.create(view);
	/* a poll started now: [ its result once it has one, else null ] */
	c.poll = () => { const box = [ null ]; c.self.fetch().then(r => { box[0] = r; }, e => { box[0] = e; }); return box; };
	try { await fn(c); }
	finally {
		Object.assign(global, { L: saved.L, setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout });
		Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|vantage\.collector|iwinfo assoclist|session access)/.test(k)) delete REPLIES[k];
	}
}

test('paired access points: the collector\'s call is a request of its own, and a poll waits 4 s for it at most', () => collectorPolls(async c => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	/* LuCI sends the calls of one moment as one request and answers them together, unless one says nobatch */
	const alone = [ ...src.matchAll(/rpc\.declare\(\{ object: '([^']+)', method: '([^']+)'[^\n]*\bnobatch: true[^\n]*\}\)/g) ].map(m => m[1] + ' ' + m[2]);
	assert.deepEqual(alone, [ 'vantage.collector report' ]);

	/* it does not answer: the device's own calls are made and answered as always */
	const first = c.poll();
	await c.advance(0);
	assert.deepEqual([ c.asked, c.assoc, c.timers.length ], [ 1, 1, 1 ], 'asked once; the stations asked for meanwhile; one deadline');
	assert.equal(first[0], null, 'the poll waits');
	await c.advance(3999);
	assert.equal(first[0], null, 'up to the deadline');
	await c.advance(1);
	assert.ok(first[0] && !(first[0] instanceof Error), 'and then goes on');
	assert.deepEqual([ first[0].fdb.map(h => h.mac), first[0].assoc['phy0-ap0'].length, first[0].collector ], [ [ '00:00:5e:00:53:31' ], 1, null ],
		'with the poll\'s other data, and the access points it had: none');
	assert.deepEqual([ first[0].started, first[0].at ], [ 1e12, 1e12 ], 'stamped when the device answered, not when the wait ended');
	assert.equal(c.timers.length, 0);
}));

/* The dashboard without the add-on (every user of 1.0.x), and a login that has the dashboard alone: the add-on's
   read group is not theirs, and rpcd says so once */
test('paired access points: a login without the add-on\'s read group never calls the collector, and is asked about the group once', () => collectorPolls(async c => {
	c.may = false;
	c.answer = () => Promise.resolve({ aps: [ { id: AP_ID } ] });
	for (let i = 0; i < 30; i++) {
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual([ p[0] && p[0].collector, c.asked, c.timers.length ], [ null, 0, 0 ], 'poll ' + i);
		await c.advance(5e3);
	}
	assert.equal(c.probed, 1, 'one question about the group for the whole page');
}));

test('paired access points: where no collector answers (nothing paired), it is asked again once a minute, not every poll', () => collectorPolls(async c => {
	const reply = { aps: [ { id: AP_ID } ] };
	c.answer = () => Promise.reject(new Error('RPC call to vantage.collector/report failed with error -32000: Object not found'));
	for (let i = 0; i < 12; i++) {
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual([ p[0] && p[0].collector, c.asked ], [ null, 1 ], 'poll ' + i + ': not asked again');
		await c.advance(5e3);
	}
	/* a minute after that answer: again, and an access point paired meanwhile is there */
	c.answer = () => Promise.resolve(reply);
	const p = c.poll();
	await c.advance(0);
	assert.deepEqual([ p[0].collector, c.asked ], [ reply, 2 ]);
	/* any other failure (a timeout, a refusal) is asked again at the next poll, as before */
	for (const text of [ 'XHR request timed out', 'RPC call to vantage.collector/report failed with error -32002: Access denied' ]) {
		c.answer = () => Promise.reject(new Error(text));
		await c.advance(5e3);
		c.poll();
		await c.advance(0);
		const asked = c.asked;
		c.answer = () => Promise.resolve(reply);
		await c.advance(5e3);
		const q = c.poll();
		await c.advance(0);
		assert.deepEqual([ q[0].collector, c.asked ], [ reply, asked + 1 ], text);
	}
}));

test('paired access points: an answer from before a pause is not shown as this poll\'s', () => collectorPolls(async c => {
	const reply = { aps: [ { id: AP_ID } ] }, newer = { aps: [ { id: AP_ID, name: 'ap-hall' } ] };
	c.answer = () => Promise.resolve(reply);
	const ok = c.poll();
	await c.advance(0);
	assert.deepEqual(ok[0].collector, reply);
	/* the tab was hidden for ten minutes; the first call after it stays out past the deadline */
	c.answer = null;
	await c.advance(600e3);
	const back = c.poll();
	await c.advance(4e3);
	assert.deepEqual([ back[0] && back[0].collector, c.asked ], [ null, 2 ], 'no access points rather than those of ten minutes ago');
	/* its answer, late, is the next poll's */
	c.calls.shift().resolve(newer);
	c.answer = () => Promise.resolve(newer);
	await c.advance(5e3);
	const next = c.poll();
	await c.advance(0);
	assert.deepEqual(next[0].collector, newer);
}));

test('paired access points: while the collector\'s call is out no second one is made and no later poll waits; its late answer is the next poll\'s', () => collectorPolls(async c => {
	const reply = { aps: [ { id: AP_ID } ] }, newer = { aps: [ { id: AP_ID, name: 'ap-hall' } ] };
	/* an answer in time, as before */
	c.answer = () => Promise.resolve(reply);
	const ok = c.poll();
	await c.advance(0);
	assert.deepEqual([ ok[0].collector, c.asked, c.timers.length ], [ reply, 1, 0 ], 'no waiting, and no deadline left behind');
	/* the next call does not answer: the poll goes on with the answer it had */
	c.answer = null;
	await c.advance(5e3);
	const late = c.poll();
	await c.advance(4e3);
	assert.ok(late[0], 'the poll is over at the deadline');
	assert.deepEqual([ late[0].collector, c.asked ], [ reply, 2 ]);
	/* the polls after it: no second call beside the one that is out, and no wait. The answer it had stands for two
	   slow polls and the wait; older than that it says nothing of now, and no access points are shown */
	for (let i = 0; i < 3; i++) {
		await c.advance(5e3);
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual([ p[0] && p[0].collector, c.asked, c.calls.length, c.timers.length ], [ i === 0 ? reply : null, 2, 1, 0 ], 'poll ' + i);
	}
	/* it answers after all: the next poll has that answer, and asks again */
	c.calls.shift().resolve(newer);
	await c.advance(5e3);
	const next = c.poll();
	await c.advance(0);
	assert.deepEqual([ next[0], c.asked, c.calls.length ], [ null, 3, 1 ], 'a new call, out again');
	await c.advance(4e3);
	assert.deepEqual(next[0] && next[0].collector, newer);
	/* Low-power router, between two slow polls: the late answer is not kept back for the next slow one */
	c.answer = () => Promise.resolve(newer);
	c.calls.shift().resolve(newer);
	global.document.documentElement.getAttribute = k => k === 'data-vt-power' ? 'low' : null;
	await c.advance(30e3);
	const slow = c.poll();
	await c.advance(0);
	assert.deepEqual([ slow[0].collector, c.asked ], [ newer, 4 ]);
	c.answer = null;
	await c.advance(30e3);
	const out = c.poll();
	await c.advance(4e3);
	assert.deepEqual([ out[0] && out[0].collector, c.asked ], [ newer, 5 ]);
	c.calls.shift().resolve(reply);
	await c.advance(5e3);
	const between = c.poll();
	await c.advance(0);
	assert.deepEqual([ between[0].collector, c.asked ], [ reply, 5 ], 'no call of its own, the answer that came in');
}));

test('paired access points: a failed collector call shows nothing, in time or late: no access points, no error, never the last answer', () => collectorPolls(async c => {
	const model = load('vantage.model'), reply = { aps: [ { id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', state: 'waiting', error: null, age: null, report: null } ] };
	/* no such object (the add-on not installed, nothing paired), the login may not read it, no answer in LuCI's time */
	const failures = [ 'RPC call to vantage.collector/report failed with error -32000: Object not found',
		'RPC call to vantage.collector/report failed with error -32002: Access denied', 'XHR request timed out' ];
	const shown = r => model.build({ ifaces: r.ifaces, devs: r.devs, fdb: r.fdb, collector: r.collector }).accessPoints.map(a => a.name);
	for (const text of failures) {
		c.answer = () => Promise.resolve(reply);
		await c.advance(5e3);
		const had = c.poll();
		await c.advance(0);
		assert.deepEqual(shown(had[0]), [ 'ap-hall' ], 'the control');
		/* refused at once */
		c.answer = () => Promise.reject(new Error(text));
		await c.advance(5e3);
		const p = c.poll();
		await c.advance(0);
		assert.ok(p[0] && !(p[0] instanceof Error), text + ': the poll itself does not fail');
		assert.deepEqual([ p[0].collector, shown(p[0]), c.timers.length ], [ null, [], 0 ], text);
		assert.deepEqual(model.build({ ifaces: p[0].ifaces, devs: p[0].devs, fdb: p[0].fdb, collector: p[0].collector }),
			model.build({ ifaces: p[0].ifaces, devs: p[0].devs, fdb: p[0].fdb }), text + ': as without the add-on');
		/* refused after the deadline: the poll that waited keeps what it had, the next one has none */
		c.answer = () => Promise.resolve(reply);
		await c.advance(60e3);
		c.poll();
		await c.advance(0);
		c.answer = null;
		await c.advance(5e3);
		const waited = c.poll();
		await c.advance(4e3);
		assert.ok(waited[0], text + ': the poll is over at the deadline');
		assert.deepEqual(shown(waited[0]), [ 'ap-hall' ], text + ': still out');
		c.calls.shift().reject(new Error(text));
		c.answer = () => new Promise(() => {});
		await c.advance(5e3);
		const after = c.poll();
		await c.advance(4e3);
		assert.ok(after[0], text + ': and the one after it');
		assert.deepEqual([ after[0].collector, shown(after[0]) ], [ null, [] ], text + ': late');
		/* that last call never settles: the next round starts as if it had */
		c.self.collectorCall = null;
		await c.advance(60e3);
	}
	/* an answer that is no report (LuCI gives {} for a ubus status without data) names none either */
	for (const junk of [ {}, 'x', [ 1 ], 7 ]) {
		c.answer = () => Promise.resolve(junk);
		await c.advance(5e3);
		const p = c.poll();
		await c.advance(0);
		assert.deepEqual(shown(p[0]), [], JSON.stringify(junk));
	}
}));

/* ------------------------------------------------------------ search */

/* the dashboard as the theme's palette asks it (vantage:palette): a model
   of its own, the Clients tile shown or hidden, and what its entries'
   functions call. A view of its own: the one above has kept the menu of
   an earlier test, and the Interfaces page with it */
const searchView = loadView();
function searching(m, shown) {
	const self = Object.create(searchView);
	self.m = Object.assign({ clients: [], wiredHosts: [], radios: [], ssids: [], accessPoints: [], uplinks: [], networks: [] }, m);
	self.el = { clients: { scrollIntoView() {}, getClientRects: () => shown === false ? [] : [ {} ] }, filter: {} };
	self.did = [];
	self.openDrawer = function(kind, id) { this.did.push([ 'drawer', kind, id ]); };
	self.closeDrawer = function() { this.did.push([ 'close' ]); };
	self.filterSsid = function(ssid) { this.did.push([ 'ssid', ssid ]); };
	return self;
}
const sta = (mac, name, extra) => Object.assign({ mac, name, secondary: mac.toUpperCase(), ssid: 'Harbor', ips: [] }, extra);
const says = list => list.map(e => [ e.kind, e.title, e.detail ]);

test('search: clients by name, MAC or address, a paired access point\'s with its name; Enter opens their details', () => {
	const self = searching({
		clients: [
			sta('00:00:5e:00:53:21', 'Living room TV', { secondary: '192.0.2.21', ips: [ '192.0.2.21', '2001:db8::21' ], ssid: 'Harbor-5G' }),
			sta('02:00:5e:00:53:0f', 'Private device 53:0F'),
			sta('00:00:5e:00:53:31', 'den-phone', { secondary: '192.0.2.31', ips: [ '192.0.2.31' ], ssid: 'Harbor-5G', ap: { id: 'a1', name: 'ap-den', node: 'phy1-ap0' } })
		],
		wiredHosts: [
			{ mac: '00:00:5e:00:53:41', name: 'office-printer', secondary: '192.0.2.41', ips: [ '192.0.2.41' ], port: 'lan2', network: 'lan', bridge: 'br-lan' },
			{ mac: '00:00:5e:00:53:42', name: 'den-nas', secondary: '192.0.2.42', ips: [ '192.0.2.42' ], port: '', network: null, bridge: null, ap: { id: 'a1', name: 'ap-den', port: 'lan1' } }
		]
	});
	const find = q => says(self.searchEntries(q));
	/* the name (an alias is the name), whatever its case */
	assert.deepEqual(find('living'), [ [ 'client', 'Living room TV', '192.0.2.21 · Harbor-5G' ] ]);
	assert.deepEqual(find('ROOM tv'), [ [ 'client', 'Living room TV', '192.0.2.21 · Harbor-5G' ] ]);
	/* a MAC fragment: of the made-up name, and of the words */
	assert.deepEqual(find('53:0f'), [ [ 'client', 'Private device 53:0F', '02:00:5E:00:53:0F · Harbor' ] ]);
	assert.deepEqual(find('5e:00:53:21'), [ [ 'client', 'Living room TV', '192.0.2.21 · Harbor-5G' ] ]);
	assert.equal(self.searchEntries('5e:00:53:21')[0].words, '00:00:5e:00:53:21 192.0.2.21 2001:db8::21');
	/* an address, IPv4 or IPv6 */
	assert.deepEqual(find('192.0.2.41'), [ [ 'client', 'office-printer', '192.0.2.41 · lan' ] ]);
	assert.deepEqual(find('2001:db8::21'), [ [ 'client', 'Living room TV', '192.0.2.21 · Harbor-5G' ] ]);
	/* a paired access point's station and wired host say whose they are, and are found by it */
	assert.deepEqual(find('den'), [ [ 'client', 'den-nas', '192.0.2.42 · via ap-den' ], [ 'client', 'den-phone', '192.0.2.31 · Harbor-5G · via ap-den' ] ]);
	assert.deepEqual(find('ap-den'), find('den'));
	assert.deepEqual(find('zzz'), []);
	/* what a click on the row does: the client's details, by its MAC */
	self.searchEntries('living')[0].run();
	self.searchEntries('nas')[0].run();
	assert.deepEqual(self.did, [ [ 'drawer', 'client', '00:00:5e:00:53:21' ], [ 'drawer', 'client', '00:00:5e:00:53:42' ] ]);
	/* no query: every one, in name order; a query that is no text counts as none */
	assert.deepEqual(find('').map(e => e[1]), [ 'den-nas', 'den-phone', 'Living room TV', 'office-printer', 'Private device 53:0F' ]);
	for (const q of [ undefined, null, '   ' ]) assert.deepEqual(find(q), find(''), String(q));
	assert.deepEqual(says(Object.assign(Object.create(searchView), { m: null }).searchEntries('den')), [], 'before the first model');
});

test('search: radios by band, channel or name; Wi-Fi networks once a name; interfaces', () => {
	const savedL = global.L, savedW = global.window;
	const self = searching({
		radios: [
			{ id: 'radio0', bandLabel: '2.4 GHz', gen: 'Wi-Fi 6', channel: 6, width: 20, htmode: 'HE20' },
			{ id: 'radio1', bandLabel: '5 GHz', gen: 'Wi-Fi 6', channel: 36, width: 80, htmode: 'HE80' },
			{ id: 'radio2', bandLabel: '6 GHz', gen: null, channel: null, width: null, htmode: null }
		],
		ssids: [
			{ ssid: 'Harbor', band: '2g', clients: 1 }, { ssid: 'Harbor', band: '5g', clients: 2 },
			{ ssid: 'Harbor-IoT', band: '2g', clients: 0 }, { ssid: '', band: '5g', clients: 4 }
		],
		accessPoints: [ { id: 'a1', name: 'ap-den', nodes: [ { ssid: 'Harbor', band: '5g', clients: 3 }, { ssid: 'Harbor-Den', band: '6g', clients: 1 } ] }, { id: 'a2', name: 'ap-loft', nodes: [] } ],
		uplinks: [ { iface: 'wan', ipv4: [ '203.0.113.7/24' ], proto: 'pppoe', ifaces: [ 'wan', 'wan6' ], l3dev: 'pppoe-wan', dev: 'eth1' } ],
		networks: [ { name: 'guest', ipv4: '198.51.100.1/24', proto: 'static', dev: 'br-guest', up: true }, { name: 'lan', ipv4: '192.0.2.1/24', proto: 'static', dev: 'br-lan', up: true },
			{ name: 'vpn', ipv4: null, proto: 'wireguard', dev: 'vpn', up: false } ]
	});
	const find = q => says(self.searchEntries(q));
	const of = (kind, q) => says(self.searchEntries(q).filter(e => e.kind === kind));
	try {
		assert.deepEqual(of('radio', ''), [ [ 'radio', '2.4 GHz · Wi-Fi 6', 'Ch 6 · 20 MHz' ], [ 'radio', '5 GHz · Wi-Fi 6', 'Ch 36 · 80 MHz' ], [ 'radio', '6 GHz · radio2', '' ] ]);
		assert.deepEqual(of('radio', '5 GHz'), [ [ 'radio', '5 GHz · Wi-Fi 6', 'Ch 36 · 80 MHz' ] ]);
		assert.deepEqual(of('radio', '5ghz'), of('radio', '5 GHz'), 'as the palette matches a title: its letters in order');
		assert.deepEqual(of('radio', '36'), of('radio', '5 GHz'));
		assert.deepEqual(of('radio', 'channel 36'), of('radio', '5 GHz'));
		assert.deepEqual(of('radio', 'ch 20'), [ [ 'radio', '2.4 GHz · Wi-Fi 6', 'Ch 6 · 20 MHz' ] ]);
		/* loosely: each word somewhere ("6" in 36 too); the palette's own rule decides (tests/theme.test.js) */
		assert.deepEqual(of('radio', 'ch 6').map(e => e[1]), [ '2.4 GHz · Wi-Fi 6', '5 GHz · Wi-Fi 6' ]);
		assert.deepEqual(of('radio', 'radio1'), of('radio', '5 GHz'));
		assert.deepEqual(of('radio', 'he80'), of('radio', '5 GHz'));
		self.searchEntries('radio1')[0].run();
		assert.deepEqual(self.did.pop(), [ 'drawer', 'radio', 'radio1' ]);

		/* one entry a name: every band it is on, here and on the paired
		   access points, and their stations; a hidden one has no name */
		assert.deepEqual(of('ssid', ''), [ [ 'ssid', 'Harbor', '2.4 GHz · 5 GHz · 6 clients' ], [ 'ssid', 'Harbor-Den', '6 GHz · 1 client' ], [ 'ssid', 'Harbor-IoT', '2.4 GHz · 0 clients' ] ]);
		assert.deepEqual(of('ssid', 'iot'), [ [ 'ssid', 'Harbor-IoT', '2.4 GHz · 0 clients' ] ]);
		self.searchEntries('harbor-den')[0].run();
		assert.deepEqual(self.did.splice(0), [ [ 'close' ], [ 'ssid', 'Harbor-Den' ] ], 'the Clients list on that network, with no details open over it');
		/* the layout hides the Clients tile: nothing to show a network on */
		assert.deepEqual(says(searching(self.m, false).searchEntries('harbor')), []);
		assert.equal(searching(self.m, false).searchEntries('').filter(e => e.kind !== 'ssid').length, 7);

		/* lines to the internet and the other networks, by name, address,
		   the interfaces a line is made of and the device */
		assert.deepEqual(of('interface', ''), [ [ 'interface', 'guest', '198.51.100.1 · static' ], [ 'interface', 'lan', '192.0.2.1 · static' ],
			[ 'interface', 'vpn', 'wireguard' ], [ 'interface', 'wan', '203.0.113.7 · pppoe' ] ]);
		assert.deepEqual(find('wan6'), [ [ 'interface', 'wan', '203.0.113.7 · pppoe' ] ]);
		assert.deepEqual(find('br-guest'), [ [ 'interface', 'guest', '198.51.100.1 · static' ] ]);
		assert.deepEqual(find('203.0.113'), [ [ 'interface', 'wan', '203.0.113.7 · pppoe' ] ]);
		/* Enter: the page the dashboard's own links to interfaces go to */
		global.L = { url: (...a) => '/cgi-bin/luci/' + a.join('/') };
		global.window = { location: {} };
		self.searchEntries('guest')[0].run();
		assert.equal(global.window.location.href, '/cgi-bin/luci/admin/network/network');
	} finally {
		global.L = savedL;
		global.window = savedW;
	}
	/* ... and only where LuCI has that page */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /var page = insight\.PAGES\.network;\n\t\tfunction go\(\) \{ window\.location\.href = L\.url\.apply\(L, page\); \}\n\t\tgive\('interface', !hasPage\(page\) \? \[\] : /);
});

test('search: a network of hundreds of clients hands over eight, those the query names first', () => {
	const clients = [];
	for (let i = 0; i < 300; i++) {
		const mac = '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0');
		clients.push(sta(mac, 'host-' + i, { secondary: '192.0.2.' + (i % 250 + 1), ips: [ '192.0.2.' + (i % 250 + 1) ] }));
	}
	clients.push(sta('02:00:5e:00:53:99', 'zz-printer 192', { secondary: '198.51.100.9', ips: [ '198.51.100.9' ] }));
	const self = searching({ clients });
	const titles = q => self.searchEntries(q).map(e => e.title);
	assert.deepEqual(titles(''), [ 'host-0', 'host-1', 'host-10', 'host-100', 'host-101', 'host-102', 'host-103', 'host-104' ]);
	assert.deepEqual(titles('host-2'), [ 'host-2', 'host-20', 'host-200', 'host-201', 'host-202', 'host-203', 'host-204', 'host-205' ]);
	/* every address holds "192": the two named so are not cut off behind the others */
	assert.deepEqual(titles('192'), [ 'host-192', 'zz-printer 192', 'host-0', 'host-1', 'host-10', 'host-100', 'host-101', 'host-102' ]);
	assert.deepEqual(titles('host-299'), [ 'host-299' ]);
	assert.deepEqual(titles('192.0.2.77'), [ 'host-76' ]);
	/* a query of any length is cut before it is used */
	assert.deepEqual(titles('host-299' + ' '.repeat(5000) + 'x'), [ 'host-299' ]);
});

test('search: what the dashboard hands over is what the theme\'s palette takes, on the same event', () => {
	const theme = fs.readFileSync(path.join(RES, '..', '..', '..', '..', 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js'), 'utf8');
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	/* one event name, one limit a kind */
	assert.equal(/^var SEARCH_EVENT = '([^']+)';$/m.exec(src)[1], /^const PALETTE_EVENT = '([^']+)';$/m.exec(theme)[1]);
	assert.equal(/^var SEARCH_MAX = (\d+);$/m.exec(src)[1], /^const PROVIDED_MAX = (\d+);$/m.exec(theme)[1]);
	/* answered while the dashboard is open (render), with nothing but the query read from the event */
	assert.match(src, /window\.addEventListener\(SEARCH_EVENT, function\(ev\) \{\n\t\t\tvar d = ev\.detail;\n\t\t\tif \(d && typeof d\.add === 'function'\) d\.add\(self\.searchEntries\(d\.query\)\);\n\t\t\}\);/);

	/* the theme's check (providedEntries) drops none of them, long names and all */
	const part = name => { const at = theme.indexOf('function ' + name + '('); return theme.slice(at, theme.indexOf('\n}\n', at) + 3); };
	const consts = [ 'PROVIDED_KINDS', 'PROVIDED_MAX', 'PROVIDED_SCAN', 'PROVIDED_TEXT' ].map(c => new RegExp('^const ' + c + ' = .*$', 'm').exec(theme)[0]).join('\n');
	const taken = new Function('window', consts + '\n' + part('kindTitle') + part('providedEntries') + '\nreturn providedEntries;')({});
	const long = '\u{1F4F1}'.repeat(48);                      /* a name of 48 characters, two code units each */
	const self = searching({
		clients: [ sta('00:00:5e:00:53:21', long, { secondary: '2001:db8:1234:5678:9abc:def0:1234:5678', ssid: '\u{1F4F6}'.repeat(32), ips: new Array(40).fill('2001:db8:1234:5678:9abc:def0:1234:5678'),
			ap: { id: 'a1', name: 'a'.repeat(63) } }) ],
		radios: [ { id: 'radio0', bandLabel: '5 GHz', gen: 'Wi-Fi 6', channel: 36, width: 80, htmode: 'HE80' } ],
		ssids: [ { ssid: '\u{1F4F6}'.repeat(32), band: '5g', clients: 1 } ],
		networks: [ { name: 'lan', ipv4: '192.0.2.1/24', proto: 'static', dev: 'br-lan', up: true } ]
	});
	const list = self.searchEntries('');
	assert.deepEqual(list.map(e => e.kind), [ 'client', 'radio', 'ssid', 'interface' ]);
	for (const e of list) assert.deepEqual(Object.keys(e), [ 'kind', 'title', 'detail', 'words', 'run' ]);
	assert.deepEqual(taken(list).map(e => [ e.kind, e.title ]), list.map(e => [ e.kind, e.title ]));
	assert.ok(list[0].detail.endsWith('…') && Array.from(list[0].detail).length === 64, 'a long second text is cut');
	assert.ok(list[0].words.length <= 512);
});

/* ---------------------------------------------------- WireGuard tile (#129) */

/* keys in a WireGuard key's form; a peer as LuCI's plugin lists one (numbers as text) */
const wgKey = c => c.repeat(43) + '=';
const wgPeer = (c, name, extra) => Object.assign({ name, public_key: wgKey(c), endpoint: '198.51.100.20:40321', allowed_ips: [ '192.0.2.200/32' ],
	latest_handshake: '0', transfer_rx: '0', transfer_tx: '0', persistent_keepalive: 'off' }, extra);
const wgReply = peers => ({ wg0: { name: 'wg0', public_key: wgKey('Z'), listen_port: '51820', fwmark: 'off', peers } });
const WG_GONE = 'RPC call to luci.wireguard/getWgInstances failed with error -32000: Object not found';
const WG_DENIED = 'RPC call to luci.wireguard/getWgInstances failed with error -32002: Access denied';

/* fetch() with LuCI's WireGuard call stubbed. c.may: the login holds LuCI's group for it; c.answer: what the call
   answers; c.took: how long the next answer takes; c.poll(ms): a poll ms later, its raw.wg */
async function wgPolls(fn) {
	const saved = { L: global.L, document: global.document, now: Date.now };
	const c = { t: 1e12, low: false, may: true, probed: 0, access: 0, asked: 0, args: null, took: 0, answer: () => Promise.resolve({}) };
	Date.now = () => c.t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? (c.low ? 'low' : null) : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({});
	REPLIES['luci.vantage thermal'] = () => Promise.resolve([]);
	REPLIES['luci.vantage wired'] = () => Promise.resolve({ hosts: [] });
	REPLIES['session access'] = (scope, object, f) => {
		c.access++;
		if (object === 'luci-proto-wireguard') c.probed++;
		return Promise.resolve(scope === 'access-group' && object === 'luci-proto-wireguard' && f === 'read' && c.may);
	};
	REPLIES['luci.wireguard getWgInstances'] = (...args) => { c.asked++; c.args = args; c.t += c.took; c.took = 0; return c.answer(); };
	c.fresh = () => { c.self = Object.create(view); };
	c.fresh();
	c.poll = async ms => { c.t += ms || 0; return (await c.self.fetch()).wg; };
	try { await fn(c); }
	finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) if (/^(luci\.vantage (wireless|thermal|wired)|luci\.wireguard|session access)/.test(k)) delete REPLIES[k];
	}
}

/* every user of 1.0.x without luci-proto-wireguard, and a login that has the dashboard alone: rpcd says once that
   the group is not theirs, and nothing else is ever asked */
test('WireGuard: a login without LuCI\'s group for it never makes the call, and is asked about the group once', () => wgPolls(async c => {
	c.may = false;
	c.answer = () => Promise.resolve(wgReply([ wgPeer('A', 'phone') ]));
	for (let i = 0; i < 30; i++) assert.equal(await c.poll(5e3), null, 'poll ' + i);
	assert.deepEqual([ c.asked, c.probed ], [ 0, 1 ]);
	/* the question itself: that group's read side, as the dashboard asks about its own */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /callAccess\('access-group', 'luci-proto-wireguard', 'read'\)/);
	/* and a session that cannot be asked (the call fails) is a no */
	c.fresh();
	REPLIES['session access'] = () => Promise.reject(new Error('XHR request timed out'));
	for (let i = 0; i < 3; i++) assert.equal(await c.poll(5e3), null);
	assert.equal(c.asked, 0);
}));

test('WireGuard: asked with the slow poll, without arguments; the answer and when it came in; between slow polls the last one', () => wgPolls(async c => {
	const reply = wgReply([ wgPeer('A', 'phone') ]), next = wgReply([]);
	c.answer = () => Promise.resolve(reply);
	const a = await c.poll(0);
	assert.deepEqual(a, { reply, at: 1e12 });
	assert.deepEqual([ c.asked, c.args, c.probed ], [ 1, [], 1 ]);
	c.answer = () => Promise.resolve(next);
	assert.deepEqual(await c.poll(5e3), { reply: next, at: 1e12 + 5e3 }, 'every poll is a slow one');
	assert.deepEqual([ c.asked, c.probed ], [ 2, 1 ], 'the group is asked about once a page');
	/* Low-power router: with the Wi-Fi state and the wired hosts, once every 30 s */
	c.low = true;
	const first = await c.poll(30e3);
	c.answer = () => Promise.resolve(reply);
	for (let i = 0; i < 5; i++) assert.equal(await c.poll(5e3), first, 'the same answer, with the time it came in');
	assert.equal(c.asked, 3);
	assert.deepEqual(await c.poll(5e3), { reply, at: c.t });
	assert.equal(c.asked, 4);
	/* its declaration: LuCI's own object and method, no parameters, a failed call rejected */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes("var callWireguard = rpc.declare({ object: 'luci.wireguard', method: 'getWgInstances', expect: { '': {} }, reject: true });"));
}));

test('WireGuard: where the first answer says the call is not there, it is never asked again on this page', () => wgPolls(async c => {
	for (const text of [ WG_GONE, WG_DENIED, 'RPC call to luci.wireguard/getWgInstances failed with ubus code 3: Method not found',
		'RPC call to luci.wireguard/getWgInstances failed with ubus code 4: Resource not found', 'RPC call to luci.wireguard/getWgInstances failed with ubus code 6: Permission denied' ]) {
		c.fresh();
		const asked = c.asked;
		c.answer = () => Promise.reject(new Error(text));
		for (let i = 0; i < 12; i++) assert.equal(await c.poll(5e3), null, text);
		/* not after a minute, not after an hour, and not when it would answer */
		c.answer = () => Promise.resolve(wgReply([ wgPeer('A', 'phone') ]));
		assert.equal(await c.poll(3600e3), null);
		assert.equal(c.asked, asked + 1, text);
	}
	/* a failure that says nothing about the call (no answer, a broken one) is asked again at the next poll */
	for (const fail of [ () => Promise.reject(new Error('XHR request timed out')), () => Promise.reject(new Error('RPC call to luci.wireguard/getWgInstances failed with ubus code 7: Request timeout')),
		() => Promise.reject(new Error('RPC call to luci.wireguard/getWgInstances failed with error -32003: ubus request timed out')), () => Promise.reject(null),
		() => Promise.resolve('x'), () => Promise.resolve([ 1 ]), () => Promise.resolve(null) ]) {
		c.fresh();
		const asked = c.asked, reply = wgReply([]);
		c.answer = fail;
		assert.equal(await c.poll(5e3), null);
		assert.equal(await c.poll(5e3), null);
		c.answer = () => Promise.resolve(reply);
		assert.deepEqual(await c.poll(5e3), { reply, at: c.t });
		assert.equal(c.asked, asked + 3);
	}
}));

test('WireGuard: an object that went away under an open page is asked for again after a minute; an answer that took long, after ten times as long', () => wgPolls(async c => {
	const reply = wgReply([ wgPeer('A', 'phone') ]);
	c.answer = () => Promise.resolve(reply);
	assert.deepEqual(await c.poll(0), { reply, at: c.t });
	/* rpcd restarted, the package removed: none now, and one question a minute */
	c.answer = () => Promise.reject(new Error(WG_GONE));
	assert.equal(await c.poll(5e3), null);
	for (let i = 0; i < 11; i++) assert.equal(await c.poll(5e3), null, 'poll ' + i);
	assert.equal(c.asked, 2, 'not asked again within the minute');
	c.answer = () => Promise.resolve(reply);
	assert.deepEqual(await c.poll(5e3), { reply, at: c.t }, 'and back when it is');
	assert.equal(c.asked, 3);

	/* an answer after 3 s (the router looked a peer's name up): the next question 30 s on, that answer until then */
	c.took = 3000;
	const slow = await c.poll(5e3);
	assert.deepEqual(slow, { reply, at: c.t });
	for (let i = 0; i < 5; i++) assert.equal(await c.poll(5e3), slow, 'poll ' + i + ': the same answer, no new question');
	assert.equal(c.asked, 4);
	assert.deepEqual(await c.poll(5e3), { reply, at: c.t });
	assert.equal(c.asked, 5, 'a quick answer: every poll again');
	const good = await c.poll(5e3);
	assert.equal(c.asked, 6);

	/* no answer after 20 s (LuCI gives the call up): that is not "no tunnel". The last answer stands, and the
	   next question comes ten times that later, however long that is */
	c.took = 20000;
	c.answer = () => Promise.reject(new Error('XHR request timed out'));
	assert.equal(await c.poll(5e3), good, 'the answer of 25 s ago');
	c.answer = () => Promise.resolve(reply);
	for (let i = 0; i < 39; i++) assert.equal(await c.poll(5e3), good, 'poll ' + i + ': no new question for 200 s');
	assert.equal(c.asked, 7);
	const back = await c.poll(5e3);
	assert.deepEqual(back, { reply, at: c.t });
	assert.equal(c.asked, 8);
	/* a call that fails at once is asked again with every poll; the last answer stands for a minute, then there is none */
	c.answer = () => Promise.reject(new Error('RPC call to luci.wireguard/getWgInstances failed with error -32603: Internal error'));
	for (let i = 0; i < 11; i++) assert.equal(await c.poll(5e3), back, 'poll ' + i + ': ' + (i + 1) * 5 + ' s old');
	assert.equal(await c.poll(5e3), null, 'a minute old: no answer rather than an old one');
	assert.equal(c.asked, 20);
	c.answer = () => Promise.resolve(reply);
	assert.deepEqual(await c.poll(5e3), { reply, at: c.t });
	/* the browser's clock stepped back during a wait: time gone, not a wait without end */
	c.took = 3000;
	await c.poll(5e3);
	const asked = c.asked;
	c.t -= 3600e3;
	await c.poll(5e3);
	assert.equal(c.asked, asked + 1);
}));

/* what a poll's answer becomes: this.st.wg, the rates, and whether the tile exists (m.wg) */
function wgState(self, reply, at, now) {
	const m = {};
	self.noteTunnels(m, reply ? { reply, at } : null, now == null ? at : now);
	return m;
}

test('WireGuard: no tile without a tunnel; a tunnel seen once keeps it for the session', () => {
	const self = Object.create(view);
	self.st = {};
	for (const r of [ null, {}, { wg0: 'x' }, 'x' ]) {
		assert.equal(wgState(self, r, 1e12).wg, false, JSON.stringify(r));
		assert.deepEqual(self.st.wg, []);
	}
	assert.equal(wgState(self, wgReply([]), 1e12 + 5e3).wg, true, 'a tunnel without peers is a tunnel');
	assert.deepEqual(self.st.wg.map(t => [ t.name, t.port, t.peers.length ]), [ [ 'wg0', 51820, 0 ] ]);
	/* the interface restarted, a failed call: the tile stays, with nothing in it; no reshuffle for one poll */
	assert.equal(wgState(self, {}, 1e12 + 10e3).wg, true);
	assert.equal(wgState(self, null, 1e12 + 15e3).wg, true);
	assert.deepEqual(self.st.wg, []);
	/* a rebuild of the model (names resolved) keeps it, as it keeps the wired-only decision */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /this\.markWired\(m, null\);\n\t\tm\.wg = st\.wgSeen === true;/);
});

test('WireGuard: a peer\'s rates between two answers; the same answer again is no sample; a handshake\'s age by the poll\'s clock', () => {
	const self = Object.create(view);
	self.st = {};
	const T = 1700000000, k = 'wg0 ' + wgKey('A');
	const reply = (rx, tx) => wgReply([ wgPeer('A', 'phone', { latest_handshake: String(T - 40), transfer_rx: String(rx), transfer_tx: String(tx) }), wgPeer('B', 'tablet') ]);
	wgState(self, reply(1000, 2000), T * 1000);
	assert.deepEqual(Object.keys(self.st.wgRates || {}), [], 'one answer: no rate yet');
	assert.deepEqual(self.st.wg[0].peers.map(p => [ p.label, p.state, p.age ]), [ [ 'phone', 'recent', 40 ], [ 'tablet', 'never', null ] ]);
	const second = reply(1000 + 6250, 2000 + 625);
	wgState(self, second, T * 1000 + 5000);
	assert.deepEqual(self.st.wgRates[k], { rx: 10000, tx: 1000 }, 'bit/s over the 5 s between the answers');
	assert.deepEqual(self.st.wgRates['wg0 ' + wgKey('B')], { rx: 0, tx: 0 });
	/* Low-power router, a long answer: the polls in between get that answer again. No sample, the rates stand,
	   and the age goes on counting */
	for (let i = 1; i <= 5; i++) {
		wgState(self, second, T * 1000 + 5000, T * 1000 + 5000 + i * 5000);
		assert.deepEqual(self.st.wgRates[k], { rx: 10000, tx: 1000 }, 'poll ' + i);
		assert.equal(self.st.wg[0].peers[0].age, 45 + i * 5);
	}
	/* 30 s after the second answer: the average since then */
	wgState(self, reply(7250 + 3750, 2625), T * 1000 + 35000);
	assert.deepEqual(self.st.wgRates[k], { rx: 1000, tx: 0 });
	/* the session ran out meanwhile: the peer is away, by the same clock */
	wgState(self, reply(11000, 2625), T * 1000 + 40000, (T + 141) * 1000);
	assert.equal(self.st.wg[0].peers[0].state, 'stale');
	/* no answer: no tunnels shown, and no rate across the gap */
	wgState(self, null, T * 1000 + 45000);
	assert.deepEqual([ self.st.wg, self.st.wgPrev && Object.keys(self.st.wgPrev) ], [ [], [] ]);
	wgState(self, reply(99000, 99000), T * 1000 + 50000);
	assert.deepEqual(Object.keys(self.st.wgRates), [], 'the first answer after it is a first sample again');
});

/* the small DOM above with what patch() reads of a node (its type, tag and attribute names) and text as nodes:
   the tile is painted as a poll paints it, into what the last poll left */
class PNode extends FNode {
	get nodeType() { return 1; }
	get tagName() { return this.tag.toUpperCase(); }
	getAttributeNames() { return Object.keys(this.attrs); }
	get firstChild() { return this.childNodes[0] || null; }
	replaceChild(n, o) { this.childNodes[this.childNodes.indexOf(o)] = n; return o; }
	/* by one class, below this node */
	querySelectorAll(sel) { return this.all().slice(1).filter(n => n.classList.contains(sel.replace(/^\./, ''))); }
	focus() { PNode.focused = this; }
}
function withPatchDom(fn) {
	const text = s => ({ nodeType: 3, data: String(s), textContent: String(s), html() { return JSON.stringify(this.data); } });
	const saved = { E: global.E, document: global.document, L: global.L };
	global.E = (tag, attrs, children) => {
		const n = new PNode(tag);
		for (const [ k, v ] of Object.entries(attrs || {})) if (typeof v === 'function') n.on[k] = v; else if (v != null) n.setAttribute(k, v);
		if (!Array.isArray(children)) { if (children != null) n.innerHTML = String(children); return n; }
		for (const c of children) if (c instanceof FNode) n.appendChild(c); else if (c != null) n.childNodes.push(text(c));
		return n;
	};
	global.document = { createElementNS: (ns, tag) => new PNode(tag), createTextNode: text };
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	try { return fn(); }
	finally { for (const k of Object.keys(saved)) if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; }
}

const WG_T = 1700000000;
/* a tile over what one poll's answer holds (reply), as of WG_T + after seconds */
function wgTile(reply, after, self) {
	self = self || Object.assign(Object.create(dview), { st: {}, ui: { wgOpen: Object.create(null) }, el: { wg: new PNode('div') }, held: { wg: { h: 300, since: null }, sys: { h: 500, since: null } } });
	self.m = wgState(self, reply, (WG_T + (after || 0)) * 1000);
	self.paintWireguard();
	return self;
}
const wgRows = self => self.el.wg.find('vt-wg-peer').map(r => ({
	name: r.find('vt-wg-peer-name')[0].textContent, endpoint: r.find('vt-wg-ep')[0].textContent, rate: r.find('vt-wg-rate')[0].textContent,
	when: r.find('vt-wg-side')[0].children[1].textContent, dot: r.find('vt-status')[0].getAttribute('class'), away: r.classList.contains('vt-wg-away'), title: r.getAttribute('title')
}));
/* seven peers: three with a session, two whose last handshake is old, two without one (one of them unnamed) */
const WG_SEVEN = () => wgReply([
	wgPeer('A', 'never came', { endpoint: '(none)', allowed_ips: [] }),
	wgPeer('B', 'tablet', { latest_handshake: String(WG_T - 100), transfer_rx: '5000', transfer_tx: '9000' }),
	wgPeer('C', 'an hour ago', { latest_handshake: String(WG_T - 3600), endpoint: '203.0.113.9:51820' }),
	wgPeer('D', 'Laptop', { latest_handshake: String(WG_T - 5), endpoint: '[2001:db8::7]:51820', allowed_ips: [ '192.0.2.201/32', '2001:db8:2::201/128' ] }),
	wgPeer('E', 'days ago', { latest_handshake: String(WG_T - 3 * 86400 - 2 * 3600) }),
	wgPeer('F', undefined, { endpoint: '(none)', allowed_ips: [] }),
	wgPeer('G', 'phone', { latest_handshake: String(WG_T - 47) })
]);

test('WireGuard tile: nothing is painted without a tunnel; with one, the tunnel\'s name, port and peers', () => withPatchDom(() => {
	const none = wgTile(null);
	assert.equal(none.m.wg, false);
	assert.deepEqual(none.el.wg.childNodes, [], 'no tunnel: the tile is off (vantage.layout) and stays empty');
	assert.deepEqual(wgTile({}).el.wg.childNodes, []);

	const self = wgTile(WG_SEVEN());
	assert.equal(self.m.wg, true);
	const tuns = self.el.wg.find('vt-wg-tun');
	assert.equal(tuns.length, 1);
	assert.deepEqual(tuns[0].find('vt-wg-head')[0].children.map(n => n.textContent), [ 'wg0', 'UDP port 51820 · 7 peers' ]);
	/* those with a session first, by name; then the latest handshake first; five until the rest is opened */
	const rows = wgRows(self);
	assert.deepEqual(rows.map(r => r.name), [ 'Laptop', 'phone', 'tablet', 'an hour ago', 'days ago' ]);
	assert.deepEqual(rows.map(r => r.when), [ 'Handshake 5 s ago', 'Handshake 47 s ago', 'Handshake 1 min ago', 'Handshake 1 h ago', 'Handshake 3d 2h ago' ]);
	assert.deepEqual(rows.map(r => [ r.dot, r.away ]), [ [ 'vt-status vt-status-ok', false ], [ 'vt-status vt-status-ok', false ], [ 'vt-status vt-status-ok', false ],
		[ 'vt-status vt-status-off', true ], [ 'vt-status vt-status-off', true ] ], 'a dot for a session now, grey without: never a warning');
	assert.deepEqual(rows.map(r => r.endpoint), [ '[2001:db8::7]:51820', '198.51.100.20:40321', '198.51.100.20:40321', '203.0.113.9:51820', '198.51.100.20:40321' ]);
	assert.deepEqual(rows.map(r => r.rate), [ '—', '—', '—', '—', '—' ], 'no rate from one answer');
	assert.equal(rows[0].title, 'Laptop\nPublic key DDDDD…DDDDD=\n[2001:db8::7]:51820\nAllowed IPs: 192.0.2.201/32, 2001:db8:2::201/128');
	const more = self.el.wg.find('vt-wg-more');
	assert.deepEqual(more.map(b => [ b.tag, b.textContent, b.getAttribute('aria-expanded'), b.getAttribute('data-tunnel') ]), [ [ 'button', '+2 more', 'false', 'wg0' ] ]);

	/* the next answer, 5 s on: rates, ↓ what this device received from the peer and ↑ what it sent */
	const next = WG_SEVEN();
	Object.assign(next.wg0.peers[1], { transfer_rx: String(5000 + 6250), transfer_tx: String(9000 + 625000) });
	wgTile(next, 5, self);
	const tablet = wgRows(self)[2], rate = self.el.wg.find('vt-wg-rate')[2];
	assert.deepEqual([ tablet.name, tablet.rate, rate.getAttribute('title') ], [ 'tablet', '↓ 10.0 kbit/s  ↑ 1 Mbit/s', 'Received 10.0 kbit/s, sent 1 Mbit/s' ]);
	assert.equal(wgRows(self)[0].rate, 'idle');

	/* a public key is on the page only as the model shortened it */
	const html = self.el.wg.html();
	for (const c of 'ABCDEFGZ') assert.ok(!html.includes(c.repeat(8)), 'the key of ' + c);
	assert.ok(html.includes('DDDDD…DDDDD='));
}));

test('WireGuard tile: "+n more" opens a tunnel\'s other peers and "Show fewer" folds them; a poll keeps the choice', () => withPatchDom(() => {
	const two = () => Object.assign(WG_SEVEN(), { wg1: { listen_port: '51821', peers: Array.from('HIJKLMNO', (c, i) => wgPeer(c, 'site ' + i, { latest_handshake: String(WG_T - 10 * i - 1) })) } });
	const self = wgTile(two());
	assert.deepEqual(self.el.wg.find('vt-wg-tun').map(t => t.find('vt-wg-peer').length), [ 5, 5 ]);
	const [ b0, b1 ] = self.el.wg.find('vt-wg-more');
	assert.deepEqual([ b0.textContent, b1.textContent ], [ '+2 more', '+3 more' ]);
	/* the handler finds its tunnel on the button the click came from: a poll keeps the button (patch) */
	b0.on.click({ currentTarget: b0 });
	assert.deepEqual(self.el.wg.find('vt-wg-tun').map(t => t.find('vt-wg-peer').length), [ 7, 5 ], 'that tunnel only');
	assert.deepEqual(wgRows(self).slice(5, 7).map(r => [ r.name, r.endpoint, r.when, r.title ]), [
		[ 'FFFFF…FFFFF=', '—', 'No handshake yet', 'FFFFF…FFFFF=' ], [ 'never came', '—', 'No handshake yet', 'never came\nPublic key AAAAA…AAAAA=' ]
	], 'a peer without a description goes by its shortened key; one that never came has no endpoint');
	const open = self.el.wg.find('vt-wg-more')[0];
	assert.deepEqual([ open.textContent, open.getAttribute('aria-expanded') ], [ 'Show fewer', 'true' ]);
	assert.ok(open !== b0 && PNode.focused === open, 'the button was built anew, and the keyboard is on the new one');
	assert.deepEqual(Object.keys(self.held), [ 'sys' ], 'the tile shows its new height at once, the others keep their hold');
	/* polls go on: open stays open */
	wgTile(two(), 5, self);
	wgTile(two(), 10, self);
	assert.deepEqual(self.el.wg.find('vt-wg-tun').map(t => t.find('vt-wg-peer').length), [ 7, 5 ]);
	const again = self.el.wg.find('vt-wg-more')[0];
	assert.equal(again, open, 'a poll keeps the button it finds');
	again.on.click({ currentTarget: again });
	assert.deepEqual(self.el.wg.find('vt-wg-tun').map(t => t.find('vt-wg-peer').length), [ 5, 5 ]);
	assert.deepEqual(self.el.wg.find('vt-wg-more').map(b => [ b.textContent, b.getAttribute('aria-expanded') ]), [ [ '+2 more', 'false' ], [ '+3 more', 'false' ] ]);
	/* five or fewer: nothing to fold */
	const few = wgTile(wgReply(Array.from('ABCDE', c => wgPeer(c, 'p' + c))));
	assert.deepEqual([ few.el.wg.find('vt-wg-peer').length, few.el.wg.find('vt-wg-more').length ], [ 5, 0 ]);
}));

test('WireGuard tile: a tunnel gone or without peers says so in words; names and endpoints reach the page as text', () => withPatchDom(() => {
	const self = wgTile(wgReply([ wgPeer('A', '<img src=x onerror=alert(1)>', { latest_handshake: String(WG_T - 1), endpoint: 'javascript:alert(1)' }),
		wgPeer('B', 'x‮y', { endpoint: '<b>' }) ]));
	const rows = wgRows(self);
	assert.deepEqual(rows.map(r => [ r.name, r.endpoint ]), [ [ '<img src=x onerror=alert(1)>', '—' ], [ 'x�y', '—' ] ], 'what is no endpoint is none');
	const nodes = self.el.wg.all();
	assert.ok(nodes.every(n => n.innerHTML === undefined), 'no markup from data');
	assert.ok(nodes.every(n => !Object.keys(n.attrs).some(a => /^(on|href|src|style)/.test(a))), 'no handler, link or style from data');
	assert.deepEqual(nodes.filter(n => Object.keys(n.on).length).map(n => [ n.tag, Object.keys(n.on) ]), [], 'two peers: nothing to click');
	/* the interface went down (or the call failed): the tile stays for the session and says so */
	wgTile({}, 5, self);
	assert.deepEqual(self.el.wg.children.map(n => [ n.tag, n.getAttribute('class'), n.textContent ]), [ [ 'p', 'vt-empty-inline', 'No WireGuard tunnel is reported right now.' ] ]);
	wgTile(null, 10, self);
	assert.equal(self.el.wg.textContent, 'No WireGuard tunnel is reported right now.');
	/* and back; a tunnel nobody is configured on */
	wgTile(Object.assign(wgReply([]), { wg1: { listen_port: 'x', peers: [ wgPeer('C', 'only', { latest_handshake: String(WG_T - 2 * 86400) }) ] } }), 15, self);
	assert.deepEqual(self.el.wg.find('vt-wg-tun').map(t => [ t.find('vt-wg-head')[0].children.map(n => n.textContent), t.find('vt-wg-peer').length, t.find('vt-empty-inline').map(n => n.textContent) ]), [
		[ [ 'wg0', 'UDP port 51820 · 0 peers' ], 0, [ 'No peers configured.' ] ], [ [ 'wg1', '1 peer' ], 1, [] ]
	]);
	assert.equal(wgRows(self)[0].when, 'Handshake 2d 0h ago');
}));

test('WireGuard tile: built once like any tile, named for Customize, its link LuCI\'s own status page', () => withPatchDom(() => {
	const self = Object.assign(Object.create(dview), { el: {} });
	const tile = self.buildWireguard();
	assert.deepEqual([ tile.tag, tile.getAttribute('class'), tile.getAttribute('aria-label') ], [ 'section', 'vt-tile vt-wg-tile', 'WireGuard' ]);
	assert.equal(tile.find('vt-tile-title')[0].textContent, 'WireGuard');
	assert.deepEqual(tile.find('vt-link').map(a => [ a.getAttribute('href'), a.textContent ]), [ [ '/cgi-bin/luci/admin/status/wireguard', 'Status' ] ]);
	assert.equal(tile.children[1], self.el.wg);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /ssids: this\.buildSsids\(\), wg: this\.buildWireguard\(\)\n/);
	assert.match(src, /ssids: _\('Wireless networks', 'vantage'\), wg: _\('WireGuard'\)\n/);
	/* painted with the other tiles, after the device's own */
	assert.match(src, /this\.paintSsids\(\);\n\t\tthis\.paintWireguard\(\);\n/);
	/* the layout is told whether a tunnel was seen, and stores under the same keys as before
	   (the Ports tile's condition follows the tunnel's in both calls: its own test) */
	assert.match(src, /wired = !!this\.m\.wired, wg = !!this\.m\.wg, ports = !!this\.m\.portsTile;\n\t\tvar list = this\.drag \? this\.drag\.list : this\.layoutFor\(tier, wired, wg, ports\);/);
	assert.match(src, /layout\.same\(list, layout\.defaults\(l\.tier, l\.wired, l\.wg, l\.ports\)\)/);
}));

/* ------------------------------------------------------------ Ports tile */

const pmodel = load('vantage.model');
const P_MODES = [ '10baseT-H', '10baseT-F', '100baseT-H', '100baseT-F', '1000baseT-F' ];
const pEth = extra => Object.assign({ devtype: 'ethernet', up: true, carrier: true, speed: '1000F', 'link-supported': P_MODES }, extra);
const pDsa = extra => Object.assign({ devtype: 'dsa', up: true, carrier: true, speed: '1000F', conduit: 'eth0', 'link-supported': P_MODES }, extra);
/* a router: wan and four LAN ports of a switch (one unplugged, one at 100 Mbit/s half duplex), a host alone on lan1, three on lan3 */
const P_DEVS = () => ({
	eth0: pEth({ speed: '2500F' }), wan: pDsa({ speed: '2500F' }), lan1: pDsa(), lan2: pDsa({ carrier: false, speed: undefined }), lan3: pDsa(), lan4: pDsa({ speed: '100H' }),
	'br-lan': { devtype: 'bridge', 'link-supported': [], 'bridge-members': [ 'lan1', 'lan2', 'lan3', 'lan4' ] }
});
const P_HOSTS = [ { mac: '00:00:5e:00:53:11', port: 'lan1' }, { mac: '00:00:5e:00:53:12', port: 'lan3' }, { mac: '00:00:5e:00:53:13', port: 'lan3' }, { mac: '00:00:5e:00:53:14', port: 'lan3' } ];
const P_WAN = { iface: 'wan', port: 'wan', l3dev: 'wan', dev: 'wan', statsDev: 'wan' };

/* the tile over one poll's model: ports as model.ports gives them, the rates the poll counted (st.devRates) */
function portsTile(o, self) {
	o = o || {};
	self = self || Object.assign(Object.create(dview), { st: { devRates: Object.create(null) }, el: { ports: new PNode('div'), portsSum: new PNode('span') }, shown: [] });
	self.showWired = function(port) { this.shown.push(port); };
	self.st.devRates = Object.assign(Object.create(null), o.rates || {});
	const lines = o.lines || [ P_WAN ];
	self.m = { uplinks: lines, ports: o.ports || pmodel.ports(o.devs || P_DEVS(), o.switches || {}, o.states || {}, [], o.hosts || P_HOSTS, lines) };
	self.notePorts(self.m);
	self.paintPorts();
	return self;
}
const portCells = self => self.el.ports.find('vt-port').map(c => ({
	tag: c.tag, cls: c.getAttribute('class'), name: c.find('vt-port-name')[0].textContent, dot: c.find('vt-status')[0].getAttribute('class'),
	mark: c.find('vt-pill').map(x => x.textContent), link: c.find('vt-port-link')[0].textContent, rates: c.find('vt-port-rates').map(r => r.children.map(x => x.textContent)),
	hosts: c.find('vt-port-hosts').map(x => x.textContent), notes: c.find('vt-port-note').map(x => x.textContent), title: c.getAttribute('title')
}));

test('Ports: no tile with one port; two seen once keep it for the session', () => {
	const self = Object.create(view);
	self.st = {};
	const note = ports => { const m = { ports }; self.notePorts(m); return m.portsTile; };
	const port = id => ({ id });
	assert.equal(note([]), false);
	assert.equal(note([ port('eth0') ]), false, 'an access point with one port: it is on the path already');
	assert.equal(self.st.portsSeen, undefined);
	assert.equal(note([ port('eth0'), port('eth1') ]), true);
	/* the device status failed for a poll (no devices), a USB adapter was pulled: the page is not rearranged */
	assert.equal(note([]), true);
	assert.equal(note([ port('eth0') ]), true);
	/* a poll's model and its rebuild (names resolved) both carry it, after the tunnel's */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /this\.noteTunnels\(m, raw\.wg, now\);\n\t\tthis\.notePorts\(m\);\n/);
	assert.match(src, /this\.markWired\(m, null\);\n\t\tm\.wg = st\.wgSeen === true;\n\t\tthis\.markOffline\(m, raw, null\);\n\t\tthis\.notePorts\(m\);\n/);
	/* the model the poll builds lists them: build() -> m.ports, from the replies the poll has anyway */
	const m = pmodel.build({ devs: P_DEVS(), ifaces: [] });
	assert.deepEqual(m.ports.map(p => p.id), [ 'lan1', 'lan2', 'lan3', 'lan4', 'wan' ]);
	assert.equal(note(m.ports), true);
	assert.equal(note(pmodel.build({ devs: { eth0: pEth() }, ifaces: [] }).ports), true, 'kept');
	self.st = {};
	assert.equal(note(pmodel.build({ devs: { eth0: pEth(), 'br-lan': { devtype: 'bridge', 'link-supported': [] }, 'phy0-ap0': { devtype: 'wlan' } }, ifaces: [] }).ports), false);
});

test('Ports: no request of its own: the tile is painted from the device status and the wired hosts the poll already has', () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const body = /\n\tpaintPorts: function\(\) \{[\s\S]*?\n\t\},\n/.exec(src)[0] + /\n\tbuildPorts: function\(\) \{[\s\S]*?\n\t\},\n/.exec(src)[0] + /\n\tnotePorts: function\(m\) \{[\s\S]*?\n\t\},\n/.exec(src)[0];
	assert.doesNotMatch(body, /\bcall[A-Z]\w*\(|rpc\.|L\.resolveDefault|fetch\(/);
	/* the model lists the ports from what build() is handed for the path and the wired hosts */
	const mod = fs.readFileSync(path.join(RES, 'vantage/model.js'), 'utf8');
	assert.match(mod, /ports: this\.ports\(devs, raw\.switches, raw\.switchState, wlNames, wired, uplinks\),/);
	const fn = mod.slice(mod.indexOf('\tports: function(devs, switches, states, wirelessNames, hosts, lines) {'), mod.indexOf('/* ------------------------------------------------------------ model */'));
	assert.ok(fn.length > 500);
	assert.doesNotMatch(fn, /\brpc\b|\bL\.|XMLHttpRequest|fetch\(/);
});

test('Ports tile: nothing is painted without the tile; with it, a cell a port: name, link, traffic, hosts and the uplink\'s mark', () => withPatchDom(() => {
	const none = portsTile({ devs: { eth0: pEth() } });
	assert.equal(none.m.portsTile, false);
	assert.deepEqual([ none.el.ports.childNodes, none.el.portsSum.textContent ], [ [], '' ], 'one port: the tile is off (vantage.layout) and stays empty');

	const rates = { wan: { rx: 364e6, tx: 2.92e6 }, lan1: { rx: 2.75e6, tx: 18.3e6 }, lan2: { rx: 0, tx: 0 }, lan3: { rx: 791e3, tx: 4.9e6 }, lan4: { rx: 0, tx: 0 }, eth0: { rx: 9e9, tx: 9e9 } };
	const self = portsTile({ rates });
	assert.equal(self.m.portsTile, true);
	assert.equal(self.el.portsSum.textContent, '4 of 5 connected');
	const cells = portCells(self);
	assert.deepEqual(cells.map(c => c.name), [ 'lan1', 'lan2', 'lan3', 'lan4', 'wan' ], 'the conduit eth0 is no cell');
	/* the link: a dot in the status colours, grey without one (never a warning), and the negotiated speed; half duplex said */
	assert.deepEqual(cells.map(c => [ c.dot, c.link ]), [ [ 'vt-status vt-status-ok', '1 Gbit/s' ], [ 'vt-status vt-status-off', 'No link' ], [ 'vt-status vt-status-ok', '1 Gbit/s' ],
		[ 'vt-status vt-status-ok', '100 Mbit/s · half duplex' ], [ 'vt-status vt-status-ok', '2.5 Gbit/s' ] ]);
	assert.deepEqual(cells.map(c => c.cls), [ 'vt-port', 'vt-port vt-port-off', 'vt-port', 'vt-port', 'vt-port' ]);
	assert.ok(self.el.ports.find('vt-status').every(d => d.getAttribute('aria-hidden') === 'true' && d.textContent === ''), 'the dot is no text: the words beside it say it');
	/* traffic: ↓ to the devices on the port and ↑ from them (the port sends what they download), as the path's port nodes;
	   on the line's port ↓ is what comes from the internet. Two items, so a narrow cell wraps them. None without a link */
	assert.deepEqual(cells.map(c => c.rates), [ [ [ '↓ 18.3', '↑ 2.75 Mbit/s' ] ], [], [ [ '↓ 4.9 Mbit/s', '↑ 791 kbit/s' ] ], [ [ 'idle' ] ], [ [ '↓ 364', '↑ 2.92 Mbit/s' ] ] ]);
	/* the hosts learned on it, and the mark on the port the line leaves through */
	assert.deepEqual(cells.map(c => c.hosts), [ [ '1 device' ], [], [ '3 devices' ], [], [] ]);
	assert.deepEqual(cells.map(c => c.mark), [ [], [], [], [], [ 'Uplink' ] ]);
	assert.deepEqual(self.el.ports.find('vt-pill').map(p => p.getAttribute('class')), [ 'vt-pill vt-pill-accent' ]);
	/* nothing counted wrong since boot: no note in any cell */
	assert.deepEqual(cells.map(c => c.notes), [ [], [], [], [], [] ]);
	/* the tooltip: the same in sentences, with the duplex and the port's own counting of its traffic */
	assert.deepEqual(cells.map(c => c.title), [
		'lan1\n1 Gbit/s · full duplex\nReceived 2.75 Mbit/s, sent 18.3 Mbit/s\nShow the devices on lan1',
		'lan2\nNo link',
		'lan3\n1 Gbit/s · full duplex\nReceived 791 kbit/s, sent 4.9 Mbit/s\nShow the devices on lan3',
		'lan4\n100 Mbit/s · half duplex\nReceived 0 bit/s, sent 0 bit/s',
		'wan\n2.5 Gbit/s · full duplex\nUplink · wan\nReceived 364 Mbit/s, sent 2.92 Mbit/s'
	]);
	/* no check mark, no colour of its own: classes of the app's stylesheet only (a .vt-status dot is the ok colour by itself) */
	const css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8');
	for (const n of self.el.ports.all().slice(1)) for (const c of (n.getAttribute('class') || '').split(' ').filter(Boolean)) assert.ok(c === 'vt-status-ok' || css.includes('.' + c), c);
	assert.ok(!self.el.ports.html().includes('✓') && self.el.ports.find('vt-ico').length === 0);
	const rules = css.split('\n').filter(l => /\.vt-port/.test(l)).join('\n') + css.slice(css.indexOf('.vt-app .vt-port {'), css.indexOf('.vt-app button.vt-port {'));
	assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(/, 'tokens only');
	assert.doesNotMatch(rules, /vt-seg\b/);
}));

test('Ports tile: the first answer has no rates yet; a second line names each port\'s; counters only where they count something', () => withPatchDom(() => {
	/* one answer: nothing to say about traffic */
	assert.deepEqual(portCells(portsTile()).map(c => c.rates), [ [ [ '—' ] ], [], [ [ '—' ] ], [ [ '—' ] ], [ [ '—' ] ] ]);
	assert.ok(portCells(portsTile()).every(c => !/Received/.test(c.title)));
	/* a backup line on lan4 (a modem in bridge mode): each line's port says which line, and counts as a line does */
	const lines = [ P_WAN, { iface: 'wanb', port: 'lan4', l3dev: 'lan4', dev: 'lan4', statsDev: 'lan4' } ];
	const two = portCells(portsTile({ lines, rates: { lan4: { rx: 30e6, tx: 4e6 }, wan: { rx: 1e6, tx: 2e6 } } }));
	assert.deepEqual(two.map(c => c.mark), [ [], [], [], [ 'wanb' ], [ 'wan' ] ]);
	assert.deepEqual([ two[3].rates, two[4].rates ], [ [ [ '↓ 30.0', '↑ 4 Mbit/s' ] ], [ [ '↓ 1', '↑ 2 Mbit/s' ] ] ]);
	assert.match(two[3].title, /\nUplink · wanb\n/);
	/* errors, drops and collisions since boot: a line each, in the cell and in its tooltip in the same words */
	const devs = P_DEVS();
	devs.lan1.statistics = { rx_errors: 12, tx_errors: 0, rx_dropped: 0, tx_dropped: 0, collisions: 0 };
	devs.lan3.statistics = { rx_errors: 0, tx_errors: 3, rx_dropped: 20224239, tx_dropped: 4, collisions: 0 };
	devs.lan4.statistics = { rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0, collisions: 7 };
	devs.wan.statistics = { rx_errors: 0, tx_errors: 0, rx_dropped: 0, tx_dropped: 0, collisions: 0, rx_bytes: 1e12 };
	const cells = portCells(portsTile({ devs }));
	assert.deepEqual(cells.map(c => c.notes), [ [ 'Errors: 12 in · 0 out' ], [], [ 'Errors: 0 in · 3 out', 'Dropped: 20 224 239 in · 4 out' ], [ 'Collisions: 7' ], [] ]);
	for (const c of cells) for (const n of c.notes) assert.ok(c.title.split('\n').includes(n), n + ': in the tooltip too');
	assert.equal(cells[2].title, 'lan3\n1 Gbit/s · full duplex\nErrors: 0 in · 3 out\nDropped: 20 224 239 in · 4 out\nShow the devices on lan3');
	assert.ok(!/Errors|Dropped|Collisions/.test(cells[4].title + cells[1].title), 'and nowhere where they are zero');
}));

test('Ports tile: a port with hosts opens the wired list on them; one without is no control; a poll keeps the cell', () => withPatchDom(() => {
	const self = portsTile();
	const cells = portCells(self);
	assert.deepEqual(cells.map(c => [ c.name, c.tag ]), [ [ 'lan1', 'button' ], [ 'lan2', 'div' ], [ 'lan3', 'button' ], [ 'lan4', 'div' ], [ 'wan', 'div' ] ]);
	const all = self.el.ports.find('vt-port'), btn = all[2];
	assert.equal(btn.getAttribute('type'), 'button');
	btn.on.click();
	assert.deepEqual(self.shown, [ 'lan3' ], 'as the port\'s node on the path does');
	assert.ok(all.filter(c => c.tag !== 'button').every(c => Object.keys(c.on).length === 0));
	/* the next polls: every cell is the element it was, though its numbers and its tooltip moved: a cell under the
	   keyboard keeps the focus, one under the pointer its tooltip */
	const devs = P_DEVS();
	devs.lan3.statistics = { rx_dropped: 5 };
	portsTile({ devs, rates: { lan3: { rx: 1e3, tx: 2e3 } } }, self);
	devs.lan3.statistics = { rx_dropped: 9 };
	portsTile({ devs, rates: { lan3: { rx: 5e3, tx: 9e3 } } }, self);
	assert.deepEqual(self.el.ports.find('vt-port'), all);
	assert.equal(btn.find('vt-port-rates')[0].textContent, '↓ 9↑ 5 kbit/s');
	assert.equal(btn.getAttribute('title'), 'lan3\n1 Gbit/s · full duplex\nReceived 5 kbit/s, sent 9 kbit/s\nDropped: 9 in · 0 out\nShow the devices on lan3');
	assert.deepEqual(btn.find('vt-port-note').map(n => n.textContent), [ 'Dropped: 9 in · 0 out' ]);
	/* a link going down is written to the same cell */
	devs.lan3.carrier = false;
	portsTile({ devs }, self);
	assert.deepEqual([ self.el.ports.find('vt-port')[2], btn.getAttribute('class'), btn.find('vt-port-link')[0].textContent, btn.find('vt-port-rates').length ], [ btn, 'vt-port vt-port-off', 'No link', 0 ]);
	/* its hosts left: no control any more (the cells are built anew); hosts on another: that one is */
	portsTile({ hosts: [ { mac: '00:00:5e:00:53:15', port: 'lan4' } ] }, self);
	assert.deepEqual(portCells(self).map(c => c.tag), [ 'div', 'div', 'div', 'button', 'div' ]);
	assert.ok(!self.el.ports.find('vt-port').includes(btn));
	self.el.ports.find('vt-port')[3].on.click();
	assert.deepEqual(self.shown, [ 'lan3', 'lan4' ]);
	/* the uplink's port lists what is heard on it too (an access point's whole network is behind its one port) */
	const up = portsTile({ hosts: [ { mac: '00:00:5e:00:53:01', port: 'wan' } ] });
	assert.deepEqual(portCells(up).filter(c => c.tag === 'button').map(c => [ c.name, c.hosts, c.mark ]), [ [ 'wan', [ '1 device' ], [ 'Uplink' ] ] ]);
}));

test('Ports tile: a swconfig switch\'s ports: a link and no counters; unknown until the switch has answered', () => withPatchDom(() => {
	const lan = n => ({ num: n, role: 'lan', index: n });
	const switches = { 'eth0.1': { name: 'switch0', vlan: 1, ports: [ lan(1), lan(2), lan(3) ] }, 'eth0.2': { name: 'switch0', vlan: 2, ports: [ { num: 5, role: 'wan', index: null } ] } };
	const devs = { eth0: pEth(), eth1: pEth({ speed: '2500F' }), 'eth0.1': { devtype: 'vlan', up: true, carrier: true, 'link-supported': P_MODES }, 'eth0.2': { devtype: 'vlan', up: true, carrier: true, 'link-supported': P_MODES } };
	const hosts = [ { mac: '00:00:5e:00:53:21', port: 'eth0.1' }, { mac: '00:00:5e:00:53:22', port: 'eth0.1' } ];
	const lines = [ { iface: 'wan', port: 'eth0.2', l3dev: 'eth0.2', dev: 'eth0.2', statsDev: 'eth0.2' } ];
	const rates = { eth1: { rx: 8e3, tx: 16e3 }, 'eth0.1': { rx: 1e6, tx: 2e6 }, 'eth0.2': { rx: 3e6, tx: 4e6 }, eth0: { rx: 5e6, tx: 6e6 } };
	/* not asked yet */
	const quiet = portsTile({ devs, switches, hosts, lines, rates });
	assert.equal(quiet.el.portsSum.textContent, '', 'no count while some links are not known');
	assert.deepEqual(portCells(quiet).map(c => [ c.name, c.tag, c.dot, c.link, c.rates, c.hosts, c.mark ]), [
		[ 'eth1', 'div', 'vt-status vt-status-ok', '2.5 Gbit/s', [ [ '↓ 16.0', '↑ 8 kbit/s' ] ], [], [] ],
		[ 'LAN 1', 'div', 'vt-status vt-status-off', '—', [], [], [] ], [ 'LAN 2', 'div', 'vt-status vt-status-off', '—', [], [], [] ], [ 'LAN 3', 'div', 'vt-status vt-status-off', '—', [], [], [] ],
		[ 'Port 5', 'div', 'vt-status vt-status-off', '—', [], [], [ 'Uplink' ] ]
	]);
	assert.equal(portCells(quiet)[1].title, 'LAN 1 · Port 1 of switch0');
	/* answered: one LAN port has a link, so the VLAN's hosts are behind it, and it opens their list (the VLAN device's) */
	const st = (n, link, speed, duplex) => ({ port: n, link, speed, duplex });
	const self = portsTile({ devs, switches, hosts, lines, rates, states: { switch0: [ st(0, true, 1000, true), st(1, false, 0, false), st(2, true, 100, false), st(3, false, 0, false), st(5, true, 1000, true) ] } }, quiet);
	assert.equal(self.el.portsSum.textContent, '3 of 5 connected');
	const cells = portCells(self);
	assert.deepEqual(cells.slice(1).map(c => [ c.name, c.tag, c.link, c.rates, c.hosts ]), [
		[ 'LAN 1', 'div', 'No link', [], [] ], [ 'LAN 2', 'button', '100 Mbit/s · half duplex', [], [ '2 devices' ] ], [ 'LAN 3', 'div', 'No link', [], [] ],
		[ 'Port 5', 'div', '1 Gbit/s', [], [] ]
	], 'no traffic of a switch port: the VLAN device\'s is every port\'s together');
	assert.equal(cells[2].title, 'LAN 2 · Port 2 of switch0\n100 Mbit/s · half duplex\nShow the devices on eth0.1');
	assert.equal(cells[4].title, 'Port 5 · Port 5 of switch0\n1 Gbit/s · full duplex\nUplink · wan');
	self.el.ports.find('vt-port')[2].on.click();
	assert.deepEqual(self.shown, [ 'eth0.1' ]);
}));

test('Ports tile: no ports in a poll says so in words; names reach the page as text', () => withPatchDom(() => {
	const self = portsTile();
	/* the device status failed: the tile stays for the session and says so */
	portsTile({ devs: {} }, self);
	assert.equal(self.m.portsTile, true);
	assert.deepEqual(self.el.ports.children.map(n => [ n.tag, n.getAttribute('class'), n.textContent ]), [ [ 'p', 'vt-empty-inline', 'No Ethernet ports are reported right now.' ] ]);
	assert.equal(self.el.portsSum.textContent, '');
	/* and back */
	portsTile({}, self);
	assert.equal(self.el.ports.find('vt-port').length, 5);
	/* names from the device and of a line: text, never markup, a handler, a link or a style */
	const hostile = '<img src=x onerror=alert(1)>';
	const odd = portsTile({ devs: { [hostile]: pEth(), 'javascript:alert(1)': pDsa(), 'x‮y': pDsa() }, hosts: [ { mac: '00:00:5e:00:53:31', port: hostile } ],
		lines: [ { iface: hostile, port: hostile, l3dev: hostile, dev: hostile, statsDev: hostile }, { iface: 'b', port: 'x‮y', l3dev: 'x‮y', dev: 'x‮y', statsDev: 'x‮y' } ] });
	assert.deepEqual(portCells(odd).map(c => [ c.name, c.mark ]), [ [ hostile, [ hostile ] ], [ 'javascript:alert(1)', [] ], [ 'x�y', [ 'b' ] ] ]);
	const nodes = odd.el.ports.all();
	assert.ok(nodes.every(n => n.innerHTML === undefined), 'no markup from data');
	assert.ok(nodes.every(n => !Object.keys(n.attrs).some(a => /^(on|href|src|style)/.test(a))), 'no handler, link or style from data');
	assert.deepEqual(nodes.filter(n => Object.keys(n.on).length).map(n => [ n.tag, Object.keys(n.on) ]), [ [ 'button', [ 'click' ] ] ]);
	nodes.filter(n => n.tag === 'button')[0].on.click();
	assert.deepEqual(odd.shown, [ hostile ], 'the port\'s name goes to the list\'s filter as a value, nowhere else');
}));

test('Ports tile: built once like any tile, named for Customize, laid out by the layout\'s rule for it', () => withPatchDom(() => {
	const self = Object.assign(Object.create(dview), { el: {} });
	const tile = self.buildPorts();
	assert.deepEqual([ tile.tag, tile.getAttribute('class'), tile.getAttribute('aria-label') ], [ 'section', 'vt-tile vt-ports-tile', 'Ports' ]);
	assert.equal(tile.find('vt-tile-title')[0].textContent, 'Ports');
	assert.deepEqual(tile.find('vt-link').map(a => [ a.getAttribute('href'), a.textContent ]), [ [ '/cgi-bin/luci/admin/network/network', 'Interfaces' ] ]);
	assert.deepEqual([ tile.children[0].find('vt-tile-extra')[0].children[0], tile.children[1] ], [ self.el.portsSum, self.el.ports ]);
	/* Customize names a tile by tileNames (its handle bar, its buttons, the list of hidden tiles): a translated name */
	self.tileNames = { ports: 'Ports' };
	self.ov = {};
	const ov = self.buildOverlay('ports');
	assert.equal(ov.getAttribute('aria-label'), 'Ports');
	assert.equal(ov.find('vt-ov-name')[0].textContent, 'Ports');
	assert.deepEqual(ov.find('vt-ov-btn').map(b => b.getAttribute('aria-label')), [ 'Move Ports up', 'Move Ports down', 'Move Ports left', 'Move Ports right', 'Make Ports narrower', 'Make Ports wider', 'Hide Ports' ]);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /clients: this\.buildClients\(\),\n\t\t\tports: this\.buildPorts\(\),\n/);
	assert.match(src, /clients: _\('Clients'\),\n\t\t\tports: _\('Ports'\),\n/, 'through _(): the catalogues translate it');
	/* every tile the layout knows is built and named: one more tile in layout.TILES needs both */
	const layout = load('vantage.layout');
	const built = /this\.tiles = \{([\s\S]*?)\};/.exec(src)[1], named = /this\.tileNames = \{([\s\S]*?)\};/.exec(src)[1];
	for (const id of layout.TILES) {
		assert.match(built, new RegExp('\\b' + id + ': this\\.build[A-Z]\\w+\\(\\)'), id);
		assert.match(named, new RegExp('\\b' + id + ': _\\('), id);
	}
	/* painted with the other tiles, after the WireGuard tile */
	assert.match(src, /this\.paintWireguard\(\);\n\t\tthis\.paintPorts\(\);\n/);
	/* the layout is told whether two ports were seen, and stores under the same keys as before */
	assert.match(src, /wg = !!this\.m\.wg, ports = !!this\.m\.portsTile;\n\t\tvar list = this\.drag \? this\.drag\.list : this\.layoutFor\(tier, wired, wg, ports\);/);
	assert.match(src, /return layout\.normalize\(this\.layouts\[k\] \|\| null, tier, wired, wg, ports\);/);
	assert.match(src, /layout\.same\(list, layout\.defaults\(l\.tier, l\.wired, l\.wg, l\.ports\)\)/);
	assert.match(src, /this\.laidPorts !== !!this\.m\.portsTile/);
}));

/* ------------------------------------- Top talkers with wired hosts (#129) */

/* a router: one host alone on lan2, two sharing lan1, the gateway alone on
   the WAN port, a host alone on a backup line's port, one alone on lan3
   without counters yet; ap-hall adds one alone on its lan3 and one on a
   port it shares there */
function talkModel(extra) {
	const host = (n, port, more) => Object.assign({ mac: '00:00:5e:00:53:0' + n, port, name: 'h' + n, plainName: 'h' + n, macLabel: '00:00:5E:00:53:0' + n, secondary: '192.0.2.' + n,
		icon: 'desktop', nameSource: 'dhcp', nameSourceLabel: 'DHCP', bridge: 'br-lan', network: 'lan', vlan: null, seen: 5, shared: false, peers: 1,
		speed: { mbps: 1000, duplex: 'full' }, carrier: true, ips: [ '192.0.2.' + n ] }, more);
	const ap = { id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', port: 'lan3', speed: null };
	return Object.assign({
		wired: true, radios: [], clients: [],
		uplink: { dev: 'eth0', statsDev: 'eth0', port: 'eth0' },
		uplinks: [ { dev: 'eth0', statsDev: 'eth0', port: 'eth0' }, { dev: 'eth1', statsDev: 'eth1', port: 'eth1' } ],
		wiredHosts: [
			host(1, 'lan2'),
			host(2, 'lan1', { shared: true, peers: 2 }), host(3, 'lan1', { shared: true, peers: 2 }),
			host(4, 'eth0', { gateway: true }),
			host(5, 'eth1'),
			host(6, '', { ap: Object.assign({ rate: { rx: 4000, tx: 9000 } }, ap) }),
			host(7, '', { ap: Object.assign({ rate: null }, ap) }),
			host(8, 'lan3')
		]
	}, extra);
}
const TALK_RATES = { lan2: { rx: 1000, tx: 3000 }, lan1: { rx: 7e6, tx: 7e6 }, eth0: { rx: 9e6, tx: 1e6 }, eth1: { rx: 5e6, tx: 5e6 } };

test('top talkers: wired hosts with a port to themselves rank with the stations; a shared port, the gateway and a line\'s port stay out', () => {
	const self = Object.create(view);
	const m = talkModel({ clients: [ { mac: '00:00:5e:00:53:a1', name: 'phone' }, { mac: '00:00:5e:00:53:a2', name: 'theirs', ap: { id: AP_ID, rate: { rx: 9e9, tx: 9e9 } } } ] });
	self.st = { devRates: TALK_RATES, staRates: { '00:00:5e:00:53:a1': { rx: 500, tx: 1500 }, '00:00:5e:00:53:a2': { rx: 9e9, tx: 9e9 } } };
	/* the model in hand, before it is the view's (ingest, rerender) */
	self.m = { uplinks: [], wiredHosts: [] };
	const t = self.talkers(m);
	assert.deepEqual(t.map(x => [ x.name, x.down, x.up, !!x.wired ]), [ [ 'h1', 3000, 1000, true ], [ 'phone', 1500, 500, false ] ],
		'by live total: the host alone on lan2 by its port, the station; a paired access point\'s host and station are not ranked, whatever they report');
	/* what the Clients list shows for each is what ranks it */
	const h = n => m.wiredHosts[n - 1];
	assert.deepEqual([ self.portRate(h(1)), self.portRate(h(6)) ], [ TALK_RATES.lan2, { rx: 4000, tx: 9000 } ]);
	assert.deepEqual([ self.portRate(h(2)), self.portRate(h(7)), self.portRate(h(8)) ], [ null, null, null ], 'shared here, shared there, not measured yet: no rate, no row');
	/* the port's rate is the line's, not theirs, however much it is */
	self.m = m;
	assert.deepEqual([ 4, 5 ].map(n => [ self.portRate(h(n)) !== null, self.talkHost(h(n)) ]), [ [ true, false ], [ true, false ] ]);
	assert.deepEqual(m.wiredHosts.filter(c => self.talkHost(c)).map(c => c.name), [ 'h1', 'h2', 'h3', 'h8' ]);
	/* a backup line whose port is unknown leaves nobody out, as on the path */
	m.uplinks[1].port = null;
	assert.deepEqual(self.talkers(m).map(x => x.name), [ 'h5', 'h1', 'phone' ]);
	assert.deepEqual(self.wiredPorts(), [ 'eth1', 'lan1', 'lan2', 'lan3' ]);
	/* three at most */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /var TALKERS = 3;/);
	assert.equal([ ...src.matchAll(/st\.talkers = this\.talkers\(m\);/g) ].length, 2, 'a poll and a rebuild rank alike');
});

test('top talkers: a wired host\'s row is a station\'s, to and from the device the same way round, and opens the host\'s details', () => withFakeDom(() => {
	const self = Object.create(dview);
	const sta = { mac: '00:00:5e:00:53:a1', name: 'phone', icon: 'desktop' };
	const m = talkModel({ wired: false, radios: [ { id: 'radio0' } ], clients: [ sta ] });
	self.m = m;
	/* the same counters on the radio and on the port */
	self.st = { devRates: TALK_RATES, staRates: { '00:00:5e:00:53:a1': { rx: 1000, tx: 3000 } } };
	self.st.talkers = self.talkers(m);
	self.el = { talkers: new FNode('div') };
	const opened = [];
	self.openDrawer = (kind, id) => opened.push([ kind, id ]);
	self.paintTalkers();
	const rows = self.el.talkers.children;
	assert.deepEqual(rows.map(r => r.getAttribute('class')), [ 'vt-talk-row', 'vt-talk-row', 'vt-talk-row vt-talk-slot' ], 'two to show, the third place kept');
	const name = r => r.find('vt-talk-name')[0].textContent, sub = r => r.find('vt-talk-sub')[0];
	assert.deepEqual(rows.slice(0, 2).map(name), [ 'h1', 'phone' ]);
	const wired = rows[0], wifi = rows[1];
	/* one row style: the same parts in the same order, no radio facts on either */
	const shape = r => r.all().map(n => n.tag + '.' + (n.getAttribute('class') || '')).join(' ');
	assert.equal(shape(wired), shape(wifi));
	assert.doesNotMatch(rows.map(r => r.html()).join(''), /vt-band|vt-signal|dBm|GHz/);
	/* the port sent the host 3 kbit/s and the radio sent the station 3 kbit/s: both downloads */
	assert.equal(sub(wired).getAttribute('title'), 'To device 3 kbit/s, from device 1 kbit/s');
	assert.equal(sub(wifi).getAttribute('title'), sub(wired).getAttribute('title'));
	assert.equal(sub(wired).textContent, sub(wifi).textContent);
	assert.equal(sub(wired).textContent, '4 kbit/s50%↓ 3  ↑ 1 kbit/s', 'total, share of the two, down then up');
	/* as the Clients list has it for the same host */
	const live = new FNode('x');
	append(live, self.wiredCells(m.wiredHosts[0], 0));
	assert.equal(live.find('vt-live-split')[0].getAttribute('title'), sub(wired).getAttribute('title'));
	/* a click: the details a click on the host's row in the Clients list opens */
	wired.on.click();
	wifi.on.click();
	assert.deepEqual(opened, [ [ 'client', '00:00:5e:00:53:01' ], [ 'client', '00:00:5e:00:53:a1' ] ]);
	self.st.gone = [];
	self.st.clientHist = {};
	self.ui = {};
	self.canWrite = false;
	const savedL = global.L;
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	try {
		const body = new FNode('x');
		append(body, self.drawerClient('00:00:5e:00:53:01').body);
		assert.match(body.textContent, /Portlan2/);
		assert.match(body.textContent, /Traffic↓ 3 kbit\/s · ↑ 1 kbit\/s/, 'the wired details, the same way round');
	} finally { global.L = savedL; }
}));

test('top talkers: without Wi-Fi the empty tile says why, and never names Wi-Fi', () => withFakeDom(() => {
	const self = Object.create(dview);
	const note = (m, rates) => {
		self.m = m;
		self.st = { devRates: rates || {}, staRates: {} };
		self.st.talkers = self.talkers(m);
		self.el = { talkers: new FNode('div') };
		self.paintTalkers();
		const all = self.el.talkers.children;
		assert.equal(all.filter(n => n.classList.contains('vt-talk-slot')).length, 3 - self.st.talkers.length, 'the tile keeps its three rows');
		return self.st.talkers.length ? null : all[0].textContent;
	};
	const every = talkModel().wiredHosts, shared = every.filter(h => h.shared), said = [];
	/* nothing heard on the ports */
	said.push(note(talkModel({ wiredHosts: [] })));
	assert.equal(said[0], 'No clients connected.');
	/* only the way to the gateway: no client either */
	said.push(note(talkModel({ wiredHosts: [ every[3], every[4] ] }), TALK_RATES));
	assert.equal(said[1], 'No clients connected.');
	/* every host shares its port, here or on its access point: none can be measured */
	said.push(note(talkModel({ wiredHosts: shared.concat(every[6]) }), TALK_RATES));
	assert.equal(said[2], 'No device has a port to itself; traffic on a shared port is not counted per device.');
	/* one has a port to itself and is idle, or not measured yet */
	said.push(note(talkModel({ wiredHosts: shared.concat(every[0]) }), { lan2: { rx: 0, tx: 0 }, lan1: { rx: 7e6, tx: 7e6 } }));
	said.push(note(talkModel({ wiredHosts: shared.concat(every[0]) })));
	assert.deepEqual(said.slice(3), [ 'Nobody is moving data right now.', 'Nobody is moving data right now.' ]);
	for (const s of said) assert.doesNotMatch(s, /Wi-?Fi|wireless|station|radio/i);
	/* with stations it is as before */
	assert.equal(note(talkModel({ wired: false, wiredHosts: shared, clients: [ { mac: '00:00:5e:00:53:a1', name: 'phone' } ] })), 'Nobody is moving data right now.');
	assert.equal(note(talkModel({ wired: false, wiredHosts: [], clients: [] })), 'No clients connected.');
	/* and a host that moves data is a row */
	assert.equal(note(talkModel(), TALK_RATES), null);
}));

/* ------------------------------------------ named devices that are offline */

/* a router with a laptop on its Wi-Fi and a NAS on lan2, both named; two
   more names for devices in no list: a speaker the host hints still give
   an address, and a camera they do not */
const OFF_NAMES = {
	'00:00:5e:00:53:01': { sid: 'cfg01', name: 'Laptop', icon: 'laptop' },
	'00:00:5e:00:53:32': { sid: 'cfg02', name: 'NAS', icon: null },
	'00:00:5e:00:53:c1': { sid: 'cfg03', name: 'Den speaker', icon: 'speaker' },
	'00:00:5e:00:53:c2': { sid: 'cfg04', name: 'attic camera', icon: 'camera' }
};
function offRaw(more) {
	return Object.assign({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] }
		],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'phy0-ap0' ] }, lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' },
			lan2: { devtype: 'ethernet', carrier: true, speed: '1000F' }, wan: { devtype: 'ethernet', carrier: true, speed: '1000F' }, 'phy0-ap0': { devtype: 'wlan' } },
		wifi: { radio0: { up: true, config: { band: '5g', channel: '36', htmode: 'HE80' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] } },
		assoc: { 'phy0-ap0': [ { mac: '00:00:5E:00:53:01', signal: -50 }, { mac: '00:00:5E:00:53:02', signal: -60 } ] },
		hints: { '00:00:5E:00:53:01': { name: 'laptop-7', ipaddrs: [ '192.0.2.101' ] }, '00:00:5E:00:53:32': { name: 'nas', ipaddrs: [ '192.0.2.132' ] },
			'00:00:5E:00:53:C1': { ipaddrs: [ '192.0.2.61' ] } },
		fdb: [ { mac: '00:00:5e:00:53:32', port: 'lan2', bridge: 'br-lan', seen: 20 }, { mac: '00:00:5e:00:53:33', port: 'lan1', bridge: 'br-lan', seen: 3 } ],
		aliases: OFF_NAMES
	}, more);
}
function offModel(more) {
	const m = load('vantage.model').build(offRaw(more));
	m.wired = false;
	return m;
}
/* the two named devices that were connected are gone, and the laptop's lease with it */
const OFF_LEFT = { assoc: { 'phy0-ap0': [ { mac: '00:00:5E:00:53:02', signal: -60 } ] }, fdb: [ { mac: '00:00:5e:00:53:33', port: 'lan1', bridge: 'br-lan', seen: 3 } ],
	hints: { '00:00:5E:00:53:32': { name: 'nas', ipaddrs: [ '192.0.2.132' ] }, '00:00:5E:00:53:C1': { ipaddrs: [ '192.0.2.61' ] } } };

test('offline: what the page still knows of a named device: when it was last listed and the address it had, for the names there are', () => {
	const self = Object.create(view);
	self.aliases = OFF_NAMES;
	self.st = { named: Object.create(null) };
	const info = m => m.offline.map(c => [ c.name, c.lastSeen, c.ips ]);
	/* the page opens: two named devices in no list, never seen by it */
	let m = offModel();
	self.markOffline(m, {}, 100000);
	assert.deepEqual(info(m), [ [ 'attic camera', null, [] ], [ 'Den speaker', null, [ '192.0.2.61' ] ] ], 'an address from the host hints, no last seen');
	assert.deepEqual(Object.assign({}, self.st.named), { '00:00:5e:00:53:01': { at: 100000, ip: '192.0.2.101' }, '00:00:5e:00:53:32': { at: 80000, ip: '192.0.2.132' } },
		'the named devices this poll lists: a station now, a wired host when its bridge last heard it; nobody without a name');
	/* a later poll: still there */
	self.markOffline(m = offModel(), {}, 105000);
	assert.equal(self.st.named['00:00:5e:00:53:01'].at, 105000);
	/* both leave */
	self.markOffline(m = offModel(OFF_LEFT), {}, 110000);
	assert.deepEqual(info(m), [ [ 'attic camera', null, [] ], [ 'Den speaker', null, [ '192.0.2.61' ] ], [ 'Laptop', 105000, [ '192.0.2.101' ] ], [ 'NAS', 85000, [ '192.0.2.132' ] ] ],
		'last seen at the last poll that listed each; the laptop\'s address from then, the hints having none now');
	/* a rebuild between polls (a name resolved) notes nothing and keeps what is known */
	self.markOffline(m = offModel(OFF_LEFT), {}, null);
	assert.deepEqual(info(m).slice(2), [ [ 'Laptop', 105000, [ '192.0.2.101' ] ], [ 'NAS', 85000, [ '192.0.2.132' ] ] ]);
	/* much later: still known, while the page is open */
	self.markOffline(m = offModel(OFF_LEFT), {}, 110000 + 6 * 3600 * 1000);
	assert.equal(m.offline[2].lastSeen, 105000);
	/* a name removed: nothing is kept for its device, and it is in no list */
	const fewer = Object.assign({}, OFF_NAMES);
	delete fewer['00:00:5e:00:53:01'];
	self.aliases = fewer;
	self.markOffline(m = offModel(Object.assign({ aliases: fewer }, OFF_LEFT)), {}, 120000);
	assert.deepEqual([ Object.keys(self.st.named), m.offline.map(c => c.name) ], [ [ '00:00:5e:00:53:32' ], [ 'attic camera', 'Den speaker', 'NAS' ] ]);
	/* a bridge with too many entries to list: who is on its ports is not known, nobody is said to be offline */
	self.markOffline(m = offModel(OFF_LEFT), { fdbCrowded: true }, 125000);
	assert.deepEqual(m.offline, []);
	/* both the poll and a rebuild go through it, the poll with its time */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes('this.markOffline(m, raw, now);') && src.includes('this.markOffline(m, raw, null);'));
	assert.match(src, /presence: null, isNew: Object\.create\(null\), gone: \[\], named: Object\.create\(null\),/, 'kept in the page only: no storage');
	assert.doesNotMatch(src.slice(src.indexOf('function writeStore'), src.indexOf('function writeStore') + 600), /named/);
});

/* the Clients tile's elements, enough to paint the list */
function clientsPage(m, ui) {
	const self = Object.create(dview);
	const el = { kinds: new FNode('div'), filter: new FNode('input'), filterBtn: new FNode('button'), filterMenu: new FNode('div'), filterTag: new FNode('button'),
		filterClear: new FNode('button'), count: new FNode('span'), thead: new FNode('thead'), tbody: new FNode('tbody'), clientsEmpty: new FNode('div') };
	/* as a document does it: a row put in again moves */
	const insert = el.tbody.insertBefore.bind(el.tbody);
	el.tbody.insertBefore = (n, ref) => { if (el.tbody.childNodes.includes(n)) el.tbody.removeChild(n); n.parentNode = el.tbody; return insert(n, ref); };
	el.filterMenu.hidden = true;
	Object.assign(self, { m, el, ui: Object.assign({ sorts: { wifi: { key: 'name', dir: 1 }, wired: { key: 'name', dir: 1 } }, kind: 'wifi', chip: 'all', filter: '', drawer: null }, ui),
		st: { staRates: {}, devRates: {}, gone: [], named: Object.create(null) }, rowMap: new Map(), aliases: OFF_NAMES, quiet: {}, lastRaw: {} });
	m.clients.forEach(c => { c.exp = { score: 90, level: 'ok', grade: 'Excellent', reason: '', short: '' }; });
	self.picked = 0;
	self.pickClients = function() { this.picked++; this.paint1(); };
	/* a paint as the page makes one; the menu is rebuilt, not updated in place */
	self.paint1 = function() { this.filterIds = null; this.rowSig = new Map(); this.paintClients(); return this; };
	return self;
}
function withClientsDom(fn) {
	return withFakeDom(() => {
		const savedL = global.L;
		global.L = { bind: (f, o) => f.bind(o), url: (...p) => '/cgi-bin/luci/' + p.join('/') };
		global.window.setTimeout = () => 0;
		try { return fn(); }
		finally { global.L = savedL; }
	});
}
const menuOf = self => self.el.filterMenu.children.map(i => i.find('vt-fmenu-label')[0].textContent + ' ' + i.find('vt-fmenu-n')[0].textContent + (i.getAttribute('aria-checked') === 'true' ? '*' : ''));
const rowsOf = self => self.el.tbody.children.map(tr => tr.children.map(td => td.textContent));
const pickFilter = (self, label) => self.el.filterMenu.children.filter(i => i.find('vt-fmenu-label')[0].textContent === label)[0].on.click();

test('offline: a quick filter beside the others, only while a named device is in neither list; its rows by name with the alias\'s name, icon and MAC', () => withClientsDom(() => {
	const m = offModel(OFF_LEFT);
	const self = clientsPage(m);
	self.el.filterBtn.focus = () => {};
	self.markOffline(m, {}, null);
	self.st.named['00:00:5e:00:53:01'] = { at: Date.now() - 90000, ip: '192.0.2.101' };
	self.markOffline(m, {}, null);
	self.paint1();
	assert.deepEqual(menuOf(self), [ 'All 1*', '5 GHz 1', 'Active 0', 'Weak signal 0', 'New 0', 'Offline 4' ], 'last in the menu, with how many; the Wi-Fi count is its own');
	assert.deepEqual(self.el.kinds.children.map(k => [ k.textContent, k.getAttribute('aria-pressed') ]), [ [ 'Wi-Fi1', 'true' ], [ 'Wired1', 'false' ] ], 'in neither count');
	assert.equal(rowsOf(self).length, 1);
	/* picked: the named devices that are in neither list */
	pickFilter(self, 'Offline');
	assert.deepEqual([ self.ui.chip, self.picked ], [ 'offline', 1 ]);
	assert.deepEqual(rowsOf(self), [
		[ 'attic cameraAlias00:00:5E:00:53:C2', '—', '—' ],
		[ 'Den speakerAlias00:00:5E:00:53:C1', '192.0.2.61', '—' ],
		[ 'LaptopAlias00:00:5E:00:53:01', '192.0.2.101', '1 min ago' ],
		[ 'NASAlias00:00:5E:00:53:32', '192.0.2.132', '—' ]
	], 'by name; the address and the last seen only where still known');
	const rows = self.el.tbody.children;
	assert.deepEqual(rows.map(tr => tr.getAttribute('data-mac')), [ '00:00:5e:00:53:c2', '00:00:5e:00:53:c1', '00:00:5e:00:53:01', '00:00:5e:00:53:32' ]);
	assert.ok(rows.every(tr => tr.classList.contains('vt-row-off') && !tr.classList.contains('vt-row-gone')));
	/* the alias's icon, or the one guessed from its name as for a connected device; dimmed like one that left */
	assert.deepEqual(m.offline.map(c => c.icon), [ 'camera', 'speaker', 'laptop', 'device' ]);
	assert.ok(rows.every(tr => tr.find('vt-av')[0].classList.contains('vt-av-gone')));
	/* what is not known is marked, so a card leaves its line out (app.css) */
	assert.deepEqual(rows.map(tr => tr.children.slice(1).map(td => td.classList.contains('vt-td-none'))), [ [ true, true ], [ false, true ], [ false, false ], [ false, true ] ]);
	assert.deepEqual(rows[0].children.map(td => td.getAttribute('data-title')), [ 'Device', 'Last address', 'Last seen' ]);
	/* its header: labels, no sorting (the list is by name), whatever the lists' own picks are */
	assert.deepEqual(self.el.thead.find('vt-label').map(n => n.textContent), [ 'Device', 'Last address', 'Last seen' ]);
	assert.equal(self.el.thead.all().filter(n => n.tag === 'button').length, 0);
	self.ui.sorts.wifi = { key: 'signal', dir: -1 };
	assert.deepEqual(rowsOf(self.paint1()).map(r => r[0].split('Alias')[0]), [ 'attic camera', 'Den speaker', 'Laptop', 'NAS' ]);
	assert.deepEqual(self.ui.sorts.wifi, { key: 'signal', dir: -1 }, 'the Wi-Fi list keeps its own');
	/* the tag in the search box, its own count, and neither Wi-Fi nor Wired pressed */
	assert.deepEqual([ self.el.filterTag.hidden, self.el.filterTag.textContent, self.el.count.textContent, self.el.count.hidden ], [ false, 'Offline', '4 devices', false ]);
	assert.deepEqual(self.el.kinds.children.map(k => k.getAttribute('aria-pressed')), [ 'false', 'false' ]);
	assert.deepEqual(menuOf(self).slice(-1), [ 'Offline 4*' ]);
	/* the search finds them by name, MAC and address */
	for (const [ q, want ] of [ [ 'den', [ 'Den speaker' ] ], [ '53:c2', [ 'attic camera' ] ], [ '192.0.2.1', [ 'Laptop', 'NAS' ] ], [ 'nothing', [] ] ]) {
		self.ui.filter = q;
		assert.deepEqual(rowsOf(self.paint1()).map(r => r[0].split('Alias')[0]), want, q);
	}
	assert.equal(self.el.count.textContent, '0 of 4');
	assert.equal(self.el.clientsEmpty.hidden, false);
	assert.match(self.el.clientsEmpty.textContent, /No clients match “nothing”/);
	self.ui.filter = '';
	/* a row opens the device's details */
	const opened = [];
	self.openDrawer = (kind, id) => opened.push([ kind, id ]);
	self.paint1().el.tbody.children[1].on.click();
	assert.deepEqual(opened, [ [ 'client', '00:00:5e:00:53:c1' ] ]);
	/* a click on Wi-Fi, the list it came from, goes back to it */
	self.el.kinds.children[0].on.click();
	assert.deepEqual([ self.ui.kind, self.ui.chip, rowsOf(self).length, self.el.kinds.children[0].getAttribute('aria-pressed') ], [ 'wifi', 'all', 1, 'true' ]);
	/* the wired list has the filter too */
	self.ui.kind = 'wired';
	assert.deepEqual(menuOf(self.paint1()), [ 'All 1*', 'Offline 4' ]);
	/* the last one comes back: no filter, and a page that was on it is on the whole list again */
	self.ui.chip = 'offline';
	self.m = offModel({ aliases: { '00:00:5e:00:53:01': OFF_NAMES['00:00:5e:00:53:01'], '00:00:5e:00:53:32': OFF_NAMES['00:00:5e:00:53:32'] } });
	self.m.clients.forEach(c => { c.exp = { score: 90, level: 'ok', grade: 'Excellent', reason: '', short: '' }; });
	assert.deepEqual(self.m.offline, []);
	self.paint1();
	assert.deepEqual([ self.ui.chip, menuOf(self) ], [ 'all', [ 'All 2*', 'lan1 1', 'lan2 1' ] ]);
	assert.ok(rowsOf(self).every(r => r.length === 5), 'the wired list\'s own rows');
}));

test('offline: counted nowhere else: not as a client, in no health check, in no talker', () => withFakeDom(() => {
	const insight = load('vantage.insight');
	const m = offModel(OFF_LEFT), bare = offModel(Object.assign({ aliases: {} }, OFF_LEFT));
	assert.equal(m.offline.length, 4);
	assert.deepEqual([ m.clients.length, m.wiredHosts.length ], [ bare.clients.length, bare.wiredHosts.length ]);
	const live = { cpu: { pct: 5, cores: [ 1 ] } };
	assert.deepEqual(insight.health(m, live), insight.health(bare, live));
	const self = Object.create(dview);
	self.m = m;
	self.st = { summary: { level: 'ok', headline: 'x' }, staRates: { '00:00:5e:00:53:01': { rx: 9e6, tx: 9e6 }, '00:00:5e:00:53:c1': { rx: 9e6, tx: 9e6 } },
		devRates: { lan2: { rx: 9e6, tx: 9e6 }, lan1: { rx: 1000, tx: 1000 } } };
	assert.deepEqual(self.talkers(m).map(x => x.mac), [ '00:00:5e:00:53:33' ], 'the host that is there, not the names that are not');
	self.el = { orb: {}, headline: new FNode('div'), subline: new FNode('div') };
	self.board = {};
	global.document.documentElement = { setAttribute() {} };
	self.paintHead();
	assert.match(self.el.subline.textContent, /1 client$/);
}));

test('offline: its details show what is known, in the drawer\'s style, and rename or remove the name with the control a connected client has', () => withFakeDom(() => {
	const savedL = global.L;
	const required = [];
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/'), require: name => { required.push(name); return new Promise(() => {}); } };
	try {
		const vendor = k => k === '00:00:5E' ? 'Example Corp' : null;
		const m = offModel(Object.assign({ vendor }, OFF_LEFT));
		const self = Object.create(dview);
		Object.assign(self, { m, st: { staRates: {}, devRates: {}, clientHist: {}, gone: [], named: Object.create(null), oui: { lookup: vendor } }, ui: {}, el: {}, quiet: {}, aliases: OFF_NAMES, canWrite: true });
		self.st.named['00:00:5e:00:53:01'] = { at: Date.now() - 125000, ip: '192.0.2.101' };
		self.markOffline(m, {}, null);
		const tree = list => { const n = new FNode('x'); append(n, list); return n; };
		const renamed = [];
		self.startRename = c => renamed.push(c);
		/* seen while the page was open */
		const d = self.drawerClient('00:00:5e:00:53:01'), body = tree(d.body), title = tree(d.title);
		assert.equal(title.find('vt-drawer-name')[0].textContent, 'Laptop');
		assert.equal(title.find('vt-drawer-sub')[0].textContent, 'Alias00:00:5E:00:53:01');
		assert.ok(title.find('vt-av')[0].classList.contains('vt-av-gone'));
		assert.equal(body.find('vt-banner')[0].textContent, 'Not connected right now. A wired device that stays quiet is forgotten after about five minutes.');
		assert.deepEqual(body.find('vt-kv').map(k => k.children[0].textContent), [ 'MAC address', 'Address type', 'Last address', 'Last seen', 'Name from' ]);
		const value = label => body.find('vt-kv').filter(k => k.children[0].textContent === label)[0].children[1].textContent;
		assert.deepEqual([ value('MAC address'), value('Address type'), value('Last address'), value('Name from') ],
			[ '00:00:5E:00:53:01', 'Globally unique · Example Corp', '192.0.2.101', 'Your name for this device' ]);
		assert.match(value('Last seen'), /^2 min ago\d/, 'how long ago, and the time');
		assert.equal(body.find('vt-rename-slot').length, 1);
		assert.equal(self.el.renameSlot, body.find('vt-rename-slot')[0], 'the slot the rename control fills');
		/* the one rename control: the button hands the device to startRename, as a connected client's does */
		const btn = body.find('vt-dactions')[0].children.filter(n => n.tag === 'button');
		assert.deepEqual(btn.map(b => b.textContent), [ 'Rename' ]);
		btn[0].on.click();
		assert.deepEqual(renamed.map(c => [ c.mac, c.alias ]), [ [ '00:00:5e:00:53:01', 'Laptop' ] ], 'with its MAC and its name: Save renames, Remove name removes');
		/* never seen by this page, no address: only what the name gives */
		const camera = tree(self.drawerClient('00:00:5e:00:53:c2').body);
		assert.deepEqual(camera.find('vt-kv').map(k => k.children[0].textContent), [ 'MAC address', 'Address type', 'Name from' ]);
		/* no link to any page, nothing of a station or a port */
		for (const t of [ body, camera ]) {
			assert.ok(!t.all().some(n => n.tag === 'a'));
			assert.doesNotMatch(t.textContent, /Signal|Port|Traffic|Experience|dBm/);
		}
		/* a login that may not name devices: no button */
		self.canWrite = false;
		assert.deepEqual(tree(self.drawerClient('00:00:5e:00:53:c2').body).find('vt-dactions')[0].children, []);
		/* the vendor table is asked for when these details need it, once, and not behind a private address */
		assert.deepEqual(required, []);
		self.st.oui = null;
		const priv = offModel(Object.assign({}, OFF_LEFT, { aliases: { '02:00:5e:00:53:c9': { sid: 'x', name: 'Guest phone' } } }));
		self.m = priv;
		self.markOffline(priv, {}, null);
		assert.match(tree(self.drawerClient('02:00:5e:00:53:c9').body).textContent, /Private address \(randomised by the device\)/);
		assert.deepEqual(required, []);
		self.m = offModel(OFF_LEFT);
		self.markOffline(self.m, {}, null);
		assert.match(tree(self.drawerClient('00:00:5e:00:53:c2').body).textContent, /Address typeGlobally uniqueName from/, 'until it is there: no vendor');
		self.drawerClient('00:00:5e:00:53:c2');
		assert.deepEqual(required, [ 'vantage.oui' ]);
		/* a station that left a moment ago keeps the details of its last sample (as before), its name's rename with them */
		self.st.gone = [ { client: { mac: '00:00:5e:00:53:c1', name: 'Den speaker', plainName: 'Den speaker', alias: 'Den speaker', nameSource: 'alias', nameSourceLabel: 'Alias', secondary: '192.0.2.61', macLabel: '00:00:5E:00:53:C1',
			signal: -60, level: { word: 'Good' }, exp: { score: 90, level: 'ok', grade: 'Excellent', reason: '', factors: [] }, band: '5g', ssid: 'Home', ips: [] }, at: Date.now() - 5000 } ];
		assert.match(tree(self.drawerClient('00:00:5e:00:53:c1').body).textContent, /^Disconnected/);
		/* a MAC with no name and in no list: as before */
		assert.match(tree(self.drawerClient('00:00:5e:00:53:ee').body).textContent, /Not connected/);
		/* one way to save a name */
		const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
		assert.equal([ ...src.matchAll(/callSetAlias\(/g) ].length, 1);
		assert.equal([ ...src.matchAll(/self\.saveAlias\(/g) ].length, 1, 'only the rename control saves');
		assert.equal([ ...src.matchAll(/self\.startRename\(c\)/g) ].length, 3, 'a station\'s, a wired host\'s and an offline device\'s button');
	} finally { global.L = savedL; }
}));

/* ---------------------------------- "What's new", once after an upgrade */

const NEWS_SRC = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
/* the version this dashboard has, whatever a release makes it, one from before and one from after */
const NEWS_NOW = /^var VERSION = '([^']+)';/m.exec(NEWS_SRC)[1], NEWS_OLD = '0.9.9', NEWS_LATER = '9999.0.0';
const NEWS_KEY = 'vantage.seen.v1';
const NEWS_LINK = 'https://github.com/anothaDev/luci-theme-vantage/blob/v' + NEWS_NOW + '/CHANGELOG.md';
/* this browser's localStorage, over what it keeps */
const kept = store => ({
	getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
	setItem: (k, v) => { store[k] = String(v); }
});
/* one load of the dashboard (inside withFakeDom): the line as render() gets it, '' for none */
function newsLoad(storage) {
	const self = Object.create(dview);
	self.el = { layoutBtn: { focused: 0, focus() { this.focused++; } } };
	global.window.localStorage = storage;
	const line = self.buildNews();
	return { self, line, link: line && line.all().find(n => n.tag === 'a'), close: line && line.all().find(n => n.tag === 'button') };
}

test('what\'s new: nothing on a first visit; once another version was kept, one line at every load until it is closed', () => withFakeDom(() => {
	const store = {};
	/* a first visit only notes the version */
	assert.equal(newsLoad(kept(store)).line, '');
	assert.deepEqual(store, { [NEWS_KEY]: NEWS_NOW });
	assert.equal(newsLoad(kept(store)).line, '', 'the same version at the next load: nothing');
	/* after an upgrade */
	store[NEWS_KEY] = NEWS_OLD;
	let p = newsLoad(kept(store));
	assert.equal(p.line.getAttribute('class'), 'vt-banner vt-banner-muted vt-news', 'in the look of the details\' notes');
	assert.equal(p.line.textContent, 'Vantage ' + NEWS_NOW + ': what\'s new', 'one line');
	assert.equal(p.link.textContent, p.line.textContent, 'all of it the link');
	assert.deepEqual(p.link.attrs, { 'class': 'vt-link', 'href': NEWS_LINK, 'target': '_blank', 'rel': 'noopener noreferrer' });
	assert.deepEqual(Object.keys(p.link.on).sort(), [ 'auxclick', 'click' ]);
	assert.equal(p.close.getAttribute('type'), 'button');
	assert.equal(p.close.getAttribute('aria-label'), 'Close');
	/* an info sign and a cross; no check mark */
	const drawn = p.line.all().filter(n => n.tag === 'path').map(n => n.getAttribute('d'));
	assert.equal(drawn.length, 4, 'the info sign\'s three strokes and the cross');
	assert.ok(!drawn.includes('M5 12.5l4.5 4.5L19 7.5'));
	assert.equal(store[NEWS_KEY], NEWS_OLD, 'showing it keeps nothing');
	/* left alone: there again at the next load */
	p = newsLoad(kept(store));
	assert.ok(p.line && !p.line.hidden);
	/* closed: gone at once, and for good */
	p.close.on.click();
	assert.equal(p.line.hidden, true);
	assert.equal(store[NEWS_KEY], NEWS_NOW);
	assert.equal(p.self.el.layoutBtn.focused, 1, 'the focus moves on to Customize, not to nowhere');
	assert.equal(newsLoad(kept(store)).line, '', 'never again');
	/* until the version changes again; a later one kept (a downgrade) differs too */
	store[NEWS_KEY] = NEWS_LATER;
	assert.ok(newsLoad(kept(store)).line);
}));

test('what\'s new: following the link is reading it, by a click or a middle click; the context menu\'s button is not', () => withFakeDom(() => {
	for (const [ on, button, read ] of [ [ 'click', 0, true ], [ 'auxclick', 1, true ], [ 'auxclick', 2, false ] ]) {
		const store = { [NEWS_KEY]: NEWS_OLD }, p = newsLoad(kept(store)), what = on + ' ' + button;
		let stopped = 0;
		p.link.on[on]({ type: on, button, preventDefault() { stopped++; } });
		assert.equal(stopped, 0, what + ': the browser opens the link itself');
		assert.equal(p.line.hidden === true, read, what);
		assert.equal(store[NEWS_KEY], read ? NEWS_NOW : NEWS_OLD, what);
		assert.equal(p.self.el.layoutBtn.focused, 0, what);
		assert.equal(newsLoad(kept(store)).line === '', read, what + ': at the next load');
	}
}));

test('what\'s new: what is kept is a version or counts as nothing kept; a browser that keeps nothing never shows the line', () => withFakeDom(() => {
	for (const junk of [ '', '1', 'v1.0.20', '1.0.20-r1', '1.0.20 ', ' 1.0.20', '1.0.20\n', '1..20', '1.2.3.4.5', '12345.0', 'null', '{"v":"1.0.20"}', '<b>1.0.20</b>', 'javascript:1.0' ]) {
		const store = { [NEWS_KEY]: junk };
		assert.equal(newsLoad(kept(store)).line, '', JSON.stringify(junk));
		assert.equal(store[NEWS_KEY], NEWS_NOW, JSON.stringify(junk) + ': this version is kept in its place');
	}
	/* no storage, or one that refuses: no line and no error, at any load */
	const refuse = () => { throw new Error('SecurityError'); };
	for (const storage of [ undefined, null, {}, { getItem: refuse, setItem: refuse }, { getItem: () => null, setItem: refuse } ])
		for (let load = 0; load < 2; load++) assert.equal(newsLoad(storage).line, '');
	Object.defineProperty(global.window, 'localStorage', { get: refuse, set() {}, configurable: true });
	assert.equal(Object.assign(Object.create(dview), { el: {} }).buildNews(), '', 'storage switched off in the browser');
	delete global.window.localStorage;
	/* it reads but cannot write: the line closes for this page and comes back with the next */
	const store = { [NEWS_KEY]: NEWS_OLD }, readOnly = { getItem: kept(store).getItem, setItem: refuse };
	const p = newsLoad(readOnly);
	assert.doesNotThrow(() => p.close.on.click());
	assert.equal(p.line.hidden, true);
	assert.ok(newsLoad(readOnly).line);
}));

test('what\'s new: the link is a constant, the changelog as tagged for this version; nothing is asked for it', () => {
	const src = NEWS_SRC;
	/* written out, as check_dom_sinks.js takes no URL put together from parts: a release bumps it with VERSION */
	assert.equal(/^var NEWS_URL = '([^']+)';$/m.exec(src)[1], NEWS_LINK, 'NEWS_URL is not this VERSION\'s: bump the two together');
	/* a version is plain digits and dots, this one and a kept one alike, or there is no line */
	const form = new RegExp(/^var VERSION_FORM = \/(.+)\/;$/m.exec(src)[1]);
	assert.ok(form.test(NEWS_NOW), 'VERSION is two to four dotted numbers');
	for (const odd of [ '1', '1.', '.1', '1.0.21-r1', '1.0.21rc1', '1.0.21/../..', '1.0.21#x', '1.0.21?x', '1.0 .21', '1.0.21.0.0', '12345.1', '１.０' ])
		assert.ok(!form.test(odd), odd);
	assert.match(src, /function newsDue\(\) \{\n\tif \(!VERSION_FORM\.test\(VERSION\)\) return false;/);
	assert.match(src, /return typeof v === 'string' && VERSION_FORM\.test\(v\) \? v : null;/);
	/* the constant is used once, as it is, and what is kept never reaches the page: it is only compared */
	assert.equal(src.split('NEWS_URL').length - 1, 2, 'defined, and the link\'s href');
	assert.equal(src.split('readSeen()').length - 1, 2, 'defined, and read by newsDue');
	assert.match(src, /var seen = readSeen\(\);\n\tif \(seen === null\) writeSeen\(VERSION\);\n\treturn seen !== null && seen !== VERSION;/);
	/* nothing is asked of anyone: the dashboard fetches its own package's files, as before */
	assert.deepEqual([ ...src.matchAll(/(?<![.\w])fetch\(([^,)]+)/g) ].map(m => m[1]), [ "L.resource('vantage/app.css'", "L.resource('menu-vantage.js'" ]);
	assert.doesNotMatch(src, /XMLHttpRequest|sendBeacon|new Image\b|EventSource|WebSocket|'ping'/);
});

test('what\'s new: above the head and outside the grid, which is all the layout measures', () => {
	const src = NEWS_SRC;
	/* the first thing in the page's body, before the head, the health cards, Customize's bar and the grid */
	assert.match(src, /E\('div', \{ 'class': 'vt-body' \}, \[\n\t\t\t\tthis\.buildNews\(\),\n\t\t\t\tthis\.buildHead\(\),\n\t\t\t\tthis\.el\.health = [^\n]+\n\t\t\t\tthis\.buildEditBar\(\),\n\t\t\t\tthis\.el\.grid = E\('div', \{ 'class': 'vt-grid vt-grid-wait' \}, this\.buildTiles\(\)\)\n/);
	assert.equal(src.split('this.buildNews()').length - 1, 1);
	/* the layout, the drag and the resize watch read the grid and its tiles, never the line */
	const part = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); assert.ok(a > 0 && b > a, from.trim()); return src.slice(a, b); };
	const layoutCode = part('\tdoLayout: function() {', '\tsetLayout: function(list) {') + part('\tdragStart: function(id, ev) {', '\tdragEnd: function(cancel) {');
	assert.doesNotMatch(layoutCode, /news|vt-body|\.el\.root\.(getBoundingClientRect|client|offset)/);
	assert.match(layoutCode, /var width = grid\.clientWidth;/);
	assert.match(layoutCode, /var nat = tiles\[e\.id\]\.getBoundingClientRect\(\)\.height;/);
	assert.match(src, /var ro = new ResizeObserver\(function\(\) \{ self\.scheduleLayout\(\); \}\);\n\t\t\tro\.observe\(this\.el\.grid\);/);
	/* the banner as it is, at the height of its close button: no colour of its own */
	const css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const own = [ ...css.matchAll(/([^{}]+)\{([^{}]*)\}/g) ].map(m => ({ sel: m[1].trim(), body: m[2] })).filter(r => /\.vt-news\b/.test(r.sel));
	assert.deepEqual(own.map(r => r.sel), [ '.vt-app .vt-banner.vt-news', '.vt-app .vt-news .vt-link', '.vt-app .vt-news .vt-icon-action' ]);
	for (const r of own) assert.doesNotMatch(r.body, /(^|[;\s])(color|background(-color)?|border(-color)?|box-shadow|fill|stroke|height)\s*:/, r.sel);
});

/* ------------------------------------------- Copy buttons in the details */

test('copy: the clipboard in a secure context, else the value selected and execCommand, else left selected to copy by hand', async () => {
	/* Node has a navigator of its own, as a getter */
	const NAMES = [ 'window', 'navigator', 'document' ];
	const saved = NAMES.map(n => Object.getOwnPropertyDescriptor(globalThis, n));
	const put = (n, value) => Object.defineProperty(globalThis, n, { value, configurable: true, writable: true });
	const run = async (secure, clip, exec) => {
		const used = [], node = { id: 'value' };
		const sel = { ranges: [], removeAllRanges() { used.push('clear'); this.ranges = []; }, addRange(r) { used.push('select ' + r.of.id); this.ranges.push(r); } };
		put('window', { isSecureContext: secure, getSelection: () => sel });
		put('navigator', clip ? { clipboard: { writeText: t => { used.push('clip ' + t); return clip === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied')); } } } : {});
		put('document', { createRange: () => ({ selectNodeContents(n) { this.of = n; } }), execCommand: c => { used.push('exec ' + c); if (exec === 'throw') throw new Error('no'); return exec; } });
		const ok = await view.copyText('192.0.2.7', node);
		return { ok, used, selected: sel.ranges.length };
	};
	try {
		assert.deepEqual(await run(true, 'ok', true), { ok: true, used: [ 'clip 192.0.2.7' ], selected: 0 }, 'nothing selected, the focus never moved');
		/* plain HTTP: no clipboard API; the value's own text is selected, copied, and let go */
		assert.deepEqual(await run(false, 'ok', true), { ok: true, used: [ 'clear', 'select value', 'exec copy', 'clear' ], selected: 0 });
		assert.deepEqual(await run(true, null, true), { ok: true, used: [ 'clear', 'select value', 'exec copy', 'clear' ], selected: 0 }, 'a secure page without the API');
		/* the clipboard refuses: the same way out */
		assert.deepEqual(await run(true, 'no', true), { ok: true, used: [ 'clip 192.0.2.7', 'clear', 'select value', 'exec copy', 'clear' ], selected: 0 });
		/* neither works: said so, and the text stays selected */
		assert.deepEqual(await run(false, null, false), { ok: false, used: [ 'clear', 'select value', 'exec copy' ], selected: 1 });
		assert.deepEqual(await run(false, null, 'throw'), { ok: false, used: [ 'clear', 'select value', 'exec copy' ], selected: 1 });
		assert.equal((await run(false, null, 'yes')).ok, false, 'only true is a copy');
	} finally {
		NAMES.forEach((n, i) => { if (saved[i]) Object.defineProperty(globalThis, n, saved[i]); else delete globalThis[n]; });
	}
});

/* the fake DOM for a test that awaits: put back when the test ends */
function fakeDom(t) {
	const fake = withFakeDom(() => ({ E: global.E, document: global.document, window: global.window }));
	const saved = { E: global.E, document: global.document, window: global.window, L: global.L, now: Date.now };
	Object.assign(global, fake, { L: { url: (...p) => '/cgi-bin/luci/' + p.join('/') } });
	t.after(() => { Date.now = saved.now; delete saved.now; Object.assign(global, saved); });
	return fake.window;
}

test('copy button: a real button named after what it copies; it reads "Copied" for a moment, on a button a poll rebuilt too, and a screen reader is told', async t => {
	const win = fakeDom(t), timers = [], copied = [];
	let now = 1e12, result = true;
	Date.now = () => now;
	win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); };
	const fire = ms => timers.splice(0).filter(x => x.ms === ms || (timers.push(x), false)).forEach(x => x.fn());
	const settle = () => new Promise(r => setImmediate(r));
	const self = Object.create(dview);
	const body = new FNode('div'), say = new FNode('span');
	body.querySelectorAll = sel => body.find(sel.slice(1));
	self.el = { drawerBody: body, drawerSay: say };
	self.copyText = (text, node) => { copied.push([ text, node.textContent ]); return Promise.resolve(result); };
	/* the details as a poll builds them: an address with its prefix length, and a MAC */
	const build = () => { body.childNodes = []; body.appendChild(self.addrLine('192.0.2.7/24')); body.appendChild(self.copyLine('00:00:5E:00:53:01')); return body.find('vt-copy'); };
	let [ addr, mac ] = build();
	assert.deepEqual([ addr.tag, addr.getAttribute('type'), addr.getAttribute('class') ], [ 'button', 'button', 'vt-btn vt-btn-ghost vt-copy' ]);
	assert.deepEqual([ addr.textContent, mac.textContent ], [ 'Copy 192.0.2.7', 'Copy 00:00:5E:00:53:01' ], 'the name says what is copied');
	assert.deepEqual(addr.children.map(n => [ n.getAttribute('class'), n.textContent ]), [ [ 'vt-copy-label', 'Copy' ], [ 'vt-sr', ' 192.0.2.7' ] ], 'the label, and the value for a screen reader');
	assert.equal(body.children[0].textContent, '192.0.2.7/24Copy 192.0.2.7', 'the line shows the prefix length');
	assert.equal(say.textContent, '');

	addr.on.click();
	await settle();
	assert.deepEqual(copied, [ [ '192.0.2.7', '192.0.2.7' ] ], 'the address without its prefix length, from a node that holds just that');
	assert.deepEqual([ addr.textContent, mac.textContent ], [ 'Copied 192.0.2.7', 'Copy 00:00:5E:00:53:01' ]);
	fire(30);
	assert.equal(say.textContent, 'Copied', 'the drawer\'s status line');
	/* a poll rebuilds the details within the moment: the new button reads the same */
	now += 1500;
	[ addr, mac ] = build();
	assert.deepEqual([ addr.textContent, mac.textContent ], [ 'Copied 192.0.2.7', 'Copy 00:00:5E:00:53:01' ]);
	/* the moment is over: the button on the page, rebuilt or not, reads Copy again */
	now += 500;
	fire(2000);
	assert.deepEqual([ addr.textContent, mac.textContent, self.copied ], [ 'Copy 192.0.2.7', 'Copy 00:00:5E:00:53:01', null ]);
	assert.equal(build()[0].textContent, 'Copy 192.0.2.7');

	/* a poll rebuilt the details between the click and the clipboard's answer: the button that is there now says it,
	   not only the one that was clicked and is gone */
	now += 5000;
	let answer;
	self.copyText = () => new Promise(r => { answer = r; });
	[ addr, mac ] = build();
	mac.on.click();
	const gone = mac;
	[ addr, mac ] = build();
	assert.equal(mac.textContent, 'Copy 00:00:5E:00:53:01', 'no answer yet');
	answer(true);
	await settle();
	assert.deepEqual([ gone.textContent, mac.textContent, addr.textContent ], [ 'Copied 00:00:5E:00:53:01', 'Copied 00:00:5E:00:53:01', 'Copy 192.0.2.7' ]);
	now += 2000;
	fire(2000);
	fire(30);
	assert.equal(mac.textContent, 'Copy 00:00:5E:00:53:01');
	self.copyText = (text, node) => { copied.push([ text, node.textContent ]); return Promise.resolve(result); };

	/* a copy that did not work says so, with no mark either */
	result = false;
	[ addr, mac ] = build();
	mac.on.click();
	await settle();
	fire(30);
	assert.deepEqual([ mac.textContent, say.textContent ], [ 'Not copied 00:00:5E:00:53:01', 'Not copied' ]);
	/* a second copy before the first one's moment is over keeps its own moment */
	result = true;
	now += 1000;
	addr.on.click();
	await settle();
	now += 1000;
	timers.splice(0).filter(x => x.ms === 2000)[0].fn();
	assert.equal(addr.textContent, 'Copied 192.0.2.7', 'the first copy\'s timer leaves the second alone');
	assert.deepEqual(copied.map(c => c[0]), [ '192.0.2.7', '00:00:5E:00:53:01', '192.0.2.7' ]);
	for (const word of [ 'Copy', 'Copied', 'Not copied' ]) assert.doesNotMatch(word, /[✓✔✅☑]/);
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.doesNotMatch(src.slice(src.indexOf('copyText: function'), src.indexOf('drawerWho: function')), /[✓✔✅☑]|icon\(/, 'no check mark, no icon');
});

test('copy buttons: the MAC and each IP address in a client\'s, a wired host\'s and the uplink\'s details; none where there is no value', t => {
	fakeDom(t);
	const m = apModel(null);
	const self = Object.assign(Object.create(dview), { m, st: { staRates: {}, devRates: {}, clientHist: {}, gone: [], uplinkRate: null, hist: { net: {} } }, ui: {}, el: {}, quiet: {}, canWrite: false });
	const tree = list => { const n = new FNode('x'); append(n, list); return n; };
	const names = n => n.find('vt-copy').map(b => b.textContent);
	const sta = m.clients[0], host = m.wiredHosts.filter(h => h.ips.length)[0];
	/* a station the host hints give no address: its MAC only */
	assert.deepEqual(names(tree(self.drawerClient(sta.mac).body)), [ 'Copy 00:00:5E:00:53:01' ]);
	sta.ips = [ '192.0.2.50', '2001:db8::50' ];
	const client = tree(self.drawerClient(sta.mac).body);
	assert.deepEqual(names(client), [ 'Copy 00:00:5E:00:53:01', 'Copy 192.0.2.50', 'Copy 2001:db8::50' ]);
	assert.match(client.textContent, /MAC address00:00:5E:00:53:01Copy 00:00:5E:00:53:01Address type/, 'on the value\'s own line');
	assert.deepEqual(names(tree(self.drawerWired(host).body)), [ 'Copy 00:00:5E:00:53:31', 'Copy 192.0.2.131' ]);
	/* the uplink: its addresses without their prefix lengths, the gateway, each DNS server */
	Object.assign(m.uplink, { ipv6: [ '2001:db8:7::5/64' ], dns: [ '203.0.113.53', '2001:db8::53' ] });
	const up = tree(self.drawerUplink('').body);
	assert.deepEqual(names(up), [ 'Copy 203.0.113.2', 'Copy 2001:db8:7::5', 'Copy 192.0.2.10', 'Copy 203.0.113.53', 'Copy 2001:db8::53' ]);
	assert.match(up.textContent, /IPv4203\.0\.113\.2\/24Copy 203\.0\.113\.2IPv62001:db8:7::5\/64Copy/, 'shown with the length');
	Object.assign(m.uplink, { ipv4: [], ipv6: [], gateway: null, dns: [] });
	const bare = tree(self.drawerUplink('').body);
	assert.deepEqual(names(bare), []);
	assert.match(bare.textContent, /IPv4—IPv6—/, 'a dash as before');
	for (const d of [ client, up ]) assert.ok(d.find('vt-copy').every(b => b.tag === 'button' && b.getAttribute('type') === 'button'));
});

/* --------------------------- from the review of the 1.1 batch: the wiring */

test('WireGuard: a poll\'s answer reaches the tile through the page\'s own state', () => {
	const saved = { window: global.window, L: global.L, document: global.document };
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0 };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { env: {}, resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	try {
		const self = Object.create(dview);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const raw = t => ({ at: t, info: { localtime: t / 1000 }, stat: '', ifaces: [], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {}, devs: {},
			wg: { reply: WG_SEVEN(), at: t } });
		self.ingest(Object.assign(raw(WG_T * 1000 - 5000), { wg: null }));
		assert.equal(self.m.wg, false, 'a page that has seen no tunnel has no tile');
		self.ingest(raw(WG_T * 1000));
		assert.equal(self.m.wg, true, 'the poll\'s answer makes the tile exist');
		assert.deepEqual(self.st.wg.map(t => [ t.name, t.peers.length ]), [ [ 'wg0', 7 ] ]);
		withPatchDom(() => {
			self.el = Object.assign(self.el || {}, { wg: new PNode('div') });
			self.paintWireguard();
			assert.equal(wgRows(self).length, 5, 'painted from the state the page itself made (ui.wgOpen)');
		});
	} finally { global.window = saved.window; global.L = saved.L; if (saved.document === undefined) delete global.document; else global.document = saved.document; }
});

test('copy: the drawer itself has the status line the Copy button speaks through', t => {
	fakeDom(t);
	const self = Object.create(dview);
	self.el = {};
	const layer = self.buildDrawer();
	const say = self.el.drawerSay;
	assert.ok(say, 'built with the drawer');
	assert.deepEqual([ say.getAttribute('role'), say.classList.contains('vt-sr') ], [ 'status', true ]);
	assert.ok(layer.all().includes(say), 'and in the drawer');
});

test('top talkers: the gateway stays out by its own mark, where the line\'s port is not known', () => {
	const self = Object.create(view);
	const m = talkModel();
	self.st = { devRates: TALK_RATES, staRates: {} };
	self.m = m;
	m.uplinks[0].port = null;
	m.uplink.port = null;
	assert.ok(!self.talkers(m).some(x => x.name === 'h4'), 'the gateway carries the line\'s traffic, not its own');
	assert.equal(self.talkHost(m.wiredHosts[3]), false);
});

test('offline: a rebuild with named devices listed notes nothing', () => {
	const self = Object.create(view);
	self.aliases = OFF_NAMES;
	self.st = { named: Object.create(null) };
	self.markOffline(offModel(), {}, 105000);
	const before = JSON.stringify(self.st.named);
	self.markOffline(offModel(), {}, null);
	assert.equal(JSON.stringify(self.st.named), before);
	assert.deepEqual([ self.st.named['00:00:5e:00:53:01'].at, self.st.named['00:00:5e:00:53:32'].at ], [ 105000, 85000 ]);
});

test('WireGuard: the wait starts past one second, not before', () => wgPolls(async c => {
	const reply = wgReply([ wgPeer('A', 'phone') ]);
	c.answer = () => Promise.resolve(reply);
	await c.poll(0);
	c.took = 1000;
	await c.poll(5e3);
	let n = c.asked;
	await c.poll(5e3);
	assert.equal(c.asked, n + 1, 'an answer within the second: asked again at the next poll');
	c.took = 1001;
	await c.poll(5e3);
	n = c.asked;
	await c.poll(5e3);
	await c.poll(5e3);
	assert.equal(c.asked, n, 'just over it: not for 10.01 s');
	await c.poll(5e3);
	assert.equal(c.asked, n + 1);
}));

test('offline: an address the host hints give now comes before the one remembered', () => {
	const self = Object.create(view);
	self.aliases = OFF_NAMES;
	self.st = { named: Object.create(null) };
	self.markOffline(offModel(), {}, 105000);
	const hints = Object.assign({}, OFF_LEFT.hints, { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.150' ] } });
	const m = offModel(Object.assign({}, OFF_LEFT, { hints }));
	self.markOffline(m, {}, 110000);
	assert.deepEqual(m.offline.filter(c => c.name === 'Laptop').map(c => c.ips), [ [ '192.0.2.150' ] ]);
});

/* --------------------------- from the review of the 1.1 batch: what it found wrong */

test('top talkers: a paired access point itself is not ranked, alone on its port with its clients\' traffic', () => {
	const self = Object.create(view);
	const m = talkModel();
	self.st = { devRates: TALK_RATES, staRates: {} };
	self.m = m;
	assert.deepEqual(self.talkers(m).map(x => x.name), [ 'h1' ]);
	/* h1 is ap-hall: its stations went to their own list, which left it alone on lan2 with the port's whole rate */
	m.accessPoints = [ { id: AP_ID, name: 'ap-hall', mac: m.wiredHosts[0].mac } ];
	assert.equal(self.talkHost(m.wiredHosts[0]), false);
	assert.deepEqual(self.talkers(m), []);
	/* an access point that is not reporting has no MAC to tell it by: nothing else is left out for it */
	m.accessPoints = [ { id: AP_ID, name: 'ap-hall', mac: null } ];
	assert.deepEqual(self.talkers(m).map(x => x.name), [ 'h1' ]);
});

test('search: a named device that is offline is found, said to be offline, and opens its details', () => {
	const self = searching({ offline: [ { mac: '00:00:5e:00:53:c2', name: 'workshop camera', secondary: '00:00:5E:00:53:C2', ips: [], offline: true } ],
		clients: [ sta('00:00:5e:00:53:21', 'camera bag tracker') ] });
	assert.deepEqual(says(self.searchEntries('camera')), [ [ 'client', 'camera bag tracker', '00:00:5E:00:53:21 · Harbor' ], [ 'client', 'workshop camera', '00:00:5E:00:53:C2 · Offline' ] ]);
	assert.deepEqual(says(self.searchEntries('53:c2')), [ [ 'client', 'workshop camera', '00:00:5E:00:53:C2 · Offline' ] ]);
	self.searchEntries('workshop')[0].run();
	assert.deepEqual(self.did, [ [ 'drawer', 'client', '00:00:5e:00:53:c2' ] ]);
});

test('layout: a tile that does not exist right now keeps its stored entry when the others are arranged', () => {
	const self = Object.create(view);
	const e = (id, c, w, hide) => Object.assign({ id, c, w }, hide ? { hide: true } : {});
	const ids = l => l.map(x => x.id + (x.hide ? '(hidden)' : ''));
	/* the WireGuard tile was hidden and put second; the tunnel is down, so the list being arranged has no such tile */
	const stored = [ e('hero', 0, 4), e('wg', 0, 2, true), e('chart', 0, 2), e('clients', 0, 4) ];
	assert.deepEqual(ids(self.keepAbsent([ e('clients', 0, 4), e('hero', 0, 4), e('chart', 0, 2) ], stored)), [ 'clients', 'hero', 'wg(hidden)', 'chart' ], 'after the tile it followed');
	assert.deepEqual(ids(self.keepAbsent([ e('chart', 0, 2), e('clients', 0, 4) ], [ e('wg', 0, 2), e('chart', 0, 2) ])), [ 'wg', 'chart', 'clients' ], 'first, where it was first');
	/* a tile in the list is taken as arranged; nothing stored, junk, or an unknown tile adds nothing */
	const now = [ e('clients', 0, 4), e('hero', 0, 4), e('wg', 0, 1), e('chart', 0, 2) ];
	assert.deepEqual(self.keepAbsent(now, stored), now);
	for (const junk of [ null, undefined, 'x', {}, [ null, 7, { id: 'nope', c: 0, w: 1 }, { c: 0, w: 1 } ] ]) assert.deepEqual(self.keepAbsent(now, junk), now, JSON.stringify(junk));
	/* and setLayout stores it so */
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.match(src, /else this\.layouts\[k\] = layout\.compact\(this\.keepAbsent\(list, this\.layouts\[k\]\)\);/);
});

test('details: a poll rebuilds them, but not under a selected text, and the focused control has the focus again', () => {
	const saved = { window: global.window, document: global.document };
	const self = Object.create(dview);
	const made = [];
	const button = () => ({ focused: 0, focus() { this.focused++; } });
	/* the body's controls are other elements after each rebuild (dom.content replaces its children) */
	let controls = [ button(), button() ], selection = null, next = () => controls.map(button);
	const body = { contains: n => n === 'in the details', querySelectorAll: () => controls, get childNodes() { return []; }, set childNodes(v) { controls = next(); } };
	self.ui = { drawer: { kind: 'device', id: 'device' }, editing: null };
	self.el = { drawer: { hidden: false }, drawerTitle: {}, drawerBody: body };
	self.drawerDevice = () => { made.push(1); return { title: [], body: [] }; };
	global.window = { getSelection: () => selection };
	global.document = { activeElement: null };
	try {
		self.paintDrawer();
		assert.equal(made.length, 1);
		assert.deepEqual(controls.map(c => c.focused), [ 0, 0 ], 'nothing had the focus: nothing gets it');
		/* the second control (a Copy button) has the focus when the poll comes */
		global.document.activeElement = controls[1];
		self.paintDrawer();
		assert.deepEqual([ made.length, controls.map(c => c.focused) ], [ 2, [ 0, 1 ] ], 'the control in its place has it again');
		/* the details changed shape (a row came or went): no guess at which control it was */
		global.document.activeElement = controls[1];
		next = () => [ button() ];
		self.paintDrawer();
		assert.deepEqual(controls.map(c => c.focused), [ 0 ]);
		next = () => controls.map(button);
		/* a text selected in the details: left as it is until the selection is gone */
		selection = { isCollapsed: false, anchorNode: 'in the details' };
		self.paintDrawer();
		assert.equal(made.length, 3, 'not rebuilt');
		selection = { isCollapsed: false, anchorNode: 'elsewhere on the page' };
		self.paintDrawer();
		selection = { isCollapsed: true, anchorNode: 'in the details' };
		self.paintDrawer();
		assert.equal(made.length, 5);
	} finally { global.window = saved.window; if (saved.document === undefined) delete global.document; else global.document = saved.document; }
});
