import { NextResponse, type NextRequest } from 'next/server';
import { fail, ok, readJson, requireAuth } from '@/lib/server/api';
import { workspaceProfileView, saveBusinessProfile } from '@/lib/server/business-profile';
import {
  BUSINESS_TYPE_OPTIONS,
  MODULES,
  businessTypeLabel,
  isBusinessType,
  isModuleId,
  moduleDependencyErrors,
  modulesWithDependencies,
  recommendedModules,
  recommendedTermPack,
  type BusinessHoursRow,
  type BusinessType,
  type ModuleId,
} from '@/lib/business';
import { TERM_PACK_IDS, describeTermPack, type TermPackId } from '@/lib/terms';
import { CURRENCIES } from '@/lib/server/money';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function payload(orgId: string, canEdit: boolean) {
  const view = workspaceProfileView(orgId);
  return {
    ...view,
    canEdit,
    businessTypes: BUSINESS_TYPE_OPTIONS,
    modules: MODULES,
    vocabularies: TERM_PACK_IDS.map((id) => ({ id, description: describeTermPack(id) })),
    recommendations: Object.fromEntries(
      BUSINESS_TYPE_OPTIONS.map((option) => [
        option.id,
        {
          label: businessTypeLabel(option.id),
          modules: recommendedModules(option.id),
          termPack: recommendedTermPack(option.id),
        },
      ])
    ),
    currencies: [...CURRENCIES],
  };
}

function mayEdit(ctx: { auth: string; user?: { role?: string } }): boolean {
  return ctx.auth === 'session' && ['owner', 'admin'].includes(ctx.user?.role ?? '');
}

export async function GET(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  return ok(payload(ctx.orgId, mayEdit(ctx)), { requestId: ctx.requestId });
}

type PatchBody = {
  type?: BusinessType;
  otherDescription?: string;
  modules?: ModuleId[];
  useRecommendedModules?: boolean;
  country?: string;
  timezone?: string;
  currency?: string;
  businessHours?: BusinessHoursRow[];
  termPack?: TermPackId;
};

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateHours(value: unknown): { rows?: BusinessHoursRow[]; error?: string } {
  if (!Array.isArray(value)) return { error: '`businessHours` must be an array.' };
  if (value.length > 7) return { error: '`businessHours` can contain at most one row for each weekday.' };
  const seen = new Set<number>();
  const rows: BusinessHoursRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return { error: 'Each business-hours row must be an object.' };
    const row = raw as Partial<BusinessHoursRow>;
    const weekday = Number(row.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: 'Each `weekday` must be an integer from 0 (Sunday) to 6 (Saturday).' };
    if (seen.has(weekday)) return { error: `Weekday ${weekday} appears more than once.` };
    seen.add(weekday);
    const open = Boolean(row.open);
    const start = String(row.start ?? '');
    const end = String(row.end ?? '');
    if (open && (!CLOCK.test(start) || !CLOCK.test(end) || start >= end)) {
      return { error: `Open weekday ${weekday} needs valid start and end times, with start before end.` };
    }
    rows.push({ weekday, open, ...(open ? { start, end } : {}) });
  }
  return { rows: rows.sort((a, b) => a.weekday - b.weekday) };
}

function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireAuth(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!mayEdit(ctx)) {
    return fail('FORBIDDEN', 'Only a workspace owner or admin can change the business profile and modules.', {
      requestId: ctx.requestId,
    });
  }
  const body = await readJson<PatchBody>(req);
  if (body instanceof NextResponse) return body;

  if (body.type !== undefined && !isBusinessType(body.type)) {
    return fail('VALIDATION_ERROR', '`type` must be contractor, dental, physiotherapy or other.', {
      param: 'type',
      requestId: ctx.requestId,
    });
  }
  const current = workspaceProfileView(ctx.orgId).business;
  const type = body.type ?? current.type;
  const otherDescription = body.otherDescription === undefined ? undefined : String(body.otherDescription).trim();
  if (otherDescription !== undefined && otherDescription.length > 120) {
    return fail('VALIDATION_ERROR', 'The business description must be 120 characters or fewer.', {
      param: 'otherDescription',
      requestId: ctx.requestId,
    });
  }

  let modules: ModuleId[] | undefined;
  if (body.useRecommendedModules) {
    modules = modulesWithDependencies(recommendedModules(type));
  } else if (body.modules !== undefined) {
    if (!Array.isArray(body.modules) || body.modules.some((id) => !isModuleId(id))) {
      return fail('VALIDATION_ERROR', '`modules` contains an unknown module.', {
        param: 'modules',
        requestId: ctx.requestId,
      });
    }
    modules = [...new Set(body.modules)];
    const dependencies = moduleDependencyErrors(modules);
    if (dependencies.length) {
      const detail = dependencies
        .map((row) => `${row.module} needs ${row.missing.join(', ')}`)
        .join('; ');
      return fail('VALIDATION_ERROR', 'Select each module\'s required dependencies before saving.', {
        param: 'modules',
        detail,
        requestId: ctx.requestId,
      });
    }
  }

  let country: string | undefined;
  if (body.country !== undefined) {
    country = String(body.country).trim().toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) {
      return fail('VALIDATION_ERROR', '`country` must be a two-letter ISO country code.', {
        param: 'country',
        requestId: ctx.requestId,
      });
    }
  }

  let timezone: string | undefined;
  if (body.timezone !== undefined) {
    timezone = String(body.timezone).trim();
    if (timezone && !validTimezone(timezone)) {
      return fail('VALIDATION_ERROR', 'Use a valid IANA timezone, such as Europe/London or Asia/Karachi.', {
        param: 'timezone',
        requestId: ctx.requestId,
      });
    }
  }

  let currency: string | undefined;
  if (body.currency !== undefined) {
    currency = String(body.currency).trim().toUpperCase();
    if (currency && !(CURRENCIES as readonly string[]).includes(currency)) {
      return fail('VALIDATION_ERROR', `\`currency\` must be one of: ${CURRENCIES.join(', ')}.`, {
        param: 'currency',
        requestId: ctx.requestId,
      });
    }
  }

  let businessHours: BusinessHoursRow[] | undefined;
  if (body.businessHours !== undefined) {
    const checked = validateHours(body.businessHours);
    if (checked.error) {
      return fail('VALIDATION_ERROR', checked.error, { param: 'businessHours', requestId: ctx.requestId });
    }
    businessHours = checked.rows;
  }

  if (body.termPack !== undefined && !TERM_PACK_IDS.includes(body.termPack)) {
    return fail('VALIDATION_ERROR', `\`termPack\` must be one of: ${TERM_PACK_IDS.join(', ')}.`, {
      param: 'termPack',
      requestId: ctx.requestId,
    });
  }

  saveBusinessProfile({
    orgId: ctx.orgId,
    actor: ctx.user?.email ?? 'dashboard',
    type: body.type,
    otherDescription,
    modules,
    country,
    timezone,
    currency,
    businessHours,
    termPack: body.termPack,
  });

  return ok(payload(ctx.orgId, true), { requestId: ctx.requestId });
}
