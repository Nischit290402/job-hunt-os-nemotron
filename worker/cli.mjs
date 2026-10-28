#!/usr/bin/env node
/**
 * Job Hunt OS worker helper. Claude (your Claude Code scheduled task, or Claude Code on your laptop) runs these
 * commands; the jobhunt-worker skill says when. No dependencies: Node 18+, plus pdflatex and Python for resumes.
 *
 *   node worker/cli.mjs claim [n] [kind]          claim up to n tasks, optionally of one kind (judge, tailor, draft, coach)
 *   node worker/cli.mjs show <id...>              print instructions (once when shared), inputs and the answer schema
 *   node worker/cli.mjs answer <id> <file>        post a judge/draft answer (JSON) or a coach answer (text)
 *   node worker/cli.mjs answer-batch <file>       post many answers: {"<id>": {...answer...}, ...}
 *   node worker/cli.mjs kit                       download master files, bases and gate scripts into .work/kit
 *   node worker/cli.mjs build <file.tex>          compile, count pages, run tools/verify.py against the master
 *   node worker/cli.mjs submit-resume <id> <file.tex> <base> <summary...>
 *   node worker/cli.mjs fail <id> <reason...>     give a task back (retried up to 3 attempts)
 *   node worker/cli.mjs idle                      report the queue is empty (end of run)
 *
 * Env: JOBHUNT_URL (your Vercel domain; any path is ignored), WORKER_TOKEN, WORKER_RUNNER (cloud | laptop).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = join(ROOT, '.work');
const KIT = join(WORK, 'kit');
/** Keeps only scheme and host, so a pasted page URL (https://x.vercel.app/login) still works. */
function originOf(u) {
  try {
    return u ? new URL(u.trim()).origin : '';
  } catch {
    return '';
  }
}
const BASE = originOf(process.env.JOBHUNT_URL ?? '');
const TOKEN = process.env.WORKER_TOKEN || '';
const RUNNER = process.env.WORKER_RUNNER || 'cloud';
const FA_SHIM = '\\ProvidesPackage{fontawesome}\n\\newcommand{\\faExternalLink}{\\ensuremath{\\nearrow}}\n';

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function api(method, path, body) {
  if (!BASE || !TOKEN) die('Set JOBHUNT_URL and WORKER_TOKEN.');
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!r.ok) die(`${method} ${path} -> HTTP ${r.status}: ${data.error ?? text.slice(0, 300)}`, 2);
  return data;
}

