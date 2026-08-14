/**
 * Kept in step with `package.json` by `scripts/sync-version.mjs`, which
 * `npm run changeset:version` runs after the release bump.
 */
export const SERVER_VERSION = '0.3.0';

/** Identity reported to the MCP client during initialisation. */
export const SERVER_INFO = {
  name: 'testops-mcp',
  version: SERVER_VERSION,
} as const;

/** Budget for a single TestOps request — an instance that hangs must fail one tool call. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** How many rows a search tool returns when the model does not say. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Ceiling on a page a tool may request. TestOps happily returns hundreds of
 * rows and the whole page ends up in the model's context, so the cap is
 * enforced here rather than trusted to the caller.
 */
export const MAX_PAGE_SIZE = 50;

/**
 * Ceiling on a Markdown import file (2 MiB). Preflight reads the whole file
 * into memory before it validates anything.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * Issue keys become links against `TESTOPS_JIRA_BASE_URL`. With no Jira root
 * configured the server refuses the write instead of guessing a host — both in
 * `testcase_add_issue_links` and, before anything is created, in import
 * preflight.
 */
export const JIRA_NOT_CONFIGURED_MESSAGE =
  'Jira links are not configured. Set TESTOPS_JIRA_BASE_URL to the Jira root ' +
  '(for example https://jira.example.com) and restart the server.';
