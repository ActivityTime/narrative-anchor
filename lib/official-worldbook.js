/**
 * 官方世界书读取 + 召回审计读取（v0.7.2）
 *
 * 非侵入式：直接读 DSH-Tavern 用户数据文件（卡工作副本 / 世界书文件 / 召回审计目录），
 * 不经过 DSHT 插件任何代码。数据根目录通过 import.meta.url 上溯推导（junction 保留时
 * 为 profile\node_modules 路径；真实路径开发目录亦可回退探测）。
 */
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { resolveTavernDataRoot as resolveRoot, setTavernDataRoot } from './paths.js'

/** DSH-Tavern 用户数据根目录（…/harness/profile-data/tavern/data）。
 *  转发到 paths.js —— 它是全插件唯一的路径真相源，保留本签名仅为兼容历史调用点。
 *
 *  历史实现的问题（已废弃）：从 import.meta.url 与 process.cwd 向上盲猜 14 层。
 *  junction 加载时 import.meta.url 会落到开发目录 → 向上必然找不到 → 只能靠 cwd 兜底；
 *  而 cwd 又随启动方式变化。这正是"开发版和发布版行为不一致"的根因。
 *  现在改由 paths.js 按 DSHT 目录结构正向发现，两种环境解析结果一致。 */
export function resolveTavernDataRoot(_fromUrl, extraCandidates = []) {
  for (const candidate of Array.isArray(extraCandidates) ? extraCandidates : []) {
    if (candidate) setTavernDataRoot(candidate)
  }
  return resolveRoot()
}

function tryReadJson(path) {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch { return null }
}

/** 读快照文件：DSHT v2.3.0 起快照为 .json.gz（DEVELOPMENT_PITFALLS 经验1.1），兼容旧 .json。
 *  不适配的后果：readdir 按 /\.json$/ 过滤匹配不到 .gz → chat 拿不到 cardPath → 官方世界书整页为空。 */
