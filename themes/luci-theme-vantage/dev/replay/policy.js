'use strict';
/* Policy for the LuCI data mirror: what a recording may contain. The
   replay uses the parsers; a recorder applies the whole policy.

   1. Only read-only requests may reach the device while recording. Every
      request the recording browser makes (any tab, popup or worker) is
      decided here by classify(); anything not explicitly allowed is refused
      before it leaves the browser, so a stray click on Save, Apply, Reboot
      or a diagnostics button cannot change or disturb the device. Wi-Fi
      scans are refused too: they take radios off channel.
      Request bodies are parsed the way the device parses them (json-c for
      JSON-RPC, cgi-io for cgi-exec forms); anything the two parsers could
      read differently is refused, and the device is sent the re-serialised
      body that was checked, not the original bytes.
      This is an accident guard for a person clicking through stock LuCI,
      not a sandbox: page JavaScript that is itself hostile runs in the
      admin's session and has other ways to act (e.g. WebSockets, which the
      DevTools Fetch domain does not see).
   2. Secrets are removed before anything is written to disk: Wi-Fi keys,
      RADIUS/WireGuard/DDNS secrets, password hashes, private keys, session
      tokens, secret-looking lines in text and the tokens of known daemons
      in process command lines. File contents (file.read) are dropped
      unless the path is on a short allowlist of non-secret system files.
      The mirror keeps real MACs/IPs/hostnames (it lives outside the repo,
      mode 0700); what gets shown or shared goes through the replay's
      --demo pseudonymiser. */

const READ = {
	'session': [ 'access', 'list' ],
	'system': [ 'board', 'info' ],
	'network': [ 'get_proto_handlers' ],
	'network.interface': [ 'dump', 'status' ],
	'network.device': [ 'status' ],
	'network.wireless': [ 'status' ],
	'uci': [ 'get', 'configs', 'changes', 'state' ],
	'iwinfo': [ 'info', 'assoclist', 'freqlist', 'txpowerlist', 'countrylist', 'devices', 'phyname', 'survey' ],
	'file': [ 'read', 'stat', 'list', 'md5' ],
	'rc': [ 'list' ],
	'service': [ 'list' ],
	'log': [ 'read' ],
	'dhcp': [ 'ipv4leases', 'ipv6leases' ]
};
/* whole objects whose getX methods are reads by LuCI convention */
const READ_PREFIX = { 'luci': /^get/, 'luci-rpc': /^get/ };
/* hostapd per-interface objects (hostapd.phy0-ap0 ...) */
const HOSTAPD_READ = [ 'get_status', 'get_clients', 'get_features', 'rrm_nr_get_own', 'get_bss_steering' ];

/* The only commands a page may run while recording: the exact read-only
   invocations LuCI's own status pages use (routing, firewall, kernel log).
   Compared as whole argument vectors, never as prefixes or patterns. */
const EXEC_READ = new Set([
	[ '/sbin/ip', '-4', 'neigh', 'show' ], [ '/sbin/ip', '-6', 'neigh', 'show' ],
	[ '/sbin/ip', '-4', 'route', 'show', 'table', 'all' ], [ '/sbin/ip', '-6', 'route', 'show', 'table', 'all' ],
	[ '/sbin/ip', '-4', 'rule', 'show' ], [ '/sbin/ip', '-6', 'rule', 'show' ],
	[ '/sbin/ip', '-4', '-j', 'neigh', 'show' ], [ '/sbin/ip', '-6', '-j', 'neigh', 'show' ],
	[ '/sbin/ip', '-4', '-j', 'route', 'show', 'table', 'all' ], [ '/sbin/ip', '-6', '-j', 'route', 'show', 'table', 'all' ],
	[ '/sbin/ip', '-4', '-j', 'rule', 'show' ], [ '/sbin/ip', '-6', '-j', 'rule', 'show' ],
	[ '/usr/sbin/nft', '--terse', '--json', 'list', 'ruleset' ],
	[ '/usr/sbin/iptables-save' ], [ '/usr/sbin/ip6tables-save' ],
	[ '/usr/sbin/iptables-legacy-save' ], [ '/usr/sbin/ip6tables-legacy-save' ],
	[ '/bin/dmesg', '-r' ]
].map(v => JSON.stringify(v)));

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

function execAllowed(argv) {
	return Array.isArray(argv) && argv.every(a => typeof a === 'string') && EXEC_READ.has(JSON.stringify(argv));
}

