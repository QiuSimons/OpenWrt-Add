'use strict';
/* luci-app-vantage-aps' ucode: the shared checks (vantage.aps), the
   pairing plugin (luci.vantage-pair) in a sandbox of its own files, and
   the access point's report against a fake sysfs and ubus. Runs under a
   host ucode binary ($UCODE, else `ucode` on PATH; skipped otherwise),
   with the doubles in tests/ucode/aps-stubs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mkTmp = require('./tmpdir');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'luci-app-vantage-aps/root');
const MODULES = path.join(PKG, 'usr/share/ucode');
const PLUGIN = path.join(PKG, 'usr/share/rpcd/ucode/luci.vantage-pair');
const REPORT = path.join(PKG, 'usr/libexec/vantage/report');
const STUBS = path.join(__dirname, 'ucode/aps-stubs');
const HARNESS = path.join(__dirname, 'ucode/aps-harness.uc');

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
	const args = [ '-L', STUBS, '-L', MODULES ];
	const lib = UCODE && path.join(path.dirname(UCODE), '../lib/ucode');
	if (lib && fs.existsSync(lib)) args.push('-L', lib);
	return args;
}

/* an Ed25519 public key blob in base64, its 32 key bytes all `fill` */
const blob = fill => Buffer.concat([ Buffer.from([ 0, 0, 0, 11 ]), Buffer.from('ssh-ed25519'), Buffer.from([ 0, 0, 0, 32 ]), Buffer.alloc(32, fill) ]);
const key = fill => blob(fill).toString('base64');
/* dropbear's key file for it: string "ssh-ed25519", 32 private bytes, the 32 public ones */
const keyFile = fill => Buffer.concat([ Buffer.from([ 0, 0, 0, 11 ]), Buffer.from('ssh-ed25519'), Buffer.from([ 0, 0, 0, 64 ]), Buffer.alloc(32, 0xee), Buffer.alloc(32, fill) ]);

const K1 = key(1), K2 = key(2), K3 = key(3);
const routerCode = (k, n) => [ 'vantage-router', '1', 'ssh-ed25519', k, n ].join(' ');
const AP_MAC = '00:00:5e:00:53:a1';
const apCode = (k, a, p, n, m) => [ 'vantage-ap', '1', 'ssh-ed25519', k, a, String(p), m || AP_MAC, n ].join(' ');

/* ------------------------------------------------------------ module */

function runModule(cases) {
	const dir = mkTmp('vantage-aps-');
	const file = path.join(dir, 'cases.json');
	fs.writeFileSync(file, JSON.stringify(cases));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'MODE=module', '-D', 'CASES=' + file, HARNESS ]), { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout);
}

test('vantage.aps: keys are exactly an Ed25519 blob', { skip: NO_UCODE }, () => {
	const bad19 = 'AAAAC3NzaC1lZDI1NTE5AAAAIQ' + K1.slice(26);
	const rsa = Buffer.concat([ Buffer.from([ 0, 0, 0, 7 ]), Buffer.from('ssh-rsa'), Buffer.alloc(40, 1) ]).toString('base64');
	const cases = [ K1, K1 + '=', K1.slice(0, -1), bad19, rsa, K1 + ' ', ' ' + K1, K1.replace(/.$/, '!'), 12, null, '' ];
	const r = runModule(cases.map(v => [ 'key', v ]));
	assert.deepEqual(r, [ K1, null, null, null, null, null, null, null, null, null, null ]);
});

test('vantage.aps: names, addresses, ports', { skip: NO_UCODE }, () => {
	const names = [ 'ap-hall', 'AP.2_x', 'a', 'x'.repeat(63), 'x'.repeat(64), '-ap', '.ap', 'ap hall', 'ap\nhall', 'ap;rm', '', 7 ];
	assert.deepEqual(runModule(names.map(v => [ 'name', v ])), [ 'ap-hall', 'AP.2_x', 'a', 'x'.repeat(63), null, null, null, null, null, null, null, null ]);
	const addrs = [
		[ '192.0.2.10', '192.0.2.10' ], [ '198.51.100.255', '198.51.100.255' ], [ '0.1.2.3', null ], [ '127.0.0.1', null ],
		[ '224.0.0.1', null ], [ '255.255.255.255', null ], [ '192.0.2.256', null ], [ '192.0.2.01', null ], [ '192.0.2', null ],
		[ ' 192.0.2.1', null ], [ '2001:db8::1', '2001:db8::1' ], [ '2001:DB8::A', '2001:db8::a' ], [ '2001:db8:0:0:0:0:0:1', '2001:db8:0:0:0:0:0:1' ],
		[ 'fe80::1', null ], [ 'ff02::1', null ], [ '::1', null ], [ '::', null ], [ '2001:db8::1::2', null ], [ '2001:db8:::1', null ],
		[ '1:2:3:4:5:6:7:8:9', null ], [ '[2001:db8::1]', null ], [ '2001:db8::1%br-lan', null ], [ 'router.lan', null ], [ 5, null ]
	];
	assert.deepEqual(runModule(addrs.map(a => [ 'addr', a[0] ])), addrs.map(a => a[1]));
	const ports = [ [ 22, 22 ], [ '22', 22 ], [ 65535, 65535 ], [ 0, null ], [ 65536, null ], [ '2a', null ], [ -1, null ], [ 22.5, null ] ];
	assert.deepEqual(runModule(ports.map(p => [ 'port', p[0] ])), ports.map(p => p[1]));
	assert.deepEqual(runModule([ [ 'name_of', 'My Router!', 'router' ], [ 'name_of', '---', 'router' ], [ 'name_of', null, 'access-point' ], [ 'name_of', 'x'.repeat(80), 'r' ] ]),
		[ 'My-Router-', 'router', 'access-point', 'x'.repeat(63) ]);
});

test('vantage.aps: codes parse only in their exact form', { skip: NO_UCODE }, () => {
	const ok = routerCode(K1, 'gw');
	const r = runModule([
		[ 'parse_router', ok ], [ 'parse_router', '  ' + ok + '\r\n' ], [ 'parse_router', ok.replace(/ /g, '\t') ],
		[ 'parse_router', ok + ' extra' ], [ 'parse_router', ok.replace('vantage-router 1', 'vantage-router 2') ],
		[ 'parse_router', ok.replace('ssh-ed25519', 'ssh-rsa') ], [ 'parse_router', routerCode(K1, 'g w') ],
		[ 'parse_router', routerCode(K1, 'gw\ncommand="sh"') ], [ 'parse_router', routerCode(K1, 'gw') + ' '.repeat(600) + 'x' ],
		[ 'parse_router', apCode(K1, '192.0.2.10', 22, 'ap') ], [ 'parse_router', null ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap-hall') ], [ 'parse_ap', apCode(K2, '2001:DB8::10', '2222', 'ap') ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 0, 'ap') ], [ 'parse_ap', apCode(K2, 'fe80::1', 22, 'ap') ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap') + ' x' ], [ 'parse_ap', ok ],
		[ 'router_code', K1, 'gw' ], [ 'ap_code', K2, '192.0.2.10', 22, AP_MAC, 'ap' ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '00:00:5E:00:53:A1') ], [ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '01:00:5e:00:53:a1') ],
		[ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '00:00:00:00:00:00') ], [ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap', '00-00-5e-00-53-a1') ],
		[ 'parse_ap', [ 'vantage-ap', '1', 'ssh-ed25519', K2, '192.0.2.10', '22', 'ap' ].join(' ') ]
	]);
	assert.deepEqual(r.slice(0, 3), [ { key: K1, name: 'gw' }, { key: K1, name: 'gw' }, { key: K1, name: 'gw' } ]);
	assert.deepEqual(r.slice(3, 11), [ null, null, null, null, null, null, null, null ]);
	assert.deepEqual(r.slice(11, 17), [ { key: K2, addr: '192.0.2.10', port: 22, mac: AP_MAC, name: 'ap-hall' }, { key: K2, addr: '2001:db8::10', port: 2222, mac: AP_MAC, name: 'ap' }, null, null, null, null ]);
	assert.deepEqual(r.slice(17, 19), [ ok, apCode(K2, '192.0.2.10', 22, 'ap') ]);
	/* the MAC: lower-cased; multicast, all zeros, dashes or none: no reply */
	assert.deepEqual(r.slice(19), [ { key: K2, addr: '192.0.2.10', port: 22, mac: AP_MAC, name: 'ap' }, null, null, null, null ]);
});

test('vantage.aps: the paired list keeps valid entries once, at most 16', { skip: NO_UCODE }, () => {
	const e = (i, k) => ({ id: i.toString(16).padStart(16, '0'), name: 'ap' + i, key: k, addr: '192.0.2.' + (i + 1), port: 22, mac: AP_MAC });
	const many = Array.from({ length: 20 }, (_, i) => e(i, key(10 + i)));
	const r = runModule([
		[ 'aps', JSON.stringify([ e(1, K1), e(1, K2), e(2, K1), Object.assign(e(3, K3), { addr: '127.0.0.1' }), Object.assign(e(4, key(4)), { port: '22' }), Object.assign(e(5, key(5)), { mac: null }), 'x', null ]) ],
		[ 'aps', JSON.stringify(many) ], [ 'aps', 'not json' ], [ 'aps', '{"id":1}' ], [ 'aps', null ]
	]);
	assert.deepEqual(r[0], [ e(1, K1), Object.assign(e(4, key(4)), { port: 22 }) ]);
	assert.equal(r[1].length, 16);
	assert.deepEqual(r.slice(2), [ [], [], [] ]);
});

test('vantage.aps find_addrs: where a MAC is now, from the neighbour table and the leases', { skip: NO_UCODE }, () => {
	const arp = 'IP address       HW type     Flags       HW address            Mask     Device\n' +
		'192.0.2.40       0x1         0x2         00:00:5E:00:53:A1     *        br-lan\n' +
		'192.0.2.41       0x1         0x0         00:00:5e:00:53:a1     *        br-lan\n' +
		'192.0.2.42       0x1         0x2         00:00:5e:00:53:a2     *        br-lan\n' +
		'127.0.0.1        0x1         0x2         00:00:5e:00:53:a1     *        lo\n';
	const leases = '1700000000 00:00:5e:00:53:a1 192.0.2.43 ap-hall *\n1700000000 00:00:5e:00:53:a1 192.0.2.40 ap-hall *\n' +
		'1700000000 00:00:5e:00:53:a3 192.0.2.44 other *\n1700000000 00:00:5e:00:53:a1 2001:db8::5 ap-hall *\ngarbage\n';
	const r = runModule([ [ 'find_addrs', AP_MAC, arp, leases, LAN_NET ], [ 'find_addrs', '00:00:5E:00:53:A1', arp, null, LAN_NET ], [ 'find_addrs', null, arp, leases, LAN_NET ],
		[ 'find_addrs', '01:00:5e:00:53:a1', arp, leases, LAN_NET ], [ 'find_addrs', AP_MAC, null, null, LAN_NET ] ]);
	assert.deepEqual(r, [ [ '192.0.2.43', '192.0.2.40' ], [ '192.0.2.40' ], [], [], [] ], 'what dnsmasq leased it first, then the neighbour table');
});

/* this router's LAN as ubus network.interface dump gives it, and as network_of() hands it on */
const LAN_IF = { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ],
	'ipv6-address': [], 'ipv6-prefix-assignment': [ { address: '2001:db8:1::', mask: 64, 'local-address': { address: '2001:db8:1::1', mask: 64 } } ] };
const WAN_IF = { interface: 'wan', up: true, l3_device: 'eth1', 'ipv4-address': [ { address: '203.0.113.2', mask: 29 } ], 'ipv6-address': [ { address: '2001:db8:ffff::2', mask: 64 } ] };
const GUEST_IF = { interface: 'guest', up: true, l3_device: 'br-guest', 'ipv4-address': [ { address: '198.51.100.1', mask: 25 } ] };
const LAN_NET = { dev: 'br-lan', nets: [ [ [ 192, 0, 2, 1 ], 24 ] ] };
const DUMP = { interface: [ { interface: 'loopback', up: true, l3_device: 'lo', 'ipv4-address': [ { address: '127.0.0.1', mask: 8 } ] }, WAN_IF, LAN_IF, GUEST_IF ] };

