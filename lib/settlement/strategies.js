/**
 * 叙事锚定独立结算路线 —— 结算策略（v0.8.0）
 *
 * v0.8.0 重大变更：
 *  - STM：永远累积不清空，每轮1条
 *  - LTM：树形结构（每7条STM→depth1，每5个同深度节点→更高层）
 *  - 工具参数新增 ltm_leaf / ltm_merge
 *
 * [2026-10-09 v2.2 清理] 旧编排器专属策略（姿势/变量/台账 + createSettlementStrategies +
 * resumeVariableSubmission）已随 orchestrator 移除（v2.2 replaceSettlement 只消费
 * createAnchorStrategy）；完整历史见 legacy-user-tool-backup/dead-code-v2-orchestrator/。
 *
 * 设计模式：策略（Strategy）
 * 每个后台结算任务封装为独立策略，统一接口：
 *   enabled(input)     是否按开关启用
 *   tools()            工具定义
 *   protocol()         system 协议片段
 *   contextSection()   turnContext 快照片段
 *   canHandle(call)    工具分发判断
 *   async handle(call) 执行工具，返回工具结果 JSON
 *   isComplete()       完成条件（stopToolsWhen / acceptWithoutText）
 *   result()           结算结果片段（anchor）
 *   fatalMissing()     结算结束后必须存在的检查（缺失抛错）
 */

import { str, object } from './mvu-audit.js'
import { checkLtmNeeds, formatLtmTree, focusUnitCount } from './store.js'
import { readAnchor } from '../data-store.js'

/* ─────────────────────────── 锚点工具定义 ─────────────────────────── */

export const NARRATIVE_ANCHOR_READ_TOOL = Object.freeze({
  name: 'narrative_anchor_read',
  description: '检索叙事锚定记忆（STM短期记忆 / known_facts已知情报），用于回忆剧情细节。query 为关键词，多个关键词用空格分隔；返回匹配条目的摘要，不是完整锚点数据。每次结算最多调用 3 次。',
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, description: '搜索关键词（人物/地点/事件/物品/关系），多个用空格分隔' },
      kind: { type: 'string', enum: ['all', 'stm', 'known_facts'], description: '搜索范围：all=全部（默认），stm=仅短期记忆，known_facts=仅已知情报' },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回多少条命中，默认 5' }
    },
    required: ['query']
  })
})

