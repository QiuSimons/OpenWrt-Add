'use strict';
/* Status -> Firewall flow view: the ruleset model (vantage-theme.nftmodel),
   and that the view (vantage-theme.nftflow) takes a rule's conditions and
   what it does from one read of the ruleset, on a small fake DOM. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '..', 'luci-theme-vantage', 'htdocs', 'luci-static', 'resources');

/* same evaluation as tests/host.test.js */
function loadThemeModule(rel) {
	const src = fs.readFileSync(path.join(RES, rel), 'utf8');
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		if (m[1] !== 'baseclass') throw new Error('unexpected dependency ' + m[1]);
		params.push(m[2] || m[1]);
		values.push({ extend: proto => proto });
	}
	return new Function(...params, src)(...values);
}

const nft = loadThemeModule('vantage-theme/nftmodel.js');
const K = (f, t, n) => nft.keyOf(f, t, n);

const chain = (family, table, name, hook, prio, policy, type) =>
	({ chain: Object.assign({ family, table, name }, hook ? { type: type || 'filter', hook, prio, policy } : {}) });
const rule = (family, table, chainName, expr, comment) =>
	({ rule: Object.assign({ family, table, chain: chainName, expr }, comment ? { comment } : {}) });
const iif = (dev) => ({ match: { op: '==', left: { meta: { key: 'iifname' } }, right: dev } });

/* an fw4 ruleset trimmed to the shapes that matter, plus a bridge table
   like the one some access point firmware adds */
const RULESET = { nftables: [
	{ metainfo: { version: '1.1.6' } },
	{ table: { family: 'inet', name: 'fw4' } },
	chain('inet', 'fw4', 'input', 'input', 0, 'drop'),
	chain('inet', 'fw4', 'forward', 'forward', 0, 'drop'),
	chain('inet', 'fw4', 'output', 'output', 0, 'accept'),
	chain('inet', 'fw4', 'mangle_input', 'input', -150, 'accept'),
	chain('inet', 'fw4', 'dstnat', 'prerouting', -100, 'accept', 'nat'),
	chain('inet', 'fw4', 'srcnat', 'postrouting', 100, 'accept', 'nat'),
	chain('inet', 'fw4', 'syn_flood'),
	chain('inet', 'fw4', 'input_lan'),
	chain('inet', 'fw4', 'handle_reject'),
	chain('inet', 'fw4', 'helper_lan'),
	rule('inet', 'fw4', 'input', [ { match: { op: '==', left: { meta: { key: 'iif' } }, right: 'lo' } }, { accept: null } ], '!fw4: Accept traffic from loopback'),
	rule('inet', 'fw4', 'input', [ { vmap: { key: { ct: { key: 'state' } }, data: { set: [ [ 'established', { accept: null } ], [ 'related', { accept: null } ] ] } } } ], '!fw4: Handle inbound flows'),
	rule('inet', 'fw4', 'input', [ { match: { op: '==', left: { '&': [ { payload: { protocol: 'tcp', field: 'flags' } }, { '|': [ 'fin', 'syn' ] } ] }, right: 'syn' } }, { jump: { target: 'syn_flood' } } ]),
	rule('inet', 'fw4', 'input', [ iif('br-lan'), { jump: { target: 'input_lan' } } ], '!fw4: Handle lan IPv4/IPv6 input traffic'),
	rule('inet', 'fw4', 'input', [ { jump: { target: 'handle_reject' } } ]),
	rule('inet', 'fw4', 'syn_flood', [ { limit: { rate: 25, burst: 50, per: 'second' } }, { return: null } ], '!fw4: Accept SYN packets below rate-limit'),
	rule('inet', 'fw4', 'syn_flood', [ { drop: null } ], '!fw4: Drop excess packets'),
	rule('inet', 'fw4', 'input_lan', [ { match: { op: '==', left: { payload: { protocol: 'ip', field: 'saddr' } }, right: '192.0.2.10' } }, { counter: { packets: 12, bytes: 3400 } }, { log: { prefix: 'ssh ' } }, { accept: null } ], '!fw4: Allow-SSH'),
	rule('inet', 'fw4', 'input_lan', [ { goto: { target: 'handle_reject' } } ]),
	rule('inet', 'fw4', 'handle_reject', [ { reject: { type: 'tcp reset' } } ]),
	rule('inet', 'fw4', 'srcnat', [ { match: { op: '==', left: { meta: { key: 'oifname' } }, right: 'wan' } }, { masquerade: null } ]),
	rule('inet', 'fw4', 'forward', [ { counter: { packets: 1, bytes: 60 } } ]),
	{ table: { family: 'bridge', name: 'mgmt' } },
	chain('bridge', 'mgmt', 'input', 'input', -200, 'accept'),
	rule('bridge', 'mgmt', 'input', [ { match: { op: '!=', left: { meta: { key: 'iifname' } }, right: 'eth0' } }, { drop: null } ], 'Management only over the wire'),
	{ table: { family: 'netdev', name: 'qos' } }
] };

