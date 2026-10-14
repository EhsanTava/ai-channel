import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import * as access from '../api/_access.ts';
import roomHandler from '../api/room.ts';
import sessionHandler from '../api/session.ts';
import uploadHandler from '../api/upload.ts';
import deleteHandler from '../api/delete-room-blobs.ts';
import attachmentHandler from '../api/attachment.ts';
import reportPage from '../api/report-page.ts';
import reportOg from '../api/report-og.ts';
import installHandler from '../api/install.ts';
import { createRemoteRoomClient, joinRoom as mcpJoin, endRoom as mcpEnd } from '../api/_mcpRoomClient.ts';
import { createClient, casRoom, createRoom, getRoom, joinRoom, verifyHostClaim, casTurnState } from '@agent-room/upstash-client';

const token = 'A'.repeat(43), guestToken = 'B'.repeat(43);
const member = { name: 'Host', tokenHash: createHash('sha256').update(token).digest('hex') };
const guest = { name: 'Guest', tokenHash: createHash('sha256').update(guestToken).digest('hex') };
const code = 'ABC-DEF-GHJ';
let db, commands, objectCalls;
function command(c) {
  commands.push(c);
  const [op, key, ...rest] = c;
  if (op === 'GET') return db.get(key) ?? null;
  if (op === 'SET') { if (rest.includes('NX') && db.has(key)) return null; db.set(key, rest[0]); return 'OK'; }
  if (op === 'DEL') { db.delete(key); return 1; }
  if (op === 'EVAL') {
    const script = key, actualKey = rest[1], a = rest.slice(2);
    if (script.includes("redis.call('INCR'")) { const n = Number(db.get(actualKey) ?? 0) + 1; db.set(actualKey, n); return n; }
    if ((db.get(actualKey) ?? '') !== a[0]) return 0;
    if (a[1] === '') db.delete(actualKey); else db.set(actualKey, a[1]); return 1;
  }
  if (op === 'LLEN') return (db.get(key) ?? []).length;
  if (op === 'LRANGE') return (db.get(key) ?? []).slice(rest[0], rest[1] === -1 ? undefined : rest[1] + 1);
  if (op === 'RPUSH') { db.set(key, [...(db.get(key) ?? []), ...rest]); return db.get(key).length; }
  if (op === 'INCR') { const n = Number(db.get(key) ?? 0) + 1; db.set(key, n); return n; }
  if (op === 'EXPIREAT' || op === 'EXPIRE' || op === 'LTRIM') return 1;
  throw new Error(`Unexpected mock command: ${op}`);
}
function response() {
  return { statusCode: 200, headers: {}, body: null, setHeader(k,v) { this.headers[k.toLowerCase()] = v; return this; }, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; }, send(v) { this.body=v; return this; }, end() { return this; } };
}
function request(who = 'Host', body = {}, method = 'POST') {
  return { method, headers: { authorization: `Bearer ${who === 'Host' ? token : guestToken}` }, body, query: {} };
}
async function call(action, args, who = 'Host') { const res=response(); await roomHandler(request(who, {action,args}), res); return res; }
function seed() {
  db.set(`room:${code}`, JSON.stringify({ code, createdBy: 'Host', ownerId: 'Host', topic: 'Private', createdAt: Date.now(), status: 'active', version: 1, replyMode: 'open', participants: [{name:'Host',client:'web',canSpeak:true},{name:'Guest',client:'web',canSpeak:true}] }));
}
beforeEach(() => {
  db=new Map(); commands=[]; objectCalls=[];
  process.env.AGENT_ROOM_MEMBERS=JSON.stringify([member,guest]); process.env.AGENT_ROOM_ORIGIN='https://rooms.example';
  process.env.UPSTASH_REDIS_REST_URL='https://storage.invalid'; process.env.UPSTASH_REDIS_REST_TOKEN='test-only';
  for (const name of ['ACCOUNT_ID','BUCKET','ACCESS_KEY_ID','SECRET_ACCESS_KEY']) process.env[`R2_${name}`]='test-only';
  process.env.R2_PRIVATE_BUCKET_CONFIRMED='1';
  globalThis.fetch=async (url, options) => {
    assert.ok(String(url).startsWith('https://storage.invalid/'), 'Real network calls prohibited');
    const input=JSON.parse(options.body); const result=String(url).endsWith('/pipeline') ? input.map(c=>({result:command(c)})) : {result:command(input)};
    return new Response(JSON.stringify(result),{status:200});
  };
  globalThis.__s3=async c=> { objectCalls.push(c); return { Contents: [] }; };
});
test('valid bearer identifies its member; missing, malformed and wrong tokens fail',()=>{
  assert.equal(access.fromBearer(`Bearer ${token}`).name,'Host');
  for(const value of [undefined,'Bearer short',`Bearer ${'C'.repeat(43)}`]) assert.throws(()=>access.fromBearer(value));
});
test('missing configuration and duplicate identities fail closed',()=>{
  delete process.env.AGENT_ROOM_MEMBERS; assert.throws(()=>access.fromBearer(`Bearer ${token}`));
  process.env.AGENT_ROOM_MEMBERS=JSON.stringify([member,{...guest,name:'host'}]); assert.throws(()=>access.members());
});
test('sessions reject tampering, expiry and revoked tokens',()=>{
  const value=access.sessionValue(member,1000000); assert.equal(access.fromSession(value,1000001).name,'Host');
  assert.throws(()=>access.fromSession(value+'x',1000001));
  assert.throws(()=>access.fromSession(value,1000000+9*3600000));
  process.env.AGENT_ROOM_MEMBERS=JSON.stringify([guest]); assert.throws(()=>access.fromSession(value,1000001));
});
test('cookie writes require exact origin; bearer cross-origin requests are rejected',()=>{
  const cookie=`agent_room_session=${access.sessionValue(member)}`;
  assert.equal(access.requireAccess({method:'POST',headers:{cookie,origin:'https://rooms.example'}}).name,'Host');
  for(const origin of [undefined,'https://evil.example']) assert.throws(()=>access.requireAccess({method:'POST',headers:{cookie,origin}}));
  assert.throws(()=>access.requireAccess({method:'POST',headers:{authorization:`Bearer ${token}`,origin:'https://evil.example'}}));
});
test('insecure non-loopback origins fail configuration',()=>{
  process.env.AGENT_ROOM_ORIGIN='http://rooms.example'; assert.throws(()=>access.appOrigin());
  process.env.AGENT_ROOM_ORIGIN='http://localhost:4310'; assert.equal(access.appOrigin(),'http://localhost:4310');
});
test('session login uses private HttpOnly Secure cookie and never returns token',async()=>{
  const res=response(); await sessionHandler(request(),res);
  assert.equal(res.statusCode,200); assert.deepEqual(res.body,{name:'Host'});
  assert.match(res.headers['set-cookie'],/HttpOnly; SameSite=Strict/); assert.match(res.headers['set-cookie'],/Secure/);
  assert.equal(res.headers['cache-control'],'private, no-store');
});
test('anonymous room access never touches storage',async()=>{
  const req=request(); req.headers={}; const res=response(); await roomHandler(req,res);
  assert.ok([401,403].includes(res.statusCode)); assert.equal(commands.length,0);
});
test('room code is not authorization and arbitrary Redis operations are unavailable',async()=>{
  seed(); const res=await call('command',['FLUSHALL']); assert.equal(res.statusCode,400); assert.equal(db.has(`room:${code}`),true);
});
test('room creation binds host identity and refuses code overwrite',async()=>{
  const forged=await call('createRoom',[{code,topic:'test',createdBy:'Host'}],'Guest'); assert.equal(forged.statusCode,403);
  const first=await call('createRoom',[{code,topic:'test',createdBy:'Host'}]); assert.equal(first.statusCode,200);
  const previous=db.get(`room:${code}`); const second=await call('createRoom',[{code,topic:'overwrite',createdBy:'Host'}]); assert.notEqual(second.statusCode,200); assert.equal(db.get(`room:${code}`),previous);
});
test('guest cannot perform host controls by supplying host name',async()=>{
  seed();
  for(const [action,args] of [['setMuted',[code,'Host','Host','web',true]],['endRoom',[code]],['directInvoke',[code,{name:'Host',client:'web'},'host']],['appendSystemMessage',[code,{text:'Forged system'}]],['updateTask',[code,'T-01',{}]]]) {
    const res=await call(action,args,'Guest'); assert.equal(res.statusCode,403,action);
  }
});
test('host controls work through authenticated browser API',async()=>{
  seed(); const res=await call('setMuted',[code,'Host','Guest','web',true]); assert.equal(res.statusCode,200);
  assert.equal(JSON.parse(db.get(`room:${code}`)).participants[1].canSpeak,false);
});
test('forged sender denied; rejoin cannot remove mute',async()=>{
  seed(); assert.equal((await call('appendMessage',[code,{name:'Host',text:'forged'}],'Guest')).statusCode,403);
  await call('setMuted',[code,'Host','Guest','web',true]);
  const rejoin=await call('joinRoom',[code,{name:'Guest',role:'test',canSpeak:true}],'Guest'); assert.equal(rejoin.statusCode,200); assert.equal(rejoin.body.result.participant.canSpeak,false);
});
test('storage host join and legacy host claim require actual proof',async()=>{
  seed(); const client=createClient({url:'https://storage.invalid',token:'test'});
  await assert.rejects(()=>verifyHostClaim(client,code,{}));
  await assert.rejects(()=>joinRoom(client,code,{name:'Host',client:'cc'},{}));
});
test('MCP host key/name spoof cannot end another host room',async()=>{
  seed(); const client=createRemoteRoomClient(undefined,guest);
  await assert.rejects(()=>mcpEnd(client,code,'Host','anything'));
  await assert.rejects(()=>client.post({action:'setReplyMode',code,requesterName:'Host',mode:'open'}));
  await assert.rejects(()=>mcpJoin(client,code,{name:'Host',client:'cc'}));
});
test('outbound webhooks fail closed even for host',async()=>{
  seed(); await assert.rejects(()=>createRemoteRoomClient(undefined,member).post({action:'webhookSet',code,url:'https://internal.example'}));
});
test('room CAS retries an interleaved write without losing either change',async()=>{
  seed(); const backing=createClient({url:'https://storage.invalid',token:'test'}); let conflict=true;
  const client={...backing,async command(c) { if(c[0]==='EVAL' && conflict) { conflict=false; const room=JSON.parse(db.get(`room:${code}`)); room.topic='Concurrent'; room.version++; db.set(`room:${code}`,JSON.stringify(room)); } return backing.command(c); }};
  const result=await casRoom(client,code,room=>({...room,status:'ended'}));
  assert.equal(result.topic,'Concurrent'); assert.equal(result.status,'ended'); assert.equal(result.version,3);
});
test('expired room during CAS is not resurrected',async()=>{
  seed(); const backing=createClient({url:'https://storage.invalid',token:'test'});
  const client={...backing,async command(c){if(c[0]==='EVAL') db.delete(`room:${code}`); return backing.command(c);}};
  await assert.rejects(()=>casRoom(client,code,r=>({...r,status:'ended'}))); assert.equal(db.has(`room:${code}`),false);
});
test('turn CAS retries an interleaved update',async()=>{
  db.set(`turn-state:${code}`,JSON.stringify({round:1,queue:[]}));
  const backing=createClient({url:'https://storage.invalid',token:'test'}); let conflict=true;
  const client={...backing,async command(c) { if(c[0]==='EVAL'&&conflict){conflict=false;db.set(`turn-state:${code}`,JSON.stringify({round:2,queue:[]}));}return backing.command(c);}};
  const state=await casTurnState(client,code,s=>({...s,currentName:'Host'})); assert.equal(state.round,2); assert.equal(state.currentName,'Host');
});
test('Redis error envelopes fail instead of succeeding silently',async()=>{
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'mock failure'}),{status:200});
  await assert.rejects(()=>createClient({url:'https://storage.invalid',token:'test'}).command(['GET','x']));
});
test('host deletion requires authentication and host authority',async()=>{
  seed(); const res=response(); await deleteHandler(request('Guest',{roomCode:code}),res); assert.equal(res.statusCode,403); assert.equal(objectCalls.length,0);
  const ok=response(); await deleteHandler(request('Host',{roomCode:code}),ok); assert.equal(ok.statusCode,200); assert.equal(objectCalls[0].kind,'ListObjectsV2Command');
});
function multipart(who,mime='text/plain',roomCode=code){
  const boundary='test-boundary';
  const body=`--${boundary}\r\nContent-Disposition: form-data; name="roomCode"\r\n\r\n${roomCode}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.txt"\r\nContent-Type: ${mime}\r\n\r\nhello\r\n--${boundary}--\r\n`;
  const req=Readable.from([Buffer.from(body)]); Object.assign(req,request(who));req.headers['content-type']=`multipart/form-data; boundary=${boundary}`; return req;
}
test('uploads require authentication before consuming request body',async()=>{
  const req=multipart('Host'); req.headers.authorization=undefined; let consumed=false;req.on('data',()=>{consumed=true;});req.pause();
  const res=response(); await uploadHandler(req,res); assert.ok([401,403].includes(res.statusCode));assert.equal(objectCalls.length,0);assert.equal(consumed,false);req.destroy();
});
test('upload rejects HTML and nonmembers, stores allowed files privately',async()=>{
  seed(); const html=response();await uploadHandler(multipart('Host','text/html'),html);assert.equal(html.statusCode,415);
  const room=JSON.parse(db.get(`room:${code}`));room.participants=room.participants.filter(p=>p.name!=='Guest');db.set(`room:${code}`,JSON.stringify(room));
  const denied=response();await uploadHandler(multipart('Guest'),denied);assert.equal(denied.statusCode,403);
  const ok=response();await uploadHandler(multipart('Host'),ok);assert.equal(ok.statusCode,201);assert.match(ok.body.url,/^\/api\/attachment\?key=/);
  assert.equal(objectCalls[0].input.ContentType,'application/octet-stream');assert.equal(objectCalls[0].input.CacheControl,'private, no-store');
});
test('attachment download is authenticated, bounded and forced as download',async()=>{
  seed();const key=`rooms/${code}/00000000-0000-0000-0000-000000000000/sample.txt`;
  globalThis.__s3=async()=>({ContentLength:5,Body:{transformToByteArray:async()=>Buffer.from('hello')}});
  const req=request('Guest',{},'GET');req.query={key};const res=response();await attachmentHandler(req,res);
  assert.equal(res.statusCode,200);assert.match(res.headers['content-disposition'],/^attachment;/);assert.equal(res.headers['content-type'],'application/octet-stream');
  req.headers={};const denied=response();await attachmentHandler(req,denied);assert.equal(denied.statusCode,401);
});
test('public bucket not explicitly confirmed private fails closed',async()=>{
  seed();delete process.env.R2_PRIVATE_BUCKET_CONFIRMED;const req=multipart('Host');const res=response();await uploadHandler(req,res);assert.equal(res.statusCode,503);assert.equal(objectCalls.length,0);req.destroy();
});
test('distributed request limits block excess requests',async()=>{
  seed();db.set(`rate:room:${createHash('sha256').update('Host').digest('hex')}`,240);
  assert.equal((await call('getRoom',[code])).statusCode,429);
});
test('automatic installer cannot execute an unreviewed latest package',async()=>{
  const res=response();await installHandler(request(),res);assert.equal(res.statusCode,410);
});
test('browser does not import runtime Redis client or database credentials',()=>{
  const source=readFileSync(new URL('../apps/web/src/lib/roomApi.ts',import.meta.url),'utf8');assert.match(source,/import type \* as Store/);assert.doesNotMatch(source,/Authorization|REST_TOKEN|\.command\(/);
});

test('anonymous report previews cannot expose cached private topics',async()=>{
  for(const handler of [reportPage,reportOg]) {
    const req=request('Host',{},'GET');req.headers={};req.query={code};const res=response();await handler(req,res);
    assert.equal(res.statusCode,401);assert.equal(res.headers['cache-control'],'private, no-store');
  }
  assert.equal(commands.length,0);
});
test('legitimate messages strip forged system metadata and host flags',async()=>{
  seed(); const res=await call('appendMessage',[code,{name:'Guest',text:'hello',type:'sys',hostVerified:true,metadata:{eventType:'mode_changed'}}],'Guest');
  assert.equal(res.statusCode,200);
  const pushed=commands.find(c=>c[0]==='RPUSH');assert.ok(pushed);
  const message=JSON.parse(pushed[2]);assert.equal(message.name,'Guest');assert.equal(message.type,'msg');assert.equal(message.hostVerified,undefined);assert.notEqual(message.metadata?.eventType,'mode_changed');
});
test('non-host cannot reassign or cancel tasks via MCP',async()=>{
  seed();const client=createRemoteRoomClient(undefined,guest);
  for(const action of ['taskReassign','taskCancel']) await assert.rejects(()=>client.post({action,code,id:'T-01',requesterName:'Host'}));
});
test('host MCP end succeeds without trusting submitted display name',async()=>{
  seed();const client=createRemoteRoomClient(undefined,member);await mcpEnd(client,code,'ignored',undefined);
  assert.equal(JSON.parse(db.get(`room:${code}`)).status,'ended');
});
