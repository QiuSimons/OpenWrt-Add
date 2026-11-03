'use strict';
'require baseclass';
'require dom';
'require ui';
/* Self-test fixture for check_dom_sinks.js: safe patterns that must pass. */

var SVGNS = 'http://www.w3.org/2000/svg';
var ICO = { wifi: '<svg viewBox="0 0 1 1"></svg>', ap: '<svg></svg>' };
var re = /['"`]<\/?b>[/]/g, ratio = 10 / 2 / 1;

function signalBars(n) {
	var bars = [];
	for (var i = 0; i < n; i++) bars.push(E('i'));
	return E('span', { 'class': 'bars' }, bars);
}

return baseclass.extend({
	icons: { cpu: '<svg><polyline points="1 2"/></svg>' },

	svg: function(markup) {
		if (markup.indexOf('xmlns') < 0)
			markup = markup.replace('<svg', '<svg xmlns="' + SVGNS + '"');
		var doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
		return document.importNode(doc.documentElement, true);
	},

	panel: function(icon, title, body, tools) {
		var head = E('div', { 'class': 'head' }, [ this.svg(icon), E('h3', {}, [ title ]),
			tools ? E('div', { 'class': 'tools' }, tools) : '' ]);
		return E('section', {}, [ head ].concat(body));
	},

	render: function(clients, host) {
		var self = this, $ = {}, links = [];
		$.chartY = [ E('span'), E('span') ];
		var defs = [ { t: 'Wireless', i: ICO.wifi }, { t: 'AP', i: ICO.ap } ];
		this.defs = defs;
		defs.forEach(function(a) { links.push(E('a', {}, [ self.svg(a.i), a.t ])); });
		var rows = clients.map(function(c) {
			return E('tr', {}, [ E('td', {}, [ c.name ]), E('td', {}, [ signalBars(c.bars) ]) ]);
		});
		var el = E('div');
		el.innerHTML = '';
		el.textContent = host;
		dom.content(el, rows);
		dom.append(el, E('p', {}, [ host ]));
		L.dom.content(el, null);
		setTimeout(function() { el.hidden = true; }, 10);
		window.setTimeout(L.bind(this.render, this), 10);
		return E('div', { 'class': 'root', 'click': function() {} }, [
			this.panel(ICO.wifi, 'Clients', [ E('table', {}, rows) ], [ E('button', {}, [ 'x' ]) ]),
			this.panel(ICO.ap, 'Links', [ E('div', { 'class': 'links' }, links) ], null),
			this.panel(ICO.ap, 'Y', [ E('div', {}, $.chartY) ]),
			E('div', {}, clients.filter(function(c) { return c.up; }).map(function(c) { return E('b', {}, [ c.ssid ]); })),
			E('ul', {}, host ? [ E('li', {}, [ host ]) ] : null),
			E('span', {}, /* dom-safe: fixture exercises the annotation escape hatch */ host),
			E('svg', { 'viewBox': '0 0 1 1' }, [ E('polyline', { 'points': '1 2' }) ]),
			E('p', null),
			document.createElementNS(SVGNS, 'svg'),
			new DOMParser().parseFromString('<svg xmlns="' + SVGNS + '"/>', 'image/svg+xml').documentElement
		]);
	},

	status: function(name) { return this.svg(this.icons[name]); },

	/* cross-method member writes that are all safe */
	paint() { if (!this.cell) this.cell = E('span'); return E('div', {}, this.cell); },
	setCell(c) { this.cell = E('b', {}, [ c.name ]); },

	/* array of records built with push, read through forEach and an index */
	results: null,
	crumbs: function(tree) {
		var crumbs = [];
		tree.forEach(function(n) { crumbs.push({ title: n.title, url: L.url.apply(L, n.path) }); });
		return crumbs.map(function(c) { return E('a', { 'href': c.url }, [ c.title ]); });
	},
	collect: function() { var out = []; out.push({ url: L.url('admin') }); return out; },
	fill: function() {
		var self = this;
		this.results = this.collect().filter(function(r) { return r.url; }).slice(0, 40);
		this.results.forEach(function(r) { E('a', { 'href': r.url }); });
		document.addEventListener('keydown', function() {
			var r = self.results && self.results[0];
			if (r) window.location.href = r.url;
		});
	}
});

function link(p) { try { return L.url(p); } catch (e) { return '/cgi-bin/luci/' + p; } }
function go() {}

function goodAttrs(el, c) {
	var mk = E, map = {}, $ = {}, bars = [];
	for (var i = 0; i < 4; i++) bars[i] = E('i');
	map[c.key] = c.value;
	$['chart-' + c.k] = E('i');
	el.setAttribute('href', L.url('admin'));
	el.setAttribute('class', c.name);
	el.setAttribute('onclick', 'return false');
	el.onclick = function() {};
	el.onload = null;
	el.href = '#top';
	setTimeout(go, 10);
	setTimeout(L.bind(go, null), 10);
	ui.showModal(_('Title'), [ E('p', {}, [ c.name ]) ]);
	ui.addNotification(null, E('p', {}, [ c.msg ]));
	return [
		mk('div', {}, [ c.name ]),
		E('a', { 'href': '#' }, [ 'x' ]),
		E('a', { 'href': 'https://openwrt.org/' }, [ 'x' ]),
		E('a', { 'href': L.url('admin') }, [ 'x' ]),
		E('a', { 'href': L.url.apply(L, [ 'admin', 'status' ]) }),
		E('a', { 'href': '/cgi-bin/luci/' + c.path }),
		E('a', { 'href': link(c.path) }),
		E('button', { 'onclick': function() { go(); } }),
		E('button', { 'onclick': (ev) => ev.preventDefault() }),
		E('button', { 'click': L.bind(go, null), 'onmouseover': go }),
		E('i', { 'style': 'width:' + (c.pct / 100).toFixed(1) + '%' }),
		E('i', { 'style': 'color:red', 'title': c.name, 'data-mac': c.mac }),
		E('div', {}, bars)
	];
}

/* Legitimate patterns next to the re-review rules (tags, attribute case,
   SVG animation, reflection, timers). */
function goodBypassNeighbours(el, c) {
	var opts = {}, spec = Object.assign({}, c.spec);
	Reflect.set(opts, c.k, c.v);
	Object.defineProperty(el, 'hidden', { value: true });
	Object.assign(el, { className: 'x', title: 'y' });
	Object.assign(opts, c.more);
	el.setAttribute('to', '1');
	el.setAttribute('attributeName', 'opacity');
	el.setAttribute('Data-Key', c.key);
	setTimeout.call(window, go, 10);
	setTimeout.apply(null, [ go, 10 ]);
	window.setInterval.call(window, function() {}, 10);
	if (typeof setTimeout === 'function') go();
	return [
		E('span', { 'data-key': c.key, 'data-band': c.band, 'DATA-MAC': c.mac, 'dataset': c.x }),
		E('SPAN', { 'Class': c.cls, 'TITLE': c.name }, [ c.name ]),
		E('img', { 'SRC': '/luci-static/x.png', 'srcset': '/a.png 1x, /b.png 2x' }),
		E('a', { 'HREF': L.url('admin') }),
		E('svg', {}, [ E('animate', { 'attributeName': 'opacity', 'from': '0', 'to': '1', 'dur': '2s', 'values': '0;1', 'begin': 0 }) ]),
		document.createElement('div'),
		document.createElementNS(SVGNS, 'path'),
		spec
	];
}

/* CSS, selectors, regular expressions and history URLs: safe forms */
function goodCss(el, n, x, sheet) {
	el.style.width = n.toFixed(1) + '%';
	el.style.cssText = 'display:none';
	el.style.setProperty('--h', (n * 2).toFixed(0));
	el.style['--x'] = '1px';
	Object.assign(el.style, { width: '1px', height: n.toFixed(0) + 'px' });
	fetch(L.resource('x/app.css')).then(function(r) { return r.text(); }).then(function(text) { sheet.replaceSync(text); });
	fetch(L.resource('x/app.css') + '?v=' + L.env.resource_version).then(function(r) { return r.text(); }).then(function(text) { sheet.replaceSync(text); });
	fetch(L.resource('x/app.css'), { cache: 'no-cache', 'credentials': 'same-origin' }).then(function(r) { return r.text(); }).then(function(text) { sheet.replaceSync(text); });
	sheet.insertRule('.a { color: red }');
	el.querySelector('div[id="graph"]');
	el.querySelector('[data-mac="' + CSS.escape(x) + '"]');
	el.closest('.row');
	new RegExp('^a+$');
	history.replaceState(null, '', '#client=' + encodeURIComponent(x));
	history.replaceState(null, '', location.pathname + location.search);
	this.matches(x);
	el.animate([ { opacity: 0 }, { opacity: 1 } ], 200);
	el.animate({ opacity: [ 0, 1 ], transform: [ 'none', 'scale(' + n.toFixed(2) + ')' ] }, { duration: n * 10, iterations: Infinity, easing: 'linear' });
	el.animate(flowFrames([ [ n, n ] ]), { duration: 300, delay: -n / 2, fill: 'both' });
	el.animate([ { opacity: 0 } ], (x, n * 2));
}

/* keyframes built in a loop from numbers */
function flowFrames(pts) {
	var frames = [];
	pts.forEach(function(p) { frames.push({ transform: 'translate(' + p[0].toFixed(1) + 'px, ' + p[1].toFixed(1) + 'px)' }); });
	return frames;
}
