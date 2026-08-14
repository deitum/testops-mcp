import * as fs from 'fs/promises';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import { test } from 'vitest';

import { parseMarkdownImport, parseMarkdownImportFile, summarizeImport } from './markdown';

function codes(result: { diagnostics: { code: string }[] }): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

test('parses the attached human-readable Markdown contract', async () => {
  const filePath = path.resolve('examples/testops-markdown-import-example.md');
  const result = await parseMarkdownImportFile(filePath, { allowedRoots: [path.resolve('.')] });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.cases.length, 1);
  const testCase = result.cases[0];
  assert.equal(testCase.line, 1);
  assert.equal(testCase.preconditions.length, 5);
  assert.deepEqual(testCase.tags, ['checkout', 'smoke']);
  assert.equal(testCase.customFields.length, 6);
  assert.deepEqual(
    testCase.customFields.find((field) => field.name === 'Тип тестирования')?.values,
    ['Smoke', 'Regress'],
  );

  const summary = summarizeImport(result) as {
    valid: boolean;
    cases: { steps: number; expectedResults: number; nestedSteps: number }[];
  };
  assert.equal(summary.valid, true);
  assert.equal(summary.cases[0].steps, 7);
  assert.equal(summary.cases[0].expectedResults, 7);
  assert.equal(summary.cases[0].nestedSteps, 2);
});

test('handles UTF-8 BOM, CRLF, English Fields alias, and preserves description paragraphs', () => {
  const result = parseMarkdownImport(
    [
      '\uFEFF## Case',
      '',
      '### Description',
      'First paragraph.',
      '',
      'Second paragraph.',
      '',
      '---',
      '',
      '### Steps',
      '[step 1] Action',
      '    [expected 1.1] Result',
      '',
      '### Fields',
      '- Team: T22',
    ].join('\r\n'),
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.cases[0].description, 'First paragraph.\n\nSecond paragraph.\n\n---');
  assert.deepEqual(result.cases[0].customFields, [{ name: 'Team', values: ['T22'], line: 15 }]);
});

test('recognizes Russian and English aliases and rejects folders', () => {
  const result = parseMarkdownImport(
    [
      '## Case',
      '### Предусловия',
      '- Ready',
      '### Scenario',
      '[step] Act',
      '### Теги',
      '- smoke',
      '### Links',
      '- ABC-1',
      '### Custom Fields',
      '- Team: T22',
      '### Папки',
      '- Folder',
    ].join('\n'),
  );

  assert.deepEqual(result.cases[0].preconditions, ['Ready']);
  assert.deepEqual(result.cases[0].issueKeys, ['ABC-1']);
  assert.ok(codes(result).includes('UNSUPPORTED_SECTION'));
});

test('reports unknown and duplicate sections with source locations', () => {
  const result = parseMarkdownImport(
    [
      '## Case',
      '### Steps',
      '[step] First',
      '### Шаги',
      '[step] Second',
      '### Mystery',
      'ignored',
    ].join('\n'),
  );

  const duplicate = result.diagnostics.find(
    (diagnostic) => diagnostic.code === 'DUPLICATE_SECTION',
  );
  const unknown = result.diagnostics.find((diagnostic) => diagnostic.code === 'UNKNOWN_SECTION');
  assert.equal(duplicate?.line, 4);
  assert.equal(duplicate?.caseName, 'Case');
  assert.equal(duplicate?.section, 'scenario');
  assert.equal(unknown?.line, 6);
  assert.equal(unknown?.caseName, 'Case');
  assert.equal(unknown?.section, 'Mystery');
});

test('does not treat headings inside code fences as cases or sections', () => {
  const result = parseMarkdownImport(
    [
      '## Real case',
      '### Steps',
      '```',
      '[step] Action',
      '    [expected] Result containing a heading below',
      '## Not a case',
      '### Not a section',
      '```',
    ].join('\n'),
  );

  assert.equal(result.cases.length, 1);
  assert.equal(result.cases[0].name, 'Real case');
  assert.ok(codes(result).includes('INVALID_SCENARIO_LINE'));
  assert.ok(!codes(result).includes('UNKNOWN_SECTION'));
});

