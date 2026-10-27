/**
 * 叙事锚定 v2 —— 官方 plugin-api 适配层（去补丁化，DSHT plugin-api v2）
 *
 * 结算形态（组合方案，用户 2026-10-09 拍板）：
 *   - 非 MVU 卡：replaceSettlement 接管 —— settle 内单次结构化输出（锚点提交 JSON），
 *     提交成功即返回（官方"接管即结束"，等价用户要求的"锚点提交即终止"）；
 *     失败/超时抛错 → 官方自动退回自己的结算。
 *   - MVU 卡：settlementTool 参与官方 MVU 结算（narrative_anchor_read/submit 工具，
 *     提交即落库；官方 MVU 结算流程官方自管，不接管）。
 *   - 纯工具注入路径（MVU 官方结算 / 官方兜底）的上下文：settlementSection 五段——
 *     锚点快照 / 后台结算协议（单段，2026-10-21 去拆分）/ LTM 动态提示 / 自由栏位注入后台 /
 *     后台指导，由官方 background-agent-task 拼进【插件附加的结算任务】（2026-10-17 补齐：
 *     此前只注册后台指导一段，且 guideSection 被无参调用 → 整段静默失效，见 index.js 注册处）。
 *
 * 复用既有实现（零重复实现）：
 *   strategies.js  createAnchorStrategy（工具定义/协议/校验/合并/result）
 *   store.js       applyAnchorSubmission（增量合并落库，loadAnchor 返回引用原地补齐）
 *   data-store.js  readAnchor / writeAnchor（自持文件，唯一权威源）
 *   session-worldbook.js autoImportFromAnchor / syncSidelineEntries（世界书流入/支线同步）
 *
 * 历史处理（v2.5，2026-10-10 路线 A 拍板——会话自身层面解决，不做请求出口裁剪）：
 *   复刻 DSHT 官方 rewindTo:-1 语义（rewind-surface.js）：settle 每轮 followup 前调用
 *   rewindResidentSurface(agent.session)，把常驻子会话 surface 的非 fixed 历史替换为
 *   空 assistant 墓碑（fixed = system/message + tavern-session-prefix: 保留），
 *   模型上下文 = 系统前缀 + 本轮任务 + 本轮工具往返，每轮天然无历史。
 *   llm/stream 守卫因此只保留两项无法在会话层解决的职责：
 *   a) 滤掉 tavern agent/request 对非 tavern 会话的 unbound 兜底注入【酒馆状态】
 *      （请求组装阶段注入，不进 session surface，rewind 清不掉）；
 *   b) 注入后台请求 token 上限（官方 maximumBackgroundTokens 语义）。
 *
 * 说明：replaceSettlement 不提供 chat/updateChat —— 锚点数据只写自持文件
 * （readAnchor/writeAnchor），不再同步 chat.narrativeAnchor（官方隔离内部数据）；
 * 前台 turnSection / 记忆快照投影 / HTTP API 均读自持文件，不受影响。
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from './model-selection.js'
import { createAnchorStrategy, ltmHintLines, stateHintLines, NARRATIVE_ANCHOR_READ_TOOL, NARRATIVE_ANCHOR_SUBMIT_TOOL } from './strategies.js'
import { applyAnchorSubmission } from './store.js'
import { readAnchor, writeAnchor, readGlobalSettings } from '../data-store.js'
import { STAGE_DIRECTOR_BLOCKED_PROVIDER } from './request-audit.js'
import { autoImportFromAnchor, syncSidelineEntries } from '../session-worldbook.js'
import { rewindResidentSurface } from './rewind-surface.js'
import { readCurrentBackgroundModelSelection } from '../official-worldbook.js'
import { resolveTavernDataRoot, tavernSessionsDir, desktopLogFile, appendRotatingLogSync } from '../paths.js'
import { join, basename } from 'node:path'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

/** 提取消息正文文本（content 为字符串或 [{type:'text',text}] 数组）。 */
function messageTextOf(message) {
  if (!message || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(block => block && block.type === 'text').map(block => str(block.text)).join('')
  }
  return ''
}

/** 后台请求 token 上限（复刻官方 maximumBackgroundTokens：deepseek 官方模型给满上限，其余不注入）。 */
function maximumBackgroundTokens(provider, model) {
  const p = str(provider).trim().toLowerCase()
  const m = str(model).trim().toLowerCase()
  if (p === 'deepseek-official' && (m === 'deepseek-v4-flash' || m === 'deepseek-v4-pro')) return 384000
  return undefined
}

// 结算子 Agent 系统提示默认值（deployment:persona，order:0 + complete:true，完整覆盖默认系统提示）。
// 写法参考 DSHT 后台 persona：定位声明（与前台隔离）+ 职责 + 严格按任务协议 + 权威状态优先。
// 导出供设置页 getConfig 返回默认值（界面为空时显示默认）。
export const SETTLE_PERSONA = `你是与前台正文生成隔离的后台结算 Agent
职责：负责每轮正文结束后维护本局的数据
严格按任务协议输出——调用 narrative_anchor_submit，结束任务
不得续写，禁止复述、猜测
单次请求

【叙事锚定结算协议】
只依据本轮正文事实更新，Brief thinking, no drafts
！known_facts 仅从【本轮正文】总结新增，不复述历史/记忆/常驻世界书；事件流水归 stm
narrative_anchor_submit 是最后一步，调用后循环立即由程序终止
⚠ 工具调用是唯一提交通道：禁止在回复文本中输出锚定数据或"已提交"类复述；未调用工具 = 本轮结算失败`
// 结算任务指令默认值（锚点设置页可覆盖，见 settleTaskPromptOf）。TASK_MARK 为任务开始标记，
// 自定义指令不含时由 settle 组装处强制前置补上。
export const DEFAULT_TASK_PROMPT = '依据当前锚点快照与本轮正文，提交本轮锚点'
// 酒馆后台叙事锚定结算协议提示词（锚点设置页"全局设置"块可覆盖，见 backendSettleProtocolOf）。
// 注入位置：酒馆（宿主）结算后台的 settlementSection（单段，见 backendProtocolSection），
// 紧跟在【当前叙事锚定快照】之后。
// ⚠ 本路径（MVU 官方结算 / 官方兜底）不挂插件的 settlePersona——persona 里的强规则
// （工具调用是唯一提交通道 / 未调用 = 失败 / submit 最后一步）不过来吧，故本默认值必须自带：
// 内容默认强调（2026-10-21 改版，修"后台老是不结算锚点"）：
//   ① 显式祈使"本轮必须调用 narrative_anchor_submit"（旧版只有残缺描述句，无祈使）；
//   ② 无变化也必须提交空对象 {}（模型判断"无可更新"就跳过调用 = 头号嫌疑，工具描述里
//      该规则埋在 schema 深处权重低，这里显式兜住）；
//   ③ 未调用工具 = 本轮结算失败 / 禁止文本复述锚定数据 / 官方后台的 posture_submit 必须
//      最后调用（顺序错会导致后续工具提交失效，2026-10-21 用户实测口径）；
//   ④ 保留记忆分工（known_facts≠事件流水，那是 STM 职责）与同轮多工具一次提交不拆分；
//   ⑤ 具体提交规则指向工具描述，协议段本身保持精简（官方单段上限 8000 字，超长会被截断）。
export const DEFAULT_BACKEND_SETTLE_PROTOCOL = `本轮必须调用 narrative_anchor_submit 提交叙事锚定数据：工具调用是唯一提交通道，未调用工具 = 本轮结算失败
即使判断本轮无任何变化，也必须调用并以空对象 {} 提交，禁止跳过
只依据本轮正文已发生事实更新，不预测、不续写、不复述；Brief thinking, no drafts
若有其他工具需调用，在同一次回复中同时调用、互不依赖，禁止拆分多次；
注意顺序，posture_submit 必须是最后一个，否则会导致后续工具提交失效
known_facts 仅从【本轮正文】总结新增，不复述历史/记忆/常驻世界书；事件流水归 stm
具体提交规则（增量合并 / stm 每轮 1 条 / LTM 合并阈值 / known_facts 写法）以 narrative_anchor_submit 工具描述为准`

// 后台指导（2026-10-10 用户拍板：默认为空、不注入）——仅当会话配置了 backgroundGuide
// 才在后台任务末尾注入【后台指导】段（含 NA 结算）；未配置整段不出现。

// 结算任务消息固定标记（settle 组装时前置到 taskSection，标记本轮任务开始）。
const TASK_MARK = '【结算任务】'
// 结算子 Agent 会话前缀（请求出口守卫只处理本插件会话，不触碰其他 Agent）。
const SETTLE_SESSION_PREFIX = 'na-background-'
// 官方 settlementSection 单段文本上限（tavern-plugin/lib/plugin-api.js:8 MAX_SECTION_TEXT）：
// 超出部分被官方按字节截断。此处只作超限诊断（dbg 记录长度），不自我截断——
// 快照内容与 settle 任务消息保持同源，截断行为交给官方统一处理。
const SECTION_TEXT_LIMIT = 8000

