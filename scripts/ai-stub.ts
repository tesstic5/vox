/**
 * A stand-in for a model provider.
 *
 * Speaks both wire formats the platform uses — Anthropic's Messages API and the
 * OpenAI chat-completions shape — so the whole AI path can be tested end to end
 * without an API key: key verification, streaming deltas, tool calls, tool
 * results coming back, and the fallback when a provider errors.
 *
 *   tsx scripts/ai-stub.ts                       # listens on 4020
 *   ANTHROPIC_API_BASE=http://127.0.0.1:4020 ANTHROPIC_API_KEY=stub-anthropic-key npm start
 *
 * It is a *scripted* model, not a smart one: it books an appointment when the
 * caller names a day and time, looks up an order when asked about one, and
 * otherwise answers briefly. That is deliberate — the point is to prove the
 * plumbing (tools, streaming, accounting), and a scripted brain makes the test
 * assertable instead of probabilistic.
 */

import { createServer, type ServerResponse } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 4020);
const GOOD_KEYS = new Set((process.env.STUB_AI_KEYS ?? 'stub-anthropic-key,stub-openai-key,sk-ant-stub-0123456789,sk-stub-0123456789').split(','));
/** Set STUB_AI_FAIL=1 to make every completion fail, for the fallback test. */
const FAIL = process.env.STUB_AI_FAIL === '1';

type Turn = { role: string; content: unknown };

function sse(res: ServerResponse, frames: [string, unknown][]) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const [event, data] of frames) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  res.write('event: message_stop\ndata: {}\n\n');
  res.end();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string; content?: unknown };
        if (p.type === 'text') return p.text ?? '';
        if (p.type === 'tool_result') return `[tool result] ${typeof p.content === 'string' ? p.content : JSON.stringify(p.content)}`;
        return '';
      })
      .join(' ');
  }
  return '';
}

/** What the scripted model decides to do with one caller turn. */
type Decision = {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  toolResultsIn?: number;
};