function readSnapshotJson(path) {
  try {
    if (/\.gz$/i.test(path)) return JSON.parse(gunzipSync(readFileSync(path)))
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch { return null }
}


/** 非侵入：从磁盘读取 chat（sessions.json 映射 sessionId→chatId + 最新快照）。
 *  options.includeMessages=true 时，block DAG 格式会额外解码全部消息（较慢，仅投影替换需要）。 */
export function readChatFromDisk(dataRoot, sessionId, options = {}) {
  if (!dataRoot || !sessionId) return null
  try {
    const map = JSON.parse(readFileSync(join(dataRoot, 'sessions.json'), 'utf-8'))
    const chatId = map[sessionId]
    if (!chatId) return null
    const snapDir = join(dataRoot, 'chats', chatId, 'snapshots')
    if (!existsSync(snapDir)) {
      // v0.9.19：block DAG 存储回退（无 snapshots/ 目录的新格式）
      const dag = readBlockDAGChatInfo(dataRoot, chatId, options)
      return Object.assign({ id: chatId }, dag || {})
    }
    // 快照文件名按序号递增，必须倒序取最新（升序会拿到最初 1 条消息的快照 → turn 误算为 1）
    const files = readdirSync(snapDir).filter(f => /\.json(\.gz)?$/i.test(f)).sort().reverse()
    for (const file of files) {
      const snap = readSnapshotJson(join(snapDir, file))
      if (snap?.cardPath || snap?.id) return Object.assign({ id: chatId }, snap)
    }
    return { id: chatId }
  } catch { return null }
}

/** v0.9.19：从 block-based Merkle DAG 读取 chat 元信息（cardName / cardPath）。
 *  路径：head.json → headId → head block → stateId → state block → worldRef → record-pack → cardName。
 *  新格式会话（无 snapshots/ 目录）用此函数回退。
 *  注：v0.9.27b 评估过在此提取 macroState.userName——chatHeader records 是嵌套
 *  record-pack/branches 图，遍历代价高且无环保护，放弃；当前称呼改由 mask/list
 *  端点优先读内存活跃会话（getChatFromSession）。 */
function readBlockDAGChatInfo(dataRoot, chatId, options = {}) {
  if (!dataRoot || !chatId) return null
  try {
    const headFile = join(dataRoot, 'chats', chatId, 'head.json')
    if (!existsSync(headFile)) return null
    const head = JSON.parse(readFileSync(headFile, 'utf-8'))
    const headId = head.headId
    if (!headId) return null
    // v3.0.2：format:2 的 headId 指向 block-pack-v1 页索引块，其内部 record 以各自的
    // content hash 为键，tryReadBlock 按 entry[0]===hash 匹配会落空 → 返回 null，导致
    // readChatFromDisk 对 format:2 永远拿不到消息（STM 投影走 "no messages after reread"
    // 直接 return）。改用 findRecordByKind 按 kind 取 'head' record；format:1 仍回退 tryReadBlock。
    const headWrapper = findRecordByKind(dataRoot, chatId, headId, 'head')
    const headBlock = headWrapper && headWrapper.kind === 'record' ? headWrapper.value : headWrapper
    if (!headBlock) {
      const fb = tryReadBlock(dataRoot, chatId, headId)
      if (!fb) return null
      headBlock = fb
    }
    const info = {}
    // v0.9.28：仅在显式请求时解码全部消息（同步读多文件，较慢）
    if (options.includeMessages) {
      const messages = readBlockDAGMessages(dataRoot, chatId, headBlock)
      if (messages.length > 0) info.messages = messages
    }
    // 提取 cardName / cardPath（可选，某些会话可能没有）
    const stateId = headBlock.stateId
    if (stateId) {
      const stateBlock = tryReadBlock(dataRoot, chatId, stateId)
      const worldRef = stateBlock?.worldRef || stateBlock?.value?.worldRef
      if (worldRef) {
        const wbBlock = tryReadBlock(dataRoot, chatId, worldRef)
        if (wbBlock?.kind === 'record-pack-v1' && Array.isArray(wbBlock.records)) {
          for (const [, val] of wbBlock.records) {
            if (val?.type === 'bucket' && Array.isArray(val.items)) {
              for (const [key, item] of val.items) {
                if (key === 'cardName' && item?.value) info.cardName = String(item.value)
                if (key === 'cardPath' && item?.value) info.cardPath = String(item.value)
              }
            }
          }
        }
      }
    }
    return Object.keys(info).length > 0 ? info : null
  } catch { return null }
  }

/** v3.0.2：读取 chat 的**当前** backgroundModelSelection（覆盖两种存储格式）。
 *
 *  ## 为什么不能用 readChatFromDisk
 *  官方后台读的是 materialize() 的结果，永远是最新；
 *  而 readChatFromDisk 只取最后一个 snapshot 文件。snapshot 不是每轮写入，
 *  用户改完配置时快照仍是旧值 → 插件侧读到过期值。
 *
 *  ## 实测确认（DSHT profile-data/tavern/data/chats/<chatId>/）
 *  真实数据里两种格式并存，缺一即返回 null：
 *  A) journal 格式 —— 目录含 snapshots/ + journals/。快照基线（含 _storageRevision）
 *     + journals/<12位>-open.jsonl 帧重放（revision > 基线且 path 为该字段）。
 *  B) block DAG 格式 —— 目录只有 blocks/ + head.json，分两代：
 *     B1) head.json 无 format 或 format:1 —— headId 即 head block，含 stateId；
 *     B2) head.json format:2 —— headId 指向**页索引块**（block-pack-v1），
 *         其中含 kind:'state' 的 record；head.json 的 format 与 head block 的
 *         format 是两回事，不可混用。
 *  block 三种封装与字段树展开见 tryReadBlock / readBlockDAGTopLevelField 注释。
 *
 *  ## 与官方语义一致性
 *  - normalizeBackgroundModel（trim + 丢空 effort）在此内联，与官方逐字段一致；
 *  - configuredChatBackgroundModel 的全局 revision 覆盖分支需 settings 参数，
 *    而官方 deps.backgroundModel 调用 resolveChatBackgroundModel 时未传 settings
 *    （index.js:583 仅两参），该分支在当前运行时本就不生效，此处不实现。
 */
export function readCurrentBackgroundModelSelection(dataRoot, sessionId) {
  if (!dataRoot || !sessionId) return null
  try {
    const map = JSON.parse(readFileSync(join(dataRoot, 'sessions.json'), 'utf-8'))
    const chatId = map[sessionId]
    if (!chatId) return null
    const root = join(dataRoot, 'chats', chatId)
    if (!existsSync(root)) return null

    let raw = null
    if (existsSync(join(root, 'blocks'))) {
      raw = readBlockDagSelection(dataRoot, chatId)
    } else if (existsSync(join(root, 'snapshots'))) {
      raw = readJournalSelection(root)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    // 归一化：与官方 normalizeBackgroundModel 逐字段一致
    const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    if (provider === '' || model === '') return null
    const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
    return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
  } catch { return null }
  }

/** block DAG 格式取值：head → state.chatHeaderRef → 字段树。
 *  head.json format:2 时 headId 是页索引块，需先从其中取出 kind:'state' 的 record。 */
function readBlockDagSelection(dataRoot, chatId) {
  const head = tryReadJson(join(dataRoot, 'chats', chatId, 'head.json'))
  const headId = head?.headId
  if (!headId) return null

  let headerRef = null
  const headBlock = tryReadBlock(dataRoot, chatId, headId)
  if (headBlock?.kind === 'head' && headBlock.stateId) {
    // format:1 —— headId 即 head block
    const stateBlock = tryReadBlock(dataRoot, chatId, headBlock.stateId)
    headerRef = stateBlock?.value?.chatHeaderRef || null
  } else {
    // format:2 —— headId 是页索引块（block-pack-v1），state record 在其中
    const stateRecord = findRecordByKind(dataRoot, chatId, headId, 'state')
    headerRef = stateRecord?.value?.chatHeaderRef || null
  }
  if (!headerRef) return null
  return selectionFromHeaderRef(dataRoot, chatId, headerRef)
  }

/** 在 block-pack-v1 索引块内按 kind 找 record（用于 format:2 定位 state）。 */
function findRecordByKind(dataRoot, chatId, packHash, kind) {
  try {
    const p = join(dataRoot, 'chats', chatId, 'blocks', packHash.slice(0, 2), packHash + '.json')
    if (!existsSync(p)) return null
    const pack = JSON.parse(readFileSync(p, 'utf-8'))
    if (!pack || !Array.isArray(pack.records)) return null
    for (const entry of pack.records) {
      if (Array.isArray(entry) && entry[1]?.kind === kind) return entry[1]
    }
    return null
  } catch { return null }
  }

/** 从 chatHeaderRef 展开字段树，取 backgroundModelSelection 的三个字段。
 *  实测：backgroundModelSelection 是 {type:'object', entries:<ref>}，
 *  provider / model / reasoningEffort 各占一项，值形如 {value:'low'}。 */
function selectionFromHeaderRef(dataRoot, chatId, headerRef) {
  const header = tryReadBlock(dataRoot, chatId, headerRef)
  if (!header || header.type !== 'object' || !header.entries) return null
  const cell = readBlockDAGTopLevelField(dataRoot, chatId, header.entries, 'backgroundModelSelection')
  if (!cell || typeof cell !== 'object') return null
  // 内联对象（少见）：直接取
  if (cell.value && typeof cell.value === 'object') return cell.value
  if (typeof cell.ref !== 'string') return null
  const target = tryReadBlock(dataRoot, chatId, cell.ref)
  if (!target || target.type !== 'object' || !target.entries) return null
  return {
    provider: pickFieldValue(dataRoot, chatId, target.entries, 'provider'),
    model: pickFieldValue(dataRoot, chatId, target.entries, 'model'),
    reasoningEffort: pickFieldValue(dataRoot, chatId, target.entries, 'reasoningEffort')
  }
  }

/** 读字段单元的内联值：{value:x} → x；缺失 → null。 */
function pickFieldValue(dataRoot, chatId, entriesRef, name) {
  const cell = readBlockDAGTopLevelField(dataRoot, chatId, entriesRef, name)
  if (cell === undefined || cell === null) return null
  if (typeof cell === 'object' && 'value' in cell) return cell.value
  return cell
  }

/** journal 格式取值：快照基线 + journal 帧重放（只关心 backgroundModelSelection）。
 *  官方常量：JOURNAL_PATTERN = /^(\d{12})-(open|(\d{12}))\.jsonl$/，STORAGE_REVISION='_storageRevision'。
 *  change op 语义见 domain/json-mutation.js：顶层标量为 set/delete。 */
function readJournalSelection(root) {
  const snapDir = join(root, 'snapshots')
  let baseline = null
  let baseRevision = 0
  if (existsSync(snapDir)) {
    const files = readdirSync(snapDir).filter(f => /\.json(\.gz)?$/i.test(f)).sort().reverse()
    for (const file of files) {
      const snap = readSnapshotJson(join(snapDir, file))
      if (snap?.id) {
        baseline = snap
        const rev = Number(snap._storageRevision)
        if (Number.isSafeInteger(rev)) baseRevision = rev
        break
      }
    }
  }
  let current = baseline?.backgroundModelSelection ?? null
  const journalsDir = join(root, 'journals')
  if (existsSync(journalsDir)) {
    const rows = readdirSync(journalsDir)
      .map((name) => {
        const m = /^(\d{12})-(?:open|(\d{12}))\.jsonl$/i.exec(name)
        return m ? { start: Number(m[1]), path: join(journalsDir, name) } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.start - b.start)
    for (const row of rows) {
      let text
      try { text = readFileSync(row.path, 'utf-8') } catch { continue }
      for (const line of text.split('\n')) {
        if (line === '') continue
        let frame
        try { frame = JSON.parse(line) } catch { break }
        const revision = Number(frame?.revision)
        if (!Number.isSafeInteger(revision) || revision <= baseRevision) continue
        if (!Array.isArray(frame.changes)) break
        for (const change of frame.changes) {
          const parts = Array.isArray(change?.path) ? change.path : []
          if (parts.length !== 1 || parts[0] !== 'backgroundModelSelection') continue
          current = change.op === 'set' ? (change.value ?? null) : null
        }
      }
    }
  }
  return current
  }

/** 读单个 block 文件：chats/<chatId>/blocks/<hash前2位>/<hash>.json
 *
 *  v3.0.2：实测数据里 block 有三种封装，全部在此统一解包（否则 v2 布局读不到）：
 *  - standalone：文件内容即值本身；
 *  - record-pack-v1：{kind,records:[[ref,value]]}，取 ref 匹配项的 value；
 *  - block-pack-v1：{kind,records:[[ref,{kind:'record',value}]]}，取 record.value。
 *  head.json 的 format（1/2）与 block 自身 kind 是两回事，不可混用。
 */
function tryReadBlock(dataRoot, chatId, hash, depth = 0) {
  if (!hash || typeof hash !== 'string' || depth > 6) return null
  try {
    const p = join(dataRoot, 'chats', chatId, 'blocks', hash.slice(0, 2), hash + '.json')
    if (!existsSync(p)) return null
    const value = JSON.parse(readFileSync(p, 'utf-8'))
    if (!value || typeof value !== 'object') return value
    const kind = value.kind
    if (kind === 'record-pack-v1' && Array.isArray(value.records)) {
      for (const entry of value.records) {
        if (Array.isArray(entry) && entry[0] === hash) return entry[1]
      }
      return null
    }
    if (kind === 'block-pack-v1' && Array.isArray(value.records)) {
      for (const entry of value.records) {
        if (Array.isArray(entry) && entry[0] === hash) return entry[1]?.value
      }
      return null
    }
    return value
  } catch { return null }
  }

/** v3.0.2：展开 object.entries 的 branches 分层结构，取指定顶层字段的最终值。
 *
 *  实测结构：chatHeaderRef → {type:'object', entries:<ref>}，
 *  entries 是 {type:'branches', children:{序号:ref}} 或 {type:'bucket', items:[[key, item]]}。
 *  branches 必须按序号数值升序递归展开，后出现的层覆盖先出现的层，才等于最终字段值。
 *  bucket.items 的元素是三元组 [key, item, order]（官方写入格式），取前两个即可。
 *  item 形如 {value: x}（内联）或 {ref: <hash>}（另存 block，需解引用）。
 */
function readBlockDAGTopLevelField(dataRoot, chatId, entriesRef, field, depth = 0) {
  if (!entriesRef || depth > 14) return null
  const node = tryReadBlock(dataRoot, chatId, entriesRef)
  if (!node || typeof node !== 'object') return null
  if (node.type === 'branches' && node.children && typeof node.children === 'object') {
    let found = null
    for (const key of Object.keys(node.children).sort((a, b) => {
      const na = Number(a); const nb = Number(b)
      return (Number.isSafeInteger(na) && Number.isSafeInteger(nb)) ? na - nb : String(a).localeCompare(String(b))
    })) {
      const hit = readBlockDAGTopLevelField(dataRoot, chatId, node.children[key], field, depth + 1)
      if (hit !== undefined) found = hit
    }
    return found
  }
  if (node.type === 'bucket' && Array.isArray(node.items)) {
    for (const item of node.items) {
      if (!Array.isArray(item) || item[0] !== field) continue
      // 单元格形如 {value:x}（内联）或 {ref:<hash>}（另存 block）。
      // ref 场景不在此展开，由调用方按需下钻（selectionFromHeaderRef 会再展开一层 object）。
      return item[1]
    }
    return undefined
  }
  return null
  }

/** v0.9.28：同步读取 block DAG 中的一条 record（处理 standalone block 和 record-pack-v1）。
 *  参考 conversation-page-store.js decodeBlock：文件内容 hash===ref 时为独立 block；
 *  否则为 record-pack-v1，在 records 中找 key===ref 的条目返回其 value。 */
function readDAGRecord(dataRoot, chatId, ref) {
  if (!ref || typeof ref !== 'string' || ref.length < 8) return null
  try {
    const p = join(dataRoot, 'chats', chatId, 'blocks', ref.slice(0, 2), ref + '.json')
    if (!existsSync(p)) return null
    const bytes = readFileSync(p, 'utf-8')
    if (createHash('sha256').update(bytes).digest('hex') === ref) {
      const obj = JSON.parse(bytes)
      return obj?.kind === 'record' ? obj.value : obj
    }
    const pack = JSON.parse(bytes)
    if (pack?.kind === 'record-pack-v1' && Array.isArray(pack.records)) {
      for (const [key, value] of pack.records) {
        if (key === ref) return value
      }
    }
    // v3.0.2：block-pack-v1 封装（format:2 的 index/page/head/state 等 record
    // 均可能存为 block-pack-v1 文件）。readDAGRecord 此前只解 record-pack-v1/standalone，
    // 导致 readBlockDAGMessages 遍历 Merkle 树时读到 null → 消息为 0（"no messages after
    // reread"，STM 投影无法匹配已提交消息）。这里补上 block-pack-v1 解包，与 tryReadBlock 一致。
    if (pack?.kind === 'block-pack-v1' && Array.isArray(pack.records)) {
      for (const entry of pack.records) {
        if (Array.isArray(entry) && entry[0] === ref) {
          const v = entry[1]
          return v && v.kind === 'record' ? v.value : v
        }
      }
    }
    return null
  } catch { return null }
}

/** v0.9.28：同步解码 incremental-json-state 的持久化 JSON 树。
 *  link 格式：{value: <内联标量>} 或 {ref: <record引用>}。
 *  record 类型：scalar（大字符串等）/ object / array（entries 指向 bucket）。
 *  bucket 类型：bucket（≤32 items）/ branches（>32，radix 树）。 */
function decodeDAGJson(dataRoot, chatId, link) {
  if (!link) return undefined
  if (Object.prototype.hasOwnProperty.call(link, 'value')) return link.value
  if (!link.ref) return undefined
  const node = readDAGRecord(dataRoot, chatId, link.ref)
  if (!node) return undefined
  if (node.type === 'scalar') return node.value
  if (node.type === 'object' || node.type === 'array') {
    const result = node.type === 'array' ? [] : {}
    const entries = readDAGBucket(dataRoot, chatId, node.entries)
    entries.sort((a, b) => (a[2] || 0) - (b[2] || 0))
    for (const [key, childLink] of entries) {
      result[key] = decodeDAGJson(dataRoot, chatId, childLink)
    }
    return result
  }
  return undefined
}

/** 读取 bucket（可能是直接 bucket 或 branches radix 树），返回 [[key, childLink, order], ...]。 */
function readDAGBucket(dataRoot, chatId, bucketRef) {
  if (!bucketRef) return []
  const node = readDAGRecord(dataRoot, chatId, bucketRef)
  if (!node) return []
  if (node.type === 'bucket') return node.items || []
  if (node.type === 'branches') {
    const result = []
    for (const childRef of Object.values(node.children || {})) {
      result.push(...readDAGBucket(dataRoot, chatId, childRef))
    }
    return result
  }
  return []
}

/** v0.9.28：从 block DAG 遍历 Merkle 树提取全部消息（含完整正文）。
 *  树结构：head.root → index(children) → ... → page(messages)，PAGE_SIZE=64。
 *  page message 含 runtimeRef（指向 incremental-json record）和 session.message.turn。 */
function readBlockDAGMessages(dataRoot, chatId, headBlock) {
  const messages = []
  function traverse(root, height) {
    if (root === null || root === undefined) return
    if (height === 0) {
      const page = readDAGRecord(dataRoot, chatId, root)
      if (page?.kind === 'page' && Array.isArray(page.messages)) {
        for (const msgRef of page.messages) {
          if (!msgRef?.runtimeRef) continue
          const fullMsg = decodeDAGJson(dataRoot, chatId, { ref: msgRef.runtimeRef })
          if (fullMsg && typeof fullMsg === 'object') {
            if (fullMsg.turn === undefined && msgRef.session?.message?.turn !== undefined) {
              fullMsg.turn = msgRef.session.message.turn
            }
            messages.push(fullMsg)
          }
        }
      }
      return
    }
    const index = readDAGRecord(dataRoot, chatId, root)
    if (index?.kind === 'index' && Array.isArray(index.children)) {
      for (const child of index.children) {
        if (child) traverse(child, height - 1)
      }
    }
  }
  traverse(headBlock.root, headBlock.height || 0)
  return messages
}
/** 按 chat 解析当前卡工作副本路径（resources\cards\<...>.json）。 */
function resolveCardWorkspace(dataRoot, chat) {
  if (!dataRoot) return null
  let cardPath = chat?.cardPath || ''
  // 平台 session.chat 无 DSHT 字段时，从持久化 chat 快照回退读取 cardPath
  if (!cardPath && chat?.id) {
      const snapDir = join(dataRoot, 'chats', chat.id, 'snapshots')
      try {
        for (const file of readdirSync(snapDir).sort()) {
          if (!/\.json(\.gz)?$/i.test(file)) continue
          const snap = readSnapshotJson(join(snapDir, file))
          if (snap?.cardPath) { cardPath = snap.cardPath; break }
        }
      } catch { /* 无快照目录则跳过 */ }
  }
  let name = String(cardPath).split(/[\\/]/).pop().replace(/\.json$/i, '')
  // v0.9.19：block DAG 回退——无 cardPath 时从 DAG 读 cardName 模糊匹配卡文件
  if (!name && chat?.id) {
    const dag = readBlockDAGChatInfo(dataRoot, chat.id)
    if (dag?.cardPath) cardPath = dag.cardPath
    const cardName = dag?.cardName || ''
    if (!name && cardName) {
      const dir = join(dataRoot, 'resources', 'cards')
      try {
        for (const file of readdirSync(dir)) {
          if (!/\.json$/i.test(file)) continue
          const data = tryReadJson(join(dir, file))
          const rawName = data?.raw?.data?.name || data?.raw?.name || data?.name || ''
          if (rawName && String(rawName).includes(cardName.slice(0, 6))) {
            return { path: join(dir, file), workspace: data }
          }
        }
      } catch { /* 目录不可读则跳过 */ }
      return null
    }
  }
  if (!name) return null
  // 直接候选
  for (const candidate of [
    join(dataRoot, 'resources', 'cards', `${name}.json`),
    join(dataRoot, 'resources', 'cards', String(cardPath).replace(/^.*resources[\\/]cards[\\/]/, ''))
  ]) {
    const data = tryReadJson(candidate)
    if (data) return { path: candidate, workspace: data }
  }
  // 目录扫描（卡名可能不含扩展名或带额外字符）
  const dir = join(dataRoot, 'resources', 'cards')
  try {
    for (const file of readdirSync(dir)) {
      if (!/\.json$/i.test(file)) continue
      const data = tryReadJson(join(dir, file))
      const rawName = data?.raw?.data?.name || data?.raw?.name || data?.name
      if (rawName && String(rawName).includes(name)) return { path: join(dir, file), workspace: data }
    }
  } catch { /* 目录不可读则跳过 */ }
  return null
}

/** 读取外部世界书绑定（resources\.worldbook-bindings.json → cardPath → 绑定）。
 *  语义对齐 DSHT file-resources.js worldBookBindingForCard：
 *  - 值为字符串 → 独立世界书资源路径（相对 resources 根，如 worldbooks/xxx.json）
 *  - 值为 {version:2, sources:[...]} → 多绑定，取其中 kind=standalone 的独立书
 *  - 值为 {kind:'embedded', cardPath} / null → 指向卡内嵌，非独立书文件，跳过
 *  世界书文件实际位于 resources\worldbooks\（原实现少了 resources 层导致外部书永远读不到）。 */
function readExternalBindings(dataRoot) {
  const file = join(dataRoot, 'resources', '.worldbook-bindings.json')
  const data = tryReadJson(file)
  if (!data || typeof data !== 'object') return []
  const resourcesRoot = join(dataRoot, 'resources')
  const resolveWb = (wbPath) => resolve(join(resourcesRoot, 'worldbooks'), String(wbPath).replace(/^.*worldbooks[\\/]/i, ''))
  const list = []
  for (const [cardPath, binding] of Object.entries(data)) {
    const sources = []
    if (typeof binding === 'string') sources.push(binding)
    else if (Array.isArray(binding?.sources)) {
      for (const s of binding.sources) if (s?.kind === 'standalone' && s.path) sources.push(s.path)
    } else if (binding && typeof binding === 'object' && binding.path) sources.push(binding.path)
    for (const wbPath of sources) {
      const resolved = resolveWb(wbPath)
      const wb = tryReadJson(resolved) || tryReadJson(String(wbPath))
      if (wb) list.push({ cardPath, path: resolved, worldbook: wb })
    }
  }
  return list
}

/**
 * 条目列表统一化（ref 规则对齐 DSHT worldbook-resource.js inspectWorldBookDocument）：
 * - entries 为数组（卡内嵌 character_book）：ref = entry:<数组下标>
 * - entries 为对象字典 {uid: entry}（SillyTavern 原生独立世界书）：ref = entry:<字典键 uid>，
 *   保持 Object.entries 顺序、不排序，否则与召回审计的 ref 对不上（快照区正文/关键词关联失效）
 */
function readEntries(worldbook) {
  const raw = worldbook?.data || worldbook
  const list = raw?.character_book?.entries || raw?.entries
  if (Array.isArray(list)) {
    return { native: false, records: list.map((entry, index) => ({ entry, ref: `entry:${index}`, index, native: false })) }
  }
  if (list && typeof list === 'object') {
    return { native: true, records: Object.entries(list).map(([key, entry], index) => ({ entry, ref: `entry:${key}`, index, native: true })) }
  }
  return { native: false, records: [] }
}

function normalizeEntry(entry, index, source, record = {}) {
  const native = record.native === true
  const ref = String(record.ref || entry?.ref || `entry:${index}`)
  return {
    ref, index,
    title: String(entry?.title || entry?.comment || entry?.name || `条目 ${index + 1}`),
    // 关键词双格式：卡内嵌用 keys（复数），SillyTavern 原生独立书用 key（单数）
    keys: Array.isArray(entry?.keys) ? entry.keys : Array.isArray(entry?.key) ? entry.key : [],
    content: String(entry?.content || ''),
    // 停用语义双格式：原生书 disable:true = 停用；卡内嵌 enabled:false = 停用
    enabled: native ? entry?.disable !== true : entry?.enabled !== false,
    constant: entry?.constant === true,
    order: Number(entry?.insertion_order ?? entry?.order ?? 100),
    source: source || 'embedded'
  }
}

/**
 * 读取当前会话关联的官方世界书条目（卡内嵌 character_book + 外部绑定文件）。
 * 返回 { card, embedded: [], external: [] }；card 为工作副本信息（可为 null）。
 */
export function readOfficialWorldbooks(dataRoot, chat) {
  const result = { card: null, embedded: [], external: [] }
  if (!dataRoot || !chat) return result
  const resolved = resolveCardWorkspace(dataRoot, chat)
  if (resolved) {
    result.card = {
      name: resolved.workspace?.raw?.data?.name || resolved.workspace?.raw?.name || resolved.workspace?.name || '',
      path: resolved.path
    }
    const raw = resolved.workspace?.raw || resolved.workspace
    result.embedded = readEntries(raw).records.map((rec, i) => normalizeEntry(rec.entry, i, 'embedded', rec))
  }
  for (const binding of readExternalBindings(dataRoot)) {
    if (binding.cardPath !== chat?.cardPath && !String(chat?.cardPath || '').includes(binding.cardPath)) continue
    const book = readEntries(binding.worldbook)
    for (const [i, rec] of book.records.entries()) {
      result.external.push(normalizeEntry(rec.entry, i, `external:${binding.path}`, rec))
    }
  }
  return result
}



/** 写回官方世界书条目（embedded=卡工作副本 / external=外部世界书文件）。
 * patch: { toggle?, enabled?, title?, keys?, content? }；返回 { ok, ref, source, enabled?, filePath? }。
 * DSHT 世界书按需读盘，改文件后下轮筛选自然生效，无需重载。 */
export function updateOfficialEntry(dataRoot, chat, { ref, source, patch = {} } = {}) {
  if (!dataRoot || !chat) return { ok: false, error: '缺少 dataRoot / chat' }
  const refStr = String(ref || '')
  const loc = locateOfficialEntry(dataRoot, chat, source)
  if (!loc) return { ok: false, error: '无法定位条目来源: ' + (source || '?') }
  // ref 直接匹配 DSHT 规则合成的记录（字典书 ref=entry:<uid>，数组书 ref=entry:<下标>），不再解析纯数字下标
  const record = loc.records.find(r => r.ref === refStr)
  if (!record) return { ok: false, error: '条目不存在: ' + refStr }
  const e = record.entry
  if (!e || typeof e !== 'object') return { ok: false, error: '条目无效: ' + refStr }
  const native = loc.native === true
  if (patch.toggle === true) {
    if (native) e.disable = e.disable !== true
    else e.enabled = (e.enabled !== false) ? false : true
  } else {
    if (patch.enabled !== undefined) {
      if (native) e.disable = patch.enabled !== true
      else e.enabled = patch.enabled === true
    }
    // 标题字段兼容：DSH 卡文件条目用 comment，标准 ST 卡用 title；只写条目原有的字段
    if (typeof patch.title === 'string' && patch.title.trim() !== '') {
      const titleField = Object.prototype.hasOwnProperty.call(e, 'comment') ? 'comment' : 'title'
      e[titleField] = patch.title
    }
    // 关键词双格式：原生书写 key（DSHT 召回读取的字段），卡内嵌写 keys
    if (Array.isArray(patch.keys)) {
      if (native) e.key = patch.keys
      else e.keys = patch.keys
    }
    if (typeof patch.content === 'string') e.content = patch.content
  }
  try {
    writeFileSync(loc.filePath, JSON.stringify(loc.container, null, 2), 'utf-8')
  } catch (err) {
    return { ok: false, error: '写入失败: ' + (err?.message || err) }
  }
  return { ok: true, ref, source, enabled: native ? e.disable !== true : e.enabled !== false, filePath: loc.filePath }
}

/** 定位官方条目所在文件（embedded=当前卡工作副本 / external=<绝对路径> 外部世界书 JSON）。 */
function locateOfficialEntry(dataRoot, chat, source) {
  if (source === 'embedded') {
    const resolved = resolveCardWorkspace(dataRoot, chat)
    if (!resolved) return null
    const workspace = resolved.workspace
    const raw = workspace?.raw || workspace
    const parsed = readEntries(raw)
    return parsed.records.length ? { filePath: resolved.path, container: workspace, native: parsed.native, records: parsed.records } : null
  }
  const filePath = String(source || '').replace(/^external:/, '')
  if (!filePath) return null
  const doc = tryReadJson(filePath)
  if (!doc) return null
  const parsed = readEntries(doc)
  return { filePath, container: doc, native: parsed.native, records: parsed.records }
}
/** 读取指定 chat 的历史召回审计摘要（index.json records → 每轮 operation 的 outputs/计数）。 */
export function readRecallHistory(dataRoot, chatId, limit = 12) {
  if (!dataRoot || !chatId) return []
  const dir = join(dataRoot, 'worldbook-recalls', String(chatId))
  const index = tryReadJson(join(dir, 'index.json'))
  if (!index) return []
  const records = Array.isArray(index.records) ? index.records : []
  const out = []
  for (const rec of records.slice(-limit)) {
    const rel = rec?.path || rec?.file || rec?.id || ''
    const op = rel ? (tryReadJson(join(dataRoot, rel)) || tryReadJson(join(dir, String(rel).replace(/^.*[\\/]/, '')))) : null
    if (!op) continue
    out.push({
      turn: op.turn ?? rec.turn,
      status: op.status || 'unknown',
      counts: op.counts || null,
      screening: op.screening ? { candidateCount: op.screening.candidateCount, estimatedTokens: op.screening.estimatedTokens, selected: Array.isArray(op.screening.selected) ? op.screening.selected : undefined } : null,
      entries: Array.isArray(op.entries) ? op.entries : [],
      outputs: Array.isArray(op.outputs) ? op.outputs.map(o => ({ ref: o.ref, text: o.text, location: o.location })) : [],
      forcedRefs: Array.isArray(op.activationRequests) ? op.activationRequests.filter(r => r?.force).map(r => String(r?.ref)).filter(Boolean) : [],
      entriesCount: Array.isArray(op.entries) ? op.entries.length : 0,
      requestedAt: op.requestedAt || op.createdAt || null,
      frameId: op.frameId || ''
    })
  }
  return out
}

/** 读取最近活跃 chat（sessions.json 最后一个映射 → 快照）。会话 id 解析失败时的兜底。 */
export function readLatestChatFromDisk(dataRoot) {
  if (!dataRoot) return null
  try {
    const map = JSON.parse(readFileSync(join(dataRoot, 'sessions.json'), 'utf-8'))
    const keys = Object.keys(map || {})
    if (!keys.length) return null
    const lastKey = keys[keys.length - 1]
    return readChatFromDisk(dataRoot, lastKey)
  } catch { return null }
}
/** 读取指定 chat 的最新召回审计（worldbook-recalls\<chatId>\index.json → 最新 operation）。 */
export function readRecallAudit(dataRoot, chatId) {
  if (!dataRoot || !chatId) return null
  const dir = join(dataRoot, 'worldbook-recalls', String(chatId))
  const index = tryReadJson(join(dir, 'index.json'))
  if (!index) return null
  const records = Array.isArray(index.records) ? index.records : Array.isArray(index) ? index : []
  if (records.length === 0) return null
  const latest = records[records.length - 1]
  const rel = typeof latest === 'string' ? latest : (latest?.path || latest?.file || latest?.id || '')
  let op = null
  if (rel) {
    // path 可能相对 dataRoot（worldbook-recalls/chat-xxx/op.json）或相对 dir
    op = tryReadJson(join(dataRoot, rel)) || tryReadJson(join(dir, String(rel).replace(/^.*[\\/]/, '')))
  }
  return op ? { record: latest, operation: op } : null
}

/**
 * v0.7.17ad：读取最新「前台正文生成（reply）」请求的完整上下文文本。
 * LLM 无状态，每轮请求重发完整上下文；model-requests\<chatId>\<id>.json 保存每轮真实请求。
 * 拼接 messages 全部 text（含 tool-result 文本 = LLM 工具注入的世界书补查结果），
 * 用于精确判断某世界书条目是否真实存在于当前上下文中。
 */
export function readLatestReplyContext(dataRoot, chatId) {
  if (!dataRoot || !chatId) return null
  try {
    const dir = join(dataRoot, 'model-requests', String(chatId))
    const index = tryReadJson(join(dir, 'index.json'))
    if (!index) return null
    const reqs = Array.isArray(index.requests) ? index.requests.filter(r => r?.task === 'reply') : []
    if (!reqs.length) return null
    const latest = reqs[reqs.length - 1]
    const file = join(dir, String(latest.id) + '.json')
    if (!existsSync(file)) return null
    const req = JSON.parse(readFileSync(file, 'utf-8'))
    const parts = []
    let lastAssistant = '' // v0.7.17am：上一段 AI 输出（预测关键词命中文本源的一部分）
    for (const m of (req.request?.messages || [])) {
      if (m?.role === 'assistant') {
        for (const c of (m?.content || [])) if (c?.type === 'text' && typeof c.text === 'string') lastAssistant = c.text
      }
      for (const c of (m?.content || [])) {
        if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text)
        else if (c?.type === 'tool-result' && Array.isArray(c.content)) {
          for (const rc of c.content) if (rc && typeof rc.text === 'string') parts.push(rc.text)
        }
      }
    }
    const haystack = parts.join('\n')
    return { requestId: latest.id, turn: req.turn, ts: latest.createdAt || 0, haystackLen: haystack.length, haystack, lastAssistant }
  } catch { return null }
}

/** 判断条目内容是否出现在上下文文本中（仅匹配条目正文 content 的句子覆盖度：
 *  content 按句号/问号/叹号/换行切句，剔除过短句（<6字），命中句数占比 >= 0.5 判定在上下文。
 *  标题/关键词不参与匹配（引用词不等于内容注入）；tool-result 文本已在 haystack 内）。 */
export function entryPresentInContext(haystack, entry) {
  if (!haystack || !entry) return false
  const content = typeof entry.content === 'string' ? entry.content : ''
  if (!content) return false
  const clean = content.replace(/^[#\-\*\s>·]+/, '').trim()
  const sents = content
    .split(/[。！？!?\n]+/)
    .map(s => s.replace(/^[#\-\*\s>·]+/, '').trim())
    .filter(s => s.length >= 6)
  // 短条目（切句后无有效长句，如内容仅数个字）：退化整段子串匹配
  if (sents.length === 0) return clean.length > 0 && haystack.includes(clean)
  let hit = 0
  for (const s of sents) if (haystack.includes(s)) hit++
  return hit / sents.length >= 0.5
}
