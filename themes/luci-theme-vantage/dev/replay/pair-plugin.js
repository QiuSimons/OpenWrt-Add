'use strict';
/* Replay stand-in for luci-app-vantage-aps's rpcd plugin, object
   luci.vantage.pair (root/usr/share/rpcd/ucode/luci.vantage-pair, with
   its checks in root/usr/share/ucode/vantage/aps.uc). The replay has no
   rpcd, dropbear or SSH keys, so this keeps the pairing state in memory,
   per store, for the session: restart the replay to reset it.

   Codes, one line each, fields apart by blanks:
     vantage-router 1 ssh-ed25519 <key> <name>                       (router -> AP)
     vantage-ap 1 ssh-ed25519 <host key> <addr> <port> <mac> <name>   (AP -> router)

   Same methods, argument policy, checks and replies as the plugin:
     status         {} -> { router: { code, aps: [ { id, name, addr, port, net? } ] },
                            ap: { ssh, routers: [ { name, key } ], reply } }
     router_code    {} -> { code }  (this device's key, made on first use)
     add_ap         { code, addr? } -> { id } | { error: invalid|self|no-key|duplicate|full }
                    (the entry keeps the reply's MAC too, not in status, and
                    the name of the network its address is on, when it is on
                    one of this device's: net; self: this device's own reply)
     remove_ap      { id } -> { ok: true } | { error: unknown }
     allow_router   { code } -> { reply } | { error: invalid|<ssh state>|duplicate|full }
     revoke_router  { key } -> { ok: true } | { error: unknown }
   rpcd refuses an argument outside the policy or of another type with
   INVALID_ARGUMENT, and an unknown method with METHOD_NOT_FOUND. What the
   replay cannot fail at (failed: a program or a write) it never answers.
   tests/aps-page.test.js runs the code checks here and in aps.uc (with a
   host ucode) on the same cases.

   It starts as a router with the three access points of aps.js paired
   (ap-hall, ap-den, ap-loft: the same ids, names, addresses and MACs, so
   the page lists what the dashboard shows with --aps; the first two on
   its lan, ap-loft at an address of none of its networks, so with no
   network kept) and as an access point that one router may read, with
   documentation addresses and made-up keys (a fixed ssh-ed25519 header
   and 32 bytes of a SHA-256). Adding or removing an access point here
   changes this list only: the --aps report is a fixed picture, so one
   added stays "waiting for its first report" and one removed stays on
   the dashboard. This device's name comes from the recorded hostname
   (pseudonymised under --demo), as the plugin makes it from
   /proc/sys/kernel/hostname.

   For previews: VANTAGE_REPLAY_PAIR_SSH sets the SSH state the access
   point side reports (ok, no-dropbear, no-key-options, unsupported,
   no-host-key, not-running, keys-unreadable, no-address; with
   keys-unreadable no router is listed and none can be revoked, as with
   the key file unread), and
   VANTAGE_REPLAY_PAIR_NO_DBCLIENT=1 takes the SSH client away (no code,
   router_code answers no-dbclient).

   store.js loads every dev/replay/*-plugin.js and routes calls on OBJECT
   to call(store, method, args); POLICY feeds `ubus list`. */

const crypto = require('crypto');

const OBJECT = 'luci.vantage.pair';
const MAX_APS = 16;
const MAX_ROUTERS = 8;
/* bytes of a pasted code */
const MAX_CODE = 512;
const SSH_STATES = [ 'ok', 'no-dropbear', 'no-key-options', 'unsupported', 'no-host-key', 'not-running', 'keys-unreadable', 'no-address' ];

/* rpcd ubus status codes */
const INVALID_ARGUMENT = 2;
const METHOD_NOT_FOUND = 3;

const POLICY = {
	status: {},
	router_code: {},
	add_ap: { code: 'string', addr: 'string' },
	remove_ap: { id: 'string' },
	allow_router: { code: 'string' },
	revoke_router: { key: 'string' }
};

/* the checks of vantage/aps.uc, which the plugin and the collector share */
const RE_KEY = /^AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$/;
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const RE_IPV4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;
const RE_IPV6 = /^[0-9a-f:]{2,39}$/;
const RE_GROUP = /^[0-9a-f]{1,4}$/;
const RE_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const RE_NET = /^[A-Za-z0-9_]{1,64}$/;
/* the 19 bytes in front of every ssh-ed25519 public key blob: the length
   of the type name, the name, the length of the 32-byte key */
