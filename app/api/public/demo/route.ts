import { NextResponse, type NextRequest } from 'next/server';
import { insert, insertMany, list, newId, nowIso, update, type Doc } from '@/lib/server/db';
import { createCall } from '@/lib/server/calls';
import { find } from '@/lib/server/db';
import { clientIp } from '@/lib/server/api';
import { demoToken } from '@/lib/server/demo-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The public demo line.
 *
 * The marketing site's call demo has to work before anyone signs up — that is
 * the whole point of it — so this opens a real call record against a demo
 * workspace, with no session, and hands back a short-lived signed token scoped
 * to that one call. It is rate limited per IP; demo records, including the
 * visitor IP and transcript, become eligible for deletion after one hour and
 * are removed by the next maintenance sweep.
 */
const DEMO_EMAIL = 'demo@voxera.ai';
const RATE_LIMIT = 20; // calls per hour per IP
const WINDOW_MS = 60 * 60 * 1000;

function demoOrg() {
  let org = find<Doc & { id: string; slug?: string }>('orgs', (o) => o.slug === 'voxera-demo');
  if (org) return org;
  let user = find<Doc & { id: string; email: string; orgId: string }>('users', (u) => u.email === DEMO_EMAIL);
  if (!user) {
    user = insert<Doc & { id: string; email: string; orgId: string }>('users', {
      id: `usr_${newId('').slice(1, 13)}`,
      email: DEMO_EMAIL,
      name: 'Public demo',
      passwordHash: 'disabled',
      orgId: 'pending',
      role: 'owner',
      emailVerified: true,
      twoFactorEnabled: false,
      createdAt: nowIso(),
    } as Doc & { id: string; email: string; orgId: string });
  }
  org = insert<Doc & { id: string; slug?: string }>('orgs', {
    id: `org_${newId('').slice(1, 13)}`,
    name: 'Voxera demo line',
    slug: 'voxera-demo',
    plan: 'build',
    region: 'us-east-1',
    createdAt: nowIso(),
  } as Doc & { id: string; slug?: string });
  user.orgId = String(org.id);
  void list<Doc>('assistants', (a) => a.orgId === org!.id);
  return org;
}

