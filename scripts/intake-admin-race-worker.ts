import fs from 'node:fs';
import { closeStore } from '../lib/server/db';
import { createClientRelationship, createCustomFieldDefinition, setCustomFieldValue } from '../lib/server/intake-admin';
import { updateClientStructuredAddress } from '../lib/server/clients';

const [action, index, barrier, orgId, first, second, third] = process.argv.slice(2);
function waitFor(file: string, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

async function main() {
  fs.writeFileSync(`${barrier}.${index}.ready`, 'ready');
  waitFor(`${barrier}.go`);
  try {
    if (action === 'relationship') {
      const row = createClientRelationship({ orgId, clientId: first, contactId: second, relationshipType: third as 'guardian', guardian: true, actor: `worker-${index}` });
      console.log(JSON.stringify({ ok: true, id: row.id, revision: row.revision }));
      return;
    }
    if (action === 'definition') {
      const row = createCustomFieldDefinition({ orgId, targetType: 'client', key: first, label: 'Concurrent field', valueType: 'text', actor: `worker-${index}` });
      console.log(JSON.stringify({ ok: true, id: row.id, revision: row.revision }));
      return;
    }
    if (action === 'value') {
      const row = setCustomFieldValue({ orgId, definitionId: first, targetType: 'client', targetId: second, value: third, actor: `worker-${index}`, expectedRevision: null });
      console.log(JSON.stringify({ ok: true, id: row.id, value: row.value, revision: row.revision }));
      return;
    }
    if (action === 'address') {
      const row = updateClientStructuredAddress({
        orgId,
        id: first,
        expectedRevision: Number(second),
        actor: `worker-${index}`,
        address: { line1: `${third} ${index}`, city: 'Race City', postcode: 'RC1 1AA', countryCode: 'GB' },
      });
      console.log(JSON.stringify({ ok: true, id: row.id, address: row.address, revision: row.revision }));
      return;
    }
    throw new Error(`unknown action ${action}`);
  } catch (error) {
    console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  }
}

void main().then(() => closeStore()).catch((error) => {
  console.error(error);
  try { closeStore(); } catch { /* ignore */ }
  process.exit(1);
});
