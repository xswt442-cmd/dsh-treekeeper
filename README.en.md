# dsh-treekeeper

[中文](./README.md) | [English](./README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-treekeeper)](https://www.npmjs.com/package/dsh-treekeeper)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

A Windows-focused DSH process-tree reconciliation and governance plugin. It displays descendants of the current host beside the available task ledger, surfaces leaked, orphaned, and unattributed processes, and provides guarded process-tree termination.

## Features

- Sample the current DSH host tree without attributing unrelated launcher children to the host.
- Detect duplicate commands, orphaned processes, and long-running plugin children.
- Reconcile jobs and the selected session's subagent descendants without waking cold sessions.
- Open the global panel from the Mini Utility Dock or focus the current session from its header.
- Identify plugin sources from command paths and retain finding and action history.

## Install

```powershell
# install from npm and register with the web profile (recommended)
dsh plugin --profile web add dsh-treekeeper

# install the npm package only
npm install dsh-treekeeper

# or install from GitHub
dsh plugin --profile web add github:xswt442-cmd/dsh-treekeeper
```

`npm install` installs the package only; DSH still needs the bundle in its profile. `dsh plugin add` performs both steps. Restart DSH Web after installation.

## Session scope

The subagent section has three states:

| State | Meaning |
| --- | --- |
| `available` | Shows the selected session's complete descendant tree |
| `root-required` | Opened from the Dock without a selected session |
| `unavailable` | The current DSH build does not expose subagents |

The session-header entry always supplies an explicit session; the global entry never guesses the current selection.

## Configuration

Configuration is process-local and resets on restart.

| Field | Default | Description |
| --- | ---: | --- |
| `pollMs` | `0` | Background sampling interval; `0` samples on demand, minimum active value is 2000 ms |
| `allowKill` | `true` | Enables guarded process-tree termination |
| `extraWhitelistPids` | `[]` | Additional protected PIDs |

## Safety and limits

- Windows is currently supported. If CIM is unavailable, sampling degrades to read-only and disables attribution and termination.
- The API accepts same-origin requests only from a loopback TCP peer; network identity is decided by the peer address, not the Host/Origin headers, so a remote peer is rejected even when the host listens on 0.0.0.0; mutating actions are POST-only.
- Termination requires a complete snapshot no older than 15 seconds and rechecks the PID creation time; only processes inside the DSH host tree may be terminated, while unknown processes are investigation-only and cannot be killed.
- Critical system processes, the current host, its launcher chain, and additional whitelisted PIDs cannot be terminated. Killable scope is the DSH host attribution only: an extra whitelisted PID is an attribution root for labelling, and its descendants stay visible but not killable, so protecting a PID never widens the kill scope.
- Protected descendants are evaluated against a process tree sampled immediately before the kill: if that tree contains any protected PID the whole kill is refused. A protected descendant that appears after that sample cannot be excluded — `taskkill /T` has no exclusion switch — which is the residual TOCTOU boundary, not an absolute guarantee.
- Jobs have no stable PID mapping to OS processes; command-line matches are investigative and never trigger automatic action.
- Findings and termination results are written to `$DSH_HOME/treekeeper/history.jsonl`.

## Development

```sh
npm test
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
