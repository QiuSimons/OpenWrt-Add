'use strict';
/* The static security checkers, run as part of `node --test tests/`:
   DOM sinks in the app's and the theme's JavaScript, and private
   addresses / real device identifiers in the app package and the
   repository's own trees. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function run(script, args) {
	const r = spawnSync(process.execPath, [ path.join(ROOT, 'security-tests', script), ...args ], { cwd: ROOT, encoding: 'utf8' });
	return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

test('check_dom_sinks: self-test, and 0 violations and 0 suppressions in the app and the theme', () => {
	let r = run('check_dom_sinks.js', [ '--self-test' ]);
	assert.equal(r.status, 0, r.out);
	for (const dir of [ 'luci-app-vantage/htdocs', 'luci-theme-vantage/htdocs' ]) {
		r = run('check_dom_sinks.js', [ dir ]);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, / 0 violation\(s\), 0 dom-safe suppression\(s\), 0 error\(s\)/, dir);
	}
});

test('check_private_addresses: self-test and a clean package, tests, docs, dev', () => {
	let r = run('check_private_addresses.js', [ '--self-test' ]);
	assert.equal(r.status, 0, r.out);
	r = run('check_private_addresses.js', [ 'luci-app-vantage', 'tests', 'docs', 'dev', 'security-tests' ]);
	assert.equal(r.status, 0, r.out);
	assert.match(r.out, / 0 finding\(s\)/);
});
