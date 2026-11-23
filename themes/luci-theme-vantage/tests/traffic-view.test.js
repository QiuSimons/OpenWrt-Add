'use strict';
/* The dashboard's side of luci-app-vantage-traffic (#110, experimental):
   model.trafficHosts, which checks the plugin's answer, and the view,
   which asks rpcd once a page whether the login holds the package's group
   (in the batch load() sends anyway), calls luci.vantage.traffic hosts
   only then, with the slow part of the poll, and shows the rate through
   this router for a wired host on a shared port, after a port of its own
   and the rate a paired access point reports. Without the package, or
   for a login without its group, nothing changes: no call, the same list
   and details. Top talkers is not touched (an open decision). The view
   runs with stub LuCI modules, as in view.test.js; its helpers for a
   small DOM are repeated here so that this file stands alone. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

const model = load('vantage.model');
const fmt = load('vantage.fmt');

const REPLIES = {};
const UI = {};
/* as LuCI's rpc.js answers a declare: a ubus status other than 0 rejects
   only with reject set, else it is the expected default ({}); a JSON-RPC
   error (-32000 no object, -32002 access denied) always rejects */
const declare = o => function(...args) {
	const f = REPLIES[o.object + ' ' + o.method], p = f ? f(...args) : Promise.resolve(null);
	return o.reject ? p : p.catch(e => { if (/ubus code [1-9]/.test(String(e && e.message))) return o.expect ? Object.values(o.expect)[0] : null; throw e; });
};
function loadView(dom) {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		rpc: { declare },
		poll: { active() { return true; } }, ui: UI, dom: dom || {}
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

/* a small DOM, as in view.test.js */
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
	get textContent() { return this.text != null ? this.text : this.childNodes.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
	all() { return [ this ].concat(...this.children.map(c => c.all())); }
	find(cls) { return this.all().filter(n => (n.attrs.class || '').split(' ').includes(cls)); }
	html() {
		const a = Object.keys(this.attrs).sort().map(k => ' ' + k + '=' + JSON.stringify(this.attrs[k])).join('');
		return '<' + this.tag + a + '>' + (this.text != null ? JSON.stringify(this.text) : '') + this.childNodes.map(n => typeof n === 'string' ? JSON.stringify(n) : n.html()).join('') + '</' + this.tag + '>';
	}
}
function append(n, ch) { [].concat(ch).forEach(c => { if (c instanceof FNode) n.appendChild(c); else if (c != null) n.childNodes.push(String(c)); }); }
const dview = loadView({ content(el, ch) { el.childNodes = []; el.text = null; append(el, ch); } });
const view = loadView();
function withFakeDom(fn) {
	const saved = { E: global.E, document: global.document, window: global.window, L: global.L };
	global.E = (tag, attrs, children) => {
		const n = new FNode(tag);
		for (const [ k, v ] of Object.entries(attrs || {})) if (typeof v === 'function') n.on[k] = v; else if (v != null) n.setAttribute(k, v);
		if (Array.isArray(children)) append(n, children);
		else if (children != null) n.innerHTML = String(children);
		return n;
	};
	global.document = { createElementNS: (ns, tag) => new FNode(tag) };
	global.window = { matchMedia: () => ({ matches: true }) };
	global.L = { url: (...p) => '/cgi-bin/luci/' + p.join('/') };
	try { return fn(); }
	finally { Object.assign(global, saved); }
}
const tree = list => { const n = new FNode('x'); append(n, list); return n; };

const PRINTER = '00:00:5e:00:53:31', NAS = '00:00:5e:00:53:33', DESK = '00:00:5e:00:53:32', AP_MAC = '02:00:5e:10:00:01';
/* a router (its line: wan) with br-lan: the printer and the NAS share
   lan1 with an access point's own MAC, the desk has lan2 to itself */
function routerModel(collector) {
	const m = model.build({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] }
		],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2' ] }, lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' },
			lan2: { devtype: 'ethernet', carrier: true, speed: '1000F' }, wan: { devtype: 'ethernet', carrier: true, speed: '1000F' } },
		hints: { [PRINTER.toUpperCase()]: { name: 'printer', ipaddrs: [ '192.0.2.131' ] }, [AP_MAC.toUpperCase()]: { name: 'ap-hall', ipaddrs: [ '192.0.2.10' ] } },
		fdb: [ { mac: AP_MAC, port: 'lan1', bridge: 'br-lan', seen: 1 }, { mac: PRINTER, port: 'lan1', bridge: 'br-lan', seen: 1 },
			{ mac: NAS, port: 'lan1', bridge: 'br-lan', seen: 1 }, { mac: DESK, port: 'lan2', bridge: 'br-lan', seen: 1 } ],
		collector
	});
	m.wired = false;
	return m;
}
const AP_ID = '0123456789abcdef';
const hall = wired => ({ id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', state: 'ok', error: null, age: 3, report: {
	name: 'OpenWrt', model: 'Example AP', uptime: 3600, mac: AP_MAC, ssids: [], stations: [], wired } });
