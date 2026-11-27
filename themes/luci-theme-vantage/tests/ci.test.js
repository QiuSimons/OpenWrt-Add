'use strict';
/* The release signing keys stay behind the release-signing environment
   (security review SEC-005), and reach one job only: the one that signs
   the package index, on a machine of its own, after the packages were
   built and compared with the manifest. The build job, which fetches the
   feeds and compiles, has no secret and no environment; every run that is
   no release goes through the signing job's steps with a throwaway key.
   The Pages job tries the deploy once more when the artifact list lags
   the upload (v1.0.21, v1.1.0); before a re-run, that run's github-pages
   artifact is deleted by hand (CONTRIBUTING.md, release step 5). The same
   holds for the job that publishes the site's page again between
   releases, by hand, around the package repositories as they are live. */

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

/* the steps of a job's text, each from its "- name:" line */
const steps = text => text.split(/\n(?= {6}- name: )/).slice(1);
const uses = (list, action) => list.filter(s => s.includes('uses: ' + action + '@'));
const count = (text, s) => text.split(s).length - 1;
const TAG_PUSH = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";

test('ci: the signing keys are named in the signing job only, the one job in release-signing; the build has neither', () => {
	const sign = job('sign'), build = job('build');
	for (const key of [ 'secrets.VANTAGE_SIGN_KEY', 'secrets.VANTAGE_USIGN_KEY' ]) {
		assert.ok(sign.includes(key), key);
		assert.equal(count(CI, key), count(sign, key), key + ' outside the signing job');
	}
	assert.equal(count(CI, 'secrets.'), count(sign, 'secrets.'), 'no other job names a secret');
	assert.match(sign, /\n {4}environment: release-signing\n/);
	assert.equal(count(CI, 'environment: release-signing'), 1);
	assert.ok(sign.includes('\n    needs: build\n    if: ' + TAG_PUSH + '\n'), 'after the build, on a pushed tag only');
	/* the build: every event, no environment, no secret, and it uploads no index */
	assert.doesNotMatch(build, /\n {4}(environment|if):|secrets\.|SIGN|packages\.adb|Packages/);
	const list = steps(build);
	assert.deepEqual(list.map(s => s.slice(14, s.indexOf('\n'))), [ 'Checkout', 'Set up Node.js', 'Build with the pinned SDK (verifies every package)',
		'Check against the committed release manifest', 'Upload packages' ]);
	assert.doesNotMatch(list[2], /\n {8}(if|env):/);
	assert.match(list[2], /\n {10}dev\/build\/sdk-build\.sh "\$SDK_RELEASE" HEAD\n/);
	assert.equal(count(build, 'sdk-build.sh'), 1);
});

/* The signing job (review finding 24, second round): a fresh machine with
   the checkout and the packages as built, nothing else of the build. The
   rehearsal is the same job for runs that are no release: a throwaway
   key, and no manifest step, since only a release has a manifest. */
