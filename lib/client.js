/**
 * Narrative Anchor System - Client (浏览器 WebUI 侧入口)
 *
 * 使用 DSH 客户端模块系统的 factory 格式（与 dsh-pocket-console 一致），
 * 无需构建步骤即可安装。
 *
 * 注册两个侧边栏 tab：
 *   - 叙事锚定设置：开关、STM上限、注入位置、重置数据
 *   - 叙事锚定状态：展示大纲路线、当前状态、多级记忆
 *
 * 与后端通信：fetch("/api/narrative-anchor/<method>", POST JSON)
 */
window.__ModuleLoader__.load({
  id: "narrative-anchor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react')
    const h = React.createElement

    // LLM 提交的字段可能是嵌套对象（如 current_state.environment = {环境: …}），
    // 直接当 React 子节点渲染会抛 Minified React error #31 —— 统一文本化兜底
    function asText(value) {
      if (value === null || value === undefined || value === false) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'object') {
        try { return JSON.stringify(value) } catch { return String(value) }
      }
      return String(value)
    }
    const ReactDOM = require('react-dom')

    // [v0.9.5] 会话临时世界书导出：把临时条目转为 SillyTavern 世界书 JSON
    // （{ entries: { <uid>: {...} } } 字典格式 —— DSHT identifyWorldbook 识别为
    //   sillytavern-worldbook，可直接导入独立世界书库 / 原版 ST）。返回导出条数，0 = 无条目。
    function exportTempWorldbook(book, sessionId) {
      const list = Array.isArray(book?.entries) ? book.entries : []
      if (list.length === 0) return 0
      const out = {
        name: '会话临时世界书',
        entries: {}
      }
      list.forEach((e, i) => {
        const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : []
        const secondary = Array.isArray(e.keysecondary) ? e.keysecondary.filter(Boolean) : []
        out.entries[String(i)] = {
          uid: i,
          key: keys,
          keysecondary: secondary,
          comment: String(e.title || ('条目 ' + i)),
          content: String(e.content || ''),
          disable: e.enabled === false,
          constant: false,
          selective: secondary.length > 0,
          selectiveLogic: 0,
          addMemo: true,
          order: 100,
          position: 0,
          excludeRecursion: false,
          preventRecursion: false,
          delayUntilRecursion: 0,
          probability: 100,
          useProbability: true,
          depth: 4,
          group: '',
          displayIndex: i
        }
      })
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = '临时世界书-' + String(sessionId || 'session').slice(0, 8) + '-' + new Date().toISOString().slice(0, 10) + '.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return list.length
    }

    // [v0.9.5] 通用编辑弹层：遮罩 + 居中卡片；ESC / 点击遮罩关闭，点卡片不冒泡。
    // 相比内联表单：不挤占页面流、编辑时视线聚焦、随时可放弃。
    function EditModal({ title, onClose, footer, children }) {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      return ReactDOM.createPortal(
        h('div', {
          onMouseDown: onClose,
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483000,
            background: 'rgba(15,18,24,.5)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '8vh 16px 16px', overflowY: 'auto'
          }
        },
          h('div', {
            onMouseDown: (e) => e.stopPropagation(),
            style: {
              width: 'min(560px, 100%)', background: 'var(--na-card, #fff)',
              border: '1px solid var(--na-border, #e2e5ea)', borderRadius: 10,
              boxShadow: '0 12px 40px rgba(0,0,0,.35)', padding: '14px 16px'
            }
          },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
              h('h3', { style: { margin: 0, fontSize: 14 } }, title),
              h('button', { className: 'dsh-local-btn', title: '关闭（ESC）', onClick: onClose }, '✕')
            ),
            children,
            footer ? h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } }, footer) : null
          )
        ),
        document.body
      )
    }

    exports.apply = function(ctx) {

  // ========== 页面主题样式（na-page 作用域，避免影响 DSHT 官方面板）==========
  if (!document.getElementById('na-page-style')) {
    const naStyle = document.createElement('style')
    naStyle.id = 'na-page-style'
    naStyle.textContent = `.na-page {
  --na-card:#ffffff; --na-card-soft:#f6f7f9; --na-card-hover:#f0f2f5;
  --na-border:#e2e5ea; --na-border-hover:#c9ced6;
  --na-text:#1d2129; --na-dim:#68707c; --na-heading:#10141a;
  --na-accent:#3b6fd4; --na-accent-soft:rgba(59,111,212,.1);
  --na-green:#188a52; --na-red:#d23f47; --na-amber:#a96a0e; --na-blue:#4a6dc6; --na-purple:#8a4ad6; --na-pink:#c2185b; --na-cyan:#00879b;
  --na-btn:#eef0f3; --na-btn-border:#d8dce1; --na-btn-hover:#e2e6ec;
  --na-input-bg:#f2f3f5; --na-hover:rgba(0,0,0,.04);
  --na-warn-bg:#fff7e6; --na-warn-border:rgba(169,106,14,.35);
  font-size:13px; color:var(--na-text);
}
@media (prefers-color-scheme: dark) {
  .na-page {
    --na-card:#1b1e25; --na-card-soft:#161a21; --na-card-hover:#20242d;
    --na-border:#2b303c; --na-border-hover:#3a4152;
    --na-text:#dde3ec; --na-dim:#8a93a5; --na-heading:#ffffff;
    --na-accent:#5b8def; --na-accent-soft:rgba(91,141,239,.14);
    --na-green:#4ec08a; --na-red:#e0595f; --na-amber:#e0a94a; --na-blue:#9fb4e8; --na-purple:#b79aeb; --na-pink:#f48fb1; --na-cyan:#67c6dc;
    --na-btn:#262b36; --na-btn-border:#3a4152; --na-btn-hover:#2f3644;
    --na-input-bg:#14161b; --na-hover:rgba(255,255,255,.035);
    --na-warn-bg:rgba(224,169,74,.1); --na-warn-border:rgba(224,169,74,.32);
  }
}
.na-page * { box-sizing:border-box; }
.na-page h2 { font-size:16px; margin:0 0 10px; color:var(--na-heading); letter-spacing:.02em; display:flex; align-items:center; gap:8px; font-weight:600; }
.na-page h2::before { content:''; width:4px; height:16px; border-radius:2px; background:linear-gradient(180deg,var(--na-accent),var(--na-blue)); flex:none; }
.na-page h3 { font-size:12px; margin:0 0 10px; color:var(--na-dim); letter-spacing:.1em; font-weight:600; border-left:3px solid var(--na-accent); padding-left:8px; text-transform:uppercase; }
.na-page .dsh-local-section { background:var(--na-card); border:1px solid var(--na-border); border-radius:10px; padding:12px 12px 14px; margin-bottom:10px; transition:border-color .15s; }
.na-page .dsh-local-section:hover { border-color:var(--na-border-hover); }
.na-page label { display:flex; align-items:flex-start; gap:9px; padding:6px 7px; border-radius:7px; cursor:pointer; color:var(--na-text); font-size:12.5px; line-height:1.5; }
.na-page label:hover { background:var(--na-hover); }
.na-page label > span:first-child { flex:1; }
.na-page label input[type=checkbox] { margin-top:2px; width:14px; height:14px; accent-color:var(--na-accent); cursor:pointer; flex:none; }
.na-page input[type=checkbox] { accent-color:var(--na-accent); cursor:pointer; }
.na-page .dsh-local-btn { background:var(--na-btn); color:var(--na-text); border:1px solid var(--na-btn-border); border-radius:7px; padding:4px 11px; font-size:12px; cursor:pointer; transition:all .15s; line-height:1.5; }
.na-page .dsh-local-btn:hover { background:var(--na-btn-hover); border-color:var(--na-accent); color:var(--na-heading); }
.na-page .dsh-local-btn[disabled] { opacity:.45; cursor:not-allowed; }
.na-page .dsh-local-btn.na-tab-active { background:var(--na-accent); border-color:var(--na-accent); color:#fff; font-weight:600; }
.na-page .dsh-tavern-btn { background:var(--na-btn); color:var(--na-text); border:1px solid var(--na-btn-border); border-radius:7px; padding:4px 11px; font-size:12px; cursor:pointer; transition:all .15s; }
.na-page .dsh-tavern-btn:hover { background:var(--na-btn-hover); border-color:var(--na-accent); color:var(--na-heading); }
.na-page .dsh-tavern-btn-danger { background:rgba(210,63,71,.08) !important; border-color:rgba(210,63,71,.35) !important; color:var(--na-red) !important; }
.na-page .dsh-tavern-btn-danger:hover { background:rgba(210,63,71,.14) !important; }
@media (prefers-color-scheme: dark) {
  .na-page .dsh-tavern-btn-danger { background:rgba(224,89,95,.15) !important; border-color:rgba(224,89,95,.4) !important; color:#f0b3b6 !important; }
  .na-page .dsh-tavern-btn-danger:hover { background:rgba(224,89,95,.25) !important; }
}
.na-page .dsh-local-input { background:var(--na-input-bg); border:1px solid var(--na-border); border-radius:7px; color:var(--na-text); padding:6px 9px; font-size:12.5px; }
.na-page .dsh-local-input:focus { outline:none; border-color:var(--na-accent); box-shadow:0 0 0 2px var(--na-accent-soft); }
.na-page textarea.dsh-local-input { font-family:inherit; line-height:1.5; }
.na-page select.dsh-local-input { min-height:30px; }
.na-page .dsh-local-help { color:var(--na-dim); font-size:12px; line-height:1.65; margin:4px 0; }
.na-page .dsh-local-warning { color:var(--na-red); background:rgba(210,63,71,.08); border:1px solid rgba(210,63,71,.3); border-radius:7px; padding:7px 10px; font-size:12px; line-height:1.5; }
@media (prefers-color-scheme: dark) {
  .na-page .dsh-local-warning { background:rgba(224,89,95,.1); border-color:rgba(224,89,95,.3); color:#f0b3b6; }
}
.na-page .dsh-tavern-settings-desc { display:block; color:var(--na-dim); font-size:11.5px; margin-top:2px; letter-spacing:0; text-transform:none; }
.na-page .dsh-local-entry { background:var(--na-card-soft); border:1px solid var(--na-border) !important; border-radius:8px; transition:border-color .15s, background .15s; }
.na-page .dsh-local-entry:hover { border-color:var(--na-accent) !important; background:var(--na-card-hover); }
.na-page .dsh-tavern-stats-grid, .na-page .dsh-tavern-state-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:8px; }
.na-page .dsh-tavern-stats-grid > div, .na-page .dsh-tavern-state-grid > div { background:var(--na-card-soft); border:1px solid var(--na-border); border-radius:8px; padding:9px 10px; text-align:center; }
.na-page .dsh-tavern-stats-grid b { display:block; font-size:20px; color:var(--na-heading); line-height:1.3; }
.na-page .dsh-tavern-stats-grid span { font-size:11px; color:var(--na-dim); }
.na-page .dsh-tavern-state-grid > div { text-align:left; font-size:12.5px; color:var(--na-text); line-height:1.5; }
.na-page .dsh-tavern-state-grid b { color:var(--na-blue); font-size:12px; }
.na-page ol, .na-page ul { margin:4px 0; padding-left:20px; }
.na-page li { margin:5px 0; line-height:1.55; font-size:12.5px; color:var(--na-text); }
.na-page .dsh-tavern-status-head { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.na-page .dsh-tavern-status-head strong { font-size:15px; color:var(--na-heading); }
.na-badge { display:inline-flex; align-items:center; padding:1px 8px; border-radius:20px; font-size:10.5px; line-height:1.7; font-weight:500; letter-spacing:.02em; margin-right:4px; white-space:nowrap; }
.na-badge.na-b-in { background:rgba(24,138,82,.12); color:var(--na-green); }
.na-badge.na-b-out { background:rgba(104,112,124,.12); color:var(--na-dim); }
.na-badge.na-b-force { background:rgba(169,106,14,.14); color:var(--na-amber); }
.na-badge.na-b-const { background:rgba(74,109,198,.12); color:var(--na-blue); }
.na-badge.na-b-constant { background:rgba(138,74,214,.14); color:var(--na-purple); }
.na-badge.na-b-off { background:rgba(210,63,71,.12); color:var(--na-red); }
.na-badge.na-b-ok { background:rgba(24,138,82,.12); color:var(--na-green); }
.na-badge.na-b-ext { background:rgba(120,80,190,.14); color:#9b6de3; }
.na-badge.na-b-temp { background:rgba(194,24,91,.13); color:var(--na-pink); }
.na-badge.na-b-ctx { background:rgba(0,135,155,.13); color:var(--na-cyan); }
.na-badge.na-b-bound { background:rgba(234,88,12,.13); color:#ea580c; }
.na-badge.na-b-warn { background:rgba(169,106,14,.14); color:var(--na-amber); }
.na-badge.na-b-pred { background:rgba(130,160,40,.14); color:#6f8f1f; }
@media (prefers-color-scheme: dark) {
  .na-badge.na-b-in, .na-badge.na-b-ok { background:rgba(78,192,138,.15); color:var(--na-green); }
  .na-badge.na-b-temp { background:rgba(244,143,177,.15); color:var(--na-pink); }
  .na-badge.na-b-ctx { background:rgba(103,198,220,.16); color:var(--na-cyan); }
  .na-badge.na-b-out { background:rgba(138,147,165,.13); color:var(--na-dim); }
  .na-badge.na-b-ext { background:rgba(156,112,230,.16); color:#ad82e8; }
  .na-badge.na-b-force, .na-badge.na-b-warn { background:rgba(224,169,74,.18); color:var(--na-amber); }
  .na-badge.na-b-const { background:rgba(159,180,232,.15); color:var(--na-blue); }
  .na-badge.na-b-bound { background:rgba(255,138,76,.16); color:#fb923c; }
  .na-badge.na-b-constant { background:rgba(183,154,235,.16); color:var(--na-purple); }
  .na-badge.na-b-off { background:rgba(224,89,95,.15); color:var(--na-red); }
  .na-badge.na-b-pred { background:rgba(170,200,70,.16); color:#b9d64c; }
}
.na-inject-bar { display:flex; align-items:center; gap:6px; background:var(--na-warn-bg); border:1px solid var(--na-warn-border); color:var(--na-amber); border-radius:8px; padding:6px 10px; font-size:12px; margin-bottom:10px; }
.na-page .dsh-tavern-status-body { padding:0 2px; }
/* v0.9.20: DSHT 全局 user-select:none 会继承到输入框（Chromium/Electron 下导致 input 文本无法选中、光标难以定位），页面内一律放开 */
.na-page input, .na-page textarea { user-select: text; -webkit-user-select: text; cursor: text; }
.na-page select { user-select: none; -webkit-user-select: none; }

`
    document.head.appendChild(naStyle)
  }

  // ========== 工具函数 ==========
  // v0.10.5：字节格式化（B / KB / MB）——全局，SettingsTab 与 StatusTab 共用
  function formatBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B'
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    return (n / (1024 * 1024)).toFixed(1) + ' MB'
  }

  // ========== 后端 API 调用 ==========
  async function api(method, payload = {}) {
    // 15s 超时：防止请求挂起导致 busy 卡死（保存按钮/编辑区永久禁用）
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null
    try {
      const res = await fetch('/api/narrative-anchor/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      })
      return res.json()
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // ========== 设置页面组件 ==========
  function NarrativeAnchorSettingsTab(props) {
    const sessionId = props.scope?.sessionId || props.sessionId
    const [loaded, setLoaded] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [notice, setNotice] = React.useState('')
    const [enabled, setEnabled] = React.useState(true)
    const [maxSTMLength, setMaxSTMLength] = React.useState(7)
    const [injectPosition, setInjectPosition] = React.useState('before-guide')
    const [projectionReplace, setProjectionReplace] = React.useState(false)
    const [skipAllPresentLtm, setSkipAllPresentLtm] = React.useState(true)
    const [settlePersona, setSettlePersona] = React.useState('')
    const [settleTaskPrompt, setSettleTaskPrompt] = React.useState('')
    const [settlePersonaCustomized, setSettlePersonaCustomized] = React.useState(false)
    const [settleTaskPromptCustomized, setSettleTaskPromptCustomized] = React.useState(false)
    // v3.6（2026-10-20）：酒馆后台叙事锚定结算协议提示词（全局设置，与 settlePersona/settleTaskPrompt 同级）
    const [backendSettleProtocol, setBackendSettleProtocol] = React.useState('')
    const [backendSettleProtocolCustomized, setBackendSettleProtocolCustomized] = React.useState(false)
    // v3.1（2026-10-10）：拦截后台会话压缩开关（global.json blockBackgroundCompaction，默认 true）
    const [blockBackgroundCompaction, setBlockBackgroundCompaction] = React.useState(true)
    // v3.5（2026-10-15）：拦截时删除对应后台会话开关（global.json，默认 true；
    // 仅在拦截开启时生效，主开关关闭时自动失效并置灰）
    const [deleteBackgroundSessionOnBlock, setDeleteBackgroundSessionOnBlock] = React.useState(true)
    // 已保存值快照（load 时更新）：用于「保存此项」dirty 判定（未修改禁用，参考 DSHT 提示词页）
    const [savedPersona, setSavedPersona] = React.useState('')
    const [savedTaskPrompt, setSavedTaskPrompt] = React.useState('')
    const [savedBackendSettleProtocol, setSavedBackendSettleProtocol] = React.useState('')
    // 剧情压缩保留轮数（DSHT tavern 全局设置 contextCompaction.retainRounds，非本插件配置）：
    // 显示当前生效值，保存走 /api/dsh-tavern/updateTavernSettings；0=全量摘要，>0=保留最近 N 轮原文。
    const [retainRounds, setRetainRounds] = React.useState(10)
    const [savedRetainRounds, setSavedRetainRounds] = React.useState(10)
    const [stats, setStats] = React.useState({ stm_count: 0, stm_unmerged: 0, ltm_root_count: 0, ltm_total_nodes: 0, known_facts_count: 0, foreshadow_count: 0, turn_count: 0 })
    // v3.4：后台会话管理（NA 结算会话 na-background-* + DSHT 原生后台会话 background-*）
    const [naBgSession, setNaBgSession] = React.useState(null) // { sessionId, exists, bytes, busy }
    const [naBgClearing, setNaBgClearing] = React.useState(false)
    const [nativeBgSession, setNativeBgSession] = React.useState(null) // { count, totalBytes, dirs }
    const [nativeBgClearing, setNativeBgClearing] = React.useState(false)
    const [paths, setPaths] = React.useState({})
    const [pathsError, setPathsError] = React.useState('')
    const pathsLoadedRef = React.useRef(false)
    const busyRef = React.useRef(false)
    // 提示词编辑焦点跟踪：编辑期间轮询 load() 跳过该字段刷新，防止草稿被覆盖（DSHT 提示词页无轮询）
    const promptEditingRef = React.useRef('') // '' | 'persona' | 'task' | 'protocol'

    // ── 提示词草稿持久化（localStorage）──
    // 背景：侧边栏 tab 切换会卸载设置组件 → React state（草稿）销毁 → 重挂载 load() 显示服务端旧值，
    // 未保存的编辑内容全部丢失（用户已多次遇到）。这里让"编辑即存"：onChange 写入 localStorage，
    // 组件挂载/load 时自动恢复草稿（切走/刷新/重开都不丢），保存成功或恢复默认才清除对应字段。
    // key 按会话隔离；草稿与服务端值相同视为已保存，自动清理。
    const draftKey = () => 'na-prompt-draft-' + sessionId
    function readDraft() {
      try { return JSON.parse(localStorage.getItem(draftKey()) || 'null') } catch { return null }
    }
    function writeDraft(patch) {
      try { localStorage.setItem(draftKey(), JSON.stringify({ ...(readDraft() || {}), ...patch, ts: Date.now() })) } catch { /* localStorage 不可用不影响主功能 */ }
    }
    function clearDraftField(field) {
      try {
        const next = readDraft() || {}
        delete next[field]
        if (Object.keys(next).length > 1) localStorage.setItem(draftKey(), JSON.stringify(next))
        else localStorage.removeItem(draftKey())
      } catch { /* ignore */ }
    }
    function clearAllDraft() {
      try { localStorage.removeItem(draftKey()) } catch { /* ignore */ }
    }

    async function load() {
      setError('')
      try {
        const result = await api('getConfig', { sessionId })
        if (result.ok) {
          setEnabled(result.settings.enabled)
          setMaxSTMLength(result.settings.maxSTMLength)
          setInjectPosition(result.settings.injectPosition)
          setProjectionReplace(!!result.settings.projectionReplace)
          setSkipAllPresentLtm(result.settings.skipAllPresentLtm !== false)
          // 全局设置（v2 2026-10-10）：结算提示词全局共享（global.json），不按会话保存。
          const gs = result.globalSettings || {}
          // 草稿恢复：localStorage 里的未保存草稿若与服务端当前值不同 → 优先显示草稿并提示
          //（这是"切换丢失"的召回机制：上次编辑但未保存的内容，重开/切换后自动回来）。
          const draft = readDraft()
          const draftPersona = draft && typeof draft.settlePersona === 'string' && draft.settlePersona !== (gs.settlePersona || '')
          const draftTask = draft && typeof draft.settleTaskPrompt === 'string' && draft.settleTaskPrompt !== (gs.settleTaskPrompt || '')
          const draftProtocol = draft && typeof draft.backendSettleProtocol === 'string' && draft.backendSettleProtocol !== (gs.backendSettleProtocol || '')
          if (promptEditingRef.current !== 'persona') {
            setSettlePersona(draftPersona ? draft.settlePersona : (gs.settlePersona || ''))
            setSettlePersonaCustomized(!!gs.settlePersonaCustomized)
          }
          if (promptEditingRef.current !== 'task') {
            setSettleTaskPrompt(draftTask ? draft.settleTaskPrompt : (gs.settleTaskPrompt || ''))
            setSettleTaskPromptCustomized(!!gs.settleTaskPromptCustomized)
          }
          if (promptEditingRef.current !== 'protocol') {
            setBackendSettleProtocol(draftProtocol ? draft.backendSettleProtocol : (gs.backendSettleProtocol || ''))
            setBackendSettleProtocolCustomized(!!gs.backendSettleProtocolCustomized)
          }
          setSavedPersona(gs.settlePersona || '')
          setSavedTaskPrompt(gs.settleTaskPrompt || '')
          setSavedBackendSettleProtocol(gs.backendSettleProtocol || '')
          // v3.1（2026-10-10）：后台会话压缩拦截开关（全局生效，默认 true）
          setBlockBackgroundCompaction(gs.blockBackgroundCompaction !== false)
          setDeleteBackgroundSessionOnBlock(gs.deleteBackgroundSessionOnBlock !== false)
          // 剧情压缩保留轮数：读 DSHT tavern 全局设置当前生效值（只读展示，非本插件配置）
          try {
            const tr = await fetch('/api/dsh-tavern/getTavernSettings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(r => r.json())
            const cc = tr && tr.settings && tr.settings.contextCompaction
            if (cc && Number.isInteger(cc.retainRounds)) {
              setRetainRounds(cc.retainRounds)
              setSavedRetainRounds(cc.retainRounds)
            }
          } catch { /* tavern 读不到时保持默认 10，不阻塞设置页 */ }
          if (draftPersona || draftTask || draftProtocol) setNotice('已恢复上次未保存的提示词草稿（编辑即存，切换/刷新不再丢失；保存或恢复默认后清除）')
          setStats(result.stats)
          // v3.4：后台会话信息（失败不阻塞设置页）
          try {
            const naInfo = await api('backgroundSessionInfo', { sessionId })
            if (naInfo && naInfo.ok) setNaBgSession(naInfo)
          } catch { /* 忽略 */ }
          try {
            const natInfo = await api('nativeBackgroundSessionsInfo', {})
            if (natInfo && natInfo.ok) setNativeBgSession(natInfo)
          } catch { /* 忽略 */ }
          setLoaded(true)
        } else {
          setError(result.error || '加载失败')
        }
      } catch (err) { setError(String(err.message || err)) }
    }
    // 路径信息：折叠框首次展开时才拉取一次（不进 8 秒轮询）
    async function loadPaths() {
      if (pathsLoadedRef.current) return
      pathsLoadedRef.current = true
      try {
        const result = await api('paths', {})
        if (result.ok) { setPaths(result.paths || {}); setPathsError('') }
        else { setPathsError(result.error || '未知错误'); pathsLoadedRef.current = false }
      } catch (err) { setPathsError(String(err.message || err)); pathsLoadedRef.current = false }
    }

    React.useEffect(() => {
      void load()
      // 不设定时轮询（会打断编辑/交互，对齐 DSHT 提示词页）；仅页面切回可见时刷新一次
      const onVis = () => { if (!document.hidden && !busyRef.current) void load() }
      document.addEventListener('visibilitychange', onVis)
      return () => { document.removeEventListener('visibilitychange', onVis) }
    }, [])

    async function save(patch) {
      if (busy || !loaded) return
      setBusy(true); busyRef.current = true; setError(''); setNotice('')
      try {
        const result = await api('setConfig', { sessionId, ...patch })
        if (result.ok) {
          setNotice(result.note || '已保存')
          // 保存成功 → 清除已保存字段的草稿（恢复默认' '同样清除：回默认即丢弃草稿）；
          // 提示词字段本地落状态（草稿=保存值，避免 load 重设引发焦点/内容闪动）。
          if ('settlePersona' in patch) {
            if (patch.settlePersona !== '') { setSettlePersonaCustomized(true); setSavedPersona(patch.settlePersona) }
            clearDraftField('settlePersona')
          }
          if ('settleTaskPrompt' in patch) {
            if (patch.settleTaskPrompt !== '') { setSettleTaskPromptCustomized(true); setSavedTaskPrompt(patch.settleTaskPrompt) }
            clearDraftField('settleTaskPrompt')
          }
          if ('backendSettleProtocol' in patch) {
            if (patch.backendSettleProtocol !== '') { setBackendSettleProtocolCustomized(true); setSavedBackendSettleProtocol(patch.backendSettleProtocol) }
            clearDraftField('backendSettleProtocol')
          }
          if ('blockBackgroundCompaction' in patch) setBlockBackgroundCompaction(!!patch.blockBackgroundCompaction)
          if ('deleteBackgroundSessionOnBlock' in patch) setDeleteBackgroundSessionOnBlock(!!patch.deleteBackgroundSessionOnBlock)
          void load()
        } else {
          setError(result.error || '保存失败')
        }
      } catch (err) { setError(String(err.message || err)) }
      finally { setBusy(false); busyRef.current = false }
    }

    // 保存剧情压缩保留轮数：tavern 的 compactionPolicy 会以 patch 对象为准重置未传字段，
    // 因此必须先读当前完整 contextCompaction（mode/rounds/percent/revision），只改 retainRounds 再回写。
    // target 省略时使用当前输入框值；恢复默认（10）时由按钮显式传入。
    async function saveRetainRounds(target) {
      if (busy || !loaded) return
      const value = Math.max(0, Math.min(100, Math.floor(target !== undefined ? target : retainRounds)))
      if (value === savedRetainRounds) return
      setBusy(true); busyRef.current = true; setError(''); setNotice('')
      try {
        const tr = await fetch('/api/dsh-tavern/getTavernSettings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then(r => r.json())
        const cc = (tr && tr.settings && tr.settings.contextCompaction) || { mode: 'manual', rounds: 20, percent: 80 }
        const res = await fetch('/api/dsh-tavern/updateTavernSettings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: { contextCompaction: Object.assign({}, cc, { retainRounds: value }) } }) }).then(r => r.json())
        if (res && res.ok) {
          setRetainRounds(value)
          setSavedRetainRounds(value)
          setNotice('已保存：压缩保留轮数 = ' + value + '（对全部游玩/剧本会话生效，下一个安全边界生效）')
        } else {
          setError((res && res.error) || '保存失败')
        }
      } catch (err) { setError(String(err.message || err)) }
      finally { setBusy(false); busyRef.current = false }
    }

    // v3.4：清空 NA 后台结算会话（na-background-*）
    async function clearNaBgSession() {
      const sizeText = naBgSession && naBgSession.exists ? formatBytes(naBgSession.bytes) : '0 B'
      const busyWarn = naBgSession && naBgSession.busy ? '\n\n⚠ 当前有结算任务在运行，清空将中断该轮结算。' : ''
      if (!window.confirm('确定清空本会话的 NA 后台结算历史吗？\n\n将删除后台结算会话的全部历史（当前 ' + sizeText + '），并在下次结算时自动新建空会话。\n\n锚点数据不受影响（存于插件自持文件）。' + busyWarn)) return
      setNaBgClearing(true)
      try {
        const result = await api('clearBackgroundSession', { sessionId })
        if (result && result.ok) {
          const freed = result.freedBytes || 0
          const freedText = freed > 0 ? formatBytes(freed) : '0 B'
          setNotice('✓ 已清空 NA 后台会话历史（释放 ' + freedText + '）')
          try {
            const info = await api('backgroundSessionInfo', { sessionId })
            if (info && info.ok) setNaBgSession(info)
          } catch { /* 忽略 */ }
        } else {
          setError((result && result.error) || '清空失败')
        }
      } catch (err) { setError(String(err.message || err)) }
      finally { setNaBgClearing(false) }
    }

    // v3.4：清空所有 DSHT 原生后台会话（background-*）
    async function clearNativeBgSession() {
      const count = nativeBgSession ? nativeBgSession.count : 0
      const sizeText = nativeBgSession ? formatBytes(nativeBgSession.totalBytes) : '0 B'
      if (!window.confirm('确定清空全部 DSHT 原生后台会话吗？\n\n将删除所有官方后台任务会话（background-*，当前 ' + count + ' 个，共 ' + sizeText + '），包括结算、候选生成、压缩等后台任务的持久会话。\n\n下次后台任务运行时自动新建空会话。游玩会话与锚点数据不受影响。')) return
      setNativeBgClearing(true)
      try {
        const result = await api('clearNativeBackgroundSessions', {})
        if (result && result.ok) {
          const freed = result.freedBytes || 0
          const freedText = freed > 0 ? formatBytes(freed) : '0 B'
          setNotice('✓ 已清空 ' + (result.cleared || 0) + ' 个原生后台会话（释放 ' + freedText + '）')
          try {
            const info = await api('nativeBackgroundSessionsInfo', {})
            if (info && info.ok) setNativeBgSession(info)
          } catch { /* 忽略 */ }
        } else {
          setError((result && result.error) || '清空失败')
        }
      } catch (err) { setError(String(err.message || err)) }
      finally { setNativeBgClearing(false) }
    }

    return h('aside', { className: 'dsh-tavern-status dsh-local-settings na-page', 'aria-label': '叙事锚定设置' },
      h('div', { className: 'dsh-tavern-status-head' }, h('strong', null, '叙事锚定设置')),
      h('div', { className: 'dsh-tavern-status-body' },
        h('p', { className: 'dsh-local-intro' }, '会话设置仅影响本局（自动保存，后台结算从下一轮生效）；下方全局设置对全部会话生效。'),

        // 开关
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '总开关'),
          h('label', { className: 'dsh-tavern-background-task' },
            h('span', null, '启用叙事锚定后台结算',
              h('span', { className: 'dsh-tavern-settings-desc' }, '关闭后不注入 system prompt 和工具，已有数据保留。')),
            h('input', { type: 'checkbox', role: 'switch', 'aria-label': '启用叙事锚定', checked: enabled, disabled: !loaded || busy, onChange: e => save({ enabled: e.target.checked }) })
          )
        ),

        // 参数设置
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '参数设置'),
          h('label', null, 'STM 短期记忆上限（暂未生效）',
            h('input', { type: 'number', min: 1, max: 50, value: maxSTMLength, disabled: true, title: '阈值写死为 7，待修复后开放编辑' }),
            h('span', { className: 'dsh-tavern-settings-desc' }, '达到后整体压缩为 LTM（当前写死 7）')
          ),
          h('label', null, 'foreground 注入位置',
            h('select', { value: injectPosition, disabled: !loaded || busy, onChange: e => save({ injectPosition: e.target.value }) },
              h('option', { value: 'before-rules' }, '写作规则之前'),
              h('option', { value: 'before-posture' }, '姿势之前'),
              h('option', { value: 'after-posture' }, '姿势之后'),
              h('option', { value: 'before-guide' }, '引导之前'),
              h('option', { value: 'after-guide' }, '引导之后'),
              h('option', { value: 'end' }, '末尾')
            )
          ),
          h('label', { className: 'dsh-tavern-background-task' },
            h('span', null, '投影替换',
              h('span', { className: 'dsh-tavern-settings-desc' }, '开启后历史正文用状态+STM投影替换（仅当正文token > STM的3倍时），标记为【Summary】')),
            h('input', { type: 'checkbox', role: 'switch', 'aria-label': '投影替换', checked: projectionReplace, disabled: !loaded || busy, onChange: e => save({ projectionReplace: e.target.checked }) })
          ),
          h('label', { className: 'dsh-tavern-background-task' },
            h('span', null, 'LTM 全在场时跳过记忆快照',
              h('span', { className: 'dsh-tavern-settings-desc' }, '所有 LTM 根节点都已在上下文中时，本轮快照不含 LTM 行（STM 补注不受影响）')),
            h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'LTM 全在场时跳过记忆快照', checked: skipAllPresentLtm, disabled: !loaded || busy, onChange: e => save({ skipAllPresentLtm: e.target.checked }) })
          )
        ),

        // 全局设置（v2 2026-10-10）：结算提示词全局共享（global.json），不按会话保存；
        // 单独折叠块放在会话设置下方——所有会话的后台结算共用同一套提示词。
        h('section', { className: 'dsh-local-section' },
          h('details', { className: 'na-global-settings', open: false },
            h('summary', { style: { cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              '全局设置',
              h('span', { className: 'dsh-tavern-settings-desc' }, '结算提示词与剧情压缩保留轮数对所有会话生效（全局共享，不按会话保存）；修改后从下一轮结算 / 下一次压缩生效')),
            h('div', { className: 'na-global-settings-body', style: { marginTop: 8 } },
              h('div', { className: 'na-prompt-section' },
                h('h3', null, '结算提示词（参考 DSHT 系统提示词页：显示当前生效值，空时即默认）'),
                h('details', { className: 'dsh-tavern-prompt-row na-prompt-row' },
                  h('summary', { style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('b', null, '结算系统提示（Persona）'),
                    h('span', { className: 'dsh-tavern-settings-desc' }, '后台结算子 Agent 的系统提示（deployment:persona）'),
                    h('span', { className: 'dsh-tavern-prompt-state ' + (settlePersonaCustomized ? 'on' : 'off'), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } }, settlePersonaCustomized ? '已修改' : '默认')
                  ),
                  h('div', { className: 'dsh-tavern-prompt-editor', style: { marginTop: 6 } },
                    h('textarea', { rows: 4, style: { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, background: 'var(--na-card-soft)', color: 'var(--na-text)', border: '1px solid var(--na-border)', borderRadius: 8, padding: '6px 8px' }, value: settlePersona, disabled: !loaded, onChange: e => { setSettlePersona(e.target.value); writeDraft({ settlePersona: e.target.value }) }, onFocus: () => { promptEditingRef.current = 'persona' }, onBlur: () => { promptEditingRef.current = '' }, 'aria-label': '结算系统提示（Persona）' }),
                    h('div', { className: 'dsh-tavern-prompt-editor-actions', style: { display: 'flex', gap: 8, marginTop: 6 } },
                      h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || !settlePersonaCustomized, onClick: () => save({ settlePersona: '' }) }, '恢复默认'),
                      h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || settlePersona === savedPersona, onClick: () => save({ settlePersona }) }, '保存此项')
                    )
                  )
                ),
                h('details', { className: 'dsh-tavern-prompt-row na-prompt-row' },
                  h('summary', { style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('b', null, '结算任务指令（每轮）'),
                    h('span', { className: 'dsh-tavern-settings-desc' }, '每轮任务消息中的指令段；按【结算任务】标记裁剪历史，不含时自动前置'),
                    h('span', { className: 'dsh-tavern-prompt-state ' + (settleTaskPromptCustomized ? 'on' : 'off'), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } }, settleTaskPromptCustomized ? '已修改' : '默认')
                  ),
                  h('div', { className: 'dsh-tavern-prompt-editor', style: { marginTop: 6 } },
                    h('textarea', { rows: 4, style: { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, background: 'var(--na-card-soft)', color: 'var(--na-text)', border: '1px solid var(--na-border)', borderRadius: 8, padding: '6px 8px' }, value: settleTaskPrompt, disabled: !loaded, onChange: e => { setSettleTaskPrompt(e.target.value); writeDraft({ settleTaskPrompt: e.target.value }) }, onFocus: () => { promptEditingRef.current = 'task' }, onBlur: () => { promptEditingRef.current = '' }, 'aria-label': '结算任务指令（每轮）' }),
                    h('div', { className: 'dsh-tavern-prompt-editor-actions', style: { display: 'flex', gap: 8, marginTop: 6 } },
                      h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || !settleTaskPromptCustomized, onClick: () => save({ settleTaskPrompt: '' }) }, '恢复默认'),
                      h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || settleTaskPrompt === savedTaskPrompt, onClick: () => save({ settleTaskPrompt }) }, '保存此项')
                    )
                  )
                ),
                h('details', { className: 'dsh-tavern-prompt-row na-prompt-row' },
                  h('summary', { style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('b', null, '酒馆后台-叙事锚定结算协议-提示词'),
                    h('span', { className: 'dsh-tavern-settings-desc' }, '后台结算任务消息中注入的协议段（位于【当前叙事锚定快照】之后）；强调记忆分工与同轮多工具一次提交'),
                    h('span', { className: 'dsh-tavern-prompt-state ' + (backendSettleProtocolCustomized ? 'on' : 'off'), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } }, backendSettleProtocolCustomized ? '已修改' : '默认')
                  ),
                  h('div', { className: 'dsh-tavern-prompt-editor', style: { marginTop: 6 } },
                    h('textarea', { rows: 4, style: { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, background: 'var(--na-card-soft)', color: 'var(--na-text)', border: '1px solid var(--na-border)', borderRadius: 8, padding: '6px 8px' }, value: backendSettleProtocol, disabled: !loaded, onChange: e => { setBackendSettleProtocol(e.target.value); writeDraft({ backendSettleProtocol: e.target.value }) }, onFocus: () => { promptEditingRef.current = 'protocol' }, onBlur: () => { promptEditingRef.current = '' }, 'aria-label': '酒馆后台-叙事锚定结算协议-提示词' }),
                    h('div', { className: 'dsh-tavern-prompt-editor-actions', style: { display: 'flex', gap: 8, marginTop: 6 } },
                      h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || !backendSettleProtocolCustomized, onClick: () => save({ backendSettleProtocol: '' }) }, '恢复默认'),
                      h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || backendSettleProtocol === savedBackendSettleProtocol, onClick: () => save({ backendSettleProtocol }) }, '保存此项')
                    )
                  )
                ),
                // v3.1（2026-10-10）：拦截后台会话压缩（global.json，全局生效）——
                // 后台会话（background-* / na-background-*）上下文每轮重建且极短，官方压缩不会
                // 产生有用信息，只会浪费 token 与时间；开启时对压缩请求抛具体拒绝错误，
                // 官方 agent-loop 捕获后仅告警、回合照常继续。
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
                  h('input', { type: 'checkbox', role: 'switch', 'aria-label': '拦截后台会话压缩', checked: blockBackgroundCompaction, disabled: !loaded || busy, onChange: e => save({ blockBackgroundCompaction: e.target.checked }) }),
                  h('span', null, '拦截后台会话压缩',
                    h('span', { className: 'dsh-tavern-settings-desc' }, '对官方后台任务会话（background-*）与 NA 结算会话（na-background-*）的压缩请求抛出拒绝错误。后台上下文每轮重建且极短，压缩无信息增益，只会浪费 token 与时间。'))
                ),
                // v3.5（2026-10-15）：拦截时删除对应后台会话（依赖主开关，仅拦截开启时生效）
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, marginLeft: 26, opacity: blockBackgroundCompaction ? 1 : 0.55 } },
                  h('input', { type: 'checkbox', role: 'switch', 'aria-label': '拦截时删除对应后台会话', checked: deleteBackgroundSessionOnBlock, disabled: !loaded || busy || !blockBackgroundCompaction, onChange: e => save({ deleteBackgroundSessionOnBlock: e.target.checked }) }),
                  h('span', null, '拦截时删除对应后台会话',
                    h('span', { className: 'dsh-tavern-settings-desc' }, '默认开启，仅在拦截开启时生效：命中拦截的同时删除该后台会话目录（sessions/<cwd-hash>/background-*），下次后台任务自动重建空会话，避免日志无限累积。仅作用于官方后台任务会话（background-*）——实测 NA 结算会话（na-background-*）不会触发压缩。删除不影响游玩会话与锚点数据。'))
                )
              )
            )
          )
        ),

        // 剧情压缩（DSHT 全局设置）：压缩保留轮数。0=全量摘要（最近轮次不保留原文、后续请求不带），
        // >0=保留最近 N 轮原文附在摘要后。读写均走 DSHT tavern rpc（getTavernSettings / updateTavernSettings），
        // 非本插件配置，仅在本设置页提供便捷入口。
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '剧情压缩（DSHT 全局设置）'),
          h('label', { style: { display: 'block' } },
            h('span', null, '压缩保留轮数（retainRounds）',
              h('span', { className: 'dsh-tavern-settings-desc' }, '0 = 压缩时全量摘要（最近轮次不再保留原文，后续请求不带）；>0 = 保留最近 N 轮原文附在摘要后。对全部游玩/剧本会话生效，下一个安全边界生效。')),
            h('input', { type: 'number', min: 0, max: 100, step: 1, style: { width: '120px', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, background: 'var(--na-card-soft)', color: 'var(--na-text)', border: '1px solid var(--na-border)', borderRadius: 8, padding: '6px 8px', marginTop: 6 }, value: retainRounds, disabled: !loaded || busy, onChange: e => { const v = e.target.valueAsNumber; if (Number.isFinite(v)) setRetainRounds(Math.max(0, Math.min(100, Math.floor(v)))) }, onBlur: () => { if (retainRounds !== savedRetainRounds) void saveRetainRounds() }, 'aria-label': '压缩保留轮数' }),
            h('div', { className: 'dsh-tavern-prompt-editor-actions', style: { display: 'flex', gap: 8, marginTop: 6 } },
              h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || retainRounds === savedRetainRounds, onClick: () => void saveRetainRounds() }, '保存此项'),
              h('button', { className: 'dsh-local-btn', disabled: !loaded || busy || savedRetainRounds === 10, onClick: () => void saveRetainRounds(10) }, '恢复默认 10')
            )
          )
        ),

        // 数据统计
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '数据统计'),
          h('div', { className: 'dsh-tavern-stats-grid' },
            h('div', null, h('b', null, stats.stm_count), h('span', null, 'STM总数')),
            h('div', null, h('b', null, stats.stm_unmerged), h('span', null, 'STM未合并')),
            h('div', null, h('b', null, stats.ltm_root_count), h('span', null, 'LTM根节点')),
            h('div', null, h('b', null, stats.ltm_total_nodes), h('span', null, 'LTM总结点')),
            h('div', null, h('b', null, stats.known_facts_count), h('span', null, '已知情报')),
            // [2026-09-29 暂停] 伏笔库暂时不单独维护
            // h('div', null, h('b', null, stats.foreshadow_count), h('span', null, '伏笔')),
            h('div', null, h('b', null, stats.turn_count), h('span', null, '轮次'))
          )
        ),

        // v3.4：后台会话管理（NA 结算会话 + DSHT 原生后台会话）
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '后台会话管理'),
          h('div', { className: 'dsh-tavern-settings-desc', style: { marginBottom: 8 } }, 'DSH 对后台子会话不跑压缩，会话日志 append-only 持续膨胀。可手动清空——下次后台任务自动新建空会话。锚点数据与游玩会话不受影响。'),
          // NA 后台结算会话
          h('div', { style: { marginBottom: 10, padding: '8px 10px', background: 'var(--na-card-soft)', borderRadius: 8, border: '1px solid var(--na-border)' } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, 'NA 结算会话（na-background-*）'),
              h('span', { className: 'dsh-tavern-prompt-state ' + (naBgSession && naBgSession.exists ? 'on' : 'off'), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } },
                naBgSession && naBgSession.exists ? formatBytes(naBgSession.bytes) : '未创建')
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--na-dim)', marginBottom: 6 } },
              h('span', null, '会话：' + (naBgSession ? (naBgSession.sessionId || '-') : '…')),
              naBgSession && naBgSession.busy ? h('span', { style: { color: '#e6a23c' } }, '（结算中）') : null
            ),
            h('button', {
              className: 'dsh-local-btn na-danger',
              style: { borderColor: '#c0392b' },
              disabled: !loaded || naBgClearing,
              onClick: () => void clearNaBgSession()
            }, naBgClearing ? '清空中…' : '清空 NA 后台会话')
          ),
          // DSHT 原生后台会话
          h('div', { style: { padding: '8px 10px', background: 'var(--na-card-soft)', borderRadius: 8, border: '1px solid var(--na-border)' } },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { style: { fontWeight: 600, fontSize: 12.5 } }, 'DSHT 原生后台会话（background-*）'),
              h('span', { className: 'dsh-tavern-prompt-state ' + (nativeBgSession && nativeBgSession.count > 0 ? 'on' : 'off'), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } },
                nativeBgSession ? (nativeBgSession.count + ' 个 · ' + formatBytes(nativeBgSession.totalBytes)) : '未创建')
            ),
            h('div', { style: { fontSize: 11, color: 'var(--na-dim)', marginBottom: 6 } },
              nativeBgSession && nativeBgSession.dirs && nativeBgSession.dirs.length > 0
                ? h('span', null, '目录：' + nativeBgSession.dirs.slice(0, 3).join('、') + (nativeBgSession.dirs.length > 3 ? ' 等 ' + nativeBgSession.dirs.length + ' 个' : ''))
                : h('span', null, '官方后台任务（结算/候选/压缩）使用的持久会话')
            ),
            h('button', {
              className: 'dsh-local-btn na-danger',
              style: { borderColor: '#c0392b' },
              disabled: !loaded || nativeBgClearing,
              onClick: () => void clearNativeBgSession()
            }, nativeBgClearing ? '清空中…' : '删除全部原生后台会话')
          )
        ),

        // 路径信息（v0.9.x）：全部由后端运行时推导，非写死
        h('section', { className: 'dsh-local-section' },
          h('details', { className: 'na-paths', onToggle: e => { if (e.target.open) void loadPaths() } },
            h('summary', { style: { cursor: 'pointer', fontWeight: 'bold' } }, '路径信息',
              h('span', { className: 'dsh-tavern-settings-desc', style: { marginLeft: 8 } }, '关键配置与工具的本地绝对路径（运行时读取）')),
            pathsError
              ? h('p', { className: 'dsh-tavern-settings-desc' }, '读取失败：' + pathsError)
              : Object.entries(paths).map(([key, item]) => (item && item.path && item.present !== false)
                ? h('div', { key, style: { margin: '6px 0' } },
                    h('div', { className: 'dsh-tavern-settings-desc' }, item.desc || key),
                    h('div', { style: { fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', color: 'var(--na-info, #7aa2f7)' } }, item.path))
                : null)
          )
        ),

        // 重置
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '数据管理'),
          h('button', { className: 'dsh-tavern-btn dsh-tavern-btn-danger', disabled: !loaded || busy, onClick: () => { if (confirm('确定要清空当前对话的所有叙事锚定数据吗？此操作不可撤销。')) save({ reset: true }) } }, '重置所有数据')
        ),

        error ? h('p', { className: 'dsh-local-warning' }, error) : null,
        notice ? h('p', { className: 'dsh-local-help' }, notice) : null
      )
    )
  }

  // ========== LTM 树递归渲染辅助（v0.8.0） ==========
  function renderLtmTreeNode(node, tree) {
    if (!node) return null
    const depthMark = '[L' + (node.depth || 1) + ']'
    const childNodes = Array.isArray(node.children)
      ? node.children.map(cid => tree && tree.nodes ? tree.nodes[cid] : null).filter(Boolean)
      : []
    return h('li', { key: node.id },
      h('div', null, h('b', null, depthMark + ' '), asText(node.summary) || '(无摘要)'),
      node.turn ? h('div', { className: 'dsh-tavern-settings-desc' }, '轮次 ' + node.turn) : null,
      childNodes.length ? h('ul', null, childNodes.map(child => renderLtmTreeNode(child, tree))) : null
    )
  }

  // ========== 状态页面组件 ==========
  function NarrativeAnchorStatusTab(props) {
    const sessionId = props.scope?.sessionId || props.sessionId
    const [loaded, setLoaded] = React.useState(false)
    const [error, setError] = React.useState('')
    const [anchor, setAnchor] = React.useState(null)
    const [display, setDisplay] = React.useState('')
    // v0.9.0：人工编辑状态
    const [editing, setEditing] = React.useState(null) // 编辑路径，如 'current_state.time' / 'stm.0' / 'ltm.2' / 'kf.0'
    const [editDraft, setEditDraft] = React.useState(null) // 编辑草稿对象
    const [expandedLtm, setExpandedLtm] = React.useState(new Set()) // 展开的 LTM 节点 ID
    const [expandedMerged, setExpandedMerged] = React.useState(new Set()) // 展开的已合并 STM 分组（按 LTM 节点 ID）
    const [expandedMergedAll, setExpandedMergedAll] = React.useState(false) // 已合并 STM 大折叠块
    const [saving, setSaving] = React.useState(false)
    const [kfQuery, setKfQuery] = React.useState('') // 已知情报搜索词
    const [kfSort, setKfSort] = React.useState('recent') // recent=最近优先（默认）/ oldest / entry
    const [tip, setTip] = React.useState('')
    // 后台指导（2026-10-10）：按会话保存（meta.settings.backgroundGuide），折叠块编辑；
    // 每轮注入本会话后台任务末尾（含 NA 结算），类似 DSHT GUIDE 的后台版
    const [backgroundGuide, setBackgroundGuide] = React.useState('')
    const [backgroundGuideCustomized, setBackgroundGuideCustomized] = React.useState(false)
    const [savedGuide, setSavedGuide] = React.useState('')
    const [guideSaving, setGuideSaving] = React.useState(false)
    // 草稿脏标记（2026-10-10）：轮询/切回可见触发的 load() 不得覆盖正在编辑的草稿——
    // 用 ref 而非 state（interval 闭包持首次渲染引用，state 判断会失效）
    const guideDirtyRef = React.useRef(false)
    // 自由栏位右键菜单（v0.10.2）：{x,y,path,label}
    const [slotMenu, setSlotMenu] = React.useState(null)

    // v0.10.2：自由栏位「注入输入框」——写入 DSH 对话输入框草稿（用户可见可编辑，发送时随消息发出）。
    // 优先官方 conversation.input API（与 DSHT 资源引用同款：input.setDraft），API 不可用时 DOM 兜底。
    function injectIntoComposer(text) {
      const v = String(text || '').trim()
      if (!v) { showTip('内容为空，未注入'); return false }
      try {
        const conversation = ctx.get('conversation')
        const actx = ctx.sessions && typeof ctx.sessions.scope === 'function' ? ctx.sessions.scope(sessionId) : null
        if (conversation && conversation.input && actx) {
          const input = conversation.input.for(actx)
          if (input && typeof input.setDraft === 'function') {
            const draft = String(input.state && input.state.getSnapshot ? input.state.getSnapshot().draft || '' : '')
            const next = draft.trim() ? draft.replace(/\s*$/, '') + '\n\n---\n\n' + v : v
            input.setDraft(next)
            showTip('✓ 已注入对话输入框（--- 分隔，发送时随消息发出）')
            return true
          }
        }
      } catch { /* 官方 API 不可用 → DOM 兜底 */ }
      const candidates = [
        () => document.querySelector('textarea[placeholder*="发送"]'),
        () => document.querySelector('.composer textarea'),
        () => document.querySelector('main textarea'),
        () => document.querySelector('textarea[contenteditable="true"]'),
        () => [...document.querySelectorAll('textarea')].find(t => t.offsetParent !== null)
      ]
      let el = null
      for (const f of candidates) { try { el = f(); if (el) break } catch { /* 忽略 */ } }
      if (!el) { showTip('未找到对话输入框，无法注入'); return false }
      const prev = typeof el.value === 'string' ? el.value : ''
      const next = prev ? prev + '\n\n---\n\n' + v : v
      try {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(el, next)
      } catch {
        el.value = next
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      showTip('✓ 已注入对话输入框（--- 分隔，发送时随消息发出）')
      return true
    }

    // v0.10.4：自由栏位注入勾选即时保存（仅列表元素）
    // slot: 'list.<i>'；mode: 'front'（注入前台）| 'input'（注入输入框）| 'back'（注入后台）
    const emptySlotItem = () => ({ display: '', injectForeground: false, injectInput: false, injectBack: false })
    const slotKeyOf = (mode) => mode === 'front' ? 'injectForeground' : (mode === 'input' ? 'injectInput' : 'injectBack')
    async function saveInject(slot, mode, checked) {
      setSaving(true)
      try {
        const fs = anchor.free_slots || {}
        const i = parseInt(String(slot).replace('list.', ''), 10)
        const list = (Array.isArray(fs.list) ? fs.list : []).map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem())
        while (list.length <= i) list.push(emptySlotItem())
        list[i] = { ...(list[i] || {}), [slotKeyOf(mode)]: checked }
        const data = { free_slots: { ...fs, list } }
        const result = await api('updateData', { sessionId, data })
        if (result && result.ok) {
          setAnchor(prev => {
            if (!prev) return prev
            const u = JSON.parse(JSON.stringify(prev))
            const l = (Array.isArray(u.free_slots?.list) ? u.free_slots.list : []).map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem())
            while (l.length <= i) l.push(emptySlotItem())
            l[i] = { ...(l[i] || {}), [slotKeyOf(mode)]: checked }
            u.free_slots = { ...(u.free_slots || {}), list: l }
            return u
          })
          const label = mode === 'front' ? '注入前台' : (mode === 'input' ? '注入输入框' : '注入后台')
          showTip(checked ? ('✓ 已勾选：' + label) : '已取消勾选')
        } else {
          setError((result && result.error) || '保存失败')
        }
      } catch (err) {
        setError(String((err && err.message) || err))
      } finally {
        setSaving(false)
      }
    }

    // v0.10.4：取自由栏位-列表指定下标元素的内容
    function slotValueAt(path) {
      if (String(path).startsWith('free_slots.list.')) {
        const i = parseInt(String(path).replace('free_slots.list.', '').replace('.display', ''), 10)
        const item = (Array.isArray(anchor.free_slots?.list) ? anchor.free_slots.list : [])[i]
        return item ? item.display : ''
      }
      return ''
    }

    // v0.10.4：清空自由栏位-列表元素（人工清空，仅清内容）
    async function clearSlot(path) {
      if (!window.confirm('确定清空该自由栏位吗？此操作立即生效')) return
      setSaving(true)
      try {
        const fs = anchor.free_slots || {}
        const i = parseInt(String(path).replace('free_slots.list.', '').replace('.display', ''), 10)
        const list = (Array.isArray(fs.list) ? fs.list : []).map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem())
        while (list.length <= i) list.push(emptySlotItem())
        list[i] = { ...(list[i] || {}), display: '' }
        const data = { free_slots: { ...fs, list } }
        const result = await api('updateData', { sessionId, data })
        if (result && result.ok) {
          setAnchor(prev => {
            if (!prev) return prev
            const u = JSON.parse(JSON.stringify(prev))
            const l = (Array.isArray(u.free_slots?.list) ? u.free_slots.list : []).map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem())
            while (l.length <= i) l.push(emptySlotItem())
            l[i] = { ...(l[i] || {}), display: '' }
            u.free_slots = { ...(u.free_slots || {}), list: l }
            return u
          })
          showTip('已清空')
        } else {
          setError((result && result.error) || '清空失败')
        }
      } catch (err) {
        setError(String((err && err.message) || err))
      } finally {
        setSaving(false)
      }
    }

    // v0.10.2：新增/删除自由栏位-列表元素
    async function addSlotItem() {
      setSaving(true)
      try {
        const fs = anchor.free_slots || {}
        const list = Array.isArray(fs.list) ? fs.list.map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem()) : []
        list.push(emptySlotItem())
        const result = await api('updateData', { sessionId, data: { free_slots: { ...fs, list } } })
        if (result && result.ok) {
          setAnchor(prev => {
            if (!prev) return prev
            const u = JSON.parse(JSON.stringify(prev))
            const l = Array.isArray(u.free_slots?.list) ? u.free_slots.list.map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem()) : []
            l.push(emptySlotItem())
            u.free_slots = { ...(u.free_slots || {}), list: l }
            return u
          })
          showTip('已新增列表栏位 #' + (list.length - 1))
        } else {
          setError((result && result.error) || '新增失败')
        }
      } catch (err) {
        setError(String((err && err.message) || err))
      } finally {
        setSaving(false)
      }
    }

    async function removeSlotItem(i) {
      if (!window.confirm('确定删除列表栏位 #' + i + ' 吗？内容将一并移除')) return
      setSaving(true)
      try {
        const fs = anchor.free_slots || {}
        const list = (Array.isArray(fs.list) ? fs.list : []).filter((_, idx) => idx !== i)
        const result = await api('updateData', { sessionId, data: { free_slots: { ...fs, list } } })
        if (result && result.ok) {
          setAnchor(prev => {
            if (!prev) return prev
            const u = JSON.parse(JSON.stringify(prev))
            u.free_slots = { ...(u.free_slots || {}), list: (Array.isArray(u.free_slots?.list) ? u.free_slots.list : []).filter((_, idx) => idx !== i) }
            return u
          })
          showTip('已删除列表栏位 #' + i)
        } else {
          setError((result && result.error) || '删除失败')
        }
      } catch (err) {
        setError(String((err && err.message) || err))
      } finally {
        setSaving(false)
      }
    }

    function showTip(msg) {
      setTip(msg)
      setTimeout(() => setTip(''), 2000)
    }

    // 自由栏位右键菜单全局关闭（点击外部 / 滚轮 / Esc）
    React.useEffect(() => {
      if (!slotMenu) return
      const close = () => setSlotMenu(null)
      const onKey = e => { if (e.key === 'Escape') setSlotMenu(null) }
      window.addEventListener('click', close)
      window.addEventListener('wheel', close)
      window.addEventListener('keydown', onKey)
      return () => {
        window.removeEventListener('click', close)
        window.removeEventListener('wheel', close)
        window.removeEventListener('keydown', onKey)
      }
    }, [slotMenu])

    /** 保存后台指导（按会话）：target 传 '' = 恢复默认（清除本会话 meta.settings.backgroundGuide）。 */
    async function saveGuide(target) {
      const value = typeof target === 'string' ? target : backgroundGuide
      setGuideSaving(true)
      try {
        const result = await api('setConfig', { sessionId, backgroundGuide: value })
        if (result.ok) {
          guideDirtyRef.current = false
          // 保存后重新取生效值（默认/自定义），界面显示"当前生效值"
          try {
            const cfg = await api('getConfig', { sessionId })
            if (cfg.ok && cfg.settings) {
              setBackgroundGuide(cfg.settings.backgroundGuide || '')
              setBackgroundGuideCustomized(!!cfg.settings.backgroundGuideCustomized)
              setSavedGuide(cfg.settings.backgroundGuide || '')
            }
          } catch { /* 回读失败仍按提交值显示 */ }
          showTip('✓ 已保存（下一轮后台任务生效）')
        } else {
          setError(result.error || '保存失败')
        }
      } catch (err) {
        setError(String(err.message || err))
      } finally {
        setGuideSaving(false)
      }
    }

    async function saveEdit(path, value) {
      setSaving(true)
      try {
        // 构建部分更新数据
        const data = {}
        if (path.startsWith('current_state.')) {
          const field = path.replace('current_state.', '')
          // value 形如 { '环境': '文本' }（label 是中文显示名，非字段名），取首个值写字段，
          // 否则 environment 会被存成 {"环境": …} 嵌套对象
          const v = value && typeof value === 'object' ? Object.values(value)[0] : value
          data.current_state = { ...(anchor.current_state || {}), [field]: v }
        } else if (path.startsWith('free_slots.list.')) {
          // v0.10.4：自由栏位-列表元素人工编辑——只改该下标元素的 display（无历史）
          const idx = parseInt(String(path).replace('free_slots.list.', '').replace('.display', ''), 10)
          const v = value && typeof value === 'object' ? Object.values(value)[0] : value
          const list = (Array.isArray(anchor.free_slots?.list) ? anchor.free_slots.list : []).map(x => x && typeof x === 'object' ? { ...x } : emptySlotItem())
          while (list.length <= idx) list.push(emptySlotItem())
          list[idx] = { ...(list[idx] || {}), display: v }
          data.free_slots = { ...(anchor.free_slots || {}), list }
        } else if (path.startsWith('stm.')) {
          const idx = parseInt(path.replace('stm.', ''), 10)
          const stm = [...(anchor.memory?.stm || [])]
          stm[idx] = { ...stm[idx], ...value }
          data.memory = { stm }
        } else if (path.startsWith('ltm.')) {
          const nid = parseInt(path.replace('ltm.', ''), 10)
          const tree = JSON.parse(JSON.stringify(anchor.memory?.ltm_tree || { nodes: {}, roots: [], next_id: 1 }))
          if (tree.nodes[nid]) {
            tree.nodes[nid] = { ...tree.nodes[nid], ...value }
          }
          data.memory = { ltm_tree: tree }
        } else if (path.startsWith('kf.')) {
          const idx = parseInt(path.replace('kf.', ''), 10)
          const kf = [...(anchor.memory?.known_facts || [])]
          // 编辑后移到数组末尾——保证数组末尾 = 最近编辑的条目
          // 和 LLM 提交的合并逻辑保持一致，slice(-10) 能正确取到最近编辑的10条
          const [item] = kf.splice(idx, 1)
          kf.push({ ...item, ...value })
          data.memory = { known_facts: kf }
        }
        const result = await api('updateData', { sessionId, data })
        if (result.ok) {
          setAnchor(prev => {
            const updated = JSON.parse(JSON.stringify(prev))
            if (data.current_state) updated.current_state = data.current_state
            if (data.free_slots) updated.free_slots = data.free_slots
            if (data.memory?.stm) updated.memory.stm = data.memory.stm
            if (data.memory?.ltm_tree) updated.memory.ltm_tree = data.memory.ltm_tree
            if (data.memory?.known_facts) updated.memory.known_facts = data.memory.known_facts
            return updated
          })
          setEditing(null)
          setEditDraft(null)
          // 编辑 known_facts 后自动同步到临时世界书（不等下一轮结算）
          if (data.memory?.known_facts) {
            try { await api('worldbook/settings', { sessionId, importNow: true }) } catch { /* 静默失败，不阻塞 UI */ }
          }
          showTip('✓ 已保存')
        } else {
          setError(result.error || '保存失败')
        }
      } catch (err) {
        setError(String(err.message || err))
      } finally {
        setSaving(false)
      }
    }

    async function deleteItem(path) {
      if (!confirm('确定删除这条记录吗？')) return
      try {
        const data = {}
        if (path.startsWith('stm.')) {
          const idx = parseInt(path.replace('stm.', ''), 10)
          const stm = [...(anchor.memory?.stm || [])]
          stm.splice(idx, 1)
          data.memory = { stm }
        } else if (path.startsWith('kf.')) {
          const idx = parseInt(path.replace('kf.', ''), 10)
          const kf = [...(anchor.memory?.known_facts || [])]
          kf.splice(idx, 1)
          data.memory = { known_facts: kf }
        }
        const result = await api('updateData', { sessionId, data })
        if (result.ok) {
          setAnchor(prev => {
            const updated = JSON.parse(JSON.stringify(prev))
            if (data.memory?.stm) updated.memory.stm = data.memory.stm
            if (data.memory?.known_facts) updated.memory.known_facts = data.memory.known_facts
            return updated
          })
          // 删除 known_facts 后同步临时世界书（autoImport 会停用失去锚点来源的条目）
          if (data.memory?.known_facts) {
            try { await api('worldbook/settings', { sessionId, importNow: true }) } catch { /* 静默失败，不阻塞 UI */ }
          }
          showTip('✓ 已删除')
        }
      } catch (err) {
        setError(String(err.message || err))
      }
    }

    async function addStm() {
      const existingStm = anchor.memory?.stm || []
      // 人工新增 STM 的轮次应用为上一条 STM 的轮次（补录性质）
      const lastTurn = existingStm.length > 0 ? (existingStm[existingStm.length - 1].turn || anchor.meta?.turn_count || 0) : (anchor.meta?.turn_count || 0)
      const newItem = {
        id: Date.now() + Math.random(),
        turn: lastTurn,
        time: '',
        location: '',
        title: '',
        summary: '',
        merged_into: null,
        manual: true
      }
      const stm = [...(anchor.memory?.stm || []), newItem]
      const result = await api('updateData', { sessionId, data: { memory: { stm } } })
      if (result.ok) {
        setAnchor(prev => ({ ...prev, memory: { ...prev.memory, stm } }))
        setEditing('stm.' + (stm.length - 1))
        setEditDraft({ ...newItem })
        showTip('✓ 已新增，点击编辑')
      }
    }

    async function addKnownFact() {
      const newItem = { entry: '', keywords: [], summary: '' }
      const kf = [...(anchor.memory?.known_facts || []), newItem]
      const result = await api('updateData', { sessionId, data: { memory: { known_facts: kf } } })
      if (result.ok) {
        setAnchor(prev => ({ ...prev, memory: { ...prev.memory, known_facts: kf } }))
        setEditing('kf.' + (kf.length - 1))
        setEditDraft({ ...newItem })
        showTip('✓ 已新增，点击编辑')
      }
    }

    function toggleLtm(id) {
      setExpandedLtm(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    function toggleMerged(id) {
      setExpandedMerged(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    async function load() {
      setError('')
      try {
        const result = await api('getData', { sessionId })
        if (result.ok) {
          setAnchor(result.anchor)
          setDisplay(result.display || '')
          setLoaded(true)
        } else {
          setError(result.error || '加载失败')
        }
        // 后台指导（按会话保存）——getConfig 返回生效值 + customized 标志；失败不阻塞状态页。
        // 轮询保护：正在编辑（guideDirtyRef）时不覆盖草稿，避免 8 秒轮询打断输入。
        try {
          const cfg = await api('getConfig', { sessionId })
          if (cfg.ok && cfg.settings && !guideDirtyRef.current) {
            setBackgroundGuide(cfg.settings.backgroundGuide || '')
            setBackgroundGuideCustomized(!!cfg.settings.backgroundGuideCustomized)
            setSavedGuide(cfg.settings.backgroundGuide || '')
          }
        } catch { /* 忽略 */ }
      } catch (err) { setError(String(err.message || err)) }
    }

    React.useEffect(() => {
      void load()
      // 自动刷新（v0.6.8）：8 秒轮询 + 页面切回可见时立即刷新
      const timer = setInterval(() => void load(), 8000)
      const onVis = () => { if (!document.hidden) void load() }
      document.addEventListener('visibilitychange', onVis)
      return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis) }
    }, [])

    if (!loaded) {
      return h('aside', { className: 'dsh-tavern-status na-page' },
        h('div', { className: 'dsh-tavern-status-head' }, h('strong', null, '叙事锚定状态')),
        h('div', { className: 'dsh-tavern-status-body' }, h('p', null, error || '加载中...'))
      )
    }

    if (!anchor) {
      return h('aside', { className: 'dsh-tavern-status na-page' },
        h('div', { className: 'dsh-tavern-status-head' }, h('strong', null, '叙事锚定状态')),
        h('div', { className: 'dsh-tavern-status-body' },
          h('p', null, '暂无叙事锚定数据。'),
          h('p', { className: 'dsh-local-help' }, '完成一轮后台结算后，数据会自动出现在这里。')
        )
      )
    }

    // 辅助：叙事备忘展示——有截断原文（focus_full）时展示全文并在截断位置插标
    function displayFocus(cs) {
      if (!cs || !cs.focus_full) return cs?.focus || ''
      const cut = cs.focus || ''
      return cs.focus_full.startsWith(cut)
        ? cut + ' ⟂截断⟂ ' + cs.focus_full.slice(cut.length)
        : cut + ' ⟂截断⟂ ' + cs.focus_full
    }

    // 辅助：可编辑文本行
    function editableField(path, label, value, multiline, viewMultiline) {
      const text = asText(value)
      const isEditing = editing === path
      if (isEditing) {
        return h('div', { className: 'na-edit-row', style: { marginBottom: 6 } },
          h('b', { style: { display: 'block', marginBottom: 3 } }, label + '：'),
          multiline
            ? h('textarea', {
                style: { width: '100%', minHeight: 60, padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', resize: 'vertical' },
                value: editDraft?.[label] ?? text,
                onChange: e => setEditDraft(prev => ({ ...(prev || {}), [label]: e.target.value }))
              })
            : h('input', {
                style: { width: '100%', padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)' },
                value: editDraft?.[label] ?? text,
                onChange: e => setEditDraft(prev => ({ ...(prev || {}), [label]: e.target.value }))
              }),
          h('div', { style: { marginTop: 4, display: 'flex', gap: 6 } },
            h('button', { className: 'dsh-local-btn na-tab-active', disabled: saving, onClick: () => saveEdit(path, { [label]: editDraft?.[label] ?? text }) }, '保存'),
            h('button', { className: 'dsh-local-btn', onClick: () => { setEditing(null); setEditDraft(null) } }, '取消')
          )
        )
      }
      return h('div', {
        className: 'na-view-row',
        style: { cursor: 'pointer', padding: '2px 4px', borderRadius: 3, ...(viewMultiline ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } : {}) },
        onClick: () => { setEditing(path); setEditDraft({ [label]: text }) },
        title: '点击编辑'
      },
        h('b', null, label + '：'),
        text ? h('span', { style: viewMultiline ? { display: 'block', marginTop: 2 } : undefined }, text) : '(空)'
      )
    }

    // 自由栏位块式渲染（v0.10.2）：标题 + 内容卡片（多行展示，点击编辑；空时占位）
    // 自由栏位-列表元素（v0.10.4）：数组元素 = 一个可见栏位
    //（展示/编辑/注入前台/注入输入框/注入后台），不含历史列表；后台可按下标写入
    function freeSlotListItem(i, item) {
      const text = asText(item && item.display)
      const path = 'free_slots.list.' + i + '.display'
      const label = '列表 #' + i
      const isEditing = editing === path
      const cardStyle = {
        marginTop: 4,
        padding: '6px 10px',
        border: '1px solid var(--na-border)',
        borderRadius: 6,
        background: 'var(--na-card-soft)',
        color: 'var(--na-text)',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.6
      }
      const checkStyle = { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--na-dim)', cursor: 'pointer', userSelect: 'none' }
      if (isEditing) {
        return h('div', { key: path, style: { marginBottom: 10 } },
          h('b', { style: { fontSize: 12 } }, label),
          h('textarea', {
            style: { width: '100%', minHeight: 60, marginTop: 4, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, background: 'var(--na-bg-input)', color: 'var(--na-text)', border: '1px solid var(--na-border)', borderRadius: 6, padding: '6px 8px', resize: 'vertical' },
            value: editDraft?.[label] ?? text,
            onChange: e => setEditDraft(prev => ({ ...(prev || {}), [label]: e.target.value }))
          }),
          h('div', { style: { marginTop: 4, display: 'flex', gap: 6 } },
            h('button', { className: 'dsh-local-btn na-tab-active', disabled: saving, onClick: () => saveEdit(path, { [label]: editDraft?.[label] ?? text }) }, '保存'),
            h('button', { className: 'dsh-local-btn', onClick: () => { setEditing(null); setEditDraft(null) } }, '取消')
          )
        )
      }
      return h('div', { key: path, style: { marginBottom: 10 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('b', { style: { fontSize: 12, cursor: 'pointer' }, onClick: () => { setEditing(path); setEditDraft({ [label]: text }) }, title: '点击编辑' }, label),
          h('label', { style: { ...checkStyle, marginLeft: 'auto' }, title: '勾选后，随当前状态注入前台游玩上下文（不注入输入框时）', onClick: e => e.stopPropagation() },
            h('input', { type: 'checkbox', checked: !!(item && item.injectForeground), disabled: saving, onChange: e => saveInject('list.' + i, 'front', e.target.checked) }),
            '注入前台'
          ),
          h('label', { style: checkStyle, title: '勾选后，发送时自动把内容跟在用户消息之后（--- 分隔）', onClick: e => e.stopPropagation() },
            h('input', { type: 'checkbox', checked: !!(item && item.injectInput), disabled: saving, onChange: e => saveInject('list.' + i, 'input', e.target.checked) }),
            '注入输入框'
          ),
          h('label', { style: checkStyle, title: '勾选后，后台结算时把内容注入结算任务', onClick: e => e.stopPropagation() },
            h('input', { type: 'checkbox', checked: !!(item && item.injectBack), disabled: saving, onChange: e => saveInject('list.' + i, 'back', e.target.checked) }),
            '注入后台'
          ),
          h('button', { className: 'dsh-local-btn', style: { padding: '0px 6px', fontSize: 10 }, onClick: e => { e.stopPropagation(); removeSlotItem(i) } }, '删除')
        ),
        h('div', {
          style: { ...cardStyle, cursor: 'context-menu' },
          onContextMenu: ev => { ev.preventDefault(); setSlotMenu({ x: ev.clientX, y: ev.clientY, path, label, value: text }) },
          onMouseDown: ev => { if (ev.button === 2) { ev.preventDefault(); setSlotMenu({ x: ev.clientX, y: ev.clientY, path, label, value: text }) } },
          onClick: () => { setEditing(path); setEditDraft({ [label]: text }) }
        }, text ? text : h('span', { style: { color: 'var(--na-dim)' } }, '（空）'))
      )
    }

    // 数组字段编辑（环境/在场人物/关键物品/关键词）：查看用「、」连接展示，
    // 编辑为每行一项的 textarea，保存时按行切回字符串数组（与数据结构一致）
    function editableArrayField(path, label, arr) {
      const list = Array.isArray(arr) ? arr.map(asText).filter(Boolean) : (asText(arr) ? [asText(arr)] : [])
      const isEditing = editing === path
      if (isEditing) {
        return h('div', { className: 'na-edit-row', style: { marginBottom: 6 } },
          h('b', { style: { display: 'block', marginBottom: 3 } }, label + '：'),
          h('textarea', {
            style: { width: '100%', minHeight: 60, padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', resize: 'vertical' },
            placeholder: '每行一项',
            value: editDraft?.[label] ?? list.join('\n'),
            onChange: e => setEditDraft(prev => ({ ...(prev || {}), [label]: e.target.value }))
          }),
          h('div', { style: { marginTop: 4, display: 'flex', gap: 6 } },
            h('button', { className: 'dsh-local-btn na-tab-active', disabled: saving, onClick: () => saveEdit(path, { [label]: (Array.isArray(editDraft?.[label]) ? editDraft[label] : String(editDraft?.[label] ?? list.join('\n'))).split('\n').map(s => s.trim()).filter(Boolean) }) }, '保存'),
            h('button', { className: 'dsh-local-btn', onClick: () => { setEditing(null); setEditDraft(null) } }, '取消')
          )
        )
      }
      return h('div', {
        className: 'na-view-row',
        style: { cursor: 'pointer', padding: '2px 4px', borderRadius: 3 },
        onClick: () => { setEditing(path); setEditDraft({ [label]: list.join('\n') }) },
        title: '点击编辑（每行一项）'
      },
        h('b', null, label + '：'),
        list.length ? list.join('、') : '(空)'
      )
    }

    // 辅助：LTM 树节点渲染（可展开/折叠/编辑，叶节点可展开到对应 STM）
    function renderLtmNode(node, tree, depth, stmList) {
      if (!node) return null
      const isExpanded = expandedLtm.has(node.id)
      const childNodes = Array.isArray(node.children)
        ? node.children.map(cid => tree.nodes ? tree.nodes[cid] : null).filter(Boolean)
        : []
      // 该 LTM 节点对应的 STM 条目（叶节点才有，懒加载：展开时才渲染）
      const nodeStm = childNodes.length === 0 && Array.isArray(stmList)
        ? stmList.filter(s => s.merged_into == node.id)
        : []
      const hasExpandable = childNodes.length > 0 || nodeStm.length > 0
      const isEditing = editing === 'ltm.' + node.id
      const depthMark = '[L' + (node.depth || 1) + ']'
      const indent = { paddingLeft: (depth - 1) * 16 }

      return h('li', { key: node.id, style: { marginBottom: 4 } },
        h('div', { style: { ...indent, padding: '4px 6px', borderRadius: 4, background: isExpanded ? 'var(--na-bg-hover)' : 'transparent', display: 'flex', alignItems: 'flex-start', gap: 4 } },
          // 展开/折叠按钮（有子节点或对应 STM 时可展开）
          hasExpandable
            ? h('span', {
                style: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, minWidth: 18, border: '1px solid var(--na-border)', borderRadius: 3, background: 'var(--na-bg-dim)', fontSize: 10, userSelect: 'none', marginTop: 1 },
                onClick: e => { e.stopPropagation(); toggleLtm(node.id) },
                title: isExpanded ? '点击折叠' : ('点击展开' + (childNodes.length ? '子节点（' + childNodes.length + ' 个）' : '对应 STM（' + nodeStm.length + ' 条）'))
              }, isExpanded ? '▼' : '▶')
            : h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, minWidth: 18, fontSize: 10, color: 'var(--na-dim)', marginTop: 1 } }, '•'),
          // 节点内容
          h('span', {
            style: { cursor: 'pointer', flex: 1, minWidth: 0 },
            onClick: () => { if (!isEditing) { setEditing('ltm.' + node.id); setEditDraft({ title: asText(node.title), keywords: (Array.isArray(node.keywords) ? node.keywords : []).join('、'), summary: node.summary || '' }) } }
          },
            h('b', null, depthMark + ' '),
            isEditing
              ? h('div', { style: { marginTop: 2 } },
                  h('input', {
                    style: { width: '100%', padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', marginBottom: 4 },
                    placeholder: '标题（12 字以内）',
                    value: editDraft?.title ?? asText(node.title),
                    onChange: e => setEditDraft(prev => ({ ...(prev || {}), title: e.target.value }))
                  }),
                  h('input', {
                    style: { width: '100%', padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', marginBottom: 4 },
                    placeholder: '关键词（用、分隔）',
                    value: editDraft?.keywords ?? (Array.isArray(node.keywords) ? node.keywords.join('、') : ''),
                    onChange: e => setEditDraft(prev => ({ ...(prev || {}), keywords: e.target.value }))
                  }),
                  h('textarea', {
                    style: { width: '100%', minHeight: 50, padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', resize: 'vertical' },
                    value: editDraft?.summary ?? asText(node.summary),
                    onChange: e => setEditDraft(prev => ({ ...(prev || {}), summary: e.target.value }))
                  })
                )
              : h('span', null,
                  node.title ? h('span', { style: { marginRight: 4 } }, asText(node.title) + '：') : null,
                  asText(node.summary) || '(无摘要)'
                )
          ),
          // 操作按钮
          h('span', { style: { display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 } },
            node.turn ? h('span', { className: 'dsh-tavern-settings-desc', style: { fontSize: 11 } }, '轮次 ' + node.turn) : null,
            childNodes.length ? h('span', { className: 'dsh-tavern-settings-desc', style: { fontSize: 11 } }, childNodes.length + '子') : null,
            nodeStm.length ? h('span', { className: 'dsh-tavern-settings-desc', style: { fontSize: 11, color: 'var(--na-info)' } }, nodeStm.length + 'STM') : null,
            isEditing
              ? h('button', { className: 'dsh-local-btn na-tab-active', style: { padding: '1px 6px', fontSize: 11 }, disabled: saving, onClick: () => saveEdit('ltm.' + node.id, {
                  title: (editDraft?.title ?? asText(node.title)).replace(/\s+/g, ' ').trim().slice(0, 12),
                  keywords: (Array.isArray(editDraft?.keywords) ? editDraft.keywords : String(editDraft?.keywords ?? '').split(/[、，,;；\n]+/)).map(s => s.trim()).filter(Boolean),
                  summary: editDraft?.summary ?? asText(node.summary)
                }) }, '保存')
              : null,
            isEditing
              ? h('button', { className: 'dsh-local-btn', style: { padding: '1px 6px', fontSize: 11 }, onClick: () => { setEditing(null); setEditDraft(null) } }, '取消')
              : null
          )
        ),
        // 展开内容：子 LTM 节点 或 对应 STM 条目（懒加载，展开时才渲染）
        isExpanded && hasExpandable
          ? childNodes.length
            ? h('ul', { style: { listStyle: 'none', paddingLeft: 0, marginTop: 2 } },
                childNodes.map(child => renderLtmNode(child, tree, depth + 1, stmList))
              )
            : h('div', { style: { marginLeft: (depth - 1) * 16 + 28, marginTop: 4, padding: '6px 8px', border: '1px dashed var(--na-border)', borderRadius: 4, background: 'var(--na-bg-dim)' } },
                h('div', { style: { fontSize: 11, color: 'var(--na-dim)', marginBottom: 4 } }, '▼ 该 LTM 由以下 ' + nodeStm.length + ' 条 STM 合并生成：'),
                h('ol', { style: { paddingLeft: 20, margin: 0, fontSize: 12 } },
                  nodeStm.map((s, i) => h('li', { key: i, style: { marginBottom: 3 } },
                    s.summary || '(空)',
                    s.turn ? h('span', { style: { fontSize: 10, color: 'var(--na-dim)' } }, ' · 轮次 ' + s.turn) : null
                  ))
                )
              )
          : null
      )
    }

    return h('aside', { className: 'dsh-tavern-status na-page' },
      h('div', { className: 'dsh-tavern-status-head' },
        h('strong', null, '叙事锚定状态'),
        tip ? h('span', { style: { marginLeft: 8, color: 'var(--na-success)', fontSize: 12 } }, tip) : null,
        h('button', { className: 'dsh-tavern-btn', style: { marginLeft: 'auto' }, onClick: load }, '刷新')
      ),
      h('div', { className: 'dsh-tavern-status-body' },

        // 当前状态（可编辑）
        h('section', { className: 'dsh-local-section' },
          h('h3', null, '当前状态', h('span', { className: 'dsh-tavern-settings-desc', style: { marginLeft: 8, fontSize: 11, fontWeight: 'normal' } }, '点击字段编辑')),
          h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' } },
            editableField('current_state.time', '时间', anchor.current_state?.time || ''),
            editableField('current_state.world', '世界', anchor.current_state?.world || ''),
            editableField('current_state.location', '地点', anchor.current_state?.location || ''),
            editableArrayField('current_state.environment', '环境', anchor.current_state?.environment),
            editableArrayField('current_state.characters', '在场人物', anchor.current_state?.characters),
            editableArrayField('current_state.items', '关键物品', anchor.current_state?.items),
            editableField('current_state.focus', '叙事备忘', displayFocus(anchor.current_state), true)
          )
        ),

        // 自由栏位（v0.10.4）：与状态/记忆同级的锚点顶层字段，后台结算提交时写入
        //（工具描述不引导，schema 注明【默认不提交】；不提交则保持现状）。
        // 仅保留列表：数组元素 = 一个可见栏位，每个元素带「注入前台 / 注入输入框 / 注入后台」
        // 三个勾选；内容均支持手动编辑（点击编辑）。
        h('section', { className: 'dsh-local-section' },
          h('details', { className: 'na-guide-block', open: false },
            h('summary', { style: { cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 8 } },
              '自由栏位',
              h('span', { className: 'dsh-tavern-prompt-state ' + (((anchor.free_slots?.list || []).some(x => x && String(x.display || '').trim()) ? 'on' : 'off')), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } },
                (anchor.free_slots?.list || []).some(x => x && String(x.display || '').trim()) ? '已配置' : '空')
            ),
            h('div', { style: { marginTop: 8 } },
              h('div', { className: 'dsh-tavern-settings-desc', style: { marginBottom: 6 } }, '与锚点状态/记忆同级的自由栏位：后台结算提交时写入（默认不提交，不填写则保持现状）；仅保留列表。每个列表元素可勾选：注入前台（随当前状态注入游玩上下文，勾选注入输入框时不再注入避免双重）、注入输入框（发送时自动跟在用户消息之后，--- 分隔）、注入后台（结算任务可见）。内容均支持手动编辑'),
              // 自由栏位-列表（v0.10.4）：数组，每个元素一个可见栏位（完整功能，无历史）
              h('div', { style: { marginTop: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('b', { style: { fontSize: 12 } }, '自由栏位-列表'),
                  h('span', { style: { fontSize: 10, color: 'var(--na-dim)' } }, (anchor.free_slots?.list || []).length + ' 项 · 后台按下标写入'),
                  h('button', { className: 'dsh-local-btn', style: { marginLeft: 'auto', padding: '1px 8px', fontSize: 10 }, disabled: saving, onClick: addSlotItem }, '+ 新增')
                ),
                (anchor.free_slots?.list || []).length === 0
                  ? h('p', { className: 'dsh-local-help', style: { margin: '4px 0 0', fontSize: 11.5 } }, '暂无列表栏位；后台结算可按下标写入（free_slots.list: [{index, display}]），或点击"+ 新增"手动添加')
                  : (anchor.free_slots?.list || []).map((item, i) => freeSlotListItem(i, item))
              )
            )
          )
        ),

        // 后台指导（2026-10-10）：类似 DSHT GUIDE 的后台版——每轮注入本会话后台任务末尾
        //（含 NA 结算）；按会话保存（meta.settings.backgroundGuide），折叠块编辑，保存后下一轮生效。
        // 折叠标题只留标题 + 状态徽标；说明文字移入展开区（标题不放长文本）。
        h('section', { className: 'dsh-local-section' },
          h('details', { className: 'na-guide-block', open: false },
            h('summary', { style: { cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 8 } },
              '后台指导',
              h('span', { className: 'dsh-tavern-prompt-state ' + (backgroundGuideCustomized ? 'on' : 'off'), style: { fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--na-border)' } }, backgroundGuideCustomized ? '已修改' : '默认')
            ),
            h('div', { style: { marginTop: 8 } },
              h('div', { className: 'dsh-tavern-settings-desc', style: { marginBottom: 6 } }, '按会话保存；配置后每轮注入本会话后台结算任务末尾（含 NA 结算），类似 DSHT GUIDE 的后台版；默认为空、不注入；修改后从下一轮后台任务生效'),
              h('textarea', {
                rows: 4,
                style: { width: '100%', boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 12, background: 'var(--na-card-soft)', color: 'var(--na-text)', border: '1px solid var(--na-border)', borderRadius: 8, padding: '6px 8px', resize: 'vertical' },
                value: backgroundGuide, disabled: !loaded || guideSaving,
                onChange: e => { guideDirtyRef.current = true; setBackgroundGuide(e.target.value) },
                'aria-label': '后台指导'
              }),
              h('div', { className: 'dsh-tavern-prompt-editor-actions', style: { display: 'flex', gap: 8, marginTop: 6 } },
                h('button', { className: 'dsh-local-btn', disabled: !loaded || guideSaving || !backgroundGuideCustomized, onClick: () => void saveGuide('') }, '恢复默认'),
                h('button', { className: 'dsh-local-btn', disabled: !loaded || guideSaving || backgroundGuide === savedGuide, onClick: () => void saveGuide() }, '保存此项')
              )
            )
          )
        ),

        // STM（未合并优先展示，已合并按 LTM 节点折叠分组）
        (function() {
          const stm = anchor.memory?.stm || []
          const unmerged = stm.map((s, i) => ({ item: s, index: i })).filter(({ item }) => item.merged_into == null)
          const mergedByLtm = {}
          stm.forEach((s, i) => {
            if (s.merged_into != null) {
              const key = String(s.merged_into)
              if (!mergedByLtm[key]) mergedByLtm[key] = []
              mergedByLtm[key].push({ item: s, index: i })
            }
          })
          const tree = anchor.memory?.ltm_tree

          return h('section', { className: 'dsh-local-section' },
            h('h3', null,
              '短期记忆 (STM)',
              h('span', { className: 'dsh-tavern-settings-desc', style: { marginLeft: 8, fontSize: 11, fontWeight: 'normal' } },
                '共 ' + stm.length + ' 条 · 未合并 ' + unmerged.length + ' 条 · 已合并 ' + (stm.length - unmerged.length) + ' 条'
              ),
              h('button', { className: 'dsh-local-btn', style: { marginLeft: 'auto', float: 'right', padding: '2px 8px', fontSize: 11 }, onClick: addStm }, '+ 新增')
            ),

            // 未合并 STM（优先展示）
            unmerged.length
              ? h('div', { style: { marginBottom: 8 } },
                  h('div', { style: { fontSize: 11, color: 'var(--na-dim)', marginBottom: 4 } }, '▼ 未合并（' + unmerged.length + ' 条）'),
                  h('ol', { style: { paddingLeft: 20, margin: 0 } },
                    unmerged.map(({ item, index }) => {
                      const isEditing = editing === 'stm.' + index
                      return h('li', { key: index, style: { marginBottom: 6, padding: '4px 6px', borderRadius: 4, background: isEditing ? 'var(--na-bg-hover)' : 'transparent' } },
                        isEditing
                          ? h('div', null,
                              h('input', {
                                style: { width: '100%', padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', marginBottom: 4 },
                                placeholder: '标题（12 字以内）',
                                value: editDraft?.title ?? asText(item.title),
                                onChange: e => setEditDraft(prev => ({ ...(prev || {}), title: e.target.value }))
                              }),
                              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 4 } },
                                h('input', {
                                  style: { padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)' },
                                  placeholder: '时间',
                                  value: editDraft?.time ?? asText(item.time),
                                  onChange: e => setEditDraft(prev => ({ ...(prev || {}), time: e.target.value }))
                                }),
                                h('input', {
                                  style: { padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)' },
                                  placeholder: '地点',
                                  value: editDraft?.location ?? asText(item.location),
                                  onChange: e => setEditDraft(prev => ({ ...(prev || {}), location: e.target.value }))
                                })
                              ),
                              h('textarea', {
                                style: { width: '100%', minHeight: 50, padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', resize: 'vertical' },
                                placeholder: '内容摘要',
                                value: editDraft?.summary ?? asText(item.summary),
                                onChange: e => setEditDraft(prev => ({ ...(prev || {}), summary: e.target.value }))
                              }),
                              h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                                h('button', { className: 'dsh-local-btn na-tab-active', style: { padding: '2px 8px', fontSize: 11 }, disabled: saving, onClick: () => saveEdit('stm.' + index, {
                                  title: editDraft?.title ?? asText(item.title),
                                  time: editDraft?.time ?? asText(item.time),
                                  location: editDraft?.location ?? asText(item.location),
                                  summary: editDraft?.summary ?? asText(item.summary)
                                }) }, '保存'),
                                h('button', { className: 'dsh-local-btn', style: { padding: '2px 8px', fontSize: 11 }, onClick: () => { setEditing(null); setEditDraft(null) } }, '取消')
                              )
                            )
                          : h('div', { style: { cursor: 'pointer' }, onClick: () => { setEditing('stm.' + index); setEditDraft({ title: asText(item.title), time: asText(item.time), location: asText(item.location), summary: asText(item.summary) }) } },
                              item.title ? h('b', null, asText(item.title) + '：') : null,
                              asText(item.summary) || '(空)',
                              h('div', { style: { display: 'flex', gap: 8, marginTop: 2 } },
                                (item.time || item.location) ? h('span', { className: 'dsh-tavern-settings-desc', style: { fontSize: 11 } }, [item.time, item.location].filter(Boolean).map(asText).join(' · ')) : null,
                                item.turn ? h('span', { className: 'dsh-tavern-settings-desc', style: { fontSize: 11 } }, '轮次 ' + item.turn) : null,
                                h('button', { className: 'dsh-local-btn', style: { padding: '0px 6px', fontSize: 10, marginLeft: 'auto' }, onClick: e => { e.stopPropagation(); deleteItem('stm.' + index) } }, '删除')
                              )
                            )
                      )
                    })
                  )
                )
              : null,

            // 已合并 STM（大折叠块包裹，懒加载：展开时才渲染内部分组）
            Object.keys(mergedByLtm).length
              ? h('div', { style: { marginTop: 8, border: '1px solid var(--na-border)', borderRadius: 4, overflow: 'hidden' } },
                  // 大折叠块标题
                  h('div', {
                    style: { cursor: 'pointer', padding: '6px 10px', background: 'var(--na-bg-dim)', display: 'flex', alignItems: 'center', gap: 6 },
                    onClick: () => setExpandedMergedAll(prev => !prev)
                  },
                    h('span', null, expandedMergedAll ? '▼' : '▶'),
                    h('span', { style: { fontSize: 12, fontWeight: 'bold' } },
                      '已合并进 LTM 的历史 STM（共 ' + (stm.length - unmerged.length) + ' 条，分属 ' + Object.keys(mergedByLtm).length + ' 个 LTM 节点）'
                    ),
                    h('span', { className: 'dsh-tavern-settings-desc', style: { fontSize: 11, marginLeft: 'auto' } },
                      expandedMergedAll ? '点击折叠' : '点击展开查看已合并的历史 STM'
                    )
                  ),
                  // 大折叠块内容（懒加载：只有展开时才渲染）
                  expandedMergedAll
                    ? h('div', { style: { padding: '6px 8px', maxHeight: 400, overflowY: 'auto' } },
                        Object.entries(mergedByLtm).map(([ltmId, items]) => {
                          const isExpanded = expandedMerged.has(ltmId)
                          const ltmNode = tree?.nodes?.[ltmId]
                          return h('div', { key: ltmId, style: { marginBottom: 4, border: '1px solid var(--na-border)', borderRadius: 3, overflow: 'hidden' } },
                            h('div', {
                              style: { cursor: 'pointer', padding: '3px 6px', background: 'var(--na-bg-hover)', display: 'flex', alignItems: 'center', gap: 4 },
                              onClick: () => toggleMerged(ltmId)
                            },
                              h('span', { style: { fontSize: 10 } }, isExpanded ? '▼' : '▶'),
                              h('span', { style: { fontSize: 11, color: 'var(--na-dim)' } },
                                'LTM#' + ltmId + (ltmNode ? ' · ' + (ltmNode.summary || '').slice(0, 25) + '...' : '') + '（' + items.length + ' 条）'
                              )
                            ),
                            isExpanded
                              ? h('ol', { style: { paddingLeft: 20, margin: '3px 6px', fontSize: 11, color: 'var(--na-dim)' } },
                                  items.map(({ item, index }) => h('li', { key: index, style: { marginBottom: 1 } },
                                    item.summary || '(空)',
                                    item.turn ? h('span', { style: { fontSize: 9 } }, ' · 轮次 ' + item.turn) : null
                                  ))
                                )
                              : null
                          )
                        })
                      )
                    : null
                )
              : null,

            !stm.length ? h('p', { className: 'dsh-local-help' }, '暂无短期记忆，点击右上角"新增"手动添加') : null
          )
        })(),

        // LTM（树形结构，可展开/折叠/编辑，叶节点可展开到对应 STM）
        (function() {
          const tree = anchor.memory?.ltm_tree
          const stm = anchor.memory?.stm || []
          if (tree && tree.roots && tree.roots.length) {
            const totalNodes = Object.keys(tree.nodes || {}).length
            // roots 数组已在数据层按历史时序持久化排序（sortRootsInPlace），UI 直接使用该顺序
            // 不再按 depth 重排——depth 只作显示标记，不参与排序
            return h('section', { className: 'dsh-local-section' },
              h('h3', null,
                '长期记忆 (LTM)',
                h('span', { className: 'dsh-tavern-settings-desc', style: { marginLeft: 8, fontSize: 11, fontWeight: 'normal' } },
                  tree.roots.length + ' 根节点 / ' + totalNodes + ' 总结点 · 按历史时序排列 · 点击节点编辑，点击 ▶ 展开（可一直展开到叶节点的 STM）'
                )
              ),
              h('ul', { style: { listStyle: 'none', paddingLeft: 0 } },
                tree.roots.map(rid => renderLtmNode(tree.nodes[rid], tree, 1, stm))
              )
            )
          }
          return h('section', { className: 'dsh-local-section' },
            h('h3', null, '长期记忆 (LTM)'),
            h('p', { className: 'dsh-local-help' }, '暂无长期记忆。未合并 STM 达到 7 条时，后台结算会自动生成 LTM。')
          )
        })(),

        // 已知情报（可编辑/删除/新增；展示层支持搜索+排序，编辑/删除路径仍用原数组下标）
        (() => {
          const kfAll = (anchor.memory?.known_facts || []).map((fact, i) => ({ fact, i }))
          const q = kfQuery.trim().toLowerCase()
          const kfList = q
            ? kfAll.filter(({ fact }) => (
                asText(fact.entry) + ' ' + asText(fact.summary) + ' ' + (Array.isArray(fact.keywords) ? fact.keywords.join(' ') : '')
              ).toLowerCase().includes(q))
            : kfAll
          // 默认最近在前：数组末尾=最近编辑/新增的条目
          const kfSorted = kfSort === 'oldest' ? kfList
            : kfSort === 'entry' ? [...kfList].sort((a, b) => asText(a.fact.entry).localeCompare(asText(b.fact.entry), 'zh'))
            : [...kfList].reverse()
          return h('section', { className: 'dsh-local-section' },
          h('h3', null,
            '已知情报',
            h('span', { className: 'dsh-tavern-settings-desc', style: { marginLeft: 8, fontSize: 11, fontWeight: 'normal' } },
              (anchor.memory?.known_facts?.length || 0) + ' 条 · 点击条目编辑'
            ),
            h('button', { className: 'dsh-local-btn', style: { marginLeft: 'auto', float: 'right', padding: '2px 8px', fontSize: 11 }, onClick: addKnownFact }, '+ 新增')
          ),
          anchor.memory?.known_facts?.length
            ? h('div', { style: { display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' } },
                h('input', {
                  style: { flex: 1, minWidth: 0, padding: '3px 8px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', fontSize: 12 },
                  placeholder: '搜索条目/内容/关键词…',
                  value: kfQuery,
                  onChange: e => setKfQuery(e.target.value)
                }),
                h('select', {
                  style: { padding: '3px 4px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', fontSize: 12 },
                  value: kfSort,
                  onChange: e => setKfSort(e.target.value),
                  title: '排序方式（默认最近编辑/新增的在前）'
                },
                  h('option', { value: 'recent' }, '最近优先'),
                  h('option', { value: 'oldest' }, '最早优先'),
                  h('option', { value: 'entry' }, '按条目名')
                )
              )
            : null,
          kfSorted.length
            ? h('ul', { style: { listStyle: 'none', paddingLeft: 0 } },
                kfSorted.map(({ fact, i: origIdx }, dispIdx) => {
                  const isEditing = editing === 'kf.' + origIdx
                  return h('li', { key: origIdx, style: { marginBottom: 6, padding: '4px 6px', borderRadius: 4, background: isEditing ? 'var(--na-bg-hover)' : 'transparent' } },
                    isEditing
                      ? h('div', null,
                          h('input', {
                            style: { width: '100%', padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', marginBottom: 4 },
                            placeholder: '条目名称',
                            value: editDraft?.entry ?? asText(fact.entry),
                            onChange: e => setEditDraft(prev => ({ ...(prev || {}), entry: e.target.value }))
                          }),
                          h('input', {
                            style: { width: '100%', padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', marginBottom: 4 },
                            placeholder: '关键词（用、分隔）',
                            value: editDraft?.keywords ?? (Array.isArray(fact.keywords) ? fact.keywords.join('、') : ''),
                            onChange: e => setEditDraft(prev => ({ ...(prev || {}), keywords: e.target.value }))
                          }),
                          h('textarea', {
                            style: { width: '100%', minHeight: 40, padding: '4px 6px', border: '1px solid var(--na-border)', borderRadius: 4, background: 'var(--na-bg-input)', color: 'var(--na-text)', resize: 'vertical' },
                            placeholder: '内容摘要',
                            value: editDraft?.summary ?? asText(fact.summary),
                            onChange: e => setEditDraft(prev => ({ ...(prev || {}), summary: e.target.value }))
                          }),
                          h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
                            h('button', { className: 'dsh-local-btn na-tab-active', style: { padding: '2px 8px', fontSize: 11 }, disabled: saving, onClick: () => saveEdit('kf.' + origIdx, {
                              entry: editDraft?.entry ?? asText(fact.entry),
                              keywords: (Array.isArray(editDraft?.keywords) ? editDraft.keywords : String(editDraft?.keywords ?? '').split(/[、，,;；\n]+/)).map(s => s.trim()).filter(Boolean),
                              summary: editDraft?.summary ?? asText(fact.summary)
                            }) }, '保存'),
                            h('button', { className: 'dsh-local-btn', style: { padding: '2px 8px', fontSize: 11 }, onClick: () => { setEditing(null); setEditDraft(null) } }, '取消')
                          )
                        )
                      : h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
                          h('div', { style: { flex: 1, minWidth: 0, cursor: 'pointer' }, onClick: () => { setEditing('kf.' + origIdx); setEditDraft({ entry: asText(fact.entry), keywords: (Array.isArray(fact.keywords) ? fact.keywords : []).join('、'), summary: asText(fact.summary) }) } },
                            fact.entry ? h('b', null, asText(fact.entry) + '：') : null,
                            asText(fact.summary) || '(空)',
                            Array.isArray(fact.keywords) && fact.keywords.length ? h('div', { className: 'dsh-tavern-settings-desc', style: { fontSize: 10 } }, '关键词: ' + fact.keywords.join('、')) : null
                          ),
                          h('button', { className: 'dsh-local-btn', style: { flexShrink: 0, padding: '0px 6px', fontSize: 10 }, onClick: e => { e.stopPropagation(); deleteItem('kf.' + origIdx) } }, '删除')
                        )
                  )
                })
              )
            : h('p', { className: 'dsh-local-help' },
                anchor.memory?.known_facts?.length
                  ? '没有匹配「' + kfQuery.trim() + '」的已知情报'
                  : '暂无已知情报，点击右上角"新增"手动添加')
          )
        })(),

        error ? h('p', { className: 'dsh-local-warning' }, error) : null,

        // 自由栏位右键菜单（v0.10.2）：注入输入框 / 复制 / 清空
        slotMenu ? ReactDOM.createPortal(h('div', {
          className: 'na-ctx-menu',
          onMouseDown: e => e.stopPropagation(),
          onClick: e => e.stopPropagation(),
          style: { position: 'fixed', left: Math.min(slotMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 150), top: Math.min(slotMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 110), zIndex: 2147483000, background: '#23272f', border: '1px solid #555', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.5)', padding: 4, minWidth: 140 }
        },
          h('button', { className: 'dsh-local-btn', style: { display: 'block', width: '100%', textAlign: 'left', marginBottom: 2 }, onClick: () => {
            const v = slotValueAt(slotMenu.path)
            setSlotMenu(null)
            if (!String(v || '').trim()) { showTip('内容为空，未注入'); return }
            injectIntoComposer(v)
          } }, '注入输入框'),
          h('button', { className: 'dsh-local-btn', style: { display: 'block', width: '100%', textAlign: 'left', marginBottom: 2 }, onClick: async () => {
            const v = slotValueAt(slotMenu.path)
            setSlotMenu(null)
            if (!String(v || '').trim()) { showTip('内容为空'); return }
            try { await navigator.clipboard.writeText(String(v)); showTip('✓ 已复制到剪贴板') } catch { showTip('复制失败（浏览器权限）') }
          } }, '复制'),
          h('button', { className: 'dsh-local-btn', style: { display: 'block', width: '100%', textAlign: 'left' }, onClick: () => {
            const p = slotMenu.path
            setSlotMenu(null)
            clearSlot(p)
          } }, '清空')
        ), document.body) : null
      )
    )
  }

  // ========== 会话世界书管理页面组件（v0.7.2：三区块 + 检索 + 强制注入 + 退役判断）==========
  function NarrativeAnchorWorldbookTab(props) {
    const sessionId = props.scope?.sessionId || props.sessionId
    const uiConversation = props.uiConversation
    const [loaded, setLoaded] = React.useState(false)
    const [error, setError] = React.useState('')
    const [data, setData] = React.useState(null)
    const [draft, setDraft] = React.useState(null)   // { id?, title, keys, content, enabled }
    const [query, setQuery] = React.useState('')
    const [hist, setHist] = React.useState(null)
    const [histTurn, setHistTurn] = React.useState(null)
    const [expandedRefs, setExpandedRefs] = React.useState(new Set())
    const [tab, setTab] = React.useState('snapshot') // snapshot | official | temporary | sessionwb
    const [filterTags, setFilterTags] = React.useState(new Map()) // v0.9.20: 三态筛选 Map<tag,'inc'|'exc'>
    const [intersect, setIntersect] = React.useState(false) // v0.7.17ac: 多选交集(AND)
    const tagRef = React.useRef(null) // v0.7.17as: 所有标签弹出面板容器
    const [tagOpen, setTagOpen] = React.useState(false) // v0.7.17as: 所有标签弹出面板开关
    const [snapExpanded, setSnapExpanded] = React.useState(new Set()) // 快照页条目内容展开 // 标签筛选: all | 页签内标签
    const [sortBy, setSortBy] = React.useState('default') // 排序: default|title|source|status|order
    const [sortDir, setSortDir] = React.useState('asc') // 排序方向: asc|desc
    const [ctxInfo, setCtxInfo] = React.useState(null) // v0.7.17ad: 最新 reply 请求上下文（在上下文标记）
    const [predictText, setPredictText] = React.useState('') // v0.7.17ak: 当前聊天输入框文本（预测关键词命中）
    const [lastTurnText, setLastTurnText] = React.useState('') // v0.7.17am: 上一段 AI 输出（预测关键词命中文本源）
    const [ctxMenu, setCtxMenu] = React.useState(null) // v0.7.17al: 官方条目右键菜单 {x,y,ref,source,title,keys,content,enabled}
    const [offDraft, setOffDraft] = React.useState(null) // v0.7.17al: 官方条目编辑草稿 {ref,source,title,keys,content}
    const busyRef = React.useRef(false)
    const entryMetaRef = React.useRef(new Map()) // v0.7.17ap: 官方条目右键原生兜底（React 合成事件可能被桌面端干扰）
    const [bookOpen, setBookOpen] = React.useState(false) // v0.7.17aw: 临时世界书开关默认折叠
    const [tip, setTip] = React.useState('') // v0.7.17aw: 操作反馈提示
    // v0.10.1: 世界书导入反馈（importingKey=库导入某本书，显示"导入中…"禁用；importingFile=文件导入中）
    const [importingKey, setImportingKey] = React.useState('')
    const [importingFile, setImportingFile] = React.useState(false)
    const importFileRef = React.useRef(null)
    // v0.7.18: 会话世界书绑定 + 组合
    const [combos, setCombos] = React.useState([])
    // v0.9.15: 全局自动绑定清单（新会话/分支会话自动跟随）
    const [globalAutoBind, setGlobalAutoBind] = React.useState([])
    const [libData, setLibData] = React.useState({ standalone: [], embedded: [] })
    const [comboDraft, setComboDraft] = React.useState({ name: '' })
    const [pickedBooks, setPickedBooks] = React.useState(new Set())
    const flashTip = (msg) => { setTip(msg); setTimeout(() => setTip(''), 2500) }
    const [comboPickerOpen, setComboPickerOpen] = React.useState(false)
    // v0.9.30: Persona（玩家角色档案库，原 mask 重构）
    const [personaStore, setPersonaStore] = React.useState({ personas: [], personaId: '', manualIds: [], userName: '你' })
    const [personaDraft, setPersonaDraft] = React.useState(null) // {id?, name, description, note}
    const [personaQuery, setPersonaQuery] = React.useState('') // v0.9.31: 人格面具搜索
    const personaFpRef = React.useRef(null)
    // v0.7.19b: 会话世界书条目列表（独立筛选状态，避免与其它页签串）
    const [sbQuery, setSbQuery] = React.useState('')
    const [sbFilterTags, setSbFilterTags] = React.useState(new Set())
    const [sbIntersect, setSbIntersect] = React.useState(false)
    const [sbInvert, setSbInvert] = React.useState(false)
    const [sbBookFilter, setSbBookFilter] = React.useState('')
    // v0.9.15: 绑定区三个列表的搜索 + 标签筛选（已绑定 / 可用世界书 / 组合）
    const [boundQ, setBoundQ] = React.useState(''); const [boundT, setBoundT] = React.useState(new Set()); const [boundInv, setBoundInv] = React.useState(false)
    const [availQ, setAvailQ] = React.useState(''); const [availT, setAvailT] = React.useState(new Set()); const [availInv, setAvailInv] = React.useState(false)
    const [comboQ, setComboQ] = React.useState(''); const [comboT, setComboT] = React.useState(new Set()); const [comboInv, setComboInv] = React.useState(false)
    // 标签筛选行（绑定区复用）：tags=当前选中集合，opts=[[v,label]]
    const bindChips = (tags, setTags, opts, invert, setInvert) => h('div', { style: { marginTop: 5, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
      h('button', { className: tags.size === 0 ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', style: { padding: '2px 9px', fontSize: 11.5 }, title: '清空所有标签筛选', onClick: () => setTags(new Set()) }, '全部'),
      opts.map(([v, label]) => {
        const active = tags.has(v)
        return h('button', { key: v, className: active ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', style: { padding: '2px 9px', fontSize: 11.5 }, title: '互斥筛选：点选只看此类，点激活项取消', onClick: () => setTags(active ? new Set() : new Set([v])) }, label)
      }),
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color: 'var(--na-dim)', whiteSpace: 'nowrap', cursor: 'pointer', marginLeft: 2 }, title: '勾选后显示不符合所选标签的项（反选）' },
        h('input', { type: 'checkbox', checked: invert, onChange: e => setInvert(e.target.checked), style: { width: 13, height: 13, cursor: 'pointer', margin: 0 } }), '反选')
    )
    // v0.7.18: 会话世界书派生 + 动作
    const libStandalone = (libData?.standalone) || []
    const libEmbedded = (libData?.embedded) || []
    const libAll = [
      ...libStandalone.map(s => ({ kind: 'standalone', path: s.path, name: s.name, entryCount: s.entryCount })),
      ...libEmbedded.map(e => ({ kind: 'embedded', cardPath: e.cardPath, name: e.cardName || e.name, entryCount: e.entryCount }))
    ]
    const boundSet = new Set((data?.bound?.books || []).map(b => JSON.stringify({ kind: b.kind, cardPath: b.cardPath, path: b.path })))
    // v0.9.15: 全局自动绑定徽标判定
    const globalSet = new Set((globalAutoBind || []).map(b => JSON.stringify({ kind: b.kind, cardPath: b.cardPath, path: b.path })))
    const toggleGlobalBind = async (item) => {
      const book = { kind: item.kind, cardPath: item.cardPath, path: item.path }
      const r = await api('worldbook/global-bind', { action: 'toggle', book })
      if (r.ok) { setGlobalAutoBind(r.globalAutoBind || []); flashTip(r.globalAutoBind?.some(b => JSON.stringify({ kind: b.kind, cardPath: b.cardPath, path: b.path }) === JSON.stringify(book)) ? '已设为全局自动绑定（对所有会话生效，含之前解绑过的）' : '已取消全局自动绑定（各会话的手动绑定不受影响）') }
      else flashTip(r.error || '操作失败')
    }
    const togglePick = (key) => setPickedBooks(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n })
    // v0.9.16: 支线系统
    const [branchInfo, setBranchInfo] = React.useState(null)
    const [branchBusy, setBranchBusy] = React.useState(false)
    const [branchNameOpen, setBranchNameOpen] = React.useState(false)
    const [branchNameDraft, setBranchNameDraft] = React.useState('')
    const createSideSession = async (alias) => {
      if (branchBusy) return
      setBranchBusy(true)
      try {
        console.log('[narrative-anchor] createSideSession effectiveSid=', effectiveSid, 'currentChatId=', currentChatId, 'scopeSessionId=', sessionId)
        const tavernRpc = async (method, args) => {
          const r = await fetch('/api/dsh-tavern/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
          return r.json()
        }
        // 官方 fork 三步（与官方分支按钮同一后端函数）：
        // 直接调 prepareConversationFork（turn=0 = 自动取最新），不预读磁盘快照
        const plan = await tavernRpc('prepareConversationFork', { chatId: '', sessionId: effectiveSid, turn: 0 })
        if (!plan || plan.ok === false || !plan.atSeq) { flashTip('分叉边界计算失败：' + (plan?.error || '未知')); return }
        const sourceChatId = plan.sourceId || plan.chatId || ''
        const sourceSessionId = plan.sourceSessionId || effectiveSid
        const sessions = props.sessions
        if (!sessions || typeof sessions.fork !== 'function') { flashTip('当前 DSH 版本不支持会话复制'); return }
        const targetSessionId = await sessions.fork({ sessionId: sourceSessionId, atSeq: plan.atSeq, increaseTitle: true })
        const done = await tavernRpc('forkChat', { chatId: sourceChatId, sessionId: sourceSessionId, targetSessionId, turn: plan.turn, sourceRevision: plan.sourceRevision, atSeq: plan.atSeq })
        if (!done || done.ok === false) { flashTip('支线创建失败：' + (done?.error || '未知')); return }
        const reg = await api('branch/register', { sessionId: targetSessionId, parentSid: sourceSessionId, label: alias || '' })
        console.log('[narrative-anchor] branch/register result:', reg)
        if (!reg.ok) { flashTip('支线注册失败：' + (reg.error || '未知')) }
        if (reg.ok) {
          // 设置会话标题为别名
          if (alias) {
            try { await tavernRpc('renameConversation', { sessionId: targetSessionId, title: alias }) } catch { /* 重命名失败不阻断 */ }
          }
          // 分支提示（system 角色）v0.9.21 起由后端请求期注入（llm/stream 中间件
          // branchNoteProjection），不再走会话层写入——DSH 会把游离 system/message
          // tombstone 掉；branch/injectSystemNote 端点已移除（2026-10-10 清理）。
          // 助手消息气泡（类开场白）：改用官方 chat-history-session 的完整合成轮写法
          // （turn/start 下一轮号 → step/start → assistant/message → step/end → turn/end）
          try {
            const greetRes = await api('branch/injectGreeting', {
              sessionId: targetSessionId,
              text: '【支线开场】这里是支线「' + (alias || '新剧情') + '」。以上复制的内容来自主线，仅作为剧情背景，本会话的故事将独立展开。\n\n输入框里已为你预填了场景模板（时间/地点/人物/情景/目标/风格），填写后直接发送即可开始支线剧情；也可以直接用自然语言描述你想切入的时空与情景。主线不受本支线影响。'
            })
            console.log('[narrative-anchor] injectGreeting:', greetRes)
          } catch (e) { console.error('[narrative-anchor] injectGreeting error:', e) }
          // 自动刷新左侧对话列表（官方同款 ctx.sessions.refresh）
          if (sessions && typeof sessions.refresh === 'function') { try { await sessions.refresh() } catch { /* 刷新失败不阻断 */ } }
          // 切换到新支线会话（对齐 DSHT 官方 openSessionWhenReady 流程）
          const waitForSession = async (sid, maxMs) => {
            const deadline = Date.now() + (maxMs || 5000)
            const delays = [0, 150, 350, 700, 1200, 1800, 2500]
            let i = 0
            while (Date.now() < deadline) {
              let summary = null, binding = null
              try { summary = sessions?.list?.getSnapshot?.()?.byId?.[sid] } catch {}
              try { binding = sessions?.binding?.(sid) } catch {}
              if (summary && binding) return true
              try { await sessions?.refresh?.() } catch {}
              if (summary && binding) return true
              await new Promise(r => setTimeout(r, delays[Math.min(i, delays.length - 1)]))
              i++
            }
            return false
          }
          const ready = await waitForSession(targetSessionId)
          if (ready && sessions && typeof sessions.open === 'function') {
            try { await sessions.open(targetSessionId) } catch {}
          }
          try { await tavernRpc('markConversationOpened', { sessionId: targetSessionId }) } catch {}
          if (sessions && typeof sessions.refresh === 'function') { try { await sessions.refresh() } catch {} }
          window.dispatchEvent(new CustomEvent('dsh-tavern-session-changed', { detail: { sessionId: targetSessionId } }))
          // 触发侧边栏刷新（对齐 tavernDataChangeAffects 监听）
          window.dispatchEvent(new CustomEvent('dsh-tavern-data-changed', { detail: { kinds: ['sessions'], source: 'narrative-anchor' } }))
          // 用 DSHT 官方 API 设置输入框草稿（对齐 /setinput 命令）
          const setDraftForSession = (sid, text) => {
            try {
              const actx = props.ctx?.sessions?.scope?.(sid)
              const conversation = props.ctx?.get?.('conversation')
              if (actx && conversation && conversation.input) {
                const input = conversation.input.for(actx)
                if (input && typeof input.setDraft === 'function') { input.setDraft(text); return true }
              }
            } catch {}
            return false
          }
          const template = '（OOC： System Command - Enter side story mode, suspend the main storyline. Do not finalize or modify the original scene on transition. This is not a new scene after the previous scene concludes, but a story at an alternate time point, either in the past or future, decided by the user.）\n【场景切换/接续】\n时间：\n地点：\n人物：\n情景：\n目标：\n风格：'
          const fillTemplate = (attempt) => {
            if (setDraftForSession(targetSessionId, template)) return true
            if (attempt < 10) setTimeout(() => fillTemplate(attempt + 1), 500)
            return false
          }
          setTimeout(() => fillTemplate(0), 2000)
          flashTip('支线已创建：' + (reg.member?.label || '') + '（已知情报族内共享，LTM 以【支线】条目互通）')
          void load()
        }
        else flashTip(reg.error || '支线登记失败')
      } catch (err) { flashTip('支线创建失败：' + String(err?.message || err)) }
      finally { setBranchBusy(false) }
    }
    // v0.9.17: 支线别名修改（支线系统内部名称，不影响会话名）
    // 注意：DSHT 桌面端是 Electron，window.prompt 不可用（点击无反应），必须用行内输入
    const [editingSid, setEditingSid] = React.useState(null)
    const [editingLabel, setEditingLabel] = React.useState('')
    const [joinPick, setJoinPick] = React.useState('')
    const [mergePick, setMergePick] = React.useState('')
    const [families, setFamilies] = React.useState([])
    // 族下拉选项文字：主线别名 | 主线会话名 | 族ID尾8位标识
    // 会话名：后端 index.json 的 title（fork 新 chat 常为空串）→ 官方 sessions.list displayTitle 兜底
    const displayTitleOf = (sid) => {
      try { return String(props.sessions?.list?.getSnapshot()?.byId?.[sid]?.displayTitle || '') } catch { return '' }
    }
    const memberTitle = (m) => m.title || displayTitleOf(m.sessionId) || '（获取不到）'
    const familyOptionLabel = (f) => {
      const root = (f.members || []).find(m => m.isRoot) || (f.members || [])[0] || {}
      return (root.label || '主线') + ' | ' + memberTitle(root) + ' | ' + String(f.familyId || '').slice(-8)
    }
    const startRename = (m) => { setEditingSid(m.sessionId); setEditingLabel(m.label || '') }
    const renameBranch = async (sid) => {
      const trimmed = String(editingLabel || '').trim()
      if (!trimmed) { flashTip('别名不能为空'); return }
      try {
        const r = await api('branch/rename', { sessionId: sid, label: trimmed })
        if (r.ok) { flashTip('别名已改为：' + trimmed + (r.synced ? '（已同步 ' + r.synced + ' 条标记）' : '')); setEditingSid(null); void load() }
        else flashTip(r.error || '改名失败')
      } catch (err) { flashTip('改名失败：' + String(err?.message || err)) }
    }
    // v0.9.18: 加入族（在本会话选族）/ 解除关联 / 合并族
    const joinFamily = async (fid) => {
      if (!fid || branchBusy) return
      setBranchBusy(true)
      try {
        const r = await api('branch/bind', { sessionId: effectiveSid, familyId: fid })
        if (r.ok) { flashTip('已加入族：' + (r.member?.label || fid.slice(-8))); setJoinPick(''); void load() }
        else flashTip(r.error || '加入失败')
      } catch (err) { flashTip('加入失败：' + String(err?.message || err)) }
      finally { setBranchBusy(false) }
    }
    const unbindBranch = async (m) => {
      if (branchBusy) return
      setBranchBusy(true)
      try {
        const r = await api('branch/unbind', { sessionId: m.sessionId })
        if (r.ok) { flashTip('已解除关联：' + (m.label || '') + '（清理 ' + (r.removedEntries || 0) + ' 条互注条目）'); void load() }
        else flashTip(r.error || '解除失败')
      } catch (err) { flashTip('解除失败：' + String(err?.message || err)) }
      finally { setBranchBusy(false) }
    }
    const mergeFamily = async (sourceFid) => {
      if (!sourceFid || branchBusy) return
      setBranchBusy(true)
      try {
        const r = await api('branch/merge', { sourceFamilyId: sourceFid, targetFamilyId: branchInfo.familyId })
        if (r.ok) { flashTip('已并入本族：现在共 ' + (r.members?.length || 0) + ' 名成员'); setMergePick(''); void load() }
        else flashTip(r.error || '合并失败')
      } catch (err) { flashTip('合并失败：' + String(err?.message || err)) }
      finally { setBranchBusy(false) }
    }
    const bindSelected = async () => {
      const books = [...pickedBooks].map(k => JSON.parse(k))
      if (books.length === 0) { flashTip('先勾选要绑定的世界书'); return }
      const r = await api('worldbook/bind', { sessionId: effectiveSid, action: 'add', books })
      if (r.ok) { setPickedBooks(new Set()); flashTip('已绑定 ' + books.length + ' 本世界书'); void load() }
      else flashTip(r.error || '绑定失败')
    }
    const unbindBook = async (b) => {
      const books = [b.kind === 'embedded' ? { kind: 'embedded', cardPath: b.cardPath } : { kind: 'standalone', path: b.path }]
      const r = await api('worldbook/bind', { sessionId: effectiveSid, action: 'remove', books })
      if (r.ok) { flashTip('已解绑'); void load() } else flashTip(r.error || '解绑失败')
    }
    const saveCombo = async () => {
      const books = [...pickedBooks].map(k => JSON.parse(k))
      if (!(comboDraft.name || '').trim()) { flashTip('输入组合名'); return }
      if (books.length === 0) { flashTip('先勾选要加入组合的世界书'); return }
      const r = await api('worldbook/combos', { action: 'create', name: comboDraft.name, books })
      if (r.ok) { setCombos(r.combos || []); setPickedBooks(new Set()); setComboDraft({ name: '' }); flashTip('组合已保存') }
      else flashTip(r.error || '保存失败')
    }
    const applyCombo = async (id, mode) => {
      const r = await api('worldbook/combos', { action: 'apply', id, mode: mode || 'replace', sessionId: effectiveSid })
      if (r.ok) { flashTip(mode === 'merge' ? '已并入组合（' + (r.entryCount || 0) + ' 条）' : '已应用组合（' + (r.entryCount || 0) + ' 条，替换原绑定）'); void load() }
      else flashTip(r.error || '操作失败')
    }
    const delCombo = async (id) => {
      const r = await api('worldbook/combos', { action: 'delete', id })
      if (r.ok) { setCombos(r.combos || []); flashTip('组合已删除') } else flashTip(r.error || '删除失败')
    }
    const addPickedToCombo = async (id) => {
      const picked = [...pickedBooks].map(k => { try { return JSON.parse(k) } catch { return null } }).filter(Boolean)
      if (picked.length === 0) { flashTip('先勾选要加入组合的世界书'); return }
      const r = await api('worldbook/combos', { action: 'addBooks', id, books: picked })
      if (r.ok) { setCombos(r.combos || []); flashTip('已加入组合「' + (r.combo?.name || '') + '」') }
      else flashTip(r.error || '加入失败')
    }
    const removeComboBook = async (id, idx) => {
      const r = await api('worldbook/combos', { action: 'removeBook', id, bookIndex: idx })
      if (r.ok) { setCombos(r.combos || []); flashTip('已从组合移除') } else flashTip(r.error || '移除失败')
    }
    React.useEffect(() => {
      if (!ctxMenu) return
      const close = (e) => { if (e && e.button === 2) return; setCtxMenu(null) } // v0.7.17am：右键 mousedown 由条目 onMouseDown 打开菜单，不得被此监听误关
      document.addEventListener('mousedown', close)
      return () => document.removeEventListener('mousedown', close)
    }, [ctxMenu])
    // v0.7.17ap/ar: 原生右键兜底——window+document 双 capture × mousedown+contextmenu 四重
    // 真实右键在桌面/浏览器均不生效：疑似 DSH 前端在 document capture 拦截 mousedown；window capture 先于 document，且 contextmenu 的 preventDefault 不阻止监听器执行
    React.useEffect(() => {
      const open = (ev) => {
        if (ev.type !== 'contextmenu' && ev.button !== 2) return
        const t = ev.target
        const el = t && t.closest ? t.closest('.dsh-local-entry') : null
        if (!el) return
        const ref = el.getAttribute('data-ref')
        if (!ref) return
        const meta = entryMetaRef.current.get(ref) || {}
        setCtxMenu({ x: ev.clientX, y: ev.clientY, ref, source: meta.source || '', title: meta.title || ref, keys: meta.keys || [], content: String(meta.content || ''), enabled: meta.enabled !== false })
      }
      const tgs = [window, document]
      const tys = ['mousedown', 'contextmenu']
      tgs.forEach(tg => tys.forEach(ty => tg.addEventListener(ty, open, true)))
      return () => { tgs.forEach(tg => tys.forEach(ty => tg.removeEventListener(ty, open, true))) }
    }, [])
    // v0.7.17as: 所有标签弹出面板外部点击关闭
    React.useEffect(() => {
      if (!tagOpen) return
      const close = (e) => { if (tagRef.current && tagRef.current.contains(e.target)) return; setTagOpen(false) }
      document.addEventListener('mousedown', close)
      return () => document.removeEventListener('mousedown', close)
    }, [tagOpen])
    // v0.7.17au: 返回顶部/底部浮动按钮（原生 DOM 挂 body；滚动最近的滚动容器）
    React.useEffect(() => {
      if (document.getElementById('na-scroll-fab')) return
      const fab = document.createElement('div')
      fab.id = 'na-scroll-fab'
      fab.style.cssText = 'position:fixed;right:14px;bottom:14px;display:none;flex-direction:column;gap:6px;z-index:2147483000;'
      const mkBtn = (txt, tip, dir) => {
        const b = document.createElement('button')
        b.textContent = txt
        b.title = tip
        b.style.cssText = 'width:34px;height:34px;border-radius:50%;cursor:pointer;background:var(--na-btn,#262b36);color:var(--na-text,#dde3ec);border:1px solid var(--na-btn-border,#3a4152);font-size:16px;line-height:1;box-shadow:0 2px 8px rgba(0,0,0,.35);'
        b.addEventListener('click', () => {
          const root = document.querySelector('.dsh-tavern-settings-root')
          const sc = (root && root.scrollHeight > root.clientHeight + 10) ? root : (document.scrollingElement || document.documentElement)
          try { sc.scrollTo({ top: dir === 'top' ? 0 : sc.scrollHeight, behavior: 'smooth' }) } catch (e) { sc.scrollTop = dir === 'top' ? 0 : sc.scrollHeight }
        })
        return b
      }
      fab.appendChild(mkBtn('↑', '返回顶部', 'top'))
      fab.appendChild(mkBtn('↓', '返回底部', 'bottom'))
      document.body.appendChild(fab)
      // v0.7.17aw: 世界书页可见且内容可滚动即常驻显示（用户要求不因滚动隐藏）
      const check = () => {
        const root = document.querySelector('.dsh-tavern-settings-root')
        const r = root ? root.getBoundingClientRect() : null
        const visible = !!(r && r.width > 10 && r.height > 10)
        fab.style.display = (visible && root.scrollHeight > root.clientHeight + 10) ? 'flex' : 'none'
      }
      check()
      document.addEventListener('scroll', check, true)
      const t = setInterval(check, 1000)
      return () => { clearInterval(t); document.removeEventListener('scroll', check, true); const f = document.getElementById('na-scroll-fab'); if (f) f.remove() }
    }, [])
    // v0.7.17ax: 动态贴底——容器高度跟随实际顶部偏移（消除底部空白；顶部预留恒定，底部精确贴齐视口）
    React.useEffect(() => {
      const root = document.querySelector('.dsh-tavern-settings-root')
      if (!root) return
      const fit = () => {
        const t = root.getBoundingClientRect().top
        root.style.maxHeight = 'calc(100vh - ' + Math.max(0, t) + 'px)'
      }
      fit()
      window.addEventListener('resize', fit)
      const iv = setInterval(fit, 1500)
      return () => { window.removeEventListener('resize', fit); clearInterval(iv) }
    }, [])
    // 当前游玩 chat 的 id（uiConversation 服务，官方酒馆状态 tab 同款；scope.sessionId 注入的是工作台主会话，不可靠）
    const [currentChatId, setCurrentChatId] = React.useState(null)
    const [uiErr, setUiErr] = React.useState('')
    React.useEffect(() => {
      let unsub
      let ok = false
      const tryBind = () => {
        try {
          const uic = typeof uiConversation === 'function' ? uiConversation() : uiConversation
          // v0.9.5 修复：官方模式是 uiConversation.binding(sessionBinding)——参数必须是
          // ctx.sessions.binding(sessionId) 返回的会话绑定对象（内部读 source.sessionId）。
          // 旧代码传空对象 {} → 宿主抛 unknown session "undefined" → 永远落到 scope 模式。
          const sessionBinding = (() => { try { return props.sessions && sessionId ? props.sessions.binding(sessionId) : null } catch (e) { return null } })()
          let chat = null
          if (uic && typeof uic.binding === 'function' && sessionBinding) {
            try { chat = uic.binding(sessionBinding).target('chat') } catch (e) { chat = null }
          }
          // 官方同款回退：uiConversation 不可用/绑定失败时，直接消费 session binding
          if (!chat && sessionBinding && sessionBinding.session
            && typeof sessionBinding.session.subscribe === 'function'
            && typeof sessionBinding.session.getSnapshot === 'function') {
            chat = {
              getSnapshot: () => { const s = sessionBinding.session.getSnapshot(); return (s && (s.chat || s)) || null },
              subscribe: (fn) => sessionBinding.session.subscribe(fn)
            }
          }
          if (!chat) { setUiErr('未绑定到游玩会话（binding 不可用，已用 scope 模式，自动重试）'); return false }
            const sync = () => {
              try {
                if (!chat) { setUiErr('未绑定到游玩会话（uiConversation 无 chat，用 scope 模式）'); return }
                const snap = typeof chat.getSnapshot === 'function' ? chat.getSnapshot() : null
                const c = snap?.chat || snap
                const id = c?.id || c?.sessionId || c?.uid || null
                setCurrentChatId(id)
                setUiErr(id ? '' : 'uiConversation: chat 无 id 字段')
              } catch (e) { setUiErr('sync: ' + (e && e.message || e)) }
            }
            sync()
            unsub = typeof chat.subscribe === 'function' ? chat.subscribe(sync) : undefined
            ok = true
            return true
      } catch (e) { setUiErr('bind: ' + (e && e.message || e)); return false }
      }
      if (!tryBind()) {
        const t = setInterval(() => { if (tryBind()) clearInterval(t) }, 2000)
        return () => { clearInterval(t); if (unsub) try { unsub() } catch { /* 忽略 */ } }
      }
      return () => { if (unsub) try { unsub() } catch { /* 忽略 */ } }
    }, [])
    // v0.7.17ak：轮询聊天输入框（contenteditable），供 预测关键词命中 使用
    // v0.7.17an：间隔 800ms → 5000ms（用户要求 3-10s，取 5s 降低 DOM 扫描频率）；变更判断保留——
    //   仅当输入框文本与上次不同才 setState，值未变时零重渲染（预测标签只随 predictText/lastTurnText 变化重算）
    const predictTextRef = React.useRef('')
    React.useEffect(() => {
      const timer = setInterval(() => {
        let el = null
        const cands = document.querySelectorAll('[contenteditable="true"]')
        for (const c of cands) { if (c.offsetParent !== null) { el = c; break } }
        const v = (el?.innerText || el?.textContent || '').trim()
        if (v !== predictTextRef.current) { predictTextRef.current = v; setPredictText(v) }
      }, 5000)
      return () => clearInterval(timer)
    }, [])
    const effectiveSid = currentChatId || sessionId
    // v0.7.15：筛选统计行（官方 reason 术语；官方 labels: worldbook-recall-log.js）
    const RECALL_COUNT_LABELS = { cooldown: '冷却中', keywords: '关键词未命中', semantic: 'LLM筛选未保留' }
    const recallCountsLine = (c) => {
      if (!c) return ''
      const order = ['cooldown', 'keywords', 'semantic']
      const parts = []
      order.forEach(k => { const v = c[k]; if (v) parts.push(RECALL_COUNT_LABELS[k] + ' ' + v) })
      const other = Object.keys(c).filter(k => !order.includes(k) && k !== 'selected' && c[k]).reduce((s, k) => s + (c[k] || 0), 0)
      if (other) parts.push('其他 ' + other)
      return parts.join(' · ')
    }
    // v0.7.16：注入组成（常驻/强制）与评估组成（官方/临时），从审计现算
    // v0.7.17 用户锁定格式：注入上下文(常驻/强制/普通) · 评估(官方/临时) · 命中(关键词/语义) · 冷却 · 筛选池 · LLM筛选未保留
    const recallStatsLine = (rec) => {
      if (!rec) return null
      const entries = Array.isArray(rec.entries) ? rec.entries : []
      const refs = Array.isArray(rec.outputRefs) ? rec.outputRefs : (Array.isArray(rec.outputs) ? rec.outputs.map(o => o.ref) : [])
      const forcedSet = new Set((Array.isArray(rec.forcedRefs) ? rec.forcedRefs : []).map(String))
      const outEntries = refs.map(ref => entries.find(e => e.ref === ref)).filter(Boolean)
      const injConst = outEntries.filter(e => e.constant === true).length
      const injForced = outEntries.filter(e => forcedSet.has(e.ref)).length
      const injNormal = Math.max(0, outEntries.length - injConst - injForced)
      const evaOfficial = entries.filter(e => String(e.ref).startsWith('entry:')).length
      const evaTemp = Math.max(0, entries.length - evaOfficial)
      const sc = rec.screening || null
      const cooldown = rec.counts?.cooldown ?? 0
      const semKilled = rec.counts?.semantic ?? 0
      const pool = sc && sc.candidateCount != null ? sc.candidateCount : null
      const tok = sc && sc.estimatedTokens != null ? sc.estimatedTokens : null
      // v0.7.17l：命中段删除——命中(语义)=普通注入数，与「注入组成·普通」重复，信息已被 注入组成/筛选池/LLM筛选未保留 覆盖
      return '第 ' + (rec.turn ?? '-') + ' 轮 · 动态世界书快照 · 注入上下文 ' + outEntries.length + ' 条（常驻 ' + injConst + ' + 强制 ' + injForced + ' + 普通 ' + injNormal + '）· 评估 ' + entries.length + ' 条（官方 ' + evaOfficial + ' + 临时 ' + evaTemp + '）· 冷却中 ' + cooldown + (pool != null ? ' · 筛选池 ' + pool + ' 条约 ' + tok + ' tok' : '') + ' · LLM筛选未保留 ' + semKilled
    }

    // v0.10.1：从本地 JSON 世界书文件导入会话临时世界书（文件导入）
    async function handleImportFile(ev) {
      const file = ev.target.files && ev.target.files[0]
      ev.target.value = '' // 清空 value，允许重复选择同一文件
      if (!file) return
      setImportingFile(true)
      try {
        const text = await file.text()
        const doc = JSON.parse(text)
        // 源书含常驻条目 → 弹窗询问是否保持常驻（默认不常驻）
        const rawList = (doc?.data || doc)?.character_book?.entries ?? (doc?.data || doc)?.entries
        const listArr = Array.isArray(rawList) ? rawList : (rawList && typeof rawList === 'object' ? Object.values(rawList) : [])
        const nConst = listArr.filter(e => e && e.constant === true).length
        const keep = nConst > 0 ? window.confirm('「' + (doc?.name || doc?.data?.name || doc?.character_book?.name || file.name) + '」含 ' + nConst + ' 条常驻条目。\n\n是否保持常驻？\n（确定 = 保持常驻；取消 = 导入为普通条目，不常驻）') : false
        const r = await api('worldbook/import-doc', {
          sessionId: effectiveSid,
          name: file.name,
          fileKey: 'upload:' + file.name + ':' + file.size + ':' + (file.lastModified || 0),
          constantMode: keep ? 'preserve' : 'strip',
          doc
        })
        if (r.ok) flashTip('✓ 文件导入「' + (r.name || '') + '」：新增 ' + r.imported + ' 条，更新 ' + r.updated + ' 条' + (r.skipped > 0 ? '，跳过 ' + r.skipped + ' 条' : '') + (nConst > 0 ? (keep ? '，常驻已保留' : '，常驻已取消') : '') + '（见下方条目列表）')
        else flashTip(r.error || '文件导入失败')
        void load()
      } catch (err) {
        flashTip('文件导入失败：' + (err instanceof SyntaxError ? '不是有效的 JSON，请确认文件是世界书 JSON 格式' : String(err?.message || err)))
      } finally {
        setImportingFile(false)
      }
    }

    // v0.7.17ao：数据指纹——lastTurnText(AI上轮输出)/轮次/评估规模/会话 任一变化才 setState；
    //   未变化零重渲染（此前 8s 轮询每次 setData 新对象引用 → 整页条目 predictHit 全量重算）
    const dataFpRef = React.useRef(null)
    const histFpRef = React.useRef(null)
    const combosFpRef = React.useRef(null)
    const familiesFpRef = React.useRef(null)
    const branchFpRef = React.useRef(null)
    async function load() {
      try {
        const result = await api('worldbook/get', { sessionId: effectiveSid })
        if (result.ok) {
          const lt = result.lastTurnText || ''
          const fp = [
            effectiveSid, lt.length, lt.slice(-80),
            result.recall?.turn, result.recall?.status,
            Array.isArray(result.official) ? result.official.length : -1,
            result.recall?.entriesCount, (result.recall?.forcedRefs || []).length,
            result.anchorCounts?.stm,
            // 勾选状态纳入指纹：worldbook/select 只改 selection，不含此项会导致 load() 跳过 setData、
            // 投影字段（selected/inContext）停留在旧值；用完整列表而非数量，勾 A 取消 B 的组合也能感知
            (result.book?.selection || []).join(','),
            // 条目updatedAt 纳入指纹：改别名后端会刷新条目 keys/标题，不含此项页面不实时反映
            (result.book?.entries || []).map(e => e.id + ':' + (e.updatedAt || 0)).join(','),
            (result.bound?.books || []).map(b => (b.kind === 'embedded' ? b.cardPath : b.path)).join(',') + ':' + (result.bound?.entryCount || 0)
          ].join('|')
          if (fp !== dataFpRef.current) {
            dataFpRef.current = fp
            setData(result); setLoaded(true); setCtxInfo(result.context || null); setLastTurnText(result.lastTurnText || '')
            try {
              const lr = await api('worldbook/library', {})
              if (lr.ok) setLibData({ standalone: lr.standalone || [], embedded: lr.embedded || [] })
            } catch { /* 库加载非关键 */ }
            try {
              const cr = await api('worldbook/combos', { action: 'list' })
              if (cr.ok) {
                const cfp = JSON.stringify((cr.combos || []).map(c => c.id + ':' + c.name + ':' + c.books.length)) + '|' + JSON.stringify(cr.globalAutoBind || [])
                if (cfp !== combosFpRef.current) { combosFpRef.current = cfp; setCombos(cr.combos || []); setGlobalAutoBind(cr.globalAutoBind || []) }
              }
            } catch { /* 组合加载非关键 */ }
          }
          // 族谱独立刷新（改名只动注册表不动 book 指纹，放指纹守卫外才能实时显示新别名）
          try {
            const br = await api('branch/list', { sessionId: effectiveSid })
            if (br.ok) { const bfp = JSON.stringify(br); if (bfp !== branchFpRef.current) { branchFpRef.current = bfp; setBranchInfo(br) } }
          } catch { /* 族谱加载非关键 */ }
          try {
            const fr = await api('branch/families', {})
            if (fr.ok) {
              const ffp = JSON.stringify((fr.families || []).map(f => f.familyId + ':' + (f.members || []).length).sort())
              if (ffp !== familiesFpRef.current) { familiesFpRef.current = ffp; setFamilies(fr.families || []) }
            }
          } catch { /* 族列表加载非关键 */ }
          // v0.9.30: Persona 列表 + 当前称呼
          try {
            const mr = await api('persona/list', { sessionId: effectiveSid })
            let liveName = ''
            try {
              const sr = await fetch('/api/dsh-tavern/getSession', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: effectiveSid }) })
              const sj = await sr.json().catch(() => null)
              const v = sj && (sj.view || sj)
              if (v && typeof v.playerName === 'string' && v.playerName.trim()) liveName = v.playerName.trim()
            } catch { /* 称呼回退 persona/list 值 */ }
            const userName = liveName || mr.userName || '你'
            if (mr.ok) {
              const mfp = JSON.stringify([mr.personas || [], mr.personaId || '', mr.manualIds || [], userName])
              if (mfp !== personaFpRef.current) { personaFpRef.current = mfp; setPersonaStore({ personas: mr.personas || [], personaId: mr.personaId || '', manualIds: mr.manualIds || [], userName }) }
            }
          } catch { /* persona 加载非关键 */ }
        }
        else setError(result.error || '加载失败')
      } catch (err) { setError(String(err.message || err)) }
      try {
        const hr = await api('worldbook/history', { sessionId: effectiveSid })
        if (hr.ok) {
          const h = hr.history || []
          const hfp = effectiveSid + '|' + h.length + '|' + (h[0]?.turn || '') + '|' + (h[0]?.status || '')
          if (hfp !== histFpRef.current) { histFpRef.current = hfp; setHist(h) }
        }
      } catch { /* 历史非关键，失败静默 */ }
    }

    React.useEffect(() => {
      void load()
      const timer = setInterval(() => { if (!busyRef.current) void load() }, 8000)
      const onVis = () => { if (!document.hidden && !busyRef.current) void load() }
      document.addEventListener('visibilitychange', onVis)
      return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis) }
    }, [sessionId])

    async function call(method, payload) {
      if (busyRef.current) return null
      busyRef.current = true; setError('')
      let ok = false
      try {
        const result = await api(method, { sessionId: effectiveSid, ...payload })
        if (result.ok) { setData({ ...data, book: result.book, ...(result.selection ? { selection: result.selection } : {}) }); ok = true }
        else setError(result.error || '操作失败')
      } catch (err) { setError(String(err.message || err)) }
      busyRef.current = false
      await load()
      return ok
    }

    // v0.9.30: Persona 操作
    const personaSetName = async (name) => {
      try {
        const r = await fetch('/api/dsh-tavern/setPlayerName', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: effectiveSid, userName: name }) })
        const j = await r.json().catch(() => null)
        if (j && (j.playerName !== undefined || j.ok !== false)) return true
        return false
      } catch { return false }
    }
    const personaSave = async () => {
      const d = personaDraft
      if (!d || !String(d.name || '').trim()) { flashTip('✗ 称呼不能为空'); return }
      busyRef.current = true
      try {
        const r = await api('persona/save', { sessionId: effectiveSid, id: d.id, name: d.name, description: d.description || '', note: d.note || '', keywords: d.keywords || '' })
        if (r.ok) { setPersonaDraft(null); flashTip('✓ 档案已保存'); await load() } else flashTip('✗ ' + (r.error || '保存失败'))
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
      busyRef.current = false
    }
    const personaApply = async (id) => {
      const m = (personaStore.personas || []).find(x => x.id === id)
      if (!m) return
      busyRef.current = true
      try {
        if (!await personaSetName(m.name)) { flashTip('✗ 玩家称呼修改失败'); busyRef.current = false; return }
        const r = await api('persona/apply', { sessionId: effectiveSid, id })
        if (r.ok) { flashTip('✓ 已应用「' + m.name + '」'); await load() } else flashTip('✗ ' + (r.error || '应用失败'))
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
      busyRef.current = false
    }
    const personaUnapply = async () => {
      busyRef.current = true
      try {
        const r = await api('persona/apply', { sessionId: effectiveSid, unapply: true })
        if (r.ok) { flashTip('已取消应用（Persona 条目已从世界书删除）'); await load() } else flashTip('✗ ' + (r.error || '操作失败'))
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
      busyRef.current = false
    }
    const personaGenEntry = async (id) => {
      const m = (personaStore.personas || []).find(x => x.id === id)
      busyRef.current = true
      try {
        const r = await api('persona/genEntry', { sessionId: effectiveSid, id })
        if (r.ok && r.created) flashTip('✓ 已在会话世界书生成非常驻条目「' + (r.title || m?.name) + '」')
        else if (r.ok && r.exists) flashTip('该档案的非常驻条目已存在（未修改）')
        else flashTip('✗ ' + (r.error || '生成失败'))
        await load()
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
      busyRef.current = false
    }
    const personaDelete = async (id) => {
      busyRef.current = true
      try {
        const r = await api('persona/delete', { sessionId: effectiveSid, id })
        if (r.ok) { if (personaStore.personaId === id) setPersonaStore(s => ({ ...s, personaId: '' })); flashTip('已删除档案'); await load() } else flashTip('✗ 删除失败')
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
      busyRef.current = false
    }

    const book = data?.book || null
    const entries = book?.entries || []
    const anchorAuto = book?.anchorAuto || {}
    const prepared = data?.prepared || null
    const recall = data?.recall || null
    // v0.7.13：preparedWorldBook 常因磁盘快照滞后为空；并集审计 outputs（requested=实际注入）作权威
    const preparedRefs = new Set([...(prepared?.refs || []), ...(recall?.outputRefs || [])].map(r => String(r)))
    const official = data?.official || null
    const officialAll = [...(official?.embedded || []), ...(official?.external || [])]
    const selectionSet = new Set((book?.selection || []).map(String))
    const forcedSet = new Set([...(recall?.forcedRefs || []), ...((hist || []).flatMap(h => h.forcedRefs || []))].map(String))
    const ctxPresent = new Set((ctxInfo?.presentRefs || []).map(String)) // v0.7.17ad: 真实在上下文（最新 reply 请求文本命中，含工具补查）
    const q = String(query || '').trim().toLocaleLowerCase()
    const inQ = text => !q || String(text || '').toLocaleLowerCase().includes(q)

    // 快照区条目（审计）——统一 ref/title/原因/渲染状态
    const recallEntries = (recall?.entries || []).map(e => ({ ...e, ref: String(e?.ref || ''), title: String(e?.title || e?.comment || e?.ref || '') }))
    // 条目元信息映射（ref → keys/content），审计条目本身无正文，从官方/临时条目关联
    const entryMeta = new Map()
    ;[...officialAll, ...(book?.entries || []).map(e => ({ ...e, ref: 'session-wb:' + e.id })), ...(data?.bound?.entries || [])].forEach(e => { if (e && e.ref) entryMeta.set(String(e.ref), e) })
    entryMetaRef.current = entryMeta
    const metaOf = (ref) => entryMeta.get(ref) || {}
    const toggleSnap = (ref) => setSnapExpanded(prev => { const s = new Set(prev); if (s.has(ref)) s.delete(ref); else s.add(ref); return s })
    const staleMark = recall ? (prepared?.turn != null && recall.turn != null && Number(recall.turn) < Number(prepared.turn) ? ' ⚠快照/审计轮次落后' : '') : ''

    // 审计字段语义映射（reason=召回/选中方式；rendering=渲染结果）
    const reasonMap = { semantic: 'LLM筛选未保留', keywords: '关键词未命中', cooldown: '⏳冷却中', unknown: '未召回' }
    const renderMap = { rendered: '✅已注入', 'not-selected': '未注入', error: '✗错误' }
    // 来源标签（官方 external 实际为 external:<路径>，需剥前缀取文件名）
    const sourceLabel = (s) => {
      if (s === 'embedded') return { label: '内嵌', cls: 'const', full: '角色卡内嵌世界书' }
      if (s && String(s).startsWith('external:')) {
        const p = String(s).slice(9)
        return { label: '外部·' + String(p).split(/[\\/]/).pop().replace(/\.(json|yaml|yml)$/i, ''), cls: 'out', full: '外部世界书: ' + p }
      }
      if (s === 'external') return { label: '外部', cls: 'out', full: '外部世界书' }
      return { label: s || '卡', cls: 'out', full: String(s || '') }
    }
    const refSource = (ref) => {
      const r = String(ref || '')
      if (r.startsWith('session-wb:')) return { label: '临时', cls: 'temp' }
      if (r.startsWith('bound:')) return { label: '会话', cls: 'bound' }
      if (r.startsWith('entry:')) return { label: '官方', cls: 'const' }
      return { label: '未知', cls: 'out' }
    }
    // 排序
    const sortList = (list) => {
      if (!sortBy || sortBy === 'default') return list
      const arr = [...list]
      const dir = sortDir === 'desc' ? -1 : 1
      switch (sortBy) {
        case 'title': arr.sort((a, b) => dir * String(a.title || '').localeCompare(String(b.title || ''), 'zh')); break
        case 'source': arr.sort((a, b) => dir * String(a.source || '').localeCompare(String(b.source || ''), 'zh')); break
        case 'status': arr.sort((a, b) => dir * ((Number(!!b.inContext) - Number(!!a.inContext)) || String(a.reason || '').localeCompare(String(b.reason || ''), 'zh'))); break
        case 'order': arr.sort((a, b) => dir * (Number(a.outputOrder || 0) - Number(b.outputOrder || 0))); break
      }
      return arr
    }


    // 官方条目匹配审计（命中原因）与在上下文状态
    const officialWithState = officialAll.map(e => {
      const audit = recallEntries.find(r => r.ref === e.ref) || recallEntries.find(r => r.title === e.title)
      return { ...e, inContext: preparedRefs.has(e.ref), reason: audit?.reason ? (audit.reason === 'selected' ? '' : (reasonMap[audit.reason] || audit.reasonLabel || audit.reason)) : (preparedRefs.has(e.ref) ? '已注入' : '未召回'), reasonRaw: audit?.reason || null, reasonFull: audit?.reasonLabel || '', rendering: audit?.rendering || null }
    }).filter(e => inQ(e.title + ' ' + (e.keys || []).join(' ') + ' ' + e.content))

    const tempFiltered = entries.filter(e => inQ(e.title + ' ' + (e.keys || []).join(' ') + ' ' + e.content))

    const cooldownRefs = new Set((recall?.cooldownRefs || []).map(String))
    const isCooling = (ref) => cooldownRefs.has(String(ref))
    const toggleSelection = (id) => {
      const next = selectionSet.has(id)
        ? [...selectionSet].filter(x => x !== id)
        : [...selectionSet, id]
      call('worldbook/select', { entryIds: next })
    }

    const TabBtn = (id, label, count) => h('button', {
      className: tab === id ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', onClick: () => setTab(id)
    }, label + (count ? ' (' + count + ')' : ''))

    // v0.7.17ac：标签筛选。chips 互斥单选（点激活项取消）；多选框可多选，「交集」勾选=AND 否则 OR
    // v0.7.17ah：列表筛选结果计数（n=筛选后条数, m=标签筛选前条数）
    // v0.7.17am：预测文本源 = 当前输入框文本 + 上一段 AI 输出（DSHT 世界书关键词匹配的真实文本范围）
    const predictSource = ((predictText || '') + '\n' + (lastTurnText || '')).trim()
    // v0.7.17ak：预测关键词命中（对齐 DSHT worldbook-activation keyMatch/literalMatch：正则key/大小写不敏感子串/单字中文独立成词）
    const predictHit = (keys, text) => {
      if (!text || !Array.isArray(keys) || keys.length === 0) return false
      const source = text.toLocaleLowerCase()
      return keys.some(k => {
        const key = String(k || '').trim()
        if (!key) return false
        const rm = /^\/(.*)\/([dgimsuvy]*)$/.exec(key)
        if (rm) { try { return new RegExp(rm[1], rm[2].replaceAll('g', '').replaceAll('y', '')).test(text) } catch (e) { return false } }
        const needle = key.toLocaleLowerCase()
        if (needle === '') return false
        if (/^\p{Script=Han}$/u.test(needle)) return new RegExp('(?:^|[^\\p{L}\\p{N}\\p{M}_])' + needle + '(?=$|[^\\p{L}\\p{N}\\p{M}_])', 'u').test(source)
        return source.includes(needle)
      })
    }
    const countBar = (nn, mm) => h('div', { style: { fontSize: 11, color: 'var(--na-dim)', margin: '6px 2px 4px', whiteSpace: 'nowrap' } },
      '共 ' + mm + ' 条' + (nn !== mm ? ' · 筛选 ' + nn + ' 条' : ''))
    const matchTag = (tags, f, useIntersect, useInvert) => {
      if (!tags || tags.size === 0) return true
      const ok = (t) => {
        switch (t) {
          case 'embedded': return !!f.embedded
          case 'external': return !!f.external
          case 'inctx': return !!f.inctx
          case 'recalled': return !!f.recalled
          case 'notrecalled': return !f.recalled
          case 'constant': return !!f.constant
          case 'disabled': return !!f.disabled
          case 'anchor': return !!f.anchor
          case 'sideline': return !!f.sideline
          case 'manual': return !!f.manual
          case 'forced': return !!f.forced
          case 'rendered': return !!f.rendered
          case 'notsel': return !!f.notsel
          case 'sel': return !!f.sel
          case 'cooldown': return !!f.cooldown
          case 'semkill': return !!f.semkill
          case 'kwmiss': return !!f.kwmiss
          case 'official': return !!f.official
          case 'temp': return !!f.temp
          case 'bound': return !!f.bound
          case 'prevForced': return !!f.prevForced
          case 'pred': return !!f.pred
          case 'global': return !!f.global
          case 'unavail': return !!f.unavail
          default: return false
        }
      }
      let m
      // v0.9.20：三态筛选——filterTags 为 Map<tag,'inc'|'exc'>；兼容旧 Set（bind 区不用 matchTag，仅防御）
      const inc = [], exc = []
      if (tags && typeof tags.forEach === 'function') tags.forEach((st, t) => { (st === 'exc' ? exc : inc).push(t) })
      else if (tags && tags.size) for (const t of tags) inc.push(t)
      if (inc.length === 0 && exc.length === 0) return true
      const anyOk = (list) => { for (const t of list) if (ok(t)) return true; return false }
      const allOk = (list) => { for (const t of list) if (!ok(t)) return false; return true }
      const passInc = inc.length === 0 ? true : (useIntersect ? allOk(inc) : anyOk(inc))
      const passExc = exc.length === 0 ? true : !anyOk(exc)
      m = passInc && passExc
      return m
    }
    // v0.9.19：临时条目可见集（搜索词 + 标签筛选，与列表渲染完全一致）——导出/清空共用
    const visibleTemp = sortList(tempFiltered.filter(e => matchTag(filterTags, { anchor: e.source === 'anchor', sideline: e.source === 'sideline', manual: e.source !== 'anchor' && e.source !== 'sideline', forced: selectionSet.has('session-wb:' + e.id), inctx: ctxPresent.has('session-wb:' + e.id), disabled: e.enabled === false, constant: e.constant === true, cooldown: isCooling('session-wb:' + e.id), pred: predictHit(e.keys, predictSource) }, intersect)))
    const FilterChips = (opts) => h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' } },
      h('button', { key: '__all', className: filterTags.size === 0 ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', style: { padding: '2px 9px', fontSize: 11.5 }, title: '清空所有标签筛选', onClick: () => setFilterTags(new Map()) }, '全部'),
      opts.map(o => {
        const st = filterTags.get(o.v) // undefined=未选中 'inc'=选中 'exc'=反选
        const style = { padding: '2px 9px', fontSize: 11.5 }
        if (st === 'exc') { style.background = '#c64545'; style.borderColor = '#c64545'; style.color = '#fff' }
        return h('button', {
          key: o.v,
          className: st === 'inc' ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn',
          style,
          title: '互斥三态：点选只看此类（清掉其他 chip 状态）→ 再点反选（红 ✖）→ 再点取消；多选组合请用「所有标签」下拉',
          onClick: () => { const cur = filterTags.get(o.v); const m = new Map(); if (!cur) m.set(o.v, 'inc'); else if (cur === 'inc') m.set(o.v, 'exc'); setFilterTags(m) }
        }, (st === 'inc' ? '✔' : st === 'exc' ? '✖' : '') + o.label)
      })
    )
    // v0.7.17t：标签定义单一数据源。顺序 = 条目徽标从左到右；chip=true 进常用 chips，全量进「所有标签」多选框
    const tagDefs = {
      official: [
        {v:'embedded',label:'内嵌',chip:true},{v:'external',label:'外部',chip:true},
        
        {v:'inctx',label:'📌在上下文',chip:true},{v:'constant',label:'常驻',chip:true},{v:'disabled',label:'停用',chip:true},
        {v:'sel',label:'⚡强制注入',chip:true}
,{v:'pred',label:'预测命中',chip:true}
      ],
      temporary: [
        {v:'anchor',label:'锚点',chip:true},{v:'sideline',label:'支线',chip:true},{v:'manual',label:'人工',chip:true},
        {v:'forced',label:'⚡强制注入',chip:true},{v:'inctx',label:'📌在上下文',chip:true},
        {v:'constant',label:'★常驻',chip:true},
        {v:'cooldown',label:'⏳冷却中'},{v:'disabled',label:'已停用',chip:true}
,{v:'pred',label:'预测命中',chip:true}
      ],
      snapshot: [
        {v:'official',label:'官方'},{v:'temp',label:'临时'},{v:'bound',label:'会话'},
        {v:'rendered',label:'✅已注入',chip:true},{v:'notsel',label:'未注入',chip:true},
        {v:'cooldown',label:'⏳冷却中',chip:true},{v:'kwmiss',label:'关键词未命中'},
        {v:'semkill',label:'LLM筛选未保留',chip:true},{v:'prevForced',label:'⚡前轮强制注入',chip:true},
        {v:'inctx',label:'📌在上下文',chip:true},{v:'constant',label:'常驻'}
      ]
    }
    // v0.7.17as: 自定义弹出多选（原生 <select multiple> 在 Edge 显示为滚动框且点击即单选，弃用）
    const TagMultiSelect = (opts) => h('div', { ref: tagRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
      h('button', { className: filterTags.size ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', style: { padding: '2px 9px', fontSize: 11.5 }, title: '所有标签（点击弹出，可多选；外部点击关闭）', onClick: () => setTagOpen(v => !v) },
        '▾ 所有标签' + (filterTags.size ? ' · ' + filterTags.size : '')),
      tagOpen ? h('div', { style: { position: 'absolute', top: '100%', left: 0, zIndex: 9999, background: 'var(--na-card)', border: '1px solid var(--na-border)', borderRadius: 7, padding: 6, maxHeight: 300, overflowY: 'auto', minWidth: 150, boxShadow: '0 6px 18px rgba(0,0,0,.4)' } },
        opts.map(o => {
          const st = filterTags.get(o.v)
          return h('label', { key: o.v, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, padding: '3px 6px', cursor: 'pointer', whiteSpace: 'nowrap', color: st === 'exc' ? '#ff9c9c' : st === 'inc' ? 'var(--na-accent)' : 'var(--na-text)', borderRadius: 5 },
            title: '三态：点击选中 → 再点反选 → 再点取消',
            onClick: (ev) => { ev.preventDefault(); const m = new Map(filterTags); const cur = m.get(o.v); if (!cur) m.set(o.v, 'inc'); else if (cur === 'inc') m.set(o.v, 'exc'); else m.delete(o.v); setFilterTags(m) } },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, borderRadius: 3, fontSize: 11, lineHeight: 1, background: st === 'inc' ? 'var(--na-accent)' : st === 'exc' ? '#c64545' : 'transparent', border: st ? 'none' : '1px solid var(--na-border)', color: '#fff' } }, st === 'inc' ? '✔' : st === 'exc' ? '✖' : ''),
            o.label)
        }))
      : null)
    // v0.7.17c：页签内工具栏（检索+筛选+排序），紧挨条目列表
    const renderToolbar = (tabKey) => h('div', null,
      h('input', { className: 'dsh-local-input', style: { width: '100%', marginTop: 6 }, placeholder: '检索：标题 / 关键词 / 正文（当前页签内过滤）', value: query || '', onChange: e => setQuery(e.target.value) }),
      h('div', { style: { marginTop: 7, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
        FilterChips((tagDefs[tabKey] || tagDefs.official).filter(d => d.chip)),
        TagMultiSelect(tagDefs[tabKey] || tagDefs.official),
        h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color: 'var(--na-dim)', whiteSpace: 'nowrap', cursor: 'pointer', marginLeft: 2 }, title: '勾选后多个标签需同时满足（AND）；不勾选为任一满足（OR）。反选请直接把标签点成红色 ✖' },
          h('input', { type: 'checkbox', checked: intersect, onChange: e => setIntersect(e.target.checked), style: { width: 13, height: 13, cursor: 'pointer', margin: 0 } }),
          '交集'),
        h('select', { className: 'dsh-local-input', style: { marginLeft: 'auto', minHeight: 26, fontSize: 11.5, width: 'auto' }, value: sortBy, onChange: e => setSortBy(e.target.value) },
          h('option', { value: 'default' }, '排序: 默认'),
          h('option', { value: 'title' }, '排序: 标题'),
          h('option', { value: 'source' }, '排序: 来源'),
          h('option', { value: 'status' }, '排序: 注入状态'),
          h('option', { value: 'order' }, '排序: 输出顺序')
        ),
        h('button', { className: 'dsh-local-btn', style: { minHeight: 26, padding: '2px 9px', fontSize: 11.5 }, title: sortDir === 'asc' ? '升序（点击切换降序）' : '降序（点击切换升序）', onClick: () => setSortDir(sortDir === 'asc' ? 'desc' : 'asc') }, sortDir === 'asc' ? '↑升' : '↓降')
      )
    )

    return h('div', { className: 'dsh-tavern-settings-root na-page', style: { minHeight: 'calc(100vh - 44px)', maxHeight: 'calc(100vh - 44px)', overflowY: 'auto' } },
      h('h2', null, '会话世界书管理'),
      tip ? h('div', { style: { background: 'var(--na-accent-soft)', border: '1px solid var(--na-accent)', color: 'var(--na-text)', borderRadius: 8, padding: '6px 10px', fontSize: 12, marginBottom: 8 } }, tip) : null,
      !sessionId ? h('p', { className: 'dsh-local-help' }, '请打开一个游玩会话后再查看') :

      h('div', null,
        // ── 开关区 ──
        h('section', { className: 'dsh-local-section' },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }, onClick: () => setBookOpen(!bookOpen) },
            h('h3', { style: { margin: 0 } }, (bookOpen ? '▾ ' : '▸ ') + '临时世界书开关'),
            h('span', { style: { fontSize: 11, color: 'var(--na-dim)', fontWeight: 600 } }, book?.enabled ? '已启用' : '已停用')
          ),
          bookOpen ? h('div', null,
          h('label', { className: 'dsh-local-label' },
            h('span', null,
              '启用会话临时世界书',
              h('span', { className: 'dsh-tavern-settings-desc' }, '开启后本会话的临时条目并入 DSHT 原生世界书召回（关键词 / Agent 筛选）')
            ),
            h('input', { type: 'checkbox', checked: !!book?.enabled, onChange: e => call('worldbook/settings', { enabled: e.target.checked }) })
          ),
          h('label', { className: 'dsh-local-label' },
            h('span', null,
              '结算后自动将锚点数据流入临时世界书',
              h('span', { className: 'dsh-tavern-settings-desc' }, '每轮后台结算时，自动把叙事锚点数据写入临时世界书（按下方四项勾选）')
            ),
            h('input', { type: 'checkbox', checked: !!book?.autoFromAnchor, onChange: e => call('worldbook/settings', { autoFromAnchor: e.target.checked }) })
          ),
          // [2026-09-29 暂停] 当前状态已通过 foreground 每轮注入，世界书流入无意义，隐藏开关
          // h('label', { className: 'dsh-local-label' },
          //   h('span', null,
          //     '自动流入：当前状态',
          //     h('span', { className: 'dsh-tavern-settings-desc' }, '时间 / 世界 / 地点 / 在场人物 / 环境 / 关键物品')
          //   ),
          //   h('input', { type: 'checkbox', checked: anchorAuto.currentState !== false, onChange: e => call('worldbook/settings', { anchorAuto: { currentState: e.target.checked } }) })
          // ),
          h('label', { className: 'dsh-local-label' },
            h('span', null,
              '自动流入：已知情报',
              h('span', { className: 'dsh-tavern-settings-desc' }, '已证实的关键设定 / 情报条目')
            ),
            h('input', { type: 'checkbox', checked: anchorAuto.knownFacts !== false, onChange: e => call('worldbook/settings', { anchorAuto: { knownFacts: e.target.checked } }) })
          ),
          h('label', { className: 'dsh-local-label' },
            h('span', null,
              '自动流入：长期记忆',
              h('span', { className: 'dsh-tavern-settings-desc' }, 'LTM 长期记忆压缩摘要；载入的条目默认停用，需手动启用才参与关键词召回')
            ),
            h('input', { type: 'checkbox', checked: anchorAuto.ltm === true, onChange: e => call('worldbook/settings', { anchorAuto: { ltm: e.target.checked } }) })
          ),
          // [2026-09-29 暂停] 大纲路线暂时不单独维护，剧情信息自然流入STM
          // h('label', { className: 'dsh-local-label' },
          //   h('span', null,
          //     '自动流入：剧情大纲',
          //     h('span', { className: 'dsh-tavern-settings-desc' }, '当前节点 / 前情衔接 / 下一幕规划')
          //   ),
          //   h('input', { type: 'checkbox', checked: anchorAuto.plotRoute === true, onChange: e => call('worldbook/settings', { anchorAuto: { plotRoute: e.target.checked } }) })
          // ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
            h('button', { className: 'dsh-local-btn', title: '立刻按上方勾选，把当前叙事锚点数据导入临时世界书（不等后台结算）', onClick: async () => { const ok = await call('worldbook/settings', { importNow: true }); if (ok) flashTip('✓ 已从锚点导入临时世界书') } }, '立即从锚点导入'),
            h('button', { className: 'dsh-local-btn', title: '清除所有已勾选的「强制注入」条目（selection 列表清空）', onClick: async () => { const ok = await call('worldbook/select', { clear: true }); if (ok) flashTip('✓ 已清空强制注入选择') } }, '清空注入选择')
          )
          ) : null
        ),

        // ── 页签导航 ──
        h('section', { className: 'dsh-local-section' },
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
            TabBtn('snapshot', '动态快照', recallEntries.length),
            TabBtn('official', '官方世界书', officialAll.length),
            TabBtn('temporary', '临时条目', entries.length),
            TabBtn('sessionwb', '会话世界书', (data?.bound?.entryCount) || 0),
            TabBtn('persona', '人格面具', (personaStore.personas || []).length)
          )
        ),

        // ── 强制注入提示条 ──
        selectionSet.size > 0 ? h('div', { className: 'na-inject-bar' }, '⚡ 已选 ' + selectionSet.size + ' 条强制注入，下一次回复生效（force 激活：过筛选豁免 + 守 10 轮冷却）') : null,

        // ── 页签：动态快照 ──
        tab === 'snapshot' ? h('section', { className: 'dsh-local-section' },
          h('h3', null, '动态世界书快照（DSHT 原生召回）' + (staleMark || '')),
          prepared ? h('p', { className: 'dsh-local-help' }, '模式: ' + (prepared.mode || '-') + ' · 快照轮: ' + (prepared.turn ?? '-') + (recall ? ' · 审计轮: ' + (recall.turn ?? '-') + ' · 状态: ' + (recall.status || '-') : '') + ' · 字符: ' + (prepared.contextChars || 0) + '/' + (prepared.totalChars || 0)) : null,
          h('p', { className: 'dsh-local-help', style: { margin: '6px 0 2px' } }, (() => { const src = histTurn != null ? (hist || []).find(r => Number(r.turn) === histTurn) : recall; return recallStatsLine(src) })()),
          h('details', { className: 'dsh-local-help', style: { marginBottom: 6 } },
            h('summary', { style: { cursor: 'pointer' } }, '这是什么？筛选流程 + 标签说明（点击展开）'),
            h('p', { style: { margin: '6px 0 2px', fontSize: 11.5 } }, '每次回复前，DSHT 会自动从你绑定的世界书里挑条目注入上下文（= 动态世界书快照）。下表 = 最新一轮的挑选结果。挑选流程：'),
            h('div', { style: { margin: '6px 0', fontSize: 11 } },
              h('div', { style: { border: '1px solid #555', borderRadius: 5, padding: '4px 7px', background: 'rgba(255,255,255,.04)' } }, h('b', { style: { display: 'block' } }, '① 关键词匹配'), h('span', null, '除「常驻」和「你勾选的强制注入」外，每个条目都要在本轮内容里找自己的关键词；没找到 → 淘汰（关键词未命中）')),
              h('div', { style: { textAlign: 'center', color: '#888', lineHeight: '14px' } }, '↓'),
              h('div', { style: { border: '1px solid #555', borderRadius: 5, padding: '4px 7px', background: 'rgba(255,255,255,.04)' } }, h('b', { style: { display: 'block' } }, '② 候选池 → AI 复核'), h('span', null, '关键词命中的条目组成候选池；池子不大（≤5条且≤2000字）直接全保留，大则由后台 AI 词面预筛 + 逐条判断，只留相关的（没留 → LLM筛选未保留）')),
              h('div', { style: { textAlign: 'center', color: '#888', lineHeight: '14px' } }, '↓'),
              h('div', { style: { border: '1px solid #555', borderRadius: 5, padding: '4px 7px', background: 'rgba(255,255,255,.04)' } }, h('b', { style: { display: 'block' } }, '③ 注入快照'), h('span', null, '常驻直通 + 强制注入直通 + 通过 AI 复核的普通条目 → 写进上下文，进入「动态世界书快照」')),
              h('div', { style: { textAlign: 'center', color: '#888', lineHeight: '14px' } }, '↓'),
              h('div', { style: { border: '1px solid #555', borderRadius: 5, padding: '4px 7px', background: 'rgba(255,255,255,.04)' } }, h('b', { style: { display: 'block' } }, '④ 冷却'), h('span', null, '注入过的条目 10 轮内不再自动出现；正文被编辑 / 重新生成时立即解除'))
            ),
            h('p', { style: { margin: '2px 0 6px', fontSize: 11, opacity: .8 } }, '「强制注入」（勾选）跳过 ①② 直接进 ③，AI 不能把它筛掉；但同样守 10 轮冷却。'),
            h('p', { style: { margin: '2px 0 6px', fontSize: 11, opacity: .8 } }, '另有一条独立通道「主动补查」：正文 AI 缺资料时可临时搜索世界书（不进快照、无冷却、只活在当轮上下文）。'),
            h('b', { style: { display: 'block', marginTop: 6 } }, '条目徽标（从左到右）：'),
            h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.75 } },
              h('li', null, '官方 / 临时：来源——角色卡或外部世界书文件 / 本插件创建的会话临时条目。'),
              h('li', null, '✅已注入 / 未注入：这一轮有没有真写进上下文。'),
              h('li', null, '⏳冷却中：正在 10 轮冷却，本轮不参与挑选（刚注入的条目从下一轮筛选起进入冷却；注入当轮显示 已注入 / ⚡前轮强制注入）。'),
              h('li', null, '关键词未命中：关键词没在本轮出现，第一步就被淘汰。'),
              h('li', null, 'LLM筛选未保留：进了候选池，但被后台 AI 筛掉了。'),
              h('li', null, '⚡前轮强制注入：之前几轮实际以强制身份注入的条目（勾选操作在官方 / 临时页签进行）。'),
              h('li', null, '常驻：每轮固定注入，不看关键词。'),
              h('li', null, '输出#N：在快照中的写入顺序。')
            )
          ),
          renderToolbar('snapshot'),
          (hist && hist.length > 1) ? h('div', { style: { marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { className: 'dsh-local-help', style: { fontSize: 11, opacity: .75, margin: 0 } }, '历史轮次:'),
            (() => {
              const turns = hist.slice().reverse() // 最新在前
              const chips = turns.slice(0, 3)      // 最近 3 轮
              const rest = turns.slice(3)          // 其余走下拉
              const turnBtn = (v, label, hint) => {
                const active = (histTurn ?? '') === v
                return h('button', {
                  key: v, className: 'dsh-local-btn',
                  style: {
                    minHeight: 24, padding: '1px 9px', fontSize: 11,
                    borderColor: active ? 'var(--na-accent)' : undefined,
                    color: active ? 'var(--na-accent)' : undefined,
                    fontWeight: active ? 600 : 400,
                    background: active ? 'var(--na-card-hover)' : undefined
                  },
                  title: hint, onClick: () => setHistTurn(v ? Number(v) : null)
                }, label)
              }
              const hintOf = r => r ? ('注入 ' + (r.outputs?.length || 0) + ' 条 · 快照 ' + (r.entriesCount || 0) + ' 条') : '实时最新轮'
              return [
                turnBtn('', '最新', hintOf(null)),
                ...chips.map(r => turnBtn(String(r.turn), '第' + r.turn + '轮' + (r.status === 'requested' ? '·已注入' : ''), hintOf(r))),
                rest.length ? h('select', { key: 'more', className: 'dsh-local-input', style: { minHeight: 24, fontSize: 11, maxWidth: 150 }, value: (histTurn != null && rest.some(r => String(r.turn) === String(histTurn))) ? String(histTurn) : '', onChange: e => setHistTurn(e.target.value ? Number(e.target.value) : null) },
                  h('option', { value: '' }, '更多轮次 ▾'),
                  rest.map(r => h('option', { key: r.turn, value: String(r.turn) }, '第 ' + r.turn + ' 轮 · ' + (r.status === 'requested' ? '已注入' : '未发送') + ' · 注入 ' + (r.outputs?.length || 0) + ' 条'))
                ) : null
              ]
            })()
          ) : null,
          histTurn != null ? (() => {
            const hh = (hist || []).find(r => Number(r.turn) === histTurn)
            if (!hh) return h('p', { className: 'dsh-local-help' }, '该轮无审计数据')
            return h('div', null,
              h('p', { className: 'dsh-local-help', style: { marginTop: 6 } }, '本轮注入条目:'),
              (hh.outputs && hh.outputs.length) ? h('div', null, hh.outputs.map((o, i) => h('div', { key: o.ref || i, className: 'dsh-local-entry', style: { border: '1px solid #444', borderRadius: 6, padding: '6px 8px', marginBottom: 6 } },
                h('b', null, o.ref || ('#' + i)),
                h('p', { style: { margin: '2px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' } }, String(o.text || ''))
              ))) : h('p', { className: 'dsh-local-help' }, '该轮无实际注入条目' + (hh.status === 'requested' ? '（结算中断，未产出快照）' : ''))
            )
          })() :
          (recallEntries.length === 0 ? h('p', { className: 'dsh-local-help' }, preparedRefs.size ? '快照存在但暂无审计记录（筛选/审计可能未运行或已欠费中断）' : (hist && hist.length ? '最新轮无召回数据（未发送或本轮无变化）' : '暂无召回审计。发出正文后自动产生。')) :
          h('div', null, countBar(sortList(recallEntries.filter(r => inQ(r.title + ' ' + (r.reason || '') + ' ' + (r.reasonLabel || '')) && matchTag(filterTags, { rendered: r.rendering === 'rendered', notsel: r.rendering === 'not-selected', recalled: preparedRefs.has(r.ref), sel: selectionSet.has(r.ref), cooldown: r.reason === 'cooldown', semkill: r.reason === 'semantic', kwmiss: r.reason === 'keywords', constant: r.constant === true, official: refSource(r.ref).cls === 'const', temp: refSource(r.ref).cls === 'temp', bound: refSource(r.ref).cls === 'bound', prevForced: forcedSet.has(r.ref), inctx: ctxPresent.has(r.ref) }, intersect))).length, recallEntries.length), sortList(recallEntries.filter(r => inQ(r.title + ' ' + (r.reason || '') + ' ' + (r.reasonLabel || '')) && matchTag(filterTags, { rendered: r.rendering === 'rendered', notsel: r.rendering === 'not-selected', recalled: preparedRefs.has(r.ref), sel: selectionSet.has(r.ref), cooldown: r.reason === 'cooldown', semkill: r.reason === 'semantic', kwmiss: r.reason === 'keywords', constant: r.constant === true, official: refSource(r.ref).cls === 'const', temp: refSource(r.ref).cls === 'temp', bound: refSource(r.ref).cls === 'bound', prevForced: forcedSet.has(r.ref), inctx: ctxPresent.has(r.ref) }, intersect))).map((r, i) => { const rs = refSource(r.ref); let meta = entryMeta.get(r.ref); if (!meta && r.title) meta = [...entryMeta.values()].find(m => String(m?.title || '') === r.title); const kArr = Array.isArray(meta?.keys) ? meta.keys : []; const hitKeys = Array.isArray(r?.match?.primary) ? r.match.primary.map(m => String(m?.key || '')).filter(Boolean) : []; const hitExcerpts = Array.isArray(r?.match?.primary) ? r.match.primary.map(m => String(m?.excerpt || '')).filter(Boolean) : []; const open = snapExpanded.has(r.ref); return h('div', { key: r.ref || i, className: 'dsh-local-entry', style: { border: '1px solid #333', borderRadius: 6, padding: '6px 8px', marginBottom: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }, title: open ? '收起内容' : '点击展开关键词与内容', onClick: () => toggleSnap(r.ref) },
              h('b', null, (open ? '▾ ' : '▸ ') + (r.title || r.ref)),
              h('span', { className: 'na-badge na-b-' + rs.cls, title: r.ref }, rs.label),
              (r.rendering === 'rendered' ? h('span', { className: 'na-badge na-b-in' }, '✅已注入') : r.rendering === 'not-selected' ? h('span', { className: 'na-badge na-b-out' }, '未注入') : r.rendering ? h('span', { className: 'na-badge na-b-off' }, '✗' + r.rendering) : null),
              (ctxPresent.has(r.ref) ? h('span', { className: 'na-badge na-b-ctx', title: '出现在最新一轮模型请求上下文（含工具补查）' }, '📌在上下文') : null),
              (r.reason && r.reason !== 'selected' ? h('span', { className: 'na-badge na-b-warn', title: r.reasonLabel || '' }, (r.reason && reasonMap[r.reason]) ? reasonMap[r.reason] : (r.reasonLabel || r.reason || '?')) : null),
              (forcedSet.has(r.ref) ? h('span', { className: 'na-badge na-b-force' }, '⚡前轮强制注入') : null),
              (r.constant === true ? h('span', { className: 'na-badge na-b-constant' }, '常驻') : null),
              r.outputOrder ? h('span', { className: 'na-badge na-b-const' }, '输出#' + r.outputOrder) : null
            ),
            h('p', { style: { marginTop: 2, marginBottom: 0, fontSize: 10.5, opacity: .7 } }, kArr.length ? '关键词: ' + kArr.join('、') : hitKeys.length ? '命中词: ' + hitKeys.join('、') + '（审计命中词）' : (meta || !String(r.ref || '').startsWith('entry:')) ? '无关键词（仅 Agent 判断 / 强制注入）' : '条目元信息未关联此 ref（旧轮次条目或官方列表已变更）'),
            (open && meta?.content) ? h('p', { style: { marginTop: 4, marginBottom: 0, fontSize: 11.5, whiteSpace: 'pre-wrap', borderTop: '1px dashed #444', paddingTop: 4 } }, String(meta.content)) : (open && hitExcerpts.length ? h('p', { style: { marginTop: 4, marginBottom: 0, fontSize: 11.5, whiteSpace: 'pre-wrap', borderTop: '1px dashed #444', paddingTop: 4 } }, '命中摘录: ' + hitExcerpts.join(' … ')) : null)
          ) })))
        ) : null,

        // ── 页签：官方世界书 ──
        tab === 'official' ? h('section', { className: 'dsh-local-section' },
          // [v0.9.5] 官方条目编辑改为弹层
          offDraft ? h(EditModal, {
            title: '编辑条目：' + (offDraft.title || offDraft.ref),
            onClose: () => setOffDraft(null),
            footer: [
              h('button', { key: 'cancel', className: 'dsh-local-btn', onClick: () => setOffDraft(null) }, '取消'),
              h('button', { key: 'save', className: 'dsh-local-btn na-tab-active', onClick: async () => {
                if (!offDraft.title && !offDraft.content) return
                await call('worldbook/entry', { action: 'update', source: offDraft.source, entry: { ref: offDraft.ref, title: offDraft.title || '', keys: (offDraft.keys || '').split(/\s+/).filter(Boolean), content: offDraft.content || '' } })
                setOffDraft(null)
                load()
              } }, '保存修改')
            ]
          },
            h('p', { key: 'hint', className: 'dsh-local-help', style: { margin: '0 0 6px' } }, '直接写回 ' + (offDraft.source ? (offDraft.source === 'embedded' ? '角色卡工作副本' : offDraft.source) : '绑定世界书文件') + '（DSHT 按需读盘，下轮筛选即生效）。仅改标题 / 关键词 / 正文，不提供删除。'),
            h('input', { key: 'title', className: 'dsh-local-input', style: { width: '100%', marginBottom: 6 }, placeholder: '标题', autoFocus: true, value: offDraft.title || '', onChange: e => setOffDraft({ ...offDraft, title: e.target.value }) }),
            h('input', { key: 'keys', className: 'dsh-local-input', style: { width: '100%', marginBottom: 6 }, placeholder: '关键词（空格分隔）', value: offDraft.keys || '', onChange: e => setOffDraft({ ...offDraft, keys: e.target.value }) }),
            h('textarea', { key: 'content', className: 'dsh-local-input', style: { width: '100%', minHeight: 120 }, placeholder: '条目正文', value: offDraft.content || '', onChange: e => setOffDraft({ ...offDraft, content: e.target.value }) })
          ) : null,
          h('h3', null, '官方世界书（卡内嵌 + 外部绑定）— ' + officialAll.length + ' 条'),
          h('details', { className: 'dsh-local-help', style: { marginBottom: 6 } },
            h('summary', { style: { cursor: 'pointer' } }, '标签说明（点击展开）'),
            h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.75 } },
              h('li', null, '内嵌：来自角色卡自带的世界书；外部·文件名：来自外部绑定的世界书文件。'),
              h('li', null, '📌在上下文：最新一轮真实模型请求里出现过（含工具补查读入；冷却/未命中条目可能因历史快照残留仍在上下文）。'),
              h('li', null, '常驻：每轮固定注入（不看关键词）；停用：不参与挑选。'),
              h('li', null, '淘汰原因：冷却中 / 关键词未命中 / LLM筛选未保留 = 这一轮为什么没进（同快照页）。'),
              h('li', null, '勾选 = ⚡强制注入下一次回复：跳过筛选直接进快照，但同样守 10 轮冷却。'),
              h('li', null, '界面版本 v0.7.17ar · 若显示旧版（排序/下拉框与桌面端不一致），请硬刷新（Ctrl+F5）后重试。')
            )
          ),
          renderToolbar('official'),
          !data?.dataRoot ? h('p', { className: 'dsh-local-warning' }, '未能定位 DSH 用户数据目录（dataRoot 推导失败），官方条目不可读。') : null,
          officialWithState.length === 0 ? h('p', { className: 'dsh-local-help' }, '无匹配条目。' + (q ? ' 换关键词试试。' : '')) :
          h('div', null, countBar(sortList(officialWithState.filter(e => matchTag(filterTags, { embedded: e.source === 'embedded', external: e.source && String(e.source).startsWith('external:'), inctx: ctxPresent.has(e.ref), constant: !!e.constant, disabled: e.enabled === false, sel: selectionSet.has(e.ref), pred: predictHit(e.keys, predictSource) }, intersect))).length, officialWithState.length), sortList(officialWithState.filter(e => matchTag(filterTags, { embedded: e.source === 'embedded', external: e.source && String(e.source).startsWith('external:'), inctx: ctxPresent.has(e.ref), recalled: !!e.inContext, constant: !!e.constant, disabled: e.enabled === false, sel: selectionSet.has(e.ref), pred: predictHit(e.keys, predictSource) }, intersect))).map((e, i) => { const src = sourceLabel(e.source); const selNow = selectionSet.has(e.ref); return h('div', { key: e.ref || i, className: 'dsh-local-entry', 'data-ref': String(e.ref || ''), style: { border: '1px solid #333', borderRadius: 6, padding: '6px 8px', marginBottom: 6 }, onContextMenu: (ev) => { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, ref: e.ref, source: e.source, title: e.title, keys: e.keys || [], content: String(e.content || ''), enabled: e.enabled !== false }) }, onMouseDown: (ev) => { if (ev.button === 2) { ev.preventDefault(); setCtxMenu({ x: ev.clientX, y: ev.clientY, ref: e.ref, source: e.source, title: e.title, keys: e.keys || [], content: String(e.content || ''), enabled: e.enabled !== false }) } } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('input', { type: 'checkbox', checked: selNow, title: '强制注入下一次回复', onChange: () => toggleSelection(e.ref) }),
              (selNow ? h('span', { className: 'na-badge na-b-force' }, '⚡强制注入') : null),
              h('b', null, e.title || e.ref),
              h('span', { className: 'na-badge na-b-' + src.cls, title: src.full }, src.label),
              (e.enabled === false ? h('span', { className: 'na-badge na-b-off' }, '停用') : null),
              (ctxPresent.has(e.ref) ? h('span', { className: 'na-badge na-b-ctx', title: '出现在最新一轮模型请求上下文（含工具补查）' }, '📌在上下文') : null),
              (e.keys && e.keys.length ? predictHit(e.keys, predictSource) ? h('span', { className: 'na-badge na-b-pred', title: '预测：输入框文本 + 上一段 AI 输出命中关键词，提交后将被自动召回' }, '预测关键词命中') : null : null),
              e.reason ? h('span', { className: 'na-badge na-b-warn', title: e.reasonFull || '' }, e.reason) : null,
              (e.constant ? h('span', { className: 'na-badge na-b-constant' }, '常驻') : null),
            ),
            (e.keys && e.keys.length ? h('p', { className: 'dsh-local-help', style: { marginTop: 2 } }, '关键词: ' + e.keys.join('、') + ' ') : h('p', { className: 'dsh-local-help', style: { marginTop: 2 } }, '无关键词（只能靠强制注入直通，不会被自动召回） ')),
            (() => {
              const body = String(e.content || '')
              const open = expandedRefs.has(e.ref)
              const shown = open ? body : body.slice(0, 160)
              return h('div', null,
                body ? h('p', { style: { margin: '2px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' } }, shown + (body.length > 160 && !open ? '…' : '') + (body.length > 160 ? ' ' : '')) : h('p', { className: 'dsh-local-help', style: { margin: '2px 0 0' } }, '（条目无正文）'),
                body.length > 160 ? h('button', { className: 'dsh-local-btn', style: { marginTop: 2 }, onClick: () => { const s = new Set(expandedRefs); if (open) s.delete(e.ref); else s.add(e.ref); setExpandedRefs(s) } }, open ? '收起' : '展开全文') : null
              )
            })()
          ) }))
        ) : null,

          ctxMenu ? ReactDOM.createPortal(h('div', { className: 'na-ctx-menu', onMouseDown: e => e.stopPropagation(), onClick: e => e.stopPropagation(), style: { position: 'fixed', left: Math.min(ctxMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 150), top: Math.min(ctxMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 90), zIndex: 2147483000, background: '#23272f', border: '1px solid #555', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,.5)', padding: 4, minWidth: 132 } },
            h('button', { className: 'dsh-local-btn', style: { display: 'block', width: '100%', textAlign: 'left', marginBottom: 2 }, onClick: () => { setOffDraft({ ref: ctxMenu.ref, source: ctxMenu.source, title: ctxMenu.title, keys: (ctxMenu.keys || []).join(' '), content: ctxMenu.content }); setCtxMenu(null) } }, '✏️ 编辑'),
            h('button', { className: 'dsh-local-btn', style: { display: 'block', width: '100%', textAlign: 'left' }, onClick: async () => { setCtxMenu(null); await call('worldbook/entry', { action: 'toggle', entryId: ctxMenu.ref, source: ctxMenu.source }); load() } }, ctxMenu.enabled ? '⏸ 停用' : '▶ 启用')
          ), document.body) : null,
        // ── 页签：临时条目 ──
        tab === 'temporary' ? h('section', { className: 'dsh-local-section' },
          // ── v0.9.16 支线系统 ──
          h('div', { className: 'dsh-local-entry', style: { border: '1px solid #333', borderRadius: 8, padding: '8px 10px', marginBottom: 8 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('b', null, '支线系统'),
              branchInfo?.familyId ? h('span', { className: 'na-badge na-b-ctx' }, branchInfo.isRoot ? '主线（族根）' : '支线成员') : h('span', { className: 'dsh-local-help', style: { fontSize: 11 } }, '本会话还没有族谱'),
              h('button', { className: 'dsh-local-btn', disabled: branchBusy, onClick: () => { setBranchNameDraft(''); setBranchNameOpen(true) }, title: '完整复制当前会话为新支线（复用官方分叉链路，新 chatId/sessionId）；族内共享已知情报，各成员 LTM 以【支线】临时条目互相注入' }, branchBusy ? '创建中…' : '创建支线（复制本会话）'),
              branchInfo?.familyId ? h('button', {
                className: 'dsh-local-btn', disabled: branchBusy,
                title: '不等后台结算，立即把族内其他成员的 LTM 与已知情报同步为本会话的【支线】临时条目（去重，重复点安全）',
                onClick: async () => {
                  setBranchBusy(true)
                  try {
                    const r = await api('branch/sync', { sessionId: effectiveSid })
                    if (r.ok) { flashTip(r.synced > 0 ? '✓ 已同步 ' + r.synced + ' 条支线条目（变更数）' : '✓ 支线条目已是最新'); void load() }
                    else flashTip(r.error || '同步失败')
                  } catch (err) { flashTip('同步失败：' + String(err?.message || err)) }
                  finally { setBranchBusy(false) }
                }
              }, '立即导入支线条目') : null,
              branchInfo?.familyId && (branchInfo.members || []).length > 0 ? h('select', {
                className: 'dsh-local-input', style: { width: 200, fontSize: 12 }, value: mergePick, onChange: e => setMergePick(e.target.value),
                title: '把另一个族的全部成员与已知情报并入本族（源族文件删除，源族根变为本族支线）'
              },
                h('option', { value: '' }, '选择要并入本族的族…'),
                (families || []).filter(f => f.familyId !== branchInfo.familyId)
                  .map(f => h('option', { key: f.familyId, value: f.familyId }, familyOptionLabel(f)))
              ) : null,
              branchInfo?.familyId && (families || []).some(f => f.familyId !== branchInfo.familyId) ? h('button', {
                className: 'dsh-local-btn', disabled: branchBusy || !mergePick,
                title: '合并族：源族成员全部并入本族，known_facts 合并（只增不减），源族文件删除',
                onClick: () => mergeFamily(mergePick)
              }, '并入本族') : null
            ),
            // 无族会话：在本会话选择要加入的族（绑定支线关联，无需 fork 关系）
            !branchInfo?.familyId && (families || []).length > 0
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
                h('select', {
                  className: 'dsh-local-input', style: { width: 240, fontSize: 12 }, value: joinPick, onChange: e => setJoinPick(e.target.value),
                  title: '把本会话作为支线加入所选族（共享已知情报，LTM 互注；之后可解除关联）'
                },
                  h('option', { value: '' }, '选择要加入的族…'),
                  (families || []).map(f => h('option', { key: f.familyId, value: f.familyId }, familyOptionLabel(f)))
                ),
                h('button', { className: 'dsh-local-btn', disabled: branchBusy || !joinPick, onClick: () => joinFamily(joinPick) }, '加入所选族')
              )
              : null,
            branchInfo?.familyId && (branchInfo.members || []).length > 0
              ? h('div', { style: { margin: '6px 0 0' } },
                h('b', { style: { fontSize: 12, display: 'block', marginBottom: 2 } }, '族谱成员（已删除会话自动剔除）：'),
                ...branchInfo.members.map(m => h('div', { key: m.sessionId, style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '2px 0', fontSize: 12 } },
                  h('span', { className: 'na-badge ' + (m.isRoot ? 'na-b-out' : 'na-b-ctx') }, m.isRoot ? '主线' : '支线'),
                  editingSid === m.sessionId
                    ? h(React.Fragment, null,
                      h('input', { className: 'dsh-local-input', style: { width: 180, fontSize: 12 }, value: editingLabel, autoFocus: true, onChange: e => setEditingLabel(e.target.value), onKeyDown: e => { if (e.key === 'Enter') renameBranch(m.sessionId); if (e.key === 'Escape') setEditingSid(null) } }),
                      h('button', { className: 'dsh-local-btn', onClick: () => renameBranch(m.sessionId) }, '保存'),
                      h('button', { className: 'dsh-local-btn', onClick: () => setEditingSid(null) }, '取消')
                    )
                    : h(React.Fragment, null,
                      h('b', null, m.label || (m.isRoot ? '主线' : '支线')),
                      h('button', { className: 'dsh-local-btn', style: { fontSize: 11, padding: '1px 6px' }, title: '修改支线系统内部别名（不改会话名；各成员条目的别名标记会随后同步）', onClick: () => startRename(m) }, '改别名'),
                      h('span', { className: 'dsh-local-help', style: { fontSize: 11 } }, '会话名：' + memberTitle(m)),
                      !m.isRoot && m.registered ? h('button', {
                        className: 'dsh-local-btn', style: { fontSize: 11, padding: '1px 6px' },
                        title: '把该支线移出本族（保留其全部数据与本地情报快照，双向清理【支线】条目；可重新加入）',
                        onClick: () => unbindBranch(m)
                      }, '解除关联') : null
                    )
                )),
                h('p', { className: 'dsh-local-help', style: { margin: '4px 0 0', fontSize: 11.5 } },
                  '已知情报族内实时共享；各成员的 LTM 会以【支线】临时条目注入其他成员（根节点启用、非根自动停用，关键词含【<--别名-->】标记）；会话绑定随支线继承，临时条目不继承')
              )
              : null
          ),
          branchNameOpen ? h('div', {
            style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }
          },
            h('div', { className: 'dsh-local-section', style: { width: 360, maxWidth: '90vw', padding: 16 } },
              h('b', null, '创建支线会话'),
              h('p', { className: 'dsh-local-help', style: { margin: '4px 0 8px', fontSize: 12 } }, '输入支线别名（同时作为会话名）'),
              h('input', {
                className: 'dsh-local-input', style: { width: '100%', marginBottom: 10 }, autoFocus: true,
                placeholder: '如：异种族风俗娘线', value: branchNameDraft,
                onChange: e => setBranchNameDraft(e.target.value),
                onKeyDown: e => {
                  if (e.key === 'Enter') { const n = branchNameDraft.trim(); if (n) { setBranchNameOpen(false); createSideSession(n) } }
                  if (e.key === 'Escape') setBranchNameOpen(false)
                }
              }),
              h('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                h('button', { className: 'dsh-local-btn', onClick: () => setBranchNameOpen(false) }, '取消'),
                h('button', {
                  className: 'dsh-local-btn',
                  disabled: branchBusy || !branchNameDraft.trim(),
                  onClick: () => { const n = branchNameDraft.trim(); if (n) { setBranchNameOpen(false); createSideSession(n) } }
                }, branchBusy ? '创建中…' : '创建')
              )
            )
          ) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0 } }, '会话临时世界书条目 — ' + entries.length + ' 条'),
            h('button', {
              className: 'dsh-local-btn',
              disabled: importingFile,
              style: importingFile ? { opacity: .6, cursor: 'wait' } : {},
              title: '从本地 JSON 世界书文件导入条目到会话临时世界书（支持独立书 / 角色卡内嵌书双格式；与绑定不同，导入后完全自持；重复导入同一文件按原条目更新）',
              onClick: () => importFileRef.current && importFileRef.current.click()
            }, importingFile ? '导入中…' : '导入文件'),
            h('input', { type: 'file', accept: '.json,application/json', ref: importFileRef, style: { display: 'none' }, onChange: handleImportFile }),
            h('button', {
              className: 'dsh-local-btn',
              title: '把临时条目导出为 SillyTavern 世界书 JSON 文件（可导入 DSHT 独立世界书库或原版 ST）。受当前搜索词/标签筛选影响，只导出列表可见条目',
              onClick: () => {
                const n = exportTempWorldbook({ ...book, entries: visibleTemp }, effectiveSid)
                flashTip(n > 0 ? '✓ 已导出 ' + n + ' 条临时条目' + (visibleTemp.length < entries.length ? '（当前筛选 ' + visibleTemp.length + '/' + entries.length + '）' : '') : '没有可导出的条目')
              }
            }, '导出世界书'),
            h('button', {
              className: 'dsh-local-btn',
              title: '在上方展开新增条目表单',
              onClick: () => setDraft({})
            }, '新增条目'),
            h('button', {
              className: 'dsh-local-btn',
              title: '删除当前搜索词/标签筛选下的所有可见条目（无筛选时=全部条目，谨慎！）',
              onClick: async () => {
                if (!visibleTemp.length) { flashTip('当前筛选下没有可清空的条目'); return }
                const scope = visibleTemp.length < entries.length ? '当前筛选的 ' + visibleTemp.length + ' 条（共 ' + entries.length + ' 条）' : '全部 ' + entries.length + ' 条'
                if (!window.confirm('确定删除' + scope + '临时条目？此操作不可恢复（支线/锚点条目可在下次同步/结算时重新生成）。')) return
                try {
                  const r = await api('worldbook/entries-clear', { sessionId: effectiveSid, ids: visibleTemp.map(e => e.id) })
                  if (r.ok) { flashTip('✓ 已清空 ' + r.removed + ' 条临时条目'); void load() }
                  else flashTip(r.error || '清空失败')
                } catch (err) { flashTip('清空失败：' + String(err?.message || err)) }
              }
            }, '清空条目')
          ),
          // [v0.9.5] 新增/编辑改为弹层（ESC / 点遮罩关闭），不再占据页面流
          draft ? h(EditModal, {
            title: draft?.id ? '编辑条目：' + (draft.title || '(未命名)') : '新增条目',
            onClose: () => setDraft(null),
            footer: [
              h('button', { key: 'cancel', className: 'dsh-local-btn', onClick: () => setDraft(null) }, '取消'),
              h('button', { key: 'save', className: 'dsh-local-btn na-tab-active', onClick: async () => {
                if (!draft?.title && !draft?.content) return
                await call('worldbook/entry', {
                  sessionId: effectiveSid,
                  action: draft?.id ? 'update' : 'add',
                  entry: { id: draft?.id, title: draft.title || '', keys: (draft.keys || '').split(/[\s,，、]+/).filter(Boolean), content: draft.content || '', enabled: true, constant: draft?.constant === true }
                })
                setDraft(null)
              } }, draft?.id ? '保存修改' : '新增条目')
            ]
          },
            h('input', { key: 'title', className: 'dsh-local-input', style: { width: '100%', marginBottom: 6 }, placeholder: '标题', autoFocus: true, value: draft?.title || '', onChange: e => setDraft({ ...(draft || {}), title: e.target.value }) }),
            h('input', { key: 'keys', className: 'dsh-local-input', style: { width: '100%', marginBottom: 6 }, placeholder: '关键词（空格分隔；留空则只能靠强制注入直通，不会被自动召回）', value: draft?.keys || '', onChange: e => setDraft({ ...(draft || {}), keys: e.target.value }) }),
            h('textarea', { key: 'content', className: 'dsh-local-input', style: { width: '100%', minHeight: 120 }, placeholder: '条目正文', value: draft?.content || '', onChange: e => setDraft({ ...(draft || {}), content: e.target.value }) }),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 12, cursor: 'pointer' }, title: '常驻：每轮固定注入到稳定前缀之前，不参与关键词召回/冷却/LLM筛选' },
              h('input', { type: 'checkbox', checked: draft?.constant === true, onChange: e => setDraft({ ...(draft || {}), constant: e.target.checked }) }, null),
              '★ 常驻（每轮固定注入前缀，不进召回池）')
          ) : null,
          h('details', { className: 'dsh-local-help', style: { marginBottom: 6 } },
            h('summary', { style: { cursor: 'pointer' } }, '标签说明（点击展开）'),
            h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.75 } },
              h('li', null, '锚点：由叙事锚点自动流入的条目；人工：手动创建 / 编辑的条目；导入：从 DSHT 世界书复制到本会话的条目（完全自持，删除原书不影响）。'),
              h('li', null, '⚡强制注入：勾选后下一次回复强制进快照（豁免筛选，但守 10 轮冷却；冷却中强制注入也不绕过）。'),
              h('li', null, '✅在快照：已进入最近一轮动态世界书快照（审计推断）。'),
              h('li', null, '在上下文：出现在最新一轮真实模型请求文本中（含工具补查结果；在快照 ≠ 一定仍在上下文，压缩后旧快照会退出）。'),
              h('li', null, '⏳冷却中：最近注入过，正在 10 轮冷却，本轮不参与挑选（刚注入的条目从下一轮筛选起进入冷却）。'),
              h('li', null, '★常驻：每轮固定注入到稳定前缀之前，不参与关键词召回/冷却/LLM筛选，也不可被主动检索。'),
              h('li', null, '已停用：不参与召回与注入。')
            )
          ),
          renderToolbar('temporary'),
          entries.length === 0 ? h('p', { className: 'dsh-local-help' }, '暂无条目。点击「新增条目」创建，开启自动流入后由锚点数据生成，或在「会话世界书」页签从 DSHT 世界书导入（「导入到临时书」按钮）。') :
          h('div', null, countBar(visibleTemp.length, tempFiltered.length), visibleTemp.map((e) => h('div', { key: e.id, className: 'dsh-local-entry', style: { border: '1px solid #333', borderRadius: 6, padding: '6px 8px', marginBottom: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('input', { type: 'checkbox', checked: selectionSet.has('session-wb:' + e.id), title: '强制注入下一次回复（force 激活：过筛选 + 守冷却）', onChange: () => toggleSelection('session-wb:' + e.id) }),
              h('b', null, e.title || '(未命名)'),
              h('span', { className: 'na-badge ' + (e.source === 'anchor' ? 'na-b-out' : e.source === 'sideline' ? 'na-b-ctx' : e.source === 'import' ? 'na-b-ext' : 'na-b-ok'), title: e.source === 'import' ? '导入自：' + (e.importTitle || e.importFrom || '') : undefined }, e.source === 'anchor' ? '锚点' : e.source === 'sideline' ? '支线' : e.source === 'import' ? '导入' : '人工'),
              (e.constant === true ? h('span', { className: 'na-badge na-b-constant', title: '常驻：每轮固定注入到前缀，不参与关键词召回/冷却/筛选' }, '★常驻') : null),
              (e.enabled === false ? h('span', { className: 'na-badge na-b-off' }, '已停用') : null),
              (selectionSet.has('session-wb:' + e.id) ? h('span', { className: 'na-badge na-b-force' }, '⚡强制注入') : null),
              (isCooling('session-wb:' + e.id) ? h('span', { className: 'na-badge na-b-off', title: '最近注入过，10 轮冷却中；强制注入也不绕过' }, '⏳冷却中') : null),
              (e.inContext ? h('span', { className: 'na-badge na-b-in', title: '已进入最近一轮动态世界书快照（审计）' }, '✅在快照') : null),
              (ctxPresent.has('session-wb:' + e.id) ? h('span', { className: 'na-badge na-b-ctx', title: '出现在最新一轮模型请求上下文（含工具补查）' }, '📌在上下文') : null),
              (e.keys && e.keys.length ? predictHit(e.keys, predictSource) ? h('span', { className: 'na-badge na-b-pred', title: '预测：输入框文本 + 上一段 AI 输出命中关键词，提交后将被自动召回' }, '预测关键词命中') : null : null),
              h('button', {
                className: 'dsh-local-btn',
                title: '常驻：每轮固定注入到稳定前缀之前，不参与关键词召回/冷却/LLM筛选',
                style: e.constant === true ? { borderColor: 'var(--na-purple)', color: 'var(--na-purple)' } : {},
                onClick: () => call('worldbook/entry', { sessionId: effectiveSid, action: 'update', entry: { id: e.id, constant: !e.constant } }).then(() => load())
              }, e.constant === true ? '★常驻' : '☆常驻'),
              h('button', { className: 'dsh-local-btn', onClick: () => call('worldbook/entry', { sessionId: effectiveSid, action: 'toggle', entryId: e.id }) }, e.enabled === false ? '启用' : '停用'),
              e.source === 'sideline' ? null : h('button', { className: 'dsh-local-btn', onClick: () => setDraft({ ...e, keys: (e.keys || []).join(' ') }) }, '编辑'),
              h('button', { className: 'dsh-local-btn', onClick: () => call('worldbook/entry', { sessionId: effectiveSid, action: 'delete', entryId: e.id }) }, '删除')
            ),
            (e.keys && e.keys.length ? h('p', { className: 'dsh-local-help', style: { marginTop: 2 } }, '关键词: ' + e.keys.join('、') + ' ') : h('p', { className: 'dsh-local-help', style: { marginTop: 2 } }, '无关键词（只能靠强制注入直通，不会被自动召回） ')),
            h('p', { style: { margin: '2px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' } }, String(e.content || '').slice(0, 200) + (String(e.content || '').length > 200 ? '…' : ''))
          )))
        ) : null,

        // ── 页签：会话世界书 ──
        tab === 'sessionwb' ? h('section', { className: 'dsh-local-section' },
          h('details', { className: 'dsh-local-help', style: { marginBottom: 6 } },
            h('summary', { style: { cursor: 'pointer' } }, '这是什么？（点击展开）'),
            h('p', { style: { margin: '6px 0 2px', fontSize: 11.5 } }, '把世界书绑定到当前会话：角色卡内嵌世界书（角色卡）或独立世界书文件（独立）。绑定后其条目并入 DSHT 原生世界书召回（与临时条目同一合并点），参与关键词激活 / 常驻 / 10 轮冷却。'),
            h('p', { style: { margin: '2px 0', fontSize: 11.5 } }, '「导入到临时书」与绑定不同：把来源书的条目复制到会话临时世界书（source=导入），完全自持——删除原书不影响，可在「会话世界书条目」列表编辑/停用；重复导入同一本书按原条目更新（用户手动改过启用/常驻状态的不覆盖）。源书含常驻条目时导入会弹窗询问是否保持常驻（默认不常驻）。'),
            h('p', { style: { margin: '2px 0', fontSize: 11.5 } }, '「组合」是跨会话复用的绑定集合：先把常用世界书存成组合，之后在任何会话一键应用。'),
            h('p', { style: { margin: '2px 0', fontSize: 11.5 } }, '「全局自动绑定」：在下方可用列表点「设为全局」后，新会话/分支会话会自动绑定该世界书；某会话解绑仅解除该会话，全局清单不变。')
          ),
          h('details', { className: 'dsh-local-help', style: { marginBottom: 6 } },
            h('summary', { style: { cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--na-text)' } }, '会话世界书绑定 — ' + (data?.bound?.books?.length || 0) + ' 本 / ' + (data?.bound?.entryCount || 0) + ' 条并入'),
            h('div', null,
          h('b', { style: { display: 'block', margin: '2px 0 6px' } }, '已绑定：'),
          h('input', { className: 'dsh-local-input', style: { width: '100%', marginTop: 2 }, placeholder: '检索已绑定：名称 / 路径（本列表内过滤）', value: boundQ, onChange: e => setBoundQ(e.target.value) }),
          bindChips(boundT, setBoundT, [['embedded', '角色卡'], ['external', '独立'], ['global', '全局'], ['unavail', '不可用']], boundInv, setBoundInv),
          (!data?.bound?.books || data.bound.books.length === 0) ? h('p', { className: 'dsh-local-help' }, '尚未绑定任何世界书（含全局自动绑定）。从下方可用列表选择绑定，或应用一个组合。') :
          (() => {
            const q = String(boundQ || '').trim().toLocaleLowerCase()
            const all = data.bound.books
            const list = all.map((b, i) => ({ b, i })).filter(({ b }) => {
              const hay = ((b.name || '') + ' ' + (b.path || '') + ' ' + (b.cardPath || '')).toLocaleLowerCase()
              if (q && !hay.includes(q)) return false
              return matchTag(boundT, {
                embedded: b.kind === 'embedded', external: b.kind !== 'embedded',
                global: globalSet.has(JSON.stringify({ kind: b.kind, cardPath: b.cardPath, path: b.path })),
                unavail: b.available === false
              }, false, boundInv)
            })
            if (list.length === 0) return h('p', { className: 'dsh-local-help' }, '无匹配世界书。' + (q ? ' 换关键词试试。' : ''))
            return h('div', null,
              h('p', { style: { fontSize: 11, color: 'var(--na-dim)', margin: '4px 2px 2px' } }, '共 ' + all.length + ' 本' + (list.length !== all.length ? ' · 筛选 ' + list.length + ' 本' : '')),
              list.map(({ b, i }) => h('div', { key: i, className: 'dsh-local-entry', style: { border: '1px solid #333', borderRadius: 6, padding: '5px 8px', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('button', { className: 'dsh-local-btn', title: '解绑此世界书（全局自动绑定的世界书解绑后仅本会话解除，新会话仍自动绑定）', onClick: () => unbindBook(b) }, '解绑'),
                h('span', { className: 'na-badge ' + (b.kind === 'embedded' ? 'na-b-ok' : 'na-b-ext') }, b.kind === 'embedded' ? '角色卡' : '独立'),
                h('b', null, b.name || '(未命名)'),
                globalSet.has(JSON.stringify({ kind: b.kind, cardPath: b.cardPath, path: b.path })) ? h('span', { className: 'na-badge na-b-ok' }, '全局') : null,
                b.available === false
                  ? h('span', { className: 'na-badge na-b-off', title: b.error || '' }, '不可用')
                  : h('span', { className: 'na-badge na-b-in' }, b.entryCount + ' 条')
              )))
          })(),
          h('b', { style: { display: 'block', margin: '16px 0 6px', paddingTop: 10, borderTop: '1px solid #333' } }, '世界书组合：'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 } },
            h('input', { className: 'dsh-local-input', style: { flex: '1 1 140px', minWidth: 100 }, placeholder: '新组合名（先勾选下方世界书）', value: comboDraft.name || '', onChange: e => setComboDraft({ ...comboDraft, name: e.target.value }) }),
            h('button', { className: 'dsh-local-btn', onClick: () => saveCombo() }, '保存为组合')
          ),
          combos.length === 0 ? h('p', { className: 'dsh-local-help', style: { margin: '2px 0' } }, '暂无组合。勾选下方可用世界书 → 输入组合名 → 保存为组合。') :
          h('div', null,
            h('input', { className: 'dsh-local-input', style: { width: '100%', marginTop: 2 }, placeholder: '检索组合：名称 / 所含世界书（本列表内过滤）', value: comboQ, onChange: e => setComboQ(e.target.value) }),
            bindChips(comboT, setComboT, [['embedded', '含角色卡书'], ['external', '含独立书']], comboInv, setComboInv),
            (() => {
              const q = String(comboQ || '').trim().toLocaleLowerCase()
              const filtered = combos.filter(c => {
                const hay = ((c.name || '') + ' ' + (c.books || []).map(x => (x.kind === 'embedded' ? (x.cardPath || '') : (x.path || ''))).join(' ')).toLocaleLowerCase()
                if (q && !hay.includes(q)) return false
                return matchTag(comboT, {
                  embedded: (c.books || []).some(x => x.kind === 'embedded'),
                  external: (c.books || []).some(x => x.kind !== 'embedded')
                }, false, comboInv)
              })
              if (filtered.length === 0) return h('p', { className: 'dsh-local-help', style: { margin: '2px 0' } }, '无匹配组合。' + (q ? ' 换关键词试试。' : ''))
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                h('p', { style: { fontSize: 11, color: 'var(--na-dim)', margin: '0 2px' } }, '共 ' + combos.length + ' 个' + (filtered.length !== combos.length ? ' · 筛选 ' + filtered.length + ' 个' : '')),
                filtered.map(c => h('div', { key: c.id, className: 'dsh-local-entry', style: { border: '1px solid #333', borderRadius: 8, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('b', { style: { minWidth: 70 } }, c.name),
            h('span', { className: 'na-badge na-b-ext' }, c.books.length + ' 本'),
            h('details', { style: { flex: '1 1 200px', minWidth: 150 } },
              h('summary', { style: { cursor: 'pointer', fontSize: 11.5, color: 'var(--na-dim)' } }, '世界书列表（点击展开）'),
              h('div', { style: { marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 } },
                c.books.map((x, j) => h('div', { key: j, style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5 } },
                  h('span', { className: 'na-badge ' + (x.kind === 'embedded' ? 'na-b-ok' : 'na-b-ext') }, x.kind === 'embedded' ? '角色卡' : '独立'),
                  String(x.kind === 'embedded' ? (x.cardPath || '') : (x.path || '')).replace(/^.*(cards|worldbooks)[\\/]/, ''),
                  h('button', { className: 'dsh-local-btn', style: { padding: '0 6px', fontSize: 11 }, title: '从组合中移除这本世界书', onClick: () => removeComboBook(c.id, j) }, '移除')
                ))
              )
            ),
            h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
              h('button', { className: 'dsh-local-btn', title: '把当前勾选的世界书加入此组合（不去重冲突项）', onClick: () => addPickedToCombo(c.id) }, '＋ 加入世界书'),
              h('button', { className: 'dsh-local-btn', title: '把组合中的世界书并入当前绑定（不替换已有绑定）', onClick: () => applyCombo(c.id, 'merge') }, '＋ 添加'),
              h('button', { className: 'dsh-local-btn', title: '用组合替换当前全部绑定', onClick: () => applyCombo(c.id, 'replace') }, '应用'),
              h('button', { className: 'dsh-local-btn', title: '删除此组合', onClick: () => delCombo(c.id) }, '删除')
            )
          )))})()),
          h('b', { style: { display: 'block', margin: '16px 0 6px', paddingTop: 10, borderTop: '1px solid #333' } }, '可用世界书（勾选 → 绑定到本会话 / 存为组合）：'),
          h('p', { className: 'dsh-local-help', style: { margin: '2px 0' } }, '当前会话自动包含角色卡自带世界书；以下为可额外绑定的来源。'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4, position: 'relative' } },
            h('button', { className: 'dsh-local-btn', onClick: () => bindSelected() }, '绑定所选 → 本会话')
          ),
          h('div', { style: { marginTop: 4 } },
            libStandalone.length === 0 && libEmbedded.length === 0 ? h('p', { className: 'dsh-local-help' }, '暂无可绑定世界书（无独立世界书文件，且没有其它带世界书的角色卡）。') :
            (() => {
              const q = String(availQ || '').trim().toLocaleLowerCase()
              const all = libAll
              const list = all.filter(item => {
                const hay = ((item.name || '') + ' ' + (item.kind === 'embedded' ? (item.cardPath || '') : (item.path || ''))).toLocaleLowerCase()
                if (q && !hay.includes(q)) return false
                const key2 = JSON.stringify({ kind: item.kind, cardPath: item.cardPath, path: item.path })
                return matchTag(availT, {
                  embedded: item.kind === 'embedded', external: item.kind !== 'embedded',
                  bound: boundSet.has(key2), global: globalSet.has(key2)
                }, false, availInv)
              })
              if (list.length === 0) return h('p', { className: 'dsh-local-help' }, '无匹配世界书。' + (q ? ' 换关键词试试。' : ''))
              return h('div', null,
                h('input', { className: 'dsh-local-input', style: { width: '100%', marginTop: 2 }, placeholder: '检索可用世界书：名称 / 路径（本列表内过滤）', value: availQ, onChange: e => setAvailQ(e.target.value) }),
                bindChips(availT, setAvailT, [['embedded', '角色卡'], ['external', '独立'], ['bound', '已绑定'], ['global', '全局']], availInv, setAvailInv),
                h('p', { style: { fontSize: 11, color: 'var(--na-dim)', margin: '4px 2px 2px' } }, '共 ' + all.length + ' 本' + (list.length !== all.length ? ' · 筛选 ' + list.length + ' 本' : '')),
                list.map(item => {
              const key = JSON.stringify({ kind: item.kind, cardPath: item.cardPath, path: item.path })
              const picked = pickedBooks.has(key)
              const isBound = boundSet.has(key)
              const isGlobal = globalSet.has(key)
              return h('div', { key, className: 'dsh-local-entry', style: { border: '1px solid #333', borderRadius: 6, padding: '5px 8px', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('input', { type: 'checkbox', checked: picked, onChange: () => togglePick(key) }),
                h('span', { className: 'na-badge ' + (item.kind === 'embedded' ? 'na-b-ok' : 'na-b-ext') }, item.kind === 'embedded' ? '角色卡' : '独立'),
                h('b', null, item.name || '(未命名)'),
                h('span', { className: 'dsh-local-help', style: { fontSize: 11 } }, (item.kind === 'embedded' ? item.cardPath : item.path) + ' · ' + item.entryCount + ' 条' + ((Number(item.constantCount) || 0) > 0 ? ' · ' + item.constantCount + ' 条常驻' : '')),
                isBound ? h('span', { className: 'na-badge na-b-in' }, '已绑定') : null,
                isGlobal ? h('span', { className: 'na-badge na-b-ok', title: '全局自动绑定：新会话/分支会话自动跟随' }, '全局') : null,
                h('button', {
                  className: 'dsh-local-btn',
                  disabled: importingKey !== '',
                  style: importingKey === key ? { opacity: .6, cursor: 'wait' } : {},
                  title: '把这本书的全部启用条目复制导入到会话临时世界书（与绑定不同：导入后完全自持，删除原书不影响；重复导入按原条目更新）。含常驻条目的书会弹窗询问是否保持常驻（默认不常驻）',
                  onClick: async () => {
                    if (importingKey !== '') return
                    // 源书含常驻条目 → 弹窗询问是否保持常驻（默认不常驻）
                    const nConst = Number(item.constantCount) || 0
                    const keep = nConst > 0 ? window.confirm('「' + (item.name || '') + '」含 ' + nConst + ' 条常驻条目。\n\n是否保持常驻？\n（确定 = 保持常驻；取消 = 导入为普通条目，不常驻）') : false
                    setImportingKey(key)
                    try {
                      const r = await api('worldbook/import', { sessionId: effectiveSid, source: { kind: item.kind, ...(item.kind === 'embedded' ? { cardPath: item.cardPath } : { path: item.path }) }, constantMode: keep ? 'preserve' : 'strip' })
                      if (r.ok) flashTip('✓ 已导入「' + (r.name || '') + '」：新增 ' + r.imported + ' 条，更新 ' + r.updated + ' 条' + (r.skipped > 0 ? '，跳过 ' + r.skipped + ' 条' : '') + (nConst > 0 ? (keep ? '，常驻已保留' : '，常驻已取消') : '') + '（见「会话世界书条目」列表）')
                      else flashTip(r.error || '导入失败')
                      void load()
                    } catch (err) { flashTip('导入失败：' + String(err?.message || err)) }
                    finally { setImportingKey('') }
                  }
                }, importingKey === key ? '导入中…' : '导入到临时书'),
                h('button', {
                  className: 'dsh-local-btn',
                  title: isGlobal ? '取消全局自动绑定' : '设为全局自动绑定：之后的新会话/分支会话自动绑定此世界书',
                  onClick: () => toggleGlobalBind(item)
                }, isGlobal ? '取消全局' : '设为全局')
              )
            }))
            })()
          )
          )),
        ) : null,

        // ── Persona（v0.9.30：玩家角色档案库，原 mask 重构为 constant 条目）──
        tab === 'persona' ? h('section', { className: 'dsh-local-section' },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 } },
            h('h3', { style: { margin: 0 } }, '人格面具 — 玩家角色档案'),
            h('span', { style: { fontSize: 12, color: 'var(--na-dim)' } },
              '当前玩家称呼：' + (personaStore.userName || '你') + ' · 当前面具：' +
              ((personaStore.personas || []).find(m => m.id === personaStore.personaId)?.name || '无'))
          ),
          h('div', { style: { fontSize: 11.5, color: 'var(--na-dim)', marginBottom: 8, lineHeight: 1.5 } },
            '应用 = ① 修改本局玩家称呼（{{user}}）；② 人设描述写入会话世界书常驻条目（由常驻注入管道统一注入固定前缀）。切换/取消时自动删除旧条目。「生成人工条目」另建非常驻条目（同标题，按标题对应，互不联动、按召回键判断是否注入）。'),
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
            h('button', { className: 'dsh-local-btn', onClick: () => setPersonaDraft({ name: '', description: '', note: '', keywords: '' }) }, '＋ 新建档案'),
            personaStore.personaId ? h('button', { className: 'dsh-local-btn', onClick: () => personaUnapply() }, '取消应用') : null
          ),
          (personaStore.personas || []).length > 0 ? h('input', {
            value: personaQuery, placeholder: '搜索：称呼 / 描述 / 备注…',
            onChange: e => setPersonaQuery(e.target.value),
            style: { width: '100%', boxSizing: 'border-box', marginBottom: 6, fontSize: 12 }
          }) : null,
          personaDraft ? h('div', { style: { border: '1px solid var(--na-border, #444)', borderRadius: 6, padding: 8, marginBottom: 8, display: 'grid', gap: 6 } },
            h('div', null,
              h('label', { style: { fontSize: 12 } }, '称呼（≤80 字，作为 {{user}} 玩家名）'),
              h('input', { value: personaDraft.name || '', maxLength: 80, placeholder: '玩家称呼', onChange: e => setPersonaDraft(d => ({ ...d, name: e.target.value })), style: { width: '100%', boxSizing: 'border-box' } })),
            h('div', null,
              h('label', { style: { fontSize: 12 } }, '人设描述（不限长；常驻注入）'),
              h('textarea', { value: personaDraft.description || '', rows: 6, placeholder: '玩家的身份、外貌、性格、背景等长段设定……', onChange: e => setPersonaDraft(d => ({ ...d, description: e.target.value })), style: { width: '100%', boxSizing: 'border-box', resize: 'vertical' } })),
            h('div', null,
              h('label', { style: { fontSize: 12 } }, '关键词（逗号分隔，中英文逗号均可；命中才召回。应用时自动追加 玩家、用户 + 角色名）'),
              h('input', { value: Array.isArray(personaDraft.keywords) ? (personaDraft.keywords || []).join('，') : (personaDraft.keywords || ''), placeholder: '例：剑修，掌门，江湖人', onChange: e => setPersonaDraft(d => ({ ...d, keywords: e.target.value })), style: { width: '100%', boxSizing: 'border-box' } })),
            h('div', null,
              h('label', { style: { fontSize: 12 } }, '备注（仅此处显示，不注入）'),
              h('input', { value: personaDraft.note || '', placeholder: '可选', onChange: e => setPersonaDraft(d => ({ ...d, note: e.target.value })), style: { width: '100%', boxSizing: 'border-box' } })),
            h('div', { style: { display: 'flex', gap: 6 } },
              h('button', { className: 'dsh-local-btn na-tab-active', onClick: () => personaSave() }, '保存'),
              h('button', { className: 'dsh-local-btn', onClick: () => setPersonaDraft(null) }, '取消'))
          ) : null,
          (() => {
            const all = personaStore.personas || []
            const pq = String(personaQuery || '').trim().toLocaleLowerCase()
            const list = pq
              ? all.filter(m => ((m.name || '') + ' ' + (m.description || '') + ' ' + (m.note || '')).toLocaleLowerCase().includes(pq))
              : all
            if (all.length === 0) return h('div', { style: { fontSize: 12, color: 'var(--na-dim)', padding: '6px 0' } }, '暂无档案。新建后一键应用称呼 + 人设描述。')
            if (list.length === 0) return h('div', { style: { fontSize: 12, color: 'var(--na-dim)', padding: '6px 0' } }, '无匹配档案。')
            return list.map(m => {
              const applied = m.id === personaStore.personaId
              const hasManual = (personaStore.manualIds || []).includes(m.id)
              const preview = String(m.description || '').replace(/\s+/g, ' ').slice(0, 60)
              return h('div', { key: m.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 6px', borderBottom: '1px solid var(--na-border, #333)' } },
                h('div', { style: { flex: 1, minWidth: 0, cursor: 'pointer' }, title: m.description || '', onClick: () => setPersonaDraft({ id: m.id, name: m.name, description: m.description || '', note: m.note || '', keywords: (m.keywords || []).join('，') }) },
                  h('div', { style: { fontSize: 12.5, fontWeight: applied ? 600 : 400 } },
                    m.name + (applied ? '  ✓当前' : '') + (hasManual ? '  ·人工条目✓' : '')),
                  preview ? h('div', { style: { fontSize: 11, color: 'var(--na-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview) : null,
                  (m.keywords || []).length ? h('div', { style: { fontSize: 11, color: 'var(--na-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '关键词：' + m.keywords.join('，')) : null,
                  m.note ? h('div', { style: { fontSize: 11, color: 'var(--na-accent, #8ab4f8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '备注：' + m.note) : null),
                h('button', { className: applied ? 'dsh-local-btn' : 'dsh-local-btn na-tab-active', disabled: applied, style: { flexShrink: 0 }, onClick: () => personaApply(m.id), title: applied ? '当前会话已应用' : '修改本局玩家称呼并写入人设常驻条目' }, '应用'),
                h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => personaGenEntry(m.id), title: '在会话世界书生成非常驻条目（同标题对应，不联动修改、不删除，按召回键判断是否注入）' }, '生成人工条目'),
                h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => setPersonaDraft({ id: m.id, name: m.name, description: m.description || '', note: m.note || '', keywords: (m.keywords || []).join('，') }) }, '编辑'),
                h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => { if (confirm('删除档案「' + m.name + '」？')) void personaDelete(m.id) } }, '删除'))
            })
          })()
        ) : null,

        // ── 会话世界书条目列表（v0.7.19b：绑定世界书条目，像官方世界书列表）──
        (() => {
          if (tab !== 'sessionwb') return null
          const boundBooks = data?.bound?.books || []
          const be = (data?.bound?.entries || []).map(e => {
            const bk = boundBooks[e.boundWorldbookIndex] || {}
            return { ...e, sourceBook: bk.name || '', sourceBookPath: bk.path || bk.cardPath || '' }
          })
          const sq = String(sbQuery || '').trim().toLocaleLowerCase()
          const sbFiltered = be.filter(e => {
            if (sbBookFilter && String(e.boundWorldbookIndex) !== sbBookFilter) return false
            const hay = (e.title || '') + ' ' + (e.keys || []).join(' ') + ' ' + String(e.content || '')
            if (sq && !hay.toLocaleLowerCase().includes(sq)) return false
            return matchTag(sbFilterTags, {
              inctx: ctxPresent.has(e.ref),
              constant: e.constant === true,
              forced: selectionSet.has(e.ref) || forcedSet.has(e.ref),
              pred: predictHit(e.keys, predictSource),
              disabled: e.enabled === false
            }, sbIntersect, sbInvert)
          })
          return h('section', { className: 'dsh-local-section' },
            h('h3', null, '会话世界书条目 — ' + be.length + ' 条'),
            h('details', { className: 'dsh-local-help', style: { marginBottom: 6 } },
              h('summary', { style: { cursor: 'pointer' } }, '标签说明（点击展开）'),
              h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 11.5, lineHeight: 1.75 } },
                h('li', null, '📌在上下文：出现在最新一轮真实模型请求文本（含工具补查）。'),
                h('li', null, '常驻：每轮固定注入（不看关键词）。'),
                h('li', null, '⚡强制注入：勾选后下一次回复跳过筛选直接进快照（守 10 轮冷却）；上一轮实际强制注入的也在此标记。'),
                h('li', null, '预测关键词命中：输入框文本 + 上一段 AI 输出命中关键词，提交后将被自动召回。'),
                h('li', null, '停用：不参与召回与注入。')
              )
            ),
            h('input', { className: 'dsh-local-input', style: { width: '100%', marginTop: 6 }, placeholder: '检索：标题 / 关键词 / 正文（本列表内过滤）', value: sbQuery, onChange: e => setSbQuery(e.target.value) }),
            h('div', { style: { marginTop: 7, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { className: sbFilterTags.size === 0 ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', style: { padding: '2px 9px', fontSize: 11.5 }, title: '清空所有标签筛选', onClick: () => setSbFilterTags(new Set()) }, '全部'),
              [['inctx', '📌在上下文'], ['constant', '常驻'], ['forced', '⚡强制注入'], ['pred', '预测关键词命中'], ['disabled', '停用']].map(([v, label]) => {
                const active = sbFilterTags.has(v)
                return h('button', { key: v, className: active ? 'dsh-local-btn na-tab-active' : 'dsh-local-btn', style: { padding: '2px 9px', fontSize: 11.5 }, title: '互斥筛选：点选只看此类，点激活项取消', onClick: () => setSbFilterTags(active ? new Set() : new Set([v])) }, label)
              }),
              h('select', { className: 'dsh-local-input', style: { minHeight: 26, fontSize: 11.5, width: 'auto', marginLeft: 4 }, title: '按来源世界书筛选', value: sbBookFilter || '', onChange: e => setSbBookFilter(e.target.value) },
                h('option', { value: '' }, '按世界书: 全部'),
                boundBooks.map((b, i) => h('option', { key: i, value: String(i) }, '按世界书: ' + (b.name || b.path || b.cardPath || ('#' + i))))
              ),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color: 'var(--na-dim)', whiteSpace: 'nowrap', cursor: 'pointer', marginLeft: 2 }, title: '勾选后多个标签需同时满足（AND）；不勾选为任一满足（OR）' },
                h('input', { type: 'checkbox', checked: sbIntersect, onChange: e => setSbIntersect(e.target.checked), style: { width: 13, height: 13, cursor: 'pointer', margin: 0 } }), '交集'),
              h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, color: 'var(--na-dim)', whiteSpace: 'nowrap', cursor: 'pointer', marginLeft: 2 }, title: '勾选后显示不符合所选标签的条目（反选）' },
                h('input', { type: 'checkbox', checked: sbInvert, onChange: e => setSbInvert(e.target.checked), style: { width: 13, height: 13, cursor: 'pointer', margin: 0 } }), '反选')
            ),
            sbFiltered.length === 0 ? h('p', { className: 'dsh-local-help' }, '无匹配条目。' + (sbQuery ? ' 换关键词试试。' : '')) :
            h('div', null, h('p', { style: { fontSize: 11, color: 'var(--na-dim)', margin: '6px 2px 4px', whiteSpace: 'nowrap' } }, '共 ' + be.length + ' 条' + (sbFiltered.length !== be.length ? ' · 筛选 ' + sbFiltered.length + ' 条' : '')), sbFiltered.map((e, i) => h('div', { key: e.ref || i, className: 'dsh-local-entry', 'data-ref': e.ref, style: { border: '1px solid #333', borderRadius: 6, padding: '6px 8px', marginBottom: 6 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('input', { type: 'checkbox', checked: selectionSet.has(e.ref), title: '强制注入下一次回复（force 激活：过筛选 + 守冷却）', onChange: () => toggleSelection(e.ref) }),
                (selectionSet.has(e.ref) ? h('span', { className: 'na-badge na-b-force' }, '⚡强制注入') : null),
                h('b', null, e.title || e.ref),
                (e.sourceBook ? h('span', { className: 'na-badge na-b-' + (e.boundWorldbookIndex % 2 ? 'out' : 'const'), title: e.sourceBookPath || '' }, e.sourceBook) : null),
                (e.enabled === false ? h('span', { className: 'na-badge na-b-off' }, '停用') : null),
                (e.constant ? h('span', { className: 'na-badge na-b-constant' }, '常驻') : null),
                (ctxPresent.has(e.ref) ? h('span', { className: 'na-badge na-b-ctx', title: '出现在最新一轮模型请求上下文（含工具补查）' }, '📌在上下文') : null),
                (e.keys && e.keys.length && predictHit(e.keys, predictSource) ? h('span', { className: 'na-badge na-b-pred', title: '预测：输入框文本 + 上一段 AI 输出命中关键词，提交后将被自动召回' }, '预测关键词命中') : null)
              ),
              (e.keys && e.keys.length ? h('p', { className: 'dsh-local-help', style: { marginTop: 2 } }, '关键词: ' + e.keys.join('、') + ' ') : h('p', { className: 'dsh-local-help', style: { marginTop: 2 } }, '无关键词（只能靠强制注入直通，不会被自动召回） ')),
              (() => {
                const body = String(e.content || '')
                const open = expandedRefs.has(e.ref)
                const shown = open ? body : body.slice(0, 160)
                return h('div', null,
                  body ? h('p', { style: { margin: '2px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' } }, shown + (body.length > 160 && !open ? '…' : '') + (body.length > 160 ? ' ' : '')) : h('p', { className: 'dsh-local-help', style: { margin: '2px 0 0' } }, '（条目无正文）'),
                  body.length > 160 ? h('button', { className: 'dsh-local-btn', style: { marginTop: 2 }, onClick: () => { const s2 = new Set(expandedRefs); if (open) s2.delete(e.ref); else s2.add(e.ref); setExpandedRefs(s2) } }, open ? '收起' : '展开全文') : null
                )
              })()
            ))))
        })(),

        error ? h('p', { className: 'dsh-local-warning' }, error) : null,
        !loaded ? h('p', { className: 'dsh-local-help' }, '加载中…') : null,
        h('p', { className: 'dsh-local-help', style: { marginTop: 8, fontSize: 11, opacity: 0.7 } }, '会话: ' + (effectiveSid || '(未绑定)') + (currentChatId ? ' (uiConversation)' : ' (scope)') + (data?.official?.card?.name ? ' · 卡: ' + data.official.card.name : '') + (uiErr ? ' · ' + uiErr : ''))
      )
    )
  }

  // ========== v0.9.37 快捷输入模板 ==========
  // v0.9.38：改用 DSH 原生草稿 API（与官方 appendMention 同一路径）：
  //   conversation.input.for(sessions.scope(sessionId)).setDraft(...)
  // DOM 定位 + execCommand 仅作原生 API 抛错时的兜底。
  function findChatComposer() {
    const nodes = document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')
    let best = null
    for (const el of nodes) {
      if (el.closest('.na-page')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 120 || r.height < 24) continue
      if (!best || r.width * r.height > best.getBoundingClientRect().width * best.getBoundingClientRect().height) best = el
    }
    return best
  }
  function insertToComposer(sessionId, text) {
    if (sessionId) {
      try {
        const conversation = ctx.get('conversation')
        const actx = ctx.sessions.scope(sessionId)
        if (conversation && actx) {
          const input = conversation.input.for(actx)
          const draft = String(input.state.getSnapshot().draft || '')
          const joined = draft ? draft.replace(/\s*$/, '') + '\n' + text : text
          input.setDraft(joined)
          return true
        }
      } catch { /* 原生 API 不可用 → 走 DOM 兜底 */ }
    }
    const el = findChatComposer()
    if (!el) return false
    const existing = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : (el.textContent || '')
    const joined = existing ? existing.replace(/\s*$/, '') + '\n' + text : text
    el.focus()
    try {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        // 全选后整体替换，保证 React 状态与新值一致
        el.setSelectionRange(0, el.value.length)
        if (!document.execCommand('insertText', false, joined)) throw new Error('execCommand failed')
      } else {
        document.execCommand('insertText', false, joined)
      }
    } catch {
      try {
        const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, joined)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } catch { return false }
    }
    el.focus()
    return true
  }

  function QuickInputsTab(props) {
    const sessionId = props?.sessionId || props?.scope?.sessionId
    const [items, setItems] = React.useState([])
    const [draft, setDraft] = React.useState(null) // { id?, name, content }
    const [tip, setTip] = React.useState('')
    const flashTip = msg => { setTip(msg); setTimeout(() => setTip(''), 2500) }
    const load = async () => {
      try { const r = await api('quickinput/list', {}); if (r.ok) setItems(r.items || []) } catch { /* 静默 */ }
    }
    React.useEffect(() => { void load() }, [])
    const save = async () => {
      const d = draft
      if (!d || !String(d.name || '').trim()) { flashTip('✗ 模板名称不能为空'); return }
      try {
        const r = await api('quickinput/save', { id: d.id, name: d.name, content: d.content || '' })
        if (r.ok) { setDraft(null); flashTip('✓ 模板已保存'); await load() } else flashTip('✗ ' + (r.error || '保存失败'))
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
    }
    const del = async id => {
      try {
        const r = await api('quickinput/delete', { id })
        if (r.ok) { flashTip('已删除模板'); await load() } else flashTip('✗ 删除失败')
      } catch (e) { flashTip('✗ ' + String(e.message || e)) }
    }
    const insert = async item => {
      if (!String(item.content || '').trim()) { flashTip('✗ 模板内容为空'); return }
      if (insertToComposer(sessionId, item.content)) { flashTip('✓ 已插入聊天输入框'); return }
      try { await navigator.clipboard.writeText(item.content); flashTip('未找到输入框，模板内容已复制到剪贴板') }
      catch { flashTip('✗ 未找到输入框，且复制失败——请打开聊天界面后重试') }
    }
    const copy = async item => {
      try { await navigator.clipboard.writeText(item.content || ''); flashTip('✓ 已复制') }
      catch { flashTip('✗ 复制失败') }
    }
    return h('section', { className: 'dsh-local-section' },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 } },
        h('h3', { style: { margin: 0 } }, '快捷输入模板'),
        h('span', { style: { fontSize: 12, color: 'var(--na-dim)' } }, (items.length) + ' 个模板')),
      h('div', { style: { fontSize: 11.5, color: 'var(--na-dim)', marginBottom: 8, lineHeight: 1.5 } },
        '点击「插入」把模板内容追加进聊天输入框（不自动发送）；找不到输入框时自动复制到剪贴板。模板全局共享。'),
      h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
        h('button', { className: 'dsh-local-btn', onClick: () => setDraft({ name: '', content: '' }) }, '＋ 新建模板')),
      tip ? h('div', { style: { fontSize: 12, color: 'var(--na-accent, #8ab4f8)', marginBottom: 6 } }, tip) : null,
      draft ? h('div', { style: { border: '1px solid var(--na-border, #444)', borderRadius: 6, padding: 8, marginBottom: 8, display: 'grid', gap: 6 } },
        h('div', null,
          h('label', { style: { fontSize: 12 } }, '模板名称（≤80 字）'),
          h('input', { value: draft.name || '', maxLength: 80, placeholder: '例：日常 OOC 提问', onChange: e => setDraft(d => ({ ...d, name: e.target.value })), style: { width: '100%', boxSizing: 'border-box' } })),
        h('div', null,
          h('label', { style: { fontSize: 12 } }, '模板内容（多行，插入时原样追加到输入框）'),
          h('textarea', { value: draft.content || '', rows: 6, placeholder: '（OOC：……）', onChange: e => setDraft(d => ({ ...d, content: e.target.value })), style: { width: '100%', boxSizing: 'border-box', resize: 'vertical' } })),
        h('div', { style: { display: 'flex', gap: 6 } },
          h('button', { className: 'dsh-local-btn na-tab-active', onClick: () => void save() }, '保存'),
          h('button', { className: 'dsh-local-btn', onClick: () => setDraft(null) }, '取消'))
      ) : null,
      items.length === 0
        ? h('div', { style: { fontSize: 12, color: 'var(--na-dim)', padding: '6px 0' } }, '暂无模板。新建后可一键插入聊天输入框。')
        : items.map(t => {
            const preview = String(t.content || '').replace(/\s+/g, ' ').trim().slice(0, 60)
            return h('div', { key: t.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '5px 6px', borderBottom: '1px solid var(--na-border, #333)' } },
              h('div', { style: { flex: 1, minWidth: 0, cursor: 'pointer' }, title: t.content || '', onClick: () => setDraft({ id: t.id, name: t.name, content: t.content || '' }) },
                h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, t.name),
                preview ? h('div', { style: { fontSize: 11, color: 'var(--na-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, preview) : null),
              h('button', { className: 'dsh-local-btn na-tab-active', style: { flexShrink: 0 }, onClick: () => void insert(t), title: '把模板内容追加进聊天输入框（不自动发送）' }, '插入'),
              h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => void copy(t), title: '复制模板内容到剪贴板' }, '复制'),
              h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => setDraft({ id: t.id, name: t.name, content: t.content || '' }) }, '编辑'),
              h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => { if (confirm('删除模板「' + t.name + '」？')) void del(t.id) } }, '删除'))
          })
    )
  }

  // ========== v2.3 结算请求体查看（2026-10-09）==========
  // 数据源：后端挂 llm/stream 捕获的 na-background-* 完整请求体（messages/system/tools），
  // 经 /api/narrative-anchor/requestLog 查询。只展示，不改动。
  const MAX_TEXT = 400
  const ROLE_COLORS = { system: '#c586c0', user: '#6a9955', assistant: '#569cd6', tool: '#ce9178' }

  // 单条消息的可读渲染：角色徽标 + 内容分块（text/thinking/tool_use/tool_result），长文本可展开
  function MessageBlock({ m }) {
    const [full, setFull] = React.useState(false)
    const role = m.role || '?'
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : [])
    const textOf = b => {
      if (b == null) return ''
      if (typeof b === 'string') return b
      if (typeof b.text === 'string') return b.text
      if (typeof b.content === 'string') return b.content
      if (typeof b.thinking === 'string') return b.thinking
      try { return JSON.stringify(b) } catch { return String(b) }
    }
    const body = parts.map((b, i) => {
      const t = textOf(b)
      if (b && (b.type === 'thinking' || b.type === 'reasoning')) {
        return h('div', { key: i, style: { fontSize: 11, color: '#9cdcfe', background: 'rgba(156,220,254,0.06)', borderRadius: 4, padding: '4px 6px', margin: '2px 0' } },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '[thinking]'),
          h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, maxHeight: 120, overflowY: 'auto', userSelect: 'text' } }, t || '（空）'))
      }
      if (b && b.type === 'tool_use') {
        return h('div', { key: i, style: { fontSize: 11, color: '#ce9178', background: 'rgba(206,145,120,0.06)', borderRadius: 4, padding: '4px 6px', margin: '2px 0' } },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '工具调用：' + (b.name || '?')),
          h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, maxHeight: 160, overflowY: 'auto', userSelect: 'text' } }, JSON.stringify(b.input ?? {}, null, 2)))
      }
      if (b && b.type === 'tool_result') {
        return h('div', { key: i, style: { fontSize: 11, color: '#d7ba7d', background: 'rgba(215,186,125,0.06)', borderRadius: 4, padding: '4px 6px', margin: '2px 0' } },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '工具结果'),
          h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, maxHeight: 160, overflowY: 'auto', userSelect: 'text' } }, t || '（空）'))
      }
      // text / 默认块
      const show = full ? t : t.slice(0, MAX_TEXT)
      const more = t.length > MAX_TEXT
      return h('div', { key: i },
        h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, lineHeight: 1.5, userSelect: 'text' } }, show || '（空）'),
        more ? h('button', { className: 'dsh-local-btn', style: { marginTop: 2 }, onClick: () => setFull(f => !f) }, full ? '收起' : ('展开全文（' + t.length + ' 字符）')) : null)
    })
    return h('div', { style: { border: '1px solid var(--na-border, #333)', borderRadius: 4, padding: '5px 7px' } },
      h('div', { style: { fontSize: 11, fontWeight: 700, color: ROLE_COLORS[role] || '#ccc', marginBottom: 2, textTransform: 'uppercase' } }, role + (m.name ? ' · ' + m.name : '')),
      body.length ? body : h('div', { style: { fontSize: 11, color: 'var(--na-dim)' } }, '（空消息）'))
  }

  function RequestLogTab(props) {
    const [entries, setEntries] = React.useState([])
    const [loaded, setLoaded] = React.useState(false)
    const [error, setError] = React.useState('')
    const [expanded, setExpanded] = React.useState(new Set())
    const [jsonView, setJsonView] = React.useState(new Set())
    const [autoRefresh, setAutoRefresh] = React.useState(false)

    async function load() {
      try {
        const result = await api('requestLog', { limit: 30 })
        if (result.ok) {
          setEntries(result.entries || [])
          setLoaded(true)
        } else {
          setError(result.error || '加载失败')
        }
      } catch (err) { setError(String(err.message || err)) }
    }

    React.useEffect(() => {
      void load()
      if (!autoRefresh) return
      const t = setInterval(() => void load(), 5000)
      return () => clearInterval(t)
    }, [autoRefresh])

    const fmt = ts => {
      try {
        const d = new Date(ts)
        return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + d.toLocaleTimeString('zh-CN', { hour12: false })
      } catch { return String(ts) }
    }
    const previewOf = e => {
      try {
        const arr = Array.isArray(e.messages) ? e.messages : []
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr[i]
          const text = Array.isArray(m.content) ? m.content.map(b => b?.text || '').join('') : (typeof m.content === 'string' ? m.content : '')
          if (text && (m.role === 'user' || m.role === 'assistant')) return text.replace(/\s+/g, ' ').trim()
        }
      } catch { /* ignore */ }
      return ''
    }

    // 按请求类型分组：body（前台正文）/ settlement（后台结算）/ compaction（压缩请求）/ candidate（候选生成）/ other
    const KIND_ORDER = ['compaction', 'settlement', 'body', 'candidate', 'other']
    const KIND_LABEL = { compaction: '压缩请求', settlement: '后台结算', body: '前台正文', candidate: '候选生成', other: '其他' }
    const byKind = new Map()
    for (const e of entries) {
      const k = (e && e.kind) || 'other'
      if (!byKind.has(k)) byKind.set(k, [])
      byKind.get(k).push(e)
    }
    const groups = KIND_ORDER.filter(k => byKind.has(k)).map(k => ({ kind: k, label: KIND_LABEL[k] || k, list: byKind.get(k) }))

    return h('section', { className: 'dsh-local-section', style: { display: 'flex', flexDirection: 'column', height: '100%', maxHeight: '100%', minHeight: 0, overflow: 'hidden' } },
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', marginBottom: 6 } },
        h('h3', { style: { margin: 0 } }, '请求体日志'),
        h('span', { style: { fontSize: 12, color: 'var(--na-dim)' } }, (entries.length) + ' 条 · ' + groups.length + ' 个分组'),
        h('label', { style: { fontSize: 11.5, color: 'var(--na-dim)', display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6 } },
          h('input', { type: 'checkbox', checked: autoRefresh, onChange: e => setAutoRefresh(e.target.checked) }), '自动刷新')),
      h('div', { style: { fontSize: 11.5, color: 'var(--na-dim)', marginBottom: 8, lineHeight: 1.5 } },
        '所有发送给模型的 LLM 请求完整请求体（前台正文、后台结算、压缩、候选生成；含本插件注入的快照；系统提示、全量上下文 messages、工具定义）。按请求类型分组；被拦截的后台压缩请求在条目上标记「已拦截」（provider 投毒，未到达模型）。'),
      h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
        h('button', { className: 'dsh-local-btn', onClick: () => void load() }, '刷新')),
      error ? h('div', { style: { fontSize: 12, color: '#e06c75', marginBottom: 6 } }, error) : null,
      !loaded ? h('div', { style: { fontSize: 12, color: 'var(--na-dim)', padding: '6px 0' } }, '加载中…') :
      entries.length === 0 ? h('div', { style: { fontSize: 12, color: 'var(--na-dim)', padding: '6px 0' } },
        '暂无请求记录。跑一轮游戏（正文或后台结算）后自动出现。') :
      h('div', { style: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', paddingRight: 4 } }, groups.map(g => {
        const badge = g.kind === 'settlement'
          ? { background: 'rgba(86,156,214,0.15)', color: '#75b0e8', border: '1px solid rgba(86,156,214,0.35)' }
          : g.kind === 'compaction'
            ? { background: 'rgba(86,182,150,0.15)', color: '#7fc9ac', border: '1px solid rgba(86,182,150,0.4)' }
            : g.kind === 'candidate'
              ? { background: 'rgba(197,134,192,0.15)', color: '#c586c0', border: '1px solid rgba(197,134,192,0.35)' }
              : { background: 'rgba(106,153,85,0.15)', color: '#8bb77a', border: '1px solid rgba(106,153,85,0.35)' }
        return h('div', { key: g.kind, style: { border: '1px solid var(--na-border, #444)', borderRadius: 8, marginBottom: 10, overflow: 'hidden' } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid var(--na-border, #333)' } },
            h('span', { style: { fontSize: 11, fontWeight: 700, borderRadius: 3, padding: '1px 7px', ...badge } }, g.label),
            h('span', { style: { fontSize: 11, color: 'var(--na-dim)', marginLeft: 'auto', flexShrink: 0 } }, g.list.length + ' 条')),
          g.list.map((e, i) => {
            const key = g.kind + ':' + i
            const open = expanded.has(key)
            const sid = String(e.sessionId || '')
            return h('div', { key, style: { border: '1px solid var(--na-border, #444)', borderRadius: 6, margin: '5px 7px', overflow: 'hidden' } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', cursor: 'pointer', background: open ? 'rgba(255,255,255,0.04)' : 'transparent' }, onClick: () => setExpanded(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n }) },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 } },
                    h('span', null, (e.model || '?') + (e.provider ? ' · ' + e.provider : '')),
                    e.blocked ? h('span', { style: { fontSize: 10, fontWeight: 700, borderRadius: 3, padding: '0 5px', background: 'rgba(214,170,60,0.15)', color: '#d9b96a', border: '1px solid rgba(214,170,60,0.4)' } }, '已拦截') : null),
                  h('div', { style: { fontSize: 11, color: 'var(--na-dim)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
                    fmt(e.ts) + ' · ' + (e.charCount || 0) + ' 字符' + (e.turn && Number(e.turn) > 0 ? ' · 轮次 ' + e.turn : '') + ' · ' + sid)),
                h('div', { style: { fontSize: 11, color: 'var(--na-dim)', flexShrink: 0 } }, open ? '收起 ▾' : '展开 ▸')),
              open ? h('div', { style: { padding: '6px 8px', borderTop: '1px solid var(--na-border, #333)' } },
                e.blocked ? h('div', { style: { fontSize: 11, color: '#d9b96a', marginBottom: 4, lineHeight: 1.5 } },
                  '已拦截后台压缩请求（purpose=compaction）：provider 被替换为「' + (e.blockedProvider || '?') + '」，路由阶段失败，未发送到模型。') : null,
                h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 } },
                  h('span', { style: { fontSize: 11, color: 'var(--na-dim)', flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, '末条消息预览：' + (previewOf(e) || '（无）')),
                  h('button', { className: 'dsh-local-btn', style: { flexShrink: 0 }, onClick: () => setJsonView(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n }) }, jsonView.has(key) ? '可读视图' : '原始 JSON')),
                jsonView.has(key)
                  ? h('pre', { style: { margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 420, overflowY: 'auto', background: 'rgba(0,0,0,0.25)', borderRadius: 4, padding: 8, userSelect: 'text' } }, JSON.stringify(e.messages || [], null, 2))
                  : h('div', { style: { display: 'grid', gap: 6 } }, (Array.isArray(e.messages) ? e.messages : []).map((m, mi) => h(MessageBlock, { key: mi, m }))),
                e.system ? h('div', { style: { marginTop: 6 } },
                  h('div', { style: { fontSize: 11, color: 'var(--na-dim)', marginBottom: 2 } }, 'system：'),
                  h('pre', { style: { margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 160, overflowY: 'auto', background: 'rgba(0,0,0,0.25)', borderRadius: 4, padding: 6, userSelect: 'text' } }, String(e.system))) : null,
                e.tools && e.tools.length ? h('div', { style: { marginTop: 6 } },
                  h('div', { style: { fontSize: 11, color: 'var(--na-dim)', marginBottom: 2 } }, 'tools（' + e.tools.length + '）：' + e.tools.map(t => t && (t.name || t.function?.name)).filter(Boolean).join('、')),
                  h('pre', { style: { margin: 0, fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 160, overflowY: 'auto', background: 'rgba(0,0,0,0.25)', borderRadius: 4, padding: 6, userSelect: 'text' } }, JSON.stringify(e.tools, null, 2))) : null)
              : null)
          }))
      }))
    )
  }

  // ========== 注册侧边栏 tab（延迟到 betterSidebar 服务可用，模式同 tavern-plugin）==========
  const getUiConversation = () => ctx.get('uiConversation') || ctx.get('conversation')
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'narrative-anchor:settings',
    title: '叙事锚定设置',
    order: 9,
    single: true,
    createTab: () => ({ tab: { id: 'narrative-anchor:settings', type: 'narrative-anchor:settings', title: '叙事锚定设置' }, patch: { panelOpen: true } }),
    component: props => h(NarrativeAnchorSettingsTab, { sessionId: props.scope?.sessionId, scope: props.scope, uiConversation: getUiConversation })
  }), 'narrative-anchor: settings tab')

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'narrative-anchor:status',
    title: '叙事锚定状态',
    order: 8,
    single: true,
    createTab: () => ({ tab: { id: 'narrative-anchor:status', type: 'narrative-anchor:status', title: '叙事锚定状态' }, patch: { panelOpen: true } }),
    component: props => h(NarrativeAnchorStatusTab, { sessionId: props.scope?.sessionId, scope: props.scope, uiConversation: getUiConversation })
  }), 'narrative-anchor: status tab')

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'narrative-anchor:worldbook',
    title: '会话世界书',
    order: 7,
    single: true,
    createTab: () => ({ tab: { id: 'narrative-anchor:worldbook', type: 'narrative-anchor:worldbook', title: '会话世界书' }, patch: { panelOpen: true } }),
    component: props => h(NarrativeAnchorWorldbookTab, { sessionId: props.scope?.sessionId, scope: props.scope, uiConversation: getUiConversation, sessions: ctx.sessions, ctx })
  }), 'narrative-anchor: worldbook tab')

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'narrative-anchor:quick-inputs',
    title: '快捷输入',
    order: 6,
    single: true,
    createTab: () => ({ tab: { id: 'narrative-anchor:quick-inputs', type: 'narrative-anchor:quick-inputs', title: '快捷输入' }, patch: { panelOpen: true } }),
    component: props => h(QuickInputsTab, props)
  }), 'narrative-anchor: quick-inputs tab')

  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'narrative-anchor:request-log',
    title: '结算请求体',
    order: 5,
    single: true,
    createTab: () => ({ tab: { id: 'narrative-anchor:request-log', type: 'narrative-anchor:request-log', title: '请求体日志' }, patch: { panelOpen: true } }),
    component: props => h(RequestLogTab, { sessionId: props.scope?.sessionId, scope: props.scope })
  }), 'narrative-anchor: request-log tab')

  // ========== v0.9.38 输入框上方 dock 按钮 ==========
  // 目标：把「快捷输入」按钮放进官方按钮行（.dsh-tavern-dock-actions，即
  // conversation.input.dock 里 order -130 的槽位）里、"生成候选项"左边。
  // dock 是纵向布局且每个槽位 width:100%，单独注册的槽位排不进那一行——
  // 官方把 git-graph 分支标签挪进输入框卡片也是用 DOM reparent（git-chip-reparent
  // 任务），这里照同样先例：按钮由本插件槽位渲染（React 单节点、状态走模块级
  // store，重渲染不会触碰兄弟节点），再用 MutationObserver 挪到官方行首。
  const quickDockState = { open: false, listeners: new Set() }
  function setQuickDockOpen(v) {
    quickDockState.open = v
    quickDockState.listeners.forEach(l => { try { l(v) } catch { /* 忽略 */ } })
  }
  function useQuickDockOpen() {
    const [open, setOpen] = React.useState(quickDockState.open)
    React.useEffect(() => {
      const l = v => setOpen(v)
      quickDockState.listeners.add(l)
      return () => quickDockState.listeners.delete(l)
    }, [])
    return open
  }

  // 按钮槽位：渲染唯一一个稳定按钮节点（data-na-quick-btn），由 reparent 挪入官方行。
  function QuickInputDockButton(props) {
    const open = useQuickDockOpen()
    // reparent 在组件挂载后执行（此时 DOM 已就绪）——不要放在 client apply 阶段，
    // 那时 document.body 可能还没挂载，同步抛错会卡死整个 renderer boot。
    React.useEffect(() => {
      let frame = null
      let mo = null
      const ensure = () => {
        frame = null
        try {
          const btn = document.querySelector('[data-na-quick-btn]')
          const row = document.querySelector('.dsh-tavern-dock-actions')
          if (!btn || !row || btn.parentElement === row) return
          row.insertBefore(btn, row.firstChild)
        } catch { /* DOM 结构变化容错 */ }
      }
      const schedule = () => { if (frame == null) frame = window.requestAnimationFrame(ensure) }
      try {
        const body = document.body
        if (body) {
          mo = new MutationObserver(schedule)
          mo.observe(body, { childList: true, subtree: true })
          schedule()
        }
      } catch { /* body 未就绪则放弃本次 reparent */ }
      return () => {
        if (frame != null && window.cancelAnimationFrame) window.cancelAnimationFrame(frame)
        if (mo) mo.disconnect()
      }
    }, [])
    if (!props?.sessionId) return null
    return h('button', {
      'data-na-quick-btn': true,
      className: 'dsh-tavern-choice-trigger',
      title: '快捷输入模板：插入预设的常用输入',
      onClick: () => setQuickDockOpen(!quickDockState.open)
    }, open ? '快捷输入 ▾' : '快捷输入')
  }

  // 面板槽位：泊在按钮行下方，结构/宽度与官方 dsh-tavern-question 面板一致。
  function QuickInputDockPanel(props) {
    const open = useQuickDockOpen()
    const [items, setItems] = React.useState([])
    const [tip, setTip] = React.useState('')
    React.useEffect(() => {
      if (!open) return
      let cancelled = false
      api('quickinput/list', {}).then(r => { if (!cancelled && r && r.ok) setItems(r.items || []) }).catch(() => {})
      return () => { cancelled = true }
    }, [open])
    if (!open || !props?.sessionId) return null
    const insert = async item => {
      if (!String(item.content || '').trim()) { setTip('模板内容为空'); setTimeout(() => setTip(''), 2000); return }
      if (insertToComposer(props.sessionId, item.content)) { setQuickDockOpen(false); setTip('') }
      else { setTip('插入失败——请从侧边栏「快捷输入」复制'); setTimeout(() => setTip(''), 2500) }
    }
    return h('div', { className: 'dsh-tavern-question' },
      h('div', { className: 'dsh-tavern-question-head', onClick: () => setQuickDockOpen(false) },
        h('span', null, '快捷输入模板'),
        h('span', { className: 'dsh-tavern-question-sub' }, '点击模板插入输入框，不自动发送')),
      items.length === 0
        ? h('p', { className: 'dsh-local-help', style: { margin: '4px 0' } }, '暂无模板——点击下方「管理模板」新建')
        : h('div', { style: { display: 'grid', gap: 4, margin: '6px 0' } },
            items.map(t => h('button', { key: t.id, className: 'dsh-tavern-btn quiet', style: { textAlign: 'left', padding: '5px 8px' }, title: t.content || '', onClick: () => void insert(t) },
              h('div', { style: { fontSize: 12.5, fontWeight: 600 } }, t.name),
              String(t.content || '').trim()
                ? h('div', { style: { fontSize: 11, color: 'var(--na-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, String(t.content).replace(/\s+/g, ' ').trim().slice(0, 60))
                : null))),
      tip ? h('p', { style: { fontSize: 12, color: 'var(--na-accent, #8ab4f8)', margin: '2px 0' } }, tip) : null,
      h('div', { className: 'dsh-tavern-question-foot' },
        h('button', { className: 'dsh-tavern-btn quiet', onClick: () => { setQuickDockOpen(false); try { ctx.betterSidebar.openTab({ type: 'narrative-anchor:quick-inputs' }, { sessionId: props.sessionId }) } catch { /* 打开失败忽略 */ } } }, '管理模板 ›'),
        h('button', { className: 'dsh-tavern-btn quiet', onClick: () => setQuickDockOpen(false) }, '关闭')))
  }

  // [v0.9.38b] dock 注册全部加守卫：slots 服务异常时只损失 dock 按钮，
  // 不允许任何同步抛错阻断 renderer boot（2026-10-07 boot 卡死教训）。
  if (ctx.slots && typeof ctx.slots.inject === 'function') {
    ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'narrative-anchor-quick-inputs-btn', order: -129, label: '快捷输入' },
      props => h(QuickInputDockButton, props)
    )), 'narrative-anchor: quick-inputs dock button')

    ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
      { name: 'conversation.input.dock', id: 'narrative-anchor-quick-inputs-panel', order: -127, label: '快捷输入面板' },
      props => h(QuickInputDockPanel, props)
    )), 'narrative-anchor: quick-inputs dock panel')
  } else {
    console.warn('[narrative-anchor] slots 服务不可用，跳过输入框 dock 按钮')
  }

  // ========== v3.5 预设详情页：新增中段条目（原生 DOM，零侵入）==========
  // 官方预设详情页（ExternalPresetLibraryTab）只有导出/重命名/删除，没有"新增条目"；
  // 官方 RPC 也只暴露 updatePresetEntry（改已有条目）。NA 自开 HTTP 端点
  // preset/list + preset/addEntry，按 SillyTavern 格式直接写 <dataRoot>/presets/*.json；
  // 前端用 MutationObserver 在详情页操作行（.dsh-tavern-preset-detail-actions）注入按钮，
  // 点击弹原生表单（不依赖 React 树，预设独立路由也能工作）。新条目 injection_position:1
  // → 官方默认分段规则自动归入中段（preset-conversion-preview.js:231）。
  ;(function installPresetAddEntryUI() {
    if (typeof document === 'undefined' || !document.body) return
    const btnAttr = 'data-na-preset-add-btn'

    function callApi(method, payload) {
      return fetch('/api/narrative-anchor/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).then(r => r.json())
    }

    function openModal() {
      // 读当前详情页标题，用于自动匹配预设
      let title = ''
      const detail = document.querySelector('.dsh-tavern-preset-detail')
      if (detail) {
        const t = detail.querySelector('.dsh-tavern-status-title, h2, h3, [class*="title"]')
        if (t) title = (t.textContent || '').trim()
      }

      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,18,24,.5);backdrop-filter:blur(2px);display:flex;align-items:flex-start;justify-content:center;padding:8vh 16px 16px;overflow-y:auto;'
      const card = document.createElement('div')
      card.style.cssText = 'width:min(560px,100%);background:#fff;border:1px solid #e2e5ea;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:14px 16px;color:#1d2129;font-size:13px;'
      overlay.appendChild(card)
      overlay.onmousedown = (e) => { if (e.target === overlay) close() }

      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;'
      head.innerHTML = '<h3 style="margin:0;font-size:14px;">在预设中新建条目（默认中段）</h3>'
      const closeX = document.createElement('button')
      closeX.textContent = '✕'
      closeX.style.cssText = 'border:none;background:none;cursor:pointer;font-size:14px;color:#68707c;padding:0;'
      closeX.onclick = close
      head.appendChild(closeX)
      card.appendChild(head)

      const labelCss = 'font-size:12px;color:#68707c;display:block;margin:8px 0 3px;'
      const inputCss = 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #e2e5ea;font-size:13px;font-family:inherit;'
      card.insertAdjacentHTML('beforeend',
        '<label style="' + labelCss + '">目标预设</label>' +
        '<select data-na-preset-select style="' + inputCss + '"><option value="">— 加载中…</option></select>' +
        '<div data-na-preset-tip style="font-size:12px;margin:4px 0;"></div>' +
        '<label style="' + labelCss + '">条目标题</label>' +
        '<input data-na-preset-name style="' + inputCss + '" placeholder="例如：世界书召回规则">' +
        '<label style="' + labelCss + '">角色</label>' +
        '<select data-na-preset-role style="' + inputCss + '"><option value="system">system（系统指令）</option><option value="user">user</option><option value="assistant">assistant</option></select>' +
        '<label style="' + labelCss + '">条目内容（作为深度注入放入中段）</label>' +
        '<textarea data-na-preset-content rows="8" style="' + inputCss + 'resize:vertical;" placeholder="写入要在中段注入的提示词……"></textarea>' +
        '<div data-na-tip style="font-size:12px;margin:6px 0;min-height:16px;"></div>'
      )

      const foot = document.createElement('div')
      foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px;'
      const cancel = document.createElement('button')
      cancel.textContent = '取消'
      cancel.style.cssText = 'padding:6px 14px;border:1px solid #e2e5ea;background:#f6f7f9;border-radius:6px;cursor:pointer;font-size:13px;'
      cancel.onclick = close
      const ok = document.createElement('button')
      ok.textContent = '新建条目'
      ok.style.cssText = 'padding:6px 14px;border:none;background:#3b6fd4;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;'
      foot.appendChild(cancel); foot.appendChild(ok)
      card.appendChild(foot)
      document.body.appendChild(overlay)

      const sel = card.querySelector('[data-na-preset-select]')
      const tipEl = card.querySelector('[data-na-tip]')
      const presetTip = card.querySelector('[data-na-preset-tip]')

      function close() {
        document.removeEventListener('keydown', onKey)
        if (overlay.parentElement) overlay.parentElement.removeChild(overlay)
      }
      function onKey(e) { if (e.key === 'Escape') close() }
      document.addEventListener('keydown', onKey)

      callApi('preset/list', {}).then(r => {
        if (!r || !r.ok) { presetTip.innerHTML = '<span style="color:#c0392b;">' + ((r && r.error) || '读取失败') + '</span>'; return }
        const items = r.items || []
        sel.innerHTML = '<option value="">— 请选择预设 —</option>'
        if (items.length === 0) {
          presetTip.innerHTML = '<span style="color:#c0392b;">预设目录为空——请先在预设库「导入外部预设」。</span>'
          return
        }
        items.forEach(it => {
          const o = document.createElement('option')
          o.value = it.path
          o.textContent = it.title
          sel.appendChild(o)
        })
        if (title) {
          const m = items.find(it => it.title === title)
          if (m) sel.value = m.path
        }
      }).catch(e => { presetTip.innerHTML = '<span style="color:#c0392b;">网络错误：' + (e && e.message || e) + '</span>' })

      ok.onclick = () => {
        const path = sel.value
        const name = card.querySelector('[data-na-preset-name]').value
        const role = card.querySelector('[data-na-preset-role]').value
        const content = card.querySelector('[data-na-preset-content]').value
        if (!path) { tipEl.style.color = '#c0392b'; tipEl.textContent = '请先选择预设'; return }
        ok.disabled = true; ok.textContent = '提交中…'
        tipEl.style.color = '#68707c'; tipEl.textContent = ''
        callApi('preset/addEntry', { path, name, role, content }).then(r => {
          if (r && r.ok) {
            tipEl.style.color = '#3b6fd4'
            tipEl.textContent = '已新增：' + ((r.entry && r.entry.name) || name) + '（中段）。请关闭并重新打开该预设查看。'
            ok.textContent = '已完成'
          } else {
            tipEl.style.color = '#c0392b'
            tipEl.textContent = '失败：' + ((r && r.error) || '未知错误')
            ok.disabled = false; ok.textContent = '新建条目'
          }
        }).catch(e => {
          tipEl.style.color = '#c0392b'
          tipEl.textContent = '请求失败：' + (e && e.message || e)
          ok.disabled = false; ok.textContent = '新建条目'
        })
      }
    }

    let frame = null
    const ensure = () => {
      frame = null
      try {
        const row = document.querySelector('.dsh-tavern-preset-detail-actions')
        if (!row) return
        if (row.querySelector('[' + btnAttr + ']')) return
        const btn = document.createElement('button')
        btn.className = 'dsh-tavern-btn quiet'
        btn.setAttribute(btnAttr, 'true')
        btn.textContent = '+ 新增中段条目'
        btn.title = '在当前预设中新建一个 prompt 条目（默认注入中段）'
        btn.onclick = openModal
        row.insertBefore(btn, row.firstChild)
      } catch { /* DOM 变化容错 */ }
    }
    const schedule = () => { if (frame == null) frame = window.requestAnimationFrame(ensure) }
    try {
      const mo = new MutationObserver(schedule)
      mo.observe(document.body, { childList: true, subtree: true })
      schedule()
    } catch { /* body 未就绪 */ }
  })()

  // ========== 快速删除（会话项 ⋯ 菜单内，跳过 archiveSession）==========
  // 官方单条删除：deleteConversation → deleteTavernChats([item]) → prepareDeleteChats → archiveSession(慢) → deleteChats
  // 快速删除：prepareDeleteChats → deleteChats，跳过客户端归档，文件清理仍由服务端执行
  ;(function installFastDelete() {
    const BTN_ATTR = 'data-na-fast-delete'
    let rafId = null

    // 从 React fiber 中找到侧边栏组件的 visibleHistory 状态数组
    function findVisibleHistory(startEl) {
      var fkey = Object.keys(startEl).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0 })
      if (!fkey) return null
      var fiber = startEl[fkey]
      while (fiber) {
        var state = fiber.memoizedState
        while (state) {
          var val = state.memoizedState
          if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0].chatId === 'string' && typeof val[0].sessionId === 'string') {
            return val
          }
          state = state.next
        }
        fiber = fiber.return
      }
      return null
    }

    // 从行元素获取对应的 chatId（通过 fiber.key = sessionId 匹配 visibleHistory）
    function getChatIdFromRow(rowEl) {
      var fkey = Object.keys(rowEl).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0 })
      if (!fkey) return null
      var sessionId = rowEl[fkey] && rowEl[fkey].key
      if (!sessionId) return null
      var history = findVisibleHistory(rowEl)
      if (!history) return null
      for (var i = 0; i < history.length; i++) {
        if (history[i].sessionId === sessionId) return history[i].chatId
      }
      return null
    }

    // 快速删除单个会话
    async function fastDeleteOne(chatId, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '删除中…' }
      try {
        // Step 1: 停止 agent（prepareDeleteChats 返回 { results: [{chatId, ok, error}] }）
        var prep = await fetch('/api/dsh-tavern/prepareDeleteChats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatIds: [chatId] })
        }).then(function (r) { return r.json() })

        if (!prep || !prep.results || !prep.results.length) {
          throw new Error('prepareDeleteChats 返回空结果')
        }
        var first = prep.results[0]
        if (!first.ok) {
          throw new Error('prepareDeleteChats 失败：' + (first.error || '未知'))
        }

        // Step 2: 直接删除（跳过 archiveSession！deleteChats 期望 { chatIds: [...] }）
        var del = await fetch('/api/dsh-tavern/deleteChats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatIds: [chatId] })
        }).then(function (r) { return r.json() })

        if (!del || !del.results || !del.results.length || !del.results[0].ok) {
          throw new Error('deleteChats 失败：' + ((del && del.results && del.results[0] && del.results[0].error) || '未知'))
        }

        setTimeout(function () { window.location.reload() }, 200)
      } catch (e) {
        console.error('[narrative-anchor] fastDelete error:', e)
        if (btn) {
          btn.disabled = false
          btn.textContent = '快速删除（失败）'
          btn.title = '错误：' + (e && e.message || e)
        }
      }
    }

    // 读取管理模式下选中的 chatId 列表
    function getSelectedChatIds() {
      var rows = document.querySelectorAll('.dsh-tavern-side-list .dsh-tavern-side-row')
      if (!rows.length) return []
      var history = findVisibleHistory(rows[0])
      if (!history) return []
      var ids = []
      for (var i = 0; i < rows.length; i++) {
        var cb = rows[i].querySelector('input[type="checkbox"]')
        if (cb && cb.checked && history[i]) {
          ids.push(history[i].chatId)
        }
      }
      return ids
    }

    // 批量快速删除
    async function fastDeleteBatch(btn) {
      if (btn) { btn.disabled = true; btn.textContent = '快速删除中…' }
      try {
        var chatIds = getSelectedChatIds()
        if (!chatIds.length) {
          if (btn) { btn.disabled = false; btn.textContent = '快速删除' }
          return
        }
        var prep = await fetch('/api/dsh-tavern/prepareDeleteChats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatIds: chatIds })
        }).then(function (r) { return r.json() })
        if (!prep || !prep.results || !prep.results.length) throw new Error('prepareDeleteChats 返回空结果')
        var readyIds = prep.results.filter(function (x) { return x.ok }).map(function (x) { return x.chatId })
        if (!readyIds.length) throw new Error('prepareDeleteChats 全部失败')
        var del = await fetch('/api/dsh-tavern/deleteChats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatIds: readyIds })
        }).then(function (r) { return r.json() })
        if (!del || !del.results) throw new Error('deleteChats 返回空结果')
        var failed = del.results.filter(function (x) { return !x.ok })
        if (failed.length) console.warn('[narrative-anchor] fastDeleteBatch 部分失败:', failed)
        setTimeout(function () { window.location.reload() }, 300)
      } catch (e) {
        console.error('[narrative-anchor] fastDeleteBatch error:', e)
        if (btn) {
          btn.disabled = false
          btn.textContent = '快速删除（失败）'
          btn.title = '错误：' + (e && e.message || e)
        }
      }
    }

    // 管理模式批量删除按钮注入
    function ensureBatch() {
      try {
        var delBtn = null
        var btns = document.querySelectorAll('.dsh-tavern-sidebar .dsh-tavern-btn')
        for (var i = 0; i < btns.length; i++) {
          if (btns[i].textContent.indexOf('删除所选') >= 0 || btns[i].textContent.indexOf('正在删除') >= 0) {
            delBtn = btns[i]
            break
          }
        }
        if (!delBtn || !delBtn.parentElement) return
        if (delBtn.parentElement.querySelector('[data-na-fast-batch]')) return

        var btn = document.createElement('button')
        btn.className = 'dsh-tavern-btn'
        btn.setAttribute('data-na-fast-batch', 'true')
        btn.textContent = '快速删除'
        btn.title = '跳过会话归档，直接删除选中会话（更快，但不可通过归档恢复）'
        btn.style.cssText = 'flex-shrink:0;margin:8px 6px 8px 12px;color:#f0ad4e;'
        btn.onclick = function () { fastDeleteBatch(btn) }
        delBtn.parentElement.insertBefore(btn, delBtn)
      } catch (e) { /* DOM 变化容错 */ }
    }

    function ensure() {
      rafId = null
      try {
        // 1. 会话项 ⋯ 菜单：单条快速删除
        var menus = document.querySelectorAll('.dsh-tavern-side-row-menu')
        for (var m = 0; m < menus.length; m++) {
          var menu = menus[m]
          if (menu.querySelector('[' + BTN_ATTR + ']')) continue

          var delBtn = menu.querySelector('button.danger') || Array.from(menu.querySelectorAll('button')).find(function (b) { return b.textContent.trim() === '删除' })
          if (!delBtn) continue

          var btn = document.createElement('button')
          btn.setAttribute(BTN_ATTR, 'true')
          btn.textContent = '快速删除'
          btn.title = '跳过会话归档，直接删除（更快，但不可通过归档恢复）'
          btn.style.cssText = 'color:#f0ad4e;'
          btn.onclick = function (e) {
            e.stopPropagation()
            var row = menu.closest('.dsh-tavern-side-row')
            if (!row) return
            var chatId = getChatIdFromRow(row)
            if (!chatId) {
              console.error('[narrative-anchor] fastDelete: 无法获取 chatId')
              return
            }
            fastDeleteOne(chatId, btn)
          }
          menu.insertBefore(btn, delBtn)
        }

        // 2. 管理模式：批量快速删除
        ensureBatch()
      } catch (e) { /* DOM 变化容错 */ }
    }

    var schedule = function () { if (rafId == null) rafId = window.requestAnimationFrame(ensure) }
    try {
      var mo = new MutationObserver(schedule)
      mo.observe(document.body, { childList: true, subtree: true })
      schedule()
    } catch (e) { /* body 未就绪 */ }
  })()

  // ========== v3.6 输入框处「NA 结算后台模型」标签 ==========
  // 官方在同一个 slot（conversation.input.right）渲染后台模型标签，但其判断硬编码
  // `identity.label === "酒馆后台 Agent"`（tavern-plugin/lib/client.js:14744），NA 的
  // label「叙事锚定后台」匹配不上 → 官方标签不显示。为保留区分度不改 label，改为 NA
  // 自行注册同一 slot（order 101，排在官方之后），用 NA 自己的数据源与判断条件。
  // 相比官方标签（只拼 provider: model），本标签额外显示推理强度。
  //
  // 显示位置：仅在**本插件后台结算会话（na-background-*）自身**的界面上显示。
  // 前台主会话不显示——官方标签挂在同一 slot 且已覆盖前台场景（其判断硬编码 label，
  // 只对官方后台生效），重复渲染会造成两个标签并排冲突。
  // 会话 id 为 na-background-<gameId>，服务端负责反推 gameId 后查实际结算选择。
  //
  // 刷新策略：纯事件驱动、无定时器——挂载加载一次 + 会话切换重载 + 页面切回可见时补一次。
  function NaBackgroundModelLabel(props) {
    const [sid, setSid] = React.useState('')
    const [info, setInfo] = React.useState(null)
    const sessions = ctx.sessions

    const readCurrent = () => {
      const fromProps = String((props && props.sessionId) || '')
      if (fromProps) return fromProps
      try {
        const snap = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
          ? sessions.list.getSnapshot() : null
        return String((snap && snap.current) || '')
      } catch { return '' }
    }

    // 订阅会话切换（官方同款：sessions.list 是 external store）
    React.useEffect(() => {
      setSid(readCurrent())
      if (!sessions || !sessions.list || typeof sessions.list.subscribe !== 'function') return undefined
      return sessions.list.subscribe(() => setSid(readCurrent()))
    }, [])

    React.useEffect(() => {
      let active = true
      if (!sid) { setInfo(null); return undefined }
      const load = () => {
        api('settlementModelInfo', { sessionId: sid })
          .then((r) => { if (active) setInfo(r && r.ok ? r : null) })
          .catch(() => { if (active) setInfo(null) })
      }
      load()
      // 纯事件驱动，无轮询：仅页面切回可见时补一次（对齐设置页 visibilitychange 节奏）。
      // 后台模型配置改动频率极低，切回会话时刷新已足够；结算产生的新值随下次切换可见。
      const onVis = () => { if (!document.hidden) load() }
      document.addEventListener('visibilitychange', onVis)
      return () => { active = false; document.removeEventListener('visibilitychange', onVis) }
    }, [sid])

    // 只在本插件的后台结算会话（na-background-*）自身界面上显示。
    // 前台主会话不显示——那里由官方标签负责（且其判断硬编码 label，只对官方后台生效）。
    if (!sid.startsWith('na-background-')) return null
    const sel = info && info.selection
    if (!sel || (!sel.provider && !sel.model)) return null
    const effort = String(sel.reasoningEffort || '').trim()
    // 与 NA 请求日志页一致的 `model · provider` 顺序，额外补强度（官方标签不显示强度）
    const text = (sel.model || '?')
      + (sel.provider ? ' · ' + sel.provider : '')
      + (effort ? ' · ' + effort : '')
    return h('div', {
      className: 'dsh-tavern-background-model na-background-model',
      title: 'NA 结算后台：' + text + '（可在「后台模型」设置中修改）',
      'aria-label': 'NA 后台模型：' + text
    },
      h('span', null, text))
  }

  // ========== 舞台视图：官方全屏 overlay 的非全屏移植（tavernUi.registerStageView）==========
  // 官方非全屏舞台没有「自动」（自动只存在于全屏 overlay），也没有「往官方 footer 加按钮」
  // 的接口；文档明确「页面结构不是接口」，不做 DOM 注入。按官方设计注册舞台视图，
  // 并整体照抄官方全屏 overlay（TavernStageFullscreen）的非全屏形态：
  //   · reader / reading 自建，口径逐行复刻官方 useTavernStageReader /
  //     useTavernStageReading（cast-stage.js:119-127/131-143，localStorage 同键）；
  //   · 场景照官方 TavernStageScene 口径（:61-85），controls 照官方全屏 footer 口径
  //     （:192-199）：‹ 进度 › 自动 朗读，顺序/类名/disabled 与全屏一致；
  //   · 「自动」= 官方 auto 三元组整体移植（:157 state + :173-182 effect + :196 按钮），
  //     无 NA 私货（仅 speak 判空与 .catch 防卡死两处插件侧适配）；
  //   · 不调用 advance()——官方 section 的 reader 随之冻结，其「翻页即读」effect 不再
  //     每页触发（官方全屏靠 !fullscreen 静音它，非全屏没有该开关，故以自管 reader 等效）；
  //   · 全屏：返回 null → 官方边界兜底用内置全屏（自带「自动」）；render 抛错同样兜底。

  const NA_CAST_EMOTIONS = { admiration: '钦佩', amusement: '逗乐', anger: '生气', annoyance: '烦躁', approval: '赞同', caring: '关心',
    confusion: '困惑', curiosity: '好奇', desire: '渴望', disappointment: '失望', disapproval: '不满', disgust: '嫌弃',
    embarrassment: '害羞', excitement: '兴奋', fear: '害怕', gratitude: '感激', grief: '悲痛', joy: '开心',
    love: '爱慕', nervousness: '紧张', neutral: '平静', optimism: '期待', pride: '得意', realization: '恍然',
    relief: '释然', remorse: '懊悔', sadness: '难过', surprise: '惊讶' }
  function naCastHue(name) {
    let hash = 0
    for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0
    return hash % 360
  }
  function naCastCharacter(cast, name) {
    return (cast || []).find(item => item.name === name || (item.aliases || []).indexOf(name) >= 0) || null
  }
  // 官方 tavernCastImage 口径：情绪立绘 → neutral → 任意立绘 → 头像
  function naCastImage(stage, name, emotion) {
    const character = naCastCharacter(stage.characters, name)
    const sprites = character ? character.sprites || {} : {}
    const sprite = sprites[emotion] || sprites.neutral || Object.values(sprites)[0] || ''
    const avatar = (character && (character.avatars || {})[emotion]) || (character && character.avatarUrl) || (name === stage.card.name ? stage.card.imageUrl : '')
    return sprite || avatar
  }
  // 官方 TavernStageFigure 照端口径（cast-stage.js:50-58）：图片加载失败退首字母
  function NaStageFigure(props) {
    const [failed, setFailed] = React.useState('')
    const url = failed === props.url ? '' : props.url
    return h('div', { className: 'dsh-tavern-stage-figure' + (props.speaking ? ' is-speaking' : '') + (props.dim ? ' is-dim' : ''), 'data-speaker': props.name },
      h('div', { className: 'dsh-tavern-stage-figure-body' },
        url ? h('img', { key: url, src: url, alt: props.name, onError: () => setFailed(props.url) })
          : h('span', { className: 'dsh-tavern-stage-figure-letter', style: { '--dsh-cast-hue': naCastHue(props.name) } }, Array.from(props.name)[0] || '?')))
  }
  // 官方 footer 里的「朗读」开关按钮（TavernStageReadButton，文本「朗读」）；不存在返回 null
  // 官方 useTavernStageReader 口径（cast-stage.js:119-127）：新一轮（key 变）重置到首句，
  // index 越界钳回。beats 直接用官方 input.beats（同源切分），index 自管——
  // advance() 不再调用，官方 section 的 reader 随之冻结，其「翻页即读」effect
  // 依赖 reader.index 不再每页变化（每轮最多触发一次），非全屏下不再与 NA 每页双发。
  function naStageReader(stage, beats) {
    const turns = stage && Array.isArray(stage.turns) ? stage.turns : []
    const latest = turns.length ? turns[turns.length - 1] : null
    const [index, setIndex] = React.useState(0)
    const key = latest ? latest.turn + ':' + (beats[0] ? beats[0].text : '') : ''
    React.useEffect(function () { setIndex(0); }, [key])
    return {
      beats: beats,
      index: Math.min(index, Math.max(0, beats.length - 1)),
      setIndex: setIndex,
      turn: latest && latest.turn
    }
  }
  // 官方 useTavernStageReading 口径（cast-stage.js:131-143）：localStorage 同键记忆、
  // toggle 时停播、卸载停播。与官方差异：available 官方取自 useTavernSpeechSettings（rpc），
  // tavernUi 无此入口，NA 恒按可用处理——配音关闭时宿主 speechForLine 回 {skip:true}、
  // speak resolve false，effect 自然走时长分支，行为等价。
  const NA_STAGE_READ_KEY = 'dsh-tavern-stage-read'
  function naStageReading() {
    const [reading, setReading] = React.useState(function () {
      try { return window.localStorage.getItem(NA_STAGE_READ_KEY) !== '0' } catch (error) { return true }
    })
    function toggle() {
      const next = !reading
      setReading(next)
      if (!next && ctx.tavernUi && typeof ctx.tavernUi.stopSpeech === 'function') ctx.tavernUi.stopSpeech()
      try { window.localStorage.setItem(NA_STAGE_READ_KEY, next ? '1' : '0') } catch (error) {}
    }
    React.useEffect(function () {
      return function () { if (ctx.tavernUi && typeof ctx.tavernUi.stopSpeech === 'function') ctx.tavernUi.stopSpeech() }
    }, [])
    return { available: true, on: reading, toggle: toggle }
  }
  // 官方 TavernStageReadButton 口径（cast-stage.js:149-152）
  function NaStageReadButton(props) {
    return h('button', {
      type: 'button',
      className: props.reading.on ? 'is-on' : '',
      'aria-pressed': props.reading.on,
      onClick: props.reading.toggle
    }, '朗读')
  }
  // 官方 tavernBeatSpeech 口径（cast-stage.js:145-148）：line 带 speaker/emotion，narration 只带文本
  function naStageBeatSpeech(gameId, beat) {
    return beat.kind === 'line'
      ? { gameId, speaker: beat.speaker, text: (beat.quotes || []).join(' ') || beat.text, emotion: beat.emotion }
      : { gameId, text: beat.text, narration: true }
  }
  // 官方全屏 auto 三元组整体移植（cast-stage.js:157/173-182/196）：state、effect、
  // 按钮逐行同款。effect 无 NA 私货——reader 与 reading 均自建（见上），index 只在
  // NA 自己翻页时变化，朗读与翻页在同一处成对发生，不存在第二个朗读者。
  // 仅两处插件侧必要适配：speak 取 tavernUi.speak（判空）、.catch 防 speak reject 时
  // 卡住不翻页（官方模块内直调 tavernSpeech 不会 reject，故原版无 catch）。
  function NaStageAutoButton(props) {
    const [auto, setAuto] = React.useState(false)
    const atEnd = props.index >= props.beats.length - 1
    React.useEffect(function () {
      const beat = props.beats[props.index]
      let active = true, timer = null
      const delay = Math.max(1500, Math.min(10000, 400 + 70 * Array.from(beat ? beat.text : '').length))
      const turn = function (wait) { if (active && auto && !atEnd) timer = window.setTimeout(props.step, wait) }
      if (props.readingOn && beat && props.speak) {
        Promise.resolve(props.speak(naStageBeatSpeech(props.gameId, beat)))
          .then(function (heard) { turn(heard ? 400 : delay) })
          .catch(function () { turn(delay) })
      } else turn(delay)
      return function () { active = false; if (timer !== null) window.clearTimeout(timer) }
    }, [auto, props.index, props.turn, props.beats, atEnd, props.readingOn])
    return h('button', {
      type: 'button',
      className: auto ? 'is-on' : '',
      'aria-pressed': auto,
      onClick: function () { setAuto(!auto) }
    }, '自动')
  }
  // 官方 TavernStageScene 照端口径（cast-stage.js:61-85）：只看已读过的句子决定谁上台；
  // 翻页/controls 按官方全屏 overlay 口径（:156/192-199）：reader 自管、step(±1)、
  // controls 顺序 ‹ 进度 › 自动 朗读（全屏另有 spacer/退出，非全屏不需要）。
  function NaStageScene(props) {
    const stage = props.stage, beats = props.beats, index = props.index
    const beat = beats[index] || null
    const present = [], emotions = new Map()
    for (let at = 0; at <= index && at < beats.length; at += 1) {
      const item = beats[at]
      if (item.kind !== 'line' || item.speaker === stage.player) continue
      if (present.indexOf(item.speaker) < 0) present.push(item.speaker)
      emotions.set(item.speaker, item.emotion)
    }
    const shown = present.slice(-3)
    function step(delta) {
      props.setIndex(function (value) { return Math.max(0, Math.min(beats.length - 1, value + delta)) })
    }
    return h('div', { className: 'dsh-tavern-stage-scene', onClick: function () { step(1) } },
      stage.background ? h('div', { className: 'dsh-tavern-stage-backdrop is-scene', style: { '--dsh-stage-backdrop': 'url("' + stage.background + '")' } })
        : h('div', { className: 'dsh-tavern-stage-backdrop', style: stage.card && stage.card.imageUrl ? { '--dsh-stage-backdrop': 'url("' + stage.card.imageUrl + '")' } : undefined }),
      h('div', { className: 'dsh-tavern-stage-figures' }, shown.map(name => h(NaStageFigure, {
        key: name, name, url: naCastImage(stage, name, emotions.get(name)),
        speaking: beat && beat.speaker === name, dim: beat && beat.kind === 'line' && beat.speaker !== name
      }))),
      beat ? h('div', { className: 'dsh-tavern-stage-textbox' },
        beat.kind === 'line' ? h('div', { className: 'dsh-tavern-stage-name', style: { '--dsh-cast-hue': naCastHue(beat.speaker) } }, beat.speaker,
          NA_CAST_EMOTIONS[beat.emotion] && beat.emotion !== 'neutral' ? h('span', { className: 'dsh-tavern-cast-emotion' }, NA_CAST_EMOTIONS[beat.emotion]) : null) : null,
        h('div', { key: index, className: 'dsh-tavern-stage-text' + (beat.kind === 'narration' ? ' is-narration' : '') }, beat.text),
        // 官方全屏 footer 口径自绘（cast-stage.js:192-199，去「退出舞台」）：顺序、类名、
        // disabled 边界与全屏一致；「自动」位于 › 与「朗读」之间（全屏同序）
        h('div', { className: 'dsh-tavern-stage-controls', onClick: event => event.stopPropagation() },
          h('button', { type: 'button', onClick: function () { step(-1) }, disabled: index <= 0, 'aria-label': '上一句' }, '‹'),
          h('span', { className: 'dsh-tavern-stage-progress' }, beats.length ? (index + 1) + ' / ' + beats.length : ''),
          h('button', { type: 'button', onClick: function () { step(1) }, disabled: index >= beats.length - 1, 'aria-label': '下一句' }, '›'),
          h(NaStageAutoButton, {
            beats: beats, index: index, turn: props.turn, step: function () { step(1) },
            readingOn: props.reading.on, speak: props.speak, gameId: props.gameId
          }),
          h(NaStageReadButton, { reading: props.reading }),
          h('span', { className: 'dsh-tavern-spacer' })))
        : h('div', { className: 'dsh-tavern-stage-textbox is-empty' }, '还没有可以演出的正文'))
  }
  // 持 reader/reading 的根组件（hooks 需要稳定的组件身份；render 入口每次调用不能带 hooks）
  function NaStageRoot(props) {
    const reader = naStageReader(props.stage, props.beats)
    const reading = naStageReading()
    const ui = ctx.tavernUi
    return h(NaStageScene, {
      stage: props.stage, beats: reader.beats, index: reader.index, turn: reader.turn,
      setIndex: reader.setIndex, reading: reading,
      speak: ui && typeof ui.speak === 'function' ? ui.speak : null, gameId: props.gameId
    })
  }
  function NaStageView(input) {
    if (!input || !input.stage || !Array.isArray(input.beats)) return null
    // 全屏继续用内置（自带「自动」），避免双按钮
    if (input.fullscreen) return null
    return h(NaStageRoot, { stage: input.stage, beats: input.beats, gameId: input.gameId })
  }
  // 注册舞台视图（tavernUi.apiVersion 2+）。官方语义：未选过样式时默认用插件视图
  // （「装了就默认用」），用户可在舞台页「舞台样式」选回「内置」。
  ctx.effect(() => {
    const ui = ctx.tavernUi
    if (!ui || typeof ui.registerStageView !== 'function' || (Number(ui.apiVersion) || 0) < 2) return undefined
    try {
      return ui.registerStageView({ id: 'na-stage', label: 'NA 舞台', render: input => NaStageView(input) })
    } catch (error) {
      console.error('[narrative-anchor] 舞台视图注册失败', error)
      return undefined
    }
  }, 'narrative-anchor: stage view')

  // ========== v3.0 官方开始页分组（tavernUi.registerStartGroup）==========
  // 官方 main 原生能力：把本插件 tab 收进「叙事锚定」独立分组，排在本局/资料库/偏好之后、
  // 插件之前；带 ':' 的是 registerTab 完整 id（betterSidebar.registerTab 注册的 tab 同此 id）。
  // 运行时 42852b0 的 client.js 已含 registerStartGroup（L10711），无需升级即可生效。
  ctx.effect(() => {
    const tavernUi = ctx.tavernUi
    if (!tavernUi || typeof tavernUi.registerStartGroup !== 'function') return
    return tavernUi.registerStartGroup({
      title: '叙事锚定',
      tabs: ['narrative-anchor:settings', 'narrative-anchor:status', 'narrative-anchor:worldbook', 'narrative-anchor:quick-inputs', 'narrative-anchor:request-log']
    })
  }, 'narrative-anchor: start group')

  // v3.6：往官方同一个 slot 注册 NA 自己的后台模型标签（order 101 —— 排在官方标签之后）。
  // 官方标签只对 label「酒馆后台 Agent」生效，NA 保持自己的 label 以区分两者。
  ctx.effect(() => {
    const slots = ctx.slots
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return undefined
    try {
      return slots.inject('conversation.input.right', () => slots.register({
        name: 'conversation.input.right',
        id: 'narrative-anchor-background-model',
        order: 101
      }, (props) => h(NaBackgroundModelLabel, props)))
    } catch (e) {
      console.error('[narrative-anchor] background model label 注册失败', e)
      return undefined
    }
  }, 'narrative-anchor: background model label')

  console.log('[narrative-anchor] 客户端已注册 5 个侧边栏 tab + 开始页分组 + 输入框 dock 按钮')
    }

    module.exports.inject = ['betterSidebar', 'tavernUi', 'sessions', 'slots', 'conversation']

    return module.exports;
  }
});
