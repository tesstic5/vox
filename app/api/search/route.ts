import { NextResponse } from 'next/server';
import { buildSearchIndex } from '@/lib/search-index';

// Static: generated once at build time and served as a flat JSON payload.
export const dynamic = 'force-static';

export function GET() {
  return NextResponse.json({ entries: buildSearchIndex() });
}
