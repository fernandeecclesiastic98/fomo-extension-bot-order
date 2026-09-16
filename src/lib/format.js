/**
 * Lecture et affichage des montants tels que fomo les écrit (« $249.1K », « $2.2M ») et tels
 * qu'un humain les tape dans un champ (« 500k », « 2,5 M », « 1 250 000 »).
 *
 * Un seuil mal lu est une vente au mauvais moment : on refuse ce qui est ambigu plutôt que de
 * deviner.
 */

const SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * « 500k » → 500000. Rend `null` si la saisie n'est pas un nombre strictement positif.
 * Virgule : décimale (« 2,5m »), sauf quand elle sépare visiblement des milliers
 * (« 1,250,000 », ou « 1,250 » sans suffixe, ou mêlée à un point).
 */
export function parseCompactUsd(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== 'string') return null;

  let s = input
    .toLowerCase()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/\$/g, '')
    .replace(/usd$/, '')
    .replace(/mc$/, '');
  if (s === '') return null;

  let multiplier = 1;
  const suffix = s.at(-1);
  if (suffix in SUFFIXES) {
    multiplier = SUFFIXES[suffix];
    s = s.slice(0, -1);
  }

  const commas = (s.match(/,/g) ?? []).length;
  if (commas > 0) {
    const hasDot = s.includes('.');
    const afterLastComma = s.length - s.lastIndexOf(',') - 1;
    const thousands = hasDot || commas > 1 || (afterLastComma === 3 && multiplier === 1);
    s = thousands ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;
  const value = Number(s) * multiplier;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 249134 → « $249.1K », comme les cases de fomo (une décimale, « .0 » retiré). */
export function formatCompactUsd(value) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const scaled = Math.floor((abs / size) * 10) / 10;
      return `${sign}$${stripZero(scaled.toFixed(1))}${unit}`;
    }
  }
  return `${sign}${formatPriceUsd(abs)}`;
}

/**
 * Valeur à écrire dans un champ de seuil depuis un raccourci (×2, −20 %…) : trois chiffres
 * significatifs, sans « $ ». Plus précis que l'affichage de fomo (« $4.4M ») pour qu'un « ×2 »
 * reste un ×2 (4.42M et non 4.4M), et relu à l'identique par `parseCompactUsd`.
 */
export function formatCompactInput(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (value >= size) return `${trimNumber((value / size).toPrecision(3))}${unit}`;
  }
  return trimNumber(value.toPrecision(3));
}

function trimNumber(text) {
  const plain = Number(text).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 });
  return plain.includes('.') ? plain.replace(/0+$/, '').replace(/\.$/, '') : plain;
}

/** Prix d'un token : deux décimales au-dessus de 1 $, trois chiffres significatifs en dessous. */
export function formatPriceUsd(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (value === 0) return '$0';
  const digits = Math.min(12, Math.max(2, -Math.floor(Math.log10(value)) + 2));
  return `$${stripTrailingZeros(value.toFixed(digits))}`;
}

/** « 25 » → « 25 % » avec l'espace fine insécable du français. */
export function formatPct(value) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}\u202f%`;
}

/** « il y a 12 s », « il y a 3 min » — pour l'état du veilleur. */
export function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'jamais';
  const s = Math.round(ms / 1000);
  if (s < 60) return `il y a ${s}\u00a0s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m}\u00a0min`;
  return `il y a ${Math.round(m / 60)}\u00a0h`;
}

function stripZero(text) {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

function stripTrailingZeros(text) {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
