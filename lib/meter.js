/**
 * dsh-live-meter — 纯聚合逻辑（无 I/O、无 DSH 依赖，可独立单测）
 *
 * 数据口径（重要）：
 *   DSH 保证 reasoningTokens ⊆ outputTokens（dsh 的校验：reasoning > output 即判非法），
 *   所以 reasoning **不能再单独累加** —— 否则输出侧被重复计入，数字偏高约一倍。
 *   本模块只取 inputTokens / cacheReadTokens / outputTokens 三个口径。
 */

/** 安全取正数，NaN/负数/非数字一律归 0 */
export function num(x) {
  const n = Number(x)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 本地日期键 'YYYY-MM-DD' */
export function dayKey(ts) {
  const d = new Date(ts == null ? Date.now() : ts)
  const p = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 一条 usage 的三个口径 → 增量对象 */
export function usageToDelta(usage) {
  return {
    input: num(usage && usage.inputTokens),
    cache: num(usage && usage.cacheReadTokens),
    output: num(usage && usage.outputTokens),
    turns: 1
  }
}

export function isZeroDelta(d) {
  return !d || (d.input === 0 && d.cache === 0 && d.output === 0)
}

export function total(d) {
  if (!d) return 0
  return (d.input || 0) + (d.cache || 0) + (d.output || 0)
}

/**
 * 创建计量器。所有可变状态闭在内部。
 * @param {{ keepDays?: number, maxSessions?: number }} opts
 */
export function createMeter(opts) {
  const keepDays = (opts && opts.keepDays) || 30
  const maxSessions = (opts && opts.maxSessions) || 50

  const sessions = new Map()
  const days = new Map()

  function blank() {
    return { input: 0, cache: 0, output: 0, turns: 0, models: {} }
  }

  /** 会话表裁剪：只保留最近活跃的 maxSessions 个 */
  function capSessions() {
    if (sessions.size <= maxSessions) return
    const sorted = [...sessions.entries()].sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0))
    for (const [k] of sorted.slice(maxSessions)) sessions.delete(k)
  }

  function dayOf(ts) {
    const k = dayKey(ts)
    let d = days.get(k)
    if (!d) { d = blank(); days.set(k, d) }
    return d
  }

  function addTo(target, add, model) {
    target.input += add.input
    target.cache += add.cache
    target.output += add.output
    target.turns += add.turns
    if (model) {
      const m = target.models[model] || (target.models[model] = { input: 0, cache: 0, output: 0, turns: 0 })
      m.input += add.input
      m.cache += add.cache
      m.output += add.output
      m.turns += add.turns
    }
  }

  return {
    sessions,
    days,

    /**
     * 吃一条会话事件。返回 true 表示产生了新的用量（供调用方决定是否落盘）。
     * @param {string} sid 会话 id
     * @param {{type?:string,data?:object}} event
     */
    ingest(sid, event) {
      try {
        if (!event || typeof event !== 'object') return false
        const type = event.type
        const d = event.data
        if (!d || typeof d !== 'object') return false

        // 一轮结束：清该会话的去重集合，标记活跃时间
        if (type === 'turn/end') {
          const s = sessions.get(sid)
          if (s) { s.lastAt = Date.now(); s.turnSeen = {} }
          return false
        }

        if (type !== 'assistant/message') return false

        const usage = d.usage
        if (!usage || typeof usage !== 'object') return false

        // ⚠️ 先算增量、先判空，**再**建会话：
        //    否则一个全零 usage 的噪声事件就会往会话表里塞一条空记录。
        const delta = usageToDelta(usage)
        if (isZeroDelta(delta)) return false

        // 同轮去重：turnSeen 只在**有效增量**之后才标记，
        // 这样"先来一条全零、后来一条有值"的同一轮不会被误判成重复而丢掉。
        const turn = Number(d.turn)

        let s = sessions.get(sid)
        if (!s) {
          s = Object.assign(blank(), { startedAt: Date.now(), lastAt: Date.now(), turnSeen: {} })
          sessions.set(sid, s)
          capSessions()   // 新会话入表即裁剪，不依赖外部调用 prune()
        } else {
          if (Number.isFinite(turn) && s.turnSeen[turn]) return false
          // 活跃度重排：把该会话移到 Map 末尾，使插入顺序 == 活跃顺序
          sessions.delete(sid)
          sessions.set(sid, s)
        }
        if (Number.isFinite(turn)) {
          s.turnSeen[turn] = 1
          if (Object.keys(s.turnSeen).length > 200) s.turnSeen = {}
        }

        const model = (d.message && d.message.source && d.message.source.model) || ''
        addTo(s, delta, model)
        s.lastAt = Date.now()
        addTo(dayOf(Date.now()), delta, model)
        return true
      } catch (err) {
        return false
      }
    },

    /** 最近有事件的那个会话 */
    activeSession() {
      let best = null, bestId = null
      for (const [id, s] of sessions) {
        if (!best || (s.lastAt || 0) > (best.lastAt || 0)) { best = s; bestId = id }
      }
      return best ? Object.assign({ id: bestId }, best) : null
    },

    today() {
      const d = days.get(dayKey())
      return d ? { input: d.input, cache: d.cache, output: d.output, turns: d.turns, models: d.models } : blank()
    },

    /** 近 n 天的按日汇总（含 0 值占位，方便画图） */
    recentDays(n) {
      const out = []
      const now = new Date()
      for (let i = n - 1; i >= 0; i--) {
        const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        const k = dayKey(dt.getTime())
        const d = days.get(k)
        out.push({
          day: k,
          input: d ? d.input : 0,
          cache: d ? d.cache : 0,
          output: d ? d.output : 0,
          turns: d ? d.turns : 0
        })
      }
      return out
    },

    /** 清理过期日聚合与最久未用的会话 */
    prune(nowTs) {
      const now = nowTs == null ? Date.now() : nowTs
      const cutoff = now - keepDays * 86400 * 1000
      for (const k of [...days.keys()]) {
        const parts = k.split('-').map(Number)
        const t = new Date(parts[0], parts[1] - 1, parts[2]).getTime()
        if (Number.isFinite(t) && t < cutoff) days.delete(k)
      }
      if (sessions.size > maxSessions) {
        capSessions()
      }
    },

    serialize() {
      const sess = {}
      for (const [k, s] of sessions) {
        sess[k] = {
          input: s.input, cache: s.cache, output: s.output, turns: s.turns,
          models: s.models, startedAt: s.startedAt, lastAt: s.lastAt
        }
      }
      return { v: 1, days: Object.fromEntries(days), sessions: sess }
    },

    restore(raw) {
      try {
        if (!raw || typeof raw !== 'object') return
        days.clear()
        sessions.clear()
        if (raw.days && typeof raw.days === 'object') {
          for (const [k, v] of Object.entries(raw.days)) {
            const d = blank()
            d.input = num(v.input); d.cache = num(v.cache); d.output = num(v.output); d.turns = num(v.turns)
            if (v.models && typeof v.models === 'object') d.models = v.models
            days.set(k, d)
          }
        }
        if (raw.sessions && typeof raw.sessions === 'object') {
          for (const [k, v] of Object.entries(raw.sessions)) {
            const s = blank()
            s.input = num(v.input); s.cache = num(v.cache); s.output = num(v.output); s.turns = num(v.turns)
            if (v.models && typeof v.models === 'object') s.models = v.models
            s.lastAt = num(v.lastAt) || Date.now()
            s.startedAt = num(v.startedAt) || s.lastAt
            s.turnSeen = {}
            sessions.set(k, s)
          }
        }
      } catch (err) { /* 坏数据不致命 */ }
    }
  }
}

