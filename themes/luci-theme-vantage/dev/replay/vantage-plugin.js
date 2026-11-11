'use strict';
/* Replay stand-in for luci-app-vantage's rpcd ucode plugin
   (luci-app-vantage/root/usr/share/rpcd/ucode/luci.vantage), which the
   replay cannot run: there is no rpcd here.

   Same object, methods, argument typing and replies:
     luci.vantage wireless   network.wireless status (from the recording),
                             reduced to the fields the dashboard reads;
                             without that object, the same fields from
                             uci wireless
     luci.vantage thermal    the thermal zones of the --fixtures file
                             system (root/sys/class/thermal), read as the
                             plugin reads sysfs; none without one
     luci.vantage wired      the hosts of a bridge forwarding database
                             dump shaped as rtnl's: synthetic.js invents
                             one, wired.js replaces the reply in --wired
     luci.vantage routes     the route lookups' answers, shaped as rtnl's:
                             kernelLookup() makes them from the interface
                             dump the dashboard gets (server.js passes it,
                             after --wired, --multiwan and --fullvpn
                             rewrote it)
     luci.vantage set_alias  { mac, name, icon } -> uci vantage in the
                             store's overlay, committed at once
   tests/plugin.test.js checks this file, the real plugin (when a host
   ucode binary is available) and names.js against the same cases, so the
   three stay in step.

   store.js loads every dev/replay/*-plugin.js and routes calls on OBJECT
   to call(store, method, args); POLICY feeds `ubus list`.
*/

const OBJECT = 'luci.vantage';
const CONFIG = 'vantage';
const NAME_MAX = 48;
const NAME_MAX_UNITS = NAME_MAX * 8;
const MAX_ALIASES = 512;
const ICONS = [ 'phone', 'laptop', 'tablet', 'desktop', 'tv', 'speaker', 'printer', 'camera', 'console', 'watch', 'iot', 'router', 'device' ];
const THERMAL = '/sys/class/thermal';
const MAX_ZONES = 16;
const MAX_HOSTS = 512;
const MAX_PER_PORT = 128;
/* the kernel's numbers, as rtnl.const */
const NUD_NOARP = 0x40, NUD_PERMANENT = 0x80, NTF_SELF = 0x02;
const AF_INET = 2, AF_INET6 = 10, RT_TABLE_MAIN = 254, RTN_UNICAST = 1;

/* rpcd ubus status codes */
const INVALID_ARGUMENT = 2;
const METHOD_NOT_FOUND = 3;

/* argument policy of each method (rpcd rejects unknown names and wrong types) */
const POLICY = {
	wireless: {},
	thermal: {},
	wired: {},
	routes: {},
	set_alias: { mac: 'string', name: 'string', icon: 'string' },
	set_quiet: { mac: 'string', quiet: 'boolean' }
};

function normMac(v) {
	if (typeof v !== 'string') return null;
	let h = v.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').toLowerCase();
	if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(h)) return h;
	if (/^[0-9a-f]{2}(-[0-9a-f]{2}){5}$/.test(h)) return h.replace(/-/g, ':');
	if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(h) || /^[0-9a-f]{12}$/.test(h)) {
		h = h.replace(/\./g, '');
		return h.match(/../g).join(':');
	}
	return null;
}

function isMulticast(mac) { return (parseInt(mac.slice(0, 2), 16) & 1) === 1; }

function forbidden(cp) {
	return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) ||
		cp === 0xad || cp === 0x34f || cp === 0x61c || cp === 0x115f || cp === 0x1160 ||
		cp === 0x17b4 || cp === 0x17b5 || cp === 0x180e || cp === 0x200b || cp === 0x200e || cp === 0x200f ||
		(cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x206f) || cp === 0x3164 ||
		(cp >= 0xfe00 && cp <= 0xfe0d) || cp === 0xfeff || cp === 0xffa0 || (cp >= 0xfff9 && cp <= 0xfffb) ||
		(cp >= 0xe0000 && cp <= 0xe007f) ||
		(cp >= 0xd800 && cp <= 0xdfff);   /* a lone surrogate (not UTF-8 encodable) */
}

