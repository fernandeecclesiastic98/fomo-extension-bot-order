import { describe, expect, it } from 'vitest';
import {
  STALE_QUOTE_MS,
  applyEvaluation,
  boughtEnough,
  buildAttachedOrders,
  classifyExecution,
  createOrder,
  describeAttached,
  describeOrder,
  estimateSellUsdAtTarget,
  evaluateOrder,
  rearmOrder,
  recoverAfterRestart,
  soldEnough,
  stillValidAtDequeue,
} from '../src/lib/orders.js';

const T0 = 1_789_440_000_000;
const RH = { chain: 'robinhood', networkId: 4663, address: '0xf7894d31d569e6330592d346ecfefdf4257f3ec1', symbol: 'SABLE' };

/** `currentValue: null` = cote inconnue (`undefined` prendrait la valeur par défaut). */
function make(input, currentValue = 250_000) {
  const res = createOrder({ ...RH, metric: 'mc', sellPct: 25, ...input }, { id: 'o1', now: T0, currentValue });
  if (!res.ok) throw new Error(res.error);
  return res.order;
}

const quote = (mc, at = T0) => ({ mc, price: mc / 1e9, at });

describe('createOrder', () => {
  it('seuil au-dessus de la MC actuelle : prise de profit, sans confirmation', () => {
    const o = make({ target: 500_000 });
    expect(o).toMatchObject({ kind: 'tp', op: 'gte', confirmSec: 0, status: 'armed', needsCross: false });
    expect(o.tokenId).toBe('0xf7894d31d569e6330592d346ecfefdf4257f3ec1:4663');
    expect(o.side).toBe('sell');
    expect(describeOrder(o)).toBe('Si MC ≥ $500K → vendre 25\u202f%');
  });

  it('seuil en dessous : stop, avec 15 s de confirmation par défaut', () => {
    const o = make({ target: 150_000 });
    expect(o).toMatchObject({ kind: 'sl', op: 'lte', confirmSec: 15 });
  });

  it('refuse un seuil déjà atteint quand le sens est imposé', () => {
    const res = createOrder({ ...RH, metric: 'mc', sellPct: 25, target: 200_000, op: 'gte' }, { id: 'x', now: T0, currentValue: 250_000 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/déjà atteint/);
  });

  it.each([
    [{ target: 0 }, /Seuil invalide/],
    [{ target: 500_000, sellPct: 0 }, /Pourcentage/],
    [{ target: 500_000, sellPct: 101 }, /Pourcentage/],
    [{ target: 500_000, sellPct: 12.5 }, /Pourcentage/],
    [{ target: 500_000, metric: 'volume' }, /Market cap/],
    [{ target: 500_000, address: '' }, /Token inconnu/],
  ])('refuse %o', (input, error) => {
    const res = createOrder({ ...RH, metric: 'mc', sellPct: 25, ...input }, { id: 'x', now: T0, currentValue: 250_000 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
  });

  it('sans cote actuelle, l’ordre attend un franchissement avant de pouvoir vendre', () => {
    const o = make({ target: 500_000 }, null);
    expect(o.needsCross).toBe(true);
  });
});

describe('createOrder — achats', () => {
  const buy = (input, currentValue = 2_000_000) =>
    createOrder({ ...RH, side: 'buy', metric: 'mc', amountUsd: 50, ...input }, { id: 'b1', now: T0, currentValue });

  it('seuil sous la MC : achat sur repli ; au-dessus : achat sur cassure', () => {
    expect(buy({ target: 1_500_000 }).order).toMatchObject({ side: 'buy', kind: 'dip', op: 'lte', amountUsd: 50, sellPct: null, confirmSec: 0 });
    expect(buy({ target: 3_000_000 }).order).toMatchObject({ kind: 'breakout', op: 'gte' });
    expect(describeOrder(buy({ target: 1_500_000 }).order)).toBe('Si MC ≤ $1.5M → acheter $50');
  });

  it('montant arrondi au centime, refusé s’il est nul ou illisible', () => {
    expect(buy({ target: 1_500_000, amountUsd: 12.349 }).order.amountUsd).toBe(12.34);
    expect(buy({ target: 1_500_000, amountUsd: 0 }).ok).toBe(false);
    expect(buy({ target: 1_500_000, amountUsd: 'abc' }).error).toMatch(/Montant/);
  });

  it('sorties attachées : TP ×2 (50 %) et stop −30 % (100 %, 15 s de confirmation)', () => {
    const o = buy({
      target: 1_500_000,
      attached: [
        { kind: 'tp', multiple: 2, sellPct: 50 },
        { kind: 'sl', multiple: 0.7, sellPct: 100 },
      ],
    }).order;
    expect(o.attached).toEqual([
      { kind: 'tp', multiple: 2, sellPct: 50, confirmSec: 0 },
      { kind: 'sl', multiple: 0.7, sellPct: 100, confirmSec: 15 },
    ]);
    expect(describeAttached(o)).toBe('puis TP ×2 (50\u202f%) · stop −30\u202f% (100\u202f%)');
  });

  it.each([
    [[{ kind: 'tp', multiple: 0.9, sellPct: 50 }], /multiple supérieur à 1/],
    [[{ kind: 'sl', multiple: 1.2, sellPct: 50 }], /baisse entre 1 et 99/],
    [[{ kind: 'tp', multiple: 2, sellPct: 0 }], /pourcentage/],
    [[{ kind: 'moon', multiple: 2, sellPct: 50 }], /TP ou stop/],
  ])('refuse une sortie attachée incohérente %o', (attached, error) => {
    const res = buy({ target: 1_500_000, attached });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(error);
  });

  it('une vente ne porte jamais de sortie attachée', () => {
    expect(make({ target: 500_000, attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }] }).attached).toEqual([]);
  });
});

describe('buildAttachedOrders — les sorties naissent de l’achat vérifié', () => {
  it('relatives à la valeur au moment de l’achat, armées, liées au parent', () => {
    const parent = createOrder(
      { ...RH, side: 'buy', metric: 'mc', amountUsd: 50, target: 1_500_000, attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }, { kind: 'sl', multiple: 0.7, sellPct: 100 }] },
      { id: 'p1', now: T0, currentValue: 2_000_000 },
    ).order;
    let n = 0;
    const children = buildAttachedOrders(parent, 1_480_000, { now: T0 + 60_000, makeId: () => `c${++n}` });
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ id: 'c1', side: 'sell', kind: 'tp', op: 'gte', target: 2_960_000, sellPct: 50, parentId: 'p1', status: 'armed', needsCross: false });
    expect(children[1]).toMatchObject({ kind: 'sl', op: 'lte', sellPct: 100, confirmSec: 15, parentId: 'p1' });
    expect(children[1].target).toBeCloseTo(1_036_000);
  });

  it('sans valeur de base lisible : aucune sortie (plutôt qu’un seuil faux)', () => {
    const parent = { ...make({ target: 500_000 }), side: 'buy', attached: [{ kind: 'tp', multiple: 2, sellPct: 50 }] };
    expect(buildAttachedOrders(parent, null, { now: T0, makeId: () => 'x' })).toEqual([]);
  });
});

