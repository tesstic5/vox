import type { LocationDoc, ProviderDoc, ServiceDoc } from './practice';

type InputError = { error: string; param?: string };
export type InputResult<T> = { value: T } | InputError;
type Mode = 'create' | 'update';
type Raw = Record<string, unknown>;
type Field<T> = { present: boolean; value?: T; error?: string; param?: string };

function isRecord(value: unknown): value is Raw {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownField(body: Raw, allowed: ReadonlySet<string>): InputError | null {
  const key = Object.keys(body).find((candidate) => !allowed.has(candidate));
  return key ? { error: `\`${key}\` is not supported.`, param: key } : null;
}

function firstError(fields: Field<unknown>[]): InputError | null {
  const field = fields.find((candidate) => candidate.error);
  return field ? { error: field.error!, param: field.param } : null;
}

function text(
  body: Raw,
  key: string,
  options: { required?: boolean; max: number; lower?: boolean; clearable?: boolean }
): Field<string> {
  if (!(key in body)) return { present: false };
  if (body[key] === null && options.clearable) return { present: true };
  if (typeof body[key] !== 'string') return { present: true, error: `\`${key}\` must be a string.`, param: key };
  let value = body[key].trim();
  if (options.lower) value = value.toLowerCase();
  if (!value && options.required) return { present: true, error: `\`${key}\` is required.`, param: key };
  if (value.length > options.max) return { present: true, error: `\`${key}\` must be at most ${options.max} characters.`, param: key };
  return { present: true, value: value || undefined };
}

function boolean(body: Raw, key: string): Field<boolean> {
  if (!(key in body)) return { present: false };
  if (typeof body[key] !== 'boolean') return { present: true, error: `\`${key}\` must be true or false.`, param: key };
  return { present: true, value: body[key] };
}

function number(
  body: Raw,
  key: string,
  options: { min: number; max: number; integer?: boolean; clearable?: boolean }
): Field<number> {
  if (!(key in body)) return { present: false };
  if (body[key] === null && options.clearable) return { present: true };
  if (typeof body[key] !== 'number' || !Number.isFinite(body[key])) {
    return { present: true, error: `\`${key}\` must be a finite number.`, param: key };
  }
  const value = body[key];
  if (options.integer && !Number.isInteger(value)) return { present: true, error: `\`${key}\` must be a whole number.`, param: key };
  if (value < options.min || value > options.max) {
    return { present: true, error: `\`${key}\` must be between ${options.min} and ${options.max}.`, param: key };
  }
  return { present: true, value };
}

function ids(body: Raw, key: string): Field<string[]> {
  if (!(key in body)) return { present: false };
  if (!Array.isArray(body[key])) return { present: true, error: `\`${key}\` must be an array of IDs.`, param: key };
  if (body[key].length > 200) return { present: true, error: `\`${key}\` may contain at most 200 IDs.`, param: key };
  const values: string[] = [];
  for (const item of body[key]) {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > 200) {
      return { present: true, error: `Every value in \`${key}\` must be a non-empty ID of at most 200 characters.`, param: key };
    }
    values.push(item.trim());
  }
  if (new Set(values).size !== values.length) return { present: true, error: `\`${key}\` cannot contain duplicate IDs.`, param: key };
  return { present: true, value: values };
}

const PROVIDER_FIELDS = new Set(['name', 'title', 'email', 'phone', 'colour', 'serviceIds', 'locationIds', 'active']);