test('nftmodel: verdicts, comments and LuCI\'s split of conditions and actions', () => {
	const m = nft.build(RULESET);
	const input = m.chains[K('inet', 'fw4', 'input')];
	assert.equal(input.base, true);
	assert.equal(input.policy, 'drop');
	assert.deepEqual(input.rules.map((r) => r.verdict.kind), [ 'accept', 'vmap', 'jump', 'jump', 'jump' ]);
	assert.equal(input.rules[0].comment, 'Accept traffic from loopback');
	assert.equal(input.rules[2].comment, '');
	assert.deepEqual(input.rules[1].verdict.map, [ { key: 'established', kind: 'accept', target: undefined }, { key: 'related', kind: 'accept', target: undefined } ]);
	assert.equal(input.rules[3].verdict.target, 'input_lan');

	/* a limit is a condition in LuCI's view, the return the action */
	assert.deepEqual(m.chains[K('inet', 'fw4', 'syn_flood')].rules[0].parts, { conds: 1, acts: 1, last: 0 });
	/* counter left out; log is an action beside the deciding accept */
	const ssh = m.chains[K('inet', 'fw4', 'input_lan')].rules[0];
	assert.deepEqual(ssh.parts, { conds: 1, acts: 2, last: 1 });
	assert.deepEqual(ssh.counter, { packets: 12, bytes: 3400 });
	assert.equal(ssh.comment, 'Allow-SSH');
	assert.deepEqual(m.chains[K('inet', 'fw4', 'input_lan')].rules[1].verdict, { kind: 'goto', target: 'handle_reject' });
	assert.deepEqual(m.chains[K('inet', 'fw4', 'srcnat')].rules[0].verdict, { kind: 'nat', nat: 'masquerade' });
	/* a rule that only counts decides nothing */
	assert.deepEqual(m.chains[K('inet', 'fw4', 'forward')].rules[0].verdict, { kind: 'none' });
	assert.deepEqual(m.chains[K('inet', 'fw4', 'forward')].rules[0].parts, { conds: 0, acts: 0, last: -1 });
});

test('nftmodel: callers, chains nobody jumps to, base chains in path order', () => {
	const m = nft.build(RULESET);
	assert.deepEqual(m.chains[K('inet', 'fw4', 'handle_reject')].callers, [ K('inet', 'fw4', 'input'), K('inet', 'fw4', 'input_lan') ]);
	assert.deepEqual(m.unused, [ K('inet', 'fw4', 'helper_lan') ]);
	assert.deepEqual(m.bases, [ K('inet', 'fw4', 'dstnat'), K('inet', 'fw4', 'mangle_input'), K('inet', 'fw4', 'input'), K('inet', 'fw4', 'forward'), K('inet', 'fw4', 'output'), K('inet', 'fw4', 'srcnat') ]);
	assert.deepEqual(m.others, [ { family: 'bridge', name: 'mgmt', chains: [ K('bridge', 'mgmt', 'input') ] } ]);
	/* tables in ruleset order, a chainless one too (LuCI renders it) */
	assert.deepEqual(m.tables.map((t) => t.family + ' ' + t.name), [ 'inet fw4', 'bridge mgmt', 'netdev qos' ]);
});

