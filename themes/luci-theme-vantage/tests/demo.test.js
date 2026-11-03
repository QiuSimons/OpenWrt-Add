'use strict';
const mkTmp = require('./tmpdir');
/* dev/replay/demo.js: the replay's --demo pseudonymiser.

   Unit tests use inputs built from numbers (this tree must stay free of
   real-looking addresses). The mirror test runs the pseudonymiser over the
   private mirror when it is present ($VANTAGE_MIRROR or ../vantage-mirror)
   and requires zero findings from check_private_addresses.js's detectors
   and zero recorded identifiers in everything the replay can serve, asking
   every recorded call through the store. The canary test does the same on
   a synthetic mirror with the shapes the pseudonymiser must catch (uci
   free text, names only in DHCP log lines, MAC fragments, EUI-64, DUIDs,
   serial numbers) and does not rely on the checker's identifier list. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Pseudonymiser, v6text, macToEui, AP_HOSTNAME } = require('../dev/replay/demo');
const checker = require('../security-tests/check_private_addresses');

const ROOT = path.join(__dirname, '..');
const MIRROR = process.env.VANTAGE_MIRROR || path.join(ROOT, '..', 'vantage-mirror');
const hasMirror = fs.existsSync(MIRROR) && fs.statSync(MIRROR).isDirectory();

/* private-looking values, assembled so the source file itself stays clean */
const ip = (...o) => o.join('.');
const mac = (...o) => o.map(x => x.toString(16).padStart(2, '0')).join(':');
const LAN = n => ip(192, 168, 7, n), MGMT = n => ip(10, 20, 30, n);
const UNI = mac(0xa4, 0x5e, 0x60, 0x11, 0x22, 0x33);       /* universal */
const LOC = mac(0x6e, 0x11, 0x22, 0x33, 0x44, 0x55);       /* locally administered */
const ULA = [ 'fd12', '3456', '789a' ].join(':');
const GUA = [ '2a01', '4f8', 'c0c' ].join(':');
const EUI = [ '6c11', '22ff', 'fe33', '4455' ].join(':');   /* EUI-64 of LOC */

test('demo: MACs map into the documentation ranges, keeping U/L and case', () => {
	const p = new Pseudonymiser();
	const a = p.text(UNI), b = p.text(LOC.toUpperCase()), m = p.text(mac(0x33, 0x33, 0, 0, 0, 1));
	assert.match(a, /^00:00:5e:00:53:[0-9a-f]{2}$/);
	assert.match(b, /^02:00:5E:00:53:[0-9A-F]{2}$/);
	assert.match(m, /^01:00:5e:90:10:[0-9a-f]{2}$/);
	assert.equal(p.text(UNI.toUpperCase()), a.toUpperCase(), 'same MAC, same demo MAC');
	assert.equal(p.text(UNI.replace(/:/g, '-')), a.replace(/:/g, '-'));
	/* bare form of a known MAC, e.g. a bridge id */
	assert.equal(p.text('7fff.' + UNI.replace(/:/g, '')), '7fff.' + a.replace(/:/g, ''));
	assert.equal(p.text('00:00:00:00:00:00'), '00:00:00:00:00:00');
	for (const out of [ a, b, m ]) assert.deepEqual(checker.findings(out, null), []);
});

test('demo: IPv4 keeps the /24 layout, IPv6 moves to 2001:db8::/32', () => {
	const p = new Pseudonymiser();
	assert.equal(p.text(LAN(69) + '/24 via ' + LAN(1)), '192.0.2.69/24 via 192.0.2.1');
	assert.equal(p.text(LAN(255)), '192.0.2.255');
	assert.equal(p.text(MGMT(0)), '198.51.100.0');
	assert.equal(p.text('255.255.255.0 0.0.0.0 127.0.0.1 198.51.100.7'), '255.255.255.0 0.0.0.0 127.0.0.1 198.51.100.7');
	assert.match(p.text(ip(8, 8, 4, 4)), /^203\.0\.113\.\d+$/);
	/* EUI-64 link-local -> short form; same identifier in a global address */
	const ll = p.text('fe80::' + EUI), gua = p.text(GUA + ':1:' + EUI);
	assert.match(ll, /^fe80::[0-9a-f]{1,4}$/);
	assert.equal(gua, '2001:db8:1:1::' + ll.slice(6));
	assert.equal(p.text(ULA + '::/48'), '2001:db8:fd01::/48');
	assert.equal(p.text('fe80::1 ::1 ff02::1'), 'fe80::1 ::1 ff02::1');
	assert.deepEqual(checker.findings(p.text([ LAN(5), MGMT(9), ll, gua, ULA + '::1' ].join(' ')), null), []);
	assert.equal(v6text([ 0x2001, 0xdb8, 0, 0, 1, 0, 0, 0 ]), '2001:db8:0:0:1::');
	assert.equal(v6text([ 0x2001, 0xdb8, 0, 0, 0, 0, 0, 1 ]), '2001:db8::1');
});

