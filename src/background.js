/**
 * Service worker : l'horloge et le chef d'orchestre.
 *
 *  - toutes les `pollSec` secondes, il demande à un onglet fomo « veilleur » la cote des tokens
 *    qui ont un ordre actif, et fait avancer chaque ordre (armé → confirmation → file) ;
 *  - un ordre déclenché s'exécute dans un onglet NEUF ouvert sur la page du token : un onglet
 *    fraîchement créé n'est pas bridé par Chrome comme un onglet caché depuis des heures, et le
 *    trade fomo (signature + suivi Relay) a besoin de ses minuteries ;
 *  - la preuve qu'un trade a eu lieu est le SOLDE du token, lu avant et après — pas un texte à
 *    l'écran. Un trade envoyé mais non confirmé n'est jamais relancé.
 *
 * Pourquoi l'horloge est ici et pas dans l'onglet : un onglet en arrière-plan depuis plus de
 * 5 minutes voit ses minuteries ramenées à une par minute ; les messages entrants, eux, ne sont
 * pas bridés. Le service worker sonne, l'onglet répond.
 */

import {
  DEFAULT_SETTINGS,
  KIND_LABELS,
  STATUS_LABELS,
  appendLog,
  applyEvaluation,
  boughtEnough,
  buildAttachedOrders,
  classifyExecution,
  createOrder,
  describeOrder,
  evaluateOrder,
  formatValue,
  isWatched,
  rearmOrder,
  recoverAfterRestart,
  soldEnough,
  stillValidAtDequeue,
} from './lib/orders.js';
import { tokenUrl } from './lib/chains.js';
import { formatPct, formatPriceUsd } from './lib/format.js';

const ALARM = 'tp-auto-veille';
const JOURNAL_LIMIT = 200;
/** Une panne qui dure se rappelle à toi toutes les six heures, pas une seule fois. */
const ALERT_AGAIN_MS = 6 * 60 * 60 * 1000;
/** Marge de renouvellement de la session fomo : on recharge l'onglet bien avant l'expiration. */
const SESSION_REFRESH_MARGIN_SEC = 600;
/** Fréquence du contrôle « l'interface de fomo est-elle toujours celle qu'on sait piloter ? ». */
const PROBE_EVERY_MS = 6 * 60 * 60 * 1000;
const FOMO_TABS = 'https://fomo.family/*';

const state = { orders: {}, settings: { ...DEFAULT_SETTINGS }, journal: [], health: {} };

let loopTimer = null;
let ticking = false;
let executingId = null;
let execTabId = null;
let lastWatcherCreate = 0;
let lastWatcherReload = 0;
let quoteFailures = 0;

const ready = init();

async function init() {
  const saved = await chrome.storage.local.get(['orders', 'settings', 'journal', 'health']);
  state.settings = { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) };
  state.journal = saved.journal ?? [];
  state.health = { ...(saved.health ?? {}), watching: false };

  const now = Date.now();
  const orders = saved.orders ?? {};
  let changed = false;
  for (const [id, order] of Object.entries(orders)) {
    const recovered = recoverAfterRestart(order, now);
    if (recovered !== order) {
      orders[id] = recovered;
      changed = true;
      if (recovered.status === 'failed') {
        log('error', `${order.symbol} : exécution interrompue par un redémarrage — vérifie ton solde sur fomo.`, id);
      }
    }
  }
  state.orders = orders;
  if (changed) await persistOrders();

  await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  await updateBadge();
  scheduleLoop(0);
}

chrome.runtime.onInstalled.addListener(() => ready.then(() => scheduleLoop(0)));
chrome.runtime.onStartup.addListener(() => ready.then(() => scheduleLoop(0)));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  ready.then(() => {
    if (!ticking && shouldWatch()) scheduleLoop(0);
  });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const orderId = notificationId.split('|')[0];
  const order = state.orders[orderId];
  if (order) chrome.tabs.create({ url: tokenUrl(order.chain, order.address) });
  chrome.notifications.clear(notificationId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.health.watcherTabId) setHealth({ watcherTabId: null });
});

// ---------------------------------------------------------------------------------------------
// Boucle de surveillance
// ---------------------------------------------------------------------------------------------

