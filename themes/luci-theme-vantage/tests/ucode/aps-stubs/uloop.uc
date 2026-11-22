// Test double for ucode's uloop module (tests/aps.test.js): the collector's
// timers and processes under a clock the test moves.
//
//   ucode -L tests/ucode/aps-stubs -L <add-on>/root/usr/share/ucode
//         -D CASES=<steps.json> -D SANDBOX=<dir> <collector copy>
//
// The collector's own uloop.run() call runs the test: the steps of CASES,
// in order, then one JSON array of their results is printed.
//   { "report": true }       calls the published report method; its reply
//   { "advance": <ms> }      moves the clock in half seconds: processes
//                            that ended get their callback, due timers fire
//   { "write": [ file, text ] }   writes a file (the paired list, a fixture)
//   { "block": file }        puts a directory where that file is, so that
//                            writing it fails from then on
// process() runs its command to the end at once, with exactly the
// environment it was given (env -i), and hands the exit code to the
// callback at the next half second. A command whose `root@<addr>` has a
// file SANDBOX/hosts/<addr>/hang is not run and never ends, until the
// collector's kill program (the test's, which writes SANDBOX/killed.<pid>)
// was run for it.
'use strict';

import { access, mkdir, readfile, unlink, writefile } from 'fs';

let loop = { now: 100000000, timers: [], procs: [], pids: 1000 };

function init() {
	global.LOOP = loop;
}

function timer(ms, cb) {
	let t = { at: loop.now + ms, cb, off: false, cancel: function() { this.off = true; } };

	push(loop.timers, t);

	return t;
}

function process(cmd, args, env, cb) {
	let id = ++loop.pids, p = { id, cb, done: false, hung: false, code: null, pid: function() { return id; } };

	for (let a in args) {
		let m = match(a, /^root@(.+)$/);

		if (m && access(global.SANDBOX + '/hosts/' + m[1] + '/hang'))
			p.hung = true;
	}

	if (!p.hung) {
		let argv = [ '/usr/bin/env', '-i' ];

		for (let k, v in env)
			push(argv, k + '=' + v);

		p.code = system([ ...argv, cmd, ...args ]);

		// a death by signal reads as exit 0 in uloop
		if (p.code < 0)
			p.code = 0;
	}

	push(loop.procs, p);

	return p;
}

function pump() {
	for (let p in loop.procs) {
		if (p.done || (p.hung && !access(global.SANDBOX + '/killed.' + p.id)))
			continue;

		p.done = true;
		p.cb(p.hung ? 0 : p.code);
	}

	for (let t in sort(filter(loop.timers, (t) => !t.off && t.at <= loop.now), (a, b) => a.at - b.at)) {
		t.off = true;
		t.cb();
	}

	loop.timers = filter(loop.timers, (t) => !t.off);
}

function run() {
	let out = [], report = global.STUB?.published?.['vantage.collector']?.report;

	for (let step in json(readfile(global.CASES))) {
		if (step.report)
			push(out, report.call({ args: {} }));
		else if (step.advance) {
			for (let end = loop.now + step.advance; loop.now < end;) {
				loop.now += 500;
				pump();
			}

			push(out, null);
		}
		else if (step.write) {
			writefile(step.write[0], step.write[1]);
			push(out, null);
		}
		else if (step.block) {
			unlink(step.block);
			mkdir(step.block);
			push(out, null);
		}
	}

	print(sprintf('%J', out), '\n');
}

export { init, run, timer, process };
