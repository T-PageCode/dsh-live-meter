/**
 * dsh-live-meter 聚合逻辑测试（纯 Node，无依赖）
 * 运行： node dsh-live-meter/test/meter.test.mjs
 */
import {
  createMeter, num, dayKey, usageToDelta, isZeroDelta, total, parseBalance
} from '../lib/meter.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name) }
  else { fail++; console.log('FAIL  ' + name + (extra ? '   → ' + extra : '')) }
}
function eq(name, got, want) {
  ok(name, got === want, '得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want))
}

// ---------------------------------------------------------------- 基础工具

console.log('--- 基础工具 ---')
eq('num(5)', num(5), 5)
eq('num(-3) 归零', num(-3), 0)
eq('num(NaN) 归零', num(NaN), 0)
eq('num(undefined) 归零', num(undefined), 0)
eq('num("12") 转数字', num('12'), 12)
eq('num("abc") 归零', num('abc'), 0)

const k1 = dayKey(new Date(2026, 9, 5).getTime())   // 2026-10-05
eq('dayKey 格式', k1, '2026-10-05')
ok('dayKey 两位补零', /^\d{4}-\d{2}-\d{2}$/.test(dayKey()))

const d1 = usageToDelta({ inputTokens: 100, cacheReadTokens: 20, outputTokens: 50 })
eq('usageToDelta.input', d1.input, 100)
eq('usageToDelta.cache', d1.cache, 20)
eq('usageToDelta.output', d1.output, 50)
ok('isZeroDelta(全零)', isZeroDelta({ input: 0, cache: 0, output: 0 }))
ok('isZeroDelta(有值) 为假', !isZeroDelta({ input: 1, cache: 0, output: 0 }))
eq('total', total({ input: 10, cache: 5, output: 2 }), 17)

// ---------------------------------------------------------------- 事件摄取

console.log('--- 事件摄取 ---')
function msgEvent(turn, input, cache, output, model) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      usage: { inputTokens: input, cacheReadTokens: cache, outputTokens: output },
      message: model ? { source: { model } } : undefined
    }
  }
}

{
  const m = createMeter()
  ok('无关事件被忽略',
    m.ingest('s1', { type: 'tool/call', data: {} }) === false)
  ok('缺 usage 被忽略',
    m.ingest('s1', { type: 'assistant/message', data: { turn: 1 } }) === false)
  ok('data 不是对象被忽略',
    m.ingest('s1', { type: 'assistant/message', data: 5 }) === false)
  ok('null 事件被忽略', m.ingest('s1', null) === false)
}

{
  const m = createMeter()
  ok('首次 usage 计入', m.ingest('s1', msgEvent(1, 100, 20, 50, 'deepseek-flash')) === true)
  const s = m.activeSession()
  eq('会话 input', s.input, 100)
  eq('会话 cache', s.cache, 20)
  eq('会话 output', s.output, 50)
  eq('会话 turns', s.turns, 1)
  const t = m.today()
  eq('今日 input', t.input, 100)
  eq('今日 turns', t.turns, 1)
}

// 同一轮重复上报 → 只计一次（防重复计费）
{
  const m = createMeter()
  m.ingest('s1', msgEvent(1, 100, 0, 50))
  ok('同轮第二次被拒绝', m.ingest('s1', msgEvent(1, 100, 0, 50)) === false)
  eq('同轮未重复累加', m.activeSession().input, 100)
}

// 新一轮 → 正常累加
{
  const m = createMeter()
  m.ingest('s1', msgEvent(1, 100, 0, 50))
  ok('第 2 轮计入', m.ingest('s1', msgEvent(2, 200, 0, 80)) === true)
  eq('两轮累加 input', m.activeSession().input, 300)
  eq('两轮 turns', m.activeSession().turns, 2)
}

// turn/end 清去重集合 → 同 turn 号可再次计入（跨轮复用 turn 号的情况）
{
  const m = createMeter()
  m.ingest('s1', msgEvent(1, 100, 0, 50))
  m.ingest('s1', { type: 'turn/end', data: {} })
  ok('turn/end 后同轮号可再计', m.ingest('s1', msgEvent(1, 10, 0, 5)) === true)
  eq('累加正确', m.activeSession().input, 110)
}

