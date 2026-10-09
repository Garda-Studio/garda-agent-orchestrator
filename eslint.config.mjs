import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import legacyExplicitAny from './.eslint/legacy-explicit-any.json' with { type: 'json' };

const recommended = js.configs.recommended.rules;
const hardeningRuleNames = [
  'constructor-super',
  'for-direction',
  'getter-return',
  'no-async-promise-executor',
  'no-class-assign',
  'no-compare-neg-zero',
  'no-cond-assign',
  'no-const-assign',
  'no-constant-binary-expression',
  'no-dupe-args',
  'no-dupe-class-members',
  'no-dupe-else-if',
  'no-dupe-keys',
  'no-duplicate-case',
  'no-empty-character-class',
  'no-ex-assign',
  'no-func-assign',
  'no-global-assign',
  'no-import-assign',
  'no-invalid-regexp',
  'no-irregular-whitespace',
  'no-loss-of-precision',
  'no-misleading-character-class',
  'no-new-native-nonconstructor',
  'no-obj-calls',
  'no-self-assign',
  'no-setter-return',
  'no-shadow-restricted-names',
  'no-this-before-super',
  'no-unreachable',
  'no-unsafe-finally',
  'no-unsafe-negation',
  'no-useless-backreference',
  'require-yield',
  'use-isnan',
  'valid-typeof'
];

const hardeningRules = Object.fromEntries(
  hardeningRuleNames.map((ruleName) => [ruleName, recommended[ruleName] ?? 'error'])
);

export default [
  {
    ignores: [
      '.node-build/**',
      '.scripts-build/**',
      'coverage/**',
      'dist/**',
      'garda-agent-orchestrator/**',
      'node_modules/**'
    ]
  },
  {
    files: ['src/**/*.ts', 'tests/node/**/*.ts', 'scripts/node-foundation/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      parser: tseslint.parser,
      sourceType: 'module'
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      ...hardeningRules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off'
    }
  },
  {
    files: ['src/**/*.ts', 'tests/node/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', {
        vars: 'all',
        varsIgnorePattern: '^_',
        args: 'all',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true
      }]
    }
  },
  {
    files: legacyExplicitAny.files,
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
];
