// playwright.config.js
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  // Borne globale : même en cas de souci, le run ne peut pas s'éterniser
  // (33 tests x 30s x 2 essais / 4 workers => largement sous cette borne).
  globalTimeout: 12 * 60 * 1000, // 12 min max pour TOUT le run
  retries: 1,
  // Parallélisation : 4 workers au lieu de 1 -> ~4x plus rapide.
  // ubuntu-latest dispose de plusieurs vCPU ; Chromium headless mobile est léger.
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