test('nftmodel: stages put bridge chains where a packet meets them and say what gets dropped', () => {
	const m = nft.build(RULESET), st = m.stages;
	assert.deepEqual(Object.keys(st).filter((k) => st[k]), [ 'prerouting', 'input', 'forward', 'output', 'postrouting', 'bridgeIn', 'bridged' ]);
	assert.deepEqual(st.bridgeIn.chains, [ K('bridge', 'mgmt', 'input') ]);
	assert.equal(st.bridgeIn.drops, 'some');
	assert.equal(st.input.drops, 'all');
	assert.equal(st.prerouting.drops, 'none');
	assert.deepEqual(st.input.chains, [ K('inet', 'fw4', 'mangle_input'), K('inet', 'fw4', 'input') ]);
	/* the IP hooks are always there, another family's only with chains */
	assert.deepEqual(st.output.chains, [ K('inet', 'fw4', 'output') ]);
	/* the bridged path is always there: frames between bridge ports skip
	   the IP hooks, and here no bridge chain sees them */
	assert.deepEqual(st.bridged.chains, []);
	assert.equal(st.bridged.drops, 'none');
	assert.equal(st.egress, null);

	const bridged = nft.build({ nftables: RULESET.nftables.concat([ chain('bridge', 'mgmt', 'fwd', 'forward', 0, 'accept') ]) });
	assert.deepEqual(bridged.stages.bridged.chains, [ K('bridge', 'mgmt', 'fwd') ]);
});

test('nftmodel: no ruleset, junk and unknown statements build an empty or partial model', () => {
	for (const j of [ null, {}, { nftables: 'x' }, { nftables: [ null, 1, { chain: {} }, { rule: { chain: 'x' } } ] } ]) {
		const m = nft.build(j);
		assert.deepEqual(m.bases, []);
		assert.deepEqual(m.others, []);
	}
	/* names can't hold a newline; spaces in them don't make two chains one */
	assert.notEqual(nft.keyOf('inet', 'a b', 'c'), nft.keyOf('inet', 'a', 'b c'));
	assert.deepEqual(nft.ruleVerdict([ { queue: { num: 1 } } ]), { kind: 'queue' });
	assert.deepEqual(nft.ruleVerdict([ { jump: {} } ]), { kind: 'none' });
	assert.deepEqual(nft.ruleVerdict('accept'), { kind: 'none' });
	/* a named verdict map: its contents aren't in the terse ruleset */
	assert.deepEqual(nft.ruleVerdict([ { vmap: { key: { meta: { key: 'iifname' } }, data: '@zones' } } ]), { kind: 'vmap', map: [], named: 'zones' });
	assert.equal(nft.comment('!fw4: Allow-Ping '), 'Allow-Ping');
});

