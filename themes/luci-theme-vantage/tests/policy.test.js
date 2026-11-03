'use strict';
/* dev/replay/policy.js: which LuCI requests are read-only, how bodies are
   parsed (like json-c and cgi-io do on the device), and what is scrubbed
   from recorded data. */
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../dev/replay/policy');

const BASE = 'https://device.example';
const SID = '0123456789abcdef0123456789abcdef';
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSONH = { 'Content-Type': 'application/json' };
const req = (method, p, postData, headers) => ({ url: BASE + p, method, postData, headers: headers || {} });
const decide = (...a) => policy.classify(req(...a), BASE);
const call = (object, method, args, id) => ({ jsonrpc: '2.0', id: id || 1, method: 'call', params: [ SID, object, method, args || {} ] });
const rpcBody = (...c) => JSON.stringify(c.length === 1 ? c[0] : c);
const exec = cmd => `sessionid=${SID}&command=${cmd}&stderr=0`;

test('policy: pages, static files and read-only RPC go through', () => {
	assert.deepEqual(decide('GET', '/cgi-bin/luci/'), { ok: true, kind: null });
	assert.equal(decide('GET', '/cgi-bin/luci/admin/menu').kind, 'http');
	assert.equal(decide('GET', '/luci-static/resources/luci.js').kind, 'static');
	assert.equal(decide('HEAD', '/').ok, true);
	const r = decide('POST', '/ubus/?session/list', ' ' + rpcBody(call('session', 'list')), JSONH);
	assert.equal(r.kind, 'rpc');
	assert.equal(r.postData, rpcBody(call('session', 'list')), 'forwarded body is the re-serialised one');
	assert.equal(decide('POST', '/ubus', rpcBody(call('file', 'exec', { command: '/bin/dmesg', params: [ '-r' ] })), JSONH).ok, true);
});

test('policy: writes and everything not on an allowlist are refused', () => {
	const no = (...a) => assert.equal(decide(...a).ok, false, a.slice(0, 2).join(' '));
	no('POST', '/ubus/', rpcBody(call('system', 'reboot')), JSONH);
	no('POST', '/ubus/', rpcBody(call('session', 'list'), call('uci', 'set', { config: 'x' }, 2)), JSONH);
	no('POST', '/ubus/', rpcBody(call('iwinfo', 'scan', { device: 'radio0' })), JSONH);
	no('POST', '/ubus/', rpcBody(call('file', 'exec', { command: '/sbin/reboot' })), JSONH);
	no('POST', '/ubus/', rpcBody(call('file', 'exec', { command: '/bin/dmesg', params: [ '-r' ], env: { A: '1' } })), JSONH);
	/* uhttpd's REST routes and other ubus spellings */
	no('POST', '/ubus/call/system', rpcBody(call('system', 'reboot')), JSONH);
	no('GET', '/ubus/list');
	no('GET', '/ubus/subscribe/x');
	no('POST', '/ubus%2Fcall/system', '{}', JSONH);
	/* cgi-io endpoints, also with PATH_INFO or encoded names */
	no('POST', '/cgi-bin/cgi-upload', 'x=1', FORM);
	no('POST', '/cgi-bin/cgi-download', `sessionid=${SID}&path=/etc/shadow`, FORM);
	no('GET', '/cgi-bin/cgi-backup');
	no('POST', '/cgi-bin/cgi-exec/x', exec('/bin/dmesg%20-r'), FORM);
	no('POST', '/cgi-bin/cgi%2Dexec', exec('/sbin/reboot'), FORM);
	no('GET', '/cgi-bin/luci2');
	/* LuCI apply/revert and legacy flash/reboot, any verb */
	no('POST', '/cgi-bin/luci/admin/uci/apply_unchecked?sid=' + SID, '', FORM);
	no('GET', '/cgi-bin/luci/admin/uci/revert');
	no('GET', '/cgi-bin/luci/admin/system/flash/reset');
	no('PUT', '/cgi-bin/luci/admin/status', 'x');
	no('DELETE', '/luci-static/x');
	no('POST', '/', 'a=1', FORM);
	/* other hosts and other spellings of the device */
	assert.equal(policy.classify({ url: 'http://device.example/ubus/', method: 'POST', postData: rpcBody(call('system', 'reboot')) }, BASE).ok, false);
	assert.equal(policy.classify({ url: 'https://device.example:8443/cgi-bin/luci/', method: 'GET' }, BASE).ok, false);
	assert.equal(policy.classify({ url: 'https://elsewhere.example/', method: 'GET' }, BASE).ok, false);
	/* service worker scripts, odd paths */
	no('GET', '/sw.js', undefined, { 'Service-Worker': 'script' });
	no('GET', '/cgi-bin/luci/%2e%2e/cgi-exec');
	no('GET', '/luci-static/a%00b');
});

