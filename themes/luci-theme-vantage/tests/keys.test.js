'use strict';
/* keys/ holds the project's public signing keys only, never a private key:
   the apk key (25.12) and the usign key (24.10). */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'keys');

test('keys/: only the public signing keys, and the apk key is a P-256 public key', () => {
	assert.deepStrictEqual(fs.readdirSync(DIR).sort(), [ 'vantage-24.10.usign.pub', 'vantage-signing.pem' ]);
	const pem = fs.readFileSync(path.join(DIR, 'vantage-signing.pem'), 'utf8');
	assert.doesNotMatch(pem, /PRIVATE KEY/);
	const key = crypto.createPublicKey(pem);
	assert.strictEqual(key.asymmetricKeyType, 'ec');
	assert.strictEqual(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('keys/: the fingerprint in the docs matches the key file', () => {
	const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, 'vantage-signing.pem'))).digest('hex');
	for (const doc of [ 'README.md', 'docs/INSTALL.md', 'dev/build/repo-index.html' ])
		assert.match(fs.readFileSync(path.join(__dirname, '..', doc), 'utf8'), new RegExp(sum), doc);
});

/* a usign public key: a comment line, then base64 of 'Ed', the 8-byte key
   number (its fingerprint) and the 32-byte Ed25519 key; a secret key is
   longer */
const usignFingerprint = () => {
	const lines = fs.readFileSync(path.join(DIR, 'vantage-24.10.usign.pub'), 'utf8').trim().split('\n');
	assert.strictEqual(lines.length, 2);
	assert.match(lines[0], /^untrusted comment: /);
	const raw = Buffer.from(lines[1], 'base64');
	assert.strictEqual(raw.length, 42, 'a public key, not a secret key');
	assert.strictEqual(raw.subarray(0, 2).toString(), 'Ed');
	return raw.subarray(2, 10).toString('hex');
};

test('keys/: the 24.10 key is a usign public key, and the docs give its number and hash', () => {
	const fp = usignFingerprint();
	const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, 'vantage-24.10.usign.pub'))).digest('hex');
	assert.match(fs.readFileSync(path.join(__dirname, '..', 'docs/INSTALL.md'), 'utf8'), new RegExp(fp), 'the file name it gets on the router');
	for (const doc of [ 'docs/INSTALL.md', 'dev/build/repo-index.html' ])
		assert.match(fs.readFileSync(path.join(__dirname, '..', doc), 'utf8'), new RegExp(sum), doc);
});

/* the setup commands as a reader copies them */
const SETUP_DOCS = [ 'README.md', 'docs/INSTALL.md', 'dev/build/repo-index.html' ];
const setupBlocks = doc => {
	const text = fs.readFileSync(path.join(__dirname, '..', doc), 'utf8').replace(/&amp;/g, '&').replace(/&gt;/g, '>');
	return text.split(/(?=key=\$\(mktemp\))/).slice(1).map(b => b.split(/\n(?=```|<\/pre>)|<\/pre>/)[0].trim().split('\n'));
};

test('install commands: a failed key check stops them before the key is trusted', () => {
	for (const doc of SETUP_DOCS) {
		const blocks = setupBlocks(doc);
		assert.ok(blocks.length >= 1, doc + ': found the setup commands');
		for (const lines of blocks) {
			lines.slice(0, -1).forEach(l => assert.match(l, /&&$/, doc + ': chained: ' + l));
			const at = re => lines.findIndex(l => re.test(l));
			const check = at(/\| sha256sum -c - &&$/);
			assert.ok(check > 0, doc + ': checks the hash');
			assert.ok(check < at(/^(cp "\$key" \/etc\/apk\/keys\/|opkg-key add "\$key")/), doc + ': checks before trusting the key');
			assert.ok(check < at(/customfeeds/), doc + ': checks before adding the feed');
		}
		assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', doc), 'utf8'), /^usign -F|^wget -O \/etc\/(apk|opkg)/m,
			doc + ': no key written unchecked, no check on the key number alone');
	}
});

test('install commands: packages never install from a folder others can write', () => {
	for (const doc of [ 'README.md', 'docs/INSTALL.md' ])
		assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', doc), 'utf8'), /allow-untrusted[^\n]* \/tmp\/(?!vantage\b)/, doc);
});
