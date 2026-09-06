import { defineConfig } from 'vitest/config';

// `tsc` emits main and preload into dist/. Without this, vitest would also collect any
// compiled copy that lands there and run each test twice.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