test('policy: the login exception is only the sysauth form', () => {
	const login = 'luci_username=root&luci_password=p%40ss+word';
	assert.deepEqual(decide('POST', '/cgi-bin/luci/', login, FORM), { ok: true, kind: 'login' });
	assert.equal(decide('POST', '/cgi-bin/luci/admin/status/overview', login, FORM).kind, 'login');
	assert.equal(decide('POST', '/cgi-bin/luci', 'luci_password=x&luci_username=root', { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }).kind, 'login');
	const no = (p, body, headers) => assert.equal(decide('POST', p, body, headers || FORM).ok, false, p + ' ' + body);
	no('/cgi-bin/luci/admin/system/flash', login + '&reset=1');
	no('/cgi-bin/luci/admin/uci/apply_unchecked', login + '&token=' + SID);
	no('/cgi-bin/luci/', login + '&luci_username=x');
	no('/cgi-bin/luci/', 'luci_username=root');
	no('/cgi-bin/luci/', 'luci_username=root&luci_password=a=b');
	no('/cgi-bin/luci/?token=' + SID, login);
	no('/cgi-bin/luci/', login, JSONH);
	no('/cgi-bin/luci/', login, {});
	no('/ubus/call/system', rpcBody(call('system', 'reboot')).replace('{', '{"luci_username":"","luci_password":"",'));
	no('/cgi-bin/cgi-upload', login);
	no('/cgi-bin/cgi-exec/x', `${login}&sessionid=${SID}&command=/sbin/reboot`);
	no('/other', login);
	assert.equal(decide('PUT', '/cgi-bin/luci/', login, FORM).ok, false);
});

test('policy: cgi-exec bodies are read exactly like cgi-io reads them', () => {
	const ok = policy.parseCgiExec(exec('%2Fbin%2Fdmesg%20-r'));
	assert.deepEqual(ok.argv, [ '/bin/dmesg', '-r' ]);
	assert.equal(ok.canonical, exec('%2Fbin%2Fdmesg%20-r'));
	assert.deepEqual(policy.parseCgiExec(`sessionid=${SID}&command=/bin/dmesg+-r`).argv, [ '/bin/dmesg', '-r' ]);
	assert.equal(policy.parseCgiExec(`sessionid=${SID}&command=/bin/dmesg+-r`).canonical, `sessionid=${SID}&command=%2Fbin%2Fdmesg%20-r`);
	/* escaped whitespace stays inside one argument, as fs.exec_direct sends it */
	assert.deepEqual(policy.parseCgiExec(`sessionid=${SID}&command=${encodeURIComponent('/bin/echo a\\ b c\\\\d')}`).argv, [ '/bin/echo', 'a b', 'c\\d' ]);
	const bad = body => assert.equal(policy.parseCgiExec(body).ok, false, body);
	bad(`sessionid=${SID}&command=/usr/sbin/iptables-save&command=/sbin/reboot`);   /* cgi-io keeps the last */
	bad(`sessionid=${SID}&%63ommand=/usr/sbin/iptables-save&command=/sbin/firstboot`);
	bad(`sessionid=${SID}&command=/bin/dmesg%20-r&filename=x`);
	bad(`sessionid=${SID}&command=/bin/dmesg%20-r&stderr=1&stderr=0`);
	bad(`sessionid=${SID}&command=x=/sbin/reboot`);   /* a raw '=' restarts cgi-io's key match */
	bad(`sessionid=${SID}&command=/bin/dmesg%2`);
	bad(`sessionid=${SID}&command=/bin/dmesg%00-r`);
	bad(`sessionid=${SID}&command=/bin/dmesg%09-r`);
	bad(`sessionid=${SID}&command=%20/bin/dmesg`);   /* not canonical */
	bad(`sessionid=${SID}&command=/bin/dmesg%20%20-r`);
	bad(`sessionid=${SID}&command=%FF`);
	bad(`sessionid=${SID}&command=`);
	bad(`sessionid=${SID}&command`);
	bad('command=/bin/dmesg%20-r');
	bad(`sessionid=nothex&command=/bin/dmesg%20-r`);
	assert.equal(decide('POST', '/cgi-bin/cgi-exec', exec('/sbin/reboot'), FORM).ok, false);
	const r = decide('POST', '/cgi-bin/cgi-exec', `sessionid=${SID}&command=/usr/sbin/nft+--terse+--json+list+ruleset`, FORM);
	assert.equal(r.kind, 'exec');
	assert.equal(r.postData, `sessionid=${SID}&command=%2Fusr%2Fsbin%2Fnft%20--terse%20--json%20list%20ruleset`);
	assert.deepEqual(policy.cgiExecArgv(r.postData), [ '/usr/sbin/nft', '--terse', '--json', 'list', 'ruleset' ]);
});