export const NARRATIVE_ANCHOR_SUBMIT_TOOL = Object.freeze({
  name: 'narrative_anchor_submit',
  description: [
    '提交叙事锚定数据',
    '规则：',
    '(1)当前状态按字段增量提交：只提交变化的字段，未提交的字段自动保留',
    '(2)记忆：',
    '  - stm 每轮恰好 1 条，永远累积不清空；time/location 由系统自动从 current_state 填充',
    '  - 未合并 STM 达 7 条时，本轮必须同时提交 ltm_leaf；提交后这 7 条 STM 标记为已合并',
    '  - LTM 树某深度根节点达 5 个时，本轮必须同时提交 ltm_merge',
    '  - stm / ltm_leaf / ltm_merge 均必须携带 title：不超过 12 字的标题，概括该条内容核心',
    '  - known_facts 动态世界书，Not limited to setting entries such as characters, items, geography, keys, organizations, rules, worldviews. Submission is not mandatory:NO滥竽充数',
    '(3)只依据本轮正文已发生事实更新，不预测',
    '(4)本轮无任何变化时提交空对象 {}'
  ].join('\n'),
  parameters: Object.freeze({
    type: 'object',
    additionalProperties: true,
    properties: {
      // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
      // plot_route: { type: 'object', additionalProperties: true, description: '大纲路线', properties: {
      //   current_node: { type: 'string', description: '当前剧情节点' },
      //   recap: { type: 'string', description: '前情衔接摘要' },
      //   next_scene: { type: 'string', description: '下一幕规划' }
      //   // [2026-09-29 暂停] foreshadowing 活跃伏笔暂时不单独维护
      //   // foreshadowing: { type: 'array', items: { type: 'string' }, description: '当前活跃的伏笔' }
      // } },
      current_state: { type: 'object', additionalProperties: true, description: '当前状态，未提交字段自动保留, 比如world不必每轮提交', properties: {
        time: { type: 'string' }, world: { type: 'string' }, location: { type: 'string' },
        characters: { type: 'array', items: { type: 'string' } , description: 'Characters present; for key absent characters, state the reasons' },
        environment: { type: 'array', items: { type: 'string' }, description: '环境/关键场景要素（非地点），名词数组（如 ["魔法阵","狂风","巨树"]），禁止长段描述，Only necessary, no listing' },
        items: { type: 'array', items: { type: 'string' }, description: '关键物品名词数组' },
        focus: { type: 'string', description: '100字内叙事备忘：Log long-term memory keys, Prohibit repeating STM. Track narrative arcs, stay decoupled from active scene. Long-term projections permitted. No submission without major revisions' }
      } },
      memory: { type: 'object', additionalProperties: false, description: '多级记忆', properties: {
        stm: { type: 'array', description: '本轮记忆（每轮仅 1 条）：概括剧情（事件经过/时空/关键结果），一条代表一轮，永远累积不清空；', items: { type: 'object', additionalProperties: true, properties: {
          title: { type: 'string', description: '本条记忆标题（必填，不超过 12 字，概括核心事件，如"涩谷Noise初战退敌"）' },
          summary: { type: 'string', description: '本轮剧情概括与关键信息，客观无主观修饰' }
        } } },
        ltm_leaf: { type: 'object', description: 'LTM 叶节点生成（仅当未合并 STM 达到 7 条时提交，必须携带 keywords）：从最旧的 7 条未合并 STM 中提取关键信息，写成一条连贯摘要', properties: {
          title: { type: 'string', description: '本节点标题（必填，不超过 12 字，概括合并范围的核心，如"涩谷崩塌事件"）' },
          summary: { type: 'string', description: '7 条 STM 合并后的关键信息摘要（真正对未来有影响的内容）' },
          keywords: { type: 'array', items: { type: 'string' }, description: '3-6 个关键词，用于后续世界书召回触发，必须是正文中自然会出现的词' },
          stm_count: { type: 'number', description: '合并的 STM 数量，默认 7' }
        } },
        ltm_merge: { type: 'object', description: 'LTM 中间节点合并（仅当某深度根节点达到 5 个时提交，必须携带 keywords）：将指定深度最旧的 5 个节点合并为一个更高层节点', properties: {
          depth: { type: 'number', description: '要合并的深度（1=叶节点层，2=第二层，以此类推）' },
          title: { type: 'string', description: '合并后节点标题（必填，不超过 12 字，覆盖合并范围的核心）' },
          summary: { type: 'string', description: '合并后的摘要' },
          keywords: { type: 'array', items: { type: 'string' }, description: '3-8 个关键词，覆盖合并范围内所有关键信息，用于世界书召回触发' },
          count: { type: 'number', description: '合并的节点数量，默认 5' }
        } },
        known_facts: { type: 'array', description: 'flow into worldbook entries, long-term facts only. Append only this turn\'s new Facts; do NOT duplicate existing content from history/memory/state. Match by entry title to append to existing entry, even if not visible. Use clear entry titles.', items: { type: 'object', additionalProperties: true, properties: {
          entry: { type: 'string', description: '条目实体名，相同时追加，分类拆分' },
          summary: { type: 'string', description: '追加内容，仅关键设定，剔除流水；禁止将事件、人物条目混用' },
          keywords: { type: 'array', items: { type: 'string' }, description: '2-10 触发词，Avoid common words, be recognizability' }
        } } }
        // [2026-09-29 暂停] foreshadow_library 伏笔库暂时不单独维护
        // foreshadow_library: { type: 'array', description: '伏笔库', items: { type: 'object', additionalProperties: true, properties: {
        //   id: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['active', 'resolved', 'abandoned'] }
        // } } }
      } },
      free_slots: { type: 'object', additionalProperties: true, description: '【默认不提交】：需要提交时会有显示指导', properties: {
        list: { type: 'array', description: '自由栏位-列表（按下标写入：元素 { index, display }，index 从 0 起，未提交的下标保留现状）', items: { type: 'object', additionalProperties: true, properties: {
          index: { type: 'integer', description: '下标，0起' },
          display: { type: 'string', description: '内容' }
        } } }
      } }
    }
  })
})