test('nftmodel: a stage drops some when a chain it jumps or goes to does (fw4 zone chains)', () => {
	/* input at policy accept, the wan zone rejecting in its own chains */
	const m = nft.build({ nftables: [
		{ table: { family: 'inet', name: 'fw4' } },
		chain('inet', 'fw4', 'input', 'input', 0, 'accept'),
		chain('inet', 'fw4', 'output', 'output', 0, 'accept'),
		chain('inet', 'fw4', 'input_wan'),
		chain('inet', 'fw4', 'reject_from_wan'),
		chain('inet', 'fw4', 'handle_reject'),
		chain('inet', 'fw4', 'vpn_out'),
		rule('inet', 'fw4', 'input', [ iif('wan'), { jump: { target: 'input_wan' } } ]),
		rule('inet', 'fw4', 'input_wan', [ { goto: { target: 'reject_from_wan' } } ]),
		rule('inet', 'fw4', 'reject_from_wan', [ { jump: { target: 'handle_reject' } } ]),
		rule('inet', 'fw4', 'handle_reject', [ { reject: { type: 'icmpx', expr: 'port-unreachable' } } ]),
		rule('inet', 'fw4', 'output', [ { vmap: { key: { ct: { key: 'state' } }, data: { set: [ [ 'invalid', { drop: null } ] ] } } } ])
	] });
	assert.equal(m.stages.input.drops, 'some');
	assert.equal(m.stages.output.drops, 'some');
	assert.equal(m.stages.forward.drops, 'none');
	assert.equal(m.chains[K('inet', 'fw4', 'input_wan')].mayDrop, true);
	assert.equal(m.chains[K('inet', 'fw4', 'vpn_out')].mayDrop, false);
});

test('nftmodel: ingress chains, offloading, an empty dropping bridge chain, IPv4-only drops', () => {
	const m = nft.build({ nftables: [
		{ table: { family: 'inet', name: 'fw4' } },
		chain('inet', 'fw4', 'input', 'input', 0, 'accept'),
		chain('inet', 'fw4', 'antispoof', 'ingress', -500, 'accept'),
		rule('inet', 'fw4', 'antispoof', [ { drop: null } ]),
		{ flowtable: { family: 'inet', table: 'fw4', name: 'ft', hook: 'ingress', prio: 0, dev: [ 'eth0' ] } },
		{ table: { family: 'ip', name: 'filter' } },
		chain('ip', 'filter', 'FORWARD', 'forward', 0, 'drop'),
		{ table: { family: 'bridge', name: 'iso' } },
		chain('bridge', 'iso', 'fwd', 'forward', 0, 'drop')
	] });
	assert.deepEqual(m.stages.ingress.chains, [ K('inet', 'fw4', 'antispoof') ]);
	assert.equal(m.bases[0], K('inet', 'fw4', 'antispoof'));
	assert.equal(m.offload, true);
	/* a bridge chain with a drop policy and no rules filters every frame */
	assert.deepEqual(m.stages.bridged.chains, [ K('bridge', 'iso', 'fwd') ]);
	assert.equal(m.stages.bridged.drops, 'all');
	/* only IPv4's forward chain drops unmatched: say so */
	assert.equal(m.stages.forward.drops, 'all');
	assert.equal(m.stages.forward.only, 'ip');
	assert.equal(nft.build(RULESET).offload, false);
});

/* LuCI's loader resolves a promise with the module instance: a method
   named then would make the instance a thenable and the load never ends */
