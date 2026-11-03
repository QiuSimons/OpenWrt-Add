'use strict';
/* The release signing keys stay behind the release-signing environment
   (security review SEC-005): only the build job names them, and only a
   tag push puts that job in the environment. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CI = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

/* the text of one top-level job, up to the next one */
const job = name => {
	const start = CI.indexOf('\n  ' + name + ':\n');
	assert.ok(start >= 0, 'job ' + name);
	const next = CI.slice(start + 1).search(/\n  [a-z][a-z-]*:\n/);
	return next < 0 ? CI.slice(start) : CI.slice(start, start + 1 + next);
};

test('ci: the signing keys are named in the build job only, which a tag push puts in release-signing', () => {
	const build = job('build');
	for (const key of [ 'secrets.VANTAGE_SIGN_KEY', 'secrets.VANTAGE_USIGN_KEY' ]) {
		assert.ok(build.includes(key), key);
		assert.equal(CI.split(key).length, build.split(key).length, key + ' outside the build job');
	}
	assert.match(build, /\n {4}environment: \$\{\{ \(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\) && 'release-signing' \|\| '' \}\}\n/);
	assert.match(build, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\n\s+env:\n\s+SIGN_KEY:/);
});
