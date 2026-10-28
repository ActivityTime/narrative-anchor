/**
 * request-audit — NA 结算请求体审计（2026-10-09 / v2.4）
 *
 * 需求背景：NA 结算走 DSH `agents` 子 Agent（sessionId=na-background-<gameId>），
 * 其 LLM 请求不经 tavern `modelRequestLog`，前端"完整上下文"面板看不到请求体。
 *
 * 方案（v2.4，按 DSHT modelRequestLog 结构落地）：
 *  - 挂 DSH `llm/stream` waterfall（第一个参数 options 即完整请求体 GenerateOptions，
 *    含 messages/system/tools），按 sessionId 前缀过滤 na-background-*；
 *  - 保留 v2.3 行为：JSONL 落盘 + 内存环形缓冲（供 /api/narrative-anchor/requestLog 查询）；
 *  - 新增 DSHT 兼容写入：把请求体构造成 tavern `model-request-log.js` 的存储结构
 *    （`model-requests/<chatId>/<requestId>.json` + `index.json` +
 *     `model-request-sessions/<sessionId>.json` 的 chatId 映射），
 *    使 tavern 的 `getLatestRequestContext({ sessionId: 'na-background-…' })`
 *    能命中并返回完整请求体，"完整上下文"面板可展示。
 *  - turn 由 replaceSettlement 包装注入（setTurn(gameId, turn)），options 本身不带轮次。
 * 只读不改，不影响瀑布链与结算主流程；所有写失败仅 console.error，不阻断。
 *
 * 退役条件（2026-10-10 记录）：官方 dsh-tavern main 已含 `67a4048c`——插件用 DSH agents
 * 建子 Agent 时只要 `meta.parentSession = gameId`，请求即自动记入该局请求记录（"完整上下文"
 * 可见，保留最近 30 轮）。当前本地运行时为固定版本（2.5.0 基础，未含该提交），
 * 本兼容层**必须保留**；待升级到含 67a4048c 的版本后再移除本文件与其注册点
 * （届时 NA 的 agents.create 已设 parentSession=gameId，官方记录自动生效）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolveTavernDataRoot, setTavernDataRoot, pluginLogDir, appendRotatingLog } from '../paths.js'

const MAX_BUFFER = 200 // 内存缓冲条数上限（含启动时从 JSONL 加载的历史）
const SETTLE_PREFIX = 'na-background-' // v2.x 自建 agents 的旧前缀（历史记录兼容）
const BG_PREFIX = 'background-' // v3.0 官方 replaceSettlement 的后台会话前缀
// v3.6（2026-10-24）：舞台导演拦截哨兵 provider——installStageDirectorBlocker 命中时把
// options.provider 设为该值，请求在路由阶段失败（不触达模型）；本审计钩子据此跳过重复记录。
export const STAGE_DIRECTOR_BLOCKED_PROVIDER = '舞台导演请求已拦截（narrative-anchor）'
const SAME_REQUEST_WINDOW = 5000 // 前台同一请求多次投影（tavern 模板递归重建）的合并窗口 ms
const KEEP_TURNS = 30 // 与 tavern MODEL_REQUEST_KEEP_TURNS 对齐：只保留最近 N 轮请求体
const HISTORY_LOAD_COUNT = 100 // 启动时从 JSONL 加载的历史条目数

// v3.0：官方 replaceSettlement 后台结算的 sessionId 由 DSHT agents 管理（background- 前缀），
// 用 AsyncLocalStorage 在 settle 调用链内标记「当前是 NA 后台结算」，llm/stream 钩子据此捕获请求体。
const bgStore = new AsyncLocalStorage()

/** 提取最后一条 user 消息文本作为请求指纹（模板重建版的本轮输入应相同；独立请求输入不同）。 */
function lastUserText(messages) {
  const arr = Array.isArray(messages) ? messages : []
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i]
    if (!m || m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c.slice(0, 200)
    if (Array.isArray(c)) {
      const t = c.map((b) => (b && (b.text || b.content)) || '').join('')
      if (t) return t.slice(0, 200)
    }
  }
  return ''
}

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

