import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

import type { ScenarioStep } from '../client/types';
import { MAX_IMPORT_BYTES } from '../testops.constants';

type SectionKey = 'description' | 'preconditions' | 'scenario' | 'tags' | 'issues' | 'fields';

const SECTION_ALIASES: Record<string, SectionKey> = {
  описание: 'description',
  description: 'description',
  предусловия: 'preconditions',
  preconditions: 'preconditions',
  шаги: 'scenario',
  сценарий: 'scenario',
  steps: 'scenario',
  scenario: 'scenario',
  теги: 'tags',
  tags: 'tags',
  ссылки: 'issues',
  issues: 'issues',
  jira: 'issues',
  links: 'issues',
  поля: 'fields',
  'кастомные поля': 'fields',
  fields: 'fields',
  'custom fields': 'fields',
};

const UNSUPPORTED_SECTION_NAMES = new Set(['папки', 'folders']);

export interface ImportDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line?: number;
  column?: number;
  caseName?: string;
  section?: string;
  candidates?: string[];
}

export interface ParsedCustomField {
  name: string;
  values: string[];
  line: number;
}

export interface ParsedMarkdownTestCase {
  name: string;
  line: number;
  description: string;
  preconditions: string[];
  scenario: ScenarioStep[];
  tags: string[];
  issueKeys: string[];
  customFields: ParsedCustomField[];
}

export interface MarkdownImportParseResult {
  filePath?: string;
  cases: ParsedMarkdownTestCase[];
  diagnostics: ImportDiagnostic[];
}

export interface MarkdownImportFileOptions {
  allowedRoots?: string[];
}

interface SourceLine {
  text: string;
  number: number;
  inFence: boolean;
}

interface Fence {
  character: '`' | '~';
  length: number;
  line: number;
}

interface AnnotatedLines {
  lines: SourceLine[];
  unclosedFence?: Fence;
}

interface CsvParseResult {
  values: string[];
  error?: string;
  errorOffset?: number;
}

