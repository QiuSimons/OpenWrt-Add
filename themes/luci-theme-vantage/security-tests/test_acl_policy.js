#!/usr/bin/env node
'use strict';
/*
 * luci-app-vantage rpcd ACL policy.
 *
 *   node security-tests/test_acl_policy.js     (or node --test ...)
 *
 * The ACL is least privilege and in step with the shipped JavaScript:
 *
 * - exactly three groups: `luci-app-vantage` (read-only),
 *   `luci-app-vantage-rdns` (optional: network.rrdns lookup, which lets
 *   the holder point the device's DNS queries at any server and port) and
 *   `luci-app-vantage-names` (station aliases, and stations whose weak
 *   signal stays out of the warnings, through the app's own rpcd plugin
 *   methods luci.vantage set_alias and set_quiet);
 * - the read group grants exactly the allowlisted ubus methods below, no
 *   write section, no `*` object or method, no method glob; the one object
 *   glob is `hostapd.*`, because hostapd's ubus objects are named per
 *   interface (hostapd.phy0-ap0, ...), and it carries two read methods;
 * - Wi-Fi configuration comes from luci.vantage wireless (no keys):
 *   luci-rpc getWirelessDevices and network.wireless are granted nowhere;
 * - `file` is limited to the `read` method on /proc/stat: no exec, write,
 *   remove, list or stat, no cgi-io;
 * - uci is readable for `vantage` only and writable by nobody: no uci
 *   add/set/delete/commit/... method and no `uci` write list in any group;
 *   the only grants beyond reads are luci.vantage set_alias and set_quiet;
 * - the plugin (root/usr/share/rpcd/ucode/luci.vantage) registers exactly
 *   the luci.vantage methods the ACL grants, opens config `vantage`, and
 *   only loads and walks config `wireless` (luci.vantage wireless without
 *   netifd's network.wireless object; same reduced reply, no keys) and
 *   the switch_vlan sections of config `network`, reading their device,
 *   vlan, vid and ports only (luci.vantage wired, behind a switch), and
 *   imports nothing but uci, ubus, fs's lsdir and readfile, which it
 *   calls on paths under /sys/class/thermal (luci.vantage thermal), on
 *   the bridges' brforward and on /etc/board.json only, and rtnl for one
 *   read-only dump of the bridge forwarding database (luci.vantage wired)
 *   and one route lookup a family, IPv4 and IPv6, of a documentation
 *   address (luci.vantage routes); no other file access, no other
 *   netlink request, no process execution, and no module, cursor or
 *   connection passed on under another name; altered copies of the
 *   plugin check that these rules catch each breach;
 * - every rpc.declare({ object, method }) in the app's JavaScript is
 *   granted, and every grant is used by a declare (no stale privilege);
 *   `session access` is the only call left to the platform (rpcd grants it
 *   to every session through its `unauthenticated` group);
 * - calls on uci objects name the `vantage` config literally, except the
 *   firewall overview (view/vantage/firewall.js), which reads `firewall`
 *   with uci get, finds the uplink with network.interface dump and
 *   declares nothing else; file.read
 *   calls name a granted path literally; no `fs` module, no fs.exec;
 * - a declared call is only ever called directly (`callX(...)`): no alias,
 *   no `.call`/`.apply`, no passing it around, so the literal arguments
 *   above are all the arguments there are;
 * - the firewall overview requires exactly its pinned LuCI modules, and no
 *   app file requires a LuCI module that loads other configs on its own
 *   (`network` loads `wireless`, `firewall` and `tools.*` load more), or
 *   loads modules by a computed name;
 * - the view probes exactly the names group (write) and the rdns group
 *   (read);
 * - the dashboard's menu entry is gated by the read group; the firewall
 *   overview's (Network -> Firewall -> Overview) by luci-app-firewall,
 *   LuCI's own group for the firewall pages, which already lets its holder
 *   read and change `firewall`: the app grants nothing for it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/* VANTAGE_APP_PKG: check another copy of the package (mutation tests) */
const PKG = path.resolve(process.env.VANTAGE_APP_PKG || path.join(__dirname, '..', 'luci-app-vantage'));
const HTDOCS = path.join(PKG, 'htdocs');
const ACL_FILE = path.join(PKG, 'root/usr/share/rpcd/acl.d/luci-app-vantage.json');
const MENU_FILE = path.join(PKG, 'root/usr/share/luci/menu.d/zz-luci-app-vantage.json');
const PLUGIN_FILE = path.join(PKG, 'root/usr/share/rpcd/ucode/luci.vantage');

const READ_GROUP = 'luci-app-vantage';
const RDNS_GROUP = 'luci-app-vantage-rdns';
const WRITE_GROUP = 'luci-app-vantage-names';
const PLUGIN_OBJECT = 'luci.vantage';
const FIREWALL_VIEW = 'view/vantage/firewall.js';

/* the complete read allowlist: object -> methods */
const READ_UBUS = {
	'file': [ 'read' ],
	'system': [ 'board', 'info' ],
	'network.interface': [ 'dump' ],
	'network.device': [ 'status' ],
	'luci-rpc': [ 'getHostHints' ],
	/* LuCI's own: swconfig dev <switch> show, the switch name quoted */
	'luci': [ 'getSwconfigPortState' ],
	'luci.vantage': [ 'routes', 'thermal', 'wired', 'wireless' ],
	'iwinfo': [ 'assoclist', 'info', 'survey' ],
	'hostapd.*': [ 'get_clients', 'get_status' ],
	'umdns': [ 'hosts' ],
	'uci': [ 'get' ]
};
const READ_FILES = { '/proc/stat': [ 'read' ] };
const RDNS_UBUS = { 'network.rrdns': [ 'lookup' ] };
const WRITE_UBUS = { 'luci.vantage': [ 'set_alias', 'set_quiet' ] };
const OBJECT_GLOBS = new Set([ 'hostapd.*' ]);
const UCI_WRITE = /^(add|set|delete|commit|rename|order|apply|confirm|rollback|revert|changes)$/;
/* calls the platform grants to every session (rpcd acl.d/unauthenticated.json) */
const PLATFORM = new Set([ 'session access' ]);

