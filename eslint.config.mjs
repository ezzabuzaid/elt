import nx from '@nx/eslint-plugin';
import zukhruf from '@zukhruf/eslint';
import modernNode from '@zukhruf/eslint/modern-node';
import island, {
  islandConstraint,
  manifest,
  moduleBoundaries,
} from '@zukhruf/eslint/nx';
import react from '@zukhruf/eslint/react';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  nx.configs['flat/base'],
  nx.configs['flat/typescript'],
  nx.configs['flat/javascript'],
  {
    // Flat config never reads .gitignore, so build output and the local
    // measurement scripts in outputs/ are listed here.
    ignores: ['**/dist', '**/out-tsc', 'outputs/**'],
  },
  // The React preset comes before the zukhruf configs, so base's changes to
  // third-party rules win.
  { files: ['apps/web/**'], extends: [react] },
  {
    plugins: { zukhruf, island, manifest },
    extends: [
      'zukhruf/base',
      'zukhruf/tests',
      'zukhruf/diagnostics',
      'zukhruf/react',
      'island/recommended',
      'manifest/recommended',
    ],
    // Every package is agnostic of its host: it reads no process.env and
    // writes no console.
    settings: { island: { libraries: ['packages/**/*.ts'] } },
    rules: {
      'manifest/dependency-checks': [
        'error',
        // apps/web's Vite config builds the frontend; it never ships.
        { ignoredFiles: ['{projectRoot}/frontend/vite.config.mts'] },
      ],
    },
  },
  {
    // Code that runs in a browser stays out: MDN marks Error.isError "Limited
    // availability", so a fix there can throw. The frontend also imports
    // contract.ts at run time, so Vite bundles that file too.
    ignores: ['apps/web/frontend/src/**', 'apps/web/src/contract.ts'],
    plugins: { 'modern-node': modernNode },
    extends: ['modern-node/recommended'],
  },
  {
    // These published packages declare engines.node >=24, and Node 24 has no
    // Uint8Array.prototype.toHex.
    files: [
      'packages/elt/**',
      'packages/destinations/sqlite/**',
      'packages/embedding/**',
      'packages/sdks/microsoft/sql-server/**',
      'packages/sources/microsoft/sql-server/**',
    ],
    rules: { 'unicorn/prefer-uint8array-hex': 'off' },
  },
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        moduleBoundaries({
          depConstraints: [
            // The hosts here (apps/google, apps/proactive) bring no runtime of
            // their own that an island could import.
            islandConstraint([]),
            // An SDK speaks one vendor store or API and knows nothing of the
            // pipeline: no path from it may reach elt, so no source or
            // destination either (Nx checks this transitively).
            { sourceTag: 'layer:sdk', notDependOnLibsWithTags: ['layer:elt'] },
            // A codec speaks one format and knows no store, so it builds
            // only on other formats.
            {
              sourceTag: 'layer:codec',
              onlyDependOnLibsWithTags: ['layer:codec'],
            },
          ],
        }),
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx,cts,mts,js,jsx,cjs,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@deepagents/agent', '@deepagents/agent/*'],
              message:
                '@deepagents/agent is legacy. Build with @deepagents/context + the AI SDK directly.',
            },
          ],
        },
      ],
    },
  },
  {
    // Braces on every if, else and loop body. Scoped to apps/web until the
    // rest of elt is converted.
    files: ['apps/web/**/*.{ts,tsx,mts}'],
    rules: { curly: ['error', 'all'] },
  },
  {
    // A stream's key is an identity its upstream enforces, and no source or SDK
    // dedupes rows: the scan fails on a repeat (packages/elt ADR 0022).
    files: ['packages/sdks/**/*.ts', 'packages/sources/**/*.ts'],
    ignores: ['**/*.test.ts', '**/src/test/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['TemplateElement[value.raw', 'Literal[value'].flatMap((node) => [
          {
            selector: `${node}=/\\bSELECT\\s+DISTINCT\\b/i]`,
            message:
              'SELECT DISTINCT hides the rows that the store repeats. Read every row, and key the stream by an identity that the store enforces (packages/elt ADR 0022).',
          },
          {
            selector: `${node}=/\\b(UNION|INTERSECT|EXCEPT)\\b(?!\\s+ALL\\b)/]`,
            message:
              'UNION, INTERSECT and EXCEPT without ALL drop repeated rows. Use the ALL form, and key the stream by an identity that the store enforces (packages/elt ADR 0022).',
          },
        ]),
        {
          selector: [
            'FunctionDeclaration > Identifier.id',
            'VariableDeclarator[init.type=/FunctionExpression$/] > Identifier.id',
            'ImportSpecifier > Identifier.imported',
          ]
            .map(
              (node) =>
                `${node}[name=/^(uniq|unique|dedupe?|distinct)(By|With)?$/i]`,
            )
            .concat('ImportDeclaration[source.value=/(^|[./])uniq/]')
            .join(', '),
          message:
            'A dedupe helper drops the rows that the store repeats. Key the stream by an identity that the store enforces, and let the scan fail on a repeat (packages/elt ADR 0022).',
        },
      ],
    },
  },
  {
    // The pre-commit hook script, which no tsconfig includes; typed lint gives
    // it the default project instead of a parse error.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['.husky/*.ts'] },
      },
    },
  },
);
