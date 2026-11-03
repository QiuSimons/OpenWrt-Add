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
