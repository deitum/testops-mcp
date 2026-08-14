# Security policy

## Supported versions

Security fixes are released for the latest published version only.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisory form](https://github.com/deitum/testops-mcp/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few working days.

## What this server can do to your project

Every tool operates in the one project named by `TESTOPS_PROJECT_ID`, and nothing a model says can
move it elsewhere — the ID is injected by the client, never accepted as a tool argument, and a by-ID
write is refused unless the entity really belongs to that project. Within it, the model can write:
it can create test cases, import a whole Markdown file of them, append steps, replace tags, add
issue links, rename launches, and move a test case to Trash.

Three things are worth understanding before pointing it at a project that matters.

**Deletion is a move to Trash, and only ever one case.** `testcase_delete` requires the exact current
name of the case, calls the API with `force=false`, and has no bulk or permanent form. It is also
never used as an import rollback. In a client that supports per-tool permissions, keeping it at
`ask` — as the README's OpenCode example does — makes that step explicit.

**Import is not transactional.** Preflight validates the whole file before anything is created, so a
bad file creates nothing. But once creation starts, the cases go in one at a time: a failure halfway
through leaves the earlier ones in TestOps. The report says precisely which were created, which were
partially created, which failed and which were never attempted — and the server never retries,
deletes or rolls back on its own.

**Markdown import reads the filesystem.** `TESTOPS_IMPORT_ROOTS` is the boundary: only absolute
paths that resolve — after following symlinks — inside one of those directories are read, and only
`.md`/`.markdown` files up to 2 MiB. Left unset, it defaults to the process's working directory, so
set it deliberately.

Beyond that, tool results are TestOps data, and TestOps data is untrusted input to whatever model
consumes it: case names, step text and custom-field values all come from your project and may say
anything.

## Credentials and transport

`TESTOPS_API_KEY` arrives through the environment, is exchanged for a bearer token, and both stay in
memory for the life of the process. Nothing is written to disk and nothing is logged: the startup
banner on stderr names the instance, the project and whether TLS verification and Jira links are on,
never a secret.

`TESTOPS_SSL_VERIFY=false` disables certificate verification for every TestOps request the process
makes. It exists for an internal instance whose certificate you have already accepted by other
means; prefer `NODE_EXTRA_CA_CERTS`, which trusts one chain instead of none.

`TESTOPS_BASE_URL` and `TESTOPS_JIRA_BASE_URL` are validated at startup: `https` outside localhost,
and no credentials, query or fragment — so a token cannot be smuggled into a URL and a request
cannot be redirected to a plain-text endpoint by configuration alone.
