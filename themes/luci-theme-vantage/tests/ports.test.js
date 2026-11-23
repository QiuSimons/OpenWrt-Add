'use strict';
/* A DSA switch chip's own byte counters for its ports (#156): the app's
   executable rpcd plugin luci.vantage.ports, which runs ethtool -S on
   each of the device's DSA ports; model.switchCounters, which checks its
   answer; model.rates, which never takes a rate across two sources; and
   the view, which asks every poll in a request of its own, stops asking
   where the first answer says there is nothing to get, and counts a
   port by its chip where it has its counters.

   The plugin runs as rpcd runs it, a ucode process with the arguments
   rpcd passes and the call's JSON on its standard input, under a host
   ucode binary ($UCODE, else `ucode` on PATH; skipped otherwise). Its
   copy here reads a /sys/class/net written by the test and runs a fake
   ethtool, a shell script of the test's that logs its arguments and
   prints what the test put there for the port: the test swaps the two
   path constants (and the clock) in the copy's text, as the other plugin
   tests do. The shipped plugin takes neither from its environment or its
   arguments, so nothing here can redirect it on a device. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mkTmp = require('./tmpdir');
const { load, RES } = require('./luci-stub');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'luci-app-vantage/root/usr/libexec/rpcd/luci.vantage.ports');
const model = load('vantage.model');

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
function ucodeArgs() {
	const lib = UCODE && path.join(path.dirname(UCODE), '../lib/ucode');
	return lib && fs.existsSync(lib) ? [ '-L', lib ] : [];
}

const CLOCK_FN = 'function now_ms() {\n\tlet t = clock(true);\n\treturn t[0] * 1000 + int(t[1] / 1000000);\n}';

/* ethtool -S as the kernel's DSA core makes it: its four counters of the CPU's path first, then the driver's */
const nic = (pairs, core) => 'NIC statistics:\n' + (core === false ? [] : [ [ 'tx_packets', 10 ], [ 'tx_bytes', 1000 ], [ 'rx_packets', 20 ], [ 'rx_bytes', 2000 ] ])
	.concat(pairs).map(([ k, v ]) => '     ' + k + ': ' + v + '\n').join('');
const MT7530 = (rx, tx) => nic([ [ 'TxDrop', 0 ], [ 'TxCrcErr', 0 ], [ 'TxUnicast', 5 ], [ 'TxBytes', tx ], [ 'RxDrop', 0 ], [ 'RxUnicast', 7 ], [ 'RxBytes', rx ], [ 'RxCtrlDrop', 0 ] ]);

/* A directory with the plugin's copy, a /sys/class/net and the fake
   ethtool. o.ports: { name: uevent text } (a DSA port's by default);
   o.out: { port: what ethtool prints }; o.code: { port: its exit code };
   o.ethtool: false for none, 'plain' for a file that is not executable;
   o.sleep: { port: s ethtool waits before it prints, then notes the port in slept };
   o.step: ms the copy's clock moves at each reading. The copy locks itself (SELF) */
function setup(o) {
	o = o || {};
	const dir = mkTmp('vantage-ports-');
	assert.match(dir, /^[A-Za-z0-9_/.-]+$/, 'a path the copy can hand to /bin/sh as it is');
	const net = path.join(dir, 'net'), bin = path.join(dir, 'bin', 'ethtool');
	fs.mkdirSync(net);
	fs.mkdirSync(path.join(dir, 'bin'));
	fs.mkdirSync(path.join(dir, 'out'));
	fs.mkdirSync(path.join(dir, 'code'));
	fs.mkdirSync(path.join(dir, 'sleep'));
	for (const [ port, sec ] of Object.entries(o.sleep || {})) fs.writeFileSync(path.join(dir, 'sleep', port), String(sec));
	for (const [ name, uevent ] of Object.entries(o.ports || {})) {
		fs.mkdirSync(path.join(net, name));
		fs.writeFileSync(path.join(net, name, 'uevent'), uevent == null ? 'DEVTYPE=dsa\nINTERFACE=' + name + '\nIFINDEX=9\n' : uevent);
	}
	for (const [ port, text ] of Object.entries(o.out || {})) fs.writeFileSync(path.join(dir, 'out', port), text);
	for (const [ port, code ] of Object.entries(o.code || {})) fs.writeFileSync(path.join(dir, 'code', port), String(code));
	if (o.ethtool !== false) {
		fs.writeFileSync(bin, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> \'' + dir + '/calls\'\n[ "$#" -eq 2 ] && [ "$1" = -S ] || exit 64\n' +
			'[ -f \'' + dir + '/sleep/\'"$2" ] && { sleep "$(cat \'' + dir + '/sleep/\'"$2")"; printf \'%s\\n\' "$2" >> \'' + dir + '/slept\'; }\n' +
			'[ -f \'' + dir + '/out/\'"$2" ] || exit 1\ncat \'' + dir + '/out/\'"$2" && printf \'%s\\n\' "$2" >> \'' + dir + '/finished\'\n' +
			'[ -f \'' + dir + '/code/\'"$2" ] && exit "$(cat \'' + dir + '/code/\'"$2")"\nexit 0\n', { mode: o.ethtool === 'plain' ? 0o644 : 0o755 });
	}
	let src = fs.readFileSync(PLUGIN, 'utf8');
	for (const [ from, to ] of [
		[ /^const NET = .*$/m, 'const NET = ' + JSON.stringify(net) + ';' ],
		[ /^const ETHTOOL = .*$/m, 'const ETHTOOL = ' + JSON.stringify(bin) + ';' ],
		[ /^const SELF = .*$/m, 'const SELF = ' + JSON.stringify(path.join(dir, 'plugin.uc')) + ';' ],
		[ CLOCK_FN, 'let ticks = 0;\nfunction now_ms() {\n\treturn ' + o.step + ' * ticks++;\n}' ]
	].slice(0, o.step == null ? 3 : 4)) {
		const next = src.replace(from, () => to);
		assert.notEqual(next, src, 'the test can change ' + from);
		src = next;
	}
	fs.writeFileSync(path.join(dir, 'plugin.uc'), src);
	return dir;
}
/* the copy run as rpcd runs it: what it printed, the arguments the fake ethtool was given (a run a line) and the ports
   whose output it wrote out whole (finished: the plugin read on to its end) */
