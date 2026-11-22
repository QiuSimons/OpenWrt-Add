// Test double for ucode's uci module (tests/aps.test.js): read-only
// configs from STUB.uci ({ config: [ { '.type', ...options } ] }). Fails
// closed: any change stops the run.
'use strict';

function cursor(...args) {
	if (length(args))
		die(sprintf('uci stub: cursor%J', args));

	let uci = global.STUB?.uci ?? {};

	return {
		load: function(conf) {
			return uci[conf] != null;
		},
		foreach: function(conf, t, cb) {
			for (let s in (uci[conf] ?? []))
				if (s['.type'] == t && cb(s) === false)
					break;
		},
		get: function(conf, sid, opt) {
			return null;
		},
		set: function() { die('uci stub: set'); },
		add: function() { die('uci stub: add'); },
		delete: function() { die('uci stub: delete'); },
		commit: function() { die('uci stub: commit'); },
		save: function() { die('uci stub: save'); }
	};
}

export { cursor };
