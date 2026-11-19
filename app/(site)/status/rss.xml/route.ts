import { NextResponse } from 'next/server';

export function GET() {
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Voxera deployment status</title><link>/status</link><description>No independent incident feed is configured for this build.</description></channel></rss>`;
  return new NextResponse(body, { headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
