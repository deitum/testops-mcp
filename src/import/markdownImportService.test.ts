import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { test, type TestContext } from 'vitest';

import {
  ImportedTestCaseCreateError,
  ImportedTestCaseOutcomeUnknownError,
} from '../client/TestOpsClient';
import type {
  ProjectCustomField,
  ProjectCustomFieldValue,
  TestCase,
  TestCaseImportCreateRequest,
} from '../client/types';

import {
  prepareMarkdownImport,
  serializeMarkdownImportReport,
  uploadPreparedMarkdownImport,
  type MarkdownImportClient,
} from './markdownImportService';

class FakeImportClient implements MarkdownImportClient {
  readonly createRequests: TestCaseImportCreateRequest[] = [];
  fieldCalls = 0;
  valueCalls = 0;

  constructor(
    private readonly fields: ProjectCustomField[],
    private readonly values: ProjectCustomFieldValue[],
    private readonly create: (
      request: TestCaseImportCreateRequest,
      callIndex: number,
    ) => Promise<TestCase> = async (_request, callIndex) => ({
      id: 1000 + callIndex,
      name: `Created ${callIndex}`,
    }),
  ) {}

  async listProjectCustomFields(): Promise<ProjectCustomField[]> {
    this.fieldCalls++;
    return this.fields;
  }

  async listProjectCustomFieldValues(fieldId: number): Promise<ProjectCustomFieldValue[]> {
    this.valueCalls++;
    return this.values.filter((value) => value.fieldId === fieldId);
  }

  async createImportedTestCase(request: TestCaseImportCreateRequest): Promise<TestCase> {
    this.createRequests.push(request);
    return this.create(request, this.createRequests.length - 1);
  }
}

const TEAM_FIELD: ProjectCustomField = {
  id: 1,
  name: 'Team',
  required: false,
  singleSelect: true,
};

const TEAM_VALUE: ProjectCustomFieldValue = {
  id: 101,
  fieldId: 1,
  name: 'T22',
  global: false,
};

test('preflights the attached example with human-readable project catalog values', async () => {
  const fieldDefinitions = [
    ['Team', true, ['T22']],
    ['Component', true, ['UI Selenide']],
    ['Product', true, ['Оформление заказа']],
    ['Модуль', true, ['Витрина']],
    ['Направление', true, ['Продажи']],
    ['Тип тестирования', false, ['Smoke', 'Regress']],
  ] as const;
  const fields: ProjectCustomField[] = fieldDefinitions.map(([name, singleSelect], index) => ({
    id: index + 1,
    name,
    required: false,
    singleSelect,
  }));
  const values: ProjectCustomFieldValue[] = fieldDefinitions.flatMap(
    ([, , fieldValues], fieldIndex) =>
      fieldValues.map((name, valueIndex) => ({
        id: (fieldIndex + 1) * 100 + valueIndex,
        fieldId: fieldIndex + 1,
        name,
        global: false,
      })),
  );
  const client = new FakeImportClient(fields, values);
  const filePath = path.resolve('examples/testops-markdown-import-example.md');

  const preflight = await prepareMarkdownImport(filePath, 23, client, {
    allowedRoots: [path.resolve('.')],
  });

  assert.equal(preflight.valid, true);
  assert.deepEqual(preflight.diagnostics, []);
  assert.equal(preflight.cases[0].resolution.assignments.length, 6);
  assert.deepEqual(
    preflight.cases[0].resolution.assignments
      .find((assignment) => assignment.fieldName === 'Тип тестирования')
      ?.values.map((value) => value.valueName),
    ['Smoke', 'Regress'],
  );
  assert.equal(client.createRequests.length, 0);
});

test('parse errors refuse upload without loading the TestOps catalog', async (t) => {
  const fixture = await markdownFixture(
    t,
    ['## Invalid case', '### Fields', '- Unknown: Value'].join('\n'),
  );
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE]);

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(preflight.valid, false);
  assert.ok(preflight.diagnostics.some((item) => item.code === 'MISSING_SCENARIO_SECTION'));
  assert.equal(client.fieldCalls, 0);
  assert.equal(upload.status, 'refused');
  assert.match(upload.report.message, /No test cases were created/);
  assert.equal(client.createRequests.length, 0);
  assert.deepEqual(upload.notAttempted, [
    {
      caseIndex: 0,
      caseName: 'Invalid case',
      reason: 'validation_failed',
    },
  ]);
  assert.match(serializeMarkdownImportReport(upload.report), /No test cases were created/);
});

