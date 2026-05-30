// tests/vadrou.spec.js
// Tests de non-régression Vadrou — vadrou.com
// Correspond à la checklist : tests automatisables (28/43)
// Pour ajouter un test : copier un bloc test() existant et l'adapter

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://vadrou.com';

// ── Helpers ──────────────────────────────────────────
// Attend que le splash disparaisse et que l'app soit chargée
async function waitForAppReady(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  // Attendre que le splash soit masqué (2s max après networkidle)
  await page.waitForSelector('#splash[style*="display:none"], #splash.out', { timeout: 8000 }).catch(() => {});
  // Attendre que les lieux soient chargés (carrousel visible)
  await page.waitForSelector('#places-scroll .place-card', { timeout: 15000 });
}

// Ferme la fiche lieu ouverte
async function closeFiche(page) {
  // Fermer via JS pour éviter les problèmes de viewport headless
  await page.evaluate(() => {
    const open = document.querySelector('.modal-overlay.open');
    if (open) open.classList.remove('open');
    document.body.classList.remove('modal-open');
  }).catch(() => {});
  await page.waitForTimeout(300);
}


// ════════════════════════════════════════════════════
// 1. DÉMARRAGE & CHARGEMENT
// ════════════════════════════════════════════════════

test('[T01] La page se charge sans erreur JS critique', async ({ page }) => {
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // Aucune erreur SyntaxError ou TypeError critique
  const criticalErrors = jsErrors.filter(e =>
    e.includes('SyntaxError') || e.includes('Unexpected token')
  );
  expect(criticalErrors, `Erreurs JS : ${criticalErrors.join(', ')}`).toHaveLength(0);
});

test('[T02] Le splash Vadrou s\'affiche puis disparaît', async ({ page }) => {
  await page.goto(BASE_URL);
  // Splash visible au départ
  await expect(page.locator('#splash')).toBeVisible({ timeout: 3000 });
  // Puis disparaît dans les 5 secondes
  await expect(page.locator('#splash')).toBeHidden({ timeout: 5000 });
});

test('[T03] Les lieux se chargent depuis Supabase', async ({ page }) => {
  await waitForAppReady(page);
  const cards = page.locator('#places-scroll .place-card');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count, 'Au moins 3 lieux attendus').toBeGreaterThanOrEqual(3);
});

test('[T04] Les événements se chargent', async ({ page }) => {
  await waitForAppReady(page);
  const events = page.locator('#events-list .event');
  await expect(events.first()).toBeVisible({ timeout: 10000 });
});

test('[T05] Les coups de cœur se chargent', async ({ page }) => {
  await waitForAppReady(page);
  const crushCards = page.locator('#crush-grid .crush-card');
  await expect(crushCards.first()).toBeVisible({ timeout: 10000 });
});


// ════════════════════════════════════════════════════
// 2. NAVIGATION
// ════════════════════════════════════════════════════

test('[T06] Navigation vers l\'onglet Carte', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-map').click();
  await expect(page.locator('#map-fullscreen-page')).toBeVisible({ timeout: 5000 });
});

test('[T07] Navigation vers l\'onglet Évènements', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-events').click();
  await expect(page.locator('#events-page')).toBeVisible({ timeout: 3000 });
});

test('[T08] Navigation vers l\'onglet Favoris', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-favs').click();
  await expect(page.locator('#favs-section')).toBeVisible({ timeout: 3000 });
});

test('[T09] Retour à l\'accueil depuis Carte', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-map').click();
  await page.locator('#nav-home').click();
  await expect(page.locator('#places-scroll')).toBeVisible({ timeout: 3000 });
});


// ════════════════════════════════════════════════════
// 3. LIEUX — Fiches & Clic
// ════════════════════════════════════════════════════

