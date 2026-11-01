export const WAD = 10n ** 18n;
export const USD = 10n ** 6n;
export const BPS = 10000n;
export function units(value, decimals = 18) {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw new Error('Amounts must be non-negative decimal strings');
  const [whole, frac = ''] = value.split('.');
  if (frac.length > decimals) throw new Error('Too many decimal places');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
export function format(value, decimals = 18) {
  const n = BigInt(value), sign = n < 0n ? '-' : '', a = n < 0n ? -n : n, base = 10n ** BigInt(decimals);
  return sign + a / base + (decimals ? '.' + (a % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '').replace(/\.$/, '');
}
export const ceilDiv = (a, b) => { a = BigInt(a); b = BigInt(b); if (b <= 0n || a < 0n) throw new Error('Invalid division'); return (a + b - 1n) / b; };
export const min = (a, b) => a < b ? a : b;
export const max = (a, b) => a > b ? a : b;
export const bnbToUsd = (wei, priceMicro) => ceilDiv(BigInt(wei) * BigInt(priceMicro), WAD);
export const usdToBnb = (micro, priceMicro) => ceilDiv(BigInt(micro) * WAD, BigInt(priceMicro));
export const bp = (amount, bps) => BigInt(amount) * BigInt(bps) / BPS;
export const dayKey = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