function exec(dir, argv, input) {
	const r = spawnSync(UCODE, ucodeArgs().concat([ path.join(dir, 'plugin.uc') ], argv), { cwd: dir, encoding: 'utf8', timeout: 30000, input: input == null ? '{ "ubus_rpc_session": "x" }' : input });
	assert.equal(r.status, 0, r.stderr);
	const lines = f => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) : [];
	return { out: r.stdout, calls: lines('calls'), finished: lines('finished') };
}
/* a call's answer, each port's read time (at: ms on the monotonic clock, every port has one) taken out into ats */
function counters(o, input) {
	const r = exec(setup(o), [ 'call', 'counters' ], input), a = JSON.parse(r.out), ats = {};
	for (const [ n, p ] of Object.entries(a.ports)) {
		assert.ok(Number.isInteger(p.at) && p.at >= 0, n + ': its read time');
		ats[n] = p.at;
		delete p.at;
	}
	return Object.assign(a, { calls: r.calls, finished: r.finished, ats });
}
const lines = (dir, f) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean) : [];
async function until(what, ok) {
	for (let i = 0; i < 300 && !ok(); i++) await new Promise(r => setTimeout(r, 20));
	assert.ok(ok(), what);
}
const without = (r, ...keys) => { const c = Object.assign({}, r); for (const k of keys) delete c[k]; return c; };

/* ------------------------------------------------------------ plugin */

test('plugin: rpcd\'s list names one method that takes nothing, and starts no program', { skip: NO_UCODE }, () => {
	const dir = setup({ ports: { lan1: null }, out: { lan1: MT7530(1, 2) } });
	const r = exec(dir, [ 'list' ]);
	assert.equal(r.out, '{ "counters": {} }\n');
	assert.deepEqual(JSON.parse(r.out), { counters: {} });
	assert.deepEqual(r.calls, []);
	/* any other method rpcd could not have registered: nothing printed, nothing run */
	assert.deepEqual(exec(dir, [ 'call', 'port' ]), { out: '', calls: [], finished: [] });
	assert.deepEqual(exec(dir, []), { out: '', calls: [], finished: [] });
});

test('plugin: mt7530\'s counters, not the four of the CPU\'s path the DSA core puts first; whatever the call carries', { skip: NO_UCODE }, () => {
	const o = { ports: { lan1: null, lan2: null, wan: null, eth0: 'INTERFACE=eth0\nIFINDEX=2\n', 'br-lan': 'DEVTYPE=bridge\nINTERFACE=br-lan\nIFINDEX=7\n' },
		out: { lan1: MT7530(74382564128, 131657591122), lan2: MT7530(0, 0), wan: MT7530(5, 6) } };
	const r = counters(o);
	assert.deepEqual(without(r, 'took', 'finished', 'ats'), {
		v: 1, state: 'ok', more: false, calls: [ '-S lan1', '-S lan2', '-S wan' ],
		ports: { lan1: { rx_bytes: 74382564128, tx_bytes: 131657591122 }, lan2: { rx_bytes: 0, tx_bytes: 0 }, wan: { rx_bytes: 5, tx_bytes: 6 } }
	});
	assert.equal(typeof r.took, 'number');
	/* the arguments rpcd writes to its standard input, a port's name among them, change nothing */
	for (const input of [ '{ "port": "-x", "ubus_rpc_session": "x" }', '{ "name": "eth0; reboot" }', '' ])
		assert.deepEqual(without(counters(o, input), 'took', 'finished', 'ats'), without(r, 'took', 'finished', 'ats'), input);
});

