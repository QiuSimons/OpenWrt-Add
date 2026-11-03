'use strict';
/* Station alias input (the only thing the dashboard writes): MAC
   normalisation, name length cap, control / invisible characters, and the
   uci change built from them (names.aliasOp). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const names = load('vantage.names');

const MAC = '00:00:5e:00:53:21';

test('MAC normalisation: notations and case give one key, junk gives null', () => {
	for (const v of [ '00:00:5E:00:53:21', '00-00-5e-00-53-21', '0000.5e00.5321', '00005E005321', '  00:00:5e:00:53:21\t' ])
		assert.equal(names.normMac(v), MAC, v);
	for (const v of [ '', '00:00:5e:00:53', '00:00:5e:00:53:21:00', '00:00:5e:00:53:2g', '00:00-5e:00:53:21',
		'00:00:5e:00:53:21\n; rm', '0:0:5e:0:53:21', null, undefined, 42, {}, [ MAC ] ])
		assert.equal(names.normMac(v), null, JSON.stringify(v));
});

test('validateAlias: whitespace is collapsed and trimmed, empty clears', () => {
	assert.deepEqual(names.validateAlias('  Hall   printer '), { ok: true, value: 'Hall printer' });
	assert.deepEqual(names.validateAlias('Hall  printer'), { ok: true, value: 'Hall printer' }, 'Unicode spaces');
	assert.deepEqual(names.validateAlias(''), { ok: true, value: '' });
	assert.deepEqual(names.validateAlias('   '), { ok: true, value: '' });
	assert.deepEqual(names.validateAlias(null), { ok: true, value: '' });
	assert.deepEqual(names.validateAlias(undefined), { ok: true, value: '' });
});

test('validateAlias: length cap counts code points, not UTF-16 units', () => {
	assert.equal(names.NAME_MAX, 48);
	assert.equal(names.validateAlias('x'.repeat(48)).ok, true);
	assert.equal(names.validateAlias('x'.repeat(49)).ok, false);
	assert.equal(names.validateAlias('\u{1F4FA}'.repeat(48)).ok, true, '48 astral characters are 96 code units');
	assert.equal(names.validateAlias('\u{1F4FA}'.repeat(49)).ok, false);
	assert.equal(names.validateAlias(' '.repeat(40) + 'x'.repeat(48) + ' '.repeat(40)).ok, true, 'trimmed before counting');
	assert.equal(names.validateAlias('x'.repeat(100000)).ok, false, 'huge input is refused early');
	assert.match(names.validateAlias('x'.repeat(49)).error, /longer than 48/);
});

test('validateAlias: control, invisible and bidi characters are rejected, not normalised', () => {
	const bad = [ 'a\u0000b', 'a\tb', 'a\nb', 'a\rb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u009fb',
		'evil‮txt', 'a​b', 'a‎b', 'a⁦b', 'a b', 'a﻿b', 'a­b',
		'a\ud800b', 'a\udc00b', '\udc00', '\ud83d' ];
	for (const v of bad) {
		const r = names.validateAlias(v);
		assert.equal(r.ok, false, JSON.stringify(v));
		assert.match(r.error, /invisible or control/);
	}
	assert.equal(names.validateAlias('\u{1F600} ok').ok, true, 'a valid surrogate pair');
	assert.equal(names.validateAlias('Café über 中文').ok, true);
	assert.equal(names.validateAlias('<img src=x onerror=alert(1)>').ok, true, 'markup is plain text; it is only ever rendered as a text node');
});

test('validateAlias: non-strings are refused', () => {
	for (const v of [ 42, true, {}, [ 'a' ], () => 'a' ]) assert.equal(names.validateAlias(v).ok, false, String(v));
});

test('aliasOp: add with a normalised MAC and a valid icon only', () => {
	assert.deepEqual(names.aliasOp(null, '00-00-5E-00-53-21', '  TV  ', 'tv'),
		{ ok: true, op: 'add', values: { mac: MAC, name: 'TV', icon: 'tv' } });
	assert.deepEqual(names.aliasOp(null, MAC, 'TV', 'rocket'),
		{ ok: true, op: 'add', values: { mac: MAC, name: 'TV' } }, 'unknown icon dropped');
	assert.deepEqual(names.aliasOp(null, MAC, 'TV', null), { ok: true, op: 'add', values: { mac: MAC, name: 'TV' } });
});

test('aliasOp: set and delete on an existing section, nothing to do without one', () => {
	const ex = { sid: 'cfg0a1b2c', name: 'Old', icon: 'tv' };
	assert.deepEqual(names.aliasOp(ex, MAC, 'New', 'phone'), { ok: true, op: 'set', sid: 'cfg0a1b2c', values: { name: 'New', icon: 'phone' } });
	assert.deepEqual(names.aliasOp(ex, MAC, 'New', 'bogus'), { ok: true, op: 'set', sid: 'cfg0a1b2c', values: { name: 'New', icon: '' } });
	assert.deepEqual(names.aliasOp(ex, MAC, '  ', null), { ok: true, op: 'delete', sid: 'cfg0a1b2c' });
	assert.deepEqual(names.aliasOp(null, MAC, '', null), { ok: true, op: 'none' });
});

test('aliasOp: invalid MAC, name or section id never reaches uci', () => {
	for (const mac of [ 'nope', '', null, '01:00:5e:00:53:21', 'ff:ff:ff:ff:ff:ff' ]) {
		const r = names.aliasOp(null, mac, 'TV', 'tv');
		assert.equal(r.ok, false, String(mac));
		assert.equal(r.op, undefined);
	}
	assert.equal(names.aliasOp(null, MAC, 'a\nb', 'tv').ok, false);
	assert.equal(names.aliasOp(null, MAC, 'x'.repeat(49), 'tv').ok, false);
	for (const sid of [ '', 'a b', 'x;y', '@client[0]', 'x'.repeat(65), 5, null ])
		assert.equal(names.aliasOp({ sid: sid }, MAC, 'TV', 'tv').ok, false, String(sid));
});

test('aliasMap: stored names go through the same validation', () => {
	const m = names.aliasMap([
		{ '.type': 'client', '.name': 'a', mac: '00:00:5E:00:53:01', name: 'Good' },
		{ '.type': 'client', '.name': 'b', mac: '00:00:5e:00:53:02', name: 'tab\there' },
		{ '.type': 'client', '.name': 'c', mac: '00:00:5e:00:53:03', name: [ 'list' ] },
		{ '.type': 'client', '.name': 'd', mac: '00:00:5e:00:53:04', name: 'y'.repeat(49) },
		{ '.type': 'client', '.name': 'e', mac: 'bogus', name: 'No MAC' }
	]);
	assert.deepEqual(Object.keys(m), [ '00:00:5e:00:53:01' ]);
});
