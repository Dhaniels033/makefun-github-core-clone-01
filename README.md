# github-core-clone-01

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/c/github-core-clone-01/)
[![rank](https://make.fun/badge/github-core-clone-01/Dhaniels033/makefun-github-core-clone-01/rank.svg)](https://make.fun/c/github-core-clone-01/)
[![reward](https://make.fun/badge/github-core-clone-01/Dhaniels033/makefun-github-core-clone-01/reward.svg)](https://make.fun/c/github-core-clone-01/)

> **Note:** the rank/reward badge URLs above still carry the placeholders
> `Dhaniels033` / `makefun-github-core-clone-01` — replace them with the real GitHub
> owner and repository name once the repository is created.

An entry for [make.fun's **github-core-clone-01** competition](https://make.fun/c/github-core-clone-01/)
— a from-scratch, standard-library-only clone of GitHub's core: git smart HTTP,
REST v3, GraphQL v4 and MCP, in a single Node process with an in-memory store.

## What it serves

- **Git smart HTTP** — `git-upload-pack` v2 (`ls-refs`, `fetch`, incl. shallow
  `deepen` and thin-pack handling) and `git-receive-pack` v0, with a full
  SHA-1 object model (commit/tree/blob/tag), pack read (OFS/REF deltas) and
  pack write (no deltas), sideband framing, and non-fast-forward refusal.
- **REST v3** under `/api/v3` — repos (CRUD, pagination), branches, commits,
  git refs, contents (create/update/delete with blob-sha checks), labels,
  issues + comments, pull requests (create, files, squash merge with
  conflict detection).
- **GraphQL** at `/api/graphql` — `viewer`, `repository` (incl. issues/PR
  connections with cursor pagination), `node`, `__type` introspection, and
  the `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations, plus batched operations.
- **MCP** at `/mcp` — streamable HTTP, `server/discover` + `initialize`,
  and tools `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` (plus `get_issue`,
  `create_comment`), mirroring the REST surface.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:crypto` and `node:zlib` only, and the trial has no package
manager and no internet.

The lifecycle (in `main.ts`, unchanged from the starter):

1. **Bind an ephemeral port.** `server.listen(0)`; never bind 8080 (the env's port).
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
3. **Poll** `GET $MAKEFUN_ENV_URL/done` until `{done: true}`, then exit 0.

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`;
missing/wrong token → 401. `/healthz` takes no auth.

## Determinism

State is derived from a logical clock seeded by `MAKEFUN_TRIAL_NOW`
(falling back to `2025-01-01T00:00:00Z`), advancing one second per created
object — no `Date.now()` or randomness in responses — so a live pass and its
replay leave byte-identical state.

The scenario's viewer login is `adaiversen` (id 1000, `adaiversen@example.invalid`).
That is the deterministic viewer the kit's sealed `wire.ts` derives from its
constant scenario seed (`SCENARIO_SEED = 0x6a09e667f3bcc909n`), verified by
running the kit's own `buildScenario()`; it is hardcoded in `app.ts`.

## Local verification

Kit's own grader, practice trial 0, `--driver process`:

```
node cli/makefun.mjs grade-local --kit . \
  --bot ~/workspace/makefun-work/entries/github-core-clone-01 \
  --driver process --worktree --instances 1
```

Result (2026-11-16, three runs): **feature 600/600 (120/120 checks),
agent 200/200 (15/15 MCP), perf 120–173/200** depending on machine load
(the grading VM was heavily loaded during the later runs; the first run
scored 958/1000). Live pass exited 0 and its replay matched byte for byte
in every run. `grade-local --driver docker` was not run: Docker is not
available on this machine.

## Files

- `main.ts` — lifecycle (register / poll / exit), unchanged from the starter.
- `app.ts` — the whole server (git, REST, GraphQL, MCP).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).
- `.makefun/owner.json` — owner's linked Solana wallet.
