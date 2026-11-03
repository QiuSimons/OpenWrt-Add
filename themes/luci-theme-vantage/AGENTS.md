# AGENTS.md

Instructions for coding agents working in this repository. Human
contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which says the same
things at more length.

## The project

Two OpenWrt 25.12 LuCI packages plus offline tooling. No npm, no
`package.json`, no build step for the UI: the files under `htdocs/` and
`ucode/` ship as they are.

| Path | What |
|---|---|
| `luci-theme-vantage/` | Theme: ucode templates (`ucode/template/themes/vantage/*.ut`), CSS and icons (`htdocs/luci-static/vantage/`), shell script (`htdocs/luci-static/resources/menu-vantage.js`, `vantage-theme/host.js`), `root/etc/uci-defaults/30_luci-theme-vantage`, `postrm` in the `Makefile` |
| `luci-app-vantage/` | Dashboard at `admin/dashboard`: views (`htdocs/.../view/vantage/overview.js`; `firewall.js`, the Network → Firewall → Overview tab), modules (`htdocs/.../vantage/*.js`), `app.css`, menu entry, rpcd ACL (`root/usr/share/rpcd/acl.d/`), rpcd ucode plugin `luci.vantage` (`root/usr/share/rpcd/ucode/luci.vantage`), default `/etc/config/vantage` |
| `dev/replay/` | Offline LuCI server that replays a recording; see its README |
| `dev/build/` | `sdk-build.sh`: reproducible build in the OpenWrt SDK image (podman) |
| `dev/icons/build.js` | Generates the status icon set; edit the generator, not the SVGs |
| `dev/i18n/` | `update.sh`: translation templates and catalogues (`po/`) with LuCI's i18n tools; `catalog.js`: LuCI's catalogue format (tests, replay `--lang`) |
| `tests/`, `security-tests/` | `node:test` suite and the four security checks |
| `prototypes/` | Design references. Do not edit or ship them |
| `docs/` | `SPEC.md` (product), `luci-contract.md` (what LuCI needs from a theme), `INSTALL.md` |

## Hard rules

1. **No real devices.** Do not SSH to, copy to, browse, or run any
   recorder against a router or access point unless the human asks for
   exactly that in the current conversation. All UI work goes through the
   replay.
2. **No real network data in the tree.** Recordings live outside the
   repository (by default `../vantage-mirror`) and are never copied in. Use
   documentation values everywhere, in code, tests, fixtures and docs:
   IPv4 `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`; IPv6
   `2001:db8::/32`; MACs `00:00:5E:00:53:xx` (invented locally administered
   ones: `02:00:5E:xx:xx:xx`). Not even OpenWrt's default LAN address.
   `check_private_addresses.js` enforces this.
3. **Screenshots only from `--demo` mode** of the replay, which
   pseudonymises the recording.
4. **DOM from data only through `E()` / `dom.create()` with text nodes.**
   A bare string as content becomes `innerHTML`, so pass text inside an
   array: `E('span', {}, [ name ])`. No `innerHTML`, `outerHTML`,
   `insertAdjacentHTML` or `document.write`. Event handlers are functions,
   never strings; build URLs with `L.url()`. `check_dom_sinks.js` enforces
   this.
5. **Templates escape everything.** `{{ }}` does not escape: use
   `entityencode(v, true)`, and `striptags()` for titles. Never output
   `fuser`. On pages for visitors who are not logged in (login, 404,
   CSRF) the theme adds nothing about the device (LuCI's core header
   still prints its `L.env` script; that is upstream, see
   `docs/luci-contract.md` section 2). Inline scripts carry no data. Stay within
   the ucode subset that `dev/replay/ut.js` compiles. `test_templates.js`
   enforces this.
6. **The ACL stays minimal and matches the code.** Every `rpc.declare` in
   the app must be granted in `luci-app-vantage.json`, and every grant must
   be used. The read group is read-only and never reads Wi-Fi keys
   (wireless data comes from the plugin's `wireless` method; LuCI's own
   groups, such as `luci-base-network-status`, can); reverse DNS
   sits in its own optional group (`luci-app-vantage-rdns`); the names
   group (`luci-app-vantage-names`) grants the plugin's `set_alias`, which
   validates and writes `/etc/config/vantage` itself, and reading that
   config. No group
   grants uci writes; no `file.exec`. The plugin's name rules must match
   `names.js` and `dev/replay/vantage-plugin.js` (`tests/plugin.test.js`).
   Adding a call means changing the view, the ACL JSON and the allowlist in
   `security-tests/test_acl_policy.js` together, and saying why in the
   commit message. Point out any ACL change to the human.
