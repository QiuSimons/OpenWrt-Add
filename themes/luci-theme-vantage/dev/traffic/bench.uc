// What a read of luci-app-vantage-traffic's plugin costs end to end, on
// the device this runs on (#110). In no package: copy it to the router and
// run it there. It needs ucode and its fs module, nothing else (a stock
// OpenWrt has both), not the package.
//
//   ucode bench.uc <dir> [entries ...]       (default 500 2000 8000 16384)
//   ucode bench.uc <dir> churn [entries] [percent] [reads] [large]
//                                            (default 2000 20 120 10)
//
// The second form keeps a table of that many entries through that many
// reads 5 s apart (by the plugin's clock), each read with that share of
// them ended and as many new ones begun, as on a busy router, and prints
// what the state holds at the end and what the last read cost. A `large`
// percent of its entries carry more than KEEP_BYTES and grow, the others
// a lookup's few hundred bytes.
//
// It makes <dir>/vantage-traffic-bench (0700), and for each size writes a
// synthetic table in the kernel's format of /proc/net/nf_conntrack there
// (documentation addresses only: 192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24, 2001:db8::/32; a quarter of it IPv6, an eighth UDP),
// then reads it twice as the plugin reads it (its own code, below:
// tests/traffic.test.js holds it to the plugin's, byte for byte): the
// saved state loaded, the table counted, the state saved. The second read
// finds every entry again with its counters grown: what the plugin does
// at every read while a dashboard is open. It prints how long each part
// took, per entry, the state file's size and this process's memory, and
// removes what it made. The plugin's own process adds to that: ucode
// starting (time it with `time ucode -e 1`), two neighbour dumps and the
// answer, a few milliseconds.
//
// Not measured: the kernel's own work to print the real table. For that
// it also times one plain read of /proc/net/nf_conntrack when there is
// one, and counts how many of its lines the plugin's layout table fits
// (read only; no line is kept or shown, only counts by protocol).
'use strict';

import { chmod, lstat, mkdir, open, readfile, rename, rmdir, stat, unlink, writefile } from 'fs';

const MAX_ENTRIES = 16384;        // entries read a time (nf_conntrack_max: 2048 up, by RAM)
const MAX_HOSTS = 512;            // hosts counted, as luci.vantage wired lists
const MAX_KEY = 160;              // characters of an entry's key: 115 at most by the layout table (IPv6 gre), 15 more with a zone
const MAX_STATE = 2 * MAX_ENTRIES * (MAX_KEY + 74) + MAX_HOSTS * (17 + 74) + 128;
const STOP_MS = 2000;             // the table is read no longer than this
const CHECK_EVERY = 64;           // entries between looks at the clock
const KEEP_MS = 150000;           // an entry a read did not see is known this long: longer than the 2-minute back-off
const KEEP_BYTES = 65536;         // ... past the next read only from this many bytes, both ways (or after a partial read)
const PROTO = {
	tcp: [ 13, 14, 5 ], udp: [ 13, 13, 5 ], udplite: [ 9, 9, 5 ], sctp: [ 12, 13, 5 ], dccp: [ 12, 13, 5 ],
	icmp: [ 12, 12, 6 ], icmpv6: [ 10, 10, 6 ], gre: [ 13, 15, 5 ], unknown: [ 9, 9, 3 ]
};
const RE_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

let flows = {};
let totals = {}, ntotals = 0;
let before = null;
let DIR = null;                   // the plugin's state directory: here the bench's own

function now_ms() {
	let t = clock(true);
	return t[0] * 1000 + int(t[1] / 1000000);
}

function count(s) {
	let n = (s == null) ? 0 : int(s);
	return (n == n && n >= 0) ? n : 0;
}

function kv(s, key) {
	let i = index(s, key);
	if (i < 0)
		return null;
	s = substr(s, i + length(key));
	i = index(s, ' ');
	return (i < 0) ? s : substr(s, 0, i);
}

function zone(l) {
	let z = count(kv(l, ' zone='));
	return z ? 'zone=' + z : '';
}

