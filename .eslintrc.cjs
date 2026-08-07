/* eslint-env node */
require('@rushstack/eslint-patch/modern-module-resolution')

module.exports = {
  root: true,
  env: {
    node: true,
  },
  plugins: ['import'],
  extends: [
    'plugin:vue/vue3-essential',
    'eslint:recommended',
    '@vue/eslint-config-typescript',
    '@vue/eslint-config-prettier',
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    // Typed linting: required by @typescript-eslint/consistent-type-imports
    // and other type-aware rules. Source files are covered by the two
    // project tsconfigs; config files are ignored (see ignorePatterns).
    project: ['./tsconfig.node.json', './tsconfig.web.json'],
    tsconfigRootDir: __dirname,
    extraFileExtensions: ['.vue'],
  },
  rules: {
    // 强制 import 顺序
    'import/order': [
      'error',
      {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true },
      },
    ],
    // Vue
    'vue/multi-word-component-names': 'off',
    'vue/component-name-in-template-casing': ['error', 'PascalCase'],
    // TS
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/consistent-type-imports': [
      'error',
      { fixStyle: 'inline-type-imports' },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
  },
  overrides: [
    {
      // renderer 严禁 import Node 内置和 electron
      files: ['src/renderer/**'],
      rules: {
        // Note: ESLint 8.57 patterns schema does not support `allowTypeImports`
        // (added in ESLint 9). Type-only imports of these modules are not blocked
        // here; renderer's tsconfig + verbatimModuleSyntax keep that path clean.
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['electron', 'node:*', 'better-sqlite3', '@main/*', '@preload/*'],
                message: 'Renderer cannot import Node/main/preload. Use IPC via window.api.',
              },
            ],
          },
        ],
      },
    },
    {
      // .vue files cannot be part of a TS program (tsc filters by .ts/.tsx/.js
      // extensions), so typescript-eslint cannot generate parserServices for
      // them — which @typescript-eslint/consistent-type-imports requires on
      // rule load. Disable the rule for .vue only; it still applies to all
      // .ts/.tsx files. See antfu/eslint-config#570, nuxt/eslint#388.
      files: ['*.vue'],
      rules: {
        '@typescript-eslint/consistent-type-imports': 'off',
      },
    },
  ],
  ignorePatterns: [
    'out/',
    'dist/',
    'node_modules/',
    '*.config.*',
    '.eslintrc.cjs',
    // PoC 验证脚本是独立 .mjs，import SDK 但不在 tsconfig project 里，
    // typed-linting 会崩（parserServices 缺失）。它们不走项目类型/lint 流水线。
    'poc/',
    // 构建期脚本（electron-builder 的 afterPack hook 等）同理：CommonJS，
    // 只被 electron-builder 用 require() 加载，不属于 app 的两个 tsconfig project。
    'scripts/',
    'src/renderer/src/auto-imports.d.ts',
    'src/renderer/src/components.d.ts',
  ],
}
