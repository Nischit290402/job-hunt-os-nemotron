/**
 * Master resume sync. The vault file ("Master Resume MD.md") is the canonical evidence base; the Resume Optimizer's
 * tagged master_resume.md is what fact_check.py reads. Both are pushed from the laptop and sent with every tailoring request.
 */
export interface MasterCopy {
  vault: string;
  tagged: string;
  vaultModified: string; // ISO time of the file on the laptop
  taggedModified: string;
  files?: Record<string, string>; // resume kit: bases/Base_*.tex and tools/*.py from your Resume Optimizer
  sha: string;
  syncedAt: string;
}

export const KIT_PATH = /^(bases\/Base_[A-Za-z0-9]+\.tex|tools\/[a-z_]+\.py)$/;
export const KIT_MAX_CHARS = 400_000;

export const MASTER_MAX_CHARS = 200_000;
const DRIFT_MS = 60 * 60 * 1000;

/** What to tell you after a sync: null when nothing changed. */
export function masterSyncNote(prev: MasterCopy | null, next: MasterCopy): string | null {
  if (prev && prev.sha === next.sha) return null;
  const parts = [`Master resume synced (vault edited ${next.vaultModified.slice(0, 16).replace('T', ' ')} UTC).`];
  const drift = Date.parse(next.vaultModified) - Date.parse(next.taggedModified);
  if (drift > DRIFT_MS) {
    parts.push(
      'The Resume Optimizer copy is older than the vault, so the fact gate may fail facts you added. Run /add-to-master-resume (or ask Claude to sync master_resume.md with the vault).'
    );
  }
  return parts.join(' ');
}

export function validMaster(b: unknown): b is { vault: string; tagged: string; vaultModified: string; taggedModified: string; files?: Record<string, string> } {
  const o = b as Record<string, unknown>;
  if (o && o.files !== undefined) {
    if (!o.files || typeof o.files !== 'object' || Array.isArray(o.files)) return false;
    const entries = Object.entries(o.files as Record<string, unknown>);
    if (entries.some(([k, v]) => !KIT_PATH.test(k) || typeof v !== 'string')) return false;
    if (entries.reduce((n, [, v]) => n + (v as string).length, 0) > KIT_MAX_CHARS) return false;
  }
  return (
    !!o &&
    typeof o.vault === 'string' &&
    typeof o.tagged === 'string' &&
    o.vault.length > 500 &&
    o.vault.length <= MASTER_MAX_CHARS &&
    o.tagged.length <= MASTER_MAX_CHARS &&
    typeof o.vaultModified === 'string' &&
    !Number.isNaN(Date.parse(o.vaultModified)) &&
    typeof o.taggedModified === 'string'
  );
}
