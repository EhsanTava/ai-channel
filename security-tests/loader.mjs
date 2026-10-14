import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const aws = `export class S3Client { async send(command) { return globalThis.__s3(command); } destroy() {} }\n` +
 ['PutObjectCommand','GetObjectCommand','ListObjectsV2Command','DeleteObjectsCommand'].map(name => `export class ${name} { constructor(input) { this.input=input; this.kind='${name}'; } }`).join('\n');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@aws-sdk/client-s3') return { url: 'data:text/javascript,' + encodeURIComponent(aws), shortCircuit: true };
    if (specifier.startsWith('@agent-room/')) {
      const name = specifier.slice('@agent-room/'.length);
      if (!['shared', 'upstash-client'].includes(name)) throw new Error('Unreviewed workspace import');
      return { url: pathToFileURL(resolve(root, 'packages', name, 'src/index.ts')).href, shortCircuit: true };
    }
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      if (!fileURLToPath(url).startsWith(root)) throw new Error('Unreviewed TypeScript path');
      return { format: 'module', source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform', sourceUrl: url }), shortCircuit: true };
    }
    return next(url, context);
  },
});
