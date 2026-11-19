import type { Workflow, WorkflowEdge, WorkflowIssue, WorkflowNode, WorkflowNodeKind } from './types';

/* --------------------------------------------------------------- palette */

export const NODE_KINDS: {
  kind: WorkflowNodeKind;
  label: string;
  icon: 'play' | 'sparkles' | 'hash' | 'cloud' | 'branch' | 'shield' | 'phoneForwarded' | 'check';
  desc: string;
  tone: string;
}[] = [
  { kind: 'start', label: 'Start', icon: 'play', desc: 'Entry point. Every workflow has exactly one.', tone: 'text-slateink-300' },
  { kind: 'prompt', label: 'Prompt', icon: 'sparkles', desc: 'Say or ask something, conversationally', tone: 'text-brand-300' },
  { kind: 'dtmf', label: 'Collect keypad', icon: 'hash', desc: 'Read digits a caller presses — safe for identifiers', tone: 'text-sky-800' },
  { kind: 'api', label: 'API request', icon: 'cloud', desc: 'Call your API and use the response', tone: 'text-violet-800' },
  { kind: 'branch', label: 'Branch', icon: 'branch', desc: 'Split on a condition, with a default path', tone: 'text-amber-300' },
  { kind: 'validate', label: 'Validate', icon: 'shield', desc: 'Check input against a rule before continuing', tone: 'text-emerald-300' },
  { kind: 'transfer', label: 'Warm transfer', icon: 'phoneForwarded', desc: 'Hand to a human or squad member with a brief', tone: 'text-rose-300' },
  { kind: 'end', label: 'End', icon: 'check', desc: 'Close the call with a closing line', tone: 'text-slateink-300' },
];

export const NODE_KIND_BY_KEY = new Map(NODE_KINDS.map((k) => [k.kind, k]));

export function nodeKind(kind: WorkflowNodeKind) {
  return NODE_KIND_BY_KEY.get(kind) ?? NODE_KINDS[0];
}

let seq = 0;
export function nodeId(prefix = 'nd') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export function makeNode(kind: WorkflowNodeKind, x: number, y: number, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  const base: Record<WorkflowNodeKind, Partial<WorkflowNode>> = {
    start: { label: 'Start', text: 'Inbound call answered' },
    prompt: { label: 'Prompt', text: 'Greet the caller and ask what they need.' },
    dtmf: { label: 'Collect keypad', text: 'Please enter your account number, then press pound.', config: { digits: 8 } },
    api: {
      label: 'API request',
      text: 'Look up the account by number.',
      config: { method: 'GET', url: 'https://api.voxera-tenant.dev/accounts/{account}', timeoutMs: 2500, retry: 'once' },
    },
    branch: { label: 'Branch', text: 'Which path should the caller take?' },
    validate: { label: 'Validate', text: 'Check the value before continuing.', config: { pattern: '^\\d{8}$', onError: 'Ask again, then transfer after two failures.' } },
    transfer: { label: 'Warm transfer', text: 'Transfer to a human with the collected context.', config: { onError: 'Fall back to a callback promise.' } },
    end: { label: 'End', text: 'Thanks for calling — your reference is on the way by text.' },
  };
  return {
    id: nodeId(),
    kind,
    label: base[kind].label ?? 'Node',
    x,
    y,
    text: base[kind].text ?? '',
    config: { ...(base[kind].config ?? {}) },
    ...overrides,
  };
}

export function makeEdge(from: string, to: string, label = ''): WorkflowEdge {
  return { id: `${from}->${to}-${Math.random().toString(36).slice(2, 6)}`, from, to, label };
}

/* ------------------------------------------------------------- templates */

