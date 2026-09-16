// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeSide,
  findAmountPresets,
  hasInsufficientCash,
  classifyAck,
  confirmState,
  findAcknowledgements,
  findAmountInput,
  findConfirmButton,
  findMaxButton,
  findPercentPresets,
  findTradePanel,
  findTradeTabs,
  isLoggedIn,
  isSellTabActive,
  looksLoggedOut,
  readAvailableUsd,
  readTitle,
  setControlledValue,
} from '../src/lib/fomo-page.js';

// Chemin disque et non `new URL(…)` : sous jsdom, `URL` est celle du faux navigateur.
const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sell-panel.html'), 'utf8');

describe('lecture du vrai panneau Sell de fomo', () => {
  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    document.title = '$2.2M MC | RUSH | fomo';
  });

  it('trouve les onglets Buy/Sell et le panneau', () => {
    const tabs = findTradeTabs(document);
    expect(tabs?.buy.textContent).toBe('Buy');
    expect(tabs?.sell.textContent).toBe('Sell');
    expect(findTradePanel(document)?.className).toContain('rounded-2xl');
  });

  it('onglet Sell actif : quatre pourcentages', () => {
    const panel = findTradePanel(document);
    expect(isSellTabActive(panel)).toBe(true);
    expect(findPercentPresets(panel).map((p) => p.pct)).toEqual([10, 25, 50, 100]);
  });

  it('lit « $1.12 available »', () => {
    expect(readAvailableUsd(findTradePanel(document))).toBe(1.12);
  });

  it('bouton « Sell RUSH » désactivé tant qu’aucun montant', () => {
    const panel = findTradePanel(document);
    const btn = findConfirmButton(panel, 'RUSH');
    expect(confirmState(btn, 'RUSH')).toMatchObject({ enabled: false, label: 'Sell RUSH', normal: true, belowMinimum: false });
  });

  it('avertissement « Liquidity unlocked » : la case est le bouton voisin du texte', () => {
    const acks = findAcknowledgements(findTradePanel(document));
    expect(acks).toHaveLength(1);
    expect(acks[0].kind).toBe('risk');
    expect(acks[0].label).toMatch(/I understand the risks/);
    expect(acks[0].el.className).toContain('shrink-0');
    expect(acks[0].el.textContent).toBe('');
  });

  it('session : le bouton « cash » de la barre du haut (montant sans texte lisible)', () => {
    expect(isLoggedIn(document)).toBe(true);
    expect(looksLoggedOut(document)).toBe(false);
  });

  it('montant sous le minimum : « Minimum amount $2 », Max masqué — le bouton est retrouvé par sa place', () => {
    // État relevé sur la vraie page après un clic sur 25 % d'une position de 1,12 $.
    const panel = findTradePanel(document);
    const confirm = findConfirmButton(panel, 'RUSH');
    confirm.querySelector('div').textContent = 'Minimum amount $2';
    panel.querySelector('button.text-accent-primary').remove(); // « Max »
    const found = findConfirmButton(panel, 'RUSH');
    expect(found).toBe(confirm);
    expect(confirmState(found, 'RUSH')).toMatchObject({ enabled: false, normal: false, belowMinimum: true });
  });

  it('champ de montant contrôlé : le setter natif déclenche l’événement input', () => {
    const input = findAmountInput(findTradePanel(document));
    let seen = null;
    input.addEventListener('input', () => (seen = input.value));
    setControlledValue(input, '0.28');
    expect(seen).toBe('0.28');
  });
});