export async function parseMarkdownImportFile(
  filePath: string,
  options: MarkdownImportFileOptions = {},
): Promise<MarkdownImportParseResult> {
  const diagnostics: ImportDiagnostic[] = [];

  if (!path.isAbsolute(filePath)) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_PATH_NOT_ABSOLUTE',
      message: `Markdown file path must be absolute: ${filePath}`,
    });
    return { filePath, cases: [], diagnostics };
  }

  const resolvedPath = path.resolve(filePath);

  if (!['.md', '.markdown'].includes(path.extname(resolvedPath).toLowerCase())) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_EXTENSION_UNSUPPORTED',
      message: 'Only .md and .markdown files are supported',
    });
    return { filePath: resolvedPath, cases: [], diagnostics };
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(resolvedPath);
  } catch (error: unknown) {
    const code = getErrorCode(error);
    diagnostics.push({
      severity: 'error',
      code: code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'FILE_UNREADABLE',
      message:
        code === 'ENOENT'
          ? `Markdown file does not exist: ${resolvedPath}`
          : `Cannot resolve Markdown file: ${errorMessage(error)}`,
    });
    return { filePath: resolvedPath, cases: [], diagnostics };
  }

  if (!['.md', '.markdown'].includes(path.extname(realPath).toLowerCase())) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_EXTENSION_UNSUPPORTED',
      message: `Resolved import target must be a .md or .markdown file: ${realPath}`,
    });
    return { filePath: realPath, cases: [], diagnostics };
  }

  const configuredRoots = options.allowedRoots?.length ? options.allowedRoots : [process.cwd()];
  if (configuredRoots.length > 0) {
    const allowedRoots: string[] = [];
    for (const configuredRoot of configuredRoots) {
      try {
        const realRoot = await fs.realpath(path.resolve(configuredRoot));
        const rootStat = await fs.stat(realRoot);
        if (!rootStat.isDirectory()) {
          diagnostics.push({
            severity: 'error',
            code: 'IMPORT_ROOT_INVALID',
            message: `Configured import root is not a directory: ${configuredRoot}`,
          });
          return { filePath: realPath, cases: [], diagnostics };
        }
        allowedRoots.push(realRoot);
      } catch (error: unknown) {
        diagnostics.push({
          severity: 'error',
          code: 'IMPORT_ROOT_UNAVAILABLE',
          message: `Cannot resolve configured import root "${configuredRoot}": ${errorMessage(error)}`,
        });
        return { filePath: realPath, cases: [], diagnostics };
      }
    }

    if (!allowedRoots.some((root) => isPathWithinRoot(realPath, root))) {
      diagnostics.push({
        severity: 'error',
        code: 'FILE_OUTSIDE_ALLOWED_ROOT',
        message: `Markdown file is outside the configured import roots: ${realPath}`,
        candidates: allowedRoots,
      });
      return { filePath: realPath, cases: [], diagnostics };
    }
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(realPath);
  } catch (error: unknown) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_UNREADABLE',
      message: `Cannot inspect Markdown file: ${errorMessage(error)}`,
    });
    return { filePath: realPath, cases: [], diagnostics };
  }

  if (!stat.isFile()) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_NOT_REGULAR',
      message: `Markdown import path is not a regular file: ${realPath}`,
    });
    return { filePath: realPath, cases: [], diagnostics };
  }

  if (stat.size > MAX_IMPORT_BYTES) {
    diagnostics.push({
      severity: 'error',
      code: 'FILE_TOO_LARGE',
      message: `Markdown file is too large: ${stat.size} bytes (maximum ${MAX_IMPORT_BYTES})`,
    });
    return { filePath: realPath, cases: [], diagnostics };
  }

  let content: string;
  try {
    const bytes = await fs.readFile(realPath);
    if (bytes.length > MAX_IMPORT_BYTES) {
      diagnostics.push({
        severity: 'error',
        code: 'FILE_TOO_LARGE',
        message: `Markdown file is too large: ${bytes.length} bytes (maximum ${MAX_IMPORT_BYTES})`,
      });
      return { filePath: realPath, cases: [], diagnostics };
    }
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    diagnostics.push({
      severity: 'error',
      code: error instanceof TypeError ? 'FILE_ENCODING_INVALID' : 'FILE_UNREADABLE',
      message:
        error instanceof TypeError
          ? 'Markdown file is not valid UTF-8'
          : `Cannot read Markdown file: ${errorMessage(error)}`,
    });
    return { filePath: realPath, cases: [], diagnostics };
  }

  const parsed = parseMarkdownImport(content);
  return { filePath: realPath, cases: parsed.cases, diagnostics: parsed.diagnostics };
}

export function parseMarkdownImport(content: string): MarkdownImportParseResult {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const annotated = annotateFences(normalized.split('\n'));
  const diagnostics: ImportDiagnostic[] = [];

  if (annotated.unclosedFence) {
    diagnostics.push({
      severity: 'error',
      code: 'UNCLOSED_MARKDOWN_FENCE',
      message: 'Markdown code fence is not closed',
      line: annotated.unclosedFence.line,
    });
  }

  const ranges = caseRanges(annotated.lines, diagnostics);
  if (
    ranges.length === 0 &&
    !diagnostics.some((diagnostic) => diagnostic.code === 'INVALID_HEADING_LEVELS')
  ) {
    diagnostics.push({
      severity: 'error',
      code: 'NO_TEST_CASES',
      message: 'No test case headings found. Expected a heading like "## Test case name"',
    });
  }

  const cases: ParsedMarkdownTestCase[] = [];
  const names = new Map<string, ParsedMarkdownTestCase>();

  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    const nextLineIndex = ranges[index + 1]?.index ?? annotated.lines.length;
    const testCase = parseCase(
      range.title,
      range.line,
      annotated.lines.slice(range.index + 1, nextLineIndex),
      diagnostics,
    );

    const normalizedName = normalizeLookup(testCase.name);
    const previous = names.get(normalizedName);
    if (previous) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_TEST_CASE_NAME',
        message: `Test case name duplicates the case declared on line ${previous.line}`,
        line: testCase.line,
        caseName: testCase.name,
      });
    } else {
      names.set(normalizedName, testCase);
    }

    cases.push(testCase);
  }

  return { cases, diagnostics };
}

