import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Le service worker contre un faux navigateur : onglets, messagerie, stockage, notifications.
 * L'onglet fomo simulé répond comme le script de contenu (PING, QUOTES, BALANCE, EXECUTE_SELL).
 * On prouve ici les règles qui protègent l'argent : une vente par ordre, jamais de nouvel essai
 * après un clic « Sell », un échec avant clic réessayé dans la limite, le mode test qui ne vend pas.
 */

const RUSH = { chain: 'solana', networkId: 1399811149, address: 'SATqS9DYpLQsM2z51P4QCoqJRHa5wboV4qjJerJRUSH', symbol: 'RUSH' };
const RUSH_ID = `${RUSH.address}:${RUSH.networkId}`;
// Deux autres tokens pour prouver la gestion de plusieurs ordres en parallèle.
const MOON = { chain: 'solana', networkId: 1399811149, address: 'MOONxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxMOON', symbol: 'MOON' };
const DOGG = { chain: 'solana', networkId: 1399811149, address: 'DOGGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxDOGG', symbol: 'DOGG' };
const MOON_ID = `${MOON.address}:${MOON.networkId}`;
const DOGG_ID = `${DOGG.address}:${DOGG.networkId}`;

function makeWorld() {
  const world = {
    market: {
      [RUSH_ID]: { mc: 250_000, price: 5.76, symbol: 'RUSH' },
      [MOON_ID]: { mc: 1_000_000, price: 0.02, symbol: 'MOON' },
      [DOGG_ID]: { mc: 4_000_000, price: 0.4, symbol: 'DOGG' },
    },
    // Avoirs par token ; `world.balance` reste le raccourci vers celui de RUSH.
    balances: { [RUSH_ID]: 100, [MOON_ID]: 5_000, [DOGG_ID]: 250 },
    quotesReply: null, // remplace la réponse QUOTES (ex. session expirée)
    probeReply: null, // remplace la réponse PROBE (contrôle de l'interface fomo)
    expInSec: 3000, // secondes restantes sur la session fomo
    telegram: [], // messages partis vers l'API Telegram
    sellBehavior: 'sells', // 'sells' | 'no-effect' | 'fails-before-click'
    quoteCalls: [], // les listes d'ids demandées, pour prouver la cotation groupée
    executeCalls: [],
    created: [],
    removed: [],
    reloaded: [],
    notifications: [],
    storage: {},
    tabs: new Map([[1, { id: 1, url: 'https://fomo.family/profile/trader', windowId: 9, active: false, discarded: false }]]),
    nextTabId: 100,
    listeners: {},
  };

  Object.defineProperty(world, 'balance', {
    get: () => world.balances[RUSH_ID],
    set: (v) => {
      world.balances[RUSH_ID] = v;
    },
  });

  const on = (name) => ({ addListener: (fn) => (world.listeners[name] = fn) });

  const tokenOf = (url) => {
    const m = /\/tokens\/(\w+)\/(\w+)/.exec(url ?? '');
    return m ? { chain: m[1], networkId: RUSH.networkId, address: m[2] } : null;
  };

  async function reply(tabId, msg) {
    const tab = world.tabs.get(tabId);
    if (!tab) throw new Error('No tab with id');
    switch (msg.type) {
      case 'PING':
        return { ok: true, path: new URL(tab.url).pathname, token: tokenOf(tab.url), session: { ok: true, expInSec: 3000 } };
      case 'PROBE':
        return world.probeReply ?? { ok: true, manquants: [] };
      case 'QUOTES':
        world.quoteCalls.push(msg.ids);
        if (world.quotesReply) return world.quotesReply;
        return {
          ok: true,
          at: Date.now(),
          expInSec: world.expInSec ?? 3000,
          quotes: Object.fromEntries(msg.ids.filter((id) => world.market[id]).map((id) => [id, world.market[id]])),
        };
      case 'BALANCE': {
        const id = `${msg.address}:${msg.networkId}`;
        const quote = world.market[id] ?? world.market[RUSH_ID];
        const avoir = world.balances[id] ?? 0;
        return { ok: true, found: avoir > 0, amount: avoir, usd: avoir * quote.price, mc: quote.mc, price: quote.price, at: Date.now() };
      }
      case 'EXECUTE_TRADE': {
        world.executeCalls.push({ tabId, ...msg });
        if (msg.dryRun) return { ok: true, stage: 'pret', dryRun: true, submitted: false, detail: 'Tout est prêt', steps: [] };
        if (world.sellBehavior === 'fails-before-click') return { ok: false, stage: 'devis', detail: 'devis absent', steps: [] };
        const id = `${msg.address}:${msg.networkId}`;
        if (world.sellBehavior === 'sells') {
          const avoir = world.balances[id] ?? 0;
          world.balances[id] = msg.side === 'buy' ? avoir + msg.amountUsd / world.market[id].price : avoir * (1 - msg.sellPct / 100);
        }
        return { ok: true, stage: 'soumis', submitted: true, detail: 'Envoyé', steps: ['Clic'] };
      }
      default:
        return { ok: false };
    }
  }

  globalThis.fetch = async (url, init) => {
    world.telegram.push({ url, body: JSON.parse(init?.body ?? '{}') });
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in world.storage).map((k) => [k, structuredClone(world.storage[k])])),
        set: async (obj) => Object.assign(world.storage, structuredClone(obj)),
      },
    },
    alarms: { create: async () => {}, onAlarm: on('alarm') },
    runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
    notifications: {
      create: async (id, opts) => world.notifications.push({ id, ...opts }),
      clear: async () => {},
      onClicked: on('notificationClicked'),
    },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    windows: { get: async () => ({ focused: false }) },
    tabs: {
      onRemoved: on('tabRemoved'),
      query: async () => [...world.tabs.values()].filter((t) => t.url.startsWith('https://fomo.family/')),
      get: async (id) => {
        const tab = world.tabs.get(id);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      create: async ({ url, active, pinned }) => {
        const tab = { id: world.nextTabId++, url, active: !!active, pinned: !!pinned, windowId: 9, discarded: false };
        world.tabs.set(tab.id, tab);
        world.created.push(tab);
        return tab;
      },
      update: async (id, props) => Object.assign(world.tabs.get(id) ?? {}, props),
      reload: async (id) => world.reloaded.push(id),
      remove: async (id) => {
        world.removed.push(id);
        world.tabs.delete(id);
      },
      sendMessage: (tabId, msg) => reply(tabId, msg),
    },
  };

  world.send = (msg) =>
    new Promise((resolve) => {
      world.listeners.message(msg, {}, resolve);
    });
  world.orders = () => Object.values(world.storage.orders ?? {});
  return world;
}

