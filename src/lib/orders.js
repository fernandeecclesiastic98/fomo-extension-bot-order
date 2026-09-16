/**
 * Ordres conditionnels (achat ET vente) et leur machine à états — pur, sans navigateur, testable.
 *
 * Cycle : `armed` → (seuil franchi) → `pending` (fenêtre de confirmation) → `queued` →
 * `executing` → `done` | `failed`. `cancelled` à la demande. Un ordre n'exécute qu'UNE fois :
 * relancer un trade dont on ne sait pas si le premier est passé, c'est risquer de le faire deux
 * fois — d'où la règle « envoyé mais non confirmé ⇒ échec, jamais de nouvel essai ».
 *
 * Quatre natures, déduites du côté et du sens :
 *  - vente au-dessus du seuil : prise de profit (`tp`) ; en dessous : stop (`sl`) ;
 *  - achat en dessous : achat sur repli (`dip`) ; au-dessus : achat sur cassure (`breakout`).
 * Un achat peut porter des sorties « attachées » (TP / stop relatifs au prix d'achat) qui
 * deviennent de vrais ordres de vente une fois l'achat vérifié.
 */

import { tokenId } from './chains.js';
import { formatCompactInput, formatCompactUsd, formatPct, formatPriceUsd } from './format.js';

export const STATUS_LABELS = {
  armed: 'Armé',
  pending: 'Confirmation…',
  queued: 'En file',
  executing: 'En cours',
  done: 'Exécuté',
  failed: 'Échec',
  cancelled: 'Annulé',
};

export const KIND_LABELS = {
  tp: 'Prise de profit',
  sl: 'Stop',
  dip: 'Achat sur repli',
  breakout: 'Achat sur cassure',
};

/** Statuts pour lesquels le veilleur doit continuer à coter le token. */
const WATCHED = new Set(['armed', 'pending', 'queued', 'executing']);

export const DEFAULT_SETTINGS = {
  enabled: true,
  pollSec: 3,
  bringToFront: true,
  acceptRiskWarnings: true,
  allowHighPriceImpact: false,
  allowHighFees: false,
  dryRun: false,
  maxAttempts: 2,
  verifySec: 180,
  notifications: true,
  /** Alertes sur le téléphone via un bot Telegram personnel (jeton et salon saisis dans les réglages). */
  telegramAlerts: false,
  telegramToken: '',
  telegramChatId: '',
};

/** Une cote plus vieille que ça ne déclenche rien : on ne trade pas sur un prix figé. */
export const STALE_QUOTE_MS = 60_000;

/** Confirmation par défaut d'un stop : une mèche de quelques secondes ne doit pas vendre. */
export const DEFAULT_STOP_CONFIRM_SEC = 15;

const MAX_BUY_USD = 1_000_000;
const LOG_LIMIT = 30;

export function isWatched(order) {
  return WATCHED.has(order.status);
}

export function kindOf(side, op) {
  if (side === 'buy') return op === 'lte' ? 'dip' : 'breakout';
  return op === 'gte' ? 'tp' : 'sl';
}

/**
 * Valide une saisie et fabrique l'ordre. `currentValue` (MC ou prix actuel, selon `metric`)
 * sert à deviner le sens : un seuil au-dessus se déclenche à la hausse, en dessous à la baisse.
 */
