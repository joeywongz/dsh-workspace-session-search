/** Locale dictionaries and helper lookups for the panel. */

import type { ClientContext } from './types'

export const NS = 'dshWorkspaceSessionSearch'

export type Dict = Record<string, string>

export const pageDicts: { en: Dict; zh: Dict } = {
  en: {
    'panel.label': 'Session search',
    'panel.title': 'Session search',
    'panel.subtitle': 'Search every workspace session and the multi-turn conversation inside it.',
    'search.placeholder': 'Search messages across all workspace sessions…',
    'search.clear': 'Clear search',
    'search.submit': 'Search',
    'search.idle': 'Type a query to search every workspace session.',
    'search.loading': 'Searching workspace sessions…',
    'search.empty': 'No session matched the query.',
    'search.error': 'Search failed.',
    'search.retry': 'Retry',
    'search.hint': 'Press Enter to search. Results are grouped by session with every matching turn.',
    'search.resultCount': '{sessions} sessions · {hits} matching turns',
    'search.results': 'Search results',
    'search.more': 'Load more',
    'search.loadingMore': 'Loading…',
    'recent.title': 'Recent workspace sessions',
    'recent.loading': 'Loading recent sessions…',
    'recent.empty': 'No workspace session yet.',
    'recent.error': 'Could not load recent sessions.',
    'hit.you': 'You',
    'hit.assistant': 'Assistant',
    'hit.turn': 'Turn {turn}',
    'session.untitled': 'Untitled',
    'session.workspace': 'Workspace',
    'session.open': 'Open session',
    'session.live': 'Live',
    'session.cold': 'On disk',
    'session.hits': '{count} matching turns',
    'time.justNow': 'just now',
    'time.minutesAgo': '{count}m ago',
    'time.hoursAgo': '{count}h ago',
    'time.daysAgo': '{count}d ago',
    'error.unavailable': 'Session search is not available on this host. Restart DeepSeek Harness after installing the plugin.',
    'error.disabled': 'The full-text session index is disabled on this host.',
  },
  zh: {
    'panel.label': '会话搜索',
    'panel.title': '会话搜索',
    'panel.subtitle': '搜索所有工作区的会话，以及每个会话里的多轮对话内容。',
    'search.placeholder': '搜索所有工作区会话中的消息…',
    'search.clear': '清空搜索',
    'search.submit': '搜索',
    'search.idle': '输入关键词，搜索所有工作区的历史会话。',
    'search.loading': '正在搜索工作区会话…',
    'search.empty': '没有匹配该关键词的会话。',
    'search.error': '搜索失败。',
    'search.retry': '重试',
    'search.hint': '回车开始搜索。结果按会话分组，并列出每条命中的消息。',
    'search.resultCount': '{sessions} 个会话 · {hits} 条命中消息',
    'search.results': '搜索结果',
    'search.more': '加载更多',
    'search.loadingMore': '加载中…',
    'recent.title': '最近的工作区会话',
    'recent.loading': '正在读取最近会话…',
    'recent.empty': '还没有工作区会话。',
    'recent.error': '最近会话读取失败。',
    'hit.you': '你',
    'hit.assistant': '助手',
    'hit.turn': '第 {turn} 轮',
    'session.untitled': '未命名',
    'session.workspace': '工作区',
    'session.open': '打开会话',
    'session.live': '运行中',
    'session.cold': '磁盘',
    'session.hits': '{count} 条命中消息',
    'time.justNow': '刚刚',
    'time.minutesAgo': '{count} 分钟前',
    'time.hoursAgo': '{count} 小时前',
    'time.daysAgo': '{count} 天前',
    'error.unavailable': '当前宿主暂不可用：安装插件后请完全退出并重新打开 DeepSeek Harness。',
    'error.disabled': '当前宿主的全文会话索引处于关闭状态。',
  },
}

export function lookup(language: string, key: string, dicts: { en: Dict; zh: Dict } = pageDicts): string {
  const dict = language.toLowerCase().startsWith('zh') ? dicts.zh : dicts.en
  const fallback = dicts.en
  return dict[key] ?? fallback[key] ?? key
}

/** Read the active UI language without assuming one locale-service shape. */
export function currentLanguage(ctx: ClientContext): string {
  try {
    const snapshot = ctx.locale?.getSnapshot?.()
    if (snapshot && typeof snapshot.language === 'string' && snapshot.language !== '') return snapshot.language
  } catch {
    /* fall through */
  }
  try {
    const documentLanguage = typeof document !== 'undefined' ? document.documentElement.lang : ''
    if (documentLanguage) return documentLanguage
  } catch {
    /* fall through */
  }
  return 'en'
}

/** Interpolate `{name}` placeholders in a localized string. */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  )
}
