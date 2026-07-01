/**
 * scripts/moderate-events.js
 *
 * Pipeline automatique de modération des événements Vadrou.
 *
 * 1. Extrait les événements non encore vérifiés par Claude (verifie_claude = false)
 * 2. Envoie le batch à l'API Claude avec le prompt système de modération
 * 3. Applique les décisions (valider / rejeter / attente) en base Supabase
 * 4. Géocode les événements valides sans quartier (reverse-geocoding Google)
 * 5. Envoie un email récapitulatif détaillé à bahrisoumaya@gmail.com
 *
 * Variables d'environnement requises :
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY   (nécessaire pour bypasser RLS sur les UPDATE)
 *   - ANTHROPIC_API_KEY
 *   - GMAIL_APP_PASSWORD          (déjà utilisé par api/notify.js)
 *   - GOOGLE_PLACES_KEY           (clé "Gambette Scripts" — aussi utilisée pour le géocoding)
 *
 * Usage :
 *   node scripts/moderate-events.js
 *   node scripts/moderate-events.js --dry-run
 */

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const PROMPT_PATH = path.join(__dirname, 'prompt_systeme_moderation.md');
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const RECIPIENT_EMAIL = 'bahrisoumaya@gmail.com';
const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// Étape 1 — Extraction des événements non vérifiés
// ---------------------------------------------------------------------------

async function fetchUnverifiedEvents() {
  const { data, error } = await supabase
    .from('evenements')
    .select(
      'id, nom, adresse, latitude, longitude, date_debut, date_fin, heure, ' +
      'categorie, ages, tarif, description, age_min, age_max, conditions_acces, ' +
      'lien_evenement, valide, rejete, coup_de_coeur'
    )
    .eq('verifie_claude', false)
    .order('date_debut', { ascending: true })
    .limit(BATCH_SIZE);

  if (error) throw new Error(`Erreur extraction Supabase: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Étape 2 — Appel à l'API Claude
// ---------------------------------------------------------------------------

function loadSystemPrompt() {
  if (!fs.existsSync(PROMPT_PATH)) {
    throw new Error(`Prompt système introuvable: ${PROMPT_PATH}`);
  }
  return fs.readFileSync(PROMPT_PATH, 'utf-8');
}

async function callClaudeForModeration(events, systemPrompt) {
  const userMessage = [
    'Voici le batch d\'événements à modérer (JSON ci-dessous).',
    'Applique strictement les règles du prompt système, y compris le journal des corrections.',
    'Réponds uniquement avec le JSON de sortie demandé, sans aucun texte autour.',
    '',
    JSON.stringify(events, null, 2),
  ].join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur API Anthropic (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Aucune réponse texte reçue de Claude.');

  const cleaned = textBlock.text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Réponse Claude non parsable en JSON: ${e.message}\n\nContenu reçu:\n${cleaned}`);
  }

  if (!Array.isArray(parsed.decisions)) {
    throw new Error('Le JSON reçu ne contient pas de tableau "decisions".');
  }

  return parsed.decisions;
}

// ---------------------------------------------------------------------------
// Étape 3 — Application des décisions en base
// ---------------------------------------------------------------------------

async function applyDecisions(decisions) {
  const results = { valides: [], rejetes: [], attente: [], erreurs: [] };

  for (const decision of decisions) {
    const { id, action, categorie, age_min, age_max, raison } = decision;

    try {
      if (action === 'attente') {
        results.attente.push({ id, raison });
        continue;
      }

      const update = { verifie_claude: true };

      if (action === 'valider') {
        update.valide = true;
        update.rejete = false;
      } else if (action === 'rejeter') {
        update.valide = false;
        update.rejete = true;
      } else {
        throw new Error(`Action inconnue: "${action}"`);
      }

      if (categorie) update.categorie = categorie;
      if (age_min !== null && age_min !== undefined) update.age_min = age_min;
      if (age_max !== null && age_max !== undefined) update.age_max = age_max;

      if (DRY_RUN) {
        console.log(`[DRY RUN] UPDATE evenements SET ${JSON.stringify(update)} WHERE id = '${id}'`);
      } else {
        const { error } = await supabase
          .from('evenements')
          .update(update)
          .eq('id', id);

        if (error) throw error;
      }

      const bucket = action === 'valider' ? results.valides : results.rejetes;
      bucket.push({ id, categorie, age_min, age_max, raison });
    } catch (err) {
      results.erreurs.push({ id, message: err.message });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Étape 4 — Géocoding des événements valides sans quartier
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Reverse-geocode un couple lat/lng → { quartier, ville }
// Logique : dans Bordeaux → quartier précis ; autre commune → nom de la commune.
async function reverseGeocode(lat, lng) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return { quartier: null, ville: null };

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=fr&key=${key}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.status !== 'OK' || !data.results?.length) {
    return { quartier: null, ville: null };
  }

  let commune = null;
  let sublocality = null;
  for (const result of data.results) {
    for (const comp of result.address_components) {
      const t = comp.types;
      if (!commune && t.includes('locality')) commune = comp.long_name;
      if (!sublocality && (t.includes('sublocality') || t.includes('sublocality_level_1') || t.includes('neighborhood'))) {
        sublocality = comp.long_name;
      }
    }
    if (commune && sublocality) break;
  }

  const ville = commune || 'Bordeaux';
  const quartier = commune?.toLowerCase() === 'bordeaux'
    ? (sublocality || 'Bordeaux')
    : (commune || sublocality || null);

  return { quartier, ville };
}

async function geocodeEventsSansQuartier() {
  // Tous les événements valides sans quartier (pas seulement le batch courant)
  const { data, error } = await supabase
    .from('evenements')
    .select('id, nom, latitude, longitude')
    .eq('valide', true)
    .is('quartier', null)
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)
    .limit(200);

  if (error) {
    console.warn('Géocoding ignoré — erreur Supabase:', error.message);
    return { ok: 0, skip: 0 };
  }

  if (!data?.length) {
    console.log('Géocoding : aucun événement valide sans quartier.');
    return { ok: 0, skip: 0 };
  }

  console.log(`Géocoding de ${data.length} événement(s) sans quartier...`);
  let ok = 0, skip = 0;

  for (const evt of data) {
    try {
      const { quartier, ville } = await reverseGeocode(evt.latitude, evt.longitude);
      if (!quartier) {
        skip++;
        continue;
      }
      if (DRY_RUN) {
        console.log(`[DRY RUN] ${evt.nom?.slice(0, 40)} → ${quartier} (${ville})`);
      } else {
        const { error: upErr } = await supabase
          .from('evenements')
          .update({ quartier, ville })
          .eq('id', evt.id);
        if (upErr) throw upErr;
        console.log(`  ✓ ${evt.nom?.slice(0, 40)} → ${quartier} (${ville})`);
      }
      ok++;
    } catch (e) {
      console.warn(`  ✗ ${evt.nom?.slice(0, 40)} — ${e.message}`);
      skip++;
    }
    await sleep(120); // ~8 req/s max, respecter le quota Google
  }

  return { ok, skip };
}

