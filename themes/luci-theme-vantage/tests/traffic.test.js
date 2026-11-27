'use strict';
const mkTmp = require('./tmpdir');
/* luci-app-vantage-traffic's executable rpcd plugin (root/usr/libexec/rpcd/
   luci.vantage.traffic, #110): per-host byte counters from the kernel's
   connection accounting, read from /proc/net/nf_conntrack in a process of
   its own, with its state in a directory of its own between calls.

   What it must do: answer rpcd's "list" and "call hosts" and nothing
   else; know an entry again however its timeout and state move, and when
   it becomes offloaded (the kernel then prints no timeout); count both
   directions the right way round (a host that opened the connection, one
   a port forward reaches, two hosts of this router's networks); find IPv6
   hosts by the neighbour table's spelling; keep counters that only grow,
   from one process to the next; count a reset counter (nlbwmon's
   zero-on-read) from zero; follow an address the neighbour table does not
   give a host yet so that it does not count whole later; cap entries and
   hosts; say when accounting is off and when entries are offloaded; share
   one read among all callers for 5 s (30 s with Low-power router), one at
   a time; stop reading the table after its time budget and wait longer
   after a slow read; know an entry a read did not see when one sees it
   again, for a while, within what it reads back (any the read before
   saw; past that, from 64 KiB, or any a partial read missed); keep its
   files to itself (0700, 0600), refuse a directory it did not make and a
   state it did not write, and give no answer without the state it comes
   from; and hand out nothing but MACs and byte counts. The lean parse
   must give what the slower one gives, on every kind of line, and leave
   lines it does not fit to it. An entry is known by its conntrack zone
   too (the same addresses and ports in two zones are two entries), by
   one key whichever parse reads it; an address two interfaces give
   different MACs is counted for nobody; and a file that did not reach
   the disk whole never takes the place of the one before it.

   Each call runs the plugin as rpcd would, a ucode process with the
   arguments rpcd passes, under a host ucode binary ($UCODE, else `ucode`
   on PATH; skipped otherwise), with rtnl and uci replaced by the doubles
   in tests/ucode/traffic-stubs, its table, accounting switch and state
   directory in a directory of the test's and its clock driven by the
   test. The table is text: nothing here touches a firewall. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'luci-app-vantage-traffic');
const PLUGIN = path.join(PKG, 'root/usr/libexec/rpcd/luci.vantage.traffic');
const BENCH = path.join(ROOT, 'dev/traffic/bench.uc');
const STUBS = path.join(__dirname, 'ucode/traffic-stubs');

function findUcode() {
	const cands = [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')));
	for (const c of cands) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const NO_UCODE = UCODE ? false : 'no ucode binary (set UCODE=/path/to/ucode)';

const CLOCK_FN = 'function now_ms() {\n\tlet t = clock(true);\n\treturn t[0] * 1000 + int(t[1] / 1000000);\n}';
const DISPATCH = "if (ARGV[0] == 'list')\n";

/* test-largest: the largest state the plugin can write, through its own
   writer and reader: 2 x MAX_ENTRIES entries with keys of MAX_KEY
   characters, MAX_HOSTS hosts, every number the widest a 64-bit integer
   prints (18446744073709551615); then the size of the file and what
   load_state took back of it */
const LARGEST = "\tdir_ok();\n\tflows = {};\n\ttotals = {};\n\tlet top = 18446744073709551615;\n" +
	"\tfor (let i = 0; i < 2 * MAX_ENTRIES; i++)\n\t\tflows[sprintf('%0' + MAX_KEY + 'd', i)] = [ top, top, top ];\n" +
	"\tfor (let i = 0; i < MAX_HOSTS; i++)\n\t\ttotals[sprintf('02:00:5e:00:%02x:%02x', i >> 8, i & 255)] = [ top, top, top ];\n" +
	"\tlet saved = save_state(top);\n\tflows = null;\n\ttotals = null;\n\tload_state();\n" +
	"\tprint(sprintf('%J\\n', { saved, size: length(readfile(DIR + '/state.json')), flows: length(flows), totals: length(totals), before }));\n";

/* The plugin with its table, switch and state directory in dir, the
   state directory's owner this process's account (root's on a router, or
   uid), the test's clock (NOW, STEP), the stubs' data from STUB, modes
   that hand out both parses, its limits, and a state at its largest
   written and read back, and what the stubs and the clock saw on stderr */
function pluginCopy(src, dir, uid) {
	const swaps = [
		[ /st\.uid === 0/, 'st.uid === ' + (uid == null ? process.getuid() : uid) ],
		[ /^const TABLE = .*$/m, 'const TABLE = ' + JSON.stringify(path.join(dir, 'nf_conntrack')) + ';' ],
		[ /^const ACCT = .*$/m, 'const ACCT = ' + JSON.stringify(path.join(dir, 'acct')) + ';' ],
		[ /^const DIR = .*$/m, 'const DIR = ' + JSON.stringify(path.join(dir, 'state')) + ';' ],
		[ CLOCK_FN, 'function now_ms() {\n\tglobal.CLOCK.reads++;\n\tlet t = global.CLOCK.t;\n\tglobal.CLOCK.t += global.CLOCK.step;\n\treturn t;\n}' ],
		[ DISPATCH, "global.STUB = json(readfile(STUB));\nglobal.STUB.dumps = 0;\nglobal.STUB.uci = 0;\nglobal.CLOCK = { t: NOW, step: STEP, reads: 0 };\n" +
			"if (ARGV[0] == 'test-parse')\n\tprint(sprintf('%J\\n', map(json(readfile(INPUT)), (l) => { let e = []; return [ parse(l, e) ? e : null, parse_slow(l) ]; })));\n" +
			"else if (ARGV[0] == 'test-const')\n\tprint(sprintf('%J\\n', { MAX_STATE, MAX_KEY, MAX_ENTRIES, MAX_HOSTS, KEEP_MS, KEEP_BYTES }));\n" +
			"else if (ARGV[0] == 'test-largest') {\n" + LARGEST + "}\n" +
			'else ' + DISPATCH ]
	];
	for (const [ from, to ] of swaps) {
		const next = src.replace(from, () => to);
		assert.notEqual(next, src, 'the test can change ' + from);
		src = next;
	}
	return src + "warn(sprintf('\\n%J\\n', { dumps: global.STUB.dumps, uci: global.STUB.uci, clock: global.CLOCK.reads }));\n";
}

/* a directory for one run of calls: the copy and the files it reads */
function setup(source, uid) {
	const dir = mkTmp('vantage-traffic-');
	fs.writeFileSync(path.join(dir, 'plugin.uc'), pluginCopy(source == null ? fs.readFileSync(PLUGIN, 'utf8') : source, dir, uid));
	return dir;
}
/* the plugin run as rpcd runs it: argv, what it printed, what the stubs saw */
function exec(dir, argv, o) {
	o = o || {};
	fs.writeFileSync(path.join(dir, 'stub.json'), JSON.stringify({ neigh: o.neigh || {}, power: o.power == null ? null : o.power, short: o.short || null }));
	const r = spawnSync(UCODE, [ '-L', STUBS, '-D', 'STUB=' + path.join(dir, 'stub.json'), '-D', 'NOW=' + (o.now || 0), '-D', 'STEP=' + (o.step || 0),
		'-D', 'INPUT=' + path.join(dir, 'input.json'), path.join(dir, 'plugin.uc') ].concat(argv), { encoding: 'utf8', maxBuffer: 64 << 20, input: '{ "ubus_rpc_session": "x" }' });
	const seen = r.stderr.trim().split('\n').pop();
	return { status: r.status, out: r.stdout, stderr: r.stderr, seen: /^\{/.test(seen) ? JSON.parse(seen) : null };
}
/* calls of `hosts` one after another, each a process of its own, as rpcd
   makes them: [ { reply, dumps, uci, clock } ] */
function calls(list, dir) {
	dir = dir || setup();
	return list.map(c => {
		const table = path.join(dir, 'nf_conntrack'), acct = path.join(dir, 'acct');
		if (c.table == null) fs.rmSync(table, { force: true }); else fs.writeFileSync(table, c.table.map(l => l + '\n').join(''));
		if (c.acct == null) fs.rmSync(acct, { force: true }); else fs.writeFileSync(acct, c.acct);
		const r = exec(dir, [ 'call', 'hosts' ], c);
		assert.equal(r.status, 0, r.stderr);
		return Object.assign({ reply: JSON.parse(r.out) }, r.seen);
	});
}
/* the plugin's limits, from its own constants */
let LIMITS = null;
function limits() {
	if (!LIMITS) {
		const r = exec(setup(), [ 'test-const' ]);
		assert.equal(r.status, 0, r.stderr);
		LIMITS = JSON.parse(r.out);
	}
	return LIMITS;
}
const parses = lines => {
	const dir = setup();
	fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify(lines));
	const r = exec(dir, [ 'test-parse' ]);
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.out);
};