function shouldWatch() {
  return state.settings.enabled && Object.values(state.orders).some(isWatched);
}

function scheduleLoop(delayMs) {
  clearTimeout(loopTimer);
  loopTimer = setTimeout(runTick, delayMs);
}

async function runTick() {
  await ready;
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } catch (error) {
    log('error', `Erreur interne du veilleur : ${error?.message ?? error}`);
  } finally {
    ticking = false;
  }
  if (shouldWatch()) scheduleLoop(state.settings.pollSec * 1000);
  await updateBadge();
}

async function tick() {
  const watched = Object.values(state.orders).filter(isWatched);
  if (!state.settings.enabled || watched.length === 0) {
    await setHealth({ watching: false, problem: state.settings.enabled ? null : 'En pause' });
    return;
  }

  const watcher = await findWatcher(watched[0]);
  if (!watcher.ok) {
    await setHealth({ watching: true, problem: watcher.detail });
    return;
  }

  const ids = [...new Set(watched.map((o) => o.tokenId))];
  const res = await sendToTab(watcher.tabId, { type: 'QUOTES', ids }, 15_000);
  if (!res?.ok) {
    await onQuoteFailure(watcher, res);
    return;
  }

  if (quoteFailures > 0) {
    quoteFailures = 0;
    if (Object.keys(state.health.alerts ?? {}).length) await setHealth({ alerts: {} });
  }
  // Renouvellement d'avance : un onglet en arrière-plan voit ses minuteries bridées, donc l'appli
  // fomo peut oublier de rafraîchir son jeton. Recharger la page le refait — et on s'y prend
  // 10 minutes avant l'expiration plutôt qu'à la dernière seconde.
  if (Number.isFinite(res.expInSec)) {
    if (res.expInSec !== state.health.sessionExpSec) await setHealth({ sessionExpSec: res.expInSec });
    if (res.expInSec < SESSION_REFRESH_MARGIN_SEC) await reloadWatcher(watcher.tabId, `session à renouveler (${res.expInSec} s restantes)`);
  }

  const now = Date.now();
  const quotes = {};
  for (const [id, quote] of Object.entries(res.quotes ?? {})) quotes[id] = { ...quote, at: res.at ?? now };
  await setHealth({ watching: true, problem: null, lastQuoteAt: now, watcherTabId: watcher.tabId, quotes });
  await maybeProbe(watcher.tabId);

  let changed = false;
  for (const order of Object.values(state.orders)) {
    const evaluation = evaluateOrder(order, quotes[order.tokenId], now);
    if (evaluation.action === 'none' && (evaluation.value === undefined || evaluation.value === order.lastValue)) continue;
    state.orders[order.id] = applyEvaluation(order, evaluation, now);
    changed = true;

    if (evaluation.action === 'pending') {
      log('info', `${order.symbol} : seuil franchi (${formatValue(order.metric, evaluation.value)}), confirmation ${order.confirmSec} s`, order.id);
    } else if (evaluation.action === 'crossed') {
      log('info', `${order.symbol} : surveillance active (${formatValue(order.metric, evaluation.value)})`, order.id);
    } else if (evaluation.action === 'reset') {
      log('info', `${order.symbol} : repassé de l'autre côté du seuil pendant la confirmation — réarmé`, order.id);
    } else if (evaluation.action === 'fire') {
      const msg = `${describeOrder(order)} — déclenché à ${formatValue(order.metric, evaluation.value)}`;
      log('warn', `${order.symbol} : ${msg}`, order.id);
      notify(order.id, `${KIND_LABELS[order.kind]} déclenché : ${order.symbol}`, msg);
    }
  }
  if (changed) await persistOrders();

  if (!executingId) {
    const next = Object.values(state.orders)
      .filter((o) => o.status === 'queued')
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (next) {
      executingId = next.id;
      executeOrder(next.id, quotes).finally(() => {
        executingId = null;
        scheduleLoop(0);
      });
    }
  }
}

