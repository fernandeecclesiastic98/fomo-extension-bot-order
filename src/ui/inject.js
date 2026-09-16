/**
 * Interface « Ordres auto » intégrée à la page token de fomo.family.
 *
 * Quatre greffes, chacune retrouvée par le texte visible de fomo (jamais par ses classes) :
 *  1. sous les onglets Buy/Sell, un sélecteur « Au marché / Ordre auto » ; en mode ordre, le
 *     formulaire de fomo est masqué (pas retiré : React le possède) et le nôtre prend sa place,
 *     côté achat ou vente selon l'onglet de fomo sélectionné ;
 *  2. dans la colonne de droite, une carte « Ordres auto » listant les ordres du token ;
 *  3. dans la barre du haut, un bouton « Ordres auto » à côté du cash ;
 *  4. un tiroir listant tous les ordres, tous tokens confondus.
 *
 * fomo est une appli React à page unique qui re-rend sans prévenir : un observateur de
 * mutations (limité à ~8 passes/s) repose les greffes disparues. Toutes les écritures dans le
 * DOM sont idempotentes — sinon nos propres mutations relanceraient l'observateur en boucle —
 * et les listes d'ordres sont mises à jour ligne par ligne : une ligne existante n'est jamais
 * recréée, pour que son animation d'entrée ne rejoue pas à chaque rafraîchissement de cote.
 */

import { CHAIN_LABELS, parseTokenPath, tokenId } from '../lib/chains.js';
import { createFomoApi, minTradeUsd, readSession as readFomoSession } from '../lib/fomo-api.js';
import { activeSide, findTradePanel, findTradeTabs, isLoggedIn, isOurs, readAvailableUsd, readTitle } from '../lib/fomo-page.js';
import { formatAgo, formatCompactInput, formatPct, formatPriceUsd, parseCompactUsd } from '../lib/format.js';
import {
  DEFAULT_SETTINGS,
  KIND_LABELS,
  STATUS_LABELS,
  describeAttached,
  describeOrder,
  estimateSellUsdAtTarget,
  formatThreshold,
  formatValue,
  isWatched,
} from '../lib/orders.js';
import { ensureStyles } from './styles.js';

const QUOTE_EVERY_MS = 5_000;
const HOLDING_EVERY_MS = 20_000;
const FLOATING_AFTER_MS = 12_000;
const DRAWER_ANIMATION_MS = 340;
const MODE_KEY = 'tpa:mode';

const BUY_AMOUNTS = [10, 50, 100, 500];
const SELL_PCTS = [10, 25, 50, 100];

function freshForms() {
  return {
    buy: { target: '', amount: '', tpOn: true, tpMultiple: '2', tpPct: '50', slOn: false, slDrop: '30', slPct: '100' },
    sell: { target: '', pct: '25', confirmSec: '' },
  };
}

