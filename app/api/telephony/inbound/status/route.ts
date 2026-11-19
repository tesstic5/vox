import { type NextRequest } from 'next/server';
import { fail } from '@/lib/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Status changes are accepted only by the signature-verified Twilio callback. */
export async function POST(_req: NextRequest) {
  return fail('NOT_FOUND', 'Generic telephony status callbacks are not available.');
}

export async function GET(_req: NextRequest) {
  return fail('NOT_FOUND', 'Generic telephony status callbacks are not available.');
}
