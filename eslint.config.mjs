import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import nextEslintPlugin from 'eslint-config-next';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.next', '.turbo', 'node_modules', 'dist', 'build', 'out', 'dist-desktop', 'backend'],
  },
  {
    // Electron main / preload run as CommonJS in Node.
    files: ['electron/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  nextEslintPlugin,
  eslintConfigPrettier,
  {
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  }
);
