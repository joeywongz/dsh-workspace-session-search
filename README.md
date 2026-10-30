# dsh-workspace-session-search

DeepSeek Harness（DSH）插件：在左侧栏增加一个**会话搜索**面板，全文搜索**所有工作区里的历史会话**，并把**每个会话里命中的多轮对话**（用户消息 + 助手消息）按会话分组展示，点击即可打开对应会话。

源码在 `/Users/joeywong/dsh-plugins/dsh-workspace-session-search`。

## 功能

- **跨工作区搜索**：不局限于当前打开的工作区，索引整个 profile 的逻辑会话语料（实时会话优先，其次是持久化日志）。
- **多轮命中**：结果按会话分组，每个会话最多列出 `hitLimit`（默认 5）条命中的消息，各自带角色、时间与摘要片段；搜索词在摘要里高亮。
- **只搜对话内容**：只匹配 `user/message` 与 `assistant/message` 的当前表层事件，不匹配工具调用、系统事件等噪声。
- **最近会话**：没有输入关键词时，面板展示最近的工作区会话，点一下直接打开。
- **加载更多**：候选会话分页，`hasMore` 时底部出现「加载更多」，新一页与已有结果按会话合并、不重复。
- **中英文界面**：跟随 DSH 语言（zh / en）。
- **深色/浅色主题**：样式全部走 `--dsw-alias-*` 主题变量。

## 使用

1. 左侧栏出现放大镜图标 **会话搜索 / Session search**（插件列表里与「插件」图标同级）。
2. 点开后输入关键词，回车（或停顿 300ms）开始搜索。
3. 结果按会话分组：标题、工作区路径、运行中/磁盘状态、命中消息列表。
4. 点击会话标题或任意一条命中消息，打开该会话；新查询会自动中止上一个请求。

## 架构

```
浏览器（客户端半边，构建为 dist/client.js）
  sidebar.panellist 图标 ──selectPanel──▶ main keyed slot "session-search"
        │                                      │
        │             PanelFace: search()/recent()/openSession()
        ▼                                      ▼
  连接层一元 RPC   POST /api/workspaceSessionSearch/search  { args: { request } }
        │
        ▼
宿主（lib/index.js，纯 ESM JavaScript，零 import）
  Cordis 插件 ctx.provide('workspaceSessionSearch', service)
  手写 typertRemote 绑定 + "@deepseek-ai/dsh-typert-protocol/remote-methods" 描述符
  search(request) / recent(request)  →  ctx.sessionQuery
        │
        ▼
  @deepseek-ai/dsh-session-query（由 @deepseek-ai/dsh-session-query-sqlite 提供 FTS5 全文搜索）
    searchSessions（候选会话）→ 每会话 searchEvents（多轮命中）→ readTitleSnapshots（标题）
```

DSH 目前不向第三方插件提供 Typert 生成器，因此宿主半边使用 Gateway 的 **source-mode Remote**（`@Remote` 的手写 SRC 标记）注册端点，客户端用 Connection 的 `/api` 一元 RPC 直接调用。这条路径在 DSH 0.2.1-rc.5 的 gateway 上做过进程内端到端验证（见 `test/host.test.mjs` 的集成段落）。

### 目录

```
src/
  host/                    （宿主半边只有 lib/index.js，纯 JS，无源码目录）
  shared/contract.ts       宿主/客户端共用的线上协议类型与常量
  client/
    entry.tsx              构建入口：导出客户端插件对象
    plugin.tsx             apply：样式注入、i18n、main 面板 + 侧栏图标注册、Remote 绑定
    panel.tsx              搜索面板 UI
    api.ts                 Connection RPC 封装（错误码、响应归一化）
    types.ts               客户端上下文/槽位类型
    i18n.ts                zh/en 文案与 lookup
    styles.css             面板样式（?inline 注入）
lib/index.js               宿主半边（源码即产物）
dist/client.js             客户端构建产物
test/host.test.mjs         宿主端测试（fake ctx + fake sessionQuery + 真实 gateway 集成探测）
test/client.test.mjs       客户端测试（加载构建产物，迷你 React 渲染器 + 假 Remote）
scripts/build.mjs          Vite → ModuleLoader 包装
CONTRACT.md                双半边实现契约（维护者参考）
```

## 安装