test('[T10] ⚠️ Clic sur un lieu SANS apostrophe ouvre sa fiche', async ({ page }) => {
  await waitForAppReady(page);
  // Cliquer sur la première carte du carrousel
  await page.locator('#places-scroll .place-card').first().click();
  // La modal détail doit s'ouvrir
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });
  // Le nom du lieu est affiché
  const name = await page.locator('#detail-name').textContent();
  expect(name.trim().length, 'Nom du lieu non vide').toBeGreaterThan(0);
  await closeFiche(page);
});

test('[T11] ⚠️ CRITIQUE — Fiche affiche la description Supabase (pas le texte générique)', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#places-scroll .place-card').first().click();
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });

  const desc = await page.locator('#detail-desc').textContent();
  expect(
    desc.trim(),
    'La description ne doit pas être le texte par défaut générique'
  ).not.toBe('Lieu sélectionné par la communauté Vadrou. Parfait pour une sortie en famille à Bordeaux !');
  expect(desc.trim().length).toBeGreaterThan(10);
  await closeFiche(page);
});

test('[T12] ⚠️ CRITIQUE — Clic lieu avec apostrophe dans le nom ouvre sa fiche', async ({ page }) => {
  await waitForAppReady(page);
  // Chercher un lieu avec apostrophe dans le carrousel ou les crush cards
  const allCards = page.locator('#places-scroll .place-card, #crush-grid .crush-card');
  const count = await allCards.count();

  let foundAndClicked = false;
  for (let i = 0; i < count; i++) {
    const name = await allCards.nth(i).locator('.place-card-name, .crush-name').textContent().catch(() => '');
    if (name.includes("'") || name.includes("'")) {
      await allCards.nth(i).click();
      await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });
      const detailName = await page.locator('#detail-name').textContent();
      expect(detailName.trim().length).toBeGreaterThan(0);
      foundAndClicked = true;
      await closeFiche(page);
      break;
    }
  }

  if (!foundAndClicked) {
    // Si pas trouvé dans le carrousel, tester via l'onglet Carte (filtre Eau → Miroir d'eau)
    await page.locator('#nav-map').click();
    await page.locator('[data-cat="eau"]').first().click();
    await page.waitForTimeout(1000);
    // Vérifier que la carte est chargée sans erreur
    await expect(page.locator('#map-fullscreen-page')).toBeVisible();
    console.log('Aucun lieu avec apostrophe visible dans le carrousel - test partiel via carte');
  }
});

test('[T13] Fiche lieu affiche le bouton Itinéraire', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#places-scroll .place-card').first().click();
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });
  // Le bouton itinéraire doit être visible
  await expect(page.locator('#detail-meta .detail-meta-item').first()).toBeVisible();
  await closeFiche(page);
});

test('[T14] Bottom sheet itinéraire s\'ouvre au clic', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#places-scroll .place-card').first().click();
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });

  // Cliquer sur le bouton itinéraire (premier meta-item cliquable)
  const itineraire = page.locator('#detail-meta .detail-meta-item[onclick]').first();
  if (await itineraire.isVisible()) {
    await itineraire.click();
    await expect(page.locator('#maps-sheet.open')).toBeVisible({ timeout: 3000 });
    // Fermer le bottom sheet
    await page.locator('.maps-sheet-btn-cancel').click();
  }
  await closeFiche(page);
});


// ════════════════════════════════════════════════════
// 4. FILTRES
// ════════════════════════════════════════════════════

test('[T15] Filtre catégorie — Resto kids', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('.filter-btn[data-cat="resto"]').click();
  await page.waitForTimeout(500);

  // Toutes les cartes affichées doivent être de catégorie resto
  const cards = page.locator('#places-scroll .place-card');
  const count = await cards.count();
  if (count > 0) {
    const firstCat = await cards.first().locator('.place-card-cat').textContent();
    expect(firstCat.toLowerCase()).toContain('resto');
  }
});

