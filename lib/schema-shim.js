// 标准 Schema（Standard Schema v1）兜底实现 —— 仅当 @deepseek-ai/schemastery
// 不可解析时由 index.js 动态 import 失败分支启用。
//
// 背景：folder-drop 安装（<data>/plugins/，由 DSHT guard 以原生 ESM 加载）下，
// Node 从插件目录上溯找不到 @deepseek-ai/*（宿主包在 app.asar 内，由 bundle
// 安装的 profile node_modules dual anchor 提供）。宿主 cordis 的 resolveConfig
// 只消费 Config['~standard'].validate(config)（同步返回 { value }），因此本
// shim 只需实现该协议并补齐各字段默认值。
//
// 与真 schemastery 的差异：不做类型校验/转换——配置来源为 cordis.patch.yml
// seed 或用户手改，异常值由插件内部 || 兜底消化；bundle 安装下仍优先使用真
// schemastery（见 index.js 的动态 import），行为与既往版本一致。

const nodes = new WeakMap()

function shimSchema(kind, shape) {
  const node = { kind, shape, hasDefault: false, default: undefined, description: '' }
  const api = {
    default(value) { node.hasDefault = true; node.default = value; return api },
    description(value) { node.description = String(value ?? ''); return api }
  }
  api['~standard'] = {
    version: 1,
    vendor: 'narrative-anchor',
    validate(value) { return { value: applyDefaults(node, value) } }
  }
  nodes.set(api, node)
  return api
}

function applyDefaults(node, value) {
  if (node.kind !== 'object' || !node.shape) return value
  const out = value && typeof value === 'object' ? { ...value } : {}
  for (const [key, child] of Object.entries(node.shape)) {
    const childNode = nodes.get(child)
    if (!childNode) continue
    if (out[key] === undefined || out[key] === null) {
      if (childNode.hasDefault) out[key] = childNode.default
    } else if (childNode.kind === 'object' && childNode.shape) {
      out[key] = applyDefaults(childNode, out[key])
    }
  }
  return out
}

export function createSchemaShim() {
  return {
    object: (shape) => shimSchema('object', shape),
    string: () => shimSchema('string'),
    number: () => shimSchema('number'),
    boolean: () => shimSchema('boolean'),
    array: () => shimSchema('array'),
    dict: () => shimSchema('dict'),
    any: () => shimSchema('any')
  }
}
