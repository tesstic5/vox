'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * The command palette is loaded on demand.
 *
 * It is mounted in the root layout on every route, so importing it statically
 * would put the dialog, its keyboard handling, and the search-index fetch on the
 * critical path of every page. Deferring it costs nothing perceptible — the
 * palette is triggered by a keystroke, not by first paint — and keeps the shared
 * bundle smaller for everyone.
 */
const CommandPalette = dynamic(() => import('./CommandPalette').then((m) => m.CommandPalette), {
  ssr: false,
});

export function PaletteMount() {
  return <CommandPalette />;
}
