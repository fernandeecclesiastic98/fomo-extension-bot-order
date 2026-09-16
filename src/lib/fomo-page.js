/**
 * Lecture de la page token de fomo.family, relevée sur la vraie page le 2026-09-15 (appli
 * v1.399.1). Panneau de trade :
 *
 *   div.rounded-2xl
 *     div.flex.gap-2            → button « Buy » + button « Sell » (onglets)
 *     div                       → « $ » + input[placeholder="0"]  (montant EN DOLLARS)
 *     div.flex > div.grid       → Buy : « $10 » « $100 » « $500 » « $1000 » ; Sell : « 10% »… « 100% »
 *     div                       → « $0.92 available » + « Max »  (ou « Insufficient cash balance »)
 *     button                    → « Buy RUSH » / « Sell RUSH » / « Minimum amount $2 »
 *     div (avertissement)       → button case à cocher + button « Warning: … / I understand … »
 *
 * Aucune classe CSS n'est utilisée comme repère : fomo les régénère (Tailwind), le texte des
 * boutons, lui, est le contrat visible par l'utilisateur. Si fomo le change, ces fonctions
 * rendent `null` et l'exécuteur s'arrête proprement au lieu de cliquer au hasard.
 */

export function textOf(el) {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Tout ce que l'extension injecte porte `data-tpa`. Ces éléments vivent DANS le panneau de fomo
 * (nos boutons « $100 », « 25 % »…) : sans cette exclusion, l'exécuteur les prendrait pour ceux
 * de fomo et cliquerait dans notre propre formulaire.
 */
export const OURS = '[data-tpa]';

export function isOurs(el) {
  return !!el.closest?.(OURS);
}

function buttons(root) {
  return [...root.querySelectorAll('button')].filter((b) => !isOurs(b));
}

/** Les deux onglets Buy/Sell du panneau de trade : deux boutons frères, texte exact. */
export function findTradeTabs(doc) {
  for (const sell of buttons(doc).filter((b) => textOf(b) === 'Sell')) {
    const buy = [...(sell.parentElement?.children ?? [])].find((el) => el.tagName === 'BUTTON' && textOf(el) === 'Buy');
    if (buy) return { buy, sell };
  }
  return null;
}

/** Le cadre du panneau de trade (le parent de la rangée d'onglets). */
export function findTradePanel(doc) {
  const tabs = findTradeTabs(doc);
  return tabs?.sell.parentElement?.parentElement ?? null;
}

/** Boutons de montant rapide : « 25% » (onglet Sell) ou « $100 » (onglet Buy). */
export function findAmountPresets(panel) {
  const out = [];
  for (const el of buttons(panel)) {
    const label = textOf(el);
    const pct = /^(\d{1,3})\s?%$/.exec(label);
    if (pct) {
      out.push({ el, kind: 'pct', value: Number(pct[1]) });
      continue;
    }
    const usd = /^\$([\d,]+(?:\.\d+)?)$/.exec(label);
    if (usd) out.push({ el, kind: 'usd', value: Number(usd[1].replace(/,/g, '')) });
  }
  return out;
}

export function findPercentPresets(panel) {
  return findAmountPresets(panel)
    .filter((p) => p.kind === 'pct')
    .map(({ el, value }) => ({ el, pct: value }));
}

/** Onglet actif, déduit des boutons de montant affichés (pourcentages = Sell, dollars = Buy). */
export function activeSide(panel) {
  const presets = findAmountPresets(panel);
  if (presets.some((p) => p.kind === 'pct')) return 'sell';
  if (presets.some((p) => p.kind === 'usd')) return 'buy';
  return null;
}

export function isSellTabActive(panel) {
  return activeSide(panel) === 'sell';
}

export function findAmountInput(panel) {
  const inputs = [...panel.querySelectorAll('input')].filter((i) => !isOurs(i));
  return inputs.find((i) => i.getAttribute('placeholder') === '0') ?? inputs[0] ?? null;
}

export function findMaxButton(panel) {
  return buttons(panel).find((b) => textOf(b) === 'Max') ?? null;
}

/**
 * « $1.12 available » → 1.12 ; `null` si la ligne n'est pas rendue. Sur l'onglet Buy c'est le
 * cash, sur l'onglet Sell la valeur de l'avoir.
 */
export function readAvailableUsd(panel) {
  for (const el of panel.querySelectorAll('span,div')) {
    if (el.children.length > 0 || isOurs(el)) continue;
    const match = /^\$([\d,]+(?:\.\d+)?)\s+available$/i.exec(textOf(el));
    if (match) return Number(match[1].replace(/,/g, ''));
  }
  return null;
}

/** fomo remplace « $X available » par « Insufficient cash balance » quand le montant dépasse le cash. */
export function hasInsufficientCash(panel) {
  return [...panel.querySelectorAll('div,span')].some(
    (el) => el.children.length === 0 && !isOurs(el) && /insufficient (cash )?balance/i.test(textOf(el)),
  );
}

const SIDE_LABEL = { buy: 'Buy', sell: 'Sell' };

/**
 * Le bouton de confirmation : « Buy RUSH » / « Sell RUSH ». Sous le minimum ou pendant le devis,
 * fomo change son libellé (« Minimum amount $2 », relevé réel) et masque le bouton Max dès qu'un
 * montant est saisi : on le retrouve alors par sa place — le premier bouton avec du texte après
 * les boutons de montant, hors « Max » et hors avertissements.
 */
export function findConfirmButton(panel, symbol, side) {
  const all = buttons(panel);
  const verbs = side ? [SIDE_LABEL[side]] : ['Buy', 'Sell'];
  if (symbol) {
    const exact = all.find((b) => verbs.some((v) => textOf(b) === `${v} ${symbol}`));
    if (exact) return exact;
  }
  const byLabel = all.find((b) => verbs.some((v) => new RegExp(`^${v}\\s+\\S`).test(textOf(b))));
  if (byLabel) return byLabel;
  const presets = findAmountPresets(panel);
  if (!presets.length) return null;
  const after = all.slice(all.indexOf(presets.at(-1).el) + 1);
  return (
    after.find((b) => {
      const label = textOf(b);
      return label !== '' && label !== 'Max' && !isAckCheckbox(b) && !/understand|warning/i.test(label);
    }) ?? null
  );
}

export function confirmState(button, symbol, side = 'sell') {
  const label = textOf(button);
  const verb = SIDE_LABEL[side];
  const normal = symbol ? label === `${verb} ${symbol}` : new RegExp(`^${verb}\\s+\\S`).test(label);
  return {
    enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
    label,
    /** libellé normal : ni « devis en cours », ni « minimum » */
    normal,
    belowMinimum: /\bmin(imum)?\b/i.test(label),
  };
}

function isAckCheckbox(el) {
  return el.getAttribute('role') === 'checkbox' || (el.tagName === 'INPUT' && el.type === 'checkbox');
}

/**
 * Cases à cocher qui bloquent le bouton : avertissement du token (« I understand the risks »),
 * impact de prix élevé, frais Relay élevés. Chacune est classée, parce que l'utilisateur ne les
 * autorise pas toutes : accepter « liquidité déverrouillée » n'est pas la même décision que
 * trader avec 30 % d'impact.
 */
export function findAcknowledgements(panel) {
  const found = [];
  const seen = new Set();

  for (const textButton of buttons(panel)) {
    const label = textOf(textButton);
    if (!/understand|acknowledge|accept|j'ai compris|je comprends/i.test(label)) continue;
    const row = textButton.parentElement;
    const checkbox =
      [...(row?.children ?? [])].find((el) => el !== textButton && (el.tagName === 'BUTTON' || isAckCheckbox(el))) ??
      row?.querySelector('input[type="checkbox"],[role="checkbox"]');
    const target = checkbox ?? textButton;
    if (seen.has(target)) continue;
    seen.add(target);
    found.push({ el: target, kind: classifyAck(label), label });
  }

  for (const box of panel.querySelectorAll('input[type="checkbox"],[role="checkbox"]')) {
    if (seen.has(box) || isOurs(box)) continue;
    const checked = box.checked === true || box.getAttribute('aria-checked') === 'true';
    if (checked) continue;
    const label = textOf(box.closest('label') ?? box.parentElement);
    seen.add(box);
    found.push({ el: box, kind: classifyAck(label), label });
  }
  return found;
}

export function classifyAck(label) {
  if (/price impact|impact/i.test(label)) return 'price-impact';
  if (/\bfees?\b|frais|relay/i.test(label)) return 'fees';
  return 'risk';
}

/**
 * Connecté = le bouton « $X cash » (ou « Deposit more ») de la barre du haut existe. Le montant
 * est un nombre animé sans texte lisible : `textContent` ne rend que « cash » (relevé réel).
 */
export function isLoggedIn(doc) {
  return buttons(doc).some((b) => {
    const label = textOf(b);
    return /(^|\s|\d)cash$/i.test(label) || label === 'Deposit more';
  });
}

export function looksLoggedOut(doc) {
  if (isLoggedIn(doc)) return false;
  return buttons(doc).some((b) => /^(log ?in|sign ?in|sign ?up|connect)$/i.test(textOf(b)));
}

/** Le titre de l'onglet porte la MC arrondie : « $2.2M MC | RUSH | fomo ». */
export function readTitle(doc) {
  const match = /^\$([\d.,]+)([KMBT])?\s+MC\s*\|\s*([^|]+?)\s*\|/i.exec(doc.title ?? '');
  if (!match) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(match[2] ?? '').toUpperCase()] ?? 1;
  return { mc: Number(match[1].replace(/,/g, '')) * mult, symbol: match[3] };
}

/**
 * Écrire dans un champ contrôlé par React : affecter `value` ne suffit pas (React garde sa
 * propre copie et l'écrase au rendu suivant) ; il faut passer par le setter natif puis
 * émettre `input`.
 */
export function setControlledValue(input, value) {
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Clic « humain » : certains composants écoutent pointerdown/mousedown plutôt que click. */
export function realClick(el) {
  const win = el.ownerDocument?.defaultView ?? globalThis;
  const opts = { bubbles: true, cancelable: true };
  const Mouse = win.MouseEvent ?? globalThis.MouseEvent;
  const Pointer = win.PointerEvent ?? Mouse;
  el.dispatchEvent(new Pointer('pointerdown', opts));
  el.dispatchEvent(new Mouse('mousedown', opts));
  el.dispatchEvent(new Pointer('pointerup', opts));
  el.dispatchEvent(new Mouse('mouseup', opts));
  el.click();
}