test('field-resolution errors refuse upload and create nothing', async (t) => {
  const fixture = await markdownFixture(t, validCase('Invalid field case', '- Unknown: Value'));
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE]);

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(preflight.valid, false);
  assert.ok(preflight.diagnostics.some((item) => item.code === 'FIELD_NOT_FOUND'));
  assert.equal(client.fieldCalls, 1);
  assert.equal(upload.status, 'refused');
  assert.equal(client.createRequests.length, 0);
});

test('issue keys refuse the whole import when no Jira root is configured', async (t) => {
  const fixture = await markdownFixture(
    t,
    [
      '## Linked case',
      '### Steps',
      '[step] Perform action',
      '    [expected] Action succeeds',
      '### Ссылки',
      '- TEST-1',
    ].join('\n'),
  );
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE]);

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
    issueLinksConfigured: false,
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(preflight.valid, false);
  const diagnostic = preflight.diagnostics.find((item) => item.code === 'JIRA_NOT_CONFIGURED');
  assert.equal(diagnostic?.caseName, 'Linked case');
  assert.match(diagnostic?.message ?? '', /TESTOPS_JIRA_BASE_URL/);
  assert.equal(upload.status, 'refused');
  assert.equal(client.createRequests.length, 0);
});

test('a case without issue keys imports with no Jira root configured', async (t) => {
  const fixture = await markdownFixture(t, validCase('Unlinked case', '- Team: T22'));
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE]);

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
    issueLinksConfigured: false,
  });

  assert.equal(preflight.valid, true);
  assert.deepEqual(preflight.diagnostics, []);
});

test('a successful preflight creates every case with resolved assignments', async (t) => {
  const fixture = await markdownFixture(
    t,
    [validCase('First case', '- Team: T22'), validCase('Second case', '- Team: T22')].join('\n\n'),
  );
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE]);

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(preflight.valid, true);
  assert.equal(upload.status, 'completed');
  assert.deepEqual(
    upload.created.map((item) => item.testCaseId),
    [1000, 1001],
  );
  assert.equal(client.createRequests.length, 2);
  assert.deepEqual(client.createRequests[0].scenario, [
    {
      text: 'Perform action',
      depth: 0,
      expectedResults: ['Action succeeds'],
    },
  ]);
  assert.deepEqual(client.createRequests[0].resolvedCustomFields, [
    {
      fieldId: 1,
      fieldName: 'Team',
      required: false,
      singleSelect: true,
      values: [{ valueId: 101, valueName: 'T22', global: false }],
    },
  ]);
  assert.equal('projectId' in client.createRequests[0], false);
  assert.match(serializeMarkdownImportReport(preflight.report), /Team -> Team: resolved/);
  assert.match(serializeMarkdownImportReport(upload.report), /Created First case: testCaseId=1000/);
  assert.deepEqual(upload.report.cases, preflight.report.cases);
  assert.match(serializeMarkdownImportReport(upload.report), /Team -> Team: resolved/);
});

test('case-distinct custom-field values survive parsing and resolve independently', async (t) => {
  const fixture = await markdownFixture(
    t,
    validCase('Case-sensitive values', '- Type: Smoke, SMOKE'),
  );
  const client = new FakeImportClient(
    [{ id: 2, name: 'Type', required: false, singleSelect: false }],
    [
      { id: 201, fieldId: 2, name: 'Smoke', global: false },
      { id: 202, fieldId: 2, name: 'SMOKE', global: false },
    ],
  );

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(preflight.valid, true);
  assert.deepEqual(preflight.diagnostics, []);
  assert.equal(upload.status, 'completed');
  assert.deepEqual(client.createRequests[0].resolvedCustomFields?.[0].values, [
    { valueId: 201, valueName: 'Smoke', global: false },
    { valueId: 202, valueName: 'SMOKE', global: false },
  ]);
});

test('warnings do not block creation', async (t) => {
  const fixture = await markdownFixture(t, validCase('Warning case', '- Team: T22, T22'));
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE]);

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(preflight.valid, true);
  assert.deepEqual(
    preflight.diagnostics.map((item) => item.code),
    ['DUPLICATE_FIELD_VALUE'],
  );
  assert.equal(upload.status, 'completed');
  assert.equal(client.createRequests.length, 1);
  assert.deepEqual(client.createRequests[0].resolvedCustomFields?.[0].values, [
    {
      valueId: 101,
      valueName: 'T22',
      global: false,
    },
  ]);
});

