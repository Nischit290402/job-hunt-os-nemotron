/** Outreach expert. Stub from W0: the owning sub-agent replaces the body; the export and its shape stay. */
import type { Expert } from './types';

export const outreach: Expert = {
  id: 'outreach',
  describe: () => ({ purpose: 'Outreach (not built yet)', sees: [], neverSees: [], models: [], tools: [] }),
  run: async () => {
    throw new Error('Outreach expert is not built yet');
  },
};