/**
 * NA 结算请求出口守卫（llm/stream waterfall）——v2.5 瘦身版。
 * 历史裁剪已移除：跨轮历史由会话层 rewindResidentSurface（rewindTo:-1 语义）在
 * settle 组装前清空，模型上下文 = 系统前缀 + 本轮任务 + 本轮工具往返（见 rewind-surface.js）。
 * 本守卫只保留两项会话层无法解决的职责：
 *  1) 滤掉 tavern agent/request 对非 tavern 会话（无 chat 上下文）的 unbound 兜底注入
 *     【酒馆状态】（turn-orchestration prepare 在请求组装阶段用 snapshotMessage 包装注入，
 *     不进 session surface，rewind 清不掉）。覆盖两种形态：source.sections 含 tavern:turn 的
 *     snapshot 包装；以及文本含【酒馆状态】/尚未选择人物卡 的任意 user 消息（不依赖前缀）。
 *  2) 注入后台请求上限（deepseek 官方模型 384k，其余不注入）。
 * 返回修改后的 request；任何异常都原样放行（只读不改，不阻断结算链）。
 *
 * 为什么挂 llm/stream 而不是 agent/request：实测 agent/request 的 request 修改不会传播到
 * 实际 LLM 调用（llm/stream 的 options 才是最终请求体，request-audit 即从它捕获完整消息）。
 */
function naTavernStateFilter(request) {
  const messages = Array.isArray(request && request.messages) ? request.messages : []
  const filtered = messages.filter((message) => {
    if (!message || message.role !== 'user') return true
    const src = message.source
    const secNames = src && Array.isArray(src.sections) ? src.sections.map(s => s && s.name) : []
    // V4 适配：tavern 轮次快照的 source.kind 在 V4 为 'plugin:dsh-tavern'（无 plugin 字段）；
    // V3 旧形式为 kind:'plugin' + plugin:'dsh-tavern'。两种都识别，避免 V4 下形态①识别失效、
    // 只能靠形态②文本兜底的退化。
    if (src && (src.kind === 'plugin:dsh-tavern' || (src.kind === 'plugin' && src.plugin === 'dsh-tavern')) && secNames.includes('tavern:turn')) return false
    const text = str(messageTextOf(message))
    return !(text.startsWith('【酒馆状态】') || text.includes('尚未选择人物卡') || /请简短提示用户先在界面中/.test(text))
  })
  const nextRequest = Object.assign({}, request, filtered.length !== messages.length ? { messages: filtered } : {})
  const limit = maximumBackgroundTokens(request && request.provider, request && request.model)
  if (limit !== undefined) nextRequest.maxTokens = limit
  return nextRequest
}

/**
 * 删除单个 DSHT 原生后台会话目录（v3.5，拦截压缩时删会话用）。
 * 定位：sessions/<cwd-hash>/<sessionId>（与 nativeBackgroundSessionDirs 同一棵树）。
 * 仅接受 background- 前缀且排除 na-background-，绝不触碰其他会话/用户数据。
 * 幂等：目录不存在时 cleared=false，不抛错（Windows 上句柄未释放时 rmSync 可能 EBUSY，
 * 由调用方 catch，不影响主流程）。
 * @param {string} sessionId 形如 background-<uuid>
 * @returns {{ok:boolean, cleared:boolean, freedBytes:number, error?:string}}
 */
function clearNativeBackgroundSession(sessionId) {
  const sid = String(sessionId || '')
  if (!sid.startsWith('background-') || sid.startsWith(SETTLE_SESSION_PREFIX)) {
    return { ok: false, cleared: false, freedBytes: 0, error: 'not a native background session' }
  }
  let dataRoot
  try { dataRoot = resolveTavernDataRoot() } catch { dataRoot = null }
  if (!dataRoot) return { ok: false, cleared: false, freedBytes: 0, error: 'tavern data root not resolved' }
  const sessionsRoot = tavernSessionsDir()
  if (!existsSync(sessionsRoot)) return { ok: false, cleared: false, freedBytes: 0, error: 'sessions root not found' }
  let freedBytes = 0
  let cleared = false
  try {
    for (const cwdEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!cwdEntry.isDirectory()) continue
      const dir = join(sessionsRoot, cwdEntry.name, sid)
      if (!existsSync(dir)) continue
      freedBytes += dirSizeOf(dir)
      rmSync(dir, { recursive: true, force: true })
      cleared = true
    }
    return { ok: true, cleared, freedBytes }
  } catch (e) {
    return { ok: false, cleared, freedBytes, error: str(e?.message || e) }
  }
}

/** 目录字节数（clearNativeBackgroundSession 用；与闭包内 dirBytes 等价但模块级可用）。 */
function dirSizeOf(dir) {
  let total = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) total += dirSizeOf(p)
      else if (entry.isFile()) { try { total += statSync(p).size } catch { /* 单文件读取失败忽略 */ } }
    }
  } catch { /* 目录读取失败按 0 计 */ }
  return total
}

/**
 * 安装 NA 结算请求出口守卫（llm/stream global waterfall）。
 * 必须在 request-audit 的 llm/stream 钩子**之前**注册：waterfall 按注册顺序传递，
 * 守卫 next(guarded) → audit 收到过滤后的 options → 请求日志如实反映最终请求体。
 * 只处理 sessionId 以 na-background- 开头的会话，其余原样放行。
 *
 * v3.1（2026-10-10 用户拍板）：新增拦截——**后台会话的官方压缩请求**。
 * 识别：options.purpose === 'compaction'（官方 dsh-compaction-basic 硬编码，唯一用途）
 *      且 sessionId 以 background-（官方 tavern 后台任务会话，background-agent-sessions 默认
 *      makeId）或 na-background-（本插件结算会话）开头。
 * 行为：开关开启时**投毒 provider** 为不存在的「后台压缩已拦截（narrative-anchor）」，
 *      请求在路由阶段失败，官方 agent-loop 捕获后仅 warn "step compaction failed...continuing
 *      the turn"（dsh-compaction-basic _registerAutomaticCompaction），回合照常继续。
 *      投毒而非抛错，是为了让 DSH/压缩面板原样展示中文拦截原因。
 * 原因（用户 2026-10-10）：后台会话上下文每轮重建（rewind）且极短，压缩不会产生有用信息，
 *      只会浪费 token 与时间。
 *
 * v3.5（2026-10-15）：新增开关 deleteOnBlock——拦截命中时**顺带删除对应后台会话目录**。
 * 实测佐证（na-debug.log）：拦截记录里只有 background-*，从未出现 na-background-*——
 * NA 结算会话建于 makeSetup 子 ctx，不在 dsh-compaction-basic 的 agent/pre-step 监听范围，
 * 故本开关实际只作用于原生 background-*（其日志会随拦截无限累积，删除后下轮重建空会话）。
 * 删除为 fire-and-forget 微任务，失败仅记日志，绝不影响请求链与回合继续。
 */