function parse(l, e) {
	let t = split(l, ' '), p = PROTO[t[6]];
	if (!p)
		return false;
	let s = p[1] + ((+t[p[0]] >= 0) ? 1 : 0), a = p[2], r = s + a + 1;
	if (t[r] == '[UNREPLIED]')
		r++;
	// the protocol's number, then the original tuple: what does not change
	e[0] = t[p[0] - 1] + join('', slice(t, s, s + a - 1));
	e[1] = t[s];
	e[2] = +substr(t[s + a], 6);
	e[3] = t[r];
	e[4] = +substr(t[r + a], 6);
	e[5] = t[r + a + 1];
	if (t[r + a + 3] != 'zone=0' && t[r + a + 2] != 'zone=0')
		e[0] += zone(l);
	return true;
}

function parse_slow(l) {
	if (type(l) != 'string')
		return null;
	let h = split(l, ' src=', 3), head = h[0], o = h[1], r = h[2] ?? '';
	let fam = substr(head, 0, 4);
	if ((fam != 'ipv4' && fam != 'ipv6') || length(head) < 22 || o == null)
		return null;
	// the head ends at the protocol's number on an offloaded entry without a state
	let b = (fam == 'ipv4') ? 20 : 21, e = index(substr(head, b, 4) + ' ', ' ');
	let sp = index(o, ' '), end = index(o, ' packets='), rs = index(r, ' ');
	let ob = kv(o, ' bytes='), x = index(r, 'OFFLOAD]'), hw = x > 2 && substr(r, x - 3, 3) == 'HW_';
	if (e <= 0 || sp <= 0)
		return null;
	if (end < 0)
		end = index(o, ' [');
	return {
		key: substr(head, b, e) + 'src=' + join('', split((end < 0) ? o : substr(o, 0, end), ' ')) + zone(l),
		osrc: substr(o, 0, sp),
		obytes: count(ob),
		rsrc: (rs > 0) ? substr(r, 0, rs) : null,
		rbytes: count(kv(r, ' bytes=')),
		acct: ob != null,
		off: x > 0 && !hw,
		hw
	};
}

function norm(a) {
	if (index(a, ':') < 0)
		return a;
	let x = iptoarr(a);
	return x ? arrtoip(x) : null;
}

function add(mac, rx, tx, now, st) {
	if (!rx && !tx)
		return;
	if (ntotals >= MAX_HOSTS) {
		if (!st.over[mac]) {
			st.over[mac] = true;
			st.dropped++;
		}
		return;
	}
	totals[mac] = [ rx, tx, now ];
	ntotals++;
}

