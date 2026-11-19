import { type NextRequest } from 'next/server';
import { fail } from '@/lib/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The former unsigned provider-agnostic SIP bridge is intentionally retired.
 * This build accepts inbound calls only through the signature-verified Twilio
 * webhook. Reintroducing another carrier requires its own authenticated adapter.
 */
export async function POST(_req: NextRequest) {
  return fail('NOT_FOUND', 'Generic telephony ingress is not available. Configure the verified Twilio webhook instead.');
}

export async function GET(_req: NextRequest) {
  return fail('NOT_FOUND', 'Generic telephony ingress is not available.');
}
