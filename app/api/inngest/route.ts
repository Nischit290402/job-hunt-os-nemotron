import { serve } from 'inngest/next';
import { inngest } from '@/src/inngest/client';
import { functions } from '@/src/inngest/functions';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
