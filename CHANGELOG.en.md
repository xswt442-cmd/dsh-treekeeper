# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## Unreleased

### Fixed

- Kill authorization now requires DSH host attribution: an extra whitelisted PID is still used for labelling, but its descendants are no longer killable. Previously protecting a PID widened the kill scope instead of narrowing it.
- A kill re-samples the process tree and re-verifies the target's creation time, so the protected-descendant check no longer runs against a snapshot up to 15 seconds old.
- The request guard now decides locality from the TCP peer address: non-loopback sources can no longer read process snapshots or kill trees. Previously a forged `Host: 127.0.0.1` passed the guard, while DSH supports listening on `0.0.0.0`.
- Kill targets must belong to the DSH host tree. Unattributed processes no longer show a kill entry, and the server rejects them as well.
- Tree kills are refused when the target's descendants include protected PIDs (whitelisted or part of the own process chain); previously such a PID was terminated as collateral.
- When the service runs on HTTP default port 80, same-origin Origins omitting the port (e.g. `http://127.0.0.1`) are no longer misjudged as cross-origin.

## 0.2.1 - 2026-09-02

### Changed

- The Mini Utility Dock is now synchronized at build time from `dsh-mini-utility-dock`; published plugins remain standalone.
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