const acl = JSON.parse(fs.readFileSync(ACL_FILE, 'utf8'));
const menu = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
const plugin = fs.readFileSync(PLUGIN_FILE, 'utf8');

function jsFiles(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) jsFiles(p, out);
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out.sort();
}
const sources = jsFiles(HTDOCS).map(f => ({ file: path.relative(PKG, f), text: fs.readFileSync(f, 'utf8') }));

function sorted(o) {
	const out = {};
	for (const k of Object.keys(o).sort()) out[k] = [ ...o[k] ].sort();
	return out;
}

function pairs(ubus) {
	const out = new Set();
	for (const [ obj, methods ] of Object.entries(ubus || {})) for (const m of methods) out.add(obj + ' ' + m);
	return out;
}

/* What the JavaScript calls. Literal declares: `var X = rpc.declare({
   object: 'o', method: 'm', ... })`. The one dynamic declare is the
   hostapd helper (object 'hostapd.' + ifname), whose methods are the
   literal second arguments of hostapd(ifname, 'method') calls. */
function analyse() {
	const declared = new Map();          /* 'obj method' -> [file] */
	const vars = new Map();              /* callVar -> { obj, method } */
	const problems = [];
	const DECL = /(?:var|let|const)\s+(\w+)\s*=\s*rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g;
	for (const { file, text } of sources) {
		/* also `rpc.declare (`, `var d = rpc.declare` and `rpc['declare']` */
		const total = (text.match(/\brpc\s*(?:\.\s*declare\b|\[)/g) || []).length;
		let literal = 0, dynamic = 0;
		for (const m of text.matchAll(DECL)) {
			literal++;
			vars.set(m[1], { obj: m[2], method: m[3] });
			const k = m[2] + ' ' + m[3];
			declared.set(k, (declared.get(k) || []).concat(file));
		}
		/* the hostapd helper: object built from a validated prefix */
		const helper = /function hostapd\((\w+), (\w+)\) \{\s*var obj = 'hostapd\.' \+ \1,[^\n]*\n\s*if \(!HOSTAPD_OBJ\.test\(obj\)\) return[^\n]*\n\s*if \(!hostapdCalls\[key\]\) hostapdCalls\[key\] = rpc\.declare\(\{ object: obj, method: \2,/;
		if (helper.test(text)) {
			dynamic++;
			for (const m of text.matchAll(/\bhostapd\(\w+, '([A-Za-z_]+)'\)/g)) {
				const k = 'hostapd.* ' + m[1];
				declared.set(k, (declared.get(k) || []).concat(file));
			}
			for (const m of text.matchAll(/(?<!function )\bhostapd\(\w+, (?!')/g)) problems.push(`${file}: hostapd() with a non-literal method at ${m.index}`);
		}
		if (literal + dynamic !== total) problems.push(`${file}: ${total - literal - dynamic} rpc.declare() call(s) with a non-literal object or method`);
	}
	return { declared, vars, problems };
}

const { declared, vars, problems } = analyse();

test('exactly the three groups', () => {
	assert.deepEqual(Object.keys(acl).sort(), [ READ_GROUP, RDNS_GROUP, WRITE_GROUP ].sort());
});

test('read group: exactly the allowlisted read methods, nothing written', () => {
	const g = acl[READ_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read' ]);
	assert.deepEqual(Object.keys(g.read).sort(), [ 'file', 'ubus', 'uci' ]);
	assert.deepEqual(sorted(g.read.ubus), sorted(READ_UBUS));
	assert.deepEqual(sorted(g.read.file), sorted(READ_FILES));
	assert.deepEqual(g.read.uci, [ 'vantage' ]);
});

test('no group can read Wi-Fi keys: wireless configuration only through luci.vantage wireless', () => {
	/* luci-rpc getWirelessDevices and network.wireless status return the
	   wifi-iface sections including key / SAE / RADIUS secrets */
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ]) {
		const p = pairs((g[kind] || {}).ubus);
		assert.ok(!p.has('luci-rpc getWirelessDevices'), `${name}.${kind}: luci-rpc getWirelessDevices`);
		assert.ok(![ ...p ].some(k => /^network\.wireless /.test(k)), `${name}.${kind}: network.wireless`);
		assert.ok(!((g[kind] || {}).uci || []).includes('wireless'), `${name}.${kind}: uci wireless`);
	}
	assert.doesNotMatch(acl[READ_GROUP].description, /Wi-Fi keys/, 'the description no longer needs the warning');
});

test('rdns group: network.rrdns lookup only, described honestly', () => {
	const g = acl[RDNS_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read' ]);
	assert.deepEqual(g.read, { ubus: RDNS_UBUS });
	assert.match(g.description, /DNS/);
	assert.match(g.description, /any DNS server and port/);
});

test('names group: luci.vantage set_alias and set_quiet, uci read on vantage, no uci write', () => {
	const g = acl[WRITE_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read', 'write' ]);
	assert.deepEqual(g.read, { ubus: { uci: [ 'get' ] }, uci: [ 'vantage' ] });
	assert.deepEqual(g.write, { ubus: WRITE_UBUS });
});

test('no uci write grant in the app; its only non-read grants are the plugin\'s set_alias and set_quiet', () => {
	const extra = [];
	for (const [ name, g ] of Object.entries(acl)) {
		for (const kind of [ 'read', 'write' ]) {
			const sec = g[kind] || {};
			for (const k of pairs(sec.ubus)) {
				const [ obj, m ] = k.split(' ');
				assert.ok(!(obj === 'uci' && UCI_WRITE.test(m)), `${name}.${kind}: uci ${m}`);
				if (!pairs(READ_UBUS).has(k) && !pairs(RDNS_UBUS).has(k)) extra.push(k);
			}
			if (kind === 'write') assert.equal(sec.uci, undefined, `${name}: uci write list`);
			if (kind === 'write') assert.equal(sec.file, undefined, `${name}: file write list`);
		}
	}
	assert.deepEqual(extra, [ 'luci.vantage set_alias', 'luci.vantage set_quiet' ]);
});

test('the plugin registers exactly the granted luci.vantage methods, writes config vantage only, reads wireless', () => {
	/* ubus object and methods (the file's last statement and its methods table) */
	assert.match(plugin, /^return \{ 'luci\.vantage': methods \};\s*$/m);
	const table = /^const methods = \{\n([\s\S]*?)\n\};$/m.exec(plugin);
	assert.ok(table, 'methods table');
	const methods = [ ...table[1].matchAll(/^\t([A-Za-z_]+): \{$/gm) ].map(m => m[1]).sort();
	const granted = new Set();
	for (const g of Object.values(acl)) for (const kind of [ 'read', 'write' ])
		for (const m of ((g[kind] || {}).ubus || {})[PLUGIN_OBJECT] || []) granted.add(m);
	assert.deepEqual(methods, [ ...granted ].sort());
	assert.deepEqual(methods, [ 'routes', 'set_alias', 'set_quiet', 'thermal', 'wired', 'wireless' ]);
	assert.ok(pairs(acl[READ_GROUP].read.ubus).has(PLUGIN_OBJECT + ' wireless'));
	assert.ok(pairs(acl[READ_GROUP].read.ubus).has(PLUGIN_OBJECT + ' thermal'));
	assert.ok(pairs(acl[WRITE_GROUP].write.ubus).has(PLUGIN_OBJECT + ' set_alias'));
	assert.ok(pairs(acl[WRITE_GROUP].write.ubus).has(PLUGIN_OBJECT + ' set_quiet'));

	checkPluginSource(plugin);
});

/* The plugin's source rules, in one function so that the mutation test
   below can run them on altered copies; throws at the first breach. They
   read the text, so the names that hold a module, cursor or connection
   (cursor, connect, uci, wl, rtnl) may appear only where listed, comments
   included, and a reference that passes one of them on is a breach. */
const REWORD = '; comments count too, so reword a comment that uses the word';
function checkPluginSource(src) {
	/* imports: exactly these lines; nothing that writes files, starts
	   processes or reaches builtins by name, not even by reference
	   (`let s = system`, `global[...]`, `call(...)`) */
	assert.deepEqual([ ...src.matchAll(/^.*\bimport\b.*$/gm) ].map(m => m[0]), [
		'import { cursor } from \'uci\';',
		'import { connect } from \'ubus\';',
		'import { lsdir, readfile } from \'fs\';',
		'import * as rtnl from \'rtnl\';'
	]);
	const word = /\b(system|popen|exec|require|loadfile|loadstring|include|render|writefile|unlink|global)\b/.exec(src);
	assert.equal(word, null, word && `"${word[1]}" is banned in the plugin, as a word${REWORD}`);
	assert.doesNotMatch(src, /(^|[^.\w])call\s*\(/m, 'the call() builtin is banned in the plugin');
	/* fs: only the thermal zones under /sys/class/thermal, the
	   bridges' forwarding counts (brforward) under /sys/class/net and
	   the board description */
	assert.match(src, /^const THERMAL = '\/sys\/class\/thermal';$/m);
	assert.match(src, /^const NET = '\/sys\/class\/net';$/m);
	assert.match(src, /^const BOARD = '\/etc\/board\.json';$/m);
	const fsCalls = [ ...src.matchAll(/\b(lsdir|readfile)\(([^,)]*)/g) ].map(m => m[1] + '(' + m[2]);
	assert.ok(fsCalls.length >= 5, 'found the fs calls');
	for (const c of fsCalls) assert.match(c, /^(lsdir\(THERMAL$|readfile\(THERMAL \+ '\/' \+ n \+ '\/(temp|type)'|lsdir\(NET$|readfile\(NET \+ '\/' \+ n \+ '\/brforward'|readfile\(BOARD)$/, c);
	/* each path constant only in its definition and those calls, so no
	   `let BOARD = ...` can shadow one; board.json read up to BOARD_MAX */
	for (const [ name, uses ] of [ [ 'THERMAL', 4 ], [ 'NET', 3 ], [ 'BOARD', 2 ] ])
		assert.equal([ ...src.matchAll(new RegExp('\\b' + name + '\\b', 'g')) ].length, uses, `${name}: its definition and its ${uses - 1} fs calls${REWORD}`);
	assert.match(src, /^const BOARD_MAX = 65536; /m);
	assert.match(src, /\breadfile\(BOARD, BOARD_MAX\)/, 'board.json read with its bound');

	/* uci: four cursors made without arguments, `uci` on CONFIG
	   ('vantage', set_alias and set_quiet), `wl`, which only loads and
	   walks WIRELESS ('wireless'), and `nw`, which only loads NETWORK
	   ('network') and walks its switch_vlan sections; every other mention
	   of these names is one of those calls */
	assert.deepEqual([ ...src.matchAll(/^.*\bcursor\b.*$/gm) ].map(m => m[0].trim()), [ 'import { cursor } from \'uci\';', 'let wl = cursor();', 'let uci = cursor();', 'let uci = cursor();', 'let nw = cursor();' ],
		`"cursor" may appear only on its import and the four cursor() lines${REWORD}`);
	const body = src.replace(/^.*\bcursor\b.*$/gm, '');
	assert.match(src, /^const CONFIG = 'vantage';$/m);
	const calls = [ ...body.matchAll(/\buci\b(?:\.(\w+)\(([^,)]*))?/g) ];
	assert.ok(calls.length >= 5, 'found the uci calls');
	for (const m of calls) assert.equal(m[2], 'CONFIG', `"${m[0]}": "uci" may appear only as uci.<method>(CONFIG, ...)${REWORD}`);
	assert.match(src, /^const WIRELESS = 'wireless';/m);
	assert.deepEqual([ ...body.matchAll(/\bwl\b(?:\.(\w+)\(([^,)]*))?/g) ].map(m => m[0]), [ 'wl.load(WIRELESS', 'wl.foreach(WIRELESS', 'wl.foreach(WIRELESS' ],
		`"wl" may appear only as wl.load(WIRELESS) and two wl.foreach(WIRELESS, ...)${REWORD}`);
	assert.equal([ ...src.matchAll(/\bWIRELESS\b/g) ].length, 4, 'WIRELESS: its definition and the three wl calls');
	assert.match(src, /^const NETWORK = 'network';/m);
	assert.deepEqual([ ...body.matchAll(/\bnw\b(?:\.(\w+)\(([^)]*?)(?:, \(|\)))?/g) ].map(m => m[0]), [ 'nw.load(NETWORK)', 'nw.foreach(NETWORK, \'switch_vlan\', (' ],
		`"nw" may appear only as nw.load(NETWORK) and nw.foreach(NETWORK, 'switch_vlan', ...)${REWORD}`);
	assert.equal([ ...src.matchAll(/\bNETWORK\b/g) ].length, 3, 'NETWORK: its definition and the two nw calls');
	/* of a switch_vlan section, only these options are read */
	const sws = /^function switches\(\) \{\n[\s\S]*?\n\}$/m.exec(src);
	assert.ok(sws, 'switches()');
	const walk = 'nw.foreach(NETWORK, \'switch_vlan\', (s) => {';
	assert.equal(sws[0].split(walk).length, 2, 'the switch_vlan callback takes its section as s');
	for (const m of sws[0].replace(walk, '').matchAll(/(?<!\\)\bs\b(\.\w+|\[|\))?/g))
		assert.ok([ '.device', '.vid', '.vlan', '.ports' ].includes(m[1]), `"${m[0]}": a switch_vlan section is read as s.device, s.vid, s.vlan and s.ports only${REWORD}`);

	/* ubus: one connection for the one call, network.wireless status */
	assert.deepEqual([ ...src.matchAll(/^.*\bconnect\b.*$/gm) ].map(m => m[0].trim()), [ 'import { connect } from \'ubus\';', 'let reply = connect()?.call(\'network.wireless\', \'status\');' ],
		`"connect" may appear only on its import and the network.wireless status call${REWORD}`);
	assert.equal([ ...src.matchAll(/\.\s*call\b/g) ].length, 1, 'one .call');

	/* rtnl: two requests, the read-only dump of the bridge forwarding
	   database and a route lookup (RTM_GETROUTE without a dump: the one
	   route the kernel takes, never a write, as `ip route get`) of the two
	   documentation addresses only; otherwise only constants are read */
	const dump = 'let fdb = rtnl.request(rtnl.const.RTM_GETNEIGH, rtnl.const.NLM_F_DUMP, { family: rtnl.const.AF_BRIDGE });';
	const lookup = 'let r = rtnl.request(rtnl.const.RTM_GETROUTE, 0, { family: q.family, dst: q.dst, flags: rtnl.const.RTM_F_FIB_MATCH });';
	assert.deepEqual([ ...src.matchAll(/^.*\brtnl\.request\b.*$/gm) ].map(m => m[0].trim()), [ dump, lookup ], `"rtnl.request" may appear only as the dump and the lookup${REWORD}`);
	/* the lookup's family and address: the two literals, read, never assigned */
	assert.deepEqual([ ...src.matchAll(/^.*\bq\b.*$/gm) ].map(m => m[0].trim()), [
		'for (let q in [ { family: rtnl.const.AF_INET, dst: PROBE4 }, { family: rtnl.const.AF_INET6, dst: PROBE6 } ]) {',
		lookup,
		"if (type(r) != 'object' || r.family != q.family || r.dst != null || r.table != rtnl.const.RT_TABLE_MAIN || r.type != rtnl.const.RTN_UNICAST)",
		"push(out, { family: (q.family == rtnl.const.AF_INET) ? 4 : 6, dev: netdev(r.oif), metric: (type(m) == 'int' && m >= 0) ? m : 0 });"
	], `"q" may appear only on the lookup's lines${REWORD}`);
	assert.deepEqual([ ...src.matchAll(/^.*\bPROBE[46]\b.*$/gm) ].map(m => m[0].trim()), [
		'const PROBE4 = \'198.51.100.1\';    // routes: looked up, never sent to (documentation ranges)',
		'const PROBE6 = \'2001:db8::1\';',
		'for (let q in [ { family: rtnl.const.AF_INET, dst: PROBE4 }, { family: rtnl.const.AF_INET6, dst: PROBE6 } ]) {'
	], `the looked-up addresses are the two documentation constants${REWORD}`);
	const rest = src.replace(/^import \* as rtnl from 'rtnl';$/m, '').replace(dump, '').replace(lookup, '');
	const CONSTS = [ 'NUD_PERMANENT', 'NUD_NOARP', 'NTF_SELF', 'AF_INET', 'AF_INET6', 'RT_TABLE_MAIN', 'RTN_UNICAST' ];
	for (const m of rest.matchAll(/\brtnl\b(?:\.const\.(\w+))?/g))
		assert.ok(CONSTS.includes(m[1]), `"${m[0]}": "rtnl" may appear only as rtnl.const.${CONSTS.join(', ')}${REWORD}`);
}

test('the plugin source rules catch writes, other configs and calls, and names passed on', () => {
	const at = '\tlet wl = cursor();\n';
	assert.ok(plugin.includes(at), 'insertion point');
	const add = code => plugin.replace(at, at + '\t' + code + '\n');
	const MUTANTS = {
		'renamed import': add('let w = rw(); w.set(\'wireless\', \'x\', \'encryption\', \'none\'); w.commit(\'wireless\');')
			.replace('import { cursor } from \'uci\';', 'import { cursor, cursor as rw } from \'uci\';'),
		'second import': plugin.replace('import { connect } from \'ubus\';', 'import { connect } from \'ubus\';\nimport * as u from \'uci\';'),
		'fs write': plugin.replace('import { lsdir, readfile } from \'fs\';', 'import { lsdir, readfile, writefile } from \'fs\';'),
		'cursor by reference': add('let mk = cursor; mk().commit(WIRELESS);'),
		'cursor on a directory': plugin.replace('let uci = cursor();', 'let uci = cursor(\'/etc/init.d\');'),
		'third cursor': add('let w = cursor(); w.load(\'network\');'),
		'write through wl': add('wl.set(WIRELESS, \'x\', \'encryption\', \'none\');'),
		'wl by reference': add('let w2 = wl;'),
		'uci by reference': plugin.replace('\tuci.load(CONFIG);\n', '\tuci.load(CONFIG);\n\tlet u = uci; u.set(\'wireless\', \'x\', \'encryption\', \'none\');\n'),
		'uci on wireless': plugin.replace('\tuci.load(CONFIG);\n', '\tuci.load(WIRELESS);\n'),
		'nw on wireless': plugin.replace('nw.load(NETWORK)', 'nw.load(WIRELESS)'),
		'nw walks interfaces': plugin.replace('nw.foreach(NETWORK, \'switch_vlan\'', 'nw.foreach(NETWORK, \'interface\''),
		'nw writes': plugin.replace('\tif (nw.load(NETWORK))', '\tnw.set(NETWORK, \'lan\', \'proto\', \'none\');\n\tif (nw.load(NETWORK))'),
		'another switch_vlan option': plugin.replace('let id = s.vid ?? s.vlan;', 'let id = s.vid ?? s.vlan ?? s.password;'),
		'a whole section passed on': plugin.replace('out[dev] = { name: s.device,', 'out[dev] = { section: s, name: s.device,'),
		'other file': plugin.replace('readfile(BOARD, BOARD_MAX)', 'readfile(\'/etc/shadow\', BOARD_MAX)'),
		'shadowed path': plugin.replace('\tlet board = null, known = {}', '\tlet BOARD = \'/etc/shadow\';\n\tlet board = null, known = {}'),
		'unbounded board read': plugin.replace('readfile(BOARD, BOARD_MAX)', 'readfile(BOARD)'),
		'shadowed net': plugin.replace('\tlet left = FDB_LIMIT * FDB_ENTRY;', '\tlet left = FDB_LIMIT * FDB_ENTRY;\n\tlet NET = \'/etc\';'),
		'ubus call in double quotes': add('connect()?.call("uci", "set", {});'),
		'ubus call on a computed object': add('let o = \'file\'; connect()?.call(o, \'write\', {});'),
		'process by reference': add('let s = system; s(\'reboot\');'),
		'builtin call()': add('call(print, null, null, \'x\');'),
		'builtin by name': add('global[\'sys\' + \'tem\'](\'reboot\');'),
		'netlink write': plugin.replace('rtnl.const.RTM_GETNEIGH, rtnl.const.NLM_F_DUMP', 'rtnl.const.RTM_DELNEIGH, rtnl.const.NLM_F_DUMP'),
		'second netlink request': add('rtnl.request(rtnl.const.RTM_NEWNEIGH, 0, {});'),
		'route write': plugin.replace('rtnl.const.RTM_GETROUTE, 0,', 'rtnl.const.RTM_NEWROUTE, 0,'),
		'route dump': plugin.replace('rtnl.const.RTM_GETROUTE, 0,', 'rtnl.const.RTM_GETROUTE, rtnl.const.NLM_F_DUMP,'),
		'another address looked up': plugin.replace('dst: PROBE4 }', 'dst: \'192.0.2.1\' }'),
		'family reassigned': plugin.replace('\t\tlet r = rtnl.request(rtnl.const.RTM_GETROUTE', '\t\tq.family = rtnl.const.AF_BRIDGE;\n\t\tlet r = rtnl.request(rtnl.const.RTM_GETROUTE'),
		'family changed in place': plugin.replace('\t\tlet r = rtnl.request(rtnl.const.RTM_GETROUTE', '\t\tq.family -= q.family;\n\t\tlet r = rtnl.request(rtnl.const.RTM_GETROUTE'),
		'probe changed': plugin.replace("const PROBE4 = '198.51.100.1';", "const PROBE4 = '203.0.113.7';"),
		'rtnl by reference': add('let nl = rtnl;'),
		'other rtnl member': add('let e = rtnl.error();')
	};
	for (const [ name, src ] of Object.entries(MUTANTS)) {
		assert.notEqual(src, plugin, name + ': the mutation applies');
		assert.throws(() => checkPluginSource(src), assert.AssertionError, name);
	}
});

test('no wildcards except the hostapd object glob; no method globs', () => {
	const GLOB = /[*?[\]]/;
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ]) {
		const sec = g[kind];
		if (!sec) continue;
		for (const [ obj, methods ] of Object.entries(sec.ubus || {})) {
			assert.ok(!GLOB.test(obj) || OBJECT_GLOBS.has(obj), `${name}.${kind}: ubus object glob ${obj}`);
			assert.ok(Array.isArray(methods) && methods.length, `${name}.${kind}: ${obj} has no method list`);
			for (const m of methods) assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(m), `${name}.${kind}: ${obj} method ${m}`);
		}
		for (const c of sec.uci || []) assert.ok(/^[a-z0-9_-]+$/.test(c), `${name}.${kind}: uci ${c}`);
		for (const p of Object.keys(sec.file || {})) assert.ok(!GLOB.test(p), `${name}.${kind}: file glob ${p}`);
	}
});

test('no file exec/write/remove, no cgi-io, no foreign sections', () => {
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ]) {
		const sec = g[kind];
		if (!sec) continue;
		for (const k of Object.keys(sec)) assert.ok([ 'ubus', 'uci', 'file' ].includes(k), `${name}.${kind}: ${k}`);
		for (const m of (sec.ubus || {}).file || []) assert.equal(m, 'read', `${name}.${kind}: ubus file.${m}`);
		for (const [ p, ops ] of Object.entries(sec.file || {})) {
			assert.equal(kind, 'read', `${name}: file ${p} under ${kind}`);
			assert.deepEqual(ops, [ 'read' ], `${name}: file ${p}`);
		}
	}
	assert.doesNotMatch(JSON.stringify(acl), /"(exec|cgi-io|remove|upload)"/);
});

test('the JavaScript is analysable', () => {
	assert.deepEqual(problems, []);
	assert.ok(declared.size >= 10, 'found the declares');
});

test('every declared call is granted and every grant is used', () => {
	const granted = new Set([ ...pairs(acl[READ_GROUP].read.ubus), ...pairs(acl[RDNS_GROUP].read.ubus),
		...pairs(acl[WRITE_GROUP].read.ubus), ...pairs(acl[WRITE_GROUP].write.ubus) ]);
	const need = [ ...declared.keys() ].filter(k => !PLATFORM.has(k));
	assert.deepEqual(need.filter(k => !granted.has(k)).sort(), [], 'declared but not granted');
	assert.deepEqual([ ...granted ].filter(k => !declared.has(k)).sort(), [], 'granted but never declared');
	/* read grants are not write methods */
	for (const k of pairs(acl[READ_GROUP].read.ubus)) assert.ok(!/^uci (add|set|delete|commit|rename|order|apply|confirm|revert)$/.test(k), k);
});

/* Problems with how the declared calls are used, over `srcs` (the real
   sources, or a mutated copy): each declared function only in direct
   calls, uci with the literal config the file may read, file.read with a
   literal granted path, no fs module, no LuCI uci module calls. */
function callProblems(srcs) {
	const out = [];
	for (const { file, text } of srcs) {
		/* a declared function is local to its file: check each file
		   against its own declarations, read from its own text, so two
		   files declaring the same name cannot vouch for each other */
		const declVars = new Map();
		for (const m of text.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g))
			declVars.set(m[1], { obj: m[2], method: m[3] });
		for (const [ v, d ] of declVars) {
			for (const m of text.matchAll(new RegExp('\\b' + v + '\\b(\\s*\\(([^,)]*))?', 'g'))) {
				const before = text.slice(Math.max(0, m.index - 80), m.index);
				if (/(?:var|let|const)\s+$/.test(before) && /^\s*=\s*rpc\.declare\(/.test(text.slice(m.index + v.length))) continue;
				if (m[1] == null || /[.\w$]$/.test(before)) { out.push(`${file}: ${v} used other than in a direct call at ${m.index}`); continue; }
				const arg = m[2].trim();
				if (d.obj === 'uci' && arg !== (file.endsWith(FIREWALL_VIEW) ? "'firewall'" : "'vantage'"))
					out.push(`${file}: ${v}(${arg}) (uci ${d.method})`);
				if (d.obj === 'file' && !(/^'[^']+'$/.test(arg) && Object.prototype.hasOwnProperty.call(READ_FILES, arg.slice(1, -1))))
					out.push(`${file}: ${v}(${arg}) not a literal granted path`);
			}
		}
		if (/'require fs'|\bfs\.(exec|exec_direct|write|remove)\(/.test(text)) out.push(`${file}: fs module`);
		if (/\buci\.(load|set|add|remove|save|apply)\(/.test(text)) out.push(`${file}: LuCI uci module`);
	}
	return out;
}

/* LuCI modules the firewall overview loads, its own and through its
   vantage.* modules: nothing that reads a config by itself */
const FIREWALL_REQUIRES = [ 'baseclass', 'rpc', 'ui', 'vantage.fwglance', 'view' ];
/* LuCI modules that load uci configs when required (network: network,
   wireless, luci; firewall and tools.*: firewall, network, ...) */
const CONFIG_LOADERS = /^(network|firewall|tools\..*|form|uci|fs)$/;

/* the modules LuCI loads for a class file: like luci.js, the leading
   string literals ('...' or "...", comments skipped) that are require
   directives, up to the first one that is neither that nor 'use strict' */
function requiresOf(text) {
	const REQ = /^require[ \t]+(\S+)(?:[ \t]+as[ \t]+([a-zA-Z_]\S*))?$/, STRICT = /^use[ \t]+strict$/;
	const out = [];
	for (let i = 0, off = -1, prev = -1, quote = -1, comment = -1, esc = false; i < text.length; i++) {
		const chr = text.charCodeAt(i);
		if (esc) esc = false;
		else if (comment !== -1) {
			if ((comment === 47 && chr === 10) || (comment === 42 && prev === 42 && chr === 47)) comment = -1;
		}
		else if ((chr === 42 || chr === 47) && prev === 47 && quote === -1) comment = chr;
		else if (chr === 92) esc = true;
		else if (chr === quote) {
			const lit = text.substring(off, i), m = REQ.exec(lit);
			if (m) out.push(m[1]);
			else if (!STRICT.exec(lit)) break;
			off = -1;
			quote = -1;
		}
		else if (quote === -1 && (chr === 34 || chr === 39)) { off = i + 1; quote = chr; }
		prev = chr;
	}
	return out;
}

function requireProblems(srcs) {
	const out = [];
	const byModule = new Map(srcs.map(s => [ s.file.replace(/^htdocs\/luci-static\/resources\//, '').replace(/\.js$/, '').replace(/\//g, '.'), s ]));
	for (const { file, text } of srcs) {
		for (const r of requiresOf(text)) if (CONFIG_LOADERS.test(r)) out.push(`${file}: 'require ${r}'`);
		/* L.require only with a literal vantage.* module as its whole
		   argument: the literal must close the call, so a literal prefix
		   followed by an expression ('vantage.x' + y) is not one */
		for (const m of text.matchAll(/\bL\s*\.\s*require\b\s*(\(\s*('[^']*'\s*\)|[^)]*))?/g))
			if (!m[2] || !/^'vantage\.[\w-]+'\s*\)$/.test(m[2].trim())) out.push(`${file}: L.require(${m[2] || ''})`);
	}
	/* the firewall overview's closure */
	const seen = new Set(), luci = new Set();
	const walk = mod => {
		if (seen.has(mod)) return;
		seen.add(mod);
		const src = byModule.get(mod);
		if (!src) { luci.add(mod); return; }
		for (const r of requiresOf(src.text)) {
			if (/^vantage\./.test(r)) { luci.add(r); walk(r); }
			else luci.add(r);
		}
	};
	walk('view.vantage.firewall');
	const got = [ ...luci ].sort();
	if (JSON.stringify(got) !== JSON.stringify(FIREWALL_REQUIRES)) out.push(`${FIREWALL_VIEW}: requires ${got.join(', ')}`);
	return out;
}

test('uci calls name the vantage config; file.read names a granted path; declared calls are only called directly', () => {
	assert.deepEqual(callProblems(sources), []);
});

test('the firewall overview requires only its pinned modules; no app file loads other configs through LuCI', () => {
	assert.deepEqual(requireProblems(sources), []);
	const fwv = sources.find(s => s.file.endsWith(FIREWALL_VIEW));
	assert.deepEqual(requiresOf(fwv.text), [ 'view', 'rpc', 'ui', 'vantage.fwglance' ]);
});

/* negative controls: each mutation of an in-memory copy must be caught */
function mutate(file, edit) {
	return sources.map(s => s.file.endsWith(file) ? { file: s.file, text: edit(s.text) } : s);
}

test('negative controls: a name declared in another file does not vouch for a call', () => {
	/* the dashboard declares callUciGet for uci; a second file declaring the
	   same name for the same object must still be held to its own rules */
	const extra = { file: 'htdocs/luci-static/resources/view/vantage/extra.js',
		text: "var callUciGet = rpc.declare({ object: 'uci', method: 'get', params: [ 'config' ] });\ncallUciGet('wireless');\n" };
	assert.match(callProblems(sources.concat([ extra ])).join('\n'), /extra\.js: callUciGet\('wireless'\)/);
	/* and a file without the declaration cannot call it at all unnoticed: the
	   name is undeclared there, so the call is not one of the app's calls */
	const borrow = { file: 'htdocs/luci-static/resources/view/vantage/borrow.js',
		text: "var callUciGet = rpc.declare({ object: 'uci', method: 'get', params: [ 'config' ] });\nvar g = callUciGet; g('wireless');\n" };
	assert.match(callProblems(sources.concat([ borrow ])).join('\n'), /borrow\.js: callUciGet used other than in a direct call/);
	/* the case a global name map missed: another file declares the same
	   name for a harmless object, and the dashboard's uci call reads wireless */
	const shadow = { file: 'htdocs/luci-static/resources/view/vantage/shadow.js',
		text: "var callUciGet = rpc.declare({ object: 'system', method: 'info' });\ncallUciGet();\n" };
	const mutant = mutate('view/vantage/overview.js', t => t + "\ncallUciGet('wireless');\n").concat([ shadow ]);
	assert.match(callProblems(mutant).join('\n'), /overview\.js: callUciGet\('wireless'\)/);
});

test('negative controls: an aliased or indirect call to a declared function fails', () => {
	const anchor = "\tload: function() {\n";
	for (const [ add, why ] of [
		[ "\t\tvar bypass = callUciGet; bypass('wireless');\n", /callUciGet used other than in a direct call/ ],
		[ "\t\tcallUciGet.call(null, 'wireless');\n", /callUciGet used other than in a direct call/ ],
		[ "\t\t[ callUciGet ][0]('wireless');\n", /callUciGet used other than in a direct call/ ],
		[ "\t\tL.resolveDefault(callUciGet('wireless'), null);\n", /callUciGet\('wireless'\)/ ],
		[ "\t\tvar c = 'wireless'; callUciGet(c);\n", /callUciGet\(c\)/ ]
	]) {
		const mutant = mutate(FIREWALL_VIEW, t => { assert.ok(t.includes(anchor)); return t.replace(anchor, anchor + add); });
		assert.match(callProblems(mutant).join('\n'), why, add.trim());
	}
	/* the same in the dashboard */
	assert.match(callProblems(mutate('view/vantage/overview.js', t => t + "\nvar f = callRead; f('/etc/shadow');\n")).join('\n'), /callRead used other than/);
});

test('negative controls: requiring a module that loads other configs fails', () => {
	const add = line => t => t.replace("'require ui';\n", "'require ui';\n" + line + "\n");
	for (const [ file, edit, why ] of [
		[ FIREWALL_VIEW, add("'require network';"), /'require network'/ ],
		[ FIREWALL_VIEW, add("'require tools.widgets as widgets';"), /'require tools\.widgets'/ ],
		[ FIREWALL_VIEW, add("\"require  network\";"), /'require network'/ ],
		[ FIREWALL_VIEW, add("/* x */ 'require\tnetwork as n';"), /'require network'/ ],
		[ FIREWALL_VIEW, add("'require poll';"), /requires .*poll/ ],
		[ 'vantage/fwglance.js', t => t.replace("'require baseclass';\n", "'require baseclass';\n'require firewall';\n"), /'require firewall'/ ],
		[ 'view/vantage/overview.js', t => t + "\nL.require('network');\n", /L\.require\('network'/ ],
		[ 'view/vantage/overview.js', t => t + "\nvar m = 'network'; L.require(m);\n", /L\.require\(m/ ],
		/* a literal prefix followed by an expression names any module */
		[ 'view/vantage/overview.js', t => t + "\nvar y = ''; L.require('vantage.x' + y);\n", /L\.require\('vantage\.x' \+ y/ ],
		[ 'view/vantage/overview.js', t => t + "\nL.require('vantage.x', 'network');\n", /L\.require\('vantage\.x', 'network'/ ]
	]) {
		const mutant = mutate(file, edit);
		assert.notDeepEqual(mutant, sources, 'the mutation applied');
		assert.match(requireProblems(mutant).join('\n'), why, file + ' ' + why);
	}
});

test('negative controls: a declare spelled to dodge the count is not analysable', () => {
	for (const add of [ "var x = rpc.declare ({ object: 'uci', method: 'get' });", "var d = rpc.declare; d({ object: 'uci', method: 'set' });", "rpc['declare']({ object: 'uci', method: 'set' });" ]) {
		const text = sources.find(s => s.file.endsWith(FIREWALL_VIEW)).text + '\n' + add + '\n';
		const total = (text.match(/\brpc\s*(?:\.\s*declare\b|\[)/g) || []).length;
		const literal = [ ...text.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g) ].length;
		assert.notEqual(total, literal, add);
	}
});

test('the view probes the names and rdns groups; the menu is gated by the read group', () => {
	const view = sources.find(s => s.file.endsWith('view/vantage/overview.js')).text;
	const probes = [ ...view.matchAll(/callAccess\('access-group', '([^']+)', '(\w+)'\)/g) ].map(m => m[1] + ' ' + m[2]);
	assert.deepEqual(probes, [ WRITE_GROUP + ' write', RDNS_GROUP + ' read' ]);
	assert.deepEqual(Object.keys(menu), [ 'admin/dashboard', 'admin/status/dashboard', 'admin/network/firewall/overview' ]);
	/* luci-mod-dashboard's page, behind that package's own group: Vantage grants nothing for it */
	assert.deepEqual(menu['admin/status/dashboard'].depends.acl, [ 'luci-mod-dashboard-index' ]);
	assert.ok(!('luci-mod-dashboard-index' in acl));
	assert.deepEqual(menu['admin/dashboard'].depends.acl, [ READ_GROUP ]);
});

test('the firewall overview: behind LuCI\'s firewall group, uci get on firewall and the interface dump, nothing else declared', () => {
	const entry = menu['admin/network/firewall/overview'];
	assert.deepEqual(entry.action, { type: 'view', path: 'vantage/firewall' });
	assert.deepEqual(entry.depends, { acl: [ 'luci-app-firewall' ], uci: { firewall: true } });
	/* no Vantage group mentions the firewall config */
	for (const [ name, g ] of Object.entries(acl))
		for (const kind of [ 'read', 'write' ])
			assert.ok(!((g[kind] || {}).uci || []).includes('firewall'), `${name}.${kind}: uci firewall`);
	const src = sources.find(s => s.file.endsWith(FIREWALL_VIEW));
	assert.ok(src, 'found the view');
	const declares = [ ...src.text.matchAll(/rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g) ].map(m => m[1] + ' ' + m[2]);
	assert.deepEqual(declares, [ 'uci get', 'network.interface dump' ]);
});
