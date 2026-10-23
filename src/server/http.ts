/** fetch with a timeout and one retry on network errors and 429/5xx. Never throws on HTTP status; callers check `status`. */

export interface HttpResult {
  status: number; // 0 = network error or timeout
  text: string;
  error?: string;
}

const UA = 'JobHuntOS/1.0 (personal job search; contact via GitHub)';

export async function httpGet(url: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<HttpResult> {
  return request(url, { method: 'GET', headers }, timeoutMs);
}

/** retry: false for slow or non-idempotent calls, so one call never runs longer than timeoutMs. */
export async function httpPost(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 60_000, retry = true): Promise<HttpResult> {
  return request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, timeoutMs, retry ? 0 : 1);
}

async function request(url: string, init: RequestInit, timeoutMs: number, attempt = 0): Promise<HttpResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers as Record<string, string>) }, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return request(url, init, timeoutMs, 1);
    }
    return { status: res.status, text };
  } catch (e) {
    if (attempt === 0) return request(url, init, timeoutMs, 1);
    return { status: 0, text: '', error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