test('vantage.aps: an access point is looked for on the network it was paired on only', { skip: NO_UCODE }, () => {
	const N = a => [ 'network_of', a, DUMP.interface ];
	const nets = runModule([ N('192.0.2.10'), N('192.0.2.255'), N('198.51.100.10'), N('198.51.100.200'), N('203.0.113.6'), N('203.0.113.9'), N('2001:db8:1::10'), N('2001:DB8:1:0::10'),
		N('2001:db8:ffff::9'), N('2001:db8:2::10'), N('198.51.100.129'), N(null), N('x'), [ 'network_of', '192.0.2.10', null ],
		[ 'network_of', '192.0.2.10', [ Object.assign({}, LAN_IF, { up: false }) ] ], [ 'network_of', '192.0.2.10', [ Object.assign({}, LAN_IF, { l3_device: '../x' }) ] ],
		[ 'network_of', '192.0.2.10', [ { interface: 'lan', up: true, l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.1', mask: 0 } ] }, null, 7 ] ] ]);
	assert.deepEqual(nets.map(n => n && n.dev), [ 'br-lan', 'br-lan', 'br-guest', null, 'eth1', null, 'br-lan', 'br-lan', 'eth1', null, null, null, null, null, null, null, null ]);
	assert.deepEqual(nets[0], LAN_NET);
	/* a wider subnet around a network's own on another interface (an uplink whose DHCP hands out a wide one) that netifd lists first: the narrowest one that holds the address */
	const wide = { interface: 'internet', up: true, l3_device: 'eth1', 'ipv4-address': [ { address: '198.51.100.2', mask: 24 } ] };
	assert.deepEqual(runModule([ [ 'network_of', '198.51.100.10', [ wide, GUEST_IF ] ], [ 'network_of', '198.51.100.10', [ GUEST_IF, wide ] ], [ 'network_of', '198.51.100.200', [ wide, GUEST_IF ] ] ]).map(n => n && n.dev),
		[ 'br-guest', 'br-guest', 'eth1' ]);
	assert.deepEqual(nets[6], LAN_NET, 'paired by an IPv6 address: that network\'s IPv4 subnets');
	/* the neighbour table takes a row under any MAC and address from any device of a network: rows of other
	   networks, rows outside the network's subnets and leases outside them are not followed */
	const row = (ip, dev) => ip + ' 0x1 0x2 ' + AP_MAC + ' * ' + dev + '\n';
	const arp = 'IP address HW type Flags HW address Mask Device\n' + row('203.0.113.5', 'eth1') + row('198.51.100.9', 'br-guest') + row('192.0.2.50', 'br-guest') + row('192.0.2.51', 'eth1') +
		row('198.51.100.10', 'br-lan') + row('203.0.113.77', 'br-lan') + row('192.0.2.60', 'br-lan') + row('192.0.2.61', 'br-lan.10');
	const leases = '1 ' + AP_MAC + ' 198.51.100.20 x *\n1 ' + AP_MAC + ' 192.0.2.70 x *\n';
	assert.deepEqual(runModule([ [ 'find_addrs', AP_MAC, arp, leases, LAN_NET ], [ 'find_addrs', AP_MAC, arp, leases, null ], [ 'find_addrs', AP_MAC, arp, leases, { dev: 'br-lan', nets: [] } ],
		[ 'find_addrs', AP_MAC, arp, leases, { dev: 'eth1', nets: [ [ [ 203, 0, 113, 2 ], 29 ] ] } ], [ 'find_addrs', AP_MAC, arp, leases, { dev: '../x', nets: LAN_NET.nets } ] ]),
		[ [ '192.0.2.70', '192.0.2.60' ], [], [], [ '203.0.113.5' ], [] ]);
	/* four rows of other networks no longer push the real one out of the four that are tried */
	const planted = 'h\n' + [ 1, 2, 3, 4 ].map(i => row('198.51.100.' + i, 'br-guest')).join('') + row('192.0.2.90', 'br-lan');
	assert.deepEqual(runModule([ [ 'find_addrs', AP_MAC, planted, '', LAN_NET ], [ 'next_addr', AP_MAC, '192.0.2.10', {}, planted, '', LAN_NET ] ]), [ [ '192.0.2.90' ], '192.0.2.90' ]);
	/* at most four, of the right network too */
	assert.equal(runModule([ [ 'find_addrs', AP_MAC, 'h\n' + [ 1, 2, 3, 4, 5, 6 ].map(i => row('192.0.2.' + (100 + i), 'br-lan')).join(''), '', LAN_NET ] ])[0].length, 4);
});

/* the LAN after its subnet was changed: the same network, by name and device, with another subnet */
const LAN_MOVED = Object.assign({}, LAN_IF, { 'ipv4-address': [ { address: '198.51.100.1', mask: 24 } ] });
const MOVED_NET = { dev: 'br-lan', nets: [ [ [ 198, 51, 100, 1 ], 24 ] ] };

test('vantage.aps: a network\'s name is a uci section\'s; the paired list takes an entry with one, without one, and none with a name that is no name', { skip: NO_UCODE }, () => {
	const names = [ [ 'lan', 'lan' ], [ 'LAN_2', 'LAN_2' ], [ 'a', 'a' ], [ '_', '_' ], [ 'x'.repeat(64), 'x'.repeat(64) ], [ 'x'.repeat(65), null ], [ '', null ], [ 'br-lan', null ], [ 'lan.1', null ],
		[ 'lan guest', null ], [ 'lan\n', null ], [ ' lan', null ], [ 'lan\u0000x', null ], [ '../x', null ], [ 'län', null ], [ 7, null ], [ null, null ], [ [ 'lan' ], null ], [ { lan: 1 }, null ], [ true, null ] ];
	assert.deepEqual(runModule(names.map(n => [ 'net', n[0] ])), names.map(n => n[1]));
	const e = (i, k, extra) => Object.assign({ id: i.toString(16).padStart(16, '0'), name: 'ap' + i, key: k, addr: '192.0.2.' + (i + 1), port: 22, mac: AP_MAC }, extra);
	const withNet = e(1, K1, { net: 'lan' }), old = e(2, K2), guest = e(3, K3, { net: 'guest_2' });
	const good = JSON.stringify([ withNet, old, guest ]);
	const r = runModule([ [ 'aps', good ], [ 'aps', good, true ] ]);
	/* the name kept where there is one; no net at all on an entry without (written back, such an entry is as it was) */
	assert.deepEqual(r, [ [ withNet, old, guest ], [ withNet, old, guest ] ]);
	assert.deepEqual(r[0].map(a => 'net' in a), [ true, false, true ]);
	/* a net that is no name: no entry, as with any other field. The collector passes it over; the one who writes the list back gets none */
	for (const bad of [ '', 'br-lan', 'lan.1', 'lan ', 'x'.repeat(65), 'lan\u0000x', 5, null, true, [ 'lan' ], { name: 'lan' } ]) {
		const text = JSON.stringify([ withNet, e(4, key(4), { net: bad }), old ]);
		assert.deepEqual(runModule([ [ 'aps', text ], [ 'aps', text, true ] ]), [ [ withNet, old ], null ], JSON.stringify(bad));
	}
	/* a field of some later version is passed over, as before; it is not the network */
	assert.deepEqual(runModule([ [ 'aps', JSON.stringify([ Object.assign({ network: 'guest', Net: 'guest' }, old) ]), true ] ]), [ [ old ] ]);
});

test('vantage.aps: the network of a pairing by name, the one its address is on then; by that name it is known again whatever its subnet is now', { skip: NO_UCODE }, () => {
	/* net_of: the name of the very interface network_of() finds */
	const addrs = [ '192.0.2.10', '192.0.2.255', '198.51.100.10', '198.51.100.200', '203.0.113.6', '203.0.113.9', '2001:db8:1::10', '2001:DB8:1:0::10', '2001:db8:ffff::9', '2001:db8:2::10', null, 'x' ];
	const got = runModule(addrs.flatMap(a => [ [ 'net_of', a, DUMP.interface ], [ 'network_of', a, DUMP.interface ] ]));
	assert.deepEqual(addrs.map((a, i) => got[2 * i]), [ 'lan', 'lan', 'guest', null, 'wan', null, 'lan', 'lan', 'wan', null, null, null ]);
	const dev = { lan: 'br-lan', guest: 'br-guest', wan: 'eth1' };
	addrs.forEach((a, i) => assert.equal(got[2 * i + 1] ? got[2 * i + 1].dev : null, got[2 * i] ? dev[got[2 * i]] : null, a + ': one rule for both'));
	const wide = { interface: 'internet', up: true, l3_device: 'eth1', 'ipv4-address': [ { address: '198.51.100.2', mask: 24 } ] };
	assert.deepEqual(runModule([ [ 'net_of', '198.51.100.10', [ wide, GUEST_IF ] ], [ 'net_of', '198.51.100.10', [ GUEST_IF, wide ] ], [ 'net_of', '198.51.100.200', [ wide, GUEST_IF ] ] ]),
		[ 'guest', 'guest', 'internet' ], 'the narrowest subnet that holds it');
	/* no name to keep: the interface down or without a device, netifd silent, or a name that is none (what netifd was handed by another program) */
	const named = n => [ Object.assign({}, LAN_IF, { interface: n }) ];
	assert.deepEqual(runModule([ [ 'net_of', '192.0.2.10', [ Object.assign({}, LAN_IF, { up: false }) ] ], [ 'net_of', '192.0.2.10', [ Object.assign({}, LAN_IF, { l3_device: '../x' }) ] ],
		[ 'net_of', '192.0.2.10', null ], [ 'net_of', '192.0.2.10', named('my-lan') ], [ 'net_of', '192.0.2.10', named('x'.repeat(65)) ], [ 'net_of', '192.0.2.10', named(7) ],
		[ 'net_of', '192.0.2.10', named(undefined) ], [ 'net_of', '192.0.2.10', named('lan\u0000') ], [ 'network_of', '192.0.2.10', named('my-lan') ] ]),
		[ null, null, null, null, null, null, null, null, LAN_NET ]);

	/* network_named: that interface now, its device and the subnets it has now */
	const N = (n, ifaces) => [ 'network_named', n, ifaces ];
	const moved = [ WAN_IF, LAN_MOVED, { interface: 'guest', up: true, l3_device: 'br-guest', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ] } ];
	const bare = Object.assign({}, LAN_IF, { 'ipv4-address': [] });
	const r = runModule([ N('lan', DUMP.interface), N('guest', DUMP.interface), N('lan', moved), N('guest', moved),
		/* gone (renamed or removed), down, without a device: nowhere */
		N('lan', [ WAN_IF, GUEST_IF ]), N('lan', [ Object.assign({}, LAN_IF, { interface: 'home' }) ]), N('lan', [ Object.assign({}, LAN_IF, { up: false }) ]),
		N('lan', [ Object.assign({}, LAN_IF, { up: 1 }) ]), N('lan', [ Object.assign({}, LAN_IF, { l3_device: '../x' }) ]), N('lan', [ Object.assign({}, LAN_IF, { l3_device: null }) ]),
		N('lan', null), N('lan', {}), N('lan', [ null, 7, 'lan', [ LAN_IF ] ]),
		/* the name itself, whole: no other spelling, no part of one, nothing that is no name */
		N('LAN', DUMP.interface), N('lan6', DUMP.interface), N('la', DUMP.interface), N('lan\u0000', DUMP.interface), N('', DUMP.interface), N(null, DUMP.interface), N(7, DUMP.interface),
		N('br-lan', [ Object.assign({}, LAN_IF, { interface: 'br-lan' }) ]), N([ 'lan' ], DUMP.interface),
		/* up, and without an IPv4 subnet for now: the network, with nowhere in it to look */
		N('lan', [ bare ]),
		/* the first of that name is the one, as it is (netifd lists a name once) */
		N('lan', [ Object.assign({}, LAN_IF, { up: false }), LAN_MOVED ]) ]);
	assert.deepEqual(r.slice(0, 4), [ LAN_NET, { dev: 'br-guest', nets: [ [ [ 198, 51, 100, 1 ], 25 ] ] }, MOVED_NET, { dev: 'br-guest', nets: [ [ [ 192, 0, 2, 1 ], 24 ] ] } ]);
	assert.deepEqual(r.slice(4, 13), Array(9).fill(null), 'gone, down or without a device');
	assert.deepEqual(r.slice(13, 22), Array(9).fill(null), 'the name whole, and only a name');
	assert.deepEqual(r.slice(22), [ { dev: 'br-lan', nets: [] }, null ]);

	/* the search there: what its MAC has now inside the network's new subnet, on its device. The subnet it was paired in is another
	   network's by now (the guests'): rows and leases there are not followed, nor is the address it was paired at */
	const row = (ip, dev) => ip + ' 0x1 0x2 ' + AP_MAC + ' * ' + dev + '\n';
	const arp = 'IP address HW type Flags HW address Mask Device\n' + row('192.0.2.60', 'br-guest') + row('192.0.2.61', 'br-lan') + row('198.51.100.60', 'br-guest') + row('198.51.100.61', 'br-lan') + row('203.0.113.5', 'eth1');
	const leases = '1 ' + AP_MAC + ' 192.0.2.70 x *\n1 ' + AP_MAC + ' 198.51.100.70 x *\n';
	assert.deepEqual(runModule([ [ 'find_addrs', AP_MAC, arp, leases, MOVED_NET ], [ 'next_addr', AP_MAC, '192.0.2.10', {}, arp, leases, MOVED_NET ],
		[ 'next_addr', AP_MAC, '192.0.2.10', { '198.51.100.70': true }, arp, leases, MOVED_NET ], [ 'next_addr', AP_MAC, '192.0.2.10', { '198.51.100.70': true, '198.51.100.61': true }, arp, leases, MOVED_NET ],
		[ 'find_addrs', AP_MAC, arp, leases, { dev: 'br-lan', nets: [] } ], [ 'find_addrs', AP_MAC, arp, leases, null ] ]),
		[ [ '198.51.100.70', '198.51.100.61' ], '198.51.100.70', '198.51.100.61', null, [], [] ]);
	/* at most four there too, counted after those already tried */
	const many = 'h\n' + [ 1, 2, 3, 4, 5, 6 ].map(i => row('198.51.100.' + (100 + i), 'br-lan')).join('');
	assert.deepEqual(runModule([ [ 'find_addrs', AP_MAC, many, '', MOVED_NET ], [ 'find_addrs', AP_MAC, many, '', MOVED_NET, { '198.51.100.101': true, '198.51.100.102': true, '198.51.100.103': true } ] ]),
		[ [ 101, 102, 103, 104 ].map(n => '198.51.100.' + n), [ 104, 105, 106 ].map(n => '198.51.100.' + n) ]);
});

test('vantage.aps: no NUL byte passes a check; loopback, link-local and IPv4-mapped addresses however spelled do not either', { skip: NO_UCODE }, () => {
	/* ucode matches a regular expression against the bytes before a NUL only */
	const nul = runModule([ [ 'name', 'ap\u0000evil' ], [ 'mac', AP_MAC + '\u0000x' ], [ 'addr', '192.0.2.1\u0000x' ], [ 'key', K1 + '\u0000' ], [ 'id', '0123456789abcdef\u0000' ], [ 'port', '22\u0000' ],
		[ 'parse_router', routerCode(K1, 'gw\u0000 x') ], [ 'parse_ap', apCode(K2, '192.0.2.10', 22, 'ap') + '\u0000' ],
		[ 'normalize', { v: 1, ssids: [ { ifname: 'w0' }, { ifname: 'w0\u0000b' } ], stations: [ { mac: MAC_(1), ifname: 'w0' }, { mac: MAC_(1) + '\u0000x', ifname: 'w0' }, { mac: MAC_(2), ifname: 'w0\u0000' }, { mac: MAC_(3), ifname: 7 }, { mac: MAC_(4), ifname: true } ] } ] ]);
	assert.deepEqual(nul.slice(0, 8), [ null, null, null, null, null, null, null, null ]);
	assert.deepEqual([ nul[8].ssids.map(x => x.ifname), nul[8].stations.map(x => x.mac) ], [ [ 'w0' ], [ MAC_(1) ] ], 'one SSID, one station: no NUL twin, no ifname that is not a string');
	const addrs = [ '0::1', '::0', '0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '::0:1', '::2', '::ffff:c000:201', '::ffff:7f00:1', '64:ff9b::c000:201', [ 169, 254, 1, 1 ].join('.'),
		'192.0.2.1,198.51.100.1', '192.0.2.1;id', '192.0.2.1\n', '-oProxyCommand=x', '192.0.2.1/22', '192.0.2.1^x', 'root@192.0.2.1' ];
	assert.deepEqual(runModule(addrs.map(a => [ 'addr', a ])), addrs.map(() => null));
	assert.deepEqual(runModule([ [ 'addr', '100::1' ], [ 'addr', '2001:db8:0:1::20' ], [ 'addr', '2001:db8::' ] ]), [ '100::1', '2001:db8:0:1::20', '2001:db8::' ]);
});

/* dbclient's own last line, up to its reason */
const DBC = '/usr/bin/dbclient: Connection to root@192.0.2.10:22 exited: ';

test('vantage.aps: how a fetch ended, the state it makes, and where to look next', { skip: NO_UCODE }, () => {
	const E = (code, out, err, timedout) => [ 'fetch_error', code, out, err, !!timedout, 100 ];
	assert.deepEqual(runModule([
		E(0, '{}', ''), E(0, '{}', '', true), E(0, '', ''), E(0, 'x'.repeat(101), ''), E(0, null, ''), E(1, '{}', ''),
		E(1, '', 'dbclient: Connection to root@192.0.2.10:22 exited: Connect failed: Connection refused'), E(1, '', null),
		E(1, '', '\n\nssh-ed25519 host key mismatch for 192.0.2.10 !\nFingerprint is SHA256:x'), E(1, '', "Host '192.0.2.10' key unknown.\n" + DBC + 'Not accepted automatically'),
		E(1, '', DBC + 'No auth methods could be used.'), E(127, '', 'ash: /usr/libexec/vantage/report: not found'), E(126, '', 'ash: /usr/libexec/vantage/report: No such file or directory'),
		E(127, '', 'ash: something-else: not found')
	]), [ null, 'timeout', 'unreachable', 'invalid', 'unreachable', 'invalid', 'unreachable', 'unreachable', 'hostkey', 'hostkey', 'denied', 'missing', 'missing', 'unreachable' ],
		'no bytes on standard output and no word of dbclient\'s or of the access point\'s shell: not its answer');
	/* dbclient's error text as Dropbear 2024.86 and 2025.89 write it (taken from both, on OpenWrt 24.10 and 25.12) */
	assert.deepEqual(runModule([
		E(1, '', '\n' + DBC + 'No auth methods could be used.\n'),
		E(1, '', '/usr/bin/dbclient: Connection to root@2001:db8::10:22 exited: No auth methods could be used.'),
		E(1, '', '\n' + DBC + '\n\nssh-ed25519 host key mismatch for 192.0.2.10 !\nFingerprint is SHA256:x\nExpected SHA256:y\nIf you know that the host key is correct you can\nremove the bad entry from ~/.ssh/known_hosts\n'),
		E(1, '', "/usr/bin/dbclient: \nHost '192.0.2.10' key unknown.\n(ssh-ed25519 fingerprint SHA256:x)\n\n" + DBC + 'Not accepted automatically\n'),
		E(1, '', '\n' + DBC + 'Connect failed: Connection refused\n'),
		E(127, '', 'ash: /usr/libexec/vantage/report: not found\n'), E(126, '', 'ash: /usr/libexec/vantage/report: Permission denied\n')
	]), [ 'denied', 'denied', 'hostkey', 'hostkey', 'unreachable', 'missing', 'missing' ]);
	/* A device that never showed the pinned host key: its version line is quoted in dbclient's error text, it
	   can send a disconnect before any key is checked (dbclient then ends with 0), or just close. None of that
	   is the access point's answer: 'denied', 'missing' and 'invalid' would end the search for the one that moved */
	const liar = [
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-Permission denied'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-No auth methods could be used.'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-/usr/libexec/vantage/report: not found'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-ash: /usr/libexec/vantage/report: not found'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-x: Connection to root@192.0.2.10:22 exited: No auth methods could be used.'\n"),
		E(0, '', '\n' + DBC + 'Disconnect received\n'), E(1, '', '\n' + DBC + 'Remote closed the connection\n'),
		/* and should dbclient ever word its own line otherwise: still nothing of the other end's counts */
		E(1, '', "dbclient: remote version 'SSH-1.5-No auth methods could be used.'"), E(1, '', "dbclient: gone: 'ash: /usr/libexec/vantage/report: not found'"),
		E(0, '', "dbclient: closed: 'SSH-1.5-Disconnect received'"), E(1, '', 'Permission denied'), E(0, '', 'exited: No auth methods could be used.'),
		/* dbclient's words for a host key it does not take, in the version line: not its verdict on a key */
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-OpenSSH host key mismatch'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-ssh-ed25519 host key mismatch for 192.0.2.10 !'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-Not accepted automatically'\n"),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-Didn't validate host key'\n"),
		/* a Dropbear that cuts its message short (2024.86 and older) ends the line with the other end's text and no quote:
		   the first " exited:" of the line is still dbclient's own, and its reason is still the whole of what follows */
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-" + 'x'.repeat(60) + ' exited: No auth methods could be used.\n'),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-" + 'x'.repeat(60) + ' x: Connection to y exited: No auth methods could be used.\n'),
		E(1, '', '\n' + DBC + "Incompatible remote version 'SSH-1.5-" + 'x'.repeat(60) + ' exited: Not accepted automatically\n')
	];
	const said = runModule(liar);
	assert.deepEqual(said, liar.map(() => 'unreachable'));
	assert.deepEqual(runModule(said.map(e => [ 'moved', e ])), liar.map(() => true), 'so the search goes on');
	assert.deepEqual(runModule([ [ 'state', true, 'timeout' ], [ 'state', false, 'timeout' ], [ 'state', false, 'unreachable' ], [ 'state', false, 'hostkey' ], [ 'state', false, 'denied' ],
		[ 'state', false, 'invalid' ], [ 'state', false, 'missing' ], [ 'state', false, null ] ]), [ 'ok', 'offline', 'offline', 'error', 'error', 'error', 'error', 'waiting' ]);
	assert.deepEqual(runModule([ 'unreachable', 'timeout', 'hostkey', 'denied', 'invalid', 'missing', null ].map(e => [ 'moved', e ])), [ true, true, true, false, false, false, false ]);
	const arp = 'h\n192.0.2.40 0x1 0x2 ' + AP_MAC + ' * br-lan\n192.0.2.44 0x1 0x2 ' + AP_MAC + ' * br-lan\n', leases = '1 ' + AP_MAC + ' 192.0.2.43 x *\n';
	assert.deepEqual(runModule([ [ 'next_addr', AP_MAC, '192.0.2.40', {}, arp, leases, LAN_NET ], [ 'next_addr', AP_MAC, '192.0.2.40', { '192.0.2.43': true }, arp, leases, LAN_NET ],
		[ 'next_addr', AP_MAC, '192.0.2.40', { '192.0.2.44': true, '192.0.2.43': true }, arp, leases, LAN_NET ], [ 'next_addr', AP_MAC, '192.0.2.9', null, '', '', LAN_NET ],
		[ 'next_addr', AP_MAC, '192.0.2.40', {}, arp, leases, null ] ]),
		[ '192.0.2.43', '192.0.2.44', null, null, null ]);
	/* four leases under its MAC that are not it (a device of the network asked dnsmasq for them, which writes the newest first)
	   do not keep the real one out: what was tried, and where it is known, is left out before the four are counted */
	const fake = [ 201, 202, 203, 204 ].map(n => '192.0.2.' + n), crowd = fake.map(a => '1 ' + AP_MAC + ' ' + a + ' x *\n').join('') + '1 ' + AP_MAC + ' 192.0.2.77 x *\n';
	const all = Object.fromEntries(fake.map(a => [ a, true ]));
	assert.deepEqual(runModule([ [ 'find_addrs', AP_MAC, '', crowd, LAN_NET ], [ 'find_addrs', AP_MAC, '', crowd, LAN_NET, all ], [ 'next_addr', AP_MAC, '192.0.2.10', {}, '', crowd, LAN_NET ],
		[ 'next_addr', AP_MAC, '192.0.2.10', all, '', crowd, LAN_NET ], [ 'next_addr', AP_MAC, '192.0.2.201', { '192.0.2.202': true }, '', crowd, LAN_NET ],
		[ 'next_addr', AP_MAC, '192.0.2.77', all, '', crowd, LAN_NET ], [ 'next_addr', AP_MAC, null, 'junk', '', crowd, LAN_NET ] ]),
		[ fake, [ '192.0.2.77' ], '192.0.2.201', '192.0.2.77', '192.0.2.203', null, '192.0.2.201' ]);
	/* a lease file is read as text only as a plain file of root's or of the daemon's own account */
	const F = (st, uid) => [ 'own_file', st, uid ];
	assert.deepEqual(runModule([ F({ type: 'file', uid: 0 }, 453), F({ type: 'file', uid: 453 }, 453), F({ type: 'file', uid: 1000 }, 453), F({ type: 'file', uid: 453 }, null), F({ type: 'file', uid: 0 }, null),
		F({ type: 'fifo', uid: 0 }, 0), F({ type: 'link', uid: 0 }, 0), F({ type: 'directory', uid: 0 }, 0), F({ type: 'file' }, 453), F({ type: 'file', uid: '0' }, 453), F(null, 0), F('file', 0) ]),
		[ true, true, false, false, true, false, false, false, false, false, false, false ]);
});

const MAC_ = n => '00:00:5e:00:53:' + n.toString(16).padStart(2, '0');
const MAC = n => '00:00:5e:00:53:' + n.toString(16).padStart(2, '0');

test('vantage.aps normalize: a hostile report keeps only what fits', { skip: NO_UCODE }, () => {
	const sta = (n, ifname, extra) => Object.assign({ mac: MAC(n), ifname, signal: -50, rx_rate: 1000, tx_rate: 2000, rx_bytes: 10, tx_bytes: 20, connected: 30 }, extra || {});
	const report = {
		v: 1, name: 'ap\u0001', model: 'M'.repeat(65), uptime: -5, mac: MAC(1).toUpperCase(),
		ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Café', freq: 5180, channel: 36 }, { ifname: 'phy0-ap0', ssid: 'again' },
			{ ifname: 'bad name' }, { ifname: 'phy1-ap0', ssid: 'x'.repeat(33), freq: 'many' }, 'junk' ],
		stations: [ sta(32, 'phy0-ap0'), sta(32, 'phy0-ap0'), sta(33, 'nowhere'), sta(34, 'phy0-ap0', { signal: 5, rx_rate: 0, rx_bytes: -1, connected: 'x' }),
			{ mac: 'ff:ff:ff:ff:ff:fg', ifname: 'phy0-ap0' }, { mac: '00:00:00:00:00:00', ifname: 'phy0-ap0' } ],
		ports: { lan2: { speed: 1000, rx_bytes: 1, tx_bytes: 2, hosts: 1 }, lan3: { hosts: 0 }, 'x y': { hosts: 1 }, lan4: 'x' },
		wired: [ { mac: MAC(48), port: 'lan2' }, { mac: MAC(48), port: 'lan2' }, { mac: MAC(32), port: 'lan2' }, { mac: MAC(1), port: 'lan2' },
			{ mac: MAC(49), port: 'lan3' }, { mac: MAC(50), port: 'lan9' } ]
	};
	const [ r, wrongV, notObj, big ] = runModule([ [ 'normalize', report ], [ 'normalize', Object.assign({}, report, { v: 2 }) ], [ 'normalize', 'x' ],
		[ 'normalize', { v: 1, ssids: [ { ifname: 'w0' } ], stations: Array.from({ length: 300 }, (_, i) => ({ mac: '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), ifname: 'w0' })),
			wired: Array.from({ length: 200 }, (_, i) => ({ mac: '02:00:5e:01:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), port: 'lan2' })),
			ports: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [ 'p' + i, { hosts: 1 } ]).concat([ [ 'lan2', { hosts: 1 } ] ])) } ]
	]);
	assert.equal(wrongV, null);
	assert.equal(notObj, null);
	assert.deepEqual(r, {
		name: '', model: '', uptime: null, mac: MAC(1),
		ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Café', freq: 5180, channel: 36 }, { ifname: 'phy1-ap0', bssid: null, ssid: '', freq: null, channel: null } ],
		stations: [ sta(32, 'phy0-ap0'), { mac: MAC(34), ifname: 'phy0-ap0', signal: null, rx_rate: null, tx_rate: 2000, rx_bytes: null, tx_bytes: 20, connected: null } ],
		ports: { lan2: { speed: 1000, rx_bytes: 1, tx_bytes: 2, hosts: 1 } },
		wired: [ { mac: MAC(48), port: 'lan2' } ]
	});
	assert.equal(big.stations.length, 256);
	assert.equal(big.wired.length, 0, 'lan2 is not among the first 32 ports, so its hosts go');
	assert.equal(Object.keys(big.ports).length, 32);
});

test('vantage.aps normalize: names and SSIDs are well-formed UTF-8 without controls', { skip: NO_UCODE }, () => {
	const texts = [ 'Café', 'a\tb', 'a\u007fb', 'x'.repeat(32), 'x'.repeat(33), '\u{1F4FA}' ];
	const r = runModule(texts.map(t => [ 'normalize', { v: 1, ssids: [ { ifname: 'w0', ssid: t } ] } ]));
	assert.deepEqual(r.map(x => x.ssids[0].ssid), [ 'Café', '', '', 'x'.repeat(32), '', '\u{1F4FA}' ]);
});

test('vantage.aps view: rates from two reports, none across a reset or on a shared port', { skip: NO_UCODE }, () => {
	const cur = { name: 'ap', model: '', uptime: 1, mac: null, ssids: [ { ifname: 'w0', bssid: null, ssid: 's', freq: 5180, channel: 36 } ],
		stations: [ { mac: MAC(32), ifname: 'w0', signal: -50, rx_rate: 1, tx_rate: 2, rx_bytes: 2000, tx_bytes: 1000, connected: 3 } ],
		ports: { lan2: { speed: 100, rx_bytes: 500, tx_bytes: 600, hosts: 1 }, lan3: { speed: null, rx_bytes: 900, tx_bytes: 900, hosts: 2 } },
		wired: [ { mac: MAC(48), port: 'lan2' }, { mac: MAC(49), port: 'lan3' }, { mac: MAC(50), port: 'lan3' } ] };
	const prev = { stations: [ { mac: MAC(32), rx_bytes: 1000, tx_bytes: 2000 } ], ports: { lan2: { rx_bytes: 0, tx_bytes: 100 }, lan3: { rx_bytes: 0, tx_bytes: 0 } } };
	const [ v, first ] = runModule([ [ 'view', cur, prev, 10 ], [ 'view', cur, null, 0 ] ]);
	assert.deepEqual(v.ssids, [ { ifname: 'w0', bssid: null, ssid: 's', freq: 5180, channel: 36, band: '5g' } ]);
	assert.deepEqual(v.stations, [ { mac: MAC(32), ifname: 'w0', signal: -50, rxRate: 1, txRate: 2, rx: 800, tx: null, connected: 3 } ]);
	assert.deepEqual(v.wired, [ { mac: MAC(48), port: 'lan2', speed: 100, rx: 400, tx: 400 },
		{ mac: MAC(49), port: 'lan3', speed: null, rx: null, tx: null }, { mac: MAC(50), port: 'lan3', speed: null, rx: null, tx: null } ]);
	assert.deepEqual(first.stations[0].rx, null);
	assert.deepEqual(first.wired[0].rx, null);
	/* counters a terabyte apart, or near the top of 64 bits: no rate, and no wrapped number */
	const huge = Object.assign({}, cur, { stations: [ Object.assign({}, cur.stations[0], { rx_bytes: 9223372036854775807, tx_bytes: 1000 + 1099511627776 }) ] });
	const [ h ] = runModule([ [ 'view', huge, { stations: [ { mac: MAC(32), rx_bytes: 1000, tx_bytes: 1000 } ], ports: {} }, 10 ] ]);
	assert.deepEqual([ h.stations[0].rx, h.stations[0].tx ], [ null, 879609302220 ]);
});

/* ------------------------------------------------------------ plugin */

const DROPBEAR_OK = 'ELF...no-port-forwarding...command="...';
/* a router's key line: the report command's options, the key, and a comment naming the router and its key (the first 8 of its 32 bytes) */
const KID = k => Buffer.from(k, 'base64').subarray(19, 27).toString('hex');
const COMMENT = (k, n) => 'vantage-router@' + n + '+' + KID(k);
const OPTIONS = 'command="/usr/libexec/vantage/report",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding';
const LINE = (k, n) => OPTIONS + ' ssh-ed25519 ' + k + ' ' + COMMENT(k, n);

test('vantage.aps: a router\'s key line is written one way and known again only as that', { skip: NO_UCODE }, () => {
	const mixed = Buffer.concat([ blob(0).subarray(0, 19), Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i)) ]).toString('base64');
	assert.equal(COMMENT(mixed, 'gw'), 'vantage-router@gw+a0a1a2a3a4a5a6a7');
	assert.deepEqual(runModule([ [ 'auth_line', K1, 'gw' ], [ 'auth_line', mixed, 'My-Router.lan' ] ]), [ LINE(K1, 'gw'), LINE(mixed, 'My-Router.lan') ]);
	assert.match(COMMENT(mixed, 'My-Router.lan'), /^[A-Za-z0-9.,_+@-]+$/, 'only what dropbear hands on as SSH_PUBKEYINFO');
	const P = l => [ 'parse_auth_line', l ], one = { key: K1, name: 'gw', comment: COMMENT(K1, 'gw') };
	assert.deepEqual(runModule([ P(LINE(K1, 'gw')), P(LINE(K1, 'gw') + ' '), P(LINE(K1, 'gw') + '\r'), P(LINE(K1, 'gw') + '  \r') ]), [ one, one, one, one ], 'an editor\'s blanks or carriage return after it: still that line');
	const not = [ OPTIONS + ' ssh-ed25519 ' + K1 + ' vantage-router@gw', OPTIONS + ' ssh-ed25519 ' + K1 + ' ' + COMMENT(K2, 'gw'), OPTIONS + ' ssh-ed25519 ' + K1 + ' ' + COMMENT(K1, 'g w'),
		OPTIONS + ' ssh-ed25519 ' + K1 + ' ' + COMMENT(K1, 'gw') + '+x', OPTIONS + ' ssh-ed25519 ' + K1 + ' ' + COMMENT(K1, 'gw') + ' more', ' ' + LINE(K1, 'gw'), LINE(K1, 'gw').replace(' ssh-ed25519 ', '  ssh-ed25519 '),
		LINE(K1, 'gw').replace(',no-port-forwarding', ''), LINE(K1, 'gw').replace('/vantage/report', '/vantage/report2'), 'ssh-ed25519 ' + K1 + ' ' + COMMENT(K1, 'gw'), LINE(K1, 'gw').replace(K1, 'AAAA'),
		LINE(K1, 'gw').replace('vantage-router@', 'vantage-routers@'), LINE(K1, 'gw') + '\u0000', LINE(K1, 'gw') + '\nx', '', null, 7,
		/* a tab after it: dropbear takes the key and names no comment to the report, so it is not a line the page may call its own */
		LINE(K1, 'gw') + '\t', LINE(K1, 'gw') + ' \t\r', LINE(K1, 'gw') + '\t ' ];
	assert.deepEqual(runModule(not.map(P)), not.map(() => null));
});

/* a sandbox of the plugin's files: dropbear (with or without the options
   parser), its host key, dbclient, dropbearkey (copies a prepared key),
   the collector's init script (logs its argument), hostname, urandom */
function sandbox(o) {
	const dir = mkTmp('vantage-pair-');
	const p = rel => path.join(dir, rel);
	for (const d of [ 'etc/dropbear', 'etc/init.d', 'usr/sbin', 'usr/bin', 'proc', 'dev', 'sys/class/net/br-lan' ]) fs.mkdirSync(p(d), { recursive: true });
	if (o.lanMac !== null) fs.writeFileSync(p('sys/class/net/br-lan/address'), (o.lanMac ?? '00:00:5E:00:53:B1') + '\n');
	if (o.dropbear !== null) fs.writeFileSync(p('usr/sbin/dropbear'), o.dropbear ?? DROPBEAR_OK, { mode: 0o755 });
	if (o.dbclient !== false) fs.writeFileSync(p('usr/bin/dbclient'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
	fs.writeFileSync(p('keysrc'), keyFile(o.routerKey ?? 9));
	fs.writeFileSync(p('usr/bin/dropbearkey'), '#!/bin/sh\n[ "$1 $2 $3" = "-t ed25519 -f" ] && cp "' + p('keysrc') + '" "$4" && echo "$*" >> "' + p('dropbearkey.log') + '"\n', { mode: 0o755 });
	fs.writeFileSync(p('etc/init.d/vantage-collector'), '#!/bin/sh\necho "$*" >> "' + p('collector.log') + '"\n', { mode: 0o755 });
	if (o.hostKey !== null) fs.writeFileSync(p('etc/dropbear/dropbear_ed25519_host_key'), o.hostKey ?? keyFile(7), { mode: 0o600 });
	if (o.auth != null) fs.writeFileSync(p('etc/dropbear/authorized_keys'), o.auth, { mode: 0o600 });
	if (o.aps != null) { fs.mkdirSync(p('etc/vantage'), { recursive: true }); fs.writeFileSync(p('etc/vantage/aps.json'), JSON.stringify(o.aps)); }
	if (o.haveKey) { fs.mkdirSync(p('etc/vantage'), { recursive: true }); fs.writeFileSync(p('etc/vantage/id_ed25519'), keyFile(o.routerKey ?? 9), { mode: 0o600 }); }
	fs.writeFileSync(p('proc/hostname'), (o.hostname ?? 'gw') + '\n');
	fs.writeFileSync(p('dev/urandom'), Buffer.from([ 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef ]));
	return { dir, p };
}

const PATHS = {
	DIR: 'etc/vantage', KEY: 'etc/vantage/id_ed25519', APS: 'etc/vantage/aps.json', APS_TMP: 'etc/vantage/aps.json.tmp',
	AUTH: 'etc/dropbear/authorized_keys', AUTH_TMP: 'etc/dropbear/authorized_keys.vantage', HOST_KEY: 'etc/dropbear/dropbear_ed25519_host_key',
	DROPBEAR: 'usr/sbin/dropbear', DBCLIENT: 'usr/bin/dbclient', DROPBEARKEY: 'usr/bin/dropbearkey', COLLECTOR: 'etc/init.d/vantage-collector',
	HOSTNAME: 'proc/hostname', RANDOM: 'dev/urandom', NET: 'sys/class/net'
};

const UBUS_OK = {
	'service list dropbear': { dropbear: { instances: { instance1: { running: true } } } },
	'network.interface.lan status': { l3_device: 'br-lan', 'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ] }
};

/* run calls on one load of the plugin in a sandbox: { results, ubus, sb } */
function runPlugin(o, calls) {
	const sb = sandbox(o);
	if (o.before) o.before(sb);
	let src = fs.readFileSync(PLUGIN, 'utf8');
	for (const [ name, rel ] of Object.entries(PATHS)) {
		const re = new RegExp('^const ' + name + ' = .*$', 'm');
		assert.match(src, re, name);
		src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify((o.paths && o.paths[name]) || sb.p(rel)) + ';');
	}
	const plugin = sb.p('plugin.uc'), file = sb.p('case.json');
	fs.writeFileSync(plugin, src);
	fs.writeFileSync(file, JSON.stringify({ stub: { ubus: o.ubus ?? UBUS_OK, uci: o.uci ?? { dropbear: [ { '.type': 'dropbear', Port: '22' } ] } }, calls }));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'MODE=plugin', '-D', 'PLUGIN=' + plugin, '-D', 'CASES=' + file, HARNESS ]), { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
	return Object.assign(JSON.parse(r.stdout), { sb });
}
const read = (sb, rel) => fs.existsSync(sb.p(rel)) ? fs.readFileSync(sb.p(rel), 'utf8') : null;
const mode = (sb, rel) => fs.statSync(sb.p(rel)).mode & 0o777;

test('pair: a router code is made once, from the key dropbearkey writes', { skip: NO_UCODE }, () => {
	const { results, sb } = runPlugin({}, [ { method: 'status' }, { method: 'router_code' }, { method: 'router_code' }, { method: 'status' } ]);
	assert.equal(results[0].reply.router.code, null);
	assert.deepEqual(results[1].reply, { code: routerCode(key(9), 'gw') });
	assert.deepEqual(results[2].reply, results[1].reply);
	assert.equal(results[3].reply.router.code, routerCode(key(9), 'gw'));
	assert.equal(read(sb, 'dropbearkey.log'), '-t ed25519 -f ' + sb.p('etc/vantage/id_ed25519') + '\n', 'made once');
	assert.equal(mode(sb, 'etc/vantage'), 0o700);
	const nodb = runPlugin({ dbclient: false }, [ { method: 'router_code' }, { method: 'status' } ]);
	assert.deepEqual(nodb.results[0].reply, { error: 'no-dbclient' });
	assert.equal(nodb.results[1].reply.router.code, null);
	assert.equal(read(nodb.sb, 'dropbearkey.log'), null);
	const host = runPlugin({ hostname: 'My Router' }, [ { method: 'router_code' } ]);
	assert.equal(host.results[0].reply.code, routerCode(key(9), 'My-Router'));
});

test('pair: allow_router adds one restricted line and keeps every other byte', { skip: NO_UCODE }, () => {
	const own = '# my keys\r\nssh-ed25519 ' + K3 + ' admin@laptop\r\n\r\nno-pty ssh-rsa AAAAB3Nza admin2\n';
	const { results, sb, ubus } = runPlugin({ auth: own }, [
		{ method: 'allow_router', args: { code: routerCode(K1, 'gw') } },
		{ method: 'allow_router', args: { code: routerCode(K1, 'gw') } },
		{ method: 'status' }
	]);
	const reply = apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1');
	assert.deepEqual(results[0].reply, { reply });
	assert.deepEqual(results[1].reply, { reply }, 'again: the same answer, no second line');
	assert.equal(read(sb, 'etc/dropbear/authorized_keys'), own + LINE(K1, 'gw') + '\n');
	assert.equal(mode(sb, 'etc/dropbear/authorized_keys'), 0o600);
	assert.deepEqual(results[2].reply.ap, { ssh: 'ok', routers: [ { name: 'gw', key: K1 } ], unread: false, reply });
	assert.ok(ubus.every(c => [ 'service list dropbear', 'network.interface.lan status' ].includes(c)), JSON.stringify(ubus));
	/* a line as an earlier build of this add-on wrote it (no key id in its comment), or one with a tab after it: Dropbear
	   takes the key, the report gives it nothing, and the page neither lists nor replaces it. It is the administrator's to remove */
	for (const old of [ OPTIONS + ' ssh-ed25519 ' + K1 + ' vantage-router@gw\n', LINE(K1, 'gw') + '\t\n' ]) {
		const was = runPlugin({ auth: own + old }, [ { method: 'status' }, { method: 'revoke_router', args: { key: K1 } }, { method: 'allow_router', args: { code: routerCode(K1, 'gw') } } ]);
		assert.deepEqual([ was.results[0].reply.ap.routers, was.results[1].reply, was.results[2].reply ], [ [], { error: 'unknown' }, { error: 'duplicate' } ]);
		assert.equal(read(was.sb, 'etc/dropbear/authorized_keys'), own + old);
	}
	assert.equal(fs.existsSync(sb.p('etc/dropbear/authorized_keys.vantage')), false);
});

test('pair: allow_router refuses bad codes, keys of the admin\'s own, a ninth router', { skip: NO_UCODE }, () => {
	const bad = [ '', routerCode(K1, 'g w'), routerCode(K1, 'gw') + '\n' + LINE(K2, 'x'), apCode(K1, '192.0.2.10', 22, 'ap'), routerCode('AAAA', 'gw') ];
	const r1 = runPlugin({ auth: 'ssh-ed25519 ' + K1 + ' admin\n' }, bad.map(code => ({ method: 'allow_router', args: { code } }))
		.concat([ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } }, { method: 'allow_router', args: { code: 5 } }, { method: 'allow_router', args: { code: 'x', more: 1 } } ]));
	assert.deepEqual(r1.results.map(x => x.status === 0 ? x.reply : x.status),
		bad.map(() => ({ error: 'invalid' })).concat([ { error: 'duplicate' }, 2, 2 ]));
	assert.equal(read(r1.sb, 'etc/dropbear/authorized_keys'), 'ssh-ed25519 ' + K1 + ' admin\n');
	const eight = Array.from({ length: 8 }, (_, i) => LINE(key(20 + i), 'r' + i)).join('\n') + '\n';
	const r2 = runPlugin({ auth: eight }, [ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } } ]);
	assert.deepEqual(r2.results[0].reply, { error: 'full' });
	assert.equal(read(r2.sb, 'etc/dropbear/authorized_keys'), eight);
});

test('pair: no pairing while SSH cannot hold a key to its command', { skip: NO_UCODE }, () => {
	const code = routerCode(K1, 'gw');
	const cases = [
		[ { dropbear: null }, 'no-dropbear' ],
		[ { dropbear: 'ELF built without key options' }, 'no-key-options' ],
		[ { hostKey: null }, 'no-host-key' ],
		[ { hostKey: Buffer.alloc(83, 1) }, 'no-host-key' ],
		[ { ubus: { 'network.interface.lan status': UBUS_OK['network.interface.lan status'], 'service list dropbear': { dropbear: { instances: { instance1: { running: false } } } } } }, 'not-running' ],
		[ { ubus: { 'service list dropbear': UBUS_OK['service list dropbear'] } }, 'no-address' ],
		[ { lanMac: null }, 'no-address' ],
		[ { lanMac: 'ff:ff:ff:ff:ff:fz' }, 'no-address' ],
		[ { ubus: { 'service list dropbear': UBUS_OK['service list dropbear'], 'network.interface.lan status': { l3_device: '../../etc', 'ipv4-address': [ { address: '192.0.2.10' } ] } } }, 'no-address' ]
	];
	for (const [ o, state ] of cases) {
		const { results, sb } = runPlugin(o, [ { method: 'allow_router', args: { code } }, { method: 'status' } ]);
		assert.deepEqual(results[0].reply, { error: state }, state);
		assert.equal(results[1].reply.ap.ssh, state);
		assert.equal(results[1].reply.ap.reply, null);
		assert.equal(read(sb, 'etc/dropbear/authorized_keys'), null, state + ': nothing written');
	}
});

test('pair: the reply names the first dropbear section that is on; settings that keep a router out refuse pairing', { skip: NO_UCODE }, () => {
	const code = routerCode(K1, 'gw'), sec = o => Object.assign({ '.type': 'dropbear' }, o);
	const port = uci => runPlugin({ uci: { dropbear: uci } }, [ { method: 'allow_router', args: { code } } ]).results[0].reply;
	assert.deepEqual(port([ sec({ enable: '0', Port: '22' }), sec({ Port: '2222 2223' }), sec({ Port: '2224' }) ]), { reply: apCode(key(7), '192.0.2.10', 2222, 'gw', '00:00:5e:00:53:b1') });
	assert.deepEqual(port([ sec({}) ]), { reply: apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1') });
	assert.deepEqual(port([ sec({ Port: 'x' }) ]), { reply: apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1') });
	for (const s of [ { RootLogin: '0' }, { RootLogin: 'off' }, { ForceCommand: '/bin/true' }, { keyfile: [ '/etc/dropbear/other_host_key' ] } ]) {
		const { results, sb } = runPlugin({ uci: { dropbear: [ sec({ enable: 'off' }), sec(s) ] } }, [ { method: 'allow_router', args: { code } }, { method: 'status' } ]);
		assert.deepEqual(results[0].reply, { error: 'unsupported' }, JSON.stringify(s));
		assert.equal(results[1].reply.ap.ssh, 'unsupported');
		assert.equal(read(sb, 'etc/dropbear/authorized_keys'), null);
	}
});

test('pair: a write that does not hold leaves the keys as they were', { skip: NO_UCODE }, () => {
	/* /dev/full takes the bytes and keeps none, as a full flash does: writefile reports no error */
	const own = 'ssh-ed25519 ' + K3 + ' admin@laptop\n';
	const a = runPlugin({ auth: own, paths: { AUTH_TMP: '/dev/full' } }, [ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } }, { method: 'status' } ]);
	assert.deepEqual(a.results[0].reply, { error: 'failed' });
	assert.equal(read(a.sb, 'etc/dropbear/authorized_keys'), own, 'untouched');
	assert.deepEqual(a.results[1].reply.ap.routers, []);
	const b = runPlugin({ haveKey: true, paths: { APS_TMP: '/dev/full' } }, [ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') } } ]);
	assert.deepEqual(b.results[0].reply, { error: 'failed' });
	assert.equal(read(b.sb, 'etc/vantage/aps.json'), null);
	assert.equal(read(b.sb, 'collector.log'), null, 'the collector is not started for a list that was not saved');
});

test('pair: revoke_router removes only that router\'s line', { skip: NO_UCODE }, () => {
	const auth = 'ssh-ed25519 ' + K1 + ' admin\n' + LINE(K1, 'gw') + '\n' + LINE(K2, 'gw2') + '\n';
	const { results, sb } = runPlugin({ auth }, [
		{ method: 'revoke_router', args: { key: K1 } }, { method: 'revoke_router', args: { key: K1 } },
		{ method: 'revoke_router', args: { key: 'AAAA' } }, { method: 'revoke_router', args: { key: K3 } }
	]);
	assert.deepEqual(results.map(x => x.reply), [ { ok: true }, { error: 'unknown' }, { error: 'unknown' }, { error: 'unknown' } ]);
	assert.equal(read(sb, 'etc/dropbear/authorized_keys'), 'ssh-ed25519 ' + K1 + ' admin\n' + LINE(K2, 'gw2') + '\n');
});

test('pair: a line an editor left a blank or a carriage return on is still listed and can be revoked', { skip: NO_UCODE }, () => {
	/* dropbear lets such a line in all the same; unlisted, the page would say no router can read this device */
	const auth = '# keys\r\n' + LINE(K1, 'gw') + '\r\n' + LINE(K2, 'gw2') + ' \n' + LINE(K3, 'old').replace('+' + KID(K3), '') + '\n';
	const { results, sb } = runPlugin({ auth }, [ { method: 'status' }, { method: 'allow_router', args: { code: routerCode(K1, 'gw') } }, { method: 'revoke_router', args: { key: K1 } },
		{ method: 'revoke_router', args: { key: K2 } }, { method: 'status' } ]);
	assert.deepEqual(results[0].reply.ap.routers, [ { name: 'gw', key: K1 }, { name: 'gw2', key: K2 } ], 'both; a line without the key\'s id in its comment is not the add-on\'s');
	assert.ok(results[1].reply.reply, 'already allowed: the answer, no second line');
	assert.deepEqual([ results[2].reply, results[3].reply, results[4].reply.ap.routers ], [ { ok: true }, { ok: true }, [] ]);
	assert.equal(read(sb, 'etc/dropbear/authorized_keys'), '# keys\r\n' + LINE(K3, 'old').replace('+' + KID(K3), '') + '\n', 'every other byte kept');
});

test('pair: a key file or a paired list that is there and cannot be read whole is never written anew', { skip: NO_UCODE }, () => {
	const code = routerCode(K1, 'gw'), own = 'ssh-ed25519 ' + K3 + ' admin@laptop\n';
	const asDir = (sb, rel) => fs.mkdirSync(sb.p(rel), { recursive: true });
	/* a link to nothing: there, and no text to read. Unlike a directory, a rename would replace it, so the file itself shows whether anything was written */
	const asLink = (sb, rel) => { fs.mkdirSync(path.dirname(sb.p(rel)), { recursive: true }); fs.symlinkSync(sb.p('nowhere'), sb.p(rel)); };
	const isLink = (sb, rel) => fs.lstatSync(sb.p(rel)).isSymbolicLink() && fs.readlinkSync(sb.p(rel)) === sb.p('nowhere');
	/* the keys: a name that is there and gives no text (a directory, a link to nothing; an I/O error reads the same), and a file longer than is read */
	const cases = [ [ 'unreadable', sb => asDir(sb, 'etc/dropbear/authorized_keys'), sb => fs.statSync(sb.p('etc/dropbear/authorized_keys')).isDirectory() ],
		[ 'a link to nothing', sb => asLink(sb, 'etc/dropbear/authorized_keys'), sb => isLink(sb, 'etc/dropbear/authorized_keys') ],
		[ 'too long', sb => fs.writeFileSync(sb.p('etc/dropbear/authorized_keys'), own + '#'.repeat(262144 - own.length) + '\n'), sb => read(sb, 'etc/dropbear/authorized_keys').length === 262145 ] ];
	for (const [ what, make, intact ] of cases) {
		const { results, sb } = runPlugin({ before: make }, [ { method: 'allow_router', args: { code } }, { method: 'revoke_router', args: { key: K1 } }, { method: 'status' } ]);
		assert.deepEqual([ results[0].reply, results[1].reply ], [ { error: 'keys-unreadable' }, { error: 'failed' } ], what);
		assert.deepEqual(results[2].reply.ap, { ssh: 'keys-unreadable', routers: [], unread: true, reply: null }, what + ': the page is told it does not know, not that there is none');
		assert.ok(intact(sb), what + ': left as it was');
		assert.equal(fs.existsSync(sb.p('etc/dropbear/authorized_keys.vantage')), false);
	}
	/* exactly as long as is read: fine; and a line that would take it past that is not added, since it could not be listed or revoked after */
	const fill = n => own + '#'.repeat(n - own.length - 1) + '\n', line = LINE(K1, 'gw') + '\n';
	const fits = runPlugin({ auth: fill(262144 - line.length) }, [ { method: 'allow_router', args: { code } }, { method: 'status' } ]);
	assert.ok(fits.results[0].reply.reply);
	assert.equal(read(fits.sb, 'etc/dropbear/authorized_keys').length, 262144);
	assert.deepEqual(fits.results[1].reply.ap.routers, [ { name: 'gw', key: K1 } ]);
	const over = runPlugin({ auth: fill(262144 - line.length + 1) }, [ { method: 'allow_router', args: { code } }, { method: 'status' } ]);
	assert.deepEqual(over.results[0].reply, { error: 'failed' });
	assert.equal(read(over.sb, 'etc/dropbear/authorized_keys'), fill(262144 - line.length + 1), 'untouched');
	assert.deepEqual([ over.results[1].reply.ap.ssh, over.results[1].reply.ap.routers ], [ 'ok', [] ]);

	/* the paired list */
	const ap = apCode(K2, '192.0.2.20', 22, 'ap-hall'), kept = [ { id: '00000000000000a1', name: 'ap-den', key: K3, addr: '192.0.2.11', port: 22, mac: AP_MAC } ];
	const long = JSON.stringify(kept) + ' '.repeat(65537);
	const text = s => [ sb => { fs.mkdirSync(sb.p('etc/vantage'), { recursive: true }); fs.writeFileSync(sb.p('etc/vantage/aps.json'), s); }, sb => read(sb, 'etc/vantage/aps.json') === s ];
	/* edited by hand: a quote lost, one entry's address typed over, no list at all, an entry twice. Written back, each would lose a pairing */
	const three = [ kept[0], Object.assign({}, kept[0], { id: '00000000000000a2', key: K1 }), Object.assign({}, kept[0], { id: '00000000000000a3', key: key(5) }) ];
	const broken = JSON.stringify(three).replace('"name":"ap-den"', '"name":"ap-den'), typed = JSON.stringify([ three[0], Object.assign({}, three[1], { addr: 'ap-hall.lan' }), three[2] ]);
	for (const [ what, make, intact ] of [ [ 'unreadable', sb => asDir(sb, 'etc/vantage/aps.json'), sb => fs.statSync(sb.p('etc/vantage/aps.json')).isDirectory() ],
		[ 'a link to nothing', sb => asLink(sb, 'etc/vantage/aps.json'), sb => isLink(sb, 'etc/vantage/aps.json') ],
		[ 'too long', ...text(long) ], [ 'not JSON', ...text(broken) ], [ 'an entry that is none', ...text(typed) ], [ 'no list', ...text('{"aps":[]}') ], [ 'an entry twice', ...text(JSON.stringify([ kept[0], kept[0] ])) ] ]) {
		const { results, sb } = runPlugin({ haveKey: true, before: make }, [ { method: 'add_ap', args: { code: ap } }, { method: 'remove_ap', args: { id: kept[0].id } }, { method: 'status' } ]);
		assert.deepEqual([ results[0].reply, results[1].reply, results[2].reply.router.aps, results[2].reply.router.unread ], [ { error: 'failed' }, { error: 'failed' }, [], true ], what);
		assert.ok(intact(sb), what + ': left as it was');
		assert.equal(read(sb, 'collector.log'), null, what);
	}
	/* no file at all is no list yet, as before, and so is an empty one; a list as the add-on wrote it is read */
	for (const before of [ undefined, text('')[0], text(' \n')[0], text('[]')[0] ]) {
		const fresh = runPlugin({ haveKey: true, before }, [ { method: 'add_ap', args: { code: ap } }, { method: 'status' } ]).results;
		assert.deepEqual([ fresh[0].reply, fresh[1].reply.router.unread, fresh[1].reply.router.aps.length ], [ { id: '0123456789abcdef' }, false, 1 ]);
	}
	assert.deepEqual(runPlugin({ haveKey: true, before: text(JSON.stringify(three))[0] }, [ { method: 'status' } ]).results[0].reply.router.aps.map(a => a.id), three.map(a => a.id));
	/* the collector reads what it can of such a list (it writes nothing back): the entries that are whole */
	assert.deepEqual(runModule([ [ 'aps', typed ], [ 'aps', typed, true ], [ 'aps', broken ], [ 'aps', broken, true ], [ 'aps', '' ], [ 'aps', '', true ], [ 'aps', null, true ], [ 'aps', '[]', true ] ])
		.map(l => l && l.map(a => a.id)), [ [ three[0].id, three[2].id ], null, [], null, [], [], null, [] ]);

	/* unread while SSH has another fault too, which the plugin names first: the page is still told */
	const down = { 'network.interface.lan status': UBUS_OK['network.interface.lan status'], 'service list dropbear': { dropbear: { instances: { instance1: { running: false } } } } };
	const st = (before) => runPlugin({ ubus: down, before }, [ { method: 'status' } ]).results[0].reply.ap;
	assert.deepEqual(st(sb => asLink(sb, 'etc/dropbear/authorized_keys')), { ssh: 'not-running', routers: [], unread: true, reply: null });
	assert.deepEqual(st(), { ssh: 'not-running', routers: [], unread: false, reply: null });
});

test('pair: allow_router has its answer before it writes the line', { skip: NO_UCODE }, () => {
	/* the LAN address gone between the check and the answer: without one there is nothing to hand the router, so no line either */
	const lanStatus = UBUS_OK['network.interface.lan status'];
	const { results, sb } = runPlugin({ ubus: Object.assign({}, UBUS_OK, { 'network.interface.lan status': { __seq: [ lanStatus, {} ] } }) }, [ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } } ]);
	assert.deepEqual(results[0].reply, { error: 'failed' });
	assert.equal(read(sb, 'etc/dropbear/authorized_keys'), null, 'nothing written');
});

test('pair: add_ap stores the access point and starts the collector; remove_ap stops it with the last', { skip: NO_UCODE }, () => {
	const code = apCode(K2, '192.0.2.20', 22, 'ap-hall');
	const { results, sb } = runPlugin({ haveKey: true }, [
		{ method: 'add_ap', args: { code } },
		{ method: 'add_ap', args: { code } },
		{ method: 'add_ap', args: { code: apCode(K3, '192.0.2.21', 2222, 'ap-loft'), addr: '198.51.100.7' } },
		{ method: 'add_ap', args: { code: apCode(key(4), '192.0.2.22', 22, 'x'), addr: '127.0.0.1' } },
		{ method: 'add_ap', args: { code: routerCode(K1, 'gw') } },
		{ method: 'status' },
		{ method: 'remove_ap', args: { id: '0123456789abcdef' } },
		{ method: 'remove_ap', args: { id: 'nope' } }
	]);
	const id = '0123456789abcdef';
	/* the urandom double gives the same id again: a second entry under it is refused */
	assert.deepEqual(results.slice(0, 5).map(x => x.reply), [ { id }, { error: 'duplicate' }, { error: 'failed' }, { error: 'invalid' }, { error: 'invalid' } ]);
	assert.deepEqual(results[5].reply.router.aps, [ { id, name: 'ap-hall', addr: '192.0.2.20', port: 22 } ]);
	assert.deepEqual(results.slice(6).map(x => x.reply), [ { ok: true }, { error: 'unknown' } ]);
	assert.equal(read(sb, 'collector.log'), 'enable\nstart\nstop\ndisable\n');
	const other = runPlugin({ haveKey: true }, [ { method: 'add_ap', args: { code: apCode(K3, '192.0.2.21', 2222, 'ap-loft'), addr: '198.51.100.7' } }, { method: 'status' } ]);
	assert.deepEqual(other.results[1].reply.router.aps, [ { id, name: 'ap-loft', addr: '198.51.100.7', port: 2222 } ], 'the address given wins');
	assert.deepEqual(JSON.parse(read(other.sb, 'etc/vantage/aps.json')), [ { id, name: 'ap-loft', key: K3, addr: '198.51.100.7', port: 2222, mac: AP_MAC } ], 'kept with its MAC');
	assert.equal(mode(sb, 'etc/vantage/aps.json'), 0o600);
	assert.deepEqual(JSON.parse(read(sb, 'etc/vantage/aps.json')), [], 'the last one removed');
	const nokey = runPlugin({}, [ { method: 'add_ap', args: { code } } ]);
	assert.deepEqual(nokey.results[0].reply, { error: 'no-key' });
	assert.equal(read(nokey.sb, 'collector.log'), null);
});

test('pair: add_ap keeps the network the access point is on, by name; a list of an earlier version is read and stays as it was', { skip: NO_UCODE }, () => {
	const ubus = Object.assign({}, UBUS_OK, { 'network.interface dump': DUMP }), id = '0123456789abcdef';
	const add = (args, o) => runPlugin(Object.assign({ haveKey: true, ubus }, o), [ { method: 'add_ap', args }, { method: 'status' } ]);
	const entry = (r) => JSON.parse(read(r.sb, 'etc/vantage/aps.json'))[0];
	/* on the LAN: its name, in the list and on the page */
	const lan = add({ code: apCode(K2, '192.0.2.20', 22, 'ap-hall') });
	assert.deepEqual(lan.results[0].reply, { id });
	assert.deepEqual(entry(lan), { id, name: 'ap-hall', key: K2, addr: '192.0.2.20', port: 22, mac: AP_MAC, net: 'lan' });
	assert.deepEqual(lan.results[1].reply.router.aps, [ { id, name: 'ap-hall', addr: '192.0.2.20', port: 22, net: 'lan' } ]);
	assert.equal(read(lan.sb, 'collector.log'), 'enable\nstart\n');
	/* netifd is asked once, for its interfaces, and nothing else is asked for a pairing */
	assert.deepEqual(runPlugin({ haveKey: true, ubus }, [ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') } } ]).ubus, [ 'network.interface dump' ]);
	/* the network of the address it is paired at: the one given, by IPv6 too */
	assert.equal(entry(add({ code: apCode(K2, '192.0.2.20', 22, 'ap-hall'), addr: '198.51.100.7' })).net, 'guest');
	assert.equal(entry(add({ code: apCode(K2, '198.51.100.7', 22, 'ap-hall'), addr: '2001:db8:1::10' })).net, 'lan');
	/* on none of this router's networks (behind another router), netifd silent or the network down, or a name netifd has from
	   elsewhere that is no section's: paired all the same, as before, and no network kept */
	const plain = a => ({ id, name: 'ap-hall', key: K2, addr: a, port: 22, mac: AP_MAC });
	for (const [ what, args, o ] of [ [ 'no network', { code: apCode(K2, '198.51.100.200', 22, 'ap-hall') } ], [ 'no network, IPv6', { code: apCode(K2, '2001:db8:2::10', 22, 'ap-hall') } ],
		[ 'no dump', { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') }, { ubus: UBUS_OK } ],
		[ 'no interfaces', { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') }, { ubus: Object.assign({}, UBUS_OK, { 'network.interface dump': { interface: 'lan' } }) } ],
		[ 'down', { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') }, { ubus: Object.assign({}, UBUS_OK, { 'network.interface dump': { interface: [ Object.assign({}, LAN_IF, { up: false }) ] } }) } ],
		[ 'no name', { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') }, { ubus: Object.assign({}, UBUS_OK, { 'network.interface dump': { interface: [ Object.assign({}, LAN_IF, { interface: 'my-lan' }) ] } }) } ] ]) {
		const r = add(args, o);
		assert.deepEqual([ r.results[0].reply, entry(r) ], [ { id }, plain(args.addr ?? args.code.split(' ')[4]) ], what);
		assert.deepEqual(r.results[1].reply.router.aps, [ { id, name: 'ap-hall', addr: plain(args.code.split(' ')[4]).addr, port: 22 } ], what + ': none on the page');
	}

	/* a list as an earlier version wrote it (no network in it): read, listed, and its entries written back as they were */
	const old = [ { id: '00000000000000a1', name: 'ap-den', key: K3, addr: '192.0.2.11', port: 22, mac: AP_MAC }, { id: '00000000000000a2', name: 'ap-loft', key: K1, addr: '198.51.100.12', port: 2222, mac: MAC(0xa2) } ];
	const up = runPlugin({ haveKey: true, ubus, aps: old }, [ { method: 'status' }, { method: 'add_ap', args: { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') } }, { method: 'status' },
		{ method: 'remove_ap', args: { id: old[0].id } } ]);
	assert.deepEqual([ up.results[0].reply.router.unread, up.results[0].reply.router.aps ], [ false, old.map(a => ({ id: a.id, name: a.name, addr: a.addr, port: a.port })) ]);
	assert.deepEqual(up.results[1].reply, { id });
	assert.deepEqual(up.results[2].reply.router.aps.map(a => a.net), [ undefined, undefined, 'lan' ]);
	assert.deepEqual(up.results[3].reply, { ok: true });
	assert.deepEqual(JSON.parse(read(up.sb, 'etc/vantage/aps.json')), [ old[1], Object.assign(plain('192.0.2.20'), { net: 'lan' }) ], 'no network made up for the old one');
	/* a network that is no name (a hand edit): the list is not this add-on's to write, as with any other field gone wrong */
	for (const bad of [ 'br-lan', '', null, 7 ]) {
		const text = JSON.stringify([ old[0], Object.assign({}, old[1], { net: bad }) ]);
		const r = runPlugin({ haveKey: true, ubus, before: sb => { fs.mkdirSync(sb.p('etc/vantage'), { recursive: true }); fs.writeFileSync(sb.p('etc/vantage/aps.json'), text); } },
			[ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.20', 22, 'ap-hall') } }, { method: 'remove_ap', args: { id: old[0].id } }, { method: 'status' } ]);
		assert.deepEqual([ r.results[0].reply, r.results[1].reply, r.results[2].reply.router.aps, r.results[2].reply.router.unread ], [ { error: 'failed' }, { error: 'failed' }, [], true ], JSON.stringify(bad));
		assert.equal(read(r.sb, 'etc/vantage/aps.json'), text, 'left as it was');
		assert.equal(read(r.sb, 'collector.log'), null);
	}
});

test('pair: a device is not paired with itself', { skip: NO_UCODE }, () => {
	/* the reply this device gives a router, pasted into its own form: its own host key */
	const self = runPlugin({ haveKey: true }, [ { method: 'allow_router', args: { code: routerCode(K1, 'gw') } }, { method: 'status' } ]).results[0].reply.reply;
	assert.equal(self, apCode(key(7), '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1'));
	for (const args of [ { code: self }, { code: self, addr: '198.51.100.7' }, { code: apCode(key(7), '203.0.113.9', 2222, 'another-name', AP_MAC) } ]) {
		const r = runPlugin({ haveKey: true, ubus: Object.assign({}, UBUS_OK, { 'network.interface dump': DUMP }) }, [ { method: 'add_ap', args }, { method: 'status' } ]);
		assert.deepEqual([ r.results[0].reply, r.results[1].reply.router.aps ], [ { error: 'self' }, [] ]);
		assert.deepEqual([ read(r.sb, 'etc/vantage/aps.json'), read(r.sb, 'collector.log') ], [ null, null ], 'nothing written, nothing started');
		assert.ok(!r.ubus.includes('network.interface dump'), 'refused before netifd is asked');
	}
	/* said of a router without a key of its own too; a reply that is no reply is still that first */
	assert.deepEqual(runPlugin({}, [ { method: 'add_ap', args: { code: self } } ]).results[0].reply, { error: 'self' });
	assert.deepEqual(runPlugin({ haveKey: true }, [ { method: 'add_ap', args: { code: self, addr: '127.0.0.1' } } ]).results[0].reply, { error: 'invalid' });
	/* another device's key at this device's own address, and a device with no host key to compare: paired as before */
	assert.deepEqual(runPlugin({ haveKey: true }, [ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.10', 22, 'gw', '00:00:5e:00:53:b1') } } ]).results[0].reply, { id: '0123456789abcdef' });
	assert.deepEqual(runPlugin({ haveKey: true, hostKey: null }, [ { method: 'add_ap', args: { code: self } } ]).results[0].reply, { id: '0123456789abcdef' });
});

test('pair: at most 16 access points', { skip: NO_UCODE }, () => {
	const aps = Array.from({ length: 16 }, (_, i) => ({ id: (i + 1).toString(16).padStart(16, '0'), name: 'ap' + i, key: key(40 + i), addr: '192.0.2.' + (i + 1), port: 22, mac: AP_MAC }));
	const { results, sb } = runPlugin({ haveKey: true, aps }, [ { method: 'add_ap', args: { code: apCode(K2, '192.0.2.100', 22, 'one-more') } } ]);
	assert.deepEqual(results[0].reply, { error: 'full' });
	assert.equal(JSON.parse(read(sb, 'etc/vantage/aps.json')).length, 16);
});

/* ------------------------------------------------------------ report */

/* a fake /sys/class/net and /proc/net/arp, and the report's ubus replies. Run as Dropbear runs it for a router's key
   line: the line's comment in SSH_PUBKEYINFO, what the router asked for in SSH_ORIGINAL_COMMAND (auth, keyinfo: another
   key file, another comment or none; shell: no key line's command, as from the administrator's shell) */
function reportRun(o) {
	if (!('auth' in o) && !('keyinfo' in o) && !o.shell) o = Object.assign({ auth: LINE(K1, 'gw') + '\n', keyinfo: COMMENT(K1, 'gw') }, o);
	const dir = mkTmp('vantage-report-');
	const net = path.join(dir, 'net');
	const dev = (name, files) => {
		fs.mkdirSync(path.join(net, name, 'statistics'), { recursive: true });
		for (const [ f, v ] of Object.entries(files || {})) fs.writeFileSync(path.join(net, name, f), v);
	};
	dev('br-lan', { address: MAC(1) + '\n' });
	dev('lan1', { address: MAC(2) + '\n', speed: '1000\n', 'statistics/rx_bytes': '100\n', 'statistics/tx_bytes': '200\n' });
	dev('lan2', { address: MAC(3) + '\n', speed: '100\n', 'statistics/rx_bytes': '300\n', 'statistics/tx_bytes': '400\n' });
	dev('lan3', { address: MAC(4) + '\n', speed: '-1\n', 'statistics/rx_bytes': '500\n', 'statistics/tx_bytes': '600\n' });
	dev('phy0-ap0', { address: MAC(16) + '\n' });
	fs.mkdirSync(path.join(net, 'phy0-ap0', 'phy80211'));
	dev('ra0', { address: MAC(17) + '\n' });
	const arp = path.join(dir, 'arp');
	fs.writeFileSync(arp, 'IP address       HW type     Flags       HW address            Mask     Device\n' + (o.arp || []).map(a => a.join('  ')).join('\n') + '\n');
	const host = path.join(dir, 'hostname');
	fs.writeFileSync(host, (o.hostname ?? 'ap-hall') + '\n');
	let src = fs.readFileSync(REPORT, 'utf8');
	const auth = path.join(dir, 'authorized_keys');
	if (o.auth != null) fs.writeFileSync(auth, o.auth);
	for (const [ name, v ] of Object.entries({ NET: net, ARP: arp, HOSTNAME: host, AUTH: auth })) {
		const re = new RegExp('^const ' + name + ' = .*$', 'm');
		assert.match(src, re);
		src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify(v) + ';');
	}
	const script = path.join(dir, 'report.uc'), stub = path.join(dir, 'stub.json'), calls = path.join(dir, 'calls');
	fs.writeFileSync(script, src);
	fs.writeFileSync(stub, JSON.stringify({ ubus: o.ubus }));
	const env = Object.assign({}, process.env, { SSH_CLIENT: o.client ?? '', SSH_ORIGINAL_COMMAND: o.asked ?? 'rm -rf /' });
	delete env.SSH_PUBKEYINFO;
	if (o.shell) delete env.SSH_ORIGINAL_COMMAND;
	if (o.keyinfo != null) env.SSH_PUBKEYINFO = o.keyinfo;
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'STUBFILE=' + stub, '-D', 'CALLSFILE=' + calls, script, 'ignored', 'args' ]), { encoding: 'utf8', input: 'ignored stdin', env });
	const made = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
	if (o.refused) return { status: r.status, stdout: r.stdout, calls: made };
	assert.equal(r.status, 0, r.stderr);
	return { out: JSON.parse(r.stdout), calls: made };
}

const REPORT_UBUS = {
	'system board': { model: 'Example AP', release: {} },
	'system info': { uptime: 1234 },
	'iwinfo devices': { devices: [ 'phy0-ap0', 'phy0-sta0', 'bad name', 'ra0' ] },
	'iwinfo info phy0-ap0': { mode: 'Master', ssid: 'Home', bssid: MAC(16).toUpperCase(), frequency: 5180, channel: 36, encryption: { enabled: true } },
	'iwinfo info phy0-sta0': { mode: 'Client', ssid: 'Upstream' },
	'iwinfo info ra0': { mode: 'Master', ssid: 'Guest', bssid: MAC(17), frequency: 2437, channel: 6 },
	'iwinfo assoclist phy0-ap0': { results: [
		{ mac: MAC(32).toUpperCase(), signal: -55, connected_time: 60, authorized: true, rx: { rate: 866000, bytes: 1000 }, tx: { rate: 650000, bytes: 2000 } },
		{ mac: MAC(33), signal: -70, authorized: false, rx: {}, tx: {} },
		{ mac: 'junk' } ] },
	'iwinfo assoclist ra0': { results: [ { mac: MAC(34), signal: -60, rx: { rate: 72000, bytes: 5 }, tx: { rate: 72000, bytes: 6 } } ] },
	'network.interface dump': { interface: [
		{ interface: 'lan', l3_device: 'br-lan', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] },
		{ interface: 'loopback', l3_device: 'lo', route: [] } ] },
	'luci.vantage wired': { hosts: [
		{ mac: MAC(64), port: 'lan1' }, { mac: MAC(65), port: 'lan1' },
		{ mac: MAC(66), port: 'lan2' },
		{ mac: MAC(67), port: 'lan3' }, { mac: MAC(68), port: 'lan3' },
		{ mac: MAC(69), port: 'phy0-ap0' }, { mac: MAC(70), port: 'ra0' },
		{ mac: MAC(1), port: 'lan2' }, { mac: 'bad', port: 'lan2' }, { mac: MAC(71), port: 'bad port' }, { mac: MAC(66), port: 'lan3' } ] }
};
const REPORT_CALLS = [ 'system board', 'system info', 'iwinfo devices', 'iwinfo info', 'iwinfo assoclist', 'network.interface dump', 'luci.vantage wired' ];

test('report: SSIDs, stations, and the wired hosts past the uplink', { skip: NO_UCODE }, () => {
	const { out, calls } = reportRun({ ubus: REPORT_UBUS, arp: [ [ '192.0.2.1', '0x1', '0x2', MAC(64), '*', 'br-lan' ], [ '192.0.2.99', '0x1', '0x0', MAC(65), '*', 'br-lan' ] ] });
	assert.deepEqual(out, {
		v: 1, name: 'ap-hall', model: 'Example AP', uptime: 1234, mac: MAC(1),
		ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Home', freq: 5180, channel: 36 }, { ifname: 'ra0', bssid: MAC(17), ssid: 'Guest', freq: 2437, channel: 6 } ],
		stations: [
			{ mac: MAC(32), ifname: 'phy0-ap0', signal: -55, rx_rate: 866000, tx_rate: 650000, rx_bytes: 1000, tx_bytes: 2000, connected: 60 },
			{ mac: MAC(34), ifname: 'ra0', signal: -60, rx_rate: 72000, tx_rate: 72000, rx_bytes: 5, tx_bytes: 6, connected: null } ],
		ports: { lan2: { speed: 100, rx_bytes: 300, tx_bytes: 400, hosts: 1 }, lan3: { speed: null, rx_bytes: 500, tx_bytes: 600, hosts: 2 } },
		wired: [ { mac: MAC(66), port: 'lan2' }, { mac: MAC(67), port: 'lan3' }, { mac: MAC(68), port: 'lan3' } ]
	});
	for (const c of calls) assert.ok(REPORT_CALLS.some(k => c === k || c.startsWith(k + ' ')), c);
});

test('report: no uplink found, no wired hosts; the router\'s own address finds it too', { skip: NO_UCODE }, () => {
	assert.deepEqual(reportRun({ ubus: REPORT_UBUS, arp: [] }).out.wired, [], 'gateway not in the neighbour table');
	const ubus = Object.assign({}, REPORT_UBUS, { 'network.interface dump': { interface: [ { interface: 'lan', l3_device: 'br-lan', route: [] } ] } });
	assert.deepEqual(reportRun({ ubus, arp: [ [ '192.0.2.1', '0x1', '0x2', MAC(64), '*', 'br-lan' ] ] }).out.wired, [], 'no default route');
	const viaRouter = reportRun({ ubus, client: '192.0.2.9 50000 22', arp: [ [ '192.0.2.9', '0x1', '0x2', MAC(66), '*', 'br-lan' ] ] }).out;
	/* the router's MAC is listed on lan2 and lan3: both are uplinks then */
	assert.deepEqual(viaRouter.wired, [ { mac: MAC(64), port: 'lan1' }, { mac: MAC(65), port: 'lan1' } ]);
});

test('report: a router whose key line is gone gets nothing, on a connection it still holds too', { skip: NO_UCODE }, () => {
	/* dropbear checks a key when a connection logs in. To every command it runs on that connection it names the line's
	   comment (SSH_PUBKEYINFO) and, when the line's command replaced the caller's, what the caller asked for (SSH_ORIGINAL_COMMAND) */
	const arp = [ [ '192.0.2.1', '0x1', '0x2', MAC(64), '*', 'br-lan' ] ], admin = 'ssh-ed25519 ' + K3 + ' admin@laptop\n';
	const run = (auth, keyinfo, more) => reportRun(Object.assign({ ubus: REPORT_UBUS, arp, auth, keyinfo }, more));
	const nothing = (r, what) => assert.deepEqual([ r.status, r.stdout, r.calls ], [ 1, '', [] ], 'nothing printed, nothing asked: ' + what);
	const plain = reportRun({ ubus: REPORT_UBUS, arp, shell: true }).out;
	/* its line is there: the report, whatever it asked for */
	for (const auth of [ admin + LINE(K1, 'gw') + '\n', LINE(K2, 'gw2') + '\n' + LINE(K1, 'gw') + '\r\n', LINE(K1, 'gw'), LINE(K1, 'gw') + ' \n' ])
		for (const asked of [ 'rm -rf /', '', '/usr/libexec/vantage/report' ])
			assert.deepEqual(run(auth, COMMENT(K1, 'gw'), { asked }).out, plain);
	/* revoked: the line gone, the file gone, another router's line left, a line for the same name and another key, the comment on a line that is not the add-on's */
	const gone = [ admin, null, LINE(K2, 'gw2') + '\n', LINE(K2, 'gw') + '\n', 'ssh-ed25519 ' + K1 + ' ' + COMMENT(K1, 'gw') + '\n', '# ' + LINE(K1, 'gw') + '\n', LINE(K1, 'gw').replace(',no-pty', '') + '\n' ];
	for (const auth of gone) nothing(run(auth, COMMENT(K1, 'gw'), { refused: true }), JSON.stringify(auth).slice(0, 60));
	/* a key line's command ran it and dropbear named no comment (a tab after it, or a dropbear that names none): the
	   report cannot tell whose line it was, so nothing, with the line there or gone */
	for (const auth of [ admin + LINE(K1, 'gw') + '\n', LINE(K1, 'gw') + '\t\n', admin ]) nothing(run(auth, null, { refused: true }), 'no comment named');
	/* under a key line's command, a comment that is no line of the add-on's: a line of the administrator's own with this command, an earlier build's line */
	for (const keyinfo of [ 'admin@laptop', '', 'vantage', 'xvantage-router@gw', 'vantage-router@', 'vantage-router@gw', COMMENT(K1, 'gw') + 'x' ])
		nothing(run(admin + LINE(K1, 'gw') + '\n' + OPTIONS + ' ssh-ed25519 ' + K2 + ' vantage-router@gw\n', keyinfo, { refused: true }), keyinfo);
	/* no key line's command (the administrator's shell, a login without a key): not the add-on's to judge */
	for (const keyinfo of [ null, 'admin@laptop', '' ]) assert.deepEqual(run(admin, keyinfo, { shell: true }).out, plain, String(keyinfo));
	/* named like the add-on's all the same, and no line of it there: refused */
	nothing(run(admin, COMMENT(K1, 'gw'), { shell: true, refused: true }), 'named, not held');
});

test('report: without ubus it prints nothing and fails', { skip: NO_UCODE }, () => {
	const dir = mkTmp('vantage-report-');
	const stub = path.join(dir, 'stub.json');
	fs.writeFileSync(stub, JSON.stringify({ no_ubus: true }));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'STUBFILE=' + stub, REPORT ]), { encoding: 'utf8' });
	assert.equal(r.status, 1);
	assert.equal(r.stdout, '');
});

test('report: one at a time; a second run gives up without a report', { skip: NO_UCODE }, async () => {
	const dir = mkTmp('vantage-report-');
	const self = path.join(dir, 'report'), stub = path.join(dir, 'stub.json');
	fs.writeFileSync(stub, JSON.stringify({ ubus: REPORT_UBUS }));
	const src = fs.readFileSync(REPORT, 'utf8').replace(/^const SELF = .*$/m, () => 'const SELF = ' + JSON.stringify(self) + ';');
	fs.writeFileSync(self, src);
	const run = () => spawnSync(UCODE, ucodeArgs().concat([ '-D', 'STUBFILE=' + stub, self ]), { encoding: 'utf8' });
	assert.equal(run().status, 0, 'alone, it reports');
	/* another holds the lock for two seconds (it says so in a file: its output is buffered until it ends) */
	const held = path.join(dir, 'held');
	const holder = require('child_process').spawn(UCODE, [ '-e', 'import { open, writefile } from "fs"; let f = open(' + JSON.stringify(self) + ', "r"); f.lock("x"); writefile(' + JSON.stringify(held) + ', "1"); sleep(2000);' ], { stdio: 'ignore' });
	for (let i = 0; i < 100 && !fs.existsSync(held); i++) await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(fs.existsSync(held), 'the lock is held');
	const second = run();
	assert.equal(second.status, 1);
	assert.equal(second.stdout, '', 'nothing printed');
	await new Promise(resolve => holder.once('exit', resolve));
	assert.equal(run().status, 0, 'and again once the first is done');
});

/* --------------------------------------------------------- collector */

const COLLECTOR = path.join(PKG, 'usr/libexec/vantage/collector');
const AP1 = { id: '00000000000000a1', name: 'ap-hall', key: K1, addr: '192.0.2.10', port: 22, mac: AP_MAC };
const AP2 = { id: '00000000000000a2', name: 'ap-den', key: K2, addr: '192.0.2.11', port: 2222, mac: '00:00:5e:00:53:a2' };
const apReport = (n, bytes, extra) => JSON.stringify(Object.assign({ v: 1, name: 'calls-itself-' + n, model: 'Example AP', uptime: 100, mac: MAC(99),
	ssids: [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Home', freq: 5180, channel: 36 } ],
	stations: [ { mac: MAC(32), ifname: 'phy0-ap0', signal: -50, rx_rate: 866000, tx_rate: 650000, rx_bytes: bytes, tx_bytes: 2 * bytes, connected: 60 } ],
	ports: { lan2: { speed: 1000, rx_bytes: bytes, tx_bytes: bytes, hosts: 1 } }, wired: [ { mac: MAC(48), port: 'lan2' } ] }, extra || {})) + '\n';

/* the collector in a sandbox, under the uloop double's clock: a fake
   dbclient that logs how it was called and answers as hosts/<addr>/ says
   (out, err, code; no directory: connection refused; a file `hang`: never
   ends), a fake kill, its own paired list, neighbour table and leases.
   Returns { results: one per step, log: dbclient's calls, sb } */
function runCollector(o, steps) {
	const dir = mkTmp('vantage-collector-');
	const p = rel => path.join(dir, rel);
	for (const d of [ 'etc/vantage', 'run', 'hosts', 'bin' ]) fs.mkdirSync(p(d), { recursive: true });
	fs.writeFileSync(p('etc/vantage/aps.json'), JSON.stringify(o.aps ?? [ AP1 ]));
	fs.writeFileSync(p('etc/vantage/id_ed25519'), keyFile(9), { mode: 0o600 });
	fs.writeFileSync(p('arp'), o.arp ?? '');
	if (o.leasesAs === 'fifo') assert.equal(spawnSync('mkfifo', [ p('leases') ]).status, 0, 'mkfifo');
	else if (o.leasesAs === 'link') { fs.writeFileSync(p('leases.real'), o.leases ?? ''); fs.symlinkSync(p('leases.real'), p('leases')); }
	else fs.writeFileSync(p('leases'), o.leases ?? '');
	for (const [ addr, h ] of Object.entries(o.hosts || {})) {
		fs.mkdirSync(p('hosts/' + addr));
		for (const [ f, v ] of Object.entries(h)) fs.writeFileSync(p('hosts/' + addr + '/' + f), String(v));
	}
	fs.writeFileSync(p('bin/dbclient'), [ '#!/bin/sh', 'S="' + dir + '"', 'for a in "$@"; do case "$a" in root@*) addr=${a#root@};; esac; done',
		'{ echo "argv: $*"; echo "home: $HOME"; echo "known_hosts: $(cat "$HOME/.ssh/known_hosts")"; } >> "$S/dbclient.log"', 'd="$S/hosts/$addr"',
		'[ -d "$d" ] || { echo "dbclient: Connection to root@$addr exited: Connect failed: Connection refused" >&2; exit 1; }',
		'[ -f "$d/err" ] && cat "$d/err" >&2', '[ -f "$d/out" ] && cat "$d/out"', 'exit "$(cat "$d/code" 2>/dev/null || echo 0)"', '' ].join('\n'), { mode: 0o755 });
	fs.writeFileSync(p('bin/kill'), '#!/bin/sh\n: > "' + dir + '/killed.$1"\n', { mode: 0o755 });
	let src = fs.readFileSync(COLLECTOR, 'utf8');
	for (const [ name, rel ] of Object.entries({ KEY: 'etc/vantage/id_ed25519', APS: 'etc/vantage/aps.json', RUN: 'run', ARP: 'arp', LEASES: 'leases', DBCLIENT: 'bin/dbclient', KILL: 'bin/kill' })) {
		const re = new RegExp('^const ' + name + ' = .*$', 'm');
		assert.match(src, re, name);
		src = src.replace(re, () => 'const ' + name + ' = ' + JSON.stringify(p(rel)) + ';');
	}
	/* the double's clock for the kernel's */
	assert.ok(src.includes('\treturn clock(true)?.[0] ?? 0;\n'), 'now()');
	src = src.replace('\treturn clock(true)?.[0] ?? 0;\n', '\treturn int(global.LOOP.now / 1000);\n');
	const script = p('collector.uc'), file = p('steps.json'), stub = p('stub.json');
	fs.writeFileSync(script, src);
	fs.writeFileSync(file, JSON.stringify(steps.map(s => s.write ? { write: [ p(s.write[0]), s.write[1] ] } : s.block ? { block: p(s.block) } : s)));
	fs.writeFileSync(stub, JSON.stringify({ ubus: { 'network.interface dump': o.dump ?? DUMP } }));
	const r = spawnSync(UCODE, ucodeArgs().concat([ '-D', 'CASES=' + file, '-D', 'SANDBOX=' + dir, '-D', 'STUBFILE=' + stub, script ]), { encoding: 'utf8', timeout: 60000 });
	assert.equal(r.status, 0, r.error ? 'the collector did not end: ' + r.error.message : r.stderr);
	const log = fs.existsSync(p('dbclient.log')) ? fs.readFileSync(p('dbclient.log'), 'utf8').trim().split('\n') : [];
	return { results: JSON.parse(r.stdout), log, calls: log.filter(l => l.startsWith('argv: ')), sb: { dir, p } };
}
const ASK = { report: true }, wait = s => ({ advance: s * 1000 });

/* Seen on a 24.10 device: every call that comes through rpcd carries ubus_rpc_session, and ucode's ubus
   answers "Invalid argument" (status 2) to a call with a field its method does not name. With args: {}
   the dashboard and the pairing page were refused, and no access point showed. The sandbox below calls
   the method directly, so it cannot see this: the form is held here */
test('collector: a browser\'s call through rpcd is answered: report names the session rpcd adds, and reads nothing of it', () => {
	const src = fs.readFileSync(COLLECTOR, 'utf8');
	assert.match(src, /\n\t\targs: \{ ubus_rpc_session: '' \}\n\t\}\n\}\)\)\n/);
	assert.equal([ ...src.matchAll(/\bargs:/g) ].length, 1, 'its one method');
	assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /\breq\s*[.\[]/, 'the request is never read');
});

test('collector: nothing runs without a viewer; a viewer gets one fetch per access point every 10 s for 60 s', { skip: NO_UCODE }, () => {
	const idle = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ wait(120) ]);
	assert.deepEqual(idle.calls, [], 'no viewer, no login');
	const { results, calls, log, sb } = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ ASK, wait(2), ASK, wait(118), ASK ]);
	assert.deepEqual(results[0].aps.map(a => [ a.id, a.name, a.addr, a.state, a.error, a.age, a.report ]), [ [ AP1.id, 'ap-hall', '192.0.2.10', 'waiting', null, null, null ] ]);
	assert.equal(results[2].aps[0].state, 'ok');
	/* exactly how dbclient is called: the pinned host key, batch mode, no passwords, a home of its own */
	assert.equal(calls[0], 'argv: -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o PasswordAuthentication=no -i ' + sb.p('etc/vantage/id_ed25519') + ' -p 22 -I 15 root@192.0.2.10 /usr/libexec/vantage/report');
	assert.equal(log[1], 'home: ' + sb.p('run/' + AP1.id));
	assert.equal(log[2], 'known_hosts: 192.0.2.10 ssh-ed25519 ' + K1);
	/* a call at 0 s and one at 2 s keep it going until 62 s: fetches at 0, 10, ... 60,
	   then none until the call at 120 s starts the next one */
	assert.equal(calls.length, 8, calls.length + ' fetches: seven while looked at, one for the last call');
	/* after the pause the last report stands until the next fetch has ended */
	assert.equal(results[4].aps[0].state, 'ok');
	assert.ok(results[4].aps[0].age >= 58, 'age ' + results[4].aps[0].age);
});

test('collector: the report is checked, carries the pairing MAC, and rates come from two reports', { skip: NO_UCODE }, () => {
	const { results } = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } },
		[ ASK, wait(2), ASK, { write: [ 'hosts/192.0.2.10/out', apReport(1, 126000) ] }, wait(10), ASK ]);
	const first = results[2].aps[0].report, second = results[5].aps[0].report;
	assert.equal(first.mac, AP_MAC, 'the MAC of the pairing, not the one it reports');
	assert.equal(first.name, 'calls-itself-1');
	assert.deepEqual(first.ssids, [ { ifname: 'phy0-ap0', bssid: MAC(16), ssid: 'Home', freq: 5180, channel: 36, band: '5g' } ]);
	assert.deepEqual(first.stations, [ { mac: MAC(32), ifname: 'phy0-ap0', signal: -50, rxRate: 866000, txRate: 650000, rx: null, tx: null, connected: 60 } ]);
	assert.deepEqual(first.wired, [ { mac: MAC(48), port: 'lan2', speed: 1000, rx: null, tx: null } ]);
	/* 125000 bytes more in 10 s: 100 kbit/s from the station, twice that to it */
	assert.deepEqual([ second.stations[0].rx, second.stations[0].tx, second.wired[0].rx ], [ 100000, 200000, 100000 ]);
});

test('collector: why a fetch failed, and what the dashboard is told', { skip: NO_UCODE }, () => {
	const cases = [
		[ {}, 'offline', 'unreachable' ],
		[ { '192.0.2.10': { err: 'dbclient: Connection to root@192.0.2.10:22 exited:\n\nssh-ed25519 host key mismatch for 192.0.2.10 !', code: 1 } }, 'error', 'hostkey' ],
		[ { '192.0.2.10': { err: 'dbclient: Connection to root@192.0.2.10:22 exited: No auth methods could be used.', code: 1 } }, 'error', 'denied' ],
		[ { '192.0.2.10': { err: 'ash: /usr/libexec/vantage/report: not found', code: 127 } }, 'error', 'missing' ],
		[ { '192.0.2.10': { out: 'not json' } }, 'error', 'invalid' ],
		[ { '192.0.2.10': { out: JSON.stringify({ v: 2 }) } }, 'error', 'invalid' ],
		[ { '192.0.2.10': { out: 'x'.repeat(200000) } }, 'error', 'invalid' ],
		[ { '192.0.2.10': { hang: '' } }, 'offline', 'timeout' ]
	];
	for (const [ hosts, state, error ] of cases) {
		const { results, sb } = runCollector({ hosts }, [ ASK, wait(17), ASK ]);
		assert.deepEqual([ results[2].aps[0].state, results[2].aps[0].error, results[2].aps[0].report ], [ state, error, null ], error);
		if (error === 'timeout') assert.ok(fs.readdirSync(sb.dir).some(f => /^killed\.\d+$/.test(f)), 'the hung dbclient is killed after 15 s');
		/* what it printed is never left behind, and never more than the size limit allows */
		for (const f of [ 'out', 'err' ]) assert.equal(fs.existsSync(sb.p('run/' + AP1.id + '/' + f)), false, f + ' removed');
	}
});

test('collector: an access point that moved is found by its MAC, the pinned host key deciding', { skip: NO_UCODE }, () => {
	const arp = 'IP address HW type Flags HW address Mask Device\n192.0.2.78 0x1 0x2 ' + AP_MAC + ' * br-lan\n';
	const leases = '1700000000 ' + AP_MAC + ' 192.0.2.77 ap-hall *\n';
	/* gone from 192.0.2.10; another device answers at .77, its old lease, with another host key; it is at .78 */
	const { results, calls, log, sb } = runCollector({ arp, leases, hosts: {
		'192.0.2.77': { err: 'ssh-ed25519 host key mismatch for 192.0.2.77 !', code: 1 },
		'192.0.2.78': { out: apReport(1, 1000) }
	} }, [ ASK, wait(1), ASK, wait(1), ASK, wait(2), ASK, wait(10), ASK ]);
	assert.deepEqual(calls.slice(0, 3).map(c => /root@(\S+)/.exec(c)[1]), [ '192.0.2.10', '192.0.2.77', '192.0.2.78' ]);
	assert.equal(log.filter(l => l.startsWith('known_hosts: '))[2], 'known_hosts: 192.0.2.78 ssh-ed25519 ' + K1, 'the same pinned key at the new address');
	/* while it looks: the error where it was paired, never the other device's */
	assert.deepEqual([ results[2].aps[0].state, results[2].aps[0].error, results[2].aps[0].addr ], [ 'offline', 'unreachable', '192.0.2.10' ]);
	assert.deepEqual([ results[6].aps[0].state, results[6].aps[0].addr ], [ 'offline', '192.0.2.10' ], 'still looking');
	assert.deepEqual([ results[8].aps[0].state, results[8].aps[0].error, results[8].aps[0].addr ], [ 'ok', null, '192.0.2.78' ]);
	assert.equal(/root@(\S+)/.exec(calls[3])[1], '192.0.2.78', 'and from then on there');
	assert.deepEqual(JSON.parse(read(sb, 'etc/vantage/aps.json')), [ AP1 ], 'the paired list is not rewritten');
	/* nothing in the tables: it stays where it was paired */
	const lost = runCollector({ hosts: {} }, [ ASK, wait(25), ASK ]);
	assert.ok(lost.calls.every(c => c.includes('root@192.0.2.10 ')), 'no other address tried');
	/* four leases under its MAC that are not it, ahead of its own (a device of the network asked for them): each is
	   tried once, and then it is found */
	const crowd = [ 201, 202, 203, 204 ].map(n => '1 ' + AP_MAC + ' 192.0.2.' + n + ' x *\n').join('') + '1 ' + AP_MAC + ' 192.0.2.77 x *\n';
	const many = runCollector({ leases: crowd, hosts: { '192.0.2.77': { out: apReport(1, 1000) } } }, [ ASK, wait(30), ASK ]);
	assert.deepEqual([ ...new Set(many.calls.map(c => /root@(\S+)/.exec(c)[1])) ], [ '192.0.2.10', '192.0.2.201', '192.0.2.202', '192.0.2.203', '192.0.2.204', '192.0.2.77' ]);
	assert.deepEqual([ many.results[2].aps[0].state, many.results[2].aps[0].addr ], [ 'ok', '192.0.2.77' ]);
	/* at its new address it answers, and not with a report: the router's key refused there, the add-on gone there, something that is
	   no report. Only the holder of the pinned key gets that far, so it is there, and that is what the dashboard is told */
	const moved = '1 ' + AP_MAC + ' 192.0.2.77 x *\n';
	for (const [ answer, error ] of [ [ { err: 'dbclient: Connection to root@192.0.2.77:22 exited: No auth methods could be used.', code: 1 }, 'denied' ],
		[ { err: 'ash: /usr/libexec/vantage/report: not found', code: 127 }, 'missing' ], [ { out: 'not json' }, 'invalid' ] ]) {
		const at = runCollector({ leases: moved, hosts: { '192.0.2.77': answer } }, [ ASK, wait(15), ASK, wait(15), ASK ]);
		assert.deepEqual([ at.results[2].aps[0].state, at.results[2].aps[0].error, at.results[2].aps[0].addr ], [ 'error', error, '192.0.2.77' ], error);
		assert.ok(at.calls.slice(2).every(c => c.includes('root@192.0.2.77 ')), error + ': asked there from then on');
	}
});

test('collector: an access point is looked for on the network it was paired on only', { skip: NO_UCODE }, () => {
	const row = (ip, dev) => ip + ' 0x1 0x2 ' + AP_MAC + ' * ' + dev + '\n', head = 'IP address HW type Flags HW address Mask Device\n';
	const tried = r => [ ...new Set(r.calls.map(c => /root@(\S+)/.exec(c)[1])) ];
	const steps = [ ASK, wait(1), ASK, wait(30), ASK ];
	/* rows any device of the guest network or the WAN side can make: this router opens no connection to them */
	const elsewhere = head + row('198.51.100.9', 'br-guest') + row('203.0.113.5', 'eth1') + row('192.0.2.50', 'br-guest') + row('203.0.113.77', 'br-lan');
	const hosts = Object.fromEntries([ '198.51.100.9', '203.0.113.5', '192.0.2.50', '203.0.113.77', '198.51.100.20' ].map(a => [ a, { out: apReport(1, 1000) } ]));
	const none = runCollector({ arp: elsewhere, leases: '1 ' + AP_MAC + ' 198.51.100.20 x *\n', hosts }, steps);
	assert.deepEqual(tried(none), [ '192.0.2.10' ]);
	assert.deepEqual([ none.results[4].aps[0].state, none.results[4].aps[0].addr ], [ 'offline', '192.0.2.10' ]);
	/* four such rows ahead of the real one: it is found all the same */
	const planted = head + [ 1, 2, 3, 4 ].map(i => row('198.51.100.' + i, 'br-guest')).join('') + row('192.0.2.90', 'br-lan');
	const found = runCollector({ arp: planted, hosts: { '192.0.2.90': { out: apReport(1, 1000) } } }, steps);
	assert.deepEqual(tried(found), [ '192.0.2.10', '192.0.2.90' ]);
	assert.deepEqual([ found.results[4].aps[0].state, found.results[4].aps[0].addr ], [ 'ok', '192.0.2.90' ]);
	/* paired at an address of no network of this router (behind another router), or with that network down: no search */
	const far = Object.assign({}, AP1, { addr: '198.51.100.200' });
	assert.deepEqual(tried(runCollector({ aps: [ far ], arp: head + row('192.0.2.90', 'br-lan') + row('198.51.100.9', 'br-guest'), hosts }, steps)), [ '198.51.100.200' ]);
	assert.deepEqual(tried(runCollector({ arp: head + row('192.0.2.90', 'br-lan'), dump: { interface: [ Object.assign({}, LAN_IF, { up: false }), GUEST_IF ] }, hosts: { '192.0.2.90': { out: apReport(1, 1000) } } }, steps)), [ '192.0.2.10' ]);
	assert.deepEqual(tried(runCollector({ arp: head + row('192.0.2.90', 'br-lan'), dump: {}, hosts: { '192.0.2.90': { out: apReport(1, 1000) } } }, steps)), [ '192.0.2.10' ]);
	/* paired by an IPv6 address of the LAN: found at an IPv4 address there */
	const v6 = Object.assign({}, AP1, { addr: '2001:db8:1::10' });
	const six = runCollector({ aps: [ v6 ], arp: head + row('192.0.2.90', 'br-lan') + row('203.0.113.5', 'eth1'), hosts: { '192.0.2.90': { out: apReport(1, 1000) } } }, steps);
	assert.deepEqual(tried(six), [ '2001:db8:1::10', '192.0.2.90' ]);
});

test('collector: a pairing that names its network is found again after that network\'s subnet was changed, its old address not asked; looked for nowhere once the network is gone', { skip: NO_UCODE }, () => {
	const row = (ip, dev) => ip + ' 0x1 0x2 ' + AP_MAC + ' * ' + dev + '\n', head = 'IP address HW type Flags HW address Mask Device\n';
	const tried = r => [ ...new Set(r.calls.map(c => /root@(\S+)/.exec(c)[1])) ];
	const last = r => { const a = r.results[r.results.length - 1].aps[0]; return [ a.state, a.addr ]; };
	const steps = [ ASK, wait(1), ASK, wait(30), ASK ], report = { out: apReport(1, 1000) };
	const NAMED = Object.assign({}, AP1, { net: 'lan' });

	/* the LAN renumbered: the subnet it was paired in is no network of this router's any more, and it has a lease in the new one.
	   The address it was paired at is not asked: whoever holds it now is no device of that network (here it would answer, and is not reached) */
	const moved = { interface: [ WAN_IF, LAN_MOVED ] }, lease = '1700000000 ' + AP_MAC + ' 198.51.100.40 ap-hall *\n';
	const found = runCollector({ aps: [ NAMED ], dump: moved, leases: lease, hosts: { '198.51.100.40': report, '192.0.2.10': report } }, steps);
	assert.deepEqual(tried(found), [ '198.51.100.40' ]);
	assert.deepEqual(last(found), [ 'ok', '198.51.100.40' ]);
	assert.equal(found.log.filter(l => l.startsWith('known_hosts: '))[0], 'known_hosts: 198.51.100.40 ssh-ed25519 ' + K1, 'the same pinned key at the new address');
	assert.deepEqual(JSON.parse(read(found.sb, 'etc/vantage/aps.json')), [ NAMED ], 'the paired list is not rewritten');
	/* a pairing of an earlier version names none: its address is on no network now and nothing is searched, as before */
	const old = runCollector({ dump: moved, leases: lease, hosts: { '198.51.100.40': report } }, steps);
	assert.deepEqual([ tried(old), last(old) ], [ [ '192.0.2.10' ], [ 'offline', '192.0.2.10' ] ]);
	/* the pinned key decides in the new subnet too: another device holds its lease's address, it is at the one its neighbour row says */
	const other = runCollector({ aps: [ NAMED ], dump: moved, leases: lease, arp: head + row('198.51.100.41', 'br-lan'),
		hosts: { '198.51.100.40': { err: 'ssh-ed25519 host key mismatch for 198.51.100.40 !', code: 1 }, '198.51.100.41': report } }, steps);
	assert.deepEqual([ tried(other), last(other) ], [ [ '198.51.100.40', '198.51.100.41' ], [ 'ok', '198.51.100.41' ] ]);
	/* and nothing but the pinned key: every address its MAC has there answers with a report under another key. Not found, so
	   offline: no device was asked at the address it was paired at, and what the others showed is not its error */
	const none = runCollector({ aps: [ NAMED ], dump: moved, leases: lease, arp: head + row('198.51.100.41', 'br-lan'),
		hosts: Object.fromEntries([ '192.0.2.10', '198.51.100.40', '198.51.100.41' ].map(a => [ a, { out: apReport(1, 1000), err: 'ssh-ed25519 host key mismatch for ' + a + ' !', code: 1 } ])) }, steps);
	assert.deepEqual([ tried(none), last(none), none.results[4].aps[0].error, none.results[4].aps[0].report ], [ [ '198.51.100.40', '198.51.100.41' ], [ 'offline', '192.0.2.10' ], 'unreachable', null ]);

	/* one network: the named one. The subnet it was paired in is the guests' by now, and a guest made rows under its MAC there, in the
	   WAN's subnet and in the LAN's new one: none of them is followed, only what the LAN's own device heard inside the LAN's subnet */
	const swapped = { interface: [ WAN_IF, LAN_MOVED, { interface: 'guest', up: true, l3_device: 'br-guest', 'ipv4-address': [ { address: '192.0.2.1', mask: 24 } ] } ] };
	const planted = head + row('192.0.2.50', 'br-guest') + row('198.51.100.50', 'br-guest') + row('203.0.113.5', 'eth1') + row('192.0.2.51', 'br-lan');
	const everywhere = Object.fromEntries([ '192.0.2.50', '198.51.100.50', '203.0.113.5', '192.0.2.51', '192.0.2.70' ].map(a => [ a, report ]));
	const kept = runCollector({ aps: [ NAMED ], dump: swapped, arp: planted, leases: '1 ' + AP_MAC + ' 192.0.2.70 x *\n', hosts: everywhere }, steps);
	assert.deepEqual([ tried(kept), last(kept), kept.results[4].aps[0].error ], [ [], [ 'offline', '192.0.2.10' ], 'unreachable' ], 'no connection at all: its old address is a guest\'s now');
	/* (by its address alone, an earlier version's pairing is looked for among the guests there: as before) */
	assert.deepEqual(tried(runCollector({ dump: swapped, arp: planted, hosts: everywhere }, steps)).slice(0, 2), [ '192.0.2.10', '192.0.2.50' ]);

	/* the named network gone (renamed here, its subnet and device as they were), down, or netifd silent: asked where it was
	   paired, as a pairing that names none is, then looked for nowhere, and not on the network the address is on now in its
	   place. Offline, as an access point that cannot be found is */
	const there = { '192.0.2.90': report }, arp = head + row('192.0.2.90', 'br-lan');
	const renamed = { interface: [ WAN_IF, Object.assign({}, LAN_IF, { interface: 'home' }) ] };
	for (const [ what, dump ] of [ [ 'renamed', renamed ], [ 'removed', { interface: [ WAN_IF, GUEST_IF ] } ], [ 'down', { interface: [ Object.assign({}, LAN_IF, { up: false }), GUEST_IF ] } ],
		[ 'no device', { interface: [ Object.assign({}, LAN_IF, { l3_device: null }) ] } ], [ 'no dump', {} ] ]) {
		const gone = runCollector({ aps: [ NAMED ], dump, arp, hosts: there }, steps);
		assert.deepEqual([ tried(gone), last(gone), gone.results[4].aps[0].error ], [ [ '192.0.2.10' ], [ 'offline', '192.0.2.10' ], 'unreachable' ], what);
	}
	/* (an earlier version's pairing is found on the renamed network by its address: as before) */
	assert.deepEqual(last(runCollector({ dump: renamed, arp, hosts: there }, steps)), [ 'ok', '192.0.2.90' ]);
	/* a name that is only like the network's is not it */
	assert.deepEqual(tried(runCollector({ aps: [ Object.assign({}, AP1, { net: 'LAN' }) ], arp, hosts: there }, steps)), [ '192.0.2.10' ]);

	/* nothing changed on the network: with its name an access point is looked for exactly as without it, the same addresses in the
	   same order. Four made-up leases ahead of its own are each tried once, then it is found; rows of other networks are passed over */
	const crowd = [ 201, 202, 203, 204 ].map(n => '1 ' + AP_MAC + ' 192.0.2.' + n + ' x *\n').join('') + '1 ' + AP_MAC + ' 192.0.2.77 x *\n';
	const elsewhere = head + row('198.51.100.9', 'br-guest') + row('203.0.113.5', 'eth1') + row('192.0.2.50', 'br-guest') + row('203.0.113.77', 'br-lan');
	const runs = [ AP1, NAMED ].map(ap => runCollector({ aps: [ ap ], leases: crowd, arp: elsewhere,
		hosts: Object.assign({ '192.0.2.77': report }, Object.fromEntries([ '198.51.100.9', '203.0.113.5', '192.0.2.50', '203.0.113.77' ].map(a => [ a, report ]))) }, [ ASK, wait(30), ASK ]));
	assert.deepEqual(tried(runs[1]), [ '192.0.2.10', '192.0.2.201', '192.0.2.202', '192.0.2.203', '192.0.2.204', '192.0.2.77' ]);
	assert.deepEqual(...runs.map(r => r.calls.map(c => /root@(\S+)/.exec(c)[1])), 'call for call');
	assert.deepEqual(last(runs[1]), [ 'ok', '192.0.2.77' ]);
	/* and the same in the new subnet after a renumbering: each made-up address once, one fetch at a time */
	const crowd2 = [ 201, 202, 203, 204, 205 ].map(n => '1 ' + AP_MAC + ' 198.51.100.' + n + ' x *\n').join('') + lease;
	const late = runCollector({ aps: [ NAMED ], dump: moved, leases: crowd2, hosts: { '198.51.100.40': report } }, [ ASK, wait(30), ASK ]);
	assert.deepEqual(late.calls.slice(0, 6).map(c => /root@(\S+)/.exec(c)[1]), [ '198.51.100.201', '198.51.100.202', '198.51.100.203', '198.51.100.204', '198.51.100.205', '198.51.100.40' ]);
	assert.deepEqual(last(late), [ 'ok', '198.51.100.40' ]);
});

test('collector: after a pause, an access point that had already failed is not shown as fine', { skip: NO_UCODE }, () => {
	const down = [ { write: [ 'hosts/192.0.2.10/out', '' ] }, { write: [ 'hosts/192.0.2.10/code', '1' ] }, { write: [ 'hosts/192.0.2.10/err', '\n' + DBC + 'Connect failed: No route to host\n' ] } ];
	/* fine, then gone while someone still looks; nobody looks for two minutes; the first reply after that */
	const { results } = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ ASK, wait(2), ASK, ...down, wait(20), ASK, wait(120), ASK ]);
	assert.equal(results[2].aps[0].state, 'ok');
	assert.deepEqual([ results[7].aps[0].state, results[7].aps[0].error ], [ 'ok', 'unreachable' ], 'a report under a minute old still stands');
	/* neither fine nor known to be failing still: it waits for the fetch that reply started */
	assert.deepEqual([ results[9].aps[0].state, results[9].aps[0].error, results[9].aps[0].report ], [ 'waiting', null, null ]);
	/* fine when the pause began: its last report stands until the first fetch after it has ended, as before */
	const fine = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ ASK, wait(2), ASK, wait(180), ASK ]);
	assert.equal(fine.results[4].aps[0].state, 'ok');
	/* ... or has failed to start (its known_hosts cannot be written): the old report does not stand on for as long as someone looks */
	const stuck = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } },
		[ ASK, wait(2), ASK, wait(180), { block: 'run/' + AP1.id + '/.ssh/known_hosts' }, ASK, wait(2), ASK, wait(30), ASK ]);
	/* from the very reply that tried to start it */
	for (const i of [ 5, 7, 9 ]) assert.deepEqual([ stuck.results[i].aps[0].state, stuck.results[i].aps[0].error, stuck.results[i].aps[0].report ], [ 'offline', 'unreachable', null ], 'reply ' + i);
});