const HEADER = Buffer.concat([ Buffer.from([ 0, 0, 0, 11 ]), Buffer.from('ssh-ed25519'), Buffer.from([ 0, 0, 0, 32 ]) ]);

/* a string without a NUL byte (aps.uc: ucode matches a regular expression
   against the bytes before the first one only) */
function str(v) { return typeof v === 'string' && !v.includes('\0'); }

/* base64 of exactly the 51-byte ssh-ed25519 blob -> it, or null */
function key(v) {
	if (!str(v) || !RE_KEY.test(v)) return null;
	const b = Buffer.from(v, 'base64');
	return b.length === 51 && b.subarray(0, 19).equals(HEADER) ? v : null;
}

function name(v) { return str(v) && RE_NAME.test(v) ? v : null; }

/* a hostname as a code's name: each byte a name may not hold becomes
   '-', leading non-alphanumerics go */
function nameOf(host, fallback) {
	const n = str(host) ? Buffer.from(host).toString('latin1').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 63) : '';
	return name(n) || fallback;
}

/* unicast IPv4, not 0/8, loopback nor link-local, no leading zeros */
function ipv4(v) {
	const m = RE_IPV4.exec(v);
	if (!m) return false;
	for (let i = 1; i <= 4; i++)
		if (+m[i] > 255 || (m[i].length > 1 && m[i][0] === '0')) return false;
	return +m[1] >= 1 && +m[1] <= 223 && +m[1] !== 127 && !(+m[1] === 169 && +m[2] === 254);
}

/* IPv6 in hex groups (no embedded IPv4, zone or brackets), judged by its
   eight groups however it is spelled: nothing of ::/8 (unspecified,
   loopback, IPv4-mapped), link-local or multicast */
function ipv6(v) {
	if (!RE_IPV6.test(v) || v.includes(':::')) return false;
	const parts = v.split('::');
	if (parts.length > 2) return false;
	const sides = [ [], [] ];
	for (let k = 0; k < parts.length; k++) {
		if (parts[k] === '') continue;
		for (const g of parts[k].split(':')) {
			if (!RE_GROUP.test(g)) return false;
			sides[k].push(parseInt(g, 16));
		}
	}
	const n = sides[0].length + sides[1].length;
	if (parts.length === 2 ? n > 7 : n !== 8) return false;
	const groups = sides[0].concat(new Array(8 - n).fill(0), sides[1]);
	return groups[0] >= 0x100 && (groups[0] & 0xffc0) !== 0xfe80 && groups[0] < 0xff00;
}

/* an address to reach an access point at, lower case, or null */
function addr(v) {
	if (!str(v)) return null;
	v = v.toLowerCase();
	return (ipv4(v) || ipv6(v)) ? v : null;
}

/* a unicast MAC, not all zeros, lower case, or null */
function mac(v) {
	v = str(v) ? v.toLowerCase() : null;
	return (v && RE_MAC.test(v) && v !== '00:00:00:00:00:00' && !(parseInt(v.slice(0, 2), 16) & 1)) ? v : null;
}

function port(v) {
	if (str(v) && /^[0-9]{1,5}$/.test(v)) v = +v;
	return (Number.isInteger(v) && v >= 1 && v <= 65535) ? v : null;
}

/* one of this device's networks by its name ("lan"), as netifd names an
   interface: a uci section's name */
function net(v) { return str(v) && RE_NET.test(v) ? v : null; }

/* The name of the network an address is on (aps.uc net_of; ifaces: the
   interfaces of ubus network.interface dump): of the interface that is
   up, has a device and holds the address in a subnet most narrowly; null
   when none does. IPv4 only: the replay's own networks have no IPv6
   subnets, so an IPv6 address is on none of them */
function netOf(a, ifaces) {
	const m = str(a) ? RE_IPV4.exec(a) : null;
	if (!m || m.slice(1).some(o => +o > 255) || !Array.isArray(ifaces)) return null;
	const num = o => ((+o[0] * 256 + +o[1]) * 256 + +o[2]) * 256 + +o[3];
	const want = num(m.slice(1));
	let best = null, most = 0;
	for (const i of ifaces) {
		if (!i || typeof i !== 'object' || i.up !== true || !str(i.l3_device) || !/^[A-Za-z0-9_.-]{1,15}$/.test(i.l3_device)) continue;
		for (const n of Array.isArray(i['ipv4-address']) ? i['ipv4-address'] : []) {
			const f = n && str(n.address) ? RE_IPV4.exec(n.address) : null;
			if (!f || f.slice(1).some(o => +o > 255) || !Number.isInteger(n.mask) || n.mask < 1 || n.mask > 32) continue;
			const size = Math.pow(2, 32 - n.mask);
			if (Math.floor(want / size) === Math.floor(num(f.slice(1)) / size) && n.mask > most) { most = n.mask; best = i; }
		}
	}
	return best ? net(best.interface) : null;
}

