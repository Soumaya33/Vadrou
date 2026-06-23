/**
 * scripts/import-lieux-google.js
 *
 * Enrichissement automatique de la table `lieux` Vadrou via Google Places API.
 *
 * 1. Pour chaque commune cible × chaque type Google Places, lance une recherche
 *    Nearby Search (rayon 3km autour du centre de la commune)
 * 2. Déduplique contre les lieux déjà en base (par google_place_id)
 * 3. Pour chaque nouveau lieu, appelle l'API Claude pour générer une description
 *    éditoriale courte (ton Vadrou : sobre, chaleureux, 2-3 phrases)
 * 4. Insère en base avec valide = false (à valider dans l'admin)
 * 5. Envoie un email récap
 *
 * Variables d'environnement requises :
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   GOOGLE_PLACES_KEY, ANTHROPIC_API_KEY, GMAIL_APP_PASSWORD_MODERATION
 *
 * Usage :
 *   node scripts/import-lieux-google.js
 *   node scripts/import-lieux-google.js --dry-run   (aucune écriture en base)
 */

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const DRY_RUN = process.argv.includes('--dry-run');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ---------------------------------------------------------------------------
// Configuration — communes et types
// ---------------------------------------------------------------------------

// Communes cibles avec coordonnées centre + rayon de recherche (mètres)
const COMMUNES = [
  // Métropole bordelaise — complètement absentes
  { nom: 'Floirac',                lat: 44.836,  lng: -0.521,  rayon: 3000 },
  { nom: 'Gradignan',              lat: 44.776,  lng: -0.622,  rayon: 3000 },
  { nom: 'Le Haillan',             lat: 44.872,  lng: -0.676,  rayon: 2500 },
  { nom: 'Le Taillan-Médoc',       lat: 44.914,  lng: -0.668,  rayon: 2500 },
  { nom: 'Artigues-près-Bordeaux', lat: 44.852,  lng: -0.481,  rayon: 2500 },
  { nom: 'Carbon-Blanc',           lat: 44.896,  lng: -0.504,  rayon: 2500 },
  { nom: 'Bassens',                lat: 44.904,  lng: -0.513,  rayon: 2000 },
  { nom: 'Parempuyre',             lat: 44.948,  lng: -0.604,  rayon: 2000 },
  { nom: 'Martignas-sur-Jalle',    lat: 44.893,  lng: -0.773,  rayon: 2000 },
  { nom: 'Saint-Aubin-de-Médoc',   lat: 44.913,  lng: -0.724,  rayon: 2000 },
  { nom: 'Ambès',                  lat: 45.004,  lng: -0.543,  rayon: 2000 },
  { nom: 'Ambarès-et-Lagrave',     lat: 44.942,  lng: -0.479,  rayon: 2500 },
  // Métropole — sous-représentées
  { nom: 'Cenon',                  lat: 44.857,  lng: -0.524,  rayon: 3000 },
  { nom: 'Bègles',                 lat: 44.801,  lng: -0.545,  rayon: 3000 },
  { nom: 'Pessac',                 lat: 44.806,  lng: -0.631,  rayon: 4000 },
  { nom: 'Eysines',                lat: 44.881,  lng: -0.650,  rayon: 3000 },
  { nom: "Villenave-d'Ornon",      lat: 44.774,  lng: -0.575,  rayon: 3000 },
  { nom: 'Saint-Médard-en-Jalles', lat: 44.897,  lng: -0.742,  rayon: 3500 },
  // Zones eau périphériques
  { nom: 'Lacanau',                lat: 44.974,  lng: -1.079,  rayon: 5000 },
  { nom: 'Lacanau-Océan',          lat: 44.991,  lng: -1.193,  rayon: 3000 },
  { nom: 'Arcachon',               lat: 44.659,  lng: -1.168,  rayon: 4000 },
  { nom: 'La Teste-de-Buch',       lat: 44.625,  lng: -1.142,  rayon: 4000 },
  { nom: 'Andernos-les-Bains',     lat: 44.740,  lng: -1.097,  rayon: 3000 },
  { nom: 'Lège-Cap-Ferret',        lat: 44.758,  lng: -1.198,  rayon: 4000 },
  { nom: 'Hourtin',                lat: 45.177,  lng: -1.063,  rayon: 3000 },
  { nom: 'Carcans',                lat: 45.078,  lng: -1.045,  rayon: 3000 },
  { nom: 'Blaye',                  lat: 45.127,  lng: -0.664,  rayon: 3000 },
  { nom: 'Libourne',               lat: 44.919,  lng: -0.242,  rayon: 3500 },
];

