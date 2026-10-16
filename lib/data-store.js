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

// ── v0.9.9 记忆快照日志 ──
// 快照消息是请求时投影、不进 chat.messages；为模拟"像正文一样留在历史、随压缩退出"，
// 每轮快照文本持久化到独立日志（snapshots-<sessionId>.json），投影时按轮次回放，
// 某轮正文退出上下文（被压缩）时该轮快照同步停止回放。

function snapshotFileFor(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w-]/g, '_')
  return join(anchorsDir, 'snapshots-' + safe + '.json')
}

/** 读取快照日志（[{ turn, text, ts }]）；无文件或解析失败返回空数组。 */
export function readSnapshotLog(sessionId) {
  try {
    const file = snapshotFileFor(sessionId)
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e === 'object' && Number.isSafeInteger(Number(e.turn))) : []
  } catch {
    return []
  }
}

/** 写入快照日志。 */
export function writeSnapshotLog(sessionId, log) {
  try {
    ensureDir()
    writeFileSync(snapshotFileFor(sessionId), JSON.stringify(log, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}
