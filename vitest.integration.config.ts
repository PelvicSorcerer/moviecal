import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // MOV-382: dispatcher tests can never resolve the live state/log locations.
    setupFiles: ['tools/dispatcher/test/setup-isolated-state.mjs'],
    include: ['test/**/*.integration.test.*', 'tools/dispatcher/test/**/*.integration.test.*'],
  },
});
