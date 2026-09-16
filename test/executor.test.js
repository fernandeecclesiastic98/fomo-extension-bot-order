// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { runTrade } from '../src/lib/executor.js';

/**
 * Doublure du panneau de trade de fomo, fidèle à ce qu'on a lu dans son code et relevé sur la
 * vraie page (2026-09-15) :
 *  - les boutons rapides ne font que remplir (« 25% » côté Sell, « $100 » côté Buy) ;
 *  - le devis arrive après un délai ; « Max » disparaît dès qu'un montant est saisi ;
 *  - côté Buy, un montant supérieur au cash remplace « $X available » par « Insufficient cash
 *    balance » et grise les boutons en dollars trop gros ;
 *  - sous le minimum, le bouton affiche « Minimum amount $2 » ;
 *  - « Buy/Sell X » reste désactivé tant qu'une case d'avertissement n'est pas cochée ;
 *  - le formulaire se vide quand le trade est mis en file.
 * Chaque changement d'état RECONSTRUIT le DOM, comme un rendu React qui remplace les nœuds.
 */
function fakeFomo(options = {}) {
  const s = {
    loggedIn: true,
    tab: 'buy',
    cashUsd: 120,
    holdingUsd: 1.12,
    amount: '',
    pct: null,
    quotePending: false,
    riskWarning: true,
    riskChecked: false,
    impactWarning: false,
    impactChecked: false,
    minUsd: 0,
    quoteDelayMs: 30,
    ...options,
  };
  const trades = [];
  const clicks = [];
  const root = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(root);

  const shownAmount = () => (s.pct ? String(Math.floor(((s.holdingUsd * s.pct) / 100) * 100) / 100) : s.amount);

  function startQuote() {
    s.quotePending = true;
    render();
    setTimeout(() => {
      s.quotePending = false;
      render();
    }, s.quoteDelayMs);
  }

  function render() {
    const amount = shownAmount();
    const amountNum = Number(amount) || 0;
    const verb = s.tab === 'buy' ? 'Buy' : 'Sell';
    const insufficient = s.tab === 'buy' && amountNum > s.cashUsd;
    let label = `${verb} RUSH`;
    let disabled = false;
    if (!amount) disabled = true;
    else if (amountNum < s.minUsd) {
      label = `Minimum amount $${s.minUsd}`;
      disabled = true;
    } else if (insufficient) disabled = true;
    else if (s.quotePending) {
      label = 'Getting quote';
      disabled = true;
    } else if ((s.riskWarning && !s.riskChecked) || (s.impactWarning && !s.impactChecked)) disabled = true;

    const presets =
      s.tab === 'sell'
        ? [10, 25, 50, 100].map((p) => `<button type="button" data-p="${p}">${p}%</button>`).join('')
        : [10, 100, 500, 1000].map((v) => `<button type="button" data-usd="${v}" ${v > s.cashUsd ? 'disabled' : ''}>$${v}</button>`).join('');
    const available = s.tab === 'buy' ? s.cashUsd : s.holdingUsd;
    const availableRow = insufficient
      ? '<div>Insufficient cash balance</div>'
      : `<div><span>$${available} available</span>${amount ? '' : '<button type="button" data-max>Max</button>'}</div>`;

    root.innerHTML = `
      <nav>${s.loggedIn ? '<button><div><number-flow></number-flow>cash</div></button>' : '<button>Log in</button>'}</nav>
      <div class="rounded-2xl">
        <div class="flex gap-2">
          <button type="button" data-t="buy">Buy</button>
          <button type="button" data-t="sell" ${s.holdingUsd <= 0 ? 'disabled' : ''}>Sell</button>
        </div>
        <div><div>$</div><input placeholder="0" value="${amount}"></div>
        <div><div>${presets}</div><button type="button" data-gear></button></div>
        ${availableRow}
        <button data-confirm ${disabled ? 'disabled' : ''}><div>${label}</div></button>
        ${
          s.riskWarning
            ? `<div><div class="row"><button type="button" data-ack="risk"></button>
               <button type="button"><span>Warning: Liquidity unlocked</span><span>I understand the risks of trading this token.</span></button></div></div>`
            : ''
        }
        ${
          s.impactWarning && amount && !s.quotePending
            ? `<div><div class="row"><button type="button" data-ack="impact"></button>
               <button type="button"><span>High price impact (31%)</span><span>I understand</span></button></div></div>`
            : ''
        }
      </div>`;

    for (const t of ['buy', 'sell']) {
      root.querySelector(`[data-t="${t}"]`).onclick = () => {
        Object.assign(s, { tab: t, amount: '', pct: null });
        render();
      };
    }
    root.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => {
        clicks.push(`preset:${b.dataset.p}%`);
        Object.assign(s, { pct: Number(b.dataset.p), amount: '' });
        startQuote();
      };
    });
    root.querySelectorAll('[data-usd]').forEach((b) => {
      b.onclick = () => {
        clicks.push(`preset:$${b.dataset.usd}`);
        Object.assign(s, { amount: b.dataset.usd, pct: null });
        startQuote();
      };
    });
    const max = root.querySelector('[data-max]');
    if (max) {
      max.onclick = () => {
        clicks.push('max');
        Object.assign(s, s.tab === 'sell' ? { pct: 100, amount: '' } : { amount: String(s.cashUsd), pct: null });
        startQuote();
      };
    }
    const input = root.querySelector('input');
    input.oninput = () => {
      clicks.push(`input:${input.value}`);
      Object.assign(s, { amount: input.value, pct: null });
      startQuote();
    };
    root.querySelectorAll('[data-ack]').forEach((b) => {
      b.onclick = () => {
        clicks.push(`ack:${b.dataset.ack}`);
        if (b.dataset.ack === 'risk') s.riskChecked = !s.riskChecked;
        else s.impactChecked = !s.impactChecked;
        render();
      };
    });
    root.querySelector('[data-confirm]').onclick = () => {
      clicks.push('confirm');
      trades.push({ side: s.tab, amount: shownAmount(), pct: s.pct });
      setTimeout(() => {
        Object.assign(s, { amount: '', pct: null });
        render();
      }, 20);
    };
  }

  render();
  return { state: s, trades, clicks };
}

