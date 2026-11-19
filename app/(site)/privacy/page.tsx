import { Section } from '@/components/ui';

export const metadata={title:'Privacy and data boundary',description:'Data handled by the current Voxera application and responsibilities left to the deployment operator.'};

const ITEMS=[
  ['Account and workspace data','The application stores account identity, signed sessions, business profile, team roles and the records users create inside a tenant-scoped database.'],
  ['Calls and communications','Call metadata, transcripts, tool outcomes, messages and optional provider recording URLs may be stored when those workflows are used. A recording URL exists only when a provider supplied one.'],
  ['Business and care records','Customer contact details, appointments, generic notes, invoices and field-service records may contain personal information. The operator decides the lawful purpose, access policy and retention period.'],
  ['Connected providers','Telephony, email, model, speech and payment data leaves the application only through providers the deployment configures. Their contracts and privacy practices apply separately.'],
  ['Public forms','Signup, booking, payment, estimate and contact forms store the information submitted to complete the requested workflow. Do not submit data the deployment has not been approved to handle.'],
  ['Exports and deletion','Owners can export workspace data and many records have tenant-scoped deletion paths. This is not a promise that provider copies, backups or legal retention obligations are erased automatically.'],
] as const;

export default function PrivacyPage(){return <Section className="pb-20 pt-16 sm:pt-24"><div className="container-wide"><div className="max-w-3xl"><div className="eyebrow mb-4">Privacy boundary</div><h1 className="h1 text-balance">Data handling depends on the deployment.</h1><p className="lede mt-6">This application description is not a jurisdiction-specific privacy notice. A real operator must identify itself, its lawful bases, retention schedule, subprocessors, contact channel and data-subject process.</p></div><div className="mt-12 grid gap-4 md:grid-cols-2">{ITEMS.map(([title,text])=><article key={title} className="panel p-6"><h2 className="text-[16px] font-semibold text-slate-900">{title}</h2><p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">{text}</p></article>)}</div><div className="mt-8 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-5 text-[12.5px] leading-relaxed text-amber-900">No certification, regional residency, zero-retention mode, training prohibition, statutory response time or automatic provider erasure is claimed here. Verify and document those matters independently.</div></div></Section>}
