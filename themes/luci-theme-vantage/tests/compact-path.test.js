'use strict';
/* The network path's compact form (#157): every node of its branches one
   line, picked under Customize beside the chart style and kept as the
   chart style is (this browser, the router through the theme's
   template). Off by default: the full path as it was. The view is
   loaded with stub LuCI modules and a small DOM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

/* elements as LuCI's E() and dom.content() build them, text nodes as strings */
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
	appendChild(n) { if (n instanceof FNode && n.parent) n.parent.removeChild(n); n.parent = this; this.childNodes.push(n); return n; }
	insertBefore(n, ref) { if (n instanceof FNode && n.parent) n.parent.removeChild(n); n.parent = this; const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); return n; }
	removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); if (n instanceof FNode) n.parent = null; return n; }
	addEventListener(t, f) { this.on[t] = f; }
	get textContent() { return this.text != null ? this.text : this.childNodes.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
	set textContent(v) { this.text = String(v); this.childNodes = []; }
	all() { return [ this ].concat(...this.children.map(c => c.all())); }
	find(cls) { return this.all().filter(n => (n.attrs.class || '').split(' ').includes(cls)); }
	html() {
		const a = Object.keys(this.attrs).sort().map(k => ' ' + k + '=' + JSON.stringify(this.attrs[k])).join('');
		return '<' + this.tag + a + '>' + (this.text != null ? JSON.stringify(this.text) : '') + this.childNodes.map(n => typeof n === 'string' ? JSON.stringify(n) : n.html()).join('') + '</' + this.tag + '>';
	}
}
function append(n, ch) { [].concat(ch).forEach(c => { if (c instanceof FNode) n.appendChild(c); else if (c != null) n.childNodes.push(String(c)); }); }
const fdom = { content(el, ch) { el.childNodes.forEach(c => { if (c instanceof FNode) c.parent = null; }); el.childNodes = []; el.text = null; append(el, ch); } };

const SRC = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
function loadView() {
	const stubs = { view: { extend: p => p }, rpc: { declare: () => () => Promise.resolve(null) }, poll: {}, ui: {}, dom: fdom };
	const params = [], values = [];
	for (const m of SRC.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, SRC)(...values);
}
const view = loadView();

/* a page: this browser's storage, the attributes the theme's template set
   on <html>, and the events the view sends */
function withPage(o, fn) {
	const saved = { E: global.E, document: global.document, window: global.window, L: global.L, CustomEvent: global.CustomEvent };
	const store = Object.assign({}, o.store), attrs = Object.assign({}, o.attrs), sent = [];
	global.E = (tag, a, children) => {
		const n = new FNode(tag);
		for (const [ k, v ] of Object.entries(a || {})) if (typeof v === 'function') n.on[k] = v; else if (v != null) n.setAttribute(k, v);
		if (Array.isArray(children)) append(n, children);
		else if (children != null) n.innerHTML = String(children);
		return n;
	};
	global.document = { createElementNS: (ns, tag) => new FNode(tag), documentElement: { getAttribute: k => (k in attrs ? attrs[k] : null) } };
	global.window = {
		matchMedia: () => ({ matches: true }),
		localStorage: { getItem: k => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
		/* the theme takes the event (preventDefault) where o.theme says so */
		dispatchEvent(ev) { sent.push(ev); if (o.theme) ev.defaultPrevented = true; return !ev.defaultPrevented; }
	};
	global.CustomEvent = function(type, init) { this.type = type; this.detail = init.detail; this.defaultPrevented = false; };
	global.L = { url: (...a) => '/' + a.join('/') };
	try { return fn({ store, attrs, sent }); }
	finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete global[k]; else global[k] = saved[k]; } }
}

const AP_ID = '0123456789abcdef';
/* a router: two radios (one SSID each, one radio switched off), stations
   with a strong, a weak and a fair signal, two ports with hosts, ap-hall
   paired (an SSID with a weak station and an idle one, two wired hosts),
   and its WAN */
