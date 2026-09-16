// Configuration ESLint minimale (flat config) : JavaScript sans build, chargé tel quel par le navigateur.
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Le script de contenu n'est pas un module : Chrome ne charge pas les content scripts en ESM.
    files: ['src/content.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.mjs', 'vitest.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Ces scripts évaluent aussi du code DANS la page ou le service worker (`chrome`).
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
    },
  },
];