export function summarizeImport(result: MarkdownImportParseResult): Record<string, unknown> {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning');

  return {
    filePath: result.filePath,
    valid: errors.length === 0,
    totalCases: result.cases.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    diagnostics: result.diagnostics,
    cases: result.cases.map((testCase) => ({
      name: testCase.name,
      line: testCase.line,
      preconditions: testCase.preconditions.length,
      steps: testCase.scenario.length,
      expectedResults: testCase.scenario.reduce(
        (count, step) => count + step.expectedResults.length,
        0,
      ),
      nestedSteps: testCase.scenario.filter((step) => step.depth > 0).length,
      tags: testCase.tags,
      issueKeys: testCase.issueKeys,
      customFields: testCase.customFields.map((field) => ({
        name: field.name,
        values: field.values,
        line: field.line,
      })),
    })),
  };
}

function annotateFences(lines: string[]): AnnotatedLines {
  let activeFence: Fence | undefined;
  const annotated = lines.map((text, index): SourceLine => {
    const number = index + 1;
    const inFence = Boolean(activeFence);

    if (activeFence) {
      if (isFenceClose(text, activeFence)) {
        activeFence = undefined;
      }
    } else {
      const opening = parseFenceOpen(text);
      if (opening) {
        activeFence = { ...opening, line: number };
      }
    }

    return { text, number, inFence };
  });

  return { lines: annotated, unclosedFence: activeFence };
}

function caseRanges(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
): { index: number; line: number; title: string }[] {
  const ranges: { index: number; line: number; title: string }[] = [];
  let levelOneTitle: string | undefined;
  let invalidHeadingLevelsReported = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.inFence) continue;

    const levelOneHeading = line.text.match(/^ {0,3}#(?!#)(?:[ \t]+(.*?))?[ \t]*$/);
    if (levelOneHeading) {
      levelOneTitle = stripClosingHashes(levelOneHeading[1] || '').trim() || undefined;
      continue;
    }

    const heading = line.text.match(/^ {0,3}##(?!#)(?:[ \t]+(.*?))?[ \t]*$/);
    if (!heading) continue;

    const title = stripClosingHashes(heading[1] || '').trim();
    if (!title) {
      diagnostics.push({
        severity: 'error',
        code: 'EMPTY_TEST_CASE_NAME',
        message: 'Test case heading must contain a name',
        line: line.number,
        column: 1,
      });
      continue;
    }

    if (levelOneTitle && ranges.length === 0 && SECTION_ALIASES[normalizeLookup(title)]) {
      if (!invalidHeadingLevelsReported) {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_HEADING_LEVELS',
          message: `"# ${levelOneTitle}" looks like a test case and "## ${title}" looks like its section. Use "## ${levelOneTitle}" for the test case and "### ${title}" for the section`,
          line: line.number,
          column: 1,
          caseName: levelOneTitle,
          section: title,
        });
        invalidHeadingLevelsReported = true;
      }
      continue;
    }

    ranges.push({ index, line: line.number, title });
  }

  return ranges;
}

function parseCase(
  name: string,
  line: number,
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
): ParsedMarkdownTestCase {
  const { sections, seen } = splitSections(lines, diagnostics, name);
  let scenario: ScenarioStep[] = [];

  if (!seen.has('scenario')) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_SCENARIO_SECTION',
      message: 'Test case must contain a "### Шаги", "### Steps", or "### Scenario" section',
      line,
      caseName: name,
      section: 'scenario',
    });
  } else {
    scenario = parseScenario(sections.scenario || [], diagnostics, name);
  }

  return {
    name,
    line,
    description: preserveText(sections.description || []),
    preconditions: parseList(sections.preconditions || []),
    scenario,
    tags: parseTags(sections.tags || [], diagnostics, name),
    issueKeys: parseIssueKeys(sections.issues || [], diagnostics, name),
    customFields: parseFields(sections.fields || [], diagnostics, name),
  };
}

