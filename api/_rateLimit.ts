import type { UpstashClient } from '@agent-room/upstash-client';
import { AccessError, type Member } from './_access.js';
import { createHash } from 'node:crypto';
export async function rateLimit(client: UpstashClient, member: Member, scope: string, limit: number): Promise<void> {
  const identity = createHash('sha256').update(member.name).digest('hex');
  const count = await client.command<number>(['EVAL',
    "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
    1, `rate:${scope}:${identity}`]);
  if (!Number.isSafeInteger(count) || count > limit) throw new AccessError(429, 'Too many requests. Try again in one minute.');
}
