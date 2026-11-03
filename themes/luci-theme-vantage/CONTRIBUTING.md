# Contributing to Vantage

Issues and pull requests are welcome. Security problems are the exception:
report those privately as described in [SECURITY.md](SECURITY.md), not in a
public issue.

Using a coding agent? Point it at [AGENTS.md](AGENTS.md); it holds the same
rules in a compact form.

Translations are especially welcome: see [Translations](#translations)
for how to add or update a language.

## Reporting a bug

Please include:

- your OpenWrt version: the output of `cat /etc/openwrt_release`
- the Vantage version (`apk list --installed | grep vantage`)
- your browser and its version
- what you did, what you expected, and what happened instead
- for a broken page, the browser console output (<kbd>F12</kbd>)

Screenshots help, but must not show your network. Take them with the
replay's `--demo` mode (below), or remove IP addresses, MAC addresses,
SSIDs, host names and device names before you post them.

## Development setup

The UI is developed offline against recorded device data, never against a
live router. You need Node.js (there are no dependencies to install) and,
to build packages, podman.

1. **Device data.** The replay reads a recording of a LuCI session in
   the format described under Recording format in
   [`dev/replay/README.md`](dev/replay/README.md#recording-format), or
   hand-written fixtures (`--fixtures`, `dev/replay/addons.sh`). Keep a
   recording outside this repository, e.g. in `../vantage-mirror`, and
   never commit one: it holds your network's addresses and names.
2. **Replay** it with the theme and app from your working tree, plus a
   LuCI 25.12 root filesystem for LuCI's own templates and static files
   (`--rootfs`, see [`dev/replay/README.md`](dev/replay/README.md)):

   ```sh
   node dev/replay/server.js --mirror ../vantage-mirror --port 8106 --demo \
       --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
       --app-dir luci-app-vantage
   ```

   Open `http://127.0.0.1:8106/` (any login works) and reload after each
   edit.
3. **Demo mode** (`--demo`) replaces addresses, MACs, SSIDs and names with
   documentation values. Use it for every screenshot you share.

The dashboard must also work under Bootstrap: run the replay without
`--theme-dir` to check.

## Checks

Run these before opening a pull request; all must pass:

```sh
node --test tests/
node security-tests/check_dom_sinks.js
node security-tests/test_templates.js
node security-tests/test_acl_policy.js
node security-tests/check_private_addresses.js [--require-mirror --mirror ../vantage-mirror]
```

When you add, change or remove a user-visible string, also run
`dev/i18n/update.sh` and commit the updated templates
(`po/templates/*.pot`) and catalogues; CI runs `dev/i18n/update.sh --check`.

For changes to Makefiles, `root/` files or install scripts, also build the
packages (commit first; the script builds a clean clone of the commit):

```sh
dev/build/sdk-build.sh 25.12.4
```

## Translations

Each package has its own catalogue, generated with LuCI's own tools:

| Package | Template | Catalogue for a language |
|---|---|---|
| dashboard | `luci-app-vantage/po/templates/vantage.pot` | `luci-app-vantage/po/<lang>/vantage.po` |
| theme | `luci-theme-vantage/po/templates/vantage-theme.pot` | `luci-theme-vantage/po/<lang>/vantage-theme.po` |

`dev/i18n/update.sh` needs git, perl and GNU gettext (Debian/Ubuntu:
`apt install gettext`; macOS: `brew install gettext`). On its first run it
fetches LuCI's i18n scripts at the commit the pinned SDK builds with
(about 2 MB, cached in `~/.cache/vantage/`).

**Add a language.** `<lang>` is LuCI's code for it, as in LuCI's own
`po/` directories: `de`, `fr`, `pt_BR`, `zh_Hans`, ...
(`dev/i18n/luci-languages.mk` lists them all):

```sh
dev/i18n/update.sh --add de
```

This creates both catalogues from the templates. Translate them with any
PO editor (Poedit, Lokalize, or a text editor): fill in each `msgstr`. An
empty `msgstr` keeps the English text, so you can translate in several
steps.

**Update a language** after the sources changed (or before you start, to
be current):

```sh
dev/i18n/update.sh
```

It regenerates the templates from the sources and merges them into every
catalogue, the way LuCI's `i18n-update.pl` does: new strings arrive with an
empty `msgstr`, removed ones are kept at the end as obsolete (`#~`)
entries.

Rules for translations:

- **Change the words, never the format.** Keep every placeholder (`%s`,
  `%d`, ...) of the English text, in the same order (LuCI fills them by
  position), and keep numbers and units as the code writes them:
  `"(configured %d dBm, limited by regulatory rules)"` becomes
  `"(eingestellt %d dBm, durch Vorschriften begrenzt)"`: the words change,
  `%d dBm` does not. `tests/i18n.test.js` checks the placeholders.
- No markup: a translation may not add `<` or `>`.
- Labels, table headers and pills have little room; keep them short.

**Preview** your translation in the replay: add `--lang <lang>` to the
replay command above (`--lang de`). The theme's and the dashboard's
strings then show in that language, straight from your `.po` files; reload
after each edit. LuCI's own strings stay in English unless the recording
contains that language.

**Check** before opening the pull request:

```sh
node --test tests/          # compiles every catalogue (msgfmt -c), checks placeholders
dev/i18n/update.sh --check
```

A translation pull request touches only `po/` files. If you find a text in
the UI that cannot be translated yet, make that a separate change to the
code: wrap the string in `_()` with the English text as it is shown today,
keeping the display format in a format string (`_('%s Gbit/s').format(v)`,
`_('%d dBm').format(p)`) rather than switching to another formatting
helper, run `dev/i18n/update.sh` and commit the templates with it.

CI builds one language package per package and language
(`luci-i18n-vantage-<lang>` and `luci-i18n-vantage-theme-<lang>`, with
`<lang>` as LuCI's package suffix, e.g. `zh-cn`) and checks each against
your catalogues; there is nothing else to set up.

## Rules

- **No real network data** in commits, tests, docs or screenshots. Use
  documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`) and MACs (`00:00:5E:00:53:xx`).
  `check_private_addresses.js` rejects anything else, including
  `192.168.x.x`.
- **No markup built from data.** Create DOM nodes with `E()` and pass text
  inside arrays; no `innerHTML` and friends. Templates escape everything
  with `entityencode()` and never echo the login name.
- **Least privilege.** A new ubus call needs its `rpc.declare`, an ACL
  entry and an allowlist entry in `security-tests/test_acl_policy.js`, with
  the reason in the pull request. The app stays read-only apart from its
  own `/etc/config/vantage`, which it writes only through its rpcd plugin
  (`luci.vantage set_alias`, validated on the device); no ACL group grants
  uci writes, and nothing reads Wi-Fi keys. Changes to the plugin's name
  rules go into `names.js` and `dev/replay/vantage-plugin.js` as well;
  `tests/plugin.test.js` compares them (the real plugin runs when
  `UCODE=/path/to/ucode` points at a host ucode binary).
- **Theme and app stay independent.** The app uses only the theme's
  `--v-*` custom properties (with fallbacks) and its own `vt-*` classes.

## Style

- Tabs, `'use strict';`, LuCI's `'require ...'` module headers and class
  idioms (`view.extend`, `baseclass.extend`, `rpc.declare`).
- The app's JavaScript is ES5 style (`var`, function expressions); the
  theme's uses `const`/`let` and arrow functions. Match the file you edit.
- No dependencies, CDNs or web fonts.
- Short comments that explain why.

## Pull requests

Coherent AI-assisted pull requests are welcome, as long as you have read
and understood every change and can explain it.

- One feature or fix per pull request; keep unrelated changes out.
- Don't touch `.github/workflows/`, `security-tests/`, `keys/`,
  `dev/build/` or `.release-manifests/` unless that is what the pull
  request is about, and say why.
- Never weaken a test or check to make it pass; fix the code instead.
- Don't bump `PKG_VERSION` or `PKG_RELEASE`; the maintainer cuts releases.
- Run the [checks](#checks) first. Screenshots only from the replay's
  `--demo` mode, never with real addresses, MACs or SSIDs.
- Mention anything that changes the ACL, the templates or the install
  scripts.

## Commits

- Imperative subject line (e.g. "Show uplink rate in the path view"), a
  blank line, then a body that says what changed and why.
- No AI attribution: no `Co-Authored-By` lines or "Generated with ..."
  notes for AI tools.

CI (`.github/workflows/ci.yml`) runs the tests and security checks on
every push and pull request, then builds the packages with the pinned
SDK.

## Releases

1. Add the release to `CHANGELOG.md` (user-visible changes, newest
   first), bump `PKG_VERSION` in both Makefiles and commit.
2. Build that commit locally: `dev/build/sdk-build.sh 25.12.4`.
3. Commit `dist/25.12.4/SHA256SUMS` as `.release-manifests/v<version>.sha256`,
   push, then push the tag `v<version>` on that commit.
4. CI rebuilds the tag, refuses to publish unless its hashes match the
   committed manifest, and creates the GitHub release with the packages,
   `SHA256SUMS` and `BUILDINFO`.

By contributing you agree that your contribution is licensed under the
GNU General Public License, version 3 or any later version
(GPL-3.0-or-later), like the rest of the project.
