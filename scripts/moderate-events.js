/**
 * scripts/moderate-events.js
 *
 * Pipeline automatique de modération des événements Vadrou.
 *
 * 1. Extrait les événements non encore vérifiés par Claude (verifie_claude = false)
 * 2. Envoie le batch à l'API Claude avec le prompt système de modération
 * 3. Applique les décisions (valider / rejeter / attente) en base Supabase
 * 4. Envoie un email récapitulatif détaillé à bahrisoumaya@gmail.com
 *
 * Variables d'environnement requises :
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY   (nécessaire pour bypasser RLS sur les UPDATE)
 *   - ANTHROPIC_API_KEY
 *   - GMAIL_APP_PASSWORD          (déjà utilisé par api/notify.js)
 *
 * Usage :
 *   node scripts/moderate-events.js
 *
 * Peut être appelé en CLI, via un cron Vercel, ou ajouté en step supplémentaire
 * du workflow GitHub Actions .github/workflows/import-events.yml (après l'import
 * OpenAgenda, pour enchaîner automatiquement la modération).
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

  // Nettoyage défensif au cas où Claude entoure le JSON de balises markdown
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
        // Ne touche à rien, ne marque pas verifie_claude.
        results.attente.push({ id, raison });
        continue;
      }

      const update = {
        verifie_claude: true,
      };

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
// Étape 4 — Email récapitulatif
// ---------------------------------------------------------------------------

function buildRecapHtml(results, eventsById, totalCount) {
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

  const events = await fetchUnverifiedEvents();
  console.log(`${events.length} événements non vérifiés trouvés.`);

  if (events.length === 0) {
    console.log('Rien à faire.');
    return;
  }

  const eventsById = Object.fromEntries(events.map((e) => [e.id, e]));

  const systemPrompt = loadSystemPrompt();
  console.log('Appel à Claude pour modération...');
  const decisions = await callClaudeForModeration(events, systemPrompt);
  console.log(`${decisions.length} décisions reçues.`);

  console.log('Application des décisions en base...');
  const results = await applyDecisions(decisions);

  console.log(`Validés: ${results.valides.length} | Rejetés: ${results.rejetes.length} | Attente: ${results.attente.length} | Erreurs: ${results.erreurs.length}`);

  const html = buildRecapHtml(results, eventsById, events.length);

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