test('plugin: each verified driver\'s pair of names; the first pair found counts', { skip: NO_UCODE }, () => {
	const rows = {
		qca: nic([ [ 'RxBroad', 1 ], [ 'RxGoodByte', 300 ], [ 'RxBadByte', 7 ], [ 'TxByte', 400 ], [ 'TXUnicast', 3 ] ]),
		mv: nic([ [ 'in_good_octets', 500 ], [ 'in_bad_octets', 9 ], [ 'out_octets', 600 ], [ 'out_octets_a', 1 ] ]),
		b53: nic([ [ 'TxOctets', 800 ], [ 'TxDropPkts', 0 ], [ 'RxOctets', 700 ], [ 'RxGoodOctets', 650 ] ]),
		gswip: nic([ [ 'Rx64BytePkts', 1 ], [ 'RxGoodBytes', 900 ], [ 'RxBadBytes', 1 ], [ 'TxGoodBytes', 1000 ] ]),
		rtl: nic([ [ 'IfInOctets', 1100 ], [ 'EtherStatsOctets', 9 ], [ 'IfOutOctets', 1200 ] ]),
		/* two pairs printed: the table's order decides */
		both: nic([ [ 'RxOctets', 1 ], [ 'TxOctets', 2 ], [ 'RxBytes', 3 ], [ 'TxBytes', 4 ] ])
	};
	const r = counters({ ports: Object.fromEntries(Object.keys(rows).map(k => [ k, null ])), out: rows });
	assert.deepEqual(r.ports, {
		b53: { rx_bytes: 700, tx_bytes: 800 }, both: { rx_bytes: 3, tx_bytes: 4 }, gswip: { rx_bytes: 900, tx_bytes: 1000 },
		mv: { rx_bytes: 500, tx_bytes: 600 }, qca: { rx_bytes: 300, tx_bytes: 400 }, rtl: { rx_bytes: 1100, tx_bytes: 1200 }
	});
});

test('plugin: names it does not know, half a pair, a name twice or a number too long: unknown, never the CPU\'s counters', { skip: NO_UCODE }, () => {
	const out = {
		/* rtl8365mb, felix, ...: drivers that give the kernel the chip's counters already */
		other: nic([ [ 'ifInOctets', 5 ], [ 'ifOutOctets', 6 ], [ 'rx_octets', 7 ], [ 'tx_octets', 8 ] ]),
		core: nic([]),
		half: nic([ [ 'RxBytes', 5 ] ]),
		twice: nic([ [ 'RxBytes', 5 ], [ 'TxBytes', 6 ], [ 'RxBytes', 7 ] ]),
		long: nic([ [ 'RxBytes', '18446744073709551615' ], [ 'TxBytes', 6 ] ]),
		junk: 'NIC statistics:\n     RxBytes 5\n\tTxBytes: 6\nRxBytes: x\n',
		spaced: nic([ [ 'RxBytes ', 5 ], [ 'TxBytes', 6 ] ])
	};
	const r = counters({ ports: Object.fromEntries(Object.keys(out).map(k => [ k, null ])), out });
	assert.deepEqual(r.state, 'ok');
	for (const k of Object.keys(out)) assert.deepEqual(r.ports[k], { error: 'unknown' }, k);
});

test('plugin: ethtool missing or not executable: no program started, and the answer says so', { skip: NO_UCODE }, () => {
	for (const ethtool of [ false, 'plain' ]) {
		const r = counters({ ports: { lan1: null, lan2: null }, out: { lan1: MT7530(1, 2) }, ethtool });
		assert.deepEqual(without(r, 'took', 'ats'), { v: 1, state: 'no-ethtool', more: false, ports: {}, calls: [], finished: [] }, String(ethtool));
	}
});

test('plugin: no DSA port: no program started, whatever else the device has', { skip: NO_UCODE }, () => {
	for (const ports of [ {}, { eth0: 'INTERFACE=eth0\nIFINDEX=2\n', 'br-lan': 'DEVTYPE=bridge\nINTERFACE=br-lan\n', 'phy0-ap0': 'DEVTYPE=wlan\nINTERFACE=phy0-ap0\n',
		/* a line that only holds the word, and a uevent past what is read */
		lan9: 'xDEVTYPE=dsa\nDEVTYPE=dsax\n DEVTYPE=dsa\n', lan8: 'INTERFACE=lan8\n' + 'X'.repeat(600) + '\nDEVTYPE=dsa\n' } ]) {
		const r = counters({ ports, out: { eth0: MT7530(1, 2), lan9: MT7530(1, 2), lan8: MT7530(1, 2) } });
		assert.deepEqual(without(r, 'took', 'ats'), { v: 1, state: 'none', more: false, ports: {}, calls: [], finished: [] }, Object.keys(ports).join());
	}
});

test('plugin: ethtool failing, printing something else, nothing, or far too much: failed, never part of it', { skip: NO_UCODE }, () => {
	/* a megabyte: more than the plugin reads and a pipe holds together, so ethtool cannot finish writing it */
	const lots = nic([ [ 'RxBytes', 5 ], [ 'TxBytes', 6 ] ]) + Array.from({ length: 60000 }, (_, i) => '     filler_' + i + ': ' + i + '\n').join('');
	assert.ok(lots.length > 1 << 20);
	const r = counters({
		ports: { exit1: null, garbage: null, empty: null, lots: null, gone: null, signalled: null, ok: null },
		out: { exit1: MT7530(1, 2), garbage: 'Cannot get stats strings information: Operation not supported\n', empty: '', lots, signalled: MT7530(1, 2), ok: MT7530(1, 2) },
		/* gone: no output file, the fake exits 1 as ethtool does for a device that went away */
		code: { exit1: 1, signalled: 141 }
	});
	assert.deepEqual(r.ports, {
		empty: { error: 'failed' }, exit1: { error: 'failed' }, garbage: { error: 'failed' }, gone: { error: 'failed' },
		lots: { error: 'failed' }, ok: { rx_bytes: 1, tx_bytes: 2 }, signalled: { error: 'failed' }
	});
	assert.equal(r.state, 'ok');
	assert.equal(r.calls.length, 7, 'each port once');
	/* the plugin stops reading at its cap: the run that prints a megabyte never gets to write it all */
	assert.ok(r.finished.includes('ok') && !r.finished.includes('lots'), r.finished.join());
});