test('preserves quoted and case-distinct custom-field values while merging field declarations', () => {
  const result = parseMarkdownImport(
    [
      '## Case',
      '### Steps',
      '[step] Action',
      '### Fields',
      '- Component: "UI, Selenide", Smoke, SMOKE, Smoke',
      '- component: Regress',
      '- "Field: Name": "Value: A", "A ""quoted"" value"',
    ].join('\n'),
  );

  assert.deepEqual(result.cases[0].customFields, [
    {
      name: 'Component',
      values: ['UI, Selenide', 'Smoke', 'SMOKE', 'Smoke', 'Regress'],
      line: 5,
    },
    { name: 'Field: Name', values: ['Value: A', 'A "quoted" value'], line: 7 },
  ]);
  assert.ok(codes(result).includes('DUPLICATE_CUSTOM_FIELD'));
  assert.ok(!codes(result).includes('DUPLICATE_CUSTOM_FIELD_VALUE'));
});

test('reports malformed and empty custom-field values instead of dropping them', () => {
  const result = parseMarkdownImport(
    [
      '## Case',
      '### Steps',
      '[step] Action',
      '### Fields',
      '- Missing delimiter',
      '- Team:',
      '- Component: UI,,API',
      '- Product: "not closed',
    ].join('\n'),
  );

  assert.deepEqual(
    codes(result).filter((code) => code.startsWith('CUSTOM_FIELD')),
    [
      'CUSTOM_FIELD_LINE_MALFORMED',
      'CUSTOM_FIELD_VALUE_MALFORMED',
      'CUSTOM_FIELD_VALUE_MALFORMED',
      'CUSTOM_FIELD_VALUE_MALFORMED',
    ],
  );
  assert.equal(result.cases[0].customFields.length, 0);
});

test('validates nested steps and expected results from the example syntax', () => {
  const result = parseMarkdownImport(
    [
      '## Case',
      '### Steps',
      '```testops',
      '[step 1] Parent',
      '\t[expected 1.1] Parent result',
      '\t[step 1.1] Child',
      '\t\t[expected 1.1.1] Child result',
      '[step 2] Next',
      '\t[expected 2.1] Next result',
      '```',
    ].join('\n'),
  );

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.cases[0].scenario, [
    { text: 'Parent', depth: 0, expectedResults: ['Parent result'] },
    { text: 'Child', depth: 1, expectedResults: ['Child result'] },
    { text: 'Next', depth: 0, expectedResults: ['Next result'] },
  ]);
  const summary = summarizeImport({ ...result }) as {
    cases: { steps: number; expectedResults: number; nestedSteps: number }[];
  };
  assert.equal(summary.cases[0].steps, 3);
  assert.equal(summary.cases[0].expectedResults, 3);
  assert.equal(summary.cases[0].nestedSteps, 1);
});

test('rejects orphan expected results, invalid indentation, depth jumps, and unsupported markers', () => {
  const result = parseMarkdownImport(
    [
      '## Case',
      '### Steps',
      '[expected 1] Orphan',
      '[step 1] Parent',
      '  [expected 1.1] Two spaces',
      '\t\t[step 1.1.1] Depth jump',
      '\t[attachment 1.2] File',
    ].join('\n'),
  );

  assert.ok(codes(result).includes('ORPHAN_EXPECTED_RESULT'));
  assert.ok(codes(result).includes('INVALID_SCENARIO_INDENTATION'));
  assert.ok(codes(result).includes('ORPHAN_SCENARIO_STEP'));
  assert.ok(codes(result).includes('UNSUPPORTED_SCENARIO_MARKER'));
});

test('requires a unique named case with a scenario section', () => {
  const result = parseMarkdownImport(
    ['## Same', 'No scenario', '## same', '### Steps', '[step] Action'].join('\n'),
  );

  assert.ok(codes(result).includes('MISSING_SCENARIO_SECTION'));
  assert.ok(codes(result).includes('DUPLICATE_TEST_CASE_NAME'));

  const empty = parseMarkdownImport('##\n');
  assert.ok(codes(empty).includes('EMPTY_TEST_CASE_NAME'));
  assert.ok(codes(empty).includes('NO_TEST_CASES'));
});

