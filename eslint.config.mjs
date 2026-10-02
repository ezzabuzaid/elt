import nx from '@nx/eslint-plugin';

import personalConfig from './personal.eslint.config.mjs';

const testHookRestrictedSyntax = [
  {
    selector:
      'CallExpression[callee.name=/^(before|after|beforeEach|afterEach|beforeAll|afterAll)$/]',
    message:
      'No test lifecycle hooks. Write self-contained AAA tests: inline arrange in each test and run teardown (cleanup, mock restore, resource stop) in a per-test try/finally.',
  },
];

const enumRestrictedSyntax = [
  {
    selector: 'TSEnumDeclaration',
    message:
      'No TS enums — they need a runtime transform and break Node strip-only `.ts` execution (tsc/bundlers hide it). Use a `const` object + a union type instead.',
  },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Flat config never reads .gitignore, so build output and the bundled
    // plugin server are listed here.
    ignores: ['**/dist', '**/out-tsc', 'plugins/apple/server'],
  },
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [{ sourceTag: '*', onlyDependOnLibsWithTags: ['*'] }],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'error',
      'no-unused-private-class-members': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-empty': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/parameter-properties': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts'],
    ignores: ['**/*.test.ts', '**/*.test.cts', '**/*.test.mts'],
    rules: {
      'no-restricted-syntax': ['error', ...enumRestrictedSyntax],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.cts', '**/*.test.mts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...testHookRestrictedSyntax,
        ...enumRestrictedSyntax,
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.cts', '**/*.mts'],
    // A disable directive that no longer suppresses anything is an escape hatch
    // that outlived its reason.
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  ...personalConfig,
];