async function boot(settings = {}) {
  const world = makeWorld();
  world.storage.settings = { pollSec: 2, verifySec: 60, ...settings };
  vi.resetModules();
  await import('../src/background.js');
  await vi.advanceTimersByTimeAsync(50);
  return world;
}

async function addTp(world, { target = 500_000, sellPct = 25 } = {}) {
  const res = await world.send({
    type: 'ADD_ORDER',
    currentValue: world.market[RUSH_ID].mc,
    input: { ...RUSH, metric: 'mc', target, sellPct },
  });
  expect(res.ok).toBe(true);
  return res.order;
}

describe('service worker — cycle complet d’un ordre', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-09-15T03:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.chrome;
  });

  it('TP : rien sous le seuil, puis vente dans un onglet neuf, solde vérifié, une seule fois', async () => {
    const world = await boot();
    await addTp(world);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.executeCalls).toHaveLength(0);
    expect(world.orders()[0].status).toBe('armed');

    world.market[RUSH_ID].mc = 520_000;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(world.executeCalls).toHaveLength(1);
    expect(world.executeCalls[0]).toMatchObject({ sellPct: 25, symbol: 'RUSH', dryRun: false, address: RUSH.address });
    expect(world.created.at(-1).url).toBe(`https://fomo.family/tokens/solana/${RUSH.address}`);
    const order = world.orders()[0];
    expect(order.status).toBe('done');
    expect(order.result).toMatchObject({ before: 100, after: 75 });
    expect(world.notifications.some((n) => /Vendu : RUSH/.test(n.title))).toBe(true);

    // La MC reste au-dessus : aucune seconde vente.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.executeCalls).toHaveLength(1);
  });

  it('plusieurs tokens : une seule cotation groupée, chaque ordre suivi et exécuté sur SON token', async () => {
    const world = await boot();
    // Trois ordres sur trois tokens : un TP, un stop, un achat sur repli.
    await addTp(world); // RUSH : vendre 25 % au-dessus de 500 k
    await world.send({
      type: 'ADD_ORDER',
      currentValue: world.market[MOON_ID].mc,
      input: { ...MOON, kind: 'sl', metric: 'mc', target: 700_000, sellPct: 100, confirmSec: 0 },
    });
    await world.send({
      type: 'ADD_ORDER',
      currentValue: world.market[DOGG_ID].mc,
      input: { ...DOGG, side: 'buy', metric: 'mc', target: 3_000_000, amountUsd: 50 },
    });
    expect(world.orders()).toHaveLength(3);

    // Un seul onglet veilleur cote les trois tokens EN UNE SEULE demande, pas un tour par token.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.created).toHaveLength(0);
    expect(world.executeCalls).toHaveLength(0);
    expect(world.orders().every((o) => o.status === 'armed')).toBe(true);
    expect(world.quoteCalls.length).toBeGreaterThan(0);
    for (const ids of world.quoteCalls) expect([...ids].sort()).toEqual([DOGG_ID, MOON_ID, RUSH_ID].sort());
    expect(Object.keys(world.storage.health.quotes)).toHaveLength(3);

    // Les trois seuils sont franchis dans le même mouvement de marché.
    world.market[RUSH_ID].mc = 520_000;
    world.market[MOON_ID].mc = 650_000;
    world.market[DOGG_ID].mc = 2_900_000;
    await vi.advanceTimersByTimeAsync(240_000);

    // Les trois sont partis, chacun avec son adresse, son sens et son montant.
    expect(world.orders().every((o) => o.status === 'done')).toBe(true);
    const parToken = Object.fromEntries(world.executeCalls.map((c) => [c.address, c]));
    expect(world.executeCalls).toHaveLength(3);
    expect(parToken[RUSH.address]).toMatchObject({ side: 'sell', sellPct: 25, symbol: 'RUSH' });
    expect(parToken[MOON.address]).toMatchObject({ side: 'sell', sellPct: 100, symbol: 'MOON' });
    expect(parToken[DOGG.address]).toMatchObject({ side: 'buy', amountUsd: 50, symbol: 'DOGG' });
    // Chaque exécution a eu lieu sur la page de SON token, dans un onglet à elle.
    for (const call of world.executeCalls) {
      expect(world.created.find((t) => t.id === call.tabId).url).toContain(call.address);
    }
    // Un seul trade à la fois : les onglets d'exécution ne se chevauchent pas.
    expect(new Set(world.executeCalls.map((c) => c.tabId)).size).toBe(3);
    expect(world.balances[RUSH_ID]).toBe(75);
    expect(world.balances[MOON_ID]).toBe(0);
    expect(world.balances[DOGG_ID]).toBeGreaterThan(250);

    // Rien ne se rejoue au tour suivant.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.executeCalls).toHaveLength(3);
  });

  it('clic « Sell » envoyé mais solde inchangé : échec à vérifier, JAMAIS de nouvel essai', async () => {
    const world = await boot();
    world.sellBehavior = 'no-effect';
    await addTp(world);
    world.market[RUSH_ID].mc = 520_000;

    await vi.advanceTimersByTimeAsync(120_000);
    const order = world.orders()[0];
    expect(order.status).toBe('failed');
    expect(order.error).toMatch(/aucun nouvel essai automatique/);
    expect(world.executeCalls).toHaveLength(1);
    // L'onglet reste ouvert pour que l'utilisateur voie ce qui s'est passé.
    expect(world.removed).not.toContain(world.created.at(-1).id);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(world.executeCalls).toHaveLength(1);
  });

  it('échec avant le clic (devis absent) : réessayé, puis abandon à la limite de tentatives', async () => {
    const world = await boot({ maxAttempts: 2 });
    world.sellBehavior = 'fails-before-click';
    await addTp(world);
    world.market[RUSH_ID].mc = 520_000;

    await vi.advanceTimersByTimeAsync(180_000);
    expect(world.executeCalls).toHaveLength(2);
    const order = world.orders()[0];
    expect(order.status).toBe('failed');
    expect(order.error).toMatch(/devis absent/);
  });

  it('mode test : la page reçoit dryRun, l’ordre finit « simulé », le solde ne bouge pas', async () => {
    const world = await boot({ dryRun: true });
    await addTp(world);
    world.market[RUSH_ID].mc = 520_000;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.executeCalls).toHaveLength(1);
    expect(world.executeCalls[0].dryRun).toBe(true);
    expect(world.balance).toBe(100);
    expect(world.orders()[0]).toMatchObject({ status: 'done', result: { simulated: true } });
  });

  it('rien à vendre au moment du déclenchement : bloqué sans ouvrir de vente', async () => {
    const world = await boot();
    await addTp(world);
    world.balance = 0;
    world.market[RUSH_ID].mc = 520_000;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.executeCalls).toHaveLength(0);
    expect(world.orders()[0]).toMatchObject({ status: 'failed' });
    expect(world.orders()[0].error).toMatch(/rien à vendre/);
  });

  it('ordre annulé avant le seuil : jamais vendu', async () => {
    const world = await boot();
    const order = await addTp(world);
    expect((await world.send({ type: 'CANCEL_ORDER', id: order.id })).ok).toBe(true);
    world.market[RUSH_ID].mc = 900_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.executeCalls).toHaveLength(0);
    expect(world.orders()[0].status).toBe('cancelled');
  });

  it('extension en pause : aucune cotation, aucune vente', async () => {
    const world = await boot();
    await addTp(world);
    await world.send({ type: 'SET_SETTINGS', patch: { enabled: false } });
    world.market[RUSH_ID].mc = 900_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.executeCalls).toHaveLength(0);
    expect(world.orders()[0].status).toBe('armed');
  });

  it('session fomo expirée : l’onglet veilleur est rechargé, rien n’est vendu', async () => {
    const world = await boot();
    await addTp(world);
    world.quotesReply = { ok: false, reason: 'http-401' };
    world.market[RUSH_ID].mc = 900_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.reloaded).toContain(1);
    expect(world.executeCalls).toHaveLength(0);
  });

  it('achat sur repli : exécuté quand la MC tombe, vérifié par le solde, puis TP et stop posés', async () => {
    const world = await boot();
    world.balance = 0;
    const res = await world.send({
      type: 'ADD_ORDER',
      currentValue: 250_000,
      input: { ...RUSH, side: 'buy', metric: 'mc', target: 200_000, amountUsd: 50, attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }, { kind: 'sl', multiple: 0.7, sellPct: 100 }] },
    });
    expect(res.ok).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.executeCalls).toHaveLength(0);

    world.market[RUSH_ID] = { mc: 190_000, price: 4.38, symbol: 'RUSH' };
    await vi.advanceTimersByTimeAsync(30_000);

    expect(world.executeCalls).toHaveLength(1);
    expect(world.executeCalls[0]).toMatchObject({ type: 'EXECUTE_TRADE', side: 'buy', amountUsd: 50 });
    const orders = world.orders();
    const parent = orders.find((o) => o.side === 'buy');
    expect(parent.status).toBe('done');
    const children = orders.filter((o) => o.parentId === parent.id);
    expect(children.map((c) => [c.kind, c.status, Math.round(c.target)])).toEqual([
      ['tp', 'armed', 380_000],
      ['sl', 'armed', 133_000],
    ]);
    expect(world.notifications.some((n) => /Acheté : RUSH/.test(n.title) && /2 sorties posées/.test(n.message))).toBe(true);

    // Les sorties vivent leur vie : la MC double, le TP vend 50 %.
    world.market[RUSH_ID] = { mc: 400_000, price: 9.2, symbol: 'RUSH' };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(world.executeCalls.at(-1)).toMatchObject({ side: 'sell', sellPct: 50 });
    expect(world.orders().find((o) => o.kind === 'tp').status).toBe('done');
    expect(world.orders().find((o) => o.kind === 'sl').status).toBe('armed');
  });

  it('achat envoyé mais solde inchangé : échec à vérifier, aucun second achat, aucune sortie posée', async () => {
    const world = await boot();
    world.sellBehavior = 'no-effect';
    world.balance = 0;
    await world.send({
      type: 'ADD_ORDER',
      currentValue: 250_000,
      input: { ...RUSH, side: 'buy', metric: 'mc', target: 200_000, amountUsd: 50, attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }] },
    });
    world.market[RUSH_ID] = { mc: 190_000, price: 4.38, symbol: 'RUSH' };
    await vi.advanceTimersByTimeAsync(240_000);
    expect(world.executeCalls).toHaveLength(1);
    expect(world.orders()).toHaveLength(1);
    expect(world.orders()[0].status).toBe('failed');
    expect(world.orders()[0].error).toMatch(/pour ne pas acheter deux fois/);
  });

  it('panne de session qui dure : l’alerte se répète toutes les 6 h tant qu’un ordre attend', async () => {
    const world = await boot({ pollSec: 60 });
    await addTp(world);
    world.quotesReply = { ok: false, reason: 'http-401' };

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const premières = world.notifications.filter((n) => n.id.startsWith('session'));
    expect(premières).toHaveLength(1);
    expect(premières[0].message).toMatch(/1 ordre en attente/);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(world.notifications.filter((n) => n.id.startsWith('session'))).toHaveLength(2);

    // Session revenue : plus d'alerte, et la surveillance repart.
    world.quotesReply = null;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const avant = world.notifications.filter((n) => n.id.startsWith('session')).length;
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
    expect(world.notifications.filter((n) => n.id.startsWith('session'))).toHaveLength(avant);
    expect(world.orders()[0].status).toBe('armed');
  });

  it('interface fomo changée : contrôle périodique, alerte avant qu’un ordre en dépende', async () => {
    const world = await boot({ pollSec: 60 });
    world.probeReply = { ok: false, manquants: ['bouton de confirmation'] };
    await addTp(world);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const alertes = world.notifications.filter((n) => n.id.startsWith('interface'));
    expect(alertes).toHaveLength(1);
    expect(alertes[0].message).toMatch(/bouton de confirmation/);
    expect(world.executeCalls).toHaveLength(0);

    // Interface réparée : plus d'alerte au contrôle suivant.
    world.probeReply = { ok: true, manquants: [] };
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
    expect(world.notifications.filter((n) => n.id.startsWith('interface'))).toHaveLength(1);
  });

  it('session bientôt expirée : l’onglet veilleur est rechargé d’avance, sans rien interrompre', async () => {
    const world = await boot({ pollSec: 60 });
    await addTp(world);
    world.expInSec = 300;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(world.reloaded).toContain(1);
    expect(world.orders()[0].status).toBe('armed');
  });

  it('alertes Telegram : envoyées quand c’est configuré, jamais sinon', async () => {
    const world = await boot({ pollSec: 60, telegramAlerts: true, telegramToken: '123456789:AAbbccddeeffgghhiijjkkllmmnnoo', telegramChatId: '1651707775' });
    await addTp(world);
    world.market[RUSH_ID].mc = 520_000;
    await vi.advanceTimersByTimeAsync(3 * 60_000);

    const envois = world.telegram.map((t) => t.body.text);
    expect(envois.some((t) => /déclenché/i.test(t))).toBe(true);
    expect(world.telegram[0].url).toBe('https://api.telegram.org/bot123456789:AAbbccddeeffgghhiijjkkllmmnnoo/sendMessage');
    expect(world.telegram[0].body.chat_id).toBe('1651707775');

    const sansTelegram = await boot({ pollSec: 60 });
    await addTp(sansTelegram);
    sansTelegram.market[RUSH_ID].mc = 520_000;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(sansTelegram.telegram).toHaveLength(0);
  });

  it('redémarrage pendant une vente : l’ordre passe en échec à vérifier, pas relancé', async () => {
    const world = makeWorld();
    world.storage.settings = { pollSec: 2 };
    world.storage.orders = {
      o1: {
        id: 'o1', ...RUSH, tokenId: RUSH_ID, kind: 'tp', metric: 'mc', op: 'gte', target: 500_000, sellPct: 25,
        confirmSec: 0, status: 'executing', attempts: 1, log: [], createdAt: 0, updatedAt: 0,
      },
    };
    world.market[RUSH_ID].mc = 900_000;
    vi.resetModules();
    await import('../src/background.js');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(world.orders()[0].status).toBe('failed');
    expect(world.executeCalls).toHaveLength(0);
  });
});