/* a pasted line's fields, apart by runs of blanks */
function fields(code) {
	if (!str(code) || Buffer.byteLength(code) > MAX_CODE) return [];
	return code.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').split(/[ \t\r\n]+/);
}

/* "vantage-router 1 ssh-ed25519 <base64> <router-name>" -> { key, name } | null */
function parseRouterCode(code) {
	const f = fields(code);
	if (f.length !== 5 || f[0] !== 'vantage-router' || f[1] !== '1' || f[2] !== 'ssh-ed25519' || !key(f[3]) || !name(f[4])) return null;
	return { key: f[3], name: f[4] };
}

/* "vantage-ap 1 ssh-ed25519 <base64> <address> <ssh port> <lan mac> <ap-name>"
   -> { key, addr, port, mac, name } | null */
function parseApReply(code) {
	const f = fields(code);
	if (f.length !== 8 || f[0] !== 'vantage-ap' || f[1] !== '1' || f[2] !== 'ssh-ed25519' || !key(f[3]) ||
		!addr(f[4]) || !port(f[5]) || !mac(f[6]) || !name(f[7])) return null;
	return { key: f[3], addr: addr(f[4]), port: port(f[5]), mac: mac(f[6]), name: f[7] };
}

/* a made-up but well-formed key: the header and 32 bytes from a label */
function fakeKey(label) {
	return Buffer.concat([ HEADER, crypto.createHash('sha256').update('vantage-replay ' + label).digest() ]).toString('base64');
}

function fakeId(label) {
	return crypto.createHash('sha256').update('vantage-replay id ' + label).digest('hex').slice(0, 16);
}

/* the replay's pairing state, one per store */
const states = new WeakMap();

function hostOf(store) {
	const board = store && typeof store.data === 'function' ? store.data('system', 'board', {}) : null;
	return board && typeof board.hostname === 'string' ? board.hostname : '';
}

/* this device's networks, as ubus network.interface dump lists them: its
   lan, at the address it gives a router as an access point */
const LAN_ADDR = '192.0.2.1';
const IFACES = [ { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [ { address: LAN_ADDR, mask: 24 } ] } ];

/* an entry of the paired list: with the name of the network its address
   is on, when it is on one */
function entry(e) {
	const n = netOf(e.addr, IFACES);
	return n ? Object.assign(e, { net: n }) : e;
}

/* the access points of aps.js (the --aps report), as paired: required
   here, not at the top, so either file may load the other */
function seeded() {
	const { APS } = require('./aps');
	return APS.map(a => ({ id: fakeId(a.name), name: name(a.name), addr: addr(a.addr), port: 22, mac: mac(a.mac), key: fakeKey('host ' + a.name) }))
		.filter(a => a.name && a.addr && a.mac).map(entry);
}

function initialState(host, ssh, noDbclient) {
	return {
		host,
		/* this device as an access point: its lan address and MAC, dropbear's port */
		addr: LAN_ADDR,
		port: 22,
		mac: '00:00:5e:00:53:01',
		hostKey: fakeKey('host ' + host),
		ssh: SSH_STATES.includes(ssh) ? ssh : 'ok',
		/* keys on authorized_keys lines of the administrator's own */
		adminKeys: [],
		/* this device as a router: a key exists, since access points are
		   paired; without dbclient the plugin gives no code */
		dbclient: !noDbclient,
		routerKey: fakeKey('router ' + host),
		aps: seeded(),
		routers: [ { name: 'gw-office', key: fakeKey('router gw-office') } ]
	};
}

function stateOf(store) {
	let s = states.get(store);
	if (!s) {
		s = initialState(hostOf(store), process.env.VANTAGE_REPLAY_PAIR_SSH, process.env.VANTAGE_REPLAY_PAIR_NO_DBCLIENT === '1');
		states.set(store, s);
	}
	return s;
}

function routerCode(s) { return s.dbclient && s.routerKey ? `vantage-router 1 ssh-ed25519 ${s.routerKey} ${nameOf(s.host, 'router')}` : null; }
function apReply(s) { return `vantage-ap 1 ssh-ed25519 ${s.hostKey} ${s.addr} ${s.port} ${s.mac} ${nameOf(s.host, 'access-point')}`; }

/* the key file unread: the plugin lists no router then, and says so */
function unread(s) { return s.ssh === 'keys-unreadable'; }

