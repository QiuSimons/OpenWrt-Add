// Test double for ucode's ubus module (tests/aps.test.js): replies from
// STUB.ubus, keyed 'object method' plus the args' device or name when
// given; a reply { __seq: [ ... ] } gives its values one call after the
// other, the last one from then on. STUB is global STUB, else the JSON
// file named by -D STUBFILE.
// Every call is recorded in STUB.calls (and appended to -D CALLSFILE as
// JSON lines), so a test can hold a script to the calls it may make.
'use strict';

import { readfile, open } from 'fs';

function stub() {
	if (global.STUB == null)
		global.STUB = (type(global.STUBFILE) == 'string') ? json(readfile(global.STUBFILE)) : {};

	return global.STUB;
}

function connect() {
	let s = stub();

	if (s.no_ubus)
		return null;

	return {
		call: function(obj, method, args) {
			let k = obj + ' ' + method;

			if (type(args) == 'object' && type(args.device) == 'string')
				k += ' ' + args.device;
			else if (type(args) == 'object' && type(args.name) == 'string')
				k += ' ' + args.name;

			push(s.calls ?? (s.calls = []), k);

			if (type(global.CALLSFILE) == 'string') {
				let f = open(global.CALLSFILE, 'a');

				f.write(sprintf('%J\n', k));
				f.close();
			}

			let v = s.ubus?.[k];

			if (type(v) == 'object' && type(v.__seq) == 'array')
				return (length(v.__seq) > 1) ? shift(v.__seq) : v.__seq[0];

			return v;
		},
		// the collector's object: kept for the uloop double, which calls it
		publish: function(name, methods) {
			if (!s.published)
				s.published = {};

			s.published[name] = methods;

			return true;
		}
	};
}

export { connect };
