#!/usr/bin/env node
'use strict';
/*
 * Vantage status icon generator (Node, no dependencies).
 *
 * LuCI views hard-code <img src="/luci-static/resources/icons/<name>.svg">
 * (luci-base owns those files). A theme cannot replace them on disk, so each
 * theme ships its own set and swaps them in with CSS:
 *
 *   img[src*="/resources/icons/wifi.svg"] { content: url(icons/light/wifi.svg) }
 *
 * The images are external documents, so they cannot inherit the page colour;
 * every icon is emitted once per theme and colour mode with the palette baked
 * in. Each glyph is defined once below on a 24px grid (round-cap strokes, no
 * gradients, no filters); "_disabled", signal and port variants are derived.
 *
 *   node dev/icons/build.js                     regenerate the package (vantage)
 *   node dev/icons/build.js graphite paper      regenerate the named targets
 *   node dev/icons/build.js --all               every target
 *   node dev/icons/build.js ... --sheet out.html  also write a contact sheet
 *
 * Output per target <t> (see TARGETS):
 *   <media>/icons/{light,dark}/<name>.svg
 *   <media>/icons.css   (the mapping, generated)
 * vantage: luci-theme-vantage/htdocs/luci-static/vantage (the package);
 * graphite, paper: prototypes/<t>/htdocs/luci-static/<t> (reference only).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');

/* ------------------------------------------------------------ palettes */

/*
 * Straight from each theme's CSS tokens (vantage.css / graphite.css, paper.css).
 * fg = secondary text, dim = tertiary text, surface = card background;
 * muted/faint are derived from dim towards the surface.
 */
const PALETTES = {
	graphite: {
		stroke: 1.9,
		light: { fg: '#4a515a', dim: '#5f666f', surface: '#ffffff', ok: '#0b7f6c', warn: '#9a5b00', err: '#c42b2b' },
		dark:  { fg: '#a9afb7', dim: '#8a9099', surface: '#1b1d21', ok: '#2dd4bf', warn: '#f5b84a', err: '#ff6b6b' },
	},
	paper: {
		stroke: 1.9,
		light: { fg: '#4a443c', dim: '#6b645a', surface: '#ffffff', ok: '#2d7a4c', warn: '#945f00', err: '#b0203e' },
		dark:  { fg: '#cbc2b5', dim: '#a1978a', surface: '#24211d', ok: '#62c08a', warn: '#e3a83f', err: '#f27a90' },
	},
};

/* the package ships the chosen direction (Graphite) under its real name */
PALETTES.vantage = PALETTES.graphite;

/* where each target's media directory lives */
const TARGETS = {
	vantage: path.join(ROOT, 'luci-theme-vantage', 'htdocs', 'luci-static', 'vantage'),
	graphite: path.join(ROOT, 'prototypes', 'graphite', 'htdocs', 'luci-static', 'graphite'),
	paper: path.join(ROOT, 'prototypes', 'paper', 'htdocs', 'luci-static', 'paper'),
};