export function installNaTavernStateFilter(ctx, opts = {}) {
  if (!ctx || typeof ctx.on !== 'function') return
  const blockBackgroundCompaction = typeof opts.blockBackgroundCompaction === 'function' ? opts.blockBackgroundCompaction : () => false
  // v3.5：拦截时是否顺带删除对应后台会话（global.json，默认 false；仅拦截开启时生效）
  const deleteOnBlock = typeof opts.deleteOnBlock === 'function' ? opts.deleteOnBlock : () => false
  ctx.on('llm/stream', function (options, next) {
    const sid = str(options && options.sessionId)
    // 诊断（v3.1）：记录后台会话/压缩请求特征，确认拦截为何未命中（后台压缩 request purpose/sid）
    if (sid.startsWith('background-') || sid.startsWith(SETTLE_SESSION_PREFIX) || (options && options.purpose === 'compaction')) {
      dbg('stream request probe', JSON.stringify({ sid: sid.slice(0, 48), purpose: options && options.purpose, msgs: Array.isArray(options.messages) ? options.messages.length : -1, maxTokens: options && options.maxTokens }))
    }
    // ── 压缩请求统一处理（v3.3 重构：请求体日志是通用日志，所有压缩请求都记录）──
    // 后台会话压缩（background-*/na-background-* + purpose=compaction）：开关开启时投毒拦截
    // （provider 改不存在值 → 路由阶段失败，未到达模型），并作为 blocked 标记记录；
    // 前台主会话压缩：不拦截，正常记录。两者都进请求体日志页「压缩请求」分组。
    if (options && options.purpose === 'compaction') {
      const isBg = sid.startsWith('background-') || sid.startsWith(SETTLE_SESSION_PREFIX)
      if (isBg && blockBackgroundCompaction()) {
        const originalProvider = options.provider
        // 投毒值用中文说明：路由失败时 DSH/压缩面板会原样展示该原因，一眼看懂是被 NA 拦截的
        const BLOCKED_PROVIDER = '后台压缩已拦截（narrative-anchor）'
        dbg('block background compaction poisoned', JSON.stringify({ sid: sid.slice(0, 48), purpose: options && options.purpose, msgs: Array.isArray(options.messages) ? options.messages.length : -1, originalProvider }))
        options.provider = BLOCKED_PROVIDER // 不存在的 provider → 路由阶段必然失败
        // v3.5：拦截时删除对应后台会话（开关默认关；仅拦截开启时生效）。
        // 只删原生 background-*：实测 na-background-* 从不触发压缩（其 agent 建于
        // makeSetup 子 ctx，不在 dsh-compaction-basic 的 agent/pre-step 监听范围内），
        // 删它无意义；而原生后台会话日志会随拦截无限累积，删掉可让其下轮重建空会话。
        // fire-and-forget：删除走微任务，不阻塞 next() 返回的请求链；rmSync 失败仅记日志。
        if (deleteOnBlock()) {
          void Promise.resolve()
            .then(() => clearNativeBackgroundSession(sid))
            .then((r) => { if (r && r.ok) dbg('blocked background session deleted', JSON.stringify({ sid: sid.slice(0, 48), cleared: r.cleared, freedBytes: r.freedBytes })) })
            .catch((e) => dbg('delete blocked background session error', str(e?.message || e)))
        }
        try {
          const audit = opts.audit && opts.audit()
          if (audit && typeof audit.record === 'function') {
            void audit.record(sid, options, { kind: 'compaction', blocked: true, blockedProvider: BLOCKED_PROVIDER, tavernCompat: false })
          }
        } catch { /* 审计失败不影响拦截 */ }
        return next(options)
      }
      // 前台压缩（不拦截）与开关关闭时的后台压缩：正常记录请求体
      try {
        const audit = opts.audit && opts.audit()
        if (audit && typeof audit.record === 'function') {
          void audit.record(sid, options, { kind: 'compaction', tavernCompat: false })
        }
      } catch { /* 审计失败不影响请求 */ }
    }
    try {
      if (sid.startsWith(SETTLE_SESSION_PREFIX)) {
        const before = Array.isArray(options.messages) ? options.messages.length : -1
        const guarded = naTavernStateFilter(options)
        const after = Array.isArray(guarded.messages) ? guarded.messages.length : -1
        const hasTavernTurn = Array.isArray(guarded.messages) && guarded.messages.some(m => m && m.role === 'user' && m.source && Array.isArray(m.source.sections) && m.source.sections.some(s => s && s.name === 'tavern:turn'))
        dbg('guard hit', JSON.stringify({ sid: sid.slice(0, 36), before, after, maxTokens: guarded.maxTokens, tavernTurnLeft: hasTavernTurn }))
        return next(guarded)
      }
    } catch (error) {
      dbg('na tavern state filter error', str(error?.message || error))
    }
    return next(options)
  }, { global: true })
}

/**
 * 拦截舞台导演后台请求（llm/stream global waterfall）——v3.6（2026-10-24，临时止血）。
 * 背景：舞台导演（task='stage-director' 的 isolated 后台 Agent）在本环境每轮必败
 * （流式提交 key 不匹配 + 舞台素材池缺失），但仍每轮发起一次无效模型请求、白耗 QPS。
 * 机制（与后台压缩拦截同通道）：命中特征后把 options.provider 投毒为不存在的哨兵值，
 * 请求在路由阶段失败、官方 agent-loop 捕获后仅 warn、回合照常继续；零模型调用、零 QPS。
 * 识别特征（任一即命中，均为舞台导演独占）：
 *   - options.tools 含 name==='stage_update'（舞台导演独占工具，兼容 {function:{name}} 包装）
 *   - options.system 含唯一标识「你是独立的舞台导演」
 * 全局开关 blockStageDirector（global.json，默认 false）：关闭时本钩子直接放行、零开销。
 * 命中时经 audit 记录为 kind='stage-director'、blocked=true（request-audit 据此跳过重复记录）。
 * 根治见上游 issue（流式提交 key + 素材池配置缺失）。
 */
export function installStageDirectorBlocker(ctx, opts = {}) {
  if (!ctx || typeof ctx.on !== 'function') return
  const enabled = typeof opts.enabled === 'function' ? opts.enabled : () => false
  const audit = typeof opts.audit === 'function' ? opts.audit : () => null
  ctx.on('llm/stream', function (options, next) {
    if (!enabled()) return next(options) // 全局开关关闭：完全不拦截（零开销）
    if (!options || typeof options !== 'object') return next(options)
    const tools = Array.isArray(options.tools) ? options.tools : []
    const hasStageTool = tools.some(t => t && (t.name === 'stage_update' || (t.function && t.function.name === 'stage_update')))
    const system = typeof options.system === 'string' ? options.system : ''
    const hasStageSystem = system.includes('你是独立的舞台导演')
    if (!hasStageTool && !hasStageSystem) return next(options) // 命中特征才拦截
    const sid = str(options && options.sessionId)
    // 投毒 provider → 路由阶段失败（未到达模型）→ 官方 agent-loop 捕获为 warn，回合继续
    options.provider = STAGE_DIRECTOR_BLOCKED_PROVIDER
    try {
      const a = audit()
      if (a && typeof a.record === 'function') {
        void a.record(sid, options, { kind: 'stage-director', blocked: true, blockedProvider: STAGE_DIRECTOR_BLOCKED_PROVIDER, tavernCompat: false })
      }
    } catch { /* 审计失败不影响拦截 */ }
    return next(options)
  }, { global: true })
}

/** [调试] 追加写 na-debug.log（与旧版同文件）；日志失败不阻断结算。
 *  位置由 paths.js 解析（<DataDir>/desktop/logs），解析不到时静默跳过——绝不硬编码盘符。 */
function dbg(...parts) {
  const line = new Date().toISOString() + ' [NA-v2] ' + parts.map(p => typeof p === 'string' ? p : safeJson(p)).join(' ') + '\n'
  appendRotatingLogSync(desktopLogFile('na-debug.log'), line, { maxBytes: 8 * 1024 * 1024, keep: 3 })
}
function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** STM 合成姿势（取未合并 STM 最后一条的摘要；原 orchestrator 同逻辑已随死代码清理）。 */
function stmPostureText(anchor) {
  const mem = anchor && typeof anchor === 'object' ? anchor.memory : null
  const stm = Array.isArray(mem?.stm) ? mem.stm : []
  const entry = stm.length > 0 ? stm[stm.length - 1] : null
  return str(entry?.summary).trim()
}

/** 勾选「注入后台」的自由栏位列表元素 → 段文本（v0.10.4）。
 *  settle 任务消息与纯工具注入路径的 settlementSection 共用同一实现；无勾选项返回 ''。 */
function freeSlotsBackText(fileAnchor) {
  const fs = fileAnchor && fileAnchor.free_slots ? fileAnchor.free_slots : {}
  const segs = []
  if (Array.isArray(fs.list)) {
    fs.list.forEach((item, i) => {
      if (item && item.injectBack === true && String(item.display || '').trim()) {
        segs.push('【自由栏位-列表#' + i + '】\n' + String(item.display).trim())
      }
    })
  }
  return segs.join('\n\n')
}

/** 锚点提交落库（自持文件唯一权威；chat.narrativeAnchor 在官方接管下不再写入）。 */
function persistAnchorOnly(gameId, anchor, maxSTMLength, turn) {
  if (!anchor || typeof anchor !== 'object') return
  const fileAnchor = readAnchor(gameId)
  // 最小 chat 壳：applyAnchorSubmission 的 loadAnchor 只消费 narrativeAnchor + 轮号来源 messages
  const chatShell = {
    narrativeAnchor: fileAnchor || {},
    messages: Number.isSafeInteger(turn) && turn > 0 ? [{ role: 'assistant', turn }] : []
  }
  applyAnchorSubmission(chatShell, anchor, maxSTMLength)
  writeAnchor(gameId, chatShell.narrativeAnchor)
  autoImportFromAnchor(gameId, chatShell.narrativeAnchor)
  syncSidelineEntries(gameId)
}

/** 组装最小策略输入（锚点策略只消费 snapshot.sessionId / snapshot.narrativeAnchor）。 */
function strategyInputFor(gameId, fileAnchor) {
  return { snapshot: { sessionId: gameId || '', narrativeAnchor: fileAnchor || null } }
}

