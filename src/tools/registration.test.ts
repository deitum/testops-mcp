import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { test } from 'vitest';

import {
  ImportedTestCaseCreateError,
  ImportedTestCaseOutcomeUnknownError,
  TestCaseRestoreOutcomeUnknownError,
  TestOpsClient,
} from '../client/TestOpsClient';
import type {
  ProjectCustomField,
  TestCase,
  TestCaseDeleteResult,
  TestCaseImportCreateRequest,
  TestCaseRestoreResult,
  TestCaseScenario,
  TestCaseTrashSearchQuery,
  TestCaseTrashSearchResult,
} from '../client/types';
import { createServerInstructions, createTestOpsServer } from '../server';
import { SERVER_INFO } from '../testops.constants';

interface ToolJsonSchemaProperty {
  description?: string;
  default?: unknown;
  enum?: unknown[];
  maximum?: number;
  minimum?: number;
  additionalProperties?: boolean;
  properties?: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
  items?: ToolJsonSchemaProperty;
}

interface ToolJsonSchema {
  additionalProperties?: boolean;
  properties?: Record<string, ToolJsonSchemaProperty>;
  required?: string[];
}

interface ToolPayload {
  allowedImportRoots?: string[];
  workflow?: string;
  rules?: string;
  example?: string;
  status?: string;
  resolution?: string;
  verifiedBy?: string;
  destination?: string;
  testCaseId?: number;
  name?: string;
  projectId?: number;
  totalElements?: number;
  matches?: unknown[];
  created?: unknown[];
  message?: string;
  nextAction?: string;
  diagnostics?: { code?: string }[];
}

class CountingTestOpsClient extends TestOpsClient {
  addStepsCalls: Array<{
    id: number;
    steps: Parameters<TestOpsClient['addTestCaseSteps']>[1];
  }> = [];
  catalogCalls = 0;
  createCalls = 0;
  importedCreateError: Error | undefined;
  deleteCalls: { id: number; expectedName: string }[] = [];
  issueLinkCalls: { id: number; issueKeys: string[] }[] = [];
  restoreCalls: { id: number; expectedName: string }[] = [];
  scenarioReads: number[] = [];
  trashSearchCalls: TestCaseTrashSearchQuery[] = [];
  readonly scenario: TestCaseScenario = {
    root: { children: [10] },
    scenarioSteps: {
      '10': { id: 10, body: 'Action', children: [], expectedResultId: 20 },
      '20': { id: 20, children: [21] },
      '21': { id: 21, body: 'Expected result', children: [] },
    },
  };

  override async listProjectCustomFields(): Promise<ProjectCustomField[]> {
    this.catalogCalls++;
    return [];
  }

  override async createImportedTestCase(_data: TestCaseImportCreateRequest): Promise<TestCase> {
    this.createCalls++;
    if (this.importedCreateError) throw this.importedCreateError;
    return { id: 1, name: 'unexpected' };
  }

  override async addTestCaseSteps(
    id: number,
    steps: Parameters<TestOpsClient['addTestCaseSteps']>[1],
  ): Promise<void> {
    this.addStepsCalls.push({ id, steps });
  }

  override async getTestCaseSteps(id: number): Promise<TestCaseScenario> {
    this.scenarioReads.push(id);
    return this.scenario;
  }

  override async addTestCaseIssueLinks(id: number, issueKeys: string[]): Promise<void> {
    this.issueLinkCalls.push({ id, issueKeys });
  }

  override async deleteTestCase(id: number, expectedName: string): Promise<TestCaseDeleteResult> {
    this.deleteCalls.push({ id, expectedName });
    return {
      status: 'accepted',
      destination: 'trash',
      testCaseId: id,
      name: expectedName,
      projectId: this.configuredProjectId,
    };
  }

  override async searchTestCasesInTrash(
    query: TestCaseTrashSearchQuery,
  ): Promise<TestCaseTrashSearchResult> {
    this.trashSearchCalls.push(query);
    return {
      projectId: this.configuredProjectId,
      query,
      resolution: 'unique',
      page: query.by === 'name' ? query.page : 0,
      size: query.by === 'name' ? query.size : 1,
      totalElements: 1,
      totalPages: 1,
      matches: [{ id: 42, name: 'Deleted case' }],
    };
  }