/* one line as the kernel prints it ("%-8s %u %-8s %u %ld "; no timeout
   when the entry is offloaded), accounting on. Its conntrack zone: of
   both directions after the mark (zid; "zone=0" for an entry in none,
   nothing on a kernel without zones: zid false), then the entry's age
   with timestamps on (delta); of one direction among that direction's
   fields (zone, rzone), and then none after the mark */
const NUM = { tcp: 6, udp: 17, icmp: 1, icmpv6: 58, sctp: 132, dccp: 33, udplite: 136, gre: 47, unknown: 47 };
function line(o) {
	const name = o.proto || 'tcp';
	const head = (o.v6 ? 'ipv6     10 ' : 'ipv4     2 ') + name.padEnd(8) + ' ' + (o.num != null ? o.num : NUM[name]) + ' ' +
		(o.offload || o.hw ? '' : (o.timeout || 7438) + ' ') + (o.state === undefined ? (name === 'tcp' ? 'ESTABLISHED ' : '') : o.state ? o.state + ' ' : '');
	const ports = o.ports != null ? o.ports : o.sport != null ? ` sport=${o.sport} dport=${o.dport}` : '';
	const back = o.back != null ? o.back : o.sport != null ? ` sport=${o.dport} dport=${o.sport}` : '';
	const orig = `src=${o.src} dst=${o.dst}${ports}${o.zone || ''}` + (o.acct === false ? '' : ` packets=1 bytes=${o.ob}`);
	const reply = `src=${o.rsrc} dst=${o.rdst}${back}${o.rzone || ''}` + (o.acct === false ? '' : ` packets=1 bytes=${o.rb}`);
	/* the kernel prints [HW_OFFLOAD] or [OFFLOAD] in place of [ASSURED] */
	const flag = o.hw ? '[HW_OFFLOAD] ' : o.offload ? '[OFFLOAD] ' : o.assured === false ? '' : '[ASSURED] ';
	const tail = (o.zone || o.rzone || o.zid === false ? '' : `zone=${o.zid || 0} `) + (o.delta != null ? `delta-time=${o.delta} ` : '');
	return `${head}${orig}${o.unreplied ? ' [UNREPLIED]' : ''} ${reply} ${flag}mark=0 ${tail}use=2`;
}
const at = (o, x) => Object.assign({}, o, x);

const M1 = '00:00:5e:00:53:01', M2 = '00:00:5e:00:53:02', M3 = '00:00:5e:00:53:03';
const V6A = '2001:0db8:0000:0000:0000:0000:0000:0010', V6R = '2001:0db8:0001:0000:0000:0000:0000:0005';
/* the neighbour tables as rtnl dumps them: two networks of this router, IPv6 in its short form */
const n4 = (dst, lladdr, state) => ({ family: 2, dev: 'br-lan', dst, lladdr, state: state == null ? 2 : state });
const n6 = (dst, lladdr, state) => ({ family: 10, dev: 'br-lan', dst, lladdr, state: state == null ? 4 : state });
const NEIGH = { 2: [ n4('192.0.2.10', M1), n4('192.0.2.20', M2), n4('198.51.100.30', M3), n4('203.0.113.254', '00:00:5e:00:53:fe') ], 10: [ n6('2001:db8::10', M1) ] };

const OUT = { src: '192.0.2.10', dst: '203.0.113.5', sport: 40000, dport: 443, rsrc: '203.0.113.5', rdst: '203.0.113.200' };
const SIX = { v6: true, src: V6A, dst: V6R, sport: 40001, dport: 443, rsrc: V6R, rdst: V6A };
/* a port forward: opened from outside, the host is the reply's source */
const FWD = { src: '203.0.113.9', dst: '203.0.113.200', sport: 50000, dport: 8443, rsrc: '192.0.2.20', rdst: '203.0.113.9' };
/* between two of this router's networks: both hosts count it */
const LAN = { src: '192.0.2.10', dst: '198.51.100.30', sport: 40002, dport: 445, rsrc: '198.51.100.30', rdst: '192.0.2.10' };
/* this router's own lookup: no host of its networks */
const OWN = { proto: 'udp', src: '203.0.113.200', dst: '203.0.113.53', sport: 40003, dport: 53, rsrc: '203.0.113.53', rdst: '203.0.113.200' };
const NEW = { src: '192.0.2.20', dst: '203.0.113.7', sport: 40004, dport: 443, rsrc: '203.0.113.7', rdst: '203.0.113.200' };

/* a call: the table, accounting on, the neighbours above, at `now` ms */
const call = (table, now, x) => Object.assign({ table, acct: '1\n', neigh: NEIGH, power: null, now }, x || {});
const of = (r, mac) => r.reply.hosts.find(h => h.mac === mac);

/* a table of n made-up entries (a quarter IPv6) over m hosts, each 100
   bytes from its host and 1000 to it, k times over; from the first-th
   made-up entry on (others than another table's) */
function table(n, m, k, first) {
	const out = [];
	for (let i = first || 0; i < (first || 0) + n; i++) {
		const h = i % m, up = 1000 + i + k * 100, down = 5000 + i + k * 1000;
		if (i % 4 === 3) {
			const a = '2001:0db8:0000:0000:0000:0000:0000:' + (h + 1).toString(16).padStart(4, '0'), b = '2001:0db8:0001:0000:0000:0000:0000:' + (i % 250 + 1).toString(16).padStart(4, '0');
			out.push(line({ v6: true, src: a, dst: b, sport: 10000 + i, dport: 443, ob: up, rsrc: b, rdst: a, rb: down }));
		}
		else {
			const a = (h < 254 ? '192.0.2.' : '198.51.100.') + (h % 254 + 1), b = '203.0.113.' + (i % 250 + 1);
			out.push(line({ src: a, dst: b, sport: 10000 + i, dport: 443, ob: up, rsrc: b, rdst: '203.0.113.254', rb: down }));
		}
	}
	return out;
}
/* the two IPv4 networks hold 508 hosts: table() gives a further one an
   address of the second again, which the kernel lists once, for the host
   that has it (two MACs for one address would be nobody's); the further
   one is known by IPv6 alone */
function neighOf(m) {
	const v4 = [], v6 = [];
	for (let h = 0; h < m; h++) {
		const mac = '02:00:5e:00:' + (h >> 8).toString(16).padStart(2, '0') + ':' + (h & 255).toString(16).padStart(2, '0');
		if (h < 508) v4.push(n4((h < 254 ? '192.0.2.' : '198.51.100.') + (h % 254 + 1), mac));
		v6.push(n6('2001:db8::' + (h + 1).toString(16), mac));
	}
	return { 2: v4, 10: v6 };
}
const sum = (r, k) => r.reply.hosts.reduce((s, h) => s + h[k], 0);

/* ------------------------------------------------------------- parse */

/* every kind of line the kernel prints: each the lean parse fits must
   give what the slower one gives; the others it must leave to it */
