/**
 * narrative-anchor 路径解析 —— 全插件唯一真相源（v0.10.0）
 *
 * 立身之本（三不原则）：
 *  1. 不写盘符：源码内不出现任何以盘符开头的路径字面量；
 *  2. 不写用户主目录：不臆造 ~/.dsh 之类"大概是这个位置"的猜测路径
 *     （历史教训：resolveDataRoot 曾 fallback 到 <用户主目录>/.dsh/profile-data，
 *      该目录在本机并不存在 → fallback 恒失效 → 逼得作者在别处硬编码日志目录兜底）；
 *  3. 不猜层级：不写 dirname(dirname(dirname(x))) 这种"上溯 N 级"的脆弱推导。
 *
 * 取而代之的是**结构发现**：路径全部由「运行时上下文」推导，拼接一律走 node:path，
 * 因此 Windows / macOS / Linux 行为一致，开发目录与正式安装位置行为也一致。
 *
 * 解析优先级（数据根）：
 *   ① 运行时显式注入（插件配置的 tavernDataRoot，唯一被允许的"外部给定路径"）
 *   ② 从起点向上遍历，发现 DSHT 安装根 launcher-settings.xml 并读取其 DataDirectory
 *      —— 这是 DSHT 自己声明的数据位置，是权威来源，不随目录改名/换盘而失效
 *   ③ 起点向上遍历时直接按 DSHT 目录结构探测
 *   ④ 环境变量（DSH_TAVERN_DATA_DIR / DSH_HOME），且必须结构校验通过才采纳
 *   ⑤ 插件根回退（仅用于插件自持数据，找不到用户数据区时）
 *
 * 起点集合 = 插件根（import.meta.url 推导）+ 进程 cwd + 环境变量。
 * 关键性质：开发时插件在开发目录，向上遍历必然失败，转由 cwd 命中；
 * 正式安装时插件在 profile/node_modules 下，向上遍历直接命中。
 * 两者最终解析出**同一个**数据根 —— 开发版与发布版因此没有区别。
 *
 * DSHT 目录结构（相对 DataDirectory）：
 *   <InstallRoot>/launcher-settings.xml          ← 真相源，含 <DataDirectory>
 *   <DataDir>/harness/profile-data/tavern/data  ← 用户数据根
 *   <DataDir>/harness/profile-data/tavern/sessions
 *   <DataDir>/desktop/logs
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'narrative-anchor'

// ── 结构常量：只描述"形状"，不含任何具体位置 ──
const INSTALL_SETTINGS_FILE = 'launcher-settings.xml'
const SETTINGS_DATA_DIR_KEY = 'DataDirectory'
// 用户数据根的尾部结构：<X>/profile-data/tavern/data
const TAVERN_TAIL_SEGMENTS = ['profile-data', 'tavern', 'data']
// 相对 DataDirectory 时，前面还要加 harness
const DATA_ROOT_SEGMENTS = ['harness', ...TAVERN_TAIL_SEGMENTS]
const DATA_ROOT_MARKER = ['resources', 'cards']
const SESSIONS_SEGMENT = 'sessions'
const DESKTOP_LOG_SEGMENTS = ['desktop', 'logs']
const PLUGIN_DATA_SEGMENTS = ['plugin-data', PLUGIN_NAME]
const MAX_UPWARD_DEPTH = 12
const MAX_SIBLING_SCAN = 64

let pluginRootCache = ''
let dataRootOverride = ''
let dataRootCache = ''
let dataRootResolved = false
let dataDirCache = ''
let pluginDataDirCache = ''

function tryReadFile(path) {
  if (!path) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function tryReadJson(path) {
  const raw = tryReadFile(path)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

function isDir(path) {
  if (!path) return false
  try { return existsSync(path) } catch { return false }
}

/** 插件根：含本插件 package.json 的目录（import.meta.url 上溯，跨平台）。 */
export function pluginRoot() {
  if (pluginRootCache) return pluginRootCache
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    const pkg = tryReadJson(join(dir, 'package.json'))
    if (pkg && pkg.name === PLUGIN_NAME) {
      pluginRootCache = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // 回退：本文件位于 <插件根>/lib/ 之下，上一级即插件根
  pluginRootCache = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return pluginRootCache
}

/** 运行时注入用户数据根（index.js 读取插件配置后调用）。空值不覆盖已有解析。 */
export function setTavernDataRoot(path) {
  const value = String(path || '')
  if (!value) return
  dataRootOverride = value
  if (dataRootCache !== value) {
    dataRootCache = value
    dataRootResolved = true
  }
}

/** 数据根合法性校验：必须是 DSHT 用户数据根（含 resources/cards）。 */
function isRealDataRoot(candidate) {
  return !!candidate && isDir(join(candidate, ...DATA_ROOT_MARKER))
}

/** 读 DSHT 安装根的 launcher-settings.xml，取它自己声明的 DataDirectory。 */
function readDataDirectory(installRoot) {
  const raw = tryReadFile(join(installRoot, INSTALL_SETTINGS_FILE))
  if (!raw) return ''
  const match = new RegExp('<' + SETTINGS_DATA_DIR_KEY + '>([^<]+)</' + SETTINGS_DATA_DIR_KEY + '>', 'i').exec(raw)
  if (!match) return ''
  const value = match[1].trim()
  if (!value) return ''
  // 相对路径按安装根解析（DSHT 写的是绝对路径，但不假设它一定如此）
  return isAbsolute(value) ? value : resolve(installRoot, value)
}

/** 在某一层目录上，按结构直接拼出候选数据根。 */
function dataRootAt(dir) {
  const candidates = [
    join(dir, ...DATA_ROOT_SEGMENTS),               // dir 是 <DataDir>
    join(dir, 'profile-data', 'tavern', 'data'),    // dir 是 harness 根
    join(dir, 'tavern', 'data'),                    // dir 是 profile-data
    join(dir, 'data')                               // dir 是 tavern
  ]
  for (const candidate of candidates) {
    if (isRealDataRoot(candidate)) {
      // 反推 <DataDir>：从数据根向上退 DATA_ROOT_SEGMENTS 的层数
      let dd = candidate
      for (let i = 0; i < DATA_ROOT_SEGMENTS.length; i++) dd = dirname(dd)
      return { dataRoot: candidate, dataDir: dd }
    }
  }
  return null
}

/** 在某一层目录及其直接子目录中，发现 DSHT 安装根并取得数据根。
 *  子目录扫描是为了覆盖"cwd 在安装根的上一级"的情况，按结构发现而非按目录名硬编码。 */
function discoverAt(dir) {
  const settings = join(dir, INSTALL_SETTINGS_FILE)
  if (existsSync(settings)) {
    const dataDir = readDataDirectory(dir)
    if (dataDir) {
      const candidate = join(dataDir, ...DATA_ROOT_SEGMENTS)
      if (isRealDataRoot(candidate)) return { dataRoot: candidate, dataDir }
    }
  }
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  let scanned = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (++scanned > MAX_SIBLING_SCAN) break
    const sub = join(dir, entry.name)
    const dataDir = readDataDirectory(sub)
    if (!dataDir) continue
    const candidate = join(dataDir, ...DATA_ROOT_SEGMENTS)
    if (isRealDataRoot(candidate)) return { dataRoot: candidate, dataDir }
  }
  return null
}

