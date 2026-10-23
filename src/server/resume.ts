/** Client for the resume service (resume-service/, Python). The service holds your master resume and LaTeX template. */
import { env, features } from './env';
import { httpPost } from './http';

export interface TailorResult {
  pdfBase64: string;
  tex: string;
  summary: string;
  verifyPassed: boolean | null;
  verifyOutput: string;
}

export async function tailorResume(job: { applicationId: number; company: string; role: string; jdText: string }): Promise<TailorResult | { error: string }> {
  if (!features.resume()) return { error: 'resume service not configured (RESUME_SERVICE_URL / RESUME_SERVICE_TOKEN)' };
  const r = await httpPost(
    `${env.resumeServiceUrl()}/tailor`,
    { application_id: job.applicationId, company: job.company, role: job.role, jd_text: job.jdText },
    { 'x-service-token': env.resumeServiceToken() },
    240_000, // one attempt only: must finish inside the 300 s function limit
    false
  );
  if (r.status !== 200) return { error: `resume service ${r.status}: ${r.error ?? r.text.slice(0, 200)}` };
  const d = JSON.parse(r.text);
  return { pdfBase64: d.pdf_base64, tex: d.tex, summary: d.summary ?? '', verifyPassed: d.verify_passed ?? null, verifyOutput: d.verify_output ?? '' };
}
