# 更新日志

本文件随每次发布追加一条，记录该次推送的变更项。

> 说明：自 `v1.0.0` 起版本号已统一为语义化版本（当前 `1.1.2`）；下方各条目按时间倒序记录变更。

## v1.1.2（2026-10-28 发布：known_facts 收敛 + 结算状态提示 + LTM 世界书固定注入）

### 变更
- **LTM 改由固定世界书注入**：不再于请求内注入（机制版本不稳定），改为记录待注入内容并经世界书源（`worldbookSource`）于下一请求注入；压缩后那一轮全量注入 LTM + STM。仅前台正文会话生效。
- **known_facts 收敛**：仅从最新一轮对话总结新增内容，不复述历史对话/记忆/常驻世界书；独立结算与官方结算两条路径按各自语义对齐。
- **结算状态未填写提示**（`stateHintLines`）：`current_state` 六字段任一为空时注入「⚠ 当前状态未填写」催填提示，两条结算路径全覆盖。
- **叙事备忘描述优化**：focus 只记伏笔/暗线/约定，可填事件提醒、长期无进展时的转折/场景变换建议；不复述当前状态与 STM。
- **current_state 工具描述优化**：unfilled 字段本轮须填写、字段级精要，避免冗长。

## v1.1.1（2026-10-24 发布：ltm_leaf.stm_indices 三条硬规则校验）

### 变更
- **`ltm_leaf.stm_indices` 新增三条硬规则校验**（均返回可重试错误，模型可自我纠正）：
  - **必须从最旧的未合并 STM 开始** —— 老条目最该被固化（注入只取最近 7 条，
    老条目一旦滑出视野就再没机会被合并）；否则模型总挑最新的合并，老条目永久残留。
  - **未合并序列中必须连续** —— 不能跳过中间任何未合并条目。
    注意「连续」指**未合并序列中的连续切片**，中间夹着已合并条目不算断；
    若按「数组下标严格相邻」，历史合并留下的空洞会让规则永远无法满足、直接卡死。
  - **至少 6 条** —— 保证合并的信息密度，避免「1 条也合并」把未合并池撑爆。
- **附带效果（隐式下限闸门）**：未合并不足 6 条时，模型无法构造出合法的 `stm_indices`
  → 自动被拒，无需额外代码即实现「未合并数不够就不允许合并」。
- 文案同步 4 处：`ltm_leaf` schema 的 `stm_indices` 描述（含实例）、工具描述规则行、
  `ltmHintLines` ⚠ 提示行、强制阈值报错文案。
- 版本号：`1.1.0` → `1.1.1`。

### 修复
v1.1.0 上线后首次真实结算暴露的问题：模型在未合并池有 6 条的情况下只声明 `[8]`
合并 1 条 —— 每轮 1 条进、远小于 1 条出，未合并池单向增长，老条目有永远无法被合并的风险。
本次三条规则即针对该现象（过窄合并 + 跳过老条目）而设。

### 升级提示
- 本次为**校验规则增强**，无协议不兼容变更；存量会话不受影响。
- 若你的跑团未合并 STM 已积累较多，下一轮合并时会一次性合并至少 6 条
  （从最旧的开始），摘要覆盖面会比之前更广，属预期行为。

## v1.1.0（2026-10-24 发布：LTM 合并协议改用下标声明，修复摘要与合并范围错位）

### 变更
- **LTM 合并协议：`ltm_leaf.stm_count` → `ltm_leaf.stm_indices`**（提交参数不兼容变更）：
  - 原参数 `stm_count`（"合并了几条"的数量声明）语义模糊：程序只把它当循环上限，
    实际吞多少由"当时还剩多少未合并"决定，两者不一致时无声吞掉偏差。
  - 新参数 `stm_indices`（下标数组）：模型显式声明合并哪几条，程序按声明精确合并。
  - **后台注入的 STM 序号改为全局数组下标**（原为从 1 重编号）：模型照抄快照里每条
    前的序号即可回填，注入端与合并端共用同一坐标系。
  - 提交层新增校验：`stm_indices` 缺失 / 越界 / 指向已合并条目 → 返回可重试错误，
    要求模型重新提交（不再静默退回"按最旧 N 条"推算）。
  - LTM 节点新增 `stm_indices`（精确下标数组）与 `merged_count` 字段供溯源。

