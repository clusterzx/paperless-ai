import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3457);

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npm run build:web && tsx e2e/demo-server.ts`,
    url: `http://127.0.0.1:${port}/health`,
    env: { DEMO_FRESH: '1', DEMO_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
