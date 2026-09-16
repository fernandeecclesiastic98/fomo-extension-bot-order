/**
 * Captures du README, sur la page de démonstration (`demo/page-demo.html`) : aucune donnée de
 * compte, aucun chiffre réel. Le vrai code de l'interface est chargé, aplati en un seul bloc,
 * avec un faux service worker en mémoire — ce qu'on photographie est donc bien l'extension.
 *
 * Usage : node scripts/captures-demo.mjs [--gif] [--store]
 * Sorties : docs/img/*.png (+ docs/img/demo.gif avec --gif ; store/*.png au format 1280×800
 * imposé par le Chrome Web Store avec --store).
 */
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES = join(RACINE, 'docs', 'img');
const MODULES = ['lib/chains.js', 'lib/format.js', 'lib/fomo-page.js', 'lib/fomo-api.js', 'lib/orders.js', 'ui/styles.js', 'ui/inject.js'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gif = process.argv.includes('--gif');
const store = process.argv.includes('--store');
const BOUTIQUE = join(RACINE, 'store');

/** Aplatit les modules ES en un seul corps de fonction évaluable dans la page. */
function aplatir() {
  const parts = MODULES.map((f) => ({
    f,
    code: readFileSync(join(RACINE, 'src', f), 'utf8')
      .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
      .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, ''),
  }));
  const noms = new Map();
  for (const { f, code } of parts) {
    for (const m of code.matchAll(/^(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)|let\s+(\w+)|class\s+(\w+))/gm)) {
      const nom = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (noms.has(nom)) throw new Error(`nom en double « ${nom} » : ${noms.get(nom)} et ${f}`);
      noms.set(nom, f);
    }
  }
  return parts.map(({ f, code }) => `// ---- ${f}\n${code}`).join('\n');
}

const DONNEES = {
  symbole: 'DEMO',
  mc: 4_200_000,
  prix: 0.0042,
  avoirUsd: 1_240,
  cash: 250,
};

const amorce = (corps) => `async () => {
${corps}
  const store = { orders: {}, settings: {}, health: { lastQuoteAt: Date.now() } };
  const listeners = [];
  const emit = (changes) => listeners.forEach((l) => l(changes, 'local'));
  let n = 0;
  const chromeApi = {
    storage: { local: { get: async () => JSON.parse(JSON.stringify(store)) }, onChanged: { addListener: (l) => listeners.push(l) } },
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'ADD_ORDER') {
          const res = createOrder(msg.input, { id: 'demo' + ++n, now: Date.now(), currentValue: msg.currentValue });
          if (!res.ok) return res;
          store.orders = { ...store.orders, [res.order.id]: res.order };
          emit({ orders: { newValue: store.orders } });
          return { ok: true, order: res.order };
        }
        return { ok: true, detail: 'démo' };
      },
    },
  };
  const d = ${JSON.stringify(DONNEES)};
  let mc = d.mc;
  const api = {
    quotes: async () => {
      mc = mc * (1 + (Math.random() - 0.45) / 400); // la cote bouge : le clignotement se voit
      return { ok: true, at: Date.now(), quotes: { 'demo:1399811149': { mc, price: (d.prix * mc) / d.mc, symbol: d.symbole } } };
    },
    userId: async () => ({ ok: true, id: 'demo' }),
    balance: async () => ({ ok: true, found: true, amount: d.avoirUsd / d.prix, usd: d.avoirUsd, price: d.prix, mc }),
    config: async () => ({ ok: true, mins: { buy: { default: 2 }, sell: { default: 2 } } }),
  };
  const handle = mountIntegration({ resolveUserId: (a) => a.userId(), chromeApi, api });
  window.__demo = { handle, store, emit, createOrder };
  return 'monté';
}`;

const remplir = (champs) => `() => {
  const form = document.querySelector('[data-tpa="form"]');
  const set = (nom, valeur) => {
    const input = form.querySelector('[data-field="' + nom + '"]');
    if (!input) return;
    if (input.type === 'checkbox') input.checked = valeur;
    else input.value = valeur;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const champs = ${JSON.stringify(champs)};
  for (const [nom, valeur] of Object.entries(champs)) set(nom, valeur);
}`;

/** webm → GIF recadré sur la colonne, palette dédiée (lisible et léger). */
function convertirEnGif(cadre) {
  const webm = join(IMAGES, 'demo.webm');
  const palette = join(IMAGES, 'palette.png');
  // `page.screencast` enregistre en pixels CSS, pas en pixels écran : le recadrage suit la
  // taille réelle de la vidéo, pas le `deviceScaleFactor`.
  const taille = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', webm]).toString().trim();
  const [largeurVideo] = taille.split(',').map(Number);
  const echelle = Math.max(1, Math.round(largeurVideo / 1440));
  const crop = cadre ? `crop=${cadre.width * echelle}:${cadre.height * echelle}:${cadre.x * echelle}:${cadre.y * echelle},` : '';
  const filtre = `fps=10,${crop}scale=400:-1:flags=lanczos`;
  try {
    execFileSync('ffmpeg', ['-y', '-i', webm, '-vf', `${filtre},palettegen=max_colors=48:stats_mode=diff`, palette], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-y', '-i', webm, '-i', palette, '-lavfi', `${filtre}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, join(IMAGES, 'demo.gif')], {
      stdio: 'ignore',
    });
    rmSync(palette);
    rmSync(webm);
    console.log('→ demo.gif');
  } catch (error) {
    console.warn('GIF non généré (ffmpeg) :', String(error.message).slice(0, 120));
  }
}