function routerModel(aps) {
	const model = load('vantage.model');
	const m = model.build({
		ifaces: [
			{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ], route: [] },
			{ interface: 'wan', up: true, l3_device: 'wan', device: 'wan', 'ipv4-address': [ { address: '203.0.113.2', mask: 24 } ],
				route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] }
		],
		devs: { 'br-lan': { devtype: 'bridge', 'bridge-members': [ 'lan1', 'lan2', 'phy0-ap0' ] }, lan1: { devtype: 'ethernet', carrier: true, speed: '1000F' },
			lan2: { devtype: 'ethernet', carrier: true, speed: '1000F' }, wan: { devtype: 'ethernet', carrier: true, speed: '1000F' }, 'phy0-ap0': { devtype: 'wlan' } },
		wifi: {
			radio0: { up: true, config: { band: '5g', channel: '36', htmode: 'HE80' }, interfaces: [ { ifname: 'phy0-ap0', config: { ssid: 'Home', mode: 'ap', network: [ 'lan' ] } } ] },
			radio1: { up: false, disabled: true, config: { band: '2g', channel: '6', htmode: 'HE20', disabled: '1' }, interfaces: [] }
		},
		assoc: { 'phy0-ap0': [ { mac: '00:00:5E:00:53:01', signal: -50 }, { mac: '00:00:5E:00:53:02', signal: -80 }, { mac: '00:00:5E:00:53:03', signal: -70 } ] },
		hints: { '00:00:5E:00:53:31': { name: 'printer', ipaddrs: [ '192.0.2.131' ] }, '00:00:5E:00:53:21': { name: 'phone', ipaddrs: [ '192.0.2.121' ] } },
		fdb: [ { mac: '02:00:5e:10:00:01', port: 'lan1', bridge: 'br-lan', seen: 1 }, { mac: '00:00:5e:00:53:32', port: 'lan2', bridge: 'br-lan', seen: 1 },
			{ mac: '00:00:5e:00:53:33', port: 'lan2', bridge: 'br-lan', seen: 1 } ],
		collector: aps ? { aps } : null
	});
	m.wired = false;
	return m;
}
const hall = extra => Object.assign({ id: AP_ID, name: 'ap-hall', addr: '192.0.2.10', state: 'ok', error: null, age: 3, report: {
	name: 'OpenWrt', model: 'Example AP', uptime: 3600, mac: '02:00:5e:10:00:01',
	ssids: [ { ifname: 'phy1-ap0', bssid: '02:00:5e:10:00:11', ssid: 'Hall', freq: 5180, channel: 36, band: '5g' },
		{ ifname: 'phy0-ap0', bssid: '02:00:5e:10:00:12', ssid: 'Hall-IoT', freq: 2437, channel: 6, band: '2g' } ],
	stations: [ { mac: '00:00:5e:00:53:21', ifname: 'phy1-ap0', signal: -88, rx: 8000, tx: 64000, connected: 60 },
		{ mac: '00:00:5e:00:53:22', ifname: 'phy1-ap0', signal: -50, rx: 2000, tx: 1000000, connected: 60 } ],
	wired: [ { mac: '00:00:5e:00:53:41', port: 'lan3', speed: 100, rx: 4000, tx: 9000 }, { mac: '00:00:5e:00:53:42', port: 'lan4', speed: 1000 } ] } }, extra);

function hero(m, form, st) {
	const self = Object.create(view);
	self.m = m;
	self.pathForm = form;
	self.st = st || { devRates: {}, radioRates: {}, ssidRates: {}, staRates: {}, uplinkRate: null };
	self.el = { path: new FNode('div'), wires: new FNode('svg'), flows: new FNode('div') };
	self.el.path.appendChild(self.el.wires);
	self.el.path.appendChild(self.el.flows);
	self.paintWireState = () => {};
	self.paintHero();
	return self;
}
const RATES = { devRates: { lan1: { rx: 1000, tx: 12345678 }, lan2: { rx: 0, tx: 0 } }, radioRates: { radio0: { rx: 3000, tx: 2100000 } },
	ssidRates: { 'phy0-ap0': { rx: 3000, tx: 2100000 } }, staRates: {}, uplinkRate: null };
/* each line of the branches: its cells' texts */
const lines = self => self.hero.branches.find('vt-node').map(n => n.children.map(c => c.textContent));