// ---------------------------------------------------------------------------
// Étape 5 — Email récapitulatif
// ---------------------------------------------------------------------------

function buildRecapHtml(results, eventsById, totalCount, geocoding) {
  const row = (item) => {
    const ev = eventsById[item.id] || {};
    const details = [
      item.categorie ? `catégorie: ${item.categorie}` : null,
      (item.age_min !== undefined && item.age_min !== null) || (item.age_max !== undefined && item.age_max !== null)
        ? `âge: ${item.age_min ?? '?'}-${item.age_max ?? '?'}`
        : null,
    ].filter(Boolean).join(' · ');

    return `<li><strong>${ev.nom || item.id}</strong>${details ? ` (${details})` : ''}<br>
      <span style="color:#666;font-size:0.9em;">${item.raison || ''}</span></li>`;
  };

  return `
    <h2>Modération automatique Vadrou — récapitulatif</h2>
    <p>Batch traité : ${totalCount} événements.</p>

    <h3>✅ Validés (${results.valides.length})</h3>
    <ul>${results.valides.map(row).join('') || '<li>Aucun</li>'}</ul>

    <h3>❌ Rejetés (${results.rejetes.length})</h3>
    <ul>${results.rejetes.map(row).join('') || '<li>Aucun</li>'}</ul>

    <h3>⏳ Laissés en attente (${results.attente.length})</h3>
    <ul>${results.attente.map(row).join('') || '<li>Aucun</li>'}</ul>

    <h3>📍 Quartiers renseignés (${geocoding.ok})</h3>
    <p>${geocoding.ok} événement(s) géocodé(s)${geocoding.skip > 0 ? `, ${geocoding.skip} ignoré(s) (coordonnées absentes ou non résolues)` : ''}.</p>

    ${results.erreurs.length > 0 ? `
    <h3 style="color:red;">⚠️ Erreurs (${results.erreurs.length})</h3>
    <ul>${results.erreurs.map((e) => `<li>${e.id}: ${e.message}</li>`).join('')}</ul>
    ` : ''}
  `;
}

async function sendRecapEmail(html, totalCount) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: RECIPIENT_EMAIL,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: RECIPIENT_EMAIL,
    to: RECIPIENT_EMAIL,
    subject: `Vadrou — modération auto (${totalCount} événements traités)`,
    html,
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main() {
  console.log('--- Modération automatique Vadrou ---');
  if (DRY_RUN) console.log('(Mode --dry-run : aucune écriture en base, aucun email envoyé)');

  // Étapes 1-3 : modération
  const events = await fetchUnverifiedEvents();
  console.log(`${events.length} événements non vérifiés trouvés.`);

  let results = { valides: [], rejetes: [], attente: [], erreurs: [] };
  const eventsById = {};

  if (events.length > 0) {
    Object.assign(eventsById, Object.fromEntries(events.map((e) => [e.id, e])));
    const systemPrompt = loadSystemPrompt();
    console.log('Appel à Claude pour modération...');
    const decisions = await callClaudeForModeration(events, systemPrompt);
    console.log(`${decisions.length} décisions reçues.`);
    console.log('Application des décisions en base...');
    results = await applyDecisions(decisions);
    console.log(`Validés: ${results.valides.length} | Rejetés: ${results.rejetes.length} | Attente: ${results.attente.length} | Erreurs: ${results.erreurs.length}`);
  } else {
    console.log('Aucun événement à modérer — passage au géocoding.');
  }

  // Étape 4 : géocoding de tous les événements valides sans quartier
  const geocoding = await geocodeEventsSansQuartier();
  console.log(`Géocoding : ${geocoding.ok} renseignés, ${geocoding.skip} ignorés.`);

  // Étape 5 : email récapitulatif (même si aucun événement à modérer)
  const html = buildRecapHtml(results, eventsById, events.length, geocoding);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Email qui aurait été envoyé :\n');
    console.log(html.replace(/<[^>]+>/g, '').trim());
  } else {
    await sendRecapEmail(html, events.length);
    console.log('Email récapitulatif envoyé.');
  }
}

main().catch((err) => {
  console.error('Erreur fatale dans le pipeline de modération:', err);
  process.exit(1);
});