function isSpace(cp) {
	return cp === 0x20 || cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) ||
		cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/* -> { ok: true, value } | { ok: false, error } */
function validateName(name) {
	if (name == null) name = '';
	if (typeof name !== 'string') return { ok: false, error: 'invalid-name' };
	const cps = Array.from(name);
	if (name.length > NAME_MAX_UNITS) return { ok: false, error: 'name-too-long' };
	if (cps.some(c => forbidden(c.codePointAt(0)))) return { ok: false, error: 'invalid-name' };
	let out = '', count = 0, pending = false;
	for (const c of cps) {
		if (isSpace(c.codePointAt(0))) { pending = true; continue; }
		if (pending && count) { out += ' '; count++; }
		pending = false;
		out += c;
		count++;
	}
	if (count > NAME_MAX) return { ok: false, error: 'name-too-long' };
	return { ok: true, value: out };
}

function scalar(v) { return [ 'string', 'number', 'boolean' ].includes(typeof v) ? v : null; }
function shortString(v, max) { return (typeof v === 'string' && Buffer.byteLength(v) <= max) ? v : null; }
function obj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }

/* the encryption mode's leading run of mode characters, nothing after it */
function encryption(v) { const m = typeof v === 'string' ? /^[A-Za-z0-9+_-]{1,40}/.exec(v) : null; return m ? m[0] : null; }

function reduceIface(i) {
	const c = obj(i.config);
	const networks = (Array.isArray(c.network) ? c.network : [ c.network ]).filter(n => typeof n === 'string' && Buffer.byteLength(n) <= 64);
	return {
		ifname: shortString(i.ifname, 64),
		section: shortString(i.section, 64),
		config: {
			ssid: shortString(c.ssid, 128),
			mode: shortString(c.mode, 32),
			hidden: scalar(c.hidden),
			encryption: encryption(c.encryption),
			ieee80211w: scalar(c.ieee80211w),
			ieee80211r: scalar(c.ieee80211r),
			ieee80211k: scalar(c.ieee80211k),
			ieee80211v: scalar(c.ieee80211v),
			network: networks,
			macaddr: normMac(c.macaddr)
		}
	};
}

function reduceRadio(r) {
	const c = obj(r.config);
	return {
		up: r.up === true,
		pending: r.pending === true,
		disabled: r.disabled === true,
		config: {
			band: shortString(c.band, 16),
			channel: scalar(c.channel),
			htmode: shortString(c.htmode, 16),
			country: shortString(c.country, 8),
			txpower: scalar(c.txpower),
			disabled: scalar(c.disabled)
		},
		interfaces: (Array.isArray(r.interfaces) ? r.interfaces : []).filter(i => i && typeof i === 'object' && !Array.isArray(i)).map(reduceIface)
	};
}

/* network.wireless status -> reply of luci.vantage wireless */
function reduceWireless(status) {
	const out = {};
	for (const [ name, r ] of Object.entries(obj(status)))
		if (r && typeof r === 'object' && !Array.isArray(r) && /^[A-Za-z0-9_.-]{1,64}$/.test(name)) out[name] = reduceRadio(r);
	return out;
}

/* a boolean option that is on, read as the init scripts read it
   (config_get_bool; netifd takes '1' and 'true'), as the plugin's uci_true() */
function uciTrue(v) {
	return [ '1', 'on', 'true', 'yes', 'enabled' ].includes(v);
}

/* The same reply from uci wireless sections ([ { '.name', '.type', ... } ]
   in config order; null without the config), as the plugin's
   wireless_from_config(): enabled interfaces that name their ifname, the
   first section per name, no run state, no txpower */
function wirelessFromConfig(sections) {
	const radios = new Map(), taken = new Set(), out = {};
	const list = Array.isArray(sections) ? sections.filter(s => s && typeof s === 'object') : [];
	for (const s of list)
		if (s['.type'] === 'wifi-device' && /^[A-Za-z0-9_.-]{1,64}$/.test(s['.name']))
			radios.set(s['.name'], { disabled: uciTrue(s.disabled), config: Object.assign({}, s, { txpower: null }), interfaces: [] });
	for (const s of list) {
		if (s['.type'] !== 'wifi-iface') continue;
		const r = typeof s.device === 'string' ? radios.get(s.device) : null, ifname = s.ifname;
		if (!r || uciTrue(s.disabled) || typeof ifname !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(ifname) || taken.has(ifname)) continue;
		taken.add(ifname);
		r.interfaces.push({ ifname, section: s['.name'],
			config: Object.assign({}, s, { network: typeof s.network === 'string' ? s.network.split(/\s+/).filter(n => n !== '') : s.network }) });
	}
	for (const [ name, r ] of radios) out[name] = Object.assign(reduceRadio(r), { source: 'config' });
	return out;
}

