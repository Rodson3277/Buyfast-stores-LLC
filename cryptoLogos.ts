// Official Base brand-kit, TheSquare/Digital/Base_square_blue.svg.
// Base's native gas asset is ETH; using ETHBASE's coin logo as the chain logo
// would misidentify Base. Keep this explicit chain-brand exception.
export const BASE_NETWORK_LOGO = 'https://raw.githubusercontent.com/base/brand-kit/main/logo/TheSquare/Digital/Base_square_blue.svg';
// Exact icon URLs published in the official sites' <link rel="icon"> /
// <link rel="apple-touch-icon"> metadata, verified at optimism.io/brand and linea.build.
export const OPTIMISM_NETWORK_LOGO = 'https://cdn.sanity.io/images/y6ka751a/production/b5455d6825417cb9be16dfda5471a72360102118-64x64.png';
export const LINEA_NETWORK_LOGO = 'https://linea.build/apple-touch-icon.png';

export function safeCryptoLogoUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if ([BASE_NETWORK_LOGO, OPTIMISM_NETWORK_LOGO, LINEA_NETWORK_LOGO].includes(value)) return value;
  // Only provider-owned coin image paths, never arbitrary remote URLs/data/SVG markup.
  const path = value.startsWith('https://nowpayments.io/')
    ? value.slice('https://nowpayments.io'.length) : value;
  if (!/^\/images\/coins\/[a-zA-Z0-9_-]+\.(svg|png|webp|jpg)$/i.test(path)) return null;
  return `https://nowpayments.io${path}`;
}

// Provider network ID -> exact provider asset with verified matching chain branding.
// No ticker/suffix inference; unknown networks get an honest unavailable fallback.
const NETWORK_ASSET: Record<string, string> = {
  btc: 'btc', ltc: 'ltc', eth: 'eth', sol: 'sol', trx: 'trx',
  bsc: 'bnbbsc', matic: 'maticmainnet', polygon: 'maticmainnet',
  arbitrum: 'arb', ton: 'ton', cchain: 'avaxc', avaxc: 'avaxc',
};

export function networkLogoFromMetadata(network: string, rows: any[]): string | null {
  if (network === 'base') return BASE_NETWORK_LOGO;
  if (network === 'op') return OPTIMISM_NETWORK_LOGO;
  if (network === 'lna') return LINEA_NETWORK_LOGO;
  const mappedCode = NETWORK_ASSET[network];
  const matches = rows.filter(row => typeof row?.code === 'string' &&
    row.code.toLowerCase() === (mappedCode || network) &&
    // Native chain metadata can extend this without treating a token as its chain.
    (mappedCode || (row.network === network && !row.smart_contract)));
  return matches.length === 1 ? safeCryptoLogoUrl(matches[0].logo_url) : null;
}