test('demo: names, SSIDs by band, WPS names, country, time zone, fingerprints', () => {
	const p = new Pseudonymiser();
	const wireless = {
		radio0: { '.type': 'wifi-device', band: '2g', country: 'NL' },
		radio1: { '.type': 'wifi-device', band: '6g', country: 'NL' },
		a: { '.type': 'wifi-iface', '.index': 2, device: 'radio0', ssid: 'Casa-Rossi' },
		b: { '.type': 'wifi-iface', '.index': 3, device: 'radio0', ssid: 'Casa-Rossi-Old' },
		c: { '.type': 'wifi-iface', '.index': 4, device: 'radio1', ssid: 'Casa-Rossi-Fast' }
	};
	p.ssids(wireless);
	const board = { hostname: 'rossi-attic-ap', model: 'Zyxel NWA50BE' };
	const clients = { [LOC]: { signature: 'wifi4|probe:0,1,wps:HP_ENVY_6000_series|assoc:0' } };
	for (const [ v, ctx ] of [ [ { values: wireless }, 'uci wireless' ], [ board, 'system board' ], [ clients, 'hostapd.x get_clients' ] ])
		p.learn(v, undefined, ctx);
	p.learn({ [UNI]: { name: 'marios-iphone', ipaddrs: [ LAN(20) ] } }, undefined, 'luci-rpc getHostHints');

	const w = p.value({ values: wireless }, undefined, 'uci wireless').values;
	assert.deepEqual([ w.a.ssid, w.b.ssid, w.c.ssid ], [ 'Harbor', 'Harbor-IoT', 'Harbor-6E' ]);
	assert.equal(w.radio0.country, 'US');
	const b = p.value(board, undefined, 'system board');
	assert.deepEqual(b, { hostname: AP_HOSTNAME, model: 'Zyxel NWA50BE' });
	const c = p.value(clients, undefined, 'hostapd.x get_clients');
	assert.match(Object.values(c)[0].signature, /wps:Office_printer\|/);
	assert.equal(p.text('HP ENVY 6000 series'), 'Office printer');
	const h = p.value({ [UNI]: { name: 'marios-iphone' } }, undefined, 'luci-rpc getHostHints');
	assert.equal(Object.values(h)[0].name, 'phone');
	assert.equal(p.text('uhttpd -r rossi-attic-ap -x /cgi-bin'), 'uhttpd -r vantage-ap -x /cgi-bin');
	assert.deepEqual(p.value({ zonename: 'Europe/Amsterdam', timezone: 'CET-1CEST' }), { zonename: 'UTC', timezone: 'UTC0' });
	const cl = p.value([ 0, { results: [ { code: 'NL', active: true }, { code: 'US', active: false } ] } ], undefined, 'iwinfo countrylist');
	assert.deepEqual(cl[1].results.map(r => r.active), [ false, true ]);
	assert.doesNotMatch(p.text('Pubkey auth succeeded with ssh-rsa key SHA256:wS0Au9q1Gy2x3EGWb4+ug5anU6OPLJk7L8vowZ9d0E1 from'), /wS0Au9q/);
	assert.deepEqual(p.value({ board: 'x', serial: 'S1234', sn: 'Q9' }), { board: 'x' });
});

/* Everything a demo-mode replay can serve: every recorded call asked
   through Store#call (so the uci overlay, plugins and synthetic generators
   answer as they would), every time series, exec output and HTTP body. */
