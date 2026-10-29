import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRules, evaluateJob, familyOf, startWindow, type RawJob } from '../src/core/filters';
import { DEFAULT_TERMS, withExtraTerms } from '../src/core/terms';
import { canonicalKey, normCompany, normUrl, xkey } from '../src/core/keys';
import { greenhouse, lever, ashby, mcf, mdlist, crawl, workday, workdayBoard, workdayPosted, workdayCxsUrl, ParseError } from '../src/core/sources';
import { htmlToText } from '../src/core/html';
import { addDays, daysBetween, sgtAt, sgtDate, weekStart } from '../src/core/time';

const R = buildRules(DEFAULT_TERMS);
const SG = 'Singapore';
const ev = (title: string, location: string, extra: Partial<RawJob> = {}) =>
  evaluateJob({ company: 'X', title, location, url: 'https://x/1', posted: '', channel: 'ATS', ...extra }, R);

// ---------- filters (ported from the v0.3.1 suite; tab names map to tracks) ----------
const TRACK: Record<string, string> = { SG_Internships: 'sg', Remote_Programs: 'remote', FT_Watch: 'ft', Archive: 'archive' };
const cases: [string, string, 'keep' | 'reject', string, Partial<RawJob>?][] = [
  ['Machine Learning Engineer Intern, Summer 2027', SG, 'keep', 'SG_Internships'],
  ['Senior Machine Learning Engineer', SG, 'reject', 'senior_title'],
  ['Research Scientist Intern, PhD', SG, 'reject', 'phd_only'],
  ['Research Scientist Intern, PhD or MS', SG, 'keep', 'SG_Internships'],
  ['Quantitative Researcher Intern', SG, 'keep', 'SG_Internships'],
  ['ML Platform Intern', SG, 'keep', 'Archive'],
  ['Machine Learning Infrastructure Intern', SG, 'keep', 'Archive'],
  ['Software Engineer Intern 2026', SG, 'reject', 'wrong_year'],
  ['Machine Learning Intern, Summer 2026', SG, 'reject', 'wrong_year'],
  ['Machine Learning Engineer Intern, Summer 2028', SG, 'reject', 'wrong_year'],
  ['Data Engineer Intern', SG, 'reject', 'not_ai_scope'],
  ['AI Research Intern', 'London, UK', 'reject', 'location'],
  ['Machine Learning Intern', 'Remote - US', 'keep', 'Remote_Programs'],
  ['Cohere Labs Scholar', 'Remote', 'keep', 'Remote_Programs', { hint: 'remote' }],
  ['Cohere Labs Scholar', 'Remote', 'reject', 'not_ai_scope'],
  ['Machine Learning Engineer', SG, 'keep', 'FT_Watch'],
  ['Machine Learning Engineer, New Grad 2028', SG, 'keep', 'FT_Watch'],
  ['Machine Learning Engineer, New Grad 2026', SG, 'reject', 'wrong_year'],
  ['Management Consulting Intern (AI)', SG, 'reject', 'excluded_role'],
  ['Operations Research Intern', SG, 'keep', 'SG_Internships'],
  ['Product Manager Intern, AI', SG, 'reject', 'excluded_role'],
  ['Quantitative Trader Intern', 'Singapore; Chicago', 'keep', 'SG_Internships'],
  ['AI Engineer', 'Remote', 'reject', 'not_program'],
  ['Marketing Intern, AI', SG, 'reject', 'excluded_role'],
  ['Computer Vision Intern', 'SG', 'keep', 'SG_Internships'],
  ['Software Engineer Intern', SG, 'reject', 'not_ai_scope'],
  ['Postdoctoral Fellow, Machine Learning', SG, 'reject', 'excluded_role'],
  ['Full Stack Engineer Intern, AI', SG, 'reject', 'excluded_role'],
];
for (const [title, loc, action, x, extra] of cases) {
  test(`filter: ${title} @ ${loc}`, () => {
    const r = ev(title, loc, extra);
    assert.equal(r.action, action, JSON.stringify(r));
    assert.equal(r.action === 'keep' ? r.track : r.reason, action === 'keep' ? TRACK[x] : x);
  });
}

