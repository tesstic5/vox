'use client';

import * as React from 'react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#08090B',
          color: '#E6EAF0',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 560 }}>
          <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: '#2BE38B' }}>
            Error 500
          </div>
          <h1 style={{ fontSize: 34, lineHeight: 1.1, letterSpacing: -1, margin: '14px 0 12px' }}>
            The application shell failed to load.
          </h1>
          <p style={{ color: '#9BA3AF', fontSize: 15, lineHeight: 1.6, margin: 0 }}>
            This is the outer boundary, so something failed before the page could render
            {error.digest ? ` (reference ${error.digest})` : ''}. Reloading usually clears it.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 26, flexWrap: 'wrap' }}>
            <button
              onClick={reset}
              style={{
                background: '#2BE38B',
                color: '#062015',
                border: 0,
                borderRadius: 10,
                padding: '11px 18px',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload
            </button>
            <a
              href="/status"
              style={{
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10,
                padding: '11px 18px',
                fontSize: 14,
                color: '#E6EAF0',
                textDecoration: 'none',
              }}
            >
              Platform status
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
