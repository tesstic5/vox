# D3 — real sign-in, real recovery, real invitations

**Date:** 2026-10-15 · **Gate:** `scripts/auth_check.py` — **101 checks, 0 failures**, three consecutive runs against the production build in the tree.

The audit said four screens were theatre: no API calls, a hard-coded `rt_9f42c1ab` offered as a "reset link", an `/invite/inv_7c2f91ab` advertised on the login page, and a verify screen that accepted any six digits, said *"Email verified. 60 free minutes added."* and changed nothing. It also noted that nothing anywhere gated on `emailVerified` — while three screens printed the sentence *"an unverified account can build agents but cannot publish or provision a number."* Both halves are fixed: the flows are real, and the sentence is true.

## What was authorised

Your three answers, which set the shape:

1. **Scope — all five flows.** Password reset (request + confirm), magic link, the six-digit verify code, and invitations on server-side tokens. *"The whole of D3, leaves nothing theatre."*
2. **Verification — "make it true."** Gate publishing and number provisioning on `emailVerified`, accept that gates which sign up and then provision will break, and fix them.
3. **Invitations — a real emailed link.** Seven days, single-use, revocable, opening it sets name and password and signs the person in — **and keep the one-time password** as the read-it-out-over-the-phone fallback.

## What was built

| Piece | Where | What it does |
|---|---|---|
| Token store | `lib/server/auth-tokens.ts` | Mint / peek / redeem / revoke, hash-at-rest, per-kind prefixes (`rt_ ml_ ev_ inv_`), TTLs, code checking with attempts and a lock |
| Mail | `lib/server/auth-mail.ts` | `emailRelayConfigured`, `sendAuthEmail`, `publicBase` — the existing relay (`VOXERA_EMAIL_API_BASE`), not the message queue |
| Decisions + copy | `lib/server/auth-flows.ts` | Every branch the routes need: who gets mail, what the answer is, what the sentence says, `pendingInvites`, `revokeInvites`, `declineInvite` |
| Routes | `app/api/auth/password/{request,state,reset}`, `magic/{request,state,consume}`, `verify` + `verify/confirm`, `invite/{state,accept,decline}` | Eleven handlers, all real |
| The gate | `lib/server/api.ts` | `requireVerifiedEmail` + its own error code, on publish, number purchase, number import and API keys |
| Identity | `lib/server/auth.ts` | `setUserPassword` (revokes sessions), `markEmailVerified` |
| Screens | `components/site/AuthFlows.tsx` and the `/reset-password`, `/magic-link`, `/verify-email`, `/invite/<token>` pages | Every panel wired to those routes; the fake-token CTA and the client-store invitation are gone (`components/site/InviteAcceptClient.tsx` deleted) |
| Where the person lands | `components/dash/Shell.tsx`, `OnboardingWizard.tsx`, `app/dashboard/team/page.tsx` | An amber "verify your email" banner, an unverified panel in the wizard, invitations readable in Team → Invitations |

## The contract, exactly

- **Reset request** — `POST /api/auth/password/request` answers `{requested:true,expiresInMinutes:15,email}` **for a known and an unknown address alike**, and never puts a token in the body. The token goes to the inbox.
- **Reset confirm** — `POST /api/auth/password/reset` takes `{token,password}`; the answer is `{reset:true,sessionsEnded:N,session}`, and a session taken *before* the reset is dead (`401` on `/api/v1/clients`, proved). Old password `401`, new password `200`. Replay → `409` *"already been used"*.
- **Magic link** — `state` is a read and does not consume (asked twice, still valid); `consume` is a `POST` that signs you in; replay → `409`.
- **Verify code** — `POST /api/auth/verify` → `{sent:true,expiresAt,attemptsLeft:5}`. A wrong code: *"That code is not right. 4 attempts left before it locks for an hour."* The fifth: *"locked for an hour"*. Asking for a new code while locked → `409`, and the lock is **not** cleared by re-sending. The right code answers `{verified:true,unlocks:["publish an assistant","buy a phone number","create API keys"]}`; a verified account gets `{alreadyVerified:true}` and no mail.
- **Invitations** — `state` returns `{valid,email,org,inviter,role}` from the token; `accept` answers `201`, signs the person in, sets their name and password and marks the address verified (they just proved they can read it); replay → `409`; `decline` → reason `revoked`. **The role comes from the invitation, never from the invitee.** An 8-character minimum is enforced *before* a token is spent.
- **Enumeration** — the only public read that names a person is `invite/state`, which is exactly what the token holder is entitled to see. Reset and magic-link requests are indistinguishable between known and unknown addresses, and no mail is sent for unknown ones.
- **The record** — `auth.reset_requested`, `auth.password_reset`, `auth.magic_link_requested`, `auth.magic_link_used`, `auth.verification_sent`, `auth.email_verified`, `team.invite_sent`, `team.invite_accepted`, `team.invite_declined`.

## Stories the gate proves end to end

`scripts/auth_check.py` runs six blocks against the live app, using the stub relay's own inbox (`GET :4010/__state`) to read what was actually emailed:

1. **Invitations** — invite → the mail carries an `/invite/` link naming the workspace → the screen reads it → a short password is refused → accept joins and signs in as themselves, verified, with the invited role → the one-time password stops working → the link works exactly once.
2. **Password reset** — request → mail → the confirm screen → short password refused → accepted → a session from before is signed out → the browser doing the reset gets a fresh one → new password works, old one does not → the link cannot be used twice.
3. **Magic link** — request → mail → state reads twice without spending → pressing the button signs in as the right person → the link cannot be used twice.
4. **Verify lock** — a new account starts unverified → the screen reads its own state → a code is sent and reaches the inbox → a wrong code reports the attempts left → the fifth wrong guess locks it → re-sending cannot clear the counter → even the right code is refused while locked.
5. **What verification gates** — drafting an agent still works unverified, **publishing is refused**, **buying a number is refused**, **creating a key is refused**, everything ungated still works, the code verifies, and publishing and keys work the moment it does.
6. **The seeded workspace, the trail, the screens** — the demo owner signs in verified, all nine audit actions appear, every auth screen renders, the old hard-coded invitation link still renders but **is genuinely not valid**, and no screen offers a demo link that skips a flow.

## Rate limits, and why they sit where they do

| Endpoint | Limit | Why |
|---|---|---|
| reset / magic **request**, per address | 3 / 15 min, answering exactly like success | Stops one address being mail-bombed without telling an attacker which addresses exist |
| reset / magic **request**, per address-IP | 15 / 15 min, honest `429` | A flood guard. Deliberately wider: a practice behind one office connection is a dozen people, not one |
| reset / magic **consume**, per IP | 60 / 15 min | The magic link is clicked from mail clients, tablets and phones; a tight IP cap here hurts only honest people |
| reset / magic **consume**, per **token** | 5 / 15 min, key hashed | Guessing is bounded at the place the secret actually is |
| verify **send** / **confirm**, per account | 10 / **60** per 15 min | The five-wrong-code lock is the real budget; these only stop a script burning through it |
| signup, per IP | 15 / 10 min | Was 5, which a run of the gate tripped on its own |
| sign-in, per IP | 10 / min | Unchanged |

Two consequences worth stating plainly. **A rate limiter is part of the product's behaviour**, so the consume endpoints are limited per token rather than per office: the token is what an attacker would have to guess. And a limiter bucket is a database row, so the **key is `sha256(token)`, never the token** — a credential must not be readable from the table that throttles it.

## Three decisions worth flagging

1. **The seeded owner is verified.** `ensureDemoOwnerVerified` (called from `/api/bootstrap` and the OAuth fallback) marks the demo Northwind owner verified, exactly as the seeded des<span></span>k account already was. A seeded fixture is not a signup, and without this the demo workspace could no longer publish or buy a number — which would have been a regression dressed up as security. Real signups still start unverified, and the gate proves it.
2. **The sixty free minutes stay a signup grant.** Signup already grants `balanceMinutes: 60`, and every marketing page ties the promise to signup. So verification does not mint a second sixty: it unlocks **publishing, numbers and API keys**, which is what the screens now say it does.
3. **The gate takes a client address of its own per run.** Every limiter here is per address, so back-to-back runs used to fail on a warm bucket rather than on the product — which is indistinguishable from a real failure in a transcript. Each run now uses a fresh `x-forwarded-for` (`198.51.100.<n>`), so a `429` in the output means something.

## Who else had to change, and why

The verification gate is enforced, so the gates that sign up and then provision had to be fixed rather than exempted:

- `scripts/onboard_check.py` gained a verification step — the fresh workspace is refused at publish and at number purchase, is emailed a code, and proceeds the moment the code is accepted (+7 checks).
- `scripts/api_check.py` rate-limit probes were pinned to two fixed addresses and sized for the old caps, so they measured the *previous* run. They now use a per-run address and spend enough to earn the `429`.
- The old `/invite/inv_7c2f91ab` link is client-rendered, so it cannot be asserted from its HTML — the gate asserts that it renders and then tests the token at `/api/auth/invite/state`, where it is genuinely invalid.

## Verification

- `scripts/auth_check.py` — **101 PASS / 0 FAIL**, three runs, including two back-to-back.
- `scripts/onboard_check.py` — **ALL PASS**, verification gate included.
- The rest of the suite green on this build: manage 31 · practice, team, reports, money, notes · messaging, booking, client, api, carrier · book, ai, smoke, report_tool · demo, guard, privacy, race, nesting (521 pages), linkcheck (521 routes, 0 unresolvable), sitemap, media.
- **Suite total: 789 before D3 → 897 now** (the auth gate's 101 plus the onboarding gate's 7), 0 failures.
- `scripts/tidy-probe-orgs.ts --apply` swept what the probes left: 14 probe workspaces, 38 probe logins, 57 auth tokens, 71 probe clients, 48 appointments and 80 abandoned calls. Backup: `data/backups/voxera-db.before-tidy-2026-10-15T12-58-16-812Z.json`. The database now holds the two seeded workspaces and three seeded identities, all verified.

## Still open (not authorised, unchanged by this work)

**D4** no receipt on payment · **D5** no overdue chase job · **D6** `matchWaitList` only a toast · **D7** one `recallDays` for the whole practice · **D8** docs stop at P4 and no single `npm run check`; **A2–A9**; the A1 provider-mismatch bug; the messaging Replies tab with a real reply; D1 seen in a real browser (it is proved by `scripts/manage_check.py`, not by a person dragging a block).