test('filter: MCF intern flag, stale postings, api-only remote flag, eligibility flag', () => {
  const k = ev('Machine Learning Research Engineer', SG, { intern: true });
  assert.equal(k.action === 'keep' && k.track, 'sg');
  assert.equal(ev('Machine Learning Engineer', SG, { posted: '2024-05-01' }).action === 'reject' && 'stale', 'stale');
  const r = ev('Machine Learning Intern', 'Boston, MA', { remote: true });
  assert.equal(r.action === 'keep' && r.hoursFlag, 'VERIFY <=16h/wk; VERIFY remote');
  const e = evaluateJob({ company: 'DSO National Laboratories', title: 'AI Research Intern', location: SG, url: '', posted: '', channel: 'ATS' }, R);
  assert.equal(e.action === 'keep' && e.eligFlag, 'VERIFY eligibility');
});

test('preferences can add exclude terms (agent roles out after the Sep 30 direction change)', () => {
  const R2 = buildRules(withExtraTerms(DEFAULT_TERMS, { exclude: ['agent', 'agentic'] }));
  const r = evaluateJob({ company: 'TikTok', title: 'AI Agent Algorithm Engineer Intern - 2027 Start', location: SG, url: '', posted: '', channel: 'ATS' }, R2);
  assert.deepEqual(r, { action: 'reject', reason: 'excluded_role' });
});

test('family and start window', () => {
  assert.equal(familyOf('LLM Algorithm Engineer Intern'), 'llm/nlp');
  assert.equal(familyOf('Algorithmic Trading Intern'), 'quant');
  assert.equal(startWindow('Summer 2027'), 'Summer');
  assert.equal(startWindow('Off-Cycle Intern'), 'Jan (shiftable)');
  assert.equal(startWindow('Intern'), '');
});

// ---------- keys ----------
test('canonical key collapses the v0.3.1 duplicates', () => {
  // AppLovin: board link vs aggregator link with utm_source
  assert.equal(
    canonicalKey({ url: 'https://boards.greenhouse.io/applovin/jobs/4713038006?gh_jid=4713038006&utm_source=freehire.me' }),
    canonicalKey({ url: 'https://boards.greenhouse.io/applovin/jobs/4713038006?gh_jid=4713038006' })
  );
  // Jump: company site gh_jid link equals the API's numeric id
  assert.equal(canonicalKey({ url: 'https://www.jumptrading.com/hr/job?gh_jid=8027939' }), canonicalKey({ url: 'x', atsName: 'greenhouse', atsJobId: '8027939' }));
  assert.equal(canonicalKey({ url: 'https://razer.wd3.myworkdayjobs.com/en-US/careers/job/Singapore-Razer-AI-Center/Reinforcement-Learning-Intern_JR2026007737' }), 'wd:razer:jr2026007737');
  assert.equal(
    canonicalKey({ url: 'https://www.mycareersfuture.gov.sg/job/engineering/research-intern-xg-tech-1c9ff81ef4ce3a921802b19020f9c53f' }),
    'mcf:1c9ff81ef4ce3a921802b19020f9c53f'
  );
  assert.match(canonicalKey({ url: 'https://lifeattiktok.com/search/7666290648937056565' }), /^url:/);
});

test('normUrl, normCompany, xkey', () => {
  assert.equal(normUrl('HTTPS://www.a.com/x/?b=2&utm_source=z&a=1'), 'a.com/x?a=1&b=2');
  assert.equal(normUrl('not a url'), '');
  assert.equal(normCompany('TikTok Pte. Ltd.'), 'bytedance');
  assert.equal(normCompany('Meta Platforms, Inc.'), 'meta');
  assert.equal(xkey({ company: 'Grab Holdings Inc.', title: 'ML Intern (Singapore)', location: 'Singapore' }), xkey({ company: 'Grab', title: 'ML Intern', location: 'Singapore, SG' }));
});