describe('boughtEnough — la preuve d’un achat', () => {
  it('solde qui monte (y compris depuis zéro) : acheté', () => {
    expect(boughtEnough(0, 1_234)).toBe(true);
    expect(boughtEnough(100, 150)).toBe(true);
  });

  it('solde inchangé, en baisse ou illisible : pas acheté', () => {
    expect(boughtEnough(100, 100)).toBe(false);
    expect(boughtEnough(100, 100.005)).toBe(false);
    expect(boughtEnough(100, 90)).toBe(false);
    expect(boughtEnough(0, Number.NaN)).toBe(false);
  });
});

describe('evaluateOrder — prise de profit', () => {
  it('rien sous le seuil, vente au seuil', () => {
    const o = make({ target: 500_000 });
    expect(evaluateOrder(o, quote(499_999), T0).action).toBe('none');
    expect(evaluateOrder(o, quote(500_000), T0).action).toBe('fire');
  });

  it('une cote figée ne déclenche jamais', () => {
    const o = make({ target: 500_000 });
    expect(evaluateOrder(o, quote(900_000, T0 - STALE_QUOTE_MS - 1), T0).action).toBe('none');
  });

  it('une cote absente ou illisible ne déclenche rien', () => {
    const o = make({ target: 500_000 });
    expect(evaluateOrder(o, undefined, T0).action).toBe('none');
    expect(evaluateOrder(o, { mc: null, price: null, at: T0 }, T0).action).toBe('none');
  });

  it('déclenché, l’ordre passe en file et ne se redéclenche plus', () => {
    const o = make({ target: 500_000 });
    const fired = applyEvaluation(o, evaluateOrder(o, quote(600_000), T0), T0);
    expect(fired.status).toBe('queued');
    expect(fired.firedValue).toBe(600_000);
    expect(evaluateOrder(fired, quote(700_000), T0 + 3000).action).toBe('none');
  });

  it('lit le prix quand l’ordre porte sur le prix', () => {
    const o = make({ metric: 'price', target: 0.0005 }, 0.00025);
    expect(evaluateOrder(o, { mc: 1, price: 0.0005, at: T0 }, T0).action).toBe('fire');
  });
});

