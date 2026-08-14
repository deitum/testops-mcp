# Repository Guide

Guidance for developers and coding agents changing a clone of this repository. It is not runtime
documentation: the MCP server never reads or exposes this file, and no end-user workflow may depend
on it. Commands and house style live in [CONTRIBUTING.md](./CONTRIBUTING.md); what follows is the
contract that must survive a change.

## Product Contract

This repository is `@deitum/testops-mcp`, a stdio MCP server for Allure TestOps. An MCP client
spawns `dist/cli.js`, which exposes tools for test cases, Markdown import, launches and statistics.

The server is deliberately single-project:

- `TESTOPS_PROJECT_ID` is required and is the only source of the target project.
- Never expose `projectId` in an MCP input schema or in a caller-controlled request type.
- `TestOpsClient` must inject its configured project into every project-scoped API request. Caller
  data must not be able to override it.
- Before a public by-ID read or mutation whose endpoint is not reliably project-scoped, load the
  entity and fail closed unless its returned `projectId` matches the configured project. Internal
  post-create import writes may use the freshly created ID without another lookup.
- Working with another project means changing the environment value and restarting the server.

Markdown import is a single MCP operation with a complete preflight. `testcase_import_markdown` must
parse and validate the whole file, load the configured project's custom-field catalog, resolve
human-readable field and value names, and stop before creating the first case if preflight has
errors. Structurally invalid files must be rejected before the catalog request. After preflight,
writes are sequential and non-transactional: the result statuses are `completed`, `refused`,
`failed` and `outcome_unknown`, and the report distinguishes `created`, `partiallyCreated`,
`failedCase` and `notAttempted`. Never perform an import retry, deletion or rollback automatically.
Do not reintroduce legacy `mode`/`dryRun`, caller-supplied `projectId`, custom-field IDs in
Markdown, or a mandatory separate catalog call.

`testcase_markdown_guide` is the read-only authoring entry point for LLM clients. It exposes the
canonical rules from `docs/markdown-import.md` and the example from `examples/`; both are read from
the package root at runtime, so they must stay in `files` in `package.json` and beside the built
server. A ready Markdown file goes directly to `testcase_import_markdown` without a guide or
custom-field call first.

For a combined author-and-import request, the tool sequence is guide, save the file, then import. Do
not call `testcase_custom_fields` before the first import attempt; it is only for an explicit
catalog request or a user-requested repair after a field-related import diagnostic.

`testcase_delete` moves exactly one active case to Trash. The LLM must use the current name from
`testcase_get`, and the OpenCode example in the README must keep `testops_testcase_delete` at
permission `ask`. The server must require that exact name, verify the case belongs to the configured
project through the documented test-case endpoint before writing, and call
`DELETE /api/testcase/{id}` only with `force=false`. Never expose bulk or permanent deletion, and
never use deletion as automatic import rollback.

Trash search accepts only structured ID or name input. The server must build AQL internally, keep
the configured project and `deleted=true` constraints under its control, preserve ambiguous matches,
and never choose a case for the LLM. Do not expose raw AQL/RQL or a caller-supplied `projectId`.

`testcase_restore` restores exactly one case selected by `id` and exact `expectedName`. Before
writing, load the case through the documented endpoint and verify its ID, project, deleted state and
name. Send at most one restore request and validate the response; after an uncertain outcome,
perform one read-only reconciliation and never retry the mutation automatically. Do not expose bulk
or automatic restore.

Markdown-import scenarios are written through the TestOps V2 scenario endpoint. `testcase_add_steps`
appends through the single-step endpoint. In both paths, expected results must remain individual
expected-result child nodes, including for nested Markdown steps; do not flatten them into step text
or empty sibling steps.

Public search tools return one requested page with metadata and accept at most 50 items
(`MAX_PAGE_SIZE`). Custom-field search must use one server-side `/api/testcase/__search` request with
internally generated exact AQL; never expose raw AQL or scan all test cases and their values.

`testcase_add_steps` accepts only the plural `expectedResults`; each item becomes a separate
expected-result child. `testcase_set_tags` replaces the full non-empty tag set only after verifying
the configured project and the exact `expectedName` from `testcase_get`.

Authentication recovery may automatically retry only read-only requests. Never automatically replay
a mutation after a 401 response. `testcase_create` must validate the returned ID, exact name and
project when present, and report an unknown outcome without retrying after an uncertain write.

