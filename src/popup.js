/**
 * Fenêtre de l'extension : tous les ordres, l'état du veilleur, les réglages, le journal.
 * Elle ne décide rien : chaque action est un message au service worker, qui reste la seule
 * source de vérité (le panneau de page et cette fenêtre peuvent être ouverts en même temps).
 */

import { CHAIN_LABELS, tokenUrl } from './lib/chains.js';
import { formatAgo } from './lib/format.js';
import { KIND_LABELS, STATUS_LABELS, describeAttached, describeOrder, formatValue, isWatched } from './lib/orders.js';

const slot = (name) => document.querySelector(`[data-slot="${name}"]`);

let state = { orders: {}, settings: {}, health: {}, journal: [] };

async function load() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res?.ok) {
    state = res;
    render();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of ['orders', 'settings', 'health', 'journal']) {
    if (changes[key]) state[key] = changes[key].newValue ?? (key === 'journal' ? [] : {});
  }
  render();
});

function render() {
  renderHealth();
  renderSettings();
  renderOrders();
  renderJournal();
}

function renderHealth() {
  const el = slot('health');
  const { settings, health, orders } = state;
  const active = Object.values(orders).filter(isWatched).length;
  el.className = 'health';
  if (!settings.enabled) {
    el.textContent = '⏸ En pause : aucun ordre n’est surveillé.';
    el.classList.add('muted');
  } else if (!active) {
    el.textContent = 'Aucun ordre actif.';
    el.classList.add('muted');
  } else if (health.problem) {
    el.textContent = `⚠ ${health.problem}`;
    el.classList.add('warn');
  } else if (health.lastQuoteAt) {
    const age = Date.now() - health.lastQuoteAt;
    el.textContent = `● ${active} ordre${active > 1 ? 's' : ''} surveillé${active > 1 ? 's' : ''} · dernière cote ${formatAgo(age)}`;
    el.classList.add(age < 20_000 ? 'ok' : 'warn');
  } else {
    el.textContent = 'Démarrage de la surveillance…';
    el.classList.add('muted');
  }

  const banner = slot('banner');
  banner.hidden = !settings.dryRun;
  banner.textContent = settings.dryRun ? 'Mode test actif : les ordres déclenchés simulent le trade, rien n’est exécuté.' : '';
}

function renderSettings() {
  for (const input of document.querySelectorAll('[data-setting]')) {
    const value = state.settings[input.dataset.setting];
    if (document.activeElement === input) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value ?? '';
  }
  slot('enabled-label').textContent = state.settings.enabled ? 'Actif' : 'En pause';
}

function renderOrders() {
  const orders = Object.values(state.orders);
  slot('empty').hidden = orders.length > 0;
  const groups = new Map();
  for (const order of orders.sort((a, b) => Number(isWatched(b)) - Number(isWatched(a)) || b.createdAt - a.createdAt)) {
    if (!groups.has(order.tokenId)) groups.set(order.tokenId, []);
    groups.get(order.tokenId).push(order);
  }
  slot('orders').innerHTML = [...groups.values()]
    .map((list) => {
      const first = list[0];
      return `
        <div class="group">
          <div class="group-title">
            <span>${esc(first.symbol)} <small>· ${esc(CHAIN_LABELS[first.chain] ?? first.chain)}</small></span>
            <button data-open="${esc(first.id)}">Ouvrir sur fomo ↗</button>
          </div>
          ${list.map(orderRow).join('')}
        </div>`;
    })
    .join('');
}