describe('evaluateOrder — stop avec confirmation', () => {
  it('attend la fenêtre complète sous le seuil avant de vendre', () => {
    let o = make({ target: 150_000, confirmSec: 15 });
    let ev = evaluateOrder(o, quote(140_000), T0);
    expect(ev.action).toBe('pending');
    o = applyEvaluation(o, ev, T0);
    expect(evaluateOrder(o, quote(140_000, T0 + 14_000), T0 + 14_000).action).toBe('none');
    expect(evaluateOrder(o, quote(140_000, T0 + 15_000), T0 + 15_000).action).toBe('fire');
  });

  it('une mèche qui remonte pendant la confirmation réarme sans vendre', () => {
    let o = make({ target: 150_000, confirmSec: 15 });
    o = applyEvaluation(o, evaluateOrder(o, quote(140_000), T0), T0);
    const ev = evaluateOrder(o, quote(160_000, T0 + 5000), T0 + 5000);
    expect(ev.action).toBe('reset');
    o = applyEvaluation(o, ev, T0 + 5000);
    expect(o).toMatchObject({ status: 'armed', pendingSince: null });
  });
});

describe('needsCross — jamais de vente sur un seuil déjà dépassé à l’armement', () => {
  it('seuil dépassé à la première cote : attend ; repassé de l’autre côté puis revenu : vend', () => {
    let o = make({ target: 500_000 }, null);
    expect(evaluateOrder(o, quote(600_000), T0).action).toBe('none');
    const crossed = evaluateOrder(o, quote(450_000, T0 + 3000), T0 + 3000);
    expect(crossed.action).toBe('crossed');
    o = applyEvaluation(o, crossed, T0 + 3000);
    expect(o.needsCross).toBe(false);
    expect(evaluateOrder(o, quote(510_000, T0 + 6000), T0 + 6000).action).toBe('fire');
  });
});

describe('rearmOrder', () => {
  const done = { ...make({ target: 500_000 }), status: 'done', attempts: 1, result: { before: 10, after: 7.5 } };

  it('refuse si la cote fraîche est déjà au-delà du seuil', () => {
    const res = rearmOrder(done, 600_000, T0);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/déclencherait tout de suite/);
  });

  it('avec une cote sous le seuil : armé normalement', () => {
    const res = rearmOrder(done, 400_000, T0);
    expect(res.ok).toBe(true);
    expect(res.order).toMatchObject({ status: 'armed', attempts: 0, result: null, needsCross: false });
  });

  it('sans cote : armé mais en attente de franchissement', () => {
    expect(rearmOrder(done, undefined, T0).order.needsCross).toBe(true);
  });

  it('refuse un ordre encore actif', () => {
    expect(rearmOrder(make({ target: 500_000 }), 400_000, T0).ok).toBe(false);
  });
});

