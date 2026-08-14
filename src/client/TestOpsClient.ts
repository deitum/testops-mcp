import { Agent } from 'node:https';

import axios, {
  type AxiosError,
  AxiosHeaders,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import FormData from 'form-data';

import { JIRA_NOT_CONFIGURED_MESSAGE, REQUEST_TIMEOUT_MS } from '../testops.constants';

import { formatTestOpsError } from './error';
import {
  type Launch,
  type LaunchCreateRequest,
  type LaunchSearchParams,
  type PageResult,
  type ProjectStatistics,
  type ProjectCustomField,
  type ProjectCustomFieldValue,
  type ResolvedCustomFieldAssignment,
  type ScenarioStep,
  type TestCase,
  type TestCaseCreateRequest,
  type TestCaseCustomFieldSearchResult,
  type TestCaseDeleteResult,
  type TestCaseHistory,
  type TestCaseHistoryItem,
  type TestCaseImportCreateRequest,
  type TestCaseRestoreResult,
  type TestCaseScenario,
  type TestCaseSearchParams,
  type TestCaseTrashSearchQuery,
  type TestCaseTrashSearchResult,
  type TestCaseTrashSummary,
  type TestStatusCount,
} from './types';

type StepInput = { name: string; expectedResults?: string[] };
type ImportedTestCasePostCreateStage = 'scenario' | 'customFields' | 'tags' | 'issueLinks';
type RetryableRequestConfig = InternalAxiosRequestConfig & {
  _testOpsAuthRetried?: boolean;
};

interface ScenarioStepCreatedResponse {
  createdStepId?: unknown;
  scenario?: {
    scenarioSteps?: Record<
      string,
      {
        expectedResultId?: unknown;
      }
    >;
  };
}

interface ApiScenarioBodyStep {
  type: 'body';
  bodyJson: Record<string, unknown>;
  steps: ApiScenarioBodyStep[];
  expectedResultSteps?: ApiScenarioExpectedStep[];
}

interface ApiScenarioExpectedStep {
  type: 'expected_body';
  bodyJson: Record<string, unknown>;
  steps: [];
}

interface ApiScenario {
  steps: ApiScenarioBodyStep[];
}

interface OAuthTokenResponse {
  access_token?: unknown;
}

interface PageResponse<T> {
  content?: T[];
  last?: unknown;
  totalPages?: unknown;
}

interface ApiPageResponse<T> {
  content?: T[];
  number?: unknown;
  size?: unknown;
  totalElements?: unknown;
  totalPages?: unknown;
}

interface ProjectCustomFieldApiItem {
  id?: unknown;
  required?: unknown;
  locked?: unknown;
  defaultCustomFieldValueId?: unknown;
  customField?: {
    id?: unknown;
    name?: unknown;
    required?: unknown;
    locked?: unknown;
    singleSelect?: unknown;
  };
}

interface ProjectCustomFieldValueApiItem {
  id?: unknown;
  name?: unknown;
  global?: unknown;
  customField?: {
    id?: unknown;
  };
}

const TOKEN_PATH = '/api/uaa/oauth/token';
const PAGE_SIZE = 100;
const MAX_PAGE_COUNT = 1000;

export class ImportedTestCaseCreateError extends Error {
  readonly testCaseId: number;
  readonly stage: ImportedTestCasePostCreateStage;
  readonly originalError: unknown;

  constructor(testCaseId: number, stage: ImportedTestCasePostCreateStage, originalError: unknown) {
    super(
      `Test case ${testCaseId} was created, but post-create stage "${stage}" failed: ${formatTestOpsError(originalError)}`,
    );
    this.name = 'ImportedTestCaseCreateError';
    this.testCaseId = testCaseId;
    this.stage = stage;
    this.originalError = originalError;
  }
}

export class ImportedTestCaseOutcomeUnknownError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(`Test case creation outcome is unknown: ${formatTestOpsError(originalError)}`);
    this.name = 'ImportedTestCaseOutcomeUnknownError';
    this.originalError = originalError;
  }
}

export class LaunchCreateOutcomeUnknownError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(
      'Launch creation outcome is unknown. Do not retry automatically. ' +
        `Original error: ${formatTestOpsError(originalError)}`,
    );
    this.name = 'LaunchCreateOutcomeUnknownError';
    this.originalError = originalError;
  }
}

export class TestCaseRestoreOutcomeUnknownError extends Error {
  readonly testCaseId: number;
  readonly originalError: unknown;
  readonly verificationError: unknown;

  constructor(testCaseId: number, originalError: unknown, verificationError: unknown) {
    super(
      `Restore outcome for test case ${testCaseId} is unknown and could not be verified. ` +
        'Do not retry automatically; search Trash by ID before further action. ' +
        `Restore error: ${formatTestOpsError(originalError)}. ` +
        `Verification error: ${formatTestOpsError(verificationError)}`,
    );
    this.name = 'TestCaseRestoreOutcomeUnknownError';
    this.testCaseId = testCaseId;
    this.originalError = originalError;
    this.verificationError = verificationError;
  }
}

export class TestCaseCreateOutcomeUnknownError extends Error {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super(
      'Test case creation outcome is unknown. Do not retry automatically. ' +
        `Original error: ${formatTestOpsError(originalError)}`,
    );
    this.name = 'TestCaseCreateOutcomeUnknownError';
    this.originalError = originalError;
  }
}

export interface TestOpsClientOptions {
  /** Off only for an explicitly approved certificate; see SECURITY.md. */
  sslVerify?: boolean;
  /**
   * Jira root that issue keys are linked against, from `TESTOPS_JIRA_BASE_URL`.
   * Left unset, the issue-link paths refuse to write rather than guess a host.
   */
  jiraBaseUrl?: string;
}

