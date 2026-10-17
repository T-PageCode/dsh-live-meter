/**
 * dsh-live-meter — 宿主半边（Node 侧）
 *
 * 职责：
 *   1. 订阅 DSH 会话事件 `session/event`，从 `assistant/message` 的 usage 里聚合 token 用量
 *   2. 通过 `ctx.webServer.register()` 暴露 /dsh-live-meter/data.json 给前端轮询
 *   3. 通过 `webserver/index-inject` 把前端脚本注入页面（Web 与桌面端双通道）
 *
 * 关键工程约束（都是从 dsh-whale-widget 踩过的坑里学到的，照做不误）：
 *
 *   A) **apply() 第一件事就注册注入行**。桌面端的注入表是宿主**启动时一次性收集**的
 *      （`collectIndexInjections()` → IPC → 渲染层），订阅晚于那次收集就永远进不了表，
 *      表现是"桌面端完全不出现且无法稳定复现"。
 *   B) **必须用 webserver/index-inject，不能用 tapIndex**。桌面壳的 index.html 从安装包
 *      静态 dist 直读（`dsh-app://app/`），函数变换永远过不去。
 *   C) **推送内联 `script` 行，不推 `script-src` 行**。页面侧解释器对两者处理不对称：
 *        case "script":      createElement + textContent + append（无 await，不可能失败）
 *        case "script-src":  await loadScript(src)（失败即 reject，而那个 reject 会 reject 掉
 *                            __DSH_BOOT_READY__ ⇒ **整个应用起不来**）
 *      所以由我们自己建 <script src> 并**吞掉 onerror**：路由在就正常加载，路由不在就静默失败。
 *   D) **绝不用对象级 `inject: [...]`**。它会把整个 apply() 推迟到服务就绪之后，也就错过了 (A)
 *      的一次性收集窗口。改成 apply() 立刻执行，把需要服务的逻辑放进局部 root.inject()。
 *   E) **可选服务绝不能写进 inject**（如 deepseekAccount）。老宿主没有该服务时，整个插件会
 *      永远等不到服务而**完全不 apply** —— 比"少一个功能"严重得多。用 ctx.get() 读。
 *
 * 数据口径（重要）：
 *   DSH 保证 reasoningTokens ⊆ outputTokens，所以 reasoning **不能再单独累加**，
 *   否则输出侧按输出价重复计费、数字偏高约一倍。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createMeter, parseBalance } from './meter.js'

// ---------------------------------------------------------------- 常量

// ⚠️ 不要把这些名字改回 token-meter / tokenMeter：DSH 宿主内置了这两个名字
//    （app.asar 里各出现 7 处 / 3 处）。占用它会顶掉内置的 tokenMeter 服务，
//    使核心压缩链路永远等不到它就绪（compaction-basic / command-compact /
//    tool-result-pruner 全在 waiting），表现为会话恢复失败、发不出消息。
//    详见 cordis.patch.yml 顶部注释。
const HOST_ID = 'live-meter'
const ROUTE_DATA = '/dsh-live-meter/data.json'
const ROUTE_JS = '/dsh-live-meter/client.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_JS_PATH = path.join(PACKAGE_ROOT, 'lib', 'client.js')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STORE_PATH = path.join(DSH_HOME, '.dsh-live-meter.json')

const BALANCE_TTL_MS = 60 * 1000   // 余额缓存：60 秒内不重复请求
const SAVE_DEBOUNCE_MS = 1500      // 落盘节流
const KEEP_DAYS = 30               // 日聚合保留天数

/** 桌面端内联注入行：自己建标签 + 吞掉 onerror，路由不在也不影响宿主启动（见约束 C） */
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + ROUTE_JS + '";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

const INDEX_TAG = '<script defer src="' + ROUTE_JS + '"></script>'

// ---------------------------------------------------------------- 工具

/** 只接受本机来源；写操作额外要求自定义头（简单跨站请求带不上） */
function isLocal(req) {
  try {
    const ra = req.socket && req.socket.remoteAddress
    if (!ra) return false
    return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
  } catch (err) { return false }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}


// ---------------------------------------------------------------- 插件