function splitSections(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
  caseName: string,
): {
  sections: Partial<Record<SectionKey, SourceLine[]>>;
  seen: Set<SectionKey>;
} {
  const sections: Partial<Record<SectionKey, SourceLine[]>> = { description: [] };
  const seen = new Set<SectionKey>();
  let current: SectionKey | undefined = 'description';

  for (const line of lines) {
    const heading = !line.inFence
      ? line.text.match(/^ {0,3}###(?!#)[ \t]+(.+?)[ \t]*$/)
      : undefined;

    if (heading) {
      const sectionName = stripClosingHashes(heading[1]).trim();
      const lookupName = normalizeLookup(sectionName);

      if (UNSUPPORTED_SECTION_NAMES.has(lookupName)) {
        diagnostics.push({
          severity: 'error',
          code: 'UNSUPPORTED_SECTION',
          message: `Section "${sectionName}" is not supported by Markdown import`,
          line: line.number,
          caseName,
          section: sectionName,
        });
        current = undefined;
        continue;
      }

      const key = SECTION_ALIASES[lookupName];
      if (!key) {
        diagnostics.push({
          severity: 'error',
          code: 'UNKNOWN_SECTION',
          message: `Unsupported section "${sectionName}"`,
          line: line.number,
          caseName,
          section: sectionName,
        });
        current = undefined;
        continue;
      }

      if (seen.has(key)) {
        diagnostics.push({
          severity: 'error',
          code: 'DUPLICATE_SECTION',
          message: `Section "${sectionName}" is declared more than once`,
          line: line.number,
          caseName,
          section: key,
        });
      }

      seen.add(key);
      current = key;
      sections[key] = sections[key] || [];
      continue;
    }

    if (current) {
      sections[current]?.push(line);
    }
  }

  return { sections, seen };
}

function parseScenario(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
  caseName: string,
): ScenarioStep[] {
  const body = scenarioBody(lines, diagnostics, caseName);
  const scenarioLines = trimBlankLines(body).filter((line) => line.text.trim());

  if (scenarioLines.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'EMPTY_SCENARIO',
      message: 'Scenario section must contain at least one step',
      line: lines[0]?.number,
      caseName,
      section: 'scenario',
    });
    return [];
  }

  let indentationStyle: 'tabs' | 'spaces' | undefined;
  const steps: ScenarioStep[] = [];
  const lastStepAtDepth = new Map<number, number>();

  for (const line of scenarioLines) {
    const split = line.text.match(/^([ \t]*)(.*)$/);
    const indentation = split?.[1] || '';
    const content = split?.[2] || '';
    const marker = content.match(/^\[(step|expected)(?:\s+([^\]]+))?\]\s+(.+?)\s*$/i);

    if (!marker) {
      const bracket = content.match(/^\[([^\]]+)\](?:\s*(.*))?$/);
      const markerName = bracket?.[1].trim().split(/\s+/)[0].toLowerCase();
      if (markerName && markerName !== 'step' && markerName !== 'expected') {
        diagnostics.push({
          severity: 'error',
          code: 'UNSUPPORTED_SCENARIO_MARKER',
          message: `Scenario marker "${markerName}" is not supported; use [step] or [expected]`,
          line: line.number,
          column: indentation.length + 1,
          caseName,
          section: 'scenario',
        });
      } else if (bracket && (!bracket[2] || !bracket[2].trim())) {
        diagnostics.push({
          severity: 'error',
          code: 'EMPTY_SCENARIO_TEXT',
          message: 'Scenario marker must be followed by non-empty text',
          line: line.number,
          column: indentation.length + 1,
          caseName,
          section: 'scenario',
        });
      } else {
        diagnostics.push({
          severity: 'error',
          code: 'INVALID_SCENARIO_LINE',
          message: `Unsupported scenario line: "${content.trim()}"`,
          line: line.number,
          column: indentation.length + 1,
          caseName,
          section: 'scenario',
        });
      }
      continue;
    }

    const indent = parseIndentation(indentation, indentationStyle);
    if (indent.style && indentationStyle && indent.style !== indentationStyle) {
      diagnostics.push({
        severity: 'error',
        code: 'MIXED_SCENARIO_INDENTATION',
        message: 'Use either tabs or groups of four spaces for the entire scenario',
        line: line.number,
        column: 1,
        caseName,
        section: 'scenario',
      });
      continue;
    }
    if (indent.error) {
      diagnostics.push({
        severity: 'error',
        code: 'INVALID_SCENARIO_INDENTATION',
        message: indent.error,
        line: line.number,
        column: 1,
        caseName,
        section: 'scenario',
      });
      continue;
    }
    if (indent.style && !indentationStyle) indentationStyle = indent.style;

    const depth = indent.depth;
    const markerName = marker[1].toLowerCase();
    const text = marker[3].trim();
    if (markerName === 'step') {
      if (depth > 0 && !lastStepAtDepth.has(depth - 1)) {
        diagnostics.push({
          severity: 'error',
          code: 'ORPHAN_SCENARIO_STEP',
          message: `Step at depth ${depth} has no parent step at depth ${depth - 1}`,
          line: line.number,
          column: indentation.length + 1,
          caseName,
          section: 'scenario',
        });
      }

      for (const knownDepth of Array.from(lastStepAtDepth.keys())) {
        if (knownDepth >= depth) lastStepAtDepth.delete(knownDepth);
      }
      steps.push({ text, depth, expectedResults: [] });
      lastStepAtDepth.set(depth, steps.length - 1);
      continue;
    }

    const parentIndex = depth === 0 ? undefined : lastStepAtDepth.get(depth - 1);
    if (parentIndex === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'ORPHAN_EXPECTED_RESULT',
        message: 'Expected result must be indented exactly one level below its parent step',
        line: line.number,
        column: indentation.length + 1,
        caseName,
        section: 'scenario',
      });
    } else {
      steps[parentIndex].expectedResults.push(text);
    }
  }

  if (steps.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'SCENARIO_HAS_NO_STEPS',
      message: 'Scenario contains no valid [step] lines',
      line: scenarioLines[0]?.number,
      caseName,
      section: 'scenario',
    });
  }

  return steps;
}

