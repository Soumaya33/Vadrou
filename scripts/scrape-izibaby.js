// ============================================================
// VADROU — Scraper Izibaby Bordeaux → Supabase
// Récupère les ateliers bébé/enfants et leurs prochaines dates
//
// Usage :
//   node scrape-izibaby.js           → CSV uniquement
//   node scrape-izibaby.js --insert  → CSV + Supabase
//   node scrape-izibaby.js --debug   → affiche les données brutes
//
// Prérequis :
//   npm install puppeteer
// ============================================================

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('fs');

const SUPABASE_URL = 'https://xwykpuytwjiwuxhpeqrt.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3eWtwdXl0d2ppd3V4aHBlcXJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NDc2OTUsImV4cCI6MjA5MzQyMzY5NX0.eOwSEwEuKChEV-oygJkpimKPO7vT4aiHm7oPiKYveGE';

const INSERT_TO_SUPABASE = process.argv.includes('--insert');
const DEBUG              = process.argv.includes('--debug');
const CSV_FILE           = `vadrou_izibaby_${new Date().toISOString().slice(0,10)}.csv`;
const TODAY              = new Date().toISOString().split('T')[0];

const LISTING_URL = 'https://izibaby.fr/ateliers/bordeaux';

// Catégories Izibaby → catégories Vadrou
const CAT_MAP = {
  'baby-gym':                   'ateliers',
  'eveil-corporel-bebe':        'ateliers',
  'eveil-corporel':             'ateliers',
  'massage-bebe':               'ateliers',
  'portage-bebe':               'ateliers',
  'yoga-prenatal':              'parents',
  'yoga-postnatal':             'parents',
  'yoga-maman-bebe':            'ateliers',
  'eveil-musical-bebe':         'ateliers',
  'eveil-a-la-nature':          'nature',
  'peinture-bebe':              'ateliers',
  'montessori-et-jeu-libre':    'jeux',
  'bebe-signe':                 'ateliers',
  'diversification-alimentaire':'parents',
  'salle-sensorielle':          'ateliers',
  'chant-prenatal':             'parents',
  'bebes-nageurs':              'ateliers',
  'mediation-culturelle':       'ateliers',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── FORMATAGE DATE ───────────────────────────────────────────
function parseIzibabyDate(str) {
  if (!str) return null;
  // Formats possibles : "15 mai 2026", "15/05/2026", "2026-05-15"
  const MOIS = { 'janvier':1,'février':2,'fevrier':2,'mars':3,'avril':4,
    'mai':5,'juin':6,'juillet':7,'août':8,'aout':8,'septembre':9,
    'octobre':10,'novembre':11,'décembre':12,'decembre':12 };

  // Format "15 mai 2026"
  const m1 = str.match(/(\d{1,2})\s+([a-záàâéèêîïôùûüç]+)\s+(\d{4})/i);
  if (m1) {
    const mNum = MOIS[m1[2].toLowerCase()];
    if (mNum) return `${m1[3]}-${String(mNum).padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  }
  // Format "15/05/2026"
  const m2 = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
  // Format ISO
  const m3 = str.match(/(\d{4}-\d{2}-\d{2})/);
  if (m3) return m3[1];
  return null;
}

function guessCategory(slug, nom) {
  for (const [key, cat] of Object.entries(CAT_MAP)) {
    if (slug.includes(key) || nom.toLowerCase().includes(key.replace(/-/g,' '))) return cat;
  }
  return 'ateliers';
}

// ── SCRAPING AVEC PUPPETEER ──────────────────────────────────
async function scrapeIzibaby() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch(e) {
    console.error('❌ Puppeteer non installé. Lance : npm install puppeteer');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=fr-FR'],
  });

  const ateliers = [];

  try {
    // ── ÉTAPE 1 : Page listing → récupérer les URLs des ateliers ──
    console.log('\n[1/3] Chargement de la page listing izibaby Bordeaux…');
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
    await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Extraire tous les liens /atelier/bordeaux-*
    const atelierUrls = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/atelier/bordeaux"]'));
      return [...new Set(links.map(l => l.href).filter(h => h.includes('/atelier/bordeaux')))];
    });

    console.log(`   → ${atelierUrls.length} ateliers trouvés`);

    if (atelierUrls.length === 0) {
      // Fallback : construire les URLs depuis les catégories connues
      console.log('   → Fallback : URLs construites depuis les sous-catégories');
      const CATEGORIES_BDX = [
        'baby-gym', 'eveil-corporel-bebe', 'massage-bebe',
        'portage-bebe', 'yoga-prenatal',
      ];
      for (const cat of CATEGORIES_BDX) {
        atelierUrls.push(`${LISTING_URL}/${cat}`);
      }
    }

    // ── ÉTAPE 2 : Scraper chaque fiche atelier ──
    console.log('\n[2/3] Scraping des fiches ateliers…\n');

    for (let i = 0; i < atelierUrls.length; i++) {
      const url = atelierUrls[i];
      const slug = url.split('/atelier/')[1] || url.split('/ateliers/bordeaux/')[1] || '';

      process.stdout.write(`  [${i+1}/${atelierUrls.length}] ${slug.slice(0,50)}… `);

      try {
        const p = await browser.newPage();
        await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
        // Intercepter TOUTES les réponses JSON — avant le goto
        const apiResponses = [];
        const allNetworkUrls = [];

        p.on('response', async response => {
          const respUrl = response.url();
          allNetworkUrls.push(respUrl);
          try {
            const ct = response.headers()['content-type'] || '';
            if (ct.includes('json') || ct.includes('javascript')) {
              const text = await response.text().catch(() => '');
              // Chercher des dates ISO dans toute réponse JSON/JS
              if (text.includes('T') && (text.includes('date') || text.includes('start') || text.includes('slot') || text.includes('session'))) {
                apiResponses.push({ url: respUrl, text: text.slice(0, 5000) });
              }
            }
          } catch(e) {}
        });

        await p.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
        await sleep(3000);
        // Scroller pour déclencher le lazy loading du calendrier
        await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await sleep(1000);
        await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(2000);

        if (DEBUG) {
          console.log('\nURLs réseau interceptées:', allNetworkUrls.slice(0, 20));
          if (apiResponses.length > 0) {
            console.log('\nRéponses JSON avec dates:');
            apiResponses.forEach(r => console.log('  ', r.url, '\n  ', r.text.slice(0, 300)));
          }
        }

        const data = await p.evaluate(() => {
          const nom = document.querySelector('h1')?.textContent?.trim() || '';
          // Description depuis window.__NUXT__ (données Apollo/GraphQL)
          let description = '';
          try {
            // Chercher le bloc __NUXT__ dans les scripts
            const scripts = Array.from(document.querySelectorAll('script:not([src])'));
            for (const s of scripts) {
              const txt = s.textContent || '';
              // Chercher "description" suivi d'un contenu HTML (\u003C = <)
              const idx = txt.indexOf('"description":"\\u003C');
              if (idx !== -1) {
                // Extraire jusqu'à la prochaine virgule ou accolade hors string
                let end = idx + 16;
                let depth = 0;
                while (end < txt.length) {
                  if (txt[end] === '"' && txt[end-1] !== '\\') break;
                  end++;
                }
                const raw = txt.slice(idx + 15, end);
                description = raw
                  .replace(/\\u003C/gi, '<').replace(/\\u003E/gi, '>')
                  .replace(/\\u00e9/gi, 'é').replace(/\\u00e0/gi, 'à')
                  .replace(/\\u00ea/gi, 'ê').replace(/\\u00e8/gi, 'è')
                  .replace(/\\u00ef/gi, 'ï').replace(/\\u00ee/gi, 'î')
                  .replace(/\\u00f4/gi, 'ô').replace(/\\u00fb/gi, 'û')
                  .replace(/\\u00e2/gi, 'â').replace(/\\u0027/gi, "'")
                  .replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ').trim()
                  .slice(0, 600);
                if (description.length > 20) break;
              }
            }
          } catch(e) {}

          // Fallback : texte visible de la page (section description)
          if (!description || description.length < 20) {
            // Le texte de description est visible dans le bodyText entre le nom et "À propos"
            const bt = document.body.textContent;
            const nomEl = document.querySelector('h1');
            const nom2 = nomEl?.textContent?.trim() || '';
            if (nom2) {
              const afterNom = bt.slice(bt.indexOf(nom2) + nom2.length);
              const beforeApropos = afterNom.split('À propos')[0].split('Voir plus')[0];
              const cleaned = beforeApropos
                .replace(/Bordeaux.*?min/s, '') // supprimer ville+durée
                .replace(/\s+/g, ' ').trim();
              if (cleaned.length > 30) description = cleaned.slice(0, 600);
            }
          }
          // Adresse depuis les données NUXT embeddées dans le bodyText
          let adresse = '';
          const bodyHtml = document.body.innerHTML;
          // Chercher "address":"XX rue..." dans les données JSON de la page
          const addrMatch = bodyHtml.match(/"address":"([^"]+)"/);
          const postalMatch = bodyHtml.match(/"postal_code":"([^"]+)"/);
          const cityMatch = bodyHtml.match(/"city_name":"([^"]+)"/);
          const districtMatch = bodyHtml.match(/"district":"([^"]+)"/);
          if (addrMatch) {
            adresse = addrMatch[1];
            if (postalMatch && cityMatch) {
              adresse += ', ' + postalMatch[1] + ' ' + cityMatch[1].trim();
              if (districtMatch && districtMatch[1] && districtMatch[1] !== 'null') {
                adresse += ' - ' + districtMatch[1];
              }
            }
          }
          // Fallback sélecteur DOM
          if (!adresse) {
            const adresseEl = document.querySelector('[class*="address"], [class*="location"]');
            adresse = adresseEl?.textContent?.trim() || '';
          }
          const bodyText = document.body.textContent;
          const prixMatch = bodyText.match(/(\d+)\s*€/);
          const tarif = prixMatch ? `${prixMatch[1]}€` : null;

          // Coordonnées GPS depuis les données NUXT
          const lngMatch = bodyHtml.match(/"lng":(-?\d+\.\d+)/);
          const latMatch = bodyHtml.match(/"lat":(\d+\.\d+)/);
          const lat = latMatch ? parseFloat(latMatch[1]) : null;
          const lng = lngMatch ? parseFloat(lngMatch[1]) : null;

          // Dates dans TOUT le HTML après chargement complet
          const dateTexts = [];
          document.querySelectorAll('time').forEach(el => {
            const dt = el.getAttribute('datetime') || el.textContent.trim();
            if (dt) dateTexts.push(dt);
          });
          document.querySelectorAll('[data-date],[data-start],[data-slot]').forEach(el => {
            const dt = el.getAttribute('data-date') || el.getAttribute('data-start') || el.getAttribute('data-slot');
            if (dt) dateTexts.push(dt);
          });
          // Patterns ISO dans le HTML brut
          const html = document.body.innerHTML;
          const isoPatterns = html.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) || [];
          dateTexts.push(...isoPatterns);
          // Dates françaises dans le texte visible
          const frDates = bodyText.match(/\d{1,2}\s+(?:janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4}/gi) || [];
          dateTexts.push(...frDates);

          const ageText = bodyText;
          // Image depuis S3 (izibaby-bucket) — URL directe dans le réseau
          const s3Imgs = Array.from(document.querySelectorAll('img[src*="izibaby-bucket"]'));
          let imageUrl = s3Imgs.length > 0 ? s3Imgs[0].src : null;

          // Fallback : chercher le content_path dans le bodyText (données NUXT)
          if (!imageUrl) {
            const bodyHtml = document.body.innerHTML;
            const s3Match = bodyHtml.match(/izibaby-bucket[^"'\s]+\.jpg/);
            if (s3Match) imageUrl = 'https://' + s3Match[0];
          }

          // Fallback og:image
          if (!imageUrl) {
            const og = document.querySelector('meta[property="og:image"]');
            if (og) imageUrl = og.getAttribute('content');
          }
          const jldEls = document.querySelectorAll('script[type="application/ld+json"]');
          const jlds = [];
          jldEls.forEach(el => { try { jlds.push(JSON.parse(el.textContent)); } catch(e) {} });

          return { nom, description, adresse, tarif, dateTexts: [...new Set(dateTexts)], ageText, imageUrl, jlds, url: window.location.href, bodyText: bodyText.slice(0, 3000), lat, lng };
        });

        if (DEBUG) console.log('\nDEBUG data:', JSON.stringify(data, null, 2));

        let dateDebut = null, heure = null;

        // 1. Depuis les réponses API interceptées
        for (const api of apiResponses) {
          const isoMatches = (api.text || '').match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) || [];
          const futureDates = isoMatches
            .map(iso => {
              try {
                const d = new Date(iso);
                return { dateStr: d.toISOString().split('T')[0], h: d.getHours(), mn: d.getMinutes() };
              } catch(e) { return null; }
            })
            .filter(d => d && d.dateStr >= TODAY)
            .sort((a, b) => a.dateStr.localeCompare(b.dateStr));

          if (futureDates.length > 0) {
            dateDebut = futureDates[0].dateStr;
            if (futureDates[0].h > 0 || futureDates[0].mn > 0) {
              heure = `${String(futureDates[0].h).padStart(2,'0')}h${String(futureDates[0].mn).padStart(2,'0')}`;
            }
            break;
          }
        }

        // 2. Depuis JSON-LD
        if (!dateDebut) {
          for (const jld of data.jlds) {
            const items = Array.isArray(jld) ? jld : [jld];
            for (const item of items) {
              if (item['@type'] === 'Event' && item.startDate) {
                // Corriger "+00" → "+00:00" pour que new Date() fonctionne
                const fixedDate = item.startDate.replace(/([+-]\d{2})$/, '$1:00');
                const d = new Date(fixedDate);
                if (isNaN(d.getTime())) continue;
                const dateStr = d.toISOString().split('T')[0];
                if (dateStr >= TODAY) {
                  dateDebut = dateStr;
                  // Heure locale France (UTC+2 en été)
                  const localH = d.getUTCHours() + 2; // approximation heure française
                  const localMn = d.getUTCMinutes();
                  if (localH > 0 || localMn > 0) heure = `${String(localH % 24).padStart(2,'0')}h${String(localMn).padStart(2,'0')}`;
                  break;
                }
              }
            }
            if (dateDebut) break;
          }
        }

        // 3. Depuis les textes de dates dans la page
        if (!dateDebut && data.dateTexts.length > 0) {
          const isoDates = data.dateTexts
            .filter(t => /^\d{4}-\d{2}-\d{2}/.test(t))
            .map(t => ({ str: t.slice(0,10), full: t }))
            .filter(t => t.str >= TODAY)
            .sort((a, b) => a.str.localeCompare(b.str));

          if (isoDates.length > 0) {
            dateDebut = isoDates[0].str;
            const heureMatch = isoDates[0].full.match(/T(\d{2}):(\d{2})/);
            if (heureMatch) heure = `${heureMatch[1]}h${heureMatch[2]}`;
          }

          if (!dateDebut) {
            for (const t of data.dateTexts) {
              const parsed = parseIzibabyDate(t);
              if (parsed && parsed >= TODAY) {
                dateDebut = parsed;
                const heureMatch = t.match(/(\d{1,2})h(\d{0,2})/);
                if (heureMatch) heure = `${heureMatch[1].padStart(2,'0')}h${(heureMatch[2]||'00').padStart(2,'0')}`;
                break;
              }
            }
          }
        }

        // Âge — parser depuis nom ET texte de la page
        let ageMin = null, ageMax = null;

        function parseAgeStr(str) {
          if (!str) return null;
          // Normaliser : "yo" → "ans", "months" → "mois", "month" → "mois"
          const s = str.toLowerCase()
            .replace(/\byo\b/g, 'ans').replace(/\byears?\b/g, 'ans')
            .replace(/\bmonths?\b/g, 'mois').replace(/\bmo\b/g, 'mois');

          // Convertir en années entières
          function toYears(val, unit) {
            if (unit.includes('mois')) return Math.floor(parseInt(val) / 12); // floor pour min
            return parseInt(val);
          }
          function toYearsMax(val, unit) {
            if (unit.includes('mois')) return Math.ceil(parseInt(val) / 12); // ceil pour max
            return parseInt(val);
          }

          // Format "X mois - Y ans" ou "X-Y mois" ou "X ans - Y ans"
          const m = s.match(/(\d+)\s*(mois|ans?)\s*[-–à]\s*(\d+)\s*(mois|ans?)/i);
          if (m) {
            return { min: toYears(m[1], m[2]), max: toYearsMax(m[3], m[4]) };
          }
          // Format "X-Y mois" ou "X-Y ans"
          const m2 = s.match(/(\d+)\s*-\s*(\d+)\s*(mois|ans?)/i);
          if (m2) {
            return { min: toYears(m2[1], m2[3]), max: toYearsMax(m2[2], m2[3]) };
          }
          // Format "dès X ans/mois"
          const m3 = s.match(/dès?\s*(\d+)\s*(mois|ans?)/i);
          if (m3) return { min: toYears(m3[1], m3[2]), max: null };
          // Format "+X mois" ou "X mois minimum"
          const m4 = s.match(/(\d+)\s*(mois|ans?)\s*(?:\+|min|et\s*\+)/i);
          if (m4) return { min: toYears(m4[1], m4[2]), max: null };
          return null;
        }

        // D'abord chercher dans le nom (entre parenthèses)
        const nomAgeMatch = data.nom.match(/\(([^)]+)\)/);
        if (nomAgeMatch) {
          const parsed = parseAgeStr(nomAgeMatch[1]);
          if (parsed) { ageMin = parsed.min; ageMax = parsed.max; }
        }

        // Sinon chercher dans le texte complet de la page
        if (ageMin === null) {
          const parsed = parseAgeStr(data.bodyText || data.ageText || '');
          if (parsed) { ageMin = parsed.min; ageMax = parsed.max; }
        }

        const nom = data.nom || slug.replace(/-/g, ' ');
        const cat = guessCategory(slug, nom);

        // Adresse : nettoyer
        let adresse = data.adresse;
        if (!adresse || adresse.length < 5) adresse = 'Bordeaux';
        else if (!adresse.toLowerCase().includes('bordeaux')) adresse += ', Bordeaux';

        const evt = {
          nom,
          adresse,
          latitude:        data.lat || null,
          longitude:       data.lng || null,
          date_debut:      dateDebut,
          date_fin:        null,
          heure,
          categorie:       cat,
          age_min:         ageMin,
          age_max:         ageMax,
          description:     data.description?.slice(0, 600) || null,
          tarif:           data.tarif,
          image_url:       data.imageUrl || null,
          lien_reservation: url,
          lien_evenement:   url,
          valide:          false,
        };

        ateliers.push(evt);
        process.stdout.write(`✅ ${nom.slice(0,40)} ${dateDebut ? '(' + dateDebut + ')' : '(sans date)'}\n`);
        await p.close();

      } catch(e) {
        process.stdout.write(`⚠️  ${e.message.slice(0,60)}\n`);
      }

      await sleep(800);
    }

  } finally {
    await browser.close();
  }

  return ateliers;
}

// ── CSV ──────────────────────────────────────────────────────
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/\r?\n/g, ' ').trim();
  return (str.includes(';') || str.includes('"')) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

const CSV_HEADER = 'nom;date_debut;heure;adresse;categorie;age_min;age_max;tarif;description;image_url;lien_reservation;valide';
const buildCsvRow = r => [
  r.nom, r.date_debut, r.heure, r.adresse, r.categorie,
  r.age_min, r.age_max, r.tarif,
  r.description?.slice(0,200), r.image_url, r.lien_reservation, 'false'
].map(escapeCsv).join(';');

// ── SUPABASE ─────────────────────────────────────────────────
async function upsertEvent(evt) {
  const existing = await fetch(
    `${SUPABASE_URL}/rest/v1/evenements?nom=eq.${encodeURIComponent(evt.nom)}&select=id,date_debut&limit=1`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
  ).then(r => r.json()).then(rows => rows[0] || null).catch(() => null);

  if (existing) {
    // Mettre à jour la date si la nouvelle est dans le futur
    const existingPast = !existing.date_debut || existing.date_debut < TODAY;
    const newFuture    = evt.date_debut && evt.date_debut >= TODAY;
    if (!existingPast || !newFuture) return 'skipped';

    const patch = {
      date_debut: evt.date_debut, heure: evt.heure,
      adresse: evt.adresse, description: evt.description,
      tarif: evt.tarif, image_url: evt.image_url,
      lien_reservation: evt.lien_reservation,
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/evenements?id=eq.${existing.id}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(patch),
    });
    return res.ok ? 'updated' : 'error';
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/evenements`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(evt),
  });
  return res.ok ? 'ok' : 'error';
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('\n🍼 Scraper Izibaby → Vadrou');
  console.log(INSERT_TO_SUPABASE ? '   Mode : CSV + Supabase\n' : '   Mode : CSV uniquement\n');

  const ateliers = await scrapeIzibaby();

  if (ateliers.length === 0) {
    console.log('\n❌ Aucun atelier récupéré.');
    return;
  }

  // CSV
  fs.writeFileSync(CSV_FILE, '\uFEFF' + [CSV_HEADER, ...ateliers.map(buildCsvRow)].join('\n'), 'utf8');
  console.log(`\n[3/3] CSV : ${CSV_FILE} — ${ateliers.length} ateliers`);
  console.log('   → Vérifie dans Excel, puis relance avec --insert\n');

  // Supabase
  if (INSERT_TO_SUPABASE && ateliers.length > 0) {
    console.log(`🚀 Insertion de ${ateliers.length} ateliers…\n`);
    let ins = 0, upd = 0, skip = 0, err = 0;
    for (const evt of ateliers) {
      const r = await upsertEvent(evt);
      if      (r === 'ok')      { ins++;  console.log(`  ✅ ${evt.nom.slice(0,55)}`); }
      else if (r === 'updated') { upd++;  console.log(`  ↻  ${evt.nom.slice(0,55)}`); }
      else if (r === 'skipped') { skip++; }
      else                      { err++;  console.log(`  ❌ ${evt.nom.slice(0,55)}`); }
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`\n✅ Insérés: ${ins} | Mis à jour: ${upd} | Déjà à jour: ${skip} | Erreurs: ${err}`);
    console.log('   Pense à valider dans l\'admin Vadrou !\n');
  }
}

main().catch(console.error);
