/**
 * Money, as words and numbers.
 *
 * Split out of `money.ts` for one reason: **a message about money must be able to
 * format money without importing the whole ledger.** `receipts.ts` writes the
 * sentence a receipt carries, `money.ts` calls `receipts.ts`, and if the formatter
 * lived on the far side of that call the two would import each other. Nothing in
 * here imports anything: it is arithmetic, a currency table and `Intl`.
 *
 * `money.ts` re-exports all of it, so every existing `import { formatMoney } from
 * './money'` keeps working.
 */
/* --------------------------------------------------------------- currencies */

export const CURRENCIES = ['USD', 'GBP', 'EUR', 'AUD', 'CAD', 'NZD', 'INR', 'PKR', 'AED', 'ZAR', 'JPY'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Currencies with no minor unit — a yen is a yen. */
const ZERO_DECIMAL: string[] = ['JPY'];

export function minorUnits(currency: string): number {
  return ZERO_DECIMAL.includes(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Turns what a person (or an integration) sends into integer minor units.
 *
 * Accepts `12`, `12.5`, `"12.34"`, `"1,240.00"` — the shapes a price arrives in —
 * and rounds half-up at the currency's precision. It deliberately does **not**
 * accept a value that is already minor units: two ways to say the same amount is
 * how a cent gets lost. Use `amountMinor` for that.
 */
export function toMinor(input: number | string, currency: string): number {
  const units = minorUnits(currency);
  const cleaned = typeof input === 'string' ? input.replace(/[^0-9.\-]/g, '') : input;
  const value = typeof cleaned === 'number' ? cleaned : Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  const scaled = value * 10 ** units;
  // 0.005 must round up, not to the nearest even number.
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled) + 1e-9);
  return Math.round(rounded);
}

export function fromMinor(amountMinor: number, currency: string): number {
  return Number((amountMinor / 10 ** minorUnits(currency)).toFixed(minorUnits(currency)));
}

export function formatMoney(amountMinor: number, currency = 'USD'): string {
  const units = minorUnits(currency);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: units,
      maximumFractionDigits: units,
    }).format(amountMinor / 10 ** units);
  } catch {
    return `${currency.toUpperCase()} ${(amountMinor / 10 ** units).toFixed(units)}`;
  }
}
