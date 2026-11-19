import { Section } from '@/components/ui';

export const metadata={title:'Use terms boundary',description:'Operational and legal responsibilities for a Voxera deployment.'};

export default function TermsPage(){return <Section className="pb-20 pt-16 sm:pt-24"><div className="container-wide max-w-4xl"><div className="eyebrow mb-4">Use terms</div><h1 className="h1 text-balance">The deployment operator must supply the contract.</h1><p className="lede mt-6 max-w-[64ch]">This repository does not itself sell a hosted service, promise availability, grant a compliance agreement or define provider charges. These boundary terms describe safe use of the application until reviewed operator terms replace them.</p><div className="mt-10 space-y-4">{[
['Authorised use','Use only workspaces and records you are authorised to access. Do not bypass tenant, role, verification, rate or provider controls.'],
['Calls and messages','Obtain required consent, identify automated systems where required, respect opt-outs and emergency limitations, and comply with local calling, recording and messaging law.'],
['Sensitive records','Do not process patient, payment or other regulated data until the actual deployment, providers, contracts and procedures have passed independent review.'],
['Providers and charges','Carrier, model, speech, email and payment services are separate. Their availability, fees, settlement, retention and terms are not guaranteed by application fields.'],
['No implied warranty or SLA','The code and test environment do not establish a production warranty, response time, service credit, certification or fitness for a regulated purpose.'],
['Operator responsibility','The operator must publish identity, support, privacy, retention, incident, backup and legal-contact details appropriate to the production environment.'],
].map(([title,text])=><section key={title} className="panel p-6"><h2 className="text-[16px] font-semibold text-slate-900">{title}</h2><p className="mt-2 text-[12.5px] leading-relaxed text-slateink-400">{text}</p></section>)}</div></div></Section>}