export function validateProviderInput(raw: unknown, mode: Mode): InputResult<Partial<ProviderDoc> & { name?: string }> {
  if (!isRecord(raw)) return { error: 'Request body must be an object.', param: 'body' };
  const unknown = unknownField(raw, PROVIDER_FIELDS);
  if (unknown) return unknown;
  if (mode === 'update' && Object.keys(raw).length === 0) return { error: 'Provide at least one provider field to change.', param: 'body' };

  const name = text(raw, 'name', { required: true, max: 120 });
  const title = text(raw, 'title', { max: 120, clearable: true });
  const email = text(raw, 'email', { max: 254, lower: true, clearable: true });
  const phone = text(raw, 'phone', { max: 40, clearable: true });
  const colour = text(raw, 'colour', { max: 32, clearable: true });
  const serviceIds = ids(raw, 'serviceIds');
  const locationIds = ids(raw, 'locationIds');
  const active = boolean(raw, 'active');
  const error = firstError([name, title, email, phone, colour, serviceIds, locationIds, active]);
  if (error) return error;
  if (mode === 'create' && !name.present) return { error: '`name` is required.', param: 'name' };
  if (email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) return { error: '`email` must be a valid email address.', param: 'email' };
  if (colour.value && !/^(?:#[0-9a-f]{3,8}|[a-z][a-z0-9_-]{0,31})$/i.test(colour.value)) {
    return { error: '`colour` must be a CSS hex colour or a short colour token.', param: 'colour' };
  }

  const value: Partial<ProviderDoc> & { name?: string } = {};
  if (name.present) value.name = name.value;
  if (title.present) value.title = title.value;
  if (email.present) value.email = email.value;
  if (phone.present) value.phone = phone.value;
  if (colour.present) value.colour = colour.value;
  if (serviceIds.present) value.serviceIds = serviceIds.value;
  if (locationIds.present) value.locationIds = locationIds.value;
  if (active.present) value.active = active.value;
  return { value };
}

const SERVICE_FIELDS = new Set([
  'name', 'code', 'description', 'durationMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes',
  'price', 'taxRatePct', 'colour', 'slotStepMinutes', 'capacity', 'recallDays', 'active',
]);

export function validateServiceInput(raw: unknown, mode: Mode): InputResult<Partial<ServiceDoc> & { name?: string }> {
  if (!isRecord(raw)) return { error: 'Request body must be an object.', param: 'body' };
  const unknown = unknownField(raw, SERVICE_FIELDS);
  if (unknown) return unknown;
  if (mode === 'update' && Object.keys(raw).length === 0) return { error: 'Provide at least one service field to change.', param: 'body' };

  const name = text(raw, 'name', { required: true, max: 120 });
  const code = text(raw, 'code', { max: 50, clearable: true });
  const description = text(raw, 'description', { max: 2_000, clearable: true });
  const colour = text(raw, 'colour', { max: 32, clearable: true });
  const durationMinutes = number(raw, 'durationMinutes', { min: 5, max: 1_440, integer: true });
  const bufferBeforeMinutes = number(raw, 'bufferBeforeMinutes', { min: 0, max: 1_440, integer: true });
  const bufferAfterMinutes = number(raw, 'bufferAfterMinutes', { min: 0, max: 1_440, integer: true });
  const price = number(raw, 'price', { min: 0, max: 10_000_000 });
  const taxRatePct = number(raw, 'taxRatePct', { min: 0, max: 100, clearable: true });
  const slotStepMinutes = number(raw, 'slotStepMinutes', { min: 5, max: 1_440, integer: true, clearable: true });
  const capacity = number(raw, 'capacity', { min: 1, max: 10_000, integer: true, clearable: true });
  const recallDays = number(raw, 'recallDays', { min: 0, max: 3_650, integer: true, clearable: true });
  const active = boolean(raw, 'active');
  const error = firstError([name, code, description, colour, durationMinutes, bufferBeforeMinutes, bufferAfterMinutes, price, taxRatePct, slotStepMinutes, capacity, recallDays, active]);
  if (error) return error;
  if (mode === 'create' && !name.present) return { error: '`name` is required.', param: 'name' };
  if (colour.value && !/^(?:#[0-9a-f]{3,8}|[a-z][a-z0-9_-]{0,31})$/i.test(colour.value)) {
    return { error: '`colour` must be a CSS hex colour or a short colour token.', param: 'colour' };
  }

  const value: Partial<ServiceDoc> & { name?: string } = {};
  if (name.present) value.name = name.value;
  if (code.present) value.code = code.value;
  if (description.present) value.description = description.value;
  if (colour.present) value.colour = colour.value;
  if (durationMinutes.present) value.durationMinutes = durationMinutes.value;
  if (bufferBeforeMinutes.present) value.bufferBeforeMinutes = bufferBeforeMinutes.value;
  if (bufferAfterMinutes.present) value.bufferAfterMinutes = bufferAfterMinutes.value;
  if (price.present) value.price = price.value;
  if (taxRatePct.present) value.taxRatePct = taxRatePct.value;
  if (slotStepMinutes.present) value.slotStepMinutes = slotStepMinutes.value;
  if (capacity.present) value.capacity = capacity.value;
  if (recallDays.present) value.recallDays = recallDays.value || undefined;
  if (active.present) value.active = active.value;
  return { value };
}

const LOCATION_FIELDS = new Set(['name', 'address', 'timezone', 'active']);

export function validateLocationInput(raw: unknown, mode: Mode): InputResult<Partial<LocationDoc> & { name?: string }> {
  if (!isRecord(raw)) return { error: 'Request body must be an object.', param: 'body' };
  const unknown = unknownField(raw, LOCATION_FIELDS);
  if (unknown) return unknown;
  if (mode === 'update' && Object.keys(raw).length === 0) return { error: 'Provide at least one location field to change.', param: 'body' };

  const name = text(raw, 'name', { required: true, max: 120 });
  const address = text(raw, 'address', { max: 500, clearable: true });
  const timezone = text(raw, 'timezone', { max: 100 });
  const active = boolean(raw, 'active');
  const error = firstError([name, address, timezone, active]);
  if (error) return error;
  if (mode === 'create' && !name.present) return { error: '`name` is required.', param: 'name' };
  if (timezone.present && !timezone.value) return { error: '`timezone` cannot be empty.', param: 'timezone' };

  const value: Partial<LocationDoc> & { name?: string } = {};
  if (name.present) value.name = name.value;
  if (address.present) value.address = address.value;
  if (timezone.present) value.timezone = timezone.value;
  if (active.present) value.active = active.value;
  return { value };
}
