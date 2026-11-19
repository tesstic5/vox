# D9 + D10 — the console clean

**Status:** built, gated, verified in a browser. Nothing is running open: the app
is up on `:3000`, build `_DfPLDP4GA9j7icwZzxE7` (580/580 static pages), tsc clean,
**32/32 gates green (1291 checks, 0 failed)**, offline gate green, and the
dashboard walked route by route in a real browser — **47/47 console-clean**.

This was read as the go-ahead for the next audit item: D9 (React #418 hydration
mismatch on the dashboard) and D10 (`notificationPrefs` 404 on every load) —
the bundle the A6 read-out recommended, taken together because they were the same
symptom (a console that is never quiet) with two different causes.

---

## What was actually wrong

### D10 — a preference that never left the browser

`notificationPrefs` was in the client's mirror list, so every dashboard load wrote
it to `/api/v1/collections/notificationPrefs` — and the route's allowlist did not
contain the name, so it answered 404. The toggles on the notifications page worked
against local state and round-tripped nowhere.

### D9 — one message, two independent causes

React #418 is *"the server rendered HTML didn't match the client"*. It was firing on
every dashboard route. Chasing it needed a different method than the module-level
clock pinning that had already cleared most routes, so the method came first:

> **JS off = the server's HTML. JS on with the API blocked = the client's first
> render on its own seeds. Diff the two text trees.** Any difference *is* the
> hydrated mismatch, with no dev server involved.

That found **cause A** immediately — on `/dashboard/notifications`, `/dashboard/logs`
and `/dashboard/calls` the server wrote `38M AGO` where the browser wrote `39M AGO`,
and `just now` where the browser wrote `1m ago`. A relative label is `now − when`,
and `now` is not the same instant in the two places: any row sitting on a rounding
boundary reads differently. Freezing the browser's clock to the instant in the
page's own payload made the error vanish (1 → 0), which is what proved it.

**The fix is `components/dash/Ago.tsx`.** `useSyncExternalStore`'s third argument is
the value React uses during server rendering **and through hydration**, then it
re-renders once with the live value. So the first render reproduces the server's
string by construction — no flag to race, no warning to suppress — and every render
after it is the honest age. (Checked in the installed React, not from memory:
`react-dom/cjs/react-dom-client.production.js`, `mountSyncExternalStore` — `if
(isHydrating) getServerSnapshot = getServerSnapshot()`.) **58 call sites** across
32 files became `<Ago at={…} />`; `fmtRelative` is now documented as not-for-JSX.

Cause A cleared 14 of 15 routes and left `/dashboard`.

**Cause B, on `/dashboard` only:** the seed state has `activity: []`
(`lib/store.tsx:1206`), so the page renders a stand-in activity list whose
timestamps are recomputed **from `Date.now()` inside the render**
(`app/dashboard/page.tsx:446–451`). Minutes after the build, `Date.now()` has moved,
so each row's `at` moves with it and the *label* lands on the other side of a
minute boundary. That is also why it looked intermittent: clean when the page was
loaded right after the build, dirty four minutes later. Pinning those six timestamps
to the render instant (`pinnedNow()`) cleared it, and the same class of read was
fixed in the four other places it was live in a render path:

| where | why it was rendered text |
|---|---|
| `app/dashboard/bookings/page.tsx:131` | which side of "now" a booking falls on decides the table |
| `app/dashboard/clients/page.tsx:535` | upcoming vs past appointments in the drawer |
| `app/dashboard/team/page.tsx:63` | "12 days ago" |
| `app/dashboard/analytics/page.tsx:37`, `page.tsx:63` | the day buckets both charts are keyed by |
| `components/site/AuthFlows.tsx:1246` | days remaining on an invite |