function scenarioBody(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
  caseName: string,
): SourceLine[] {
  const trimmed = trimBlankLines(lines);
  const openingIndex = trimmed.findIndex((line) => Boolean(parseFenceOpen(line.text)));
  if (openingIndex < 0) return trimmed;

  const openingLine = trimmed[openingIndex];
  const opening = parseFenceOpen(openingLine.text)!;
  if (openingIndex > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'SCENARIO_CONTENT_OUTSIDE_FENCE',
      message: 'When a scenario uses a code fence, all scenario content must be inside that fence',
      line: trimmed[0].number,
      caseName,
      section: 'scenario',
    });
  }

  const fence: Fence = { ...opening, line: openingLine.number };
  const closingOffset = trimmed
    .slice(openingIndex + 1)
    .findIndex((line) => isFenceClose(line.text, fence));

  if (closingOffset < 0) {
    diagnostics.push({
      severity: 'error',
      code: 'UNCLOSED_SCENARIO_FENCE',
      message: 'Scenario code fence is not closed',
      line: openingLine.number,
      caseName,
      section: 'scenario',
    });
    return trimmed.slice(openingIndex + 1);
  }

  const closingIndex = openingIndex + 1 + closingOffset;
  const trailing = trimmed.slice(closingIndex + 1).filter((line) => line.text.trim());
  if (trailing.length > 0) {
    diagnostics.push({
      severity: 'error',
      code: 'SCENARIO_CONTENT_OUTSIDE_FENCE',
      message: 'When a scenario uses a code fence, all scenario content must be inside that fence',
      line: trailing[0].number,
      caseName,
      section: 'scenario',
    });
  }

  return trimmed.slice(openingIndex + 1, closingIndex);
}

