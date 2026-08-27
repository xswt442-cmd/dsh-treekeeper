# dsh-treekeeper

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**Ledger ↔ OS reconciliation engine with unified governance for DeepSeek Harness.** Does the official task ledger (background jobs, subagent genealogy) match the processes actually alive on your machine? Whatever does not — leaked MCP servers, orphaned npx chains, unattributed residents — gets attributed, aged, and killed behind guards.

[中文](README.md) | English

## Why

- **Jobs have no process view**: `JobSnapshot` knows the owning session but carries no pid. Whether a background bash or subagent left OS children behind is nobody's business today.
- **Children leak**: the same MCP server relaunched again and again, old copies never exiting — dozens of node/cmd processes eating memory, invisible to every existing panel.
- **Plugins raise processes**: every vision/MCP/terminal plugin may leave resident children behind; nothing audits them after install.

## What it does

- **Process-tree attribution**: periodic OS samples, ancestor-walked down from the harness root; every process labeled (harness / some plugin / unattributed) with memory and age.
- **Leak heuristics**: same command line ≥N copies, orphaned survivors of dead parents, over-long plugin children.
- **Ledger reconciliation**: the cross-session jobs registry and subagent genealogy joined (indicatively) against the OS tree; jobs without processes and processes without owners both get called out.
- **Guarded tree kill**: creation-time precheck (pid-reuse guard), protected-name and self-tree whitelists, double confirmation, post-kill verification.
- **Plugin audit**: attribute resident children back to the plugin that spawned them via `node_modules/<pkg>` paths.

## Install

```sh
dsh plugin --profile web add dsh-treekeeper
```

## Use

A "🌳 TreeKeeper" floating button appears in the web UI (bottom-left). The panel shows leak findings, the unattributed bucket, and the cross-session job ledger with guarded kill buttons (two-click arm + system confirm; the server re-checks creation time and whitelists).

## Security model

- Same-origin guard on `/api` (Fetch Metadata + Origin + loopback Host), POST-only mutations.
- Server-side kill gates: whitelist, protected system names, pid-reuse precheck; every kill lands in a local history file.
- Read-only sampling plus explicit kills only; no session content is read, nothing leaves the machine.

## Platform

Windows first (CIM sampling; automatic `tasklist` degradation disables attribution and says so). macOS/Linux samplers are on the roadmap.

## Known limits

- Job ↔ process joins are **indicative** (official `JobSnapshot` has no pid) — labeled as such, never auto-killed.
- Processes spawned outside `ctx.subprocess` are only visible through the OS layer.

## License

MIT
