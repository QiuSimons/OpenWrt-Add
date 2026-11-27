'use strict';
/* luci-app-vantage-aps's page, Network -> Access points
   (view/vantage/aps.js), with its menu entry and stylesheet, and the
   replay's stand-in for luci.vantage.pair (dev/replay/pair-plugin.js).

   The view is loaded with stub LuCI modules, as in view.test.js, and
   rendered into a small stand-in DOM. The codes it must have words for
   are read from the plugin's and the collector's sources. The stand-in's
   code, key, address, MAC and port checks run on the same cases as the
   add-on's vantage/aps.uc under a host ucode binary ($UCODE, else `ucode`
   on PATH; skipped without one), through tests/ucode/aps-harness.uc. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('./luci-stub');
const mkTmp = require('./tmpdir');
const pair = require('../dev/replay/pair-plugin');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'luci-app-vantage-aps');
const VIEW = path.join(PKG, 'htdocs/luci-static/resources/view/vantage/aps.js');
const src = fs.readFileSync(VIEW, 'utf8');
const GROUP = 'luci-app-vantage-aps';
const acl = JSON.parse(fs.readFileSync(path.join(PKG, 'root/usr/share/rpcd/acl.d/luci-app-vantage-aps.json'), 'utf8'));
const menu = JSON.parse(fs.readFileSync(path.join(PKG, 'root/usr/share/luci/menu.d/luci-app-vantage-aps.json'), 'utf8'));
const css = fs.readFileSync(path.join(PKG, 'htdocs/luci-static/resources/vantage/aps.css'), 'utf8');

/* ------------------------------------------------------------ the view */

const REPLIES = {};
const DECLARED = [];
/* LuCI's poll: what the page registered, and whether refreshing is on */
const POLL = { added: [], on: true, add(fn, s) { this.added.push({ fn, s }); }, active() { return this.on; } };
/* ui.showModal: the open dialog, as { title, body } */
const UI = { modal: null, showModal(title, body) { const n = new FakeNode('dialog'); n.set(body); this.modal = { title, body: n }; }, hideModal() { this.modal = null; } };
/* focus() calls, in order */
const FOCUS = [];
/* the page in the document (isConnected) */
const MOUNT = { page: null };

/* A small DOM for render(): elements as E() makes them, with what the
   page reads and sets (hidden, disabled, value, className, children as
   nodes or text). Text reaches it as strings inside arrays only. */
class FakeNode {
	constructor(tag) {
		Object.assign(this, { tag, attrs: {}, on: {}, children: [], parent: null, hidden: false, disabled: false, readOnly: false, value: '', className: '', placeholder: '' });
	}
	setAttribute(k, v) { this.attrs[k] = v; }
	appendChild(c) { c.parent = this; this.children.push(c); return c; }
	set(list) {
		for (const c of this.children) if (c instanceof FakeNode) c.parent = null;
		this.children = [];
		for (const c of list || []) {
			assert.ok(typeof c === 'string' || c instanceof FakeNode, 'content is text or an element');
			if (c instanceof FakeNode) this.appendChild(c); else this.children.push(c);
		}
	}
	get text() { return this.children.map(c => c instanceof FakeNode ? c.text : c).join(''); }
	get isConnected() { let n = this; while (n.parent) n = n.parent; return n === MOUNT.page; }
	has(cls) { return this.className.split(' ').includes(cls); }
	all(pred) {
		const out = [], f = typeof pred === 'string' ? (n => n.has(pred)) : pred;
		const walk = n => { for (const c of n.children) if (c instanceof FakeNode) { if (f(c)) out.push(c); walk(c); } };
		walk(this);
		return out;
	}
	focus() { FOCUS.push(this); }
	select() {}
	click() { assert.equal(typeof this.on.click, 'function', 'clickable'); return this.on.click({ currentTarget: this }); }
}

/* LuCI's E(): functions are listeners, the rest attributes; content an array */
global.E = (tag, attrs, content) => {
	const n = new FakeNode(tag);
	for (const [ k, v ] of Object.entries(attrs || {})) {
		if (typeof v === 'function') n.on[k] = v;
		else if (k === 'class') n.className = String(v);
		else if (k === 'hidden') n.hidden = true;
		else if (k === 'disabled') n.disabled = true;
		else if (k === 'readonly') n.readOnly = true;
		else n.attrs[k] = v;
	}
	assert.ok(content === undefined || Array.isArray(content), `E('${tag}') content is an array`);
	n.set(content);
	return n;
};
global.L = { bind: (f, self) => f.bind(self), resolveDefault: (p, d) => Promise.resolve(p).catch(() => d) };
global.document = {
	hidden: false, listeners: {},
	addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
	createElementNS: (ns, tag) => new FakeNode(tag)
};

/* dom.content as the page uses it: an array of elements and text */
const DOM = { content(node, c) { if (node instanceof FakeNode) node.set(c); else node.text = (c || []).map(x => typeof x === 'string' ? x : '').join(''); } };

function loadView() {
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args); none: a ubus error */
		rpc: { declare: o => { DECLARED.push(o); return (...args) => { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.reject(new Error('Object not found')); }; } },
		ui: UI, poll: POLL, dom: DOM
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		assert.ok(Object.prototype.hasOwnProperty.call(stubs, m[1]), 'only LuCI core modules: ' + m[1]);
		params.push(m[2] || m[1]);
		values.push(stubs[m[1]]);
	}
	return new Function(...params, src)(...values);
}

const view = loadView();

/* a stand-in element for the tests that call one method: what it reads and sets */
function el(extra) {
	return Object.assign({ value: '', hidden: false, disabled: false, text: '', focused: 0, selected: 0,
		focus() { this.focused++; }, select() { this.selected++; } }, extra);
}

/* promises the page left running */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

/* the page rendered and in the document */
function mount(status, report) {
	FOCUS.length = 0;
	UI.modal = null;
	POLL.added.length = 0;
	POLL.on = true;
	document.hidden = false;
	document.listeners = {};
	const self = Object.create(view);
	MOUNT.page = self.render({ status, report });
	return self;
}

/* ------------------------------- what the device's own code can answer */

const PLUGIN = fs.readFileSync(path.join(PKG, 'root/usr/share/rpcd/ucode/luci.vantage-pair'), 'utf8');
const APS_UC = fs.readFileSync(path.join(PKG, 'root/usr/share/ucode/vantage/aps.uc'), 'utf8');
const COLLECTOR = fs.readFileSync(path.join(PKG, 'root/usr/libexec/vantage/collector'), 'utf8');
/* a top-level function's body in a ucode source */
const body = (code, name) => {
	const m = new RegExp('^function ' + name + '\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\}$', 'm').exec(code);
	assert.ok(m, 'function ' + name + ' found');
	return m[1];
};
const literals = t => [ ...t.matchAll(/'([a-z][a-z-]*)'/g) ].map(m => m[1]);
const returned = t => [ ...new Set(t.split('\n').filter(l => /\breturn\b/.test(l)).flatMap(literals)) ];
/* the error codes of a plugin method: the literals in its { error: ... }
   replies; ssh: it also passes ssh_state()'s on ({ error: ssh }) */
function pluginErrors(method) {
	const codes = new Set();
	let ssh = false;
	for (const m of body(PLUGIN, method).matchAll(/\{\s*error:([^}]*)\}/g)) {
		const l = literals(m[1]);
		if (l.length) l.forEach(c => codes.add(c)); else ssh = true;
	}
	return { codes: [ ...codes ].sort(), ssh };
}
/* status.ap.ssh: what ssh_state() returns */
const SSH_SOURCE = returned(body(PLUGIN, 'ssh_state')).sort();
/* the report's error codes: fetch_error() in aps.uc, and what the
   collector sets itself */
const FETCH_ERRORS = [ ...new Set(returned(body(APS_UC, 'fetch_error'))
	.concat([ ...COLLECTOR.matchAll(/\b(?:e|\w+\.error)\s*=\s*([^;]*);/g) ].flatMap(m => literals(m[1])))) ].sort();
/* those the collector calls offline (aps.uc state()): could not be reached */
const OFFLINE_ERRORS = literals((/\(([^()]*)\)\s*\?\s*'offline'/.exec(body(APS_UC, 'state')) || [ '', '' ])[1]).sort();

const pairs = ubus => Object.entries(ubus || {}).flatMap(([ o, ms ]) => ms.map(m => o + ' ' + m)).sort();

test('aps: the declares are exactly the luci-app-vantage-aps grants; status and report read, the rest write', () => {
	/* the page's group, for administrators, and the one that only shows the access points on the dashboard:
	   that one reads the collector's report and nothing else, and writes nothing */
	assert.deepEqual(Object.keys(acl).sort(), [ GROUP, GROUP + '-view' ]);
	assert.deepEqual(acl[GROUP + '-view'].read, { ubus: { 'vantage.collector': [ 'report' ] } });
	assert.deepEqual(Object.keys(acl[GROUP + '-view']).sort(), [ 'description', 'read' ]);
	const g = acl[GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read', 'write' ]);
	assert.deepEqual(Object.keys(g.read), [ 'ubus' ], 'no uci or file grants');
	assert.deepEqual(Object.keys(g.write), [ 'ubus' ]);
	assert.deepEqual(pairs(g.read.ubus), [ 'luci.vantage.pair status', 'vantage.collector report' ]);
	assert.deepEqual(pairs(g.write.ubus), [ 'luci.vantage.pair add_ap', 'luci.vantage.pair allow_router', 'luci.vantage.pair remove_ap',
		'luci.vantage.pair revoke_router', 'luci.vantage.pair router_code' ]);
	const declared = DECLARED.map(d => d.object + ' ' + d.method).sort();
	assert.deepEqual(declared, [ ...pairs(g.read.ubus), ...pairs(g.write.ubus) ].sort(), 'every grant used, nothing else declared');
	assert.equal(new Set(declared).size, declared.length, 'each once');
	/* every declare literal (the ACL policy's form), arguments as the plugin's */
	assert.equal((src.match(/\brpc\s*(?:\.\s*declare\b|\[)/g) || []).length, DECLARED.length);
	const params = Object.fromEntries(DECLARED.map(d => [ d.method, d.params || [] ]));
	assert.deepEqual(params, { status: [], router_code: [], add_ap: [ 'code', 'addr' ], remove_ap: [ 'id' ], allow_router: [ 'code' ], revoke_router: [ 'key' ], report: [] });
	for (const [ m, sig ] of Object.entries(pair.POLICY)) assert.deepEqual(Object.keys(sig), params[m], m + ': the stand-in\'s policy');
	assert.ok(DECLARED.every(d => d.reject === true), 'a ubus error rejects, never a default');
	/* each declared function only ever called directly */
	for (const m of src.matchAll(/var (call\w+) = rpc\.declare\(/g))
		for (const u of src.matchAll(new RegExp('\\b' + m[1] + '\\b(.?)', 'g')))
			assert.ok(u[1] === '(' || /var\s+$/.test(src.slice(u.index - 4, u.index)), `${m[1]} used other than in a direct call`);
});

test('aps: menu entry under Network, after Switch (20) and before Routing (30), gated by the add-on\'s group', () => {
	assert.deepEqual(menu, { 'admin/network/vantage_aps': { title: 'Access points', order: 25,
		action: { type: 'view', path: 'vantage/aps' }, depends: { acl: [ GROUP ] } } });
	assert.ok(fs.existsSync(path.join(PKG, 'htdocs/luci-static/resources/view', menu['admin/network/vantage_aps'].action.path + '.js')));
	const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'luci-app-vantage/root/usr/share/luci/menu.d/zz-luci-app-vantage.json'), 'utf8'));
	assert.ok(!('admin/network/vantage_aps' in base), 'not in the dashboard package');
});