describe('lecture du vrai panneau Buy de fomo', () => {
  const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'token-page.html'), 'utf8');

  beforeEach(() => {
    document.body.innerHTML = PAGE;
  });

  it('onglet actif Buy : boutons en dollars, cash disponible, bouton « Buy RUSH »', () => {
    const panel = findTradePanel(document);
    expect(activeSide(panel)).toBe('buy');
    expect(findAmountPresets(panel).map((p) => [p.kind, p.value])).toEqual([
      ['usd', 10],
      ['usd', 100],
      ['usd', 500],
      ['usd', 1000],
    ]);
    expect(readAvailableUsd(panel)).toBe(0.92);
    const confirm = findConfirmButton(panel, 'RUSH', 'buy');
    expect(confirmState(confirm, 'RUSH', 'buy')).toMatchObject({ enabled: false, label: 'Buy RUSH', normal: true });
    expect(findConfirmButton(panel, 'RUSH', 'sell')?.textContent.trim()).toBe('Buy RUSH'); // repli par position
  });

  it('« Insufficient cash balance » à la place du disponible (relevé réel, montant > cash)', () => {
    const panel = findTradePanel(document);
    expect(hasInsufficientCash(panel)).toBe(false);
    panel.querySelector('span[translate="no"]').textContent = 'Insufficient cash balance';
    expect(hasInsufficientCash(panel)).toBe(true);
    expect(readAvailableUsd(panel)).toBeNull();
  });

  it('nos éléments injectés dans le panneau ne sont JAMAIS pris pour ceux de fomo', () => {
    const panel = findTradePanel(document);
    const ours = document.createElement('div');
    ours.setAttribute('data-tpa', 'form');
    ours.innerHTML = `
      <button>$50</button><button>25%</button><button>Sell RUSH</button><button>Buy RUSH</button>
      <span>$9,999 available</span><div>Insufficient cash balance</div><input placeholder="0" value="12">
      <button><span>I understand</span></button><input type="checkbox">`;
    panel.querySelector('.flex.gap-2').after(ours);

    expect(findAmountPresets(panel).map((p) => p.value)).toEqual([10, 100, 500, 1000]);
    expect(readAvailableUsd(panel)).toBe(0.92);
    expect(hasInsufficientCash(panel)).toBe(false);
    expect(findAmountInput(panel).value).toBe('');
    expect(findConfirmButton(panel, 'RUSH', 'buy').closest('[data-tpa]')).toBeNull();
    expect(findAcknowledgements(panel).every((a) => !a.el.closest('[data-tpa]'))).toBe(true);
    expect(findTradeTabs(document).buy.closest('[data-tpa]')).toBeNull();
  });
});

describe('titre de l’onglet', () => {
  it.each([
    ['$249.1K MC | SABLE | fomo', 249_100, 'SABLE'],
    ['$2.2M MC | RUSH | fomo', 2_200_000, 'RUSH'],
    ['$1.3B MC | PONS | fomo', 1_300_000_000, 'PONS'],
  ])('%s', (title, mc, symbol) => {
    document.title = title;
    const read = readTitle(document);
    expect(read?.mc).toBeCloseTo(mc, 3);
    expect(read?.symbol).toBe(symbol);
  });

  it('page sans MC : null', () => {
    document.title = 'fomo | Social Crypto Trading App & Web Platform';
    expect(readTitle(document)).toBeNull();
  });
});

describe('classifyAck', () => {
  it.each([
    ['Warning: Liquidity unlocked I understand the risks of trading this token.', 'risk'],
    ['High price impact (32%) I understand', 'price-impact'],
    ['Relay fees are more than 10% of your trade. I understand', 'fees'],
  ])('%s → %s', (label, kind) => {
    expect(classifyAck(label)).toBe(kind);
  });
});

describe('onglet Buy (pas de pourcentages)', () => {
  it('isSellTabActive faux', () => {
    document.body.innerHTML = `
      <div><div class="flex gap-2"><button>Buy</button><button>Sell</button></div>
      <div><input placeholder="0"></div>
      <div><button>$10</button><button>$100</button></div></div>`;
    expect(isSellTabActive(findTradePanel(document))).toBe(false);
  });
});

/**
 * fomo est traduit : un utilisateur en interface FRANÇAISE (`<html lang="fr">`, 2026-09-16) ne
 * voyait ni le panneau ni la session, et l'exécuteur annonçait « fomo a changé son interface ».
 * La page ci-dessous est la capture réelle avec les libellés traduits — mêmes structures, mêmes
 * classes, seuls les textes changent, ce qui est exactement ce que fait fomo.
 */