/** 根据 sessionId 前缀、purpose 和 bgStore 判定请求类型（前端分组依据）。 */
function kindOf(sessionId, options) {
  const sid = str(sessionId)
  const purpose = options && options.purpose
  if (purpose === 'compaction') return 'compaction'
  if (purpose === 'candidate') return 'candidate'
  if (!!bgStore.getStore() || sid.startsWith(SETTLE_PREFIX) || sid.startsWith(BG_PREFIX)) return 'settlement'
  return 'body'
}

/** 用户数据根：优先插件配置，其次结构发现（launcher-settings.xml 的 DataDirectory）。
 *  不再 fallback 到 <homedir>/.dsh —— 该目录在本机并不存在，旧 fallback 恒失效，
 *  正是它逼出了原来那行硬编码的日志目录。无可用数据根时返回 ''，由调用方降级。 */
function resolveDataRoot(config) {
  if (config && config.tavernDataRoot) setTavernDataRoot(config.tavernDataRoot)
  return resolveTavernDataRoot() || ''
}

/** 与 tavern serializableRequest 一致：保留 prompt/tool 证据原文，脱敏传输/配置元数据。 */
function redactRequestMetadata(value) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactRequestMetadata)
  if (typeof value.entries === 'function' && typeof value.get === 'function') value = Object.fromEntries(value.entries())
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(authorization|proxy-authorization|cookie|set-cookie|.*api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)$/i.test(key) ? '[REDACTED]' : redactRequestMetadata(item)]))
}

function serializableRequest(options) {
  const result = {}
  for (const [key, value] of Object.entries(options || {})) {
    if (key === 'signal') continue
    result[key] = ['messages', 'tools', 'system'].includes(key) ? value : redactRequestMetadata({ [key]: value })[key]
  }
  return JSON.parse(JSON.stringify(result))
}

async function readJsonSafe(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return undefined }
}