test('collector: nothing is left of an access point that was removed', { skip: NO_UCODE }, () => {
	const home = sb => sb.p('run/' + AP1.id), gone = { write: [ 'etc/vantage/aps.json', '[]' ] };
	const a = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ ASK, wait(2), ASK ]);
	assert.ok(fs.existsSync(home(a.sb) + '/.ssh/known_hosts'), 'while it is paired: its known_hosts');
	const b = runCollector({ hosts: { '192.0.2.10': { out: apReport(1, 1000) } } }, [ ASK, wait(2), ASK, gone, ASK ]);
	assert.deepEqual([ b.results[4].aps, fs.existsSync(home(b.sb)) ], [ [], false ]);
	/* removed while a fetch for it hangs: cleared once that fetch has been ended */
	const c = runCollector({ hosts: { '192.0.2.10': { hang: '' } } }, [ ASK, wait(1), gone, ASK, wait(20), ASK ]);
	assert.equal(fs.existsSync(home(c.sb)), false);
	/* removed and paired again while it hangs: the new pairing's files stay */
	const d = runCollector({ hosts: { '192.0.2.10': { hang: '' } } }, [ ASK, wait(1), gone, ASK, { write: [ 'etc/vantage/aps.json', JSON.stringify([ AP1 ]) ] }, ASK, wait(1), ASK, wait(16), ASK ]);
	assert.equal(d.results[d.results.length - 1].aps.length, 1);
	assert.ok(fs.existsSync(home(d.sb) + '/.ssh/known_hosts'), 'after the old fetch was ended: the new pairing\'s known_hosts is there');
});

