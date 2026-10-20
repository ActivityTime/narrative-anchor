/**
 * Narrative Anchor System - DSH-Tavern Plugin
 *
 * v3.0（补丁全移除 · 官方 plugin-api v2 原生）
 * 世界书条目：tavern.worldbookEntries（条目池，官方召回/后台结算/候选全路径）
 * 结算：非 MVU → replaceSettlement；MVU → settlementTool（read/submit）
 * 前台注入：llm/stream 中间件（foreground section / 记忆投影 / 常量条目前缀）
 * 分组：tavernUi.registerStartGroup
 *
 * 数据存储：chat.narrativeAnchor + 插件自持文件（data/anchors、data/session-worldbooks）
 *
 * 依赖：官方 plugin-api v2（worldbookEntries 消费链需运行时升级到官方 main）
 */

import { readAnchor, writeAnchor, readSnapshotLog, writeSnapshotLog, readGlobalSettings, writeGlobalSettings } from './data-store.js'
import { str } from './settlement/mvu-audit.js'
import { formatLtmTree, getAnchorStats, updateLtmSnapshot } from './settlement/store.js'
import { createOfficialSettlement, SETTLE_PERSONA, DEFAULT_TASK_PROMPT, DEFAULT_BACKEND_SETTLE_PROTOCOL, installNaTavernStateFilter } from './settlement/official-v2.js'
import { installRequestAudit } from './settlement/request-audit.js'
import { NARRATIVE_ANCHOR_READ_TOOL, NARRATIVE_ANCHOR_SUBMIT_TOOL, searchAnchorMemory } from './settlement/strategies.js'
import Schema from '@deepseek-ai/schemastery'
import {
  readSessionWorldbook, loadSessionWorldbook, writeSessionWorldbook, effectiveBoundBooks, sourceSig,
  listSessionWorldbooks, selectedEntries, toWorldbookEntries, autoImportFromAnchor,
  boundWorldbookEntries, readBoundWorldbookDocument, writeBoundWorldbookDocument, updateBoundEntry,
  syncSidelineEntries, removeSidelineEntries, importWorldbookEntries
} from './session-worldbook.js'
import { loadPersonas, savePersona, deletePersona, applyPersona, unapplyPersona, createManualEntry } from './persona.js'
import { loadQuickInputs, saveQuickInput, deleteQuickInput } from './quick-inputs.js'
import { listCombos, createCombo, updateCombo, deleteCombo, listGlobalAutoBind, setGlobalAutoBind, toggleGlobalAutoBind } from './worldbook-combos.js'
import { readOfficialWorldbooks, readRecallAudit, readRecallHistory, readChatFromDisk, readLatestChatFromDisk, readLatestReplyContext, entryPresentInContext, updateOfficialEntry } from './official-worldbook.js'
import { resolveTavernDataRoot, setTavernDataRoot, pluginRoot, pluginDataDir, installDataDir, desktopLogFile, appendRotatingLogSync } from './paths.js'
import { setFamilyDataRoot, resolveFamilyId, registerBranch, familyMembers, rootOf, readRegistry, unregisterBranch, sessionAlive, sessionTitle, deleteFamilyFile, clearFamilyCaches } from './family.js'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'narrative-anchor'

// v3.0：补丁全部移除——不再依赖 tavernExtensionPoints（世界书条目走官方 worldbookEntries；
// 结算走 replaceSettlement/settlementTool；前台注入走 llm/stream 中间件；分组走 registerStartGroup）
export const inject = ['tools', 'webServer', 'tavern', 'llm']

// v3.6：DSHT 0.2.x 把插件自建条目的召回 ref 改成命名空间格式 `plugin:narrative-anchor/session/eanchor-XXX`。
// 插件经 tavern.worldbookEntries 注册时 entry id = safeId('e' + 本地 anchorId)（见下方注册处），
// 原生 ref 里的 `eanchor-XXX` 即 'e' + 本地 anchorId。这里去掉命名空间前缀 + 前导 'e'，
// 归一化回 `session-wb:<anchorId>`，使 inCtx 去重比对能对齐本地 book.entries.id
// （与前端 client.js 的 normalizeRef 保持同一逻辑）。
const NA_SESSION_REF_NS = 'plugin:narrative-anchor/session/'
const normalizeRef = (r) => {
  const s = String(r || '')
  if (s.startsWith(NA_SESSION_REF_NS)) {
    const inner = s.slice(NA_SESSION_REF_NS.length)
    const anchorId = inner.startsWith('e') ? inner.slice(1) : inner
    return 'session-wb:' + anchorId
  }
  return s
}

// 可调配置必须是 Schemastery Schema，禁止普通对象
export const Config = Schema.object({
  maxSTMLength: Schema.number().default(7).description('STM 短期记忆上限（轮次条数），达到后筛选生成 LTM 关键信息'),
  sectionName: Schema.string().default('narrative-anchor').description('foreground-frame section 标识（调试用）'),
  injectPosition: Schema.string().default('before-rules').description('foreground-frame 注入位置'),
  debug: Schema.boolean().default(false).description('是否输出调试日志'),
  tavernDataRoot: Schema.string().default('').description('DSH 用户数据根目录（留空自动推导：DSHT 安装根 launcher-settings.xml 的 DataDirectory / 目录结构发现）')
})

// ========== 数据存储 ==========

function loadAnchor(chat) {
  if (!chat.narrativeAnchor || typeof chat.narrativeAnchor !== 'object') {
    chat.narrativeAnchor = {
      plot_route: { current_node: '', recap: '', next_scene: '', foreshadowing: [] },
      current_state: { time: '', world: '', location: '', characters: [], environment: [], items: [], focus: '', focus_full: '' },
      free_slots: { list: [] },
      memory: { stm: [], ltm: [], ltm_tree: { nodes: {}, roots: [], next_id: 1 }, ltm_snapshot: { content: '', turn: 0 }, known_facts: [], foreshadow_library: [] },
      meta: { turn_count: 0, created_at: Date.now(), settings: {} }
    }
  }
  return chat.narrativeAnchor
}

function updateAnchor(chat, mutator) {
  const anchor = loadAnchor(chat)
  mutator(anchor)
  anchor.meta.updated_at = Date.now()
}

// ========== 格式化 ==========

function formatAnchorForInjection(anchor) {
  // v0.9.1：null 防护 —— 首轮无锚点时 fileAnchor 与 chat.narrativeAnchor 皆为 null，
  // 直接访问 .current_state 会抛 TypeError 并被扩展点 try/catch 吞掉，导致前台 section 永久缺失。
  if (!anchor || typeof anchor !== 'object') return ''
  const sections = []

  const cs = anchor.current_state || {}
  const csParts = []
  if (cs.time) csParts.push(`时间: ${cs.time}`)
  if (cs.world) csParts.push(`世界: ${cs.world}`)
  if (cs.location) csParts.push(`地点: ${cs.location}`)
  if (Array.isArray(cs.characters) && cs.characters.length > 0) csParts.push(`在场人物: ${cs.characters.join(', ')}`)
  if (cs.environment) csParts.push('环境: ' + (Array.isArray(cs.environment) ? cs.environment.join('、') : cs.environment))
  if (Array.isArray(cs.items) && cs.items.length > 0) csParts.push(`物品: ${cs.items.join(', ')}`)
  if (cs.focus) csParts.push(`叙事备忘: ${cs.focus}`)
  if (csParts.length > 0) sections.push('【当前状态】\n' + csParts.join('\n'))

  // 自由栏位（v0.10.4）：仅列表。元素 { display, injectForeground, injectInput, injectBack }。
  // 注入前台 = 勾选「注入前台」且未勾选「注入输入框」的元素（勾选注入输入框的内容已随用户
  // 消息进入模型，避免双重注入）；空则不注入。
  const fs = anchor.free_slots || {}
  const fsSegs = []
  if (Array.isArray(fs.list)) {
    fs.list.forEach((item, i) => {
      if (item && item.injectForeground === true && item.injectInput !== true && String(item.display || '').trim()) {
        fsSegs.push('【自由栏位-列表#' + i + '】\n' + String(item.display).trim())
      }
    })
  }
  if (fsSegs.length > 0) sections.push('【自由栏位】\n' + fsSegs.join('\n\n'))

  // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
  // const pr = anchor.plot_route || {}
  // const prParts = []
  // if (pr.current_node) prParts.push(`当前节点: ${pr.current_node}`)
  // if (pr.recap) prParts.push(`前情衔接: ${pr.recap}`)
  // if (pr.next_scene) prParts.push(`下一幕规划: ${pr.next_scene}`)
  // // [2026-09-29 暂停] 活跃伏笔暂时不单独维护，伏笔信息自然流入STM
  // // if (Array.isArray(pr.foreshadowing) && pr.foreshadowing.length > 0) prParts.push(`活跃伏笔: ${pr.foreshadowing.join('; ')}`)
  // if (prParts.length > 0) sections.push('【大纲路线】\n' + prParts.join('\n'))

  // v0.9.6：STM 不再常规注入 —— STM 仅用于①投影替换（projectHistoryMessages）
  // ②对应正文退出上下文（压缩）时经记忆快照补注（buildMemorySnapshot）。
  // 这里只保留 当前状态。
  // [v0.9.7] 已知情报不再注入前台正文上下文——减少 token，需要时用 narrative_anchor_read 检索
  const mem = anchor.memory || {}

  // 注：LTM 长期记忆不在此 section 中渲染 —— v0.9.6 起由 buildSection 中的
  // 「记忆快照」块按根节点逐条检测在上下文后组装（buildMemorySnapshot）。

  if (sections.length === 0) return ''
  return sections.join('\n\n')
}

// ========== 结算提交处理 ==========

/** 数组字段归一化：LLM 可能提交字符串/对象/数组，统一为字符串数组（与 store.js 同规则） */
function envNorm(value) {
  if (value == null) return []
  let s = value
  if (typeof s === 'object') s = Object.values(s).map(x => (x != null && typeof x === 'object') ? '' : String(x)).filter(Boolean).join('，')
  if (!Array.isArray(s)) s = String(s).split(/[、，,;；\n]+/)
  return s.map(x => String(x).trim()).filter(Boolean)
}

// ========== 后台结算扩展 ==========

// 工具定义统一从 strategies.js 导入（NARRATIVE_ANCHOR_READ_TOOL / NARRATIVE_ANCHOR_SUBMIT_TOOL），
// 避免 lib/index.js 与 strategies.js 重复定义导致版本不一致。

// 兼容两种分发上下文：MVU 分支传 settlementInput（含 snapshot 字段）、非 MVU 分支传 { snapshot, call }
function chatFromInput(ctx2) {
  if (!ctx2) return null
  if (ctx2.snapshot) return ctx2.snapshot.chat || ctx2.snapshot
  return ctx2.chat || ctx2
}

// [2026-09-29 暂停] formatAnchorSnapshot 为死代码，从未被调用；后台实际用 strategies.js 的 anchorSnapshot。
// 完整函数已备份至 docs/BACKUP_伏笔活跃伏笔注释_20260929/，需要恢复时从备份取回。
/*
// 完整锚点快照（后台结算上下文用，STM 全量，区别于前台注入的 formatAnchorForInjection）
function formatAnchorSnapshot(anchor) {
  const sections = []
  const cs = anchor.current_state
  const csParts = []
  if (cs.time) csParts.push('时间: ' + cs.time)
  if (cs.world) csParts.push('世界: ' + cs.world)
  if (cs.location) csParts.push('地点: ' + cs.location)
  if (Array.isArray(cs.characters) && cs.characters.length > 0) csParts.push('在场人物: ' + cs.characters.join(', '))
  if (cs.environment) csParts.push('环境: ' + (Array.isArray(cs.environment) ? cs.environment.join('、') : cs.environment))
  if (Array.isArray(cs.items) && cs.items.length > 0) csParts.push('物品: ' + cs.items.join(', '))
  if (cs.focus) csParts.push('叙事备忘: ' + cs.focus)
  if (csParts.length > 0) sections.push('【当前状态】\n' + csParts.join('\n'))

  const pr = anchor.plot_route
  const prParts = []
  if (pr.current_node) prParts.push('当前节点: ' + pr.current_node)
  if (pr.recap) prParts.push('前情衔接: ' + pr.recap)
  if (pr.next_scene) prParts.push('下一幕规划: ' + pr.next_scene)
  if (Array.isArray(pr.foreshadowing) && pr.foreshadowing.length > 0) prParts.push('活跃伏笔: ' + pr.foreshadowing.join('; '))
  if (prParts.length > 0) sections.push('【大纲路线】\n' + prParts.join('\n'))

  if (Array.isArray(anchor.memory.stm) && anchor.memory.stm.length > 0) {
    const unmerged = anchor.memory.stm.filter((e) => e.merged_into == null)
    if (unmerged.length > 0) {
      const stmText = unmerged.map((e, i) => (i + 1) + '. [' + (e.time || '') + ' @ ' + (e.location || '') + '] ' + e.summary).join('\n')
      sections.push('【近期记忆 STM】（未合并 ' + unmerged.length + ' 条，共 ' + anchor.memory.stm.length + ' 条）\n' + stmText)
    }
  }
  // LTM 树形结构（v0.8.0）
  const ltmTreeText = formatLtmTree(anchor)
  if (ltmTreeText) sections.push('【长期记忆 LTM】（树形结构）\n' + ltmTreeText)
  // 兼容旧格式扁平 ltm
  if (!ltmTreeText && Array.isArray(anchor.memory.ltm) && anchor.memory.ltm.length > 0) {
    const ltmText = anchor.memory.ltm.map((e, i) => (i + 1) + '. [' + (e.subject || e.time_span || '') + '] ' + e.summary).join('\n')
    sections.push('【长期记忆 LTM】\n' + ltmText)
  }
  if (Array.isArray(anchor.memory.known_facts) && anchor.memory.known_facts.length > 0) {
    const kfText = anchor.memory.known_facts.map(f => '- ' + f.entry + ': ' + f.summary).join('\n')
    sections.push('【已知情报】\n' + kfText)
  }
  if (Array.isArray(anchor.memory.foreshadow_library) && anchor.memory.foreshadow_library.length > 0) {
    const ffText = anchor.memory.foreshadow_library.map(f => '- [' + f.id + '] ' + f.description + ' (' + f.status + ')').join('\n')
    sections.push('【伏笔库】\n' + ffText)
  }
  if (sections.length === 0) return ''
  return sections.join('\n\n')
}
*/

// NARRATIVE_ANCHOR_SUBMIT_TOOL 已从 strategies.js 统一导入，此处不再重复定义。

// ========== 辅助：从会话获取 chat ==========

function getChatFromSession(ctx, sessionId) {
  if (!sessionId) return null
  try {
    const sessions = ctx.get('sessions')
    if (!sessions) return null
    // 1) 直接按传入 id 取
    let session = typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    if (session?.chat) return session.chat
    // 2) list 遍历：DSH platform session id 与 DSHT sessionId 不同，按 chat.sessionId/chat.id 匹配
    const list = typeof sessions.list === 'function' ? sessions.list() : []
    for (const s of list) {
      const chat = s?.chat
      if (!chat) continue
      if (chat.sessionId === sessionId || chat.id === sessionId) return chat
    }
    // 3) 唯一有 cardPath 的 chat（单会话场景兜底）
    for (const s of list) {
      const chat = s?.chat
      if (chat?.cardPath) return chat
    }
    // 4) 平台 session 本身
    return session || null
  } catch { return null }
}

// ========== v0.8.0：投影替换（Projection Replace）==========

/** 粗估 token 数：CJK 约 2 字符/token，ASCII 约 4 字符/token */
function estimateTokens(text) {
  if (!text) return 0
  let nonAscii = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) nonAscii++
  }
  const ascii = text.length - nonAscii
  return Math.ceil(ascii / 4) + Math.ceil(nonAscii / 2)
}

/** 提取 assistant 消息中的正文文本块拼接（不含 reasoning / tool-call） */
function bodyTextOfMessage(msg) {
  if (!msg || msg.role !== 'assistant') return ''
  // 请求消息：content 数组格式；block DAG 解码消息：text 字符串格式
  if (Array.isArray(msg.content)) return msg.content.filter(b => b && b.type === 'text').map(b => String(b.text || '')).join('\n')
  if (typeof msg.text === 'string') return msg.text
  return ''
}

/**
 * 投影替换核心逻辑：
 * - 保留最后一轮 AI 正文（最近一次 assistant 大块文本）
 * - 更早的 assistant 正文若原文 token > 3 x STM 摘要 token，则替换为【Summary】投影
 * - 其余消息（user / tool-call / reasoning / frame）原样保留
 * - STM 条目按 turn 匹配 chat.messages 中对应 assistant 轮次
 */

/**
 * v0.9.33：会话常驻条目 → 独立系统消息注入。
 * 常驻条目不进原生世界书召回池（merger 已排除），由本投影在正文生成请求的
 * 消息数组中插入一条独立 system 消息（不改动原前缀消息内容）：
 * - 优先插到含【常驻世界书】的消息之后（紧跟官方常驻内容）
 * - 官方常驻世界书为空（前缀无该消息）时，回退插到开头 system 消息块之后
 *   （消除对官方常驻内容非空的依赖）
 */
