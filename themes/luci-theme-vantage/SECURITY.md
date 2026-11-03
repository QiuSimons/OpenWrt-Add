# Security policy

## Supported versions

| Version | OpenWrt | Supported |
|---|---|---|
| 1.0.x | 25.12 | Yes |
| 1.0.x | 24.10 | Yes, since 1.0.8 |
| 1.0.x | 23.05 and older | No (untested) |

Fixes go into the latest release. Only the newest 1.0.x release is
supported.

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

1. Open the repository's **Security** tab on GitHub.
2. Choose **Report a vulnerability**. This uses GitHub's private
   vulnerability reporting, so only the maintainers see your report.

If the button is missing, open an issue that asks for a private contact,
without any details of the problem.

Please include:

- the affected package (`luci-theme-vantage`, `luci-app-vantage` or the
  dev tooling) and version, and your OpenWrt version
- what an attacker can do, and what they need first (logged in or not,
  on the LAN, a Wi-Fi client, a limited LuCI user, ...)
- steps to reproduce, ideally a proof of concept
- any real addresses, MACs, SSIDs or keys removed from your report

## Scope

In scope:

- the theme's templates (`header.ut`, `footer.ut`, `sysauth.ut`), for
  example escaping, or information shown to visitors who are not logged in
- the theme's and the dashboard's JavaScript, for example markup injection
  through host names, SSIDs or other data a client controls
- the dashboard's rpcd ACL: permissions broader than documented, or writes
  outside `/etc/config/vantage`
- packaging: the install and removal scripts, file permissions
- the dev tooling that handles recorded device data (`dev/replay/`),
  for example real identifiers leaking into demo output or the
  repository

Out of scope:

- bugs in LuCI, rpcd, uhttpd, OpenWrt or other packages that Vantage only
  uses. Report those to the OpenWrt project. If you are unsure where a
  problem belongs, report it here and we will help route it.
- information that LuCI's core templates put on every page, including
  error pages for visitors who are not logged in (the `L.env` script with
  the LuCI build, and on 404 pages the menu tree); see
  `docs/luci-contract.md` section 2

## What to expect

This is a small project maintained in spare time. We will acknowledge your
report as soon as we can, keep you informed while we work on a fix, and
agree on a disclosure date with you. We will credit you in the release
notes if you want.
