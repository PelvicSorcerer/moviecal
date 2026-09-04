import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.*', 'tools/dispatcher/test/**/*.test.*'],
    exclude: ['test/**/*.integration.test.*', 'test/**/*.real-stack.test.*'],
  },
});
