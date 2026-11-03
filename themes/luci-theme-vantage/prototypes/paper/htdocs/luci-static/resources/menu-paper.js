'use strict';
'require baseclass';
'require ui';
'require rpc';

/* Vantage "paper" prototype: icon rail + flyout, breadcrumb, page tabs,
   command palette, host chip, theme toggle and indicator pills. */

const callBoard = rpc.declare({ object: 'system', method: 'board' });

const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
	dashboard: '<rect x="4" y="4" width="7" height="8" rx="1.6"/><rect x="13" y="4" width="7" height="5" rx="1.6"/><rect x="13" y="11" width="7" height="9" rx="1.6"/><rect x="4" y="14" width="7" height="6" rx="1.6"/>',
	status: '<path d="M3 12.5h3.6l2.4-6 4.6 11.5 2.6-5.5H21"/>',
	system: '<path d="M6 4v5.2M6 12.8V20M12 4v9.2M12 16.8V20M18 4v1.2M18 8.8V20"/><circle cx="6" cy="11" r="1.8"/><circle cx="12" cy="15" r="1.8"/><circle cx="18" cy="7" r="1.8"/>',
	network: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5M12 3.5C9.6 6 8.5 8.8 8.5 12s1.1 6 3.5 8.5"/>',
	services: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><path d="M16.75 13.5v6.5M13.5 16.75H20"/>',
	vpn: '<path d="M12 3.5l7 2.7v5.4c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6.2z"/><path d="M9.2 12.1l2 2 3.7-3.9"/>',
	statistics: '<path d="M4 20h16M7 16.5V11M12 16.5V6M17 16.5v-3.5"/>',
	storage: '<ellipse cx="12" cy="6.5" rx="7" ry="2.8"/><path d="M5 6.5v11c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-11M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
	dot: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2"/>',
	chevron: '<path d="M9.5 6l6 6-6 6"/>',
	search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
	page: '<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20z"/><path d="M14 3.5V8h4"/>',
	enter: '<path d="M19 5v6a2 2 0 0 1-2 2H6M9.5 9.5 6 13l3.5 3.5"/>',
	close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'
};

