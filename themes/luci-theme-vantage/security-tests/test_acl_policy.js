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
 *   routes), and nl80211 for two read-only dumps: the channel survey of
 *   an interface (luci.vantage survey) and the list of the wireless
 *   interfaces (luci.vantage wireless, #164); no other file access, no other
 *   netlink request, no process execution, and no module, cursor or
 *   connection passed on under another name; altered copies of the
 *   plugin check that these rules catch each breach;
 * - every rpc.declare({ object, method }) in the app's JavaScript is
 *   granted, and every grant is used by a declare (no stale privilege);
 *   `session access` is the only call left to the platform (rpcd grants it
 *   to every session through its `unauthenticated` group);
 * - four declared calls are granted by no group of the dashboard, each
 *   by another package's own group: the add-on's `vantage.collector
 *   report` (below), luci-app-vantage-traffic's `luci.vantage.traffic
 *   hosts` (below; declared once without parameters, called only after
 *   rpcd said the login holds that package's group), LuCI's
 *   `luci.wireguard getWgInstances`
 *   (luci-proto-wireguard's rpcd plugin, the call of its status page:
 *   the WireGuard interfaces and their peers, without private or
 *   preshared keys; it takes no argument and writes nothing), and the
 *   provider tiles' `vantage.tile.<id> status` (#129: another package's
 *   data for a tile the dashboard draws itself). LuCI's group
 *   luci-proto-wireguard grants the WireGuard call to read, so only a
 *   login that holds that group is answered; the dashboard's ACL says
 *   nothing of the object. It is declared once, in the dashboard, in one
 *   exact form without parameters, and called without arguments; the
 *   object's other methods, which make keys, are declared nowhere;
 * - the provider tiles' call is the one other dynamic declare: in the
 *   dashboard, in one exact helper (TILE_HELPER) whose object is the
 *   fixed prefix `vantage.tile.` and an id of a-z only, checked by the
 *   pinned TILE_OBJ (only tested, never changed; the helper's declares
 *   are its own), its one method `status`, no parameters, so no
 *   argument can be sent; it is called in one place, for ids that come
 *   only from the session's own ACL (rpcd's `session access` without an
 *   object, declared once in one exact form without parameters and
 *   called once), never another LuCI or OpenWrt object. Those ids are
 *   tileIds' (its text pinned), handed as they are to askTile, its one
 *   caller, which hands its id to the call unchanged. No group of the
 *   dashboard or the add-on mentions a `vantage.tile.` object or a
 *   `vantage-tile-` group: a provider's package ships its own;
 * - beside the declares there is no way to rpcd: the browser files of
 *   the dashboard and the add-ons use rpc only as `rpc.declare({`, fetch
 *   only their own CSS and the theme's script, and make no
 *   XMLHttpRequest, beacon, socket or LuCI request; none of them, nor the
 *   theme's, assigns a prototype's member or defines a property (which
 *   could change what the checks above rely on, TILE_OBJ.test);
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
 * - the view probes exactly five groups: its names group (write), its
 *   rdns group (read), luci-app-vantage-traffic's (read), the add-on's
 *   view group (read) and LuCI's luci-proto-wireguard (read); it reads
 *   its own session's ACL once,
 *   for the provider tiles only;
 * - the app's executable rpcd plugin (root/usr/libexec/rpcd/
 *   luci.vantage.ports, #156) is the one file of the dashboard and the
 *   theme that starts a program: /usr/sbin/ethtool with -S and the name
 *   of one of the device's own DSA ports, which it finds in
 *   /sys/class/net (DEVTYPE=dsa) and holds to RE_PORT (popen hands the
 *   line to /bin/sh: letters, digits, _ and -, never first, are plain
 *   words to it and a device to ethtool); one read at a time: it locks
 *   its own file, opened for reading, before it reads or starts anything,
 *   and answers busy where the lock is held; its one method, counters,
 *   takes nothing; it reads MAX_PORTS ports, none after BUDGET_MS, and
 *   MAX_OUT bytes of each run at most; the read group grants it, no
 *   other group of any Vantage package mentions it, and the dashboard
 *   declares it once without parameters and calls it in one place
 *   without arguments; luci.vantage still starts nothing;
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
 *
 * luci-app-vantage-traffic, the opt-in, experimental per-device traffic
 * (#110; VANTAGE_TRAFFIC_PKG: another copy of it):
 *
 * - one group, `luci-app-vantage-traffic`: luci.vantage.traffic hosts to
 *   read and nothing else, no write section; no group of the dashboard
 *   or the add-on grants the call, and it grants nothing of theirs;
 * - its plugin, an executable rpcd plugin (/usr/libexec/rpcd/
 *   luci.vantage.traffic) that rpcd runs as a process of its own, answers
 *   rpcd's "list" with that one method, without arguments, and "call
 *   hosts", and nothing else; it reads no input; it imports rtnl, uci's
 *   cursor and fs's chmod, lstat, mkdir, open, readfile, rename and
 *   writefile only; it opens /proc/net/nf_conntrack to read it line by
 *   line, reads the accounting switch (bounded), makes one read-only
 *   neighbour dump each for IPv4 and IPv6 and reads one uci option, the
 *   theme's vantage_theme.appearance.power; it writes only its state in
 *   /var/run/vantage-traffic, a directory it makes 0700 and refuses when
 *   others may enter it, through files written 0600 beside the ones they
 *   replace (state.json, answer.json; a lock file), reads back only those
 *   (bounded), runs nothing, and its answer holds MACs and counts, never
 *   an address; altered copies of it check that these rules catch each
 *   breach.
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
	/* the app's executable plugin: a DSA switch chip's own byte counters,
	   ethtool -S on each of the device's DSA ports (#156; PORTS_* below) */
	'luci.vantage.ports': [ 'counters' ],
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
/* And luci-app-vantage-traffic's counters (#110, experimental): the bytes
   from and to each host as this router's connection tracking counts them,
   by MAC; the plugin takes no argument and writes nothing. No group of
   the dashboard grants it: the package's own does (TRAFFIC_GROUP), so the
   dashboard asks rpcd once a page whether the login holds that group
   (TRAFFIC_PROBE, in the batch load() sends anyway) and calls only then
   (TRAFFIC_ASK); without the package there is no such group and no call.
   Declared in this one form, a request of its own (the plugin is a
   process of rpcd's, and a read may take seconds: no poll waits for it),
   called in that one place. */
const TRAFFIC_CALL = 'luci.vantage.traffic hosts';
const TRAFFIC_GROUP = 'luci-app-vantage-traffic';
const TRAFFIC_DECLARE = "var callTraffic = rpc.declare({ object: 'luci.vantage.traffic', method: 'hosts', expect: { '': {} }, reject: true, nobatch: true });";
const TRAFFIC_PROBE = "\t\t\t\tL.resolveDefault(ui.menu.load(), null),\n" +
	"\t\t\t\t/* per-device traffic is a package and a group of its own: without either, no call (takeTraffic) */\n" +
	"\t\t\t\tL.resolveDefault(callAccess('access-group', 'luci-app-vantage-traffic', 'read'), false)\n\t\t\t]);\n\t\t}).then(function(r) {\n";
const TRAFFIC_ASK = "\t\tif (slow && this.canTraffic && !this.trafficCall && !(now < this.trafficNext))\n" +
	"\t\t\tthis.trafficCall = callTraffic().then(null, function(e) { return self.trafficFailed(e); }).then(function(v) { self.trafficGot = v; self.trafficCall = null; });\n";
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
/* And the provider tiles (#129): another package's ubus object
   vantage.tile.<id>, its method status, which takes nothing and answers
   data the dashboard checks and draws as text. No group of the dashboard
   grants it: the provider's package ships its own group, so the call
   fails for a login without it and where no such package is installed.
   The object is the fixed prefix and an id of 1-7 letters a-z, so it
   names no LuCI or OpenWrt object; the dashboard asks only the ids its
   session's own ACL names (TILE_ACLS: rpcd's session access without an
   object and a function answers the session's whole ACL, as LuCI's
   dispatcher asks it), in one helper of one exact form. */
const TILE_CALL = 'vantage.tile.* status';
const TILE_OBJ_LINE = 'var TILE_OBJ = /^vantage\\.tile\\.[a-z]{1,7}$/;';
const TILE_HELPER = "var tileCalls = {};\nfunction tileCall(id) {\n\tvar obj = 'vantage.tile.' + id;\n\tif (!TILE_OBJ.test(obj)) return Promise.reject(new Error('not a provider'));\n" +
	"\tif (!tileCalls[obj]) tileCalls[obj] = rpc.declare({ object: obj, method: 'status', expect: { '': {} }, reject: true, nobatch: true });\n\treturn tileCalls[obj]();\n}\n";
const TILE_ACLS = "var callAcls = rpc.declare({ object: 'session', method: 'access', expect: { '': {} } });";
/* where the ids come from, and the one call: in askTiles and askTile */
const TILE_FROM_ACL = "\t\tif (!this.tilesMay) this.tilesMay = callAcls().then(tileIds, function() { self.tilesMay = null; return []; });\n";
const TILE_ASK = '\t\ts.call = tileCall(id).then(';
/* ...and whole: tileIds reads the ACL's ubus part and nothing else; the
   ids it gives, as they are, are the only ones askTile is called with
   (TILE_IDS_TO_ASK follows TILE_FROM_ACL), and askTile hands its id to
   the call unchanged (TILE_ASK_HEAD, which ends with TILE_ASK) */
const TILE_IDS = "function tileIds(acl) {\n\tvar ubus = acl && typeof acl === 'object' && !Array.isArray(acl) ? acl.ubus : null, out = [];\n" +
	"\tif (!ubus || typeof ubus !== 'object' || Array.isArray(ubus)) return out;\n\tObject.keys(ubus).forEach(function(obj) {\n" +
	"\t\tif (TILE_OBJ.test(obj) && Array.isArray(ubus[obj]) && ubus[obj].indexOf('status') >= 0) out.push(obj.slice(13));\n" +
	"\t});\n\treturn out.sort().slice(0, layout.EXTRA_MAX);\n}\n";
const TILE_IDS_TO_ASK = "\t\treturn this.tilesMay.then(function(ids) {\n\t\t\tself.tileIds = ids;\n" +
	"\t\t\tvar now = Date.now(), asks = ids.map(function(id) { return self.askTile(id, now); }).filter(Boolean);\n";
const TILE_ASK_DEF = '\taskTile: function(id, now) {';
const TILE_ASK_HEAD = TILE_ASK_DEF + "\n\t\tvar self = this, ts = this.tileState || (this.tileState = Object.create(null));\n" +
	"\t\tvar s = ts[id] || (ts[id] = { off: false, answered: false, last: null, failed: false, fails: 0, wait: null, call: null });\n" +
	"\t\tif (s.off || s.call) return null;\n\t\tif (s.wait && now >= s.wait.from && now < s.wait.until) return null;\n" +
	"\t\tif (s.answered && this.tileHidden(id)) return null;\n\t\tvar asked = Date.now();\n" + TILE_ASK;
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
		/* the provider tiles' helper: TILE_HELPER exactly, with the
		   pinned TILE_OBJ (tileProblems holds it to one file and one
		   use); its one method is the only one it can declare */
		if (text.includes(TILE_HELPER) && text.includes('\n' + TILE_OBJ_LINE + '\n')) {
			dynamic++;
			declared.set(TILE_CALL, (declared.get(TILE_CALL) || []).concat(file));
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

	/* nl80211: two requests, each a read-only dump (a GET with
	   NLM_F_DUMP, never a SET, NEW, DEL or TRIGGER): the list of the
	   wireless interfaces, asked without a message (#164: which of them
	   hostapd made for a network's VLANs), and the channel survey of the
	   one interface asked about; nothing else */
	const ifaces = 'let res = nl80211.request(nl80211.const.NL80211_CMD_GET_INTERFACE, nl80211.const.NLM_F_DUMP);';
	const survey = 'let res = nl80211.request(nl80211.const.NL80211_CMD_GET_SURVEY, nl80211.const.NLM_F_DUMP, { dev });';
	assert.deepEqual([ ...src.matchAll(/^.*\bnl80211\b.*$/gm) ].map(m => m[0].trim()), [ 'import * as nl80211 from \'nl80211\';', ifaces, survey ],
		`"nl80211" may appear only on its import, the interface dump and the survey dump${REWORD}`);
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
		'interface dump made a write': plugin.replace('nl80211.const.NL80211_CMD_GET_INTERFACE, nl80211.const.NLM_F_DUMP);', 'nl80211.const.NL80211_CMD_DEL_INTERFACE, 0);'),
		'interface dump with a message': plugin.replace('nl80211.const.NL80211_CMD_GET_INTERFACE, nl80211.const.NLM_F_DUMP);', 'nl80211.const.NL80211_CMD_GET_INTERFACE, nl80211.const.NLM_F_DUMP, { dev: \'phy0-ap0\' });'),
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
	/* the four calls another package's group grants, and no fifth: per-device traffic, LuCI's WireGuard status
	   and the provider tiles' status (their own tests below), and the collector's report, which the add-on's
	   view group grants, and that group grants nothing else; so does per-device traffic's */
	assert.deepEqual(foreignCalls(sources), [ TRAFFIC_CALL, WIREGUARD_CALL, COLLECTOR_CALL, TILE_CALL ], 'declared but not granted by the dashboard');
	assert.deepEqual([ ...pairs(apsAcl[APS_VIEW_GROUP].read.ubus) ], [ COLLECTOR_CALL ]);
	assert.deepEqual([ ...pairs(trafficAcl[TRAFFIC_GROUP].read.ubus) ], [ TRAFFIC_CALL ]);
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
	assert.deepEqual(probes, [ WRITE_GROUP + ' write', RDNS_GROUP + ' read', TRAFFIC_GROUP + ' read', APS_VIEW_GROUP + ' read', WIREGUARD_GROUP + ' read' ]);
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
		assert.deepEqual(foreignCalls(mutant), [ TRAFFIC_CALL, WIREGUARD_CALL, COLLECTOR_CALL, TILE_CALL, extra ].sort(), what);
		assert.notDeepEqual(foreignCalls(mutant), [ TRAFFIC_CALL, WIREGUARD_CALL, COLLECTOR_CALL, TILE_CALL ], what);
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

/* The provider tiles' calls in `srcs`: the helper in its one form, in the
   dashboard only and once, with the pinned TILE_OBJ; the helper called
   once, in askTile, for an id; the session's ACL declared once in its one
   form (no parameters: the whole ACL, never a question about an object
   of the caller's choosing) and called once, where it feeds tileIds; no
   other mention of a vantage.tile object in a declare. */
function tileProblems(srcs) {
	const out = [];
	let helpers = 0, objs = 0, prefixes = 0, asks = 0, acls = 0, fromAcl = 0, idsWhole = 0, askers = 0;
	for (const { file, text } of srcs) {
		const dash = file.endsWith('view/vantage/overview.js');
		const h = text.split(TILE_HELPER).length - 1, o = text.split('\n' + TILE_OBJ_LINE + '\n').length - 1;
		helpers += h; objs += o;
		if ((h || o) && !dash) out.push(`${file}: the provider helper outside the dashboard`);
		for (const m of text.matchAll(/^.*\bTILE_OBJ\s*=.*$/gm)) if (m[0] !== TILE_OBJ_LINE) out.push(`${file}: ${m[0].trim()}`);
		/* the check only tested, never changed (TILE_OBJ.test = ...); the
		   helper's declares only in the helper (tileCalls[...] = callX) */
		for (const m of text.matchAll(/^.*\bTILE_OBJ\s*[.[](?!test\(obj\)).*$/gm)) out.push(`${file}: ${m[0].trim()}`);
		/* and the name is used for nothing else: every mention is the
		   declaration or TILE_OBJ.test(obj) (an alias, an argument, a
		   property defined on it would be another use) */
		for (const m of text.matchAll(/\bTILE_OBJ\b/g)) {
			const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
			if (line !== TILE_OBJ_LINE && !text.startsWith('TILE_OBJ.test(obj)', m.index)) out.push(`${file}: TILE_OBJ in ${line.trim()}`);
		}
		/* where the ids come from: tileIds as it is, defined once; the
		   read's ids handed as they are to askTile, its one caller; the
		   read itself (tilesMay) set and used there only; askTile's id
		   handed to the call unchanged */
		if (dash && text.includes(TILE_IDS)) idsWhole++;
		for (const name of [ 'tileIds', 'tileCall' ]) {
			const defs = (text.match(new RegExp('\\bfunction\\s+' + name + '\\b', 'g')) || []).length;
			if (defs !== (dash ? 1 : 0)) out.push(`${file}: ${defs} definitions of ${name}`);
			for (const m of text.matchAll(new RegExp('(?:^|[^.\\w$])' + name + '\\s*=(?!=)', 'g'))) out.push(`${file}: ${name} assigned: ${m[0].trim()}`);
		}
		if (dash && !text.includes(TILE_FROM_ACL + TILE_IDS_TO_ASK)) out.push(`${file}: the ACL's ids not handed to askTile as they are`);
		const mays = (text.match(/\btilesMay\b/g) || []).length, pinnedMays = ((TILE_FROM_ACL + TILE_IDS_TO_ASK).match(/\btilesMay\b/g) || []).length;
		if (mays !== (dash ? pinnedMays : 0)) out.push(`${file}: tilesMay used ${mays} times`);
		if (dash && !text.includes(TILE_ASK_HEAD)) out.push(`${file}: askTile does not hand its id to the call as it came`);
		/* askTile as code (called, read as a property, named in a string,
		   defined): its definition and the one call in TILE_IDS_TO_ASK */
		for (const m of text.matchAll(/\baskTile\b/g)) {
			const before = text[m.index - 1], after = /^\s*(.)/.exec(text.slice(m.index + 7));
			if (!/[.'"`[]/.test(before) && !(after && /[(:]/.test(after[1]))) continue;
			const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index) + 1);
			if (dash && (line === TILE_ASK_DEF + '\n' || TILE_IDS_TO_ASK.endsWith(line))) { askers++; continue; }
			out.push(`${file}: askTile in ${line.trim()}`);
		}
		if ((text.match(/\btileCalls\b/g) || []).length !== h * (TILE_HELPER.match(/\btileCalls\b/g) || []).length) out.push(`${file}: tileCalls used outside the helper`);
		for (const m of text.matchAll(/^.*['"`]vantage\.tile\b.*$/gm))
			if (dash && m[0] === "\tvar obj = 'vantage.tile.' + id;") prefixes++;
			else out.push(`${file}: ${m[0].trim()}`);
		/* tileCall: its definition and one call, an id and nothing else */
		for (const m of text.matchAll(/\btileCall\b(\s*\(([^)]*)\))?/g)) {
			const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
			if (line === 'function tileCall(id) {') continue;
			if (dash && line.startsWith(TILE_ASK) && m[2] === 'id') { asks++; continue; }
			out.push(`${file}: ${line.trim()}`);
		}
		/* the session's ACL: one declare without parameters, one call, read by tileIds */
		for (const m of text.matchAll(/^.*\bobject\s*:\s*['"]session['"].*$/gm)) {
			if (m[0] === TILE_ACLS && dash) { acls++; continue; }
			if (/\bparams: \[ 'scope', 'object', 'function' \]/.test(m[0]) && dash) continue;
			out.push(`${file}: ${m[0].trim()}`);
		}
		for (const m of text.matchAll(/\bcallAcls\b\s*\(([^)]*)\)/g)) {
			if (dash && m[1] === '' && text.includes(TILE_FROM_ACL) && text.indexOf(TILE_FROM_ACL) < m.index && m.index < text.indexOf(TILE_FROM_ACL) + TILE_FROM_ACL.length) { fromAcl++; continue; }
			out.push(`${file}: callAcls(${m[1]})`);
		}
	}
	if (helpers !== 1 || objs !== 1 || prefixes !== 1) out.push(`${helpers} provider helpers, ${objs} TILE_OBJ, ${prefixes} objects made from the prefix`);
	if (asks !== 1) out.push(`${asks} provider calls`);
	if (acls !== 1 || fromAcl !== 1) out.push(`${acls} declares of the session's ACL, ${fromAcl} calls`);
	if (idsWhole !== 1) out.push(`${idsWhole} tileIds in its pinned form`);
	if (askers !== 2) out.push(`askTile defined and called ${askers} times, not once each`);
	return out;
}

test('provider tiles: one helper for vantage.tile.<id> status, called for ids from the session\'s own ACL only; no group of the dashboard or the add-on grants it', () => {
	assert.deepEqual(tileProblems(sources), []);
	const view = sources.find(s => s.file.endsWith('view/vantage/overview.js')).text;
	/* the id: from the ACL's ubus part, by TILE_OBJ, and checked again in the helper */
	assert.ok(view.includes("\t\tif (TILE_OBJ.test(obj) && Array.isArray(ubus[obj]) && ubus[obj].indexOf('status') >= 0) out.push(obj.slice(13));\n"), 'tileIds reads object names it checks');
	assert.equal('vantage.tile.'.length, 13);
	assert.ok(new RegExp(/^vantage\.tile\.[a-z]{1,7}$/).test('vantage.tile.dns'));
	for (const bad of [ 'luci.vantage', 'vantage.tile.', 'vantage.tile.dns.x', 'vantage.tile.DNS', 'vantage.tile.dns2', 'vantage.tile.abcdefgh', 'vantage.tile.*', 'file' ])
		assert.ok(!/^vantage\.tile\.[a-z]{1,7}$/.test(bad), bad);
	/* the ids of the ACL are all it asks for: a declared call, granted by no group of the dashboard */
	assert.ok(declared.has(TILE_CALL));
	assert.ok(!grantedCalls().has(TILE_CALL));
	for (const [ name, g ] of Object.entries(acl).concat(Object.entries(apsAcl))) {
		assert.ok(!/^vantage-tile-/.test(name), name);
		for (const kind of [ 'read', 'write' ])
			for (const k of pairs((g[kind] || {}).ubus)) assert.ok(!/^vantage\.tile\b/.test(k), `${name}.${kind}: ${k}`);
	}
	assert.doesNotMatch(JSON.stringify(acl) + JSON.stringify(apsAcl), /vantage[.-]tile/);
	/* the session's ACL: session access, which rpcd grants every session (PLATFORM) */
	assert.ok(PLATFORM.has('session access'));
	assert.ok(view.includes('\n' + TILE_ACLS + '\n'));
});

test('negative controls: another form, object, method or argument of the provider call, or another use of the session\'s ACL, fails', () => {
	const DASH = 'view/vantage/overview.js';
	const edit = (from, to) => mutate(DASH, t => { assert.ok(t.includes(from), from); return t.replace(from, to); });
	const add = (file, code) => mutate(file, t => t + '\n' + code + '\n');
	const helper = TILE_HELPER;
	for (const [ what, mutant, why ] of [
		[ 'a parameter', edit("object: obj, method: 'status', expect", "object: obj, method: 'status', params: [ 'cmd' ], expect"), /1 rpc\.declare\(\) call\(s\) with a non-literal|0 provider helpers/ ],
		[ 'another method', edit("object: obj, method: 'status',", "object: obj, method: 'set',"), /0 provider helpers/ ],
		[ 'another prefix', edit("var obj = 'vantage.tile.' + id;", "var obj = 'luci.' + id;"), /0 provider helpers/ ],
		[ 'a wider id', edit(TILE_OBJ_LINE, TILE_OBJ_LINE.replace('[a-z]', '[a-z.]')), /TILE_OBJ = .*\[a-z\.\]/ ],
		[ 'no check of the id', edit("\tif (!TILE_OBJ.test(obj)) return Promise.reject(new Error('not a provider'));\n", ''), /0 provider helpers/ ],
		[ 'a second helper', add(DASH, helper.replace(/tileCall/g, 'tileCall2').replace(/tileCalls/g, 'tileCalls2')), /2 objects made from the prefix/ ],
		[ 'the helper in a module', add('vantage/model.js', helper), /model\.js: the provider helper outside the dashboard/ ],
		[ 'an argument to the call', edit('return tileCalls[obj]();', "return tileCalls[obj]({ cmd: 'x' });"), /0 provider helpers/ ],
		[ 'a literal id', add(DASH, "tileCall('dns');"), /overview\.js: tileCall\('dns'\);/ ],
		[ 'a second call', add(DASH, 'tileCall(id);'), /overview\.js: tileCall\(id\);/ ],
		[ 'the helper passed on', add(DASH, 'var f = tileCall;'), /overview\.js: var f = tileCall;/ ],
		[ 'a provider object named elsewhere', add(DASH, "var callT = rpc.declare({ object: 'vantage.tile.dns', method: 'status' });"), /overview\.js: var callT = rpc\.declare\(\{ object: 'vantage\.tile\.dns'/ ],
		[ 'the ACL asked about an object', edit(TILE_ACLS, TILE_ACLS.replace("method: 'access',", "method: 'access', params: [ 'scope', 'object' ],")), /overview\.js: var callAcls = .*params|0 declares of the session's ACL/ ],
		[ 'the ACL read twice', add(DASH, 'callAcls();'), /overview\.js: callAcls\(\)/ ],
		[ 'the ACL with an argument', edit('callAcls().then(tileIds', "callAcls('ubus').then(tileIds"), /overview\.js: callAcls\('ubus'\)/ ],
		[ 'another session method', add(DASH, "var callSess = rpc.declare({ object: 'session', method: 'get' });"), /overview\.js: var callSess = /],
		[ 'the helper\'s declares filled elsewhere', add(DASH, "tileCalls['vantage' + '.tile.dns'] = callRead;"), /overview\.js: tileCalls used outside the helper/ ],
		[ 'the id check changed', add(DASH, 'TILE_OBJ.test = function() { return true; };'), /overview\.js: TILE_OBJ\.test = function/ ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		const found = tileProblems(mutant).concat(analyse(mutant).problems).join('\n');
		assert.match(found, why, what);
	}
	/* the dashboard's groups granting it would leave nothing foreign to allow */
	const granting = JSON.parse(JSON.stringify(acl));
	granting[READ_GROUP].read.ubus['vantage.tile.dns'] = [ 'status' ];
	assert.match(JSON.stringify(granting), /vantage[.-]tile/, 'what the ACL test above refuses');
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

/* ------------------------------------ luci-app-vantage: luci.vantage.ports */

/* The app's executable rpcd plugin (#156): the byte counters a DSA switch
   chip keeps for its ports, read with ethtool. rpcd runs it as a process
   of its own per call. The rules below hold it to that one program, at
   that one path, with that one option and a port name of the device's
   own: every line of code that mentions a file, the program, a name or a
   cap is listed (checkPins), the three functions that take the lock,
   find the ports and run the program are pinned whole, and so are its
   top-level statements and every name it binds. One read at a
   time: the plugin locks its own file, opened for reading, before it
   reads or starts anything, and answers busy where another holds it. */
const THEME_PKG = path.resolve(process.env.VANTAGE_THEME_PKG || path.join(__dirname, '..', 'luci-theme-vantage'));
const PORTS_OBJECT = 'luci.vantage.ports';
const PORTS_CALL = PORTS_OBJECT + ' counters';
const PORTS_REL = 'root/usr/libexec/rpcd/luci.vantage.ports';
const portsPlugin = fs.readFileSync(path.join(PKG, PORTS_REL), 'utf8');
/* a port's name: to /bin/sh (popen) a plain word, to ethtool a device and never an option */
const PORTS_RE_PORT = 'const RE_PORT = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,14}$/;';
const PORTS_PATHS = { NET: '/sys/class/net', ETHTOOL: '/usr/sbin/ethtool', SELF: '/usr/libexec/rpcd/luci.vantage.ports' };
const PORTS_CAPS = { MAX_PORTS: 32, BUDGET_MS: 1000, MAX_OUT: 32768, MAX_UEVENT: 512 };
/* the ports: a name of /sys/class/net that RE_PORT takes and whose uevent says DEVTYPE=dsa, MAX_PORTS at most */
const PORTS_FIND = "function dsa_ports() {\n\tlet found = [], more = false;\n\n\tfor (let n in sort(lsdir(NET) ?? [])) {\n\t\tif (!match(n, RE_PORT))\n\t\t\tcontinue;\n\n" +
	"\t\tlet dsa = false;\n\n\t\tfor (let l in split(readfile(NET + '/' + n + '/uevent', MAX_UEVENT) ?? '', '\\n'))\n\t\t\tif (l == 'DEVTYPE=dsa')\n\t\t\t\tdsa = true;\n\n" +
	"\t\tif (!dsa)\n\t\t\tcontinue;\n\n\t\tif (length(found) >= MAX_PORTS) {\n\t\t\tmore = true;\n\t\t\tbreak;\n\t\t}\n\n\t\tpush(found, n);\n\t}\n\n\treturn { found, more };\n}";
/* the one program: ETHTOOL -S <port>, MAX_OUT bytes of its output read, its exit code checked */
const PORTS_RUN = "function read_port(name) {\n\tlet p = popen(ETHTOOL + ' -S ' + name, 'r');\n\n\tif (!p)\n\t\treturn { error: 'failed' };\n\n" +
	"\tlet text = p.read(MAX_OUT + 1);\n\n\tif (p.close() !== 0 || type(text) != 'string' || length(text) > MAX_OUT)\n\t\treturn { error: 'failed' };\n\n\treturn parse(text);\n}";
/* the lock, taken without waiting before anything is read or started; held elsewhere: busy, and nothing started */
const PORTS_COUNT = "function counters() {\n\tlet t0 = now_ms(), self_file = open(SELF, 'r');\n\n\tif (!self_file || self_file.lock('xn') !== true)\n" +
	"\t\treturn { v: 1, state: 'busy', took: now_ms() - t0, more: false, ports: {} };\n\n\tlet ports = {}, d = dsa_ports();\n\n\tif (!length(d.found))\n" +
	"\t\treturn { v: 1, state: 'none', took: now_ms() - t0, more: false, ports };\n\n\tif (!access(ETHTOOL, 'x'))\n" +
	"\t\treturn { v: 1, state: 'no-ethtool', took: now_ms() - t0, more: d.more, ports };\n\n\tfor (let name in d.found) {\n\t\tlet at = now_ms();\n\n" +
	"\t\tports[name] = (at - t0 < BUDGET_MS) ? { ...read_port(name), at } : { error: 'time', at };\n\t}\n\n\treturn { v: 1, state: 'ok', took: now_ms() - t0, more: d.more, ports };\n}";
const PORTS_PINS = [
	[ '\\b(?:popen|access|lsdir|readfile|ETHTOOL|NET)\\b', [
		'import { access, lsdir, open, popen, readfile } from \'fs\';',
		'const NET = \'/sys/class/net\';',
		'const ETHTOOL = \'/usr/sbin/ethtool\';',
		'for (let n in sort(lsdir(NET) ?? [])) {',
		'for (let l in split(readfile(NET + \'/\' + n + \'/uevent\', MAX_UEVENT) ?? \'\', \'\\n\'))',
		'let p = popen(ETHTOOL + \' -S \' + name, \'r\');',
		'if (!access(ETHTOOL, \'x\'))'
	] ],
	/* the name ethtool gets: one of dsa_ports(), each in turn */
	[ '\\b(?:name|found|RE_PORT|read_port|dsa_ports)\\b|\\bd\\b', [
		'const RE_PORT = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,14}$/;',
		'function dsa_ports() {',
		'let found = [], more = false;',
		'if (!match(n, RE_PORT))',
		'if (length(found) >= MAX_PORTS) {',
		'push(found, n);',
		'return { found, more };',
		'function read_port(name) {',
		'let p = popen(ETHTOOL + \' -S \' + name, \'r\');',
		'let ports = {}, d = dsa_ports();',
		'if (!length(d.found))',
		'return { v: 1, state: \'no-ethtool\', took: now_ms() - t0, more: d.more, ports };',
		'for (let name in d.found) {',
		'ports[name] = (at - t0 < BUDGET_MS) ? { ...read_port(name), at } : { error: \'time\', at };',
		'return { v: 1, state: \'ok\', took: now_ms() - t0, more: d.more, ports };'
	] ],
	/* the one file opened, its own, for reading, and locked without waiting */
	[ '\\b(?:open|lock|SELF|self_file)\\b', [
		'import { access, lsdir, open, popen, readfile } from \'fs\';',
		'const SELF = \'/usr/libexec/rpcd/luci.vantage.ports\';',
		'let t0 = now_ms(), self_file = open(SELF, \'r\');',
		'if (!self_file || self_file.lock(\'xn\') !== true)'
	] ],
	/* the caps, each used where it bounds */
	[ '\\b(?:MAX_PORTS|BUDGET_MS|MAX_OUT|MAX_UEVENT)\\b', [
		'const MAX_PORTS = 32;             // ports read each time; the add-on\'s report lists 32 at most',
		'const BUDGET_MS = 1000;           // no port is read after this',
		'const MAX_OUT = 32768;            // bytes of one ethtool run read: the drivers below fill 3 KiB or so',
		'const MAX_UEVENT = 512;           // bytes of a device\'s uevent read',
		'for (let l in split(readfile(NET + \'/\' + n + \'/uevent\', MAX_UEVENT) ?? \'\', \'\\n\'))',
		'if (length(found) >= MAX_PORTS) {',
		'let text = p.read(MAX_OUT + 1);',
		'if (p.close() !== 0 || type(text) != \'string\' || length(text) > MAX_OUT)',
		'ports[name] = (at - t0 < BUDGET_MS) ? { ...read_port(name), at } : { error: \'time\', at };'
	] ],
	/* rpcd's two calls, and nothing else of the command line: one method, which takes nothing */
	[ '\\b(?:ARGV|print)\\b', [
		'if (ARGV[0] == \'list\')',
		'print(\'{ "counters": {} }\\n\');',
		'else if (ARGV[0] == \'call\' && ARGV[1] == \'counters\')',
		'print(sprintf(\'%J\', counters()), \'\\n\');'
	] ],
	/* the table: defined once, only read */
	[ '\\bCOUNTERS\\b', [
		'const COUNTERS = [',
		'for (let c in COUNTERS)'
	] ],
	/* the counters' names (COUNTERS), and no member reached by a literal name */
	[ '\\[\\s*[\'"]', [
		'[ \'RxBytes\', \'TxBytes\' ],             // mt7530: MT7530, MT7531, MT7988 (until Linux 6.16)',
		'[ \'RxGoodByte\', \'TxByte\' ],           // qca8k: QCA8337, QCA8327',
		'[ \'in_good_octets\', \'out_octets\' ],   // mv88e6xxx: Marvell',
		'[ \'RxOctets\', \'TxOctets\' ],           // b53, bcm_sf2: Broadcom',
		'[ \'RxGoodBytes\', \'TxGoodBytes\' ],     // lantiq_gswip',
		'[ \'IfInOctets\', \'IfOutOctets\' ]       // rtl8366rb'
	] ]
];
/* Every name the plugin binds and every function it defines. At the
   top: its imports, its constants, its five functions and rpcd's two
   calls; inside the functions: their parameters and locals. No other
   function (none inside another, no arrow function), no try/catch, no
   name assigned that is not one of these. So a builtin the pinned
   functions call (match, split, readfile, ...) cannot be replaced or
   shadowed, and no function of the plugin can be defined a second time */
const PORTS_TOP = [
	'#!/usr/bin/ucode -S', '\'use strict\';', 'import { access, lsdir, open, popen, readfile } from \'fs\';',
	'const NET', 'const ETHTOOL', 'const SELF', 'const MAX_PORTS', 'const BUDGET_MS', 'const MAX_OUT', 'const MAX_UEVENT', 'const RE_PORT', 'const RE_LINE', 'const COUNTERS',
	'function now_ms()', 'function dsa_ports()', 'function parse(text)', 'function read_port(name)', 'function counters()',
	'if (ARGV[0] == \'list\')', 'else if (ARGV[0] == \'call\' && ARGV[1] == \'counters\')'
];
const PORTS_NAMES = [
	'BUDGET_MS', 'COUNTERS', 'ETHTOOL', 'MAX_OUT', 'MAX_PORTS', 'MAX_UEVENT', 'NET', 'RE_LINE', 'RE_PORT', 'SELF',
	'at', 'c', 'counters', 'd', 'dsa', 'dsa_ports', 'found', 'i', 'l', 'lines', 'm', 'more', 'n', 'name', 'now_ms', 'p', 'parse',
	'ports', 'read_port', 'seen', 'self_file', 't', 't0', 'text'
];
/* the top-level statements of `code` (comment lines out), a constant or a function by its head */
function portsTop(code) {
	return code.split('\n').filter(l => /^[^\s}\]]/.test(l)).map(l => (/^const \w+|^function \w+\([^)]*\)/.exec(l) || [ l ])[0]);
}
/* the names `code` binds: assigned (=, +=, ...; not a member), declared without a value, a for-in's, a function's and its parameters */
function portsNames(code) {
	const bare = code.replace(/'(?:[^'\\\n]|\\.)*'/g, '\'\'').replace(/"(?:[^"\\\n]|\\.)*"/g, '""'), out = new Set();
	for (const m of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:[-+*\/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?![=>])/g)) out.add(m[1]);
	for (const m of bare.matchAll(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*(?=[;,]|\bin\b)/g)) out.add(m[1]);
	for (const m of bare.matchAll(/\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
		if (m[1]) out.add(m[1]);
		for (const a of m[2].split(',')) if (a.trim()) out.add(a.trim().replace(/^\.\.\./, ''));
	}
	return [ ...out ].sort();
}

function checkPortsSource(src) {
	assert.ok(src.startsWith('#!/usr/bin/ucode -S\n'), 'strict ucode');
	assert.match(src, /^'use strict';$/m);
	const code = codeOf(src, 'the switch counters plugin');
	assert.deepEqual(linesWith(code, 'import'), [ 'import { access, lsdir, open, popen, readfile } from \'fs\';' ]);
	/* no other way to a program, a file, the environment or standard input (open: its own file, pinned below) */
	const word = /\b(system|exec|execv|execvp|uloop|fork|spawn|require|loadfile|loadstring|include|render|writefile|unlink|rename|mkdir|chmod|symlink|connect|cursor|global|getenv|stdin|sleep|signal)\b/.exec(code);
	assert.equal(word, null, word && `"${word[1]}" is banned in the switch counters plugin`);
	assert.doesNotMatch(code, /(^|[^.\w])call\s*\(/m, 'the call() builtin is banned in the switch counters plugin');
	for (const [ name, v ] of Object.entries(PORTS_PATHS)) {
		assert.ok(src.includes('\nconst ' + name + ' = \'' + v + '\';\n'), name + ' = ' + v);
		assert.equal([ ...code.matchAll(new RegExp('\\b' + name + '\\s*=(?!=)', 'g')) ].length, 1, name + ' is defined once and never assigned');
	}
	assert.ok(src.includes('\n' + PORTS_RE_PORT + '\n'), 'RE_PORT, exactly');
	for (const [ name, v ] of Object.entries(PORTS_CAPS)) {
		assert.match(src, new RegExp('\\nconst ' + name + ' = ' + v + ';'), name + ' = ' + v);
		assert.equal([ ...code.matchAll(new RegExp('\\b' + name + '\\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)', 'g')) ].length, 1, name + ' is defined once and never assigned');
	}
	for (const [ what, fn ] of [ [ 'dsa_ports', PORTS_FIND ], [ 'read_port', PORTS_RUN ], [ 'counters', PORTS_COUNT ] ]) {
		const found = new RegExp('^function ' + what + '\\(.*\\) \\{\\n[\\s\\S]*?\\n\\}$', 'm').exec(src);
		assert.equal(found && found[0], fn, what + '(), exactly');
	}
	checkPins(src, 'the switch counters plugin', PORTS_PINS);
	assert.deepEqual(portsTop(code), PORTS_TOP, 'the top-level statements, exactly');
	assert.deepEqual(portsNames(code), PORTS_NAMES, 'every name the plugin binds, exactly');
	assert.equal((code.match(/\bfunction\b/g) || []).length, 5, 'five functions, at the top');
	assert.doesNotMatch(code, /=>|\btry\b|\bcatch\b/, 'no arrow function, no try/catch');
}

test('switch counters: the plugin starts ethtool alone, at its one path, with -S and a DSA port\'s name of the device\'s own; its method takes nothing', () => {
	checkPortsSource(portsPlugin);
	/* the pattern itself: no option, nothing the shell reads otherwise, an interface name's length */
	const re = new RegExp(PORTS_RE_PORT.slice('const RE_PORT = /'.length, -2));
	for (const ok of [ 'lan1', 'wan', 'lan-1', 'port_2', 'sfp', 'p0', 'x'.repeat(15) ]) assert.ok(re.test(ok), ok);
	for (const bad of [ '', '-S', '-lan1', '--help', 'lan 1', 'lan1;reboot', 'a|b', 'a&b', '$(id)', '`id`', 'a\'b', 'a"b', 'a\\b', 'a*', 'a?',
		'[a]', '~root', 'a>b', 'a<b', 'a\nb', 'a\tb', '#a', 'a.b', '..', 'a/b', 'a=b', 'a{b}', 'x'.repeat(16), 'lan1\u0000x', 'l\u00e4n' ])
		assert.ok(!re.test(bad), JSON.stringify(bad));
});

test('switch counters: the plugin rules catch each breach', () => {
	const at = '\tlet ports = {}, d = dsa_ports();\n';
	assert.ok(portsPlugin.includes(at), 'insertion point');
	const add = code => portsPlugin.replace(at, at + '\t' + code + '\n');
	const swap = (from, to) => { assert.ok(portsPlugin.includes(from), from); return portsPlugin.replace(from, to); };
	const MUTANTS = {
		'another program': swap('const ETHTOOL = \'/usr/sbin/ethtool\';', 'const ETHTOOL = \'/bin/sh\';'),
		'ethtool from the PATH': swap('const ETHTOOL = \'/usr/sbin/ethtool\';', 'const ETHTOOL = \'ethtool\';'),
		'another option': swap('popen(ETHTOOL + \' -S \' + name, \'r\')', 'popen(ETHTOOL + \' -s \' + name + \' speed 10\', \'r\')'),
		'a second option': swap('popen(ETHTOOL + \' -S \' + name, \'r\')', 'popen(ETHTOOL + \' -S \' + name + \' --all-groups\', \'r\')'),
		'a second program': swap('popen(ETHTOOL + \' -S \' + name, \'r\')', 'popen(ETHTOOL + \' -S \' + name + \'; reboot\', \'r\')'),
		'the path reassigned': add('ETHTOOL = \'/tmp/x\';'),
		'the path shadowed': add('let ETHTOOL = \'/tmp/x\';'),
		'a second popen': add('let q = popen(\'reboot\', \'r\');'),
		'popen under another name': add('let run = popen; run(\'reboot\');'),
		'system': add('system([ ETHTOOL, \'-S\', \'lan1\' ]);'),
		'uloop': swap('import { access, lsdir, open, popen, readfile } from \'fs\';', 'import { access, lsdir, open, popen, readfile } from \'fs\';\nimport * as uloop from \'uloop\';'),
		'the call builtin': add('call(print, null, null, \'x\');'),
		'a builtin by name': add('global[\'sys\' + \'tem\'](\'reboot\');'),
		'a name from the caller': swap('else if (ARGV[0] == \'call\' && ARGV[1] == \'counters\')', 'else if (ARGV[0] == \'call\' && ARGV[1] == \'port\')\n\tprint(sprintf(\'%J\', read_port(ARGV[2])), \'\\n\');\nelse if (ARGV[0] == \'call\' && ARGV[1] == \'counters\')'),
		'a method that takes an argument': swap('print(\'{ "counters": {} }\\n\');', 'print(\'{ "counters": { "port": "string" } }\\n\');'),
		'standard input read': swap('import { access, lsdir, open, popen, readfile } from \'fs\';', 'import { access, lsdir, open, popen, readfile, stdin } from \'fs\';'),
		'the environment read': add('let n2 = getenv(\'PORT\');'),
		'a name not checked': swap('\t\tif (!match(n, RE_PORT))\n\t\t\tcontinue;\n', ''),
		'a wider pattern': swap(PORTS_RE_PORT, 'const RE_PORT = /^[A-Za-z0-9_.;-]{1,15}$/;'),
		'a leading dash allowed': swap(PORTS_RE_PORT, 'const RE_PORT = /^[A-Za-z0-9_-]{1,15}$/;'),
		'any device, not a DSA port': swap('\t\tif (!dsa)\n\t\t\tcontinue;\n', ''),
		'the ports from elsewhere': swap('for (let n in sort(lsdir(NET) ?? [])) {', 'for (let n in sort(lsdir(\'/tmp\') ?? [])) {'),
		'a found name changed': add('d.found[0] = \'-x\';'),
		'no port cap': swap('\t\tif (length(found) >= MAX_PORTS) {\n\t\t\tmore = true;\n\t\t\tbreak;\n\t\t}\n\n', ''),
		'a larger port cap': swap('const MAX_PORTS = 32;', 'const MAX_PORTS = 4096;'),
		'no time budget': swap('ports[name] = (at - t0 < BUDGET_MS) ? { ...read_port(name), at } : { error: \'time\', at };', 'ports[name] = { ...read_port(name), at };'),
		'a reading timed by the call, not the port': swap('\t\tlet at = now_ms();\n', '\t\tlet at = t0;\n'),
		'a longer budget': swap('const BUDGET_MS = 1000;', 'const BUDGET_MS = 30000;'),
		'the output read whole': swap('let text = p.read(MAX_OUT + 1);', 'let text = p.read(\'all\');'),
		'too much output taken': swap('|| length(text) > MAX_OUT)', ')'),
		'the exit code ignored': swap('if (p.close() !== 0 || type(text)', 'if (p.close() === null || type(text)'),
		'a larger output cap': swap('const MAX_OUT = 32768;', 'const MAX_OUT = 16777216;'),
		'the uevent read unbounded': swap('readfile(NET + \'/\' + n + \'/uevent\', MAX_UEVENT)', 'readfile(NET + \'/\' + n + \'/uevent\')'),
		'a file written': swap('import { access, lsdir, open, popen, readfile } from \'fs\';', 'import { access, lsdir, open, popen, readfile, writefile } from \'fs\';'),
		'code in a template literal': add('let t = \`\${reboot()}\`;'),
		/* the lock: on its own file, for reading, without waiting, before anything */
		'no lock': swap('\tif (!self_file || self_file.lock(\'xn\') !== true)\n\t\treturn { v: 1, state: \'busy\', took: now_ms() - t0, more: false, ports: {} };\n\n', ''),
		'a lock that waits': swap('self_file.lock(\'xn\')', 'self_file.lock(\'x\')'),
		'a shared lock': swap('self_file.lock(\'xn\')', 'self_file.lock(\'sn\')'),
		'the file opened for writing': swap('open(SELF, \'r\')', 'open(SELF, \'r+\')'),
		'the file opened to append': swap('open(SELF, \'r\')', 'open(SELF, \'a\')'),
		'another file locked': swap('open(SELF, \'r\')', 'open(\'/tmp/vantage.lock\', \'w\')'),
		'SELF elsewhere': swap('const SELF = \'/usr/libexec/rpcd/luci.vantage.ports\';', 'const SELF = \'/tmp/vantage.lock\';'),
		'a second file opened': add('let f2 = open(\'/etc/shadow\', \'r\');'),
		'busy where the lock is not held': swap('if (!self_file || self_file.lock(\'xn\') !== true)', 'if (!self_file && self_file.lock(\'xn\') !== true)'),
		'the ports read before the lock': swap('\tlet t0 = now_ms(), self_file = open(SELF, \'r\');\n', '\tlet d0 = dsa_ports();\n\tlet t0 = now_ms(), self_file = open(SELF, \'r\');\n'),
		'a program started while busy': swap('\t\treturn { v: 1, state: \'busy\', took: now_ms() - t0, more: false, ports: {} };', '\t\treturn { v: 1, state: \'busy\', took: now_ms() - t0, more: false, ports: { lan1: read_port(\'lan1\') } };'),
		'the lock let go': add('self_file.lock(\'u\');'),
		'the lock closed early': add('self_file.close();'),
		/* the names: no builtin replaced or shadowed, no function defined twice */
		'a later definition of a builtin': portsPlugin + '\nfunction match(s, re) {\n\treturn [ s ];\n}\n',
		'a second parse': portsPlugin + '\nfunction parse(text) {\n\treturn { rx_bytes: 1, tx_bytes: 1 };\n}\n',
		'a builtin replaced at the top': portsPlugin.replace('// ms on the monotonic clock\n', 'split = sort;\n\n// ms on the monotonic clock\n'),
		'a builtin replaced inside a function': add('length = int;'),
		'a builtin shadowed by a local': add('let readfile2 = 1, sort = reverse;'),
		'a builtin shadowed by a loop': add('for (let match in [ 1 ]) d.more = true;'),
		'a parameter shadowing a builtin': swap('function parse(text) {', 'function parse(text, split) {'),
		'an arrow function': add('let f = (x) => x;'),
		'a function inside one': add('let g = function() { return 1; };'),
		'try and catch': add('try { d.more = true; } catch (match) { d.more = false; }'),
		'the table changed in place': add('COUNTERS[0][0] = \'rx_bytes\';')
	};
	for (const [ name, src ] of Object.entries(MUTANTS)) {
		assert.notEqual(src, portsPlugin, name + ': the mutation applies');
		assert.throws(() => checkPortsSource(src), assert.AssertionError, name);
	}
});

/* every file the dashboard and the theme ship to the device, as text, by package-relative path */
function coreFiles() {
	const out = [];
	const walk = (base, pkg, dir) => {
		if (!fs.existsSync(dir)) return;
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(base, pkg, p);
			else out.push({ rel: pkg + '/' + path.relative(base, p), text: fs.readFileSync(p, 'utf8') });
		}
	};
	walk(PKG, 'luci-app-vantage', path.join(PKG, 'root'));
	walk(THEME_PKG, 'luci-theme-vantage', path.join(THEME_PKG, 'root'));
	walk(THEME_PKG, 'luci-theme-vantage', path.join(THEME_PKG, 'ucode'));
	return out;
}
/* what starts a program from ucode, or reaches what does by name ('system' quoted is the ubus object or uci config) */
const STARTS = /(?<!['"])\b(popen|system|exec|execv|execvp|uloop|fork|spawn)\b(?!['"])|(^|[^.\w])call\s*\(|\bglobal\s*\[/m;
function programFiles(files) {
	const out = { shell: [], starts: [], libexec: [] };
	for (const f of files) {
		if (/^[^/]+\/root\/usr\/libexec\//.test(f.rel)) out.libexec.push(f.rel);
		/* data: uci defaults, menu and ACL files */
		if (/\.json$/.test(f.rel) || /^[^/]+\/root\/etc\/config\/[a-z_]+$/.test(f.rel)) continue;
		/* the uci-defaults scripts: the package manager runs them once, at install */
		if (f.text.startsWith('#!/bin/sh\n')) { out.shell.push(f.rel); continue; }
		/* the rest is ucode: templates, rpcd plugins, scripts */
		if (STARTS.test(f.text)) out.starts.push(f.rel);
	}
	return out;
}

test('switch counters: of the dashboard\'s and the theme\'s files, the plugin alone starts a program; luci.vantage still starts none', () => {
	const files = coreFiles(), found = programFiles(files);
	assert.ok(files.some(f => f.rel.endsWith('/luci.vantage')) && files.some(f => f.rel.endsWith('/sysauth.ut')), 'found the files');
	assert.deepEqual(found.starts, [ 'luci-app-vantage/' + PORTS_REL ]);
	assert.deepEqual(found.libexec, [ 'luci-app-vantage/' + PORTS_REL ]);
	assert.deepEqual(found.shell, [ 'luci-app-vantage/root/etc/uci-defaults/30_luci-app-vantage', 'luci-theme-vantage/root/etc/uci-defaults/30_luci-theme-vantage' ]);
	/* the dashboard's removes the packaged copy of its config that an upgrade leaves, and does nothing else */
	assert.deepEqual(files.find(f => f.rel.endsWith('/30_luci-app-vantage')).text.split('\n').filter(l => l && !l.startsWith('# ')),
		[ '#!/bin/sh', 'rm -f /etc/config/vantage-opkg /etc/config/vantage.apk-new', 'exit 0' ]);
	/* a second program anywhere else is caught: in luci.vantage, a template, a new script */
	const plus = (rel, text) => programFiles(files.concat([ { rel, text } ]));
	assert.notDeepEqual(plus('luci-app-vantage/root/usr/share/rpcd/ucode/luci.vantage2', 'import { popen } from \'fs\';\n').starts, found.starts);
	assert.notDeepEqual(plus('luci-theme-vantage/ucode/template/themes/vantage/x.ut', '{% system(\'id\') %}').starts, found.starts);
	assert.notDeepEqual(plus('luci-app-vantage/root/usr/libexec/vantage/x', '#!/bin/sh\nid\n').shell, found.shell);
	assert.notDeepEqual(plus('luci-app-vantage/root/usr/libexec/rpcd/luci.vantage.x', '#!/usr/bin/ucode\nprint(1);\n').libexec, found.libexec);
	/* luci.vantage, inside rpcd: its own rules still refuse every way to a program */
	for (const [ what, src ] of [
		[ 'popen', plugin.replace('import { access, lsdir, readfile } from \'fs\';', 'import { access, lsdir, popen, readfile } from \'fs\';') ],
		[ 'system', plugin.replace('\tlet wl = cursor();\n', '\tlet wl = cursor();\n\tsystem([ \'/usr/sbin/ethtool\', \'-S\', \'lan1\' ]);\n') ],
		[ 'uloop', plugin.replace('import { connect } from \'ubus\';', 'import { connect } from \'ubus\';\nimport * as uloop from \'uloop\';') ]
	]) {
		assert.notEqual(src, plugin, what + ': the mutation applies');
		assert.throws(() => checkPluginSource(src), assert.AssertionError, what);
	}
});

test('switch counters: the read group grants counters, and no other group of any Vantage package mentions the object', () => {
	assert.deepEqual(acl[READ_GROUP].read.ubus[PORTS_OBJECT], [ 'counters' ]);
	const themeAcl = JSON.parse(fs.readFileSync(path.join(THEME_PKG, 'root/usr/share/rpcd/acl.d/luci-theme-vantage.json'), 'utf8'));
	const groups = Object.entries(acl).concat(Object.entries(apsAcl), Object.entries(trafficAcl), Object.entries(themeAcl));
	const mentions = [];
	for (const [ name, g ] of groups) for (const kind of [ 'read', 'write' ])
		for (const k of pairs((g[kind] || {}).ubus)) if (k.startsWith(PORTS_OBJECT + ' ')) mentions.push(`${name}.${kind}: ${k}`);
	assert.deepEqual(mentions, [ READ_GROUP + '.read: ' + PORTS_CALL ]);
	assert.ok(declared.has(PORTS_CALL), 'the dashboard declares it');
});

/* The dashboard's side in `srcs`: one declare of the object, in the
   dashboard, exactly PORTS_DECLARE (this method, no parameters, so no
   argument can be sent), and one call, without an argument, in PORTS_ASK */
const PORTS_DECLARE = "var callSwitchCounters = rpc.declare({ object: 'luci.vantage.ports', method: 'counters', expect: { '': {} }, reject: true, nobatch: true });";
const PORTS_ASK = '\t\tvar call = this.hwCall = callSwitchCounters().then(function(v) {\n';
function portsCallProblems(srcs) {
	const out = [];
	let declares = 0, calls = 0;
	for (const { file, text } of srcs) {
		const dash = file.endsWith('view/vantage/overview.js');
		for (const m of text.matchAll(/^.*\bobject\s*:\s*['"]luci\.vantage\.ports\b.*$/gm)) {
			declares++;
			if (!dash || m[0] !== PORTS_DECLARE) out.push(`${file}: ${m[0].trim()}`);
		}
		for (const m of text.matchAll(/\bcallSwitchCounters\b(\s*\(([^)]*)\))?/g)) {
			const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index) + 1);
			if (line === PORTS_DECLARE + '\n') continue;
			if (dash && line === PORTS_ASK && m[2] === '') { calls++; continue; }
			out.push(`${file}: ${line.trim()}`);
		}
	}
	if (declares !== 1 || calls !== 1) out.push(`${declares} declares of luci.vantage.ports, ${calls} calls`);
	return out;
}

test('switch counters: the dashboard declares the call once, without parameters, and calls it in one place without arguments', () => {
	assert.deepEqual(portsCallProblems(sources), []);
	assert.doesNotMatch(PORTS_DECLARE, /\b(params|filter)\b/);
	const DASH = 'view/vantage/overview.js';
	const edit = (from, to) => mutate(DASH, t => { assert.ok(t.includes(from), from); return t.replace(from, to); });
	const add = (file, code) => mutate(file, t => t + '\n' + code + '\n');
	for (const [ what, mutant, why ] of [
		[ 'a parameter', edit(PORTS_DECLARE, PORTS_DECLARE.replace("method: 'counters',", "method: 'counters', params: [ 'port' ],")), /overview\.js: var callSwitchCounters = .*params/ ],
		[ 'another method under the name', edit(PORTS_DECLARE, PORTS_DECLARE.replace("'counters'", "'reset'")), /overview\.js: var callSwitchCounters = .*reset/ ],
		[ 'a second declare', add(DASH, "var callPorts2 = rpc.declare({ object: 'luci.vantage.ports', method: 'counters', params: [ 'port' ] });"), /2 declares of luci\.vantage\.ports/ ],
		[ 'a declare in a module', add('vantage/model.js', PORTS_DECLARE), /model\.js: var callSwitchCounters = / ],
		[ 'an argument', edit('callSwitchCounters().then(', "callSwitchCounters({ port: '-x' }).then("), /overview\.js: .*callSwitchCounters\(\{ port/ ],
		[ 'a second call', add(DASH, 'callSwitchCounters();'), /overview\.js: callSwitchCounters\(\);/ ],
		[ 'the call passed on', add(DASH, 'var t = callSwitchCounters;'), /overview\.js: var t = callSwitchCounters;/ ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.match(portsCallProblems(mutant).join('\n'), why, what);
	}
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
		'let hosts = ubus.call(\'luci.vantage\', \'wired\')?.hosts, uplinks = {}, any = false;',
		/* the switch chip's counters (#156): the dashboard's plugin runs ethtool, the report only asks */
		'let hw = nports ? ubus.call(\'luci.vantage.ports\', \'counters\')?.ports : null;'
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
		'const RUN_SH = \'ulimit -c 0; ulimit -f 544; exec "$@" >"$VT_OUT" 2>"$VT_ERR" </dev/null\';',
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
	/* a report is read up to MAX_OUT bytes, and the shell lets dbclient write just over that (1/16 more), not less */
	assert.match(src, /\nconst MAX_OUT = 262144;\n/, 'MAX_OUT = 262144');
	assert.equal([ ...src.matchAll(/\bMAX_OUT\s*=(?!=)/g) ].length, 1, 'MAX_OUT is defined once and never assigned');
	const blocks = /ulimit -f (\d+);/.exec(src);
	assert.ok(blocks && +blocks[1] * 512 === 262144 + 262144 / 16, 'ulimit -f: just over MAX_OUT');
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
		'no size limit': collectorSrc.replace('ulimit -f 544; ', ''),
		'a report read past its limit': collectorSrc.replace('const MAX_OUT = 262144;', 'const MAX_OUT = 1048576;'),
		'a file limit below the report\'s': collectorSrc.replace('ulimit -f 544; ', 'ulimit -f 256; '),
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

/* -------------------------------------------- luci-app-vantage-traffic */

const TRAFFIC_PKG = path.resolve(process.env.VANTAGE_TRAFFIC_PKG || path.join(__dirname, '..', 'luci-app-vantage-traffic'));
const trafficFile = rel => fs.readFileSync(path.join(TRAFFIC_PKG, rel), 'utf8');
const trafficAcl = JSON.parse(trafficFile('root/usr/share/rpcd/acl.d/luci-app-vantage-traffic.json'));
const trafficPlugin = trafficFile('root/usr/libexec/rpcd/luci.vantage.traffic');

test('traffic: one group, luci.vantage.traffic hosts to read and nothing else; no group of the dashboard or the add-on grants it', () => {
	assert.deepEqual(Object.keys(trafficAcl), [ TRAFFIC_GROUP ]);
	const g = trafficAcl[TRAFFIC_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read' ]);
	assert.deepEqual(g.read, { ubus: { 'luci.vantage.traffic': [ 'hosts' ] } });
	assert.match(g.description, /no remote addresses/);
	assert.match(g.description, /Experimental/);
	for (const [ name, grp ] of Object.entries(acl).concat(Object.entries(apsAcl))) {
		assert.notEqual(name, TRAFFIC_GROUP);
		for (const kind of [ 'read', 'write' ])
			for (const k of pairs((grp[kind] || {}).ubus)) assert.ok(!k.startsWith('luci.vantage.traffic '), `${name}.${kind}: ${k}`);
	}
	assert.ok(!grantedCalls().has(TRAFFIC_CALL));
	assert.ok(declared.has(TRAFFIC_CALL));
});

/* The dashboard's side in `srcs`: one declare of the object, in the
   dashboard, exactly TRAFFIC_DECLARE (this method, no parameters, so no
   argument can be sent; a request of its own), one call, without an
   argument, in TRAFFIC_ASK, which runs only where the probe's answer
   (TRAFFIC_PROBE, kept as canTraffic) is yes */
function trafficProblems(srcs) {
	const out = [];
	let declares = 0, calls = 0;
	for (const { file, text } of srcs) {
		const dash = file.endsWith('view/vantage/overview.js');
		for (const m of text.matchAll(/^.*\bobject\s*:\s*['"]luci\.vantage\.traffic\b.*$/gm)) {
			declares++;
			if (!dash || m[0] !== TRAFFIC_DECLARE) out.push(`${file}: ${m[0].trim()}`);
		}
		for (const m of text.matchAll(/\bcallTraffic\b(\s*\(([^)]*)\))?/g)) {
			const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index) + 1);
			if (line === TRAFFIC_DECLARE + '\n') continue;
			if (dash && TRAFFIC_ASK.endsWith('\n' + line) && text.includes(TRAFFIC_ASK) && m[2] === '') { calls++; continue; }
			out.push(`${file}: ${line.trim()}`);
		}
		/* the probe's answer: set once from it, read once, by TRAFFIC_ASK */
		const flags = [ ...text.matchAll(/^.*(?:\.canTraffic\b|\bcanTraffic\s*:).*$/gm) ].map(m => m[0].trim());
		if (dash) {
			if (!text.includes(TRAFFIC_PROBE)) out.push(`${file}: the probe is not the last of load()'s batch`);
			if (JSON.stringify(flags) !== JSON.stringify([
				'return { board: r[1] || {}, canWrite: r[2] === true, mdns: r[4], raw: r[5], canRdns: r[6] === true, canTraffic: r[8] === true };',
				'if (slow && this.canTraffic && !this.trafficCall && !(now < this.trafficNext))',
				'this.canTraffic = data.canTraffic === true;'
			])) out.push(`${file}: canTraffic: ${flags.join(' | ')}`);
		}
		else if (flags.length) out.push(`${file}: canTraffic`);
	}
	if (declares !== 1 || calls !== 1) out.push(`${declares} declares of luci.vantage.traffic, ${calls} calls`);
	return out;
}

test('traffic: the dashboard declares the call once, without parameters, and calls it only for a login rpcd says holds the group', () => {
	assert.deepEqual(trafficProblems(sources), []);
	const view = sources.find(s => s.file.endsWith('view/vantage/overview.js')).text;
	assert.ok(view.includes('\n' + TRAFFIC_DECLARE + '\n'), 'the declare, a line of its own');
	assert.doesNotMatch(TRAFFIC_DECLARE, /\b(params|filter)\b/);
	assert.match(TRAFFIC_DECLARE, /, nobatch: true \}\);$/, 'a request of its own: no poll waits for a read');
	assert.equal([ ...view.matchAll(/callAccess\('access-group', 'luci-app-vantage-traffic', 'read'\)/g) ].length, 1, 'asked about once');
});

test('negative controls: another form, method, argument or place of the traffic call, or a call without the group, fails', () => {
	const DASH = 'view/vantage/overview.js';
	const edit = (from, to) => mutate(DASH, t => { assert.ok(t.includes(from), from); return t.replace(from, to); });
	const add = (file, code) => mutate(file, t => t + '\n' + code + '\n');
	for (const [ what, mutant, why ] of [
		[ 'a parameter', edit(TRAFFIC_DECLARE, TRAFFIC_DECLARE.replace("method: 'hosts',", "method: 'hosts', params: [ 'cmd' ],")), /overview\.js: var callTraffic = .*params/ ],
		[ 'another method under the name', edit(TRAFFIC_DECLARE, TRAFFIC_DECLARE.replace("'hosts'", "'reset'")), /overview\.js: var callTraffic = .*reset/ ],
		[ 'a second declare', add(DASH, "var callTraffic2 = rpc.declare({ object: 'luci.vantage.traffic', method: 'hosts' });"), /2 declares of luci\.vantage\.traffic/ ],
		[ 'a declare in a module', add('vantage/model.js', TRAFFIC_DECLARE), /model\.js: var callTraffic = / ],
		[ 'an argument', edit('this.trafficCall = callTraffic().then(', "this.trafficCall = callTraffic({ cmd: 'x' }).then("), /overview\.js: .*callTraffic\(\{ cmd/ ],
		[ 'a second call', add(DASH, 'L.resolveDefault(callTraffic(), null);'), /overview\.js: L\.resolveDefault\(callTraffic\(\), null\);/ ],
		[ 'called without the group', edit('if (slow && this.canTraffic && !this.trafficCall && !(now < this.trafficNext))', 'if (slow && !this.trafficCall && !(now < this.trafficNext))'), /0 calls|canTraffic: / ],
		[ 'in the poll\'s batch', edit(TRAFFIC_DECLARE, TRAFFIC_DECLARE.replace(', nobatch: true', '')), /overview\.js: var callTraffic = / ],
		[ 'the answer set elsewhere', add(DASH, 'self.canTraffic = true;'), /canTraffic: .*self\.canTraffic = true/ ],
		[ 'the probe moved', edit("\t\t\t\tL.resolveDefault(callAccess('access-group', 'luci-app-vantage-traffic', 'read'), false)\n", "\t\t\t\tL.resolveDefault(callAccess('access-group', 'luci-app-vantage-names', 'write'), false)\n"), /the probe is not the last/ ],
		[ 'the call passed on', add(DASH, 'var t = callTraffic;'), /overview\.js: var t = callTraffic;/ ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.match(trafficProblems(mutant).join('\n'), why, what);
	}
	/* the dashboard's groups granting it would leave nothing foreign to allow */
	const granting = JSON.parse(JSON.stringify(acl));
	granting[READ_GROUP].read.ubus['luci.vantage.traffic'] = [ 'hosts' ];
	assert.ok(pairs(granting[READ_GROUP].read.ubus).has(TRAFFIC_CALL), 'what the test above refuses');
});

/* The plugin's source rules: every line of code (comment lines left out)
   that mentions one of these names, as for the add-on (checkPins) */
const TRAFFIC_PINS = [
	/* files: the table and the switch read; its own directory and files, nothing else */
	[ '\\b(?:open|readfile|writefile|chmod|rename|mkdir|lstat|unlink)\\b', [
		'import { chmod, lstat, mkdir, open, readfile, rename, unlink, writefile } from \'fs\';',
		'let v = readfile(ACCT, 8);',
		'let st = lstat(DIR);',
		'mkdir(DIR, 0700);',
		'st = lstat(DIR);',
		'if (writefile(tmp, text) == length(text) && chmod(tmp, 0600) && rename(tmp, file) === true)',
		'unlink(tmp);',
		'let text = readfile(DIR + \'/state.json\', MAX_STATE + 1), st = null;',
		'let text = readfile(DIR + \'/answer.json\', MAX_ANSWER), a = null;',
		'let acct = acct_on(), f = (acct !== false) ? open(TABLE, \'r\') : null;',
		'let lock = open(DIR + \'/lock\', \'a\', 0600);'
	] ],
	[ '\\b(?:TABLE|ACCT|THEME|DIR)\\b', [
		'const TABLE = \'/proc/net/nf_conntrack\';',
		'const ACCT = \'/proc/sys/net/netfilter/nf_conntrack_acct\';',
		'const DIR = \'/var/run/vantage-traffic\';',
		'const THEME = \'vantage_theme\';    // read only: is Low-power router on',
		'return cursor().get(THEME, \'appearance\', \'power\') == \'low\';',
		'let v = readfile(ACCT, 8);',
		'let st = lstat(DIR);',
		'mkdir(DIR, 0700);',
		'st = lstat(DIR);',
		'let tmp = DIR + \'/\' + name + \'.new\', file = DIR + \'/\' + name;',
		'let text = readfile(DIR + \'/state.json\', MAX_STATE + 1), st = null;',
		'let text = readfile(DIR + \'/answer.json\', MAX_ANSWER), a = null;',
		'let acct = acct_on(), f = (acct !== false) ? open(TABLE, \'r\') : null;',
		'let lock = open(DIR + \'/lock\', \'a\', 0600);'
	] ],
	/* the directory: its own (a directory, not a link, root's, closed to others) or none */
	[ '\\bst(?:\\?)?\\.(?:type|mode|uid)\\b', [ 'return st?.type == \'directory\' && st.uid === 0 && !(st.mode & 0077);' ] ],
	/* writes: whole, 0600, then in place, of these two files only; what a
	   failed one left beside the file removed */
	[ '\\b(?:put|tmp)\\b', [
		'function put(name, text) {',
		'let tmp = DIR + \'/\' + name + \'.new\', file = DIR + \'/\' + name;',
		'if (writefile(tmp, text) == length(text) && chmod(tmp, 0600) && rename(tmp, file) === true)',
		'unlink(tmp);',
		'return put(\'state.json\', sprintf(\'%J\', { v: 2, at: now, flows, totals }));',
		'put(\'answer.json\', text);'
	] ],
	/* one read at a time; the lock file 0600 */
	[ '\\block\\b', [ 'let lock = open(DIR + \'/lock\', \'a\', 0600);', 'if (!lock || lock.lock(\'xn\') !== true)' ] ],
	[ '\\bcursor\\b', [
		'import { cursor } from \'uci\';',
		'return cursor().get(THEME, \'appearance\', \'power\') == \'low\';'
	] ],
	/* two read-only dumps, the neighbour tables of IPv4 and IPv6 */
	[ '\\b(?:rtnl|family)\\b', [
		'import * as rtnl from \'rtnl\';',
		'for (let family in [ rtnl.const.AF_INET, rtnl.const.AF_INET6 ]) {',
		'let dump = rtnl.request(rtnl.const.RTM_GETNEIGH, rtnl.const.NLM_F_DUMP, { family });'
	] ],
	/* the table: read line by line, closed, nothing else */
	[ '\\bf\\b', [
		'const RE_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;',
		'function feed(f, neigh, now, stop, st) {',
		'for (let l = f.read(\'line\'); l; l = f.read(\'line\')) {',
		'let acct = acct_on(), f = (acct !== false) ? open(TABLE, \'r\') : null;',
		'if (f) {',
		'feed(f, neighbours(), t0, t0 + STOP_MS, st);',
		'f.close();'
	] ],
	/* the answer: a MAC and two counts a host, and the read's numbers */
	[ '\\bpush\\(out\\b|\\br\\.(?:st|acct|hosts)\\b', [
		'push(out, { mac: k, rx: totals[k][0], tx: totals[k][1] });',
		'v: 1, at: t0, took, every, slow: took * SLOW_FACTOR > (low ? LOW_MS : WINDOW_MS), low, acct: r.acct,',
		'entries: r.st.entries, partial: r.st.partial, offloaded: r.st.offloaded, hw: r.st.hw,',
		'zeroed: r.st.zeroed, dropped: r.st.dropped, hosts: r.hosts'
	] ],
	/* rpcd's two questions: one method, which takes nothing; nothing read from its input */
	[ '\\b(?:ARGV|print)\\b', [
		'if (ARGV[0] == \'list\')',
		'print(\'{ "hosts": {} }\\n\');',
		'else if (ARGV[0] == \'call\' && ARGV[1] == \'hosts\')',
		'print(hosts() ?? \'{}\', \'\\n\');'
	] ]
];

function checkTrafficSource(src) {
	assert.ok(src.startsWith('#!/usr/bin/ucode -S\n'), 'an executable ucode script');
	const code = codeOf(src.replace(/^#![^\n]*\n/, ''), 'the traffic plugin');
	assert.deepEqual(linesWith(code, 'import'), [ 'import * as rtnl from \'rtnl\';', 'import { cursor } from \'uci\';', 'import { chmod, lstat, mkdir, open, readfile, rename, unlink, writefile } from \'fs\';' ]);
	/* unlink is pinned above (the temporary file only) */
	const word = /\b(system|popen|exec|require|loadfile|loadstring|include|render|symlink|rmdir|global|getenv|stdin|sleep|exit)\b/.exec(code);
	assert.equal(word, null, word && `"${word[1]}" is banned in the traffic plugin`);
	assert.doesNotMatch(code, /(^|[^.\w])call\s*\(/m, 'the call() builtin is banned in the traffic plugin');
	for (const name of [ 'TABLE', 'ACCT', 'THEME', 'DIR' ])
		assert.equal([ ...code.matchAll(new RegExp('\\b' + name + '\\s*=(?!=)', 'g')) ].length, 1, name + ' is defined once and never assigned');
	checkPins(src.replace(/^#![^\n]*\n/, ''), 'the traffic plugin', TRAFFIC_PINS);
}

test('traffic: the plugin answers the granted method, takes nothing, reads only what it lists, writes only its own state, runs nothing', () => {
	checkTrafficSource(trafficPlugin);
});

test('traffic: the plugin rules catch each breach', () => {
	const at = '\tlet acct = acct_on(), f = (acct !== false) ? open(TABLE, \'r\') : null;\n';
	assert.ok(trafficPlugin.includes(at), 'insertion point');
	const add = code => trafficPlugin.replace(at, at + '\t' + code + '\n');
	const swap = (from, to) => { assert.ok(trafficPlugin.includes(from), from); return trafficPlugin.replace(from, to); };
	const MUTANTS = {
		'another file written': add('writefile(\'/etc/config/vantage\', \'\');'),
		'a write past put': add('writefile(DIR + \'/hosts.txt\', \'\');'),
		'a second import': swap('import { cursor } from \'uci\';', 'import { cursor } from \'uci\';\nimport { connect } from \'ubus\';'),
		'its input read': swap('import { chmod, lstat, mkdir, open, readfile, rename, unlink, writefile } from \'fs\';', 'import { chmod, lstat, mkdir, open, readfile, rename, stdin, unlink, writefile } from \'fs\';'),
		'another file read': add('let pw = readfile(\'/etc/shadow\', 8);'),
		'the table opened for writing': swap('open(TABLE, \'r\')', 'open(TABLE, \'w\')'),
		'a shadowed path': add('let TABLE = \'/etc/shadow\';'),
		'a shadowed directory': add('let DIR = \'/tmp\';'),
		'the state elsewhere': swap('const DIR = \'/var/run/vantage-traffic\';', 'const DIR = \'/tmp/vantage-traffic\';'),
		'the directory open to others': swap('mkdir(DIR, 0700);', 'mkdir(DIR, 0755);'),
		'a directory others may enter taken': swap('return st?.type == \'directory\' && st.uid === 0 && !(st.mode & 0077);', 'return st?.type == \'directory\' && st.uid === 0;'),
		'a link taken': swap('return st?.type == \'directory\' && st.uid === 0 && !(st.mode & 0077);', 'return st?.type != \'file\' && st.uid === 0 && !(st.mode & 0077);'),
		'another account\'s directory taken': swap('return st?.type == \'directory\' && st.uid === 0 && !(st.mode & 0077);', 'return st?.type == \'directory\' && !(st.mode & 0077);'),
		'files others may read': swap('chmod(tmp, 0600)', 'chmod(tmp, 0644)'),
		'a lock file others may read': swap('open(DIR + \'/lock\', \'a\', 0600)', 'open(DIR + \'/lock\', \'a\')'),
		'a file written in place': swap('if (writefile(tmp, text) == length(text) && chmod(tmp, 0600) && rename(tmp, file) === true)', 'if (writefile(file, text) == length(text) && chmod(file, 0600))'),
		'another file removed': add('unlink(DIR + \'/../vantage\');'),
		'the file removed, not what is beside it': swap('unlink(tmp);', 'unlink(file);'),
		'a third file': swap('put(\'answer.json\', text);', 'put(\'answer.json\', text);\n\tput(\'flows.json\', sprintf(\'%J\', flows));'),
		'the entries in the answer file': swap('put(\'answer.json\', text);', 'put(\'answer.json\', sprintf(\'%J\', flows));'),
		'the state read unbounded': swap('readfile(DIR + \'/state.json\', MAX_STATE + 1)', 'readfile(DIR + \'/state.json\')'),
		'no lock': swap('if (!lock || lock.lock(\'xn\') !== true)', 'if (!lock)'),
		'the switch read unbounded': swap('readfile(ACCT, 8)', 'readfile(ACCT)'),
		'the switch turned on': add('writefile(ACCT, \'1\');'),
		'a program': add('system([ \'/sbin/reboot\' ]);'),
		'the call builtin': add('call(print, null, null, \'x\');'),
		'a builtin by name': add('global[\'sys\' + \'tem\'](\'reboot\');'),
		'code from text': add('loadstring(\'return 1\')();'),
		'the theme config written': swap('return cursor().get(THEME, \'appearance\', \'power\') == \'low\';', 'let c = cursor(); c.set(THEME, \'appearance\', \'power\', \'low\'); c.commit(THEME);\n\treturn false;'),
		'another config read': add('let lan = cursor().get(\'network\', \'lan\', \'ipaddr\');'),
		'the cursor by reference': add('let mk = cursor;'),
		'a netlink write': swap('rtnl.const.RTM_GETNEIGH, rtnl.const.NLM_F_DUMP', 'rtnl.const.RTM_DELNEIGH, rtnl.const.NLM_F_DUMP'),
		'another netlink request': add('rtnl.request(rtnl.const.RTM_NEWNEIGH, 0, {});'),
		'the bridge table dumped': swap('[ rtnl.const.AF_INET, rtnl.const.AF_INET6 ]', '[ rtnl.const.AF_INET, rtnl.const.AF_BRIDGE ]'),
		'rtnl by reference': add('let nl = rtnl;'),
		'a remote address in the answer': swap('push(out, { mac: k, rx: totals[k][0], tx: totals[k][1] });', 'push(out, { mac: k, rx: totals[k][0], tx: totals[k][1], peers: totals[k][3] });'),
		'the entries in the answer': swap('zeroed: r.st.zeroed, dropped: r.st.dropped, hosts: r.hosts', 'zeroed: r.st.zeroed, dropped: r.st.dropped, hosts: r.hosts, flows'),
		'an argument taken': swap('print(\'{ "hosts": {} }\\n\');', 'print(\'{ "hosts": { "cmd": "string" } }\\n\');'),
		'a second method': swap('else if (ARGV[0] == \'call\' && ARGV[1] == \'hosts\')', 'else if (ARGV[0] == \'call\' && (ARGV[1] == \'hosts\' || ARGV[1] == \'flows\'))'),
		'the handle written': add('f?.write(\'x\');'),
		'the handle passed on': add('let g = f;'),
		'no first line': trafficPlugin.replace(/^#![^\n]*\n/, '')
	};
	for (const [ name, src ] of Object.entries(MUTANTS)) {
		assert.notEqual(src, trafficPlugin, name + ': the mutation applies');
		assert.throws(() => checkTrafficSource(src), assert.AssertionError, name);
	}
});

/* ------------------------------------- how the browser files reach rpcd */

/* The checks above read the calls the JavaScript declares; these hold
   that there is no other way out, in every browser file of the dashboard
   and of the add-ons (the traffic add-on has none), and that nothing
   changes the built-ins those checks lean on, in those and in the
   theme's (which runs in the dashboard's page), as is true today:
   - rpc only as `'require rpc';` and `rpc.declare({` (or in an object's
     name, `luci-rpc`): no rpc.call, no alias, no other member; one
     exception, a comment in fmt.js;
   - fetch only for the packages' own CSS and the theme's script (the
     calls in FETCHES, by file), the dashboard's own fetch method, and
     prose;
   - no XMLHttpRequest, sendBeacon, WebSocket, EventSource or
     importScripts, no L.Request / L.request / L.get / L.post, and no
     'require request' or 'require xhr';
   - .prototype only as (Object|Array).prototype.<name>.call(, and no
     defineProperty, defineProperties, setPrototypeOf, getPrototypeOf,
     __proto__, __defineGetter__/__defineSetter__ or Reflect. */
const BROWSER_PKGS = [ PKG, APS_PKG ];
const browserFiles = pkgs => pkgs.flatMap(p => fs.existsSync(path.join(p, 'htdocs')) ? jsFiles(path.join(p, 'htdocs')).map(f => ({ file: path.relative(path.dirname(p), f), text: fs.readFileSync(f, 'utf8') })) : []);
const RPC_EXCEPTIONS = { 'vantage/fmt.js': [ 'no DOM, no rpc. Every' ] };
const FETCHES = {
	'view/vantage/overview.js': [ "fetch(L.resource('vantage/app.css') + '?v=' + L.env.resource_version).then(", "fetch(L.resource('menu-vantage.js'), { method: 'HEAD', cache: 'no-store' }).then(" ],
	'view/vantage/firewall.js': [ "fetch(L.resource('vantage/app.css') + '?v=' + L.env.resource_version).then(" ],
	'view/vantage/aps.js': [ "fetch(L.resource('vantage/app.css') + '?v=' + L.env.resource_version).then(", "fetch(L.resource('vantage/aps.css') + '?v=' + L.env.resource_version).then(" ]
};
const OTHER_WAYS = /\b(?:XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\b|\bL\s*\.\s*(?:Request|request|get|post)\b/g;
const BUILTIN_CHANGES = /\b(?:defineProperty|defineProperties|setPrototypeOf|getPrototypeOf|__proto__|__defineGetter__|__defineSetter__|Reflect)\b/g;

function lineAt(text, i) { return text.slice(text.lastIndexOf('\n', i) + 1, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i)).trim(); }
function keyOf(file) { return Object.keys(Object.assign({}, RPC_EXCEPTIONS, FETCHES)).find(k => file.endsWith('/' + k)) || null; }

function transportProblems(files) {
	const out = [];
	for (const { file, text } of files) {
		const key = keyOf(file);
		for (const m of text.matchAll(/\brpc\b/g)) {
			const i = m.index;
			if (text.startsWith('rpc.declare({', i) || text.slice(i - 5, i) === 'luci-' || lineAt(text, i) === "'require rpc';") continue;
			if ((RPC_EXCEPTIONS[key] || []).some(x => text.slice(i - x.indexOf('rpc'), i - x.indexOf('rpc') + x.length) === x)) continue;
			out.push(`${file}: rpc in ${lineAt(text, i)}`);
		}
		const fetches = (FETCHES[key] || []).slice();
		for (const m of text.matchAll(/\bfetch\b/g)) {
			const i = m.index, k = fetches.findIndex(f => text.startsWith(f, i));
			if (k >= 0) { fetches.splice(k, 1); continue; }
			/* the dashboard's own poll, fetch() */
			if (file.endsWith('view/vantage/overview.js') && (/(?:self|this)\.$/.test(text.slice(i - 5, i)) && text.startsWith('fetch()', i) || lineAt(text, i) === 'fetch: function() {')) continue;
			/* prose: "the last fetch failed", "fetch's", "(fetch)" closing a comment */
			if (/[ (]/.test(text[i - 1]) && /^(?: [a-z]|'s |\) \*\/)/.test(text.slice(i + 5, i + 9))) continue;
			out.push(`${file}: fetch in ${lineAt(text, i)}`);
		}
		for (const f of fetches) out.push(`${file}: not found: ${f}`);
		for (const m of text.matchAll(OTHER_WAYS)) out.push(`${file}: ${m[0]} in ${lineAt(text, m.index)}`);
		for (const r of requiresOf(text)) if (/^(?:request|xhr)$/.test(r)) out.push(`${file}: 'require ${r}'`);
	}
	return out;
}

function builtinProblems(files) {
	const out = [];
	for (const { file, text } of files) {
		for (const m of text.matchAll(/\.\s*prototype\b|['"`]prototype['"`]/g))
			if (!/(?:^|[^.\w$])(?:Object|Array)\.prototype\.\w+\.call\($/.test(text.slice(Math.max(0, m.index - 12), m.index) + text.slice(m.index, m.index + 40).replace(/^(\.prototype\.\w+\.call\().*$/s, '$1')))
				out.push(`${file}: prototype in ${lineAt(text, m.index)}`);
		for (const m of text.matchAll(BUILTIN_CHANGES)) out.push(`${file}: ${m[0]} in ${lineAt(text, m.index)}`);
	}
	return out;
}

test('the browser files reach rpcd only through rpc.declare; fetch only for the packages\' own static files; nothing changes a built-in', () => {
	const files = browserFiles(BROWSER_PKGS);
	assert.ok(files.length >= 14 && files.some(f => f.file.endsWith('view/vantage/aps.js')), 'the dashboard\'s and the add-on\'s');
	assert.deepEqual(transportProblems(files), []);
	const all = files.concat(browserFiles([ THEME_PKG ]));
	assert.ok(all.some(f => f.file.endsWith('menu-vantage.js')), 'and the theme\'s');
	assert.deepEqual(builtinProblems(all), []);
});

test('negative controls: ids from anywhere but the session\'s ACL, TILE_OBJ changed, rpc used beside declare, a raw request, a built-in changed: each fails', () => {
	const DASH = 'view/vantage/overview.js';
	const dash = () => sources.find(s => s.file.endsWith(DASH)).text;
	const edit = (from, to) => mutate(DASH, t => { assert.ok(t.includes(from), from); return t.replace(from, to); });
	const add = code => mutate(DASH, t => t + '\n' + code + '\n');
	const MAP = 'asks = ids.map(function(id) { return self.askTile(id, now); })';
	const IDS_UBUS = "!Array.isArray(acl) ? acl.ubus : null, out = [];";
	/* 11: where the ids come from */
	for (const [ what, mutant, why ] of [
		[ 'ids from the saved layout\'s x entries', edit(MAP, "asks = ids.concat(Object.keys(self.layouts || {}).reduce(function(a, k) { return a.concat((self.layouts[k] || []).filter(function(e) { return layout.isExtra(e.id); }).map(function(e) { return e.id.slice(1); })); }, [])).map(function(id) { return self.askTile(id, now); })"), /not handed to askTile as they are/ ],
		[ 'tileIds reading the uci scope too', edit(IDS_UBUS, "!Array.isArray(acl) ? Object.assign({}, acl.uci, acl.ubus) : null, out = [];"), /0 tileIds in its pinned form/ ],
		[ 'tileIds reading the access-group names', edit("\treturn out.sort().slice(0, layout.EXTRA_MAX);\n}\n", "\tObject.keys(acl['access-group'] || {}).forEach(function(g) { var m = /^vantage-tile-([a-z]{1,7})$/.exec(g); if (m) out.push(m[1]); });\n\treturn out.sort().slice(0, layout.EXTRA_MAX);\n}\n"), /0 tileIds in its pinned form/ ],
		[ 'a second caller of askTile', add("function askOther(view) { return view.askTile('other', Date.now()); }"), /askTile in function askOther/ ],
		[ 'ids from localStorage', edit(MAP, "asks = ids.concat(JSON.parse(window.localStorage.getItem('vantage.tiles') || '[]')).map(function(id) { return self.askTile(id, now); })"), /not handed to askTile as they are/ ],
		[ 'a constant id', edit(MAP, "asks = ids.concat([ 'zzzzzzz' ]).map(function(id) { return self.askTile(id, now); })"), /not handed to askTile as they are/ ],
		[ 'id reassigned above the call', edit("\t\tvar asked = Date.now();\n\t\ts.call = tileCall(id).then(", "\t\tvar asked = Date.now();\n\t\tid = window.location.hash.slice(1) || id;\n\t\ts.call = tileCall(id).then("), /askTile does not hand its id/ ],
		[ 'the ids replaced after the read', edit("\t\t\tself.tileIds = ids;\n", "\t\t\tids = [ 'dns', 'modem', 'sqm' ];\n\t\t\tself.tileIds = ids;\n"), /not handed to askTile as they are/ ],
		[ 'the read replaced elsewhere', add("function forge(view) { view.tilesMay = Promise.resolve([ 'dns' ]); }"), /tilesMay used/ ],
		[ 'tileIds defined again below', add('function tileIds(acl) { return [ \'dns\' ]; }'), /2 definitions of tileIds/ ],
		[ 'askTile defined again below', edit('\ttileHidden: function(id) {', '\taskTile: function(id, now) { return tileCall(\'dns\'); },\n\ttileHidden: function(id) {'), /askTile defined and called 3 times|tileCall/ ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.match(tileProblems(mutant).join('\n'), why, what);
	}
	/* 12: TILE_OBJ only tested, never changed */
	for (const [ what, mutant, why, check ] of [
		[ 'an alias of TILE_OBJ changed', add('var tileObjAlias = TILE_OBJ;\ntileObjAlias.test = function() { return true; };'), /TILE_OBJ in var tileObjAlias = TILE_OBJ;/, tileProblems ],
		[ 'RegExp.prototype.test replaced', add('RegExp.prototype.test = function() { return true; };'), /overview\.js: prototype in RegExp\.prototype\.test = /, builtinProblems ],
		[ 'test defined on TILE_OBJ', add("Object.defineProperty(TILE_OBJ, 'test', { value: function() { return true; } });"), /TILE_OBJ in Object\.defineProperty\(TILE_OBJ/, tileProblems ],
		[ 'test defined on TILE_OBJ (the built-in)', add("Object.defineProperty(TILE_OBJ, 'test', { value: function() { return true; } });"), /overview\.js: defineProperty in /, builtinProblems ],
		[ 'a prototype reached by name', add("RegExp['prototype'].test = function() { return true; };"), /prototype in RegExp\['prototype'\]/, builtinProblems ],
		[ 'a prototype reached through an object', add('Object.getPrototypeOf(TILE_OBJ).test = function() { return true; };'), /getPrototypeOf in /, builtinProblems ],
		[ 'a module changes RegExp', mutate('vantage/model.js', t => t + '\nRegExp.prototype.exec = function() { return null; };\n'), /model\.js: prototype in RegExp\.prototype\.exec/, builtinProblems ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.match(check(mutant).join('\n'), why, what);
	}
	assert.match(builtinProblems([ { file: 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js', text: 'Object.prototype.hasOwnProperty.call(a, b);\nString.prototype.trim = null;\n' } ]).join('\n'), /menu-vantage\.js: prototype in String\.prototype\.trim/);
	/* 13: rpc, fetch, XMLHttpRequest */
	const aps = browserFiles([ APS_PKG ]);
	const withAps = srcs => srcs.concat(aps);
	for (const [ what, mutant, why ] of [
		[ 'rpc aliased, then declare', add("var rpcAlias = rpc;\nvar callAny = rpcAlias.declare({ object: 'file', method: 'exec', params: [ 'command' ] });"), /overview\.js: rpc in var rpcAlias = rpc;/ ],
		[ 'rpc.call directly', add("function rawCall(o, m, a) { return new Promise(function(res) { rpc.call({ jsonrpc: '2.0', id: 1, method: 'call', params: [ rpc.getSessionID(), o, m, a ] }, res); }); }"), /overview\.js: rpc in function rawCall/ ],
		[ 'rpc required under another name', edit("'require rpc';\n", "'require rpc as r';\n"), /overview\.js: rpc in 'require rpc as r';/ ],
		[ 'a raw fetch to ubus', add("function rawTile(o, m, a) { return fetch(L.url('admin/ubus'), { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ L.env.sessionid, o, m, a ] }) }); }"), /overview\.js: fetch in function rawTile/ ],
		[ 'window.fetch', add("window.fetch('/ubus/', { method: 'POST' });"), /overview\.js: fetch in window\.fetch/ ],
		[ 'fetch passed on', add('var f = fetch;'), /overview\.js: fetch in var f = fetch;/ ],
		[ 'a CSS fetch with more', edit("fetch(L.resource('vantage/app.css') + '?v=' + L.env.resource_version)", "fetch(L.resource('vantage/app.css') + '?v=' + L.env.resource_version, { method: 'POST' })"), /overview\.js: fetch in |not found: fetch\(L\.resource\('vantage\/app\.css'\)/ ],
		[ 'XMLHttpRequest', add("var x = new XMLHttpRequest(); x.open('POST', L.url('admin/ubus'));"), /overview\.js: XMLHttpRequest in / ],
		[ 'LuCI\'s request module', edit("'require rpc';\n", "'require rpc';\n'require request';\n"), /overview\.js: 'require request'/ ],
		[ 'L.post', add("L.post('admin/ubus', {});"), /overview\.js: L\.post in / ],
		[ 'the same in a module', mutate('vantage/model.js', t => t + "\nvar r = rpc;\n"), /model\.js: rpc in var r = rpc;/ ]
	]) {
		assert.notDeepEqual(mutant, sources, what + ': the mutation applies');
		assert.match(transportProblems(withAps(mutant)).join('\n'), why, what);
	}
	const apsView = aps.find(f => f.file.endsWith('view/vantage/aps.js'));
	assert.match(transportProblems(aps.map(f => f === apsView ? { file: f.file, text: f.text + "\nfetch('/ubus/', { method: 'POST' });\n" } : f)).join('\n'), /aps\.js: fetch in fetch\('\/ubus\/'/, 'the add-on too');
	assert.ok(dash().includes("'require rpc';\n"));
});
