import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'tests/**', 'scripts/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    rules: {
      // All if / else / loop bodies must use braces
      curly: ['error', 'all'],

      // Blank lines around control-flow blocks and before return
      'padding-line-between-statements': [
        'error',
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
      ],
    },
  },
);