/* reply of luci.vantage wireless: network.wireless status, or, when that
   object is missing (status null), the wireless config */
/* netifd's status, unless it is missing or skipped every radio (no
   handler for the vendor's driver type): then the config */
function wirelessReply(status, sections) {
	return (status && typeof status === 'object' && !Array.isArray(status) && Object.keys(status).length) ? reduceWireless(status) : wirelessFromConfig(sections);
}

/* uci sections of one config from the store, in config order; null when
   the config is missing */
function storeSections(store, config) {
	const r = store.uci('get', { config });
	if (!(r && Array.isArray(r.result) && r.result[0] === 0)) return null;
	return Object.values(r.result[1].values || {}).sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));
}

/* The uci work of set_alias against a minimal cursor:
     { sections(): [ { '.name', '.type', ... } ], add(type) -> sid,
       set(sid, opt, value), del(sid, opt?), commit() -> bool,
       revert()? } */
function setAlias(uci, args) {
	const mac = normMac(args.mac);
	if (!mac || isMulticast(mac)) return { ok: false, error: 'invalid-mac' };
	const v = validateName(args.name);
	if (!v.ok) return v;
	const icon = args.icon ?? '';
	if (icon !== '' && !ICONS.includes(icon)) return { ok: false, error: 'invalid-icon' };

	const clients = uci.sections().filter(s => s['.type'] === 'client');
	const mine = clients.filter(s => normMac(s.mac) === mac).map(s => s['.name']);
	let op;
	if (v.value === '') {
		if (!mine.length) return { ok: true, op: 'none', mac };
		mine.forEach(sid => uci.del(sid));
		op = 'delete';
	}
	else if (mine.length) {
		uci.set(mine[0], 'mac', mac);
		uci.set(mine[0], 'name', v.value);
		if (icon !== '') uci.set(mine[0], 'icon', icon);
		else uci.del(mine[0], 'icon');
		mine.slice(1).forEach(sid => uci.del(sid));
		op = 'set';
	}
	else {
		if (clients.length >= MAX_ALIASES) return { ok: false, error: 'too-many' };
		const sid = uci.add('client');
		if (!sid) return { ok: false, error: 'failed' };
		uci.set(sid, 'mac', mac);
		uci.set(sid, 'name', v.value);
		if (icon !== '') uci.set(sid, 'icon', icon);
		op = 'add';
	}
	if (!uci.commit()) {
		/* a failed commit leaves the change pending: drop it */
		if (uci.revert) uci.revert();
		return { ok: false, error: 'failed' };
	}
	return { ok: true, op, mac };
}

/* set_quiet's uci work (#110): a quiet section per muted MAC, at most
   MAX_QUIET, against the same minimal cursor as setAlias */
const MAX_QUIET = 512;
function setQuiet(uci, args) {
	const mac = normMac(args.mac);
	if (!mac || isMulticast(mac)) return { ok: false, error: 'invalid-mac' };
	if (typeof args.quiet !== 'boolean') return { ok: false, error: 'invalid-value' };
	const quiet = uci.sections().filter(s => s['.type'] === 'quiet');
	const mine = quiet.filter(s => normMac(s.mac) === mac).map(s => s['.name']);
	let op;
	if (args.quiet) {
		if (mine.length) return { ok: true, op: 'none', mac };
		if (quiet.length >= MAX_QUIET) return { ok: false, error: 'too-many' };
		const sid = uci.add('quiet');
		if (!sid) return { ok: false, error: 'failed' };
		uci.set(sid, 'mac', mac);
		op = 'add';
	}
	else {
		if (!mine.length) return { ok: true, op: 'none', mac };
		mine.forEach(sid => uci.del(sid));
		op = 'delete';
	}
	if (!uci.commit()) {
		if (uci.revert) uci.revert();
		return { ok: false, error: 'failed' };
	}
	return { ok: true, op, mac };
}

