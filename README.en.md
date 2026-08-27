# dsh-treekeeper

Runtime process-tree reconciliation and governance plugin for DeepSeek Harness.

**Status: work in progress (skeleton).** The pure-function core (attribution, leak heuristics) is tested; host integration is not verified yet — see "Status".

## Problem

The DSH task ledger (the `jobs` registry and the subagent genealogy) records background work but carries no OS process facts: which processes a background bash or subagent left behind, whether they leaked, and who owns them is unanswered by the ledger and by every existing panel.

## What it does

- **Process-tree attribution**: periodic OS sampling; processes are walked down the ancestor chain to the harness root; whatever does not reach a known root lands in an "unattributed" bucket.
- **Leak heuristics**: same command line ≥N copies, survivors of dead parents, plugin-attributed children alive past a threshold.
- **Ledger reconciliation**: the cross-session `jobs` registry joined indicatively against the OS tree (`JobSnapshot` has no pid; the join matches command lines and is labeled indicative).
- **Plugin audit**: processes whose command line contains `node_modules/<pkg>/` are attributed to the plugin package that spawned them.
- **Tree kill**: `taskkill /T` behind a creation-time precheck (pid-reuse guard), protected-name and self-tree whitelists, client-side double confirmation, and a post-kill liveness check.

## Status

Implemented:

- Sampler (Windows CIM; degrades to `tasklist`, which disables attribution and says so);
- Attribution and leak heuristics (pure functions, covered by `node --test`);
- Host route `/dsh-treekeeper/api` (snapshot / jobs / subtree / history / kill / config);
- Browser panel (findings, unattributed bucket, job ledger, two-step kill).

Not verified / not done:

- CIM availability inside the host process, the real `jobs.list()` signature, panel slot — pending host integration;
- Subagent genealogy resolution (`@deepseek-ai/dsh-subagent` dynamic import written, fallback untested);
- Not published to npm; not submitted to awesome-dsh-plugin.

## Security model

- Same-origin guard on `/api` (Fetch Metadata + Origin + loopback Host); mutations are POST-only.
- Server-side kill gates: pid-reuse precheck, whitelist and protected system names, post-kill verification; every kill is appended to a local history file.
- Read-only sampling plus explicit kills only; no session content is read; nothing leaves the machine.

## Platform and limits

- Windows first; non-Windows sampling is not implemented.
- Processes spawned outside `ctx.subprocess` are only visible through the OS layer.
- macOS/Linux: roadmap.

## License

MIT
