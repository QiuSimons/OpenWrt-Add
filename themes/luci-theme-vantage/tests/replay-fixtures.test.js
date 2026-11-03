'use strict';
/* dev/replay --fixtures (fixtures.js, store.js, server.js): device paths
   never leave <dir>/root, the recording answers first, fixture plugins
   cannot replace built-in ones, uci fixtures only add sections, and
   /cgi-bin/cgi-download keeps the replay's host, cross-site and session
   checks. Also checks the committed sample fixtures and dev/replay/addons.sh.

   Runs without the private mirror: a small synthetic mirror and rootfs are
   made in a temporary directory. The HTTP test listens on a free port in
   8221-8229 on 127.0.0.1. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const mkTmp = require('./tmpdir');
const { Fixtures } = require('../dev/replay/fixtures');
const { Store } = require('../dev/replay/store');

const ROOT = path.join(__dirname, '..');
const ADDONS = path.join(ROOT, 'dev/replay/fixtures/addons');

function put(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, data);
}

/* <tmp>/secret.txt outside two fixture dirs, symlinks pointing at it */
function fixtureTree() {
	const tmp = mkTmp('vantage-fixtures-');
	put(path.join(tmp, 'secret.txt'), 'SECRET\n');
	put(path.join(tmp, 'outside/inner.txt'), 'SECRET-DIR\n');
	const a = path.join(tmp, 'a'), b = path.join(tmp, 'b');
	put(path.join(a, 'root/etc/demo.txt'), 'from a\n');
	put(path.join(a, 'root/usr/share/x/one'), '1');
	put(path.join(a, 'root/etc/config/demo'), "config demo 'main'\n\toption a '1'\n");
	fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(a, 'root/etc/leak'));
	fs.symlinkSync(path.join(tmp, 'outside'), path.join(a, 'root/etc/leakdir'));
	fs.symlinkSync('../etc/demo.txt', path.join(a, 'root/usr/inside'));
	fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(a, 'root/etc/config/leaked'));
	put(path.join(a, 'exec.json'), JSON.stringify([
		{ argv: [ '/bin/true' ], stdout: 'ok\n' },
		{ argv: [ '/bin/json' ], json: { a: [ 1 ] } },
		{ argv: [ '/bin/true' ], stdout: 'second row ignored' },
		{ argv: [ 1 ], stdout: 'bad argv' },
		{ argv: [], stdout: 'empty argv' },
		{ argv: [ '/bin/none' ] },
		null
	]));
	put(path.join(b, 'root/etc/demo.txt'), 'from b\n');
	put(path.join(b, 'root/usr/share/x/two'), '2');
	put(path.join(b, 'root/usr/share/y/three'), '3');
	put(path.join(b, 'exec.json'), '{ not json');
	return { tmp, a, b };
}

