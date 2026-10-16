# Narrative Anchor System（叙事锚定系统）

DSH-Tavern 插件：把每轮剧情沉淀为**大纲路线 + 当前状态 + 多级记忆**的结构化锚点，
在下一轮正文与结算之间保持长期叙事连贯。

> 自 v3.0 起**零补丁**——不再修改 DSHT 源码，全部改为官方 plugin-api v2 原生能力。

## 一、锚点数据模型

每轮结算写入一份锚点（`anchors/<sessionId>.json`），结构如下（字段名与代码一致）：

| 区块 | 内容 |
|---|---|
| `plot_route` | 大纲路线：`current_node` 当前剧情节点、`recap` 前情衔接、`next_scene` 下一幕规划、`foreshadowing` 活跃伏笔 |
| `current_state` | 当前状态：`time` / `world` / `location` / `characters[]` / `environment[]` / `items[]` / `focus` / `focus_full`<br>**按字段增量合并**：未提交的字段保留上一轮的值 |
| `memory.stm[]` | 短期记忆：每轮 1 条（`title` + `summary`），**永远累积、不清空**；归并进 LTM 后打 `merged_into` 标记 |
| `memory.ltm_tree` | 长期记忆（树形 `{ nodes, roots, next_id }`）：未合并 STM 累积到阈值（默认 7）→ 生成 depth=1 叶节点；同深度节点累积到阈值（默认 5）→ 归并为更高层节点；根节点过多时由程序兜底归并 |
| `memory.ltm_snapshot` | LTM 快照 `{ content, turn }`，用于前台投影 |
| `memory.known_facts[]` | 已知情报，增量合并。**不注入前台正文**（省 token），需要时用 `narrative_anchor_read` 检索 |
| `memory.foreshadow_library[]` | 伏笔库：字段保留，但**已暂停单独维护**，伏笔信息自然流入 STM |
| `free_slots.list[]` | 自由栏位（v0.10.2）：与 `current_state` / `memory` 同级的自定义顶层字段 |

## 二、子系统

- **后台结算**：非 MVU 卡走 `replaceSettlement`（单次结构化输出提交）；MVU 卡走 `settlementTool`。
- **会话临时世界书**（`session-worldbook.js`）：按会话增删条目、绑定到官方世界书、
  导入/导出（SillyTavern 字典格式）、旁白条目（sideline）同步。
- **官方世界书**（`official-worldbook.js`）：读取 DSHT 世界书、召回审计与历史、
  判断条目是否已在上下文中、更新条目。
- **世界书组合**（`worldbook-combos.js`）：把多个世界书打包成组合，支持全局自动绑定。
- **人格**（`persona.js` / `persona-mask.js`）：结算人格预设的保存、应用、生成条目。
- **快捷输入**（`quick-inputs.js`）：输入模板；界面上有独立的侧边栏 tab，
  并在输入框上方官方按钮行注入「快捷输入」按钮。
- **支线分支 / 家族**（`family.js`）：分支会话的注册、绑定、同步、合并、改名，
  以及家族成员查询（用于读档/重开后延续支线）。
- **请求体审计**（`settlement/request-audit.js`）：记录每轮结算请求体，落盘 `na-request-log.jsonl`，
  可在「结算请求体」tab 中查看。
- **后台会话治理**：拦截后台会话压缩、清空后台会话/DSHT 原生 `background-*` 会话，
  避免长期跑团日志膨胀。

## 三、环境要求

- Node.js >= 18
- **DSHT 2.7.0**（在此版本验证）——需要支持官方 plugin-api v2，即宿主提供：
  - `tavern.replaceSettlement` / `tavern.settlementTool`（后台结算）
  - `tavern.worldbookEntries`（世界书条目注入）
  - `tavern.turnSection` / `tavern.promptSection`（前台注入）
  - `tavernUi.registerStartGroup`（开始页分组）、`betterSidebar`（侧边栏）
- 运行时依赖由宿主提供（`peerDependencies`，无需单独安装）：
  `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`

> 未提供上述 API 的旧版 DSHT 上，对应能力会静默跳过（不报错、不阻断正文）。

## 四、安装

NA 作为 DSHT profile 的一个 **bundle** 运行，注册点在 profile 而非插件自身：

1. 把插件放到 `<DSHT 数据目录>/harness/profiles/tavern/node_modules/narrative-anchor`，
   或用包管理器安装（`npm i narrative-anchor` / pnpm 等）；
2. 编辑同一目录下的 profile `package.json`：
   - 在 `dependencies` 中加入 `"narrative-anchor": "<版本或路径>"`
   - 在 `dsh.profile.bundles` 数组中加入 `"narrative-anchor"`
3. 重启 DSHT。

**不需要修改 DSHT 源码，也没有"打补丁"这一步。**

## 五、数据存放

插件自持数据**不写在插件安装位置**（否则开发时在源码目录、发布时在 node_modules，升级即丢），
而是自动落在 DSHT 用户数据区：

```
<DSHT 数据目录>/harness/profile-data/tavern/data/plugin-data/narrative-anchor/
├── anchors/<sessionId>.json        锚点数据
├── global.json                     全局共享设置（结算人格/任务提示词等）
├── session-worldbooks/             会话临时世界书
└── personas.json / persona-masks.json / quick-inputs.json
    worldbook-combos.json / branch-families.json
```

数据根目录在**运行时**由 DSHT 安装根 `launcher-settings.xml` 的 `<DataDirectory>` 推导
（唯一路径真相源 `lib/paths.js`）：

