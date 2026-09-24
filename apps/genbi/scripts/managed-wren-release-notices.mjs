/** Release-only license evidence validation. Never grants redistribution approval. */
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const exactHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function docs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('missing redistribution documents');
  for (const row of rows) {
    if (typeof row.path !== 'string' || row.path.startsWith('/') || row.path.split('/').includes('..') || typeof row.text !== 'string' || !row.text.trim() || !exactHash(row.sha256) || hash(Buffer.from(row.text)) !== row.sha256) throw new Error('invalid redistribution document');
    const source = row.source;
    if (!source || !(exactHash(source.sha256) && /^https:\/\//.test(source.url) || exactHash(source.archiveSha256) || exactHash(source.wheelSha256) && /^https:\/\//.test(source.url))) throw new Error('missing document provenance');
  }
}
export function validateLicenseEvidence(candidate, pbs, wheels) {
  if (pbs?.schema !== 2 || wheels?.schema !== 2 || pbs.archiveSha256 !== candidate.python.mirror.sha256 || pbs.pythonVersion !== candidate.python.version || !Number.isInteger(pbs.matchingInstallEntries) || pbs.matchingInstallEntries <= 0) throw new Error('license inventory does not bind exact Python artifact');
  if (!exactHash(pbs.fullDistribution?.sha256) || !/^https:\/\//.test(pbs.fullDistribution?.url) || !/^[a-f0-9]{40}$/.test(pbs.sourceCommit)) throw new Error('missing PBS source identity');
  docs(pbs.documents); docs(pbs.retainedDocuments);
  if (!Array.isArray(pbs.nativeComponents) || pbs.nativeComponents.length === 0 || !Array.isArray(pbs.installedNativeLibraries) || pbs.installedNativeLibraries.length === 0) throw new Error('missing bundled library inventory');
  const names = new Set(); const links = new Set();
  for (const row of pbs.nativeComponents) {
    if (!row.name || !row.version || names.has(row.name) || !Array.isArray(row.licenses) || !row.licenses.length || !exactHash(row.source?.sha256) || !/^https:\/\//.test(row.source?.url)) throw new Error('invalid bundled library identity');
    names.add(row.name); for (const link of row.linkedNames ?? []) links.add(link); docs(row.documents);
  }
  for (const name of ['tcl', 'tk', 'itcl', 'thread']) if (!names.has(name)) throw new Error('missing installed Tcl library evidence');
  if (!pbs.extensionLinks || !Object.keys(pbs.extensionLinks).length) throw new Error('missing extension dependency map');
  for (const row of Object.values(pbs.extensionLinks)) for (const link of row.links) if (link.path_static && !links.has(link.name)) throw new Error('unmapped static native library');
  if (!Array.isArray(wheels.wheels) || wheels.wheels.length !== candidate.wheels.length) throw new Error('license wheel closure differs');
  const inventory = new Map(wheels.wheels.map(w => [w.filename, w]));
  if (inventory.size !== candidate.wheels.length) throw new Error('duplicate license wheel');
  for (const selected of candidate.wheels) {
    const row = inventory.get(selected.filename);
    if (!row || ['distribution', 'version', 'sha256', 'sourceUrl'].some(key => row[key] !== selected[key])) throw new Error('license wheel identity differs');
    docs(row.documents);
    for (const doc of row.documents) if (doc.source.wheelSha256 && (doc.source.wheelSha256 !== selected.sha256 || doc.source.url !== selected.sourceUrl)) throw new Error('document bound to another wheel');
  }
}
export function renderNotices(pbs, wheels) {
  const sections = [
    ['CPython', pbs.pythonVersion, pbs.documents],
    ...pbs.nativeComponents.map(c => [c.name, c.version, c.documents]),
    ['Documents retained inside CPython archive', pbs.sourceRelease, pbs.retainedDocuments],
    ...wheels.wheels.map(c => [c.distribution, c.version, c.documents]),
  ];
  return 'Managed Wren redistribution notices\n\nOriginal runtime archives and wheels are mirrored without modification.\nThis companion preserves upstream license and attribution documents.\nComponent and exact-source mappings are in pbs-license-inventory.json and wheel-license-inventory.json.\n\n' + sections.map(([name, version, documents]) =>
    `=== ${name} ${version} ===\n\n` + documents.map(d => `--- ${d.path} ---\nSource: ${JSON.stringify(d.source)}\nDocument SHA-256: ${d.sha256}\n\n${d.text}\n`).join('\n')).join('\n');
}
export function noticesDigest(pbs, wheels) { return hash(renderNotices(pbs, wheels)); }
export function verifyNotices(candidate, pbs, wheels) {
  validateLicenseEvidence(candidate, pbs, wheels);
  const digest = noticesDigest(pbs, wheels);
  if (pbs.noticesSha256 !== digest || wheels.noticesSha256 !== digest) throw new Error('redistribution notices digest differs');
  return renderNotices(pbs, wheels);
}