// ---------- source parsers ----------
const src = (type: any, extra: any = {}) => ({ id: 's', type, company: 'Acme', slug_or_url: 'acme', ...extra });

test('greenhouse parser keeps the job description and the ATS id', () => {
  const body = JSON.stringify({
    jobs: [{ id: 42, title: 'ML Intern', absolute_url: 'https://boards.greenhouse.io/acme/jobs/42', location: { name: 'Singapore' }, first_published: '2026-10-01T02:00:00Z', content: '&lt;p&gt;Build &amp;amp; ship models.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;PyTorch&lt;/li&gt;&lt;/ul&gt;' }],
  });
  const [j] = greenhouse.parse(body, src('greenhouse'));
  assert.equal(j.atsJobId, '42');
  assert.equal(j.posted, '2026-10-01');
  assert.match(j.jdText!, /Build & ship models\./);
  assert.match(j.jdText!, /- PyTorch/);
  assert.throws(() => greenhouse.parse('<html>', src('greenhouse')), ParseError);
});

test('lever and ashby parsers', () => {
  const lv = lever.parse(JSON.stringify([{ id: 'abc', text: 'AI Intern', hostedUrl: 'https://jobs.lever.co/acme/abc', categories: { location: 'Singapore' }, createdAt: 1_790_000_000_000, descriptionPlain: 'About the team', lists: [{ text: 'You will', content: '<li>train models</li>' }], workplaceType: 'onsite' }]), src('lever'));
  assert.equal(lv[0].location, 'Singapore');
  assert.match(lv[0].jdText!, /About the team[\s\S]*train models/);
  const ab = ashby.parse(JSON.stringify({ jobs: [{ id: 'u1', title: 'ML Intern', location: 'Singapore', secondaryLocations: [{ location: 'Remote' }], jobUrl: 'https://jobs.ashbyhq.com/acme/u1', publishedAt: '2026-10-02', workplaceType: 'Remote', descriptionPlain: 'Train LLMs' }, { id: 'u2', title: 'Hidden', isListed: false }] }), src('ashby'));
  assert.equal(ab.length, 1);
  assert.equal(ab[0].remote, true);
  assert.equal(ab[0].location, 'Singapore; Remote');
});

test('mcf parser and markdown list parser', () => {
  const m = mcf.parse(JSON.stringify({ results: [{ uuid: 'f'.repeat(32), title: 'AI Intern', postedCompany: { name: 'Acme Pte Ltd' }, metadata: { newPostingDate: '2026-10-20' }, employmentTypes: [{ employmentType: 'Internship/Attachment' }] }] }));
  assert.equal(m[0].intern, true);
  assert.equal(canonicalKey(m[0]), `mcf:${'f'.repeat(32)}`);
  const md = [
    '| Company | Position | Location | Posting | Age |',
    '| --- | --- | --- | --- | --- |',
    '| <a href="https://x.com"><strong>Grab</strong></a> | Machine Learning Intern 🛂 | Singapore | <div align="center"><a href="https://grab.com/j/1"><img src="a.png" alt="Apply"></a></div> | 3d |',
    '| ↳ | Computer Vision Intern | Singapore<br>Remote | <a href="https://grab.com/j/2">Apply</a> | 10d |',
    '| **[Sea](https://sea.com)** | AI Intern | Singapore | [Apply](https://sea.com/j/3) | 0d |',
    '| Broken | No Link | Singapore | n/a | 1d |',
  ].join('\n');
  const jobs = mdlist.parse(md, src('mdlist'), Date.parse('2026-10-23T04:00:00Z'));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].title, 'Machine Learning Intern');
  assert.equal(jobs[1].company, 'Grab');
  assert.equal(jobs[1].location, 'Singapore; Remote');
  assert.equal(jobs[0].posted, '2026-10-20');
});

