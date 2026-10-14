/**
 * rewind-surface — 会话层每轮历史清空（复刻 DSHT 官方 rewindBackgroundSurface 语义）
 *
 * 官方实现参照（只读，不 import——Tavern 内部模块非接口，随版本变）：
 *   tavern-plugin/lib/domain/background-surface.js      rewindBackgroundSurface
 *   tavern-plugin/lib/domain/session-surface-mutations.js replaceSessionSurface
 *   tavern-plugin/lib/domain/session-events.js          appendSessionEvent / sessionEvents
 * 这些实现的底层全部是 DSH Session 原生 API（session.append / snapshotEvents / events /
 * surface.nodes / header.version），因此 NA 可以独立复刻，不依赖任何官方内部模块。
 *
 * 语义（与官方 rewindTo:-1 一致）：
 *   surface 上「非 fixed」节点（上一轮任务消息 / 工具往返 / 结算输出）被替换为
 *   空 assistant 消息（墓碑）；fixed（system/message + tavern-session-prefix: 前缀）保留。
 *   效果：模型上下文 = 保留的系统前缀 + 本轮任务 + 本轮工具往返 —— 每轮天然无历史，
 *   无需 llm/stream 后处理裁剪（用户 2026-10-10 拍板：会话自身层面解决，不走请求出口裁剪）。
 *
 * 幂等：同一批 sourceEventSeqs 的替换已存在时不重复追加——settle 失败重试 / 重复调用
 * 不会堆叠墓碑。
 */

import { randomUUID } from 'node:crypto'

/** 读取会话事件（DSH 原生：snapshotEvents 优先，回退 events 数组）。 */
function sessionEventsOf(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session.events) ? session.events : []
}

/** V3 会话：assistant/message 缺 stream 时补空数组（与官方 sessionEventData 一致）。 */
function normalizedData(session, type, data) {
  return Number(session?.header?.version) >= 3 && type === 'assistant/message' && data.stream === undefined
    ? { ...data, stream: [] }
    : data
}

/** V3 会话：surfaceOp 的 start/end 规范化为 startSeq/endSeq（与官方 appendSessionEvent 一致）。 */
function normalizedIntent(session, intent) {
  if (Number(session?.header?.version) < 3 || !intent) return intent
  const next = { ...intent }
  const op = next.surfaceOp
  if (op && typeof op === 'object' && op.op === 'replace' && 'start' in op) {
    next.surfaceOp = { op: 'replace', startSeq: op.start, endSeq: op.end }
  }
  return next
}

/**
 * 把 surface [start..end] 区间替换为空 assistant 消息。
 * @returns {boolean} 是否实际追加（幂等跳过时 false）
 */
function replaceRange(session, data, { start, end, sourceEventSeqs }) {
  const events = sessionEventsOf(session)
  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
  const startIndex = nodes.at(-1) === start ? nodes.length - 1 : nodes.indexOf(start)
  const endIndex = start === end ? startIndex : nodes.indexOf(end)
  if (startIndex < 0 || endIndex < startIndex) return false
  // 幂等：已存在覆盖同一 sourceEventSeqs 的替换则跳过（官方 replaceSessionSurface 同思路）
  const referenced = new Set(Array.isArray(sourceEventSeqs) ? sourceEventSeqs : [])
  if (referenced.size > 0) {
    for (const event of events) {
      if (event?.type === 'assistant/message' && event.surfaceOp?.op === 'replace' &&
          Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.length === referenced.size &&
          event.sourceEventSeqs.every(seq => referenced.has(seq))) return false
    }
  }
  session.append('assistant/message', normalizedData(session, 'assistant/message', data),
    normalizedIntent(session, { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs }))
  return true
}

/**
 * 每轮结算前调用：清空常驻结算子会话 surface 的非 fixed 历史（rewindTo:-1 语义）。
 * @param {object} session DSH handle.agent.session（ensureResident 返回的 resident.agent.session）
 * @returns {number} 被遮蔽（替换为墓碑）的节点数；0 = 无可遮蔽历史或会话不可用
 */
export function rewindResidentSurface(session) {
  if (!session || !Array.isArray(session.surface?.nodes)) return 0
  const events = sessionEventsOf(session)
  const bySeq = new Map(events.map(event => [event.seq, event]))
  const nodes = session.surface.nodes
  // 分组：fixed（system/message 或 tavern-session-prefix: 前缀消息）或 seq<=boundary(-1) → 保留；
  // 其余连续非 fixed 节点成组，整组替换为墓碑（与官方 rewindBackgroundSurface 完全一致）。
  const groups = []
  let group = null
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    const id = event?.data?.message?.id || event?.data?.id || ''
    const fixed = event?.type === 'system/message' || String(id).startsWith('tavern-session-prefix:')
    if (fixed || !Number.isSafeInteger(seq) || seq <= -1) { group = null; continue }
    if (group === null) { group = []; groups.push(group) }
    group.push(seq)
  }
  if (groups.length === 0) return 0
  // 墓碑的来源与轮次：优先取最后一个模型回复的来源/轮次（官方同逻辑）；
  // 首次请求失败尚无模型回复时用 NA 自持的投影来源（与 tavern reply-projection 定位一致）。
  let source = null
  let turn = 0
  let step = 1
  for (let index = nodes.length - 1; index >= 0; index--) {
    const event = bySeq.get(nodes[index])
    const candidate = event?.data?.message?.source
    if (event?.type === 'assistant/message' && candidate?.kind === 'model') {
      source = candidate
      turn = Math.max(0, Number(event.data.turn) || 0)
      step = Math.max(1, Number(event.data.step) || 1)
      break
    }
  }
  if (source === null) {
    source = { kind: 'model', provider: 'narrative-anchor', model: 'rewind-projection' }
    turn = 1
    for (const group of groups) for (const seq of group) {
      turn = Math.max(turn, Number(bySeq.get(seq)?.data?.turn) || 0)
    }
  }
  for (const shadowed of groups) {
    replaceRange(session, {
      turn, step,
      message: { id: randomUUID(), role: 'assistant', content: [], source }
    }, { start: shadowed[0], end: shadowed[shadowed.length - 1], sourceEventSeqs: shadowed })
  }
  return groups.reduce((count, group) => count + group.length, 0)
}
