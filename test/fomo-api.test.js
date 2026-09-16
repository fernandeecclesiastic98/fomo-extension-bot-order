import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_MIN_TRADE_USD,
  createFomoApi,
  findBalance,
  minTradeUsd,
  parseFilterTokens,
  parseMinAmounts,
  readSession,
} from '../src/lib/fomo-api.js';
import { parseTokenPath, tokenId } from '../src/lib/chains.js';

const NOW = 1_789_440_000_000;

function jwt(expSec) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256' })}.${b64({ iat: expSec - 3600, exp: expSec })}.sig`;
}

function storageWith(token) {
  return { getItem: (k) => (k === 'privy:token' && token ? JSON.stringify(token) : null) };
}

// Réponse réelle de `POST /proxy/filterTokens`, raccourcie (relevé du 2026-09-15).
const FILTER_TOKENS = {
  success: true,
  message: 'Successfully fetched 1 cached, 1 fresh',
  responseObject: [
    {
      marketCap: '2214529.7246594797',
      priceUSD: '51.00396761140258',
      token: { address: 'SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH', networkId: 1399811149, name: 'Sat Rush', symbol: 'RUSH' },
    },
    {
      marketCap: '267686.1',
      priceUSD: '0.000267686',
      token: { address: '0xF7894d31d569e6330592d346ecfefdf4257f3ec1', networkId: 4663, name: 'Sable Network', symbol: 'SABLE' },
    },
  ],
};

describe('chemins et identifiants', () => {
  it('lit les pages token de fomo', () => {
    expect(parseTokenPath('/tokens/robinhood/0xF7894D31d569e6330592d346ecfefdf4257f3ec1')).toEqual({
      chain: 'robinhood',
      networkId: 4663,
      address: '0xf7894d31d569e6330592d346ecfefdf4257f3ec1',
    });
    expect(parseTokenPath('/tokens/solana/SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH')?.address).toBe(
      'SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH',
    );
    expect(parseTokenPath('/profile/trader')).toBeNull();
    expect(parseTokenPath('/tokens/inconnue/0xabc')).toBeNull();
  });

  it('ne touche jamais à la casse d’une adresse Solana', () => {
    expect(tokenId(1399811149, 'SATqS9DY')).toBe('SATqS9DY:1399811149');
    expect(tokenId(4663, '0xABC')).toBe('0xabc:4663');
  });
});

describe('readSession', () => {
  it('jeton valide : secondes restantes', () => {
    const s = readSession(storageWith(jwt(NOW / 1000 + 1200)), NOW);
    expect(s).toMatchObject({ ok: true, expInSec: 1200 });
  });

  it('jeton expiré ou absent', () => {
    expect(readSession(storageWith(jwt(NOW / 1000 - 1)), NOW)).toMatchObject({ ok: false, reason: 'expired' });
    expect(readSession(storageWith(null), NOW)).toMatchObject({ ok: false, reason: 'no-session' });
    expect(readSession({ getItem: () => 'pas du json' }, NOW)).toMatchObject({ ok: false, reason: 'no-session' });
  });
});

describe('parseFilterTokens', () => {
  it('rend MC et prix indexés par identifiant normalisé', () => {
    const quotes = parseFilterTokens(FILTER_TOKENS);
    expect(quotes['SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH:1399811149']).toMatchObject({ mc: 2214529.7246594797, symbol: 'RUSH' });
    expect(quotes['0xf7894d31d569e6330592d346ecfefdf4257f3ec1:4663']).toMatchObject({ mc: 267686.1, price: 0.000267686 });
  });
});