test('nftflow: no theme module is a thenable', () => {
	for (const f of fs.readdirSync(path.join(RES, 'vantage-theme')))
		assert.doesNotMatch(fs.readFileSync(path.join(RES, 'vantage-theme', f), 'utf8'), /^\t(then|catch|finally)\s*(\(|:)/m, f);
});

/* ------------- review at 85b66db, finding 05: one snapshot per rule

   LuCI's page draws its rules table from one read of the ruleset, the
   flow view reads it again. The flow must not put the conditions of the
   first read beside what the rule does in the second. */

test('nftmodel: a rule keeps the JSON it was built from', () => {
	const m = nft.build(RULESET);
	const rules = RULESET.nftables.filter((it) => it.rule && it.rule.chain === 'input_lan').map((it) => it.rule);
	assert.deepEqual(m.chains[K('inet', 'fw4', 'input_lan')].rules.map((r) => r.spec), rules);
	assert.equal(m.chains[K('inet', 'fw4', 'input_lan')].rules[0].spec, rules[0], 'the object itself');
});

/* a fake DOM: what nftflow.js and the stand-in for LuCI's view use */
function matches(el, sel) {
	return sel.split(',').some((one) => {
		const parts = one.trim().replace(/^:scope\s*>\s*/, '').split(/\s+/), scoped = /^\s*:scope/.test(one);
		const simple = (n, s) => {
			const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(s);
			if (!m || !n || n.nodeType !== 1 || (m[1] && n.tagName !== m[1].toUpperCase())) return false;
			if ((m[2].match(/\.[\w-]+/g) || []).some((c) => !n.classList.contains(c.slice(1)))) return false;
			return (m[3].match(/\[[^\]]+\]/g) || []).every((a) => {
				const x = /^\[([\w-]+)(?:(\^?=)"?([^"\]]*)"?)?\]$/.exec(a), v = n.getAttribute(x[1]);
				return v != null && (!x[2] || (x[2] === '=' ? v === x[3] : v.indexOf(x[3]) === 0));
			});
		};
		if (!simple(el, parts[parts.length - 1])) return false;
		if (scoped) return el.parentNode === matches.scope;
		let n = el.parentNode;
		for (let i = parts.length - 2; i >= 0; i--) {
			while (n && !simple(n, parts[i])) n = n.parentNode;
			if (!n) return false;
			n = n.parentNode;
		}
		return true;
	});
}
class El {
	constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; }
	get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
	get firstChild() { return this.childNodes[0] || null; }
	get firstElementChild() { return this.children[0] || null; }
	get id() { return this.attrs.id || ''; }
	get className() { return this.attrs.class || ''; }
	set className(v) { this.attrs.class = v; }
	get classList() {
		const list = () => this.className.split(/\s+/).filter(Boolean);
		return { contains: (c) => list().indexOf(c) >= 0,
			toggle: (c, on) => { this.attrs.class = list().filter((x) => x !== c).concat(on ? [ c ] : []).join(' '); } };
	}
	get textContent() { return this.childNodes.map((n) => n.nodeType === 3 ? n.data : n.textContent).join(''); }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
	appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.childNodes.push(n); return n; }
	insertBefore(n, ref) { this.appendChild(n); if (ref) { this.childNodes.pop(); this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); } return n; }
	remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
	addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
	matches(sel) { return matches(this, sel); }
	closest(sel) { for (let n = this; n; n = n.parentNode) if (matches(n, sel)) return n; return null; }
	querySelectorAll(sel) {
		const out = [], walk = (n) => n.children.forEach((c) => { matches.scope = this; if (matches(c, sel)) out.push(c); walk(c); });
		walk(this);
		return out;
	}
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const textNode = (data) => ({ nodeType: 3, data: String(data), parentNode: null, remove() { El.prototype.remove.call(this); } });
function E(tag, attrs, kids) {
	const el = new El(tag);
	for (const k in (attrs || {})) typeof attrs[k] === 'function' ? el.addEventListener(k, attrs[k]) : el.setAttribute(k, attrs[k]);
	[].concat(kids == null ? [] : kids).forEach((c) => el.appendChild(typeof c === 'object' ? c : textNode(c)));
	return el;
}

/* LuCI's view for a rule, shaped as its renderRule(data, spec): a row of
   two cells, the comment and conditions in the first, the actions (a
   jump as a link to the chain) in the second */
const luciView = (seen) => ({
	renderRule(data, spec) {
		if (seen) seen.push([ data, spec ]);
		const badge = (cls, kids) => E('span', { 'class': 'ifacebadge' + cls }, kids);
		const row = E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td' }), E('td', { 'class': 'td' }) ]);
		if (spec.comment) row.childNodes[0].appendChild(badge(' cbi-tooltip-container nft-comment', [ E('var', {}, [ '#' ]), E('div', { 'class': 'cbi-tooltip' }, [ 'Rule comment: ' + spec.comment ]) ]));
		spec.expr.forEach((st) => {
			if (st.match) row.childNodes[0].appendChild(badge('', [ E('var', {}, [ st.match.left.payload.protocol + ' ' + st.match.left.payload.field ]), ' is ', E('strong', {}, [ String(st.match.right) ]) ]));
			else if (st.jump) row.childNodes[1].appendChild(badge('', [ 'Continue in ', E('strong', {}, [ E('a', { 'href': '#' + spec.table + '.' + st.jump.target }, [ st.jump.target ]) ]) ]));
			else row.childNodes[1].appendChild(badge('', [ Object.keys(st)[0] === 'accept' ? 'Accept packet' : 'Drop packet' ]));
		});
		return row;
	}
});

