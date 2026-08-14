import type {
  ProjectCustomField,
  ProjectCustomFieldValue,
  ResolvedCustomFieldAssignment,
} from '../client/types';

import type { ImportDiagnostic, ParsedMarkdownTestCase } from './markdown';

export interface CustomFieldCatalogClient {
  listProjectCustomFields(): Promise<ProjectCustomField[]>;
  listProjectCustomFieldValues(fieldId: number): Promise<ProjectCustomFieldValue[]>;
}

export interface ResolutionCandidate {
  id: number;
  name: string;
}

export interface ValueResolutionReport {
  input: string;
  status: 'resolved' | 'not_found' | 'ambiguous' | 'duplicate';
  valueId?: number;
  valueName?: string;
  global?: boolean;
  candidates: ResolutionCandidate[];
}

export interface FieldResolutionReport {
  input: string;
  status: 'resolved' | 'not_found' | 'ambiguous';
  fieldId?: number;
  fieldName?: string;
  required?: boolean;
  singleSelect?: boolean;
  candidates: ResolutionCandidate[];
  values: ValueResolutionReport[];
}

export interface ResolvedCaseCustomFields {
  caseIndex: number;
  caseName: string;
  assignments: ResolvedCustomFieldAssignment[];
  fields: FieldResolutionReport[];
}

export interface CustomFieldResolutionResult {
  cases: ResolvedCaseCustomFields[];
  diagnostics: ImportDiagnostic[];
}

type NamedEntity = { id: number; name: string };

type NameResolution<T extends NamedEntity> =
  | { status: 'resolved'; item: T; candidates: T[] }
  | { status: 'not_found' | 'ambiguous'; candidates: T[] };

interface DiagnosticDetails {
  line?: number;
  caseName?: string;
  section?: string;
  candidates?: string[];
}

