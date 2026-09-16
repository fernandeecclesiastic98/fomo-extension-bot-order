/**
 * Veille longue : relève l'état de l'extension toutes les minutes et l'écrit dans
 * `data/veille-ordres.csv`, pour répondre par des mesures à « est-ce que mon ordre sera encore
 * surveillé dans 48 h ? ».
 *
 * Prérequis : Brave lancé avec `--remote-debugging-port=9222`, extension installée
 * (brave://extensions → Mode développeur → Charger l'extension non empaquetée), au moins un ordre
 * armé (un seuil inatteignable suffit : il ne s'exécutera jamais mais reste surveillé).
 *
 * Usage : node scripts/veille-longue.mjs [minutes]
 * Chaque changement d'état est aussi imprimé sur la sortie standard.
 */
import puppeteer from 'puppeteer';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const FICHIER = join(RACINE, 'data', 'veille-ordres.csv');
const MINUTES = Number(process.argv[2]) || 60 * 24 * 3; // 3 jours par défaut
const PAS_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(dirname(FICHIER), { recursive: true });
if (!existsSync(FICHIER)) {
  writeFileSync(FICHIER, 'horodatage;serviceWorker;ageCoteSec;probleme;ordresArmes;statuts;ongletsFomo;ongletVeilleur;sessionResteSec\n');
}

async function releve() {
  const ligne = {
    horodatage: new Date().toISOString(),
    serviceWorker: 'absent',
    ageCoteSec: '',
    probleme: '',
    ordresArmes: '',
    statuts: '',
    ongletsFomo: '',
    ongletVeilleur: '',
    sessionResteSec: '',
  };
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  } catch (error) {
    ligne.probleme = `navigateur injoignable (${String(error?.message ?? error).slice(0, 40)})`;
    return ligne;
  }
  try {
    const pages = await browser.pages();
    const fomo = pages.filter((p) => p.url().startsWith('https://fomo.family/'));
    ligne.ongletsFomo = String(fomo.length);

    // La session vit dans la page fomo : on la lit là où elle est, sans réveiller quoi que ce soit.
    if (fomo[0]) {
      ligne.sessionResteSec = await fomo[0]
        .evaluate(() => {
          try {
            const token = JSON.parse(localStorage.getItem('privy:token') ?? 'null');
            if (typeof token !== 'string') return 'aucune';
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return String(Math.round(payload.exp - Date.now() / 1000));
          } catch {
            return 'illisible';
          }
        })
        .catch(() => 'illisible');
    }

    const cible = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('background.js'));
    if (!cible) return ligne;
    const worker = await cible.worker().catch(() => null);
    if (!worker) return ligne;
    ligne.serviceWorker = 'vivant';
    const etat = await worker
      .evaluate(async () => {
        const s = await chrome.storage.local.get(['health', 'orders']);
        const ordres = Object.values(s.orders ?? {});
        return {
          ageCoteSec: s.health?.lastQuoteAt ? Math.round((Date.now() - s.health.lastQuoteAt) / 1000) : null,
          probleme: s.health?.problem ?? '',
          ongletVeilleur: s.health?.watcherTabId ?? '',
          armes: ordres.filter((o) => ['armed', 'pending', 'queued', 'executing'].includes(o.status)).length,
          statuts: ordres.map((o) => `${o.symbol}:${o.status}`).join(' '),
        };
      })
      .catch(() => null);
    if (etat) Object.assign(ligne, { ...etat, ordresArmes: String(etat.armes), ageCoteSec: etat.ageCoteSec ?? '' });
  } finally {
    browser.disconnect();
  }
  return ligne;
}

function resume(l) {
  return `${l.serviceWorker}|cote ${l.ageCoteSec || '—'}s|${l.probleme || 'ok'}|armés ${l.ordresArmes || '0'}|onglets ${l.ongletsFomo}`;
}

let precedent = null;
const fin = Date.now() + MINUTES * 60_000;
console.log(`Veille longue démarrée pour ${MINUTES} min → ${FICHIER}`);
while (Date.now() < fin) {
  const l = await releve();
  appendFileSync(
    FICHIER,
    [l.horodatage, l.serviceWorker, l.ageCoteSec, l.probleme, l.ordresArmes, l.statuts, l.ongletsFomo, l.ongletVeilleur, l.sessionResteSec].join(';') + '\n',
  );
  const court = resume(l);
  if (court !== precedent) {
    console.log(`${new Date().toLocaleTimeString('fr-FR')} ${court}`);
    precedent = court;
  }
  await sleep(PAS_MS);
}
console.log('Veille longue terminée.');
