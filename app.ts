// github-core-clone-01: a standalone GitHub-compatible git forge.
// One Node 22 process, stdlib only, in-memory store. Serves:
//   - git smart HTTP (upload-pack v2 + v0 fallback, receive-pack v0) at /{owner}/{repo}.git
//   - REST v3 under /api/v3 (repos, branches, commits, contents, issues, labels, pulls)
//   - GraphQL v4 at /api/graphql (the documents gh / github-mcp-server send)
//   - MCP over streamable HTTP at /mcp (initialize + server/discover, tools/list, tools/call)
// Deterministic: no wall clock and no Math.random reach any response; a logical
// clock seeded from MAKEFUN_TRIAL_NOW (else 2025-01-01) advances one second per
// created object, so a live run and its replay produce identical state.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- utilities

export const VIEWER_LOGIN = 'adaiversen'; // scenario viewer (wire.ts SCENARIO_SEED); see README note
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';

const TRIAL_NOW = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 1735689600; // 2025-01-01T00:00:00Z
})();

let clockTick = 0;
function nowSec(): number { return TRIAL_NOW + (clockTick += 1); }
function iso(sec: number): string { return new Date(sec * 1000).toISOString().replace('.000Z', 'Z'); }
let reqCounter = 0;
function reqId(): string { reqCounter += 1; return reqCounter.toString(16).padStart(12, '0'); }
function sha1hex(data: Buffer): string { return createHash('sha1').update(data).digest('hex'); }
function b64url(text: string): string { return Buffer.from(text, 'utf8').toString('base64url'); }
function unb64url(text: string): string { try { return Buffer.from(text, 'base64url').toString('utf8'); } catch { return ''; } }
function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

type Json = Record<string, unknown>;
function isObj(v: unknown): v is Json { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function asStr(v: unknown, d = ''): string { return typeof v === 'string' ? v : d; }
function asNum(v: unknown, d = 0): number { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function asBool(v: unknown, d = false): boolean { return typeof v === 'boolean' ? v : d; }

// ---------------------------------------------------------------- git objects

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}
interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree');
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(l, r);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string; }
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8'));
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
function buildCommit(tree: string, parents: string[], message: string, ts: number, who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who} ${ts} +0000`, `committer ${who} ${ts} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = (blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8'));
  const m = new Map<string, string>();
  for (const line of head.split('\n')) { const sp = line.indexOf(' '); if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1)); }
  return { object: m.get('object') ?? '', type: m.get('type') ?? '', tag: m.get('tag') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

// --- packfile read/write (no deltas on write; deltas resolved on read) ---
function readVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]; const first = byte;
  let size = byte & 0x0f; let shift = 4; let off = start + 1;
  while (byte & 0x80) { byte = buffer[off++]; size += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { size, next: off, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => { let v = 0; let sh = 0; for (;;) { const b = delta[off++]; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let co = 0; let cs = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit++) { if (op & (1 << bit)) co += delta[off++] * 2 ** sh; sh += 8; }
      sh = 0;
      for (let bit = 4; bit < 7; bit++) { if (op & (1 << bit)) cs += delta[off++] * 2 ** sh; sh += 8; }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs); written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f; delta.copy(out, written, off, off + n); off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOffset?: number; baseOid?: string; resolved?: GitObj; oid?: string; }
  const raw: Raw[] = []; const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const hdr = readVarint(pack, off); off = hdr.next;
    const typeCode = (hdr.first >> 4) & 0x07;
    const e: Raw = { offset: entryOffset, typeCode, size: hdr.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[off]; let v = b & 0x7f; off += 1;
      while (b & 0x80) { b = pack[off++]; v = ((v + 1) * 128) + (b & 0x7f); }
      e.baseOffset = entryOffset - v;
    } else if (typeCode === 7) { e.baseOid = pack.subarray(off, off + 20).toString('hex'); off += 20; }
    else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type');
    const res = inflateSync(pack.subarray(off, trailerStart), { info: true } as never) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (res.buffer.length !== hdr.size) throw new Error('pack entry size mismatch');
    e.data = res.buffer; off += res.engine.bytesWritten;
    raw.push(e); byOffset.set(entryOffset, e);
  }
  const objects = new Map<string, GitObj>(); const resolvedByOid = new Map<string, Raw>(); const resolving = new Set<number>();
  const resolve = (e: Raw): GitObj & { oid: string } => {
    if (e.resolved && e.oid) return { ...e.resolved, oid: e.oid };
    if (resolving.has(e.offset)) throw new Error('delta cycle');
    resolving.add(e.offset);
    let type: ObjType; let data: Buffer;
    if (e.typeCode === 6) { const base = resolve(byOffset.get(e.baseOffset!)!); type = base.type; data = applyDelta(base.data, e.data); }
    else if (e.typeCode === 7) {
      const be = resolvedByOid.get(e.baseOid!);
      if (be) { const base = resolve(be); type = base.type; data = applyDelta(base.data, e.data); }
      else { const ext = resolveBase?.(e.baseOid!); if (!ext) throw new Error('delta base missing'); type = ext.type; data = applyDelta(ext.data, e.data); }
    } else { type = CODE_TYPE[e.typeCode]; data = e.data; }
    const oid = hashObject(type, data);
    e.resolved = { type, data }; e.oid = oid; resolvedByOid.set(oid, e); resolving.delete(e.offset);
    return { type, data, oid };
  };
  for (const e of raw) { const r = resolve(e); if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data }); }
  return objects;
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type]; const bytes: number[] = [];
  let rem = size; let first = (code << 4) | (rem & 0x0f); rem = Math.floor(rem / 16);
  while (rem > 0) { bytes.push(first | 0x80); first = rem & 0x7f; rem = Math.floor(rem / 128); }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) { parts.push(writePackObjectHeader(o.type, o.data.length)); parts.push(deflateSync(o.data)); }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --- pkt-line ---
