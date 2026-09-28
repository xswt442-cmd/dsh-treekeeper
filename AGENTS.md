# Agent guide

`dsh-treekeeper` is a Windows-only DSH host + web plugin. It reconciles the DSH job ledger with the OS process tree and offers guarded process-tree termination.

## Engineering

- Keep `package.json#version` and `lib/shared.js#VERSION` equal, and keep `README.md` / `README.en.md` and `docs/CHANGELOG.md` / `docs/CHANGELOG.en.md` in sync.
- The four marked blocks are generated from `dsh-mini-utility-dock`: `dsh-loopback-helpers`, `dsh-host-guard` and `dsh-host-http` in `lib/shared.js`, `dsh-utility-launcher` in `lib/client.js`. Edit the dock fragment and run the matching `*.sync` script (`loopback:sync` / `guard:sync` / `http:sync` / `launcher:sync`); never edit a block. The guard block depends on the loopback block, so keep that order, and the HTTP glue lands below the guard — that is the block order, and `lib/shared.js` keeps exactly one pair of markers per block.
- `npm test` checks every block against the dock version this repo pins (`launcher:check` / `loopback:check` / `guard:check` / `http:check`). The `shared.js` script names are synonymous by design, not four separate inspections: the CLI selects the blocks from the markers present in the target file that its own version carries, so one `check lib/shared.js` verifies the host-side blocks it knows in a single pass.
- A `check` only compares the marked blocks its pinned dock version knows, so a block newer than that pin passes silently — never read a green `http:check` as proof that the third block matches. `test/host-http.test.js` is what asserts each block's markers appear exactly once and in order. Raise the pin and re-sync every block in the same commit: two separate pushes leave CI reporting ok about a file it did not actually verify.
- The HTTP glue is what `lib/shared.js` used to hand-write: `sendJson`, `optionalSessionId` and the browser authorizer come from the block, so the `cache-control: no-store` reply policy has one source. This plugin keeps the fragment's default POST vocabulary (`code: 'method'`); a route's unexpected failure answers a fixed `code` only — an exception message never goes into a response body, it is logged instead, because it reaches the browser and can name a host path.
- `lib/index.js` authorizes a request with one call, `authorizeBrowser(req, res)`. Do not put the Connection branches back inline in the route: the order they decide in — a Connection that throws answers 503 and never reaches the handler, and a reload gap after a Connection has existed never falls back to the loopback guard — is the security property, and it lives in the fragment.
- `dsh-plugin-parity` (from the dock) is a manual diagnostic, not a CI gate: what it asserts cannot hold across checkouts that sit on different branches.
- `docs.config.mjs` declares this repository's bilingual documentation pairs — the two paths of each pair and the shape it is compared by — and `docs:check` passes it to `dsh-plugin-docs` with `--config`. The checker names no document of its own, so a pair moves or a new one appears by editing that file alone.
- Treat `lib/act.js`, the process allowlists, and the creation-time guards as safety-critical. Never widen what can be terminated without a test.
- Keep finding confidence, scope, source, and rule values consistent across the host, the client, and the agent tools.
- Report unsupported platforms explicitly: do not add an unverified non-Windows sampler.
- Read optional DSH services only inside `ctx.inject(...)` callbacks.
- The supported DSH floor lives in three places and must agree: the README badge, `engines.dsh`, and `peerDependencies['@deepseek-ai/dsh']` (marked optional in `peerDependenciesMeta` so npm never installs the host because of it). DSH's startup preflight compares that peer against the running version with prereleases included and disables the row when it does not match, and the only override is an exact-version `dsh plugin allow-version` exemption. The range carries no upper bound on purpose: a ceiling would disable this plugin on the host's next release, and the exemption path accepts an exact version only.
- The ambient `sidebar.session.row.*` occupants read only cached client facts and never cause a host read: the leading cell mounts on every idle row, so a fetch, a session binding, or a subscription there would turn a passive badge into per-row host work.

## Changelog

- `docs/CHANGELOG.md` and `docs/CHANGELOG.en.md` stay in step: the same sections, the same number of bullets, the same order.
- One bullet per change — what changed and why it matters, in at most two short sentences — counting prose, not the inline code identifiers a bullet names (roughly 120 CJK characters or 240 letters of it, and a whole version section stays under about 900 CJK characters). A version section is published verbatim as the GitHub release notes, so its reader is someone using this plugin, not its historian.
- No implementation narrative and no root-cause essay. "It used to do X, which was wrong because Y, so now Z" is one bullet about Z; the rest belongs in the commit message or a handoff note. A bullet that needs a subordinate clause to justify itself has one clause too many.
- The same register as the README: state what ships, in the tool's own technical vocabulary. No conversational verbs ("the pin rises to", "this now compares it for real", "one call asks it all"), no quotation marks used for emphasis, and no colon-then-explanation flourish.
- `Unreleased` records what a reader other than the author would notice. Deferred work and "X was left alone because it needs a product call" are handoff notes, not changelog entries.
- Do not name another repository. The test is a reader who cloned only this one: a sentence that only parses if they also know what a sibling checkout does cannot be verified and adds nothing — state what this repository does. `dsh-mini-utility-dock` is the single exception, and only where it genuinely is the subject: it is a dependency this package declares, and these blocks are synced from it.

## Verify

```sh
npm test
npm run docs:check
for f in lib/*.js; do node --check "$f"; done
npm pack --dry-run
```
