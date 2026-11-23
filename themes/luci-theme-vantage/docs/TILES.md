# Provider tiles (experimental)

Another package can put a read-only tile of its own on the Vantage
dashboard. It answers one ubus call with data; the dashboard checks the
answer and draws it, as text, in its own look. Nothing of the package
runs in the browser. Since 1.2.0
([#129](https://github.com/anothaDev/luci-theme-vantage/issues/129)).

This page is for people who write such a package (a provider). The
dashboard's side is in the spec, [Provider tiles](SPEC.md#provider-tiles-experimental).

## Experimental

Everything on this page may change in any release, without notice
beyond the changelog, until the project says otherwise here and in
[`CHANGELOG.md`](../CHANGELOG.md): the object and group names, the
method, the fields and their limits, the layout ids and the number of
tiles. A dashboard of another version may draw your answer differently
or not at all. Read the changelog before you upgrade, and keep your
provider small so that it is easy to follow.

The dashboard's own tiles (their ids, sizes, order and defaults) are
not part of the contract at all.

## What a provider ships

Two files, usually in a LuCI-style package of its own:

- **A ubus object `vantage.tile.<id>`** with one method, **`status`**,
  which takes no arguments, changes nothing and answers the data below.
  `<id>` is 1 to 7 letters `a` to `z` (`dns`, `sqm`, `modem`); it is
  what the tile is known by, and it is shown on the tile. The natural
  form is an rpcd ucode plugin, `/usr/share/rpcd/ucode/vantage.tile.<id>`
  (needs `rpcd-mod-ucode`), but any ubus object of that name works.
- **An rpcd ACL group `vantage-tile-<id>`**, in
  `/usr/share/rpcd/acl.d/vantage-tile-<id>.json`, that grants
  `vantage.tile.<id>` `status` to read, by name, and nothing else.

The dashboard's own permissions never grant a provider's call. It
learns which providers a login may ask from that login's own ACL (rpcd's
`session access` without an object, once a page) and asks only an
object named exactly `vantage.tile.<id>` with `status` granted by name.
A grant by pattern (`vantage.tile.*`, or `*` as the method) shows no
tile. root holds every group. Another login holds yours only where its
entry in `/etc/config/rpcd` lists it (`list read 'vantage-tile-dns'`),
and needs the dashboard's own `luci-app-vantage` group to see the
dashboard at all.

After installing, rpcd has to load the plugin and the group
(`service rpcd reload`; LuCI packages do this when they are installed),
and the dashboard reads them when it is next opened or reloaded.

## The answer

`status` returns one object. Unknown keys are left out, so do not count
on them; an item that is not of the form below is left out alone. An
answer without `v: 1` or without a title is no answer: the tile says
"Sent a report that could not be read".

```
{ v: 1, title, icon?, state?, note?, every?, page?, items: [ item ] }
item: { label, value | text, unit?, rate?, max?, level?, trend? }
```

| Field | What it may be | What the dashboard does with it |
|---|---|---|
| `v` | `1` | Required. |
| `title` | text, 1 to 32 characters | Required. The tile's name, looked up in LuCI's catalogues. |
| `icon` | `pulse`, `globe`, `signal`, `port`, `lock`, `cpu`, `memory`, `disk`, `router`, `wifi` or `users` | The dashboard's own drawing of that name in the head; anything else is `pulse`. |
| `state` | `ok`, `warn`, `err` or `off` | A dot in the head: green, amber, red or grey, with "Warning" or "Error" for screen readers. Never one of the dashboard's health checks, and never the mark in the page title. |
| `note` | text, up to 64 characters | One line under the head, looked up in LuCI's catalogues. |
| `every` | a whole number of seconds, 5 to 300 | How often your data changes: the dashboard asks again no sooner than that after it last asked, at the first slow poll after that. Without it, with every slow poll. |
| `page` | a LuCI page by its menu path: `admin` and 1 to 4 more steps of `A-Z a-z 0-9 _ -`, up to 32 characters each (`admin/network/dhcp`) | A link in the head, named with LuCI's own title for that page, only where this login's menu has the page. |
| `items` | a list | At most 8 are shown, of the first 32 looked at. |

| Item field | What it may be | What the dashboard does with it |
|---|---|---|
| `label` | text, 1 to 32 characters | Required; one item a label (the first, compared without case). Looked up in LuCI's catalogues. |
| `value` | a number between −10¹⁵ and 10¹⁵ | Written out by its unit, in the dashboard's own formats. |
| `text` | text, up to 48 characters | Instead of a value: shown as it came, not translated (it is a value, such as an operator's name). |
| `unit` | `''` (a count), `%`, `ms`, `s` (a duration), `dBm`, `dB`, `MHz`, `B` (bytes) or `bit/s` | `''` if left out; any other unit drops the item. `bit/s` follows the speed unit picked under Appearance. |
| `rate` | `true` | The value is a counter (0 or more, unit `''` or `B`): the tile shows its rate between two answers, `/s` for a count and traffic for bytes. |
| `max` | a number above 0 | A thin meter, value of max. Not with `rate`. |
| `level` | `ok`, `warn`, `err` or `off` | The value's colour: amber for `warn`, red for `err`, grey for `off`; `warn` and `err` also as a word for screen readers. |
| `trend` | `true` | The page keeps this value (5 minutes) and draws a small line of it, from its lowest to its highest value in that time. Values only. |

Text is cut to its length with an ellipsis. Control characters, the
bidirectional controls and a list of characters that show nothing (the
zero-width space, the word joiner, the soft hyphen, the Hangul fillers,
tag characters and others) are replaced with `�`. Not every such
character is: the joiners and variation selectors that scripts and
emoji need (U+200C, U+200D, U+FE0E, U+FE0F, U+E0100 to U+E01EF) stay,
so two labels can still look alike. A title, note, label or text with
nothing to see counts as none: it needs a letter, a digit, punctuation
or a symbol other than U+2800. Numbers come out as
the dashboard writes its own: `12 345`, `85%`, `23.5 ms`, `1d 1h`,
`−97 dBm`, `4.5 dB`, `1800 MHz`, `1.50 KiB`, `2.5 Mbit/s`, a fraction
with three digits. There is no way to send markup, a style, a colour,
a script or a link of your own: whatever you put in a text is shown as
those characters.

## How the dashboard asks

- Once a page it reads the login's ACL (again at the next slow poll
  only where the read failed). With no provider granted, that is the
  only thing it does: no other call, no tile.
- At most three providers a page, the first three by id. A fourth is
  not asked and has no tile, without a word.
- It asks with the slow part of its poll (every 5 s; every 30 s on a
  Low-power router), never sooner than `every` after it last asked, in
  a request of its own, and waits for the answer 2 s at most. An answer
  still out is not asked again beside itself; it shows when it comes.
- An answer that took over half a second makes it wait ten times as
  long before it asks again, four minutes at most: rpcd runs a ucode
  method inside its own process and answers nobody else meanwhile. A
  call that was out over 30 s (the computer slept) makes no wait.
- A first answer that says the object is not there (not found, access
  denied) means no tile on that page. An object that goes away later is
  asked once a minute; its last answer stays for that minute, then the
  tile says "Did not answer in time". Any other failure says the same,
  and makes it wait: 10 s, then twice as long after each further
  failure, four minutes at most, until an answer comes.
- A tile hidden under Customize is not asked after its first answer
  (before it, as above).

## How the tile looks

The dashboard draws the tile with its own parts: the icon and name,
then **your id in a small tag** (the look of a client's name source in
the Clients list), so that no provider passes for one of the
dashboard's tiles. Under Customize, and for screen readers, the tile is
"title (id)". The tag comes from the object's name, never from your
answer. Then the dot and the link, the note, and the items in a grid,
each a label over its value with its meter or its line.

The tile is laid out like the others, as `x<id>` (`xdns`): one column
wide at the end of the right-hand column by default, moved, resized or
hidden under Customize, and saved with the layout. A provider that is
not answering keeps its place in a saved layout. Before the first
answer the tile says "Waiting for its first report".

**Translations.** Write the title, the note and the labels in English
and ship a LuCI catalogue for them (`luci-i18n-<your package>-<lang>`,
built from a `po/` directory as LuCI apps have, its `msgid`s your
English texts); the dashboard looks them up in every catalogue LuCI
loads for the language. Where none has a string, it shows in English.
Numbers and units are the dashboard's own and need nothing.

So the title, the note and the labels are for fixed words. LuCI finds
a translation by a 32-bit hash of the text alone, without comparing the
text, so a text that changes with your data (a count, a name, an
address) is looked up anew with every answer and may, rarely, come out
as the translation of some other string. A label is also how the tile
knows an item from one answer to the next (its rate and its line): a
label that changes starts the item over. Data goes in a value, or in
`text`, which is shown as it came.

## A complete example

`dev/replay/tiles/` holds an example provider: the DNS numbers dnsmasq
keeps, from its ubus `metrics`. `tests/tiles.test.js` runs it with ucode
(where `$UCODE` points at a host ucode binary) against made-up metrics,
holds its answers to the replay's stand-in and to the contract, and
checks that this page shows both files as they are.

`/usr/share/rpcd/acl.d/vantage-tile-dns.json`:

```json
{
	"vantage-tile-dns": {
		"description": "Vantage dashboard: the DNS tile (vantage.tile.dns status: dnsmasq's query counters, read-only)",
		"read": {
			"ubus": {
				"vantage.tile.dns": [ "status" ]
			}
		}
	}
}
```

`/usr/share/rpcd/ucode/vantage.tile.dns`:

```js
// An example provider tile for the Vantage dashboard (#129): the DNS
// numbers dnsmasq keeps, from its ubus metrics. Not shipped: it shows what
// a provider package holds, this rpcd ucode plugin and its ACL group
// (acl.d/vantage-tile-dns.json); docs/TILES.md has the contract. The
// replay answers the same object with its stand-in (dev/replay/tiles.js,
// --tiles); tests/tiles.test.js runs this file and holds the two to the
// same answers.
//
// The dashboard asks `vantage.tile.dns status` with the slow part of its
// poll, only for a login whose ACL grants that call by name, and draws the
// answer itself, as text (model.js, tile). So the answer is data: a
// title, labelled numbers with a unit, no markup and no script. It is made
// from dnsmasq's counters alone, with nothing asked of the network or the
// disk: a plugin answers inside rpcd, which answers nothing else
// meanwhile.
'use strict';

import { connect } from 'ubus';

// the dashboard asks again after this many seconds, not at every poll
const EVERY = 10;

function status() {
	let bus = connect();
	let m = bus ? bus.call('dnsmasq', 'metrics') : null;

	if (type(m) != 'object')
		return { v: 1, title: 'DNS', icon: 'globe', state: 'off', note: 'dnsmasq does not answer', page: 'admin/network/dhcp', items: [] };

	let n = (k) => (type(m[k]) == 'int' && m[k] >= 0) ? m[k] : 0;
	let cached = n('dns_local_answered'), forwarded = n('dns_queries_forwarded');
	let asked = cached + forwarded + n('dns_auth_answered') + n('dns_stale_answered');

	return {
		v: 1, title: 'DNS', icon: 'globe', state: 'ok', every: EVERY, page: 'admin/network/dhcp',
		note: 'dnsmasq, since it started',
		items: [
			// counters: the dashboard shows each as a rate between two answers
			{ label: 'Queries', value: asked, rate: true, trend: true },
			{ label: 'Forwarded', value: forwarded, rate: true },
			// a share with a meter, in tenths of a percent
			{ label: 'From cache', value: (cached + forwarded) ? int(cached * 1000 / (cached + forwarded)) / 10.0 : 0, unit: '%', max: 100 },
			{ label: 'Unanswered', value: n('dns_unanswered') }
		]
	};
}

return {
	'vantage.tile.dns': {
		status: { call: status }
	}
};
```

As a package, with LuCI's build rules, the two files go under `root/`
of a directory like this `Makefile`'s; LuCI's rules install `root/` as
it is and reload rpcd after installing:

```make
include $(TOPDIR)/rules.mk

LUCI_TITLE:=DNS tile for the Vantage dashboard
LUCI_DEPENDS:=+rpcd-mod-ucode +ucode-mod-ubus
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
```

## Trying it

**In the replay**, without a router (see
[`dev/replay/README.md`](../dev/replay/README.md)): `--tiles` answers
the example above, over invented dnsmasq numbers, and a stand-in for a
mobile backup line.

```sh
node dev/replay/server.js --mirror ../vantage-mirror --port 8106 --demo --tiles \
    --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
    --app-dir luci-app-vantage
```

For your own provider, give the replay its ACL file with `--app-dir
<dir>` (the file in `<dir>/root/usr/share/rpcd/acl.d/`) and a JavaScript
stand-in for the plugin with `--fixtures <dir>`: a file
`vantage.tile.<id>-plugin.js` that exports `OBJECT` and
`call(store, method, args)`, returning `{ result: [ 0, answer ] }` (the
replay cannot run ucode; the dnsmasq example's stand-in is `dnsStatus()`
in `dev/replay/tiles.js`).

**On a router**, call it as the dashboard does and see what the
dashboard reads of the answer, with a checkout of this repository:

```sh
ubus call vantage.tile.dns status > answer.json       # on the router
node -e "const m = require('./tests/luci-stub').load('vantage.model'); console.log(JSON.stringify(m.tile(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))), null, 1))" answer.json
```

`null` is no answer; an item missing from `items` was left out.

## What a provider must not do

- **Change anything in `status`.** It is called every few seconds, with
  the session of whoever has the dashboard open. The dashboard cannot
  check that it only reads; installing your package is trusting it.
- **Take time.** Answer from what is already in memory, in a few
  milliseconds: no network, no waiting on a daemon that may hang, no
  large files, no programs started. While your method runs, rpcd answers
  no other request, of LuCI or anyone; the dashboard backs off from a
  slow answer, but cannot stop other callers.
- **Answer with secrets.** Anyone your group is granted to sees the
  answer, and it travels to their browser.
- **Grant more.** The group grants your object's `status`, to read, and
  nothing else: no other method, no pattern, no write.
- **Call itself something else.** The tag shows your object's id, not
  what you write in the title; a title that imitates one of the
  dashboard's tiles only makes the tag the more visible.
- **Count on the dashboard's own tiles**, their ids or their places.

## Known limits

- Three provider tiles a page.
- A slow provider holds up rpcd for everyone while it runs, and the
  dashboard's first paint for up to 2 s.
- The dashboard cannot verify that `status` has no side effects.
- The ACL is read once a page: a provider installed or granted while
  the dashboard is open shows after a reload.
- No actions, tables of many rows, free-form charts, colours or markup:
  numbers and short texts, drawn by the dashboard.