test('crawl parser: Optiver and Google shapes, Google pagination', () => {
  const o = crawl.parse('### [Quantitative Research Intern - Singapore](https://optiver.com/join-us/jobs/1234/)\n[Home](https://optiver.com/)', src('crawl', { company: 'Optiver', slug_or_url: 'https://optiver.com/x', link_pattern: '/join-us/jobs/', default_location: SG }));
  assert.equal(o.length, 1);
  const g = crawl.parse('[Learn more about ML Intern, Summer 2027](https://www.google.com/about/careers/applications/jobs/results/12345-ml)\n[Rel](/about/careers/applications/jobs/results/777-x)', src('crawl', { company: 'Google', slug_or_url: 'https://www.google.com/about/careers/applications/jobs/results/?q=intern', link_pattern: '/jobs/results/\\d||Learn more about ' }));
  assert.equal(g.length, 2);
  assert.equal(g[0].title, 'ML Intern, Summer 2027');
  assert.equal(crawl.pageUrl('https://www.google.com/about/careers/applications/jobs/results/?q=ml', 2), 'https://www.google.com/about/careers/applications/jobs/results/?q=ml&page=2');
  assert.equal(crawl.pageUrl('https://optiver.com/x', 2), '');
});

test('htmlToText strips scripts and keeps list structure', () => {
  assert.equal(htmlToText('<script>x()</script><p>A &amp; B</p><ul><li>one</li><li>two</li></ul>'), 'A & B\n\n- one\n- two');
});

// ---------- time ----------
test('Singapore time helpers', () => {
  assert.equal(sgtDate(Date.parse('2026-10-22T16:30:00Z')), '2026-10-23');
  assert.equal(sgtAt('2026-10-24', '07:45').toISOString(), '2026-10-23T23:45:00.000Z');
  assert.equal(daysBetween('2026-10-23', '2026-11-02'), 10);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(weekStart('2026-10-25'), '2026-10-19'); // Sunday belongs to the week that started Monday
  assert.equal(weekStart('2026-10-19'), '2026-10-19');
});

