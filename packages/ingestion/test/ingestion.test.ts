import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bufferChunks,
  decryptStagedFile,
  encryptStagedFile,
  parseRows,
} from '../src/index.js';

describe('upload ingestion', () => {
  it('parses quoted CSV and JSONL rows', async () => {
    const csv = 'id,title,price\n1,"Keyboard, compact",89\n2,Mouse,25\n';
    const csvRows = [];
    for await (const row of parseRows(bufferChunks(Buffer.from(csv)), 'CSV'))
      csvRows.push(row);
    expect(csvRows).toEqual([
      { id: 1, title: 'Keyboard, compact', price: 89 },
      { id: 2, title: 'Mouse', price: 25 },
    ]);
    const jsonRows = [];
    for await (const row of parseRows(
      bufferChunks(Buffer.from('{"id":"a"}\n{"id":"b"}\n')),
      'JSONL',
    ))
      jsonRows.push(row);
    expect(jsonRows).toHaveLength(2);
  });

  it('encrypts staged bytes and streams an authenticated round trip', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'osc-ingest-'));
    const path = join(directory, 'upload.enc');
    const key = Buffer.alloc(32, 9).toString('base64');
    const input = Buffer.alloc(150_000, 7);
    await encryptStagedFile(path, input, key);
    expect((await readFile(path)).includes(input.subarray(0, 100))).toBe(false);
    const output = [];
    for await (const chunk of decryptStagedFile(path, key)) output.push(chunk);
    expect(Buffer.concat(output)).toEqual(input);
  });
});
