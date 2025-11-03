// ESLint v9 flat config
const localPlugin = require('./eslint-local-rules');

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
	{
		files: ['**/*.js'],
		ignores: ['node_modules/', 'dist/', 'build/', '.git/'],
		languageOptions: {
			ecmaVersion: 2021,
			sourceType: 'commonjs'
		},
		plugins: {
			local: localPlugin
		},
		rules: {
			// Keep console usage allowed for this project
			'no-console': 'off',
			// Ensure a blank line before and after any block-like statement
			'padding-line-between-statements': [
				'error',
				{ blankLine: 'always', prev: '*', next: 'block-like' },
				{ blankLine: 'always', prev: 'block-like', next: '*' }
			],
			// Turn off core one-var to avoid merging across blank lines
			'one-var': 'off',
			// When multiple declarators exist in a single declaration, put each on its own line
			'one-var-declaration-per-line': ['error', 'always'],
			// Merge only when no blank line separates declarations
			'local/magnetic-vars': 'error'
		}
	}
];
