'use strict';
/* Client naming: resolution order, MAC classes, WPS names, aliases, OUI. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const names = load('vantage.names');
const oui = load('vantage.oui');

const MAC = '00:00:5E:00:53:10';        /* globally unique (U/L bit clear) */
const PMAC = '02:00:5E:00:53:11';       /* locally administered */

test('normMac: accepts common notations, rejects junk', () => {
	assert.equal(names.normMac('00-00-5E-00-53-10'), '00:00:5e:00:53:10');
	assert.equal(names.normMac('0000.5e00.5310'), '00:00:5e:00:53:10');
	assert.equal(names.normMac('00005E005310'), '00:00:5e:00:53:10');
	assert.equal(names.normMac('00:00:5E:00:53'), null);
	assert.equal(names.normMac('zz:00:5E:00:53:10'), null);
	assert.equal(names.normMac(null), null);
});

test('locally administered (private) and multicast detection', () => {
	assert.equal(names.isPrivateMac(PMAC), true);
	assert.equal(names.isPrivateMac('06:00:5E:00:53:01'), true);
	assert.equal(names.isPrivateMac('0A:00:5E:00:53:01'), true);
	assert.equal(names.isPrivateMac('0E:00:5E:00:53:01'), true);
	assert.equal(names.isPrivateMac(MAC), false);
	assert.equal(names.isPrivateMac('04:00:5E:00:53:01'), false);
	assert.equal(names.isMulticastMac('01:00:5E:00:53:01'), true);
	assert.equal(names.isMulticastMac(MAC), false);
	assert.equal(names.ouiKey(MAC), '00:00:5E');
	assert.equal(names.ouiKey(PMAC), null, 'no vendor for a private address');
	assert.equal(names.ouiKey('01:00:5E:00:53:01'), null);
});

test('OUI table: lookup by key or full MAC, unknown gives null', () => {
	assert.equal(oui.lookup('B8:27:EB'), 'Raspberry Pi');
	assert.equal(oui.lookup('b827eb'), 'Raspberry Pi');
	assert.equal(oui.lookup('00:17:88'), 'Signify (Hue)');
	assert.equal(oui.lookup('00:00:5E'), null);
	assert.equal(oui.lookup(''), null);
	assert.equal(oui.lookup(null), null);
	assert.ok(oui.size() >= 300, 'a few hundred prefixes');
});

test('wpsName: from a hostapd signature, underscores become spaces', () => {
	assert.equal(names.wpsName('wifi4|probe:0,1,50,wps:Office_Jet_Pro_9|assoc:0,1'), 'Office Jet Pro 9');
	assert.equal(names.wpsName('wifi4|probe:0,1,221(0050f2,4),wps:Living_Room_TV'), 'Living Room TV');
	assert.equal(names.wpsName('wifi4|probe:0,1|assoc:0,1'), null);
	assert.equal(names.wpsName('wps:___'), null);
	assert.equal(names.wpsName(null), null);
	/* hostile: bidi override is neutralised, never passed through */
	assert.ok(!/\u202e/.test(names.wpsName('wps:abc\u202egnp.exe')));
});

test('cleanHostname: strips local suffixes, rejects addresses', () => {
	assert.equal(names.cleanHostname('laptop.lan.'), 'laptop');
	assert.equal(names.cleanHostname('tv.home.arpa'), 'tv');
	assert.equal(names.cleanHostname('printer.example.org'), 'printer.example.org');
	assert.equal(names.cleanHostname('192.0.2.5'), null);
	assert.equal(names.cleanHostname('2001:db8::1'), null);
	assert.equal(names.cleanHostname(''), null);
});