`testcase_add_issue_links` and Markdown issue keys create Jira URLs as external links through one V2
bulk request scoped to exactly one active test case and the configured project. They do not create
integrated TestOps Issues, and they never retry or fall back to another write endpoint. The Jira root
comes from `TESTOPS_JIRA_BASE_URL` and must never be hard-coded: with no root configured, the tool
fails before writing and import preflight rejects any file with issue keys, so nothing is created.

Launch tools use the documented `/api/launch` endpoints. Creation accepts only `name` plus the
server-owned project and must not be retried automatically after an unknown outcome. Update is
rename-only and requires the exact name returned by `launch_get`. Launch status changes are separate
lifecycle operations and are not exposed. A launch's test results come from the V2 folder tree
endpoint and are read only after the launch itself has been verified against the configured project;
`deleted` is a caller-chosen filter that defaults to active results. Project statistics come from
`/api/project/{id}/stats`.

## Project Layout

- `src/cli.ts` is the published binary: loads configuration and starts the stdio transport.
- `src/index.ts` is the library entry point and re-exports the public API.
- `src/server.ts` defines MCP-level instructions and registers the tool groups.
- `src/config.ts` owns environment parsing and URL validation.
- `src/testops.constants.ts` owns `SERVER_INFO`/`SERVER_VERSION` and the shared limits.
- `src/client/` contains TestOps HTTP/authentication code and shared API types.
- `src/tools/` contains MCP schemas and handlers.
- `src/import/` contains Markdown parsing, custom-field resolution, preflight, upload and report
  formatting.
- `docs/markdown-import.md` is the canonical LLM-facing contract for the Markdown format; it and
  `examples/` are shipped in the npm tarball and are read at runtime.
- `scripts/` holds the release version sync and the smoke test.
- `dist/` is generated; never edit it directly.

## Change Rules

- `npm run verify` is the gate: lint, format, types, tests, build, packaging. It is exactly what CI
  runs.
- Keep endpoint details in `TestOpsClient`, input validation in MCP schemas and import modules, and
  user-facing behaviour in `README.md` and `docs/`.
- `README.md` is human onboarding: setup, the safety boundaries, and one plain list that names every
  registered tool exactly once as ``- `tool_name` — description``. `registration.test.ts` parses
  that list, so a new tool that is not documented fails the build. Do not teach internal LLM call
  routing there.
- Keep tool descriptions concise and put non-obvious input rules in field descriptions or schemas.
  State mutation semantics explicitly when a tool name could be ambiguous.
- Tool IDs use `snake_case`; types use `PascalCase`; functions and variables use `camelCase`.
- Write diagnostics to stderr only. Stdout is reserved for the MCP protocol; `scripts/smoke.mjs`
  fails the build if that slips.
- Error messages name the environment variable to change — `TESTOPS_JIRA_BASE_URL` is worth more to
  the reader than the failure that replaced it.
- `docs/markdown-import.md` and `examples/` are Russian on purpose: they are the runtime contract
  returned to LLM clients, and the parser accepts both Russian and English section names. They are
  in `.prettierignore` so the formatter cannot alter them. Prose written for contributors —
  `README.md`, this file, `CONTRIBUTING.md`, `SECURITY.md` — is English.
- Do not preserve obsolete tool arguments or behaviour unless the user explicitly asks for
  compatibility.
- Every user-visible change carries a changeset (`npm run changeset`); docs-only and internal
  tooling changes do not.

## Verification and Safety

`npm run verify` is required after code changes. Add or update `*.test.ts` coverage for schema and
request-contract changes.

For MCP schema changes, verify the JSON Schema returned by an in-memory `client.listTools()` call.
With the current SDK, a root union may validate locally but be published to LLM clients as an empty
object; public tool inputs must use a root object schema.

Automated tests must use local HTTP fixtures, mocks or in-memory MCP transports. They must never
call a real TestOps instance, and must never create, update or delete real entities. A live write is
allowed only when the user explicitly asks for it and provides a safe target.

Never commit API keys, bearer tokens, authorization headers, environment files containing secrets,
or an internal hostname. Keep TLS verification enabled unless the environment has an explicitly
approved exception. Preserve unrelated working-tree changes.