function parseList(lines: SourceLine[]): string[] {
  return lines.map((line) => stripListMarker(line.text).content.trim()).filter(Boolean);
}

function parseTags(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
  caseName: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line.text.trim()) continue;
    const item = stripListMarker(line.text);
    const parsed = parseCsv(item.content);
    if (parsed.error) {
      diagnostics.push({
        severity: 'error',
        code: 'TAG_VALUE_MALFORMED',
        message: parsed.error,
        line: line.number,
        column: item.offset + (parsed.errorOffset || 0) + 1,
        caseName,
        section: 'tags',
      });
      continue;
    }

    for (const value of parsed.values) {
      const key = normalizeLookup(value);
      if (seen.has(key)) {
        diagnostics.push({
          severity: 'warning',
          code: 'DUPLICATE_TAG',
          message: `Duplicate tag "${value}" was ignored`,
          line: line.number,
          caseName,
          section: 'tags',
        });
        continue;
      }
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function parseIssueKeys(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
  caseName: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const value = stripListMarker(line.text).content.trim();
    if (!value) continue;
    const matches = value.match(/\b[A-Z][A-Z0-9_]+-\d+\b/gi) || [];
    if (matches.length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'ISSUE_REFERENCE_MALFORMED',
        message: `Issue reference does not contain a Jira-style key: "${value}"`,
        line: line.number,
        caseName,
        section: 'issues',
      });
      continue;
    }

    for (const match of matches) {
      const key = match.toUpperCase();
      if (seen.has(key)) {
        diagnostics.push({
          severity: 'warning',
          code: 'DUPLICATE_ISSUE_KEY',
          message: `Duplicate issue key "${key}" was ignored`,
          line: line.number,
          caseName,
          section: 'issues',
        });
        continue;
      }
      seen.add(key);
      result.push(key);
    }
  }

  return result;
}

function parseFields(
  lines: SourceLine[],
  diagnostics: ImportDiagnostic[],
  caseName: string,
): ParsedCustomField[] {
  const result: ParsedCustomField[] = [];
  const byName = new Map<string, ParsedCustomField>();

  for (const line of lines) {
    if (!line.text.trim()) continue;
    const item = stripListMarker(line.text);
    const separator = findUnquotedColon(item.content);
    if (separator < 0) {
      diagnostics.push({
        severity: 'error',
        code: 'CUSTOM_FIELD_LINE_MALFORMED',
        message: 'Custom field must use the format "Field name: Value"',
        line: line.number,
        column: item.offset + 1,
        caseName,
        section: 'fields',
      });
      continue;
    }

    const parsedName = parseCsv(item.content.slice(0, separator));
    if (parsedName.error || parsedName.values.length !== 1) {
      diagnostics.push({
        severity: 'error',
        code: 'CUSTOM_FIELD_NAME_MALFORMED',
        message: parsedName.error || 'Custom field name must be a single non-empty value',
        line: line.number,
        column: item.offset + 1,
        caseName,
        section: 'fields',
      });
      continue;
    }

    const name = parsedName.values[0];
    const parsedValues = parseCsv(item.content.slice(separator + 1));
    if (parsedValues.error) {
      diagnostics.push({
        severity: 'error',
        code: 'CUSTOM_FIELD_VALUE_MALFORMED',
        message: parsedValues.error,
        line: line.number,
        column: item.offset + separator + 2 + (parsedValues.errorOffset || 0),
        caseName,
        section: 'fields',
      });
      continue;
    }

    const fieldKey = normalizeLookup(name);
    let field = byName.get(fieldKey);
    if (!field) {
      field = { name, values: [], line: line.number };
      byName.set(fieldKey, field);
      result.push(field);
    } else {
      diagnostics.push({
        severity: 'warning',
        code: 'DUPLICATE_CUSTOM_FIELD',
        message: `Custom field "${name}" is declared more than once; values were merged`,
        line: line.number,
        caseName,
        section: 'fields',
      });
    }

    field.values.push(...parsedValues.values);
  }

  return result;
}

