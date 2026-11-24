'use strict';
/* The release signing keys stay behind the release-signing environment
   (security review SEC-005): only the build job names them, and only a
   tag push puts that job in the environment. The Pages job tries the
   deploy once more when the artifact list lags the upload (v1.0.21,
   v1.1.0); before a re-run, that run's github-pages artifact is deleted
   by hand (CONTRIBUTING.md, release step 5). The same holds for the job
   that publishes the site's page again between releases, by hand, around
   the package repositories as they are live. */

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

/* the steps of a job's text, each from its "- name:" line */
const steps = text => text.split(/\n(?= {6}- name: )/).slice(1);
const uses = (list, action) => list.filter(s => s.includes('uses: ' + action + '@'));

/* the jobs that deploy to Pages: a release's, and the one run by hand */
const PAGES = [ 'repository', 'site' ];
const count = (text, s) => text.split(s).length - 1;

test('ci: a failed Pages deploy is tried once more, under the artifact name Pages is known to take', () => {
	for (const action of [ 'actions/upload-pages-artifact', 'actions/deploy-pages' ])
		assert.equal(count(CI, action + '@'), PAGES.reduce((n, name) => n + count(job(name), action + '@'), 0), action + ' outside the Pages jobs');
	assert.equal(count(CI, 'continue-on-error'), PAGES.length, 'continue-on-error on the first deploys only');
	for (const name of PAGES) pagesDeploy(job(name));
});

function pagesDeploy(repo) {
	/* the artifact keeps the name both actions use by default: Pages is
	   known to take that one, and another could not be tried before a
	   release that would depend on it */
	assert.doesNotMatch(repo, /artifact_name|PAGES_ARTIFACT|\n {10}name:/);

	assert.match(repo, /\n {4}environment:\n {6}name: github-pages\n/);

	const list = steps(repo);
	const upload = uses(list, 'actions/upload-pages-artifact');
	assert.equal(upload.length, 1);
	assert.match(upload[0], /\n {8}with:\n {10}path: site\n/);

	const deploys = uses(list, 'actions/deploy-pages');
	assert.equal(deploys.length, 2);

	/* first try: its failure must not end the job, and nothing else's may */
	const [ first, again ] = deploys;
	assert.match(first, /\n {8}id: deploy\n/);
	assert.match(first, /\n {8}continue-on-error: true\n/);
	assert.doesNotMatch(first, /\n {8}if:/);

	/* second try after a pause, only then, and its failure fails the job */
	const i = list.indexOf(first), j = list.indexOf(again);
	assert.ok(j > i + 1, 'a step between the two deploys');
	const wait = list.slice(i + 1, j);
	assert.equal(wait.length, 1);
	for (const s of [ wait[0], again ])
		assert.match(s, /\n {8}if: steps\.deploy\.outcome == 'failure'\n/);
	const pause = wait[0].match(/\n {8}run: sleep (\d+)\n/);
	assert.ok(pause && +pause[1] >= 10 && +pause[1] <= 120, 'a bounded pause');
	assert.match(again, /\n {8}id: deploy_again\n/);
	assert.doesNotMatch(again, /continue-on-error/);
	assert.equal(list.indexOf(again), list.length - 1, 'the second try is the last step');

	assert.match(repo, /\n {6}url: \$\{\{ steps\.deploy\.outputs\.page_url \|\| steps\.deploy_again\.outputs\.page_url \}\}\n/);
}

test('ci: the Pages jobs may write Pages and request an OIDC token, nothing else', () => {
	for (const name of PAGES)
		assert.match(job(name), /\n {4}permissions:\n {6}pages: write\n {6}id-token: write\n {4}[a-z]/, name);
});