export class TestOpsClient {
  private client: AxiosInstance;
  private authClient: AxiosInstance;
  private readonly projectId: number;
  private readonly jiraBaseUrl: string | undefined;
  private apiKey: string;
  private bearerToken: string | null = null;
  private tokenPromise: Promise<string> | null = null;

  constructor(
    baseUrl: string,
    apiKey: string,
    projectId: number,
    options: TestOpsClientOptions = {},
  ) {
    const { sslVerify = true, jiraBaseUrl } = options;
    this.projectId = projectId;
    this.apiKey = apiKey;
    this.jiraBaseUrl = jiraBaseUrl;
    const httpsAgent = sslVerify ? undefined : new Agent({ rejectUnauthorized: false });

    const axiosConfig = {
      baseURL: baseUrl,
      timeout: REQUEST_TIMEOUT_MS,
      httpsAgent,
    };

    this.authClient = axios.create(axiosConfig);
    this.client = axios.create({
      ...axiosConfig,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const request = error.config as RetryableRequestConfig | undefined;
        const method = request?.method?.toLowerCase();
        const canReplaySafely = method === 'get' || method === 'head';
        if (error.response?.status === 401 && request) {
          this.bearerToken = null;
          if (canReplaySafely && !request._testOpsAuthRetried) {
            request._testOpsAuthRetried = true;
            const token = await this.ensureToken(true);
            request.headers = AxiosHeaders.from(request.headers);
            request.headers.set('Authorization', `Bearer ${token}`);
            return this.client.request(request);
          }
        }
        throw error;
      },
    );
  }

  get configuredProjectId(): number {
    return this.projectId;
  }

  /** Whether issue keys can be turned into links; see `TESTOPS_JIRA_BASE_URL`. */
  get issueLinksConfigured(): boolean {
    return this.jiraBaseUrl !== undefined;
  }

  async initialize(): Promise<void> {
    await this.ensureToken();
  }

  private ensureToken(forceRefresh: boolean = false): Promise<string> {
    if (forceRefresh) {
      this.bearerToken = null;
    }

    if (this.bearerToken) {
      return Promise.resolve(this.bearerToken);
    }

    if (!this.tokenPromise) {
      this.tokenPromise = this.getBearerToken()
        .then((token) => {
          this.bearerToken = token;
          return token;
        })
        .finally(() => {
          this.tokenPromise = null;
        });
    }

    return this.tokenPromise;
  }

