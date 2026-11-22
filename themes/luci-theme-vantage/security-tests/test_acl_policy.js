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
 * - iwinfo survey is granted nowhere: rpcd serves it by calling a
 *   function libiwinfo has for its NL80211 backend only, so on any other
 *   (MediaTek's mtwifi in the mt798x builds) the call kills rpcd (#124);
 *   the noise floor comes from luci.vantage survey instead;
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
 *   the bridges' brforward and on /etc/board.json only, fs's access, on
 *   an interface's phy80211 link only, rtnl for one read-only dump of the
 *   bridge forwarding database (luci.vantage wired) and one route lookup
 *   a family, IPv4 and IPv6, of a documentation address (luci.vantage
 *   routes), and nl80211 for one read-only channel survey dump of an
 *   interface (luci.vantage survey); no other file access, no other
 *   netlink request, no process execution, and no module, cursor or
 *   connection passed on under another name; altered copies of the
 *   plugin check that these rules catch each breach;
 * - every rpc.declare({ object, method }) in the app's JavaScript is
 *   granted, and every grant is used by a declare (no stale privilege);
 *   `session access` is the only call left to the platform (rpcd grants it
 *   to every session through its `unauthenticated` group);
 * - two declared calls are granted by no group of the dashboard, each by
 *   another package's own group, and by name: the add-on's
 *   `vantage.collector report` (below), and LuCI's `luci.wireguard
 *   getWgInstances` (luci-proto-wireguard's rpcd plugin, the call of its
 *   status page: the WireGuard interfaces and their peers, without
 *   private or preshared keys; it takes no argument and writes nothing).
 *   LuCI's group luci-proto-wireguard grants that one to read, so only a
 *   login that holds that group is answered; the dashboard's ACL says
 *   nothing of the object. It is declared once, in the dashboard, in one
 *   exact form without parameters, and called without arguments; the
 *   object's other methods, which make keys, are declared nowhere;
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
 * - the view probes exactly four groups: its names group (write), its
 *   rdns group (read), the add-on's view group (read) and LuCI's
 *   luci-proto-wireguard (read);
 * - the dashboard's menu entry is gated by the read group; the firewall
 *   overview's (Network -> Firewall -> Overview) by luci-app-firewall,
 *   LuCI's own group for the firewall pages, which already lets its holder
 *   read and change `firewall`: the app grants nothing for it.
 *
 * luci-app-vantage-aps, the opt-in add-on that pairs devices over SSH
 * (VANTAGE_APS_PKG: another copy of it):
 *
 * - two groups. `luci-app-vantage-aps`, for administrators:
 *   luci.vantage.pair status and vantage.collector report to read, the
 *   pairing methods to write, and nothing else; its page declares exactly
 *   those, its menu entry is gated by it. `luci-app-vantage-aps-view`:
 *   vantage.collector report to read and nothing else, for a login that
 *   may see the access points on the dashboard; the dashboard's own
 *   groups grant nothing of the add-on, so a login with the dashboard
 *   alone cannot make the router log in to its access points;
 * - the pairing plugin (luci.vantage-pair) registers exactly those
 *   methods; it runs dropbearkey to make the router's key and the
 *   collector's init script with fixed words, writes /etc/vantage/aps.json
 *   and, through a temporary file and a rename, authorized_keys, adding
 *   only the line vantage.aps auth_line makes (the report command, no
 *   pty, no forwarding);
 *   it reads only its own files, dropbear's binary, host key and config,
 *   the hostname and 8 random bytes, and asks ubus for dropbear's state,
 *   the LAN address and, when it pairs an access point, this router's
 *   interfaces (the network that access point is on, kept by name) only;
 * - the report (the forced command) writes nothing, runs nothing, reads
 *   only sysfs, the neighbour table, the hostname and authorized_keys
 *   (for the line it was let in by), takes SSH_CLIENT and SSH_PUBKEYINFO
 *   and nothing else from its environment, and makes read calls only;
 * - the collector runs dbclient alone, with the host key pinned
 *   (StrictHostKeyChecking=yes), batch mode and no passwords, the access
 *   point's address and port as arguments, never through a shell word;
 *   it writes only the known_hosts it hands dbclient, removes only what
 *   it made under its run directory, asks ubus for this router's
 *   interfaces only, and publishes vantage.collector report only;
 * - the shared checks (vantage.aps) import nothing; the key line is made
 *   and known again there, in one form.
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
	'luci.vantage': [ 'routes', 'survey', 'thermal', 'wired', 'wireless' ],
	/* not survey (#124): luci.vantage survey reads it through nl80211 */
	'iwinfo': [ 'assoclist', 'info' ],
	'hostapd.*': [ 'get_clients', 'get_status' ],
	'umdns': [ 'hosts' ],
	'uci': [ 'get' ]
};
/* The dashboard also declares luci-app-vantage-aps' collector (what the
   paired access points report). No group of the dashboard grants it: the
   add-on's view group does (APS_VIEW_GROUP, below), so without the add-on,
   or for a login without that group, the call fails and the dashboard
   shows no access points. */
const COLLECTOR_CALL = 'vantage.collector report';
/* And LuCI's own WireGuard status (luci-proto-wireguard's rpcd plugin):
   `wg show all dump` by interface, each with its peers (name, public key,
   endpoint, allowed IPs, last handshake, byte counters, keepalive); the
   plugin leaves the private and the preshared keys out, takes no argument
   and writes nothing. No group of the dashboard grants it either: LuCI's
   group for it does (WIREGUARD_GROUP, read), so the call fails for a
   login without that group, and where the package is not installed. This
   one method only, declared in this one form: the object's others
   (generateKeyPair, generatePsk, getPublicAndPrivateKeyFromPrivate) make
   or take private keys. */
const WIREGUARD_CALL = 'luci.wireguard getWgInstances';
const WIREGUARD_GROUP = 'luci-proto-wireguard';
const WIREGUARD_DECLARE = "var callWireguard = rpc.declare({ object: 'luci.wireguard', method: 'getWgInstances', expect: { '': {} }, reject: true });";
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
function analyse(srcs) {
	const declared = new Map();          /* 'obj method' -> [file] */
	const vars = new Map();              /* callVar -> { obj, method } */
	const problems = [];
	const DECL = /(?:var|let|const)\s+(\w+)\s*=\s*rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g;
	for (const { file, text } of srcs) {
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

const { declared, vars, problems } = analyse(sources);

/* what the dashboard's groups grant, read and write together */
function grantedCalls() {
	return new Set([ ...pairs(acl[READ_GROUP].read.ubus), ...pairs(acl[RDNS_GROUP].read.ubus),
		...pairs(acl[WRITE_GROUP].read.ubus), ...pairs(acl[WRITE_GROUP].write.ubus) ]);
}
/* The calls `srcs` (the real sources, or a mutated copy) declare that
   none of those groups grants, the platform's aside: each must be one of
   the two named above, a read another package's own group grants. */
function foreignCalls(srcs) {
	const granted = grantedCalls();
	return [ ...analyse(srcs).declared.keys() ].filter(k => !PLATFORM.has(k) && !granted.has(k)).sort();
}
/* LuCI's WireGuard status in `srcs`: one declare of the object, in the
   dashboard, exactly WIREGUARD_DECLARE (this method, no parameters, so no
   argument can be sent), and no call that passes one. */
function wireguardProblems(srcs) {
	const out = [];
	let declares = 0;
	for (const { file, text } of srcs) {
		for (const m of text.matchAll(/^.*\bobject\s*:\s*['"]luci\.wireguard\b.*$/gm)) {
			declares++;
			if (!file.endsWith('view/vantage/overview.js') || m[0] !== WIREGUARD_DECLARE) out.push(`${file}: ${m[0].trim()}`);
		}
		for (const m of text.matchAll(/\bcallWireguard\b\s*\(([^)]*)\)/g))
			if (m[1].trim() !== '') out.push(`${file}: callWireguard(${m[1]})`);
	}
	if (declares !== 1) out.push(`${declares} declares of luci.wireguard`);
	return out;
}

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

test('no group grants iwinfo survey, which kills rpcd on drivers other than nl80211\'s (#124)', () => {
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ])
		assert.ok(!pairs((g[kind] || {}).ubus).has('iwinfo survey'), `${name}.${kind}: iwinfo survey`);
	assert.ok(pairs(acl[READ_GROUP].read.ubus).has(PLUGIN_OBJECT + ' survey'), 'the noise floor through the plugin');
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
	assert.deepEqual(methods, [ 'routes', 'set_alias', 'set_quiet', 'survey', 'thermal', 'wired', 'wireless' ]);
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
		'import * as rtnl from \'rtnl\';',
		'import * as nl80211 from \'nl80211\';',
		'import { cursor } from \'uci\';',
		'import { connect } from \'ubus\';',
		'import { access, lsdir, readfile } from \'fs\';'
	]);
	const word = /\b(system|popen|exec|require|loadfile|loadstring|include|render|writefile|unlink|global)\b/.exec(src);
	assert.equal(word, null, word && `"${word[1]}" is banned in the plugin, as a word${REWORD}`);
	assert.doesNotMatch(src, /(^|[^.\w])call\s*\(/m, 'the call() builtin is banned in the plugin');
	/* fs: only the thermal zones under /sys/class/thermal, the
	   bridges' forwarding counts (brforward) under /sys/class/net, the
	   board description, and whether an interface has a phy80211 link
	   (access) */
	assert.match(src, /^const THERMAL = '\/sys\/class\/thermal';$/m);
	assert.match(src, /^const NET = '\/sys\/class\/net';$/m);
	assert.match(src, /^const BOARD = '\/etc\/board\.json';$/m);
	const fsCalls = [ ...src.matchAll(/\b(lsdir|readfile|access)\(([^,)]*)/g) ].map(m => m[1] + '(' + m[2]);
	assert.ok(fsCalls.length >= 6, 'found the fs calls');
	for (const c of fsCalls) assert.match(c, /^(lsdir\(THERMAL$|readfile\(THERMAL \+ '\/' \+ n \+ '\/(temp|type)'|lsdir\(NET$|readfile\(NET \+ '\/' \+ n \+ '\/brforward'|readfile\(BOARD|access\(NET \+ '\/' \+ dev \+ '\/phy80211')$/, c);
	assert.equal([ ...src.matchAll(/\baccess\b/g) ].length, 2, `"access" may appear only on its import and the phy80211 check${REWORD}`);
	/* each path constant only in its definition and those calls, so no
	   `let BOARD = ...` can shadow one; board.json read up to BOARD_MAX */
	for (const [ name, uses ] of [ [ 'THERMAL', 4 ], [ 'NET', 4 ], [ 'BOARD', 2 ] ])
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

	/* nl80211: one request, the read-only channel survey dump (a GET
	   with NLM_F_DUMP, never a SET, NEW, DEL or TRIGGER) of the one
	   interface asked about, and nothing else */
	const survey = 'let res = nl80211.request(nl80211.const.NL80211_CMD_GET_SURVEY, nl80211.const.NLM_F_DUMP, { dev });';
	assert.deepEqual([ ...src.matchAll(/^.*\bnl80211\b.*$/gm) ].map(m => m[0].trim()), [ 'import * as nl80211 from \'nl80211\';', survey ],
		`"nl80211" may appear only on its import and the survey dump${REWORD}`);
}

test('the plugin source rules catch writes, other configs and calls, and names passed on', () => {
	const at = '\tlet wl = cursor();\n';
	assert.ok(plugin.includes(at), 'insertion point');
	const add = code => plugin.replace(at, at + '\t' + code + '\n');
	const MUTANTS = {
		'renamed import': add('let w = rw(); w.set(\'wireless\', \'x\', \'encryption\', \'none\'); w.commit(\'wireless\');')
			.replace('import { cursor } from \'uci\';', 'import { cursor, cursor as rw } from \'uci\';'),
		'second import': plugin.replace('import { connect } from \'ubus\';', 'import { connect } from \'ubus\';\nimport * as u from \'uci\';'),
		'fs write': plugin.replace('import { access, lsdir, readfile } from \'fs\';', 'import { access, lsdir, readfile, writefile } from \'fs\';'),
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
		'other rtnl member': add('let e = rtnl.error();'),
		'nl80211 write': plugin.replace('nl80211.const.NL80211_CMD_GET_SURVEY, nl80211.const.NLM_F_DUMP', 'nl80211.const.NL80211_CMD_SET_INTERFACE, 0'),
		'second nl80211 request': add('nl80211.request(nl80211.const.NL80211_CMD_TRIGGER_SCAN, 0, { dev: \'phy0-ap0\' });'),
		'survey of another interface': plugin.replace('nl80211.const.NLM_F_DUMP, { dev });', 'nl80211.const.NLM_F_DUMP, { dev: \'phy0-ap0\' });'),
		'nl80211 by reference': add('let n = nl80211;'),
		'access elsewhere': add('let seen = access(\'/etc/shadow\');'),
		'access by reference': add('let a = access;')
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
	const granted = grantedCalls();
	/* the two calls another package's group grants, and no third: LuCI's WireGuard status (its own test below),
	   and the collector's report, which the add-on's view group grants, and that group grants nothing else */
	assert.deepEqual(foreignCalls(sources), [ WIREGUARD_CALL, COLLECTOR_CALL ], 'declared but not granted by the dashboard');
	assert.deepEqual([ ...pairs(apsAcl[APS_VIEW_GROUP].read.ubus) ], [ COLLECTOR_CALL ]);
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

test('the view probes the names and rdns groups, the add-on\'s for the access points and LuCI\'s for WireGuard; the menu is gated by the read group', () => {
	const view = sources.find(s => s.file.endsWith('view/vantage/overview.js')).text;
	const probes = [ ...view.matchAll(/callAccess\('access-group', '([^']+)', '(\w+)'\)/g) ].map(m => m[1] + ' ' + m[2]);
	/* the third: asked once, so that a login without the add-on's read group (or without the add-on) never calls its collector;
	   the last, likewise, LuCI's own group for its WireGuard status: without it (or without luci-proto-wireguard) no call */
	assert.deepEqual(probes, [ WRITE_GROUP + ' write', RDNS_GROUP + ' read', APS_VIEW_GROUP + ' read', WIREGUARD_GROUP + ' read' ]);
	assert.deepEqual(Object.keys(menu), [ 'admin/dashboard', 'admin/status/dashboard', 'admin/network/firewall/overview' ]);
	/* luci-mod-dashboard's page, behind that package's own group: Vantage grants nothing for it */
	assert.deepEqual(menu['admin/status/dashboard'].depends.acl, [ 'luci-mod-dashboard-index' ]);
	assert.ok(!('luci-mod-dashboard-index' in acl));
	assert.deepEqual(menu['admin/dashboard'].depends.acl, [ READ_GROUP ]);
});

test('LuCI\'s WireGuard status: this one read, declared once without parameters, asked for only by a login that holds LuCI\'s group; the dashboard grants nothing of it', () => {
	assert.deepEqual(wireguardProblems(sources), []);
	const view = sources.find(s => s.file.endsWith('view/vantage/overview.js')).text;
	assert.ok(view.includes('\n' + WIREGUARD_DECLARE + '\n'), 'the declare, a line of its own');
	assert.doesNotMatch(WIREGUARD_DECLARE, /\b(params|filter|nobatch)\b/);
	/* one call, behind the answer about LuCI's group: any other login, and a router without the package, asks for nothing */
	assert.equal([ ...view.matchAll(/\bcallWireguard\s*\(/g) ].length, 1, 'called in one place');
	assert.ok(view.includes("\t\tif (!this.wgMay) this.wgMay = L.resolveDefault(callAccess('access-group', '" + WIREGUARD_GROUP + "', 'read'), false);\n" +
		"\t\treturn this.wgMay.then(function(may) {\n\t\t\tif (may !== true) { self.wgOff = true; return null; }\n\t\t\tvar asked = Date.now();\n\t\t\treturn callWireguard().then("),
		'the call follows a yes about the group, and nothing else');
	assert.equal([ ...view.matchAll(/\b\w+\.wgMay\b/g) ].length, 3, 'the answer about the group is set in one place and read in one');
	/* no group of the dashboard, and none of the add-on, mentions the object or LuCI's group: the ACL files stay as they were */
	for (const [ name, g ] of Object.entries(acl).concat(Object.entries(apsAcl))) {
		assert.notEqual(name, WIREGUARD_GROUP);
		for (const kind of [ 'read', 'write' ])
			for (const k of pairs((g[kind] || {}).ubus)) assert.ok(!/^luci\.wireguard\b/.test(k), `${name}.${kind}: ${k}`);
	}
	assert.doesNotMatch(JSON.stringify(acl) + JSON.stringify(apsAcl), /wireguard/i);
});

test('negative controls: any other call no group grants, another method or form of LuCI\'s WireGuard call, or an argument to it, fails', () => {
	const DASH = 'view/vantage/overview.js';
	const swap = to => mutate(DASH, t => { assert.ok(t.includes(WIREGUARD_DECLARE)); return t.replace(WIREGUARD_DECLARE, to); });
	const add = (file, code) => mutate(file, t => t + '\n' + code + '\n');
	/* the allowance is for that one call: nothing else rides on it */
	for (const [ what, mutant, extra ] of [
		[ 'a method that makes keys', add(DASH, "var callWgKeys = rpc.declare({ object: 'luci.wireguard', method: 'generateKeyPair' });"), 'luci.wireguard generateKeyPair' ],
		[ 'the method that takes a private key', add(DASH, "var callWgPub = rpc.declare({ object: 'luci.wireguard', method: 'getPublicAndPrivateKeyFromPrivate', params: [ 'privkey' ] });"), 'luci.wireguard getPublicAndPrivateKeyFromPrivate' ],
		[ 'another object nobody grants', add(DASH, "var callExec = rpc.declare({ object: 'file', method: 'exec', params: [ 'command' ] });"), 'file exec' ],
		[ 'a LuCI call the dashboard has no grant for', add(DASH, "var callWl = rpc.declare({ object: 'luci-rpc', method: 'getWirelessDevices' });"), 'luci-rpc getWirelessDevices' ],
		[ 'the same in the firewall overview', add(FIREWALL_VIEW, "var callWgKeys = rpc.declare({ object: 'luci.wireguard', method: 'generatePsk' });"), 'luci.wireguard generatePsk' ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.deepEqual(foreignCalls(mutant), [ WIREGUARD_CALL, COLLECTOR_CALL, extra ].sort(), what);
		assert.notDeepEqual(foreignCalls(mutant), [ WIREGUARD_CALL, COLLECTOR_CALL ], what);
	}
	/* its one form: this method, no parameters, in the dashboard, once */
	for (const [ what, mutant, why ] of [
		[ 'a parameter', swap(WIREGUARD_DECLARE.replace("method: 'getWgInstances',", "method: 'getWgInstances', params: [ 'privkey' ],")), /overview\.js: var callWireguard = .*params/ ],
		[ 'another method under the name', swap(WIREGUARD_DECLARE.replace('getWgInstances', 'generateKeyPair')), /overview\.js: var callWireguard = .*generateKeyPair/ ],
		[ 'a filter on the reply', swap(WIREGUARD_DECLARE.replace('reject: true', 'reject: true, filter: function(r) { return r; }')), /overview\.js: var callWireguard = .*filter/ ],
		[ 'double quotes', swap(WIREGUARD_DECLARE.replace("'luci.wireguard'", '"luci.wireguard"')), /overview\.js: var callWireguard = / ],
		[ 'a second declare', add(DASH, "var callWg2 = rpc.declare({ object: 'luci.wireguard', method: 'getWgInstances', params: [ 'x' ] });"), /2 declares of luci\.wireguard/ ],
		[ 'a declare in a module', add('vantage/model.js', WIREGUARD_DECLARE), /model\.js: var callWireguard = / ],
		[ 'the declare moved to the firewall overview', add(FIREWALL_VIEW, WIREGUARD_DECLARE).map(s => s.file.endsWith(DASH) ? { file: s.file, text: s.text.replace(WIREGUARD_DECLARE, '') } : s), /firewall\.js: var callWireguard = / ],
		[ 'no declare at all', swap(''), /0 declares of luci\.wireguard/ ],
		[ 'an argument', add(DASH, "callWireguard('privkey');"), /overview\.js: callWireguard\('privkey'\)/ ],
		[ 'an argument, spaced', add(DASH, 'callWireguard ( { privkey: k } );'), /overview\.js: callWireguard\( \{ privkey: k \} \)/ ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.match(wireguardProblems(mutant).join('\n'), why, what);
	}
	/* and it is only ever called directly, like every declared call */
	assert.match(callProblems(add(DASH, 'var w = callWireguard; w();')).join('\n'), /overview\.js: callWireguard used other than in a direct call/);
	assert.match(callProblems(add(DASH, "callWireguard.call(null, 'x');")).join('\n'), /overview\.js: callWireguard used other than in a direct call/);
	/* a declare spelled so that its object is not a literal is no declare the analysis can read */
	assert.match(analyse(add(DASH, "var callW = rpc.declare({ object: 'luci.' + 'wireguard', method: 'generatePsk' });")).problems.join('\n'), /overview\.js: 1 rpc\.declare\(\) call\(s\) with a non-literal object or method/);
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

/* ------------------------------------------------ luci-app-vantage-aps */

const APS_PKG = path.resolve(process.env.VANTAGE_APS_PKG || path.join(__dirname, '..', 'luci-app-vantage-aps'));
const APS_GROUP = 'luci-app-vantage-aps';
const APS_VIEW_GROUP = 'luci-app-vantage-aps-view';
const PAIR_OBJECT = 'luci.vantage.pair';
const APS_READ = { 'luci.vantage.pair': [ 'status' ], 'vantage.collector': [ 'report' ] };
const APS_WRITE = { 'luci.vantage.pair': [ 'add_ap', 'allow_router', 'remove_ap', 'revoke_router', 'router_code' ] };
const apsFile = rel => fs.readFileSync(path.join(APS_PKG, rel), 'utf8');
const apsAcl = JSON.parse(apsFile('root/usr/share/rpcd/acl.d/luci-app-vantage-aps.json'));
const apsMenu = JSON.parse(apsFile('root/usr/share/luci/menu.d/luci-app-vantage-aps.json'));
const pairPlugin = apsFile('root/usr/share/rpcd/ucode/luci.vantage-pair');
const reportSrc = apsFile('root/usr/libexec/vantage/report');
const collectorSrc = apsFile('root/usr/libexec/vantage/collector');
const apsModule = apsFile('root/usr/share/ucode/vantage/aps.uc');
const apsSources = jsFiles(path.join(APS_PKG, 'htdocs')).map(f => ({ file: path.relative(APS_PKG, f), text: fs.readFileSync(f, 'utf8') }));

/* the lines of src that hold `word` (trimmed) */
const linesWith = (src, word) => [ ...src.matchAll(new RegExp('^.*\\b' + word + '\\b.*$', 'gm')) ].map(m => m[0].trim());
const count = (src, word) => [ ...src.matchAll(new RegExp('\\b' + word + '\\b', 'g')) ].length;

test('add-on: two groups: pairing for administrators, and seeing the access points; nothing else', () => {
	assert.deepEqual(Object.keys(apsAcl).sort(), [ APS_GROUP, APS_VIEW_GROUP ].sort());
	const g = apsAcl[APS_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read', 'write' ]);
	assert.deepEqual(g.read, { ubus: APS_READ });
	assert.deepEqual(g.write, { ubus: APS_WRITE });
	assert.match(g.description, /authorized_keys/);
	assert.match(g.description, /administrators only/);
	/* the view group: the collector's report to read, no write section at all; its description says what a call does */
	const v = apsAcl[APS_VIEW_GROUP];
	assert.deepEqual(Object.keys(v).sort(), [ 'description', 'read' ]);
	assert.deepEqual(v.read, { ubus: { 'vantage.collector': [ 'report' ] } });
	assert.match(v.description, /log in to them over SSH/);
	/* the dashboard's groups grant nothing of the add-on: not the pairing, and not the report either, which makes
	   the router log in to every access point and shows their clients */
	for (const [ name, grp ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ])
		for (const k of pairs((grp[kind] || {}).ubus)) assert.ok(!k.startsWith(PAIR_OBJECT + ' ') && !k.startsWith('vantage.collector '), `${name}.${kind}: ${k}`);
});

test('add-on: its page declares exactly the group\'s calls; its menu entry is gated by the group', () => {
	const declares = new Set(), problems = [];
	for (const { file, text } of apsSources) {
		const total = (text.match(/\brpc\s*(?:\.\s*declare\b|\[)/g) || []).length;
		const found = [ ...text.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g) ];
		if (found.length !== total) problems.push(file);
		for (const m of found) declares.add(m[2] + ' ' + m[3]);
	}
	assert.deepEqual(problems, [], 'every declare literal');
	const granted = new Set([ ...pairs(APS_READ), ...pairs(APS_WRITE) ]);
	assert.deepEqual([ ...declares ].filter(k => !PLATFORM.has(k)).sort(), [ ...granted ].sort());
	assert.deepEqual(callProblems(apsSources), []);
	const entries = Object.values(apsMenu);
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0].depends.acl, [ APS_GROUP ]);
	assert.deepEqual(entries[0].action, { type: 'view', path: 'vantage/aps' });
});

/* The add-on's source rules. Each table below lists, for a set of names,
   every line of code that may mention one of them (comment lines are left
   out; template literals are refused, so a line that starts with // is a
   comment and nothing else). A call under another name, with other
   arguments, through an alias or a computed member, or with a space before
   its bracket, is a line that is not listed: change a listed line and this
   test changes with it, on purpose. */
function codeOf(src, what) {
	assert.ok(!src.includes('`'), what + ': no template literals (code in ${} would hide from these rules)');
	return src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}
