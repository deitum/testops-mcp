import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { formatTestOpsError } from '../client/error';

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function jsonErrorResult(value: unknown): CallToolResult {
  return {
    ...jsonResult(value),
    isError: true,
  };
}

export function errorResult(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `Error: ${formatTestOpsError(error)}`,
      },
    ],
    isError: true,
  };
}
