// api/send-push.js
// Envoie une notification push via Firebase Cloud Messaging (HTTP v1).
//
// POST body :
//   {
//     "title":  "Titre visible",
//     "body":   "Message visible",
//     "target": "all" | "device_id"     // "all" = tous les tokens, sinon un device_id précis
//     "adminPassword": "..."            // protection basique
//   }
//
// Variables d'environnement Vercel requises :
//   - SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY (bypass RLS pour lire push_tokens)
//   - FIREBASE_SERVICE_ACCOUNT  (JSON complet du compte de service Firebase, en string)
//   - ADMIN_PASSWORD            (même mot de passe que celui de l'admin — protection basique)

const crypto = require('crypto');

// ── Auth Google : générer un access token depuis le compte de service ─────────
async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: 'RS256', typ: 'JWT' };
  const jwtClaim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(jwtHeader)}.${b64(jwtClaim)}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Envoi d'une notif à un token précis via l'API FCM HTTP v1 ────────────────
async function sendToToken({ accessToken, projectId, token, title, body }) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const payload = {
    message: {
      token,
      notification: { title, body },
      android: { priority: 'HIGH' },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status };
}

// ── Handler principal ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS pour l'admin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { title, body: messageBody, target, adminPassword } = body || {};

    // Protection basique
    if (!process.env.ADMIN_PASSWORD || adminPassword !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!title || !messageBody) {
      return res.status(400).json({ error: 'title et body requis' });
    }

    // Charger le compte de service Firebase
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

    // Récupérer les tokens depuis Supabase
    // Note : on garde 1 token par device_id (le plus récent) pour éviter les doublons.
    const supaUrl = `${process.env.SUPABASE_URL}/rest/v1/push_tokens?select=device_id,token,updated_at&order=updated_at.desc`
      + (target && target !== 'all' ? `&device_id=eq.${encodeURIComponent(target)}` : '');
    const supaRes = await fetch(supaUrl, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!supaRes.ok) {
      return res.status(500).json({ error: 'Supabase read failed', detail: await supaRes.text() });
    }
    const rows = await supaRes.json();

    // Dédupliquer : garder le token le plus récent par device_id
    const seen = new Set();
    const uniqueTokens = [];
    for (const row of rows) {
      if (!row.token || seen.has(row.device_id)) continue;
      seen.add(row.device_id);
      uniqueTokens.push(row.token);
    }

    if (!uniqueTokens.length) {
      return res.status(200).json({ sent: 0, failed: 0, message: 'Aucun token à notifier' });
    }

    // Obtenir un access token Google
    const accessToken = await getAccessToken(sa);

    // Envoyer à chaque token (parallélisé par lot de 10 pour éviter de saturer)
    let sent = 0, failed = 0;
    const batchSize = 10;
    for (let i = 0; i < uniqueTokens.length; i += batchSize) {
      const batch = uniqueTokens.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(token =>
        sendToToken({ accessToken, projectId: sa.project_id, token, title, body: messageBody })
      ));
      results.forEach(r => r.ok ? sent++ : failed++);
    }

    return res.status(200).json({ sent, failed, total: uniqueTokens.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