test('collector: a device at the old address that never shows the pinned key does not end the search', { skip: NO_UCODE }, () => {
	const arp = 'IP address HW type Flags HW address Mask Device\n192.0.2.77 0x1 0x2 ' + AP_MAC + ' * br-lan\n';
	const there = { '192.0.2.77': { out: apReport(1, 1000) } };
	/* what real dbclient writes for a version line of the other end's choosing, and for a disconnect sent before any key (it ends with 0) */
	for (const [ err, code ] of [ [ "Incompatible remote version 'SSH-1.5-Permission denied'", 1 ], [ "Incompatible remote version 'SSH-1.5-ash: /usr/libexec/vantage/report: not found'", 1 ], [ 'Disconnect received', 0 ] ]) {
		const { results, calls } = runCollector({ arp, hosts: Object.assign({ '192.0.2.10': { err: '\n' + DBC + err + '\n', code } }, there) }, [ ASK, wait(1), ASK, wait(3), ASK ]);
		assert.deepEqual([ results[2].aps[0].state, results[2].aps[0].error ], [ 'offline', 'unreachable' ], err);
		assert.deepEqual(calls.slice(0, 2).map(c => /root@(\S+)/.exec(c)[1]), [ '192.0.2.10', '192.0.2.77' ], err);
		assert.deepEqual([ results[4].aps[0].state, results[4].aps[0].addr ], [ 'ok', '192.0.2.77' ], err);
	}
	/* the access point itself, key shown, refusing this router: that is its answer, and it is looked for nowhere else */
	const refused = runCollector({ arp, hosts: Object.assign({ '192.0.2.10': { err: '\n' + DBC + 'No auth methods could be used.\n', code: 1 } }, there) }, [ ASK, wait(25), ASK ]);
	assert.deepEqual([ refused.results[2].aps[0].state, refused.results[2].aps[0].error ], [ 'error', 'denied' ]);
	assert.ok(refused.calls.every(c => c.includes('root@192.0.2.10 ')));
});

