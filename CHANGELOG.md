# Changelog

All notable changes to this project are documented in this file.
The format follows Keep a Changelog; versions are SemVer.

## Unreleased

- Scope attribution to the DSH host process rather than its launcher chain.
- Mark process evidence as `exact` or `unattributed`; label the jobs view as implementation-limited rather than cross-session.
- Fail closed on process termination unless a recent complete snapshot and a verified creation time identify the target.

## [0.0.1] - unreleased

### Added
- Skeleton: host half (`lib/index.js`) with `/dsh-treekeeper/api` route,
  Windows process sampler with degraded fallback, ancestor-attribution
  engine, leak heuristics (duplicate / orphan / long-lived), guarded
  tree-kill with creation-time precheck, browser panel shell.
- Pure-function core (`attribute` / `leak`) covered by `node --test`.
