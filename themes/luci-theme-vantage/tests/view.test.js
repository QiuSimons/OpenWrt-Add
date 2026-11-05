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

function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args) when set */
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: {}, ui: UI, dom: {}
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
	assert.deepEqual(openFor('#uplink=anything').opened, [ [ 'uplink', 'uplink' ] ], 'uplink takes no id');
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

test('live pill: under the Vantage theme only when not live; under another theme always', () => {
	const saved = { L: global.L, document: global.document };
	const pill = () => ({ className: '', hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
	const run = (media, st) => {
		global.L = { env: { media } };
		global.document = { hidden: false };
		const self = Object.create(view);
		self.st = Object.assign({ paused: false, lastErr: null, lastOk: Date.now() }, st);
		self.el = { live: pill(), liveText: { textContent: '' } };
		self.paintLive();
		return [ self.el.live.hidden, self.el.live.className ];
	};
	try {
		assert.deepEqual(run('/luci-static/vantage', {}), [ true, 'vt-livepill vt-live-ok' ], 'the theme\'s poll indicator says it');
		assert.deepEqual(run('/luci-static/vantage', { lastErr: new Error('x') }), [ false, 'vt-livepill vt-live-err' ]);
		assert.deepEqual(run('/luci-static/vantage/', { paused: true }), [ false, 'vt-livepill vt-live-paused' ]);
		assert.deepEqual(run('/luci-static/bootstrap', {}), [ false, 'vt-livepill vt-live-ok' ]);
	} finally {
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
	global.E = (tag, attrs, children) => ({ tag, attrs: attrs || {}, children: [].concat(children == null ? [] : children), style: { setProperty() {} } });
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
