// tests/vadrou.spec.js
// Tests de non-régression Vadrou — vadrou.com
// Correspond à la checklist : tests automatisables (36/43)
// Pour ajouter un test : copier un bloc test() existant et l'adapter
//
// Nouveautés couvertes (juin 2026) :
//   T29 — Intégrité de l'encodage UTF-8 (anti-charabia)
//   T30 — Recherche "Proposer un lieu" (le bug Places d'origine)
//   T31 — Aucun toast de debug en prod (PLACES_DEBUG / UPDATE_DEBUG = false)
//   T32 — ID device persistant et stable (suivi des utilisateurs)
//   T33 — Favoris persistants après rechargement (ID device stable de bout en bout)
//   T34 — Géolocalisation "Me localiser" fonctionne
//   T35 — Responsive petit écran (iPhone SE — 375×667)
//   T36 — Responsive très petit écran (320×568)
//   T37 — Responsive tablette (768×1024)

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://vadrou.com';

// ── Helpers ──────────────────────────────────────────
// Attend que le splash disparaisse et que l'app soit chargée
async function waitForAppReady(page) {
  // Marque tout le trafic de test pour que l'app n'enregistre NI analytics NI device.
  // Doit être posé avant la navigation (s'applique aussi aux rechargements).
  await page.addInitScript(() => {
    try { localStorage.setItem('vadrou_is_test', '1'); } catch (e) {}
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // Attendre que le splash soit masqué (2s max après chargement)
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

// Vérifie qu'un élément ne déborde pas du viewport
async function isWithinViewport(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, reason: 'not found' };
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw + 2) return { ok: false, reason: `right edge ${Math.round(rect.right)}px > viewport ${vw}px` };
    if (rect.left < -2) return { ok: false, reason: `left edge ${Math.round(rect.left)}px < 0` };
    return { ok: true };
  }, selector);
}


// ════════════════════════════════════════════════════
// 1. DÉMARRAGE & CHARGEMENT
// ════════════════════════════════════════════════════