test('policy: JSON-RPC bodies json-c could read differently are refused', () => {
	const list = call('session', 'list');
	const bad = (body, why) => assert.equal(policy.rpcAllowed(body).ok, false, why);
	/* json-c cuts keys at NUL, so "params\u0000" would replace "params" */
	bad(JSON.stringify(list).replace('"params":', '"params\\u0000":["x","system","reboot",{}],"params":'), 'NUL in a key');
	bad(JSON.stringify(call('file', 'exec', { command: '/bin/dmesg', params: [ '-r' ] })).replace('"command":', '"command\\u0000x":"/sbin/reboot","command":'), 'NUL key in args');
	bad(JSON.stringify(list).replace('"id":1', '"id":1,"id":2'), 'duplicate key');
	bad(JSON.stringify(list).replace('"session"', '"session\\u0000x"'), 'NUL in a string');
	bad(JSON.stringify(list).replace('"session"', '"sess\\u001bion"'), 'control character');
	bad(JSON.stringify(list).replace('"session"', '"\\ud800session"'), 'lone surrogate');
	bad(JSON.stringify(Object.assign({ extra: 1 }, list)), 'unknown message key');
	bad(JSON.stringify(Object.assign({}, list, { jsonrpc: '1.0' })), 'wrong version');
	bad(JSON.stringify({ jsonrpc: '2.0', method: 'call', params: list.params }), 'no id');
	bad(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ SID, 'session', 'list', [] ] }), 'args not an object');
	bad(JSON.stringify(list) + ' x', 'trailing data');
	bad('[]', 'empty batch');
	bad('{"jsonrpc":"2.0",/*c*/"id":1}', 'comments');
	bad('[' + '['.repeat(100) + ']'.repeat(100) + ']', 'too deep');
	const ok = policy.rpcAllowed('[ ' + JSON.stringify(list) + ' , ' + JSON.stringify(call('system', 'board', {}, 2)) + ' ]');
	assert.equal(ok.ok, true);
	assert.equal(ok.canonical, JSON.stringify([ list, call('system', 'board', {}, 2) ]));
	/* "__proto__" is a plain key, not a prototype */
	const p = policy.strictJson('{"__proto__":{"x":1}}');
	assert.equal(Object.getPrototypeOf(p), null);
	assert.deepEqual(Object.keys(p), [ '__proto__' ]);
});