test('workday: board URL, search requests, postings parsed into job links the detail API understands', () => {
  const s = { id: 'wd_razer', type: 'workday' as const, company: 'Razer', slug_or_url: 'https://razer.wd3.myworkdayjobs.com/en-US/careers', default_location: 'Singapore' };
  assert.deepEqual(workdayBoard(s.slug_or_url), { origin: 'https://razer.wd3.myworkdayjobs.com', tenant: 'razer', site: 'careers' });
  const reqs = workday.requests(s, ['intern'], 2);
  assert.equal(reqs[1].url, 'https://razer.wd3.myworkdayjobs.com/wday/cxs/razer/careers/jobs');
  assert.deepEqual(reqs[1].body, { appliedFacets: {}, limit: 20, offset: 20, searchText: 'intern' });
  const now = Date.parse('2026-10-29T02:00:00Z');
  const jobs = workday.parse(JSON.stringify({ total: 2, jobPostings: [
    { title: 'Reinforcement Learning Intern', externalPath: '/job/Singapore-Razer-AI-Center/Reinforcement-Learning-Intern_JR2026007737', locationsText: 'Singapore', postedOn: 'Posted 3 Days Ago' },
    { title: 'AI Engineer Intern', externalPath: '/job/Singapore/AI-Engineer-Intern_JR2026006947', locationsText: '2 Locations', postedOn: 'Posted 30+ Days Ago' },
  ] }), s, now);
  assert.equal(jobs[0].url, 'https://razer.wd3.myworkdayjobs.com/en-US/careers/job/Singapore-Razer-AI-Center/Reinforcement-Learning-Intern_JR2026007737');
  assert.equal(jobs[0].posted, '2026-10-26');
  assert.equal(jobs[1].location, '2 Locations; Singapore');
  assert.match(workdayCxsUrl(jobs[0].url), /\/wday\/cxs\/razer\/careers\/job\//);
  assert.equal(workdayPosted('Posted Today', now), '2026-10-29');
  assert.throws(() => workday.parse('{}', s), ParseError);
});

// ---------- master resume sync ----------
import { masterSyncNote, validMaster, type MasterCopy } from '../src/core/master';

test('master sync: notes a change, stays quiet on the same content, warns when the Optimizer copy lags the vault', () => {
  const m = (sha: string, vaultModified: string, taggedModified: string): MasterCopy => ({ vault: 'v', tagged: 't', sha, vaultModified, taggedModified, syncedAt: '' });
  const a = m('a', '2026-10-27T04:02:00Z', '2026-10-27T03:44:00Z');
  assert.match(masterSyncNote(null, a)!, /Master resume synced/);
  assert.doesNotMatch(masterSyncNote(null, a)!, /older than the vault/, '18 minutes apart is one editing session');
  assert.equal(masterSyncNote(a, { ...a }), null);
  assert.match(masterSyncNote(a, m('b', '2026-10-29T09:00:00Z', '2026-10-27T03:44:00Z'))!, /older than the vault/);
});

test('master sync: rejects empty or oversized uploads', () => {
  const ok = { vault: 'x'.repeat(600), tagged: 't', vaultModified: '2026-10-27T04:02:00Z', taggedModified: '' };
  assert.equal(validMaster(ok), true);
  assert.equal(validMaster({ ...ok, vault: 'short' }), false);
  assert.equal(validMaster({ ...ok, vault: 'x'.repeat(200_001) }), false);
  assert.equal(validMaster({ ...ok, vaultModified: 'not a date' }), false);
  assert.equal(validMaster(null), false);
});

test('xkey: Intern and Internship titles at the same company match across boards', () => {
  const a = xkey({ company: 'MOTIONAL SINGAPORE PTE. LIMITED', title: 'Machine Learning Intern, Behaviors Research', location: 'Singapore' });
  const b = xkey({ company: 'Motional', title: 'Machine Learning Internship, Behaviors Research', location: 'Singapore' });
  assert.equal(a, b);
});

test('searchName: registry names become the name people put on their profiles', async () => {
  const { searchName, xrayQueries } = await import('../src/core/contacts');
  assert.equal(searchName('MOTIONAL SINGAPORE PTE. LIMITED'), 'Motional');
  assert.equal(searchName('CYNAPSE PTE. LTD.'), 'Cynapse');
  assert.equal(searchName('Hudson River Trading'), 'Hudson River Trading');
  assert.equal(searchName('Grab Holdings Inc.'), 'Grab');
  assert.equal(searchName('DBS Bank Ltd.'), 'DBS Bank');
  assert.equal(searchName('IMC'), 'IMC');
  assert.match(xrayQueries('MOTIONAL SINGAPORE PTE. LIMITED', 'ml')[0].q, /"Motional" "machine learning engineer"/);
});

test('Gmail: the app can save drafts but has no code path that sends email', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = ['src/server/gmail.ts', 'src/server/outreach.ts', 'src/server/steps.ts', 'src/server/actions.ts'];
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /messages\/send|drafts\/send|\/send['"`]/, `${f} must not call a Gmail send endpoint`);
  }
  const { GMAIL_SCOPES } = await import('../src/server/gmail');
  assert.deepEqual(GMAIL_SCOPES.map((s) => s.split('/').pop()), ['gmail.compose', 'gmail.metadata']);
  void readdirSync;
});

