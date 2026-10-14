/**
 * 叙事锚定独立结算路线 —— 通用工具函数（v0.5）
 *
 * [2026-10-09 v2.2 清理] 旧编排器专属的 MVU 变量审计/回执辅助（auditMvuSettlement、
 * pendingReceipt、applyMvuSubmission、promptVariables、retryPromptState、
 * rejectNonStatDataPaths、clone 等）已随 orchestrator 移除；完整历史见
 * legacy-user-tool-backup/dead-code-v2-orchestrator/。
 * 本文件仅保留被活代码（strategies.js 锚点策略 / index.js）消费的 str / object。
 */

export function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
