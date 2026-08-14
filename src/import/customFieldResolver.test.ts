import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ProjectCustomField, ProjectCustomFieldValue } from '../client/types';

import { type CustomFieldCatalogClient, resolveCustomFields } from './customFieldResolver';
import type { ParsedMarkdownTestCase } from './markdown';

function markdownCase(
  name: string,
  customFields: Record<string, string | string[]>,
): ParsedMarkdownTestCase {
  return {
    name,
    line: 1,
    description: '',
    preconditions: [],
    scenario: [{ text: 'test', depth: 0, expectedResults: [] }],
    tags: [],
    issueKeys: [],
    customFields: Object.entries(customFields).map(([fieldName, values], index) => ({
      name: fieldName,
      values: Array.isArray(values) ? values : values.split(','),
      line: index + 2,
    })),
  };
}

function catalog(
  fields: ProjectCustomField[],
  values: Array<ProjectCustomFieldValue & { fieldId: number }>,
): CustomFieldCatalogClient & { fieldCalls: number; valueCalls: Map<number, number> } {
  return {
    fieldCalls: 0,
    valueCalls: new Map<number, number>(),
    async listProjectCustomFields() {
      this.fieldCalls++;
      return fields;
    },
    async listProjectCustomFieldValues(fieldId) {
      this.valueCalls.set(fieldId, (this.valueCalls.get(fieldId) || 0) + 1);
      return values.filter((value) => value.fieldId === fieldId);
    },
  };
}

function diagnosticCodes(result: Awaited<ReturnType<typeof resolveCustomFields>>): string[] {
  return (result.diagnostics as unknown as Array<{ code: string }>).map((item) => item.code);
}

