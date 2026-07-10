// api/send-push.js
// Envoi de notifications push :
//   - Android  -> Firebase Cloud Messaging (FCM) direct
//   - iOS      -> OneSignal REST API (gère le HTTP/2 vers APNs)
//
// Variables d'environnement (Vercel) :
//   ADMIN_PASSWORD
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   FIREBASE_SERVICE_ACCOUNT   (JSON complet du compte de service Firebase)
//   ONESIGNAL_APP_ID           (e0c5b8b4-beec-4e44-b251-aa2f34c2c3a4)
//   ONESIGNAL_API_KEY          (REST API Key OneSignal)

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;

// Appareils de test fixes
const TEST_ANDROID_DEVICE_ID = 'dev_mq49putd_9bluacw';
const TEST_IOS_ONESIGNAL_ID = '8411b4fd-f2d6-4b5b-adb4-ce1271a2090b';

// ---------------------------------------------------------------------------
// FCM (Android)
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
      message: { token, notification: { title, body } },
    }),
  });
  if (!res.ok) console.log('FCM error:', await res.text());
  return res.ok;
}

// ---------------------------------------------------------------------------
// OneSignal (iOS)
// ---------------------------------------------------------------------------
async function sendOneSignal(payload) {
  const res = await fetch('https://onesignal.com/api/v1/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + ONESIGNAL_API_KEY,
    },
    body: JSON.stringify({ app_id: ONESIGNAL_APP_ID, ...payload }),
  });
  const data = await res.json();
  console.log('OneSignal response:', JSON.stringify(data));
  return data;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

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

  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  if (!title || !body) return res.status(400).json({ error: 'Titre et message requis' });

  let success = 0, failure = 0;

  try {
    if (target === 'test_android') {
      // ── Test Android uniquement ──
      const tokensRes = await fetch(
        `${SUPABASE_URL}/rest/v1/push_tokens?select=token,platform&device_id=eq.${TEST_ANDROID_DEVICE_ID}`,
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
      );
      const rows = await tokensRes.json();
      const androidToken = rows.find(r => r.platform === 'android')?.token;
      if (androidToken) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        const accessToken = await getFcmAccessToken(serviceAccount);
        const ok = await sendFcm(accessToken, serviceAccount.project_id, androidToken, title, body);
        ok ? success++ : failure++;
      }
      return res.status(200).json({ success, failure, total: 1, android: 1, ios: 0 });

    } else if (target === 'test_ios') {
      // ── Test iOS uniquement ──
      const data = await sendOneSignal({
        headings: { en: title, fr: title },
        contents: { en: body, fr: body },
        include_subscription_ids: [TEST_IOS_ONESIGNAL_ID],
      });
      success = data.errors ? 0 : 1;
      failure = data.errors ? 1 : 0;
      return res.status(200).json({ success, failure, total: 1, android: 0, ios: 1 });

    } else {
      // ── Tous les utilisateurs ──
      const tokensRes = await fetch(
        `${SUPABASE_URL}/rest/v1/push_tokens?select=device_id,token,platform`,
        { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } }
      );
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

      // iOS via OneSignal — segment All avec filtre iOS
      if (iosTokens.length > 0) {
        try {
          const data = await sendOneSignal({
            headings: { en: title, fr: title },
            contents: { en: body, fr: body },
            included_segments: ['All'],
            isIos: true,
            isAndroid: false,
          });
          if (!data.errors) success += iosTokens.length;
          else failure += iosTokens.length;
        } catch (e) { failure += iosTokens.length; }
      }

      return res.status(200).json({
        success,
        failure,
        total: tokens.length,
        android: androidTokens.length,
        ios: iosTokens.length,
      });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