7. **Theme and app stay independent.** The app is styled only through the
   theme's `--v-*` custom properties, each with a fallback, and its classes
   are `vt-*` scoped under `.vt-app`. The theme doesn't style app
   internals. The app must still work under Bootstrap (replay without
   `--theme-dir`).
8. **Git.** Do not commit or push unless asked. No AI attribution anywhere:
   no `Co-Authored-By` or "Generated with" trailers in commits or pull
   requests, and no such notes in code or docs.
9. **Files.** No `rm -rf` on variable or glob paths. Do not stop processes
   you did not start (a replay server on a port may be the human's).

## Dev loop

Needs Node.js (the maintainer uses a current release; there are no
dependencies to install).

The replay needs two local inputs that are not in the repository: a
recording (`--mirror`, in the format described in `dev/replay/README.md`
under Recording format) and a LuCI 25.12 root
filesystem for the core templates and static files (`--rootfs` or
`$VANTAGE_ROOTFS`). If either is missing, say so and stick to the tests; do
not fake them.

```sh
# theme + app, pseudonymised (use for screenshots)
node dev/replay/server.js --mirror ../vantage-mirror --port 8106 --demo \
    --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
    --app-dir luci-app-vantage

# app under Bootstrap
node dev/replay/server.js --mirror ../vantage-mirror --port 8097 --app-dir luci-app-vantage
```

Open `http://127.0.0.1:<port>/`; any username and password log in. Files
are read on every request, so reload the page after an edit. Save & Apply
only changes an in-memory overlay. Pick a free port. The replay listens on
127.0.0.1 only and never forwards anything to a device.

## Verify

Run all of these before you call a change done:

```sh
node --test tests/            # UCODE=/path/to/ucode also runs the real rpcd plugin
dev/i18n/update.sh --check    # translation templates match the sources
node security-tests/check_dom_sinks.js
node security-tests/test_templates.js
node security-tests/test_acl_policy.js
node security-tests/check_private_addresses.js --require-mirror --mirror ../vantage-mirror
```

Leave out `--require-mirror --mirror ...` only when there is no mirror
(it then also can't look for recorded hostnames and SSIDs). For packaging
changes (Makefiles, `root/`, uci-defaults, postrm), also build:

```sh
dev/build/sdk-build.sh 25.12.4      # builds the committed HEAD into dist/25.12.4/
```

It builds from a clean clone of a commit, so uncommitted edits are not in
the result.

## Style

- Tabs for indentation. Every JS file starts with `'use strict';` and
  LuCI `'require ...';` lines. Use LuCI idioms: `view.extend({...})`,
  `baseclass.extend({...})`, `rpc.declare()` at the top of the file,
  `poll.add()`, `L.resolveDefault()`, `_()` for user-visible strings.
- App JavaScript (`luci-app-vantage/`) is ES5 style: `var`, function
  expressions, no arrow functions. Theme JavaScript (`menu-vantage.js`,
  `vantage-theme/`) uses `const`/`let` and arrow functions. Follow the file
  you are in. No ES modules, no dependencies, no CDNs, no web fonts.
- CSS is shipped unminified (`LUCI_MINIFY_CSS:=0`) because it uses modern
  syntax; JS may go through LuCI's jsmin in builds.
- **Translations.** Wrap every user-visible string in `_()` (templates:
  `entityencode(_('...'), true)`), including titles, tooltips and
  `aria-label`s. Translation changes the words only, never the display
  format: keep today's output exactly (e.g. link speeds `2.5 Gbit/s`, TX
  power `0 dBm`) by putting the format into the string,
  `_('%s Gbit/s').format(v)`, `_('%d dBm').format(p)`, rather than
  switching to other `fmt` helpers. Placeholders are positional (LuCI's
  `String.format`). After adding, changing or removing strings, run
  `dev/i18n/update.sh` and commit `po/templates/*.pot` and the updated
  catalogues; CI fails on `dev/i18n/update.sh --check` otherwise.
  Catalogues are `luci-app-vantage/po/<lang>/vantage.po` and
  `luci-theme-vantage/po/<lang>/vantage-theme.po`; nothing else goes in
  `po/`.
- Comments are short and say why, not what.
- Status icons come from `dev/icons/build.js`; regenerate them, don't
  hand-edit the SVGs.

## Commits

Imperative subject line, blank line, then a wrapped body saying what
changed per package and why. No trailers of any kind for AI tools.

## Reference

- [`docs/SPEC.md`](docs/SPEC.md): scope and security requirements
- [`docs/luci-contract.md`](docs/luci-contract.md): what LuCI 25.12 expects
  from a theme (required hooks, CSS, template scope)
- [`dev/replay/README.md`](dev/replay/README.md): replay options, synthetic
  data, demo mode
- [`docs/INSTALL.md`](docs/INSTALL.md): installing and packaging behaviour
