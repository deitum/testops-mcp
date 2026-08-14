# Contributing

Thanks for taking the time. Bug reports, TestOps deployments this does not fit yet, and tools that
answer a real question are all welcome.

## Getting set up

```bash
npm install
npm run verify
```

`verify` is exactly what CI runs: lint → format → types → tests → build → packaging checks. Node 20
or newer (`.nvmrc` pins 22 for development; CI also runs 20 and 24).

| Command                 | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `npm test`              | vitest, no network — every TestOps call goes to a local fixture |
| `npm run test:watch`    | the same in watch mode                                          |
| `npm run test:coverage` | coverage, with the thresholds CI enforces                       |
| `npm run build`         | `tsc` → `dist` (CommonJS, so `npx` can run `dist/cli.js`)       |
| `npm run inspector`     | build, then drive the server with the MCP inspector             |
| `npm run lint:fix`      | eslint --fix                                                    |
| `npm run format`        | prettier --write                                                |

## How the code is arranged

```
src/
  cli.ts                stdio entry point (the bin)
  index.ts              library entry point
  server.ts             builds the McpServer, its instructions and the tool groups
  config.ts             environment → TestOpsConfig, and the URL rules
  testops.constants.ts  server identity, timeouts, page and file limits
  client/
    TestOpsClient.ts    the whole REST surface, auth, and project scoping
    types.ts            shared API types
    error.ts            turns an axios failure into one readable line
  import/
    markdown.ts         the Markdown parser and its diagnostics
    customFieldResolver.ts  human-readable field/value names → project IDs
    markdownImportService.ts  preflight, sequential upload, report
    markdownGuide.ts    reads docs/ and examples/ from the package root
  tools/
    testCase.ts         15 test-case tools
    launches.ts         5 launch tools
    statistics.ts       the project statistics tool
    result.ts           the CallToolResult wrappers
docs/markdown-import.md   the import format — LLM-facing, Russian, shipped in the tarball
examples/                 the worked example the guide tool returns
```

Tests sit next to what they test (`config.ts` ↔ `config.test.ts`); the MCP surface as a whole is
covered by `tools/registration.test.ts` through an in-memory client.

## House rules

- **One project, injected not asked for.** No tool takes a `projectId`, and a by-ID write verifies
  the entity's project before it writes. See [AGENTS.md](./AGENTS.md) for the full contract.
- **Nothing on stdout but protocol frames.** The transport is stdio; every diagnostic goes to
  stderr. `scripts/smoke.mjs` fails the build if that slips.
- **A failing tool returns `isError`, it does not throw.** A model should be free to try a different
  argument rather than lose the turn.
- **A write is never replayed automatically.** Only reads are retried after a refreshed token; an
  unknown outcome is reported as unknown.
- **Error messages name the variable to change.** "Set `TESTOPS_JIRA_BASE_URL`" is worth more than
  the status code it replaces.
- **Tests never touch a real instance.** Use the local HTTP fixture in `client/TestOpsClient.test.ts`
  or an in-memory MCP transport.
- Constants live in `testops.constants.ts`, API types in `client/types.ts`.
- `docs/` and `examples/` are the runtime contract returned by `testcase_markdown_guide`. They are
  Russian on purpose, and `.prettierignore` keeps the formatter away from them.

## Adding a tool

1. Register it in `tools/testCase.ts`, `tools/launches.ts` or `tools/statistics.ts`, describing every
   argument with `.describe()` — that text is what the model reads.
2. Return through `jsonResult`/`errorResult` from `tools/result.ts` so failures come back as
   `isError`.
3. Keep the endpoint itself in `TestOpsClient`, with the project injected there.
4. Cover it in `tools/registration.test.ts` through the in-memory MCP client, **and add it to the
   README's tool list** — that test parses the list and fails if the two disagree.
5. If the tool count changes, update `EXPECTED_TOOL_COUNT` in `scripts/smoke.mjs`.

## Pull requests

- Include a changeset (`npm run changeset`) unless the change is docs-only or internal tooling. It
  is what versions and publishes the package.
- Keep `npm run verify` green.
- New behaviour needs a test; a bug fix needs the test that would have caught it.