const KINDS = {
	'tcp': line(at(OUT, { ob: 1, rb: 2 })),
	'tcp, later timeout and state': line(at(OUT, { ob: 9, rb: 8, timeout: 12, state: 'TIME_WAIT' })),
	'tcp offloaded (no timeout)': line(at(OUT, { ob: 9, rb: 8, offload: true })),
	'tcp offloaded to hardware': line(at(OUT, { ob: 9, rb: 8, hw: true })),
	'tcp unreplied': line(at(NEW, { ob: 3, rb: 0, unreplied: true, state: 'SYN_SENT', assured: false })),
	'udp (no state)': line(at(OWN, { ob: 70, rb: 90 })),
	'udp unreplied': line(at(OWN, { ob: 70, rb: 0, unreplied: true, assured: false })),
	'udp offloaded': line(at(OWN, { ob: 70, rb: 90, offload: true })),
	'udplite': line(at(OWN, { proto: 'udplite', ob: 5, rb: 6 })),
	'icmp': line({ proto: 'icmp', src: '192.0.2.10', dst: '203.0.113.5', ports: ' type=8 code=0 id=4660', back: ' type=0 code=0 id=4660', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 84, rb: 84, timeout: 29, assured: false }),
	'icmpv6': line({ proto: 'icmpv6', v6: true, src: V6A, dst: V6R, ports: ' type=128 code=0 id=4660', back: ' type=129 code=0 id=4660', rsrc: V6R, rdst: V6A, ob: 104, rb: 104, timeout: 29, assured: false }),
	'tcp over IPv6': line(at(SIX, { ob: 5, rb: 6 })),
	'tcp over IPv6, offloaded': line(at(SIX, { ob: 5, rb: 6, offload: true })),
	'sctp': line({ proto: 'sctp', state: 'ESTABLISHED', src: '192.0.2.10', dst: '203.0.113.5', sport: 5000, dport: 5001, rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 7, rb: 8 }),
	'dccp': line({ proto: 'dccp', state: 'OPEN', src: '192.0.2.10', dst: '203.0.113.5', sport: 5000, dport: 5001, rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 7, rb: 8 }),
	'gre (its tracker: two fields of state, keys)': line({ proto: 'gre', state: 'timeout=30, stream_timeout=180', src: '192.0.2.10', dst: '203.0.113.5', ports: ' srckey=0x0 dstkey=0x0', back: ' srckey=0x0 dstkey=0x0', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 7, rb: 8 }),
	'a protocol without a tracker': line({ proto: 'unknown', num: 4, src: '192.0.2.10', dst: '203.0.113.5', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 7, rb: 8 }),
	'large counters': line(at(OUT, { ob: 900719925474099, rb: 123456789012 })),
	'tcp in a zone': line(at(OUT, { ob: 1, rb: 2, zid: 5 })),
	'tcp in a zone, later, offloaded': line(at(OUT, { ob: 9, rb: 8, zid: 5, offload: true })),
	'tcp in a zone, unreplied': line(at(OUT, { ob: 3, rb: 0, zid: 5, unreplied: true, state: 'SYN_SENT', assured: false })),
	'tcp in another zone': line(at(OUT, { ob: 1, rb: 2, zid: 6 })),
	'tcp in a zone, with its age': line(at(OUT, { ob: 1, rb: 2, zid: 5, delta: 12 })),
	'tcp in no zone, with its age': line(at(OUT, { ob: 1, rb: 2, delta: 12 })),
	'tcp on a kernel without zones': line(at(OUT, { ob: 1, rb: 2, zid: false })),
	'udp in a zone': line(at(OWN, { ob: 70, rb: 90, zid: 5, assured: false })),
	/* these the lean parse must leave to the slower one */
	'no counters (accounting off)': line(at(OUT, { acct: false })),
	'no counters, unreplied': line(at(NEW, { acct: false, unreplied: true, state: 'SYN_SENT', assured: false })),
	'no counters, no ports': line({ proto: 'unknown', num: 4, src: '192.0.2.10', dst: '203.0.113.5', rsrc: '203.0.113.5', rdst: '203.0.113.200', acct: false }),
	'a zone of the original direction': line(at(OUT, { ob: 1, rb: 2, zone: ' zone-orig=1' })),
	'another zone of the original direction': line(at(OUT, { ob: 1, rb: 2, zone: ' zone-orig=2' })),
	'a zone of the reply direction': line(at(OUT, { ob: 1, rb: 2, rzone: ' zone-reply=1' })),
	'a protocol of another name': line(at(OUT, { proto: 'mptcp', num: 6, ob: 1, rb: 2 })),
	'a protocol of another name, in a zone': line(at(OUT, { proto: 'mptcp', num: 6, ob: 1, rb: 2, zid: 5 })),
	'counters that are no counts': 'ipv4     2 tcp      6 1 src=192.0.2.1 dst=192.0.2.2 bytes=-5 src=192.0.2.2 bytes=99999999999999999999',
	'not a line': 'ipv4     2 tcp      6 7438 ESTABLISHED'
};
const LEFT = [ 'no counters (accounting off)', 'no counters, unreplied', 'no counters, no ports', 'a zone of the original direction', 'another zone of the original direction',
	'a zone of the reply direction', 'a protocol of another name', 'a protocol of another name, in a zone', 'counters that are no counts', 'not a line' ];
/* the lean parse's check (feed's): both src fields at their places, and a
   count after each (a zone of the reply direction moves the second) */
const counted = v => typeof v === 'number' && v >= 0;
const fits = e => !!e && /^src=/.test(e[1]) && /^src=/.test(e[3]) && counted(e[2]) && counted(e[4]);

test('traffic plugin: the lean parse gives what the slower one gives, on every kind of line, and leaves it the others', { skip: NO_UCODE }, () => {
	const names = Object.keys(KINDS), out = parses(names.map(n => KINDS[n]));
	names.forEach((name, i) => {
		const [ e, s ] = out[i];
		if (LEFT.includes(name)) { assert.ok(!fits(e), name + ': left to the slower parse'); return; }
		assert.ok(fits(e), name + ': fits ' + JSON.stringify(e));
		assert.ok(s && s.acct, name);
		assert.deepEqual([ e[1], e[2], e[3], e[4], e[5] === '[HW_OFFLOAD]' ? 2 : e[5] === '[OFFLOAD]' ? 1 : 0 ], [ 'src=' + s.osrc, s.obytes, 'src=' + s.rsrc, s.rbytes, s.hw ? 2 : s.off ? 1 : 0 ], name);
		assert.equal(e[0], s.key, name + ': one key, whichever parse reads the line');
	});
	const key = name => out[names.indexOf(name)][0][0];
	assert.equal(key('tcp'), key('tcp, later timeout and state'), 'one key while the timeout and the state move');
	assert.equal(key('tcp'), key('tcp offloaded (no timeout)'), 'and once offloaded');
	assert.equal(key('tcp'), key('tcp offloaded to hardware'));
	assert.equal(key('udp (no state)'), key('udp offloaded'));
	assert.equal(key('tcp over IPv6'), key('tcp over IPv6, offloaded'));
	assert.ok(!/7438|ESTABLISHED|bytes|packets/.test(key('tcp')), key('tcp'));
	assert.notEqual(key('udp (no state)'), key('udplite'), 'protocols by their numbers');
	/* the slower parse on what the lean one leaves */
	const s = name => out[names.indexOf(name)][1];
	/* the zone is part of the key: the kernel keeps the same addresses and
	   ports once in each */
	assert.equal(key('tcp in a zone'), key('tcp') + 'zone=5');
	assert.equal(key('tcp in a zone'), key('tcp in a zone, later, offloaded'), 'one key while it moves, in a zone too');
	assert.equal(key('tcp in a zone'), key('tcp in a zone, unreplied'), 'whether [ASSURED] stands before the mark or not');
	assert.equal(key('tcp in a zone'), key('tcp in a zone, with its age'));
	assert.notEqual(key('tcp in a zone'), key('tcp in another zone'));
	assert.equal(key('udp in a zone'), key('udp (no state)') + 'zone=5');
	assert.equal(key('tcp in no zone, with its age'), key('tcp'), 'zone=0 is no zone, wherever it stands');
	assert.equal(key('tcp on a kernel without zones'), key('tcp'));
	assert.equal(s('a protocol of another name, in a zone').key, s('a protocol of another name').key + 'zone=5', 'the slower parse spells it the same');
	assert.equal(s('a protocol of another name').key, key('tcp'), 'and the rest of the key');
	assert.match(s('a zone of the original direction').key, /dport=443zone-orig=1$/, 'a zone of the original direction: among its fields');
	assert.notEqual(s('a zone of the original direction').key, s('another zone of the original direction').key);
	assert.equal(s('a zone of the reply direction').key, key('tcp'), 'a zone of the reply alone leaves the original direction in zone 0');
	assert.equal(s('no counters (accounting off)').acct, false);
	assert.equal(s('no counters, unreplied').acct, false);
	assert.deepEqual([ s('a zone of the original direction').obytes, s('a zone of the original direction').rbytes ], [ 1, 2 ]);
	assert.deepEqual([ s('counters that are no counts').obytes, s('counters that are no counts').rbytes ], [ 0, 0 ], 'a count that is no count is 0');
	assert.equal(s('not a line'), null);
});

test('traffic plugin: the slower parse, as before: the reply is the second src=; a key without what moves', { skip: NO_UCODE }, () => {
	const out = parses([ line(at(OUT, { ob: 1, rb: 2 })), line(at(OUT, { ob: 9, rb: 8, timeout: 12, state: 'TIME_WAIT' })),
		line({ proto: 'unknown', num: 47, src: '192.0.2.10', dst: '203.0.113.5', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 1, rb: 1 }),
		line({ proto: 'unknown', num: 4, src: '192.0.2.10', dst: '203.0.113.5', rsrc: '203.0.113.5', rdst: '203.0.113.200', ob: 1, rb: 1 }),
		'', 'ipv5 src=1', 'ipv4 src=', 'x'.repeat(5000) ]).map(x => x[1]);
	assert.equal(out[0].key, out[1].key);
	assert.deepEqual([ out[0].osrc, out[0].obytes, out[0].rsrc, out[0].rbytes, out[0].acct, out[0].off, out[0].hw ], [ '192.0.2.10', 1, '203.0.113.5', 2, true, false, false ]);
	assert.notEqual(out[2].key, out[3].key);
	assert.deepEqual(out.slice(4), [ null, null, null, null ]);
});

/* ---------------------------------------------------------- counting */