async function onQuoteFailure(watcher, res) {
  quoteFailures += 1;
  const reason = res?.reason ?? 'inconnu';

  if (reason === 'no-receiver' || reason === 'timeout') {
    await setHealth({ watcherTabId: null, problem: "L'onglet veilleur fomo ne répond pas — relance…" });
    if (watcher.tabId && !executingId) await reloadWatcher(watcher.tabId, 'onglet muet');
    return;
  }

  const sessionProblem = ['no-session', 'expired', 'http-401', 'http-403'].includes(reason);
  if (sessionProblem) {
    await setHealth({ problem: 'Session fomo expirée ou fermée' });
    // Un rechargement laisse Privy renouveler le jeton ; si ça ne suffit pas, c'est une vraie déconnexion.
    const reloaded = await reloadWatcher(watcher.tabId, 'session à renouveler');
    if (!reloaded && quoteFailures >= 5) {
      await alertAgain(
        'session',
        'Session fomo fermée',
        'Reconnecte-toi sur fomo.family : tes ordres ne sont plus surveillés.',
        'Session fomo fermée : ordres non surveillés tant que tu ne te reconnectes pas.',
      );
    }
    return;
  }

  await setHealth({ problem: `Cotation impossible (${reason})` });
  if (quoteFailures * state.settings.pollSec >= 60) {
    await alertAgain(
      'stale',
      'Plus de cotation',
      `Raison : ${reason}. Vérifie ta connexion et l'onglet fomo.`,
      `Plus de cotation (${reason})`,
    );
  }
}

/**
 * Contrôle périodique de l'interface de fomo, en lecture seule : si une mise à jour de fomo
 * déplace ses repères, on le sait tout de suite, et pas au moment où un ordre devait partir.
 */
async function maybeProbe(tabId) {
  if (Date.now() - (state.health.probe?.at ?? 0) < PROBE_EVERY_MS) return;
  const res = await sendToTab(tabId, { type: 'PROBE' }, 8_000);
  if (!res || res.reason === 'pas-page-token') return; // depuis une autre page, on ne peut rien juger
  await setHealth({ probe: { at: Date.now(), ok: !!res.ok, manquants: res.manquants ?? [] } });
  if (res.ok) {
    if (state.health.alerts?.interface) await setHealth({ alerts: { ...state.health.alerts, interface: 0 } });
    return;
  }
  await alertAgain(
    'interface',
    'fomo a changé son interface',
    `Introuvable : ${res.manquants.join(', ')}. Tes ordres ne pourront pas s’exécuter tant que l’extension n’est pas mise à jour.`,
    `Contrôle de l'interface fomo en échec : ${res.manquants.join(', ')}`,
  );
}

/**
 * Une panne qui dure : prévenir une fois ne suffit pas. Un ordre posé lundi et une session tombée
 * mardi doivent continuer de faire du bruit tant qu'un ordre attend. Le moment de la dernière
 * alerte vit dans `health` : il survit aux redémarrages du service worker, donc pas de rafale.
 */
async function alertAgain(key, title, message, logLine) {
  const previous = state.health.alerts?.[key] ?? 0;
  if (Date.now() - previous < ALERT_AGAIN_MS) return;
  await setHealth({ alerts: { ...(state.health.alerts ?? {}), [key]: Date.now() } });
  const armed = Object.values(state.orders).filter(isWatched).length;
  notify(key, title, `${message}${armed ? ` ${armed} ordre${armed > 1 ? 's' : ''} en attente.` : ''}`, true);
  log('error', logLine);
}

/**
 * L'onglet qui cote : celui qu'on a déjà, sinon n'importe quel onglet fomo qui répond, sinon
 * un onglet épinglé qu'on ouvre nous-mêmes. Jamais l'onglet d'exécution.
 */