mkdirSync(IMAGES, { recursive: true });
const corps = aplatir();

// La page est servie en HTTP sur un chemin de token : l'extension ne se greffe que sur
// `/tokens/<chaîne>/<adresse>`, ce qu'une URL `file://` ne peut pas imiter.
const html = readFileSync(join(RACINE, 'demo', 'page-demo.html'));
const serveur = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${serveur.address().port}`;
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const colonne = () => page.$('.column');
const capture = async (nom, cible) => {
  const el = cible ?? (await colonne());
  await el.screenshot({ path: join(IMAGES, nom) });
  console.log('→', nom);
};

try {
  await page.goto(`${base}/tokens/solana/demo`, { waitUntil: 'load' });
  if (!gif) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  console.log(await page.evaluate(`(${amorce(corps)})()`));
  await page.waitForSelector('[data-tpa="mode"]');
  await sleep(1200);

  // L'animation ne montre que la colonne de trade : un GIF plein écran pèse dix fois plus pour
  // moins d'information.
  let recorder = null;
  let cadre = null;
  if (gif) {
    cadre = await page.evaluate(() => {
      const r = document.querySelector('.column').getBoundingClientRect();
      return { x: Math.floor(r.x) - 8, y: Math.floor(r.y) - 8, width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 };
    });
    recorder = await page.screencast({ path: join(IMAGES, 'demo.webm'), speed: 1 });
  }

  // 1. Achat : bascule en mode ordre, raccourci de repli, montant, sorties attachées.
  await page.click('[data-tpa="mode"] [data-mode="order"]');
  await page.waitForSelector('[data-tpa="form"][data-side="buy"]');
  await sleep(900);
  await page.click('[data-slot="target-chips"] button:nth-child(3)');
  await sleep(500);
  await page.evaluate(`(${remplir({ amount: '100' })})()`);
  await sleep(400);
  await page.evaluate(`(${remplir({ slOn: true })})()`);
  await sleep(900);
  await capture('achat.png');

  // 2. L'ordre est placé : la carte apparaît.
  await page.click('[data-tpa="form"] [data-action="submit"]');
  await sleep(1400);
  await capture('carte-ordres.png');
  if (recorder) {
    await sleep(1200);
    await recorder.stop();
    recorder = null;
    console.log('→ demo.webm');
    convertirEnGif(cadre);
  }

  // 3. Vente : l'onglet Sell de la page bascule le formulaire.
  await page.evaluate(() => [...document.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Sell').click());
  await page.evaluate(() => {
    // La page de démo n'a pas de logique : on remplace ses boutons rapides par des pourcentages,
    // comme le fait fomo quand on passe sur l'onglet Sell.
    const grille = document.querySelector('.quick .grid');
    grille.innerHTML = ['10%', '25%', '50%', '100%'].map((t) => `<button type="button">${t}</button>`).join('');
    document.querySelector('.available span').textContent = '$1,240 available';
    document.querySelector('.confirm').textContent = 'Sell DEMO';
    document.querySelector('.tabs button:first-child').className = '';
    document.querySelector('.tabs button:last-child').className = 'on-sell';
  });
  await page.evaluate(() => window.__demo.handle.sync());
  await page.waitForSelector('[data-tpa="form"][data-side="sell"]');
  await sleep(700);
  await page.click('[data-slot="target-chips"] button:nth-child(2)');
  await sleep(400);
  await page.click('[data-tpa="form"] [data-pct="50"]');
  await sleep(900);
  await capture('vente.png');
  await page.click('[data-tpa="form"] [data-action="submit"]');
  await sleep(1200);

  // 4. Tiroir : tous les ordres, toutes pages confondues.
  await page.click('[data-tpa="chip"]');
  await sleep(1200);
  await capture('tiroir.png', page);
  await page.click('[data-tpa="drawer"] [data-close]');
  await sleep(600);

  // 5. Captures de la boutique : plein écran au format exact 1280×800 exigé par le Web Store.
  if (store) {
    mkdirSync(BOUTIQUE, { recursive: true });
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await sleep(800);
    await page.evaluate(() => window.__demo.handle.sync());
    await sleep(600);
    await page.screenshot({ path: join(BOUTIQUE, '1-ordre-de-vente.png') });
    await page.evaluate(() => [...document.querySelectorAll('.tabs button')].find((b) => b.textContent.trim() === 'Buy').click());
    await page.evaluate(() => {
      const grille = document.querySelector('.quick .grid');
      grille.innerHTML = ['$10', '$50', '$100', '$500'].map((t) => `<button type="button">${t}</button>`).join('');
      document.querySelector('.available span').textContent = '$250 available';
      document.querySelector('.confirm').textContent = 'Buy DEMO';
      document.querySelector('.tabs button:first-child').className = 'on-buy';
      document.querySelector('.tabs button:last-child').className = '';
    });
    await page.evaluate(() => window.__demo.handle.sync());
    await page.waitForSelector('[data-tpa="form"][data-side="buy"]');
    await page.evaluate(`(${remplir({ amount: '100' })})()`);
    await sleep(900);
    await page.screenshot({ path: join(BOUTIQUE, '2-ordre-dachat.png') });
    await page.click('[data-tpa="chip"]');
    await sleep(1000);
    await page.screenshot({ path: join(BOUTIQUE, '3-tous-les-ordres.png') });
    console.log('→ store/1-ordre-de-vente.png, store/2-ordre-dachat.png, store/3-tous-les-ordres.png');
  }

} finally {
  await browser.close();
  serveur.close();
}
console.log(`Captures écrites dans ${IMAGES}`);
