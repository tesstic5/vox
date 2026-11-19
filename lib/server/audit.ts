import { insert, newId, nowIso, type Doc } from './db';

/** Every meaningful mutation lands here; the dashboard's audit page reads it back. */
export function audit(input: { orgId: string; actor: string; action: string; target?: string; detail?: string; kind?: string }) {
  return insert<Doc>('audit', {
    id: newId('aud_'),
    orgId: input.orgId,
    actor: input.actor,
    action: input.action,
    kind: input.kind ?? 'config',
    target: input.target ?? '',
    at: nowIso(),
    detail: input.detail ?? '',
  } as Doc);
}