### 修复
- **摘要与被合并条目对不上**：模型按工具 schema 里写死的「7 条」口径组织摘要，程序却按
  实际剩余条数合并 → 节点自称覆盖 7 条事件、实则只标了 2 条，记忆密度被稀释。
- **视图错位导致内容丢失 / 重复总结**：注入用最近 7 条、合并用最旧 N 条，两套坐标系在
  未合并数超过 7 时错位 —— 被标记已合并的条目模型从未见过（内容凭空消失），
  而模型写进摘要的条目仍留在未合并池（将来被重复总结）。
- **静默截断无留痕**：声明与实际的偏差此前被无声吞掉，无日志无告警。
- **删除 LTM 节点的 `turn` 字段**：该字段填的是 `meta.turn_count`（锚点累计提交次数），
  UI 却渲染成「轮次 N」，与展开的子 STM「轮次 N」（正文轮号）同屏冲突，用户无从判断
  哪个对。全仓仅 UI 两处渲染、无逻辑依赖，且可由 `stm_indices` / `children` 推导 → 纯冗余。
  叶节点与中间节点的写入一并删除，UI 两处渲染一并移除；**存量节点数据不动**
  （UI 不再读取，无害），避免一次性迁移风险。
- **新增舞台导演后台请求拦截**（临时止血）：舞台导演每轮必败（流式提交 key 不匹配 +
  素材池缺失）却仍每轮发起一次无效模型请求、白耗 QPS。复用 `llm/stream` 全局瀑布，
  命中 `stage_update` 工具或「你是独立的舞台导演」系统提示时投毒 provider，使请求在
  路由阶段失败 —— 零模型调用、零 QPS，回合照常继续。全局开关 `blockStageDirector`
  （global.json，默认 false），关闭时零开销放行。根治见上游 issue。
- **新增本局结算归属开关**：DSHT 3.1.0 移除官方「结算由谁负责」下拉框，改由插件用
  `tavern.gameSettings` 自行声明；按局让路只能走「settle 内 throw / 返回 null」。

### 文档
- 新增 `docs/局级结算开关-按局让路方案.md`（正本内部文档，不随包外发）。

### 升级提示
- 本次含**提交协议不兼容变更**：若你自行改过 `narrative_anchor_submit` 的调用或
  二次开发了结算层，需从 `stm_count` 改为 `stm_indices`。
- 存量会话的 LTM 节点仍带旧 `turn` 字段（无害，UI 不再展示），新节点不再写入。

## v1.0.1（2026-10-21 发布：修复 folder-drop 安装无法加载）

### 变更
- **修复「加载失败：Cannot find package '@deepseek-ai/dsh-agent'」**（用户实测反馈）：
  v1.0.0 经插件管理「GitHub 安装」落入 `<data>/plugins/` 后，由 DSHT guard 以原生
  ESM 加载，Node 从插件目录上溯解析不到 asar 内的宿主包，静态 import 直接致命。
  - `lib/settlement/official-v2.js`：去掉 `import { installModelSelection } from
    '@deepseek-ai/dsh-agent'`，改为本地移植实现 `lib/settlement/model-selection.js`
    （据 dsh-agent 0.2.1-rc.2 `model-selection.js` 逐行移植 assemble 快照 +
    request 路由覆盖；未移植切模型通知——依赖 dsh-llm，且后台结算会话 selection
    静态指定不会切换）。
  - `lib/index.js`：`import Schema from '@deepseek-ai/schemastery'` 改为动态
    import + 失败兜底 `lib/schema-shim.js`（标准 Schema v1 协议，补齐 Config 五项
    默认值；cordis `resolveConfig` 只消费 `Config['~standard'].validate`）。
    bundle 安装下仍优先使用真 schemastery，行为与既往一致。
