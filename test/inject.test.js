// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrder } from '../src/lib/orders.js';
import { findAmountPresets, findTradePanel } from '../src/lib/fomo-page.js';
import { mountIntegration } from '../src/ui/inject.js';

/**
 * L'interface injectée sur la VRAIE structure de la page token de fomo (relevée le 2026-09-15) :
 * où elle se greffe, ce qu'elle masque, ce qu'elle envoie au service worker, et comment elle
 * survit aux re-rendus de React.
 */

const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'token-page.html'), 'utf8');
const RUSH = 'SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH';
const RUSH_ID = `${RUSH}:1399811149`;
const T0 = Date.now();

const flush = async (n = 4) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Jeton Privy comme celui que fomo range dans `localStorage`, avec l'expiration voulue. */
function jwt(expSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64({ iat: expSec - 3600, exp: expSec })}.sig`;
}

function makeWin() {
  const stops = [];
  const win = {
    location: window.location,
    sessionStorage: window.sessionStorage,
    localStorage: window.localStorage,
    fetch: () => Promise.reject(new Error('pas de réseau en test')),
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      stops.push(() => clearInterval(id));
      return id;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    MutationObserver: class extends MutationObserver {
      constructor(cb) {
        super(cb);
        stops.push(() => this.disconnect());
      }
    },
    addEventListener: (type, listener) => {
      window.addEventListener(type, listener);
      stops.push(() => window.removeEventListener(type, listener));
    },
    confirm: () => true,
    alert: vi.fn(),
  };
  win.dispose = () => stops.forEach((stop) => stop());
  return win;
}

function makeChrome(initial = {}) {
  const listeners = [];
  const sent = [];
  const store = { orders: {}, settings: {}, health: {}, ...initial };
  const chromeApi = {
    storage: {
      local: { get: async () => structuredClone(store) },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      sendMessage: async (msg) => {
        sent.push(msg);
        if (msg.type === 'ADD_ORDER') {
          const res = createOrder(msg.input, { id: `o${sent.length}`, now: Date.now(), currentValue: msg.currentValue });
          return res.ok ? { ok: true, order: res.order } : res;
        }
        return { ok: true, detail: 'ok' };
      },
    },
  };
  return {
    chromeApi,
    sent,
    setOrders(orders) {
      store.orders = orders;
      listeners.forEach((fn) => fn({ orders: { newValue: orders } }, 'local'));
    },
  };
}

function makeApi({ holdingAmount = 0.022, price = 50.9, mc = 2_211_808 } = {}) {
  return {
    quotes: vi.fn(async () => ({ ok: true, at: Date.now(), quotes: { [RUSH_ID]: { mc, price, symbol: 'RUSH' } } })),
    userId: vi.fn(async () => ({ ok: true, id: 'u1' })),
    balance: vi.fn(async () =>
      holdingAmount > 0
        ? { ok: true, found: true, amount: holdingAmount, usd: holdingAmount * price, price, mc }
        : { ok: true, found: false, amount: 0, usd: 0 },
    ),
    config: vi.fn(async () => ({ ok: true, mins: { buy: { 1: 25, default: 2 }, sell: { 1: 5, default: 2 } } })),
  };
}

let win;
async function mount(apiOptions, chromeInitial) {
  document.body.innerHTML = PAGE;
  window.history.pushState({}, '', `/tokens/solana/${RUSH}`);
  window.sessionStorage.clear();
  window.localStorage.clear();
  win = makeWin();
  const chrome = makeChrome(chromeInitial);
  const api = makeApi(apiOptions);
  const handle = mountIntegration({ resolveUserId: (fomo) => fomo.userId(), doc: document, win, chromeApi: chrome.chromeApi, api });
  await flush();
  handle.sync();
  return { handle, chrome, api };
}

const $ = (sel) => document.querySelector(sel);
const panel = () => findTradePanel(document);
const form = () => $('[data-tpa="form"]');
const field = (name) => form().querySelector(`[data-field="${name}"]`);

function type(name, value) {
  const input = field(name);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function click(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

async function enterOrderMode(handle) {
  click($('[data-tpa="mode"] [data-mode="order"]'));
  handle.sync();
  await flush();
  // Sous charge, la cote et l'avoir arrivent après quelques tours de boucle : on attend le
  // formulaire au lieu de supposer qu'il est déjà là. S'il ne vient jamais, le test échoue quand même.
  for (let i = 0; i < 50 && !form(); i++) await flush(2);
  expect(form()).not.toBeNull();
}

describe('greffes sur la page token', () => {
  afterEach(() => win.dispose());

  it('bouton dans la barre du haut, sélecteur sous les onglets, rien de masqué en mode marché', async () => {
    await mount();
    const nav = $('nav[aria-label="Main"]');
    expect(nav.previousElementSibling.getAttribute('data-tpa')).toBe('chip');
    expect($('[data-tpa="chip"]').textContent).toContain('Ordres auto');

    const tabsRow = panel().querySelector('.flex.gap-2');
    expect(tabsRow.nextElementSibling.getAttribute('data-tpa')).toBe('mode');
    expect($('[data-tpa="mode"]').textContent).toMatch(/Au marché\s*Ordre auto/);
    expect(form()).toBeNull();
    expect(document.querySelectorAll('[data-tpa-hidden]')).toHaveLength(0);
    expect($('[data-tpa="drawer"]').hidden).toBe(true);
  });

  it('« Ordre auto » : le formulaire de fomo est masqué (pas retiré), le nôtre prend sa place côté Buy', async () => {
    const { handle } = await mount();
    const fomoChildren = [...panel().children].filter((el) => !el.hasAttribute('data-tpa'));
    await enterOrderMode(handle);

    expect(form()).not.toBeNull();
    expect(form().dataset.side).toBe('buy');
    expect(form().previousElementSibling.getAttribute('data-tpa')).toBe('mode');
    const hidden = fomoChildren.filter((el) => el.hasAttribute('data-tpa-hidden'));
    expect(hidden).toHaveLength(fomoChildren.length - 1); // tout sauf la rangée d'onglets
    expect(panel().querySelector('.flex.gap-2').hasAttribute('data-tpa-hidden')).toBe(false);
    // Les éléments de fomo sont toujours là pour l'exécuteur, et nos boutons ne s'y mêlent pas.
    expect(findAmountPresets(panel()).map((p) => p.value)).toEqual([10, 100, 500, 1000]);
    expect(form().textContent).toContain('cash $0.92');
    expect(form().textContent).toContain('actuel $2.2M');
  });

  it('retour « Au marché » : formulaire retiré, fomo réaffiché', async () => {
    const { handle } = await mount();
    await enterOrderMode(handle);
    click($('[data-tpa="mode"] [data-mode="market"]'));
    handle.sync();
    expect(form()).toBeNull();
    expect(document.querySelectorAll('[data-tpa-hidden]')).toHaveLength(0);
  });

  it('re-rendu de React qui efface nos greffes et ajoute un bloc : tout est reposé et masqué', async () => {
    const { handle } = await mount();
    await enterOrderMode(handle);
    $('[data-tpa="mode"]').remove();
    form().remove();
    const fresh = document.createElement('div');
    fresh.textContent = 'Nouveau bloc fomo';
    panel().appendChild(fresh);
    handle.sync();
    expect($('[data-tpa="mode"]')).not.toBeNull();
    expect(form()).not.toBeNull();
    expect(fresh.hasAttribute('data-tpa-hidden')).toBe(true);
  });

  it('pendant une exécution dans cet onglet : mode marché forcé, puis retour au mode ordre', async () => {
    const { handle } = await mount();
    await enterOrderMode(handle);
    window.dispatchEvent(new CustomEvent('tpa:executing', { detail: true }));
    expect(form()).toBeNull();
    expect(document.querySelectorAll('[data-tpa-hidden]')).toHaveLength(0);
    window.dispatchEvent(new CustomEvent('tpa:executing', { detail: false }));
    expect(form()).not.toBeNull();
    handle.sync();
  });
});

describe('ordre d’achat depuis la page', () => {
  afterEach(() => win.dispose());

  it('raccourci −20 %, montant $50, TP ×2 coché par défaut : l’ordre part au service worker', async () => {
    const { handle, chrome } = await mount();
    await enterOrderMode(handle);

    click(form().querySelector('[data-target="1.77M"]'));
    type('amount', '50');
    expect(form().querySelector('[data-slot="dir"]').textContent).toBe('↓ à la baisse');
    expect(form().querySelector('[data-slot="summary"]').textContent).toMatch(/Achète \$50 de RUSH si la MC tombe à \$1\.77M \(−20\u202f%\)\. Puis vend 50\u202f% à ×2\./);
    // Cash de 0,92 $ : avertissement, pas blocage (le dépôt peut arriver avant le repli).
    expect(form().querySelector('[data-slot="msg"]').textContent).toMatch(/Cash disponible : \$0\.92/);
    expect(form().querySelector('[data-action="submit"]').disabled).toBe(false);

    click(form().querySelector('[data-action="submit"]'));
    await flush();
    const add = chrome.sent.find((m) => m.type === 'ADD_ORDER');
    expect(add).toMatchObject({
      currentValue: 2_211_808,
      input: { side: 'buy', chain: 'solana', networkId: 1399811149, address: RUSH, symbol: 'RUSH', metric: 'mc', target: 1_770_000, amountUsd: 50, attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }] },
    });
    expect(form().querySelector('[data-slot="msg"]').textContent).toMatch(/Ordre placé : Si MC ≤ \$1\.77M → acheter \$50, puis TP ×2/);
    expect(field('target').value).toBe('');
  });

  it('montant sous le minimum d’achat fomo (2 $) : bouton désactivé et raison affichée', async () => {
    const { handle, chrome } = await mount();
    await enterOrderMode(handle);
    type('target', '1.5M');
    type('amount', '1');
    expect(form().querySelector('[data-slot="msg"]').textContent).toMatch(/fomo refuse tout achat sous \$2/);
    expect(form().querySelector('[data-action="submit"]').disabled).toBe(true);
    click(form().querySelector('[data-action="submit"]'));
    await flush();
    expect(chrome.sent.some((m) => m.type === 'ADD_ORDER')).toBe(false);
  });

  it('prise de profit attachée trop petite pour fomo : refusée avant de créer l’ordre', async () => {
    const { handle } = await mount();
    await enterOrderMode(handle);
    type('target', '1.5M');
    type('amount', '3');
    type('tpPct', '10');
    expect(form().querySelector('[data-slot="msg"]').textContent).toMatch(/La prise de profit vendrait ≈ \$0\.6 : sous le minimum de vente fomo/);
    expect(form().querySelector('[data-action="submit"]').disabled).toBe(true);
  });
});

describe('ordre de vente depuis la page', () => {
  afterEach(() => win.dispose());

  async function switchFomoToSell(handle) {
    // fomo passe sur l'onglet Sell : ses boutons deviennent des pourcentages.
    const labels = ['10%', '25%', '50%', '100%'];
    findAmountPresets(panel()).forEach((p, i) => (p.el.textContent = labels[i]));
    handle.sync();
    await flush();
  }

  it('onglet Sell de fomo : le formulaire bascule en vente, avec l’avoir et l’estimation au seuil', async () => {
    const { handle, chrome } = await mount({ holdingAmount: 1, price: 50.9 });
    await enterOrderMode(handle);
    await switchFomoToSell(handle);
    expect(form().dataset.side).toBe('sell');
    expect(form().textContent).toContain('avoir $50.9');

    click(form().querySelector('[data-target="4.42M"]'));
    click(form().querySelector('[data-pct="50"]'));
    expect(form().querySelector('[data-slot="summary"]').textContent).toMatch(/Vend 50\u202f% de ton RUSH si la MC atteint \$4\.42M \(×2,00\)/);
    expect(form().querySelector('[data-slot="pct-usd"]').textContent).toMatch(/≈ \$50\.\d+ au seuil/);

    click(form().querySelector('[data-action="submit"]'));
    await flush();
    expect(chrome.sent.find((m) => m.type === 'ADD_ORDER').input).toMatchObject({ side: 'sell', sellPct: 50, target: 4_420_000 });
  });

  it('position réelle de 1,12 $ : vente refusée avant création (minimum fomo 2 $)', async () => {
    const { handle } = await mount({ holdingAmount: 0.022, price: 50.9 });
    await enterOrderMode(handle);
    await switchFomoToSell(handle);
    click(form().querySelector('[data-target="4.42M"]'));
    expect(form().querySelector('[data-slot="msg"]').textContent).toMatch(/fomo refuse toute vente sous \$2/);
    expect(form().querySelector('[data-action="submit"]').disabled).toBe(true);
  });

  it('stop (seuil sous la MC) : la ligne « attendre N s » apparaît', async () => {
    const { handle } = await mount({ holdingAmount: 1 });
    await enterOrderMode(handle);
    await switchFomoToSell(handle);
    type('target', '1.5M');
    expect(form().querySelector('[data-slot="confirm-row"]').hidden).toBe(false);
    expect(form().querySelector('[data-slot="summary"]').textContent).toMatch(/après 15\u00a0s sous le seuil/);
  });
});

describe('listes d’ordres : carte du token et tiroir', () => {
  afterEach(() => win.dispose());

  function sampleOrders() {
    const mk = (id, input, currentValue) => createOrder(input, { id, now: T0, currentValue }).order;
    return {
      a: mk('a', { side: 'sell', chain: 'solana', networkId: 1399811149, address: RUSH, symbol: 'RUSH', metric: 'mc', target: 4_400_000, sellPct: 25 }, 2_211_808),
      b: mk('b', { side: 'buy', chain: 'solana', networkId: 1399811149, address: RUSH, symbol: 'RUSH', metric: 'mc', target: 1_500_000, amountUsd: 50, attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }] }, 2_211_808),
      c: mk('c', { side: 'sell', chain: 'robinhood', networkId: 4663, address: '0xf7894d31d569e6330592d346ecfefdf4257f3ec1', symbol: 'SABLE', metric: 'mc', target: 500_000, sellPct: 100 }, 250_000),
    };
  }

  it('carte « Ordres auto » posée sous le panneau de trade, avec les ordres de CE token', async () => {
    const { chrome, handle } = await mount();
    const card = $('[data-tpa="orders"]');
    expect(card.hidden).toBe(true);
    expect(card.previousElementSibling).toBe(panel().parentElement);

    chrome.setOrders(sampleOrders());
    handle.sync();
    expect(card.hidden).toBe(false);
    expect(card.textContent).toContain('Si MC ≥ $4.4M → vendre 25\u202f%');
    expect(card.textContent).toContain('Si MC ≤ $1.5M → acheter $50');
    expect(card.textContent).toContain('puis TP ×2 (50\u202f%)');
    expect(card.textContent).not.toContain('SABLE');
    expect($('[data-tpa="mode"] [data-slot="mode-count"]').textContent).toBe('2');
  });

  it('lignes mises à jour sur place : un rafraîchissement ne recrée pas les lignes (pas d’animation rejouée)', async () => {
    const { chrome } = await mount();
    const orders = sampleOrders();
    chrome.setOrders(orders);
    const row = $('[data-tpa="orders"] [data-order-id="a"]');
    chrome.setOrders({ ...orders, a: { ...orders.a, lastValue: 2_300_000 } });
    expect($('[data-tpa="orders"] [data-order-id="a"]')).toBe(row);
    expect(row.textContent).toContain('actuel $2.3M');

    chrome.setOrders({ ...orders, a: { ...orders.a, status: 'executing' } });
    expect($('[data-tpa="orders"] [data-order-id="a"]')).toBe(row);
    expect(row.dataset.flash).toBe('status');
    expect(row.textContent).toContain('En cours');
  });

  it('Annuler / Tester depuis la carte : messages au service worker', async () => {
    const { chrome } = await mount();
    chrome.setOrders(sampleOrders());
    click($('[data-tpa="orders"] [data-op="cancel"][data-id="a"]'));
    click($('[data-tpa="orders"] [data-op="test"][data-id="b"]'));
    await flush();
    expect(chrome.sent.filter((m) => m.id).map((m) => [m.type, m.id])).toEqual([
      ['CANCEL_ORDER', 'a'],
      ['TEST_ORDER', 'b'],
    ]);
  });

  it('tiroir ouvert depuis la barre du haut : tous les tokens, pause globale, réglages', async () => {
    const { chrome } = await mount();
    chrome.setOrders(sampleOrders());
    click($('[data-tpa="chip"]'));
    const drawer = $('[data-tpa="drawer"]');
    expect(drawer.hidden).toBe(false);
    expect(drawer.textContent).toContain('SABLE');
    expect(drawer.textContent).toContain('RUSH');
    expect(drawer.querySelector('a[href="/tokens/robinhood/0xf7894d31d569e6330592d346ecfefdf4257f3ec1"]')).not.toBeNull();

    const toggle = drawer.querySelector('[data-setting="enabled"]');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    click(drawer.querySelector('[data-action="options"]'));
    await flush();
    expect(chrome.sent.map((m) => m.type)).toEqual(expect.arrayContaining(['SET_SETTINGS', 'OPEN_OPTIONS']));
    expect(chrome.sent.find((m) => m.type === 'SET_SETTINGS').patch).toEqual({ enabled: false });

    // Ouverture animée : l'état « open » arrive une image après l'affichage.
    await new Promise((r) => setTimeout(r, 40));
    expect(drawer.dataset.state).toBe('open');
    click(drawer.querySelector('[data-close]'));
    expect(drawer.dataset.state).toBe('closed');
    expect(drawer.hidden).toBe(false); // encore visible pendant la sortie
    await new Promise((r) => setTimeout(r, 400));
    expect(drawer.hidden).toBe(true);
  });
});

describe('page token sans panneau Buy / Sell de fomo', () => {
  afterEach(() => win.dispose());

  /** Le repli n'apparaît qu'au bout de 12 s : on avance l'horloge de l'onglet. */
  function dropPanel(handle, { loggedOut = false } = {}) {
    panel().remove();
    if (loggedOut) document.querySelector('nav[aria-label="Main"]').remove();
    handle.ui.tokenSince = Date.now() - 20_000;
    handle.sync();
  }

  it('connecté : dit pourquoi, et laisse quand même poser un ordre', async () => {
    const { handle } = await mount();
    dropPanel(handle);
    const box = $('[data-tpa="floating"]');
    expect(box.querySelector('[data-slot="why"]').textContent).toMatch(/page encore en chargement, ou marché sans achat direct/);
    expect(box.querySelector('[data-slot="sides"]').hidden).toBe(false);
    expect(box.querySelector('[data-tpa="form"]')).not.toBeNull();
  });

  it('déconnecté : dit de se reconnecter et n’affiche aucun formulaire', async () => {
    const { handle } = await mount();
    dropPanel(handle, { loggedOut: true });
    const box = $('[data-tpa="floating"]');
    expect(box.querySelector('[data-slot="why"]').textContent).toMatch(/Connecte-toi à fomo/);
    expect(box.querySelector('[data-slot="sides"]').hidden).toBe(true);
    expect(box.querySelector('[data-tpa="form"]')).toBeNull();
  });

  /**
   * Le bug signalé : « Connecte-toi à fomo » alors que la session est bien vivante. La connexion
   * se lisait sur un bouton de l'en-tête ; fomo redessine sa barre du haut (ou n'affiche rien
   * quand le cash est à zéro) et l'extension se croyait déconnectée. C'est le JETON qui décide.
   */
  it('en-tête méconnaissable mais jeton valide : ne réclame PAS une reconnexion', async () => {
    const { handle } = await mount();
    window.localStorage.setItem('privy:token', JSON.stringify(jwt(Date.now() / 1000 + 1800)));
    dropPanel(handle, { loggedOut: true }); // plus aucun repère visuel de connexion
    const box = $('[data-tpa="floating"]');
    expect(box.querySelector('[data-slot="why"]').textContent).not.toMatch(/Connecte-toi/);
    expect(box.querySelector('[data-slot="why"]').textContent).toMatch(/page encore en chargement/);
    expect(box.querySelector('[data-slot="sides"]').hidden).toBe(false);
    expect(box.querySelector('[data-tpa="form"]')).not.toBeNull();
  });

  it('jeton expiré : dit de recharger la page, même si l’en-tête a l’air connecté', async () => {
    const { handle } = await mount();
    window.localStorage.setItem('privy:token', JSON.stringify(jwt(Date.now() / 1000 - 60)));
    dropPanel(handle); // l'en-tête, lui, affiche toujours « Deposit more »
    const box = $('[data-tpa="floating"]');
    expect(box.querySelector('[data-slot="why"]').textContent).toMatch(/Session fomo expirée.*recharge la page/);
    expect(box.querySelector('[data-tpa="form"]')).toBeNull();
  });

  it('le panneau revient (page chargée) : le repli disparaît', async () => {
    const { handle } = await mount();
    const saved = panel().parentElement;
    const clone = panel().cloneNode(true);
    dropPanel(handle);
    expect($('[data-tpa="floating"]')).not.toBeNull();
    saved.prepend(clone);
    handle.sync();
    expect($('[data-tpa="floating"]')).toBeNull();
    expect($('[data-tpa="mode"]')).not.toBeNull();
  });
});

describe('hors page token', () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE;
  });
  afterEach(() => win.dispose());

  it('page profil : bouton de la barre du haut seulement, aucune greffe dans le panneau', async () => {
    window.history.pushState({}, '', '/profile/trader');
    win = makeWin();
    const chrome = makeChrome();
    const handle = mountIntegration({ resolveUserId: async () => ({ ok: false }), doc: document, win, chromeApi: chrome.chromeApi, api: makeApi() });
    handle.sync();
    expect($('[data-tpa="chip"]')).not.toBeNull();
    expect($('[data-tpa="mode"]')).toBeNull();
    expect($('[data-tpa="orders"]')).toBeNull();
  });
});