test('plugin: a port name on disk that could be read as an option or a shell word never reaches ethtool', { skip: NO_UCODE }, () => {
	const hostile = [ '-S', '--help', '-lan1', 'lan1;touch PWNED', 'lan 1', '$(touch PWNED)', '`touch PWNED`', 'a|b', 'a&b', 'a>PWNED',
		'lan1\'', 'lan1"', 'a\\b', 'a*', '[a]', '~root', 'lan1\ntouch PWNED', 'a.b', '..x', 'x'.repeat(16), 'län1', '#x' ];
	const ports = Object.fromEntries(hostile.map(n => [ n, null ]).concat([ [ 'lan1', null ], [ 'lan-2', null ], [ 'port_3', null ] ]));
	const out = Object.fromEntries(hostile.map(n => [ n.replace(/\//g, '_'), MT7530(1, 2) ]).filter(([ n ]) => !n.includes('\n')).concat([ [ 'lan1', MT7530(1, 2) ], [ 'lan-2', MT7530(3, 4) ], [ 'port_3', MT7530(5, 6) ] ]));
	const dir = setup({ ports, out });
	const r = exec(dir, [ 'call', 'counters' ]), a = JSON.parse(r.out);
	assert.deepEqual(Object.keys(a.ports), [ 'lan-2', 'lan1', 'port_3' ]);
	assert.deepEqual(r.calls, [ '-S lan-2', '-S lan1', '-S port_3' ]);
	/* the copy runs in dir: whatever a name made the shell do would land there */
	assert.deepEqual(fs.readdirSync(dir).filter(f => /PWNED/.test(f)), [], 'nothing the names say was run');
});

test('plugin: at most 32 ports, in name order; more says there were others', { skip: NO_UCODE }, () => {
	const names = Array.from({ length: 40 }, (_, i) => 'lan' + String(i).padStart(2, '0'));
	const r = counters({ ports: Object.fromEntries(names.map(n => [ n, null ])), out: Object.fromEntries(names.map((n, i) => [ n, MT7530(i, i) ])) });
	assert.deepEqual(Object.keys(r.ports), names.slice(0, 32));
	assert.equal(r.more, true);
	assert.deepEqual(r.calls, names.slice(0, 32).map(n => '-S ' + n));
	assert.equal(counters({ ports: { lan1: null }, out: { lan1: MT7530(1, 2) } }).more, false);
});

test('plugin: after its time budget no port is read; the rest are said to be left out', { skip: NO_UCODE }, () => {
	const names = [ 'lan1', 'lan2', 'lan3', 'lan4', 'lan5' ];
	const o = { ports: Object.fromEntries(names.map(n => [ n, null ])), out: Object.fromEntries(names.map((n, i) => [ n, MT7530(i, i) ])) };
	/* the clock moves 400 ms at each reading: the start, then one before each port (400, 800, 1200 ...) */
	const r = counters(Object.assign({ step: 400 }, o));
	assert.deepEqual(r.ports, { lan1: { rx_bytes: 0, tx_bytes: 0 }, lan2: { rx_bytes: 1, tx_bytes: 1 }, lan3: { error: 'time' }, lan4: { error: 'time' }, lan5: { error: 'time' } });
	assert.deepEqual(r.calls, [ '-S lan1', '-S lan2' ]);
	assert.equal(r.took, 400 * 6);
	/* each port's time is the reading just before its ethtool, not the call's start */
	assert.deepEqual(r.ats, { lan1: 400, lan2: 800, lan3: 1200, lan4: 1600, lan5: 2000 });
	/* a budget spent before the first port: none read, and still an answer */
	assert.deepEqual(counters(Object.assign({ step: 1000 }, o)).calls, []);
});

test('plugin: one read at a time: a call that finds the lock held answers busy at once and starts nothing', { skip: NO_UCODE }, async () => {
	const o = { ports: { lan1: null, lan2: null }, out: { lan1: MT7530(1, 2), lan2: MT7530(3, 4) } };
	const dir = setup(o), held = path.join(dir, 'held');
	/* another process holds the lock on the plugin's file, as a call that is reading does */
	const holder = require('child_process').spawn(UCODE, ucodeArgs().concat([ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(path.join(dir, 'plugin.uc')) +
		', "r"); f.lock("x"); writefile(' + JSON.stringify(held) + ', "1"); sleep(1500);' ]), { stdio: 'ignore' });
	await until('the lock is held', () => fs.existsSync(held));
	const t = Date.now(), busy = exec(dir, [ 'call', 'counters' ]);
	assert.ok(Date.now() - t < 1000, 'answered at once, not after the holder');
	assert.deepEqual(without(JSON.parse(busy.out), 'took'), { v: 1, state: 'busy', more: false, ports: {} });
	assert.deepEqual(busy.calls, [], 'no program started');
	await new Promise(r => holder.once('exit', r));
	const ok = exec(dir, [ 'call', 'counters' ]);
	assert.deepEqual([ JSON.parse(ok.out).state, ok.calls ], [ 'ok', [ '-S lan1', '-S lan2' ] ], 'free again once the holder is gone');
	/* the plugin's file opened for reading: not written, not even touched */
	const before = fs.statSync(path.join(dir, 'plugin.uc'));
	exec(dir, [ 'call', 'counters' ]);
	assert.deepEqual([ fs.statSync(path.join(dir, 'plugin.uc')).mtimeMs, fs.statSync(path.join(dir, 'plugin.uc')).size ], [ before.mtimeMs, before.size ]);
});

test('plugin: the lock goes with a call rpcd kills, and stays while that call\'s ethtool still runs', { skip: NO_UCODE }, async () => {
	const dir = setup({ ports: { lan1: null, lan2: null }, out: { lan1: MT7530(1, 2), lan2: MT7530(3, 4) }, sleep: { lan1: 2 } });
	const call = () => require('child_process').spawn(UCODE, ucodeArgs().concat([ path.join(dir, 'plugin.uc'), 'call', 'counters' ]), { cwd: dir, stdio: 'ignore' });
	/* a call whose ethtool hangs (here: sleeps 2 s), killed as rpcd kills one after its timeout */
	const a = call();
	await until('its ethtool runs', () => lines(dir, 'calls').length === 1);
	const gone = new Promise(r => a.once('exit', r));
	a.kill('SIGKILL');
	await gone;
	/* the shell and ethtool it started hold the lock: no second ethtool meanwhile */
	assert.deepEqual([ JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, lines(dir, 'calls') ], [ 'busy', [ '-S lan1' ] ]);
	await until('that ethtool ended', () => lines(dir, 'slept').length === 1);
	await until('the lock is free', () => JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state === 'ok');
	/* a call killed with nothing of its own left running frees the lock at once */
	fs.unlinkSync(path.join(dir, 'sleep', 'lan1'));
	const held = path.join(dir, 'held');
	const holder = require('child_process').spawn(UCODE, ucodeArgs().concat([ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(path.join(dir, 'plugin.uc')) +
		', "r"); f.lock("xn"); writefile(' + JSON.stringify(held) + ', "1"); sleep(30000);' ]), { stdio: 'ignore' });
	await until('the lock is held', () => fs.existsSync(held));
	assert.equal(JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, 'busy');
	const killed = new Promise(r => holder.once('exit', r));
	holder.kill('SIGKILL');
	await killed;
	assert.equal(JSON.parse(exec(dir, [ 'call', 'counters' ]).out).state, 'ok');
});

/* ------------------------------------------------------------- model */

test('model: switchCounters keeps the counters of well-formed ports and says when there is nothing to ask for', () => {
	const ok = model.switchCounters({ v: 1, state: 'ok', took: 12, more: false, ports: {
		lan1: { rx_bytes: 5, tx_bytes: 6, at: 7000 }, lan2: { error: 'unknown', at: 7001 }, lan3: { error: 'failed' }, lan4: { error: 'time' },
		'bad name': { rx_bytes: 1, tx_bytes: 1, at: 7000 }, lan5: { rx_bytes: -1, tx_bytes: 1, at: 7000 }, lan6: { rx_bytes: '5', tx_bytes: 6, at: 7000 }, lan7: 'x',
		/* a reading without its time (when the device read it) is none: rated by when it came in, it would be wrong */
		lan8: { rx_bytes: 5, tx_bytes: 6 }, lan9: { rx_bytes: 5, tx_bytes: 6, at: -1 }, lan10: { rx_bytes: 5, tx_bytes: 6, at: '7000' } } });
	assert.deepEqual(JSON.parse(JSON.stringify(ok)), { state: 'ok', counters: { lan1: { rx: 5, tx: 6, at: 7000 } }, none: false });
	assert.equal(Object.getPrototypeOf(ok.counters), null);
	/* nothing to get: no DSA port, no ethtool, every port read with names the plugin does not know */
	assert.equal(model.switchCounters({ v: 1, state: 'none', ports: {} }).none, true);
	assert.equal(model.switchCounters({ v: 1, state: 'no-ethtool', ports: {} }).none, true);
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: { lan1: { error: 'unknown' }, lan2: { error: 'unknown' }, lan3: { error: 'time' } } }).none, true);
	/* asked and failed is not nothing: ethtool may answer next time */
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: { lan1: { error: 'unknown' }, lan2: { error: 'failed' } } }).none, false);
	assert.equal(model.switchCounters({ v: 1, state: 'ok', ports: { lan1: { error: 'time' } } }).none, false);
	for (const junk of [ null, {}, 'x', [ 1 ], { v: 2, state: 'ok', ports: {} }, { v: 1, state: 'later', ports: {} } ])
		assert.equal(model.switchCounters(junk), null, JSON.stringify(junk));
	/* another call was reading: no answer this time, as a failed call, never "nothing to get" */
	assert.equal(model.switchCounters({ v: 1, state: 'busy', took: 0, more: false, ports: {} }), null);
	/* the plugin's own cap */
	const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [ 'p' + i, { rx_bytes: i, tx_bytes: i, at: 7000 } ]));
	assert.equal(Object.keys(model.switchCounters({ v: 1, state: 'ok', ports: many }).counters).length, 32);
});

