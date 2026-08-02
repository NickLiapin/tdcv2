// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    // ESLint is only for source TypeScript; meta-config files and generated
    // outputs are out of scope.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '**/generated/**',
      // Written by scripts/generate-quick-types.mjs: 3957 addresses, one
      // property each. Nothing in it is a style decision.
      '**/quick/addresses.ts',
      'eslint.config.mjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettierConfig,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Project-wide discipline per docs/vision/19-engineering-discipline.md:
      // no source file exceeds 1000 lines (blank lines and comments excluded).
      'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }],

      // `any` requires conscious justification via an eslint-disable comment.
      '@typescript-eslint/no-explicit-any': 'error',

      // Encourage explicit return types on exported API for documentation value.
      '@typescript-eslint/explicit-module-boundary-types': 'warn',

      // Allow unused args prefixed with `_` (common intent: "I know, kept for signature").
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Build scripts are plain ESM run by node, not part of the type-checked
    // project — the type-aware rules need a tsconfig they are deliberately not
    // in. They still get the core rules, which is the point of linting them.
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: false, project: false },
    },
  },
  {
    // Tests may be slightly more relaxed. Pattern uses `**/test/` so it
    // matches whether ESLint was invoked from the typescript/ workspace
    // or from the repo root (as lint-staged does).
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