function feed(f, neigh, now, stop, st) {
	// "src=A" -> its host's MAC, '' (no host), false (no src field): once each
	let memo = {}, e = [], n = 0, counted = 0, noacct = 0, off = 0, hw = 0, zeroed = 0, partial = false;
	let who = (a) => {
		let v = false;
		if (substr(a, 0, 4) == 'src=') {
			let x = norm(substr(a, 4));
			v = (x != null && neigh[x]) ? neigh[x] : '';
		}
		return (memo[a] = v);
	};

	for (let l = f.read('line'); l; l = f.read('line')) {
		if (n >= MAX_ENTRIES) {
			partial = 'entries';
			break;
		}
		if (n && !(n & (CHECK_EVERY - 1)) && now_ms() >= stop) {
			partial = 'time';
			break;
		}
		n++;
		let lo = parse(l, e) ? (memo[e[1]] ?? who(e[1])) : false;
		let lr = (lo !== false) ? (memo[e[3]] ?? who(e[3])) : false;
		if (lr === false || !(e[2] >= 0 && e[4] >= 0)) {
			// not the table's layout: search the line
			let o = parse_slow(l);
			if (!o)
				continue;
			if (!o.acct) {
				noacct++;
				continue;
			}
			e[0] = o.key;
			e[2] = o.obytes;
			e[4] = o.rbytes;
			e[5] = o.hw ? '[HW_OFFLOAD]' : o.off ? '[OFFLOAD]' : '';
			lo = memo['src=' + o.osrc] ?? who('src=' + o.osrc);
			lr = (o.rsrc != null) ? (memo['src=' + o.rsrc] ?? who('src=' + o.rsrc)) : '';
		}
		counted++;
		if (e[5] != '[ASSURED]') {
			if (e[5] == '[OFFLOAD]')
				off++;
			else if (e[5] == '[HW_OFFLOAD]')
				hw++;
		}
		let k = e[0], ob = e[2], rb = e[4], prev = flows[k], dob = ob, drb = rb;
		if (prev) {
			if (ob >= prev[0] && rb >= prev[1]) {
				dob -= prev[0];
				drb -= prev[1];
			}
			else if (prev[2] == before)
				zeroed++;
			prev[0] = ob;
			prev[1] = rb;
			prev[2] = now;
		}
		else if (length(k) <= MAX_KEY)
			flows[k] = [ ob, rb, now ];
		else
			continue;    // not this table's: one it could not know again
		// the host that opened it sent the original direction; one it was
		// opened to (a port forward, another of this router's networks)
		// sent the reply. As this router counts them: rx from, tx to
		if (lo) {
			let t = totals[lo];
			if (!t)
				add(lo, dob, drb, now, st);
			else if (dob || drb) {
				t[0] += dob;
				t[1] += drb;
				t[2] = now;
			}
		}
		if (lr && lr != lo) {
			let t = totals[lr];
			if (!t)
				add(lr, drb, dob, now, st);
			else if (dob || drb) {
				t[0] += drb;
				t[1] += dob;
				t[2] = now;
			}
		}
	}

	st.entries = n;
	st.counted = counted;
	st.noacct = noacct;
	st.offloaded = off;
	st.hw = hw;
	st.zeroed = zeroed;
	st.partial = partial;

	// An entry the read did not see may have ended, or the read missed
	// it: a read stops short, and the kernel lists the table by position,
	// starting again at every read() of about a page, so each entry
	// removed behind that place hides the next one. Kept, so that it does
	// not count whole when a read sees it again: one the read before saw,
	// whatever its size, however long ago (no read while nobody looks):
	// that covers a single miss; then, seen less than KEEP_MS ago, one
	// that carried KEEP_BYTES or more, or any after a partial read (those
	// it did not reach are many, and mostly still there); MAX_ENTRIES at
	// most, those the read before saw first (never more than that read
	// saw: all of them). A smaller one missed by two whole reads running
	// counts twice when one sees it again: by less than KEEP_BYTES, once.
	// Lookups and short exchanges that ended stay one read, not KEEP_MS,
	// on a router where connections come and go
	let gone = [], recent = [], older = [], kept = 0;
	for (let k, v in flows)
		if (v[2] != now)
			push((v[2] == before) ? recent : (!partial && v[0] + v[1] < KEEP_BYTES) ? gone : (now - v[2] < KEEP_MS) ? older : gone, k);
	for (let k in [ ...recent, ...older ])
		if (++kept > MAX_ENTRIES)
			push(gone, k);
	for (let k in gone)
		delete flows[k];
}

function put(name, text) {
	let tmp = DIR + '/' + name + '.new', file = DIR + '/' + name;
	if (writefile(tmp, text) == length(text) && lstat(tmp)?.size === length(text) && chmod(tmp, 0600) && rename(tmp, file) === true)
		return true;
	unlink(tmp);
	return false;
}

function entry_ok(v) {
	if (type(v) != 'array' || length(v) != 3)
		return false;
	let a = v[0], b = v[1], c = v[2];
	return a === +a && b === +b && c === +c && a >= 0 && b >= 0 && c >= 0;
}

function load_state() {
	let text = readfile(DIR + '/state.json', MAX_STATE + 1), st = null;
	if (type(text) == 'string' && length(text) <= MAX_STATE)
		try { st = json(text); } catch (err) { st = null; }
	let ok = type(st) == 'object' && st.v == 3 && type(st.flows) == 'object' && type(st.totals) == 'object' &&
		(st.at == null || st.at === +st.at) && length(st.totals) <= MAX_HOSTS;
	for (let k, v in (ok ? st.flows : {}))
		if (length(k) > MAX_KEY || !entry_ok(v)) {
			ok = false;
			break;
		}
	for (let k, v in (ok ? st.totals : {}))
		if (!match(k, RE_MAC) || !entry_ok(v)) {
			ok = false;
			break;
		}
	flows = ok ? st.flows : {};
	totals = ok ? st.totals : {};
	ntotals = length(totals);
	before = ok ? st.at : null;
}

function save_state(now) {
	return put('state.json', sprintf('%J', { v: 3, at: now, flows, totals }));
}

/* -------------------------------------------------------- the bench */