test('fixtures: device paths stay inside <dir>/root', () => {
	const { a, b } = fixtureTree();
	const fx = new Fixtures([ a, b ]);
	const read = p => fx.file('read', { path: p });
	assert.deepEqual(read('/etc/demo.txt'), { result: [ 0, { data: 'from a\n' } ] }, 'first directory wins');
	assert.deepEqual(read('/usr/share/y/three'), { result: [ 0, { data: '3' } ] });
	assert.deepEqual(read('/usr/inside'), { result: [ 0, { data: 'from a\n' } ] }, 'a symlink inside the root is fine');
	for (const p of [ '/etc/leak', '/etc/leakdir/inner.txt', '/etc/../../secret.txt', '/../secret.txt', '/etc/..', '..',
		'etc/demo.txt', '', '/etc/demo.txt\0', '/etc/demo.txt\n', '/etc/\x1b', null, 42, [ '/etc/demo.txt' ], { toString: () => '/etc/demo.txt' },
		'/' + 'a/'.repeat(3000) ]) {
		assert.equal(read(p), null, JSON.stringify(p));
		assert.equal(fx.file('stat', { path: p }), null, JSON.stringify(p));
		assert.equal(fx.file('list', { path: p }), null, JSON.stringify(p));
		assert.equal(fx.read(p), null, JSON.stringify(p));
	}
	assert.equal(fx.file('read', null), null);
	assert.deepEqual(read('/etc'), { result: [ 2 ] }, 'a directory is not readable');
	assert.equal(fx.read('/etc'), null);
	assert.equal(fx.read('/etc/demo.txt').toString(), 'from a\n');
	/* only read, stat and list */
	assert.equal(fx.file('write', { path: '/etc/demo.txt', data: 'x' }), null);
	assert.equal(fx.file('remove', { path: '/etc/demo.txt' }), null);
	assert.equal(fx.file('exec', { path: '/etc/demo.txt' }), null);
	assert.equal(fx.file('md5', { path: '/etc/demo.txt' }), null);

	const st = fx.file('stat', { path: '/etc/demo.txt' }).result;
	assert.equal(st[0], 0);
	assert.equal(st[1].type, 'file');
	assert.equal(st[1].path, '/etc/demo.txt');
	assert.equal(st[1].uid, 0);

	/* listings merge the roots and leave out entries resolving outside */
	const names = p => fx.file('list', { path: p }).result[1].entries.map(e => e.name);
	assert.deepEqual(names('/etc'), [ 'config', 'demo.txt' ]);
	assert.deepEqual(names('/usr/share'), [ 'x', 'y' ]);
	assert.deepEqual(names('/usr/share/x'), [ 'one', 'two' ]);
	assert.deepEqual(names('/'), [ 'etc', 'usr' ]);
	assert.deepEqual(fx.file('list', { path: '/etc/demo.txt' }), { result: [ 2 ] });
	assert.equal(fx.file('list', { path: '/nope' }), null);

	/* uci configs: valid names, never through a symlink out */
	assert.deepEqual(fx.configs().map(c => c[0]), [ 'demo' ]);
	assert.ok(fx.configs()[0][1].startsWith(fs.realpathSync(a)));

	/* exec.json: strings or JSON, first row wins, bad rows and files ignored */
	assert.equal(fx.execText([ '/bin/true' ]), 'ok\n');
	assert.equal(fx.execText([ '/bin/json' ]), '{"a":[1]}');
	assert.equal(fx.execText([ 1 ]), null);
	assert.equal(fx.execText([]), null);
	assert.equal(fx.execText([ '/bin/none' ]), null);
	assert.equal(fx.exec.size, 2);
	assert.deepEqual(new Fixtures([ path.join(a, 'missing') ]).pluginFiles(), []);
});

