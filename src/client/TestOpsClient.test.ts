import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

import { test } from 'vitest';

import { parseMarkdownImport } from '../import/markdown';

import {
  ImportedTestCaseCreateError,
  ImportedTestCaseOutcomeUnknownError,
  LaunchCreateOutcomeUnknownError,
  TestCaseCreateOutcomeUnknownError,
  TestOpsClient,
} from './TestOpsClient';
import type { ResolvedCustomFieldAssignment, ScenarioStep } from './types';

type RequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
) => void | Promise<void>;

function scenario(text: string = 'Do something'): ScenarioStep[] {
  return [{ text, depth: 0, expectedResults: [] }];
}

test('authentication is lazy and concurrent initialization shares one token request', async (context) => {
  let tokenRequests = 0;
  const fixture = await startServer(async (_request, response, url) => {
    assert.equal(url.pathname, '/api/uaa/oauth/token');
    tokenRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeJson(response, 200, { access_token: 'token-1' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.equal(tokenRequests, 0);

  await Promise.all([client.initialize(), client.initialize(), client.initialize()]);
  assert.equal(tokenRequests, 1);
});

test('a protected 401 refreshes once and retries with the new Authorization header', async (context) => {
  let tokenRequests = 0;
  const authorizations: Array<string | undefined> = [];
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      tokenRequests += 1;
      writeJson(response, 200, { access_token: `token-${tokenRequests}` });
      return;
    }

    assert.equal(url.pathname, '/api/project/23/cf');
    authorizations.push(request.headers.authorization);
    if (request.headers.authorization === 'Bearer token-1') {
      writeJson(response, 401, { message: 'expired' });
      return;
    }
    writeJson(response, 200, { content: [], last: true, totalPages: 1 });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await client.initialize();
  await client.listProjectCustomFields();

  assert.equal(tokenRequests, 2);
  assert.deepEqual(authorizations, ['Bearer token-1', 'Bearer token-2']);
});

test('token endpoint failures do not enter the protected-request retry interceptor', async (context) => {
  let tokenRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    assert.equal(url.pathname, '/api/uaa/oauth/token');
    tokenRequests += 1;
    writeJson(response, 401, { message: 'bad api token' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(client.initialize(), /Failed to get bearer token: bad api token/);
  assert.equal(tokenRequests, 1);
});

test('a protected request is retried only once when the refreshed token is also rejected', async (context) => {
  let tokenRequests = 0;
  let protectedRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      tokenRequests += 1;
      writeJson(response, 200, { access_token: `token-${tokenRequests}` });
      return;
    }

    protectedRequests += 1;
    writeJson(response, 401, { message: 'still unauthorized' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(client.listProjectCustomFields(), /status code 401/);
  assert.equal(tokenRequests, 2);
  assert.equal(protectedRequests, 2);
});

test('project-scoped requests cannot override the configured project at runtime', async (context) => {
  const projectIds: unknown[] = [];
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/__search') {
      projectIds.push(url.searchParams.get('projectId'));
      writeJson(response, 200, {
        content: [],
        number: 0,
        size: 20,
        totalElements: 0,
        totalPages: 0,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/rs/testcase') {
      projectIds.push(((await readJson(request)) as { projectId?: unknown }).projectId);
      writeJson(response, 201, { id: 1, name: 'Created case' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/launch') {
      projectIds.push(url.searchParams.get('projectId'));
      writeJson(response, 200, {
        content: [],
        number: 0,
        size: 20,
        totalElements: 0,
        totalPages: 0,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/launch') {
      projectIds.push(((await readJson(request)) as { projectId?: unknown }).projectId);
      writeJson(response, 201, { id: 2, name: 'Created launch', projectId: 17 });
      return;
    }

    assert.equal(request.method, 'GET');
    assert.equal(url.pathname, '/api/project/17/stats');
    projectIds.push(17);
    writeJson(response, 200, {
      launches: 0,
      manualTestCases: 0,
      automatedTestCases: 0,
      automationPercent: 0,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17);
  const searchOverrideAttempt = {
    projectId: 23,
    page: 0,
    size: 20,
  } as Parameters<TestOpsClient['searchTestCases']>[0] & { projectId: number };
  const createCaseOverrideAttempt = {
    name: 'Created case',
    projectId: 23,
  } as Parameters<TestOpsClient['createTestCase']>[0] & { projectId: number };
  const launchSearchOverrideAttempt = {
    projectId: 23,
    page: 0,
    size: 20,
  } as Parameters<TestOpsClient['listLaunches']>[0] & { projectId: number };
  const createLaunchOverrideAttempt = {
    name: 'Created launch',
    projectId: 23,
  } as Parameters<TestOpsClient['createLaunch']>[0] & { projectId: number };

  await client.searchTestCases(searchOverrideAttempt);
  await client.createTestCase(createCaseOverrideAttempt);
  await client.listLaunches(launchSearchOverrideAttempt);
  await client.createLaunch(createLaunchOverrideAttempt);
  await client.getOverallStatistics();

  assert.deepEqual(projectIds, ['17', 17, '17', 17, 17]);
});

test('simple test-case creation is not replayed after 401 and the next explicit call refreshes auth', async (context) => {
  let tokenRequests = 0;
  let createRequests = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      tokenRequests++;
      writeJson(response, 200, { access_token: `token-${tokenRequests}` });
      return;
    }

    assert.equal(url.pathname, '/api/rs/testcase');
    createRequests++;
    if (createRequests === 1) {
      assert.equal(request.headers.authorization, 'Bearer token-1');
      writeJson(response, 401, { message: 'expired' });
      return;
    }
    assert.equal(request.headers.authorization, 'Bearer token-2');
    writeJson(response, 201, { id: 42, name: 'Do not duplicate', projectId: 23 });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(client.createTestCase({ name: 'Do not duplicate' }), /status code 401/);
  assert.equal(tokenRequests, 1);
  assert.equal(createRequests, 1);
  assert.deepEqual(await client.createTestCase({ name: 'Do not duplicate' }), {
    id: 42,
    name: 'Do not duplicate',
    projectId: 23,
  });
  assert.equal(tokenRequests, 2);
  assert.equal(createRequests, 2);
});

test('simple test-case creation validates responses and reports unknown outcomes', async (context) => {
  const responses = [
    { status: 500, body: { message: 'create result unavailable' } },
    { status: 201, body: {} },
    { status: 201, body: { id: 42, name: 'Different case', projectId: 23 } },
    { status: 201, body: { id: 43, name: 'Created case', projectId: 99 } },
    { status: 201, body: { id: 44, name: 'Created case', projectId: 23 } },
  ];
  let createRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/rs/testcase');
    const planned = responses[createRequests++];
    writeJson(response, planned.status, planned.body);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  for (const expectedMessage of [
    /create result unavailable/,
    /Invalid created test case id/,
    /named "Different case", not "Created case"/,
    /belongs to project 99/,
  ]) {
    await assert.rejects(
      client.createTestCase({ name: 'Created case' }),
      (error) =>
        error instanceof TestCaseCreateOutcomeUnknownError && expectedMessage.test(error.message),
    );
  }

  assert.deepEqual(await client.createTestCase({ name: 'Created case' }), {
    id: 44,
    name: 'Created case',
    projectId: 23,
  });
  assert.equal(createRequests, responses.length);
});

test('public test-case reads preserve workflow status objects while validating identity and name', async (context) => {
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (url.pathname === '/api/rs/testcase/42') {
      writeJson(response, 200, { id: 99, name: 'Wrong case', projectId: 23 });
      return;
    }
    if (url.pathname === '/api/rs/testcase/43') {
      writeJson(response, 200, { id: 43, name: '   ', projectId: 23 });
      return;
    }
    if (url.pathname === '/api/rs/testcase/44') {
      writeJson(response, 200, {
        id: 44,
        name: 'Case with status',
        projectId: 23,
        status: {
          id: -1,
          name: 'Draft',
          color: '#6B7280',
          createdBy: 'system',
        },
      });
      return;
    }
    writeJson(response, 404, { message: 'unexpected request' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(client.getTestCase(42), /returned test case 99 when 42 was requested/);
  await assert.rejects(client.getTestCase(43), /Invalid test case 43 name/);
  assert.deepEqual((await client.getTestCase(44)).status, {
    id: -1,
    name: 'Draft',
    color: '#6B7280',
    createdBy: 'system',
  });
});

test('test-case steps preserve and validate the hierarchical scenario', async (context) => {
  const scenario = {
    attachments: {},
    root: { id: 0, children: [10] },
    scenarioSteps: {
      '10': {
        id: 10,
        body: 'Action',
        bodyJson: textDocument('Action'),
        children: [11],
        expectedResultId: 20,
        createdBy: 'author',
      },
      '11': { id: 11, body: 'Nested action', children: [] },
      '20': { id: 20, children: [21, 22] },
      '21': { id: 21, body: 'First result', children: [] },
      '22': { id: 22, body: 'Second result', children: [] },
    },
    sharedStepAttachments: {},
    sharedStepScenarioSteps: {
      'shared-child': { body: 'Shared nested action', children: [] },
    },
    sharedSteps: {
      'shared-root': { body: 'Shared action', children: [] },
    },
  };
  const scenarioResponses = [
    scenario,
    {},
    [],
    { root: { children: 'broken' }, scenarioSteps: {} },
    { root: { children: [] }, scenarioSteps: [] },
    { root: { children: [10] }, scenarioSteps: { '10': { id: 'broken' } } },
    { root: { children: [10] }, scenarioSteps: { '10': { id: 10, bodyJson: null } } },
  ];
  let stepRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (url.pathname === '/api/rs/testcase/42') {
      writeJson(response, 200, { id: 42, name: 'Case', projectId: 23 });
      return;
    }

    assert.equal(url.pathname, '/api/testcase/42/step');
    assert.equal(url.search, '');
    writeJson(response, 200, scenarioResponses[stepRequests++]);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(await client.getTestCaseSteps(42), scenario);
  assert.deepEqual(await client.getTestCaseSteps(42), {});
  await assert.rejects(client.getTestCaseSteps(42), /scenario response: expected an object/);
  await assert.rejects(client.getTestCaseSteps(42), /scenario root children/);
  await assert.rejects(client.getTestCaseSteps(42), /scenario steps: expected an object/);
  await assert.rejects(client.getTestCaseSteps(42), /scenario steps 10 id/);
  await assert.rejects(client.getTestCaseSteps(42), /scenario steps 10 bodyJson/);
  assert.equal(stepRequests, scenarioResponses.length);
});

test('test-case search uses scoped AQL and normalizes one page of active results', async (context) => {
  let searchRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/testcase/__search');
    assert.equal(url.searchParams.get('projectId'), '23');
    assert.equal(url.searchParams.get('deleted'), 'false');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('size'), '20');
    searchRequests++;

    if (url.searchParams.get('rql')?.includes('Malformed')) {
      writeJson(response, 200, {
        content: [],
        number: '2',
        size: 20,
        totalElements: 0,
        totalPages: 0,
      });
      return;
    }

    assert.equal(url.searchParams.get('rql'), 'name ~= "Checkout" and status = "Active"');
    writeJson(response, 200, {
      content: [
        {
          id: 41,
          name: 'Checkout',
          projectId: 23,
          deleted: false,
          status: { id: 5, name: 'Active', color: '#22C55E' },
        },
      ],
      number: 2,
      size: 20,
      totalElements: 41,
      totalPages: 3,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(
    await client.searchTestCases({
      name: 'Checkout',
      status: 'Active',
      page: 2,
      size: 20,
    }),
    {
      items: [
        {
          id: 41,
          name: 'Checkout',
          projectId: 23,
          deleted: false,
          status: { id: 5, name: 'Active', color: '#22C55E' },
        },
      ],
      page: 2,
      size: 20,
      totalElements: 41,
      totalPages: 3,
    },
  );
  await assert.rejects(client.searchTestCases({ name: 'Malformed', page: 2, size: 20 }));
  assert.equal(searchRequests, 2);
});

test('custom-field search sends one AQL request and rejects unsafe literals before HTTP', async (context) => {
  let requests = 0;
  let searchRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    requests++;
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    searchRequests++;
    assert.equal(url.pathname, '/api/testcase/__search');
    assert.equal(url.searchParams.get('projectId'), '23');
    assert.equal(url.searchParams.get('deleted'), 'false');
    assert.equal(url.searchParams.get('rql'), 'cf["Component"] = "UI Selenide"');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get('size'), '15');
    writeJson(response, 200, {
      content: [{ id: 51, name: 'UI case', projectId: 23, deleted: false }],
      number: 1,
      size: 15,
      totalElements: 16,
      totalPages: 2,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(await client.searchTestCasesByCustomField('Component', 'UI Selenide', 1, 15), {
    projectId: 23,
    query: { fieldName: 'Component', value: 'UI Selenide', match: 'exact' },
    items: [{ id: 51, name: 'UI case', projectId: 23, deleted: false }],
    page: 1,
    size: 15,
    totalElements: 16,
    totalPages: 2,
  });
  const requestsBeforeInvalidInputs = requests;
  await assert.rejects(
    client.searchTestCasesByCustomField('Bad"field', 'UI Selenide', 0, 20),
    /cannot contain quotes, backslashes, or control characters/,
  );
  await assert.rejects(
    client.searchTestCasesByCustomField('Component', 'Bad\\value', 0, 20),
    /cannot contain quotes, backslashes, or control characters/,
  );
  assert.equal(requests, requestsBeforeInvalidInputs);
  assert.equal(searchRequests, 1);
});

test('test-case history normalizes page metadata to items', async (context) => {
  let historyRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (url.pathname === '/api/rs/testcase/42') {
      assert.equal(url.searchParams.get('projectId'), '23');
      writeJson(response, 200, { id: 42, name: 'History case', projectId: 23 });
      return;
    }

    assert.equal(url.pathname, '/api/rs/testcase/42/history');
    assert.equal(url.searchParams.get('projectId'), '23');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(url.searchParams.get('size'), '10');
    historyRequests++;
    writeJson(response, 200, {
      content: [
        {
          id: 91,
          testCaseId: historyRequests === 1 ? 42 : 99,
          projectId: 23,
          status: 'passed',
        },
      ],
      number: 1,
      size: 10,
      totalElements: 11,
      totalPages: 2,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(await client.getTestCaseHistory(42, 1, 10), {
    items: [{ id: 91, testCaseId: 42, projectId: 23, status: 'passed' }],
    page: 1,
    size: 10,
    totalElements: 11,
    totalPages: 2,
  });
  await assert.rejects(
    client.getTestCaseHistory(42, 1, 10),
    /returned history for test case 99 when 42 was requested/,
  );
});

test('last metadata overrides a short first page without totalPages', async (context) => {
  const requestedPages: number[] = [];
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    writeJson(
      response,
      200,
      page === 0
        ? {
            content: [
              {
                id: 1001,
                required: false,
                customField: {
                  id: 1,
                  name: 'First',
                  required: false,
                  locked: false,
                  singleSelect: false,
                },
              },
            ],
            last: false,
          }
        : {
            content: [
              {
                id: 1002,
                required: false,
                customField: {
                  id: 2,
                  name: 'Second',
                  required: false,
                  locked: false,
                  singleSelect: false,
                },
              },
            ],
            last: true,
          },
    );
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  const fields = await client.listProjectCustomFields();

  assert.deepEqual(requestedPages, [0, 1]);
  assert.deepEqual(
    fields.map((field) => field.name),
    ['First', 'Second'],
  );
});

test('catalog pagination accepts a metadata-free terminal page and rejects malformed metadata', async (context) => {
  const responses = [
    { content: [] },
    { content: [], last: false },
    { content: [], totalPages: -1 },
    { content: [], last: false, totalPages: 1 },
  ];
  let catalogRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/project/23/cf');
    assert.equal(url.searchParams.get('page'), '0');
    writeJson(response, 200, responses[catalogRequests++]);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(await client.listProjectCustomFields(), []);
  for (const expectedMessage of [
    /page 0 is empty before the last page/,
    /Invalid paginated response page 0 totalPages/,
    /page 0 is not last at totalPages 1/,
  ]) {
    await assert.rejects(client.listProjectCustomFields(), expectedMessage);
  }
  assert.equal(catalogRequests, responses.length);
});

test('custom-field catalog rejects a non-integer default value ID', async (context) => {
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/project/23/cf');
    writeJson(response, 200, {
      content: [
        {
          id: 1001,
          required: false,
          defaultCustomFieldValueId: '101',
          customField: {
            id: 1,
            name: 'Team',
            required: false,
            locked: false,
            singleSelect: true,
          },
        },
      ],
      last: true,
      totalPages: 1,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(
    client.listProjectCustomFields(),
    /Invalid project custom field 0 default value id/,
  );
});

test('custom-field catalogs are fully paginated and resolved assignments use the working TestOps REST endpoint', async (context) => {
  const fieldsPageOne = Array.from({ length: 100 }, (_, index) => ({
    id: 10_000 + index,
    required: false,
    locked: index === 0,
    defaultCustomFieldValueId: index === 0 ? 501 : undefined,
    customField: {
      id: index + 1,
      name: `Field ${index + 1}`,
      required: false,
      locked: false,
      singleSelect: false,
    },
  }));
  const valuesPageOne = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Value ${index + 1}`,
    global: false,
    customField: { id: 7 },
  }));
  let customFieldBody: unknown;
  let tagBody: unknown;

  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (url.pathname === '/api/project/23/cf') {
      const page = Number(url.searchParams.get('page'));
      writeJson(
        response,
        200,
        page === 0
          ? { content: fieldsPageOne, last: false, totalPages: 2 }
          : {
              content: [
                {
                  id: 10_101,
                  required: true,
                  locked: false,
                  defaultCustomFieldValueId: 601,
                  customField: {
                    id: 101,
                    name: 'Field 101',
                    required: false,
                    locked: true,
                    singleSelect: true,
                  },
                },
              ],
              last: true,
              totalPages: 2,
            },
      );
      return;
    }

    if (url.pathname === '/api/project/23/cfv') {
      assert.equal(url.searchParams.get('customFieldId'), '7');
      const page = Number(url.searchParams.get('page'));
      writeJson(
        response,
        200,
        page === 0
          ? { content: valuesPageOne, last: false, totalPages: 2 }
          : {
              content: [
                {
                  id: 101,
                  name: 'Value 101',
                  global: true,
                  customField: { id: 7 },
                },
              ],
              last: true,
              totalPages: 2,
            },
      );
      return;
    }

    if (url.pathname === '/api/rs/testcase/42/cfv') {
      assert.equal(request.method, 'POST');
      assert.equal(url.searchParams.get('projectId'), '23');
      customFieldBody = await readJson(request);
      writeJson(response, 204);
      return;
    }

    if (url.pathname === '/api/rs/testcase/42') {
      assert.equal(request.method, 'GET');
      assert.equal(url.searchParams.get('projectId'), '23');
      writeJson(response, 200, { id: 42, name: 'Existing case', projectId: 23 });
      return;
    }

    if (url.pathname === '/api/testcase/42') {
      assert.equal(request.method, 'GET');
      assert.equal(url.search, '');
      writeJson(response, 200, {
        id: 42,
        name: 'Existing case',
        projectId: 23,
        deleted: false,
      });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/testcase/42/tag');
    tagBody = await readJson(request);
    writeJson(response, 204);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  const fields = await client.listProjectCustomFields();
  const values = await client.listProjectCustomFieldValues(7);
  await client.setTestCaseCustomFields(42, [
    assignment(7, [11, 12]),
    assignment(7, [12, 13]),
    assignment(8, [21]),
  ]);
  await client.setTestCaseTags(42, 'Existing case', ['smoke', 'mcp-upload']);

  assert.equal(fields.length, 101);
  assert.equal(values.length, 101);
  assert.deepEqual(fields[0], {
    id: 1,
    name: 'Field 1',
    required: false,
    singleSelect: false,
    locked: true,
    defaultValueId: 501,
  });
  assert.deepEqual(fields[100], {
    id: 101,
    name: 'Field 101',
    required: true,
    singleSelect: true,
    locked: true,
    defaultValueId: 601,
  });
  assert.deepEqual(values[100], {
    id: 101,
    fieldId: 7,
    name: 'Value 101',
    global: true,
  });
  assert.deepEqual(customFieldBody, [
    { id: 11, customField: { id: 7 }, name: 'Value 11' },
    { id: 12, customField: { id: 7 }, name: 'Value 12' },
    { id: 13, customField: { id: 7 }, name: 'Value 13' },
    { id: 21, customField: { id: 8 }, name: 'Value 21' },
  ]);
  assert.deepEqual(tagBody, [{ name: 'smoke' }, { name: 'mcp-upload' }]);
});

test('custom-field value catalogs reject values that belong to another field', async (context) => {
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/project/23/cfv');
    assert.equal(url.searchParams.get('customFieldId'), '7');
    writeJson(response, 200, {
      content: [
        {
          id: 101,
          name: 'Foreign value',
          global: false,
          customField: { id: 8 },
        },
      ],
      last: true,
      totalPages: 1,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(
    client.listProjectCustomFieldValues(7),
    /item 0 belongs to field 8, expected field 7/,
  );
});

test('public tag updates require the exact current test-case name before writing', async (context) => {
  let tagWrites = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (url.pathname === '/api/testcase/44') {
      writeJson(response, 200, {
        id: 44,
        name: 'Actual case name',
        projectId: 23,
        deleted: false,
      });
      return;
    }

    tagWrites++;
    writeJson(response, 500, { message: 'tag write must not be attempted' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(
    client.setTestCaseTags(44, 'Wrong case name', ['smoke']),
    /Actual case name.*Wrong case name.*Tags were not changed/,
  );
  assert.equal(tagWrites, 0);
});

test('Markdown import writes tags for its fresh ID without an extra test-case lookup', async (context) => {
  let testCaseReads = 0;
  let tagBody: unknown;
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (request.method === 'GET') {
      testCaseReads++;
      writeJson(response, 500, { message: 'fresh imported ID must not be read' });
      return;
    }
    if (url.pathname === '/api/testcase') {
      writeJson(response, 201, { id: 90, name: 'Imported tagged case', projectId: 23 });
      return;
    }
    if (url.pathname === '/api/testcase/90/scenario') {
      assert.equal(url.searchParams.get('v2'), 'true');
      writeJson(response, 200, {});
      return;
    }

    assert.equal(url.pathname, '/api/testcase/90/tag');
    tagBody = await readJson(request);
    writeJson(response, 204);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await client.createImportedTestCase({
    name: 'Imported tagged case',
    scenario: scenario(),
    tags: ['smoke', 'imported'],
  });
  assert.equal(testCaseReads, 0);
  assert.deepEqual(tagBody, [{ name: 'smoke' }, { name: 'imported' }]);
});

test('manual step creation accepts only expectedResults and creates each result as a child', async (context) => {
  const stepRequests: Array<{ query: string; body: unknown }> = [];
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (url.pathname === '/api/rs/testcase/42') {
      writeJson(response, 200, { id: 42, name: 'Step case', projectId: 23 });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/testcase/step');
    stepRequests.push({ query: url.search, body: await readJson(request) });
    const requestNumber = stepRequests.length;
    writeJson(
      response,
      200,
      requestNumber === 1
        ? {
            createdStepId: 100,
            scenario: { scenarioSteps: { '100': { expectedResultId: 200 } } },
          }
        : { createdStepId: 100 + requestNumber },
    );
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await client.addTestCaseSteps(42, [
    {
      name: 'Perform action',
      expectedResults: ['First result', 'Second result'],
    },
  ]);

  assert.deepEqual(stepRequests, [
    {
      query: '?withExpectedResult=true',
      body: { testCaseId: 42, bodyJson: textDocument('Perform action') },
    },
    {
      query: '?withExpectedResult=false',
      body: { testCaseId: 42, bodyJson: textDocument('First result'), parentId: 200 },
    },
    {
      query: '?withExpectedResult=false',
      body: { testCaseId: 42, bodyJson: textDocument('Second result'), parentId: 200 },
    },
  ]);
});

test('issue links use one project-scoped V2 external-link request', async (context) => {
  const writes: Array<{ path: string; query: string; body: unknown }> = [];
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/42') {
      assert.equal(url.search, '');
      writeJson(response, 200, {
        id: 42,
        name: 'Case',
        projectId: 23,
        deleted: false,
      });
      return;
    }

    assert.equal(request.method, 'POST');
    writes.push({
      path: url.pathname,
      query: url.search,
      body: await readJson(request),
    });
    writeJson(response, 200);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23, {
    jiraBaseUrl: 'https://jira.example.com/jira',
  });
  await client.addTestCaseIssueLinks(42, ['TEST-1', 'TEST-2']);

  assert.deepEqual(writes, [
    {
      path: '/api/v2/test-case/bulk/external-link/add',
      query: '',
      body: {
        links: [
          { name: 'TEST-1', url: 'https://jira.example.com/jira/browse/TEST-1' },
          { name: 'TEST-2', url: 'https://jira.example.com/jira/browse/TEST-2' },
        ],
        selection: {
          projectId: 23,
          testCasesInclude: [42],
          inverted: false,
          deleted: false,
        },
        treeFolder: false,
      },
    },
  ]);
});

test('issue links require a confirmed active test case before writing', async (context) => {
  let writes = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/42') {
      writeJson(response, 200, {
        id: 42,
        name: 'Deleted case',
        projectId: 23,
        deleted: true,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/43') {
      writeJson(response, 200, {
        id: 43,
        name: 'Unknown state case',
        projectId: 23,
      });
      return;
    }

    writes++;
    writeJson(response, 500, { message: 'write must not be attempted' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23, {
    jiraBaseUrl: 'https://jira.example.com',
  });
  await assert.rejects(
    client.addTestCaseIssueLinks(42, ['TEST-1']),
    /Test case 42 is in Trash\. Issue links were not changed/,
  );
  await assert.rejects(
    client.addTestCaseIssueLinks(43, ['TEST-1']),
    /Cannot verify test case 43: TestOps response has no deleted state/,
  );
  assert.equal(writes, 0);
});

test('issue links are refused, without any request, when no Jira root is configured', async (context) => {
  let requests = 0;
  const fixture = await startServer((_request, response) => {
    requests++;
    writeJson(response, 500, { message: 'nothing may be requested' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.equal(client.issueLinksConfigured, false);
  await assert.rejects(
    client.addTestCaseIssueLinks(42, ['TEST-1']),
    /Set TESTOPS_JIRA_BASE_URL .* Issue links were not changed/s,
  );
  assert.equal(requests, 0);
});

test('by-ID mutations reject entities outside the configured project before writing', async (context) => {
  let writeRequests = 0;
  let testCaseReads = 0;
  let launchReads = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/rs/testcase/42') {
      testCaseReads++;
      assert.equal(url.searchParams.get('projectId'), '17');
      writeJson(response, 200, { id: 42, name: 'Foreign case', projectId: 23 });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/42') {
      testCaseReads++;
      assert.equal(url.searchParams.has('projectId'), false);
      writeJson(response, 200, { id: 42, name: 'Foreign case', projectId: 23, deleted: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/43') {
      testCaseReads++;
      assert.equal(url.search, '');
      writeJson(response, 200, { id: 43, name: 'Unscoped case', deleted: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/launch/7') {
      launchReads++;
      assert.equal(url.search, '');
      writeJson(response, 200, { id: 7, name: 'Foreign launch', projectId: 23 });
      return;
    }

    writeRequests++;
    writeJson(response, 500, { message: 'write must not be attempted' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17, {
    jiraBaseUrl: 'https://jira.example.com',
  });
  const foreignCaseError =
    /Test case 42 belongs to project 23, but this server is configured for project 17/;

  await assert.rejects(client.setTestCaseTags(42, 'Foreign case', ['smoke']), foreignCaseError);
  await assert.rejects(client.deleteTestCase(42, 'Foreign case'), foreignCaseError);
  await assert.rejects(client.addTestCaseSteps(42, [{ name: 'Do something' }]), foreignCaseError);
  await assert.rejects(client.addTestCaseIssueLinks(42, ['TEST-1']), foreignCaseError);
  await assert.rejects(client.setTestCaseCustomFields(42, [assignment(7, [11])]), foreignCaseError);
  await assert.rejects(
    client.setTestCaseTags(43, 'Unscoped case', ['smoke']),
    /Cannot verify test case 43: TestOps response has no projectId/,
  );
  await assert.rejects(
    client.updateLaunch(7, 'Foreign launch', 'Changed launch'),
    /Launch 7 belongs to project 23, but this server is configured for project 17/,
  );

  assert.equal(testCaseReads, 6);
  assert.equal(launchReads, 1);
  assert.equal(writeRequests, 0);
});

test('test-case deletion verifies the exact target and only moves it to Trash', async (context) => {
  let deleteRequests = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/41') {
      assert.equal(url.searchParams.has('projectId'), false);
      writeJson(response, 200, { id: 41, name: 'Case to delete', projectId: 23, deleted: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/42') {
      writeJson(response, 200, { id: 42, name: 'Different case', projectId: 23, deleted: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/43') {
      writeJson(response, 200, { id: 43, name: 'Deleted case', projectId: 23, deleted: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/44') {
      writeJson(response, 200, { id: 99, name: 'Wrong case', projectId: 23, deleted: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/45') {
      writeJson(response, 200, { id: 45, name: 'Unknown state', projectId: 23 });
      return;
    }

    assert.equal(request.method, 'DELETE');
    assert.equal(url.pathname, '/api/testcase/41');
    assert.equal(url.searchParams.get('force'), 'false');
    assert.equal(url.searchParams.has('projectId'), false);
    deleteRequests++;
    writeJson(response, 202);
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  const result = await client.deleteTestCase(41, 'Case to delete');

  assert.deepEqual(result, {
    status: 'accepted',
    destination: 'trash',
    testCaseId: 41,
    name: 'Case to delete',
    projectId: 23,
  });
  await assert.rejects(
    client.deleteTestCase(42, 'Case to delete'),
    /Different case.*Nothing was deleted/,
  );
  await assert.rejects(client.deleteTestCase(43, 'Deleted case'), /already in Trash/);
  await assert.rejects(client.deleteTestCase(44, 'Wrong case'), /returned test case 99/);
  await assert.rejects(client.deleteTestCase(45, 'Unknown state'), /no deleted state/);
  assert.equal(deleteRequests, 1);
});

test('Trash search uses one scoped AQL page, preserves ambiguity, and supports exact IDs', async (context) => {
  let searchRequests = 0;
  let writeRequests = 0;
  const searchName = 'Case with path';
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/__search') {
      searchRequests++;
      assert.equal(url.searchParams.get('projectId'), '23');
      assert.equal(url.searchParams.get('deleted'), 'true');
      const rql = url.searchParams.get('rql');

      if (rql === `name = ${JSON.stringify('Exact case')}`) {
        assert.equal(url.searchParams.get('page'), '0');
        assert.equal(url.searchParams.get('size'), '20');
        writeJson(response, 200, {
          content: [],
          number: 0,
          size: 20,
          totalElements: 0,
          totalPages: 0,
        });
        return;
      }

      if (rql === `name ~= ${JSON.stringify('Paged case')}`) {
        assert.equal(url.searchParams.get('page'), '1');
        assert.equal(url.searchParams.get('size'), '1');
        writeJson(response, 200, {
          content: [{ id: 56, name: 'Paged case', projectId: 23, deleted: true }],
          number: 1,
          size: 1,
          totalElements: 3,
          totalPages: 3,
        });
        return;
      }

      assert.equal(url.searchParams.get('page'), '0');
      assert.equal(url.searchParams.get('size'), '20');
      assert.equal(rql, `name ~= ${JSON.stringify(searchName)}`);
      writeJson(response, 200, {
        content: [
          { id: 51, name: searchName, projectId: 23, deleted: true, automated: false },
          { id: 52, name: searchName, projectId: 23, deleted: true, automated: true },
        ],
        number: 0,
        size: 20,
        totalElements: 2,
        totalPages: 1,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/53') {
      writeJson(response, 200, { id: 53, name: 'Deleted by ID', projectId: 23, deleted: true });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/54') {
      writeJson(response, 200, { id: 54, name: 'Active case', projectId: 23, deleted: false });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/55') {
      writeJson(response, 404, { message: 'not found' });
      return;
    }

    writeRequests++;
    writeJson(response, 500, { message: 'unexpected request' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  const byName = await client.searchTestCasesInTrash({
    by: 'name',
    name: searchName,
    match: 'contains',
    page: 0,
    size: 20,
  });
  assert.equal(byName.resolution, 'ambiguous');
  assert.equal(byName.totalElements, 2);
  assert.deepEqual(
    byName.matches.map((item) => item.id),
    [51, 52],
  );

  const exact = await client.searchTestCasesInTrash({
    by: 'name',
    name: 'Exact case',
    match: 'exact',
    page: 0,
    size: 20,
  });
  assert.equal(exact.resolution, 'not_found');

  const paged = await client.searchTestCasesInTrash({
    by: 'name',
    name: 'Paged case',
    match: 'contains',
    page: 1,
    size: 1,
  });
  assert.equal(paged.resolution, 'ambiguous');
  assert.equal(paged.totalElements, 3);
  assert.deepEqual(
    paged.matches.map((item) => item.id),
    [56],
  );

  const byId = await client.searchTestCasesInTrash({ by: 'id', id: 53 });
  assert.equal(byId.resolution, 'unique');
  assert.deepEqual(byId.matches, [{ id: 53, name: 'Deleted by ID' }]);

  const active = await client.searchTestCasesInTrash({ by: 'id', id: 54 });
  assert.equal(active.resolution, 'not_found');
  assert.match(active.message || '', /not in Trash/);

  const missing = await client.searchTestCasesInTrash({ by: 'id', id: 55 });
  assert.equal(missing.resolution, 'not_found');
  await assert.rejects(
    client.searchTestCasesInTrash({
      by: 'name',
      name: 'Case "quoted"',
      match: 'contains',
      page: 0,
      size: 20,
    }),
    /cannot contain quotes, backslashes, or control characters/,
  );
  assert.equal(searchRequests, 3);
  assert.equal(writeRequests, 0);
});

test('Trash search fails closed on malformed, foreign-project, or non-deleted results', async (context) => {
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    const rql = url.searchParams.get('rql');
    if (rql?.includes('Malformed')) {
      writeJson(response, 200, { number: 0, size: 20, totalElements: 0, totalPages: 0 });
      return;
    }
    const testCase = rql?.includes('Foreign')
      ? { id: 81, name: 'Foreign', projectId: 99, deleted: true }
      : rql?.includes('Active')
        ? { id: 82, name: 'Active', projectId: 23, deleted: false }
        : { id: 83, name: 'Unknown', projectId: 23 };
    writeJson(response, 200, {
      content: [testCase],
      number: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  const search = (name: string) =>
    client.searchTestCasesInTrash({
      by: 'name' as const,
      name,
      match: 'contains' as const,
      page: 0,
      size: 20,
    });

  await assert.rejects(search('Malformed'), /content is not an array/);
  await assert.rejects(search('Foreign'), /belongs to project 99/);
  await assert.rejects(search('Active'), /does not mark it as deleted/);
  await assert.rejects(search('Unknown'), /does not mark it as deleted/);
});

test('test-case restore verifies one exact deleted target and validates the response', async (context) => {
  let restoreRequests = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/testcase/61') {
      writeJson(response, 200, { id: 61, name: 'Case to restore', projectId: 23, deleted: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/62') {
      writeJson(response, 200, { id: 62, name: 'Different case', projectId: 23, deleted: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/63') {
      writeJson(response, 200, { id: 63, name: 'Active case', projectId: 23, deleted: false });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/64') {
      writeJson(response, 200, { id: 64, name: 'Foreign case', projectId: 99, deleted: true });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/65') {
      writeJson(response, 200, { id: 65, name: 'Unknown state', projectId: 23 });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/testcase/61/restore');
    assert.equal(url.search, '');
    restoreRequests++;
    writeJson(response, 200, {
      id: 61,
      name: 'Case to restore',
      projectId: 23,
      deleted: false,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(await client.restoreTestCase(61, 'Case to restore'), {
    status: 'restored',
    verifiedBy: 'response',
    testCaseId: 61,
    name: 'Case to restore',
    projectId: 23,
  });
  await assert.rejects(
    client.restoreTestCase(62, 'Case to restore'),
    /Different case.*Nothing was restored/,
  );
  await assert.rejects(client.restoreTestCase(63, 'Active case'), /not in Trash/);
  await assert.rejects(client.restoreTestCase(64, 'Foreign case'), /belongs to project 99/);
  await assert.rejects(client.restoreTestCase(65, 'Unknown state'), /no deleted state/);
  assert.equal(restoreRequests, 1);
});

test('restore never replays the mutation after an authentication failure', async (context) => {
  let tokenRequests = 0;
  let restoreRequests = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      tokenRequests++;
      writeJson(response, 200, { access_token: `token-${tokenRequests}` });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/testcase/66') {
      writeJson(response, 200, {
        id: 66,
        name: 'Expired token case',
        projectId: 23,
        deleted: true,
      });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/testcase/66/restore');
    restoreRequests++;
    writeJson(response, 401, { message: 'expired' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(client.restoreTestCase(66, 'Expired token case'), /status code 401/);
  assert.equal(tokenRequests, 1);
  assert.equal(restoreRequests, 1);
});

test('restore reconciles unknown and malformed POST outcomes without repeating the mutation', async (context) => {
  const reads = new Map<number, number>();
  let restoreRequests = 0;
  const fixture = await startServer((request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    const match = url.pathname.match(/^\/api\/testcase\/(71|72|73|74|75)$/);
    if (request.method === 'GET' && match) {
      const id = Number(match[1]);
      const read = (reads.get(id) || 0) + 1;
      reads.set(id, read);
      if (id === 73 && read === 2) {
        writeJson(response, 500, { message: 'verification unavailable' });
        return;
      }
      writeJson(response, 200, {
        id,
        name: `Case ${id}`,
        projectId: 23,
        deleted: [71, 74, 75].includes(id) && read === 2 ? false : true,
      });
      return;
    }

    assert.equal(request.method, 'POST');
    const restoreMatch = url.pathname.match(/^\/api\/testcase\/(71|72|73|74|75)\/restore$/);
    assert.ok(restoreMatch);
    const id = Number(restoreMatch[1]);
    restoreRequests++;
    if (id === 74) {
      writeJson(response, 200, {});
      return;
    }
    if (id === 75) {
      response.destroy();
      return;
    }
    writeJson(response, 500, { message: 'restore response lost' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  assert.deepEqual(await client.restoreTestCase(71, 'Case 71'), {
    status: 'restored',
    verifiedBy: 'follow-up-read',
    testCaseId: 71,
    name: 'Case 71',
    projectId: 23,
  });
  await assert.rejects(
    client.restoreTestCase(72, 'Case 72'),
    /remains in Trash.*do not retry automatically/,
  );
  await assert.rejects(
    client.restoreTestCase(73, 'Case 73'),
    /outcome.*unknown.*Do not retry automatically/i,
  );
  for (const id of [74, 75]) {
    assert.deepEqual(await client.restoreTestCase(id, `Case ${id}`), {
      status: 'restored',
      verifiedBy: 'follow-up-read',
      testCaseId: id,
      name: `Case ${id}`,
      projectId: 23,
    });
  }
  assert.equal(restoreRequests, 5);
  assert.deepEqual(Object.fromEntries(reads), { 71: 2, 72: 2, 73: 2, 74: 2, 75: 2 });
});

test('launch list, get, and create use the documented endpoints and validate responses', async (context) => {
  const createBodies: unknown[] = [];
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/launch') {
      assert.equal(url.searchParams.get('projectId'), '17');
      assert.equal(url.searchParams.get('page'), '1');
      assert.equal(url.searchParams.get('size'), '10');
      writeJson(response, 200, {
        content: [{ id: 6, name: 'Listed launch', projectId: 17 }],
        number: 1,
        size: 10,
        totalElements: 11,
        totalPages: 2,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/launch/7') {
      assert.equal(url.search, '');
      writeJson(response, 200, { id: 7, name: 'Existing launch', projectId: 17 });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/launch/8') {
      writeJson(response, 200, { id: 80, name: 'Wrong launch', projectId: 17 });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/launch');
    assert.equal(url.search, '');
    const body = await readJson(request);
    createBodies.push(body);
    const name = (body as { name: string }).name;
    writeJson(
      response,
      201,
      name === 'Malformed launch'
        ? { id: 9, name: 'Different launch', projectId: 17 }
        : { id: 9, name, projectId: 17 },
    );
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17);
  assert.deepEqual(await client.listLaunches({ page: 1, size: 10 }), {
    items: [{ id: 6, name: 'Listed launch', projectId: 17 }],
    page: 1,
    size: 10,
    totalElements: 11,
    totalPages: 2,
  });
  assert.deepEqual(await client.getLaunch(7), {
    id: 7,
    name: 'Existing launch',
    projectId: 17,
  });
  await assert.rejects(client.getLaunch(8), /returned launch 80 when 8 was requested/);
  assert.deepEqual(await client.createLaunch({ name: 'Created launch' }), {
    id: 9,
    name: 'Created launch',
    projectId: 17,
  });
  await assert.rejects(
    client.createLaunch({ name: 'Malformed launch' }),
    (error) =>
      error instanceof LaunchCreateOutcomeUnknownError &&
      /Do not retry automatically/.test(error.message),
  );
  assert.deepEqual(createBodies, [
    { name: 'Created launch', projectId: 17 },
    { name: 'Malformed launch', projectId: 17 },
  ]);
});

test('launch update checks the exact name, PATCHes only name, and statistics are validated', async (context) => {
  const patchBodies: unknown[] = [];
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    const launchMatch = url.pathname.match(/^\/api\/launch\/(10|11|12|13|14|15)$/);
    if (request.method === 'GET' && launchMatch) {
      const id = Number(launchMatch[1]);
      const names: Record<number, string> = {
        10: 'Before update',
        11: 'Actual name',
        12: 'Foreign launch',
        13: 'Statistic launch',
        14: 'Malformed statistic launch',
        15: 'Before malformed update',
      };
      writeJson(response, 200, {
        id,
        name: names[id],
        projectId: id === 12 ? 23 : 17,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/launch/13/statistic') {
      writeJson(response, 200, [
        { status: 'passed', count: 8 },
        { status: 'failed', count: 2 },
      ]);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/launch/14/statistic') {
      writeJson(response, 200, [{ status: 'unexpected', count: 'two' }]);
      return;
    }

    assert.equal(request.method, 'PATCH');
    assert.match(url.pathname, /^\/api\/launch\/(10|15)$/);
    assert.equal(url.search, '');
    const body = await readJson(request);
    patchBodies.push(body);
    const id = Number(url.pathname.split('/').at(-1));
    writeJson(response, 200, {
      id,
      name: id === 15 ? 'Wrong updated name' : 'After update',
      projectId: 17,
    });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17);
  assert.deepEqual(await client.updateLaunch(10, 'Before update', 'After update'), {
    id: 10,
    name: 'After update',
    projectId: 17,
  });
  await assert.rejects(
    client.updateLaunch(11, 'Expected name', 'After update'),
    /Actual name.*Expected name.*Nothing was changed/,
  );
  await assert.rejects(
    client.updateLaunch(12, 'Foreign launch', 'After update'),
    /belongs to project 23/,
  );
  await assert.rejects(
    client.updateLaunch(15, 'Before malformed update', 'After update'),
    /Wrong updated name.*After update/,
  );
  assert.deepEqual(await client.getLaunchStatistics(13), [
    { status: 'passed', count: 8 },
    { status: 'failed', count: 2 },
  ]);
  await assert.rejects(client.getLaunchStatistics(14), /Invalid launch statistic 0 status/);
  assert.deepEqual(patchBodies, [{ name: 'After update' }, { name: 'After update' }]);
});

test('launch creation is never auth-retried and unknown outcomes warn against retrying', async (context) => {
  let tokenRequests = 0;
  const createRequests = new Map<string, number>();
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      tokenRequests++;
      writeJson(response, 200, { access_token: `token-${tokenRequests}` });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/launch');
    const body = (await readJson(request)) as { name: string };
    createRequests.set(body.name, (createRequests.get(body.name) || 0) + 1);
    if (body.name === 'Unauthorized launch') {
      writeJson(response, 401, { message: 'expired' });
      return;
    }
    if (body.name === 'Server-error launch') {
      writeJson(response, 500, { message: 'create result unavailable' });
      return;
    }
    response.destroy();
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17);
  await assert.rejects(client.createLaunch({ name: 'Unauthorized launch' }), /status code 401/);
  for (const name of ['Server-error launch', 'Network-error launch']) {
    await assert.rejects(
      client.createLaunch({ name }),
      (error) =>
        error instanceof LaunchCreateOutcomeUnknownError &&
        /outcome is unknown.*Do not retry automatically/i.test(error.message),
    );
  }
  assert.equal(tokenRequests, 2);
  assert.deepEqual(Object.fromEntries(createRequests), {
    'Unauthorized launch': 1,
    'Server-error launch': 1,
    'Network-error launch': 1,
  });
});

test('overall statistics use the project endpoint and validate all documented fields', async (context) => {
  let requests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/project/17/stats');
    assert.equal(url.search, '');
    requests++;
    writeJson(
      response,
      200,
      requests === 1
        ? {
            launches: 5,
            manualTestCases: 10,
            automatedTestCases: 6,
            automationPercent: 37.5,
          }
        : requests === 2
          ? {
              launches: 5,
              manualTestCases: 10,
              automatedTestCases: '6',
              automationPercent: 37.5,
            }
          : {
              launches: 5,
              manualTestCases: 10,
              automatedTestCases: 6,
              automationPercent: 101,
            },
    );
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17);
  assert.deepEqual(await client.getOverallStatistics(), {
    launches: 5,
    manualTestCases: 10,
    automatedTestCases: 6,
    automationPercent: 37.5,
  });
  await assert.rejects(client.getOverallStatistics(), /Invalid project automated test-case count/);
  await assert.rejects(client.getOverallStatistics(), /Invalid project automation percent/);
});

test('invalid structured import scenarios are rejected before any HTTP request', async () => {
  const client = new TestOpsClient('http://127.0.0.1:1', 'api-key', 23);
  await assert.rejects(
    client.createImportedTestCase({
      name: 'Invalid scenario',
      scenario: [{ text: 'Orphan', depth: 1, expectedResults: [] }],
    }),
    /step at depth 1 has no parent step/,
  );
});

test('post-create metadata failures retain the created test-case ID and stage', async (context) => {
  let createBody: unknown;
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/testcase') {
      createBody = await readJson(request);
      writeJson(response, 201, { id: 42, name: 'Imported case' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/testcase/42/scenario') {
      assert.equal(url.searchParams.get('v2'), 'true');
      writeJson(response, 200, {});
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/rs/testcase/42/cfv');
    assert.equal(url.searchParams.get('projectId'), '17');
    writeJson(response, 500, { message: 'metadata unavailable' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 17);
  const overrideAttempt = {
    name: 'Imported case',
    scenario: scenario(),
    projectId: 23,
    resolvedCustomFields: [assignment(7, [11])],
  } as Parameters<TestOpsClient['createImportedTestCase']>[0] & { projectId: number };
  await assert.rejects(
    client.createImportedTestCase(overrideAttempt),
    (error) =>
      error instanceof ImportedTestCaseCreateError &&
      error.testCaseId === 42 &&
      error.stage === 'customFields' &&
      /metadata unavailable/.test(error.message),
  );
  assert.equal((createBody as { projectId?: unknown }).projectId, 17);
});

test('scenario failures retain the created test-case ID and stage', async (context) => {
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (url.pathname === '/api/testcase') {
      writeJson(response, 201, { id: 42, name: 'Imported case' });
      return;
    }

    assert.equal(url.pathname, '/api/testcase/42/scenario');
    assert.equal(url.searchParams.get('v2'), 'true');
    writeJson(response, 500, { message: 'scenario unavailable' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(
    client.createImportedTestCase({
      name: 'Imported case',
      scenario: scenario(),
    }),
    (error) =>
      error instanceof ImportedTestCaseCreateError &&
      error.testCaseId === 42 &&
      error.stage === 'scenario' &&
      /scenario unavailable/.test(error.message),
  );
});

test('initial server failure reports an unknown create outcome without inventing an ID', async (context) => {
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    assert.equal(url.pathname, '/api/testcase');
    writeJson(response, 500, { message: 'create result unavailable' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(
    client.createImportedTestCase({
      name: 'Unknown outcome case',
      scenario: scenario(),
    }),
    (error) =>
      error instanceof ImportedTestCaseOutcomeUnknownError &&
      !('testCaseId' in error) &&
      error.originalError instanceof Error &&
      /create result unavailable/.test(error.message),
  );
});

test('malformed imported create responses never drive post-create writes', async (context) => {
  const createResponses = [
    {},
    { id: 42, name: 'Different case', projectId: 23 },
    { id: 43, name: 'Imported case', projectId: 99 },
  ];
  let createRequests = 0;
  let postCreateRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }
    if (url.pathname === '/api/testcase') {
      writeJson(response, 201, createResponses[createRequests]);
      createRequests++;
      return;
    }

    postCreateRequests++;
    writeJson(response, 500, { message: 'post-create write must not run' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  for (const expectedMessage of [
    /Invalid created test case id/,
    /named "Different case", not "Imported case"/,
    /belongs to project 99/,
  ]) {
    await assert.rejects(
      client.createImportedTestCase({
        name: 'Imported case',
        scenario: scenario(),
      }),
      (error) =>
        error instanceof ImportedTestCaseOutcomeUnknownError &&
        expectedMessage.test(error.message) &&
        !('testCaseId' in error),
    );
  }
  assert.equal(createRequests, 3);
  assert.equal(postCreateRequests, 0);
});

test('initial imported test-case creation is never replayed after a 401 response', async (context) => {
  let tokenRequests = 0;
  let createRequests = 0;
  const fixture = await startServer((_request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      tokenRequests++;
      writeJson(response, 200, { access_token: `token-${tokenRequests}` });
      return;
    }

    assert.equal(url.pathname, '/api/testcase');
    createRequests++;
    writeJson(response, 401, { message: 'expired' });
  });
  context.onTestFinished(fixture.close);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await assert.rejects(
    client.createImportedTestCase({
      name: 'Do not duplicate',
      scenario: scenario(),
    }),
    /status code 401/,
  );
  assert.equal(tokenRequests, 1);
  assert.equal(createRequests, 1);
});

test('Markdown import maps description, preconditions, and expected results to their API fields', async (context) => {
  let createBody: unknown;
  let scenarioBody: unknown;
  const fixture = await startServer(async (request, response, url) => {
    if (url.pathname === '/api/uaa/oauth/token') {
      writeJson(response, 200, { access_token: 'token' });
      return;
    }

    if (url.pathname === '/api/testcase') {
      assert.equal(request.method, 'POST');
      createBody = await readJson(request);
      writeJson(response, 201, { id: 42, name: 'Scenario case' });
      return;
    }

    assert.equal(request.method, 'POST');
    assert.equal(url.pathname, '/api/testcase/42/scenario');
    assert.equal(url.searchParams.get('v2'), 'true');
    scenarioBody = await readJson(request);
    writeJson(response, 200, {});
  });
  context.onTestFinished(fixture.close);

  const parsed = parseMarkdownImport(
    [
      '## Scenario case',
      '### Description',
      'Scenario description',
      '### Preconditions',
      '- User is signed in',
      '- Test data exists',
      '### Steps',
      '[step 1] Parent action',
      '    [expected 1.1] First parent result',
      '    [expected 1.2] Second parent result',
      '    [step 1.1] Child action',
      '        [expected 1.1.1] Child result',
    ].join('\n'),
  );
  assert.deepEqual(parsed.diagnostics, []);

  const client = new TestOpsClient(fixture.baseUrl, 'api-key', 23);
  await client.createImportedTestCase({
    name: 'Scenario case',
    description: parsed.cases[0].description,
    preconditions: parsed.cases[0].preconditions,
    scenario: parsed.cases[0].scenario,
  });

  assert.deepEqual(createBody, {
    name: 'Scenario case',
    description: 'Scenario description',
    precondition: '- User is signed in\n- Test data exists',
    projectId: 23,
  });
  assert.deepEqual(scenarioBody, {
    steps: [
      {
        type: 'body',
        bodyJson: textDocument('Parent action'),
        steps: [
          {
            type: 'body',
            bodyJson: textDocument('Child action'),
            steps: [],
            expectedResultSteps: [
              {
                type: 'expected_body',
                bodyJson: textDocument('Child result'),
                steps: [],
              },
            ],
          },
        ],
        expectedResultSteps: [
          {
            type: 'expected_body',
            bodyJson: textDocument('First parent result'),
            steps: [],
          },
          {
            type: 'expected_body',
            bodyJson: textDocument('Second parent result'),
            steps: [],
          },
        ],
      },
    ],
  });
});

function textDocument(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function assignment(fieldId: number, valueIds: number[]): ResolvedCustomFieldAssignment {
  return {
    fieldId,
    fieldName: `Field ${fieldId}`,
    required: false,
    singleSelect: false,
    values: valueIds.map((valueId) => ({
      valueId,
      valueName: `Value ${valueId}`,
      global: false,
    })),
  };
}

async function startServer(handler: RequestHandler): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    Promise.resolve(handler(request, response, url)).catch((error) => {
      writeJson(response, 500, { message: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function writeJson(response: ServerResponse, status: number, body?: unknown): void {
  response.statusCode = status;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const content = Buffer.concat(chunks).toString('utf8');
  return content ? JSON.parse(content) : undefined;
}