function parseCsv(input: string): CsvParseResult {
  const values: string[] = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length && /[ \t]/.test(input[index])) index++;
    if (index >= input.length) {
      return { values, error: 'List contains an empty value', errorOffset: index };
    }

    let value = '';
    if (input[index] === '"') {
      const quoteOffset = index;
      index++;
      let closed = false;
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        value += input[index];
        index++;
      }
      if (!closed) {
        return { values, error: 'Quoted value is not closed', errorOffset: quoteOffset };
      }
      while (index < input.length && /[ \t]/.test(input[index])) index++;
      if (index < input.length && input[index] !== ',') {
        return {
          values,
          error: 'Only whitespace or a comma is allowed after a quoted value',
          errorOffset: index,
        };
      }
    } else {
      const start = index;
      while (index < input.length && input[index] !== ',') {
        if (input[index] === '"') {
          return {
            values,
            error: 'Quote must start at the beginning of a value',
            errorOffset: index,
          };
        }
        index++;
      }
      value = input.slice(start, index).trim();
    }

    value = value.trim();
    if (!value) {
      return { values, error: 'List contains an empty value', errorOffset: index };
    }
    values.push(value);

    if (index >= input.length) break;
    index++;
    if (index >= input.length) {
      return { values, error: 'List contains an empty trailing value', errorOffset: index };
    }
  }

  if (values.length === 0) {
    return { values, error: 'At least one value is required', errorOffset: 0 };
  }
  return { values };
}

function findUnquotedColon(value: string): number {
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') {
      if (quoted && value[index + 1] === '"') {
        index++;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (value[index] === ':' && !quoted) return index;
  }
  return -1;
}

function stripListMarker(value: string): { content: string; offset: number } {
  const match = value.match(/^(\s*[-*+]\s+)(.*)$/);
  if (!match) {
    const leading = value.match(/^\s*/)?.[0].length || 0;
    return { content: value.slice(leading), offset: leading };
  }
  return { content: match[2], offset: match[1].length };
}

function parseIndentation(
  indentation: string,
  currentStyle: 'tabs' | 'spaces' | undefined,
): { depth: number; style?: 'tabs' | 'spaces'; error?: string } {
  if (!indentation) return { depth: 0 };
  const hasTabs = indentation.includes('\t');
  const hasSpaces = indentation.includes(' ');
  if (hasTabs && hasSpaces) {
    return { depth: 0, error: 'Do not mix tabs and spaces in one indentation prefix' };
  }

  const style: 'tabs' | 'spaces' = hasTabs ? 'tabs' : 'spaces';
  if (currentStyle && currentStyle !== style) {
    return { depth: 0, style };
  }
  if (style === 'spaces' && indentation.length % 4 !== 0) {
    return { depth: 0, style, error: 'Space indentation must use groups of exactly four spaces' };
  }

  return {
    depth: style === 'tabs' ? indentation.length : indentation.length / 4,
    style,
  };
}

function preserveText(lines: SourceLine[]): string {
  return trimBlankLines(lines)
    .map((line) => line.text)
    .join('\n');
}

function trimBlankLines(lines: SourceLine[]): SourceLine[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].text.trim()) start++;
  while (end > start && !lines[end - 1].text.trim()) end--;
  return lines.slice(start, end);
}

function normalizeLookup(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function stripClosingHashes(value: string): string {
  return value.replace(/[ \t]+#+[ \t]*$/, '');
}

function parseFenceOpen(value: string): Pick<Fence, 'character' | 'length'> | undefined {
  const match = value.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return undefined;
  return {
    character: match[1][0] as '`' | '~',
    length: match[1].length,
  };
}

function isFenceClose(value: string, fence: Pick<Fence, 'character' | 'length'>): boolean {
  const trimmedStart = value.match(/^ {0,3}(.*)$/)?.[1];
  if (trimmedStart === undefined || trimmedStart[0] !== fence.character) return false;
  let length = 0;
  while (trimmedStart[length] === fence.character) length++;
  return length >= fence.length && !trimmedStart.slice(length).trim();
}

function isPathWithinRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