const FAST = {
  panelMs: 400,
  tabMs: 300,
  availableMs: 300,
  quoteMs: 1_000,
  settleMs: 120,
  ackMs: 250,
  submitMs: 400,
  stepMs: 10,
};

const base = { symbol: 'RUSH', acceptRiskWarnings: true, allowHighPriceImpact: false, allowHighFees: false, timeouts: FAST };
const sell = (opts) => runTrade(document, { ...base, side: 'sell', ...opts });
const buy = (opts) => runTrade(document, { ...base, side: 'buy', ...opts });

describe('runTrade — vente pilotée', () => {
  it('25 % : passe sur l’onglet Sell, bouton 25 %, case « liquidité » cochée, clic, formulaire vidé', async () => {
    const fomo = fakeFomo();
    const res = await sell({ sellPct: 25 });
    expect(res).toMatchObject({ ok: true, side: 'sell', stage: 'soumis', submitted: true, submitEvidence: 'form-cleared' });
    expect(fomo.trades).toEqual([{ side: 'sell', amount: '0.28', pct: 25 }]);
    expect(fomo.clicks).toEqual(['preset:25%', 'ack:risk', 'confirm']);
  });

  it('33 % (pas de bouton) : montant tapé en dollars, arrondi au centime inférieur', async () => {
    const fomo = fakeFomo({ riskWarning: false });
    const res = await sell({ sellPct: 33 });
    expect(res.ok).toBe(true);
    expect(fomo.clicks[0]).toBe('input:0.36');
    expect(fomo.trades).toEqual([{ side: 'sell', amount: '0.36', pct: null }]);
  });

  it('100 % passe par le bouton 100 %', async () => {
    const fomo = fakeFomo({ riskWarning: false });
    await sell({ sellPct: 100 });
    expect(fomo.clicks[0]).toBe('preset:100%');
    expect(fomo.trades[0].pct).toBe(100);
  });

  it('case déjà cochée avant nous + impact autorisé : on remet la case dans son état et la vente part', async () => {
    const fomo = fakeFomo({ riskChecked: true, impactWarning: true });
    const res = await sell({ sellPct: 50, allowHighPriceImpact: true });
    expect(res).toMatchObject({ ok: true, submitted: true });
    expect(fomo.state.riskChecked).toBe(true);
    expect(fomo.trades).toHaveLength(1);
  });
});

