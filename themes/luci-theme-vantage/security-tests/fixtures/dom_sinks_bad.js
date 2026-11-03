'use strict';
'require baseclass';
'require dom as d';
'require ui';
/* Self-test fixture for check_dom_sinks.js: every line marked
   expect-violation must be reported, and no other line may be. */

var ICO = { a: '<svg></svg>' };
var MUT = { a: '<svg></svg>' };
var re = /['"`]<\/?b>/g, half = 10 / 2;

function wrap(v) { return E('div', {}, v); } // expect-violation
function wrapIndirect(v) { return E('p', {}, v); } // expect-violation
function svg(markup) { return new DOMParser().parseFromString(markup, 'image/svg+xml'); } // expect-violation

function bad(el, c, x, dom, host) {
	E('td', {}, c.name); // expect-violation
	E('div', c.name); // expect-violation
	E('<span>' + x + '</span>'); // expect-violation
	E('<b>'); // expect-violation
	E(x, {}, []); // expect-violation
	E('div', {}, 'literal text'); // expect-violation
	E('div', {}, [ 'a' ].join('')); // expect-violation
	E('div', {}, 'x' + x); // expect-violation
	E('div', {}, x.name || []); // expect-violation
	E('div', {}, `${E('td', {}, x)}`); // expect-violation
	E('a', { 'onclick': 'go(1)' }, [ 'x' ]); // expect-violation
	dom.content(el, x); // expect-violation
	dom.append(el, c.label); // expect-violation
	L.dom.content(el, '<i>' + x + '</i>'); // expect-violation
	dom.create('<div>' + x + '</div>'); // expect-violation
	dom.parse(x); // expect-violation
	el['innerHTML'] = x; // expect-violation
	el["outerHTML"] = x; // expect-violation
	el.innerHTML = x; // expect-violation
	el.innerHTML += ''; // expect-violation
	el.innerHTML = '<b>' + x; // expect-violation
	el.outerHTML = `<p>${x}</p>`; // expect-violation
	el.srcdoc = x; // expect-violation
	Object.assign(el, {innerHTML: x}); // expect-violation
	el.insertAdjacentHTML('beforeend', x); // expect-violation
	document.createRange().createContextualFragment(x); // expect-violation
	document.write(x); // expect-violation
	eval(x); // expect-violation
	new Function('return ' + x); // expect-violation
	setTimeout('tick(' + x + ')', 10); // expect-violation
	setInterval('tick()', 10); // expect-violation
	new DOMParser().parseFromString(x, 'text/html'); // expect-violation
	var html = '<p>' + host + '</p>';
	new DOMParser().parseFromString(html, 'text/html'); // expect-violation
	var kids = [ c.name ];
	kids = c.name;
	E('div', {}, kids); // expect-violation
	var list = [];
	list += x;
	E('div', {}, list); // expect-violation
	MUT.a = x;
	new DOMParser().parseFromString(MUT.a, 'image/svg+xml');  // expect-violation
	var defs = [ { i: ICO.a } ];
	defs.push({ i: host.icon });
	defs.forEach(function(d) {
		new DOMParser().parseFromString(d.i, 'image/svg+xml'); // expect-violation
	});
	E('div', {}, /* dom-safe: */ x); // expect-violation
	wrap(host.name);
	[ 1 ].forEach(wrapIndirect);
	svg(ICO.a);
	svg(host.icon);
}

/* SEC-002 re-review: each of these was accepted by the previous checker. */
function badAttrs(el, c, x, host) {
	E('a', {'href': c.name}, ['open']); // expect-violation
	E('img', {'src': x}); // expect-violation
	E('form', {'action': 'javascript:go()'}); // expect-violation
	E('a', {'href': ' JavaScript:go()'}); // expect-violation
	E('button', {'formaction': c.url}); // expect-violation
	E('a', {'xlink:href': x}); // expect-violation
	E('a', {'href': x + '/path'}); // expect-violation
	E('a', {'href': '//' + x}); // expect-violation
	E('div', {'style': c.style}); // expect-violation
	E('div', {'style': 'color:' + x}); // expect-violation
	var h = c.name; E('div', {'onclick': h}, []); // expect-violation
	E('div', {'onmouseover': 'go()'}); // expect-violation
	E('div', {'onfocus': [ x ]}); // expect-violation
	E('div', {['on' + 'click']: c.name}, []); // expect-violation
	E('div', {...c.attrs}, []); // expect-violation
	var href = c.url; E('a', {href}, []); // expect-violation
	var mk = E; mk('div', {}, c.name); // expect-violation
	[ 1 ].map(E); // expect-violation
	E.call(null, 'div', {}, x); // expect-violation
	var ct = dom.content; ct(el, x); // expect-violation
	d.content(el, c.name); // expect-violation
	d.append(el, x); // expect-violation
	d.create('div', {}, x); // expect-violation
	someFn(dom); // expect-violation
	dom['content'](el, x); // expect-violation
	ui.showModal('t', c.name); // expect-violation
	ui.showModal(c.title, [ 'x' ]); // expect-violation
	ui.addNotification(null, c.name); // expect-violation
	L.ui.addTimeLimitedNotification(null, x, 5000); // expect-violation
	L.showModal(null, x); // expect-violation
	ui.itemlist(el, [ c.label, c.value ]); // expect-violation
	cbi_update_table(el, [ [ c.name ] ]); // expect-violation
	cbi_update_table(el, rowsOf(c)); // expect-violation
	el.setAttribute('onclick', x); // expect-violation
	el.setAttribute('href', c.url); // expect-violation
	el.setAttribute('src', x); // expect-violation
	el.setAttribute('action', x); // expect-violation
	el.setAttribute('formaction', x); // expect-violation
	el.setAttribute(x, 'y'); // expect-violation
	el.setAttributeNS(null, 'href', x); // expect-violation
	dom.attr(el, 'onclick', x); // expect-violation
	dom.attr(el, { href: x }); // expect-violation
	el.href = c.url; // expect-violation
	el.src = x; // expect-violation
	el.action = x; // expect-violation
	el['href'] = x; // expect-violation
	el.onclick = 'go()'; // expect-violation
	el.onload = x; // expect-violation
	window.location = x; // expect-violation
	location.href = 'javascript:void(0)'; // expect-violation
	location.assign(x); // expect-violation
	window.open(c.url); // expect-violation
	var code = c.name; setTimeout(code, 10); // expect-violation
	setInterval(c.fn, 10); // expect-violation
	window['eval'](x); // expect-violation
	globalThis.eval(x); // expect-violation
	(0, eval)(x); // expect-violation
	window['Function']('return 1'); // expect-violation
	[].constructor.constructor(x)(); // expect-violation
	el['inner' + 'HTML'] = x; // expect-violation
	el[c.prop] = x; // expect-violation
	document['wri' + 'te'](x); // expect-violation
	var name = [ 'x' ]; ({name} = c); E('div', {}, name); // expect-violation
	var n = [ 'x' ]; for (n of c.list) {} E('div', {}, n); // expect-violation
	var [z] = [ c.name ]; E('div', {}, z); // expect-violation
	E('a', {'href': 'javascript\x3ago()'}); // expect-violation
	E('a', {'href': 'java\tscript:go()'}); // expect-violation
	el['inner\x48TML'] = x; // expect-violation
	window['ev\u0061l'](x); // expect-violation
	el.onmouseover = c.name; // expect-violation
	var links = [ { u: '#' } ];
	links.push({ u: host.url });
	links.forEach(function(l) { E('a', { href: l.u }); }); // expect-violation
}
function dflt(a, v = document.title) { return E('p', {}, v); } // expect-violation
function destr({ name }) { return E('p', {}, name); } // expect-violation
dflt(1);
destr({ name: [ 'x' ] });

var Cell = baseclass.extend({
	paint() { if (!this.cell) this.cell = E('span'); return E('div', {}, this.cell); }, // expect-violation
	setHost(c) { this.cell = c.name; }
});

var View = baseclass.extend({
	render() { var $ = this.$ = {}; $.list = [ E('i') ]; return E('div', {}, $.list); }, // expect-violation
	update(c) { var $ = this.$; $.list = c.name; },
	later(c) { var $ = this.$; $[c.key] = c.name; return E('div', {}, $.list2); } // expect-violation
});

/* Re-review (tag / case / reflection / timer / import bypasses): each of
   these produced no finding in the previous checker, or is kept here as a
   regression guard for attribute-name case handling. */
function badBypass(el, c, x, doc) {
	E('script', {}, [ c.name ]); // expect-violation
	E('style', {}, [ x ]); // expect-violation
	E('SCRIPT'); // expect-violation
	d.create('Style', {}, [ 'b{}' ]); // expect-violation
	E('svg:script', {}, [ x ]); // expect-violation
	E('iframe', { 'src': '/x' }); // expect-violation
	E('base', { 'href': '/' }); // expect-violation
	var s = document.createElement('script'); s.textContent = x; s.text = x; s.innerText = x; // expect-violation
	document.createElement('SCRIPT').src = '/a.js'; // expect-violation
	document.createElementNS('http://www.w3.org/2000/svg', 'script'); // expect-violation
	document.createElement(c.tag); // expect-violation
	E('div', { 'ONCLICK': c.name }); // expect-violation
	E('div', { 'OnMouseOver': 'go()' }); // expect-violation
	el.setAttribute('ONCLICK', x); // expect-violation
	el.setAttributeNS(null, 'foo:onclick', x); // expect-violation
	E('a', { 'HREF': c.url }); // expect-violation
	E('img', { 'SRC': x }); // expect-violation
	E('embed', { 'SRC': x }); // expect-violation
	E('object', { data: x }); // expect-violation
	E('video', { 'POSTER': x }); // expect-violation
	E('img', { 'srcset': x }); // expect-violation
	E('a', { 'Ping': x }); // expect-violation
	el.setAttribute('XLINK:HREF', x); // expect-violation
	E('div', { 'STYLE': c.style }); // expect-violation
	E('animate', { 'attributeName': 'href', 'to': x }); // expect-violation
	E('set', { 'attributeName': 'href', 'to': 'javascript:go()' }); // expect-violation
	E('animate', { 'attributeName': c.attr, 'to': '1' }); // expect-violation
	E('animateMotion', { 'values': '/a;javascript:go()' }); // expect-violation
	E('animateTransform', { 'from': x }); // expect-violation
	el.setAttribute('to', x); // expect-violation
	el.setAttribute('values', 'javascript:go()'); // expect-violation
	el.setAttribute('attributeName', x); // expect-violation
	dom.attr(el, 'from', x); // expect-violation
	el.setHTMLUnsafe(x); // expect-violation
	Document.parseHTMLUnsafe(x); // expect-violation
	document.parseHTMLUnsafe('<p>' + x + '</p>'); // expect-violation
	var sh = el.setHTMLUnsafe; // expect-violation
	el['setHTMLUnsafe'](x); // expect-violation
	Reflect.set(el, c.k, x); // expect-violation
	Reflect.set(el, 'href', x); // expect-violation
	Reflect.defineProperty(el, c.k, { value: x }); // expect-violation
	Object.defineProperty(el, 'outerHTML', { value: x }); // expect-violation
	Object.defineProperty(el, c.k, { value: x }); // expect-violation
	Object.defineProperties(el, { src: { value: x } }); // expect-violation
	Object.defineProperties(el, c.props); // expect-violation
	Object.assign(el, { href: x }); // expect-violation
	Object.assign(el, c.attrs); // expect-violation
	window.setTimeout.call(window, x, 1); // expect-violation
	setTimeout.apply(null, [ x ]); // expect-violation
	setTimeout.apply(null, c.args); // expect-violation
	setInterval.call(null, 'tick()', 10); // expect-violation
	setTimeout.bind(null)(x, 1); // expect-violation
	var st = setTimeout; // expect-violation
	[ x ].forEach(setInterval); // expect-violation
	Reflect.apply(setTimeout, null, [ x ]); // expect-violation
	import(x); // expect-violation
	import('/luci-static/resources/x.js'); // expect-violation
	new Worker(x); // expect-violation
	doc.execCommand('insertHTML', false, x); // expect-violation
}

/* CSS, selectors, regular expressions and history URLs from data */
function badCss(el, x, sheet, doc) {
	el.style.cssText = x; // expect-violation
	el.style.color = x; // expect-violation
	el.style.backgroundImage = 'url(' + x + ')'; // expect-violation
	el.style = x; // expect-violation
	el.style[x] = x.v; // expect-violation
	el.style.setProperty('background', 'url(' + x + ')'); // expect-violation
	el.style.setProperty(x, '1px'); // expect-violation
	Object.assign(el.style, { color: x }); // expect-violation
	Object.assign(el.style, x); // expect-violation
	new CSSStyleSheet().replaceSync(x); // expect-violation
	sheet.insertRule(x); // expect-violation
	fetch(x).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css')).then(function(t) { t = x; sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css'), { cache: x }).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css'), opts).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + x).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '?v=' + x).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '?v=' + L.env.base_url).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '/../evil?v=' + L.env.resource_version).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '?v=' + L.env.resource_version + x).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '?v=' + L.env.resource_version.x).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '?v=' + M.env.resource_version).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css') + '?v=' + L.env.resource_version, { cache: x }).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	fetch(L.resource('a.css'), { cache: 'no-cache' }, x).then(function(t) { sheet.replaceSync(t); }); // expect-violation
	doc.querySelector('[data-mac="' + x + '"]'); // expect-violation
	el.closest(x); // expect-violation
	el.matches(x.sel); // expect-violation
	document.querySelectorAll(`[id=${x}]`); // expect-violation
	new RegExp(x); // expect-violation
	/* Web Animations keyframes are CSS too */
	el.animate([ { backgroundImage: 'url(' + x + ')' } ], 300); // expect-violation
	el.animate(x, 300); // expect-violation
	el.animate({ color: [ 'red', x ] }, 300); // expect-violation
	el.animate([ { opacity: 0 }, x ], 300); // expect-violation
	el.animate([ { opacity: 0 } ], { duration: 300, easing: x }); // expect-violation
	el.animate([ { opacity: 0 } ], x); // expect-violation
	el.animate([ { backgroundImage: (x * 0, x) } ], 300); // expect-violation
	el.animate([ { opacity: 0 } ], (x * 0, x)); // expect-violation
	el.style.color = (x - 1, x); // expect-violation
	var kf = [];
	kf.push({ transform: x });
	el.animate(kf, 300); // expect-violation
	RegExp('^' + x + '$'); // expect-violation
	history.pushState(null, '', x); // expect-violation
	history.replaceState(null, '', 'javascript:' + x); // expect-violation
}
