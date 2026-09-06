import { defineConfig } from 'vitest/config';

/** The `@/` alias the app uses, so tests import the same way the source does. */
export default defineConfig({
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