test('job types: part-time is its own category, full-time stays out of Today until switched on', async () => {
  const { evaluateJob, buildRules, jobTypeOf, parseJobTypes } = await import('../src/core/filters');
  const { DEFAULT_TERMS } = await import('../src/core/terms');
  const { scoreCandidate } = await import('../src/core/ranker');
  const { verdictFor } = await import('../src/core/judge');
  const R = buildRules(DEFAULT_TERMS);
  const now = Date.parse('2026-10-29T00:00:00Z');
  const job = (title: string, extra: Partial<Parameters<typeof evaluateJob>[0]> = {}) =>
    evaluateJob({ company: 'X', title, location: 'Singapore', url: 'u', posted: '', channel: 'ATS', ...extra }, R, now);

  const pt = job('Machine Learning Engineer (Part-Time)');
  assert.ok(pt.action === 'keep' && pt.track === 'sg' && jobTypeOf(pt.track, pt.hoursFlag) === 'parttime');
  const mcfPt = job('AI Research Assistant', { partTime: true });
  assert.ok(mcfPt.action === 'keep' && jobTypeOf(mcfPt.track, mcfPt.hoursFlag) === 'parttime');
  const ft = job('Machine Learning Engineer');
  assert.ok(ft.action === 'keep' && jobTypeOf(ft.track, ft.hoursFlag) === 'fulltime');
  const intern = job('Machine Learning Intern');
  assert.ok(intern.action === 'keep' && jobTypeOf(intern.track, intern.hoursFlag) === 'intern');

  assert.deepEqual(parseJobTypes('intern part-time'), ['intern', 'parttime']);
  assert.deepEqual(parseJobTypes('fulltime intern'), ['intern', 'fulltime']);
  assert.equal(parseJobTypes('banana'), null);

  const cand = { jobId: 1, companyKey: 'x', company: 'X', title: 't', track: 'ft' as const, hoursFlag: '', score: 85, verdict: 'Watch' as const, deadline: '', posted: '', firstSeen: '2026-10-29' };
  assert.equal(scoreCandidate(cand, undefined, { today: '2026-10-29' }), null, 'full-time hidden by default');
  assert.ok(scoreCandidate(cand, undefined, { today: '2026-10-29', jobTypes: ['intern', 'parttime', 'fulltime'] }));
  assert.equal(scoreCandidate({ ...cand, track: 'sg', hoursFlag: 'part-time' }, undefined, { today: '2026-10-29', jobTypes: ['intern'] }), null);

  const gates = { A1: 'PASS', A2: 'PASS', A3: 'PASS', A4: 'PASS', A5: 'PASS' } as const;
  assert.equal(verdictFor(85, gates as any, '', 'ft', '2026-10-29'), 'Watch');
  assert.equal(verdictFor(85, gates as any, '', 'ft', '2026-10-29', true), 'Apply now');
});