export function createOrder(input, { id, now, currentValue }) {
  const side = input.side === 'buy' ? 'buy' : input.side === 'sell' || input.side === undefined ? 'sell' : null;
  if (!side) return fail('Côté inconnu : achat ou vente.');
  const metric = input.metric === 'price' ? 'price' : input.metric === 'mc' ? 'mc' : null;
  if (!metric) return fail('Choisis « Market cap » ou « Prix ».');
  if (!input.address || !Number.isInteger(input.networkId) || !input.chain) {
    return fail('Token inconnu : ouvre la page du token sur fomo.family.');
  }

  const target = Number(input.target);
  if (!Number.isFinite(target) || target <= 0) return fail('Seuil invalide : tape par exemple 500k ou 2,5M.');

  let sellPct = null;
  let amountUsd = null;
  if (side === 'sell') {
    sellPct = Number(input.sellPct);
    if (!Number.isInteger(sellPct) || sellPct < 1 || sellPct > 100) {
      return fail('Pourcentage à vendre invalide : un entier entre 1 et 100.');
    }
  } else {
    amountUsd = Math.floor(Number(input.amountUsd) * 100) / 100;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_BUY_USD) {
      return fail('Montant d’achat invalide : un nombre de dollars, par exemple 50.');
    }
  }

  const known = Number.isFinite(currentValue) && currentValue > 0;
  let op = input.op === 'gte' || input.op === 'lte' ? input.op : null;
  if (!op) op = known && target < currentValue ? 'lte' : 'gte';

  if (known && conditionMet(op, currentValue, target)) {
    return fail(
      `Seuil déjà atteint (actuellement ${formatValue(metric, currentValue)}) : l'ordre partirait immédiatement.`,
    );
  }

  const kind = kindOf(side, op);
  const confirmSec =
    input.confirmSec === undefined || input.confirmSec === null || input.confirmSec === ''
      ? kind === 'sl'
        ? DEFAULT_STOP_CONFIRM_SEC
        : 0
      : Number(input.confirmSec);
  if (!Number.isFinite(confirmSec) || confirmSec < 0 || confirmSec > 3600) {
    return fail('Délai de confirmation invalide (0 à 3600 s).');
  }

  const attached = side === 'buy' ? parseAttached(input.attached) : { ok: true, value: [] };
  if (!attached.ok) return attached;

  const order = {
    id,
    createdAt: now,
    updatedAt: now,
    chain: input.chain,
    networkId: input.networkId,
    address: input.address,
    tokenId: tokenId(input.networkId, input.address),
    symbol: input.symbol || '?',
    side,
    kind,
    metric,
    op,
    target,
    sellPct,
    amountUsd,
    attached: attached.value,
    parentId: input.parentId ?? null,
    confirmSec,
    status: 'armed',
    pendingSince: null,
    // Sans valeur actuelle connue, on ne sait pas de quel côté du seuil on part : l'ordre attend
    // d'avoir vu le marché de l'autre côté avant de pouvoir partir (voir `evaluateOrder`).
    needsCross: !known,
    attempts: 0,
    lastValue: known ? currentValue : null,
    result: null,
    error: null,
    log: [],
  };
  return { ok: true, order: appendLog(order, `Créé : ${describeOrder(order)}`, now) };
}

/** Sorties attachées à un achat : `[{ kind: 'tp'|'sl', multiple, sellPct, confirmSec? }]`. */
function parseAttached(list) {
  if (list === undefined || list === null) return { ok: true, value: [] };
  if (!Array.isArray(list) || list.length > 4) return fail('Sorties attachées invalides.');
  const value = [];
  for (const item of list) {
    const multiple = Number(item?.multiple);
    const sellPct = Number(item?.sellPct);
    if (item?.kind !== 'tp' && item?.kind !== 'sl') return fail('Sortie attachée : TP ou stop.');
    if (item.kind === 'tp' && !(multiple > 1 && multiple <= 1000)) return fail('TP attaché : un multiple supérieur à 1 (×2…).');
    if (item.kind === 'sl' && !(multiple > 0 && multiple < 1)) return fail('Stop attaché : une baisse entre 1 et 99 %.');
    if (!Number.isInteger(sellPct) || sellPct < 1 || sellPct > 100) return fail('Sortie attachée : pourcentage entre 1 et 100.');
    const confirmSec = item.confirmSec === undefined ? (item.kind === 'sl' ? DEFAULT_STOP_CONFIRM_SEC : 0) : Number(item.confirmSec);
    value.push({ kind: item.kind, multiple, sellPct, confirmSec });
  }
  return { ok: true, value };
}

export function conditionMet(op, value, target) {
  return op === 'gte' ? value >= target : value <= target;
}

/** « Si MC ≥ $500K → vendre 25 % » / « Si MC ≤ $1.5M → acheter $50 » */
export function describeOrder(order) {
  const what = order.metric === 'mc' ? 'MC' : 'Prix';
  const sign = order.op === 'gte' ? '≥' : '≤';
  const action = order.side === 'buy' ? `acheter ${formatPriceUsd(order.amountUsd)}` : `vendre ${formatPct(order.sellPct)}`;
  return `Si ${what} ${sign} ${formatThreshold(order.metric, order.target)} → ${action}`;
}

/**
 * Un seuil choisi par l'utilisateur s'affiche avec sa précision (« $1.66M ») : l'arrondi de
 * fomo (« $1.6M »), bon pour une valeur qui bouge, ferait croire à un autre seuil.
 */
export function formatThreshold(metric, value) {
  return metric === 'mc' ? `$${formatCompactInput(value)}` : formatPriceUsd(value);
}

