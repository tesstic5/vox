/**
 * Expand-compatible postal addresses.
 *
 * Legacy records keep their original free-text address in `legacyText`. We do
 * not infer lines, locality or postcode from that text. A staff member must
 * explicitly review and save structured fields before `reviewStatus` changes.
 */

export type StructuredAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode?: string;
  /** Original free text retained verbatim (apart from outer whitespace). */
  legacyText?: string;
  reviewStatus: 'needs_review' | 'reviewed';
  reviewedAt?: string;
  reviewedBy?: string;
};

export type StructuredAddressInput = Pick<StructuredAddress, 'line1' | 'line2' | 'city' | 'county' | 'postcode' | 'countryCode'>;

function cleanText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} is too long`);
  return text || undefined;
}

export function cleanLegacyAddress(value: unknown): string | undefined {
  return cleanText(value, 'address', 1_000);
}

/** Copy a flat legacy value without attempting to parse it. */
export function structuredAddressFromLegacy(value: unknown): StructuredAddress | undefined {
  const legacyText = cleanLegacyAddress(value);
  return legacyText ? { legacyText, reviewStatus: 'needs_review' } : undefined;
}

/**
 * Validate an explicit staff review. Unknown properties are rejected so API
 * callers cannot forge review actors or timestamps.
 */
export function reviewStructuredAddress(input: unknown, options: {
  actor: string;
  at?: string;
  existing?: StructuredAddress;
  legacyText?: string;
}): StructuredAddress {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('structured address must be an object');
  const record = input as Record<string, unknown>;
  const allowed = new Set(['line1', 'line2', 'city', 'county', 'postcode', 'countryCode']);
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported) throw new Error(`structured address field ${unsupported} cannot be set`);

  const line1 = cleanText(record.line1, 'address line 1', 200);
  const line2 = cleanText(record.line2, 'address line 2', 200);
  const city = cleanText(record.city, 'city or locality', 120);
  const county = cleanText(record.county, 'county or region', 120);
  const postcode = cleanText(record.postcode, 'postcode', 32)?.toUpperCase();
  const rawCountry = cleanText(record.countryCode, 'country code', 2)?.toUpperCase();
  const countryCode = rawCountry ?? options.existing?.countryCode ?? 'GB';
  if (!/^[A-Z]{2}$/.test(countryCode)) throw new Error('country code must be a two-letter ISO code');
  if (!line1) throw new Error('address line 1 is required to complete address review');
  if (!city) throw new Error('city or locality is required to complete address review');

  const legacyText = options.existing?.legacyText ?? cleanLegacyAddress(options.legacyText);
  return {
    line1,
    line2,
    city,
    county,
    postcode,
    countryCode,
    legacyText,
    reviewStatus: 'reviewed',
    reviewedAt: options.at ?? new Date().toISOString(),
    reviewedBy: options.actor,
  };
}

/**
 * A compatibility string for existing exports, merge fields and old clients.
 * Reviewed components win; an unreviewed record exposes only its untouched
 * legacy text.
 */
export function formatStructuredAddress(
  address: StructuredAddress | undefined,
  fallback?: string,
  separator = ', ',
): string | undefined {
  if (address?.reviewStatus === 'reviewed') {
    const formatted = [address.line1, address.line2, address.city, address.county, address.postcode, address.countryCode]
      .filter((part): part is string => Boolean(part))
      .join(separator);
    if (formatted) return formatted;
  }
  return address?.legacyText ?? cleanLegacyAddress(fallback);
}