function injectConstantWbEntriesToPrefix(messages, context) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  const sessionId = context && context.chat && context.chat.sessionId
  if (!sessionId) return messages
  const book = readSessionWorldbook(sessionId)
  if (!book || !Array.isArray(book.entries)) return messages
  // 只取 constant=true、enabled、有正文的条目（Persona 条目也走此路径）
  const constEntries = book.entries.filter(e =>
    e && e.constant === true && e.enabled !== false &&
    String(e.content || '').trim() !== ''
  )
  if (constEntries.length === 0) return messages
  // 已注入过（同请求内重复投影）则不动
  for (const msg of messages) {
    const full = msg && Array.isArray(msg.content)
      ? msg.content.map(b => (b && b.type === 'text') ? String(b.text || '') : '').join('')
      : ''
    if (full.indexOf('【会话常驻】') >= 0) return messages
  }
  const block = '【会话常驻】\n' + constEntries.map(e =>
    String(e.content || '').trim() + '\n' + '---'
  ).join('\n\n')
  const sysMsg = { role: 'system', content: [{ type: 'text', text: block }] }
  // 定位插入点（按可靠性分级）：
  //   ① 消息 id 以 tavern-session-prefix: 开头（官方稳定前缀消息的精确标识）
  //   ② source.sections 含 name 'tavern:constant-worldbook'（官方常驻世界书 section）
  //   ③ 正文含【常驻世界书】标记（兜底，兼容不带 source 的消息形态）
  //   ④ 均未命中 → 回退到开头 system 消息块之后
  let anchorIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (!msg) continue
    const isPrefix = String(msg.id || '').startsWith('tavern-session-prefix:')
    const hasWbSection = Array.isArray(msg.source?.sections) &&
      msg.source.sections.some(s => s && s.name === 'tavern:constant-worldbook')
    if (isPrefix || hasWbSection) { anchorIdx = i; break }
  }
  if (anchorIdx < 0) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg || !Array.isArray(msg.content)) continue
      const full = msg.content.map(b => (b && b.type === 'text') ? String(b.text || '') : '').join('')
      if (full.indexOf('【常驻世界书】') >= 0) { anchorIdx = i; break }
    }
  }
  if (anchorIdx < 0) {
    let lastSystem = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] && messages[i].role === 'system') lastSystem = i
      else break
    }
    anchorIdx = lastSystem
  }
  if (anchorIdx < 0) return messages // 消息数组开头没有 system 消息，放弃注入
  const result = messages.slice()
  result.splice(anchorIdx + 1, 0, sysMsg)
  return result
}

/** 投影诊断：写 DSHT 桌面日志目录（console.log 不被 DSH 日志捕获）。
 *  位置由 paths.js 解析 → <DataDir>/desktop/logs/na-proj-diag.log，
 *  与 na-debug.log、na-request-log.jsonl 同处；数据区只放数据，不混放日志。
 *  解析不到目录时静默跳过（不退化到插件目录、不刷错误）。 */
function projDiag(...args) {
  try {
    const line = new Date().toISOString() + ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') + '\n'
    // 投影诊断每请求一条，量最大但价值最低 → 上限最小、只留 2 份
    appendRotatingLogSync(desktopLogFile('na-proj-diag.log'), line, { maxBytes: 4 * 1024 * 1024, keep: 2 })
  } catch { /* ignore */ }
}

function projectHistoryMessages(messages, context) {
  try {
  return _projectHistoryMessages(messages, context)
  } catch (e) {
    projDiag('EXCEPTION:', e && e.stack || e)
    return messages
  }
}

function _projectHistoryMessages(messages, context) {
  const chat = context && context.chat
  if (!chat) { projDiag('no chat'); return messages }
  const sessionId = chat.sessionId || (context && context.sessionId) || ''
  projDiag('enter sessionId=', sessionId ? sessionId.slice(0,30) : '', 'chat.id=', chat && chat.id)

  const anchor = readAnchor(sessionId) || chat.narrativeAnchor
  if (!anchor) { projDiag('no anchor'); return messages }
  const settings = anchor.meta && anchor.meta.settings || {}
  if (settings.projectionReplace !== true) { projDiag('projectionReplace not true'); return messages }

  // v0.9.28：block DAG 格式默认不随 chat 带 messages，需要时按需重读（含消息解码较慢）
  let chatWithMessages = chat
  if (!Array.isArray(chat.messages)) {
    const dataRoot = context && context.dataRoot
    if (dataRoot && sessionId) {
      const reRead = readChatFromDisk(dataRoot, sessionId, { includeMessages: true })
      if (reRead && Array.isArray(reRead.messages)) chatWithMessages = reRead
    }
  }
  if (!Array.isArray(chatWithMessages.messages)) { projDiag('no messages after reread'); return messages }
  projDiag('committed messages=', chatWithMessages.messages.length)

  const stmList = anchor.memory && anchor.memory.stm
  if (!Array.isArray(stmList) || stmList.length === 0) { projDiag('no stm'); return messages }

  // STM 按 turn 索引
  const stmByTurn = new Map()
  for (const entry of stmList) {
    if (entry && Number.isFinite(entry.turn)) stmByTurn.set(Number(entry.turn), entry)
  }
  if (stmByTurn.size === 0) { projDiag('stmByTurn empty'); return messages }
  projDiag('stmByTurn turns=', Array.from(stmByTurn.keys()).join(','))

  // 已提交的 assistant 正文轮次（排除 greeting）
  const committedAsm = chatWithMessages.messages.filter(m =>
    m && m.role === 'assistant' && !m.greeting && bodyTextOfMessage(m).trim().length > 0
  )
  if (committedAsm.length < 2) { projDiag('committedAsm < 2:', committedAsm.length); return messages }
  projDiag('committedAsm=', committedAsm.length, 'turns=', committedAsm.map(m=>m.turn).join(','))

  // 在请求 messages 中定位"已提交 assistant 正文"的索引。必须与 committedAsm 用【完全相同的
  // 过滤条件】（role==='assistant' && !greeting && 正文长度>0），否则两者长度不一致、尾部对齐
  // 会把 turn 配错（替换错消息或整轮跳过）。此前这里用 >200 的启发式阈值，会让 1~200 字的
  // assistant 回复进 committedAsm 却不进 bodyAsmIdx，造成错位；改为 >0 后长度恒等、对齐稳定。
  // （实际是否替换仍由下方 originalTokens > 3*stmTokens 判定，短原文不会被误替换。）
  const bodyAsmIdx = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!m || m.role !== 'assistant' || m.greeting) continue
    const t = bodyTextOfMessage(m).trim()
    if (t.length > 0) bodyAsmIdx.push(i)
  }
  if (bodyAsmIdx.length < 2) { projDiag('bodyAsmIdx < 2:', bodyAsmIdx.length); return messages }
  projDiag('bodyAsmIdx=', bodyAsmIdx.length, 'indices=', bodyAsmIdx.join(','))

  // 已提交 assistant 轮次（按时间顺序，最后一个=最新轮次）
  const committedTurns = committedAsm.map(m => Number(m.turn))
  projDiag('committedTurns tail=', committedTurns.slice(-Math.min(12, committedTurns.length)).join(','))

  const result = messages.slice()
  let changed = false

  // 反向位置匹配：请求正文 assistant 必然是已提交 assistant 的连续后缀
  // 从末尾对齐：最后一条请求正文 = 最后一条已提交，倒数第二 = 倒数第二...
  // 最后一轮（k=bodyAsmIdx.length-1）保留原文，从倒数第二条开始替换
  let ci = committedTurns.length - 1
  for (let k = bodyAsmIdx.length - 2; k >= 0; k--) {
    if (ci < 0) break
    const msgIdx = bodyAsmIdx[k]
    const matchedTurn = committedTurns[ci]
    ci--
    if (!Number.isFinite(matchedTurn)) continue

    const stm = stmByTurn.get(matchedTurn)
    if (!stm || !String(stm.summary || '').trim()) continue

    const reqText = bodyTextOfMessage(messages[msgIdx]).trim()
    const originalTokens = estimateTokens(reqText)
    const stmTokens = estimateTokens(String(stm.summary || ''))
    if (originalTokens <= 3 * stmTokens) continue

    // 构建投影文本
    const projLines = ['【Summary】']
    projLines.push('[轮次 ' + matchedTurn + ']')
    const time = String(stm.time || '').trim()
    const loc = String(stm.location || '').trim()
    if (time || loc) projLines.push('[' + (time || '?') + ' @ ' + (loc || '?') + ']')
    projLines.push(String(stm.summary || '').trim())
    const projText = projLines.join('\n')

    // 替换 text 块内容，保留 reasoning / tool-call 块
    const msg = messages[msgIdx]
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map(b => {
        if (b && b.type === 'text') return Object.assign({}, b, { text: projText })
        return b
      })
      result[msgIdx] = Object.assign({}, msg, { content: newContent })
    } else if (typeof msg.text === 'string') {
      result[msgIdx] = Object.assign({}, msg, { text: projText })
    } else {
      continue
    }
    changed = true
    projDiag('REPLACED msgIdx=', msgIdx, 'turn=', matchedTurn)
  }

  projDiag('done, changed=', changed)
  return changed ? result : messages
}

  // ========== 插件入口 ==========

