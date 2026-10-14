/**
 * 支线系统（v0.9.16 · 会话族谱）
 *
 * 支线 = 通过官方 fork 全链路复制出的会话，由本插件登记为族谱成员。
 * 主线（根会话）与所有支线同级，族内共享：
 *   - known_facts（已知情报）：familyId 为键的共享存储（见 data-store.js 重定向）
 *   - LTM 交叉注入：各成员的 LTM 以【支线】临时世界书条目注入其他成员（见 session-worldbook.js）
 *
 * 族谱解析：支线登记在 data/branch-families.json；未登记的会话沿 chat.forkedFrom
 * 父指针向根回溯（sessions.json → chats/<chatId>/snapshots），命中任一已登记祖先
 * 即归入其族。familyId = 根会话 sessionId。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTavernDataRoot, readChatFromDisk } from './official-worldbook.js'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 'data')
const registryFile = join(dataDir, 'branch-families.json')
const familiesDir = join(dataDir, 'anchor-families')

let dataRootOverride = ''

/** 注入 DSH 用户数据根目录（index.js apply 时调用，与 config.tavernDataRoot 一致）。 */
export function setFamilyDataRoot(root) {
  dataRootOverride = String(root || '')
  chainCache.clear()
}

function dataRoot() {
  return dataRootOverride || resolveTavernDataRoot()
}

/** 当前 DSH 用户数据根目录（供其他模块读 chat 用）。 */
export function currentDataRoot() {
  return dataRoot()
}

/** 沿 forkedFrom 链返回祖先 sessionId 列表（直接父级在前，不含自身）。 */export function parentChain(sessionId) {
  const dataRootPath = dataRoot()
  const chain = []
  let current = String(sessionId || '').trim()
  const seen = new Set([current])
  for (let i = 0; i < 32; i++) {
    if (!current) break
    const chat = readChatFromDisk(dataRootPath, current)
    const parent = String(chat?.forkedFrom?.sessionId || '')
    if (!parent || seen.has(parent)) break
    chain.push(parent)
    seen.add(parent)
    current = parent
  }
  return chain
}

/** 会话的族根 sessionId（无 fork 关系返回自身）。 */
export function rootOf(sessionId) {
  return rootSessionId(sessionId)
}

// ── 注册表 ──
// { branches: { <sessionId>: { familyId, parentSid, label, createdAt } } }

let registryCache = null

export function readRegistry() {
  if (registryCache) return registryCache
  try {
    const data = JSON.parse(readFileSync(registryFile, 'utf-8'))
    registryCache = data && typeof data === 'object' && data.branches && typeof data.branches === 'object'
      ? data
      : { branches: {} }
  } catch {
    registryCache = { branches: {} }
  }
  return registryCache
}

function writeRegistry(reg) {
  try {
    mkdirSync(dirname(registryFile), { recursive: true })
    writeFileSync(registryFile, JSON.stringify(reg, null, 2), 'utf-8')
    registryCache = reg
    chainCache.clear()
    return true
  } catch {
    return false
  }
}

/** 成员别名（族内 label；root 未登记默认 '主线'；查不到返回 null）。 */
export function memberLabelOf(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return null
  const fid = resolveFamilyId(sid) || (readRegistry().branches[sid]?.familyId)
  if (!fid) return null
  const m = familyMembers(fid).find(x => x.sessionId === sid)
  return m ? (m.label || null) : null
}

const ALIAS_MARKER_RE = /^【<--.*-->】$/

/** 按来源把【<--别名-->】标记写进 known_facts 的 keywords 字段本身：
 *  有 sourceSid 的条目 = 原关键词（剔除旧标记）+ 当前来源别名标记；
 *  无来源/写方未知的条目不动 keywords（保护用户手填关键词）。返回新数组。 */
export function tagKnownFacts(list) {
  if (!Array.isArray(list)) return list
  return list.map(f => {
    if (!f || typeof f !== 'object' || !f.sourceSid) return f
    const label = memberLabelOf(f.sourceSid)
    const base = (Array.isArray(f.keywords) ? f.keywords : []).filter(k => !ALIAS_MARKER_RE.test(String(k)))
    return { ...f, keywords: label ? [...base, `【<--${label}-->】`] : base }
  })
}

/** 立即刷新族共享文件的标记（别名修改后调用；平时随 writeAnchor 合并自动刷新）。 */
export function refreshFamilyFactMarkers(familyId) {
  const fid = String(familyId || '').trim()
  if (!fid) return false
  const list = readFamilyKnownFacts(fid)
  if (list === null) return false
  return writeFamilyKnownFacts(fid, tagKnownFacts(list))
}

/** 删除族共享 known_facts 文件（合并族后清理源族）。 */
export function deleteFamilyFile(familyId) {
  try {
    unlinkSync(familyFileFor(familyId))
    return true
  } catch {
    return false
  }
}

