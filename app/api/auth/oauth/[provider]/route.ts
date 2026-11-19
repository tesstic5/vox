import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Federated sign-in is deliberately unavailable until a real, verified
 * authorization-code callback is implemented and tested end to end.
 *
 * The former endpoint redirected configured providers back to itself without
 * exchanging a code, and its unconfigured fallback issued a session for a
 * shared demo owner. Neither is safe on a customer-facing deployment. In
 * particular, no provider request or callback may mint a demo session.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!['google', 'github'].includes(provider.toLowerCase())) {
    return NextResponse.json(
      { error: { code: 'UNKNOWN_PROVIDER', message: 'That sign-in provider is not available.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } }
    );
  }
  return NextResponse.json(
    { error: { code: 'OAUTH_UNAVAILABLE', message: 'Google and GitHub sign-in are unavailable. Please use email and password.' } },
    { status: 503, headers: { 'cache-control': 'no-store' } }
  );
}