test('compact path: every node of the branches is one line of four cells, name, how many, rate down and up; no client rows', () => withPage({}, () => {
	const self = hero(routerModel([ hall() ]), 'compact', RATES);
	const p = self.el.path;
	assert.equal(p.getAttribute('class'), 'vt-path vt-path-mesh vt-path-compact');
	for (const n of self.hero.branches.find('vt-node'))
		assert.deepEqual(n.children.map(c => c.getAttribute('class')).slice(1), [ 'vt-cl-num vt-tn', 'vt-cl-dn vt-tn', 'vt-cl-up vt-tn' ], n.textContent);
	/* a line without a count (a radio) lets its name have that cell too */
	assert.deepEqual(self.hero.branches.find('vt-node').map(n => n.children[0].getAttribute('class')), [ 'vt-cl-name vt-cl-wide', 'vt-cl-name', 'vt-cl-name vt-cl-wide',
		'vt-cl-name', 'vt-cl-name', 'vt-cl-name', 'vt-cl-name', 'vt-cl-name', 'vt-cl-name', 'vt-cl-name' ]);
	assert.doesNotMatch(self.hero.branches.html(), /vt-leaf-row|vt-node-body|vt-leaf-more/, 'no rows, no card bodies');
	assert.deepEqual(lines(self).map(c => [ c[0], c[1], c[3] ]), [
		[ '5 GHz Ch 36 · 80 MHz', '', '↑ 3 kbit/s' ],
		[ 'Home', '3 clients', '↑ 3 kbit/s' ],
		[ '2.4 GHz Ch 6 · 20 MHz', '', '' ],
		[ 'Wired', '3 devices', '↑ 1 kbit/s' ],
		[ 'lan1 · ap-hall', '1 Gbit/s', '↑ 1 kbit/s' ],
		[ 'lan2', '2 devices', '' ],
		[ 'ap-hall ', '4 devices', '↑ 14.0 kbit/s' ],
		[ '5 GHz Hall', '2 clients', '↑ 10.0 kbit/s' ],
		[ '2.4 GHz Hall-IoT', '0 clients', '' ],
		[ 'Wired', '2 devices', '↑ 4 kbit/s' ]
	]);
	/* down: in full, and short for a narrow tree; a radio switched off says so, a port where nothing moves is idle */
	const cells = self.hero.branches.find('vt-cl-dn').map(c => c.children.map(x => x.textContent));
	assert.deepEqual(cells, [ [ '↓ 2.1 Mbit/s', '↓2.10M' ], [ '↓ 2.1 Mbit/s', '↓2.10M' ], [ 'Disabled', 'Disabled' ], [ '↓ 12.3 Mbit/s', '↓12.3M' ],
		[ '↓ 12.3 Mbit/s', '↓12.3M' ], [ 'idle', 'idle' ], [ '↓ 1.07 Mbit/s', '↓1.07M' ], [ '↓ 1.06 Mbit/s', '↓1.06M' ], [ 'idle', 'idle' ], [ '↓ 9 kbit/s', '↓9.00k' ] ],
		'an access point\'s node: what its rows would have added up to; none there: idle');
	/* the access point's node: one count of all it has, its address and uptime only in its tooltip */
	const peer = p.find('vt-node-peer')[0];
	assert.doesNotMatch(peer.textContent, /192\.0\.2\.10|up 1h/);
	assert.match(peer.getAttribute('title'), /^Show the clients of ap-hall\n2 clients · 2 wired\n[\s\S]*192\.0\.2\.10/, 'the split of its count, its address: in its tooltip');
	assert.doesNotMatch(hero(routerModel([ hall() ]), 'full', RATES).el.path.find('vt-node-peer')[0].getAttribute('title'), /2 wired/, 'the card has them in its body');
	/* the same classes as the cards: idle, off */
	assert.deepEqual(self.hero.branches.find('vt-node').map(n => n.getAttribute('class')), [
		'vt-node vt-node-radio', 'vt-node vt-node-ssid', 'vt-node vt-node-radio vt-node-off', 'vt-node vt-node-radio', 'vt-node vt-node-ssid', 'vt-node vt-node-ssid',
		'vt-node vt-node-peer', 'vt-node vt-node-ssid', 'vt-node vt-node-ssid vt-node-idle', 'vt-node vt-node-ssid' ]);
	assert.match(self.heroKey(), /\ncompact\n/, 'the other form is another set of nodes');
}));