export function mountIntegration({ resolveUserId, doc = document, win = window, chromeApi = globalThis.chrome, api } = {}) {
  const fomo = api ?? createFomoApi({ fetchImpl: win.fetch.bind(win), storage: win.localStorage });
  ensureStyles(doc);

  const ui = {
    token: null,
    tokenSince: 0,
    quote: null,
    holding: null,
    cash: null,
    mins: null,
    orders: {},
    settings: { ...DEFAULT_SETTINGS },
    health: {},
    mode: readSession(MODE_KEY) === 'order' ? 'order' : 'market',
    executing: false,
    drawerOpen: false,
    metric: 'mc',
    forms: freshForms(),
    floatingSide: 'buy',
    flash: null,
    justCreated: null,
  };

  /** Dernières valeurs affichées par formulaire : ne faire « flasher » que ce qui change vraiment. */
  const memory = new WeakMap();

  // -------------------------------------------------------------------------------------------
  // Données : stockage de l'extension, cote, avoir, minimums
  // -------------------------------------------------------------------------------------------

  chromeApi.storage.local.get(['orders', 'settings', 'health']).then((saved) => {
    ui.orders = saved.orders ?? {};
    ui.settings = { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) };
    ui.health = saved.health ?? {};
    renderData();
  });
  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.orders) ui.orders = changes.orders.newValue ?? {};
    if (changes.settings) ui.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue ?? {}) };
    if (changes.health) ui.health = changes.health.newValue ?? {};
    renderData();
  });

  win.addEventListener('tpa:executing', (event) => {
    ui.executing = !!event.detail;
    sync();
  });

  async function refreshQuote() {
    const token = ui.token;
    if (!token || doc.visibilityState === 'hidden') return;
    const res = await fomo.quotes([token.id]);
    if (ui.token !== token) return;
    if (res.ok && res.quotes[token.id]) ui.quote = { ...res.quotes[token.id], at: Date.now() };
    else if (!ui.quote) {
      const title = readTitle(doc);
      if (title) ui.quote = { mc: title.mc, price: null, symbol: title.symbol, at: Date.now(), approx: true };
    }
    renderData();
  }

  async function refreshHolding() {
    const token = ui.token;
    if (!token || doc.visibilityState === 'hidden') return;
    const user = await resolveUserId(fomo);
    if (!user?.ok || ui.token !== token) return;
    const res = await fomo.balance(user.id, token.networkId, token.address);
    if (ui.token !== token || !res.ok) return;
    ui.holding = res;
    renderData();
  }

  async function refreshMins() {
    if (ui.mins) return;
    const res = await fomo.config();
    if (res.ok) {
      ui.mins = res.mins;
      renderData();
    }
  }

  win.setInterval(refreshQuote, QUOTE_EVERY_MS);
  win.setInterval(refreshHolding, HOLDING_EVERY_MS);

  function currentValue() {
    const v = ui.metric === 'mc' ? ui.quote?.mc : ui.quote?.price;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function symbol() {
    return ui.quote?.symbol ?? readTitle(doc)?.symbol ?? '?';
  }

  function sortOrders(list) {
    return list.sort((a, b) => Number(isWatched(b)) - Number(isWatched(a)) || b.createdAt - a.createdAt);
  }

  function tokenOrders() {
    if (!ui.token) return [];
    return sortOrders(Object.values(ui.orders).filter((o) => o.tokenId === ui.token.id));
  }

  // -------------------------------------------------------------------------------------------
  // Greffes : posées, reposées si fomo les efface
  // -------------------------------------------------------------------------------------------

  let scheduled = false;
  const observer = new win.MutationObserver((mutations) => {
    const foreign = mutations.some((m) => {
      const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
      return el && !isOurs(el);
    });
    if (foreign) schedule();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  win.setInterval(sync, 1_000);

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    win.setTimeout(() => {
      scheduled = false;
      sync();
    }, 120);
  }

  function sync() {
    const route = parseTokenPath(win.location.pathname);
    const id = route ? tokenId(route.networkId, route.address) : null;
    if (id !== (ui.token?.id ?? null)) onTokenChange(route ? { ...route, id } : null);

    mountChip();
    mountDrawer();

    const panel = ui.token ? findTradePanel(doc) : null;
    if (panel) {
      removeFloating();
      mountInPanel(panel);
      mountOrdersCard(panel);
    } else {
      removePanelParts();
      if (ui.token && Date.now() - ui.tokenSince > FLOATING_AFTER_MS) mountFloating();
      else removeFloating();
    }
  }

  function onTokenChange(token) {
    ui.token = token;
    ui.tokenSince = Date.now();
    ui.quote = null;
    ui.holding = null;
    ui.forms = freshForms();
    ui.flash = null;
    doc.querySelectorAll('[data-tpa="form"]').forEach((el) => el.remove());
    if (token) {
      refreshQuote();
      refreshHolding();
      refreshMins();
    }
  }

  function mountInPanel(panel) {
    const tabs = findTradeTabs(doc);
    const tabsRow = tabs.sell.parentElement;
    const mode = ui.executing ? 'market' : ui.mode;

    let switcher = child(panel, 'mode');
    if (!switcher) {
      switcher = h('div', { 'data-tpa': 'mode', class: 'tpa-mode', role: 'tablist', 'aria-label': 'Type d’ordre' });
      switcher.innerHTML = `
        <button type="button" role="tab" data-mode="market">Au marché</button>
        <button type="button" role="tab" data-mode="order">Ordre auto <span class="tpa-badge" data-slot="mode-count" hidden></span></button>`;
      switcher.addEventListener('click', (event) => {
        const button = event.target.closest('[data-mode]');
        if (!button) return;
        ui.mode = button.dataset.mode;
        writeSession(MODE_KEY, ui.mode);
        sync();
      });
    }
    if (switcher.previousElementSibling !== tabsRow) tabsRow.after(switcher);
    setData(switcher, 'active', mode);
    for (const button of switcher.querySelectorAll('[data-mode]')) {
      toggleClass(button, 'tpa-on', button.dataset.mode === mode);
      setAttr(button, 'aria-selected', String(button.dataset.mode === mode));
    }
    renderModeCount(switcher);

    // Masquer (sans retirer) tout ce que fomo affiche sous ses onglets.
    for (const el of [...panel.children]) {
      if (el === tabsRow || isOurs(el)) continue;
      if (mode === 'order') {
        if (!el.hasAttribute('data-tpa-hidden')) el.setAttribute('data-tpa-hidden', '');
      } else if (el.hasAttribute('data-tpa-hidden')) {
        el.removeAttribute('data-tpa-hidden');
      }
    }

    let form = child(panel, 'form');
    if (mode !== 'order') {
      form?.remove();
      return;
    }
    // Onglet Sell grisé par fomo (rien à vendre) : ses boutons restent en dollars, côté Buy.
    const side = activeSide(panel) ?? 'buy';
    const cash = readAvailableUsd(panel);
    if (side === 'buy' && cash !== null) ui.cash = cash;
    if (!form) form = h('div', { 'data-tpa': 'form' });
    if (form.previousElementSibling !== switcher) switcher.after(form);
    if (form.dataset.side !== side) buildForm(form, side);
    else updateForm(form);
  }

  function removePanelParts() {
    doc.querySelectorAll('[data-tpa="mode"],[data-tpa="form"]:not(.tpa-in-floating),[data-tpa="orders"]').forEach((el) => el.remove());
    doc.querySelectorAll('[data-tpa-hidden]').forEach((el) => el.removeAttribute('data-tpa-hidden'));
  }

  function mountOrdersCard(panel) {
    const wrapper = panel.parentElement;
    const column = wrapper?.parentElement;
    if (!column) return;
    let card = child(column, 'orders');
    if (!card) {
      card = h('div', { 'data-tpa': 'orders', class: 'tpa-card' });
      card.innerHTML = `
        <div class="tpa-card-head">
          <span class="tpa-card-title">Ordres auto</span>
          <button type="button" class="tpa-link" data-action="drawer">Tout voir</button>
        </div>
        <div class="tpa-card-head"><span class="tpa-state" data-slot="state"></span></div>
        <div class="tpa-rows" data-slot="rows"></div>`;
      card.addEventListener('click', onOrderAction);
      renderOrdersCard(card);
    }
    if (card.previousElementSibling !== wrapper) wrapper.after(card);
  }

  function mountChip() {
    const nav = doc.querySelector('nav[aria-label="Main"]');
    if (!nav?.parentElement) return;
    let chip = child(nav.parentElement, 'chip');
    if (!chip) {
      chip = h('button', { 'data-tpa': 'chip', type: 'button', class: 'tpa-chip' });
      chip.innerHTML = `<span class="tpa-chip-dot" data-slot="dot"></span><span>Ordres auto</span><span class="tpa-chip-count" data-slot="count"></span>`;
      chip.addEventListener('click', () => openDrawer(true));
      renderChip(chip);
    }
    if (chip.nextElementSibling !== nav) nav.before(chip);
  }

  function mountDrawer() {
    if (doc.querySelector('[data-tpa="drawer"]')) return;
    const drawer = h('div', { 'data-tpa': 'drawer', class: 'tpa-drawer', hidden: '', 'data-state': 'closed' });
    drawer.innerHTML = `
      <div class="tpa-backdrop" data-close></div>
      <aside class="tpa-sheet" role="dialog" aria-label="Ordres auto">
        <div class="tpa-sheet-head">
          <div>
            <h2>Ordres auto</h2>
            <span class="tpa-state" data-slot="drawer-state"></span>
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <label class="tpa-switch"><input type="checkbox" data-setting="enabled"> Actif</label>
            <button type="button" class="tpa-close" data-close aria-label="Fermer">✕</button>
          </div>
        </div>
        <div class="tpa-sheet-body" data-slot="drawer-body"></div>
        <div class="tpa-sheet-foot">
          <button type="button" class="tpa-link" data-action="options">Réglages et journal</button>
          <span class="tpa-fine" data-slot="drawer-mode"></span>
        </div>
      </aside>`;
    drawer.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) return openDrawer(false);
      if (event.target.closest('[data-action="options"]')) return chromeApi.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      onOrderAction(event);
    });
    drawer.addEventListener('change', async (event) => {
      const input = event.target.closest('[data-setting="enabled"]');
      if (input) await chromeApi.runtime.sendMessage({ type: 'SET_SETTINGS', patch: { enabled: input.checked } });
    });
    drawer.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') openDrawer(false);
    });
    doc.body.appendChild(drawer);
  }

  let drawerTimer = null;
  function openDrawer(open) {
    ui.drawerOpen = open;
    const drawer = doc.querySelector('[data-tpa="drawer"]');
    if (!drawer) return;
    win.clearTimeout?.(drawerTimer);
    if (open) {
      renderDrawer(drawer);
      drawer.hidden = false;
      // Une image d'écart entre l'affichage et l'état « ouvert » : sinon pas de transition.
      drawerTimer = win.setTimeout(() => setData(drawer, 'state', 'open'), 16);
    } else {
      setData(drawer, 'state', 'closed');
      drawerTimer = win.setTimeout(() => {
        if (!ui.drawerOpen) drawer.hidden = true;
      }, DRAWER_ANIMATION_MS);
    }
  }

  /**
   * « Connecté » se lit sur le JETON de session, pas sur un bouton de l'en-tête : c'est ce jeton,
   * et lui seul, qui permet de coter, de lire les soldes et de trader. Un en-tête que fomo
   * redessine (ou qui n'affiche rien quand le cash est à zéro) ne doit pas faire croire à une
   * déconnexion. Le repère visuel ne sert plus que de filet quand le jeton est illisible.
   */
  function sessionState() {
    let jeton = { ok: false, reason: 'no-session' };
    try {
      jeton = readFomoSession(win.localStorage, Date.now());
    } catch {
      jeton = { ok: false, reason: 'illisible' };
    }
    return { ...jeton, domHint: isLoggedIn(doc) };
  }

  function hasSession() {
    const etat = sessionState();
    return etat.ok || (etat.reason !== 'expired' && etat.domHint);
  }

  function sessionMessage() {
    const etat = sessionState();
    if (etat.reason === 'expired') return 'Session fomo expirée : recharge la page (F5) pour la renouveler, sinon aucun ordre ne peut être posé ni exécuté.';
    return 'Connecte-toi à fomo : sans session, aucun ordre ne peut être posé ni exécuté.';
  }

  /**
   * Repli quand fomo n'affiche pas son panneau Buy/Sell sur une page token (déconnecté, page
   * encore en chargement, ou marché sans achat direct : les perps ont Long/Short). Le message dit
   * laquelle des deux causes s'applique — « panneau introuvable » tout court n'aide personne.
   */
  function mountFloating() {
    let box = doc.querySelector('[data-tpa="floating"]');
    if (!box) {
      box = h('div', { 'data-tpa': 'floating', class: 'tpa-floating' });
      box.innerHTML = `
        <div class="tpa-card-head"><span class="tpa-card-title">Ordre auto</span><button type="button" class="tpa-link" data-action="retry">Réessayer</button></div>
        <p class="tpa-msg tpa-warn" data-slot="why"></p>
        <div class="tpa-sides" data-slot="sides">
          <button type="button" class="tpa-buy" data-side="buy">Achat</button>
          <button type="button" class="tpa-sell" data-side="sell">Vente</button>
        </div>`;
      box.addEventListener('click', (event) => {
        if (event.target.closest('[data-action="retry"]')) return sync();
        const button = event.target.closest('[data-side]');
        if (!button) return;
        ui.floatingSide = button.dataset.side;
        sync();
      });
      doc.body.appendChild(box);
    }
    const loggedIn = hasSession();
    setText(
      box.querySelector('[data-slot="why"]'),
      loggedIn
        ? 'fomo n’affiche pas son panneau Buy / Sell sur cette page : page encore en chargement, ou marché sans achat direct. Tes ordres déjà posés restent surveillés.'
        : sessionMessage(),
    );
    setHidden(box.querySelector('[data-slot="sides"]'), !loggedIn);
    for (const button of box.querySelectorAll('[data-side]')) toggleClass(button, 'tpa-on', button.dataset.side === ui.floatingSide);

    let form = box.querySelector('[data-tpa="form"]');
    if (!loggedIn) {
      form?.remove();
      return;
    }
    if (!form) {
      form = h('div', { 'data-tpa': 'form', class: 'tpa-in-floating' });
      box.appendChild(form);
    }
    if (form.dataset.side !== ui.floatingSide) buildForm(form, ui.floatingSide);
  }

  function removeFloating() {
    doc.querySelector('[data-tpa="floating"]')?.remove();
  }

  // -------------------------------------------------------------------------------------------
  // Formulaire d'ordre
  // -------------------------------------------------------------------------------------------

  function buildForm(form, side) {
    const f = ui.forms[side];
    form.dataset.side = side;
    memory.delete(form);
    const buy = side === 'buy';
    form.innerHTML = `
      <div class="tpa-form">
        <div class="tpa-box">
          <div class="tpa-box-head">
            <span>Seuil</span>
            <span class="tpa-metric" data-slot="metric">
              <button type="button" data-metric="mc">MC</button>
              <button type="button" data-metric="price">Prix</button>
            </span>
            <span class="tpa-grow"></span>
            <span class="tpa-dir" data-slot="dir" hidden></span>
          </div>
          <div class="tpa-big">
            <input data-field="target" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Seuil de déclenchement" placeholder="${buy ? 'ex. 1.5M' : 'ex. 5M'}" value="${esc(f.target)}">
            <em data-slot="now"></em>
          </div>
        </div>
        <div class="tpa-chips" data-slot="target-chips"></div>
        ${
          buy
            ? `
        <div class="tpa-box">
          <div class="tpa-box-head"><span>Montant à acheter</span><span class="tpa-grow"></span><span data-slot="cash"></span></div>
          <div class="tpa-big"><span>$</span><input data-field="amount" inputmode="decimal" autocomplete="off" aria-label="Montant à acheter en dollars" placeholder="0" value="${esc(f.amount)}"></div>
        </div>
        <div class="tpa-chips">${BUY_AMOUNTS.map((v) => `<button type="button" data-amount="${v}">$${v}</button>`).join('')}</div>
        <div class="tpa-box tpa-exits">
          <div class="tpa-box-head"><span>Après l’achat, poser automatiquement</span></div>
          <div class="tpa-exit" data-exit="tp">
            <label><input type="checkbox" class="tpa-check" data-field="tpOn" ${f.tpOn ? 'checked' : ''}> Prise de profit</label>
            à ×<input type="text" data-field="tpMultiple" inputmode="decimal" aria-label="Multiple de prise de profit" value="${esc(f.tpMultiple)}">
            → vendre <input type="text" data-field="tpPct" inputmode="numeric" aria-label="Pourcentage vendu à la prise de profit" value="${esc(f.tpPct)}"> %
          </div>
          <div class="tpa-exit" data-exit="sl">
            <label><input type="checkbox" class="tpa-check" data-field="slOn" ${f.slOn ? 'checked' : ''}> Stop</label>
            à −<input type="text" data-field="slDrop" inputmode="numeric" aria-label="Baisse du stop en pourcentage" value="${esc(f.slDrop)}"> %
            → vendre <input type="text" data-field="slPct" inputmode="numeric" aria-label="Pourcentage vendu au stop" value="${esc(f.slPct)}"> %
          </div>
        </div>`
            : `
        <div class="tpa-box">
          <div class="tpa-box-head"><span>Part de ton avoir à vendre</span><span class="tpa-grow"></span><span data-slot="holding"></span></div>
          <div class="tpa-big tpa-big-pct"><input data-field="pct" inputmode="numeric" autocomplete="off" aria-label="Pourcentage de l’avoir à vendre" placeholder="25" maxlength="3" value="${esc(f.pct)}"><span>%</span><em data-slot="pct-usd"></em></div>
        </div>
        <div class="tpa-chips">${SELL_PCTS.map((v) => `<button type="button" data-pct="${v}">${v}%</button>`).join('')}</div>
        <div class="tpa-exit" data-slot="confirm-row" hidden style="padding:0 8px">
          Attendre <input type="text" data-field="confirmSec" inputmode="numeric" aria-label="Secondes sous le seuil avant de vendre" placeholder="15" value="${esc(f.confirmSec)}"> s sous le seuil avant de vendre
        </div>`
        }
        <p class="tpa-summary" data-slot="summary"></p>
        <p class="tpa-msg" data-slot="msg" role="status" hidden></p>
        <button type="button" class="tpa-submit ${buy ? 'tpa-buy' : 'tpa-sell'}" data-action="submit"><span>${buy ? 'Placer l’ordre d’achat' : 'Placer l’ordre de vente'}</span></button>
        <p class="tpa-fine">Exécuté par une page fomo ouverte : garde le navigateur ouvert et l’ordinateur éveillé.</p>
      </div>`;

    form.oninput = (event) => {
      const input = event.target.closest('[data-field]');
      if (!input) return;
      ui.forms[side][input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
      if (ui.flash?.side === side && ui.flash.kind !== 'ok') ui.flash = null;
      updateForm(form);
    };
    form.onchange = form.oninput;
    form.onclick = (event) => {
      const metric = event.target.closest('[data-metric]');
      if (metric) {
        if (ui.metric === metric.dataset.metric) return;
        ui.metric = metric.dataset.metric;
        ui.forms.buy.target = '';
        ui.forms.sell.target = '';
        form.querySelector('[data-field="target"]').value = '';
        return updateForm(form);
      }
      const chip = event.target.closest('[data-target],[data-amount],[data-pct]');
      if (chip) {
        const [field, value] =
          chip.dataset.target !== undefined ? ['target', chip.dataset.target] : chip.dataset.amount !== undefined ? ['amount', chip.dataset.amount] : ['pct', chip.dataset.pct];
        ui.forms[side][field] = value;
        form.querySelector(`[data-field="${field}"]`).value = value;
        ui.flash = null;
        return updateForm(form);
      }
      if (event.target.closest('[data-action="submit"]')) submit(form, side);
    };
    // Les raccourcis clavier de fomo (« / » ouvre la recherche) ne doivent pas voler la frappe.
    form.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && event.target.matches('input[data-field]:not([type="checkbox"])')) submit(form, side);
    };
    updateForm(form);
  }

  /** Tout ce qu'on sait dire d'une saisie : sens, estimations, erreurs bloquantes, avertissements. */
  function analyze(side) {
    const f = ui.forms[side];
    const value = currentValue();
    const target = parseCompactUsd(f.target);
    const net = ui.token?.networkId;
    const minBuy = minTradeUsd(ui.mins, 'buy', net);
    const minSell = minTradeUsd(ui.mins, 'sell', net);
    const out = { side, value, target, op: null, errors: [], warnings: [], attached: [], ready: false };
    if (f.target && !target) out.errors.push('Seuil illisible : tape par exemple 1.5M, 500k ou 0.0004.');
    if (target && value) {
      if (target === value) out.errors.push('Le seuil est égal à la valeur actuelle : choisis-le au-dessus ou en dessous.');
      out.op = target < value ? 'lte' : 'gte';
    }

    if (side === 'buy') {
      out.amount = parseCompactUsd(f.amount);
      if (f.amount && !out.amount) out.errors.push('Montant illisible : tape un nombre de dollars, par exemple 50.');
      if (out.amount && out.amount < minBuy) out.errors.push(`fomo refuse tout achat sous ${formatPriceUsd(minBuy)}.`);
      if (out.amount && ui.cash !== null && out.amount > ui.cash) {
        out.warnings.push(`Cash disponible : ${formatPriceUsd(ui.cash)}. Dépose avant le déclenchement, sinon fomo refusera l’achat.`);
      }
      if (f.tpOn) {
        const multiple = parseDecimal(f.tpMultiple);
        const pct = Number(f.tpPct);
        if (!(multiple > 1)) out.errors.push('Prise de profit : un multiple supérieur à 1 (×2, ×1,5…).');
        else if (!isPct(pct)) out.errors.push('Prise de profit : un pourcentage entre 1 et 100.');
        else {
          out.attached.push({ kind: 'tp', multiple, sellPct: pct });
          if (out.amount && out.amount * multiple * (pct / 100) < minSell) {
            out.errors.push(`La prise de profit vendrait ≈ ${formatPriceUsd(out.amount * multiple * (pct / 100))} : sous le minimum de vente fomo (${formatPriceUsd(minSell)}).`);
          }
        }
      }
      if (f.slOn) {
        const drop = Number(f.slDrop);
        const pct = Number(f.slPct);
        if (!(Number.isInteger(drop) && drop >= 1 && drop <= 99)) out.errors.push('Stop : une baisse entre 1 et 99 %.');
        else if (!isPct(pct)) out.errors.push('Stop : un pourcentage entre 1 et 100.');
        else {
          const multiple = 1 - drop / 100;
          out.attached.push({ kind: 'sl', multiple, sellPct: pct });
          if (out.amount && out.amount * multiple * (pct / 100) < minSell) {
            out.errors.push(`Le stop vendrait ≈ ${formatPriceUsd(out.amount * multiple * (pct / 100))} : sous le minimum de vente fomo (${formatPriceUsd(minSell)}).`);
          }
        }
      }
      out.ready = !!(target && value && out.amount && out.errors.length === 0);
    } else {
      out.pct = Number(f.pct);
      if (f.pct !== '' && !isPct(out.pct)) out.errors.push('Pourcentage à vendre : un entier entre 1 et 100.');
      if (f.confirmSec !== '' && !(Number(f.confirmSec) >= 0 && Number(f.confirmSec) <= 3600)) out.errors.push('Attente : entre 0 et 3600 s.');
      const held = ui.holding;
      if (held && !(held.amount > 0)) out.errors.push(`Tu ne détiens aucun ${symbol()} : rien à vendre.`);
      if (held?.found && isPct(out.pct) && target && value) {
        out.sellUsd = estimateSellUsdAtTarget({ holdingUsd: held.usd, currentValue: value, target, sellPct: out.pct });
        if (out.sellUsd !== null && out.sellUsd < minSell) {
          out.errors.push(`À ce seuil, la vente vaudrait ≈ ${formatPriceUsd(out.sellUsd)} : fomo refuse toute vente sous ${formatPriceUsd(minSell)}.`);
        }
      }
      out.ready = !!(target && value && isPct(out.pct) && out.errors.length === 0);
    }
    return out;
  }

  function updateForm(form) {
    const side = form.dataset.side;
    if (!side) return;
    const a = analyze(side);
    const f = ui.forms[side];
    const value = a.value;
    const slot = (name) => form.querySelector(`[data-slot="${name}"]`);
    const what = ui.metric === 'mc' ? 'la MC' : 'le prix';
    const seen = memory.get(form) ?? {};

    setData(slot('metric'), 'active', ui.metric);
    for (const button of form.querySelectorAll('[data-metric]')) toggleClass(button, 'tpa-on', button.dataset.metric === ui.metric);

    // Valeur actuelle : clignote vert/rouge quand la cote bouge, comme les prix de fomo.
    const now = slot('now');
    setText(now, value ? `actuel ${ui.quote?.approx ? '≈' : ''}${formatValue(ui.metric, value)}` : 'cote…');
    if (value && seen.value && value !== seen.value && seen.metric === ui.metric) flash(now, value > seen.value ? 'up' : 'down', 'tick', 1_100);

    const dir = slot('dir');
    if (a.op) {
      setHidden(dir, false);
      setText(dir, a.op === 'lte' ? '↓ à la baisse' : '↑ à la hausse');
      toggleClass(dir, 'tpa-up', a.op === 'gte');
      toggleClass(dir, 'tpa-down', a.op === 'lte');
      if (seen.op !== a.op) flash(dir, 'pop');
    } else setHidden(dir, true);

    // Raccourcis de seuil, relatifs à la valeur actuelle : repli d'abord pour un achat, hausse d'abord pour une vente.
    const chips = slot('target-chips');
    const multiples = side === 'buy' ? [[0.9, '−10%'], [0.8, '−20%'], [0.7, '−30%'], [0.5, '−50%'], [1.5, '×1,5']] : [[1.5, '×1,5'], [2, '×2'], [3, '×3'], [5, '×5'], [0.7, '−30%']];
    // Les raccourcis suivent la cote, mais pas à chaque tick : ils se recalent quand elle bouge de plus de 1 %.
    const anchor = seen.anchor && seen.metric === ui.metric && value && Math.abs(value / seen.anchor - 1) < 0.01 ? seen.anchor : value;
    const chipsHtml = anchor
      ? multiples
          .map(([k, label]) => {
            const shown = formatCompactInput(anchor * k);
            return `<button type="button" data-target="${esc(shown)}" title="${esc(`${ui.metric === 'mc' ? 'MC' : 'Prix'} ${formatThreshold(ui.metric, anchor * k)}`)}">${label}</button>`;
          })
          .join('')
      : '';
    setHtml(chips, chipsHtml);
    for (const chip of form.querySelectorAll('[data-target]')) toggleClass(chip, 'tpa-on', chip.dataset.target === f.target);
    for (const chip of form.querySelectorAll('[data-amount]')) toggleClass(chip, 'tpa-on', chip.dataset.amount === f.amount);
    for (const chip of form.querySelectorAll('[data-pct]')) toggleClass(chip, 'tpa-on', chip.dataset.pct === f.pct);

    if (side === 'buy') {
      setText(slot('cash'), ui.cash !== null ? `cash ${formatPriceUsd(ui.cash)}` : '');
      for (const exit of form.querySelectorAll('[data-exit]')) toggleClass(exit, 'tpa-off', !f[`${exit.dataset.exit}On`]);
    } else {
      const held = ui.holding;
      setText(slot('holding'), held ? (held.found && held.amount > 0 ? `avoir ${formatPriceUsd(held.usd ?? 0)}` : 'aucun avoir') : '');
      setText(slot('pct-usd'), a.sellUsd ? `≈ ${formatPriceUsd(a.sellUsd)} au seuil` : '');
      setHidden(slot('confirm-row'), a.op !== 'lte');
    }

    setHtml(slot('summary'), summaryHtml(a, what));

    const msg = slot('msg');
    const message = ui.flash?.side === side ? ui.flash : a.errors.length ? { kind: 'err', text: a.errors[0] } : a.warnings.length ? { kind: 'warn', text: a.warnings[0] } : null;
    setHidden(msg, !message);
    if (message) {
      setText(msg, message.text);
      setAttr(msg, 'class', `tpa-msg tpa-${message.kind}`);
    }
    const submitButton = form.querySelector('[data-action="submit"]');
    const disabled = !a.ready || submitButton.dataset.state === 'busy';
    if (submitButton.disabled !== disabled) submitButton.disabled = disabled;

    memory.set(form, { value, op: a.op, metric: ui.metric, anchor });
  }

  function summaryHtml(a, what) {
    const sym = esc(symbol());
    if (!a.value) return 'Cote en cours de lecture…';
    if (!a.target) return `Tape un seuil ou choisis un raccourci. ${what === 'la MC' ? 'MC actuelle' : 'Prix actuel'} : <b>${esc(formatValue(ui.metric, a.value))}</b>.`;
    if (!a.op) return '';
    const ratio = a.target / a.value;
    const delta = a.op === 'gte' ? `×${ratio.toFixed(ratio < 10 ? 2 : 1).replace('.', ',')}` : `−${Math.round((1 - ratio) * 100)}\u202f%`;
    const level = `<b>${esc(formatThreshold(ui.metric, a.target))}</b> (${delta})`;
    const move = a.op === 'lte' ? `tombe à ${level}` : `${a.side === 'buy' ? 'monte à' : 'atteint'} ${level}`;
    if (a.side === 'buy') {
      const amount = a.amount ? `<b>${esc(formatPriceUsd(a.amount))}</b>` : 'le montant choisi';
      const exits = a.attached.length
        ? ` Puis ${a.attached
            .map((x) => (x.kind === 'tp' ? `vend ${formatPct(x.sellPct)} à ×${String(x.multiple).replace('.', ',')}` : `stop à −${Math.round((1 - x.multiple) * 100)}\u202f% (vend ${formatPct(x.sellPct)})`))
            .join(', ')}.`
        : '';
      return `${a.op === 'lte' ? '↓' : '↑'} Achète ${amount} de ${sym} si ${what} ${move}.${exits}`;
    }
    const pct = isPct(a.pct) ? `<b>${formatPct(a.pct)}</b>` : 'une part';
    const confirm = a.op === 'lte' ? `, après ${ui.forms.sell.confirmSec === '' ? 15 : Number(ui.forms.sell.confirmSec)}\u00a0s sous le seuil` : '';
    return `${a.op === 'lte' ? '↓' : '↑'} Vend ${pct} de ton ${sym} si ${what} ${move}${confirm}.`;
  }

  async function submit(form, side) {
    const a = analyze(side);
    const msg = () => form.querySelector('[data-slot="msg"]');
    const fail = (text) => {
      ui.flash = { side, kind: 'err', text };
      updateForm(form);
      flash(msg(), 'shake', 'flash', 400);
    };
    if (!a.value) return fail('Cote pas encore reçue : attends une seconde puis réessaie.');
    if (!a.target) return fail('Tape un seuil, par exemple 1.5M.');
    if (a.errors.length) return fail(a.errors[0]);
    if (!a.ready) return fail(side === 'buy' ? 'Indique le montant à acheter.' : 'Indique le pourcentage à vendre.');

    const button = form.querySelector('[data-action="submit"]');
    setData(button, 'state', 'busy');
    button.disabled = true;
    const input = {
      side,
      chain: ui.token.chain,
      networkId: ui.token.networkId,
      address: ui.token.address,
      symbol: symbol(),
      metric: ui.metric,
      target: a.target,
      ...(side === 'buy'
        ? { amountUsd: a.amount, attached: a.attached }
        : { sellPct: a.pct, confirmSec: ui.forms.sell.confirmSec === '' ? undefined : Number(ui.forms.sell.confirmSec) }),
    };
    let res;
    try {
      res = await chromeApi.runtime.sendMessage({ type: 'ADD_ORDER', currentValue: a.value, input });
    } catch (error) {
      res = { ok: false, error: `Extension injoignable (${error?.message ?? error}) : recharge la page.` };
    }
    delete button.dataset.state;
    if (!res?.ok) return fail(res?.error ?? 'Ordre refusé.');

    ui.justCreated = res.order.id;
    ui.forms[side].target = '';
    form.querySelector('[data-field="target"]').value = '';
    ui.flash = { side, kind: 'ok', text: `Ordre placé : ${describeOrder(res.order)}${res.order.attached?.length ? `, ${describeAttached(res.order)}` : ''}.` };
    updateForm(form);
    flash(button, 'done', 'state', 900);
  }

  // -------------------------------------------------------------------------------------------
  // Listes d'ordres : carte du token, tiroir, bouton de la barre du haut
  // -------------------------------------------------------------------------------------------

  function renderData() {
    doc.querySelectorAll('[data-tpa="form"]').forEach((form) => updateForm(form));
    const card = doc.querySelector('[data-tpa="orders"]');
    if (card) renderOrdersCard(card);
    const chip = doc.querySelector('[data-tpa="chip"]');
    if (chip) renderChip(chip);
    const switcher = doc.querySelector('[data-tpa="mode"]');
    if (switcher) renderModeCount(switcher);
    const drawer = doc.querySelector('[data-tpa="drawer"]');
    if (drawer && ui.drawerOpen) renderDrawer(drawer);
  }

  function renderModeCount(switcher) {
    const badge = switcher.querySelector('[data-slot="mode-count"]');
    const active = tokenOrders().filter(isWatched).length;
    setHidden(badge, active === 0);
    if (setText(badge, String(active)) && active > 0) flash(badge, 'bump');
  }

  function healthState() {
    const active = Object.values(ui.orders).filter(isWatched).length;
    if (!ui.settings.enabled) return { tone: '', text: 'En pause', active };
    if (!active) return { tone: '', text: 'Aucun ordre actif', active };
    if (ui.health.problem) return { tone: 'bad', text: ui.health.problem, active };
    if (ui.health.lastQuoteAt) {
      const age = Date.now() - ui.health.lastQuoteAt;
      return { tone: age < 20_000 ? 'good' : 'bad', text: `Surveillé · cote ${formatAgo(age)}`, active };
    }
    return { tone: '', text: 'Démarrage…', active };
  }

  function paintState(el, state) {
    setText(el, state.text);
    setAttr(el, 'class', `tpa-state${state.tone ? ` tpa-${state.tone}` : ''}`);
  }

  function renderChip(chip) {
    const state = healthState();
    const dot = chip.querySelector('[data-slot="dot"]');
    setAttr(dot, 'class', `tpa-chip-dot${state.tone ? ` tpa-${state.tone}` : ''}`);
    const count = chip.querySelector('[data-slot="count"]');
    const label = state.active ? String(state.active) : ui.settings.enabled ? '' : '⏸';
    if (setText(count, label) && label) flash(count, 'bump');
    setAttr(chip, 'title', `Ordres auto — ${state.text}`);
  }

  function renderOrdersCard(card) {
    const orders = tokenOrders();
    setHidden(card, orders.length === 0);
    if (!orders.length) return;
    paintState(card.querySelector('[data-slot="state"]'), healthState());
    renderRows(card.querySelector('[data-slot="rows"]'), orders);
  }

  function renderDrawer(drawer) {
    paintState(drawer.querySelector('[data-slot="drawer-state"]'), healthState());
    const toggle = drawer.querySelector('[data-setting="enabled"]');
    if (toggle.checked !== ui.settings.enabled) toggle.checked = ui.settings.enabled;
    setText(drawer.querySelector('[data-slot="drawer-mode"]'), ui.settings.dryRun ? 'Mode test : rien n’est exécuté pour de vrai' : '');

    const body = drawer.querySelector('[data-slot="drawer-body"]');
    const groups = new Map();
    for (const order of sortOrders(Object.values(ui.orders))) {
      if (!groups.has(order.tokenId)) groups.set(order.tokenId, []);
      groups.get(order.tokenId).push(order);
    }

    let empty = body.querySelector(':scope > .tpa-empty');
    if (!groups.size) {
      [...body.children].forEach((el) => el !== empty && el.remove());
      if (!empty) {
        empty = h('p', { class: 'tpa-empty' });
        empty.textContent = 'Aucun ordre. Sur la page d’un token, choisis « Ordre auto » sous les onglets Buy / Sell.';
        body.appendChild(empty);
      }
      return;
    }
    empty?.remove();

    let previous = null;
    const keep = new Set(groups.keys());
    for (const el of [...body.children]) if (!keep.has(el.dataset.group)) el.remove();
    for (const [key, list] of groups) {
      let group = [...body.children].find((el) => el.dataset.group === key);
      if (!group) {
        group = h('section', { class: 'tpa-group', 'data-group': key });
        group.innerHTML = `
          <div class="tpa-group-head">
            <span>${esc(list[0].symbol)} <small>· ${esc(CHAIN_LABELS[list[0].chain] ?? list[0].chain)}</small></span>
            <a href="/tokens/${esc(list[0].chain)}/${esc(list[0].address)}">Ouvrir ↗</a>
          </div>
          <div class="tpa-rows"></div>`;
      }
      placeAfter(body, group, previous);
      previous = group;
      renderRows(group.querySelector('.tpa-rows'), list);
    }
  }

  /** Lignes gardées par identifiant d'ordre : mise à jour sur place, entrée animée seulement pour les nouvelles. */
  function renderRows(container, orders) {
    const keep = new Set(orders.map((o) => o.id));
    for (const row of [...container.children]) if (!keep.has(row.dataset.orderId)) row.remove();
    let previous = null;
    orders.forEach((order, index) => {
      let row = [...container.children].find((el) => el.dataset.orderId === order.id);
      if (!row) {
        row = h('div', { class: 'tpa-order', 'data-order-id': order.id });
        row.style.animationDelay = `${Math.min(index, 6) * 40}ms`;
      }
      if (row.dataset.status && row.dataset.status !== order.status) flash(row, 'status');
      setData(row, 'status', order.status);
      if (ui.justCreated === order.id) {
        ui.justCreated = null;
        row.style.animationDelay = '';
        flash(row, 'new', 'flash', 1_600);
      }
      setHtml(row, orderRowInner(order));
      placeAfter(container, row, previous);
      previous = row;
    });
  }

  function orderRowInner(o) {
    const active = isWatched(o);
    const actions = [];
    if (o.status === 'armed') actions.push(['test', 'Tester']);
    if (o.status === 'armed' || o.status === 'pending' || o.status === 'queued') actions.push(['cancel', 'Annuler']);
    if (!active) actions.push(['rearm', 'Réarmer'], ['delete', 'Supprimer']);
    const meta = [
      KIND_LABELS[o.kind],
      o.kind === 'sl' ? `${o.confirmSec}\u00a0s de confirmation` : null,
      o.lastValue ? `actuel ${formatValue(o.metric, o.lastValue)}` : null,
      o.parentId ? 'posé après un achat' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const extra = o.error
      ? `<div class="tpa-order-err">${esc(o.error)}</div>`
      : o.result?.simulated
        ? `<div class="tpa-order-meta">${esc(o.result.detail ?? 'Simulé')}</div>`
        : o.attached?.length
          ? `<div class="tpa-order-meta">${esc(describeAttached(o))}</div>`
          : '';
    return `
      <div class="tpa-order-top">
        <span class="tpa-order-desc"><span class="tpa-side tpa-${o.side ?? 'sell'}" aria-hidden="true">${o.side === 'buy' ? '▲' : '▼'}</span>${esc(describeOrder(o))}</span>
        <span class="tpa-status tpa-s-${o.status}">${esc(STATUS_LABELS[o.status] ?? o.status)}</span>
      </div>
      <div class="tpa-order-meta">${esc(meta)}</div>
      ${extra}
      <div class="tpa-order-actions">${actions.map(([op, label]) => `<button type="button" data-op="${op}" data-id="${esc(o.id)}">${label}</button>`).join('')}</div>`;
  }

  async function onOrderAction(event) {
    if (event.target.closest('[data-action="drawer"]')) return openDrawer(true);
    const button = event.target.closest('[data-op]');
    if (!button) return;
    const { op, id } = button.dataset;
    if (op === 'delete' && !win.confirm('Supprimer cet ordre ?')) return;
    const type = { cancel: 'CANCEL_ORDER', rearm: 'REARM_ORDER', delete: 'DELETE_ORDER', test: 'TEST_ORDER' }[op];
    const order = ui.orders[id];
    const value = order && ui.quote && order.tokenId === ui.token?.id ? (order.metric === 'mc' ? ui.quote.mc : ui.quote.price) : undefined;
    button.disabled = true;
    if (op === 'test') button.textContent = 'Test en cours…';
    const res = await chromeApi.runtime.sendMessage({ type, id, currentValue: value });
    button.disabled = false;
    if (op === 'test') {
      button.textContent = 'Tester';
      win.alert(res?.ok ? `Test réussi (rien n’a été exécuté) : ${res.detail}` : `Test en échec : ${res?.detail ?? res?.error}`);
    } else if (!res?.ok) {
      win.alert(res?.error ?? 'Action refusée.');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Outils DOM
  // -------------------------------------------------------------------------------------------

  function h(tag, attrs = {}) {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  }

  function child(parent, name) {
    return [...parent.children].find((el) => el.getAttribute('data-tpa') === name) ?? null;
  }

  /** Pose un attribut `data-<name>` le temps d'une animation, puis le retire. */
  function flash(el, value, name = 'flash', ms = 700) {
    if (!el) return;
    el.removeAttribute(`data-${name}`);
    void el.offsetWidth; // relance l'animation si la même valeur était déjà posée
    el.setAttribute(`data-${name}`, value);
    win.setTimeout(() => {
      if (el.getAttribute(`data-${name}`) === value) el.removeAttribute(`data-${name}`);
    }, ms);
  }

  function readSession(key) {
    try {
      return win.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSession(key, value) {
    try {
      win.sessionStorage.setItem(key, value);
    } catch {
      // stockage indisponible : le mode ne survit pas au rechargement, rien de grave
    }
  }

  sync();
  return { sync, ui };
}

/** Écritures idempotentes : rendent `true` seulement quand elles changent quelque chose. */
function setText(el, text) {
  if (!el || el.textContent === text) return false;
  el.textContent = text;
  return true;
}

/** Dernier HTML écrit par nous dans chaque élément : on ne réécrit (et ne re-mute) que s'il change. */
const writtenHtml = new WeakMap();

function setHtml(el, html) {
  if (!el || writtenHtml.get(el) === html) return false;
  writtenHtml.set(el, html);
  el.innerHTML = html;
  return true;
}

function setHidden(el, hidden) {
  if (el && el.hidden !== hidden) el.hidden = hidden;
}

function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function setData(el, name, value) {
  setAttr(el, `data-${name}`, value);
}

function toggleClass(el, name, on) {
  if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

function placeAfter(container, el, previous) {
  const expected = previous ? previous.nextElementSibling : container.firstElementChild;
  if (el === expected) return;
  if (previous) previous.after(el);
  else container.prepend(el);
}

function isPct(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100;
}

function parseDecimal(text) {
  const n = Number(String(text ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