Clock reads that only happen **after** mount (toast ids, playground latency,
creating a booking's external id) were left alone deliberately.

---

## Four pages that were broken for real, found by widening the sweep

The fifteen-route sweep was the wrong tool for the next question, so the pass was
made to walk **every** dashboard route (`scripts/console-sweep.mjs` — routes read
off the filesystem, `[id]` segments filled from the API so it can't go stale). Four
routes threw in the browser, and none of them had ever been in a sweep:

| route | what the browser said | why |
|---|---|---|
| `/dashboard/billing` | `Cannot read properties of undefined (reading 'toLocaleString')` | D10 gave `invoices` a mirror lane, and the name collides: the store's slice is the **platform's** billing invoices (platform fee, provider, telephony, concurrency lines) while the server's collection is the **practice's** money lane (subtotal, tax, paid). Practice rows went into the platform page and `money(undefined)` threw. |
| `/dashboard/keys` | `Cannot read properties of undefined (reading 'slice')` | The page renders `k.secret.slice(-4)`. Rows read back from `/api/v1/keys` have no secret — the server stores a hash and returns `last4` — so *every* server-held key crashed the page. |
| `/dashboard/tools` | `Cannot read properties of undefined (reading 'map')` | `tool.parameters.map(...)`. Tools registered against an endpoint (`{name, description, method, endpoint}`) carry no parameter schema. |
| `/dashboard/webhooks` | `Minified React error #31 … object with keys {at, status…}` | The delivery's `attempts` is a **list of tries**, and the table rendered it as a child. The list is also the useful part: each try carries its failure reason. |

Fixes, all in the same spirit — a page renders what the row actually holds:

- **`invoices` is no longer mirrored** (`lib/server-sync.tsx`), with the reasoning
  written down above the list. The practice lane is served by `/api/v1/invoices`,
  which `/dashboard/money` already uses; the platform lane is owned by the store.
- `ApiKey` and `ToolDefinition` types gained the server's shape (`last4`, `scopes`,
  `lastUsedAt`, `endpoint`) so tsc flags the next page that assumes a field.
  `secret` is now optional — and that is how the keys page revealed a **second**
  bug: the "copy your key now" modal was showing `k.secret` from the *placeholder*
  row (empty string), because the real secret only arrives when the server answers.
  It now holds the row id and reads the secret back out of the store.
- Keys page: `prefix •••••••• last4`, the scope the row declares (or the
  capabilities the server recorded), and a copy button that says *why* it can't copy
  a secret it doesn't have instead of copying a blank.
- Tools page: kinds and parameters are read defensively, and a schema-less tool says
  so in the table instead of crashing the page.
- Webhooks page: the attempts cell shows the count, and the last try's error is
  printed under the status — e.g. `blocked by URL policy: 0.0.0.0 is a private or
  loopback address`, which is a guard working, not noise.

---

## How it's held

- **`scripts/console-sweep.mjs`** *(new)* — every dashboard route, one browser, fails
  on any console error or uncaught error. 47/47 today. It is the tool that found the
  four pages above, and it is the only one that can: they were green in every API
  gate.
- **`scripts/day-ui-pass.mjs`** — the sweep now reads **uncaught errors as well as
  console errors** (React #418 is *thrown*; a 404 is *logged*), covers 15 routes
  instead of 5, and its bogus `/dashboard/phone` entry is gone — that route never
  existed, so its "clean" readings had been a 404 page with no hydration error.
  39/39 today.
- **`scripts/mirror_check.py`** (gate #13 of 32) — 32 checks; the mirror list is read
  out of the client's source, so it cannot drift. Hardened while fixing it here: it
  now strips comments before reading names, because a note inside the array literal
  ("why `invoices` is not mirrored") made it ask the server for a collection called
  `s slice is the platform`.

## Evidence

| what | result |
|---|---|
| prod hydration sweep, 15 routes (`diag5`) | `al5JCAhokvWriMQ4kXRvV` → 13/15 · `i3WthgOnduOXUbeFDrHzN` → 12/15 · `33j6Q7YgAcsaVowDiwH2w` → 7/15 (the abandoned `—` attempt) · `R9C32vS_k5IRQsUMH5UHc` → 14/15 (Ago) · **`_DfPLDP4GA9j7icwZzxE7` → 15/15** |
| dashboard console sweep, 47 routes | **47/47 clean** · `screenshots/dashboard-console-sweep.json` |
| day-view browser pass | **39/39** · `screenshots/a6-my-day-browser-pass.json` |
| full suite | **32 gates, 1291 checks, 0 failed** · `CHECK-RUN-2026-10-16-D9-D10.txt` |
| offline gate (app stopped) | 1 gate, 8 checks, 0 failed |
| `mirror_check.py`, D10 | 32 checks — names, settings round-trip, empty-`append` row lane (13 → 13), no server-owned slice mirrored |
| `npx tsc --noEmit` | clean, unpiped |

## What I checked and found fine

- **The seeded value itself was never the problem.** Server and client agree on
  every seeds-derived number after pinning; the residual mismatches were label
  rounding and one list of stand-in timestamps.
- **The final DOM equals the server's HTML** on the routes that were still dirty —
  byte-identical text trees, identical element sequence, identical attributes apart
  from CSS float serialisation. That is why the cause had to be *transient*, and why
  a diff of the settled page could never have found it. Recorded here so nobody
  repeats the search.
- **`useSyncExternalStore` is the right primitive, verified in the installed React**
  rather than assumed.
- **The mirror lane itself was sound**: settings round-trip byte-for-byte, unknown
  names still 404, and the row lane writes without emptying a collection.
- **The demo data survived** the whole segment: the 13 `tools` rows restored earlier
  are still there (the 18 rows now include 5 in the scratch workspace, which tidy
  leaves alone by design).

## What did not work, and should not be retried

- **A module-level "labels are live" flag** (`fmtRelative` returning `—` until
  mount). It made things *worse* — 8 routes dirty instead of 3 — because React can
  finish hydrating in pieces, so a subtree that hydrates late renders after the flag
  has flipped. Per-component state is what holds.
- **The dev server.** Fourth attempt, fourth death on this box (this time while
  compiling `/api/bootstrap`, with 1.3 GB and the app stopped). The production build
  plus a browser is the only diagnosis rig here.
- **The API-blocked first-render diff, on its own.** It found cause A and completely
  hid cause B, because with the API blocked the page keeps rendering its stand-in
  list. The live sweep is the check that has to go with it.
- **Guessing at chunk/Suspense timing.** Chunk preloads, warm caches and a
  deliberately blocked main thread all left the error at exactly 1; it was a clock
  read in a render, six lines of JSX.

## Left open, unchanged

`days:1` returning two rows · desk `send` with the rule off · `templates?kind=recall`
· the Replies tab · D1 never walked in a browser. A4 remains unbuilt; **A8 stays
unauthorised**.

## Files

**New** — `components/dash/Ago.tsx` · `scripts/console-sweep.mjs` ·
`CHECK-RUN-2026-10-16-D9-D10.txt` · `screenshots/dashboard-console-sweep.json`.

**Changed** — `lib/utils.ts` (`fmtRelative` takes a real instant; `labelNow()` is the
render instant; `pinLabelClock`) · `lib/store.tsx` (pins the label clock in
`buildInitial`, never releases it) · 32 pages/components converted to `<Ago>`
· `lib/server-sync.tsx` (18 mirrored row slices; `invoices` deliberately absent, with
the reason in the file) · `app/api/v1/collections/[name]/route.ts` (D10, allowlist)
· `lib/types.ts` (both row shapes) · `app/dashboard/{keys,tools,webhooks,billing,
bookings,clients,team,analytics}/page.tsx` · `components/{dash/Shell,site/AuthFlows}.tsx`
· `scripts/{mirror_check.py,day-ui-pass.mjs}`.

**Deleted** — `diag3.mjs` … `diag19.mjs` (seventeen diagnosis scripts; the method is
written down above instead).
