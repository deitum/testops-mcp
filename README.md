# @deitum/testops-mcp

An [MCP](https://modelcontextprotocol.io) server for **Allure TestOps**: search, read and write test
cases, author a whole suite in Markdown and import it in one call, manage launches, and read project
statistics — all locked to a single project.

```bash
npx @deitum/testops-mcp
```

It speaks MCP over stdio and is configured entirely through environment variables.

The server is deliberately **single-project**: `TESTOPS_PROJECT_ID` is the only source of the target
project, it is never part of a tool's input, and the model cannot reach another project by asking.
Pointing it somewhere else means changing the configuration and restarting.

## Setting it up in a client

**Claude Desktop** (`claude_desktop_config.json`), **Cursor**, **Windsurf** and anything else that
reads the same shape:

```json
{
  "mcpServers": {
    "testops": {
      "command": "npx",
      "args": ["-y", "@deitum/testops-mcp"],
      "env": {
        "TESTOPS_BASE_URL": "https://testops.example.com",
        "TESTOPS_API_KEY": "your-api-token",
        "TESTOPS_PROJECT_ID": "23",
        "TESTOPS_IMPORT_ROOTS": "/Users/you/test-cases"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add testops \
  --env TESTOPS_BASE_URL=https://testops.example.com \
  --env TESTOPS_API_KEY=your-api-token \
  --env TESTOPS_PROJECT_ID=23 \
  -- npx -y @deitum/testops-mcp
```

**VS Code** (`.mcp.json` / `.vscode/mcp.json`), where the token is prompted for rather than written
down:

```json
{
  "inputs": [
    {
      "id": "testops-token",
      "type": "promptString",
      "description": "Allure TestOps API token",
      "password": true
    }
  ],
  "servers": {
    "testops": {
      "command": "npx",
      "args": ["-y", "@deitum/testops-mcp"],
      "env": {
        "TESTOPS_BASE_URL": "https://testops.example.com",
        "TESTOPS_API_KEY": "${input:testops-token}",
        "TESTOPS_PROJECT_ID": "23"
      }
    }
  }
}
```

**OpenCode** (`~/.config/opencode/opencode.json`, or `%USERPROFILE%\.config\opencode\opencode.json`
on Windows). Note that `permission` sits beside `mcp`, not inside it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "testops": {
      "type": "local",
      "enabled": true,
      "command": ["npx", "-y", "@deitum/testops-mcp"],
      "environment": {
        "TESTOPS_BASE_URL": "https://testops.example.com",
        "TESTOPS_API_KEY": "your-api-token",
        "TESTOPS_PROJECT_ID": "23",
        "TESTOPS_IMPORT_ROOTS": "/Users/you/test-cases"
      }
    }
  },
  "permission": {
    "testops_testcase_delete": "ask"
  }
}
```

The API token comes from TestOps itself: your avatar → **API Tokens** → **+ Token**.

## Configuration

| Variable                | Required | Meaning                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------- |
| `TESTOPS_BASE_URL`      | yes      | TestOps root, no path (`https://testops.example.com`).                    |
| `TESTOPS_API_KEY`       | yes      | Personal API token, exchanged for a bearer token on first use.            |
| `TESTOPS_PROJECT_ID`    | yes      | The one project every tool operates in.                                   |
| `TESTOPS_IMPORT_ROOTS`  | –        | Directories Markdown import may read, `PATH`-separated. Default: the cwd. |
| `TESTOPS_JIRA_BASE_URL` | –        | Jira root for issue links. Unset, the issue-link paths refuse to write.   |
| `TESTOPS_SSL_VERIFY`    | –        | `false` disables TLS verification. Default on; see [TLS](#tls).           |

`TESTOPS_BASE_URL` must be `https` outside localhost and must carry no credentials, query, fragment
or path. `TESTOPS_JIRA_BASE_URL` follows the same rules but may carry a path, since Jira is often
published under one (`https://jira.example.com/jira`).

### Issue links

Issue keys — from `testcase_add_issue_links`, or from a `Ссылки` / `Issues` section in an imported
file — become external links of the form `<TESTOPS_JIRA_BASE_URL>/browse/KEY`. They are external
links, not integrated TestOps Issues.

With no Jira root configured the server does not guess a host: `testcase_add_issue_links` fails
before it writes anything, and an import file containing issue keys is rejected during preflight, so
no case is created.

### TLS

An instance behind a certificate Node does not trust fails with `SELF_SIGNED_CERT_IN_CHAIN`. Prefer
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`, which trusts that one chain. `TESTOPS_SSL_VERIFY=false` is
the blunt alternative — it turns verification off for every TestOps request the process makes — and
is worth it only for an internal instance whose certificate you have already accepted by other
means.

## Safety model

- **One project.** Every project-scoped request carries the configured ID, injected by the client
  rather than taken from the model. Before a by-ID write, the entity is loaded and refused if it
  belongs to another project.
- **Deletion means Trash.** `testcase_delete` moves exactly one case — named exactly as
  `testcase_get` returned it — to Trash (`force=false`). There is no bulk and no permanent delete,
  and deletion is never used as an import rollback.
- **Writes are never replayed on their own.** After an expired token only reads are retried. A write
  whose outcome is unknown is reported as unknown: the model is told to reconcile and wait, not to
  try again.
- **Import is preflighted, then non-transactional.** Nothing is created until the whole file and the
  project's custom-field catalog have been validated. After that, cases are created one at a time:
  if one fails, the earlier ones remain, and the report says exactly which are `created`,
  `partiallyCreated`, `failedCase` and `notAttempted`.

## Authoring and importing Markdown

A whole suite can be written as one Markdown file and imported in a single call. The format carries
a description, preconditions, nested steps with individual expected results, tags, issue keys and
custom fields addressed by their human-readable names — the server resolves those against the
project's catalog.

The intended flow is: ask the model for the file, read it yourself, then ask for the import. The
rules do not need to be pasted into the conversation — `testcase_markdown_guide` hands the model the
canonical format and a worked example, and the model is instructed to call it before writing or
repairing a file. A file that is already written goes straight to `testcase_import_markdown`.

The file must be an absolute path inside one of `TESTOPS_IMPORT_ROOTS`. For a human reference:
[the format](docs/markdown-import.md) and
[the example](examples/testops-markdown-import-example.md).

## Tools

Test cases:

- `testcase_search` — one page of active cases by partial name and exact workflow status.
- `testcase_get` — one test case by ID.
- `testcase_steps` — a case's scenario tree, its steps and expected results.
- `testcase_history` — a case's execution history.
- `testcase_search_by_custom_field` — one server-side search by exact custom-field name and value.
- `testcase_custom_fields` — the project's custom fields and their allowed values.
- `testcase_markdown_guide` — the Markdown rules and the example, for the model to write against.
- `testcase_import_markdown` — validate a Markdown file and import every case in it.
- `testcase_create` — create one simple test case.
- `testcase_add_steps` — append steps, each with its own expected results.
- `testcase_set_tags` — replace a case's whole tag set.
- `testcase_add_issue_links` — add Jira keys as external links on one active case.
- `testcase_delete` — move exactly one confirmed case to Trash.
- `testcase_trash_search` — find deleted cases by ID or by name.
- `testcase_restore` — restore exactly one case chosen by ID and name.

Launches:

- `launch_list` — one page of launches.
- `launch_get` — one launch by ID.
- `launch_create` — create a launch.
- `launch_update` — rename a launch, given its exact current name.
- `launch_statistic` — a launch's result counts by status.

Project:

- `statistics_overall` — launch and test-case counts, and the automation percentage.

Search tools return one requested page with its metadata and accept at most 50 items, so a large
project cannot land in the model's context whole. The AQL behind a search is built by the server: no
tool accepts a raw query.

## Troubleshooting

| Symptom                                                | What it means                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `Failed to get bearer token`                           | `TESTOPS_API_KEY` is wrong, revoked, or from another instance.     |
| `SELF_SIGNED_CERT_IN_CHAIN`                            | Node does not trust the chain; see [TLS](#tls).                    |
| `belongs to project N, but this server is configured…` | The case exists, but not in `TESTOPS_PROJECT_ID`.                  |
| `Set TESTOPS_JIRA_BASE_URL`                            | Issue keys were used with no Jira root configured.                 |
| `Markdown file is outside the configured import roots` | The path is not under `TESTOPS_IMPORT_ROOTS`.                      |
| `status: refused` from an import                       | Preflight failed and **nothing** was created; the report says why. |

## Using it as a library

The stdio binary is the point, but the server is exported too — for a custom transport or a test
harness:

```ts
import { createTestOpsServer, loadConfig, TestOpsClient } from '@deitum/testops-mcp';

const config = loadConfig();
const client = new TestOpsClient(config.baseUrl, config.apiKey, config.projectId, {
  sslVerify: config.sslVerify,
});
const server = createTestOpsServer(client, { allowedMarkdownRoots: config.importRoots });
await server.connect(myTransport);
```

## Development

```bash
npm install
npm run verify        # lint, format, types, tests, build, packaging
npm test              # vitest, no network — every TestOps call goes to a local fixture
npm run inspector     # build, then drive it with the MCP inspector
```

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

[MIT](./LICENSE).
