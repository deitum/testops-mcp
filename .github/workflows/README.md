# Workflows

| Workflow                                           | Trigger                                        | What it does                                             |
| -------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| [`ci.yml`](./ci.yml)                               | push to `master`, pull requests                | Lint, types, tests on a Node matrix, build and packaging |
| [`release.yml`](./release.yml)                     | push to `master`                               | Opens the version PR, or publishes to npm                |
| [`codeql-analysis.yml`](./codeql-analysis.yml)     | push to `master`, pull requests, Tue 01:30 UTC | Static security analysis                                 |
| [`dependency-review.yml`](./dependency-review.yml) | pull requests                                  | Blocks PRs that pull in known-vulnerable packages        |

Dependency bumps are proposed by Dependabot, configured in
[`../dependabot.yml`](../dependabot.yml): npm weekly (dev-dependency minor and patch updates
grouped into one PR), GitHub Actions monthly.

> **The two security workflows only run on a public repository.** Both code scanning and the
> dependency graph they rely on require GitHub Advanced Security when the repository is private,
> so on a private repository they can only ever fail. Each job is guarded with
> `if: ${{ !github.event.repository.private }}` and reports as _skipped_ instead; making the
> repository public re-enables them with no further changes.

## `ci.yml`

Three independent jobs, so a formatting slip doesn't hide a test failure:

- **lint** — `npm run lint`, `npm run format:check`, `npm run typecheck`.
- **test** — `npm test` on Node 20, 22 and 24 on Ubuntu, plus Node 22 on Windows. `fail-fast: false`,
  so one red cell doesn't cancel the rest. The Windows cell is there because MCP clients spawn this
  server on Windows too, and the repo enforces LF endings (`linebreak-style: unix`).
- **build** — `npm run build`, then `npm run check:package` (`publint --strict` and `attw` over an
  actual `npm pack` tarball), then `scripts/smoke.mjs`. The packaging check catches a broken
  `exports` map or a missing declaration file; the smoke test catches the things that only show up
  when the binary actually runs — a broken shebang, a missing dependency, or anything written to
  stdout that is not an MCP frame. It also calls `testcase_markdown_guide` and inspects the packed
  file list, because that tool reads `docs/` and `examples/` from the package root: drop them from
  `files` and nothing else in CI would notice.

Everything mirrors `npm run verify`, so a failure here reproduces locally with one command.

Runs are grouped by ref with `cancel-in-progress: true` — pushing again to a branch cancels the
superseded run.

## `release.yml`

Releases are driven by [changesets](https://github.com/changesets/changesets) (config in
[`../../.changeset/config.json`](../../.changeset/config.json)). The workflow has two modes, and
`changesets/action` picks between them automatically:

1. **Changesets are pending** → it opens or updates a `chore: version packages` pull request that
   applies the version bumps, rewrites `CHANGELOG.md`, syncs `SERVER_VERSION` in
   `src/testops.constants.ts` and refreshes `package-lock.json` (`npm run changeset:version`).
2. **No changesets pending** (i.e. that PR has just been merged) → it runs `npm run release`
   (`changeset publish`), which publishes any version not yet on the registry and pushes the git tag.

So: merging a feature PR never publishes; merging the version PR does.

### Required setup

- **`NPM_TOKEN`** repository secret — an npm automation token with publish rights on the `@deitum`
  scope. Nothing else is needed; `GITHUB_TOKEN` is provided by Actions.
- **Workflow permissions** — the job requests `contents: write` and `pull-requests: write` to push
  the version PR, and `id-token: write` for npm
  [provenance](https://docs.npmjs.com/generating-provenance-statements). Provenance is enabled
  through `publishConfig.provenance` in `package.json`; without `id-token: write` the publish step
  fails.
- In repository settings, Actions must be allowed to create pull requests.

Unlike the other workflows this one uses `cancel-in-progress: false`: cancelling a publish halfway
through is worse than running it twice.

## Adding a workflow

Keep the conventions the existing ones follow, since they are what makes these files boring to
review:

- Declare a least-privilege top-level `permissions:` block (start from `contents: read` and add per
  job only what that job needs).
- Set a `concurrency:` group.
- Pin actions to a major tag (`actions/checkout@v4`); Dependabot keeps them current.
- Take the Node version from `.nvmrc` via `node-version-file` rather than hard-coding it, except in
  the test matrix where the version is the point.
- Use `cache: npm` on `actions/setup-node` and install with `npm ci`.