async function findWatcher(hintOrder) {
  const remembered = state.health.watcherTabId;
  if (remembered && remembered !== execTabId) {
    const tab = await chrome.tabs.get(remembered).catch(() => null);
    if (tab && !tab.discarded && tab.url?.startsWith('https://fomo.family/')) return { ok: true, tabId: remembered };
    if (tab?.discarded) await chrome.tabs.reload(remembered).catch(() => {});
  }

  const tabs = await chrome.tabs.query({ url: FOMO_TABS });
  for (const tab of tabs) {
    if (tab.id === execTabId || tab.discarded) continue;
    const ping = await sendToTab(tab.id, { type: 'PING' }, 3_000);
    if (ping?.ok) {
      chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
      await setHealth({ watcherTabId: tab.id });
      return { ok: true, tabId: tab.id };
    }
  }

  if (Date.now() - lastWatcherCreate < 60_000) return { ok: false, detail: 'Ouverture de l’onglet veilleur fomo…' };
  lastWatcherCreate = Date.now();
  const url = hintOrder ? tokenUrl(hintOrder.chain, hintOrder.address) : 'https://fomo.family/';
  const tab = await chrome.tabs.create({ url, pinned: true, active: false });
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await setHealth({ watcherTabId: tab.id, ownWatcherTabId: tab.id });
  log('info', 'Onglet veilleur fomo ouvert (épinglé). Laisse-le ouvert.');
  const ping = await waitForPing(tab.id, 30_000);
  return ping ? { ok: true, tabId: tab.id } : { ok: false, detail: 'Onglet veilleur ouvert, page fomo en chargement…' };
}

/** Recharge l'onglet veilleur, au plus une fois toutes les 2 min, et jamais sous les yeux de l'utilisateur. */
async function reloadWatcher(tabId, why) {
  if (!tabId || executingId || Date.now() - lastWatcherReload < 120_000) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const ours = tabId === state.health.ownWatcherTabId;
  if (tab.active && !ours) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.focused) return false;
  }
  lastWatcherReload = Date.now();
  log('info', `Rechargement de l'onglet veilleur (${why})`);
  await chrome.tabs.reload(tabId).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------------------------
// Exécution d'un ordre (achat ou vente)
// ---------------------------------------------------------------------------------------------

async function executeOrder(orderId, quotes) {
  const start = state.orders[orderId];
  if (!start || start.status !== 'queued') return;

  if (!stillValidAtDequeue(start, quotes[start.tokenId], Date.now())) {
    await updateOrder(orderId, (o, now) => appendLog({ ...o, status: 'armed', updatedAt: now }, 'Seuil plus atteint au moment de vendre — réarmé', now));
    log('info', `${start.symbol} : seuil plus atteint au moment de vendre — réarmé`, orderId);
    return;
  }

  const settings = { ...state.settings };
  await updateOrder(orderId, (o, now) =>
    appendLog(
      { ...o, status: 'executing', attempts: o.attempts + 1, updatedAt: now, error: null },
      `${o.side === 'buy' ? 'Achat' : 'Vente'}, tentative ${o.attempts + 1}${settings.dryRun ? ' (mode test : rien ne sera exécuté)' : ''}`,
      now,
    ),
  );

  const outcome = await runExecution(state.orders[orderId], settings);
  const order = state.orders[orderId];
  if (!order) return;
  const label = `${order.symbol} (${describeOrder(order)})`;

  const verb = order.side === 'buy' ? 'Achat' : 'Vente';
  switch (outcome.kind) {
    case 'done': {
      const { before, after } = outcome;
      await finishOrder(orderId, 'done', { result: { before, after, at: Date.now(), firedValue: order.firedValue } }, `${verb} exécuté, solde vérifié`);
      if (order.side === 'buy') {
        log('ok', `${label} : acheté ✓ (solde ${fmtQty(before)} → ${fmtQty(after)})`, orderId);
        const children = await attachExits(order, outcome.baseValue);
        const exits = children.length ? ` ${children.length} sortie${children.length > 1 ? 's' : ''} posée${children.length > 1 ? 's' : ''} : ${children.map(describeOrder).join(' ; ')}.` : '';
        notify(orderId, `Acheté : ${order.symbol} ✓`, `${formatPriceUsd(order.amountUsd)} achetés à ${formatValue(order.metric, order.firedValue)}.${exits}`);
      } else {
        log('ok', `${label} : vendu ✓ (solde ${fmtQty(before)} → ${fmtQty(after)})`, orderId);
        notify(orderId, `Vendu : ${order.symbol} ✓`, `${formatPct(order.sellPct)} vendus à ${formatValue(order.metric, order.firedValue)}. Solde ${fmtQty(before)} → ${fmtQty(after)}.`);
      }
      break;
    }
    case 'simulated':
      await finishOrder(orderId, 'done', { result: { simulated: true, detail: outcome.detail, at: Date.now() } }, `Simulé : ${outcome.detail}`);
      log('ok', `${label} : simulé (mode test) — ${outcome.detail}`, orderId);
      notify(orderId, `Test : ${order.symbol}`, outcome.detail);
      break;
    case 'unconfirmed':
      await finishOrder(orderId, 'failed', { error: outcome.detail }, 'Envoyé mais non confirmé');
      log('error', `${label} : ${outcome.detail}`, orderId);
      notify(orderId, `À vérifier : ${order.symbol}`, outcome.detail, true);
      break;
    case 'blocked':
      await finishOrder(orderId, 'failed', { error: outcome.detail }, `Bloqué : ${outcome.detail}`);
      log('error', `${label} : bloqué — ${outcome.detail}`, orderId);
      notify(orderId, `${verb} bloqué${order.side === 'buy' ? '' : 'e'} : ${order.symbol}`, outcome.detail, true);
      break;
    default: {
      // Incident avant tout clic : sûr de réessayer, dans la limite des tentatives.
      if (order.attempts < settings.maxAttempts) {
        await updateOrder(orderId, (o, now) => appendLog({ ...o, status: 'armed', updatedAt: now, error: outcome.detail }, `Échec avant envoi, réarmé : ${outcome.detail}`, now));
        log('warn', `${label} : échec avant envoi (${outcome.detail}) — nouvel essai si le seuil tient`, orderId);
      } else {
        await finishOrder(orderId, 'failed', { error: outcome.detail }, `Abandon après ${order.attempts} tentatives`);
        log('error', `${label} : abandon après ${order.attempts} tentatives — ${outcome.detail}`, orderId);
        notify(orderId, `${verb} impossible : ${order.symbol}`, outcome.detail, true);
      }
    }
  }
}

