export interface TestCase {
  id: number;
  name: string;
  description?: string;
  projectId?: number;
  deleted?: boolean;
  automated?: boolean;
  status?: TestCaseWorkflowStatus;
  created?: string;
  updated?: string;
}

export interface TestCaseWorkflowStatus {
  id: number;
  name: string;
  color?: string;
  createdBy?: string;
  createdDate?: number;
  lastModifiedBy?: string;
  lastModifiedDate?: number;
}

export interface TestCaseDeleteResult {
  status: 'accepted';
  destination: 'trash';
  testCaseId: number;
  name: string;
  projectId: number;
}

export type TestCaseTrashSearchQuery =
  | { by: 'id'; id: number }
  | {
      by: 'name';
      name: string;
      match: 'exact' | 'contains';
      page: number;
      size: number;
    };

export interface TestCaseTrashSummary {
  id: number;
  name: string;
  automated?: boolean;
}

export interface TestCaseTrashSearchResult {
  projectId: number;
  query: TestCaseTrashSearchQuery;
  resolution: 'not_found' | 'unique' | 'ambiguous';
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  matches: TestCaseTrashSummary[];
  message?: string;
}

export interface TestCaseRestoreResult {
  status: 'restored';
  verifiedBy: 'response' | 'follow-up-read';
  testCaseId: number;
  name: string;
  projectId: number;
}

export interface TestCaseSearchParams {
  name?: string;
  status?: string;
  page?: number;
  size?: number;
}

export interface PageResult<T> {
  items: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
}

export interface TestCaseCustomFieldSearchResult extends PageResult<TestCase> {
  projectId: number;
  query: {
    fieldName: string;
    value: string;
    match: 'exact';
  };
}

export interface TestCaseCreateRequest {
  name: string;
  description?: string;
  status?: string;
}

export interface ProjectCustomField {
  id: number;
  name: string;
  required: boolean;
  singleSelect: boolean;
  locked?: boolean;
  defaultValueId?: number;
}

export interface ProjectCustomFieldValue {
  id: number;
  fieldId: number;
  name: string;
  global: boolean;
}

export interface ResolvedCustomFieldAssignment {
  fieldId: number;
  fieldName: string;
  required: boolean;
  singleSelect: boolean;
  values: {
    valueId: number;
    valueName: string;
    global: boolean;
  }[];
}

export interface ScenarioStep {
  text: string;
  depth: number;
  expectedResults: string[];
}

export interface TestCaseImportCreateRequest {
  name: string;
  description?: string;
  preconditions?: string[];
  scenario: ScenarioStep[];
  resolvedCustomFields?: ResolvedCustomFieldAssignment[];
  tags?: string[];
  issueKeys?: string[];
}

export interface TestCaseScenario {
  attachments?: Record<string, unknown>;
  root?: TestCaseScenarioStep;
  scenarioSteps?: Record<string, TestCaseScenarioStep>;
  sharedStepAttachments?: Record<string, unknown>;
  sharedStepScenarioSteps?: Record<string, TestCaseScenarioStep>;
  sharedSteps?: Record<string, TestCaseScenarioStep>;
}

export interface TestCaseScenarioStep {
  body?: string;
  bodyJson?: Record<string, unknown>;
  children?: number[];
  expectedResult?: string;
  expectedResultId?: number;
  id?: number;
}

export interface Launch {
  id: number;
  name: string;
  projectId: number;
  closed?: boolean;
}

export interface LaunchSearchParams {
  page?: number;
  size?: number;
}

export interface LaunchCreateRequest {
  name: string;
}

export interface LaunchTestResultSearchParams {
  page?: number;
  size?: number;
  /** `true` returns deleted results instead of active ones; defaults to `false`. */
  deleted?: boolean;
}

export interface LaunchTestResult {
  /** `LEAF` is one test result; any other node groups results into a tree folder. */
  type: string;
  id: number;
  name: string;
  status?: TestStatus;
  testCaseId?: number;
  duration?: number;
  flaky?: boolean;
  hidden?: boolean;
  manual?: boolean;
}

export type TestStatus = 'failed' | 'broken' | 'passed' | 'skipped' | 'unknown' | 'in_progress';

export interface TestStatusCount {
  status: TestStatus;
  count: number;
}

export interface ProjectStatistics {
  launches: number;
  manualTestCases: number;
  automatedTestCases: number;
  automationPercent: number;
}

export interface TestCaseHistoryItem {
  id: number;
  status: string;
  statusName: string;
  testCaseId: number;
  testCaseUuid: string;
  launchId: number;
  launchName: string;
  launchNumber: number;
  projectId: number;
  environment?: string;
  browser?: string;
  startTime: string;
  endTime: string;
  duration: number;
  reason?: string;
  knownIssues: string[];
  comment?: string;
  failureDetails?: string;
}

export type TestCaseHistory = PageResult<TestCaseHistoryItem>;