test('model: rates never take a rate across two sources; a key whose source changed starts over', () => {
	const a = model.rates(null, { lan1: { rx: 0, tx: 0, src: 'switch' }, eth0: { rx: 0, tx: 0 } }, 0);
	const b = model.rates(a.next, { lan1: { rx: 5000, tx: 1000, src: 'switch' }, eth0: { rx: 500, tx: 0 } }, 5000);
	assert.deepEqual([ b.rates.lan1, b.rates.eth0 ], [ { rx: 8000, tx: 1600 }, { rx: 800, tx: 0 } ]);
	/* the chip's counters stayed out: the kernel's, far lower, are no rate against them */
	const c = model.rates(b.next, { lan1: { rx: 10, tx: 10 } }, 10000);
	assert.equal(c.rates.lan1, undefined);
	/* and back: the chip's again are no rate against the kernel's */
	const d = model.rates(c.next, { lan1: { rx: 20000, tx: 2000, src: 'switch' } }, 15000);
	assert.equal(d.rates.lan1, undefined);
	const e = model.rates(d.next, { lan1: { rx: 25000, tx: 3000, src: 'switch' } }, 20000);
	assert.deepEqual(e.rates.lan1, { rx: 8000, tx: 1600 });
});

test('model: a chip\'s counters at a steady rate give that rate, however late each reading came in (the reviewer\'s case)', () => {
	/* 19 Mbit/s on a port, read every 5 s on the device's clock; the answers came in alternately 0.1 s and 1.5 s after their poll */
	let prev = null;
	const got = [];
	for (let k = 0; k < 8; k++) {
		const read = 5000 * k, came = 1.8e12 + 5000 * k + (k % 2 ? 1500 : 100), bytes = 19e6 / 8 * read / 1000;
		const r = model.rates(prev, { lan1: { rx: bytes, tx: bytes, src: 'switch', at: 9e6 + read } }, came);
		prev = r.next;
		if (k) got.push(r.rates.lan1.rx);
	}
	assert.deepEqual(got, Array(7).fill(19e6));
	/* a key without its own time keeps the poll's, as every other counter does */
	const a = model.rates(null, { eth0: { rx: 0, tx: 0 } }, 1000), b = model.rates(a.next, { eth0: { rx: 1000, tx: 0 } }, 6000);
	assert.deepEqual(b.rates.eth0, { rx: 1600, tx: 0 });
});

