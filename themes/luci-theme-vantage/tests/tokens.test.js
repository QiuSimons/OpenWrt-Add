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
		'vt-icon-action', 'vt-ov-grip', 'vt-ov-btn', 'vt-drawer-close', 'vt-icon-pick', 'vt-rename-input', 'vt-kind', 'vt-fmenu-item' ]) {
		const self = new RegExp('\\.' + cls + '(?![\\w-])[^\\s]*\\s*$');
		const own = rules.filter(r => r.sel.some(s => self.test(s.trim())));
		assert.ok(own.length, 'found ' + cls);
		for (const r of own)
			assert.doesNotMatch(r.body, /(^|[\s;])height:\s*\d+px/, cls + ' has a fixed height: ' + r.sel.join(',').trim());
	}
});

/* the dashboard and LuCI's pages read as one product: the app takes the
   theme's roles (accent fill, status text, focus, segmented control,
   hover, meter, scrim, spacing, weights) instead of mixing its own */
const appRules = [ ...appCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g) ].map(m => ({ sel: m[1].trim(), body: m[2] }));
const appBody = sel => appRules.filter(r => r.sel === sel).map(r => r.body).join(';');

test('the shared contract names the roles, and the app reads each of them', () => {
	const roles = [ '--v-accent-text', '--v-accent-line', '--v-accent-fill', '--v-accent-fill-ink', '--v-ok-text', '--v-warn-text',
		'--v-err-text', '--v-info-text', '--v-focus', '--v-scrim', '--v-seg-bg', '--v-seg-on', '--v-seg-on-ring', '--v-hover',
		'--v-meter', '--v-card-px', '--v-card-py', '--v-shadow-raise', '--v-r-xs', '--v-r-xl',
		'--v-sp-0-5', '--v-sp-1', '--v-sp-1-5', '--v-sp-2', '--v-sp-3', '--v-sp-4', '--v-sp-5', '--v-sp-6', '--v-sp-8',
		'--v-fw-regular', '--v-fw-medium', '--v-fw-semibold', '--v-fw-bold' ];
	const read = new Set(uses.map(u => u.name));
	for (const n of roles) {
		assert.ok(defined.has(n), 'theme defines ' + n);
		assert.ok(read.has(n), 'app reads ' + n);
	}
	/* the theme maps them onto its own tokens, not onto copies */
	assert.match(themeCss, /--v-accent-fill: var\(--accent\);/);
	assert.match(themeCss, /--v-accent-fill-ink: var\(--accent-ink\);/);
	assert.match(themeCss, /--v-focus: var\(--focus\);/);
	assert.match(themeCss, /--v-seg-on-ring: var\(--seg-on-ring\);/);
	/* the app no longer re-mixes the accent text under the theme: the mix is the fallback only */
	assert.match(appCss, /--vt-accent-text: var\(--v-accent-text, color-mix\(/);
});

test('one recipe per component: primary fill, field focus, segmented switch, firewall colours, meters', () => {
	assert.match(appBody('.vt-app .vt-btn.vt-btn-primary'), /background:\s*var\(--vt-accent-fill\);[^]*color:\s*var\(--vt-accent-fill-ink\)/);
	for (const sel of [ '.vt-app .vt-select:focus', '.vt-app .vt-filter:focus-within', '.vt-app .vt-rename .vt-rename-input:focus' ])
		assert.match(appBody(sel), /border-color:\s*var\(--vt-focus\);\s*box-shadow:\s*var\(--vt-focus-ring\)/, sel);
	assert.match(appCss, /--vt-focus-ring: 0 0 0 1px var\(--vt-focus\), 0 0 0 4px var\(--vt-accent-soft\);/);
	/* the Wi-Fi/Wired switch is the theme's tabs: track, a control-high segment, the accent selection */
	assert.match(appBody('.vt-app .vt-kinds'), /background:\s*var\(--vt-seg-bg\)/);
	assert.match(appBody('.vt-app .vt-kind'), /min-height:\s*var\(--vt-ctl\)[^]*border:\s*3px solid transparent/);
	assert.match(appBody('.vt-app .vt-kind.vt-kind-on, .vt-app .vt-kind.vt-kind-on:hover'), /var\(--vt-seg-on\)[^]*var\(--vt-accent-text\)[^]*var\(--vt-seg-on-ring\)/);
	/* the selected tabs in the theme use the same ring token */
	assert.ok(/\.vt-tab\[aria-current\] \{[^}]*box-shadow: var\(--seg-on-ring\)/.test(themeCss));
	/* Overview's policy pills are neutral; the one that is an error (an
	   internet zone that accepts) uses the shared red text, as the other
	   Firewall tabs do */
	assert.match(appBody('.vt-app .vt-fg-pol'), /color:\s*var\(--vt-text-2\)/);
	assert.match(appBody('.vt-app .vt-fg-pol.is-risk'), /color:\s*var\(--vt-err-text\)/);
	assert.match(themeCss, /\.masq"\]:checked\) > \.td\[data-name="input"\] select:has\(> option:checked\[value="ACCEPT"\]\) \{\s*color: var\(--err-text\)/);
	/* memory and storage meters: one colour in both packages */
	assert.match(themeCss, /\.v-seg-used \{ background: var\(--v-meter\); \}/);
	assert.match(appCss, /--vt-meter: var\(--v-meter, /);
	for (const sel of [ '.vt-app .vt-seg-used', '.vt-app .vt-bar-fill', '.vt-app .vt-thin-fill' ])
		assert.match(appBody(sel), /background:\s*var\(--vt-meter\)/, sel);
});

test('four font weights: the theme uses 400-700 steps, the app the weight tokens', () => {
	const themeWeights = [ ...themeCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/font(?:-weight)?:\s*(\d{3})\b/g) ].map(m => m[1]);
	assert.ok(themeWeights.length > 40);
	assert.deepEqual([ ...new Set(themeWeights) ].filter(w => ![ '400', '500', '600', '700' ].includes(w)), []);
	const appWeights = [ ...appCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/font(?:-weight)?:\s*(var\(--vt-fw-[a-z-]+\))/g) ].map(m => m[1]);
	assert.ok(appWeights.length > 60, 'the app uses the weight tokens');
	assert.deepEqual([ ...new Set(appWeights) ].filter(w => !/^var\(--vt-fw-(regular|medium|semibold|bold)\)$/.test(w)), []);
	for (const n of [ 'regular', 'medium', 'semibold', 'bold' ])
		assert.match(appCss, new RegExp('--vt-fw-' + n + ': var\\(--v-fw-' + n + ', [4-7]00\\);'));
});
