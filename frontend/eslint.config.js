import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

const FEATURES = ['hero', 'how-it-works', 'simulate', 'losses-chart']
const noClimb = { group: ['../*'], message: 'Use @/ imports instead of ../' }

// features never import each other or the app layer
const featureBoundaries = FEATURES.map((name) => ({
  files: [`src/features/${name}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: FEATURES.filter((f) => f !== name).flatMap((f) => [
              `@/features/${f}`,
              `@/features/${f}/**`,
            ]),
            message: 'Features never import other features. Compose them in src/app.',
          },
          { group: ['@/app', '@/app/**'], message: 'Features never import the app layer.' },
          noClimb,
        ],
      },
    ],
  },
}))

// shared code imports only shared code
const sharedBoundary = {
  files: ['src/{components,config,hooks,utils}/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@/features', '@/features/**', '@/app', '@/app/**'],
            message: 'Shared code imports only shared code.',
          },
          noClimb,
        ],
      },
    ],
  },
}

const appBoundary = {
  files: ['src/app/**/*.{ts,tsx}', 'src/main.tsx'],
  rules: { 'no-restricted-imports': ['error', { patterns: [noClimb] }] },
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  ...featureBoundaries,
  sharedBoundary,
  appBoundary,
])
