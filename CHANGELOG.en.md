# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## Unreleased

### Changed

- Adopt the two sidebar Session-row seats DSH `0.1.7-rc.2` adds: `sidebar.session.row.leading` paints a 12px glyph on an idle row whose session TreeKeeper already has a cached fact for (an empty cache leaves the cell blank), and `sidebar.session.row.hover` adds a one-line cached summary plus a "View this session in TreeKeeper" entry to the row's hover card. Both read only the module-level cache the panel fills when it loads a snapshot: no host call, no session binding, so no idle row is sampled or woken. The hover entry works with an empty cache too — that is the path that discovers an unknown session.
- The panel launcher becomes the family's shared launcher: one 30px icon at the bottom-left of the work area (the host's `shell.overlay` layer, positioned by the sidebar's right edge + 16, 80 while the shell has not laid the column out) that opens a menu listing the three panels. The assembly comes from the new `dsh-utility-launcher` fragment in `dsh-mini-utility-dock` (maintained here with `launcher:sync` / `launcher:check`, which `npm test` runs), and this plugin only contributes its own row; the page-level dock protocol is gone, the old `dock:sync` / `dock:check` for `client.js` with it, and the panel position no longer follows that fragment's measured left offset but is pinned to the frame's top-right corner.
- Raise the minimum supported DSH version to `0.1.5-rc.3`; the compatibility matrix now pins this baseline and the 0.1.7 line.
- Declare host compatibility: `peerDependencies` now carries `@deepseek-ai/dsh: >=0.1.5-rc.3` (marked optional in `peerDependenciesMeta`, so npm never installs the host because of it), `engines.dsh` repeats the same range, and the compatibility matrix's 0.1.7 anchor moves from rc.1 to rc.2. The 0.1.7 startup preflight compares every `@deepseek-ai/dsh*` peer against the running version with prereleases included and **disables** the row when it does not match, with only an exact-version `dsh plugin allow-version` exemption to override it — previously this plugin declared no peer at all, so a user on an unsupported host got no signal. The range carries no upper bound on purpose: the host is a developer preview, a ceiling would disable our own plugin on its next release, and the exemption path accepts an exact version only.

## 0.3.0 - 2026-09-23

### Fixed

- Two fail-open holes in the kill path: extracting the gates dropped the sample binding, so an authorized kill always threw and answered 500; and a failed probe read as "already gone" or "killed" — one hole on each side of taskkill. Both now fail closed.
- An empty CIM reply is treated as degradation: a live machine never samples zero processes, and the empty result used to render as a healthy, empty machine with no hint.
- History append and rotation are serialized: the background poll and concurrent kills both append, and interleaving could drop a line.
- Background sampling failures leave a log line; they used to be swallowed, letting the snapshot go stale while the panel showed nothing.

### Changed

- The kill gates are pure functions (`decideKillEntry` / `decideKillConfirm`), so all eight refusal paths are covered on every platform.
- The declared minimum DSH version is now `>=0.1.2-rc.1` (was `>=0.1.0-rc.6`; CI never covered it).

## 0.2.6 - 2026-09-17

### Maintenance

- README badges are coloured per facet (npm / release / DSH / node / downloads / license) and the changelog wording is tightened. No code change.

## 0.2.5 - 2026-09-17

### Changed

- "DSH host descendants" is a collapsed disclosure now, with the count badge still on the heading. The expanded list pushed the actionable sections (unattributed processes, job ledger, subagent tree) below the first screen.
- The README header uses one consistent badge row.

## 0.2.4 - 2026-09-16

### Maintenance

- The shared-fragment CI check now runs in this repository (`loopback:check` / `guard:check`) instead of comparing across repositories.

## 0.2.3 - 2026-09-14

### Security

- **The Origin port is now always compared.** The comparison was previously skipped when no `currentPort` was configured, so a server on any port accepted `Origin: http://localhost:3080`. This is a tightening and admits no request the previous behaviour rejected.
- Fix a way to bypass the same-origin check: when a `Host` header is present but yields no hostname (for example an unbracketed IPv6 host such as `::1:3080`, which RFC 7230 does not allow), the allowlist was skipped entirely. Such requests are now rejected as non-loopback.
- The IPv4-mapped IPv6 loopback (`::ffff:127.0.0.1`, and `::ffff:7f00:1` after the URL parser normalises it) counts as loopback on both the Host and the Origin path.

### Fixed

- Reaching the plugin over the IPv6 loopback address `::1` no longer gets rejected.

## 0.2.2 - 2026-09-04

### Changed

- Adapted the browser API to the DSH 0.1.2-rc.1 Connection signed cookie; a Connection rejection never falls back to the legacy loopback guard.
- Descendant queries now receive cancellation from both HTTP request lifetime and browser refresh lifetime. A newer refresh, panel close, or request disconnect stops the obsolete traversal.
- Integrated the DSH global locale so runtime language changes update the panel, session entry, and Dock label.
- Compatibility checks cover `0.1.2-rc.1` and latest.

### Fixed

- Kill authorization now requires DSH host attribution: an extra whitelisted PID is still used for labelling, but its descendants are no longer killable. Previously protecting a PID widened the kill scope instead of narrowing it.
- A kill re-samples the process tree and re-verifies the target's creation time, so the protected-descendant check no longer runs against a snapshot up to 15 seconds old.
- The request guard now decides locality from the TCP peer address: non-loopback sources can no longer read process snapshots or kill trees. On older or custom remote-listening deployments, a forged `Host: 127.0.0.1` previously passed the guard.
- Kill targets must belong to the DSH host tree. Unattributed processes no longer show a kill entry, and the server rejects them as well.
- Tree kills are refused when the target's descendants include protected PIDs (whitelisted or part of the own process chain); previously such a PID was terminated as collateral.
- When the service runs on HTTP default port 80, same-origin Origins omitting the port (e.g. `http://127.0.0.1`) are no longer misjudged as cross-origin.

## 0.2.1 - 2026-09-02

### Changed

- The Dock fragment is now embedded from an external fragment package at build time; published plugins remain standalone.
- The Dock now filters external SVG icons while preserving sidebar geometry detection and fallback placement.

## 0.2.0 - 2026-09-01

### Added

- The session header can open a selected session's subagent descendant tree in TreeKeeper without waking cold sessions.
- Host and client now share unavailable, root-required, and available states.

### Changed

- Findings use a consistent evidence vocabulary and are grouped by severity.

## 0.1.1 - 2026-08-31

### Added

- The panel can read the selected session's complete subagent descendant tree.
- The jobs ledger enumerates live Agents through the owner-fenced API and retains unowned jobs.

### Changed

- The Mini Utility Dock uses a versioned protocol with HMR ownership protection.
- Opening one Dock panel closes its active sibling.

### Fixed

- The subagent service is accessed inside the DSH injection fence.

## 0.1.0 - 2026-08-29

### Added

- Added the positionable, hideable Mini Utility Dock entry.

### Changed

- The client waits for the slots service before mounting its entry and panel.
- Improved sampling state, summaries, keyboard focus, and visual hierarchy.

### Fixed

- Kill failures remain visible in the panel.
- Process scope is rooted at the DSH host and evidence scope is explicit.
- Process termination requires a recent complete snapshot and verified creation time.

## 0.0.1 - 2026-08-27

### Added

- Initial release: Windows process sampling, host attribution, and leak findings.
- Added guarded process-tree termination with creation-time verification.
- Added the browser panel and core unit tests.
