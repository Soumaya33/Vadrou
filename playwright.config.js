// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 1,
  workers: 1,
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
  // Chromium uniquement — WebKit non disponible sur ubuntu-latest sans install complète
  projects: [
    {
      name: 'Mobile Chrome (Android)',
      use: {
        ...require('@playwright/test').devices['Pixel 7'],
      },
    },
  ],
});