const hex = c => [ 1, 3, 5 ].map(i => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');

function colours(p) {
	return Object.assign({}, p, {
		muted: mix(p.dim, p.surface, .38),   /* disabled glyphs, "down" ports */
		faint: mix(p.dim, p.surface, .74),   /* empty signal bars, spinner track */
		ok2: mix(p.ok, p.surface, .2),       /* 3/4 bars: same hue, a touch lighter */
	});
}

/* ------------------------------------------------------------- glyphs */

/* Every glyph draws with currentColor; the root <svg color=".."> sets it. */
const GLYPH = {
	/* radio waves: a dot and three concentric arcs */
	wifi: '<circle cx="12" cy="18.6" r="1.35" fill="currentColor" stroke="none"/>' +
		'<path d="M8.46 15.06a5 5 0 0 1 7.08 0M5.28 11.88a9.5 9.5 0 0 1 13.44 0M2.1 8.7a14 14 0 0 1 19.8 0"/>',

	/* RJ45 jack seen from the front: socket, latch recess, four contacts */
	ethernet: '<path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9.5A1.5 1.5 0 0 1 19 17h-2.5v2.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V17H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z"/>' +
		'<path d="M8.5 8v2.5M10.83 8v2.5M13.17 8v2.5M15.5 8v2.5" stroke-width="1.5"/>',

	/* deck on two piers with an arch between them */
	bridge: '<path d="M2.5 8h19M6 8v12M18 8v12M6 16.5a6 6 0 0 1 12 0M2.5 20h3.5M18 20h3.5"/>',

	/* two opposing arrows: frames switched between ports */
	switch: '<path d="M4 8h15.5M16 4.5 19.5 8 16 11.5M20 16H4.5M8 12.5 4.5 16 8 19.5"/>',

	/* tag with a punch hole */
	vlan: '<path d="M3.5 5v6.38a1.5 1.5 0 0 0 .44 1.06l7.62 7.62a1.5 1.5 0 0 0 2.12 0l6.38-6.38a1.5 1.5 0 0 0 0-2.12L12.44 3.94A1.5 1.5 0 0 0 11.38 3.5H5A1.5 1.5 0 0 0 3.5 5z"/>' +
		'<circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',

	/* stacked planes: separate routing tables */
	vrf: '<path d="M12 3.5 20.5 8 12 12.5 3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',

	/* portal with a road through it */
	tunnel: '<path d="M3.5 20v-8a8.5 8.5 0 0 1 17 0v8M8.5 20v-7a3.5 3.5 0 0 1 7 0v7M2 20h20"/>',

	/* shield with a tunnel mouth: generic encrypted tunnel, not a logo */
	wireguard: '<path d="M12 3 19.5 6v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6z"/>' +
		'<path d="M9 16v-3a3 3 0 0 1 6 0v3"/>',

	/* two interlocked chain links */
	alias: '<rect x="3" y="12" width="12" height="6" rx="3" transform="rotate(-45 9 15)"/>' +
		'<rect x="9" y="6" width="12" height="6" rx="3" transform="rotate(-45 15 9)"/>',
};

/* ----------------------------------------------------------- builders */

function svg(body, opts) {
	const o = Object.assign({ size: 32, color: null, sw: 2, extra: '' }, opts);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 24 24"` +
		(o.color ? ` color="${o.color}"` : '') +
		` fill="none" stroke="currentColor" stroke-width="${o.sw}" stroke-linecap="round" stroke-linejoin="round">` +
		o.extra + body + '</svg>\n';
}

/* "off" variant: muted glyph, cut by a diagonal slash */
function disabled(glyph, c, sw) {
	return svg(
		'<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">' +
		'<rect width="24" height="24" fill="#fff" stroke="none"/><path d="M4 4 20 20" stroke="#000" stroke-width="' + (sw + 3.2) + '"/></mask>' +
		'<g mask="url(#m)">' + glyph + '</g><path d="M4 4 20 20"/>',
		{ color: c.muted, sw });
}

/* 4 rising bars; `level` bars filled in `fill`, the rest faint */
function signal(level, fill, c, sw, mark) {
	const bars = [ [ 2, 15 ], [ 7.5, 11 ], [ 13, 7 ], [ 18.5, 3 ] ].map(([ x, y ], i) =>
		`<rect x="${x}" y="${y}" width="3.5" height="${21 - y}" rx="1.25" fill="${i < level ? fill : c.faint}" stroke="none"/>`).join('');
	/* no link: a small cross in the free corner above the short bars */
	const x = mark ? `<path d="M3.5 4.5l4.5 4.5M8 4.5 3.5 9" stroke="${c.muted}" stroke-width="${sw}"/>` : '';
	return svg(bars + x, { sw });
}

/* RJ45 port with link state; PoE (PSE) ports show a bolt instead of contacts */
function port(up, pse, c, sw) {
	const [ outline, pins ] = GLYPH.ethernet.split('/>').filter(Boolean).map(e => e + '/>');
	const tint = up ? outline.replace('/>', ' fill="currentColor" fill-opacity=".16" stroke="none"/>') : '';
	const inner = pse ? '<path d="M13.3 6.6 9.6 11.7h2.9l-1.2 4.2 3.8-5.2h-2.9z" fill="currentColor" stroke-width="1.1"/>' : pins;
	return svg(tint + outline + inner, { color: up ? c.ok : c.muted, sw });
}

/* spinner: faint track, one quarter arc; slower when reduced motion is set */
function loading(c, sw) {
	return svg(
		'<style>.a{transform-box:view-box;transform-origin:50% 50%;animation:r 1.1s linear infinite}' +
		'@keyframes r{to{transform:rotate(360deg)}}' +
		'@media (prefers-reduced-motion:reduce){.a{animation-duration:3.5s}}</style>' +
		`<circle cx="12" cy="12" r="8" stroke="${c.faint}"/>` +
		`<path class="a" d="M12 4a8 8 0 0 1 8 8" stroke="${c.fg}"/>`,
		{ size: 48, sw });
}

/* name -> svg for one theme + mode */
function iconSet(pal, mode) {
	const c = colours(pal[mode]);
	const sw = pal.stroke;
	const out = {};
	for (const [ name, g ] of Object.entries(GLYPH)) {
		out[name] = svg(g, { color: c.fg, sw });
		out[name + '_disabled'] = disabled(g, c, sw);
	}
	out['signal-075-100'] = signal(4, c.ok, c, sw);
	out['signal-050-075'] = signal(3, c.ok2, c, sw);
	out['signal-025-050'] = signal(2, c.warn, c, sw);
	out['signal-000-025'] = signal(1, c.err, c, sw);
	out['signal-000-000'] = signal(0, null, c, sw);
	out['signal-none'] = signal(0, null, c, sw, true);
	out.port_up = port(true, false, c, sw);
	out.port_down = port(false, false, c, sw);
	out.port_pse_up = port(true, true, c, sw);
	out.port_pse_down = port(false, true, c, sw);
	out.loading = loading(c, sw);
	return out;
}

/* ---------------------------------------------------------------- emit */

const MODES = [ 'light', 'dark' ];

function build(themes) {
	const all = {};
	for (const theme of themes) {
		const pal = PALETTES[theme];
		const media = TARGETS[theme];
		const sets = {};
		const css = [
			'/*',
			theme === 'vantage'
				? ' * Vantage status icons - GENERATED by dev/icons/build.js, do not edit.'
				: ` * Vantage "${theme}" status icons - GENERATED by dev/icons/build.js, do not edit.`,
			' * Replaces luci-base\'s /luci-static/resources/icons/*.svg in place: LuCI keeps',
			' * its <img> (size, title, alt); the image content comes from this theme.',
			' * ?h= is a content hash so a changed icon is never served from cache.',
			' */',
			'',
		];
		for (const mode of MODES) {
			const set = sets[mode] = iconSet(pal, mode);
			const dir = path.join(media, 'icons', mode);
			fs.mkdirSync(dir, { recursive: true });
			const scope = mode === 'dark' ? 'html[data-darkmode="true"] ' : '';
			css.push(mode === 'dark' ? '/* dark */' : '/* light (default) */');
			for (const [ name, data ] of Object.entries(set)) {
				fs.writeFileSync(path.join(dir, name + '.svg'), data);
				const h = crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
				css.push(`${scope}img[src*="/resources/icons/${name}.svg"] { content: url("icons/${mode}/${name}.svg?h=${h}"); }`);
			}
			css.push('');
		}
		fs.writeFileSync(path.join(media, 'icons.css'), css.join('\n'));
		all[theme] = sets;
		console.log(`${theme}: ${Object.keys(sets.light).length} icons x ${MODES.length} modes -> ${path.relative(ROOT, media)}/icons/, icons.css`);
	}
	return all;
}

/* contact sheet: every icon, both themes and modes, at 16/24/32px */
function sheet(all, file) {
	const uri = s => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');
	const bg = { vantage: { light: '#ffffff', dark: '#1b1d21' }, graphite: { light: '#ffffff', dark: '#1b1d21' }, paper: { light: '#ffffff', dark: '#24211d' } };
	const ink = { light: '#14171a', dark: '#e8eaed' };
	const names = Object.keys(all[Object.keys(all)[0]].light);
	let html = '<!doctype html><meta charset="utf-8"><title>Vantage icons</title><style>' +
		'body{margin:0;padding:24px;font:12px/1.4 system-ui,sans-serif;background:#8a8f96}' +
		'.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}' +
		'.panel{border-radius:10px;padding:14px 16px}' +
		'h2{margin:0 0 10px;font-size:14px}' +
		'table{border-collapse:collapse;width:100%}td{padding:2px 4px;vertical-align:middle;white-space:nowrap}' +
		'td.n{font-family:ui-monospace,monospace;font-size:11px;opacity:.8}' +
		'img{vertical-align:middle;margin-right:8px}' +
		'</style><div class="grid">';
	for (const theme of Object.keys(all)) for (const mode of MODES) {
		html += `<div class="panel" style="background:${bg[theme][mode]};color:${ink[mode]}"><h2>${theme} / ${mode}</h2><table>`;
		for (const n of names) {
			const u = uri(all[theme][mode][n]);
			html += `<tr><td class="n">${n}</td><td>` + [ 16, 24, 32 ].map(s => `<img src="${u}" width="${s}" height="${s}" alt="">`).join('') +
				`<span style="font-size:13px">eth0</span></td></tr>`;
		}
		html += '</table></div>';
	}
	fs.writeFileSync(file, html + '</div>\n');
	console.log('sheet ->', file);
}

const argv = process.argv.slice(2);
const si = argv.indexOf('--sheet');
const sheetFile = si >= 0 ? argv[si + 1] : null;
const named = argv.filter((a, i) => !a.startsWith('--') && !(si >= 0 && i === si + 1));
for (const n of named)
	if (!Object.prototype.hasOwnProperty.call(TARGETS, n)) {
		console.error(`unknown target '${n}' (known: ${Object.keys(TARGETS).join(', ')})`);
		process.exit(2);
	}
const all = build(argv.includes('--all') ? Object.keys(TARGETS) : named.length ? named : [ 'vantage' ]);
if (sheetFile) sheet(all, path.resolve(sheetFile));
