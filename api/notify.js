// api/notify.js — Notification email pour les propositions de lieux/événements
// Vercel serverless function — appelée depuis l'app après un INSERT réussi.

const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST uniquement' });
  }

  const { type, nom, adresse, categorie, description, date_debut, date_fin, heure, lien } = req.body || {};

  if (!type || !nom) {
    return res.status(400).json({ error: 'type et nom requis' });
  }

  // Construire le contenu de l'email
  const isEvent = type === 'evenement';
  const emoji = isEvent ? '🎉' : '📍';
  const label = isEvent ? 'événement' : 'lieu';

  const lignes = [`Nom : ${nom}`];
  if (adresse) lignes.push(`Adresse : ${adresse}`);
  if (categorie) lignes.push(`Catégorie(s) : ${Array.isArray(categorie) ? categorie.join(', ') : categorie}`);
  if (date_debut) lignes.push(`Date début : ${date_debut}`);
  if (date_fin) lignes.push(`Date fin : ${date_fin}`);
  if (heure) lignes.push(`Heure : ${heure}`);
  if (lien) lignes.push(`Lien : ${lien}`);
  if (description) lignes.push(`\nCommentaire :\n${description}`);
  lignes.push('\n—\nVa sur vadrou.com/admin pour valider ou rejeter cette proposition.');

  const subject = `${emoji} Vadrou — Nouveau ${label} proposé : ${nom}`;
  const text = lignes.join('\n');

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: 'bahrisoumaya@gmail.com',
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `Vadrou App <bahrisoumaya@gmail.com>`,
      to: 'bahrisoumaya@gmail.com',
      subject,
      text,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
    return res.status(500).json({ error: 'Envoi email échoué' });
  }
};
