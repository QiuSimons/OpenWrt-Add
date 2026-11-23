// Test double for ucode's uci module (tests/traffic.test.js): the one
// option the traffic plugin may read, vantage_theme.appearance.power,
// from global STUB.power; each read is counted in STUB.uci. Fails closed:
// a cursor made with arguments, any other read and every other method
// stop the run.
'use strict';

function cursor(...args) {
	if (length(args))
		die(sprintf('uci stub: cursor%J', args));

	return {
		get: function(...a) {
			if (a[0] != 'vantage_theme' || a[1] != 'appearance' || a[2] != 'power' || length(a) != 3)
				die(sprintf('uci stub: get%J', a));

			global.STUB.uci++;

			return global.STUB.power;
		}
	};
}

export { cursor };
