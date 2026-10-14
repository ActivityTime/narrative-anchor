# narrative-anchor（叙事锚定系统）

DSH-Tavern 的叙事锚定插件：把长程跑团的**大纲路线、多级记忆、当前状态**持续注入游玩上下文，并在每轮正文结束后由后台结算自动更新。

当前实现基于 **官方 plugin-api v2（零源码补丁）**：世界书条目走 `tavern.worldbookEntries`，结算走 `tavern.replaceSettlement` / `tavern.settlementTool`，前台注入走 `tavern.turnSection` / `tavern.promptSection`，UI 走 `tavernUi.registerStartGroup` / `ctx.betterSidebar`。

> 版本说明：`package.json` 的版本字段仍为 0.8.0（历史遗留）；代码实现已迭代至 v3.x（2026-10-10 补丁全部移除，改官方原生接口）。

## 系统要求

- **DSH-Tavern**：官方 **main** 分支（含 plugin-api v2 消费链）。代码对每个 API 做存在性检查，缺失时对应功能自动跳过、不影响其余部分，但完整功能需要以上接口可用。
- **Node.js** ≥ 18。

## 功能（按实际注册面）

### 后台结算
- **非 MVU 卡**：`tavern.replaceSettlement` 接管后台结算——结算轮内模型做单次结构化输出，提交锚点 JSON 后结束；提交失败/超时/无模型配置时抛错并自动退回官方结算。
- **MVU 卡**：`tavern.settlementTool` 参与官方 MVU 结算，提供 `narrative_anchor_read` / `narrative_anchor_submit` 两个结算工具。

### 多级记忆
- **STM 短期记忆**：每轮恰好 1 条，永久累积不清空，每条带 `merged_into` 标记（前台只展示未归并的最近 7 条）。
- **LTM 长期记忆**：树形结构 `ltm_tree`——未归并 STM 达 7 条时生成 depth=1 叶节点；同深度节点达 5 个时归并为更高层；根节点超 10 个由程序兜底合并。
- **已知情报**：增量合并；**伏笔库**：完整替换。

### 前台注入
- **当前状态**（`tavern.turnSection`）：每轮正文请求注入一次（时间/世界/地点/在场人物/关键物品等）。
- **常驻世界书前缀**（`tavern.promptSection`）：Persona / 常驻条目，静态文本、提示词缓存友好。
- **记忆快照投影**（`llm/stream` 中间件）：按需把记忆快照投影进请求。

### 会话世界书（`tavern.worldbookEntries`，两个来源）
- `session`：会话临时条目 + 支线条目 + 人工选择（`force: true` 强制入选）；
- `bound`：会话级绑定世界书条目（`constant` 常驻条目）；
- 人工选择在一次正文写完后由 `tavern.onTurnSettled` 自动清空（一次性消费语义）。

### 前台工具
- `narrative_anchor_read`：检索 STM / 已知情报（`kind` 过滤、`limit` 1–10），供前台模型按需取用。

### HTTP API
`POST /api/narrative-anchor/<method>`，body 为 JSON（常用字段 `sessionId`）：

| 方法 | 用途 |
|---|---|
| `getConfig` / `setConfig` | 会话设置（开关、STM 上限、注入位置、后台指导）+ 全局设置（结算提示词、后台压缩拦截） |
| `getData` | 锚点数据（STM / LTM / 大纲 / 状态 / 统计） |
| `requestLog` | 结算请求体日志（内存缓冲尾部，可带 sessionId 过滤） |
| `backgroundSessionInfo` / `clearBackgroundSession` | NA 后台结算会话信息 / 清空历史（防日志膨胀） |
| `nativeBackgroundSessionsInfo` / `clearNativeBackgroundSessions` | DSHT 原生后台会话（`background-*`）信息 / 清空 |
| `worldbook/*` | 会话世界书读写 |
| `paths` | 关键数据目录的运行时解析路径 |

### 客户端 UI（`ctx.betterSidebar.registerTab` × 5 + 开始页分组）
- **叙事锚定设置**（`narrative-anchor:settings`）：会话设置 + 全局设置两块
- **叙事锚定状态**（`narrative-anchor:status`）：大纲路线 / 当前状态 / 记忆 / 已知情报 / 伏笔
- **会话世界书**（`narrative-anchor:worldbook`）
- **快捷输入**（`narrative-anchor:quick-inputs`）
- **请求体日志**（`narrative-anchor:request-log`）：后台结算请求体审计
- 开始页分组 **「叙事锚定」**（`tavernUi.registerStartGroup`）

### 请求体审计
- 后台结算请求体记录：JSONL 落盘 + 内存环形缓冲 + 写入 tavern `model-requests/` 兼容结构（"完整上下文"面板可见）。
- 日志目录：`config.logDir` 可覆盖，默认 `$DSH_HOME/../desktop/logs`（无 `DSH_HOME` 时 `~/.dsh/../desktop/logs`）；调试日志路径可用环境变量 `NA_DEBUG_LOG` 覆盖。

## 安装

> 前置：DSH-Tavern 已安装并初始化（有 `data/harness/profiles/tavern/` profile 目录）。

```bash
# 1. 获取源码
git clone https://github.com/ActivityTime/narrative-anchor.git
cd narrative-anchor
npm install    # 安装运行时依赖（@deepseek-ai/dsh-tools、@deepseek-ai/schemastery）
```

```powershell
# 2. 注册到 DSHT（在 profile 目录执行）
#    <DSHT 安装目录>\data\harness\profiles\tavern\
#    a) package.json 的 "dependencies" 增加：
#         "narrative-anchor": "link:<上一步的绝对路径>"
#    b) 同一文件 "dsh.profile.bundles" 数组增加：
#         "narrative-anchor"
#    c) 在 profile 的 node_modules 下建立 junction：
#         New-Item -ItemType Junction -Path ".\node_modules\narrative-anchor" -Target "<上一步的绝对路径>"
```

```powershell
# 3. 重启 DSH-Tavern
```

重启后左侧栏出现「叙事锚定」相关标签页，开始页出现「叙事锚定」分组，即安装成功。

## 数据位置

锚点数据只写插件自持文件（官方结算接管下不再写 `chat.narrativeAnchor`）：
- `data/anchors/`：锚点（STM / LTM / 大纲 / 状态 / 伏笔）
- `data/session-worldbooks/`：会话临时世界书
- `data/personas.json`、`data/persona-masks.json`、`data/quick-inputs.json`、`data/worldbook-combos.json`、`data/branch-families.json`：各功能模块数据

具体路径由运行时解析（HTTP API `paths` 可查）。

## 许可

MIT（见 [LICENSE](LICENSE)）。
