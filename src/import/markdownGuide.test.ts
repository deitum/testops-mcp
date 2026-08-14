import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { test } from 'vitest';

import { loadMarkdownGuide } from './markdownGuide';

test('returns the complete canonical Markdown rules and example files', async () => {
  const guide = await loadMarkdownGuide();
  const [rulesFile, exampleFile] = await Promise.all([
    fs.readFile(path.resolve('docs/markdown-import.md'), 'utf8'),
    fs.readFile(path.resolve('examples/testops-markdown-import-example.md'), 'utf8'),
  ]);

  assert.equal(guide.rules, rulesFile);
  assert.equal(guide.example, exampleFile);
  assert.match(guide.rules, /^# Формат Markdown для импорта тест-кейсов/m);
  assert.match(guide.rules, /Этот этап не транзакционный/i);
  assert.match(guide.rules, /`completed`.*`refused`.*`failed`.*`outcome_unknown`/s);
  assert.doesNotMatch(guide.rules, /заведено в проекте/i);
  assert.match(guide.example, /^## TC-01\./m);
  for (const heading of ['Описание', 'Предусловия', 'Шаги', 'Теги', 'Поля']) {
    assert.match(guide.example, new RegExp(`^### ${heading}$`, 'm'));
  }
});
