#!/usr/bin/env node
/**
 * Vadrou — générateur de pages statiques SEO
 * ------------------------------------------
 * Lit les lieux validés dans Supabase et écrit /lieu/<slug>/index.html
 * à la racine du dépôt. Vercel les sert automatiquement, Capacitor les
 * ignore (il n'embarque que www/).
 *
 * Usage :
 *   node generate-pages.mjs --limit 4      # mode test
 *   node generate-pages.mjs                # tout
 *   node generate-pages.mjs --mock         # données factices, sans Supabase
 *
 * Variables d'environnement requises (sauf en --mock) :
 *   SUPABASE_URL       https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY  la clé anon (celle déjà publique dans index.html)
 *
 * Node 18+ requis (fetch natif).
 */

import { writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ───────────────────────── Configuration ─────────────────────────

const SITE = 'https://vadrou.com';
const OG_DEFAULT = `${SITE}/og-image.png`;
const SLUGS_FILE = 'data/slugs.json';
const MIN_DESCRIPTION = 100; // en dessous, la page n'a pas assez de contenu propre

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit')
  ? parseInt(args[args.indexOf('--limit') + 1], 10)
  : null;
const MOCK = args.includes('--mock');
const OUT_ROOT = args.includes('--out') ? args[args.indexOf('--out') + 1] : '.';

// ───────────────────────── Libellés ─────────────────────────
// Les valeurs stockées en base sont des codes techniques ; on les traduit
// avec les mêmes libellés que l'app, pour que le site et l'app concordent.

const LABELS_CATEGORIE = {
  jeux_ext: 'Jeux en extérieur',
  jeux_int: 'Jeux en intérieur',
  culture:  'Culture et bibliothèque',
  apero:    'Apéro parents',
  resto:    'Restaurant family-friendly',
  eau:      "Au bord de l'eau",
  musique:  'Musique et concerts',
  theatre:  'Théâtre et spectacle',
  sport:    'Sport et plein air',
  expos:    'Expositions et musées',
  sciences: 'Sciences et découverte',
  ateliers: 'Ateliers créatifs',
  nature:   'Nature et balades',
  jeux:     'Jeux',
  parents:  'Pour les parents',
};

const LABELS_AGE = {
  '0-2':  '0–2 ans',
  '3-5':  '3–5 ans',
  '6-10': '6–10 ans',
  '10+':  '10 ans et plus',
  'tout': 'tout âge',
};

const LABELS_MOMENT = {
  weekend: 'le week-end',
  semaine: 'en semaine',
  matin:   'le matin',
  midi:    'le midi',
  soir:    'en soirée',
};

/** Traduit un tableau de codes ; conserve la valeur brute si elle est inconnue. */
function traduire(codes, table) {
  return (codes || []).filter(Boolean).map(c => table[c] || c);
}

// ───────────────────────── Utilitaires ─────────────────────────

/** Transforme un nom en slug d'URL stable et lisible. */
function slugify(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // retire les accents
    .replace(/['’]/g, '')              // apostrophes collées : l'Ile -> lile
    .replace(/[()\[\]{}]/g, '')        // parenthèses : (S)pace -> Space
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

/** Échappe le texte destiné au HTML. */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Échappe pour un attribut ou une valeur JSON-LD. */
function jsonSafe(str) {
  return String(str ?? '').replace(/\s+/g, ' ').trim();
}

/** Coupe proprement une description pour la meta (155 car. max). */
function metaDesc(lieu) {
  const base = jsonSafe(lieu.description || lieu.label_redac || '');
  const lieuOu = lieu.quartier && lieu.quartier !== lieu.ville
    ? `${lieu.quartier}, ${lieu.ville}`
    : lieu.ville;
  const prefix = `${lieu.nom} à ${lieuOu}. `;
  const room = 155 - prefix.length;
  if (room < 40) return prefix.trim();
  let tail = base.slice(0, room);
  if (base.length > room) tail = tail.replace(/\s+\S*$/, '') + '…';
  return prefix + tail;
}

/** Liste lisible : ["a","b","c"] -> "a, b et c" */
function listeFr(arr) {
  const a = (arr || []).filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  return a.slice(0, -1).join(', ') + ' et ' + a[a.length - 1];
}

// ───────────────────────── Récupération des données ─────────────────────────

const MOCK_DATA = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    nom: 'Parc Bordelais',
    adresse: 'Rue du Bocage, 33200 Bordeaux',
    latitude: 44.8483, longitude: -0.6094,
    google_place_id: 'ChIJmockmockmock',
    categorie: ['jeux_ext'],
    ages: ['0-2', '3-5', '6-10'],
    moments: ['weekend', 'matin'],
    tarif: 'Gratuit',
    label_redac: 'Le grand classique des familles bordelaises',
    description: "Vingt-huit hectares de pelouses, d'allées ombragées et de jeux au cœur de Caudéran. Le Parc Bordelais reste le point de repère des familles du quartier : plusieurs aires de jeux réparties selon les âges, un petit train l'après-midi, une mare aux canards et assez d'espace pour que les vélos et les trottinettes ne gênent personne. Les arbres centenaires rendent l'endroit praticable même en plein été, ce qui est rare à Bordeaux.",
    quartier: 'Villa Primerose - Parc Bordelais - Caudéran',
    ville: 'Bordeaux',
    coup_de_coeur: true,
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    nom: 'Étang de Cousseau',
    adresse: 'Réserve naturelle, 33121 Carcans',
    latitude: 44.9331, longitude: -1.1408,
    google_place_id: null,
    categorie: ['nature', 'jeux_int'],
    ages: ['6-10', '10+'],
    moments: ['weekend'],
    tarif: 'Gratuit',
    label_redac: null,
    description: "Une réserve naturelle entre Lacanau et Carcans, accessible seulement à pied ou à vélo, ce qui explique le calme qu'on y trouve même en août. Le sentier depuis le parking du Marmande fait environ cinq kilomètres aller-retour, plat et sableux, faisable avec des enfants habitués à marcher. On y croise des vaches marines en liberté, des libellules par centaines et, avec un peu de patience, des cistudes sur les troncs. Prévoir de l'eau : il n'y a aucun point de ravitaillement.",
    quartier: 'Carcans',
    ville: 'Carcans',
    coup_de_coeur: false,
  },
];

async function fetchLieux() {
  if (MOCK) return MOCK_DATA;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error('✖ SUPABASE_URL et SUPABASE_ANON_KEY sont requis (ou --mock).');
    process.exit(1);
  }

  const endpoint = new URL(`${url}/rest/v1/lieux`);
  endpoint.searchParams.set('select', '*');
  endpoint.searchParams.set('valide', 'eq.true');
  endpoint.searchParams.set('order', 'nom.asc');

  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`✖ Supabase a répondu ${res.status} : ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

// ───────────────────────── Slugs stables ─────────────────────────

/**
 * Charge la table id -> slug si elle existe, complète avec les nouveaux
 * lieux, et garantit qu'un slug déjà attribué ne change jamais — même
 * si le nom du lieu est modifié plus tard.
 */
async function resolveSlugs(lieux) {
  let map = {};
  if (existsSync(SLUGS_FILE)) {
    try { map = JSON.parse(await readFile(SLUGS_FILE, 'utf8')); }
    catch { map = {}; }
  }

  const used = new Set(Object.values(map));
  let nouveaux = 0;

  for (const l of lieux) {
    if (map[l.id]) continue;
    let base = slugify(l.nom);
    if (!base) base = 'lieu';
    let slug = base;
    if (used.has(slug) && l.ville) slug = `${base}-${slugify(l.ville)}`;
    let n = 2;
    while (used.has(slug)) slug = `${base}-${n++}`;
    map[l.id] = slug;
    used.add(slug);
    nouveaux++;
  }

  await mkdir(dirname(SLUGS_FILE), { recursive: true });
  await writeFile(SLUGS_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
  return { map, nouveaux };
}

// ───────────────────────── Gabarit ─────────────────────────

const CSS = `
:root{
  --forest:#1E3A2F; --forest2:#2D5241; --forest3:#3D6B57;
  --cream:#F6F1E9; --cream2:#EDE6D8; --sand:#D9CFC0;
  --terracotta:#C4622D; --gold:#C9A84C; --gold2:#E8C46A;
  --charcoal:#1A1A18; --muted:#7A7570; --white:#FDFAF5;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  font-family:'DM Sans',system-ui,sans-serif;
  background:var(--cream); color:var(--charcoal);
  line-height:1.6; font-size:17px;
}
a{color:var(--forest2)}
a:focus-visible,button:focus-visible{outline:2px solid var(--terracotta);outline-offset:3px}

.wrap{max-width:44rem;margin:0 auto;padding:0 1.5rem}

/* ── Bandeau ── */
.topbar{background:var(--forest);padding:1rem 0}
.topbar .wrap{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.mark{font-family:Fraunces,Georgia,serif;font-size:1.45rem;font-weight:600;
  color:var(--cream);text-decoration:none;letter-spacing:-.01em}
.mark em{font-style:italic;font-weight:300;color:var(--gold2)}
.topbar a.retour{color:var(--sand);font-size:.9rem;text-decoration:none}
.topbar a.retour:hover{color:var(--gold2)}

/* ── Titre ── */
header.hero{padding:3rem 0 1.5rem}
.fil{font-size:.88rem;color:var(--muted);margin-bottom:1.25rem}
.fil a{color:var(--muted)}
h1{font-family:Fraunces,Georgia,serif;font-weight:600;
  font-size:clamp(2rem,6vw,3rem);line-height:1.12;
  letter-spacing:-.02em;color:var(--forest)}
.chapeau{font-family:Fraunces,Georgia,serif;font-style:italic;font-weight:300;
  font-size:1.2rem;color:var(--forest3);margin-top:.85rem;line-height:1.45}
.coeur{display:inline-block;font-size:.8rem;color:var(--terracotta);
  margin-top:1rem;padding:.2rem .6rem;border:1px solid var(--terracotta);border-radius:2rem}

/* ── Corps ── */
.texte{padding:.5rem 0 2rem;font-size:1.08rem}
.texte p+p{margin-top:1rem}

/* ── Infos pratiques ── */
.infos{border-top:1px solid var(--sand);padding:1.75rem 0}
.infos dl{display:grid;grid-template-columns:8.5rem 1fr;gap:.7rem 1.25rem}
.infos dt{color:var(--muted);font-size:.93rem}
.infos dd{font-size:.98rem}
@media (max-width:520px){
  .infos dl{grid-template-columns:1fr;gap:.15rem}
  .infos dt{margin-top:.85rem}
}

/* ── Appel à l'action ── */
.cta{background:var(--forest);color:var(--cream);padding:2.25rem 0;margin-top:1rem}
.cta h2{font-family:Fraunces,Georgia,serif;font-size:1.4rem;font-weight:600;
  color:var(--white);margin-bottom:.5rem}
.cta p{color:var(--sand);font-size:.98rem;max-width:32rem}
.cta .bouton{display:inline-block;margin-top:1.25rem;background:var(--gold2);
  color:var(--forest);font-weight:500;text-decoration:none;
  padding:.7rem 1.4rem;border-radius:.4rem}
.cta .bouton:hover{background:var(--gold)}

footer{padding:2rem 0 3rem;font-size:.88rem;color:var(--muted)}
footer a{color:var(--muted)}
`;

function renderLieu(lieu, slug) {
  const url = `${SITE}/lieu/${slug}`;
  const lieuOu = lieu.quartier && lieu.quartier !== lieu.ville
    ? `${lieu.quartier}, ${lieu.ville}`
    : lieu.ville;
  const titre = `${lieu.nom} — ${lieuOu} | Vadrou`;
  const desc = metaDesc(lieu);

  // Paragraphes : on respecte les sauts de ligne de la description
  const paras = String(lieu.description || '')
    .split(/\n{1,}/).map(s => s.trim()).filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`).join('\n        ');

  const mapsUrl = lieu.google_place_id
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lieu.nom)}&query_place_id=${lieu.google_place_id}`
    : (lieu.latitude && lieu.longitude
        ? `https://www.google.com/maps/search/?api=1&query=${lieu.latitude},${lieu.longitude}`
        : null);

  const lignes = [];
  if (lieu.adresse) {
    lignes.push(['Adresse', mapsUrl
      ? `${esc(lieu.adresse)}<br><a href="${mapsUrl}" rel="noopener nofollow" target="_blank">Ouvrir dans Google Maps</a>`
      : esc(lieu.adresse)]);
  }
  if (lieu.tarif) lignes.push(['Tarif', esc(lieu.tarif)]);
  // Valeurs d'un tableau d'infos : simple virgule. Un « et » final entrerait
  // en collision avec les libellés qui en contiennent déjà (« Nature et balades »).
  if (lieu.ages?.length) lignes.push(['Âges', esc(traduire(lieu.ages, LABELS_AGE).join(', '))]);
  if (lieu.moments?.length) lignes.push(['Quand y aller', esc(traduire(lieu.moments, LABELS_MOMENT).join(', '))]);
  if (lieu.categorie?.length) lignes.push(['Type de sortie', esc(traduire(lieu.categorie, LABELS_CATEGORIE).join(', '))]);

  const infos = lignes.length
    ? `<section class="infos"><div class="wrap"><dl>
        ${lignes.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('\n        ')}
      </dl></div></section>`
    : '';

  // ── Données structurées ──
  const place = {
    '@context': 'https://schema.org',
    '@type': 'Place',
    '@id': `${url}#place`,
    name: jsonSafe(lieu.nom),
    url,
    description: jsonSafe(lieu.description),
  };
  if (lieu.adresse) {
    place.address = {
      '@type': 'PostalAddress',
      streetAddress: jsonSafe(lieu.adresse),
      addressLocality: jsonSafe(lieu.ville),
      addressRegion: 'Gironde',
      addressCountry: 'FR',
    };
  }
  if (lieu.latitude && lieu.longitude) {
    place.geo = { '@type': 'GeoCoordinates', latitude: lieu.latitude, longitude: lieu.longitude };
  }
  if (lieu.tarif && /gratuit/i.test(lieu.tarif)) place.isAccessibleForFree = true;

  const fil = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Vadrou', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: jsonSafe(lieu.ville), item: `${SITE}/` },
      { '@type': 'ListItem', position: 3, name: jsonSafe(lieu.nom), item: url },
    ],
  };

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titre)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">

