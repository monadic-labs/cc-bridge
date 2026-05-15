import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  globalSetup: './global-setup.js',
  globalTeardown: './global-teardown.js',
  // Per-test timeout. Boot + click-through fits comfortably in this budget.
  timeout: 60000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // Port matches setup-daemon.js PORT — kept literal so test workers
    // (separate processes from globalSetup) don't need env propagation.
    baseURL: 'http://localhost:9119',
    headless: true,
    actionTimeout: 8000,
    navigationTimeout: 15000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
