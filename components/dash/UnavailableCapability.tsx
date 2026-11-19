import { Icons } from '@/components/icons';
import { LinkButton } from '@/components/ui';
import { PageHeader } from '@/components/dash/Shell';

export function UnavailableCapability({
  title,
  description,
  boundary,
  links = [],
}: {
  title: string;
  description: string;
  boundary: string;
  links?: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} desc={description} breadcrumb={[{ label: 'Dashboard', href: '/dashboard' }, { label: title }]} />
      <section className="mx-auto max-w-3xl rounded-2xl border border-amber-400/25 bg-amber-400/[0.055] p-6 sm:p-8" aria-labelledby="capability-boundary-title">
        <div className="flex items-start gap-4">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-amber-400/30 bg-amber-400/10 text-amber-800">
            <Icons.shield size={18} />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-800">Not available in this build</p>
            <h1 id="capability-boundary-title" className="mt-2 text-[18px] font-semibold text-slate-900">No simulated success state</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-slateink-300">{boundary}</p>
            {links.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2">
                {links.map((link) => (
                  <LinkButton key={link.href} href={link.href} variant="ghost" size="sm">
                    {link.label}
                  </LinkButton>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