test('[T01] La page se charge sans erreur JS critique', async ({ page }) => {
  const jsErrors = [];
  page.on('pageerror', err => jsErrors.push(err.message));

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // Renforcé : on attrape aussi les ReferenceError et les références cassées
  // (fonction/variable inexistante) — typiques d'un fichier mal copié ou mal mergé.
  const criticalErrors = jsErrors.filter(e =>
    e.includes('SyntaxError') || e.includes('Unexpected token') ||
    e.includes('ReferenceError') || e.includes('is not defined') ||
    e.includes('is not a function')
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
    if (name.includes("'") || name.includes("\u2019")) {
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

test.skip('[T23] Filtre catégorie sur carte plein écran', async ({ page }) => {
  // Skippé : les filtres Leaflet ne sont pas accessibles en mode headless
  // À tester manuellement via la checklist
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


// ════════════════════════════════════════════════════
// 10. INTÉGRITÉ & NOUVELLES FONCTIONNALITÉS (juin 2026)
// ════════════════════════════════════════════════════

test('[T29] ⚠️ CRITIQUE — Intégrité de l\'encodage UTF-8 (anti-charabia)', async ({ page }) => {
  // Garde contre le double-encodage UTF-8 (emojis/accents transformés en "Ã°Å¸...").
  // C'est le bug qui avait rendu toute l'interface illisible.
  await waitForAppReady(page);

  const txt = await page.evaluate(() => document.body.innerText || '');

  // 1) Aucune séquence de double-encodage connue.
  //    (On cible des séquences précises — pas le simple "Â" qui est légitime dans "Âge".)
  const mojibake = /Ã©|Ã¨|Ã |Ã´|Ã§|Ã®|Ã¯|Ãª|Ã‰|Ã€|â€™|â€œ|â€\u009d|Å¸|Ã‚|ð\u0178/;
  const found = txt.match(mojibake);
  expect(found, `Charabia d'encodage détecté : "${found ? found[0] : ''}"`).toBeNull();

  // 2) Les accents et emojis de référence s'affichent correctement.
  expect(txt, 'L\'accent du sous-titre doit être correct').toContain('Métropole');
  expect(txt, 'L\'emoji repère doit être intact').toContain('📍');
});

test('[T30] ⚠️ CRITIQUE — Recherche "Proposer un lieu" ne reste pas bloquée', async ({ page }) => {
  // Le bug d'origine : la recherche restait figée sur "Recherche…".
  // Ici on vérifie qu'elle se résout TOUJOURS (résultats ou "Aucun résultat").
  //
  // Depuis l'ajout du FAB contextuel ("＋ Proposer un lieu"), le clic ouvre
  // directement #add-modal — il n'y a plus de #choice-modal intermédiaire
  // sur l'onglet Accueil/Carte.
  await waitForAppReady(page);

  await page.locator('#fab').click();
  await expect(page.locator('#add-modal.open')).toBeVisible({ timeout: 3000 });

  await page.locator('#place-search-input').fill('Parc');

  // La boîte de suggestions doit sortir de l'état "Recherche…" (résolution réussie).
  await page.waitForFunction(() => {
    const box = document.getElementById('place-suggestions');
    if (!box) return false;
    const t = (box.innerText || '').trim();
    return t.length > 0 && !t.includes('Recherche');
  }, { timeout: 12000 });

  const boxText = (await page.locator('#place-suggestions').innerText()).trim();
  expect(boxText, 'La recherche ne doit pas rester bloquée sur "Recherche…"').not.toContain('Recherche…');

  // Idéalement le proxy Places renvoie des résultats ; sinon, état résolu accepté.
  const items = await page.locator('#place-suggestions .place-suggestion-item').count();
  console.log(`[T30] suggestions de lieux trouvées : ${items}`);
});

test('[T31] ⚠️ Aucun toast de debug en production (flags désactivés)', async ({ page }) => {
  // Vérifie que PLACES_DEBUG et UPDATE_DEBUG sont bien à false :
  // aucun toast de diagnostic ne doit apparaître au démarrage.
  await waitForAppReady(page);
  await page.waitForTimeout(4000); // laisser fetchPlacePredictions / checkForUpdate s'exécuter

  const debugToast = page.locator('body > div').filter({
    hasText: /installé=|min=\d|config (vide|OK)|Places (HTTP|erreur|:)|RLS|repere/i,
  });
  await expect(debugToast, 'Un toast de debug est visible : PLACES_DEBUG/UPDATE_DEBUG doit être false').toHaveCount(0);
});

test('[T32] ID device persistant et stable après rechargement', async ({ page }) => {
  // Suivi des utilisateurs : un même appareil doit garder le même identifiant.
  await waitForAppReady(page);
  await page.waitForTimeout(1000);

  const id1 = await page.evaluate(() => localStorage.getItem('vadrou_device_id'));
  expect(id1, 'Un identifiant d\'appareil doit être créé').toBeTruthy();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#places-scroll .place-card', { timeout: 15000 });
  await page.waitForTimeout(1000);

  const id2 = await page.evaluate(() => localStorage.getItem('vadrou_device_id'));
  expect(id2, 'L\'identifiant doit rester identique après rechargement').toBe(id1);
});

test('[T33] Favoris persistants après rechargement (ID device stable de bout en bout)', async ({ page }) => {
  // Valide indirectement la stabilité de l'ID : si l'ID changeait, les favoris
  // (stockés côté Supabase par device) disparaîtraient au rechargement.
  await waitForAppReady(page);

  // Ajouter un lieu aux favoris
  await page.locator('#places-scroll .place-card').first().click();
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });
  const favBtn = page.locator('#detail-fav-btn');
  await favBtn.click();
  await expect(favBtn).toHaveText('❤️');
  await closeFiche(page);

  // Recharger (même contexte → même device id)
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#places-scroll .place-card', { timeout: 15000 });
  await page.waitForTimeout(1500); // laisser charger les favoris depuis Supabase

  // Le favori doit toujours être présent
  await page.locator('#nav-favs').click();
  await expect(
    page.locator('#favs-list .event').first(),
    'Le favori doit survivre au rechargement (ID device stable)'
  ).toBeVisible({ timeout: 5000 });
});


// ════════════════════════════════════════════════════
// 11. GÉOLOCALISATION
// ════════════════════════════════════════════════════

test('[T34] 📍 Géolocalisation "Me localiser" met à jour l\'interface', async ({ browser }) => {
  // Playwright peut simuler une position GPS via l'API du contexte.
  // On vérifie que le clic sur "Me localiser" :
  //   1) Change le texte du bouton à "✅ Localisé"
  //   2) Met à jour le titre en "📍 Autour de toi"
  // Note : on teste ici le fallback web (navigator.geolocation), pas le plugin natif.

  const context = await browser.newContext({
    geolocation: { latitude: 44.8378, longitude: -0.5792 }, // Bordeaux centre
    permissions: ['geolocation'],
    viewport: { width: 390, height: 844 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  const page = await context.newPage();

  await waitForAppReady(page);

  const geoBtn = page.locator('#geo-btn');
  await expect(geoBtn).toBeVisible();
  await expect(geoBtn).toContainText('Me localiser');

  await geoBtn.click();

  // Le bouton doit passer à "✅ Localisé" dans les 12 secondes
  await expect(geoBtn).toContainText('Localisé', { timeout: 12000 });

  // Le titre de section doit refléter la géolocalisation
  const nearTitle = page.locator('#near-me-title');
  await expect(nearTitle).toContainText('Autour de toi', { timeout: 3000 });

  // Le header doit aussi être mis à jour
  const headerCity = page.locator('#header-city');
  await expect(headerCity).toContainText('Autour de toi', { timeout: 3000 });

  await context.close();
});


// ════════════════════════════════════════════════════
// 12. RESPONSIVE
// ════════════════════════════════════════════════════

test('[T35] 📱 Responsive — iPhone SE (375×667) : éléments clés visibles', async ({ browser }) => {
  // Petit écran courant (iPhone SE 2/3 ou Android compact).
  // On vérifie que les éléments principaux sont accessibles.
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  const page = await context.newPage();

  await waitForAppReady(page);

  // Header visible
  await expect(page.locator('#header')).toBeVisible();

  // Logo lisible
  const logo = page.locator('.logo');
  await expect(logo).toBeVisible();

  // Carrousel de lieux visible et avec des cartes
  const cards = page.locator('#places-scroll .place-card');
  await expect(cards.first()).toBeVisible();

  // Filtres visibles et cliquables
  const filters = page.locator('.filter-btn');
  await expect(filters.first()).toBeVisible();

  // Nav bar visible et complète (4 onglets)
  const navItems = page.locator('#nav .nav-item');
  await expect(navItems).toHaveCount(4);
  await expect(navItems.first()).toBeVisible();

  // FAB (bouton +) visible
  await expect(page.locator('#fab')).toBeVisible();

  // Le carrousel ne déborde pas du viewport
  const hscrollCheck = await isWithinViewport(page, '#places-scroll');
  expect(hscrollCheck.ok, `Carrousel déborde : ${hscrollCheck.reason}`).toBe(true);

  // Le header ne déborde pas
  const headerCheck = await isWithinViewport(page, '#header');
  expect(headerCheck.ok, `Header déborde : ${headerCheck.reason}`).toBe(true);

  // Navigation vers la carte fonctionne
  await page.locator('#nav-map').click();
  await expect(page.locator('#map-fullscreen-page')).toBeVisible({ timeout: 5000 });

  // Filtres carte visibles
  await expect(page.locator('#map-fs-filters')).toBeVisible({ timeout: 3000 });

  await context.close();
});

test('[T36] 📱 Responsive — Très petit écran (320×568) : pas de débordement', async ({ browser }) => {
  // Gabarit le plus petit encore utilisé (anciens iPhone SE, petits Android).
  // L'objectif : aucun élément critique ne déborde ou n'est inaccessible.
  const context = await browser.newContext({
    viewport: { width: 320, height: 568 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  const page = await context.newPage();

  await waitForAppReady(page);

  // Pas de scrollbar horizontale sur le body (signe de débordement)
  const hasHScroll = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth);
  expect(hasHScroll, 'Le body ne doit pas avoir de scroll horizontal').toBe(false);

  // Header ne déborde pas
  const headerCheck = await isWithinViewport(page, '#header');
  expect(headerCheck.ok, `Header déborde à 320px : ${headerCheck.reason}`).toBe(true);

  // Nav ne déborde pas
  const navCheck = await isWithinViewport(page, '#nav');
  expect(navCheck.ok, `Nav déborde à 320px : ${navCheck.reason}`).toBe(true);

  // Les cartes sont visibles (même petites)
  await expect(page.locator('#places-scroll .place-card').first()).toBeVisible();

  // Coups de cœur visibles
  await expect(page.locator('#crush-grid .crush-card').first()).toBeVisible({ timeout: 10000 });

  // On peut ouvrir une fiche lieu sans problème
  await page.locator('#places-scroll .place-card').first().click();
  await expect(page.locator('#detail-modal.open')).toBeVisible({ timeout: 5000 });
  await closeFiche(page);

  await context.close();
});

test('[T37] 🖥️ Responsive — Tablette (768×1024) : mise en page centrée', async ({ browser }) => {
  // Sur un grand écran, l'app doit rester centrée à max 430px de large
  // et ne pas s'étaler sur toute la largeur.
  const context = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
  });
  const page = await context.newPage();

  await waitForAppReady(page);

  // Le body a un max-width (430px) : vérifier qu'il n'occupe pas les 768px
  const bodyWidth = await page.evaluate(() => {
    const body = document.body;
    return body.getBoundingClientRect().width;
  });
  expect(bodyWidth, 'Le body doit rester à ~430px max, pas 768px').toBeLessThanOrEqual(440);

  // Les éléments sont toujours visibles et fonctionnels
  await expect(page.locator('#header')).toBeVisible();
  await expect(page.locator('#places-scroll .place-card').first()).toBeVisible();
  await expect(page.locator('#nav')).toBeVisible();

  // Navigation fonctionne
  await page.locator('#nav-events').click();
  await expect(page.locator('#events-page')).toBeVisible({ timeout: 3000 });

  await context.close();
});
