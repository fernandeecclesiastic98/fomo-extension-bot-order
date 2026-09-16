import { describe, expect, it } from 'vitest';
import { formatAgo, formatCompactInput, formatCompactUsd, formatPriceUsd, parseCompactUsd } from '../src/lib/format.js';

describe('parseCompactUsd — ce que l’utilisateur tape', () => {
  it.each([
    ['500k', 500_000],
    ['500 K', 500_000],
    ['$1.2M', 1_200_000],
    ['2,5M', 2_500_000],
    ['2,5 m', 2_500_000],
    ['1b', 1_000_000_000],
    ['1 250 000', 1_250_000],
    ['1,250,000', 1_250_000],
    ['1,250', 1_250],
    ['1,25', 1.25],
    ['1,234.56', 1_234.56],
    ['0.000249', 0.000249],
    ['0,000249', 0.000249],
    ['$249.1K MC', 249_100],
    ['4.4M', 4_400_000],
  ])('%s → %d', (input, expected) => {
    expect(parseCompactUsd(input)).toBeCloseTo(expected, 9);
  });

  it.each(['', 'abc', '5x', '-5k', '0', '1.2.3', '5kk', null, undefined])('refuse %s', (input) => {
    expect(parseCompactUsd(input)).toBeNull();
  });
});

describe('formatCompactUsd — comme les cases de fomo', () => {
  it.each([
    [249_134, '$249.1K'],
    [2_214_529, '$2.2M'],
    [21_000_000, '$21M'],
    [39_940_848, '$39.9M'],
    [1_300_000_000, '$1.3B'],
    [615.42, '$615.42'],
  ])('%d → %s', (value, expected) => {
    expect(formatCompactUsd(value)).toBe(expected);
  });

  it('arrondit vers le bas : un seuil affiché ne dépasse jamais la valeur réelle', () => {
    expect(formatCompactUsd(4_449_999)).toBe('$4.4M');
  });

  it('un montant formaté se relit à l’identique', () => {
    expect(parseCompactUsd(formatCompactUsd(2_200_000).slice(1))).toBe(2_200_000);
  });
});

describe('formatCompactInput — seuils posés par les raccourcis', () => {
  it.each([
    [1_769_446, '1.77M'],
    [4_423_616, '4.42M'],
    [416_540, '417K'],
    [2_000_000, '2M'],
    [1_300_000_000, '1.3B'],
    [0.000532_1, '0.000532'],
    [51.13, '51.1'],
  ])('%d → %s', (value, expected) => {
    expect(formatCompactInput(value)).toBe(expected);
  });

  it('se relit à 0,5 % près : un ×2 reste un ×2', () => {
    for (const value of [1_769_446, 4_423_616, 416_540, 0.0005321]) {
      expect(parseCompactUsd(formatCompactInput(value)) / value).toBeCloseTo(1, 2);
    }
  });
});

describe('formatPriceUsd', () => {
  it.each([
    [0.000249, '$0.000249'],
    [0.0215, '$0.0215'],
    [51.04, '$51.04'],
    [77975.3, '$77,975.3'],
  ])('%d → %s', (value, expected) => {
    expect(formatPriceUsd(value)).toBe(expected);
  });
});

describe('formatAgo', () => {
  it('secondes puis minutes', () => {
    expect(formatAgo(12_000)).toBe('il y a 12\u00a0s');
    expect(formatAgo(180_000)).toBe('il y a 3\u00a0min');
  });
});