test('ci: the signing job and its rehearsal are the same steps, apart from the key and the manifest', () => {
	const sign = job('sign'), reh = job('rehearsal');
	const s = steps(sign), r = steps(reh);
	const names = l => l.map(x => x.slice(14, x.indexOf('\n')));
	const MANIFEST = 'Check against the committed release manifest';
	assert.deepEqual(names(s), [ 'Checkout', 'Download the packages as built', MANIFEST, 'Sign the package index', 'Upload the signed packages' ]);
	assert.deepEqual(names(r), names(s).filter(n => n !== MANIFEST));
	const [ checkout, download, manifest, signing, upload ] = s;

	/* never the same run: one on a pushed tag, the other on everything else; both after the build */
	assert.ok(reh.includes('\n    needs: build\n    if: ${{ !(' + TAG_PUSH + ') }}\n'));
	assert.doesNotMatch(reh, /\n {4}environment:|secrets\.|\bSIGN_KEY:|\$SIGN_KEY|keys\//);
	/* the same machine, time limit and matrix as each other, the matrix the build's too */
	const head = t => t.slice(t.indexOf('\n    runs-on:'), t.indexOf('\n    steps:\n')).replace(/\n {4}#.*|\n {4}environment: release-signing/g, '');
	assert.equal(head(reh), head(sign));
	const matrix = t => t.slice(t.indexOf('\n    strategy:\n'), t.indexOf('\n    steps:\n'));
	assert.equal(matrix(sign), matrix(job('build')));

	/* word for word: the checkout, the download, and the upload but for its name and how long it is kept */
	const end = t => t.split('\n\n')[0].trimEnd();
	assert.equal(r[0], checkout);
	assert.equal(r[1], download);
	assert.equal(end(r[3]).replace('          name: rehearsal-', '          name: signed-').replace('          retention-days: 1\n', ''), end(upload));
	assert.ok(end(r[3]).includes('          name: rehearsal-${{ env.SDK_RELEASE }}\n          retention-days: 1\n'));
	/* nothing of the build but its packages, sums and record: no tools, no Node set up to run any */
	assert.doesNotMatch(sign, /setup-node|dist\/\.tools|\bnode\b|fetch-depth/);
	assert.match(download, /\n {10}name: vantage-\$\{\{ env\.SDK_RELEASE \}\}\n {10}path: dist\/\$\{\{ env\.SDK_RELEASE \}\}\n/);
	/* the manifest once more, as the build job checked it */
	assert.equal(manifest, steps(job('build'))[3]);

	/* the signing step: one pipeline into one script. The secret leaves the
	   step's environment before anything is started, is never written to a
	   file, and goes to the script's standard input */
	assert.match(signing, /\n {8}env:\n {10}SIGN_KEY: \$\{\{ matrix\.fmt == 'apk' && secrets\.VANTAGE_SIGN_KEY \|\| secrets\.VANTAGE_USIGN_KEY \}\}\n {8}run: \|\n {10}set -euo pipefail\n(?: {10}#.*\n)* {10}key=\$SIGN_KEY\n {10}unset SIGN_KEY\n/);
	assert.doesNotMatch(signing, /RUNNER_TEMP|umask|> ?"\$key"|-out |VANTAGE_SIGN_PUB/, 'no key file, and the committed public keys');
	assert.ok(signing.trimEnd().endsWith('\n          printf \'%s\\n\' "$key" | VANTAGE_SIGN_KEY=- dev/build/sdk-build.sh --sign "$SDK_RELEASE"'));
	assert.equal(count(signing, 'sdk-build.sh'), 1);
	/* the rehearsal's: a key from the SDK image, its public half named, then the same pipeline */
	assert.equal(r[2].trimEnd(), [
		'      - name: Sign the package index',
		'        run: |',
		'          set -euo pipefail',
		'          key=$(dev/build/sdk-build.sh --throwaway-key "$SDK_RELEASE" "$RUNNER_TEMP/throwaway.pub")',
		'          printf \'%s\\n\' "$key" | VANTAGE_SIGN_KEY=- VANTAGE_SIGN_PUB="$RUNNER_TEMP/throwaway.pub" dev/build/sdk-build.sh --sign "$SDK_RELEASE"'
	].join('\n'));

	/* what is published is what the signing job uploaded, never the build's own artifact */
	assert.match(job('release'), /\n {4}needs: sign\n/);
	for (const name of [ 'release', 'repository' ]) {
		const j = job(name);
		assert.equal(count(j, '\n          pattern: signed-*\n'), 1, name);
		assert.equal(count(j, 'a="release/signed-$SDK_APK" i="release/signed-$SDK_IPK"'), 1, name);
		assert.doesNotMatch(j, /vantage-\*|release\/vantage-|rehearsal/);
	}
});

const SDK_BUILD = fs.readFileSync(path.join(__dirname, '..', 'dev', 'build', 'sdk-build.sh'), 'utf8');
/* a script the build script keeps in a variable: name=$(cat <<'INNER' ... INNER) or name='...' */
const inner = name => {
	const m = SDK_BUILD.match(new RegExp("\\n" + name + "=\\$\\(cat <<'INNER'\\n([\\s\\S]*?)\\nINNER\\n\\)\\n")) ||
		SDK_BUILD.match(new RegExp("\\n" + name + "='\\n([^']*)'\\n"));
	assert.ok(m, name);
	return m[1];
};
const fn = name => {
	const a = SDK_BUILD.indexOf('\n' + name + '() {\n'), b = SDK_BUILD.indexOf('\n}\n', a);
	assert.ok(a >= 0 && b > a, name);
	return SDK_BUILD.slice(a, b);
};

test('sdk-build.sh: the container that builds has no key; the key is read by one container without network, which checks what it signed', () => {
	const build = inner('inner'), signer = inner('inner_sign'), signIndex = fn('sign_index');
	assert.match(build, /\nbash \/entrypoint\.sh /);
	assert.doesNotMatch(build, /PRIVATE_KEY|KEY_BUILD|private-key|key-build|\bSIGN\b|\bcat\)/);
	/* the build: everything after the modes that sign; its one container reads nothing */
	const tail = SDK_BUILD.slice(SDK_BUILD.indexOf('\nwork=$(mktemp -d "${TMPDIR:-/tmp}/vantage-build.XXXXXX")\n'));
	assert.match(tail, /\npodman "\$\{podman_args\[@\]\}" < \/dev\/null > /);
	assert.equal(count(tail, '\npodman '), 1);
	assert.doesNotMatch(tail.slice(0, tail.lastIndexOf('\n[ -z "$keysrc" ] || sign_index\n')), /keysrc|pubabs|VANTAGE_SIGN|inner_sign|INDEX|offline/);

	/* both containers of the signing step have no network */
	assert.match(SDK_BUILD, /\noffline=\(run --rm --pull=missing --network=none\n/);
	assert.equal(count(signIndex, 'podman '), 2, 'the key from standard input, or from the file');
	assert.equal(count(signIndex, 'podman "${run[@]}"'), 2);
	assert.ok(signIndex.includes('\trun=("${offline[@]}" -i '));
	assert.ok(signIndex.includes('podman "${run[@]}" < "$keysrc" > '));
	/* no program on this machine opens the key, and none the build produced is run */
	assert.doesNotMatch(SDK_BUILD, /\b(head|cat|grep|sed|awk|cp|usign|openssl|sha256sum)\b[^\n|;]*"\$keysrc"/);
	assert.doesNotMatch(signIndex, /\bnode\b|verify_built|dist\/\.tools|\$tools|usign"? -|openssl/);
	assert.doesNotMatch(fn('throwaway_key'), /\bnode\b|dist\/\.tools|\$tools/);

	/* in the container: the SDK's index target, the key deleted, then the checks, with the image's tools */
	assert.doesNotMatch(signer, /feeds (update|install)|entrypoint|compile|download|curl|wget|\bgit /);
	const at = t => { const i = signer.indexOf(t); assert.ok(i >= 0, t); return i; };
	const made = at('\nmake CONFIG_SIGNED_PACKAGES=y V=s package/index || rc=$?\nrm -f "$key"\n');
	assert.ok(at('( cd "$in" && sha256sum -c --quiet --strict SHA256SUMS )') < at('\ncat > "$key"\n'), 'the packages are checked before the key is read');
	assert.ok(at('\ncat > "$key"\n') < made);
	for (const check of [ '"$bin/apk" --keys-dir "$t/keys" verify packages.adb || fail', 'cmp -s "$t/signed" "$t/ref" || fail',
		'"$bin/usign" -V -m Packages -p "$pub" || fail', 'cmp -s "$t/listed" "$t/named" || fail' ])
		assert.ok(at(check) > made, check);
	assert.match(signer, /\nbin=\/builder\/staging_dir\/host\/bin in=\/in pub=\/pub\/key out=\/artifacts\n/);
	/* a failed step of a pipeline fails it, in both containers of the signing step */
	for (const script of [ signer, inner('inner_key') ]) assert.ok(script.startsWith('set -euo pipefail\n'));

	/* where the key is leaves the environment before this script starts anything: a build's
	   verification runs tools that build produced, and inherits no name of the key */
	const taken = SDK_BUILD.indexOf('\nsign_key=${VANTAGE_SIGN_KEY:-} sign_pub=${VANTAGE_SIGN_PUB:-}\nunset VANTAGE_SIGN_KEY VANTAGE_SIGN_PUB\n');
	assert.ok(taken > 0 && taken < SDK_BUILD.indexOf('$('), 'before the first command this script runs');
	assert.equal(count(SDK_BUILD.replace(/^\s*#.*$/gm, ''), '${VANTAGE_SIGN_'), 2, 'read once each, there');
	assert.doesNotMatch(SDK_BUILD, /\bexport\b[^\n]*(sign_key|sign_pub|keysrc|pubabs)/);
});

/* The checks the signing container makes on what it signed, run here as
   they stand in the script: its own failure settings, then everything
   after the key is deleted, with stand-ins for the SDK's usign and apk
   (an "index" is a text file to them). A step that fails inside a
   pipeline must fail the check: a Packages.gz cut short still unpacks to
   the whole text, and an entry without a file name stops awk after the
   good ones are printed. */
test('sdk-build.sh: the signing container refuses an index whose check failed halfway', () => {
	const { spawnSync } = require('child_process');
	const crypto = require('crypto');
	const zlib = require('zlib');
	const mkTmp = require('./tmpdir');
	const signer = inner('inner_sign');
	const from = signer.indexOf('\n# from here on there is no key');
	assert.ok(from > 0);
	const lines = signer.split('\n');
	assert.deepEqual(lines.slice(0, 2), [ 'set -euo pipefail', 'fail() { echo "::error::$*" >&2; exit 1; }' ]);
	const script = lines.slice(0, 2).join('\n') + '\n' + signer.slice(from);
	assert.doesNotMatch(script, /\/in\b|\/pub\b|\/artifacts\b|\/builder\b/, 'the checks name their places by variable');
	const sha = t => crypto.createHash('sha256').update(t).digest('hex');
	const USIGN = '#!/bin/bash\ncase $1 in -V) exit "${USIGN_V:-0}" ;; -F) echo 0123456789abcdef ;; *) exit 64 ;; esac\n';
	const APK = `#!/bin/bash
args=()
while [ $# -gt 0 ]; do case $1 in --keys-dir) shift ;; --output) to=$2; shift ;; --allow-untrusted) ;; verify|mkndx|adbdump) cmd=$1 ;; *) args+=("$1") ;; esac; shift; done
case $cmd in
verify) exit "\${APK_V:-0}" ;;
mkndx) printf '%s\\n' "\${args[@]}" > "$to" ;;
adbdump) cat "\${args[0]}"; exit "\${APK_DUMP:-0}" ;;
esac
`;
	const run = (kind, files, env) => {
		const dir = mkTmp('vantage-check-test-'), d = path.join(dir, 'feed');
		for (const sub of [ 'bin', 'in', 'out', 'feed', 'tmp' ]) fs.mkdirSync(path.join(dir, sub));
		fs.writeFileSync(path.join(dir, 'bin', 'usign'), USIGN, { mode: 0o755 });
		fs.writeFileSync(path.join(dir, 'bin', 'apk'), APK, { mode: 0o755 });
		fs.writeFileSync(path.join(dir, 'pub'), 'a public key\n');
		for (const [ n, body ] of Object.entries(files)) fs.writeFileSync(path.join(n === 'SHA256SUMS' ? path.join(dir, 'in') : d, n), body);
		const r = spawnSync('bash', [ '-c', script ], { encoding: 'utf8', env: Object.assign({}, process.env, { TMPDIR: path.join(dir, 'tmp'),
			bin: path.join(dir, 'bin'), in: path.join(dir, 'in'), pub: path.join(dir, 'pub'), out: path.join(dir, 'out'), d, SIGN: kind }, env || {}) });
		return { code: r.status, err: r.stderr, out: fs.readdirSync(path.join(dir, 'out')).sort() };
	};
	const refused = (r, why) => { assert.notEqual(r.code, 0, String(why)); assert.match(r.err, why); assert.deepEqual(r.out, [], String(why) + ': nothing handed out'); };

	/* 24.10: Packages, its gzip, a signature; two packages */
	const P = { 'one_1_all.ipk': 'package one', 'two_1_all.ipk': 'package two' };
	const entry = (n, hash) => `Package: ${n.split('_')[0]}\nVersion: 1\nFilename: ${n}\nSize: 11\nSHA256sum: ${hash}\nDescription: a package\n`;
	const names = Object.keys(P);
	const sums = names.map(n => sha(P[n]) + '  ' + n + '\n').join('');
	const ipk = text => ({ SHA256SUMS: sums, Packages: text, 'Packages.gz': zlib.gzipSync(text), 'Packages.sig': 'a signature\n' });
	const good = names.map(n => entry(n, sha(P[n]))).join('\n') + '\n\n';
	let r = run('usign', ipk(good));
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.out, [ 'Packages', 'Packages.gz', 'Packages.sig', 'fingerprint' ]);
	/* the gzip without its last bytes (its checksum): it still unpacks to all of Packages, and fails */
	const cut = ipk(good);
	cut['Packages.gz'] = cut['Packages.gz'].subarray(0, cut['Packages.gz'].length - 8);
	assert.equal(spawnSync('bash', [ '-c', 'gunzip -c | cmp -s - "$0"', '/dev/stdin' ], { input: cut['Packages.gz'] }).status !== null, true);
	refused(run('usign', cut), /::error::Packages\.gz does not unpack/);
	/* one more entry after the good ones, with no file name: awk stops there, having printed the good ones */
	refused(run('usign', ipk(good.trimEnd() + '\n\nPackage: three\nVersion: 1\nDescription: no file\n')), /::error::Packages has an entry without a file name or a hash/);
	/* each name and each hash is there, but not in the same entry */
	refused(run('usign', ipk(entry(names[0], sha(P[names[1]])) + '\n' + entry(names[1], sha(P[names[0]])))), /::error::Packages does not list exactly these packages, each with its hash/);
	refused(run('usign', ipk(entry(names[0], sha(P[names[0]])))), /::error::Packages does not list exactly/);
	refused(run('usign', Object.assign(ipk(good), { 'Packages.gz': zlib.gzipSync(good + 'more') })), /::error::Packages\.gz is not Packages/);
	refused(run('usign', ipk(good), { USIGN_V: '1' }), /::error::Packages\.sig does not verify with the public key given/);

	/* 25.12: the signed index lists what an index made from the files lists */
	const apk = listed => ({ 'one-1-r1.apk': 'one', 'two-1-r1.apk': 'two', 'packages.adb': listed + '# sig v00 abc\n' });
	r = run('apk', apk('one-1-r1.apk\ntwo-1-r1.apk\n'));
	assert.equal(r.code, 0, r.err);
	assert.deepEqual(r.out, [ 'packages.adb' ]);
	refused(run('apk', apk('one-1-r1.apk\n')), /::error::packages\.adb does not list exactly these packages/);
	refused(run('apk', apk('one-1-r1.apk\ntwo-1-r1.apk\n'), { APK_V: '1' }), /::error::packages\.adb does not verify with the public key given/);
	/* a dump that fails after printing: the two texts are equal, and it is refused all the same */
	refused(run('apk', apk('one-1-r1.apk\ntwo-1-r1.apk\n'), { APK_DUMP: '1' }), /::error::packages\.adb cannot be read/);
});

/* The signer on this machine, with a stand-in for podman: it signs a
   complete set only, checks it before the key is used and again before it
   writes, and writes nothing unless the container succeeded. The stand-in
   plays the container: it logs that it ran, may change a package (as
   something beside it could), and leaves the index the script expects. */
const PODMAN = `#!/bin/bash
case $1 in
version) echo 5.4.0; exit 0 ;;
run) ;;
*) exit 64 ;;
esac
echo "container: $* key=\${VANTAGE_SIGN_KEY-none} pub=\${VANTAGE_SIGN_PUB-none}" >> "$STUB/log"
cat > "$STUB/stdin"
[ -z "\${STUB_TOUCH:-}" ] || printf x >> "$STUB_TOUCH"
[ "\${STUB_RC:-0}" = 0 ] || exit "$STUB_RC"
for a in "$@"; do case $a in *:/artifacts:z) echo index > "\${a%%:*}/packages.adb" ;; esac; done
`;

test('sdk-build.sh --sign: a complete set only, checked before the key is read and again before anything is written', () => {
	const { spawnSync } = require('child_process');
	const crypto = require('crypto');
	const mkTmp = require('./tmpdir');
	const PKGS = [ 'luci-theme-vantage', 'luci-app-vantage', 'luci-app-vantage-aps', 'luci-app-vantage-traffic' ];
	const NAMES = PKGS.map(p => p + '-1.0.0-r1.apk').concat('luci-i18n-vantage-de-1.0.0-r1.apk');

	/* a repository with the script, four packages (one translated) and a build of them in dist/ */
	const setup = () => {
		const repo = mkTmp('vantage-sign-test-'), stub = path.join(repo, '.stub');
		const put = (rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text, { mode: mode || 0o644 }); };
		put('dev/build/sdk-build.sh', SDK_BUILD, 0o755);
		put('dev/i18n/luci-languages.mk', 'LUCI_LANG.de=Deutsch (German)\n');
		put('keys/vantage-signing.pem', 'a public key\n');
		for (const p of PKGS) put(p + '/Makefile', 'PKG_VERSION:=1.0.0\nPKG_RELEASE:=1\nPKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)\n');
		put('luci-app-vantage/po/de/vantage.po', 'msgid ""\n');
		put('.gitignore', 'dist/\n.stub/\n');
		const git = (...a) => { const r = spawnSync('git', [ '-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...a ], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
		git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'packages');
		const rev = git('rev-parse', 'HEAD'), dist = path.join(repo, 'dist', '25.12.6');
		for (const n of NAMES) put('dist/25.12.6/' + n, 'package ' + n);
		put('dist/25.12.6/SHA256SUMS', NAMES.map(n => crypto.createHash('sha256').update('package ' + n).digest('hex') + '  ' + n + '\n').join(''));
		put('dist/25.12.6/BUILDINFO', `rev=${rev}\nsdk_release=25.12.6\nsigned_index=none\nverified_by=security-tests/verify_built_apk.js\n`);
		put('.stub/bin/podman', PODMAN, 0o755);
		const run = env => {
			const r = spawnSync('bash', [ path.join(repo, 'dev/build/sdk-build.sh'), '--sign', '25.12.6' ], { cwd: repo, encoding: 'utf8', input: 'the key\n',
				env: Object.assign({}, process.env, { PATH: path.join(stub, 'bin') + path.delimiter + process.env.PATH, STUB: stub, TMPDIR: mkTmp('vantage-sign-tmp-'),
					VANTAGE_SIGN_KEY: '-', VANTAGE_SIGN_PUB: '', VANTAGE_SDK_IMAGE: '', STUB_RC: '', STUB_TOUCH: '' }, env || {}) });
			let log = '';
			try { log = fs.readFileSync(path.join(stub, 'log'), 'utf8'); } catch (e) {}
			let stdin = null;
			try { stdin = fs.readFileSync(path.join(stub, 'stdin'), 'utf8'); } catch (e) {}
			return { code: r.status, err: r.stderr, ran: count(log, 'container: '), log, stdin,
				index: fs.existsSync(path.join(dist, 'packages.adb')), info: fs.readFileSync(path.join(dist, 'BUILDINFO'), 'utf8') };
		};
		return { repo, dist, rev, run };
	};
	const unsigned = r => { assert.equal(r.index, false); assert.match(r.info, /\nsigned_index=none\n/); assert.doesNotMatch(r.info, /signing_/); };

	/* complete and untouched: the container runs, without network, and the index and the two lines are written */
	let t = setup(), r = t.run();
	assert.equal(r.code, 0, r.err);
	assert.equal(r.ran, 1);
	assert.match(r.log, / --network=none /);
	assert.equal(r.stdin, 'the key\n', 'the key from this script\'s standard input to the container\'s');
	assert.equal(r.index, true);
	assert.match(r.info, new RegExp('\\nsigned_index=packages\\.adb\\nsigning_public_key_sha256=' + crypto.createHash('sha256').update('a public key\n').digest('hex') + '\\nverified_by='));
	/* and a second time it refuses: one index per build */
	r = t.run();
	assert.notEqual(r.code, 0);
	assert.match(r.err, /has a signed index already/);
	assert.equal(r.ran, 1);

	/* each of these stops before the container, so before the key is read */
	for (const [ why, change, message ] of [
		[ 'SHA256SUMS cut at a line end', d => fs.writeFileSync(path.join(d, 'SHA256SUMS'), fs.readFileSync(path.join(d, 'SHA256SUMS'), 'utf8').split('\n').slice(0, -2).join('\n') + '\n'), /SHA256SUMS does not name exactly the packages of [0-9a-f]{40}/ ],
		[ 'a package SHA256SUMS does not name', d => fs.writeFileSync(path.join(d, 'luci-i18n-vantage-ru-1.0.0-r1.apk'), 'x'), /does not hold exactly the packages of/ ],
		[ 'a package of the other format beside them', d => fs.writeFileSync(path.join(d, 'luci-app-vantage_1.0.0-r1_all.ipk'), 'x'), /does not hold exactly the packages of/ ],
		[ 'a package and its line both gone', d => { fs.rmSync(path.join(d, NAMES[4])); fs.writeFileSync(path.join(d, 'SHA256SUMS'), fs.readFileSync(path.join(d, 'SHA256SUMS'), 'utf8').split('\n').slice(0, -2).join('\n') + '\n'); }, /SHA256SUMS does not name exactly/ ],
		[ 'a package changed', d => fs.appendFileSync(path.join(d, NAMES[1]), 'x'), /does not match its SHA256SUMS/ ],
		[ 'a commit this repository does not have', d => fs.writeFileSync(path.join(d, 'BUILDINFO'), 'rev=' + '1'.repeat(40) + '\nsigned_index=none\n'), /names no commit of this repository/ ]
	]) {
		t = setup();
		change(t.dist);
		r = t.run();
		assert.notEqual(r.code, 0, why);
		assert.match(r.err, message, why);
		assert.equal(r.ran, 0, why + ': the container must not run');
		assert.equal(r.index, false, why);
	}

	/* a package changed while the container ran: nothing is written */
	t = setup();
	r = t.run({ STUB_TOUCH: path.join(t.dist, NAMES[0]) });
	assert.notEqual(r.code, 0);
	assert.match(r.err, /changed while its index was signed; nothing was written/);
	assert.equal(r.ran, 1);
	unsigned(r);
	/* the container failed (a wrong secret, a list that is not these packages): nothing is written */
	t = setup();
	r = t.run({ STUB_RC: '1' });
	assert.notEqual(r.code, 0);
	assert.match(r.err, /signing the index failed \(exit 1\)/);
	unsigned(r);
	/* without a key it does not start */
	t = setup();
	r = t.run({ VANTAGE_SIGN_KEY: '' });
	assert.match(r.err, /--sign needs VANTAGE_SIGN_KEY/);
	assert.equal(r.ran, 0);
	/* a key file goes to the container's standard input too, and no program this
	   script starts has the key's place, or the public key's, in its environment */
	t = setup();
	const keys = mkTmp('vantage-sign-keys-');
	fs.writeFileSync(path.join(keys, 'key'), 'the key in a file\n', { mode: 0o600 });
	fs.writeFileSync(path.join(keys, 'pub'), 'its public key\n');
	r = t.run({ VANTAGE_SIGN_KEY: path.join(keys, 'key'), VANTAGE_SIGN_PUB: path.join(keys, 'pub') });
	assert.equal(r.code, 0, r.err);
	assert.equal(r.stdin, 'the key in a file\n');
	assert.match(r.log, / key=none pub=none\n$/);
	assert.match(r.info, new RegExp('\\nsigning_public_key_sha256=' + crypto.createHash('sha256').update('its public key\n').digest('hex') + '\\n'));
});

/* the jobs that deploy to Pages: a release's, and the one run by hand */
const PAGES = [ 'repository', 'site' ];

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

/* The release job's own script, run here against a stand-in for gh: the
   step runs on a tag only, so no CI run before a release exercises it.
   The stand-in keeps the "release" as a directory and logs each upload. */
const GH = `#!/bin/bash
set -eu
if [ "$1" = api ]; then
	# the commit a tag is at, peeled: none when the tag is not there
	[ "$2" = "repos/$REPO/commits/refs/tags/$TAG" ] && [ "$3 $4" = '--jq .sha' ] || exit 64
	echo "tag asked" >> "$STUB/log"
	[ -e "$STUB/tag" ] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }
	cat "$STUB/tag"; exit 0
fi
[ "$1" = release ] || exit 64
cmd=$2 tag=$3; shift 3
remote="$STUB/remote"
case $cmd in
view)
	[ -d "$remote" ] || exit 1
	case " $* " in
	*' --json assets '*) ls "$remote" ;;
	*' --json isDraft '*) [ -e "$STUB/draft" ] && echo true || echo false ;;
	esac ;;
edit)
	case " $* " in *' --draft=false '*) ;; *) exit 64 ;; esac
	rm -f "$STUB/draft"; echo "publish $tag" >> "$STUB/log" ;;
download)
	while [ $# -gt 0 ]; do case $1 in --pattern) pat=$2; shift ;; --dir) dir=$2; shift ;; --repo) shift ;; esac; shift; done
	mkdir -p "$dir"; cp -- "$remote/$pat" "$dir/" ;;
upload)
	[ ! -e "$remote/$1" ] || exit 65
	cp -- "$1" "$remote/"; echo "upload $1" >> "$STUB/log" ;;
create)
	mkdir "$remote"
	for f in "$@"; do [ ! -f "$f" ] || { cp -- "$f" "$remote/"; echo "create $f" >> "$STUB/log"; }; done ;;
*) exit 64 ;;
esac
`;

test('ci: a release retry keeps an asset only when it is this build\'s file, and uploads nothing beside one that is not', () => {
	const { spawnSync } = require('child_process');
	const crypto = require('crypto');
	const mkTmp = require('./tmpdir');
	const step = steps(job('release')).find(s => s.startsWith('      - name: Create or complete the release\n'));
	const at = step.indexOf('\n        run: |\n');
	assert.ok(at >= 0);
	const script = step.slice(at + 16).split('\n').map(l => { assert.ok(l === '' || l.startsWith(' '.repeat(10)), l); return l.slice(10); }).join('\n');
	assert.doesNotMatch(script, /\$\{\{/, 'plain shell: nothing for the workflow to fill in');
	const sdk = name => CI.match(new RegExp('\\n  ' + name + ': (\\S+)\\n'))[1];
	const apk = sdk('SDK_APK'), ipk = sdk('SDK_IPK');

	/* a build's two artifacts; remote: the release as it stands, or null for none */
	const SHA = '0'.repeat(40);
	/* draft: the release is one; tag: the commit its tag is at on the repository, null for no tag */
	const run = (remote, draft, tag = SHA) => {
		const dir = mkTmp('vantage-release-test-'), stub = path.join(dir, 'stub');
		const put = (d, files) => {
			fs.mkdirSync(d, { recursive: true });
			for (const [ n, text ] of Object.entries(files)) fs.writeFileSync(path.join(d, n), text);
			fs.writeFileSync(path.join(d, 'SHA256SUMS'), Object.entries(files).filter(([ n ]) => /\.(apk|ipk)$/.test(n))
				.map(([ n, text ]) => crypto.createHash('sha256').update(text).digest('hex') + '  ' + n + '\n').join(''));
		};
		put(path.join(dir, 'release', 'signed-' + apk), { 'one-1.0-r1.apk': 'apk one', 'packages.adb': 'index', BUILDINFO: 'apk build' });
		put(path.join(dir, 'release', 'signed-' + ipk), { 'one_1.0-r1_all.ipk': 'ipk one', BUILDINFO: 'ipk build' });
		fs.mkdirSync(path.join(stub, 'bin'), { recursive: true });
		fs.writeFileSync(path.join(stub, 'bin', 'gh'), GH, { mode: 0o755 });
		if (remote) put(path.join(stub, 'remote'), remote);
		if (remote) fs.rmSync(path.join(stub, 'remote', 'SHA256SUMS'));
		if (draft) fs.writeFileSync(path.join(stub, 'draft'), '');
		if (tag) fs.writeFileSync(path.join(stub, 'tag'), tag + '\n');
		fs.writeFileSync(path.join(dir, 'step.sh'), script);
		const r = spawnSync('bash', [ path.join(dir, 'step.sh') ], { cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, {
			PATH: path.join(stub, 'bin') + path.delimiter + process.env.PATH, STUB: stub, TAG: 'v0.0.1', REPO: 'example/vantage',
			SDK_APK: apk, SDK_IPK: ipk, GITHUB_SHA: SHA }) });
		let log = [];
		try { log = fs.readFileSync(path.join(stub, 'log'), 'utf8').trim().split('\n'); } catch (e) {}
		const there = n => { try { return fs.readFileSync(path.join(stub, 'remote', n), 'utf8'); } catch (e) { return null; } };
		return { code: r.status, out: r.stdout + r.stderr, log, there, draft: fs.existsSync(path.join(stub, 'draft')) };
	};
	const ALL = [ 'BUILDINFO', 'BUILDINFO-24.10', 'SHA256SUMS', 'SHA256SUMS-24.10', 'one-1.0-r1.apk', 'one_1.0-r1_all.ipk', 'packages.adb' ];

	/* no release yet: created with every file */
	const first = run(null);
	assert.equal(first.code, 0, first.out);
	assert.deepEqual(first.log.map(l => l.replace('create ', '')).sort(), ALL);

	/* a retry after two assets went up: both are this build's, the rest is added */
	const again = run({ 'one-1.0-r1.apk': 'apk one', 'packages.adb': 'index' });
	assert.equal(again.code, 0, again.out);
	assert.deepEqual(again.log.sort(), ALL.filter(n => n !== 'one-1.0-r1.apk' && n !== 'packages.adb').map(n => 'upload ' + n));
	assert.equal(again.there('one-1.0-r1.apk'), 'apk one');

	/* the same retry where the first try was cut off after its draft was
	   made: the draft is published, after the last asset is up. A release
	   that is public already is not edited (the retry above) */
	const cutOff = run({ 'one-1.0-r1.apk': 'apk one', 'packages.adb': 'index' }, true);
	assert.equal(cutOff.code, 0, cutOff.out);
	assert.deepEqual(cutOff.log.slice(-2), [ 'tag asked', 'publish v0.0.1' ], 'the tag is looked up, then the draft published, last');
	assert.equal(cutOff.log.filter(l => l.startsWith('upload ')).length, ALL.length - 2);
	assert.equal(cutOff.draft, false);
	assert.deepEqual(again.log.filter(l => !l.startsWith('upload ')), [], 'a public release: no tag asked, nothing published');

	/* a draft is published as this build's release only. One that holds a
	   file this build does not have (an older package) stays a draft */
	const published = l => l.filter(x => x.startsWith('publish')).length;
	const stale = run({ 'one-1.0-r1.apk': 'apk one', 'one-0.9-r1.apk': 'an older package' }, true);
	assert.notEqual(stale.code, 0);
	assert.match(stale.out, /::error::the draft release does not hold exactly this build's files; it stays a draft/);
	assert.deepEqual([ published(stale.log), stale.draft, stale.there('one-0.9-r1.apk') ], [ 0, true, 'an older package' ]);
	/* the same on a release that is public already is left alone, as before */
	const extra = run({ 'one-1.0-r1.apk': 'apk one', 'one-0.9-r1.apk': 'an older package' }, false);
	assert.equal(extra.code, 0, extra.out);
	assert.deepEqual([ published(extra.log), extra.there('one-0.9-r1.apk') ], [ 0, 'an older package' ]);
	/* and one whose tag is gone from the repository, or is at another
	   commit than this run's, stays a draft: publishing would make the tag */
	for (const [ tag, said ] of [ [ null, /::error::tag v0\.0\.1 is not at this run's commit on the repository \(no such tag\); the release stays a draft/ ],
		[ '1'.repeat(40), /::error::tag v0\.0\.1 is not at this run's commit on the repository \(1{40}\); the release stays a draft/ ] ]) {
		const r = run({ 'one-1.0-r1.apk': 'apk one' }, true, tag);
		assert.notEqual(r.code, 0, String(tag));
		assert.match(r.out, said);
		assert.deepEqual([ published(r.log), r.draft ], [ 0, true ], String(tag));
	}
	/* a public release is not asked about its tag */
	assert.equal(run({ 'one-1.0-r1.apk': 'apk one' }, false, null).code, 0);

	/* a retry where a package of that name is another file: the job fails,
	   names it, and has uploaded nothing; the asset stays as it was */
	const other = run({ 'one-1.0-r1.apk': 'apk one, from somewhere else', 'packages.adb': 'index' });
	assert.notEqual(other.code, 0);
	assert.match(other.out, /::error::release asset one-1\.0-r1\.apk is not this build's file \(sha256 [0-9a-f]{64}, built [0-9a-f]{64}\)/);
	assert.deepEqual(other.log, []);
	assert.equal(other.there('one-1.0-r1.apk'), 'apk one, from somewhere else');
	/* and a draft with such an asset stays a draft */
	const badDraft = run({ 'one-1.0-r1.apk': 'apk one, from somewhere else' }, true);
	assert.notEqual(badDraft.code, 0);
	assert.deepEqual([ badDraft.log, badDraft.draft ], [ [], true ]);
	assert.equal(other.there('BUILDINFO'), null);
});

test('ci: every action is pinned to a full commit SHA with its version in a comment', () => {
	const lines = CI.split('\n').filter(l => /^\s*(- )?uses:/.test(l));
	assert.ok(lines.length > 0);
	for (const l of lines)
		assert.match(l, /^\s*(- )?uses: [\w.-]+\/[\w.\/-]+@[0-9a-f]{40} # v\d+(\.\d+)*$/, l);
});