function demoAssistants(orgId: string) {
  let assistants = list<Doc & { status?: string; name?: string }>('assistants', (a) => a.orgId === orgId);
  if (assistants.length) {
    // These records persist between runs, so repair older seeded copy rather than
    // allowing retired pricing or retention wording to survive indefinitely.
    for (const assistant of assistants) {
      const support = String(assistant.name).toLowerCase().includes('support');
      update('assistants', assistant.id, {
        firstMessage: support
          ? 'Hi — this is a browser demo using fictional records. I can demonstrate an order lookup, refund request, appointment request or hand-off. What would you like to try?'
          : 'Hi — this is a browser demo using fictional availability. Which day would you like to try?',
        systemPrompt: support
          ? 'You are the public Voxera browser demo. Be brief. State that every order, refund, appointment and transfer is fictional and no real provider action occurs.'
          : 'You are the public Voxera booking demo. Offer fictional slots, stay brief, and state that no real appointment or provider action occurs.',
        knowledge: ['This is a browser assistant test. Its records, tool results and actions are fictional.', 'The demo call, visitor IP and transcript become eligible for deletion after one hour and are removed by the next maintenance sweep.'],
        model: '',
        provider: 'rules',
        voiceId: '',
        updatedAt: nowIso(),
      } as never);
    }
    return list<Doc & { status?: string; name?: string }>('assistants', (a) => a.orgId === orgId);
  }

  assistants = insertMany<Doc & { status?: string }>('assistants', [
    {
      id: `asst_${newId('').slice(1, 13)}`,
      orgId,
      name: 'Demo support agent',
      firstMessage:
        'Hi — this is a browser demo using fictional records. I can demonstrate an order lookup, refund request, appointment request or hand-off. What would you like to try?',
      systemPrompt:
        'You are the public Voxera browser demo. Be brief. State that every order, refund, appointment and transfer is fictional and no real provider action occurs.',
      model: '',
      provider: 'rules',
      voiceId: '',
      temperature: 0.5,
      transcriber: 'browser-speech',
      language: 'en-US',
      tools: ['lookup_order', 'issue_refund', 'transfer_call'],
      knowledge: [
        'This is a browser assistant test. Its records, tool results and actions are fictional.',
        'The demo call, visitor IP and transcript become eligible for deletion after one hour and are removed by the next maintenance sweep.',
      ],
      status: 'published',
      template: 'support-concierge',
      calls: 0,
      minutes: 0,
      containment: 0,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: `asst_${newId('').slice(1, 13)}`,
      orgId,
      name: 'Demo booking agent',
      firstMessage: 'Hi — this is a browser demo using fictional availability. Which day would you like to try?',
      systemPrompt: 'You are the public Voxera booking demo. Offer fictional slots, stay brief, and state that no real appointment or provider action occurs.',
      model: '',
      provider: 'rules',
      voiceId: '',
      temperature: 0.4,
      transcriber: 'browser-speech',
      language: 'en-US',
      tools: ['check_availability', 'book_appointment'],
      knowledge: ['Demo appointments are fictional and last 20 minutes.'],
      status: 'published',
      template: 'appointment-booking',
      calls: 0,
      minutes: 0,
      containment: 0,
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ] as (Doc & { status?: string })[]);

  // The demo needs the tool definitions the assistants reference.
  const existingTools = list<Doc>('tools', (t) => t.orgId === orgId);
  if (!existingTools.length) {
    insertMany<Doc>('tools', [
      { id: `tool_${newId('').slice(1, 9)}`, orgId, name: 'lookup_order', description: 'Look up an order', method: 'GET', endpoint: 'https://api.example.com/orders/{id}', createdAt: nowIso() },
      { id: `tool_${newId('').slice(1, 9)}`, orgId, name: 'issue_refund', description: 'Refund an order', method: 'POST', endpoint: 'https://api.example.com/refunds', createdAt: nowIso() },
      { id: `tool_${newId('').slice(1, 9)}`, orgId, name: 'transfer_call', description: 'Transfer to a human', method: 'POST', endpoint: 'https://api.example.com/transfer', createdAt: nowIso() },
      { id: `tool_${newId('').slice(1, 9)}`, orgId, name: 'check_availability', description: 'Read calendar availability', method: 'GET', endpoint: 'https://api.example.com/availability', createdAt: nowIso() },
      { id: `tool_${newId('').slice(1, 9)}`, orgId, name: 'book_appointment', description: 'Book a slot', method: 'POST', endpoint: 'https://api.example.com/bookings', createdAt: nowIso() },
    ] as Doc[]);
  }
  return assistants;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const since = Date.now() - WINDOW_MS;
  const recent = list<Doc & { ip?: string; at?: string }>('demoCalls', (c) => c.ip === ip && new Date(String(c.at)).getTime() > since);
  if (recent.length >= RATE_LIMIT) {
    return NextResponse.json(
      {
        error: {
          type: 'rate_limit_error',
          code: 'RATE_LIMITED',
          message: `This demo allows ${RATE_LIMIT} calls an hour per address. Create a free workspace to keep going.`,
          request_id: `req_${newId('').slice(1, 15)}`,
        },
      },
      { status: 429, headers: { 'retry-after': '600' } }
    );
  }

  const body = (await req.json().catch(() => ({}))) as { agent?: string; assistantId?: string };
  const org = demoOrg();
  const assistants = demoAssistants(String(org.id));
  const chosen =
    (body.assistantId && assistants.find((a) => a.id === body.assistantId)) ||
    assistants.find((a) => (body.agent ? String(a.name).toLowerCase().includes(body.agent.toLowerCase()) : false)) ||
    assistants[0];

  const { call, error } = createCall({
    orgId: String(org.id),
    assistantId: String(chosen.id),
    type: 'web',
    from: 'Public demo',
    to: String(chosen.name),
    customer: { name: 'Website visitor', number: ip },
    source: 'demo',
  });
  if (error || !call) {
    return NextResponse.json({ error: { type: 'api_error', code: 'INTERNAL_ERROR', message: error ?? 'could not start the call' } }, { status: 500 });
  }

  insert<Doc>('demoCalls', { id: newId('dc_'), ip, callId: call.id, at: nowIso(), orgId: String(org.id) } as Doc);

  // Short-lived token: this call, nothing else. Verified on every turn.
  const expires = Date.now() + 30 * 60 * 1000;
  const token = demoToken(call.id, expires);

  return NextResponse.json(
    {
      callId: call.id,
      token: `${expires}.${token}`,
      transport: 'sse',
      turnUrl: `/api/public/demo/${call.id}/turn`,
      assistant: {
        id: chosen.id,
        name: chosen.name,
        firstMessage: chosen.firstMessage,
        voice: chosen.voiceId,
        model: chosen.model,
        tools: chosen.tools,
      },
      retention: 'The demo record becomes eligible for deletion after one hour and is removed by the next scheduled maintenance sweep.',
      remaining: RATE_LIMIT - recent.length - 1,
    },
    { status: 201 }
  );
}

export async function GET() {
  const org = demoOrg();
  const assistants = demoAssistants(String(org.id));
  return NextResponse.json({
    object: 'list',
    data: assistants.map((a) => ({ id: a.id, name: a.name, firstMessage: a.firstMessage, voice: a.voiceId })),
    note: 'POST here to start a demo call without an account.',
  });
}