/* file.exec RPC arguments: { command, params } */
function execArgsAllowed(args) {
	if (!args || typeof args.command !== 'string') return false;
	for (const k of Object.keys(args)) if (k !== 'command' && k !== 'params' && k !== 'env') return false;
	if (args.env != null && (typeof args.env !== 'object' || Object.keys(args.env).length)) return false;
	if (args.params != null && !Array.isArray(args.params)) return false;
	return execAllowed([ args.command ].concat(args.params || []));
}

/* ------------------------------------------------------------ cgi-exec */

/* cgi-io (util.c) as the device runs it: postdecode_fields() compares raw,
   undecoded keys and keeps the last match, a raw '=' inside a value
   restarts the match, urldecode() turns '+' into a space and fails on a
   bad %xx, parse_command() splits on isspace() with backslash escapes.
   parseCgiExec() refuses every body where that could differ from a plain
   reading: unknown, duplicate or encoded keys, raw '=' in a value, control
   characters, non-UTF-8 bytes, and a command that is not in the canonical
   form LuCI's fs.exec_direct() produces. */
const CGI_EXEC_KEYS = new Set([ 'sessionid', 'command', 'stderr' ]);
const C_SPACE = c => c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

function cgiDecode(v) {
	const bytes = [];
	for (let i = 0; i < v.length; i++) {
		const c = v[i];
		if (c === '%') {
			if (!/^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) return null;
			bytes.push(parseInt(v.slice(i + 1, i + 3), 16));
			i += 2;
		}
		else if (c === '+') bytes.push(0x20);
		else for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
	}
	try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(bytes)); } catch (e) { return null; }
}

/* parse_command() of cgi-io, on a decoded string */
function cgiParseCommand(cmd) {
	let i = 0;
	while (i < cmd.length && C_SPACE(cmd[i])) i++;
	const argv = [];
	let cur = '', raw = 0, esc = false;
	for (; i <= cmd.length; i++) {
		const c = (i < cmd.length) ? cmd[i] : '\0';
		if (esc) { esc = false; cur += c; raw++; continue; }
		if (c === '\\' && i + 1 < cmd.length) { esc = true; raw++; continue; }
		if (C_SPACE(c) || c === '\0') {
			if (raw) argv.push(cur);
			cur = ''; raw = 0;
			continue;
		}
		cur += c; raw++;
	}
	return argv.length ? argv : null;
}

/* fs.exec_direct(): backslash and whitespace escaped, joined with ' ' */
function cgiCommandString(argv) {
	return argv.map(a => a.replace(/\\/g, '\\\\').replace(/(\s)/g, '\\$1')).join(' ');
}

/* -> { ok: true, argv, sessionid, canonical } | { ok: false, why } */
function parseCgiExec(body) {
	const bad = why => ({ ok: false, why: 'cgi-exec ' + why });
	if (typeof body !== 'string' || !body || body.length > 65536) return bad('empty or oversized body');
	if (/[\0-\x1f\x7f]/.test(body)) return bad('control character in body');
	const f = Object.create(null);
	for (const pair of body.split('&')) {
		const eq = pair.indexOf('=');
		if (eq < 0) return bad('field without a value');
		const key = pair.slice(0, eq), value = pair.slice(eq + 1);
		if (!CGI_EXEC_KEYS.has(key)) return bad('unexpected field');
		if (key in f) return bad('duplicate field ' + key);
		if (value.includes('=')) return bad('raw "=" in ' + key);
		const dec = cgiDecode(value);
		if (dec == null) return bad('undecodable ' + key);
		if (/[\0-\x1f\x7f]/.test(dec)) return bad('control character in ' + key);
		f[key] = dec;
	}
	if (typeof f.sessionid !== 'string' || !/^[0-9a-f]{32}$/.test(f.sessionid)) return bad('missing session id');
	if (typeof f.command !== 'string' || !f.command) return bad('missing command');
	if (f.stderr != null && f.stderr !== '0' && f.stderr !== '1') return bad('bad stderr flag');
	const argv = cgiParseCommand(f.command);
	if (!argv || cgiCommandString(argv) !== f.command) return bad('non-canonical command');
	let canonical = 'sessionid=' + f.sessionid + '&command=' + encodeURIComponent(cgiCommandString(argv));
	if (f.stderr != null) canonical += '&stderr=' + f.stderr;
	return { ok: true, argv, sessionid: f.sessionid, canonical };
}

