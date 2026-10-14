import { AccessError, assertIdentity, assertHost as requireHost, type Member } from './_access.js';
// MCP storage operations are called only after authenticated identity binding in api/mcp.ts.
import { generateCode } from '@agent-room/shared';
import type { Message, Participant, Room, RoomReport } from '@agent-room/shared';
import {
  createClient,
  createRoom as storeCreateRoom,
  createRoomReport as storeCreateRoomReport,
  endRoom as storeEndRoom,
  getRoom as storeGetRoom,
  joinRoom as storeJoinRoom,
  listMessages as storeListMessages,
  appendMessage as storeAppendMessage,
  reactivateRoom as storeReactivateRoom,
  removeParticipant as storeRemoveParticipant,
  setListenUntil as storeSetListenUntil,
  updatePresence,
  HostNameTakenError,
  MutedError,
  NotHostError,
  NotYourTurnError,
  RoomNotFoundError,
  getTaskBoard,
  createTask,
  claimTask,
  submitTask,
  verifyTask,
  reassignTaskRoles,
  cancelTask,
  listRoomWebhooks,
  unregisterRoomWebhook,
  WebhookLimitError,
  NotParticipantError,
  setReplyMode,
  getTurnState,
  directInvoke,
  hostSkipCurrent,
  canAgentSpeakNow,
  myRoleInTurn,
  sweepTimeouts,
} from '@agent-room/upstash-client';
import type { UpstashClient } from '@agent-room/upstash-client';

/** Same shape the hosted deployment's client throws, so the tool layer's
 *  error handling is identical on both. */
export class RemoteRoomApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'RemoteRoomApiError';
  }
}

export interface RemoteRoomClient {
  readonly store: UpstashClient;
  readonly member?: Member;
  /**
   * The rest of the room API, as an action envelope.
   *
   * The eleven named functions below cover the room lifecycle, but the task
   * board, webhook and moderator-admin tools in `_mcpTools.ts` reach past them
   * and post an `{ action }` payload directly. That is the hosted deployment's
   * HTTP body; here it is dispatched onto upstash-client instead. Every action
   * the tool layer sends must be handled — an unknown one throws rather than
   * returning a plausible empty result, because a task board that silently
   * does nothing is worse than one that fails loudly.
   */
  post<T>(payload: Record<string, unknown>): Promise<T>;
}

export function createRemoteRoomClient(_requestHost: string | undefined, member?: Member): RemoteRoomClient {
  // Database credentials are server-only. Never use VITE-prefixed secrets.
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new RemoteRoomApiError(
      'Room storage is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on the deployment.',
      500,
      'not_configured',
    );
  }
  const store = createClient({ url, token });
  return { store, member, post: (payload) => {
    if (!member) throw new AccessError(401, 'Authenticated caller required.');
    return dispatchAction(store, { ...payload, requesterName: member.name, name: member.name }) as never;
  } };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const agent = (name: unknown) => ({ name: str(name), client: 'cc' as const });

