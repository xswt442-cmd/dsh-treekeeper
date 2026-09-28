# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## 0.3.4 - 2026-09-29

### Changed

- `CHANGELOG.md`, `CHANGELOG.en.md` and `RELEASING.md` move into `docs/`; the repository root keeps the two READMEs, `LICENSE`, `AGENTS.md` and `CLAUDE.md`. The npm package ships both changelogs at their new paths.

### Maintenance

- The `dsh-mini-utility-dock` dependency is 0.7.0, and `docs:check` reads the pairs this repository declares in `docs.config.mjs`.

## 0.3.3 - 2026-09-28

### Security

- Host-side JSON replies and session-id validation come from the embedded `dsh-mini-utility-dock` fragment `dsh-host-http`, so `cache-control: no-store` has a single setter.
- Connection authorization is one `authorizeBrowser(req, res)` call built by that fragment. A reload during the window after a Connection has existed still returns 503 rather than falling back to the loopback guard.
- The 500 response and the panel's error rendering contain a fixed `code`; the exception text goes to the host log.
- The `action` written to that host log has its line breaks folded and its length truncated, so one request produces one log row.

### Changed

- An unusable request body returns a distinguishable error: a body that is not a JSON object returns 400 `bad_json`, an oversized one returns 413 `body_too_large`.
- `pid` and `pollMs` go through explicit validation: an invalid value is not folded into `0`, and an out-of-bounds poll interval returns 400.
- The process sampler (`lib/sampler.js`) has parsing and degradation tests, covering the `snapshot.degraded` flag the termination gates depend on.
- The history store distinguishes an empty store from an unusable one and logs once per state change.

### Maintenance

- The compatibility workflow runs on `pull_request`, its Windows cell runs the unit tests, syntax checking walks `lib/*.js`, and the matrix drops `@latest` and adds the `engines.node` floor, Node 20.
- The publish workflow splits into checks / npm / GitHub release jobs: the jobs that run this repository's code hold a read-only token, and a tag must be an ancestor of `main` to reach npm.
- The npm package includes both CHANGELOGs and `LICENSE`, `package.json` declares an author, both READMEs lead their badge row with the compatibility CI badge, and a `README.en.md` link to a section name that does not exist is corrected.
- `http:check` joined `npm test`. A check compares only the marked blocks its pinned dock knows, so the new block's presence and uniqueness are asserted by `test/host-http.test.js`.
- The dock pin is 0.6.0 and all four embedded blocks re-synced; `http:check` covers the fourth block.

## 0.3.2 - 2026-09-25

### Changed

- Adopt DSH `0.1.7-rc.2`'s two sidebar Session-row seats: an idle row shows a small glyph, its hover card a one-line summary and a "View this session in TreeKeeper" entry. Both read the panel's cache, so neither reaches the host.
- The panel entry becomes `dsh-mini-utility-dock`'s shared launcher fragment: one icon at the bottom-left opens the panel menu. The page-local dock protocol and `dock:sync` / `dock:check` are retired, and the panel is pinned to the top-right.
- Raise the minimum supported DSH version to `0.1.5-rc.3`; the compatibility matrix now pins this baseline and the 0.1.7 line.
- Declare host compatibility: `peerDependencies` and `engines.dsh` both require `>=0.1.5-rc.3`, with the peer optional so npm never installs the host. The host's startup preflight uses that range to decide whether to disable this plugin.
- Fix the bottom-left launcher icon disappearing after a hot reload: synced from `dsh-mini-utility-dock` 0.5.1, whose claim is released with its owner so the page's other copies register again without a full reload.

## 0.3.0 - 2026-09-23

### Fixed

- Two fail-open holes in the kill path now fail closed: an authorized kill no longer throws for want of a sample, and a failed probe is no longer reported as "already gone" or "killed".
- An empty CIM reply is treated as degradation: a live machine never samples zero processes.
- History append and rotation are serialized: the background poll and concurrent kills both append, and interleaving could drop a line.
- Background sampling failures leave a log line instead of being swallowed.

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