test('traffic plugin: counters per MAC, the right way round, as this router counts them, and they only grow from one call to the next', { skip: NO_UCODE }, () => {
	const t1 = [ line(at(OUT, { ob: 1000, rb: 5000 })), line(at(SIX, { ob: 200, rb: 800 })), line(at(FWD, { ob: 300, rb: 3000 })),
		line(at(LAN, { ob: 100, rb: 50 })), line(at(OWN, { ob: 70, rb: 90 })), 'not a line' ];
	const t2 = [ line(at(OUT, { ob: 1500, rb: 9000, timeout: 7000, offload: true })),
		/* the IPv6 entry ended; the forward's counters were reset */
		line(at(FWD, { ob: 100, rb: 1000 })), line(at(LAN, { ob: 100, rb: 50 })), line(at(NEW, { ob: 10, rb: 20 })) ];
	const [ r1, r2, r3, r4, r5, r6 ] = calls([ call(t1, 0), call(t2, 5000),
		/* another viewer half a second later: the same answer, nothing read */
		call(t2, 5500),
		call(t2, 10000),
		/* ten minutes without traffic */
		call(t2, 10000 + 600001),
		call(t2, 10000 + 605001) ]);
	/* rx: from the host, tx: to it, as a port's counters */
	assert.deepEqual(r1.reply.hosts, [
		{ mac: M1, rx: 1000 + 200 + 100, tx: 5000 + 800 + 50 },
		{ mac: M2, rx: 3000, tx: 300 },
		{ mac: M3, rx: 50, tx: 100 }
	]);
	assert.deepEqual([ r1.reply.acct, r1.reply.entries, r1.reply.partial, r1.reply.zeroed ], [ true, 6, false, 0 ]);
	assert.deepEqual(of(r2, M1), { mac: M1, rx: 1300 + 500, tx: 5850 + 4000 }, 'offloaded since: known again');
	assert.deepEqual(of(r2, M2), { mac: M2, rx: 3000 + 1000 + 10, tx: 300 + 100 + 20 }, 'a reset counter counts from zero; a new entry whole');
	assert.deepEqual(of(r2, M3), of(r1, M3));
	assert.deepEqual([ r2.reply.zeroed, r2.reply.offloaded ], [ 1, 1 ]);
	assert.deepEqual(r3.reply, r2.reply, 'read again within 5 s: the last answer');
	assert.deepEqual([ r3.dumps, r3.uci, r3.clock ], [ 0, 0, 1 ], 'and nothing read for it');
	assert.deepEqual(r4.reply.hosts, r2.reply.hosts, 'the same table read again adds nothing');
	assert.notEqual(r4.reply.at, r2.reply.at);
	assert.deepEqual(r5.reply.hosts, [], 'ten minutes without traffic: gone');
	assert.deepEqual(r6.reply.hosts, [], 'and not back at 0 for its idle connections');
	/* nothing in any answer but MACs and counts */
	for (const r of [ r1, r2, r5 ]) {
		assert.deepEqual(Object.keys(r.reply).sort(), [ 'acct', 'at', 'dropped', 'entries', 'every', 'hosts', 'hw', 'low', 'offloaded', 'partial', 'slow', 'took', 'v', 'zeroed' ]);
		for (const h of r.reply.hosts) assert.deepEqual(Object.keys(h), [ 'mac', 'rx', 'tx' ]);
		assert.doesNotMatch(JSON.stringify(r.reply), /203\.0\.113|192\.0\.2|198\.51\.100|2001:|db8/i, 'no address of either end');
	}
});

test('traffic plugin: an address the neighbour table gives no host yet is followed, so it does not count whole later', { skip: NO_UCODE }, () => {
	const t = (ob, rb) => [ line(at(SIX, { ob, rb })) ];
	const none = { 2: [], 10: [] };
	const [ a, b ] = calls([ call(t(4000, 9000), 0, { neigh: none }), call(t(4100, 9500), 5000) ]);
	assert.deepEqual(a.reply.hosts, [], 'followed, not counted');
	assert.deepEqual(b.reply.hosts, [ { mac: M1, rx: 100, tx: 500 } ], 'from then on, not since it began');
	/* neighbour entries that name no host: failed, incomplete, without ARP, a group or empty MAC; a failed dump */
	const bad = { 2: [ n4('192.0.2.10', M1, 0x20), n4('192.0.2.10', M1, 0x01), n4('192.0.2.10', M1, 0x40), n4('192.0.2.10', '01:00:5e:00:53:01'),
		n4('192.0.2.10', '00:00:00:00:00:00'), n4('192.0.2.10', 'not a mac'), { dst: 7, lladdr: M1, state: 2 } ], 10: null };
	const [ c ] = calls([ call([ line(at(OUT, { ob: 1, rb: 1 })), line(at(SIX, { ob: 1, rb: 1 })) ], 0, { neigh: bad }) ]);
	assert.deepEqual([ c.reply.hosts, c.dumps ], [ [], 2 ]);
	/* a static entry (PERMANENT) and a stale one name their host */
	const [ d ] = calls([ call([ line(at(OUT, { ob: 1, rb: 2 })), line(at(SIX, { ob: 3, rb: 4 })) ], 0,
		{ neigh: { 2: [ n4('192.0.2.10', M1.toUpperCase(), 0x80) ], 10: [ n6('2001:db8::10', M2, 0x04) ] } }) ]);
	assert.deepEqual(d.reply.hosts, [ { mac: M1, rx: 1, tx: 2 }, { mac: M2, rx: 3, tx: 4 } ]);
});

test('traffic plugin: lines the lean parse leaves are counted as before', { skip: NO_UCODE }, () => {
	/* a zone of the original direction moves the fields: the slower parse, the same counts */
	const z = (ob, rb) => line(at(OUT, { ob, rb, zone: ' zone-orig=1' }));
	const [ a, b ] = calls([ call([ z(100, 500), line(at(NEW, { ob: 1, rb: 2 })) ], 0), call([ z(150, 900), line(at(NEW, { ob: 1, rb: 2 })) ], 5000) ]);
	assert.deepEqual(a.reply.hosts, [ { mac: M1, rx: 100, tx: 500 }, { mac: M2, rx: 1, tx: 2 } ]);
	assert.deepEqual(b.reply.hosts, [ { mac: M1, rx: 150, tx: 900 }, { mac: M2, rx: 1, tx: 2 } ]);
});

test('traffic plugin: the same addresses and ports in two conntrack zones are two entries; a table that did not change adds nothing', { skip: NO_UCODE }, () => {
	/* two networks with one subnet, each tracked in a zone of its own: the
	   host of each talks to the same server from the same port. One key
	   for both made every read count each from the other's numbers */
	const a = (ob, rb) => line(at(OUT, { ob, rb, zid: 1 })), b = (ob, rb) => line(at(OUT, { ob, rb, zid: 2 }));
	/* the slower parse's lines: zones of both directions and of the original one */
	const c = (ob, rb, zid) => line(at(NEW, { proto: 'mptcp', num: 6, ob, rb, zid }));
	const d = (ob, rb, n) => line(at(FWD, { ob, rb, zone: ' zone-orig=' + n }));
	const t = [ a(100, 300), b(200, 400), c(10, 30, 1), c(20, 40, 2), d(1000, 3000, 1), d(2000, 4000, 2) ];
	const [ r1, r2, r3, r4 ] = calls([ call(t, 0), call(t, 5000),
		/* the kernel lists the table in another order */
		call(t.slice().reverse(), 10000),
		/* one of each pair grows */
		call([ a(150, 360), b(200, 400), c(10, 30, 1), c(21, 42, 2), d(1001, 3002, 1), d(2000, 4000, 2) ], 15000) ]);
	const want = [ { mac: M1, rx: 300, tx: 700 }, { mac: M2, rx: 30 + 7000, tx: 70 + 3000 } ];
	assert.deepEqual(r1.reply.hosts, want, 'each entry whole, once');
	assert.deepEqual(r2.reply.hosts, want, 'read again: nothing added');
	assert.deepEqual(r3.reply.hosts, want, 'nor in another order');
	assert.deepEqual([ r1.reply.zeroed, r2.reply.zeroed, r3.reply.zeroed, r4.reply.zeroed ], [ 0, 0, 0, 0 ], 'and no counter read as reset');
	assert.deepEqual(r4.reply.hosts, [ { mac: M1, rx: 350, tx: 760 }, { mac: M2, rx: 7030 + 1 + 2, tx: 3070 + 2 + 1 } ], 'what each carried since');
});

