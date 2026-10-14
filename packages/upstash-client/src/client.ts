import { NetworkError, RateLimitError, UpstashError } from './errors.js';

export interface UpstashEnv {
  url: string;
  token: string;
}

export interface UpstashClient {
  command<T = unknown>(cmd: readonly (string | number)[]): Promise<T>;
  pipeline<T = unknown>(cmds: readonly (readonly (string | number)[])[]): Promise<T[]>;
}

export function createClient(env: UpstashEnv): UpstashClient {
  const base = env.url.replace(/\/$/, '');
  // We hammer this endpoint from polling loops with identical request
  // bodies (e.g. [GET counter, LLEN list] every 3 seconds). Browsers and
  // some CDNs honor Cache-Control on POST responses → identical body =
  // served from cache for the response TTL, even though new writes have
  // landed in Redis. Symptom Robin caught: polling logged `fresh: 0`
  // for ~30 seconds while messages had clearly been written, then
  // suddenly caught up when the cache expired. Forcing `no-store` on
  // every request short-circuits any layer that might be caching us.
  const headers = {
    'Authorization': `Bearer ${env.token}`,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
  };

  async function post(path: string, body: unknown): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch (e) {
      throw new NetworkError(e);
    }
    if (resp.status === 429) throw new RateLimitError();
    if (!resp.ok) throw new UpstashError(`Upstash HTTP ${resp.status}`);
    return resp.clone().json();
  }

  return {
    async command<T>(cmd: readonly (string | number)[]): Promise<T> {
      const out = (await post('/', cmd)) as { result: T; error?: string };
      if (out.error) throw new UpstashError('Storage command failed.');
      return out.result;
    },
    async pipeline<T>(cmds: readonly (readonly (string | number)[])[]): Promise<T[]> {
      const out = (await post('/pipeline', cmds)) as Array<{ result: T; error?: string }>;
      if (out.some(x => x.error)) throw new UpstashError('Storage pipeline failed.');
      return out.map(x => x.result);
    },
  };
}