test('validateAlias: trims, collapses, limits, rejects control characters', () => {
	assert.deepEqual(names.validateAlias('  Hall   printer '), { ok: true, value: 'Hall printer' });
	assert.deepEqual(names.validateAlias(''), { ok: true, value: '' });
	assert.equal(names.validateAlias('x'.repeat(48)).ok, true);
	assert.equal(names.validateAlias('x'.repeat(49)).ok, false);
	assert.equal(names.validateAlias('evil\u202etxt').ok, false);
	assert.equal(names.validateAlias('a\u0000b').ok, false, 'control characters are rejected');
});

test('aliasMap: sections past ALIAS_MAX are ignored', () => {
	assert.equal(names.ALIAS_MAX, 512);
	const many = [];
	for (let i = 0; i < 600; i++)
		many.push({ '.type': 'client', '.name': 'cfg' + i, mac: '02:00:5e:00:' + ('0' + (i >> 8).toString(16)).slice(-2) + ':' + ('0' + (i & 255).toString(16)).slice(-2), name: 'n' + i });
	assert.equal(Object.keys(names.aliasMap(many)).length, 512);
});

test('aliasMap: client sections only, valid MAC and name, first wins', () => {
	const m = names.aliasMap([
		{ '.type': 'client', '.name': 'cfg1', mac: '00-00-5E-00-53-10', name: 'Desk', icon: 'desktop' },
		{ '.type': 'client', '.name': 'cfg2', mac: MAC, name: 'Dup' },
		{ '.type': 'client', '.name': 'cfg3', mac: 'bad', name: 'Bad' },
		{ '.type': 'client', '.name': 'cfg4', mac: PMAC, name: '   ' },
		{ '.type': 'client', '.name': 'cfg5', mac: '00:00:5E:00:53:12', name: 'Pad', icon: 'rocket' },
		{ '.type': 'main', '.name': 'main' }
	]);
	assert.deepEqual(Object.keys(m).sort(), [ '00:00:5e:00:53:10', '00:00:5e:00:53:12' ]);
	assert.deepEqual(m['00:00:5e:00:53:10'], { sid: 'cfg1', name: 'Desk', icon: 'desktop' });
	assert.equal(m['00:00:5e:00:53:12'].icon, null, 'unknown icon names are dropped');
});

test('mdnsMap: host -> address map', () => {
	const m = names.mdnsMap({ 'kitchen-speaker.local': { ipv4: '192.0.2.20', ipv6: [ '2001:db8::20' ] }, 'bad': 'x' });
	assert.equal(m['192.0.2.20'], 'kitchen-speaker');
	assert.equal(m['2001:db8::20'], 'kitchen-speaker');
});

test('mdnsMap: an address claimed by two different names is dropped, whatever the order', () => {
	/* umdns returns hosts in name order; an attacker picks a name that sorts first */
	const hosts = {
		'Aaa-Attacker.local': { ipv4: '192.0.2.50' },
		'victim-real.local': { ipv4: '192.0.2.50', ipv6: '2001:db8::50' },
		'other.local': { ipv4: '192.0.2.51' }
	};
	const m = names.mdnsMap(hosts);
	assert.equal(m['192.0.2.50'], undefined);
	assert.equal(m['2001:db8::50'], 'victim-real', 'the uncontested address still counts');
	assert.equal(m['192.0.2.51'], 'other');
	/* a third claim does not bring the address back */
	assert.equal(names.mdnsMap(Object.assign({ 'zzz.local': { ipv4: '192.0.2.50' } }, hosts))['192.0.2.50'], undefined);
	/* the same name twice (IPv4 list) is not a conflict */
	assert.equal(names.mdnsMap({ 'tv.local': { ipv4: [ '192.0.2.60', '192.0.2.60' ] } })['192.0.2.60'], 'tv');
	assert.equal(Object.getPrototypeOf(names.mdnsMap({ '__proto__.local': { ipv4: '192.0.2.70' } })), null);
});

