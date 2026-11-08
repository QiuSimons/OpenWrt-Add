'use strict';
/* Motion rules of the dashboard stylesheet (app.css): idle animations
   run on the compositor, nothing animates layout on every poll, and the
   Live beat neither covers its dot nor shows without motion. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'luci-app-vantage/htdocs/luci-static/resources/vantage/app.css'), 'utf8')
	.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [ ...css.matchAll(/([^{}]+)\{([^{}]*)\}/g) ].map(m => ({ sel: m[1].trim(), body: m[2] }));
const keyframes = [ ...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g) ].map(m => ({ name: m[1], body: m[2] }));

test('keyframes animate transform and opacity only (compositor), never stroke-dashoffset or a box', () => {
	assert.ok(keyframes.length >= 3, 'found the keyframes');
	for (const k of keyframes)
		for (const p of [ ...k.body.matchAll(/([\w-]+)\s*:/g) ].map(m => m[1]))
			assert.ok([ 'transform', 'opacity' ].includes(p), `@keyframes ${k.name} animates ${p}`);
});

test('no width or height transition runs on every poll', () => {
	for (const r of rules) {
		const t = /(?:^|;)\s*transition\s*:([^;]*)/.exec(r.body);
		if (!t || !/\b(width|height|all)\b/.test(t[1])) continue;
		/* the memory bar animates only a visible change (.vt-seg-move, set by the view) */
		assert.match(r.sel, /\.vt-seg-move\b/, `${r.sel} transitions ${t[1].trim()}`);
	}
});

test('the Live beat: behind its dot, invisible unless it animates', () => {
	const ring = rules.find(r => r.sel === '.vt-app .vt-live-beat::after');
	assert.ok(ring);
	assert.match(ring.body, /z-index:\s*-1/);
	assert.match(ring.body, /(?:^|;|\s)opacity:\s*0\s*;/, 'transparent at rest (reduced motion stops the animation)');
	assert.match(rules.find(r => r.sel === '.vt-app .vt-livepill').body, /isolation:\s*isolate/, 'the ring stays inside the pill');
	assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none !important/);
});

test('the orb and the Live beat always pulse, slower while all is fine; a paused page keeps a still dot (#100)', () => {
	const animated = rules.filter(r => /(?:^|;|\s)animation\s*:\s*vt-(ring|beat)\b/.test(r.body)).map(r => r.sel).sort();
	assert.deepEqual(animated, [ '.vt-app .vt-live-err .vt-live-beat::after', '.vt-app .vt-live-ok .vt-live-beat::after', '.vt-app .vt-orb-warn::after, .vt-app .vt-orb-err::after', '.vt-app .vt-orb::after' ]);
	const seconds = sel => parseFloat(/animation\s*:\s*\S+\s+([\d.]+)s/.exec(rules.find(r => r.sel === sel).body)[1]);
	assert.ok(seconds('.vt-app .vt-orb::after') > seconds('.vt-app .vt-orb-warn::after, .vt-app .vt-orb-err::after'), 'attention pulses faster');
	assert.ok(seconds('.vt-app .vt-live-ok .vt-live-beat::after') > seconds('.vt-app .vt-live-err .vt-live-beat::after'), 'reconnecting beats faster');
	assert.ok(!rules.some(r => /vt-live-paused/.test(r.sel) && /animation\s*:/.test(r.body)), 'paused: no beat');
});

test('a band and a name source keep their case inside upper-case labels ("2.4 GHz", "mDNS")', () => {
	for (const sel of [ '.vt-app .vt-band', '.vt-app .vt-src' ])
		assert.match(rules.find(r => r.sel === sel).body, /text-transform:\s*none/, sel);
	assert.ok(!/\.vt-kpi/.test(css), 'the number strip under the path is gone');
});

