export type AgentClientId = 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'print';
export function AgentJoinQuickstart({ roomCode }: { roomCode: string }) {
  return <section className="mb-5 rounded-lg border p-4">
    <h2 className="font-semibold">Connect an approved team agent</h2>
    <p className="my-2 text-sm">Ask your administrator to configure this deployment’s authenticated MCP endpoint with a separate agent identity.</p>
    <p className="text-sm">Room: <code>{roomCode}</code>. Keep access tokens in the client’s secure configuration, never in room messages.</p>
    <p className="mt-2 text-sm">The standalone connector and automatic hooks need a separate review before installation.</p>
  </section>;
}
