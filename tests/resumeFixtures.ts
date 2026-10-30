/** Shared fixtures for the resume tests: a small master resume and a ResumeDoc that passes every gate against it. */
import type { ResumeDoc } from '../src/core/resumeDoc';

export const MASTER = `# Nischit Hosamani
nischitv29@gmail.com | github.com/Nischit290402 | +65 8123 4567 | Singapore

## Education
Nanyang Technological University, MSc Artificial Intelligence, 2025 to 2026

## Experience
Acme Analytics, ML Engineer, 2022 to 2024
- Cut inference latency by 48.9% on 12 GPU nodes.
- Served 1,200 requests per second for 52 enterprise clients.
- Raised accuracy from 71% to 84% on 3 benchmarks.
- Managed a budget of 1.2 Cr across 6 projects.
- Processed 75% of 40 TB of logs in 9 hours.
- Trained 18 models on 250 million samples with 64 GPUs.
- Reduced cost by 30% across 5 regions and 7 teams.

Cannot Claim: Kubernetes in production.

## Publications
WACV 2025: blind hyperspectral denoising, 2 datasets, 3.1 dB gain.
`;

const VERBS = [
  'Built', 'Designed', 'Reduced', 'Trained', 'Deployed', 'Optimized', 'Implemented', 'Benchmarked', 'Led', 'Automated',
  'Scaled', 'Improved', 'Developed', 'Created', 'Published', 'Engineered', 'Migrated', 'Profiled', 'Evaluated', 'Analyzed',
];
const NUMS = ['48.9%', '12', '1,200', '52', '84%', '6', '75%', '40', '9', '18', '250', '64', '30%', '5', '7', '3.1', '2', '3', '71%', '12M'];

/** A bullet of about 20 words, with a master number unless `noNumber`. */
export function bullet(i: number, extraWords = 0): string {
  const filler = ' across the full evaluation suite'.repeat(Math.ceil(extraWords / 5));
  return `${VERBS[i]} the retrieval pipeline covering ${NUMS[i]} units of production work with clear tests and weekly reviews for the platform group${filler}`;
}

export function makeDoc(nBullets = 13, extraWords = 0): ResumeDoc {
  const bs = Array.from({ length: nBullets }, (_, i) => ({ text: bullet(i, extraWords), priority: (i % 5) + 1 }));
  const half = Math.ceil(nBullets / 2);
  return {
    header: { name: 'Nischit Hosamani', email: 'nischitv29@gmail.com', github: 'github.com/Nischit290402', phone: '+65 8123 4567', location: 'Singapore' },
    education: [{ school: 'Nanyang Technological University', degree: 'MSc Artificial Intelligence', dates: '2025 to 2026', detail: '' }],
    experience: [{ org: 'Acme Analytics', role: 'ML Engineer', location: 'Bangalore', dates: '2022 to 2024', bullets: bs.slice(0, half) }],
    projects: [{ name: 'Hyperspectral denoising', dates: '2025', bullets: bs.slice(half) }],
    publications: ['WACV 2025: blind hyperspectral denoising.'],
    skills: [
      { label: 'Languages', items: 'Python, C++, SQL' },
      { label: 'ML', items: 'PyTorch, CUDA, ONNX' },
    ],
    meta: { base: 'ML', match_pct: 70, covered: ['PyTorch'], gaps: ['Spark'], changes: ['led with latency work', 'skills reordered'] },
  };
}
