// Runs the example provider tile (dev/replay/tiles/.../vantage.tile.dns)
// outside rpcd, for tests/tiles.test.js:
//
//   ucode -L tests/ucode/tile-stubs -D PLUGIN=<plugin> -D CASES=<cases.json> tests/ucode/tile-harness.uc
//
// Each case is dnsmasq's metrics (null: no answer). Prints one JSON array
// with the object's methods and each case's reply to `status`, called as
// rpcd calls it from a browser: with the session id and nothing else.
'use strict';

import { readfile } from 'fs';

let plugin = loadfile(PLUGIN, { raw_mode: true })();
let obj = plugin?.['vantage.tile.dns'];

if (type(obj) != 'object' || type(obj.status?.call) != 'function')
	die('plugin does not return vantage.tile.dns with a status method');

let out = { objects: keys(plugin), methods: keys(obj), args: obj.status.args ?? null, replies: [] };

for (let c in json(readfile(CASES))) {
	global.STUB = { metrics: c };
	push(out.replies, obj.status.call({ args: { ubus_rpc_session: '0123456789abcdef0123456789abcdef' } }));
}

print(sprintf('%J', out), '\n');
