/**
 * 世界书组合（v0.7.18 · 会话世界书）
 *
 * 组合是"跨会话复用"的绑定集合：一组世界书来源
 *   [{ kind:'embedded', cardPath:'cards/x.json' } | { kind:'standalone', path:'worldbooks/y.json' }]
 * 可在任意会话一键应用（写入该会话 session-worldbook.boundBooks）。
 *
 * 持久化：<插件目录>/data/worldbook-combos.json
 *   { combos: [{ id, name, books:[...], createdAt, updatedAt }] }
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const combosFile = join(here, '..', 'data', 'worldbook-combos.json')

function ensureFile() {
  try {
    mkdirSync(dirname(combosFile), { recursive: true })
    if (!existsSync(combosFile)) writeFileSync(combosFile, JSON.stringify({ combos: [] }, null, 2), 'utf-8')
  } catch { /* 忽略 */ }
}

export function listCombos() {
  try {
    ensureFile()
    const data = JSON.parse(readFileSync(combosFile, 'utf-8'))
    return Array.isArray(data?.combos) ? data.combos : []
  } catch {
    return []
  }
}

function writeCombos(combos) {
  try {
    ensureFile()
    // v0.9.15：同文件还保存全局自动绑定清单，写回时保留原值
    let globalAutoBind = []
    try { globalAutoBind = JSON.parse(readFileSync(combosFile, 'utf-8'))?.globalAutoBind || [] } catch { }
    writeFileSync(combosFile, JSON.stringify({ combos, globalAutoBind }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

// ── v0.9.15：全局自动绑定 ──
// 标记为"全局自动绑定"的世界书来源，在新会话/分支会话首次物化会话世界书时
// 自动写入该会话的 boundBooks（见 session-worldbook.js seedGlobalAutoBind）。
function normalizeSources(books) {
  return (Array.isArray(books) ? books : []).map(source => {
    if (source?.kind === 'embedded') return { kind: 'embedded', cardPath: String(source.cardPath || '') }
    return { kind: 'standalone', path: String(source?.path || '') }
  }).filter(s => (s.kind === 'embedded' && s.cardPath) || (s.kind === 'standalone' && s.path))
}

export function listGlobalAutoBind() {
  try {
    ensureFile()
    const data = JSON.parse(readFileSync(combosFile, 'utf-8'))
    return Array.isArray(data?.globalAutoBind) ? data.globalAutoBind : []
  } catch {
    return []
  }
}

function writeGlobalAutoBind(books) {
  try {
    ensureFile()
    const combos = listCombos()
    writeFileSync(combosFile, JSON.stringify({ combos, globalAutoBind: books }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 全量设置全局自动绑定清单（每个条目带 ts=设为全局的时间，用于覆盖更早的会话解除记录）。 */
export function setGlobalAutoBind(books) {
  const normalized = normalizeSources(books).map(s => ({ ...s, ts: Date.now() }))
  writeGlobalAutoBind(normalized)
  return normalized
}

/** 切换单本世界书的全局自动绑定标记（加入时盖新 ts），返回更新后的清单。 */
export function toggleGlobalAutoBind(source) {
  const [norm] = normalizeSources([source])
  if (!norm) throw new Error('无效的世界书来源')
  const current = listGlobalAutoBind()
  const key = JSON.stringify(norm)
  const has = current.some(s => JSON.stringify(normalizeSources([s])[0]) === key)
  const next = has
    ? current.filter(s => JSON.stringify(normalizeSources([s])[0]) !== key)
    : [...current, { ...norm, ts: Date.now() }]
  writeGlobalAutoBind(next)
  return next
}

export function createCombo(name, books) {
  const n = String(name || '').trim()
  if (!n) throw new Error('组合名不能为空')
  if (!Array.isArray(books) || books.length === 0) throw new Error('组合至少需要一本世界书')
  const normalized = books.map(source => {
    if (source?.kind === 'embedded') return { kind: 'embedded', cardPath: String(source.cardPath || '') }
    return { kind: 'standalone', path: String(source?.path || '') }
  })
  if (normalized.some(s => (s.kind === 'embedded' && !s.cardPath) || (s.kind === 'standalone' && !s.path))) {
    throw new Error('组合中包含无效的世界书来源')
  }
  const combos = listCombos()
  const combo = {
    id: 'combo-' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
    name: n,
    books: normalized,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  combos.push(combo)
  writeCombos(combos)
  return combo
}

export function updateCombo(id, patch = {}) {
  const combos = listCombos()
  const combo = combos.find(c => c.id === id)
  if (!combo) throw new Error('组合不存在: ' + id)
  if (typeof patch.name === 'string' && patch.name.trim() !== '') combo.name = patch.name.trim()
  if (Array.isArray(patch.books)) {
    combo.books = patch.books.map(source =>
      source?.kind === 'embedded'
        ? { kind: 'embedded', cardPath: String(source.cardPath || '') }
        : { kind: 'standalone', path: String(source?.path || '') })
    if (combo.books.some(s => (s.kind === 'embedded' && !s.cardPath) || (s.kind === 'standalone' && !s.path))) {
      throw new Error('组合中包含无效的世界书来源')
    }
  }
  combo.updatedAt = Date.now()
  writeCombos(combos)
  return combo
}

export function deleteCombo(id) {
  const combos = listCombos()
  const next = combos.filter(c => c.id !== id)
  if (next.length === combos.length) throw new Error('组合不存在: ' + id)
  writeCombos(next)
  return { ok: true, id }
}
