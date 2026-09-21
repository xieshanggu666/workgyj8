import { defineStore } from 'pinia'
import { ACTIVITIES, TASKS, SHOP_GOODS, DEMO_USER, DEFAULT_RISK_RULES } from '@/mock/data'

// 加权随机抽取（按权重选一个奖品下标）
function drawByWeight(prizes) {
  const total = prizes.reduce((s, p) => s + p.weight, 0)
  let r = Math.random() * total
  for (let i = 0; i < prizes.length; i++) {
    r -= prizes[i].weight
    if (r < 0) return i
  }
  return prizes.length - 1
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function todayStr() {
  // 业务日按本地自然日计算（与 nowTime 的本地时间保持一致，避免 UTC 偏移导致跨日错配）
  return dateStr(0)
}
// 相对今天偏移 offset 天的业务日字符串（负数取历史日，用于跨日台账/种子数据）
function dateStr(offsetDays = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
// 今天某时刻（h:m）的时间戳，用于构造演示数据/风控窗口比较
function todayAt(h, m = 0) {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

// 风控规则文案
const RULE_LABELS = {
  blacklist: '黑名单用户',
  highValue: '高价值奖品/兑换',
  dailyBurst: '当日抽奖频次超限',
  rapidDraw: '短时间连续抽奖',
  rapidRedeem: '短时间连续兑换'
}
export const RISK_RULE_LABELS = RULE_LABELS

// 审核单状态文案与样式标记
export const RISK_STATUS = {
  pending: { label: '待审核', tone: 'warn' },
  appealed: { label: '已申诉', tone: 'info' },
  released: { label: '已放行', tone: 'ok' },
  revoked: { label: '已撤销', tone: 'bad' }
}

// 对账任务单状态
export const RECON_JOB_STATUS = {
  pending: { label: '有差异待复核', tone: 'warn' },
  balanced: { label: '账实一致', tone: 'ok' }
}
// 差异单状态
export const RECON_DIFF_STATUS = {
  pending: { label: '待复核', tone: 'warn' },
  compensated: { label: '已补偿', tone: 'ok' },
  waived: { label: '已挂账', tone: 'info' },
  balanced: { label: '重核一致', tone: 'ok' }
}
// 差异分类文案
export const RECON_CATEGORY = {
  points: '积分账目',
  frozenPoints: '冻结积分',
  stock: '库存账目'
}

let seq = 0
const genId = (p) => `${p}-${Date.now()}-${seq++}`

export const usePlatformStore = defineStore('platform', {
  state: () => ({
    user: { ...DEMO_USER },
    role: 'user',               // user | operator：演示角色（用户申诉 / 运营审核）
    points: 0,                  // 用户可用积分（冻结部分不计入）
    activities: [],             // 深拷贝
    tasks: [],                  // 深拷贝（含完成状态）
    goods: [],                  // 商城商品（响应式库存 + 预占）
    records: [],                // 抽奖 / 兑换业务记录（含 frozen/released/revoked 状态）
    pointRecords: [],           // 积分流水（append-only）
    taskClaims: [],             // 任务领奖台账（append-only）：{ taskId, bizDate 归属业务日, grantDate 实际发放日, reward }，防重复发奖的唯一判重依据
    riskOrders: [],             // 风控审核单
    auditLogs: [],              // 操作记录（审计日志）
    stockLedger: [],            // 库存流水（append-only）：hold/release/revoke/reset/recon 均留痕，对账重放的唯一账册
    reconJobs: [],              // 对账任务单（按业务日唯一，重复执行复用同一张）
    reconDiffs: [],             // 差异单（可追溯：业务台账值 vs 流水账值，补偿后保留原始快照）
    reconCompensations: [],     // 补偿流水（append-only，原始记录永不改写）
    riskRules: { ...DEFAULT_RISK_RULES, blacklist: [...DEFAULT_RISK_RULES.blacklist] },
    todayDate: todayStr(),
    activeTab: 'home',
    toast: null
  }),

  getters: {
    // 是否运营身份
    isOperator: (s) => s.role === 'operator',
    // 冻结中的积分（抽奖成本 + 兑换成本；抽奖积分奖品在放行时才入账）
    frozenPoints(s) {
      return s.riskOrders
        .filter((o) => o.status === 'pending' || o.status === 'appealed')
        .reduce((sum, o) => sum + (o.frozenPoints || 0), 0)
    },
    // 每日抽奖次数（已撤销不计入：撤销后返还限次；待审核/已放行均占用次数）
    dailyDrawCount: (s) => (activityId) =>
      s.records.filter(
        (r) => r.type === 'draw' && r.activityId === activityId &&
          r.date === s.todayDate && r.status !== 'revoked'
      ).length,
    // 总抽奖次数统计
    totalDrawCount: (s) => (activityId) =>
      s.records.filter(
        (r) => r.type === 'draw' && r.activityId === activityId && r.status !== 'revoked'
      ).length,
    // 有效业务记录（已撤销不计入业务与统计）
    validRecords(s) {
      return s.records.filter((r) => r.status !== 'revoked')
    },
    // 某业务日有效抽奖次数（真实参与记录：正常 + 审核放行计入；冻结暂缓、撤销回退均不计）
    validDrawCount: (s) => (date) =>
      s.records.filter(
        (r) => r.type === 'draw' && r.date === date &&
          (r.status === 'normal' || r.status === 'released')
      ).length,
    // 某业务日风控审核中的抽奖笔数（暂缓计入任务进度，放行后补计、撤销后不计）
    pendingDrawCount: (s) => (date) =>
      s.records.filter(
        (r) => r.type === 'draw' && r.date === date && r.status === 'frozen'
      ).length,
    // 抽奖任务当日状态：进度/达标/已结算/审核中笔数（进度由真实记录推导，不落库）
    drawTaskState(s) {
      return (taskId) => {
        const t = s.tasks.find((x) => x.id === taskId)
        if (!t || t.metric !== 'draw') return null
        const date = s.todayDate
        const progress = this.validDrawCount(date)
        const claim = s.taskClaims.find((c) => c.taskId === taskId && c.bizDate === date)
        return {
          goal: t.goal,
          progress,
          pending: this.pendingDrawCount(date),
          done: progress >= t.goal,
          claimed: !!claim,
          claim: claim || null
        }
      }
    },
    // 任务台账：按业务日保留每个抽奖任务的进度与领奖记录（跨日审核各记各的账，不串日）
    taskDayBooks(s) {
      const drawTasks = s.tasks.filter((t) => t.metric === 'draw')
      const dates = new Set()
      s.records.forEach((r) => { if (r.type === 'draw') dates.add(r.date) })
      s.taskClaims.forEach((c) => dates.add(c.bizDate))
      return [...dates].sort().reverse().map((date) => ({
        date,
        isToday: date === s.todayDate,
        tasks: drawTasks.map((t) => {
          const claim = s.taskClaims.find((c) => c.taskId === t.id && c.bizDate === date)
          return {
            taskId: t.id,
            label: t.label,
            goal: t.goal,
            reward: t.reward,
            progress: this.validDrawCount(date),
            pending: this.pendingDrawCount(date),
            claim: claim || null
          }
        })
      }))
    },
    // 待处理审核单数（用户端/运营端角标）
    pendingRiskCount(s) {
      return s.riskOrders.filter((o) => o.status === 'pending' || o.status === 'appealed').length
    },
    // 待运营复核的差异单数（对账页/看板角标）
    pendingDiffCount(s) {
      return s.reconDiffs.filter((d) => d.status === 'pending').length
    },
    // 运营看板统计（同步冻结/撤销状态）
    dashboard(state) {
      const draws = state.records.filter((r) => r.type === 'draw' && r.status !== 'revoked')
      return {
        totalDraws: draws.length,
        running: state.activities.filter((a) => a.status === 'running').length,
        participants: Math.round(draws.length * 1.7) + 128,
        legendaryWins: draws.filter((r) => r.rarity === 'legendary').length,
        epicWins: draws.filter((r) => r.rarity === 'epic').length,
        pointsIssued: state.pointRecords
          .filter((p) => p.delta > 0 && !['refund', 'opening', 'recon'].includes(p.kind))
          .reduce((s, p) => s + p.delta, 0),
        goodsSold: state.records.filter((r) => r.type === 'redeem' && r.status !== 'revoked').length,
        taskSettlements: state.taskClaims.length,
        pendingRisk: state.riskOrders.filter((o) => o.status === 'pending' || o.status === 'appealed').length,
        frozenPoints: state.riskOrders
          .filter((o) => o.status === 'pending' || o.status === 'appealed')
          .reduce((sum, o) => sum + (o.frozenPoints || 0), 0),
        pendingDiffs: state.reconDiffs.filter((d) => d.status === 'pending').length,
        reconciledDays: state.reconJobs.length,
        reconCompensations: state.reconCompensations.length,
        reconCompPoints: state.reconCompensations
          .filter((c) => c.nature === 'points' || c.nature === 'frozenPoints')
          .reduce((s, c) => s + (c.delta || 0), 0)
      }
    }
  },

  actions: {
    init() {
      this.activities = ACTIVITIES.map((a) => ({
        ...a,
        prizes: a.prizes.map((p) => ({ ...p, frozen: 0 }))
      }))
      this.tasks = TASKS.map((t) => ({
        ...t,
        done: false,
        claimed: false
      }))
      this.goods = SHOP_GOODS.map((g) => ({ ...g, frozen: 0 }))
      // 以当前真实业务日为种子数据的日期基准（避免种子单据的日期落在"昨天"）
      this.todayDate = todayStr()
      this.seedRiskData()
    },

    // ===== 统一业务日切换 =====
    // 所有按日重置/统计的唯一入口：业务动作前、定时器轮询、页面重新可见时调用。
    // 跨日处理：
    //  - 重置每日任务（done/claimed 复位，可重新完成领取）；一次性任务保持已完成状态
    //  - 刷新 todayDate：每日限抽、风控当日频次从新日期起算
    //  - 保留累计抽奖次数、积分余额/流水，以及审核中（pending/appealed）单据的冻结积分与预占库存，支持跨日审核
    syncBusinessDay(showHint = false) {
      const current = todayStr()
      if (current === this.todayDate) return false
      const prev = this.todayDate
      // 归档前兜底结算上一业务日的抽奖任务（幂等）：已达标的防漏发，审核中的留待放行后补计
      this.settleDrawTasks(prev)
      this.todayDate = current

      // 每日任务随业务日重置（保留一次性任务的进度与领取状态；
      // 抽奖类任务进度由真实参与记录按日推导，领奖记录留存在 taskClaims 台账，无需重置）
      this.tasks.forEach((t) => {
        if (t.type === 'daily' && !t.metric) {
          t.done = false
          t.claimed = false
        }
      })

      // 冻结权益不随跨日处置：待审核/已申诉单据仍占用冻结积分与预占库存，
      // 运营可在新业务日继续放行/撤销；累计次数、历史流水/记录同样保留。
      this.addAuditLog('day-rollover', null,
        `业务日由 ${prev} 切换为 ${current}：每日任务与每日限次已重置，任务进度与领奖记录按业务日归档保留，审核中冻结权益保留`)
      if (showHint) {
        this.showToast(`🌅 已跨日至 ${current}，每日任务与抽奖次数已刷新，审核中的冻结权益保留`, 'info')
      }
      return true
    },

    showToast(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
    },
    clearToast() {
      this.toast = null
    },

    gotoTab(tab) {
      this.activeTab = tab
    },

    // ===== 角色切换（演示权限） =====
    setRole(role) {
      this.role = role
      this.addAuditLog('switch-role', null, `切换为${role === 'operator' ? '运营' : '用户'}视角`)
      this.showToast(`已切换为${role === 'operator' ? '运营审核' : '普通用户'}视角`, 'info')
    },

    // ===== 积分流水（append-only，禁止改写历史行） =====
    // bizDate：流水归属业务日（跨日审核的放行/撤销/对账补偿时可能早于发生日 todayDate）
    // refType/refId：关联的业务记录/审核单/差异单，保证对账可逐笔追溯
    addPointRecord(delta, note, kind = 'normal', extra = {}) {
      this.pointRecords.unshift({
        id: extra.id || genId('pr'),
        date: extra.date || this.todayDate,
        bizDate: extra.bizDate || extra.date || this.todayDate,
        time: extra.time || nowTime(),
        ts: extra.ts || Date.now(),
        delta,
        balance: this.points,
        note,
        kind, // normal | frozen | release | refund | reward | opening | recon
        refType: extra.refType || '',
        refId: extra.refId || ''
      })
      if (this.pointRecords.length > 400) this.pointRecords.pop()
    },

    // ===== 库存流水（append-only） =====
    // kind：hold 预占 / release 核销 / revoke 回补 / reset 运营重置 / init 建账 / recon 对账补偿
    // deltaHeld 为可售余量变化（出库为负），deltaFrozen 为预占库存变化
    addStockMove(kind, payload) {
      const m = {
        id: payload.id || genId('sl'),
        kind,
        date: payload.date || this.todayDate,
        bizDate: payload.bizDate || payload.date || this.todayDate,
        time: payload.time || nowTime(),
        ts: payload.ts || Date.now(),
        targetType: payload.targetType,   // prize | goods
        targetId: payload.targetId,
        targetName: payload.targetName,
        activityId: payload.activityId || null,
        deltaHeld: payload.deltaHeld || 0,
        deltaFrozen: payload.deltaFrozen || 0,
        refType: payload.refType || '',
        refId: payload.refId || '',
        note: payload.note || ''
      }
      this.stockLedger.unshift(m)
      if (this.stockLedger.length > 500) this.stockLedger.pop()
      return m
    },

    // ===== 操作记录（审计日志） =====
    addAuditLog(action, orderId, detail) {
      this.auditLogs.unshift({
        id: genId('log'),
        action,                                   // freeze/release/revoke/appeal/config/switch-role
        actionLabel: {
          freeze: '风控冻结',
          release: '审核放行',
          revoke: '审核撤销',
          appeal: '用户申诉',
          config: '规则变更',
          'task-settle': '任务结算',
          'switch-role': '视角切换',
          'day-rollover': '业务日切换',
          'recon-run': '执行对账',
          'recon-compensate': '对账补偿',
          'recon-waive': '差异挂账',
          'stock-reset': '库存重置'
        }[action] || action,
        orderId: orderId || '',
        operator: this.role === 'operator' ? `运营(${this.user.name})` : this.user.name,
        detail,
        date: this.todayDate,
        time: nowTime()
      })
      if (this.auditLogs.length > 200) this.auditLogs.pop()
    },

    // ===== 风控规则评估 =====
    // 抽奖：返回命中的规则 code 列表
    evalDrawRisk(activity, prize) {
      const hit = []
      const r = this.riskRules
      if (!r.enabled) return hit
      if (r.blacklist.includes(this.user.id)) hit.push('blacklist')
      if (r.highValueRarities.includes(prize.rarity)) hit.push('highValue')
      // 当日频次：含本次将达到阈值
      const todayCount = this.dailyDrawCount(activity.id)
      if (r.dailyDrawThreshold > 0 && todayCount + 1 >= r.dailyDrawThreshold) hit.push('dailyBurst')
      // 短时连抽
      if (r.rapidDrawSeconds > 0 && r.rapidDrawMax > 0) {
        const since = Date.now() - r.rapidDrawSeconds * 1000
        const recent = this.records.filter(
          (x) => x.type === 'draw' && x.status !== 'revoked' && x.ts && x.ts >= since
        ).length
        if (recent + 1 >= r.rapidDrawMax) hit.push('rapidDraw')
      }
      return hit
    },
    // 兑换：返回命中的规则 code 列表
    evalRedeemRisk(goods) {
      const hit = []
      const r = this.riskRules
      if (!r.enabled) return hit
      if (r.blacklist.includes(this.user.id)) hit.push('blacklist')
      if (goods.cost >= r.highValueRedeemCost) hit.push('highValue')
      if (r.rapidRedeemSeconds > 0 && r.rapidRedeemMax > 0) {
        const since = Date.now() - r.rapidRedeemSeconds * 1000
        const recent = this.records.filter(
          (x) => x.type === 'redeem' && x.status !== 'revoked' && x.ts && x.ts >= since
        ).length
        if (recent + 1 >= r.rapidRedeemMax) hit.push('rapidRedeem')
      }
      return hit
    },

    // ===== 抽奖任务自动结算 =====
    // 进度唯一来源：真实参与记录（validDrawCount）。冻结暂缓计入、放行补计、撤销不计。
    // 幂等：同一（任务, 归属业务日）仅发奖一次——taskClaims 判重，重复调用/跨日补审不会重复发奖。
    // 跨日：按参与记录的业务日（bizDate）归属结算，实际发放日 grantDate 单独记录，积分流水同步标注。
    settleDrawTasks(bizDate) {
      const date = bizDate || this.todayDate
      const drawTasks = this.tasks.filter((t) => t.metric === 'draw' && t.type === 'daily')
      if (!drawTasks.length) return []
      const valid = this.validDrawCount(date)
      const settled = []
      drawTasks.forEach((t) => {
        if (valid < t.goal) return
        if (this.taskClaims.some((c) => c.taskId === t.id && c.bizDate === date)) return // 已结算，防重
        const crossDay = date !== this.todayDate
        this.points += t.reward
        this.taskClaims.push({
          id: genId('tc'),
          taskId: t.id,
          taskLabel: t.label,
          reward: t.reward,
          bizDate: date,               // 任务归属业务日（按真实参与记录日期）
          grantDate: this.todayDate,   // 实际发放业务日（跨日审核补计时晚于归属日）
          time: nowTime(),
          ts: Date.now(),
          source: 'auto'
        })
        this.addPointRecord(t.reward, `任务结算：${t.label}${crossDay ? `（${date} 业务日补计）` : ''}`, 'reward',
          { bizDate: date, refType: 'task', refId: t.id })
        this.addAuditLog('task-settle', null,
          `抽奖任务【${t.label}】达成（${date} 有效参与 ${valid}/${t.goal}），自动发放 ${t.reward} 积分${crossDay ? '（跨日审核补计）' : ''}`)
        settled.push(t)
      })
      if (settled.length) {
        this.showToast(
          `🎯 任务达成【${settled.map((t) => t.label).join('、')}】，+${settled.reduce((s, t) => s + t.reward, 0)} 积分已自动结算`,
          'success')
      }
      return settled
    },

    // ===== 抽奖 =====
    draw(activityId) {
      this.syncBusinessDay()
      const act = this.activities.find((a) => a.id === activityId)
      if (!act || act.status !== 'running') {
        this.showToast('活动未在运行', 'warn')
        return null
      }
      // 每日限抽
      if (this.dailyDrawCount(activityId) >= act.dailyLimit) {
        this.showToast(`今日已达抽奖上限（${act.dailyLimit} 次）`, 'warn')
        return null
      }
      // 总限抽
      if (this.totalDrawCount(activityId) >= act.totalLimit) {
        this.showToast(`累计已达抽奖上限（${act.totalLimit} 次）`, 'warn')
        return null
      }
      // 可抽取奖品（排除库存为 0 的实物，但"谢谢参与"始终保留）
      const drawable = act.prizes.filter((p) => p.remain > 0 || p.rarity === 'none')
      if (!drawable.length) {
        this.showToast('奖品已抽完', 'warn')
        return null
      }
      const idx = drawByWeight(drawable)
      const prize = drawable[idx]
      // 积分成本校验（先校验后扣减，避免无奖品时误扣）
      const cost = act.costType === 'points' ? act.cost : 0
      if (cost > 0 && this.points < cost) {
        this.showToast('积分不足，无法参与', 'warn')
        return null
      }

      // 风控评估（在任何扣减发生之前，杜绝部分扣减）
      const riskHits = this.evalDrawRisk(act, prize)
      if (riskHits.length) {
        return this.freezeDraw(act, prize, cost, riskHits)
      }

      // 正常放行
      const recId = genId('r')
      if (cost > 0) {
        this.points -= cost
        this.addPointRecord(-cost, `参与活动【${act.name}】`, 'normal',
          { bizDate: this.todayDate, refType: 'record', refId: recId })
      }
      this.saveDayLog()
      if (prize.rarity !== 'none') {
        const orig = act.prizes.find((p) => p.id === prize.id)
        orig.remain -= 1
        this.addStockMove('release', {
          targetType: 'prize', targetId: prize.id, targetName: prize.name, activityId: act.id,
          deltaHeld: -1, refType: 'record', refId: recId, note: `抽奖中奖出库：${act.name}`
        })
      }
      let pointDelta = 0
      if (prize.name.includes('积分')) {
        pointDelta = parseInt(prize.name) || 0
        this.points += pointDelta
      }

      const rec = {
        id: recId,
        type: 'draw',
        status: 'normal',          // normal | frozen | released | revoked
        date: this.todayDate,
        time: nowTime(),
        ts: Date.now(),
        activityId: act.id,
        activityName: act.name,
        prizeId: prize.id,
        prizeName: prize.name,
        rarity: prize.rarity,
        icon: prize.emoji
      }
      this.records.unshift(rec)
      if (pointDelta) this.addPointRecord(pointDelta, `抽奖获得：${prize.name}`, 'reward',
        { bizDate: rec.date, refType: 'record', refId: rec.id })
      if (prize.rarity === 'legendary') this.showToast(`🎉 传说大奖！${prize.name}`, 'success')
      else this.showToast(`获得：${prize.name}`, 'success')
      // 真实参与记录落账后，按归属业务日自动结算抽奖任务（达标即发奖，幂等防重）
      this.settleDrawTasks(rec.date)
      return rec
    },

    // 冻结抽奖：占用成本积分 + 预占奖品库存，建立审核单
    freezeDraw(act, prize, cost, riskHits) {
      const recId = genId('r')
      if (cost > 0) {
        this.points -= cost
        this.addPointRecord(-cost, `冻结：参与【${act.name}】待风控审核`, 'frozen',
          { bizDate: this.todayDate, refType: 'record', refId: recId })
      }
      if (prize.rarity !== 'none') {
        const orig = act.prizes.find((p) => p.id === prize.id)
        orig.remain -= 1
        orig.frozen += 1
        this.addStockMove('hold', {
          targetType: 'prize', targetId: prize.id, targetName: prize.name, activityId: act.id,
          deltaHeld: -1, deltaFrozen: +1, refType: 'record', refId: recId,
          note: `风控预占：${act.name}（审核中）`
        })
      }
      const rec = {
        id: recId,
        type: 'draw',
        status: 'frozen',
        date: this.todayDate,
        time: nowTime(),
        ts: Date.now(),
        activityId: act.id,
        activityName: act.name,
        prizeId: prize.id,
        prizeName: prize.name,
        rarity: prize.rarity,
        icon: prize.emoji
      }
      this.records.unshift(rec)
      const order = this.createRiskOrder({
        bizType: 'draw',
        recordId: rec.id,
        activityId: act.id,
        targetId: prize.id,
        targetName: prize.name,
        icon: prize.emoji,
        rarity: prize.rarity,
        cost,
        stockHeld: prize.rarity === 'none' ? 0 : 1,
        riskHits
      })
      rec.riskOrderId = order.id
      this.showToast('⚠️ 该次抽奖触发风控，奖品与积分已冻结，审核通过前不计入抽奖任务进度；可在「风控申诉」中查看/申诉', 'warn')
      return rec
    },

    // ===== 任务 =====
    completeTask(taskId) {
      this.syncBusinessDay()
      const t = this.tasks.find((x) => x.id === taskId)
      if (!t || t.claimed) return
      // 抽奖类任务由真实参与记录驱动，自动结算，禁止手动领取（防刷/防重复发奖）
      if (t.metric === 'draw') {
        this.showToast('抽奖任务按真实参与记录自动结算，达标后自动发奖', 'info')
        return
      }
      t.done = true
      this.claimTask(taskId)
    },
    claimTask(taskId) {
      this.syncBusinessDay()
      const t = this.tasks.find((x) => x.id === taskId)
      if (!t || t.claimed || !t.done) return
      if (t.metric === 'draw') return // 抽奖任务奖励仅由 settleDrawTasks 发放
      t.claimed = true
      this.points += t.reward
      this.addPointRecord(t.reward, `完成任务：${t.label}`, 'reward',
        { bizDate: this.todayDate, refType: 'task', refId: t.id })
      this.showToast(`获得 ${t.reward} 积分`, 'success')
    },
    // 一键签到
    checkInTask() {
      this.completeTask('t-checkin')
    },

    // ===== 商城兑换 =====
    redeem(goodsId) {
      this.syncBusinessDay()
      const g = this.goods.find((x) => x.id === goodsId)
      if (!g) return null
      if (g.remain <= 0) {
        this.showToast('商品已兑完', 'warn')
        return null
      }
      if (this.points < g.cost) {
        this.showToast('积分不足', 'warn')
        return null
      }

      // 风控评估（扣减前）
      const riskHits = this.evalRedeemRisk(g)
      if (riskHits.length) {
        return this.freezeRedeem(g, riskHits)
      }

      const recId = genId('rg')
      this.points -= g.cost
      g.remain -= 1
      this.addPointRecord(-g.cost, `兑换：${g.name}`, 'normal',
        { bizDate: this.todayDate, refType: 'record', refId: recId })
      this.addStockMove('release', {
        targetType: 'goods', targetId: g.id, targetName: g.name,
        deltaHeld: -1, refType: 'record', refId: recId, note: '积分商城兑换出库'
      })
      const rec = {
        id: recId,
        type: 'redeem',
        status: 'normal',
        date: this.todayDate,
        time: nowTime(),
        ts: Date.now(),
        goodsId: g.id,
        goodsName: g.name,
        icon: g.icon
      }
      this.records.unshift(rec)
      this.showToast(`兑换成功：${g.name}`, 'success')
      return rec
    },

    // 冻结兑换：占用积分 + 预占商品库存
    freezeRedeem(g, riskHits) {
      const recId = genId('rg')
      this.points -= g.cost
      g.remain -= 1
      g.frozen += 1
      this.addPointRecord(-g.cost, `冻结：兑换【${g.name}】待风控审核`, 'frozen',
        { bizDate: this.todayDate, refType: 'record', refId: recId })
      this.addStockMove('hold', {
        targetType: 'goods', targetId: g.id, targetName: g.name,
        deltaHeld: -1, deltaFrozen: +1, refType: 'record', refId: recId,
        note: '风控预占：积分商城兑换（审核中）'
      })
      const rec = {
        id: recId,
        type: 'redeem',
        status: 'frozen',
        date: this.todayDate,
        time: nowTime(),
        ts: Date.now(),
        goodsId: g.id,
        goodsName: g.name,
        icon: g.icon
      }
      this.records.unshift(rec)
      const order = this.createRiskOrder({
        bizType: 'redeem',
        recordId: rec.id,
        targetId: g.id,
        targetName: g.name,
        icon: g.icon,
        cost: g.cost,
        stockHeld: 1,
        riskHits
      })
      rec.riskOrderId = order.id
      this.showToast('⚠️ 该笔兑换触发风控，积分与商品已冻结，可在「风控申诉」中查看/申诉', 'warn')
      return rec
    },

    // ===== 风控审核单 =====
    createRiskOrder({ bizType, recordId, activityId = null, targetId, targetName, icon, rarity = null, cost, stockHeld, riskHits }) {
      const order = {
        id: genId('rk'),
        bizType,                    // draw | redeem
        status: 'pending',          // pending | appealed | released | revoked
        userId: this.user.id,
        userName: this.user.name,
        recordId,
        activityId,
        targetId,
        targetName,
        icon,
        rarity,
        frozenPoints: cost || 0,    // 冻结的成本积分
        stockHeld,                  // 预占库存数量
        rules: riskHits.map((code) => ({ code, label: RULE_LABELS[code] || code })),
        appealReason: '',
        appealAt: '',
        reviewNote: '',
        reviewer: '',
        createdAt: this.todayDate,
        time: nowTime(),
        ts: Date.now(),
        reviewedAt: ''
      }
      this.riskOrders.unshift(order)
      this.addAuditLog('freeze', order.id,
        `${bizType === 'draw' ? '抽奖' : '兑换'}【${targetName}】命中规则：${order.rules.map((r) => r.label).join('、')}，冻结${cost || 0}积分${stockHeld ? `、预占库存×${stockHeld}` : ''}${bizType === 'draw' ? '；该笔暂缓计入抽奖任务进度' : ''}`)
      return order
    },

    // 用户申诉（仅本人、且单据处于待审核/已申诉可补充）
    appealRisk(orderId, reason) {
      this.syncBusinessDay()
      const o = this.riskOrders.find((x) => x.id === orderId)
      if (!o) return false
      if (this.role === 'operator') {
        this.showToast('运营视角无需申诉，请切换到用户视角', 'warn')
        return false
      }
      if (o.userId !== this.user.id) {
        this.showToast('只能对自己的单据申诉', 'warn')
        return false
      }
      if (o.status !== 'pending' && o.status !== 'appealed') {
        this.showToast('该单据已处理，无法申诉', 'warn')
        return false
      }
      if (!reason || !reason.trim()) {
        this.showToast('请填写申诉理由', 'warn')
        return false
      }
      o.status = 'appealed'
      o.appealReason = reason.trim()
      o.appealAt = `${this.todayDate} ${nowTime()}`
      this.addAuditLog('appeal', o.id, `用户提交申诉：${o.appealReason}`)
      this.showToast('申诉已提交，等待运营审核', 'success')
      return true
    },

    // 运营放行（幂等：仅 pending/appealed 可处理）
    releaseRisk(orderId, note = '') {
      this.syncBusinessDay()
      const o = this.riskOrders.find((x) => x.id === orderId)
      if (!o) return
      if (this.role !== 'operator') {
        this.showToast('仅运营可审核放行，请切换到运营视角', 'warn')
        return
      }
      if (o.status !== 'pending' && o.status !== 'appealed') {
        this.showToast('该单据已处理，请勿重复操作', 'warn')
        return
      }
      const rec = this.records.find((r) => r.id === o.recordId)
      if (!rec) {
        this.showToast('关联业务记录缺失，无法处理', 'warn')
        return
      }

      if (o.bizType === 'draw') {
        // 核销预占库存（remain 已扣，仅清 frozen）
        if (o.stockHeld) {
          const act = this.activities.find((a) => a.id === o.activityId)
          const prize = act?.prizes.find((p) => p.id === o.targetId)
          if (prize) prize.frozen = Math.max(0, prize.frozen - 1)
          this.addStockMove('release', {
            targetType: 'prize', targetId: o.targetId, targetName: o.targetName, activityId: o.activityId,
            deltaHeld: 0, deltaFrozen: -1, refType: 'riskOrder', refId: o.id,
            bizDate: rec.date, date: this.todayDate,
            note: `审核放行核销预占（归属业务日 ${rec.date}）`
          })
        }
        // 积分奖品此刻才入账
        const n = parseInt(o.targetName) || 0
        if (o.targetName.includes('积分') && n > 0) {
          this.points += n
          this.addPointRecord(n, `审核放行：抽奖奖品【${o.targetName}】`, 'release',
            { bizDate: rec.date, refType: 'record', refId: rec.id })
        }
      } else {
        const g = this.goods.find((x) => x.id === o.targetId)
        if (g) {
          g.frozen = Math.max(0, g.frozen - 1)
          this.addStockMove('release', {
            targetType: 'goods', targetId: o.targetId, targetName: o.targetName,
            deltaHeld: 0, deltaFrozen: -1, refType: 'riskOrder', refId: o.id,
            bizDate: rec.date, date: this.todayDate,
            note: `审核放行核销预占（归属业务日 ${rec.date}）`
          })
        }
      }

      o.status = 'released'
      o.reviewNote = note
      o.reviewer = this.user.name
      o.reviewedAt = `${this.todayDate} ${nowTime()}`
      rec.status = 'released'
      this.addAuditLog('release', o.id,
        `放行${o.bizType === 'draw' ? '抽奖' : '兑换'}【${o.targetName}】${note ? '；备注：' + note : ''}`)
      this.showToast(`已放行【${o.targetName}】`, 'success')
      // 抽奖放行后按记录归属业务日补计任务进度（跨日审核不串当日账，幂等防重复发奖）
      if (o.bizType === 'draw') this.settleDrawTasks(rec.date)
    },

    // 运营撤销：返还积分、回补库存、业务记录作废（幂等）
    revokeRisk(orderId, note = '') {
      this.syncBusinessDay()
      const o = this.riskOrders.find((x) => x.id === orderId)
      if (!o) return
      if (this.role !== 'operator') {
        this.showToast('仅运营可审核撤销，请切换到运营视角', 'warn')
        return
      }
      if (o.status !== 'pending' && o.status !== 'appealed') {
        this.showToast('该单据已处理，请勿重复操作', 'warn')
        return
      }
      const rec = this.records.find((r) => r.id === o.recordId)
      if (!rec) {
        this.showToast('关联业务记录缺失，无法处理', 'warn')
        return
      }

      // 返还冻结的成本积分
      if (o.frozenPoints > 0) {
        this.points += o.frozenPoints
        this.addPointRecord(o.frozenPoints,
          `撤销返还：${o.bizType === 'draw' ? '抽奖' : '兑换'}【${o.targetName}】`, 'refund',
          { bizDate: rec.date, refType: 'record', refId: rec.id })
      }
      // 回补库存（remain 回补 + frozen 释放）
      if (o.bizType === 'draw') {
        if (o.stockHeld) {
          const act = this.activities.find((a) => a.id === o.activityId)
          const prize = act?.prizes.find((p) => p.id === o.targetId)
          if (prize) {
            prize.frozen = Math.max(0, prize.frozen - 1)
            prize.remain += 1
            this.addStockMove('revoke', {
              targetType: 'prize', targetId: o.targetId, targetName: o.targetName, activityId: o.activityId,
              deltaHeld: +1, deltaFrozen: -1, refType: 'riskOrder', refId: o.id,
              bizDate: rec.date, date: this.todayDate,
              note: `审核撤销回补库存（归属业务日 ${rec.date}）`
            })
          }
        }
      } else {
        const g = this.goods.find((x) => x.id === o.targetId)
        if (g) {
          g.frozen = Math.max(0, g.frozen - 1)
          g.remain += 1
          this.addStockMove('revoke', {
            targetType: 'goods', targetId: o.targetId, targetName: g.name,
            deltaHeld: +1, deltaFrozen: -1, refType: 'riskOrder', refId: o.id,
            bizDate: rec.date, date: this.todayDate,
            note: `审核撤销回补库存（归属业务日 ${rec.date}）`
          })
        }
      }

      o.status = 'revoked'
      o.reviewNote = note
      o.reviewer = this.user.name
      o.reviewedAt = `${this.todayDate} ${nowTime()}`
      rec.status = 'revoked'
      this.addAuditLog('revoke', o.id,
        `撤销${o.bizType === 'draw' ? '抽奖' : '兑换'}【${o.targetName}】，返还${o.frozenPoints}积分${o.stockHeld ? `、回补库存×${o.stockHeld}` : ''}${o.bizType === 'draw' ? '；该笔不计入抽奖任务进度（冻结期间暂缓，撤销后确认回退）' : ''}${note ? '；备注：' + note : ''}`)
      this.showToast(`已撤销【${o.targetName}】，积分与库存已返还`, 'info')
    },

    // ===== 积分库存对账（按业务日） =====
    // 三方独立来源交叉核对（避免"自己证自己"）：
    //  1) 业务台账：records / riskOrders / taskClaims（抽奖、兑换、任务奖励、冻结的业务事实）
    //  2) 积分账册：pointRecords（append-only，按归属业务日 bizDate，跨日审核各记各的账）
    //  3) 库存账册：stockLedger（append-only 库存流水）+ 实时 remain/frozen 计数
    // 幂等：同一业务日复用一张 reconJob；重复执行对未处理差异重算——
    //   重核一致自动核销；已补偿差异把补偿流水计入账侧后必然收敛，不重复产生差异/补偿。
    // 跨日：历史业务日可补核对；补偿执行日落 todayDate、归属业务日保留 bizDate，不串当日账。
    reconcile(bizDate) {
      this.syncBusinessDay()
      if (this.role !== 'operator') {
        this.showToast('仅运营可执行对账，请切换到运营视角', 'warn')
        return null
      }
      const date = bizDate || this.todayDate
      let job = this.reconJobs.find((j) => j.bizDate === date)
      const isNew = !job
      if (isNew) {
        job = {
          id: genId('recon'),
          bizDate: date,
          status: 'pending',
          createdAt: this.todayDate,
          createdTime: nowTime(),
          ts: Date.now(),
          lastRunAt: '',
          runs: 0,
          operator: this.user.name,
          summary: {}
        }
        this.reconJobs.unshift(job)
      }

      const candidates = this.buildReconChecks(date)
      const existing = this.reconDiffs.filter((d) => d.jobId === job.id)
      const byKey = new Map(existing.filter((d) => d.status !== 'balanced').map((d) => [d.checkKey, d]))

      candidates.forEach((c) => {
        const old = byKey.get(c.checkKey)
        if (c.delta === 0) {
          if (old && old.status === 'pending') {
            old.status = 'balanced'
            old.expected = c.expected
            old.actual = c.actual
            old.delta = 0
            old.resolvedAt = `${this.todayDate} ${nowTime()}`
            old.resolutionNote = '重复执行对账：账实已一致，自动核销（原始差异快照保留）'
          }
          return
        }
        if (!old) {
          this.reconDiffs.unshift({
            id: genId('diff'),
            jobId: job.id,
            bizDate: date,
            category: c.category,
            checkKey: c.checkKey,
            metric: c.metric,
            targetType: c.targetType || null,
            targetId: c.targetId || null,
            targetName: c.targetName || '',
            activityId: c.activityId || null,
            refType: c.refType || '',
            refId: c.refId || '',
            expected: c.expected,
            actual: c.actual,
            delta: c.delta,
            evidence: c.evidence || [],
            origExpected: c.expected,
            origActual: c.actual,
            status: 'pending',
            createdAt: this.todayDate,
            time: nowTime(),
            ts: Date.now(),
            resolvedAt: '',
            resolutionNote: '',
            reviewer: ''
          })
        } else if (old.status === 'pending' && (old.expected !== c.expected || old.actual !== c.actual)) {
          // 保留首次快照（orig*），更新最新账实值供复核参考
          old.expected = c.expected
          old.actual = c.actual
          old.delta = c.delta
          old.evidence = c.evidence || old.evidence
        }
      })

      // 任务单状态：无待复核差异即为已核平（已补偿/已挂账/重核一致均算处理完毕）
      const diffs = this.reconDiffs.filter((d) => d.jobId === job.id)
      const pending = diffs.filter((d) => d.status === 'pending')
      job.status = pending.length ? 'pending' : 'balanced'
      job.runs += 1
      job.lastRunAt = `${this.todayDate} ${nowTime()}`
      job.operator = this.user.name
      job.summary = this.buildReconSummary(date, candidates, diffs)

      this.addAuditLog('recon-run', job.id,
        `${isNew ? '生成' : '重新执行'}业务日 ${date} 对账：${job.summary.checks} 项核对，` +
        `${job.summary.diffs} 项差异待复核（重复执行幂等，不重复补偿）${date !== this.todayDate ? '，跨日补核（补偿将计入执行日流水、保留归属业务日）' : ''}`)
      if (pending.length) {
        this.showToast(`📋 业务日 ${date} 对账完成：${pending.length} 项差异待运营复核`, 'warn')
      } else {
        this.showToast(`✅ 业务日 ${date} 对账完成：账实一致`, 'success')
      }
      return job
    },

    // 汇总某业务日的全部核对项（含账实值与证据，供任务单详情展示）
    buildReconSummary(date, candidates, diffs) {
      const sum = (key) => candidates.filter((c) => c.flowKey === key).reduce((s, c) => s + (c.flowAmount || 0), 0)
      return {
        checks: candidates.length,
        balanced: candidates.length - diffs.filter((d) => d.status === 'pending').length,
        diffs: diffs.filter((d) => d.status === 'pending').length,
        drawCount: this.records.filter((r) => r.type === 'draw' && r.date === date && r.status !== 'revoked').length,
        redeemCount: this.records.filter((r) => r.type === 'redeem' && r.date === date && r.status !== 'revoked').length,
        drawCost: -sum('drawCost'),
        drawReward: sum('drawReward'),
        redeemCost: -sum('redeemCost'),
        taskReward: sum('task'),
        pointsOut: sum('drawReward') + sum('task'),
        pointsIn: -(sum('drawCost') + sum('redeemCost')),
        stockOut: candidates.filter((c) => c.flowKey === 'stockFlow').reduce((s, c) => s + Math.abs(c.expected || 0), 0)
      }
    },

    // 计算某业务日的全部核对项；actual 已包含既往已采纳补偿（delta 收敛，重复补偿为 0）
    buildReconChecks(date) {
      const checks = []
      const isToday = date === this.todayDate
      const push = (c) => {
        c.delta = c.expected - c.actual
        checks.push(c)
      }
      const compSum = (checkKey, field) =>
        this.reconCompensations
          .filter((x) => x.checkKey === checkKey && x.kind === 'compensate')
          .reduce((s, x) => s + (x[field] || 0), 0)
      const pointRows = (pred) =>
        this.pointRecords.filter((p) => p.bizDate === date && p.kind !== 'recon' && pred(p))
      const rowNet = (recId, kinds) =>
        pointRows((p) => p.refId === recId && kinds.includes(p.kind))
          .reduce((s, p) => s + p.delta, 0)

      // —— 1) 抽奖逐笔核对：积分成本、积分奖品（业务台账 vs 积分流水，按笔可追溯） ——
      this.records.filter((r) => r.type === 'draw' && r.date === date).forEach((r) => {
        const act = this.activities.find((a) => a.id === r.activityId)
        const cost = act?.costType === 'points' ? act.cost || 0 : 0
        const costKey = `points:drawCost:${r.id}`
        const expCost = r.status === 'revoked' ? 0 : -cost
        const actCost = rowNet(r.id, ['normal', 'frozen', 'refund']) + compSum(costKey, 'delta')
        push({
          category: 'points', checkKey: costKey, metric: '抽奖积分成本', flowKey: 'drawCost', flowAmount: expCost,
          targetName: r.prizeName, activityId: r.activityId, refType: 'record', refId: r.id,
          expected: expCost, actual: actCost,
          evidence: [
            `业务记录 ${r.id}：${r.activityName} · 状态${({ normal: '正常', frozen: '审核中', released: '已放行', revoked: '已撤销' })[r.status]}` +
            (cost ? `，成本 ${cost} 积分` : '，免费参与'),
            '积分流水：同笔 normal/frozen/refund 净额（撤销返还计入，跨日补行按归属业务日）'
          ]
        })
        if (r.rarity !== 'none' || r.prizeName.includes('积分')) {
          const n = r.prizeName.includes('积分') ? parseInt(r.prizeName) || 0 : 0
          const rewKey = `points:drawReward:${r.id}`
          const expReward = (r.status === 'normal' || r.status === 'released') ? n : 0
          const actReward = rowNet(r.id, ['reward', 'release']) + compSum(rewKey, 'delta')
          push({
            category: 'points', checkKey: rewKey, metric: '抽奖积分奖品', flowKey: 'drawReward', flowAmount: expReward,
            targetName: r.prizeName, activityId: r.activityId, refType: 'record', refId: r.id,
            expected: expReward, actual: actReward,
            evidence: [
              `业务记录 ${r.id}：奖品【${r.prizeName}】，正常/放行应入账 +${n}，审核中/撤销不入账`,
              '积分流水：同笔 reward/release 净额（放行积分奖品跨日按归属业务日补计）'
            ]
          })
        }
      })

      // —— 2) 兑换逐笔核对：积分成本 ——
      this.records.filter((r) => r.type === 'redeem' && r.date === date).forEach((r) => {
        const g = this.goods.find((x) => x.id === r.goodsId)
        const cost = g?.cost || 0
        const key = `points:redeemCost:${r.id}`
        const expected = r.status === 'revoked' ? 0 : -cost
        const actual = rowNet(r.id, ['normal', 'frozen', 'refund']) + compSum(key, 'delta')
        push({
          category: 'points', checkKey: key, metric: '兑换积分成本', flowKey: 'redeemCost', flowAmount: expected,
          targetType: 'goods', targetId: r.goodsId, targetName: r.goodsName, refType: 'record', refId: r.id,
          expected, actual,
          evidence: [
            `业务记录 ${r.id}：积分商城【${r.goodsName}】· 状态${({ normal: '正常', frozen: '审核中', released: '已放行', revoked: '已撤销' })[r.status]}，价格 ${cost} 积分`,
            '积分流水：同笔 normal/frozen/refund 净额（撤销返还计入）'
          ]
        })
      })

      // —— 3) 任务奖励核对：自动结算台账 vs 任务结算流水（仅抽奖任务自动结算笔，跨日补计计入归属日） ——
      const claims = this.taskClaims.filter((c) => c.bizDate === date)
      if (claims.length) {
        const key = `points:task:${date}`
        const expected = claims.reduce((s, c) => s + c.reward, 0)
        const ledgerTask = pointRows((p) => p.kind === 'reward' && p.note.startsWith('任务结算：'))
          .reduce((s, p) => s + p.delta, 0)
        push({
          category: 'points', checkKey: key, metric: '任务奖励', flowKey: 'task', flowAmount: expected,
          expected, actual: ledgerTask + compSum(key, 'delta'),
          evidence: [
            ...claims.map((c) => `任务结算台账 ${c.id}：【${c.taskLabel}】+${c.reward}（归属 ${c.bizDate}，发放 ${c.grantDate}）`),
            '积分流水：当日归属的「任务结算」reward 行合计'
          ]
        })
      }

      // —— 4) 当日库存出库核对：业务记录净消耗 vs 库存流水（hold/release/revoke 净额；运营重置单独留痕不计入） ——
      const stockFlow = new Map()
      this.records.filter((r) => r.date === date && r.status !== 'revoked' &&
        ((r.type === 'draw' && r.rarity !== 'none') || r.type === 'redeem')).forEach((r) => {
        const isGoods = r.type === 'redeem'
        const k = isGoods ? `g:${r.goodsId}` : `p:${r.activityId}:${r.prizeId}`
        if (!stockFlow.has(k)) {
          stockFlow.set(k, {
            targetType: isGoods ? 'goods' : 'prize',
            targetId: isGoods ? r.goodsId : r.prizeId,
            activityId: isGoods ? null : r.activityId,
            targetName: isGoods ? r.goodsName : r.prizeName,
            expected: 0
          })
        }
        stockFlow.get(k).expected -= 1
      })
      this.stockLedger.filter((m) => m.bizDate === date &&
        ['hold', 'release', 'revoke'].includes(m.kind)).forEach((m) => {
        const k = m.targetType === 'goods' ? `g:${m.targetId}` : `p:${m.activityId}:${m.targetId}`
        if (!stockFlow.has(k)) {
          stockFlow.set(k, {
            targetType: m.targetType, targetId: m.targetId, activityId: m.activityId,
            targetName: m.targetName, expected: 0, ledger: 0
          })
        }
        const row = stockFlow.get(k)
        row.ledger = (row.ledger || 0) + m.deltaHeld
      })
      stockFlow.forEach((v, k) => {
        const key = `stock:flow:${date}:${k}`
        push({
          category: 'stock', checkKey: key, metric: '库存净消耗', flowKey: 'stockFlow',
          targetType: v.targetType, targetId: v.targetId, targetName: v.targetName, activityId: v.activityId,
          expected: v.expected,
          actual: (v.ledger || 0) + compSum(key, 'deltaHeld'),
          evidence: [
            `业务台账：当日正常/审核中/放行各计 1 件出库，撤销净 0（预占 + 回补相抵）`,
            `库存流水：hold/release/revoke 当日 deltaHeld 净额 = ${v.ledger || 0}`
          ]
        })
      })

      // —— 实时账核对（当前余额/库存是实时值，仅在当日任务单核对；历史日以流水核对为准） ——
      if (isToday) {
        // 5) 积分余额：全部积分流水（含建账、既往补偿）重放 vs 实时可用余额
        const base = this.pointRecords.filter((p) => p.kind !== 'recon').reduce((s, p) => s + p.delta, 0)
        const ptsComp = compSum('points:balance', 'delta')
        push({
          category: 'points', checkKey: 'points:balance', metric: '积分余额',
          targetName: '可用积分', expected: base + ptsComp, actual: this.points,
          evidence: [
            '账册重放：全部积分流水（含历史余额建账，不含当次待补偿）净额',
            `业务余额：实时可用积分 ${this.points}（冻结部分不计入）`
          ]
        })

        // 6) 冻结积分：待处理审核单冻结合计 vs 冻结流水（逐单关联）
        const pendingOrders = this.riskOrders.filter((o) => o.status === 'pending' || o.status === 'appealed')
        const expFrozen = pendingOrders.reduce((s, o) => s + (o.frozenPoints || 0), 0)
        const ledgerFrozen = this.pointRecords.filter((p) => p.kind === 'frozen')
          .filter((p) => {
            const rec = this.records.find((r) => r.id === p.refId)
            const order = rec && this.riskOrders.find((o) => o.id === rec.riskOrderId)
            return order && (order.status === 'pending' || order.status === 'appealed')
          })
          .reduce((s, p) => s + Math.abs(p.delta), 0)
        push({
          category: 'frozenPoints', checkKey: 'points:frozen', metric: '冻结积分',
          targetName: '冻结积分', expected: expFrozen + compSum('points:frozen', 'delta'), actual: ledgerFrozen,
          evidence: [
            `审核单台账：待审核/已申诉单据冻结积分合计 ${expFrozen}（跨日未审结单仍占用）`,
            '积分流水：上述单据关联的 frozen 冻结行合计'
          ]
        })

        // 7) 库存余量守恒：初始库存 + 库存流水重放（含既往补偿）vs 实时 remain
        const allTargets = [
          ...this.activities.flatMap((a) => a.prizes
            .filter((p) => p.rarity !== 'none')
            .map((p) => ({ targetType: 'prize', targetId: p.id, targetName: p.name, activityId: a.id, stock: p.stock, live: p.remain, liveFrozen: p.frozen }))),
          ...this.goods.map((g) => ({ targetType: 'goods', targetId: g.id, targetName: g.name, activityId: null, stock: g.stock, live: g.remain, liveFrozen: g.frozen }))
        ]
        allTargets.forEach((t) => {
          const k = t.targetType === 'goods' ? `g:${t.targetId}` : `p:${t.activityId}:${t.targetId}`
          const moves = this.stockLedger.filter((m) =>
            m.targetType === t.targetType &&
            m.targetId === t.targetId &&
            (t.targetType === 'goods' || m.activityId === t.activityId))
          const heldBase = moves.filter((m) => !['init', 'recon'].includes(m.kind)).reduce((s, m) => s + m.deltaHeld, 0)
          const heldKey = `stock:held:${k}`
          push({
            category: 'stock', checkKey: heldKey, metric: '库存余量守恒',
            targetType: t.targetType, targetId: t.targetId, targetName: t.targetName, activityId: t.activityId,
            expected: t.stock + heldBase + compSum(heldKey, 'deltaHeld'), actual: t.live,
            evidence: [
              `账册重放：初始库存 ${t.stock} + 非建账/非补偿库存流水净额 ${heldBase}`,
              `实时账面：可售余量 remain = ${t.live}`
            ]
          })
          const fzBase = moves.filter((m) => m.kind !== 'recon').reduce((s, m) => s + m.deltaFrozen, 0)
          const fzKey = `stock:frozenLedger:${k}`
          push({
            category: 'stock', checkKey: fzKey, metric: '预占库存（账册）',
            targetType: t.targetType, targetId: t.targetId, targetName: t.targetName, activityId: t.activityId,
            expected: fzBase + compSum(fzKey, 'deltaFrozen'), actual: t.liveFrozen,
            evidence: [
              `账册重放：库存流水 deltaFrozen 净额 ${fzBase}（预占 +1，核销/回补 -1）`,
              `实时账面：frozen 预占 = ${t.liveFrozen}`
            ]
          })
          const bizFrozen = pendingOrders
            .filter((o) => o.targetId === t.targetId &&
              (t.targetType === 'goods'
                ? o.bizType === 'redeem'
                : o.bizType === 'draw' && o.activityId === t.activityId))
            .reduce((s, o) => s + (o.stockHeld || 0), 0)
          const bizKey = `stock:frozenBiz:${k}`
          push({
            category: 'stock', checkKey: bizKey, metric: '预占库存（业务台账）',
            targetType: t.targetType, targetId: t.targetId, targetName: t.targetName, activityId: t.activityId,
            expected: bizFrozen, actual: t.liveFrozen + compSum(bizKey, 'deltaFrozen'),
            evidence: [
              `审核单台账：待处理单据对【${t.targetName}】的预占件数 ${bizFrozen}`,
              `实时账面：frozen 预占 = ${t.liveFrozen}`
            ]
          })
        })
      }

      return checks
    },

    // 运营复核：通过补偿流水修正账目（原始记录不改写；补偿本身 append-only，重复执行幂等收敛）
    compensateDiff(diffId, note = '') {
      this.syncBusinessDay()
      if (this.role !== 'operator') {
        this.showToast('仅运营可执行补偿，请切换到运营视角', 'warn')
        return false
      }
      const d = this.reconDiffs.find((x) => x.id === diffId)
      if (!d) return false
      if (d.status !== 'pending') {
        this.showToast('该差异已处理，请勿重复操作', 'warn')
        return false
      }
      // 以最新账实值重算一次（防止复核期间账目又变动）
      const fresh = this.buildReconChecks(d.bizDate).find((c) => c.checkKey === d.checkKey)
      const delta = fresh ? fresh.delta : d.delta
      if (delta === 0) {
        d.status = 'balanced'
        d.expected = fresh.expected
        d.actual = fresh.actual
        d.delta = 0
        d.resolvedAt = `${this.todayDate} ${nowTime()}`
        d.resolutionNote = '补偿前重核已一致，自动核销，未产生补偿流水'
        d.reviewer = this.user.name
        this.refreshReconJob(d.jobId)
        this.showToast('该差异已自行消失，重核一致自动核销', 'info')
        return true
      }

      const comp = {
        id: genId('comp'),
        diffId: d.id,
        jobId: d.jobId,
        checkKey: d.checkKey,
        kind: 'compensate',
        nature: d.category,             // points | frozenPoints | stock
        bizDate: d.bizDate,             // 归属业务日（跨日补偿保留归属）
        date: this.todayDate,           // 实际执行日
        time: nowTime(),
        ts: Date.now(),
        delta: 0,
        deltaHeld: 0,
        deltaFrozen: 0,
        targetType: d.targetType,
        targetId: d.targetId,
        targetName: d.targetName,
        activityId: d.activityId,
        refType: 'diff',
        refId: d.id,
        note: note || '运营复核后补偿修正',
        operator: this.user.name
      }

      if (d.category === 'points' || d.category === 'frozenPoints') {
        comp.delta = delta
        this.points += delta
        const label = d.category === 'frozenPoints' ? '冻结积分' : '积分'
        this.addPointRecord(delta,
          `对账补偿：${label}差异修正【${d.targetName}】（归属 ${d.bizDate}）`, 'recon',
          { bizDate: d.bizDate, refType: 'diff', refId: d.id })
      } else {
        // 库存补偿：余量类修 remain、预占类修 frozen，流水留痕
        if (d.metric.includes('余量') || d.metric.includes('净消耗')) {
          comp.deltaHeld = delta
          const t = this.findStockTarget(d.targetType, d.targetId, d.activityId)
          if (t) t.remain = Math.max(0, t.remain + delta)
        } else {
          comp.deltaFrozen = delta
          const t = this.findStockTarget(d.targetType, d.targetId, d.activityId)
          if (t) t.frozen = Math.max(0, t.frozen + delta)
        }
        this.addStockMove('recon', {
          targetType: d.targetType, targetId: d.targetId, targetName: d.targetName, activityId: d.activityId,
          deltaHeld: comp.deltaHeld, deltaFrozen: comp.deltaFrozen,
          refType: 'diff', refId: d.id, bizDate: d.bizDate, date: this.todayDate,
          note: `对账补偿：${d.metric}差异修正（归属 ${d.bizDate}）${note ? '；' + note : ''}`
        })
      }

      this.reconCompensations.unshift(comp)
      d.status = 'compensated'
      d.delta = delta
      d.resolvedAt = `${this.todayDate} ${nowTime()}`
      d.resolutionNote = `补偿流水 ${comp.id}：${note || '账实差异修正'}` +
        (d.bizDate !== this.todayDate ? `（跨日补偿，执行日 ${this.todayDate}）` : '')
      d.reviewer = this.user.name
      this.refreshReconJob(d.jobId)

      this.addAuditLog('recon-compensate', d.id,
        `业务日 ${d.bizDate}「${d.metric}·${d.targetName}」差异：账面 ${d.origActual} → 台账应有 ${d.origExpected}，` +
        `运营复核通过补偿流水 ${comp.id} 修正 ${d.category === 'stock' ? `库存 ${comp.deltaHeld || comp.deltaFrozen} 件` : `${delta} 积分`}，原始记录保留`)
      this.showToast(`🛠️ 已通过补偿流水修正【${d.targetName}】，原始记录保留可追溯`, 'success')
      return true
    },

    // 运营复核：差异挂账（确认为合理差异/暂不修正，不产生补偿，留痕待后续跟进）
    waiveDiff(diffId, note = '') {
      if (this.role !== 'operator') {
        this.showToast('仅运营可操作，请切换到运营视角', 'warn')
        return false
      }
      const d = this.reconDiffs.find((x) => x.id === diffId)
      if (!d || d.status !== 'pending') {
        this.showToast(d ? '该差异已处理，请勿重复操作' : '差异单不存在', 'warn')
        return false
      }
      d.status = 'waived'
      d.resolvedAt = `${this.todayDate} ${nowTime()}`
      d.resolutionNote = `挂账保留：${note || '运营确认为合理差异，暂不修正'}` +
        (d.bizDate !== this.todayDate ? `（跨日复核，归属业务日 ${d.bizDate}）` : '')
      d.reviewer = this.user.name
      this.reconCompensations.unshift({
        id: genId('comp'), diffId: d.id, jobId: d.jobId, checkKey: d.checkKey,
        kind: 'waive', nature: d.category, bizDate: d.bizDate, date: this.todayDate,
        time: nowTime(), ts: Date.now(), delta: 0, deltaHeld: 0, deltaFrozen: 0,
        targetType: d.targetType, targetId: d.targetId, targetName: d.targetName, activityId: d.activityId,
        refType: 'diff', refId: d.id, note: d.resolutionNote, operator: this.user.name
      })
      this.refreshReconJob(d.jobId)
      this.addAuditLog('recon-waive', d.id,
        `业务日 ${d.bizDate}「${d.metric}·${d.targetName}」差异挂账：台账应有 ${d.expected}，账面 ${d.actual}；${d.resolutionNote}`)
      this.showToast('差异已挂账保留，未修改账目，记录可追溯', 'info')
      return true
    },

    findStockTarget(targetType, targetId, activityId) {
      if (targetType === 'goods') return this.goods.find((g) => g.id === targetId)
      const act = this.activities.find((a) => a.id === activityId)
      return act?.prizes.find((p) => p.id === targetId) || null
    },

    // 补偿/挂账/自动核销后刷新任务单状态与汇总
    refreshReconJob(jobId) {
      const job = this.reconJobs.find((j) => j.id === jobId)
      if (!job) return
      const diffs = this.reconDiffs.filter((d) => d.jobId === jobId)
      const candidates = this.buildReconChecks(job.bizDate)
      job.status = diffs.some((d) => d.status === 'pending') ? 'pending' : 'balanced'
      job.summary = this.buildReconSummary(job.bizDate, candidates, diffs)
      job.lastRunAt = `${this.todayDate} ${nowTime()}`
    },

    // 更新风控规则（仅运营）
    updateRiskRules(patch) {
      if (this.role !== 'operator') {
        this.showToast('仅运营可配置风控规则', 'warn')
        return false
      }
      const before = this.riskRules
      this.riskRules = { ...this.riskRules, ...patch }
      const changes = []
      Object.keys(patch).forEach((k) => {
        if (JSON.stringify(before[k]) !== JSON.stringify(patch[k])) {
          changes.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(patch[k])}`)
        }
      })
      this.addAuditLog('config', null, changes.length ? `调整规则：${changes.join('；')}` : '规则配置已保存（无变化）')
      this.showToast('风控规则已更新', 'success')
      return true
    },

    saveDayLog() {
      // 业务动作落账前确保业务日一致（统一走业务日切换）
      this.syncBusinessDay()
      return true
    },

    // ===== 活动运营管理 =====
    toggleActivityStatus(id) {
      const a = this.activities.find((x) => x.id === id)
      if (!a) return
      const map = { running: 'paused', paused: 'running', ended: 'running' }
      a.status = map[a.status]
      this.showToast(`活动【${a.name}】已${a.status === 'running' ? '恢复/启动' : a.status === 'paused' ? '暂停' : '结束'}`, 'info')
    },
    resetActivityStock(id) {
      const a = this.activities.find((x) => x.id === id)
      if (!a) return
      // 重置时不动审核中预占的库存：remain 恢复为 总库存 - 冻结预占
      a.prizes.forEach((p) => {
        const before = p.remain
        p.remain = p.stock - (p.frozen || 0)
        if (p.rarity !== 'none' && p.remain !== before) {
          this.addStockMove('reset', {
            targetType: 'prize', targetId: p.id, targetName: p.name, activityId: a.id,
            deltaHeld: p.remain - before, deltaFrozen: 0,
            refType: 'activity', refId: a.id, note: `运营重置库存（保留预占 ${p.frozen || 0} 件）`
          })
        }
      })
      this.addAuditLog('stock-reset', id, `活动【${a.name}】奖品库存已重置（风控预占保留）`)
      this.showToast(`活动【${a.name}】奖品库存已恢复（风控预占保留）`, 'success')
    },
    createActivity(payload) {
      const id = 'act-' + Date.now().toString().slice(-5)
      const act = {
        id,
        name: payload.name,
        type: payload.type,
        status: 'running',
        cost: payload.cost || 0,
        costType: payload.costType || 'free',
        dailyLimit: payload.dailyLimit || 3,
        totalLimit: payload.totalLimit || 50,
        icon: '🎪',
        desc: payload.desc || '新活动',
        startAt: payload.startAt || this.todayDate,
        endAt: payload.endAt || this.todayDate,
        prizes: (payload.prizes || []).map((p, i) => ({
          id: 'p' + i + '-' + id,
          name: p.name,
          rarity: p.rarity || 'common',
          stock: p.stock || 10,
          remain: p.stock || 10,
          frozen: 0,
          weight: p.weight || 10,
          emoji: p.emoji || '🎁'
        }))
      }
      // 确保含"谢谢参与"
      if (!act.prizes.some((p) => p.rarity === 'none')) {
        act.prizes.push({ id: 'p-none-' + id, name: '谢谢参与', rarity: 'none', stock: 99999, remain: 99999, frozen: 0, weight: 100, emoji: '🤝' })
      }
      this.activities.unshift(act)
      // 库存建账流水（append-only）
      act.prizes.forEach((p) => {
        if (p.rarity === 'none') return
        this.addStockMove('init', {
          targetType: 'prize', targetId: p.id, targetName: p.name, activityId: act.id,
          deltaHeld: p.stock, deltaFrozen: 0,
          refType: 'activity', refId: act.id, note: `新建活动建账：初始库存 ${p.stock}`
        })
      })
      this.showToast(`活动【${act.name}】创建成功`, 'success')
      return act
    },

    // ===== 演示数据：预置审核单 / 冻结积分 / 预占库存 =====
    seedRiskData() {
      const uid = this.user.id
      const uname = this.user.name
      const DAY = 86400000
      const d1Seed = dateStr(-1)
      const d2Seed = dateStr(-2)
      // 期初建账：可用积分 465（d2 00:00）。此后种子业务全部按真实语义变更 points，
      // 期末可用 = 465 +15(任务) -80 +80(视频周卡撤销配对) -200(福袋冻结) -10(月卡冻结) -10(跨日月卡) = 260。
      // 对账"余额核对"以积分流水全量重放为账侧依据（建账行 + 全部流水 == 实时 points）。
      this.points = 465
      this.pointRecords.unshift({
        id: 'seed-pr-open', date: d2Seed, bizDate: d2Seed, time: '00:00:00', ts: todayAt(0, 0) - 2 * DAY - 1,
        delta: 465, balance: 465, note: '历史余额建账（期初积分）', kind: 'opening',
        refType: 'system', refId: 'init'
      })
      // —— 1) 待审核：传说大奖（10 积分成本 + 预占 iPhone） ——
      const a1 = this.activities.find((a) => a.id === 'act-1')
      const pLegend = a1?.prizes.find((p) => p.id === 'p1')
      if (pLegend) { pLegend.remain -= 1; pLegend.frozen += 1 }
      this.addStockMove('hold', {
        id: 'seed-sl1', targetType: 'prize', targetId: 'p1', targetName: 'iPhone 16', activityId: 'act-1',
        deltaHeld: -1, deltaFrozen: 1, refType: 'record', refId: 'seed-r1',
        date: this.todayDate, time: '10:02:15', ts: todayAt(10, 2),
        note: '风控预占：周年庆幸运转盘（审核中）'
      })
      const rec1 = {
        id: 'seed-r1', type: 'draw', status: 'frozen',
        date: this.todayDate, time: '10:02:15', ts: todayAt(10, 2),
        activityId: 'act-1', activityName: '周年庆幸运转盘',
        prizeId: 'p1', prizeName: 'iPhone 16', rarity: 'legendary', icon: '📱',
        riskOrderId: 'seed-rk1'
      }
      this.records.push(rec1)
      this.riskOrders.push({
        id: 'seed-rk1', bizType: 'draw', status: 'pending', userId: uid, userName: uname,
        recordId: rec1.id, activityId: 'act-1', targetId: 'p1', targetName: 'iPhone 16',
        icon: '📱', rarity: 'legendary', frozenPoints: 0, stockHeld: 1,
        rules: [{ code: 'highValue', label: RULE_LABELS.highValue }],
        appealReason: '', appealAt: '', reviewNote: '', reviewer: '',
        createdAt: this.todayDate, time: '10:02:15', ts: todayAt(10, 2), reviewedAt: ''
      })

      // —— 2) 已申诉：刮刮乐史诗（10 积分成本冻结 + 预占视频月卡） ——
      const a2 = this.activities.find((a) => a.id === 'act-2')
      const pEpic = a2?.prizes.find((p) => p.id === 'p2')
      if (pEpic) { pEpic.remain -= 2; pEpic.frozen += 2 }
      this.addStockMove('hold', {
        id: 'seed-sl2', targetType: 'prize', targetId: 'p2', targetName: '视频月卡', activityId: 'act-2',
        deltaHeld: -1, deltaFrozen: 1, refType: 'record', refId: 'seed-r2',
        date: this.todayDate, time: '09:40:08', ts: todayAt(9, 40),
        note: '风控预占：新人刮刮乐（审核中）'
      })
      // 历史在途预占：另一笔视频月卡审核单（演示跨日未审结的冻结库存；对应审核单 seed-rk2b）
      this.addStockMove('hold', {
        id: 'seed-sl2b', targetType: 'prize', targetId: 'p2', targetName: '视频月卡', activityId: 'act-2',
        deltaHeld: -1, deltaFrozen: 1, refType: 'record', refId: 'seed-r2b',
        date: dateStr(-1), time: '19:20:11', ts: todayAt(19, 20) - 86400000,
        note: `风控预占：新人刮刮乐（审核中，归属业务日 ${dateStr(-1)}）`
      })
      this.points -= 10
      const rec2 = {
        id: 'seed-r2', type: 'draw', status: 'frozen',
        date: this.todayDate, time: '09:40:08', ts: todayAt(9, 40),
        activityId: 'act-2', activityName: '新人刮刮乐',
        prizeId: 'p2', prizeName: '视频月卡', rarity: 'epic', icon: '🎬',
        riskOrderId: 'seed-rk2'
      }
      this.records.push(rec2)
      this.riskOrders.push({
        id: 'seed-rk2', bizType: 'draw', status: 'appealed', userId: uid, userName: uname,
        recordId: rec2.id, activityId: 'act-2', targetId: 'p2', targetName: '视频月卡',
        icon: '🎬', rarity: 'epic', frozenPoints: 10, stockHeld: 1,
        rules: [{ code: 'highValue', label: RULE_LABELS.highValue }],
        appealReason: '本人正常参与活动中奖，未使用任何外挂，请求放行。',
        appealAt: `${this.todayDate} 09:45:30`, reviewNote: '', reviewer: '',
        createdAt: this.todayDate, time: '09:40:08', ts: todayAt(9, 40), reviewedAt: ''
      })
      this.pointRecords.unshift({
        id: 'seed-pr2', date: this.todayDate, bizDate: this.todayDate, time: '09:40:08', ts: todayAt(9, 40),
        delta: -10, balance: this.points, note: '冻结：参与【新人刮刮乐】待风控审核', kind: 'frozen',
        refType: 'record', refId: 'seed-r2'
      })
      // 跨日在途审核单：昨日视频月卡（10 积分成本冻结 + 预占 1 件，尚未审结，跨日仍占用）
      this.points -= 10
      this.records.push({
        id: 'seed-r2b', type: 'draw', status: 'frozen',
        date: dateStr(-1), time: '19:20:11', ts: todayAt(19, 20) - 86400000,
        activityId: 'act-2', activityName: '新人刮刮乐',
        prizeId: 'p2', prizeName: '视频月卡', rarity: 'epic', icon: '🎬',
        riskOrderId: 'seed-rk2b'
      })
      this.riskOrders.push({
        id: 'seed-rk2b', bizType: 'draw', status: 'pending', userId: uid, userName: uname,
        recordId: 'seed-r2b', activityId: 'act-2', targetId: 'p2', targetName: '视频月卡',
        icon: '🎬', rarity: 'epic', frozenPoints: 10, stockHeld: 1,
        rules: [{ code: 'highValue', label: RULE_LABELS.highValue }],
        appealReason: '', appealAt: '', reviewNote: '', reviewer: '',
        createdAt: dateStr(-1), time: '19:20:11', ts: todayAt(19, 20) - 86400000, reviewedAt: ''
      })
      this.pointRecords.unshift({
        id: 'seed-pr2b', date: dateStr(-1), bizDate: dateStr(-1), time: '19:20:11', ts: todayAt(19, 20) - 86400000,
        delta: -10, balance: this.points, note: '冻结：参与【新人刮刮乐】待风控审核', kind: 'frozen',
        refType: 'record', refId: 'seed-r2b'
      })

      // —— 3) 待审核：高价值兑换 盲盒福袋（200 积分冻结 + 预占 g4） ——
      const g4 = this.goods.find((g) => g.id === 'g4')
      if (g4) { g4.remain -= 1; g4.frozen += 1 }
      this.addStockMove('hold', {
        id: 'seed-sl3', targetType: 'goods', targetId: 'g4', targetName: '盲盒福袋',
        deltaHeld: -1, deltaFrozen: 1, refType: 'record', refId: 'seed-r3',
        date: this.todayDate, time: '09:15:22', ts: todayAt(9, 15),
        note: '风控预占：积分商城兑换（审核中）'
      })
      this.points -= 200
      const rec3 = {
        id: 'seed-r3', type: 'redeem', status: 'frozen',
        date: this.todayDate, time: '09:15:22', ts: todayAt(9, 15),
        goodsId: 'g4', goodsName: '盲盒福袋', icon: '🎁', riskOrderId: 'seed-rk3'
      }
      this.records.push(rec3)
      this.riskOrders.push({
        id: 'seed-rk3', bizType: 'redeem', status: 'pending', userId: uid, userName: uname,
        recordId: rec3.id, activityId: null, targetId: 'g4', targetName: '盲盒福袋',
        icon: '🎁', rarity: null, frozenPoints: 200, stockHeld: 1,
        rules: [{ code: 'highValue', label: RULE_LABELS.highValue },
                { code: 'rapidRedeem', label: RULE_LABELS.rapidRedeem }],
        appealReason: '', appealAt: '', reviewNote: '', reviewer: '',
        createdAt: this.todayDate, time: '09:15:22', ts: todayAt(9, 15), reviewedAt: ''
      })
      this.pointRecords.unshift({
        id: 'seed-pr3', date: this.todayDate, bizDate: this.todayDate, time: '09:15:22', ts: todayAt(9, 15),
        delta: -200, balance: this.points, note: '冻结：兑换【盲盒福袋】待风控审核', kind: 'frozen',
        refType: 'record', refId: 'seed-r3'
      })

      // —— 4) 已放行：500元购物卡（免费转盘，无积分冻结，库存已核销） ——
      // 注：另有昨日跨日在途预占 1 件（seed-r6 段处理），故该奖品 remain 在此共扣 2、frozen 1
      const pEpicCard = a1?.prizes.find((p) => p.id === 'p2')
      if (pEpicCard) { pEpicCard.remain -= 1 }
      this.addStockMove('release', {
        id: 'seed-sl4', targetType: 'prize', targetId: 'p2', targetName: '500元购物卡', activityId: 'act-1',
        deltaHeld: -1, deltaFrozen: 0, refType: 'record', refId: 'seed-r4',
        date: this.todayDate, time: '08:55:40', ts: todayAt(8, 55),
        note: '抽奖中奖出库：周年庆幸运转盘（审核放行）'
      })
      const rec4 = {
        id: 'seed-r4', type: 'draw', status: 'released',
        date: this.todayDate, time: '08:55:40', ts: todayAt(8, 55),
        activityId: 'act-1', activityName: '周年庆幸运转盘',
        prizeId: 'p2', prizeName: '500元购物卡', rarity: 'epic', icon: '💳',
        riskOrderId: 'seed-rk4'
      }
      this.records.push(rec4)
      this.riskOrders.push({
        id: 'seed-rk4', bizType: 'draw', status: 'released', userId: uid, userName: uname,
        recordId: rec4.id, activityId: 'act-1', targetId: 'p2', targetName: '500元购物卡',
        icon: '💳', rarity: 'epic', frozenPoints: 0, stockHeld: 0,
        rules: [{ code: 'highValue', label: RULE_LABELS.highValue }],
        appealReason: '系统误判，正常中奖。', appealAt: `${this.todayDate} 09:00:00`,
        reviewNote: '核实为正常用户，放行并发奖。', reviewer: '运营小张',
        createdAt: this.todayDate, time: '08:55:40', ts: todayAt(8, 55),
        reviewedAt: `${this.todayDate} 09:10:12`
      })

      // —— 5) 已撤销：视频会员周卡（80 积分冻结后撤销返还，净额 0；库存预占后回补，当前无占用） ——
      this.points -= 80
      this.pointRecords.unshift({
        id: 'seed-pr5b', date: this.todayDate, bizDate: this.todayDate, time: '08:30:05', ts: todayAt(8, 30),
        delta: -80, balance: 0, note: '冻结：兑换【视频会员周卡】待风控审核', kind: 'frozen',
        refType: 'record', refId: 'seed-r5'
      })
      this.addStockMove('hold', {
        id: 'seed-sl5h', targetType: 'goods', targetId: 'g2', targetName: '视频会员周卡',
        deltaHeld: -1, deltaFrozen: 1, refType: 'record', refId: 'seed-r5',
        date: this.todayDate, time: '08:30:05', ts: todayAt(8, 30),
        note: '风控预占：积分商城兑换（审核中）'
      })
      this.addStockMove('revoke', {
        id: 'seed-sl5', targetType: 'goods', targetId: 'g2', targetName: '视频会员周卡',
        deltaHeld: 1, deltaFrozen: -1, refType: 'riskOrder', refId: 'seed-rk5',
        date: this.todayDate, time: '08:35:00', ts: todayAt(8, 35),
        note: '审核撤销回补库存'
      })
      const rec5 = {
        id: 'seed-r5', type: 'redeem', status: 'revoked',
        date: this.todayDate, time: '08:30:05', ts: todayAt(8, 30),
        goodsId: 'g2', goodsName: '视频会员周卡', icon: '🎬', riskOrderId: 'seed-rk5'
      }
      this.records.push(rec5)
      this.riskOrders.push({
        id: 'seed-rk5', bizType: 'redeem', status: 'revoked', userId: uid, userName: uname,
        recordId: rec5.id, activityId: null, targetId: 'g2', targetName: '视频会员周卡',
        icon: '🎬', rarity: null, frozenPoints: 80, stockHeld: 0,
        rules: [{ code: 'rapidRedeem', label: RULE_LABELS.rapidRedeem }],
        appealReason: '', appealAt: '',
        reviewNote: '命中短时连续兑换规则，自动拦截，用户未申诉。', reviewer: '系统',
        createdAt: this.todayDate, time: '08:30:05', ts: todayAt(8, 30),
        reviewedAt: `${this.todayDate} 08:35:00`
      })
      this.points += 80
      this.pointRecords.unshift({
        id: 'seed-pr5', date: this.todayDate, bizDate: this.todayDate, time: '08:35:00', ts: todayAt(8, 35),
        delta: 80, balance: this.points, note: '撤销返还：兑换【视频会员周卡】', kind: 'refund',
        refType: 'record', refId: 'seed-r5'
      })

      // —— 6) 历史业务日台账：演示"按业务日保留进度与领奖记录 + 跨日审核补计" ——
      const d1 = d1Seed   // 上一业务日
      const d2 = d2Seed   // 前两业务日
      // 前两业务日：3 次有效参与（谢谢参与，无库存/积分变动）→ 当日任务已自动结算 +15
      ;[['08:10:02', 8, 10], ['08:11:15', 8, 11], ['08:12:40', 8, 12]].forEach(([time, h, m], i) => {
        this.records.push({
          id: `seed-rd2-${i}`, type: 'draw', status: 'normal',
          date: d2, time, ts: todayAt(h, m) - 2 * DAY,
          activityId: 'act-1', activityName: '周年庆幸运转盘',
          prizeId: 'p6', prizeName: '谢谢参与', rarity: 'none', icon: '🤝'
        })
      })
      this.taskClaims.push({
        id: 'seed-tc1', taskId: 't-draw3', taskLabel: '今日抽奖3次', reward: 15,
        bizDate: d2, grantDate: d2, time: '08:12:40', ts: todayAt(8, 12) - 2 * DAY, source: 'auto'
      })
      this.pointRecords.unshift({
        id: 'seed-pr1', date: d2, bizDate: d2, time: '08:12:40', ts: todayAt(8, 12) - 2 * DAY,
        delta: 15, balance: 0, note: '任务结算：今日抽奖3次', kind: 'reward',
        refType: 'task', refId: 'seed-tc1'
      })
      this.points += 15
      // 上一业务日：2 次有效参与 + 1 笔风控冻结（审核中暂缓计入）→ 任务 2/3 未达成；
      // 该跨日审核单放行后按归属业务日 d1 补计进度并结算，撤销则确认不计入
      ;[['18:03:11', 18, 3], ['18:05:26', 18, 5]].forEach(([time, h, m], i) => {
        this.records.push({
          id: `seed-rd1-${i}`, type: 'draw', status: 'normal',
          date: d1, time, ts: todayAt(h, m) - DAY,
          activityId: 'act-1', activityName: '周年庆幸运转盘',
          prizeId: 'p6', prizeName: '谢谢参与', rarity: 'none', icon: '🤝'
        })
      })
      const pCardD1 = a1?.prizes.find((p) => p.id === 'p2')
      if (pCardD1) { pCardD1.remain -= 1; pCardD1.frozen += 1 }
      this.addStockMove('hold', {
        id: 'seed-sl6', targetType: 'prize', targetId: 'p2', targetName: '500元购物卡', activityId: 'act-1',
        deltaHeld: -1, deltaFrozen: 1, refType: 'record', refId: 'seed-r6',
        date: d1, time: '18:06:40', ts: todayAt(18, 6) - DAY,
        note: `风控预占：周年庆幸运转盘（审核中，归属业务日 ${d1}）`
      })
      const rec6 = {
        id: 'seed-r6', type: 'draw', status: 'frozen',
        date: d1, time: '18:06:40', ts: todayAt(18, 6) - DAY,
        activityId: 'act-1', activityName: '周年庆幸运转盘',
        prizeId: 'p2', prizeName: '500元购物卡', rarity: 'epic', icon: '💳',
        riskOrderId: 'seed-rk6'
      }
      this.records.push(rec6)
      this.riskOrders.push({
        id: 'seed-rk6', bizType: 'draw', status: 'pending', userId: uid, userName: uname,
        recordId: rec6.id, activityId: 'act-1', targetId: 'p2', targetName: '500元购物卡',
        icon: '💳', rarity: 'epic', frozenPoints: 0, stockHeld: 1,
        rules: [{ code: 'highValue', label: RULE_LABELS.highValue }],
        appealReason: '', appealAt: '', reviewNote: '', reviewer: '',
        createdAt: d1, time: '18:06:40', ts: todayAt(18, 6) - DAY, reviewedAt: ''
      })

      // 期初建账在种子段最前面写入（points 置为期初值，之后按真实业务语义增减）；
      // 此处修正流水余额快照（append-only，重排后顺序写入当时余额；重放结果应等于 this.points）
      this.rebalanceSeedPoints()

      // —— 7) 历史已平衡对账任务单（前两业务日已核平，演示台账保留 + 重复执行幂等） ——
      this.reconJobs.push({
        id: 'seed-recon-d2', bizDate: d2, status: 'balanced',
        createdAt: d2, createdTime: '23:59:00', ts: todayAt(23, 59) - 2 * DAY,
        lastRunAt: `${d2} 23:59:00`, runs: 1, operator: '系统',
        summary: {
          checks: 7, balanced: 7, diffs: 0,
          drawCost: 0, drawReward: 0, redeemCost: 0, taskReward: 15,
          pointsOut: 15, stockOut: 0, frozenPoints: 0
        }
      })

      // 审计日志（最新在前）
      this.auditLogs = [
        { id: 'seed-log5', action: 'revoke', actionLabel: '审核撤销', orderId: 'seed-rk5', operator: '系统', detail: '撤销兑换【视频会员周卡】，返还80积分、回补库存×1；备注：命中短时连续兑换规则，自动拦截，用户未申诉。', date: this.todayDate, time: '08:35:00' },
        { id: 'seed-log4', action: 'release', actionLabel: '审核放行', orderId: 'seed-rk4', operator: '运营小张', detail: '放行抽奖【500元购物卡】；备注：核实为正常用户，放行并发奖。', date: this.todayDate, time: '09:10:12' },
        { id: 'seed-log3', action: 'appeal', actionLabel: '用户申诉', orderId: 'seed-rk2', operator: uname, detail: '用户提交申诉：本人正常参与活动中奖，未使用任何外挂，请求放行。', date: this.todayDate, time: '09:45:30' },
        { id: 'seed-log2', action: 'freeze', actionLabel: '风控冻结', orderId: 'seed-rk3', operator: uname, detail: '兑换【盲盒福袋】命中规则：高价值奖品/兑换、短时间连续兑换，冻结200积分、预占库存×1', date: this.todayDate, time: '09:15:22' },
        { id: 'seed-log1', action: 'freeze', actionLabel: '风控冻结', orderId: 'seed-rk1', operator: uname, detail: '抽奖【iPhone 16】命中规则：高价值奖品/兑换，冻结0积分、预占库存×1；该笔暂缓计入抽奖任务进度', date: this.todayDate, time: '10:02:15' },
        { id: 'seed-log6', action: 'freeze', actionLabel: '风控冻结', orderId: 'seed-rk6', operator: uname, detail: `抽奖【500元购物卡】命中规则：高价值奖品/兑换，冻结0积分、预占库存×1；该笔暂缓计入抽奖任务进度（归属业务日 ${d1}，跨日审核单）`, date: d1, time: '18:06:40' },
        { id: 'seed-log7', action: 'task-settle', actionLabel: '任务结算', orderId: '', operator: '系统', detail: `抽奖任务【今日抽奖3次】达成（${d2} 有效参与 3/3），自动发放 15 积分`, date: d2, time: '08:12:40' }
      ]
    },

    // 按时间正序重放种子流水，修正每行 balance 快照（含历史余额建账行，重放后应等于当前 points）
    rebalanceSeedPoints() {
      const seeds = this.pointRecords.filter((p) => p.id.startsWith('seed-'))
      if (!seeds.length) return
      const sorted = [...seeds].sort((a, b) => a.ts - b.ts)
      let bal = this.points - sorted.reduce((s, p) => s + p.delta, 0)
      sorted.forEach((p) => {
        bal += p.delta
        p.balance = bal
      })
    }
  }
})