/* small synthetic mirror: one recorded file.read and exec, a network config */
function mirror() {
	const dir = mkTmp('vantage-fixmirror-');
	const b = path.join(dir, 'browser-2026-01-01T00-00-00-000Z');
	fs.mkdirSync(b);
	const rows = [
		{ at: 1, object: 'uci', method: 'get', args: { config: 'network' }, result: [ 0, { values: {
			lan: { '.anonymous': false, '.type': 'interface', '.name': 'lan', '.index': 0, proto: 'static', ipaddr: '192.0.2.1' } } } ] },
		{ at: 2, object: 'file', method: 'read', args: { path: '/etc/demo.txt' }, result: [ 0, { data: 'recorded\n' } ] },
		{ at: 3, object: 'system', method: 'board', args: {}, result: [ 0, { hostname: 'ap' } ] },
		{ at: 4, object: 'network', method: 'get_proto_handlers', args: {}, result: [ 0, { static: {} } ] }
	];
	fs.writeFileSync(path.join(b, 'rpc.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
	fs.writeFileSync(path.join(b, 'http.jsonl'), [
		{ at: 1, url: '/cgi-bin/cgi-exec', argv: [ '/bin/true' ], body: 'recorded exec\n' },
		{ at: 2, url: '/cgi-bin/luci/admin/menu', body: { action: { type: 'firstchild' }, children: { admin: {
			satisfied: true, title: 'Administration', order: 10, action: { type: 'firstchild' },
			auth: { methods: [ 'cookie:sysauth_https', 'cookie:sysauth_http' ], login: true },
			children: { status: { satisfied: true, title: 'Status', order: 10, action: { type: 'template', path: 'status' } } } } } } }
	].map(r => JSON.stringify(r)).join('\n') + '\n');
	return dir;
}

test('fixtures in the store: the recording answers first, writes stay dropped', () => {
	const { a } = fixtureTree();
	put(path.join(a, 'root/etc/only-fixture'), 'fixture\n');
	const s = new Store(mirror(), { synthetic: false, fixtures: new Fixtures([ a ]) });
	assert.deepEqual(s.call('file', 'read', { path: '/etc/demo.txt' }), { result: [ 0, { data: 'recorded\n' } ] });
	assert.deepEqual(s.call('file', 'read', { path: '/etc/only-fixture' }), { result: [ 0, { data: 'fixture\n' } ] });
	assert.deepEqual(s.call('file', 'read', { path: '/etc/leak' }), { result: [ 4 ] });
	assert.deepEqual(s.call('file', 'read', { path: '/etc/../../secret.txt' }), { result: [ 4 ] });
	assert.deepEqual(s.call('file', 'exec', { command: '/bin/true' }), { result: [ 0, { code: 0, stdout: 'recorded exec\n' } ] });
	assert.deepEqual(s.call('file', 'exec', { command: '/bin/json' }), { result: [ 0, { code: 0, stdout: '{"a":[1]}' } ] });
	assert.equal(s.execText([ '/bin/true' ]), 'recorded exec\n');
	assert.equal(s.execText([ '/bin/json' ]), '{"a":[1]}');
	assert.equal(s.execText([ '/bin/other' ]), null);
	/* file.write/remove on a fixture path: success, and nothing touched */
	assert.deepEqual(s.call('file', 'write', { path: '/etc/only-fixture', data: 'changed' }), { result: [ 0 ] });
	assert.deepEqual(s.call('file', 'remove', { path: '/etc/only-fixture' }), { result: [ 0 ] });
	assert.equal(fs.readFileSync(path.join(a, 'root/etc/only-fixture'), 'utf8'), 'fixture\n');
});

test('fixtures in the store: uci sections are only added, never replaced', () => {
	const s = new Store(mirror(), { synthetic: false });
	const before = JSON.stringify(s.uciGet('network', 'lan'));
	const added = s.uciAddSections('network', {
		lan: { '.type': 'interface', '.name': 'lan', proto: 'dhcp' },
		wg0: { '.anonymous': false, '.type': 'interface', '.name': 'wg0', proto: 'wireguard', addresses: [ '192.0.2.199/24' ], 'bad key': 'x' },
		__proto__x: { '.type': 'x' },
		'bad name': { '.type': 'interface' },
		constructor: { '.type': 'interface' },
		notype: { proto: 'x' }
	});
	assert.equal(added, 2, 'wg0 and __proto__x (a valid uci name)');
	assert.equal(JSON.stringify(s.uciGet('network', 'lan')), before);
	assert.equal(s.uciGet('network', 'wg0', 'proto'), 'wireguard');
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'wg0', option: 'addresses' }), { result: [ 0, { value: [ '192.0.2.199/24' ] } ] });
	assert.equal(s.uciGet('network', 'wg0', 'bad key'), null);
	assert.equal(s.uciGet('network', 'wg0')['.index'], 1);
	assert.equal(s.uciAddSections('nope', { x: { '.type': 'x' } }), 0, 'unknown configs are seeded, not merged');
	assert.equal(s.uciAddSections('__proto__', { x: { '.type': 'x' } }), 0);
	assert.equal(({}).proto, undefined);
	assert.deepEqual(s.call('uci', 'changes', { config: 'network' }), { result: [ 0, { changes: [] } ] }, 'committed state, no pending changes');
});

test('fixtures in the store: plugins get next() and cannot replace built-ins', () => {
	const { a } = fixtureTree();
	put(path.join(a, 'wrap-plugin.js'), `'use strict';
exports.OBJECTS = [ 'network', 'luci.vantage', 'uci', 'session', 'demo.extra' ];
exports.call = (store, method, args, next) => {
	if (method === 'hello') return { result: [ 0, { from: 'fixture' } ] };
	const r = next();
	if (r.result && r.result[0] === 0 && r.result[1]) r.result[1].wrapped = true;
	return r;
};
`);
	put(path.join(a, 'Not-A-Plugin.js'), 'throw new Error("must not load")');
	put(path.join(a, 'root/x-plugin.js'), 'throw new Error("must not load")');
	const lines = [];
	const orig = console.error;
	console.error = (...m) => lines.push(m.join(' '));
	let s;
	try { s = new Store(mirror(), { synthetic: false, fixtures: new Fixtures([ a ]) }); }
	finally { console.error = orig; }
	const vantage = require('../dev/replay/vantage-plugin');
	assert.equal(s.plugins.get('luci.vantage'), vantage, 'built-in plugin kept');
	assert.ok(!s.plugins.has('uci') && !s.plugins.has('session'));
	for (const o of [ 'luci.vantage', 'uci', 'session' ]) assert.ok(lines.some(l => l.includes(o + ' is already answered')), o);
	assert.deepEqual(s.call('network', 'get_proto_handlers', {}), { result: [ 0, { static: {}, wrapped: true } ] });
	assert.deepEqual(s.call('network', 'hello', {}), { result: [ 0, { from: 'fixture' } ] });
	assert.deepEqual(s.call('demo.extra', 'other', {}), { result: [ 4 ] }, 'next() of an unknown call');
	assert.equal(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'proto' }).result[1].value, 'static');
	assert.equal(new Store(mirror(), { synthetic: false, plugins: false, fixtures: new Fixtures([ a ]) }).plugins.size, 0);
});

