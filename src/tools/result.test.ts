import assert from 'node:assert/strict';

import { test } from 'vitest';

import { errorResult } from './result';

test('tool errors preserve the useful TestOps response message', () => {
  const result = errorResult({
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: {
      data: { message: 'Workflow status was not found' },
    },
  });

  assert.equal(result.isError, true);
  const first = result.content[0];
  assert.equal(first.type, 'text');
  if (first.type !== 'text') assert.fail('Expected text tool content');
  assert.equal(first.text, 'Error: Workflow status was not found');
});