function checkPins(src, what, pins) {
	const code = codeOf(src, what);
	for (const [ re, expected ] of pins)
		assert.deepEqual([ ...code.matchAll(new RegExp('^.*(?:' + re + ').*$', 'gm')) ].map(m => m[0].trim()), expected,
			what + ': the lines that mention /' + re + '/' + REWORD);
}

const PAIR_PATHS = {
	DIR: '/etc/vantage', KEY: '/etc/vantage/id_ed25519', APS: '/etc/vantage/aps.json', APS_TMP: '/etc/vantage/aps.json.tmp',
	AUTH: '/etc/dropbear/authorized_keys', AUTH_TMP: '/etc/dropbear/authorized_keys.vantage', HOST_KEY: '/etc/dropbear/dropbear_ed25519_host_key',
	DROPBEAR: '/usr/sbin/dropbear', DBCLIENT: '/usr/bin/dbclient', DROPBEARKEY: '/usr/bin/dropbearkey', COLLECTOR: '/etc/init.d/vantage-collector',
	HOSTNAME: '/proc/sys/kernel/hostname', RANDOM: '/dev/urandom', NET: '/sys/class/net'
};
/* files and programs; ubus; uci; its own writers; what reaches
   authorized_keys; a parsed router code; computed members */
const PAIR_PINS = [
	/* the network kept with a pairing: netifd's word for where the address is, never the caller's */
	[ '\\b(?:net|entry)\\b', [
		'const NET = \'/sys/class/net\';',
		'let entry = { id, name: a.name, key: a.key, addr: vaps.addr(args.addr) ?? a.addr, port: a.port, mac: a.mac };',
		'let net = vaps.net_of(entry.addr, connect(null, 3)?.call(\'network.interface\', \'dump\')?.interface);',
		'if (net)',
		'entry.net = net;',
		'push(list, entry);',
		'aps: map(list ?? [], (e) => ({ id: e.id, name: e.name, addr: e.addr, port: e.port, ...(e.net ? { net: e.net } : {}) })),'
	] ],
	/* what each method takes from its caller */
	[ '\\bargs:', [
		'args: { code: \'code\', addr: \'addr\' },',
		'args: { id: \'id\' },',
		'args: { code: \'code\' },',
		'args: { key: \'key\' },'
	] ],
	[ '\\b(?:access|chmod|lstat|mkdir|readfile|rename|stat|writefile|put|whole|max)\\b', [
		'import { access, chmod, lstat, mkdir, readfile, rename, stat, writefile } from \'fs\';',
		'let b = readfile(file, 84);',
		'function put(tmp, file, text) {',
		'return writefile(tmp, text) != null && stat(tmp)?.size === length(text) && chmod(tmp, 0600) && rename(tmp, file) === true;',
		'return vaps.name_of(trim(readfile(HOSTNAME, 256) ?? \'\'), fallback);',
		'function whole(file, max) {',
		'let text = readfile(file, max + 1);',
		'return lstat(file) ? null : \'\';',
		'return (length(text) <= max) ? text : null;',
		'let text = whole(APS, MAX_APS_FILE);',
		'mkdir(DIR, 0700);',
		'return put(APS_TMP, APS, sprintf(\'%J\', list));',
		'let r = readfile(RANDOM, 8);',
		'if (!access(DBCLIENT, \'x\'))',
		'if (!stat(KEY)) {',
		'mkdir(DIR, 0700);',
		'/* ----------------------------------------------------- access point */',
		'let s = stat(DROPBEAR), sig = s ? s.size + \'/\' + s.mtime : null;',
		'let b = readfile(DROPBEAR, MAX_DROPBEAR);',
		'let m = dev ? match(lc(trim(readfile(NET + \'/\' + dev + \'/address\', 64) ?? \'\')), RE_MAC) : null;',
		'let text = whole(AUTH, MAX_AUTH);',
		'if (!access(DROPBEAR, \'x\'))',
		'return length(text) <= MAX_AUTH && put(AUTH_TMP, AUTH, text);',
		'return (k && l) ? vaps.ap_code(k, l.addr, dropbear_conf().port, l.mac, hostname(\'access-point\')) : null;',
		'let k = access(DBCLIENT, \'x\') ? public_key(KEY) : null, ssh = ssh_state(), auth = read_auth(), list = load_aps();'
	] ],
	[ '\\bsystem\\b', [
		'system([ DROPBEARKEY, \'-t\', \'ed25519\', \'-f\', KEY ], 30000);',
		'system([ COLLECTOR, \'enable\' ], 10000);',
		'system([ COLLECTOR, \'start\' ], 10000);',
		'system([ COLLECTOR, \'stop\' ], 10000);',
		'system([ COLLECTOR, \'disable\' ], 10000);'
	] ],
	[ '\\b(?:connect|call|ubus)\\b', [
		'import { connect } from \'ubus\';',
		'let net = vaps.net_of(entry.addr, connect(null, 3)?.call(\'network.interface\', \'dump\')?.interface);',
		'function lan(ubus) {',
		'let st = (ubus ?? connect(null, 3))?.call(\'network.interface.lan\', \'status\');',
		'let ubus = connect(null, 3);',
		'let svc = ubus?.call(\'service\', \'list\', { name: \'dropbear\' })?.dropbear?.instances, running = false;',
		'return lan(ubus) ? \'ok\' : \'no-address\';',
		'function reply(ubus) {',
		'let k = public_key(HOST_KEY), l = lan(ubus);',
		'call: function() {',
		'call: function() {',
		'call: function(req) {',
		'call: function(req) {',
		'call: function(req) {',
		'call: function(req) {'
	] ],
	[ '\\b(?:cursor|uci)\\b', [
		'import { cursor } from \'uci\';',
		'const OFF = [ \'0\', \'off\', \'false\', \'no\', \'disabled\' ];   // uci\'s ways to say no',
		'let uci = cursor(), found = null;',
		'if (uci.load(\'dropbear\'))',
		'uci.foreach(\'dropbear\', \'dropbear\', (s) => {'
	] ],
	[ '\\b(?:save_aps|write_auth|read_auth|public_key)\\b', [
		'function public_key(file) {',
		'function save_aps(list) {',
		'let k = public_key(KEY);',
		'if (a.key === public_key(HOST_KEY))',
		'if (!public_key(KEY))',
		'if (!save_aps(list))',
		'if (!save_aps(left))',
		'function read_auth() {',
		'if (!public_key(HOST_KEY))',
		'if (!read_auth())',
		'function write_auth(lines) {',
		'let k = public_key(HOST_KEY), l = lan(ubus);',
		'let auth = read_auth();',
		'if (!write_auth(auth.lines))',
		'let k = vaps.key(args.key), auth = k ? read_auth() : null;',
		'return write_auth(left) ? { ok: true } : { error: \'failed\' };',
		'let k = access(DBCLIENT, \'x\') ? public_key(KEY) : null, ssh = ssh_state(), auth = read_auth(), list = load_aps();'
	] ],
	[ '\\bauth\\b|\\blines\\b|\\bours\\b', [
		'let lines = (text == \'\') ? [] : split(text, \'\\n\'), ours = [];',
		'if (length(lines) && lines[length(lines) - 1] == \'\')',
		'pop(lines);',
		'for (let i = 0; i < length(lines); i++) {',
		'let o = vaps.parse_auth_line(lines[i]);',
		'push(ours, { key: o.key, name: o.name, at: i });',
		'return { lines, ours };',
		'function write_auth(lines) {',
		'let text = length(lines) ? join(\'\\n\', lines) + \'\\n\' : \'\';',
		'let auth = read_auth();',
		'if (!auth)',
		'for (let o in auth.ours)',
		'for (let l in auth.lines)',
		'if (length(auth.ours) >= vaps.MAX_ROUTERS)',
		'push(auth.lines, vaps.auth_line(r.key, r.name));',
		'if (!write_auth(auth.lines))',
		'let k = vaps.key(args.key), auth = k ? read_auth() : null;',
		'if (!auth)',
		'for (let o in auth.ours)',
		'for (let i = 0; i < length(auth.lines); i++)',
		'push(left, auth.lines[i]);',
		'let k = access(DBCLIENT, \'x\') ? public_key(KEY) : null, ssh = ssh_state(), auth = read_auth(), list = load_aps();',
		'let routers = map(auth?.ours ?? [], (o) => ({ name: o.name, key: o.key }));',
		'ap: { ssh, routers, unread: !auth, reply: (ssh == \'ok\' && length(routers)) ? reply() : null }'
	] ],
	[ '\\b(?:KEY_OPTIONS|COMMENT|auth_line|parse_auth_line)\\b', [
		'let o = vaps.parse_auth_line(lines[i]);',
		'push(auth.lines, vaps.auth_line(r.key, r.name));'
	] ],
	[ '\\br\\b', [
		'let r = readfile(RANDOM, 8);',
		'if (type(r) != \'string\' || length(r) != 8)',
		'h += sprintf(\'%02x\', ord(r, i));',
		'let r = vaps.parse_router(args.code);',
		'if (!r)',
		'if (o.key == r.key)',
		'if (index(l, r.key) >= 0)',
		'push(auth.lines, vaps.auth_line(r.key, r.name));'
	] ],
	[ '\\[\\s*[\'"]', [
		'const OFF = [ \'0\', \'off\', \'false\', \'no\', \'disabled\' ];   // uci\'s ways to say no',
		'let a = (type(st?.[\'ipv4-address\']) == \'array\' && type(st[\'ipv4-address\'][0]) == \'object\') ? vaps.addr(st[\'ipv4-address\'][0].address) : null;'
	] ]
];
function checkPairSource(src) {
	assert.deepEqual(linesWith(src, 'import'), [
		'import { access, chmod, lstat, mkdir, readfile, rename, stat, writefile } from \'fs\';',
		'import { connect } from \'ubus\';',
		'import { cursor } from \'uci\';',
		'import * as vaps from \'vantage.aps\';'
	]);
	const word = /\b(popen|exec|require|loadfile|loadstring|include|render|unlink|global|getenv|open|symlink|rmdir|signal|sleep|exit)\b/.exec(codeOf(src, 'the pairing plugin'));
	assert.equal(word, null, word && `"${word[1]}" is banned in the pairing plugin`);
	/* the paths: each defined once, literally, never shadowed or assigned */
	for (const [ name, v ] of Object.entries(PAIR_PATHS)) {
		assert.ok(src.includes('\nconst ' + name + ' = \'' + v + '\';\n'), name + ' = ' + v);
		assert.equal([ ...src.matchAll(new RegExp('\\b' + name + '\\s*=(?!=)', 'g')) ].length, 1, name + ' is defined once and never assigned');
	}
	checkPins(src, 'the pairing plugin', PAIR_PINS);
}

