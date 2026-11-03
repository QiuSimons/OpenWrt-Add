#!/usr/bin/env node
'use strict';
/*
 * Keep real network identifiers out of the published tree.
 *
 * Usage
 *   node security-tests/check_private_addresses.js [--mirror <dir>] [--require-mirror] [paths...]
 *   node security-tests/check_private_addresses.js --self-test
 *
 * Without paths it scans every file git would publish: tracked plus
 * untracked-but-not-ignored (`git ls-files -co --exclude-standard`; the
 * private mirror is ignored by .gitignore). With paths it scans those files
 * and directories. Always skipped: node_modules/, .git/, this checker's own
 * fixtures (security-tests/fixtures/addresses_{bad,good}.txt) and binary
 * files (NUL byte or an image/archive/font extension, e.g. the prototype
 * screenshots), which are listed as skipped.
 *
 * A text file fails when it contains
 *
 *   IPv4  a private (10/8, 172.16/12, 192.168/16), shared/CGNAT (100.64/10)
 *         or link-local (169.254/16) address, also glued to a word
 *         (host_10...); only a digit or dot before it, or a digit / ".digit"
 *         after it, stops a match;
 *   IPv6  a global unicast address (first three bits 001) outside the
 *         documentation prefix 2001:db8::/32; a unique-local address (first
 *         seven bits 1111110) other than the bare example prefix `fd00::`;
 *         a link-local address whose interface identifier is longer than
 *         16 bits (EUI-64 / random identifiers are per device; fe80::1 is
 *         a textbook gateway); an IPv4-mapped private address;
 *   MAC   an address in colon, dash, dotted (xxxx.xxxx.xxxx) or bare
 *         12-hex-digit form (bare only when "mac" or "bssid" appears earlier
 *         on the line) outside the allowlist below;
 *   mirror identifiers  (when the private data mirror is available) the
 *         hostnames, SSIDs, DNS/mDNS names, search domains, WPS device
 *         names, client names from DHCP logs and global IPv4 addresses
 *         recorded from the real device, including names with spaces or
 *         quotes. They are read at run time and never written anywhere;
 *         findings show them masked. A name matches as a whole word, with
 *         any run of whitespace for a space, and also in its JSON-escaped,
 *         HTML-entity and URL-encoded forms. Names of 4+ characters match
 *         in any case; 2-3 character names only in their recorded case.
 *         False positives (a recorded name that is also an ordinary word
 *         in the tree) go in <mirror>/identifier-allowlist.txt, one per
 *         line.
 *
 * MAC allowlist (policy):
 *   00:00:5E:00:53:00/24  RFC 7042 documentation unicast range; tests may
 *                         vary the first octet (00-0F) to exercise the
 *                         group (I/G) and local (U/L) bits, e.g.
 *                         02:00:5E:00:53:11 (private) or 01:00:5E:00:53:01;
 *   01:00:5E:90:10:00/24  RFC 7042 documentation multicast range;
 *   02:00:5E:xx:xx:xx     locally administered addresses under the IANA
 *                         OUI with the U/L bit set: never assigned to
 *                         hardware, used for invented BSSIDs
 *                         (dev/replay/synthetic.js) and fake stations;
 *   00:00:00:00:00:00, FF:FF:FF:FF:FF:FF.
 * Everything else, including other locally administered addresses (a
 * phone's real randomised MAC is one), fails.
 *
 * Documentation IPv4 (192.0.2/24, 198.51.100/24, 203.0.113/24), loopback,
 * 0.0.0.0, ::1 and :: pass. No exemption for well-known defaults such as
 * the OpenWrt LAN address: use a documentation address instead.
 *
 * Mirror: --mirror <dir>, else $VANTAGE_MIRROR, else ../vantage-mirror
 * next to the repository. Missing mirror: the identifier check is skipped
 * with a note (CI has no mirror), or fails with --require-mirror.
 *
 * Exit status: 0 clean, 1 findings, 2 usage/IO error.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'security-tests', 'fixtures');
const EXCLUDED_FILES = new Set([ path.join(FIXTURES, 'addresses_bad.txt'), path.join(FIXTURES, 'addresses_good.txt') ]);
const EXCLUDED_DIRS = new Set([ 'node_modules', '.git' ]);
const BINARY_EXT = new Set([ '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.apk', '.ipk', '.gz', '.xz',
	'.zst', '.bz2', '.zip', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.bin', '.img' ]);

/* ------------------------------------------------------------- patterns */

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g;
const MAC_SEP = /(?<![0-9A-Fa-f:-])((?:[0-9A-Fa-f]{2}([:-]))(?:[0-9A-Fa-f]{2}\2){4}[0-9A-Fa-f]{2})(?![0-9A-Fa-f:-])/g;
const MAC_DOT = /(?<![0-9A-Fa-f.])([0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4})(?![0-9A-Fa-f.])/g;
const MAC_BARE = /(?<![0-9A-Fa-f])([0-9A-Fa-f]{12})(?![0-9A-Fa-f])/g;
const MAC_CONTEXT = /mac|bssid/i;
/* hex groups joined by colons (at least two), not glued to hex, colons or
   dots; net.isIPv6 decides validity */
