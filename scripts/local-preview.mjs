// Local-only preview: real Redis through a private Unix socket; no cloud services.
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setSession, privateResponse } from '../api/_access.ts';
import room from '../api/room.ts';
import session from '../api/session.ts';

const port = Number(process.env.LOCAL_PREVIEW_PORT ?? 4311);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port.');
const origin = `http://127.0.0.1:${port}`;
const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = join(root, 'apps/web/dist');
await stat(join(publicRoot, 'index.html'));
const runDir = await mkdtemp(join(tmpdir(), 'agent-room-preview-'));
const socketPath = join(runDir, 'redis.sock');
const secret = randomBytes(32).toString('base64url');
const member = { name: 'Local Host', tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex') };
process.env.AGENT_ROOM_MEMBERS = JSON.stringify([member]);
process.env.AGENT_ROOM_ORIGIN = origin;
// Never inherit cloud attachment access for a preview.
for (const key of Object.keys(process.env)) if (key.startsWith('R2_')) delete process.env[key];
const redis = spawn('/opt/homebrew/bin/redis-server', [
  '--port','0','--unixsocket',socketPath,'--unixsocketperm','700',
  '--save','','--appendonly','no','--dir',runDir,'--maxmemory','128mb','--maxmemory-policy','noeviction',
], { stdio: ['ignore','ignore','pipe'] });
redis.stderr.on('data', () => {});
let startupError;
redis.on('error', error => { startupError = error; });
for (let n=0; n<100; n++) {
  if (startupError || redis.exitCode !== null) throw new Error('Private Redis failed to start.');
  if (await stat(socketPath).then(()=>true,()=>false)) break;
  if (n===99) throw new Error('Private Redis startup timed out.');
  await delay(50);
}
function parseResp(data, offset=0) {
  const end=data.indexOf('\r\n',offset); if(end<0) return null;
  const kind=String.fromCharCode(data[offset]), line=data.toString('utf8',offset+1,end); let next=end+2;
  if(kind==='+') return {value:line,next};
  if(kind==='-') return {value:{error:'Redis command failed'},next};
  if(kind===':') return {value:Number(line),next};
  const size=Number(line);
  if(kind==='$') {
    if(size===-1)return {value:null,next};
    if(data.length<next+size+2)return null;
    return {value:data.toString('utf8',next,next+size),next:next+size+2};
  }
  if(kind==='*') {
    if(size===-1)return {value:null,next}; const value=[];
    for(let i=0;i<size;i++){const item=parseResp(data,next);if(!item)return null;value.push(item.value);next=item.next;}
    return {value,next};
  }
  throw new Error('Invalid Redis response');
}
const commands=new Set(['GET','SET','DEL','INCR','EXPIRE','EXPIREAT','PEXPIRE','TTL','PTTL','RPUSH','LPUSH','LRANGE','LLEN','LTRIM','SADD','SREM','SMEMBERS','EVAL']);
function redisCommands(batch) {
  if(!Array.isArray(batch)||batch.length<1||batch.length>100)throw new Error('Invalid command batch');
  const wire=batch.map(cmd=>{
    if(!Array.isArray(cmd)||!commands.has(cmd[0])||cmd.length>200||cmd.some(x=>typeof x!=='string'&&typeof x!=='number'))throw new Error('Invalid storage command');
    return `*${cmd.length}\r\n`+cmd.map(x=>{const s=String(x);return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;}).join('');
  }).join('');
  return new Promise((resolvePromise,reject)=>{
    const socket=createConnection(socketPath);let buffer=Buffer.alloc(0);const results=[];let done=false;
    const fail=e=>{if(!done){done=true;socket.destroy();reject(e);}};
    socket.setTimeout(8000,()=>fail(new Error('Redis timeout')));socket.on('error',fail);
    socket.on('connect',()=>socket.write(wire));
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);if(buffer.length>32*1024*1024){fail(new Error('Redis response too large'));return;}
      try{
        let result;while((result=parseResp(buffer))){results.push(result.value);buffer=buffer.subarray(result.next);}
        if(results.length===batch.length){done=true;socket.end();resolvePromise(results);}
      }catch(e){fail(e);}
    });
    socket.on('end',()=>{if(!done)fail(new Error('Incomplete Redis response'));});
  });
}
async function readJson(req, max=128*1024) {
  let size=0;const parts=[];
  for await(const chunk of req){size+=chunk.length;if(size>max)throw new Error('Request too large');parts.push(chunk);}
  return parts.length?JSON.parse(Buffer.concat(parts).toString('utf8')):{};
}
const bridge=createServer(async(req,res)=>{
  try{
    const provided=Buffer.from(String(req.headers.authorization??'')), expected=Buffer.from(`Bearer ${secret}`);
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected)||req.method!=='POST') {res.writeHead(403).end();return;}
    const pipeline=req.url==='/pipeline';if(!pipeline&&req.url!=='/'){res.writeHead(404).end();return;}
    const input=await readJson(req);const values=await redisCommands(pipeline?input:[input]);
    const envelope=values.map(result=>result?.error?result:{result});
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(pipeline?envelope:envelope[0]));
  }catch{res.writeHead(400).end(JSON.stringify({error:'Local storage request failed'}));}
});
await new Promise((resolvePromise,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolvePromise);});
process.env.UPSTASH_REDIS_REST_URL=`http://127.0.0.1:${bridge.address().port}`;
process.env.UPSTASH_REDIS_REST_TOKEN=secret;
function decorate(res){
  res.status=function(code){this.statusCode=code;return this;};
  res.json=function(value){this.setHeader('Content-Type','application/json');this.end(JSON.stringify(value));return this;};
  res.send=function(value){this.end(value);return this;};
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
  decorate(res);privateResponse(res);
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  try{
    if(req.headers.host!==`127.0.0.1:${port}`){res.status(403).json({error:'Local host only'});return;}
    const url=new URL(req.url,origin);
    if(url.pathname==='/local-preview' && req.method==='GET') {
      if(req.headers['sec-fetch-site'] && !['none','same-origin'].includes(req.headers['sec-fetch-site'])){res.status(403).end();return;}
      if(req.headers.origin && req.headers.origin!==origin){res.status(403).end();return;}
      setSession(res,member);res.writeHead(302,{Location:'/new'}).end();return;
    }
    if(url.pathname.startsWith('/api/')){
      const handler={'/api/room':room,'/api/session':session}[url.pathname];
      if(!handler){res.status(503).json({error:'This feature is not connected in the local preview.'});return;}
      req.query=Object.fromEntries(url.searchParams);req.body=await readJson(req);await handler(req,res);return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.status(405).end();return;}
    let path=resolve(publicRoot,'.'+decodeURIComponent(url.pathname));
    if(!path.startsWith(publicRoot+'/'))path=join(publicRoot,'index.html');
    let file=await stat(path).catch(()=>null);if(!file?.isFile()){path=join(publicRoot,'index.html');file=await stat(path);}
    res.setHeader('Content-Type',mime[extname(path)]??'application/octet-stream');
    if(req.method==='HEAD'){res.end();return;}
    res.end(await readFile(path));
  }catch{if(!res.headersSent)res.status(400).json({error:'Local request failed'});else res.end();}
});
server.requestTimeout=15000;server.headersTimeout=10000;
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close();bridge.close();redis.kill('SIGTERM');await delay(150);await rm(runDir,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
redis.on('exit',()=>{if(!stopping)void stop();});
server.on('error',error=>{console.error(`Preview cannot listen: ${error.code??'error'}`);void stop();});
server.listen(port,'127.0.0.1',()=>console.log(`Agent Room local preview: ${origin}/local-preview\nLocal Host session; ephemeral Redis; cloud storage and AI connections disabled.`));