/* the page as LuCI left it for a ruleset: #view > div > .nft-table > .nft-chains > .nft-chain */
function luciPage(json) {
	const chains = json.nftables.filter((it) => it.chain).map((it) => E('div', { 'class': 'nft-chain' }, [
		E('h4', { 'id': it.chain.table + '.' + it.chain.name }, [ it.chain.name ]),
		E('table', { 'class': 'nft-rules table' }, [ E('tr', { 'class': 'tr table-titles' }, [ E('th', {}, [ 'Rule matches' ]) ]) ].concat(
			json.nftables.filter((r) => r.rule && r.rule.chain === it.chain.name).map((r) => luciView().renderRule(json.nftables, r.rule))))
	]));
	const root = E('div', {}, [ E('div', { 'class': 'nft-table' }, [ E('h3', {}, [ 'fw4' ]), E('div', { 'class': 'nft-chains' }, chains) ]) ]);
	return { view: E('div', { 'id': 'view' }, [ root ]), root };
}

/* nftflow.js as LuCI evaluates it: a function of window, document, L and its requires */
function loadFlow(json, luci) {
	const src = fs.readFileSync(path.join(RES, 'vantage-theme/nftflow.js'), 'utf8');
	const asked = [];
	const L = { resolveDefault: (p, d) => Promise.resolve(p).catch(() => d), require: (name) => { asked.push(name); return luci instanceof Error ? Promise.reject(luci) : Promise.resolve(luci); } };
	const deps = { baseclass: { extend: (proto) => proto }, fs: { exec_direct: () => Promise.resolve(json) }, 'vantage-theme.nftmodel': nft };
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) { params.push(m[2] || m[1]); values.push(deps[m[1]]); }
	Object.assign(global, { E, _: (s) => s, N_: (n, a, b) => n === 1 ? a : b });
	if (!String.prototype.format)
		Object.defineProperty(String.prototype, 'format', { value: function(...a) { let i = 0; return this.replace(/%[sdh]/g, () => String(a[i++])); } });
	const flow = new Function('window', 'document', 'L', 'localStorage', ...params, src)({ matchMedia: () => ({ matches: false }) }, { createTextNode: textNode }, L, { getItem: () => null, setItem() {} }, ...values);
	return { flow, asked };
}

const port = (n) => ({ match: { op: '==', left: { payload: { protocol: 'tcp', field: 'dport' } }, right: n } });
/* one chain, one commented rule: the same count, comment and (no) jump in both reads */
const snapshot = (n, what) => ({ nftables: [
	{ table: { family: 'inet', name: 'fw4' } },
	chain('inet', 'fw4', 'input', 'input', 0, 'drop'),
	rule('inet', 'fw4', 'input', [ port(n), what ], '!fw4: Allow-Admin')
] });
const steps = (root) => root.querySelectorAll('.v-nft-step').map((li) => li.children.map((c) => c.textContent).join(' | '));