test('compact path: a line is one control named with all it shows, and a click does what the card\'s does', () => withPage({}, () => {
	const self = hero(routerModel([ hall({ state: 'offline', error: 'unreachable', age: 120, report: null }) ]), 'compact', RATES);
	const did = [];
	self.filterSsid = (ssid, band) => did.push([ 'ssid', ssid, band ]);
	self.showWired = (port, ap) => did.push([ 'wired', port, ap || null ]);
	self.showAp = id => did.push([ 'ap', id ]);
	self.openDrawer = (kind, id) => did.push([ kind, id ]);
	const nodes = self.hero.branches.find('vt-node');
	assert.ok(nodes.every(n => n.tag === 'button' && n.getAttribute('type') === 'button' && typeof n.on.click === 'function'), 'buttons, as the cards are');
	assert.deepEqual(nodes.map(n => n.getAttribute('aria-label')), [
		'5 GHz Ch 36 · 80 MHz, ↓ 2.1 Mbit/s  ↑ 3 kbit/s',
		'Home, 3 clients, ↓ 2.1 Mbit/s  ↑ 3 kbit/s, 1 weak',
		'2.4 GHz Ch 6 · 20 MHz, Disabled',
		'Wired, 3 devices, ↓ 12.3 Mbit/s  ↑ 1 kbit/s',
		'lan1 · Private device 00:01, 1 Gbit/s, ↓ 12.3 Mbit/s  ↑ 1 kbit/s',
		'lan2, 2 devices, idle',
		'ap-hall Not reachable over SSH'
	]);
	nodes.forEach(n => n.on.click());
	assert.deepEqual(did, [ [ 'radio', 'radio0' ], [ 'ssid', 'Home', '5g' ], [ 'radio', 'radio1' ], [ 'wired', null, null ], [ 'wired', 'lan1', null ], [ 'wired', 'lan2', null ], [ 'ap', AP_ID ] ]);
	/* not reporting: dimmed and dashed as its card is, why beside its name, no count or rate */
	const peer = self.el.path.find('vt-node-peer')[0];
	assert.equal(peer.getAttribute('class'), 'vt-node vt-node-peer vt-node-off');
	assert.deepEqual(peer.children.map(c => c.textContent), [ 'ap-hall Not reachable over SSH', '', '', '' ]);
}));

test('compact path: a line\'s tooltip carries its full name first, unless it names it already; what it said stays, written once a change', () => withPage({}, () => {
	const m = routerModel([ hall() ]);
	const self = hero(m, 'compact', RATES);
	const titles = () => self.hero.branches.find('vt-node').map(n => n.getAttribute('title'));
	assert.deepEqual(titles(), [
		'5 GHz Ch 36 · 80 MHz',
		'Show the clients of Home\nOpen network',
		'2.4 GHz Ch 6 · 20 MHz',
		'Wired',
		'lan1 · ap-hall\nShow the devices on lan1\nPort total: ↓ 12.3 Mbit/s · ↑ 1 kbit/s',
		'Show the devices on lan2\nPort total: ↓ 0 bit/s · ↑ 0 bit/s',
		'Show the clients of ap-hall\n2 clients · 2 wired\nCalls itself OpenWrt\nExample AP\n192.0.2.10\nLast report 3 s ago',
		'5 GHz Hall\nphy1-ap0 · 02:00:5E:10:00:11 · channel 36 · 5180 MHz',
		'2.4 GHz Hall-IoT\nphy0-ap0 · 02:00:5E:10:00:12 · channel 6 · 2437 MHz',
		'Wired\nShow the wired devices of ap-hall'
	]);
	/* a poll that changes nothing writes no title; a new name is written once */
	let writes = 0;
	self.hero.branches.find('vt-node').forEach(n => { const set = n.setAttribute; n.setAttribute = function(k, v) { if (k === 'title') writes++; return set.call(this, k, v); }; });
	self.updateHero();
	assert.equal(writes, 0);
	m.accessPoints[0].nodes[0].ssid = 'Hall-Upstairs';
	self.updateHero();
	assert.equal(writes, 1);
	assert.equal(titles()[7], '5 GHz Hall-Upstairs\nphy1-ap0 · 02:00:5E:10:00:11 · channel 36 · 5180 MHz');
	/* not reporting: its name, then why */
	const off = hero(routerModel([ hall({ state: 'offline', error: 'unreachable', age: 120, report: null }) ]), 'compact', RATES);
	assert.equal(off.el.path.find('vt-node-peer')[0].getAttribute('title'), 'ap-hall\nNot reachable over SSH\nOffline · last report 2 min ago\n192.0.2.10');
	assert.equal(off.el.path.find('vt-node-peer')[0].children[0].getAttribute('class'), 'vt-cl-name vt-cl-wide', 'its name and why take the count\'s cell');
	/* the full path's tooltips are as they were */
	const full = hero(m, 'full', RATES);
	assert.deepEqual(full.hero.branches.find('vt-node-ssid').map(n => n.getAttribute('title').split('\n')[0]),
		[ 'Show the clients of Home', 'Show the devices on lan1', 'Show the devices on lan2', 'phy1-ap0 · 02:00:5E:10:00:11 · channel 36 · 5180 MHz',
			'phy0-ap0 · 02:00:5E:10:00:12 · channel 6 · 2437 MHz', 'Show the wired devices of ap-hall' ]);
	assert.equal(full.hero.branches.find('vt-node-radio')[0].getAttribute('title'), null);
}));