export type WorkflowTemplate = {
  slug: string;
  name: string;
  purpose: string;
  /** Why this shape, not a conversational prompt. */
  why: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

function n(kind: WorkflowNodeKind, x: number, y: number, overrides: Partial<WorkflowNode> = {}) {
  return makeNode(kind, x, y, overrides);
}

const wf1 = {
  start: n('start', 40, 200, { text: 'Inbound call on the eligibility line' }),
  hook: n('prompt', 260, 200, {
    label: 'Disclosure',
    text: 'Identify yourself as a Voxera AI assistant, state that the call is recorded, and ask for the member ID.',
    config: { writes: 'disclosureDelivered' },
  }),
  id: n('dtmf', 480, 200, {
    label: 'Member ID by keypad',
    text: 'Please enter your member ID, then press pound.',
    config: { digits: 10, writes: 'memberId', onError: 'Repeat once, then transfer to eligibility services.' },
  }),
  check: n('validate', 700, 200, {
    label: 'Format check',
    text: 'Reject anything that is not ten digits before calling the payer.',
    config: { pattern: '^\\d{10}$', onError: 'Ask again once, then transfer.' },
  }),
  payer: n('api', 920, 200, {
    label: 'Eligibility check',
    text: 'POST the member ID to the clearinghouse and read active coverage and copay.',
    config: { method: 'POST', url: 'https://api.voxera-tenant.dev/eligibility', timeoutMs: 3000, retry: 'once', writes: 'coverage', onError: 'Read the standard "cannot confirm right now" line, then transfer.' },
  }),
  decision: n('branch', 1140, 200, {
    label: 'Coverage decision',
    text: 'Split on whether the payer returned active coverage.',
  }),
  active: n('prompt', 1360, 60, {
    label: 'Confirm coverage',
    text: 'Confirm coverage is active, state the copay amount, and offer to text the summary.',
    config: { writes: 'summarySent' },
  }),
  inactive: n('prompt', 1360, 340, {
    label: 'Explain next steps',
    text: 'Explain that coverage is not active, read the two options, and offer a billing representative.',
  }),
  done: n('end', 1580, 60, { label: 'End — covered', text: 'Thank the caller and end the call.' }),
  hand: n('transfer', 1580, 340, {
    label: 'Warm transfer',
    text: 'Transfer to a billing representative with the member ID and the payer response attached.',
    config: { onError: 'Promise a callback within two hours and log the request.' },
  }),
};

const wf2 = {
  start: n('start', 40, 200, { text: 'Outbound confirmation call' }),
  verify: n('dtmf', 260, 200, {
    label: 'Date of birth',
    text: 'For security, enter your date of birth as eight digits — month, day, year.',
    config: { digits: 8, writes: 'dob', onError: 'Repeat once, then end the call politely.' },
  }),
  validate: n('validate', 480, 200, {
    label: 'DOB plausibility',
    text: 'Check the digits parse as a real date and the year is sensible.',
    config: { pattern: '^\\d{8}$', onError: 'Two attempts, then end the call.' },
  }),
  ask: n('prompt', 700, 200, {
    label: 'Read the appointment',
    text: 'Read the appointment time and ask whether it still works. Wait for a yes or no.',
    config: { writes: 'appointmentConfirmed' },
  }),
  decision: n('branch', 920, 200, { label: 'Still works?', text: 'Split on the confirmation answer.' }),
  confirm: n('prompt', 1140, 60, {
    label: 'Confirm and set reminder',
    text: 'Confirm the appointment, offer a text reminder, and set the flag for the dispatcher.',
    config: { writes: 'reminderSet' },
  }),
  resched: n('api', 1140, 340, {
    label: 'Offer new slots',
    text: 'GET the two earliest alternative slots and read them aloud.',
    config: { method: 'GET', url: 'https://api.voxera-tenant.dev/slots', timeoutMs: 2000, retry: 'once', writes: 'offeredSlots', onError: 'Apologise and transfer to scheduling.' },
  }),
  done: n('end', 1360, 60, { label: 'End — confirmed', text: 'Confirm once more and end the call.' }),
  human: n('transfer', 1360, 340, {
    label: 'Transfer to scheduling',
    text: 'Transfer with the DOB verified and the two slots already offered.',
    config: { onError: 'Send a self-serve rebooking link by text instead.' },
  }),
};

const wf3 = {
  start: n('start', 40, 200, { text: 'Outbound balance reminder' }),
  disclosure: n('prompt', 260, 200, {
    label: 'Required disclosure',
    text: 'State that this is an automated call from Voxera on behalf of the creditor, and that this is an attempt to collect a debt.',
    config: { writes: 'miniMiranda' },
  }),
  identify: n('dtmf', 480, 200, {
    label: 'Last four of SSN',
    text: 'Ask the caller to enter the last four digits of the account holder\u2019s social security number.',
    config: { digits: 4, writes: 'ssn4', onError: 'End the call and log a verification failure.' },
  }),
  lookup: n('api', 700, 200, {
    label: 'Balance lookup',
    text: 'GET the current balance and the minimum due date.',
    config: { method: 'GET', url: 'https://api.voxera-tenant.dev/balances/{ssn4}', timeoutMs: 2500, retry: 'once', writes: 'balance', onError: 'Read a generic status line and offer a callback.' },
  }),
  decision: n('branch', 920, 200, { label: 'Intent', text: 'Pay now, or request a hardship option.' }),
  pay: n('prompt', 1140, 60, {
    label: 'Offer payment link',
    text: 'Never take card details by voice. Text a secure payment link and confirm receipt.',
    config: { writes: 'linkSent' },
  }),
  hardship: n('prompt', 1140, 340, {
    label: 'Explain hardship options',
    text: 'Read the two hardship programmes, note interest, and capture which one the caller wants.',
    config: { writes: 'hardshipChoice' },
  }),
  done: n('end', 1360, 60, { label: 'End — link sent', text: 'Confirm the text was received and end the call.' }),
  human: n('transfer', 1360, 340, {
    label: 'Transfer to collections',
    text: 'Transfer to a licensed collections agent with the hardship choice attached.',
    config: { onError: 'Promise a callback within one business day.' },
  }),
};

const wf4 = {
  start: n('start', 40, 200, { text: 'Inbound order line' }),
  ask: n('prompt', 260, 200, {
    label: 'Collect order reference',
    text: 'Ask for the order number, or offer to look it up by the phone number on the account.',
    config: { writes: 'orderRef' },
  }),
  lookup: n('api', 480, 200, {
    label: 'Order lookup',
    text: 'GET the order and carrier scan history.',
    config: { method: 'GET', url: 'https://api.voxera-tenant.dev/orders/{orderRef}', timeoutMs: 2500, retry: 'once', writes: 'order', onError: 'Say the system is slow, then take a callback number.' },
  }),
  found: n('branch', 700, 200, { label: 'Order found?', text: 'Split on whether the lookup returned an order.' }),
  read: n('prompt', 920, 60, {
    label: 'Read the status',
    text: 'Read the current status in plain language, then offer a tracking link by text.',
    config: { writes: 'statusRead' },
  }),
  missing: n('prompt', 920, 340, {
    label: 'Order not found',
    text: 'Explain that the reference did not match, ask the caller to check it, and offer a human.',
  }),
  done: n('end', 1140, 60, { label: 'End — status given', text: 'Confirm the text arrived and end the call.' }),
  human: n('transfer', 1140, 340, {
    label: 'Transfer to support',
    text: 'Transfer with the reference the caller gave and the failed lookup attached.',
    config: { onError: 'Take a callback number and open a ticket.' },
  }),
};

function wire(parts: { start: WorkflowNode; prompt: WorkflowNode; dtmf?: WorkflowNode; validate?: WorkflowNode; api?: WorkflowNode; branch?: WorkflowNode; yes: WorkflowNode; no: WorkflowNode }, yesLabel: string, noLabel: string): WorkflowEdge[] {
  const e: WorkflowEdge[] = [];
  const chain = [parts.start, parts.prompt, parts.dtmf, parts.validate, parts.api].filter(Boolean) as WorkflowNode[];
  for (let i = 0; i < chain.length - 1; i++) e.push(makeEdge(chain[i].id, chain[i + 1].id));
  const tail = chain[chain.length - 1];
  if (parts.branch) {
    e.push(makeEdge(tail.id, parts.branch.id), makeEdge(parts.branch.id, parts.yes.id, yesLabel), makeEdge(parts.branch.id, parts.no.id, noLabel));
  } else {
    e.push(makeEdge(tail.id, parts.yes.id));
  }
  return e;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    slug: 'eligibility-verification',
    name: 'Insurance eligibility verification',
    purpose: 'Verify coverage before a visit, with the member ID collected by keypad and the payer called deterministically.',
    why: 'Eligibility is a regulated check with a binary answer, so it should not be improvised. The conversational model handles the greeting and the explanation; the lookup, the format check, and the branch are fixed nodes a compliance reviewer can read in a minute.',
    nodes: Object.values(wf1),
    edges: wire(
      { start: wf1.start, prompt: wf1.hook, dtmf: wf1.id, validate: wf1.check, api: wf1.payer, branch: wf1.decision, yes: wf1.active, no: wf1.inactive },
      'coverage active',
      'not active'
    )
      .concat([
        makeEdge(wf1.active.id, wf1.done.id),
        makeEdge(wf1.inactive.id, wf1.hand.id),
      ]),
  },
  {
    slug: 'appointment-confirmation',
    name: 'Appointment confirmation with rescheduling',
    purpose: 'Confirm tomorrow\u2019s appointment over the phone, and offer the two earliest alternatives when it does not work.',
    why: 'A confirmation call is short and repetitive, which is exactly where a fixed shape beats a long prompt. Identity verification happens by keypad so nothing sensitive enters the transcript, and the reschedule path is a single API node with a stated fallback.',
    nodes: Object.values(wf2),
    edges: wire(
      { start: wf2.start, prompt: wf2.ask, dtmf: wf2.verify, validate: wf2.validate, branch: wf2.decision, yes: wf2.confirm, no: wf2.resched },
      'yes',
      'no'
    ).concat([makeEdge(wf2.confirm.id, wf2.done.id), makeEdge(wf2.resched.id, wf2.human.id)]),
  },
  {
    slug: 'collections-soft',
    name: 'Collections reminder (soft)',
    purpose: 'A required-disclosure-first reminder call that never collects card details by voice and always offers a hardship path.',
    why: 'Collections is the call type where improvisation creates legal exposure. The disclosure and the refusal to take card details by voice are nodes, not prompt instructions, and the hardship branch exists on every call rather than only when the caller asks.',
    nodes: Object.values(wf3),
    edges: wire(
      { start: wf3.start, prompt: wf3.disclosure, dtmf: wf3.identify, api: wf3.lookup, branch: wf3.decision, yes: wf3.pay, no: wf3.hardship },
      'wants to pay',
      'hardship'
    ).concat([makeEdge(wf3.pay.id, wf3.done.id), makeEdge(wf3.hardship.id, wf3.human.id)]),
  },
  {
    slug: 'order-status-api',
    name: 'Order status with live API lookup',
    purpose: 'Answer where an order is by calling the order service, with a defined path for a reference that does not match.',
    why: 'WISMO calls are the highest-volume, lowest-variance contact in most support queues. Making the lookup a node means the answer comes from the order service rather than the model\u2019s memory, and a failed lookup has a sentence attached instead of an invention.',
    nodes: Object.values(wf4),
    edges: wire(
      { start: wf4.start, prompt: wf4.ask, api: wf4.lookup, branch: wf4.found, yes: wf4.read, no: wf4.missing },
      'found',
      'not found'
    ).concat([makeEdge(wf4.read.id, wf4.done.id), makeEdge(wf4.missing.id, wf4.human.id)]),
  },
];