const IPV6 = /(?<![0-9A-Fa-f:.])([0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7})(%[\w.-]+)?(?![0-9A-Fa-f:])/g;

/* IPv4 networks as { base: 32-bit number, prefix }, built from numbers so
   this file does not flag itself */
function v4net(a, b, c, d, prefix) { return { base: ((a << 24) | (b << 16) | (c << 8) | d) >>> 0, prefix }; }
function inV4(n, net4) { const mask = net4.prefix ? (~0 << (32 - net4.prefix)) >>> 0 : 0; return ((n & mask) >>> 0) === net4.base; }
const PRIVATE_V4 = [
	[ v4net(10, 0, 0, 0, 8), 'private' ],
	[ v4net(172, 16, 0, 0, 12), 'private' ],
	[ v4net(192, 168, 0, 0, 16), 'private' ],
	[ v4net(100, 64, 0, 0, 10), 'shared/CGNAT' ],
	[ v4net(169, 254, 0, 0, 16), 'link-local' ]
];
const PUBLIC_EXEMPT_V4 = [ v4net(192, 0, 2, 0, 24), v4net(198, 51, 100, 0, 24), v4net(203, 0, 113, 0, 24), v4net(127, 0, 0, 0, 8), v4net(0, 0, 0, 0, 8), v4net(224, 0, 0, 0, 3) ];

const MAC_ALLOWED = new RegExp('^(?:' + [
	'0[0-9a-f]:00:5e:00:53:[0-9a-f]{2}',
	'01:00:5e:90:10:[0-9a-f]{2}',
	'02:00:5e(?::[0-9a-f]{2}){3}',
	'00(?::00){5}',
	'ff(?::ff){5}'
].join('|') + ')$');

function v4int(o) { return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0; }

function v4finding(o) {
	const n = v4int(o);
	for (const [ r, what ] of PRIVATE_V4) if (inV4(n, r)) return `${what} IPv4 ${o.join('.')}`;
	return null;
}

/* '2001:db8::1' -> [8 x 16-bit], or null */
function v6groups(text) {
	if (!net.isIPv6(text)) return null;
	let s = text.toLowerCase();
	/* trailing dotted quad -> two hex groups */
	const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
	if (v4) {
		const o = v4.slice(1).map(Number);
		s = s.slice(0, v4.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
	}
	let groups;
	if (s.includes('::')) {
		const [ a, b ] = s.split('::');
		const ha = a ? a.split(':') : [], hb = b ? b.split(':') : [];
		groups = [ ...ha, ...Array(8 - ha.length - hb.length).fill('0'), ...hb ];
	} else groups = s.split(':');
	groups = groups.map(g => parseInt(g || '0', 16));
	return groups.length === 8 ? groups : null;
}

function v6finding(text) {
	const g = v6groups(text);
	if (!g) return null;
	/* IPv4-mapped ::ffff:a.b.c.d */
	if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
		const o = [ g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255 ];
		return v4finding(o) ? `IPv4-mapped ${v4finding(o)}` : null;
	}
	if (text.toLowerCase() === 'fd00::' || text.toLowerCase() === 'fe80::') return null;
	if ((g[0] & 0xe000) === 0x2000 && !(g[0] === 0x2001 && g[1] === 0x0db8)) return `global IPv6 ${text}`;
	if ((g[0] & 0xfe00) === 0xfc00) return `unique-local IPv6 ${text}`;
	if ((g[0] & 0xffc0) === 0xfe80 && (g[4] || g[5] || g[6])) return `link-local IPv6 with interface identifier ${text}`;
	return null;
}

