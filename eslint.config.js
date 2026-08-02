import js from '@eslint/js'
import eslintReact from '@eslint-react/eslint-plugin'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  {
    ignores: ['dist', 'reference', 'referencejs'],
  },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: eslintReact.configs.recommended.settings,
    plugins: {
      ...eslintReact.configs.recommended.plugins,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...eslintReact.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // This project is built on React Three Fiber / Three.js, so many JSX props are
      // renderer-specific scene graph properties rather than DOM attributes.
      '@eslint-react/dom-no-unknown-property': 'off',
      '@eslint-react/dom-no-unsafe-target-blank': 'off',
      // Keep eslint-plugin-react-hooks as the single owner of hook diagnostics.
      '@eslint-react/error-boundaries': 'off',
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/purity': 'off',
      '@eslint-react/rules-of-hooks': 'off',
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/set-state-in-render': 'off',
      '@eslint-react/static-components': 'off',
      '@eslint-react/unsupported-syntax': 'off',
      '@eslint-react/use-memo': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // These React Compiler diagnostics are noisy for mutable Three.js objects.
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
]