function orderRow(o) {
  const active = isWatched(o);
  const actions = [];
  if (o.status === 'armed' || o.status === 'pending' || o.status === 'queued') actions.push(['cancel', 'Annuler']);
  if (o.status === 'armed') actions.push(['test', 'Tester (sans exécuter)']);
  if (!active) actions.push(['rearm', 'Réarmer'], ['delete', 'Supprimer']);
  const meta = [
    o.kind === 'sl' ? `Stop · confirmation ${o.confirmSec}\u00a0s` : KIND_LABELS[o.kind],
    o.lastValue ? `actuel ${formatValue(o.metric, o.lastValue)}` : null,
    o.attempts ? `${o.attempts} tentative${o.attempts > 1 ? 's' : ''}` : null,
    o.parentId ? 'posé après un achat' : null,
    describeAttached(o) || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const last = o.log?.at(-1);
  return `
    <div class="order">
      <div class="row">
        <span class="desc">${o.side === 'buy' ? '▲' : '▼'} ${esc(describeOrder(o))}</span>
        <span class="status s-${o.status}">${esc(STATUS_LABELS[o.status] ?? o.status)}</span>
      </div>
      <div class="meta">${esc(meta)}</div>
      ${o.error ? `<p class="err">${esc(o.error)}</p>` : ''}
      ${!o.error && last ? `<p class="note">${esc(new Date(last.at).toLocaleTimeString('fr-FR'))} · ${esc(last.msg)}</p>` : ''}
      <div class="actions">${actions.map(([op, label]) => `<button data-op="${op}" data-id="${esc(o.id)}">${label}</button>`).join('')}</div>
    </div>`;
}

function renderJournal() {
  slot('journal').innerHTML = [...state.journal]
    .reverse()
    .slice(0, 60)
    .map((e) => `<div class="${esc(e.level)}"><time>${esc(new Date(e.at).toLocaleTimeString('fr-FR'))}</time>${esc(e.msg)}</div>`)
    .join('');
}

document.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-setting]');
  if (!input) return;
  const key = input.dataset.setting;
  const value = input.type === 'checkbox' ? input.checked : input.type === 'text' ? input.value.trim() : Number(input.value);
  if (key === 'dryRun' && value === false && !confirm('Quitter le mode test ? Les ordres déclenchés achèteront et vendront pour de vrai.')) {
    input.checked = true;
    return;
  }
  if (key === 'allowHighPriceImpact' && value && !confirm('Autoriser des trades avec un impact de prix de 25 % ou plus ?')) {
    input.checked = false;
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', patch: { [key]: value } });
  if (res?.ok) state.settings = res.settings;
  render();
});

document.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open]');
  if (open) {
    const order = state.orders[open.dataset.open];
    if (order) chrome.tabs.create({ url: tokenUrl(order.chain, order.address) });
    return;
  }

  if (event.target.closest('[data-action="clear-journal"]')) {
    await chrome.runtime.sendMessage({ type: 'CLEAR_JOURNAL' });
    return;
  }

  const testTelegram = event.target.closest('[data-action="test-telegram"]');
  if (testTelegram) {
    testTelegram.disabled = true;
    testTelegram.textContent = 'Envoi…';
    const res = await chrome.runtime.sendMessage({ type: 'TEST_TELEGRAM' });
    testTelegram.disabled = false;
    testTelegram.textContent = 'Envoyer un message de test';
    alert(res?.ok ? 'Message envoyé : regarde ton Telegram.' : (res?.error ?? 'Échec de l’envoi.'));
    return;
  }

  const button = event.target.closest('[data-op]');
  if (!button) return;
  const { op, id } = button.dataset;
  if (op === 'delete' && !confirm('Supprimer cet ordre ?')) return;
  const type = { cancel: 'CANCEL_ORDER', rearm: 'REARM_ORDER', delete: 'DELETE_ORDER', test: 'TEST_ORDER' }[op];
  button.disabled = true;
  // L'onglet de test prend le focus et ferme cette fenêtre : le résultat arrive aussi en
  // notification et dans le journal.
  if (op === 'test') button.textContent = 'Test en cours… (un onglet s’ouvre)';
  const res = await chrome.runtime.sendMessage({ type, id });
  button.disabled = false;
  if (op === 'test') alert(res?.ok ? `Test réussi : ${res.detail}` : `Test en échec : ${res?.detail ?? res?.error}`);
  else if (!res?.ok) alert(res?.error ?? 'Action refusée.');
  load();
});

load();
setInterval(renderHealth, 1_000);

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