/* ------------------------------------------------------------------ HTTP */

async function freePort() {
	for (let p = 8221; p <= 8229; p++) {
		const ok = await new Promise(res => {
			const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true)));
		});
		if (ok) return p;
	}
	throw new Error('no free port in 8221-8229');
}

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

/* the smallest rootfs the server starts with */
function rootfs() {
	const dir = mkTmp('vantage-fixrootfs-');
	put(path.join(dir, 'usr/share/ucode/luci/template/view.ut'), 'view\n');
	put(path.join(dir, 'usr/share/ucode/luci/template/sysauth.ut'), 'login\n');
	put(path.join(dir, 'usr/share/ucode/luci/template/status.ut'), 'status\n');
	fs.mkdirSync(path.join(dir, 'usr/share/luci/menu.d'), { recursive: true });
	return dir;
}

function start(args) {
	const srv = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), ...args ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	const st = { srv, log: '' };
	srv.stderr.on('data', d => { st.log += d; });
	st.ready = (async () => {
		for (let i = 0; i < 200 && !st.log.includes('[replay] http://') && srv.exitCode == null; i++) await new Promise(r => setTimeout(r, 50));
		assert.match(st.log, /\[replay\] http:\/\//, st.log);
	})();
	return st;
}

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSONH = { 'Content-Type': 'application/json' };
const rpc = (sid, object, method, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: [ sid, object, method, args || {} ] });

