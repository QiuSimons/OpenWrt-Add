// Runs luci-app-vantage-aps' ucode outside the device, for tests/aps.test.js:
//
//   ucode -L tests/ucode/aps-stubs -L <add-on>/root/usr/share/ucode -D MODE=module -D CASES=<cases.json> tests/ucode/aps-harness.uc
//   ucode ... -D MODE=plugin -D PLUGIN=<plugin copy> -D CASES=<case.json> tests/ucode/aps-harness.uc
//
// module: CASES is [ [ name, ...args ] ]: each a call of vantage.aps' export
// name; prints the results as one JSON array.
// plugin: CASES is { stub, calls: [ { method, args } ] }, run in order on
// one load of the plugin, its arguments checked the way rpcd-mod-ucode
// does (unknown name or wrong type: UBUS_STATUS_INVALID_ARGUMENT); prints
// { results: [ { status, reply } ], ubus: [ calls made ] }.
'use strict';

import { readfile } from 'fs';
import * as vaps from 'vantage.aps';

const TYPES = { string: 'string', int: 'int', double: 'double', bool: 'bool', array: 'array', object: 'object' };

let cases = json(readfile(CASES));

if (MODE == 'module') {
	let out = [];

	for (let c in cases) {
		let f = vaps[c[0]];

		push(out, (type(f) == 'function') ? call(f, null, null, ...slice(c, 1)) : (f ?? 'no such export'));
	}

	print(sprintf('%J', out), '\n');
}
else if (MODE == 'plugin') {
	global.STUB = cases.stub ?? {};

	let obj = loadfile(PLUGIN, { raw_mode: true })()?.['luci.vantage.pair'], out = [];

	if (type(obj) != 'object')
		die('plugin does not return a luci.vantage.pair object');

	for (let c in cases.calls) {
		let m = obj[c.method], status = 0, reply = null;

		if (type(m) != 'object' || type(m.call) != 'function')
			status = 3;
		else {
			for (let k, v in (c.args ?? {}))
				if (m.args?.[k] == null || type(v) != TYPES[type(m.args[k])])
					status = 2;

			if (!status)
				reply = m.call({ args: c.args ?? {} });
		}

		push(out, { status, reply });
	}

	print(sprintf('%J', { results: out, ubus: global.STUB.calls ?? [] }), '\n');
}
else
	die('MODE?');
