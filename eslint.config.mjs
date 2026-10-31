import nx from '@nx/eslint-plugin';
import zukhruf from '@zukhruf/eslint';
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