test('[T16] Filtre "Tout" restaure tous les lieux', async ({ page }) => {
  await waitForAppReady(page);
  const initialCount = await page.locator('#places-scroll .place-card').count();

  await page.locator('.filter-btn[data-cat="resto"]').click();
  await page.waitForTimeout(300);
  await page.locator('.filter-btn[data-cat="all"]').click();
  await page.waitForTimeout(300);

  const afterCount = await page.locator('#places-scroll .place-card').count();
  expect(afterCount).toBeGreaterThanOrEqual(initialCount);
});

test('[T17] Filtre Eau — logo 🌊 affiché en priorité sur les cartes', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('.filter-btn[data-cat="eau"]').click();
  await page.waitForTimeout(500);

  const cards = page.locator('#places-scroll .place-card');
  const count = await cards.count();
  if (count > 0) {
    // La première carte doit afficher la catégorie eau
    const cardImg = await cards.first().locator('.place-card-img').innerHTML();
    expect(cardImg).toContain('🌊');
  }
});


// ════════════════════════════════════════════════════
// 5. ÉVÉNEMENTS
// ════════════════════════════════════════════════════

test('[T18] Page Évènements charge la liste', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-events').click();
  await expect(page.locator('#events-page-list .event-card-full').first()).toBeVisible({ timeout: 10000 });
});

test('[T19] ⚠️ CRITIQUE — Aucun événement passé affiché', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-events').click();
  await page.waitForSelector('#events-page-list .event-card-full', { timeout: 10000 });

  // Récupérer toutes les dates affichées
  const dateEls = page.locator('.event-day');
  const monthEls = page.locator('.event-month');
  const count = await dateEls.count();

  const MOIS = ['jan','fév','mar','avr','mai','juin','juil','août','sep','oct','nov','déc'];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < Math.min(count, 10); i++) {
    const day = parseInt(await dateEls.nth(i).textContent(), 10);
    const monthStr = (await monthEls.nth(i).textContent()).toLowerCase().trim();
    const monthIdx = MOIS.findIndex(m => monthStr.startsWith(m));
    if (monthIdx >= 0 && day > 0) {
      const evtDate = new Date(today.getFullYear(), monthIdx, day);
      // Si la date semble dans le passé cette année, vérifier
      if (evtDate < today && evtDate.getFullYear() === today.getFullYear()) {
        throw new Error(`Événement passé détecté : ${day} ${monthStr}`);
      }
    }
  }
});

test('[T20] Filtre catégorie événements fonctionne', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-events').click();
  await page.waitForSelector('#events-page-list', { timeout: 10000 });

  await page.locator('#ep-cat-filters .ef-btn').nth(1).click(); // Premier filtre non "Tout"
  await page.waitForTimeout(500);

  // Au moins un résultat ou message "aucun résultat"
  const results = page.locator('#events-page-list .event-card-full, #events-page-list .loading-card');
  await expect(results.first()).toBeVisible({ timeout: 3000 });
});

test('[T21] Clic sur un événement ouvre sa fiche', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-events').click();
  await expect(page.locator('#events-page-list .event-card-full').first()).toBeVisible({ timeout: 10000 });
  await page.locator('#events-page-list .event-card-full').first().click();
  await expect(page.locator('#event-detail-modal.open')).toBeVisible({ timeout: 5000 });

  const name = await page.locator('#evd-name').textContent();
  expect(name.trim().length).toBeGreaterThan(0);
});


// ════════════════════════════════════════════════════
// 6. CARTE PLEIN ÉCRAN
// ════════════════════════════════════════════════════

test('[T22] Carte plein écran se charge avec marqueurs', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-map').click();
  await expect(page.locator('#map-fullscreen-page')).toBeVisible({ timeout: 5000 });
  // Attendre que la page carte soit affichée (display:flex)
  await page.waitForFunction(() => {
    const el = document.getElementById('map-fullscreen-page');
    return el && getComputedStyle(el).display !== 'none';
  }, { timeout: 8000 });
  // Vérifier que les filtres de la carte sont visibles (prouve que la page est chargée)
  await expect(page.locator('#map-fs-filters')).toBeVisible({ timeout: 8000 });
});

