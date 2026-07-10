// api/send-push.js
// Envoi de notifications push via OneSignal REST API
// OneSignal gère le relais HTTP/2 vers APNs (iOS) et FCM (Android)
//
// Variables d'environnement (Vercel) :
//   ADMIN_PASSWORD
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ONESIGNAL_APP_ID       (ex: e0c5b8b4-beec-4e44-b251-aa2f34c2c3a4)
//   ONESIGNAL_API_KEY      (REST API Key depuis OneSignal → Settings → Keys & IDs)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

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

  const { password, title, body, target, device_id } = parsed || {};

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  if (!title || !body) {
    return res.status(400).json({ error: 'Titre et message requis' });
  }

  try {
    // Récupérer les tokens depuis Supabase pour connaître la portée
    let url = `${SUPABASE_URL}/rest/v1/push_tokens?select=device_id,token,platform`;
    if (target !== 'all' && device_id) {
      url += `&device_id=eq.${encodeURIComponent(device_id)}`;
    }
    const tokensRes = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    });
    const rows = await tokensRes.json();

    // Dédupliquer par device_id
    const seen = new Set();
    const tokens = [];
    for (const r of rows) {
      if (r.device_id && seen.has(r.device_id)) continue;
      if (r.device_id) seen.add(r.device_id);
      tokens.push(r);
    }

    const androidTokens = tokens.filter(t => t.platform === 'android');
    const iosTokens = tokens.filter(t => t.platform === 'ios');

    // Construire le payload OneSignal
    let oneSignalTarget;
    if (target === 'all') {
      // Envoyer à tous les abonnés OneSignal
      oneSignalTarget = { included_segments: ['All'] };
    } else {
      // Envoyer uniquement aux tokens du device ciblé
      const targetTokens = tokens.map(t => t.token).filter(Boolean);
      if (!targetTokens.length) {
        return res.status(200).json({ success: 0, failure: 0, total: 0, android: 0, ios: 0 });
      }
      oneSignalTarget = { include_player_ids: targetTokens };
    }

    const payload = {
      app_id: ONESIGNAL_APP_ID,
      headings: { en: title, fr: title },
      contents: { en: body, fr: body },
      ...oneSignalTarget,
    };

    const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + ONESIGNAL_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const osData = await osRes.json();
    console.log('OneSignal response:', JSON.stringify(osData));

    if (!osRes.ok || osData.errors) {
      return res.status(200).json({
        success: 0,
        failure: tokens.length,
        total: tokens.length,
        android: androidTokens.length,
        ios: iosTokens.length,
        debug: { onesignal_error: osData.errors || osData },
      });
    }

    return res.status(200).json({
      success: osData.recipients || tokens.length,
      failure: 0,
      total: tokens.length,
      android: androidTokens.length,
      ios: iosTokens.length,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