- **安装方式影响**：folder-drop（`<data>/plugins/`）安装不再需要手动 `pnpm install`，
  与 bundle 安装（`dsh plugin --profile tavern add`）行为一致；配置默认值两种方式相同。
- 版本号：`1.0.0` → `1.0.1`。
- **README 补充两种安装方式差异对照表**（bundle `dsh plugin add` vs folder-drop `<data>/plugins/`）：依赖安装机制、宿主包可解析性（folder-drop 必须零运行时外部依赖）、配置来源（seed 层 vs Schema 默认值）、安装位置、重名检查、维护方六维对照。

## v1.0.0（2026-10-21 发布：叙事锚定系统首个完整功能版本）

### 里程碑范围
- 叙事锚定核心：global / session 锚点 + 快照
- 世界书条目三源接入：session（插件自建）/ bound（会话绑定）/ 官方 entry
- 后台结算协议：`replaceSettlement` / `settlementTool` / `settlementSection`（七行硬规则 + `posture_submit` 顺序）
- 动态快照：来源标签、展开正文 / 关键词
- 官方世界书 block-DAG 读取修复
- **DSHT 0.2.x ref 体系错位全量修复**：前端 `normalizeRef`（来源标签 / entryMeta 关联）+ 后端 `inCtx` 强制注入去重，均经真实数据 round-trip 验证
- 版本号统一：`0.8.0` → `1.0.0`

### 发布说明
- 本次发布以独立 commit 推送至 GitHub `main`；建议用户重载 / 重启 DSH-Tavern 插件，使前端与后端修复一并生效。

## 2026-10-21（后台结算协议提示词改版：七行硬规则 + posture_submit 顺序；注入改单段）

### 变更
- **【酒馆后台-叙事锚定结算协议-提示词】默认值改版**（`lib/settlement/official-v2.js`
  `DEFAULT_BACKEND_SETTLE_PROTOCOL`，锚点设置页"全局设置"可覆盖）：修「后台老是不结算
  锚点」。旧默认值只有三行残缺描述句——无"必须调用"祈使、无空提交兜底；且本路径
  （官方后台 settlementSection）**不挂插件的 settlePersona**，persona 里的强规则
  一句不过去，默认值必须自带。新版七行：
  1. 本轮必须调用 narrative_anchor_submit：工具调用是唯一提交通道，未调用 = 本轮结算失败；
  2. 即使判断本轮无任何变化，也必须调用并以空对象 {} 提交，禁止跳过（"无可更新即跳过调用"
     是头号嫌疑——该规则虽在工具描述里，但埋在 schema 深处权重低，协议段显式兜住）；
  3. 只依据本轮正文已发生事实更新，不预测、不续写、不复述；
  4. 同轮多工具在一次回复中同时调用、互不依赖，禁止拆分多次；
  5. posture_submit 必须是最后一个，否则会导致后续工具提交失效（用户实测口径）；
  6. 记忆分工：known_facts 不是事件流水，那是 STM 的工作；
  7. 具体提交规则（增量合并 / stm 每轮 1 条 / LTM 合并阈值 / known_facts 写法）以
     narrative_anchor_submit 工具描述为准。
- **协议注入机制调整并单段化**（修正 10-20 同名条目中的"任务消息注入"描述）：
  - 注入位置从 settle 任务消息改为酒馆（宿主）后台的 `settlementSection`
    （`narrative-anchor.1b-backend-protocol`，位于【当前叙事锚定快照】之后，由官方
    background-agent-task 拼进【插件附加的结算任务】；MVU 结算与官方兜底同走此路）；
  - 当日上线当日废除的拆分机制：按换行拆最多 16 段（为绕官方单段 8000 字上限）——
    默认协议仅三百余字、一段足够，删除 `backendProtocolRawChunks` / `backendProtocolChunk` /
    段数上限常量，改为单段函数 `backendProtocolSection`（标题 + 全文；超 8000 字仅
    dbg 诊断、不自我截断，与快照段同款）。
- 设置页 UI 描述同步更新（原"强调记忆分工与同轮多工具一次提交"过时）。
- 生效：lib 改动需**重启/重载插件一次**（注册名变更）；之后改协议内容每轮实时读全局
  文件、无需重启。