export default {
  name: 'dsh-live-meter',

  // ⚠️ 有意不写对象级 inject（约束 D）。apply() 必须立刻跑，才能赶上桌面端启动时
  //    一次性收集注入表的那个窗口。
  apply(root) {
    const meter = createMeter()
    let lastSaved = 0
    let saveTimer = null
    let balanceCache = { at: 0, value: null, error: '' }
    const disposers = []

    // ---------- 持久化 ----------
    function loadFromDisk() {
      try {
        if (!fs.existsSync(STORE_PATH)) return
        const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
        meter.restore(raw)
      } catch (err) { /* 坏文件忽略 */ }
    }

    function saveNow() {
      try {
        const tmp = STORE_PATH + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(meter.serialize()), 'utf8')
        fs.renameSync(tmp, STORE_PATH)
        lastSaved = Date.now()
      } catch (err) { /* 写盘失败不影响功能 */ }
    }

    function scheduleSave() {
      if (saveTimer) return
      saveTimer = setTimeout(() => {
        saveTimer = null
        meter.prune()
        saveNow()
      }, SAVE_DEBOUNCE_MS)
    }

    loadFromDisk()

    // ---------- ① 注入行：apply() 里第一件事（约束 A / B / C）----------
    try {
      disposers.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === ROUTE_JS) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(ROUTE_JS) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
        } catch (err) { /* 注入失败不该影响宿主 */ }
      }))
    } catch (err) { /* 老宿主没有这个事件，忽略 */ }

    // ---------- ② 需要服务的部分：局部等待，不阻塞 ① ----------
    root.inject(['webServer'], (ctx) => {
      // 事件订阅
      // ⚠️ `session/event` 的第一个参数是**会话对象**，不是 id 字符串。
      //    早先按字符串处理，结果 sessionId 变成 "[object Object]"（实测踩到）。
      //    这里兼容两种形态：对象取 .id，字符串直接用。
      function sidOf(session, fallback) {
        try {
          if (typeof session === 'string') return session
          if (session && typeof session.id === 'string' && session.id) return session.id
          if (session && session.id != null) return String(session.id)
        } catch (err) { /* 忽略 */ }
        return fallback || 'unknown'
      }

      try {
        disposers.push(ctx.on('session/event', (session, event) => {
          const sid = sidOf(session, event && event.sessionId)
          if (meter.ingest(sid, event)) scheduleSave()
        }))
      } catch (err) { /* 订阅失败则只显示余额 */ }

      try {
        disposers.push(ctx.on('session/disposed', (session) => {
          try {
            const sid = sidOf(session)
            const s = meter.sessions.get(sid)
            if (s) { s.lastAt = Date.now(); s.turnSeen = {} }
            scheduleSave()
          } catch (err) {}
        }))
      } catch (err) {}

      // 余额：可选服务，绝不能进 inject（约束 E）
      //
      // ⚠️ `getBalance` **必须传 AccountClientMetadata**，否则内部读 client.version 会抛
      //    "Cannot read properties of undefined (reading 'version')"（实测踩到）。
      //    DSH 的接口声明：
      //      interface AccountClientMetadata {
      //        readonly version: string
      //        readonly locale: string
      //        readonly timezoneOffsetSeconds: number
      //      }
      //    timezoneOffsetSeconds 约定「东为正的整秒」。
      //    返回 null 表示"未登录 / 没有 grant"，属于正常降级，不是错误。
      function accountClientMeta() {
        let version = ''
        try {
          version = String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown'
        } catch (err) { version = 'unknown' }
        let locale = ''
        try { locale = String(process.env.DSH_LOCALE || '') || 'zh_CN' } catch (err) { locale = 'zh_CN' }
        let tz = 0
        try { tz = -new Date().getTimezoneOffset() * 60 } catch (err) { tz = 0 }
        return { version, locale, timezoneOffsetSeconds: tz }
      }

      async function readBalance() {
        const now = Date.now()
        // 只在**成功**时用缓存；失败不缓存，否则会把一次瞬时故障锁死 60 秒
        if (balanceCache.value && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache
        let account = null
        try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch (err) { account = null }
        if (!account) {
          balanceCache = { at: now, value: null, error: 'no-service', detail: 'ctx.get("deepseekAccount") 返回空（宿主无此服务）' }
          return balanceCache
        }
        if (typeof account.getBalance !== 'function') {
          balanceCache = { at: now, value: null, error: 'no-method', detail: 'deepseekAccount 上没有 getBalance 方法' }
          return balanceCache
        }
        try {
          // ⚠️ 必须传 client 元数据，见上方注释
          const r = await account.getBalance(accountClientMeta())

          // null 表示未登录 / 没有 grant —— 正常降级，不是错误
          if (r == null) {
            balanceCache = { at: now, value: null, error: 'not-signed-in', detail: '未登录 DeepSeek 账号（没有账号凭据）' }
            return balanceCache
          }

          // ---- 解析余额 ----
          // 解析逻辑抽在 meter.js 的 parseBalance() 里（可单测）。
          // 实测 DSH 0.2.0-rc.2 的返回结构见该函数注释。
          const parsed = parseBalance(r)

          if (!parsed.ok) {
            // 记录返回体形状，便于兼容宿主改版后的字段名
            let shape = ''
            try { shape = JSON.stringify(r).slice(0, 400) } catch (e) { shape = String(r).slice(0, 400) }
            balanceCache = { at: now, value: null, error: 'empty', detail: '返回体里没找到余额字段；原始返回: ' + shape }
          } else {
            balanceCache = {
              at: now,
              value: {
                currency: parsed.currency,
                total: parsed.total,
                granted: parsed.granted,
                toppedUp: parsed.toppedUp,
                available: r && r.is_available !== undefined ? !!r.is_available : true
              },
              error: ''
            }
          }
        } catch (err) {
          // ⚠️ 一定要把真实原因带出来：之前只回 'error'，线上完全无法定位。
          const msg = (err && (err.message || err.code)) ? String(err.message || err.code) : String(err)
          balanceCache = { at: now, value: null, error: 'error', detail: msg.slice(0, 300) }
        }
        return balanceCache
      }

      // ---------- 路由 ----------
      function register(route) {
        try { disposers.push(ctx.webServer.register(route)) } catch (err) {}
      }

      register({
        kind: 'exact',
        path: ROUTE_DATA,
        handler: async (req, res) => {
          if (!isLocal(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
          let balance = { available: false, error: '' }
          try {
            const b = await readBalance()
            if (b.value) balance = { available: true, error: '', ...b.value }
            else balance = { available: false, error: b.error || 'unavailable', detail: b.detail || '' }
          } catch (err) {
            const msg = (err && err.message) ? String(err.message) : String(err)
            balance = { available: false, error: 'error', detail: msg.slice(0, 300) }
          }

          const act = meter.activeSession()
          const t = meter.today()
          sendJson(res, 200, {
            ok: true,
            at: Date.now(),
            today: { input: t.input, cache: t.cache, output: t.output, turns: t.turns },
            session: act
              ? {
                  id: act.id,
                  input: act.input, cache: act.cache, output: act.output, turns: act.turns,
                  startedAt: act.startedAt, lastAt: act.lastAt
                }
              : null,
            recent: meter.recentDays(7),
            balance,
            totals: {
              sessions: meter.sessions.size,
              days: meter.days.size
            }
          })
        }
      })

      register({
        kind: 'exact',
        path: ROUTE_JS,
        handler: (req, res) => {
          if (!isLocal(req)) { res.writeHead(403); res.end(); return }
          let js = ''
          try { js = fs.readFileSync(CLIENT_JS_PATH, 'utf8') } catch (err) { js = '' }
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
          })
          res.end(js)
        }
      })

      // Web 形态的注入通道（桌面端走 ① 的结构化行，两条并存、各自去重）
      try {
        if (typeof ctx.webServer.tapIndex === 'function') {
          disposers.push(ctx.webServer.tapIndex((html) => {
            if (typeof html !== 'string') return html
            if (html.indexOf(ROUTE_JS) !== -1) return html
            if (html.indexOf('</body>') !== -1) return html.replace('</body>', INDEX_TAG + '</body>')
            return html + INDEX_TAG
          }))
        }
      } catch (err) {}

      // 卸载：清定时器 + 落盘
      root.effect(() => () => {
        try { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null } } catch (err) {}
        try { meter.prune(); saveNow() } catch (err) {}
        for (const d of disposers) { try { if (typeof d === 'function') d() } catch (err) {} }
      })
    })
  }
}