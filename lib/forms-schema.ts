export const FORM_FIELD_TYPES = [
  'text',
  'long_text',
  'number',
  'date',
  'yes_no',
  'single_choice',
  'multiple_choice',
  'acknowledgement',
  'file',
  'display',
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormCondition =
  | { op: 'equals'; field: string; value: string | number | boolean }
  | { op: 'notEquals'; field: string; value: string | number | boolean }
  | { op: 'contains'; field: string; value: string | number | boolean }
  | { op: 'answered'; field: string }
  | { op: 'all'; rules: FormCondition[] }
  | { op: 'any'; rules: FormCondition[] };

export type FormField = {
  id: string;
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  condition?: FormCondition;
  sensitivity?: 'administrative' | 'clinical';
  updateTarget?: 'name' | 'email' | 'phone' | 'address' | `custom:${string}`;
  displayText?: string;
};

export type FormSchema = {
  version: 1;
  title: string;
  description?: string;
  submitLabel?: string;
  completionMessage?: string;
  emergencyNotice?: string;
  fields: FormField[];
};

export type FormAnswers = Record<string, unknown>;

const KEY = /^[a-z][a-z0-9_]{1,63}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{1,79}$/;
const CUSTOM_UPDATE_TARGET = /^custom:[a-z][a-z0-9_]{1,63}$/;

function conditionReferences(condition: FormCondition | undefined, out = new Set<string>()): Set<string> {
  if (!condition) return out;
  if (condition.op === 'all' || condition.op === 'any') {
    for (const child of condition.rules) conditionReferences(child, out);
  } else {
    out.add(condition.field);
  }
  return out;
}

function validateCondition(condition: FormCondition, known: Set<string>, depth = 0): void {
  if (depth > 8) throw new Error('Form conditions may be nested at most eight levels.');
  if (condition.op === 'all' || condition.op === 'any') {
    if (!Array.isArray(condition.rules) || condition.rules.length < 1 || condition.rules.length > 20) {
      throw new Error(`A ${condition.op} condition must contain 1 to 20 rules.`);
    }
    for (const rule of condition.rules) validateCondition(rule, known, depth + 1);
    return;
  }
  if (!known.has(condition.field)) throw new Error(`Condition refers to unknown field ${condition.field}.`);
  if (!['equals', 'notEquals', 'contains', 'answered'].includes(condition.op)) throw new Error('Unsupported form condition operator.');
  if (condition.op !== 'answered' && condition.value === undefined) throw new Error(`${condition.op} requires a comparison value.`);
}

function assertNoConditionCycles(fields: FormField[]) {
  const graph = new Map(fields.map((field) => [field.key, [...conditionReferences(field.condition)]]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error(`Conditional form cycle includes ${key}.`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const field of fields) visit(field.key);
}

export function validateFormSchema(value: unknown): FormSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Form schema must be an object.');
  const input = value as Partial<FormSchema>;
  const title = String(input.title ?? '').trim();
  if (title.length < 2 || title.length > 160) throw new Error('Form title must be 2 to 160 characters.');
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 100) {
    throw new Error('A form must contain 1 to 100 fields.');
  }
  const fields: FormField[] = input.fields.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Field ${index + 1} must be an object.`);
    const row = raw as FormField;
    const type = String(row.type ?? '') as FormFieldType;
    const key = String(row.key ?? '').trim();
    const id = String(row.id ?? `field_${key || index + 1}`).trim();
    const label = String(row.label ?? '').trim();
    if (!FORM_FIELD_TYPES.includes(type)) throw new Error(`Field ${index + 1} has an unsupported type.`);
    if (!KEY.test(key)) throw new Error(`Field key ${key || index + 1} must use lower-case letters, numbers and underscores.`);
    if (!ID.test(id)) throw new Error(`Field ${key} has an invalid id.`);
    if (type !== 'display' && (label.length < 1 || label.length > 240)) throw new Error(`Field ${key} needs a label of at most 240 characters.`);
    if (type === 'display' && !String(row.displayText ?? '').trim()) throw new Error(`Display field ${key} needs text.`);
    const needsOptions = type === 'single_choice' || type === 'multiple_choice';
    const options = Array.isArray(row.options)
      ? row.options.map((option) => ({ value: String(option.value ?? '').trim(), label: String(option.label ?? '').trim() }))
      : undefined;
    if (needsOptions && (!options || options.length < 1 || options.length > 50)) throw new Error(`Field ${key} needs 1 to 50 choices.`);
    if (options && (options.some((option) => !option.value || !option.label) || new Set(options.map((option) => option.value)).size !== options.length)) {
      throw new Error(`Field ${key} has blank or duplicate choices.`);
    }
    const updateTarget = row.updateTarget === undefined ? undefined : String(row.updateTarget);
    if (updateTarget && !['name', 'email', 'phone', 'address'].includes(updateTarget) && !CUSTOM_UPDATE_TARGET.test(updateTarget)) {
      throw new Error(`Field ${key} has an invalid update target.`);
    }
    if (updateTarget && (type === 'display' || type === 'file')) throw new Error(`Field ${key} cannot update a patient record.`);
    if (updateTarget && !updateTarget.startsWith('custom:') && !['text', 'long_text'].includes(type)) {
      throw new Error(`Field ${key} must be text to update ${updateTarget}.`);
    }
    return {
      id,
      key,
      label: type === 'display' ? label || 'Information' : label,
      type,
      required: type === 'display' ? false : Boolean(row.required),
      help: row.help ? String(row.help).slice(0, 1_000) : undefined,
      placeholder: row.placeholder ? String(row.placeholder).slice(0, 240) : undefined,
      options,
      condition: row.condition,
      sensitivity: row.sensitivity === 'clinical' ? 'clinical' : 'administrative',
      updateTarget: updateTarget as FormField['updateTarget'],
      displayText: type === 'display' ? String(row.displayText).slice(0, 4_000) : undefined,
    };
  });
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error('Form field keys must be unique.');
  if (new Set(fields.map((field) => field.id)).size !== fields.length) throw new Error('Form field ids must be unique.');
  const keys = new Set(fields.map((field) => field.key));
  for (const field of fields) if (field.condition) validateCondition(field.condition, keys);
  assertNoConditionCycles(fields);
  return {
    version: 1,
    title,
    description: input.description ? String(input.description).slice(0, 4_000) : undefined,
    submitLabel: input.submitLabel ? String(input.submitLabel).slice(0, 80) : 'Submit securely',
    completionMessage: input.completionMessage ? String(input.completionMessage).slice(0, 2_000) : 'Thank you. Your response has been received for staff review.',
    emergencyNotice: input.emergencyNotice ? String(input.emergencyNotice).slice(0, 2_000) : undefined,
    fields,
  };
}

function answered(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== '';
}

export function conditionMatches(condition: FormCondition | undefined, answers: FormAnswers): boolean {
  if (!condition) return true;
  if (condition.op === 'all') return condition.rules.every((rule) => conditionMatches(rule, answers));
  if (condition.op === 'any') return condition.rules.some((rule) => conditionMatches(rule, answers));
  const actual = answers[condition.field];
  if (condition.op === 'answered') return answered(actual);
  if (condition.op === 'contains') {
    if (Array.isArray(actual)) return actual.map(String).includes(String(condition.value));
    return String(actual ?? '').toLowerCase().includes(String(condition.value).toLowerCase());
  }
  const same = typeof condition.value === 'boolean'
    ? actual === condition.value
    : String(actual ?? '') === String(condition.value);
  return condition.op === 'equals' ? same : !same;
}

export function visibleFormFields(schema: FormSchema, answers: FormAnswers): FormField[] {
  return schema.fields.filter((field) => conditionMatches(field.condition, answers));
}

function sanitiseAnswer(field: FormField, value: unknown): unknown {
  if (field.type === 'display') return undefined;
  if (field.type === 'text' || field.type === 'long_text') {
    const text = String(value ?? '').trim();
    const max = field.type === 'long_text' ? 20_000 : 1_000;
    if (text.length > max) throw new Error(`${field.label} is too long.`);
    return text;
  }
  if (field.type === 'number') {
    if (value === '' || value === undefined || value === null) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number.`);
    return number;
  }
  if (field.type === 'date') {
    const date = String(value ?? '');
    if (!date) return '';
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined;
    if (!match || !parsed || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
      throw new Error(`${field.label} must be a valid date.`);
    }
    return date;
  }
  if (field.type === 'yes_no' || field.type === 'acknowledgement') {
    if (value === '' || value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') throw new Error(`${field.label} must be answered yes or no.`);
    return value;
  }
  if (field.type === 'single_choice') {
    const selected = String(value ?? '');
    if (selected && !field.options?.some((option) => option.value === selected)) throw new Error(`${field.label} contains an invalid choice.`);
    return selected;
  }
  if (field.type === 'multiple_choice') {
    if (value === undefined || value === null || value === '') return [];
    if (!Array.isArray(value) || value.length > 50) throw new Error(`${field.label} must be a list of choices.`);
    const selected = [...new Set(value.map(String))];
    if (selected.some((item) => !field.options?.some((option) => option.value === item))) throw new Error(`${field.label} contains an invalid choice.`);
    return selected;
  }
  if (field.type === 'file') {
    if (value === undefined || value === null || value === '') return [];
    if (!Array.isArray(value) || value.length > 10 || value.some((item) => !/^doc_[A-Za-z0-9_-]+$/.test(String(item)))) {
      throw new Error(`${field.label} contains an invalid document reference.`);
    }
    return [...new Set(value.map(String))];
  }
  return undefined;
}

export function validateFormAnswers(schema: FormSchema, value: unknown, options: { partial?: boolean } = {}): FormAnswers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Answers must be an object.');
  const incoming = value as FormAnswers;
  const known = new Set(schema.fields.map((field) => field.key));
  const unknown = Object.keys(incoming).find((key) => !known.has(key));
  if (unknown) throw new Error(`Unknown form answer ${unknown}.`);
  const visible = new Set(visibleFormFields(schema, incoming).map((field) => field.key));
  const hiddenAnswer = Object.keys(incoming).find((key) => !visible.has(key) && answered(incoming[key]));
  if (hiddenAnswer) throw new Error(`Hidden field ${hiddenAnswer} cannot be submitted.`);
  const clean: FormAnswers = {};
  for (const field of schema.fields) {
    if (!visible.has(field.key) || field.type === 'display') continue;
    const answer = sanitiseAnswer(field, incoming[field.key]);
    if (!options.partial && field.required && !answered(answer)) throw new Error(`${field.label} is required.`);
    if (!options.partial && field.required && field.type === 'acknowledgement' && answer !== true) throw new Error(`${field.label} must be acknowledged.`);
    if (answered(answer) || Array.isArray(answer)) clean[field.key] = answer;
  }
  return clean;
}