test('nftflow 05: a rule edited between LuCI\'s read and this one shows its own conditions, never the page\'s', async () => {
	const before = snapshot(22, { accept: null }), after = snapshot(443, { drop: null });
	const page = luciPage(before), seen = [];
	assert.match(page.root.textContent, /tcp dport is 22.*Accept packet/, 'LuCI\'s table shows its own read');
	const { flow, asked } = loadFlow(after, luciView(seen));
	flow.attach(page.view);
	await new Promise((ok) => setImmediate(ok));
	assert.equal(page.root.firstChild.className, 'v-nft', 'drawn above LuCI\'s tables');
	/* the input chain drops unmatched packets: its card starts open */
	assert.deepEqual(steps(page.root.firstChild), [ '1 | Allow-Admintcp dport is 443 | Drop', ' | No rule matched | Drop: input policy' ]);
	assert.doesNotMatch(page.root.firstChild.textContent, /is 22|Accept/);
	assert.deepEqual(asked, [ 'view.status.nftables' ], 'LuCI\'s own view, which the page has loaded');
	/* LuCI's view drew the very rule this read holds, with this read as its data */
	assert.equal(seen.length, 1);
	assert.equal(seen[0][0], after.nftables);
	assert.equal(seen[0][1], after.nftables[2].rule);
});

test('nftflow 05: where LuCI\'s view cannot draw a rule the step shows no conditions, not the page\'s', async () => {
	const before = snapshot(22, { accept: null }), after = snapshot(443, { drop: null });
	const broken = { renderRule() { throw new Error('unknown expression'); } }, odd = { renderRule: () => E('div', {}, [ 'x' ]) };
	for (const [ luci, why ] of [ [ {}, 'no renderRule' ], [ null, 'no view' ], [ new Error('load'), 'the view fails to load' ], [ broken, 'it throws' ], [ odd, 'no row of two cells' ] ]) {
		const page = luciPage(before);
		loadFlow(after, luci).flow.attach(page.view);
		await new Promise((ok) => setImmediate(ok));
		assert.deepEqual(steps(page.root.firstChild)[0], '1 | Allow-Admin | Drop', why);
		assert.doesNotMatch(page.root.firstChild.textContent, /is 22|is 443/, why);
	}
	/* and a rule without a name says where its conditions are */
	const page = luciPage(before), bare = snapshot(443, { drop: null });
	delete bare.nftables[2].rule.comment;
	loadFlow(bare, null).flow.attach(page.view);
	await new Promise((ok) => setImmediate(ok));
	assert.equal(steps(page.root.firstChild)[0], '1 | Conditions in the rules table | Drop');
});

/* LuCI's own view from the rootfs dump (skipped without it): the function
   the flow calls is there, takes (ruleset, rule) and gives a row of two
   cells for the rule it is handed */
const NFT_JS = path.join(path.resolve(process.env.VANTAGE_ROOTFS || path.join(__dirname, '../../vantage-rootfs')), 'www/luci-static/resources/view/status/nftables.js');
const NO_NFT_JS = fs.existsSync(NFT_JS) ? false : 'no LuCI nftables view in the rootfs dump (set VANTAGE_ROOTFS)';

test('nftflow 05: LuCI\'s view draws the rule of this read (its renderRule, from the rootfs dump)', { skip: NO_NFT_JS }, async () => {
	const src = fs.readFileSync(NFT_JS, 'utf8');
	const before = snapshot(22, { accept: null }), after = snapshot(443, { drop: null });
	const page = luciPage(before);
	const { flow } = loadFlow(after, null);      /* sets E, _ and format as LuCI has them */
	const stubs = { view: { extend: (proto) => proto }, dom: { append: (node, kids) => [].concat(kids).forEach((k) => node.appendChild(typeof k === 'object' ? k : textNode(k))) } };
	const names = [ ...src.matchAll(/'require ([\w.-]+)';/g) ].map((m) => m[1]);
	assert.ok(names.indexOf('view') >= 0 && names.indexOf('dom') >= 0);
	const luci = new Function(...names, src)(...names.map((n) => stubs[n] || {}));
	assert.equal(typeof luci.renderRule, 'function');
	flow.draw(page.root, nft.build(after), after.nftables, luci);
	const step = steps(page.root.firstChild)[0];
	assert.match(step, /^1 \| Allow-Admin.*443.* \| Drop$/);
	assert.doesNotMatch(step, /\b22\b/);
});
