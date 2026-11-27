'use strict';
/* dev/replay/server.js over HTTP: DNS-rebinding and cross-site guards, the
   login session on ubus/cgi-exec/apply, response hardening, the escaped 404
   page and control characters kept off the terminal.

   Needs the private mirror ($VANTAGE_MIRROR or ../vantage-mirror) and a
   rootfs dump ($VANTAGE_ROOTFS or the server's default); skipped without
   them. Listens on a free port in 8230-8239 on 127.0.0.1. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIRROR = process.env.VANTAGE_MIRROR || path.join(ROOT, '..', 'vantage-mirror');
const ROOTFS = process.env.VANTAGE_ROOTFS || path.join(ROOT, '../vantage-rootfs');
const ready = fs.existsSync(MIRROR) && fs.existsSync(path.join(ROOTFS, 'usr/share/ucode/luci/template/view.ut'));
const skip = !ready && 'no mirror or rootfs dump';

/* from a place of this process's own in the range: two runs side by side
   would both find the first free port free, and one would talk to the
   other's server. A range of its own too: replay-fixtures.test.js runs
   beside this file and takes its port from 8221-8229 */
async function freePort() {
	for (let i = 0; i < 10; i++) {
		const p = 8230 + (process.pid + i) % 10;
		const ok = await new Promise(res => {
			const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true)));
		});
		if (ok) return p;
	}
	throw new Error('no free port in 8230-8239');
}

/* raw request, so Host / Origin can be anything */
function request(port, method, p, { headers, body } = {}) {
	return new Promise((resolve, reject) => {
		const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: Object.assign({ Host: `127.0.0.1:${port}` }, headers || {}) }, res => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
		});
		r.on('error', reject);
		if (body != null) r.write(body);
		r.end();
	});
}

const rpc = (sid, object, method, args, id) => JSON.stringify({ jsonrpc: '2.0', id: id || 1, method: 'call', params: [ sid, object, method, args || {} ] });
const ZERO = '0'.repeat(32);
const JSONH = { 'Content-Type': 'application/json' };