export function apply(ctx, config) {
  const debug = config.debug || false
  const log = (...args) => { if (debug) console.log('[narrative-anchor]', ...args) }

  // 请求体审计实例（v3.3）：先声明供守卫的 audit getter 惰性引用，下方 installRequestAudit 时赋值
  let requestAudit = null
  // 结算 API（official-v2 createOfficialSettlement 返回，settlement effect 内赋值；
  // HTTP 端点经此访问 clearBackgroundSession / backgroundSessionInfo）
  let officialApi = null

  // v0.9.16 支线系统：族谱解析需要读 DSH chat 数据（forkedFrom 链），注入数据根
  // 数据根优先级 ①：插件显式配置（留空则由 paths.js 结构发现推导）
  if (config.tavernDataRoot) setTavernDataRoot(config.tavernDataRoot)
  setFamilyDataRoot(resolveTavernDataRoot())

  // ── v2 结算请求出口守卫（2026-10-10，v2.5 瘦身版）──
  // 跨轮历史已由会话层 rewindResidentSurface（rewindTo:-1 语义）清空，不再在此裁剪；
  // 本守卫只滤 tavern unbound 注入的【酒馆状态】+ 注入 maxTokens（见 installNaTavernStateFilter）。
  // v3.1（2026-10-10）：同时拦截后台会话（background-* / na-background-*）的官方压缩请求——
  // 开关 blockBackgroundCompaction（global.json，默认 false，即默认不勾选/不拦截）开启时抛具体拒绝错误，
  // 官方 agent-loop 捕获后仅 warn、回合照常继续（后台压缩无信息增益，只浪费 token 与时间）。
  // **必须在 installRequestAudit 之前注册**：waterfall 按注册顺序传递，守卫先改、
  // audit 后记录，请求日志才能如实反映最终请求体（见 installNaTavernStateFilter 注释）。
  // audit 用惰性 getter：requestAudit 在下方 L4xx 赋值，拦截运行时（请求发生时）已可用。
  installNaTavernStateFilter(ctx, {
    blockBackgroundCompaction: () => (readGlobalSettings() || {}).blockBackgroundCompaction === true,
    // v3.5：拦截时删除对应后台会话（默认 true；仅拦截开启时生效）
    deleteOnBlock: () => (readGlobalSettings() || {}).deleteBackgroundSessionOnBlock !== false,
    audit: () => requestAudit
  })

  // ── v2.3 请求体审计（2026-10-09）──
  // 挂 llm/stream waterfall，捕获 na-background-* 结算会话的完整请求体（messages/system/tools），
  // 落盘 JSONL + 内存缓冲（供 /api/narrative-anchor/requestLog）。只读不改，不影响瀑布链。
  requestAudit = installRequestAudit(ctx, { tavernDataRoot: config.tavernDataRoot })

  // ── v0.9.6 记忆快照（LTM 逐条在上下文检测 + STM 压缩补偿）──
  // LTM 唯一引用：时间戳 + 节点 id（节点 id 自增不复用，created_at 毫秒时间戳）
  function ltmRef(node) {
    return 'ltm-' + Number(node.created_at || 0).toString(36) + '-' + node.id
  }
  // STM 对应正文是否已退出上下文：chat 里找得到该消息、但其正文不在本次
  // 请求文本中 → 已被压缩/滚出。只在"能确证缺失"时返回 true（保守）。
  function stmBodyAbsentFromContext(chat, haystack, stm) {
    if (!haystack) return false
    const messages = Array.isArray(chat?.messages) ? chat.messages : []
    const msg = messages.find((m) => m && m.role === 'assistant'
      && (m.id === stm.message_id || Number(m.turn) === Number(stm.turn)))
    if (!msg) return false
    // chat 层消息只有 .text（无 content 数组），必须走 text 回退
    const raw = (typeof msg.text === 'string' && msg.text) ? msg.text : bodyTextOfMessage(msg)
    const probe = raw.replace(/\s+/g, '').slice(0, 40)
    if (probe.length < 12) return false
    return !haystack.replace(/\s+/g, '').includes(probe)
  }
  // 组装记忆快照（v0.9.17）：每请求现算一条。判定源 = 本次请求的现场 messages
  // 文本（即"这一轮模型实际会看到的全部内容"）：LTM 根已在 → 只留 √ 标题行
  //（标题为结算时提交的 ≤12 字概括，无标题的旧节点回退为 ref）；缺席 → 标题：全文。
  // STM 默认不注入，仅当对应正文已退出上下文（压缩）时补注。
  function buildMemorySnapshot(chat, haystack, replayTexts, sid) {
    try {
      const anchor = readAnchor(sid || chat.sessionId || '') || chat.narrativeAnchor
      const memory = anchor?.memory
      if (!memory) return ''
      const tree = memory.ltm_tree
      const roots = (tree && Array.isArray(tree.roots)) ? tree.roots : []
      const stms = Array.isArray(memory.stm) ? memory.stm.filter((e) => e && e.merged_into == null) : []
      naDbg('snapshot build entry', { hasMem: !!memory, roots: roots.length, stms: stms.length, hasTree: !!tree, hasNodes: !!(tree && tree.nodes) })
      if (roots.length === 0 && stms.length === 0) return ''
      // 无现场证据（haystack 为空）时 LTM 全量注入、STM 保守跳过——下一轮即有证据，自愈
      const settings = anchor?.meta?.settings || {}
      const lines = []
      if (roots.length > 0 && tree.nodes) {
        const rows = []
        for (const id of roots) {
          const node = tree.nodes[id]
          if (!node) continue
          const ref = ltmRef(node)
          const summary = String(node.summary || '')
          const present = haystack && (entryPresentInContext(haystack, { content: summary })
            || (Array.isArray(replayTexts) && replayTexts.some((t) => entryPresentInContext(t, { content: summary }))))
          rows.push({ node, ref, summary, present })
        }
        // 设置项：所有 LTM 根全部已在上下文 → 本轮快照不含 LTM 行（STM 补注逻辑不受影响）
        const skipLtm = settings.skipAllPresentLtm !== false && rows.length > 0 && rows.every((r) => r.present)
        naDbg('snapshot build ltm', { rows: rows.length, skipLtm, linesBefore: lines.length })
        if (!skipLtm) {
          for (const r of rows) {
            const title = String(r.node.title || '').replace(/\s+/g, ' ').trim().slice(0, 12)
            if (r.present) {
              // 已在上下文：√ + 标题（无标题的旧节点回退为 ref/id）
              lines.push(`[L${r.node.depth}] √ ` + (title || '#' + r.ref))
            } else {
              // 本轮补注：标题：全文（无标题则用 ref/id 作前缀）
              lines.push(`[L${r.node.depth}] ` + (title || '#' + r.ref) + '：' + r.summary.trim())
            }
          }
        }
      }
      if (stms.length > 0 && haystack) {
        // STM 补注判断：
        //   - 自动生成的 STM（manual 未设置）：正文缺席 AND 摘要缺席 → 补注
        //   - 人工新增的 STM（manual=true）：只判断摘要是否在上下文（没有对应正文可查）
        //   摘要在场判断与 LTM 一致：haystack + replayTexts 双检查
        for (const s of stms) {
          const summary = String(s.summary || '').trim()
          if (!summary) continue  // 空 summary 直接跳过
          // 人工 STM（manual=true）：跳过正文判断，只看摘要是否在场
          const isManual = s.manual === true
          if (!isManual) {
            const bodyAbsent = stmBodyAbsentFromContext(chat, haystack, s)
            if (!bodyAbsent) continue  // 正文还在上下文 → 不补
          }
          // 摘要是否在上下文（与 LTM 一致：haystack + replayTexts 双检查）
          const summaryPresent = haystack && (entryPresentInContext(haystack, { content: summary })
            || (Array.isArray(replayTexts) && replayTexts.some((t) => entryPresentInContext(t, { content: summary }))))
          if (summaryPresent) continue  // 摘要已在上下文 → 不补
          // 补注格式：标题：摘要内容（无标题时退化为 #id）
          const title = String(s.title || '').replace(/\s+/g, ' ').trim()
          const prefix = title || ('#' + s.id)
          lines.push(`[轮${s.turn}] ` + prefix + '：' + summary)
        }
      }
      naDbg('snapshot build stm', { linesAfterStm: lines.length, stms: stms.length })
      if (lines.length === 0) return ''
      return '【Narrative Anchor · Memory Snapshot (✓=exists Elsewhere In Context: title ref for timeline; unmarked = new notes)】\n' + lines.join('\n')
    } catch (e) {
      log('buildMemorySnapshot 失败（不阻断正文 section）:', e && e.message)
      naDbg('buildMemorySnapshot error', { err: e && e.message || String(e) })
      return ''
    }
  }

  // 正文前缀指纹：请求层/chat 层通用的正文签名（归一化前 80 字，用于按正文对齐
  // 请求层消息与 chat 层轮次，以及判定正文是否换装）
  function chatBodySig(msg) {
    const raw = (typeof msg?.text === 'string' && msg.text) ? msg.text : bodyTextOfMessage(msg)
    const body = String(raw).replace(/\s+/g, '')
    return body.length >= 12 ? body.slice(0, 80) : ''
  }
  // 现场语料：投影收到的 messages 即本次请求将发出的全部内容（含 projection-replace
  // 之后的历史），直接拼接为"在上下文"检测的判定源，无需读历史请求文件
  function messagesHaystack(messages) {
    let hay = ''
    for (const m of messages || []) {
      const c = m?.content
      if (typeof c === 'string') hay += c + '\n'
      else if (Array.isArray(c)) for (const p of c) { if (typeof p?.text === 'string') hay += p.text + '\n' }
    }
    return hay
  }

  // 1. 前台当前状态（官方 plugin-api v2 turnSection，2026-10-09 去补丁化）
  //    turnSection 只进游玩正文请求（等价原 purpose==='body'），每轮只算一次、随轮保存、
  //    重试沿用；内容每轮变化 → 不使提示词缓存失效。
  //    位置官方仅 after/before：injectPosition 含 'before' → 'before'（本轮上下文之前），否则 'after'。
  //    （原 slot 级精确位置不再可用；注册时固定 position，运行时设置变化不生效。）
  function buildTurnSectionText(gameId) {
    const parts = []
    const chat = gameId ? readChatFromDisk(resolveTavernDataRoot(), gameId) : null
    // 支线分支提示（fork 时写入 chat.branchNote，只显示一次）
    if (chat && chat.branchNote) parts.push(chat.branchNote)
    const fileAnchor = readAnchor(gameId || '') || null
    const settings = (fileAnchor?.meta?.settings) || {}
    if (settings.enabled === false) return parts.length > 0 ? parts.join('\n\n') : ''
    const text = formatAnchorForInjection(fileAnchor)
    if (text) parts.push(text)
    // 动态世界书快照 · 人工选择 —— 作者指定注入下一次回复的临时世界书条目；
    // 已由 DSHT 原生召回进入本轮上下文的条目不重复注入（refs 前缀 session-wb:）。
    const book = readSessionWorldbook(gameId || '')
    const inCtx = new Set((Array.isArray(chat?.preparedWorldBook?.refs) ? chat.preparedWorldBook.refs : []).map(r => normalizeRef(r)))
    const toInject = selectedEntries(book).filter(e => !inCtx.has('session-wb:' + e.id))
    if (toInject.length > 0) {
      const block = toInject.map(e => {
        const head = String(e.title || '').trim()
        return (head ? '◆ ' + head + '\n' : '') + String(e.content || '').trim()
      }).join('\n\n')
      parts.push('【动态世界书快照 · 人工选择（本轮临时注入，作者指定，务必纳入考量）】\n' + block)
    }
    return parts.join('\n\n')
  }
  ctx.effect(() => {
    const tavern = ctx.tavern
    if (!tavern || typeof tavern.turnSection !== 'function') return
    const position = String(config.injectPosition || '').includes('before') ? 'before' : 'after'
    return tavern.turnSection({
      name: 'narrative-anchor.current-state',
      position,
      text({ gameId }) {
        try {
          return buildTurnSectionText(gameId)
        } catch (e) {
          console.error('[narrative-anchor] turnSection 构建失败（不阻断正文）:', e && e.message || e)
          return ''
        }
      }
    })
  }, 'narrative-anchor: foreground turn section')

  // 1a. 常驻世界书前缀（官方 plugin-api v1 promptSection，2026-10-09 去补丁化）：
  //     官方实现把插件段落追加在"Tavern 系统提示 + 稳定前缀 + 常驻世界书"之后
  //     （hooks/turn-lifecycle.js L107）——与原 projection 插入点【常驻世界书】之后一致。
  //     text 函数每轮请求前调用，内容不变 → 提示词缓存友好（官方明示 promptSection 适合不常变规则）。
  ctx.effect(() => {
    const tavern = ctx.tavern
    if (!tavern || typeof tavern.promptSection !== 'function') return
    return tavern.promptSection({
      name: 'narrative-anchor.constant-worldbook',
      text({ gameId }) {
        try {
          const book = readSessionWorldbook(gameId || '')
          if (!book || !Array.isArray(book.entries)) return ''
          const constEntries = book.entries.filter(e =>
            e && e.constant === true && e.enabled !== false &&
            String(e.content || '').trim() !== '')
          if (constEntries.length === 0) return ''
          return '【会话常驻】\n' + constEntries.map(e =>
            String(e.content || '').trim() + '\n' + '---'
          ).join('\n\n')
        } catch (e) {
          console.error('[narrative-anchor] constant wb prompt section failed:', e && e.message || e)
          return ''
        }
      }
    })
  }, 'narrative-anchor: constant worldbook prompt section')

  // 1b/1c. v2（2026-10-09）：消息投影改为标准 DSH llm/stream 中间件。
  //     —— TEP registerMessageProjection 的消费点（applyMessageProjections）经排查
  //       从未被官方/补丁运行时调用（更新前备份与官方 2.5.0 均无调用点），原注册为
  //       死代码；改为本插件自挂中间件（before dsh-tavern-plugin），在请求层直接执行
  //       同一批投影：projection-replace（旧正文→Summary）/ memory-snapshot（冻结注解）
  //       / branch-note（分支提示）。
  //     —— 只作用于 story/script 前台正文请求（purpose undefined 且非 sillytavern）。
  // 记忆快照（v0.9.18）：快照是正文的冻结注解，随正文存亡——
  // ① 回放：日志条目绑定某轮正文，正文仍在请求里 → 冻结文本原样插在该轮正文
  //    之前（字节不变，缓存稳定）；正文退出（压缩/rewind/改写）→ 成对退役。
  // ② 首次在场补建：某轮正文第一次出现在请求里而没有绑定条目（新正文 / 旧版本
  //    时代缺失）→ 当场现算一次、落日志冻结，从下一轮起原样回放。
  // 不做生成期注入（生成轮正文尚不存在，其注解在下一轮首次在场时创建）。
  function memorySnapshotProjection(messages, context) {
    try {
      const chat = context?.chat
          if (!chat) return messages
          // v0.9.27 修复：新格式 chat（block DAG 回退对象）没有 sessionId/messages 字段，
          // 必须用中间件传入的 context.sessionId（llm/stream options.sessionId），
          // 否则 readAnchor('')/readSnapshotLog('') 会 fallback 到 unknown.json 读错锚点。
          const sid = context?.sessionId || chat.sessionId || ''
          const fileAnchor = readAnchor(sid)
          const settings = (fileAnchor?.meta?.settings) || chat.narrativeAnchor?.meta?.settings || {}
          if (settings.enabled === false) return messages
          naDbg('snapshot projection entered', { sessionId: sid.slice(0, 20), msgCount: messages.length, enabled: settings.enabled, anchor: !!fileAnchor })
          // foreground-frame 仅作"同一槽位"兼容参考（官方 2.5.0 请求无独立 frame 消息，
          // 缺失时按"最后一条 assistant 正文"定位，不再作为投影门槛）
          let fgIdx = -1
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.source?.form === 'foreground-frame') {
              fgIdx = i
              break
            }
          }
          const scanEnd = fgIdx === -1 ? messages.length : fgIdx
          // 双前缀兼容：历史快照日志可能是旧中文 header，已回放的判重两种都要认
          const isOurs = (m) => {
            const c = m?.content
            const has = (t) => typeof t === 'string' && (t.includes('【Narrative Anchor · Memory Snapshot') || t.includes('【叙事锚定 · 记忆快照'))
            return Array.isArray(c) ? c.some(p => has(p?.text)) : has(c)
          }
          const snapshotMsgOf = (text) => ({ role: 'system', content: [{ type: 'text', text }] })
          const log = readSnapshotLog(sid)
          let latestTurn = 0
          for (const m of chat.messages || []) {
            if (m && m.role === 'assistant' && !m.greeting && Number.isSafeInteger(Number(m.turn))) {
              latestTurn = Math.max(latestTurn, Number(m.turn))
            }
          }
          const genTurn = latestTurn + 1 // 本请求正在生成的轮次
          // ① 历史回放：绑定正文仍在请求里 → 冻结文本原样回放；否则成对退役
          const kept = []
          const insertBefore = new Map()
          const replayTexts = []
          for (const e of log) {
            if (e.turn >= genTurn) { kept.push(e); continue } // 超前条目（异常残留）原样保留
            // 新格式 chat（block DAG）无 messages：无 chat 层轮次可查，直接用日志签名
            // 在请求层匹配；旧格式有 messages 时仍走 chat 层签名（正文换装检测）
            const hasChatMsgs = Array.isArray(chat.messages) && chat.messages.length > 0
            let sig = ''
            if (hasChatMsgs) {
              const cm = chat.messages.find(m => m && m.role === 'assistant' && !m.greeting && Number(m.turn) === Number(e.turn))
              sig = chatBodySig(cm)
              if (!sig) continue // 该轮已不存在于 chat（rewind 截断）或正文过短 → 成对退役
              if (e.body && !(sig.startsWith(e.body) || e.body.startsWith(sig))) continue // 正文换装（原地改写）→ 退役（前缀比对，chat 层签名可能短于 80 字）
            } else {
              sig = e.body || ''
              if (!sig) continue
            }
            let idx = -1
            for (let i = 0; i < scanEnd; i++) {
              const m = messages[i]
              if (m && m.role === 'assistant' && !m.greeting
                && bodyTextOfMessage(m).replace(/\s+/g, '').startsWith(sig)) { idx = i; break }
            }
            naDbg('snapshot replay probe', { sig: sig.slice(0, 12), idx, logLen: log.length })
            if (idx === -1) continue // 正文已不在请求中（压缩 / Summary 替换）→ 成对退役
            e.body = sig
            kept.push(e)
            replayTexts.push(e.text)
            // 锚点：该轮正文之前——快照是该轮正文的记忆注解，位于"每轮新进入
            // 上下文的内容"（前缀缓存变动点）之前，正文+快照顺序稳定 → 缓存命中
            const at = idx
            if (isOurs(messages[at - 1])) continue // 已有回放（重复投影幂等防御）
            const arr = insertBefore.get(at) || []
            arr.push(snapshotMsgOf(e.text))
            insertBefore.set(at, arr)
          }
          // ② 首次冻结：请求中最后一条 assistant 正文（本轮新进入上下文的正文，
          // 与 foreground-frame 无关）首次在场（日志无绑定）→ 现算一次并冻结；
          // 之后该轮成为历史，回放冻结文本（不变 → 前缀缓存命中）
          let lastIdx = -1
          for (let i = scanEnd - 1; i >= 0; i--) {
            const m = messages[i]
            if (m && m.role === 'assistant' && !m.greeting && bodyTextOfMessage(m).trim()) { lastIdx = i; break }
          }
          if (lastIdx !== -1) {
            const sig = bodyTextOfMessage(messages[lastIdx]).replace(/\s+/g, '').slice(0, 80)
            // chat 层签名可能短于 80 字（正文不足 80 时 slice 取不满），与请求层签名
            // 是前缀关系而非相等，必须按前缀比对
            const bound = kept.some(e => e.body && (sig.startsWith(e.body) || e.body.startsWith(sig)))
            naDbg('snapshot freeze probe', { sig: sig.slice(0, 12), bound, kept: kept.length, lastIdx })
            if (sig && !bound) {
              // 新快照插在最后一条正文之前（该轮正文的记忆注解，变动点之前）
              const at = lastIdx
              if (!isOurs(messages[at - 1])) {
                const haystack = messagesHaystack(messages)
                const snapshot = buildMemorySnapshot(chat, haystack, replayTexts, sid)
                const anchorDbg = readAnchor(sid || '')
                naDbg('snapshot freeze build', { snapshotLen: String(snapshot || '').length, haystackLen: String(haystack || '').length, replayTexts: replayTexts.length, anchorAgain: !!anchorDbg, anchorMem: !!(anchorDbg && anchorDbg.memory), roots: (anchorDbg && anchorDbg.memory && anchorDbg.memory.ltm_tree && anchorDbg.memory.ltm_tree.roots || []).length })
                if (snapshot) {
                  const cm = (chat.messages || []).find(m => m && m.role === 'assistant' && !m.greeting && chatBodySig(m) && sig.startsWith(chatBodySig(m)))
                  const entry = { turn: Number.isSafeInteger(Number(cm?.turn)) ? Number(cm.turn) : genTurn - 1, text: snapshot, ts: Date.now(), body: sig }
                  log.push(entry)
                  kept.push(entry)
                  const arr = insertBefore.get(at) || []
                  arr.push(snapshotMsgOf(snapshot))
                  insertBefore.set(at, arr)
                }
              }
            }
          }
          writeSnapshotLog(sid, kept)
          // 组装：各轮正文之前插其冻结注解（快照 → 正文，注解在正文前）
          const insertCount = [...insertBefore.values()].reduce((n, a) => n + a.length, 0)
          naDbg('snapshot projection done', { insertCount, kept: kept.length, logLen: log.length })
          if (insertCount === 0) return messages
          const out = []
          for (let i = 0; i < messages.length; i++) {
            const arr = insertBefore.get(i)
            if (arr) out.push(...arr)
            out.push(messages[i])
          }
          return out
    } catch (e) {
      naDbg('snapshot projection failed', { err: e && e.message || String(e) })
      console.error('[narrative-anchor] memory snapshot projection failed:', e && e.message || e)
      return messages
    }
  }

  // 分支提示（v0.9.21）：请求期注入 system 角色提示。
  // 不能走会话层 system/message——实测 DSH 在下一轮 claim 时会把游离追加的
  // system/message surface 节点 replace 成空墓碑（session.v3 seq 964 replace 951），
  // 永远进不了请求；而请求期投影注入的 system 消息稳定存在（同 Memory Snapshot 通道）。
  // 位置：开场白气泡（narrative-anchor-greeting）之前——即"复制自主线的内容"之后。
  function branchNoteProjection(messages, context) {
    try {
      const NOTE_TEXT = 'Entering a branched session. The content above are messages copied from the main branch, not the original content of this session. The user may switch scenarios or continue the plot. Follow the user\'s instructions.'
      // 仅以"开场白气泡在请求里"为锚点：有则插、无则原样返回。
      // 退役路径唯一且自洽：开场白本身随压缩/改写退役时，提示随之消失
      // （fork 前缀里可能本来就带主线的 checkpoint 摘要，不能用 checkpoint
      // 判退役，否则从创建起就永不注入）。位置固定+文本恒定 → 前缀缓存命中。
      const gi = (messages || []).findIndex(m => m?.role === 'assistant' && m?.source?.kind === 'model' && m?.source?.model === 'narrative-anchor-greeting')
      if (gi <= 0) return messages
      const prev = messages[gi - 1]
      if (prev?.role === 'system' && (prev?.content || []).some(b => typeof b?.text === 'string' && b.text.includes('Entering a branched session'))) return messages
      const note = { role: 'system', content: [{ type: 'text', text: NOTE_TEXT }] }
      return messages.slice(0, gi).concat([note], messages.slice(gi))
    } catch (e) {
      console.error('[narrative-anchor] branch-note projection failed:', e && e.message || e)
      return messages
    }
  }

  // 标准 DSH llm/stream 中间件：依次执行上述投影链；无修改则原样放行。
  // prepend:true 把本监听器 unshift 到 llm/stream 队列头部（cordis 只支持 prepend，
  // 无 before/after 事件排序；bundle 加载顺序 tavern 先于本插件，不加 prepend
  // 则本中间件在 tavern model-stream hook 之后执行，tavern 的请求记录不含本插件注入）。
  ctx.on('llm/stream', function (options, next) {
    try {
      const sessionId = (options && options.sessionId) || ''
      projDiag('enter', JSON.stringify({ sessionId: sessionId ? sessionId.slice(0, 30) : '', purpose: options && options.purpose, hasMessages: Array.isArray(options && options.messages), msgCount: Array.isArray(options && options.messages) ? options.messages.length : 0 }))
      if (!sessionId) return next(options)
      if (options && options.purpose !== undefined) { projDiag('skip: purpose defined'); return next(options) }
      const dataRoot = resolveTavernDataRoot()
      const chat = dataRoot ? readChatFromDisk(dataRoot, sessionId) : null
      if (!chat || !['story', 'script'].includes(chat.mode || 'story') || chat.requestMode === 'sillytavern') return next(options)
      naDbg('projection middleware entered', { sessionId: sessionId.slice(0, 20), purpose: options.purpose, chatId: chat.id, mode: chat.mode, reqMode: chat.requestMode, msgCount: Array.isArray(options.messages) ? options.messages.length : -1, chatMsgCount: Array.isArray(chat.messages) ? chat.messages.length : 'none', lastTail: (function () { const m = Array.isArray(options.messages) ? options.messages[options.messages.length - 1] : null; if (!m) return ''; const c = m.content; const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map(function (b) { return b && b.text || '' }).join('') : ''; return String(t).slice(-160) })() })
      const context = { chat, sessionId, purpose: 'body', dataRoot }
      let messages = Array.isArray(options.messages) ? options.messages : []
      const apply = (project) => {
        try {
          const result = project(messages, context)
          if (Array.isArray(result)) messages = result
        } catch (e) {
          console.error('[narrative-anchor] projection failed:', e && e.message || e)
        }
      }
      // v0.9.28 修复：LTM 记忆快照投影必须在 STM 历史替换【之前】执行。
      // memorySnapshotProjection 的回放(①)以"该轮原始助手正文"为锚点，在 messages 中
      // 查找正文前缀匹配的位置来注入冻结快照；若 STM 先跑，它会把历史助手正文改写成
      // 【Summary】… 后原文消失 → 回放找不到锚点 → 快照被"成对退役"、对应轮次的 LTM
      // 注入消失（用户观测：STM 替换后原助手消息的 LTM 没了）。
      // 先跑 LTM（此时正文仍是原文），快照以 system 消息插入各助手正文之前，随后 STM
      // 只改写该助手正文块、不动 system 快照 → 各轮记忆注解均保留（且快照质量更高，
      // 因为 haystack 用原始正文而非摘要）。branchNoteProjection 独立、保持最后。
      apply(m => memorySnapshotProjection(m, context))
      apply(m => projectHistoryMessages(m, context))
      apply(m => branchNoteProjection(m, context))
      // 投递方式（v3.6 修复，2026-10-16）：DSH 的 cordis fork（@deepseek-ai/cordis@4.0.2）
      // 中 waterfall 的 next 是零参闭包——
      //   waterfall(...args) { const cbs = this.dispatch("waterfall", args);
      //     const next = () => (cbs.shift() ?? inner)(...args);   // 永远展开最初 emit 的 args
      //     args.push(next); return next() }
      // 监听器调用 next(新options) 时新对象被静默丢弃，下游监听器（tavern model-stream
      // 钩子 / state-filter / 请求审计）与最终兜底 adapterStream 拿到的永远是 emit 时的
      // 原始 options。本 fork 中唯一有效的修改传播方式是原地 mutation（对象引用不变，
      // 属性改动对所有持有同一引用的下游可见）；tavern 自己的钩子正是用
      // ctx.llm.stream(重发) 绕过这一点。
      // 曾经的回归：此处用 next(Object.assign({}, options, { messages })) 传新对象，
      // 三条投影（记忆快照 / 分支提示 / 历史摘要替换）的产出全部在 next() 处被丢弃——
      // 请求体日志（NA jsonl、tavern model-requests、「完整上下文」面板）零快照，
      // 且模型实际也未收到 LTM（tavern 的 projectRequest 从同一 options 重建请求）。
      // 修复窗口实证：10-10 19:12 ~ 10-13 08:38 UTC 快照记录正常（228 条，ark-doubao
      // 时代旧管线），10-13 09:31 重启激活新构建后归零至今。
      // 幂等由投影内置的 isOurs 检测保证：tavern 对 E1 选择 ctx.llm.stream(重发) 产生
      // E2/E3，届时 options.messages 已含本轮快照 → 回放/冻结自动跳过，不会重复注入。
      if (messages !== options.messages) options.messages = messages
      return next(options)
    } catch (e) {
      console.error('[narrative-anchor] llm/stream projection middleware failed:', e && e.message || e)
      return next(options)
    }
  }, { global: true, prepend: true })

  // 3. 自由栏位「注入输入框」（v0.10.3）：勾选后，发送时自动跟在用户消息之后。
  //    实现 = 源头注入：修改 pre-step 的原始 payload.messages 用户消息文本 + decision.messages。
  //    为什么不能只改 decision.messages：tavern 的 nativePlay prepareStep 用
  //    userTextOf(payload.messages)（原始批次）渲染 projectedText，再 replaceTurnInput 把
  //    decision 里的用户消息整体替换为该投影文本——只改 decision 会被替换掉。
  //    改 payload.messages 源文本 → tavern 渲染的用户输入帧天然含注入 → 内容作为用户消息
  //    的一部分进入请求（符合「注入输入框 = 消息的一部分」，非上下文注入）。
  ctx.on('agent/pre-step', async function (payload, next) {
    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    try {
      const agent = payload && payload.agent
      // DSH Agent 接口：会话 ID 是 agent.id（SessionId）；agent.sessionId 不存在
      const sessionId = String(
        (agent && (agent.id || agent.sessionId || agent.session)) ||
        (payload.messages && payload.messages[0] && payload.messages[0].sessionId) || ''
      )
      // 后台结算会话不注入（结算请求不带历史）；非游戏会话 anchor 无 free_slots，天然跳过
      if (!sessionId || sessionId.startsWith('na-background-')) return decision
      const anchor = readAnchor(sessionId) || null
      const fs = anchor && anchor.free_slots ? anchor.free_slots : {}
      const parts = []
      // 自由栏位-列表（v0.10.4）：勾选「注入输入框」的元素 → 发送时自动跟在用户消息之后（带下标标识）
      if (Array.isArray(fs.list)) {
        fs.list.forEach((item, i) => {
          if (item && item.injectInput === true && String(item.display || '').trim()) {
            parts.push('【自由栏位-列表#' + i + '】\n' + String(item.display).trim())
          }
        })
      }
      if (parts.length === 0) return decision
      const appended = '---\n' + parts.join('\n\n---\n')
      // 在一条消息文本末尾追加（string 与 text-block 两种 content 形态都处理）
      const appendTo = (m) => {
        if (typeof m?.content === 'string') {
          return { ...m, content: (m.content ? m.content + '\n\n' : '') + appended }
        }
        if (Array.isArray(m?.content)) {
          const last = m.content[m.content.length - 1]
          if (last && last.type === 'text' && typeof last.text === 'string') {
            const cp = m.content.slice()
            cp[cp.length - 1] = { ...last, text: (last.text ? last.text + '\n\n' : '') + appended }
            return { ...m, content: cp }
          }
        }
        return m
      }
      const isUserMessage = (m) => m && m.role === 'user' && m.source && m.source.kind === 'user'
      // ① 原始批次（payload.messages）：tavern userTextOf 读这里 → 渲染的用户输入帧含注入
      let payloadIdx = -1
      const raw = Array.isArray(payload.messages) ? payload.messages : []
      for (let i = raw.length - 1; i >= 0; i--) {
        if (isUserMessage(raw[i])) { payloadIdx = i; break }
      }
      if (payloadIdx >= 0) raw[payloadIdx] = appendTo(raw[payloadIdx])
      // ② 决策批次（decision.messages）：其他消费方（agent loop 组装 / 非 tavern 会话）一致性
      const msgs = Array.isArray(decision.messages) ? decision.messages : []
      let decisionIdx = -1
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        // V4 适配：plugin 类消息 source.kind 在 V4 为 'plugin:<name>'（如 'plugin:dsh-tavern'），
        // 不再是裸 'plugin'。用 startsWith('plugin') 同时覆盖 V3/V4，避免把 tavern 注入消息
        // 误判为真实用户输入、把 free_slots 注入错挂到插件消息上。
        if (m && m.role === 'user' && !(m.source && typeof m.source.kind === 'string' && m.source.kind.startsWith('plugin'))) { decisionIdx = i; break }
      }
      if (decisionIdx >= 0) {
        const out = msgs.slice()
        out[decisionIdx] = appendTo(msgs[decisionIdx])
        naDbg('free_slots user-message injected', { sessionId: sessionId.slice(0, 20), payloadIdx, decisionIdx, appended: appended.slice(0, 60) })
        return { ...decision, messages: out }
      }
      naDbg('free_slots user-message injected (payload only)', { sessionId: sessionId.slice(0, 20), payloadIdx, appended: appended.slice(0, 60) })
      return decision
    } catch (e) {
      console.error('[narrative-anchor] free_slots pre-step inject failed:', e && e.message || e)
      return decision
    }
  }, { global: true })

  // 2. v2 官方 API 结算（2026-10-09 去补丁化组合方案）：
  //    - 非 MVU 卡：replaceSettlement 接管 —— settle 内单次结构化输出锚点提交 JSON，
  //      提交成功即返回 posture（官方"接管即结束" = 用户要求的"锚点提交即终止"）；
  //      失败/超时/无模型配置 → 抛错自动退回官方结算。
  //    - MVU 卡：settlementTool 参与官方 MVU 结算（read/submit 工具，提交即落库自持文件）。
  //    - 纯工具注入路径的上下文：settlementSection 四段（锚点快照 / LTM 动态提示 /
  //      自由栏位注入后台 / 后台指导），官方拼进【插件附加的结算任务】；
  //      静态提交规则按 2026-10-10 拍板不注入（工具 schema / 系统提示承载）。
  // 调试日志位置由 paths.js 解析（<DataDir>/desktop/logs），无结果时静默跳过
  const naDbg = (...parts) => {
    const line = new Date().toISOString() + ' [NA-v2] ' + parts.map(p => typeof p === 'string' ? p : (() => { try { return JSON.stringify(p) } catch { return String(p) } })()).join(' ') + '\n'
    appendRotatingLogSync(desktopLogFile('na-debug.log'), line, { maxBytes: 8 * 1024 * 1024, keep: 3 })
  }
  ctx.effect(() => {
    const tavern = ctx.tavern
    if (!tavern) return
    naDbg('effect entered', { replaceSettlement: typeof tavern.replaceSettlement, settlementTool: typeof tavern.settlementTool, settlementSection: typeof tavern.settlementSection })
    const official = createOfficialSettlement({ config, ctx, tavern })
    // 供 HTTP API 使用（后台会话清空/信息；两个 effect 作用域不同，经闭包变量传出）
    officialApi = official
    const disposers = []
    if (typeof tavern.replaceSettlement === 'function') {
      // 包装 settle：先注入本轮 turn（llm/stream 的 options 不带轮次，audit 需它写 DSHT 请求日志），
      // 再原样转交官方结算；setTurn 失败不影响结算。
      disposers.push(tavern.replaceSettlement({ settle: async (args) => {
        try { requestAudit.setTurn(args?.gameId, args?.turn) } catch (e) { naDbg('setTurn failed', str(e?.message || e)) }
        // v3.0：用 AsyncLocalStorage 标记后台结算上下文，使 request-audit 的 llm/stream 钩子
        // 能识别并记录请求体（官方结算 sessionId 带 background- 前缀，旧 na-background- 过滤已失效）。
        return requestAudit.runBackground(args?.gameId, args?.turn, () => official.settle(args))
      } }))
      naDbg('registered replaceSettlement')
    } else {
      naDbg('replaceSettlement API missing')
    }
    // settlementTool 包装：刷新审计轮次。setTurn 原只在 replaceSettlement 包装里调用，
    // 纯工具注入路径（MVU 官方结算）下 stateByGame 会停留在上一次接管结算的旧轮次。
    for (const tool of official.tools) {
      if (typeof tavern.settlementTool === 'function') {
        disposers.push(tavern.settlementTool({
          ...tool,
          async execute(args) {
            try { requestAudit.setTurn(args?.gameId, args?.turn) } catch (e) { naDbg('setTurn failed', str(e?.message || e)) }
            return tool.execute(args)
          }
        }))
        naDbg('registered settlementTool', tool.name)
      }
    }
    // 结算说明段落（settlementSection）——纯工具注入路径的上下文来源：官方
    // background-agent-task 把它们拼进【插件附加的结算任务】（task:'settlement'，
    // MVU 结算与非 MVU 官方兜底都走这里）。静态提交规则按 2026-10-10 拍板不注入
    // （工具 schema / 结算系统提示已承载）；这里只补 settle 任务消息有、工具路径
    // 此前缺失的四段（与 settle 任务消息同序）：
    //   1-anchor-snapshot  锚点快照（read 工具不返回 current_state，结算模型需要它）
    //   1b-backend-protocol  酒馆后台叙事锚定结算协议（单段，紧跟快照之后；见下）
    //   2-ltm-hints        LTM 动态 ⚠ 提示（到阈值的催促；强制校验在 submit 内）
    //   3-free-slots       自由栏位「注入后台」元素
    //   4-background-guide 后台指导（按会话保存 meta.settings.backgroundGuide，为空整段不出现）
    // 名称带序号前缀：官方 collectSections 按 owner+name 字典序输出，序号即注入顺序。
    // ⚠ text 必须收 { gameId } 再下传：官方以 text({gameId,turn}) 调用；曾因无参调用
    //    official.guideSection() 在其内解构 undefined 抛 TypeError，被官方 catch 后
    //    recordError + 静默跳过整段——【后台指导】在 MVU 路径每轮失效（2026-10-17 修）。
    if (typeof tavern.settlementSection === 'function') {
      const sectionDefs = [
        ['narrative-anchor.1-anchor-snapshot', official.anchorSnapshotSection],
        ['narrative-anchor.2-ltm-hints', official.ltmHintsSection],
        ['narrative-anchor.3-free-slots', official.freeSlotsSection],
        ['narrative-anchor.4-background-guide', official.guideSection]
      ]
      // 酒馆后台叙事锚定结算协议：单个 settlementSection（2026-10-21 用户拍板去拆分——默认协议仅
      // 三百余字，一段足够；官方单段上限 8000 字，超长截断风险由 backendProtocolSection 内 dbg 诊断）。
      // text 实时读全局配置，运行时改协议即时生效（单段无注册段数约束，增删行无需重启）。
      if (typeof official.backendProtocolSection === 'function') {
        const anchorIdx = sectionDefs.findIndex(([n]) => n === 'narrative-anchor.1-anchor-snapshot')
        sectionDefs.splice(anchorIdx + 1, 0, ['narrative-anchor.1b-backend-protocol', official.backendProtocolSection])
      }
      for (const [name, fn] of sectionDefs) {
        if (typeof fn !== 'function') continue
        disposers.push(tavern.settlementSection({ name, text: (context) => fn(context) }))
        naDbg('registered settlementSection', name)
      }
    }
    return () => {
      disposers.forEach(dispose => dispose())
      void Promise.resolve(official.disposeResidents?.())
    }
  }, 'narrative-anchor: official settlement')

  // 2b-foreground: 注册前台工具 narrative_anchor_read（正文生成时 LLM 可检索锚点记忆）
  // 与后台工具同名但独立执行：前台直接读自持文件搜索，不走编排器
  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') return
    const dispose = tools.register({
      name: NARRATIVE_ANCHOR_READ_TOOL.name,
      description: NARRATIVE_ANCHOR_READ_TOOL.description,
      parameters: NARRATIVE_ANCHOR_READ_TOOL.parameters,
      // dsh-tools 新版校验要求声明 output { schema, render }；execute 返回对象，render 转 JSON 文本
      output: {
        schema: {
          type: 'object', additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            query: { type: 'string' },
            kind: { type: 'string' },
            total: { type: 'number' },
            returned: { type: 'number' },
            results: { type: 'array', items: { type: 'object', additionalProperties: true } },
            note: { type: 'string' },
            error: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        try {
          const query = args?.query || ''
          if (!query) return { ok: false, error: 'query 不能为空' }
          const kind = args?.kind === 'stm' || args?.kind === 'known_facts' ? args.kind : 'all'
          const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
          // 从 exec 上下文获取当前会话 ID，读自持锚点文件；无文件时回退
          // chat.narrativeAnchor（fork 从主线克隆的 chat 层副本，与 Memory Snapshot
          // 注入路径 line~296 同一数据源——否则支线首轮检索恒空而注入却有数据）
          const sessionId = exec?.agent?.session?.id || exec?.ctx?.session?.id || ''
          let anchor = null
          if (sessionId) {
            try { anchor = readAnchor(sessionId) } catch (e) { anchor = null }
          }
          if (!anchor) {
            try { anchor = getChatFromSession(ctx, sessionId)?.narrativeAnchor || null } catch (e) { anchor = null }
          }
          if (!anchor) return { ok: true, query, results: [], total: 0, note: '尚无叙事锚定数据' }
          const { results, total } = searchAnchorMemory(anchor, query, kind, limit)
          return { ok: true, query, kind, total, returned: results.length, results }
        } catch (e) {
          return { ok: false, error: e && e.message || String(e) }
        }
      }
    })
    return typeof dispose === 'function' ? dispose : undefined
  }, 'narrative-anchor: foreground read tool')

  // 2c. 会话临时世界书条目池（v3.0 · 官方 plugin-api v2 worldbookEntries —— 替代旧补丁 merger）
  //     NA 条目进官方世界书条目池，由 Tavern 召回决定是否入请求：
  //     关键词激活 / 常驻 / 冷却 / 筛选复审 / 后台结算 / 候选 / Agent 查世界书 全部官方原生
  //     （官方 main 起 playWorldBook 统一并入 worldbookPoolEntries；42852b0 未接入消费链，
  //     需运行时升级到官方 main 后生效）。
  //     两个固定来源（官方每来源 ≤200 条；id 仅 [A-Za-z0-9._-] ≤64 字；纯文本，EJS 跳过）：
  //       'session' — 会话临时条目（非 constant）+ 支线条目 + 人工选择（force:true 强制入选）
  //       'bound'    — 会话级绑定世界书条目（constant 常驻传官方 constant）
  //     常量条目（constant=true / Persona）仍由 injectConstantWbEntriesToPrefix 前缀注入（零补丁）。
  //     已知缺口：勾选官方世界书条目（entry:N ref）的强制注入官方暂不提供
  //     （worldbookEntries 的 force 只作用于插件条目），已在 issue《接口需求-世界书条目注入.md》标注。
  ctx.effect(() => {
    const tavern = ctx.tavern
    if (!tavern || typeof tavern.worldbookEntries !== 'function') return
    const disposers = []

    const safeId = (raw) => String(raw || 'x').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'x'
    const keyList = (list) => (Array.isArray(list) ? list : []).filter(k => typeof k === 'string' && k.trim()).slice(0, 50).map(k => k.trim().slice(0, 200))
    const clip = (text) => String(text || '').trim().slice(0, 4000) // 官方 MAX_WORLDBOOK_ENTRY，超长被跳过并报问题
    const dataRoot = () => resolveTavernDataRoot()

    // 来源 1：会话临时条目 + 人工选择 force
    disposers.push(tavern.worldbookEntries({
      name: 'session',
      entries: async ({ gameId }) => {
        const book = readSessionWorldbook(String(gameId || ''))
        if (!book || book.enabled === false) return []
        const selection = new Set(Array.isArray(book.selection) ? book.selection.map(String) : [])
        const out = []
        for (const e of (Array.isArray(book.entries) ? book.entries : [])) {
          if (!e || e.enabled === false) continue
          if (e.constant === true) continue // 常驻走前缀注入
          const content = String(e.content || '').trim()
          if (!content) continue
          out.push({
            id: safeId('e' + e.id),
            title: e.title || '',
            keys: keyList(e.keys || e.key),
            secondaryKeys: keyList(e.keysecondary),
            content: clip(content),
            force: selection.has(String(e.id)) || selection.has('session-wb:' + e.id)
          })
        }
        return out
      }
    }))

    // 来源 2：会话级绑定世界书条目
    disposers.push(tavern.worldbookEntries({
      name: 'bound',
      entries: async ({ gameId }) => {
        const book = readSessionWorldbook(String(gameId || ''))
        if (!book || book.enabled === false) return []
        const boundRes = boundWorldbookEntries(book, dataRoot())
        const selection = new Set(Array.isArray(book.selection) ? book.selection.map(String) : [])
        return boundRes.entries
          .filter(e => e && String(e.content || '').trim())
          .map(e => ({
            id: safeId(String(e.ref || '').replace(/[^A-Za-z0-9._-]/g, '_')), // bound:0:1 → bound_0_1
            title: e.title || '',
            keys: keyList(e.keys),
            secondaryKeys: keyList(e.secondaryKeys),
            content: clip(String(e.content).trim()),
            constant: e.constant === true,
            force: selection.has(String(e.ref))
          }))
      }
    }))

    // 人工选择一次性消费：正文写完后清空 selection（等价原 merger 的 generation 消费语义；
    // 不清空时官方 force 条目按 ref 冷却 10 轮，语义不符"只注入下一次回复"）
    if (typeof tavern.onTurnSettled === 'function') {
      disposers.push(tavern.onTurnSettled(async ({ gameId }) => {
        const book = readSessionWorldbook(String(gameId || ''))
        if (book && Array.isArray(book.selection) && book.selection.length > 0) {
          book.selection = []
          writeSessionWorldbook(book)
        }
      }))
    }

    return () => disposers.forEach(d => { try { d() } catch { /* ignore */ } })
  }, 'narrative-anchor: worldbookEntries')

  // 4. 注册 HTTP API 路由（effect 内取服务，模式与 tavern-plugin 一致）
  ctx.effect(() => {
    const webServer = ctx.get('webServer')
    if (!webServer) return
    return webServer.register({
      kind: 'prefix',
      path: '/api/narrative-anchor',
      handler: async (req, res) => {
        const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
        const method = pathname.replace('/api/narrative-anchor/', '')
        let body = {}
        if (req.method === 'POST') {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch { body = {} }
        }
        // v0.7.3：readChatFromDisk（sessions.json 精确映射 sid→chatId→snapshot）优先；
        // getChatFromSession 的 ctx.sessions 在多会话/主从会话场景会返回错误 chat（cardPath 缺失），不再优先。
        const chat = readChatFromDisk(resolveTavernDataRoot(), body.sessionId) || getChatFromSession(ctx, body.sessionId) || readLatestChatFromDisk(resolveTavernDataRoot())
        const sendJson = (data, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify(data))
        }
        try {
          switch (method) {
            case 'list': {
              // v3.0：TEP 补丁已移除——扩展点注册表固定为空（保留端点供诊断兼容）
              return sendJson({ ok: true, registry: { sessionWorldbook: [] }, note: '扩展点已全部移除（官方 plugin-api v2 原生）' })
            }
            case 'getConfig': {
              // v0.6.7：以插件自持文件为权威源（零 DSHT 依赖），不再读内存 chat
              const anchor = readAnchor(body.sessionId) || loadAnchor(chat || {})
              const settings = anchor.meta.settings || {}
              // v2（2026-10-10）：结算提示词改全局共享（data/anchors/global.json），设置页拆
              // "会话设置 + 全局设置"两块；提示词不再按会话保存。text 恒为"当前生效值"，
              // customized 标志区分已修改/默认（未配置时返回默认值，界面显示默认，参考 DSHT 系统提示词页）。
              const global = readGlobalSettings() || {}
              const gPersona = typeof global.settlePersona === 'string' && global.settlePersona !== '' ? global.settlePersona : SETTLE_PERSONA
              const gTask = typeof global.settleTaskPrompt === 'string' && global.settleTaskPrompt !== '' ? global.settleTaskPrompt : DEFAULT_TASK_PROMPT
              const gProtocol = typeof global.backendSettleProtocol === 'string' && global.backendSettleProtocol !== '' ? global.backendSettleProtocol : DEFAULT_BACKEND_SETTLE_PROTOCOL
              // 后台指导（2026-10-10 用户拍板：按会话保存、默认为空不注入）：存会话锚点
              // meta.settings.backgroundGuide，不在 globalSettings；未配置返回 ''（界面空、结算不注入）。
              const gGuide = typeof settings.backgroundGuide === 'string' && settings.backgroundGuide !== '' ? settings.backgroundGuide : ''
              return sendJson({ ok: true, settings: { enabled: settings.enabled !== false, maxSTMLength: settings.maxSTMLength || config.maxSTMLength, injectPosition: settings.injectPosition || config.injectPosition, projectionReplace: settings.projectionReplace === true, skipAllPresentLtm: settings.skipAllPresentLtm !== false, backgroundGuide: gGuide, backgroundGuideCustomized: settings.backgroundGuide !== undefined && settings.backgroundGuide !== '' }, globalSettings: { settlePersona: gPersona, settlePersonaCustomized: global.settlePersona !== undefined && global.settlePersona !== '', settleTaskPrompt: gTask, settleTaskPromptCustomized: global.settleTaskPrompt !== undefined && global.settleTaskPrompt !== '', backendSettleProtocol: gProtocol, backendSettleProtocolCustomized: global.backendSettleProtocol !== undefined && global.backendSettleProtocol !== '', blockBackgroundCompaction: global.blockBackgroundCompaction === true, deleteBackgroundSessionOnBlock: global.deleteBackgroundSessionOnBlock !== false }, stats: getAnchorStats(anchor) })
            }
            case 'requestLog': {
              // v2.3：结算请求体审计查询（内存缓冲尾部，可带 sessionId 过滤）
              const sidFilter = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : ''
              const limit = Number.isFinite(body.limit) ? Math.max(1, Math.min(body.limit, 60)) : 20
              let entries = requestAudit.list(limit)
              if (sidFilter) entries = entries.filter((e) => e.sessionId === sidFilter)
              return sendJson({ ok: true, path: requestAudit.path(), total: entries.length, entries })
            }
            case 'backgroundSessionInfo': {
              // v0.10.5：后台结算会话信息（状态页显示大小/是否存在/是否在结算中）
              if (!officialApi || typeof officialApi.backgroundSessionInfo !== 'function') {
                return sendJson({ ok: false, error: '结算模块未就绪' })
              }
              return sendJson(officialApi.backgroundSessionInfo(body.sessionId))
            }
            case 'clearBackgroundSession': {
              // v0.10.5：清空后台结算会话历史（解决后台无压缩导致的日志膨胀）——
              // dispose 常驻 handle + 删除持久化会话目录；下次结算自动新建空会话。
              if (!officialApi || typeof officialApi.clearBackgroundSession !== 'function') {
                return sendJson({ ok: false, error: '结算模块未就绪' })
              }
              return sendJson(await officialApi.clearBackgroundSession(body.sessionId))
            }
            case 'nativeBackgroundSessionsInfo': {
              // v3.4：DSHT 原生后台会话（background-*）信息（数量/总大小）
              if (!officialApi || typeof officialApi.nativeBackgroundSessionsInfo !== 'function') {
                return sendJson({ ok: false, error: '结算模块未就绪' })
              }
              return sendJson(officialApi.nativeBackgroundSessionsInfo())
            }
            case 'settlementModelInfo': {
              // v3.6：输入框处 NA 后台模型标签数据源（最近一次结算实际使用的 provider/model/强度；
              // 进程重启后回退 per-chat 后台模型配置）。只读，不触发任何结算。
              if (!officialApi || typeof officialApi.settlementModelInfo !== 'function') {
                return sendJson({ ok: false, error: '结算模块未就绪' })
              }
              return sendJson(officialApi.settlementModelInfo(body.sessionId))
            }
            case 'clearNativeBackgroundSessions': {
              // v3.4：清空所有 DSHT 原生后台会话（background-*）——官方后台任务下次运行自动新建
              if (!officialApi || typeof officialApi.clearNativeBackgroundSessions !== 'function') {
                return sendJson({ ok: false, error: '结算模块未就绪' })
              }
              return sendJson(await officialApi.clearNativeBackgroundSessions())
            }
            case 'paths': {
              // v0.10：全部由 paths.js 推导，无一处写死的机器路径。
              const local = rel => { try { return fileURLToPath(new URL(rel, import.meta.url)) } catch { return '' } }
              const exists = p => { try { return existsSync(p) } catch { return false } }
              const dataRoot = resolveTavernDataRoot()
              // 正向拼接替代"上溯 3 级"：DataDirectory → harness/profiles/tavern/node_modules/<插件名>
              const dataDir = installDataDir()
              const junctionPath = dataDir
                ? join(dataDir, 'harness', 'profiles', 'tavern', 'node_modules', name)
                : ''
              const devRoot = pluginRoot()
              return sendJson({
                ok: true,
                paths: {
                  pluginEntry: { path: local('./index.js'), desc: '插件主入口：工具注册、后台结算/前台注入装配' },
                  clientEntry: { path: local('./client.js'), desc: '设置页/状态页 UI（本页面）' },
                  settlementStrategies: { path: local('./settlement/strategies.js'), desc: '锚点提交/检索工具定义（narrative_anchor_submit schema）、注入文案' },
                  settlementStore: { path: local('./settlement/store.js'), desc: '结算存储：LTM 归并、锚点统计' },
                  sessionWorldbook: { path: local('./session-worldbook.js'), desc: '会话临时世界书（合并/同步）' },
                  anchorsDir: { path: join(pluginDataDir(), 'anchors'), desc: '锚点数据存储（<插件数据区>/anchors/<sessionId>.json）' },
                  sessionWorldbooksDir: { path: join(pluginDataDir(), 'session-worldbooks'), desc: '会话临时世界书存储' },
                  patchSource: { path: join(devRoot, 'patches', 'tavern-plugin'), desc: 'DSHT 扩展注册点补丁权威源（修改入口，禁止直接改运行时）' },
                  tavernDataRoot: { path: dataRoot, desc: 'DSH 用户数据根（角色卡/世界书/对话快照）' },
                  junctionPath: { path: junctionPath, desc: exists(junctionPath) ? 'profile 安装位（junction，指向开发目录）' : '', present: exists(junctionPath) },
                },
              })
            }
            case 'setConfig': {
              // v0.6.7：设置持久化到自持文件（权威源），立即生效且重启不丢
              const anchor = readAnchor(body.sessionId) || loadAnchor(chat || {})
              if (!anchor.meta.settings) anchor.meta.settings = {}
              if (typeof body.maxSTMLength === 'number') anchor.meta.settings.maxSTMLength = Math.max(1, Math.min(50, Math.floor(body.maxSTMLength)))
              if (typeof body.injectPosition === 'string') anchor.meta.settings.injectPosition = body.injectPosition
              if (typeof body.enabled === 'boolean') anchor.meta.settings.enabled = body.enabled
              if (typeof body.projectionReplace === 'boolean') anchor.meta.settings.projectionReplace = body.projectionReplace
              if (typeof body.skipAllPresentLtm === 'boolean') anchor.meta.settings.skipAllPresentLtm = body.skipAllPresentLtm
              // 后台指导（2026-10-10 用户拍板按会话保存）：写入本会话锚点 meta.settings.backgroundGuide；
              // 空串=清除（回默认）。不再写 global.json。
              if (typeof body.backgroundGuide === 'string') {
                if (body.backgroundGuide === '') delete anchor.meta.settings.backgroundGuide
                else anchor.meta.settings.backgroundGuide = body.backgroundGuide
              }
              // v2（2026-10-10）：结算提示词是全局共享配置（global.json），不再写会话文件；
              // 空串=清除（回代码默认）；字符串原样持久化，结算侧每轮读全局文件实时生效。
              // v3.1（2026-10-10）：blockBackgroundCompaction 同存 global.json——
              // true（默认）= 拦截后台会话压缩，删除字段回默认；false = 落盘关闭拦截。
              // v3.5（2026-10-15）：deleteBackgroundSessionOnBlock——拦截命中时顺带删除
              // 对应后台会话目录，默认 true（未配置/删字段均视为开启）；仅拦截开启时生效。
              if (typeof body.settlePersona === 'string' || typeof body.settleTaskPrompt === 'string' || typeof body.backendSettleProtocol === 'string' || typeof body.blockBackgroundCompaction === 'boolean' || typeof body.deleteBackgroundSessionOnBlock === 'boolean') {
                const global = readGlobalSettings() || {}
                if (typeof body.settlePersona === 'string') {
                  if (body.settlePersona === '') delete global.settlePersona
                  else global.settlePersona = body.settlePersona
                }
                if (typeof body.settleTaskPrompt === 'string') {
                  if (body.settleTaskPrompt === '') delete global.settleTaskPrompt
                  else global.settleTaskPrompt = body.settleTaskPrompt
                }
                if (typeof body.backendSettleProtocol === 'string') {
                  if (body.backendSettleProtocol === '') delete global.backendSettleProtocol
                  else global.backendSettleProtocol = body.backendSettleProtocol
                }
                if (typeof body.blockBackgroundCompaction === 'boolean') {
                  // 默认 false（2026-10-20 起）：true → 显式落盘，false → 删字段回默认。
                  if (body.blockBackgroundCompaction) global.blockBackgroundCompaction = true
                  else delete global.blockBackgroundCompaction
                }
                // 默认 true：true → 删字段回默认，false → 显式落盘。
                // 与 blockBackgroundCompaction（默认 false）方向相反——各自的"删字段回默认"必须以各自默认值为准。
                if (typeof body.deleteBackgroundSessionOnBlock === 'boolean') {
                  if (body.deleteBackgroundSessionOnBlock) delete global.deleteBackgroundSessionOnBlock
                  else global.deleteBackgroundSessionOnBlock = false
                }
                global.updated_at = Date.now()
                writeGlobalSettings(global)
              }
              if (body.reset === true) { anchor.plot_route = { current_node: '', recap: '', next_scene: '', foreshadowing: [] }; anchor.current_state = { time: '', world: '', location: '', characters: [], environment: [], items: [] }; anchor.free_slots = { list: [] }; anchor.memory = { stm: [], ltm: [], ltm_tree: { nodes: {}, roots: [], next_id: 1 }, ltm_snapshot: { content: '', turn: 0 }, known_facts: [], foreshadow_library: [] } }
              anchor.meta.updated_at = Date.now()
              writeAnchor(body.sessionId, anchor)
              // 写盘日志：记录收到/持久化的设置字段（保存链路可追踪；含提示词长度，丢失时据此召回）
              naDbg('setConfig persisted', {
                sessionId: body.sessionId,
                keys: Object.keys(anchor.meta.settings || {}),
                received: Object.keys(body).filter(k => k !== 'sessionId'),
                personaLen: typeof body.settlePersona === 'string' ? body.settlePersona.length : -1,
                taskLen: typeof body.settleTaskPrompt === 'string' ? body.settleTaskPrompt.length : -1,
                protocolLen: typeof body.backendSettleProtocol === 'string' ? body.backendSettleProtocol.length : -1,
              })
              return sendJson({ ok: true, note: '设置已更新并持久化' })
            }
            case 'getData': {
              // v0.6.6：优先读插件自持数据文件（零 DSHT 依赖）；无文件回退运行时 chat
              const anchor = readAnchor(body.sessionId) || (chat && chat.narrativeAnchor) || null
              if (!anchor) return sendJson({ ok: true, anchor: null, display: '（暂无数据）' })
              return sendJson({ ok: true, anchor, display: formatAnchorForInjection(anchor) })
            }
            case 'debug/candidates': {
              // [v3.0] 候选项链路诊断：运行时 chat 候选态（TEP 已移除，不再读扩展点）
              const ops = {}
              try {
                for (const [k, v] of Object.entries(chat?.timeline?.operations || {})) {
                  ops[k] = { kind: v?.kind || null, role: v?.role || null, status: v?.status || null, requestId: v?.requestId || null, successful: v?.successful }
                }
              } catch { /* timeline 结构差异忽略 */ }
              return sendJson({
                ok: true,
                chatId: chat?.id || null,
                sessionId: chat?.sessionId || body.sessionId || null,
                mode: chat?.mode ?? null,
                chatKeys: chat ? Object.keys(chat).slice(0, 80) : null,
                settleStatus: chat?.settleStatus ?? null,
                chatCandidates: chat?.candidates ?? null,
                operations: ops,
                providerRegistered: null,
                tepDebug: null
              })
            }
            case 'updateData': {
              // v0.9.0：人工编辑锚点数据（current_state / stm / ltm_tree / known_facts）
              // body.data 为完整的 anchor 对象或部分字段（部分字段时合并）
              // v0.9.1：修复内存覆盖问题——写入文件后必须同步更新内存 chat.narrativeAnchor，
              //         否则后续结算从内存读取旧数据会覆盖文件中的界面编辑修改
              const anchor = readAnchor(body.sessionId) || loadAnchor(chat || {})
              if (!body.data || typeof body.data !== 'object') {
                return sendJson({ ok: false, error: '缺少 data 参数' }, 400)
              }
              const incoming = body.data
              // 合并顶层字段
              if (incoming.current_state && typeof incoming.current_state === 'object') anchor.current_state = incoming.current_state
              // v0.10.4：自由栏位编辑（人工保存列表与注入开关；仅保留 list）
              if (incoming.free_slots && typeof incoming.free_slots === 'object') {
                const prevFs = anchor.free_slots && typeof anchor.free_slots === 'object' ? anchor.free_slots : {}
                const prevList = Array.isArray(prevFs.list) ? prevFs.list : []
                anchor.free_slots = {
                  ...prevFs,
                  list: Array.isArray(incoming.free_slots.list)
                    ? incoming.free_slots.list.map(x => x && typeof x === 'object' && !Array.isArray(x)
                        ? {
                            display: typeof x.display === 'string' ? x.display : '',
                            injectForeground: x.injectForeground === true,
                            injectInput: x.injectInput === true,
                            injectBack: x.injectBack === true
                          }
                        : { display: '', injectForeground: false, injectInput: false, injectBack: false })
                    : prevList
                }
              }
              if (incoming.memory && typeof incoming.memory === 'object') {
                if (Array.isArray(incoming.memory.stm)) anchor.memory.stm = incoming.memory.stm
                if (incoming.memory.ltm_tree && typeof incoming.memory.ltm_tree === 'object') anchor.memory.ltm_tree = incoming.memory.ltm_tree
                if (Array.isArray(incoming.memory.known_facts)) anchor.memory.known_facts = incoming.memory.known_facts
              }
              // 重新计算 LTM 快照
              updateLtmSnapshot(anchor)
              anchor.meta.updated_at = Date.now()
              writeAnchor(body.sessionId, anchor)
              // 同步更新内存中的 chat.narrativeAnchor（防止后续结算用内存旧数据覆盖文件）
              if (chat && typeof chat === 'object') {
                chat.narrativeAnchor = anchor
              }
              return sendJson({ ok: true, note: '锚点数据已更新（文件+内存已同步）', stats: getAnchorStats(anchor) })
            }
            case 'getPosture': {
              // 从内存会话读取当前姿势描述（chat.posture 纯字符串字段）；
              // 不读磁盘（readChatFromDisk 有 .json.gz 缺陷），内存无数据时返回空结构。
              const memChat = getChatFromSession(ctx, body.sessionId)
              if (memChat && typeof memChat.posture === 'string') {
                return sendJson({
                  ok: true,
                  posture: memChat.posture,
                  postureEnabled: memChat.backgroundTasks?.posture !== false,
                  lastSettle: memChat.lastSettle || null
                })
              }
              return sendJson({ ok: true, posture: '', postureEnabled: true, lastSettle: null, note: '当前会话无内存 chat 数据' })
            }
            // ── v0.7：人工世界书管理系统 ──
            case 'worldbook/list': {
              return sendJson({ ok: true, sessions: listSessionWorldbooks() })
            }
            // ── v0.9.16 支线系统 ──
            case 'branch/prepare': {
              // 为"创建支线"准备官方 fork 三步所需的参数：chatId + 最新完成轮。
              // 内存 chat 可能是未完全加载的骨架（消息缺 turn → 误算成第 1 轮，fork 出空会话），
              // 主从场景还可能拿错会话——因此磁盘快照与内存 chat 都算 turn，取最大值
              const sid = body.sessionId
              const dataRoot = resolveTavernDataRoot()
              const diskChat = readChatFromDisk(dataRoot, sid)
              const memChat = getChatFromSession(ctx, sid)
              const candidates = []
              if (memChat && String(memChat.sessionId) === String(sid)) candidates.push(memChat)
              if (diskChat && String(diskChat.sessionId) === String(sid)) candidates.push(diskChat)
              const chatData = candidates[0]
              if (!chatData) return sendJson({ ok: false, error: '找不到会话对应的对话数据' }, 404)
              let latestTurn = 0
              let cardName = ''
              for (const c of candidates) {
                cardName = cardName || c.cardName || ''
                for (const m of (Array.isArray(c.messages) ? c.messages : [])) {
                  const t = Number(m?.turn) || 0
                  if (t > latestTurn) { latestTurn = t; cardName = c.cardName || cardName }
                }
              }
              if (latestTurn === 0) return sendJson({ ok: false, error: '会话尚无已完成的回合，无法创建支线' }, 400)
              return sendJson({ ok: true, chatId: chatData.id, sessionId: chatData.sessionId, turn: latestTurn, cardName })
            }
            case 'branch/register': {
              try {
                const sid = String(body.sessionId || '')
                const parentSid = String(body.parentSid || '')
                if (!sid || !parentSid) return sendJson({ ok: false, error: '需要 sessionId 与 parentSid' }, 400)
                const familyId = String(body.familyId || '') || rootOf(parentSid)
                const member = registerBranch({ sessionId: sid, familyId, parentSid, label: body.label })
                // 创建支线结束时清空支线锚点信息：不继承 fork 继承的 chat.narrativeAnchor 主线数据。
                // ① 清空支线 chat 的 narrativeAnchor（结算 loadAnchor 的数据源）
                // ② 写空锚点文件（readAnchor 的数据源），避免 readAnchor 回退到 chat.narrativeAnchor。
                // 支线从空锚点开始独立演化，避免继承主线锚点造成的已知情报/LTM 重复。
                const emptyAnchor = () => ({
                  plot_route: { current_node: '', recap: '', next_scene: '', foreshadowing: [] },
                  current_state: { time: '', world: '', location: '', characters: [], environment: [], items: [], focus: '', focus_full: '' },
                  memory: {
                    stm: [],
                    ltm_tree: { nodes: {}, roots: [], next_id: 1 },
                    ltm_snapshot: { content: '', turn: 0 },
                    known_facts: [],
                    foreshadow_library: []
                  },
                  meta: { turn_count: 0, created_at: Date.now() }
                })
                try {
                  const chat = getChatFromSession(ctx, sid)
                  if (chat) chat.narrativeAnchor = emptyAnchor()
                } catch { /* 拿不到会话 chat 时仅写空锚点文件 */ }
                writeAnchor(sid, emptyAnchor())
                // 创建支线即拉取族内已有【支线】条目（避免新支线起步为空、需自行结算才出现）
                try { syncSidelineEntries(sid) } catch { /* 无族关联时静默 */ }
                return sendJson({ ok: true, member, familyId })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/inspectSessions': {
              try {
                const sessions = ctx.get('sessions')
                const agents = ctx.get('agents')
                const sid = String(body.sessionId || '')
                const sess = (agents?.get?.(sid)?.session) || sessions?.get?.(sid)
                if (!sess) return sendJson({ ok: true, found: false })
                const sessIdent = { sid, hasSeq: sess.seq, sessionId: sess.sessionId || sess.id || null, chatId: sess.chatId || null }
                let events = []
                try {
                  events = (typeof sess.snapshotEvents === 'function' ? sess.snapshotEvents() : (Array.isArray(sess.events) ? sess.events : [])).map(e => ({
                    seq: e.seq, type: e.type, turn: e.data?.turn, step: e.data?.step,
                    id: e.data?.message?.id || e.data?.id,
                    text: (e.data?.message?.content?.[0]?.text || e.data?.content?.[0]?.text || '').slice(0, 80),
                    surfaceOp: e.surfaceOp
                  }))
                } catch (e) { events = [{ error: String(e) }] }
                let surface = null
                try {
                  const nodes = sess.surface?.nodes
                  surface = Array.isArray(nodes) ? nodes.map(n => {
                    const t = typeof n
                    if (t === 'object') return { keys: Object.keys(n).slice(0, 12), seq: n.seq, type: n.type || n.kind || null }
                    return n
                  }) : String(nodes)
                } catch (e) { surface = 'error: ' + e.message }
                let derived = null
                try {
                  if (typeof sess.deriveMessages === 'function') {
                    derived = sess.deriveMessages().map(m => ({
                      role: m.role, id: m.id, source: m.source?.kind,
                      text: String(m.content?.[0]?.text || m.text || '').slice(0, 60)
                    })).slice(-8)
                  }
                } catch (e) { derived = 'error: ' + e.message }
                return sendJson({ ok: true, found: true, sessIdent, seq: sess.seq, events: events.slice(-15), surface, derived })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 500)
              }
            }
            case 'branch/injectGreeting': {
              try {
                const sid = String(body.sessionId || '')
                const text = String(body.text || '')
                if (!sid || !text) return sendJson({ ok: false, error: '需要 sessionId 与 text' }, 400)
                const sessions = ctx.get('sessions')
                const agents = ctx.get('agents')
                const session = (agents?.get?.(sid)?.session) || sessions?.get?.(sid)
                if (!session) return sendJson({ ok: false, error: '找不到 session（agents/sessions 均未命中）' }, 404)
                const msgId = 'branch-greeting:' + Date.now()
                // 官方机制对齐（conversation-initialization.js appendNativeOpening 双写模式）：
                // 1) 会话层：完整合成轮 turn/start(N) → step/start → assistant/message → step/end →
                //    turn/end；V3 给 assistant data 补 stream: []。（裸 turn:0 曾致历史加载崩溃）
                // 2) chat 层：界面气泡只渲染 chat.messages，必须 push 一条对应消息（官方开场白同款形状）。
                // 3) agent.phase.lastTurn 同步顺延到 N——循环下一轮号来源于它（官方导入路径同款），
                //    否则真实第 N 轮与问候合成轮撞号（曾观察到两个 turn/start {turn:70}）。
                // chat 层消息随下一次真实轮 commit 落盘；重启前未发首条消息则气泡仅会话层留存。
                const snapshot = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : (Array.isArray(session.events) ? session.events : [])
                let lastTurn = 0
                for (const ev of snapshot) {
                  const t = ev?.data?.turn
                  if (typeof t === 'number' && t > lastTurn) lastTurn = t
                }
                const turn = lastTurn + 1
                const isV3 = session?.header?.version >= 3
                const assistantData = {
                  turn,
                  step: 1,
                  message: {
                    id: msgId,
                    role: 'assistant',
                    content: [{ type: 'text', text }],
                    source: { kind: 'model', provider: 'dsh-tavern', model: 'narrative-anchor-greeting' }
                  }
                }
                if (isV3) assistantData.stream = []
                session.append('turn/start', { turn })
                session.append('step/start', { turn, step: 1 })
                session.append('assistant/message', assistantData, { surfaceOp: 'append' })
                session.append('step/end', { turn, step: 1 })
                session.append('turn/end', { turn, reason: { kind: 'completed' } })
                // 双写 chat 层（官方开场白消息形状，不含 MVU/swipe 字段；不置 greeting:true 以免触发开场逻辑）
                const chat = session.chat || getChatFromSession(ctx, sid) || (typeof session === 'object' ? session.chat : null)
                let chatWritten = false
                if (chat && Array.isArray(chat.messages)) {
                  chat.messages.push({
                    role: 'assistant',
                    text,
                    sourceText: text,
                    projectionText: text,
                    displayText: '',
                    displayMode: 'all',
                    projectionVersion: 2,
                    projectionWarnings: [],
                    ts: Date.now(),
                    turn
                  })
                  chat.updatedAt = Date.now()
                  chatWritten = true
                }
                // 循环下一轮号顺延（官方 chat-history-import-service.js 同款）
                const agent = typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(sid) : null
                if (agent?.phase && (agent.phase.kind === undefined || agent.phase.kind === 'idle')) {
                  agent.phase.lastTurn = Math.max(Number(agent.phase.lastTurn) || 0, turn)
                }
                if (typeof sessions.flush === 'function') {
                  try { await sessions.flush(session) } catch (e) { log('[injectGreeting] flush error: ' + e.message) }
                }
                return sendJson({ ok: true, messageId: msgId, turn, chatWritten })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/unbind': {
              try {
                const sid = String(body.sessionId || '')
                if (!sid) return sendJson({ ok: false, error: '需要 sessionId' }, 400)
                const reg = readRegistry()
                const entry = reg.branches[sid]
                const fid = entry?.familyId || resolveFamilyId(sid)
                if (!fid) return sendJson({ ok: false, error: '该会话没有族谱关联' }, 400)
                if (sid === fid) return sendJson({ ok: false, error: '主线（族根）不能解除关联——族以它为键；如需拆族请用合并/解除各支线' }, 400)
                unregisterBranch(sid)
                // 双向清理【支线】条目：本会话书里来自该族的、族成员书里来自本会话的
                const removed = removeSidelineEntries(sid, familyMembers(fid).map(m => m.sessionId))
                let cleaned = 0
                for (const m of familyMembers(fid)) {
                  if (m.sessionId && m.sessionId !== sid) cleaned += removeSidelineEntries(m.sessionId, [sid])
                }
                clearFamilyCaches()
                return sendJson({ ok: true, familyId: fid, removedEntries: removed + cleaned })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/bind': {
              try {
                const sid = String(body.sessionId || '')
                const parentSid = String(body.parentSid || '')
                const familyId = String(body.familyId || '').trim() || (parentSid ? rootOf(parentSid) : '')
                if (!sid || !familyId) return sendJson({ ok: false, error: '需要 sessionId 与 familyId（或 parentSid）' }, 400)
                if (!sessionAlive(sid)) return sendJson({ ok: false, error: '目标会话不存在（可能已删除）' }, 400)
                const existing = readRegistry().branches[sid]
                if (existing && existing.familyId !== familyId) return sendJson({ ok: false, error: '该会话已属于其他族（' + existing.familyId + '），请先解除关联' }, 400)
                const member = registerBranch({ sessionId: sid, familyId, parentSid: parentSid || familyId, label: body.label })
                // 加入后立即生成族内互注条目（新成员拿到族成员 LTM 副本）
                let synced = 0
                try { synced = syncSidelineEntries(sid) } catch { }
                for (const m of familyMembers(familyId)) {
                  if (m.sessionId && m.sessionId !== sid) { try { syncSidelineEntries(m.sessionId) } catch { } }
                }
                return sendJson({ ok: true, member, familyId, synced })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/sync': {
              // 手动触发支线互注条目导入（不等后台结算；含 LTM + 已知情报）
              const sid = String(body.sessionId || '')
              if (!sid) return sendJson({ ok: false, error: '需要 sessionId' }, 400)
              if (!resolveFamilyId(sid)) return sendJson({ ok: false, error: '本会话没有族谱关联' }, 400)
              try {
                const synced = syncSidelineEntries(sid)
                return sendJson({ ok: true, synced })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/families': {
              // 全部族列表（供合并选择）：fid + 成员摘要
              const reg = readRegistry()
              const fids = [...new Set(Object.values(reg.branches).map(b => b.familyId))]
              const families = fids.map(fid => ({ familyId: fid, members: familyMembers(fid) })).filter(f => f.members.length > 0)
              return sendJson({ ok: true, families })
            }
            case 'branch/merge': {
              try {
                const sourceFid = String(body.sourceFamilyId || '')
                const targetFid = String(body.targetFamilyId || '')
                if (!sourceFid || !targetFid) return sendJson({ ok: false, error: '需要 sourceFamilyId 与 targetFamilyId' }, 400)
                if (sourceFid === targetFid) return sendJson({ ok: false, error: '不能合并到自身' }, 400)
                const reg = readRegistry()
                const sourceBranches = Object.entries(reg.branches).filter(([, b]) => b.familyId === sourceFid)
                // 1. 源族成员全部并入目标族（保留别名/父指针）；源族根登记为普通支线
                for (const [sid, b] of sourceBranches) {
                  registerBranch({ sessionId: sid, familyId: targetFid, parentSid: b.parentSid === sourceFid ? targetFid : b.parentSid, label: b.label })
                }
                const sourceRootEntry = reg.branches[sourceFid]
                if (sessionAlive(sourceFid) && !readRegistry().branches[sourceFid]) {
                  registerBranch({ sessionId: sourceFid, familyId: targetFid, parentSid: targetFid, label: sourceRootEntry?.label || sessionTitle(sourceFid) || '原主线' })
                } else if (sessionAlive(sourceFid)) {
                  registerBranch({ sessionId: sourceFid, familyId: targetFid, parentSid: targetFid, label: reg.branches[sourceFid]?.label || '原主线' })
                }
                // 2. known_facts 已不族共享（v0.9.19），无需合并文件；清理源族遗留文件
                deleteFamilyFile(sourceFid)
                clearFamilyCaches()
                // 3. 双向刷新族内条目
                let synced = 0
                for (const m of familyMembers(targetFid)) {
                  if (m.sessionId) { try { synced += syncSidelineEntries(m.sessionId) } catch { } }
                }
                const merged = familyMembers(targetFid)
                return sendJson({ ok: true, familyId: targetFid, members: merged, synced })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/rename': {
              try {
                const sid = String(body.sessionId || '')
                const label = String(body.label || '').trim()
                if (!sid || !label) return sendJson({ ok: false, error: '需要 sessionId 与 label' }, 400)
                const existing = readRegistry().branches[sid]
                const familyId = existing?.familyId || resolveFamilyId(sid) || sid // 根会话改名：familyId=自身
                const member = registerBranch({ sessionId: sid, familyId, parentSid: existing?.parentSid || '', label })
                // 别名变了 → 立即同步其他成员的【支线】条目（换新别名标记/标题），
                // 刷新族共享情报的 keywords 标记，并重生成已知情报条目；时机不严格，这里尽力即时
                let synced = 0
                // 改名会话自己的条目也刷新（自己来源的情报条目标记在其本人书中也要换新）
                try { autoImportFromAnchor(sid, readAnchor(sid)) } catch { }
                for (const m of familyMembers(familyId)) {
                  if (m.sessionId && m.sessionId !== sid) {
                    try { synced += syncSidelineEntries(m.sessionId) } catch { }
                    try { autoImportFromAnchor(m.sessionId, readAnchor(m.sessionId)) } catch { }
                  }
                }
                return sendJson({ ok: true, member, familyId, synced })
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'branch/list': {
              const sid = body.sessionId
              const fid = resolveFamilyId(sid)
              const members = fid ? familyMembers(fid) : []
              return sendJson({ ok: true, familyId: fid || null, members, isRoot: fid === sid })
            }
            case 'worldbook/get': {
              const sid = body.sessionId
              const book = readSessionWorldbook(sid)
              const prepared = chat?.preparedWorldBook || null
              const anchor = readAnchor(sid) || (chat && chat.narrativeAnchor) || null
              const inCtx = new Set((Array.isArray(prepared?.refs) ? prepared.refs : []).map(r => normalizeRef(r)))
              // v0.7.14：selection 可能存 'session-wb:'+id 或裸 id，都算已勾选
              const selList = Array.isArray(book?.selection) ? book.selection.map(String) : []
              const bookEntries = book ? book.entries.map(e => ({
                ...e,
                inContext: inCtx.has('session-wb:' + e.id),
                selected: selList.includes(e.id) || selList.includes('session-wb:' + e.id)
              })) : []
              // v0.7.2：官方世界书（文件直读）+ 召回审计（非侵入）
              const dataRoot = resolveTavernDataRoot()
              const official = readOfficialWorldbooks(dataRoot, chat)
              const recall = readRecallAudit(dataRoot, chat?.id)
              // v0.7.17ad：最新 reply 请求上下文分析（含工具补查 tool-result 文本）→ 条目真实在上下文标记
              let ctx = null
              let presentRefs = []
              if (dataRoot && chat?.id) {
                ctx = readLatestReplyContext(dataRoot, chat.id)
                if (ctx) {
                  const probeList = []
                  for (const e of (official?.embedded || [])) probeList.push({ ref: e.ref, entry: e })
                  for (const e of (official?.external || [])) probeList.push({ ref: e.ref, entry: e })
                  for (const e of (book?.entries || [])) probeList.push({ ref: 'session-wb:' + e.id, entry: e })
                  // v0.7.19b：绑定世界书条目也参与「在上下文」判定（bound 条目注入后 ref='bound:书序:条序'）
                  for (const e of (boundWorldbookEntries(book, dataRoot).entries || [])) probeList.push({ ref: e.ref, entry: e })
                  presentRefs = probeList.filter(p => entryPresentInContext(ctx.haystack, p.entry)).map(p => p.ref)
                  ctx.haystack = '' // 不送回前端（省流量）
                }
              }
              return sendJson({
                ok: true,
                book: book ? { ...book, entries: bookEntries } : null,
                prepared: prepared ? {
                  mode: prepared.mode, refs: prepared.refs, totalChars: prepared.totalChars,
                  contextChars: prepared.contextChars, context: chat?.preparedWorldBookContext || '',
                  turn: prepared.turn
                } : null,
                official,
                lastTurnText: ctx?.lastAssistant || '', // v0.7.17am：上一段 AI 输出（预测关键词命中文本源）
                recall: recall ? {
                  record: recall.record,
                  turn: recall.operation?.turn,
                  status: recall.operation?.status,
                  entries: Array.isArray(recall.operation?.entries) ? recall.operation.entries : [],
                  // v0.7.13：磁盘快照滞后导致 preparedWorldBook 常为空；
                  // 以审计 outputs（status=requested 即实际注入）作为"在快照"权威来源
                  outputRefs: Array.isArray(recall.operation?.outputs) ? recall.operation.outputs.map(o => o?.ref).filter(Boolean) : [],
                  // v0.7.14：冷却中条目（force 注入也不绕过冷却，页面需提示）
                  cooldownRefs: Array.isArray(recall.operation?.entries) ? recall.operation.entries.filter(x => x?.reason === 'cooldown').map(x => String(x?.ref)).filter(Boolean) : [],
                  // v0.7.15：筛选统计（官方 reason 分布 + LLM 筛选池规模）
                  // v0.7.17：上一轮强制注入（activationRequests force=true，含勾选/原生调度）
                  forcedRefs: Array.isArray(recall.operation?.activationRequests) ? recall.operation.activationRequests.filter(r => r?.force).map(r => String(r?.ref)).filter(Boolean) : [],
                  counts: recall.operation?.counts || null,
                  screening: recall.operation?.screening ? { candidateCount: recall.operation.screening.candidateCount, estimatedTokens: recall.operation.screening.estimatedTokens } : null,
                  entriesCount: Array.isArray(recall.operation?.entries) ? recall.operation.entries.length : 0
                } : null,
                dataRoot,
                bound: (() => {
                  const bd = boundWorldbookEntries(book, dataRoot)
                  return { books: bd.books, entryCount: bd.entries.length, entries: bd.entries }
                })(),
                context: ctx ? { requestId: ctx.requestId, turn: ctx.turn, ts: ctx.ts, haystackLen: ctx.haystackLen, presentRefs } : null,
                anchorCounts: anchor ? {
                  stm: (anchor.memory?.stm || []).length, ltm: (anchor.memory?.ltm || []).length,
                  known_facts: (anchor.memory?.known_facts || []).length,
                  foreshadow: (anchor.memory?.foreshadow_library || []).length
                } : null
              })
            }
            case 'worldbook/entry': {
              const sid = body.sessionId
              const book = loadSessionWorldbook(sid)
              const action = body.action
              const now = Date.now()              // v0.7.17al：官方条目（ref=entry:N）编辑/停用 → 写回卡工作副本 / 外部世界书文件
              const officialRef = action === 'toggle' ? String(body.entryId || '') : String(body.entry?.ref || '')
              if (officialRef.startsWith('entry:')) {
                const dataRoot = resolveTavernDataRoot()
                const res = updateOfficialEntry(dataRoot, chat, {
                  ref: officialRef,
                  source: body.source,
                  patch: action === 'toggle' ? { toggle: true } : {
                    enabled: typeof body.entry?.enabled === 'boolean' ? body.entry.enabled : undefined,
                    title: typeof body.entry?.title === 'string' ? body.entry.title : undefined,
                    keys: Array.isArray(body.entry?.keys) ? body.entry.keys : undefined,
                    content: typeof body.entry?.content === 'string' ? body.entry.content : undefined
                  }
                })
                if (!res.ok) return sendJson(res, 400)
                return sendJson({ ok: true, ref: officialRef, source: res.source, enabled: res.enabled, filePath: res.filePath })
              }
              // v0.7.20：bound 条目（会话绑定世界书）编辑/停用 → 写回绑定世界书文件（同官方右键菜单）
              // v0.9.19：抽到 session-worldbook.js updateBoundEntry（双格式 disable/key 语义，可单测）
              if (officialRef.startsWith('bound:')) {
                const dataRoot = resolveTavernDataRoot()
                const res = updateBoundEntry(book, officialRef, { action, entry: body.entry }, dataRoot)
                if (!res.ok) return sendJson(res, 400)
                return sendJson(res)
              }
              if (action === 'add' || action === 'update') {
                const e = body.entry || {}
                if (action === 'add') {
                  const id = 'manual-' + now.toString(36) + Math.floor(Math.random() * 1000).toString(36)
                  book.entries.push({
                    id, title: String(e.title || ''), keys: Array.isArray(e.keys) ? e.keys : [],
                    content: String(e.content || ''), enabled: e.enabled !== false, constant: e.constant === true,
                    source: 'manual', createdAt: now, updatedAt: now
                  })
                } else {
                  const target = book.entries.find(x => x.id === e.id)
                  if (!target) return sendJson({ ok: false, error: '条目不存在: ' + e.id }, 404)
                  if (typeof e.title === 'string') target.title = e.title
                  if (Array.isArray(e.keys)) target.keys = e.keys
                  if (typeof e.content === 'string') target.content = e.content
                  if (typeof e.enabled === 'boolean') { target.enabled = e.enabled; target.enabledTouched = true }
                  if (typeof e.constant === 'boolean') { target.constant = e.constant; target.constantTouched = true }
                  target.updatedAt = now

                  // 反向同步：如果该条目是从 known_facts 自动生成的，把修改后的 content 同步回 known_facts.summary
                  // 解析方式：去掉第一行标题（titleLine），剩下的全部作为 summary
                  if (target.anchorRef && target.anchorRef.kind === 'known_fact' && typeof e.content === 'string') {
                    try {
                      const kfId = target.anchorRef.id
                      const anchor = readAnchor(sid)
                      if (anchor && Array.isArray(anchor.memory?.known_facts)) {
                        const kfIdx = anchor.memory.known_facts.findIndex(f => f.id === kfId)
                        if (kfIdx >= 0) {
                          // 去掉第一行标题（仅在创建时写入的 titleLine），剩下的作为 summary
                          const lines = String(e.content).split('\n')
                          const summary = lines.slice(1).join('\n').trim()
                          if (summary) {
                            anchor.memory.known_facts[kfIdx].summary = summary
                            // 移到末尾（和 LLM 提交的合并逻辑保持一致）
                            const [item] = anchor.memory.known_facts.splice(kfIdx, 1)
                            anchor.memory.known_facts.push(item)
                            writeAnchor(sid, anchor)
                          }
                        }
                      }
                    } catch (err) {
                      // 反向同步失败不阻塞世界书条目更新
                      console.error('[narrative-anchor] 反向同步 known_facts 失败:', err)
                    }
                  }
                }
              } else if (action === 'delete') {
                book.entries = book.entries.filter(x => x.id !== body.entryId)
                book.selection = book.selection.filter(x => x !== body.entryId && x !== 'session-wb:' + body.entryId)
              } else if (action === 'toggle') {
                const target = book.entries.find(x => x.id === body.entryId)
                if (target) { target.enabled = target.enabled === false; target.enabledTouched = true }
              } else return sendJson({ ok: false, error: '未知 action: ' + action }, 400)
              writeSessionWorldbook(book)
              return sendJson({ ok: true, book })
            }
            case 'worldbook/entries-clear': {
              // 批量删除临时条目（按 id 列表；客户端按当前筛选传 ids）——条目与强制注入选择一并清理
              const sid = body.sessionId
              const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String))
              if (ids.size === 0) return sendJson({ ok: false, error: '需要 ids' }, 400)
              const book = loadSessionWorldbook(sid)
              const before = book.entries.length
              book.entries = book.entries.filter(x => !ids.has(String(x.id)))
              const removed = before - book.entries.length
              book.selection = book.selection.filter(x => !ids.has(String(x)) && !ids.has(String(x).replace(/^session-wb:/, '')))
              writeSessionWorldbook(book)
              return sendJson({ ok: true, removed })
            }
            case 'worldbook/import': {
              // 从 DSHT 世界书导入条目到会话临时世界书（复制自持，与"绑定"引用的语义不同）。
              // body: { sessionId, source: { kind:'embedded', cardPath } | { kind:'standalone', path },
              //         includeDisabled?, includeEmpty?, constantMode?: 'preserve'|'strip'(默认 strip：常驻条目导入后不常驻，由客户端弹窗询问) }
              const sidIm = body.sessionId
              const src = body.source || {}
              const kind = src.kind === 'embedded' ? 'embedded' : 'standalone'
              const source = kind === 'embedded'
                ? { kind: 'embedded', cardPath: String(src.cardPath || '') }
                : { kind: 'standalone', path: String(src.path || '') }
              if ((kind === 'embedded' && !source.cardPath) || (kind === 'standalone' && !source.path)) {
                return sendJson({ ok: false, error: '缺少世界书来源（embedded 需 cardPath，standalone 需 path）' }, 400)
              }
              const dataRootIm = resolveTavernDataRoot()
              let docIm = null
              try { docIm = readBoundWorldbookDocument(source, dataRootIm) } catch (errIm) { docIm = null }
              if (!docIm) return sendJson({ ok: false, error: '无法读取世界书文件：' + (kind === 'embedded' ? source.cardPath : source.path) }, 400)
              const resIm = importWorldbookEntries(sidIm, source, docIm, {
                includeDisabled: body.includeDisabled === true,
                includeEmpty: body.includeEmpty === true,
                keepConstant: body.constantMode === 'preserve'
              })
              if (resIm.error) return sendJson({ ok: false, error: resIm.error }, 400)
              return sendJson({ ok: true, imported: resIm.imported, updated: resIm.updated, skipped: resIm.skipped, name: resIm.name, entryCount: resIm.entryCount, constantCount: resIm.constantCount })
            }
            case 'worldbook/import-doc': {
              // 客户端上传世界书 JSON 文档导入会话临时世界书（文件导入；无磁盘路径）。
              // body: { sessionId, name, fileKey, doc, includeDisabled?, includeEmpty?, constantMode?: 'preserve'|'strip'(默认) }
              // fileKey：客户端提供的文件标识（文件名+大小+修改时间），重复导入同一文件 → 更新
              const sidF = body.sessionId
              const docF = body.doc
              if (!docF || typeof docF !== 'object') return sendJson({ ok: false, error: '缺少世界书文档（doc）' }, 400)
              const nameF = String(body.name || docF?.name || docF?.data?.name || docF?.character_book?.name || '未命名世界书')
              const fileKey = String(body.fileKey || ('upload:' + nameF))
              const sourceF = { kind: 'standalone', path: fileKey.indexOf('upload:') === 0 ? fileKey : ('upload:' + fileKey) }
              const resF = importWorldbookEntries(sidF, sourceF, docF, {
                includeDisabled: body.includeDisabled === true,
                includeEmpty: body.includeEmpty === true,
                keepConstant: body.constantMode === 'preserve'
              })
              if (resF.error) return sendJson({ ok: false, error: resF.error }, 400)
              return sendJson({ ok: true, imported: resF.imported, updated: resF.updated, skipped: resF.skipped, name: resF.name, entryCount: resF.entryCount, constantCount: resF.constantCount })
            }
            case 'worldbook/history': {
              const dataRoot = resolveTavernDataRoot()
              const chatId = (String(chat?.id || '').startsWith('chat-') ? chat.id : chat?.chatId) || readChatFromDisk(dataRoot, body.sessionId)?.id || (body.chatId || '')
              const history = dataRoot && chatId ? readRecallHistory(dataRoot, chatId, Number(body.limit) || 12) : []
              return sendJson({ ok: true, history })
            }
            case 'worldbook/library': {
              const dataRootLib = resolveTavernDataRoot()
              const standalone = []
              const embedded = []
              if (dataRootLib) {
                const { readdirSync: _rd, readFileSync: _rf, existsSync: _ex } = await import('node:fs')
                const { join: _jn } = await import('node:path')
                const wbDir = _jn(dataRootLib, 'resources', 'worldbooks')
                if (_ex(wbDir)) {
                  for (const f of _rd(wbDir).filter(n => /.json$/i.test(n))) {
                    try {
                      const doc = JSON.parse(_rf(_jn(wbDir, f), 'utf-8'))
                      const list = doc?.character_book?.entries || doc?.entries || doc?.data?.character_book?.entries
                      const listArr = Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : [])
                      standalone.push({
                        path: 'worldbooks/' + f,
                        name: String(doc?.name || doc?.data?.name || doc?.character_book?.name || f.replace(/\.json$/, '')),
                        entryCount: listArr.length,
                        enabledCount: listArr.filter(e => e?.enabled !== false).length,
                        constantCount: listArr.filter(e => e?.constant === true).length
                      })
                    } catch { /* 跳过损坏文件 */ }
                  }
                }
                const cardDir = _jn(dataRootLib, 'resources', 'cards')
                if (_ex(cardDir)) {
                  for (const f of _rd(cardDir).filter(n => /.json$/i.test(n))) {
                    try {
                      const ws = JSON.parse(_rf(_jn(cardDir, f), 'utf-8'))
                      const raw = ws?.raw || ws
                      const cb = raw?.data?.character_book || raw?.character_book
                      if (!cb || typeof cb !== 'object') continue
                      const list = cb.entries
                      const listArr = Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : [])
                      embedded.push({
                        cardPath: 'cards/' + f,
                        cardName: String(raw?.data?.name || raw?.name || f.replace(/\.json$/, '')),
                        name: String(cb?.name || raw?.data?.name || f.replace(/\.json$/, '')),
                        entryCount: listArr.length,
                        enabledCount: listArr.filter(e => e?.enabled !== false).length,
                        constantCount: listArr.filter(e => e?.constant === true).length
                      })
                    } catch { /* 跳过损坏文件 */ }
                  }
                }
              }
              return sendJson({ ok: true, standalone, embedded })
            }
            case 'worldbook/bind': {
              const sid = body.sessionId
              const book = loadSessionWorldbook(sid)
              const action = body.action || 'add'
              const sources = Array.isArray(body.books) ? body.books : []
              const now = Date.now()
              const norm = sources.map(src => {
                if (src?.kind === 'embedded') return { kind: 'embedded', cardPath: String(src.cardPath || '') }
                return { kind: 'standalone', path: String(src?.path || '') }
              }).filter(s => (s.kind === 'embedded' && s.cardPath) || (s.kind === 'standalone' && s.path))
              const current = Array.isArray(book.boundBooks) ? book.boundBooks : []
              const unboundG = Array.isArray(book.unboundGlobals) ? book.unboundGlobals : []
              const globalKeys = new Set(listGlobalAutoBind().map(sourceSig))
              if (action === 'set') {
                book.boundBooks = norm
                // set/replace 只管本会话本地绑定；重新绑定的来源同时撤销其"主动解除"记录
                const keys = new Set(norm.map(sourceSig))
                book.unboundGlobals = unboundG.filter(s => !keys.has(sourceSig(s)))
              } else if (action === 'remove') {
                const keys = new Set(norm.map(sourceSig))
                book.boundBooks = current.filter(s => !keys.has(sourceSig(s)))
                // v0.9.15：解除全局自动绑定的来源 → 记入本会话主动解除清单（带 ts，
                // 与全局条目 ts 比较：解除晚于设为全局才生效）
                book.unboundGlobals = [
                  ...unboundG.filter(s => !keys.has(sourceSig(s))),
                  ...norm.filter(s => globalKeys.has(sourceSig(s)) && !unboundG.some(u => sourceSig(u) === sourceSig(s)))
                    .map(s => ({ ...s, ts: now }))
                ]
              } else { // add
                const keys = new Set(current.map(sourceSig))
                for (const s of norm) {
                  if (!keys.has(sourceSig(s))) { current.push(s); keys.add(sourceSig(s)) }
                }
                book.boundBooks = current
                // add 的来源若之前被主动解除 → 恢复跟随（撤销解除记录）
                const addKeys = new Set(norm.map(sourceSig))
                book.unboundGlobals = unboundG.filter(s => !addKeys.has(sourceSig(s)))
              }
              book.updatedAt = now
              writeSessionWorldbook(book)
              const bd = boundWorldbookEntries(book, resolveTavernDataRoot())
              return sendJson({ ok: true, boundBooks: effectiveBoundBooks(book), unboundGlobals: book.unboundGlobals, books: bd.books, entryCount: bd.entries.length })
            }
            // v0.9.15：全局自动绑定清单管理（新会话/分支会话自动跟随）
            case 'worldbook/global-bind': {
              const action = body.action || 'list'
              try {
                if (action === 'list') return sendJson({ ok: true, globalAutoBind: listGlobalAutoBind() })
                if (action === 'set') {
                  const list = setGlobalAutoBind(Array.isArray(body.books) ? body.books : [])
                  // 新 ts 自动覆盖所有更早的会话解除记录，无需清扫
                  return sendJson({ ok: true, globalAutoBind: list })
                }
                if (action === 'toggle') {
                  const list = toggleGlobalAutoBind(body.book)
                  return sendJson({ ok: true, globalAutoBind: list })
                }
                return sendJson({ ok: false, error: '未知 action: ' + action }, 400)
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'worldbook/combos': {
              const action = body.action || 'list'
              try {
                if (action === 'list') return sendJson({ ok: true, combos: listCombos(), globalAutoBind: listGlobalAutoBind() })
                if (action === 'create') {
                  const combo = createCombo(body.name, body.books)
                  return sendJson({ ok: true, combo, combos: listCombos() })
                }
                if (action === 'update') {
                  const combo = updateCombo(body.id, { name: body.name, books: body.books })
                  return sendJson({ ok: true, combo, combos: listCombos() })
                }
                if (action === 'delete') {
                  deleteCombo(body.id)
                  return sendJson({ ok: true, id: body.id, combos: listCombos() })
                }
                if (action === 'addBooks') {
                  const combos = listCombos()
                  const combo = combos.find(c => c.id === body.id)
                  if (!combo) return sendJson({ ok: false, error: '组合不存在: ' + body.id }, 404)
                  const add = (Array.isArray(body.books) ? body.books : []).map(src =>
                    src?.kind === 'embedded'
                      ? { kind: 'embedded', cardPath: String(src.cardPath || '') }
                      : { kind: 'standalone', path: String(src?.path || '') })
                    .filter(s => (s.kind === 'embedded' && s.cardPath) || (s.kind === 'standalone' && s.path))
                  if (add.length === 0) return sendJson({ ok: false, error: '没有可加入的世界书' }, 400)
                  const sig = (sb) => (sb.kind === 'embedded' ? 'e:' + sb.cardPath : 's:' + sb.path)
                  const seen = new Set((combo.books || []).map(sig))
                  const merged = [...(combo.books || []), ...add.filter(sb => !seen.has(sig(sb)))]
                  const updated = updateCombo(body.id, { books: merged })
                  return sendJson({ ok: true, combo: updated, combos: listCombos() })
                }
                if (action === 'removeBook') {
                  const combos = listCombos()
                  const combo = combos.find(c => c.id === body.id)
                  if (!combo) return sendJson({ ok: false, error: '组合不存在: ' + body.id }, 404)
                  const idx = Number(body.bookIndex)
                  if (!Number.isInteger(idx) || idx < 0 || idx >= (combo.books || []).length) {
                    return sendJson({ ok: false, error: '无效的世界书索引: ' + body.bookIndex }, 400)
                  }
                  const books = (combo.books || []).filter((_, i) => i !== idx)
                  const updated = updateCombo(body.id, { books })
                  return sendJson({ ok: true, combo: updated, combos: listCombos() })
                }
                if (action === 'apply') {
                  const combos = listCombos()
                  const combo = combos.find(c => c.id === body.id)
                  if (!combo) return sendJson({ ok: false, error: '组合不存在: ' + body.id }, 404)
                  const sid = body.sessionId
                  const book = loadSessionWorldbook(sid)
                  const mode = body.mode === 'merge' ? 'merge' : 'replace'
                  const sig = (s) => (s.kind === 'embedded' ? 'e:' + s.cardPath : 's:' + s.path)
                  const existing = new Set((book.boundBooks || []).map(sig))
                  book.boundBooks = mode === 'merge'
                    ? [...(book.boundBooks || []), ...combo.books.filter(s => !existing.has(sig(s)))]
                    : combo.books.map(s => ({ ...s }))
                  book.updatedAt = Date.now()
                  writeSessionWorldbook(book)
                  const bd = boundWorldbookEntries(book, resolveTavernDataRoot())
                  return sendJson({ ok: true, applied: combo.id, boundBooks: book.boundBooks, books: bd.books, entryCount: bd.entries.length })
                }
                return sendJson({ ok: false, error: '未知 action: ' + action }, 400)
              } catch (err) {
                return sendJson({ ok: false, error: String(err?.message || err) }, 400)
              }
            }
            case 'worldbook/select': {
              const sid = body.sessionId
              const book = loadSessionWorldbook(sid)
              if (body.clear === true) book.selection = []
              else book.selection = Array.isArray(body.entryIds)
                ? body.entryIds.filter(id => book.entries.some(e => e.id === id) || String(id).startsWith('entry:') || String(id).startsWith('session-wb:') || String(id).startsWith('bound:'))
                : book.selection
              writeSessionWorldbook(book)
              return sendJson({ ok: true, selection: book.selection, book })
            }
            // ── v0.9.30 Persona（玩家角色档案库，原 mask 重构为 constant 条目）──
            case 'persona/list': {
              const store = loadPersonas()
              const sid = body.sessionId || ''
              const book = sid ? loadSessionWorldbook(sid) : null
              const liveChat = getChatFromSession(ctx, sid)
              const userName = str(liveChat && liveChat.macroState && liveChat.macroState.userName)
                || str(chat && chat.macroState && chat.macroState.userName) || '你'
              const manualIds = ((book && book.entries) || [])
                .filter(e => e && e.anchorRef && e.anchorRef.kind === 'persona-manual')
                .map(e => e.anchorRef.id)
              return sendJson({ ok: true, personas: store.personas || [], personaId: (book && (book.personaId || book.maskId)) || '', manualIds, userName })
            }
            case 'persona/save': {
              const persona = savePersona({ id: body.id, name: body.name, description: body.description, note: body.note, keywords: body.keywords })
              return sendJson({ ok: true, persona })
            }
            case 'persona/delete': {
              const removed = deletePersona(body.id)
              return sendJson({ ok: removed, removed })
            }
            case 'persona/apply': {
              const sid = body.sessionId
              if (!sid) return sendJson({ ok: false, error: '缺少 sessionId' }, 400)
              if (body.unapply === true) {
                unapplyPersona(sid)
                return sendJson({ ok: true, personaId: '' })
              }
              const { persona, entryId } = applyPersona(sid, body.id)
              return sendJson({ ok: true, personaId: persona.id, personaName: persona.name, entryId })
            }
            // v0.9.31：生成人工非常驻条目（以标题对应，不联动、不删除）
            case 'persona/genEntry': {
              const sid = body.sessionId
              if (!sid) return sendJson({ ok: false, error: '缺少 sessionId' }, 400)
              const r = createManualEntry(sid, body.id)
              return sendJson({ ok: true, ...r })
            }
            // ── v0.9.37 快捷输入模板（全局存储）──
            case 'quickinput/list':
              return sendJson({ ok: true, items: loadQuickInputs().items || [] })
            case 'quickinput/save': {
              const item = saveQuickInput({ id: body.id, name: body.name, content: body.content })
              return sendJson({ ok: true, item })
            }
            case 'quickinput/delete': {
              const removed = deleteQuickInput(body.id)
              return sendJson({ ok: removed, removed })
            }
            case 'worldbook/settings': {
              const sid = body.sessionId
              const book = loadSessionWorldbook(sid)
              if (typeof body.enabled === 'boolean') book.enabled = body.enabled
              if (typeof body.autoFromAnchor === 'boolean') book.autoFromAnchor = body.autoFromAnchor
              if (body.anchorAuto && typeof body.anchorAuto === 'object') {
                book.anchorAuto = { ...(book.anchorAuto || {}), ...body.anchorAuto }
                if (typeof book.anchorAuto.maxEnabled === 'number') book.anchorAuto.maxEnabled = Math.max(1, Math.min(1000, Math.floor(book.anchorAuto.maxEnabled)))
              }
              // v0.7.4：先写设置，再执行导入（autoImportFromAnchor 内部写文件），
              // 避免 L764 旧 book 覆盖掉导入修改；返回时重读最新。
              writeSessionWorldbook(book)
              if (body.importNow === true) {
                const anchor = readAnchor(sid) || (chat && chat.narrativeAnchor) || null
                if (anchor) autoImportFromAnchor(sid, anchor, true)
              }
              const finalBook = readSessionWorldbook(sid) || book
              return sendJson({ ok: true, book: finalBook })
            }
            // ========== 预设库：列表 + 新增中段条目（非侵入，遵循 SillyTavern 预设格式）==========
            // 官方 RPC 只暴露 updatePresetEntry（改已有条目），没有 createPreset/addPresetEntry。
            // NA 自己按官方格式直接读写 <dataRoot>/presets/*.json：
            //   prompts[] 末尾 push 新条目；prompt_order[100001].order[] 追加引用；
            //   dsh_tavern.promptLayout.middle[] 追加 {sourceIndex, identifier}。
            // 新条目设 injection_position:1（深度注入）→ 官方默认分段规则自动归入中段
            // （preset-conversion-preview.js:231：injectionPosition===1 → middle）。
            case 'preset/list': {
              // 官方 fileResources.absolute() 把 preset 放在 <dataRoot>/resources/presets/（working 副本），
              // 不是 <dataRoot>/presets/。对齐官方路径，否则列表永远为空。
              const dataRoot = resolveTavernDataRoot()
              const presetDir = join(dataRoot, 'resources', 'presets')
              if (!existsSync(presetDir)) return sendJson({ ok: true, items: [], presetDir, note: '预设目录不存在（尚未导入任何外部预设）' })
              let files = []
              try { files = readdirSync(presetDir) } catch (e) { return sendJson({ ok: false, error: String(e.message || e) }) }
              const items = files.filter(f => f.toLowerCase().endsWith('.json')).map(f => ({
                path: f,
                title: f.replace(/\.json$/i, '')
              }))
              return sendJson({ ok: true, items, presetDir })
            }
            case 'preset/addEntry': {
              const dataRoot = resolveTavernDataRoot()
              const presetDir = join(dataRoot, 'resources', 'presets')
              const relPath = typeof body.path === 'string' ? body.path : ''
              // 防路径穿越：只允许纯文件名，禁止 / \ ..
              if (!relPath || /[\\/]|\.\./.test(relPath)) return sendJson({ ok: false, error: '非法预设路径: ' + relPath })
              const filePath = join(presetDir, relPath)
              if (!existsSync(filePath)) return sendJson({ ok: false, error: '预设文件不存在: ' + relPath })
              let doc
              try { doc = JSON.parse(readFileSync(filePath, 'utf-8')) } catch (e) { return sendJson({ ok: false, error: '预设不是有效 JSON: ' + String(e.message || e) }) }
              if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return sendJson({ ok: false, error: '预设根节点不是对象' })
              if (!Array.isArray(doc.prompts)) return sendJson({ ok: false, error: '该预设没有 prompts 结构（不是可编辑的 SillyTavern 预设）' })
              const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '新建条目'
              const role = ['system', 'user', 'assistant'].includes(body.role) ? body.role : 'system'
              const content = typeof body.content === 'string' ? body.content : ''
              const identifier = 'na-entry-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
              const newEntry = {
                identifier,
                name,
                role,
                content,
                enabled: true,
                system_prompt: false,
                marker: false,
                injection_position: 1,   // 深度注入 → 官方默认归中段
                injection_depth: 4,
                injection_order: 100
              }
              doc.prompts.push(newEntry)
              const sourceIndex = doc.prompts.length - 1
              // prompt_order：确保有 character_id=100001 的 order group，追加引用
              if (!Array.isArray(doc.prompt_order)) doc.prompt_order = []
              let orderGroup = doc.prompt_order.find(g => g && Number(g.character_id) === 100001 && Array.isArray(g.order))
              if (!orderGroup) { orderGroup = { character_id: 100001, order: [] }; doc.prompt_order.push(orderGroup) }
              orderGroup.order.push({ identifier, enabled: true })
              // dsh_tavern.promptLayout.middle：若已存在 layout，同步追加到中段；不存在则留给官方默认推导
              if (doc.dsh_tavern && typeof doc.dsh_tavern === 'object' && !Array.isArray(doc.dsh_tavern)) {
                if (!doc.dsh_tavern.promptLayout || typeof doc.dsh_tavern.promptLayout !== 'object') doc.dsh_tavern.promptLayout = {}
                if (!Array.isArray(doc.dsh_tavern.promptLayout.middle)) doc.dsh_tavern.promptLayout.middle = []
                doc.dsh_tavern.promptLayout.middle.push({ sourceIndex, identifier })
              }
              writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8')
              return sendJson({ ok: true, entry: { identifier, name, role, sourceIndex, phase: 'middle' }, note: '已新增中段条目，重新打开预设即可看到并编辑' })
            }
            default: return sendJson({ ok: false, error: '未知方法: ' + method }, 404)
          }
        } catch (err) { return sendJson({ ok: false, error: String(err.message || err) }, 500) }
      }
    }, 'narrative-anchor: HTTP API')
    log('HTTP API 已注册: /api/narrative-anchor/*')
  })

  log('插件加载完成')
}
