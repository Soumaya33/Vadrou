// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  globalTimeout: 12 * 60 * 1000, // 12 min max pour tout le run
  retries: 1,
  workers: 4,
  forbidOnly: false,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://vadrou.com',
    headless: true,
    viewport: { width: 390, height: 844 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // Chromium uniquement — WebKit non disponible sur ubuntu-latest
  projects: [
    {
      name: 'Mobile Chrome (Android)',
      use: {
        ...require('@playwright/test').devices['Pixel 7'],
      },
    },
  ],
});
