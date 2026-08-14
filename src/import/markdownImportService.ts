import {
  ImportedTestCaseCreateError,
  ImportedTestCaseOutcomeUnknownError,
} from '../client/TestOpsClient';
import type {
  ResolvedCustomFieldAssignment,
  TestCase,
  TestCaseImportCreateRequest,
} from '../client/types';
import { JIRA_NOT_CONFIGURED_MESSAGE } from '../testops.constants';

import {
  resolveCustomFields,
  type CustomFieldCatalogClient,
  type FieldResolutionReport,
  type ResolvedCaseCustomFields,
} from './customFieldResolver';
import {
  parseMarkdownImportFile,
  type ImportDiagnostic,
  type ParsedMarkdownTestCase,
} from './markdown';

export interface MarkdownImportClient extends CustomFieldCatalogClient {
  createImportedTestCase(data: TestCaseImportCreateRequest): Promise<TestCase>;
}

export interface PreparedMarkdownImportCase {
  caseIndex: number;
  testCase: ParsedMarkdownTestCase;
  resolution: ResolvedCaseCustomFields;
}

export interface MarkdownImportCaseReport {
  caseIndex: number;
  name: string;
  line: number;
  fields: FieldResolutionReport[];
  assignments: ResolvedCustomFieldAssignment[];
}

export interface MarkdownImportPreflightReport {
  kind: 'preflight';
  status: 'valid' | 'invalid';
  filePath?: string;
  projectId: number;
  totalCases: number;
  errorCount: number;
  warningCount: number;
  diagnostics: ImportDiagnostic[];
  cases: MarkdownImportCaseReport[];
}

export interface MarkdownImportPreflight {
  filePath?: string;
  projectId: number;
  valid: boolean;
  cases: PreparedMarkdownImportCase[];
  diagnostics: ImportDiagnostic[];
  report: MarkdownImportPreflightReport;
}

export interface CreatedMarkdownTestCase {
  caseIndex: number;
  caseName: string;
  testCaseId: number;
}

export interface PartiallyCreatedMarkdownTestCase extends CreatedMarkdownTestCase {
  stage: ImportedTestCaseCreateError['stage'];
  error: string;
}

export interface FailedMarkdownTestCase {
  caseIndex: number;
  caseName: string;
  error: string;
  testCaseId?: number;
  stage?: ImportedTestCaseCreateError['stage'];
  outcomeUnknown?: boolean;
}

export interface NotAttemptedMarkdownTestCase {
  caseIndex: number;
  caseName: string;
  reason: 'validation_failed' | 'stopped_after_failure' | 'stopped_after_unknown_outcome';
}

export interface MarkdownImportUploadReport {
  kind: 'upload';
  status: 'completed' | 'refused' | 'failed' | 'outcome_unknown';
  message: string;
  filePath?: string;
  projectId: number;
  totalCases: number;
  errorCount: number;
  warningCount: number;
  cases: MarkdownImportCaseReport[];
  created: CreatedMarkdownTestCase[];
  partiallyCreated: PartiallyCreatedMarkdownTestCase[];
  failedCase?: FailedMarkdownTestCase;
  notAttempted: NotAttemptedMarkdownTestCase[];
  diagnostics: ImportDiagnostic[];
}

export interface MarkdownImportUploadResult {
  status: MarkdownImportUploadReport['status'];
  filePath?: string;
  projectId: number;
  created: CreatedMarkdownTestCase[];
  partiallyCreated: PartiallyCreatedMarkdownTestCase[];
  failedCase?: FailedMarkdownTestCase;
  notAttempted: NotAttemptedMarkdownTestCase[];
  diagnostics: ImportDiagnostic[];
  report: MarkdownImportUploadReport;
}

export type MarkdownImportReport = MarkdownImportPreflightReport | MarkdownImportUploadReport;

export interface MarkdownImportPreflightOptions {
  /** Directories the file may be read from; empty allows none. */
  allowedRoots?: readonly string[];
  /**
   * False when `TESTOPS_JIRA_BASE_URL` is unset, so issue keys cannot become
   * links. Preflight then refuses a file that has them instead of letting the
   * import fail after the first cases are already in TestOps.
   */
  issueLinksConfigured?: boolean;
}

