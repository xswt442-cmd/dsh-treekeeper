# dsh-treekeeper

[中文](./README.md) | [English](./README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-treekeeper)](https://www.npmjs.com/package/dsh-treekeeper)
![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

A DSH Web runtime process-tree reconciliation plugin. It samples descendants of the current DSH host, shows them beside the available background-job ledger, and surfaces likely leaks, orphaned processes, and unattributed processes. Destructive actions are guarded.

## Features

- **Host process tree**: attributes only descendants of the current DSH host. Launcher ancestors are protected, but never claim sibling processes.
- **Findings**: detects duplicate command lines, survivors of exited parents, and long-lived plugin children.
- **Ledger reconciliation**: uses DSH's owner fence to list unowned jobs and jobs for every live session, then makes indicative command-line matches.
- **Subagent tree**: calls `subagents.listDescendants()` for the current session and shows durable lineage, depth, mode, and activity without waking cold sessions.
- **Plugin attribution**: identifies the source package from `node_modules/<package>/` command-line paths.
- **Guarded tree kill**: runs `taskkill /T /F` on a confirmed process tree; see Security model for the full checks.
- **Utility Dock**: Use the dock in the bottom-left corner of the Session settings as the entry point.

## Install

```powershell
dsh plugin --profile web add dsh-treekeeper
# Or install directly from Git
dsh plugin --profile web add github:xswt442-cmd/dsh-treekeeper
```

Restart DSH Web after installation. Open the panel from the TreeKeeper entry at the bottom left of the main content area.

## How it works

The host registers the same-origin API at `/dsh-treekeeper/api`.

| Action | Method | Description |
|---|---|---|
| `snapshot&rootSessionId=` | GET | Samples processes, attribution, findings, jobs, and the selected session's subagent tree; OS snapshots are reused for two seconds |
| `jobs` | GET | Returns unowned jobs and jobs visible to every live owner |
| `subagents&rootSessionId=` | GET | Returns the complete durable subagent tree below one session |
| `subtree&pid=` | GET | Returns the current process subtree for a PID |
| `history` | GET | Returns the latest 100 local finding and action records |
| `config` | POST | Updates runtime polling, tree-kill access, and additional whitelisted PIDs |
| `kill` | POST | Terminates a verified process tree with `{ pid, seenCreatedMs }` |

Windows CIM is the primary process sampler. If it is unavailable, TreeKeeper falls back to `tasklist`. Fallback mode has no parent chain, so attribution and tree kill are disabled and the panel says so.

## Security model

- The API accepts loopback same-origin requests only. Fetch Metadata, `Origin`, and `Host` checks block cross-site calls and DNS rebinding.
- Mutating actions are POST-only.
- Tree kill requires a complete snapshot no older than 15 seconds and rechecks the PID creation time to prevent PID reuse.
- Critical system names, the current DSH host, its launcher chain, and configured whitelisted PIDs cannot be terminated.
- TreeKeeper checks liveness after the operation and appends findings and termination results to `$DSH_HOME/treekeeper/history.jsonl`.

## Configuration

`config` is runtime-only and resets when the instance restarts.

| Field | Default | Description |
|---|---:|---|
| `pollMs` | `0` | Background sample interval in milliseconds; `0` samples on request only, minimum active value is `2000` |
| `allowKill` | `true` | Enables guarded tree kill |
| `extraWhitelistPids` | `[]` | Additional protected PIDs |

The duplicate command-line threshold is fixed at three copies. The long-lived plugin-child threshold is fixed at 30 minutes.

## Platform and limits

- Windows is currently supported; other platforms do not provide process sampling.
- Attribution follows OS parent-child relationships. Processes started outside the DSH subprocess interface remain visible but may not map to a specific task.
- The job ledger has no stable PID mapping to OS processes. Command-line matching is for investigation only and never terminates a process automatically.

## Layout

```
package.json       npm metadata and DSH declarations
cordis.patch.yml   profile loader patch
lib/index.js       host API and runtime state
lib/client.js      Utility Dock entry and panel
lib/sampler.js     Windows process sampling
lib/attribute.js   process attribution and subtree calculation
lib/leak.js        finding rules
lib/act.js         guarded tree kill
lib/ledger.js      DSH owner-aware jobs and subagent-tree adapters
test/              node:test suite
```

## License

[MIT](./LICENSE)