/** « puis TP ×2 (50 %) · stop −30 % (100 %) » — vide sans sortie attachée. */
export function describeAttached(order) {
  if (!order.attached?.length) return '';
  return `puis ${order.attached
    .map((a) =>
      a.kind === 'tp'
        ? `TP ×${formatMultiple(a.multiple)} (${formatPct(a.sellPct)})`
        : `stop −${Math.round((1 - a.multiple) * 100)}\u202f% (${formatPct(a.sellPct)})`,
    )
    .join(' · ')}`;
}

export function formatValue(metric, value) {
  return metric === 'mc' ? formatCompactUsd(value) : formatPriceUsd(value);
}

function formatMultiple(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '').replace('.', ',');
}

/**
 * Que faire de cet ordre avec cette cote ? Ne modifie rien : rend l'action et la valeur lue.
 * `quote` = `{ mc, price, at }` (at en ms).
 */
export function evaluateOrder(order, quote, now) {
  if (order.status !== 'armed' && order.status !== 'pending') return { action: 'none' };
  if (!quote) return { action: 'none' };
  const value = order.metric === 'mc' ? quote.mc : quote.price;
  if (!Number.isFinite(value) || value <= 0) return { action: 'none' };
  if (!Number.isFinite(quote.at) || now - quote.at > STALE_QUOTE_MS) return { action: 'none', value };

  const met = conditionMet(order.op, value, order.target);
  // Armé sans savoir de quel côté on partait (réarmement, cote absente) : un seuil déjà dépassé
  // ne déclenche pas — il faut d'abord voir le marché de l'autre côté. Sinon réarmer un TP après
  // une hausse revendrait aussitôt.
  if (order.needsCross) return met ? { action: 'none', value } : { action: 'crossed', value };

  if (!met) {
    return order.status === 'pending' ? { action: 'reset', value } : { action: 'none', value };
  }
  if (order.confirmSec <= 0) return { action: 'fire', value };
  if (order.status === 'armed') return { action: 'pending', value };
  return now - order.pendingSince >= order.confirmSec * 1000 ? { action: 'fire', value } : { action: 'none', value };
}

/** Applique une évaluation : nouvel objet, l'ancien reste intact. */
export function applyEvaluation(order, evaluation, now) {
  const withValue = evaluation.value === undefined ? order : { ...order, lastValue: evaluation.value };
  switch (evaluation.action) {
    case 'crossed':
      return appendLog(
        { ...withValue, needsCross: false, updatedAt: now },
        `Surveillance active (${formatValue(order.metric, evaluation.value)}, seuil pas encore atteint)`,
        now,
      );
    case 'pending':
      return appendLog(
        { ...withValue, status: 'pending', pendingSince: now, updatedAt: now },
        `Seuil franchi (${formatValue(order.metric, evaluation.value)}) — confirmation ${order.confirmSec} s`,
        now,
      );
    case 'reset':
      return appendLog(
        { ...withValue, status: 'armed', pendingSince: null, updatedAt: now },
        `Repassé de l'autre côté (${formatValue(order.metric, evaluation.value)}) — réarmé`,
        now,
      );
    case 'fire':
      return appendLog(
        { ...withValue, status: 'queued', pendingSince: null, updatedAt: now, firedValue: evaluation.value },
        `Déclenché à ${formatValue(order.metric, evaluation.value)}`,
        now,
      );
    default:
      return withValue;
  }
}

/**
 * Au moment de sortir un ordre de la file : le seuil tient-il encore ? Deux ordres déclenchés
 * ensemble s'exécutent l'un après l'autre, et le marché a pu repartir entre les deux.
 * Un stop, lui, a déjà passé sa fenêtre de confirmation : il part.
 */
export function stillValidAtDequeue(order, quote, now) {
  if (order.kind === 'sl') return true;
  if (!quote || !Number.isFinite(quote.at) || now - quote.at > STALE_QUOTE_MS) return true;
  const value = order.metric === 'mc' ? quote.mc : quote.price;
  return !Number.isFinite(value) || conditionMet(order.op, value, order.target);
}

/**
 * Les résultats de l'exécuteur de page se rangent en familles, parce qu'ils n'appellent pas la
 * même suite :
 *  - `verify`    : le clic de confirmation a eu lieu → on vérifie le solde, sans jamais recommencer ;
 *  - `simulated` : mode test, tout était prêt ;
 *  - `retry`     : incident passager AVANT tout clic (page lente, devis qui n'arrive pas) ;
 *  - `blocked`   : un obstacle qu'un nouvel essai ne lèvera pas (session, avertissement refusé,
 *    rien à vendre, cash insuffisant, montant sous le minimum).
 */
