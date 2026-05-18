// api/places.js — Proxy Vercel pour Google Places API
// Évite les problèmes CORS sur web et WebView Android
// Déployer dans le repo Vadrou, Vercel l'expose automatiquement sur /api/places

export default async function handler(req, res) {
  // CORS — autoriser vadrou.com et localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const GOOGLE_KEY = process.env.GOOGLE_PLACES_KEY;
  if (!GOOGLE_KEY) {
    res.status(500).json({ error: 'Clé Google manquante' });
    return;
  }

  const { action, input, place_id } = req.query;

  let url;
  if (action === 'autocomplete') {
    url = `https://maps.googleapis.com/maps/api/place/autocomplete/json`
      + `?input=${encodeURIComponent(input)}`
      + `&location=44.8378,-0.5792&radius=20000`
      + `&components=country:fr&language=fr`
      + `&key=${GOOGLE_KEY}`;
  } else if (action === 'details') {
    url = `https://maps.googleapis.com/maps/api/place/details/json`
      + `?place_id=${place_id}`
      + `&fields=name,formatted_address,geometry`
      + `&key=${GOOGLE_KEY}`;
  } else {
    res.status(400).json({ error: 'action inconnue' });
    return;
  }

  try {
    const r = await fetch(url);
    const data = await r.json();
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