function taskFile(id) {
  const f = join(WORK, `${id}.json`);
  if (!existsSync(f)) die(`No claimed task ${id} in .work/. Run "claim" first.`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
}

let PY = null;
function python() {
  if (PY) return PY;
  for (const c of ['python3', 'python']) if (run(c, ['--version']).status === 0) return (PY = c);
  die('Python not found (needed for tools/verify.py).');
}

/** Minimal check against the task's JSON schema: required keys, enums, numeric bounds, string lengths. */
function schemaProblems(schema, v, path = 'output') {
  if (!schema) return [];
  const out = [];
  if (schema.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${path} must be an object`];
    for (const k of schema.required ?? []) if (!(k in v)) out.push(`${path}.${k} is missing`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in v) out.push(...schemaProblems(s, v[k], `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (schema.properties ?? {}))) out.push(`${path}.${k} is not allowed`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(v)) return [`${path} must be an array`];
    if (schema.maxItems && v.length > schema.maxItems) out.push(`${path} has more than ${schema.maxItems} items`);
    v.forEach((x, i) => out.push(...schemaProblems(schema.items, x, `${path}[${i}]`)));
  } else if (schema.type === 'string') {
    if (typeof v !== 'string') return [`${path} must be a string`];
    if (schema.enum && !schema.enum.includes(v)) out.push(`${path} must be one of ${schema.enum.join(', ')}`);
    if (schema.maxLength && v.length > schema.maxLength) out.push(`${path} is ${v.length} chars; max ${schema.maxLength}`);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof v !== 'number' || (schema.type === 'integer' && !Number.isInteger(v))) return [`${path} must be ${schema.type === 'integer' ? 'an integer' : 'a number'}`];
    if (schema.minimum !== undefined && v < schema.minimum) out.push(`${path} below ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) out.push(`${path} above ${schema.maximum}`);
  }
  return out;
}

/** Compiles in a temp folder (twice, for references), with the same fontawesome stand-in your build_check.py uses. */
function compile(texPath) {
  if (run('pdflatex', ['--version']).status !== 0) die('pdflatex not found. Cloud: add the setup script from docs/SETUP.md. Laptop: install MiKTeX.');
  const wd = mkdtempSync(join(tmpdir(), 'jh-tex-'));
  copyFileSync(texPath, join(wd, 'resume.tex'));
  const src = readFileSync(texPath, 'utf8');
  if (src.includes('{fontawesome}') && !(run('kpsewhich', ['fontawesome.sty']).stdout || '').trim()) writeFileSync(join(wd, 'fontawesome.sty'), FA_SHIM);
  let log = '';
  for (let i = 0; i < 2; i++) {
    const p = run('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'resume.tex'], { cwd: wd, timeout: 120_000 });
    log = (p.stdout || '') + (p.stderr || '');
    if (p.status !== 0) {
      const err = log.split('\n').filter((l) => l.startsWith('!')).slice(0, 3).join(' | ');
      rmSync(wd, { recursive: true, force: true });
      return { ok: false, error: `LaTeX failed: ${err || log.slice(-800)}` };
    }
  }
  const m = log.match(/Output written on \S+ \((\d+) pages?/);
  const pdf = readFileSync(join(wd, 'resume.pdf'));
  rmSync(wd, { recursive: true, force: true });
  return { ok: true, pdf, pages: m ? Number(m[1]) : 0 };
}

function verify(texPath) {
  const v = join(KIT, 'tools', 'verify.py');
  if (!existsSync(v)) return { passed: null, output: 'tools/verify.py missing from the kit; run "kit" first' };
  const p = run(python(), [v, texPath], { env: { ...process.env, RESUME_MASTER: join(KIT, 'master_resume.md') }, timeout: 180_000, cwd: tmpdir() });
  return { passed: p.status === 0, output: ((p.stdout || '') + (p.stderr || '')).slice(-4000) };
}

function build(texPath) {
  const c = compile(texPath);
  if (!c.ok) return { ok: false, passed: false, output: c.error };
  writeFileSync(texPath.replace(/\.tex$/, '.pdf'), c.pdf);
  const v = verify(texPath);
  const pageNote = c.pages === 1 ? '' : `FAIL  exactly 1 page: ${c.pages} pages\n`;
  return { ok: true, pdf: c.pdf, pages: c.pages, passed: c.pages === 1 ? v.passed : false, output: pageNote + v.output };
}

const [cmd, ...args] = process.argv.slice(2);
mkdirSync(WORK, { recursive: true });

switch (cmd) {
  case 'claim': {
    const d = await api('POST', '/api/worker/claim', { runner: RUNNER, limit: Number(args[0]) || 5, kind: args[1] || undefined });
    if (d.paused) console.log('Note: Job Hunt OS is paused from Telegram. Answer coach tasks only; give the rest back with "fail".');
    if (!d.tasks.length) {
      console.log('Queue empty.');
      break;
    }
    for (const t of d.tasks) {
      writeFileSync(join(WORK, `${t.id}.json`), JSON.stringify(t, null, 2));
      const m = t.meta || {};
      const what = t.kind === 'judge' ? `job ${m.jobId}` : t.kind === 'coach' ? 'question from Telegram' : `${m.company ?? ''} ${m.role ?? ''} (application ${m.applicationId})`;
      console.log(`${t.id}\t${t.kind}\t${what}\t.work/${t.id}.json`);
    }
    break;
  }
  case 'show': {
    if (!args.length) die('show <id...>');
    const ts = args.map(taskFile);
    const shared = ts.every((t) => t.instructions === ts[0].instructions);
    if (shared) console.log(`=== INSTRUCTIONS (same for ${ts.length === 1 ? 'this task' : 'all ' + ts.length + ' tasks'}) ===\n${ts[0].instructions}\n`);
    if (ts[0].schema && ts.every((t) => JSON.stringify(t.schema) === JSON.stringify(ts[0].schema)))
      console.log(`=== ANSWER SCHEMA (write a JSON object matching this) ===\n${JSON.stringify(ts[0].schema)}\n`);
    for (const t of ts) {
      console.log(`=== TASK ${t.id} (${t.kind}) ===`);
      if (!shared) console.log(`--- instructions ---\n${t.instructions}\n--- input ---`);
      console.log(`${t.input}\n`);
    }
    break;
  }
  case 'answer': {
    const [id, file] = args;
    const t = taskFile(id);
    if (!file || !existsSync(file)) die('answer <id> <file>');
    const raw = readFileSync(file, 'utf8');
    let result;
    if (t.kind === 'coach') result = { text: raw.trim() };
    else {
      let j;
      try {
        j = JSON.parse(raw);
      } catch (e) {
        die(`Not valid JSON: ${e.message}`);
      }
      const output = j && typeof j === 'object' && 'output' in j ? j.output : j;
      const problems = schemaProblems(t.schema, output);
      if (problems.length) die(`Answer does not match the schema:\n- ${problems.join('\n- ')}`);
      result = { output };
    }
    const r = await api('POST', '/api/worker/result', { id: Number(id), result });
    console.log(`${id}: ${r.note}`);
    break;
  }
  case 'answer-batch': {
    const file = args[0];
    if (!file || !existsSync(file)) die('answer-batch <file>');
    let all;
    try {
      all = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      die(`Not valid JSON: ${e.message}`);
    }
    let okN = 0;
    for (const [id, ans] of Object.entries(all)) {
      const t = taskFile(id);
      let result;
      if (t.kind === 'coach') result = { text: String(ans).trim() };
      else {
        const output = ans && typeof ans === 'object' && 'output' in ans ? ans.output : ans;
        const problems = schemaProblems(t.schema, output);
        if (problems.length) {
          console.log(`${id}: NOT SENT, fix and resend:\n  - ${problems.join('\n  - ')}`);
          continue;
        }
        result = { output };
      }
      const r = await fetch(`${BASE}/api/worker/result`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: Number(id), result }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) okN++;
      console.log(`${id}: ${r.ok ? d.note : 'NOT ACCEPTED: ' + (d.error ?? r.status)}`);
    }
    console.log(`${okN}/${Object.keys(all).length} accepted.`);
    break;
  }
  case 'kit': {
    const k = await api('GET', '/api/worker/kit');
    mkdirSync(KIT, { recursive: true });
    writeFileSync(join(KIT, 'vault_master.md'), k.vault);
    writeFileSync(join(KIT, 'master_resume.md'), k.tagged || k.vault);
    for (const [p, body] of Object.entries(k.files)) {
      mkdirSync(dirname(join(KIT, p)), { recursive: true });
      writeFileSync(join(KIT, p), body);
    }
    console.log(`Kit in .work/kit (vault edited ${String(k.vaultModified).slice(0, 10)}, synced ${String(k.syncedAt).slice(0, 10)}):`);
    console.log(['vault_master.md', 'master_resume.md', ...Object.keys(k.files)].map((f) => `  ${f}`).join('\n'));
    if (!Object.keys(k.files).some((f) => f.startsWith('bases/'))) console.log('No bases synced yet: start from the base the skill describes and expect more FAILs.');
    break;
  }
  case 'build': {
    const tex = resolve(args[0] || '');
    if (!existsSync(tex)) die('build <file.tex>');
    const b = build(tex);
    console.log(b.output);
    if (b.ok) console.log(`\nPDF: ${basename(tex).replace(/\.tex$/, '.pdf')}, ${b.pages} page(s). ${b.passed ? 'READY TO SEND' : 'NOT READY'}`);
    process.exit(b.passed ? 0 : 1);
  }
  case 'submit-resume': {
    const [id, file, base, ...summary] = args;
    const t = taskFile(id);
    if (t.kind !== 'tailor') die(`Task ${id} is ${t.kind}, not tailor.`);
    const tex = resolve(file || '');
    if (!existsSync(tex) || !base) die('submit-resume <id> <file.tex> <base> <summary...>');
    const norm = (x) => x.replace(/%.*$/gm, '').replace(/\s+/g, ' ').trim();
    const mine = norm(readFileSync(tex, 'utf8'));
    for (const n of ['Base_MLEngineer.tex', 'Base_CVResearch.tex', 'Base_BackendSystems.tex']) {
      const p = join(KIT, 'bases', n);
      if (existsSync(p) && norm(readFileSync(p, 'utf8')) === mine) die(`Not submitted: this is ${n} unchanged. Tailor it to the posting (skill step 6), then submit.`);
    }
    const b = build(tex);
    if (!b.ok) die(`Not submitted: ${b.output}`);
    const r = await api('POST', '/api/worker/result', {
      id: Number(id),
      result: {
        tex: readFileSync(tex, 'utf8').replace(/\u2014/g, ', '),
        pdfBase64: b.pdf.toString('base64'),
        summary: summary.join(' ').slice(0, 250),
        verifyPassed: b.passed,
        verifyOutput: b.output,
        base,
      },
    });
    console.log(`${id}: ${r.note} (${b.passed ? 'READY TO SEND' : 'submitted with FAILs'})`);
    break;
  }
  case 'fail': {
    const [id, ...reason] = args;
    const r = await api('POST', '/api/worker/fail', { id: Number(id), error: reason.join(' ') || 'no reason given' });
    console.log(`${id}: ${r.status}`);
    break;
  }
  case 'idle':
    await api('POST', '/api/worker/idle', {});
    console.log('Reported idle.');
    break;
  default:
    die('Commands: claim, show, answer, kit, build, submit-resume, fail, idle. See the header of worker/cli.mjs.');
}