test('replay server: cgi-download serves fixture files only, with the session', { timeout: 60000 }, async () => {
	const { a } = fixtureTree();
	const m = mirror(), r = rootfs();
	const port = await freePort();
	const st = start([ '--mirror', m, '--rootfs', r, '--port', String(port), '--fixtures', a, '--no-synthetic' ]);
	try {
		await st.ready;
		assert.match(st.log, /\[replay\] fixtures: .*\(0 plugin files, 1 uci configs, 2 exec outputs\)/);
		const req = (...x) => request(port, ...x);
		const login = await req('POST', '/cgi-bin/luci/admin/status', { headers: FORM, body: 'luci_username=root&luci_password=x' });
		assert.equal(login.status, 302);
		const sid = login.headers['set-cookie'][0].split(';')[0].split('=')[1];
		assert.match(sid, /^[0-9a-f]{32}$/);
		const dl = (body, headers) => req('POST', '/cgi-bin/cgi-download', { headers: Object.assign({}, FORM, headers || {}), body });
		const q = p => `sessionid=${sid}&path=${encodeURIComponent(p)}`;

		const ok = await dl(q('/etc/demo.txt'));
		assert.equal(ok.status, 200);
		assert.equal(ok.body, 'from a\n');
		assert.equal(ok.headers['content-type'], 'application/octet-stream');
		assert.equal(ok.headers['content-disposition'], 'attachment');
		assert.equal(ok.headers['x-content-type-options'], 'nosniff');

		/* the login session, nothing else */
		for (const body of [ 'path=%2Fetc%2Fdemo.txt', `sessionid=${'0'.repeat(32)}&path=%2Fetc%2Fdemo.txt`, `sessionid=&path=%2Fetc%2Fdemo.txt`,
			`sessionid=${sid.toUpperCase()}&path=%2Fetc%2Fdemo.txt`, `sessionid=${sid}x&path=%2Fetc%2Fdemo.txt` ]) {
			const res = await dl(body);
			assert.equal(res.status, 403, body);
			assert.doesNotMatch(res.body, /from a/);
		}
		assert.equal((await req('GET', `/cgi-bin/cgi-download?${q('/etc/demo.txt')}`)).status, 405);
		/* the replay's host and cross-site checks come first */
		assert.equal((await dl(q('/etc/demo.txt'), { Host: 'evil.example' })).status, 421);
		assert.equal((await dl(q('/etc/demo.txt'), { Origin: 'http://evil.example' })).status, 403);
		assert.equal((await dl(q('/etc/demo.txt'), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);

		/* traversal, symlinks out, host files, odd paths: 404 and no content */
		for (const p of [ '/etc/../../secret.txt', '/../secret.txt', '/etc/leak', '/etc/leakdir/inner.txt', '/etc/config/leaked',
			'etc/demo.txt', '/etc', '/etc/passwd', fs.realpathSync(path.join(a, '..', 'secret.txt')), '/etc/demo.txt\0' ]) {
			const res = await dl(q(p));
			assert.equal(res.status, 404, p);
			assert.doesNotMatch(res.body, /SECRET|root:/, p);
		}
		assert.equal((await dl(`sessionid=${sid}`)).status, 404, 'no path');

		/* file.* over ubus: fixture files with the session, rpcd's ACL without */
		const fr = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc(sid, 'file', 'read', { path: '/usr/share/x/one' }) })).body);
		assert.deepEqual(fr.result, [ 0, { data: '1' } ]);
		const anon = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc('0'.repeat(32), 'file', 'read', { path: '/usr/share/x/one' }) })).body);
		assert.equal(anon.error.code, -32002);
		const leak = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc(sid, 'file', 'list', { path: '/etc' }) })).body);
		assert.deepEqual(leak.result[1].entries.map(e => e.name), [ 'config', 'demo.txt' ]);
		/* the uci fixture seeded a config the recording lacks */
		const demo = JSON.parse((await req('POST', '/ubus/', { headers: JSONH, body: rpc(sid, 'uci', 'get', { config: 'demo', section: 'main', option: 'a' }) })).body);
		assert.deepEqual(demo.result, [ 0, { value: '1' } ]);
		/* cgi-exec: recorded first, then exec.json, with the session */
		const ex = (cmd, s) => req('POST', '/cgi-bin/cgi-exec', { headers: FORM, body: `sessionid=${s || sid}&command=${encodeURIComponent(cmd)}` });
		assert.equal((await ex('/bin/true')).body, 'recorded exec\n');
		assert.equal((await ex('/bin/json')).body, '{"a":[1]}');
		assert.equal((await ex('/bin/json', '0'.repeat(32))).status, 403);
		assert.equal((await ex('/bin/sh -c id')).status, 403);
		await new Promise(res => setTimeout(res, 100));
		assert.doesNotMatch(st.log, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, 'no control characters in the log');
	}
	finally { st.srv.kill('SIGTERM'); }
});