/**
 * Transforme les sorties attachées d'un achat vérifié en ordres de vente, relatifs à la valeur
 * au moment de l'achat (cote fraîche du veilleur, sinon la valeur de déclenchement).
 */
async function attachExits(order, baseValue) {
  const quote = state.health.quotes?.[order.tokenId];
  const fresh = quote && Date.now() - (quote.at ?? 0) < 60_000 ? (order.metric === 'mc' ? quote.mc : quote.price) : null;
  const base = [baseValue, fresh, order.firedValue].find((v) => Number.isFinite(v) && v > 0);
  const children = buildAttachedOrders(order, base, { now: Date.now(), makeId: newOrderId });
  for (const child of children) {
    state.orders[child.id] = child;
    log('info', `${child.symbol} : sortie posée après achat — ${describeOrder(child)}`, child.id);
  }
  if (children.length) await persistOrders();
  return children;
}

function newOrderId() {
  return `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Ouvre l'onglet d'exécution, lit le solde, fait piloter le trade, vérifie le solde.
 * Rend `{ kind: 'done'|'simulated'|'unconfirmed'|'blocked'|'retry', detail, before?, after? }`.
 * Ne touche pas au statut de l'ordre : sert aussi au bouton « Tester » de la fenêtre.
 */
async function runExecution(order, settings, { forceDryRun = false } = {}) {
  const dryRun = forceDryRun || settings.dryRun;
  const watcher = state.health.watcherTabId ? await chrome.tabs.get(state.health.watcherTabId).catch(() => null) : null;
  let tabId = null;
  let keepTab = false;

  try {
    const tab = await chrome.tabs.create({
      url: tokenUrl(order.chain, order.address),
      active: !!settings.bringToFront,
      ...(watcher ? { windowId: watcher.windowId } : {}),
    });
    tabId = tab.id;
    execTabId = tabId;
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

    const ping = await waitForPing(tabId, 45_000, (p) => p.token?.address === order.address);
    if (!ping) return { kind: 'retry', detail: 'La page du token ne s’est pas chargée à temps.' };
    if (!ping.session?.ok) return { kind: 'blocked', detail: 'Session fomo fermée dans l’onglet d’exécution : reconnecte-toi.' };

    const before = await sendToTab(tabId, { type: 'BALANCE', networkId: order.networkId, address: order.address }, 20_000);
    if (!before?.ok) return { kind: 'retry', detail: `Solde illisible avant le trade (${before?.reason ?? 'sans réponse'}).` };
    if (order.side === 'sell' && !(before.amount > 0)) {
      return { kind: 'blocked', detail: `Plus aucun ${order.symbol} dans le portefeuille : rien à vendre.` };
    }

    const result = await sendToTab(
      tabId,
      {
        type: 'EXECUTE_TRADE',
        side: order.side,
        networkId: order.networkId,
        address: order.address,
        sellPct: order.sellPct,
        amountUsd: order.amountUsd,
        symbol: order.symbol,
        dryRun,
        acceptRiskWarnings: settings.acceptRiskWarnings,
        allowHighPriceImpact: settings.allowHighPriceImpact,
        allowHighFees: settings.allowHighFees,
      },
      150_000,
    );
    for (const step of result?.steps ?? []) log('info', `${order.symbol} · ${step}`, order.id);

    const kind = classifyExecution(result);
    const detail = result?.detail ?? result?.reason ?? 'sans réponse de la page';
    if (kind === 'simulated') return { kind: 'simulated', detail };
    if (kind === 'blocked') {
      keepTab = true;
      return { kind: 'blocked', detail };
    }
    if (kind === 'retry') return { kind: 'retry', detail };

    // Le clic a eu lieu : à partir d'ici, plus jamais de nouvel essai automatique.
    const deadline = Date.now() + settings.verifySec * 1000;
    let after = before.amount;
    while (Date.now() < deadline) {
      await sleep(3_000);
      const now = await sendToTab(tabId, { type: 'BALANCE', networkId: order.networkId, address: order.address }, 15_000);
      if (!now?.ok) continue;
      after = now.amount;
      const arrived = order.side === 'buy' ? boughtEnough(before.amount, after) : soldEnough(before.amount, after, order.sellPct);
      if (arrived) {
        const baseValue = order.metric === 'mc' ? now.mc : now.price;
        return { kind: 'done', before: before.amount, after, baseValue, detail };
      }
    }
    keepTab = true;
    const what = order.side === 'buy' ? 'Achat envoyé' : 'Vente envoyée';
    const twice = order.side === 'buy' ? 'acheter' : 'vendre';
    return {
      kind: 'unconfirmed',
      detail: `${what} mais solde inchangé après ${settings.verifySec} s (${fmtQty(before.amount)} → ${fmtQty(after)}). Vérifie sur fomo avant de réarmer : aucun nouvel essai automatique, pour ne pas ${twice} deux fois.`,
    };
  } catch (error) {
    return { kind: 'retry', detail: `Erreur : ${error?.message ?? error}` };
  } finally {
    execTabId = null;
    if (tabId !== null && !keepTab) setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 4_000);
  }
}

// ---------------------------------------------------------------------------------------------
// Messages du panneau (page fomo) et de la fenêtre de l'extension
// ---------------------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ready
    .then(() => onMessage(message))
    .then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});

async function onMessage(message) {
  const now = Date.now();
  switch (message?.type) {
    case 'GET_STATE':
      return { ok: true, ...snapshot() };

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'ADD_ORDER': {
      const id = newOrderId();
      const created = createOrder(message.input ?? {}, { id, now, currentValue: message.currentValue });
      if (!created.ok) return created;
      state.orders[id] = created.order;
      await persistOrders();
      log('info', `${created.order.symbol} : ordre ajouté — ${describeOrder(created.order)}`, id);
      scheduleLoop(0);
      await updateBadge();
      return { ok: true, order: created.order };
    }

    case 'CANCEL_ORDER': {
      const order = state.orders[message.id];
      if (!order) return { ok: false, error: 'Ordre introuvable.' };
      if (order.status === 'executing') return { ok: false, error: 'Exécution en cours : impossible d’annuler maintenant.' };
      await updateOrder(order.id, (o, t) => appendLog({ ...o, status: 'cancelled', pendingSince: null, updatedAt: t }, 'Annulé', t));
      log('info', `${order.symbol} : ordre annulé — ${describeOrder(order)}`, order.id);
      await updateBadge();
      return { ok: true };
    }

    case 'REARM_ORDER': {
      const order = state.orders[message.id];
      if (!order) return { ok: false, error: 'Ordre introuvable.' };
      // Cote fraîche : celle du veilleur, sinon celle que la page du token vient de lire.
      const quote = state.health.quotes?.[order.tokenId];
      const watcherValue = quote && now - (quote.at ?? 0) < 60_000 ? (order.metric === 'mc' ? quote.mc : quote.price) : undefined;
      const rearmed = rearmOrder(order, watcherValue ?? message.currentValue, now);
      if (!rearmed.ok) return rearmed;
      state.orders[order.id] = rearmed.order;
      await persistOrders();
      log('info', `${order.symbol} : ordre réarmé — ${describeOrder(order)}`, order.id);
      scheduleLoop(0);
      await updateBadge();
      return { ok: true };
    }

    case 'DELETE_ORDER': {
      const order = state.orders[message.id];
      if (!order) return { ok: true };
      if (order.status === 'executing') return { ok: false, error: 'Exécution en cours : impossible de supprimer maintenant.' };
      delete state.orders[message.id];
      await persistOrders();
      await updateBadge();
      return { ok: true };
    }

    case 'TEST_ORDER': {
      const order = state.orders[message.id];
      if (!order) return { ok: false, error: 'Ordre introuvable.' };
      if (executingId) return { ok: false, error: 'Un ordre est en cours d’exécution, réessaie dans un instant.' };
      executingId = `test:${order.id}`;
      try {
        log('info', `${order.symbol} : test lancé (rien ne sera exécuté)`, order.id);
        const outcome = await runExecution(order, state.settings, { forceDryRun: true });
        const ok = outcome.kind === 'simulated';
        log(ok ? 'ok' : 'error', `${order.symbol} : test ${ok ? 'réussi' : 'en échec'} — ${outcome.detail}`, order.id);
        notify(order.id, `Test ${ok ? 'réussi' : 'en échec'} : ${order.symbol}`, outcome.detail, !ok);
        return { ok, detail: outcome.detail };
      } finally {
        executingId = null;
      }
    }

    case 'SET_SETTINGS': {
      state.settings = sanitizeSettings({ ...state.settings, ...(message.patch ?? {}) });
      await chrome.storage.local.set({ settings: state.settings });
      log('info', `Réglages : ${Object.keys(message.patch ?? {}).join(', ')}`);
      scheduleLoop(0);
      await updateBadge();
      return { ok: true, settings: state.settings };
    }

    case 'TEST_TELEGRAM': {
      const res = await sendTelegram('Test depuis l’extension « Ordres auto pour fomo » : les alertes arriveront ici.');
      log(res.ok ? 'ok' : 'warn', `Test Telegram : ${res.ok ? 'reçu' : `échec (${res.reason})`}`);
      return res.ok ? { ok: true } : { ok: false, error: `Telegram : ${res.reason}${res.detail ? ` — ${res.detail}` : ''}` };
    }

    case 'CLEAR_JOURNAL':
      state.journal = [];
      await chrome.storage.local.set({ journal: [] });
      return { ok: true };

    default:
      return { ok: false, error: 'Message inconnu.' };
  }
}

function sanitizeSettings(s) {
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const int = (v, min, max, d) => (Number.isInteger(v) && v >= min && v <= max ? v : d);
  const text = (v, pattern) => (typeof v === 'string' && pattern.test(v.trim()) ? v.trim() : '');
  return {
    telegramAlerts: bool(s.telegramAlerts, DEFAULT_SETTINGS.telegramAlerts),
    // Forme d'un jeton de bot Telegram : « 123456789:AA… » ; salon : un entier, négatif pour un groupe.
    telegramToken: text(s.telegramToken, /^\d{5,}:[\w-]{20,}$/),
    telegramChatId: text(s.telegramChatId, /^-?\d{3,}$/),
    enabled: bool(s.enabled, DEFAULT_SETTINGS.enabled),
    pollSec: int(s.pollSec, 2, 60, DEFAULT_SETTINGS.pollSec),
    bringToFront: bool(s.bringToFront, DEFAULT_SETTINGS.bringToFront),
    acceptRiskWarnings: bool(s.acceptRiskWarnings, DEFAULT_SETTINGS.acceptRiskWarnings),
    allowHighPriceImpact: bool(s.allowHighPriceImpact, DEFAULT_SETTINGS.allowHighPriceImpact),
    allowHighFees: bool(s.allowHighFees, DEFAULT_SETTINGS.allowHighFees),
    dryRun: bool(s.dryRun, DEFAULT_SETTINGS.dryRun),
    maxAttempts: int(s.maxAttempts, 1, 5, DEFAULT_SETTINGS.maxAttempts),
    verifySec: int(s.verifySec, 60, 600, DEFAULT_SETTINGS.verifySec),
    notifications: bool(s.notifications, DEFAULT_SETTINGS.notifications),
  };
}

// ---------------------------------------------------------------------------------------------
// Outils
// ---------------------------------------------------------------------------------------------

function snapshot() {
  return { orders: state.orders, settings: state.settings, health: state.health, journal: state.journal, statusLabels: STATUS_LABELS };
}

async function updateOrder(id, fn) {
  const current = state.orders[id];
  if (!current) return null;
  state.orders[id] = fn(current, Date.now());
  await persistOrders();
  return state.orders[id];
}

async function finishOrder(id, status, fields, message) {
  return updateOrder(id, (o, now) => appendLog({ ...o, ...fields, status, updatedAt: now, pendingSince: null }, message, now));
}

async function persistOrders() {
  await chrome.storage.local.set({ orders: state.orders });
}

async function setHealth(patch) {
  state.health = { ...state.health, ...patch };
  await chrome.storage.local.set({ health: state.health });
}

function log(level, msg, orderId = null) {
  state.journal = [...state.journal, { at: Date.now(), level, msg, orderId }].slice(-JOURNAL_LIMIT);
  chrome.storage.local.set({ journal: state.journal }).catch(() => {});
}

function notify(key, title, message, urgent = false) {
  sendTelegram(`${title}\n${message}`);
  if (!state.settings.notifications) return;
  try {
    const pending = chrome.notifications.create(`${key}|${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: urgent ? 2 : 1,
      requireInteraction: urgent,
    });
    pending?.catch?.(() => {});
  } catch {
    // Notifications coupées au niveau du système : le journal garde la trace.
  }
}