test('add-on: the pairing plugin registers the granted methods and runs, writes and reads only what it lists', () => {
	assert.match(pairPlugin, /^return \{ 'luci\.vantage\.pair': methods \};\s*$/m);
	const table = /^const methods = \{\n([\s\S]*?)\n\};$/m.exec(pairPlugin);
	assert.ok(table, 'methods table');
	const methods = [ ...table[1].matchAll(/^\t([A-Za-z_]+): \{$/gm) ].map(m => m[1]).sort();
	assert.deepEqual(methods, [ ...APS_READ[PAIR_OBJECT], ...APS_WRITE[PAIR_OBJECT] ].sort());
	checkPairSource(pairPlugin);
});

test('add-on: the pairing plugin rules catch each breach', () => {
	const at = '\tlet r = vaps.parse_router(args.code);\n';
	assert.ok(pairPlugin.includes(at), 'insertion point');
	const add = code => pairPlugin.replace(at, at + '\t' + code + '\n');
	const MUTANTS = {
		'a line of its own making': pairPlugin.replace('push(auth.lines, vaps.auth_line(r.key, r.name));', 'push(auth.lines, \'no-pty ssh-ed25519 \' + r.key + \' vantage-router@\' + r.name);'),
		'the pasted line as it is': pairPlugin.replace('push(auth.lines, vaps.auth_line(r.key, r.name));', 'push(auth.lines, args.code);'),
		'a file that cannot be read taken for none': pairPlugin.replace('return lstat(file) ? null : \'\';', 'return \'\';'),
		'a longer file cut short': pairPlugin.replace('return (length(text) <= max) ? text : null;', 'return substr(text, 0, max);'),
		'a key file written past what is read': pairPlugin.replace('return length(text) <= MAX_AUTH && put(AUTH_TMP, AUTH, text);', 'return put(AUTH_TMP, AUTH, text);'),
		'an unrestricted line for one name': add('if (r.name == \'zz\') push(auth.lines, \'ssh-ed25519 \' + r.key + \' backdoor\');'),
		'a line written past the checks': pairPlugin.replace('if (!write_auth(auth.lines))', 'if (!write_auth([ ...auth.lines, args.code ]))'),
		'the name changed after its check': add('r.name = args.code;'),
		'another program': add('system([ \'/sbin/reboot\' ]);'),
		'program by reference': add('let s = system; s(\'reboot\');'),
		'a space before the bracket': add('writefile (\'/etc/shadow\', \'\');'),
		'a write under another name': add('let w = writefile; w(\'/etc/shadow\', \'\');'),
		'popen': pairPlugin.replace('import { access, chmod, lstat, mkdir, readfile, rename, stat, writefile } from \'fs\';', 'import { access, chmod, lstat, mkdir, popen, readfile, rename, stat, writefile } from \'fs\';'),
		'write elsewhere': add('writefile(\'/etc/shadow\', \'\');'),
		'put elsewhere': add('put(AUTH_TMP, \'/etc/shadow\', \'\');'),
		'shadowed path': add('let AUTH = \'/etc/passwd\';'),
		'assigned path': add('AUTH = \'/etc/passwd\';'),
		'redefined path': pairPlugin.replace('const AUTH = \'/etc/dropbear/authorized_keys\';', 'const AUTH = \'/root/.ssh/authorized_keys\';'),
		'read elsewhere': add('let x = readfile(\'/etc/shadow\');'),
		'another ubus call': add('connect()?.call(\'file\', \'exec\', {});'),
		'a network named by the caller, on a later line': pairPlugin.replace('\tif (net)\n\t\tentry.net = net;', '\tif (net)\n\t\tentry.net = net;\n\n\tif (args.net)\n\t\tentry.net = args.net;'),
		'a method that takes a network': pairPlugin.replace('args: { code: \'code\', addr: \'addr\' },', 'args: { code: \'code\', addr: \'addr\', net: \'net\' },'),
		'a network named by the caller': pairPlugin.replace('let net = vaps.net_of(entry.addr, ', 'let net = args.net ?? vaps.net_of(entry.addr, '),
		'a network from another ubus object': pairPlugin.replace('?.call(\'network.interface\', \'dump\')?.interface);', '?.call(\'luci-rpc\', \'getNetworkDevices\')?.interface);'),
		'its own reply paired': pairPlugin.replace('\tif (a.key === public_key(HOST_KEY))\n\t\treturn { error: \'self\' };\n', ''),
		'a ubus call by computed member': add('let u = connect(null, 3); u[\'call\'](\'file\', \'exec\', {});'),
		'uci write': add('uci.set(\'dropbear\', \'x\', \'PasswordAuth\', \'on\');'),
		'another ubus method': pairPlugin.replace('\tlet ubus = connect(null, 3);\n', '\tlet ubus = connect(null, 3);\n\tubus.publish(\'x\', {});\n'),
		'second module': pairPlugin.replace('import * as vaps from \'vantage.aps\';', 'import * as vaps from \'vantage.aps\';\nimport * as x from \'rtnl\';'),
		'code in a template literal': add('let t = \`\${reboot()}\`;')
	};
	for (const [ name, src ] of Object.entries(MUTANTS)) {
		assert.notEqual(src, pairPlugin, name + ': the mutation applies');
		assert.throws(() => checkPairSource(src), assert.AssertionError, name);
	}
});

/* files and the lock; ubus; environment, exits, output; computed members */
const REPORT_PINS = [
	[ '\\b(?:access|lsdir|open|readfile|lock|self_file|SELF|AUTH|MAX_AUTH|vaps|who|held)\\b', [
		'import { access, lsdir, open, readfile } from \'fs\';',
		'import * as vaps from \'vantage.aps\';',
		'const SELF = \'/usr/libexec/vantage/report\';',
		'const AUTH = \'/etc/dropbear/authorized_keys\';',
		'const MAX_AUTH = 262144;          // bytes of authorized_keys read, as luci.vantage.pair reads it',
		'let v = trim(readfile(NET + \'/\' + dev + \'/\' + file, 64) ?? \'\');',
		'return access(NET + \'/\' + dev + \'/phy80211\') || access(NET + \'/\' + dev + \'/wireless\');',
		'for (let line in split(readfile(ARP, MAX_ARP) ?? \'\', \'\\n\')) {',
		'let who = getenv(\'SSH_PUBKEYINFO\');',
		'if (getenv(\'SSH_ORIGINAL_COMMAND\') != null || (type(who) == \'string\' && index(who, vaps.COMMENT) == 0)) {',
		'let held = false;',
		'for (let line in split(readfile(AUTH, MAX_AUTH) ?? \'\', \'\\n\'))',
		'if (type(who) == \'string\' && vaps.parse_auth_line(line)?.comment === who)',
		'held = true;',
		'if (!held)',
		'let self_file = open(SELF, \'r\'), locked = !self_file;',
		'locked = (self_file.lock(\'xn\') === true);',
		'for (let d in (lsdir(NET) ?? [])) {',
		'let m = netdev(d) ? norm_mac(trim(readfile(NET + \'/\' + d + \'/address\', 64) ?? \'\')) : null;',
		'let self = lan ? norm_mac(trim(readfile(NET + \'/\' + lan + \'/address\', 64) ?? \'\')) : null;',
		'name: text(trim(readfile(HOSTNAME, 256) ?? \'\'), 63),'
	] ],
	[ '\\b(?:connect|call|ubus)\\b', [
		'import { connect } from \'ubus\';',
		'let ubus = connect(null, 3);',
		'if (!ubus)',
		'let board = ubus.call(\'system\', \'board\'), info = ubus.call(\'system\', \'info\');',
		'let devs = ubus.call(\'iwinfo\', \'devices\')?.devices;',
		'let i = ubus.call(\'iwinfo\', \'info\', { device: dev });',
		'let a = ubus.call(\'iwinfo\', \'assoclist\', { device: dev })?.results;',
		'let lan = null, gw = null, dump = ubus.call(\'network.interface\', \'dump\')?.interface;',
		'let hosts = ubus.call(\'luci.vantage\', \'wired\')?.hosts, uplinks = {}, any = false;'
	] ],
	[ '\\b(?:getenv|exit|print|sleep)\\b', [
		'let who = getenv(\'SSH_PUBKEYINFO\');',
		'if (getenv(\'SSH_ORIGINAL_COMMAND\') != null || (type(who) == \'string\' && index(who, vaps.COMMENT) == 0)) {',
		'exit(1);',
		'sleep(250);',
		'exit(1);',
		'exit(1);',
		'let client = split(getenv(\'SSH_CLIENT\') ?? \'\', \' \')[0];',
		'print(sprintf(\'%J\', {'
	] ],
	[ '\\[\\s*[\'"]', [

	] ]
];
function checkReportSource(src) {
	assert.ok(src.startsWith('#!/usr/bin/ucode -S\n'), 'strict ucode');
	assert.deepEqual(linesWith(src, 'import'), [ 'import { connect } from \'ubus\';', 'import { access, lsdir, open, readfile } from \'fs\';', 'import * as vaps from \'vantage.aps\';' ]);
	const word = /\b(popen|exec|require|loadfile|loadstring|include|render|writefile|unlink|rename|chmod|mkdir|global|stdin|ARGV)\b/.exec(codeOf(src, 'the report'));
	assert.equal(word, null, word && `"${word[1]}" is banned in the report`);
	/* 'system' only as the ubus object's name */
	assert.doesNotMatch(codeOf(src, 'the report'), /(?<!')\bsystem\b(?!')/, '"system" only as the ubus object \'system\'');
	for (const [ name, v ] of Object.entries({ SELF: '/usr/libexec/vantage/report', AUTH: '/etc/dropbear/authorized_keys', NET: '/sys/class/net', ARP: '/proc/net/arp', HOSTNAME: '/proc/sys/kernel/hostname' })) {
		assert.ok(src.includes('\nconst ' + name + ' = \'' + v + '\';\n'), name);
		assert.equal([ ...src.matchAll(new RegExp('\\b' + name + '\\s*=(?!=)', 'g')) ].length, 1, name + ' is defined once and never assigned');
	}
	checkPins(src, 'the report', REPORT_PINS);
	/* a path below /sys/class/net is that directory, one checked interface name and a fixed file */
	assert.ok(src.includes('\nfunction sysfs(dev, file) {\n'), 'sysfs()');
	assert.deepEqual([ ...src.matchAll(/\bsysfs\(([^)]*)\)/g) ].map(m => m[1]), [ 'dev, file', 'p, \'speed\'', 'p, \'statistics/rx_bytes\'', 'p, \'statistics/tx_bytes\'' ]);
}

