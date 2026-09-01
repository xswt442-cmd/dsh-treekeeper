# Agent guide

`dsh-treekeeper` is a Windows-only DSH host + web plugin. It reconciles the DSH job ledger with the OS process tree and offers guarded process-tree termination.

## Workflow

- Do not commit directly to `main`. Use a development branch such as `dev`.
- Use lowercase Conventional Commit prefixes.
- Never bypass repository hooks with `--no-verify`.
- Keep disposable scripts and generated artifacts out of tracked source.
- Do not link this working tree into a running DSH profile.
- Read `RELEASING.md` only when publishing.

## Engineering

- Prefer root-cause fixes to patches and workarounds.
- Refactor when it simplifies the requested change or prevents technical debt.
- Keep changes focused; avoid unrelated or speculative refactors.
- Keep `package.json#version` and `lib/shared.js#VERSION` equal.
- Access optional DSH services only inside `ctx.inject(...)` callbacks.
- Treat `lib/act.js`, process allowlists, and creation-time guards as safety-critical. Never broaden termination without tests.
- Keep finding confidence, scope, source, and rule values consistent across the host, client, and agent tools.
- Do not add an unverified non-Windows sampler. Report unsupported platforms explicitly.
- Keep `README.md` / `README.en.md` and `CHANGELOG.md` / `CHANGELOG.en.md` in sync.

## Verify

```sh
npm test
npm run docs:check
node --check lib/index.js
node --check lib/client.js
npm pack --dry-run
```