function macNorm(hex) { return hex.toLowerCase().match(/../g).join(':'); }

/* one regex per identifier: whole word, whitespace runs as \s+, any case
   from 4 characters on */
const idCache = new WeakMap();
function identifierRes(identifiers) {
	if (!identifiers || !identifiers.size) return [];
	let res = idCache.get(identifiers);
	if (!res) {
		res = [ ...identifiers ].map(([ v, kind ]) => {
			const src = v.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
			return [ new RegExp('(?<![A-Za-z0-9])' + src + '(?![A-Za-z0-9])', v.length >= 4 ? 'i' : ''), v, kind ];
		});
		idCache.set(identifiers, res);
	}
	return res;
}

/* the forms a value takes in committed files: as is, JSON-escaped,
   HTML entities, URL-encoded */
const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: '\u00a0' };
function jsonUnescape(s) {
	return s.replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
		.replace(/\\([\\"'\/bfnrt])/g, (m, c) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[c] || c);
}
function htmlDecode(s) {
	return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([a-z]+));/g, (m, d, h, n) => {
		const cp = d ? +d : h ? parseInt(h, 16) : null;
		if (cp != null) return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
		return ENTITIES[n] ?? m;
	});
}
function urlDecode(s) {
	return s.replace(/\+/g, ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, m => {
		try { return decodeURIComponent(m); } catch (e) { return m.replace(/%([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))); }
	});
}
function views(line) {
	const out = new Set([ line ]);
	if (/[\\&%+]/.test(line)) {
		const j = jsonUnescape(line), h = htmlDecode(line);
		for (const v of [ j, h, urlDecode(line), htmlDecode(j), jsonUnescape(h), urlDecode(j) ]) out.add(v);
	}
	return [ ...out ];
}

/* identifiers: Map value -> kind (from mirrorIdentifiers) */
function findings(text, identifiers) {
	const out = [];
	const idRes = identifierRes(identifiers);
	text.split('\n').forEach((line, i) => {
		const n = i + 1;
		for (const m of line.matchAll(IPV4)) {
			const o = m.slice(1, 5).map(Number);
			if (o.some(x => x > 255)) continue;
			const f = v4finding(o);
			if (f) out.push([ n, f ]);
		}
		for (const m of line.matchAll(IPV6)) {
			const f = v6finding(m[1]);
			if (f) out.push([ n, f ]);
		}
		const macs = [];
		for (const m of line.matchAll(MAC_SEP)) macs.push([ m[1], m[1].replace(/[^0-9A-Fa-f]/g, '') ]);
		for (const m of line.matchAll(MAC_DOT)) macs.push([ m[1], m[1].replace(/[^0-9A-Fa-f]/g, '') ]);
		for (const m of line.matchAll(MAC_BARE)) if (MAC_CONTEXT.test(line.slice(0, m.index))) macs.push([ m[1], m[1] ]);
		for (const [ shown, hex ] of macs) if (!MAC_ALLOWED.test(macNorm(hex))) out.push([ n, `MAC address ${shown}` ]);
		if (idRes.length) {
			const forms = views(line);
			for (const [ re, v, kind ] of idRes) if (forms.some(f => re.test(f))) out.push([ n, `${kind} from the device mirror (${mask(v)})` ]);
		}
	});
	return out;
}

function mask(v) {
	return v.length <= 4 ? '*'.repeat(v.length) : v.slice(0, 2) + '*'.repeat(v.length - 4) + v.slice(-2) + ` [${v.length} chars]`;
}

/* ------------------------------------------------------ mirror identifiers */

/* names that are generic, not identifying */
const GENERIC = new Set([ 'openwrt', 'localhost', 'lan', 'wan', 'local', 'home', 'localdomain', 'home.arpa', 'internal',
	'router', 'accesspoint', 'default', 'unknown', 'hidden', '(hidden)', 'guest', 'test', 'none', 'true', 'false', 'null',
	'hostname', 'name', 'ssid', 'domain', 'model', 'device', 'client', 'station' ]);
const NAME_KEYS = new Set([ 'hostname', 'ssid', 'mesh_id', 'domain', 'dns_search', 'dns-search', 'fqdn', 'wps_device_name', 'device_name' ]);
/* client names only a log line carries: dnsmasq's DHCPACK(<if>) <ip> <mac>
   <name> and "not giving name <name> to the DHCP lease" */
const LOG_NAMES = [
	/\bDHCPACK\([^)]*\)\s+\S+\s+(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\s+([^\s*]\S*)/g,
	/\bnot giving name\s+(\S+)\s+to\b/g
];
function logHostnames(text) {
	const names = [];
	if (typeof text !== 'string' || !/DHCPACK|not giving name/.test(text)) return names;
	for (const re of LOG_NAMES) for (const m of text.matchAll(re)) names.push(m[1]);
	return names;
}

/* Map value -> kind. Values keep their recorded case (short names match
   case-sensitively); 4+ character names are kept once per spelling. */
function mirrorIdentifiers(dir) {
	const ids = new Map(), seen = new Set();
	let allow = new Set();
	try {
		allow = new Set(fs.readFileSync(path.join(dir, 'identifier-allowlist.txt'), 'utf8').split('\n')
			.map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.toLowerCase()));
	} catch (e) {}
	function add(v, kind) {
		if (typeof v !== 'string') return;
		v = v.trim().replace(/\.$/, '');
		if (v.length < 2 || v.length > 100 || /[\x00-\x1f\x7f]/.test(v) || /^[\d.:\s]+$/.test(v) || GENERIC.has(v.toLowerCase()) || allow.has(v.toLowerCase())) return;
		const key = v.length >= 4 ? v.toLowerCase() : v;
		if (seen.has(key)) return;
		seen.add(key);
		ids.set(v, kind);
	}
	function addIp(v) {
		if (typeof v !== 'string') return;
		v = v.replace(/\/\d+$/, '');
		if (!net.isIPv4(v)) return;
		const o = v.split('.').map(Number), n = v4int(o);
		if (PUBLIC_EXEMPT_V4.some(r => inV4(n, r)) || v4finding(o) || n === 0xffffffff) return;
		ids.set(v, 'public IPv4');
	}
	function walk(x, key, ctx) {
		if (Array.isArray(x)) { x.forEach(v => walk(v, key, ctx)); return; }
		if (x && typeof x === 'object') {
			for (const [ k, v ] of Object.entries(x)) {
				if (ctx === 'umdns hosts' && v && typeof v === 'object') add(k, 'mDNS name');
				walk(v, k, ctx);
			}
			return;
		}
		if (typeof x !== 'string') return;
		if (NAME_KEYS.has(key)) add(x, key === 'ssid' || key === 'mesh_id' ? 'SSID' : key.endsWith('device_name') ? 'WPS device name' : 'hostname');
		if (key === 'name' && /^(luci-rpc (getHostHints|getDHCPLeases)|dhcp ipv[46]leases|uci get dhcp)$/.test(ctx)) add(x, 'hostname');
		if (key === 'signature') { const m = /(?:^|[|,:])wps:([^|,]{1,64})/.exec(x); if (m) { add(m[1], 'WPS device name'); add(m[1].replace(/_/g, ' '), 'WPS device name'); } }
		if (ctx === 'network.rrdns lookup') add(x, 'reverse DNS name');
		for (const n of logHostnames(x)) add(n, 'hostname from a DHCP log');
		addIp(x);
	}
	function file(p) {
		let text;
		try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
		for (const line of text.split('\n')) {
			if (!line.trim()) continue;
			let r;
			try { r = JSON.parse(line); } catch (e) { continue; }
			if (typeof r.object === 'string') walk(r.result, null, `${r.object} ${r.method}${r.object === 'uci' && r.args && typeof r.args.config === 'string' ? ' ' + r.args.config : ''}`);
			else if (typeof r.body === 'string') for (const n of logHostnames(r.body)) add(n, 'hostname from a DHCP log');
		}
	}
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		for (const f of [ 'rpc.jsonl', 'snapshots.jsonl', 'http.jsonl' ]) file(path.join(dir, e.name, f));
	}
	return ids;
}

