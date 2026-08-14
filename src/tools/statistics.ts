import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { type TestOpsClient } from '../client/TestOpsClient';

import { errorResult, jsonResult } from './result';

export function registerStatisticsTools(server: McpServer, client: TestOpsClient): void {
  server.registerTool(
    'statistics_overall',
    {
      title: 'Overall Statistics',
      description:
        'Get launch count, manual and automated test-case counts, and automation percentage for the configured project.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        return jsonResult(await client.getOverallStatistics());
      } catch (error: unknown) {
        return errorResult(error);
      }
    },
  );
}