function decide(messages: Turn[]): Decision {
  // A tool result looks different per wire: the Messages API hands it back as a
  // user message containing a `tool_result` part, the chat-completions API as a
  // message with role "tool". Only the *latest* message matters here. Looking for
  // any historical result makes every later caller turn skip tools forever.
  const latest = messages.at(-1);
  const latestIsToolResult = latest?.role === 'tool' || textOf(latest?.content ?? '').includes('[tool result]');
  const toolResults = messages.filter((m) => m.role === 'tool' || textOf(m.content).includes('[tool result]'));
  const userTurns = messages.filter((m) => m.role === 'user' && !textOf(m.content).includes('[tool result]'));
  const lastUser = userTurns.at(-1);
  const said = textOf(lastUser?.content ?? '').toLowerCase();
  const priorUserSaid = userTurns
    .slice(0, -1)
    .reverse()
    .map((m) => textOf(m.content).toLowerCase())
    .join(' ');

  // Current caller words win. Provider requests also carry a system prompt, and
  // harvesting the first date/time from the entire request can turn an unrelated
  // "text my confirmation" or report question into a reschedule.
  const dateFrom = (text: string) =>
    /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ??
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today)/.exec(text)?.[1];
  const timeFrom = (text: string) => /(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})/.exec(text)?.[1];
  const day = dateFrom(said) ?? dateFrom(priorUserSaid);
  const time = timeFrom(said) ?? timeFrom(priorUserSaid);

  // A site the caller names ("at the East clinic") is handed over as an argument,
  // the way a real model would. It matters only on the hosted path: the running
  // demo's assistants answer from the rules engine, where the *sentence* is the
  // source of the site (`siteFromText` in booking-tools) because the tool
  // arguments are built from the extracted slots, not from a model's tool call.
  const site = /\b(east|hq)\b/.test(said) ? (/\beast\b/.test(said) ? 'east' : 'hq') : undefined;

  // The provider calls us again with the tool result appended. Speak from that
  // result rather than using a canned success line: this is what proves a model
  // cannot turn a refusal into "all set" or invent a diary slot/report figure.
  if (latestIsToolResult) {
    const raw = textOf(latest?.content ?? '').replace(/^\[tool result\]\s*/, '');
    let result: Record<string, unknown> = {};
    try {
      result = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // A malformed test-provider result is still handled as words, never as a
      // made-up success.
    }
    const slots = Array.isArray(result.slots) ? result.slots.map(String) : [];
    const spoken =
      (typeof result.summary === 'string' && result.summary) ||
      (slots.length ? `I can offer ${slots.slice(0, 2).join(' or ')}.` : '') ||
      (typeof result.appointment === 'string' && result.appointment) ||
      (typeof result.note === 'string' && result.note) ||
      (typeof result.reason === 'string' && result.reason) ||
      (typeof result.message === 'string' && result.message) ||
      'I have checked the live record. Is there anything else I can help with?';
    return { text: spoken, toolResultsIn: toolResults.length };
  }

  if (/(cancel|call it off|not coming)/.test(said)) {
    return { tool: { name: 'cancel_appointment', args: { date: day ?? 'the booked day', reason: 'caller asked to cancel' } } };
  }

  // Specific current-turn intentions come before generic booking words. A prompt
  // and an old transcript naturally contain dates, times and "book"; those are
  // context, not the caller's intent on this turn.
  if (
    /(how (?:did|are|was|were) we|how busy|no-?show|no-?shows|revenue|takings|what did we bill|our (?:numbers|figures|appointments|bookings|diary)|how (?:many|much) (?:did|have) we|utilisation|utilization|who earns|where did (?:our )?bookings come from|who is overdue|recall|calls? did we handle)/.test(
      said
    )
  ) {
    return { tool: { name: 'practice_report', args: {} } };
  }
  if (/(how much .*\bowe\b|what .*\bowe\b|balance|amount due|pay it now|payment status)/.test(said)) {
    return { tool: { name: 'payment_status', args: {} } };
  }
  if (/(order|parcel|delivery|arrive|where is it)/.test(said)) {
    return { tool: { name: 'lookup_order', args: {} } };
  }
  if (/(text|sms|message|email|e-mail|confirmation|write (?:that|it) down)/.test(said)) {
    return { tool: { name: 'send_confirmation', args: { channel: 'sms' } } };
  }
  if (/(refund|money back)/.test(said)) {
    return { tool: { name: 'issue_refund', args: { orderId: 'NW-7293', reason: 'requested by caller' } } };
  }
  if (/(human|person|agent|manager)/.test(said)) {
    return { tool: { name: 'transfer_call', args: { department: 'support', reason: 'caller asked for a person' } } };
  }
  if (day && time && /(book|reschedule|move|change|make it|instead)/.test(said)) {
    return { tool: { name: 'reschedule_appointment', args: { date: day, time, ...(site ? { site } : {}) } } };
  }
  if (day && /(book|reschedule|appointment|available|availability|slot)/.test(said)) {
    return { tool: { name: 'check_availability', args: { date: day, ...(site ? { site } : {}) } } };
  }
  return { text: 'I can help with that — could you tell me a little more about what you need?' };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c as Buffer));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    const key = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
    const provider = url.pathname.includes('/messages') ? 'anthropic' : 'openai';

    /**
     * `/custom/…` stands in for a **customer's own endpoint** — their service, a
     * gateway, a self-hosted model. It behaves like a real one in the way that
     * matters for testing: it insists on its own extra header, and it will not
     * answer at all without it. That is how the check proves Voxera really sends
     * the headers a customer configured rather than just storing them.
     */
    const isCustom = url.pathname.startsWith('/custom');
    const customHeader = req.headers['x-voxera-tenant'];
    if (isCustom && customHeader !== 'northwind') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'x-voxera-tenant header is required', type: 'invalid_request_error' } }));
      return;
    }

    // ---- key checks -------------------------------------------------------
    if (/\/models\/?$/.test(url.pathname)) {
      if (!GOOD_KEYS.has(String(key))) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify(provider === 'anthropic'
          ? { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
          : { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
      const ids = isCustom
        ? ['northwind-triage-8b', 'northwind-desk-70b']
        : provider === 'anthropic'
          ? ['claude-sonnet-4.5', 'claude-haiku-4.5', 'claude-opus-4.1']
          : ['gpt-5-mini', 'gpt-5-chat', 'gpt-4.1'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }));
      return;
    }

    // A customer's endpoint that speaks the Messages API instead.
    if (url.pathname.startsWith('/custom-anthropic')) {
      if (customHeader !== 'northwind') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'x-voxera-tenant header is required' } }));
        return;
      }
      if (!GOOD_KEYS.has(String(key))) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      if (/\/models\/?$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'northwind-messages-1' }] }));
        return;
      }
      const body = JSON.parse(raw || '{}') as { messages?: Turn[]; stream?: boolean };
      const decision = decide(body.messages ?? []);
      // The real Messages API is non-streaming unless `stream: true` is asked for.
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_stub', type: 'message', model: 'northwind-messages-1', content: [{ type: 'text', text: decision.text ?? 'The endpoint answered over Messages.' }] }));
        return;
      }
      sse(res, [
        ['message_start', { type: 'message_start', message: { usage: { input_tokens: 30, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: decision.text ?? 'answered through the Messages wire' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }],
      ]);
      return;
    }

    // ---- completions ------------------------------------------------------
    if (url.pathname === '/v1/messages' || url.pathname.endsWith('/chat/completions')) {
      const body = JSON.parse(raw || '{}') as { messages?: Turn[]; stream?: boolean };
      const messages = body.messages ?? [];
      if (FAIL) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(provider === 'anthropic'
          ? { type: 'error', error: { type: 'api_error', message: 'stub is configured to fail' } }
          : { error: { message: 'stub is configured to fail' } }));
        return;
      }

      const decision: Decision = decide(messages);
      const words = (decision.text ?? '').split(/(?<=\s)/).filter(Boolean);

      // A plain, non-streaming completion — what "Send a test message" sends.
      if (body.stream === false) {
        const text = decision.text ?? 'The endpoint answered.';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            provider === 'anthropic'
              ? { id: 'msg_stub', type: 'message', content: [{ type: 'text', text }], model: 'stub' }
              : { id: 'chatcmpl_stub', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
          )
        );
        return;
      }

      if (provider === 'anthropic') {
        const frames: [string, unknown][] = [
          ['message_start', { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 0 } } }],
        ];
        if (decision.tool) {
          frames.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${Date.now()}`, name: decision.tool.name } }]);
          frames.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(decision.tool.args) } }]);
          frames.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
          frames.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 24 } }]);
        } else {
          frames.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text' } }]);
          for (const word of words) frames.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: word } }]);
          frames.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
          frames.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: words.length * 2 } }]);
        }
        sse(res, frames);
        return;
      }

      const frames: [string, unknown][] = [];
      if (decision.tool) {
        frames.push([
          'data',
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.args) } }] },
              },
            ],
          },
        ]);
        frames.push(['data', { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 22 } }]);
      } else {
        for (const word of words) frames.push(['data', { choices: [{ index: 0, delta: { content: word } }] }]);
        frames.push(['data', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: words.length * 2 } }]);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const [, data] of frames) res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no stub route for ${req.method} ${url.pathname}` } }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `ai stub listening on http://127.0.0.1:${PORT} — anthropic at /v1/messages, openai at /v1/chat/completions` +
      (FAIL ? ' (configured to fail every completion)' : '')
  );
});
