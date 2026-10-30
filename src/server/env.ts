/**
 * Environment access. Each feature reads only what it needs, so a missing Gmail token never breaks the brief.
 * See .env.example for every variable and where to get it.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
const opt = (name: string, d = '') => process.env[name] ?? d;
const num = (name: string, d: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : d;
};

export const env = {
  appUrl: () => {
    const u = opt('APP_URL', 'http://localhost:3000').trim();
    try {
      return new URL(u).origin; // a pasted page URL (…/login) still works
    } catch {
      return u.replace(/\/+$/, '');
    }
  },
  signingSecret: () => req('SIGNING_SECRET'),

  telegramToken: () => req('TELEGRAM_BOT_TOKEN'),
  telegramChatId: () => req('TELEGRAM_CHAT_ID'),
  telegramWebhookSecret: () => req('TELEGRAM_WEBHOOK_SECRET'),

  // Claude work runs in your Claude Code scheduled task, started by an HTTP "fire". No API key.
  routineFireUrl: () => opt('ROUTINE_FIRE_URL'),
  routineToken: () => opt('ROUTINE_TOKEN'),
  workerToken: () => req('WORKER_TOKEN'),
  judgeMaxPerDay: () => num('JUDGE_MAX_PER_DAY', 40),

  firecrawlKey: () => opt('FIRECRAWL_API_KEY'),
  firecrawlDailyCap: () => num('FIRECRAWL_DAILY_CAP', 10),
  firecrawlMonthlyCap: () => num('FIRECRAWL_MONTHLY_CAP', 1240),
  firecrawlLifetimeCap: () => num('FIRECRAWL_LIFETIME_CAP', 9900),

  braveKey: () => opt('BRAVE_SEARCH_API_KEY'),
  hunterKey: () => opt('HUNTER_API_KEY'),

  gmailClientId: () => opt('GMAIL_CLIENT_ID'),
  gmailClientSecret: () => opt('GMAIL_CLIENT_SECRET'),
  gmailRefreshToken: () => opt('GMAIL_REFRESH_TOKEN'),
  gmailFrom: () => opt('GMAIL_FROM'),

  agentToken: () => req('AGENT_TOKEN'),

  // ---- Nebius hackathon branch: every LLM call goes to Nebius Token Factory (NVIDIA Nemotron). ----
  nebiusKey: () => opt('NEBIUS_API_KEY'),
  nebiusBaseUrl: () => opt('NEBIUS_BASE_URL', 'https://api.tokenfactory.nebius.com/v1/').replace(/\/?$/, '/'),
  modelFast: () => opt('NEBIUS_MODEL_FAST', 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B'),
  modelReason: () => opt('NEBIUS_MODEL_REASON', 'nvidia/Nemotron-3-Ultra-550b-a55b'),
  modelVision: () => opt('NEBIUS_MODEL_VISION', 'nvidia/Nemotron-3.5-Super-VL'),
  modelFallback: () => opt('NEBIUS_MODEL_FALLBACK', 'nvidia/Nemotron-3_5-Lightning'),
  tavilyKey: () => opt('TAVILY_API_KEY'),
  demoMode: () => opt('DEMO_MODE') === '1',
  demoPassword: () => opt('DEMO_PASSWORD'),
  // Money guard: only the free hackathon credits are spent. At a cap the app answers with a banner, never a model call.
  llmDailyUsdCap: () => num('LLM_DAILY_USD_CAP', 1),
  llmTotalUsdCap: () => num('LLM_TOTAL_USD_CAP', 15),
  tavilyDailyCap: () => num('TAVILY_DAILY_CAP', 150),
  cronSecret: () => opt('CRON_SECRET'),
  videoUrl: () => opt('VIDEO_URL'),
  demoSourceIds: () => opt('DEMO_SOURCE_IDS').split(',').map((s) => s.trim()).filter(Boolean),
  featureSearch: () => opt('FEATURE_SEARCH', '1') !== '0',
};

export const features = {
  gmail: () => !!(env.gmailClientId() && env.gmailClientSecret() && env.gmailRefreshToken() && env.gmailFrom()),
  brave: () => !!env.braveKey(),
  hunter: () => !!env.hunterKey(),
  firecrawl: () => !!env.firecrawlKey(),
  routine: () => !!(env.routineFireUrl() && env.routineToken()),
  nebius: () => !!env.nebiusKey(),
  tavily: () => !!env.tavilyKey(),
};