/** 清空族谱解析缓存（解除关联/合并族等注册表结构变化后调用）。 */
export function clearFamilyCaches() {
  chainCache.clear()
}

/** 会话名（DSHT data/index.json 的 chat 行 title；读不到返回 ''）。 */
export function sessionTitle(sessionId) {
  const root = dataRoot()
  const sid = String(sessionId || '').trim()
  if (!root || !sid) return ''
  try {
    const links = readChatLinks(root)
    const chatId = links?.[sid]
    if (!chatId) return ''
    const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf-8'))
    const rows = Array.isArray(index?.chats) ? index.chats : []
    return String(rows.find(r => r?.id === chatId)?.title || '')
  } catch {
    return ''
  }
}

/** 登记支线成员。familyId = 根会话 sessionId；未提供时由 parentSid 沿 forkedFrom 链推导。
 *  默认别名 = 主线会话名·支线N（主线会话名读不到则省略前缀）；root 自身登记（改别名）时 familyId=自身。 */
export function registerBranch({ sessionId, familyId, parentSid, label }) {
  const sid = String(sessionId || '').trim()
  let fid = String(familyId || '').trim()
  if (!fid && parentSid) fid = rootSessionId(parentSid)
  if (!fid && sid) fid = sid // root 别名登记：familyId=自身
  if (!sid || !fid) throw new Error('registerBranch 需要 sessionId 与 familyId（或可推导的 parentSid）')
  const reg = readRegistry()
  const existing = reg.branches[sid]
  const isRootReg = sid === fid
  const n = Object.entries(reg.branches).filter(([s, b]) => b.familyId === fid && s !== fid).length
  const defaultLabel = isRootReg
    ? '主线'
    : (sessionTitle(fid) ? sessionTitle(fid) + '·' : '') + '支线' + (n + 1)
  reg.branches[sid] = {
    familyId: fid,
    parentSid: String(parentSid || ''),
    label: String(label || existing?.label || defaultLabel),
    createdAt: existing?.createdAt || Date.now()
  }
  writeRegistry(reg)
  return reg.branches[sid]
}

/** 移除登记（会话删除等场景）。 */
export function unregisterBranch(sessionId) {
  const reg = readRegistry()
  if (!reg.branches[String(sessionId || '')]) return false
  delete reg.branches[String(sessionId || '')]
  writeRegistry(reg)
  return true
}

/** 某族全部成员（含根会话，根已删除时不含）。root 无 forkedFrom 且不登记，由本函数补入。 */
export function familyMembers(familyId) {
  const fid = String(familyId || '').trim()
  if (!fid) return []
  pruneDeletedSessions()
  const reg = readRegistry()
  const members = []
  const rootBranch = reg.branches[fid]
  if (sessionAlive(fid)) {
    members.push({ sessionId: fid, label: rootBranch?.label || '主线', isRoot: true, registered: !!rootBranch, title: sessionTitle(fid) })
  }
  for (const [sid, b] of Object.entries(reg.branches)) {
    if (sid === fid) continue
    if (b.familyId !== fid) continue
    if (!sessionAlive(sid)) continue
    members.push({ sessionId: sid, label: b.label || '支线', isRoot: false, parentSid: b.parentSid || '', registered: true, title: sessionTitle(sid) })
  }
  return members
}

// ── 会话删除检测（惰性清理）──
// DSHT 删除会话时 conversationRegistry.remove 会移除 sessions.json 的 sessionId→chatId
// 映射并删除 chat 目录；对曾是 chat 的会话，映射消失即视为已删除。
// 每次族谱查询顺带清理一次（30s 节流）；无数据根/无 sessions.json（离线测试）时不判死。

const PRUNE_INTERVAL = 30_000
const lastPruneByRoot = new Map() // dataRoot -> ts（切换数据根时各自可清理）

function readChatLinks(root) {
  try {
    const links = JSON.parse(readFileSync(join(root, 'sessions.json'), 'utf-8'))
    return links && typeof links === 'object' ? links : null
  } catch {
    return null
  }
}

/** 会话是否仍存在（以 sessions.json 映射为准；无法判定时按存在处理）。 */
export function sessionAlive(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid) return false
  const root = dataRoot()
  if (!root) return true
  const links = readChatLinks(root)
  if (!links) return true
  return Boolean(links[sid])
}

