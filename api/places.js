// api/places.js — Proxy Vercel pour Google Places API
// Évite les problèmes CORS sur web et WebView Android (Capacitor)
export default async function handler(req, res) {

  // ── CORS ──────────────────────────────────────────────────────────────────
  // '*' est insuffisant pour certaines WebViews Android ; on reflète l'origin
  // exacte si elle est dans la liste blanche, sinon on force vadrou.com.
  const ALLOWED_ORIGINS = [
    'https://vadrou.com',
    'capacitor://localhost',   // WebView Capacitor Android/iOS
    'http://localhost',        // dev local
    'https://localhost',
    'http://localhost:3000',
    'http://localhost:5173',
  ];
  const origin = req.headers.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://vadrou.com';

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── Clé Google ────────────────────────────────────────────────────────────
  const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;
  if (!GOOGLE_KEY) {
    console.error('[places] GOOGLE_PLACES_KEY manquante dans les env vars Vercel');
    res.status(500).json({ error: 'Clé Google manquante' });
    return;
  }

  const { action, input, place_id } = req.query;
  console.log(`[places] action=${action} | input=${input || place_id} | origin=${origin}`);

  let url;
  if (action === 'autocomplete') {
    if (!input) { res.status(400).json({ error: 'paramètre input manquant' }); return; }
    url = `https://maps.googleapis.com/maps/api/place/autocomplete/json`
      + `?input=${encodeURIComponent(input)}`
      + `&location=44.8378,-0.5792&radius=20000`
      + `&components=country:fr&language=fr`
      + `&key=${GOOGLE_KEY}`;

  } else if (action === 'details') {
    if (!place_id) { res.status(400).json({ error: 'paramètre place_id manquant' }); return; }
    url = `https://maps.googleapis.com/maps/api/place/details/json`
      + `?place_id=${place_id}`
      + `&fields=name,formatted_address,geometry`
      + `&key=${GOOGLE_KEY}`;

  } else {
    res.status(400).json({ error: `action inconnue : ${action}` });
    return;
  }

  try {
    const r = await fetch(url);
    const data = await r.json();

    // Log du statut Google pour repérer REQUEST_DENIED, INVALID_REQUEST, etc.
    console.log(`[places] Google status=${data.status} | HTTP=${r.status}`);
    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(`[places] Réponse Google non-OK :`, JSON.stringify(data).slice(0, 300));
    }

    res.status(200).json(data);
  } catch (e) {
    console.error('[places] Erreur fetch Google:', e.message);
    res.status(500).json({ error: e.message });
  }
}