<meta property="og:type" content="article">
<meta property="og:site_name" content="Vadrou">
<meta property="og:locale" content="fr_FR">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(lieu.nom)} — ${esc(lieuOu)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${OG_DEFAULT}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>${CSS}</style>

<script type="application/ld+json">${JSON.stringify(place)}</script>
<script type="application/ld+json">${JSON.stringify(fil)}</script>
</head>
<body>

<div class="topbar"><div class="wrap">
  <a class="mark" href="${SITE}/">Vad<em>rou</em></a>
  <a class="retour" href="${SITE}/">Toutes les sorties</a>
</div></div>

<header class="hero"><div class="wrap">
  <nav class="fil" aria-label="Fil d'Ariane">
    <a href="${SITE}/">Vadrou</a> &rsaquo; ${esc(lieu.ville)}
  </nav>
  <h1>${esc(lieu.nom)}</h1>
  ${lieu.label_redac ? `<p class="chapeau">${esc(lieu.label_redac)}</p>` : ''}
  ${lieu.coup_de_coeur ? `<p class="coeur">Coup de cœur Vadrou</p>` : ''}
</div></header>

${paras ? `<section class="texte"><div class="wrap">
        ${paras}
</div></section>` : ''}

${infos}

<section class="cta"><div class="wrap">
  <h2>Retrouvez ce lieu dans Vadrou</h2>
  <p>Vadrou rassemble plus de 400 sorties en famille à Bordeaux, sur le Bassin d'Arcachon
     et en Gironde. Filtrez par âge, par moment de la journée et par quartier. Gratuit,
     collaboratif, sans publicité.</p>
  <a class="bouton" href="${SITE}/">Explorer les sorties</a>
</div></section>

<footer><div class="wrap">
  <a href="${SITE}/">Vadrou</a> — sorties en famille en Gironde ·
  <a href="${SITE}/privacy-policy">Confidentialité</a>
</div></footer>

</body>
</html>
`;
}

// ───────────────────────── Sitemap ─────────────────────────

function renderSitemap(entrees) {
  const lignes = entrees.map(e => [
    '  <url>',
    `    <loc>${e.loc}</loc>`,
    e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>` : null,
    e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>` : null,
    e.priority ? `    <priority>${e.priority}</priority>` : null,
    '  </url>',
  ].filter(Boolean).join('\n')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${lignes}
</urlset>
`;
}

