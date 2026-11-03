'use strict';
/* Temporary directories for tests, removed when the test process exits. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
process.on('exit', () => {
	for (const dir of made)
		if (path.dirname(dir) === os.tmpdir() && /^vantage-[a-z-]+-[A-Za-z0-9]{6}$/.test(path.basename(dir)))
			fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = function mkTmp(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.push(dir);
	return dir;
};
