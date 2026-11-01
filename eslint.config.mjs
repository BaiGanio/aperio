// Aperio v2 lint configuration.
//
// Anti-pattern guards AP1-AP6 live here. AP7 (file size) and AP9 (duplicate
// basenames) are scripts under scripts/. AP8 (the WebSocket schema contract)
// arrives in step S2.11.
//
// Every `files` / `ignores` glob starts with `**/` on purpose. The guard test
// (T1.3) copies fixtures into a throwaway project directory and runs this same
// config there, so the patterns must match by path segment, not by repo root.

import js from '@eslint/js';
import noUnmarkedEmptyHandler from './eslint-rules/no-unmarked-empty-handler.js';
import noUnboundedModuleCache from './eslint-rules/no-unbounded-module-cache.js';
import requireApReasonOnDisable from './eslint-rules/require-ap-reason-on-disable.js';

/**
 * Node globals, written out instead of pulling in the `globals` package.
 * Lesson L-C07: keep the dependency list tiny so the audit gate stays cheap.
 */
const NODE_GLOBALS = Object.fromEntries(
  [
    'AbortController',
    'AbortSignal',
    'Buffer',
    'TextDecoder',
    'TextEncoder',
    'URL',
    'URLSearchParams',
    'clearInterval',
    'clearTimeout',
    'console',
    'crypto',
    'fetch',
    'performance',
    'process',
    'queueMicrotask',
    'setImmediate',
    'setInterval',
    'setTimeout',
    'structuredClone',
  ].map((name) => [name, 'readonly']),
);

/** Files allowed to read process.env: the config registry plus one Tier-0 file. */
const ENV_READERS = ['**/src/config/**/*.js', '**/src/boot/tier0-env.js'];

/** Provider names must only be compared inside the provider folder (AP2). */
const PROVIDER_NAMES = [
  'llamacpp',
  'ollama',
  'anthropic',
  'deepseek',
  'gemini',
  'claude-code',
  'codex',
  'openai',
];

const AP2_SELECTORS = [
  {
    selector: `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/^(${PROVIDER_NAMES.join('|')})$/]`,
    message: 'AP2: do not branch on a provider name. Ask src/providers/ for a capability.',
  },
  {
    selector: `SwitchCase > Literal[value=/^(${PROVIDER_NAMES.join('|')})$/]`,
    message: 'AP2: do not switch on a provider name. Ask src/providers/ for a capability.',
  },
];

const AP4_SELECTORS = [
  {
    selector: 'CallExpression[callee.name=/Sync$/]',
    message: 'AP4: a sync call blocks every socket. Use the async form, or move it to src/boot/.',
  },
  {
    selector: 'CallExpression[callee.property.name=/Sync$/]',
    message: 'AP4: a sync call blocks every socket. Use the async form, or move it to src/boot/.',
  },
];

const aperio = {
  rules: {
    'no-unmarked-empty-handler': noUnmarkedEmptyHandler,
    'no-unbounded-module-cache': noUnboundedModuleCache,
    'require-ap-reason-on-disable': requireApReasonOnDisable,
  },
};

export default [
  {
    name: 'aperio/ignores',
    ignores: [
      '**/node_modules/**',
      '**/coverage/**',
      '**/var/**',
      '**/docs/**',
      // Plans, audits and old proof-of-concept scripts, not v2 source.
      '**/trash/**',
      // Planted violations. The guard test lints these on purpose, in a copy.
      '**/tests/guards/fixtures/**',
    ],
  },

  {
    name: 'aperio/base',
    files: ['**/*.js', '**/*.mjs'],
    plugins: { aperio },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'aperio/require-ap-reason-on-disable': 'error',
    },
  },

  // AP5 - empty catch block / empty .catch() handler.
  // AP6 - module-level cache with no size limit.
  {
    name: 'aperio/ap5-ap6',
    files: ['**/src/**/*.js'],
    rules: {
      'aperio/no-unmarked-empty-handler': 'error',
      'aperio/no-unbounded-module-cache': 'error',
    },
  },

  // AP1 - only the config registry (and one Tier-0 file) reads process.env.
  {
    name: 'aperio/ap1-env',
    files: ['**/src/**/*.js'],
    ignores: ENV_READERS,
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'AP1: read configuration through src/config/, never process.env here.',
        },
      ],
    },
  },

  // AP2 - callers ask for a capability, never a provider name.
  // AP4 - sync fs blocks every socket. Boot code only.
  //
  // Both guards use `no-restricted-syntax`, and in flat config the last block
  // that sets a rule replaces it outright. So the selectors are grouped by
  // which folders are exempt, never split across two blocks for the same file.
  {
    name: 'aperio/ap2-ap4',
    files: ['**/src/**/*.js'],
    ignores: ['**/src/providers/**/*.js', '**/src/boot/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error', ...AP2_SELECTORS, ...AP4_SELECTORS],
    },
  },
  {
    name: 'aperio/ap4-only-in-providers',
    files: ['**/src/providers/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error', ...AP4_SELECTORS],
    },
  },
  {
    name: 'aperio/ap2-only-in-boot',
    files: ['**/src/boot/**/*.js'],
    rules: {
      'no-restricted-syntax': ['error', ...AP2_SELECTORS],
    },
  },

  // AP3 - tools never touch raw fs. They go through gatedRead / gatedWrite.
  {
    name: 'aperio/ap3-raw-fs',
    files: ['**/src/tools/**/*.js', '**/src/mcp/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'AP3: use gatedRead / gatedWrite from src/files/paths.js.' },
            { name: 'node:fs', message: 'AP3: use gatedRead / gatedWrite from src/files/paths.js.' },
            { name: 'fs/promises', message: 'AP3: use gatedRead / gatedWrite from src/files/paths.js.' },
            { name: 'node:fs/promises', message: 'AP3: use gatedRead / gatedWrite from src/files/paths.js.' },
          ],
        },
      ],
    },
  },

  // Tests and tooling run off the request path.
  {
    name: 'aperio/tooling',
    files: ['**/tests/**/*.js', '**/scripts/**/*.mjs', '**/eslint-rules/**/*.js'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