test('traffic plugin: an address two interfaces give different MACs is counted for nobody, and followed', { skip: NO_UCODE }, () => {
	const on = (n, dev) => at(n, { dev });
	const t = (ob, rb) => [ line(at(OUT, { ob, rb })), line(at(SIX, { ob, rb })) ];
	const two = { 2: [ n4('192.0.2.10', M1), on(n4('192.0.2.10', M2), 'br-guest'), n4('192.0.2.20', M3) ],
		10: [ n6('2001:db8::10', M1), on(n6('2001:db8:0::10', M2), 'br-guest') ] };
	const swapped = { 2: [ two[2][1], two[2][0] ], 10: [ two[10][1], two[10][0] ] };
	/* the first MAC listed a third time does not win it back */
	const thrice = { 2: two[2].concat(on(n4('192.0.2.10', M1), 'br-iot')), 10: two[10].concat(on(n6('2001:db8::10', M1), 'br-iot')) };
	for (const [ name, neigh ] of [ [ 'two MACs', two ], [ 'the other order', swapped ], [ 'the first one again', thrice ] ]) {
		const [ r ] = calls([ call(t(1000, 5000), 0, { neigh }) ]);
		assert.deepEqual(r.reply.hosts, [], name + ': neither host is given the other\'s traffic');
	}
	/* one MAC on two interfaces is one host */
	const same = { 2: [ n4('192.0.2.10', M1), on(n4('192.0.2.10', M1), 'br-guest') ], 10: [ n6('2001:db8::10', M1), on(n6('2001:db8::10', M1), 'br-guest') ] };
	const [ one ] = calls([ call(t(1000, 5000), 0, { neigh: same }) ]);
	assert.deepEqual(one.reply.hosts, [ { mac: M1, rx: 2000, tx: 10000 } ]);
	/* once one interface alone holds the address: what passed since, not all of it */
	const [ , later ] = calls([ call(t(1000, 5000), 0, { neigh: two }), call(t(1100, 5500), 5000) ]);
	assert.deepEqual(later.reply.hosts, [ { mac: M1, rx: 200, tx: 1000 } ]);
});

test('traffic plugin: accounting off, no table, offloaded entries', { skip: NO_UCODE }, () => {
	const t = [ line(at(OUT, { ob: 1000, rb: 5000 })) ];
	const [ on, off, again ] = calls([ call(t, 0), call(t, 5000, { acct: '0\n' }), call(t, 10000) ]);
	assert.equal(on.reply.hosts.length, 1);
	assert.deepEqual([ off.reply.acct, off.reply.hosts, off.reply.entries, off.dumps ], [ false, [], 0, 0 ], 'switched off: the table is not read, nothing kept');
	assert.deepEqual(again.reply.hosts, [ { mac: M1, rx: 1000, tx: 5000 } ], 'on again: counted afresh');
	/* no switch to read: the entries decide */
	const [ bare ] = calls([ call([ line(at(OUT, { acct: false })) ], 0, { acct: null }) ]);
	assert.deepEqual([ bare.reply.acct, bare.reply.hosts, bare.reply.entries ], [ false, [], 1 ]);
	const [ known ] = calls([ call(t, 0, { acct: null }) ]);
	assert.equal(known.reply.acct, true);
	/* no connection tracking at all */
	const [ gone ] = calls([ call(null, 0, { acct: null }) ]);
	assert.deepEqual([ gone.reply.acct, gone.reply.hosts, gone.reply.entries ], [ null, [], 0 ]);
	const [ fl ] = calls([ call([ line(at(OUT, { ob: 1, rb: 1, offload: true })), line(at(SIX, { ob: 1, rb: 1, hw: true })), line(at(FWD, { ob: 1, rb: 1 })) ], 0) ]);
	assert.deepEqual([ fl.reply.offloaded, fl.reply.hw ], [ 1, 1 ]);
	assert.equal(fl.reply.hosts.length, 2, 'offloaded entries are counted all the same');
});

test('traffic plugin: at most 16384 entries a read and 512 hosts, nothing counted twice', { skip: NO_UCODE }, () => {
	const neigh = neighOf(300);
	const [ a, b, c ] = calls([ call(table(17000, 300, 0), 0, { neigh }), call(table(17000, 300, 1), 5000, { neigh }), call(table(17000, 300, 2), 10000, { neigh }) ]);
	assert.deepEqual([ a.reply.partial, a.reply.entries ], [ 'entries', 16384 ]);
	assert.deepEqual([ sum(b, 'rx') - sum(a, 'rx'), sum(b, 'tx') - sum(a, 'tx') ], [ 16384 * 100, 16384 * 1000 ], 'the entries read again add their growth only');
	assert.deepEqual([ sum(c, 'rx') - sum(b, 'rx'), sum(c, 'tx') - sum(b, 'tx') ], [ 16384 * 100, 16384 * 1000 ]);
	const [ many ] = calls([ call(table(4096, 600, 0), 0, { neigh: neighOf(600) }) ]);
	assert.equal(many.reply.hosts.length, 512);
	assert.ok(many.reply.dropped > 0);
	/* 600 hosts by IPv6 alone, three connections each: 88 left out, each counted once */
	const six = [], v6 = [];
	for (let h = 0; h < 600; h++) {
		const a = '2001:0db8:0000:0000:0000:0000:0001:' + h.toString(16).padStart(4, '0');
		v6.push(n6('2001:db8::1:' + h.toString(16), '02:00:5e:01:' + (h >> 8).toString(16).padStart(2, '0') + ':' + (h & 255).toString(16).padStart(2, '0')));
		for (let k = 0; k < 3; k++) six.push(line(at(SIX, { src: a, rdst: a, sport: 20000 + k, ob: 10, rb: 10 })));
	}
	const [ cut ] = calls([ call(six, 0, { neigh: { 2: [], 10: v6 } }) ]);
	assert.deepEqual([ cut.reply.hosts.length, cut.reply.dropped ], [ 512, 88 ], 'hosts, each once, however many entries it has');
});

test('traffic plugin: one read serves every caller for 5 s, 30 s with Low-power router', { skip: NO_UCODE }, () => {
	const t = [ line(at(OUT, { ob: 1000, rb: 5000 })) ];
	const r = calls([ call(t, 1000), call(t, 3000), call(t, 5499), call(t, 5500), call(t, 9999),
		call(t, 20000, { power: 'low' }), call(t, 35000, { power: 'low' }), call(t, 49499, { power: 'low' }), call(t, 49500, { power: 'low' }) ]);
	assert.deepEqual(r.map(x => x.reply.at), [ 1000, 1000, 1000, 5500, 5500, 20000, 20000, 20000, 49500 ],
		'a poll every 5 s gets a fresh read each time (the window less 500 ms for its jitter); every 30 s with Low-power router');
	assert.deepEqual(r.map(x => x.dumps), [ 2, 0, 0, 2, 0, 2, 0, 0, 2 ], 'a shared answer reads nothing');
	assert.deepEqual(r.map(x => [ x.reply.every, x.reply.low ]).filter((x, i) => [ 0, 5, 8 ].includes(i)), [ [ 5000, false ], [ 30000, true ], [ 30000, true ] ]);
	assert.equal(r[1].uci, 0, 'the Low-power option is read only for a read');
});

test('traffic plugin: the table is read for 2 s at most; a slow read lengthens the wait before the next', { skip: NO_UCODE }, () => {
	/* each look at the clock: 10 ms on. Two looks before the table, then one every 64 entries: the 199th is past 2 s */
	const big = table(16000, 100, 0), neigh = neighOf(100);
	const r = calls([ call(big, 0, { neigh, step: 10 }), call(big, 19000, { neigh, step: 10 }), call(big, 19600, { neigh, step: 10 }) ]);
	assert.deepEqual([ r[0].reply.partial, r[0].reply.entries ], [ 'time', 64 * 199 ]);
	assert.deepEqual([ r[0].reply.took, r[0].reply.slow, r[0].reply.every ], [ 2010, true, 2010 * 10 ], 'the next read 10 times as late: a tenth of one core');
	assert.equal(r[1].reply.at, 0, 'shared until then');
	assert.equal(r[2].reply.at, 19600, 'from its every less the 500 ms');
	/* entries a partial read did not reach: the next read that does counts their growth, not all they carried */
	const all = calls([ call(table(16000, 100, 0), 0, { neigh }), call(table(16000, 100, 1), 5000, { neigh, step: 10 }), call(table(16000, 100, 2), 30000, { neigh }) ]);
	assert.deepEqual(all.map(x => [ x.reply.partial, x.reply.entries ]), [ [ false, 16000 ], [ 'time', 12736 ], [ false, 16000 ] ]);
	assert.equal(sum(all[1], 'rx') - sum(all[0], 'rx'), 12736 * 100);
	assert.equal(sum(all[2], 'rx') - sum(all[1], 'rx'), 12736 * 100 + (16000 - 12736) * 200, 'the ones the partial read missed: what they added since the read before');
	/* fast reads: 5 s; never more than two minutes */
	const quick = calls([ call(big, 0, { neigh, step: 1 }) ]);
	assert.deepEqual([ quick[0].reply.partial, quick[0].reply.slow, quick[0].reply.every ], [ false, false, 5000 ]);
	const stuck = calls([ call(big, 0, { neigh, step: 13000 }) ]);
	assert.deepEqual([ stuck[0].reply.entries, stuck[0].reply.took, stuck[0].reply.every ], [ 64, 39000, 120000 ]);
});