/* argv of a cgi-exec body, or null (the replay answers from it) */
function cgiExecArgv(body) {
	const r = parseCgiExec(body);
	return r.ok ? r.argv : null;
}

/* ------------------------------------------------------------ JSON-RPC */

/* Strict JSON as json-c + blobmsg can agree on it: no duplicate keys (json-c
   keeps the last, JS too, but a reviewer reading the body would not), no
   control characters or NUL in keys or strings (json-c cuts keys at NUL,
   blobmsg strings are C strings), no lone surrogates, bounded depth.
   Objects have no prototype, so "__proto__" is an ordinary key. */
function strictJson(text) {
	if (typeof text !== 'string' || text.length > (1 << 20)) throw new SyntaxError('body too large');
	let i = 0;
	const fail = why => { throw new SyntaxError(why + ' at offset ' + i); };
	const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
	const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
	const str = () => {
		i++;
		let out = '';
		for (;;) {
			if (i >= text.length) fail('unterminated string');
			const c = text[i];
			if (c === '"') { i++; break; }
			if (c.charCodeAt(0) < 0x20) fail('raw control character');
			if (c === '\\') {
				const e = text[i + 1];
				if (e === 'u') {
					const h = text.slice(i + 2, i + 6);
					if (!/^[0-9A-Fa-f]{4}$/.test(h)) fail('bad \\u escape');
					out += String.fromCharCode(parseInt(h, 16));
					i += 6;
				}
				else if (hasOwn(ESC, e)) { out += ESC[e]; i += 2; }
				else fail('bad escape');
			}
			else { out += c; i++; }
		}
		if (/[\0-\x1f\x7f]/.test(out)) fail('control character in string');
		if (/\p{Cs}/u.test(out)) fail('lone surrogate');
		return out;
	};
	const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
	const value = depth => {
		if (depth > 64) fail('nested too deep');
		ws();
		const c = text[i];
		if (c === '"') return str();
		if (c === '{') {
			i++;
			const o = Object.create(null);
			ws();
			if (text[i] === '}') { i++; return o; }
			for (;;) {
				ws();
				if (text[i] !== '"') fail('expected key');
				const k = str();
				if (hasOwn(o, k)) fail('duplicate key');
				ws();
				if (text[i++] !== ':') fail('expected ":"');
				o[k] = value(depth + 1);
				ws();
				if (text[i] === ',') { i++; continue; }
				if (text[i] === '}') { i++; return o; }
				fail('expected "," or "}"');
			}
		}
		if (c === '[') {
			i++;
			const a = [];
			ws();
			if (text[i] === ']') { i++; return a; }
			for (;;) {
				a.push(value(depth + 1));
				ws();
				if (text[i] === ',') { i++; continue; }
				if (text[i] === ']') { i++; return a; }
				fail('expected "," or "]"');
			}
		}
		for (const [ lit, v ] of [ [ 'true', true ], [ 'false', false ], [ 'null', null ] ])
			if (text.startsWith(lit, i)) { i += lit.length; return v; }
		NUM.lastIndex = i;
		const m = NUM.exec(text);
		if (!m) fail('unexpected character');
		i += m[0].length;
		const n = Number(m[0]);
		if (!Number.isFinite(n)) fail('number out of range');
		return n;
	};
	const v = value(0);
	ws();
	if (i !== text.length) fail('trailing data');
	return v;
}

const RPC_KEYS = new Set([ 'jsonrpc', 'id', 'method', 'params' ]);

/* JSON-RPC body -> { calls: [ {object, method, args, id} | {list, id} | {bad} ],
   canonical } or null when the body is not strict JSON */
function parseRpc(body) {
	let v;
	try { v = strictJson(body); } catch (e) { return null; }
	const batch = Array.isArray(v);
	const msgs = batch ? v : [ v ];
	if (!msgs.length) return null;
	const calls = msgs.map(function(m) {
		if (!m || typeof m !== 'object' || Array.isArray(m)) return { bad: true };
		if (Object.keys(m).some(k => !RPC_KEYS.has(k)) || m.jsonrpc !== '2.0') return { bad: true };
		if (typeof m.id !== 'number' && typeof m.id !== 'string') return { bad: true };
		if (m.method === 'list') {
			if (m.params !== undefined && !(Array.isArray(m.params) && m.params.every(p => typeof p === 'string'))) return { bad: true };
			return { list: true, id: m.id };
		}
		if (m.method !== 'call' || !Array.isArray(m.params) || m.params.length < 3 || m.params.length > 4) return { bad: true };
		const [ sid, object, method, args ] = m.params;
		if (typeof sid !== 'string' || typeof object !== 'string' || typeof method !== 'string') return { bad: true };
		if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) return { bad: true };
		return { id: m.id, object, method, args: args || Object.create(null) };
	});
	return { calls, canonical: JSON.stringify(batch ? msgs : msgs[0]) };
}