test('collector: the leases are read only as a plain file; a FIFO under their name does not hold the daemon', { skip: NO_UCODE }, () => {
	const leases = '1700000000 ' + AP_MAC + ' 192.0.2.78 ap-hall *\n', there = { '192.0.2.78': { out: apReport(1, 1000) } };
	const steps = [ ASK, wait(1), ASK, wait(12), ASK ];
	assert.equal(runCollector({ leases, hosts: there }, steps).results[4].aps[0].addr, '192.0.2.78', 'a plain file: found by its lease');
	for (const leasesAs of [ 'fifo', 'link' ]) {
		/* with the name opened as it comes, the FIFO never returns from open(): this run would end in the harness's timeout */
		const { results, calls } = runCollector({ leases, leasesAs, hosts: there }, steps);
		assert.deepEqual([ results[4].aps[0].state, results[4].aps[0].addr ], [ 'offline', '192.0.2.10' ], leasesAs);
		assert.ok(calls.length >= 2 && calls.every(c => c.includes('root@192.0.2.10 ')), leasesAs + ': no address from it');
	}
});

test('collector: a report is counted before it is parsed', { skip: NO_UCODE }, () => {
	/* 128 KiB of empty objects took 66 MB to parse, for a report normalize() then empties */
	const head = '{"v":1,"name":"x","ssids":[', objects = n => head + Array(n).fill('{}').join(',') + ']}';
	const hostile = objects(Math.floor((131072 - head.length - 2 + 1) / 3));
	assert.ok(hostile.length <= 131072 && hostile.length > 131000 && JSON.parse(hostile).v === 1, 'within the size limit, and JSON');
	for (const out of [ hostile, objects(1280), '{"v":1,"x":[' + Array(4098).fill('0').join(',') + ']}' ]) {
		const { results } = runCollector({ hosts: { '192.0.2.10': { out } } }, [ ASK, wait(2), ASK ]);
		assert.deepEqual([ results[2].aps[0].state, results[2].aps[0].error, results[2].aps[0].report ], [ 'error', 'invalid', null ], out.length + ' bytes');
	}
	/* the fullest report an access point can make, every free text of it nothing but braces or commas, still passes */
	const full = fill => JSON.stringify({ v: 1, name: fill.repeat(63), model: fill.repeat(64), uptime: 1, mac: MAC(99),
		ssids: Array.from({ length: 16 }, (_, i) => ({ ifname: 'w' + i, bssid: MAC(i), ssid: fill.repeat(32), freq: 5180, channel: 36 })),
		stations: Array.from({ length: 256 }, (_, i) => ({ mac: '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), ifname: 'w' + (i % 16),
			signal: -50, rx_rate: 866000, tx_rate: 650000, rx_bytes: 1, tx_bytes: 2, connected: 60 })),
		ports: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [ 'lan' + i, { speed: 1000, rx_bytes: 1, tx_bytes: 1, hosts: 4 } ])),
		wired: Array.from({ length: 128 }, (_, i) => ({ mac: '02:00:5e:01:00:' + i.toString(16).padStart(2, '0'), port: 'lan' + (i % 32) })) });
	for (const fill of [ '{', '[', ',' ]) {
		const { results } = runCollector({ hosts: { '192.0.2.10': { out: full(fill) } } }, [ ASK, wait(2), ASK ]);
		const r = results[2].aps[0].report;
		assert.deepEqual([ results[2].aps[0].state, r.ssids.length, r.stations.length, r.wired.length, r.ssids[0].ssid ], [ 'ok', 16, 256, 128, fill.repeat(32) ], 'full of ' + fill);
	}
	/* the two counts, to the byte */
	const P = t => [ 'parseable', t ];
	assert.deepEqual(runModule([ P('{}'), P('['.repeat(1280)), P('['.repeat(1281)), P('{'.repeat(1281)), P('{'.repeat(640) + 'x' + '['.repeat(641)), P(','.repeat(4096)), P(','.repeat(4097)),
		P('{}\u0000' + '{'.repeat(2000)), P(null), P(7) ]), [ true, true, false, false, false, true, false, false, false, false ]);
});