/** 检测已删除会话并清理：注册表条目、空族共享文件、死者锚点/会话世界书数据文件。 */
export function pruneDeletedSessions() {
  const now = Date.now()
  const root = dataRoot()
  if (!root) return null
  const last = lastPruneByRoot.get(root) || 0
  if (now - last < PRUNE_INTERVAL) return null
  lastPruneByRoot.set(root, now)
  const links = readChatLinks(root)
  if (!links) return null
  const reg = readRegistry()
  const deadSids = []
  for (const sid of Object.keys(reg.branches)) {
    if (!links[sid]) { deadSids.push(sid); delete reg.branches[sid] }
  }
  if (deadSids.length > 0) writeRegistry(reg)
  // 以族共享文件为准扫描全族：族内（含根）无任何存活成员 → 删共享文件 + 死者数据文件
  const removedFamilies = []
  let familyFiles = []
  try { familyFiles = readdirSync(familiesDir).filter(f => f.endsWith('.json')) } catch { }
  for (const file of familyFiles) {
    const fid = file.slice(0, -'.json'.length)
    const memberSids = [fid, ...Object.entries(reg.branches).filter(([, b]) => b.familyId === fid).map(([s]) => s)]
    const anyAlive = memberSids.some(s => links[s])
    if (anyAlive) continue
    try { unlinkSync(join(familiesDir, file)) } catch { }
    removedFamilies.push(fid)
    for (const sid of memberSids) {
      if (links[sid]) continue
      deadSids.push(sid)
      for (const f of [join(dataDir, 'anchors', 'session-' + sid + '.json'), join(dataDir, 'session-worldbooks', 'session-' + sid + '.json')]) {
        try { unlinkSync(f) } catch { }
      }
    }
  }
  if (deadSids.length > 0 || removedFamilies.length > 0) chainCache.clear()
  return { removed: deadSids, removedFamilies }
}

/** 仅供离线测试重置 30s 节流。 */
export function _resetPruneThrottleForTests() {
  lastPruneByRoot.clear()
}

// ── 族谱解析 ──

const chainCache = new Map() // sid -> familyId | null（含负缓存）

/** 沿 chat.forkedFrom 链向根回溯，返回根会话 sessionId（无 fork 关系返回自身）。 */
function rootSessionId(sessionId) {
  const dataRootPath = dataRoot()
  let current = String(sessionId || '').trim()
  const seen = new Set()
  for (let i = 0; i < 32 && current && !seen.has(current); i++) {
    seen.add(current)
    const chat = readChatFromDisk(dataRootPath, current)
    const parent = chat?.forkedFrom?.sessionId
    if (!parent) return current
    current = String(parent)
  }
  return current
}

/**
 * 解析会话所属族：registry 直查 → forkedFrom 链回溯（命中任一已登记祖先 / 根有成员）。
 * 无族返回 null（主线在没有任何支线时也无族）。结果带缓存，registerBranch 会清缓存。
 */
export function resolveFamilyId(sessionId) {
  const sid = String(sessionId || '').trim()
  if (!sid || sid.startsWith('test-') || sid === 'unknown') return null
  pruneDeletedSessions()
  if (chainCache.has(sid)) return chainCache.get(sid)
  let familyId = null
  const reg = readRegistry()
  const direct = reg.branches[sid]
  if (direct) {
    familyId = direct.familyId
  } else if (sid === rootSessionIdFromRegistry(sid, reg)) {
    // 根自身是成员（主线，含仅剩主线的族——族共享文件仍在即视为族未消亡）
    familyId = (Object.values(reg.branches).some(b => b.familyId === sid) || existsSync(familyFileFor(sid))) ? sid : null
  }
  // v0.9.23 改为名册唯一指标：未登记会话不再沿 forkedFrom 回溯入族——
  // 官方 UI fork 未必想进支线系统，成员资格只来自显式登记。
  // forkedFrom 仅在 registerBranch（创建时推导 familyId）与将来的"未登记 fork 提示"中使用。
  chainCache.set(sid, familyId)
  return familyId
}

/** 判断 sid 是否为某族的根（仅按注册表：有成员登记在 sid 名下）。不读 forkedFrom。 */
function rootSessionIdFromRegistry(sid, reg) {
  return Object.values(reg.branches).some(b => b.familyId === sid) || existsSync(familyFileFor(sid)) ? sid : null
}

// ── 族共享 known_facts 存储 ──

function familyFileFor(familyId) {
  const safe = String(familyId || '').replace(/[^\w-]/g, '_')
  return join(familiesDir, safe + '.json')
}

/** 读族共享 known_facts；无文件返回 null（调用方回退本地）。 */
export function readFamilyKnownFacts(familyId) {
  try {
    const file = familyFileFor(familyId)
    if (!existsSync(file)) return null
    const list = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(list) ? list : null
  } catch {
    return null
  }
}

/** 写族共享 known_facts（全量替换）。 */
export function writeFamilyKnownFacts(familyId, list) {
  try {
    mkdirSync(familiesDir, { recursive: true })
    writeFileSync(familyFileFor(familyId), JSON.stringify(Array.isArray(list) ? list : [], null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}
