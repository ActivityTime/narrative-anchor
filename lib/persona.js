/**
 * Persona —— 玩家角色档案库（v0.9.30 重构）
 *
 * 档案 = 玩家称呼（≤80 字，经官方 setPlayerName 进 {{user}} 宏）
 *      + 人设描述（不限长，落会话世界书 constant 常驻条目，由 injectConstantWbEntriesToPrefix 注入前缀）。
 *
 * 存储：
 *   - 档案库（全局）：<插件目录>/data/personas.json
 *   - 应用痕迹：会话世界书 book.personaId + 条目 anchorRef:{kind:'persona', id}
 *
 * v0.9.30：移除独立的 injectMaskToPrefix projection；Persona 条目以 constant=true 常驻条目
 * 身份由 injectConstantWbEntriesToPrefix 统一注入。切换/取消时删除对应条目。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSessionWorldbook, writeSessionWorldbook } from './session-worldbook.js'

const here = dirname(fileURLToPath(import.meta.url))
const personasFile = join(here, '..', 'data', 'personas.json')
const legacyMasksFile = join(here, '..', 'data', 'persona-masks.json')

function ensureDir() {
  try { mkdirSync(join(here, '..', 'data'), { recursive: true }) } catch { /* 忽略 */ }
}

export function loadPersonas() {
  try {
    const parsed = JSON.parse(readFileSync(personasFile, 'utf-8'))
    return Array.isArray(parsed?.personas) ? parsed : { personas: [] }
  } catch {
    // 向后兼容：迁移旧 persona-masks.json
    try {
      const legacy = JSON.parse(readFileSync(legacyMasksFile, 'utf-8'))
      if (Array.isArray(legacy?.masks)) {
        const store = { personas: legacy.masks }
        writePersonas(store)
        return store
      }
    } catch { /* 无旧文件 */ }
    return { personas: [] }
  }
}

function writePersonas(store) {
  ensureDir()
  writeFileSync(personasFile, JSON.stringify(store, null, 2), 'utf-8')
  return store
}

/** v0.9.32：关键词规范化——中英文逗号/顿号/分号均分隔，去空白去重。 */
export function normalizeKeywords(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[，,、;；]/)
  const out = []
  for (const k of raw) {
    const t = String(k ?? '').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 组 keys：额外关键词在前端/存储层为字符串或数组；基础词自动去重追加。 */
function buildKeys(base, keywords) {
  const keys = normalizeKeywords(keywords)
  for (const b of base) if (b && !keys.includes(b)) keys.unshift(b)
  return keys
}

export function savePersona({ id, name, description, note, keywords } = {}) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('称呼不能为空')
  const trimmedName = clean.slice(0, 80)
  const store = loadPersonas()
  const now = Date.now()
  let persona = Array.isArray(store.personas) ? store.personas.find(m => m.id === id) : null
  if (persona) {
    persona.name = trimmedName
    persona.description = String(description ?? '')
    persona.note = String(note ?? '')
    persona.keywords = normalizeKeywords(keywords)
    persona.updatedAt = now
  } else {
    persona = { id: randomUUID(), name: trimmedName, description: String(description ?? ''), note: String(note ?? ''), keywords: normalizeKeywords(keywords), createdAt: now, updatedAt: now }
    store.personas = Array.isArray(store.personas) ? store.personas : []
    store.personas.push(persona)
  }
  writePersonas(store)
  return persona
}

export function deletePersona(id) {
  const store = loadPersonas()
  const before = Array.isArray(store.personas) ? store.personas.length : 0
  store.personas = (store.personas || []).filter(m => m.id !== id)
  writePersonas(store)
  return store.personas.length < before
}

/**
 * 应用档案到会话：先清除旧 Persona 条目，再 upsert 新常驻条目 + 记录 book.personaId。
 * 返回 { persona, entryId }。
 */
export function applyPersona(sessionId, personaId) {
  const store = loadPersonas()
  const persona = (store.personas || []).find(m => m.id === personaId)
  if (!persona) throw new Error('Persona 不存在：' + personaId)
  const book = loadSessionWorldbook(sessionId)
  const description = String(persona.description ?? '').trim()
  const title = '【用户人设】' + persona.name
  // v0.9.32：keys = 角色名 + 自动追加 玩家/用户 + 档案关键词（中英文逗号分隔）
  const keys = buildKeys([persona.name, '玩家', '用户'], persona.keywords)
  // v0.9.31：条目正文第一行固定为「用户人设：角色名」，模型可直接读到归属
  const content = '【覆盖任何表示玩家的设定】用户人设：' + persona.name + (description ? '\n' + description : '')
  const now = Date.now()

  // 先清除旧 Persona 条目（切换时删除对应条目；含旧版 persona_mask kind）
  book.entries = (book.entries || []).filter(e => !(e.anchorRef && (e.anchorRef.kind === 'persona' || e.anchorRef.kind === 'persona_mask')))

  // 创建新条目
  const entry = {
    id: 'persona-' + persona.id,
    title,
    keys,
    content,
    enabled: true,
    constant: true,
    source: 'persona',
    anchorRef: { kind: 'persona', id: persona.id },
    createdAt: now,
    updatedAt: now
  }
  book.entries.push(entry)
  book.personaId = persona.id
  writeSessionWorldbook(book)
  return { persona, entryId: entry.id }
}

/** 取消应用：删除 Persona 条目（含旧版 persona_mask）+ 清 book.personaId/book.maskId。 */
export function unapplyPersona(sessionId) {
  const book = loadSessionWorldbook(sessionId)
  book.entries = (book.entries || []).filter(e => !(e.anchorRef && (e.anchorRef.kind === 'persona' || e.anchorRef.kind === 'persona_mask')))
  book.personaId = ''
  book.maskId = '' // 清旧字段
  writeSessionWorldbook(book)
  return true
}

/**
 * v0.9.31：生成「人工非常驻条目」——与会话常驻 Persona 条目以【标题】确定对应关系，
 * 但两者互不联动：常驻条目的应用/切换/取消不创建、不修改、不删除本条目；
 * 本条目 constant=false，走普通召回池（按 keys 判断是否注入），不进常驻前缀注入。
 * 同标题的人工条目已存在时跳过（不修改、不删除，防重复点击堆叠）。
 */
export function createManualEntry(sessionId, personaId) {
  const store = loadPersonas()
  const persona = (store.personas || []).find(m => m.id === personaId)
  if (!persona) throw new Error('Persona 不存在：' + personaId)
  const book = loadSessionWorldbook(sessionId)
  const title = '【角色池】' + persona.name
  const existing = (book.entries || []).find(e =>
    e && e.anchorRef && e.anchorRef.kind === 'persona-manual' && e.anchorRef.id === persona.id)
  if (existing) {
    return { created: false, exists: true, entryId: existing.id, title }
  }
  const description = String(persona.description ?? '').trim()
  const now = Date.now()
  const entry = {
    id: 'persona-manual-' + persona.id,
    title,
    keys: buildKeys([persona.name], persona.keywords),
    content: String(persona.description ?? '').trim(),
    enabled: true,
    constant: false,
    source: 'persona-manual',
    anchorRef: { kind: 'persona-manual', id: persona.id },
    createdAt: now,
    updatedAt: now
  }
  book.entries = book.entries || []
  book.entries.push(entry)
  writeSessionWorldbook(book)
  return { created: true, exists: false, entryId: entry.id, title }
}