test('aps: no HTML sinks, no browser dialogs, no links, no save buttons; ES5 with tabs', () => {
	assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
	assert.doesNotMatch(src, /\b(alert|confirm|prompt)\s*\(/, 'confirmations through ui.showModal');
	/* an access point's address is text: no link to its LuCI (phishing) */
	assert.doesNotMatch(src, /'href'|\.href\b|window\.open|location\s*=/);
	for (const k of [ 'handleSave', 'handleSaveApply', 'handleReset' ]) assert.match(src, new RegExp(k + ': null'));
	assert.doesNotMatch(src, /=>|\b(let|const)\s+[A-Za-z_$][\w$]*\s*=|`/, 'ES5: var and function expressions');
	/* (block comments continue on lines indented by three spaces) */
	assert.ok(src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').every(l => !/^\t* +\S/.test(l)), 'tabs');
	/* each dialog's title a literal translation (LuCI puts it in an h4 as HTML) */
	const titles = [ ...src.matchAll(/ui\.showModal\(([^,]+),/g) ].map(m => m[1]);
	assert.deepEqual(titles, [ '_(\'Remove access point\')', '_(\'Revoke router\')' ]);
	/* both sheets: the dashboard's and the add-on's */
	assert.match(src, /fetch\(L\.resource\('vantage\/app\.css'\)/);
	assert.match(src, /fetch\(L\.resource\('vantage\/aps\.css'\)/);
	assert.match(src, /poll\.add\(L\.bind\(this\.refresh, this\), 5\);/, 'status and report every 5 s');
});

test('aps: stylesheet scoped under .vt-app as .vt-pair-*, matching the classes the view uses', () => {
	const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
	const selectors = [ ...bare.matchAll(/([^{}@]+)\{[^{}]*\}/g) ].flatMap(m => m[1].split(',')).map(s => s.trim()).filter(Boolean);
	assert.ok(selectors.length > 20);
	for (const s of selectors) assert.match(s, /^\.vt-app (?:[a-z]+)?\.vt-pair-[a-z-]+/, s);
	assert.doesNotMatch(bare, /var\(--v-/, 'tokens through app.css\'s --vt-*, which fall back from the theme\'s');
	const app = fs.readFileSync(path.join(ROOT, 'luci-app-vantage/htdocs/luci-static/resources/vantage/app.css'), 'utf8');
	assert.doesNotMatch(app, /vt-pair-/, 'nothing of the add-on in the dashboard\'s sheet');
	const used = new Set([ ...src.matchAll(/vt-pair-[a-z-]+/g) ].map(m => m[0]));
	const styled = new Set([ ...bare.matchAll(/vt-pair-[a-z-]+/g) ].map(m => m[0]));
	assert.deepEqual([ ...styled ].filter(c => !used.has(c)), [], 'no rules for classes the view does not use');
	for (const c of used) if (c !== 'vt-pair-page') assert.ok(styled.has(c), c + ' styled');
});

/* ------------------------------------------------ codes and prefilling */

const K = pair.fakeKey('host ap-x');
const RK = pair.fakeKey('router r1');
/* an access point's reply; its LAN MAC between the port and the name */
const MAC = '00:00:5e:00:53:10';
const ap = (k, a, p, n, m = MAC) => `vantage-ap 1 ssh-ed25519 ${k} ${a} ${p} ${m} ${n}`;
const rc = (k, n) => `vantage-router 1 ssh-ed25519 ${k} ${n}`;
/* an address check_private_addresses would stop at (link-local) */
const ip = (...o) => o.join('.');
/* a header that is not ssh-ed25519's, base64 still well-formed */
const RSA = Buffer.concat([ Buffer.from([ 0, 0, 0, 11 ]), Buffer.from('ssh-ed25518'), Buffer.from([ 0, 0, 0, 32 ]), Buffer.alloc(32, 7) ]).toString('base64');

/* [ code, accepted ] as the pairing design and vantage/aps.uc say */
const AP_CASES = [
	[ ap(K, '192.0.2.10', 22, 'ap-hall'), true ],
	[ `  vantage-ap 1 ssh-ed25519\n${K}\t198.51.100.20  2222 00:00:5e:00:53:20\nap-garage\r\n`, true ],
	[ ap(K, '2001:DB8::10', 22, 'ap-shed'), true ],
	[ ap(K, '2001:db8:0:0:0:0:0:1', 22, 'a'), true ],
	[ ap(K, '203.0.113.7', '022', 'ap.2_x-y'), true ],
	[ ap(K, '192.0.2.10', 65535, 'a'.repeat(63)), true ],
	[ ap(K, '192.0.2.10', 22, 'a'.repeat(64)), false ],
	[ ap(K, '192.0.2.10', 22, '-ap'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap/hall'), false ],
	[ ap(K, '192.0.2.10', 0, 'ap'), false ],
	[ ap(K, '192.0.2.10', 65536, 'ap'), false ],
	[ ap(K, '192.0.2.10', '22a', 'ap'), false ],
	[ ap(K, '127.0.0.1', 22, 'ap'), false ],
	[ ap(K, '0.1.2.3', 22, 'ap'), false ],
	[ ap(K, '224.0.0.1', 22, 'ap'), false ],
	[ ap(K, '192.0.2.256', 22, 'ap'), false ],
	[ ap(K, '192.0.2.01', 22, 'ap'), false ],
	[ ap(K, 'ap.example', 22, 'ap'), false ],
	[ ap(K, '::1', 22, 'ap'), false ],
	[ ap(K, '::', 22, 'ap'), false ],
	[ ap(K, 'fe80::1', 22, 'ap'), false ],
	[ ap(K, 'ff02::1', 22, 'ap'), false ],
	[ ap(K, '[2001:db8::1]', 22, 'ap'), false ],
	[ ap(K, '2001:db8::1%eth0', 22, 'ap'), false ],
	[ ap(K, '2001:db8::192.0.2.1', 22, 'ap'), false ],
	[ ap(K, '1::2::3', 22, 'ap'), false ],
	[ ap(K.slice(1), '192.0.2.10', 22, 'ap'), false ],
	[ ap(K + '=', '192.0.2.10', 22, 'ap'), false ],
	[ ap(RSA, '192.0.2.10', 22, 'ap'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap') + ' extra', false ],
	[ `vantage-ap 2 ssh-ed25519 ${K} 192.0.2.10 22 ${MAC} ap`, false ],
	[ `vantage-ap 1 ssh-rsa ${K} 192.0.2.10 22 ${MAC} ap`, false ],
	[ `vantage-ap 1 ssh-ed25519 ${K} 192.0.2.10 22 ${MAC}`, false ],
	/* the MAC: unicast, not all zeros; upper case taken and lowered */
	[ `vantage-ap 1 ssh-ed25519 ${K} 192.0.2.10 22 ap-hall`, false ],
	[ `vantage-ap 1 ssh-ed25519 ${K} 192.0.2.10 22 ap-hall ${MAC}`, false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '00:00:5E:00:53:0A'), true ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '02:00:5e:00:53:01'), true ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '01:00:5e:00:53:01'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '03:00:5e:00:53:01'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', 'ff:ff:ff:ff:ff:ff'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '00:00:00:00:00:00'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '00:00:5e:00:53'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '00:00:5e:00:53:10:01'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '00-00-5e-00-53-10'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '0000.5e00.5310'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '0:0:5e:0:53:10'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall', '00:00:5e:00:53:1g'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap') + ' '.repeat(600), false ],
	/* addresses with no host to reach, however spelled; a NUL byte anywhere */
	[ ap(K, ip(169, 254, 1, 1), 22, 'ap'), false ],
	[ ap(K, '0::1', 22, 'ap'), false ],
	[ ap(K, '0:0:0:0:0:0:0:1', 22, 'ap'), false ],
	[ ap(K, '::ffff:c000:20a', 22, 'ap'), false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall') + '\0', false ],
	[ ap(K, '192.0.2.10', 22, 'ap-hall\0x'), false ],
	[ ap(K, '192.0.2.10\0', 22, 'ap-hall'), false ],
	[ '\0' + ap(K, '192.0.2.10', 22, 'ap-hall'), false ],
	[ rc(RK, 'gw'), false ],
	[ '', false ]
];
const ROUTER_CASES = [
	[ rc(RK, 'gw-office'), true ],
	[ `\n${rc(RK, 'gw-office')}\n`, true ],
	[ `vantage-router  1 ssh-ed25519\n${RK} gw`, true ],
	[ rc(RK, '-gw'), false ],
	[ rc(RK, 'gw office'), false ],
	[ rc(RK.slice(0, -1), 'gw'), false ],
	[ rc(RSA, 'gw'), false ],
	[ `vantage-router 1 ssh-ed25519 ${RK}`, false ],
	[ ap(K, '192.0.2.10', 22, 'ap'), false ],
	[ rc(RK, 'gw\0'), false ],
	[ rc(RK + '\0', 'gw'), false ],
	[ 'vantage-router', false ]
];
const ADDR_CASES = [ '192.0.2.1', '198.51.100.255', '203.0.113.7', '203.0.113.200', '2001:db8::', '2001:DB8::A', '2001:db8:0:0:0:0:0:1',
	'127.0.0.1', '0.0.0.0', '223.255.255.255', '224.0.0.1', '255.255.255.255', '1.2.3', '1.2.3.4.5', '01.2.3.4', ip(169, 254, 0, 1), ip(169, 254, 255, 255),
	/* ::/8, however spelled: unspecified, loopback, IPv4-mapped and the rest */
	'::1', '::', '0::1', '0:0:0:0:0:0:0:1', '::0', '0::', '0::0', '0:0::0:1', '::2', '1::', 'ff::1', '::ffff:c000:201', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::',
	'fe80::1', 'febf::1', 'fec0::1', 'ff00::1', ':::', '2001:db8:1:2:3:4:5:6:7', '::ffff:192.0.2.1', '2001:db8::/32', ' 192.0.2.1', '',
	'192.0.2.1\0', '2001:db8::1\0', '\0', 7 ];
const PORT_CASES = [ '22', '022', '1', '65535', '0', '65536', '123456', '', 'x', '-1', '22\0', '2\x002', 22, 0 ];
const MAC_CASES = [ MAC, '00:00:5E:00:53:0A', '02:00:5e:00:53:01', '01:00:5e:00:53:01', 'ff:ff:ff:ff:ff:ff', '00:00:00:00:00:00', '00:00:5e:00:53',
	'00-00-5e-00-53-10', MAC + '\0', '', 5 ];
const NAME_OF_CASES = [ [ 'gw-office', 'router' ], [ 'my host!', 'router' ], [ '--x y', 'router' ], [ 'ünï', 'router' ], [ '', 'access-point' ],
	[ 'a'.repeat(80), 'router' ], [ '...', 'access-point' ], [ 'a\0b', 'router' ], [ 'gw\0', 'access-point' ] ];
/* a network's name, as netifd has it from a uci section */
const NET_CASES = [ 'lan', 'LAN_2', '_', 'a'.repeat(64), 'a'.repeat(65), '', 'br-lan', 'lan.1', 'lan guest', ' lan', 'lan\n', 'lan\0', 'lan\0x', 'län', '../x', 7, null ];
/* this device's interfaces as ubus network.interface dump lists them (IPv4 subnets: the stand-in's networks have no others), and addresses to place */
const iface = (name, dev, address, mask, extra) => Object.assign({ interface: name, up: true, l3_device: dev, 'ipv4-address': [ { address, mask } ] }, extra);
const NET_OF_IFACES = [ pair.IFACES, null, [],
	[ iface('wan', 'eth1', '198.51.100.2', 24), iface('lan', 'br-lan', '192.0.2.1', 24), iface('guest', 'br-guest', '198.51.100.129', 25), null, 7, [ 'lan' ] ],
	[ iface('lan', 'br-lan', '192.0.2.1', 24, { up: false }), iface('lan2', '../x', '192.0.2.1', 24), iface('my-lan', 'br-lan', '192.0.2.1', 25), iface('wide', 'eth1', '192.0.2.1', 16) ],
	[ iface('lan', 'br-lan', '192.0.2.1', 0), iface('lan', 'br-lan', '192.0.2.1', 33), iface('lan', 'br-lan', '192.0.2.256', 24), iface('lan', 'br-lan', 'x', 24), iface('lan', 'br-lan', '192.0.2.1', '24') ],
	[ iface('a', 'br-a', '192.0.2.1', 24), iface('b', 'br-b', '192.0.2.129', 24) ] ];
const NET_OF_ADDRS = [ '192.0.2.10', '192.0.2.255', '192.0.2.200', '198.51.100.7', '198.51.100.200', '203.0.113.9', '192.0.3.1', '192.0.2.256', '2001:db8::10', '', null, 7 ];

test('aps: the view parses what the stand-in accepts, the same way, and prefills nothing from a router code', () => {
	for (const [ code, ok ] of AP_CASES) {
		const p = pair.parseApReply(code);
		assert.equal(!!p, ok, JSON.stringify(code));
		if (!p) continue;
		assert.deepEqual(view.parseApReply(code), { addr: p.addr, port: p.port, name: p.name }, JSON.stringify(code));
	}
	assert.equal(view.parseApReply(rc(RK, 'gw')), null);
	assert.equal(view.codeKind(rc(RK, 'gw')), 'router');
	assert.equal(view.codeKind('  ' + ap(K, '192.0.2.10', 22, 'ap')), 'ap');
	assert.equal(view.codeKind('hello'), null);
	assert.equal(view.codeKind(null), null);
	assert.equal(view.normCode(`  vantage-ap 1\n ssh-ed25519\t${K}  `), `vantage-ap 1 ssh-ed25519 ${K}`);
	assert.equal(view.normCode(' \n '), '');
	/* the address goes with add_ap only when it is another one */
	const parsed = { addr: '192.0.2.10' };
	assert.equal(view.addrOverride('', parsed), undefined);
	assert.equal(view.addrOverride(' 192.0.2.10 ', parsed), undefined);
	assert.equal(view.addrOverride(' 198.51.100.7\n', parsed), '198.51.100.7');
	assert.equal(view.addrOverride('198.51.100.7', null), '198.51.100.7');
	assert.equal(view.shortKey(K), '…' + K.slice(-12));
});

function addForm() {
	const self = Object.create(view);
	self.add = { reply: el(), addr: el(), go: el({ disabled: true }), err: el({ hidden: true }), seen: el(), addrEdited: false };
	self.el = { addFlow: el(), addBtn: el({ hidden: true }) };
	self.refreshed = 0;
	self.refresh = function() { this.refreshed++; return Promise.resolve(); };
	return self;
}

test('aps: a pasted reply prefills the address until the field is edited, and says what it is', () => {
	const self = addForm(), f = self.add;
	f.reply.value = ap(K, '198.51.100.20', 2222, 'ap-garage');
	self.onReply();
	assert.equal(f.addr.value, '198.51.100.20');
	assert.equal(f.go.disabled, false);
	assert.equal(f.seen.text, 'Access point ap-garage, SSH port 2222.');
	f.reply.value = ap(K, '2001:DB8::10', 22, 'ap-shed');
	self.onReply();
	assert.equal(f.addr.value, '2001:db8::10');
	assert.equal(f.seen.text, 'Access point ap-shed.');
	/* edited: kept */
	f.addr.value = '192.0.2.99';
	f.addrEdited = true;
	f.reply.value = ap(K, '198.51.100.20', 22, 'ap-garage');
	self.onReply();
	assert.equal(f.addr.value, '192.0.2.99');
	/* a router's code or a half line: no prefill, a hint, Add still possible (the plugin decides) */
	const g = addForm();
	g.add.reply.value = rc(RK, 'gw');
	g.onReply();
	assert.equal(g.add.addr.value, '');
	assert.equal(g.add.seen.text, 'This is a router\'s code: paste it on the access point instead.');
	assert.equal(g.add.go.disabled, false);
	g.add.reply.value = 'vantage-ap 1';
	g.onReply();
	assert.equal(g.add.seen.text, 'This does not look like an access point\'s reply yet.');
	g.add.reply.value = '  ';
	g.onReply();
	assert.equal(g.add.go.disabled, true, 'nothing to send');
	assert.equal(g.add.seen.text, '');
});

test('aps: Add sends the normalised reply, the address only when changed, and says each refusal in words', async () => {
	const calls = [];
	const self = addForm(), f = self.add;
	f.reply.value = ` ${ap(K, '198.51.100.20', 2222, 'ap-garage')}\n`;
	self.onReply();
	REPLIES['luci.vantage.pair add_ap'] = (...a) => { calls.push(a); return Promise.resolve({ id: '0123456789abcdef' }); };
	await self.submitAdd();
	assert.deepEqual(calls.pop(), [ ap(K, '198.51.100.20', 2222, 'ap-garage'), undefined ]);
	assert.equal(self.el.addFlow.hidden, true, 'closed');
	assert.equal(self.refreshed, 1);
	f.addr.value = '192.0.2.77';
	await self.submitAdd();
	assert.deepEqual(calls.pop(), [ ap(K, '198.51.100.20', 2222, 'ap-garage'), '192.0.2.77' ]);
	for (const [ reply, words ] of [
		[ { error: 'duplicate' }, 'This access point is already on this dashboard.' ],
		[ { error: 'full' }, 'This dashboard already reads 16 access points. Remove one first.' ],
		[ { error: 'invalid' }, /the address must be an IPv4 or IPv6 address/ ],
		[ { error: 'no-key' }, /no key yet/ ],
		[ { error: 'failed' }, /could not save/ ],
		[ null, 'The access point could not be added.' ]
	]) {
		REPLIES['luci.vantage.pair add_ap'] = () => Promise.resolve(reply);
		await self.submitAdd();
		assert.equal(f.err.hidden, false);
		if (typeof words === 'string') assert.equal(f.err.text, words); else assert.match(f.err.text, words);
		assert.equal(f.go.disabled, false, 'can try again');
	}
	f.addr.value = '198.51.100.20';
	REPLIES['luci.vantage.pair add_ap'] = () => Promise.resolve({ error: 'invalid' });
	await self.submitAdd();
	assert.match(f.err.text, /^That is not an access point's reply/, 'no override: the reply is wrong');
	/* saved, and the collector's service did not start: said, the form stays for a second try, the row shows behind it;
	   the same call again, answered with the service running, closes it */
	self.el.addFlow.hidden = false;
	const before = self.refreshed;
	REPLIES['luci.vantage.pair add_ap'] = (...a) => { calls.push(a); return Promise.resolve({ id: '0123456789abcdef', collector: false }); };
	await self.submitAdd();
	assert.equal(f.err.text, 'The access point is saved, but this device could not set up the service that reads it. Try again.');
	assert.deepEqual([ f.err.hidden, self.el.addFlow.hidden, f.go.disabled, self.refreshed ], [ false, false, false, before + 1 ]);
	REPLIES['luci.vantage.pair add_ap'] = (...a) => { calls.push(a); return Promise.resolve({ id: '0123456789abcdef', collector: true }); };
	await self.submitAdd();
	assert.deepEqual(calls.slice(-2), [ [ ap(K, '198.51.100.20', 2222, 'ap-garage'), undefined ], [ ap(K, '198.51.100.20', 2222, 'ap-garage'), undefined ] ], 'the same call again');
	assert.deepEqual([ f.err.hidden, self.el.addFlow.hidden ], [ true, true ]);
	REPLIES['luci.vantage.pair add_ap'] = () => Promise.reject(new Error('Permission denied'));
	await self.submitAdd();
	assert.equal(f.err.text, 'The request failed: Permission denied');
	delete REPLIES['luci.vantage.pair add_ap'];
});

test('aps: letting a router in shows the reply; refusals in words, SSH states as the warnings say them', async () => {
	const self = Object.create(view);
	self.status = { ssh: 'ok', routers: [], aps: [] };
	self.el = { allowFlow: el(), allowBtn: el({ hidden: true }), again: { field: el() }, againBox: el(), ssh: el(), routerRows: el() };
	self.paintRouters = () => {};
	self.refresh = () => Promise.resolve();
	const shown = [];
	self.allow = { code: el(), seen: el(), where: el(), err: el({ hidden: true }), go: el(), step2: el({ hidden: true }), ask: el(), done: el({ hidden: true }),
		reply: { btn: el(), set: t => shown.push(t) } };
	const f = self.allow;
	f.code.value = ap(K, '192.0.2.10', 22, 'ap');
	self.onRouterCode();
	assert.equal(f.seen.text, 'This is an access point\'s reply: paste it on the router instead.');
	f.code.value = `\n${rc(RK, 'gw-lab')}\n`;
	self.onRouterCode();
	assert.equal(f.seen.text, 'Router gw-lab.');
	const calls = [];
	REPLIES['luci.vantage.pair allow_router'] = c => { calls.push(c); return Promise.resolve({ reply: ap(K, '192.0.2.1', 22, 'this-ap') }); };
	await self.submitAllow();
	assert.deepEqual(calls, [ rc(RK, 'gw-lab') ]);
	assert.deepEqual(shown, [ ap(K, '192.0.2.1', 22, 'this-ap') ]);
	assert.equal(f.step2.hidden, false);
	assert.equal(f.code.readOnly, true, 'the code stays, read-only');
	assert.equal(f.done.hidden, false);
	assert.equal(f.ask.hidden, true);
	for (const [ reply, words ] of [
		[ { error: 'invalid' }, /^That is not a router's code/ ],
		[ { error: 'full' }, /^8 routers can already read/ ],
		[ { error: 'duplicate' }, /added by hand/ ],
		[ { error: 'failed' }, /could not update its SSH keys/ ],
		[ { error: 'no-key-options' }, view.sshProblem('no-key-options') ],
		[ { error: 'not-running' }, view.sshProblem('not-running') ],
		[ { error: 'no-address' }, view.sshProblem('no-address') ],
		[ 42, 'The router could not be let in.' ]
	]) {
		REPLIES['luci.vantage.pair allow_router'] = () => Promise.resolve(reply);
		await self.submitAllow();
		assert.equal(f.err.hidden, false);
		if (typeof words === 'string') assert.equal(f.err.text, words); else assert.match(f.err.text, words);
	}
	delete REPLIES['luci.vantage.pair allow_router'];
});

/* ------------------------------------------------ messages per code */

/* The codes come from the device's own sources (pluginErrors, SSH_SOURCE,
   FETCH_ERRORS above), not from a list here: one added there without
   words of its own on the page fails. */
test('aps: every code the plugin and the collector can answer has words of its own', () => {
	/* the derivation found them */
	for (const c of [ 'hostkey', 'denied', 'unreachable', 'timeout', 'invalid' ]) assert.ok(FETCH_ERRORS.includes(c), c + ' among the report errors');
	assert.deepEqual(OFFLINE_ERRORS, [ 'timeout', 'unreachable' ]);
	assert.ok(SSH_SOURCE.includes('ok') && SSH_SOURCE.includes('no-key-options'));
	assert.deepEqual(pluginErrors('remove_ap').codes, [ 'failed', 'unknown' ]);

	const own = (codes, say, what) => {
		const generic = say('a-code-nobody-answers');
		const words = codes.map(say);
		words.forEach((w, i) => {
			assert.equal(typeof w, 'string', `${what} ${codes[i]}`);
			assert.notEqual(w, generic, `${what} ${codes[i]}: the generic words`);
		});
		assert.equal(new Set(words).size, words.length, `${what}: each its own (${codes})`);
	};
	/* the report's errors */
	own(FETCH_ERRORS, c => view.reportError(c), 'report error');
	assert.equal(view.reportError(null), view.reportError('a-code-nobody-answers'));
	assert.equal(view.reportError('missing'), 'Vantage\'s access point add-on is not installed on it. Install luci-app-vantage-aps there again.');
	assert.match(view.reportError('invalid'), /Update Vantage on it/);

	/* this device's SSH */
	assert.equal(view.sshProblem('ok'), null);
	own(SSH_SOURCE.filter(c => c !== 'ok'), c => view.sshProblem(c), 'SSH state');
	assert.equal(view.sshProblem('no-key-options'), 'This device\'s Dropbear ignores key restrictions; letting a router in would give it full access, so pairing is off.');
	assert.equal(view.sshProblem('unsupported'), 'Dropbear\'s settings on this device (root login off, a forced command or its own host key files) keep a router from reading it, so pairing is off.');
	assert.deepEqual(pair.SSH_STATES.slice().sort(), SSH_SOURCE, 'the stand-in knows the same states');

	/* each method's refusals */
	const add = pluginErrors('add_ap');
	assert.equal(add.ssh, false);
	own(add.codes, c => view.addError({ error: c }, false), 'add_ap');
	own(add.codes, c => view.addError({ error: c }, true), 'add_ap with an address');
	assert.match(view.addError({ error: 'invalid' }, false), /^That is not an access point's reply/);
	assert.match(view.addError({ error: 'invalid' }, true), /address/);

	const allow = pluginErrors('allow_router');
	assert.equal(allow.ssh, true, 'passes the SSH state on');
	own(allow.codes.concat(SSH_SOURCE.filter(c => c !== 'ok')), c => view.allowError({ error: c }), 'allow_router');
	for (const c of SSH_SOURCE.filter(x => x !== 'ok')) assert.equal(view.allowError({ error: c }), view.sshProblem(c), c + ': as the warning says it');

	own(pluginErrors('router_code').codes, c => view.codeError({ error: c }), 'router_code');
	assert.match(view.codeError({ error: 'no-dbclient' }), /dbclient/);

	/* gone already is what was asked: no words, the dialog closes */
	for (const m of [ 'remove_ap', 'revoke_router' ]) {
		const { codes, ssh } = pluginErrors(m);
		assert.equal(ssh, false);
		assert.ok(codes.includes('unknown'), m);
		assert.equal(view.dropError({ error: 'unknown' }), null);
		own(codes.filter(c => c !== 'unknown'), c => view.dropError({ error: c }), m);
	}
	assert.equal(view.dropError({ ok: true }), null);
	assert.match(view.dropError(null), /did not do it/);
});

test('aps: live state from the report; a failed report call is no live state, not an error', () => {
	const id = '0123456789abcdef';
	assert.equal(view.liveOf(id, null), null);
	assert.deepEqual(view.liveOf(id, { aps: [] }), { state: 'waiting' }, 'not picked up yet');
	const ok = { id, state: 'ok', age: 3, error: null };
	assert.equal(view.liveOf(id, { aps: [ null, 'x', ok ] }), ok);
	const st = live => view.stateLine(live);
	assert.deepEqual(st(null), { cls: 'none', text: 'No live state', why: null });
	assert.deepEqual(st(ok), { cls: 'ok', text: 'Reporting, 3 s ago', why: null });
	assert.equal(st({ state: 'ok', age: 125 }).text, 'Reporting, 2 min ago');
	assert.equal(st({ state: 'ok', age: null }).text, 'Reporting');
	/* its last report, served as ok right after a pause in viewing */
	assert.deepEqual(st({ state: 'ok', age: 400, error: null }), { cls: 'ok', text: 'Reporting, 6 min ago', why: null });
	assert.deepEqual(st({ state: 'waiting', age: null, error: null }), { cls: 'wait', text: 'Waiting for its first report', why: null });
	/* the collector's own pairs of state and error: offline says why too */
	for (const e of FETCH_ERRORS) {
		if (OFFLINE_ERRORS.includes(e)) {
			assert.deepEqual(st({ state: 'offline', error: e, age: 7300 }), { cls: 'off', text: 'Offline, last report 2 h ago', why: view.reportError(e) });
			assert.deepEqual(st({ state: 'offline', error: e, age: null }), { cls: 'off', text: 'Offline', why: view.reportError(e) });
		}
		else
			assert.deepEqual(st({ state: 'error', error: e, age: 50 }), { cls: 'err', text: 'Not reporting', why: view.reportError(e) });
	}
	assert.match(st({ state: 'offline', error: 'unreachable' }).why, /cannot connect to it\. Check that it is on and that its SSH port is reachable/);
	assert.match(st({ state: 'offline', error: 'timeout' }).why, /did not answer in time/);
	assert.equal(st({ state: 'offline', age: 3 * 86400, error: 'timeout' }).text, 'Offline, last report 3 days ago');
	assert.deepEqual(st({ state: 'offline', age: -1, error: null }), { cls: 'off', text: 'Offline', why: null }, 'no reason given: none shown');
	assert.equal(st({ state: 'bogus' }).cls, 'none');
});

/* ------------------------------------------------ the page, rendered */

const tile = (self, which) => (which === 'router' ? self.el.apRows : self.el.routerRows).parent;
const rows = list => list.all('vt-pair-row').map(r => ({
	node: r,
	name: r.all('vt-pair-name')[0].text,
	sub: r.all('vt-pair-sub')[0].text,
	state: (r.all(n => n.has('vt-pair-state'))[0] || {}).className,
	text: (r.all(n => n.has('vt-pair-state'))[0] || {}).text,
	why: (r.all('vt-pair-why')[0] || { hidden: true, text: '' }),
	act: r.all('vt-pair-act')[0]
}));
const notes = box => box.all('vt-pair-note').map(n => n.text);
const NO_CLIENT = 'This device has no SSH client (dbclient), so it cannot read access points.';
const KEYS = [ 'gw-office', 'gw-lab' ].map(n => pair.fakeKey('router ' + n));
/* an access point for every state the collector can report */
const STATES = [ [ 'ok', null ], [ 'waiting', null ] ].concat(FETCH_ERRORS.map(e => [ OFFLINE_ERRORS.includes(e) ? 'offline' : 'error', e ]));
const paired = STATES.map(([ state, error ], i) => ({ id: pair.fakeId('ap' + i), name: 'ap-' + (error || state), addr: '192.0.2.' + (10 + i), port: i === 1 ? 2222 : 22 }));
const statusOf = (aps, extra) => Object.assign({ router: { code: rc(RK, 'gw'), aps }, ap: { ssh: 'ok', routers: KEYS.map((key, i) => ({ key, name: 'gw-' + i })), reply: ap(K, '192.0.2.1', 22, 'this-ap') } }, extra);
const reportOf = aps => ({ aps: aps.map((a, i) => ({ id: a.id, name: a.name, addr: a.addr, state: STATES[i][0], error: STATES[i][1], age: STATES[i][0] === 'ok' ? 4 : STATES[i][0] === 'offline' ? 300 : null,
	report: STATES[i][0] === 'ok' ? { name: 'x', model: 'Example AX3000' } : null })).filter(a => a.state !== 'waiting') });

test('aps render: a row for every state the collector reports, each with its reason; none without a report', () => {
	const self = mount(statusOf(paired), reportOf(paired));
	assert.deepEqual(POLL.added.map(p => p.s), [ 5 ], 'polled every 5 s');
	const list = rows(self.el.apRows);
	assert.deepEqual(list.map(r => r.name), paired.map(a => a.name));
	STATES.forEach(([ state, error ], i) => {
		const r = list[i], what = `${state} ${error}`;
		assert.equal(r.state, 'vt-pair-state is-' + { ok: 'ok', waiting: 'wait', offline: 'off', error: 'err' }[state], what);
		assert.equal(r.text, { ok: 'Reporting, 4 s ago', waiting: 'Waiting for its first report', offline: 'Offline, last report 5 min ago', error: 'Not reporting' }[state], what);
		assert.equal(r.why.hidden, !error, what + ': the reason shows');
		assert.equal(r.why.text, error ? view.reportError(error) : '', what);
		assert.equal(r.act.text, 'Remove');
		assert.equal(r.act.attrs['aria-label'], 'Remove ' + paired[i].name);
	});
	assert.equal(list[0].sub, '192.0.2.10 · Example AX3000');
	assert.equal(list[1].sub, '192.0.2.11, SSH port 2222');
	assert.deepEqual(notes(tile(self, 'router')), [], 'nothing to warn about');
	assert.equal(self.el.addBtn.hidden, false);
	/* an access point's address is text */
	assert.deepEqual(MOUNT.page.all(n => n.tag === 'a'), []);

	/* no report at all: no live state, no reasons, no error banner */
	const blind = mount(statusOf(paired), null);
	for (const r of rows(blind.el.apRows)) {
		assert.equal(r.state, 'vt-pair-state is-none');
		assert.equal(r.text, 'No live state');
		assert.equal(r.why.hidden, true);
	}
	assert.deepEqual(notes(MOUNT.page), []);
	/* nothing paired */
	const empty = mount(statusOf([]), null);
	assert.equal(rows(empty.el.apRows).length, 0);
	assert.match(empty.el.apRows.text, /^No access points yet/);
	/* no status: the page says so and asks for nothing */
	const none = mount(null, null);
	assert.match(MOUNT.page.text, /Could not read the pairing state/);
	assert.equal(POLL.added.length, 0);
	assert.equal(none.el, undefined);
});

test('aps render: the routers that may read this device, the SSH warning, the reply', () => {
	const self = mount(statusOf(paired), null);
	const list = rows(self.el.routerRows);
	assert.deepEqual(list.map(r => [ r.name, r.sub, r.act.text ]), KEYS.map((k, i) => [ 'gw-' + i, view.shortKey(k), 'Revoke' ]));
	assert.deepEqual(notes(tile(self, 'ap')), []);
	assert.equal(self.el.allowBtn.hidden, false);
	assert.equal(self.el.againBox.hidden, false);
	assert.equal(self.el.again.field.value, ap(K, '192.0.2.1', 22, 'this-ap'));
	/* SSH not ready: the warning, no button to let a router in, no reply; revoking stays */
	for (const ssh of SSH_SOURCE.filter(c => c !== 'ok')) {
		const off = mount(statusOf(paired, { ap: { ssh, routers: [ { key: KEYS[0], name: 'gw-0' } ], reply: null } }), null);
		assert.deepEqual(notes(tile(off, 'ap')), [ view.sshProblem(ssh) ], ssh);
		assert.equal(off.el.allowBtn.hidden, true, ssh);
		assert.equal(off.el.againBox.hidden, true, ssh);
		assert.equal(rows(off.el.routerRows).length, 1);
	}
	/* routers let in, and a listener that runs a command of its own: what their keys do there, in place of "pairing is off";
	   they can still be revoked. Without a router let in there is nothing to say but that */
	const forced = mount(statusOf(paired, { ap: { ssh: 'unsupported', forced: true, routers: [ { key: KEYS[0], name: 'gw-0' } ], reply: null } }), null);
	assert.deepEqual(notes(tile(forced, 'ap')), [ 'A Dropbear listener on this device runs a command of its own for every login (ForceCommand in /etc/config/dropbear). ' +
		'The routers below are still let in, and through that listener their keys run that command as root instead of the report. Remove the command, or revoke the routers.' ]);
	assert.deepEqual([ forced.el.allowBtn.hidden, rows(forced.el.routerRows).map(r => r.act.text) ], [ true, [ 'Revoke' ] ]);
	/* and the tile's own sentence, that a router let in fetches the report "and nothing else", is not said beside it */
	const leadOf = t => tile(t, 'ap').all('vt-pair-lead')[0];
	assert.match(leadOf(self).text, /and nothing else\.$/);
	assert.deepEqual([ leadOf(self).hidden, leadOf(forced).hidden ], [ false, true ]);
	/* it comes back with the warning gone (the command removed), and stays beside any other SSH warning */
	forced.status = view.normStatus(statusOf(paired, { ap: { ssh: 'ok', routers: [ { key: KEYS[0], name: 'gw-0' } ], reply: null } }));
	forced.paintRouters();
	assert.deepEqual([ leadOf(forced).hidden, notes(tile(forced, 'ap')) ], [ false, [] ]);
	assert.equal(leadOf(mount(statusOf(paired, { ap: { ssh: 'unsupported', routers: [ { key: KEYS[0], name: 'gw-0' } ], reply: null } }), null)).hidden, false);
	assert.deepEqual(notes(tile(mount(statusOf(paired, { ap: { ssh: 'unsupported', forced: true, routers: [], reply: null } }), null), 'ap')), [ view.sshProblem('unsupported') ]);
	assert.equal(view.forcedProblem({ forced: false, routers: [ { key: KEYS[0], name: 'gw-0' } ] }), null);
	const lone = mount(statusOf([], { ap: { ssh: 'ok', routers: [], reply: null } }), null);
	assert.match(lone.el.routerRows.text, /^No router can read this access point/);
	assert.equal(lone.el.againBox.hidden, true);
	/* the key file cannot be read: an empty list is not "none" */
	const blind = mount(statusOf([], { ap: { ssh: 'keys-unreadable', routers: [], reply: null } }), null);
	assert.equal(blind.el.routerRows.text, 'Not known while this device\'s SSH keys cannot be read.');
	assert.deepEqual(notes(tile(blind, 'ap')), [ 'This device\'s SSH keys (/etc/dropbear/authorized_keys) cannot be read, or are larger than 256 KiB. Which routers can read this device is not known, so pairing is off.' ]);
	assert.equal(blind.el.allowBtn.hidden, true);
	/* unread while something else is wrong with SSH too (the plugin names that first): still not "none" */
	const both = mount(statusOf([], { ap: { ssh: 'not-running', routers: [], unread: true, reply: null } }), null);
	assert.equal(both.el.routerRows.text, 'Not known while this device\'s SSH keys cannot be read.');
	assert.match(mount(statusOf([], { ap: { ssh: 'not-running', routers: [], unread: false, reply: null } }), null).el.routerRows.text, /^No router can read this access point/);
	/* the router's own list unread: not "none yet" either */
	const lost = mount({ router: { code: rc(RK, 'gw'), aps: [], unread: true }, ap: { ssh: 'ok', routers: [], unread: false, reply: null } }, null);
	assert.equal(lost.el.apRows.text, 'Not known while this router\'s list of access points (/etc/vantage/aps.json) cannot be read.');
	assert.match(mount(statusOf([]), null).el.apRows.text, /^No access points yet/);
});

test('aps render: a poll updates the rows in place and rebuilds them only when the list changes', async () => {
	const self = mount(statusOf(paired), reportOf(paired));
	const before = rows(self.el.apRows), routersBefore = rows(self.el.routerRows);
	const say = (status, report) => {
		REPLIES['luci.vantage.pair status'] = () => Promise.resolve(status);
		REPLIES['vantage.collector report'] = () => report ? Promise.resolve(report) : Promise.reject(new Error('Object not found'));
	};
	/* the same list, another report: every access point now reports, from another address */
	say(statusOf(paired), { aps: paired.map(a => ({ id: a.id, state: 'ok', age: 9, addr: '198.51.100.' + a.addr.split('.')[3], error: null, report: null })) });
	await POLL.added[0].fn();
	let now = rows(self.el.apRows);
	assert.ok(now.every((r, i) => r.node === before[i].node && r.act === before[i].act), 'the same rows and buttons');
	assert.ok(now.every(r => r.text === 'Reporting, 9 s ago' && r.state === 'vt-pair-state is-ok' && r.why.hidden && r.why.text === ''));
	assert.equal(now[2].sub, '198.51.100.12', 'where it last answered');
	assert.ok(rows(self.el.routerRows).every((r, i) => r.node === routersBefore[i].node));
	assert.deepEqual(FOCUS, [], 'a poll moves no focus');
	/* the report gone: no live state, rows kept */
	say(statusOf(paired), null);
	await self.refresh();
	now = rows(self.el.apRows);
	assert.ok(now.every((r, i) => r.node === before[i].node && r.text === 'No live state'));
	assert.equal(now[2].sub, '192.0.2.12', 'the paired address again');
	/* a failed status read: what is shown stays */
	REPLIES['luci.vantage.pair status'] = () => Promise.reject(new Error('timeout'));
	await self.refresh();
	assert.ok(rows(self.el.apRows).every((r, i) => r.node === before[i].node));
	/* the list changed: rebuilt, with the new one's row */
	const more = paired.slice(1).concat([ { id: pair.fakeId('new'), name: 'ap-new', addr: '203.0.113.9', port: 22 } ]);
	say(statusOf(more, { ap: { ssh: 'ok', routers: [ { key: KEYS[1], name: 'gw-1' } ], reply: null } }), { aps: [] });
	await self.refresh();
	now = rows(self.el.apRows);
	assert.deepEqual(now.map(r => r.name), more.map(a => a.name));
	assert.ok(now.every(r => !before.some(b => b.node === r.node)), 'new rows');
	assert.equal(now[now.length - 1].text, 'Waiting for its first report');
	assert.equal(before[0].node.isConnected, false);
	assert.deepEqual(rows(self.el.routerRows).map(r => r.name), [ 'gw-1' ]);
	delete REPLIES['luci.vantage.pair status'];
	delete REPLIES['vantage.collector report'];
});

test('aps render: a hidden tab asks for nothing; shown again, it asks once', async () => {
	const self = mount(statusOf(paired), null);
	let calls = 0;
	REPLIES['luci.vantage.pair status'] = () => { calls++; return Promise.resolve(statusOf(paired)); };
	REPLIES['vantage.collector report'] = () => { calls++; return Promise.resolve(reportOf(paired)); };
	const shown = () => document.listeners.visibilitychange.forEach(f => f());
	assert.equal(document.listeners.visibilitychange.length, 1);
	document.hidden = true;
	await POLL.added[0].fn();
	await POLL.added[0].fn();
	assert.equal(calls, 0, 'no status, no report: the collector stops logging in');
	shown();
	assert.equal(calls, 0, 'still hidden');
	document.hidden = false;
	shown();
	await settle();
	assert.equal(calls, 2, 'one refresh');
	assert.equal(rows(self.el.apRows)[0].text, 'Reporting, 4 s ago');
	shown();
	await settle();
	assert.equal(calls, 2, 'nothing was skipped since');
	/* LuCI's refresh paused by hand: its resume asks, not the tab */
	document.hidden = true;
	await self.refresh();
	document.hidden = false;
	POLL.on = false;
	shown();
	await settle();
	assert.equal(calls, 2);
	delete REPLIES['luci.vantage.pair status'];
	delete REPLIES['vantage.collector report'];
});

test('aps render: no dbclient is said in the router tile, with access points paired or from the add form', async () => {
	/* paired, and no code to give: why nothing reports */
	const self = mount(statusOf(paired, { router: { code: null, aps: paired } }), null);
	assert.deepEqual(notes(tile(self, 'router')), [ NO_CLIENT ]);
	assert.ok(rows(self.el.apRows).every(r => r.text === 'No live state'));
	/* a device that pairs nothing yet has no key either: nothing to say */
	assert.deepEqual(notes(tile(mount(statusOf([], { router: { code: null, aps: [] } }), null), 'router')), []);
	/* the add form finds out */
	const fresh = mount(statusOf([], { router: { code: null, aps: [] } }), null);
	REPLIES['luci.vantage.pair router_code'] = () => Promise.resolve({ error: 'no-dbclient' });
	fresh.el.addBtn.click();
	await settle();
	assert.equal(fresh.el.addFlow.hidden, false);
	assert.deepEqual(notes(tile(fresh, 'router')), [ NO_CLIENT ]);
	assert.equal(fresh.add.codeErr.hidden, false);
	assert.equal(fresh.add.codeErr.text, NO_CLIENT);
	assert.equal(fresh.add.code.field.value, '');
	/* with a client again: the code, and the note goes */
	REPLIES['luci.vantage.pair router_code'] = () => Promise.resolve({ code: rc(RK, 'gw') });
	fresh.closeAdd();
	fresh.el.addBtn.click();
	await settle();
	assert.equal(fresh.add.code.field.value, rc(RK, 'gw'));
	assert.equal(fresh.add.codeErr.hidden, true);
	assert.deepEqual(notes(tile(fresh, 'router')), []);
	REPLIES['luci.vantage.pair router_code'] = () => Promise.resolve({ error: 'failed' });
	fresh.closeAdd();
	fresh.el.addBtn.click();
	await settle();
	assert.match(fresh.add.codeErr.text, /could not make its SSH key/);
	assert.deepEqual(notes(tile(fresh, 'router')), []);
	delete REPLIES['luci.vantage.pair router_code'];
});

test('aps render: confirming a removal or a revocation; the focus returns to where it was opened', async () => {
	const self = mount(statusOf(paired), reportOf(paired));
	const buttons = () => UI.modal.body.all(n => n.tag === 'button');
	const alertText = () => UI.modal.body.all(n => n.attrs.role === 'alert')[0];
	const target = rows(self.el.apRows)[2];
	const calls = [];

	/* Cancel: nothing sent, back on the row's button */
	target.act.click();
	assert.equal(UI.modal.title, 'Remove access point');
	assert.match(UI.modal.body.text, new RegExp('^' + paired[2].name + ' will no longer show on this dashboard'));
	assert.deepEqual(buttons().map(b => b.text), [ 'Cancel', 'Remove' ]);
	REPLIES['luci.vantage.pair remove_ap'] = id => { calls.push(id); return Promise.resolve({ ok: true }); };
	buttons()[0].click();
	assert.equal(UI.modal, null);
	assert.deepEqual(calls, []);
	assert.equal(FOCUS[FOCUS.length - 1], target.act);

	/* refused: the dialog stays and says why; a failed call too */
	target.act.click();
	REPLIES['luci.vantage.pair remove_ap'] = () => Promise.resolve({ error: 'failed' });
	buttons()[1].click();
	assert.equal(buttons()[1].disabled, true, 'one at a time');
	await settle();
	assert.ok(UI.modal, 'still open');
	assert.equal(alertText().hidden, false);
	assert.equal(alertText().text, view.dropError({ error: 'failed' }));
	assert.equal(buttons()[1].disabled, false);
	REPLIES['luci.vantage.pair remove_ap'] = () => Promise.reject(new Error('Permission denied'));
	buttons()[1].click();
	await settle();
	assert.equal(alertText().text, 'The request failed: Permission denied');

	/* confirmed: sent with its id, the row goes, the focus to the tile's button */
	const left = paired.filter((a, i) => i !== 2);
	REPLIES['luci.vantage.pair remove_ap'] = id => { calls.push(id); return Promise.resolve({ ok: true }); };
	REPLIES['luci.vantage.pair status'] = () => Promise.resolve(statusOf(left));
	REPLIES['vantage.collector report'] = () => Promise.resolve({ aps: [] });
	buttons()[1].click();
	await settle();
	assert.equal(UI.modal, null);
	assert.deepEqual(calls, [ paired[2].id ]);
	assert.deepEqual(rows(self.el.apRows).map(r => r.name), left.map(a => a.name));
	assert.equal(target.act.isConnected, false);
	assert.equal(FOCUS[FOCUS.length - 1], self.el.addBtn, 'its row is gone');

	/* the last one removed and the collector's service not stopped: said, and the dialog stays for a second try,
	   which the device answers as gone already once it has stopped it */
	const lastOne = rows(self.el.apRows)[0];
	lastOne.act.click();
	REPLIES['luci.vantage.pair remove_ap'] = () => Promise.resolve({ ok: true, collector: false });
	buttons()[1].click();
	await settle();
	assert.ok(UI.modal, 'still open');
	assert.equal(alertText().text, 'The access point is removed, but this device could not shut down the service that read it. Try again.');
	assert.equal(buttons()[1].disabled, false);
	REPLIES['luci.vantage.pair remove_ap'] = () => Promise.resolve({ error: 'unknown', collector: false });
	buttons()[1].click();
	await settle();
	assert.ok(UI.modal, 'not stopped yet');
	REPLIES['luci.vantage.pair remove_ap'] = () => Promise.resolve({ error: 'unknown' });
	buttons()[1].click();
	await settle();
	assert.equal(UI.modal, null);

	/* gone already (unknown): closes all the same; the status could not be
	   read, so the row is still there and gets the focus back */
	const still = rows(self.el.apRows)[0];
	still.act.click();
	REPLIES['luci.vantage.pair remove_ap'] = () => Promise.resolve({ error: 'unknown' });
	REPLIES['luci.vantage.pair status'] = () => Promise.reject(new Error('timeout'));
	buttons()[1].click();
	await settle();
	assert.equal(UI.modal, null);
	assert.equal(FOCUS[FOCUS.length - 1], still.act);

	/* revoking a router: its key sent, then the tile's button */
	const router = rows(self.el.routerRows)[1];
	router.act.click();
	assert.equal(UI.modal.title, 'Revoke router');
	assert.match(UI.modal.body.text, /^gw-1 will no longer be able to read this access point/);
	assert.deepEqual(buttons().map(b => b.text), [ 'Cancel', 'Revoke' ]);
	buttons()[0].click();
	assert.equal(FOCUS[FOCUS.length - 1], router.act);
	router.act.click();
	const revoked = [];
	REPLIES['luci.vantage.pair revoke_router'] = key => { revoked.push(key); return Promise.resolve({ ok: true }); };
	REPLIES['luci.vantage.pair status'] = () => Promise.resolve(statusOf(left, { ap: { ssh: 'ok', routers: [ { key: KEYS[0], name: 'gw-0' } ], reply: null } }));
	buttons()[1].click();
	await settle();
	assert.deepEqual(revoked, [ KEYS[1] ]);
	assert.deepEqual(rows(self.el.routerRows).map(r => r.name), [ 'gw-0' ]);
	assert.equal(FOCUS[FOCUS.length - 1], self.el.allowBtn);
	/* the tile's button hidden (SSH not ready): the focus is left alone */
	const last = rows(self.el.routerRows)[0];
	last.act.click();
	REPLIES['luci.vantage.pair status'] = () => Promise.resolve(statusOf(left, { ap: { ssh: 'not-running', routers: [], reply: null } }));
	const n = FOCUS.length;
	buttons()[1].click();
	await settle();
	assert.equal(self.el.allowBtn.hidden, true);
	assert.equal(FOCUS.length, n);
	for (const k of [ 'remove_ap', 'revoke_router', 'status' ]) delete REPLIES['luci.vantage.pair ' + k];
	delete REPLIES['vantage.collector report'];
});

test('aps: an access point shows the address it last answered at, else the paired one', () => {
	const self = mount(statusOf([ { id: 'a1', name: 'ap-hall', addr: '192.0.2.10', port: 22 } ]), null);
	const at = report => { self.report = report; self.paintAps(); return rows(self.el.apRows)[0].sub; };
	assert.equal(at(null), '192.0.2.10', 'no live state');
	assert.equal(at({ aps: [] }), '192.0.2.10', 'not in the report yet');
	assert.equal(at({ aps: [ { id: 'a1', state: 'ok', age: 2, addr: '192.0.2.77', report: { model: 'Example AX3000' } } ] }), '192.0.2.77 · Example AX3000');
	assert.equal(at({ aps: [ { id: 'a1', state: 'offline', age: 90, addr: '', error: 'timeout' } ] }), '192.0.2.10');
	const far = mount(statusOf([ { id: 'a1', name: 'ap-hall', addr: '192.0.2.10', port: 2222 } ]), { aps: [ { id: 'a1', state: 'ok', addr: '2001:db8::77' } ] });
	assert.equal(rows(far.el.apRows)[0].sub, '2001:db8::77, SSH port 2222');
});

test('aps: the network an access point was paired on is said in its row, as text; nothing where none is kept', async () => {
	const aps = [ { id: 'a1', name: 'ap-hall', addr: '192.0.2.10', port: 22, net: 'lan' }, { id: 'a2', name: 'ap-den', addr: '192.0.2.11', port: 2222, net: 'guest_2' },
		{ id: 'a3', name: 'ap-loft', addr: '198.51.100.12', port: 22 } ];
	/* the first found again at an address of the network's new subnet: the name is the network's, whatever its addresses */
	const report = { aps: [ { id: 'a1', state: 'ok', age: 2, addr: '198.51.100.40', report: { model: 'Example AX3000' } } ] };
	const self = mount(statusOf(aps), report);
	const list = rows(self.el.apRows);
	assert.deepEqual(list.map(r => r.sub), [ '198.51.100.40 · network lan · Example AX3000', '192.0.2.11, SSH port 2222 · network guest_2', '198.51.100.12' ]);
	const nets = list.map(r => r.node.all('vt-pair-net'));
	assert.deepEqual(nets.map(n => n.length), [ 1, 1, 0 ], 'no element where there is no network');
	for (const [ n ] of nets.slice(0, 2)) {
		assert.equal(n.tag, 'span');
		assert.equal(n.attrs.title, 'The network it was paired on: this router looks for it there when its address changes');
		assert.deepEqual([ Object.keys(n.on), n.all(() => true) ], [ [], [] ], 'text, and nothing to click or type in');
		assert.equal(n.parent, n.parent.parent.all('vt-pair-sub')[0], 'in the row\'s line of details');
	}
	assert.deepEqual(MOUNT.page.all(n => n.tag === 'a' || n.tag === 'select'), []);
	assert.equal(MOUNT.page.all(n => n.tag === 'input').length, 1, 'the add form\'s address field, as before');
	/* a poll keeps the rows; a list in which a network changed is another list */
	REPLIES['luci.vantage.pair status'] = () => Promise.resolve(statusOf(aps));
	REPLIES['vantage.collector report'] = () => Promise.resolve(report);
	await self.refresh();
	assert.ok(rows(self.el.apRows).every((r, i) => r.node === list[i].node), 'the same rows');
	REPLIES['luci.vantage.pair status'] = () => Promise.resolve(statusOf([ aps[0], Object.assign({}, aps[1], { net: 'lan' }), Object.assign({}, aps[2], { net: 'guest_2' }) ]));
	await self.refresh();
	assert.deepEqual(rows(self.el.apRows).map(r => r.sub), [ '198.51.100.40 · network lan · Example AX3000', '192.0.2.11, SSH port 2222 · network lan', '198.51.100.12 · network guest_2' ]);
	delete REPLIES['luci.vantage.pair status'];
	delete REPLIES['vantage.collector report'];
	/* only a name counts as one */
	const read = net => view.normStatus({ router: { aps: [ { id: 'a', name: 'n', addr: '192.0.2.10', port: 22, net } ] } }).aps[0];
	assert.deepEqual(read('lan'), { id: 'a', name: 'n', addr: '192.0.2.10', port: 22, net: 'lan' });
	for (const none of [ undefined, null, '', 7, true, [ 'lan' ], { name: 'lan' } ]) assert.deepEqual(read(none), { id: 'a', name: 'n', addr: '192.0.2.10', port: 22 }, JSON.stringify(none));
	/* this device's own reply pasted into its own form: said in the form's own words */
	assert.equal(view.addError({ error: 'self' }, false), 'That is this device\'s own reply. Paste the reply of the access point you want to add.');
	assert.equal(view.addError({ error: 'self' }, true), view.addError({ error: 'self' }, false));
	const form = addForm();
	form.add.reply.value = ap(K, '192.0.2.1', 22, 'this-ap');
	form.onReply();
	REPLIES['luci.vantage.pair add_ap'] = () => Promise.resolve({ error: 'self' });
	await form.submitAdd();
	assert.deepEqual([ form.add.err.hidden, form.add.err.text, form.el.addFlow.hidden, form.add.go.disabled ], [ false, view.addError({ error: 'self' }, false), false, false ], 'in the form\'s error line, the form still open');
	delete REPLIES['luci.vantage.pair add_ap'];
});

test('aps: status read defensively; a poll keeps the last status when it fails and drops the report', async () => {
	assert.equal(view.normStatus(null), null);
	assert.equal(view.normStatus([]), null);
	assert.deepEqual(view.normStatus({}), { code: null, aps: [], ssh: null, routers: [], reply: null, forced: false, apsUnread: false, keysUnread: false });
	const s = view.normStatus({ router: { code: 'c', aps: [ { id: 'a', name: 'n', addr: '192.0.2.10' }, { name: 'no id' }, 3 ] },
		ap: { ssh: 'ok', routers: [ { key: 'k', name: 'gw' }, { name: 'no key' } ], reply: 5 } });
	assert.deepEqual(s, { code: 'c', aps: [ { id: 'a', name: 'n', addr: '192.0.2.10', port: 22 } ], ssh: 'ok', routers: [ { key: 'k', name: 'gw' } ], reply: null, forced: false, apsUnread: false, keysUnread: false });
	/* only true says a listener's own command is what the routers' keys run */
	assert.deepEqual([ true, 1, 'yes', null ].map(f => view.normStatus({ ap: { forced: f } }).forced), [ true, false, false, false ]);
	/* only true counts as unread; the state alone says it of the keys too */
	assert.deepEqual([ 'apsUnread', 'keysUnread' ].map(k => view.normStatus({ router: { unread: true }, ap: { unread: true } })[k]), [ true, true ]);
	assert.deepEqual([ 'apsUnread', 'keysUnread' ].map(k => view.normStatus({ router: { unread: 1 }, ap: { unread: 'yes' } })[k]), [ false, false ]);
	assert.equal(view.normStatus({ ap: { ssh: 'keys-unreadable' } }).keysUnread, true);

	document.hidden = false;
	const self = Object.create(view);
	let painted = 0;
	self.paint = () => painted++;
	self.status = { mark: 'last' };
	self.report = { aps: [] };
	REPLIES['luci.vantage.pair status'] = () => Promise.reject(new Error('timeout'));
	REPLIES['vantage.collector report'] = () => Promise.reject(new Error('Object not found'));
	await self.refresh();
	assert.deepEqual(self.status, { mark: 'last' });
	assert.equal(self.report, null);
	assert.equal(painted, 1);
	REPLIES['luci.vantage.pair status'] = () => Promise.resolve({ router: { aps: [] }, ap: { ssh: 'ok', routers: [] } });
	REPLIES['vantage.collector report'] = () => Promise.resolve({ aps: [] });
	await self.refresh();
	assert.equal(self.status.ssh, 'ok');
	assert.deepEqual(self.report, { aps: [] });
	delete REPLIES['luci.vantage.pair status'];
	delete REPLIES['vantage.collector report'];
});

test('aps: copying uses the clipboard in a secure context, else select() and execCommand, else asks to copy by hand', async () => {
	/* Node has a navigator of its own, as a getter */
	const NAMES = [ 'window', 'navigator', 'document' ];
	const saved = NAMES.map(n => Object.getOwnPropertyDescriptor(globalThis, n));
	const put = (n, value) => Object.defineProperty(globalThis, n, { value, configurable: true, writable: true });
	const run = async (secure, clip, exec) => {
		const field = el({ value: 'vantage-router 1 ssh-ed25519 x y' }), note = el(), btn = el();
		const used = [];
		put('window', { isSecureContext: secure });
		put('navigator', clip ? { clipboard: { writeText: t => { used.push('clip ' + t); return clip === 'ok' ? Promise.resolve() : Promise.reject(new Error('denied')); } } } : {});
		put('document', { execCommand: c => { used.push('exec ' + c); if (exec === 'throw') throw new Error('no'); return exec; } });
		view.copyField(field, note, btn);
		await new Promise(r => setTimeout(r, 0));
		return { used, note: note.text, selected: field.selected, button: btn.focused };
	};
	try {
		assert.deepEqual(await run(true, 'ok', true), { used: [ 'clip vantage-router 1 ssh-ed25519 x y' ], note: 'Copied', selected: 0, button: 0 }, 'the focus never left the button');
		/* plain HTTP: no clipboard API; the selection took the focus, the button gets it back */
		assert.deepEqual(await run(false, 'ok', true), { used: [ 'exec copy' ], note: 'Copied', selected: 1, button: 1 });
		assert.deepEqual(await run(true, 'no', true), { used: [ 'clip vantage-router 1 ssh-ed25519 x y', 'exec copy' ], note: 'Copied', selected: 1, button: 1 });
		const failed = await run(false, null, false);
		assert.equal(failed.note, 'Select and copy it');
		assert.equal(failed.selected, 2, 'left selected');
		assert.equal(failed.button, 0, 'and focused, to copy by hand');
		assert.equal((await run(false, null, 'throw')).note, 'Select and copy it');
	} finally {
		NAMES.forEach((n, i) => { if (saved[i]) Object.defineProperty(globalThis, n, saved[i]); else delete globalThis[n]; });
	}
	assert.match(src, /document\.execCommand\('copy'\)/);
	/* the page's own Copy button passes itself */
	const self = mount(statusOf(paired), null);
	assert.match(String(self.el.again.btn.on.click), /copyField\(field, note, btn\)/);
});

/* ------------------------------------------ the replay's stand-in */

function store(host) { return { data: (o, m) => (o === 'system' && m === 'board' ? { hostname: host } : null) }; }
const res = (s, m, a) => pair.handle(s, m, a);
const data = (s, m, a) => { const r = res(s, m, a); assert.equal(r.result[0], 0, `${m} ${JSON.stringify(a)}`); return r.result[1]; };

test('pair stand-in: rpcd\'s argument policy', () => {
	const s = pair.initialState('gw', 'ok');
	assert.deepEqual(res(s, 'nope', {}), { result: [ 3 ] });
	assert.deepEqual(res(s, '__proto__', {}), { result: [ 3 ] });
	for (const [ m, a ] of [ [ 'status', { x: 1 } ], [ 'router_code', { code: 'x' } ], [ 'add_ap', { code: 1 } ], [ 'add_ap', { code: 'x', addr: null } ],
		[ 'add_ap', { code: 'x', addr: [ '192.0.2.1' ] } ], [ 'add_ap', { code: 'x', port: '22' } ], [ 'remove_ap', { id: 5 } ], [ 'allow_router', { code: {} } ],
		[ 'revoke_router', { key: true } ], [ 'revoke_router', { id: 'x' } ] ])
		assert.deepEqual(res(s, m, a), { result: [ 2 ] }, `${m} ${JSON.stringify(a)}`);
	/* rpcd adds the session; absent arguments are fine */
	assert.equal(res(s, 'status', { ubus_rpc_session: 'x' }).result[0], 0);
	assert.deepEqual(data(s, 'add_ap', {}), { error: 'invalid' });
	assert.deepEqual(data(s, 'remove_ap', {}), { error: 'unknown' });
});

test('pair stand-in: starts with the access points of --aps paired, documentation values and well-formed keys', () => {
	const s = pair.initialState('vantage-ap', 'ok'), st = data(s, 'status', {});
	/* what the dashboard shows with --aps (dev/replay/aps.js) is what the page lists */
	const aps = require('../dev/replay/aps');
	assert.deepEqual(aps.APS.map(a => a.name), [ 'ap-hall', 'ap-den', 'ap-loft' ]);
	/* the two on the stand-in's own lan with its name, as the plugin keeps it at pairing; ap-loft's address is on none of its networks */
	const onLan = a => a.addr.startsWith('192.0.2.') ? { net: 'lan' } : {};
	assert.deepEqual(st.router.aps, aps.APS.map(a => Object.assign({ id: aps.id(a.name), name: a.name, addr: a.addr, port: 22 }, onLan(a))));
	assert.deepEqual(st.router.aps.map(a => a.net), [ 'lan', 'lan', undefined ]);
	assert.deepEqual(s.aps.map(a => a.mac), aps.APS.map(a => a.mac), 'the MACs they were paired with');
	const report = aps.transform('vantage.collector', 'report', {}, null).result[1];
	assert.deepEqual(report.aps.map(a => [ a.id, a.name, a.addr ]), st.router.aps.map(a => [ a.id, a.name, a.addr ]));
	for (const a of s.aps) {
		assert.equal(pair.mac(a.mac), a.mac, a.name + ': a MAC a reply may carry');
		assert.equal(pair.key(a.key), a.key);
		assert.match(a.id, /^[0-9a-f]{16}$/);
	}
	assert.equal(new Set(s.aps.map(a => a.key)).size, 3);
	assert.equal(st.ap.routers.length, 1);
	assert.match(st.router.code, /^vantage-router 1 ssh-ed25519 \S+ vantage-ap$/);
	assert.deepEqual(pair.parseRouterCode(st.router.code), { key: st.router.code.split(' ')[3], name: 'vantage-ap' });
	assert.ok(pair.parseApReply(st.ap.reply), 'its own reply passes its checks');
	assert.equal(pair.parseApReply(st.ap.reply).mac, '00:00:5e:00:53:01');
	for (const a of st.router.aps.map(x => x.addr).concat(st.ap.reply.split(' ')[4]))
		assert.match(a, /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$|^2001:db8:/, a);
	for (const k of st.ap.routers.map(r => r.key).concat(K, RK)) {
		const b = Buffer.from(k, 'base64');
		assert.equal(b.length, 51);
		assert.equal(b.subarray(4, 15).toString(), 'ssh-ed25519');
		assert.equal(pair.key(k), k);
	}
	/* names from the hostname, as the plugin makes them */
	assert.match(data(pair.initialState('my host!', 'ok'), 'status', {}).router.code, / my-host-$/);
	assert.match(data(pair.initialState('', 'ok'), 'status', {}).ap.reply, / access-point$/);
	assert.match(data(pair.initialState('', 'ok'), 'status', {}).router.code, / router$/);
	/* one state per store */
	const a = store('gw-a'), b = store('gw-b');
	pair.call(a, 'revoke_router', { key: data(pair.initialState('x', 'ok'), 'status', {}).ap.routers[0].key });
	assert.equal(pair.call(a, 'status', {}).result[1].ap.routers.length, 0);
	assert.equal(pair.call(b, 'status', {}).result[1].ap.routers.length, 1);
	assert.match(pair.call(b, 'status', {}).result[1].router.code, / gw-b$/);
});

test('pair stand-in: add_ap and remove_ap', () => {
	const s = pair.initialState('gw', 'ok');
	for (const [ code, ok ] of AP_CASES)
		if (!ok) assert.deepEqual(data(s, 'add_ap', { code }), { error: 'invalid' }, JSON.stringify(code));
	const r = data(s, 'add_ap', { code: ap(K, '2001:DB8::10', 2222, 'ap-x') });
	assert.match(r.id, /^[0-9a-f]{16}$/);
	assert.deepEqual(data(s, 'status', {}).router.aps.find(a => a.id === r.id), { id: r.id, name: 'ap-x', addr: '2001:db8::10', port: 2222 }, 'no MAC in status');
	assert.equal(s.aps.find(a => a.id === r.id).mac, MAC, 'kept with the pairing');
	const up = data(s, 'add_ap', { code: ap(pair.fakeKey('host upper'), '192.0.2.21', 22, 'upper', '00:00:5E:00:53:0A') }).id;
	assert.equal(s.aps.find(a => a.id === up).mac, '00:00:5e:00:53:0a');
	assert.deepEqual(data(s, 'remove_ap', { id: up }), { ok: true, collector: true });
	assert.deepEqual(data(s, 'add_ap', { code: ap(K, '192.0.2.99', 22, 'other-name') }), { error: 'duplicate' }, 'the same host key');
	/* the same pairing again: its id again, and no second entry */
	assert.deepEqual(data(s, 'add_ap', { code: ap(K, '2001:db8::10', 2222, 'ap-x') }), { id: r.id, collector: true });
	assert.equal(s.aps.filter(a => a.key === K).length, 1);
	/* the address: another valid one replaces the reply's, an empty one is none */
	const k2 = pair.fakeKey('host two'), k3 = pair.fakeKey('host three');
	for (const bad of [ 'fe80::1', '192.0.2.20:22', '::1', '0::1', ip(169, 254, 3, 4), '192.0.2.20\0' ])
		assert.deepEqual(data(s, 'add_ap', { code: ap(k2, '192.0.2.20', 22, 'two'), addr: bad }), { error: 'invalid' }, JSON.stringify(bad));
	const two = data(s, 'add_ap', { code: ap(k2, '192.0.2.20', 22, 'two'), addr: '198.51.100.20' }).id;
	const three = data(s, 'add_ap', { code: ap(k3, '192.0.2.30', 22, 'three'), addr: '' }).id;
	const list = data(s, 'status', {}).router.aps;
	assert.equal(list.find(a => a.id === two).addr, '198.51.100.20');
	assert.equal(list.find(a => a.id === three).addr, '192.0.2.30');
	/* 16 at most */
	for (let i = list.length; i < pair.MAX_APS; i++) assert.ok(data(s, 'add_ap', { code: ap(pair.fakeKey('n' + i), '192.0.2.40', 22, 'n' + i) }).id);
	assert.deepEqual(data(s, 'add_ap', { code: ap(pair.fakeKey('one more'), '192.0.2.40', 22, 'more') }), { error: 'full' });
	assert.deepEqual(data(s, 'remove_ap', { id: two }), { ok: true, collector: true });
	assert.deepEqual(data(s, 'remove_ap', { id: two }), { error: 'unknown' });
	assert.deepEqual(data(s, 'remove_ap', { id: '__proto__' }), { error: 'unknown' });
	assert.equal(data(s, 'status', {}).router.aps.length, pair.MAX_APS - 1);
	/* no key yet: router_code first, and it makes this device's own (from its host name) */
	const fresh = pair.initialState('gw', 'ok');
	const code = data(fresh, 'status', {}).router.code;
	fresh.routerKey = null;
	assert.equal(data(fresh, 'status', {}).router.code, null);
	assert.deepEqual(data(fresh, 'add_ap', { code: ap(k2, '192.0.2.20', 22, 'two') }), { error: 'no-key' });
	assert.deepEqual(data(fresh, 'router_code', {}), { code });
	assert.ok(data(fresh, 'add_ap', { code: ap(k2, '192.0.2.20', 22, 'two') }).id);
	/* no dbclient: no code to give, and router_code says so; the key is still there */
	const blind = pair.initialState('gw', 'ok', true);
	assert.equal(data(blind, 'status', {}).router.code, null);
	assert.equal(data(blind, 'status', {}).router.aps.length, 3);
	assert.deepEqual(data(blind, 'router_code', {}), { error: 'no-dbclient' });
	assert.ok(data(blind, 'add_ap', { code: ap(k2, '192.0.2.20', 22, 'two') }).id);
});

test('pair stand-in: add_ap keeps the network the address is on, by name, and refuses this device\'s own reply', () => {
	const s = pair.initialState('gw', 'ok');
	const listed = id => data(s, 'status', {}).router.aps.find(a => a.id === id);
	const lan = data(s, 'add_ap', { code: ap(K, '192.0.2.40', 2222, 'ap-x') }).id;
	assert.deepEqual(listed(lan), { id: lan, name: 'ap-x', addr: '192.0.2.40', port: 2222, net: 'lan' });
	assert.equal(s.aps.find(a => a.id === lan).net, 'lan', 'kept with the pairing');
	/* the address it is paired at decides: the one given, when one is */
	const moved = data(s, 'add_ap', { code: ap(pair.fakeKey('host two'), '192.0.2.41', 22, 'two'), addr: '198.51.100.20' }).id;
	assert.deepEqual(listed(moved), { id: moved, name: 'two', addr: '198.51.100.20', port: 22 }, 'on none of its networks: no network');
	const back = data(s, 'add_ap', { code: ap(pair.fakeKey('host three'), '198.51.100.30', 22, 'three'), addr: '192.0.2.42' }).id;
	assert.equal(listed(back).net, 'lan');
	const six = data(s, 'add_ap', { code: ap(pair.fakeKey('host six'), '2001:db8::10', 22, 'six') }).id;
	assert.equal('net' in listed(six), false);
	assert.equal('net' in s.aps.find(a => a.id === six), false);
	/* its own reply, as status gives it and however it is addressed or named */
	const own = data(s, 'status', {}).ap.reply, n = s.aps.length;
	assert.equal(own.split(' ')[3], s.hostKey);
	for (const args of [ { code: own }, { code: own, addr: '198.51.100.7' }, { code: ap(s.hostKey, '203.0.113.9', 2222, 'another-name') } ])
		assert.deepEqual(data(s, 'add_ap', args), { error: 'self' }, JSON.stringify(args));
	assert.equal(s.aps.length, n);
	/* before the key is looked for, after the code is checked: as the plugin orders them */
	s.routerKey = null;
	assert.deepEqual(data(s, 'add_ap', { code: own }), { error: 'self' });
	assert.deepEqual(data(s, 'add_ap', { code: own, addr: '127.0.0.1' }), { error: 'invalid' });
});

test('pair stand-in: allow_router and revoke_router', () => {
	const s = pair.initialState('ap-x', 'ok');
	for (const [ code, ok ] of ROUTER_CASES)
		if (!ok) assert.deepEqual(data(s, 'allow_router', { code }), { error: 'invalid' }, JSON.stringify(code));
	const reply = data(s, 'allow_router', { code: rc(RK, 'gw-lab') }).reply;
	assert.equal(reply, data(s, 'status', {}).ap.reply);
	assert.deepEqual(data(s, 'allow_router', { code: rc(RK, 'gw-renamed') }), { reply }, 'already in: the reply again');
	assert.deepEqual(data(s, 'status', {}).ap.routers.filter(r => r.key === RK), [ { name: 'gw-lab', key: RK } ]);
	s.adminKeys.push(pair.fakeKey('admin laptop'));
	assert.deepEqual(data(s, 'allow_router', { code: rc(pair.fakeKey('admin laptop'), 'laptop') }), { error: 'duplicate' });
	for (let i = data(s, 'status', {}).ap.routers.length; i < pair.MAX_ROUTERS; i++) assert.ok(data(s, 'allow_router', { code: rc(pair.fakeKey('r' + i), 'r' + i) }).reply);
	assert.deepEqual(data(s, 'allow_router', { code: rc(pair.fakeKey('nine'), 'nine') }), { error: 'full' });
	assert.deepEqual(data(s, 'revoke_router', { key: RK }), { ok: true });
	assert.deepEqual(data(s, 'revoke_router', { key: RK }), { error: 'unknown' });
	assert.deepEqual(data(s, 'revoke_router', { key: 'not a key' }), { error: 'unknown' });
	/* SSH not ready (every state the plugin can find): refused after the code check, and no reply */
	for (const ssh of SSH_SOURCE.filter(x => x !== 'ok')) {
		const t = pair.initialState('ap-x', ssh);
		assert.deepEqual(data(t, 'allow_router', { code: 'junk' }), { error: 'invalid' });
		assert.deepEqual(data(t, 'allow_router', { code: rc(RK, 'gw') }), { error: ssh });
		const st = data(t, 'status', {});
		assert.equal(st.ap.ssh, ssh);
		assert.equal(st.ap.reply, null);
		/* the key file unread: no router listed and none revoked, as the plugin answers; any other state lists them */
		const blind = ssh === 'keys-unreadable', first = pair.initialState('ap-x', 'ok').routers[0].key;
		assert.deepEqual([ st.ap.unread, st.ap.routers.length > 0, st.router.unread ], [ blind, !blind, false ], ssh);
		assert.deepEqual(data(t, 'revoke_router', { key: first }), blind ? { error: 'failed' } : { ok: true }, ssh);
	}
	const none = pair.initialState('ap-x', 'ok');
	data(none, 'revoke_router', { key: data(none, 'status', {}).ap.routers[0].key });
	assert.equal(data(none, 'status', {}).ap.reply, null, 'no router allowed: no reply');
	assert.equal(pair.initialState('ap-x', 'bogus').ssh, 'ok');
});

/* --------------------------------------- the same checks in aps.uc */

function findUcode() {
	const cands = [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')));
	for (const c of cands) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const HARNESS = path.join(__dirname, 'ucode/aps-harness.uc');
const SKIP = !UCODE ? 'no ucode binary (set UCODE=/path/to/ucode)' : !fs.existsSync(HARNESS) ? 'no tests/ucode/aps-harness.uc' : false;

test('pair stand-in: codes, keys, addresses, MACs, ports and names checked as vantage/aps.uc checks them', { skip: SKIP }, () => {
	const cases = [].concat(
		AP_CASES.map(([ c ]) => [ 'parse_ap', c ]),
		ROUTER_CASES.map(([ c ]) => [ 'parse_router', c ]),
		ADDR_CASES.map(a => [ 'addr', a ]),
		PORT_CASES.map(p => [ 'port', p ]),
		MAC_CASES.map(m => [ 'mac', m ]),
		[ K, RK, RSA, K.slice(1), K + '=', K + '\0', 'x' ].map(k => [ 'key', k ]),
		NAME_OF_CASES.map(([ h, f ]) => [ 'name_of', h, f ]),
		NET_CASES.map(n => [ 'net', n ]),
		NET_OF_IFACES.flatMap(ifaces => NET_OF_ADDRS.map(a => [ 'net_of', a, ifaces ])));
	const file = path.join(mkTmp('vantage-aps-page-'), 'cases.json');
	fs.writeFileSync(file, JSON.stringify(cases));
	const r = spawnSync(UCODE, [ '-L', path.join(__dirname, 'ucode/aps-stubs/*.uc'), '-L', path.join(PKG, 'root/usr/share/ucode/*.uc'),
		'-D', 'MODE=module', '-D', 'CASES=' + file, HARNESS ], { encoding: 'utf8' });
	fs.unlinkSync(file);
	assert.equal(r.status, 0, r.stderr);
	const got = JSON.parse(r.stdout);
	const js = { parse_ap: pair.parseApReply, parse_router: pair.parseRouterCode, addr: pair.addr, port: pair.port, mac: pair.mac, key: pair.key, name_of: pair.nameOf,
		net: pair.net, net_of: pair.netOf };
	cases.forEach((c, i) => assert.deepEqual(js[c[0]](...c.slice(1)), got[i], `${c[0]}(${JSON.stringify(c.slice(1))})`));
	assert.equal(got[0].addr, '192.0.2.10', 'the cases ran');
	/* and they say what the review asked for */
	const said = (fn, arg) => got[cases.findIndex(c => c[0] === fn && c[1] === arg)];
	for (const a of [ '0::1', '0:0:0:0:0:0:0:1', '::0', '::2', '1::', ip(169, 254, 0, 1), '192.0.2.1\0' ]) assert.equal(said('addr', a), null, JSON.stringify(a));
	assert.equal(said('addr', '2001:DB8::A'), '2001:db8::a');
	assert.equal(said('mac', '00:00:5E:00:53:0A'), '00:00:5e:00:53:0a');
	/* the network of an address: both named some, and both none, on these cases */
	const placed = cases.map((c, i) => c[0] === 'net_of' ? got[i] : undefined).filter(v => v !== undefined);
	assert.deepEqual([ ...new Set(placed) ].sort(), [ 'a', 'guest', 'lan', 'wan', 'wide', null ].sort());
	assert.deepEqual(NET_OF_ADDRS.map(a => pair.netOf(a, pair.IFACES)), [ 'lan', 'lan', 'lan', null, null, null, null, null, null, null, null, null ]);
});
