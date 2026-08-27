# dsh-treekeeper

Runtime process-tree reconciliation and governance plugin for DeepSeek Harness.

**Status: work in progress (skeleton).** The pure-function core (attribution, leak heuristics) is tested; host integration is not verified yet — see "Status".

## Problem

DSH task and subagent seams carry no OS PIDs: which processes a background bash or subagent left behind, whether they leaked, and who owns them is unanswered by the ledger.

## What it does

- **Process-tree attribution**: periodic OS sampling attributes only descendants of the current DSH host PID; launch ancestors are protected but never claim sibling processes.
- **Leak heuristics**: same command line ≥N copies, survivors of dead parents, plugin-attributed children alive past a threshold.
- **Optional ledger reconciliation**: where the implementation exposes unowned jobs, join them indicatively against the OS tree (`JobSnapshot` has no PID; command-line matching is never a termination authority).
- **Plugin audit**: processes whose command line contains `node_modules/<pkg>/` are attributed to the plugin package that spawned them.
- **Tree kill**: `taskkill /T` behind a creation-time precheck (pid-reuse guard), protected-name and self-tree whitelists, client-side double confirmation, and a post-kill liveness check.

## Status

Implemented:

- Sampler (Windows CIM; degrades to `tasklist`, which disables attribution and says so);
- Attribution and leak heuristics (pure functions, covered by `node --test`);
- Host route `/dsh-treekeeper/api` (snapshot / jobs / subtree / history / kill / config), with `exact` / `unattributed` process evidence;
- Browser panel (findings, unattributed bucket, job ledger, two-step kill).

Not verified / not done:

- CIM availability inside the host process, webServer route, and panel slot — pending host integration;
- Subagent genealogy uses `ctx.subagents.listDescendants(rootSessionId)` but is not wired into the API/UI yet and requires an explicit root session;
- Not published to npm; not submitted to awesome-dsh-plugin.

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