/* ─────────────────────────── 锚点记忆搜索（前后台共用）────────────────────────── */

/**
 * 在锚点数据中搜索 STM 和 known_facts，返回匹配条目（按匹配度降序，同分按存储序、旧的在前——
 * 为召回远处历史，近处一般可直接看到或已被 LTM 覆盖）。
 * v0.9.22 评分：IDF × 命中等级。
 *   - 整词连续命中：2 × idf
 *   - 碎裂命中（≥3 字且含 CJK 的词整词未中时，按 2 字滑窗命中率 ≥0.5）：1 × 命中率 × idf
 *   - idf = log(1 + N/df)：专名（低 df）权重高、口水词（"的"类）自动压低，无需停用词表
 * 仅搜 STM 与 known_facts——LTM 是压缩概括层，靠注入通道，不参与检索。
 * 供后台 narrative_anchor_read 和前台同名工具共用。
 */
export function searchAnchorMemory(anchor, query, kind = 'all', limit = 5) {
  if (!anchor || typeof anchor !== 'object' || !query) return { results: [], total: 0 }
  const keywords = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return { results: [], total: 0 }
  const results = []

  // 统一候选集：[{ kind, index, text(小写), e/f(原条目) }]
  const entries = []
  if (kind === 'all' || kind === 'stm') {
    const stmList = Array.isArray(anchor.memory?.stm) ? anchor.memory.stm : []
    stmList.forEach((e, i) => {
      if (e && e.summary) entries.push({ kind: 'stm', index: i, text: (e.time + ' ' + e.location + ' ' + e.summary).toLowerCase(), e })
    })
  }
  if (kind === 'all' || kind === 'known_facts') {
    const kfList = Array.isArray(anchor.memory?.known_facts) ? anchor.memory.known_facts : []
    kfList.forEach((f, i) => {
      if (f && f.entry) entries.push({ kind: 'known_facts', index: i, text: (f.entry + ' ' + (f.summary || '')).toLowerCase(), f })
    })
  }

  const hasCJK = (s) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s)
  const bigrams = (s) => {
    const grams = []
    for (let i = 0; i + 2 <= s.length; i++) grams.push(s.slice(i, i + 2))
    return grams
  }

  // IDF：df 在候选集上按整词 includes 统计
  const N = entries.length
  const idfOf = (kw) => {
    let df = 0
    for (const e of entries) if (e.text.includes(kw)) df++
    return Math.log(1 + N / Math.max(1, df))
  }

  const kwWeights = keywords.map((kw) => {
    const idf = idfOf(kw)
    // 碎裂匹配仅对 ≥3 字且含 CJK 的词启用（纯 ASCII 短语的 2 字滑窗会产生无意义片段）
    const grams = kw.length >= 3 && hasCJK(kw) ? bigrams(kw) : null
    return { kw, idf, grams }
  })

  for (const e of entries) {
    const gramRatios = kwWeights.map(({ grams }) => {
      if (grams === null) return null
      let hit = 0
      for (const g of grams) if (e.text.includes(g)) hit++
      return grams.length ? hit / grams.length : 0
    })
    let score = 0
    kwWeights.forEach(({ kw, idf }, ki) => {
      if (e.text.includes(kw)) { score += 2 * idf; return }
      const r = gramRatios[ki]
      if (r !== null && r >= 0.5) score += 1 * r * idf
    })
    if (score <= 0) continue
    if (e.kind === 'stm') {
      const itm = e.e
      results.push({ kind: 'stm', index: e.index, time: itm.time || '', location: itm.location || '', summary: itm.summary, merged: itm.merged_into != null, score })
    } else {
      const f = e.f
      results.push({ kind: 'known_facts', index: e.index, entry: f.entry, summary: f.summary || '', score })
    }
  }

  // 稳定排序：同分保持存储序（旧的在前）
  results.sort((a, b) => b.score - a.score)
  const max = Math.min(10, Math.max(1, Number(limit) || 5))
  return { results: results.slice(0, max), total: results.length }
}

