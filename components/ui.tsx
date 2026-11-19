'use client';

import * as React from 'react';
import { cn, clamp } from '@/lib/utils';
import { Icons } from './icons';

/* -------------------------------------------------------------- reveal */

export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: any;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setTimeout(() => el.classList.add('is-in'), delay);
            io.unobserve(el);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);
  return (
    <Tag ref={ref} className={cn('reveal', className)}>
      {children}
    </Tag>
  );
}

/* -------------------------------------------------------------- section */

export function Section({
  children,
  className,
  id,
  tone = 'default',
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
  tone?: 'default' | 'panel';
}) {
  return (
    <section
      id={id}
      className={cn(
        'relative py-20 sm:py-24 lg:py-28',
        tone === 'panel' && 'border-y border-slate-900/[0.04] bg-ink-900/40',
        className
      )}
    >
      {children}
    </section>
  );
}

export function SectionHead({
  eyebrow,
  title,
  desc,
  align = 'left',
  className,
  maxWidth = 'max-w-3xl',
}: {
  eyebrow?: string;
  title: React.ReactNode;
  desc?: React.ReactNode;
  align?: 'left' | 'center';
  className?: string;
  maxWidth?: string;
}) {
  return (
    <div className={cn(maxWidth, align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <div className="eyebrow mb-4">{eyebrow}</div>}
      <h2 className="h2 text-balance">{title}</h2>
      {desc && <p className="lede mt-5 text-pretty">{desc}</p>}
    </div>
  );
}

/* -------------------------------------------------------------- buttons */

export function LinkButton({
  href,
  children,
  variant = 'primary',
  size,
  className,
  external,
  onClick,
}: {
  href: string;
  children: React.ReactNode;
  variant?: 'primary' | 'brand' | 'ghost' | 'quiet';
  size?: 'sm';
  className?: string;
  external?: boolean;
  onClick?: () => void;
}) {
  const cls = cn(
    variant === 'primary' && 'btn-primary',
    variant === 'brand' && 'btn-brand',
    variant === 'ghost' && 'btn-ghost',
    variant === 'quiet' && 'btn-quiet',
    size === 'sm' && 'btn-sm',
    className
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <a href={href} className={cls} onClick={onClick}>
      {children}
    </a>
  );
}

export function Button({
  children,
  className,
  variant = 'primary',
  size,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'brand' | 'ghost' | 'quiet' | 'danger'; size?: 'sm' }) {
  return (
    <button
      className={cn(
        variant === 'primary' && 'btn-primary',
        variant === 'brand' && 'btn-brand',
        variant === 'ghost' && 'btn-ghost',
        variant === 'quiet' && 'btn-quiet',
        variant === 'danger' && 'btn-danger',
        size === 'sm' && 'btn-sm',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------- tabs */

export function Tabs({
  tabs,
  active,
  onChange,
  className,
  size = 'md',
}: {
  tabs: { id: string; label: string; badge?: string }[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'no-scrollbar inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-slate-900/[0.035] bg-ink-850/70 p-1',
        className
      )}
    >
      {tabs.map((t) => (
        <button
          type="button"
          role="tab"
          aria-selected={active === t.id}
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            'whitespace-nowrap rounded-full font-medium transition-all duration-200',
            size === 'sm' ? 'px-3 py-1.5 text-[12px]' : 'px-4 py-2 text-[13px]',
            active === t.id ? 'bg-white text-black' : 'text-slateink-400 hover:bg-slate-900/[0.05] hover:text-slate-900'
          )}
        >
          {t.label}
          {t.badge && (
            <span
              className={cn(
                'ml-1.5 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wider',
                active === t.id ? 'bg-black/10 text-black/70' : 'bg-brand-500/15 text-brand-700'
              )}
            >
              {t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- toggles */

export function Toggle({
  checked,
  onChange,
  label,
  desc,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  desc?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2.5">
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium text-slate-900">{label}</span>
        {desc && <span className="mt-0.5 block text-[12.5px] leading-snug text-slateink-400">{desc}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-200',
          checked ? 'border-brand-500/50 bg-brand-500/80' : 'border-slate-900/[0.06] bg-slate-900/[0.06]'
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow transition-all duration-200',
            checked ? 'left-[19px]' : 'left-[2px]'
          )}
        />
      </button>
    </label>
  );
}

/* -------------------------------------------------------------- modal */

export function Modal({
  open,
  onClose,
  title,
  desc,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  desc?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    /**
     * Keyboard behaviour a dialog is expected to have: Escape closes, Tab stays
     * inside, and focus returns to whatever opened it. Without the trap, Tab
     * walks out into the page behind the overlay, which is disorienting with a
     * screen reader and unreachable-looking with a keyboard.
     */
    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !panelRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    // Move focus in on open so the dialog is what the keyboard is talking to.
    const timer = window.setTimeout(() => {
      const items = focusables();
      (items.find((el) => el.getAttribute('aria-label') === 'Close') ?? items[0])?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={desc ? descId : undefined}
        className={cn(
          'relative z-10 max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border border-slate-900/[0.035] bg-ink-850 shadow-panel sm:rounded-2xl',
          width
        )}
      >
        <div className="flex items-start justify-between gap-6 border-b border-slate-900/[0.04] p-5">
          <div>
            <h3 className="h4" id={titleId}>
              {title}
            </h3>
            {desc && <p id={descId} className="mt-1 text-[13px] text-slateink-400">{desc}</p>}
          </div>
          <button onClick={onClose} className="btn-quiet -mr-2 -mt-1 p-2" aria-label="Close">
            <Icons.close size={16} />
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-900/[0.04] p-5">{footer}</div>}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- toast */

const ToastCtx = React.createContext<(msg: string, kind?: 'success' | 'error' | 'info') => void>(() => {});
export const useToast = () => React.useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<{ id: number; msg: string; kind: string }[]>([]);
  const push = React.useCallback((msg: string, kind = 'success') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, msg, kind }]);
    setTimeout(() => setItems((s) => s.filter((i) => i.id !== id)), 3600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-6 left-1/2 z-[200] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col gap-2">
        {items.map((i) => (
          <div
            key={i.id}
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-slate-900/[0.04] bg-ink-800/95 px-4 py-3 text-[13px] text-slate-900 shadow-panel backdrop-blur animate-fade-up"
          >
            <span
              className={cn(
                'grid h-5 w-5 shrink-0 place-items-center rounded-full',
                i.kind === 'error' ? 'bg-red-500/20 text-red-700' : 'bg-brand-500/20 text-brand-700'
              )}
            >
              {i.kind === 'error' ? <Icons.close size={12} /> : <Icons.check size={12} />}
            </span>
            <span className="min-w-0 flex-1">{i.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* -------------------------------------------------------------- copy */

export function CopyButton({ value, className, label }: { value: string; className?: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
      className={cn('btn-quiet gap-1.5 text-[12px]', className)}
      title="Copy to clipboard"
    >
      {done ? <Icons.check size={14} className="text-brand-700" /> : <Icons.copy size={14} />}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

/* -------------------------------------------------------------- code block */

export function CodeBlock({
  code,
  lang = 'ts',
  filename,
  className,
  lineNumbers = false,
}: {
  code: string;
  lang?: string;
  filename?: string;
  className?: string;
  lineNumbers?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const html = React.useMemo(() => highlight(code, lang), [code, lang]);
  const lines = code.split('\n');
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-slate-900/[0.035] bg-ink-950', className)}>
      <div className="flex items-center justify-between gap-4 border-b border-slate-900/[0.04] px-3.5 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-slate-900/10" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-900/10" />
            <span className="h-2.5 w-2.5 rounded-full bg-slate-900/10" />
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-slateink-400">
            {filename ?? lang}
          </span>
        </div>
        <button
          onClick={() => {
            navigator.clipboard?.writeText(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          className="btn-quiet gap-1.5 px-2 py-1 text-[11px]"
        >
          {copied ? <Icons.check size={13} className="text-brand-700" /> : <Icons.copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="no-scrollbar overflow-x-auto p-4">
        <pre className="font-mono text-[12.5px] leading-[1.75]">
          <code className="text-slateink-300">
            {lineNumbers ? (
              <span className="flex gap-4">
                <span className="select-none text-right text-slate-900/15">
                  {lines.map((_, i) => (
                    <span key={i} className="block">
                      {i + 1}
                    </span>
                  ))}
                </span>
                <span dangerouslySetInnerHTML={{ __html: html }} />
              </span>
            ) : (
              <span dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </code>
        </pre>
      </div>
    </div>
  );
}

/* Tiny tokenizer — enough to make code look intentional without a dependency. */
function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function highlight(src: string, lang: string) {
  const kw =
    'const|let|var|await|async|function|return|import|from|export|default|new|class|extends|if|else|for|while|type|interface|as|of|in|try|catch|throw|def|print|if|elif|curl|with|not|and|or|true|false|null|undefined|None|True|False';
  let out = escapeHtml(src);
  const tokens: string[] = [];
  const stash = (html: string) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };
  // strings (single, double, backtick) and template holes
  out = out.replace(/(&quot;|&#39;|"|'|`)(?:\\.|(?!\1)[^\\\n])*\1?/g, (m) =>
    stash(`<span style="color:#9BE7C4">${m}</span>`)
  );
  // comments
  out = out.replace(/(\/\/[^\n]*|#[^\n]*)/g, (m) => stash(`<span style="color:#5A6661">${m}</span>`));
  // keywords
  out = out.replace(new RegExp(`\\b(${kw})\\b`, 'g'), (m) => stash(`<span style="color:#C77DFF">${m}</span>`));
  // numbers
  out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => stash(`<span style="color:#F2A65A">${m}</span>`));
  // punctuation / keys
  out = out.replace(/([{}\[\]()])/g, (m) => stash(`<span style="color:#7A857F">${m}</span>`));
  // property names before colon
  out = out.replace(/([A-Za-z_$][\w$]*)(\s*:)/g, (_m, k, c) => `${stash(`<span style="color:#D5DBD8">${k}</span>`)}${c}`);
  // restore
  let prev;
  let guard = 0;
  while (out.includes('\u0000') && guard++ < 12) {
    prev = out;
    out = out.replace(/\u0000(\d+)\u0000/g, (_m, i) => tokens[Number(i)]);
    if (out === prev) break;
  }
  return out;
}

/* -------------------------------------------------------------- charts */

export function Sparkline({
  data,
  className,
  color = '#2BE38B',
  height = 34,
  fill = true,
  width = 120,
}: {
  data: number[];
  className?: string;
  color?: string;
  height?: number;
  fill?: boolean;
  width?: number;
}) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const step = width / (data.length - 1 || 1);
  const pts = data.map((d, i) => [i * step, height - ((d - min) / span) * (height - 4) - 2] as const);
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${path} L${width} ${height} L0 ${height} Z`;
  const id = React.useId();
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn('w-full', className)} preserveAspectRatio="none">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function AreaChart({
  series,
  labels,
  height = 220,
  className,
  colors = ['#2BE38B', '#6EA8FE'],
  valueFormat = (v: number) => `${Math.round(v)}`,
}: {
  series: { name: string; data: number[] }[];
  labels: string[];
  height?: number;
  className?: string;
  colors?: string[];
  valueFormat?: (v: number) => string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const w = 720;
  const h = height;
  const pad = { t: 14, r: 12, b: 26, l: 46 };
  const all = series.flatMap((s) => s.data);
  const max = Math.max(...all, 1) * 1.12;
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const step = iw / Math.max(1, labels.length - 1);
  const x = (i: number) => pad.l + i * step;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const id = React.useId();
  return (
    <div className={cn('relative', className)}>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={pad.t + ih * t} y2={pad.t + ih * t} stroke="rgba(255,255,255,0.06)" />
            <text x={pad.l - 8} y={pad.t + ih * t + 4} textAnchor="end" fontSize="10" fill="#6E7873">
              {valueFormat(max * (1 - t))}
            </text>
          </g>
        ))}
        {series.map((s, si) => {
          const color = colors[si % colors.length];
          const path = s.data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
          return (
            <g key={s.name}>
              <defs>
                <linearGradient id={`${id}-${si}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`${path} L${x(s.data.length - 1)} ${pad.t + ih} L${pad.l} ${pad.t + ih} Z`} fill={`url(#${id}-${si})`} />
              <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
              {hover !== null && (
                <circle cx={x(hover)} cy={y(s.data[hover] ?? 0)} r="3.2" fill={color} stroke="#050706" strokeWidth="1.5" />
              )}
            </g>
          );
        })}
        {labels.map((l, i) => {
          if (labels.length > 12 && i % 3 !== 0) return null;
          return (
            <text key={l + i} x={x(i)} y={h - 8} textAnchor="middle" fontSize="10" fill="#6E7873">
              {l}
            </text>
          );
        })}
        {labels.map((_, i) => (
          <rect
            key={i}
            x={x(i) - step / 2}
            y={pad.t}
            width={step}
            height={ih}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-slate-900/[0.04] bg-ink-800/95 px-2.5 py-2 text-[11px] shadow-panel"
          style={{ left: `${(x(hover) / w) * 100}%`, top: 4 }}
        >
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-slateink-400">{labels[hover]}</div>
          {series.map((s, si) => (
            <div key={s.name} className="flex items-center gap-2 whitespace-nowrap">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: colors[si % colors.length] }} />
              <span className="text-slateink-300">{s.name}</span>
              <span className="tabular ml-auto font-medium text-slate-900">{valueFormat(s.data[hover] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BarChart({
  data,
  className,
  height = 180,
  color = '#2BE38B',
  horizontal = false,
}: {
  data: { label: string; value: number }[];
  className?: string;
  height?: number;
  color?: string;
  horizontal?: boolean;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  if (horizontal) {
    return (
      <div className={cn('space-y-2.5', className)}>
        {data.map((d) => (
          <div key={d.label} className="grid grid-cols-[minmax(96px,1.1fr)_2.4fr_auto] items-center gap-3">
            <span className="truncate text-[12.5px] text-slateink-300">{d.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-slate-900/[0.05]">
              <span
                className="block h-full rounded-full transition-[width] duration-700"
                style={{ width: `${(d.value / max) * 100}%`, background: color }}
              />
            </span>
            <span className="tabular text-[12px] font-medium text-slate-900">{d.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={cn('flex items-end gap-1.5', className)} style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="group relative flex flex-1 flex-col items-center justify-end gap-2">
          <span className="absolute -top-6 hidden rounded-md border border-slate-900/[0.04] bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-900 group-hover:block">
            {d.value.toLocaleString()}
          </span>
          <span
            className="w-full rounded-t-[3px] transition-colors"
            style={{ height: `${clamp((d.value / max) * 100, 2, 100)}%`, background: color, opacity: 0.75 }}
          />
          <span className="truncate font-mono text-[9.5px] text-slateink-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Donut({
  segments,
  size = 132,
  thickness = 14,
  center,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  center?: React.ReactNode;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={thickness} />
        {segments.map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle
              key={s.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      {center && <div className="absolute grid place-items-center text-center">{center}</div>}
    </div>
  );
}

export function Meter({ level, bars = 22, className }: { level: number; bars?: number; className?: string }) {
  return (
    <div className={cn('flex items-center gap-[3px]', className)}>
      {Array.from({ length: bars }).map((_, i) => {
        const active = i / bars < level;
        return (
          <span
            key={i}
            className="w-[3px] rounded-full transition-all duration-100"
            style={{
              height: `${6 + Math.sin(i * 0.7) * 4 + (active ? level * 16 : 0)}px`,
              background: active ? '#2BE38B' : 'rgba(255,255,255,0.12)',
            }}
          />
        );
      })}
    </div>
  );
}

export function LiveWave({
  active,
  bars = 28,
  className,
  color = '#2BE38B',
}: {
  active: boolean;
  bars?: number;
  className?: string;
  color?: string;
}) {
  return (
    <div className={cn('flex h-8 items-center gap-[3px]', className)}>
      {Array.from({ length: bars }).map((_, i) => (
        <span
          key={i}
          className={cn('w-[2.5px] rounded-full', active && 'animate-wave-bar')}
          style={{
            height: active ? `${18 + ((i * 7) % 14)}px` : '4px',
            background: active ? color : 'rgba(255,255,255,0.14)',
            animationDelay: `${(i % 9) * 0.08}s`,
            transition: 'height 200ms',
          }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- misc */

export function Stat({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[clamp(1.9rem,3.4vw,3rem)] font-semibold leading-none tracking-[-0.03em] text-slate-900 tabular">
        {value}
      </div>
      <div className="mt-2.5 text-[12.5px] leading-snug text-slateink-400">{label}</div>
    </div>
  );
}

/**
 * A small state label.
 *
 * `title` is worth passing whenever the label is a word somebody might have to
 * decode ("Part paid", "Overdue"): a sentence of explanation on hover costs
 * nothing and saves a support message.
 */
export function Pill({ children, tone = 'default', title }: { children: React.ReactNode; tone?: 'default' | 'brand' | 'warn' | 'danger' | 'info'; title?: string }) {
  const tones = {
    default: 'border-slate-900/[0.05] bg-slate-900/[0.04] text-slateink-300',
    brand: 'border-brand-600/30 bg-brand-500/[0.09] text-brand-800',
    warn: 'border-amber-500/30 bg-amber-400/[0.08] text-amber-800',
    danger: 'border-red-500/25 bg-red-500/[0.08] text-red-700',
    info: 'border-sky-600/30 bg-sky-500/[0.08] text-sky-800',
  } as const;
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] tracking-wide', tones[tone])}>
      {children}
    </span>
  );
}

export function Accordion({ items, className }: { items: { q: string; a: string }[]; className?: string }) {
  const [open, setOpen] = React.useState<number | null>(0);
  return (
    <div className={cn('divide-y divide-slate-900/[0.04] border-y border-slate-900/[0.045]', className)}>
      {items.map((it, i) => (
        <div key={it.q}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="flex w-full items-start justify-between gap-6 py-5 text-left transition-colors hover:text-slate-900"
          >
            <span className="text-[15.5px] font-medium text-slate-900 sm:text-base">{it.q}</span>
            <span
              className={cn(
                'mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-slate-900/[0.05] text-slateink-400 transition-transform duration-300',
                open === i && 'rotate-45 border-brand-500/40 text-brand-700'
              )}
            >
              <Icons.plus size={13} />
            </span>
          </button>
          <div
            className={cn(
              'grid overflow-hidden transition-all duration-400 ease-out',
              open === i ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            )}
          >
            <div className="overflow-hidden">
              <p className="max-w-3xl pb-6 pr-10 text-[14.5px] leading-relaxed text-slateink-400">{it.a}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon = 'sparkles',
  title,
  desc,
  action,
}: {
  icon?: keyof typeof Icons;
  title: string;
  desc?: string;
  action?: React.ReactNode;
}) {
  const C = Icons[icon] ?? Icons.sparkles;
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-slate-900/[0.04] bg-ink-900/40 px-6 py-14 text-center">
      <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl border border-slate-900/[0.035] bg-slate-900/[0.03] text-slateink-400">
        <C size={20} />
      </span>
      <h4 className="h4">{title}</h4>
      {desc && <p className="mt-2 max-w-sm text-[13px] text-slateink-400">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Progress({ value, className, color = '#2BE38B' }: { value: number; className?: string; color?: string }) {
  return (
    <span className={cn('block h-1.5 w-full overflow-hidden rounded-full bg-slate-900/[0.06]', className)}>
      <span
        className="block h-full rounded-full transition-[width] duration-700"
        style={{ width: `${clamp(value, 0, 100)}%`, background: color }}
      />
    </span>
  );
}
