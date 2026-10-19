import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { treekeeperGuard, hasVerifiedCreationTime, parseCimDate, isLoopbackAddress, resolveDshHome, hostDshHome, dshSignals, hasPreviousHostSignal, rankUnattributed, unattributedRows, hostKind, HOST_KIND_DESKTOP, HOST_KIND_WEB } from '../lib/shared.js'

function response() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) }
  }
}

// 除特别说明外，这些测试里的请求都来自回环地址；守卫判断的是 TCP 对端地址，
// 不是请求头。
const loopback = (headers = {}) => ({ headers, socket: { remoteAddress: '127.0.0.1' } })

test('CIM dates and identity tolerance are parsed consistently', () => {
  const createdMs = parseCimDate('20260825162958.5+480')

  assert.equal(createdMs, Date.UTC(2026, 7, 25, 8, 29, 58, 500))
  assert.ok(hasVerifiedCreationTime(createdMs, createdMs + 750))
  assert.ok(!hasVerifiedCreationTime(createdMs, createdMs + 751))
  assert.ok(!hasVerifiedCreationTime(createdMs, null))
})

test('the .NET JSON date form is a creation time, and the .NET floor is not', () => {
  // Windows PowerShell 5.1 的 ConvertTo-Json 不输出 ISO 形式：JSON 文本是
  // `"\/Date(ms)\/"`，解析回来是 `/Date(ms)/`。必须把它读成创建时间，否则每一行
  // 都会丢掉创建时间，也随之丢掉终止按钮。
  assert.equal(parseCimDate('/Date(1790745392422)/'), 1790745392422)
  assert.equal(parseCimDate('  /Date(1790745392422)/  '), 1790745392422)
  // 只认数字：属性被拒绝时携带的下限（1601-01-01）不能被读成创建时间，否则终止
  // 检查会拿它比对身份。
  assert.equal(parseCimDate('/Date(-62135596800000)/'), null)
  assert.equal(parseCimDate('/Date(abc)/'), null)
  assert.equal(parseCimDate('/Date(1790745392422)/extra'), null)
  // 两代 PowerShell 输出的每种形式，加上缺失值，都保持可区分。
  assert.equal(parseCimDate('2026-08-25T16:29:59.250+08:00'), Date.UTC(2026, 7, 25, 8, 29, 59, 250))
  assert.equal(parseCimDate(null), null)
  assert.equal(parseCimDate(''), null)
})

test('DSH relevance orders the unattributed bucket, and only DSH paths accuse a dead host', () => {
  const desktopHost = {
    pid: 37224,
    name: 'DeepSeek Harness',
    cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --expose-internals "E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js"'
  }
  assert.deepEqual(dshSignals(desktopHost).signals, ['image', 'expose-internals', 'asar', 'node_modules'])
  assert.equal(dshSignals(desktopHost).score, 13)
  assert.ok(hasPreviousHostSignal(desktopHost))

  // 包管理器只是排序信号：`_npx` 与 `node_modules` 说明不了进程由哪个宿主启动，
  // 因此永远不能据此指控某个宿主。
  const cache = {
    pid: 51,
    name: 'node',
    cmdline: 'node C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\x\\index.js'
  }
  assert.deepEqual(dshSignals(cache).signals, ['npx', 'node_modules'])
  assert.ok(!hasPreviousHostSignal(cache))
  // 命令行里调用的 `npx` 不是它运行所在的 `_npx` 缓存路径。
  assert.equal(dshSignals({ pid: 50, name: 'cmd', cmdline: 'cmd /c npx -y @upstash/context7-mcp' }).score, 0)
  assert.equal(dshSignals({ pid: 4, name: 'System', cmdline: '' }).score, 0)
  assert.equal(dshSignals(undefined).score, 0)

  const ranked = rankUnattributed([
    { pid: 900, name: 'svchost', cmdline: 'C:\\Windows\\system32\\svchost.exe -k netsvcs' },
    cache,
    desktopHost,
    { pid: 3, name: 'System', cmdline: '' }
  ])
  assert.deepEqual(ranked.map((p) => p.pid), [37224, 51, 3, 900], 'relevance first, then pid ascending')

  // 宿主发送的行带着桌面应用成员标记，面板据此分组，不再对整机命令行做第二次
  // 匹配。选出这个成员的信号 id 留在宿主里。
  const rows = unattributedRows([
    { pid: 900, ppid: 0, name: 'svchost', cmdline: 'svchost -k netsvcs' },
    desktopHost
  ])
  assert.deepEqual(rows.map((row) => row.pid), [37224, 900], 'the order is the ranked one')
  assert.deepEqual(rows.map((row) => row.desktopApp), [true, false])
  assert.ok(!('signals' in rows[0]), 'the signal ids do not cross to the browser')
  assert.equal(rows[0].ppid, undefined, 'a stamped row keeps the fields it came with')
  assert.equal(unattributedRows(null).length, 0)
})

