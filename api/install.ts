import type { VercelRequest, VercelResponse } from './_http.js';
export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.status(410).json({ error: 'Automatic installation is disabled. Review and pin the separate MCP connector before configuring any local agent.' });
}
