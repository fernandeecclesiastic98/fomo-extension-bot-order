/**
 * Exécute un trade en pilotant le panneau de trade de fomo, comme le ferait un humain :
 * onglet Buy/Sell → montant → attente du devis → cases d'avertissement autorisées → confirmation.
 *
 * Pourquoi piloter l'interface plutôt qu'appeler l'API : chez fomo, `POST /swaps/v2` rend une
 * transaction que le wallet Privy de la page doit signer. Seule la page ouverte peut trader.
 *
 * Chaque étape a un nom (`stage`) : c'est ce que l'utilisateur lit quand ça échoue, et ce qui
 * décide s'il est sûr de réessayer (voir `classifyExecution`).
 */

import {
  activeSide,
  confirmState,
  findAcknowledgements,
  findAmountInput,
  findAmountPresets,
  findConfirmButton,
  findMaxButton,
  findTradePanel,
  findTradeTabs,
  hasInsufficientCash,
  looksLoggedOut,
  readAvailableUsd,
  realClick,
  setControlledValue,
  textOf,
} from './fomo-page.js';

export const DEFAULT_TIMEOUTS = {
  panelMs: 45_000,
  tabMs: 10_000,
  availableMs: 15_000,
  quoteMs: 25_000,
  settleMs: 2_000,
  ackMs: 4_000,
  submitMs: 20_000,
  stepMs: 250,
};

const VERB = { buy: 'Buy', sell: 'Sell' };

/**
 * @param {Document} doc
 * @param {{ side: 'buy'|'sell', sellPct?: number, amountUsd?: number, symbol?: string, dryRun?: boolean,
 *           acceptRiskWarnings?: boolean, allowHighPriceImpact?: boolean, allowHighFees?: boolean,
 *           timeouts?: object }} opts
 */