- 不依赖盘符、安装路径、用户名或固定层级，Windows / macOS / Linux 行为一致；
- 换机器、换盘、改目录名都无需改动任何代码；
- 解析不到时（例如单元测试环境）自动回退到 `<插件根>/data/`；
- 首次启动会把旧版本的 `<插件根>/data/` 内容自动迁移到上述目录。

## 六、架构与注册面

标准 DSH Cordis 插件，与 `dsh-tavern-plugin` 同级。注册方式均为官方 API：

| 能力 | 注册点 |
|---|---|
| 前台当前状态注入 | `tavern.turnSection` |
| 常驻世界书前缀 | `tavern.promptSection` |
| 世界书条目 | `tavern.worldbookEntries`（条目池，覆盖官方召回 / 后台结算 / 候选全路径） |
| 后台结算（非 MVU） | `tavern.replaceSettlement` |
| 后台结算（MVU） | `tavern.settlementTool` |
| 前台/后台流投影 | `ctx.on('llm/stream')` |
| 开始页分组 | `tavernUi.registerStartGroup` |
| 侧边栏 | `ctx.betterSidebar.registerTab` ×5 |
| HTTP API | `webServer.register` 前缀路由 `/api/narrative-anchor` |

调试日志写往 DSHT 桌面日志目录（`na-debug.log`、`na-request-log.jsonl`），
由 `debug` 开关控制。

## 七、配置

`cordis.yml` 中可配置（括号内为代码默认值）：

```yaml
narrative-anchor:
  maxSTMLength: 7            # STM 阈值：未合并 STM 达到该数量后归并进 LTM（默认 7）
  sectionName: narrative-anchor   # section 标识（调试用，默认 narrative-anchor）
  injectPosition: before-rules    # 注入位置，默认 before-rules；值含 'before' 即 before，否则 after
  debug: false               # 是否输出调试日志
  tavernDataRoot: ''         # 留空自动推导；仅在自动推导失败时手工指定用户数据根
```

除上述插件级配置外，还有两类运行时设置（通过 `getConfig` / `setConfig` 读写，保存在自持文件中）：

- **会话级**（`anchors/<sid>.json` 的 `meta.settings`）：`enabled`、`maxSTMLength`、
  `injectPosition`、`projectionReplace`、`skipAllPresentLtm`、`backgroundGuide`
- **全局级**（`global.json`）：`settlePersona`（结算人格）、`settleTaskPrompt`（结算任务提示词）、
  `blockBackgroundCompaction`（拦截后台压缩，默认开）、
  `deleteBackgroundSessionOnBlock`（拦截命中时删除后台会话，默认开）

## 八、LLM 工具

后台结算与前台检索共用这两个工具（定义见 `lib/settlement/strategies.js`）：

| 工具 | 用途 |
|---|---|
| `narrative_anchor_read` | 检索锚点记忆（LTM / 已知情报 / 伏笔）。后台结算中每轮最多 3 次 |
| `narrative_anchor_submit` | 提交本轮锚点（`current_state` / `memory`）。提交即终止本轮结算循环，是最后一步 |

## 九、HTTP API

统一前缀 `POST /api/narrative-anchor/<method>`，方法由路径分发。主要方法：

- **配置与数据**：`getConfig`、`setConfig`、`getData`、`updateData`（人工编辑锚点）、
  `paths`（路径诊断）、`list`（扩展点注册表，v3.0 起固定为空）、
  `requestLog`（请求体审计）、`debug/candidates`、`getPosture`
- **后台结算会话**：`backgroundSessionInfo`、`clearBackgroundSession`、
  `nativeBackgroundSessionsInfo`、`clearNativeBackgroundSessions`、`settlementModelInfo`
- **会话临时世界书**：`worldbook/list`、`worldbook/get`、`worldbook/entry`、
  `worldbook/entries-clear`、`worldbook/import`、`worldbook/import-doc`、
  `worldbook/history`、`worldbook/library`、`worldbook/bind`、
  `worldbook/global-bind`、`worldbook/combos`、`worldbook/select`、`worldbook/settings`
- **支线分支 / 家族**：`branch/list`、`branch/families`、`branch/prepare`、`branch/register`、
  `branch/bind`、`branch/unbind`、`branch/sync`、`branch/merge`、`branch/rename`、
  `branch/inspectSessions`、`branch/injectGreeting`
- **人格**：`persona/list`、`persona/save`、`persona/delete`、`persona/apply`、`persona/genEntry`
- **快捷输入**：`quickinput/list`、`quickinput/save`、`quickinput/delete`
- **预设**：`preset/list`、`preset/addEntry`

## 十、客户端 UI

侧边栏注册 5 个 tab（`order` 越小越靠前）：

| tab | 说明 |
|---|---|
| 结算请求体（`narrative-anchor:request-log`，order 5） | 查看每轮结算请求体 |
| 快捷输入（`narrative-anchor:quick-inputs`，order 6） | 管理输入模板 |
| 会话世界书（`narrative-anchor:worldbook`，order 7） | 管理会话临时世界书 |
| 叙事锚定状态（`narrative-anchor:status`，order 8） | 大纲路线 / 当前状态 / 多级记忆 |
| 叙事锚定设置（`narrative-anchor:settings`，order 9） | 会话设置 + 全局设置 |

此外：开始页注册分组（`tavernUi.registerStartGroup`），
并在输入框上方官方按钮行注入「快捷输入」按钮。

## 十一、许可

MIT