/**
 * Alerte sur le téléphone : une notification Windows ne sert à rien quand l'ordinateur tourne
 * seul la nuit. Le jeton et le salon sont ceux d'un bot Telegram personnel, saisis dans les
 * réglages ; sans eux, rien n'est envoyé et rien ne sort du navigateur.
 */
async function sendTelegram(text) {
  const { telegramToken: token, telegramChatId: chatId, telegramAlerts } = state.settings;
  if (!telegramAlerts || !token || !chatId) return { ok: false, reason: 'non-configuré' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log('warn', `Telegram : envoi refusé (${res.status}) ${detail.slice(0, 120)}`);
      return { ok: false, reason: `http-${res.status}`, detail: detail.slice(0, 200) };
    }
    return { ok: true };
  } catch (error) {
    log('warn', `Telegram injoignable : ${error?.message ?? error}`);
    return { ok: false, reason: 'réseau', detail: String(error?.message ?? error) };
  }
}

async function updateBadge() {
  const active = Object.values(state.orders).filter(isWatched).length;
  const failed = Object.values(state.orders).some((o) => o.status === 'failed');
  const problem = state.settings.enabled && active > 0 && state.health.problem;
  const text = !state.settings.enabled ? '⏸' : problem || failed ? '!' : active ? String(active) : '';
  await chrome.action.setBadgeText({ text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: problem || failed ? '#FF622E' : '#516AF6' }).catch(() => {});
}

function sendToTab(tabId, message, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    chrome.tabs.sendMessage(tabId, message).then(
      (response) => finish(response ?? { ok: false, reason: 'empty' }),
      (error) => finish({ ok: false, reason: 'no-receiver', detail: String(error?.message ?? error) }),
    );
  });
}

async function waitForPing(tabId, timeoutMs, accept = () => true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ping = await sendToTab(tabId, { type: 'PING' }, 3_000);
    if (ping?.ok && accept(ping)) return ping;
    await sleep(1_000);
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtQty(value) {
  if (!Number.isFinite(value)) return '?';
  return value >= 1000 ? value.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) : String(Number(value.toPrecision(4)));
}
