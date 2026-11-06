'use strict';
/* LuCI's build minifies every shipped script with jsmin, which reads a
   "/" after `return` (and some other words) as a division: an escaped
   slash followed by a star or another slash inside such a regular
   expression then starts a "comment", the rest of the line is dropped
   and the packaged script no longer parses (1.0.15's release build:
   /(^|\/)vantage\/*$/ after return). verify_built_apk catches it only in
   the package build; this catches it before. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function scripts(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...scripts(p));
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out;
}

test('shipped scripts: no escaped slash followed by * or another slash (jsmin reads a comment)', () => {
	const files = [ 'luci-app-vantage/htdocs', 'luci-theme-vantage/htdocs' ].flatMap(d => scripts(path.join(ROOT, d)));
	assert.ok(files.length > 10, 'found the shipped scripts');
	const bad = [];
	for (const f of files)
		fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
			if (/\\\/[*]|\\\/\\\//.test(line)) bad.push(path.relative(ROOT, f) + ':' + (i + 1) + ': ' + line.trim().slice(0, 80));
		});
	assert.deepEqual(bad, []);
});

/* the regular expression's closing "/" after one of these is, to jsmin,
   the start of a new one (it already read the opening "/" as a division),
   which runs to the end of the line: /^up:/ after return broke the
   package build of the #88 change ("Unterminated set in Regular
   Expression literal") */
const JSMIN_REGEX_START = '(,=:[!&|?{};+-~*/';
function closingSlashPrev(line, from) {
	let inSet = false;
	for (let i = from; i < line.length; i++) {
		const c = line[i];
		if (c === '\\') { i++; continue; }
		if (c === '[') inSet = true;
		else if (c === ']') inSet = false;
		else if (c === '/' && !inSet) return line[i - 1];
	}
	return null;
}

test('shipped scripts: no regular expression after return that ends in a character jsmin starts one after', () => {
	const files = [ 'luci-app-vantage/htdocs', 'luci-theme-vantage/htdocs' ].flatMap(d => scripts(path.join(ROOT, d)));
	const bad = [];
	for (const f of files)
		fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
			for (const m of line.matchAll(/\b(?:return|typeof|case|do|else|in|instanceof|new|void|delete|throw)\s*\/(?![/*])/g)) {
				const prev = closingSlashPrev(line, m.index + m[0].length);
				if (prev != null && JSMIN_REGEX_START.includes(prev)) bad.push(path.relative(ROOT, f) + ':' + (i + 1) + ': ' + line.trim().slice(0, 80));
			}
		});
	assert.deepEqual(bad, []);
});

test('jsmin regex check: catches the #88 pattern, passes ordinary ones', () => {
	const hit = line => { const m = /\breturn\s*\/(?![/*])/.exec(line); return !!m && JSMIN_REGEX_START.includes(closingSlashPrev(line, m.index + m[0].length)); };
	assert.equal(hit("function h(k) { return /^up:/.test(k) ? 1 : 2; }"), true);
	assert.equal(hit("return /^wan$/.test(i.interface) ? 0 : 1;"), false);
	assert.equal(hit("return /[:/]$/.test(s);"), false);
	assert.equal(hit("return key.indexOf('up:') === 0;"), false);
});
