/**
 * Privacy guards for the public demo:
 *  - kv 'master_resume' is read only by route handlers that do not exist in demo (worker, agent, telegram, inngest).
 *  - middleware 404s those machine endpoints when DEMO_MODE=1, and the chat API still needs a session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const middlewareSrc = readFileSync(join(ROOT, 'middleware.ts'), 'utf8');
const blockedSrc = middlewareSrc.match(/const DEMO_BLOCKED = \/(.+)\/;/);

test('middleware declares the demo block list', () => {
  assert.ok(blockedSrc, 'DEMO_BLOCKED regex not found in middleware.ts');
});

const DEMO_BLOCKED = new RegExp(blockedSrc ? blockedSrc[1] : '$^');
const apiPath = (file: string) => '/' + relative(join(ROOT, 'app'), file).replace(/\\/g, '/').replace(/\/route\.\w+$/, '');

test('DEMO_BLOCKED covers the machine endpoints and nothing the chat needs', () => {
  for (const p of ['/api/worker', '/api/worker/claim', '/api/agent/run', '/api/telegram', '/api/inngest']) assert.ok(DEMO_BLOCKED.test(p), p);
  for (const p of ['/api/chat', '/api/spend', '/api/workers-guide', '/api/companies', '/api/cron/daily']) assert.ok(!DEMO_BLOCKED.test(p), p);
});

test('no route reachable in demo reads kv master_resume', () => {
  const files = routeFiles(join(ROOT, 'app', 'api'));
  assert.ok(files.length > 0);
  const offenders = files.filter((f) => /master_resume/.test(readFileSync(f, 'utf8')) && !DEMO_BLOCKED.test(apiPath(f)));
  assert.deepEqual(offenders.map((f) => relative(ROOT, f)), []);
});

test('the chat path (route, orchestrator, router) never touches master_resume', () => {
  for (const f of ['app/api/chat/route.ts', 'src/agents/orchestrator.ts', 'src/agents/router.ts']) {
    assert.ok(!/master_resume/.test(readFileSync(join(ROOT, f), 'utf8')), f);
  }
});

test('middleware: demo 404s machine endpoints; chat still needs a session', async (t) => {
  let mods: [typeof import('next/server'), typeof import('../middleware')];
  try {
    mods = await Promise.all([import('next/server'), import('../middleware')]);
  } catch {
    t.skip('next is not installed here; the DEMO_BLOCKED grep tests above still cover the block list');
    return;
  }
  const [{ NextRequest }, { middleware }] = mods;
  const prev = { demo: process.env.DEMO_MODE, secret: process.env.SIGNING_SECRET };
  try {
    process.env.SIGNING_SECRET = 'privacy-test-secret-0123456789abcdef';
    process.env.DEMO_MODE = '1';
    for (const p of ['/api/worker/claim', '/api/agent/x', '/api/telegram', '/api/inngest']) {
      const r = await middleware(new NextRequest(`http://localhost${p}`, { method: 'POST' }));
      assert.equal(r.status, 404, p);
    }
    const chat = await middleware(new NextRequest('http://localhost/api/chat', { method: 'POST' }));
    assert.equal(chat.status, 401);
    process.env.DEMO_MODE = '';
    const worker = await middleware(new NextRequest('http://localhost/api/worker/claim', { method: 'POST' }));
    assert.notEqual(worker.status, 404, 'outside demo the worker endpoint authenticates itself');
  } finally {
    if (prev.demo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = prev.demo;
    if (prev.secret === undefined) delete process.env.SIGNING_SECRET;
    else process.env.SIGNING_SECRET = prev.secret;
  }
});