/* ─────────────────────────── 锚点策略 ─────────────────────────── */

function anchorSnapshot(input) {
  // v0.9.3：优先读插件自持文件（零 DSHT 依赖），避免 chat 快照未同步 narrativeAnchor 导致"尚无数据"
  const sessionId = input.snapshot?.sessionId || ''
  const fileAnchor = sessionId ? readAnchor(sessionId) : null
  const current = fileAnchor || input.snapshot?.narrativeAnchor
  if (current && typeof current === 'object') {
    // v0.9.0：sections 按"变化频率"重排，稳定内容在前、每轮变化的在后，
    // 以拉长一次性会话 followup 的可缓存前缀（前缀缓存：分歧点越靠后，命中越长）。
    //   LTM roots（每 7+ 轮才变）→ 已知情报（增量、很少变）→ 当前状态（每轮重写）
    //   → STM（仅在末尾追加 1 条）→ 大纲路线（每轮可能变）
    const parts = {}

    // 当前状态（每轮重写）
    const cs = current.current_state || {}
    // 2026-10-10：字段不能省 —— 全部字段固定输出，空字段显式占位 unfilled
    // （保证快照结构稳定：模型可见"该字段为空"与"无此字段"的差别）
    const csParts = [
      `时间: ${cs.time || 'unfilled'}`,
      `世界: ${cs.world || 'unfilled'}`,
      `地点: ${cs.location || 'unfilled'}`,
      `在场人物: ${Array.isArray(cs.characters) && cs.characters.length > 0 ? cs.characters.join(', ') : 'unfilled'}`,
      `环境: ${cs.environment || 'unfilled'}`,
      `物品: ${Array.isArray(cs.items) && cs.items.length > 0 ? cs.items.join(', ') : 'unfilled'}`,
      `叙事备忘: ${cs.focus || 'unfilled'}`,
    ]
    parts.state = '【当前状态】\n' + csParts.join('\n')

    // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
    // // 大纲路线（每轮可能变）
    // const pr = current.plot_route || {}
    // const prParts = []
    // if (pr.current_node) prParts.push(`当前节点: ${pr.current_node}`)
    // if (pr.recap) prParts.push(`前情衔接: ${pr.recap}`)
    // if (pr.next_scene) prParts.push(`下一幕规划: ${pr.next_scene}`)
    // // [2026-09-29 暂停] 活跃伏笔暂时不单独维护，伏笔信息自然流入STM
    // // if (Array.isArray(pr.foreshadowing) && pr.foreshadowing.length > 0) prParts.push(`活跃伏笔: ${pr.foreshadowing.join('; ')}`)
    // if (prParts.length > 0) parts.plot = '【大纲路线】\n' + prParts.join('\n')

    // STM：仅显示未合并的最近条目（每轮末尾追加 1 条，前缀稳定）
    const stm = current.memory?.stm || []
    const unmergedStm = stm.filter((e) => e.merged_into == null)
    if (unmergedStm.length > 0) {
      const stmText = unmergedStm.slice(-7).map((e, i) => `${i + 1}. [${e.time || ''} @ ${e.location || ''}] ${e.summary}`).join('\n')
      parts.stm = `【近期记忆 STM】（未合并）\n${stmText}`
    }

    // LTM 根节点摘要（roots 层，每 7+ 轮才变）
    const ltmText = formatLtmTree(current)
    if (ltmText) parts.ltm = '【长期记忆 LTM】（根节点摘要）\n' + ltmText

    // known_facts（v0.9.7：精简注入——只注入标题，随机各1条含内容，减少 token）
    // 规则：最近10条标题 + 随机5条标题；最近10条中随机1条含内容，随机5条中随机1条含内容
    const allKf = Array.isArray(current.memory?.known_facts) ? current.memory.known_facts : []
    if (allKf.length > 0) {
      // 用户 2026-10-10：目录整体按旧→新排列。存储数组本身旧→新（新条目/最近编辑
      // 追加到末尾），slice(-10) 保持原序输出即为旧→新；随机 5 条随机选取后
      // 再按存储原序排列，避免乱序展示。
      const recent10 = allKf.slice(-10)
      // 随机5条：从排除最近10条后的剩余条目中抽取，避免与最近部分重复
      const excludeIds = new Set(recent10)
      const pool = allKf.filter(f => !excludeIds.has(f))
      const shuffled = [...pool].sort(() => Math.random() - 0.5)
      const picked = shuffled.slice(0, Math.min(5, pool.length))
      const random5 = picked.sort((a, b) => pool.indexOf(a) - pool.indexOf(b))
      // 最近10条中随机1条含内容
      const recentContentIdx = Math.floor(Math.random() * recent10.length)
      // 随机5条中随机1条含内容
      const randomContentIdx = Math.floor(Math.random() * random5.length)

      const kfLines = []
      kfLines.push(`── 最近 ${recent10.length} 条 ──`)
      recent10.forEach((f, i) => {
        if (i === recentContentIdx) {
          kfLines.push(`- ${f.entry}：${f.summary || ''}`)
        } else {
          kfLines.push(`- ${f.entry}`)
        }
      })
      if (random5.length > 0) {
        kfLines.push(`── 随机 ${random5.length} 条 ──`)
        random5.forEach((f, i) => {
          if (i === randomContentIdx) {
            kfLines.push(`- ${f.entry}：${f.summary || ''}`)
          } else {
            kfLines.push(`- ${f.entry}`)
          }
        })
      }
      kfLines.push(`（共 ${allKf.length} 条，以上仅标题，详情可 narrative_anchor_read 检索，但尽量不要检索）`)
      // 标题保持固定文本（前缀稳定：标题位置不带变化量），共 N 条等变化量全部放尾部提示行
      parts.known = `【已知情报目录】\n` + kfLines.join('\n')
    }

    // 用户 2026-10-10 拍板的标准组织顺序（快照内）：LTM → 近期记忆 STM → 已知情报 → 当前状态。
    // 注：STM 是变化最大的段，提前会让跨轮前缀更早断裂（牺牲部分缓存命中率），
    // 但用户明确以该顺序为语义标准，优先语义。
    const ordered = [parts.ltm, parts.stm, parts.known, parts.state, parts.plot].filter(Boolean)
    if (ordered.length === 0) return '【当前叙事锚定快照】\n（尚无叙事锚定数据）'
    return '【当前叙事锚定快照】\n' + ordered.join('\n\n')
  }
  return '【当前叙事锚定快照】\n（尚无叙事锚定数据）'
}