test('ci: the site job runs by hand on main only, with no secret, and publishes the live repositories only as the latest release', () => {
	const site = job('site');
	assert.match(CI, /\n {2}workflow_dispatch:\n {4}inputs:\n {6}site:\n {8}description: .+\n {8}type: boolean\n {8}default: false\n/);
	assert.match(site, /\n {4}needs: checks\n {4}if: github\.event_name == 'workflow_dispatch' && inputs\.site && github\.ref == 'refs\/heads\/main'\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: \d+\n/);
	assert.doesNotMatch(site, /\bsecrets\b|github\.token|GH_TOKEN|GITHUB_TOKEN/);
	/* in a group of its own, so a push run on main and it never wait for
	   or cancel each other */
	assert.match(CI, /\n {2}group: ci-\$\{\{ github\.ref \}\}\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.site && '-site' \|\| '' \}\}\n/);

	const list = steps(site);
	assert.deepEqual(list.map(s => s.slice(14, s.indexOf('\n'))), [ 'Checkout (public key and site page)', 'Fetch the live package repositories',
		'Assemble the site', 'Upload site', 'Deploy to GitHub Pages', 'Wait before deploying again', 'Deploy to GitHub Pages (second try)' ]);

	/* the lines that make what it publishes the latest release's: each
	   whole, not commented out, and in this order (a checksum list is
	   compared before a name in it is fetched) */
	let pos = list[1].indexOf('\n          set -euo pipefail\n');
	assert.ok(pos >= 0);
	for (const line of [
		'latest="https://github.com/$GITHUB_REPOSITORY/releases/latest/download"',
		'get() { mkdir -p "${2%/*}"; curl -fsSL --retry 3 -o "$2" "$1"; }',
		'get "$latest/SHA256SUMS" release/SHA256SUMS',
		'get "$latest/packages.adb" release/packages.adb',
		'get "$latest/SHA256SUMS-$i" "release/SHA256SUMS-$i"',
		'cmp "site/$a/SHA256SUMS" release/SHA256SUMS',
		'cmp "site/$a/packages.adb" release/packages.adb',
		'cmp "site/$i/SHA256SUMS" "release/SHA256SUMS-$i"',
		'fetch "$a" $(awk \'{ print $2 }\' "site/$a/SHA256SUMS")',
		'fetch "$i" $(awk \'{ print $2 }\' "site/$i/SHA256SUMS")',
		'( cd "site/$a" && sha256sum -c SHA256SUMS )',
		'( cd "site/$i" && sha256sum -c SHA256SUMS )',
		'signify-openbsd -V -q -p keys/vantage-24.10.usign.pub -x "site/$i/Packages.sig" -m "site/$i/Packages"',
		'gunzip -c "site/$i/Packages.gz" | cmp - "site/$i/Packages"',
		'  grep -qx "SHA256sum: $h" "site/$i/Packages" || { echo "Packages does not list $h" >&2; exit 1; }',
		'for k in vantage-signing.pem vantage-24.10.usign.pub; do',
		'  get "$live/$k" "release/$k"',
		'  cmp "release/$k" "keys/$k"'
	]) {
		const i = list[1].indexOf('\n          ' + line + '\n', pos);
		assert.ok(i >= 0, 'missing, changed or out of order: ' + line);
		pos = i + 1;
	}

	/* its "Assemble the site" step adds the page's own files and nothing
	   else, as a release's does from the keys on */
	const assemble = text => {
		const s = steps(text).find(s => s.startsWith('      - name: Assemble the site\n'));
		const i = s.indexOf('\n          cp keys/');
		assert.ok(i >= 0);
		return [ s.slice(0, i), s.slice(i).trimEnd() ];
	};
	const [ before, files ] = assemble(site);
	assert.equal(before, '      - name: Assemble the site\n        run: |\n          set -euo pipefail');
	assert.equal(files, assemble(job('repository'))[1]);
	assert.equal(files.split('\n').length, 5);
});

test('ci: every action is pinned to a full commit SHA with its version in a comment', () => {
	const lines = CI.split('\n').filter(l => /^\s*(- )?uses:/.test(l));
	assert.ok(lines.length > 0);
	for (const l of lines)
		assert.match(l, /^\s*(- )?uses: [\w.-]+\/[\w.\/-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, l);
});