test('model: a device clock that went back (the router started again) starts a chip\'s port over, then rates it again', () => {
	const at = (prev, rx, t) => model.rates(prev, { lan1: { rx, tx: 0, src: 'switch', at: t } }, 1.8e12 + t);
	const a = at(null, 5e9, 9e6), b = at(a.next, 5e9 + 625000, 9e6 + 5000);
	assert.equal(b.rates.lan1.rx, 1e6);
	/* the router restarted: its monotonic clock and the chip's counters from near zero */
	const c = at(b.next, 1000, 30000);
	assert.equal(c.rates.lan1, undefined, 'no rate across the restart');
	assert.equal(c.next.lan1.at, 30000, 'the new reading is the base');
	const d = at(c.next, 1000 + 625000, 35000);
	assert.equal(d.rates.lan1.rx, 1e6, 'and the next is rated');
});

/* ------------------------------------------------------------- view */

const REPLIES = {};
function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: { active() { return true; } }, ui: {}, dom: {}
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}
const view = loadView();

/* askSwitch with the test's timers: c.reply() answers a call (null: it stays out until the test settles it, c.out) */
async function switchCalls(fn) {
	const saved = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
	const c = { asked: 0, timers: [], seq: 0, out: [], reply: null };
	global.setTimeout = (f, ms) => { const id = ++c.seq; c.timers.push({ id, f, ms }); return id; };
	global.clearTimeout = id => { c.timers = c.timers.filter(x => x.id !== id); };
	c.flush = () => new Promise(r => setImmediate(r));
	c.fire = async () => { const due = c.timers; c.timers = []; due.forEach(x => x.f()); await c.flush(); };
	REPLIES['luci.vantage.ports counters'] = () => { c.asked++; return c.reply ? c.reply() : new Promise((resolve, reject) => c.out.push({ resolve, reject })); };
	c.self = Object.create(view);
	c.ask = async () => { const box = [ undefined ]; c.self.askSwitch().then(v => { box[0] = v; }); await c.flush(); return box; };
	try { await fn(c); }
	finally {
		Object.assign(global, saved);
		delete REPLIES['luci.vantage.ports counters'];
	}
}
/* the plugin's answer: a port with counters read at 7000 ms on the device's clock */
const answer = ports => () => Promise.resolve({ v: 1, state: 'ok', took: 9, more: false,
	ports: Object.fromEntries(Object.entries(ports).map(([ n, p ]) => [ n, p.rx_bytes != null ? Object.assign({ at: 7000 }, p) : p ])) });

test('view: asked every poll while the first answer had counters, whatever later ones say', () => switchCalls(async c => {
	c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
	assert.deepEqual(JSON.parse(JSON.stringify((await c.ask())[0])), { state: 'ok', counters: { lan1: { rx: 1, tx: 2, at: 7000 } }, none: false });
	c.reply = answer({ lan1: { error: 'unknown' } });
	for (let i = 0; i < 3; i++) assert.equal((await c.ask())[0].none, true);
	assert.equal(c.asked, 4, 'decided by the first answer only');
	/* a call that failed is asked again */
	c.reply = () => Promise.reject(new Error('XHR request timed out'));
	assert.equal((await c.ask())[0], null);
	assert.equal((await c.ask())[0], null);
	assert.equal(c.asked, 6);
	assert.equal(c.timers.length, 0, 'no deadline left behind');
}));

