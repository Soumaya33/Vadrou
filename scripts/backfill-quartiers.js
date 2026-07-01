// scripts/backfill-quartiers.js
// Renseigne la colonne `quartier` (et `ville`) des événements/lieux à partir de
// latitude/longitude, via Google Geocoding (reverse).
//
// Règle de granularité :
//   - Si la commune est BORDEAUX  -> on stocke le QUARTIER (ex: "Chartrons", "Bastide")
//   - Sinon (autre commune métropole) -> on stocke la COMMUNE (ex: "Pessac", "Cenon")
//
// Lancer une fois sur l'existant :  node scripts/backfill-quartiers.js
// Variables d'env requises :
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, GOOGLE_GEOCODING_KEY (clé "Gambette Scripts")
//
// Idempotent : ne traite que les lignes où `quartier` est encore NULL.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xwykpuytwjiwuxhpeqrt.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;       // clé service_role (bypass RLS)
const GOOGLE_KEY   = process.env.GOOGLE_GEOCODING_KEY;       // clé "Gambette Scripts"

if (!SERVICE_KEY || !GOOGLE_KEY) {
  console.error('❌ SUPABASE_SERVICE_KEY et GOOGLE_GEOCODING_KEY sont requis.');
  process.exit(1);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Supabase REST helpers (service_role) ---------------------------------
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// --- Reverse geocoding -----------------------------------------------------
// Retourne { quartier, ville } pour un couple lat/lng.
async function reverseGeocode(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=fr&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK' || !data.results || !data.results.length) {
    return { quartier: null, ville: null, status: data.status };
  }

  // Parcourir les composants d'adresse de tous les résultats
  let commune = null;        // locality (ex: "Bordeaux", "Pessac")
  let sublocality = null;    // sublocality / neighborhood (ex: "Chartrons")
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
  let quartier;
  if (commune && commune.toLowerCase() === 'bordeaux') {
    // Dans Bordeaux : on préfère le quartier précis, sinon "Bordeaux"
    quartier = sublocality || 'Bordeaux';
  } else {
    // Autre commune de la métropole : le quartier = la commune elle-même
    quartier = commune || sublocality || null;
  }
  return { quartier, ville, status: 'OK' };
}

// --- Traitement d'une table ------------------------------------------------
async function processTable(table) {
  console.log(`\n=== Table ${table} ===`);
  // Lignes sans quartier, avec coordonnées
  const rows = await sb(
    `${table}?quartier=is.null&latitude=not.is.null&longitude=not.is.null&select=id,nom,latitude,longitude&limit=1000`
  );
  console.log(`${rows.length} ligne(s) à géocoder.`);

  let ok = 0, skip = 0;
  for (const row of rows) {
    try {
      const { quartier, ville, status } = await reverseGeocode(row.latitude, row.longitude);
      if (!quartier) {
        console.log(`  · ${row.nom?.slice(0, 40)} → (aucun quartier, status=${status})`);
        skip++;
      } else {
        await sb(`${table}?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ quartier, ville }),
        });
        console.log(`  ✓ ${row.nom?.slice(0, 40)} → ${quartier} (${ville})`);
        ok++;
      }
    } catch (e) {
      console.log(`  ✗ ${row.nom?.slice(0, 40)} → ERREUR ${e.message}`);
      skip++;
    }
    await sleep(120); // respecter le quota Google (≈ 8 req/s max ici)
  }
  console.log(`Terminé ${table} : ${ok} renseignés, ${skip} ignorés.`);
}

(async () => {
  await processTable('evenements');
  await processTable('lieux');
  console.log('\n✅ Backfill quartiers terminé.');
})();