describe('findBalance', () => {
  // Forme réelle de `GET /v2/users/<id>/balances`, raccourcie.
  const BALANCES = {
    responseObject: {
      balances: [
        {
          balance: { tokenId: 'SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH:1399811149', shiftedBalance: 0.022005998 },
          tokenFilterResult: { priceUSD: '50.98', marketCap: '2213691' },
        },
        {
          balance: { tokenId: '0x4ba5a4cb7a2a3b17e6d6e3a3b0e0c2c4e7fdb6d1:4663', shiftedBalance: 23876.5 },
          tokenFilterResult: { priceUSD: '0.0000034', marketCap: '3473' },
        },
      ],
    },
  };

  it('trouve l’avoir et sa valeur', () => {
    const b = findBalance(BALANCES, 1399811149, 'SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH');
    expect(b.found).toBe(true);
    expect(b.amount).toBeCloseTo(0.022005998);
    expect(b.usd).toBeCloseTo(1.1218, 3);
  });

  it('adresse EVM en majuscules : même avoir', () => {
    expect(findBalance(BALANCES, 4663, '0x4BA5A4CB7A2A3B17E6D6E3A3B0E0C2C4E7FDB6D1').amount).toBe(23876.5);
  });

  it('token non détenu : zéro, jamais une erreur', () => {
    expect(findBalance(BALANCES, 4663, '0xdead')).toMatchObject({ found: false, amount: 0 });
  });

  it('une adresse Solana de casse différente n’est PAS le même token', () => {
    expect(findBalance(BALANCES, 1399811149, 'satqs9dyplqsm2z51p4qcoqjrha5wbov4qjjerjrush').found).toBe(false);
  });
});

describe('minimums d’achat et de vente (GET /config)', () => {
  // Relevé réel du 2026-09-15.
  const CONFIG = {
    responseObject: { minPurchaseAmountByChain: { 1: { buy: 25, sell: 5 }, default: { buy: 2, sell: 2 } } },
  };

  it('Ethereum : achat 25 $, vente 5 $ ; les autres chaînes : 2 $', () => {
    const mins = parseMinAmounts(CONFIG);
    expect(minTradeUsd(mins, 'buy', 1)).toBe(25);
    expect(minTradeUsd(mins, 'sell', 1)).toBe(5);
    expect(minTradeUsd(mins, 'buy', 4663)).toBe(2);
    expect(minTradeUsd(mins, 'sell', 1399811149)).toBe(2);
  });

  it('config illisible : le minimum relevé, jamais zéro', () => {
    expect(minTradeUsd(parseMinAmounts({}), 'sell', 4663)).toBe(FALLBACK_MIN_TRADE_USD);
    expect(minTradeUsd(null, 'buy', 4663)).toBe(FALLBACK_MIN_TRADE_USD);
  });
});

describe('createFomoApi', () => {
  it('envoie le jeton de la page et l’en-tête des chaînes', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => FILTER_TOKENS }));
    const api = createFomoApi({ fetchImpl, storage: storageWith(jwt(NOW / 1000 + 900)), now: () => NOW });
    const res = await api.quotes(['SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH:1399811149']);
    expect(res.ok).toBe(true);
    expect(res.expInSec).toBe(900);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://prod-api.fomo.family/proxy/filterTokens');
    expect(init.headers.authorization).toMatch(/^Bearer /);
    expect(init.headers['x-supported-chains']).toBe('1,56,143,4663,8453,1399811149');
    expect(JSON.parse(init.body)).toEqual(['SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH:1399811149']);
  });

  it('401 : raison exploitable par le veilleur (recharger la page)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const api = createFomoApi({ fetchImpl, storage: storageWith(jwt(NOW / 1000 + 900)), now: () => NOW });
    expect(await api.quotes(['a:1'])).toMatchObject({ ok: false, reason: 'http-401' });
  });

  it('sans session : aucun appel réseau', async () => {
    const fetchImpl = vi.fn();
    const api = createFomoApi({ fetchImpl, storage: storageWith(null), now: () => NOW });
    expect(await api.quotes(['a:1'])).toMatchObject({ ok: false, reason: 'no-session' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('réseau coupé : rend une raison, ne lève pas', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const api = createFomoApi({ fetchImpl, storage: storageWith(jwt(NOW / 1000 + 900)), now: () => NOW });
    expect(await api.quotes(['a:1'])).toMatchObject({ ok: false, reason: 'network' });
  });
});