const host = (m, mac) => m.wiredHosts.filter(h => h.mac === mac)[0];

/* a page as the poll leaves it, with two answers of the plugin 5 s apart: from the printer 1000 bytes and to it
   10000 (1.6 and 16 kbit/s); the desk listed too, at a rate its own port beats */
const ANSWER = (at, k, x) => Object.assign({ v: 1, at, took: 3, every: 5000, slow: false, low: false, acct: true, entries: 40, partial: false,
	offloaded: 0, hw: 0, zeroed: 0, dropped: 0, hosts: [
		{ mac: PRINTER, rx: 5000 + 1000 * k, tx: 90000 + 10000 * k }, { mac: DESK, rx: 1, tx: 1 + 1e6 * k }, { mac: AP_MAC, rx: 0, tx: 0 } ] }, x || {});
function page(m, answers) {
	const self = Object.create(dview);
	Object.assign(self, { m, ui: {}, el: {}, quiet: {}, canWrite: false });
	self.st = { staRates: {}, devRates: { lan1: { rx: 7e6, tx: 7e6 }, lan2: { rx: 1000, tx: 3000 } }, clientHist: {}, gone: [],
		traffic: null, trafficRates: null, trafficPrev: null, trafficSeen: 0, trafficNew: 0, trafficAt: null };
	for (const a of answers || []) self.noteTraffic(a);
	return self;
}
const live = (self, h) => tree(self.wiredCells(h, 0)).find('vt-td-live')[0];
const details = (self, h) => tree(self.drawerWired(h).body).textContent;