## 2026-10-20（舞台视图改官方 reader/footer 模式：朗读开关恢复官方语义，「自动」播完再翻页）

### 变更
- **na-stage 舞台视图改为卡内插件既定模式**（参照本机另一个 `registerStageView`
  实现 dsh-card-dafeiyu-galgame：「翻页、自动、输入框和音乐播放仍由 Tavern 负责」）：
  reader / reading / 翻页 / 朗读开关全部用官方的——视图只画场景，index/beat/advance
  走官方 input，controls 原样渲染官方 `input.footer`（‹ 进度 › 朗读）。
- **修复「朗读」开关失灵**（取代同日「官方全屏 overlay 非全屏移植」一条的实现与已知边界）：
  上一代自建 reader/reading 造成两个朗读开关实例——NA 自绘按钮切的是 NA 自己的状态，
  而官方 section effect（cast-stage.js:292-294）检查的是官方实例，其唯一 UI（官方
  footer 的「朗读」按钮）被丢弃，永远停在默认开：关掉 NA 的「朗读」后，每轮首句仍会被
  官方 effect 读一句。现全链路只有一个朗读者、一个开关：关掉「朗读」→ 官方 effect 与
  自动翻页都不发声，与内置舞台同语义。
- **「自动」按钮照官方全屏 auto effect（cast-stage.js:174-182）移植，恢复「播完再翻页」**：
  官方「播完再翻页」不依赖任何播放状态 API——auto effect 自己调 speak、await 那个
  promise（heard 到结尾才 resolve true，speech.js:27/39/49），再 heard ? 400ms : 时长
  公式翻页。NA 经公开接口 `tavernUi.speak`（plugin-extensions.js:244-249，转发的就是
  同一个 speech 单例）照此接线。非全屏唯一结构差异：官方全屏里 section 的「翻页即读」
  effect 被 `!fullscreen` 静音、auto effect 是唯一朗读者；非全屏没有该开关，section
  effect 会在同一次提交里后跑并 stop 掉先发的那次 speak，故 NA 把发声排到本次提交所有
  effect 之后（queueMicrotask）成为最终朗读者。朗读关闭时 NA 不发声、只按官方时长公式
  `clamp(1500, 400+70×字数, 10000)` 翻页。
- 移除：自建 reader/reading、自绘「朗读」按钮。
- 已知边界：朗读开启且自动开启时，每次翻页会额外发起一次 `speechForLine` 请求
  （官方 section effect 那次，被 NA 后发的 speak 中止、不播放）。
- 验证：react-test-renderer 真实渲染冒烟 81/81 通过（含「官方 section 与 NA 竞发时
  NA 为最终朗读者（对方被 stop、NA heard=true）」时序用例、朗读关零发声、heard=false
  与 speak reject 均退回时长公式、advance 引用抖动不重置计时、末句不排程、场景点击
  翻页、空 beats、全屏与缺 advance 回退内置）；`node --check` 通过。
- 生效：client.js 改动，**刷新页面**即生效，无需重启。

## 2026-10-20（修复：LTM/known_facts 编辑保存 keywords 数组兼容）

### 修复
- `lib/client.js` 三处 `saveEdit` 提交前的 keywords 拆解改为数组兼容：
  编辑草稿中的 `keywords` 可能已是数组（而非字符串），原先直接 `.split()` 会抛
  `TypeError: editDraft.keywords.split is not a function`，导致 LTM 节点 /
  known_facts 条目 / 通用列表标签三类编辑「保存」按钮点击无响应。
  - LTM 节点保存（`saveEdit('ltm.' + node.id, …)`）
  - known_facts 条目保存（`saveEdit('kf.' + origIdx, …)`）
  - 通用列表标签保存（`saveEdit(path, { [label]: … })`）
  - 口径统一为：`Array.isArray(draft.keywords) ? draft.keywords : String(draft.keywords ?? fallback).split(/[、，,;；\n]+/)`，再 `.map(s => s.trim()).filter(Boolean)`。
- 生效：client.js 改动，**刷新页面**即生效，无需重启。

