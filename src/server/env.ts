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
  appUrl: () => opt('APP_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  signingSecret: () => req('SIGNING_SECRET'),

  telegramToken: () => req('TELEGRAM_BOT_TOKEN'),
  telegramChatId: () => req('TELEGRAM_CHAT_ID'),
  telegramWebhookSecret: () => req('TELEGRAM_WEBHOOK_SECRET'),

  anthropicKey: () => req('ANTHROPIC_API_KEY'),
  judgeModel: () => opt('JUDGE_MODEL', 'claude-haiku-4-5-20251001'),
  writerModel: () => opt('WRITER_MODEL', 'claude-sonnet-5-5'),
  monthlyTokenCap: () => num('MONTHLY_INPUT_TOKEN_CAP', 4_000_000),
  judgeBatchSize: () => num('JUDGE_BATCH_SIZE', 5),
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

  resumeServiceUrl: () => opt('RESUME_SERVICE_URL').replace(/\/+$/, ''),
  resumeServiceToken: () => opt('RESUME_SERVICE_TOKEN'),

  agentToken: () => req('AGENT_TOKEN'),
};

export const features = {
  gmail: () => !!(env.gmailClientId() && env.gmailClientSecret() && env.gmailRefreshToken() && env.gmailFrom()),
  brave: () => !!env.braveKey(),
  hunter: () => !!env.hunterKey(),
  firecrawl: () => !!env.firecrawlKey(),
  resume: () => !!(env.resumeServiceUrl() && env.resumeServiceToken()),
};