export async function prepareMarkdownImport(
  filePath: string,
  projectId: number,
  client: CustomFieldCatalogClient,
  options: MarkdownImportPreflightOptions = {},
): Promise<MarkdownImportPreflight> {
  const { allowedRoots = [], issueLinksConfigured = true } = options;
  const parsed = await parseMarkdownImportFile(filePath, {
    allowedRoots: [...allowedRoots],
  });
  const resolution =
    parsed.cases.length === 0 || hasErrors(parsed.diagnostics)
      ? {
          cases: parsed.cases.map(emptyResolution),
          diagnostics: [] as ImportDiagnostic[],
        }
      : await resolveCustomFields(parsed.cases, projectId, client);
  const diagnostics = [...parsed.diagnostics, ...resolution.diagnostics];

  if (!issueLinksConfigured) {
    for (const testCase of parsed.cases) {
      if (testCase.issueKeys.length === 0) continue;
      diagnostics.push({
        severity: 'error',
        code: 'JIRA_NOT_CONFIGURED',
        message: JIRA_NOT_CONFIGURED_MESSAGE,
        line: testCase.line,
        caseName: testCase.name,
        section: 'issues',
      });
    }
  }

  const resolutionsByIndex = new Map<number, ResolvedCaseCustomFields>();

  for (const resolvedCase of resolution.cases) {
    resolutionsByIndex.set(resolvedCase.caseIndex, resolvedCase);
  }

  const preparedCases = parsed.cases.map((testCase, caseIndex): PreparedMarkdownImportCase => {
    const resolvedCase = resolutionsByIndex.get(caseIndex);
    if (resolvedCase) {
      return { caseIndex, testCase, resolution: resolvedCase };
    }

    diagnostics.push({
      severity: 'error',
      code: 'FIELD_RESOLUTION_MISSING',
      message: 'Custom-field resolution did not return a result for this test case',
      line: testCase.line,
      caseName: testCase.name,
      section: 'fields',
    });
    return {
      caseIndex,
      testCase,
      resolution: {
        caseIndex,
        caseName: testCase.name,
        assignments: [],
        fields: [],
      },
    };
  });

  const valid = !hasErrors(diagnostics);
  const report = buildPreflightReport(
    parsed.filePath,
    projectId,
    valid,
    preparedCases,
    diagnostics,
  );

  return {
    filePath: parsed.filePath,
    projectId,
    valid,
    cases: preparedCases,
    diagnostics,
    report,
  };
}

export async function uploadPreparedMarkdownImport(
  preflight: MarkdownImportPreflight,
  client: Pick<MarkdownImportClient, 'createImportedTestCase'>,
): Promise<MarkdownImportUploadResult> {
  const created: CreatedMarkdownTestCase[] = [];
  const partiallyCreated: PartiallyCreatedMarkdownTestCase[] = [];

  if (!preflight.valid || hasErrors(preflight.diagnostics)) {
    return buildUploadResult({
      preflight,
      status: 'refused',
      created,
      partiallyCreated,
      notAttempted: preflight.cases.map((item) => notAttempted(item, 'validation_failed')),
      diagnostics: [...preflight.diagnostics],
    });
  }

  for (const [position, item] of preflight.cases.entries()) {
    try {
      const createdTestCase = await client.createImportedTestCase({
        name: item.testCase.name,
        description: item.testCase.description || undefined,
        preconditions: item.testCase.preconditions,
        scenario: item.testCase.scenario,
        resolvedCustomFields: item.resolution.assignments,
        tags: item.testCase.tags,
        issueKeys: item.testCase.issueKeys,
      });
      created.push({
        caseIndex: item.caseIndex,
        caseName: item.testCase.name,
        testCaseId: createdTestCase.id,
      });
    } catch (error: unknown) {
      const failedCase = toFailedCase(item, error);
      const diagnostics = [...preflight.diagnostics, uploadDiagnostic(item, error)];

      if (error instanceof ImportedTestCaseOutcomeUnknownError) {
        return buildUploadResult({
          preflight,
          status: 'outcome_unknown',
          created,
          partiallyCreated,
          failedCase,
          notAttempted: preflight.cases
            .slice(position + 1)
            .map((remaining) => notAttempted(remaining, 'stopped_after_unknown_outcome')),
          diagnostics,
        });
      }

      if (error instanceof ImportedTestCaseCreateError) {
        partiallyCreated.push({
          caseIndex: item.caseIndex,
          caseName: item.testCase.name,
          testCaseId: error.testCaseId,
          stage: error.stage,
          error: errorMessage(error.originalError),
        });
      }

      return buildUploadResult({
        preflight,
        status: 'failed',
        created,
        partiallyCreated,
        failedCase,
        notAttempted: preflight.cases
          .slice(position + 1)
          .map((remaining) => notAttempted(remaining, 'stopped_after_failure')),
        diagnostics,
      });
    }
  }

  return buildUploadResult({
    preflight,
    status: 'completed',
    created,
    partiallyCreated,
    notAttempted: [],
    diagnostics: [...preflight.diagnostics],
  });
}