/**
 * 创建 v2 官方 API 结算件。
 * @param {object} options { config, ctx, tavern }
 * @returns {{ settle, tools, protocol, anchorSnapshotSection, ltmHintsSection, freeSlotsSection, guideSection, ... }}
 *   settle({gameId, turn, text, posture, tasks})  → replaceSettlement 处理器
 *   tools()                                       → settlementTool 注册项数组（MVU 结算用）
 *   protocol({gameId, turn})                      → 结算协议文本（2026-10-10 起不注入，留用）
 *   anchorSnapshotSection({gameId})               → settlementSection：锚点快照
 *   ltmHintsSection({gameId})                     → settlementSection：LTM 动态 ⚠ 提示
 *   freeSlotsSection({gameId})                    → settlementSection：自由栏位注入后台
 *   guideSection({gameId})                        → settlementSection：后台指导
 */
export function createOfficialSettlement({ config = {}, ctx, tavern }) {
  const maxSTMLengthDefault = Math.max(1, Number(config.maxSTMLength) || 7)

  /** 读取会话锚点 + 生效的 STM 上限（设置以自持文件为权威）。 */
  function anchorOf(gameId) {
    const fileAnchor = readAnchor(gameId || '') || null
    const maxStm = fileAnchor?.meta?.settings?.maxSTMLength || maxSTMLengthDefault
    return { fileAnchor, maxStm }
  }

  /** 会话不存在判定（resume 失败时区分"可新建"与"真错误"）。 */
  function missingSession(error) {
    let current = error
    for (let depth = 0; current && depth < 5; depth++) {
      const code = str(current.code).trim().toUpperCase()
      if (code === 'ENOENT' || code === 'SESSION_NOT_FOUND') return true
      const message = str(current.message || current)
      if (/session\s+["'][^"']+["']\s+not found/i.test(message) || /会话[^\n]*不存在/.test(message)) return true
      current = current.cause
    }
    return false
  }

  // ── 常驻结算子 Agent（复刻 DSHT 后台子会话能力，2026-10-09 v2.2）──
  // 每个前台会话一个固定结算会话（na-background-<gameId>），界面可见（descriptor 发布）、
  // 可续跑（continuable）、重启后可恢复（resume）；工具注册一次、任务走 followup/whenIdle，
  // 空闲超时回收，不再每轮新建 one-shot 会话。
  const residentHandles = new Map()   // gameId -> { handle, agent, sessionId, lastUsedAt }
  const activeStrategies = new Map()  // gameId -> { strategy, readCount }（当前任务，工具 execute 分发用）
  const settleQueues = new Map()      // gameId -> Promise（同会话结算串行）
  // 纯工具注入路径（settlementTool）的 read 计数：接管路径由 activeStrategies.readCount
  // 强制（每次 execute 复用同一 strategy 对象）；工具路径每次 execute 新建 strategy、
  // 无跨调用状态，这里按 gameId 自管 { turn, count }——turn 变化或 submit 成功即重置。
  const toolReadCounts = new Map()    // gameId -> { turn, count }
  const RESIDENT_IDLE_MS = 10 * 60 * 1000
  // v3.6：gameId -> 本会话最近一次结算**实际使用**的 { provider, model, reasoningEffort, sessionId, at }
  // 仅内存（进程重启后为空，标签此时不显示）；用于输入框处 NA 后台模型标签。
  const settleSelections = new Map()

  function naDescriptor(bg) {
    return {
      version: 3,
      mode: 'continuable',
      provider: 'narrative-anchor-settlement',
      label: '叙事锚定后台',
      agentProvider: bg.provider,
      agentModel: bg.model,
      persona: '为本游戏维护叙事锚定数据（当前状态/多级记忆/已知情报）。只调用 narrative_anchor_read 与 narrative_anchor_submit 完成每轮结算，不续写故事、不修改变量。'
    }
  }

  // 与宿主 background-agent-sessions.js / background-catalog.js 的 sessionEvents() 一致的事件访问器。
  // released V4 下 catalog/descriptor 等系统事件经 snapshotEvents() 暴露，直接读 session.events 可能漏掉
  // 已写入的 subagent/catalog → 去重失效、每轮结算重复 append → "duplicate catalog child"。
  function allEvents(session) {
    if (!session) return []
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    return Array.isArray(session.events) ? session.events : []
  }

  /** 往父会话追加 subagent/catalog 事件，使 DSH UI 能发现本子 Agent 并显示模型。 */
  function registerCatalogChild(parent, childSession) {
    try {
      const header = childSession.header
      if (!header || !header.id) return
      // 幂等防护：父会话已登记过同 childId 的 subagent/catalog 则跳过，
      // 避免 DSH 加载会话时抛 "duplicate catalog child"（同一 childId 出现两次）。
      // 与下方 subagent/descriptor 的去重模式一致（见 ensureResident 内 line ~443）。
      const existing = allEvents(parent.session)
      if (existing.some(e => e && e.type === 'subagent/catalog' && e.data && e.data.childId === header.id)) {
        dbg('registerCatalogChild skip (already registered)', { childId: header.id })
        return
      }
      parent.session.append('subagent/catalog', {
        version: 0,
        childId: header.id,
        childCreatedAt: Number(header.createdAt) || Date.now(),
        mode: 'continuable',
        label: '叙事锚定后台'
      })
    } catch (e) { dbg('registerCatalogChild error', str(e?.message || e)) }
  }

  // 结算子 Agent 系统提示（deployment:persona，order:0 + complete:true，完整覆盖默认系统提示）。
  // 每轮任务消息的固定标记（settle 的 taskText 首段），agent/request 据此裁剪跨轮历史。
  //（TASK_MARK 为模块级常量，settle 组装与守卫共用。）

  // 提示词可配置（锚点设置页"全局设置"块）：settlePersona = 结算系统提示；settleTaskPrompt = 每轮【结算任务】指令。
  // 全局共享（data/anchors/global.json），不按会话保存（用户 2026-10-10 拍板）；每轮请求/任务组装时
  // 实时读全局文件，空/未配置 → 用上方默认值；改动无需重启、下一轮生效。
  // TASK_MARK 为任务开始标记（不再承担历史裁剪锚点——历史由会话层 rewind 清空）。
  function settlePersonaOf() {
    const global = readGlobalSettings()
    const custom = global && typeof global.settlePersona === 'string' && global.settlePersona !== '' ? global.settlePersona : undefined
    return custom || SETTLE_PERSONA
  }
  function settleTaskPromptOf() {
    const global = readGlobalSettings()
    const custom = global && typeof global.settleTaskPrompt === 'string' && global.settleTaskPrompt !== '' ? global.settleTaskPrompt : undefined
    return custom || DEFAULT_TASK_PROMPT
  }
  // 酒馆后台叙事锚定结算协议提示词（2026-10-20 新增全局设置）——酒馆（宿主）结算后台的 settlementSection
  // 注入内容，位于【当前叙事锚定快照】之后；空/未配置 → 用上方 DEFAULT_BACKEND_SETTLE_PROTOCOL。
  function backendSettleProtocolOf() {
    const global = readGlobalSettings()
    const custom = global && typeof global.backendSettleProtocol === 'string' && global.backendSettleProtocol !== '' ? global.backendSettleProtocol : undefined
    return custom || DEFAULT_BACKEND_SETTLE_PROTOCOL
  }
  // 酒馆后台叙事锚定结算协议：单个 settlementSection 注入（标题【叙事锚定结算协议】+ 协议全文，
  // 位于【当前叙事锚定快照】之后）。
  // 2026-10-21 用户拍板去拆分：原按换行拆成最多 16 段是为绕官方单段 8000 字上限，但默认协议仅
  // 三百余字、一段足够；单段后无段数注册上限约束，运行时改协议（增删行）同样即时生效。
  // ⚠ 官方单段上限 SECTION_TEXT_LIMIT=8000 字仍在：自定义协议超长会被官方按字节截断，
  // 超限时 dbg 记录长度便于诊断（与 anchorSnapshotSection 同款处理）。
  function backendProtocolSection({ gameId } = {}) {
    const text = str(backendSettleProtocolOf()).trim()
    if (text === '') return ''
    if (text.length > SECTION_TEXT_LIMIT) dbg('backend protocol section exceeds official cap', { gameId, len: text.length, cap: SECTION_TEXT_LIMIT })
    return '【叙事锚定结算协议】\n' + text
  }
  // 后台指导（按会话保存，2026-10-10 用户拍板：默认为空、不注入）。
  // 存于会话锚点文件 meta.settings.backgroundGuide（与 enabled/maxSTMLength 同层）；
  // 未配置返回 ''——调用方据此跳过整段【后台指导】注入。
  function backgroundGuideOf(gameId) {
    const anchor = readAnchor(String(gameId || '')) || null
    const custom = anchor?.meta?.settings && typeof anchor.meta.settings.backgroundGuide === 'string' && anchor.meta.settings.backgroundGuide !== '' ? anchor.meta.settings.backgroundGuide : ''
    return custom
  }

  function makeSetup(gameId, bg) {
    let descriptorAppended = false
    return async (childCtx) => {
      // 注册模型选择（与 DSHT 官方后台一致）：使 DSH UI 显示本子 Agent 的 provider/model
      installModelSelection(childCtx, {
        current: {
          provider: bg.provider,
          model: bg.model,
          ...(bg.reasoningEffort ? { reasoningEffort: bg.reasoningEffort } : {})
        },
        assembled: undefined
      })
      // 与 DSHT 官方后台一致：在 agent/pre-step 第一次 enter 时兜底追加 descriptor
      // （create 返回后立即 append 可能太早，session 未持久化；pre-step 确保第一次 LLM 请求前已落盘）
      childCtx.on('agent/pre-step', async ({ agent }, next) => {
        const decision = await next()
        if (!descriptorAppended && decision.kind === 'enter') {
          descriptorAppended = true
          try {
            const has = allEvents(agent.session).some(e => e && e.type === 'subagent/descriptor')
            if (!has) agent.session.append('subagent/descriptor', naDescriptor(bg))
          } catch (e) { dbg('pre-step descriptor append error', str(e?.message || e)) }
        }
        return decision
      })
      if (childCtx.systemPrompt && typeof childCtx.systemPrompt.section === 'function') {
        childCtx.systemPrompt.section({
          name: 'deployment:persona',
          order: 0,
          complete: true,
          text: () => settlePersonaOf()
        })
      }
      // 历史清空由会话层 rewind 处理（settle 每轮 followup 前 rewindResidentSurface）；
      // 【酒馆状态】过滤 / maxTokens 由 llm/stream 守卫统一处理（installNaTavernStateFilter）。
      //（childCtx.on('agent/request') 不触发，agent/request 的 request 修改也不传播到实际调用，
      // 均已废弃——见 rewind-surface.js 与 installNaTavernStateFilter 注释）
      const register = (tool) => childCtx.tools.register({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args, exec) {
          const active = activeStrategies.get(gameId)
          if (!active || !active.strategy) {
            return JSON.stringify({ ok: false, retryable: true, error: '当前没有正在执行的结算任务，请等待下一条任务指令。' })
          }
          if (active.strategy.isComplete()) {
            return JSON.stringify({ ok: false, retryable: false, message: '本轮锚点已提交，任务结束。' })
          }
          if (tool.name === NARRATIVE_ANCHOR_READ_TOOL.name) {
            if (active.readCount >= 3) {
              return JSON.stringify({ ok: false, retryable: false, message: 'narrative_anchor_read 每轮结算最多 3 次，请直接调用 narrative_anchor_submit 提交最终结果。' })
            }
            active.readCount++
          }
          let resultText
          try {
            resultText = await active.strategy.handle({ name: tool.name, arguments: args })
          } catch (error) {
            resultText = JSON.stringify({ ok: false, retryable: true, error: str(error?.message || error) })
          }
          // 锚点提交成功 → 标记本回合终止（DSH 官方 ToolExecution.concludeTurn()：
          // 单调终端轮次策略，loop 在该 step 后停止，不再发后续模型请求）。
          // 仅限 submit 成功（isComplete）且 exec 携带 concludeTurn 的 DSH 工具管线；
          // 失败/异常结果不标记（可重试），exec 缺失时退回现行为。
          if (tool.name === NARRATIVE_ANCHOR_SUBMIT_TOOL.name && active.strategy.isComplete() && exec && typeof exec.concludeTurn === 'function') {
            try {
              exec.concludeTurn()
              dbg('submit concluded turn', { gameId })
            } catch (concludeError) {
              dbg('concludeTurn error', str(concludeError?.message || concludeError))
            }
          }
          dbg('tool executed', { name: tool.name, resultText: str(resultText).slice(0, 200) })
          return resultText
        }
      })
      register(NARRATIVE_ANCHOR_READ_TOOL)
      register(NARRATIVE_ANCHOR_SUBMIT_TOOL)
      if (typeof childCtx.tools.restrict === 'function') {
        // restrict 只接受已知全局工具名；submit 为本地注册工具，天然可见，不进 restrict 集合。
        // 白名单失败 = 无法保证工具受控 → 抛错（创建失败走清理兜底），绝不静默放行全部全局工具。
        try {
          childCtx.tools.restrict({ allow: [NARRATIVE_ANCHOR_READ_TOOL.name] })
        } catch (restrictError) {
          throw new Error('结算子 Agent 工具白名单失败：' + str(restrictError?.message || restrictError))
        }
      }
      if (childCtx.systemPrompt && typeof childCtx.systemPrompt.suppressRuntimeContext === 'function') {
        childCtx.systemPrompt.suppressRuntimeContext()
      }
    }
  }

  /** 获取（或创建/恢复）gameId 的常驻结算子 Agent；空闲超时则回收重建。 */
  async function ensureResident(gameId, bg, agents, parent) {
    const sessionId = 'na-background-' + String(gameId || 'unknown').replace(/[^\w-]/g, '_')
    const now = Date.now()
    // v3.6：记录本会话结算**实际使用**的 provider/model/强度，供输入框处的 NA 后台模型标签读取
    // （官方同位置标签只读 label 为「酒馆后台 Agent」的子 Agent，NA 走自己的 slot 与数据源）。
    settleSelections.set(String(gameId || ''), {
      provider: str(bg && bg.provider),
      model: str(bg && bg.model),
      reasoningEffort: str(bg && bg.reasoningEffort),
      sessionId,
      at: now
    })
    let resident = residentHandles.get(gameId)
    if (resident && now - resident.lastUsedAt > RESIDENT_IDLE_MS) {
      dbg('resident idle reclaim', { sessionId: resident.sessionId })
      try { await resident.handle.dispose() } catch (e) { dbg('resident reclaim dispose error', str(e?.message || e)) }
      residentHandles.delete(gameId)
      resident = null
    }
    if (resident) { resident.lastUsedAt = now; return resident }
    // 与 DSHT 官方后台 Agent（background-agent-sessions.js agentOptions 组装）逐字段一致：
    // provider + model + maximumBackgroundTokens 结果 + reasoningEffort 透传。
    // 此前仅传 provider/model，丢弃了后台模型配置的 reasoningEffort（2026-10-15 修复）。
    const agentMaxTokens = maximumBackgroundTokens(bg.provider, bg.model)
    const agentOptions = {
      provider: bg.provider,
      model: bg.model,
      ...(agentMaxTokens === undefined ? {} : { maxTokens: agentMaxTokens }),
      ...(bg.reasoningEffort === undefined ? {} : { reasoningEffort: bg.reasoningEffort })
    }
    let handle = null
    if (typeof agents.resume === 'function') {
      try {
        handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup: makeSetup(gameId, bg) })
        try {
          handle.agent.session.append('subagent/descriptor', naDescriptor(bg))
        } catch (e) { dbg('descriptor re-append on resume error', str(e?.message || e)) }
        registerCatalogChild(parent, handle.agent.session)
        dbg('resident resumed', { sessionId })
      } catch (error) {
        if (!missingSession(error)) throw error
        handle = null
      }
    }
    if (!handle) {
      // 继承父会话 cwd（DSH 会话历史 API 要求 header.cwd 非 undefined，否则前端加载子 Agent 历史报 subagent/not-found）
      const cwd = str(parent.session?.header?.cwd)
      const meta = { parentSession: parent.id, origin: 'subagent', delegationDepth: 1, ...(cwd ? { cwd } : {}) }
      handle = await agents.create({
        sessionId,
        meta,
        agentOptions,
        setup: makeSetup(gameId, bg)
      })
      try {
        handle.agent.session.append('subagent/descriptor', naDescriptor(bg))
      } catch (e) { dbg('descriptor append error', str(e?.message || e)) }
      registerCatalogChild(parent, handle.agent.session)
      dbg('resident created', { sessionId, parentId: parent.id, bg })
    }
    resident = { handle, agent: handle.agent, sessionId, lastUsedAt: now }
    residentHandles.set(gameId, resident)
    return resident
  }

  async function settle({ gameId, turn, text, posture, tasks }) {
    dbg('settle entered', { gameId, turn, textLen: str(text).length, postureLen: str(posture).length, tasks })
    const { fileAnchor, maxStm } = anchorOf(gameId)
    dbg('anchorOf', { hasFile: !!fileAnchor, enabled: fileAnchor?.meta?.settings?.enabled, maxStm })
    // 锚点关闭 / 无正文：抛错退回官方结算（返回 {} 会让官方误以为已接管而吞掉姿势结算）
    if (fileAnchor?.meta?.settings?.enabled === false) { dbg('throw: anchor disabled'); throw new Error('叙事锚定已关闭，本轮结算退回官方') }
    if (!text || !str(text).trim()) { dbg('throw: no text'); throw new Error('本轮无正文，叙事锚定结算退回官方') }
    const input = strategyInputFor(gameId, fileAnchor)
    const strategy = createAnchorStrategy(input)
    const context = str(strategy.contextSection()).trim()
    dbg('strategy ready', { contextLen: context.length })

    // 模型来源：官方 backgroundModel（未配置 → 抛错退回官方结算）
    const bg = await Promise.resolve(tavern.backgroundModel?.({ gameId })).catch((e) => { dbg('backgroundModel threw', str(e?.message || e)); return null })
    dbg('backgroundModel', bg)
    if (!bg || !bg.provider || !bg.model) {
      dbg('throw: no background model')
      throw new Error('没有可用的后台模型配置，叙事锚定结算退回官方结算')
    }

    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') {
      dbg('throw: agents service missing')
      throw new Error('当前 DSH 未提供 agents 服务，叙事锚定结算退回官方结算')
    }
    const parent = agents.get(String(gameId))
    if (!parent || !parent.session) {
      dbg('throw: parent session missing', { gameId })
      throw new Error('无法创建结算子 Agent：前台会话不可用，叙事锚定结算退回官方结算')
    }

    // ---------------------------------------------------------------------
    // reasoningEffort 补齐（2026-10-15）
    //
    // 背景：官方 plugin-api 的 backgroundModel() 只 return {provider, model}，
    // 丢弃 reasoningEffort（tavern-plugin/lib/plugin-api.js:236-239）。
    // 官方后台自己走内部 backgroundModelSelection()
    // （tavern-plugin/lib/index.js:582-584），拿到的是含 effort 的完整 selection。
    // → 同一份 per-chat 配置，官方后台能读出 effort，插件读不到。
    //
    // 对齐目标：与官方后台行为完全一致。
    // 官方 resolveChatBackgroundModel(chat, fallback)（domain/background-model-selection.js:30）
    // 语义：source = configuredChatBackgroundModel(chat) || fallback，再 normalize。
    // 即 per-chat 未配则整个回退前台（provider/model 一起），effort 不单独兜底。
    //
    // ⚠ v3.0.1 修正：路径1 早期实现读的是「最后一个 snapshot 文件」。
    // 官方读的是 materialize() 结果（快照基线 + journal 帧重放），二者不等价：
    // snapshot 并非每轮写入，用户改完后台模型配置时快照仍是旧值，
    // 导致 NA 发出与设置页不一致的 effort（本轮实测症状）。
    // 现改为 readCurrentBackgroundModelSelection()：快照基线 + journal 增量重放，与官方同源同语义。
    //
    // 注：configuredChatBackgroundModel 的「全局 revision 覆盖」分支需 settings 参数，
    // 而官方 index.js:583 调用时未传 settings，故该分支在当前运行时本就不生效，此处不实现。
    //
    // 路径1：读 chat 的当前 backgroundModelSelection（含 effort），与官方同源。
    try {
      const dataRoot = resolveTavernDataRoot()
      const perChat = dataRoot ? readCurrentBackgroundModelSelection(dataRoot, String(gameId)) : null
      if (perChat && typeof perChat.reasoningEffort === 'string' && perChat.reasoningEffort !== '') {
        bg.reasoningEffort = perChat.reasoningEffort
        dbg('reasoningEffort from per-chat backgroundModelSelection', bg.reasoningEffort)
      } else {
        dbg('per-chat reasoningEffort absent', { hasPerChat: !!perChat })
      }
    } catch (e) { dbg('read per-chat backgroundModelSelection error', str(e?.message || e)) }

    // 路径2：per-chat 未配 effort 时回退前台。
    // 对应官方 resolveChatBackgroundModel 的 `|| fallback`：
    // 官方 fallback 传的是 modelSelection(sessionId)（前台 model），
    // normalizeBackgroundModel 会连带保留 fallback 自带的 effort。
    // 此处保持同一语义——per-chat 未配则 effort 随前台，配置过则以路径1 为准。
    if (!bg.reasoningEffort) {
      try {
        const parentCfg = parent.session?.requestHeader?.()?.config
        if (parentCfg && typeof parentCfg.reasoningEffort === 'string' && parentCfg.reasoningEffort !== '') {
          bg.reasoningEffort = parentCfg.reasoningEffort
          dbg('reasoningEffort fell back to parent session header', bg.reasoningEffort)
        }
      } catch (e) { dbg('read parent reasoningEffort error', str(e?.message || e)) }
    }

    // 同 gameId 结算串行（常驻会话一次只跑一个任务）
    const previous = settleQueues.get(gameId) || Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      let resident
      try {
        resident = await ensureResident(gameId, bg, agents, parent)
      } catch (error) {
        dbg('resident ensure error', str(error?.message || error))
        // create/resume 失败：尽力回收可能已落盘的会话，防止 na-background-* 残留
        try {
          if (typeof agents.resume === 'function') {
            const cleanup = await agents.resume({ resumeSessionId: 'na-background-' + String(gameId || 'unknown').replace(/[^\w-]/g, '_'), setup: async () => {} })
            if (cleanup && typeof cleanup.dispose === 'function') await cleanup.dispose()
            dbg('resident cleanup after ensure failure', { gameId })
          }
        } catch (cleanupError) {
          dbg('resident cleanup failed', str(cleanupError?.message || cleanupError))
        }
        throw error
      }
      const state = { strategy, readCount: 0 }
      activeStrategies.set(gameId, state)
      try {
        // ── 会话层历史清空（rewindTo:-1 语义，复刻 DSHT 官方 rewindBackgroundSurface）──
        // 每轮 followup 前把 surface 的非 fixed 历史替换为空 assistant 墓碑，
        // 模型上下文 = 系统前缀 + 本轮任务 + 本轮工具往返，天然无历史；
        // 不再依赖 llm/stream 后处理裁剪（用户 2026-10-10 拍板路线 A）。
        // 墓碑由编辑轮次包裹（官方 withSurfaceEditTurn 语义），resident.agent 传入以同步
        // phase.lastTurn（循环下一轮号来源；NA 开场白路径同判据）。
        const rewindCount = rewindResidentSurface(resident.agent.session, resident.agent)
        dbg('resident rewind', { sessionId: resident.sessionId, shielded: rewindCount })
        // 每轮任务指令可配置（读自持文件，实时生效）；TASK_MARK 缺失时强制前置（任务开始标记）。
        const taskPrompt = settleTaskPromptOf()
        const taskSection = taskPrompt.includes(TASK_MARK) ? taskPrompt : TASK_MARK + '\n' + taskPrompt
        // 任务消息组装（用户 2026-10-10 精简）：【叙事锚定结算协议】整段静态文本移除（规则已并入
        // 工具 schema/系统提示，不再重复注入；2026-10-17 仅恢复其中的动态 LTM ⚠ 提示，接在
        // 【结算任务】之后）；【人物卡与世界书】段移除（用户拍板，结算
        // 只依据锚点快照 + 本轮正文，不需要卡设定/世界书原料）；快照段只用 strategies 自带的
        // 【当前叙事锚定快照】标题（不再套外层【当前锚点快照】）；
        // 末尾追加【后台指导】（2026-10-10：类似 DSHT GUIDE 的后台版，按会话保存；
        // 默认为空 → 不注入整段，仅配置了才追加）。
        const guide = backgroundGuideOf(gameId)
        // 注入后台（v0.10.4）：勾选「注入后台」的列表元素 → 追加到后台任务（状态之后、正文之前）。
        // 与 settlementSection 的 3-free-slots 段共用 freeSlotsBackText，两条路径同源。
        const fsBack = freeSlotsBackText(fileAnchor)
        // LTM 动态 ⚠ 提示 + 状态未填写提示（2026-10-17 补回 LTM、2026-10-28 并 state）：接在【结算任务】
        // 之后、【后台指导】之前，与纯工具注入路径的 ltm-hints/state-hints 段同源同序。
        // 注意 2026-10-10 移除的是【叙事锚定结算协议】整段**静态文本**（规则已并入工具 schema/系统提示）；
        // 动态提示是"当前已到阈值 / 字段未填写"的逐局催促，不属静态规则，故恢复；无提示时整段不出现。
        const ltmHints = [...ltmHintLines(fileAnchor), ...stateHintLines(fileAnchor)].join('\n')
        const taskText = [
          context !== '' ? context : '',
          fsBack !== '' ? '【自由栏位】\n' + fsBack : '',
          '【本轮正文】\n' + str(text),
          taskSection,
          ltmHints !== '' ? ltmHints : '',
          guide !== '' ? '【后台指导】\n' + guide : ''
        ].filter(Boolean).join('\n\n')
        dbg('resident task start', { sessionId: resident.sessionId, parentId: parent.id, bg })
        resident.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: taskText }],
          // DSH 0.2.x（session format v4）取消了裸 `kind: 'plugin'` + `plugin` 字段的写法，
          // 写入侧 dsh-session-format 的 source() 校验要求「producer-owned source kind」
          // （kind 必须是非空字符串且不等于 'plugin'），否则抛
          // 「format v4 message requires a producer-owned source kind」并导致后台结算每轮失败。
          // 改用与 tavern-plugin message-source.js 一致的 producer-owned 形式 plugin:<name>。
          source: { kind: 'plugin:narrative-anchor' }
        })
        await resident.agent.whenIdle()
        dbg('resident idle', { sessionId: resident.sessionId, readCount: state.readCount, complete: state.strategy.isComplete() })
      } catch (error) {
        dbg('resident settle error', str(error?.message || error))
        throw new Error('叙事锚定结算子 Agent 失败：' + str(error?.message || error))
      } finally {
        activeStrategies.delete(gameId)
      }

      if (!state.strategy.isComplete()) {
        dbg('throw: not complete')
        throw new Error('叙事锚定结算未获得有效锚点提交，退回官方结算')
      }

      // 落库（自持文件唯一权威）
      const anchor = state.strategy.result().anchor
      dbg('persist begin', { hasAnchor: !!anchor, anchorKeys: anchor && typeof anchor === 'object' ? Object.keys(anchor) : null })
      if (anchor && typeof anchor === 'object') persistAnchorOnly(gameId, anchor, maxStm, turn)
      dbg('persist done')

      // STM 合成姿势（界面展示随锚点）：只认本轮提交对象——空提交（{}）无 STM → 不覆写，
      // 姿势结算开启时保持上一轮（与旧编排器"无变化不覆写"语义一致）。
      const stmPosture = stmPostureText(anchor)
      if (stmPosture !== '') { dbg('settle return stmPosture', { len: stmPosture.length }); return { posture: stmPosture } }
      if (tasks?.posture) { dbg('settle return keep posture'); return { posture: str(posture || '') } }
      dbg('settle return empty')
      return {}
    })
    settleQueues.set(gameId, run)
    return run.finally(() => { if (settleQueues.get(gameId) === run) settleQueues.delete(gameId) })
  }

  /** 插件卸载时回收全部常驻结算子 Agent（fire-and-forget，不阻断卸载）。 */
  function disposeResidents() {
    const pending = Array.from(residentHandles.values()).map((resident) =>
      Promise.resolve().then(() => resident.handle.dispose())
        .catch((e) => { dbg('resident final dispose error', str(e?.message || e)) })
    )
    residentHandles.clear()
    activeStrategies.clear()
    settleQueues.clear()
    toolReadCounts.clear()
    return Promise.allSettled(pending)
  }

  /** 定位持久化后台会话目录（sessions/<cwd-hash>/na-background-<gameId>/，cwd-hash 目录未知 → 递归查找）。 */
  function backgroundSessionDirOf(gameId) {
    const sessionId = 'na-background-' + String(gameId || 'unknown').replace(/[^\w-]/g, '_')
    const dataRoot = resolveTavernDataRoot()
    if (!dataRoot) return null
    const sessionsRoot = tavernSessionsDir()
    if (!existsSync(sessionsRoot)) return null
    try {
      for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(sessionsRoot, entry.name, sessionId)
        if (existsSync(candidate)) return candidate
      }
    } catch (e) { dbg('backgroundSessionDirOf scan error', str(e?.message || e)) }
    return null
  }

  /** 目录字节数（递归，仅统计文件）。 */
  function dirBytes(dir) {
    let total = 0
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) total += dirBytes(p)
        else if (entry.isFile()) total += statSync(p).size
      }
    } catch { /* 目录被并发删除等场景忽略 */ }
    return total
  }

  /** 后台结算会话信息（供状态页显示）：{ exists, bytes, sessionId }。 */
  function backgroundSessionInfo(gameId) {
    const sessionId = 'na-background-' + String(gameId || 'unknown').replace(/[^\w-]/g, '_')
    const dir = backgroundSessionDirOf(gameId)
    const busy = activeStrategies.has(gameId) || settleQueues.has(gameId)
    return { ok: true, sessionId, exists: !!dir, bytes: dir ? dirBytes(dir) : 0, busy }
  }

  /**
   * 清空后台结算会话历史（v0.10.5 · 解决后台无压缩导致的会话日志膨胀）：
   * 1. dispose 常驻 handle 并从内存 map 移除（DSH 无官方删除会话 API，事件日志 append-only）；
   * 2. 删除持久化会话目录（session.v*.jsonl.zstd）——下次结算 agents.resume 抛 missingSession
   *    → ensureResident fallback agents.create 新建空会话（保留 system 前缀重建）。
   * 仅匹配 na-background- 前缀会话目录，绝不触碰其他会话/用户数据。
   * @returns {Promise<{ok:boolean, cleared:boolean, freedBytes:number, busy:boolean, error?:string}>}
   */
  async function clearBackgroundSession(gameId) {
    const sessionId = 'na-background-' + String(gameId || 'unknown').replace(/[^\w-]/g, '_')
    const busy = activeStrategies.has(gameId) || settleQueues.has(gameId)
    try {
      // 1. 内存：dispose 常驻 handle（在跑任务会被中断——UI 确认弹窗已提示）
      const resident = residentHandles.get(gameId)
      if (resident) {
        try { await resident.handle.dispose() } catch (e) { dbg('clear resident dispose error', str(e?.message || e)) }
        residentHandles.delete(gameId)
      }
      activeStrategies.delete(gameId)
      settleQueues.delete(gameId)
      // 2. 磁盘：删除持久化会话目录
      const dir = backgroundSessionDirOf(gameId)
      let freedBytes = 0
      if (dir) {
        freedBytes = dirBytes(dir)
        rmSync(dir, { recursive: true, force: true })
        dbg('background session cleared', { sessionId, freedBytes })
      }
      return { ok: true, cleared: !!dir, freedBytes, busy }
    } catch (e) {
      dbg('clear background session error', str(e?.message || e))
      return { ok: false, cleared: false, freedBytes: 0, busy, error: str(e?.message || e) }
    }
  }

  /** 扫描所有原生后台会话目录（sessions/<cwd-hash>/background-* 子目录，排除 na-background-*）。 */
  function nativeBackgroundSessionDirs() {
    const dataRoot = resolveTavernDataRoot()
    if (!dataRoot) return []
    const sessionsRoot = tavernSessionsDir()
    if (!existsSync(sessionsRoot)) return []
    const dirs = []
    try {
      for (const cwdEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!cwdEntry.isDirectory()) continue
        const cwdDir = join(sessionsRoot, cwdEntry.name)
        try {
          for (const bgEntry of readdirSync(cwdDir, { withFileTypes: true })) {
            if (!bgEntry.isDirectory()) continue
            if (bgEntry.name.startsWith('background-') && !bgEntry.name.startsWith('na-background-')) {
              dirs.push(join(cwdDir, bgEntry.name))
            }
          }
        } catch { /* 单个 cwd 目录读取失败忽略 */ }
      }
    } catch (e) { dbg('nativeBackgroundSessionDirs scan error', str(e?.message || e)) }
    return dirs
  }

  /** 原生后台会话信息（供设置页显示）：{ count, totalBytes, dirs }。 */
  function nativeBackgroundSessionsInfo() {
    const dirs = nativeBackgroundSessionDirs()
    let totalBytes = 0
    for (const d of dirs) totalBytes += dirBytes(d)
    return { ok: true, count: dirs.length, totalBytes, dirs: dirs.map(d => basename(d)) }
  }

  /**
   * 清空所有 DSHT 原生后台会话（background-*）：
   * 删除持久化会话目录——官方后台任务（结算/候选/压缩）下次运行时自动新建空会话。
   * 仅匹配 background- 前缀（排除 na-background-），绝不触碰其他会话/用户数据。
   * @returns {Promise<{ok:boolean, cleared:number, freedBytes:number, total:number, error?:string}>}
   */
  async function clearNativeBackgroundSessions() {
    const dirs = nativeBackgroundSessionDirs()
    let freedBytes = 0
    let cleared = 0
    try {
      for (const d of dirs) {
        freedBytes += dirBytes(d)
        rmSync(d, { recursive: true, force: true })
        cleared++
      }
      dbg('native background sessions cleared', { count: cleared, freedBytes })
      return { ok: true, cleared, freedBytes, total: dirs.length }
    } catch (e) {
      dbg('clear native background sessions error', str(e?.message || e))
      return { ok: false, cleared, freedBytes, total: dirs.length, error: str(e?.message || e) }
    }
  }

  /**
   * v3.6：查询某会话最近一次结算实际使用的模型选择（供输入框处 NA 后台模型标签显示）。
   * 进程重启后内存为空 → 回退读 per-chat 后台模型配置（readCurrentBackgroundModelSelection，
   * 即 DSHT 后台模型设置页里的值），保证标签"有配置就显示"。
   * @returns {{ok:boolean, selection?:{provider,model,reasoningEffort}, source?:string, sessionId?:string}}
   */
  function settlementModelInfo(sessionIdOrGameId) {
    const raw = String(sessionIdOrGameId || '')
    // 传入 NA 结算子会话 id（na-background-<gameId>）时反推 gameId——标签显示在
    // **子会话自身**的界面上，而 settleSelections 以 gameId 为键。
    const key = raw.startsWith(SETTLE_SESSION_PREFIX) ? raw.slice(SETTLE_SESSION_PREFIX.length) : raw
    const live = settleSelections.get(key)
    if (live && (live.provider || live.model)) {
      return { ok: true, selection: { provider: live.provider, model: live.model, reasoningEffort: live.reasoningEffort }, source: 'live', sessionId: live.sessionId, gameId: key }
    }
    try {
      const dataRoot = resolveTavernDataRoot()
      const perChat = dataRoot ? readCurrentBackgroundModelSelection(dataRoot, key) : null
      if (perChat && (perChat.provider || perChat.model)) {
        return {
          ok: true,
          selection: { provider: str(perChat.provider), model: str(perChat.model), reasoningEffort: str(perChat.reasoningEffort) },
          source: 'configured'
        }
      }
    } catch (e) { dbg('settlementModelInfo fallback error', str(e?.message || e)) }
    return { ok: true, selection: null, source: 'none' }
  }

  /** settlementTool 注册项（MVU 结算 + 官方结算兜底共用；execute 返回 JSON 字符串）。
   *  官方调用形态（plugin-api.js:913）：execute({ gameId, turn, arguments })，不传 exec——
   *  故本路径拿不到 concludeTurn，"submit 即终止"只存在于接管路径；每轮插件工具 ≤8 次
   *  （MAX_TOOL_CALLS_PER_SETTLEMENT）且须在官方 submit 之前调用，均为官方硬约束。
   *  2026-10-17：与接管路径对齐——补锚点总开关门（enabled=false 拒绝执行）与
   *  read 每轮 3 次上限（toolReadCounts 自管）。 */
  const tools = [
    {
      name: NARRATIVE_ANCHOR_READ_TOOL.name,
      description: NARRATIVE_ANCHOR_READ_TOOL.description,
      parameters: NARRATIVE_ANCHOR_READ_TOOL.parameters,
      async execute({ gameId, turn, arguments: args }) {
        const { fileAnchor } = anchorOf(gameId)
        // 锚点总开关（与 settle 路径同语义）：本局停用时拒绝执行，官方结算继续、不写 NA 数据
        if (fileAnchor?.meta?.settings?.enabled === false) {
          return JSON.stringify({ ok: false, retryable: false, error: '叙事锚定已在本局设置中关闭，请不要调用叙事锚定工具，继续完成本轮结算。' })
        }
        // read 每轮上限 3 次（接管路径由 activeStrategies.readCount 强制；工具路径无跨调用
        // 状态，按 gameId+turn 自管；turn 变化或 submit 成功后计数重置）
        const readKey = String(gameId || '')
        const readTurn = Math.max(0, Number(turn) || 0)
        const prevRead = toolReadCounts.get(readKey)
        const usedRead = prevRead && prevRead.turn === readTurn ? prevRead.count : 0
        if (usedRead >= 3) {
          return JSON.stringify({ ok: false, retryable: false, message: 'narrative_anchor_read 每轮结算最多 3 次，请直接调用 narrative_anchor_submit 提交最终结果。' })
        }
        toolReadCounts.set(readKey, { turn: readTurn, count: usedRead + 1 })
        return strategyHandle('read', gameId, fileAnchor, args)
      }
    },
    {
      name: NARRATIVE_ANCHOR_SUBMIT_TOOL.name,
      description: NARRATIVE_ANCHOR_SUBMIT_TOOL.description,
      parameters: NARRATIVE_ANCHOR_SUBMIT_TOOL.parameters,
      async execute({ gameId, turn, arguments: args }) {
        const { fileAnchor, maxStm } = anchorOf(gameId)
        // 锚点总开关：关闭时拒绝提交（模型收到明确指示，不会反复重试）
        if (fileAnchor?.meta?.settings?.enabled === false) {
          return JSON.stringify({ ok: false, retryable: false, error: '叙事锚定已在本局设置中关闭，本轮不提交锚点数据，请继续完成本轮结算。' })
        }
        const strategy = createAnchorStrategy(strategyInputFor(gameId, fileAnchor))
        const text = await strategy.handle({ name: NARRATIVE_ANCHOR_SUBMIT_TOOL.name, arguments: args })
        if (strategy.isComplete()) {
          toolReadCounts.delete(String(gameId || '')) // 本轮结束，read 计数重置
          const anchor = strategy.result().anchor
          if (anchor && typeof anchor === 'object') persistAnchorOnly(gameId, anchor, maxStm, turn)
        }
        return text
      }
    }
  ]

  /** settlementSection 文本：锚点结算协议（含 LTM 动态提示）。
   *  注：2026-10-10 用户拍板协议文本不再注入结算请求（静态规则已并入工具 schema /
   *  结算系统提示），本函数保留供复用/诊断；动态提示改由 ltmHintsSection 单独承载。 */
  function protocol({ gameId, turn } = {}) {
    const { fileAnchor } = anchorOf(gameId)
    const input = strategyInputFor(gameId, fileAnchor)
    return str(createAnchorStrategy(input).protocol()).trim()
  }

  /** settlementSection：当前叙事锚定快照（2026-10-17 补）。
   *  纯工具注入路径此前只有工具可用，而 read 工具只检索 STM/known_facts、不返回
   *  current_state——结算模型看不到"当前状态/叙事备忘"语境。本段与 settle 任务消息的
   *  快照同源（strategies contextSection），官方拼进【插件附加的结算任务】。
   *  官方单段上限 8000 字（plugin-api.js:8）：超限时官方截断尾部（=当前状态段），
   *  这里记录长度便于诊断；长局若触发应按需精简 known_facts 注入面。 */
  function anchorSnapshotSection({ gameId } = {}) {
    const { fileAnchor } = anchorOf(gameId)
    const text = str(createAnchorStrategy(strategyInputFor(gameId, fileAnchor)).contextSection()).trim()
    if (text.length > SECTION_TEXT_LIMIT) dbg('anchor snapshot section exceeds official cap', { gameId, len: text.length, cap: SECTION_TEXT_LIMIT })
    return text
  }

  /** settlementSection：LTM 动态提示 + 状态未填写提示（⚠ 行；无提示返回 ''，官方跳过空段）。
   *  与 strategies.protocol() 中的提示同源（ltmHintLines / stateHintLines），但只含动态催促——
   *  静态提交规则按 2026-10-10 拍板不注入（工具 schema/系统提示已承载）。 */
  function ltmHintsSection({ gameId } = {}) {
    const { fileAnchor } = anchorOf(gameId)
    return [...ltmHintLines(fileAnchor), ...stateHintLines(fileAnchor)].join('\n')
  }

  /** settlementSection：自由栏位「注入后台」元素（与 settle 任务消息的【自由栏位】段同源）。 */
  function freeSlotsSection({ gameId } = {}) {
    const { fileAnchor } = anchorOf(gameId)
    const fsBack = freeSlotsBackText(fileAnchor)
    return fsBack !== '' ? '【自由栏位】\n' + fsBack : ''
  }

  /** 后台指导段文本（2026-10-10）：settlementSection 承载，MVU 官方结算任务末尾注入【后台指导】。
   *  与已移除的【叙事锚定结算协议】不同——本段为通用后台工作准则；配置为空时返回 ''（官方跳过）。
   *  ⚠ 调用方必须传 { gameId }：官方以 text({gameId,turn}) 调用，无参调用会在解构时抛
   *  TypeError，被官方 collectSections catch 后静默跳过整段（2026-10-17 修复见 index.js）。 */
  function guideSection({ gameId } = {}) {
    const guide = backgroundGuideOf(gameId)
    return guide !== '' ? '【后台指导】\n' + guide : ''
  }

  return { settle, tools, protocol, anchorSnapshotSection, ltmHintsSection, freeSlotsSection, guideSection, backendProtocolSection, disposeResidents, backgroundSessionInfo, clearBackgroundSession, nativeBackgroundSessionsInfo, clearNativeBackgroundSessions, settlementModelInfo }
}

/** 工具执行分派（read/submit 走策略 handle）。 */
async function strategyHandle(kind, gameId, fileAnchor, args) {
  const strategy = createAnchorStrategy(strategyInputFor(gameId, fileAnchor))
  const name = kind === 'read' ? NARRATIVE_ANCHOR_READ_TOOL.name : NARRATIVE_ANCHOR_SUBMIT_TOOL.name
  return strategy.handle({ name, arguments: args || {} })
}