  private async getBearerToken(): Promise<string> {
    try {
      const form = new FormData();
      form.append('grant_type', 'apitoken');
      form.append('scope', 'openid');
      form.append('token', this.apiKey);

      const response = await this.authClient.post<OAuthTokenResponse>(TOKEN_PATH, form, {
        headers: form.getHeaders(),
      });

      if (
        typeof response.data.access_token !== 'string' ||
        response.data.access_token.length === 0
      ) {
        throw new Error('Token response does not contain access_token');
      }

      return response.data.access_token;
    } catch (error: unknown) {
      throw new Error(`Failed to get bearer token: ${formatTestOpsError(error)}`, { cause: error });
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  private withProject<T extends object>(params: T): T & { projectId: number } {
    return { ...params, projectId: this.projectId };
  }

  private assertConfiguredProject(
    entityType: 'Test case' | 'Launch',
    entityId: number,
    actualProjectId: number | undefined,
  ): void {
    if (actualProjectId === this.projectId) return;

    if (actualProjectId === undefined) {
      throw new Error(
        `Cannot verify ${entityType.toLowerCase()} ${entityId}: TestOps response has no projectId`,
      );
    }

    throw new Error(
      `${entityType} ${entityId} belongs to project ${actualProjectId}, ` +
        `but this server is configured for project ${this.projectId}`,
    );
  }

  async searchTestCases(params: TestCaseSearchParams): Promise<PageResult<TestCase>> {
    const conditions = [
      ...(params.name === undefined ? [] : [`name ~= ${aqlString(params.name, 'test-case name')}`]),
      ...(params.status === undefined
        ? []
        : [`status = ${aqlString(params.status, 'test-case status')}`]),
    ];
    return this.searchActiveTestCases(
      conditions.join(' and ') || 'id > 0',
      params.page ?? 0,
      params.size ?? 20,
      'test-case search',
    );
  }

  async getTestCase(id: number): Promise<TestCase> {
    await this.ensureToken();
    const response = await this.client.get<TestCase>(`/api/rs/testcase/${id}`, {
      params: { projectId: this.projectId },
      headers: this.getHeaders(),
    });
    const actualId = requiredPositiveInteger(response.data.id, 'test case id');
    if (actualId !== id) {
      throw new Error(`TestOps returned test case ${actualId} when ${id} was requested`);
    }
    requiredString(response.data.name, `test case ${id} name`);
    this.assertConfiguredProject('Test case', id, response.data.projectId);
    return response.data;
  }

  private async searchActiveTestCases(
    rql: string,
    page: number,
    size: number,
    label: string,
  ): Promise<PageResult<TestCase>> {
    await this.ensureToken();
    const response = await this.client.get<ApiPageResponse<TestCase>>('/api/testcase/__search', {
      params: {
        projectId: this.projectId,
        deleted: false,
        rql,
        page,
        size,
      },
      headers: this.getHeaders(),
    });
    const result = pageResult(response.data, label);
    result.items.forEach((testCase, index) => {
      const id = requiredPositiveInteger(testCase.id, `${label} item ${index} id`);
      requiredString(testCase.name, `${label} item ${index} name`);
      this.assertConfiguredProject('Test case', id, testCase.projectId);
      if (testCase.deleted === true) {
        throw new Error(`Invalid ${label} response: test case ${id} is deleted`);
      }
    });
    return result;
  }

  async searchTestCasesInTrash(
    query: TestCaseTrashSearchQuery,
  ): Promise<TestCaseTrashSearchResult> {
    if (query.by === 'id') {
      return this.searchTestCaseInTrashById(query);
    }

    const operator = query.match === 'exact' ? '=' : '~=';
    const rql = `name ${operator} ${aqlString(query.name, 'Trash search name')}`;
    await this.ensureToken();
    const response = await this.client.get<ApiPageResponse<TestCase>>('/api/testcase/__search', {
      params: {
        projectId: this.projectId,
        deleted: true,
        rql,
        page: query.page,
        size: query.size,
      },
      headers: this.getHeaders(),
    });

    const result = pageResult(response.data, 'Trash search');
    const matches = result.items.map((testCase, index) =>
      this.toTrashSummary(testCase, `Trash search result ${index}`),
    );

    return {
      projectId: this.projectId,
      query,
      resolution: trashSearchResolution(result.totalElements),
      page: result.page,
      size: result.size,
      totalElements: result.totalElements,
      totalPages: result.totalPages,
      matches,
    };
  }

  async deleteTestCase(id: number, expectedName: string): Promise<TestCaseDeleteResult> {
    const testCase = await this.getTestCaseDetails(id);
    if (testCase.deleted === true) {
      throw new Error(`Test case ${id} is already in Trash`);
    }
    if (testCase.deleted !== false) {
      throw new Error(`Cannot verify test case ${id}: TestOps response has no deleted state`);
    }
    if (testCase.name !== expectedName) {
      throw new Error(
        `Test case ${id} is named "${testCase.name}", not "${expectedName}". Nothing was deleted`,
      );
    }

    await this.client.delete(`/api/testcase/${id}`, {
      params: { force: false },
      headers: this.getHeaders(),
    });

    return {
      status: 'accepted',
      destination: 'trash',
      testCaseId: id,
      name: testCase.name,
      projectId: this.projectId,
    };
  }

  async restoreTestCase(id: number, expectedName: string): Promise<TestCaseRestoreResult> {
    const testCase = await this.getTestCaseDetails(id);
    if (testCase.deleted === false) {
      throw new Error(`Test case ${id} is not in Trash. Nothing was restored`);
    }
    if (testCase.deleted !== true) {
      throw new Error(`Cannot verify test case ${id}: TestOps response has no deleted state`);
    }
    if (testCase.name !== expectedName) {
      throw new Error(
        `Test case ${id} is named "${testCase.name}", not "${expectedName}". Nothing was restored`,
      );
    }

    let response;
    try {
      response = await this.client.post<TestCase>(`/api/testcase/${id}/restore`, undefined, {
        headers: this.getHeaders(),
      });
    } catch (error: unknown) {
      if (!isUnknownWriteOutcome(error)) throw error;
      return this.reconcileRestoredTestCase(id, expectedName, error);
    }

    try {
      return this.restoredTestCaseResult(response.data, id, expectedName, 'response');
    } catch (error: unknown) {
      return this.reconcileRestoredTestCase(id, expectedName, error);
    }
  }

  private async searchTestCaseInTrashById(
    query: Extract<TestCaseTrashSearchQuery, { by: 'id' }>,
  ): Promise<TestCaseTrashSearchResult> {
    let testCase: TestCase;
    try {
      testCase = await this.getTestCaseDetails(query.id);
    } catch (error: unknown) {
      if (!axios.isAxiosError(error) || error.response?.status !== 404) throw error;
      return this.emptyTrashSearchResult(query, `Test case ${query.id} was not found`);
    }

    if (testCase.deleted === false) {
      return this.emptyTrashSearchResult(query, `Test case ${query.id} exists but is not in Trash`);
    }
    if (testCase.deleted !== true) {
      throw new Error(`Cannot verify test case ${query.id}: TestOps response has no deleted state`);
    }

    return {
      projectId: this.projectId,
      query,
      resolution: 'unique',
      page: 0,
      size: 1,
      totalElements: 1,
      totalPages: 1,
      matches: [this.toTrashSummary(testCase, `Test case ${query.id}`)],
    };
  }

  private emptyTrashSearchResult(
    query: Extract<TestCaseTrashSearchQuery, { by: 'id' }>,
    message: string,
  ): TestCaseTrashSearchResult {
    return {
      projectId: this.projectId,
      query,
      resolution: 'not_found',
      page: 0,
      size: 1,
      totalElements: 0,
      totalPages: 0,
      matches: [],
      message,
    };
  }

  private async getTestCaseDetails(id: number): Promise<TestCase> {
    await this.ensureToken();
    const response = await this.client.get<TestCase>(`/api/testcase/${id}`, {
      headers: this.getHeaders(),
    });
    const actualId = requiredPositiveInteger(response.data.id, 'test case id');
    if (actualId !== id) {
      throw new Error(`TestOps returned test case ${actualId} when ${id} was requested`);
    }
    requiredString(response.data.name, `test case ${id} name`);
    this.assertConfiguredProject('Test case', id, response.data.projectId);
    return response.data;
  }

  private toTrashSummary(testCase: TestCase, label: string): TestCaseTrashSummary {
    const id = requiredPositiveInteger(testCase.id, `${label} id`);
    const name = requiredString(testCase.name, `${label} name`);
    this.assertConfiguredProject('Test case', id, testCase.projectId);
    if (testCase.deleted !== true) {
      throw new Error(`Cannot verify ${label}: TestOps response does not mark it as deleted`);
    }

    return {
      id,
      name,
      ...(typeof testCase.automated === 'boolean' ? { automated: testCase.automated } : {}),
    };
  }

  private restoredTestCaseResult(
    testCase: TestCase,
    id: number,
    expectedName: string,
    verifiedBy: TestCaseRestoreResult['verifiedBy'],
  ): TestCaseRestoreResult {
    const actualId = requiredPositiveInteger(testCase.id, 'restored test case id');
    if (actualId !== id) {
      throw new Error(`TestOps returned test case ${actualId} after restoring ${id}`);
    }
    const actualName = requiredString(testCase.name, `restored test case ${id} name`);
    this.assertConfiguredProject('Test case', id, testCase.projectId);
    if (actualName !== expectedName) {
      throw new Error(`Restored test case ${id} is named "${actualName}", not "${expectedName}"`);
    }
    if (testCase.deleted !== false) {
      throw new Error(`TestOps did not confirm that test case ${id} left Trash`);
    }

    return {
      status: 'restored',
      verifiedBy,
      testCaseId: id,
      name: actualName,
      projectId: this.projectId,
    };
  }

  private async reconcileRestoredTestCase(
    id: number,
    expectedName: string,
    originalError: unknown,
  ): Promise<TestCaseRestoreResult> {
    let testCase: TestCase;
    try {
      testCase = await this.getTestCaseDetails(id);
    } catch (verificationError: unknown) {
      throw new TestCaseRestoreOutcomeUnknownError(id, originalError, verificationError);
    }

    if (testCase.name !== expectedName) {
      throw new TestCaseRestoreOutcomeUnknownError(
        id,
        originalError,
        new Error(`Test case ${id} is now named "${testCase.name}"`),
      );
    }
    if (testCase.deleted === false) {
      return this.restoredTestCaseResult(testCase, id, expectedName, 'follow-up-read');
    }
    if (testCase.deleted === true) {
      throw new Error(
        `Test case ${id} remains in Trash after the restore attempt. ` +
          'Nothing was restored; do not retry automatically',
      );
    }

    throw new TestCaseRestoreOutcomeUnknownError(
      id,
      originalError,
      new Error(`TestOps response for test case ${id} has no deleted state`),
    );
  }

  async createTestCase(data: TestCaseCreateRequest): Promise<TestCase> {
    await this.ensureToken();
    let response;
    try {
      response = await this.client.post<TestCase>(
        '/api/rs/testcase',
        {
          ...data,
          projectId: this.projectId,
        },
        {
          headers: this.getHeaders(),
        },
      );
    } catch (error: unknown) {
      if (isUnknownWriteOutcome(error)) {
        throw new TestCaseCreateOutcomeUnknownError(error);
      }
      throw error;
    }

    try {
      return this.validateCreatedTestCase(response.data, data.name);
    } catch (error: unknown) {
      throw new TestCaseCreateOutcomeUnknownError(error);
    }
  }

  async createImportedTestCase(data: TestCaseImportCreateRequest): Promise<TestCase> {
    const precondition = formatPreconditions(data.preconditions || []);
    const scenario = scenarioToApiScenario(data.scenario);
    await this.ensureToken();

    let response;
    try {
      response = await this.client.post<TestCase>(
        '/api/testcase',
        {
          name: data.name,
          description: data.description || '',
          ...(precondition ? { precondition } : {}),
          projectId: this.projectId,
        },
        {
          headers: this.getHeaders(),
        },
      );
    } catch (error: unknown) {
      if (isUnknownWriteOutcome(error)) {
        throw new ImportedTestCaseOutcomeUnknownError(error);
      }
      throw error;
    }

    let created: TestCase;
    try {
      created = this.validateCreatedTestCase(response.data, data.name);
    } catch (error: unknown) {
      throw new ImportedTestCaseOutcomeUnknownError(error);
    }
    const createdId = created.id;

    try {
      await this.setImportedTestCaseScenario(createdId, scenario);
    } catch (error: unknown) {
      throw new ImportedTestCaseCreateError(createdId, 'scenario', error);
    }

    if (data.resolvedCustomFields && data.resolvedCustomFields.length > 0) {
      try {
        await this.writeTestCaseCustomFields(createdId, data.resolvedCustomFields);
      } catch (error: unknown) {
        throw new ImportedTestCaseCreateError(createdId, 'customFields', error);
      }
    }

    if (data.tags && data.tags.length > 0) {
      try {
        await this.writeTestCaseTags(createdId, data.tags);
      } catch (error: unknown) {
        throw new ImportedTestCaseCreateError(createdId, 'tags', error);
      }
    }

    if (data.issueKeys && data.issueKeys.length > 0) {
      try {
        await this.setTestCaseIssueLinks(createdId, data.issueKeys);
      } catch (error: unknown) {
        throw new ImportedTestCaseCreateError(createdId, 'issueLinks', error);
      }
    }

    return created;
  }

  private validateCreatedTestCase(testCase: TestCase, expectedName: string): TestCase {
    const id = requiredPositiveInteger(testCase.id, 'created test case id');
    const name = requiredString(testCase.name, `created test case ${id} name`);
    if (name !== expectedName) {
      throw new Error(
        `TestOps returned created test case ${id} named "${name}", not "${expectedName}"`,
      );
    }
    if (testCase.projectId !== undefined) {
      this.assertConfiguredProject('Test case', id, testCase.projectId);
    }
    return testCase;
  }

  async getTestCaseSteps(id: number): Promise<TestCaseScenario> {
    await this.getTestCase(id);
    const response = await this.client.get<unknown>(`/api/testcase/${id}/step`, {
      headers: this.getHeaders(),
    });
    return validateTestCaseScenario(response.data);
  }

  async getTestCaseHistory(
    id: number,
    page: number = 0,
    size: number = 20,
  ): Promise<TestCaseHistory> {
    await this.getTestCase(id);
    const response = await this.client.get<ApiPageResponse<TestCaseHistoryItem>>(
      `/api/rs/testcase/${id}/history`,
      {
        params: { projectId: this.projectId, page, size },
        headers: this.getHeaders(),
      },
    );
    const result = pageResult(response.data, 'test-case history');
    for (const [index, item] of result.items.entries()) {
      const actualTestCaseId = requiredPositiveInteger(
        item.testCaseId,
        `test-case history item ${index} testCaseId`,
      );
      if (actualTestCaseId !== id) {
        throw new Error(
          `TestOps returned history for test case ${actualTestCaseId} when ${id} was requested`,
        );
      }
      this.assertConfiguredProject('Test case', actualTestCaseId, item.projectId);
    }
    return result;
  }

  async listProjectCustomFields(): Promise<ProjectCustomField[]> {
    await this.ensureToken();
    const encodedProjectId = encodeURIComponent(String(this.projectId));

    const items = await this.collectPages(async (page, size) => {
      const response = await this.client.get<PageResponse<ProjectCustomFieldApiItem>>(
        `/api/project/${encodedProjectId}/cf`,
        {
          params: { page, size },
          headers: this.getHeaders(),
        },
      );
      return response.data;
    });

    return items.map((item, index) => normalizeProjectCustomField(item, index));
  }

  async listProjectCustomFieldValues(customFieldId: number): Promise<ProjectCustomFieldValue[]> {
    await this.ensureToken();
    const encodedProjectId = encodeURIComponent(String(this.projectId));

    const items = await this.collectPages(async (page, size) => {
      const response = await this.client.get<PageResponse<ProjectCustomFieldValueApiItem>>(
        `/api/project/${encodedProjectId}/cfv`,
        {
          params: { customFieldId, page, size },
          headers: this.getHeaders(),
        },
      );
      return response.data;
    });

    return items.map((item, index) => normalizeProjectCustomFieldValue(item, index, customFieldId));
  }

  async listLaunches(params: LaunchSearchParams): Promise<PageResult<Launch>> {
    await this.ensureToken();
    const response = await this.client.get<ApiPageResponse<Launch>>('/api/launch', {
      params: this.withProject(params),
      headers: this.getHeaders(),
    });
    const result = pageResult(response.data, 'launch list');
    result.items.forEach((launch, index) =>
      this.validateLaunch(launch, undefined, undefined, `launch list item ${index}`),
    );
    return result;
  }

  async getLaunch(id: number): Promise<Launch> {
    await this.ensureToken();
    const response = await this.client.get<Launch>(`/api/launch/${id}`, {
      headers: this.getHeaders(),
    });
    return this.validateLaunch(response.data, id);
  }

  private validateLaunch(
    launch: Launch,
    expectedId?: number,
    expectedName?: string,
    label: string = 'launch',
  ): Launch {
    const id = requiredPositiveInteger(launch.id, `${label} id`);
    if (expectedId !== undefined && id !== expectedId) {
      throw new Error(`TestOps returned launch ${id} when ${expectedId} was requested`);
    }
    const name = requiredString(launch.name, `${label} name`);
    this.assertConfiguredProject('Launch', id, launch.projectId);
    if (expectedName !== undefined && name !== expectedName) {
      throw new Error(`TestOps returned launch ${id} named "${name}", not "${expectedName}"`);
    }
    return launch;
  }

  async getLaunchStatistics(id: number): Promise<TestStatusCount[]> {
    await this.getLaunch(id);
    const response = await this.client.get<TestStatusCount[]>(`/api/launch/${id}/statistic`, {
      headers: this.getHeaders(),
    });
    if (!Array.isArray(response.data)) {
      throw new Error('Invalid launch statistics response: expected an array');
    }
    return response.data.map((item, index) => ({
      status: requiredTestStatus(item.status, `launch statistic ${index} status`),
      count: requiredNonNegativeInteger(item.count, `launch statistic ${index} count`),
    }));
  }

  async createLaunch(data: LaunchCreateRequest): Promise<Launch> {
    await this.ensureToken();
    let response;
    try {
      response = await this.client.post<Launch>(
        '/api/launch',
        {
          name: data.name,
          projectId: this.projectId,
        },
        {
          headers: this.getHeaders(),
        },
      );
    } catch (error: unknown) {
      if (isUnknownWriteOutcome(error)) throw new LaunchCreateOutcomeUnknownError(error);
      throw error;
    }

    try {
      return this.validateLaunch(response.data, undefined, data.name, 'created launch');
    } catch (error: unknown) {
      throw new LaunchCreateOutcomeUnknownError(error);
    }
  }

  async updateLaunch(id: number, expectedName: string, name: string): Promise<Launch> {
    const launch = await this.getLaunch(id);
    if (launch.name !== expectedName) {
      throw new Error(
        `Launch ${id} is named "${launch.name}", not "${expectedName}". Nothing was changed`,
      );
    }

    const response = await this.client.patch<Launch>(
      `/api/launch/${id}`,
      { name },
      {
        headers: this.getHeaders(),
      },
    );
    return this.validateLaunch(response.data, id, name, 'updated launch');
  }

  async getOverallStatistics(): Promise<ProjectStatistics> {
    await this.ensureToken();
    const response = await this.client.get<ProjectStatistics>(
      `/api/project/${this.projectId}/stats`,
      {
        headers: this.getHeaders(),
      },
    );
    return {
      launches: requiredNonNegativeInteger(response.data.launches, 'project launch count'),
      manualTestCases: requiredNonNegativeInteger(
        response.data.manualTestCases,
        'project manual test-case count',
      ),
      automatedTestCases: requiredNonNegativeInteger(
        response.data.automatedTestCases,
        'project automated test-case count',
      ),
      automationPercent: requiredPercentage(
        response.data.automationPercent,
        'project automation percent',
      ),
    };
  }

  async setTestCaseCustomFields(
    testCaseId: number,
    assignments: ResolvedCustomFieldAssignment[],
  ): Promise<void> {
    if (assignments.length === 0) return;

    await this.getTestCase(testCaseId);
    await this.writeTestCaseCustomFields(testCaseId, assignments);
  }

  private async writeTestCaseCustomFields(
    testCaseId: number,
    assignments: ResolvedCustomFieldAssignment[],
  ): Promise<void> {
    await this.ensureToken();
    const valuesByField = new Map<number, Map<number, string>>();

    for (const assignment of assignments) {
      const values = valuesByField.get(assignment.fieldId) ?? new Map<number, string>();
      for (const value of assignment.values) {
        values.set(value.valueId, value.valueName);
      }
      valuesByField.set(assignment.fieldId, values);
    }

    const payload = Array.from(valuesByField.entries()).flatMap(([fieldId, values]) =>
      Array.from(values, ([id, name]) => ({
        id,
        customField: { id: fieldId },
        name,
      })),
    );

    if (payload.length === 0) return;

    await this.client.post(`/api/rs/testcase/${testCaseId}/cfv`, payload, {
      params: { projectId: this.projectId },
      headers: this.getHeaders(),
    });
  }

  async searchTestCasesByCustomField(
    fieldName: string,
    value: string,
    page: number = 0,
    size: number = 20,
  ): Promise<TestCaseCustomFieldSearchResult> {
    const result = await this.searchActiveTestCases(
      `cf[${aqlString(fieldName, 'custom-field name')}] = ${aqlString(value, 'custom-field value')}`,
      page,
      size,
      'custom-field test-case search',
    );
    return {
      projectId: this.projectId,
      query: { fieldName, value, match: 'exact' },
      ...result,
    };
  }

  async setTestCaseTags(id: number, expectedName: string, tags: string[]): Promise<void> {
    if (tags.length === 0) throw new Error('At least one tag is required');

    const testCase = await this.getTestCaseDetails(id);
    if (testCase.name !== expectedName) {
      throw new Error(
        `Test case ${id} is named "${testCase.name}", not "${expectedName}". Tags were not changed`,
      );
    }
    if (testCase.deleted === true) {
      throw new Error(`Test case ${id} is in Trash. Tags were not changed`);
    }
    await this.writeTestCaseTags(id, tags);
  }

  async addTestCaseSteps(id: number, steps: StepInput[]): Promise<void> {
    if (steps.length === 0) return;

    await this.getTestCase(id);
    await this.appendScenarioSteps(
      id,
      steps.map((step) => ({
        text: step.name,
        depth: 0,
        expectedResults: step.expectedResults ?? [],
      })),
    );
  }

  async addTestCaseIssueLinks(id: number, issueKeys: string[]): Promise<void> {
    if (issueKeys.length === 0) return;
    if (this.jiraBaseUrl === undefined) {
      throw new Error(`${JIRA_NOT_CONFIGURED_MESSAGE} Issue links were not changed`);
    }

    const testCase = await this.getTestCaseDetails(id);
    if (testCase.deleted === true) {
      throw new Error(`Test case ${id} is in Trash. Issue links were not changed`);
    }
    if (testCase.deleted !== false) {
      throw new Error(`Cannot verify test case ${id}: TestOps response has no deleted state`);
    }
    await this.setTestCaseIssueLinks(id, issueKeys);
  }

  private async writeTestCaseTags(id: number, tags: string[]): Promise<void> {
    await this.ensureToken();
    await this.client.post(
      `/api/testcase/${id}/tag`,
      tags.map((name) => ({ name })),
      {
        headers: this.getHeaders(),
      },
    );
  }

  private async setTestCaseIssueLinks(id: number, issueKeys: string[]): Promise<void> {
    const jiraBaseUrl = this.jiraBaseUrl;
    if (jiraBaseUrl === undefined) {
      throw new Error(`${JIRA_NOT_CONFIGURED_MESSAGE} Issue links were not changed`);
    }

    await this.ensureToken();
    await this.client.post(
      '/api/v2/test-case/bulk/external-link/add',
      {
        links: issueKeys.map((key) => ({
          name: key,
          url: `${jiraBaseUrl}/browse/${key}`,
        })),
        selection: {
          projectId: this.projectId,
          testCasesInclude: [id],
          inverted: false,
          deleted: false,
        },
        treeFolder: false,
      },
      {
        headers: this.getHeaders(),
      },
    );
  }

  private async collectPages<T>(
    loadPage: (page: number, size: number) => Promise<PageResponse<T>>,
  ): Promise<T[]> {
    const items: T[] = [];

    for (let page = 0; page < MAX_PAGE_COUNT; page++) {
      const response = await loadPage(page, PAGE_SIZE);
      if (!Array.isArray(response.content)) {
        throw new Error(`Invalid paginated response: page ${page} has no content array`);
      }
      if (response.content.length > PAGE_SIZE) {
        throw new Error(
          `Invalid paginated response: page ${page} contains more than ${PAGE_SIZE} items`,
        );
      }

      if (response.last !== undefined && typeof response.last !== 'boolean') {
        throw new Error(`Invalid paginated response: page ${page} has invalid last metadata`);
      }
      const totalPages =
        response.totalPages === undefined
          ? undefined
          : requiredNonNegativeInteger(
              response.totalPages,
              `paginated response page ${page} totalPages`,
            );
      if (totalPages !== undefined && totalPages > MAX_PAGE_COUNT) {
        throw new Error(
          `Invalid paginated response: totalPages ${totalPages} exceeds the safety limit ${MAX_PAGE_COUNT}`,
        );
      }
      if (totalPages === 0 && response.content.length > 0) {
        throw new Error('Invalid paginated response: totalPages is zero but content is not empty');
      }
      if (totalPages !== undefined && totalPages > 0 && page >= totalPages) {
        throw new Error(
          `Invalid paginated response: page ${page} is outside totalPages ${totalPages}`,
        );
      }

      items.push(...response.content);

      if (response.last === true) {
        if (totalPages !== undefined && page + 1 < totalPages) {
          throw new Error(
            `Invalid paginated response: page ${page} is last before totalPages ${totalPages}`,
          );
        }
        return items;
      }

      if (totalPages !== undefined && page + 1 >= totalPages) {
        if (response.last === false) {
          throw new Error(
            `Invalid paginated response: page ${page} is not last at totalPages ${totalPages}`,
          );
        }
        return items;
      }

      const hasPaginationMetadata = response.last !== undefined || totalPages !== undefined;
      if (!hasPaginationMetadata && response.content.length < PAGE_SIZE) {
        return items;
      }
      if (response.content.length === 0) {
        throw new Error(`Invalid paginated response: page ${page} is empty before the last page`);
      }
    }

    throw new Error(`Paginated response exceeded the safety limit of ${MAX_PAGE_COUNT} pages`);
  }

  private async appendScenarioSteps(testCaseId: number, steps: ScenarioStep[]): Promise<void> {
    const createdStepByDepth = new Map<number, number>();

    for (const step of steps) {
      const parentId = step.depth === 0 ? undefined : createdStepByDepth.get(step.depth - 1);
      if (step.depth > 0 && parentId === undefined) {
        throw new Error(`Scenario step at depth ${step.depth} has no created parent`);
      }

      const created = await this.createScenarioStep(
        testCaseId,
        step.text,
        parentId,
        step.expectedResults.length > 0,
      );
      createdStepByDepth.set(step.depth, created.id);
      for (const knownDepth of Array.from(createdStepByDepth.keys())) {
        if (knownDepth > step.depth) createdStepByDepth.delete(knownDepth);
      }

      if (step.expectedResults.length === 0) continue;
      if (created.expectedResultId === undefined) {
        throw new Error(
          `TestOps did not create an expected-result container for scenario step ${created.id}`,
        );
      }

      for (const expectedResult of step.expectedResults) {
        await this.createScenarioStep(testCaseId, expectedResult, created.expectedResultId, false);
      }
    }
  }

  private async setImportedTestCaseScenario(
    testCaseId: number,
    scenario: ApiScenario,
  ): Promise<void> {
    await this.client.post(`/api/testcase/${testCaseId}/scenario`, scenario, {
      params: { v2: true },
      headers: this.getHeaders(),
    });
  }

  private async createScenarioStep(
    testCaseId: number,
    text: string,
    parentId: number | undefined,
    withExpectedResult: boolean,
  ): Promise<{ id: number; expectedResultId?: number }> {
    const response = await this.client.post<ScenarioStepCreatedResponse>(
      '/api/testcase/step',
      {
        testCaseId,
        bodyJson: docJson(text),
        ...(parentId === undefined ? {} : { parentId }),
      },
      {
        params: { withExpectedResult },
        headers: this.getHeaders(),
      },
    );

    const id = requiredInteger(response.data.createdStepId, 'created scenario step id');
    if (!withExpectedResult) return { id };

    const expectedResultId = requiredInteger(
      response.data.scenario?.scenarioSteps?.[String(id)]?.expectedResultId,
      `expected-result container id for scenario step ${id}`,
    );
    return { id, expectedResultId };
  }
}

function formatPreconditions(preconditions: string[]): string {
  return preconditions.map((item) => `- ${item}`).join('\n');
}

function pageResult<T>(response: ApiPageResponse<T>, label: string): PageResult<T> {
  if (!Array.isArray(response.content)) {
    throw new Error(`Invalid ${label} response: content is not an array`);
  }
  const page = requiredNonNegativeInteger(response.number, `${label} page`);
  const size = requiredPositiveInteger(response.size, `${label} page size`);
  const totalElements = requiredNonNegativeInteger(
    response.totalElements,
    `${label} total elements`,
  );
  const totalPages = requiredNonNegativeInteger(response.totalPages, `${label} total pages`);
  if (response.content.length > size || response.content.length > totalElements) {
    throw new Error(`Invalid ${label} response: inconsistent page metadata`);
  }
  return { items: response.content, page, size, totalElements, totalPages };
}

function aqlString(value: string, label: string): string {
  requiredString(value, label);
  // Control characters are the point here: this is what keeps them out of the AQL
  // the server builds around caller input.
  // eslint-disable-next-line no-control-regex
  if (/["\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} cannot contain quotes, backslashes, or control characters`);
  }
  return `"${value}"`;
}

function scenarioToApiScenario(scenario: ScenarioStep[]): ApiScenario {
  if (!Array.isArray(scenario) || scenario.length === 0) {
    throw new Error('Imported test-case scenario has no steps');
  }

  const roots: ApiScenarioBodyStep[] = [];
  const stepAtDepth = new Map<number, ApiScenarioBodyStep>();

  for (const [index, step] of scenario.entries()) {
    if (!isRecord(step)) {
      throw new Error(`Invalid imported scenario step ${index}: expected an object`);
    }
    const text = requiredString(step.text, `imported scenario step ${index} text`);
    const depth = requiredNonNegativeInteger(step.depth, `imported scenario step ${index} depth`);
    if (!Array.isArray(step.expectedResults)) {
      throw new Error(`Invalid imported scenario step ${index} expectedResults`);
    }
    const expectedResults = step.expectedResults.map((value, expectedIndex) =>
      requiredString(value, `imported scenario step ${index} expected result ${expectedIndex}`),
    );
    const apiStep: ApiScenarioBodyStep = {
      type: 'body',
      bodyJson: docJson(text),
      steps: [],
      ...(expectedResults.length === 0
        ? {}
        : {
            expectedResultSteps: expectedResults.map((expectedResult) => ({
              type: 'expected_body',
              bodyJson: docJson(expectedResult),
              steps: [],
            })),
          }),
    };

    if (depth === 0) {
      roots.push(apiStep);
    } else {
      const parent = stepAtDepth.get(depth - 1);
      if (!parent) {
        throw new Error(`Imported scenario step at depth ${depth} has no parent step`);
      }
      parent.steps.push(apiStep);
    }

    stepAtDepth.set(depth, apiStep);
    for (const knownDepth of Array.from(stepAtDepth.keys())) {
      if (knownDepth > depth) stepAtDepth.delete(knownDepth);
    }
  }

  return { steps: roots };
}

function docJson(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTestCaseScenario(value: unknown): TestCaseScenario {
  if (!isRecord(value)) {
    throw new Error('Invalid test-case scenario response: expected an object');
  }

  if (value.root !== undefined) {
    validateScenarioStep(value.root, 'test-case scenario root');
  }
  validateOptionalScenarioStepMap(value.scenarioSteps, 'test-case scenario steps');
  validateOptionalRecord(value.attachments, 'test-case scenario attachments');
  validateOptionalRecord(value.sharedStepAttachments, 'test-case scenario shared-step attachments');
  validateOptionalScenarioStepMap(
    value.sharedStepScenarioSteps,
    'test-case scenario shared-step scenario steps',
  );
  validateOptionalScenarioStepMap(value.sharedSteps, 'test-case scenario shared steps');

  return value as unknown as TestCaseScenario;
}

function validateScenarioStepMap(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: expected an object`);

  for (const [key, stepValue] of Object.entries(value)) {
    validateScenarioStep(stepValue, `${label} ${key}`);
  }
}

function validateOptionalScenarioStepMap(value: unknown, label: string): void {
  if (value === undefined) return;
  validateScenarioStepMap(value, label);
}

function validateScenarioStep(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}: expected an object`);
  if (value.id !== undefined) requiredInteger(value.id, `${label} id`);
  if (value.body !== undefined && typeof value.body !== 'string') {
    throw new Error(`Invalid ${label} body`);
  }
  if (value.bodyJson !== undefined && !isRecord(value.bodyJson)) {
    throw new Error(`Invalid ${label} bodyJson`);
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) throw new Error(`Invalid ${label} children`);
    validateIntegerArray(value.children, `${label} children`);
  }
  if (value.expectedResult !== undefined && typeof value.expectedResult !== 'string') {
    throw new Error(`Invalid ${label} expectedResult`);
  }
  if (value.expectedResultId !== undefined) {
    requiredInteger(value.expectedResultId, `${label} expectedResultId`);
  }
  return value;
}

function validateIntegerArray(values: unknown[], label: string): void {
  values.forEach((value, index) => requiredInteger(value, `${label} ${index}`));
}

function validateOptionalRecord(value: unknown, label: string): void {
  if (value !== undefined && !isRecord(value)) throw new Error(`Invalid ${label}`);
}

function isUnknownWriteOutcome(error: unknown): boolean {
  return (
    axios.isAxiosError(error) && (error.response === undefined || error.response.status >= 500)
  );
}

function trashSearchResolution(totalElements: number): TestCaseTrashSearchResult['resolution'] {
  if (totalElements === 0) return 'not_found';
  return totalElements === 1 ? 'unique' : 'ambiguous';
}

function normalizeProjectCustomField(
  item: ProjectCustomFieldApiItem,
  index: number,
): ProjectCustomField {
  const customField = item.customField;
  if (!customField) {
    throw new Error(`Invalid project custom-field response: item ${index} has no customField`);
  }
  const defaultValueId = optionalInteger(
    item.defaultCustomFieldValueId,
    `project custom field ${index} default value id`,
  );

  return {
    id: requiredInteger(customField.id, `project custom field ${index} id`),
    name: requiredString(customField.name, `project custom field ${index} name`),
    required: item.required === true || customField.required === true,
    singleSelect: customField.singleSelect === true,
    locked: item.locked === true || customField.locked === true,
    ...(defaultValueId === undefined ? {} : { defaultValueId }),
  };
}

function normalizeProjectCustomFieldValue(
  item: ProjectCustomFieldValueApiItem,
  index: number,
  expectedFieldId: number,
): ProjectCustomFieldValue {
  if (!item.customField) {
    throw new Error(
      `Invalid project custom-field value response: item ${index} has no customField`,
    );
  }

  const fieldId = requiredInteger(
    item.customField.id,
    `project custom-field value ${index} field id`,
  );
  if (fieldId !== expectedFieldId) {
    throw new Error(
      `Invalid project custom-field value response: item ${index} belongs to field ${fieldId}, ` +
        `expected field ${expectedFieldId}`,
    );
  }

  return {
    id: requiredInteger(item.id, `project custom-field value ${index} id`),
    fieldId,
    name: requiredString(item.name, `project custom-field value ${index} name`),
    global: item.global === true,
  };
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const integer = requiredInteger(value, label);
  if (integer < 0) throw new Error(`Invalid ${label}`);
  return integer;
}

function requiredNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredPercentage(value: unknown, label: string): number {
  const percentage = requiredNonNegativeNumber(value, label);
  if (percentage > 100) throw new Error(`Invalid ${label}`);
  return percentage;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const integer = requiredInteger(value, label);
  if (integer <= 0) throw new Error(`Invalid ${label}`);
  return integer;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredInteger(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function requiredTestStatus(value: unknown, label: string): TestStatusCount['status'] {
  const statuses: TestStatusCount['status'][] = [
    'failed',
    'broken',
    'passed',
    'skipped',
    'unknown',
    'in_progress',
  ];
  if (!statuses.includes(value as TestStatusCount['status'])) {
    throw new Error(`Invalid ${label}`);
  }
  return value as TestStatusCount['status'];
}