export function serializeMarkdownImportReport(report: MarkdownImportReport): string {
  const lines = [
    report.kind === 'preflight'
      ? `Markdown import preflight: ${report.status.toUpperCase()}`
      : `Markdown import upload: ${report.status.toUpperCase()}`,
    `File: ${report.filePath || '(unresolved)'}`,
    `Project: ${report.projectId}`,
    `Cases: ${report.totalCases}; errors: ${report.errorCount}; warnings: ${report.warningCount}`,
  ];

  if (report.kind === 'preflight') {
    appendPreflightCases(lines, report.cases);
  } else {
    appendUploadOutcome(lines, report);
    appendPreflightCases(lines, report.cases);
  }

  appendDiagnostics(lines, report.diagnostics);
  return lines.join('\n');
}

interface UploadResultInput {
  preflight: MarkdownImportPreflight;
  status: MarkdownImportUploadResult['status'];
  created: CreatedMarkdownTestCase[];
  partiallyCreated: PartiallyCreatedMarkdownTestCase[];
  failedCase?: FailedMarkdownTestCase;
  notAttempted: NotAttemptedMarkdownTestCase[];
  diagnostics: ImportDiagnostic[];
}

function buildPreflightReport(
  filePath: string | undefined,
  projectId: number,
  valid: boolean,
  cases: PreparedMarkdownImportCase[],
  diagnostics: ImportDiagnostic[],
): MarkdownImportPreflightReport {
  const counts = diagnosticCounts(diagnostics);
  return {
    kind: 'preflight',
    status: valid ? 'valid' : 'invalid',
    filePath,
    projectId,
    totalCases: cases.length,
    errorCount: counts.errors,
    warningCount: counts.warnings,
    diagnostics,
    cases: cases.map((item) => ({
      caseIndex: item.caseIndex,
      name: item.testCase.name,
      line: item.testCase.line,
      fields: item.resolution.fields,
      assignments: item.resolution.assignments,
    })),
  };
}

function buildUploadResult(input: UploadResultInput): MarkdownImportUploadResult {
  const counts = diagnosticCounts(input.diagnostics);
  const report: MarkdownImportUploadReport = {
    kind: 'upload',
    status: input.status,
    message: uploadMessage(input.status),
    filePath: input.preflight.filePath,
    projectId: input.preflight.projectId,
    totalCases: input.preflight.cases.length,
    errorCount: counts.errors,
    warningCount: counts.warnings,
    cases: input.preflight.report.cases,
    created: input.created,
    partiallyCreated: input.partiallyCreated,
    failedCase: input.failedCase,
    notAttempted: input.notAttempted,
    diagnostics: input.diagnostics,
  };

  return {
    status: input.status,
    filePath: input.preflight.filePath,
    projectId: input.preflight.projectId,
    created: input.created,
    partiallyCreated: input.partiallyCreated,
    failedCase: input.failedCase,
    notAttempted: input.notAttempted,
    diagnostics: input.diagnostics,
    report,
  };
}

function emptyResolution(
  testCase: ParsedMarkdownTestCase,
  caseIndex: number,
): ResolvedCaseCustomFields {
  return {
    caseIndex,
    caseName: testCase.name,
    assignments: [],
    fields: [],
  };
}

function uploadMessage(status: MarkdownImportUploadReport['status']): string {
  switch (status) {
    case 'completed':
      return 'Import completed.';
    case 'refused':
      return 'Import was refused during validation. No test cases were created.';
    case 'failed':
      return 'Import failed while trying to create a test case. Review and reconcile the report; do not perform any retry, deletion, or rollback automatically.';
    case 'outcome_unknown':
      return 'Import stopped because TestOps may have created a test case without confirming the result. Reconcile whether it exists; do not perform any retry, deletion, or rollback automatically.';
  }
}

function toFailedCase(item: PreparedMarkdownImportCase, error: unknown): FailedMarkdownTestCase {
  if (error instanceof ImportedTestCaseOutcomeUnknownError) {
    return {
      caseIndex: item.caseIndex,
      caseName: item.testCase.name,
      error: errorMessage(error),
      outcomeUnknown: true,
    };
  }

  if (error instanceof ImportedTestCaseCreateError) {
    return {
      caseIndex: item.caseIndex,
      caseName: item.testCase.name,
      testCaseId: error.testCaseId,
      stage: error.stage,
      error: errorMessage(error),
    };
  }

  return {
    caseIndex: item.caseIndex,
    caseName: item.testCase.name,
    error: errorMessage(error),
  };
}

