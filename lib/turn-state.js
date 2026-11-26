/**
 * 当前状态版本化（2026-11-26）
 *
 * 背景：叙事锚定的「当前状态」（time/world/location/characters/environment/items/focus）
 * 原本只是一份文件里的累积字段。正文被重新生成、或回退到更早的轮次后，这份状态不会跟着
 * 一起回退 —— 场景已经变了，状态还停在后来那一轮，看着就自相矛盾。
 *
 * 机制：宿主插件 API 的按轮存储（saveTurnData / readTurnData）把数据绑定到「正文版本 key」
 * （sha256([chatId, 前缀摘要, index, turn, swipeId, 正文digest])）。宿主从不删除旧 key 的记录，
 * 而读取时只认「key 仍等于该轮此刻的正文版本」的那条 —— 于是：
 *   · 重新生成某轮 → 该轮 key 变 → 旧记录自动不可见；
 *   · 回退到更早轮次 → 后面轮次的 key 失效 → 自动不可见，被保留轮次的 key 不变 → 记录仍匹配。
 * 即「读取时按 key 过滤」天然实现了版本回退，不需要宿主额外通知。
 *
 * 范围：只处理 current_state。STM / LTM / known_facts / 自由栏位一律不动，继续走自持文件。
 *
 * 文档：docs/当前状态版本化方案.md
 */

/** 轮次存储里放当前状态用的键名（宿主按 owner+turn+key 存，读时按 key 过滤）。 */
const TURN_DATA_KEY = 'current-state'

/** 空当前状态（字段与 loadAnchor 的默认值一致）。 */
export function emptyCurrentState() {
  return { time: '', world: '', location: '', characters: [], environment: [], items: [], focus: '', focus_full: '' }
}

/**
 * 取某局「此刻生效」的当前状态。
 *
 * 优先轮次存储（能精确回退到最近一个仍有效的版本），没有记录时回退到自持文件。
 * readTurnData 会静默降级（请求第 4 轮可能返回第 3 轮的数据）——这正是要的回退语义。
 *
 * @param {object} tavern  插件 API（需具备 readTurnData）
 * @param {string} gameId  前台 sessionId（宿主 API 的 gameId）
 * @param {number} turn    前台故事轮号
 * @param {object} fileAnchor 自持文件锚点（回退用）
 * @returns {Promise<{current_state: object, source: 'turn'|'file', turn: number|null}>}
 */
export async function resolveCurrentState(tavern, gameId, turn, fileAnchor) {
  const fallback = (fileAnchor && fileAnchor.current_state) || emptyCurrentState()
  const at = Number(turn)
  if (!tavern || typeof tavern.readTurnData !== 'function' || !gameId || !Number.isFinite(at) || at <= 0) {
    return { current_state: fallback, source: 'file', turn: null }
  }
  try {
    const record = await tavern.readTurnData({ gameId: String(gameId), turn: at })
    const stored = record && record.data && record.data[TURN_DATA_KEY]
    if (stored && typeof stored === 'object') {
      return { current_state: { ...emptyCurrentState(), ...stored }, source: 'turn', turn: Number(record.turn) || null }
    }
  } catch (error) {
    // 读失败不阻断任何功能：回退到文件即可。
    if (typeof console !== 'undefined') console.warn('[narrative-anchor] 读取轮次当前状态失败，回退文件：', error && error.message || error)
  }
  return { current_state: fallback, source: 'file', turn: null }
}

/**
 * 结算落库后，把本轮当前状态写进轮次存储。
 *
 * textVersion 必须传：结算是长任务，期间正文可能被重新生成；不传会把状态写到即将失效的
 * 旧 key 上（那份数据立刻变成不可读的死数据）。写入失败（版本已变 / 轮次不存在）一律不
 * 阻断结算 —— 锚点文件已经落库，轮次存储只是额外的回退能力。
 *
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function saveTurnCurrentState(tavern, gameId, turn, textVersion, currentState) {
  if (!tavern || typeof tavern.saveTurnData !== 'function') return false
  const at = Number(turn)
  if (!gameId || !Number.isFinite(at) || at <= 0) return false
  if (!currentState || typeof currentState !== 'object') return false
  try {
    await tavern.saveTurnData({
      gameId: String(gameId),
      turn: at,
      ...(textVersion ? { textVersion: String(textVersion) } : {}),
      data: { [TURN_DATA_KEY]: { ...emptyCurrentState(), ...currentState } }
    })
    return true
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[narrative-anchor] 写入轮次当前状态失败（不影响锚点落库）：', error && error.message || error)
    return false
  }
}

/**
 * 取某局某轮的正文版本 key（宿主 API 的 textVersion）。
 * 拿不到时返回 null —— 写轮次存储时不传 textVersion 会退化到「写入时刻」的 key。
 */
export async function turnTextVersion(tavern, gameId, turn) {
  if (!tavern || typeof tavern.getTurn !== 'function') return null
  const at = Number(turn)
  if (!gameId || !Number.isFinite(at) || at <= 0) return null
  try {
    const material = await tavern.getTurn({ gameId: String(gameId), turn: at })
    return material && material.textVersion ? String(material.textVersion) : null
  } catch {
    return null
  }
}

/**
 * 从自持文件锚点里取当前状态（同步，供不能 await 的老路径使用）。
 */
export function currentStateOf(fileAnchor) {
  if (fileAnchor && fileAnchor.current_state && typeof fileAnchor.current_state === 'object') {
    return { ...emptyCurrentState(), ...fileAnchor.current_state }
  }
  return emptyCurrentState()
}