test('policy: secrets are removed from values, text and command lines', () => {
	const R = policy.REDACTED;
	for (const k of [ 'key', 'key2', 'password', 'password2', 'priv_key2_pwd', 'r0kh', 'r1kh', 'passphrase', 'auth_key', 'authkey',
		'community', 'credentials', 'wpa_psk', 'sae_password', 'private_key', 'PrivateKey', 'api_key', 'ddns_password', 'mqtt_token' ])
		assert.equal(policy.sanitize({ [k]: 'v' })[k], R, k);
	for (const k of [ 'ssid', 'keys', 'hostname', 'macaddr', 'encryption', 'monkey' ])
		assert.equal(policy.sanitize({ [k]: 'v' })[k], 'v', k);

	const text = policy.scrubText([
		"config wifi-iface 'x'",
		"\toption ssid 'Home'",
		"\toption key 'pa55phrase'",
		"\tlist r0kh 'aa,bb,cc'",
		'wpa_passphrase=pa55phrase',
		'sae_password = pa55phrase',
		'PrivateKey = cGFzc3BocmFzZXBhc3NwaHJhc2VwYXNzcGhyYXNlMTI=',
		'export API_TOKEN=abc123',
		'*/5 * * * * wget -q -O- "https://ddns.example/update?host=a&token=s3cr3t&x=1"',
		'root:$2b$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz012345:19000:0:99999:7:::',
		'admin:$6$salt$hash:1',
		'Authorization: Bearer abcdefghijkl'
	].join('\n'));
	assert.doesNotMatch(text, /pa55phrase|cGFzc3|abc123|s3cr3t|\$2b\$|\$6\$|abcdefghijkl/);
	assert.match(text, /option ssid 'Home'/);
	assert.match(text, /host=a&token=<redacted>&x=1/);

	/* argv: per-binary flags only */
	const svc = policy.sanitize({ rtty: { instances: { i: { command: [ '/usr/sbin/rtty', '-I', 'dev', '-t', 'deadbeefdeadbeef', '-a' ] } } },
		uhttpd: { instances: { i: { command: [ '/usr/sbin/uhttpd', '-f', '-h', '/www', '-t', '60', '-T', '30' ] } } },
		rpcd: { instances: { i: { command: [ '/sbin/rpcd', '-s', '/var/run/ubus/ubus.sock', '-t', '30' ] } } },
		dropbear: { instances: { i: { command: [ '/usr/sbin/dropbear', '-F', '-P', '/var/run/dropbear.pid', '-p', '22' ] } } },
		ntpd: { instances: { i: { command: [ '/usr/sbin/ntpd', '-n', '-N', '-p', '0.openwrt.pool.ntp.org' ] } } },
		x: { instances: { i: { command: [ '/usr/bin/tool', '--password=hunter2', '--token', 'abc' ] } } } });
	assert.deepEqual(svc.rtty.instances.i.command, [ '/usr/sbin/rtty', '-I', 'dev', '-t', R, '-a' ]);
	assert.deepEqual(svc.uhttpd.instances.i.command.slice(-4), [ '-t', '60', '-T', '30' ]);
	assert.deepEqual(svc.rpcd.instances.i.command.slice(-2), [ '-t', '30' ]);
	assert.deepEqual(svc.dropbear.instances.i.command.slice(-2), [ '-p', '22' ]);
	assert.deepEqual(svc.ntpd.instances.i.command.slice(-2), [ '-p', '0.openwrt.pool.ntp.org' ]);
	assert.deepEqual(svc.x.instances.i.command, [ '/usr/bin/tool', '--password=' + R, '--token', R ]);
	const ps = policy.sanitize([ { PID: 1, COMMAND: '/usr/sbin/rtty -I dev -t deadbeefdeadbeef' }, { PID: 2, COMMAND: '/usr/sbin/uhttpd -t 60' } ]);
	assert.equal(ps[0].COMMAND, '/usr/sbin/rtty -I dev -t ' + R);
	assert.equal(ps[1].COMMAND, '/usr/sbin/uhttpd -t 60');
});

test('policy: file contents are kept only for non-secret system files', () => {
	const R = policy.REDACTED;
	const read = (p, data) => policy.sanitizeResult('file', 'read', { path: p }, [ 0, { data } ]);
	for (const p of [ '/etc/rc.local', '/etc/crontabs/root', '/etc/config/wireless', '/etc/shadow', '/etc/dropbear/authorized_keys',
		'/proc/123/cmdline', '/proc/self/environ', '/proc/../etc/shadow', '/etc/uhttpd.key', '/root/.ash_history', '/tmp/x' ])
		assert.deepEqual(read(p, 'secret'), [ 0, { data: R } ], p);
	for (const p of [ '/proc/cpuinfo', '/proc/sys/kernel/hostname', '/proc/sys/net/netfilter/nf_conntrack_count', '/etc/board.json',
		'/etc/iproute2/rt_tables', '/etc/sysupgrade.conf', '/sys/class/net/eth0/address' ])
		assert.deepEqual(read(p, 'content'), [ 0, { data: 'content' } ], p);
	assert.deepEqual(policy.sanitizeResult('file', 'read', { path: '/etc/rc.local' }, [ 4 ]), [ 4 ]);
	/* other calls are sanitized as values */
	assert.deepEqual(policy.sanitizeResult('uci', 'get', { config: 'wireless' }, [ 0, { values: { x: { key: 'k', ssid: 's' } } } ]),
		[ 0, { values: { x: { key: R, ssid: 's' } } } ]);
});
