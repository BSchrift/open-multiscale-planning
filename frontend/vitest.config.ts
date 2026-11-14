import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Pure code runs under Node; anything that renders runs under jsdom. Test files go next to their code.
export default defineConfig({
  plugins: [react()],
  test: {
    // Off unless asked for, with `npx vitest run --coverage`. Every source file counts, so code no test loads shows as
    // uncovered rather than missing. There's no threshold: the numbers are for finding what's untested.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}'],
      reporter: ['text-summary', 'html', 'json-summary'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/core/**/*.test.ts', 'src/platform/**/*.test.ts', 'electron/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['src/ui/**/*.test.{ts,tsx}'],
          setupFiles: ['src/ui/app/test-setup.ts'],
        },
      },
    ],
  },
});
