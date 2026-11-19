import { NextResponse, type NextRequest } from 'next/server';

/**
 * Gate the dashboard behind a session cookie. (Next 16 renamed the
 * `middleware` convention to `proxy`; same request, same job.)
 *
 * The cookie is only checked for presence here — expiry and revocation are
 * verified inside the route handlers, where the database is reachable. This
 * layer exists so an unauthenticated visitor gets a redirect instead of a
 * half-rendered dashboard, and so the API never caches private responses.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith('/dashboard')) {
    const session = req.cookies.get('voxera_session')?.value;
    if (!session) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.search = `?next=${encodeURIComponent(pathname + search)}`;
      return NextResponse.redirect(url);
    }
    const res = NextResponse.next();
    res.headers.set('cache-control', 'private, no-store');
    return res;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
