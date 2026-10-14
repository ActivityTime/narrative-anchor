/**
 * 人格面具 —— 玩家角色档案库（v0.9.27）
 *
 * 档案 = 玩家称呼（≤80 字，经官方 setPlayerName 进 {{user}} 宏）
 *      + 人设描述（不限长，落会话世界书 constant 常驻条目，进固定前缀，与官方库常驻同链）。
 *
 * 存储：
 *   - 档案库（全局）：<插件目录>/data/persona-masks.json
 *   - 应用痕迹：会话世界书 book.maskId + 条目 anchorRef:{kind:'persona_mask', id}
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSessionWorldbook, writeSessionWorldbook } from './session-worldbook.js'

const here = dirname(fileURLToPath(import.meta.url))
const masksFile = join(here, '..', 'data', 'persona-masks.json')

function ensureDir() {
  try { mkdirSync(join(here, '..', 'data'), { recursive: true }) } catch { /* 忽略 */ }
}

export function loadMasks() {
  try {
    const parsed = JSON.parse(readFileSync(masksFile, 'utf-8'))
    return Array.isArray(parsed?.masks) ? parsed : { masks: [] }
  } catch {
    return { masks: [] }
  }
}

function writeMasks(store) {
  ensureDir()
  writeFileSync(masksFile, JSON.stringify(store, null, 2), 'utf-8')
  return store
}

export function saveMask({ id, name, description, note } = {}) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('称呼不能为空')
  const trimmedName = clean.slice(0, 80)
  const store = loadMasks()
  const now = Date.now()
  let mask = Array.isArray(store.masks) ? store.masks.find(m => m.id === id) : null
  if (mask) {
    mask.name = trimmedName
    mask.description = String(description ?? '')
    mask.note = String(note ?? '')
    mask.updatedAt = now
  } else {
    mask = { id: randomUUID(), name: trimmedName, description: String(description ?? ''), note: String(note ?? ''), createdAt: now, updatedAt: now }
    store.masks = Array.isArray(store.masks) ? store.masks : []
    store.masks.push(mask)
  }
  writeMasks(store)
  return mask
}

export function deleteMask(id) {
  const store = loadMasks()
  const before = Array.isArray(store.masks) ? store.masks.length : 0
  store.masks = (store.masks || []).filter(m => m.id !== id)
  writeMasks(store)
  return store.masks.length < before
}

/**
 * 应用档案到会话：upsert 会话世界书常驻条目（原位更新，同 id 不重复）+ 记录 book.maskId。
 * 返回 { mask, entryId }。
 */
export function applyMask(sessionId, maskId) {
  const store = loadMasks()
  const mask = (store.masks || []).find(m => m.id === maskId)
  if (!mask) throw new Error('人格面具不存在：' + maskId)
  const book = loadSessionWorldbook(sessionId)
  const description = String(mask.description ?? '').trim()
  const title = '【人格面具】' + mask.name
  const keys = [mask.name, '玩家']
  let entry = (book.entries || []).find(e => e.anchorRef && e.anchorRef.kind === 'persona_mask' && e.anchorRef.id === mask.id)
  const now = Date.now()
  if (entry) {
    entry.title = title
    entry.keys = keys
    entry.content = description
    entry.constant = true
    entry.enabled = true
    entry.updatedAt = now
  } else {
    entry = {
      id: 'persona-mask-' + mask.id,
      title,
      keys,
      content: description,
      enabled: true,
      constant: true,
      source: 'mask',
      anchorRef: { kind: 'persona_mask', id: mask.id },
      createdAt: now,
      updatedAt: now
    }
    book.entries = Array.isArray(book.entries) ? book.entries : []
    book.entries.push(entry)
  }
  book.maskId = mask.id
  writeSessionWorldbook(book)
  return { mask, entryId: entry.id }
}

/** 取消应用（仅清 book.maskId；已物化条目保留，由用户在世界书页自行管理）。 */
export function unapplyMask(sessionId) {
  const book = loadSessionWorldbook(sessionId)
  book.maskId = ''
  writeSessionWorldbook(book)
  return true
}