function pkt(s: string | Buffer): Buffer {
  const body = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pkt(it));
  }
  return Buffer.concat(parts);
}
interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer; }
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = []; let off = 0;
  while (off + 4 <= buf.length) {
    const hdr = buf.subarray(off, off + 4).toString('ascii');
    if (hdr === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hdr === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (hdr === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(hdr, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function sidebandWrap(data: Buffer): Buffer {
  // wrap bytes into sideband band-1 pkt-lines (<= 60000 data bytes each)
  const parts: Buffer[] = [];
  for (let off = 0; off < data.length; off += 60000) {
    const chunk = data.subarray(off, Math.min(data.length, off + 60000));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- store

interface Label { id: number; name: string; color: string; description: string; }
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; createdSeq: number; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: Array<{ id: number; body: string; createdAt: string }>;
}
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string; mergeBase: string;
  merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; createdSeq: number; createdAt: string;
}
interface Repo {
  id: number; owner: string; name: string; description: string; private: boolean;
  defaultBranch: string; createdSeq: number; createdAt: string;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[];
  nextIssue: number; nextPull: number; nextComment: number; nextLabel: number;
}

const repos = new Map<string, Repo>();
let seqCounter = 0;
let repoIdCounter = 4999;
let globalIdCounter = 0;
function nextSeq(): number { seqCounter += 1; return seqCounter; }
function repoKey(owner: string, name: string): string { return `${owner}\0${name}`; }
function getRepo(owner: string, name: string): Repo | undefined { return repos.get(repoKey(owner, name)); }
function createRepo(owner: string, name: string, description: string, priv: boolean): Repo {
  const sec = nowSec();
  const r: Repo = {
    id: ++repoIdCounter, owner, name, description, private: priv, defaultBranch: 'main',
    createdSeq: nextSeq(), createdAt: iso(sec),
    objects: new Map(), refs: new Map(), labels: new Map(), issues: [], pulls: [],
    nextIssue: 1, nextPull: 1, nextComment: 1, nextLabel: 1,
  };
  repos.set(repoKey(owner, name), r);
  return r;
}
function gid(kind: string, key: string): string { return b64url(`${kind}:${key}`); }
function repoGid(r: Repo): string { return gid('Repository', `${r.owner}/${r.name}`); }
function issueGid(r: Repo, n: number): string { return gid('Issue', `${r.owner}/${r.name}:${n}`); }
function pullGid(r: Repo, n: number): string { return gid('PullRequest', `${r.owner}/${r.name}:${n}`); }
function commentGid(r: Repo, issueNum: number, cid: number): string { return gid('IssueComment', `${r.owner}/${r.name}:${issueNum}:${cid}`); }
function decodeGid(id: string): { kind: string; key: string } | null {
  const s = unb64url(id);
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { kind: s.slice(0, i), key: s.slice(i + 1) };
}
function viewerUser(): Json {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('User', VIEWER_LOGIN), avatar_url: '', type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}
function repoJson(r: Repo): Json {
  return {
    id: r.id, node_id: repoGid(r), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: viewerUserFor(r.owner), private: r.private, description: r.description,
    default_branch: r.defaultBranch, created_at: r.createdAt, updated_at: r.createdAt,
    pushed_at: r.createdAt, html_url: `/${r.owner}/${r.name}`, clone_url: `/${r.owner}/${r.name}.git`,
    url: `/api/v3/repos/${r.owner}/${r.name}`, has_issues: true, has_projects: true, has_wiki: true,
    forks_count: 0, stargazers_count: 0, watchers_count: 0, open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}
function viewerUserFor(owner: string): Json {
  if (owner === VIEWER_LOGIN) return viewerUser();
  return { login: owner, id: 2000 + (owner.length * 7) % 997, node_id: gid('User', owner), avatar_url: '', type: 'User', site_admin: false };
}
function labelJson(l: Label): Json { return { id: l.id, node_id: gid('Label', l.name), url: '', name: l.name, color: l.color, description: l.description, default: false }; }
function issueJson(r: Repo, i: Issue): Json {
  return {
    id: i.id, node_id: issueGid(r, i.number), number: i.number, title: i.title, body: i.body,
    state: i.state, locked: false, labels: i.labels.map(labelJson),
    user: viewerUser(), assignee: null, assignees: [], comments: i.comments.length,
    created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
    html_url: `/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
  };
}
function pullJson(r: Repo, p: Pull): Json {
  return {
    id: p.id, node_id: pullGid(r, p.number), number: p.number, title: p.title, body: p.body,
    state: p.state, locked: false, merged: p.merged, mergeable: computeMergeable(r, p) === 'MERGEABLE',
    merge_commit_sha: p.mergeCommitSha, merged_at: p.mergedAt,
    head: { ref: p.head, sha: refTip(r, `refs/heads/${p.head}`) ?? p.headSha, label: `${r.owner}:${p.head}`, user: viewerUserFor(r.owner), repo: repoJson(r) },
    base: { ref: p.base, sha: refTip(r, `refs/heads/${p.base}`) ?? p.baseSha, label: `${r.owner}:${p.base}`, user: viewerUserFor(r.owner), repo: repoJson(r) },
    user: viewerUser(), created_at: p.createdAt, updated_at: p.createdAt, closed_at: p.mergedAt,
    html_url: `/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function refTip(r: Repo, ref: string): string | undefined { return r.refs.get(ref); }
function defaultTip(r: Repo): string | undefined { return r.refs.get(`refs/heads/${r.defaultBranch}`); }

// --- git graph helpers ---
function commitOf(r: Repo, oid: string): CommitView | null {
  const o = r.objects.get(oid);
  if (!o || o.type !== 'commit') return null;
  return parseCommit(o.data);
}
function reachableCommits(r: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>(); const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !r.objects.has(oid)) continue;
    const o = r.objects.get(oid)!;
    if (o.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(o.data).parents) stack.push(p);
  }
  return seen;
}
function isAncestor(r: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  return reachableCommits(r, [desc]).has(anc);
}
function reachableObjects(r: Repo, tips: string[]): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const seen = new Set<string>(); const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const o = r.objects.get(oid);
    if (!o) continue;
    seen.add(oid); out.set(oid, o);
    if (o.type === 'commit') { const c = parseCommit(o.data); stack.push(c.tree); for (const p of c.parents) stack.push(p); }
    else if (o.type === 'tag') stack.push(parseTag(o.data).object);
    else if (o.type === 'tree') for (const e of parseTree(o.data)) { if (e.mode !== '160000') stack.push(e.oid); }
  }
  return out;
}
function commitDepthMap(r: Repo, tips: string[]): Map<string, number> {
  // generation (shortest distance in commits) from any tip
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = tips.map((t) => [t, 0] as [string, number]);
  while (queue.length) {
    const [oid, d] = queue.shift()!;
    if (depth.has(oid)) continue;
    const c = commitOf(r, oid); if (!c) continue;
    depth.set(oid, d);
    for (const p of c.parents) queue.push([p, d + 1]);
  }
  return depth;
}
function flattenTree(r: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const o = r.objects.get(oid); if (!o || o.type !== 'tree') return;
    for (const e of parseTree(o.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}
function buildTreeFromFiles(r: Repo, baseTreeOid: string | null, changes: Array<{ path: string; oid: string | null; mode?: string }>): string {
  // changes: oid null = delete. Returns new root tree oid, storing intermediate trees.
  const getTree = (oid: string | null): TreeEntry[] => {
    if (!oid) return [];
    const o = r.objects.get(oid); if (!o || o.type !== 'tree') return [];
    return parseTree(o.data);
  };
  const putTree = (entries: TreeEntry[]): string => {
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    r.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const apply = (treeOid: string | null, parts: string[], change: { path: string; oid: string | null; mode?: string }): string => {
    const entries = getTree(treeOid);
    const [head, ...rest] = parts;
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (change.oid === null) { if (idx >= 0) entries.splice(idx, 1); }
      else {
        const ent: TreeEntry = { mode: change.mode ?? '100644', name: head, oid: change.oid };
        if (idx >= 0) entries[idx] = ent; else entries.push(ent);
      }
      return putTree(entries);
    }
    let childOid: string | null = null;
    if (idx >= 0 && entries[idx].mode === '40000') childOid = entries[idx].oid;
    const newChild = apply(childOid, rest, change);
    const ent: TreeEntry = { mode: '40000', name: head, oid: newChild };
    if (idx >= 0) entries[idx] = ent; else entries.push(ent);
    return putTree(entries);
  };
  let root = baseTreeOid;
  for (const c of changes) root = apply(root, c.path.split('/'), c);
  if (!root) { const empty = buildTree([]); const oid = hashObject('tree', empty); r.objects.set(oid, { type: 'tree', data: empty }); return oid; }
  return root;
}
function commitFileOnBranch(r: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
  const blobSha = hashObject('blob', content);
  r.objects.set(blobSha, { type: 'blob', data: content });
  const ref = `refs/heads/${branch}`;
  const tip = r.refs.get(ref);
  const baseTree = tip ? commitOf(r, tip)?.tree ?? null : null;
  const treeOid = buildTreeFromFiles(r, baseTree, [{ path, oid: blobSha }]);
  const ts = nowSec();
  const commitData = buildCommit(treeOid, tip ? [tip] : [], message.endsWith('\n') ? message : `${message}\n`, ts);
  const commitSha = hashObject('commit', commitData);
  r.objects.set(commitSha, { type: 'commit', data: commitData });
  r.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}
function diffTrees(r: Repo, baseTreeOid: string | null, headTreeOid: string | null): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; oldContent: Buffer | null; newContent: Buffer | null }> {
  const base = baseTreeOid ? flattenTree(r, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(r, headTreeOid) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; oldContent: Buffer | null; newContent: Buffer | null }> = [];
  const lines = (b: Buffer | null): string[] => (b ? b.toString('utf8').split('\n') : []);
  const lcsLen = (a: string[], b: string[]): number => {
    const dp = new Array(b.length + 1).fill(0);
    for (let i = 0; i < a.length; i++) { let prev = 0; for (let j = 0; j < b.length; j++) { const t = dp[j + 1]; if (a[i] === b[j]) dp[j + 1] = prev + 1; else dp[j + 1] = Math.max(dp[j + 1], dp[j]); prev = t; } }
    return dp[b.length];
  };
  for (const p of [...paths].sort()) {
    const b = base.get(p); const h = head.get(p);
    if (b && !h) { const old = r.objects.get(b.oid)?.data ?? null; out.push({ filename: p, status: 'removed', additions: 0, deletions: lines(old).length, oldContent: old, newContent: null }); }
    else if (!b && h) { const nw = r.objects.get(h.oid)?.data ?? null; const ls = lines(nw); out.push({ filename: p, status: 'added', additions: ls.filter((x) => x !== '').length || (nw && nw.length ? 1 : 0), deletions: 0, oldContent: null, newContent: nw }); }
    else if (b && h && b.oid !== h.oid) {
      const old = r.objects.get(b.oid)?.data ?? null; const nw = r.objects.get(h.oid)?.data ?? null;
      const la = lines(old); const lb = lines(nw); const common = lcsLen(la, lb);
      out.push({ filename: p, status: 'modified', additions: Math.max(1, lb.length - common), deletions: Math.max(0, la.length - common), oldContent: old, newContent: nw });
    }
  }
  return out;
}
function computeMergeable(r: Repo, p: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (p.state !== 'open') return 'UNKNOWN';
  const baseTip = refTip(r, `refs/heads/${p.base}`);
  const headTip = refTip(r, `refs/heads/${p.head}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const baseCommit = commitOf(r, p.mergeBase); const headCommit = commitOf(r, headTip); const tipCommit = commitOf(r, baseTip);
  if (!baseCommit || !headCommit || !tipCommit) return 'UNKNOWN';
  const baseFiles = flattenTree(r, baseCommit.tree);
  const headFiles = flattenTree(r, headCommit.tree);
  const tipFiles = flattenTree(r, tipCommit.tree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...tipFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const t = tipFiles.get(path)?.oid ?? null;
    const headChanged = h !== b; const tipChanged = t !== b;
    if (headChanged && tipChanged && h !== t) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
function doSquashMerge(r: Repo, p: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (computeMergeable(r, p) !== 'MERGEABLE') return { ok: false, reason: 'merge conflict' };
  const baseTip = refTip(r, `refs/heads/${p.base}`)!;
  const headTip = refTip(r, `refs/heads/${p.head}`)!;
  const baseCommit = commitOf(r, p.mergeBase)!; const headCommit = commitOf(r, headTip)!; const tipCommit = commitOf(r, baseTip)!;
  const baseFiles = flattenTree(r, baseCommit.tree);
  const headFiles = flattenTree(r, headCommit.tree);
  const tipFiles = flattenTree(r, tipCommit.tree);
  const changes: Array<{ path: string; oid: string | null }> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    if (h !== b) changes.push({ path, oid: h });
  }
  void tipFiles;
  const treeOid = buildTreeFromFiles(r, tipCommit.tree, changes);
  const ts = nowSec();
  const msg = `${p.title} (#${p.number})\n`;
  const data = buildCommit(treeOid, [baseTip], msg, ts);
  const sha = hashObject('commit', data);
  r.objects.set(sha, { type: 'commit', data });
  r.refs.set(`refs/heads/${p.base}`, sha);
  p.state = 'closed'; p.merged = true; p.mergeCommitSha = sha; p.mergedAt = iso(ts);
  return { ok: true, sha };
}
function createIssueIn(r: Repo, title: string, body: string, labelNames: string[]): { issue?: Issue; error?: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const l = r.labels.get(name);
    if (!l) return { error: `Label '${name}' does not exist` };
    labels.push(l);
  }
  const sec = nowSec();
  const issue: Issue = {
    id: 10000 + nextSeq(), number: r.nextIssue++, title, body, state: 'open', labels,
    createdSeq: nextSeq(), createdAt: iso(sec), updatedAt: iso(sec), closedAt: null, comments: [],
  };
  r.issues.push(issue);
  return { issue };
}
function createPullIn(r: Repo, title: string, body: string, head: string, base: string): { pull?: Pull; error?: string } {
  const headTip = refTip(r, `refs/heads/${head}`);
  const baseTip = refTip(r, `refs/heads/${base}`);
  if (!headTip) return { error: `Head branch '${head}' does not exist` };
  if (!baseTip) return { error: `Base branch '${base}' does not exist` };
  if (head === base) return { error: 'Head and base are the same' };
  const existing = r.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
  if (existing) return { error: 'A pull request already exists for this head branch' };
  const sec = nowSec();
  const pull: Pull = {
    id: 20000 + nextSeq(), number: r.nextPull++, title, body, state: 'open',
    head, base, headSha: headTip, baseSha: baseTip, mergeBase: baseTip,
    merged: false, mergeCommitSha: null, mergedAt: null, createdSeq: nextSeq(), createdAt: iso(sec),
  };
  r.pulls.push(pull);
  return { pull };
}

// ---------------------------------------------------------------- HTTP plumbing

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function authed(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7);
  if (tok.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(tok), Buffer.from(TOKEN));
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': reqId(), ...extra };
  if (body !== null) { headers['content-type'] = 'application/json; charset=utf-8'; headers['content-length'] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': reqId(), ...extra });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void { sendJson(res, status, { message }); }
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
}
function urlOf(req: IncomingMessage): URL {
  try { return new URL(req.url ?? '/', 'http://entry'); } catch { return new URL('/', 'http://entry'); }
}
function hostOf(req: IncomingMessage): string {
  const h = req.headers.host ?? '127.0.0.1';
  return `http://${h}`;
}

// ---------------------------------------------------------------- git smart HTTP

function sortedRefs(r: Repo): Array<{ name: string; oid: string }> {
  return [...r.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peeledOid(r: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 16; i++) {
    const o = r.objects.get(cur);
    if (!o) return null;
    if (o.type !== 'tag') return i === 0 ? null : cur;
    cur = parseTag(o.data).object;
  }
  return cur;
}
function v2Capabilities(): string[] {
  return ['agent=github-core-clone/1.0.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done filter', 'object-format=sha1'];
}
function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string, service: string): void {
  const r = getRepo(owner, name);
  if (!r) { errJson(res, 404, 'Not Found'); return; }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const refs = sortedRefs(r);
  if (service === 'git-receive-pack') {
    const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0.0';
    const items: Array<string | Buffer | 'flush'> = [`# service=git-receive-pack\n`, 'flush'];
    if (refs.length === 0) items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    else {
      refs.forEach((ref, i) => {
        items.push(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
        const peeled = peeledOid(r, ref.oid);
        if (peeled && ref.name.startsWith('refs/tags/')) items.push(`${peeled} ${ref.name}^{}\n`);
      });
    }
    items.push('flush');
    sendRaw(res, 200, pktLines(items), 'application/x-git-receive-pack-advertisement');
    return;
  }
  if (isV2) {
    const items: Array<string | Buffer | 'flush'> = [`# service=git-upload-pack\n`, 'flush', 'version 2\n'];
    for (const c of v2Capabilities()) items.push(`${c}\n`);
    items.push('flush');
    sendRaw(res, 200, pktLines(items), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = 'symref=HEAD:refs/heads/main multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=github-core-clone/1.0.0';
  const items: Array<string | Buffer | 'flush'> = [`# service=git-upload-pack\n`, 'flush'];
  if (refs.length === 0) items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  else {
    const headTip = defaultTip(r);
    items.push(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const ref of refs) {
      items.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peeledOid(r, ref.oid);
      if (peeled && ref.name.startsWith('refs/tags/')) items.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  items.push('flush');
  sendRaw(res, 200, pktLines(items), 'application/x-git-upload-pack-advertisement');
}
function handleLsRefs(r: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const headTip = defaultTip(r);
  if (symrefs && keep('HEAD')) lines.push(`${headTip ?? ZERO_OID} HEAD symref-target:refs/heads/main\n`);
  for (const ref of sortedRefs(r)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) { const peeled = peeledOid(r, ref.oid); if (peeled) line += ` peeled:${peeled}`; }
    lines.push(`${line}\n`);
  }
  if (lines.length === 0 && prefixes.length === 0) {
    // empty repo: HEAD only, already added above when symrefs; if symrefs not requested, still advertise HEAD
    if (!symrefs) lines.push(`${ZERO_OID} HEAD symref-target:refs/heads/main\n`);
  }
  return pktLines([...lines, 'flush']);
}
interface FetchReq { wants: string[]; haves: string[]; shallow: string[]; depth: number | null; }
/** Objects the client already holds via its haves. Traversal stops at commits the
 * client lists as shallow: it holds their own tree/blobs, but not their parents. */
function heldObjects(r: Repo, haves: string[], shallowSet: Set<string>): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const seen = new Set<string>(); const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const o = r.objects.get(oid);
    if (!o) continue;
    seen.add(oid); out.set(oid, o);
    if (o.type === 'commit') {
      const c = parseCommit(o.data);
      const walkTree = (treeOid: string): void => {
        const t = r.objects.get(treeOid); if (!t || t.type !== 'tree') return;
        if (!out.has(treeOid)) out.set(treeOid, t);
        for (const e of parseTree(t.data)) {
          if (e.mode === '40000') walkTree(e.oid);
          else { const b = r.objects.get(e.oid); if (b && !out.has(e.oid)) out.set(e.oid, b); }
        }
      };
      walkTree(c.tree);
      if (!shallowSet.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (o.type === 'tag') stack.push(parseTag(o.data).object);
    else if (o.type === 'tree') for (const e of parseTree(o.data)) { if (e.mode !== '160000') stack.push(e.oid); }
  }
  return out;
}

function computeFetch(r: Repo, req: FetchReq): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const haveSet = new Set(req.haves);
  const shallowSet = new Set(req.shallow);
  // A want may name a tag object: the tag itself must be sent, and its peeled
  // commit is the tip for depth purposes.
  const tagWants: string[] = [];
  const commitWants: string[] = [];
  for (const w of req.wants) {
    const o = r.objects.get(w);
    if (o?.type === 'tag') { tagWants.push(w); const peeled = peeledOid(r, w); if (peeled) commitWants.push(peeled); }
    else commitWants.push(w);
  }
  const depthMap = commitDepthMap(r, commitWants);
  const included = new Set<string>();
  const boundary = new Set<string>();
  if (req.depth !== null) {
    for (const [oid, d] of depthMap) {
      if (haveSet.has(oid)) continue;
      if (d < req.depth) included.add(oid);
    }
    // boundary = included commits whose parent is not included (and not a have)
    for (const oid of included) {
      const c = commitOf(r, oid)!;
      const hasIncludedParent = c.parents.some((p) => included.has(p));
      if (!hasIncludedParent && (c.parents.length > 0 || req.depth === 1)) boundary.add(oid);
    }
  } else {
    const haveReachable = new Set<string>();
    for (const h of req.haves) for (const o of reachableCommits(r, [h])) haveReachable.add(o);
    for (const oid of depthMap.keys()) if (!haveReachable.has(oid)) included.add(oid);
  }
  const unshallow: string[] = [];
  for (const s of req.shallow) {
    if (included.has(s) && !boundary.has(s)) { unshallow.push(s); continue; }
    // a shallow boundary whose parent is now included is no longer shallow
    const c = commitOf(r, s);
    if (c && c.parents.some((p) => included.has(p))) unshallow.push(s);
  }
  const send = new Map<string, GitObj>();
  const collectFrom = (commitOid: string): void => {
    const c = commitOf(r, commitOid); if (!c) return;
    const addObj = (oid: string): void => { const o = r.objects.get(oid); if (o && !send.has(oid)) send.set(oid, o); };
    addObj(commitOid);
    const walkTree = (treeOid: string): void => {
      const o = r.objects.get(treeOid); if (!o || o.type !== 'tree') return;
      addObj(treeOid);
      for (const e of parseTree(o.data)) { if (e.mode === '40000') walkTree(e.oid); else addObj(e.oid); }
    };
    walkTree(c.tree);
  };
  for (const oid of included) collectFrom(oid);
  for (const t of tagWants) { const o = r.objects.get(t); if (o) send.set(t, o); }
  // remove objects the client already holds (reachable from haves, stopping
  // at shallow boundaries so a deepen still delivers the parent generation)
  const heldObjs = heldObjects(r, req.haves, shallowSet);
  for (const k of heldObjs.keys()) send.delete(k);
  // deterministic order: commits by depth asc, then trees, then blobs, then tags
  const ordered = [...send.entries()].sort((a, b) => {
    const rank = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
    const ra = rank(a[1].type); const rb = rank(b[1].type);
    if (ra !== rb) return ra - rb;
    return a[0] < b[0] ? -1 : 1;
  }).map(([, v]) => v);
  return { objects: ordered, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}
function handleUploadPackV2(r: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).trim() ?? '';
  if (command === 'ls-refs') {
    const args = lines.filter((l) => !l.startsWith('command=') && !l.startsWith('agent=') && !l.startsWith('object-format=')).map((l) => l.replace(/\n$/, ''));
    return handleLsRefs(r, args);
  }
  if (command === 'fetch') {
    const req: FetchReq = { wants: [], haves: [], shallow: [], depth: null };
    for (const raw of lines) {
      const l = raw.replace(/\n$/, '');
      if (l.startsWith('want ')) req.wants.push(l.slice(5).trim());
      else if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
      else if (l.startsWith('shallow ')) req.shallow.push(l.slice(8).trim());
      else if (l.startsWith('deepen ')) req.depth = parseInt(l.slice(7), 10);
      else if (l.startsWith('deepen-since ')) req.depth = req.depth ?? 1;
    }
    const { objects, shallow, unshallow } = computeFetch(r, req);
    const pack = writePack(objects);
    const parts: Buffer[] = [];
    // Per protocol v2 (and real git behaviour): the acknowledgments section is
    // only sent when the client sent at least one 'have' line (negotiation).
    // With no haves the response starts at shallow-info / packfile.
    if (req.haves.length > 0) parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), PKT_DELIM);
    if (shallow.length || unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(sidebandWrap(pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  return pktLines(['flush']);
}
function handleUploadPackV0(r: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const req: FetchReq = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of lines) {
    const l = raw.replace(/\n$/, '');
    if (l.startsWith('want ')) req.wants.push(l.slice(5).split(' ')[0]);
    else if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) req.shallow.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) req.depth = parseInt(l.slice(7), 10);
  }
  const { objects, shallow, unshallow } = computeFetch(r, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sidebandWrap(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function handleReceivePack(r: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const flushIdx = packets.findIndex((p) => p.kind === 'flush');
  const cmdPackets = (flushIdx < 0 ? packets : packets.slice(0, flushIdx)).filter((p) => p.kind === 'data');
  const packBytes = flushIdx < 0 ? Buffer.alloc(0) : body.subarray(pktBytesConsumed(body, flushIdx));
  let unpackOk = true;
  const newObjects = new Map<string, GitObj>();
  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes, (oid) => r.objects.get(oid) ?? newObjects.get(oid));
      for (const [k, v] of objs) newObjects.set(k, v);
    } catch { unpackOk = false; }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const p of cmdPackets) {
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts;
    const current = r.refs.get(ref);
    let ok = false; let reason = '';
    if (!unpackOk) { reason = 'unpack failed'; }
    else if (newOid === ZERO_OID) {
      if (!current) { reason = 'ref does not exist'; }
      else if (oldOid !== ZERO_OID && oldOid !== current) { reason = 'non-fast-forward'; }
      else { r.refs.delete(ref); ok = true; }
    } else if (oldOid === ZERO_OID) {
      if (current) { reason = 'already exists'; }
      else if (!r.objects.has(newOid) && !newObjects.has(newOid)) { reason = 'missing object'; }
      else { r.refs.set(ref, newOid); ok = true; }
    } else {
      if (current !== oldOid) { reason = 'non-fast-forward'; }
      else if (!r.objects.has(newOid) && !newObjects.has(newOid)) { reason = 'missing object'; }
      else {
        // fast-forward check for branch updates (tags: allow any move only if ancestor)
        const combined = new Map(r.objects); for (const [k, v] of newObjects) combined.set(k, v);
        const probe: Repo = { ...r, objects: combined };
        if (ref.startsWith('refs/heads/') && !isAncestor(probe, oldOid, newOid)) { reason = 'non-fast-forward'; }
        else { r.refs.set(ref, newOid); ok = true; }
      }
    }
    results.push({ ref, ok, reason });
  }
  if (unpackOk) for (const [k, v] of newObjects) r.objects.set(k, v);
  const inner: Array<string | 'flush'> = [unpackOk ? 'unpack ok\n' : 'unpack failed\n'];
  for (const res of results) inner.push(res.ok ? `ok ${res.ref}\n` : `ng ${res.ref} ${res.reason}\n`);
  inner.push('flush');
  const innerBuf = pktLines(inner);
  const outer = Buffer.concat([sidebandWrap(innerBuf), PKT_FLUSH]);
  return outer;
}
function pktBytesConsumed(body: Buffer, flushIndex: number): number {
  // byte offset just past the flushIdx-th packet in body
  let off = 0; let idx = 0;
  while (off + 4 <= body.length) {
    const hdr = body.subarray(off, off + 4).toString('ascii');
    if (hdr === '0000' || hdr === '0001' || hdr === '0002') { if (idx === flushIndex) return off + 4; off += 4; idx++; continue; }
    const len = parseInt(hdr, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) return body.length;
    off += len; idx++;
  }
  return body.length;
}

// ---------------------------------------------------------------- REST v3

function repoFromParts(res: ServerResponse, owner: string, name: string): Repo | null {
  const r = getRepo(owner, name);
  if (!r) { errJson(res, 404, 'Not Found'); return null; }
  return r;
}
function paginate<T>(items: T[], url: URL, req: IncomingMessage): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, asNum(Number(url.searchParams.get('per_page') ?? '30'), 30) || 30));
  const page = Math.max(1, asNum(Number(url.searchParams.get('page') ?? '1'), 1) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(`${hostOf(req)}${url.pathname}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}
function linkHeader(link: string | null): Record<string, string> { return link ? { link } : {}; }

async function handleRest(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  const url = urlOf(req);
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const segs = path.split('/').filter((s) => s !== '');
  // segs[0]='api', segs[1]='v3', rest follows
  const rest = segs.slice(2);
  const jsonBody = (): { ok: true; value: unknown } | { ok: false } => {
    if (method === 'GET' || method === 'DELETE' || method === 'HEAD') return { ok: true, value: {} };
    if (body.length === 0) return { ok: true, value: {} };
    return parseJsonBody(body);
  };
  // API root
  if (rest.length === 0) {
    if (method !== 'GET') { errJson(res, 404, 'Not Found'); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', current_user_authorizations_html_url: '', authorizations_url: '', code_search_url: '', commit_search_url: '', emails_url: '/api/v3/user/emails', emojis_url: '/api/v3/emojis', events_url: '/api/v3/events', feeds_url: '/api/v3/feeds', followers_url: '/api/v3/user/followers', following_url: '/api/v3/user/following', gists_url: '/api/v3/gists', hub_url: '', issue_search_url: '', issues_url: '/api/v3/issues', keys_url: '/api/v3/user/keys', label_search_url: '', notifications_url: '/api/v3/notifications', organization_url: '', public_gists_url: '', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}', repository_search_url: '', current_user_repositories_url: '/api/v3/user/repos', user_url: '/api/v3/users/{user}', user_organizations_url: '', user_repositories_url: '/api/v3/users/{user}/repos', user_search_url: '' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, ssh_key_fingerprints: {}, hook_id: 0, git_ip_addresses: [], installed_version: '1.0.0', api: { version: 'v3' } });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') { sendJson(res, 200, viewerUser()); return; }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(all.map(repoJson), url, req);
      sendJson(res, 200, page, linkHeader(link));
      return;
    }
    if (method === 'POST') {
      const parsed = jsonBody();
      if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
      const v = isObj(parsed.value) ? parsed.value : {};
      const name = asStr(v.name);
      if (!name) { errJson(res, 422, 'Validation Failed: name is required'); return; }
      if (getRepo(VIEWER_LOGIN, name)) { errJson(res, 422, 'Repository already exists'); return; }
      const r = createRepo(VIEWER_LOGIN, name, asStr(v.description), asBool(v.private, false));
      sendJson(res, 201, repoJson(r));
      return;
    }
  }
  if (rest.length >= 2 && rest[0] === 'users' && method === 'GET') {
    const login = decodeURIComponent(rest[1]);
    sendJson(res, 200, login === VIEWER_LOGIN ? viewerUser() : viewerUserFor(login));
    return;
  }
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = decodeURIComponent(rest[1]);
    const name = decodeURIComponent(rest[2]);
    const tail = rest.slice(3);
    // /repos/{o}/{r}
    if (tail.length === 0) {
      const r = repoFromParts(res, owner, name); if (!r) return;
      if (method === 'GET') { sendJson(res, 200, repoJson(r)); return; }
      if (method === 'PATCH') {
        const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const v = isObj(parsed.value) ? parsed.value : {};
        if (typeof v.description === 'string') r.description = v.description;
        if (typeof v.private === 'boolean') r.private = v.private;
        sendJson(res, 200, repoJson(r)); return;
      }
      if (method === 'DELETE') { repos.delete(repoKey(owner, name)); sendJson(res, 204, null); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    const r = repoFromParts(res, owner, name); if (!r) return;
    const sub = tail[0];
    // branches
    if (sub === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...r.refs.entries()].filter(([n]) => n.startsWith('refs/heads/')).map(([n, oid]) => ({ name: n.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }));
        sendJson(res, 200, list); return;
      }
      if (tail.length === 2 && method === 'GET') {
        const oid = r.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
        if (!oid) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { name: decodeURIComponent(tail[1]), commit: { sha: oid, url: '' }, protected: false }); return;
      }
    }
    // commits
    if (sub === 'commits') {
      if (tail.length === 2 && method === 'GET') {
        const oid = r.objects.get(decodeURIComponent(tail[1])) ? decodeURIComponent(tail[1]) : r.refs.get(`refs/heads/${decodeURIComponent(tail[1])}`);
        const c = oid ? commitOf(r, oid) : null;
        if (!c || !oid) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, commitJson(r, oid, c)); return;
      }
      if (tail.length === 1 && method === 'GET') {
        const shaParam = url.searchParams.get('sha');
        let tip: string | undefined;
        if (shaParam) tip = r.refs.get(`refs/heads/${shaParam}`) ?? (r.objects.has(shaParam) ? shaParam : undefined);
        else tip = defaultTip(r);
        if (!tip) { sendJson(res, 200, []); return; }
        const commits = listCommits(r, tip);
        const { page, link } = paginate(commits, url, req);
        sendJson(res, 200, page, linkHeader(link)); return;
      }
    }
    // git refs
    if (sub === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const v = isObj(parsed.value) ? parsed.value : {};
        const ref = asStr(v.ref); const sha = asStr(v.sha);
        if (!ref.startsWith('refs/') || !r.objects.has(sha)) { errJson(res, 422, 'Validation Failed'); return; }
        if (r.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return; }
        r.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: gid('Ref', `${r.owner}/${r.name}:${ref}`), url: '', object: { sha, type: r.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = decodeURIComponent(tail.slice(2).join('/'));
        const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const oid = r.refs.get(full);
        if (!oid) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref: full, node_id: gid('Ref', `${r.owner}/${r.name}:${full}`), url: '', object: { sha: oid, type: r.objects.get(oid)?.type ?? 'commit', url: '' } });
        return;
      }
      if (method === 'DELETE' && tail.length >= 3) {
        const ref = decodeURIComponent(tail.slice(2).join('/'));
        const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        if (!r.refs.has(full)) { errJson(res, 404, 'Not Found'); return; }
        r.refs.delete(full); sendJson(res, 204, null); return;
      }
    }
    // contents
    if (sub === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      if (method === 'GET') return handleContentsGet(req, res, r, filePath, url);
      if (method === 'PUT') return handleContentsPut(req, res, r, filePath, body);
      if (method === 'DELETE') return handleContentsDelete(req, res, r, filePath, body);
    }
    // labels
    if (sub === 'labels') {
      if (method === 'GET') { sendJson(res, 200, [...r.labels.values()].map(labelJson)); return; }
      if (method === 'POST') {
        const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const v = isObj(parsed.value) ? parsed.value : {};
        const labelName = asStr(v.name);
        if (!labelName) { errJson(res, 422, 'Validation Failed'); return; }
        const existing = r.labels.get(labelName);
        if (existing) { sendJson(res, 200, labelJson(existing)); return; }
        const label: Label = { id: r.nextLabel++, name: labelName, color: asStr(v.color, 'ededed'), description: asStr(v.description) };
        r.labels.set(labelName, label);
        sendJson(res, 201, labelJson(label)); return;
      }
    }
    // issues
    if (sub === 'issues') {
      if (tail.length === 1 && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const sort = url.searchParams.get('sort') ?? 'created';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let list = r.issues.filter((i) => state === 'all' ? true : i.state === state);
        list = [...list].sort((a, b) => (sort === 'created' ? (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq) : 0));
        const { page, link } = paginate(list.map((i) => issueJson(r, i)), url, req);
        sendJson(res, 200, page, linkHeader(link)); return;
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const v = isObj(parsed.value) ? parsed.value : {};
        const title = asStr(v.title);
        if (!title) { errJson(res, 422, 'Validation Failed: title is required'); return; }
        const labelNames = Array.isArray(v.labels) ? v.labels.map((x) => (typeof x === 'string' ? x : asStr((x as Json).name))).filter(Boolean) : [];
        const created = createIssueIn(r, title, asStr(v.body), labelNames);
        if (created.error) { errJson(res, 422, created.error); return; }
        sendJson(res, 201, issueJson(r, created.issue!)); return;
      }
      const num = Number(tail[1]);
      const issue = r.issues.find((i) => i.number === num);
      if (tail.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(r, issue)); return; }
        if (method === 'PATCH') {
          const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const v = isObj(parsed.value) ? parsed.value : {};
          if (typeof v.title === 'string') issue.title = v.title;
          if (typeof v.body === 'string') issue.body = v.body;
          if (v.state === 'closed' || v.state === 'open') { issue.state = v.state; issue.closedAt = v.state === 'closed' ? iso(nowSec()) : null; }
          if (Array.isArray(v.labels)) {
            const names = v.labels.map((x) => (typeof x === 'string' ? x : asStr((x as Json).name))).filter(Boolean);
            const ls: Label[] = [];
            for (const n of names) { const l = r.labels.get(n); if (!l) { errJson(res, 422, `Label '${n}' does not exist`); return; } ls.push(l); }
            issue.labels = ls;
          }
          issue.updatedAt = iso(nowSec());
          sendJson(res, 200, issueJson(r, issue)); return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: commentGid(r, issue.number, c.id), body: c.body, user: viewerUser(), created_at: c.createdAt, updated_at: c.createdAt, html_url: '' })));
          return;
        }
        if (method === 'POST') {
          const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
          const v = isObj(parsed.value) ? parsed.value : {};
          const cbody = asStr(v.body);
          if (!cbody) { errJson(res, 422, 'Validation Failed'); return; }
          const c = { id: r.nextComment++, body: cbody, createdAt: iso(nowSec()) };
          issue.comments.push(c);
          sendJson(res, 201, { id: c.id, node_id: commentGid(r, issue.number, c.id), body: c.body, user: viewerUser(), created_at: c.createdAt, updated_at: c.createdAt, html_url: '' });
          return;
        }
      }
    }
    // pulls
    if (sub === 'pulls') {
      if (tail.length === 1 && method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const list = r.pulls.filter((p) => state === 'all' ? true : p.state === state);
        const { page, link } = paginate(list.map((p) => pullJson(r, p)), url, req);
        sendJson(res, 200, page, linkHeader(link)); return;
      }
      if (tail.length === 1 && method === 'POST') {
        const parsed = jsonBody(); if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
        const v = isObj(parsed.value) ? parsed.value : {};
        const created = createPullIn(r, asStr(v.title), asStr(v.body), asStr(v.head), asStr(v.base));
        if (created.error) { errJson(res, 422, created.error); return; }
        sendJson(res, 201, pullJson(r, created.pull!)); return;
      }
      const num = Number(tail[1]);
      const pull = r.pulls.find((p) => p.number === num);
      if (tail.length === 2) {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, pullJson(r, pull)); return; }
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const headTip = refTip(r, `refs/heads/${pull.head}`);
        const baseCommit = commitOf(r, pull.mergeBase);
        const headCommit = headTip ? commitOf(r, headTip) : null;
        const diffs = diffTrees(r, baseCommit?.tree ?? null, headCommit?.tree ?? null);
        sendJson(res, 200, diffs.map((d) => ({ sha: '', filename: d.filename, status: d.status, additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions, blob_url: '', raw_url: '', contents_url: '', patch: '' })));
        return;
      }
      if (tail.length === 3 && tail[2] === 'commits' && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const headTip = refTip(r, `refs/heads/${pull.head}`);
        if (!headTip) { sendJson(res, 200, []); return; }
        const baseSet = reachableCommits(r, [pull.mergeBase]);
        const list = listCommits(r, headTip).filter((c) => !baseSet.has(String(c.sha)));
        sendJson(res, 200, list); return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        if (pull.state !== 'open') { errJson(res, 405, 'Pull request is already merged or closed'); return; }
        const merged = doSquashMerge(r, pull);
        if (!merged.ok) { errJson(res, 405, merged.reason ?? 'Merge conflict'); return; }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
    }
  }
  errJson(res, 404, 'Not Found');
}
function commitJson(r: Repo, sha: string, c: CommitView): Json {
  const authorLine = c.author;
  const m = /^(.*) <(.*)> (\d+) ([+-]\d+)$/.exec(authorLine);
  const name = m ? m[1] : VIEWER_NAME; const email = m ? m[2] : VIEWER_EMAIL;
  const date = m ? iso(Number(m[3])) : r.createdAt;
  return {
    sha, node_id: gid('Commit', `${r.owner}/${r.name}:${sha}`), url: '',
    commit: { message: c.message.replace(/\n$/, ''), author: { name, email, date }, committer: { name, email, date }, tree: { sha: c.tree, url: '' } },
    author: { login: VIEWER_LOGIN }, committer: { login: VIEWER_LOGIN },
    parents: c.parents.map((p) => ({ sha: p, url: '' })),
  };
}
function listCommits(r: Repo, tip: string): Json[] {
  const out: Json[] = []; const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const c = commitOf(r, oid); if (!c) continue;
    seen.add(oid);
    out.push(commitJson(r, oid, c));
    for (const p of c.parents) stack.push(p);
  }
  return out;
}
function handleContentsGet(req: IncomingMessage, res: ServerResponse, r: Repo, filePath: string, url: URL): void {
  const refParam = url.searchParams.get('ref');
  let tip: string | undefined;
  if (refParam) tip = r.refs.get(`refs/heads/${refParam}`) ?? (r.objects.has(refParam) ? refParam : undefined);
  else tip = defaultTip(r);
  if (!tip) { errJson(res, 404, 'Not Found'); return; }
  const commit = commitOf(r, tip); if (!commit) { errJson(res, 404, 'Not Found'); return; }
  if (!filePath) {
    const entries = parseTree(r.objects.get(commit.tree)!.data).map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid, size: e.mode === '40000' ? 0 : (r.objects.get(e.oid)?.data.length ?? 0), url: '', html_url: '', git_url: '', download_url: null }));
    sendJson(res, 200, entries); return;
  }
  const flat = flattenTree(r, commit.tree);
  const file = flat.get(filePath);
  if (file) {
    const data = r.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(), path: filePath, content: data.toString('base64'), sha: file.oid, url: '', html_url: '', git_url: '', download_url: null });
    return;
  }
  // directory?
  const dirEntries: Json[] = [];
  const prefix = `${filePath}/`;
  const seen = new Set<string>();
  for (const [p, ent] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0];
    if (seen.has(first)) continue;
    seen.add(first);
    const isDir = rest.includes('/');
    let sha = ent.oid;
    if (isDir) {
      // find subtree oid by walking
      const parts = filePath.split('/');
      let treeOid = commit.tree;
      for (const part of parts) { const e = parseTree(r.objects.get(treeOid)!.data).find((x) => x.name === part); if (!e) { treeOid = ''; break; } treeOid = e.oid; }
      const sub = treeOid ? parseTree(r.objects.get(treeOid)!.data).find((x) => x.name === first) : undefined;
      sha = sub?.oid ?? ent.oid;
    }
    dirEntries.push({ type: isDir ? 'dir' : 'file', name: first, path: `${filePath}/${first}`, sha, size: isDir ? 0 : (r.objects.get(ent.oid)?.data.length ?? 0), url: '', html_url: '', git_url: '', download_url: null });
  }
  if (dirEntries.length) { sendJson(res, 200, dirEntries); return; }
  errJson(res, 404, 'Not Found');
}
function handleContentsPut(req: IncomingMessage, res: ServerResponse, r: Repo, filePath: string, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
  const v = isObj(parsed.value) ? parsed.value : {};
  const message = asStr(v.message, 'Update');
  const contentB64 = asStr(v.content);
  if (!contentB64) { errJson(res, 422, 'Validation Failed: content is required'); return; }
  const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = asStr(v.branch, r.defaultBranch);
  const ref = `refs/heads/${branch}`;
  let tip = r.refs.get(ref);
  if (!tip && branch !== r.defaultBranch) {
    // create branch from default tip (MCP fallback path)
    const base = defaultTip(r);
    if (base) { r.refs.set(ref, base); tip = base; }
  }
  const blobSha = hashObject('blob', content);
  r.objects.set(blobSha, { type: 'blob', data: content });
  const baseTree = tip ? commitOf(r, tip)?.tree ?? null : null;
  if (tip) {
    const flat = flattenTree(r, baseTree!);
    const existing = flat.get(filePath);
    const sha = asStr(v.sha);
    if (existing) {
      if (sha && sha.toLowerCase() !== existing.oid.toLowerCase()) { errJson(res, 409, 'Conflict: sha does not match'); return; }
      if (!sha) { errJson(res, 409, 'Conflict: sha is required to update a file'); return; }
    } else if (sha) { errJson(res, 422, 'Validation Failed: sha does not match'); return; }
  }
  const treeOid = buildTreeFromFiles(r, baseTree, [{ path: filePath, oid: blobSha }]);
  const ts = nowSec();
  const commitData = buildCommit(treeOid, tip ? [tip] : [], message.endsWith('\n') ? message : `${message}\n`, ts);
  const commitSha = hashObject('commit', commitData);
  r.objects.set(commitSha, { type: 'commit', data: commitData });
  r.refs.set(ref, commitSha);
  const status = tip ? 200 : 201;
  // 201 on create, 200 on update: distinguish by whether file existed before
  const existed = tip !== undefined && baseTree !== null && flattenTree(r, baseTree).has(filePath);
  sendJson(res, existed ? 200 : 201, {
    content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, url: '', html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64', content: contentB64 },
    commit: { sha: commitSha, node_id: gid('Commit', `${r.owner}/${r.name}:${commitSha}`), message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: iso(ts) }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: iso(ts) }, parents: tip ? [{ sha: tip }] : [], tree: { sha: treeOid } },
  });
  void status;
}
function handleContentsDelete(req: IncomingMessage, res: ServerResponse, r: Repo, filePath: string, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
  const v = isObj(parsed.value) ? parsed.value : {};
  const branch = asStr(v.branch, r.defaultBranch);
  const tip = r.refs.get(`refs/heads/${branch}`);
  if (!tip) { errJson(res, 404, 'Not Found'); return; }
  const commit = commitOf(r, tip); if (!commit) { errJson(res, 404, 'Not Found'); return; }
  const flat = flattenTree(r, commit.tree);
  if (!flat.has(filePath)) { errJson(res, 404, 'Not Found'); return; }
  const treeOid = buildTreeFromFiles(r, commit.tree, [{ path: filePath, oid: null }]);
  const ts = nowSec();
  const message = asStr(v.message, 'Delete');
  const commitData = buildCommit(treeOid, [tip], message.endsWith('\n') ? message : `${message}\n`, ts);
  const commitSha = hashObject('commit', commitData);
  r.objects.set(commitSha, { type: 'commit', data: commitData });
  r.refs.set(`refs/heads/${branch}`, commitSha);
  sendJson(res, 200, { commit: { sha: commitSha, message } });
}

// ---------------------------------------------------------------- GraphQL v4

interface GField { alias: string; name: string; args: Record<string, unknown>; selections: GField[]; }
function tokenizeGql(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if ('{}():![]=@$...'.includes(ch) || (ch === '.' && src.slice(i, i + 3) === '...')) {
      if (ch === '.' && src.slice(i, i + 3) === '...') { toks.push('...'); i += 3; continue; }
      toks.push(ch); i++; continue;
    }
    if (ch === '"') {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j++; } }
      toks.push(JSON.stringify(s)); i = j + 1; continue;
    }
    let j = i;
    while (j < src.length && !/[\s{}():!,\[\]=@$#"]/.test(src[j])) j++;
    toks.push(src.slice(i, j)); i = j;
  }
  return toks;
}
class GqlParser {
  toks: string[]; pos = 0; vars: Record<string, unknown>;
  constructor(src: string, vars: Record<string, unknown>) { this.toks = tokenizeGql(src); this.vars = vars; }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(): unknown {
    const t = this.next();
    if (t === '$') { const name = this.next(); return { __var: name }; }
    if (t === '[') { const arr: unknown[] = []; while (this.peek() !== ']') arr.push(this.parseValue()); this.expect(']'); return arr; }
    if (t === '{') { const obj: Record<string, unknown> = {}; while (this.peek() !== '}') { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(); } this.expect('}'); return obj; }
    if (t.startsWith('"')) return JSON.parse(t);
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    const n = Number(t); if (t !== '' && Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(t)) return n;
    return { __enum: t };
  }
  resolve(v: unknown): unknown {
    if (isObj(v) && '__var' in v) return this.vars[String(v.__var)];
    if (isObj(v) && '__enum' in v) return String(v.__enum);
    if (Array.isArray(v)) return v.map((x) => this.resolve(x));
    if (isObj(v)) { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries(v)) o[k] = this.resolve(x); return o; }
    return v;
  }
  parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') { const k = this.next(); this.expect(':'); args[k] = this.resolve(this.parseValue()); }
    this.expect(')');
    return args;
  }
  parseSelectionSet(): GField[] {
    this.expect('{');
    const fields: GField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') { this.next(); this.next(); }
        const inner = this.parseSelectionSet();
        fields.push(...inner.map((f) => ({ ...f, __fragment: true } as GField & { __fragment?: boolean })));
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs();
      const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
      fields.push({ alias, name, args, selections });
    }
    this.expect('}');
    return fields;
  }
  parseOperation(): { kind: string; fields: GField[] } {
    let kind = 'query';
    let t = this.peek();
    if (t === 'query' || t === 'mutation' || t === 'subscription') { kind = this.next(); t = this.peek(); if (t !== '{' && t !== '(') this.next(); }
    if (this.peek() === '(') { // variable definitions: skip balanced
      let depth = 0;
      do { const x = this.next(); if (x === '(') depth++; else if (x === ')') depth--; } while (depth > 0);
    }
    const fields = this.parseSelectionSet();
    return { kind, fields };
  }
}
const ISSUE_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt'];
const PR_TYPE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRefOid', 'baseRefOid', 'createdAt', 'url'];
const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'description', 'isPrivate', 'url'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'LABEL', 'MILESTONE', 'PACKAGE', 'WIKI'];

function gqlIssueFields(r: Repo, i: Issue, sels: GField[]): Json {
  const out: Json = {};
  for (const f of sels) {
    if (f.name === 'id') out[f.alias] = issueGid(r, i.number);
    else if (f.name === 'number') out[f.alias] = i.number;
    else if (f.name === 'title') out[f.alias] = i.title;
    else if (f.name === 'state') out[f.alias] = i.state.toUpperCase();
    else if (f.name === 'body') out[f.alias] = i.body;
    else if (f.name === 'createdAt') out[f.alias] = i.createdAt;
    else if (f.name === 'updatedAt') out[f.alias] = i.updatedAt;
    else if (f.name === 'url') out[f.alias] = `/${r.owner}/${r.name}/issues/${i.number}`;
    else if (f.name === 'author') out[f.alias] = { login: VIEWER_LOGIN };
    else if (f.name === 'labels') out[f.alias] = { nodes: i.labels.map((l) => ({ name: l.name })) };
    else if (f.name === 'comments') out[f.alias] = { nodes: i.comments.map((c) => ({ id: commentGid(r, i.number, c.id), body: c.body })) };
    else out[f.alias] = null;
  }
  return out;
}
function gqlPullFields(r: Repo, p: Pull, sels: GField[]): Json {
  const out: Json = {};
  for (const f of sels) {
    if (f.name === 'id') out[f.alias] = pullGid(r, p.number);
    else if (f.name === 'number') out[f.alias] = p.number;
    else if (f.name === 'title') out[f.alias] = p.title;
    else if (f.name === 'state') out[f.alias] = p.merged ? 'MERGED' : p.state.toUpperCase();
    else if (f.name === 'body') out[f.alias] = p.body;
    else if (f.name === 'headRefName') out[f.alias] = p.head;
    else if (f.name === 'baseRefName') out[f.alias] = p.base;
    else if (f.name === 'mergeable') out[f.alias] = computeMergeable(r, p);
    else if (f.name === 'merged') out[f.alias] = p.merged;
    else if (f.name === 'headRefOid') out[f.alias] = refTip(r, `refs/heads/${p.head}`) ?? p.headSha;
    else if (f.name === 'baseRefOid') out[f.alias] = refTip(r, `refs/heads/${p.base}`) ?? p.baseSha;
    else if (f.name === 'createdAt') out[f.alias] = p.createdAt;
    else if (f.name === 'url') out[f.alias] = `/${r.owner}/${r.name}/pull/${p.number}`;
    else if (f.name === 'files') {
      const first = asNum(f.args.first, 100);
      const headTip = refTip(r, `refs/heads/${p.head}`);
      const baseCommit = commitOf(r, p.mergeBase);
      const headCommit = headTip ? commitOf(r, headTip) : null;
      const diffs = diffTrees(r, baseCommit?.tree ?? null, headCommit?.tree ?? null).slice(0, first);
      out[f.alias] = { nodes: diffs.map((d) => ({ path: d.filename })), totalCount: diffs.length };
    } else out[f.alias] = null;
  }
  return out;
}
function gqlRepoFields(r: Repo, sels: GField[], errors: Array<{ message: string }>): Json {
  const out: Json = {};
  for (const f of sels) {
    if (f.name === 'id') out[f.alias] = repoGid(r);
    else if (f.name === 'databaseId') out[f.alias] = r.id;
    else if (f.name === 'name') out[f.alias] = r.name;
    else if (f.name === 'nameWithOwner') out[f.alias] = `${r.owner}/${r.name}`;
    else if (f.name === 'description') out[f.alias] = r.description;
    else if (f.name === 'isPrivate') out[f.alias] = r.private;
    else if (f.name === 'url') out[f.alias] = `/${r.owner}/${r.name}`;
    else if (f.name === 'createdAt') out[f.alias] = r.createdAt;
    else if (f.name === 'owner') out[f.alias] = { login: r.owner };
    else if (f.name === 'defaultBranchRef') {
      const tip = defaultTip(r);
      out[f.alias] = tip ? { name: r.defaultBranch, target: { oid: tip } } : null;
    }
    else if (f.name === 'viewerPermission') out[f.alias] = 'ADMIN';
    else if (f.name === 'hasIssuesEnabled') out[f.alias] = true;
    else if (f.name === 'issue') {
      const n = asNum(f.args.number, 0);
      const issue = r.issues.find((i) => i.number === n);
      out[f.alias] = issue ? gqlIssueFields(r, issue, f.selections) : null;
    }
    else if (f.name === 'issues') {
      const first = asNum(f.args.first, 10);
      const after = asStr(f.args.after, '');
      let list = [...r.issues];
      const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : null;
      if (states) list = list.filter((i) => states.includes(i.state.toUpperCase()));
      const orderBy = isObj(f.args.orderBy) ? f.args.orderBy : null;
      if (orderBy && String(orderBy.field) === 'CREATED_AT') list.sort((a, b) => String(orderBy.direction) === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq);
      else list.sort((a, b) => a.createdSeq - b.createdSeq);
      if (after) { const m = /^cursor:(\d+)$/.exec(unb64url(after)); if (m) list = list.filter((i) => i.number > Number(m[1])); }
      const page = list.slice(0, first);
      const hasNext = list.length > first;
      const endCursor = page.length ? b64url(`cursor:${page[page.length - 1].number}`) : null;
      out[f.alias] = { nodes: page.map((i) => gqlIssueFields(r, i, f.selections.find((s) => s.name === 'nodes')?.selections ?? [])), edges: page.map((i) => ({ node: gqlIssueFields(r, i, f.selections.find((s) => s.name === 'edges')?.selections.find((x) => x.name === 'node')?.selections ?? []), cursor: b64url(`cursor:${i.number}`) })), pageInfo: { hasNextPage: hasNext, hasPreviousPage: false, startCursor: page.length ? b64url(`cursor:${page[0].number}`) : null, endCursor }, totalCount: list.length };
    }
    else if (f.name === 'pullRequests') {
      const first = asNum(f.args.first, 10);
      const list = [...r.pulls].slice(0, first);
      out[f.alias] = { nodes: list.map((p) => gqlPullFields(r, p, f.selections.find((s) => s.name === 'nodes')?.selections ?? [])), totalCount: r.pulls.length };
    }
    else if (f.name === 'pullRequest') {
      const n = asNum(f.args.number, 0);
      const pull = r.pulls.find((p) => p.number === n);
      out[f.alias] = pull ? gqlPullFields(r, pull, f.selections) : null;
    }
    else { errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` }); out[f.alias] = null; }
  }
  return out;
}
function gqlTypeInfo(name: string): { fields: string[]; enumValues: string[] } | null {
  if (name === 'Issue') return { fields: ISSUE_TYPE_FIELDS, enumValues: [] };
  if (name === 'PullRequest') return { fields: PR_TYPE_FIELDS, enumValues: [] };
  if (name === 'Repository') return { fields: REPO_TYPE_FIELDS, enumValues: [] };
  if (name === 'SearchType') return { fields: [], enumValues: SEARCH_ENUM };
  if (name === 'User') return { fields: ['id', 'login', 'name', 'email'], enumValues: [] };
  return null;
}
function executeGql(query: string, variables: Record<string, unknown>): { data: Json | null; errors: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  let op: { kind: string; fields: GField[] };
  try { op = new GqlParser(query, variables).parseOperation(); } catch (e) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  const data: Json = {};
  if (op.kind === 'mutation') {
    for (const f of op.fields) {
      const input = isObj(f.args.input) ? f.args.input : {};
      if (f.name === 'createIssue') {
        const dec = decodeGid(asStr(input.repositoryId));
        const repo = dec?.kind === 'Repository' ? getRepo(dec.key.split('/')[0], dec.key.split('/')[1]) : undefined;
        if (!repo) { errors.push({ message: 'Repository not found' }); data[f.alias] = null; continue; }
        const created = createIssueIn(repo, asStr(input.title), asStr(input.body), []);
        if (!created.issue) { errors.push({ message: created.error ?? 'failed' }); data[f.alias] = null; continue; }
        data[f.alias] = { issue: gqlIssueFields(repo, created.issue, f.selections.find((s) => s.name === 'issue')?.selections ?? []) };
      } else if (f.name === 'closeIssue') {
        const dec = decodeGid(asStr(input.issueId));
        let found: { repo: Repo; issue: Issue } | null = null;
        if (dec?.kind === 'Issue') { const [owner, rest] = dec.key.split('/'); const [name, num] = rest.split(':'); const repo = getRepo(owner, name); const issue = repo?.issues.find((i) => i.number === Number(num)); if (repo && issue) found = { repo, issue }; }
        if (!found) { errors.push({ message: 'Issue not found' }); data[f.alias] = null; continue; }
        found.issue.state = 'closed'; found.issue.closedAt = iso(nowSec());
        data[f.alias] = { issue: gqlIssueFields(found.repo, found.issue, f.selections.find((s) => s.name === 'issue')?.selections ?? []) };
      } else if (f.name === 'createPullRequest') {
        const dec = decodeGid(asStr(input.repositoryId));
        const repo = dec?.kind === 'Repository' ? getRepo(dec.key.split('/')[0], dec.key.split('/')[1]) : undefined;
        if (!repo) { errors.push({ message: 'Repository not found' }); data[f.alias] = null; continue; }
        const created = createPullIn(repo, asStr(input.title), asStr(input.body), asStr(input.headRefName), asStr(input.baseRefName));
        if (!created.pull) { errors.push({ message: created.error ?? 'failed' }); data[f.alias] = null; continue; }
        data[f.alias] = { pullRequest: gqlPullFields(repo, created.pull, f.selections.find((s) => s.name === 'pullRequest')?.selections ?? []) };
      } else if (f.name === 'mergePullRequest') {
        const dec = decodeGid(asStr(input.pullRequestId));
        let found: { repo: Repo; pull: Pull } | null = null;
        if (dec?.kind === 'PullRequest') { const [owner, rest] = dec.key.split('/'); const [name, num] = rest.split(':'); const repo = getRepo(owner, name); const pull = repo?.pulls.find((p) => p.number === Number(num)); if (repo && pull) found = { repo, pull }; }
        if (!found) { errors.push({ message: 'Pull request not found' }); data[f.alias] = null; continue; }
        if (found.pull.state !== 'open') { errors.push({ message: 'Pull request is not open' }); data[f.alias] = null; continue; }
        const merged = doSquashMerge(found.repo, found.pull);
        if (!merged.ok) { errors.push({ message: merged.reason ?? 'Merge conflict' }); data[f.alias] = null; continue; }
        data[f.alias] = { pullRequest: gqlPullFields(found.repo, found.pull, f.selections.find((s) => s.name === 'pullRequest')?.selections ?? []) };
      } else if (f.name === 'addComment') {
        const dec = decodeGid(asStr(input.subjectId));
        let found: { repo: Repo; issue: Issue } | null = null;
        if (dec?.kind === 'Issue') { const [owner, rest] = dec.key.split('/'); const [name, num] = rest.split(':'); const repo = getRepo(owner, name); const issue = repo?.issues.find((i) => i.number === Number(num)); if (repo && issue) found = { repo, issue }; }
        if (!found) { errors.push({ message: 'Subject not found' }); data[f.alias] = null; continue; }
        const c = { id: found.repo.nextComment++, body: asStr(input.body), createdAt: iso(nowSec()) };
        found.issue.comments.push(c);
        data[f.alias] = { commentEdge: { node: { id: commentGid(found.repo, found.issue.number, c.id), body: c.body } } };
      } else { errors.push({ message: `Cannot query field "${f.name}" on type "Mutation".` }); data[f.alias] = null; }
    }
    return { data, errors };
  }
  for (const f of op.fields) {
    if (f.name === 'viewer') {
      const out: Json = {};
      for (const s of f.selections) {
        if (s.name === 'login') out[s.alias] = VIEWER_LOGIN;
        else if (s.name === 'id') out[s.alias] = String(VIEWER_ID);
        else if (s.name === 'name') out[s.alias] = VIEWER_NAME;
        else { errors.push({ message: `Cannot query field "${s.name}" on type "User".` }); out[s.alias] = null; }
      }
      data[f.alias] = out;
    } else if (f.name === 'repository') {
      const repo = getRepo(asStr(f.args.owner), asStr(f.args.name));
      data[f.alias] = repo ? gqlRepoFields(repo, f.selections, errors) : null;
    } else if (f.name === 'node') {
      const dec = decodeGid(asStr(f.args.id));
      if (!dec) { data[f.alias] = null; continue; }
      if (dec.kind === 'Repository') {
        const [owner, name] = dec.key.split('/');
        const repo = getRepo(owner, name);
        if (!repo) { data[f.alias] = null; continue; }
        const out: Json = { id: repoGid(repo) };
        for (const s of f.selections) {
          if (s.name === 'id') out[s.alias] = repoGid(repo);
          else if (s.name === 'name') out[s.alias] = repo.name;
          else if (s.name === 'nameWithOwner') out[s.alias] = `${repo.owner}/${repo.name}`;
          else out[s.alias] = null;
        }
        data[f.alias] = out;
      } else if (dec.kind === 'Issue') {
        const [owner, rest] = dec.key.split('/'); const [name, num] = rest.split(':');
        const repo = getRepo(owner, name); const issue = repo?.issues.find((i) => i.number === Number(num));
        data[f.alias] = repo && issue ? { id: issueGid(repo, issue.number), ...gqlIssueFields(repo, issue, f.selections.filter((s) => s.name !== 'id')) } : null;
      } else data[f.alias] = null;
    } else if (f.name === '__type') {
      const info = gqlTypeInfo(asStr(f.args.name));
      if (!info) { data[f.alias] = null; continue; }
      const out: Json = {};
      for (const s of f.selections) {
        if (s.name === 'fields') out[s.alias] = info.fields.map((n) => ({ name: n }));
        else if (s.name === 'enumValues') out[s.alias] = info.enumValues.map((n) => ({ name: n }));
        else if (s.name === 'name') out[s.alias] = asStr(f.args.name);
        else out[s.alias] = null;
      }
      data[f.alias] = out;
    } else { errors.push({ message: `Cannot query field "${f.name}" on type "Query".` }); data[f.alias] = null; }
  }
  return { data, errors };
}
async function handleGraphql(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
  const ops = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results = ops.map((op) => {
    if (!isObj(op) || typeof op.query !== 'string') return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
    const vars = isObj(op.variables) ? (op.variables as Record<string, unknown>) : {};
    return executeGql(op.query, vars);
  });
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS: Array<{ name: string; description: string; inputSchema: Json }> = [
  { name: 'create_repo', description: 'Create a repository for the authenticated user.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash commit.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer', description: 'Pull request number' }, number: { type: 'integer', description: 'Pull request number (alias)' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, number: { type: 'integer' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'create_comment', description: 'Add a comment to an issue.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' }, body: { type: 'string' } }, required: ['owner', 'repo', 'issue_number', 'body'] } },
];
function mcpResult(id: unknown, result: unknown): Json { return { jsonrpc: '2.0', id: id ?? null, result }; }
function mcpError(id: unknown, code: number, message: string): Json { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }
function toolOk(obj: unknown): Json {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}
function toolErr(message: string): Json { return { content: [{ type: 'text', text: message }], isError: true }; }
function mcpCallTool(name: string, args: Record<string, unknown>): { rpcError?: { code: number; message: string }; result?: Json } {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  const required = (tool.inputSchema.required as string[]) ?? [];
  const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  // merge_pull_request / get_issue accept the `number` alias for the numeric argument
  if (name === 'merge_pull_request' && missing.includes('pull_number') && args.number !== undefined) missing.splice(missing.indexOf('pull_number'), 1);
  if (name === 'get_issue' && missing.includes('issue_number') && args.number !== undefined) missing.splice(missing.indexOf('issue_number'), 1);
  if (missing.length) return { rpcError: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } };
  const owner = asStr(args.owner, VIEWER_LOGIN);
  const repoName = asStr(args.repo ?? args.repository ?? args.name);
  const fullName = asStr(args.full_name ?? args.repo_full_name);
  let resolvedOwner = owner; let resolvedRepo = repoName;
  if (!resolvedRepo && fullName.includes('/')) { const [o, n] = fullName.split('/', 2); resolvedOwner = o; resolvedRepo = n; }
  switch (name) {
    case 'create_repo': {
      const rname = asStr(args.name);
      if (!rname) return { rpcError: { code: -32602, message: 'Missing required arguments: name' } };
      const o = asStr(args.owner, VIEWER_LOGIN);
      if (getRepo(o, rname)) return { result: toolErr(`Repository ${o}/${rname} already exists`) };
      const r = createRepo(o, rname, asStr(args.description), asBool(args.private, false));
      return { result: toolOk(repoJson(r)) };
    }
    case 'get_repo': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      return { result: toolOk(repoJson(r)) };
    }
    case 'create_issue': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      const created = createIssueIn(r, asStr(args.title), asStr(args.body), []);
      if (!created.issue) return { result: toolErr(created.error ?? 'failed') };
      return { result: toolOk(issueJson(r, created.issue)) };
    }
    case 'list_issues': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      const state = asStr(args.state, 'open');
      const list = r.issues.filter((i) => state === 'all' ? true : i.state === state);
      return { result: toolOk(list.map((i) => issueJson(r, i))) };
    }
    case 'create_pull_request': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      const created = createPullIn(r, asStr(args.title), asStr(args.body), asStr(args.head), asStr(args.base));
      if (!created.pull) return { result: toolErr(created.error ?? 'failed') };
      return { result: toolOk(pullJson(r, created.pull)) };
    }
    case 'merge_pull_request': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      const num = asNum(args.pull_number ?? args.number, 0);
      const pull = r.pulls.find((p) => p.number === num);
      if (!pull) return { result: toolErr(`Pull request #${num} not found`) };
      if (pull.state !== 'open') return { result: toolErr(`Pull request #${num} is not open`) };
      const merged = doSquashMerge(r, pull);
      if (!merged.ok) return { result: toolErr(merged.reason ?? 'Merge conflict') };
      return { result: toolOk({ sha: merged.sha, merged: true, message: 'Pull request successfully merged', ...pullJson(r, pull) }) };
    }
    case 'get_issue': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      const num = asNum(args.issue_number ?? args.number, 0);
      const issue = r.issues.find((i) => i.number === num);
      if (!issue) return { result: toolErr(`Issue #${num} not found`) };
      return { result: toolOk(issueJson(r, issue)) };
    }
    case 'create_comment': {
      const r = getRepo(resolvedOwner, resolvedRepo);
      if (!r) return { result: toolErr(`Repository ${resolvedOwner}/${resolvedRepo} not found`) };
      const num = asNum(args.issue_number ?? args.number, 0);
      const issue = r.issues.find((i) => i.number === num);
      if (!issue) return { result: toolErr(`Issue #${num} not found`) };
      const c = { id: r.nextComment++, body: asStr(args.body), createdAt: iso(nowSec()) };
      issue.comments.push(c);
      return { result: toolOk({ id: c.id, node_id: commentGid(r, issue.number, c.id), body: c.body, user: viewerUser(), created_at: c.createdAt }) };
    }
    default: return { rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}
