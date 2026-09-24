import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // contexto-chatgpt y .audit-*: copias y restos de una auditoria (fuera de
  // git), no es codigo del proyecto. El backend es JS de Node sin TypeScript.
  { ignores: ['dist', 'contexto-chatgpt', '.audit-*', 'backend'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Con las opciones por defecto esta regla revienta al cargar (la version
      // de typescript-eslint no casa con la de ESLint): `npm run lint` no
      // llegaba a mirar nada. Con las opciones explicitas funciona igual.
      '@typescript-eslint/no-unused-expressions': ['error', {
        allowShortCircuit: true,
        allowTernary: true,
        allowTaggedTemplates: false,
        enforceForJSX: false,
      }],
      // Hay cientos de `any` heredados: se avisan, no rompen el lint.
      '@typescript-eslint/no-explicit-any': 'warn',
      // `_algo` = sin usar a proposito (firmas que se conservan); un catch que
      // no mira el error tampoco es un fallo.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // `catch {}` vacio es intencionado aqui (localStorage, JSON de un error...).
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  }
);