function uploadDiagnostic(item: PreparedMarkdownImportCase, error: unknown): ImportDiagnostic {
  return {
    severity: 'error',
    code:
      error instanceof ImportedTestCaseOutcomeUnknownError
        ? 'TEST_CASE_CREATE_OUTCOME_UNKNOWN'
        : error instanceof ImportedTestCaseCreateError
          ? error.stage === 'scenario'
            ? 'TEST_CASE_SCENARIO_UPLOAD_FAILED'
            : 'TEST_CASE_METADATA_UPLOAD_FAILED'
          : 'TEST_CASE_UPLOAD_FAILED',
    message: errorMessage(error),
    line: item.testCase.line,
    caseName: item.testCase.name,
  };
}

function notAttempted(
  item: PreparedMarkdownImportCase,
  reason: NotAttemptedMarkdownTestCase['reason'],
): NotAttemptedMarkdownTestCase {
  return {
    caseIndex: item.caseIndex,
    caseName: item.testCase.name,
    reason,
  };
}

function hasErrors(diagnostics: ImportDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

function diagnosticCounts(diagnostics: ImportDiagnostic[]): { errors: number; warnings: number } {
  return diagnostics.reduce(
    (counts, diagnostic) => {
      counts[diagnostic.severity === 'error' ? 'errors' : 'warnings']++;
      return counts;
    },
    { errors: 0, warnings: 0 },
  );
}

function appendPreflightCases(lines: string[], cases: MarkdownImportCaseReport[]): void {
  lines.push('Field resolution:');
  if (cases.length === 0) {
    lines.push('- No test cases parsed');
    return;
  }

  for (const testCase of cases) {
    lines.push(`- ${testCase.name} (line ${testCase.line})`);
    if (testCase.fields.length === 0) {
      lines.push('  - No custom fields declared or resolved');
      continue;
    }

    for (const field of testCase.fields) {
      const fieldTarget = field.fieldName ? ` -> ${field.fieldName}` : '';
      lines.push(`  - ${field.input}${fieldTarget}: ${field.status}`);
      for (const value of field.values) {
        const valueTarget = value.valueName ? ` -> ${value.valueName}` : '';
        const candidates =
          value.candidates.length > 0
            ? `; candidates: ${value.candidates.map((item) => item.name).join(', ')}`
            : '';
        lines.push(`    - ${value.input}${valueTarget}: ${value.status}${candidates}`);
      }
      if (field.status !== 'resolved' && field.candidates.length > 0) {
        lines.push(`    - Candidates: ${field.candidates.map((item) => item.name).join(', ')}`);
      }
    }
  }
}

function appendUploadOutcome(lines: string[], report: MarkdownImportUploadReport): void {
  lines.push(report.message);
  lines.push(
    `Created: ${report.created.length}; partially created: ${report.partiallyCreated.length}; not attempted: ${report.notAttempted.length}`,
  );
  for (const item of report.created) {
    lines.push(`- Created ${item.caseName}: testCaseId=${item.testCaseId}`);
  }
  for (const item of report.partiallyCreated) {
    lines.push(
      `- Partially created ${item.caseName}: testCaseId=${item.testCaseId}, failed stage=${item.stage}: ${item.error}`,
    );
  }
  if (report.failedCase?.outcomeUnknown) {
    lines.push(
      `- UNKNOWN OUTCOME ${report.failedCase.caseName}: TestOps may have created this test case; do not perform any retry, deletion, or rollback automatically. ${report.failedCase.error}`,
    );
  } else if (report.failedCase && report.partiallyCreated.length === 0) {
    lines.push(`- Failed ${report.failedCase.caseName}: ${report.failedCase.error}`);
  }
  for (const item of report.notAttempted) {
    lines.push(`- Not attempted ${item.caseName}: ${item.reason}`);
  }
}

function appendDiagnostics(lines: string[], diagnostics: ImportDiagnostic[]): void {
  if (diagnostics.length === 0) return;

  lines.push('Diagnostics:');
  for (const diagnostic of diagnostics) {
    const location = [
      diagnostic.caseName,
      diagnostic.line === undefined ? undefined : `line ${diagnostic.line}`,
      diagnostic.section,
    ].filter((part): part is string => Boolean(part));
    const locationText = location.length > 0 ? ` [${location.join(', ')}]` : '';
    const candidates =
      diagnostic.candidates && diagnostic.candidates.length > 0
        ? `; candidates: ${diagnostic.candidates.join(', ')}`
        : '';
    lines.push(
      `- ${diagnostic.severity.toUpperCase()} ${diagnostic.code}${locationText}: ${diagnostic.message}${candidates}`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
