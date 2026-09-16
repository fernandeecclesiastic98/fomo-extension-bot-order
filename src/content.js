/*
 * Script de contenu, injecté dans chaque page https://fomo.family/*.
 *
 * Trois rôles :
 *  1. relais réseau du service worker : il cote les tokens et lit les soldes AVEC la session de
 *     la page (même origine, jeton Privy déjà renouvelé par fomo) ;
 *  2. exécuteur : sur ordre du service worker, il pilote le panneau de vente de cet onglet ;
 *  3. interface : le panneau « TP auto » posé sur les pages de token.
 *
 * Chrome ne charge pas les scripts de contenu en module : les bibliothèques sont importées
 * dynamiquement depuis l'extension (déclarées dans web_accessible_resources).
 */
(() => {
  if (window.__fomoTpAutoLoaded) return;
  window.__fomoTpAutoLoaded = true;

  const load = (path) => import(chrome.runtime.getURL(path));
  const libs = Promise.all([
    load('lib/fomo-api.js'),
    load('lib/executor.js'),
    load('lib/chains.js'),
    load('lib/fomo-page.js'),
  ]).then(([api, executor, chains, page]) => ({ api, executor, chains, page }));

  let executing = false;

  // Enregistré tout de suite : un message qui arrive avant la fin des imports attend `libs`
  // au lieu de tomber sur « Receiving end does not exist ».
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handle(message).then(sendResponse, (error) =>
      sendResponse({ ok: false, reason: 'exception', stage: 'exception', detail: String(error?.message ?? error) }),
    );
    return true;
  });

  async function handle(message) {
    const { api, executor, chains, page } = await libs;
    const fomo = api.createFomoApi({ fetchImpl: window.fetch.bind(window), storage: window.localStorage });

    switch (message?.type) {
      case 'PING': {
        // Le jeton lui-même ne sort jamais de la page : le service worker n'a besoin que de savoir
        // si la session est valide.
        const { ok, reason, expInSec } = api.readSession(window.localStorage, Date.now());
        return {
          ok: true,
          path: location.pathname,
          token: chains.parseTokenPath(location.pathname),
          loggedIn: page.isLoggedIn(document),
          session: { ok, reason, expInSec },
          visibility: document.visibilityState,
          executing,
        };
      }

      case 'QUOTES':
        return fomo.quotes(message.ids ?? []);

      /**
       * Contrôle de l'interface, en lecture seule : les repères dont l'exécuteur a besoin
       * existent-ils encore ? Permet de prévenir qu'une mise à jour de fomo a cassé le pilotage
       * AVANT qu'un ordre en dépende, au lieu de le découvrir au moment de trader.
       */
      case 'PROBE': {
        const here = chains.parseTokenPath(location.pathname);
        if (!here) return { ok: false, reason: 'pas-page-token', path: location.pathname };
        const manquants = [];
        // La session se juge sur le jeton, pas sur un bouton de l'en-tête : sinon fomo qui
        // redessine sa barre du haut déclenche une alerte « session morte » alors que tout va bien.
        if (!api.readSession(window.localStorage, Date.now()).ok) manquants.push('session fomo');
        const tabs = page.findTradeTabs(document);
        if (!tabs) manquants.push('onglets Buy/Sell');
        const panel = page.findTradePanel(document);
        if (!panel) manquants.push('panneau de trade');
        else {
          const side = page.activeSide(panel);
          if (!side) manquants.push('boutons de montant');
          if (!page.findAmountInput(panel)) manquants.push('champ de montant');
          if (page.readAvailableUsd(panel) === null && !page.hasInsufficientCash(panel)) manquants.push('ligne « available »');
          if (!page.findConfirmButton(panel, undefined, side ?? 'buy')) manquants.push('bouton de confirmation');
        }
        return { ok: manquants.length === 0, manquants, url: location.pathname };
      }

      case 'BALANCE': {
        const user = await resolveUserId(fomo);
        if (!user.ok) return user;
        return fomo.balance(user.id, message.networkId, message.address);
      }

      case 'EXECUTE_TRADE': {
        if (executing) return { ok: false, stage: 'occupe', detail: 'Un trade est déjà en cours dans cet onglet.' };
        const here = chains.parseTokenPath(location.pathname);
        if (!here || here.address !== chains.normalizeAddress(message.address, message.networkId)) {
          return { ok: false, stage: 'panneau', detail: `Mauvaise page : ${location.pathname}` };
        }
        executing = true;
        // L'interface injectée repasse en mode « Au marché » : l'exécuteur doit voir le panneau de fomo.
        window.dispatchEvent(new CustomEvent('tpa:executing', { detail: true }));
        try {
          return await executor.runTrade(document, {
            side: message.side,
            amountUsd: message.amountUsd,
            sellPct: message.sellPct,
            symbol: message.symbol,
            dryRun: !!message.dryRun,
            acceptRiskWarnings: message.acceptRiskWarnings,
            allowHighPriceImpact: message.allowHighPriceImpact,
            allowHighFees: message.allowHighFees,
          });
        } finally {
          executing = false;
          window.dispatchEvent(new CustomEvent('tpa:executing', { detail: false }));
        }
      }

      default:
        return { ok: false, reason: 'unknown-message' };
    }
  }

  async function resolveUserId(fomo) {
    const cached = sessionStorage.getItem('fomoTpAuto:userId');
    if (cached) return { ok: true, id: cached };
    const user = await fomo.userId();
    if (user.ok) sessionStorage.setItem('fomoTpAuto:userId', user.id);
    return user;
  }

  // Interface : seulement dans la fenêtre principale, pas dans les iframes (graphique TradingView).
  if (window.top === window) {
    libs
      .then(async () => {
        const { mountIntegration } = await load('ui/inject.js');
        mountIntegration({ resolveUserId });
      })
      .catch((error) => console.warn('[TP auto] interface non montée :', error));
  }
})();
