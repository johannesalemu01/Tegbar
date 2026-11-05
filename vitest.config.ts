import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests must not depend on the developer's machine time zone.
    env: { TZ: 'America/Los_Angeles' },
  },
});
