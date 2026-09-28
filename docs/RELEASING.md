# Releasing

A release is a tag. Pushing a branch publishes nothing. The examples below use
`dev`; any development branch behaves the same way.

## Which CI has to be green

- `compat.yml` and `docs.yml` both run on `pull_request` and on a push to `main`
  or `dev`, so the pull request carries the verdict. `publish.yml` runs only on a
  `v*` tag: it says whether the release went out, not whether a change is good.
- `docs.yml` runs `docs:check` and, on a pull request, requires both files of
  every bilingual pair to change together. A one-sided changelog edit fails here.
- `compat.yml` has two jobs. `static checks` (node 20 and node 24) installs
  dependencies and runs the unit suite, the syntax walk over `lib/*.js`,
  `npm pack --dry-run`, and the manifest checks.
  `boot DSH Web with bundle (…)` boots a real host.
- The two boot cells are not the same inspection, and their job names say so. The
  Windows cell also runs the unit tests, so the sampler and the kill gates
  execute on the platform this plugin samples (`full: sampler + kill gates`). The
  Linux cell covers routing, the deployed fence, and the documented
  `unsupported_platform` answer (`partial: routing + fence + platform verdict`):
  a green Linux cell says nothing about sampling.
- The badge at the front of the README badge row is `compat.yml` on `main`.

## publish.yml

Three jobs, and only the last one may write to the repository:

| Job | What it does | Permissions |
| --- | --- | --- |
| `release checks` (node 20 and node 24) | installs dependencies and runs step 3's checks against the tagged commit, plus the `lib/shared.js#VERSION` match and the plugin-shape import | `contents: read` |
| `publish to npm` | `npm publish --provenance` through npm Trusted Publishing; no npm credential lives in this repository | `contents: read`, `id-token: write` |
| `GitHub release from changelog` | cuts one changelog section with `scripts/release-notes.mjs` and calls `gh release` | `contents: write` |

That split is deliberate: `GITHUB_TOKEN` is exported into every step of a job, so
a `contents: write` job that also ran `npm test` would hand repository write
access to whatever an install hook or a test fixture decides to run. The release
job installs nothing and runs no tests. It waits for the npm job to finish, not
to succeed, so a version that was already on npm still gets its release notes.

Two gates stop a tag before npm sees it: the tag must name
`package.json#version`, and the tagged commit must be an ancestor of `main`.

## Checklist

1. On the development branch, choose `X.Y.Z` and update:
   - `package.json#version`
   - `lib/shared.js#VERSION`
   - the changelogs: turn `## Unreleased` into `## X.Y.Z - YYYY-MM-DD` in both
     `docs/CHANGELOG.md` and `docs/CHANGELOG.en.md`. Keep that heading format exactly —
     `scripts/release-notes.mjs` finds the section by matching it, and
     `test/version.test.js` fails when a changelog has no section for the version
     being shipped.
2. Make sure every embedded fragment matches its canonical source in
   `dsh-mini-utility-dock`: the loopback predicates, the host request guard, and
   the host HTTP glue in `lib/shared.js`, and the utility launcher in
   `lib/client.js`. `npm test` fails when one has drifted, and a sync script
   rewrites every marked block in that file:

   ```sh
   npm run guard:sync
   npm run http:sync
   npm run launcher:sync
   ```

   A `check` only compares the marked blocks its pinned dock version knows, so a
   block newer than that pin passes silently. Raise the pin and re-sync every
   block in one commit: two pushes — old bytes under a new pin, or the reverse —
   leave CI reporting ok about a file it never actually verified.

3. Run the checks this repository documents — the same commands as `Verify` in
   `AGENTS.md`:

   ```sh
   npm test
   npm run docs:check
   for f in lib/*.js; do node --check "$f"; done
   npm pack --dry-run
   ```

4. Commit and push the development branch, then open a pull request and wait for
   `compat` and `docs` to pass on it:

   ```sh
   git commit -am "chore: release X.Y.Z"
   git push origin dev
   ```

5. Merge the development branch into `main` with a merge commit, and push:

   ```sh
   git switch main
   git pull --ff-only origin main
   git merge --no-ff dev -m "merge: dev -> main"
   git push origin main
   ```

   Do not squash or rebase this merge. Either one replaces the commit you tested
   with a new SHA, so the commit the tag carries is no longer any commit `main`
   holds — and `publish.yml` refuses exactly that; see step 6.

6. Tag `main`, with the push from step 5 already done:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   If the merge happened on GitHub instead, get `main` first:
   `git switch main && git pull --ff-only origin main`.

   `publish.yml` rejects a tag that is not an ancestor of `main` —
   `tag vX.Y.Z points at <sha>, which is not on main` — and publishes nothing.
   That gate is why the tag comes after the merge: never tag the development
   branch, and never tag before `main` has the commit.

7. Check the run: the checks job, the npm publish, and the GitHub release whose
   notes are that changelog section.

Published npm versions are immutable. If a release is bad, deprecate it and
publish a new patch version. Never move a tag after npm publication.