// 桌面应用的 Electron 进程组：渲染、GPU 与网络工具进程是宿主的兄弟而不是后代，
// 因此会排在整机集合的前面，看起来像遗留进程。它们属于同一个应用，宿主给属于
// 该应用的行打上标记，面板据此把它们显示成一个组。
test('the desktop application membership follows the parent chain inside the bucket', () => {
  const main = { pid: 40376, ppid: 13784, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe"' }
  const gpu = { pid: 26928, ppid: 40376, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=gpu-process' }
  const renderer = { pid: 9480, ppid: 40376, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=renderer --standard-schemes=dsh-app' }
  const outsider = { pid: 35004, ppid: 0, name: 'node', cmdline: 'node C:\\billion-context\\dist\\index.js start' }

  const flags = (procs) => unattributedRows(procs).map((row) => [row.pid, row.desktopApp])

  // 父进程链决定成员，因此成员与排好序的集合以什么顺序到达无关；父进程在集合
  // 之外的行不会被它带进来。
  const orders = [[main, gpu, renderer, outsider], [renderer, outsider, gpu, main], [gpu, outsider, renderer, main]]
  for (const order of orders) {
    assert.deepEqual(flags(order), [[9480, true], [26928, true], [40376, true], [35004, false]])
  }

  // 子进程的子进程也会加入：闭包在集合增长时继续计算。
  const util = { pid: 27240, ppid: 9480, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=utility' }
  assert.deepEqual(flags([util, outsider, main, gpu, renderer]), [[9480, true], [26928, true], [27240, true], [40376, true], [35004, false]])

  // 两次运行的应用各自保留自己的子进程，没有行会串到另一次运行的组里。
  const second = { pid: 40100, ppid: 13784, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe"' }
  const secondChild = { pid: 40101, ppid: 40100, name: 'DeepSeek Harness', cmdline: '"E:\\DSH\\DeepSeek Harness.exe" --type=gpu-process' }
  assert.deepEqual(flags([main, gpu, second, secondChild]), [[26928, true], [40100, true], [40101, true], [40376, true]])

  // 集合保留每一行与它的排序；新增的只有那个布尔标记。
  const rows = unattributedRows([outsider, main, gpu])
  assert.deepEqual(rows.map((row) => row.pid), [26928, 40376, 35004])
  assert.equal(rows.length, 3, '成员判定不会把行从集合里移走')
  assert.equal(unattributedRows([]).length, 0)
})

// 面板要说明回答的是哪一种宿主，答案从进程事实读取：桌面宿主是 Electron 包，
// web 宿主是 node.exe。环境变量不能作为证据，因为从桌面应用启动的 `dsh web`
// 宿主会继承它的 ELECTRON_RUN_AS_NODE。
test('the host kind is read from the process facts, and the environment is not one of them', () => {
  assert.equal(HOST_KIND_DESKTOP, 'desktop')
  assert.equal(HOST_KIND_WEB, 'web')

  assert.equal(hostKind({
    execPath: 'E:\\DSH\\resources\\app.asar\\dsh\\node.exe',
    execArgv: [],
    argv: ['node', 'E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'],
    env: {}
  }), HOST_KIND_DESKTOP)

  // 运行中的桌面宿主：可执行文件是 node.exe，包里的脚本在 argv 里，标志被 Node
  // 自己移进了 execArgv。
  assert.equal(hostKind({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: ['--expose-internals'],
    argv: ['node', 'E:\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'],
    env: {}
  }), HOST_KIND_DESKTOP, '运行中的进程把标志放在 execArgv 里')

  // 采样器从操作系统读到的进程行仍然把标志留在记录的命令行里。
  assert.equal(hostKind({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    execArgv: [],
    argv: ['node', '--expose-internals', 'E:\\DSH\\resources\\app.asar\\dsh\\lib\\index.js'],
    env: {}
  }), HOST_KIND_DESKTOP, '记录的命令行里仍然能读到这个标志')

  const web = { execPath: 'C:\\Program Files\\nodejs\\node.exe', execArgv: [], argv: ['node', 'C:\\dsh\\bin\\dsh.js', 'web'] }
  assert.equal(hostKind(web), HOST_KIND_WEB)
  assert.equal(hostKind({ ...web, env: { ELECTRON_RUN_AS_NODE: '1' } }), hostKind(web),
    '继承来的 ELECTRON_RUN_AS_NODE 不会让 web 宿主读成桌面宿主')
  assert.equal(hostKind({ ...web, env: {} }), hostKind(web))

  // 形状异常的进程对象只给出答案，不抛错。
  assert.equal(hostKind({}), HOST_KIND_WEB)
  assert.equal(hostKind(undefined), HOST_KIND_WEB)
  assert.equal(hostKind({ execPath: 42, execArgv: 'nope', argv: [null, 7] }), HOST_KIND_WEB)
})

test('isLoopbackAddress folds real loopback forms and fails closed', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:127.0.0.2', '127.255.0.1']) {
    assert.ok(isLoopbackAddress(a), a)
  }
  for (const a of ['192.168.1.5', '10.0.0.1', '::2', 'example.com', '', null, undefined, '  ', '::ffff:8.8.8.8']) {
    assert.ok(!isLoopbackAddress(a), String(a))
  }
})

test('API guard accepts loopback and rejects browser cross-site requests', () => {
  const guard = treekeeperGuard()
  const allowedResponse = response()
  const rejectedResponse = response()

  assert.equal(guard(loopback({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }), allowedResponse), true)
  assert.equal(guard(loopback({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), rejectedResponse), false)
  assert.equal(rejectedResponse.status, 403)
  assert.equal(rejectedResponse.body.code, 'cross_site')
})

// 会话入口不直接访问接口，但它扩大了客户端的请求面，因此 Origin、Host 与
// Fetch Metadata 这几项检查在所有轴向上都必须保持严密。
test('API guard rejects a foreign Origin and a rebound non-loopback Host', () => {
  // 这里显式给出端口：共享守卫总是把 Origin 的端口与服务器端口比较，不比较就会
  // 把 `http://localhost:3080` 放进任何端口的服务器。
  const guard = treekeeperGuard({ currentPort: () => 3080 })

  for (const origin of ['https://evil.example', 'https://127.0.0.1.evil.example', 'http://localhost.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host: '127.0.0.1:3080', origin }), rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'foreign_origin')
  }

  for (const host of ['rebound.example', '127.0.0.1.evil.example']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host, 'sec-fetch-site': 'same-origin' }), rejectedResponse), false)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'non_loopback')
  }

  // 只接受精确的回环写法；任意 localhost 子域都被拒绝，DNS 重绑定因此进不了
  // 接口范围。
  for (const host of ['localhost:3080', '127.0.0.1:3080']) {
    const allowedResponse = response()
    assert.equal(guard(loopback({ host, origin: 'http://localhost:3080' }), allowedResponse), true)
  }
  const subdomainResponse = response()
  assert.equal(guard(loopback({ host: 'api.localhost' }), subdomainResponse), false)
  assert.equal(subdomainResponse.body.code, 'non_loopback')

  // IPv4 映射的 IPv6 形式属于回环：双栈浏览器访问面板时对端是 ::ffff:127.0.0.1，
  // 拒绝它会把合法客户端挡在自己的接口之外。两种写法都覆盖。
  for (const host of ['[::ffff:127.0.0.1]:3080', '[::ffff:7f00:1]:3080']) {
    const allowedResponse = response()
    assert.equal(guard(loopback({ host }), allowedResponse), true, `${host} is loopback`)
  }

  // 解析不出主机名的 Host 必须失败关闭，不能跳过白名单。RFC 7230 要求 IPv6
  // 字面量带方括号，客户端仍然可以发不带括号的形式，而 `hostHostname` 会在第一个
  // 冒号处切开它。
  for (const host of ['::1:3080', '::ffff:127.0.0.1:3080']) {
    const rejectedResponse = response()
    assert.equal(guard(loopback({ host }), rejectedResponse), false, `${host} is not a usable Host`)
    assert.equal(rejectedResponse.status, 403)
    assert.equal(rejectedResponse.body.code, 'non_loopback')
  }
})

