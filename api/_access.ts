import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from './_http.js';

export interface Member { name: string; tokenHash: string }
export class AccessError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const COOKIE = 'agent_room_session';
const SESSION_SECONDS = 8 * 60 * 60;
export function members(): Member[] {
  let value: unknown;
  try { value = JSON.parse(process.env.AGENT_ROOM_MEMBERS ?? ''); } catch { throw new AccessError(503, 'Team access is not configured.'); }
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new AccessError(503, 'Invalid team configuration.');
  const names = new Set<string>();
  const hashes = new Set<string>();
  for (const m of value) {
    if (!m || typeof m.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/.test(m.name)
      || m.name !== m.name.trim() || ['system', 'server'].includes(m.name.toLowerCase()) || !/^[a-f0-9]{64}$/.test(m.tokenHash ?? '')
      || names.has(m.name.toLowerCase()) || hashes.has(m.tokenHash)) throw new AccessError(503, 'Invalid team configuration.');
    names.add(m.name.toLowerCase()); hashes.add(m.tokenHash);
  }
  return value as Member[];
}
export function appOrigin(): string {
  try {
    const u = new URL(process.env.AGENT_ROOM_ORIGIN ?? '');
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash
      || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error();
    return u.origin;
  } catch { throw new AccessError(503, 'A secure application origin is required.'); }
}
function equal(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function fromBearer(header: unknown): Member {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header)) throw new AccessError(401, 'A team access token is required.');
  const hash = createHash('sha256').update(header.slice(7)).digest('hex');
  const member = members().find(m => equal(m.tokenHash, hash));
  if (!member) throw new AccessError(401, 'Invalid team access token.');
  return member;
}
export function sessionValue(member: Member, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ name: member.name, expires: Math.floor(now / 1000) + SESSION_SECONDS })).toString('base64url');
  const signature = createHmac('sha256', member.tokenHash).update(payload).digest('hex');
  return `${payload}.${signature}`;
}
export function fromSession(value: string, now = Date.now()): Member {
  try {
    if (value.length > 512) throw new Error();
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra || !/^[a-f0-9]{64}$/.test(signature)) throw new Error();
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const member = members().find(m => m.name === data.name);
    if (!member || !Number.isSafeInteger(data.expires) || data.expires <= now / 1000 || data.expires > now / 1000 + SESSION_SECONDS + 1) throw new Error();
    if (!equal(signature, createHmac('sha256', member.tokenHash).update(payload).digest('hex'))) throw new Error();
    return member;
  } catch { throw new AccessError(401, 'Sign in again.'); }
}
export function requireAccess(req: VercelRequest): Member {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== appOrigin()) throw new AccessError(403, 'Origin not allowed.');
  if (req.headers.authorization !== undefined) return fromBearer(req.headers.authorization);
  if (!['GET', 'HEAD'].includes(req.method ?? '') && origin !== appOrigin()) throw new AccessError(403, 'A same-origin request is required.');
  const cookie = String(req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`));
  if (!cookie) throw new AccessError(401, 'Sign in with your team access token.');
  return fromSession(cookie.slice(COOKIE.length + 1));
}
export function setSession(res: VercelResponse, member: Member): void {
  const secure = appOrigin().startsWith('https:') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${sessionValue(member)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`);
}
export function privateResponse(res: VercelResponse): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Vary', 'Cookie, Authorization');
}
export function deny(res: VercelResponse, error: unknown): void {
  privateResponse(res);
  res.status(error instanceof AccessError ? error.status : 500).json({ error: error instanceof AccessError ? error.message : 'Request failed.' });
}
export function assertIdentity(member: Member, value: unknown): void {
  if (value !== member.name) throw new AccessError(403, 'Use your authenticated team name.');
}
export function assertHost(member: Member, room: { createdBy: string }): void { assertIdentity(member, room.createdBy); }
export function validCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(value)) throw new AccessError(400, 'Invalid room code.');
  return value;
}