test('replay server: without --fixtures cgi-download stays refused; a bad --fixtures stops it', { timeout: 60000 }, async () => {
	const m = mirror(), r = rootfs();
	const port = await freePort();
	const st = start([ '--mirror', m, '--rootfs', r, '--port', String(port), '--no-synthetic' ]);
	try {
		await st.ready;
		assert.doesNotMatch(st.log, /\[replay\] fixtures:/);
		const login = await request(port, 'POST', '/cgi-bin/luci/admin/status', { headers: FORM, body: 'luci_username=root&luci_password=x' });
		const sid = login.headers['set-cookie'][0].split(';')[0].split('=')[1];
		const res = await request(port, 'POST', '/cgi-bin/cgi-download', { headers: FORM, body: `sessionid=${sid}&path=%2Fetc%2Fpasswd` });
		assert.equal(res.status, 403);
		assert.equal(res.body, 'Not available in the replay');
	}
	finally { st.srv.kill('SIGTERM'); }

	const tmp = mkTmp('vantage-fixbad-');
	put(path.join(tmp, 'file'), 'x');
	for (const bad of [ path.join(tmp, 'missing'), path.join(tmp, 'file') ]) {
		const p = spawn(process.execPath, [ path.join(ROOT, 'dev/replay/server.js'), '--mirror', m, '--rootfs', r, '--port', '1', '--fixtures', bad ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
		let err = '';
		p.stderr.on('data', d => { err += d; });
		assert.equal(await new Promise(res => p.on('exit', res)), 2, bad);
		assert.match(err, /--fixtures .*: not a directory/);
	}
});

/* ------------------------------------------------------ committed files */

test('sample add-on fixtures: data and plugins only, no third-party sources, no network', () => {
	const files = [];
	(function walk(d) {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const f = path.join(d, e.name);
			assert.ok(!e.isSymbolicLink(), `${f}: no symlinks`);
			if (e.isDirectory()) walk(f); else files.push(path.relative(ADDONS, f));
		}
	})(ADDONS);
	/* upstream package files are copied into the cache by addons.sh, never committed */
	for (const f of files) assert.doesNotMatch(f, /^root\/(www\/|usr\/share\/luci\/|usr\/share\/https-dns-proxy\/)|^root\/etc\/(adblock\/adblock|banip\/banip)\.(feeds|categories|countries)$/, f);
	/* plugins: our stand-ins, no network or processes */
	const plugins = files.filter(f => /-plugin\.js$/.test(f));
	assert.ok(plugins.length >= 5);
	for (const f of [ ...plugins.map(p => path.join(ADDONS, p)), path.join(ROOT, 'dev/replay/fixtures.js') ]) {
		const src = fs.readFileSync(f, 'utf8');
		assert.match(src, /^'use strict';/, f);
		assert.doesNotMatch(src, /require\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|child_process|worker_threads|vm)['"]\s*\)|\bfetch\(|\beval\(|new Function/, f);
	}
	assert.ok(files.every(f => !/\.(ut|htm)$/.test(f)), 'nothing a template engine would compile');
	/* exec.json and the uci files parse */
	const fx = new Fixtures([ ADDONS ]);
	assert.ok(fx.exec.size >= 10);
	for (const v of fx.exec.values()) assert.equal(typeof v, 'string');
	assert.ok(fx.configs().length >= 11);
	/* every plugin answers each POLICY method without throwing */
	const s = new Store(mirror(), { synthetic: false, fixtures: fx });
	for (const p of plugins) {
		const mod = require(path.join(ADDONS, p));
		for (const o of Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ]) {
			assert.equal(s.plugins.get(o), mod, o);
			for (const m of Object.keys(mod.POLICY || {})) {
				const r = s.call(o, m, {});
				assert.ok(r && (Array.isArray(r.result) || r.error), `${o}.${m}`);
			}
		}
	}
	assert.ok('wireguard' in s.call('network', 'get_proto_handlers', {}).result[1]);
	assert.equal(s.call('luci.ddns', 'get_services_log', { service_name: '../../../../etc/passwd' }).result[1].result, 'File not found or empty');
	assert.match(s.call('luci.ddns', 'get_services_log', { service_name: 'home_ipv4' }).result[1].result, /203\.0\.113\.7/);
});

test('addons.sh: pinned commits, cache outside the repository', () => {
	const sh = fs.readFileSync(path.join(ROOT, 'dev/replay/addons.sh'), 'utf8');
	assert.match(sh, /^LUCI_REV=[0-9a-f]{40}\b/m);
	assert.match(sh, /^PACKAGES_REV=[0-9a-f]{40}\b/m);
	assert.match(sh, /fetch -q --depth 1 --filter=blob:none origin "\$rev"/);
	assert.match(sh, /core\.symlinks false/);
	assert.match(sh, /libs\/luci-lib-chartjs/);
	assert.doesNotMatch(sh, /luci-app-openvpn$/m, 'Lua app not served');
	assert.doesNotMatch(sh, /rm -rf/);
	const inside = spawn('bash', [ path.join(ROOT, 'dev/replay/addons.sh'), '--cache', path.join(ROOT, 'dev/replay/cache-test'), '--fetch-only' ], { stdio: [ 'ignore', 'ignore', 'pipe' ] });
	let err = '';
	inside.stderr.on('data', d => { err += d; });
	return new Promise(res => inside.on('exit', code => {
		assert.equal(code, 2);
		assert.match(err, /inside the repository/);
		assert.ok(!fs.existsSync(path.join(ROOT, 'dev/replay/cache-test')));
		res();
	}));
});
