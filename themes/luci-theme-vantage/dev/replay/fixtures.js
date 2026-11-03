'use strict';
/* --fixtures <dir>: hand-written device data for pages the recording never
   saw, typically third-party LuCI apps (adblock, sqm, ddns, ...). Only used
   where the recording has no answer, so recorded data stays authoritative.

     <dir>/*-plugin.js     rpcd stand-ins, same contract as dev/replay/*-plugin.js
                           (code: loaded with require(), like the templates)
     <dir>/root/etc/config/<name>
                           seeds the uci overlay; for a config the recording
                           has, only the sections it lacks are added
     <dir>/root/...        a small file system for file.read/stat/list and
                           /cgi-bin/cgi-download (fs.read_direct)
     <dir>/exec.json       [ { "argv": [ cmd, ...args ], "stdout": "..." } ]
                           for file.exec and /cgi-bin/cgi-exec ("json": v
                           instead of "stdout" answers JSON.stringify(v))

   Everything but the plugins is data: read, never compiled or run. A device
   path never leaves <dir>/root (no '..', no symlink pointing out). Fixture
   data is served as it is, also in --demo mode (which only rewrites the
   recording): documentation values only. With several directories the
   first one that has a file wins. */

const fs = require('fs');
const path = require('path');

const PLUGIN_FILE = /^[a-z0-9_.-]+-plugin\.js$/;
const CONFIG_FILE = /^[A-Za-z0-9_-]{1,64}$/;

class Fixtures {
	constructor(dirs) {
		this.dirs = (dirs || []).map(d => path.resolve(d));
		this.exec = new Map();
		for (const d of this.dirs) {
			const file = path.join(d, 'exec.json');
			let rows = [];
			try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); }
			catch (e) { if (e.code !== 'ENOENT') console.error(`[replay] ${file}: ${e.message}`); }
			for (const r of Array.isArray(rows) ? rows : []) {
				if (!r || !Array.isArray(r.argv) || !r.argv.length || !r.argv.every(a => typeof a === 'string')) continue;
				const out = (typeof r.stdout === 'string') ? r.stdout : (r.json !== undefined) ? JSON.stringify(r.json) : null;
				const key = JSON.stringify(r.argv);
				if (out != null && !this.exec.has(key)) this.exec.set(key, out);
			}
		}
	}

	pluginFiles() {
		const out = [];
		for (const d of this.dirs) {
			let files = [];
			try { files = fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isFile() && PLUGIN_FILE.test(e.name)).map(e => e.name).sort(); } catch (e) {}
			for (const f of files) out.push(path.join(d, f));
		}
		return out;
	}

	/* [ name, file ] for each root/etc/config/<name>, first directory wins */
	configs() {
		const out = new Map();
		for (const d of this.dirs) {
			let files = [];
			try { files = fs.readdirSync(path.join(d, 'root/etc/config')).filter(f => CONFIG_FILE.test(f)).sort(); } catch (e) {}
			for (const f of files) {
				const file = this.within(d, '/etc/config/' + f);
				if (file && !out.has(f)) out.set(f, file);
			}
		}
		return [ ...out ];
	}

	/* absolute device path -> real path inside <dir>/root, or null; the
	   path must be absolute, without '..' or control characters, and its
	   real path (symlinks resolved) must stay inside the root */
	static devicePath(p) {
		return typeof p === 'string' && p.startsWith('/') && p.length < 4096 &&
			!/[\0-\x1f\x7f]/.test(p) && !p.split('/').includes('..');
	}

	within(dir, p) {
		if (!Fixtures.devicePath(p)) return null;
		let real, root;
		try {
			root = fs.realpathSync(path.join(dir, 'root'));
			real = fs.realpathSync(path.join(root, p));
		} catch (e) { return null; }
		return (real === root || real.startsWith(root + path.sep)) ? real : null;
	}

	resolve(p) {
		for (const d of this.dirs) {
			const f = this.within(d, p);
			if (f) return f;
		}
		return null;
	}

	static statOf(st) {
		const t = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'unknown';
		const s = n => Math.floor(n / 1000);
		return { type: t, size: st.size, mode: t === 'directory' ? 16877 : 33188, atime: s(st.atimeMs), mtime: s(st.mtimeMs), ctime: s(st.ctimeMs), inode: st.ino, uid: 0, gid: 0 };
	}

	/* a directory merged across the fixture roots; entries that resolve
	   outside their root (symlinks) are left out */
	list(p) {
		const seen = new Map();
		let found = false;
		for (const d of this.dirs) {
			const dir = this.within(d, p);
			let st;
			try { st = dir && fs.statSync(dir); } catch (e) { continue; }
			if (!st || !st.isDirectory()) continue;
			found = true;
			for (const n of fs.readdirSync(dir).sort()) {
				if (seen.has(n)) continue;
				const f = this.within(d, path.posix.join(p, n));
				let cs;
				try { cs = f && fs.statSync(f); } catch (e) { continue; }
				if (cs) seen.set(n, Object.assign({ name: n }, Fixtures.statOf(cs)));
			}
		}
		return found ? [ ...seen.values() ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : null;
	}

	/* rpcd's file object (read, stat, list); null when no fixture has the path */
	file(method, args) {
		const p = args && args.path;
		if (method === 'list') {
			const entries = this.list(p);
			if (entries) return { result: [ 0, { entries } ] };
			return this.resolve(p) ? { result: [ 2 ] } : null;
		}
		if (method !== 'read' && method !== 'stat') return null;
		const f = this.resolve(p);
		if (!f) return null;
		let st;
		try { st = fs.statSync(f); } catch (e) { return null; }
		if (method === 'stat') return { result: [ 0, Object.assign({ path: p }, Fixtures.statOf(st)) ] };
		if (!st.isFile()) return { result: [ 2 ] };
		return { result: [ 0, { data: fs.readFileSync(f, 'utf8') } ] };
	}

	/* raw bytes for cgi-download, or null */
	read(p) {
		const f = this.resolve(p);
		try { return f && fs.statSync(f).isFile() ? fs.readFileSync(f) : null; } catch (e) { return null; }
	}

	execText(argv) {
		const out = this.exec.get(JSON.stringify(argv));
		return out === undefined ? null : out;
	}
}

module.exports = { Fixtures };