let base = ARGV[0], churn = (ARGV[1] == 'churn') ? map(slice(ARGV, 2), (n) => int(n)) : null;
let sizes = churn ? [ churn[0] ?? 2000 ] : map(slice(ARGV, 1), (n) => int(n));
if (!length(sizes))
	sizes = [ 500, 2000, 8000, MAX_ENTRIES ];
if (type(base) != 'string' || stat(base)?.type != 'directory') {
	warn('usage: ucode bench.uc <directory> [entries ...] | churn [entries] [percent] [reads] [large]\n');
	exit(1);
}
for (let n in sizes)
	if (!(n > 0 && n <= MAX_ENTRIES)) {
		warn(sprintf('entries: 1 to %d\n', MAX_ENTRIES));
		exit(1);
	}

DIR = base + '/vantage-traffic-bench';
if (lstat(DIR) || !mkdir(DIR, 0700)) {
	warn(sprintf('%s exists or cannot be made; remove it or pick another directory\n', DIR));
	exit(1);
}
const TABLE = DIR + '/nf_conntrack';

// the table, written to its file: n entries over m hosts from entry
// `first` on, every counter k steps on; with `large` (a percent), that
// share of them large and growing, the others a few hundred bytes. Line
// by line, so that what this process holds is the count's
function table(n, m, k, first, large) {
	let out = open(TABLE, 'w');
	if (!out)
		die(sprintf('cannot write %s\n', TABLE));
	for (let i = first ?? 0; i < (first ?? 0) + n; i++) {
		let h = i % m, up = 1000 + i + k * 100, down = 5000 + i + k * 1000;
		if (large != null) {
			let big = (i * 37) % 100 < large;
			up = big ? KEEP_BYTES + k * 1000 : 60 + i % 40;
			down = big ? 10 * KEEP_BYTES + k * 10000 : 120 + i % 200;
		}
		if (i % 4 == 3) {
			let a = sprintf('2001:0db8:0000:0000:0000:0000:0000:%04x', h + 1), b = sprintf('2001:0db8:0001:0000:0000:0000:0000:%04x', i % 250 + 1);
			out.write(sprintf('ipv6     10 tcp      6 7438 ESTABLISHED src=%s dst=%s sport=%d dport=443 packets=%d bytes=%d src=%s dst=%s sport=443 dport=%d packets=%d bytes=%d [ASSURED] mark=0 zone=0 use=2\n',
				a, b, 1024 + i % 64000, 10 + k, up, b, a, 1024 + i % 64000, 10 + k, down));
		}
		else if (i % 8 == 2) {
			let a = sprintf('%s.%d', (h < 254) ? '192.0.2' : '198.51.100', h % 254 + 1), b = sprintf('203.0.113.%d', i % 250 + 1);
			out.write(sprintf('ipv4     2 udp      17 54 src=%s dst=%s sport=%d dport=53 packets=%d bytes=%d src=%s dst=203.0.113.254 sport=53 dport=%d packets=%d bytes=%d mark=0 zone=0 use=2\n',
				a, b, 1024 + i % 64000, 1 + k, up, b, 1024 + i % 64000, 1 + k, down));
		}
		else {
			let a = sprintf('%s.%d', (h < 254) ? '192.0.2' : '198.51.100', h % 254 + 1), b = sprintf('203.0.113.%d', i % 250 + 1);
			out.write(sprintf('ipv4     2 tcp      6 7438 ESTABLISHED src=%s dst=%s sport=%d dport=443 packets=%d bytes=%d src=%s dst=203.0.113.254 sport=443 dport=%d packets=%d bytes=%d [ASSURED] mark=0 zone=0 use=2\n',
				a, b, 1024 + i % 64000, 10 + k, up, b, 1024 + i % 64000, 10 + k, down));
		}
	}
	out.close();
}

// address -> MAC as the plugin's neighbours() gives it, for m hosts
function neighbours(m) {
	let out = {};
	for (let h = 0; h < m; h++) {
		let mac = sprintf('02:00:5e:00:%02x:%02x', h >> 8, h & 255);
		out[sprintf('%s.%d', (h < 254) ? '192.0.2' : '198.51.100', h % 254 + 1)] = mac;
		out[sprintf('2001:db8::%x', h + 1)] = mac;
	}
	return out;
}