**当前状态：已安装到 `~/.dsh/profiles/desktop` 并随 2026-10-30 14:31 的重启生效。** 运行中 Host 的启动图（`GET /plugins/events`）已包含 `dsh-workspace-session-search`，客户端 bundle 由 Host 通过 `/plugins/??dsh-workspace-session-search/client.js&rev=…` 正常提供（HTTP 200，52 843 字节）。

重新安装或装到其他 profile：

```sh
node scripts/install-profile.mjs                    # 默认 desktop profile
node scripts/install-profile.mjs /path/to/profile   # 指定 profile
```

脚本只改 profile 的 `package.json`（`link:` 依赖 + `dsh.profile.bundles`），幂等。等价的手工改动：

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-workspace-session-search": "link:/Users/joeywong/dsh-plugins/dsh-workspace-session-search"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-workspace-session-search"]
    }
  }
}
```

```sh
cd ~/.dsh/profiles/desktop && pnpm install   # 或在 node_modules 里建同名 link 符号链接
```

然后**完全退出并重新打开** DeepSeek Harness（客户端插件元数据有进程级缓存，仅刷新页面或重载插件不够）。

## 配置

插件自带的 `cordis.patch.yml` 会做两件事：

1. 把根 `session-query-sqlite` 行的 `openAt` 从 `never` 改为 `first-search`，并固定 `path: ':memory:'` —— 首次搜索时才打开 SQLite 索引，避免 Node 22 启动开销。
2. 插入宿主半边 `workspace-session-search`。

如需调整索引参数，可在 profile 的 `cordis.patch.yml` 里覆盖 `session-query-sqlite` 行（注意会同时影响其他使用根 `sessionQuery` 的功能）。索引用 `:memory:`，**DSH 重启后按需重建**；会话很多时首次搜索会稍慢，之后走缓存。

## 开发

```sh
npm run typecheck   # 客户端 TS 严格检查
npm test            # 宿主 + 客户端测试
npm run build       # 重新生成 dist/client.js
```

只改客户端代码时，页面开着会由 Host 的 client-hmr 热替换；改 `lib/index.js` 或 `cordis.patch.yml` 需要重启 Host。详细实现约束见 `CONTRACT.md`。

## 验证

`npm test` = **132 项检查**（宿主 85 + 客户端 47），全部通过：

- **宿主** `test/host.test.mjs`：注册/发现元数据（含真实 `remoteMethods()` 校验、参数名精确 `['request']`）、多轮命中分组、多会话 + cwd 过滤、单会话失败回退 `bestMatch`、标题容错、cursor/分页、四向 clamp、空 query、disabled 错误映射、`recent()`、响应 lossless JSON。其中可选集成段在 `/tmp/dsh-probe` 存在时，会用 **app.asar 里真实的 0.2.1-rc.5 Cordis + typert-registry + Gateway** 加载本插件并 `typertGateway.invoke` 调通 `search`/`recent`（本次实跑 4 项全 ✔；该目录由维护者按需从 app.asar 解包重建，缺失时自动 skip）。
- **客户端** `test/client.test.mjs`：加载真实 `dist/client.js`（ModuleLoader factory + 迷你 React 渲染器 + 假 ctx），覆盖两个 slot 注册、i18n 中英切换、RPC 包裹 `{ args: { request } }`、单会话 3 条命中渲染、`<mark>` 高亮、abort/stale、防抖、加载更多合并、错误重试、点击打开会话等 47 项。
- **运行中 Host 实证**：`curl -s -N http://127.0.0.1:<port>/plugins/events` 的启动图包含本插件条目；`curl http://127.0.0.1:<port>/plugins/??dsh-workspace-session-search/client.js&rev=<rev>` 返回 200 且内容与本地 `dist/client.js` 一致。

## 已知限制

- 全文索引匹配 token/短语（FTS5 `unicode61`），不是任意子串；需要子串扫描请依赖 `ctx.sessionQuery.filterEvents` 的语义文本过滤（本插件未使用）。
- 只索引 `current` 表层的 user/assistant 消息；被替换/压缩掉的旧消息不在搜索范围内。
- 包含带 `cwd` 的子代理派生会话（它们本身也是工作区会话）；如觉得噪声大，可在宿主 `search` 里按 `header.parentSession === undefined` 过滤。
- 搜索面板挂在主内容区（`main` keyed slot），不做右侧浮层；会话定位到「打开会话」，不会自动滚动到命中轮次。
