/**
 * 叙事锚定独立结算路线 —— 锚点存储（v0.8.0）
 *
 * v0.8.0 重大变更：
 *  - STM：永远累积不清空，每轮1条，增加 merged_into 标记
 *  - LTM：改为树形结构（每7条STM→depth1节点，每5个同深度节点→更高层节点）
 *  - LTM 快照：类似世界书快照机制，跟踪插入状态
 *  - 向后兼容：旧扁平 ltm 数组自动迁移为树形 depth=1 节点
 *
 * 数据结构：
 *   memory.stm[]        — 短期记忆（永远累积）
 *   memory.ltm_tree     — LTM 树形结构 { nodes, roots, next_id }
 *   memory.ltm_snapshot — LTM 快照跟踪 { content, turn }
 *   memory.known_facts[]
 *   memory.foreshadow_library[]
 */

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

/** 标题规整：去空白并截断到 12 字（LLM 提交超长时程序兜底截断） */
function title12(value) {
  return str(value).replace(/\s+/g, ' ').trim().slice(0, 12)
}

/** 数组字段归一化：LLM 可能提交字符串/对象/数组，统一为字符串数组
 *  字符串按 、，,；; 换行 切分；对象取值拼接后同样切分 */
function arrField(value) {
  if (value == null) return []
  let s = value
  if (typeof s === 'object') s = Object.values(s).map(x => (x != null && typeof x === 'object') ? '' : str(x)).filter(Boolean).join('，')
  if (!Array.isArray(s)) s = str(s).split(/[、，,;；\n]+/)
  return s.map(x => str(x).trim()).filter(Boolean)
}

