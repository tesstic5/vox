import { Icons } from '@/components/icons';
import { LinkButton, Section } from '@/components/ui';

export const metadata = { title: 'Deployment examples', description: 'Capability examples without invented customer endorsements or outcome metrics.' };

export default function CustomersPage() {
  return (
    <Section className="pb-20 pt-16 sm:pt-24">
      <div className="container-wide grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)]">
        <div className="max-w-3xl"><div className="eyebrow mb-4">Examples, not endorsements</div><h1 className="h1 text-balance">No customer outcome is claimed without evidence.</h1><p className="lede mt-6 max-w-[62ch]">Earlier sample stories and aggregate metrics have been removed from the public surface. Use the workflow pages to understand what the application can do, then validate it with your own data and providers.</p><div className="mt-8 flex flex-wrap gap-3"><LinkButton href="/solutions" variant="brand">Explore workflows</LinkButton><LinkButton href="/signup" variant="ghost">Create a test workspace</LinkButton></div></div>
        <aside className="panel p-6"><Icons.users size={20} className="text-brand-700" /><h2 className="mt-4 text-[16px] font-semibold text-slate-900">Reference policy</h2><p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">Names, logos, call volumes, savings, uptime and conversion changes should appear here only with a verifiable customer record and permission. This build includes none, so it presents none.</p></aside>
      </div>
    </Section>
  );
}