// this process's resident memory now and at its peak, KiB
function memory() {
	let s = readfile('/proc/self/status', 8192) ?? '', out = {};
	for (let k in [ 'VmRSS', 'VmHWM' ]) {
		let i = index(s, k + ':');
		out[k] = (i < 0) ? null : int(trim(substr(s, i + length(k) + 1, 16)));
	}
	return out;
}

// one read as the plugin makes it, without its time budget: ms of each part
function read(neigh, now) {
	let st = { entries: 0, counted: 0, noacct: 0, partial: false, offloaded: 0, hw: 0, zeroed: 0, dropped: 0, over: {} };
	let t0 = now_ms();
	load_state();
	let t1 = now_ms(), f = open(TABLE, 'r');
	if (!f)
		die(sprintf('cannot read %s\n', TABLE));
	feed(f, neigh, now, t1 + 3600000, st);
	f.close();
	let t2 = now_ms();
	save_state(now);
	let t3 = now_ms();
	return { load: t1 - t0, count: t2 - t1, save: t3 - t2, all: t3 - t0, st };
}

// the real table: how long the kernel takes to print it, and whether the
// plugin's layout table fits its lines (those it does not go to
// parse_slow, at several times the cost); nothing of it is kept or shown
let real = churn ? null : open('/proc/net/nf_conntrack', 'r');
if (real) {
	let t0 = now_ms(), n = 0;
	while (real.read('line'))
		n++;
	real.close();
	let t1 = now_ms(), fit = 0, e = [], other = {};
	real = open('/proc/net/nf_conntrack', 'r');
	for (let l = real.read('line'); l; l = real.read('line')) {
		if (parse(l, e) && substr(e[1], 0, 4) == 'src=' && substr(e[3], 0, 4) == 'src=' && e[2] >= 0 && e[4] >= 0)
			fit++;
		else {
			let k = split(l, ' ')[6] ?? '?';
			other[k] = (other[k] ?? 0) + 1;
		}
	}
	real.close();
	print(sprintf('this device\'s own table: %d entries, read (not parsed) in %d ms; the layout table fits %d of them%s\n',
		n, t1 - t0, fit, length(other) ? sprintf(' (the others by protocol: %J)', other) : ''));
}

if (churn) {
	let n = sizes[0], c = int(n * (churn[1] ?? 20) / 100), reads = churn[2] ?? 120, large = churn[3] ?? 10, m = min(250, max(10, int(n / 20)));
	let neigh = neighbours(m), r = null;
	for (let k = 0; k < reads; k++) {
		table(n, m, k, k * c, large);
		r = read(neigh, k * 5000);
	}
	let size = stat(DIR + '/state.json')?.size ?? 0, mem = memory();
	print(sprintf('churn: %d entries, %d ended and begun a read, %d reads 5 s apart, %d %% large: the state holds %d entries, %d KiB; the last read %d ms = state load %d + table %d + state save %d; memory %s KiB, peak %s KiB\n',
		n, c, reads, large, length(flows), int(size / 1024), r.all, r.load, r.count, r.save, mem.VmRSS ?? '?', mem.VmHWM ?? '?'));
	sizes = [];
}
else
	print(sprintf('the plugin stops reading the table after %d ms. This process before the reads: %s KiB\n', STOP_MS, memory().VmRSS ?? '?'));
for (let n in sizes) {
	let m = min(250, max(10, int(n / 20)));
	let neigh = neighbours(m);
	unlink(DIR + '/state.json');
	flows = {};
	totals = {};
	ntotals = 0;
	table(n, m, 0);
	let a = read(neigh, 0);
	table(n, m, 1);
	flows = {};
	totals = {};
	let b = read(neigh, 5000), mem = memory(), size = stat(DIR + '/state.json')?.size ?? 0;
	let stops = (b.count > STOP_MS) ? sprintf('; the plugin would stop near %d', int(n * STOP_MS / b.count)) : '';
	print(sprintf('%6d entries, %3d hosts: first read %5d ms, next %5d ms = state load %d + table %d + state save %d (%d us an entry)%s; state %d KiB; memory %s KiB, peak %s KiB\n',
		n, ntotals, a.all, b.all, b.load, b.count, b.save, int(b.all * 1000 / n), stops, int(size / 1024), mem.VmRSS ?? '?', mem.VmHWM ?? '?'));
}
unlink(TABLE);
unlink(DIR + '/state.json');
rmdir(DIR);