test('mdnsForStations: shared addresses and names that land on two stations name nobody', () => {
	const map = { '192.0.2.10': 'phone', '192.0.2.11': 'phone', '192.0.2.12': 'tv', '192.0.2.13': 'shared', '192.0.2.14': 'laptop', '2001:db8::14': 'laptop' };
	const out = names.mdnsForStations(map, [
		{ mac: '00:00:5e:00:53:10', ips: [ '192.0.2.10' ] },
		{ mac: '00:00:5e:00:53:11', ips: [ '192.0.2.11' ] },          /* same name, second station */
		{ mac: '00:00:5e:00:53:12', ips: [ '192.0.2.12', '192.0.2.13' ] },
		{ mac: '00:00:5e:00:53:13', ips: [ '192.0.2.13' ] },          /* address on two stations */
		{ mac: '00:00:5e:00:53:14', ips: [ '192.0.2.14', '2001:db8::14' ] }
	]);
	assert.deepEqual(Object.assign({}, out), { '192.0.2.12': 'tv', '192.0.2.14': 'laptop', '2001:db8::14': 'laptop' });
	assert.deepEqual(Object.assign({}, names.mdnsForStations(null, [])), {});
});

const ALL = {
	mac: MAC,
	alias: { name: 'My Laptop', icon: 'laptop' },
	ips: [ '192.0.2.44' ],
	rdns: { '192.0.2.44': 'laptop-dns.lan' },
	mdns: { '192.0.2.44': 'laptop-mdns.local' },
	hint: { name: 'laptop-dhcp' },
	wps: 'Laptop WPS',
	vendor: 'Example Vendor'
};

test('resolve: fixed order alias > dns > dhcp > mdns > wps > vendor', () => {
	/* DHCP hints are keyed by the station's own MAC; mDNS answers come from
	   anyone on the LAN, so they rank below */
	const order = [];
	const s = Object.assign({}, ALL);
	const steps = [ [ 'alias', 'My Laptop' ], [ 'dns', 'laptop-dns' ], [ 'dhcp', 'laptop-dhcp' ], [ 'mdns', 'laptop-mdns' ], [ 'wps', 'Laptop WPS' ], [ 'vendor', 'Example Vendor device · …00:53:10' ], [ 'mac', 'Device · …00:53:10' ] ];
	const drop = [ 'alias', 'rdns', 'hint', 'mdns', 'wps', 'vendor' ];
	for (let i = 0; i < steps.length; i++) {
		const r = names.resolve(s);
		assert.deepEqual([ r.source, r.name ], steps[i]);
		order.push(r.source);
		if (drop[i]) delete s[drop[i]];
	}
	assert.deepEqual(order, [ 'alias', 'dns', 'dhcp', 'mdns', 'wps', 'vendor', 'mac' ]);
});

test('resolve: private MAC says so instead of a vendor, never "?"', () => {
	const r = names.resolve({ mac: PMAC, vendor: 'Should Not Show' });
	assert.equal(r.source, 'private');
	assert.equal(r.name, 'Private device · …00:53:11');
	assert.equal(r.isPrivate, true);
	assert.equal(r.secondary, '02:00:5E:00:53:11');
	for (const junk of [ {}, { mac: 'nonsense' }, { mac: null } ]) {
		const j = names.resolve(junk);
		assert.ok(j.name && !/\?/.test(j.name));
	}
});

test('resolve: address is the secondary line, icon from alias or guessed', () => {
	const r = names.resolve({ mac: MAC, ips: [ '192.0.2.44' ], wps: 'ENVY Photo 7100' });
	assert.equal(r.secondary, '192.0.2.44');
	assert.equal(r.icon, 'printer');
	assert.equal(names.resolve(ALL).icon, 'laptop');
	/* an invalid alias is ignored, not shown */
	assert.equal(names.resolve({ mac: MAC, alias: { name: 'x\u202e' }, wps: 'Fallback' }).source, 'wps');
	/* rdns entries for addresses the station does not have do not apply */
	assert.equal(names.resolve({ mac: MAC, ips: [ '192.0.2.1' ], rdns: { '192.0.2.44': 'other' } }).source, 'mac');
});
