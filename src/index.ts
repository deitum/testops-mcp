/**
 * Library entry point, for embedding the server in another process (a custom
 * transport, an in-process MCP host, a test harness). The stdio binary is
 * `cli.ts`, which is what `npx @deitum/testops-mcp` runs.
 */
export { formatTestOpsError } from './client/error';
export {
  ImportedTestCaseCreateError,
  ImportedTestCaseOutcomeUnknownError,
  LaunchCreateOutcomeUnknownError,
  TestCaseCreateOutcomeUnknownError,
  TestCaseRestoreOutcomeUnknownError,
  TestOpsClient,
  type TestOpsClientOptions,
} from './client/TestOpsClient';
export type {
  Launch,
  LaunchCreateRequest,
  LaunchSearchParams,
  LaunchTestResult,
  LaunchTestResultSearchParams,
  PageResult,
  ProjectCustomField,
  ProjectCustomFieldValue,
  ProjectStatistics,
  ResolvedCustomFieldAssignment,
  ScenarioStep,
  TestCase,
  TestCaseCreateRequest,
  TestCaseCustomFieldSearchResult,
  TestCaseDeleteResult,
  TestCaseHistory,
  TestCaseHistoryItem,
  TestCaseImportCreateRequest,
  TestCaseRestoreResult,
  TestCaseScenario,
  TestCaseScenarioStep,
  TestCaseSearchParams,
  TestCaseTrashSearchQuery,
  TestCaseTrashSearchResult,
  TestCaseTrashSummary,
  TestCaseWorkflowStatus,
  TestStatus,
  TestStatusCount,
} from './client/types';
export { loadConfig, type TestOpsConfig } from './config';
export { loadMarkdownGuide, type MarkdownGuide } from './import/markdownGuide';
export { createServerInstructions, createTestOpsServer, type TestOpsServerOptions } from './server';
export {
  JIRA_NOT_CONFIGURED_MESSAGE,
  MAX_IMPORT_BYTES,
  SERVER_INFO,
  SERVER_VERSION,
} from './testops.constants';
