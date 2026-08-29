# dsh-treekeeper

Runtime process-tree reconciliation and governance plugin for DeepSeek Harness.

**Status: v0.1.0-dev, not published.** The Windows local profile has been manually integrated; this branch remains development-only and is not an npm release.

## Problem

DSH task and subagent seams carry no OS PIDs: which processes a background bash or subagent left behind, whether they leaked, and who owns them is unanswered by the ledger.

## What it does

- **Process-tree attribution**: periodic OS sampling attributes only descendants of the current DSH host PID; launch ancestors are protected but never claim sibling processes.
- **Leak heuristics**: same command line ≥N copies, survivors of dead parents, plugin-attributed children alive past a threshold.
- **Optional ledger reconciliation**: where the implementation exposes unowned jobs, join them indicatively against the OS tree (`JobSnapshot` has no PID; command-line matching is never a termination authority).
- **Plugin audit**: processes whose command line contains `node_modules/<pkg>/` are attributed to the plugin package that spawned them.
- **Tree kill**: `taskkill /T` behind a creation-time precheck (pid-reuse guard), protected-name and self-tree whitelists, client-side double confirmation, and a post-kill liveness check.
- **Shared entry**: shares the main-content bottom-left Utility Dock with dsh-instance-manager; it follows the sidebar width without occupying the sidebar footer or Settings action.

## Status

Implemented:

- Sampler (Windows CIM; degrades to `tasklist`, which disables attribution and says so);
- Attribution and leak heuristics (pure functions, covered by `node --test`);
- Host route `/dsh-treekeeper/api` (snapshot / jobs / subtree / history / kill / config), with `exact` / `unattributed` process evidence;
- Browser panel (findings, unattributed bucket, job ledger, two-step kill), with visible loading, degraded, and operation-failure states.
- Both the Utility Dock entry and overlay wait for the DSH slots service, avoiding silent absence from bundle mount order.

Not verified / not done:

- Subagent genealogy uses `ctx.subagents.listDescendants(rootSessionId)` but is not wired into the API/UI yet and requires an explicit root session;
- Not published to npm; not submitted to awesome-dsh-plugin.

## Development install

For a development-only test profile on the current `dev` branch, install from the local directory:

```powershell
dsh plugin --profile web add .
```

After restarting the test profile, DIM and TreeKeeper appear together in the shared Utility Dock. Do not treat this development branch as a published release.

## Security model

- Same-origin guard on `/api` (Fetch Metadata + Origin + loopback Host); mutations are POST-only.
- Server-side kill gates: a recent complete snapshot, mandatory creation-time recheck, whitelist and protected system names, post-kill verification; every kill is appended to a local history file.
- Read-only sampling plus explicit kills only; no session content is read; nothing leaves the machine.

## Platform and limits

- Windows first; non-Windows sampling is not implemented.
- Processes spawned outside `ctx.subprocess` are only visible through the OS layer.
- macOS/Linux: roadmap.

## License

MIT
