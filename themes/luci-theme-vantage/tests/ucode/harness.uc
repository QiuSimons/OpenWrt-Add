// Runs luci-app-vantage's rpcd ucode plugin outside rpcd, for
// tests/plugin.test.js:
//
//   ucode -L tests/ucode/stubs -D PLUGIN=<plugin> -D CASES=<cases.json> tests/ucode/harness.uc
//
// uci, ubus and rtnl are the test doubles in stubs/. Arguments are checked
// the way rpcd-mod-ucode does before a method runs (unknown name or wrong
// type: UBUS_STATUS_INVALID_ARGUMENT). A case's brforward ({ bridge:
// base64 }) is written to the fake /sys/class/net (-D NET=<dir>) before
// it runs, the bridges' tables as the kernel would hold them then.
// Prints one JSON array with
// { status, reply, sections, reverted } per case; sections are the
// committed config (unchanged when nothing was committed).
'use strict';

import { readfile, writefile } from 'fs';

const TYPES = { string: 'string', int: 'int', double: 'double', bool: 'bool', array: 'array', object: 'object' };

let cases = json(readfile(CASES));
let plugin = loadfile(PLUGIN, { raw_mode: true })();
let obj = plugin?.['luci.vantage'];
let out = [];

if (type(obj) != 'object')
	die('plugin does not return a luci.vantage object');

for (let c in cases) {
	let orig = json(sprintf('%J', c.sections ?? []));

	if (type(c.brforward) == 'object')
		for (let br, data in c.brforward)
			if (type(NET) != 'string' || writefile(NET + '/' + br + '/brforward', b64dec(data)) == null)
				die(sprintf('harness: cannot write brforward for %s', br));

	global.STUB = { sections: json(sprintf('%J', orig)), seq: 0, committed: false, reverted: false, fail_commit: !!c.fail_commit, ubus: c.ubus ?? {}, wireless: c.wireless_uci, network: c.network_uci ?? 'no load', fdb: c.fdb, lookup: exists(c, 'lookup') ? c.lookup : 'no lookup' };

	let m = obj[c.method], status = 0, reply = null;

	if (type(m) != 'object' || type(m.call) != 'function') {
		status = 3;
	}
	else {
		for (let k, v in (c.args ?? {})) {
			let hint = m.args?.[k];

			if (hint == null || type(v) != TYPES[type(hint)])
				status = 2;
		}

		if (!status)
			reply = m.call({ args: c.args ?? {} });
	}

	push(out, { status, reply, sections: global.STUB.committed ? global.STUB.sections : orig, reverted: global.STUB.reverted });
}

print(sprintf('%J', out), '\n');