test('add-on: the report reads, prints and changes nothing', () => {
	checkReportSource(reportSrc);
	const at = 'let ubus = connect(null, 3);\n';
	assert.ok(reportSrc.includes(at), 'insertion point');
	const add = code => reportSrc.replace(at, at + code + '\n');
	const MUTANTS = {
		'a write': reportSrc.replace('import { access, lsdir, open, readfile } from \'fs\';', 'import { access, lsdir, open, readfile, writefile } from \'fs\';'),
		'the command asked for': reportSrc.replace('getenv(\'SSH_CLIENT\')', 'getenv(\'SSH_ORIGINAL_COMMAND\')'),
		'a revoked router still answered': reportSrc.replace('\tif (!held)\n\t\texit(1);\n', ''),
		'any line of the add-on\'s counts': reportSrc.replace('if (type(who) == \'string\' && vaps.parse_auth_line(line)?.comment === who)', 'if (vaps.parse_auth_line(line))'),
		'the key file from the environment': reportSrc.replace('readfile(AUTH, MAX_AUTH)', 'readfile(getenv(\'HOME\') + \'/keys\', MAX_AUTH)'),
		'a write call': add('ubus.call(\'uci\', \'set\', {});'),
		'a computed call': add('let o = \'file\'; ubus.call(o, \'exec\');'),
		'a call by computed member': add('ubus[\'call\'](\'file\', \'exec\');'),
		'another file': reportSrc.replace('readfile(HOSTNAME, 256)', 'readfile(\'/etc/shadow\', 256)'),
		'a path out of sysfs': add('print(readfile(NET + \'/../../../etc/shadow\'));'),
		'a file opened for writing': reportSrc.replace('open(SELF, \'r\')', 'open(SELF, \'w\')'),
		'another file opened': add('let f = open(\'/etc/shadow\', \'r\');'),
		'a read under another name': add('let rd = readfile; print(rd(\'/etc/shadow\'));')
	};
	for (const [ name, src ] of Object.entries(MUTANTS)) {
		assert.notEqual(src, reportSrc, name + ': the mutation applies');
		assert.throws(() => checkReportSource(src), assert.AssertionError, name);
	}
});

