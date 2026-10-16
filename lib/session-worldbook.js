/**
 * 会话临时世界书（v0.7 · 人工世界书管理系统）
 *
 * 数据模型：每个前台会话绑定一份"会话临时世界书"，持久化到
 *   <插件目录>/data/session-worldbooks/<sessionId>.json
 *
 * 三大能力：
 *   1. 人工条目管理：随时新增/编辑/删除/启用条目（title/keys/content）
 *   2. DSHT 原生自动加载：enabled 条目经官方 plugin-api v2 tavern.worldbookEntries
 *      进世界书条目池（v3.0 起，替代旧 tavernExtensionPoints merger），
 *      参与官方召回（关键词激活/常驻/冷却/后台结算/候选）——与普通世界书条目同机制
 *   3. 锚点自动流入：结算后按开关把锚点数据（当前状态/已知情报/LTM/大纲）
 *      转成条目写入临时世界书，供自动加载或人工确认
 *
 * 人工选择注入：selection 记录"注入下一次回复"的条目 id 列表，
 * 前台 foreground section 在正文组装时把它们作为动态世界书快照的一部分注入。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { listGlobalAutoBind } from './worldbook-combos.js'
import { resolveFamilyId, familyMembers, parentChain, currentDataRoot, sessionAlive, memberLabelOf } from './family.js'
import { readAnchor, writeAnchor } from './data-store.js'
import { join } from 'node:path'
import { resolveTavernDataRoot, pluginDataDir } from './paths.js'

const booksDir = join(pluginDataDir(), 'session-worldbooks')

function ensureDir() {
  try { mkdirSync(booksDir, { recursive: true }) } catch { /* 忽略 */ }
}

function fileFor(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w-]/g, '_')
  return join(booksDir, safe + '.json')
}

