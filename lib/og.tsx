import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

export type OgInput = {
  eyebrow: string;
  title: string;
  subtitle?: string;
  meta?: string;
  accent?: string;
};

/**
 * One shared renderer for every opengraph-image route.
 *
 * Inline styles only — ImageResponse renders with satori, not a browser, so no
 * Tailwind classes and every container that holds children needs an explicit
 * flex display.
 */
export function renderOg({ eyebrow, title, subtitle, meta, accent = '#2BE38B' }: OgInput) {
  const trimmed = title.length > 92 ? `${title.slice(0, 91).trimEnd()}…` : title;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#08090B',
          padding: '64px 72px',
          position: 'relative',
          fontFamily: 'sans-serif',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: `radial-gradient(900px 480px at 82% -10%, ${accent}22, transparent 60%), radial-gradient(700px 420px at 4% 108%, #2BE38B12, transparent 62%)`,
            display: 'flex',
          }}
        />
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 6, background: accent, display: 'flex' }} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              fontSize: 19,
              letterSpacing: 3.4,
              textTransform: 'uppercase',
              color: accent,
              fontFamily: 'monospace',
            }}
          >
            <div style={{ width: 42, height: 2, background: accent, display: 'flex' }} />
            {eyebrow}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: trimmed.length > 58 ? 60 : 72,
              lineHeight: 1.05,
              letterSpacing: -2.4,
              color: '#FFFFFF',
              fontWeight: 600,
              maxWidth: 1000,
            }}
          >
            {trimmed}
          </div>
          {subtitle ? (
            <div style={{ display: 'flex', fontSize: 27, lineHeight: 1.4, color: '#9BA3AF', maxWidth: 940 }}>{subtitle}</div>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 16,
                border: '1px solid #FFFFFF22',
                background: '#FFFFFF0A',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 0,
                  height: 0,
                  borderLeft: `13px solid ${accent}`,
                  borderTop: '9px solid transparent',
                  borderBottom: '9px solid transparent',
                  display: 'flex',
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', fontSize: 30, fontWeight: 600, color: '#FFFFFF', letterSpacing: -0.8 }}>Voxera</div>
              <div style={{ display: 'flex', fontSize: 19, color: '#7C8592' }}>voxera.ai</div>
            </div>
          </div>
          {meta ? (
            <div
              style={{
                display: 'flex',
                fontSize: 19,
                color: '#C3CAD5',
                fontFamily: 'monospace',
                border: '1px solid #FFFFFF1A',
                background: '#FFFFFF08',
                borderRadius: 999,
                padding: '12px 22px',
              }}
            >
              {meta}
            </div>
          ) : null}
        </div>
      </div>
    ),
    OG_SIZE
  );
}
