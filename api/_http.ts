import type { IncomingMessage, ServerResponse } from 'node:http';
/** Minimal structural HTTP adapter shared by Vercel-compatible and local handlers. */
export interface VercelRequest extends IncomingMessage {
  body: any;
  query: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
}
export interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(value: unknown): VercelResponse;
  send(value: string | Buffer): VercelResponse;
}
