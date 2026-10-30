/** Job Fetcher expert. Stub from W0: the owning sub-agent replaces the body; the export and its shape stay. */
import type { Expert } from './types';

export const jobFetcher: Expert = {
  id: 'job_fetcher',
  describe: () => ({ purpose: 'Job Fetcher (not built yet)', sees: [], neverSees: [], models: [], tools: [] }),
  run: async () => {
    throw new Error('Job Fetcher expert is not built yet');
  },
};
