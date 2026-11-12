'use strict';
const mkTmp = require('./tmpdir');
/* luci-app-vantage's rpcd ucode plugin (root/usr/share/rpcd/ucode/luci.vantage)
   and its replay stand-in (dev/replay/vantage-plugin.js).

   The same cases run through
     - names.js (the view's own checks: validateAlias, normMac),
     - the replay stand-in, always,
     - the real plugin under a host ucode binary, when one is found
       ($UCODE, else `ucode` on PATH; skipped otherwise), with uci and ubus
       replaced by the doubles in tests/ucode/stubs and rpcd's argument
       check emulated by tests/ucode/harness.uc.
   The ucode and JavaScript results must be identical, so the device, the
   replay and the view agree on what a valid name is. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { load } = require('./luci-stub');
const shim = require('../dev/replay/vantage-plugin');

const names = load('vantage.names');
const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'luci-app-vantage/root/usr/share/rpcd/ucode/luci.vantage');

/* ------------------------------------------------------------- ucode */

function findUcode() {
	const cands = [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')));
	for (const c of cands) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const NO_UCODE = UCODE ? false : 'no ucode binary (set UCODE=/path/to/ucode, e.g. an OpenWrt build\'s staging_dir/hostpkg/bin/ucode)';

/* a fake /sys/class/net: br-lan and br-guest with forwarding records
   in brforward (16 bytes each; `entries` is br-lan's count, or both as
   [ lan, guest ]), eth0 without one */
const BRIDGES = [ 'br-lan', 'br-guest' ];
function fakeNet(dir, entries) {
	const net = path.join(dir, 'net'), n = [].concat(entries, 0);
	fs.mkdirSync(path.join(net, 'eth0'), { recursive: true });
	BRIDGES.forEach((b, i) => {
		fs.mkdirSync(path.join(net, b));
		fs.writeFileSync(path.join(net, b, 'brforward'), Buffer.alloc(16 * n[i]));
	});
	return net;
}

/* run cases through a plugin (the real one unless given its source),
   reading its bridges from a fake /sys/class/net with `entries` (default
   3) records on br-lan, and /etc/board.json from `board` (an object, or
   text as it is; none when left out): the harness's spawnSync result */
function spawnUcode(cases, source, entries, board) {
	const dir = mkTmp('vantage-plugin-');
	const file = path.join(dir, 'cases.json');
	const plugin = path.join(dir, 'luci.vantage');
	const boardFile = path.join(dir, 'board.json');
	try {
		const src = source == null ? fs.readFileSync(PLUGIN, 'utf8') : source;
		fs.writeFileSync(file, JSON.stringify(cases));
		if (board != null) fs.writeFileSync(boardFile, typeof board === 'string' ? board : JSON.stringify(board));
		const net = fakeNet(dir, entries == null ? 3 : entries);
		fs.writeFileSync(plugin, src.replace(/^const NET = .*$/m, () => 'const NET = ' + JSON.stringify(net) + ';')
			.replace(/^const BOARD = .*$/m, () => 'const BOARD = ' + JSON.stringify(boardFile) + ';'));
		const args = [ '-L', path.join(__dirname, 'ucode/stubs') ];
		const lib = path.join(path.dirname(UCODE), '../lib/ucode');
		if (fs.existsSync(lib)) args.push('-L', lib);
		args.push('-D', 'PLUGIN=' + plugin, '-D', 'CASES=' + file, '-D', 'NET=' + net, path.join(__dirname, 'ucode/harness.uc'));
		return spawnSync(UCODE, args, { encoding: 'utf8' });
	} finally {
		for (const f of [ file, plugin, boardFile ].concat(BRIDGES.map(b => path.join(dir, 'net', b, 'brforward')))) if (fs.existsSync(f)) fs.unlinkSync(f);
		for (const d of BRIDGES.map(b => 'net/' + b).concat([ 'net/eth0', 'net', '' ])) if (fs.existsSync(path.join(dir, d))) fs.rmdirSync(path.join(dir, d));
	}
}

/* the bridges' sysfs brforward as the kernel would hold it beside an
   rtnl-shaped dump: a 16-byte record (MAC, port number, is_local, ageing
   in 1/100 s, the port number's high byte) for each entry a bridge
   learned or owns, the switches' copies (self) left out. opts.age: every
   record's ageing instead of the dump's; opts.be: written big-endian, as
   on a big-endian router. { bridge: base64 } for the harness */
const PORT_NO = { lan1: 1, lan2: 2, 'phy2g-ap0': 3, eth0: 4 };
function brforward(list, opts) {
	const o = opts || {}, out = {};
	for (const b of BRIDGES) {
		const recs = (Array.isArray(list) ? list : []).filter(n => n && typeof n === 'object' && !Array.isArray(n) && n.master === b &&
			typeof n.lladdr === 'string' && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(n.lladdr) && !(n.flags & 0x02));
		const buf = Buffer.alloc(16 * recs.length);
		recs.forEach((n, i) => {
			n.lladdr.split(':').forEach((x, j) => buf[16 * i + j] = parseInt(x, 16));
			buf[16 * i + 6] = PORT_NO[n.dev] || 9;
			buf[16 * i + 7] = (n.state & 0x80) ? 1 : 0;
			const u = n.cacheinfo && n.cacheinfo.updated;
			const age = o.age != null ? o.age : (Number.isInteger(u) && u >= 0 ? u : 0);
			if (o.be) buf.writeUInt32BE(age, 16 * i + 8); else buf.writeUInt32LE(age, 16 * i + 8);
		});
		out[b] = buf.toString('base64');
	}
	return out;
}

/* run cases through the real plugin: [ { status, reply, sections } ];
   a wired case's bridges hold what its dump has */
function runUcode(cases) {
	const r = spawnUcode(cases.map(c => c.method === 'wired' && (Array.isArray(c.fdb) || c.fdb === null) && !c.brforward ? Object.assign({ brforward: brforward(c.fdb) }, c) : c));
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

/* the same cases through the stand-in, with a cursor that behaves like
   the ucode test double (section ids cfg000001, cfg000002, ...) */
function runShim(cases) {
	return cases.map(c => {
		const orig = JSON.parse(JSON.stringify(c.sections || []));
		let sections = JSON.parse(JSON.stringify(orig)), seq = 0, committed = false, reverted = false;
		const find = sid => sections.find(s => s['.name'] === sid);
		const cursor = {
			sections: () => sections.map(s => Object.assign({}, s)),
			add: type => { const sid = 'cfg' + (++seq).toString(16).padStart(6, '0'); sections.push({ '.name': sid, '.type': type, '.anonymous': true }); return sid; },
			set: (sid, opt, v) => { const s = find(sid); if (s) s[opt] = v; },
			del: (sid, opt) => { if (opt != null) { const s = find(sid); if (s) delete s[opt]; } else sections = sections.filter(s => s['.name'] !== sid); },
			commit: () => { if (c.fail_commit) return false; committed = true; return true; },
			revert: () => { reverted = true; }
		};
		if (!Object.prototype.hasOwnProperty.call(shim.POLICY, c.method)) return { status: 3, reply: null, sections: orig, reverted };
		if (!shim.argsOk(c.method, c.args)) return { status: 2, reply: null, sections: orig, reverted };
		const reply = c.method === 'wireless'
			? shim.wirelessReply((c.ubus || {})['network.wireless status'] ?? null, c.wireless_uci ?? null)
			: c.method === 'wired' ? { hosts: shim.wired(c.fdb ?? null) }
			: c.method === 'routes' ? { routes: shim.routes(c.lookup ?? null) }
			: c.method === 'set_quiet' ? shim.setQuiet(cursor, c.args || {})
			: shim.setAlias(cursor, c.args || {});
		return { status: 0, reply, sections: committed ? sections : orig, reverted };
	});
}

/* ucode prints null object members; JSON.stringify keeps them too, but
   ucode has no undefined: normalise both through JSON */
const norm = v => JSON.parse(JSON.stringify(v));

/* -------------------------------------------------------------- cases */

const MAC = '00:00:5e:00:53:21';
const client = (sid, mac, name, icon) => Object.assign({ '.name': sid, '.type': 'client', '.anonymous': true, mac, name }, icon ? { icon } : {});
const quietSec = (sid, mac) => ({ '.name': sid, '.type': 'quiet', '.anonymous': true, mac });

/* names: [ input, ok, value ] as validateAlias sees them */
const NAMES = [
	[ 'TV', true, 'TV' ],
	[ '  Hall   printer ', true, 'Hall printer' ],
	[ 'Hall\u00a0\u2003 printer', true, 'Hall printer' ],
	[ '', true, '' ],
	[ '   ', true, '' ],
	[ 'x'.repeat(48), true, 'x'.repeat(48) ],
	[ 'x'.repeat(49), false ],
	[ '\u{1F4FA}'.repeat(48), true, '\u{1F4FA}'.repeat(48) ],
	[ '\u{1F4FA}'.repeat(49), false ],
	[ ' '.repeat(40) + 'y'.repeat(48) + ' '.repeat(40), true, 'y'.repeat(48) ],
	[ ' '.repeat(300) + 'y' + ' '.repeat(100), false ],
	[ 'Café über 中文', true, 'Café über 中文' ],
	[ '<img src=x onerror=alert(1)>', true, '<img src=x onerror=alert(1)>' ],
	[ '\u{1F468}\u200d\u{1F4BB} desk', true, '\u{1F468}\u200d\u{1F4BB} desk' ],
	[ 'a\tb', false ], [ 'a\nb', false ], [ 'a\rb', false ], [ 'a\u001bb', false ], [ 'a\u007fb', false ],
	[ 'a\u0085b', false ], [ 'a\u009fb', false ], [ 'evil\u202etxt', false ], [ 'a\u200bb', false ],
	[ 'a\u200eb', false ], [ 'a\u2066b', false ], [ 'a\u2028b', false ], [ 'a\ufeffb', false ], [ 'a\u00adb', false ],
	[ 'a\u{E0041}b', false ], [ 'a\ufe00b', false ], [ 'a\u3164b', false ]
];

const MACS = [ '00:00:5E:00:53:21', '00-00-5e-00-53-21', '0000.5e00.5321', '00005E005321', ' 00:00:5e:00:53:21\t',
	'00:00:5e:00:53', '00:00:5e:00:53:21:00', '00:00:5e:00:53:2g', '00:00-5e:00:53:21', '00:00:5e:00:53:21\n; rm', '0:0:5e:0:53:21',
	'01:00:5e:00:53:21', 'ff:ff:ff:ff:ff:ff', '02:00:5E:00:53:0F', '' ];

const SECRETS = { key: 'SECRET-PSK-1', sae_password: 'SECRET-SAE-2', auth_secret: 'SECRET-RADIUS-3', acct_secret: 'SECRET-RADIUS-4',
	r0kh: [ '02:00:5e:00:53:01,nas,SECRET-R0KH-5' ], r1kh: [ '02:00:5e:00:53:01,02:00:5e:00:53:01,SECRET-R1KH-6' ],
	password: 'SECRET-EAP-7', identity: 'SECRET-ID-8', key1: 's:SECRET-WEP-9', priv_key_pwd: 'SECRET-10' };

const WIRELESS = {
	radio0: {
		up: true, pending: false, autostart: true, disabled: false, retry_setup_failed: false,
		config: { disabled: false, type: 'mac80211', channel: '6', band: '2g', htmode: 'EHT20', country: 'US', path: 'platform/soc@0/x', txpower: 20, channels: [ '1', '6' ] },
		interfaces: [
			{ section: 'default_radio0', ifname: 'phy2g-ap0', vlans: [], stations: [],
				config: Object.assign({ network: [ 'lan' ], device: 'radio0', mode: 'ap', ssid: 'Home', encryption: 'sae-mixed+ccmp', ieee80211w: 1, macaddr: '02:00:5E:00:53:A0', hidden: '1', ieee80211r: true }, SECRETS) },
			{ section: 'sta0', ifname: 'phy2g-sta0',
				config: Object.assign({ network: 'wwan', mode: 'sta', ssid: 'Upstream', encryption: 'wpa2+ccmp key=SECRET-11' }, SECRETS) },
			'junk'
		]
	},
	'bad name': { up: true },
	radio1: 'junk'
};

/* uci wireless of firmware without netifd's network.wireless object,
   shaped like GL.iNet's mtkwifi config (MediaTek MT7990, issue #60) */
const dev = (name, band, channel, htmode, extra) => Object.assign({ '.name': name, '.type': 'wifi-device', type: 'mtkwifi', txpower: '100', band, channel, htmode, disabled: '0' }, extra);
const wif = (name, device, ifname, extra) => Object.assign({ '.name': name, '.type': 'wifi-iface', device, ifname, mode: 'ap', network: 'lan', disabled: '0', hidden: '0' }, SECRETS, extra);
const MTK = [
	dev('MT7990_1_1', '2g', '11', 'EHT20'),
	wif('ra0', 'MT7990_1_1', 'ra0', { ssid: 'Home', encryption: 'psk2+ccmp', ieee80211w: '1' }),
	dev('MT7990_1_2', '5g', '48', 'EHT80'),
	wif('rai0', 'MT7990_1_2', 'rai0', { ssid: 'Home', encryption: 'sae-mixed', ieee80211w: '1' }),
	dev('MT7990_1_3', '6g', 'auto', 'EHT160'),
	wif('rax0', 'MT7990_1_3', 'rax0', { ssid: 'Home', encryption: 'sae', ieee80211w: '2' }),
	wif('guest2g', 'MT7990_1_1', 'ra1', { ssid: 'Guest', encryption: 'psk2+ccmp', disabled: '1' }),
	wif('wlanmld2g', 'MT7990_1_1', 'ra2', { ssid: 'Home MLO', encryption: 'sae', mld: 'mld0', network: ' lan  guest ' }),
	wif('bbss5g', 'MT7990_1_2', 'rai4', { ssid: 'Backhaul', disabled: '1' }),
	wif('wlanmldguest5g', 'MT7990_1_2', 'rai4', { ssid: 'Guest MLO', encryption: 'sae' }),
	wif('again5g', 'MT7990_1_2', 'rai4', { ssid: 'Same name' }),
	wif('noname', 'MT7990_1_2', null, { ssid: 'No ifname' }),
	wif('badname', 'MT7990_1_2', 'ra0; reboot', { ssid: 'Bad ifname' }),
	wif('orphan', 'radio9', 'ra9', { ssid: 'No radio' }),
	{ '.name': 'mld0', '.type': 'wifi-mld', ssid: 'Home MLO', key: 'SECRET-MLD-12' },
	wif('bsta5g', 'MT7990_1_2', 'apclii0', { mode: 'sta', disabled: '1' }),
	dev('MT7990_off', '2g', '1', 'EHT20', { disabled: '1' }),
	dev('bad radio', '5g', '36', 'EHT80')
];
/* disabled as the init scripts read it (config_get_bool): a section
   switched off with 'true' or 'yes' claims no ifname, so it cannot stand
   in for the open network that is on air */
const BOOLS = [
	dev('r_on', '5g', '36', 'EHT80', { disabled: 'off' }),
	wif('old', 'r_on', 'rai4', { ssid: 'Old', encryption: 'sae', disabled: 'true' }),
	wif('off', 'r_on', 'rai4', { ssid: 'Off', encryption: 'sae', disabled: 'yes' }),
	wif('gone', 'r_on', 'rai4', { ssid: 'Gone', encryption: 'sae', disabled: 'on' }),
	wif('unused', 'r_on', 'rai4', { ssid: 'Unused', encryption: 'sae', disabled: 'enabled' }),
	wif('open', 'r_on', 'rai4', { ssid: 'Open', encryption: 'none' }),
	wif('kept', 'r_on', 'rai5', { ssid: 'Kept', encryption: 'psk2', disabled: 'no' }),
	wif('upper', 'r_on', 'rai6', { ssid: 'Upper', encryption: 'psk2', disabled: 'TRUE' }),
	dev('r_true', '2g', '1', 'EHT20', { disabled: 'true' }),
	dev('r_yes', '6g', '37', 'EHT160', { disabled: 'yes' }),
	dev('r_no', '2g', '6', 'EHT20', { disabled: 'false' })
];

/* a route lookup's answer as ucode's rtnl gives it (RTM_GETROUTE with
   RTM_F_FIB_MATCH, one a family): the route that matched, no dst on a
   default, priority its metric; false is the kernel's error (no route),
   null a request not sent */
const rt = (family, oif, priority, extra) => Object.assign({ family, tos: 0, protocol: 4, scope: 0, type: 1, flags: 0, table: 254 },
	oif == null ? {} : { oif }, priority == null ? {} : { priority }, extra);
const LOOKUPS = {
	both: { 2: rt(2, 'eth0', null, { gateway: '192.0.2.1' }), 10: rt(10, 'eth0', 1024, { gateway: 'fe80::1' }) },
	tunnel: { 2: rt(2, 'wg0', 0), 10: false },
	def1: { 2: rt(2, 'tun0', 0, { dst: '128.0.0.0/1' }), 10: false },     /* OpenVPN's redirect-gateway def1: not a default */
	ownTable: { 2: rt(2, 'wg1', 0, { table: 100 }), 10: false },
	blackhole: { 2: rt(2, 'lo', 0, { type: 6 }), 10: false },
	multipath: { 2: rt(2, null, 5, { multipath: [ { dev: 'eth0' }, { dev: 'eth9' } ] }), 10: false },
	oddDev: { 2: rt(2, 'bad name!', -3), 10: false },
	notSent: { 2: rt(2, 'eth0', 0), 10: null },
	junk: { 2: 'x', 10: 7 }
};

/* the bridge forwarding database as ucode's rtnl dumps it (RTM_GETNEIGH,
   AF_BRIDGE): learned hosts are kept, everything else is left out */
const fdb = (lladdr, dev, extra) => Object.assign({ family: 7, dev, master: 'br-lan', lladdr, state: 0x02, flags: 0,
	cacheinfo: { confirmed: 0, used: 0, updated: 1234, refcnt: 0 } }, extra);
const FDB = [
	fdb('00:00:5e:00:53:01', 'lan1'),
	fdb('00:00:5e:00:53:02', 'lan2', { vlan: 10, cacheinfo: { updated: 30099 } }),
	fdb('00:00:5e:00:53:03', 'lan2', { state: 0x40 }),                          /* static: never heard */
	fdb('00:00:5E:00:53:04', 'phy2g-ap0', { vlan: 4095, cacheinfo: { updated: -5 } }),
	fdb('00:00:5e:00:53:05', 'eth0', { master: 'br-guest', state: 0x04, cacheinfo: null }),
	fdb('00:00:5e:00:53:10', 'lan1', { state: 0x80 }),                          /* the bridge's own */
	fdb('00:00:5e:00:53:11', 'lan1', { master: null, flags: 0x02 }),           /* the switch's copy */
	fdb('01:00:5e:90:10:01', 'lan1'),                                          /* a group address */
	fdb('00:00:5e:00:53:12', 'lan1; reboot'),
	fdb('00:00:5e:00:53:13', 'lan1', { master: 'br lan' }),
	fdb('00:00:5e:00:53:14', 'a-port-name-too-long'),
	fdb('00:00:5e:00:53:15', 'lan1', { state: true }),
	fdb('not a mac', 'lan1'),
	'junk', null, [ 'lan1' ]
];
const FDB_MANY = Array.from({ length: 600 }, (_, i) => fdb('02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'lan1'));
const FDB_UPLINK = Array.from({ length: 700 }, (_, i) => fdb('02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'eth0'))
	.concat([ fdb('00:00:5e:00:53:31', 'lan1'), fdb('00:00:5e:00:53:32', 'lan2') ]);

const BEHAVIOUR = [
	/* add, one section per MAC, icon handling */
	{ method: 'set_alias', args: { mac: '00-00-5E-00-53-21', name: '  TV  ', icon: 'tv' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', icon: '' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', icon: 'rocket' } },
	{ method: 'set_alias', sections: [ client('cfgold', MAC, 'Old', 'tv') ], args: { mac: MAC, name: 'New', icon: 'phone' } },
	{ method: 'set_alias', sections: [ client('cfgold', MAC, 'Old', 'tv') ], args: { mac: MAC, name: 'New', icon: '' } },
	/* duplicates from before (two tabs, the old raw uci writes): one survives */
	{ method: 'set_alias', sections: [ client('a', MAC, 'One'), client('b', '00-00-5E-00-53-21', 'Two'), client('c', '00:00:5e:00:53:22', 'Other') ], args: { mac: MAC, name: 'Only' } },
	{ method: 'set_alias', sections: [ client('a', MAC, 'One'), client('b', MAC.toUpperCase(), 'Two'), client('c', '00:00:5e:00:53:22', 'Other') ], args: { mac: MAC, name: '' } },
	{ method: 'set_alias', sections: [ client('c', '00:00:5e:00:53:22', 'Other') ], args: { mac: MAC, name: '' } },
	{ method: 'set_alias', args: { mac: MAC } },
	/* refusals */
	{ method: 'set_alias', args: { mac: '01:00:5e:00:53:21', name: 'Group' } },
	{ method: 'set_alias', args: { name: 'No MAC' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'a\u202eb' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'x'.repeat(49) } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV' }, fail_commit: true },
	/* rpcd's argument check */
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', icon: 5 } },
	{ method: 'set_alias', args: { mac: MAC, name: [ 'TV' ] } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', section: 'x' } },
	{ method: 'nope', args: {} },
	/* the cap: a new MAC is refused at 512 client sections, an existing one is updated */
	(() => { const s = []; for (let i = 0; i < 512; i++) s.push(client('s' + i, '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'n' + i)); return { method: 'set_alias', sections: s, args: { mac: MAC, name: 'One too many' } }; })(),
	(() => { const s = []; for (let i = 0; i < 512; i++) s.push(client('s' + i, '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'n' + i)); return { method: 'set_alias', sections: s, args: { mac: '02:00:5e:00:00:07', name: 'Renamed' } }; })(),
	/* wireless */
	{ method: 'wireless', ubus: { 'network.wireless status': WIRELESS } },
	{ method: 'wireless', ubus: {} },
	{ method: 'wireless', args: { device: 'radio0' } },
	/* no network.wireless object: the config stands in; netifd's status
	   wins whenever it answers */
	{ method: 'wireless', ubus: {}, wireless_uci: MTK },
	{ method: 'wireless', ubus: { 'network.wireless status': WIRELESS }, wireless_uci: MTK },
	{ method: 'wireless', ubus: {}, wireless_uci: BOOLS },
	/* wired: the bridges' learned hosts */
	{ method: 'wired', fdb: FDB },
	{ method: 'wired', fdb: null },
	{ method: 'wired', fdb: FDB_MANY },
	{ method: 'wired', args: { port: 'lan1' } },
	/* netifd answers but skipped every radio: the config as well */
	{ method: 'wireless', ubus: { 'network.wireless status': {} }, wireless_uci: MTK },
	/* the uplink's port full of upstream hosts leaves room for the others */
	{ method: 'wired', fdb: FDB_UPLINK },
	/* routes: the route lookups' answers */
	{ method: 'routes', lookup: LOOKUPS.both },
	{ method: 'routes', lookup: LOOKUPS.tunnel },
	{ method: 'routes', lookup: LOOKUPS.def1 },
	{ method: 'routes', lookup: LOOKUPS.ownTable },
	{ method: 'routes', lookup: LOOKUPS.blackhole },
	{ method: 'routes', lookup: LOOKUPS.multipath },
	{ method: 'routes', lookup: LOOKUPS.oddDev },
	{ method: 'routes', lookup: LOOKUPS.notSent },
	{ method: 'routes', lookup: LOOKUPS.junk },
	{ method: 'routes', lookup: LOOKUPS.both, args: { table: 100 } },
	/* set_quiet (#110): one quiet section per muted MAC, beside the names */
	{ method: 'set_quiet', args: { mac: '00-00-5E-00-53-21', quiet: true } },
	{ method: 'set_quiet', sections: [ client('a', MAC, 'TV'), quietSec('q', MAC) ], args: { mac: MAC, quiet: true } },
	{ method: 'set_quiet', sections: [ client('a', MAC, 'TV'), quietSec('q', MAC), quietSec('r', MAC.toUpperCase()), quietSec('s', '00:00:5e:00:53:22') ], args: { mac: MAC, quiet: false } },
	{ method: 'set_quiet', sections: [ client('a', MAC, 'TV') ], args: { mac: MAC, quiet: false } },
	{ method: 'set_quiet', args: { mac: '01:00:5e:00:53:21', quiet: true } },
	{ method: 'set_quiet', args: { quiet: true } },
	{ method: 'set_quiet', args: { mac: MAC } },
	{ method: 'set_quiet', args: { mac: MAC, quiet: true }, fail_commit: true },
	{ method: 'set_quiet', args: { mac: MAC, quiet: 'yes' } },
	{ method: 'set_quiet', args: { mac: MAC, quiet: 1 } },
	{ method: 'set_quiet', args: { mac: MAC, quiet: true, name: 'x' } },
	(() => { const s = []; for (let i = 0; i < 512; i++) s.push(quietSec('q' + i, '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'))); return { method: 'set_quiet', sections: s, args: { mac: MAC, quiet: true } }; })(),
	(() => { const s = []; for (let i = 0; i < 512; i++) s.push(client('s' + i, '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'n' + i)); return { method: 'set_quiet', sections: s, args: { mac: MAC, quiet: true } }; })()
];

const NAME_CASES = NAMES.map(([ n ]) => ({ method: 'set_alias', args: { mac: MAC, name: n } }));
const MAC_CASES = MACS.map(m => ({ method: 'set_alias', args: { mac: m, name: 'x' } }));
const ALL = BEHAVIOUR.concat(NAME_CASES, MAC_CASES);

/* -------------------------------------------------------------- tests */

test('names: the stand-in, names.js and the table agree', () => {
	for (const [ n, ok, value ] of NAMES) {
		const v = names.validateAlias(n), s = shim.validateName(n);
		assert.equal(v.ok, ok, 'names.js ' + JSON.stringify(n));
		assert.equal(s.ok, ok, 'stand-in ' + JSON.stringify(n));
		if (ok) { assert.equal(v.value, value); assert.equal(s.value, value); }
	}
	for (const n of [ 'a\ud800b', '\udc00', '\ud83d' ]) {
		assert.equal(names.validateAlias(n).ok, false);
		assert.equal(shim.validateName(n).ok, false, 'lone surrogate');
	}
});

test('MACs: the stand-in and names.js normalise alike; multicast is refused', () => {
	for (const m of MACS) {
		assert.equal(shim.normMac(m), names.normMac(m), JSON.stringify(m));
		const r = runShim([ { method: 'set_alias', args: { mac: m, name: 'x' } } ])[0].reply;
		const want = names.normMac(m) && !names.isMulticastMac(m) ? names.normMac(m) : null;
		assert.equal(r.ok ? r.mac : null, want, JSON.stringify(m));
	}
});

test('stand-in: set_alias keeps one section per MAC, caps at 512, refuses bad input', () => {
	const r = runShim(BEHAVIOUR);
	assert.deepEqual(r[0].reply, { ok: true, op: 'add', mac: MAC });
	assert.deepEqual(r[0].sections, [ client('cfg000001', MAC, 'TV', 'tv') ]);
	assert.deepEqual(r[3].reply, { ok: false, error: 'invalid-icon' });
	assert.deepEqual(r[4].sections, [ Object.assign(client('cfgold', MAC, 'New', 'phone')) ]);
	assert.deepEqual(r[5].sections, [ client('cfgold', MAC, 'New') ]);
	assert.deepEqual(r[6].reply, { ok: true, op: 'set', mac: MAC });
	assert.deepEqual(r[6].sections.map(s => [ s['.name'], s.mac, s.name ]), [ [ 'a', MAC, 'Only' ], [ 'c', '00:00:5e:00:53:22', 'Other' ] ]);
	assert.deepEqual(r[7].reply, { ok: true, op: 'delete', mac: MAC });
	assert.deepEqual(r[7].sections.map(s => s['.name']), [ 'c' ]);
	assert.deepEqual(r[8].reply, { ok: true, op: 'none', mac: MAC });
	assert.deepEqual(r[9].reply, { ok: true, op: 'none', mac: MAC }, 'no name removes');
	assert.deepEqual(r.slice(10, 14).map(x => x.reply.error), [ 'invalid-mac', 'invalid-mac', 'invalid-name', 'name-too-long' ]);
	assert.deepEqual(r[14].reply, { ok: false, error: 'failed' });
	assert.deepEqual(r[14].sections, [], 'nothing committed');
	assert.equal(r[14].reverted, true, 'a failed commit drops the pending change (SEC-002)');
	assert.equal(r[0].reverted, false);
	assert.deepEqual(r.slice(15, 19).map(x => x.status), [ 2, 2, 2, 3 ]);
	assert.deepEqual(r[19].reply, { ok: false, error: 'too-many' });
	assert.equal(r[19].sections.length, 512);
	assert.deepEqual(r[20].reply, { ok: true, op: 'set', mac: '02:00:5e:00:00:07' });
	assert.equal(r[20].sections.length, 512);
	for (const x of r.slice(0, 21)) for (const s of x.sections) {
		assert.equal(s['.type'], 'client');
		assert.ok(names.validateAlias(s.name).ok, 'stored names pass validateAlias');
	}
});

test('stand-in: wireless keeps the fields the view reads and no secret', () => {
	const r = runShim(BEHAVIOUR)[21].reply;
	assert.deepEqual(Object.keys(r), [ 'radio0' ]);
	const text = JSON.stringify(r);
	for (const v of Object.values(SECRETS).flat()) assert.ok(!text.includes(v.replace(/^s:/, '')), 'secret value ' + v);
	assert.doesNotMatch(text, /SECRET/);
	for (const k of Object.keys(SECRETS)) assert.ok(!new RegExp('"' + k + '"').test(text), 'secret key ' + k);
	assert.deepEqual(r.radio0.config, { band: '2g', channel: '6', htmode: 'EHT20', country: 'US', txpower: 20, disabled: false });
	const [ ap, sta ] = r.radio0.interfaces;
	assert.equal(r.radio0.interfaces.length, 2);
	assert.deepEqual(ap, { ifname: 'phy2g-ap0', section: 'default_radio0', config: { ssid: 'Home', mode: 'ap', hidden: '1', encryption: 'sae-mixed+ccmp',
		ieee80211w: 1, ieee80211r: true, ieee80211k: null, ieee80211v: null, network: [ 'lan' ], macaddr: '02:00:5e:00:53:a0' } });
	assert.equal(sta.config.encryption, 'wpa2+ccmp', 'anything beyond the mode string is dropped');
	assert.deepEqual(sta.config.network, [ 'wwan' ]);
	assert.deepEqual(runShim(BEHAVIOUR)[22].reply, {});
});

test('the model accepts what wireless returns', () => {
	const model = load('vantage.model');
	const wifi = runShim([ BEHAVIOUR[21] ])[0].reply;
	const m = model.build({ wifi, iwinfo: { 'phy2g-ap0': { channel: 6, frequency: 2437, bssid: '02:00:5E:00:53:A0', ssid: 'Home' } } });
	assert.deepEqual(m.radios.map(r => [ r.id, r.band, r.channel, r.country ]), [ [ 'radio0', '2g', 6, 'US' ] ]);
	assert.deepEqual(m.ssids.map(s => [ s.ssid, s.bssid, s.security.short, s.hidden ]), [ [ 'Home', '02:00:5E:00:53:A0', 'WPA2/3', true ], [ 'Upstream', '', 'WPA2-Ent', false ] ]);
});

test('stand-in: without network.wireless, wireless comes from the config, enabled interfaces only, no secret', () => {
	const [ r, netifd ] = runShim(BEHAVIOUR.slice(24, 26)).map(x => x.reply);
	assert.deepEqual(Object.keys(r), [ 'MT7990_1_1', 'MT7990_1_2', 'MT7990_1_3', 'MT7990_off' ]);
	const text = JSON.stringify(r);
	assert.doesNotMatch(text, /SECRET/);
	for (const k of Object.keys(SECRETS)) assert.ok(!new RegExp('"' + k + '"').test(text), 'secret key ' + k);
	assert.deepEqual(r.MT7990_1_1, {
		up: false, pending: false, disabled: false, source: 'config',
		config: { band: '2g', channel: '11', htmode: 'EHT20', country: null, txpower: null, disabled: '0' },
		interfaces: [
			{ ifname: 'ra0', section: 'ra0', config: { ssid: 'Home', mode: 'ap', hidden: '0', encryption: 'psk2+ccmp',
				ieee80211w: '1', ieee80211r: null, ieee80211k: null, ieee80211v: null, network: [ 'lan' ], macaddr: null } },
			{ ifname: 'ra2', section: 'wlanmld2g', config: { ssid: 'Home MLO', mode: 'ap', hidden: '0', encryption: 'sae',
				ieee80211w: null, ieee80211r: null, ieee80211k: null, ieee80211v: null, network: [ 'lan', 'guest' ], macaddr: null } }
		]
	});
	assert.deepEqual(r.MT7990_1_2.interfaces.map(i => [ i.ifname, i.section ]), [ [ 'rai0', 'rai0' ], [ 'rai4', 'wlanmldguest5g' ] ], 'first enabled section per ifname');
	assert.deepEqual(r.MT7990_1_3.config, { band: '6g', channel: 'auto', htmode: 'EHT160', country: null, txpower: null, disabled: '0' });
	assert.equal(r.MT7990_off.disabled, true);
	assert.deepEqual(netifd, runShim([ BEHAVIOUR[21] ])[0].reply, 'netifd answers: the config is not read');
	assert.equal(netifd.radio0.source, undefined);
});

test('stand-in: disabled reads like config_get_bool, and a disabled section claims no ifname', () => {
	const r = runShim([ BEHAVIOUR[26] ])[0].reply;
	assert.deepEqual(Object.keys(r).map(n => [ n, r[n].disabled ]), [ [ 'r_on', false ], [ 'r_true', true ], [ 'r_yes', true ], [ 'r_no', false ] ]);
	assert.deepEqual(r.r_on.interfaces.map(i => [ i.ifname, i.section, i.config.encryption ]),
		[ [ 'rai4', 'open', 'none' ], [ 'rai5', 'kept', 'psk2' ], [ 'rai6', 'upper', 'psk2' ] ], 'case as config_get_bool: TRUE is not a boolean');
	const m = load('vantage.model').build({ wifi: r, iwinfo: { rai4: { channel: 36 }, rai5: { channel: 36 }, rai6: { channel: 36 } } });
	assert.deepEqual(m.ssids.filter(s => s.ifname === 'rai4').map(s => [ s.ssid, s.security.short ]), [ [ 'Open', 'Open' ] ]);
	assert.deepEqual(m.radios.map(x => [ x.id, x.disabled ]), [ [ 'r_no', false ], [ 'r_on', false ], [ 'r_true', true ], [ 'r_yes', true ] ]);
});

test('stand-in: wired keeps the hosts the bridges learned, with port, VLAN and seconds since heard', () => {
	const [ r, none, many, bad ] = runShim(BEHAVIOUR.slice(27, 31));
	assert.deepEqual(r.reply.hosts, [
		{ mac: '00:00:5e:00:53:01', port: 'lan1', bridge: 'br-lan', vlan: null, seen: 12 },
		{ mac: '00:00:5e:00:53:02', port: 'lan2', bridge: 'br-lan', vlan: 10, seen: 300 },
		{ mac: '00:00:5e:00:53:03', port: 'lan2', bridge: 'br-lan', vlan: null, seen: null },
		{ mac: '00:00:5e:00:53:04', port: 'phy2g-ap0', bridge: 'br-lan', vlan: null, seen: null },
		{ mac: '00:00:5e:00:53:05', port: 'eth0', bridge: 'br-guest', vlan: null, seen: null }
	]);
	assert.deepEqual(none.reply, { hosts: [] });
	assert.equal(many.reply.hosts.length, 128, 'at most 128 on one port');
	assert.equal(bad.status, 2);
	const [ up ] = runShim([ BEHAVIOUR.find(c => c.fdb === FDB_UPLINK) ]);
	assert.deepEqual(up.reply.hosts.slice(-2).map(h => h.port), [ 'lan1', 'lan2' ], 'the downstream ports still listed');
	assert.equal(up.reply.hosts.filter(h => h.port === 'eth0').length, 128);
});

test('stand-in: routes keeps the lookups\' default routes in the main table, device and metric only', () => {
	const R = k => shim.routes(LOOKUPS[k]);
	assert.deepEqual(R('both'), [ { family: 4, dev: 'eth0', metric: 0 }, { family: 6, dev: 'eth0', metric: 1024 } ]);
	assert.deepEqual(R('tunnel'), [ { family: 4, dev: 'wg0', metric: 0 } ], 'no IPv6 route: left out');
	for (const k of [ 'def1', 'ownTable', 'blackhole', 'junk' ]) assert.deepEqual(R(k), [], k);
	assert.deepEqual(R('multipath'), [ { family: 4, dev: null, metric: 5 } ], 'several next hops still count');
	assert.deepEqual(R('oddDev'), [ { family: 4, dev: null, metric: 0 } ]);
	assert.equal(R('notSent'), null, 'a lookup not sent: no answer at all');
	assert.equal(shim.routes(null), null);
	/* the replay's kernel: netifd's routes, the lowest metric; of a
	   tunnel's and its line's, the tunnel's */
	const wan = { interface: 'wan', up: true, proto: 'dhcp', l3_device: 'eth0', metric: 0, route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] };
	const vpn = { interface: 'vpn', up: true, proto: 'wireguard', l3_device: 'wg0', route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] };
	const wanb = { interface: 'wanb', up: true, proto: 'dhcp', l3_device: 'eth9', metric: 20, route: [ { target: '0.0.0.0', mask: 0, nexthop: '203.0.113.201' } ] };
	const pbr = { interface: 'vpn2', up: true, proto: 'wireguard', l3_device: 'wg1', ip4table: '100', route: [ { target: '0.0.0.0', mask: 0, nexthop: '0.0.0.0' } ] };
	const wan6 = { interface: 'wan6', up: true, proto: 'dhcpv6', l3_device: 'eth0', route: [ { target: '::', mask: 0, nexthop: 'fe80::1' } ] };
	assert.deepEqual(shim.routes(shim.kernelLookup([ vpn, wan, wanb, pbr ])), [ { family: 4, dev: 'wg0', metric: 0 } ]);
	assert.deepEqual(shim.routes(shim.kernelLookup([ wan, wanb, wan6 ])), [ { family: 4, dev: 'eth0', metric: 0 }, { family: 6, dev: 'eth0', metric: 1024 } ]);
	assert.deepEqual(shim.routes(shim.kernelLookup([ Object.assign({}, vpn, { metric: 5 }), wan ])), [ { family: 4, dev: 'eth0', metric: 0 } ]);
	assert.deepEqual(shim.routes(shim.kernelLookup([])), []);
});

test('ucode plugin: crowded bridges are counted, not dumped', { skip: NO_UCODE }, () => {
	const src = fs.readFileSync(PLUGIN, 'utf8');
	assert.match(src, /^const NET = '\/sys\/class\/net';$/m);
	assert.match(src, /^const FDB_LIMIT = 4096;/m);
	/* never more read than the budget left, so a huge table costs no more */
	assert.match(src, /let left = FDB_LIMIT \* FDB_ENTRY;/);
	assert.match(src, /readfile\(NET \+ '\/' \+ n \+ '\/brforward', left\)/);
	const run = (entries, fdbIn) => { const r = spawnUcode([ { method: 'wired', fdb: fdbIn } ], null, entries); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout)[0].reply; };
	/* 'no dump': the rtnl double stops the run if the table is dumped */
	assert.deepEqual(run(4096, 'no dump'), { hosts: [], crowded: true }, 'at the limit: nothing dumped');
	assert.deepEqual(run([ 3000, 3000 ], 'no dump'), { hosts: [], crowded: true }, 'two bridges add up: one dump returns both');
	assert.equal(run(4095, FDB).hosts.length, 5, 'one below: dumped as usual');
	assert.equal(run([ 2000, 2095 ], FDB).hosts.length, 5);
	assert.equal(run(0, FDB).hosts.length, 5);
	const dumped = spawnUcode([ { method: 'wired', fdb: 'no dump' } ], null, 0);
	assert.notEqual(dumped.status, 0, 'the double does catch a dump');
	assert.match(dumped.stderr, /rtnl stub: a dump where none may happen/);
});

/* #101: on a router with a switch chip the dump also has its driver read
   the chip's own table (29 ms a dump on an MT7981): taken again only when
   brforward shows a host arrive, leave or change port, or after 30 s */
test('ucode plugin: wired dumps again only when the hosts move, or after FDB_DUMP_S', { skip: NO_UCODE }, () => {
	const src = fs.readFileSync(PLUGIN, 'utf8');
	assert.match(src, /^const FDB_DUMP_S = 30;/m);
	const run = (cases, source) => { const r = spawnUcode(cases, source); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).map(x => x.reply.hosts); };
	const seen = hosts => hosts.map(h => h.mac + ' ' + h.port + ' ' + h.vlan + ' ' + h.seen);
	const first = shim.wired(FDB);
	const added = FDB.concat([ fdb('00:00:5e:00:53:40', 'lan2') ]);
	const moved = FDB.map(n => n && n.lladdr === '00:00:5e:00:53:01' ? Object.assign({}, n, { dev: 'lan2' }) : n);
	const gone = FDB.filter(n => !(n && n.lladdr === '00:00:5e:00:53:02'));
	const [ a, b, c, d, e ] = run([
		{ method: 'wired', fdb: FDB, brforward: brforward(FDB) },
		/* the same hosts: the dump's, heard 2.5 s ago; 'no dump' stops the run on a dump */
		{ method: 'wired', fdb: 'no dump', brforward: brforward(FDB, { age: 250 }) },
		{ method: 'wired', fdb: added, brforward: brforward(added) },
		{ method: 'wired', fdb: moved, brforward: brforward(moved) },
		{ method: 'wired', fdb: gone, brforward: brforward(gone) }
	]);
	assert.deepEqual(a, first);
	assert.deepEqual(seen(b), [ '00:00:5e:00:53:01 lan1 null 2', '00:00:5e:00:53:02 lan2 10 2', '00:00:5e:00:53:03 lan2 null null',
		'00:00:5e:00:53:04 phy2g-ap0 null null', '00:00:5e:00:53:05 eth0 null null' ], 'static and unknown times stay unknown');
	assert.deepEqual(c, shim.wired(added), 'a host arrived: dumped');
	assert.deepEqual(d, shim.wired(moved), 'a host changed port: dumped');
	assert.deepEqual(e, shim.wired(gone), 'a host left: dumped');
	/* after FDB_DUMP_S (here 0): dumped though nothing moved, a VLAN changed */
	const vlan = FDB.map(n => n && n.lladdr === '00:00:5e:00:53:02' ? Object.assign({}, n, { vlan: 20 }) : n);
	const [ , late ] = run([ { method: 'wired', fdb: FDB, brforward: brforward(FDB) }, { method: 'wired', fdb: vlan, brforward: brforward(FDB) } ],
		src.replace(/^const FDB_DUMP_S = 30;/m, 'const FDB_DUMP_S = 0;'));
	assert.deepEqual(late, shim.wired(vlan));
	/* a big-endian router: the byte order is learned from the dump */
	const [ , be ] = run([ { method: 'wired', fdb: FDB, brforward: brforward(FDB, { be: true }) }, { method: 'wired', fdb: 'no dump', brforward: brforward(FDB, { be: true, age: 250 }) } ]);
	assert.deepEqual(seen(be).slice(0, 2), [ '00:00:5e:00:53:01 lan1 null 2', '00:00:5e:00:53:02 lan2 10 2' ]);
	/* a MAC on two ports of one bridge: each row's time is the dump's own,
	   so it is dumped every call (one brforward key cannot tell them apart) */
	const twice = FDB.concat([ fdb('00:00:5e:00:53:01', 'lan2', { vlan: 10, cacheinfo: { updated: 5000 } }) ]);
	const twiceVlan = twice.map(n => n && n.dev === 'lan2' && n.lladdr === '00:00:5e:00:53:01' ? Object.assign({}, n, { vlan: 20 }) : n);
	const [ , both ] = run([ { method: 'wired', fdb: twice, brforward: brforward(twice) }, { method: 'wired', fdb: twiceVlan, brforward: brforward(twice) } ]);
	assert.deepEqual(both, shim.wired(twiceVlan), 'dumped again');
	/* over FDB_PARSE records the tables are only counted: dumped each call */
	const big = Array.from({ length: 513 }, (_, i) => fdb('02:00:5e:01:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'lan1'));
	const bigVlan = big.map((n, i) => i === 0 ? Object.assign({}, n, { vlan: 30 }) : n);
	const [ , many ] = run([ { method: 'wired', fdb: big, brforward: brforward(big) }, { method: 'wired', fdb: bigVlan, brforward: brforward(big) } ]);
	assert.deepEqual(many, shim.wired(bigVlan), 'dumped again');
	assert.match(src, /^const FDB_PARSE = 512;/m);
	/* a failed dump is not kept */
	const [ , retry ] = run([ { method: 'wired', fdb: null, brforward: brforward(FDB) }, { method: 'wired', fdb: FDB, brforward: brforward(FDB) } ]);
	assert.deepEqual(retry, first);
});

/* a swconfig switch as OpenWrt's board.json describes it: LAN 1-4 on
   ports 0-3, WAN on 4, the CPU on 5 as eth1; documentation values only */
const SWITCH_BOARD = { model: { id: 'example,router', name: 'Example Router' }, switch: { switch0: { enable: true, reset: true,
	ports: [ { num: 0, role: 'lan', index: 1 }, { num: 1, role: 'lan', index: 2 }, { num: 2, role: 'lan', index: 3 }, { num: 3, role: 'lan', index: 4 },
		{ num: 4, role: 'wan' }, { num: 5, device: 'eth1', need_tag: false, want_untag: false } ],
	roles: [ { role: 'lan', ports: '0 1 2 3 5t', device: 'eth1.1' }, { role: 'wan', ports: '4 5t', device: 'eth1.2' } ] } } };
const SWITCH_UCI = [
	{ '.name': 'cfg01', '.type': 'switch', name: 'switch0', reset: '1', enable_vlan: '1' },
	{ '.name': 'cfg02', '.type': 'switch_vlan', device: 'switch0', vlan: '1', ports: '0 1 2 3 5t' },
	{ '.name': 'cfg03', '.type': 'switch_vlan', device: 'switch0', vlan: '2', ports: '4 5t' },
	{ '.name': 'wan', '.type': 'interface', device: 'eth1.2', proto: 'pppoe', username: 'user', password: 'not-for-the-dashboard' }
];

test('ucode plugin: a switch VLAN behind a port, from board.json and the switch_vlan sections only', { skip: NO_UCODE }, () => {
	const src = fs.readFileSync(PLUGIN, 'utf8');
	assert.match(src, /^const BOARD = '\/etc\/board\.json';$/m);
	const run = (board, network, fdbIn) => {
		const r = spawnUcode([ { method: 'wired', fdb: fdbIn || FDB, network_uci: network } ], null, 3, board);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout)[0].reply;
	};
	const lan = n => ({ num: n, role: 'lan', index: n + 1 });
	const r = run(SWITCH_BOARD, SWITCH_UCI);
	assert.equal(r.hosts.length, 5, 'the hosts as before');
	assert.deepEqual(r.switches, {
		'eth1.1': { name: 'switch0', vlan: 1, ports: [ lan(0), lan(1), lan(2), lan(3) ] },
		'eth1.2': { name: 'switch0', vlan: 2, ports: [ { num: 4, role: 'wan', index: null } ] }
	});
	assert.ok(!JSON.stringify(r).includes('not-for-the-dashboard'), 'nothing else of the network config');

	/* no switch in board.json (DSA), no board.json, or one that does not
	   parse: no switches, and the network config is never loaded */
	const dsa = { model: { id: 'example,dsa' }, network: { lan: { ports: [ 'lan1', 'lan2' ] } } };
	for (const b of [ dsa, null, '{"switch": {"switch0": ', '[]', JSON.stringify({ switch: { switch0: { ports: [ { num: 0, role: 'lan' } ] } } }) ])
		assert.equal(run(b, 'no load').switches, undefined, 'board ' + JSON.stringify(b).slice(0, 40));
	assert.deepEqual(run(SWITCH_BOARD, []).switches, r.switches, 'no switch_vlan sections: board.json\'s roles');

	/* vid over vlan; an untagged CPU port is the bare device; bad tokens,
	   unknown switches and bad device names skipped */
	const odd = run(SWITCH_BOARD, [
		{ '.name': 'a', '.type': 'switch_vlan', device: 'switch0', vlan: '3', vid: '100', ports: '0 1t 5t' },
		{ '.name': 'b', '.type': 'switch_vlan', device: 'switch0', vlan: '4', ports: '2 x 99 7 3* 5' },
		{ '.name': 'c', '.type': 'switch_vlan', device: 'switch1', vlan: '1', ports: '0 5t' },
		{ '.name': 'd', '.type': 'switch_vlan', device: 'switch0', vlan: '1.5', ports: '0 5t' },
		{ '.name': 'e', '.type': 'switch_vlan', device: 'switch0', vlan: '6', ports: '0 1' }
	]);
	assert.deepEqual(odd.switches, {
		'eth1.100': { name: 'switch0', vlan: 100, ports: [ lan(0), lan(1) ] },
		'eth1': { name: 'switch0', vlan: 4, ports: [ lan(2), { num: 7, role: null, index: null }, lan(3) ] }
	});
	/* GL.iNet's layout (#67): ports with a role and no number, a role
	   longer than "wan", the CPU tagged; the switch_vlan sections named,
	   or without their ports: board.json's roles */
	const gl = { model: { id: 'example,gl' }, switch: { switch0: { enable: true, reset: 0,
		ports: [ 0, 1, 2, 3 ].map(n => ({ num: n, role: 'lan' })).concat([ { num: 4, role: 'secondwan' }, { num: 5, device: 'eth1', need_tag: true, want_untag: false } ]),
		roles: [ { role: 'lan', ports: '0 1 2 3 5t', device: 'eth1.1' }, { role: 'secondwan', ports: '4 5t', device: 'eth1.2' } ] } } };
	const plain = n => ({ num: n, role: 'lan', index: null });
	const glWant = { 'eth1.1': { name: 'switch0', vlan: 1, ports: [ plain(0), plain(1), plain(2), plain(3) ] }, 'eth1.2': { name: 'switch0', vlan: 2, ports: [ { num: 4, role: 'secondwan', index: null } ] } };
	const named = [ { '.name': 'cfg01', '.type': 'switch', name: 'switch0', reset: '0', enable_vlan: '1' },
		{ '.name': 'vlan_lan', '.type': 'switch_vlan', device: 'switch0', vlan: '1', ports: '0 1 2 3 5t' },
		{ '.name': 'vlan_secondwan', '.type': 'switch_vlan', device: 'switch0', vlan: '2', ports: '4 5t' } ];
	assert.deepEqual(run(gl, named).switches, glWant);
	assert.deepEqual(run(gl, named.map(x => x['.type'] === 'switch_vlan' ? { '.name': x['.name'], '.type': x['.type'], device: x.device } : x)).switches, glWant, 'sections without ports: the roles');
	/* the config wins where it has the switch's VLANs, roles or not */
	assert.deepEqual(run(gl, [ { '.name': 'v', '.type': 'switch_vlan', device: 'switch0', vlan: '1', ports: '0 1 5t' } ]).switches,
		{ 'eth1.1': { name: 'switch0', vlan: 1, ports: [ plain(0), plain(1) ] } });
	/* roles that do not add up (a device that is not the CPU port's, no
	   VLAN, no device name) are skipped */
	const odd2 = JSON.parse(JSON.stringify(gl));
	odd2.switch.switch0.roles = [ { role: 'lan', ports: '0 1 5t', device: 'eth2.1' }, { role: 'x', ports: '2 5', device: 'eth1' }, { role: 'y', ports: '3 5t', device: 'eth1.3;x' } ];
	assert.equal(run(odd2, []).switches, undefined);
	/* a VLAN on two CPU ports reaches this device on both */
	const twoCpu = { switch: { switch0: { ports: [ { num: 0, role: 'lan', index: 1 }, { num: 5, device: 'eth0' }, { num: 6, device: 'eth1' } ] } } };
	assert.deepEqual(run(twoCpu, [ { '.name': 'v', '.type': 'switch_vlan', device: 'switch0', vlan: '100', ports: '0 5t 6t' } ]).switches,
		{ 'eth0.100': { name: 'switch0', vlan: 100, ports: [ lan(0) ] }, 'eth1.100': { name: 'switch0', vlan: 100, ports: [ lan(0) ] } });
	/* only plain names, roles and numbers reach the reply */
	const hostile = { switch: {
		'switch0': { ports: [ { num: 0, role: 'lan<b>', index: 1 }, { num: 1, role: 'a'.repeat(17), index: 2 }, { num: 2, role: 'lan', index: 100 }, { num: 5, device: 'eth1' } ],
			roles: [ { ports: '0 5t', device: 'eth1.4095' } ] },
		'sw itch': { ports: [ { num: 0 }, { num: 5, device: 'eth2' } ], roles: [ { ports: '0 5t', device: 'eth2.1' } ] } } };
	assert.deepEqual(run(hostile, [ { '.name': 'v', '.type': 'switch_vlan', device: 'switch0', vlan: '4095', ports: '0 5t' },
		{ '.name': 'w', '.type': 'switch_vlan', device: 'switch0', vlan: '9', ports: '0 1 2 5t' } ]).switches,
		{ 'eth1.9': { name: 'switch0', vlan: 9, ports: [ { num: 0, role: null, index: 1 }, { num: 1, role: null, index: 2 }, { num: 2, role: 'lan', index: null } ] } },
		'no VLAN 4095, no odd role, index or switch name');
	assert.equal(run(hostile, [ { '.name': 'v', '.type': 'switch_vlan', device: 'switch1', vlan: '1', ports: '0 5t' } ]).switches, undefined, 'roles with VLAN 4095: none');
	const many = Array.from({ length: 70 }, (_, i) => ({ '.name': 'v' + i, '.type': 'switch_vlan', device: 'switch0', vlan: String(i + 1), ports: '0 5t' }));
	assert.equal(Object.keys(run(SWITCH_BOARD, many).switches).length, 64, 'at most 64 VLANs');
	const evil = JSON.parse(JSON.stringify(SWITCH_BOARD));
	evil.switch.switch0.ports[5].device = 'eth1;reboot';
	assert.equal(run(evil, 'no load').switches, undefined, 'a CPU device that is no device name: no switch');
	const crowded = spawnUcode([ { method: 'wired', fdb: 'no dump', network_uci: SWITCH_UCI } ], null, 4096, SWITCH_BOARD);
	assert.equal(crowded.status, 0, crowded.stderr);
	assert.deepEqual(Object.keys(JSON.parse(crowded.stdout)[0].reply), [ 'hosts', 'crowded', 'switches' ], 'crowded bridges: the switches still');
});

test('stand-in: the replay falls back to the store\'s uci wireless when network.wireless is missing or empty', () => {
	const values = {};
	MTK.forEach((s, i) => { values[s['.name']] = Object.assign({ '.index': MTK.length - i }, s); });
	const store = status => ({ data: () => status, uci: (m, a) => (m === 'get' && a.config === 'wireless') ? { result: [ 0, { values } ] } : { result: [ 4 ] } });
	const r = shim.call(store(null), 'wireless', {}).result[1];
	assert.deepEqual(Object.keys(r).sort(), [ 'MT7990_1_1', 'MT7990_1_2', 'MT7990_1_3', 'MT7990_off' ]);
	assert.deepEqual(r.MT7990_1_2.interfaces.map(i => i.section), [ 'again5g', 'rai0' ], 'config order is the store\'s .index order');
	assert.deepEqual(Object.keys(shim.call(store({}), 'wireless', {}).result[1]).sort(), [ 'MT7990_1_1', 'MT7990_1_2', 'MT7990_1_3', 'MT7990_off' ], 'an empty status: the config');
	assert.deepEqual(shim.call({ data: () => ({}), uci: () => ({ result: [ 4 ] }) }, 'wireless', {}), { result: [ 0, {} ] }, 'empty and no config: nothing');
	assert.deepEqual(shim.call({ data: () => null, uci: () => ({ result: [ 4 ] }) }, 'wireless', {}), { result: [ 0, {} ] });
});

test('model: a radio from the config shows its configured Wi-Fi 7 mode and is up when iwinfo answers', () => {
	const model = load('vantage.model');
	const wifi = runShim([ BEHAVIOUR[24] ])[0].reply;
	/* mtkwifi's iwinfo: HE only, txpower in dBm; rai4 does not answer */
	const iw = (channel, frequency, htmode, centre) => ({ mode: 'Master', ssid: 'Home', bssid: '02:00:5E:00:53:B0', channel, frequency, htmode, center_chan1: centre, txpower: 23, hwmodes: [ 'ax' ] });
	const iwinfo = { ra0: iw(11, 2462, 'HE20', 11), ra2: iw(11, 2462, 'HE20', 11), rai0: iw(48, 5240, 'HE80', 42), rax0: iw(37, 6135, 'HE160', 47), rai4: {} };
	const m = model.build({ wifi, iwinfo });
	assert.deepEqual(m.radios.map(r => [ r.id, r.band, r.gen, r.width, r.htmode, r.channel, r.up, r.disabled, r.txpower, r.txpowerCfg ]), [
		[ 'MT7990_1_1', '2g', 'Wi-Fi 7', 20, 'EHT20', 11, true, false, 23, null ],
		[ 'MT7990_1_2', '5g', 'Wi-Fi 7', 80, 'EHT80', 48, true, false, 23, null ],
		[ 'MT7990_1_3', '6g', 'Wi-Fi 7', 160, 'EHT160', 37, true, false, 23, null ],
		[ 'MT7990_off', '2g', 'Wi-Fi 7', 20, 'EHT20', 1, false, true, null, null ]
	]);
	assert.deepEqual(m.ssids.map(s => [ s.ifname, s.ssid, s.up ]), [ [ 'ra0', 'Home', true ], [ 'ra2', 'Home MLO', true ],
		[ 'rai0', 'Home', true ], [ 'rai4', 'Guest MLO', true ], [ 'rax0', 'Home', true ] ]);
	/* nothing answers: down, not up */
	assert.deepEqual(model.build({ wifi, iwinfo: { ra0: {}, ra2: {} } }).radios.map(r => r.up), [ false, false, false, false ]);
});

test('model: a radio netifd reports keeps iwinfo\'s mode over the configured one', () => {
	const model = load('vantage.model');
	const wifi = { radio0: { up: true, config: { band: '6g', channel: '37', htmode: 'EHT160' }, interfaces: [ { ifname: 'phy6g-ap0', config: { ssid: 'Home', mode: 'ap' } } ] } };
	const m = model.build({ wifi, iwinfo: { 'phy6g-ap0': { channel: 37, frequency: 6135, htmode: 'HE160', center_chan1: 47 } } });
	assert.deepEqual(m.radios.map(r => [ r.gen, r.width, r.htmode, r.up ]), [ [ 'Wi-Fi 6E', 160, 'HE160', true ] ]);
	const down = model.build({ wifi: { radio0: Object.assign({}, wifi.radio0, { up: false }) }, iwinfo: { 'phy6g-ap0': { channel: 37 } } });
	assert.equal(down.radios[0].up, false, 'netifd says down: iwinfo does not make it up');
});

/* a fake /sys/class/thermal under a fixtures root: [ zone, type, temp ] */
const ZONES = [
	[ 'thermal_zone0', 'cpu-thermal\n', '52100\n' ],
	[ 'thermal_zone1', 'gpu thermal\n', '-5000\n' ],       /* not a plain word: sent as '' */
	[ 'thermal_zone2', 'off\n', null ],                     /* no reading: left out */
	[ 'thermal_zone10', 'tsens_tz_sensor11\n', '77100\n' ], /* numeric order */
	[ 'thermal_zone3', 'x\n', 'hot\n' ],                    /* not a number: left out */
	[ 'cooling_device0', 'fan\n', '1\n' ]                   /* not a zone */
];
const ZONES_OUT = [
	{ zone: 'thermal_zone0', type: 'cpu-thermal', temp: 52100 },
	{ zone: 'thermal_zone1', type: '', temp: -5000 },
	{ zone: 'thermal_zone10', type: 'tsens_tz_sensor11', temp: 77100 }
];
function fakeThermal() {
	const dir = mkTmp('vantage-thermal-');
	const sys = path.join(dir, 'root/sys/class/thermal');
	for (const [ zone, type, temp ] of ZONES) {
		fs.mkdirSync(path.join(sys, zone), { recursive: true });
		fs.writeFileSync(path.join(sys, zone, 'type'), type);
		if (temp != null) fs.writeFileSync(path.join(sys, zone, 'temp'), temp);
	}
	return { dir, sys };
}

test('stand-in: thermal reads the zones of a fixtures file system, none without one', () => {
	const { Fixtures } = require('../dev/replay/fixtures');
	const { dir } = fakeThermal();
	assert.deepEqual(shim.call({ fixtures: new Fixtures([ dir ]) }, 'thermal', {}), { result: [ 0, { zones: ZONES_OUT } ] });
	assert.deepEqual(shim.call({ fixtures: null }, 'thermal', {}), { result: [ 0, { zones: [] } ] });
	assert.deepEqual(load('vantage.model').temps(ZONES_OUT).map(t => t.name), [ 'tsens_tz_sensor11', 'cpu-thermal', 'thermal_zone1' ]);
});

test('ucode plugin: thermal reads the same file system alike', { skip: NO_UCODE }, () => {
	const { dir, sys } = fakeThermal();
	const src = fs.readFileSync(PLUGIN, 'utf8');
	assert.match(src, /^const THERMAL = '\/sys\/class\/thermal';$/m);
	const copy = path.join(dir, 'luci.vantage');
	fs.writeFileSync(copy, src.replace(/^const THERMAL = .*$/m, () => 'const THERMAL = ' + JSON.stringify(sys) + ';'));
	const args = [ '-L', path.join(__dirname, 'ucode/stubs') ];
	const lib = path.join(path.dirname(UCODE), '../lib/ucode');
	if (fs.existsSync(lib)) args.push('-L', lib);
	args.push('-e', "printf('%J', loadfile(" + JSON.stringify(copy) + ", { raw_mode: true })()['luci.vantage'].thermal.call())");
	const r = spawnSync(UCODE, args, { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), { zones: ZONES_OUT });
});

test('ucode plugin: same results as the stand-in for every case', { skip: NO_UCODE }, () => {
	const u = runUcode(ALL), s = runShim(ALL);
	assert.equal(u.length, ALL.length);
	for (let i = 0; i < ALL.length; i++)
		assert.deepEqual(norm(u[i]), norm(s[i]), `case ${i}: ${JSON.stringify(ALL[i]).slice(0, 160)}`);
});

test('ucode plugin: the test doubles stop a copy that writes wireless, reads another config, calls another object or writes over netlink', { skip: NO_UCODE }, () => {
	const src = fs.readFileSync(PLUGIN, 'utf8'), at = '\tlet wl = cursor();\n';
	assert.ok(src.includes(at), 'insertion point');
	const MUTANTS = {
		'write wireless': "let w = cursor(); w.set('wireless', 'x', 'encryption', 'none'); w.commit('wireless');",
		'commit wireless': 'wl.commit(WIRELESS);',
		'read network': "wl.load('network');",
		'cursor on another directory': "cursor('/etc/init.d');",
		'another ubus call': "connect().call('file', 'read', { path: '/etc/shadow' });",
		'a netlink write': 'rtnl.request(rtnl.const.RTM_DELNEIGH, 0, { family: rtnl.const.AF_BRIDGE });'
	};
	const run = [ BEHAVIOUR[24], BEHAVIOUR[0] ];      /* the config fallback and an alias write */
	const ok = spawnUcode(run, src);
	assert.equal(ok.status, 0, ok.stderr);
	for (const [ name, code ] of Object.entries(MUTANTS)) {
		const r = spawnUcode(run, src.replace(at, at + '\t' + code + '\n'));
		assert.notEqual(r.status, 0, name);
		assert.match(r.stderr, /(uci|ubus|rtnl) stub: /, name);
	}
});

test('ucode plugin: compiles as rpcd loads it', { skip: NO_UCODE }, () => {
	/* imports resolve against the test doubles; the device has the real modules */
	const r = spawnSync(UCODE, [ '-L', path.join(__dirname, 'ucode/stubs'), '-c', '-o', '/dev/null', PLUGIN ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
});

/* ucode compiles a regular expression literal each time the code reaches it,
   and musl takes milliseconds over a counted repeat on a router (8.5 ms
   against 0.07 ms on an ARM access point): the plugin's patterns are module
   constants, compiled once while rpcd keeps the module loaded */
test('ucode plugin: every regular expression is a module constant', () => {
	const bad = [];
	fs.readFileSync(PLUGIN, 'utf8').split('\n').forEach((line, i) => {
		const code = line.replace(/\/\/.*$/, '');
		if (/^const RE_[A-Z0-9_]+ = \//.test(code)) return;
		/* a "/" that starts an expression: after ( , = : ! & | ? or return */
		if (/(?:[(,=:!&|?]|\breturn)\s*\/(?![/*])/.test(code)) bad.push((i + 1) + ': ' + line.trim().slice(0, 80));
	});
	assert.deepEqual(bad, []);
});

test('stand-in: set_quiet keeps one quiet section per MAC, beside the names; off removes them all; caps at 512; refuses bad input', () => {
	const pick = c => runShim([ c ])[0];
	const QUIET = BEHAVIOUR.filter(c => c.method === 'set_quiet');
	let r = pick(QUIET[0]);
	assert.deepEqual(r.reply, { ok: true, op: 'add', mac: MAC });
	assert.deepEqual(r.sections.map(s => [ s['.type'], s.mac ]), [ [ 'quiet', MAC ] ], 'normalised MAC');
	r = pick(QUIET[1]);
	assert.deepEqual(r.reply, { ok: true, op: 'none', mac: MAC }, 'already quiet');
	r = pick(QUIET[2]);
	assert.deepEqual(r.reply.op, 'delete');
	assert.deepEqual(r.sections.map(s => s['.name']), [ 'a', 's' ], 'both spellings of the MAC go; the name and another MAC stay');
	assert.deepEqual(pick(QUIET[3]).reply, { ok: true, op: 'none', mac: MAC }, 'not quiet: nothing to do');
	assert.deepEqual(pick(QUIET[4]).reply, { ok: false, error: 'invalid-mac' }, 'multicast');
	assert.deepEqual(pick(QUIET[5]).reply, { ok: false, error: 'invalid-mac' });
	assert.deepEqual(pick(QUIET[6]).reply, { ok: false, error: 'invalid-value' }, 'quiet missing');
	r = pick(QUIET[7]);
	assert.deepEqual([ r.reply, r.reverted, r.sections ], [ { ok: false, error: 'failed' }, true, [] ], 'a failed commit is reverted');
	assert.deepEqual([ pick(QUIET[8]).status, pick(QUIET[9]).status, pick(QUIET[10]).status ], [ 2, 2, 2 ], 'rpcd refuses a string, a number, an unknown argument');
	assert.deepEqual(pick(QUIET[11]).reply, { ok: false, error: 'too-many' }, '512 quiet sections');
	assert.equal(pick(QUIET[12]).reply.op, 'add', '512 names do not count');
});