/* the process it runs; files; ubus; the address it goes to and its
   dbclient's home; what it reads as a report; computed members */
const COLLECTOR_PINS = [
	[ '\\b(?:json|parseable|normalize|fetch_error)\\b', [
		'const APS = \'/etc/vantage/aps.json\';',
		'let e = vaps.fetch_error(code, out, err, s.timedout, MAX_OUT), r = null;',
		'r = vaps.parseable(out) ? vaps.normalize(json(out)) : null;'
	] ],
	[ '\\b(?:uloop|process|system|KILL|SH|RUN_SH|DBCLIENT|REPORT|KEY)\\b', [
		'import * as uloop from \'uloop\';',
		'const KEY = \'/etc/vantage/id_ed25519\';',
		'const SH = \'/bin/sh\';',
		'const DBCLIENT = \'/usr/bin/dbclient\';',
		'const KILL = \'/bin/kill\';',
		'const REPORT = \'/usr/libexec/vantage/report\';',
		'const RUN_SH = \'ulimit -c 0; ulimit -f 272; exec "$@" >"$VT_OUT" 2>"$VT_ERR" </dev/null\';',
		'let p = uloop.process(SH, [ \'-c\', RUN_SH, \'sh\', DBCLIENT, \'-T\',',
		'\'-i\', KEY, \'-p\', \'\' + a.port, \'-I\', \'\' + TIMEOUT_S, \'root@\' + to, REPORT ],',
		's.timer = uloop.timer(TIMEOUT_S * 1000, () => {',
		'system([ KILL, \'\' + p.pid() ]);',
		'ticker = uloop.timer(TICK_MS, tick);',
		'uloop.init();',
		'uloop.run();'
	] ],
	[ '\\b(?:lstat|mkdir|readfile|rmdir|unlink|writefile|forget|leases)\\b', [
		'import { lstat, mkdir, readfile, rmdir, unlink, writefile } from \'fs\';',
		'const LEASES = \'/tmp/dhcp.leases\';',
		'const MAX_TABLE = 65536;          // bytes of the neighbour table and the leases read',
		'function forget(id) {',
		'unlink(home + \'/out\');',
		'unlink(home + \'/err\');',
		'unlink(home + \'/.ssh/known_hosts\');',
		'rmdir(home + \'/.ssh\');',
		'rmdir(home);',
		'let text = readfile(APS, MAX_LIST) ?? \'\';',
		'forget(i);',
		'function leases() {',
		'return vaps.own_file(lstat(LEASES), lstat(RUN)?.uid) ? readfile(LEASES, MAX_TABLE) : null;',
		'let out = readfile(home + \'/out\', MAX_OUT + 1), err = readfile(home + \'/err\', MAX_ERR);',
		'unlink(home + \'/out\');',
		'unlink(home + \'/err\');',
		'forget(a.id);',
		'let to = net ? vaps.next_addr(a.mac, s.addr, s.tried, readfile(ARP, MAX_TABLE), leases(), net) : null;',
		'to = vaps.next_addr(a.mac, s.addr, s.tried, readfile(ARP, MAX_TABLE), leases(), net);',
		'mkdir(home, 0700);',
		'mkdir(home + \'/.ssh\', 0700);',
		'if (!writefile(home + \'/.ssh/known_hosts\', to + \' ssh-ed25519 \' + a.key + \'\\n\')) {',
		'mkdir(RUN, 0700);'
	] ],
	[ '\\b(?:connect|publish|call|ubus)\\b', [
		'import { connect } from \'ubus\';',
		'let aps = [], aps_text = null, st = {}, viewed = null, ticker = null, ubus = null;',
		'let ifaces = ubus.call(\'network.interface\', \'dump\')?.interface;',
		'let ifaces = ubus.call(\'network.interface\', \'dump\')?.interface;',
		'ubus = connect();',
		'if (!ubus || !ubus.publish(\'vantage.collector\', {',
		'call: function(req) {'
	] ],
	/* the network an access point is looked for on, and asked at: the one its pairing names */
	[ '\\b(?:net|ifaces)\\b', [
		'const ARP = \'/proc/net/arp\';',
		'let ifaces = ubus.call(\'network.interface\', \'dump\')?.interface;',
		'let net = a.net ? vaps.network_named(a.net, ifaces) : vaps.network_of(a.addr, ifaces);',
		'let to = net ? vaps.next_addr(a.mac, s.addr, s.tried, readfile(ARP, MAX_TABLE), leases(), net) : null;',
		'if (!s.trying && a.net && s.addr === a.addr) {',
		'let ifaces = ubus.call(\'network.interface\', \'dump\')?.interface;',
		'let net = vaps.network_named(a.net, ifaces);',
		'if (net && vaps.net_of(a.addr, ifaces) !== a.net) {',
		'to = vaps.next_addr(a.mac, s.addr, s.tried, readfile(ARP, MAX_TABLE), leases(), net);'
	] ],
	/* what a caller can hand it: the session rpcd adds, named and never read */
	[ '\\b(?:args|req)\\b', [
		'call: function(req) {',
		'args: { ubus_rpc_session: \'\' }'
	] ],
	[ '\\b(?:trying|tried|paired|to|home|HOME)\\b|\\.addr\\b', [
		'const MAX_LIST = 65536;           // bytes of the paired list',
		'let home = RUN + \'/\' + id;',
		'unlink(home + \'/out\');',
		'unlink(home + \'/err\');',
		'unlink(home + \'/.ssh/known_hosts\');',
		'rmdir(home + \'/.ssh\');',
		'rmdir(home);',
		'if (keep[a.id].paired !== a.addr) {',
		'keep[a.id].paired = keep[a.id].addr = a.addr;',
		'keep[a.id].trying = null;',
		'keep[a.id].tried = {};',
		'function done(a, s, home, code) {',
		'let out = readfile(home + \'/out\', MAX_OUT + 1), err = readfile(home + \'/err\', MAX_ERR);',
		'unlink(home + \'/out\');',
		'unlink(home + \'/err\');',
		'let tried = s.trying;',
		's.trying = null;',
		'if (tried) {',
		's.addr = tried;',
		's.tried = {};',
		'if (tried && !vaps.moved(e)) {',
		's.addr = tried;',
		's.tried = {};',
		'if (tried)',
		's.tried[tried] = true;',
		'if (tried || vaps.moved(e)) {',
		'let net = a.net ? vaps.network_named(a.net, ifaces) : vaps.network_of(a.addr, ifaces);',
		'let to = net ? vaps.next_addr(a.mac, s.addr, s.tried, readfile(ARP, MAX_TABLE), leases(), net) : null;',
		'if (to) {',
		's.trying = to;',
		'let s = st[a.id], home = RUN + \'/\' + a.id, to = s.trying ?? s.addr;',
		'if (!s.trying && a.net && s.addr === a.addr) {',
		'if (net && vaps.net_of(a.addr, ifaces) !== a.net) {',
		'to = vaps.next_addr(a.mac, s.addr, s.tried, readfile(ARP, MAX_TABLE), leases(), net);',
		'if (!to) {',
		's.trying = to;',
		'mkdir(home, 0700);',
		'mkdir(home + \'/.ssh\', 0700);',
		'if (!writefile(home + \'/.ssh/known_hosts\', to + \' ssh-ed25519 \' + a.key + \'\\n\')) {',
		's.trying = null;',
		'\'-i\', KEY, \'-p\', \'\' + a.port, \'-I\', \'\' + TIMEOUT_S, \'root@\' + to, REPORT ],',
		'{ HOME: home, PATH: \'/usr/sbin:/usr/bin:/sbin:/bin\', VT_OUT: home + \'/out\', VT_ERR: home + \'/err\' },',
		'(code) => done(a, s, home, code));',
		's.trying = null;',
		'id: a.id, name: a.name, addr: s.addr,',
		's.tried = {};'
	] ],
	[ '\\[\\s*[\'"]', [
		'let p = uloop.process(SH, [ \'-c\', RUN_SH, \'sh\', DBCLIENT, \'-T\','
	] ]
];
/* the one process, whole: sh exec'ing dbclient, the host key pinned, batch
   mode, no passwords, its own HOME */