  override async restoreTestCase(id: number, expectedName: string): Promise<TestCaseRestoreResult> {
    if (id === 99) {
      throw new TestCaseRestoreOutcomeUnknownError(
        id,
        new Error('connection lost'),
        new Error('verification unavailable'),
      );
    }
    this.restoreCalls.push({ id, expectedName });
    return {
      status: 'restored',
      verifiedBy: 'response',
      testCaseId: id,
      name: expectedName,
      projectId: this.configuredProjectId,
    };
  }
}

test('publishes the complete MCP contract locked to the configured project', async (context) => {
  const importRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'testops-mcp-contract-'));
  const invalidFile = path.join(importRoot, 'invalid.md');
  const validFile = path.join(importRoot, 'valid.md');
  await fs.writeFile(invalidFile, '# Invalid case\n## Steps\n1. Open page', 'utf8');
  await fs.writeFile(validFile, '## Valid case\n### Steps\n[step] Open page', 'utf8');
  const testOpsClient = new CountingTestOpsClient('http://127.0.0.1', 'not-used', 23);
  const server = createTestOpsServer(testOpsClient, { allowedMarkdownRoots: [importRoot] });
  const client = new Client({ name: 'registration-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
    await fs.rm(importRoot, { recursive: true, force: true });
  });

  assert.equal(client.getInstructions(), createServerInstructions(23));
  assert.deepEqual(client.getServerVersion(), { ...SERVER_INFO });
  const listedTools = await client.listTools();
  const tools = new Map(listedTools.tools.map((tool) => [tool.name, tool]));

  const expectedToolNames = [
    'launch_create',
    'launch_get',
    'launch_list',
    'launch_statistic',
    'launch_update',
    'statistics_overall',
    'testcase_add_issue_links',
    'testcase_add_steps',
    'testcase_create',
    'testcase_custom_fields',
    'testcase_delete',
    'testcase_get',
    'testcase_history',
    'testcase_import_markdown',
    'testcase_markdown_guide',
    'testcase_restore',
    'testcase_search',
    'testcase_search_by_custom_field',
    'testcase_set_tags',
    'testcase_steps',
    'testcase_trash_search',
  ];
  assert.deepEqual([...tools.keys()].sort(), expectedToolNames);

  const readme = await fs.readFile(path.resolve('README.md'), 'utf8');
  const documentedToolNames = Array.from(
    readme.matchAll(/^- `((?:testcase|launch|statistics)_[a-z_]+)` — /gm),
    (match) => match[1],
  ).sort();
  assert.deepEqual(documentedToolNames, expectedToolNames);

  for (const [name, tool] of tools) {
    const schema = tool.inputSchema as ToolJsonSchema | undefined;
    assert.ok(schema, `${name} must publish an input schema`);
    assert.equal(
      schema.properties && 'projectId' in schema.properties,
      false,
      `${name} must not let the caller select projectId`,
    );
    assert.doesNotMatch(JSON.stringify(schema), /"projectId"/);
  }

  const importTool = tools.get('testcase_import_markdown');
  const importSchema = importTool?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(importSchema?.required, ['filePath']);
  assert.equal(importSchema?.properties && 'mode' in importSchema.properties, false);
  assert.match(importTool?.description || '', /single call/i);
  assert.match(importTool?.description || '', /completed.*refused.*failed.*outcome_unknown/i);
  assert.match(
    importTool?.description || '',
    /never perform a retry, deletion, or rollback automatically/i,
  );

  for (const toolName of [
    'testcase_search',
    'testcase_history',
    'launch_list',
    'testcase_search_by_custom_field',
  ]) {
    const schema = tools.get(toolName)?.inputSchema as ToolJsonSchema | undefined;
    assert.equal(schema?.properties?.size.maximum, 50, `${toolName}.size must not exceed 50`);
  }

  const customFieldSearchTool = tools.get('testcase_search_by_custom_field');
  const customFieldSearchSchema = customFieldSearchTool?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(Object.keys(customFieldSearchSchema?.properties || {}).sort(), [
    'fieldName',
    'page',
    'size',
    'value',
  ]);
  assert.deepEqual(customFieldSearchSchema?.required, ['fieldName', 'value']);
  assert.equal(customFieldSearchSchema?.properties?.page.default, 0);
  assert.equal(customFieldSearchSchema?.properties?.size.default, 20);
  assert.match(customFieldSearchTool?.description || '', /exact.*server-side/i);

  const setTagsTool = tools.get('testcase_set_tags');
  const setTagsSchema = setTagsTool?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(Object.keys(setTagsSchema?.properties || {}).sort(), [
    'expectedName',
    'id',
    'tags',
  ]);
  assert.deepEqual(setTagsSchema?.required, ['id', 'expectedName', 'tags']);
  assert.equal(setTagsTool?.annotations?.destructiveHint, true);

  const addStepsSchema = tools.get('testcase_add_steps')?.inputSchema as ToolJsonSchema | undefined;
  const stepItemSchema = addStepsSchema?.properties?.steps.items;
  assert.deepEqual(Object.keys(stepItemSchema?.properties || {}).sort(), [
    'expectedResults',
    'name',
  ]);
  assert.equal(stepItemSchema?.properties && 'expectedResult' in stepItemSchema.properties, false);
  assert.equal(stepItemSchema?.additionalProperties, false);

  const addIssueLinksTool = tools.get('testcase_add_issue_links');
  assert.match(addIssueLinksTool?.description || '', /external links.*single request/i);
  assert.match(addIssueLinksTool?.description || '', /outcome may be unknown/i);
  const addIssueLinksSchema = addIssueLinksTool?.inputSchema as ToolJsonSchema | undefined;
  assert.match(addIssueLinksSchema?.properties?.issueKeys.description || '', /unique.*duplicates/i);

  const duplicateIssueLinks = await client.callTool({
    name: 'testcase_add_issue_links',
    arguments: { testCaseId: 42, issueKeys: ['TEST-1', 'TEST-1'] },
  });
  assert.equal(duplicateIssueLinks.isError, true);
  assert.match(toolText(duplicateIssueLinks.content), /Issue keys must be unique/);
  assert.deepEqual(testOpsClient.issueLinkCalls, []);

  const validSteps = await client.callTool({
    name: 'testcase_add_steps',
    arguments: {
      testCaseId: 42,
      steps: [{ name: 'Action', expectedResults: ['First result', 'Second result'] }],
    },
  });
  assert.notEqual(validSteps.isError, true);
  assert.deepEqual(testOpsClient.addStepsCalls, [
    {
      id: 42,
      steps: [{ name: 'Action', expectedResults: ['First result', 'Second result'] }],
    },
  ]);

  const scenarioResult = toolPayload(
    (
      await client.callTool({
        name: 'testcase_steps',
        arguments: { id: 42 },
      })
    ).content,
  );
  assert.deepEqual(scenarioResult, testOpsClient.scenario);
  assert.deepEqual(testOpsClient.scenarioReads, [42]);

  const legacyStep = await client.callTool({
    name: 'testcase_add_steps',
    arguments: {
      testCaseId: 42,
      steps: [{ name: 'Action', expectedResult: 'Legacy result' }],
    },
  });
  assert.equal(legacyStep.isError, true);
  assert.match(toolText(legacyStep.content), /Input validation error/);
  assert.equal(testOpsClient.addStepsCalls.length, 1);

  const launchCreateSchema = tools.get('launch_create')?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(Object.keys(launchCreateSchema?.properties || {}), ['name']);
  assert.deepEqual(launchCreateSchema?.required, ['name']);

  const launchUpdateSchema = tools.get('launch_update')?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(Object.keys(launchUpdateSchema?.properties || {}).sort(), [
    'expectedName',
    'id',
    'name',
  ]);
  assert.deepEqual(launchUpdateSchema?.required, ['id', 'expectedName', 'name']);
  assert.equal(launchUpdateSchema?.properties && 'status' in launchUpdateSchema.properties, false);

  const guideTool = tools.get('testcase_markdown_guide');
  assert.equal(guideTool?.annotations?.readOnlyHint, true);
  assert.match(guideTool?.description || '', /before creating, converting, or repairing/i);
  assert.match(
    guideTool?.description || '',
    /first import attempt.*without testcase_custom_fields/i,
  );

  const guideResult = await client.callTool({
    name: 'testcase_markdown_guide',
    arguments: {},
  });
  assert.notEqual(guideResult.isError, true);
  const guide = toolPayload(guideResult.content);
  const [guideRulesFile, guideExampleFile] = await Promise.all([
    fs.readFile(path.resolve('docs/markdown-import.md'), 'utf8'),
    fs.readFile(path.resolve('examples/testops-markdown-import-example.md'), 'utf8'),
  ]);
  assert.deepEqual(guide.allowedImportRoots, [importRoot]);
  assert.match(guide.workflow || '', /only if the user requested import/i);
  assert.match(guide.workflow || '', /first import attempt.*without testcase_custom_fields/i);
  assert.match(guide.workflow || '', /after a field-related import diagnostic/i);
  assert.equal(guide.rules, guideRulesFile);
  assert.equal(guide.example, guideExampleFile);

  const deleteTool = tools.get('testcase_delete');
  const deleteSchema = deleteTool?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(deleteSchema?.required, ['id', 'expectedName']);
  assert.equal(deleteSchema?.properties && 'force' in deleteSchema.properties, false);
  assert.equal(deleteTool?.annotations?.destructiveHint, true);
  assert.equal(deleteTool?.annotations?.idempotentHint, false);
  assert.match(deleteTool?.description || '', /explicitly asks to delete this exact ID/i);
  assert.match(deleteTool?.description || '', /Use testcase_get first/i);
  assert.match(deleteTool?.description || '', /does not permanently delete/i);

  const deleteResult = toolPayload(
    (
      await client.callTool({
        name: 'testcase_delete',
        arguments: { id: 42, expectedName: 'Case to delete' },
      })
    ).content,
  );
  assert.deepEqual(deleteResult, {
    status: 'accepted',
    destination: 'trash',
    testCaseId: 42,
    name: 'Case to delete',
    projectId: 23,
  });
  assert.deepEqual(testOpsClient.deleteCalls, [{ id: 42, expectedName: 'Case to delete' }]);

  const trashSearchTool = tools.get('testcase_trash_search');
  assert.equal(trashSearchTool?.annotations?.readOnlyHint, true);
  assert.equal(trashSearchTool?.annotations?.destructiveHint, false);
  assert.equal(trashSearchTool?.annotations?.idempotentHint, true);
  assert.match(trashSearchTool?.description || '', /duplicate names/i);
  assert.match(trashSearchTool?.description || '', /do not restore/i);
  const trashSearchSchema = trashSearchTool?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(Object.keys(trashSearchSchema?.properties || {}).sort(), [
    'by',
    'id',
    'match',
    'name',
    'page',
    'size',
  ]);
  assert.deepEqual(trashSearchSchema?.required, ['by']);
  assert.equal(trashSearchSchema?.additionalProperties, false);
  assert.deepEqual(trashSearchSchema?.properties?.by.enum, ['id', 'name']);
  assert.match(
    trashSearchSchema?.properties?.id.description || '',
    /allowed only when by is "id"/i,
  );
  assert.match(
    trashSearchSchema?.properties?.name.description || '',
    /allowed only when by is "name"/i,
  );
  assert.equal(trashSearchSchema?.properties?.size.maximum, 50);
  assert.doesNotMatch(JSON.stringify(trashSearchSchema), /"rql"|"projectId"/);

  const trashSearchResult = toolPayload(
    (
      await client.callTool({
        name: 'testcase_trash_search',
        arguments: { by: 'name', name: 'Deleted case' },
      })
    ).content,
  );
  assert.equal(trashSearchResult.resolution, 'unique');
  assert.equal(trashSearchResult.totalElements, 1);
  assert.deepEqual(testOpsClient.trashSearchCalls, [
    {
      by: 'name',
      name: 'Deleted case',
      match: 'contains',
      page: 0,
      size: 20,
    },
  ]);

  const trashSearchById = await client.callTool({
    name: 'testcase_trash_search',
    arguments: { by: 'id', id: 42 },
  });
  assert.notEqual(trashSearchById.isError, true);
  assert.deepEqual(testOpsClient.trashSearchCalls[1], { by: 'id', id: 42 });

  const invalidTrashSearch = await client.callTool({
    name: 'testcase_trash_search',
    arguments: { by: 'id' },
  });
  assert.equal(invalidTrashSearch.isError, true);
  assert.match(toolText(invalidTrashSearch.content), /requires id/);
  assert.equal(testOpsClient.trashSearchCalls.length, 2);

  for (const arguments_ of [
    { by: 'id', id: 42, name: 'Deleted case' },
    { by: 'id', id: 42, match: 'exact' },
    { by: 'name', id: 42, name: 'Deleted case' },
  ]) {
    const conflictingTrashSearch = await client.callTool({
      name: 'testcase_trash_search',
      arguments: arguments_,
    });
    assert.equal(conflictingTrashSearch.isError, true);
    assert.match(toolText(conflictingTrashSearch.content), /does not accept/);
  }
  assert.equal(testOpsClient.trashSearchCalls.length, 2);

  for (const arguments_ of [
    { by: 'id', id: 42, projectId: 99 },
    { by: 'name', name: 'Deleted case', rql: 'id > 0' },
  ]) {
    const unknownTrashInput = await client.callTool({
      name: 'testcase_trash_search',
      arguments: arguments_,
    });
    assert.equal(unknownTrashInput.isError, true);
    assert.match(toolText(unknownTrashInput.content), /Input validation error/);
  }
  assert.equal(testOpsClient.trashSearchCalls.length, 2);

  const oversizedTrashSearch = await client.callTool({
    name: 'testcase_trash_search',
    arguments: { by: 'name', name: 'Deleted case', size: 51 },
  });
  assert.equal(oversizedTrashSearch.isError, true);
  assert.match(toolText(oversizedTrashSearch.content), /Input validation error/);
  assert.equal(testOpsClient.trashSearchCalls.length, 2);

  const restoreTool = tools.get('testcase_restore');
  const restoreSchema = restoreTool?.inputSchema as ToolJsonSchema | undefined;
  assert.deepEqual(restoreSchema?.required, ['id', 'expectedName']);
  assert.doesNotMatch(JSON.stringify(restoreSchema), /"projectId"|"force"/);
  assert.equal(restoreTool?.annotations?.readOnlyHint, false);
  assert.equal(restoreTool?.annotations?.destructiveHint, false);
  assert.equal(restoreTool?.annotations?.idempotentHint, false);
  assert.match(restoreTool?.description || '', /explicitly asks to restore/i);
  assert.match(restoreTool?.description || '', /never retry restoration automatically/i);

  const restoreResult = toolPayload(
    (
      await client.callTool({
        name: 'testcase_restore',
        arguments: { id: 42, expectedName: 'Deleted case' },
      })
    ).content,
  );
  assert.deepEqual(restoreResult, {
    status: 'restored',
    verifiedBy: 'response',
    testCaseId: 42,
    name: 'Deleted case',
    projectId: 23,
  });
  assert.deepEqual(testOpsClient.restoreCalls, [{ id: 42, expectedName: 'Deleted case' }]);

  const unknownRestore = await client.callTool({
    name: 'testcase_restore',
    arguments: { id: 99, expectedName: 'Unknown case' },
  });
  assert.equal(unknownRestore.isError, true);
  assert.match(toolText(unknownRestore.content), /Do not retry automatically; search Trash by ID/);
  assert.deepEqual(testOpsClient.restoreCalls, [{ id: 42, expectedName: 'Deleted case' }]);

  const refusedResult = await client.callTool({
    name: 'testcase_import_markdown',
    arguments: { filePath: invalidFile },
  });
  assert.equal(refusedResult.isError, true);
  const refused = toolPayload(refusedResult.content);
  assert.equal(refused.status, 'refused');
  assert.deepEqual(refused.created, []);
  assert.match(refused.message || '', /No test cases were created/);
  assert.match(refused.nextAction || '', /wait for the user/i);
  assert.match(refused.nextAction || '', /testcase_markdown_guide/);
  assert.match(refused.nextAction || '', /Retry only when the user asks/i);
  assert.equal(testOpsClient.catalogCalls, 0);
  assert.equal(testOpsClient.createCalls, 0);

  const relativePathResult = await client.callTool({
    name: 'testcase_import_markdown',
    arguments: { filePath: 'relative-cases.md' },
  });
  assert.equal(relativePathResult.isError, true);
  const relativePathPayload = toolPayload(relativePathResult.content);
  assert.equal(relativePathPayload.status, 'refused');
  assert.ok(
    relativePathPayload.diagnostics?.some(
      (diagnostic) => diagnostic.code === 'FILE_PATH_NOT_ABSOLUTE',
    ),
  );
  assert.equal(testOpsClient.catalogCalls, 0);
  assert.equal(testOpsClient.createCalls, 0);

  testOpsClient.importedCreateError = new ImportedTestCaseCreateError(
    321,
    'tags',
    new Error('tag write failed'),
  );
  const failedImport = toolPayload(
    (
      await client.callTool({
        name: 'testcase_import_markdown',
        arguments: { filePath: validFile },
      })
    ).content,
  );
  assert.equal(failedImport.status, 'failed');
  assert.match(
    failedImport.nextAction || '',
    /Do not perform any retry, deletion, or rollback automatically/i,
  );
  assert.match(failedImport.nextAction || '', /wait for the user/i);

  testOpsClient.importedCreateError = new ImportedTestCaseOutcomeUnknownError(
    new Error('connection lost'),
  );
  const unknownImport = toolPayload(
    (
      await client.callTool({
        name: 'testcase_import_markdown',
        arguments: { filePath: validFile },
      })
    ).content,
  );
  assert.equal(unknownImport.status, 'outcome_unknown');
  assert.match(unknownImport.nextAction || '', /Reconcile whether the case exists/i);
  assert.match(
    unknownImport.nextAction || '',
    /Do not perform any retry, deletion, or rollback automatically/i,
  );
  testOpsClient.importedCreateError = undefined;

  const customFieldsTool = tools.get('testcase_custom_fields');
  assert.match(customFieldsTool?.description || '', /only when the user explicitly requests/i);
  assert.match(
    customFieldsTool?.description || '',
    /not a prerequisite for the first Markdown import attempt/i,
  );
  assert.match(customFieldsTool?.description || '', /after a field-related import diagnostic/i);
  assert.equal(tools.get('launch_update')?.annotations?.destructiveHint, true);
  assert.match(client.getInstructions() || '', /locked to Allure TestOps project 23/i);
  assert.match(client.getInstructions() || '', /do not ask for, infer, or pass projectId/i);
  assert.match(client.getInstructions() || '', /call testcase_markdown_guide/i);
  assert.match(
    client.getInstructions() || '',
    /ready existing file.*testcase_import_markdown directly/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Do not call testcase_custom_fields before the first import attempt/i,
  );
  assert.match(client.getInstructions() || '', /after a field-related import diagnostic/i);
  assert.match(
    client.getInstructions() || '',
    /After any structured import result whose status is not completed/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Do not perform any edit-and-retry, deletion, or rollback automatically/i,
  );
  assert.match(
    client.getInstructions() || '',
    /only after the user explicitly asks to delete that exact test case/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Never use testcase_delete automatically as cleanup or rollback/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Use testcase_trash_search to find deleted test cases/i,
  );
  assert.match(
    client.getInstructions() || '',
    /never select one of multiple candidates automatically/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Call testcase_restore only after the user explicitly asks/i,
  );
  assert.match(client.getInstructions() || '', /never retry restoration automatically/i);
  assert.match(client.getInstructions() || '', /Never retry testcase_create automatically/i);
  assert.match(
    client.getInstructions() || '',
    /testcase_add_steps fails.*testcase_add_issue_links fails.*never retry automatically.*wait for the user/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Call launch_create only after the user explicitly asks.*never retry it automatically/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Before launch_update, call launch_get.*expectedName/i,
  );
  assert.match(
    client.getInstructions() || '',
    /Before testcase_set_tags, call testcase_get.*expectedName/i,
  );
});

