/**
 * Streaming chat, in the two wire formats that matter.
 *
 * Anthropic's Messages API and the OpenAI chat-completions shape. Both stream
 * server-sent events; both can ask for tools mid-stream; both report token usage.
 * The differences (where the system prompt goes, how tool calls and tool results
 * are shaped) are handled here so nothing above this file has to know which
 * vendor is answering.
 *
 * Everything is a generator of small events, because the consumer is a phone
 * call: text has to leave for the speaker the moment it exists.
 */

import type { ResolvedModel } from './credentials';
import { authHeaders, completionUrl } from './providers';

/**
 * Request headers for a resolved model.
 *
 * Hosted providers get their vendor's header shape; a bring-your-own endpoint
 * gets whatever the customer configured — key style plus any extra headers they
 * need (a tenant id, a gateway token). Nothing else in the file has to care.
 */
function headersFor(model: ResolvedModel) {
  const base = authHeaders(model.wire, model.apiKey, model.authStyle);
  return { ...base, ...(model.headers ?? {}) };
}

export type ChatToolCall = { id: string; name: string; args: Record<string, unknown> };

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ChatToolCall[] }
  | { role: 'tool'; results: { id: string; name: string; content: string }[] };

export type ChatToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_use'; call: ChatToolCall }
  | { type: 'usage'; input: number; output: number }
  | { type: 'stop'; reason: string };

export type ChatInput = {
  model: ResolvedModel;
  system: string;
  messages: ChatMessage[];
  tools: ChatToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** First-token budget: a voice turn that has not started in time is a bad turn. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Splits a byte stream into `data:` payloads, whatever chunking the network chose. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      let event: string | undefined;
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
  if (buffer.trim()) {
    const data = buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    if (data.length) yield { data: data.join('\n') };
  }
}

async function failure(res: Response, providerLabel: string) {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 240);
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    detail = json.error?.message ?? json.message ?? detail;
  } catch {
    /* keep the raw text */
  }
  return `${providerLabel} returned ${res.status}${detail ? `: ${detail}` : ''}`;
}

/* ------------------------------------------------------------------ anthropic */

async function* anthropic(input: ChatInput): AsyncGenerator<ChatEvent> {
  const { model } = input;
  const body = {
    model: model.model,
    system: input.system,
    max_tokens: input.maxTokens ?? 400,
    temperature: input.temperature ?? 0.4,
    stream: true,
    messages: input.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', content: [{ type: 'text', text: m.content }] };
      if (m.role === 'assistant') {
        const content: Record<string, unknown>[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const call of m.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
        return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] };
      }
      // Tool results come back to the model as a user turn.
      return {
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })),
      };
    }),
    tools: input.tools.length
      ? input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      : undefined,
  };

  // `completionUrl` collapses a doubled `/v1` — the single most common way a
  // pasted endpoint URL fails.
  const res = await fetch(completionUrl({ wire: 'anthropic' }, model.baseUrl), {
    method: 'POST',
    headers: headersFor(model),
    body: JSON.stringify(body),
    signal: input.signal ?? AbortSignal.timeout(input.timeoutMs ?? 45_000),
  });
  if (!res.ok || !res.body) throw new Error(await failure(res, model.providerLabel));

  let current: { id: string; name: string; json: string } | undefined;
  for await (const { data } of sseLines(res.body)) {
    if (!data || data === '[DONE]') continue;
    let payload: {
      type?: string;
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      index?: number;
      content_block?: { type?: string; id?: string; name?: string };
      delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
      usage?: { output_tokens?: number };
      error?: { message?: string };
    };
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    if (payload.type === 'error') throw new Error(payload.error?.message ?? 'model stream failed');

    if (payload.type === 'message_start') {
      yield { type: 'usage', input: payload.message?.usage?.input_tokens ?? 0, output: 0 };
      continue;
    }
    if (payload.type === 'content_block_start') {
      if (payload.content_block?.type === 'tool_use') {
        current = { id: String(payload.content_block.id ?? ''), name: String(payload.content_block.name ?? ''), json: '' };
      }
      continue;
    }
    if (payload.type === 'content_block_delta') {
      if (payload.delta?.type === 'text_delta' && payload.delta.text) {
        yield { type: 'delta', text: payload.delta.text };
      } else if (payload.delta?.type === 'input_json_delta' && current) {
        current.json += payload.delta.partial_json ?? '';
      }
      continue;
    }
    if (payload.type === 'content_block_stop') {
      if (current) {
        yield { type: 'tool_use', call: { id: current.id, name: current.name, args: safeJson(current.json) } };
        current = undefined;
      }
      continue;
    }
    if (payload.type === 'message_delta') {
      if (payload.usage?.output_tokens) yield { type: 'usage', input: 0, output: payload.usage.output_tokens };
      if (payload.delta?.stop_reason) yield { type: 'stop', reason: payload.delta.stop_reason };
    }
  }
}

/* ------------------------------------------------------------------- openai */

async function* openai(input: ChatInput): AsyncGenerator<ChatEvent> {
  const { model } = input;
  const body = {
    model: model.model,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages.map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.role === 'assistant') {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls?.length
              ? m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }))
              : undefined,
          };
        }
        return m.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.content }));
      }).flat(),
    ],
    tools: input.tools.length
      ? input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      : undefined,
    temperature: input.temperature ?? 0.4,
    max_tokens: input.maxTokens ?? 400,
    stream: true,
    stream_options: { include_usage: true },
  };

  const res = await fetch(completionUrl({ wire: 'openai' }, model.baseUrl), {
    method: 'POST',
    headers: headersFor(model),
    body: JSON.stringify(body),
    signal: input.signal ?? AbortSignal.timeout(input.timeoutMs ?? 45_000),
  });
  if (!res.ok || !res.body) throw new Error(await failure(res, model.providerLabel));

  const pending = new Map<number, { id: string; name: string; args: string }>();
  for await (const { data } of sseLines(res.body)) {
    if (!data || data === '[DONE]') continue;
    let payload: {
      choices?: {
        delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }

    if (payload.error) throw new Error(payload.error.message ?? 'model stream failed');

    const choice = payload.choices?.[0];
    if (choice?.delta?.content) yield { type: 'delta', text: choice.delta.content };

    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const entry = pending.get(index) ?? { id: call.id ?? `call_${index}`, name: '', args: '' };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      if (call.function?.arguments) entry.args += call.function.arguments;
      pending.set(index, entry);
    }

    if (choice?.finish_reason) {
      if (payload.usage) yield { type: 'usage', input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 };
      for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (call.name) yield { type: 'tool_use', call: { id: call.id, name: call.name, args: safeJson(call.args) } };
      }
      pending.clear();
      yield { type: 'stop', reason: choice.finish_reason };
    }

    if (!choice && payload.usage) {
      yield { type: 'usage', input: payload.usage.prompt_tokens ?? 0, output: payload.usage.completion_tokens ?? 0 };
    }
  }
}

function safeJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One streamed completion from whichever provider the model belongs to. */
export function streamChat(input: ChatInput): AsyncGenerator<ChatEvent> {
  return input.model.wire === 'anthropic' ? anthropic(input) : openai(input);
}
