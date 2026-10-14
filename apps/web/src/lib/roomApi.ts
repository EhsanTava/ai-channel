import type * as Store from '@agent-room/upstash-client';
export type { TurnState } from '@agent-room/upstash-client';
export class HostNameTakenError extends Error {}
export class RoomNotFoundError extends Error {}
export function createClient() { return Object.freeze({ transport: 'room-api' }); }
type Remote<F> = F extends (client: any, ...args: infer A) => infer R ? (client: ReturnType<typeof createClient>, ...args: A) => R : never;
function operation<K extends keyof typeof Store>(action: K): Remote<(typeof Store)[K]> {
  return (async (_client: unknown, ...args: unknown[]) => {
    const response = await fetch('/api/room', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, args }), signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok) {
      if (body.kind === 'RoomNotFoundError') throw new RoomNotFoundError(body.error);
      if (body.kind === 'HostNameTakenError') throw new HostNameTakenError(body.error);
      throw new Error(body.error || 'Room request failed.');
    }
    return body.result;
  }) as Remote<(typeof Store)[K]>;
}
export const getRoom = operation('getRoom');
export const listMessages = operation('listMessages');
export const appendMessage = operation('appendMessage');
export const updatePresence = operation('updatePresence');
export const getMessageTotalCount = operation('getMessageTotalCount');
export const getTaskBoard = operation('getTaskBoard');
export const createRoom = operation('createRoom');
export const joinRoom = operation('joinRoom');
export const verifyHostKey = operation('verifyHostKey');
export const appendSystemMessage = operation('appendSystemMessage');
export const directInvoke = operation('directInvoke');
export const getTurnState = operation('getTurnState');
export const hostSkipCurrent = operation('hostSkipCurrent');
export const setMuted = operation('setMuted');
export const setReplyMode = operation('setReplyMode');
export const createRoomReport = operation('createRoomReport');
export const getRoomReport = operation('getRoomReport');
export const endRoom = operation('endRoom');
export const reactivateRoom = operation('reactivateRoom');
export const removeParticipant = operation('removeParticipant');
export const blockTask = operation('blockTask');
export const cancelTask = operation('cancelTask');
export const createTask = operation('createTask');
export const reassignTaskRoles = operation('reassignTaskRoles');
export const updateTask = operation('updateTask');
export const verifyTask = operation('verifyTask');
