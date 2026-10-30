# CONTRACT — dsh-workspace-session-search

> Implementation contract for the two build tasks (host half / client UI). The
> Lead owns `package.json`, `cordis.patch.yml`, `scripts/`, `src/shared/contract.ts`,
> `src/client/{entry.tsx,plugin.tsx,api.ts,types.ts,globals.d.ts,css.d.ts}`,
> `README.md`, install into the profile, and the final integration build.
> Do not edit files outside your task's write scope.

## 1. Goal

A DeepSeek Harness (DSH) plugin that adds a **sidebar panel** ("会话搜索 / Session
search") which full-text searches **every session of every workspace** in the
current DSH profile, and shows **multiple matching conversation turns per
session** (user + assistant messages), with snippets, grouped by session, and
click-to-open.

## 2. Architecture (already decided — do not change)

```
Browser (client half, built to dist/client.js)
  sidebar.panellist icon  ──selectPanel──▶  main keyed slot "session-search"
        │                                        │
        │                    PanelFace: search()/recent()/openSession()
        ▼                                        ▼
  Connection unary RPC  POST /api/workspaceSessionSearch/search   { args: { request } }
        │
        ▼
Host half (lib/index.js, plain ESM JS, ZERO imports)
  Cordis plugin: ctx.provide('workspaceSessionSearch', service)
  service.typertRemote = { service, serviceKey, namespace }        (hand-written)
  Service.prototype["@deepseek-ai/dsh-typert-protocol/remote-methods"]
      = { version: 1, methods: [{ method: 'search', invocation: { kind: 'direct' } }, …] }
  methods: async search(request) / async recent(request)   ← plain identifier params only
        │
        ▼
  ctx.sessionQuery (root session-query service, backed by @deepseek-ai/dsh-session-query-sqlite)
    searchSessions / searchEvents / readTitleSnapshots / listSessions
```

The bundle patch (`cordis.patch.yml`) enables the root full-text index by
overriding the `session-query-sqlite` row to `openAt: first-search`, and inserts
the host plugin row. This is the "source-mode" Remote path: no generated Typert
artifacts are available to third-party plugins, so the host half registers the
SRC markers by hand and the client calls the raw `/api` endpoint.

**Reference material** (read before coding):

- Extracted DSH packages (docs + compiled JS):
  `/tmp/dsh-extract/node_modules/@deepseek-ai/{dsh-session-query,dsh-session-query-sqlite,dsh-api-gateway,dsh-typert-protocol,dsh-api-session-controller,dsh-client-ui-sidebar,dsh-client-ui-plugin-manager,dsh-client-ui-layout,dsh-client-ui-workspace}/`
- Installed profile packages (real files, importable): `~/.dsh/profiles/node_modules/@deepseek-ai/…`
- Reference third-party plugin (build/test/UI patterns): `~/dsh-plugins/dsh-my-plugin-updater/`
  - `test/harness.mjs` — loads a built client bundle through the DSH module
    loader with a mini React renderer and fake remotes. Reuse this pattern.

Key gateway facts (verified in `dsh-api-gateway/lib/index.js`):

- `collectSrcClaims()` scans `ctx.reflect.props` for `type === 'service'`, reads
  `Reflect.get(original, 'typertRemote')`, then `remoteMethods(original)`.
- `readBinding` requires `typertRemote.service === service`, `serviceKey` exact,
  and `namespace` a string.
- `methodParameterNames()` parses `Function.prototype.toString` of the prototype
  method: parameters must be unique plain identifiers (no destructuring,
  defaults, or rest). `signal` must be the LAST parameter if used.
- Args wire shape: `{ request: <object> }` for `async search(request)`.
- Return values must be **lossless JSON** (`src-json` codec): no `undefined`
  values inside objects/arrays, no `BigInt`, no non-finite numbers, no class
  instances, no functions. Use `null` for absent fields; verify with
  `JSON.parse(JSON.stringify(value))` equality in tests.
- The service must be visible from the gateway's root context: `ctx.provide()`
  (not isolated).
- Endpoint names are claimed lazily; gateway clears the claim cache on
  `internal/service`, so ordering is safe.

## 3. Host half — `lib/index.js` (task: host-remote)

Plain ESM JavaScript, **no imports at all** (Node builtins are also unnecessary).
Target Node 22+.

Exports:

```js
export const name = 'workspace-session-search'
export const inject = ['sessionQuery']
export function apply(ctx) { … }
```

`apply(ctx)` must:

1. Build the service object (class instance is fine, hand-written class).
2. Attach the binding and the Remote method markers exactly as in §2.
3. Register the service as a Cordis service: `ctx.provide('workspaceSessionSearch', service)`.
4. Register no commands, no other services.

Methods (parameter names and order are part of the wire contract):
`async search(request)` and `async recent(request)`. Do **not** add a `signal`
parameter for v1 (keep it simple; the client aborts its fetch and the gateway
cancels the invocation signal internally — if you add `signal` it must be last).

### 3.1 `search(request)`

Input (`src/shared/contract.ts` is the source of truth):

```ts
{ query: string, sessionLimit?: number /*1..100, default 30*/, hitLimit?: number /*1..20, default 5*/, cursor?: string, cwd?: string }
```

Algorithm:

1. Normalize `query`: `String(query ?? '').trim()`. Reject empty query by throwing
   `new Error('搜索关键词不能为空。')` (the client never sends empty queries).
2. Candidate sessions: `ctx.sessionQuery.searchSessions({ query, limit: sessionLimit, eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] }], ...(cursor ? { cursor } : {}) }, { signal })`.
   - Return shape: `{ items: [{ header, live, persisted, bestMatch }], nextCursor? }`.
   - `bestMatch` = `{ sessionId, seq, type, time, surface, snippet }`.
3. Keep only workspace sessions: `hit.header.cwd` is a non-empty string. Also
   skip rows whose `bestMatch` type is not a message type or whose `surface` is
   not `'current'`. If `request.cwd` is a non-empty string, require exact equality.
4. For each kept session (bounded concurrency, e.g. 4 at a time), fetch its
   matching turns:
   `ctx.sessionQuery.searchEvents({ sessionId, query, limit: hitLimit, eventFilters: <same filters> }, { signal })`
   → `{ session, items: [{ sessionId, seq, type, time, surface, snippet }] }`.
   Use `items` as `hits` (already strongest-first). On a per-session failure,
   fall back to `[bestMatch]` instead of failing the whole search.
5. Titles: `ctx.sessionQuery.readTitleSnapshots(sessionIds)` →
   `[{ status: 'fulfilled', value: { session, title? } } | { status: 'rejected', reason }]`.
   Map `sessionId → title ?? null`. Batch once per page. Failures isolate per id.
   Fallback title if unavailable: `null` (the client renders 未命名).
6. Response (JSON-safe, no undefined):
   ```json
   { "query": "…", "sessions": [ { "sessionId": "…", "title": "… | null", "cwd": "…", "createdAt": 0,
       "live": true, "parentSessionId": "…(optional, omit when absent)",
       "hits": [ { "seq": 0, "type": "user/message", "time": 0, "snippet": "…" } ],
       "bestMatch": { "seq": 0, "type": "…", "time": 0, "snippet": "…" } } ],
     "hasMore": true, "nextCursor": "…(optional, omit when absent)" }
   ```
   `hasMore` = `page.nextCursor !== undefined`. Preserve provider order.
7. Error mapping: if `error.code === 'SESSION_QUERY_SEARCH_DISABLED'`, throw
   `new Error('会话全文索引未启用：请在 profile 的 cordis.patch.yml 中把 session-query-sqlite 的 openAt 设为 first-search。')`.
   Otherwise rethrow (the gateway turns it into `gateway/internal` with the
   message; keep messages user-readable).
8. Clamp `sessionLimit` to `1..100` (default 30), `hitLimit` to `1..20` (default 5).
   Invalid cursor is passed through to the provider (it rejects with
   `SESSION_QUERY_INVALID_CURSOR`; the client restarts without a cursor only via
   its own retry path — do not silently retry here).

### 3.2 `recent(request)`

Input `{ limit?: number /*1..50, default 20*/, cwd?: string }`.

1. `const records = await ctx.sessionQuery.listSessions()` → newest-first
   `[{ header, live, persisted }]`.
2. Keep `header.cwd` non-empty; apply `request.cwd` exact filter if provided;
   take `limit`.
3. Titles via `readTitleSnapshots(ids)` (same tolerance as §3.1 step 5).
4. Return `{ sessions: [{ sessionId, title: string|null, cwd, createdAt, live, parentSessionId? }] }`.
   Omit `parentSessionId` when absent, never emit `undefined`.

### 3.3 Host tests — `test/host.test.mjs` (task: host-remote)

Standalone ESM script, Node builtins only (no test framework), exits non-zero on
failure and prints `✔`/`✖` per check plus a final count. It must:

- Load `../lib/index.js` and call `apply(fakeCtx)` with a fake `ctx` providing
  `provide(name, value)` (capture), `get`, `effect`, `inject`, `sessions` as
  needed by your code. Assert the service was registered under
  `workspaceSessionSearch`.
- Assert the discovery metadata: `typertRemote` binding shape; prototype marker
  `version === 1`, methods `search`/`recent`, `invocation.kind === 'direct'`;
  and that `Function.prototype.toString` parameter names are exactly
  `['request']`. Import the real protocol helper to double-check:
  ```js
  const protocol = await import(pathToFileURL(process.env.HOME + '/.dsh/profiles/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js'))
  protocol.remoteMethods(service) // → markers
  ```
  (If the profile path is missing, fall back to reading the marker property
  directly and note it in output.)
- Drive `service.search(...)` with a fake `sessionQuery`:
  - multi-turn: one session with 3 matching events returned by `searchEvents`
    → response has 3 `hits`, grouped under one session;
  - multiple sessions, workspace filter (`cwd`), session ordering preserved;
  - per-session `searchEvents` failure falls back to `bestMatch` and does not
    fail the page;
  - title snapshot rejection yields `title: null`;
  - `nextCursor` → `hasMore: true, nextCursor`; cursor forwarded;
  - limits clamped (sessionLimit 999 → 100; hitLimit 0 → 1).
- Drive `service.recent(...)`: newest-first, cwd filter, limit clamp.
- Assert every response is lossless JSON: `JSON.stringify` round-trip deep-equal
  and no `undefined` appears in nested objects.
- Timeboxed optional integration check (nice-to-have, skip if >20 min): load
  `dsh-typert-registry`, `dsh-api-gateway`, `dsh-api-remote-access` from the
  profile `node_modules` with a real Cordis `Context` from
  `~/.dsh/profiles/node_modules/@deepseek-ai/cordis/lib/index.js`, provide a
  fake `sessionQuery`, load this plugin, and invoke
  `ctx.typertGateway.invoke({ namespace: 'workspaceSessionSearch', method: 'search', args: { request: { query: 'x' } }, peer: <fake owner peer> })`.
  If the gateway import or peer construction is not workable quickly, record the
  attempt in your final report instead of blocking.

## 4. Client UI — `src/client/panel.tsx`, `styles.css`, `i18n.ts`, `test/client.test.mjs` (task: client-ui)

The Lead has already registered the slots and the Remote API:

- `plugin.tsx` registers `main` keyed slot `key: 'session-search'` with
  `inject: () => ({ t, search, recent, openSession, panelId })`, and the
  `sidebar.panellist` icon with `id: 'session-search'`, label from
  `i18n.lookup`.
- `api.ts` exports `createSearchApi(ctx)` returning
  `search(request, signal)` / `recent(request, signal)`, which throw
  `SearchApiError { code, message }` on failure. Codes: `remote/unavailable`,
  `remote/transport`, `remote/malformed`, `gateway/...`, `SESSION_QUERY_*`.
- `i18n.ts` already has the `NS`, `pageDicts`, `lookup`, `currentLanguage`,
  `format` helpers and a starter dictionary. Extend both `en` and `zh` keys as
  needed (keep existing keys used by `plugin.tsx`/`i18n.ts`).
- `types.ts` has `PanelFace` and the client context shapes.

`SearchPanel` requirements:

1. Stable module-level component; props = `PanelFace` (+ arbitrary slot props);
   use only `React` from the host (`import React from 'react'`), no other deps.
2. Layout: full-height panel in the main column.
   - Header: title `t('panel.title')`, subtitle `t('panel.subtitle')`.
   - Search field: input with placeholder `t('search.placeholder')`, search
     icon/button (`t('search.submit')`), clear button (`t('search.clear')`).
     Enter submits; also debounce 300 ms while typing. On panel mount, focus the
     input.
   - Each new query aborts the previous request with `AbortController` and
     ignores stale resolutions (`requestId` guard). Abort errors are silent.
   - Idle state (no query): `t('recent.title')` list of recent sessions from
     `recent({ limit: 20 })`, each row title/`t('session.untitled')`, workspace
     basename, relative time; click opens the session.
   - Loading: `t('search.loading')` with a subtle skeleton or spinner.
   - Empty: `t('search.empty')`.
   - Error: message `t('search.error')` + the thrown `SearchApiError.message`
     (map `remote/unavailable` → `t('error.unavailable')`,
     `SESSION_QUERY_SEARCH_DISABLED` → `t('error.disabled')`), retry button.
   - Result summary: `t('search.resultCount')` formatted with `format()`.
3. Results: one card/group per session, ordered as returned:
   - Session title (or `t('session.untitled')`), workspace path (basename +
     full path `title` attr), live/disk badge (`t('session.live')`/`t('session.cold')`),
     relative updated time.
   - Under it, up to `hitLimit` hit rows: role badge (`t('hit.you')` /
     `t('hit.assistant')`), relative time, snippet with the query terms
     highlighted (`<mark>`), clickable → `openSession(session.sessionId)`.
     Highlight client-side: split snippet on case-insensitive occurrences of
     the trimmed query token sequence (handle multi-word queries by highlighting
     each word occurrence), never inject HTML.
   - Clicking the group header also opens the session. Keyboard accessible:
     rows are buttons, visible focus ring.
   - `hasMore` → `t('search.more')` button appends the next page with the same
     query using `nextCursor`; while appending show `t('search.loadingMore')`
     and keep existing groups. New page's sessions with an existing
     `sessionId` merge hits into the existing group instead of duplicating.
4. Styling (`styles.css`, plain CSS, imported with `?inline` by `plugin.tsx`,
   class prefix `wss-`): use DSH theme tokens (`--dsw-alias-*`,
   `--dsw-radius-*`, `--dsh-frame-top-clearance` for the top padding of the
   main panel, `--dsw-alias-bg-skeleton` etc. — see
   `~/dsh-plugins/dsh-my-plugin-updater/src/client/styles.css` and
   `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`
   for token usage). Dark/light must both look right (tokens handle it). No
   Tailwind required. Panel root: `box-sizing: border-box; height: 100%;
   overflow-y: auto; padding: 24px 32px 48px; padding-top:
   calc(var(--dsh-frame-top-clearance, 0px) + 24px);` max content width
   ~880px centered.
5. i18n: no hardcoded user-facing text; zh + en both complete.
6. Accessibility: `aria-label` on icon buttons, `role="search"` on the form,
   `aria-live="polite"` status region, buttons reachable by Tab, no text
   clipping on narrow widths.

### 4.1 Client tests — `test/client.test.mjs` (task: client-ui)

Standalone ESM script, Node builtins + `npm run build` output. Adapt
`~/dsh-plugins/dsh-my-plugin-updater/test/harness.mjs`:

- Load `dist/client.js` in a vm/sandbox providing `window.__ModuleLoader__`,
  `document` (a tiny DOM shim sufficient for the style-injection effect), and a
  permissive `require` returning a mini React renderer (copy the updater's).
- Build a fake client context with `slots.inject/register` capture,
  `locale.register`, `effect`, `get('connection')` → fake `rpc.call` that
  resolves canned `{ ok: true, value }` payloads, `get('uiWorkspace')` →
  `{ openSession }` spy.
- Assert: `apply()` registers the sidebar icon (`id: 'session-search'`, order
  30) and the `main` panel (`key: 'session-search'`); rendering the panel with
  the injected face yields the title and search input.
- Simulate typing + Enter (or debounce advance with a fake timer) → the fake
  rpc receives `workspaceSessionSearch/search` with `{ args: { request: {
  query } } }`; results render one group with **3 hit rows** for a session that
  has 3 hits, ZH and EN labels switch with `getSnapshot().language`;
  `hasMore` append merges duplicates; error path renders the retry button;
  clicking a hit calls `uiWorkspace.openSession(sessionId)`.
- If a full render harness becomes impractical, timebox it and report honestly
  what is covered; do not pretend checks passed.

## 5. Workflow, ownership, commands

Workspace: `/Users/joeywong/dsh-plugins/dsh-workspace-session-search`.
`node_modules` is already copied; do not run `npm install`.

- Lead-only files: `package.json`, `cordis.patch.yml`, `scripts/*`,
  `src/shared/contract.ts`, `src/client/{entry.tsx,plugin.tsx,api.ts,types.ts,globals.d.ts,css.d.ts}`,
  `locale/*`, `icon.svg`, `README.md`.
- host-remote write scope: `lib/index.js`, `test/host.test.mjs`.
- client-ui write scope: `src/client/panel.tsx`, `src/client/styles.css`,
  `src/client/i18n.ts`, `test/client.test.mjs`.
- Do not edit files outside your scope; if the contract seems wrong, message
  the Lead instead of silently diverging.
- Commands:
  `npm run typecheck`, `npm run build` (client-ui may run it freely; host half
  needs no build), `node test/host.test.mjs`, `node test/client.test.mjs`.
- Definition of done: your tests pass, no TypeScript errors for client-ui, host
  code has no imports and discovery metadata verified, and you report to the
  Lead via `send_message` with: files touched, commands run + results, any
  deviation from this contract, and anything the Lead must know for integration.