export async function runTrade(doc, opts, deps = {}) {
  const side = opts.side === 'buy' ? 'buy' : 'sell';
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts ?? {}) };
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const waitFor = deps.waitFor ?? ((fn, ms) => pollUntil(fn, ms, sleep, timeouts.stepMs));
  const steps = [];
  const note = (msg) => steps.push(msg);
  const out = (ok, stage, detail, extra = {}) => ({ ok, stage, side, detail, steps, dryRun: !!opts.dryRun, ...extra });
  const symbol = opts.symbol;
  const token = symbol ?? 'ce token';

  // 1. Panneau de trade rendu, session ouverte.
  const tabs = await waitFor(() => findTradeTabs(doc) ?? (looksLoggedOut(doc) ? 'logged-out' : null), timeouts.panelMs);
  if (tabs === 'logged-out') return out(false, 'session', 'Session fomo fermée : reconnecte-toi sur fomo.family.');
  if (!tabs) return out(false, 'panneau', 'Panneau de trade introuvable (page lente ou interface fomo modifiée).');
  note('Panneau de trade trouvé');

  // 2. Bon onglet. fomo grise « Sell » quand il n'y a rien à vendre.
  const tab = tabs[side];
  if (tab.disabled) return out(false, 'avoir', `Onglet ${VERB[side]} grisé : aucun ${token} à vendre.`);
  if (activeSide(findTradePanel(doc)) !== side) {
    realClick(tab);
    const switched = await waitFor(() => activeSide(findTradePanel(doc)) === side, timeouts.tabMs);
    if (!switched) return out(false, 'onglet', `L'onglet ${VERB[side]} ne s'est pas ouvert.`);
  }
  note(`Onglet ${VERB[side]} ouvert`);

  // 3. Disponible, en dollars, tel qu'affiché par fomo : le cash côté Buy, l'avoir côté Sell.
  const available = await waitFor(() => {
    const p = findTradePanel(doc);
    const usd = p ? readAvailableUsd(p) : null;
    return usd !== null && usd > 0 ? usd : null;
  }, timeouts.availableMs);
  if (!available) {
    return side === 'sell'
      ? out(false, 'avoir', `Rien à vendre : fomo affiche 0 $ disponible sur ${token}.`)
      : out(false, 'fonds', 'Pas de cash disponible sur fomo pour acheter.');
  }
  note(`Disponible : $${available}`);
  if (side === 'buy' && opts.amountUsd > available) {
    return out(false, 'fonds', `Cash insuffisant : $${available} disponibles, $${opts.amountUsd} demandés.`);
  }

  // 4. Montant : bouton rapide s'il existe, sinon Max pour 100 %, sinon saisie en dollars.
  const panel = findTradePanel(doc);
  const presets = findAmountPresets(panel).filter((p) => !p.el.disabled);
  let usdToType = null;
  let amountLabel;
  if (side === 'sell') {
    const preset = presets.find((p) => p.kind === 'pct' && p.value === opts.sellPct);
    if (preset) {
      realClick(preset.el);
      amountLabel = `bouton ${opts.sellPct}%`;
    } else if (opts.sellPct >= 100 && findMaxButton(panel)) {
      realClick(findMaxButton(panel));
      amountLabel = 'bouton Max';
    } else {
      // Même arrondi que fomo pour ses boutons : au centime inférieur.
      usdToType = Math.floor(((available * opts.sellPct) / 100) * 100) / 100;
      if (usdToType <= 0) return out(false, 'montant', `${opts.sellPct} % de $${available} fait moins d'un centime.`);
    }
  } else {
    const preset = presets.find((p) => p.kind === 'usd' && p.value === opts.amountUsd);
    if (preset) {
      realClick(preset.el);
      amountLabel = `bouton $${opts.amountUsd}`;
    } else {
      usdToType = opts.amountUsd;
    }
  }
  if (usdToType !== null) {
    const input = findAmountInput(panel);
    if (!input) return out(false, 'montant', 'Champ de montant introuvable.');
    input.focus?.();
    setControlledValue(input, String(usdToType));
    amountLabel = `$${usdToType} saisis`;
  }
  note(`Montant : ${amountLabel}`);

  // 5. Devis : le bouton de confirmation s'active quand fomo a construit la transaction.
  // « Désactivé avec le libellé normal » veut dire deux choses selon le moment : juste après le
  // clic, React n'a pas encore affiché « devis en cours » ; plus tard, le devis est prêt mais une
  // case à cocher bloque. On ne conclut au second cas qu'après l'avoir vu tenir `settleMs`.
  let blockedSince = null;
  const quoteReady = await waitFor(() => {
    const p = findTradePanel(doc);
    if (!p) return null;
    if (side === 'buy' && hasInsufficientCash(p)) return { insufficient: true };
    const btn = findConfirmButton(p, symbol, side);
    if (!btn) return null;
    const state = confirmState(btn, symbol, side);
    if (state.enabled || state.belowMinimum) return { btn, state };
    if (state.normal && findAcknowledgements(p).length > 0) {
      blockedSince ??= Date.now();
      return Date.now() - blockedSince >= timeouts.settleMs ? { btn, state } : null;
    }
    blockedSince = null;
    return null;
  }, timeouts.quoteMs);

  if (quoteReady?.insufficient) return out(false, 'fonds', `Cash insuffisant pour acheter $${opts.amountUsd} (« Insufficient cash balance »).`);
  if (!quoteReady) {
    const p = findTradePanel(doc);
    const btn = p && findConfirmButton(p, symbol, side);
    return out(false, 'devis', `Le devis n'est pas arrivé à temps (bouton : « ${btn ? textOf(btn) : 'absent'} »).`);
  }
  if (quoteReady.state.belowMinimum) {
    const what = side === 'sell' ? `${opts.sellPct} % de $${available}` : `$${opts.amountUsd}`;
    return out(false, 'montant', `fomo refuse ce trade : ${what} est sous son minimum (« ${quoteReady.state.label} »).`);
  }
  note('Devis prêt');

  // 6. Cases d'avertissement, seulement celles que l'utilisateur a autorisées.
  if (!quoteReady.state.enabled) {
    const acks = findAcknowledgements(findTradePanel(doc));
    const allowed = acks.filter((a) => allows(opts, a.kind));
    const refused = acks.filter((a) => !allows(opts, a.kind));
    const acknowledgements = acks.map(({ kind, label }) => ({ kind, label, allowed: allows(opts, kind) }));

    if (opts.dryRun) {
      return out(refused.length === 0, refused.length === 0 ? 'pret' : 'avertissements', describeAcks(allowed, refused), {
        submitted: false,
        available,
        acknowledgements,
      });
    }

    // On ne sait pas lire l'état coché d'une case fomo (une icône SVG, sans aria-checked) : on
    // clique, puis on regarde si le bouton s'active.
    const clicked = [];
    let enabled = false;
    for (const ack of allowed) {
      if (!clickAck(doc, ack)) continue;
      clicked.push(ack);
      note(`Case cochée : ${ack.label}`);
      enabled = !!(await waitFor(() => confirmEnabled(doc, symbol, side), timeouts.ackMs));
      if (enabled) break;
    }
    // Une case déjà cochée avant nous a pu être DÉcochée par notre clic : on remet chacune
    // dans son état d'origine, une à la fois, en regardant si le bouton s'active.
    if (!enabled) {
      for (const ack of clicked) {
        clickAck(doc, ack);
        enabled = !!(await waitFor(() => confirmEnabled(doc, symbol, side), timeouts.ackMs / 2));
        if (enabled) break;
      }
    }
    if (!enabled) return out(false, 'avertissements', describeAcks(allowed, refused, true), { acknowledgements });
  }

  if (opts.dryRun) {
    const label = textOf(findConfirmButton(findTradePanel(doc), symbol, side));
    return out(true, 'pret', `Tout est prêt : « ${label} » était cliquable. Rien n'a été ${side === 'buy' ? 'acheté' : 'vendu'}.`, {
      submitted: false,
      available,
    });
  }

  // 7. Envoi. La preuve d'envoi : fomo vide le formulaire quand le trade est mis en file.
  const btn = findConfirmButton(findTradePanel(doc), symbol, side);
  if (!btn || !confirmState(btn, symbol, side).enabled) {
    return out(false, 'devis', 'Le bouton de confirmation s’est désactivé juste avant le clic (devis expiré).');
  }
  const labelBefore = textOf(btn);
  realClick(btn);
  note(`Clic sur « ${labelBefore} »`);

  const cleared = await waitFor(() => {
    const p = findTradePanel(doc);
    const input = p && findAmountInput(p);
    return input && input.value === '' ? true : null;
  }, timeouts.submitMs);

  return out(true, 'soumis', cleared ? 'Ordre envoyé à fomo (formulaire vidé).' : 'Clic effectué, confirmation visuelle absente — vérification par le solde.', {
    submitted: true,
    submitEvidence: cleared ? 'form-cleared' : 'clicked',
    available,
  });
}