// Mapping catégories Vadrou → types Google Places groupés
// 1 requête par catégorie par commune (au lieu de 1 par type) = 4x moins de requêtes
const CATEGORIE_MAP = [
  {
    categorie: 'jeux_ext',
    googleTypes: [
      'playground', 'park', 'amusement_park', 'miniature_golf_course',
      'adventure_sports_center', 'sports_complex', 'skateboard_park', 'water_park',
    ],
  },
  {
    categorie: 'jeux_int',
    googleTypes: [
      'bowling_alley', 'trampoline_park', 'laser_game_center',
      'indoor_play_area', 'climbing_gym', 'escape_room',
    ],
  },
  {
    categorie: 'eau',
    googleTypes: ['swimming_pool', 'beach', 'lake', 'marina'],
  },
  {
    categorie: 'culture',
    googleTypes: [
      'library', 'museum', 'performing_arts_theater',
      'cultural_center', 'zoo', 'aquarium', 'movie_theater',
    ],
  },
];

// ---------------------------------------------------------------------------
// Étape 1 — Récupérer les google_place_id déjà en base (pour déduplication)
// ---------------------------------------------------------------------------

async function fetchExistingPlaceIds() {
  const { data, error } = await supabase
    .from('lieux')
    .select('google_place_id')
    .not('google_place_id', 'is', null);
  if (error) throw new Error(`Erreur Supabase fetchExisting: ${error.message}`);
  return new Set(data.map(r => r.google_place_id));
}

// ---------------------------------------------------------------------------
// Étape 2 — Google Places Nearby Search (API v1 New)
// ---------------------------------------------------------------------------

async function searchNearby(commune, googleTypes) {
  const url = 'https://places.googleapis.com/v1/places:searchNearby';
  const body = {
    includedTypes: googleTypes,
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: commune.lat, longitude: commune.lng },
        radius: commune.rayon,
      },
    },
    languageCode: 'fr',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': process.env.GOOGLE_PLACES_KEY,
      // Champs Basic Data uniquement (tier gratuit / moins cher)
      // editorialSummary retiré : Claude génère les descriptions de toute façon
      'X-Goog-FieldMask': [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.location',
        'places.rating',
        'places.userRatingCount',
        'places.primaryType',
        'places.primaryTypeDisplayName',
      ].join(','),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(`    ⚠️ Google Places error (${commune.nom}): ${response.status} ${text.slice(0, 100)}`);
    return [];
  }

  const data = await response.json();
  return data.places || [];
}

// ---------------------------------------------------------------------------
// Étape 3 — Génération de description par Claude
// ---------------------------------------------------------------------------

const SYSTEM_DESCRIPTION = `Tu rédiges des descriptions courtes pour Vadrou, une application mobile qui aide les familles bordelaises à trouver des sorties avec leurs enfants.

Ton style : sobre, chaleureux, concis. 2 à 3 phrases maximum. Pas de superlatifs marketing ("incontournable", "magnifique"). Parle à la famille, pas au touriste. Mentionne l'âge minimum ou le type de public si pertinent. Commence toujours par décrire ce que c'est, pas par le nom du lieu.

Tu reçois en entrée : nom, adresse, type principal, note Google, résumé éditorial Google (si disponible). Tu réponds uniquement avec la description, sans guillemets ni balises.`;

async function generateDescription(lieu) {
  const userMsg = [
    `Nom : ${lieu.nom}`,
    `Adresse : ${lieu.adresse}`,
    `Type : ${lieu.typeLabel}`,
    lieu.rating ? `Note Google : ${lieu.rating}/5 (${lieu.ratingCount} avis)` : null,
  ].filter(Boolean).join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system: SYSTEM_DESCRIPTION,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const text = data.content.find(b => b.type === 'text');
  return text ? text.text.trim() : null;
}

// ---------------------------------------------------------------------------
// Étape 4 — Insertion en base
// ---------------------------------------------------------------------------

