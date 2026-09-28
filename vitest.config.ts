import { defineConfig } from 'vitest/config';

// Отдельно от vite.config.ts (там корень — web/ для сборки PWA).
export default defineConfig({
  test: {
    root: '.',
    include: ['test/**/*.test.ts'],
  },
});
