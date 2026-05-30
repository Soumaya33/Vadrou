// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,           // 30s max par test
  retries: 1,               // 1 retry automatique en cas d'échec réseau
  workers: 1,               // Tests séquentiels (évite surcharge Supabase)
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],               // Affiche les résultats dans la console GitHub Actions
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://vadrou.com',
    headless: true,
    viewport: { width: 390, height: 844 }, // iPhone 14 Pro
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    screenshot: 'only-on-failure', // Screenshot auto si test échoue
    video: 'off',
  },
  projects: [
    {
      name: 'Mobile Chrome (Android)',
      use: {
        ...require('@playwright/test').devices['Pixel 7'],
      },
    },
    {
      name: 'Mobile Safari (iPhone)',
      use: {
        ...require('@playwright/test').devices['iPhone 14 Pro'],
      },
    },
  ],
});