/** The `{ action }` envelope, mapped onto upstash-client. */
async function dispatchAction(store: UpstashClient, p: Record<string, unknown>): Promise<unknown> {
  const code = str(p.code);
  try {
    switch (p.action) {
      // ── task board ──────────────────────────────────────────────────────
      case 'taskBoard':
        return { board: (await getTaskBoard(store, code)) ?? { code, tasks: [], version: 0 } };
      case 'taskCreate':
        return await createTask(store, code, {
          title: str(p.title),
          createdBy: str(p.requesterName),
          ...(p.id ? { id: str(p.id) } : {}),
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
          ...(p.dod ? { dod: str(p.dod) } : {}),
        });
      case 'taskClaim':
        return await claimTask(store, code, str(p.id), agent(p.name));
      case 'taskSubmit':
        return await submitTask(
          store, code, str(p.id), agent(p.name),
          p.evidence as Parameters<typeof submitTask>[4],
        );
      case 'taskVerify':
        return await verifyTask(
          store, code, str(p.id), agent(p.name),
          p.verdict === 'done' ? 'done' : 'rejected',
          typeof p.note === 'string' ? p.note : undefined,
        );
      case 'taskReassign':
        await assertHostFor(store, code, str(p.requesterName), undefined);
        return await reassignTaskRoles(store, code, str(p.id), {
          ...(p.owner ? { owner: str(p.owner), ownerClient: 'cc' as const } : {}),
          ...(p.verifier ? { verifier: str(p.verifier), verifierClient: 'cc' as const } : {}),
        }, agent(p.requesterName));
      case 'taskCancel':
        await assertHostFor(store, code, str(p.requesterName), undefined);
        return await cancelTask(
          store, code, str(p.id), agent(p.requesterName),
          typeof p.reason === 'string' ? p.reason : undefined,
        );

      // ── resident webhooks ───────────────────────────────────────────────
      case 'webhookSet': {
        throw new AccessError(403, 'Outbound webhooks are disabled in this private deployment.');
      }
      case 'webhookList':
        await assertHostFor(store, code, str(p.requesterName), undefined);
        return { webhooks: (await listRoomWebhooks(store, code)).map(({ secret: _secret, ...hook }) => hook) };
      case 'webhookDelete':
        await assertHostFor(store, code, str(p.requesterName), undefined);
        return { removed: await unregisterRoomWebhook(store, code, str(p.id)) };

      // ── host / moderator controls ───────────────────────────────────────
      case 'setReplyMode': {
        await assertHostFor(store, code, str(p.requesterName), p.hostKey as string | undefined);
        const room = await setReplyMode(
          store, code, str(p.requesterName),
          p.mode as Parameters<typeof setReplyMode>[3],
          p.config as Parameters<typeof setReplyMode>[4],
        );
        return { room };
      }
      case 'directInvoke': {
        await assertHostFor(store, code, str(p.requesterName), undefined);
        const target = p.target as { name?: string } | undefined;
        return { added: await directInvoke(store, code, { name: str(target?.name), client: 'cc' }, 'host') };
      }
      case 'skipCurrent': {
        await assertHostFor(store, code, str(p.requesterName), undefined);
        return { skipped: await hostSkipCurrent(store, code, await storeGetRoom(store, code)) };
      }

      default:
        throw new RemoteRoomApiError(
          `Unsupported room action "${String(p.action)}" on this deployment.`,
          400,
          'unsupported_action',
        );
    }
  } catch (e) {
    if (e instanceof WebhookLimitError) throw new RemoteRoomApiError(e.message, 409, 'WebhookLimitError');
    if (e instanceof NotParticipantError) throw new RemoteRoomApiError(e.message, 403, 'NotParticipantError');
    return translate(e);
  }
}

/** Shared by the admin actions; see assertHost below for why this exists. */
async function assertHostFor(
  store: UpstashClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<void> {
  const room = await storeGetRoom(store, code);
  if (requesterName === room.createdBy) return;
  throw new RemoteRoomApiError(
    `Only the authenticated room host can do this.`,
    403,
    'NotHostError',
  );
}

/**
 * Map a storage-layer throw onto the code the tool layer knows how to explain.
 * Anything unrecognised is rethrown untouched — inventing a code for an error
 * we do not understand would hand the agent confident, wrong guidance.
 */
function translate(e: unknown): never {
  if (e instanceof RemoteRoomApiError) throw e;
  if (e instanceof MutedError) throw new RemoteRoomApiError(e.message, 403, 'MutedError');
  if (e instanceof NotYourTurnError) throw new RemoteRoomApiError(e.message, 409, 'NotYourTurnError');
  if (e instanceof NotHostError) throw new RemoteRoomApiError(e.message, 403, 'NotHostError');
  if (e instanceof HostNameTakenError) throw new RemoteRoomApiError(e.message, 409, 'HostNameTakenError');
  if (e instanceof RoomNotFoundError) throw new RemoteRoomApiError(e.message, 404, 'RoomNotFoundError');
  throw e;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return translate(e);
  }
}

export async function createRoom(
  client: RemoteRoomClient,
  input: { topic: string; createdBy: string },
): Promise<Room & { hostKey: string }> {
  if (!client.member) throw new AccessError(401, 'Authenticated caller required.');
  assertIdentity(client.member, input.createdBy);
  // Codes are generated here rather than by the caller, matching the hosted
  // server. A collision is a 1-in-many-millions event, but retrying twice is
  // cheaper than explaining to a user why their room code was already taken.
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode();
    try {
      return await storeCreateRoom(client.store, { code, topic: input.topic, createdBy: input.createdBy, ownerId: client.member.name });
    } catch (e) {
      lastError = e;
    }
  }
  return translate(lastError);
}

export async function getRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

/** Read the speaking entitlement from storage, including legacy grace and
 * moderator direct assignments. No commercial HTTP/auth service is required. */