test('compact path: a weak signal shows as one red dot before the count, set-quiet clients left out; fair and good ones show none', () => withPage({}, () => {
	const m = routerModel([ hall() ]);
	const self = hero(m, 'compact', RATES);
	const home = self.el.path.find('vt-node-ssid')[0], hallNode = self.el.path.find('vt-node-ssid')[3];
	const dot = n => n.find('vt-dot').map(d => [ d.getAttribute('class'), d.getAttribute('title') ]);
	assert.deepEqual(dot(home), [ [ 'vt-dot vt-lvl-crit', 'Unknown device 53:02 · −80 dBm' ] ], 'one dot for the −80 dBm station, none for −70 or −50');
	assert.deepEqual(dot(hallNode), [ [ 'vt-dot vt-lvl-crit', 'phone · −88 dBm' ] ], 'an access point\'s station, as its row showed it red');
	assert.equal(self.el.path.find('vt-dot').length, 2, 'the Wired nodes and ports have none');
	/* #110: set not to warn about its signal */
	self.quiet = { '00:00:5e:00:53:02': true };
	self.updateHero();
	assert.deepEqual(dot(home), []);
	assert.doesNotMatch(home.getAttribute('aria-label'), /weak/);
	/* the full path keeps its dot per client */
	const full = hero(m, 'full', RATES);
	assert.equal(full.el.path.find('vt-node-ssid')[0].find('vt-dot').length, 3);
}));

test('compact path off (the default): the full path, as before; back from compact it is the same again', () => withPage({}, () => {
	for (const aps of [ null, [ hall() ], [ hall({ state: 'waiting', age: null, report: null }) ] ]) {
		const m = routerModel(aps);
		const plain = hero(m, undefined, RATES), full = hero(m, 'full', RATES);
		assert.equal(full.el.path.html(), plain.el.path.html());
		assert.equal(full.heroKey(), plain.heroKey());
		assert.doesNotMatch(plain.el.path.html(), /vt-path-compact|vt-cl-|aria-label/);
		assert.doesNotMatch(plain.heroKey(), /compact/);
		/* a card's body: the full path's nodes */
		assert.ok(plain.hero.branches.find('vt-node').every(n => n.children.some(c => c.getAttribute('class') === 'vt-node-body')));
		const back = hero(m, 'compact', RATES);
		back.pathForm = 'full';
		back.paintHero();
		assert.equal(back.el.path.html(), plain.el.path.html(), 'compact, then full on the same page');
		assert.deepEqual(back.wireList().map(w => w.key), plain.wireList().map(w => w.key));
	}
	/* the client rows of the full path with an access point paired */
	assert.ok(hero(routerModel([ hall() ]), undefined, RATES).el.path.find('vt-leaf-row').length > 0);
}));

test('compact path: the wires are the full path\'s, the same keys between the same nodes, busy where they were', () => withPage({}, () => {
	const m = routerModel([ hall() ]);
	const full = hero(m, 'full', RATES), compact = hero(m, 'compact', RATES);
	const sum = s => s.wireList().map(w => [ w.key, !!w.active, w.speed ]);
	assert.deepEqual(sum(compact), sum(full));
	/* each wire still ends on a node of the path: its line */
	const nodes = new Set(compact.el.path.find('vt-node'));
	assert.ok(compact.wireList().every(w => nodes.has(w.from) && nodes.has(w.to)));
}));