function allows(opts, kind) {
  if (kind === 'price-impact') return !!opts.allowHighPriceImpact;
  if (kind === 'fees') return !!opts.allowHighFees;
  return opts.acceptRiskWarnings !== false;
}

/** Reclique une case en la retrouvant dans le DOM du moment : un rendu a pu remplacer le nœud. */
function clickAck(doc, ack) {
  const panel = findTradePanel(doc);
  const fresh = panel && findAcknowledgements(panel).find((a) => a.kind === ack.kind && a.label === ack.label);
  const el = fresh?.el ?? (ack.el.isConnected ? ack.el : null);
  if (!el) return false;
  realClick(el);
  return true;
}

function confirmEnabled(doc, symbol, side) {
  const p = findTradePanel(doc);
  const btn = p && findConfirmButton(p, symbol, side);
  return btn && confirmState(btn, symbol, side).enabled ? true : null;
}

const KIND_LABELS = {
  risk: 'avertissement du token',
  'price-impact': 'impact de prix élevé',
  fees: 'frais élevés',
};

function describeAcks(allowed, refused, afterClicks = false) {
  const parts = [];
  if (refused.length) {
    parts.push(
      `Bloqué par : ${refused.map((a) => `${KIND_LABELS[a.kind]} (« ${a.label} »)`).join(', ')} — non autorisé dans les réglages.`,
    );
  }
  if (allowed.length) {
    parts.push(
      afterClicks
        ? `Cases cochées sans débloquer le trade : ${allowed.map((a) => `« ${a.label} »`).join(', ')}.`
        : `L'extension cochera : ${allowed.map((a) => `« ${a.label} »`).join(', ')}.`,
    );
  }
  if (!parts.length) parts.push('Bouton de confirmation désactivé sans raison visible.');
  return parts.join(' ');
}

/** Attente par sondage : `fn` rend une valeur « vraie » ou `null`. */
export async function pollUntil(fn, timeoutMs, sleep, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(stepMs);
  }
}
