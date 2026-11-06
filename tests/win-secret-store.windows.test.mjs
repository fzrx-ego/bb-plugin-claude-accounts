import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('Windows DPAPI round-trip, concurrent saves, and corrupt ciphertext', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpapi-live-'));
  process.env.LOCALAPPDATA = root;
  try {
    const { writeWinSecret, readWinSecret, deleteWinSecret } = await import('../lib/win-secret-store.ts');
    const value = 'Synthetic credential: Привет 🌍 ' + 'x'.repeat(100_000);
    await writeWinSecret('test', 'account', value);
    assert.equal(await readWinSecret('test', 'account'), value);
    const dir = path.join(root, 'bb-claude-accounts', 'secrets');
    const file = path.join(dir, 'test__account.dpapi');
    assert.ok(!(await readFile(file)).includes(Buffer.from('Synthetic credential')));
    const values = ['parallel A', 'parallel B', 'parallel C'];
    await Promise.all(values.map(v => writeWinSecret('test', 'account', v)));
    assert.ok(values.includes(await readWinSecret('test', 'account')));
    assert.deepEqual(await readdir(dir), ['test__account.dpapi']);
    await writeFile(file, Buffer.from('invalid DPAPI blob'));
    assert.equal(await readWinSecret('test', 'account'), null);
    assert.equal(await deleteWinSecret('test', 'account'), true);
    assert.equal(await readWinSecret('test', 'account'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