/* ---------------------------------------- entries a read did not see */

/* The kernel lists the table by position, from the start again at every
   read() of about a page: an entry removed behind that place hides the
   next one from a read that is not partial. */
test('traffic plugin: an entry one whole read did not see counts its growth when one sees it again, not all it carried', { skip: NO_UCODE }, () => {
	const big = at(OUT, { ob: 1000000000, rb: 4000000000 }), other = at(NEW, { ob: 10, rb: 20 });
	const back = line(at(big, { ob: 1000000100, rb: 4000000500 }));
	const [ a, b, c ] = calls([ call([ line(big), line(other) ], 0), call([ line(other) ], 5000), call([ back, line(other) ], 10000) ]);
	assert.deepEqual([ of(a, M1), b.reply.partial ], [ { mac: M1, rx: 1000000000, tx: 4000000000 }, false ]);
	assert.deepEqual(of(c, M1), { mac: M1, rx: 1000000100, tx: 4000000500 }, 'counted once');
	/* the read before saw it: kept however long ago (no read while nobody
	   looks; here longer than KEEP_MS, shorter than a host's IDLE_MS) */
	const { KEEP_MS } = limits();
	const late = calls([ call([ line(big), line(other) ], 0), call([ line(other) ], 2 * KEEP_MS), call([ back, line(other) ], 2 * KEEP_MS + 5000) ]);
	assert.deepEqual(of(late[2], M1), { mac: M1, rx: 1000000100, tx: 4000000500 });
	/* then for KEEP_MS from the read that last saw it */
	const twice = calls([ call([ line(big), line(other) ], 0), call([ line(other) ], 5000), call([ line(other) ], KEEP_MS - 1), call([ back, line(other) ], KEEP_MS + 4999) ]);
	assert.deepEqual(of(twice[3], M1), { mac: M1, rx: 1000000100, tx: 4000000500 });
	const dir = setup(), flows = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8')).flows).length;
	const gone = calls([ call([ line(big), line(other) ], 0), call([ line(other) ], 5000), call([ line(other) ], KEEP_MS) ], dir);
	assert.equal(flows(), 1, 'not seen by the read before, not seen for KEEP_MS: ended');
	const [ again ] = calls([ call([ back, line(other) ], KEEP_MS + 5000) ], dir);
	assert.equal(of(again, M1).rx - of(gone[2], M1).rx, 1000000100, 'were it back, it would count whole: the limit');
	/* a new connection with the addresses and ports of one kept: smaller
	   counters count from 0, and are no reset by another program */
	const reuse = calls([ call([ line(big), line(other) ], 0), call([ line(other) ], 5000), call([ line(at(big, { ob: 300, rb: 700 })), line(other) ], 10000) ]);
	assert.deepEqual([ of(reuse[2], M1), reuse[2].reply.zeroed ], [ { mac: M1, rx: 1000000300, tx: 4000000700 }, 0 ]);
});

/* An entry the read before saw is kept whatever its size: a single miss
   by the kernel's listing costs nothing. Missed by two whole reads
   running, it is kept only from KEEP_BYTES both ways (or after a partial
   read: the time budget's test above, what it did not reach counts its
   growth whatever its size) */
test('traffic plugin: an entry one whole read missed counts once, whatever its size; a smaller one missed by two reads running, twice by less than KEEP_BYTES', { skip: NO_UCODE }, () => {
	const { KEEP_BYTES } = limits(), other = at(NEW, { ob: 10, rb: 20 }), q = KEEP_BYTES / 4;
	const missed = (ob, rb, reads) => {
		const list = [ call([ line(at(OUT, { ob, rb })), line(other) ], 0) ];
		for (let i = 1; i <= reads; i++) list.push(call([ line(other) ], 5000 * i));
		list.push(call([ line(at(OUT, { ob: ob + 100, rb: rb + 500 })), line(other) ], 5000 * (reads + 1)));
		return of(calls(list).pop(), M1);
	};
	for (const [ ob, rb ] of [ [ 1, 2 ], [ q, 3 * q - 1 ], [ q, 3 * q ] ])
		assert.deepEqual(missed(ob, rb, 1), { mac: M1, rx: ob + 100, tx: rb + 500 }, 'missed once: counted once, ' + (ob + rb) + ' bytes');
	assert.deepEqual(missed(q, 3 * q, 2), { mac: M1, rx: q + 100, tx: 3 * q + 500 }, 'twice running, KEEP_BYTES both ways: kept, counted once');
	assert.deepEqual(missed(q, 3 * q - 1, 2), { mac: M1, rx: 2 * q + 100, tx: 2 * (3 * q - 1) + 500 },
		'twice running, a byte less: forgotten, and what it had carried counted again, once: KEEP_BYTES - 1 at most');
	assert.deepEqual(missed(1, 2, 2), { mac: M1, rx: 2 + 100, tx: 4 + 500 }, 'a lookup: a few bytes twice');
});

test('traffic plugin: every entry the read before saw is kept, at the most entries a read takes, and the state is read back', { skip: NO_UCODE }, () => {
	/* a full table of IPv6 entries, then as many others: the first all
	   kept, 2 x 16384 entries, about 5 MiB of state (more than the 4 MiB
	   read back before) */
	const dir = setup(), neigh = neighOf(100);
	const v6 = (first, k) => {
		const out = [];
		for (let i = first; i < first + 16384; i++) {
			const a = '2001:0db8:0000:0000:0000:0000:0000:' + (i % 100 + 1).toString(16).padStart(4, '0'), b = '2001:0db8:ffff:ffff:ffff:ffff:ffff:' + (i % 65000 + 1).toString(16).padStart(4, '0');
			out.push(line({ v6: true, src: a, dst: b, sport: 1024 + i % 60000, dport: 443 + (i >> 16), ob: 4000000000 + i + k * 100, rsrc: b, rdst: a, rb: 4000000000 + i + k * 1000 }));
		}
		return out;
	};
	const [ a, b ] = calls([ call(v6(0, 0), 0, { neigh }), call(v6(16384, 0), 5000, { neigh }) ], dir);
	const st = fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8');
	assert.deepEqual([ a.reply.entries, b.reply.entries, b.reply.partial ], [ 16384, 16384, false ]);
	assert.equal(Object.keys(JSON.parse(st).flows).length, 2 * 16384);
	assert.ok(st.length > 4 << 20 && st.length <= limits().MAX_STATE, st.length);
	const [ c ] = calls([ call(v6(0, 1), 10000, { neigh }) ], dir);
	assert.deepEqual([ sum(c, 'rx') - sum(b, 'rx'), sum(c, 'tx') - sum(b, 'tx') ], [ 16384 * 100, 16384 * 1000 ], 'their growth, not all they carried');
	/* a third table: the first kept (the read before saw it), the second
	   (seen 10 s ago) has no room left: 16384 kept at most */
	const [ d ] = calls([ call(v6(32768, 0), 15000, { neigh }) ], dir);
	assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8')).flows).length, 2 * 16384);
	const [ e ] = calls([ call(v6(16384, 1), 20000, { neigh }) ], dir);
	assert.ok(sum(e, 'rx') - sum(d, 'rx') > 16384 * 4000000000, 'the second, no longer kept, counts whole again: what the cap costs');
});

test('traffic plugin: the largest state it can write is within MAX_STATE, and read back whole', { skip: NO_UCODE }, () => {
	const { MAX_STATE, MAX_ENTRIES, MAX_HOSTS } = limits();
	const dir = setup(), r = exec(dir, [ 'test-largest' ]);
	assert.equal(r.status, 0, r.stderr);
	const got = JSON.parse(r.out);
	assert.equal(got.saved, true);
	assert.ok(got.size <= MAX_STATE && got.size > MAX_STATE - 128, got.size + ' bytes of ' + MAX_STATE + ': within, and the bound no looser than its frame');
	assert.deepEqual([ got.flows, got.totals, got.before ], [ 2 * MAX_ENTRIES, MAX_HOSTS, 18446744073709551615 ]);
});

/* ------------------------------------------------- process and state */

test('traffic plugin: rpcd\'s list and call, and nothing else', { skip: NO_UCODE }, () => {
	const dir = setup();
	const list = exec(dir, [ 'list' ]);
	assert.deepEqual([ list.status, JSON.parse(list.out) ], [ 0, { hosts: {} } ], 'one method, which takes nothing');
	for (const argv of [ [], [ 'call' ], [ 'call', 'reset' ], [ 'call', 'Hosts' ], [ 'hosts' ] ]) {
		const r = exec(dir, argv);
		assert.deepEqual([ r.status, r.out ], [ 0, '' ], JSON.stringify(argv));
	}
	assert.ok(!fs.existsSync(path.join(dir, 'state')), 'nothing made for them');
});

