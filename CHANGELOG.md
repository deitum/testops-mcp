# @deitum/testops-mcp

## 0.3.0

### Minor Changes

- d619fa8: Add `launch_test_results`: one page of a launch's test results, each with its name, status and test
  case. The launch is verified against the configured project before the results are read, and
  `deleted` selects active results by default or the deleted ones instead.

## 0.2.0

### Minor Changes

- 252152f: First public release: an MCP server for Allure TestOps, locked to a single project. Test-case
  search, read and write; Markdown authoring and a preflighted single-call import; launches; project
  statistics. The Jira root behind issue links is configuration (`TESTOPS_JIRA_BASE_URL`) and the
  issue-link paths fail closed without it.
