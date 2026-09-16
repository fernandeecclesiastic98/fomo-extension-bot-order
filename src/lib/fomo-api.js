/**
 * Appels à l'API de fomo, faits DEPUIS la page fomo.family (script de contenu) : même origine
 * que l'appli, donc CORS accepté, et le jeton de session est celui que Privy renouvelle déjà
 * pour la page. Rien n'est stocké hors du navigateur.
 *
 * Relevé du 2026-09-15 :
 *  - `POST /proxy/filterTokens` corps `["<adresse>:<networkId>", …]` → `marketCap`, `priceUSD`
 *    (groupé, 60-120 ms). Le WebSocket `prices` n'envoyait RIEN pour les petits tokens suivis :
 *    c'est pour ça que la cotation passe par ici.
 *  - `POST /v2/users` → l'utilisateur connecté (`responseObject.id`).
 *  - `GET /v2/users/<id>/balances` → `balance.tokenId`, `balance.shiftedBalance` par avoir.
 *  - Jeton : JWT Privy dans `localStorage['privy:token']`, valable 1 h.
 */

import { SUPPORTED_CHAINS_HEADER, normalizeAddress, tokenId } from './chains.js';

export const API_BASE = 'https://prod-api.fomo.family';

export function readSession(storage, nowMs) {
  let token = null;
  try {
    const raw = storage.getItem('privy:token');
    token = raw ? JSON.parse(raw) : null;
  } catch {
    token = null;
  }
  if (typeof token !== 'string' || token.split('.').length !== 3) return { ok: false, reason: 'no-session' };
  const payload = decodeJwtPayload(token);
  const expInSec = payload?.exp ? Math.round(payload.exp - nowMs / 1000) : null;
  if (expInSec !== null && expInSec <= 0) return { ok: false, reason: 'expired', token, expInSec };
  return { ok: true, token, expInSec };
}

export function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function createFomoApi({ fetchImpl, storage, now = () => Date.now() }) {
  async function call(path, { method = 'GET', body } = {}) {
    const session = readSession(storage, now());
    if (!session.ok) return { ok: false, reason: session.reason };
    let res;
    try {
      res = await fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${session.token}`,
          'content-type': 'application/json',
          'x-supported-chains': SUPPORTED_CHAINS_HEADER,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, reason: 'network', detail: String(error) };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: `http-${res.status}`, expInSec: session.expInSec };
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: 'bad-json' };
    }
    return { ok: true, json, expInSec: session.expInSec };
  }

  return {
    /** `{ ok, quotes: { [tokenId]: { mc, price, symbol, name } }, at }` */
    async quotes(ids) {
      if (!ids.length) return { ok: true, quotes: {}, at: now() };
      const res = await call('/proxy/filterTokens', { method: 'POST', body: ids });
      if (!res.ok) return res;
      return { ok: true, quotes: parseFilterTokens(res.json), at: now(), expInSec: res.expInSec };
    },

    async userId() {
      const res = await call('/v2/users', { method: 'POST', body: {} });
      if (!res.ok) return res;
      const id = res.json?.responseObject?.id;
      return typeof id === 'string' ? { ok: true, id, handle: res.json.responseObject.userHandle ?? null } : { ok: false, reason: 'no-user' };
    },

    /** `{ ok, mins: { buy: {…}, sell: {…} } }` depuis `GET /config`. */
    async config() {
      const res = await call('/config');
      if (!res.ok) return res;
      return { ok: true, mins: parseMinAmounts(res.json) };
    },

    /** Avoir d'UN token : `{ ok, amount, usd, price, mc }` ; amount 0 si non détenu. */
    async balance(userId, networkId, address) {
      const res = await call(`/v2/users/${encodeURIComponent(userId)}/balances`);
      if (!res.ok) return res;
      return { ok: true, ...findBalance(res.json, networkId, address), at: now() };
    },
  };
}

/**
 * Minimums d'achat et de vente en dollars, par chaîne. Relevé réel : `minPurchaseAmountByChain`
 * = `{ "1": { buy: 25, sell: 5 }, default: { buy: 2, sell: 2 } }` — sous le minimum, le bouton
 * affiche « Minimum amount $2 » et refuse le trade.
 */
export function parseMinAmounts(json) {
  const table = (json?.responseObject ?? json)?.minPurchaseAmountByChain ?? {};
  const out = { buy: {}, sell: {} };
  for (const [key, value] of Object.entries(table)) {
    for (const side of ['buy', 'sell']) {
      const amount = Number(value?.[side]);
      if (Number.isFinite(amount) && amount >= 0) out[side][key] = amount;
    }
  }
  return out;
}

/** Faute de config lisible, on retient le minimum relevé le 2026-09-15 plutôt que zéro. */
export const FALLBACK_MIN_TRADE_USD = 2;

export function minTradeUsd(mins, side, networkId) {
  const table = mins?.[side];
  const specific = table?.[String(networkId)];
  if (Number.isFinite(specific)) return specific;
  return Number.isFinite(table?.default) ? table.default : FALLBACK_MIN_TRADE_USD;
}

export function parseFilterTokens(json) {
  const quotes = {};
  for (const item of json?.responseObject ?? []) {
    const token = item?.token;
    if (!token?.address || !Number.isInteger(token.networkId)) continue;
    const mc = Number(item.marketCap);
    const price = Number(item.priceUSD);
    quotes[tokenId(token.networkId, token.address)] = {
      mc: Number.isFinite(mc) ? mc : null,
      price: Number.isFinite(price) ? price : null,
      symbol: token.symbol ?? null,
      name: token.name ?? null,
    };
  }
  return quotes;
}

export function findBalance(json, networkId, address) {
  const wanted = tokenId(networkId, address);
  for (const row of json?.responseObject?.balances ?? []) {
    const raw = row?.balance?.tokenId;
    if (typeof raw !== 'string') continue;
    const [addr, net] = raw.split(':');
    if (Number(net) !== networkId || normalizeAddress(addr, networkId) !== wanted.split(':')[0]) continue;
    const amount = Number(row.balance.shiftedBalance);
    const price = Number(row.tokenFilterResult?.priceUSD);
    const mc = Number(row.tokenFilterResult?.marketCap);
    return {
      found: true,
      amount: Number.isFinite(amount) ? amount : 0,
      price: Number.isFinite(price) ? price : null,
      mc: Number.isFinite(mc) ? mc : null,
      usd: Number.isFinite(amount) && Number.isFinite(price) ? amount * price : null,
    };
  }
  return { found: false, amount: 0, price: null, mc: null, usd: 0 };
}