## 2026-10-20（新增全局设置：酒馆后台-叙事锚定结算协议-提示词）

### 新增
- **全局设置【酒馆后台-叙事锚定结算协议-提示词】**（`backendSettleProtocol`，与 settlePersona /
  settleTaskPrompt 同级，位于锚点设置页「全局设置」块）：
  - 注入位置：后台结算任务消息中【当前叙事锚定快照】**之后**，以【叙事锚定结算协议】段注入；
    未配置/为空 → 用默认值，`global.json` 无需预置键（与 settlePersona/settleTaskPrompt 同构）。
  - 默认值：只依据本轮正文事实更新，Brief thinking, no drafts / ！强调记忆分工，不要把
    known_facts 当做事件流水，那是 STM 的工作 / 如果有其他工具需要提交，尽可能在一次提交内
    完成，不要拆分多次！
  - `lib/settlement/official-v2.js`：新增常量 `DEFAULT_BACKEND_SETTLE_PROTOCOL` 与 getter
    `backendSettleProtocolOf()`；`settle()` 任务消息数组在 context（【当前叙事锚定快照】）
    段之后插入该段，其余段落顺序未变。
  - `lib/index.js`：getConfig 返回 `backendSettleProtocol` / `backendSettleProtocolCustomized`
    （未配置回默认值）；setConfig 新增持久化分支（空串 = 删键回默认，字符串 = 落盘），
    并补 `protocolLen` 诊断日志。
  - `lib/client.js`：全局设置折叠块新增对应 `details` 行（textarea + 恢复默认/保存此项，
    样式与另两个提示词行一致）；草稿恢复新增 `protocol` 档，切换/刷新不丢失未保存编辑。
- 生效：server 模块（official-v2.js / index.js）需**完全重启 DSH Desktop**；client.js
  刷新页面即生效。

## 2026-10-20（舞台视图：官方全屏 overlay 的非全屏移植）

### 新增
- **舞台「自动」按钮非全屏可用（官方 `tavernUi.registerStageView`，apiVersion≥2）**：
  官方非全屏舞台 control 条只有 ‹ 进度 › 朗读，「自动」只存在于全屏 overlay；且没有任何
  「往官方 footer 里加按钮」的接口——接口参考原话「页面结构不是接口」，故不做 DOM 注入。
  本版按用户要求**整体照抄官方全屏 overlay（TavernStageFullscreen）的非全屏形态**，
  注册舞台视图 `na-stage`（label「NA 舞台」）：
  - `reader`/`reading` 自建，口径逐行复刻官方 `useTavernStageReader` /
    `useTavernStageReading`（`cast-stage.js:119-127/131-143`，localStorage 同键
    `dsh-tavern-stage-read`，新一轮重置首句、toggle 停播、卸载停播）；
  - 场景照官方 `TavernStageScene` 口径（`:61-85`：背景/上台规则/立绘选图/情绪标签/
    文本箱；保真校验：情绪映射 28 项键序值与官方逐一一致、选图四级兜底用例全中）；
  - controls 照官方全屏 footer 口径（`:192-199`）：‹ 进度 › **自动** 朗读，顺序、类名、
    disabled 边界与全屏一致；
  - 「自动」= 官方 auto 三元组整体移植（`:157` state + `:173-182` effect + `:196` 按钮），
    逐行同款：朗读开着先读当前句，听到完（`heard`）只补 400ms 缓冲翻页；读不成
    （配音关闭/旁白无声音 → 宿主回 `{skip:true}`、前端 resolve false）按台词长度定时
    `clamp(1500, 400+70×字数, 10000)`；演完熄火保持点亮。仅两处插件侧必要适配：
    `speak` 取 `tavernUi.speak`（判空）、`.catch` 防 speak reject 时卡住不翻页；
  - **不调用 `advance()`**：官方 section 的 reader 随之冻结，其「翻页即读」effect 不再
    每页触发（官方全屏态靠该 effect 的 `!fullscreen` 条件静音它，非全屏没有这个开关，
    故以自管 reader 达到同一效果——NA 是每页唯一朗读者，朗读与翻页在同一处成对发生）；
  - 全屏返回 null → 官方边界兜底用内置全屏（自带「自动」），不双按钮；render 抛错同样
    兜底回内置画面。
