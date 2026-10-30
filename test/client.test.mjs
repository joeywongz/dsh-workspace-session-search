/**
 * Client harness for dsh-workspace-session-search.
 *
 * Loads the built `dist/client.js` exactly as the host module loader does
 * (`window.__ModuleLoader__.load({ id, factory(require) })`), renders the
 * sidebar panel with a tiny hook-capable React renderer and a fake Cordis-like
 * client context, then drives the UI through its real event handlers.
 *
 * Adapted from ~/dsh-plugins/dsh-my-plugin-updater/test/harness.mjs.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = resolve(import.meta.dirname, '..')
const failures = []
let checkCount = 0

function check(label, condition, detail) {
  checkCount += 1
  if (!condition) {
    failures.push(label + (detail ? ' — ' + detail : ''))
    console.error('FAIL ' + label + (detail ? ' — ' + detail : ''))
    return
  }
  console.log('PASS ' + label)
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))

// ---------------------------------------------------------------- fake React
const hookStates = new Map()
let currentKey = ''
let cursor = 0
let pendingEffects = []
let dirty = false

function stateList() {
  let list = hookStates.get(currentKey)
  if (!list) {
    list = []
    hookStates.set(currentKey, list)
  }
  return list
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const nextProps = { ...(props || {}) }
    if (children.length === 1) nextProps.children = children[0]
    else if (children.length > 1) nextProps.children = children
    return { type, props: nextProps, children }
  },
  useState(initial) {
    const list = stateList()
    const index = cursor
    cursor += 1
    if (!(index in list)) list[index] = typeof initial === 'function' ? initial() : initial
    return [
      list[index],
      (value) => {
        list[index] = typeof value === 'function' ? value(list[index]) : value
        dirty = true
      },
    ]
  },
  useRef(initial) {
    const list = stateList()
    const index = cursor
    cursor += 1
    if (!(index in list)) list[index] = { current: initial }
    return list[index]
  },
  useMemo(factory) {
    const list = stateList()
    const index = cursor
    cursor += 1
    if (!(index in list)) list[index] = factory()
    return list[index]
  },
  useCallback(fn) {
    const list = stateList()
    const index = cursor
    cursor += 1
    if (!(index in list)) list[index] = fn
    return list[index]
  },
  useEffect(effect) {
    const list = stateList()
    const index = cursor
    cursor += 1
    if (!(index in list)) {
      list[index] = true
      pendingEffects.push(effect)
    }
  },
  useLayoutEffect(effect) {
    React.useEffect(effect)
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  useDebugValue() {},
}

function renderNode(node, path) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => renderNode(child, path + '/' + index))
  if (typeof node.type === 'function') {
    const key = node.props && node.props.key !== undefined ? '#' + String(node.props.key) : ''
    const componentPath = path + key
    const previousKey = currentKey
    const previousCursor = cursor
    currentKey = componentPath
    cursor = 0
    const output = node.type(node.props)
    currentKey = previousKey
    cursor = previousCursor
    return renderNode(output, componentPath)
  }
  const children = (node.children || []).map((child, index) => renderNode(child, path + '/' + index))
  return { type: node.type, props: node.props || {}, children }
}

function flushEffects() {
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) {
    try {
      effect()
    } catch (error) {
      console.error('effect failed', error)
    }
  }
}

function* walk(node) {
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  if (typeof node === 'string') return
  yield node
  for (const child of node.children || []) yield* walk(child)
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

function normalizedText(node) {
  return textOf(node).replace(/\s+/g, ' ').trim()
}

function classTokens(node) {
  const className = node && node.props ? node.props.className : ''
  return typeof className === 'string' ? className.split(/\s+/).filter(Boolean) : []
}

function hasClass(node, token) {
  return classTokens(node).includes(token)
}

function findAllByClass(node, token) {
  const output = []
  for (const child of walk(node)) {
    if (hasClass(child, token)) output.push(child)
  }
  return output
}

function findByClass(node, token) {
  return findAllByClass(node, token)[0] || null
}

function findInput(node) {
  for (const child of walk(node)) {
    if (child.type === 'input') return child
  }
  return null
}

function findForm(node) {
  for (const child of walk(node)) {
    if (child.type === 'form') return child
  }
  return null
}

function findByAriaLive(node, value) {
  for (const child of walk(node)) {
    if (child.props && child.props['aria-live'] === value) return child
  }
  return null
}

function findButtons(node) {
  const output = []
  for (const child of walk(node)) {
    if (child.type === 'button') output.push(child)
  }
  return output
}

function findBySessionId(node, sessionId) {
  for (const child of walk(node)) {
    if (child.props && child.props['data-session-id'] === sessionId) return child
  }
  return null
}

// ------------------------------------------------------------ fake page/env
const injectedStyles = []

globalThis.window = globalThis
globalThis.document = {
  head: {
    appendChild(element) {
      injectedStyles.push(element)
    },
  },
  createElement(tag) {
    return { tagName: tag, dataset: {}, textContent: '', remove() {} }
  },
  documentElement: { lang: 'zh-CN' },
  addEventListener() {},
  removeEventListener() {},
}

let capturedDefinition = null
globalThis.__ModuleLoader__ = {
  load(definition) {
    capturedDefinition = definition
  },
}

// ------------------------------------------------------------ fake client ctx
const registrations = []
const registeredDictionaries = new Map()
const injectedSlots = []
const rpcCalls = []
const openedSessions = []
let language = 'zh'

let recentResponder = null
let searchResponder = null

function remoteValue(value) {
  return { ok: true, value }
}

function remoteFailure(code, message) {
  return { ok: false, error: { code, message } }
}

const fakeConnection = {
  rpc: {
    call(channel, endpoint, payload, signal) {
      const record = { channel, endpoint, payload, signal }
      rpcCalls.push(record)
      const method = String(endpoint).split('/').pop()
      const responder = method === 'recent' ? recentResponder : searchResponder
      return Promise.resolve().then(() => {
        if (typeof responder !== 'function') return remoteFailure('remote/unavailable', 'no fake responder')
        return responder(payload, signal, record)
      })
    },
  },
}

const fakeUiWorkspace = {
  openSession(sessionId) {
    openedSessions.push(sessionId)
  },
}

const ctx = {
  locale: {
    register(namespace, lang, dict) {
      registeredDictionaries.set(namespace + ':' + lang, dict)
      return () => {}
    },
    getSnapshot() {
      return { language }
    },
  },
  slots: {
    inject(name, callback) {
      injectedSlots.push(name)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(_deps, callback) {
    callback(ctx)
  },
  get(name) {
    if (name === 'connection') return fakeConnection
    if (name === 'uiWorkspace') return fakeUiWorkspace
    return undefined
  },
}

// ---------------------------------------------------------------------- boot
const bundleSource = readFileSync(resolve(root, 'dist', 'client.js'), 'utf8')
vm.runInThisContext(bundleSource, { filename: 'dist/client.js' })

check('bundle is registered through the DSH module loader', capturedDefinition !== null)
check(
  'bundle id matches the plugin id',
  Boolean(capturedDefinition) && capturedDefinition.id === 'dsh-workspace-session-search',
  capturedDefinition ? String(capturedDefinition.id) : 'missing',
)

let plugin = null
try {
  plugin = capturedDefinition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
} catch (error) {
  console.error('bundle factory failed', error)
}
check('bundle factory returns the plugin', Boolean(plugin) && typeof plugin.apply === 'function')

plugin.apply(ctx)

// ------------------------------------------------------------- registrations
const mainRegistration = registrations.find((item) => item.options.name === 'main')
const sidebarRegistration = registrations.find((item) => item.options.name === 'sidebar.panellist')

check('registers exactly two slots', registrations.length === 2, 'got ' + registrations.length)
check(
  'main slot uses the session-search key',
  Boolean(mainRegistration) && mainRegistration.options.key === 'session-search',
  mainRegistration ? JSON.stringify(mainRegistration.options.key) : 'missing',
)
check(
  'sidebar panellist uses the session-search id and order 30',
  Boolean(sidebarRegistration) &&
    sidebarRegistration.options.id === 'session-search' &&
    sidebarRegistration.options.order === 30,
  sidebarRegistration ? JSON.stringify({ id: sidebarRegistration.options.id, order: sidebarRegistration.options.order }) : 'missing',
)
check(
  'sidebar label is localized (zh)',
  Boolean(sidebarRegistration) && sidebarRegistration.options.label() === '会话搜索',
  sidebarRegistration ? String(sidebarRegistration.options.label()) : 'missing',
)
check(
  'injects into main and sidebar.panellist',
  injectedSlots.includes('main') && injectedSlots.includes('sidebar.panellist'),
  JSON.stringify(injectedSlots),
)
check(
  'registers zh and en dictionaries',
  registeredDictionaries.has('dshWorkspaceSessionSearch:zh') &&
    registeredDictionaries.has('dshWorkspaceSessionSearch:en') &&
    registeredDictionaries.get('dshWorkspaceSessionSearch:zh')['panel.title'] === '会话搜索' &&
    registeredDictionaries.get('dshWorkspaceSessionSearch:en')['panel.title'] === 'Session search',
)
check(
  'injects the compiled stylesheet once',
  injectedStyles.length === 1 &&
    injectedStyles[0].dataset.dshPlugin === 'dsh-workspace-session-search' &&
    injectedStyles[0].textContent.includes('.wss-panel') &&
    injectedStyles[0].textContent.includes('--dsh-frame-top-clearance'),
  'styles=' + injectedStyles.length,
)

// ------------------------------------------------------------------ rendering
function panelFace() {
  if (!mainRegistration) throw new Error('main slot was not registered')
  return mainRegistration.options.inject()
}

function renderPanel() {
  const element = React.createElement(mainRegistration.component, { ...panelFace() })
  return renderNode(element, 'panel')
}

function flushRender() {
  let tree = null
  let guard = 0
  do {
    dirty = false
    tree = renderPanel()
    flushEffects()
    guard += 1
  } while (dirty && guard < 40)
  return tree
}

async function settle(ms = 30) {
  await wait(ms)
  return flushRender()
}

async function until(predicate, timeoutMs = 3000) {
  const start = Date.now()
  let tree = flushRender()
  while (!predicate(tree)) {
    if (Date.now() - start > timeoutMs) return tree
    await wait(20)
    tree = flushRender()
  }
  return tree
}

function typeQuery(tree, value) {
  const input = findInput(tree)
  if (!input) throw new Error('search input was not rendered')
  input.props.onChange({ target: { value } })
  return flushRender()
}

function submitForm(tree) {
  const form = findForm(tree)
  if (!form) throw new Error('search form was not rendered')
  form.props.onSubmit({ preventDefault() {} })
  return flushRender()
}

function lastSearchCall() {
  const calls = rpcCalls.filter((call) => call.endpoint === 'workspaceSessionSearch/search')
  return calls.length > 0 ? calls[calls.length - 1] : null
}

function searchCallsFor(query) {
  return rpcCalls.filter(
    (call) =>
      call.endpoint === 'workspaceSessionSearch/search' &&
      call.payload &&
      call.payload.args &&
      call.payload.args.request &&
      call.payload.args.request.query === query,
  )
}

// ------------------------------------------------------------------ fixtures
const now = Date.now()

function hit(seq, type, snippet, minutesAgo) {
  return { seq, type, time: now - minutesAgo * 60_000, snippet }
}

function group(sessionId, title, cwd, hits, options = {}) {
  return {
    sessionId,
    title,
    cwd,
    createdAt: options.createdAt ?? now - 3 * 60 * 60_000,
    live: options.live ?? true,
    hits,
    bestMatch: hits[0],
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
  }
}

function searchPage(query, sessions, hasMore = false, nextCursor) {
  const value = { query, sessions, hasMore }
  if (typeof nextCursor === 'string') value.nextCursor = nextCursor
  return remoteValue(value)
}

const RECENT_SESSIONS = [
  {
    sessionId: 'recent-1',
    title: 'Recent session',
    cwd: '/Users/joey/projects/alpha',
    createdAt: now - 2 * 60 * 60_000,
    live: false,
  },
  {
    sessionId: 'recent-2',
    title: null,
    cwd: '/Users/joey/projects/beta',
    createdAt: now - 3 * 60_000,
    live: true,
  },
]

recentResponder = () => remoteValue({ sessions: RECENT_SESSIONS })
searchResponder = () => searchPage('', [])

// ------------------------------------------------------ idle: recent sessions
let tree = await until((current) => findAllByClass(current, 'wss-recentRow').length === 2)

const recentCall = rpcCalls.find((call) => call.endpoint === 'workspaceSessionSearch/recent')
check(
  'mount loads recent sessions with the { args: { request } } envelope',
  Boolean(recentCall) &&
    recentCall.channel === '/api' &&
    recentCall.payload.args.request.limit === 20,
  JSON.stringify(recentCall && recentCall.payload),
)
check(
  'idle state renders the recent session list',
  normalizedText(tree).includes('Recent session') && normalizedText(tree).includes('未命名'),
  normalizedText(tree).slice(0, 160),
)
check(
  'panel renders the localized title and subtitle',
  normalizedText(tree).includes('会话搜索') && normalizedText(tree).includes('搜索所有工作区的会话'),
)
check(
  'search input is rendered with the localized placeholder and aria-label',
  Boolean(findInput(tree)) &&
    findInput(tree).props.placeholder === '搜索所有工作区会话中的消息…' &&
    findInput(tree).props['aria-label'] === '搜索所有工作区会话中的消息…',
)
check(
  'search form is a role="search" landmark with an aria-live status region',
  Boolean(findForm(tree)) && findForm(tree).props.role === 'search' && Boolean(findByAriaLive(tree, 'polite')),
)

const recentRow = findByClass(tree, 'wss-recentRow')
check('recent row is a button', Boolean(recentRow) && recentRow.type === 'button')
openedSessions.length = 0
recentRow.props.onClick()
check('clicking a recent row opens that session', openedSessions.length === 1 && openedSessions[0] === 'recent-1', JSON.stringify(openedSessions))

// ----------------------------------------------- search: envelope + grouping
const S1_HITS = [
  hit(12, 'user/message', 'Where is the session search panel?', 30),
  hit(13, 'assistant/message', 'The session search panel lives in the sidebar.', 29),
  hit(14, 'user/message', 'Great, search sessions by keyword now.', 28),
]
const S1 = group(
  's1',
  'Sidebar polish',
  '/Users/joey/projects/dsh-plugins/dsh-workspace-session-search',
  S1_HITS,
)

searchResponder = (payload) => {
  const request = payload.args.request
  if (request.query === 'session search') return searchPage(request.query, [S1])
  return searchPage(request.query, [])
}

tree = typeQuery(tree, 'session search')
tree = submitForm(tree)
tree = await until((current) => normalizedText(current).includes('3 条命中消息'))

const firstSearchCall = lastSearchCall()
const firstRequest = firstSearchCall && firstSearchCall.payload.args.request
check(
  'search RPC sends workspaceSessionSearch/search on /api',
  Boolean(firstSearchCall) &&
    firstSearchCall.channel === '/api' &&
    firstSearchCall.endpoint === 'workspaceSessionSearch/search',
  JSON.stringify(firstSearchCall && { channel: firstSearchCall.channel, endpoint: firstSearchCall.endpoint }),
)
check(
  'search request is wrapped as { args: { request } }',
  Boolean(firstSearchCall) &&
    Object.keys(firstSearchCall.payload).length === 1 &&
    firstSearchCall.payload.args !== undefined &&
    Object.keys(firstSearchCall.payload.args).length === 1 &&
    firstSearchCall.payload.args.request !== undefined,
  JSON.stringify(firstSearchCall && firstSearchCall.payload),
)
check(
  'search request trims and bounds the query',
  Boolean(firstRequest) &&
    firstRequest.query === 'session search' &&
    firstRequest.sessionLimit === 30 &&
    firstRequest.hitLimit === 5 &&
    !Object.prototype.hasOwnProperty.call(firstRequest, 'cursor'),
  JSON.stringify(firstRequest),
)
check(
  'one session with three hits renders one group with three hit rows',
  findAllByClass(tree, 'wss-group').length === 1 &&
    findAllByClass(findBySessionId(tree, 's1'), 'wss-hit').length === 3,
  'groups=' + findAllByClass(tree, 'wss-group').length + ' hits=' + findAllByClass(tree, 'wss-hit').length,
)
check(
  'group shows the session title, workspace basename and live badge',
  normalizedText(findBySessionId(tree, 's1')).includes('Sidebar polish') &&
    normalizedText(findBySessionId(tree, 's1')).includes('dsh-workspace-session-search') &&
    normalizedText(findBySessionId(tree, 's1')).includes('运行中'),
  normalizedText(findBySessionId(tree, 's1')).slice(0, 200),
)
check(
  'hits show both role badges',
  normalizedText(findBySessionId(tree, 's1')).includes('你') &&
    normalizedText(findBySessionId(tree, 's1')).includes('助手'),
)
check(
  'query terms are highlighted as <mark> (never HTML)',
  findAllByClass(findBySessionId(tree, 's1'), 'wss-mark').length >= 3,
  'marks=' + findAllByClass(findBySessionId(tree, 's1'), 'wss-mark').length,
)
check(
  'result summary is formatted from the i18n template',
  normalizedText(tree).includes('1 个会话 · 3 条命中消息'),
  normalizedText(tree).slice(0, 200),
)

const iconLabels = findButtons(tree)
  .map((button) => button.props['aria-label'])
  .filter((label) => typeof label === 'string')
check(
  'search and clear icon buttons expose aria-labels',
  iconLabels.includes('搜索') && iconLabels.includes('清空搜索'),
  JSON.stringify(iconLabels),
)

// Enter must cancel the pending 300 ms debounce: no duplicate request.
await wait(360)
tree = flushRender()
check(
  'Enter submits once and cancels the debounce timer',
  searchCallsFor('session search').length === 1,
  'calls=' + searchCallsFor('session search').length,
)

// ------------------------------------------------------------ zh/en switching
language = 'en'
tree = flushRender()
check(
  'English labels switch with the locale snapshot',
  normalizedText(tree).includes('Session search') &&
    normalizedText(tree).includes('You') &&
    normalizedText(tree).includes('Assistant') &&
    normalizedText(tree).includes('3 matching turns'),
  normalizedText(tree).slice(0, 200),
)
check('sidebar label follows the language', sidebarRegistration.options.label() === 'Session search')
language = 'zh'
tree = flushRender()
check('switching back restores Chinese labels', normalizedText(tree).includes('你') && normalizedText(tree).includes('助手'))

// ------------------------------------------------------ load more merge
const MORE_HITS = [
  hit(21, 'user/message', 'first more hit', 10),
  hit(22, 'assistant/message', 'second more hit', 9),
  hit(23, 'user/message', 'third more hit', 8),
]
const MORE_S1 = group('s1', 'Sidebar polish', '/Users/joey/projects/dsh-plugins/dsh-workspace-session-search', MORE_HITS)
const MORE_S2 = group('s2', 'Second session', '/Users/joey/projects/other', [hit(31, 'user/message', 'another session hit', 5)], {
  live: false,
})
searchResponder = (payload) => {
  const request = payload.args.request
  if (request.query !== 'more') return searchPage(request.query, [])
  if (request.cursor === undefined) {
    return searchPage(request.query, [{ ...MORE_S1, hits: MORE_HITS.slice(0, 2) }], true, 'cursor-1')
  }
  if (request.cursor === 'cursor-1') {
    return searchPage(request.query, [{ ...MORE_S1, hits: [MORE_HITS[2]] }, MORE_S2])
  }
  return searchPage(request.query, [])
}

tree = typeQuery(tree, 'more')
tree = submitForm(tree)
tree = await until((current) => normalizedText(current).includes('1 个会话 · 2 条命中消息'))
const moreButton = findByClass(tree, 'wss-moreButton')
check('hasMore renders the load-more button', Boolean(moreButton) && normalizedText(moreButton) === '加载更多')

moreButton.props.onClick()
tree = await until((current) => normalizedText(current).includes('2 个会话 · 4 条命中消息'))

const moreCalls = searchCallsFor('more')
check(
  'load more reuses the query with nextCursor',
  moreCalls.length === 2 && moreCalls[1].payload.args.request.cursor === 'cursor-1',
  JSON.stringify(moreCalls.map((call) => call.payload.args.request)),
)
const mergedGroups = findAllByClass(tree, 'wss-group')
check(
  'new page merges the duplicate session instead of duplicating the group',
  mergedGroups.length === 2 &&
    mergedGroups.map((item) => item.props['data-session-id']).join(',') === 's1,s2',
  JSON.stringify(mergedGroups.map((item) => item.props['data-session-id'])),
)
check(
  'merged group keeps all three hits for the repeated session',
  findAllByClass(findBySessionId(tree, 's1'), 'wss-hit').length === 3,
  'hits=' + findAllByClass(findBySessionId(tree, 's1'), 'wss-hit').length,
)
check(
  'the new session from the second page is rendered',
  Boolean(findBySessionId(tree, 's2')) && normalizedText(tree).includes('Second session'),
)

// ------------------------------------------------------------- click to open
openedSessions.length = 0
const hitButtons = findButtons(findBySessionId(tree, 's1')).filter((button) => hasClass(button, 'wss-hit'))
hitButtons[0].props.onClick()
check('clicking a hit opens its session', openedSessions.length === 1 && openedSessions[0] === 's1', JSON.stringify(openedSessions))

openedSessions.length = 0
const groupHead = findByClass(findBySessionId(tree, 's2'), 'wss-groupHead')
groupHead.props.onClick()
check('clicking a group header opens its session', openedSessions.length === 1 && openedSessions[0] === 's2')

// ------------------------------------------------------------ error + retry
searchResponder = (payload) => {
  const request = payload.args.request
  if (request.query === 'broken') return remoteFailure('gateway/internal', 'gateway exploded')
  return searchPage(request.query, [])
}

tree = typeQuery(tree, 'broken')
tree = submitForm(tree)
tree = await until((current) => Boolean(findByClass(current, 'wss-retry')))

check(
  'error state shows the localized error and the host message',
  normalizedText(tree).includes('搜索失败') && normalizedText(tree).includes('gateway exploded'),
  normalizedText(tree).slice(0, 200),
)
check('error state renders a retry button', Boolean(findByClass(tree, 'wss-retry')))

const retryHit = hit(41, 'user/message', 'recovered result', 1)
searchResponder = (payload) => {
  const request = payload.args.request
  if (request.query === 'broken') {
    return searchPage(request.query, [group('s3', 'Recovered session', '/Users/joey/projects/recovered', [retryHit])])
  }
  return searchPage(request.query, [])
}
findByClass(tree, 'wss-retry').props.onClick()
tree = await until((current) => normalizedText(current).includes('Recovered session'))

check(
  'retry re-runs the same query and renders results',
  searchCallsFor('broken').length === 2 && normalizedText(tree).includes('recovered result'),
  'calls=' + searchCallsFor('broken').length,
)

// --------------------------------------------- disabled-index error mapping
searchResponder = (payload) => {
  const request = payload.args.request
  if (request.query === 'disabled') return remoteFailure('SESSION_QUERY_SEARCH_DISABLED', 'index off')
  return searchPage(request.query, [])
}
tree = typeQuery(tree, 'disabled')
tree = submitForm(tree)
tree = await until((current) => normalizedText(current).includes('全文索引'))

check(
  'SESSION_QUERY_SEARCH_DISABLED maps to the localized disabled explanation',
  normalizedText(tree).includes('全文会话索引处于关闭状态'),
  normalizedText(tree).slice(0, 200),
)

// ---------------------------------------------------------------- debounce
searchResponder = (payload) => searchPage(payload.args.request.query, [])
tree = typeQuery(tree, 'debounced')
await wait(150)
check('debounce does not search before 300 ms', searchCallsFor('debounced').length === 0)
await wait(260)
tree = flushRender()
check('debounce searches after 300 ms without Enter', searchCallsFor('debounced').length === 1)
tree = await until((current) => normalizedText(current).includes('没有匹配该关键词的会话。'))
check('empty result renders the empty state', normalizedText(tree).includes('没有匹配该关键词的会话。'))

// ----------------------------------------------------- abort / stale guard
let resolveSlow = null
searchResponder = (payload) => {
  const request = payload.args.request
  if (request.query === 'slow') {
    return new Promise((resolveSlowPromise) => {
      resolveSlow = () =>
        resolveSlowPromise(
          searchPage('slow', [
            group('slow-session', 'Slow result', '/Users/joey/projects/slow', [hit(51, 'user/message', 'slow payload', 2)]),
          ]),
        )
    })
  }
  if (request.query === 'fast') {
    return searchPage('fast', [
      group('fast-session', 'Fast result', '/Users/joey/projects/fast', [hit(61, 'user/message', 'fast payload', 1)]),
    ])
  }
  return searchPage(request.query, [])
}

tree = typeQuery(tree, 'slow')
tree = submitForm(tree)
tree = typeQuery(tree, 'fast')
tree = submitForm(tree)
tree = await until((current) => normalizedText(current).includes('Fast result'))

const slowCall = searchCallsFor('slow')[0]
const fastCall = searchCallsFor('fast')[0]
check(
  'a new query aborts the previous in-flight request',
  Boolean(slowCall) && Boolean(slowCall.signal) && slowCall.signal.aborted === true,
)
check('the newest query renders first', normalizedText(tree).includes('Fast result'))

if (typeof resolveSlow === 'function') resolveSlow()
await wait(80)
tree = flushRender()
check(
  'stale resolution is ignored (no flicker back to the old query)',
  normalizedText(tree).includes('Fast result') && !normalizedText(tree).includes('Slow result'),
  normalizedText(tree).slice(0, 200),
)

// ---------------------------------------------------------------- summary
if (failures.length) {
  console.error('\nHARNESS FAILED: ' + failures.length + ' of ' + checkCount + ' checks failed')
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log('\nALL ' + checkCount + ' CLIENT HARNESS CHECKS PASSED')