test('traffic plugin: its state in a directory of its own, 0700, its files 0600, from one call to the next', { skip: NO_UCODE }, () => {
	const dir = setup();
	calls([ call([ line(at(OUT, { ob: 1, rb: 2 })) ], 0) ], dir);
	const state = path.join(dir, 'state');
	assert.equal(fs.statSync(state).mode & 0o777, 0o700);
	assert.deepEqual(fs.readdirSync(state).sort(), [ 'answer.json', 'lock', 'state.json' ]);
	for (const f of [ 'answer.json', 'lock', 'state.json' ]) assert.equal(fs.statSync(path.join(state, f)).mode & 0o777, 0o600, f);
	const st = JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
	assert.deepEqual(Object.keys(st).sort(), [ 'at', 'flows', 'totals', 'v' ]);
	assert.deepEqual([ st.v, st.at, st.totals ], [ 3, 0, { [M1]: [ 1, 2, 0 ] } ]);
	/* a state it wrote, up to MAX_STATE bytes, is counted on from; one that is
	   not its own, or larger: counted afresh, never trusted */
	const { MAX_STATE, MAX_KEY, MAX_HOSTS } = limits();
	const of1 = (flows, totals, x) => JSON.stringify(Object.assign({ v: 3, at: 0, flows: flows || {}, totals: totals || { [M1]: [ 1000000, 1000000, 5000 ] } }, x || {}));
	const pad = (text, n) => text.slice(0, -1) + ' '.repeat(n - text.length) + '}';
	const hosts = {};
	for (let h = 0; h <= MAX_HOSTS; h++) hosts['02:00:5e:00:' + (h >> 8).toString(16).padStart(2, '0') + ':' + (h & 255).toString(16).padStart(2, '0')] = [ 1, 1, 5000 ];
	const cases = [
		[ of1(), 1000005 ],
		[ of1(null, null, { at: undefined }), 1000005 ],
		[ of1({ k: [ 1.5, 2, 3 ] }), 1000005 ],
		[ pad(of1(), MAX_STATE), 1000005 ],
		[ pad(of1(), MAX_STATE + 1), 5 ],
		[ of1(null, null, { v: 1 }), 5 ],
		/* 1.2.1's, left in /var/run by an upgrade: its keys hold no zone, so
		   an entry in one would count whole once more beside them */
		[ of1(null, null, { v: 2 }), 5 ],
		[ of1({ '6src=192.0.2.10dst=203.0.113.5sport=40000dport=443': [ 4, 4, 0 ] }, null, { v: 2 }), 5 ],
		[ 'not json', 5 ],
		[ '[]', 5 ],
		/* entries it would not write: a read would stop at the first (not an
		   array), count from the others, join a count as text */
		[ of1({ k: 5 }), 5 ],
		[ of1({ k: [ 1, 2 ] }), 5 ],
		[ of1({ k: [ '1', 2, 3 ] }), 5 ],
		[ of1({ k: [ 1, 2, -3 ] }), 5 ],
		[ of1({ k: [ 1, 2, null ] }), 5 ],
		[ of1({ k: [ 1, 2, true ] }), 5 ],
		[ of1({ k: [ 1, 2, [ 3 ] ] }), 5 ],
		[ of1({ k: [ 1, 2, 3, 4 ] }), 5 ],
		[ of1({ [ 'k'.repeat(MAX_KEY + 1) ]: [ 1, 2, 3 ] }), 5 ],
		[ of1(null, { [M1]: [ '1000000', 1000000, 5000 ] }), 5 ],
		[ of1(null, { [M1]: [ 1000000, 1000000, 5000 ], 'not a MAC': [ 1, 2, 3 ] }), 5 ],
		[ of1(null, Object.assign({ [M1]: [ 1000000, 1000000, 5000 ] }, hosts)), 5 ],
		[ of1(null, null, { at: '5000' }), 5 ]
	];
	for (const [ text, rx ] of cases) {
		fs.writeFileSync(path.join(state, 'state.json'), text);
		fs.rmSync(path.join(state, 'answer.json'));
		const [ r ] = calls([ call([ line(at(OUT, { ob: 5, rb: 6 })) ], 5000) ], dir);
		assert.deepEqual(r.reply.hosts.find(h => h.mac === M1), { mac: M1, rx, tx: rx + 1 }, text.slice(0, 80) + ' (' + text.length + ' bytes)');
	}
	/* a broken answer: a new read */
	fs.writeFileSync(path.join(state, 'answer.json'), '{ "at": "soon" }');
	const [ again ] = calls([ call([ line(at(OUT, { ob: 7, rb: 9 })) ], 6000) ], dir);
	assert.equal(again.reply.at, 6000);
});

test('traffic plugin: a state directory it did not make is refused, and nothing is read or written', { skip: NO_UCODE }, () => {
	for (const [ make, uid ] of [
		[ d => { fs.mkdirSync(d, { mode: 0o755 }); fs.chmodSync(d, 0o755); } ],
		[ d => { const real = d + '-real'; fs.mkdirSync(real, { mode: 0o700 }); fs.symlinkSync(real, d); } ],
		[ d => fs.writeFileSync(d, 'a file') ],
		/* 0700, but another account's (on a router: not root's) */
		[ d => fs.mkdirSync(d, { mode: 0o700 }), process.getuid() + 1 ]
	]) {
		const dir = setup(null, uid), state = path.join(dir, 'state');
		make(state);
		const [ r ] = calls([ call([ line(at(OUT, { ob: 1, rb: 2 })) ], 0) ], dir);
		assert.deepEqual([ r.reply, r.dumps, r.uci ], [ {}, 0, 0 ]);
		if (fs.lstatSync(state).isDirectory()) assert.deepEqual(fs.readdirSync(state), []);
		if (fs.existsSync(state + '-real')) assert.deepEqual(fs.readdirSync(state + '-real'), []);
	}
});

test('traffic plugin: one read at a time; a call while one runs gets the last answer, or none', { skip: NO_UCODE }, () => {
	const dir = setup(), state = path.join(dir, 'state');
	const t = [ line(at(OUT, { ob: 1, rb: 2 })) ];
	/* the lock held by another process (a read running), through ucode's own flock */
	const holder = path.join(dir, 'hold.uc');
	fs.writeFileSync(holder, "'use strict';\nimport { open, readfile } from 'fs';\nlet l = open(LOCK, 'a');\nif (l.lock('xn') !== true) die('cannot lock');\n" +
		"exit(system(json(readfile(CMD))));\n");
	const run = argv => {
		fs.writeFileSync(path.join(dir, 'cmd.json'), JSON.stringify(argv));
		return spawnSync(UCODE, [ '-D', 'LOCK=' + path.join(state, 'lock'), '-D', 'CMD=' + path.join(dir, 'cmd.json'), holder ], { encoding: 'utf8' });
	};
	const plugin = [ UCODE, '-L', STUBS, '-D', 'STUB=' + path.join(dir, 'stub.json'), '-D', 'NOW=9000', '-D', 'STEP=0', '-D', 'INPUT=x', path.join(dir, 'plugin.uc'), 'call', 'hosts' ];
	fs.mkdirSync(state, { mode: 0o700 });
	fs.writeFileSync(path.join(dir, 'acct'), '1\n');
	fs.writeFileSync(path.join(dir, 'nf_conntrack'), t.join('\n') + '\n');
	fs.writeFileSync(path.join(dir, 'stub.json'), JSON.stringify({ neigh: NEIGH, power: null }));
	let r = run(plugin);
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), {}, 'no answer yet: none, and no wait');
	assert.ok(!fs.existsSync(path.join(state, 'state.json')), 'and no read beside the one running');
	/* an old answer: that one */
	calls([ call(t, 0) ], dir);
	r = run(plugin);
	assert.equal(JSON.parse(r.stdout).at, 0, 'the last answer while the read runs');
	/* free again: a new read */
	const [ next ] = calls([ call(t, 9000) ], dir);
	assert.equal(next.reply.at, 9000);
});