test('resolves exact and normalized field/value names', async () => {
  const client = catalog(
    [
      { id: 1, name: 'Team', required: false, singleSelect: true },
      { id: 2, name: 'Compónent', required: false, singleSelect: true },
    ],
    [
      { id: 101, fieldId: 1, name: 'T22', global: false },
      { id: 201, fieldId: 2, name: 'UI Selenide', global: true },
    ],
  );

  const result = await resolveCustomFields(
    [
      markdownCase('TC-1', {
        ' team ': ' t22 ',
        'Compo\u0301nent': ' UI\t  Selenide ',
      }),
    ],
    23,
    client,
  );

  assert.deepEqual(result.cases[0].assignments, [
    {
      fieldId: 1,
      fieldName: 'Team',
      required: false,
      singleSelect: true,
      values: [{ valueId: 101, valueName: 'T22', global: false }],
    },
    {
      fieldId: 2,
      fieldName: 'Compónent',
      required: false,
      singleSelect: true,
      values: [{ valueId: 201, valueName: 'UI Selenide', global: true }],
    },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('reports a missing field with available candidates and does not load values', async () => {
  const client = catalog(
    [{ id: 1, name: 'Team', required: false, singleSelect: true }],
    [{ id: 101, fieldId: 1, name: 'T22', global: false }],
  );

  const result = await resolveCustomFields([markdownCase('TC-1', { Unknown: 'X' })], 23, client);

  assert.deepEqual(diagnosticCodes(result), ['FIELD_NOT_FOUND']);
  assert.deepEqual(result.cases[0].fields[0].candidates, [{ id: 1, name: 'Team' }]);
  assert.equal(client.valueCalls.size, 0);
});

test('reports an ambiguous case-insensitive field match', async () => {
  const client = catalog(
    [
      { id: 1, name: 'Team', required: false, singleSelect: true },
      { id: 2, name: 'TEAM', required: false, singleSelect: true },
    ],
    [],
  );

  const result = await resolveCustomFields([markdownCase('TC-1', { team: 'T22' })], 23, client);

  assert.deepEqual(diagnosticCodes(result), ['FIELD_AMBIGUOUS']);
  assert.deepEqual(result.cases[0].fields[0].candidates, [
    { id: 1, name: 'Team' },
    { id: 2, name: 'TEAM' },
  ]);
});

test('reports missing and ambiguous values without selecting a candidate', async () => {
  const client = catalog(
    [{ id: 1, name: 'Type', required: false, singleSelect: false }],
    [
      { id: 101, fieldId: 1, name: 'Smoke', global: false },
      { id: 102, fieldId: 1, name: 'SMOKE', global: true },
      { id: 103, fieldId: 1, name: 'Regress', global: false },
    ],
  );

  const result = await resolveCustomFields(
    [markdownCase('TC-1', { Type: 'smoke, Integration' })],
    23,
    client,
  );

  assert.deepEqual(diagnosticCodes(result), ['VALUE_AMBIGUOUS', 'VALUE_NOT_FOUND']);
  assert.deepEqual(result.cases[0].assignments, []);
  assert.deepEqual(
    result.cases[0].fields[0].values.map((value) => value.status),
    ['ambiguous', 'not_found'],
  );
});

test('requires every required project field in every case', async () => {
  const client = catalog(
    [{ id: 1, name: 'Team', required: true, singleSelect: true }],
    [{ id: 101, fieldId: 1, name: 'T22', global: false }],
  );

  const result = await resolveCustomFields(
    [markdownCase('TC-1', {}), markdownCase('TC-2', { Team: 'Unknown' })],
    23,
    client,
  );

  assert.deepEqual(diagnosticCodes(result), [
    'REQUIRED_FIELD_MISSING',
    'VALUE_NOT_FOUND',
    'REQUIRED_FIELD_MISSING',
  ]);
});

test('requires an explicit Markdown value even when the project defines a default', async () => {
  const client = catalog(
    [
      {
        id: 1,
        name: 'Team',
        required: true,
        singleSelect: true,
        defaultValueId: 101,
      },
    ],
    [{ id: 101, fieldId: 1, name: 'T22', global: false }],
  );

  const result = await resolveCustomFields([markdownCase('TC-1', {})], 23, client);

  assert.deepEqual(diagnosticCodes(result), ['REQUIRED_FIELD_MISSING']);
  assert.match(result.diagnostics[0].message, /requires an explicit value/);
});

test('preserves multi-value order, rejects multiple single-select values, and deduplicates', async () => {
  const client = catalog(
    [
      { id: 1, name: 'Team', required: false, singleSelect: true },
      { id: 2, name: 'Type', required: false, singleSelect: false },
    ],
    [
      { id: 101, fieldId: 1, name: 'T22', global: false },
      { id: 102, fieldId: 1, name: 'T23', global: false },
      { id: 201, fieldId: 2, name: 'Smoke', global: false },
      { id: 202, fieldId: 2, name: 'Regress', global: true },
    ],
  );

  const result = await resolveCustomFields(
    [
      markdownCase('TC-1', {
        Team: 'T22, T23',
        Type: 'Regress, Smoke, smoke',
      }),
    ],
    23,
    client,
  );

  assert.deepEqual(result.cases[0].assignments[1].values, [
    { valueId: 202, valueName: 'Regress', global: true },
    { valueId: 201, valueName: 'Smoke', global: false },
  ]);
  assert.deepEqual(diagnosticCodes(result), [
    'DUPLICATE_FIELD_VALUE',
    'MULTIPLE_VALUES_NOT_ALLOWED',
  ]);
});

test('loads project fields once and caches values per referenced field', async () => {
  const client = catalog(
    [
      { id: 1, name: 'Team', required: false, singleSelect: true },
      { id: 2, name: 'Type', required: false, singleSelect: false },
    ],
    [
      { id: 101, fieldId: 1, name: 'T22', global: false },
      { id: 201, fieldId: 2, name: 'Smoke', global: false },
    ],
  );

  await resolveCustomFields(
    [
      markdownCase('TC-1', { Team: 'T22', Type: 'Smoke' }),
      markdownCase('TC-2', { team: 't22' }),
      markdownCase('TC-3', { Type: 'Smoke' }),
    ],
    23,
    client,
  );

  assert.equal(client.fieldCalls, 1);
  assert.equal(client.valueCalls.get(1), 1);
  assert.equal(client.valueCalls.get(2), 1);
});
