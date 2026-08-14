#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { TestOpsClient } from './client/TestOpsClient';
import { loadConfig } from './config';
import { createTestOpsServer } from './server';
import { SERVER_INFO } from './testops.constants';

/**
 * stdio entry point: an MCP client spawns this process and speaks the protocol
 * over stdin/stdout. Nothing may be written to stdout except protocol frames —
 * every diagnostic goes to stderr.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const client = new TestOpsClient(config.baseUrl, config.apiKey, config.projectId, {
    sslVerify: config.sslVerify,
    ...(config.jiraBaseUrl ? { jiraBaseUrl: config.jiraBaseUrl } : {}),
  });
  const server = createTestOpsServer(client, { allowedMarkdownRoots: config.importRoots });

  await server.connect(new StdioServerTransport());
  console.error(
    `${SERVER_INFO.name} ${SERVER_INFO.version} ready — ${config.baseUrl}, ` +
      `project ${config.projectId}, TLS verification ${config.sslVerify ? 'on' : 'off'}, ` +
      `Jira links ${config.jiraBaseUrl ?? 'off (TESTOPS_JIRA_BASE_URL unset)'}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `Failed to start ${SERVER_INFO.name}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
