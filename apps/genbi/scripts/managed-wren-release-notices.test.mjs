import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLicenseEvidence, noticesDigest, verifyNotices } from './managed-wren-release-notices.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
function fixture() {
  const source = { url: 'https://example.invalid/source', sha256: 'a'.repeat(64) };
  const doc = { path: 'LICENSE', text: 'License fixture\n', sha256: hash('License fixture\n'), source };
  const candidate = { python: { mirror: { sha256: 'b'.repeat(64) }, version: '3.11.16' }, wheels: [{ distribution: 'example', version: '1', filename: 'example.whl', sha256: 'c'.repeat(64), sourceUrl: 'https://example.invalid/example.whl' }] };
  const pbs = { schema: 2, archiveSha256: candidate.python.mirror.sha256, pythonVersion: '3.11.16', matchingInstallEntries: 10, fullDistribution: source, sourceCommit: 'a'.repeat(40), documents: [structuredClone(doc)], retainedDocuments: [structuredClone(doc)], nativeComponents: ['tcl','tk','itcl','thread'].map(name => ({ name, version: '1', licenses: ['TCL'], source, documents: [structuredClone(doc)] })), installedNativeLibraries: ['python/lib/libtcl.dylib'], extensionLinks: { tcl: { links: [{ name: 'tcl', system: true }] } } };
  const wheels = { schema: 2, wheels: [{ ...candidate.wheels[0], documents: [structuredClone(doc)] }] };
  pbs.noticesSha256 = wheels.noticesSha256 = noticesDigest(pbs, wheels);
  return { candidate, pbs, wheels };
}
test('all notice bytes and their source bindings produce the approved companion', () => {
  const {candidate,pbs,wheels} = fixture();
  validateLicenseEvidence(candidate,pbs,wheels);
  const text = verifyNotices(candidate,pbs,wheels);
  assert.equal(hash(text), pbs.noticesSha256); assert.match(text, /License fixture/);
});
test('missing, stale, duplicate and tampered evidence rejects before publication', () => {
  const mutations = [
    f => { f.pbs.schema = 1; }, f => { f.pbs.archiveSha256 = 'd'.repeat(64); },
    f => { f.pbs.documents[0].text += 'changed'; }, f => { f.pbs.noticesSha256 = 'e'.repeat(64); },
    f => { f.pbs.nativeComponents.pop(); }, f => { f.pbs.nativeComponents[0].documents = []; },
    f => { f.wheels.wheels = []; }, f => { f.wheels.wheels.push(f.wheels.wheels[0]); },
    f => { f.wheels.wheels[0].sha256 = 'f'.repeat(64); }, f => { f.wheels.wheels[0].documents = []; },
    f => { f.pbs.extensionLinks.tcl.links = [{ name: 'unknown', path_static: 'build/lib/libunknown.a' }]; },
    f => { f.wheels.wheels[0].documents[0].path = '../escape'; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => verifyNotices(f.candidate,f.pbs,f.wheels)); }
});
test('any legitimate license-text update changes the approval-bound companion digest', () => {
  const f = fixture(); const before = noticesDigest(f.pbs,f.wheels);
  f.wheels.wheels[0].documents[0].text += 'new attribution';
  f.wheels.wheels[0].documents[0].sha256 = hash(f.wheels.wheels[0].documents[0].text);
  assert.notEqual(noticesDigest(f.pbs,f.wheels),before);
  assert.throws(() => verifyNotices(f.candidate,f.pbs,f.wheels), /digest differs/);
});
test('offline license-source collector contracts pass', () => {
  execFileSync('python3', [new URL('./managed-wren-release-licenses.test.py', import.meta.url).pathname], {stdio:'pipe'});
});

test('actual publish preparation includes notices and rejects missing evidence before fetching', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'license-publish-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const f = fixture();
  const source = 'https://example.invalid/python.tar.gz'; const mirror = 'https://github.com/goldmedal/WrenAI/releases/download/managed-wren-fixture/';
  f.candidate.activation = 'staged'; f.candidate.platform = 'darwin-arm64'; f.candidate.compatibility = {wren:'1'};
  f.candidate.python.upstream = {url:source,sha256:hash('python')};
  f.candidate.python.mirror = {url:mirror+'python.tar.gz',sha256:hash('python')};
  f.candidate.wheels[0] = {distribution:'wrenai',version:'1',filename:'wrenai.whl',sha256:hash('wheel'),sourceUrl:'https://example.invalid/wrenai.whl',url:mirror+'wrenai.whl'};
  f.pbs.archiveSha256 = hash('python'); f.wheels.wheels[0] = {...f.candidate.wheels[0],documents:f.wheels.wheels[0].documents};
  f.pbs.noticesSha256 = f.wheels.noticesSha256 = noticesDigest(f.pbs,f.wheels);
  const save=(name,obj)=>writeFileSync(path.join(root,name),JSON.stringify(obj));
  save('managed-wren-manifest.candidate.json',f.candidate); save('wheel-inputs.json',f.candidate.wheels);
  save('pbs-license-inventory.json',f.pbs); save('wheel-license-inventory.json',f.wheels);
  const hook=path.join(root,'fetch.mjs');
  writeFileSync(hook, `globalThis.fetch=async url=>{if(url==='${source}')return new Response('python');if(url==='https://example.invalid/wrenai.whl')return new Response('wheel');throw new Error('Unexpected network request');};`);
  const script=new URL('./managed-wren-release.mjs',import.meta.url).pathname;
  const assets=path.join(root,'assets');
  execFileSync(process.execPath,['--import',hook,script,'verify-publish',root,assets]);
  assert.equal(hash(readFileSync(path.join(assets,'THIRD_PARTY_NOTICES.txt'))),f.pbs.noticesSha256);
  assert.equal(JSON.parse(readFileSync(path.join(root,'managed-wren-manifest.json'))).activation,'approved');
  f.wheels.wheels[0].documents=[];save('wheel-license-inventory.json',f.wheels);
  const blocked=path.join(root,'blocked');
  const result=spawnSync(process.execPath,['--import',hook,script,'verify-publish',root,blocked],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/missing redistribution documents/);assert.equal(existsSync(blocked),false);
});