function crawl(store) {
	/* the store logs coverage gaps on stderr; not needed here */
	const quiet = console.error;
	console.error = () => {};
	try { return crawlAll(store); } finally { console.error = quiet; }
}
function crawlAll(store) {
	const chunks = new Set();
	const add = v => chunks.add(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
	const ask = key => {
		const [ o, m, a ] = key.split('\0');
		let args = {};
		try { args = JSON.parse(a || '{}'); } catch (e) {}
		add(key.replace(/\0/g, ' '));
		add(store.call(o, m, args));
	};
	for (const k of store.exact.keys()) ask(k);
	for (const k of store.series.keys()) { ask(k); for (const r of store.series.get(k)) add(r); }
	for (const r of store.loose.values()) add(r);
	for (const [ u, b ] of store.http) { add(u); add(b); }
	for (const [ a, o ] of store.exec) { add(a); add(o); add(store.execText(JSON.parse(a))); }
	add(store.call('uci', 'configs', {}));
	for (const c of Object.keys(store.uciCommitted)) add(store.call('uci', 'get', { config: c }));
	add(store.menu());
	add(store.list());
	for (const radio of [ 'radio0', 'radio1', 'radio2' ]) { add(store.call('iwinfo', 'scan', { device: radio })); add(store.call('iwinfo', 'info', { device: radio })); }
	for (const mode of [ 'load', 'conntrack' ]) add(store.call('luci', 'getRealtimeStats', { mode }));
	add(store.call('luci', 'getConntrackList', {}));
	for (const o of store.plugins.keys()) add(store.call(o, 'wireless', {}));
	return [ ...chunks ].join('\n');
}

const escRe = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/* what is left of the originals in the output, masked */
function leaks(text, p) {
	const lower = text.toLowerCase();
	const out = [];
	const word = v => new RegExp('(?<![a-z0-9])' + escRe(v.toLowerCase()).replace(/\s+/g, '\\s+') + '(?![a-z0-9])').test(lower);
	for (const real of p.names.keys()) if (word(real)) out.push('name ' + checker.mask(real));
	for (const real of p.freeform.keys()) if (real.trim().length >= 4 && word(real.trim())) out.push('uci free text ' + checker.mask(real));
	for (const [ real, demo ] of p.macs) {
		if (real === demo) continue;
		const eui = macToEui(real);
		const forms = [ real.match(/../g).join(':'), real.match(/../g).join('-'), real.match(/.{4}/g).join('.'), real, eui, eui.match(/.{4}/g).map(g => g.replace(/^0+(?=.)/, '')).join(':') ];
		if (forms.some(f => lower.includes(f))) out.push('MAC ' + checker.mask(real));
		if (!(parseInt(real.slice(0, 2), 16) & 1) && new RegExp('[_-]' + real.slice(6) + '(?![0-9a-f])').test(lower)) out.push('MAC suffix ' + checker.mask(real));
	}
	for (const real of p.v4other.keys()) if (new RegExp('(?<![\\d.])' + real.replace(/\./g, '\\.') + '(?![\\d]|\\.\\d)').test(text)) out.push('IPv4 ' + checker.mask(real));
	for (const c of p.countries) if (text.includes(`"country":"${c}"`)) out.push('country');
	return out;
}

test('demo: canary mirror - free text, log names, MAC fragments, EUI-64, DUIDs, serials', () => {
	const { Store } = require('../dev/replay/store');
	const os = require('os');
	const dir = mkTmp('vantage-demo-canary-');
	const run = path.join(dir, 'browser-2026-01-01T00-00-00-000Z');
	fs.mkdirSync(run);
	const CLIENT = mac(0xa4, 0x5e, 0x60, 0x11, 0x22, 0x33);        /* only named in a DHCP log line */
	const BRIDGE = [ 0xb8, 0x27, 0xeb, 0x12, 0x34, 0x56 ].map(x => x.toString(16).padStart(2, '0')).join('');   /* only in a bridge id */
	const ESP = mac(0x24, 0x6f, 0x28, 0x44, 0x55, 0x66);          /* learned; its suffix shows up as ESP_445566 */
	const EUI_BARE = 'a65e60fffe112233', EUI_COLON = 'a65e:60ff:fe11:2233';
	const DUID = '00030001' + CLIENT.replace(/:/g, '');
	const sections = (type, list) => Object.fromEntries(list.map((s, i) => {
		const sid = s['.name'] || 'cfg' + type.replace(/\W/g, '') + i;
		return [ sid, Object.assign({ '.anonymous': !s['.name'], '.type': type, '.name': sid, '.index': i }, s) ];
	}));
	const uci = (config, values) => ({ at: 1, object: 'uci', method: 'get', args: { config }, result: [ 0, { values } ] });
	const rows = [
		uci('system', Object.assign(sections('system', [ { hostname: 'rossi-attic-ap', description: "Mario's lab AP", notes: 'Garage shelf, left', zonename: 'Europe/Rome' } ]),
			sections('timeserver', [ { '.name': 'ntp', server: [ '0.openwrt.pool.ntp.org', 'ntp.rossi-corp.example' ] } ]))),
		uci('firewall', Object.assign(sections('zone', [ { name: 'lan', network: [ 'lan' ], input: 'ACCEPT' } ]),
			sections('rule', [ { name: 'Allow-Ping', proto: 'icmp', target: 'ACCEPT' }, { name: 'Allow-Mario-NAS', dest_port: '445', target: 'ACCEPT' } ]))),
		uci('uhttpd', sections('cert', [ { '.name': 'defaults', commonname: 'mario-router', location: 'Bologna', organization: 'Rossi Family', days: '397' } ])),
		uci('network', sections('interface', [ { '.name': 'lan', proto: 'static', device: 'br-lan', ipaddr: LAN(2) } ])),
		{ at: 1, object: 'hostapd.phy0-ap0', method: 'get_clients', args: {}, result: [ 0, { clients: { [ESP]: { auth: true } } } ] },
		{ at: 1, object: 'network.interface', method: 'dump', args: {}, result: [ 0, { interface: [ { interface: 'lan', 'ipv6-address': [ { address: GUA + ':1:' + EUI_COLON, mask: 64 } ] } ] } ] },
		{ at: 1, object: 'log', method: 'read', args: {}, result: [ 0, { log: [
			`dnsmasq-dhcp[1]: DHCPACK(br-lan) ${LAN(23)} ${CLIENT} lucias-macbook`,
			'dnsmasq-dhcp[1]: not giving name gianni-pc to the DHCP lease of ' + LAN(24) + ' because the name exists',
			`kernel: br-lan: bridge id 8000.${BRIDGE} topology change`,
			'hostapd: ESP_445566 associated',
			'odhcpd[2]: addr ' + EUI_BARE + ' DUID ' + DUID + ' joined ff02::1:ff11:2233',
			'Serial\t\t: 00000000deadbeef',
			'usb 1-1: SerialNumber: ABC123XYZ',
			'fw4: sn=QX7781 serial=QX7782'
		].join('\n') } ] }
	];
	fs.writeFileSync(path.join(run, 'rpc.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
	fs.writeFileSync(path.join(run, 'http.jsonl'), JSON.stringify({ at: 1, url: '/cgi-bin/cgi-exec', argv: [ '/usr/sbin/nft', '--terse', '--json', 'list', 'ruleset' ],
		body: JSON.stringify({ nftables: [ { rule: { comment: '!fw4: Allow-Mario-NAS' } }, { rule: { comment: '!fw4: Allow-Ping' } } ] }) }) + '\n');

	const store = new Store(dir, { synthetic: false, demo: true, plugins: false });
	const text = crawl(store);
	const canaries = [ 'mario', 'garage', 'rossi', 'bologna', 'lucias', 'gianni', BRIDGE, BRIDGE.match(/../g).join(':'), '445566', EUI_BARE, EUI_COLON,
		'ff11:2233', DUID, 'deadbeef', 'abc123xyz', 'qx778', CLIENT, ESP ];
	const left = canaries.filter(c => text.toLowerCase().includes(c.toLowerCase())).map(c => checker.mask(c));
	assert.deepEqual(left, [], 'canaries left in the demo output');
	assert.deepEqual(leaks(text, store.demo), []);
	assert.deepEqual(checker.findings(text, null).map(f => f[1]), []);
	/* structure survives */
	const fw = store.data('uci', 'get', { config: 'firewall' }).values;
	assert.deepEqual(Object.values(fw).map(s => s.name), [ 'lan', 'Allow-Ping', 'name-1' ]);
	assert.equal(fw.cfgrule0.target, 'ACCEPT');
	assert.deepEqual(store.data('uci', 'get', { config: 'system', section: 'ntp' }).values.server, [ '0.openwrt.pool.ntp.org', 'host1.example.net' ]);
	assert.equal(store.data('uci', 'get', { config: 'network', section: 'lan', option: 'proto' }).value, 'static');
	assert.equal(store.data('uci', 'get', { config: 'system' }).values.cfgsystem0.description, 'description-1');
	assert.match(text, /!fw4: name-1/);
	assert.match(text, /!fw4: Allow-Ping/);
});

test('demo: every recorded call, served in demo mode, carries no real identifiers', { skip: !hasMirror && `no mirror at ${MIRROR}` }, () => {
	const { Store } = require('../dev/replay/store');
	const ids = checker.mirrorIdentifiers(MIRROR);
	assert.ok(ids.size > 0, 'mirror identifiers loaded');
	const store = new Store(MIRROR, { synthetic: true, demo: true });
	const p = store.demo;
	const text = crawl(store);

	/* 1. the address/MAC detectors and the recorded identifiers (findings
	   are masked by the checker) */
	const found = checker.findings(text, ids);
	assert.deepEqual(found.slice(0, 10).map(f => f[1]), [], `${found.length} finding(s) in the demo output`);

	/* 2. none of the originals the pseudonymiser replaced, in any form */
	assert.deepEqual(leaks(text, p), []);

	/* 3. the demo data is what the screenshots expect */
	const board = store.data('system', 'board', {});
	assert.equal(board.hostname, AP_HOSTNAME);
	assert.match(JSON.stringify(store.data('network.wireless', 'status', {})), /"ssid":"Harbor"/);
});
