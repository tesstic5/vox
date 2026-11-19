import crypto from 'node:crypto';
import { documentMasterKey } from './document-config';

export type DocumentEnvelope = {
  algorithm: 'AES-256-GCM';
  version: 1;
  dataIv: string;
  dataAuthTag: string;
  wrappedKey: string;
  wrapIv: string;
  wrapAuthTag: string;
  aadSha256: string;
};

export type DocumentAad = {
  orgId: string;
  documentId: string;
  versionId: string;
  version: number;
  objectKey: string;
};

function aadBuffer(aad: DocumentAad) {
  return Buffer.from(JSON.stringify({
    orgId: aad.orgId,
    documentId: aad.documentId,
    versionId: aad.versionId,
    version: aad.version,
    objectKey: aad.objectKey,
  }), 'utf8');
}

export function encryptDocumentBytes(plaintext: Buffer, aad: DocumentAad): {
  ciphertext: Buffer;
  envelope: DocumentEnvelope;
  plaintextSha256: string;
  ciphertextSha256: string;
} {
  const dataKey = crypto.randomBytes(32);
  const dataIv = crypto.randomBytes(12);
  const aadBytes = aadBuffer(aad);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, dataIv);
  cipher.setAAD(aadBytes);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const dataAuthTag = cipher.getAuthTag();

  const wrapIv = crypto.randomBytes(12);
  const wrapper = crypto.createCipheriv('aes-256-gcm', documentMasterKey(), wrapIv);
  wrapper.setAAD(Buffer.from('voxera:clinical-document-dek:v1'));
  const wrappedKey = Buffer.concat([wrapper.update(dataKey), wrapper.final()]);
  dataKey.fill(0);

  return {
    ciphertext,
    envelope: {
      algorithm: 'AES-256-GCM',
      version: 1,
      dataIv: dataIv.toString('base64'),
      dataAuthTag: dataAuthTag.toString('base64'),
      wrappedKey: wrappedKey.toString('base64'),
      wrapIv: wrapIv.toString('base64'),
      wrapAuthTag: wrapper.getAuthTag().toString('base64'),
      aadSha256: crypto.createHash('sha256').update(aadBytes).digest('hex'),
    },
    plaintextSha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
    ciphertextSha256: crypto.createHash('sha256').update(ciphertext).digest('hex'),
  };
}

export function decryptDocumentBytes(ciphertext: Buffer, envelope: DocumentEnvelope, aad: DocumentAad): Buffer {
  if (envelope.algorithm !== 'AES-256-GCM' || envelope.version !== 1) throw new Error('unsupported document encryption envelope');
  const aadBytes = aadBuffer(aad);
  const aadHash = crypto.createHash('sha256').update(aadBytes).digest('hex');
  if (aadHash !== envelope.aadSha256) throw new Error('document envelope metadata does not match this object');

  const unwrapper = crypto.createDecipheriv('aes-256-gcm', documentMasterKey(), Buffer.from(envelope.wrapIv, 'base64'));
  unwrapper.setAAD(Buffer.from('voxera:clinical-document-dek:v1'));
  unwrapper.setAuthTag(Buffer.from(envelope.wrapAuthTag, 'base64'));
  const dataKey = Buffer.concat([unwrapper.update(Buffer.from(envelope.wrappedKey, 'base64')), unwrapper.final()]);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.dataIv, 'base64'));
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(Buffer.from(envelope.dataAuthTag, 'base64'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally {
    dataKey.fill(0);
  }
}