test('path form: full unless picked; this browser\'s pick, the router\'s first for a login that may save (as the chart style)', () => {
	const form = o => withPage(o, () => { const self = Object.create(view); self.initState({}); return self.pathForm; });
	assert.equal(form({}), 'full');
	assert.equal(form({ store: { 'vantage.path.v1': 'compact' } }), 'compact');
	for (const junk of [ 'Compact', '"><img src=x>', 'constructor', '' ]) assert.equal(form({ store: { 'vantage.path.v1': junk } }), 'full', junk);
	/* the router's, handed over by the theme's template */
	assert.equal(form({ attrs: { 'data-vt-look-path': 'compact', 'data-vt-look-save': 'yes' } }), 'compact', 'a second browser gets the router\'s');
	assert.equal(form({ attrs: { 'data-vt-look-path': 'compact', 'data-vt-look-save': 'yes' }, store: { 'vantage.path.v1': 'full' } }), 'compact', 'the router first for a login that may save');
	assert.equal(form({ attrs: { 'data-vt-look-path': 'compact', 'data-vt-look-save': 'no' }, store: { 'vantage.path.v1': 'full' } }), 'full', 'any other keeps this browser\'s');
	assert.equal(form({ attrs: { 'data-vt-look-path': 'compact', 'data-vt-look-save': 'no' } }), 'compact', 'and gets the router\'s where it has none');
	assert.equal(form({ attrs: { 'data-vt-look-path': 'full', 'data-vt-look-save': 'yes' }, store: { 'vantage.path.v1': 'compact', 'vantage.view.unsaved': '["path"]' } }), 'compact',
		'changed here and not saved yet: this browser\'s stands');
	assert.equal(form({ attrs: { 'data-vt-look-path': 'bogus', 'data-vt-look-save': 'yes' } }), 'full');
});

test('path form: picked under Customize beside the chart style; kept, marked for the router, the path built again at its new height', () => withPage({ attrs: { 'data-vt-look-save': 'yes' } }, page => {
	const self = Object.create(view);
	self.initState({});
	const pick = self.buildPathPick();
	const select = pick.find('vt-select')[0];
	assert.equal(select.getAttribute('id'), 'vt-path-form');
	assert.deepEqual(pick.children.map(c => c.tag), [ 'label', 'select' ]);
	assert.deepEqual([ pick.children[0].getAttribute('for'), pick.children[0].textContent ], [ 'vt-path-form', 'Network path' ]);
	assert.deepEqual(select.children.map(o => [ o.getAttribute('value'), o.textContent ]), [ [ 'full', 'Full' ], [ 'compact', 'Compact, one line each' ] ]);
	assert.equal(select.value, 'full');
	assert.ok(SRC.includes("[ this.buildChartPick(), this.buildPathPick(), this.buildBackdropPick() ]"), 'beside the chart style');
	let painted = 0;
	self.m = {};
	self.hero = {};
	self.paintHero = () => { painted++; };
	self.wireRo = {};
	self.held = { hero: { h: 2000, since: 1 }, chart: { h: 300, since: 1 } };
	select.on.change({ target: { value: 'compact' } });
	assert.equal(self.pathForm, 'compact');
	assert.equal(page.store['vantage.path.v1'], 'compact');
	assert.deepEqual(JSON.parse(page.store['vantage.view.unsaved']), [ 'path' ], 'Done sends it to the router');
	assert.equal(painted, 1);
	assert.deepEqual(Object.keys(self.held), [ 'chart' ], 'the path\'s tile is not held at its old height');
	self.setPathForm('compact');
	self.setPathForm('cards');
	assert.equal(painted, 1, 'the same or an unknown form changes nothing');
	assert.equal(self.viewValues().path, 'compact');
	self.setPathForm('full');
	assert.ok(!('vantage.path.v1' in page.store), 'the default needs no entry');
}));

test('path form: Done hands it to the theme with the chart style\'s options, only when it changed', () => withPage({ attrs: { 'data-vt-look-save': 'yes' }, theme: true }, page => {
	const self = Object.create(view);
	self.initState({});
	self.layouts = Object.create(null);
	self.el = { editNote: new FNode('span') };
	self.m = {};
	self.hero = {};
	self.paintHero = () => {};
	self.wireRo = {};
	assert.equal(self.saveView(), false, 'nothing changed: nothing sent');
	self.setPathForm('compact');
	assert.equal(self.saveView(), true);
	assert.equal(page.sent.length, 1);
	assert.equal(page.sent[0].type, 'vantage:view-save');
	assert.deepEqual(page.sent[0].detail.values, { path: 'compact' });
	self.setEditing = () => {};
	page.sent[0].detail.done(true);
	assert.ok(!('vantage.view.unsaved' in page.store), 'saved: nothing left to send');
	/* a login that may not save: nothing marked, it stays in this browser */
	withPage({ attrs: { 'data-vt-look-save': 'no' } }, other => {
		const v = Object.create(view);
		v.initState({});
		v.m = {}; v.hero = {}; v.paintHero = () => {}; v.wireRo = {};
		v.setPathForm('compact');
		assert.equal(other.store['vantage.path.v1'], 'compact');
		assert.ok(!('vantage.view.unsaved' in other.store));
	});
}));

