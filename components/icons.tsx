import * as React from 'react';
import { cn } from '@/lib/utils';

/* ------------------------------------------------------------------ logo */

export function LogoMark({ className, size = 26 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 28 28"
      width={size}
      height={size}
      fill="none"
      className={cn('shrink-0', className)}
      aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="27" height="27" rx="7.5" fill="#0B0F0D" stroke="rgba(255,255,255,0.14)" />
      <g fill="#2BE38B">
        <rect x="6" y="12" width="2.2" height="4" rx="1.1" />
        <rect x="9.6" y="8.5" width="2.2" height="11" rx="1.1" />
        <rect x="13.2" y="5.8" width="2.2" height="16.4" rx="1.1" />
        <rect x="16.8" y="9.6" width="2.2" height="8.8" rx="1.1" />
        <rect x="20.4" y="12.6" width="2.2" height="2.8" rx="1.1" />
      </g>
      <circle cx="14.3" cy="14" r="12" stroke="#2BE38B" strokeOpacity="0.12" />
    </svg>
  );
}

export function Logo({ className, size = 26, showWord = true }: { className?: string; size?: number; showWord?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark size={size} />
      {showWord && (
        <span className="text-[17px] font-semibold tracking-[-0.03em] text-slate-900">
          Voxera
          <span className="text-brand-400">.</span>
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------- generic icons set */

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export const Icons = {
  arrowRight: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  ),
  arrowUpRight: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M7 17 17 7M8 7h9v9" />
    </svg>
  ),
  chevronDown: ({ size = 14, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
  chevronRight: ({ size = 14, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
  check: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p} strokeWidth={2}>
      <path d="m5 13 4 4L19 7" />
    </svg>
  ),
  close: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p} strokeWidth={1.8}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  menu: ({ size = 18, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M3 7h18M3 12h18M3 17h18" />
    </svg>
  ),
  plus: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  search: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  copy: ({ size = 15, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A2.5 2.5 0 0 0 4 5.5v6A2.5 2.5 0 0 0 6.5 14" />
    </svg>
  ),
  external: ({ size = 14, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M14 4h6v6M20 4l-8 8" />
      <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
    </svg>
  ),
  phone: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M5 3h3l1.8 4.2-2.1 1.5a12 12 0 0 0 6.1 6.1l1.5-2.1L19.5 14v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3 5.2 2 2 0 0 1 5 3Z" />
    </svg>
  ),
  phoneOff: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M5 3h3l1.8 4.2-2.1 1.5a12 12 0 0 0 6.1 6.1l1.5-2.1L19.5 14v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3 5.2 2 2 0 0 1 5 3Z" />
      <path d="m3 3 18 18" />
    </svg>
  ),
  mic: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="9" y="3" width="6" height="10" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  ),
  micOff: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M9 6a3 3 0 0 1 6 0v5M14.9 14.9A3 3 0 0 1 9 13v-2" />
      <path d="M5.5 11a6.5 6.5 0 0 0 9.7 5.7M18.5 11a6.4 6.4 0 0 1-.4 2.2M12 17.5V21" />
      <path d="m3 3 18 18" />
    </svg>
  ),
  play: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p} fill="currentColor" stroke="none">
      <path d="M8 5.5v13l11-6.5-11-6.5Z" />
    </svg>
  ),
  pause: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p} fill="currentColor" stroke="none">
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" />
    </svg>
  ),
  waveform: ({ size = 18, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11.5v1M21 12h.5" />
    </svg>
  ),
  sparkles: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6z" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
    </svg>
  ),
  bolt: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z" />
    </svg>
  ),
  shield: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  lock: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </svg>
  ),
  globe: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.3 3.6 8.5S14.4 19.1 12 20.5c-2.4-1.4-3.6-5.3-3.6-8.5S9.6 5.9 12 3.5Z" />
    </svg>
  ),
  users: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17.5 20h3a4.5 4.5 0 0 0-3-4.2" />
    </svg>
  ),
  headphones: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="13.5" width="3.6" height="6.5" rx="1.6" />
      <rect x="17.4" y="13.5" width="3.6" height="6.5" rx="1.6" />
    </svg>
  ),
  trend: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  ),
  handshake: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="m8 12 2.5 2.5a1.6 1.6 0 0 0 2.3 0L15 12" />
      <path d="M2.5 10.5 6 7l3 1 3-1 3 1 3.5-3.5M21.5 10.5 18 14l-3 3-3-3" />
      <path d="M6 7v6M18 7v7" />
    </svg>
  ),
  badge: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 2.8l2.3 1.7 2.9-.3 1 2.7 2.3 1.6-.9 2.8.9 2.8-2.3 1.6-1 2.7-2.9-.3L12 21.2l-2.3-1.7-2.9.3-1-2.7L3.5 15.5l.9-2.8-.9-2.8 2.3-1.6 1-2.7 2.9.3z" />
      <path d="m9.2 12 2 2 3.6-3.8" />
    </svg>
  ),
  trash: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 7h16M9.5 7V5h5v2M6 7l1 13h10l1-13" />
    </svg>
  ),
  eye: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  settings: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  ),
  chart: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  ),
  terminal: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="m7 10 2.5 2.5L7 15M12.5 15H17" />
    </svg>
  ),
  book: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z" />
      <path d="M8 3v18" />
    </svg>
  ),
  layers: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  ),
  flask: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M9 3h6M10 3v5.5L4.8 17A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.2-4L14 8.5V3" />
      <path d="M7.5 15h9" />
    </svg>
  ),
  server: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="3" y="3.5" width="18" height="7" rx="2" />
      <rect x="3" y="13.5" width="18" height="7" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  ),
  clock: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  building: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h6v6H9z" />
    </svg>
  ),
  key: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21M17.5 12v3M20 12v2" />
    </svg>
  ),
  download: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4 20h16" />
    </svg>
  ),
  refresh: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  ),
  filter: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M3 5h18l-7 8v6l-4-2v-4z" />
    </svg>
  ),
  briefcase: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18" />
    </svg>
  ),
  rocket: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M5 15s-1 4 0 5 5 0 5 0" />
      <path d="M14.5 3.5C18 5 21 9 20.5 14.5l-5 5-4-1.5L3.5 10 8.5 5z" />
      <circle cx="14.5" cy="9.5" r="1.6" />
    </svg>
  ),
  award: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="12" cy="9" r="5.5" />
      <path d="m8.5 14-1.5 7 5-2.5 5 2.5-1.5-7" />
    </svg>
  ),
  dollar: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 2.5v19M16.5 6.5H10a3.2 3.2 0 0 0 0 6.4h4a3.2 3.2 0 0 1 0 6.4H7" />
    </svg>
  ),
  spark2: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 4v6M12 14v6M4 12h6M14 12h6" />
    </svg>
  ),
  send: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4z" />
    </svg>
  ),
  calendar: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  ),
  puzzle: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M9 3.5a2 2 0 1 1 4 0V5h3a1 1 0 0 1 1 1v3h1.5a2 2 0 1 1 0 4H17v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V17H6a1 1 0 0 1-1-1v-3H3.5a2 2 0 1 1 0-4H5V6a1 1 0 0 1 1-1h3z" />
    </svg>
  ),
  hash: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M5 9h14M4.5 15h14M10 4.5 8.5 19.5M15.5 4.5 14 19.5" />
    </svg>
  ),
  cloud: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M7 18h9.5a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6-1.3A3.6 3.6 0 0 0 7 18Z" />
    </svg>
  ),
  branch: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="17.5" cy="12" r="2.5" />
      <path d="M6.5 8v8M9 6.5h3.5a2.5 2.5 0 0 1 2.5 2.5v0M9 17.5h3.5a2.5 2.5 0 0 0 2.5-2.5v0" />
    </svg>
  ),
  phoneForwarded: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M15.5 4.5h5l-2-2M20.5 4.5l-2 2" />
      <path d="M7.5 4.5h2.2l1.2 3.2-1.7 1.4a11 11 0 0 0 5.7 5.7l1.4-1.7 3.2 1.2v2.2a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 5.5 6.7a2 2 0 0 1 2-2.2Z" />
    </svg>
  ),
  alert: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 4.5 3.2 19.5h17.6L12 4.5Z" />
      <path d="M12 10v4M12 16.8v.2" />
    </svg>
  ),
  rss: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1.5" />
    </svg>
  ),
  tag: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5L20 11l-8.5 8.5z" />
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  ),
  pen: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
      <path d="M13.5 6.5 17.5 10.5" />
    </svg>
  ),
};

/** Generic icons only; vendor glyph catalogues are intentionally not bundled. */

export function EnterpriseIcon({ name, className }: { name: string; className?: string }) {
  const map: Record<string, React.FC<IconProps>> = {
    headphones: Icons.headphones,
    handshake: Icons.handshake,
    lock: Icons.lock,
    trend: Icons.trend,
    shield: Icons.shield,
    badge: Icons.badge,
    globe: Icons.globe,
    trash: Icons.trash,
    eye: Icons.eye,
    users: Icons.users,
  };
  const C = map[name] ?? Icons.sparkles;
  return <C size={19} className={className} />;
}