export async function resolveCustomFields(
  cases: ParsedMarkdownTestCase[],
  projectId: number,
  client: CustomFieldCatalogClient,
): Promise<CustomFieldResolutionResult> {
  let projectFields: ProjectCustomField[];
  try {
    projectFields = uniqueById(await client.listProjectCustomFields());
  } catch (error) {
    return {
      cases: cases.map((testCase, caseIndex) => ({
        caseIndex,
        caseName: testCase.name,
        assignments: [],
        fields: [],
      })),
      diagnostics: [
        createDiagnostic(
          'error',
          'FIELD_CATALOG_UNAVAILABLE',
          `Could not load custom fields for project ${projectId}: ${errorMessage(error)}`,
          {},
        ),
      ],
    };
  }
  const valuesByFieldId = new Map<number, Promise<ProjectCustomFieldValue[]>>();
  const diagnostics: ImportDiagnostic[] = [];
  const resolvedCases: ResolvedCaseCustomFields[] = [];

  const getValues = (fieldId: number): Promise<ProjectCustomFieldValue[]> => {
    let cached = valuesByFieldId.get(fieldId);
    if (!cached) {
      cached = client.listProjectCustomFieldValues(fieldId).then((values) => uniqueById(values));
      valuesByFieldId.set(fieldId, cached);
    }
    return cached;
  };

  for (const [caseIndex, testCase] of cases.entries()) {
    const assignmentsByFieldId = new Map<number, ResolvedCustomFieldAssignment>();
    const selectionTargetsByFieldId = new Map<number, Set<string>>();
    const encounteredFieldIds = new Set<number>();
    const fieldReports: FieldResolutionReport[] = [];

    for (const parsedField of testCase.customFields) {
      const inputFieldName = parsedField.name;
      const inputValues = parsedField.values.map((value) => normalizeName(value)).filter(Boolean);
      const fieldResolution = resolveName(inputFieldName, projectFields);

      if (fieldResolution.status !== 'resolved') {
        const candidates = toCandidates(fieldResolution.candidates);
        fieldReports.push({
          input: inputFieldName,
          status: fieldResolution.status,
          candidates,
          values: [],
        });
        diagnostics.push(
          createDiagnostic(
            'error',
            fieldResolution.status === 'ambiguous' ? 'FIELD_AMBIGUOUS' : 'FIELD_NOT_FOUND',
            fieldResolution.status === 'ambiguous'
              ? `Custom field "${inputFieldName}" is ambiguous`
              : `Custom field "${inputFieldName}" was not found in project ${projectId}`,
            {
              line: parsedField.line,
              caseName: testCase.name,
              section: 'fields',
              candidates: candidates.map((candidate) => candidate.name),
            },
          ),
        );
        continue;
      }

      const field = fieldResolution.item;
      const duplicateField = encounteredFieldIds.has(field.id);
      encounteredFieldIds.add(field.id);

      if (duplicateField) {
        diagnostics.push(
          createDiagnostic(
            'warning',
            'DUPLICATE_FIELD',
            `Custom field "${field.name}" is declared more than once; its values were merged`,
            { line: parsedField.line, caseName: testCase.name, section: 'fields' },
          ),
        );
      }

      const existingAssignment = assignmentsByFieldId.get(field.id);
      const assignment: ResolvedCustomFieldAssignment = existingAssignment || {
        fieldId: field.id,
        fieldName: field.name,
        required: Boolean(field.required),
        singleSelect: Boolean(field.singleSelect),
        values: [],
      };
      if (!existingAssignment) {
        assignmentsByFieldId.set(field.id, assignment);
      }

      let selectionTargets = selectionTargetsByFieldId.get(field.id);
      if (!selectionTargets) {
        selectionTargets = new Set<string>();
        selectionTargetsByFieldId.set(field.id, selectionTargets);
      }

      const valueReports: ValueResolutionReport[] = [];
      if (inputValues.length === 0) {
        diagnostics.push(
          createDiagnostic(
            'error',
            'FIELD_VALUE_MISSING',
            `Custom field "${field.name}" has no value`,
            { line: parsedField.line, caseName: testCase.name, section: 'fields' },
          ),
        );
      } else {
        let availableValues: ProjectCustomFieldValue[];
        try {
          availableValues = await getValues(field.id);
        } catch (error) {
          diagnostics.push(
            createDiagnostic(
              'error',
              'FIELD_CATALOG_UNAVAILABLE',
              `Could not load values for custom field "${field.name}": ${errorMessage(error)}`,
              { line: parsedField.line, caseName: testCase.name, section: 'fields' },
            ),
          );
          fieldReports.push({
            input: inputFieldName,
            status: 'resolved',
            fieldId: field.id,
            fieldName: field.name,
            required: Boolean(field.required),
            singleSelect: Boolean(field.singleSelect),
            candidates: toCandidates(fieldResolution.candidates),
            values: [],
          });
          continue;
        }

        for (const inputValue of inputValues) {
          const valueResolution = resolveName(inputValue, availableValues);

          if (valueResolution.status !== 'resolved') {
            const candidates = toCandidates(valueResolution.candidates);
            selectionTargets.add(`unresolved:${foldName(inputValue)}`);
            valueReports.push({
              input: inputValue,
              status: valueResolution.status,
              candidates,
            });
            diagnostics.push(
              createDiagnostic(
                'error',
                valueResolution.status === 'ambiguous' ? 'VALUE_AMBIGUOUS' : 'VALUE_NOT_FOUND',
                valueResolution.status === 'ambiguous'
                  ? `Value "${inputValue}" is ambiguous for custom field "${field.name}"`
                  : `Value "${inputValue}" was not found for custom field "${field.name}"`,
                {
                  line: parsedField.line,
                  caseName: testCase.name,
                  section: 'fields',
                  candidates: candidates.map((candidate) => candidate.name),
                },
              ),
            );
            continue;
          }

          const value = valueResolution.item;
          selectionTargets.add(`resolved:${value.id}`);
          const duplicateValue = assignment.values.some((item) => item.valueId === value.id);

          if (duplicateValue) {
            valueReports.push({
              input: inputValue,
              status: 'duplicate',
              valueId: value.id,
              valueName: value.name,
              global: Boolean(value.global),
              candidates: toCandidates(valueResolution.candidates),
            });
            diagnostics.push(
              createDiagnostic(
                'warning',
                'DUPLICATE_FIELD_VALUE',
                `Value "${value.name}" is duplicated for custom field "${field.name}" and was included once`,
                { line: parsedField.line, caseName: testCase.name, section: 'fields' },
              ),
            );
            continue;
          }

          assignment.values.push({
            valueId: value.id,
            valueName: value.name,
            global: Boolean(value.global),
          });
          valueReports.push({
            input: inputValue,
            status: 'resolved',
            valueId: value.id,
            valueName: value.name,
            global: Boolean(value.global),
            candidates: toCandidates(valueResolution.candidates),
          });
        }
      }

      fieldReports.push({
        input: inputFieldName,
        status: 'resolved',
        fieldId: field.id,
        fieldName: field.name,
        required: Boolean(field.required),
        singleSelect: Boolean(field.singleSelect),
        candidates: toCandidates(fieldResolution.candidates),
        values: valueReports,
      });
    }

    for (const field of projectFields) {
      const selectionTargets = selectionTargetsByFieldId.get(field.id);
      if (field.singleSelect && selectionTargets && selectionTargets.size > 1) {
        diagnostics.push(
          createDiagnostic(
            'error',
            'MULTIPLE_VALUES_NOT_ALLOWED',
            `Custom field "${field.name}" is single-select but multiple values were provided`,
            { line: testCase.line, caseName: testCase.name, section: 'fields' },
          ),
        );
      }

      const assignment = assignmentsByFieldId.get(field.id);
      if (field.required && (!assignment || assignment.values.length === 0)) {
        const defaultNote =
          field.defaultValueId === undefined
            ? ''
            : ' A project default exists, but Markdown import requires an explicit value.';
        diagnostics.push(
          createDiagnostic(
            'error',
            'REQUIRED_FIELD_MISSING',
            `Required custom field "${field.name}" has no resolved value.${defaultNote}`,
            { line: testCase.line, caseName: testCase.name, section: 'fields' },
          ),
        );
      }
    }

    resolvedCases.push({
      caseIndex,
      caseName: testCase.name,
      assignments: Array.from(assignmentsByFieldId.values()).filter(
        (assignment) => assignment.values.length > 0,
      ),
      fields: fieldReports,
    });
  }

  return { cases: resolvedCases, diagnostics };
}

