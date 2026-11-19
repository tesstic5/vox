import { NextResponse } from 'next/server';
import { clearSessionCookie, currentSession, revokeSession } from '@/lib/server/auth';
import { ok } from '@/lib/server/api';

export const runtime = 'nodejs';

export async function POST() {
  const session = await currentSession();
  if (session) revokeSession(session.id);
  await clearSessionCookie();
  return ok({ signedOut: true });
}