- 已知边界：每轮新 beats 到达时，官方 section 的 reader（冻结在首句）其 effect 仍会触发
  一次朗读，与 NA 首句竞争（单例后发赢）——表现为每轮第一句按台词时长翻页，第二句起
  播完才翻。官方全屏态无此问题（`!fullscreen` 静音），非全屏下无等价开关。
- 注意：注册后舞台样式默认切到「NA 舞台」（官方设计：未选过样式时默认用插件视图），
  可在舞台页「舞台样式」选回「内置」。

### 修复
- **后台 catalog 去重漏判（`duplicate catalog child`）**：released V4 下 catalog/descriptor
  等系统事件改经 `snapshotEvents()` 暴露，直读 `session.events` 会漏掉已写入的
  subagent/catalog → 去重失效、每轮结算重复 append → DSH 加载会话抛 "duplicate catalog child"。
  `lib/settlement/official-v2.js` 新增与宿主 `background-agent-sessions.js` /
  `background-catalog.js` 同口径的 `allEvents()` 访问器（优先 `snapshotEvents()`，
  回退 `events`/`_events`）；`registerCatalogChild` 补同 childId 幂等跳过，
  subagent/descriptor 去重同源。
- **新建支线起步为空**：创建支线即拉取族内已有【支线】条目（`syncSidelineEntries`），
  不必再等一轮结算才出现（`lib/index.js`）。

## 2026-10-20（v3.0 线适配 DSH Desktop 3.0）

> **适配声明**：NA v3.0（零补丁线）已完成 **DSH Desktop 3.0** 适配——v3.0 安装器布局
> （数据根解析走官方 `DSH_HOME` 机制，真相源 `lib/paths.js`）、DSH runtime `0.2.1-rc.2`、
> session format v4。旧版 stable 布局（安装根 `launcher-settings.xml` 的 `<DataDirectory>`）
> 由同一真相源兼容，两种安装布局自动识别、行为一致。README「环境要求 / 数据存放」
> 已按双布局更新。

### 修复
- **后台结算会话稳定损坏（`assistant/message does not match an open turn and step`）**：
  复刻官方 `rewindBackgroundSurface` 时漏了 `withSurfaceEditTurn` 包裹。replacement 落在
  append-only 日志尾部，released V4 按「尾部当时开着的 turn/step」校验墓碑（而非被遮蔽区间）；
  rewind 运行于上一轮 `turn/end` 之后，旧实现把 turn/step 抄自已关闭轮次裸 append，
  恢复校验拒绝 → 每个跑过后台结算的 na-background 会话每轮稳定中招、存档不可加载。
  `lib/settlement/rewind-surface.js` 现按官方语义补编辑轮次包裹：尾部无开轮次时新开
  `turn=N+1/step=1` → 写墓碑 → `step/end`+`turn/end`；墓碑携带编辑轮次号；同步
  `agent.phase.lastTurn`（循环下一轮号来源，判据同开场白路径）；另加全覆盖幂等预检，
  重复调用不再堆叠空转轮次。`lib/settlement/official-v2.js` 调用点改传 `resident.agent`。
- 验证（`_analysis_tmp/verify-rewind-fix.mjs`）：负对照（旧逻辑）精确复现该报错；
  新逻辑经 app 同款宿主 catalog 两种校验模式全过、墓碑全部位于编辑轮次内、
  surface 收敛为「系统头 + 一枚最新墓碑」、轮次号任务/编辑交替无撞号、幂等收敛。
- **请求体日志面板（RequestLogTab）长内容截断与滚动**：分组列表由
  `maxHeight:calc(100vh-100px)` 整体滚动改为弹性滚动容器（外层 `overflow:hidden`，
  内层 `flex:1 1 0; min-height:0; overflow-y:auto`），在侧边栏受限高度内稳定滚动；
  摘要行与「末条消息预览」去掉单行 `text-overflow:ellipsis` 截断，改 `pre-wrap` 断行，
  长会话 ID / 长预览完整可见。

