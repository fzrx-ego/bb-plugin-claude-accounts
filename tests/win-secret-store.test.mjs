import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'dpapi-test-'));
process.env.LOCALAPPDATA = root;
after(() => rm(root, { recursive: true, force: true }));
let behavior = 'success';
const calls = [];
mock.module('node:child_process', { namedExports: { spawn(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
  calls.push({ command, args, options });
  const scenario = behavior;
  if (scenario === 'epipe') {
    queueMicrotask(() => child.stdin.emit('error', Object.assign(new Error('pipe closed'), { code: 'EPIPE' })));
  } else {
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => {
      if (scenario === 'failure') {
        child.stderr.write('protection failed');
        child.emit('close', 1);
      } else {
        child.stdout.write(scenario === 'empty' ? '' : scenario === 'invalid' ? 'invalid!' : Buffer.from('encrypted:' + input).toString('base64'));
        child.emit('close', 0);
      }
    });
  }
  return child;
} } });
const { writeWinSecret } = await import('../lib/win-secret-store.ts');
const secretDir = path.join(root, 'bb-claude-accounts', 'secrets');
const target = path.join(secretDir, 'service__account.dpapi');

test('protect passes secrets only through stdin and stores the returned ciphertext', async () => {
  await writeWinSecret('service', 'account', 'synthetic secret');
  assert.equal((await readFile(target)).toString(), 'encrypted:' + Buffer.from('synthetic secret').toString('base64'));
  assert.equal(calls[0].command, 'powershell.exe');
  assert.ok(!JSON.stringify(calls[0]).includes('synthetic secret'));
  assert.deepEqual(await readdir(path.dirname(secretDir)), ['secrets']);
});
for (const scenario of ['epipe', 'failure', 'empty', 'invalid']) {
  test(`${scenario} rejects without replacing a saved snapshot`, async () => {
    const previous = await readFile(target);
    behavior = scenario;
    await assert.rejects(writeWinSecret('service', 'account', 'replacement'));
    assert.deepEqual(await readFile(target), previous);
    assert.deepEqual(await readdir(secretDir), ['service__account.dpapi']);
  });
}
test('concurrent saves use independent temp files and leave one complete snapshot', async () => {
  behavior = 'success';
  const values = Array.from({ length: 20 }, (_, i) => `value ${i}`);
  await Promise.all(values.map(value => writeWinSecret('service', 'account', value)));
  const saved = (await readFile(target)).toString();
  assert.ok(values.some(value => saved === 'encrypted:' + Buffer.from(value).toString('base64')));
  assert.deepEqual(await readdir(secretDir), ['service__account.dpapi']);
});
