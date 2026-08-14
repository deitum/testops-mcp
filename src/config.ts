import path from 'node:path';

export interface TestOpsConfig {
  baseUrl: string;
  apiKey: string;
  projectId: number;
  sslVerify: boolean;
  importRoots: string[];
  /** Undefined when TESTOPS_JIRA_BASE_URL is unset; issue links then fail closed. */
  jiraBaseUrl?: string;
}

export function loadConfig(): TestOpsConfig {
  const baseUrl = process.env.TESTOPS_BASE_URL?.trim();
  const apiKey = process.env.TESTOPS_API_KEY?.trim();
  const projectIdValue = process.env.TESTOPS_PROJECT_ID?.trim();
  const jiraBaseUrl = process.env.TESTOPS_JIRA_BASE_URL?.trim();
  const sslVerify = process.env.TESTOPS_SSL_VERIFY !== 'false';

  if (!baseUrl) {
    throw new Error('Environment variable TESTOPS_BASE_URL is not set');
  }

  if (!apiKey) {
    throw new Error('Environment variable TESTOPS_API_KEY is not set');
  }

  if (!projectIdValue) {
    throw new Error('Environment variable TESTOPS_PROJECT_ID is not set');
  }

  const projectId = Number(projectIdValue);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error('Environment variable TESTOPS_PROJECT_ID must be a positive integer');
  }

  const configuredRoots = process.env.TESTOPS_IMPORT_ROOTS?.split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  const importRoots = (configuredRoots?.length ? configuredRoots : [process.cwd()]).map((root) =>
    path.resolve(root),
  );

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    projectId,
    sslVerify,
    importRoots,
    ...(jiraBaseUrl ? { jiraBaseUrl: normalizeJiraBaseUrl(jiraBaseUrl) } : {}),
  };
}

function normalizeBaseUrl(value: string): string {
  const url = parseSafeUrl(value, 'TESTOPS_BASE_URL');

  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Environment variable TESTOPS_BASE_URL must not contain a path');
  }

  return url.origin;
}

/**
 * Unlike the TestOps root, a Jira root is often published under a path
 * (`https://host/jira`), so the path is kept — only a trailing slash goes,
 * because the issue key is appended as `/browse/KEY`.
 */
function normalizeJiraBaseUrl(value: string): string {
  const url = parseSafeUrl(value, 'TESTOPS_JIRA_BASE_URL');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function parseSafeUrl(value: string, variable: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Environment variable ${variable} must be a valid URL`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Environment variable ${variable} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `Environment variable ${variable} must not contain credentials, query, or fragment`,
    );
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'https:' && !localHosts.has(url.hostname)) {
    throw new Error(`Environment variable ${variable} must use https outside localhost`);
  }

  return url;
}