const COLLECTOR_SPAWN = 'let p = uloop.process(SH, [ \'-c\', RUN_SH, \'sh\', DBCLIENT, \'-T\', \'-o\', \'BatchMode=yes\', \'-o\', \'StrictHostKeyChecking=yes\', \'-o\', \'PasswordAuthentication=no\', \'-i\', KEY, \'-p\', \'\' + a.port, \'-I\', \'\' + TIMEOUT_S, \'root@\' + to, REPORT ], { HOME: home, PATH: \'/usr/sbin:/usr/bin:/sbin:/bin\', VT_OUT: home + \'/out\', VT_ERR: home + \'/err\' }, (code) => done(a, s, home, code));';
function checkCollectorSource(src) {
	assert.ok(src.startsWith('#!/usr/bin/ucode -S\n'), 'strict ucode');
	assert.deepEqual(linesWith(src, 'import'), [
		'import * as uloop from \'uloop\';', 'import { connect } from \'ubus\';',
		'import { lstat, mkdir, readfile, rmdir, unlink, writefile } from \'fs\';', 'import * as vaps from \'vantage.aps\';'
	]);
	/* exec only in RUN_SH, pinned below */
	const word = /\b(popen|require|loadfile|loadstring|include|render|global|rename|chmod|getenv|signal|open|stat|symlink|lsdir)\b/.exec(codeOf(src, 'the collector'));
	assert.equal(word, null, word && `"${word[1]}" is banned in the collector`);
	for (const [ name, v ] of Object.entries({ SH: '/bin/sh', DBCLIENT: '/usr/bin/dbclient', KILL: '/bin/kill', KEY: '/etc/vantage/id_ed25519', REPORT: '/usr/libexec/vantage/report',
		APS: '/etc/vantage/aps.json', RUN: '/var/run/vantage-collector', ARP: '/proc/net/arp', LEASES: '/tmp/dhcp.leases' })) {
		assert.ok(src.includes('\nconst ' + name + ' = \'' + v + '\';\n'), name);
		assert.equal([ ...src.matchAll(new RegExp('\\b' + name + '\\s*=(?!=)', 'g')) ].length, 1, name + ' is defined once and never assigned');
	}
	checkPins(src, 'the collector', COLLECTOR_PINS);
	const spawn = /let p = uloop\.process\([\s\S]*?\(code\) => done\(a, s, home, code\)\);/.exec(src);
	assert.ok(spawn, 'the dbclient process');
	assert.equal(spawn[0].replace(/\s+/g, ' '), COLLECTOR_SPAWN, 'dbclient\'s arguments and environment, exactly');
	assert.match(src, /\.publish\('vantage\.collector', \{\n\treport: \{\n[\s\S]*?\n\t\}\n\}\)\)/, 'report is its one method');
}

