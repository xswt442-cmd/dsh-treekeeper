// 读取一个可选 DSH 服务。
//
// 注册期用 `ctx.inject` 声明依赖；请求处理时服务实例可能已经被替换，所以每次
// 调用都重新读取，不缓存。真实的 Cordis 上下文在注入围栏外读属性会抛错，
// `ctx.get(name)` 是围栏内的读法；精简的测试上下文直接暴露服务对象。两种都试，
// 读不到就是这一项能力不可用，由调用方如实呈现。

export function readService(ctx, name) {
  try {
    const direct = ctx[name]
    if (direct) return direct
  } catch {
    // 围栏外读属性在真实上下文里会抛；继续尝试 ctx.get。
  }
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : null
  } catch {
    return null
  }
}
