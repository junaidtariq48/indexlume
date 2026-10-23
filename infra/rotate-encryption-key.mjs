import { createPrismaClient } from '../packages/db/dist/index.js';
import {
  activeEncryptionKeyId,
  decryptEnvelope,
  encryptEnvelope,
  envelopeKeyId,
} from '../packages/ingestion/dist/index.js';

const activeKey = process.env.APP_ENCRYPTION_KEY;
const previousKeys = process.env.APP_ENCRYPTION_KEY_PREVIOUS ?? '';
const apply = process.argv.includes('--apply');

if (!activeKey) throw new Error('APP_ENCRYPTION_KEY is required');
if (!process.env.APP_HMAC_KEY) {
  throw new Error(
    'APP_HMAC_KEY must be set to a stable independent key before encryption rotation',
  );
}
if (!process.env.SEARCH_KEY_PEPPER) {
  throw new Error(
    'SEARCH_KEY_PEPPER must be set to a stable independent key before encryption rotation',
  );
}

const activeKeyId = activeEncryptionKeyId(activeKey);
const prisma = createPrismaClient(process.env.DATABASE_URL);
const specifications = [
  {
    name: 'Typesense credentials',
    model: 'typesenseConnection',
    field: 'encryptedApiKey',
    purpose: 'typesense-api-key',
  },
  {
    name: 'PostgreSQL credentials',
    model: 'dataSource',
    field: 'encryptedConfig',
    purpose: 'postgres-config',
  },
  {
    name: 'Projection change keys',
    model: 'projectionChangeEvent',
    field: 'relationKeyCiphertext',
    purpose: 'projection-relation-key',
  },
  {
    name: 'Projection dirty-root keys',
    model: 'projectionDirtyRoot',
    field: 'rootKeyCiphertext',
    purpose: 'projection-root-key',
  },
  {
    name: 'Projection dependency keys',
    model: 'projectionDependencyEdge',
    field: 'rootKeyCiphertext',
    purpose: 'projection-root-key',
  },
  {
    name: 'Projection document keys',
    model: 'projectionDocumentState',
    field: 'rootKeyCiphertext',
    purpose: 'projection-root-key',
  },
  {
    name: 'Projection reconciliation keys',
    model: 'projectionReconcileCandidate',
    field: 'rootKeyCiphertext',
    purpose: 'projection-root-key',
  },
];

const report = [];
try {
  for (const specification of specifications) {
    report.push(await rotateModel(specification));
  }
  console.log(
    JSON.stringify(
      {
        event: apply
          ? 'encryption_key_rotation_completed'
          : 'encryption_key_rotation_dry_run_completed',
        activeKeyId,
        mode: apply ? 'apply' : 'dry-run',
        records: report,
        nextStep: apply
          ? 'Restart API and worker, verify connectors and projections, then remove APP_ENCRYPTION_KEY_PREVIOUS.'
          : 'Stop API and worker writes, back up metadata, then rerun with --apply.',
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}

async function rotateModel({ name, model, field, purpose }) {
  const delegate = prisma[model];
  let cursor;
  let scanned = 0;
  let alreadyActive = 0;
  let rewrapped = 0;
  while (true) {
    const rows = await delegate.findMany({
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, [field]: true },
    });
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      const envelope = row[field];
      if (!envelope) continue;
      scanned += 1;
      if (envelopeKeyId(envelope) === activeKeyId) {
        alreadyActive += 1;
        continue;
      }
      const plaintext = decryptEnvelope(
        purpose,
        envelope,
        activeKey,
        previousKeys,
      );
      if (apply) {
        await delegate.update({
          where: { id: row.id },
          data: { [field]: encryptEnvelope(purpose, plaintext, activeKey) },
        });
      }
      plaintext.fill(0);
      rewrapped += 1;
    }
  }
  return { name, scanned, alreadyActive, rewrapped };
}