test('API guard uses strict loopback names, matching Origin ports, and bracketed IPv6', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  for (const host of ['evil.localhost:3080', '[::1]:3080']) {
    const res = response()
    assert.equal(guard(loopback({ host }), res), host.startsWith('evil') ? false : true)
  }
  for (const origin of ['http://evil.localhost:3080', 'http://localhost:3081']) {
    const res = response()
    assert.equal(guard(loopback({ host: '127.0.0.1:3080', origin }), res), false)
    assert.equal(res.status, 403)
  }
  for (const origin of ['http://[::1]:3080', 'http://127.0.0.1:3080']) {
    const res = response()
    assert.equal(guard(loopback({ host: '[::1]:3080', origin }), res), true)
  }
})

test('API guard rejects a non-loopback TCP peer regardless of spoofed headers', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  // 伪造的回环 Host 与 same-origin 元数据都在，但真实对端在远端。
  const spoofed = response()
  assert.equal(
    guard({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: '192.168.1.50' } }, spoofed),
    false
  )
  assert.equal(spoofed.status, 403)
  assert.equal(spoofed.body.code, 'non_loopback_peer')
  // HTTP/1.0 风格的请求完全不带 Host 头，且对端在远端。
  const noHost = response()
  assert.equal(guard({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }, noHost), false)
  assert.equal(noHost.body.code, 'non_loopback_peer')
})