test('traffic plugin: no answer without the state it comes from, and nothing left beside a file it could not write', { skip: NO_UCODE }, () => {
	const dir = setup(), state = path.join(dir, 'state');
	/* state.json a directory: its text written, then not put in its place */
	fs.mkdirSync(state, { mode: 0o700 });
	fs.mkdirSync(path.join(state, 'state.json'));
	const [ none ] = calls([ call([ line(at(OUT, { ob: 1, rb: 2 })) ], 0) ], dir);
	assert.deepEqual(none.reply, {}, 'none yet: none');
	assert.deepEqual(fs.readdirSync(state).sort(), [ 'lock', 'state.json' ]);
	fs.rmdirSync(path.join(state, 'state.json'));
	calls([ call([ line(at(OUT, { ob: 1, rb: 2 })) ], 5000) ], dir);
	fs.renameSync(path.join(state, 'state.json'), path.join(state, 'kept.json'));
	fs.mkdirSync(path.join(state, 'state.json'));
	const [ failed ] = calls([ call([ line(at(OUT, { ob: 9, rb: 9 })) ], 10000) ], dir);
	assert.deepEqual(failed.reply, {}, 'none: not the last again, whose rates a dashboard would show as current');
	assert.deepEqual(fs.readdirSync(state).sort(), [ 'answer.json', 'kept.json', 'lock', 'state.json' ], 'no .new left');
	assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'answer.json'), 'utf8')).at, 5000, 'the answer of the last state written');
	/* written again: counted from the state the last answer came from */
	fs.rmdirSync(path.join(state, 'state.json'));
	fs.renameSync(path.join(state, 'kept.json'), path.join(state, 'state.json'));
	const [ next ] = calls([ call([ line(at(OUT, { ob: 9, rb: 9 })) ], 15000) ], dir);
	assert.deepEqual([ next.reply.at, of(next, M1) ], [ 15000, { mac: M1, rx: 9, tx: 9 } ]);
});

test('traffic plugin: a file that did not reach the disk whole does not take the place of the one before it', { skip: NO_UCODE }, () => {
	/* a full /tmp: writefile() counts what it handed over, and the last of
	   it fails to reach the file when that is closed. Here: 20 bytes of the
	   file named in the call, and the whole count */
	const WRITE = 'writefile(tmp, text) == length(text)';
	const src = fs.readFileSync(PLUGIN, 'utf8');
	assert.ok(src.includes(WRITE), 'the write in put()');
	const dir = setup(src.replace(WRITE, '(global.STUB.short == name ? (writefile(tmp, substr(text, 0, 20)), length(text)) : writefile(tmp, text)) == length(text)')), state = path.join(dir, 'state');
	const read = f => fs.readFileSync(path.join(state, f), 'utf8');
	/* two entries of one host; the second ends before the last read */
	const t = (ob, rb) => line(at(OUT, { ob, rb })), gone = line(at(LAN, { ob: 300, rb: 400 }));
	const [ first ] = calls([ call([ t(1000, 5000), gone ], 0) ], dir);
	assert.deepEqual(of(first, M1), { mac: M1, rx: 1300, tx: 5400 });
	const kept = read('state.json');
	/* the state: no answer, and the state before it stays */
	const [ none ] = calls([ call([ t(1500, 6000), gone ], 5000, { short: 'state.json' }) ], dir);
	assert.deepEqual(none.reply, {}, 'no answer without its state');
	assert.equal(read('state.json'), kept, 'the state before it, untouched');
	assert.deepEqual(fs.readdirSync(state).sort(), [ 'answer.json', 'lock', 'state.json' ], 'no .new left');
	/* the answer: given, and the file keeps the last one that was whole */
	const [ given ] = calls([ call([ t(1500, 6000), gone ], 10000, { short: 'answer.json' }) ], dir);
	assert.deepEqual(of(given, M1), { mac: M1, rx: 1800, tx: 6400 });
	assert.equal(JSON.parse(read('answer.json')).at, 0, 'the last answer written whole');
	assert.deepEqual(fs.readdirSync(state).sort(), [ 'answer.json', 'lock', 'state.json' ]);
	/* counted on from the state: the entry that ended is not lost with a restart */
	const [ next ] = calls([ call([ t(2000, 7000) ], 15000) ], dir);
	assert.deepEqual(of(next, M1), { mac: M1, rx: 2300, tx: 7400 });
});

test('traffic plugin: a module that cannot load ends the call with no answer and no state, in its own process', { skip: NO_UCODE }, () => {
	const dir = setup(), stubs = mkTmp('vantage-trafficmods-');
	fs.copyFileSync(path.join(STUBS, 'uci.uc'), path.join(stubs, 'uci.uc'));
	fs.writeFileSync(path.join(stubs, 'rtnl.uc'), "'use strict';\ndie('rtnl stand-in: cannot load');\n");
	fs.writeFileSync(path.join(dir, 'stub.json'), '{}');
	const r = spawnSync(UCODE, [ '-L', stubs, '-D', 'STUB=' + path.join(dir, 'stub.json'), '-D', 'NOW=0', '-D', 'STEP=0', path.join(dir, 'plugin.uc'), 'call', 'hosts' ], { encoding: 'utf8' });
	assert.notEqual(r.status, 0);
	assert.equal(r.stdout, '');
	assert.match(r.stderr, /rtnl stand-in: cannot load/);
	assert.ok(!fs.existsSync(path.join(dir, 'state')));
});

test('traffic plugin: compiles as ucode runs it; every regular expression is a module constant', { skip: NO_UCODE }, () => {
	const r = spawnSync(UCODE, [ '-L', STUBS, '-c', '-o', '/dev/null', PLUGIN ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(fs.readFileSync(PLUGIN, 'utf8').startsWith('#!/usr/bin/ucode -S\n'), 'rpcd runs it by its first line');
	assert.equal(fs.statSync(PLUGIN).mode & 0o111, 0o111, 'executable');
	const bad = [];
	fs.readFileSync(PLUGIN, 'utf8').split('\n').forEach((l, i) => {
		if (!i) return;
		const code = l.replace(/\/\/.*$/, '');
		if (/^const RE_[A-Z0-9_]+ = \//.test(code)) return;
		if (/(?:[(,=:!&|?]|\breturn)\s*\/(?![/*])/.test(code)) bad.push((i + 1) + ': ' + l.trim());
	});
	assert.deepEqual(bad, []);
});

/* ---------------------------------------------------------- benchmark */

/* dev/traffic/bench.uc runs on a router without the package: it carries
   the plugin's counting and state code, which must be the plugin's own */
test('traffic benchmark: its counting and state code is the plugin\'s, byte for byte', () => {
	const plugin = fs.readFileSync(PLUGIN, 'utf8'), bench = fs.readFileSync(BENCH, 'utf8');
	const block = (src, name) => {
		const m = new RegExp('^function ' + name + '\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}$', 'm').exec(src);
		assert.ok(m, name);
		return m[0];
	};
	for (const name of [ 'now_ms', 'count', 'kv', 'zone', 'parse', 'parse_slow', 'norm', 'add', 'feed', 'put', 'entry_ok', 'load_state', 'save_state' ]) assert.equal(block(bench, name), block(plugin, name), name);
	for (const c of [ 'MAX_ENTRIES', 'MAX_HOSTS', 'MAX_KEY', 'MAX_STATE', 'STOP_MS', 'CHECK_EVERY', 'KEEP_MS', 'KEEP_BYTES', 'PROTO', 'RE_MAC' ])
		assert.equal(new RegExp('^const ' + c + ' = [^\\n]*(\\n\\t[^\\n]*)*', 'm').exec(bench)[0], new RegExp('^const ' + c + ' = [^\\n]*(\\n\\t[^\\n]*)*', 'm').exec(plugin)[0], c);
	assert.doesNotMatch(bench, /^import .*'(rtnl|uci|ubus)'/m, 'only what a stock OpenWrt has: ucode and its fs module');
});

test('traffic benchmark: runs, writes only its own files and prints a line per size', { skip: NO_UCODE }, t => {
	const dir = mkTmp('vantage-trafficbench-');
	fs.writeFileSync(path.join(dir, 'kept'), 'x');
	const r = spawnSync(UCODE, [ BENCH, dir, '500', '2000' ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	const rows = r.stdout.split('\n').filter(l => /^\s*\d+ entries/.test(l));
	assert.equal(rows.length, 2, r.stdout);
	for (const l of r.stdout.trim().split('\n')) t.diagnostic(l.trim());
	/* a busy table: a fifth of it ends and begins again each read, a tenth of it large */
	const churn = spawnSync(UCODE, [ BENCH, dir, 'churn', '500', '20', '40', '10' ], { encoding: 'utf8' });
	assert.equal(churn.status, 0, churn.stderr);
	assert.match(churn.stdout, /^churn: 500 entries, 100 ended and begun a read, 40 reads 5 s apart, 10 % large: the state holds 880 entries/m,
		'those seen, the small ones the read before saw (90), and the large ones that ended less than KEEP_MS (150 s) ago: 10 a read, 29 reads');
	t.diagnostic(churn.stdout.trim());
	assert.deepEqual(fs.readdirSync(dir), [ 'kept' ], 'its files removed, nothing else touched');
	const bad = spawnSync(UCODE, [ BENCH, path.join(dir, 'no-such-dir') ], { encoding: 'utf8' });
	assert.notEqual(bad.status, 0);
});