export const WORKFLOW_TEMPLATE_BY_SLUG = new Map(WORKFLOW_TEMPLATES.map((t) => [t.slug, t]));

export function getWorkflowTemplate(slug: string) {
  return WORKFLOW_TEMPLATE_BY_SLUG.get(slug);
}

/* ------------------------------------------------------------ validation */

/**
 * The same checks the runtime applies before a workflow can be published.
 * Warnings are things a reviewer should look at; errors block publishing.
 */
export function validateWorkflow(wf: Pick<Workflow, 'nodes' | 'edges' | 'name'>): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));

  if (!wf.name.trim()) {
    issues.push({ nodeId: null, severity: 'error', message: 'The workflow needs a name before it can be published.' });
  }

  const starts = wf.nodes.filter((n) => n.kind === 'start');
  if (starts.length === 0) {
    issues.push({ nodeId: null, severity: 'error', message: 'No start node. A call would arrive with nowhere to go.' });
  }
  if (starts.length > 1) {
    issues.push({
      nodeId: starts[1].id,
      severity: 'error',
      message: 'More than one start node. Only the first can receive the call, so the others are unreachable.',
    });
  }

  if (!wf.nodes.some((n) => n.kind === 'end')) {
    issues.push({
      nodeId: null,
      severity: 'warning',
      message: 'No end node. Calls will close on the caller hanging up, with no closing line.',
    });
  }

  // Reachability from the start node.
  const outgoing = new Map<string, WorkflowEdge[]>();
  wf.edges.forEach((e) => outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]));
  const reached = new Set<string>();
  const queue = starts.length ? [starts[0].id] : [];
  while (queue.length) {
    const id = queue.shift() as string;
    if (reached.has(id)) continue;
    reached.add(id);
    (outgoing.get(id) ?? []).forEach((e) => {
      if (byId.has(e.to)) queue.push(e.to);
    });
  }
  wf.nodes.forEach((n) => {
    if (!reached.has(n.id)) {
      issues.push({
        nodeId: n.id,
        severity: 'error',
        message: `"${n.label}" cannot be reached from the start node, so it will never run.`,
      });
    }
  });

  // Dangling edges.
  wf.edges.forEach((e) => {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      issues.push({ nodeId: byId.has(e.from) ? e.from : null, severity: 'error', message: 'An edge points at a node that no longer exists.' });
    }
  });

  // Per-node checks.
  wf.nodes.forEach((n) => {
    const outs = outgoing.get(n.id) ?? [];
    const ins = wf.edges.filter((e) => e.to === n.id);

    if (n.kind === 'branch') {
      const labelled = outs.filter((e) => e.label.trim());
      if (outs.length < 2) {
        issues.push({ nodeId: n.id, severity: 'error', message: `"${n.label}" has ${outs.length} outgoing path — a branch needs at least two.` });
      }
      if (outs.length > 2 && labelled.length) {
        issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" has ${outs.length} paths. Make sure one of them is the default.` });
      }
      outs.forEach((e) => {
        if (!e.label.trim() && outs.length > 1 && outs.filter((x) => !x.label.trim()).length > 1) {
          issues.push({ nodeId: n.id, severity: 'warning', message: `Two paths out of "${n.label}" are unlabelled; the second can never be chosen.` });
        }
      });
    } else if (n.kind !== 'end' && outs.length === 0) {
      issues.push({ nodeId: n.id, severity: 'error', message: `"${n.label}" has no outgoing path, so the call stalls here.` });
    }

    if (n.kind === 'end' && outs.length > 0) {
      issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" is an end node but still has an outgoing path.` });
    }
    if (n.kind !== 'start' && ins.length === 0) {
      issues.push({ nodeId: n.id, severity: 'error', message: `"${n.label}" has no incoming path.` });
    }

    const needsErrorPath = n.kind === 'api' || n.kind === 'transfer' || n.kind === 'dtmf' || n.kind === 'validate';
    if (needsErrorPath && !n.config.onError?.trim()) {
      issues.push({
        nodeId: n.id,
        severity: 'error',
        message: `"${n.label}" can fail and has no error path. Say what happens instead — silence is not a policy.`,
      });
    }
    if (n.kind === 'api' && !n.config.url?.trim()) {
      issues.push({ nodeId: n.id, severity: 'error', message: `"${n.label}" has no URL.` });
    }
    if (n.kind === 'api' && !n.config.timeoutMs) {
      issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" has no timeout, so a slow API will hold the caller.` });
    }
    if (n.kind === 'dtmf' && !n.config.digits) {
      issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" has no expected digit count, which makes retries hard to judge.` });
    }
    if (n.kind === 'validate' && !n.config.pattern?.trim()) {
      issues.push({ nodeId: n.id, severity: 'error', message: `"${n.label}" has no pattern to validate against.` });
    }
    if (n.kind === 'validate') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(n.config.pattern ?? '');
      } catch {
        issues.push({ nodeId: n.id, severity: 'error', message: `The pattern in "${n.label}" is not valid Regex.` });
      }
    }
    if (n.kind === 'prompt' && n.text.trim().length < 24) {
      issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" is very short — write the sentence the agent should actually say.` });
    }
    if ((n.kind === 'dtmf' || n.kind === 'api') && !n.config.writes?.trim()) {
      issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" does not name the variable it writes, so nothing downstream can use the value.` });
    }
  });

  // Variables read before they are written (a common silent failure).
  const written = new Set(wf.nodes.map((n) => n.config.writes).filter(Boolean) as string[]);
  wf.nodes.forEach((n) => {
    if (n.kind !== 'prompt' || !n.text.trim()) return;
    const named = n.config.writes?.trim();
    if (named && !written.has(named)) {
      issues.push({ nodeId: n.id, severity: 'warning', message: `"${n.label}" writes a variable nothing reads.` });
    }
  });

  return issues;
}

export function workflowStats(wf: Pick<Workflow, 'nodes' | 'edges'>) {
  const count = (kind: WorkflowNodeKind) => wf.nodes.filter((n) => n.kind === kind).length;
  return {
    nodes: wf.nodes.length,
    edges: wf.edges.length,
    branches: count('branch'),
    deterministic: count('dtmf') + count('api') + count('validate'),
    endpoints: count('end') + count('transfer'),
  };
}