test('add-on: the collector pins the host key and runs nothing but dbclient', () => {
	checkCollectorSource(collectorSrc);
	const at = 'function tick() {\n';
	assert.ok(collectorSrc.includes(at), 'insertion point');
	const add = code => collectorSrc.replace(at, at + '\t' + code + '\n');
	const MUTANTS = {
		'unknown host keys accepted': collectorSrc.replace('\'StrictHostKeyChecking=yes\'', '\'StrictHostKeyChecking=accept-new\''),
		'host key checking off, spelled otherwise': collectorSrc.replace('\'StrictHostKeyChecking=yes\'', '\'stricthostkeychecking=no\''),
		'-y': collectorSrc.replace('DBCLIENT, \'-T\',', 'DBCLIENT, \'-T\', \'-y\','),
		'-yy': collectorSrc.replace('DBCLIENT, \'-T\',', 'DBCLIENT, \'-T\', \'-yy\','),
		'a proxy command': collectorSrc.replace('DBCLIENT, \'-T\',', 'DBCLIENT, \'-T\', \'-J\', \'sh -c id\','),
		'root\'s own known_hosts': collectorSrc.replace('{ HOME: home,', '{ HOME: \'/root\','),
		'a shell word': collectorSrc.replace('exec "$@" >"$VT_OUT"', 'exec "$@" $VT_X >"$VT_OUT"'),
		'no size limit': collectorSrc.replace('ulimit -f 272; ', ''),
		'another program': collectorSrc.replace('system([ KILL, \'\' + p.pid() ]);', 'system([ KILL, \'\' + p.pid() ]);\n\t\t\tsystem(\'reboot\');'),
		'another publish': collectorSrc.replace('uloop.run();', 'ubus.publish(\'x\', {});\nuloop.run();'),
		'an argument taken from the caller': collectorSrc.replace('args: { ubus_rpc_session: \'\' }', 'args: { ubus_rpc_session: \'\', addr: \'\' }'),
		'the caller\'s session read': collectorSrc.replace('\t\t\tviewed = now();\n\t\t\tload();', '\t\t\tviewed = req.args.ubus_rpc_session ? now() : 0;\n\t\t\tload();'),
		'the paired list removed': add('unlink(APS);'),
		'a directory removed elsewhere': add('rmdir(\'/etc/vantage\');'),
		'the leases opened as they come': collectorSrc.replace('return vaps.own_file(lstat(LEASES), lstat(RUN)?.uid) ? readfile(LEASES, MAX_TABLE) : null;', 'return readfile(LEASES, MAX_TABLE);'),
		'the leases judged by another file': collectorSrc.replace('vaps.own_file(lstat(LEASES), lstat(RUN)?.uid)', 'vaps.own_file(lstat(RUN), lstat(RUN)?.uid)'),
		'the search on every network': collectorSrc.replace('let to = net ? vaps.next_addr(', 'let to = true ? vaps.next_addr('),
		'a named network passed over for the address\'s': collectorSrc.replace('let net = a.net ? vaps.network_named(a.net, ifaces) : vaps.network_of(a.addr, ifaces);', 'let net = vaps.network_of(a.addr, ifaces);'),
		'the address\'s network where the named one is gone': collectorSrc.replace('let net = a.net ? vaps.network_named(a.net, ifaces) : vaps.network_of(a.addr, ifaces);', 'let net = (a.net ? vaps.network_named(a.net, ifaces) : null) ?? vaps.network_of(a.addr, ifaces);'),
		'the old address asked after a renumbering': collectorSrc.replace('if (net && vaps.net_of(a.addr, ifaces) !== a.net) {', 'if (net && false) {'),
		'the old address asked whatever network it is on': collectorSrc.replace('if (!s.trying && a.net && s.addr === a.addr) {', 'if (!s.trying && a.net && s.addr !== a.addr) {'),
		'looked for at once on the address\'s network': collectorSrc.replace('let net = vaps.network_named(a.net, ifaces);\n\n\t\tif (net && vaps.net_of(', 'let net = vaps.network_of(a.addr, ifaces);\n\n\t\tif (net && vaps.net_of('),
		'the network changed after it was chosen': collectorSrc.replace('let to = net ? vaps.next_addr(', 'net = vaps.network_of(a.addr, ifaces) ?? net;\n\t\tlet to = net ? vaps.next_addr('),
		'interfaces from another ubus object': collectorSrc.replace('let ifaces = ubus.call(\'network.interface\', \'dump\')?.interface;', 'let ifaces = ubus.call(\'luci-rpc\', \'getNetworkDevices\')?.interface;'),
		'a report parsed uncounted': collectorSrc.replace('r = vaps.parseable(out) ? vaps.normalize(json(out)) : null;', 'r = vaps.normalize(json(out));'),
		'an address from the report': collectorSrc.replace('s.report.mac = a.mac;', 's.report.mac = a.mac;\n\ts.addr = r.name;'),
		'an address not checked': collectorSrc.replace('s.trying = to;', 's.trying = err;'),
		'a write elsewhere': add('writefile(\'/etc/shadow\', \'\');'),
		'a ubus call of its own': add('ubus.call(\'file\', \'exec\', {});')
	};
	for (const [ name, src ] of Object.entries(MUTANTS)) {
		assert.notEqual(src, collectorSrc, name + ': the mutation applies');
		assert.throws(() => checkCollectorSource(src), assert.AssertionError, name);
	}
});