/**
 * 动态 LTM 提示行（⚠ 开头）：未合并 STM / 同深度根节点 / 总根节点达提示阈值时生成。
 * 提示阈值（非强制）：STM 7 条 / 同深度 5 节点 / 总根 10 个；强制提交校验在
 * createAnchorStrategy 的 submit handle（11 条 / 8 节点），静态规则在工具描述。
 * 输入为锚点对象（null/undefined 按空锚点处理）；供 protocol() 与纯工具注入路径的
 * settlementSection（official-v2.js ltmHintsSection）共用，保证两条路径提示一致。
 */
export function ltmHintLines(anchor) {
  const needs = checkLtmNeeds(anchor || { memory: { stm: [], ltm_tree: { nodes: {}, roots: [] } } })
  const hints = []
  if (needs.needLeafLtm) {
    hints.push(`⚠ 未合并 STM 已达 ${needs.unmergedStm} 条（>=7），建议本轮提交 memory.ltm_leaf（title + summary），将最旧的 7 条 STM 合并为一条 LTM 叶节点。`)
  }
  if (needs.needMergeDepth > 0) {
    hints.push(`⚠ LTM 树 depth=${needs.needMergeDepth} 层根节点已达 5 个，建议本轮提交 memory.ltm_merge（depth=${needs.needMergeDepth}, title + summary），合并为更高层节点。`)
  }
  if (needs.needRootMerge) {
    hints.push(`⚠ LTM 树根节点总数已达 ${needs.rootCount} 个（>=10），建议尽快通过 ltm_merge 合并同深度节点以减少根节点数量；达到 15 个时程序将自动兜底合并。`)
  }
  return hints
}