async function insertLieu(lieu) {
  const row = {
    nom: lieu.nom,
    adresse: lieu.adresse,
    latitude: lieu.latitude,
    longitude: lieu.longitude,
    google_place_id: lieu.googlePlaceId,
    categorie: JSON.stringify([lieu.categorie]),
    description: lieu.description || null,
    valide: false,
  };

  if (DRY_RUN) {
    console.log(`    [DRY RUN] INSERT: ${lieu.nom} (${lieu.categorie})`);
    return true;
  }

  const { error } = await supabase.from('lieux').insert(row);
  if (error) {
    console.warn(`    ⚠️ Erreur INSERT ${lieu.nom}: ${error.message}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function main() {
  console.log('--- Import lieux Google Places → Vadrou ---');
  if (DRY_RUN) console.log('(Mode --dry-run : aucune écriture en base, aucun email)');

  // Récupérer les IDs déjà en base
  const existingIds = await fetchExistingPlaceIds();
  console.log(`${existingIds.size} lieux déjà en base (pour déduplication)`);

  const results = { inseres: [], doublons: 0, erreurs: [] };
  const seenThisRun = new Set(); // évite les doublons inter-requêtes du même run

  for (const commune of COMMUNES) {
    console.log(`\n📍 ${commune.nom}`);
    const communeInserts = [];

    for (const { categorie, googleTypes } of CATEGORIE_MAP) {
      const places = await searchNearby(commune, googleTypes);

      for (const place of places) {
        const placeId = place.id;

        // Déduplication
        if (existingIds.has(placeId) || seenThisRun.has(placeId)) {
          results.doublons++;
          continue;
        }
        seenThisRun.add(placeId);

        // Note minimale : éviter les lieux avec trop peu d'avis ou très mal notés
        if (place.userRatingCount && place.userRatingCount < 5) continue;
        if (place.rating && place.rating < 3.5) continue;

        const lieuData = {
          nom: place.displayName?.text || 'Lieu sans nom',
          adresse: place.formattedAddress || '',
          latitude: place.location?.latitude,
          longitude: place.location?.longitude,
          googlePlaceId: placeId,
          categorie,
          typeLabel: place.primaryTypeDisplayName?.text || place.primaryType || categorie,
          rating: place.rating,
          ratingCount: place.userRatingCount,
          commune: commune.nom,
        };

        // Génération de description
        console.log(`    ✏️  Description : ${lieuData.nom}`);
        lieuData.description = await generateDescription(lieuData);

        // Insertion
        const ok = await insertLieu(lieuData);
        if (ok) {
          communeInserts.push(lieuData);
          results.inseres.push(lieuData);
        } else {
          results.erreurs.push(lieuData.nom);
        }

        // Petite pause pour ne pas saturer l'API Anthropic
        await new Promise(r => setTimeout(r, 300));
      }
    }

    console.log(`  → ${communeInserts.length} nouveaux lieux`);
  }

  console.log(`\n✅ Total inséré : ${results.inseres.length}`);
  console.log(`⏭️  Doublons ignorés : ${results.doublons}`);
  if (results.erreurs.length) console.log(`❌ Erreurs : ${results.erreurs.join(', ')}`);

  // Email récap
  if (!DRY_RUN) await sendRecapEmail(results);
}

// ---------------------------------------------------------------------------
// Email récap
// ---------------------------------------------------------------------------

async function sendRecapEmail(results) {
  // Grouper par commune
  const parCommune = {};
  for (const lieu of results.inseres) {
    if (!parCommune[lieu.commune]) parCommune[lieu.commune] = [];
    parCommune[lieu.commune].push(lieu);
  }

  const communeRows = Object.entries(parCommune).map(([commune, lieux]) => `
    <tr>
      <td style="padding:4px 8px;"><strong>${commune}</strong></td>
      <td style="padding:4px 8px;">${lieux.length}</td>
      <td style="padding:4px 8px;font-size:0.85em;color:#555;">
        ${lieux.map(l => `${l.nom} (${l.categorie})`).join(', ')}
      </td>
    </tr>
  `).join('');

  const html = `
    <h2>Import lieux Vadrou — Google Places</h2>
    <p><strong>${results.inseres.length} nouveaux lieux insérés</strong> (valide = false, à valider dans l'admin).</p>
    <p>Doublons ignorés : ${results.doublons}</p>

    <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:16px;">
      <thead>
        <tr style="background:#f0f0f0;">
          <th style="padding:4px 8px;">Commune</th>
          <th style="padding:4px 8px;">Nb</th>
          <th style="padding:4px 8px;">Lieux</th>
        </tr>
      </thead>
      <tbody>${communeRows}</tbody>
    </table>

    ${results.erreurs.length ? `<p style="color:red;">Erreurs : ${results.erreurs.join(', ')}</p>` : ''}

    <p style="margin-top:24px;color:#888;font-size:0.85em;">
      À valider dans l'admin Vadrou → onglet Lieux → filtrer valide = false.
    </p>
  `;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'bahrisoumaya@gmail.com',
      pass: process.env.GMAIL_APP_PASSWORD_MODERATION,
    },
  });

  await transporter.sendMail({
    from: 'bahrisoumaya@gmail.com',
    to: 'bahrisoumaya@gmail.com',
    subject: `Vadrou — ${results.inseres.length} nouveaux lieux importés`,
    html,
  });

  console.log('📧 Email récap envoyé.');
}

main().catch(err => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