test('replay server: host, origin, session, headers, escaping, logs', { skip, timeout: 60000 }, async () => {
	const port = await freePort();
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', String(port),
		'--theme-dir', path.join(ROOT, 'luci-theme-vantage/htdocs/luci-static/vantage'), '--theme', 'vantage', '--app-dir', path.join(ROOT, 'luci-app-vantage'), '--demo' ],
	{ stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let log = '';
	srv.stderr.on('data', d => { log += d; });
	try {
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /\[replay\] http:\/\//, log);
		const req = (...a) => request(port, ...a);

		/* DNS rebinding: only our own names */
		for (const host of [ 'evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1' ]) {
			const r = await req('POST', '/ubus/', { headers: Object.assign({ Host: host }, JSONH), body: rpc(ZERO, 'luci', 'getFeatures') });
			assert.equal(r.status, 421, host);
			assert.doesNotMatch(r.body, /jsonrpc/);
		}
		for (const host of [ `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}` ])
			assert.equal((await req('GET', '/', { headers: { Host: host } })).status, 302, host);

		/* hardening on every response */
		const root = await req('GET', '/');
		assert.equal(root.headers['x-content-type-options'], 'nosniff');
		assert.equal(root.headers['x-frame-options'], 'DENY');
		const stat = await req('GET', '/luci-static/resources/luci.js');
		assert.equal(stat.status, 200);
		assert.equal(stat.headers['x-content-type-options'], 'nosniff');

		/* cross-site writes and text/plain simple requests */
		assert.equal((await req('POST', '/ubus/', { headers: { 'Content-Type': 'text/plain' }, body: rpc(ZERO, 'luci', 'getFeatures') })).status, 415);
		assert.equal((await req('POST', '/ubus/', { headers: Object.assign({ Origin: 'http://evil.example' }, JSONH), body: rpc(ZERO, 'luci', 'getFeatures') })).status, 403);
		assert.equal((await req('POST', '/ubus/', { headers: Object.assign({ 'Sec-Fetch-Site': 'cross-site' }, JSONH), body: rpc(ZERO, 'luci', 'getFeatures') })).status, 403);
		assert.equal((await req('POST', '/ubus/', { headers: Object.assign({ 'Sec-Fetch-Site': 'same-site', Origin: `http://127.0.0.1:${port + 1}` }, JSONH), body: '[]' })).status, 403);
		assert.equal((await req('POST', '/cgi-bin/luci/', { headers: { Origin: 'null', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'luci_username=a&luci_password=b' })).status, 403);
		assert.equal((await req('POST', '/cgi-bin/luci/', { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'luci_username=a&luci_password=b' })).status, 403);
		assert.equal((await req('POST', '/ubus/', { headers: Object.assign({ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'same-origin' }, JSONH), body: '[]' })).status, 403);
		/* a same-origin form post may say "Origin: null" (sandboxed or no-referrer contexts) */
		assert.equal((await req('POST', '/cgi-bin/luci/', { headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'luci_username=a&luci_password=b' })).status, 302);
		assert.equal((await req('POST', '/ubus/', { headers: Object.assign({ Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' }, JSONH), body: '[]' })).status, 200);

		/* without the login session: only rpcd's unauthenticated ACL */
		const anon = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: `[${rpc(ZERO, 'system', 'board')},${rpc(ZERO, 'luci', 'getFeatures', {}, 2)},${rpc(ZERO, 'uci', 'set', { config: 'network', section: 'lan', values: { x: '1' } }, 3)}]` })).body);
		assert.equal(anon[0].error.code, -32002);
		assert.ok(anon[1].result, 'luci.getFeatures is unauthenticated');
		assert.equal(anon[2].error.code, -32002);

		/* login, then the page carries the session */
		const login = await req('POST', '/cgi-bin/luci/', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${port}` }, body: 'luci_username=root&luci_password=x' });
		assert.equal(login.status, 302);
		const cookie = login.headers['set-cookie'][0].split(';')[0];
		const sid = cookie.split('=')[1];
		assert.match(sid, /^[0-9a-f]{32}$/);
		const page = await req('GET', '/cgi-bin/luci/', { headers: { Cookie: cookie } });
		assert.equal(page.status, 200);
		assert.match(page.headers['content-security-policy'] || '', /frame-ancestors 'none'/);
		assert.ok(page.body.includes(sid), 'L.env.sessionid');
		assert.equal((await req('GET', '/cgi-bin/luci/', { headers: { Cookie: 'sysauth_http=' + 'f'.repeat(32) } })).status, 403, 'any other cookie is logged out');

		/* dashboard calls with the session */
		const dash = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: `[${rpc(sid, 'system', 'board')},${rpc(sid, 'system', 'info', {}, 2)},${rpc(sid, 'network.wireless', 'status', {}, 3)}]` })).body);
		assert.equal(dash[0].result[0], 0);
		assert.equal(typeof dash[0].result[1].hostname, 'string');
		assert.equal(dash[1].result[0], 0);
		assert.equal(dash[2].result[0], 0);

		/* without --wg there is no luci-proto-wireguard: its group is not held, its object absent (as uhttpd says it);
		   the other groups are held as before */
		const access = (group, id) => rpc(sid, 'session', 'access', { scope: 'access-group', object: group, function: 'read' }, id);
		const nowg = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: `[${access('luci-proto-wireguard', 1)},${access('luci-app-vantage', 2)},${rpc(sid, 'luci.wireguard', 'getWgInstances', {}, 3)},${rpc(sid, 'luci.wireguard', 'generateKeyPair', {}, 4)}]` })).body);
		assert.deepEqual(nowg.map(r => r.result || r.error), [ [ 0, { access: false } ], [ 0, { access: true } ], { code: -32000, message: 'Object not found' }, { code: -32000, message: 'Object not found' } ]);
		/* nor, without --traffic, luci-app-vantage-traffic */
		const notraffic = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: `[${access('luci-app-vantage-traffic', 1)},${rpc(sid, 'luci.vantage.traffic', 'hosts', {}, 2)}]` })).body);
		assert.deepEqual(notraffic.map(r => r.result || r.error), [ [ 0, { access: false } ], { code: -32000, message: 'Object not found' } ]);

		/* app plugin stand-ins (dev/replay/*-plugin.js) are loaded and answer */
		for (const f of fs.readdirSync(path.join(ROOT, 'dev/replay')).filter(f => /-plugin\.js$/.test(f))) {
			const mod = require(path.join(ROOT, 'dev/replay', f));
			for (const o of Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ]) {
				assert.match(log, new RegExp('plugins: .*' + o.replace(/\./g, '\\.')));
				const m = Object.keys(mod.POLICY || {})[0];
				if (!m) continue;
				const r = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc(sid, o, m) })).body);
				assert.ok(Array.isArray(r.result), `${o}.${m} answered`);
				const anonR = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc(ZERO, o, m) })).body);
				assert.equal(anonR.error && anonR.error.code, -32002, `${o}.${m} needs the session`);
			}
		}
		const vw = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc(sid, 'luci.vantage', 'wireless') })).body);
		assert.equal(vw.result[0], 0);
		assert.equal(typeof vw.result[1], 'object');

		/* uci overlay: names libuci refuses, prototype keys */
		const pol = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: `[${rpc(sid, 'uci', 'set', { config: 'network', section: '__proto__', values: { zz: 'x' } })},${rpc(sid, 'uci', 'add', { config: '__proto__', type: 'x' }, 2)},${rpc(sid, 'uci', 'set', { config: 'network', section: 'lan', values: { __proto__x: 1, 'a b': 1 } }, 3)}]` })).body);
		assert.deepEqual(pol.map(r => r.result), [ [ 2 ], [ 2 ], [ 2 ] ]);

		/* cgi-exec and apply need the session */
		assert.equal((await req('POST', '/cgi-bin/cgi-exec', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `sessionid=${ZERO}&command=%2Fbin%2Fdmesg%20-r` })).status, 403);
		assert.equal((await req('POST', '/cgi-bin/luci/admin/uci/revert', {})).status, 403);
		assert.equal((await req('POST', `/cgi-bin/luci/admin/uci/revert?sid=${sid}`, {})).status, 200);

		/* 404 with a hostile path: escaped, and nothing raw on the terminal */
		const hostile = '/cgi-bin/luci/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E%22%27';
		const nf = await req('GET', hostile, { headers: { Cookie: cookie } });
		assert.equal(nf.status, 404);
		assert.match(nf.headers['content-type'], /text\/html/);
		/* (inside <script>, L.env carries the path as JSON with "/" escaped, as upstream's header.ut does) */
		assert.ok(!nf.body.replace(/<script\b[\s\S]*?<\/script>/g, '').includes('<img src=x'), 'markup from the path is not reflected');
		assert.ok(nf.body.includes('&#60;img src=x onerror=alert(1)&#62;&#34;&#39;'), 'the path is shown entity-encoded');
		assert.equal((await req('GET', '/cgi-bin/luci/%1b%5d0%3bX%07')).status, 400);
		await req('GET', '/luci-static/%C2%9B31mX');
		await req('POST', '/cgi-bin/x%C2%9B', { headers: JSONH, body: '{}' });
		await req('POST', '/ubus/', { headers: JSONH, body: rpc(sid, 'o\u001b]0;T\u0007', 'm') });
		await new Promise(r => setTimeout(r, 200));
		assert.doesNotMatch(log, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'no control characters in the log');
		assert.match(log, /\\x1b\]0;T\\x07/);
	}
	finally {
		srv.kill('SIGTERM');
	}
});

test('replay server: a static file is served from inside its tree only', { skip, timeout: 60000 }, async () => {
	/* a package directory with one file of its own and a link to a file
	   outside it, as an imported tree could hold */
	const dir = require('./tmpdir')('vantage-static-app-'), res = path.join(dir, 'app/htdocs/luci-static/resources');
	fs.mkdirSync(res, { recursive: true });
	fs.writeFileSync(path.join(res, 'vt-inside.js'), '/* inside */');
	fs.writeFileSync(path.join(dir, 'private.txt'), 'not for the browser');
	fs.symlinkSync(path.join(dir, 'private.txt'), path.join(res, 'vt-leak.js'));
	const port = await freePort();
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', String(port),
		'--app-dir', path.join(dir, 'app'), '--demo' ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let log = '';
	srv.stderr.on('data', d => { log += d; });
	try {
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /\[replay\] http:\/\//, log);
		const inside = await request(port, 'GET', '/luci-static/resources/vt-inside.js');
		assert.deepEqual([ inside.status, inside.body, inside.headers['content-type'] ], [ 200, '/* inside */', 'application/javascript; charset=UTF-8' ]);
		const leak = await request(port, 'GET', '/luci-static/resources/vt-leak.js');
		assert.equal(leak.status, 404);
		assert.doesNotMatch(leak.body, /not for the browser/);
		/* a link that stays inside its tree still serves (the rootfs dump's bootstrap-dark -> bootstrap) */
		if (fs.existsSync(path.join(ROOTFS, 'www/luci-static/bootstrap-dark/cascade.css')))
			assert.equal((await request(port, 'GET', '/luci-static/bootstrap-dark/cascade.css')).status, 200);
		/* a recording with static files of its own says once what they are */
		if (fs.readdirSync(MIRROR).some(d => d.startsWith('browser-') && fs.existsSync(path.join(MIRROR, d, 'static'))))
			assert.match(log, /\[replay\] the recording's static files and translations run as script in the browser/);
	}
	finally { srv.kill(); }
});

/* a recording of two runs, made here: one with its own static tree, one whose static/ is a link to a place outside the recording */
test('replay server: a recording\'s static tree that is a link out of the recording is not served', { skip: !fs.existsSync(path.join(ROOTFS, 'usr/share/ucode/luci/template/view.ut')) && 'no rootfs dump', timeout: 60000 }, async () => {
	const dir = require('./tmpdir')('vantage-static-rec-'), rec = path.join(dir, 'recording');
	const runs = [ 'browser-2026-01-01T00-00-00-000Z', 'browser-2026-01-02T00-00-00-000Z' ].map(d => path.join(rec, d));
	for (const r of runs) {
		fs.mkdirSync(r, { recursive: true });
		fs.writeFileSync(path.join(r, 'rpc.jsonl'), JSON.stringify({ at: 1, object: 'system', method: 'board', args: {}, result: [ 0, { hostname: 'ap', model: 'Demo' } ] }) + '\n');
	}
	fs.mkdirSync(path.join(runs[0], 'static/luci-static/resources'), { recursive: true });
	fs.writeFileSync(path.join(runs[0], 'static/luci-static/resources/vt-own.js'), '/* own */');
	fs.mkdirSync(path.join(dir, 'elsewhere/luci-static/resources'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'elsewhere/luci-static/resources/vt-out.js'), 'not the recording\'s');
	fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(runs[1], 'static'));
	const port = await freePort();
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', rec, '--rootfs', ROOTFS, '--port', String(port) ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let log = '';
	srv.stderr.on('data', d => { log += d; });
	try {
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /\[replay\] http:\/\//, log);
		const own = await request(port, 'GET', '/luci-static/resources/vt-own.js');
		assert.deepEqual([ own.status, own.body ], [ 200, '/* own */' ]);
		const out = await request(port, 'GET', '/luci-static/resources/vt-out.js');
		assert.equal(out.status, 404);
		assert.doesNotMatch(out.body, /not the recording/);
		assert.match(log, /\[replay\] the recording's static files and translations run as script in the browser/);
	}
	finally { srv.kill(); }
});

/* --wg: LuCI's WireGuard status is there, for the session only, and its group held */
test('replay server: --wg answers luci.wireguard getWgInstances with two tunnels', { skip, timeout: 60000 }, async () => {
	const port = await freePort();
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', String(port),
		'--app-dir', path.join(ROOT, 'luci-app-vantage'), '--demo', '--wg' ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let log = '';
	srv.stderr.on('data', d => { log += d; });
	try {
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /\[replay\] http:\/\//, log);
		const login = await request(port, 'POST', '/cgi-bin/luci/', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${port}` }, body: 'luci_username=root&luci_password=x' });
		const sid = login.headers['set-cookie'][0].split(';')[0].split('=')[1];
		const call = async (s, object, method, args) => JSON.parse((await request(port, 'POST', '/ubus/', { headers: JSONH, body: rpc(s, object, method, args) })).body);
		assert.deepEqual((await call(sid, 'session', 'access', { scope: 'access-group', object: 'luci-proto-wireguard', function: 'read' })).result, [ 0, { access: true } ]);
		const r = await call(sid, 'luci.wireguard', 'getWgInstances');
		assert.equal(r.result[0], 0);
		assert.deepEqual(Object.keys(r.result[1]), [ 'wg0', 'wg1' ]);
		assert.deepEqual(Object.values(r.result[1]).map(t => t.peers.length), [ 7, 1 ]);
		/* a later call: the counters moved on */
		await new Promise(res => setTimeout(res, 1100));
		const later = await call(sid, 'luci.wireguard', 'getWgInstances');
		assert.ok(+later.result[1].wg1.peers[0].transfer_rx > +r.result[1].wg1.peers[0].transfer_rx);
		/* not without the login */
		assert.equal((await call(ZERO, 'luci.wireguard', 'getWgInstances')).error.code, -32002);
		assert.doesNotMatch(log, /unknown call[^\n]*luci\.wireguard\.getWgInstances/);
	}
	finally {
		srv.kill('SIGTERM');
	}
});

/* --traffic: luci-app-vantage-traffic's counters for the wired hosts the replay lists, its group held */
test('replay server: --traffic answers luci.vantage.traffic hosts for the wired hosts, one read every 5 s', { skip, timeout: 60000 }, async () => {
	const port = await freePort();
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', String(port),
		'--app-dir', path.join(ROOT, 'luci-app-vantage'), '--demo', '--wired', '--traffic' ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let log = '';
	srv.stderr.on('data', d => { log += d; });
	try {
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /\[replay\] http:\/\//, log);
		const login = await request(port, 'POST', '/cgi-bin/luci/', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${port}` }, body: 'luci_username=root&luci_password=x' });
		const sid = login.headers['set-cookie'][0].split(';')[0].split('=')[1];
		const call = async (s, object, method, args) => JSON.parse((await request(port, 'POST', '/ubus/', { headers: JSONH, body: rpc(s, object, method, args) })).body);
		assert.deepEqual((await call(sid, 'session', 'access', { scope: 'access-group', object: 'luci-app-vantage-traffic', function: 'read' })).result, [ 0, { access: true } ]);
		const wired = (await call(sid, 'luci.vantage', 'wired')).result[1].hosts.map(h => h.mac).sort();
		const r = await call(sid, 'luci.vantage.traffic', 'hosts');
		assert.equal(r.result[0], 0);
		const a = r.result[1];
		assert.deepEqual(a.hosts.map(h => h.mac), wired, 'the wired hosts the replay lists');
		for (const h of a.hosts) assert.deepEqual(Object.keys(h), [ 'mac', 'rx', 'tx' ]);
		assert.deepEqual([ a.acct, a.every, a.partial, a.at % 5000 ], [ true, 5000, false, 0 ]);
		assert.ok(a.hosts.every(h => /^00:00:5e:00:53:[0-9a-f]{2}$|^02:00:5e:/.test(h.mac)), 'documentation MACs');
		/* not without the login */
		assert.equal((await call(ZERO, 'luci.vantage.traffic', 'hosts')).error.code, -32002);
		/* --wired: a router's firewall, not the recorded access point's */
		const fw = Object.values((await call(sid, 'uci', 'get', { config: 'firewall' })).result[1].values);
		assert.deepEqual(fw.filter(s => s['.type'] === 'zone').map(s => [ s.name, s.network ]), [ [ 'lan', [ 'lan', 'vpn' ] ], [ 'wan', [ 'wan', 'wan6' ] ], [ 'guest', [ 'guest' ] ] ]);
	}
	finally {
		srv.kill('SIGTERM');
	}
});

/* --lang: the packages' po/<lang>/*.po over the recorded catalogue, in
   /admin/translations/<lc> (what cbi.js reads) and in the templates' _() */
test('replay server: --lang previews the package catalogues', { skip, timeout: 60000 }, async () => {
	const mkTmp = require('./tmpdir');
	const tmp = mkTmp('vantage-replaylang-');
	fs.cpSync(path.join(ROOT, 'luci-theme-vantage'), path.join(tmp, 'luci-theme-vantage'), { recursive: true });
	fs.cpSync(path.join(ROOT, 'luci-app-vantage'), path.join(tmp, 'luci-app-vantage'), { recursive: true });
	const head = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n"Plural-Forms: nplurals=2; plural=n != 1;\\n"\n\n';
	fs.mkdirSync(path.join(tmp, 'luci-app-vantage/po/de'), { recursive: true });
	fs.writeFileSync(path.join(tmp, 'luci-app-vantage/po/de/vantage.po'), head + 'msgid "Dashboard"\nmsgstr "Übersicht"\n');
	fs.mkdirSync(path.join(tmp, 'luci-theme-vantage/po/de'), { recursive: true });
	fs.writeFileSync(path.join(tmp, 'luci-theme-vantage/po/de/vantage-theme.po'), head + 'msgid "Log out"\nmsgstr "Abmelden <b>"\n');
	const port = await freePort();
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', String(port),
		'--theme-dir', path.join(tmp, 'luci-theme-vantage/htdocs/luci-static/vantage'), '--theme', 'vantage',
		'--app-dir', path.join(tmp, 'luci-app-vantage'), '--demo', '--lang', 'de' ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let log = '';
	srv.stderr.on('data', d => { log += d; });
	try {
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /language de \(de\)/, log);
		const tr = await request(port, 'GET', '/cgi-bin/luci/admin/translations/de');
		assert.equal(tr.status, 200);
		assert.match(tr.headers['content-type'], /^application\/javascript/);
		assert.match(tr.body, /^window\.TR=\{.*\};$/s);
		/* sfh("Dashboard") = 36ec1dcb, sfh("Log out") = f5cd233a (real .lmo keys) */
		assert.match(tr.body, /"36ec1dcb":"Übersicht",/);
		assert.match(tr.body, /"f5cd233a":"Abmelden <b>",/);
		assert.match(tr.body, /"00000000":"nplurals=2; plural=n != 1;",/);
		/* edits show on the next request */
		fs.appendFileSync(path.join(tmp, 'luci-app-vantage/po/de/vantage.po'), '\nmsgid "Log in"\nmsgstr "Anmelden"\n');
		assert.match((await request(port, 'GET', '/cgi-bin/luci/admin/translations/de')).body, /"3008cc84":"Anmelden",/);
		/* templates: translated and still escaped */
		const login = await request(port, 'GET', '/cgi-bin/luci/admin/status/overview');
		assert.match(login.body, /Anmelden/);
		const page = await request(port, 'GET', '/cgi-bin/luci/admin/status/overview', { headers: { Cookie: (await request(port, 'POST', '/cgi-bin/luci/admin/status/overview',
			{ headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'luci_username=root&luci_password=x' })).headers['set-cookie'][0].split(';')[0] } });
		assert.equal(page.status, 200);
		assert.match(page.body, /<html lang="de"/);
		assert.match(page.body, /admin\/translations\/de/);
		assert.match(page.body, /aria-label="Abmelden &#60;b&#62;"/);
		assert.doesNotMatch(page.body, /Abmelden <b>/);
	} finally {
		srv.kill();
	}
	/* an unknown language is refused */
	const bad = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', '1', '--lang', 'xx' ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let err = '';
	bad.stderr.on('data', d => { err += d; });
	const code = await new Promise(r => bad.on('exit', r));
	assert.equal(code, 2);
	assert.match(err, /--lang xx: not a LuCI language/);
});

/* --dsa: --wired's ports as a DSA switch's, the dashboard's switch counters plugin answering with the chip's own (#156) */
test('replay server: --dsa types --wired\'s ports dsa and answers luci.vantage.ports counters with the chip\'s counters', { skip, timeout: 60000 }, async () => {
	const start = async extra => {
		const port = await freePort();
		const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', MIRROR, '--rootfs', ROOTFS, '--port', String(port),
			'--app-dir', path.join(ROOT, 'luci-app-vantage'), '--demo', '--wired' ].concat(extra), { stdio: [ 'ignore', 'ignore', 'pipe' ] });
		let log = '';
		srv.stderr.on('data', d => { log += d; });
		for (let i = 0; i < 200 && !log.includes('[replay] http://'); i++) await new Promise(r => setTimeout(r, 50));
		assert.match(log, /\[replay\] http:\/\//, log);
		const login = await request(port, 'POST', '/cgi-bin/luci/', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${port}` }, body: 'luci_username=root&luci_password=x' });
		const sid = login.headers['set-cookie'][0].split(';')[0].split('=')[1];
		const call = async (s, object, method, args) => JSON.parse((await request(port, 'POST', '/ubus/', { headers: JSONH, body: rpc(s, object, method, args) })).body);
		return { srv, sid, call };
	};
	const a = await start([ '--dsa' ]);
	try {
		const devs = (await a.call(a.sid, 'network.device', 'status')).result[1];
		assert.deepEqual([ devs.lan1.devtype, devs.lan2.devtype ], [ 'dsa', 'dsa' ]);
		const r = await a.call(a.sid, 'luci.vantage.ports', 'counters');
		assert.equal(r.result[0], 0);
		assert.deepEqual([ r.result[1].v, r.result[1].state, Object.keys(r.result[1].ports) ], [ 1, 'ok', [ 'lan1', 'lan2' ] ]);
		/* each reading with its time on the device's clock, which a later one is ahead of */
		assert.ok(Number.isInteger(r.result[1].ports.lan1.at) && r.result[1].ports.lan1.at >= 0);
		await new Promise(res => setTimeout(res, 50));
		assert.ok((await a.call(a.sid, 'luci.vantage.ports', 'counters')).result[1].ports.lan1.at > r.result[1].ports.lan1.at);
		/* the chip counts what the kernel's counters miss */
		assert.ok(r.result[1].ports.lan1.tx_bytes > devs.lan1.statistics.tx_bytes * 10);
		assert.equal((await a.call(ZERO, 'luci.vantage.ports', 'counters')).error.code, -32002, 'not without the login');
	}
	finally {
		const gone = new Promise(r => a.srv.once('exit', r));
		a.srv.kill('SIGTERM');
		await gone;
	}
	/* without it: a device without a DSA port */
	const b = await start([]);
	try {
		assert.deepEqual((await b.call(b.sid, 'luci.vantage.ports', 'counters')).result, [ 0, { v: 1, state: 'none', took: 0, more: false, ports: {} } ]);
		assert.equal((await b.call(b.sid, 'network.device', 'status')).result[1].lan1.devtype, 'ethernet');
	}
	finally {
		const gone = new Promise(r => b.srv.once('exit', r));
		b.srv.kill('SIGTERM');
		await gone;
	}
});