export function createAnchorStrategy(input) {
  let submitted = null
  return {
    key: 'anchor',
    enabled: () => true,
    tools: () => [NARRATIVE_ANCHOR_READ_TOOL, NARRATIVE_ANCHOR_SUBMIT_TOOL],
    protocol: () => {
      // 动态检测 LTM 需求，在协议中提示（v0.9.3：优先读自持文件）
      const sessionId = input.snapshot?.sessionId || ''
      const fileAnchor = sessionId ? readAnchor(sessionId) : null
      const ltmHints = ltmHintLines(fileAnchor || input.snapshot?.narrativeAnchor)
      return [
        '【叙事锚定结算协议】本轮必须调用 narrative_anchor_submit 工具提交叙事锚定数据（提交规则详见工具描述）',
        ...ltmHints,
        '只依据本轮正文已发生事实更新，Brief thinking, no drafts', 
        '！强调记忆分工，不要把known_facts当做事件流水，那是STM的工作；No posture_submit',
        'Submit candidate_submit_choices. If main text contains options, PROHIBIT CONSISTENCY, Write your own. Player perspective',
        'narrative_anchor_submit 是最后一步，调用后循环立即由程序终止，必须最后提交：若有其他工具需调用，在同一次回复中同时调用，互不依赖。必须在一次调用中全部提交，禁止拆分多次',
        '⚠ 工具调用是唯一提交通道：禁止在回复文本中输出锚定数据或"已提交"类复述；未调用工具 = 本轮结算失败。'
      ].join('\n')
    },
    contextSection: () => anchorSnapshot(input),
    canHandle: (call) => call && (call.name === NARRATIVE_ANCHOR_READ_TOOL.name || call.name === NARRATIVE_ANCHOR_SUBMIT_TOOL.name),
    async handle(call) {
      if (call.name === NARRATIVE_ANCHOR_READ_TOOL.name) {
        // v0.9.5：关键词检索，只搜索 STM 和 known_facts，限制返回数量
        const args = object(call.arguments) || {}
        const query = str(args.query) || ''
        if (!query) return JSON.stringify({ ok: false, error: 'query 不能为空' })
        const kind = args.kind === 'stm' || args.kind === 'known_facts' ? args.kind : 'all'
        const limit = Math.min(10, Math.max(1, Number(args.limit) || 5))

        const sessionId = input.snapshot?.sessionId || ''
        const fileAnchor = sessionId ? readAnchor(sessionId) : null
        const current = fileAnchor || input.snapshot?.narrativeAnchor
        if (!current || typeof current !== 'object') {
          return JSON.stringify({ ok: true, query, results: [], total: 0, note: '尚无叙事锚定数据' })
        }

        const { results, total } = searchAnchorMemory(current, query, kind, limit)
        return JSON.stringify({ ok: true, query, kind, total, returned: results.length, results })
      }
      // narrative_anchor_submit
      const value = object(call.arguments)
      const mem = object(value.memory)

      // 校验：STM 每轮最多 1 条
      const newStm = Array.isArray(mem.stm) ? mem.stm.length : 0
      if (newStm > 1) {
        return JSON.stringify({
          ok: false, retryable: true,
          error: 'stm 每轮只能提交 1 条（本轮提交了 ' + newStm + ' 条）。请只保留 1 条概括本轮剧情主干与关键信息的记忆。'
        })
      }

      // 校验：未合并 STM 达到强制阈值（11 条 = 7 × 1.5）时必须提交 ltm_leaf
      // 提示阈值仍为 7 条（上下文 ⚠ 警告），报错信息中的数字保持写死的"7 条"不变
      const sessionId2 = input.snapshot?.sessionId || ''
      const fileAnchor2 = sessionId2 ? readAnchor(sessionId2) : null
      const currentAnchor2 = fileAnchor2 || input.snapshot?.narrativeAnchor
      const needs = checkLtmNeeds(currentAnchor2 || { memory: { stm: [], ltm_tree: { nodes: {}, roots: [] } } })
      if (needs.forceLeafLtm && !(mem.ltm_leaf && str(mem.ltm_leaf.summary))) {
        return JSON.stringify({
          ok: false, retryable: true,
          error: '未合并 STM 已达 ' + needs.unmergedStm + ' 条（>=7）。必须在本次提交中提供 memory.ltm_leaf.summary：从最旧的 7 条未合并 STM 中提取真正有长期价值的关键信息，写成一条连贯摘要。提交后这 7 条 STM 将标记为已合并。'
        })
      }

      // 校验：某深度根节点达到强制阈值（8 个 = 5 × 1.5）时必须提交 ltm_merge
      // 提示阈值仍为 5 个（上下文 ⚠ 警告），报错信息中的数字保持写死的"5 个"不变
      if (needs.forceMergeDepth > 0 && !(mem.ltm_merge && str(mem.ltm_merge.summary) && Number(mem.ltm_merge.depth) > 0)) {
        return JSON.stringify({
          ok: false, retryable: true,
          error: 'LTM 树 depth=' + needs.forceMergeDepth + ' 层根节点已达 5 个。必须在本次提交中提供 memory.ltm_merge（depth=' + needs.forceMergeDepth + ', summary=...）：将该深度最旧的 5 个节点合并为一个更高层节点，summary 为合并后的摘要。'
        })
      }

      // 同轮多次 submit 合并（兜底）
      const incoming = normalizeAnchorSubmission(value)
      submitted = submitted === null ? incoming : mergeAnchorSubmission(submitted, incoming)
      // focus 超 100 字（名义上限）：正常提交，仅告知已被截断，无需重复提交
      const focusVal = object(value).current_state?.focus
      if (focusVal !== undefined && focusUnitCount(focusVal) > 100) {
        return JSON.stringify({ ok: true, accepted: true, note: 'current_state.focus 已超过 100 字上限，超出部分已被截断；本轮已正常提交，无需重复提交。' })
      }
      return JSON.stringify({ ok: true, accepted: true })
    },
    isComplete: () => submitted !== null,
    result: () => ({ anchor: submitted }),
    fatalMissing: () => submitted === null ? '后台 Agent 未调用 narrative_anchor_submit 提交叙事锚定数据' : ''
  }
}