## 2026-10-19（v4 兼容与依赖最终修正）

> 取代同日早前的「放宽 dsh-tools 版本范围」条目：dsh-tools 不再声明，改为 dsh-agent。

### 修复
- **后台结算每轮失败（DSH 0.2.x / session format v4）**：写入侧 `dsh-session-format`
  要求 `source.kind` 为 producer-owned（非空字符串、不等于裸 `plugin`），否则抛
  「format v4 message requires a producer-owned source kind」。`lib/settlement/official-v2.js`
  的结算任务消息 source 由 `{ kind: 'plugin', plugin: 'narrative-anchor' }` 改为
  `{ kind: 'plugin:narrative-anchor' }`，与 tavern-plugin 的 message-source 写法一致。
- **V4 下 tavern 注入消息被误判为真实用户输入**：`lib/index.js` 用户消息判定与
  `official-v2.js` 的 `naTavernStateFilter` 此前只识别 V3 的 `kind:'plugin'` + `plugin:'dsh-tavern'`。
  现改 `startsWith('plugin')` / 同时匹配 `kind:'plugin:dsh-tavern'`，覆盖 V3 与 V4，
  避免把 free_slots 注入错挂到插件消息、状态过滤退化到只能靠文本兜底。

### 变更
- **依赖最终修正**：移除 `@deepseek-ai/dsh-tools`（`lib/index.js` 已不再 import 其 `defineTool`，
  相关工具注册改走官方 settlement/tool API），`peerDependencies` 与 `devDependencies` 改为
  `@deepseek-ai/dsh-agent: ^0.2.0-rc.1`，与 DSH 0.2 运行时对齐。

### 其他
- `lib/client.js` 请求体日志区补 `height/maxHeight/overflowY` 样式，长日志可滚动。

## 2026-10-19（DSH 0.2 兼容修正）

### 修复

- **`peerDependencies` 补 DSH 0.2 支持**：`@deepseek-ai/dsh-tools` 由 `^0.1.5-rc.2`
  放宽为 `^0.1.5-rc.1 || ^0.2.0-rc.1`。此前声明只覆盖 0.1.x，在 DSH runtime 0.2.1-rc.2 下
  `dsh plugin add` 会判定版本不兼容并拒绝安装（`Plugin narrative-anchor@0.8.0 is incompatible
  with dsh 0.2.1-rc.2`）。本插件只用 `dsh-tools` 的 `defineTool`，跨该版本未变更。

### 新增

- **`devDependencies` 首次声明** `@deepseek-ai/dsh-tools: ^0.2.1-rc.2`，满足 DSH 官方发布规范
  「需与宿主共享实例的 dsh 包须同时声明在 `peerDependencies` 与 `devDependencies`」。

## 2026-10-18（日志归位与轮转）

### 修复

- **日志不再写进数据区**：`proj-diag.log` 由`plugin-data/narrative-anchor/` 迁至
  DSHT 桌面日志目录（`<DataDir>/desktop/logs/`），与 `na-debug.log`、`na-request-log.jsonl` 同处。
  数据区只存数据；解析不到日志目录时静默跳过，不回退到插件目录。
- 清理一处无写入者的历史遗留日志 `merger-debug.log`。

### 新增

- **三个日志统一轮转**：`na-request-log.jsonl`（实测一度涨到 168MB，1338 条平均 128.8KB/条）
  此前无上限、只增不减。现按写入频率与单条体量分档：`na-proj-diag` 4MB/留 2 份、
  `na-debug` 8MB/留 3 份、`na-request-log` 50MB/留 3 份，超限即归档。
  归档用 rename 覆盖最老一份，轮转异常一律吞掉、不阻断业务。

### 文档

- README 补充日志清单与轮转策略、以及 `settlementSection` 四段上下文说明。

## 2026-10-17 · 补发（结算注入链路）

### 修复

- **修复结算注入静默失效**：`settlementSection` 的段函数此前未接收官方传入的 context 参数，
  内部解构 undefined 抛错后被官方 catch 并**跳过整段**，导致「后台指导」实际从未注入成功。
  现四段均已正确接收参数。

