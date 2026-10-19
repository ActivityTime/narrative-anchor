# 更新日志

本文件随每次发布追加一条，记录该次推送的变更项。

> 说明：`package.json` 的版本字段仍为 `0.8.0`（历史遗留，代码实现实为 v3.x 系列）。
> 在未统一版本号之前，各条目以日期区分。

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