describe('stillValidAtDequeue', () => {
  it('un palier dont le seuil ne tient plus repart armé ; un stop part quand même', () => {
    const tp = make({ target: 500_000 });
    const sl = make({ target: 150_000 });
    expect(stillValidAtDequeue(tp, quote(480_000), T0)).toBe(false);
    expect(stillValidAtDequeue(tp, quote(520_000), T0)).toBe(true);
    expect(stillValidAtDequeue(sl, quote(200_000), T0)).toBe(true);
  });
});

describe('classifyExecution — ce qui autorise un nouvel essai', () => {
  it.each([
    [{ ok: true, submitted: true, stage: 'soumis' }, 'verify'],
    [{ ok: true, dryRun: true, submitted: false, stage: 'pret' }, 'simulated'],
    [{ ok: false, stage: 'devis' }, 'retry'],
    [{ ok: false, stage: 'panneau' }, 'retry'],
    [{ ok: false, stage: 'session' }, 'blocked'],
    [{ ok: false, stage: 'avoir' }, 'blocked'],
    [{ ok: false, stage: 'fonds' }, 'blocked'],
    [{ ok: false, stage: 'avertissements' }, 'blocked'],
    [{ ok: false, stage: 'montant' }, 'blocked'],
    [undefined, 'retry'],
  ])('%o → %s', (result, expected) => {
    expect(classifyExecution(result)).toBe(expected);
  });
});

describe('estimateSellUsdAtTarget — refuser dès la création ce que fomo refusera', () => {
  it('position de 1,12 $ (RUSH réel), TP ×2, 25 % : 0,56 $ — sous le minimum de 2 $', () => {
    expect(estimateSellUsdAtTarget({ holdingUsd: 1.12, currentValue: 2.2e6, target: 4.4e6, sellPct: 25 })).toBeCloseTo(0.56);
  });

  it('un stop vend moins cher que la valeur actuelle', () => {
    expect(estimateSellUsdAtTarget({ holdingUsd: 10, currentValue: 1e6, target: 5e5, sellPct: 100 })).toBeCloseTo(5);
  });

  it('avoir inconnu : pas d’estimation', () => {
    expect(estimateSellUsdAtTarget({ holdingUsd: null, currentValue: 1e6, target: 2e6, sellPct: 50 })).toBeNull();
  });
});

describe('soldEnough — la preuve par le solde', () => {
  it('25 % demandés : il faut au moins la moitié (12,5 %) de baisse', () => {
    expect(soldEnough(100, 75, 25)).toBe(true);
    expect(soldEnough(100, 87, 25)).toBe(true);
    expect(soldEnough(100, 88, 25)).toBe(false);
    expect(soldEnough(100, 100, 25)).toBe(false);
  });

  it('100 % : il faut au moins la moitié du solde partie', () => {
    expect(soldEnough(100, 0, 100)).toBe(true);
    expect(soldEnough(100, 60, 100)).toBe(false);
  });

  it('solde avant nul ou illisible : jamais « vendu »', () => {
    expect(soldEnough(0, 0, 25)).toBe(false);
    expect(soldEnough(Number.NaN, 0, 25)).toBe(false);
  });
});

describe('recoverAfterRestart', () => {
  it('une vente en cours n’est pas relancée : échec à vérifier', () => {
    const o = recoverAfterRestart({ ...make({ target: 500_000 }), status: 'executing' }, T0);
    expect(o.status).toBe('failed');
    expect(o.error).toMatch(/vérifie ton solde/);
  });

  it('un ordre seulement en file repart armé', () => {
    expect(recoverAfterRestart({ ...make({ target: 500_000 }), status: 'queued' }, T0).status).toBe('armed');
  });

  it('les autres statuts ne bougent pas (même référence)', () => {
    const o = make({ target: 500_000 });
    expect(recoverAfterRestart(o, T0)).toBe(o);
  });
});
