/**
 * dsh-live-meter — 浏览器半边
 *
 * 由宿主通过 <script src="/dsh-live-meter/client.js"> 注入（Web 用 tapIndex，
 * 桌面端用 webserver/index-inject 的内联行）。**不依赖 React / DSH 客户端模块**，
 * 因此对宿主版本变化免疫 —— 这是刻意的选择：数据全部来自宿主的 JSON 路由。
 *
 * 显示：右下角悬浮面板，实时轮询输入/输出/缓存 token、余额、速率、迷你趋势图。
 */

(function () {
  'use strict'

  if (window.__DSH_LIVE_METER__) return
  window.__DSH_LIVE_METER__ = true

  var ENDPOINT = '/dsh-live-meter/data.json'
  var LS_KEY = 'dsh-live-meter.v1'
  var POLL_MS = 2000

  // ---------------------------------------------------------------- 状态

  var prefs = {
    open: true,
    x: null,          // null = 用默认右下角定位
    y: null,
    collapsed: false,
    compact: false    // 紧凑模式：只显示总计
  }
  try {
    var raw = localStorage.getItem(LS_KEY)
    if (raw) prefs = Object.assign(prefs, JSON.parse(raw))
  } catch (e) { /* 忽略坏数据 */ }

  function savePrefs() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)) } catch (e) {}
  }

  var data = null            // 最近一次 /data.json
  var lastFetchOk = false
  var prevOutput = 0         // 用于算速率
  var prevAt = 0
  var rate = 0               // tokens / 分钟
  var peakRate = 0

  // ---------------------------------------------------------------- 工具

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function fmt(n) {
    n = Number(n) || 0
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'
    return String(Math.round(n))
  }

  function fmtFull(n) {
    try { return (Number(n) || 0).toLocaleString('zh-CN') } catch (e) { return String(n) }
  }

  function fmtMoney(n, cur) {
    if (n == null || !isFinite(n)) return '—'
    var sym = cur === 'USD' ? '$' : '¥'
    return sym + Number(n).toFixed(2)
  }

  function fmtDur(ms) {
    if (!ms || ms < 0) return '—'
    var s = Math.floor(ms / 1000)
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '')
    var h = Math.floor(m / 60)
    return h + 'h' + (m % 60) + 'm'
  }

  // ---------------------------------------------------------------- 样式

  var CSS = [
    '#dsh-tm{position:fixed;z-index:2147483000;right:18px;bottom:18px;width:242px;',
    'font:12px/1.5 "Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
    'color:var(--dsw-alias-label-primary,#1b202b);background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 82%,transparent);',
    'border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:14px;',
    'box-shadow:0 10px 30px rgba(0,0,0,.18);backdrop-filter:blur(14px) saturate(150%);',
    '-webkit-backdrop-filter:blur(14px) saturate(150%);user-select:none;overflow:hidden;',
    'transition:opacity .18s,transform .18s}',
    '#dsh-tm.dsh-tm-hide{opacity:0;transform:translateY(8px);pointer-events:none}',
    '#dsh-tm .tm-head{display:flex;align-items:center;gap:7px;padding:8px 10px;cursor:grab;',
    'border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}',
    '#dsh-tm .tm-head:active{cursor:grabbing}',
    '#dsh-tm .tm-dot{width:7px;height:7px;border-radius:50%;background:#94a3b8;flex:none}',
    '#dsh-tm.live .tm-dot{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.22)}',
    '#dsh-tm.err .tm-dot{background:#ef4444}',
    '#dsh-tm .tm-title{flex:1;font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#dsh-tm .tm-btn{width:22px;height:22px;border-radius:6px;display:grid;place-items:center;',
    'cursor:pointer;opacity:.6;font-size:12px;flex:none}',
    '#dsh-tm .tm-btn:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
    '#dsh-tm .tm-body{padding:9px 10px 10px}',
    '#dsh-tm.collapsed .tm-body{display:none}',
    '#dsh-tm .tm-sec{font-size:10px;letter-spacing:.6px;opacity:.55;margin:0 0 5px;text-transform:uppercase}',
    '#dsh-tm .tm-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:9px}',
    '#dsh-tm .tm-cell{background:color-mix(in srgb,currentColor 7%,transparent);border-radius:8px;padding:5px 7px}',
    '#dsh-tm .tm-cell .k{font-size:10px;opacity:.6;white-space:nowrap}',
    '#dsh-tm .tm-cell .v{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.25}',
    '#dsh-tm .tm-row{display:flex;justify-content:space-between;gap:8px;padding:3px 0;font-size:11.5px}',
    '#dsh-tm .tm-row .k{opacity:.6}',
    '#dsh-tm .tm-row .v{font-variant-numeric:tabular-nums;font-weight:600}',
    '#dsh-tm .tm-bal{display:flex;align-items:baseline;justify-content:space-between;gap:8px;',
    'margin-top:7px;padding:6px 8px;border-radius:8px;background:color-mix(in srgb,currentColor 7%,transparent)}',
    '#dsh-tm .tm-bal .k{font-size:10.5px;opacity:.62}',
    '#dsh-tm .tm-bal .v{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}',
    '#dsh-tm .tm-bal.warn .v{color:#f59e0b}',
    '#dsh-tm .tm-bal.bad .v{color:#ef4444}',
    '#dsh-tm .tm-spark{display:flex;align-items:flex-end;gap:2px;height:22px;margin-top:8px}',
    '#dsh-tm .tm-spark i{flex:1;background:color-mix(in srgb,#4c6ef5 65%,transparent);border-radius:2px;min-height:2px}',
    '#dsh-tm .tm-spark i.today{background:#4c6ef5}',
    '#dsh-tm .tm-foot{margin-top:7px;font-size:10px;opacity:.5;display:flex;justify-content:space-between;gap:6px}',
    '#dsh-tm .tm-err{font-size:11px;opacity:.75;padding:2px 0}'
  ].join('')

  var style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  // ---------------------------------------------------------------- DOM

  var root = el('div')
  root.id = 'dsh-tm'

  var head = el('div', 'tm-head')
  var dot = el('span', 'tm-dot')
  var title = el('span', 'tm-title', 'Token 计量')
  var btnCompact = el('span', 'tm-btn', '⇔')
  btnCompact.title = '紧凑 / 完整'
  var btnFold = el('span', 'tm-btn', '−')
  btnFold.title = '折叠'
  head.appendChild(dot); head.appendChild(title); head.appendChild(btnCompact); head.appendChild(btnFold)

  var body = el('div', 'tm-body')

  // 本轮 / 本次会话
  var secSession = el('div', 'tm-sec', '本次会话')
  var grid = el('div', 'tm-grid')
  var cIn = cell('输入')
  var cOut = cell('输出')
  var cCache = cell('缓存读')
  var cTotal = cell('合计')
  function cell(k) {
    var c = el('div', 'tm-cell')
    c.appendChild(el('div', 'k', k))
    var v = el('div', 'v', '0')
    c.appendChild(v)
    c._v = v
    return c
  }
  grid.appendChild(cIn); grid.appendChild(cOut); grid.appendChild(cCache); grid.appendChild(cTotal)

  var rowRate = row('速率', '—')
  var rowTurns = row('轮次', '0')
  var rowAvg = row('平均每轮', '—')
  var rowDur = row('会话时长', '—')
  function row(k, v) {
    var r = el('div', 'tm-row')
    r.appendChild(el('span', 'k', k))
    var vv = el('span', 'v', v)
    r.appendChild(vv)
    r._v = vv
    return r
  }

  var secToday = el('div', 'tm-sec', '今日累计')
  secToday.style.marginTop = '9px'
  var rowTodayIn = row('输入 / 输出', '0 / 0')
  var rowTodayCache = row('缓存读', '0')
  var rowTodayTotal = row('合计', '0')

  var spark = el('div', 'tm-spark')
  var bal = el('div', 'tm-bal')
  bal.appendChild(el('span', 'k', '账户余额'))
  var balV = el('span', 'v', '—')
  bal.appendChild(balV)

  var foot = el('div', 'tm-foot')
  var footLeft = el('span', null, '—')
  var footRight = el('span', null, '2s')
  foot.appendChild(footLeft); foot.appendChild(footRight)

  body.appendChild(secSession); body.appendChild(grid)
  body.appendChild(rowRate); body.appendChild(rowTurns); body.appendChild(rowAvg); body.appendChild(rowDur)
  body.appendChild(secToday); body.appendChild(rowTodayIn); body.appendChild(rowTodayCache); body.appendChild(rowTodayTotal)
  body.appendChild(spark); body.appendChild(bal); body.appendChild(foot)

  root.appendChild(head); root.appendChild(body)

  function mount() {
    var host = document.body || document.documentElement
    if (host && !root.parentNode) host.appendChild(root)
    applyPrefs()
  }

  function applyPrefs() {
    root.classList.toggle('collapsed', !!prefs.collapsed)
    btnFold.textContent = prefs.collapsed ? '+' : '−'
    if (prefs.x != null && prefs.y != null) {
      root.style.left = prefs.x + 'px'
      root.style.top = prefs.y + 'px'
      root.style.right = 'auto'
      root.style.bottom = 'auto'
    } else {
      root.style.left = 'auto'
      root.style.top = 'auto'
      root.style.right = '18px'
      root.style.bottom = '18px'
    }
    if (prefs.compact) {
      secToday.style.display = 'none'
      rowTodayIn.style.display = 'none'
      rowTodayCache.style.display = 'none'
      rowTodayTotal.style.display = 'none'
      spark.style.display = 'none'
    } else {
      secToday.style.display = ''
      rowTodayIn.style.display = ''
      rowTodayCache.style.display = ''
      rowTodayTotal.style.display = ''
      spark.style.display = ''
    }
  }

  // ---------------------------------------------------------------- 交互

  btnFold.addEventListener('click', function (e) {
    e.stopPropagation()
    prefs.collapsed = !prefs.collapsed
    savePrefs(); applyPrefs()
  })
  btnCompact.addEventListener('click', function (e) {
    e.stopPropagation()
    prefs.compact = !prefs.compact
    savePrefs(); applyPrefs()
  })

  // 拖拽（指针事件，pointer capture 防止拖出窗口丢事件）
  ;(function enableDrag() {
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0
    head.addEventListener('pointerdown', function (e) {
      if (e.target === btnFold || e.target === btnCompact) return
      var r = root.getBoundingClientRect()
      dragging = true
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top
      root.style.right = 'auto'; root.style.bottom = 'auto'
      root.style.left = ox + 'px'; root.style.top = oy + 'px'
      try { head.setPointerCapture(e.pointerId) } catch (err) {}
      e.preventDefault()
    })
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return
      var w = root.offsetWidth, h = root.offsetHeight
      var nx = Math.max(4, Math.min(window.innerWidth - w - 4, ox + (e.clientX - sx)))
      var ny = Math.max(4, Math.min(window.innerHeight - h - 4, oy + (e.clientY - sy)))
      root.style.left = nx + 'px'
      root.style.top = ny + 'px'
      prefs.x = nx; prefs.y = ny
    })
    function end(e) {
      if (!dragging) return
      dragging = false
      try { head.releasePointerCapture(e.pointerId) } catch (err) {}
      savePrefs()
    }
    head.addEventListener('pointerup', end)
    head.addEventListener('pointercancel', end)
  })()

  window.addEventListener('resize', function () {
    if (prefs.x == null) return
    var w = root.offsetWidth, h = root.offsetHeight
    prefs.x = Math.max(4, Math.min(window.innerWidth - w - 4, prefs.x))
    prefs.y = Math.max(4, Math.min(window.innerHeight - h - 4, prefs.y))
    applyPrefs()
  })

  // ---------------------------------------------------------------- 渲染

  function renderSpark() {
    spark.textContent = ''
    var recent = (data && data.recent) || []
    if (!recent.length) return
    var max = 1
    recent.forEach(function (d) {
      var t = (d.input || 0) + (d.cache || 0) + (d.output || 0)
      if (t > max) max = t
    })
    recent.forEach(function (d, i) {
      var t = (d.input || 0) + (d.cache || 0) + (d.output || 0)
      var b = el('i', i === recent.length - 1 ? 'today' : null)
      b.style.height = (t === 0 ? 2 : Math.max(3, Math.round((t / max) * 22))) + 'px'
      b.title = d.day + '：' + fmtFull(t) + ' tokens / ' + (d.turns || 0) + ' 轮'
      spark.appendChild(b)
    })
  }

  function render() {
    if (!data) return
    var s = data.session || { input: 0, cache: 0, output: 0, turns: 0 }
    var t = data.today || { input: 0, cache: 0, output: 0, turns: 0 }

    cIn._v.textContent = fmt(s.input)
    cIn._v.title = fmtFull(s.input)
    cOut._v.textContent = fmt(s.output)
    cOut._v.title = fmtFull(s.output)
    cCache._v.textContent = fmt(s.cache)
    cCache._v.title = fmtFull(s.cache)
    var sTotal = (s.input || 0) + (s.cache || 0) + (s.output || 0)
    cTotal._v.textContent = fmt(sTotal)
    cTotal._v.title = fmtFull(sTotal)

    rowRate._v.textContent = rate > 0 ? (fmt(rate) + ' /min') : '—'
    rowTurns._v.textContent = String(s.turns || 0)
    rowAvg._v.textContent = s.turns > 0 ? fmt(Math.round(sTotal / s.turns)) : '—'
    rowDur._v.textContent = s.startedAt ? fmtDur(Date.now() - s.startedAt) : '—'

    rowTodayIn._v.textContent = fmt(t.input) + ' / ' + fmt(t.output)
    rowTodayCache._v.textContent = fmt(t.cache)
    var tTotal = (t.input || 0) + (t.cache || 0) + (t.output || 0)
    rowTodayTotal._v.textContent = fmt(tTotal)

    var b = data.balance || {}
    if (b.available) {
      balV.textContent = fmtMoney(b.total, b.currency)
      bal.classList.remove('bad')
      bal.classList.toggle('warn', Number(b.total) > 0 && Number(b.total) < 10)
      bal.title = '余额读取正常'
      if (b.granted != null || b.toppedUp != null) {
        bal.title = '赠金 ' + fmtMoney(b.granted, b.currency) + ' · 充值 ' + fmtMoney(b.toppedUp, b.currency)
      }
    } else {
      var label = '读取失败'
      if (b.error === 'not-signed-in') label = '未登录'
      else if (b.error === 'no-service') label = '无账号服务'
      else if (b.error === 'no-method') label = '不支持'
      else if (b.error === 'empty') label = '无数据'
      balV.textContent = label
      bal.classList.remove('warn')
      // "未登录"是正常状态，不该标红；只有真出错才标红
      bal.classList.toggle('bad', b.error === 'error')
      // 把宿主的真实失败原因放进悬停提示，便于定位
      bal.title = (b.error || '') + (b.detail ? ('\n' + b.detail) : '')
    }

    renderSpark()
    footLeft.textContent = '更新 ' + new Date(data.at).toLocaleTimeString('zh-CN', { hour12: false })

    // 活跃状态：最近 20 秒内有事件
    var live = s.lastAt && (Date.now() - s.lastAt < 20000)
    root.classList.toggle('live', !!live)
    title.textContent = live ? 'Token 计量 · 活跃' : 'Token 计量'
  }

  function setError(msg) {
    root.classList.add('err')
    root.classList.remove('live')
    title.textContent = 'Token 计量 · 连接失败'
    footLeft.textContent = msg || '无法连接宿主'
  }

  // ---------------------------------------------------------------- 轮询

  var inFlight = false
  var failCount = 0

  function tick() {
    if (inFlight) return
    inFlight = true
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    var timer = setTimeout(function () { if (ctrl) ctrl.abort() }, 4000)

    fetch(ENDPOINT, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (j) {
        clearTimeout(timer)
        if (!j || !j.ok) throw new Error('bad payload')

        // 速率：用输出 token 的增量估算（输出是"新生成"的部分，最能反映节奏）
        var outNow = (j.session && j.session.output) || 0
        var atNow = j.at || Date.now()
        if (prevAt && atNow > prevAt) {
          var dOut = outNow - prevOutput
          if (dOut > 0) {
            var inst = dOut / ((atNow - prevAt) / 60000)
            // 指数平滑，避免抖动
            rate = rate ? (rate * 0.55 + inst * 0.45) : inst
            if (rate > peakRate) peakRate = rate
          } else if (atNow - prevAt > 30000) {
            rate = 0
          }
        }
        prevOutput = outNow; prevAt = atNow

        data = j
        failCount = 0
        lastFetchOk = true
        root.classList.remove('err')
        render()
      })
      .catch(function (err) {
        clearTimeout(timer)
        failCount++
        if (failCount >= 3) setError(err && err.name === 'AbortError' ? '请求超时' : '无法连接宿主')
      })
      .then(function () { inFlight = false })
  }

  // ---------------------------------------------------------------- 启动

  function boot() {
    mount()
    tick()
    setInterval(tick, POLL_MS)
    // 页面从后台回来时立刻刷一次
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) tick()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
