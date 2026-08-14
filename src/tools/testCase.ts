import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { type TestOpsClient } from '../client/TestOpsClient';
import type { TestCaseTrashSearchQuery } from '../client/types';
import { loadMarkdownGuide } from '../import/markdownGuide';
import {
  prepareMarkdownImport,
  serializeMarkdownImportReport,
  uploadPreparedMarkdownImport,
} from '../import/markdownImportService';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../testops.constants';

import { errorResult, jsonErrorResult, jsonResult } from './result';

export interface TestCaseToolOptions {
  allowedMarkdownRoots: readonly string[];
}

const positiveId = z.number().int().positive();
const pageNumber = z.number().int().nonnegative().default(0).describe('Zero-based page number.');
const pageSize = z
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Items per page; maximum ${MAX_PAGE_SIZE}.`);
const nonEmptyString = z.string().trim().min(1);
const aqlText = nonEmptyString.regex(
  // The control characters are the point: this is what keeps them out of the
  // AQL the server builds from this input.
  // eslint-disable-next-line no-control-regex
  /^[^"\\\u0000-\u001f\u007f]+$/u,
  'Must not contain quotes, backslashes, or control characters',
);
const issueKey = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]+-\d+$/, 'Issue key must look like PROJECT-123');
const issueKeys = z
  .array(issueKey)
  .min(1)
  .refine((keys) => new Set(keys).size === keys.length, 'Issue keys must be unique')
  .describe('Unique Jira issue keys; duplicates are rejected.');
const stepSchema = z
  .object({
    name: nonEmptyString,
    expectedResults: z.array(nonEmptyString).min(1).optional(),
  })
  .strict();
const markdownWorkflow = [
  'After preparing or repairing the file, call testcase_import_markdown only if the user requested import.',
  'For the first import attempt, call testcase_import_markdown without testcase_custom_fields; the importer loads the catalog itself.',
  'Call testcase_custom_fields only when the user explicitly requests the catalog or, after a field-related import diagnostic, asks to repair the file.',
].join(' ');
const trashSearchSchema = z
  .object({
    by: z.enum(['id', 'name']).describe('Choose one search mode and provide only its fields.'),
    id: positiveId
      .optional()
      .describe('Required and allowed only when by is "id"; omit for name search.'),
    name: aqlText
      .optional()
      .describe('Required and allowed only when by is "name"; omit for ID search.'),
    match: z
      .enum(['exact', 'contains'])
      .optional()
      .describe('Name search only; defaults to "contains".'),
    page: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Name search only; zero-based, defaults to 0.'),
    size: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe(`Name search only; defaults to ${DEFAULT_PAGE_SIZE}, maximum ${MAX_PAGE_SIZE}.`),
  })
  .strict();

export function registerTestCaseTools(
  server: McpServer,
  client: TestOpsClient,
  options: TestCaseToolOptions,
): void {
  server.registerTool(
    'testcase_search',
    {
      title: 'Test Case Search',
      description: 'Get one page of active test cases by partial name and exact workflow status.',
      inputSchema: {
        name: aqlText.optional(),
        status: aqlText.optional(),
        page: pageNumber,
        size: pageSize,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, status, page, size }) => {
      try {
        return jsonResult(await client.searchTestCases({ name, status, page, size }));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_get',
    {
      title: 'Get Test Case',
      description: 'Get a specific test case by ID.',
      inputSchema: {
        id: positiveId,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        return jsonResult(await client.getTestCase(id));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_trash_search',
    {
      title: 'Search Test Cases in Trash',
      description: [
        'Find deleted test cases in the configured project by exact ID or by name.',
        'Name search is paginated and may return duplicate names; never choose one candidate automatically.',
        'If the user asked only to search, do not restore anything.',
      ].join(' '),
      inputSchema: trashSearchSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        return jsonResult(await client.searchTestCasesInTrash(toTrashSearchQuery(input)));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_delete',
    {
      title: 'Delete Test Case to Trash',
      description: [
        'Move one active test case from the configured project to TestOps Trash.',
        'Call only after the user explicitly asks to delete this exact ID.',
        'Use testcase_get first and pass its current name unchanged as expectedName.',
        'Never use it automatically for cleanup or rollback. It does not permanently delete test cases.',
      ].join(' '),
      inputSchema: {
        id: positiveId,
        expectedName: nonEmptyString.describe(
          'Exact current test-case name returned by testcase_get.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, expectedName }) => {
      try {
        return jsonResult(await client.deleteTestCase(id, expectedName));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_restore',
    {
      title: 'Restore Test Case from Trash',
      description: [
        'Restore exactly one deleted test case in the configured project.',
        'Call only after the user explicitly asks to restore a candidate selected by ID.',
        'Pass the exact name returned by testcase_trash_search as expectedName.',
        'If search returned multiple candidates, ask the user to choose; never retry restoration automatically.',
      ].join(' '),
      inputSchema: {
        id: positiveId,
        expectedName: nonEmptyString.describe(
          'Exact current name returned by testcase_trash_search.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, expectedName }) => {
      try {
        return jsonResult(await client.restoreTestCase(id, expectedName));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_create',
    {
      title: 'Create Test Case',
      description:
        'Create a simple test case in the configured Allure TestOps project. If the result is unknown, do not retry automatically.',
      inputSchema: {
        name: nonEmptyString,
        description: nonEmptyString.optional(),
        status: nonEmptyString.optional().describe('Exact TestOps workflow status name.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, description, status }) => {
      try {
        return jsonResult(await client.createTestCase({ name, description, status }));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_markdown_guide',
    {
      title: 'Get TestOps Markdown Guide',
      description: [
        'Call this before creating, converting, or repairing Markdown for TestOps import.',
        markdownWorkflow,
      ].join(' '),
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const guide = await loadMarkdownGuide();
        return jsonResult({
          workflow: markdownWorkflow,
          projectId: client.configuredProjectId,
          allowedImportRoots: options.allowedMarkdownRoots,
          ...guide,
        });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_import_markdown',
    {
      title: 'Import Test Cases from Markdown',
      description: [
        'Import an existing .md/.markdown file into the configured project.',
        'This single call performs structural and custom-field preflight before creating any test case.',
        'completed means all cases and their data were created; refused means preflight created none; failed can leave fully or partially created cases; outcome_unknown means a case may exist without confirmation.',
        'When a structured report is returned, follow it and never perform a retry, deletion, or rollback automatically.',
      ].join(' '),
      inputSchema: {
        filePath: nonEmptyString.describe('Absolute path to the .md or .markdown file to import.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ filePath }) => {
      try {
        const preflight = await prepareMarkdownImport(
          filePath,
          client.configuredProjectId,
          client,
          {
            allowedRoots: options.allowedMarkdownRoots,
            issueLinksConfigured: client.issueLinksConfigured,
          },
        );
        const upload = await uploadPreparedMarkdownImport(preflight, client);
        const nextAction =
          upload.status === 'refused'
            ? 'Explain the reported errors and wait for the user. If they ask to repair the file, call testcase_markdown_guide before editing. For a field-related diagnostic, call testcase_custom_fields only if the user asks for the catalog or repair. Retry only when the user asks.'
            : upload.status === 'failed'
              ? 'Report created, partiallyCreated, failedCase, and notAttempted. Do not perform any retry, deletion, or rollback automatically. Reconcile the reported state and wait for the user to choose a recovery action.'
              : upload.status === 'outcome_unknown'
                ? 'Report the case with unknown outcome and all created and notAttempted cases. Reconcile whether the case exists in TestOps. Do not perform any retry, deletion, or rollback automatically; wait for the user.'
                : undefined;
        const payload = {
          ...upload.report,
          summary: serializeMarkdownImportReport(upload.report),
          ...(nextAction === undefined ? {} : { nextAction }),
        };
        return upload.status === 'completed' ? jsonResult(payload) : jsonErrorResult(payload);
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_custom_fields',
    {
      title: 'List Project Custom Fields',
      description: [
        'List human-readable custom fields and values for the configured project.',
        'This is not a prerequisite for the first Markdown import attempt because testcase_import_markdown loads the catalog itself.',
        'Call only when the user explicitly requests the catalog or, after a field-related import diagnostic, asks to repair the file.',
      ].join(' '),
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const fields = await client.listProjectCustomFields();
        const catalog = [];

        for (const field of fields) {
          const values = await client.listProjectCustomFieldValues(field.id);
          catalog.push({
            name: field.name,
            required: field.required,
            singleSelect: field.singleSelect,
            locked: field.locked === true,
            ...(field.defaultValueId === undefined
              ? {}
              : {
                  defaultValue:
                    values.find((value) => value.id === field.defaultValueId)?.name ?? null,
                }),
            values: values.map((value) => ({
              name: value.name,
              global: value.global,
            })),
          });
        }

        return jsonResult({
          projectId: client.configuredProjectId,
          fields: catalog,
        });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_steps',
    {
      title: 'Get Test Case Steps',
      description:
        'Get the hierarchical TestOps scenario, preserving nested steps, expected results, shared steps, and attachments.',
      inputSchema: {
        id: positiveId,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      try {
        return jsonResult(await client.getTestCaseSteps(id));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_history',
    {
      title: 'Get Test Case History',
      description: 'Get the execution history for a test case.',
      inputSchema: {
        id: positiveId,
        page: pageNumber,
        size: pageSize,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, page, size }) => {
      try {
        return jsonResult(await client.getTestCaseHistory(id, page, size));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_search_by_custom_field',
    {
      title: 'Search Test Cases by Custom Field',
      description:
        'Run one exact server-side search by human-readable custom-field name and value.',
      inputSchema: {
        fieldName: aqlText,
        value: aqlText,
        page: pageNumber,
        size: pageSize,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ fieldName, value, page, size }) => {
      try {
        return jsonResult(await client.searchTestCasesByCustomField(fieldName, value, page, size));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_set_tags',
    {
      title: 'Set Test Case Tags',
      description:
        'Replace all tags on one test case. Use testcase_get first and pass its exact current name.',
      inputSchema: {
        id: positiveId,
        expectedName: nonEmptyString.describe(
          'Exact current test-case name returned by testcase_get.',
        ),
        tags: z.array(nonEmptyString).min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, expectedName, tags }) => {
      try {
        await client.setTestCaseTags(id, expectedName, tags);
        return jsonResult({ success: true, testCaseId: id, name: expectedName, tags });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_add_steps',
    {
      title: 'Add Steps to Test Case',
      description:
        'Append steps sequentially; every expectedResults item becomes a separate expected result for its step. If writing fails, earlier nodes may remain.',
      inputSchema: {
        testCaseId: positiveId,
        steps: z.array(stepSchema).min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ testCaseId, steps }) => {
      try {
        await client.addTestCaseSteps(testCaseId, steps);
        return jsonResult({ success: true });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'testcase_add_issue_links',
    {
      title: 'Add Issue Links to Test Case',
      description:
        'Add Jira URLs as external links on one active test case in a single request. Links are built against the Jira root the server was configured with; without one the call is refused. If the request fails, its outcome may be unknown.',
      inputSchema: {
        testCaseId: positiveId,
        issueKeys,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ testCaseId, issueKeys }) => {
      try {
        await client.addTestCaseIssueLinks(testCaseId, issueKeys);
        return jsonResult({ success: true });
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );
}

function toTrashSearchQuery(input: z.infer<typeof trashSearchSchema>): TestCaseTrashSearchQuery {
  if (input.by === 'id') {
    if (input.id === undefined) {
      throw new Error('Trash search by ID requires id');
    }
    if (input.name !== undefined) {
      throw new Error('Trash search by ID does not accept name');
    }
    if (input.match !== undefined || input.page !== undefined || input.size !== undefined) {
      throw new Error('Trash search by ID does not accept match, page, or size');
    }
    return { by: 'id', id: input.id };
  }

  if (input.name === undefined) {
    throw new Error('Trash search by name requires name');
  }
  if (input.id !== undefined) {
    throw new Error('Trash search by name does not accept id');
  }
  return {
    by: 'name',
    name: input.name,
    match: input.match ?? 'contains',
    page: input.page ?? 0,
    size: input.size ?? DEFAULT_PAGE_SIZE,
  };
}