export async function getSpeakingTurn(client: RemoteRoomClient, code: string, name: string) {
  const room = await storeGetRoom(client.store, code);
  if (room.status !== 'active' || !room.participants.some(p => p.name === name && p.client === 'cc' && p.canSpeak !== false)) return null;
  const mode = room.replyMode;
  if (mode !== 'sequential' && mode !== 'moderator') return null;
  const { state } = await sweepTimeouts(client.store, code, room);
  if (!state || state.mode !== mode) return null;
  const directed = state.hostDirected?.some(p => p.name === name && p.client === 'cc');
  if (!directed && !canAgentSpeakNow(state, name, 'cc')) return null;
  return {
    mode,
    round: state.round ?? 1,
    role: directed ? 'assignee' as const : myRoleInTurn(state, name, 'cc'),
    isLead: state.currentName === name && state.currentClient === 'cc'
      && (state.currentRole === 'lead' || state.currentRole === 'wrap'),
  };
}

/**
 * Refresh what the room knows about who is present.
 *
 * The hosted server has a dedicated `sweep` action that also expires stale
 * seats. Here the same read is a `getRoom`, which already normalises the
 * stored record; presence expiry is the caller's business via
 * `isParticipantStale`, not a stored mutation.
 */
export async function sweepRoom(client: RemoteRoomClient, code: string): Promise<Room> {
  return guarded(() => storeGetRoom(client.store, code));
}

export async function joinRoom(
  client: RemoteRoomClient,
  code: string,
  participant: Participant,
  options: { hostKey?: string; seatKey?: string } = {},
): Promise<Room & { participant: Participant; seatKey?: string }> {
  return guarded(async () => {
    if (!client.member) throw new AccessError(401, 'Authenticated caller required.');
    assertIdentity(client.member, participant.name);
    const before = await storeGetRoom(client.store, code);
    if (before.participants.some(p => p.name === participant.name && p.client !== 'cc')) throw new AccessError(409, 'Use a separate identity for each browser and agent.');
    const old = before.participants.find(p => p.name === participant.name && p.client === 'cc');
    const result = await storeJoinRoom(client.store, code, { ...participant, canSpeak: old?.canSpeak ?? true }, {
      authedUserId: client.member.name,
      ...(options.hostKey ? { hostKey: options.hostKey } : {}),
      ...(options.seatKey ? { seatKey: options.seatKey } : {}),
      priorIdentity: { name: participant.name, client: 'cc' as const },
    });
    return result as Room & { participant: Participant; seatKey?: string };
  });
}

export async function listMessages(client: RemoteRoomClient, code: string, since: number): Promise<Message[]> {
  return guarded(() => storeListMessages(client.store, code, since));
}

export async function appendMessage(
  client: RemoteRoomClient,
  code: string,
  message: Message,
  kind: 'message' | 'status' = 'message',
): Promise<unknown> {
  if (!client.member) throw new AccessError(401, 'Authenticated caller required.');
  assertIdentity(client.member, message.name);
  const result = await guarded(() => storeAppendMessage(client.store, code, message, kind));
  return result;
}

export async function setListenUntil(
  client: RemoteRoomClient,
  code: string,
  name: string,
  until: number,
): Promise<void> {
  await guarded(async () => {
    await storeSetListenUntil(client.store, code, name, until);
    await updatePresence(client.store, code, name, Date.now());
  });
}

export async function removeParticipant(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  targetName: string,
): Promise<Room> {
  if (!client.member) throw new AccessError(401, 'Authenticated caller required.');
  assertIdentity(client.member, requesterName);
  // MCP agents are always 'cc' seats; the web seats leave through the UI.
  return guarded(() => storeRemoveParticipant(client.store, code, requesterName, targetName, 'cc'));
}

// Host authority is bound to the authenticated member, never a supplied name.
async function assertHost(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<void> {
  const room = await storeGetRoom(client.store, code);
  if (!client.member) throw new AccessError(401, 'Authenticated caller required.');
  requireHost(client.member, room);
  return;
}

export async function endRoom(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHost(client, code, requesterName, hostKey);
    return storeEndRoom(client.store, code);
  });
}

export async function reactivateRoom(
  client: RemoteRoomClient,
  code: string,
  requesterName: string,
  hostKey: string | undefined,
): Promise<Room> {
  return guarded(async () => {
    await assertHost(client, code, requesterName, hostKey);
    return storeReactivateRoom(client.store, code);
  });
}

export async function createRoomReport(client: RemoteRoomClient, code: string): Promise<RoomReport> {
  return guarded(async () => {
    const room = await storeGetRoom(client.store, code);
    const messages = await storeListMessages(client.store, code, 0);
    return storeCreateRoomReport(client.store, room, messages);
  });
}
