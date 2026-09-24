# Agent guide

`dsh-treekeeper` is a Windows-only DSH host + web plugin. It reconciles the DSH job ledger with the OS process tree and offers guarded process-tree termination.

## Engineering

- Keep `package.json#version` and `lib/shared.js#VERSION` equal, and keep `README.md` / `README.en.md` and `CHANGELOG.md` / `CHANGELOG.en.md` in sync.
- The three marked blocks are generated from `dsh-mini-utility-dock`: `dsh-loopback-helpers` and `dsh-host-guard` in `lib/shared.js`, `dsh-utility-launcher` in `lib/client.js`. Edit the dock fragment and run the matching `*.sync` script (`loopback:sync` / `guard:sync` / `launcher:sync`); never edit a block. The guard block depends on the loopback block, so keep that order.
- `npm test` checks all three blocks against the dock version this repo pins (`launcher:check` / `loopback:check` / `guard:check`).
- `dsh-plugin-parity` (from the dock) is a manual diagnostic, not a CI gate: what it asserts cannot hold across checkouts that sit on different branches.
- Treat `lib/act.js`, the process allowlists, and the creation-time guards as safety-critical. Never widen what can be terminated without a test.
- Keep finding confidence, scope, source, and rule values consistent across the host, the client, and the agent tools.
- Report unsupported platforms explicitly: do not add an unverified non-Windows sampler.
- Read optional DSH services only inside `ctx.inject(...)` callbacks.

## Verify

```sh
npm test
npm run docs:check
node --check lib/index.js
node --check lib/client.js
npm pack --dry-run
```
