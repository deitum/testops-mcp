import js from '@eslint/js';
import vitest from '@vitest/eslint-plugin';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importPlugin from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', 'coverage'],
  },

  js.configs.recommended,
  tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,

  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // The `.mjs` config and scripts are not part of the TS program, but we
        // still want them linted.
        projectService: { allowDefaultProject: ['*.mjs', 'scripts/*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver()],
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      eqeqeq: ['error', 'allow-null'],
      'dot-notation': 'error',
      'linebreak-style': ['error', 'unix'],
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      radix: 'error',

      'import-x/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: true,
          peerDependencies: true,
          optionalDependencies: false,
        },
      ],
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      // `npm run typecheck` resolves every import through the compiler, which —
      // unlike this rule's resolver — reads the MCP SDK's exports map
      // (`@modelcontextprotocol/sdk/server/mcp.js`) the way NodeNext does.
      'import-x/no-unresolved': 'off',
    },
  },

  {
    files: ['src/**/*.test.ts'],
    ...vitest.configs.recommended,
  },

  {
    // `tseslint` and `eslint-plugin-import-x` are CommonJS namespaces whose
    // members are meant to be reached through the default import, which is what
    // this file does.
    files: ['eslint.config.mjs'],
    rules: { 'import-x/no-named-as-default-member': 'off' },
  },

  // Must stay last: turns off every rule that would fight Prettier.
  prettier,
);
