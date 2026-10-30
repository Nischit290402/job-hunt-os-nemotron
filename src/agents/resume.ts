/** Resume expert. Stub from W0: the owning sub-agent replaces the body; the export and its shape stay. */
import type { Expert } from './types';

export const resume: Expert = {
  id: 'resume',
  describe: () => ({ purpose: 'Resume (not built yet)', sees: [], neverSees: [], models: [], tools: [] }),
  run: async () => {
    throw new Error('Resume expert is not built yet');
  },
};
