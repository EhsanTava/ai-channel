import type { VercelRequest, VercelResponse } from './_http.js';
import { requireAccess, setSession, privateResponse, deny, AccessError } from './_access.js';
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  privateResponse(res);
  try {
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) throw new AccessError(405, 'Method not allowed.');
    const member = requireAccess(req);
    if (req.method === 'DELETE') {
      res.setHeader('Set-Cookie', 'agent_room_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      res.status(200).json({ ok: true }); return;
    }
    if (req.method === 'POST') setSession(res, member);
    res.status(200).json({ name: member.name });
  } catch (error) { deny(res, error); }
}