// 多会话隔离
{
  const m = createMeter()
  m.ingest('s1', msgEvent(1, 100, 0, 0))
  m.ingest('s2', msgEvent(1, 7, 0, 0))
  eq('s1 独立', m.sessions.get('s1').input, 100)
  eq('s2 独立', m.sessions.get('s2').input, 7)
  eq('会话数', m.sessions.size, 2)
}

// 按模型拆分
{
  const m = createMeter()
  m.ingest('s1', msgEvent(1, 100, 0, 10, 'deepseek-flash'))
  m.ingest('s1', msgEvent(2, 200, 0, 20, 'deepseek-v4-pro'))
  const s = m.activeSession()
  eq('flash 模型 input', s.models['deepseek-flash'].input, 100)
  eq('pro 模型 input', s.models['deepseek-v4-pro'].input, 200)
  eq('今日模型数', Object.keys(m.today().models).length, 2)
}

// 全零 usage 不计入、不产生落盘信号
{
  const m = createMeter()
  ok('全零 usage 返回 false', m.ingest('s1', msgEvent(1, 0, 0, 0)) === false)
  eq('未创建会话', m.sessions.size, 0)
}

// ⚠️ 关键回归：reasoning 不单独累加
// 若实现错误地把 reasoningTokens 也加上，output 会变成 100+80=180
{
  const m = createMeter()
  m.ingest('s1', {
    type: 'assistant/message',
    data: {
      turn: 1,
      usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 100, reasoningTokens: 80 }
    }
  })
  eq('reasoning 不重复计入 output', m.activeSession().output, 100)
}

// ---------------------------------------------------------------- 序列化 / 恢复

console.log('--- 序列化与恢复 ---')
{
  const a = createMeter()
  a.ingest('s1', msgEvent(1, 111, 22, 33, 'deepseek-flash'))
  const snap = JSON.parse(JSON.stringify(a.serialize()))

  const b = createMeter()
  b.restore(snap)
  eq('恢复后 input', b.activeSession().input, 111)
  eq('恢复后 cache', b.activeSession().cache, 22)
  eq('恢复后 output', b.activeSession().output, 33)
  eq('恢复后 turns', b.activeSession().turns, 1)
  eq('恢复后今日 input', b.today().input, 111)
  eq('恢复后模型保留', b.activeSession().models['deepseek-flash'].input, 111)
  ok('恢复后 turnSeen 是空集合（不会误判重复）',
    b.ingest('s1', msgEvent(1, 5, 0, 0)) === true)
}
{
  const m = createMeter()
  m.restore(null)
  ok('restore(null) 不抛异常', true)
  m.restore({ days: 'garbage', sessions: 42 })
  ok('restore(垃圾) 不抛异常', true)
  eq('垃圾数据后为空', m.sessions.size, 0)
}

// ---------------------------------------------------------------- recentDays / prune

console.log('--- 时间窗口 ---')
{
  const m = createMeter()
  m.ingest('s1', msgEvent(1, 100, 0, 0))
  const r = m.recentDays(7)
  eq('recentDays 长度', r.length, 7)
  eq('最后一天是今天', r[6].day, dayKey())
  eq('今天有数据', r[6].input, 100)
  eq('前天为 0', r[5].input, 0)
}
{
  const m = createMeter({ keepDays: 3 })
  const old = new Date(); old.setDate(old.getDate() - 10)
  m.days.set(dayKey(old.getTime()), { input: 1, cache: 0, output: 0, turns: 1, models: {} })
  m.ingest('s1', msgEvent(1, 5, 0, 0))
  eq('prune 前有 2 天', m.days.size, 2)
  m.prune()
  eq('prune 后只剩 1 天', m.days.size, 1)
}
{
  const m = createMeter({ maxSessions: 2 })
  for (let i = 0; i < 5; i++) {
    m.ingest('s' + i, msgEvent(1, i + 1, 0, 0))
  }
  eq('会话上限生效', m.sessions.size, 2)
}

// ---------------------------------------------------------------- 异常安全