### 新增

- **纯工具注入路径补齐上下文**：MVU 官方结算与官方兜底路径此前只拿到「后台指导」一段，
  现由官方 background-agent-task 拼进完整四段（锚点快照 / LTM 动态提示 / 自由栏位注入后台 / 后台指导）。
- **「注入后台」自由栏位**：勾选后可把该栏位内容注入后台结算任务；
  settle 任务消息与 settlementSection 共用同一实现，避免两处文案漂移。
- settlementSection 单段文本上限（8000 字节）诊断：超限仅记录长度，截断交给官方统一处理。

## 2026-10-17

### 修复

- **数据根解析改用 DSHT 官方机制（`DSH_HOME`）**。此前靠「模块所在路径」与「进程 cwd」向上
  推导数据根，在插件以 junction / symlink 形式安装、且 cwd 不在 DSHT 安装目录下时会解析失败
  并静默回退到插件安装位置。现改为优先读取 DSHT 注入的 `DSH_HOME` 环境变量
  （官方 tavern-plugin 即采用此机制），该值与模块从哪个路径加载无关，
  因此 junction / symlink / npm 正式安装均可正确定位。
- 修复解析失败被永久缓存、导致本进程内无法重试的问题；解析失败时不再固化回退目录。

- **移除全部本机绝对路径**，插件不再依赖任何盘符、用户目录或固定层级。
  路径改由 DSHT 安装根 `launcher-settings.xml` 的 `<DataDirectory>` 在运行时推导，
  因此可安装在任意目录、任意操作系统下运行。
- 修正调试日志与请求审计日志的目录解析：此前回退到 `~/.dsh`（该目录通常并不存在）
  导致解析恒失效，被迫改用硬编码路径兜底；现已改为从安装配置推导。

### 变更

- **插件自持数据位置调整**：锚点、会话临时世界书、人格、人格掩码、速输入、
  世界书组合、支线家族，统一改存到 DSHT 用户数据区的
  `plugin-data/narrative-anchor/` 下，不再写入插件安装位置。
  好处是重装或升级插件不会丢失数据；首次启动会自动迁移旧数据。
- 依赖声明由指向本机目录的 `link:` 改为 `peerDependencies`（版本范围），
  由宿主 DSHT 环境提供。
- 发布包排除 `.bak` / `.pre-*` / `.orig` 备份文件。

### 文档

- README 重写：补充安装步骤（通过 profile 的 `package.json` 注册）、环境要求、
  数据存放位置说明，并纠正 v2.x 遗留的"需要应用 DSHT 补丁"这一过期描述
  （v3.0 起已零补丁）。
- **README 按实际代码重新整理**（此前功能描述有多处与代码不符）：
  - 修正 LLM 工具清单：实际只有 `narrative_anchor_read` 与 `narrative_anchor_submit` 两个，
    旧文档里的 `_query` / `_get` / `_settings` 在代码中并不存在；
  - 补全 HTTP API 清单：旧文档仅列 3 个，实际 40+ 个，已按
    世界书 / 分支 / 人格 / 快捷输入 / 预设 / 后台会话分组列出；
  - 补全客户端 UI：实际注册 5 个侧边栏 tab（请求体日志 / 快捷输入 / 会话世界书 / 状态 / 设置），
    另有开始页分组与输入框 dock 按钮，旧文档只写了 2 个；
  - 修正 `injectPosition` 默认值为 `before-rules`（旧文档写 `after-posture`）；
  - 修正「当前状态」合并语义：实为**按字段增量合并**，未提交字段保留上一轮
    （旧文档写"每轮完整替换"）；
  - 标注伏笔库 `foreshadow_library` 已暂停单独维护（伏笔信息自然流入 STM）；
  - 补全子系统说明：会话临时世界书、官方世界书与召回审计、世界书组合、人格与人格掩码、
    快捷输入、支线分支/家族、请求体审计、后台会话治理；
  - 补全锚点数据模型字段（含 `focus` / `focus_full`、`ltm_snapshot`、`free_slots`）。
