// api/send-push.js
// Envoi de notifications push :
//   - Android  -> Firebase Cloud Messaging (FCM)
//   - iOS      -> APNs directement (le plugin Capacitor renvoie un token APNs, pas FCM)
//
// Variables d'environnement (Vercel) :
//   ADMIN_PASSWORD
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   FIREBASE_SERVICE_ACCOUNT        (JSON complet du compte de service Firebase)
//   APNS_KEY_P8                     (contenu du fichier .p8, avec les lignes BEGIN/END)
//   APNS_KEY_ID                     (ex: 7Y9X8CHLLQ)
//   APNS_TEAM_ID                    (ex: SMUNNGQ6R8)
//   APNS_BUNDLE_ID                  (com.vadrou.app)

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ---------------------------------------------------------------------------
// FCM (Android) — access token via le compte de service
// ---------------------------------------------------------------------------
async function getFcmAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(claims)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('FCM token error: ' + JSON.stringify(data));
  return data.access_token;
}

async function sendFcm(accessToken, projectId, token, title, body) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: token,
        notification: { title, body },
      },
    }),
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// APNs (iOS) — envoi direct via HTTP/2, JWT ES256 (clé .p8)
// ---------------------------------------------------------------------------
function getApnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: process.env.APNS_KEY_ID };
  const claims = { iss: process.env.APNS_TEAM_ID, iat: now };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(claims)}`;

  const key = process.env.APNS_KEY_P8.replace(/\\n/g, '\n');
  const signer = crypto.createSign('SHA256');
  signer.update(unsigned);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${unsigned}.${signature}`;
}

async function sendApns(jwt, token, title, body) {
  const res = await fetch(`https://api.push.apple.com/3/device/${token}`, {
    method: 'POST',
    headers: {
      'authorization': 'bearer ' + jwt,
      'apns-topic': process.env.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: {
        alert: { title, body },
        sound: 'default',
      },
    }),
  });
  return res.status === 200;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { password, title, body, target, device_id } = req.body || {};

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  if (!title || !body) {
    return res.status(400).json({ error: 'Titre et message requis' });
  }

  try {
    let url = `${SUPABASE_URL}/rest/v1/push_tokens?select=device_id,token,platform`;
    if (target === 'me' && device_id) {
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

    let success = 0, failure = 0;

    // Android via FCM
    if (androidTokens.length > 0) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      const accessToken = await getFcmAccessToken(serviceAccount);
      for (const t of androidTokens) {
        try {
          const ok = await sendFcm(accessToken, serviceAccount.project_id, t.token, title, body);
          ok ? success++ : failure++;
        } catch (e) { failure++; }
      }
    }

    // iOS via APNs
    if (iosTokens.length > 0) {
      const jwt = getApnsJwt();
      for (const t of iosTokens) {
        try {
          const ok = await sendApns(jwt, t.token, title, body);
          ok ? success++ : failure++;
        } catch (e) { failure++; }
      }
    }

    return res.status(200).json({
      success,
      failure,
      total: tokens.length,
      android: androidTokens.length,
      ios: iosTokens.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