describe('runTrade — achat piloté', () => {
  it('$100 : bouton rapide $100, avertissement coché, « Buy RUSH » cliqué', async () => {
    const fomo = fakeFomo({ tab: 'sell' });
    const res = await buy({ amountUsd: 100 });
    expect(res).toMatchObject({ ok: true, side: 'buy', stage: 'soumis', submitted: true });
    expect(fomo.trades).toEqual([{ side: 'buy', amount: '100', pct: null }]);
    expect(fomo.clicks).toEqual(['preset:$100', 'ack:risk', 'confirm']);
  });

  it('$37.5 (pas de bouton) : montant tapé tel quel', async () => {
    const fomo = fakeFomo({ riskWarning: false });
    await buy({ amountUsd: 37.5 });
    expect(fomo.clicks[0]).toBe('input:37.5');
    expect(fomo.trades[0]).toMatchObject({ side: 'buy', amount: '37.5' });
  });

  it('cash insuffisant (lu avant la saisie) : bloqué sans rien taper', async () => {
    const fomo = fakeFomo({ cashUsd: 0.92, riskWarning: false });
    const res = await buy({ amountUsd: 50 });
    expect(res).toMatchObject({ ok: false, stage: 'fonds' });
    expect(res.detail).toMatch(/\$0\.92 disponibles, \$50 demandés/);
    expect(fomo.clicks).toEqual([]);
    expect(fomo.trades).toEqual([]);
  });

  it('cash à zéro : bloqué sur les fonds', async () => {
    const fomo = fakeFomo({ cashUsd: 0 });
    const res = await buy({ amountUsd: 10 });
    expect(res).toMatchObject({ ok: false, stage: 'fonds' });
    expect(fomo.trades).toEqual([]);
  });

  it('sous le minimum d’achat (« Minimum amount $2 ») : bloqué sur le montant', async () => {
    const fomo = fakeFomo({ minUsd: 2, riskWarning: false });
    const res = await buy({ amountUsd: 1 });
    expect(res).toMatchObject({ ok: false, stage: 'montant' });
    expect(res.detail).toMatch(/Minimum amount \$2/);
    expect(fomo.trades).toEqual([]);
  });

  it('mode test : va jusqu’au bouton Buy, ne coche rien, n’achète rien', async () => {
    const fomo = fakeFomo();
    const res = await buy({ amountUsd: 100, dryRun: true });
    expect(res).toMatchObject({ ok: true, stage: 'pret', submitted: false, dryRun: true, side: 'buy' });
    expect(fomo.trades).toEqual([]);
    expect(fomo.state.riskChecked).toBe(false);
  });
});

describe('runTrade — ce qui doit bloquer sans trader', () => {
  it('mode test vente : va jusqu’au bouton, ne coche rien, ne clique pas', async () => {
    const fomo = fakeFomo();
    const res = await sell({ sellPct: 25, dryRun: true });
    expect(res).toMatchObject({ ok: true, stage: 'pret', submitted: false, dryRun: true });
    expect(res.detail).toMatch(/L'extension cochera/);
    expect(fomo.trades).toEqual([]);
    expect(fomo.clicks).toEqual(['preset:25%']);
    expect(fomo.state.riskChecked).toBe(false);
  });

  it('mode test sans avertissement : « Sell RUSH » cliquable, rien vendu', async () => {
    const fomo = fakeFomo({ riskWarning: false });
    const res = await sell({ sellPct: 25, dryRun: true });
    expect(res).toMatchObject({ ok: true, stage: 'pret' });
    expect(res.detail).toMatch(/Rien n'a été vendu/);
    expect(fomo.trades).toEqual([]);
  });

  it('impact de prix élevé non autorisé : bloqué, rien vendu', async () => {
    const fomo = fakeFomo({ riskWarning: false, impactWarning: true });
    const res = await sell({ sellPct: 25 });
    expect(res).toMatchObject({ ok: false, stage: 'avertissements' });
    expect(res.detail).toMatch(/impact de prix élevé/);
    expect(fomo.trades).toEqual([]);
    expect(fomo.clicks).not.toContain('ack:impact');
  });

  it('avertissement du token refusé dans les réglages : bloqué', async () => {
    const fomo = fakeFomo();
    const res = await sell({ sellPct: 25, acceptRiskWarnings: false });
    expect(res.stage).toBe('avertissements');
    expect(fomo.trades).toEqual([]);
  });

  it('rien à vendre : onglet Sell grisé', async () => {
    const fomo = fakeFomo({ holdingUsd: 0 });
    const res = await sell({ sellPct: 25 });
    expect(res).toMatchObject({ ok: false, stage: 'avoir' });
    expect(fomo.trades).toEqual([]);
  });

  it('sous le minimum de vente (relevé réel : 25 % de 1,12 $, « Minimum amount $2 », Max masqué)', async () => {
    const fomo = fakeFomo({ minUsd: 2 });
    const res = await sell({ sellPct: 25 });
    expect(res).toMatchObject({ ok: false, stage: 'montant' });
    expect(res.detail).toMatch(/Minimum amount \$2/);
    expect(fomo.trades).toEqual([]);
    expect(fomo.clicks).not.toContain('ack:risk');
  });

  it('déconnecté : étape session', async () => {
    document.body.innerHTML = '<nav><button>Log in</button></nav>';
    expect(await sell({ sellPct: 25 })).toMatchObject({ ok: false, stage: 'session' });
  });

  it('interface méconnaissable : s’arrête au panneau, ne clique rien', async () => {
    document.body.innerHTML = '<nav><button><div>cash</div></button></nav><div><button>Vendre</button></div>';
    expect(await buy({ amountUsd: 10 })).toMatchObject({ ok: false, stage: 'panneau' });
  });

  it('devis qui n’arrive jamais : étape devis (réessayable)', async () => {
    const fomo = fakeFomo({ riskWarning: false, quoteDelayMs: 60_000 });
    const res = await sell({ sellPct: 25 });
    expect(res).toMatchObject({ ok: false, stage: 'devis' });
    expect(fomo.trades).toEqual([]);
  });
});
