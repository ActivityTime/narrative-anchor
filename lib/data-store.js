/**
 * 叙事锚定 —— 插件自持数据存储（v0.6.6）
 *
 * 锚点数据由本插件在结算时管理并持久化到本地文件，
 * 状态界面 / HTTP API 直接读本文件，零 DSHT 依赖。
 *
 * 存储位置：<插件目录>/data/anchors/<sessionId>.json
 * 生命周期：结算成功后写最新完整锚点；读取按 sessionId 直接查文件。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginDataDir } from './paths.js'

const anchorsDir = join(pluginDataDir(), 'anchors')

function ensureDir() {
  try { mkdirSync(anchorsDir, { recursive: true }) } catch { /* 忽略 */ }
}

function fileFor(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w-]/g, '_')
  return join(anchorsDir, safe + '.json')
}


/** 结算后写入最新完整锚点（增量合并后的权威对象）。
 *  v0.9.19：known_facts 不再族共享——各会话自有；对其他成员的流动改由
 *  syncSidelineEntries 以【支线】世界书条目互注（与 LTM 同机制）。 */
export function writeAnchor(sessionId, anchor) {
  try {
    ensureDir()
    writeFileSync(fileFor(sessionId), JSON.stringify(anchor, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

/** 读取指定会话最新锚点；无文件或解析失败返回 null。 */
export function readAnchor(sessionId) {
  try {
    return JSON.parse(readFileSync(fileFor(sessionId), 'utf-8'))
  } catch {
    return null
  }
}

// ── v0.2.x 全局设置（global.json）──
// 结算提示词（settlePersona / settleTaskPrompt）是**全局共享**配置，不再按会话单独保存
//（用户 2026-10-10 拍板：提示词不应 per-session，设置页拆"会话设置 + 全局设置"两块）。
// 存储：<插件目录>/data/anchors/global.json  →  { settlePersona?, settleTaskPrompt?, updated_at }
const GLOBAL_SETTINGS_FILE = join(anchorsDir, 'global.json')

/** 读取全局设置；无文件/解析失败返回 null。 */
export function readGlobalSettings() {
  try {
    if (!existsSync(GLOBAL_SETTINGS_FILE)) return null
    const parsed = JSON.parse(readFileSync(GLOBAL_SETTINGS_FILE, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 写入全局设置（整体替换对象）；失败返回 false。 */
export function writeGlobalSettings(settings) {
  try {
    ensureDir()
    writeFileSync(GLOBAL_SETTINGS_FILE, JSON.stringify(settings || {}, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

// ── v0.9.30 注入状态（替代记忆快照日志）──
// 世界书注入（worldbookSource）为「记录→下一轮注入」：llm/stream 读当轮请求，
// 现算记忆快照并写入待注入暂存（pending）；worldbookSource 在下一轮读取、注入一次即消费。
// 同一状态文件同时维护 STM 冷却（距上次补注的轮数，满 5 轮后才允许补注）与
// 压缩后强制注入标志（postCompaction，压缩钩子置位，压缩后那一轮直接注入 LTM+STM）。
// 不再按轮冻结/回放快照（无正文绑定、无成对退役）。

function injectionStateFileFor(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w-]/g, '_')
  return join(anchorsDir, 'injection-state-' + safe + '.json')
}

/** 读取注入状态；无文件/解析失败返回默认态。 */
export function readInjectionState(sessionId) {
  const base = { pending: null, stmCooldown: 0, postCompaction: false, updatedAt: 0 }
  try {
    const file = injectionStateFileFor(sessionId)
    if (!existsSync(file)) return { ...base }
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return {
      pending: typeof parsed?.pending === 'string' && parsed.pending.trim() ? parsed.pending : null,
      stmCooldown: Number.isFinite(Number(parsed?.stmCooldown)) ? Math.max(0, Number(parsed.stmCooldown)) : 0,
      postCompaction: parsed?.postCompaction === true,
      updatedAt: parsed?.updatedAt || 0
    }
  } catch {
    return { ...base }
  }
}

/** 写入注入状态（部分合并：只更新 patch 里提供的字段，其余保留原值）。 */
export function writeInjectionState(sessionId, patch = {}) {
  try {
    ensureDir()
    const current = readInjectionState(sessionId)
    const next = {
      pending: Object.hasOwn(patch, 'pending')
        ? (typeof patch.pending === 'string' && patch.pending.trim() ? patch.pending : null)
        : current.pending,
      stmCooldown: Object.hasOwn(patch, 'stmCooldown') && Number.isFinite(Number(patch.stmCooldown))
        ? Math.max(0, Number(patch.stmCooldown))
        : current.stmCooldown,
      postCompaction: Object.hasOwn(patch, 'postCompaction')
        ? patch.postCompaction === true
        : current.postCompaction,
      updatedAt: Date.now()
    }
    writeFileSync(injectionStateFileFor(sessionId), JSON.stringify(next, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}
