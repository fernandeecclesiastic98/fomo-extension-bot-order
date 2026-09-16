/**
 * Correspondance entre les chemins de fomo.family (`/tokens/<chaîne>/<adresse>`) et les
 * identifiants de l'API (`<adresse>:<networkId>`), relevée dans l'appli le 2026-09-15.
 */

export const NETWORK_IDS = {
  solana: 1399811149,
  robinhood: 4663,
  bnb: 56,
  base: 8453,
  ethereum: 1,
  monad: 143,
};

export const CHAIN_LABELS = {
  solana: 'Solana',
  robinhood: 'Robinhood',
  bnb: 'BNB',
  base: 'Base',
  ethereum: 'Ethereum',
  monad: 'Monad',
};

/** En-tête que l'appli envoie à chaque appel : sans lui, certaines chaînes sont filtrées. */
export const SUPPORTED_CHAINS_HEADER = Object.values(NETWORK_IDS).sort((a, b) => a - b).join(',');

const SOLANA = NETWORK_IDS.solana;

/** `/tokens/robinhood/0xAbC…` → `{ chain, networkId, address }`, ou `null` hors page token. */
export function parseTokenPath(pathname) {
  const match = /^\/tokens\/([a-z0-9-]+)\/([A-Za-z0-9]+)\/?$/.exec(pathname ?? '');
  if (!match) return null;
  const [, chain, rawAddress] = match;
  const networkId = NETWORK_IDS[chain];
  if (networkId === undefined) return null;
  return { chain, networkId, address: normalizeAddress(rawAddress, networkId) };
}

/**
 * Les adresses EVM sont insensibles à la casse et l'API les rend en minuscules ; une adresse
 * Solana (base58) change de sens si on touche à sa casse.
 */
export function normalizeAddress(address, networkId) {
  return networkId === SOLANA ? address : address.toLowerCase();
}

export function tokenId(networkId, address) {
  return `${normalizeAddress(address, networkId)}:${networkId}`;
}

export function tokenUrl(chain, address) {
  return `https://fomo.family/tokens/${chain}/${address}`;
}

export function chainForNetwork(networkId) {
  return Object.keys(NETWORK_IDS).find((chain) => NETWORK_IDS[chain] === networkId) ?? null;
}