/* ---------------------------------------------------------------- files */

function gitFiles() {
	const out = execFileSync('git', [ '-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard' ]).toString();
	return [ ...new Set(out.split('\0').filter(Boolean)) ].sort().map(f => path.join(ROOT, f));
}

function walkFiles(p, out) {
	const st = fs.statSync(p);
	if (st.isFile()) { out.push(p); return out; }
	for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
		if (EXCLUDED_DIRS.has(e.name)) continue;
		const q = path.join(p, e.name);
		if (e.isDirectory()) walkFiles(q, out);
		else if (e.isFile()) out.push(q);
	}
	return out;
}

function skipPath(abs) {
	return EXCLUDED_FILES.has(abs) || path.relative(ROOT, abs).split(path.sep).some(s => EXCLUDED_DIRS.has(s));
}

function scan(targets, identifiers) {
	let bad = 0, count = 0;
	const skipped = [];
	for (const abs of targets) {
		if (skipPath(abs) || !fs.statSync(abs).isFile()) continue;
		const rel = path.relative(ROOT, abs) || abs;
		const data = fs.readFileSync(abs);
		if (BINARY_EXT.has(path.extname(abs).toLowerCase()) || data.includes(0)) { skipped.push(rel); continue; }
		count++;
		for (const [ n, what ] of findings(data.toString('utf8'), identifiers)) {
			console.log(`${rel}:${n}: ${what}`);
			bad++;
		}
	}
	if (skipped.length) console.log(`skipped ${skipped.length} binary file(s) (not scannable)`);
	console.log(`${count} text file(s) scanned, ${skipped.length} binary skipped, ${bad} finding(s)`);
	return bad ? 1 : 0;
}

