# Resend email deployment and acceptance

Voxera has an explicit Resend adapter. It sends plain-text transactional mail to
`POST https://api.resend.com/emails`, maps internal identifiers to Resend tags,
uses the durable queue message id as the provider idempotency key, and accepts
signed delivery/bounce events at:

```text
https://YOUR_PUBLIC_HOST/api/webhooks/resend
```

The generic relay mode remains available, but do not point the Resend API at
`VOXERA_EMAIL_PROVIDER=relay`: generic `metadata` is not assumed to be a Resend
field.

## 1. Provider setup

1. Create a dedicated Resend account/project for the pilot.
2. Verify a sending subdomain and complete the DNS records Resend requires. Keep
   the pilot From address on that verified domain.
3. Create a least-privilege API key and put it only in Dokploy's secret store.
4. Create a webhook for `/api/webhooks/resend` and retain its `whsec_...` signing
   secret in Dokploy.
5. Subscribe to: `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.failed`, `email.bounced`, `email.complained`, and `email.suppressed`.

Resend's signing documentation requires verification over the **raw request
body** with the `svix-id`, `svix-timestamp`, and `svix-signature` headers:
https://resend.com/docs/webhooks/verify-webhooks-requests

Resend documents at-least-once delivery and non-guaranteed ordering. Voxera stores
the signed Svix id for idempotency, gives a terminal failure precedence over a
late delivered event, and retains only minimal event metadata:
https://resend.com/docs/webhooks/create-webhook

## 2. Dokploy variables

```text
VOXERA_EMAIL_PROVIDER=resend
VOXERA_EMAIL_API_BASE=https://api.resend.com
VOXERA_EMAIL_API_KEY=<Resend API key>
VOXERA_EMAIL_FROM=Pilot Practice <appointments@verified.example>
RESEND_WEBHOOK_SECRET=<whsec_... signing secret>
```

Strict production validation refuses a partial configuration, a Resend host with
the generic adapter, a direct Resend adapter pointed at another host, or a missing
webhook secret.

## 3. Pre-live contract gate

```bash
npm run check:email-provider
```

The gate proves generic-vs-Resend payload shapes, Bearer authentication, queue
idempotency, safe tag translation, provider refusal handling, raw-body signature
verification, stale and forged signature rejection, and permanent-vs-temporary
bounce mapping. It does not contact Resend.

## 4. Controlled provider acceptance

Use fictional content and Resend's designated test addresses before real inboxes.
Resend documents `delivered@resend.dev` and `bounced@resend.dev` for predictable
events and warns against arbitrary example/test domains:
https://resend.com/docs/knowledge-base/what-email-addresses-to-use-for-testing

Retain redacted evidence for each check:

- accepted API response id is stored as the message's provider id;
- `email.delivered` changes the outreach outcome to delivered;
- `email.bounced`, `email.complained`, and `email.suppressed` mark the message
  failed; permanent recipient signals also withdraw future email consent for a
  linked client;
- forged, stale and oversized webhook requests are rejected;
- replaying the same valid `svix-id` is acknowledged once without a second state
  transition;
- invite, verification, password reset, booking confirmation and reminder arrive
  at two consented real inboxes;
- provider rejection/bounce is visible to operations and is never reported as
  successful delivery;
- SPF/DKIM/DMARC and From alignment are reviewed in the Resend/domain dashboards;
- no message contains unnecessary health data or unsupported clinical claims.

Do not mark this gate complete from a 201 API response alone. Provider acceptance
and signed delivery/bounce evidence are separate facts.
