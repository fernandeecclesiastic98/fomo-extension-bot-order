/**
 * Styles de l'interface injectée dans fomo.family.
 *
 * Couleurs : les variables CSS du thème de fomo (relevées le 2026-09-15 : `--color-bg-secondary`,
 * `--color-green`…), avec la valeur relevée en repli — l'interface prend les couleurs de fomo et
 * les suit s'il les change. Dimensions : celles des composants de fomo (montant en text-3xl,
 * cases p-4 rounded-xl, boutons rapides h-8 rounded-lg, confirmation h-11 rounded-xl).
 *
 * Mouvement : court (150-350 ms), une seule courbe, et jamais rejoué par un simple rafraîchissement
 * de cote — les animations d'entrée ne jouent qu'à la création d'un nœud, les « flash » passent
 * par un attribut `data-flash` posé puis retiré. `prefers-reduced-motion` coupe tout.
 *
 * Toutes les classes sont préfixées `tpa-` : rien ne fuit vers la page, rien ne s'y accroche.
 */

export const STYLE_ID = 'tpa-styles';

const CSS = `
[data-tpa-hidden], [data-tpa][hidden], [data-tpa] [hidden] { display: none !important; }
[data-tpa] {
  --tpa-bg: var(--color-bg-primary, #060510);
  --tpa-bg2: var(--color-bg-secondary, #12111a);
  --tpa-line: var(--color-bg-tertiary, #cbd0eb1a);
  --tpa-t1: var(--color-text-primary, #f7f7f7);
  --tpa-t2: var(--color-text-secondary, #9899a3);
  --tpa-t3: var(--color-text-tertiary, #474b52);
  --tpa-accent: var(--color-accent-primary, #516af6);
  --tpa-accent-soft: var(--color-accent-primary-transparent, #516af629);
  --tpa-green: var(--color-green, #21c95e);
  --tpa-green-soft: var(--color-green-transparent, #21c95e33);
  --tpa-red: var(--color-red, #ff622e);
  --tpa-red-soft: var(--color-red-transparent, #ff622e33);
  --tpa-warn: var(--color-warning, #ffc74f);
  --tpa-warn-soft: #ffc74f1f;
  --tpa-ease: cubic-bezier(.2, .8, .2, 1);
  font-family: var(--font-sans, Aeonik, "DM Sans", system-ui, sans-serif);
  color: var(--tpa-t1);
  box-sizing: border-box;
  font-variant-numeric: tabular-nums;
}
[data-tpa] *, [data-tpa] *::before, [data-tpa] *::after { box-sizing: border-box; }
[data-tpa] button { font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent; }
[data-tpa] button:disabled { cursor: not-allowed; }
[data-tpa] input { font: inherit; color: inherit; }
[data-tpa] button:focus-visible, [data-tpa] input:focus-visible { outline: 2px solid var(--tpa-accent); outline-offset: 1px; }

@keyframes tpa-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes tpa-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes tpa-pop { 0% { transform: scale(.86); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
@keyframes tpa-shake { 0%, 100% { transform: none; } 20%, 60% { transform: translateX(-4px); } 40%, 80% { transform: translateX(4px); } }
@keyframes tpa-ring { 0% { transform: scale(1); opacity: .6; } 100% { transform: scale(2.6); opacity: 0; } }
@keyframes tpa-breathe { 0% { box-shadow: 0 0 0 0 var(--tpa-accent-soft); } 70% { box-shadow: 0 0 0 5px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@keyframes tpa-tick-up { 0%, 30% { color: var(--tpa-green); } 100% { color: var(--tpa-t2); } }
@keyframes tpa-tick-down { 0%, 30% { color: var(--tpa-red); } 100% { color: var(--tpa-t2); } }
@keyframes tpa-glow { 0% { background: var(--tpa-accent-soft); box-shadow: inset 0 0 0 1px var(--tpa-accent); } 100% { background: transparent; box-shadow: inset 0 0 0 1px transparent; } }
@keyframes tpa-glow-green { 0% { box-shadow: 0 0 0 0 var(--tpa-green-soft); } 50% { box-shadow: 0 0 0 6px var(--tpa-green-soft); } 100% { box-shadow: 0 0 0 0 transparent; } }
@keyframes tpa-spin { to { transform: rotate(360deg); } }
@keyframes tpa-flip-up { from { opacity: 0; transform: translateY(40%); } to { opacity: 1; transform: none; } }

/* Sélecteur « Au marché / Ordre auto » : pastille qui glisse, calquée sur le bouton Open/Closed de fomo */
.tpa-mode { position: relative; display: grid; grid-template-columns: 1fr 1fr; padding: 2px; border: 1px solid var(--tpa-line);
  border-radius: 10px; background: var(--tpa-bg); }
.tpa-mode::before { content: ''; position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc(50% - 2px); border-radius: 8px;
  background: var(--tpa-accent-soft); transition: transform .32s var(--tpa-ease); }
.tpa-mode[data-active="order"]::before { transform: translateX(100%); }
.tpa-mode button { position: relative; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 30px;
  border: 0; border-radius: 8px; background: transparent; color: var(--tpa-t2); font-size: 13px; font-weight: 700; transition: color .2s; }
.tpa-mode button:hover { color: var(--tpa-t1); }
.tpa-mode button.tpa-on { color: var(--tpa-accent); }
.tpa-badge { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--tpa-accent);
  color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
[data-flash="bump"] { animation: tpa-pop .42s var(--tpa-ease); }

/* Formulaire d'ordre : entrée en cascade à la création (et au changement Buy ↔ Sell) */
.tpa-form { display: flex; flex-direction: column; gap: 8px; }
.tpa-form > * { animation: tpa-rise .34s var(--tpa-ease) both; }
.tpa-form > :nth-child(2) { animation-delay: 30ms; } .tpa-form > :nth-child(3) { animation-delay: 60ms; }
.tpa-form > :nth-child(4) { animation-delay: 90ms; } .tpa-form > :nth-child(5) { animation-delay: 120ms; }
.tpa-form > :nth-child(6) { animation-delay: 150ms; } .tpa-form > :nth-child(7) { animation-delay: 180ms; }
.tpa-form > :nth-child(n+8) { animation-delay: 210ms; }

.tpa-box { background: var(--tpa-bg2); border-radius: 12px; padding: 12px 16px; border: 1px solid transparent; transition: border-color .18s; }
.tpa-box:focus-within { border-color: var(--tpa-line); }
.tpa-box-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--tpa-t2); min-height: 24px; }
.tpa-box-head .tpa-grow { flex: 1; }
.tpa-metric { position: relative; display: inline-grid; grid-template-columns: 1fr 1fr; padding: 2px; border-radius: 8px; background: var(--tpa-bg); }
.tpa-metric::before { content: ''; position: absolute; top: 2px; bottom: 2px; left: 2px; width: calc(50% - 2px); border-radius: 6px;
  background: var(--tpa-line); transition: transform .28s var(--tpa-ease); }
.tpa-metric[data-active="price"]::before { transform: translateX(100%); }
.tpa-metric button { position: relative; z-index: 1; border: 0; border-radius: 6px; padding: 2px 10px; background: transparent;
  color: var(--tpa-t2); font-size: 12px; font-weight: 700; transition: color .2s; }
.tpa-metric button.tpa-on { color: var(--tpa-t1); }
.tpa-big { display: flex; align-items: center; gap: 2px; margin-top: 6px; }
.tpa-big > span { color: var(--tpa-t3); font-size: 30px; line-height: 1.2; }
.tpa-big input { flex: 1; min-width: 0; border: 0; outline: 0 !important; background: transparent; font-size: 30px; line-height: 1.2; caret-color: var(--tpa-accent); }
.tpa-big input::placeholder { color: var(--tpa-t3); }
.tpa-big em { font-style: normal; color: var(--tpa-t2); font-size: 13px; white-space: nowrap; }
.tpa-big-pct input { flex: none; width: 3.2ch; text-align: right; }
.tpa-big-pct em { margin-left: auto; }
[data-slot="now"][data-tick="up"] { animation: tpa-tick-up 1.1s ease-out; }
[data-slot="now"][data-tick="down"] { animation: tpa-tick-down 1.1s ease-out; }

.tpa-dir { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; white-space: nowrap; transition: background-color .25s, color .25s; }
.tpa-dir.tpa-up { background: var(--tpa-green-soft); color: var(--tpa-green); }
.tpa-dir.tpa-down { background: var(--tpa-red-soft); color: var(--tpa-red); }
.tpa-dir[data-flash] { animation: tpa-pop .36s var(--tpa-ease); }

.tpa-chips { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 6px; }
.tpa-chips button { height: 32px; border: 0; border-radius: 8px; background: var(--tpa-bg2); color: var(--tpa-t1); font-size: 14px; font-weight: 700;
  transition: background-color .15s, color .15s, box-shadow .15s, transform .12s var(--tpa-ease); }
.tpa-chips button:hover { background: var(--tpa-line); }
.tpa-chips button:active { transform: scale(.95); }
.tpa-chips button.tpa-on { background: var(--tpa-accent-soft); color: var(--tpa-accent); box-shadow: inset 0 0 0 1px var(--tpa-accent-soft); }
.tpa-chips:empty { display: none; }

.tpa-exits { display: flex; flex-direction: column; gap: 8px; }
.tpa-exit { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--tpa-t2); }
.tpa-exit label { display: flex; align-items: center; gap: 8px; color: var(--tpa-t1); font-weight: 600; cursor: pointer; user-select: none; }
.tpa-check { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0; border-radius: 5px; border: 1.5px solid var(--tpa-t3);
  display: inline-grid; place-content: center; cursor: pointer; transition: background-color .18s, border-color .18s; }
.tpa-check::after { content: ''; width: 8px; height: 5px; border: 2px solid #fff; border-top: 0; border-right: 0; transform: rotate(-45deg) scale(0);
  margin-top: -2px; transition: transform .22s var(--tpa-ease); }
.tpa-check:checked { background: var(--tpa-accent); border-color: var(--tpa-accent); }
.tpa-check:checked::after { transform: rotate(-45deg) scale(1); }
.tpa-exit input[type="text"] { width: 44px; height: 26px; padding: 0 6px; border: 1px solid var(--tpa-line); border-radius: 6px;
  background: var(--tpa-bg); text-align: right; font-weight: 700; outline: 0; transition: opacity .2s, border-color .15s; }
.tpa-exit input[type="text"]:focus { border-color: var(--tpa-accent); }
.tpa-exit.tpa-off input[type="text"] { opacity: .35; }

.tpa-summary { margin: 0; padding: 0 8px; font-size: 13px; line-height: 1.4; color: var(--tpa-t2); }
.tpa-summary b { color: var(--tpa-t1); font-weight: 600; }
.tpa-msg { margin: 0; padding: 8px 12px; border-radius: 10px; font-size: 12px; line-height: 1.4; animation: tpa-rise .26s var(--tpa-ease) both; }
.tpa-msg.tpa-err { background: var(--tpa-red-soft); color: var(--tpa-red); }
.tpa-msg.tpa-warn { background: var(--tpa-warn-soft); color: var(--tpa-warn); }
.tpa-msg.tpa-ok { background: var(--tpa-green-soft); color: var(--tpa-green); }
.tpa-msg[data-flash="shake"] { animation: tpa-shake .38s ease-in-out; }

.tpa-submit { position: relative; height: 44px; border-radius: 12px; border: 1px solid var(--tpa-line); font-size: 16px; font-weight: 700; overflow: hidden;
  transition: filter .15s, opacity .2s, transform .12s var(--tpa-ease), background-color .2s, color .2s; }
.tpa-submit:disabled { opacity: .45; }
.tpa-submit:not(:disabled):hover { filter: brightness(1.18); }
.tpa-submit:not(:disabled):active { transform: scale(.985); }
.tpa-submit.tpa-buy { background: var(--tpa-green-soft); color: var(--tpa-green); }
.tpa-submit.tpa-sell { background: var(--tpa-red-soft); color: var(--tpa-red); }
.tpa-submit span { display: inline-block; animation: tpa-flip-up .28s var(--tpa-ease); }
.tpa-submit[data-state="busy"] span { opacity: 0; }
.tpa-submit[data-state="busy"]::after { content: ''; position: absolute; left: 50%; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px;
  border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: tpa-spin .7s linear infinite; }
.tpa-submit[data-state="done"] { animation: tpa-glow-green .9s ease-out; }
.tpa-link { border: 0; background: none; padding: 0; color: var(--tpa-accent); font-size: 13px; font-weight: 700; transition: opacity .15s; }
.tpa-link:hover { opacity: .8; }
.tpa-fine { margin: 0; padding: 0 8px; font-size: 11px; color: var(--tpa-t3); line-height: 1.4; }

/* Carte « Ordres auto » de la colonne de droite, calquée sur « Your positions » */
.tpa-card { border: 1px solid var(--tpa-line); border-radius: 16px; padding: 8px; display: flex; flex-direction: column; gap: 4px; animation: tpa-rise .34s var(--tpa-ease) both; }
.tpa-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 8px; }
.tpa-card-title { font-size: 16px; }
.tpa-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tpa-t2); }
.tpa-state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--tpa-t3); }
.tpa-state.tpa-good { color: var(--tpa-green); }
.tpa-state.tpa-good::before { background: var(--tpa-green); animation: tpa-breathe 2s ease-out infinite; box-shadow: 0 0 0 0 var(--tpa-green-soft); }
.tpa-state.tpa-bad { color: var(--tpa-warn); }
.tpa-state.tpa-bad::before { background: var(--tpa-warn); }
.tpa-rows { display: flex; flex-direction: column; }
.tpa-order { padding: 8px; border-radius: 10px; display: flex; flex-direction: column; gap: 3px; transition: background-color .15s; animation: tpa-rise .3s var(--tpa-ease) both; }
.tpa-order:hover { background: var(--tpa-bg2); }
.tpa-order[data-flash="new"] { animation: tpa-glow 1.6s ease-out; }
.tpa-order[data-flash="status"] .tpa-status { animation: tpa-pop .42s var(--tpa-ease); }
.tpa-order-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tpa-order-desc { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; min-width: 0; }
.tpa-side { flex: none; width: 18px; height: 18px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px; }
.tpa-side.tpa-buy { background: var(--tpa-green-soft); color: var(--tpa-green); }
.tpa-side.tpa-sell { background: var(--tpa-red-soft); color: var(--tpa-red); }
.tpa-order-meta { font-size: 12px; color: var(--tpa-t2); padding-left: 26px; }
.tpa-order-err { font-size: 12px; color: var(--tpa-red); padding-left: 26px; }
.tpa-order-actions { display: flex; gap: 12px; padding-left: 26px; margin-top: 2px; }
.tpa-order-actions button { border: 0; background: none; padding: 0; font-size: 12px; font-weight: 700; color: var(--tpa-t2); transition: color .15s; }
.tpa-order-actions button:hover { color: var(--tpa-t1); }
.tpa-order-actions button[data-op="cancel"]:hover, .tpa-order-actions button[data-op="delete"]:hover { color: var(--tpa-red); }
.tpa-status { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px; background: var(--tpa-line); color: var(--tpa-t2); }
.tpa-s-armed { background: var(--tpa-accent-soft); color: var(--tpa-accent); }
.tpa-s-armed::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--tpa-accent); animation: tpa-breathe 2s ease-out infinite; }
.tpa-s-pending, .tpa-s-queued, .tpa-s-executing { background: var(--tpa-warn-soft); color: var(--tpa-warn); }
.tpa-s-pending::before, .tpa-s-queued::before, .tpa-s-executing::before { content: ''; width: 8px; height: 8px; border-radius: 50%;
  border: 1.5px solid currentColor; border-right-color: transparent; animation: tpa-spin .8s linear infinite; }
.tpa-s-done { background: var(--tpa-green-soft); color: var(--tpa-green); }
.tpa-s-failed { background: var(--tpa-red-soft); color: var(--tpa-red); }

/* Bouton de la barre du haut, calqué sur les cases « cash » de fomo */
.tpa-chip { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 12px; margin-right: 8px; border: 1px solid var(--tpa-line);
  border-radius: 12px; background: var(--tpa-bg); color: var(--tpa-t1); font-size: 14px; white-space: nowrap; transition: background-color .15s, transform .12s var(--tpa-ease);
  animation: tpa-fade .4s ease-out both; }
.tpa-chip:hover { background: var(--tpa-bg2); }
.tpa-chip:active { transform: scale(.98); }
.tpa-chip-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--tpa-t3); transition: background-color .3s; }
.tpa-chip-dot.tpa-good { background: var(--tpa-green); }
.tpa-chip-dot.tpa-good::after { content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--tpa-green); animation: tpa-ring 1.8s ease-out infinite; }
.tpa-chip-dot.tpa-bad { background: var(--tpa-warn); }
.tpa-chip-count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--tpa-accent-soft); color: var(--tpa-accent);
  font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; }
.tpa-chip-count:empty { display: none; }

/* Tiroir « Ordres auto » : glisse depuis la droite */
.tpa-drawer { position: fixed; inset: 0; z-index: 2147483000; }
.tpa-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, .55); opacity: 0; transition: opacity .24s ease; }
.tpa-sheet { position: absolute; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: var(--tpa-bg); border-left: 1px solid var(--tpa-line);
  display: flex; flex-direction: column; box-shadow: -16px 0 48px rgba(0, 0, 0, .5); transform: translateX(100%); transition: transform .34s var(--tpa-ease); }
.tpa-drawer[data-state="open"] .tpa-backdrop { opacity: 1; }
.tpa-drawer[data-state="open"] .tpa-sheet { transform: none; }
.tpa-sheet-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 16px; border-bottom: 1px solid var(--tpa-line); }
.tpa-sheet-head h2 { margin: 0 0 2px; font-size: 18px; font-weight: 600; }
.tpa-sheet-body { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 12px; }
.tpa-sheet-foot { padding: 12px 16px; border-top: 1px solid var(--tpa-line); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.tpa-group { animation: tpa-rise .3s var(--tpa-ease) both; }
.tpa-group-head { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 8px; font-weight: 600; }
.tpa-group-head small { color: var(--tpa-t2); font-weight: 400; }
.tpa-group-head a { color: var(--tpa-accent); font-size: 12px; font-weight: 700; text-decoration: none; }
.tpa-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; color: var(--tpa-t2); cursor: pointer; user-select: none; }
.tpa-switch input { appearance: none; -webkit-appearance: none; position: relative; width: 34px; height: 20px; margin: 0; border-radius: 999px; background: var(--tpa-line);
  cursor: pointer; transition: background-color .22s; }
.tpa-switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--tpa-t1);
  transition: transform .26s var(--tpa-ease); }
.tpa-switch input:checked { background: var(--tpa-green); }
.tpa-switch input:checked::after { transform: translateX(14px); }
.tpa-close { width: 32px; height: 32px; border: 0; border-radius: 8px; background: var(--tpa-bg2); color: var(--tpa-t2); font-size: 15px; transition: color .15s, background-color .15s; }
.tpa-close:hover { color: var(--tpa-t1); background: var(--tpa-line); }
.tpa-empty { padding: 32px 16px; text-align: center; color: var(--tpa-t2); font-size: 13px; line-height: 1.5; animation: tpa-fade .3s ease-out both; }

/* Repli flottant si le panneau de fomo est introuvable */
.tpa-floating { position: fixed; right: 16px; bottom: 44px; z-index: 2147482000; width: 360px; max-height: calc(100vh - 120px); overflow-y: auto;
  padding: 8px; border: 1px solid var(--tpa-line); border-radius: 16px; background: var(--tpa-bg); box-shadow: 0 12px 40px rgba(0, 0, 0, .6);
  display: flex; flex-direction: column; gap: 8px; animation: tpa-rise .34s var(--tpa-ease) both; }
.tpa-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tpa-sides button { height: 40px; border: 0; border-radius: 8px; background: var(--tpa-bg2); color: var(--tpa-t2); font-size: 16px; font-weight: 700; transition: background-color .2s, color .2s; }
.tpa-sides button.tpa-on.tpa-buy { background: var(--tpa-green-soft); color: var(--tpa-green); }
.tpa-sides button.tpa-on.tpa-sell { background: var(--tpa-red-soft); color: var(--tpa-red); }

/* Mouvement réduit : pas d'animation du tout. Raccourcir la durée ne suffit pas — les délais de la
   cascade garderaient les éléments invisibles, et indéfiniment dans un onglet que Chrome ne dessine pas. */
@media (prefers-reduced-motion: reduce) {
  [data-tpa], [data-tpa] *, [data-tpa] *::before, [data-tpa] *::after {
    animation: none !important; transition: none !important;
  }
}
`;

export function ensureStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}