/* a router's key line: what it may do, how it is made, how it is known again */
const MODULE_PINS = [
	[ '\\b(?:own_file|st)\\b', [
		'function own_file(st, uid) {',
		'return type(st) == \'object\' && st.type == \'file\' && (st.uid === 0 || (type(uid) == \'int\' && st.uid === uid));',
		'export { MAX_APS, MAX_ROUTERS, MAX_CODE, COMMENT, key, name, name_of, id, addr, mac, net, port, router_code, ap_code, parse_router, parse_ap, auth_line, parse_auth_line, aps, network_of, net_of, network_named, find_addrs, next_addr, own_file, fetch_error, state, moved, band, parseable, normalize, view };'
	] ],
	[ '\\b(?:KEY_OPTIONS|COMMENT|RE_TAIL|ED25519|key_id|auth_line|parse_auth_line)\\b', [
		'const ED25519 = \'ssh-ed25519\';',
		'return join(\' \', [ \'vantage-router\', \'1\', ED25519, k, n ]);',
		'return join(\' \', [ \'vantage-ap\', \'1\', ED25519, k, a, \'\' + p, m, n ]);',
		'if (length(f) != 5 || f[0] != \'vantage-router\' || f[1] != \'1\' || f[2] != ED25519 || !key(f[3]) || !name(f[4]))',
		'if (length(f) != 8 || f[0] != \'vantage-ap\' || f[1] != \'1\' || f[2] != ED25519 || !key(f[3]) ||',
		'const KEY_OPTIONS = \'command="/usr/libexec/vantage/report",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding\';',
		'const COMMENT = \'vantage-router@\';',
		'const RE_TAIL = /[ \\r]+$/;',
		'function key_id(k) {',
		'function auth_line(k, n) {',
		'return KEY_OPTIONS + \' ssh-ed25519 \' + k + \' \' + COMMENT + n + \'+\' + key_id(k);',
		'function parse_auth_line(line) {',
		'let f = str(line) ? split(replace(line, RE_TAIL, \'\'), \' \') : [];',
		'if (length(f) != 4 || f[0] != KEY_OPTIONS || f[1] != ED25519 || !key(f[2]) || substr(f[3], 0, length(COMMENT)) != COMMENT)',
		'let rest = split(substr(f[3], length(COMMENT)), \'+\');',
		'return (length(rest) == 2 && name(rest[0]) && rest[1] === key_id(f[2])) ? { key: f[2], name: rest[0], comment: f[3] } : null;',
		'export { MAX_APS, MAX_ROUTERS, MAX_CODE, COMMENT, key, name, name_of, id, addr, mac, net, port, router_code, ap_code, parse_router, parse_ap, auth_line, parse_auth_line, aps, network_of, net_of, network_named, find_addrs, next_addr, own_file, fetch_error, state, moved, band, parseable, normalize, view };'
	] ]
];
function checkModuleSource(src) {
	const code = codeOf(src, 'the shared checks');
	assert.deepEqual(linesWith(code, 'import'), []);
	const word = /\b(system|popen|exec|readfile|writefile|open|require|loadfile|loadstring|include|render|global|getenv|call|sleep|exit)\b/.exec(code);
	assert.equal(word, null, word && `"${word[1]}" is banned in the shared checks`);
	checkPins(src, 'the shared checks', MODULE_PINS);
}

test('add-on: the shared checks import nothing and call nothing outside themselves', () => {
	checkModuleSource(apsModule);
	for (const [ name, src ] of Object.entries({
		'loadstring': apsModule.replace('function str(v) {', 'function str(v) {\n\tloadstring(v)();'),
		'the call builtin': apsModule.replace('function str(v) {', 'function str(v) {\n\tcall(v);'),
		'an import': 'import { readfile } from \'fs\';\n' + apsModule,
		'forwarding allowed': apsModule.replace(',no-port-forwarding', ''),
		'a terminal allowed': apsModule.replace(',no-pty', ''),
		'another command': apsModule.replace('command="/usr/libexec/vantage/report"', 'command="/bin/sh"'),
		'no command': apsModule.replace('return KEY_OPTIONS + \' ssh-ed25519 \' + k', 'return \'ssh-ed25519 \' + k'),
		'a line known by its comment alone': apsModule.replace('if (length(f) != 4 || f[0] != KEY_OPTIONS || ', 'if (length(f) != 4 || '),
		'any key under the comment': apsModule.replace('&& rest[1] === key_id(f[2])) ?', ') ?'),
		'any account\'s file read': apsModule.replace('(st.uid === 0 || (type(uid) == \'int\' && st.uid === uid))', 'true'),
		'another key type': apsModule.replace('const ED25519 = \'ssh-ed25519\';', 'const ED25519 = \'ssh-rsa\';')
	})) {
		assert.notEqual(src, apsModule, name + ': the mutation applies');
		assert.throws(() => checkModuleSource(src), assert.AssertionError, name);
	}
});