/** 从一个起点向上遍历，逐级尝试发现数据根。 */
function searchUpward(start) {
  if (!start) return null
  let dir = start
  for (let i = 0; i < MAX_UPWARD_DEPTH; i++) {
    const found = discoverAt(dir) || dataRootAt(dir)
    if (found) return found
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 结构发现用的起点：插件根 → 进程 cwd。与开发/发布无关（仅作 DSH_HOME 的补充）。 */
function startPoints() {
  const ordered = [pluginRoot()]
  try { if (process.cwd()) ordered.push(process.cwd()) } catch { /* 无 cwd 时不加 */ }
  return ordered
}

/** 环境变量里的 DSH home。DSHT 进程内 launcher/updater 会注入 DSH_HOME。 */
function envHomes() {
  const env = (typeof process !== 'undefined' && process.env) || {}
  return [env.DSH_TAVERN_DATA_DIR, env.DSH_HOME]
    .map(v => String(v || '').trim())
    .filter(Boolean)
}

/** DSH home → 候选数据根。
 *  官方语义里 DSH_HOME 指向 **harness 根**（见官方 tavern-plugin 的 resolveTavernDataRoot：
 *  join(dshHome,'profile-data','tavern','data')，而 application-updater 把 dataRoot 上溯 3 级
 *  即 harness 根注入为 DSH_HOME）。但该值也可能是 DataDirectory，两种都试。 */
function candidatesFromHome(home) {
  return [
    { dataRoot: join(home, ...TAVERN_TAIL_SEGMENTS), dataDir: dirname(home) },
    { dataRoot: join(home, ...DATA_ROOT_SEGMENTS), dataDir: home }
  ]
}

/** 解析 DSHT 用户数据根（…/harness/profile-data/tavern/data）。解析不到返回 null。
 *
 * 优先级（从最可靠到最兜底）：
 *   ① 插件显式配置 tavernDataRoot —— 用户唯一可指定的外部路径
 *   ② **DSH_HOME 环境变量（官方机制）** —— DSHT 进程内由 launcher/updater 注入为 harness 根。
 *      它与「模块从哪个路径加载」完全无关，因此 junction / symlink / 正式 npm 安装全都适用，
 *      这正是分发渠道下最可靠的来源（分发时插件常以 link 形式安装，靠模块位置上溯会失效）。
 *   ③ 结构发现 —— 从插件根与 cwd 向上遍历，读 launcher-settings.xml 的 DataDirectory
 *      或按目录结构直接探测；覆盖 DSH_HOME 未设置的场景（CLI 模式、单元测试等）。
 *
 * 失败时**不**标记为已解析，允许后续调用重试——否则首次解析失败会把空结果固化，
 * 导致本进程内再也纠正不回来（旧实现即有此缺陷）。
 */
export function resolveTavernDataRoot() {
  if (dataRootResolved) return dataRootCache || null

  // ① 显式配置
  if (dataRootOverride && isRealDataRoot(dataRootOverride)) {
    dataRootCache = dataRootOverride
    dataRootResolved = true
    return dataRootCache
  }

  // ② 官方机制：DSH_HOME
  for (const home of envHomes()) {
    for (const candidate of candidatesFromHome(home)) {
      if (isRealDataRoot(candidate.dataRoot)) {
        dataRootCache = candidate.dataRoot
        dataDirCache = candidate.dataDir
        dataRootResolved = true
        return dataRootCache
      }
    }
  }

  // ③ 结构发现
  for (const start of startPoints()) {
    const found = searchUpward(start)
    if (found) {
      dataRootCache = found.dataRoot
      dataDirCache = found.dataDir
      dataRootResolved = true
      return dataRootCache
    }
  }

  // 显式配置即便校验未过也照用（尊重用户），但不标记已解析，下次仍可重试
  if (dataRootOverride) {
    dataRootCache = dataRootOverride
    return dataRootCache
  }
  return null
}

/** 用户数据根（与 resolveTavernDataRoot 同义，语义更直白）。 */
export function tavernDataRoot() {
  return resolveTavernDataRoot()
}

/** DSHT 数据目录（launcher-settings.xml 里的 DataDirectory）。拿不到时由数据根反推。 */
export function installDataDir() {
  const root = resolveTavernDataRoot()
  if (!root) return ''
  if (dataDirCache) return dataDirCache
  let dd = root
  for (let i = 0; i < DATA_ROOT_SEGMENTS.length; i++) dd = dirname(dd)
  dataDirCache = dd
  return dd
}

/** 后台会话目录（…/profile-data/tavern/sessions）。 */
export function tavernSessionsDir() {
  const root = resolveTavernDataRoot()
  return root ? join(dirname(root), SESSIONS_SEGMENT) : ''
}

/** DSHT 桌面日志目录（<DataDir>/desktop/logs）。 */
export function desktopLogDir() {
  const dataDir = installDataDir()
  return dataDir ? join(dataDir, ...DESKTOP_LOG_SEGMENTS) : ''
}

/** 桌面日志目录下的指定文件。拿不到目录时返回 ''，调用方据此跳过写盘——绝不退化为相对路径。 */
export function desktopLogFile(fileName) {
  const dir = desktopLogDir()
  return dir && fileName ? join(dir, fileName) : ''
}

/** 插件自持数据目录。用户数据区优先，解析不到时回退插件根下 data/。
 *
 * 注意：**只在解析成功时缓存**。解析失败时返回回退目录但不缓存——否则模块顶层首次调用
 * 一旦赶上解析失败（如 DSH_HOME 未就绪），会把回退位置固化，之后再也纠正不回用户数据区。
 * 不缓存的代价仅是每次调用多一次 existsSync，可忽略。 */
export function pluginDataDir() {
  if (pluginDataDirCache) return pluginDataDirCache
  const root = resolveTavernDataRoot()
  if (root) {
    const target = join(root, ...PLUGIN_DATA_SEGMENTS)
    if (ensurePluginDataDir(target)) {
      pluginDataDirCache = target
      return target
    }
  }
  const fallback = join(pluginRoot(), 'data')
  try { mkdirSync(fallback, { recursive: true }) } catch { /* 只读安装位置：忽略 */ }
  return fallback
}

/** 建目录 + 一次性迁移旧数据（旧位置 → 用户数据区）。失败不影响主流程。 */
function ensurePluginDataDir(target) {
  const legacy = join(pluginRoot(), 'data')
  try {
    if (isDir(target)) return true
    mkdirSync(target, { recursive: true })
    if (isDir(legacy) && legacy !== target) migrateDir(legacy, target)
    return true
  } catch {
    return false
  }
}

/** 逐文件递归复制。
 *  刻意不用 fs.cpSync：实测在本机（跨盘 + 该文件系统驱动环境）cpSync 会**静默中断**——
 *  既不成功也不抛错，进程在调用处失去响应；逐文件 copyFileSync 则 239/239 全部成功。
 *  单文件失败只记不抛，保证部分失败不影响其余数据迁出。 */
function migrateDir(from, to) {
  let entries = []
  try { entries = readdirSync(from, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const src = join(from, entry.name)
    const dst = join(to, entry.name)
    try {
      if (entry.isDirectory()) {
        if (!existsSync(dst)) mkdirSync(dst, { recursive: true })
        migrateDir(src, dst)
      } else if (entry.isFile()) {
        copyFileSync(src, dst)
      }
    } catch { /* 该文件跳过，继续其余 */ }
  }
}

/** 测试/热重载用：清空路径缓存，下次调用重新解析。 */
export function resetPathCache() {
  pluginRootCache = ''
  dataRootCache = ''
  dataRootResolved = false
  dataDirCache = ''
  pluginDataDirCache = ''
}
