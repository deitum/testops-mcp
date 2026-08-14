import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { type TestOpsClient } from './client/TestOpsClient';
import { SERVER_INFO } from './testops.constants';
import { registerLaunchTools } from './tools/launches';
import { registerStatisticsTools } from './tools/statistics';
import { registerTestCaseTools } from './tools/testCase';

export function createServerInstructions(projectId: number): string {
  return [
    `This server is locked to Allure TestOps project ${projectId} from TESTOPS_PROJECT_ID.`,
    'Every tool operates only in that configured project.',
    'Do not ask for, infer, or pass projectId; changing the target project requires changing the server configuration and restarting it.',
    'Before creating, converting, or repairing Markdown for TestOps import, call testcase_markdown_guide.',
    'For a combined prepare-and-import request, call testcase_markdown_guide, save the file, then call testcase_import_markdown. For a ready existing file, call testcase_import_markdown directly.',
    'Do not call testcase_custom_fields before the first import attempt; call it only when the user explicitly requests the catalog or, after a field-related import diagnostic, asks to repair the file.',
    'After any structured import result whose status is not completed, explain the returned report and wait for the user. Do not perform any edit-and-retry, deletion, or rollback automatically; for failed or outcome_unknown, reconcile the reported state before the user chooses a recovery action.',
    'Call testcase_delete only after the user explicitly asks to delete that exact test case; use testcase_get first to obtain its current name.',
    'Never use testcase_delete automatically as cleanup or rollback after an import failure.',
    'Use testcase_trash_search to find deleted test cases; never select one of multiple candidates automatically.',
    'Call testcase_restore only after the user explicitly asks to restore the exact selected ID and name; never restore after a search-only request and never retry restoration automatically.',
    'Never retry testcase_create automatically when its outcome is unknown; report the error and wait for the user.',
    'If testcase_add_steps fails, earlier writes may remain. If testcase_add_issue_links fails, its outcome may be unknown. Report the failure, never retry automatically, and wait for the user.',
    'Call launch_create only after the user explicitly asks to create a launch; never retry it automatically when the outcome is unknown.',
    'Before launch_update, call launch_get and pass the current name exactly as expectedName.',
    'Before testcase_set_tags, call testcase_get and pass the current name exactly as expectedName.',
  ].join(' ');
}

export interface TestOpsServerOptions {
  allowedMarkdownRoots: readonly string[];
}

export function createTestOpsServer(
  client: TestOpsClient,
  options: TestOpsServerOptions,
): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: createServerInstructions(client.configuredProjectId),
  });

  registerTestCaseTools(server, client, {
    allowedMarkdownRoots: options.allowedMarkdownRoots,
  });
  registerLaunchTools(server, client);
  registerStatisticsTools(server, client);

  return server;
}