test('compact path: its styles apply under .vt-path-compact only; a narrower tree drops the rate up, then shortens the rate down; one column below the wide layout', () => {
	const css = fs.readFileSync(path.join(RES, 'vantage/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	/* every rule that names a line's cells or the tree's container is the compact path's */
	const rules = [ ...css.matchAll(/([^{}]+)\{([^{}]*)\}/g) ].map(m => ({ sel: m[1].trim(), body: m[2] }));
	const mine = rules.filter(r => /vt-cl-|vt-path-compact/.test(r.sel + r.body));
	assert.ok(mine.length > 10);
	for (const r of mine) for (const s of r.sel.split(',')) assert.match(s, /\.vt-path\.vt-path-compact\b/, s);
	const block = (at) => { const i = css.indexOf(at); assert.ok(i >= 0, at); return css.slice(i, css.indexOf('\n}', i)); };
	/* below the wide layout the tree has the tile's width but 34 px: under 500 px of it the rate up goes, under 400 px the short form */
	assert.match(block('@container vthero (max-width: 533px)'), /\.vt-cl-up \{ display: none; \}/);
	const narrow = block('@container vthero (max-width: 433px)');
	assert.match(narrow, /\.vt-cl-long \{ display: none; \}/);
	assert.match(narrow, /\.vt-cl-short \{ display: inline; \}/);
	/* and the names more room: set in 26 px, not 34 */
	assert.match(narrow, /\.vt-branches \{ --vt-nest: 26px; \}/);
	assert.match(narrow, /\.vt-branch-ssids \{ padding-left: 26px; \}/);
	assert.match(block('@container vthero (max-width: 1020px) {\n\t.vt-app .vt-path.vt-path-compact {'), /grid-template-columns: minmax\(0, 1fr\)/);
	/* the wide layout: the tree has the room access points' branches have */
	assert.match(block('@container vthero (min-width: 1021px) {\n\t.vt-app .vt-path.vt-path-compact {'), /grid-template-columns: minmax\(150px, \.7fr\) minmax\(90px, \.4fr\) minmax\(184px, \.85fr\) minmax\(0, 3\.4fr\)/);
	/* as wide as its longest name needs (a name 36em at most), no fixed cap; a line without a count lends its name that cell */
	const tree = rules.find(r => r.sel === '.vt-app .vt-path.vt-path-compact .vt-branches' && /display: flex/.test(r.body)).body;
	assert.match(tree, /width: fit-content;/);
	assert.match(tree, /max-width: 100%;/);
	assert.doesNotMatch(css, /vtlines|max-width: 640px/);
	assert.match(rules.find(r => r.sel === '.vt-app .vt-path.vt-path-compact .vt-cl-name').body, /max-width: 36em;/);
	assert.match(css, /\.vt-app \.vt-path\.vt-path-compact \.vt-cl-wide \{ grid-column: span 2; \}/);
	assert.match(css, /\.vt-app \.vt-path\.vt-path-compact \.vt-cl-wide \+ \.vt-cl-num \{ display: none; \}/);
	/* 26 px in still turns the wire's corner into the line's edge, as 34 px does */
	const wires = load('vantage.wires');
	for (const indent of [ 26, 34 ]) {
		const d = wires.curve({ l: 0, r: 300, t: 0, b: 28, cy: 14 }, { l: indent, r: 300, t: 32, b: 60, cy: 46 }).d;
		assert.match(d, /Q/, indent + ': a corner');
		assert.ok(d.endsWith('H' + indent + '.0'), d);
	}
	/* subgrid: every line shares the tree's columns */
	assert.match(css, /@supports \(grid-template-columns: subgrid\) \{\s*\.vt-app \.vt-path\.vt-path-compact \.vt-branches \{ display: grid; grid-template-columns: minmax\(6em, 1fr\) repeat\(3, auto\);/);
});