function resolveName<T extends NamedEntity>(input: string, items: T[]): NameResolution<T> {
  const normalizedInput = normalizeName(input);
  const exactMatches = items.filter((item) => normalizeName(item.name) === normalizedInput);
  if (exactMatches.length === 1) {
    return { status: 'resolved', item: exactMatches[0], candidates: exactMatches };
  }
  if (exactMatches.length > 1) {
    return { status: 'ambiguous', candidates: exactMatches };
  }

  const foldedInput = foldName(normalizedInput);
  const caseInsensitiveMatches = items.filter((item) => foldName(item.name) === foldedInput);
  if (caseInsensitiveMatches.length === 1) {
    return {
      status: 'resolved',
      item: caseInsensitiveMatches[0],
      candidates: caseInsensitiveMatches,
    };
  }
  if (caseInsensitiveMatches.length > 1) {
    return { status: 'ambiguous', candidates: caseInsensitiveMatches };
  }

  return {
    status: 'not_found',
    candidates: [...items].sort((left, right) => left.name.localeCompare(right.name)).slice(0, 20),
  };
}

function normalizeName(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function foldName(value: string): string {
  return normalizeName(value).toLowerCase();
}

function uniqueById<T extends NamedEntity>(items: T[]): T[] {
  const seen = new Set<number>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function toCandidates(items: NamedEntity[]): ResolutionCandidate[] {
  return items.map((item) => ({ id: item.id, name: item.name }));
}

function createDiagnostic(
  severity: 'error' | 'warning',
  code: string,
  message: string,
  details: DiagnosticDetails,
): ImportDiagnostic {
  return {
    severity,
    code,
    message,
    ...details,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