describe('interface fomo en français', () => {
  const FR = FIXTURE.replace(/>Buy</g, '>Acheter<')
    .replace(/>Sell</g, '>Vendre<')
    .replace(/>Sell RUSH</g, '>Vendre RUSH<')
    .replace(/>Buy RUSH</g, '>Acheter RUSH<')
    .replace(/available/g, 'disponible')
    .replace(/I understand the risks of trading this token\./g, 'Je comprends les risques liés à ce token.')
    .replace(/Warning:/g, 'Avertissement :');

  beforeEach(() => {
    document.body.innerHTML = FR;
    document.documentElement.lang = 'fr';
  });

  it('trouve les onglets « Acheter » / « Vendre » et le panneau', () => {
    const tabs = findTradeTabs(document);
    expect(tabs?.buy.textContent).toBe('Acheter');
    expect(tabs?.sell.textContent).toBe('Vendre');
    expect(findTradePanel(document)).not.toBeNull();
  });

  it('lit le disponible, les pourcentages et le bouton de confirmation traduits', () => {
    const panel = findTradePanel(document);
    expect(readAvailableUsd(panel)).toBeGreaterThan(0);
    expect(findPercentPresets(panel).map((p) => p.pct)).toContain(25);
    const confirm = findConfirmButton(panel, 'RUSH', 'sell');
    expect(confirm?.textContent.trim()).toBe('Vendre RUSH');
    expect(confirmState(confirm, 'RUSH', 'sell').normal).toBe(true);
  });

  it('reconnaît la case d’avertissement traduite', () => {
    const acks = findAcknowledgements(findTradePanel(document));
    expect(acks.length).toBeGreaterThan(0);
  });

  it('accents et casse indifférents : « ACHETER », « acheter »', () => {
    document.body.innerHTML = `
      <div><div class="flex gap-2"><button>ACHETER</button><button>vendre</button></div>
      <div><input placeholder="0"></div>
      <div><button>$10</button><button>$100</button></div></div>`;
    expect(findTradeTabs(document)).not.toBeNull();
    expect(activeSide(findTradePanel(document))).toBe('buy');
  });
});

/**
 * Libellés RELEVÉS sur la page française d'un utilisateur le 2026-09-16 (token WASSIE), pas
 * traduits par nous : c'est le contrat réel. « Max. » porte un point — une égalité stricte sur
 * « Max » échouait, et la vente en pourcentage avec elle.
 */
describe('libellés réels relevés en français', () => {
  const RELEVE = ['✕', 'Réglages et journal', 'Ordres auto', 'liquidités', 'Déposer plus', '-$0.1824h', 'Alertes', 'Tokens',
    'Classement', 'Swaps', 'Thèse', 'Acheter', 'Vendre', '$10', '$100', '$500', '$1000', 'Max.', 'Acheter WASSIE',
    'Voir plus', 'Vos positions', 'Réessayer'];

  beforeEach(() => {
    document.documentElement.lang = 'fr';
    document.body.innerHTML = `
      <div class="header">${['liquidités', 'Déposer plus'].map((t) => `<button>${t}</button>`).join('')}</div>
      <div class="rounded-2xl">
        <div class="flex gap-2"><button>Acheter</button><button>Vendre</button></div>
        <div><span>$</span><input placeholder="0"></div>
        <div class="flex"><div class="grid">${['$10', '$100', '$500', '$1000'].map((t) => `<button>${t}</button>`).join('')}</div></div>
        <div><span>$0.18 disponible</span><button>Max.</button></div>
        <button>Acheter WASSIE</button>
      </div>`;
  });

  it('« Max. » (avec le point) est bien le bouton Max', () => {
    expect(findMaxButton(findTradePanel(document))?.textContent).toBe('Max.');
  });

  it('« liquidités » / « Déposer plus » : session reconnue, pas de faux « déconnecté »', () => {
    expect(isLoggedIn(document)).toBe(true);
    expect(looksLoggedOut(document)).toBe(false);
  });

  it('onglets, disponible et bouton « Acheter WASSIE »', () => {
    const panel = findTradePanel(document);
    expect(findTradeTabs(document)).not.toBeNull();
    expect(activeSide(panel)).toBe('buy');
    expect(readAvailableUsd(panel)).toBe(0.18);
    expect(confirmState(findConfirmButton(panel, 'WASSIE', 'buy'), 'WASSIE', 'buy').normal).toBe(true);
  });

  it('aucun libellé relevé n’est pris pour un onglet de trade par erreur', () => {
    const faux = RELEVE.filter((t) => !['Acheter', 'Vendre'].includes(t));
    document.body.innerHTML = `<div><div>${faux.map((t) => `<button>${t}</button>`).join('')}</div></div>`;
    expect(findTradeTabs(document)).toBeNull();
  });
});