/** 校验并规整一次锚点提交（宽松结构：额外字段保留，缺失字段忽略）。 */
function normalizeAnchorSubmission(value) {
  const data = object(value)
  const clean = {}
  // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
  // if (object(data.plot_route) && Object.keys(object(data.plot_route)).length > 0) clean.plot_route = object(data.plot_route)
  if (object(data.current_state) && Object.keys(object(data.current_state)).length > 0) clean.current_state = object(data.current_state)
  const mem = { ...object(data.memory) }
  // 接口参数兼容：schema 定义 known_facts 在 memory 内，但 deepseek-v4-flash 等模型
  // 约 47% 的提交把它放在参数顶层（历史 journal 实测）。顶层合法（additionalProperties:true），
  // 合并层只读 memory.known_facts —— 这里归位，避免静默丢失。
  if (!Array.isArray(mem.known_facts) && Array.isArray(data.known_facts)) mem.known_facts = data.known_facts
  if (Object.keys(mem).length > 0) clean.memory = mem
  // v0.10.4：自由栏位（与 current_state/memory 同级）——模型可选提交【默认不提交】；
  // 仅保留 list（按下标写入）：元素 { index, display }，index 归一化到非负整数；
  // undefined=未提交该字段，合并/落库层保持现状；空数组视为未提交（避免误清空整列）
  const fs = object(data.free_slots)
  if (fs && typeof fs === 'object') {
    const cleanFs = {}
    if (fs.list !== undefined) {
      if (Array.isArray(fs.list)) {
        const cleanList = []
        for (const item of fs.list) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue
          const o = {}
          o.index = Number.isFinite(Number(item.index)) ? Math.max(0, Math.floor(Number(item.index))) : 0
          if (item.display !== undefined) o.display = str(item.display)
          cleanList.push(o)
        }
        // 仅非空提交（空数组视为未提交，避免误清空整列）
        if (cleanList.length > 0) cleanFs.list = cleanList
      }
    }
    if (Object.keys(cleanFs).length > 0) clean.free_slots = cleanFs
  }
  return clean
}

