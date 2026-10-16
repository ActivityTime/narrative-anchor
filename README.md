# Narrative Anchor System

DSH-Tavern 叙事锚定系统插件：将原生姿势系统的设计哲学重新定位为**大纲路线 + 多级记忆 + 当前状态**的综合叙事锚定系统。

## 功能

- **大纲路线**：当前剧情节点、前情衔接、下一幕规划、活跃伏笔
- **当前状态**：时间、世界、地点、在场人物、环境、关键物品（每轮完整替换）
- **多级记忆**：
  - STM 短期记忆（每轮恰好 1 条，永远累积不清空，merged_into 标记是否已归并）
  - LTM 长期记忆（树形 ltm_tree：未合并 STM 每 7 条 → depth1 叶节点；同深度每 5 个节点 → 归并更高层；根节点超 10 个由程序兜底合并）
  - 已知情报（增量合并）
  - 伏笔库（完整替换）
- **会话临时世界书**：按会话增删条目，可强制注入官方召回链路

## 环境要求

- Node.js >= 18
- **DSHT 2.7.0**（在此版本验证）——需要支持官方 plugin-api v2，即提供：
  - `tavern.replaceSettlement` / `tavern.settlementTool`（后台结算）
  - `tavern.worldbookEntries`（世界书条目注入）
  - `tavernUi.registerStartGroup`（开始页分组）
- 宿主提供的运行时依赖（`peerDependencies`，由 DSHT 环境提供，无需单独安装）：
  - `@deepseek-ai/dsh-tools`
  - `@deepseek-ai/schemastery`

## 安装

NA 作为 DSHT profile 的一个 **bundle** 运行，注册点在 profile 而非插件自身：

1. 把插件放到 `<DSHT 数据目录>/harness/profiles/tavern/node_modules/narrative-anchor`，
   或用包管理器安装（`npm i narrative-anchor` / pnpm 等）；
2. 编辑同一目录下的 profile `package.json`：
   - 在 `dependencies` 中加入 `"narrative-anchor": "<版本或路径>"`
   - 在 `dsh.profile.bundles` 数组中加入 `"narrative-anchor"`
3. 重启 DSHT。

> **不需要修改 DSHT 源码。** 本插件自 v3.0 起已移除全部扩展注册点补丁，
> 改为官方 plugin-api v2 原生能力，因此不存在"打补丁"这一步。

## 数据存放

插件自持数据**不写在插件安装位置**（否则开发时在源码目录、发布时在 node_modules，升级即丢），
而是自动落在 DSHT 用户数据区：

```
<DSHT 数据目录>/harness/profile-data/tavern/data/plugin-data/narrative-anchor/
├── anchors/<sessionId>.json      锚点数据
├── session-worldbooks/           会话临时世界书
└── personas.json / persona-masks.json / quick-inputs.json
    worldbook-combos.json / branch-families.json
```

数据根目录在**运行时**由 DSHT 安装根 `launcher-settings.xml` 的 `<DataDirectory>` 推导：

- 不依赖盘符、安装路径、用户名或固定层级，Windows / macOS / Linux 行为一致；
- 换机器、换盘、改目录名都无需改动任何代码；
- 解析不到时（例如单元测试环境）自动回退到 `<插件根>/data/`。

首次启动会把旧版本的 `<插件根>/data/` 内容自动迁移到上述目录。

## 架构

- 标准 DSH Cordis 插件，与 dsh-tavern-plugin 同级
- 世界书条目：`tavern.worldbookEntries`（条目池，官方召回 / 后台结算 / 候选全路径）
- 结算：非 MVU 卡走 `replaceSettlement`；MVU 卡走 `settlementTool`（read / submit）
- 前台注入：`llm/stream` 中间件（foreground section / 记忆投影）
- 开始页分组：`tavernUi.registerStartGroup`
- 调试日志写往 DSHT 桌面日志目录（`na-debug.log`、`na-request-log.jsonl`）

## 配置

```yaml
# cordis.yml 中可配置
narrative-anchor:
  maxSTMLength: 7        # STM 阈值（设置项保留；当前结算链实际阈值内置 7）
  sectionName: narrative-anchor  # section kind 名称
  injectPosition: after-posture  # 注入位置
  debug: false            # 调试日志
  tavernDataRoot: ''      # 留空自动推导；仅在自动推导失败时手工指定用户数据根
```

## 工具

- `narrative_anchor_submit`（后台）：提交锚定数据
- `narrative_anchor_query`（前台）：查询 LTM / 已知情报 / 伏笔
- `narrative_anchor_get`（前台）：获取完整锚定数据
- `narrative_anchor_settings`（前台）：查看 / 修改设置

## HTTP API

- `POST /api/narrative-anchor/getConfig`
- `POST /api/narrative-anchor/setConfig`
- `POST /api/narrative-anchor/getData`

## 客户端 UI

- 叙事锚定设置（侧边栏 tab）
- 叙事锚定状态（侧边栏 tab）

## 许可

MIT