export function installRequestAudit(ctx, config = {}) {
  const buffer = []
  const dataRoot = resolveDataRoot(config)
  // 日志目录 = 插件自持数据目录下的 logs（走 pluginLogDir，不依赖 DataDir 探测，避免撞系统桌面）
  const logDir = config.logDir || pluginLogDir()
  const logFile = logDir ? join(logDir, 'na-request-log.jsonl') : ''

  // gameId → { turn, step }（由 replaceSettlement 包装注入 turn；options 本身不含轮次）
  const stateByGame = new Map()
  // na-session → chatId（内存缓存 + 落盘 model-request-sessions/<sessionId>.json）
  const ownerBySession = new Map()
  // sessionId → chatId（tavern sessions.json 缓存）
  let sessionLinks = undefined
  // 每 chatId 串行写队列（与 tavern modelRequestLog 同思路：写不阻塞请求路径）
  const writeQueues = new Map()

  function enqueue(chatId, task) {
    const next = (writeQueues.get(chatId) || Promise.resolve()).then(task)
    const settled = next.catch((e) => console.error('[narrative-anchor] DSHT request-log write failed:', str(e && e.message || e)))
    writeQueues.set(chatId, settled)
    settled.then(() => { if (writeQueues.get(chatId) === settled) writeQueues.delete(chatId) })
    return next
  }

  function setTurn(gameId, turn) {
    if (!gameId) return
    const key = str(gameId)
    const nextTurn = Math.max(0, Number(turn) || 0)
    const prev = stateByGame.get(key)
    stateByGame.set(key, { turn: nextTurn, step: prev && prev.turn === nextTurn ? (prev.step || 1) + 1 : 1 })
  }

  function stateOf(sessionId) {
    // v3.0：优先从 bgStore 取 gameId（官方结算 sessionId 带 background- 前缀，不含 gameId）；
    // 兼容旧版：sessionId 带 na-background- 前缀时剥离后查 stateByGame。
    const bg = bgStore.getStore()
    if (bg && bg.gameId) return stateByGame.get(str(bg.gameId)) || { turn: 0, step: 1 }
    const sid = str(sessionId)
    if (sid.startsWith(SETTLE_PREFIX)) return stateByGame.get(sid.slice(SETTLE_PREFIX.length)) || { turn: 0, step: 1 }
    return { turn: 0, step: 1 }
  }

  /** v3.0：在 NA 后台结算调用链内运行 fn，使 llm/stream 钩子能识别并记录请求体。 */
  function runBackground(gameId, turn, fn) {
    return bgStore.run({ gameId: str(gameId), turn: Number(turn) || 0 }, fn)
  }

  /** 构造并写入 tavern modelRequestLog 兼容结构；失败不阻断请求链。
   *  前台（无 na-background- 前缀）：mainSession = sessionId 本身；
   *  turn 从 tavern model-requests/<chatId>/index.json 推断最新轮（与 tavern
   *  model-stream.js 对无 turn 请求的归类一致）。 */
  async function writeTavernLog(entry) {
    // sessionId = na-background-<gameId>（后台）→ 主会话 = 前缀之后；
    // 前台 sessionId（session-…）即主会话本身
    const mainSession = entry.sessionId.startsWith(SETTLE_PREFIX)
      ? entry.sessionId.slice(SETTLE_PREFIX.length) : entry.sessionId
    if (sessionLinks === undefined) sessionLinks = (await readJsonSafe(join(dataRoot, 'sessions.json'))) || {}
    const chatId = sessionLinks && sessionLinks[mainSession]
    if (!chatId) {
      console.error('[narrative-anchor] tavern request-log: 找不到主会话映射', { mainSession })
      return
    }
    let st = entry.state || { turn: 0, step: 1 }
    if (!Number.isSafeInteger(Number(st.turn)) || Number(st.turn) <= 0) {
      const index = await readJsonSafe(join(dataRoot, 'model-requests', chatId, 'index.json'))
      const turns = Array.isArray(index && index.requests) ? index.requests.map((r) => Number(r && r.turn) || 0) : []
      st = { turn: turns.length ? Math.max(...turns) : 0, step: 1 }
    }
    const requestId = Date.now().toString(36) + '-' + randomUUID()
    const turn = st.turn
    const record = {
      version: 2,
      id: requestId,
      chatId,
      scope: 'background',
      task: 'narrative-anchor',
      sessionId: entry.sessionId,
      turn,
      agentTurn: turn,
      step: st.step,
      createdAt: entry.ts,
      status: 'running',
      requestMode: 'dsh',
      compatibility: null,
      frame: null,
      bypassPlan: { id: '', name: '', digest: '' },
      request: entry.requestBody,
    }
    enqueue(chatId, async () => {
      const dir = join(dataRoot, 'model-requests', chatId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, requestId + '.json'), JSON.stringify(record), 'utf8')
      // sessionId → chatId 归属（latestForSession 第一步读它）
      if (ownerBySession.get(entry.sessionId) !== chatId) {
        ownerBySession.set(entry.sessionId, chatId)
        await writeFile(
          join(dataRoot, 'model-request-sessions', encodeURIComponent(entry.sessionId) + '.json'),
          JSON.stringify({ chatId }, null, 2) + '\n', 'utf8')
      }
      // index.json：追加条目 + 裁剪超出保留窗口的旧请求体
      const index = (await readJsonSafe(join(dir, 'index.json'))) || { version: 1, chatId, requests: [] }
      const requests = Array.isArray(index.requests) ? index.requests : []
      const pruned = []
      const cutoff = turn - KEEP_TURNS
      for (const item of requests) {
        const t = Number(item && item.turn)
        if (item && item.pruned) continue
        if (cutoff >= 1 && Number.isSafeInteger(t) && t > 0 && t <= cutoff) pruned.push(item.id)
      }
      requests.push({ id: requestId, scope: 'background', task: 'narrative-anchor', sessionId: entry.sessionId, turn, agentTurn: turn, step: st.step, createdAt: entry.ts })
      const next = requests.filter((item) => !(pruned.includes(item.id)))
      await writeFile(join(dir, 'index.json'), JSON.stringify({ version: 1, chatId, requests: next }, null, 2) + '\n', 'utf8')
      for (const id of pruned) { try { await import('node:fs/promises').then(({ rm }) => rm(join(dir, id + '.json'), { force: true })) } catch { /* 忽略清理失败 */ } }
    })
  }

  const record = async (sessionId, options, opts = {}) => {
    const entry = {
      ts: Date.now(),
      sessionId,
      kind: opts.kind || kindOf(sessionId, options), // body / settlement / compaction / candidate
      blocked: opts.blocked === true, // true=被拦截（后台压缩投毒后未到达模型）
      blockedProvider: opts.blockedProvider, // 拦截时的投毒 provider（仅 blocked 时）
      provider: options.provider,
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      purpose: options.purpose,
      messages: Array.isArray(options.messages) ? options.messages : [],
      system: options.system,
      tools: Array.isArray(options.tools) ? options.tools : [],
      requestBody: serializableRequest(options),
      state: stateOf(sessionId),
      charCount: 0,
    }
    try {
      entry.charCount = entry.messages.reduce((n, m) => n + JSON.stringify(m).length, 0)
    } catch { /* 序列化失败不阻断 */ }
    const now = entry.ts
    let replaced = false
    if (entry.kind === 'body') {
      // 前台正文：tavern 模板递归会重建 messages 并再次经过 llm/stream（同一请求多次投影）。
      // 仅当「本轮用户输入指纹」相同才视为同一请求的多次投影并合并（保留最后一次=最终发送版）；
      // 单轮多步的独立请求（世界书主动搜索、历史召回等）输入不同，不会被误合并。
      const fingerprint = lastUserText(entry.messages)
      for (let i = buffer.length - 1; i >= 0; i--) {
        const prev = buffer[i]
        if (!prev || prev.sessionId !== sessionId || now - prev.ts >= SAME_REQUEST_WINDOW) break
        if (fingerprint && lastUserText(prev.messages) === fingerprint) {
          buffer[i] = entry
          replaced = true
        }
        break
      }
    }
    if (!replaced) buffer.push(entry)
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    try {
      if (!logFile) return // 无解析结果：只留内存缓冲，不落盘（静默跳过，不刷错误）
      await mkdir(logDir, { recursive: true })
      // 请求体审计体量最大（实测曾达 166MB）→ 上限 50MB，留 3 份
      await appendRotatingLog(logFile, JSON.stringify({ ...entry, requestBody: undefined }) + '\n', 'utf8', { maxBytes: 50 * 1024 * 1024, keep: 3 })
    } catch (e) {
      console.error('[narrative-anchor] request audit write failed:', e && e.message || e)
    }
    if (opts.tavernCompat !== false) void writeTavernLog(entry) // 异步写 DSHT 结构，不阻塞流
  }

  // 启动时从 JSONL 异步加载最近 HISTORY_LOAD_COUNT 条历史到内存缓冲（重启不清空）。
  // 不阻塞 install 返回；JSONL 落盘时 requestBody 被置 undefined（体积控制），但 messages/system/tools 完整。
  ;(logFile ? readFile(logFile, 'utf8') : Promise.resolve('')).then(raw => {
    const lines = raw.split('\n').filter(Boolean)
    const recent = lines.slice(-HISTORY_LOAD_COUNT)
    let loaded = 0
    for (const line of recent) {
      try {
        const entry = JSON.parse(line)
        if (entry && entry.ts && entry.sessionId) { buffer.push(entry); loaded++ }
      } catch { /* 跳过损坏行 */ }
    }
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
    console.log('[narrative-anchor] request audit: loaded', loaded, 'historical entries from JSONL')
  }).catch(e => {
    console.log('[narrative-anchor] request audit: no historical JSONL loaded:', str(e && e.message || e))
  })

  // 统一审计 waterfall：记录所有非压缩请求（压缩请求由 official-v2.js 专门记录，含 blocked 逻辑）。
  // kind 由 kindOf() 判定：body / settlement / candidate / compaction。
  ctx.on('llm/stream', function (options, next) {
    try {
      const sid = str(options && options.sessionId)
      if (!sid) return next(options)
      const purpose = options && options.purpose
      if (purpose === 'compaction') return next(options) // 压缩请求由 official-v2.js 记录（含 blocked 标记）
      if (options && options.provider === STAGE_DIRECTOR_BLOCKED_PROVIDER) return next(options) // 舞台导演拦截：由安装方单独记录 blocked
      void record(sid, options, { kind: kindOf(sid, options), tavernCompat: false })
    } catch (e) {
      console.error('[narrative-anchor] request audit hook failed:', e && e.message || e)
    }
    return next(options)
  }, { global: true })

  return {
    list(limit = 20) { return buffer.slice(-Math.max(1, Math.min(limit, MAX_BUFFER))) },
    path() { return logFile },
    setTurn,
    record,
    runBackground,
  }
}
