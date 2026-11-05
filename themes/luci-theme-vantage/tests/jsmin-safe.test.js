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