function status(s) {
	const routers = unread(s) ? [] : s.routers.map(r => ({ name: r.name, key: r.key }));
	return {
		router: { code: routerCode(s), aps: s.aps.map(a => Object.assign({ id: a.id, name: a.name, addr: a.addr, port: a.port }, a.net ? { net: a.net } : {})), unread: false },
		ap: { ssh: s.ssh, routers, unread: unread(s), reply: s.ssh === 'ok' && routers.length ? apReply(s) : null }
	};
}

/* an empty addr is no addr */
function addAp(s, args) {
	const ap = parseApReply(args.code);
	if (!ap || (args.addr != null && args.addr !== '' && !addr(args.addr))) return { error: 'invalid' };
	/* this device's own reply */
	if (ap.key === s.hostKey) return { error: 'self' };
	if (!s.routerKey) return { error: 'no-key' };
	if (s.aps.some(a => a.key === ap.key)) return { error: 'duplicate' };
	if (s.aps.length >= MAX_APS) return { error: 'full' };
	let id;
	do id = crypto.randomBytes(8).toString('hex'); while (s.aps.some(a => a.id === id));
	s.aps.push(entry({ id, name: ap.name, addr: addr(args.addr) || ap.addr, port: ap.port, mac: ap.mac, key: ap.key }));
	return { id };
}

function removeAp(s, args) {
	const i = s.aps.findIndex(a => a.id === args.id);
	if (i < 0) return { error: 'unknown' };
	s.aps.splice(i, 1);
	return { ok: true };
}

/* validates the line, checks dropbear, adds the key: a router already
   allowed gets the reply again; a key on one of the administrator's own
   lines is not the plugin's to restrict */
function allowRouter(s, args) {
	const r = parseRouterCode(args.code);
	if (!r) return { error: 'invalid' };
	if (s.ssh !== 'ok') return { error: s.ssh };
	if (s.routers.some(x => x.key === r.key)) return { reply: apReply(s) };
	if (s.adminKeys.includes(r.key)) return { error: 'duplicate' };
	if (s.routers.length >= MAX_ROUTERS) return { error: 'full' };
	s.routers.push({ name: r.name, key: r.key });
	return { reply: apReply(s) };
}

function revokeRouter(s, args) {
	const k = key(args.key);
	if (unread(s)) return { error: 'failed' };
	const n = s.routers.length;
	s.routers = s.routers.filter(r => !k || r.key !== k);
	return s.routers.length < n ? { ok: true } : { error: 'unknown' };
}

/* rpcd's argument check: every argument must be in the policy with the
   declared type (absent ones are fine); the required ones are checked by
   each method (rpcd's ucode bridge does not require any) */
function argsOk(method, args) {
	const pol = POLICY[method];
	for (const [ k, v ] of Object.entries(args || {})) {
		if (k === 'ubus_rpc_session') continue;
		if (!Object.prototype.hasOwnProperty.call(pol, k)) return false;
		const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
		if (t !== pol[k]) return false;
	}
	return true;
}

/* one call on the state s -> the reply body (handle() without a store) */
function handle(s, method, args) {
	args = (args && typeof args === 'object') ? args : {};
	if (!Object.prototype.hasOwnProperty.call(POLICY, method)) return { result: [ METHOD_NOT_FOUND ] };
	if (!argsOk(method, args)) return { result: [ INVALID_ARGUMENT ] };
	switch (method) {
	case 'status': return { result: [ 0, status(s) ] };
	case 'router_code':
		if (!s.dbclient) return { result: [ 0, { error: 'no-dbclient' } ] };
		if (!s.routerKey) s.routerKey = fakeKey('router ' + s.host);
		return { result: [ 0, { code: routerCode(s) } ] };
	case 'add_ap': return { result: [ 0, addAp(s, args) ] };
	case 'remove_ap': return { result: [ 0, removeAp(s, args) ] };
	case 'allow_router': return { result: [ 0, allowRouter(s, args) ] };
	case 'revoke_router': return { result: [ 0, revokeRouter(s, args) ] };
	}
	return { result: [ METHOD_NOT_FOUND ] };
}

function call(store, method, args) {
	return handle(stateOf(store), method, args);
}

module.exports = { OBJECT, POLICY, MAX_APS, MAX_ROUTERS, MAX_CODE, SSH_STATES, IFACES, key, name, nameOf, addr, mac, net, netOf, port, parseRouterCode, parseApReply,
	fakeKey, fakeId, seeded, initialState, argsOk, handle, call };
