import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx,mdx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './content/**/*.{ts,tsx,md}',
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#05070600',
          950: '#e6ece9',
          900: '#edf2ef',
          850: '#f4f7f5',
          800: '#ffffff',
          750: '#eef3f0',
          700: '#e3eae6',
          600: '#d3ddd8',
        },
        brand: {
          50: '#E9FFF4',
          100: '#C6FEE3',
          200: '#8FFACA',
          300: '#57F2AE',
          400: '#2BE38B',
          500: '#14C877',
          600: '#0BA362',
          // Dark enough for WCAG AA as small text on selected green panels.
          700: '#087346',
          800: '#0A613E',
          900: '#084F34',
        },
        lime: {
          DEFAULT: '#D2FD45',
          soft: '#E7FFA3',
        },
        slateink: {
          // Body-muted text still clears WCAG AA on the lightest tinted panels.
          // The previous #5d6f66 missed 4.5:1 on ink-950 by a fraction and fell
          // further on selected green cards.
          400: '#56675f',
          300: '#43534c',
          200: '#22302a',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '7.5xl': ['5.25rem', { lineHeight: '1.02', letterSpacing: '-0.03em' }],
        '8.5xl': ['6.5rem', { lineHeight: '0.98', letterSpacing: '-0.035em' }],
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(43,227,139,0.25), 0 18px 60px -18px rgba(43,227,139,0.55)',
        panel: '0 1px 2px 0 rgba(16,40,30,0.05), 0 16px 40px -24px rgba(16,40,30,0.18)',
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(to bottom, rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(to right, rgba(255,255,255,0.06) 1px, transparent 1px)',
        'radial-brand': 'radial-gradient(closest-side, rgba(43,227,139,0.35), transparent)',
      },
      animation: {
        marquee: 'marquee 42s linear infinite',
        'marquee-rev': 'marquee-rev 42s linear infinite',
        'pulse-ring': 'pulse-ring 2.6s cubic-bezier(0.4,0,0.6,1) infinite',
        float: 'float 7s ease-in-out infinite',
        shimmer: 'shimmer 2.4s linear infinite',
        'wave-bar': 'wave-bar 1.1s ease-in-out infinite',
        'spin-slow': 'spin 14s linear infinite',
        'fade-up': 'fade-up 0.7s cubic-bezier(0.16,1,0.3,1) both',
      },
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        'marquee-rev': {
          '0%': { transform: 'translateX(-50%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.5)', opacity: '0' },
          '100%': { transform: 'scale(1.5)', opacity: '0' },
        },
        float: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-14px)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'wave-bar': {
          '0%,100%': { transform: 'scaleY(0.25)' },
          '50%': { transform: 'scaleY(1)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(18px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