test('post-create metadata failure retains id and stage and stops remaining cases', async (t) => {
  const fixture = await markdownFixture(
    t,
    [
      validCase('Created case', '- Team: T22'),
      validCase('Partial case', '- Team: T22'),
      validCase('Skipped case', '- Team: T22'),
    ].join('\n\n'),
  );
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE], async (request, callIndex) => {
    if (callIndex === 1) {
      throw new ImportedTestCaseCreateError(2001, 'tags', new Error('Tag endpoint unavailable'));
    }
    return { id: 2000, name: request.name };
  });

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(upload.status, 'failed');
  assert.deepEqual(upload.created, [
    {
      caseIndex: 0,
      caseName: 'Created case',
      testCaseId: 2000,
    },
  ]);
  assert.deepEqual(upload.partiallyCreated, [
    {
      caseIndex: 1,
      caseName: 'Partial case',
      testCaseId: 2001,
      stage: 'tags',
      error: 'Tag endpoint unavailable',
    },
  ]);
  assert.equal(upload.failedCase?.testCaseId, 2001);
  assert.equal(upload.failedCase?.stage, 'tags');
  assert.deepEqual(upload.notAttempted, [
    {
      caseIndex: 2,
      caseName: 'Skipped case',
      reason: 'stopped_after_failure',
    },
  ]);
  assert.equal(client.createRequests.length, 2);
  assert.match(
    upload.report.message,
    /do not perform any retry, deletion, or rollback automatically/i,
  );
  assert.match(serializeMarkdownImportReport(upload.report), /failed stage=tags/);
});

test('unknown create outcome is reported explicitly and stops all remaining cases', async (t) => {
  const fixture = await markdownFixture(
    t,
    [
      validCase('Possibly created case', '- Team: T22'),
      validCase('Skipped case', '- Team: T22'),
    ].join('\n\n'),
  );
  const client = new FakeImportClient([TEAM_FIELD], [TEAM_VALUE], async () => {
    throw new ImportedTestCaseOutcomeUnknownError(new Error('connection timed out'));
  });

  const preflight = await prepareMarkdownImport(fixture.filePath, 23, client, {
    allowedRoots: [fixture.root],
  });
  const upload = await uploadPreparedMarkdownImport(preflight, client);

  assert.equal(upload.status, 'outcome_unknown');
  assert.deepEqual(upload.created, []);
  assert.deepEqual(upload.partiallyCreated, []);
  assert.deepEqual(upload.failedCase, {
    caseIndex: 0,
    caseName: 'Possibly created case',
    error: 'Test case creation outcome is unknown: connection timed out',
    outcomeUnknown: true,
  });
  assert.deepEqual(upload.notAttempted, [
    {
      caseIndex: 1,
      caseName: 'Skipped case',
      reason: 'stopped_after_unknown_outcome',
    },
  ]);
  assert.equal(client.createRequests.length, 1);
  assert.ok(upload.diagnostics.some((item) => item.code === 'TEST_CASE_CREATE_OUTCOME_UNKNOWN'));
  assert.deepEqual(upload.report.cases, preflight.report.cases);

  const report = serializeMarkdownImportReport(upload.report);
  assert.match(report, /Markdown import upload: OUTCOME_UNKNOWN/);
  assert.match(
    report,
    /Reconcile whether it exists; do not perform any retry, deletion, or rollback automatically/i,
  );
  assert.match(
    report,
    /TestOps may have created this test case; do not perform any retry, deletion, or rollback automatically/i,
  );
  assert.match(report, /Team -> Team: resolved/);
});

function validCase(name: string, fieldLine: string): string {
  return [
    `## ${name}`,
    '### Steps',
    '[step] Perform action',
    '    [expected] Action succeeds',
    '### Fields',
    fieldLine,
  ].join('\n');
}

async function markdownFixture(
  t: TestContext,
  content: string,
): Promise<{ root: string; filePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'testops-import-service-'));
  const filePath = path.join(root, 'cases.md');
  await fs.writeFile(filePath, content, 'utf8');
  t.onTestFinished(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, filePath };
}