function isReadCall(object, method, args) {
	if (typeof object !== 'string' || typeof method !== 'string') return false;
	if (object === 'file' && method === 'exec') return execArgsAllowed(args);
	if (hasOwn(READ, object)) return READ[object].indexOf(method) >= 0;
	if (hasOwn(READ_PREFIX, object)) return READ_PREFIX[object].test(method);
	if (/^hostapd\.[A-Za-z0-9_.-]+$/.test(object)) return HOSTAPD_READ.indexOf(method) >= 0;
	return false;
}

/* -> { ok, why, calls, canonical } */
function rpcAllowed(body) {
	const p = parseRpc(body);
	if (!p) return { ok: false, why: 'unparseable or non-strict RPC body' };
	for (const c of p.calls) {
		if (c.bad) return { ok: false, why: 'malformed RPC message' };
		if (c.list) continue;
		if (!isReadCall(c.object, c.method, c.args)) return { ok: false, why: c.object + '.' + c.method + ' is not on the read allowlist' };
	}
	return { ok: true, calls: p.calls, canonical: p.canonical };
}

/* ------------------------------------------------------------ HTTP */

/* paths (decoded, query removed) that must never be requested, any verb */
const BLOCKED_HTTP = [
	/^\/cgi-bin\/cgi-[a-z]+/,
	/^\/cgi-bin\/luci\/admin\/uci\//,
	/^\/cgi-bin\/luci\/admin\/system\/(flash|reboot)\/[a-z]/
];

function httpAllowed(pathname) {
	for (const re of BLOCKED_HTTP) if (re.test(pathname)) return { ok: false, why: 'blocked endpoint ' + pathname };
	return { ok: true };
}

function header(headers, name) {
	for (const [ k, v ] of Object.entries(headers || {})) if (k.toLowerCase() === name) return String(v);
	return null;
}

/* the sysauth form: a POST to a LuCI page with exactly the two login fields
   (the form posts to the current URL, so any /cgi-bin/luci path) */
