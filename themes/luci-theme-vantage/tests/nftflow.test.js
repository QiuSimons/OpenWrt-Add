'use strict';
/* Status -> Firewall flow view: the ruleset model (vantage-theme.nftmodel). */
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