test('API guard allows loopback TCP peers including IPv6 loopback forms', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const res = response()
    assert.equal(
      guard({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, socket: { remoteAddress: addr } }, res),
      true
    )
  }
})

test('API guard fails closed when the peer address is missing or empty', () => {
  const guard = treekeeperGuard({ currentPort: () => 3080 })
  const cases = [
    { headers: { host: '127.0.0.1:3080' } }, // 完全没有 socket
    { headers: { host: '127.0.0.1:3080' }, socket: {} }, // 有 socket 但没有 remoteAddress
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '' } },
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: '   ' } },
    { headers: { host: '127.0.0.1:3080' }, socket: { remoteAddress: null } }
  ]
  for (const req of cases) {
    const res = response()
    assert.equal(guard(req, res), false)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'non_loopback_peer')
  }
})

test('API guard accepts a same-origin Origin on the default HTTP port (80)', () => {
  const guard = treekeeperGuard({ currentPort: () => 80 })
  // http://127.0.0.1 不带显式端口；WHATWG URL 会把 .port 归一为 ''，因此比较时
  // 必须回退到协议默认端口。
  const res = response()
  assert.equal(
    guard(loopback({ host: '127.0.0.1', origin: 'http://127.0.0.1' }), res),
    true
  )
  // 显式端口不一致时仍然拒绝。
  const mismatch = response()
  assert.equal(
    guard(loopback({ host: '127.0.0.1', origin: 'http://127.0.0.1:8080' }), mismatch),
    false
  )
  assert.equal(mismatch.body.code, 'foreign_origin')
})

// 宿主主目录决定本插件自己的历史写到哪里，因此按宿主使用的同一套优先级解析，
// 包括波浪号：普通 path.join() 会把它当成字面目录名。
test('resolveDshHome honours the harness precedence and never falls back to cwd', () => {
  const homeDir = '/home/dsh-user' // (pure function: the argument is never touched)

  assert.equal(resolveDshHome({ DSH_HOME: '/srv/dsh-home' }, homeDir), path.resolve('/srv/dsh-home'))
  assert.equal(resolveDshHome({ DSH_HOME: '~/elsewhere' }, homeDir), path.resolve('/home/dsh-user/elsewhere'))
  assert.equal(resolveDshHome({}, homeDir), path.resolve('/home/dsh-user/.dsh'))
  for (const blank of ['', '   ', undefined]) {
    assert.equal(resolveDshHome({ DSH_HOME: blank }, homeDir), path.resolve("/home/dsh-user/.dsh"),
      'a blank override counts as unset')
  }
})

// 宿主自己的访问器是唯一不会偏离宿主规则的答案，因此只要启动层提供了它就优先
// 使用；什么都没提供的上下文（裸嵌入的宿主、路由测试里的桩对象）属于后备情形，
// 不是故障。
test('hostDshHome prefers the host accessor and falls back without one', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = '/srv/from-env'
  try {
    let calls = 0
    const accessor = () => { calls += 1; return '/srv/from-host' }
    const hosted = { get: (name) => (name === 'dshHomePath' ? accessor : undefined) }
    assert.equal(hostDshHome(hosted), '/srv/from-host')
    assert.equal(calls, 1)

    // 没有访问器、或提供的值不是函数的上下文，其值永远不会被当成主目录。
    for (const ctx of [{}, { get: () => undefined }, { get: () => '/srv/not-a-function' }]) {
      assert.equal(hostDshHome(ctx), path.resolve('/srv/from-env'))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