console.log('--- 异常安全 ---')
{
  const m = createMeter()
  ok('usage 是字符串不抛', m.ingest('s1', { type: 'assistant/message', data: { usage: 'x' } }) === false)
  ok('turn 是非数字不抛', m.ingest('s1', { type: 'assistant/message', data: { turn: 'abc', usage: { inputTokens: 5 } } }) === true)
  ok('event 缺 type 不抛', m.ingest('s1', { data: {} }) === false)
  ok('sid 为空串也能工作', m.ingest('', msgEvent(9, 1, 0, 0)) === true)
}

// ---------------------------------------------------------------- 余额解析

console.log('--- 余额解析 parseBalance ---')

// ⚠️ 真实返回体（本机 DSH 0.2.0-rc.2 实测抓到），这条是防回归的关键用例
{
  const real = {
    status: 'ready',
    value: [{ currency: 'CNY', balance: '47.1691495600000000' }],
    bonusWallets: [{ currency: 'CNY', balance: '0' }]
  }
  const p = parseBalance(real)
  ok('真实返回体可解析', p.ok === true)
  eq('真实余额 currency', p.currency, 'CNY')
  ok('真实余额 total ≈ 47.169', Math.abs(p.total - 47.16914956) < 1e-9, '得到 ' + p.total)
  eq('真实赠金 granted', p.granted, 0)
  ok('真实充值 toppedUp ≈ 47.169', Math.abs(p.toppedUp - 47.16914956) < 1e-9)
}

// 赠金 + 充值应相加（赠金有钱时）
{
  const p = parseBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '10.00' }],
    bonusWallets: [{ currency: 'CNY', balance: '5.50' }]
  })
  ok('赠金+充值相加 = 15.5', Math.abs(p.total - 15.5) < 1e-9, '得到 ' + p.total)
  ok('granted=5.5', Math.abs(p.granted - 5.5) < 1e-9)
  ok('toppedUp=10', Math.abs(p.toppedUp - 10) < 1e-9)
}

// 只有赠金（没充值钱包）
{
  const p = parseBalance({ value: [], bonusWallets: [{ currency: 'CNY', balance: '8' }] })
  ok('只有赠金也能拿到余额', p.ok === true && Math.abs(p.total - 8) < 1e-9, '得到 ' + JSON.stringify(p))
}

// 多币种时优先 CNY
{
  const p = parseBalance({
    value: [{ currency: 'USD', balance: '9.99' }, { currency: 'CNY', balance: '20' }]
  })
  ok('多币种优先 CNY', p.currency === 'CNY' && Math.abs(p.total - 20) < 1e-9, '得到 ' + JSON.stringify(p))
}

// 兼容旧形态 balance_infos / total_balance
{
  const p = parseBalance({ balance_infos: [{ currency: 'CNY', balance: '3.25' }] })
  ok('兼容 balance_infos', p.ok === true && Math.abs(p.total - 3.25) < 1e-9)
}
{
  const p = parseBalance({ total_balance: 12.5, granted_balance: 2, topped_up_balance: 10.5, currency: 'CNY' })
  ok('兼容 total_balance 单对象', p.ok === true && Math.abs(p.total - 12.5) < 1e-9)
  ok('  单对象 granted', Math.abs(p.granted - 2) < 1e-9)
  ok('  单对象 toppedUp', Math.abs(p.toppedUp - 10.5) < 1e-9)
}
// 顶层数组形态
{
  const p = parseBalance([{ currency: 'CNY', balance: '6' }])
  ok('兼容顶层数组', p.ok === true && Math.abs(p.total - 6) < 1e-9)
}

// null = 未登录（正常降级，不是错误）
{
  const p = parseBalance(null)
  eq('null 返回 ok=false', p.ok, false)
  eq('null reason', p.reason, 'null')
}
{
  const p = parseBalance(undefined)
  eq('undefined reason', p.reason, 'null')
}

// 无法解析
{
  const p = parseBalance({ status: 'ready' })
  eq('空对象不可解析', p.reason, 'unparsable')
}
{
  const p = parseBalance({ value: [{ currency: 'CNY', balance: 'abc' }] })
  eq('非法金额不可解析', p.reason, 'unparsable')
}
{
  const p = parseBalance('garbage')
  eq('字符串不可解析', p.reason, 'unparsable')
}
{
  const p = parseBalance({ value: 'nope', bonusWallets: 42 })
  eq('字段类型错误不可解析', p.reason, 'unparsable')
}

console.log('')
console.log('合计: ' + pass + ' 通过, ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