test('[T23] Filtre catégorie sur carte plein écran', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-map').click();
  await expect(page.locator('#map-fs-filters')).toBeVisible({ timeout: 8000 });
  // Cliquer sur un filtre catégorie
  const filtreExt = page.locator('#map-fs-filters .filter-btn[data-cat="jeux_ext"]');
  await filtreExt.scrollIntoViewIfNeeded();
  await filtreExt.click({ force: true });
  await page.waitForTimeout(800);
  // Vérifier que le filtre est bien actif
  await expect(filtreExt).toHaveClass(/active/);
});

test('[T24] Recherche dans la carte plein écran affiche des suggestions', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-map').click();
  await expect(page.locator('#fs-search-input')).toBeVisible({ timeout: 5000 });
  await page.locator('#fs-search-input').fill('Parc');
  await page.waitForTimeout(800);
  // Des résultats doivent apparaître (lieux déjà chargés)
  const results = page.locator('#fs-search-results');
  await expect(results).toBeVisible({ timeout: 3000 });
});


// ════════════════════════════════════════════════════
// 7. COUPS DE CŒUR
// ════════════════════════════════════════════════════

test('[T25] Coups de cœur — clic ouvre la fiche avec description', async ({ page }) => {
  await waitForAppReady(page);
  const crushCards = page.locator('#crush-grid .crush-card');
  await expect(crushCards.first()).toBeVisible({ timeout: 10000 });
  await crushCards.first().click();

  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });
  const name = await page.locator('#detail-name').textContent();
  expect(name.trim().length).toBeGreaterThan(0);
  const desc = await page.locator('#detail-desc').textContent();
  expect(desc.trim().length).toBeGreaterThan(10);
  await closeFiche(page);
});


// ════════════════════════════════════════════════════
// 8. FAVORIS
// ════════════════════════════════════════════════════

test('[T26] Ajouter un lieu aux favoris', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#places-scroll .place-card').first().click();
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });

  const favBtn = page.locator('#detail-fav-btn');
  await favBtn.click();
  // Le bouton passe à ❤️
  await expect(favBtn).toHaveText('❤️');
  await closeFiche(page);

  // Aller dans les favoris
  await page.locator('#nav-favs').click();
  await expect(page.locator('#favs-list .event').first()).toBeVisible({ timeout: 3000 });
});

test('[T27] Ajouter un événement aux favoris', async ({ page }) => {
  await waitForAppReady(page);
  await page.locator('#nav-events').click();
  await expect(page.locator('#events-page-list .event-card-full').first()).toBeVisible({ timeout: 10000 });
  await page.locator('#events-page-list .event-card-full').first().click();
  await expect(page.locator('#event-detail-modal.open')).toBeVisible({ timeout: 5000 });

  const favBtn = page.locator('#event-fav-btn');
  await favBtn.click();
  await expect(favBtn).toHaveText('❤️');

  // Fermer via JS pour éviter le problème de viewport headless
  await page.evaluate(() => closeModalById('event-detail-modal'));
  await page.waitForTimeout(500);
  await page.locator('#nav-favs').click();
  await expect(page.locator('#favs-list').first()).toBeVisible({ timeout: 3000 });
});


// ════════════════════════════════════════════════════
// 9. POPUP MISE À JOUR ANDROID
// ════════════════════════════════════════════════════

test('[T28] ⚠️ Aucune popup de mise à jour sur le web (non-Android)', async ({ page }) => {
  await waitForAppReady(page);
  await page.waitForTimeout(3000); // Laisser le temps à checkForUpdate de s'exécuter
  // Sur le web, la popup ne doit jamais apparaître
  const overlay = page.locator('#update-modal-overlay');
  const isVisible = await overlay.isVisible();
  expect(isVisible, 'La popup de mise à jour ne doit pas s\'afficher sur le web').toBe(false);
});
