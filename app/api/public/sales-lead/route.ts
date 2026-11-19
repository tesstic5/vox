import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, fail, ok, readJson } from '@/lib/server/api';
import { sendAuthEmail, emailRelayConfigured } from '@/lib/server/auth-mail';
import { createLead, validateLead } from '@/lib/server/leads';
import { rateLimit } from '@/lib/server/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/public/sales-lead — the "Contact sales" form, for real.
 *
 * This used to not exist: the form showed a thank-you and stored nothing,
 * so every enquiry was lost. Now the submission is validated, rate
 * limited per IP (it is a public, unauthenticated endpoint — the same
 * treatment the public booking page gets), stored as a lead the sales
 * inbox can work, and, when an operator inbox is configured and the mail
 * relay is up, emailed there. The email is best-effort on purpose: a
 * mail outage must not lose the lead, which is safe in the store either
 * way. A honeypot field keeps the simplest bots out without a captcha.
 */
export async function POST(req: NextRequest) {
  const limit = rateLimit(`sales-lead:${clientIp(req)}`, 10, 60 * 60 * 1000);
  if (!limit.allowed) {
    return fail('RATE_LIMITED', 'Too many enquiries from this address. Try again in a little while.', {
      requestId: 'sales-lead',
      headers: { 'retry-after': String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))) },
    });
  }

  const body = await readJson<Record<string, unknown>>(req);
  if (body instanceof NextResponse) return body;

  // Honeypot: a field the real form renders hidden and empty. Anything
  // filled in is a bot; answer as if it worked and store nothing.
  if (String(body.website ?? '').trim()) return ok({ received: true }, { requestId: 'sales-lead', status: 201 });

  const valid = validateLead(body);
  if (!valid.ok) return fail('VALIDATION_ERROR', valid.error, { param: valid.param, requestId: 'sales-lead' });

  const lead = createLead(valid.value);

  const notify = process.env.VOXERA_SALES_NOTIFY_EMAIL;
  if (notify && emailRelayConfigured()) {
    void sendAuthEmail({
      to: notify,
      subject: `New sales enquiry — ${lead.company} (${lead.name})`,
      text: [
        `${lead.name} · ${lead.company}${lead.role ? ` · ${lead.role}` : ''}`,
        `${lead.email}${lead.phone ? ` · ${lead.phone}` : ''}`,
        lead.goal ? `Goal: ${lead.goal}` : '',
        lead.volume ? `Volume: ${lead.volume}` : '',
        lead.timeline ? `Timeline: ${lead.timeline}` : '',
        lead.requirements?.length ? `Requirements: ${lead.requirements.join(', ')}` : '',
        lead.notes ? `\n${lead.notes}` : '',
        `\nLead ${lead.id} — work it in the dashboard under Leads.`,
      ]
        .filter(Boolean)
        .join('\n'),
    }).catch(() => undefined);
  }

  return ok({ received: true, id: lead.id }, { status: 201 });
}
