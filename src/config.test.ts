import assert from 'node:assert/strict';
import path from 'node:path';

import { test } from 'vitest';

import { loadConfig } from './config';

const CONFIG_KEYS = [
  'TESTOPS_BASE_URL',
  'TESTOPS_API_KEY',
  'TESTOPS_PROJECT_ID',
  'TESTOPS_SSL_VERIFY',
  'TESTOPS_IMPORT_ROOTS',
  'TESTOPS_JIRA_BASE_URL',
] as const;

test('loads and normalizes safe configuration', () => {
  const firstRoot = path.resolve('examples');
  const secondRoot = path.resolve('src');

  withConfig(
    {
      TESTOPS_BASE_URL: 'https://testops.example.test/',
      TESTOPS_PROJECT_ID: '23',
      TESTOPS_SSL_VERIFY: 'false',
      TESTOPS_IMPORT_ROOTS: `${firstRoot}${path.delimiter}${secondRoot}`,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.baseUrl, 'https://testops.example.test');
      assert.equal(config.projectId, 23);
      assert.equal(config.sslVerify, false);
      assert.deepEqual(config.importRoots, [firstRoot, secondRoot]);
    },
  );
});

test('uses the current directory as the default import root', () => {
  withConfig({}, () => {
    assert.deepEqual(loadConfig().importRoots, [path.resolve(process.cwd())]);
  });
});

test('rejects invalid project IDs and unsafe base URLs', () => {
  withConfig({ TESTOPS_PROJECT_ID: '0' }, () => {
    assert.throws(loadConfig, /positive integer/);
  });
  withConfig({ TESTOPS_BASE_URL: 'https://user:secret@testops.example.test' }, () => {
    assert.throws(loadConfig, /must not contain credentials/);
  });
  withConfig({ TESTOPS_BASE_URL: 'http://testops.example.test' }, () => {
    assert.throws(loadConfig, /must use https/);
  });
  withConfig({ TESTOPS_BASE_URL: 'https://testops.example.test/prefix' }, () => {
    assert.throws(loadConfig, /must not contain a path/);
  });
});

test('allows HTTP for a local development server only', () => {
  withConfig({ TESTOPS_BASE_URL: 'http://127.0.0.1:8080' }, () => {
    assert.equal(loadConfig().baseUrl, 'http://127.0.0.1:8080');
  });
});

test('keeps a Jira path prefix, drops its trailing slash, and stays undefined when unset', () => {
  withConfig({}, () => {
    assert.equal(loadConfig().jiraBaseUrl, undefined);
  });
  withConfig({ TESTOPS_JIRA_BASE_URL: 'https://jira.example.test/jira/' }, () => {
    assert.equal(loadConfig().jiraBaseUrl, 'https://jira.example.test/jira');
  });
  withConfig({ TESTOPS_JIRA_BASE_URL: 'https://jira.example.test' }, () => {
    assert.equal(loadConfig().jiraBaseUrl, 'https://jira.example.test');
  });
});

test('rejects an unsafe Jira base URL by name', () => {
  withConfig({ TESTOPS_JIRA_BASE_URL: 'https://user:secret@jira.example.test' }, () => {
    assert.throws(loadConfig, /TESTOPS_JIRA_BASE_URL must not contain credentials/);
  });
  withConfig({ TESTOPS_JIRA_BASE_URL: 'http://jira.example.test' }, () => {
    assert.throws(loadConfig, /TESTOPS_JIRA_BASE_URL must use https/);
  });
  withConfig({ TESTOPS_JIRA_BASE_URL: 'not-a-url' }, () => {
    assert.throws(loadConfig, /TESTOPS_JIRA_BASE_URL must be a valid URL/);
  });
  withConfig({ TESTOPS_JIRA_BASE_URL: 'https://jira.example.test/browse?a=1' }, () => {
    assert.throws(
      loadConfig,
      /TESTOPS_JIRA_BASE_URL must not contain credentials, query, or fragment/,
    );
  });
});

function withConfig(
  overrides: Partial<Record<(typeof CONFIG_KEYS)[number], string | undefined>>,
  callback: () => void,
): void {
  const previous = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]));
  const defaults: Record<(typeof CONFIG_KEYS)[number], string | undefined> = {
    TESTOPS_BASE_URL: 'https://testops.example.test',
    TESTOPS_API_KEY: 'test-api-key',
    TESTOPS_PROJECT_ID: '23',
    TESTOPS_SSL_VERIFY: undefined,
    TESTOPS_IMPORT_ROOTS: undefined,
    TESTOPS_JIRA_BASE_URL: undefined,
  };

  try {
    for (const key of CONFIG_KEYS) {
      const value = key in overrides ? overrides[key] : defaults[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    callback();
  } finally {
    for (const key of CONFIG_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