function icon(name, cls) {
	const svg = document.createElementNS(SVGNS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	if (cls) svg.setAttribute('class', cls);
	svg.innerHTML = ICONS[name] || ICONS.dot;   /* static strings from this file */
	return svg;
}

function iconFor(name, title) {
	const key = String(name).toLowerCase(), t = String(title || '').toLowerCase();
	if (ICONS[key]) return key;
	if (/overview|dashboard/.test(key + t)) return 'dashboard';
	if (/stat/.test(key)) return 'statistics';
	if (/nas|storage|disk/.test(key + t)) return 'storage';
	if (/vpn|wireguard|tunnel/.test(key + t)) return 'vpn';
	return 'dot';
}

function store(key, value) {
	try {
		if (value === undefined) return localStorage.getItem(key);
		if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
	} catch (e) {}
	return null;
}

const mqMobile = window.matchMedia('(max-width: 720px)');
const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
const mqHover = window.matchMedia('(hover: hover) and (pointer: fine)');

/* ---------------------------------------------------------------------------
 * Stock-page enhancers, only where CSS cannot restructure LuCI's markup
 * (Status -> Overview: fused memory bar, per-mount storage bars, radio band
 * chips). Rules:
 *  - DOM is built with createElement/textContent, never innerHTML;
 *  - LuCI's own nodes stay in the DOM (hidden by class) so its code keeps
 *    working; nothing of LuCI's is moved or removed;
 *  - idempotent: the status includes re-render their container on every
 *    poll (dom.content), the observer rebuilds from the fresh nodes before
 *    the next paint, and a pass that finds nothing to do mutates nothing.
 * ------------------------------------------------------------------------ */

const BYTE_UNITS = { '': 1, K: 1024, M: 1048576, G: 1073741824, T: 1099511627776, P: 1125899906842624 };

function h(tag, attrs, children) {
	const el = document.createElement(tag);
	for (const k in (attrs || {})) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
	[].concat(children == null ? [] : children).forEach(c => {
		if (c == null || c === false) return;
		el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
	});
	return el;
}

function parseBytes(s) {
	const m = /(-?\d+(?:\.\d+)?)\s*([KMGTP]?)i?B\b/.exec(s || '');
	return m ? parseFloat(m[1]) * BYTE_UNITS[m[2]] : null;
}

/* progressbar title "534.50 MiB / 856.19 MiB (62%)" -> { value, total } */
function parseBarTitle(title) {
	const parts = String(title || '').split(' / ');
	if (parts.length < 2) return null;
	const value = parseBytes(parts[0]), total = parseBytes(parts[1]);
	return (value != null && total != null && total > 0) ? { value, total } : null;
}

function fmtBytes(n) { return String.format('%1024.1mB', Math.max(0, n)); }
function pctOf(n, total) { return total > 0 ? Math.round(100 * n / total) : 0; }

/* the Overview .cbi-section whose title (text before the Hide/Show label) is `title` */
function statusSections(title) {
	return Array.prototype.filter.call(document.querySelectorAll('#view .cbi-section > .cbi-title > h3'), hd => {
		const t = hd.firstChild;
		return t && t.nodeType === 3 && t.data.trim() === title;
	}).map(hd => hd.parentNode.parentNode);
}

/* the include's freshly rendered table, if it has not been enhanced yet */
function pendingTable(section) {
	const box = section.children[1];
	const table = box && box.querySelector(':scope > table.table');
	return (table && !table.hasAttribute('data-v-done')) ? table : null;
}

function barRows(table) {
	return Array.prototype.map.call(table.querySelectorAll(':scope > tr, :scope > tbody > tr'), tr => {
		const bar = tr.querySelector('.cbi-progressbar');
		return { label: (tr.firstElementChild ? tr.firstElementChild.textContent : '').trim(),
		         pair: bar ? parseBarTitle(bar.getAttribute('title')) : null };
	});
}

function segment(cls, value, total, title) {
	const s = h('span', { 'class': 'v-seg ' + cls, 'title': title });
	s.style.width = (total > 0 ? Math.min(100, 100 * value / total) : 0).toFixed(2) + '%';
	return s;
}

function legendKey(cls, label, value, note) {
	return h('li', {}, [ h('span', { 'class': 'v-key ' + cls }), h('span', {}, label), h('b', {}, fmtBytes(value)), note ? h('em', {}, note) : null ]);
}

function replaceTable(table, block) {
	table.setAttribute('data-v-done', '1');
	table.classList.add('v-src-hidden');
	const prev = table.previousElementSibling;
	if (prev && prev.classList.contains('v-enhanced')) prev.remove();
	block.classList.add('v-enhanced');
	table.parentNode.insertBefore(block, table);
}

/* Memory: one bar. in use = total - available; cache (reclaimable) =
   available - free; free = total - LuCI's "Used" (which is total - free). */
function enhanceMemory() {
	statusSections(_('Memory')).forEach(section => {
		const table = pendingTable(section);
		if (!table) return;
		const rows = barRows(table), get = l => (rows.find(r => r.label === l) || {}).pair;
		const avail = get(_('Total Available')), used = get(_('Used')),
		      buffered = get(_('Buffered')), cached = get(_('Cached')), swap = get(_('Swap free'));
		const total = (used || avail || {}).total;
		if (!total || !used) return;

		const free = Math.max(0, total - used.value);
		let available = avail ? avail.value : free + (buffered ? buffered.value : 0) + (cached ? cached.value : 0);
		available = Math.min(total, Math.max(available, free));
		const inuse = total - available, reclaim = available - free;
		const usedPct = pctOf(inuse, total);

		const summary = '%s: %s %s, %s %s (%s), %s %s, %s %s'.format(_('Memory'),
			_('In use'), fmtBytes(inuse), _('Cache'), fmtBytes(reclaim), _('reclaimable'),
			_('Free'), fmtBytes(free), _('Total'), fmtBytes(total));

		const children = [
			h('div', { 'class': 'v-meter-head' }, [
				h('span', { 'class': 'v-meter-big' }, [ pctOf(available, total) + '%', h('small', {}, _('available')) ]),
				h('span', { 'class': 'v-meter-sub' }, '%s / %s'.format(fmtBytes(available), fmtBytes(total)))
			]),
			h('div', { 'class': 'v-meter-bar', 'role': 'img', 'aria-label': summary }, [
				segment('v-seg-used' + (usedPct >= 90 ? ' is-crit' : usedPct >= 75 ? ' is-warn' : ''), inuse, total, _('In use')),
				segment('v-seg-cache', reclaim, total, _('Cache') + ' (' + _('reclaimable') + ')')
			]),
			h('ul', { 'class': 'v-meter-legend', 'aria-hidden': 'true' }, [
				legendKey('v-seg-used', _('In use'), inuse),
				legendKey('v-seg-cache', _('Cache'), reclaim, _('reclaimable')),
				legendKey('v-seg-free', _('Free'), free)
			])
		];

		if (swap) {
			const swapUsed = swap.total - swap.value;
			children.push(h('div', { 'class': 'v-meter-rows v-meter-swap' }, h('div', { 'class': 'v-meter-row' }, [
				h('span', { 'class': 'v-meter-label' }, _('Swap')),
				h('div', { 'class': 'v-meter-bar is-thin', 'role': 'img',
				           'aria-label': '%s: %s / %s'.format(_('Swap'), fmtBytes(swapUsed), fmtBytes(swap.total)) },
					segment('v-seg-used', swapUsed, swap.total)),
				h('span', { 'class': 'v-meter-val' }, [ h('b', {}, fmtBytes(swapUsed)), ' / ' + fmtBytes(swap.total) ])
			])));
		}

		replaceTable(table, h('div', { 'class': 'v-meter v-meter-mem' }, children));
	});
}

/* Storage: one thin bar per mount, "used · free of total" beside it */
function enhanceStorage() {
	statusSections(_('Storage')).forEach(section => {
		const table = pendingTable(section);
		if (!table) return;
		const rows = barRows(table);
		if (!rows.length) return;

		replaceTable(table, h('div', { 'class': 'v-meter-rows v-meter-disk' }, rows.map(r => {
			const m = /^(.*) \((\/.*)\)$/.exec(r.label);
			const label = h('span', { 'class': 'v-meter-label' }, m ? [ m[2], h('small', {}, m[1]) ] : r.label);
			if (!r.pair)
				return h('div', { 'class': 'v-meter-row' }, [ label, h('div', { 'class': 'v-meter-bar is-thin' }), h('span', { 'class': 'v-meter-val' }, '?') ]);
			const used = r.pair.value, size = r.pair.total, p = pctOf(used, size);
			return h('div', { 'class': 'v-meter-row' }, [
				label,
				h('div', { 'class': 'v-meter-bar is-thin', 'role': 'img',
				           'aria-label': '%s: %s %s, %s %s'.format(r.label, fmtBytes(used), _('used'), fmtBytes(size - used), _('free')) },
					segment('v-seg-used' + (p >= 95 ? ' is-crit' : p >= 80 ? ' is-warn' : ''), used, size)),
				h('span', { 'class': 'v-meter-val' }, [
					h('b', {}, fmtBytes(used)), ' ' + _('used') + ' · ' + fmtBytes(size - used) + ' ' + _('free') + ' · ' + fmtBytes(size)
				])
			]);
		})));
	});
}

/* Wireless radio boxes: band chip from the "Channel: 6 (2.437 GHz)" line */
function decorateRadios() {
	statusSections(_('Wireless')).forEach(section => {
		section.querySelectorAll('.network-status-table > .ifacebox').forEach(box => {
			const head = box.querySelector(':scope > .ifacebox-head');
			if (!head || head.hasAttribute('data-v-band')) return;
			let band = '';
			box.querySelectorAll('.ifacebox-body > span > .nowrap').forEach(n => {
				const label = n.querySelector('strong');
				const m = label && label.textContent.indexOf(_('Channel')) === 0 && /(\d+(?:\.\d+)?)\s*GHz/.exec(n.textContent);
				if (m) {
					const f = parseFloat(m[1]);
					band = f < 3 ? '2.4 GHz' : f < 5.925 ? '5 GHz' : f < 7.2 ? '6 GHz' : '60 GHz';
				}
			});
			if (band) head.setAttribute('data-v-band', band);
		});
	});
}

function setupStockEnhancers() {
	const view = document.getElementById('view');
	if (!view || !window.MutationObserver) return;
	if (!/^admin(-status(-overview)?)?$/.test(document.body.getAttribute('data-page') || '')) return;
	let busy = false;
	const run = () => {
		if (busy) return;
		busy = true;
		try { enhanceMemory(); enhanceStorage(); decorateRadios(); }
		catch (e) { if (window.console) console.warn('vantage: status enhancer', e); }
		busy = false;
	};
	new MutationObserver(run).observe(view, { childList: true, subtree: true });
	run();
}

return baseclass.extend({
	__init__() {
		this.dp = (L.env.dispatchpath || []).slice();
		this.rp = (L.env.requestpath || []).slice();
		this.setupTheme();
		this.setupIndicators();
		setupStockEnhancers();
		ui.menu.load().then(L.bind(this.render, this));
		L.resolveDefault(callBoard(), null).then(L.bind(this.renderHost, this));
	},

	/* ------------------------------------------------------------- menu */

	render(tree) {
		const admin = tree.children && tree.children.admin;
		if (!admin) return;
		this.tree = tree;
		this.cats = ui.menu.getChildren(admin).filter(c => {
			if (c.name === 'logout') return false;
			const kids = ui.menu.getChildren(c);
			return kids.length > 0 || !(c.action && c.action.type === 'firstchild');
		});
		this.renderRail();
		this.renderCrumbs();
		this.renderTabs();
		this.buildIndex();
		this.setupPalette();
		this.rememberVisit();
	},

	nodeAt(path) {
		let node = this.tree;
		for (const seg of path) {
			node = node && node.children && node.children[seg];
			if (!node) return null;
		}
		return node;
	},

	renderRail() {
		const list = document.getElementById('rail-list');
		const flyout = document.getElementById('flyout');
		if (!list || !flyout) return;
		const active = this.dp[1];

		for (const cat of this.cats) {
			const kids = ui.menu.getChildren(cat);
			const title = _(cat.title);
			const li = E('li', { 'class': 'rail-entry' });
			const isActive = (cat.name === active);
			const inner = [ icon(iconFor(cat.name, cat.title), 'rail-icon'), E('span', { 'class': 'rail-label' }, title) ];

			let trigger;
			if (kids.length) {
				inner.push(icon('chevron', 'rail-caret'));
				trigger = E('button', {
					'type': 'button', 'class': 'rail-item', 'data-cat': cat.name,
					'aria-expanded': 'false', 'aria-controls': 'flyout', 'aria-label': title
				}, inner);
				const sub = E('ul', { 'class': 'rail-sub', 'role': 'list' },
					kids.map(k => E('li', {}, E('a', {
						'href': L.url('admin', cat.name, k.name),
						'aria-current': (isActive && this.dp[2] === k.name) ? 'page' : null
					}, _(k.title)))));
				li.appendChild(trigger);
				li.appendChild(sub);
				if (isActive) li.classList.add('is-open');
			}
			else {
				trigger = E('a', { 'class': 'rail-item is-leaf', 'href': L.url('admin', cat.name), 'data-cat': cat.name, 'aria-label': title }, inner);
				li.appendChild(trigger);
			}
			if (isActive) { trigger.classList.add('is-active'); if (!kids.length) trigger.setAttribute('aria-current', 'page'); }
			list.appendChild(li);
		}

		this.setupRailBehaviour(list, flyout);
	},

	setupRailBehaviour(list, flyout) {
		const rail = document.getElementById('rail');
		const scrim = document.getElementById('scrim');
		const pin = document.getElementById('rail-pin');
		let openTimer = null, closeTimer = null;
		const pinned = () => document.documentElement.getAttribute('data-rail') === 'pinned' && !mqMobile.matches;

		const items = () => Array.from(list.querySelectorAll('.rail-item'));

		const close = (refocus) => {
			const btn = list.querySelector('.rail-item[aria-expanded="true"]');
			if (btn) btn.setAttribute('aria-expanded', 'false');
			flyout.hidden = true;
			flyout.removeAttribute('data-cat');
			scrim.hidden = true;
			document.body.classList.remove('flyout-open');
			if (refocus && btn) btn.focus();
		};

		const open = (btn, focusFirst) => {
			const cat = this.cats.find(c => c.name === btn.getAttribute('data-cat'));
			if (!cat) return;
			if (flyout.getAttribute('data-cat') === cat.name && !flyout.hidden) {
				if (focusFirst) { const a = flyout.querySelector('a'); if (a) a.focus(); }
				return;
			}
			const prev = list.querySelector('.rail-item[aria-expanded="true"]');
			if (prev) prev.setAttribute('aria-expanded', 'false');
			btn.setAttribute('aria-expanded', 'true');
			this.fillFlyout(flyout, cat);
			flyout.setAttribute('data-cat', cat.name);
			flyout.hidden = false;
			if (mqMobile.matches) { scrim.hidden = false; document.body.classList.add('flyout-open'); }
			else {
				/* align the panel with the hovered item when there is room */
				const r = btn.getBoundingClientRect();
				const h = flyout.offsetHeight;
				const top = Math.max(8, Math.min(r.top - 8, window.innerHeight - h - 8));
				flyout.style.top = `${top}px`;
			}
			if (focusFirst) { const a = flyout.querySelector('a'); if (a) a.focus(); }
		};

		this.closeFlyout = close;

		list.addEventListener('click', ev => {
			const btn = ev.target.closest('button.rail-item');
			if (!btn) return;
			if (pinned()) {
				btn.parentNode.classList.toggle('is-open');
				btn.setAttribute('aria-expanded', btn.parentNode.classList.contains('is-open') ? 'true' : 'false');
				return;
			}
			if (btn.getAttribute('aria-expanded') === 'true') close(false);
			else open(btn, ev.detail === 0);
		});

		/* hover intent (desktop pointer only, not pinned) */
		const mouse = ev => (ev.pointerType === 'mouse' || (ev.pointerType == null && mqHover.matches));
		list.addEventListener('pointerover', ev => {
			if (!mouse(ev) || pinned() || mqMobile.matches) return;
			const item = ev.target.closest('.rail-item');
			clearTimeout(closeTimer);
			clearTimeout(openTimer);
			if (!item) return;
			if (item.tagName !== 'BUTTON') { openTimer = setTimeout(() => close(false), 120); return; }
			openTimer = setTimeout(() => open(item, false), flyout.hidden ? 140 : 40);
		});
		const leave = (ev) => {
			if (!mouse(ev) || pinned() || mqMobile.matches) return;
			clearTimeout(openTimer);
			clearTimeout(closeTimer);
			closeTimer = setTimeout(() => {
				if (!flyout.contains(document.activeElement)) close(false);
			}, 280);
		};
		rail.addEventListener('pointerleave', leave);
		flyout.addEventListener('pointerleave', leave);
		flyout.addEventListener('pointerenter', () => clearTimeout(closeTimer));
		rail.addEventListener('pointerenter', () => clearTimeout(closeTimer));

		/* keyboard: arrows move within the rail, Right/Enter opens */
		list.addEventListener('keydown', ev => {
			const all = items(), i = all.indexOf(document.activeElement);
			if (i < 0) return;
			const vertical = !mqMobile.matches;
			const next = vertical ? 'ArrowDown' : 'ArrowRight', prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
			if (ev.key === next || ev.key === prevKey) {
				ev.preventDefault();
				all[(i + (ev.key === next ? 1 : all.length - 1)) % all.length].focus();
			}
			else if (ev.key === 'ArrowRight' && vertical && all[i].tagName === 'BUTTON' && !pinned()) {
				ev.preventDefault();
				open(all[i], true);
			}
			else if (ev.key === 'Home' || ev.key === 'End') {
				ev.preventDefault();
				all[ev.key === 'Home' ? 0 : all.length - 1].focus();
			}
		});

		flyout.addEventListener('keydown', ev => {
			const links = Array.from(flyout.querySelectorAll('a, button'));
			const i = links.indexOf(document.activeElement);
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
				ev.preventDefault();
				links[(i + (ev.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length].focus();
			}
			else if (ev.key === 'Escape' || (ev.key === 'ArrowLeft' && !mqMobile.matches)) {
				ev.preventDefault();
				close(true);
			}
			else if (ev.key === 'Tab' && !mqMobile.matches) {
				/* leaving the panel returns to the rail order */
				if ((ev.shiftKey && i === 0) || (!ev.shiftKey && i === links.length - 1)) close(ev.shiftKey);
			}
		});

		flyout.addEventListener('click', ev => {
			if (ev.target.closest('.flyout-close')) close(true);
		});
		scrim.addEventListener('click', () => close(false));
		document.addEventListener('click', ev => {
			if (!flyout.hidden && !flyout.contains(ev.target) && !rail.contains(ev.target)) close(false);
		});
		document.addEventListener('keydown', ev => {
			if (ev.key === 'Escape' && !flyout.hidden) close(true);
		});
		mqMobile.addEventListener('change', () => close(false));

		/* pin / unpin (desktop) */
		const syncPin = () => {
			const p = document.documentElement.getAttribute('data-rail') === 'pinned';
			pin.setAttribute('aria-pressed', p ? 'true' : 'false');
			pin.setAttribute('title', p ? _('Collapse navigation') : _('Expand navigation'));
			pin.setAttribute('aria-label', p ? _('Collapse navigation') : _('Expand navigation'));
			pin.querySelector('.rail-label').textContent = p ? _('Collapse') : _('Expand');
			list.querySelectorAll('.rail-entry').forEach(li => {
				const b = li.querySelector('button.rail-item');
				if (b) b.setAttribute('aria-expanded', (p && li.classList.contains('is-open')) ? 'true' : 'false');
			});
		};
		pin.addEventListener('click', () => {
			const p = document.documentElement.getAttribute('data-rail') === 'pinned';
			close(false);
			if (p) { document.documentElement.removeAttribute('data-rail'); store('paper-rail', null); }
			else { document.documentElement.setAttribute('data-rail', 'pinned'); store('paper-rail', 'pinned'); }
			syncPin();
		});
		syncPin();
	},

	fillFlyout(flyout, cat) {
		const kids = ui.menu.getChildren(cat);
		const current = (this.dp[1] === cat.name) ? this.dp[2] : null;
		flyout.replaceChildren(
			E('div', { 'class': 'flyout-head' }, [
				icon(iconFor(cat.name, cat.title), 'flyout-icon'),
				E('h2', { 'class': 'flyout-title', 'id': 'flyout-title' }, _(cat.title)),
				E('button', { 'type': 'button', 'class': 'flyout-close icon-btn', 'aria-label': _('Close') }, icon('close'))
			]),
			E('ul', { 'class': 'flyout-list', 'role': 'list', 'aria-labelledby': 'flyout-title' },
				kids.map(k => {
					const sub = ui.menu.getChildren(k);
					return E('li', {}, E('a', {
						'href': L.url('admin', cat.name, k.name),
						'class': 'flyout-link',
						'aria-current': (current === k.name) ? 'page' : null
					}, [
						E('span', { 'class': 'flyout-link-title' }, _(k.title)),
						sub.length ? E('span', { 'class': 'flyout-link-meta', 'aria-hidden': 'true' }, sub.slice(0, 3).map(s => _(s.title)).join(' · ') + (sub.length > 3 ? ' …' : '')) : ''
					]));
				}))
		);
	},

	renderCrumbs() {
		const nav = document.getElementById('crumbs');
		if (!nav) return;
		const ol = E('ol');
		let node = this.tree.children.admin;
		const path = [ 'admin' ];
		for (let i = 1; i < this.dp.length && node; i++) {
			node = node.children && node.children[this.dp[i]];
			if (!node || !node.title) break;
			path.push(this.dp[i]);
			const last = (i === this.dp.length - 1);
			ol.appendChild(E('li', { 'class': last ? 'is-current' : null },
				last ? E('span', { 'aria-current': 'page' }, _(node.title))
				     : E('a', { 'href': L.url.apply(L, path) }, _(node.title))));
		}
		if (ol.childNodes.length) {
			nav.appendChild(ol);
			const t = ol.lastElementChild.textContent;
			this.pageTitle = t;
		}
	},

	renderTabs() {
		const host = document.getElementById('tabmenu');
		if (!host || this.dp.length < 3) return;
		const parent = this.nodeAt(this.dp.slice(0, 3));
		const kids = parent ? ui.menu.getChildren(parent) : [];
		if (!kids.length) return;
		const ul = E('ul', { 'class': 'tabs', 'role': 'list' }, kids.map(k => {
			const on = (this.dp[3] === k.name);
			return E('li', { 'class': on ? 'is-active' : null },
				E('a', { 'href': L.url(this.dp[0], this.dp[1], this.dp[2], k.name), 'aria-current': on ? 'page' : null }, _(k.title)));
		}));
		host.appendChild(E('nav', { 'aria-label': _('Page sections') }, ul));
		host.hidden = false;
		document.body.classList.add('has-tabs');
		const cur = ul.querySelector('.is-active');
		if (cur && cur.scrollIntoView && host.scrollWidth > host.clientWidth) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
	},

	/* ---------------------------------------------------------- palette */

	buildIndex() {
		const idx = [];
		const walk = (node, path, trail, depth, catName) => {
			for (const k of ui.menu.getChildren(node)) {
				if (k.name === 'logout') continue;
				const p = path.concat(k.name);
				const title = _(k.title);
				const kids = ui.menu.getChildren(k);
				const cat = catName || k.name;
				/* a category with pages is not a destination of its own */
				if (!(depth === 1 && kids.length))
					idx.push({ title, trail: trail.join(' › '), url: L.url.apply(L, p), path: p.join('/'), icon: iconFor(cat, depth === 1 ? k.title : this.tree.children.admin.children[cat].title), depth });
				if (depth < 3 && kids.length) walk(k, p, trail.concat(title), depth + 1, cat);
			}
		};
		walk(this.tree.children.admin, [ 'admin' ], [], 1, null);
		this.index = idx;
	},

	score(q, entry) {
		const t = entry.title.toLowerCase(), full = `${entry.trail} ${entry.title}`.toLowerCase();
		const at = t.indexOf(q);
		if (at >= 0) return { s: 1000 - at * 5 - t.length + ((at === 0 || /\W/.test(t[at - 1])) ? 200 : 0) + (entry.depth === 2 ? 30 : 0), hit: [ at, at + q.length ] };
		if (full.indexOf(q) >= 0) return { s: 500 - full.length, hit: null };
		/* subsequence over the title, then over trail + title */
		const sub = (hay) => {
			let j = 0, gaps = 0, last = -1;
			const pos = [];
			for (let i = 0; i < hay.length && j < q.length; i++) {
				if (hay[i] === q[j]) { if (last >= 0) gaps += i - last - 1; last = i; pos.push(i); j++; }
			}
			return (j === q.length) ? { gaps, pos } : null;
		};
		const m = sub(t);
		if (m) return { s: 300 - m.gaps * 4 - t.length, pos: m.pos };
		const m2 = sub(full);
		if (m2) return { s: 100 - m2.gaps * 2 - full.length / 4, hit: null };
		return null;
	},

	highlight(title, res) {
		if (!res) return [ title ];
		if (res.hit) return [ title.slice(0, res.hit[0]), E('mark', {}, title.slice(res.hit[0], res.hit[1])), title.slice(res.hit[1]) ];
		if (res.pos) {
			const out = [], set = new Set(res.pos);
			let buf = '';
			for (let i = 0; i < title.length; i++) {
				if (set.has(i)) { if (buf) out.push(buf); buf = ''; out.push(E('mark', {}, title[i])); }
				else buf += title[i];
			}
			if (buf) out.push(buf);
			return out;
		}
		return [ title ];
	},

	setupPalette() {
		const root = document.getElementById('palette');
		const trigger = document.getElementById('palette-open');
		if (!root || !this.index) return;

		const input = E('input', {
			'type': 'search', 'class': 'palette-input', 'id': 'palette-input', 'role': 'combobox',
			'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list',
			'autocomplete': 'off', 'spellcheck': 'false', 'placeholder': _('Search pages and settings…'),
			'aria-label': _('Search pages')
		});
		const list = E('ul', { 'class': 'palette-list', 'id': 'palette-list', 'role': 'listbox', 'aria-label': _('Pages') });
		const status = E('p', { 'class': 'palette-empty', 'hidden': '' }, _('No matching pages'));
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', _('Search pages'));
		root.replaceChildren(
			E('div', { 'class': 'palette-backdrop' }),
			E('div', { 'class': 'palette-panel' }, [
				E('div', { 'class': 'palette-field' }, [ icon('search', 'palette-glass'), input, E('kbd', {}, 'Esc') ]),
				list, status,
				E('div', { 'class': 'palette-foot', 'aria-hidden': 'true' }, [
					E('span', {}, [ E('kbd', {}, '↑'), E('kbd', {}, '↓'), ' ', _('Navigate') ]),
					E('span', {}, [ E('kbd', {}, '↵'), ' ', _('Open') ]),
					E('span', {}, [ E('kbd', {}, 'Esc'), ' ', _('Close') ])
				])
			])
		);

		let results = [], sel = 0, lastFocus = null;

		const renderList = () => {
			const q = input.value.trim().toLowerCase();
			if (!q) {
				const recent = (JSON.parse(store('paper-recent') || '[]') || []).map(p => this.index.find(e => e.path === p)).filter(Boolean);
				const rest = this.index.filter(e => recent.indexOf(e) < 0);
				results = recent.map(e => ({ e, r: null, recent: true })).concat(rest.map(e => ({ e, r: null })));
			}
			else {
				results = this.index.map(e => ({ e, r: this.score(q, e) })).filter(x => x.r).sort((a, b) => b.r.s - a.r.s);
			}
			results = results.slice(0, 40);
			sel = 0;
			list.replaceChildren.apply(list, results.map((x, i) => {
				const li = E('li', {
					'role': 'option', 'id': `palette-opt-${i}`, 'class': 'palette-item', 'aria-selected': i === sel ? 'true' : 'false',
					'data-index': i
				}, [
					E('span', { 'class': 'palette-item-icon' }, icon(x.e.icon)),
					E('span', { 'class': 'palette-item-text' }, [
						E('span', { 'class': 'palette-item-title' }, this.highlight(x.e.title, x.r)),
						x.e.trail ? E('span', { 'class': 'palette-item-trail' }, x.e.trail) : ''
					]),
					x.recent ? E('span', { 'class': 'palette-tag' }, _('Recent')) : '',
					E('span', { 'class': 'palette-item-go' }, icon('enter'))
				]);
				return li;
			}));
			status.hidden = results.length > 0;
			list.hidden = results.length === 0;
			mark();
		};

		const mark = () => {
			list.querySelectorAll('.palette-item').forEach((li, i) => li.setAttribute('aria-selected', i === sel ? 'true' : 'false'));
			const cur = list.querySelector(`#palette-opt-${sel}`);
			if (cur) { input.setAttribute('aria-activedescendant', cur.id); cur.scrollIntoView({ block: 'nearest' }); }
			else input.removeAttribute('aria-activedescendant');
		};

		const go = (i) => {
			const x = results[i];
			if (x) window.location.href = x.e.url;
		};

		const openPalette = () => {
			if (!root.hidden) return;
			if (this.closeFlyout) this.closeFlyout(false);
			lastFocus = document.activeElement;
			root.hidden = false;
			document.body.classList.add('palette-open');
			input.value = '';
			renderList();
			input.focus();
		};
		const closePalette = () => {
			if (root.hidden) return;
			root.hidden = true;
			document.body.classList.remove('palette-open');
			if (lastFocus && lastFocus.focus) lastFocus.focus();
		};
		this.openPalette = openPalette;

		input.addEventListener('input', renderList);
		input.addEventListener('keydown', ev => {
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
				ev.preventDefault();
				if (!results.length) return;
				sel = (sel + (ev.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
				mark();
			}
			else if (ev.key === 'Enter') { ev.preventDefault(); go(sel); }
			else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePalette(); }
			else if (ev.key === 'Tab') ev.preventDefault();
		});
		list.addEventListener('mousemove', ev => {
			const li = ev.target.closest('.palette-item');
			if (li && +li.getAttribute('data-index') !== sel) { sel = +li.getAttribute('data-index'); mark(); }
		});
		list.addEventListener('click', ev => {
			const li = ev.target.closest('.palette-item');
			if (li) go(+li.getAttribute('data-index'));
		});
		root.querySelector('.palette-backdrop').addEventListener('click', closePalette);
		if (trigger) trigger.addEventListener('click', openPalette);

		document.addEventListener('keydown', ev => {
			const t = ev.target;
			const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
			const modal = document.body.classList.contains('modal-overlay-active');
			if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) {
				if (modal) return;
				ev.preventDefault();
				root.hidden ? openPalette() : closePalette();
			}
			else if (ev.key === '/' && !typing && !modal && !ev.ctrlKey && !ev.metaKey && !ev.altKey && root.hidden) {
				ev.preventDefault();
				openPalette();
			}
		});
	},

	rememberVisit() {
		const p = this.dp.join('/');
		if (!this.index || !this.index.find(e => e.path === p)) return;
		let recent = [];
		try { recent = JSON.parse(store('paper-recent') || '[]') || []; } catch (e) {}
		recent = [ p ].concat(recent.filter(x => x !== p)).slice(0, 4);
		store('paper-recent', JSON.stringify(recent));
	},

	/* ------------------------------------------------------- host / theme */

	renderHost(board) {
		const chip = document.getElementById('host-chip');
		if (!board || !chip) return;
		const host = board.hostname || '';
		const model = board.model || '';
		chip.replaceChildren(
			E('span', { 'class': 'host-dot', 'aria-hidden': 'true' }),
			E('span', { 'class': 'host-name' }, host),
			model ? E('span', { 'class': 'host-model' }, model) : ''
		);
		chip.setAttribute('title', [ host, model, board.release && board.release.description ].filter(Boolean).join(' · '));
		chip.hidden = !host;
		if (host) document.title = `${this.pageTitle || _('Overview')} · ${host}`;
	},

	setupTheme() {
		const btn = document.getElementById('theme-toggle');
		const html = document.documentElement;
		const names = { auto: _('Automatic'), light: _('Light'), dark: _('Dark') };
		const order = [ 'auto', 'light', 'dark' ];
		const apply = (pref) => {
			html.setAttribute('data-theme-pref', pref);
			html.setAttribute('data-darkmode', (pref === 'dark' || (pref === 'auto' && mqDark.matches)) ? 'true' : 'false');
			if (btn) {
				const next = order[(order.indexOf(pref) + 1) % order.length];
				btn.setAttribute('aria-label', `${_('Theme')}: ${names[pref]}. ${_('Switch to')} ${names[next]}`);
				btn.setAttribute('title', `${_('Theme')}: ${names[pref]}`);
			}
		};
		let pref = store('paper-theme') || 'auto';
		if (order.indexOf(pref) < 0) pref = 'auto';
		apply(pref);
		mqDark.addEventListener('change', () => apply(html.getAttribute('data-theme-pref') || 'auto'));
		if (btn) btn.addEventListener('click', () => {
			const cur = html.getAttribute('data-theme-pref') || 'auto';
			const next = order[(order.indexOf(cur) + 1) % order.length];
			store('paper-theme', next === 'auto' ? null : next);
			apply(next);
		});
	},

	/* ------------------------------------------------------- indicators */

	setupIndicators() {
		const host = document.getElementById('indicators');
		if (!host) return;
		const sync = () => {
			host.querySelectorAll('span[data-indicator]').forEach(el => {
				const text = el.textContent || '';
				const m = /^(.*?):\s*(\d+)\s*$/.exec(text);
				const label = m ? m[1] : text, count = m ? m[2] : null;
				if (el.getAttribute('data-label') !== label) el.setAttribute('data-label', label);
				if (count !== null) { if (el.getAttribute('data-count') !== count) el.setAttribute('data-count', count); }
				else if (el.hasAttribute('data-count')) el.removeAttribute('data-count');
				if (el.hasAttribute('data-clickable')) {
					if (el.getAttribute('role') !== 'button') {
						el.setAttribute('role', 'button');
						el.setAttribute('tabindex', '0');
						el.addEventListener('keydown', ev => {
							if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); }
						});
					}
				}
			});
		};
		new MutationObserver(sync).observe(host, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [ 'data-style', 'data-clickable' ] });
		sync();
	}
});