function selfTest() {
	let ok = true;
	const ids = new Map([ [ 'example-host-1234', 'hostname' ], [ '198.18.7.9', 'public IPv4' ], [ 'Example Home Net', 'SSID' ],
		[ "Pat's-AP", 'SSID' ], [ 'Quote"d Host', 'hostname' ], [ 'zed', 'hostname' ], [ 'Lab <AP>', 'SSID' ] ]);
	for (const [ name, wantHits ] of [ [ 'addresses_bad.txt', true ], [ 'addresses_good.txt', false ] ]) {
		const lines = fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n');
		const hits = new Set(findings(lines.join('\n'), ids).map(f => f[0]));
		lines.forEach((line, i) => {
			if (!line.trim() || line.startsWith('#')) return;
			if (hits.has(i + 1) !== wantHits) { ok = false; console.log(`FAIL: ${name}:${i + 1}: ${wantHits ? 'missed' : 'flagged'}: ${line}`); }
		});
	}
	console.log(ok ? 'PASS: address policy self-test' : 'FAIL: address policy self-test');
	return ok ? 0 : 1;
}

function main(argv) {
	if (argv[0] === '--self-test') return selfTest();
	let mirror = process.env.VANTAGE_MIRROR || path.join(ROOT, '..', 'vantage-mirror'), requireMirror = false;
	const paths = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--mirror') mirror = argv[++i];
		else if (argv[i].startsWith('--mirror=')) mirror = argv[i].slice(9);
		else if (argv[i] === '--require-mirror') requireMirror = true;
		else if (argv[i].startsWith('--')) { console.log(`ERROR unknown option ${argv[i]}`); return 2; }
		else paths.push(argv[i]);
	}
	let identifiers = null;
	if (mirror && fs.existsSync(mirror) && fs.statSync(mirror).isDirectory()) {
		identifiers = mirrorIdentifiers(mirror);
		console.log(`mirror: ${identifiers.size} identifier(s) loaded`);
	} else if (requireMirror) { console.log(`ERROR mirror not found: ${mirror}`); return 2; }
	else console.log('mirror not found: device identifier check skipped');

	let targets;
	try {
		targets = paths.length ? paths.flatMap(p => walkFiles(path.resolve(p), [])) : gitFiles();
	} catch (e) {
		console.log(`ERROR cannot list files: ${e.message}`);
		return 2;
	}
	return scan(targets, identifiers);
}

/* importable: dev/replay/demo.js reuses the detectors and the mirror
   identifier list for its pseudonymiser and its test */
module.exports = { findings, mirrorIdentifiers, logHostnames, views, mask, v4finding, v6finding, v6groups, IPV4, IPV6, MAC_SEP, MAC_DOT, MAC_BARE, MAC_CONTEXT, MAC_ALLOWED, GENERIC, NAME_KEYS, PUBLIC_EXEMPT_V4, inV4, v4int };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