test('reduced motion: no moving flow dots, the static dotted wire instead', () => {
	const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
	assert.ok(rm);
	assert.match(rm[1], /\.vt-flows\s*\{\s*display:\s*none/);
	assert.match(rm[1], /\.vt-flow-on\s*\{\s*opacity:/);
});

test('found on a real router: links to absent pages, a wrapping handle bar, clipped node text', () => {
	const view = fs.readFileSync(path.join(__dirname, '..', 'luci-app-vantage/htdocs/luci-static/resources/view/vantage/overview.js'), 'utf8');
	/* Mount Points without block-mount: no link to a 404 */
	assert.match(view, /function pageLink\(page, label\) \{\s*if \(!hasPage\(page\)\) return '';/);
	assert.match(view, /var to = hasPage\(c\.page\) \? c\.page : \[ 'admin', 'status', 'overview' \];/);
	/* a quarter-wide tile's handle bar: two rows, not three (no ‹ ›) */
	assert.ok(rules.some((r) => r.sel === '.vt-app .vt-cell' && /container:\s*vtcell \/ inline-size/.test(r.body)));
	/* a tile with a container of its own must not drop the vtcell name */
	for (const sel of [ '.vt-app .vt-hero', '.vt-app .vt-sys', '.vt-app .vt-clients' ]) {
		const r = rules.find((x) => x.sel === sel && /container:/.test(x.body));
		assert.match(r.body, /container:\s*[\w ]*\bvtcell\b[\w ]*\/ inline-size/, sel);
	}
	for (const r of rules.filter((x) => /container:/.test(x.body) && /\.vt-(hero|sys|clients|cell)$/.test(x.sel)))
		assert.match(r.body, /\bvtcell\b/, r.sel);
	assert.match(css, /@container vtcell \(max-width: 340px\) \{ \.vt-app \.vt-ov-lr \{ display: none; \} \}/);
	/* text-only node sub-lines are blocks, so their ellipsis shows */
	assert.ok(rules.some((r) => r.sel === '.vt-app .vt-node-sub:not(:has(> *))' && /display:\s*block/.test(r.body)));
});

test('other lines to the internet (#88): the main row as with one line, the others under it; on a phone one column again', () => {
	const rule = sel => rules.find(r => r.sel === sel);
	/* a tall branch column grows the outer rows, not the gap between the lines */
	assert.match(rule('.vt-app .vt-path-lines').body, /grid-template-rows:\s*1fr auto auto 1fr/);
	for (const [ sel, area ] of [ [ '.vt-node-gw', '2 / 1' ], [ '.vt-link-label', '2 / 2' ], [ '.vt-node-ap', '2 / 3' ], [ '.vt-branches', '1 / 4 / -1 / 5' ] ])
		assert.match(rule('.vt-app .vt-path-lines > ' + sel).body, new RegExp('grid-area:\\s*' + area.replace(/ /g, '\\s*') + '\\s*;'), sel);
	assert.match(rule('.vt-app .vt-lines').body, /grid-area:\s*3\s*\/\s*1\s*;/);
	/* a narrow node: the tag under the name, a long name ellipsized */
	assert.match(rule('.vt-app .vt-node-kicker-tag').body, /flex-wrap:\s*wrap/);
	assert.match(rule('.vt-app .vt-node-name').body, /text-overflow:\s*ellipsis/);
	/* the phone layout puts every part back in the one column */
	const phone = /@container vthero \(max-width: 700px\) \{([\s\S]*?)\n\}/.exec(css)[1];
	assert.match(phone, /\.vt-path-lines \{ grid-template-rows: none; \}/);
	assert.match(phone, /\.vt-path-lines > \.vt-node-gw, [^{]*\.vt-path-lines > \.vt-branches, \.vt-app \.vt-lines \{ grid-area: auto; \}/);
	/* "default route" keeps its case in the upper-case kicker */
	assert.match(rule('.vt-app .vt-node-tag').body, /text-transform:\s*none/);
	assert.match(rule('.vt-app .vt-node-rates').body, /flex-wrap:\s*wrap/, 'a narrow node wraps its rates');
});

test('Customize\'s notes are not the hint, which phones hide', () => {
	const view = fs.readFileSync(path.join(__dirname, '..', 'luci-app-vantage/htdocs/luci-static/resources/view/vantage/overview.js'), 'utf8');
	assert.match(view, /el\.editNote = E\('span', \{ 'class': 'vt-edit-note'/);
	assert.ok(!/vt-edit-note[^{]*\{[^}]*display: none[^}]*\}/.test(css.replace(/\.vt-edit-note\[hidden\][^}]*\}/, '')));
});
