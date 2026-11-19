import fs from 'node:fs';
import { find } from '../lib/server/db';
import { persistGeneratedDocument } from '../lib/server/clinical-documents';
import { createBodyChartTemplate } from '../lib/server/clinical/body-charts';
import type { UserDoc } from '../lib/server/auth';

async function main() {
  const email = process.env.VOXERA_EMAIL ?? 'jordan@northwind.dev';
  const user = find<UserDoc>('users', (row) => row.email.toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`fixture user ${email} not found`);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63606060f80f0001040100c9fe92ef0000000049454e44ae426082', 'hex');
  const source = await persistGeneratedDocument({
    orgId: user.orgId,
    ownerType: 'workspace',
    ownerId: user.orgId,
    title: 'HTTP body-chart source',
    category: 'phase4_body_chart_http_source',
    originalName: 'body-chart-http.png',
    mimeType: 'image/png',
    bytes: png,
    actor: user.email,
  });
  const made = createBodyChartTemplate({
    orgId: user.orgId,
    title: 'HTTP anterior body',
    sourceDocumentId: source.document.id,
    sourceDocumentVersionId: source.version.id,
    state: 'published',
    actorId: user.id,
    actorName: user.name,
  });
  if (!made.ok) throw new Error(made.error);
  const payload = { orgId: user.orgId, templateId: made.value.id, sourceDocumentId: source.document.id, sourceVersionId: source.version.id };
  if (process.env.VOXERA_BODY_CHART_SEED_OUT) fs.writeFileSync(process.env.VOXERA_BODY_CHART_SEED_OUT, JSON.stringify(payload));
  console.log(JSON.stringify(payload));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