function loginAllowed(pathname, search, headers, body) {
	if (!/^\/cgi-bin\/luci(\/[^?#]*)?$/.test(pathname) || search) return false;
	if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(header(headers, 'content-type') || '')) return false;
	if (typeof body !== 'string' || body.length > 4096 || /[\0-\x1f\x7f]/.test(body)) return false;
	const pairs = body.split('&');
	if (pairs.length !== 2) return false;
	const seen = new Set();
	for (const pair of pairs) {
		const eq = pair.indexOf('=');
		if (eq < 0) return false;
		const key = pair.slice(0, eq), value = pair.slice(eq + 1);
		if ((key !== 'luci_username' && key !== 'luci_password') || seen.has(key) || value.includes('=')) return false;
		try { decodeURIComponent(value.replace(/\+/g, ' ')); } catch (e) { return false; }
		seen.add(key);
	}
	return seen.size === 2;
}

/* Decide one request of the recording browser.
     req  { url, method, headers, postData }
     base 'https://device' (origin of the device)
   -> { ok: false, why }
    | { ok: true, kind: 'rpc'|'exec'|'login'|'http'|'static'|null,
        calls, postData (canonical body to send instead, if any) } */
function classify(req, base) {
	const verb = String(req.method || '').toUpperCase();
	const deny = why => ({ ok: false, why });
	let u, origin;
	try { u = new URL(req.url); origin = new URL(base).origin; } catch (e) { return deny('unparseable URL'); }
	if (u.origin !== origin) return deny(`off-device request ${verb} ${(u.protocol + "//" + u.host + u.pathname).slice(0, 120)}`);
	let p;
	try { p = decodeURIComponent(u.pathname); } catch (e) { return deny('undecodable path'); }
	const where = `${verb} ${p}`;
	if (/[\0-\x1f\x7f\\]/.test(p) || /(^|\/)\.\.?(\/|$)/.test(p) || p.includes('//')) return deny('odd path ' + JSON.stringify(p));
	if (header(req.headers, 'service-worker')) return deny('service worker script ' + where);
	const read = verb === 'GET' || verb === 'HEAD';
	const body = req.postData;

	/* ubus JSON-RPC: only the endpoint itself (not the REST /ubus/call/...,
	   /ubus/list, /ubus/subscribe routes), only POST, only reads */
	if (p === '/ubus' || p.startsWith('/ubus/') || p === '/cgi-bin/luci/admin/ubus' || p.startsWith('/cgi-bin/luci/admin/ubus/')) {
		if (verb !== 'POST' || !(p === '/ubus' || p === '/ubus/' || p === '/cgi-bin/luci/admin/ubus')) return deny('ubus endpoint ' + where);
		const v = rpcAllowed(body);
		if (!v.ok) return deny(v.why);
		return { ok: true, kind: 'rpc', calls: v.calls, postData: v.canonical };
	}
	if (p.startsWith('/cgi-bin/')) {
		if (p === '/cgi-bin/cgi-exec' && verb === 'POST') {
			const v = parseCgiExec(body);
			if (!v.ok) return deny(v.why);
			if (!execAllowed(v.argv)) return deny('cgi-exec ' + JSON.stringify(v.argv));
			return { ok: true, kind: 'exec', calls: v.argv, postData: v.canonical };
		}
		const blocked = httpAllowed(p);
		if (!blocked.ok) return blocked;
		if (p === '/cgi-bin/luci' || p.startsWith('/cgi-bin/luci/')) {
			if (read) return { ok: true, kind: /^\/cgi-bin\/luci\/admin\/(menu|translations)(\/|$)/.test(p) ? 'http' : null };
			if (verb === 'POST' && loginAllowed(p, u.search, req.headers, body)) return { ok: true, kind: 'login' };
			return deny(where);
		}
		return deny('cgi endpoint ' + where);
	}
	if (!read) return deny(where);
	return { ok: true, kind: p.startsWith('/luci-static/') ? 'static' : null };
}

/* ---------------------------------------------------------------- secrets */

const SECRET_KEY = new RegExp('^(' + [
	'key\\d*', 'password\\d*', 'passwd', 'pass', 'passphrase', 'wpa_passphrase', 'psk', 'wpa_psk', 'sae_password',
	'sae_pwe_secret', 'auth_secret', 'acct_secret', 'dae_secret', 'priv_key\\d*(_pwd)?', 'private_?key', 'privatekey',
	'preshared_?key', 'presharedkey', 'secret', 'token', 'ppsk', 'mesh_psk', 'ubus_rpc_session', 'sessionid', 'shared_secret',
	'pin', 'wps_pin', 'client_secret', 'api_?key', 'auth_?key', 'community', 'credentials?', 'r[01]kh', 'cookie',
	'.*_(secret|psk|password|passwd|pwd|token|passphrase)'
].join('|') + ')$', 'i');

/* file.read contents kept: system files without secrets. /proc/<pid>/ is
   not among them (cmdline and environ carry tokens). */
const FILE_KEEP = /^(\/proc\/(?![0-9]|self\/|thread-self\/)[A-Za-z0-9_.\/-]+|\/sys\/[A-Za-z0-9_.:@\/-]+|\/etc\/board\.json|\/etc\/iproute2\/rt_tables|\/etc\/sysupgrade\.conf|\/etc\/services|\/etc\/protocols|\/etc\/os-release|\/usr\/lib\/os-release|\/etc\/openwrt_release|\/etc\/openwrt_version)$/;

/* process command lines: the flags of known daemons whose next argument is
   a secret. Per binary, never a generic "-t"/"-p" rule (uhttpd -t 60,
   rpcd -t 30, dropbear -p, ntpd -p are harmless and needed). */
const ARGV_SECRET = {
	'rtty': [ '-t', '--token' ],
	'ttyd': [ '-c', '--credential' ],
	'curl': [ '-u', '--user', '--proxy-user', '--oauth2-bearer' ],
	'wget': [ '--password', '--http-password', '--ftp-password', '--proxy-password' ],
	'sshpass': [ '-p' ],
	'mosquitto_pub': [ '-P', '--pw' ], 'mosquitto_sub': [ '-P', '--pw' ],
	'openconnect': [ '--cookie' ]
};
/* long options that always carry a secret, for any binary */
const LONG_SECRET = /^--?(password|passwd|pass|token|secret|psk|passphrase|credentials?|auth-?key|api-?key)$/i;

function scrubArgv(argv) {
	if (!argv.length || typeof argv[0] !== 'string') return argv;
	const flags = ARGV_SECRET[argv[0].replace(/^.*\//, '')] || [];
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (typeof a !== 'string') { out.push(a); continue; }
		const eq = /^(--?[A-Za-z][\w-]*)=/.exec(a);
		if (eq && (LONG_SECRET.test(eq[1]) || flags.includes(eq[1]))) { out.push(eq[1] + '=' + REDACTED); continue; }
		out.push(scrubText(a));
		if ((flags.includes(a) || LONG_SECRET.test(a)) && i + 1 < argv.length) { out.push(REDACTED); i++; }
	}
	return out;
}

const SECRET_TEXT = [
	[ /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => REDACTED ],
	/* crypt(3) password hashes: md5, bcrypt, sha256/512, yescrypt, ... */
	[ /\$(1|2[abxy]?|5|6|7|y|gy|sha1|md5|apr1)\$[^\s:'"]+/g, () => REDACTED ],
	[ /\b(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-ssh-ed25519@openssh\.com) AAAA[A-Za-z0-9+/=]+/g, () => REDACTED ],
	/* uci files: option key '...' / list ... */
	[ /^(\s*(?:option|list)\s+)(['"]?)([A-Za-z0-9_]+)\2(\s+)(.+)$/gm, (m, a, q, name, sp) => SECRET_KEY.test(name) ? `${a}${q}${name}${q}${sp}'${REDACTED}'` : m ],
	/* hostapd / wpa_supplicant / wg-quick / shell: name=value, name = value */
	[ /^(\s*(?:export\s+)?)([A-Za-z][A-Za-z0-9_]*)(\s*=\s*)(.+)$/gm, (m, a, name, eq) => SECRET_KEY.test(name) ? `${a}${name}${eq}${REDACTED}` : m ],
	/* query strings (crontabs, scripts, URLs in logs) */
	[ /([?&;](?:token|key|password|passwd|pass|secret|sig|signature|auth|apikey|api_key|access_token|psk)=)[^&\s'"]+/gi, (m, a) => a + REDACTED ],
	[ /\b(Authorization:\s*)?(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{8,}/g, (m, h, kind) => (h || '') + kind + ' ' + REDACTED ]
];
const REDACTED = '<redacted>';

function scrubText(s) {
	let out = s;
	for (const [ re, fn ] of SECRET_TEXT) out = out.replace(re, fn);
	return out;
}

function scrubCmdline(s) {
	return scrubArgv(s.split(' ')).join(' ');
}

function sanitize(value, depth, key) {
	depth = depth || 0;
	if (depth > 64) return REDACTED;
	if (typeof value === 'string') return (key === 'COMMAND' || key === 'cmdline') ? scrubCmdline(scrubText(value)) : scrubText(value);
	if (Array.isArray(value)) {
		const arr = (key === 'command' || key === 'argv') && value.every(v => typeof v === 'string') ? scrubArgv(value) : value;
		return arr.map(function(v) { return sanitize(v, depth + 1); });
	}
	if (value && typeof value === 'object') {
		const out = {};
		for (const k of Object.keys(value)) {
			if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
			out[k] = SECRET_KEY.test(k) ? REDACTED : sanitize(value[k], depth + 1, k);
		}
		return out;
	}
	return value;
}

function fileReadable(p) {
	return typeof p === 'string' && FILE_KEEP.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p) && !p.includes('//');
}

/* file.read: contents only for FILE_KEEP paths; everything else keeps the
   call (so the replay answers) and drops the data */
function sanitizeResult(object, method, args, result) {
	if (object === 'file' && method === 'read' && !fileReadable(args && args.path)) {
		if (Array.isArray(result)) return result[0] === 0 ? [ 0, { data: REDACTED } ] : [ result[0] ];
		return { data: REDACTED };
	}
	return sanitize(result);
}

module.exports = {
	execAllowed, execArgsAllowed, cgiExecArgv, parseCgiExec, cgiParseCommand, cgiCommandString, cgiDecode,
	strictJson, isReadCall, parseRpc, rpcAllowed, httpAllowed, loginAllowed, classify,
	sanitize, sanitizeResult, scrubText, scrubArgv, fileReadable, SECRET_KEY, REDACTED
};