/** created_at -> 2026-09-12 */
function jour(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// ───────────────────────── Exécution ─────────────────────────

const tous = await fetchLieux();

const eligibles = tous.filter(l =>
  l.nom && l.description && l.description.trim().length >= MIN_DESCRIPTION
);
const ecartes = tous.length - eligibles.length;

const { map: slugs, nouveaux } = await resolveSlugs(eligibles);
const aGenerer = LIMIT ? eligibles.slice(0, LIMIT) : eligibles;

// ── Écriture des pages ──
const vivants = new Set();
for (const lieu of aGenerer) {
  const slug = slugs[lieu.id];
  vivants.add(slug);
  const dossier = join(OUT_ROOT, 'lieu', slug);
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, 'index.html'), renderLieu(lieu, slug), 'utf8');
}

// ── Purge des pages orphelines ──
// Un lieu supprimé ou dévalidé dans Supabase ne doit plus avoir de page :
// sinon elle reste indexée indéfiniment. Jamais en mode --limit, qui ne
// voit qu'une partie des lieux.
let purgees = 0;
if (!LIMIT) {
  const racineLieu = join(OUT_ROOT, 'lieu');
  let existants = [];
  try {
    existants = (await readdir(racineLieu, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name);
  } catch { /* le dossier n'existe pas encore */ }

  for (const nom of existants) {
    if (!vivants.has(nom)) {
      await rm(join(racineLieu, nom), { recursive: true, force: true });
      purgees++;
      console.log(`  purge /lieu/${nom}`);
    }
  }
}

// ── Sitemap ──
if (!LIMIT) {
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const entrees = [
    { loc: `${SITE}/`, lastmod: aujourdhui, changefreq: 'daily', priority: '1.0' },
    ...aGenerer.map(l => ({
      loc: `${SITE}/lieu/${slugs[l.id]}`,
      lastmod: jour(l.created_at),
      changefreq: 'monthly',
      priority: '0.7',
    })),
    { loc: `${SITE}/privacy-policy`, changefreq: 'yearly', priority: '0.1' },
  ];
  await writeFile(join(OUT_ROOT, 'sitemap.xml'), renderSitemap(entrees), 'utf8');
}

// ── Récapitulatif ──
console.log('');
console.log(`Lieux validés en base ......... ${tous.length}`);
console.log(`Écartés (description < ${MIN_DESCRIPTION}) ... ${ecartes}`);
console.log(`Éligibles .................... ${eligibles.length}`);
console.log(`Nouveaux slugs attribués ..... ${nouveaux}`);
console.log(`Pages écrites ................ ${aGenerer.length}${LIMIT ? ` (limite ${LIMIT})` : ''}`);
if (!LIMIT) {
  console.log(`Pages purgées ................ ${purgees}`);
  console.log(`Sitemap ...................... ${aGenerer.length + 2} URL`);
}
