import { useEffect, useState, type ReactNode, type FormEvent } from 'react';
let signedInName = '';
export function teamName(): string { return signedInName; }
export function TeamAccess({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/session', { credentials: 'same-origin' }).then(async r => {
      if (r.ok) { signedInName = (await r.json()).name; setReady(true); }
    }).catch(() => setError('Cannot reach the room server.')).finally(() => setLoading(false));
  }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const r = await fetch('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token.trim()}` }, credentials: 'same-origin' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Sign-in failed.');
      signedInName = data.name; setToken(''); setReady(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed.'); }
    finally { setLoading(false); }
  }
  if (ready) return <>{children}</>;
  return <form onSubmit={signIn} className="max-w-md mx-auto mt-16 p-8 border rounded-xl bg-white">
    <h1 className="text-xl font-semibold">Private team room</h1>
    <p className="my-4">Enter the access token issued to you by your team administrator.</p>
    <label>Access token<input className="block w-full border rounded p-2 my-2" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required /></label>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <button className="bg-accent text-white rounded px-4 py-2" disabled={loading}>{loading ? 'Checking…' : 'Sign in'}</button>
  </form>;
}