test('view: once it has answered, no later answer ends the asking: not a missing object, a refusal or nothing to get', () => switchCalls(async c => {
	const absent = msg => () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with ' + msg));
	const none = state => () => Promise.resolve({ v: 1, state, took: 0, more: false, ports: {} });
	const later = [ absent('error -32000: Object not found'), absent('error -32002: Access denied'), absent('ubus code 4: Resource not found'),
		absent('ubus code 3: Method not found'), none('none'), none('no-ethtool'), answer({ lan1: { error: 'unknown' } }) ];
	c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
	await c.ask();
	/* rpcd reloading after a package install: its objects gone for a moment, then back */
	for (const reply of later) {
		c.reply = reply;
		await c.ask();
		c.reply = answer({ lan1: { rx_bytes: 3, tx_bytes: 4 } });
		assert.deepEqual((await c.ask())[0].counters.lan1, { rx: 3, tx: 4, at: 7000 }, 'asked again after ' + reply);
	}
	assert.equal(c.asked, 1 + 2 * later.length);
}));

test('view: the first answer that says there is nothing to get, or no object, ends the asking for the page', () => switchCalls(async c => {
	for (const [ what, reply ] of [
		[ 'no DSA port', () => Promise.resolve({ v: 1, state: 'none', took: 0, more: false, ports: {} }) ],
		[ 'no ethtool', () => Promise.resolve({ v: 1, state: 'no-ethtool', took: 0, more: false, ports: {} }) ],
		[ 'names it does not know', answer({ lan1: { error: 'unknown' }, lan2: { error: 'unknown' } }) ],
		[ 'no object (rpcd not reloaded, the plugin removed)', () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with error -32000: Object not found')) ],
		[ 'no such plugin file any more', () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with ubus code 4: Resource not found')) ]
	]) {
		c.self = Object.create(view);
		c.asked = 0;
		c.reply = reply;
		await c.ask();
		c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
		for (let i = 0; i < 5; i++) assert.equal((await c.ask())[0], null, what);
		assert.equal(c.asked, 1, what + ': asked once');
	}
	/* a first call that failed decides nothing */
	c.self = Object.create(view);
	c.asked = 0;
	c.reply = () => Promise.reject(new Error('RPC call to luci.vantage.ports/counters failed with ubus code 7: Request timed out'));
	await c.ask();
	c.reply = () => Promise.resolve({ v: 1, state: 'none', took: 0, more: false, ports: {} });
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 2, 'the first answer after it does');
}));

test('view: busy is no answer this time: the page keeps asking, and the first real answer decides', () => switchCalls(async c => {
	const busy = () => Promise.resolve({ v: 1, state: 'busy', took: 0, more: false, ports: {} });
	c.reply = busy;
	for (let i = 0; i < 5; i++) assert.equal((await c.ask())[0], null, 'busy ' + i);
	assert.equal(c.asked, 5, 'asked every poll');
	/* busy, then counters, then busy again: still asked */
	c.reply = answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } });
	assert.deepEqual((await c.ask())[0].counters.lan1, { rx: 1, tx: 2, at: 7000 });
	c.reply = busy;
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 8);
	/* busy first, then an answer of nothing to get: that one ends the asking */
	c.self = Object.create(view);
	c.asked = 0;
	c.reply = busy;
	await c.ask();
	c.reply = () => Promise.resolve({ v: 1, state: 'none', took: 0, more: false, ports: {} });
	await c.ask();
	await c.ask();
	await c.ask();
	assert.equal(c.asked, 2);
}));

test('view: a poll waits 2 s for the answer at most; while a call is out no other is made', () => switchCalls(async c => {
	const first = await c.ask();
	assert.deepEqual([ c.asked, c.timers.map(t => t.ms), first[0] ], [ 1, [ 2000 ], undefined ], 'the poll waits, with a deadline');
	await c.fire();
	assert.equal(first[0], null, 'and goes on without it');
	const second = await c.ask();
	assert.deepEqual([ c.asked, second[0], c.timers.length ], [ 1, null, 0 ], 'not asked again while the first is out');
	c.out.shift().resolve({ v: 1, state: 'ok', took: 2500, more: false, ports: { lan1: { rx_bytes: 1, tx_bytes: 2, at: 7000 } } });
	await c.flush();
	c.reply = answer({ lan1: { rx_bytes: 3, tx_bytes: 4 } });
	assert.deepEqual((await c.ask())[0].counters.lan1, { rx: 3, tx: 4, at: 7000 });
	assert.equal(c.asked, 2);
}));