/**
 * v0.8.0：合并同轮多次锚点提交。
 * 顶层字段（current_state）按最新值覆盖；
 * memory 内部：stm 按最新值覆盖，ltm_leaf / ltm_merge 累积（取最后一次有效提交），known_facts 按 entry 增量合并去重。
 * [2026-09-29 暂停] plot_route 大纲路线、foreshadow_library 伏笔库暂时不单独维护
 */
function mergeAnchorSubmission(prev, incoming) {
  const out = { ...(prev || {}) }
  // [2026-09-29 暂停] 大纲路线暂时不单独维护
  // if (incoming.plot_route) out.plot_route = incoming.plot_route
  if (incoming.current_state) out.current_state = incoming.current_state
  // v0.10.2：自由栏位同轮多次提交取最新；list 按下标合并（不同下标多次提交互不覆盖）
  if (incoming.free_slots) {
    const prevFs = object(out.free_slots)
    if (Array.isArray(incoming.free_slots.list) && Array.isArray(prevFs.list)) {
      const merged = prevFs.list.slice()
      for (const item of incoming.free_slots.list) {
        if (!item || typeof item !== 'object') continue
        const idx = Number.isFinite(Number(item.index)) ? Math.max(0, Math.floor(Number(item.index))) : 0
        while (merged.length <= idx) merged.push({})
        merged[idx] = { ...(merged[idx] || {}), ...item }
      }
      out.free_slots = { ...incoming.free_slots, list: merged }
    } else {
      out.free_slots = incoming.free_slots
    }
  }
  if (incoming.memory) {
    const pm = object(out.memory)
    const im = object(incoming.memory)
    const nm = { ...pm }
    if (Array.isArray(im.stm)) nm.stm = im.stm
    // ltm_leaf / ltm_merge：取最后一次有效提交
    if (im.ltm_leaf && str(im.ltm_leaf.summary)) nm.ltm_leaf = im.ltm_leaf
    if (im.ltm_merge && str(im.ltm_merge.summary) && Number(im.ltm_merge.depth) > 0) nm.ltm_merge = im.ltm_merge
    // 兼容旧格式 ltm 数组
    if (Array.isArray(im.ltm)) {
      const prevLtm = Array.isArray(pm.ltm) ? pm.ltm : []
      const bySubject = new Map(prevLtm.map((e) => [e && e.subject, e]))
      for (const e of im.ltm) if (e && e.subject) bySubject.set(e.subject, e)
      nm.ltm = [...bySubject.values()]
    }
    if (Array.isArray(im.known_facts)) {
      const prevKf = Array.isArray(pm.known_facts) ? pm.known_facts : []
      const byEntry = new Map(prevKf.map((f) => [f && f.entry, f]))
      // 已存在的 entry 被更新时，先删除再追加到末尾——保证数组末尾 = 最近编辑的条目
      // 这样 slice(-10) 才能正确取到"最近编辑的10条"
      // v0.9.35：keywords 并集合并（summary 仍按最新值覆盖）
      for (const f of im.known_facts) {
        if (f && f.entry) {
          const prev = byEntry.get(f.entry)
          if (prev && Array.isArray(f.keywords) && f.keywords.length > 0) {
            f.keywords = [...new Set([...(Array.isArray(prev.keywords) ? prev.keywords : []), ...f.keywords.filter(Boolean)])]
          }
          byEntry.delete(f.entry)
          byEntry.set(f.entry, f)
        }
      }
      nm.known_facts = [...byEntry.values()]
    }
    // [2026-09-29 暂停] foreshadow_library 伏笔库暂时不单独维护
    // if (Array.isArray(im.foreshadow_library)) nm.foreshadow_library = im.foreshadow_library
    out.memory = nm
  }
  return out
}