/* rpcd's argument check: every argument must be in the policy with the
   declared type (absent ones are fine) */
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

/* thermal: [ { zone, type, temp } ] from a fixtures.js Fixtures (or
   nothing), as the plugin's thermal(): readfile with the same limits */
function thermal(fixtures) {
	const text = (p, limit) => { const b = fixtures.read(p); return b ? b.subarray(0, limit).toString('utf8') : ''; };
	const zones = ((fixtures && fixtures.list(THERMAL)) || []).map(e => e.name).filter(n => /^thermal_zone[0-9]{1,3}$/.test(n));
	const out = [];
	for (const n of zones.sort((a, b) => a.slice(12) - b.slice(12))) {
		if (out.length >= MAX_ZONES) break;
		const temp = text(THERMAL + '/' + n + '/temp', 16).trim();
		if (!/^-?[0-9]{1,7}$/.test(temp)) continue;
		const kind = text(THERMAL + '/' + n + '/type', 64).trim();
		out.push({ zone: n, type: /^[A-Za-z0-9_.-]{1,40}$/.test(kind) ? kind : '', temp: parseInt(temp, 10) });
	}
	return out;
}

/* wired: [ { mac, port, bridge, vlan, seen } ] from an rtnl-shaped dump
   of the bridge forwarding database (or nothing), as the plugin's wired():
   at most MAX_PER_PORT a port. The replay has no crowded bridge. */
function wired(fdb) {
	const out = [], per = Object.create(null);
	const netdev = v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,15}$/.test(v);
	for (const n of Array.isArray(fdb) ? fdb : []) {
		if (out.length >= MAX_HOSTS) break;
		const mac = (n && typeof n === 'object' && !Array.isArray(n)) ? normMac(n.lladdr) : null;
		if (!mac || isMulticast(mac) || !Number.isInteger(n.state) || (n.state & NUD_PERMANENT) ||
		    (Number.isInteger(n.flags) && (n.flags & NTF_SELF)) || !netdev(n.master) || !netdev(n.dev) ||
		    (per[n.dev] || 0) >= MAX_PER_PORT) continue;
		per[n.dev] = (per[n.dev] || 0) + 1;
		const upd = n.cacheinfo && n.cacheinfo.updated;
		out.push({
			mac, port: n.dev, bridge: n.master,
			vlan: Number.isInteger(n.vlan) && n.vlan > 0 && n.vlan < 4095 ? n.vlan : null,
			seen: !(n.state & NUD_NOARP) && Number.isInteger(upd) && upd >= 0 ? Math.floor(upd / 100) : null
		});
	}
	return out;
}

/* routes: [ { family, dev, metric } ] from the two lookups' answers as
   rtnl gives them, { 2: IPv4's, 10: IPv6's } (a route, false for the
   kernel's error, which for a lookup is no route, null when not sent), as
   the plugin's routes(): a unicast default route in the main table (no
   dst) is kept, IPv4 then IPv6, dev null over several next hops; null
   when a lookup was not sent */
function routes(answers) {
	const out = [];
	const netdev = v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,15}$/.test(v) ? v : null;
	for (const fam of [ AF_INET, AF_INET6 ]) {
		const r = answers && typeof answers === 'object' ? answers[fam] : null;
		if (r === null || r === undefined) return null;
		if (typeof r !== 'object' || Array.isArray(r) || r.family !== fam || r.dst != null || r.table !== RT_TABLE_MAIN || r.type !== RTN_UNICAST) continue;
		const m = r.priority ?? 0;
		out.push({ family: fam === AF_INET ? 4 : 6, dev: netdev(r.oif), metric: Number.isInteger(m) && m >= 0 ? m : 0 });
	}
	return out;
}

/* The replay's kernel: the lookups' answers (for routes()) from netifd's
   routes as the kernel keeps them. netifd adds a route replacing one of
   the same family and metric, so of a tunnel's and its line's the
   tunnel's is kept, added later (a tunnel waits for a route to its
   endpoint); a lookup answers with the lowest metric left, or false
   when the family has none. Invented here; the device answers from its
   own table. */