test('routes: hiring-system page first, then careers site; job boards and other companies never count', async () => {
  const { classifyResult, pickRoute, extractApplyEmail, routeQueries } = await import('../src/core/route');
  const co = 'MOTIONAL SINGAPORE PTE. LIMITED';
  const title = 'Machine Learning Intern, Behaviors Research';
  assert.match(routeQueries(co, title)[0], /^"Motional" "Machine Learning Intern, Behaviors Research" \(site:greenhouse\.io/);
  const gh = { url: 'https://job-boards.greenhouse.io/motional/jobs/123', title: 'Job Application for Machine Learning Internship, Behaviors Research at Motional' };
  const site = { url: 'https://motional.com/careers/open-positions/ml-intern', title: 'Machine Learning Internship, Behaviors Research | Motional' };
  const board = { url: 'https://builtinsingapore.com/job/machine-learning-internship-behaviors-research/4217973', title: 'Machine Learning Internship, Behaviors Research - Motional' };
  const otherCo = { url: 'https://job-boards.greenhouse.io/waymo/jobs/9', title: 'Machine Learning Intern, Behaviors Research' };
  const wrongRole = { url: 'https://job-boards.greenhouse.io/motional/jobs/5', title: 'Senior Software Engineer, Mapping at Motional' };
  assert.equal(classifyResult(gh, co, title), 'ats');
  assert.equal(classifyResult(site, co, title), 'careers');
  assert.equal(classifyResult(board, co, title), null);
  assert.equal(classifyResult(otherCo, co, title), null);
  assert.equal(classifyResult(wrongRole, co, title), 'ats-check', 'same company, other role: only the page check can rule it in');
  assert.equal(await pickRoute([board, site, gh], co, title), gh.url, 'hiring system preferred over careers site');
  assert.equal(await pickRoute([board, site], co, title), site.url);
  assert.equal(await pickRoute([board, otherCo], co, title), null);
  // Search engines show Greenhouse pages as "Back to jobs": the page itself is checked.
  const generic = { url: 'https://job-boards.greenhouse.io/motional/jobs/6410602003', title: 'Back to jobs' };
  assert.equal(classifyResult(generic, co, title), 'ats-check');
  assert.equal(await pickRoute([board, generic], co, title, async () => true), generic.url);
  assert.equal(await pickRoute([board, generic], co, title, async () => false), null);

  const { bestPosting, boardSlugs } = await import('../src/core/route');
  assert.deepEqual(boardSlugs(co), ['motional']);
  assert.deepEqual(boardSlugs('Hudson River Trading'), ['hudsonrivertrading', 'hudson-river-trading']);
  const posts = [
    { title: 'Principal Engineer, Team Lead - Behaviors', url: 'https://motional.com/open-positions/?gh_jid=1', location: 'Boston' },
    { title: 'Machine Learning Internship, Behaviors Research', url: 'https://motional.com/open-positions/?gh_jid=7600024003', location: 'Singapore, Central, Singapore' },
  ];
  assert.equal(bestPosting(posts, title)?.url, 'https://motional.com/open-positions/?gh_jid=7600024003');
  assert.equal(bestPosting(posts, 'Data Scientist Intern'), null);

  assert.equal(extractApplyEmail('Interested candidates, please send your CV to hr@cynapse.ai by 30 Nov.'), 'hr@cynapse.ai');
  assert.equal(extractApplyEmail('We handle data under PDPA. Contact dpo@cynapse.ai for privacy requests.'), null);
  assert.equal(extractApplyEmail('Apply on our site. Questions: noreply@x.com'), null);
});

test('email with attachment: multipart with the PDF, header injection still blocked', async () => {
  const { buildRawEmail, applicationEmail } = await import('../src/core/outreach');
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  const m = applicationEmail('ML Intern', 'Cynapse', 'MSc AI at NTU; WACV 2025 paper.');
  assert.match(m.subject, /Application: ML Intern \(Nischit Hosamani\)/);
  const raw = Buffer.from(buildRawEmail({ from: 'a@b.com', to: 'hr@cynapse.ai', subject: m.subject, body: m.body, attachment: { filename: 'cv.pdf', mimeType: 'application/pdf', base64: pdf } }), 'base64url').toString('utf8');
  assert.match(raw, /multipart\/mixed; boundary="jh_/);
  assert.match(raw, /Content-Disposition: attachment; filename="cv.pdf"/);
  assert.ok(raw.includes(pdf));
  assert.throws(() => buildRawEmail({ from: 'a@b.com', to: 'x@y.com', subject: 's', body: 'b', attachment: { filename: 'a"\r\nBcc: z@z.com', mimeType: 'application/pdf', base64: pdf } }), /injection/);
});

test('answers: questions from the agent are cleaned, results checked', async () => {
  const { cleanQuestions, resultError } = await import('../src/core/worker');
  assert.deepEqual(cleanQuestions([{ qid: 'q1', label: ' Why   us? ', maxLength: 500, required: true }]), [{ qid: 'q1', label: 'Why us?', maxLength: 500, required: true }]);
  assert.equal(cleanQuestions([{ qid: 'x; drop', label: 'a' }]), null);
  assert.equal(cleanQuestions([]), null);
  assert.equal(resultError('answers', { output: { answers: [{ qid: 'q1', text: 'Because...' }] } }), null);
  assert.match(resultError('answers', { output: { answers: 'nope' } })!, /answers/);
});

test('resume file names follow Resume_<year>_SG_<Company>_<Role>', async () => {
  const { resumeFileName } = await import('../src/core/contacts');
  assert.equal(resumeFileName('MOTIONAL SINGAPORE PTE. LIMITED', 'Machine Learning Intern, Behaviors Research', '2026'), 'Resume_2026_SG_Motional_ML_Intern_Behaviors_Research.pdf');
  assert.equal(resumeFileName('Hudson River Trading', 'Algorithm Development (Quant Research & Trading) Internship – Summer 2027', '2026'), 'Resume_2026_SG_HudsonRiverTrading_Algorithm_Development_Intern.pdf');
  assert.equal(resumeFileName('TikTok', 'Machine Learning Engineer Intern - TikTok Search - 2027 Start', '2026'), 'Resume_2026_SG_TikTok_ML_Engineer_Intern_TikTok_Search.pdf');
});