test('traffic model: the plugin\'s answer is checked and cut to its cap; anything else is no answer', () => {
	const t = model.trafficHosts(ANSWER(5000, 1, { hosts: [ { mac: '00-00-5E-00-53-31', rx: 1, tx: 2 }, { mac: PRINTER, rx: 9, tx: 9 }, { mac: '01:00:5e:00:53:01', rx: 1, tx: 1 },
		{ mac: 'x', rx: 1, tx: 1 }, { mac: NAS, rx: -1, tx: 1 }, { mac: DESK, rx: 'many', tx: 1 }, { mac: AP_MAC, rx: 1, tx: Infinity }, null ] }));
	assert.deepEqual(Object.keys(t.counters), [ PRINTER, '01:00:5e:00:53:01' ], 'normalised, the first of a MAC, numbers only');
	assert.deepEqual(t.counters[PRINTER], { rx: 1, tx: 2, at: 5000 }, 'each with the read\'s time, on the router\'s clock');
	assert.equal(Object.getPrototypeOf(t.counters), null);
	assert.deepEqual([ t.at, t.every, t.acct, t.partial, t.hw, t.zeroed ], [ 5000, 5000, true, false, 0, 0 ]);
	const many = [];
	for (let i = 0; i < 600; i++) many.push({ mac: '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), rx: 1, tx: 1 });
	assert.equal(Object.keys(model.trafficHosts(ANSWER(0, 0, { hosts: many })).counters).length, 512);
	for (const bad of [ null, 6, [], {}, { at: 1 }, { hosts: [] }, { at: '1', hosts: [] }, { at: NaN, hosts: [] } ]) assert.equal(model.trafficHosts(bad), null, JSON.stringify(bad));
	const odd = model.trafficHosts({ at: 1, hosts: [], every: 'soon', acct: 'yes', partial: 'all', hw: -3, zeroed: 2.5 });
	assert.deepEqual([ odd.every, odd.acct, odd.partial, odd.hw, odd.zeroed ], [ 5000, null, false, 0, 2 ]);
});

test('traffic view: a host on a shared port has the rate through this router, in the list and its details; its own port and a paired access point come first; Top talkers is unchanged', () => withFakeDom(() => {
	const m = routerModel(null), self = page(m, [ ANSWER(1000, 0), ANSWER(6000, 1) ]);
	const printer = host(m, PRINTER);
	assert.deepEqual([ printer.shared, printer.port ], [ true, 'lan1' ]);
	assert.deepEqual(self.listRate(printer), { rx: 1600, tx: 16000 }, 'bit/s between the two reads: from the host, to it');
	const cell = live(self, printer);
	assert.equal(cell.find('vt-live-total')[0].textContent, fmt.bits(17600));
	assert.equal(cell.find('vt-live-total')[0].getAttribute('title'), 'Through this router, from its connection tracking (read every 5 s)');
	assert.equal(cell.find('vt-live-split')[0].getAttribute('title'), 'To device ' + fmt.bits(16000) + ', from device ' + fmt.bits(1600));
	assert.equal(self.sortValue(printer, 'live'), 17600, 'sorted by it');
	const text = details(self, printer);
	assert.ok(text.includes('Traffic↓ ' + fmt.bits(16000) + ' · ↑ ' + fmt.bits(1600) + 'Through this router, from its connection tracking (read every 5 s)' +
		'Not counted: traffic with devices on the same networkthe port in total: ↓ ' + fmt.bits(7e6)), text);
	assert.equal(tree(self.wiredCells(printer, 0)).find('vt-td-link')[0].textContent, 'Shared portlan1 · 3 devices', 'its link stays the shared port');
	/* the desk has lan2 to itself: its port's rate, though the answer lists it */
	assert.deepEqual(self.listRate(host(m, DESK)), { rx: 1000, tx: 3000 });
	assert.ok(!('title' in tree(self.wiredCells(host(m, DESK), 0)).find('vt-live-total')[0].attrs));
	/* the NAS on the same port, not in the answer: as before */
	assert.equal(self.listRate(host(m, NAS)), null);
	assert.equal(live(self, host(m, NAS)).textContent, fmt.DASH);
	/* ranked by its port's rate as before: the desk only */
	assert.deepEqual(self.talkers(m).map(x => x.mac), [ DESK ]);

	/* ap-hall reports the printer alone on its lan2: that rate, said to be counted there */
	const both = routerModel({ aps: [ hall([ { mac: PRINTER, port: 'lan2', speed: 1000, rx: 2000, tx: 50000 } ]) ] });
	const apSelf = page(both, [ ANSWER(1000, 0), ANSWER(6000, 1) ]), p2 = host(both, PRINTER);
	assert.deepEqual(apSelf.listRate(p2), { rx: 2000, tx: 50000 });
	assert.equal(live(apSelf, p2).find('vt-live-total')[0].getAttribute('title'), 'Counted by ap-hall on its port lan2');
	assert.doesNotMatch(details(apSelf, p2), /Through this router/);
	/* ... sharing its port there too: this router's count, not "counted by ap-hall" */
	const shared = routerModel({ aps: [ hall([ { mac: PRINTER, port: 'lan2', speed: 1000 }, { mac: NAS, port: 'lan2', speed: 1000 } ]) ] });
	const shSelf = page(shared, [ ANSWER(1000, 0), ANSWER(6000, 1) ]), p3 = host(shared, PRINTER);
	assert.equal(p3.behind.rate, null);
	assert.deepEqual(shSelf.listRate(p3), { rx: 1600, tx: 16000 });
	assert.equal(live(shSelf, p3).find('vt-live-total')[0].getAttribute('title'), 'Through this router, from its connection tracking (read every 5 s)');
	assert.ok(details(shSelf, p3).includes('Access pointap-hallits port lan2'), 'the note stays');

	/* not for the gateway, a host on a line's port, or one on a line's own network (a dumb access point's hosts) */
	assert.equal(self.trafficRate(Object.assign({}, printer, { gateway: true })), null);
	const onLine = Object.create(self);
	onLine.m = Object.assign({}, m, { uplinks: [ Object.assign({}, m.uplinks[0], { port: 'lan1' }) ] });
	assert.equal(onLine.trafficRate(printer), null);
	onLine.m = Object.assign({}, m, { uplinks: [ Object.assign({}, m.uplinks[0], { l3dev: 'br-lan', port: 'eth0' }) ] });
	assert.equal(onLine.trafficRate(printer), null);
	assert.deepEqual(self.trafficRate(printer), { rx: 1600, tx: 16000 });
}));

test('traffic view: a read given twice keeps its rates; a failed call keeps them two slow polls; what may make them low is said', t => withFakeDom(() => {
	const saved = Date.now;
	let now = 1e12;
	Date.now = () => now;
	t.after(() => { Date.now = saved; });
	const m = routerModel(null), printer = host(m, PRINTER);
	const self = page(m, [ ANSWER(1000, 0), ANSWER(6000, 1) ]);
	self.noteTraffic(ANSWER(6000, 1));
	assert.deepEqual(self.listRate(printer), { rx: 1600, tx: 16000 }, 'the same read again: the same rates');
	self.noteTraffic(undefined);
	assert.deepEqual(self.listRate(printer), { rx: 1600, tx: 16000 }, 'not asked: kept');
	now += 9000;
	self.noteTraffic(null);
	assert.deepEqual(self.listRate(printer), { rx: 1600, tx: 16000 }, 'a failed call: kept a while');
	now += 2000;
	self.noteTraffic(null);
	assert.equal(self.listRate(printer), null, 'then none, not an old rate shown as current');
	assert.equal(live(self, printer).textContent, fmt.DASH);
	/* a failed call, then none for a minute (the plugin not there): none
	   two slow polls after the last answer, though no answer comes; back,
	   a base first, not a rate over the gap */
	const gone = page(m, [ ANSWER(1000, 0), ANSWER(6000, 1) ]);
	now += 5000;
	gone.noteTraffic(null);
	now += 5000;
	gone.noteTraffic(undefined);
	assert.deepEqual(gone.listRate(printer), { rx: 1600, tx: 16000 }, 'two slow polls: kept');
	now += 1;
	gone.noteTraffic(undefined);
	assert.equal(gone.listRate(printer), null, 'then none, without an answer');
	now += 50000;
	gone.noteTraffic(ANSWER(66000, 13));
	assert.equal(gone.listRate(printer), null, 'back: a base');
	now += 5000;
	gone.noteTraffic(ANSWER(71000, 14));
	assert.deepEqual(gone.listRate(printer), { rx: 1600, tx: 16000 }, 'then a rate of its own');
	/* the router started again under the page: its monotonic clock and the
	   plugin's counters start over (its state is RAM); the next two reads
	   give rates again, not only once the new uptime passes the old one */
	const booted = page(m, [ ANSWER(600000, 0), ANSWER(605000, 1) ]);
	booted.noteTraffic(ANSWER(30000, 0, { hosts: [ { mac: PRINTER, rx: 100, tx: 900 } ] }));
	assert.equal(booted.listRate(printer), null, 'the first read after it: a base');
	booted.noteTraffic(ANSWER(35000, 0, { hosts: [ { mac: PRINTER, rx: 1100, tx: 10900 } ] }));
	assert.deepEqual(booted.listRate(printer), { rx: 1600, tx: 16000 }, 'the next: a rate');
	/* the same read given on and on (the plugin reads no more): its rates
	   stand twice its every, then none, as for a failed call; a new read
	   starts over from itself, not from the old one */
	const stuck = page(m, [ ANSWER(1000, 0), ANSWER(6000, 1) ]);
	now += 10000;
	stuck.noteTraffic(ANSWER(6000, 1));
	assert.deepEqual(stuck.listRate(printer), { rx: 1600, tx: 16000 }, 'twice its every: kept');
	now += 1;
	stuck.noteTraffic(ANSWER(6000, 1));
	assert.equal(stuck.listRate(printer), null, 'longer: none');
	assert.equal(live(stuck, printer).textContent, fmt.DASH);
	stuck.noteTraffic(ANSWER(6000, 1));
	assert.equal(stuck.listRate(printer), null, 'and none while it lasts');
	stuck.noteTraffic(ANSWER(611000, 2));
	assert.equal(stuck.listRate(printer), null, 'the next read: a base, not a rate over the stall');
	now += 5000;
	stuck.noteTraffic(ANSWER(616000, 3));
	assert.deepEqual(stuck.listRate(printer), { rx: 1600, tx: 16000 });
	/* a slow plugin's every (2 minutes) or this page's slow poll (Low-power router, 30 s): the same read is usual that long */
	const slow = page(m, [ ANSWER(1000, 0, { every: 120000 }), ANSWER(121000, 1, { every: 120000 }) ]);
	now += 240000;
	slow.noteTraffic(ANSWER(121000, 1, { every: 120000 }));
	assert.notEqual(slow.listRate(printer), null, 'twice a slow every: kept');
	now += 1;
	slow.noteTraffic(ANSWER(121000, 1, { every: 120000 }));
	assert.equal(slow.listRate(printer), null);
	const doc = global.document;
	global.document = Object.assign({}, doc, { documentElement: { getAttribute: k => k === 'data-vt-power' ? 'low' : null } });
	try {
		const low = page(m, [ ANSWER(1000, 0), ANSWER(6000, 1) ]);
		now += 60000;
		low.noteTraffic(ANSWER(6000, 1));
		assert.notEqual(low.listRate(printer), null, 'twice the slow poll of a Low-power page: kept');
		now += 1;
		low.noteTraffic(ANSWER(6000, 1));
		assert.equal(low.listRate(printer), null);
	} finally { global.document = doc; }
	/* the read stopped short, connections offloaded to hardware, counters reset by another program */
	const noted = page(m, [ ANSWER(1000, 0), ANSWER(31000, 6, { partial: 'time', hw: 3, zeroed: 2, every: 30000 }) ]);
	const text = details(noted, printer);
	for (const s of [ 'From part of the connection table: reading all of it took too long', '3 connections offloaded to hardware may be missing',
		'Another program resets the connection counters (nlbwmon?): too low', '(read every 30 s)' ]) assert.ok(text.includes(s), s);
	/* accounting off: no rate, and the details say why */
	const off = page(m, [ ANSWER(1000, 0, { acct: false, hosts: [] }) ]);
	assert.ok(details(off, printer).includes('Not counted per device on a shared portConnection accounting is off on this router: per-device traffic counts nothing'));
}));

/* Without the package or its group: what view.test.js checks for a shared port, and the very same list cells and details */
test('traffic view: without the package or its group, the list and details are as before', () => withFakeDom(() => {
	const m = routerModel(null), printer = host(m, PRINTER);
	const bare = page(m, []), absent = page(m, [ ANSWER(1000, 0, { hosts: [] }), ANSWER(6000, 1, { hosts: [] }) ]);
	delete bare.st.traffic; delete bare.st.trafficRates;
	for (const self of [ bare, absent ]) {
		const c = live(self, printer);
		assert.deepEqual([ c.textContent, c.children[0].getAttribute('title') ], [ fmt.DASH, 'Not counted per device on a shared port' ]);
		assert.equal(self.sortValue(printer, 'live'), -1);
		assert.ok(details(self, printer).includes('TrafficNot counted per device on a shared portthe port in total: '));
	}
	assert.equal(tree(absent.wiredCells(printer, 0)).html(), tree(bare.wiredCells(printer, 0)).html(), 'the same row');
	assert.equal(tree(absent.drawerWired(printer).body).html(), tree(bare.drawerWired(printer).body).html(), 'the same details');
}));

/* fetch() with the test's replies: what the poll asks for */
async function polls(may, fn) {
	const saved = { L: global.L, document: global.document, now: Date.now };
	const c = { t: 1e12, asked: 0, low: false, reply: () => Promise.resolve(ANSWER(1000, 0)) };
	Date.now = () => c.t;
	global.document = { hidden: false, documentElement: { getAttribute: k => k === 'data-vt-power' ? (c.low ? 'low' : null) : null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	REPLIES['luci.vantage wireless'] = () => Promise.resolve({});
	REPLIES['luci.vantage thermal'] = () => Promise.resolve([]);
	REPLIES['luci.vantage wired'] = () => Promise.resolve({ hosts: [] });
	REPLIES['luci.vantage.traffic hosts'] = (...args) => { c.asked++; c.args = args; return c.reply(); };
	c.self = Object.create(view);
	c.self.canTraffic = may;
	try { await fn(c); }
	finally {
		global.L = saved.L; Date.now = saved.now;
		if (saved.document === undefined) delete global.document; else global.document = saved.document;
		for (const k of Object.keys(REPLIES)) delete REPLIES[k];
	}
}

test('traffic view: a login without the group never calls; with it, once a slow poll, without an argument, and no poll waits for it', async () => {
	const flush = () => new Promise(r => setImmediate(r));
	await polls(false, async c => {
		for (let i = 0; i < 6; i++) { assert.equal((await c.self.fetch()).traffic, undefined); await flush(); c.t += 5000; }
		assert.equal(c.asked, 0);
	});
	await polls(undefined, async c => {
		await c.self.fetch();
		await flush();
		assert.equal(c.asked, 0, 'load()\'s own first poll, before the answer about the group');
	});
	await polls(true, async c => {
		const a = await c.self.fetch();
		assert.deepEqual([ c.asked, c.args, a.traffic ], [ 1, [], undefined ], 'asked, and the poll goes on without it');
		await flush();
		c.t += 5000;
		const b = await c.self.fetch();
		assert.deepEqual([ c.asked, b.traffic.at ], [ 2, 1000 ], 'its answer is the next poll\'s; asked again');
		/* a call that stays out: no second one beside it, and no poll waits */
		let hold;
		c.reply = () => new Promise(r => { hold = r; });
		await flush();
		c.t += 5000;
		const d = await c.self.fetch();
		c.t += 5000;
		const e = await c.self.fetch();
		assert.deepEqual([ c.asked, e.traffic ], [ 3, undefined ], 'one at a time');
		hold(ANSWER(11000, 2));
		await flush();
		c.t += 5000;
		assert.equal((await c.self.fetch()).traffic.at, 11000, 'late, then the next poll\'s');
		assert.ok(d);
		/* the call that poll made, settled */
		c.reply = () => Promise.resolve(ANSWER(1000, 0));
		hold(ANSWER(16000, 3));
		await flush();
		/* Low-power router: the slow part every 30 s, and the call with it */
		const before = c.asked;
		c.low = true;
		c.t += 30000;
		await c.self.fetch();
		await flush();
		c.t += 5000;
		await c.self.fetch();
		await flush();
		assert.equal(c.asked, before + 1, 'between slow polls: not asked');
		c.reply = () => Promise.reject(new Error('RPC call to luci.vantage.traffic/hosts failed with error -32000: Object not found'));
		c.t += 30000;
		await c.self.fetch();
		await flush();
		c.t += 30000;
		assert.equal((await c.self.fetch()).traffic, null, 'a failed call is null');
	});
});

/* A call that says the plugin is not there (removed under the page, or
   rpcd's objects gone a moment while it reloads at a package install):
   asked again a minute later, whether it had answered before or not, and
   on as before once it answers. Its empty answer ({}: no read yet) and
   any other failure: at the next slow poll, as before */
test('traffic view: the plugin not there is asked for again a minute later, first answer or later; an empty answer or another failure at the next slow poll', async () => {
	const flush = () => new Promise(r => setImmediate(r));
	const step = async (c, ms) => { c.t += ms; const a = await c.self.fetch(); await flush(); return a; };
	const failed = msg => () => Promise.reject(new Error('RPC call to luci.vantage.traffic/hosts failed with ' + msg));
	for (const gone of [ 'ubus code 4: Resource not found', 'error -32000: Object not found', 'error -32002: Access denied' ]) {
		for (const answered of [ false, true ]) {
			await polls(true, async c => {
				if (answered) await step(c, 0);
				const before = c.asked;
				c.reply = failed(gone);
				await step(c, 5000);
				assert.equal(c.asked, before + 1);
				for (let i = 0; i < 11; i++) assert.equal((await step(c, 5000)).traffic, i ? undefined : null, gone);
				assert.equal(c.asked, before + 1, 'not asked for a minute: ' + gone + (answered ? ', after an answer' : ', as the first answer'));
				c.reply = () => Promise.resolve(ANSWER(70000, 1));
				await step(c, 5000);
				assert.equal(c.asked, before + 2, 'asked again a minute later');
				assert.equal((await step(c, 5000)).traffic.at, 70000, 'its answer read');
				await step(c, 5000);
				assert.equal(c.asked, before + 4, 'and every slow poll again');
			});
		}
	}
	for (const [ reply, got ] of [ [ () => Promise.resolve({}), {} ], [ failed('ubus code 7: Request timeout'), null ], [ () => Promise.reject(new Error('XHR request timed out')), null ] ]) {
		await polls(true, async c => {
			c.reply = reply;
			for (let i = 0; i < 3; i++) assert.deepEqual((await step(c, i ? 5000 : 0)).traffic, i ? got : undefined);
			assert.equal(c.asked, 3, 'asked every slow poll: ' + reply);
		});
	}
});

test('traffic view: load() asks about the group once, in its own batch, and keeps the answer', async () => {
	const saved = { L: global.L, menu: UI.menu, window: global.window, fetch: global.fetch };
	const groups = [];
	global.L = { env: { media: '/luci-static/vantage', resource_version: '25.12-1' }, resource: p => '/luci-static/resources/' + p,
		url: (...a) => '/cgi-bin/luci/' + a.join('/'), resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	global.fetch = () => Promise.resolve({ ok: false, text: () => Promise.resolve('') });
	const store = { getItem: () => null, setItem() {}, removeItem() {} };
	global.window = { sessionStorage: store, localStorage: store };
	UI.menu = { load: () => Promise.resolve(null) };
	try {
		for (const may of [ true, false ]) {
			REPLIES['session access'] = (scope, object, fn) => { groups.push(object + ' ' + fn); return Promise.resolve(scope === 'access-group' && object === 'luci-app-vantage-traffic' && fn === 'read' && may); };
			REPLIES['luci.vantage.traffic hosts'] = () => { throw new Error('called during load()'); };
			const data = await Object.create(view).load();
			assert.equal(data.canTraffic, may);
			const self = Object.create(view);
			self.initState(Object.assign({ board: {}, canWrite: false, canRdns: false, mdns: null }, data));
			assert.equal(self.canTraffic, may);
		}
		assert.equal(groups.filter(g => g === 'luci-app-vantage-traffic read').length, 2, 'once a page');
	} finally {
		global.L = saved.L; UI.menu = saved.menu; global.fetch = saved.fetch;
		if (saved.window === undefined) delete global.window; else global.window = saved.window;
		for (const k of Object.keys(REPLIES)) delete REPLIES[k];
	}
});
