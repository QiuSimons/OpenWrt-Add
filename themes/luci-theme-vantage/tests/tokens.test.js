'use strict';
/* The theme/app contract: the dashboard reads the theme only through
   --v-* custom properties, each with a fallback (it must also work under
   Bootstrap), and every one it reads is one the theme defines. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appCss = fs.readFileSync(path.join(root, 'luci-app-vantage/htdocs/luci-static/resources/vantage/app.css'), 'utf8');
const themeCss = fs.readFileSync(path.join(root, 'luci-theme-vantage/htdocs/luci-static/vantage/vantage.css'), 'utf8');

const uses = [ ...appCss.matchAll(/var\(\s*(--v-[a-z0-9-]+)\s*([,)])/g) ].map(m => ({ name: m[1], fallback: m[2] === ',' }));
const defined = new Set([ ...themeCss.matchAll(/^\s*(--v-[a-z0-9-]+)\s*:/gm) ].map(m => m[1]));

test('the app reads theme tokens only with a fallback', () => {
	assert.ok(uses.length > 30, 'found the token reads');
	assert.deepEqual(uses.filter(u => !u.fallback).map(u => u.name), []);
});

test('every theme token the app reads is defined by the theme', () => {
	assert.deepEqual([ ...new Set(uses.map(u => u.name)) ].filter(n => !defined.has(n)), []);
});

test('one type scale: every font size comes from it, but iOS\'s 16px for fields', () => {
	for (const n of [ 'micro', 'sm', 'base', 'md', 'lg', 'xl', '2xl' ]) {
		assert.ok(defined.has('--v-fs-' + n), '--v-fs-' + n);
		assert.match(appCss, new RegExp('--vt-fs-' + n + ': var\\(--v-fs-' + n + ', \\d+(\\.\\d+)?px\\);'));
	}
	const pxSizes = css => [ ...css.matchAll(/(?<![\w-])font(?:-size)?\s*:([^;{}]*)/g) ]
		.map(m => m[1].trim())
		.filter(v => /(^|\s)\d+(\.\d+)?px/.test(v.split('/')[0]))
		.filter(v => !/^16px( !important)?$/.test(v));
	assert.deepEqual(pxSizes(appCss), []);
	assert.deepEqual(pxSizes(themeCss), []);
});

test('controls share one height: the app takes the theme\'s, on touch too', () => {
	assert.ok(defined.has('--v-ctl-h'));
	assert.match(themeCss, /--v-ctl-h: var\(--ctl-h\);/);
	assert.match(themeCss, /@media \(pointer: coarse\) \{\s*:root \{ --ctl-h: 44px; \}/);
	assert.match(appCss, /--vt-ctl: var\(--v-ctl-h, 36px\);/);
	assert.match(appCss, /@media \(pointer: coarse\) \{\s*\.vt-app \{ --vt-ctl: var\(--v-ctl-h, 44px\); \}/);
	/* no control in the app keeps a fixed height of its own: rules whose
	   selector ends at the control (states allowed, descendants not) */
	const rules = [ ...appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g) ].map(m => ({ sel: m[1].split(','), body: m[2] }));
	for (const cls of [ 'vt-btn', 'vt-layout-btn', 'vt-filter', 'vt-filter-input', 'vt-fchip', 'vt-sort', 'vt-fold-btn',
		'vt-icon-action', 'vt-ov-grip', 'vt-ov-btn', 'vt-drawer-close', 'vt-icon-pick', 'vt-rename-input' ]) {
		const self = new RegExp('\\.' + cls + '(?![\\w-])[^\\s]*\\s*$');
		const own = rules.filter(r => r.sel.some(s => self.test(s.trim())));
		assert.ok(own.length, 'found ' + cls);
		for (const r of own)
			assert.doesNotMatch(r.body, /(^|[\s;])height:\s*\d+px/, cls + ' has a fixed height: ' + r.sel.join(',').trim());
	}
});
