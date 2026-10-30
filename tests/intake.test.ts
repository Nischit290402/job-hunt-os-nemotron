/** Intake rules R0 to R4 on fixtures. Pure, no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatRequest } from '../src/agents/types';
import { classifyIntake, findUrls, looksLikeJobDescription, LINKEDIN_REPLY } from '../src/core/intake';

const req = (text: string, o: Partial<ChatRequest> = {}): ChatRequest => ({ text, images: [], history: [], ...o });
const IMG = { mime: 'image/png', b64: 'iVBORw0KGgo=' };

const JD = `Machine Learning Intern, Singapore. About the role: you will build ranking models for search.
Responsibilities: train and evaluate models in PyTorch, run A/B tests, ship features to production with the team.
Requirements: currently pursuing a degree in computer science or a related field, experience with Python and SQL.
Qualifications: strong grasp of statistics, familiarity with deep learning. Apply by 30 November with your resume.`;

test('R1: any image wins, even with a LinkedIn link in the caption', () => {
  const r = classifyIntake(req('saw this on https://www.linkedin.com/posts/jane_1', { images: [IMG] }));
  assert.equal(r.rule, 'R1');
  assert.equal(r.hasImages, true);
  assert.deepEqual(r.linkedinUrls, ['https://www.linkedin.com/posts/jane_1']);
});

test('R3: only LinkedIn links, with or without a scheme, and lnkd.in', () => {
  for (const t of [
    'https://www.linkedin.com/posts/jane-tan_hiring-ml-interns-activity-123',
    'check this out: linkedin.com/jobs/view/4001',
    'https://lnkd.in/gAbC12',
    'www.linkedin.com/feed/update/urn:li:activity:7 and https://sg.linkedin.com/in/jane',
  ]) {
    const r = classifyIntake(req(t));
    assert.equal(r.rule, 'R3', t);
    assert.equal(r.urls.length, 0, t);
    assert.ok(r.linkedinUrls.length >= 1, t);
  }
  assert.match(LINKEDIN_REPLY, /never open LinkedIn links/);
  assert.ok(!/[—]/.test(LINKEDIN_REPLY));
});

test('R2: a non-LinkedIn URL, even alongside a LinkedIn one', () => {
  const a = classifyIntake(req('https://boards.greenhouse.io/acme/jobs/123.'));
  assert.equal(a.rule, 'R2');
  assert.deepEqual(a.urls, ['https://boards.greenhouse.io/acme/jobs/123']);
  const b = classifyIntake(req('JD (https://jobs.lever.co/grab/abc) and post https://www.linkedin.com/posts/x'));
  assert.equal(b.rule, 'R2');
  assert.deepEqual(b.urls, ['https://jobs.lever.co/grab/abc']);
  assert.deepEqual(b.linkedinUrls, ['https://www.linkedin.com/posts/x']);
});

test('R4: a long pasted job description with no link', () => {
  const r = classifyIntake(req(JD));
  assert.ok(JD.length >= 400);
  assert.equal(r.looksLikeJd, true);
  assert.equal(r.rule, 'R4');
});

test('R0: short text, long text that is not a JD, and any tapped button', () => {
  assert.equal(classifyIntake(req('what should I apply to today?')).rule, 'R0');
  assert.equal(classifyIntake(req('Hiring ML interns at Shopee SG, DM me, Jane Tan')).rule, 'R0');
  const essay = 'The weather in Singapore was warm and humid all week, and the hawker centre near the office was busy at lunch. '.repeat(5);
  assert.equal(looksLikeJobDescription(essay), false);
  assert.equal(classifyIntake(req(essay)).rule, 'R0');
  const tapped = classifyIntake(req('https://boards.greenhouse.io/acme/jobs/1', { images: [IMG], action: { expert: 'resume', action: 'tailor', args: { appId: 3 } } }));
  assert.equal(tapped.rule, 'R0');
});

test('findUrls: trailing punctuation trimmed, duplicates removed, non-http ignored', () => {
  const r = findUrls('see https://acme.com/jobs/1, and https://acme.com/jobs/1! ftp://x.y/z mailto:a@b.com acme.com/careers');
  assert.deepEqual(r.urls, ['https://acme.com/jobs/1']);
  assert.deepEqual(r.linkedinUrls, []);
});
