# dsh-treekeeper

[中文](./README.md) | [English](./README.en.md)

[![ci](https://github.com/xswt442-cmd/dsh-treekeeper/actions/workflows/compat.yml/badge.svg?branch=main)](https://github.com/xswt442-cmd/dsh-treekeeper/actions/workflows/compat.yml)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=plugin&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-treekeeper?label=npm&color=4d6bfe)](https://www.npmjs.com/package/dsh-treekeeper)
[![release](https://img.shields.io/github/v/release/xswt442-cmd/dsh-treekeeper?label=release&color=16a3a3)](https://github.com/xswt442-cmd/dsh-treekeeper/releases)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=%3E%3D0.1.5-rc.3&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D20&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/d18m/dsh-treekeeper?label=downloads&logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-treekeeper)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

A Windows-focused DSH process-tree reconciliation and governance plugin. It puts the current host process tree beside the available task ledger, attributes each process to the job that created it, surfaces unattributed and orphaned processes, and provides guarded tree termination.

## Features

- Sample the current DSH host process tree; other children of the launcher are never attributed to it.
- Attribute each process to the job that created it, and detect duplicate command lines, orphaned processes and long-running plugin children.
- Reconcile the job ledger with the root session's subagent descendant tree; the descendant tree of any other session is never read.
- Guarded tree termination (`taskkill /T /F`); the guard conditions are listed under "Safety and limits".
- Identify the plugin a process belongs to from the `node_modules` path in its command line, and keep finding and termination history.
- The "DSH host descendants" section is collapsed by default, with its count on the heading.
- A finding carries one of two confidence tiers: `hard`, confirmed by attribution into the host process tree and eligible for a tree kill, and `inferred`, a heuristic lead only and not eligible.
- The `dsh-mini-utility-dock` launcher at the bottom-left opens the global panel, a session header opens it focused on that session, and a sidebar Session row shows the cached facts for that session.

## Install

```powershell
# install from npm and register with the web profile (recommended)
dsh plugin --profile web add dsh-treekeeper

# install the npm package only
npm install dsh-treekeeper

# or install from GitHub
dsh plugin --profile web add github:xswt442-cmd/dsh-treekeeper
```

- `npm install` installs the package only and does not register a DSH profile.
- Restart DSH Web after installation.

## Session scope

The subagent section has three states:

| State | Meaning |
| --- | --- |
| `available` | Shows the root session's complete descendant tree |
| `root-required` | No root session is available |
| `unavailable` | The current DSH build does not expose subagents |

The session-header entry takes the row's sessionId as the root session, and the global panel entry takes the currently selected session.

Once the panel has loaded a snapshot, the facts attributable to a specific session enter a client-side cache:

| Cached fact | Attribution source |
| --- | --- |
| Descendant count, running count, read-issue count | The response's `subagentRoot` and its descendant rows |
| Running job count | The ledger row's `ownerSession` |
| Finding count | The `ownership.session` filled by the ledger join |

The host process list, unattributed processes, and jobs without an owner session cannot be attributed to a session and are not cached.

A sidebar Session row reads that cache: an idle row's leading cell shows a glyph and its hover card shows a one-line summary with "View this session in TreeKeeper". With no cached fact for that session the leading cell stays empty while the hover card's action still works, and neither issues a host read.

## Configuration

Configuration is process-local and resets on restart.

| Field | Default | Range | Purpose |
| --- | ---: | --- | --- |
| `pollMs` | `0` | `0` (sample on request) or 2000–600000 ms | Background sampling interval |
| `allowKill` | `true` | Boolean | Enables guarded process-tree termination |
| `extraWhitelistPids` | `[]` | Array of PIDs | Additional protected PIDs |

## Safety and limits

| Item | Limit |
| --- | --- |
| Platform | Windows only |
| Non-Windows | Reports `unsupported_platform` |
| Sampling degradation | If CIM is unavailable, sampling degrades to read-only and attribution and termination are disabled |
| Browser credential | On DSH 0.1.0-rc.7+, the browser API reuses the Connection signed cookie |
| Admission when the host has a Connection | Decided by the Connection's Host/Origin fence plus the signed cookie |
| Admission when the host has no Connection | Decided by this plugin's guard: TCP peer address, Fetch Metadata, Origin, and loopback Host |
| Mutating actions | POST-only |
| Remote reach | On a host configured with `trustedHosts` and listening on `0.0.0.0`, a remote peer holding a valid browser session reaches the API, `kill` included |
| Admission narrowing | This plugin does not narrow the host's Connection admission, and the kill guards below apply there as well |
| Traversal cancellation | Closing the panel, superseding a refresh, or disconnecting the HTTP request cancels an in-flight subagent descendant traversal |

Kill guards:

| Guard | Rule |
| --- | --- |
| Arming | The first click arms the button for 6 seconds |
| Confirmation | The second click opens the browser confirmation dialog |
| Snapshot | Requires a complete snapshot no older than 15 seconds |
| Identity check | The PID creation time is compared with the snapshot on entry |
| Recheck before the kill | A fresh sample is taken and the creation time is compared again |
| Attribution | Only processes whose attribution root is the DSH host may be terminated, and unattributed processes are investigation-only |
| Never terminable | Critical system processes, the current host, its launcher chain, and `extraWhitelistPids` |
| Whitelist | An extra whitelisted PID is an attribution root for investigation, and its descendants are visible but not terminable |
| Protected descendants | If the tree sampled immediately before the kill contains any protected PID, the whole operation is refused |

A protected descendant that appears after that sample cannot be excluded.

- Jobs have no stable PID mapping to OS processes.
- Command-line matches are investigative and never trigger automatic action.
- Findings and termination results are written to `$DSH_HOME/treekeeper/history.jsonl`.

## Development

Run before committing:

```sh
npm test
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