test('import refuses a file with issue keys while no Jira root is configured', async (context) => {
  const importRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'testops-mcp-jira-'));
  const linkedFile = path.join(importRoot, 'linked.md');
  await fs.writeFile(
    linkedFile,
    '## Linked case\n### Steps\n[step] Open page\n### Ссылки\n- TEST-1',
    'utf8',
  );
  const testOpsClient = new CountingTestOpsClient('http://127.0.0.1', 'not-used', 23);
  assert.equal(testOpsClient.issueLinksConfigured, false);

  const server = createTestOpsServer(testOpsClient, { allowedMarkdownRoots: [importRoot] });
  const client = new Client({ name: 'jira-registration-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close()]);
    await fs.rm(importRoot, { recursive: true, force: true });
  });

  const result = await client.callTool({
    name: 'testcase_import_markdown',
    arguments: { filePath: linkedFile },
  });
  assert.equal(result.isError, true);
  const payload = toolPayload(result.content);
  assert.equal(payload.status, 'refused');
  assert.ok(payload.diagnostics?.some((diagnostic) => diagnostic.code === 'JIRA_NOT_CONFIGURED'));
  assert.equal(testOpsClient.createCalls, 0);
});

function toolPayload(content: unknown): ToolPayload {
  return JSON.parse(toolText(content)) as ToolPayload;
}

function toolText(content: unknown): string {
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, 'text');
  assert.equal(typeof first.text, 'string');
  return first.text as string;
}