async function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (req.method === 'DELETE') { res.writeHead(204, { 'x-github-request-id': reqId() }); res.end(); return; }
  if (req.method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
  if (!authed(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  const text = body.toString('utf8');
  let msg: unknown;
  try { msg = JSON.parse(text); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isObj(msg)) { sendJson(res, 400, mcpError(null, -32600, 'Invalid Request')); return; }
  const id = (msg as Json).id ?? null;
  const method = asStr((msg as Json).method);
  const params = isObj((msg as Json).params) ? ((msg as Json).params as Record<string, unknown>) : {};
  if (method.startsWith('notifications/')) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, { supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'], capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' }, instructions: 'A standalone GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.' }));
    return;
  }
  if (method === 'initialize') {
    const offered = asStr((params as Json).protocolVersion, '2025-11-25');
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const negotiated = supported.includes(offered) ? offered : '2025-11-25';
    sendJson(res, 200, mcpResult(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } }));
    return;
  }
  if (method === 'ping') { sendJson(res, 200, mcpResult(id, {})); return; }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const toolName = asStr(params.name);
    const args = isObj(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const out = mcpCallTool(toolName, args);
    if (out.rpcError) { sendJson(res, 200, mcpError(id, out.rpcError.code, out.rpcError.message)); return; }
    sendJson(res, 200, mcpResult(id, out.result));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------- dispatch

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = urlOf(req);
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
      const body = await readBody(req);
      if (path === '/api/graphql' && method === 'POST') { await handleGraphql(req, res, body); return; }
      if (path === '/mcp') { await handleMcp(req, res, body); return; }
      if (path.startsWith('/api/v3')) { await handleRest(req, res, body); return; }
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        const [, ownerRaw, repoRaw, tail] = gitMatch;
        const owner = decodeURIComponent(ownerRaw); const repoName = decodeURIComponent(repoRaw);
        if (!authed(req)) { errJson(res, 401, 'Requires authentication'); return; }
        const repo = getRepo(owner, repoName);
        if (tail === 'info/refs') {
          const service = url.searchParams.get('service') ?? '';
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 400, 'Bad Request'); return; }
          if (!repo) { errJson(res, 404, 'Not Found'); return; }
          handleInfoRefs(req, res, owner, repoName, service);
          return;
        }
        if (!repo) { errJson(res, 404, 'Not Found'); return; }
        if (tail === 'git-upload-pack' && method === 'POST') {
          let out: Buffer;
          try {
            const hasCommand = decodePktLines(body).some((p) => p.kind === 'data' && p.payload.toString('utf8').startsWith('command='));
            out = hasCommand ? handleUploadPackV2(repo, body) : handleUploadPackV0(repo, body);
          } catch {
            errJson(res, 400, 'Bad Request'); return;
          }
          sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
          return;
        }
        if (tail === 'git-receive-pack' && method === 'POST') {
          let out: Buffer;
          try { out = handleReceivePack(repo, body); } catch { errJson(res, 400, 'Bad Request'); return; }
          sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      errJson(res, 404, 'Not Found');
    } catch (err) {
      try { errJson(res, 500, err instanceof Error ? err.message : 'Internal Server Error'); } catch { /* socket gone */ }
    }
  });
}