/**
 * 解析 deepseekAccount.getBalance() 的返回体。
 *
 * 实测（DSH 0.2.0-rc.2）结构：
 *   { status: "ready",
 *     value:        [{ currency: "CNY", balance: "47.1691495600000000" }],   // 充值钱包
 *     bonusWallets: [{ currency: "CNY", balance: "0" }] }                    // 赠金钱包
 * 要点：字段名是 `balance`（字符串高精度小数），钱包数组叫 `value`，
 *       赠金在 `bonusWallets`，两者金额**相加**才是显示总额。
 * 同时兼容 balance_infos/total_balance 形态（宿主改版时不会立刻失效）。
 *
 * @returns {{ok:true, currency:string, total:number, granted:number|null, toppedUp:number|null}
 *          | {ok:false, reason:'null'|'unparsable'}}
 */
export function parseBalance(r) {
  if (r == null) return { ok: false, reason: 'null' }

  const numOf = (x) => {
    if (x == null) return NaN
    const n = Number(x)
    return Number.isFinite(n) ? n : NaN
  }
  const pickFrom = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null
    return arr.find((x) => x && String(x.currency).toUpperCase() === 'CNY' && Number.isFinite(numOf(x.balance)))
      || arr.find((x) => x && Number.isFinite(numOf(x.balance)))
      || null
  }

  let currency = 'CNY'
  let total = NaN
  let granted = null
  let toppedUp = null

  // 充值/主钱包
  const main = pickFrom(r.value) || pickFrom(r.balance_infos) || pickFrom(Array.isArray(r) ? r : null)
  if (main) {
    currency = main.currency || 'CNY'
    toppedUp = numOf(main.balance)
    total = toppedUp
  }
  // 赠金
  const bonus = pickFrom(r.bonusWallets)
  if (bonus) {
    granted = numOf(bonus.balance)
    if (!Number.isFinite(total)) { total = granted; currency = bonus.currency || currency }
    else total += granted
  }
  // 兜底：单对象形态
  if (!Number.isFinite(total) && r.total_balance !== undefined) {
    total = numOf(r.total_balance)
    granted = r.granted_balance !== undefined ? numOf(r.granted_balance) : null
    toppedUp = r.topped_up_balance !== undefined ? numOf(r.topped_up_balance) : null
    currency = r.currency || currency
  }

  if (!Number.isFinite(total)) return { ok: false, reason: 'unparsable' }
  return {
    ok: true,
    currency,
    total,
    granted: Number.isFinite(granted) ? granted : null,
    toppedUp: Number.isFinite(toppedUp) ? toppedUp : null
  }
}
