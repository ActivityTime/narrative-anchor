// installModelSelection 的本地等价实现（2026-10-21，据 @deepseek-ai/dsh-agent
// 0.2.1-rc.2 lib/model-selection.js 移植）。
//
// 为什么移植：上游实现静态 import @deepseek-ai/dsh-agent（该包在宿主 app.asar 内，
// 仅 bundle 安装的 profile node_modules dual anchor 可解析）；folder-drop 安装
// （<data>/plugins/，DSHT guard 以原生 ESM 加载）下 Node 解析不到，插件直接
// 加载失败。本文件只依赖 cordis ctx API，两种安装方式均可工作。
//
// 与上游的差异：未移植 modelSwitchNotice（agent/pre-step 的切模型用户通知）——
// 它依赖 @deepseek-ai/dsh-llm 的 createUserMessage 构造带 source 元数据的消息，
// 且仅对交互式会话的模型切换有意义；后台结算会话的 selection 每轮静态指定
// （makeSetup 闭包内固定 bg.provider/model），不会发生切换，故省略。
// 其余行为（assemble 快照 + request 路由覆盖 + disposer 返回）与上游逐行一致。

export function installModelSelection(agentCtx, selection) {
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model
      }
    }
  })
  const disposeRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }
    }
  })
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