function emptyBook(sessionId) {
  return {
    sessionId: String(sessionId || ''),
    name: '会话临时世界书',
    enabled: true,
    autoFromAnchor: true,
    anchorAuto: { currentState: false, knownFacts: true, ltm: false, plotRoute: false, maxEnabled: 200 },
    selection: [],
    // v0.7.18：会话级世界书绑定（参考 DSHT 角色卡多世界书绑定）：
    // 元素 { kind: 'embedded', cardPath } 或 { kind: 'standalone', path }
    boundBooks: [],
    // v0.9.15：主动解除的全局自动绑定（本会话不再跟随全局清单），元素同 boundBooks 结构
    unboundGlobals: [],
    entries: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/** 读取会话临时世界书；无文件返回 null。 */
export function readSessionWorldbook(sessionId) {
  try {
    const file = fileFor(sessionId)
    if (!existsSync(file)) return null
    const book = JSON.parse(readFileSync(file, 'utf-8'))
    if (!book || typeof book !== 'object') return null
    if (!Array.isArray(book.boundBooks)) book.boundBooks = []
    if (!Array.isArray(book.unboundGlobals)) book.unboundGlobals = []
    // 清理已废弃字段：maxEntries（旧的"删最旧条目"上限）被 maxEnabled（只停用不删除）取代
    if (book.anchorAuto && typeof book.anchorAuto === 'object') delete book.anchorAuto.maxEntries
    return book
  } catch {
    return null
  }
}

/** 读取或初始化会话临时世界书（惰性创建默认对象，不落盘）。
 *  v0.9.16 支线系统：族成员首次物化时从父级链拷贝会话绑定（boundBooks + unboundGlobals，
 *  一次性写入；临时条目不继承——新文件 entries 为空）。 */
export function loadSessionWorldbook(sessionId) {
  const existing = readSessionWorldbook(sessionId)
  if (existing) return existing
  const inherited = inheritedBinding(sessionId)
  if (inherited) {
    const book = emptyBook(sessionId)
    book.boundBooks = inherited.boundBooks
    book.unboundGlobals = inherited.unboundGlobals
    writeSessionWorldbook(book)
    return book
  }
  return emptyBook(sessionId)
}

/** 沿 forkedFrom 父链找最近一个有世界书文件的祖先，返回其 { boundBooks, unboundGlobals }；无族/无文件返回 null。 */
export function inheritedBinding(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid || !resolveFamilyId(sid)) return null
  for (const parent of parentChain(sid)) {
    const pb = readSessionWorldbook(parent)
    if (pb) return { boundBooks: Array.isArray(pb.boundBooks) ? pb.boundBooks : [], unboundGlobals: Array.isArray(pb.unboundGlobals) ? pb.unboundGlobals : [] }
  }
  return null
}

/** 写入会话临时世界书（完整替换）。 */
export function writeSessionWorldbook(book) {
  try {
    ensureDir()
    if (!book.sessionId) return false
    book.updatedAt = Date.now()
    writeFileSync(fileFor(book.sessionId), JSON.stringify(book, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 列出所有已有临时世界书的会话 id。 */
export function listSessionWorldbooks() {
  try {
    ensureDir()
    return readdirSync(booksDir)
      .filter(name => name.endsWith('.json'))
      .map(name => name.replace(/\.json$/, ''))
  } catch {
    return []
  }
}

/* ───────────── 锚点自动流入 ───────────── */

function anchorEntryId(source, title) {
  const seed = String(source) + ':' + String(title)
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return 'anchor-' + (hash >>> 0).toString(36)
}

/**
 * 从文本中提取关键词（简单版：按标点分割，取长度 2-12 的片段）。
 * 用于 LTM 节点 summary 的关键词提取，子节点递归继承父节点关键词。
 */
function extractKeywords(text, max = 6) {
  if (!text) return []
  const segments = String(text)
    .split(/[，。！？、；：""''（）【】《》\n\r\t,.!?;:'"()\[\]{}<>\/\\]/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
    // 长片段截取前 8 字作为关键词（保证有语义且不会过长）
    .map(s => s.length > 8 ? s.slice(0, 8) : s)
  return [...new Set(segments)].slice(0, max)
}

/**
 * 按开关把锚点数据转为条目（增量：同 source+title 已存在则更新 content）。
 * 返回新增/更新的条目 id 列表。
 */
export function autoImportFromAnchor(sessionId, anchor, force = false) {
  if (!anchor || typeof anchor !== 'object') return []
  const book = loadSessionWorldbook(sessionId)
  if (!book.enabled || (!book.autoFromAnchor && !force)) return []
  const cfg = book.anchorAuto || {}
  const produced = []

  function upsert(source, title, keys, content, extra = {}) {
    const id = anchorEntryId(source, title)
    // titleLine 是临时参数（仅用于第一行标题写入），不持久化到 entry；
    // anchorReenable 是临时参数（锚点重新触发时恢复启用），不持久化
    const titleLine = extra.titleLine
    const anchorReenable = extra.anchorReenable === true
    const { titleLine: _ignored, anchorReenable: _ignored2, ...entryExtra } = extra
    // 优先用 anchorRef 匹配（稳定标识，不受 title 变化影响）；匹配不到回退到 id（hash）匹配
    const ref = entryExtra.anchorRef
    let existing = null
    if (ref && typeof ref === 'object') {
      existing = book.entries.find(e => e.anchorRef && e.anchorRef.kind === ref.kind &&
        (ref.kind === 'ltm_node' ? e.anchorRef.nodeId === ref.nodeId : e.anchorRef.id === ref.id))
    }
    if (!existing) existing = book.entries.find(e => e.id === id)
    if (existing) {
      // 已存在条目：保留第一行标题不动（仅创建时写入），直接覆盖后续内容
      // known_facts.summary 已在 store.js 中处理时间戳追加，此处直接同步完整内容
      const lines = String(existing.content || '').split('\n')
      const firstLine = lines[0] || ''
      existing.content = firstLine + '\n' + String(content || '')
      // keys 去重追加：合并旧 keys 和新 keys，保留全部不重复
      const oldKeys = Array.isArray(existing.keys) ? existing.keys : []
      const newKeys = Array.isArray(keys) ? keys : []
      // 已知情报条目：别名标记实时计算——先剔除旧标记再并入新 keys，改名后标记随之更新
      const cleanedOld = ref?.kind === 'known_fact'
        ? oldKeys.filter(k => !/^【<--.*-->】$/.test(String(k)))
        : oldKeys
      existing.keys = [...new Set([...cleanedOld, ...newKeys])]
      existing.title = title
      existing.updatedAt = Date.now()
      // 锚点重新触发（内容再次变更）→ 恢复启用：上限管控自动停用的、用户人工停用的，
      // 一律重新启用，并移除 enabledTouched（条目回归锚点/上限管控；仅已知情报类传
      // 此标记，LTM 条目默认停用的设计不受影响）
      if (anchorReenable) { existing.enabled = true; delete existing.enabledTouched }
      if (ref) existing.anchorRef = ref
      Object.assign(existing, entryExtra)
      produced.push(existing.id)
      return
    }
    const now = Date.now()
    // 新条目默认 enabled 由调用方通过 extra 控制；LTM 条目传 { enabled: false }
    // 第一行固定为 titleLine（仅创建时写入），后续追加块不再编辑首行
    const initialContent = titleLine ? titleLine + '\n' + String(content || '') : String(content || '')
    const entry = {
      id,
      title,
      keys: Array.isArray(keys) ? keys : [],
      content: initialContent,
      enabled: true,
      constant: false,
      source,
      createdAt: now,
      updatedAt: now,
      ...entryExtra
    }
    book.entries.push(entry)
    produced.push(id)
  }

  // [2026-09-29 暂停] 当前状态已通过 foreground-frame 每轮强制注入上下文，世界书关键词召回反而可能重复或遗漏，不再流入
  // if (cfg.currentState !== false && anchor.current_state) {
  //   const cs = anchor.current_state
  //   const parts = []
  //   if (cs.time) parts.push('时间: ' + cs.time)
  //   if (cs.world) parts.push('世界: ' + cs.world)
  //   if (cs.location) parts.push('地点: ' + cs.location)
  //   if (Array.isArray(cs.characters) && cs.characters.length) parts.push('在场人物: ' + cs.characters.join(', '))
  //   if (cs.environment) parts.push('环境: ' + cs.environment)
  //   if (Array.isArray(cs.items) && cs.items.length) parts.push('物品: ' + cs.items.join(', '))
  //   if (parts.length) {
  //     const names = (Array.isArray(cs.characters) ? cs.characters : []).join(' ')
  //     const loc = String(cs.location || '')
  //     upsert('anchor', '当前状态', [loc, names].filter(Boolean).join(' ').split(/\s+/).filter(Boolean), parts.join('\n'))
  //   }
  // }

  // 已知情报 → 每条【设定·entry】（关键词优先用 LLM 提交的 keywords，回退到 entry）
  // v0.9.17：有来源（sourceSid）且非本会话的条目，keys 追加【<--来源别名-->】标记
  // （标记按当前别名实时计算，改名后下次生成即换新标记；旧标记在 upsert 中被剔除）
  if (cfg.knownFacts !== false && Array.isArray(anchor.memory?.known_facts)) {
    const activeKfIds = new Set()
    for (const fact of anchor.memory.known_facts) {
      if (!fact || !fact.entry || !fact.summary) continue
      const baseKeys = Array.isArray(fact.keywords) && fact.keywords.length > 0
        ? fact.keywords
        : [fact.entry]
      const fromLabel = fact.sourceSid && fact.sourceSid !== sessionId ? memberLabelOf(fact.sourceSid) : null
      const keys = fromLabel ? [...new Set([...baseKeys, `【<--${fromLabel}-->】`])] : baseKeys
      // anchorRef 用 fact.id（唯一 ID），避免 entry 名称冲突
      const refId = fact.id || ('kf-' + String(fact.entry).slice(0, 12))
      activeKfIds.add(refId)
      // 内容第一行为标题（entry 名）；追加块不带标题（titleLine 语义见 upsert）
      // anchorReenable：锚点重新触发该条目时恢复启用（覆盖上限停用与人工停用）
      upsert('anchor', '设定·' + fact.entry, keys, String(fact.summary), { anchorRef: { kind: 'known_fact', id: refId }, titleLine: String(fact.entry), anchorReenable: true })
    }
    // 孤儿退役：来源 known_facts 已删除（人工删除等）的 anchor 条目自动停用（不删除，
    // 用户可查历史/手动清理）。enabledTouched 条目跳过——用户人工启用的孤儿条目保留启用
    // （人工意志优先），人工停用的也不改；同 id 情报恢复时 anchorReenable 照常接管
    for (const e of book.entries) {
      if (e.source !== 'anchor' || !e.anchorRef || e.anchorRef.kind !== 'known_fact') continue
      if (e.enabledTouched) continue
      if (!activeKfIds.has(e.anchorRef.id) && e.enabled !== false) {
        e.enabled = false
        e.updatedAt = Date.now()
      }
    }
  }

  // 长期记忆 LTM → 每个节点一条【LTM·L{depth}·#节点ID】
  // 设计（参考世界书递归扫描级联 + Meta-Nav 索引规范）：
  //   - 每个节点关键词 = 优先用 LLM 提交的 node.keywords，回退到从 summary 自动提取
  //   - 父节点 content 末尾嵌入【子节点索引】：列出每个直接子节点的关键词 + 摘要前若干字
  //   - 递归扫描时：父节点被激活 → content 中包含子节点关键词 → 子节点被触发 → ...
  //   - 标题含节点 ID 保证稳定 ID（summary 变化不重置冷却）
  if (cfg.ltm !== false && anchor.memory?.ltm_tree?.nodes && Object.keys(anchor.memory.ltm_tree.nodes).length > 0) {
    const tree = anchor.memory.ltm_tree
    // 获取节点关键词：优先 LLM 提交的 keywords，回退自动提取
    function nodeKeys(node) {
      if (node && Array.isArray(node.keywords) && node.keywords.length > 0) {
        return node.keywords.filter(Boolean)
      }
      return extractKeywords(node?.summary || '', 4)
    }
    function buildContent(node) {
      const parts = [node.summary || '']
      // 嵌入直接子节点索引（递归扫描级联的关键）
      if (Array.isArray(node.children) && node.children.length > 0) {
        const indexLines = ['', '── 子节点索引 ──']
        for (const childId of node.children) {
          const child = tree.nodes[childId]
          if (!child) continue
          const childKeys = nodeKeys(child)
          // 父节点索引中每个子节点只保留一个关键词（最核心的实体名）
          const childKey = childKeys.length > 0 ? childKeys[0] : ''
          const childShort = String(child.summary || '').slice(0, 20)
          indexLines.push(`· [L${child.depth || 1}·#${child.id}] 关键词: ${childKey} ｜ ${childShort}...`)
        }
        parts.push(indexLines.join('\n'))
      }
      return parts.join('\n')
    }
    function walkLtm(nodeId) {
      const node = tree.nodes[nodeId]
      if (!node) return
      const ownKeys = nodeKeys(node)
      const depth = node.depth || 1
      const shortSummary = String(node.summary || '').slice(0, 12)
      const title = `LTM·L${depth}·${shortSummary}·#${node.id}`
      // LTM 条目默认停用（enabled: false），用户可在 UI 中手动启用需要的条目
      // anchorRef 用 node.id 作为稳定标识，title 中 summary 变化不影响匹配
      upsert('anchor', title, ownKeys, buildContent(node), { enabled: false, anchorRef: { kind: 'ltm_node', nodeId: node.id } })
      if (Array.isArray(node.children)) {
        for (const childId of node.children) {
          walkLtm(childId)
        }
      }
    }
    for (const rootId of tree.roots) {
      walkLtm(rootId)
    }
  }

  // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
  // // 大纲 → 单条【剧情大纲】（keys: 当前节点关键词）
  // if (cfg.plotRoute === true && anchor.plot_route) {
  //   const pr = anchor.plot_route
  //   const parts = []
  //   if (pr.current_node) parts.push('当前节点: ' + pr.current_node)
  //   if (pr.recap) parts.push('前情衔接: ' + pr.recap)
  //   if (pr.next_scene) parts.push('下一幕规划: ' + pr.next_scene)
  //   // [2026-09-29 暂停] 活跃伏笔暂时不单独维护，伏笔信息自然流入STM
  //   // if (Array.isArray(pr.foreshadowing) && pr.foreshadowing.length) parts.push('活跃伏笔: ' + pr.foreshadowing.join('; '))
  //   if (parts.length) {
  //     upsert('anchor', '剧情大纲', String(pr.current_node || '').split(/\s+/).filter(Boolean), parts.join('\n'))
  //   }
  // }

  // 上限控制（v0.9.15）：不删除条目。anchor 自动条目中启用数超过 maxEnabled（默认 200）
  // 时，自动停用修改时间最早的（内容与锚点数据都保留，随时可手动重新启用）；
  // 用户手动改过启用/停用状态的条目（enabledTouched）不参与计数、不受管控
  {
    const maxEnabled = Math.max(1, Number(cfg.maxEnabled) || 200)
    const managed = book.entries.filter(e => e.source === 'anchor' && !e.enabledTouched)
    const enabledManaged = managed.filter(e => e.enabled !== false)
    if (enabledManaged.length > maxEnabled) {
      const sorted = [...enabledManaged].sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0))
      for (const e of sorted.slice(0, enabledManaged.length - maxEnabled)) e.enabled = false
    }
  }

  writeSessionWorldbook(book)
  return produced
}

/* ───────────── DSHT 原生召回兼容 ───────────── */

/**
 * 从 DSHT 世界书导入条目到会话临时世界书（v0.10.1 · 「导入世界书」能力）。
 * 与「绑定」的区别：绑定是引用外部文件（boundBooks，写回原文件）；导入是复制
 * 条目到本会话的 entries[]（source:'import'），之后完全自持（删除原书不影响）。
 *
 * source: { kind:'embedded', cardPath } | { kind:'standalone', path } —— 与绑定结构一致
 * doc:    readBoundWorldbookDocument(source) 返回的世界书文档（数组/字典双格式）
 * options: { includeDisabled?, includeEmpty? }
 *   - includeDisabled=false（默认）：跳过原书停用条目（enabled===false / disable===true）
 *   - includeEmpty=false（默认）：跳过空内容条目
 *
 * 去重：同一来源书 + 同一原条目（importRef=原 ref，数组书 entry:N / 字典书 entry:<uid>）
 * 重复导入 → 更新内容/关键词/标题；用户改过启用状态的（enabledTouched）不覆盖启用，
 * 其余保持原书最新启用状态。返回 { imported, updated, skipped }。
 */
export function importWorldbookEntries(sessionId, source, doc, options = {}) {
  const sid = String(sessionId || '').trim()
  if (!sid) return { imported: 0, updated: 0, skipped: 0, error: '缺少 sessionId' }
  if (!doc || typeof doc !== 'object') return { imported: 0, updated: 0, skipped: 0, error: '世界书文档不可读' }
  const book = loadSessionWorldbook(sid)
  if (!book.enabled) return { imported: 0, updated: 0, skipped: 0, error: '会话临时世界书未启用（先在设置中启用）' }
  const includeDisabled = options.includeDisabled === true
  const includeEmpty = options.includeEmpty === true
  // keepConstant=false（默认）：源书常驻条目导入后也按普通条目（不常驻），由客户端弹窗询问；
  // keepConstant=true：保留源书常驻标记
  const keepConstant = options.keepConstant === true
  const rawList = (doc?.data || doc)?.character_book?.entries ?? (doc?.data || doc)?.entries
  const native = !Array.isArray(rawList) && rawList && typeof rawList === 'object'
  const records = native
    ? Object.entries(rawList).map(([uid, entry]) => ({ entry, ref: 'entry:' + uid }))
    : (Array.isArray(rawList) ? rawList.map((entry, index) => ({ entry, ref: 'entry:' + index })) : [])
  const bookName = String(doc?.name || doc?.data?.name || doc?.character_book?.name || source?.path || source?.cardPath || '')
  const from = sourceSig(source)
  const now = Date.now()
  let imported = 0, updated = 0, skipped = 0
  // 源书常驻条目总数（供客户端弹窗询问「是否保持常驻」）
  const constantCount = records.reduce((n, rec) => (rec.entry && typeof rec.entry === 'object' && rec.entry.constant === true ? n + 1 : n), 0)

  for (const rec of records) {
    const e = rec.entry
    if (!e || typeof e !== 'object') { skipped++; continue }
    const enabled = native ? e.disable !== true : e.enabled !== false
    if (enabled === false && !includeDisabled) { skipped++; continue }
    const content = String(e.content || '').trim()
    if (!content && !includeEmpty) { skipped++; continue }
    const title = String(e.title || e.comment || e.name || ('条目 ' + (native ? rec.ref.slice(6) : rec.index + 1)))
    const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : (Array.isArray(e.key) ? e.key.filter(Boolean) : [])
    const constant = keepConstant ? e.constant === true : false
    // 稳定 id：来源书 + 原条目 ref 哈希 → 重复导入同一书命中同一条
    const id = anchorEntryId('import', from + ':' + rec.ref)
    let target = book.entries.find(x => x.source === 'import' && x.importFrom === from && x.importRef === rec.ref)
    if (!target) target = book.entries.find(x => x.id === id)
    // 兜底：同一本书（同名 importTitle）的同一条目也视为命中——库导入与文件上传同书互相同步更新，
    // 文件名/来源变化不产生重复条目
    if (!target) target = book.entries.find(x => x.source === 'import' && x.importTitle === bookName && x.importRef === rec.ref)
    if (target) {
      // 更新：内容/关键词/标题保持原书最新；启用/常驻状态尊重用户手动改动（enabledTouched/constantTouched）
      target.title = title
      target.keys = keys
      target.content = content
      if (!target.constantTouched) target.constant = constant
      if (!target.enabledTouched) target.enabled = enabled
      target.importTitle = bookName
      target.updatedAt = now
      updated++
    } else {
      book.entries.push({
        id,
        title,
        keys,
        content,
        enabled,
        constant,
        source: 'import',
        importFrom: from,
        importRef: rec.ref,
        importTitle: bookName,
        createdAt: now,
        updatedAt: now
      })
      imported++
    }
  }
  writeSessionWorldbook(book)
  return { imported, updated, skipped, name: bookName, entryCount: records.length, constantCount }
}

/**
 * 把临时世界书条目转成 DSHT worldBook.view.entries 兼容格式，
 * 供 merger 并入世界书快照参与原生召回。
 */
export function toWorldbookEntries(book) {
  if (!book || !Array.isArray(book.entries)) return []
  return book.entries
    .filter(e => e && e.enabled !== false && String(e.content || '').trim() !== '')
    .map(e => {
      const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : (Array.isArray(e.key) ? e.key.filter(Boolean) : [])
      return {
        ref: 'session-wb:' + e.id,
        sourceUid: e.id,
        title: e.title || '会话条目',
        comment: e.title || '会话条目',
        name: e.title || '会话条目',
        keys,
        primaryKeys: keys,
        secondaryKeys: Array.isArray(e.keysecondary) ? e.keysecondary.filter(Boolean) : [],
        content: String(e.content || '').trim(),
        enabled: true,
        constant: e.constant === true,
        sessionWorldbook: true,
        sessionWorldbookSource: e.source || 'manual'
      }
    })
}

/** 人工选择的条目（按 selection 顺序），用于前台动态世界书快照注入。 */
export function selectedEntries(book) {
  if (!book || !Array.isArray(book.selection) || !Array.isArray(book.entries)) return []
  return book.selection
    .map(id => book.entries.find(e => e.id === id))
    .filter(Boolean)
}

/* ───────────── 会话级世界书绑定（v0.7.18）───────────── */
/* 参考 DSHT 角色卡多世界书绑定（.worldbook-bindings.json）：
 *   boundBooks: [{ kind:'embedded', cardPath:'cards/x.json' } | { kind:'standalone', path:'worldbooks/y.json' }]
 * 绑定条目与临时条目同一 merger 合并点并入 view.entries，参与原生召回/冷却/筛选。
 */

function documentEntriesOf(doc) {
  const raw = doc?.data || doc
  const list = raw?.character_book?.entries || raw?.entries
  if (Array.isArray(list)) return list
  // DSHT 原生独立世界书格式：entries 为对象字典 {uid: entry}（非数组）
  if (list && typeof list === 'object') return Object.values(list)
  return []
}

function documentNameOf(doc) {
  return String(doc?.name || doc?.data?.name || doc?.character_book?.name || '')
}

/** 读取单个绑定来源的世界书文档（embedded=卡工作副本 / standalone=独立世界书文件）。 */
export function readBoundWorldbookDocument(source, dataRoot) {
  const root = dataRoot || resolveTavernDataRoot()
  if (!root) return null
  const kind = source?.kind
  if (kind === 'embedded') {
    const file = String(source.cardPath || '').replace(/^.*cards[\\/]/, 'cards/')
    const abs = join(root, 'resources', file)
    if (!existsSync(abs)) return null
    const data = JSON.parse(readFileSync(abs, 'utf-8'))
    const raw = data?.raw || data
    const doc = raw?.data?.character_book || raw?.character_book
    return doc && typeof doc === 'object' ? doc : null
  }
  if (kind === 'standalone') {
    const file = String(source.path || '').replace(/^.*worldbooks[\\/]/, 'worldbooks/')
    const abs = join(root, 'resources', file)
    if (!existsSync(abs)) return null
    const data = JSON.parse(readFileSync(abs, 'utf-8'))
    return data && typeof data === 'object' ? data : null
  }
  return null
}

/** 写回单个绑定来源的世界书文档（embedded=卡工作副本 / standalone=独立世界书文件）。
 *  doc 为 readBoundWorldbookDocument 返回的引用，调用方已就地修改；standalone 直接写 doc，
 *  embedded 重新读完整卡文件后将 character_book 替换为 doc 再写回。 */
export function writeBoundWorldbookDocument(source, doc, dataRoot) {
  const root = dataRoot || resolveTavernDataRoot()
  if (!root || !doc) return false
  const kind = source?.kind
  if (kind === 'embedded') {
    const file = String(source.cardPath || '').replace(/^.*cards[\\/]/, 'cards/')
    const abs = join(root, 'resources', file)
    if (!existsSync(abs)) return false
    try {
      const data = JSON.parse(readFileSync(abs, 'utf-8'))
      const raw = data?.raw || data
      if (raw?.data?.character_book) raw.data.character_book = doc
      else if (raw?.character_book) raw.character_book = doc
      else return false
      writeFileSync(abs, JSON.stringify(data, null, 2), 'utf-8')
      return true
    } catch { return false }
  }
  if (kind === 'standalone') {
    const file = String(source.path || '').replace(/^.*worldbooks[\\/]/, 'worldbooks/')
    const abs = join(root, 'resources', file)
    if (!existsSync(abs)) return false
    try {
      writeFileSync(abs, JSON.stringify(doc, null, 2), 'utf-8')
      return true
    } catch { return false }
  }
  return false
}

/** 把绑定世界书条目转成 DSHT view.entries 兼容格式（ref='bound:书序:条目序'）。 */
export function sourceSig(s) {
  return JSON.stringify({ kind: s?.kind, cardPath: s?.cardPath, path: s?.path })
}

/**
 * v0.9.15：全局自动绑定合成（全局清单 − 本会话主动解除 ＋ 本会话额外绑定）。
 * 会话世界书只在"主动解除/额外绑定"时落盘，新会话/分支会话无需物化即跟随全局清单。
 * 时间戳语义：解除记录仅在 解除.ts > 全局.ts 时生效——重新设为全局（新 ts）
 * 即对所有会话无条件生效，无需清扫历史解除记录。
 */
export function effectiveBoundBooks(book) {
  const unbound = new Map((Array.isArray(book?.unboundGlobals) ? book.unboundGlobals : [])
    .map(s => [sourceSig(s), Number(s?.ts || 0)]))
  const globals = listGlobalAutoBind().filter(s => {
    const ub = unbound.get(sourceSig(s))
    return ub === undefined || !(ub > Number(s?.ts || 0))
  })
  const locals = Array.isArray(book?.boundBooks) ? book.boundBooks : []
  const seen = new Set()
  const out = []
  for (const s of [...globals, ...locals]) {
    const k = sourceSig(s)
    if (!seen.has(k)) { seen.add(k); out.push(s) }
  }
  return out
}

export function boundWorldbookEntries(book, dataRoot) {
  const bound = effectiveBoundBooks(book)
  if (bound.length === 0) return { books: [], entries: [] }
  const books = []
  const entries = []
  const seen = new Set()
  bound.forEach((source, idx) => {
    let doc = null
    let error = ''
    try { doc = readBoundWorldbookDocument(source, dataRoot) } catch (err) { error = String(err?.message || err) }
    const base = {
      kind: source?.kind || 'standalone',
      cardPath: source?.cardPath,
      path: source?.path,
      index: idx
    }
    if (!doc) {
      books.push({ ...base, available: false, name: '', entryCount: 0, error: error || '文件不存在或不可读' })
      return
    }
    const list = documentEntriesOf(doc)
    const name = documentNameOf(doc) || (source?.kind === 'embedded' ? source.cardPath : source.path)
    // 双格式判定（同 official-worldbook readEntries）：entries 为对象字典 = 原生 SillyTavern
    // 独立书（disable/key 字段）；数组 = 卡内嵌 DSHT 格式（enabled/keys）
    const rawList = (doc?.data || doc)?.character_book?.entries ?? (doc?.data || doc)?.entries
    const native = !Array.isArray(rawList) && rawList && typeof rawList === 'object'
    books.push({ ...base, available: true, name, entryCount: list.length, native })
    list.forEach((e, eidx) => {
      // 停用语义双格式：原生书 disable:true = 停用；卡内嵌 enabled:false = 停用
      if (!e || typeof e !== 'object' || e.enabled === false || (native && e.disable === true)) return
      const content = String(e.content || '').trim()
      if (!content) return
      const ref = 'bound:' + idx + ':' + eidx
      if (seen.has(ref)) return
      seen.add(ref)
      const title = String(e.title || e.comment || e.name || (name + '#' + (eidx + 1)))
      // 兼容两种关键词字段：DSHT/SillyTavern 标准用 keys，部分世界书（如 SillyTavern 导出的年鉴）用 key
      const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : (Array.isArray(e.key) ? e.key.filter(Boolean) : [])
      const secondaryKeys = Array.isArray(e.keysecondary) ? e.keysecondary.filter(Boolean) : []
      entries.push({
        ref,
        sourceUid: ref,
        title,
        comment: title,
        name: title,
        keys,
        primaryKeys: keys,
        secondaryKeys,
        content,
        enabled: native ? e.disable !== true : e.enabled !== false,
        constant: e.constant === true,
        boundWorldbook: true,
        boundWorldbookIndex: idx
      })
    })
  })
  return { books, entries }
}

/** 写回 bound 条目（v0.7.20；双格式语义对齐 updateOfficialEntry）。
 *  action: 'toggle' | 'update'；entry: { title?, keys?, content?, enabled? }。
 *  返回 { ok, ref?, enabled?, source?, error? }。错误一律 ok:false（HTTP 层统一 400）。 */
export function updateBoundEntry(book, ref, { action, entry } = {}, dataRoot) {
  const bm = /^bound:(\d+):(\d+)$/.exec(String(ref || ''))
  if (!bm) return { ok: false, error: '非法 bound ref: ' + ref }
  const boundRes = boundWorldbookEntries(book, dataRoot)
  const src = boundRes.books[Number(bm[1])]
  if (!src || !src.available) return { ok: false, error: '绑定世界书不可读: ' + (src?.error || '未知') }
  const doc = readBoundWorldbookDocument(src, dataRoot)
  if (!doc) return { ok: false, error: '绑定世界书文档不可读' }
  const docRoot = doc?.data || doc
  const rawEntries = docRoot?.character_book?.entries || docRoot?.entries
  // 双格式判定（同 readEntries）：字典 = 原生 ST 独立书（disable/key），数组 = 卡内嵌 DSHT 格式
  // （enabled/keys）。写错字段 DSHT 召回读不到 = 假成功。
  const native = !Array.isArray(rawEntries) && rawEntries && typeof rawEntries === 'object'
  const list = Array.isArray(rawEntries) ? rawEntries : (native ? Object.values(rawEntries) : null)
  if (!Array.isArray(list)) return { ok: false, error: '世界书条目结构不支持（非数组/字典）' }
  // eidx 与 boundWorldbookEntries 生成 ref 时的 Object.values 顺序一致
  const target = list[Number(bm[2])]
  if (!target) return { ok: false, error: '条目不存在: ' + ref }
  if (action === 'toggle') {
    if (native) target.disable = target.disable !== true
    else target.enabled = (target.enabled !== false) ? false : true
  } else if (action === 'update') {
    if (entry?.enabled !== undefined) {
      if (native) target.disable = entry.enabled !== true
      else target.enabled = entry.enabled === true
    }
    // 标题字段兼容：只写条目原有的字段（原生书用 comment，卡内嵌用 title）
    if (typeof entry?.title === 'string' && entry.title.trim() !== '') {
      const titleField = Object.prototype.hasOwnProperty.call(target, 'comment') ? 'comment' : 'title'
      target[titleField] = entry.title
    }
    // 关键词双格式：原生书写 key（DSHT 召回读取的字段），卡内嵌写 keys
    if (Array.isArray(entry?.keys)) {
      if (native) target.key = entry.keys
      else target.keys = entry.keys
    }
    if (typeof entry?.content === 'string') target.content = entry.content
  } else return { ok: false, error: 'bound 条目不支持 action: ' + action }
  if (!writeBoundWorldbookDocument(src, doc, dataRoot)) return { ok: false, error: '写回失败: ' + ref }
  return { ok: true, ref, enabled: native ? target.disable !== true : target.enabled !== false, source: src.kind + (src.kind === 'standalone' ? (':' + (src.path || '')) : (':' + (src.cardPath || ''))) }
}

/**
 * v0.9.16 支线系统：把族内其他成员的 LTM 同步为本会话的【支线】临时世界书条目。
 * - 每个成员的每个 LTM 节点一条，anchorRef { kind:'sideline_node', sid, nodeId } 按 nodeId 去重
 *   （= 各支线对自己的 LTM 去重）
 * - 根节点条目启用，非根节点自动停用（不删除）；用户手动 toggle 打 enabledTouched 后不再自动改动
 * - 内容首行固定说明为支线剧情记录；行为与普通临时条目一致（关键词激活/冷却/强制注入）
 * 在每次结算后（autoImportFromAnchor 之后）调用，把副本刷新到源会话的最新 LTM。
 * 返回发生变化的条目数。
 */
/** 移除指定来源成员的【支线】条目（解除关联/删除会话清理用）。返回移除条数。 */
export function removeSidelineEntries(sessionId, fromSids) {
  const sid = String(sessionId || '').trim()
  const set = new Set((Array.isArray(fromSids) ? fromSids : []).map(String))
  if (!sid || set.size === 0) return 0
  const book = loadSessionWorldbook(sid)
  const kept = book.entries.filter(e => !(e.source === 'sideline' && e.sidelineFrom && set.has(e.sidelineFrom)))
  const removed = book.entries.length - kept.length
  if (removed > 0) { book.entries = kept; writeSessionWorldbook(book) }
  return removed
}

export function syncSidelineEntries(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid || sid.startsWith('test-')) return 0
  // 会话删除检测：已删除成员残留的【支线】条目先清掉（不依赖族识别，族解散也能清）
  const book0 = loadSessionWorldbook(sid)
  const stale = book0.entries.filter(e => e.source === 'sideline' && e.sidelineFrom && !sessionAlive(e.sidelineFrom))
  if (stale.length > 0) {
    book0.entries = book0.entries.filter(e => !stale.includes(e))
    writeSessionWorldbook(book0)
  }
  const fid = resolveFamilyId(sid)
  if (!fid) return 0
  const members = familyMembers(fid).filter(m => m.sessionId && m.sessionId !== sid)
  if (members.length === 0) return 0
  const book = loadSessionWorldbook(sid)
  if (!book.enabled) return 0
  // [NA-v0.10] 自身 LTM 树：跨支线去重需与成员自身的 LTM 树节点直接对比
  // （autoImportFromAnchor 会把自身 LTM 树节点生成为【LTM·】条目，避免支线同内容重复）
  const selfAnchor = readAnchor(sid)
  const selfTree = selfAnchor && selfAnchor.memory && selfAnchor.memory.ltm_tree && selfAnchor.memory.ltm_tree.nodes
    ? selfAnchor.memory.ltm_tree.nodes : null
  let changed = 0
  const now = Date.now()
  for (const member of members) {
    const fromSid = member.sessionId
    const label = member.label || '支线'
    const src = readAnchor(fromSid)
    const tree = src?.memory?.ltm_tree
    const hasTree = tree?.nodes && Array.isArray(tree.roots)
    if (!hasTree && !(Array.isArray(src?.memory?.known_facts) && src.memory.known_facts.length > 0)) continue
    function nodeKeysOf(node) {
      if (node && Array.isArray(node.keywords) && node.keywords.length > 0) return node.keywords.filter(Boolean)
      return extractKeywords(node?.summary || '', 4)
    }
    // [NA-v0.10] 文本归一化：去空白与【】<>—— 标记，用于内容命中去重
    const normTxt = s => String(s || '').replace(/\s+/g, '').replace(/[【】<>——]/g, '')
    // [NA-v0.10] 同一事实判定：内容相等或互相包含（前缀/超集命中）
    const sameFact = (a, b) => {
      const na = normTxt(a), nb = normTxt(b)
      if (!na || !nb) return false
      return na === nb || na.includes(nb) || nb.includes(na)
    }
    function buildContent(node) {
      const nodeTitle = node.title || String(node.summary || '').slice(0, 12)
      const title = `【${label}】L${node.depth || 1}·${nodeTitle}`
      const lines = [title, '【支线剧情记录】', node.summary || '']
      if (Array.isArray(node.children) && node.children.length > 0) {
        const idx = ['', '── 子节点索引 ──']
        for (const childId of node.children) {
          const child = tree.nodes[childId]
          if (!child) continue
          const ck = nodeKeysOf(child)
          idx.push(`· [L${child.depth || 1}·#${child.id}] 关键词: ${ck[0] || ''} ｜ ${String(child.summary || '').slice(0, 20)}...`)
        }
        lines.push(idx.join('\n'))
      }
      return lines.join('\n')
    }
    // 别名标记：形如【<--支线别名-->】的附加关键词——用作标记和检索，
    // 正常对话文本不会出现此格式所以不会被关键词匹配误触发；别名修改后旧标记在此被替换
    const aliasMarker = `【<--${label}-->】`
    const isAliasMarker = k => /^【<--.*-->】$/.test(String(k))
    // [NA-v0.10] 提取【支线】条目的正文本体（去掉标题/标记行/子节点索引），用于归一化比较
    const sidelineBodyOf = content => {
      const sep = '\n【支线剧情记录】\n'
      const idxMark = '\n── 子节点索引 ──'
      const c = String(content || '')
      let body = c.indexOf(sep) >= 0 ? c.slice(c.indexOf(sep) + sep.length) : c
      const mi = body.indexOf(idxMark)
      if (mi >= 0) body = body.slice(0, mi)
      return body.replace(/\s+/g, '').replace(/[【】<>——]/g, '')
    }
    function walk(nodeId, isRoot) {
      const node = tree.nodes[nodeId]
      if (!node) return
      const depth = node.depth || 1
      const shortSummary = node.title || String(node.summary || '').slice(0, 12)
      const title = `【${label}】L${depth}·${shortSummary}`
      const keys = [...new Set([...nodeKeysOf(node), aliasMarker])]
      const content = buildContent(node)
      // 优先按 anchorRef（fromSid+nodeId 稳定标识）匹配，回退 id
      const refId = anchorEntryId('sideline', fromSid + ':' + node.id)
      let entry = book.entries.find(e => e.anchorRef && e.anchorRef.kind === 'sideline_node' &&
        e.anchorRef.sid === fromSid && e.anchorRef.nodeId === node.id)
      if (!entry) entry = book.entries.find(e => e.id === refId)
      if (!entry) {
        // [NA-v0.10] 内容命中去重：判断键是内容（summary 归一化），不是 keys/entry/标题。
        // 对比范围 = 其他成员同步的【支线】LTM 条目 + 成员自身 LTM 树。
        // 内容命中时：其他成员【支线】→ 覆盖世界书条目为最新；成员自身 LTM 树 → 直接写入
        // 自身树节点（源 ⊇ 自身才覆盖）。内容不同 = 各支线互补，各自保留。
        const nodeBody = String(node.summary || '').replace(/\s+/g, '').replace(/[【】<>——]/g, '')
        let dupEntry = null
        let dupSelfNode = null
        if (nodeBody !== '') {
          for (const e of book.entries) {
            if (!(e.source === 'sideline' && e.anchorRef && e.anchorRef.kind === 'sideline_node' && e.anchorRef.sid !== fromSid)) continue
            if (sidelineBodyOf(e.content) === nodeBody) { dupEntry = e; break }
          }
          if (!dupEntry && selfTree) {
            for (const selfId in selfTree) {
              const sn = selfTree[selfId]
              if (sn && sameFact(String(node.summary || ''), String(sn.summary || ''))) { dupSelfNode = sn; break }
            }
          }
        }
        if (dupSelfNode) {
          // 自身 LTM 树内容命中 → 判定为同一事实（重复内容）：
          // 直接写入自身 LTM 树节点，不建世界书条目；autoImportFromAnchor 会把树同步为世界书条目。
          // 覆盖条件：源成员内容 ⊇ 自身树节点内容且不同 → 覆盖为源（保留更多信息）；
          // 自身树节点 ⊇ 源 或相等 → 不动（自身已更全/已含该内容）。
          const selfNode = dupSelfNode.id != null && selfAnchor && selfAnchor.memory && selfAnchor.memory.ltm_tree && selfAnchor.memory.ltm_tree.nodes
            ? selfAnchor.memory.ltm_tree.nodes[dupSelfNode.id] : null
          if (selfNode) {
            const nn = String(node.summary || ''), sn = String(selfNode.summary || '')
            if (normTxt(nn) && normTxt(nn).includes(normTxt(sn)) && nn !== sn) {
              selfNode.summary = nn
              writeAnchor(sid, selfAnchor)
              changed++
            }
          }
        } else if (dupEntry) {
          // 内容命中的其他成员【支线】→ 判定为重复 → 直接覆盖为最新
          dupEntry.content = content
          dupEntry.keys = [...new Set([...(Array.isArray(dupEntry.keys) ? dupEntry.keys.filter(k => !isAliasMarker(k)) : []), ...keys])]
          dupEntry.title = title
          dupEntry.readOnly = true
          dupEntry.updatedAt = now
          if (!dupEntry.enabledTouched) dupEntry.enabled = isRoot
          changed++
        } else {
          book.entries.push({
            id: refId,
            title,
            keys: [...keys],
            content,
            enabled: isRoot,
            constant: false,
            source: 'sideline',
            sidelineFrom: fromSid,
            readOnly: true,
            anchorRef: { kind: 'sideline_node', sid: fromSid, nodeId: node.id },
            createdAt: now,
            updatedAt: now
          })
          changed++
        }
      } else {
        // 内容整体重建（首行=标题、次行=【支线剧情记录】；保留旧首行会把旧标题/说明叠层）
        entry.content = content
        entry.keys = [...new Set([...(Array.isArray(entry.keys) ? entry.keys.filter(k => !isAliasMarker(k)) : []), ...keys])]
        entry.title = title
        entry.readOnly = true
        entry.updatedAt = now
        // 根/非根自动启用/停用（用户碰过的不动）
        if (!entry.enabledTouched) entry.enabled = isRoot
        changed++
      }
      if (Array.isArray(node.children)) for (const childId of node.children) walk(childId, false)
    }
    if (hasTree) for (const rootId of tree.roots) walk(rootId, true)

    // v0.9.19：已知情报与 LTM 同机制流动——来源成员的 known_facts 逐条生成【支线】条目
    // （known_facts 本身不再族共享，各会话自有；这里只读对方的锚点做条目副本）
    for (const fact of (Array.isArray(src?.memory?.known_facts) ? src.memory.known_facts : [])) {
      if (!fact || !fact.entry || !fact.summary) continue
      const factKeys = (Array.isArray(fact.keywords) && fact.keywords.length > 0 ? fact.keywords : [fact.entry])
        .filter(k => !isAliasMarker(k))
      const fTitle = `【${label}】${fact.entry}`
      const fContent = [fTitle, '【支线剧情记录】', String(fact.summary)].join('\n')
      const fRefId = anchorEntryId('sideline', fromSid + ':fact:' + (fact.id || fact.entry))
      let fEntry = book.entries.find(e => e.anchorRef && e.anchorRef.kind === 'sideline_fact' &&
        e.anchorRef.sid === fromSid && e.anchorRef.id === (fact.id || fact.entry))
      if (!fEntry) fEntry = book.entries.find(e => e.id === fRefId)
      if (!fEntry) {
        // [NA-v0.10] 内容命中去重：判断键只有内容（summary 归一化），不用 keys/entry/标题。
        // 对比范围 = 其他成员同步的【支线】条目 + 成员自身锚点世界书（known_fact）。
        // 内容命中时：其他成员【支线】与成员自身锚点均覆盖合并（内容 A+B 保留双方信息，
        // 自身锚点不跳过）；内容不同 = 互补，各自保留。
        const factBody = String(fact.summary || '').replace(/\s+/g, '').replace(/[【】<>——]/g, '')
        let dupEntry = null
        if (factBody !== '') {
          for (const e of book.entries) {
            const isOtherSideline = e.source === 'sideline' && e.anchorRef && e.anchorRef.kind === 'sideline_fact' && e.anchorRef.sid !== fromSid
            const isOwnAnchor = e.source === 'anchor' && e.anchorRef && e.anchorRef.kind === 'known_fact'
            if (!isOtherSideline && !isOwnAnchor) continue
            let eBody
            if (e.source === 'sideline') {
              const sep = '\n【支线剧情记录】\n'
              const content = String(e.content || '')
              eBody = content.indexOf(sep) >= 0 ? content.slice(content.indexOf(sep) + sep.length) : content
            } else {
              const nl = String(e.content || '').indexOf('\n')
              eBody = nl >= 0 ? String(e.content).slice(nl + 1) : String(e.content || '')
            }
            if (eBody.replace(/\s+/g, '').replace(/[【】<>——]/g, '') === factBody) { dupEntry = e; break }
          }
        }
        if (dupEntry) {
          // 内容命中 → 判定为同一事实（重复内容）→ 直接覆盖为最新，不拼接累积
          const newSummary = String(fact.summary || '')
          const oldContent = String(dupEntry.content || '')
          if (dupEntry.source === 'anchor') {
            // 自身锚点 known_fact：保持首行 + 覆盖 summary 段为最新（不改其格式）
            const nl = oldContent.indexOf('\n')
            const firstLine = nl >= 0 ? oldContent.slice(0, nl) : (dupEntry.title || oldContent)
            dupEntry.content = firstLine + '\n' + newSummary
          } else {
            // 其他成员【支线】：直接覆盖为最新（保持【支线剧情记录】结构）
            dupEntry.content = fContent
          }
          dupEntry.keys = [...new Set([...(Array.isArray(dupEntry.keys) ? dupEntry.keys.filter(k => !isAliasMarker(k)) : []), ...factKeys, aliasMarker])]
          dupEntry.title = fTitle
          dupEntry.readOnly = true
          dupEntry.updatedAt = now
          changed++
        } else {
        book.entries.push({
          id: fRefId,
          title: fTitle,
          keys: [...new Set([...factKeys, aliasMarker])],
          content: fContent,
          enabled: true,
          constant: false,
          source: 'sideline',
          sidelineFrom: fromSid,
          readOnly: true,
          anchorRef: { kind: 'sideline_fact', sid: fromSid, id: fact.id || fact.entry },
          createdAt: now,
          updatedAt: now
        })
        changed++
        }
      } else {
        // 正文整体重建（首行标记带最新别名；旧实现 fFirst+'\n'+fContent 会把标记行叠两层）
        fEntry.content = fContent
        fEntry.keys = [...new Set([...(Array.isArray(fEntry.keys) ? fEntry.keys.filter(k => !isAliasMarker(k)) : []), ...factKeys, aliasMarker])]
        fEntry.title = fTitle
        fEntry.readOnly = true
        fEntry.updatedAt = now
        changed++
      }
    }
  }
  if (changed > 0) writeSessionWorldbook(book)
  return changed
}

export { emptyBook }