test('collector: the paired list is read again when it changes, even within a second; 1024 stations in a reply', { skip: NO_UCODE }, () => {
	const many = n => JSON.stringify({ v: 1, name: 'x', ssids: [ { ifname: 'w0', freq: 2437 } ],
		stations: Array.from({ length: 256 }, (_, i) => ({ mac: '02:00:5e:' + n.toString(16).padStart(2, '0') + ':' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), ifname: 'w0' })) });
	const aps = Array.from({ length: 5 }, (_, i) => ({ id: (0xb0 + i).toString(16).padStart(16, '0'), name: 'ap' + i, key: key(60 + i), addr: '192.0.2.' + (20 + i), port: 22, mac: MAC(0x70 + i) }));
	const hosts = Object.fromEntries(aps.map((a, i) => [ a.addr, { out: many(i) } ]));
	const { results } = runCollector({ aps, hosts }, [ ASK, wait(2), ASK, { write: [ 'etc/vantage/aps.json', JSON.stringify(aps.slice(1)) ] }, ASK,
		{ write: [ 'etc/vantage/aps.json', JSON.stringify(aps.slice(1).concat([ AP2 ])) ] }, ASK ]);
	assert.deepEqual(results[2].aps.map(a => a.report.stations.length), [ 256, 256, 256, 256, 0 ], '1024 in all, the first access points first');
	assert.deepEqual(results[4].aps.map(a => a.name), [ 'ap1', 'ap2', 'ap3', 'ap4' ], 'removed at once');
	assert.deepEqual(results[6].aps.map(a => a.name), [ 'ap1', 'ap2', 'ap3', 'ap4', 'ap-den' ], 'and added, in the same second');
	assert.equal(results[6].aps[4].state, 'waiting');
});
