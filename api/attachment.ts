import type { VercelRequest, VercelResponse } from './_http.js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { requireAccess, privateResponse, deny, AccessError, validCode } from './_access.js';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { getRoom } from '@agent-room/upstash-client';
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  privateResponse(res);
  try {
    requireAccess(req);
    if (req.method !== 'GET') throw new AccessError(405, 'Use GET.');
    if (process.env.R2_PRIVATE_BUCKET_CONFIRMED !== '1') throw new AccessError(503, 'Private attachment storage is required.');
    const key = req.query.key;
    if (typeof key !== 'string' || key.length > 512 || key.includes('..') || !/^rooms\/[A-Z0-9-]+\/[a-f0-9-]{36}\/[^/\\]+$/.test(key)) throw new AccessError(400, 'Invalid attachment.');
    await getRoom(createRemoteRoomClient(undefined).store, validCode(key.split('/')[1]));
    const account = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_BUCKET;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    if (!account || !bucket || !accessKeyId || !secretAccessKey) throw new AccessError(503, 'Storage is not configured.');
    const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body || object.ContentLength === undefined || object.ContentLength > 10 * 1024 * 1024) throw new AccessError(413, 'Attachment exceeds the download limit.');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(key.split('/').pop()!)}`);
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.status(200).send(Buffer.from(await object.Body.transformToByteArray()));
    } finally { client.destroy(); }
  } catch (error) { deny(res, error); }
}
