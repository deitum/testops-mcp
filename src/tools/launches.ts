import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { type TestOpsClient } from '../client/TestOpsClient';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../testops.constants';

import { errorResult, jsonResult } from './result';

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

export function registerLaunchTools(server: McpServer, client: TestOpsClient): void {
  server.registerTool(
    'launch_list',
    {
      title: 'List Launches',
      description: 'Get one page of launches in the configured Allure TestOps project.',
      inputSchema: {
        page: pageNumber,
        size: pageSize,
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ page, size }) => {
      try {
        return jsonResult(await client.listLaunches({ page, size }));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'launch_get',
    {
      title: 'Get Launch',
      description: 'Get a specific launch by ID.',
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
        return jsonResult(await client.getLaunch(id));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'launch_create',
    {
      title: 'Create Launch',
      description:
        'Create one launch only when the user explicitly asks. Never retry automatically if its outcome is unknown.',
      inputSchema: {
        name: nonEmptyString,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name }) => {
      try {
        return jsonResult(await client.createLaunch({ name }));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'launch_update',
    {
      title: 'Update Launch',
      description: 'Rename one launch. Use launch_get first and pass its exact current name.',
      inputSchema: {
        id: positiveId,
        expectedName: nonEmptyString.describe('Exact current launch name returned by launch_get.'),
        name: nonEmptyString.describe('New launch name.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, expectedName, name }) => {
      try {
        return jsonResult(await client.updateLaunch(id, expectedName, name));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'launch_statistic',
    {
      title: 'Get Launch Statistics',
      description: 'Get execution-status counts for a launch.',
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
        return jsonResult(await client.getLaunchStatistics(id));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'launch_test_results',
    {
      title: 'Get Launch Test Results',
      description:
        'Get one page of the test results in a launch, with their statuses and test cases. An item of type "LEAF" is one test result; any other type is a folder that groups them and carries no status.',
      inputSchema: {
        id: positiveId,
        page: pageNumber,
        size: pageSize,
        deleted: z
          .boolean()
          .default(false)
          .describe('Return deleted results instead of active ones.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, page, size, deleted }) => {
      try {
        return jsonResult(await client.getLaunchTestResults(id, { page, size, deleted }));
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );
}
