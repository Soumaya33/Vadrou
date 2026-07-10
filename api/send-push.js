// api/send-push.js
// Envoi de notifications push via OneSignal REST API
//
// Variables d'environnement (Vercel) :
//   ADMIN_PASSWORD
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ONESIGNAL_APP_ID       (e0c5b8b4-beec-4e44-b251-aa2f34c2c3a4)
//   ONESIGNAL_API_KEY      (REST API Key depuis OneSignal → Settings → Keys & IDs)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Subscription ID OneSignal de l'appareil de test (Android Soumaya)
const MY_ONESIGNAL_ID = '7127c0ea-0929-496e-b7e6-3921f32f7189';

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  // Parser le body JSON manuellement
  let parsed = req.body;
  if (!parsed || typeof parsed === 'string') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      parsed = JSON.parse(Buffer.concat(chunks).toString());
    } catch (e) {
      return res.status(400).json({ error: 'Body JSON invalide' });
    }
  }

  const { password, title, body, target } = parsed || {};

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  if (!title || !body) {
    return res.status(400).json({ error: 'Titre et message requis' });
  }

  try {
    // Récupérer le nombre total d'appareils pour l'affichage
    const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/push_tokens?select=device_id,platform`, {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    });
    const rows = await tokensRes.json();
    const seen = new Set();
    const tokens = [];
    for (const r of rows) {
      if (r.device_id && seen.has(r.device_id)) continue;
      if (r.device_id) seen.add(r.device_id);
      tokens.push(r);
    }
    const androidCount = tokens.filter(t => t.platform === 'android').length;
    const iosCount = tokens.filter(t => t.platform === 'ios').length;

    // Construire le payload OneSignal
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      headings: { en: title, fr: title },
      contents: { en: body, fr: body },
    };

    if (target === 'all') {
      payload.included_segments = ['All'];
    } else {
      // Moi uniquement — Subscription ID OneSignal
      payload.include_subscription_ids = [MY_ONESIGNAL_ID];
    }

    const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + ONESIGNAL_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await osRes.json();
    console.log('OneSignal response:', JSON.stringify(data));

    if (!osRes.ok || data.errors) {
      return res.status(200).json({
        success: 0,
        failure: tokens.length,
        total: tokens.length,
        android: androidCount,
        ios: iosCount,
        debug: { onesignal_error: data.errors || data },
      });
    }

    return res.status(200).json({
      success: data.recipients || 0,
      failure: 0,
      total: tokens.length,
      android: androidCount,
      ios: iosCount,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