export function classifyExecution(result) {
  if (!result || typeof result !== 'object') return 'retry';
  if (result.ok && result.submitted) return 'verify';
  if (result.ok && result.dryRun) return 'simulated';
  const hard = new Set(['session', 'avoir', 'fonds', 'avertissements', 'montant']);
  return hard.has(result.stage) ? 'blocked' : 'retry';
}

/**
 * Valeur en dollars de la part vendue AU MOMENT où le seuil sera atteint (MC et prix évoluent
 * ensemble tant que l'offre ne bouge pas). Sert à refuser dès la création un ordre que fomo
 * rejettera à coup sûr : il n'accepte aucune vente sous 2 $ (5 $ sur Ethereum).
 */
export function estimateSellUsdAtTarget({ holdingUsd, currentValue, target, sellPct }) {
  if (![holdingUsd, currentValue, target, sellPct].every(Number.isFinite) || currentValue <= 0) return null;
  return holdingUsd * (target / currentValue) * (sellPct / 100);
}

/** Le solde a-t-il baissé d'au moins la moitié de ce qu'on voulait vendre ? */
export function soldEnough(before, after, sellPct) {
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after)) return false;
  const intended = sellPct >= 100 ? before : (before * sellPct) / 100;
  return before - after >= intended * 0.5;
}

/** L'achat est arrivé : le solde du token a augmenté (au-delà d'un arrondi). */
export function boughtEnough(before, after) {
  if (!Number.isFinite(after)) return false;
  const base = Number.isFinite(before) && before > 0 ? before : 0;
  return after > base * 1.0001 && after - base > 0;
}

/**
 * Transforme les sorties attachées d'un achat vérifié en ordres de vente, relatifs à la valeur
 * au moment de l'achat (`baseValue`, même métrique que l'achat).
 */
export function buildAttachedOrders(parent, baseValue, { now, makeId }) {
  if (!parent.attached?.length || !Number.isFinite(baseValue) || baseValue <= 0) return [];
  const children = [];
  for (const a of parent.attached) {
    const created = createOrder(
      {
        side: 'sell',
        chain: parent.chain,
        networkId: parent.networkId,
        address: parent.address,
        symbol: parent.symbol,
        metric: parent.metric,
        target: baseValue * a.multiple,
        op: a.kind === 'tp' ? 'gte' : 'lte',
        sellPct: a.sellPct,
        confirmSec: a.confirmSec,
        parentId: parent.id,
      },
      { id: makeId(), now, currentValue: baseValue },
    );
    if (created.ok) children.push(created.order);
  }
  return children;
}

/**
 * Après un redémarrage du navigateur ou de l'extension, un ordre « en cours » a peut-être
 * été exécuté, peut-être pas : on ne le relance pas, on le signale. Un ordre seulement en file,
 * lui, n'a rien envoyé : il repart armé.
 */
export function recoverAfterRestart(order, now) {
  if (order.status === 'executing') {
    return appendLog(
      {
        ...order,
        status: 'failed',
        updatedAt: now,
        error: 'Interrompu par un redémarrage pendant l’exécution — vérifie ton solde sur fomo avant de réarmer.',
      },
      'Interrompu pendant l’exécution (redémarrage)',
      now,
    );
  }
  if (order.status === 'queued' || order.status === 'pending') {
    return { ...order, status: 'armed', pendingSince: null, updatedAt: now };
  }
  return order;
}

/**
 * Réarmer un ordre terminé. Avec une cote fraîche on sait de quel côté on part (et on refuse si
 * le seuil est déjà atteint) ; sans cote, l'ordre attend un franchissement.
 */
export function rearmOrder(order, freshValue, now) {
  if (isWatched(order)) return fail('Ordre déjà actif.');
  const known = Number.isFinite(freshValue) && freshValue > 0;
  if (known && conditionMet(order.op, freshValue, order.target)) {
    return fail(`Seuil déjà atteint (${formatValue(order.metric, freshValue)}) : le réarmer le déclencherait tout de suite.`);
  }
  const next = {
    ...order,
    status: 'armed',
    attempts: 0,
    error: null,
    pendingSince: null,
    result: null,
    needsCross: !known,
    updatedAt: now,
  };
  return { ok: true, order: appendLog(next, 'Réarmé', now) };
}

export function appendLog(order, message, now) {
  const log = [...(order.log ?? []), { at: now, msg: message }];
  return { ...order, log: log.slice(-LOG_LIMIT) };
}

function fail(error) {
  return { ok: false, error };
}
