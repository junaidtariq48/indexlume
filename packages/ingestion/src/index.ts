import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';

export * from './projection.js';
export * from './crypto.js';

const MAGIC = Buffer.from('OSCU1');
const CHUNK_BYTES = 64 * 1024;

export type UploadFormat = 'CSV' | 'JSONL';
export type ParsedRow = Record<string, unknown>;

export async function encryptStagedFile(
  path: string,
  plaintext: Buffer,
  base64Key: string,
): Promise<void> {
  const key = Buffer.from(base64Key, 'base64');
  const output: Buffer[] = [MAGIC];
  for (let offset = 0, index = 0; offset < plaintext.length; index += 1) {
    const chunk = plaintext.subarray(offset, offset + CHUNK_BYTES);
    offset += chunk.length;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`osc-upload:${index}`));
    const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encrypted.length);
    output.push(length, nonce, cipher.getAuthTag(), encrypted);
  }
  await writeFile(path, Buffer.concat(output), { mode: 0o600, flag: 'wx' });
}

export async function* decryptStagedFile(
  path: string,
  base64Key: string | string[],
): AsyncGenerator<Buffer> {
  const keys = (Array.isArray(base64Key) ? base64Key : [base64Key]).map(
    (value) => Buffer.from(value, 'base64'),
  );
  const file = await open(path, 'r');
  let position = 0;
  try {
    const magic = Buffer.alloc(MAGIC.length);
    if (
      (await file.read(magic, 0, magic.length, position)).bytesRead !==
        magic.length ||
      !magic.equals(MAGIC)
    )
      throw new Error('Invalid staged upload');
    position += magic.length;
    for (let index = 0; ; index += 1) {
      const length = Buffer.alloc(4);
      const header = await file.read(length, 0, 4, position);
      if (header.bytesRead === 0) break;
      if (header.bytesRead !== 4) throw new Error('Truncated staged upload');
      position += 4;
      const size = length.readUInt32BE();
      if (size > CHUNK_BYTES) throw new Error('Invalid staged upload chunk');
      const nonce = Buffer.alloc(12);
      const tag = Buffer.alloc(16);
      const ciphertext = Buffer.alloc(size);
      for (const target of [nonce, tag, ciphertext]) {
        const read = await file.read(target, 0, target.length, position);
        if (read.bytesRead !== target.length)
          throw new Error('Truncated staged upload');
        position += target.length;
      }
      let decrypted: Buffer | undefined;
      for (const key of keys) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, nonce);
          decipher.setAAD(Buffer.from(`osc-upload:${index}`));
          decipher.setAuthTag(tag);
          decrypted = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]);
          break;
        } catch {
          // Staged upload v1 has no key identifier; try the configured keyring.
        }
      }
      if (!decrypted)
        throw new Error('Staged upload requires an unavailable key');
      yield decrypted;
    }
  } finally {
    await file.close();
  }
}

export async function* bufferChunks(buffer: Buffer): AsyncGenerator<Buffer> {
  yield buffer;
}

export async function* parseRows(
  chunks: AsyncIterable<Buffer>,
  format: UploadFormat,
): AsyncGenerator<ParsedRow> {
  if (format === 'JSONL') {
    yield* parseJsonLines(chunks);
    return;
  }
  yield* parseCsv(chunks);
}

async function* parseJsonLines(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<ParsedRow> {
  let pending = '';
  for await (const chunk of chunks) {
    pending += chunk.toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) yield parseObject(line);
  }
  if (pending.trim()) yield parseObject(pending);
}

function parseObject(line: string): ParsedRow {
  const value: unknown = JSON.parse(line);
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw new Error('Every JSONL line must be an object');
  return value as ParsedRow;
}

async function* parseCsv(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<ParsedRow> {
  let headers: string[] | undefined;
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let pendingQuote = false;
  const emit = (): ParsedRow | undefined => {
    row.push(field);
    field = '';
    if (!headers) {
      headers = row.map((item) => item.trim());
      if (!headers.length || headers.some((item) => !item))
        throw new Error('CSV header contains an empty field');
      if (new Set(headers).size !== headers.length)
        throw new Error('CSV headers must be unique');
      row = [];
      return;
    }
    if (row.length !== headers.length)
      throw new Error('CSV row does not match the header');
    const value = Object.fromEntries(
      headers.map((header, index) => [header, coerceCsv(row[index] ?? '')]),
    );
    row = [];
    return value;
  };
  for await (const chunk of chunks) {
    for (const character of chunk.toString('utf8')) {
      if (pendingQuote) {
        pendingQuote = false;
        if (character === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (character === '"') pendingQuote = true;
        else field += character;
        continue;
      }
      if (character === '"' && !field) {
        quoted = true;
        continue;
      }
      if (character === ',') {
        row.push(field);
        field = '';
        continue;
      }
      if (character === '\n') {
        const value = emit();
        if (value) yield value;
        continue;
      }
      if (character !== '\r') field += character;
    }
  }
  if (quoted && !pendingQuote)
    throw new Error('CSV contains an unterminated quote');
  if (field || row.length) {
    const value = emit();
    if (value) yield value;
  }
  if (!headers) throw new Error('CSV header is required');
}

function coerceCsv(value: string): unknown {
  if (value === '') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function inferFields(
  rows: ParsedRow[],
): Array<{ name: string; type: string }> {
  const names = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return names.map((name) => ({
    name,
    type: inferType(
      rows
        .map((row) => row[name])
        .filter((value) => value !== null && value !== undefined),
    ),
  }));
}

function inferType(values: unknown[]): string {
  if (!values.length) return 'string';
  if (values.every((value) => typeof value === 'boolean')) return 'bool';
  if (
    values.every(
      (value) => typeof value === 'number' && Number.isInteger(value),
    )
  )
    return 'int64';
  if (values.every((value) => typeof value === 'number')) return 'float';
  if (
    values.every(
      (value) =>
        Array.isArray(value) && value.every((item) => typeof item === 'string'),
    )
  )
    return 'string[]';
  return 'string';
}