test('reports section headings written at the test-case level', () => {
  const result = parseMarkdownImport(
    ['# Wrong case heading', '## Steps', '[step] Action', '## Fields', '- Team: T22'].join('\n'),
  );

  assert.equal(result.cases.length, 0);
  assert.deepEqual(codes(result), ['INVALID_HEADING_LEVELS']);
});

test('enforces extension, regular-file, size, encoding, and allowed-root checks', async (t) => {
  const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'testops-md-allowed-'));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'testops-md-outside-'));
  t.onTestFinished(async () => {
    await fs.rm(allowedRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  const validFile = path.join(allowedRoot, 'case.MARKDOWN');
  await fs.writeFile(validFile, '## Case\n### Steps\n[step] Action', 'utf8');
  assert.deepEqual(
    (await parseMarkdownImportFile(validFile, { allowedRoots: [allowedRoot] })).diagnostics,
    [],
  );

  const relative = await parseMarkdownImportFile('case.md', { allowedRoots: [allowedRoot] });
  assert.ok(codes(relative).includes('FILE_PATH_NOT_ABSOLUTE'));

  const wrongExtension = await parseMarkdownImportFile(path.join(allowedRoot, 'case.txt'));
  assert.ok(codes(wrongExtension).includes('FILE_EXTENSION_UNSUPPORTED'));

  const directory = path.join(allowedRoot, 'folder.md');
  await fs.mkdir(directory);
  assert.ok(
    codes(await parseMarkdownImportFile(directory, { allowedRoots: [allowedRoot] })).includes(
      'FILE_NOT_REGULAR',
    ),
  );

  const oversized = path.join(allowedRoot, 'large.md');
  await fs.writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  assert.ok(
    codes(await parseMarkdownImportFile(oversized, { allowedRoots: [allowedRoot] })).includes(
      'FILE_TOO_LARGE',
    ),
  );

  const invalidUtf8 = path.join(allowedRoot, 'invalid.md');
  await fs.writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
  assert.ok(
    codes(await parseMarkdownImportFile(invalidUtf8, { allowedRoots: [allowedRoot] })).includes(
      'FILE_ENCODING_INVALID',
    ),
  );

  const outsideFile = path.join(outsideRoot, 'outside.md');
  await fs.writeFile(outsideFile, '## Case\n### Steps\n[step] Action', 'utf8');
  assert.ok(
    codes(await parseMarkdownImportFile(outsideFile)).includes('FILE_OUTSIDE_ALLOWED_ROOT'),
  );
  assert.ok(
    codes(await parseMarkdownImportFile(outsideFile, { allowedRoots: [allowedRoot] })).includes(
      'FILE_OUTSIDE_ALLOWED_ROOT',
    ),
  );

  const symlink = path.join(allowedRoot, 'escape.md');
  try {
    await fs.symlink(outsideFile, symlink, 'file');
    assert.ok(
      codes(await parseMarkdownImportFile(symlink, { allowedRoots: [allowedRoot] })).includes(
        'FILE_OUTSIDE_ALLOWED_ROOT',
      ),
    );
  } catch (error: unknown) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['EPERM', 'EACCES'].includes(String((error as { code: unknown }).code))
    )) {
      throw error;
    }
    await t.annotate('Symlink escape assertion skipped: the platform denied symlink creation');
  }

  const disguisedTarget = path.join(allowedRoot, 'not-markdown.txt');
  const disguisedLink = path.join(allowedRoot, 'disguised.md');
  await fs.writeFile(disguisedTarget, '## Case\n### Steps\n[step] Action', 'utf8');
  try {
    await fs.symlink(disguisedTarget, disguisedLink, 'file');
    assert.ok(
      codes(await parseMarkdownImportFile(disguisedLink, { allowedRoots: [allowedRoot] })).includes(
        'FILE_EXTENSION_UNSUPPORTED',
      ),
    );
  } catch (error: unknown) {
    if (!(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['EPERM', 'EACCES'].includes(String((error as { code: unknown }).code))
    )) {
      throw error;
    }
    await t.annotate('Resolved-extension assertion skipped: the platform denied symlink creation');
  }
});
