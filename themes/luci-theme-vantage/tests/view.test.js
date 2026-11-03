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

function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args) when set */
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: {}, ui: {}, dom: {}
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
	const kpi = self.kpiSpecs()[0];
	assert.deepEqual([ kpi.value, kpi.sub ], [ '3', '3 wired' ]);
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
	assert.deepEqual([ shared.name.textContent, shared.count.textContent, shared.rate.textContent ], [ 'lan5', '2 devices', '↓ 12M  ↑ 3k' ]);
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