test('view: a port counts by its chip where the poll has its counters, never a line\'s own device, and a rate is of one source', () => {
	const savedL = global.L, savedW = global.window;
	global.L = { env: {} };
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} } };
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
		const dsa = (rx, tx) => ({ devtype: 'dsa', carrier: true, speed: '1000F', statistics: { rx_bytes: rx, tx_bytes: tx } });
		/* t s after the start: the kernel's counters crawl (what passes the CPU), the chip's run at the port's rate */
		const raw = (t, hw) => ({ at: 1.8e12 + t * 1000, info: { localtime: 1.8e9 + t }, stat: '', ifaces: [ wan ], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
			devs: { lan1: dsa(t * 10, t * 20), lan2: dsa(t * 30, t * 40), wan: dsa(t * 1000, t * 2000) },
			hw: hw === false ? null : { state: 'ok', none: false, counters: Object.assign(Object.create(null), {
				lan1: { rx: 5e9 + t * 1e6, tx: 7e9 + t * 2e6 }, wan: { rx: 1e12 + t * 9e6, tx: 1e12 } }) } });
		const rates = () => JSON.parse(JSON.stringify([ self.st.devRates.lan1 || null, self.st.devRates.lan2 || null, self.st.devRates.wan || null ]));
		self.ingest(raw(0));
		self.ingest(raw(5));
		/* lan1: the chip's; lan2: the kernel's (no counters of the chip for it); wan, the line's: the kernel's */
		assert.deepEqual(rates(), [ { rx: 8e6, tx: 16e6 }, { rx: 240, tx: 320 }, { rx: 8000, tx: 16000 } ]);
		/* the chip's counters stayed out this poll: no rate for lan1, not the kernel's against the chip's */
		self.ingest(raw(10, false));
		assert.deepEqual(rates(), [ null, { rx: 240, tx: 320 }, { rx: 8000, tx: 16000 } ]);
		/* and the step back to the chip's is none either; then the chip's again */
		self.ingest(raw(15));
		assert.deepEqual(rates()[0], null);
		self.ingest(raw(20));
		assert.deepEqual(rates()[0], { rx: 8e6, tx: 16e6 });
	} finally {
		global.L = savedL;
		global.window = savedW;
	}
});

test('view: a chip\'s counters are rated by when the device read them, however late each answer came in', () => {
	const savedL = global.L, savedW = global.window;
	global.L = { env: {} };
	global.window = { sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} } };
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const wan = { interface: 'wan', up: true, proto: 'dhcp', device: 'wan', l3_device: 'wan', metric: 10, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' } ] };
		const dsa = { devtype: 'dsa', carrier: true, speed: '1000F', statistics: { rx_bytes: 1, tx_bytes: 1 } };
		/* poll k: the batch at 5 s steps; the chip read at 5 s steps on the device's clock, its answer held back 0.1 s, then 1.5 s, ... */
		const raw = k => ({ at: 1.8e12 + k * 5000 + (k % 2 ? 1500 : 100), info: { localtime: 1.8e9 + k * 5 }, stat: '', ifaces: [ wan ], wifi: null, hints: {}, thermal: [], fdb: [], assoc: {}, hapd: {}, hapdStatus: {}, iwinfo: {},
			devs: { lan1: dsa, wan: dsa }, hw: { state: 'ok', none: false, counters: Object.assign(Object.create(null), { lan1: { rx: k * 5 * 19e6 / 8, tx: k * 5 * 1e6 / 8, at: 123e6 + k * 5000 } }) } });
		self.ingest(raw(0));
		for (let k = 1; k < 6; k++) {
			self.ingest(raw(k));
			assert.deepEqual(JSON.parse(JSON.stringify(self.st.devRates.lan1)), { rx: 19e6, tx: 1e6 }, 'poll ' + k);
		}
	} finally {
		global.L = savedL;
		global.window = savedW;
	}
});

test('view: a busy answer reaches ingest as none (the kernel\'s counters for that step), and the next poll asks again', async () => {
	const saved = { L: global.L, document: global.document };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	let asked = 0;
	REPLIES['luci.vantage.ports counters'] = () => { asked++; return Promise.resolve({ v: 1, state: 'busy', took: 0, more: false, ports: {} }); };
	try {
		const self = Object.create(view);
		assert.equal((await self.fetch()).hw, null);
		REPLIES['luci.vantage.ports counters'] = () => { asked++; return answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } })(); };
		assert.deepEqual(JSON.parse(JSON.stringify((await self.fetch()).hw.counters)), { lan1: { rx: 1, tx: 2, at: 7000 } });
		assert.equal(asked, 2);
	} finally {
		Object.assign(global, saved);
		if (saved.document === undefined) delete global.document;
		delete REPLIES['luci.vantage.ports counters'];
	}
});

test('view: the call is a request of its own, in every poll\'s fetch, and what it answers reaches ingest', async () => {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	assert.ok(src.includes("var callSwitchCounters = rpc.declare({ object: 'luci.vantage.ports', method: 'counters', expect: { '': {} }, reject: true, nobatch: true });"));
	const saved = { L: global.L, document: global.document };
	global.document = { hidden: false, documentElement: { getAttribute: () => null } };
	global.L = { resolveDefault: (p, d) => Promise.resolve(p).then(v => v == null ? d : v, () => d) };
	let asked = 0;
	REPLIES['luci.vantage.ports counters'] = () => { asked++; return answer({ lan1: { rx_bytes: 1, tx_bytes: 2 } })(); };
	try {
		const self = Object.create(view);
		const raw = await self.fetch();
		assert.deepEqual([ asked, JSON.parse(JSON.stringify(raw.hw)) ], [ 1, { state: 'ok', counters: { lan1: { rx: 1, tx: 2, at: 7000 } }, none: false } ]);
		await self.fetch();
		assert.equal(asked, 2, 'every poll');
	} finally {
		Object.assign(global, saved);
		if (saved.document === undefined) delete global.document;
		delete REPLIES['luci.vantage.ports counters'];
	}
});
