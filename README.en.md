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
- A terminal session's reported pid is used as an exact attribution anchor, so processes started inside a terminal land under a `pty` root and are marked non-terminable.
- A cross-session census listing the live subagents of every session, not only the currently selected tree.
- A subagent residency level — `running` / `idle-resident` / `idle-parked` — taken from the turn timing projection rather than from store membership.
- Release a resident subagent and return its capacity slot. An in-process `spawn` / `fork` subagent is one Agent inside the same process with no killable OS process behind it, so release goes through a host primitive rather than `taskkill`. Off by default.
- Guarded tree termination (`taskkill /T /F`); the conditions are listed in the termination-guard table under "Safety and limits".
- Identify the plugin a process belongs to from the `node_modules` path in its command line, and keep finding and termination history.
- The DSH host descendants section is collapsed by default, with its count on the heading.
- The panel header shows the host kind, taken from the host process's executable path and command line; the process environment is not part of the decision.
- The desktop application's own Electron processes are listed as one group inside the unattributed section, and each member keeps its command line, pid, memory and age.
- A finding carries one of three confidence tiers: `exact`, confirmed by attribution into the host process tree and eligible for a tree kill; `indicative`, where the process fact is real and the attribution link is softer or missing (a degraded sample, or a survivor left by a previous host); `inferred`, produced by a heuristic rule alone and never eligible.
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
| `allowRelease` | `false` | Boolean | Enables resident-subagent release, separate from `allowKill` |
| `residencyThresholdMs` | `0` | `0` (off) or 60000–86400000 ms | Accumulated subagent turn time past which a row is promoted to a finding |
| `extraWhitelistPids` | `[]` | Array of PIDs | Additional protected PIDs |

## Subagent residency

The residency level on the panel is an observable fact, not an alert:

| Residency | Meaning |
| --- | --- |
| `running` | The projection holds a turn that has not closed |
| `idle-resident` | The turn has settled and the Agent is still alive. It holds a capacity slot and can still be continued with `send_message` |
| `idle-parked` | The child session is no longer in the store, so its capacity slot has been returned |
| no verdict | The host exposes no `sessionQuery`, or the projection cannot be read |

**Residency is not a leak.** Residency is by design — an idle subagent can still be continued — so it is not reported as a finding by default. Only accumulated turn time past `residencyThresholdMs` is promoted, and that threshold is off by default: how long counts as too long is your call.

The threshold rests on what the projection can answer: `subagentTiming`'s `settledMs` is the accumulated duration of completed turns, and the current turn's duration comes from `now - active.since`. The projection does not record when the last turn ended, so how long a subagent has been idle cannot be derived, and the verdict does not rest on idle duration.

The panel reports "resident N / idle M" and no capacity figure: `ctx.subagents.maxActiveSubagents` is a Volatile, private setting and cannot be read.

Only children live in the agents lineage get a projection read; the diagnostic rows of `listDescendants` have no child session to read and are skipped.

## Releasing a resident subagent

Release and tree termination are two different operations:

- **Release** returns the capacity slot a resident subagent holds (8 by default, one pool per top-level session). It goes through the host's public `drainChildren` primitive. The subagent can no longer be continued with `send_message` afterwards.
- **Stopping the current turn** ends only that turn and keeps the residency: the subagent still holds its capacity slot and can still be continued. This plugin does not perform it.

A resident subagent may have no OS process behind it at all — an in-process `spawn` / `fork` subagent is one Agent inside the host process. Release therefore never carries a `taskkill` along: a tree kill takes the target's own descendant tree with it, which has nothing to do with releasing.

Release guards:

| Guard | Rule |
| --- | --- |
| Switch | `allowRelease` is off by default and separate from `allowKill`; enabling termination does not enable release |
| Confirmation | The first click arms for 6 seconds, the second click opens the confirmation dialog |
| Parent | The parent must be the exact live Agent in the registry |
| Direct child | The target must be a direct child of that parent, checked against the agents lineage |
| Parent source | The parent is resolved from the server-side lineage; a `parentId` in the request body takes no part in the decision |
| Read surface | Only `session.header`'s `parentSession` / `origin` and `Agent.status` are read; no session content and no log |

The plugin reports no capacity figure: `ctx.subagents.maxActiveSubagents` is a Volatile, private setting and cannot be read.

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
| Remote reach | On a host configured with `trustedHosts` and listening on a non-loopback address, a remote peer holding a valid browser session reaches the API, `kill` included |
| Admission narrowing | This plugin does not narrow the host's Connection admission, and the kill guards below apply there as well |
| Traversal cancellation | Closing the panel, superseding a refresh, or disconnecting the HTTP request cancels an in-flight subagent descendant traversal and the cross-session census |

Kill guards:

| Guard | Rule |
| --- | --- |
| Arming | The first click arms the button for 6 seconds |
| Confirmation | The second click opens the browser confirmation dialog |
| Snapshot | Requires a complete snapshot no older than 15 seconds |
| Identity check | The PID creation time is compared with the snapshot on entry |
| Recheck before the kill | A fresh sample is taken and the creation time is compared again |
| Attribution | Only processes whose attribution root is the DSH host may be terminated, and unattributed processes are investigation-only |
| Terminal ownership | Processes attributed to a terminal session's pty, and their whole descendant subtree, are not terminable |
| Never terminable | Critical system processes, the current host, its launcher chain, and `extraWhitelistPids` |
| Whitelist | An extra whitelisted PID is an attribution root for investigation, and its descendants are visible but not terminable |
| Protected descendants | If the tree sampled immediately before the kill contains any protected PID, the whole operation is refused |

A protected descendant that appears after that sample cannot be excluded.

- Jobs have no stable PID mapping to OS processes.
- Command-line matches are investigative and never trigger automatic action.
- Findings and termination results are written to `$DSH_HOME/treekeeper/history.jsonl`.

## Terminal session attribution

There is no stable pid mapping between the job ledger and the OS, so reconciliation approximates the command line against the job label and reports `indicative`.

A terminal session is the one exception: the snapshots from `ctx.terminals.list(owner)` carry a `pid`, and that is the single place DSH is willing to hand a pid to a plugin. Those pids join the same multi-root attribution as new roots, so a terminal session's **whole descendant subtree** lands under `rootLabel: 'pty'` — the processes started inside a terminal are all below the pty, and labelling the pty row alone would not be enough.

A job row matching that pid is no longer `indicative`: it is marked `via: 'pty-pid'`, because a label match is two command-line texts containing each other while this is a pid the host itself reported.

**Processes attributed to a `pty` root are not terminable.** A dev server, watcher or `npm install` running in a terminal is legitimately owned by a live PTY, and ending it as if it were residue of the host tree means ending what the user is working with. The whole terminal-owned subtree is owned by that pty, so the pty root and every row below it carry the refusal code `pty_owned`.

On a host that does not expose terminal sessions, that whole path is absent: there is no `pty` attribution root, `FINDING_VIA` carries no `pty-pid`, and reconciliation keeps its previous shape.

## Development

Run `npm install` after the first checkout. The full pre-commit checks are listed under [Verify in AGENTS.md](./AGENTS.md#verify).

## License

[MIT](./LICENSE)
