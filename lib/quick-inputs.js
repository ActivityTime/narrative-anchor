/**
 * QuickInputs —— 快捷输入模板库（v0.9.37）
 *
 * 模板 = 名称 + 多行内容；全局存储（跨会话共享），供侧边栏一键插入聊天输入框。
 * 存储：<插件目录>/data/quick-inputs.json { items: [{ id, name, content, createdAt, updatedAt }] }
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir } from './paths.js'

const file = join(pluginDataDir(), 'quick-inputs.json')

function ensureDir() {
  try { mkdirSync(pluginDataDir(), { recursive: true }) } catch { /* 忽略 */ }
}

export function loadQuickInputs() {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed?.items) ? parsed : { items: [] }
  } catch { return { items: [] } }
}

function writeStore(store) {
  ensureDir()
  writeFileSync(file, JSON.stringify(store, null, 2), 'utf-8')
  return store
}

export function saveQuickInput({ id, name, content } = {}) {
  const cleanName = String(name || '').trim()
  if (!cleanName) throw new Error('模板名称不能为空')
  const store = loadQuickInputs()
  const now = Date.now()
  let item = Array.isArray(store.items) ? store.items.find(t => t.id === id) : null
  if (item) {
    item.name = cleanName.slice(0, 80)
    item.content = String(content ?? '')
    item.updatedAt = now
  } else {
    item = { id: randomUUID(), name: cleanName.slice(0, 80), content: String(content ?? ''), createdAt: now, updatedAt: now }
    store.items = Array.isArray(store.items) ? store.items : []
    store.items.push(item)
  }
  writeStore(store)
  return item
}

export function deleteQuickInput(id) {
  const store = loadQuickInputs()
  const before = Array.isArray(store.items) ? store.items.length : 0
  store.items = (store.items || []).filter(t => t.id !== id)
  writeStore(store)
  return store.items.length < before
}