/** 字段文本化：LLM 可能提交嵌套对象（如 environment = {环境: …}），统一转可读文本 */
function text(value) {
  if (value !== null && typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return str(value)
}

function object(value) {
  if (value === null || value === undefined) return {}
  return typeof value === 'object' ? value : {}
}

/* ── v0.9.34：已知情报追加上限与自动分卷（原标题·其二/其三…）────────────
 * 条目 summary 以 --<hex>-- 段分隔追加；appends 计数段数（旧数据回退为按分隔符统计）。
 * 达到 KF_APPEND_LIMIT 次后，新提交不再拼接，而是生成新条目「基标题·序数」，
 * 序数在全部同基标题条目中取最大值 +1（其二 → 其三 → …，保证连续不重号）。 */
const KF_APPEND_LIMIT = 5
const KF_ORDINALS = ['二', '三', '四', '五', '六', '七', '八', '九', '十']
function kfSegmentCount(summary) {
  return (String(summary || '').match(/\n--[0-9a-f]+--\n/g) || []).length
}
// 去掉尾部一个「·其X」/「·X」序数后缀得到基标题（无后缀原样返回）
function kfBaseTitle(entry) {
  return String(entry || '').replace(/·(?:其)?(?:[二三四五六七八九十]|\d+)$/, '')
}
function kfOrdinalValue(suffix) {
  if (suffix === '十') return 10
  if (/^[二三四五六七八九]$/.test(suffix)) return '二三四五六七八九'.indexOf(suffix) + 2
  const n = Number(suffix)
  return Number.isSafeInteger(n) && n > 0 ? n : 1
}
// n 从 2 起（2 → 其二）；超出表（>10）回退为「其 + 数字」
function kfOrdinalName(n) {
  return '其' + (KF_ORDINALS[n - 2] || String(n))
}
// v0.9.35：keywords 并集合并（去空白、去重，保序：旧词在前、新词在后）
function kfMergeKeywords(prev, incoming) {
  const out = []
  for (const k of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const t = String(k ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/**
 * v0.9.24 focus 字段计量（v0.9.24b 修订）：CJK 字符（中日韩）各计 1，
 * 英文/数字连续串（单词）计 1；数字/日期等含义明确的结构（22.1、2026-10-03、12:30）
 * 连同内部分隔符整体计 1；标点、符号、空白不计量。名义上限 100 字，
 * 程序截断点在 120–150 间随机；截断细节不暴露给模型。
 */
const FOCUS_TOKEN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9]+(?:[.\-/:][A-Za-z0-9]+)*/gu
export function focusUnitCount(value) {
  const s = text(value)
  const m = s.match(FOCUS_TOKEN_RE)
  return m ? m.length : 0
}

/**
 * 截断 focus 文本：返回 { value, full, truncated }。
 * value=截断版（注入用）；full=未截断原文（页面展示用）；truncated=是否发生截断。
 * 未超随机上限时 value===full 原样保留。
 */
export function truncateFocusDetail(value) {
  const s = text(value).trim()
  if (!s) return { value: '', full: '', truncated: false }
  const limit = 120 + Math.floor(Math.random() * 31) // 120–150
  const ends = []
  for (const m of s.matchAll(FOCUS_TOKEN_RE)) ends.push(m.index + m[0].length)
  if (ends.length <= limit) return { value: s, full: s, truncated: false }
  // 截到第 limit 个计量单位边界
  return { value: s.slice(0, ends[limit - 1]).trim(), full: s, truncated: true }
}
/** 兼容旧签名：仅返回截断后文本 */
export function truncateFocus(value) {
  return truncateFocusDetail(value).value
}

/* ─────────────────────────── 数据初始化与迁移 ─────────────────────────── */

/** 读取（必要时初始化）chat.narrativeAnchor，包含旧格式迁移。 */
export function loadAnchor(chat) {
  if (!chat.narrativeAnchor || typeof chat.narrativeAnchor !== 'object') {
    chat.narrativeAnchor = createEmptyAnchor()
    return chat.narrativeAnchor
  }
  const a = chat.narrativeAnchor
  // 确保 memory 存在
  if (!a.memory || typeof a.memory !== 'object') a.memory = {}
  if (!Array.isArray(a.memory.stm)) a.memory.stm = []
  if (!Array.isArray(a.memory.known_facts)) a.memory.known_facts = []
  if (!Array.isArray(a.memory.foreshadow_library)) a.memory.foreshadow_library = []

  // 确保 ltm_tree 存在
  if (!a.memory.ltm_tree || typeof a.memory.ltm_tree !== 'object') {
    a.memory.ltm_tree = { nodes: {}, roots: [], next_id: 1 }
  }
  if (!a.memory.ltm_snapshot || typeof a.memory.ltm_snapshot !== 'object') {
    a.memory.ltm_snapshot = { content: '', turn: 0 }
  }
  // 确保 meta 存在
  if (!a.meta || typeof a.meta !== 'object') a.meta = { turn_count: 0, created_at: Date.now() }
  if (!a.meta.settings || typeof a.meta.settings !== 'object') a.meta.settings = {}
  // 确保 plot_route / current_state 存在
  if (!a.plot_route || typeof a.plot_route !== 'object') {
    a.plot_route = { current_node: '', recap: '', next_scene: '', foreshadowing: [] }
  }
  if (!a.current_state || typeof a.current_state !== 'object') {
    a.current_state = { time: '', world: '', location: '', characters: [], environment: [], items: [], focus: '', focus_full: '' }
  }
  return a
}

function createEmptyAnchor() {
  return {
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
  }
}

/* ─────────────────────────── LTM 树操作 ─────────────────────────── */

/** 获取未合并的 STM 数量（merged_into 为 null 的条目）。 */
export function getUnmergedStmCount(anchor) {
  const stm = anchor.memory?.stm || []
  return stm.filter((e) => e.merged_into == null).length
}

/** 获取指定深度的根节点数量。 */
function getDepthRootCount(tree, depth) {
  return tree.roots.filter((id) => tree.nodes[id]?.depth === depth).length
}

/**
 * 检查是否需要 LLM 生成 LTM。
 * 返回 { needLeafLtm, needMergeDepth, mergeDepth }
 *  - needLeafLtm: 未合并 STM >= 7，需要生成 depth=1 节点
 *  - needMergeDepth: 某深度根节点 >= 5，需要合并为更高层
 */
export function checkLtmNeeds(anchor) {
  const tree = anchor.memory?.ltm_tree
  if (!tree) return { needLeafLtm: false, needMergeDepth: 0, forceLeafLtm: false, forceMergeDepth: 0, rootCount: 0, needRootMerge: false }
  const unmerged = getUnmergedStmCount(anchor)
  // 提示阈值：STM 7 条 / 同深度 5 个节点
  const needLeafLtm = unmerged >= 7
  // 强制阈值：提示阈值 × 1.5（STM 11 条 / 同深度 8 个节点）
  const forceLeafLtm = unmerged >= 11
  // 根节点总数
  const rootCount = tree.roots?.length || 0
  // 根节点提示阈值：10 个时提醒 LLM 主动合并（程序兜底阈值为 15 = 10 × 1.5）
  const needRootMerge = rootCount >= 10
  // O(n) 一次遍历 roots，按 depth 分组计数
  const depthCount = {}
  for (const id of tree.roots) {
    const d = tree.nodes[id]?.depth || 0
    if (d >= 1) depthCount[d] = (depthCount[d] || 0) + 1
  }
  // 提示阈值：从 depth=1 开始找第一个 >=5 的
  let needMergeDepth = 0
  for (let d = 1; d <= 10; d++) {
    if ((depthCount[d] || 0) >= 5) {
      needMergeDepth = d
      break
    }
  }
  // 强制阈值：从 depth=1 开始找第一个 >=8 的（5 × 1.5 = 7.5，向上取整 8）
  let forceMergeDepth = 0
  for (let d = 1; d <= 10; d++) {
    if ((depthCount[d] || 0) >= 8) {
      forceMergeDepth = d
      break
    }
  }
  return { needLeafLtm, needMergeDepth, forceLeafLtm, forceMergeDepth, rootCount, needRootMerge, unmergedStm: unmerged }
}

/**
 * 创建一个 LTM 叶节点（depth=1，由 STM 合并生成）。
 * @param {object} anchor
 * @param {string} summary - LLM 生成的摘要
 * @param {number} stmCount - 合并的 STM 数量（默认7）
 * @returns {object} 新节点
 */
export function createLeafLtm(anchor, summary, stmCount = 7, keywords = [], title = '') {
  const tree = anchor.memory.ltm_tree
  const stm = anchor.memory.stm
  // 找到最旧的未合并 STM
  const unmergedIndices = []
  for (let i = 0; i < stm.length && unmergedIndices.length < stmCount; i++) {
    if (stm[i].merged_into == null) unmergedIndices.push(i)
  }
  if (unmergedIndices.length === 0) return null

  const id = tree.next_id++
  const node = {
    id,
    depth: 1,
    title: title12(title) || title12(summary),
    summary: str(summary),
    keywords: Array.isArray(keywords) ? keywords.filter(Boolean).map(str) : [],
    children: [],
    stm_range: [unmergedIndices[0], unmergedIndices[unmergedIndices.length - 1]],
    created_at: Date.now(),
    turn: anchor.meta.turn_count || 0
  }
  tree.nodes[id] = node
  tree.roots.push(id)
  // 标记 STM 已合并
  for (const idx of unmergedIndices) {
    stm[idx].merged_into = id
  }
  // 检查根节点数量限制
  enforceRootLimit(tree)
  // 按历史时序排序 roots（保证数据结构本身就是时序有序的）
  sortRootsInPlace(tree)
  // 更新快照
  updateLtmSnapshot(anchor)
  return node
}

/**
 * 合并指定深度的根节点为更高层节点。
 * @param {object} anchor
 * @param {number} depth - 要合并的深度
 * @param {string} summary - LLM 生成的摘要
 * @param {number} count - 合并的节点数量（默认5）
 * @returns {object} 新节点
 */
export function mergeLtmNodes(anchor, depth, summary, count = 5, keywords = [], title = '') {
  const tree = anchor.memory.ltm_tree
  // 找到该深度最旧的根节点
  const depthRoots = tree.roots
    .filter((id) => tree.nodes[id]?.depth === depth)
    .sort((a, b) => (tree.nodes[a].created_at || 0) - (tree.nodes[b].created_at || 0))
    .slice(0, count)
  if (depthRoots.length === 0) return null

  const id = tree.next_id++
  const node = {
    id,
    depth: depth + 1,
    title: title12(title) || title12(summary),
    summary: str(summary),
    keywords: Array.isArray(keywords) ? keywords.filter(Boolean).map(str) : [],
    children: depthRoots,
    stm_range: null,
    created_at: Date.now(),
    turn: anchor.meta.turn_count || 0
  }
  tree.nodes[id] = node
  // 从 roots 中移除被合并的节点，添加新节点
  tree.roots = tree.roots.filter((rid) => !depthRoots.includes(rid))
  tree.roots.push(id)
  // 检查根节点数量限制
  enforceRootLimit(tree)
  // 按历史时序排序 roots（保证数据结构本身就是时序有序的）
  sortRootsInPlace(tree)
  // 更新快照
  updateLtmSnapshot(anchor)
  return node
}

/**
 * 把 roots 数组按历史发生顺序原地排序（越早的排越前面）。
 * 在 createLeafLtm / mergeLtmNodes / enforceRootLimit 末尾调用，保证数据结构本身就是时序有序的。
 */
function sortRootsInPlace(tree) {
  tree.roots = sortRootsChronologically(tree)
}

/**
 * 强制执行根节点数量限制（最多15个 = 提示阈值10 × 1.5）。
 * 超过时，合并所有深度 > 2 的根节点为一个节点（程序化摘要）。
 * 根节点达到10个时由上下文提示 LLM 主动合并，达到15个时程序兜底。
 */
function enforceRootLimit(tree) {
  const MAX_ROOTS = 15
  if (tree.roots.length <= MAX_ROOTS) return
  // 找到深度 > 2 的根节点
  const deepRoots = tree.roots.filter((id) => tree.nodes[id]?.depth > 2)
  if (deepRoots.length < 2) return // 无法合并
  const id = tree.next_id++
  const summaries = deepRoots.map((rid) => tree.nodes[rid].summary).filter(Boolean)
  const node = {
    id,
    depth: Math.max(...deepRoots.map((rid) => tree.nodes[rid].depth)) + 1,
    title: '兜底合并',
    summary: '【程序合并·根节点超限兜底】' + summaries.join('；'),
    children: deepRoots,
    stm_range: null,
    created_at: Date.now(),
    turn: 0,
    auto_merged: true
  }
  tree.nodes[id] = node
  tree.roots = tree.roots.filter((rid) => !deepRoots.includes(rid))
  tree.roots.push(id)
  sortRootsInPlace(tree)
}

/**
 * 节点覆盖的历史起点（STM 数组下标，越小越早）。
 * 叶子：stm_range[0]；合并节点：递归取各子节点的最小值。
 * 兜底返回 Infinity（无 stm_range 且无子节点的 legacy 节点），排序时沉底。
 */
function nodeHistoryStart(tree, id, memo = new Map()) {
  const node = tree.nodes[id]
  if (!node) return Infinity
  if (memo.has(id)) return memo.get(id)
  let start = Infinity
  // 仅当 stm_range 是有效数组且有有限数值时才使用（合并节点 stm_range=null，需递归子节点）
  if (Array.isArray(node.stm_range)) {
    const range0 = Number(node.stm_range[0])
    if (Number.isFinite(range0)) start = range0
  }
  if (start === Infinity) {
    for (const cid of node.children || []) {
      const s = nodeHistoryStart(tree, cid, memo)
      if (s < start) start = s
    }
  }
  memo.set(id, start)
  return start
}

/** 根节点按历史发生顺序排序（depth 只作显示标记，不参与排序）。 */
function sortRootsChronologically(tree) {
  return [...tree.roots].sort((a, b) => {
    const ha = nodeHistoryStart(tree, a)
    const hb = nodeHistoryStart(tree, b)
    if (ha !== hb) return ha - hb
    // 无历史位置的节点（legacy）按创建时间沉底，保持稳定
    return (tree.nodes[a]?.created_at || 0) - (tree.nodes[b]?.created_at || 0)
  })
}

/** 更新 LTM 快照内容（所有根节点摘要，含深度）。 */
export function updateLtmSnapshot(anchor) {
  const tree = anchor.memory.ltm_tree
  if (!tree || tree.roots.length === 0) {
    anchor.memory.ltm_snapshot = { content: '', turn: anchor.meta.turn_count || 0 }
    return
  }
  const lines = []
  // 按历史发生顺序排序根节点（合并后新节点覆盖的是最旧历史，不得按插入序/深度排）
  for (const rid of sortRootsChronologically(tree)) {
    const node = tree.nodes[rid]
    if (!node) continue
    const depthMark = node.depth > 1 ? `[L${node.depth}]` : '[L1]'
    lines.push(`${depthMark} ${node.summary}`)
  }
  const content = '【LTM 长期记忆快照】\n' + lines.join('\n')
  anchor.memory.ltm_snapshot = { content, turn: anchor.meta.turn_count || 0 }
}

/** 格式化 LTM 树为可读文本（用于前台注入）。 */
export function formatLtmTree(anchor) {
  const tree = anchor.memory?.ltm_tree
  if (!tree || tree.roots.length === 0) return ''
  const lines = []
  for (const rid of sortRootsChronologically(tree)) {
    const node = tree.nodes[rid]
    if (!node) continue
    const depthMark = node.depth > 1 ? `[L${node.depth}]` : '[L1]'
    lines.push(`${depthMark} ${node.summary}`)
  }
  return lines.join('\n')
}

/* ─────────────────────────── 提交合并 ─────────────────────────── */

/**
 * 把一次增量锚点提交合并到 chat.narrativeAnchor。
 * v0.8.0：STM 永远累积，LTM 走树形结构。
 *
 * submission.memory 支持：
 *  - stm: [{ title, summary }]  每轮1条（time/location/turn/message_id 由系统自动填充）
 *  - ltm_leaf: { summary }                             生成 depth=1 节点（STM达7时）
 *  - ltm_merge: { depth, summary }                    合并指定深度节点
 *  - known_facts: []
 *  - foreshadow_library: []
 */
export function applyAnchorSubmission(chat, submission, maxSTMLength = 7) {
  const anchor = loadAnchor(chat)
  const data = object(submission)

  // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
  // // plot_route 增量合并
  // if (object(data.plot_route) && Object.keys(object(data.plot_route)).length > 0) {
  //   Object.assign(anchor.plot_route, object(data.plot_route))
  // }

  // current_state 按字段增量合并（v0.9.x：每个字段可单独提交，未提交字段保留上一轮）
  if (object(data.current_state) && Object.keys(object(data.current_state)).length > 0) {
    const cs = object(data.current_state)
    const prev = anchor.current_state || {}
    // 字段级：仅显式提交（!== undefined，含空串/空数组，用于主动清空）才覆盖
    const field = (v, fallback) => (v === undefined ? fallback : v)
    const textField = (v, fallback) => (v === undefined ? fallback : text(v))
    const arrTextField = (v, fallback) => (v === undefined ? fallback : arrField(v))
    anchor.current_state = {
      time: textField(cs.time, str(prev.time)),
      world: textField(cs.world, str(prev.world)),
      location: textField(cs.location, str(prev.location)),
      characters: arrTextField(cs.characters, Array.isArray(prev.characters) ? prev.characters : []),
      environment: arrTextField(cs.environment, Array.isArray(prev.environment) ? prev.environment : []),
      items: arrTextField(cs.items, Array.isArray(prev.items) ? prev.items : []),
      // v0.9.24：叙事备忘（AI 自由使用，追踪正文之外的关键信息）。
      // 未提交时保留上一轮；提交时程序截断（120-150 计量单位随机），截断版入库 focus
      // （前后台注入用），原文存 focus_full（页面展示用，标明截断位置）。
      ...(cs.focus === undefined
        ? { focus: prev.focus || '', focus_full: prev.focus_full || '' }
        : (() => {
            const det = truncateFocusDetail(cs.focus)
            return det.truncated
              ? { focus: det.value, focus_full: det.full }
              : { focus: det.value, focus_full: '' }
          })())
    }
  }

  // 自由栏位（v0.10.2）：与 current_state/memory 同级的顶层字段，后台结算提交时写入。
  // v0.10.4：自由栏位仅保留 list（按下标写入）——提交元素覆盖对应下标，未提交下标保留现状；
  // 元素 { display, injectForeground, injectInput, injectBack }；display 提交空串=清空该栏位内容；
  // 三个注入开关是 UI 维护字段，模型提交不覆盖（保留现值）
  if (object(data.free_slots)) {
    const fs = object(data.free_slots)
    const prevFs = anchor.free_slots && typeof anchor.free_slots === 'object' ? anchor.free_slots : {}
    anchor.free_slots = { ...prevFs }
    if (Array.isArray(fs.list) && fs.list.length > 0) {
      const prevList = Array.isArray(prevFs.list) ? prevFs.list.map(x => x && typeof x === 'object' ? { ...x } : { display: '' }) : []
      for (const item of fs.list) {
        if (!item || typeof item !== 'object') continue
        const idx = Number.isFinite(Number(item.index)) ? Math.max(0, Math.floor(Number(item.index))) : 0
        while (prevList.length <= idx) prevList.push({ display: '', injectForeground: false, injectInput: false, injectBack: false })
        const old = prevList[idx] || {}
        prevList[idx] = {
          display: item.display !== undefined ? str(item.display) : str(old.display || ''),
          injectForeground: old.injectForeground === true,
          injectInput: old.injectInput === true,
          injectBack: old.injectBack === true
        }
      }
      anchor.free_slots.list = prevList
    } else if (Array.isArray(prevFs.list)) {
      anchor.free_slots.list = prevFs.list
    } else {
      anchor.free_slots.list = []
    }
  }

  if (object(data.memory) && Object.keys(object(data.memory)).length > 0) {
    const mem = object(data.memory)

    // STM：永远追加，不清空；time/location 自动从 current_state 填充（LLM 无需提交）
    if (Array.isArray(mem.stm) && mem.stm.length > 0) {
      const cs = anchor.current_state || {}
      // 轮号统一为 DSHT 的 chat 轮号（取最新 assistant 消息的 turn），不再用锚点自维护的 turn_count
      const chatMessages = Array.isArray(chat?.messages) ? chat.messages : []
      const lastAssistant = [...chatMessages].reverse().find(m => m && m.role === 'assistant')
      const chatTurn = lastAssistant && Number.isFinite(Number(lastAssistant.turn)) ? Number(lastAssistant.turn) : anchor.meta.turn_count
      const messageId = lastAssistant && lastAssistant.id ? String(lastAssistant.id) : ''
      for (const entry of mem.stm) {
        anchor.memory.stm.push({
          id: Date.now() + Math.random(),
          turn: chatTurn,
          message_id: messageId,
          time: str(cs.time),
          location: str(cs.location),
          title: title12(entry.title),
          summary: str(entry.summary),
          merged_into: null
        })
      }
    }

    // LTM 叶节点生成（STM 达 7 时 LLM 提交标题 + 摘要 + 关键词）
    if (mem.ltm_leaf && str(mem.ltm_leaf.summary)) {
      createLeafLtm(anchor, mem.ltm_leaf.summary, Number(mem.ltm_leaf.stm_count) || 7, mem.ltm_leaf.keywords || [], str(mem.ltm_leaf.title))
    }

    // LTM 中间节点合并
    if (mem.ltm_merge && str(mem.ltm_merge.summary) && Number(mem.ltm_merge.depth) > 0) {
      mergeLtmNodes(anchor, Number(mem.ltm_merge.depth), mem.ltm_merge.summary, Number(mem.ltm_merge.count) || 5, mem.ltm_merge.keywords || [], str(mem.ltm_merge.title))
    }

    // known_facts 增量合并（含 keywords + id）
    if (Array.isArray(mem.known_facts)) {
      for (const fact of mem.known_facts) {
        // 优先按 id 匹配（LLM 提交带 id 时），回退到 entry 匹配
        const existing = (fact.id
          ? anchor.memory.known_facts.findIndex((f) => f.id === fact.id)
          : -1) >= 0
          ? anchor.memory.known_facts.findIndex((f) => f.id === fact.id)
          : anchor.memory.known_facts.findIndex((f) => f.entry === fact.entry)
        const kw = Array.isArray(fact.keywords) ? fact.keywords.filter(Boolean).map(str) : []
        if (existing >= 0) {
          // 已存在的条目：先从原位置移除，再追加到末尾——保证数组末尾 = 最近编辑的条目
          // 这样 slice(-10) 才能正确取到"最近编辑的10条"
          const old = anchor.memory.known_facts[existing]
          anchor.memory.known_facts.splice(existing, 1)
          // 同名情报：新 summary 追加到旧 summary 后面，用 --时间戳-- 分隔（去重）；
          // v0.9.34：追加最多 5 次，超出时程序自动生成新条目「原标题·其二/其三/…」
          const newSummary = str(fact.summary)
          const oldSummary = String(old.summary || '')
          const segs = old.appends != null ? Number(old.appends) : kfSegmentCount(oldSummary)
          if (newSummary && !oldSummary.includes(newSummary) && segs < KF_APPEND_LIMIT) {
            const ts = Math.floor(Date.now() / 1000).toString(16)
            old.summary = oldSummary + '\n--' + ts + '--\n' + newSummary
            old.appends = segs + 1
          } else if (newSummary && !oldSummary.includes(newSummary)) {
            // v0.9.34：原条目已满 → 路由到同基标题的最新分卷；最新分卷也满才开新卷
            // v0.9.35：keywords 并集合并——历次提交的关键词在各分卷逐级累积
            const base = kfBaseTitle(old.entry)
            old.appends = segs
            let latest = null
            let maxOrd = 1
            for (const sib of anchor.memory.known_facts) {
              if (!sib || kfBaseTitle(sib.entry) !== base) continue
              const m = /·(?:其)?([二三四五六七八九]|\d+|十)$/.exec(String(sib.entry || ''))
              const ord = m ? kfOrdinalValue(m[1]) : 1
              if (ord >= maxOrd) { maxOrd = ord; latest = sib }
            }
            const latestSegs = latest
              ? (latest.appends != null ? Number(latest.appends) : kfSegmentCount(latest.summary))
              : -1 // 无分卷 → 直接开其二
            const ts = Math.floor(Date.now() / 1000).toString(16)
            const latestSummary = latest ? String(latest.summary || '') : ''
            const dupInLatest = latestSummary.includes(newSummary)
            if (latest && latest !== old && latestSegs < KF_APPEND_LIMIT && !dupInLatest) {
              latest.summary = String(latest.summary || '') + '\n--' + ts + '--\n' + newSummary
              latest.appends = latestSegs + 1
              if (kw.length > 0) latest.keywords = kfMergeKeywords(latest.keywords, kw)
            } else if (!dupInLatest) {
              anchor.memory.known_facts.push({
                id: 'kf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
                entry: base + '·' + kfOrdinalName(maxOrd + 1),
                summary: newSummary,
                // v0.9.35：新卷只携带本次提交的 keywords，各自任期累积（分别流向），不整体继承原条目
                keywords: kw,
                appends: 0
              })
            }
          }
          if (kw.length > 0) old.keywords = kfMergeKeywords(old.keywords, kw)
          anchor.memory.known_facts.push(old)
        } else {
          // 新条目生成唯一 id（kf-<timestamp>-<random>）
          const kfId = fact.id || ('kf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6))
          anchor.memory.known_facts.push({ id: kfId, entry: str(fact.entry), summary: str(fact.summary), keywords: kw })
        }
      }
    }

    // [2026-09-29 暂停] foreshadow_library 伏笔库暂时不单独维护，伏笔信息自然流入STM
    // 保留数据结构不删除，已有数据仍在文件中，但不再处理提交
    // if (Array.isArray(mem.foreshadow_library)) {
    //   anchor.memory.foreshadow_library = mem.foreshadow_library.map((f) => ({
    //     id: str(f.id), description: str(f.description), status: str(f.status) || 'active'
    //   }))
    // }
  }

  anchor.meta.turn_count++
  anchor.meta.updated_at = Date.now()
  return anchor
}

/* ─────────────────────────── 统计 ─────────────────────────── */

/** 获取锚点统计信息。 */
export function getAnchorStats(anchor) {
  const stm = anchor.memory?.stm || []
  const tree = anchor.memory?.ltm_tree
  const rootCount = tree?.roots?.length || 0
  const totalNodes = tree ? Object.keys(tree.nodes).length : 0
  const unmergedStm = stm.filter((e) => e.merged_into == null).length
  return {
    stm_count: stm.length,
    stm_unmerged: unmergedStm,
    ltm_root_count: rootCount,
    ltm_total_nodes: totalNodes,
    known_facts_count: anchor.memory?.known_facts?.length || 0,
    foreshadow_count: anchor.memory?.foreshadow_library?.length || 0,
    turn_count: anchor.meta?.turn_count || 0
  }
}