const TUNNEL_PROTO = /^(wireguard|openvpn|gre|vti|xfrm|ipip|6in4)$/;
function kernelLookup(ifaces) {
	const best = { [AF_INET]: null, [AF_INET6]: null };
	for (const i of Array.isArray(ifaces) ? ifaces : []) {
		if (!i || !i.up) continue;
		for (const r of Array.isArray(i.route) ? i.route : []) {
			if (!r || +r.mask !== 0 || (r.target !== '0.0.0.0' && r.target !== '::')) continue;
			const v6 = r.target === '::', fam = v6 ? AF_INET6 : AF_INET;
			const t = r.table != null ? r.table : i[v6 ? 'ip6table' : 'ip4table'];
			if (!(t == null || t === '' || t === 'main' || +t === 254)) continue;
			let m = r.metric != null ? +r.metric : +i.metric;
			m = isFinite(m) ? m : 0;
			if (v6 && m === 0) m = 1024;
			const tun = TUNNEL_PROTO.test(i.proto || ''), b = best[fam];
			if (!b || m < b.priority || (m === b.priority && tun && !b.tun))
				best[fam] = { tun, family: fam, table: RT_TABLE_MAIN, type: RTN_UNICAST, oif: i.l3_device || i.device, priority: m };
		}
	}
	const answer = b => b ? { family: b.family, table: b.table, type: b.type, oif: b.oif, priority: b.priority } : false;
	return { [AF_INET]: answer(best[AF_INET]), [AF_INET6]: answer(best[AF_INET6]) };
}

/* a uci cursor on the replay store's overlay for one config */
function storeCursor(store) {
	const u = (method, a) => store.uci(method, Object.assign({ config: CONFIG }, a));
	const ok = r => r && Array.isArray(r.result) && r.result[0] === 0;
	return {
		sections: () => {
			const r = u('get', {});
			return ok(r) ? Object.values(r.result[1].values || {}) : [];
		},
		add: type => { const r = u('add', { type }); return ok(r) ? r.result[1].section : null; },
		set: (sid, opt, value) => u('set', { section: sid, values: { [opt]: value } }),
		del: (sid, opt) => u('delete', opt == null ? { section: sid } : { section: sid, option: opt }),
		commit: () => ok(u('commit', {}))
	};
}

/* JSON-RPC reply body for one call on luci.vantage */
function call(store, method, args) {
	args = (args && typeof args === 'object') ? args : {};
	if (!Object.prototype.hasOwnProperty.call(POLICY, method)) return { result: [ METHOD_NOT_FOUND ] };
	if (!argsOk(method, args)) return { result: [ INVALID_ARGUMENT ] };
	if (method === 'wireless') {
		const status = store.data('network.wireless', 'status', {});
		const empty = status && typeof status === 'object' && !Object.keys(status).length;
		return { result: [ 0, wirelessReply(status, status == null || empty ? storeSections(store, 'wireless') : null) ] };
	}
	if (method === 'thermal') return { result: [ 0, { zones: thermal(store.fixtures) } ] };
	if (method === 'wired') return { result: [ 0, { hosts: wired(store.synthetic && store.synthetic.fdb ? store.synthetic.fdb() : null) } ] };
	if (method === 'routes') {
		const dump = typeof store.ifaceDump === 'function' ? store.ifaceDump() : ((store.data('network.interface', 'dump', {}) || {}).interface || null);
		return { result: [ 0, { routes: routes(kernelLookup(dump)) } ] };
	}
	if (store.uciSeed) store.uciSeed(CONFIG, { main: { '.anonymous': false, '.type': 'vantage', '.name': 'main' } });
	return { result: [ 0, (method === 'set_quiet' ? setQuiet : setAlias)(storeCursor(store), args) ] };
}

module.exports = { OBJECT, POLICY, MAX_ALIASES, MAX_QUIET, NAME_MAX, ICONS, normMac, validateName, reduceWireless, wirelessFromConfig, wirelessReply, thermal, wired, routes, kernelLookup, setAlias, setQuiet, argsOk, call };
