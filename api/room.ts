import type { VercelRequest, VercelResponse } from './_http.js';
import { rateLimit } from './_rateLimit.js';
import * as store from '@agent-room/upstash-client';
import type { Message, Participant } from '@agent-room/shared';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { AccessError, requireAccess, assertIdentity, assertHost, validCode, privateResponse, deny } from './_access.js';
export const config = { api: { bodyParser: { sizeLimit: '128kb' } } };
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccessError(400, 'Invalid input.');
  return value as Record<string, any>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AccessError(400, 'Invalid text.');
  return value;
}
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  privateResponse(res);
  try {
    const member = requireAccess(req);
    if (req.method !== 'POST') throw new AccessError(405, 'Use POST.');
    const { action, args } = object(req.body);
    if (!Array.isArray(args) || args.length > 8) throw new AccessError(400, 'Invalid arguments.');
    const client = createRemoteRoomClient(undefined).store;
    await rateLimit(client, member, 'room', 240);
    if (action === 'createRoom') {
      const input = object(args[0]); assertIdentity(member, input.createdBy);
      const result = await store.createRoom(client, { code: validCode(input.code), topic: text(input.topic, 1000), createdBy: member.name, ownerId: member.name });
      res.status(200).json({ result }); return;
    }
    // Reports carry a room object in the old browser signature. Never trust its contents.
    const code = validCode(action === 'createRoomReport' ? object(args[0]).code : args[0]);
    const room = await store.getRoom(client, code);
    const actor = { name: member.name, client: 'web' as const };
    const host = () => assertHost(member, room);
    const participant = () => {
      if (!room.participants.some(p => p.name === member.name && p.client === 'web')) throw new AccessError(403, 'Join this room first.');
    };
    let result: unknown;
    switch (action) {
      case 'getRoom': result = room; break;
      case 'listMessages': {
        const cursor = args[1];
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AccessError(400, 'Invalid cursor.');
        result = await store.listMessages(client, code, cursor); break;
      }
      case 'getMessageTotalCount': result = await store.getMessageTotalCount(client, code); break;
      case 'getTaskBoard': result = await store.getTaskBoard(client, code); break;
      case 'getTurnState': result = await store.getTurnState(client, code); break;
      case 'getRoomReport': result = await store.getRoomReport(client, code); break;
      case 'verifyHostKey': host(); result = null; break;
      case 'joinRoom': {
        const p = object(args[1]); assertIdentity(member, p.name);
        if (room.participants.some(p => p.name === member.name && p.client !== 'web')) throw new AccessError(409, 'Use a separate identity for each browser and agent.');
        const old = room.participants.find(p => p.name === member.name && p.client === 'web');
        const candidate: Participant = { name: member.name, client: 'web', role: typeof p.role === 'string' ? p.role.slice(0, 200) : '',
          initials: member.name.slice(0, 2), color: '#5B6AFF', joinedAt: old?.joinedAt ?? Date.now(), lastSeenAt: Date.now(), canSpeak: old?.canSpeak ?? true };
        result = await store.joinRoom(client, code, candidate, { authedUserId: member.name, priorIdentity: actor }); break;
      }
      case 'appendMessage': {
        participant(); const m = object(args[1]); assertIdentity(member, m.name);
        if (m.attachments !== undefined && (!Array.isArray(m.attachments) || m.attachments.length > 5)) throw new AccessError(400, 'Invalid attachments.');
        const attachments = (m.attachments ?? []).map((a: unknown) => {
          const item = object(a);
          if (typeof item.storageKey !== 'string' || !item.storageKey.startsWith(`rooms/${code}/`) || item.storageKey.includes('..')) throw new AccessError(400, 'Invalid attachment.');
          return { id: text(item.id), type: 'file' as const, url: `/api/attachment?key=${encodeURIComponent(item.storageKey)}`, storageKey: item.storageKey,
            name: text(item.name), size: 0, mime: 'application/octet-stream', uploadedAt: Date.now() };
        });
        if (typeof m.text !== 'string' || m.text.length > 32000 || (!m.text.trim() && !attachments.length)) throw new AccessError(400, 'Invalid message.');
        const message: Message = { id: Date.now(), time: Date.now(), type: 'msg', name: member.name, client: 'web', role: '', initials: member.name.slice(0, 2), color: '#5B6AFF', text: m.text, attachments };
        result = await store.appendMessage(client, code, message); break;
      }
      case 'updatePresence': participant(); assertIdentity(member, args[1]); result = await store.updatePresence(client, code, member.name, Date.now()); break;
      case 'setMuted': host(); result = await store.setMuted(client, code, member.name, text(args[2]), args[3] === 'cc' ? 'cc' : 'web', args[4] === true); break;
      case 'removeParticipant': {
        const target = text(args[2]); if (target !== member.name) host();
        result = await store.removeParticipant(client, code, member.name, target, args[3] === 'cc' ? 'cc' : 'web'); break;
      }
      case 'endRoom': host(); result = await store.endRoom(client, code); break;
      case 'reactivateRoom': host(); result = await store.reactivateRoom(client, code); break;
      case 'setReplyMode': {
        host(); if (!['open', 'sequential', 'moderator'].includes(args[2])) throw new AccessError(400, 'Invalid reply mode.');
        result = await store.setReplyMode(client, code, member.name, args[2], args[3]); break;
      }
      case 'directInvoke': {
        host(); const target = object(args[1]);
        result = await store.directInvoke(client, code, { name: text(target.name), client: target.client === 'cc' ? 'cc' : 'web' }, 'host'); break;
      }
      case 'hostSkipCurrent': host(); result = await store.hostSkipCurrent(client, code, room); break;
      case 'appendSystemMessage': {
        host(); const m = object(args[1]);
        result = await store.appendSystemMessage(client, code, { id: Date.now(), time: Date.now(), type: 'sys', name: 'system', client: 'cc', role: '', initials: 'AR', color: '#5B6AFF', text: text(m.text, 2000) }); break;
      }
      case 'createRoomReport': result = await store.createRoomReport(client, room, await store.listMessages(client, code, 0)); break;
      case 'createTask': {
        participant(); const input = object(args[1]);
        result = await store.createTask(client, code, { title: text(input.title, 1000), createdBy: member.name,
          ...(input.owner ? { owner: text(input.owner), ownerClient: 'cc' as const } : {}),
          ...(input.verifier ? { verifier: text(input.verifier), verifierClient: 'cc' as const } : {}), ...(input.dod ? { dod: text(input.dod, 8000) } : {}) }); break;
      }
      case 'updateTask': host(); result = await store.updateTask(client, code, text(args[1]), object(args[2])); break;
      case 'reassignTaskRoles': host(); result = await store.reassignTaskRoles(client, code, text(args[1]), object(args[2]), actor); break;
      case 'cancelTask': host(); result = await store.cancelTask(client, code, text(args[1]), actor, typeof args[3] === 'string' ? args[3].slice(0, 2000) : undefined); break;
      case 'blockTask': {
        participant(); const task = (await store.getTaskBoard(client, code))?.tasks.find(t => t.id === args[1]);
        if (!(task?.owner === member.name && task.ownerClient === 'web')) host();
        result = await store.blockTask(client, code, text(args[1]), actor, text(args[3], 2000)); break;
      }
      case 'verifyTask': participant();
        if (!['done', 'rejected'].includes(args[3])) throw new AccessError(400, 'Invalid verdict.');
        result = await store.verifyTask(client, code, text(args[1]), actor, args[3], typeof args[4] === 'string' ? args[4].slice(0, 8000) : undefined); break;
      default: throw new AccessError(400, 'Unsupported room operation.');
    }
    res.status(200).json({ result: result ?? null });
  } catch (error) {
    if (error instanceof store.RoomNotFoundError) { res.status(404).json({ kind: 'RoomNotFoundError', error: 'Room not found.' }); return; }
    deny(res, error);
  }
}
