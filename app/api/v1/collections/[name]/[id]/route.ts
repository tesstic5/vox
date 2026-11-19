import { fail } from '@/lib/server/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dashboard does not use this old unrestricted by-ID document endpoint.
 * It allowed arbitrary collection names (including authentication records),
 * bypassing dedicated APIs, role checks and the collection bridge allowlist.
 * Retire it rather than leave a second, less-protected route into the store.
 */
function retired() {
  return fail('NOT_FOUND', 'This document endpoint is unavailable. Use the resource’s dedicated API.', {});
}

export async function GET() { return retired(); }
export async function PATCH() { return retired(); }
export async function DELETE() { return retired(); }
