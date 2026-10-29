import tseslint from 'typescript-eslint';

/**
 * The type-checked recommended rules, reported as warnings for now: the code base doesn't pass them
 * yet. Promote a rule to `error` once its count reaches 0.
 */
const recommendedAsWarnings = tseslint.configs.recommendedTypeChecked.map((config) =>
  config.rules
    ? {
        ...config,
        rules: Object.fromEntries(
          Object.entries(config.rules).map(([rule, setting]) => [
            rule,
            (Array.isArray(setting) ? setting[0] : setting) === 'error'
              ? Array.isArray(setting)
                ? ['warn', ...setting.slice(1)]
                : 'warn'
              : setting,
          ]),
        ),
      }
    : config,
);

const paddingRules = [
  // blank line before return
  { blankLine: 'always', prev: '*', next: 'return' },
  // blank line before and after if blocks
  { blankLine: 'always', prev: '*', next: 'if' },
  { blankLine: 'always', prev: 'if', next: '*' },
  // blank line before and after loops
  { blankLine: 'always', prev: '*', next: ['for', 'while', 'do'] },
  { blankLine: 'always', prev: ['for', 'while', 'do'], next: '*' },
  // blank line after a variable-declaration block when followed by non-declaration code
  { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
  { blankLine: 'always', prev: '*', next: ['const', 'let', 'var'] },
  // consecutive declarations stay together (no blank line required between them)
  { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'scripts/**', 'tests/test-*/**'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: recommendedAsWarnings,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // All if / else / loop bodies must use braces
      curly: ['error', 'all'],

      // Blank lines around control-flow blocks and before return
      'padding-line-between-statements': ['error', ...paddingRules],
    },
  },
  {
    // Tests follow the same layout, reported as warnings until they are formatted
    files: ['tests/**/*.ts'],
    rules: {
      curly: ['warn', 'all'],
      'padding-line-between-statements': ['warn', ...paddingRules],
    },
  },
);
