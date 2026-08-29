# Changelog

All notable changes to this project are documented in this file.
The format follows Keep a Changelog; versions are SemVer.

## Unreleased

## [0.1.0] - 2026-08-29

### Added

- Shared createhelper utility dock entry with dsh-instance-manager. It follows
  the live sidebar edge, supports persisted bottom-left / bottom-right / hidden
  placement, and does not occupy the sidebar footer or Settings action.
- Browser client lifecycle test, API route lifecycle test, and a package-version lockstep test.

### Changed

- The client now waits for the `slots` service before mounting its dock item
  and overlay, avoiding a silent missing entry caused by bundle mount order.
- The panel adds an explicit sampling state, a compact findings/descendants
  summary, keyboard focus treatment, and a clearer hierarchy.
- A click on the TreeKeeper dock icon now closes an already-open panel instead
  of being intercepted by the outside-dismiss handler.

### Fixed

- Kill failures are surfaced in the panel instead of being immediately erased
  by an unconditional refresh.
- Scope attribution to the DSH host process rather than its launcher chain.
- Mark process evidence as `exact` or `unattributed`; label the jobs view as implementation-limited rather than cross-session.
- Fail closed on process termination unless a recent complete snapshot and a verified creation time identify the target.

## [0.0.1] - 2026-08-27

### Added
- Skeleton: host half (`lib/index.js`) with `/dsh-treekeeper/api` route,
  Windows process sampler with degraded fallback, ancestor-attribution
  engine, leak heuristics (duplicate / orphan / long-lived), guarded
  tree-kill with creation-time precheck, browser panel shell.
- Pure-function core (`attribute` / `leak`) covered by `node --test`.
