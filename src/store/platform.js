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
    reconBills: [],             // 积分库存对账差异单（按业务日，append-only 保留执行/复核/补偿痕迹）
    stockAdjustments: [],       // 库存校正台账（append-only）：对账补偿对 remain 的修正凭证
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
          .filter((p) => p.delta > 0 && p.kind !== 'refund')
          .reduce((s, p) => s + p.delta, 0),
        goodsSold: state.records.filter((r) => r.type === 'redeem' && r.status !== 'revoked').length,
        taskSettlements: state.taskClaims.length,
        pendingRisk: state.riskOrders.filter((o) => o.status === 'pending' || o.status === 'appealed').length,
        frozenPoints: state.riskOrders
          .filter((o) => o.status === 'pending' || o.status === 'appealed')
          .reduce((sum, o) => sum + (o.frozenPoints || 0), 0),
        // 对账看板：对账业务日数、待复核差异单数、累计补偿积分、库存校正次数
        reconDays: state.reconBills.length,
        reconOpen: state.reconBills.filter((b) => ['pending', 'reviewed'].includes(b.status)).length,
        reconCompensated: state.pointRecords
          .filter((p) => p.kind === 'recon-comp' || p.kind === 'task-comp')
          .reduce((s, p) => s + p.delta, 0),
        stockAdjCount: state.stockAdjustments.length
      }
    },
    // 某业务日的对账差异单（一业务日一单，重复执行更新同单并保留痕迹）
    reconBillOf: (s) => (date) => s.reconBills.find((b) => b.date === date) || null,
    // 存在差异、尚未平账的对账单元数（看板/Tab 角标）
    reconOpenCount(s) {
      return s.reconBills.filter((b) => ['pending', 'reviewed'].includes(b.status)).length
    },
    // 可选对账业务日：有业务记录/审核单/任务台账/已有对账单的日期，倒序
    reconDates(s) {
      const dates = new Set()
      s.records.forEach((r) => dates.add(r.date))
      s.riskOrders.forEach((o) => dates.add(o.createdAt))
      s.taskClaims.forEach((c) => { dates.add(c.bizDate); dates.add(c.grantDate) })
      s.reconBills.forEach((b) => dates.add(b.date))
      dates.add(s.todayDate)
      return [...dates].sort().reverse()
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
    // extra（可选）：
    //   bizDate 该笔归属业务日（跨日补偿/补计用；默认取实际发生业务日 todayDate）
    //   refId   关联业务凭证（任务台账/对账差异单 id），用于逐笔勾稽与幂等判重
    //   refType 关联类型：task-claim | recon-comp
    addPointRecord(delta, note, kind = 'normal', extra = {}) {
      // 常规流水取当前时刻；对历史业务日补账的流水（任务结算/对账补偿/放行发奖）显式续在现有链末端 +1ms，
      // 保证其"期末余额"快照在按 ts 重放时落在链尾、余额链连续
      const appendFlow = extra.bizDate && extra.bizDate !== (extra.date || this.todayDate)
      const isChainTail = kind === 'recon-comp' || kind === 'task-comp' ||
        (appendFlow && (kind === 'reward' || kind === 'release'))
      const latestTs = isChainTail
        ? this.pointRecords.reduce((mx, p) => Math.max(mx, p.ts || 0), Date.now())
        : 0
      this.pointRecords.unshift({
        id: genId('pr'),
        date: extra.date || this.todayDate,
        bizDate: extra.bizDate || extra.date || this.todayDate,
        time: extra.time || nowTime(),
        ts: extra.ts || (isChainTail ? latestTs + 1 : Date.now()),
        delta,
        // 余额快照：调用方先改 this.points 再记账，快照即记账后余额
        balance: extra.balance !== undefined ? extra.balance : this.points,
        note,
        kind, // normal | frozen | release | refund | reward | task-comp | recon-comp
        refId: extra.refId || '',
        refType: extra.refType || ''
      })
      if (this.pointRecords.length > 300) this.popIfTrimmed()
    },
    popIfTrimmed() {
      // 补偿/对账流水优先保留，裁剪最老的普通流水（append-only 历史行不被改写，仅控制演示内存）
      const oldest = [...this.pointRecords].reverse().find((p) => !['recon-comp', 'task-comp'].includes(p.kind))
      if (oldest) this.pointRecords.splice(this.pointRecords.indexOf(oldest), 1)
      else this.pointRecords.pop()
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
          'recon-run': '对账执行',
          'recon-review': '对账复核',
          'recon-comp': '对账补偿',
          'recon-inject': '差异注入'
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
        // 流水实际发放日为今日，但 bizDate 标注归属业务日（跨日补计计入原业务日对账，不串当日账）
        this.addPointRecord(t.reward, `任务结算：${t.label}${crossDay ? `（${date} 业务日补计）` : ''}`, 'reward', {
          bizDate: date
        })
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
      if (cost > 0) {
        this.points -= cost
        this.addPointRecord(-cost, `参与活动【${act.name}】`)
      }
      this.saveDayLog()
      if (prize.rarity !== 'none') {
        const orig = act.prizes.find((p) => p.id === prize.id)
        orig.remain -= 1
      }
      let pointDelta = 0
      if (prize.name.includes('积分')) {
        pointDelta = parseInt(prize.name) || 0
        this.points += pointDelta
      }

      const rec = {
        id: genId('r'),
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
      if (pointDelta) this.addPointRecord(pointDelta, `抽奖获得：${prize.name}`, 'reward')
      if (prize.rarity === 'legendary') this.showToast(`🎉 传说大奖！${prize.name}`, 'success')
      else this.showToast(`获得：${prize.name}`, 'success')
      // 真实参与记录落账后，按归属业务日自动结算抽奖任务（达标即发奖，幂等防重）
      this.settleDrawTasks(rec.date)
      return rec
    },

    // 冻结抽奖：占用成本积分 + 预占奖品库存，建立审核单
    freezeDraw(act, prize, cost, riskHits) {
      if (cost > 0) {
        this.points -= cost
        this.addPointRecord(-cost, `冻结：参与【${act.name}】待风控审核`, 'frozen')
      }
      if (prize.rarity !== 'none') {
        const orig = act.prizes.find((p) => p.id === prize.id)
        orig.remain -= 1
        orig.frozen += 1
      }
      const rec = {
        id: genId('r'),
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
      this.addPointRecord(t.reward, `完成任务：${t.label}`, 'reward')
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

      this.points -= g.cost
      g.remain -= 1
      this.addPointRecord(-g.cost, `兑换：${g.name}`)
      const rec = {
        id: genId('rg'),
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
      this.points -= g.cost
      g.remain -= 1
      g.frozen += 1
      this.addPointRecord(-g.cost, `冻结：兑换【${g.name}】待风控审核`, 'frozen')
      const rec = {
        id: genId('rg'),
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
        }
        // 积分奖品此刻才入账（归属原参与业务日；跨日审核时流水续在链尾、对账不串当日）
        const n = parseInt(o.targetName) || 0
        if (o.targetName.includes('积分') && n > 0) {
          this.points += n
          this.addPointRecord(n, `审核放行：抽奖奖品【${o.targetName}】`, 'release', {
            bizDate: o.createdAt
          })
        }
      } else {
        const g = this.goods.find((x) => x.id === o.targetId)
        if (g) g.frozen = Math.max(0, g.frozen - 1)
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
          `撤销返还：${o.bizType === 'draw' ? '抽奖' : '兑换'}【${o.targetName}】`, 'refund')
      }
      // 回补库存（remain 回补 + frozen 释放）
      if (o.bizType === 'draw') {
        if (o.stockHeld) {
          const act = this.activities.find((a) => a.id === o.activityId)
          const prize = act?.prizes.find((p) => p.id === o.targetId)
          if (prize) {
            prize.frozen = Math.max(0, prize.frozen - 1)
            prize.remain += 1
          }
        }
      } else {
        const g = this.goods.find((x) => x.id === o.targetId)
        if (g) {
          g.frozen = Math.max(0, g.frozen - 1)
          g.remain += 1
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

    // ===== 积分库存对账 =====
    // 对账口径（按业务日 D）：
    //  P1 积分发生额：业务侧（抽奖成本/中奖积分、兑换成本/撤销返还、任务奖励）推导的应有净额
    //                vs 积分流水实际净额（补偿流水单列），残差即少记/多记
    //  P2 任务奖励台账：taskClaims 每笔领奖必须有对应流水（跨日补计按发放日勾稽）
    //  P3 余额链：append-only 流水余额快照逐笔连续，且最新一行余额 == 当前可用积分（安全网）
    //  P4 冻结单据（当前态）：在审单与业务记录状态一致、冻结积分=业务成本、预占库存=账面 frozen
    //  P5 库存账实（当前态）：应有 remain = 初始库存 - 有效消耗 + 库存校正，与实物账逐 SKU 比对
    //
    // 幂等：一业务日一张差异单，签名（各类残差指纹）不变即同一版本；重复执行只追加执行痕迹，不重建、不重复补偿。
    // 跨日：补偿流水带 bizDate 归属原业务日、date 为实际处理日；风控放行/撤销的积分动作按审核日入账。
    // 留痕：原始流水/业务记录/库存行永不改写，所有修正只追加补偿流水与库存校正台账。

    _flowBizDate(p) {
      return p.bizDate || p.date
    },
    _orderOfRecord(recordId) {
      return this.riskOrders.find((o) => o.recordId === recordId)
    },
    _reviewDate(order) {
      return (order?.reviewedAt || '').slice(0, 10)
    },
    // 抽奖记录对应的积分成本（免费活动为 0）
    _drawCostOf(rec) {
      const act = this.activities.find((a) => a.id === rec.activityId)
      return act && act.costType === 'points' ? (act.cost || 0) : 0
    },
    // 抽奖中奖积分（仅积分奖品）
    _drawPrizePoints(rec) {
      return rec.prizeName && rec.prizeName.includes('积分') ? (parseInt(rec.prizeName) || 0) : 0
    },

    // 计算某业务日的对账差异（纯推导，不落库；补偿流水/校正台账参与勾稽）
    computeReconDiffs(date) {
      const flowsOn = (d) => this.pointRecords.filter((p) => this._flowBizDate(p) === d)
      const isComp = (p) => p.kind === 'recon-comp' || p.kind === 'task-comp'
      const dayFlows = flowsOn(date)

      // —— P1 积分发生额 ——
      // 业务侧逐笔推导应有流水（同日同额合成明细，供差异单展示勾稽过程）
      const expectedDetail = []
      let expectedNet = 0
      const pushExpect = (delta, label, effDate) => {
        if (effDate !== date) return
        expectedNet += delta
        expectedDetail.push({ delta, label })
      }
      this.records.forEach((r) => {
        if (r.type === 'draw') {
          // 成本：落账即扣（正常/冻结/撤销都曾扣减），撤销返还按审核日另计
          const cost = this._drawCostOf(r)
          if (cost) pushExpect(-cost, `抽奖成本：${r.activityName}`, r.date)
          // 中奖积分：正常按参与日入账；放行按审核日入账；撤销/冻结中无
          const prize = this._drawPrizePoints(r)
          if (prize && r.status === 'normal') pushExpect(prize, `抽奖中奖：${r.prizeName}`, r.date)
          // 放行发奖流水归属原参与业务日（实际发放日见流水 date，跨日不串当日净额）
          if (prize && r.status === 'released') pushExpect(prize, `审核放行发奖：${r.prizeName}（${this._reviewDate(this._orderOfRecord(r.id))} 入账）`, r.date)
          // 撤销返还冻结成本（按审核日）
          if (r.status === 'revoked') {
            const o = this._orderOfRecord(r.id)
            if (o?.frozenPoints) pushExpect(o.frozenPoints, '撤销返还：抽奖冻结积分', this._reviewDate(o))
          }
        } else if (r.type === 'redeem') {
          const g = this.goods.find((x) => x.id === r.goodsId)
          const cost = g?.cost || 0
          if (cost) pushExpect(-cost, `兑换扣减：${r.goodsName}`, r.date)
          if (r.status === 'revoked') {
            const o = this._orderOfRecord(r.id)
            if (o?.frozenPoints) pushExpect(o.frozenPoints, '撤销返还：兑换冻结积分', this._reviewDate(o))
          }
        }
      })
      // 手动任务奖励：以 reward 类"完成任务"流水为业务凭证（补记的 task-comp 补偿流不计入应有发生额）
      dayFlows.forEach((p) => {
        if (!isComp(p) && p.kind === 'reward' && p.note.startsWith('完成任务：')) {
          expectedNet += p.delta
          expectedDetail.push({ delta: p.delta, label: p.note })
        }
      })
      // 抽奖任务台账：归属业务日为 bizDate（跨日补计计入原业务日，不串审核当日账）；
      // 实际发放日 grantDate 记录在台账与流水上。缺记台账无流水，体现为 P1 残差由 P2 逐笔列出。
      this.taskClaims.forEach((c) => {
        if (c.bizDate === date) {
          expectedNet += c.reward
          expectedDetail.push({
            delta: c.reward,
            label: `任务结算：${c.taskLabel}${c.grantDate !== c.bizDate ? `（${c.grantDate} 跨日补计）` : ''}`
          })
        }
      })

      const ledgerNet = dayFlows.filter((p) => !isComp(p)).reduce((s, p) => s + p.delta, 0)
      const compNet = dayFlows.filter(isComp).reduce((s, p) => s + p.delta, 0)
      const residual = expectedNet - ledgerNet - compNet

      // —— P2 任务奖励逐笔勾稽（按归属业务日 bizDate；跨日补计的流水带相同 bizDate） ——
      // 候选流水：原始"任务结算"reward 流（按任务名匹配）或 task-comp 补偿流（按台账 id 精确匹配）
      const usedFlowIds = new Set()
      const taskItems = this.taskClaims
        .filter((c) => c.bizDate === date)
        .map((c) => {
          const comp = this.pointRecords.find((p) => p.kind === 'task-comp' && p.refId === c.id)
          if (comp) { usedFlowIds.add(comp.id); return null }
          const cand = this.pointRecords.find((p) =>
            !usedFlowIds.has(p.id) && !isComp(p) && p.kind === 'reward' &&
            this._flowBizDate(p) === date && p.delta === c.reward &&
            p.note.includes('任务结算') && p.note.includes(c.taskLabel))
          if (cand) { usedFlowIds.add(cand.id); return null }
          return {
            key: `task-${c.id}`, claimId: c.id, label: c.taskLabel, reward: c.reward,
            bizDate: c.bizDate, grantDate: c.grantDate, autoFixable: true
          }
        })
        .filter(Boolean)
      // P1 残差 = 应有净额 − 原始流水净额 − 已补偿净额；P2 缺笔是其中的逐笔明细
      const pointsResidual = residual

      // —— P3 余额链连续性（当前态安全网） ——
      const sorted = [...this.pointRecords].sort((a, b) => a.ts - b.ts)
      let bal = this.points - sorted.reduce((s, p) => s + p.delta, 0)
      let brokenRows = 0
      let firstBad = null
      sorted.forEach((p) => {
        bal += p.delta
        if (p.balance !== bal) {
          brokenRows += 1
          if (!firstBad) firstBad = { id: p.id, expect: bal, actual: p.balance, note: p.note, date: p.date }
        }
      })
      const head = sorted[sorted.length - 1]
      const chainItem = (brokenRows > 0 || (head && head.balance !== this.points)) ? {
        brokenRows,
        firstBad,
        headBalance: head ? head.balance : null,
        pointsBalance: this.points,
        autoFixable: false   // 不直接改余额/快照；P1/P2 补偿使余额与流水同步后自愈
      } : null

      // —— P4 风控冻结单据一致性（当前态） ——
      const frozenItems = []
      const heldByTarget = new Map()
      this.riskOrders.filter((o) => o.status === 'pending' || o.status === 'appealed').forEach((o) => {
        // 预占键：奖品按 活动id+奖品id（不同活动奖品 id 可能重复），商品按 goodsId
        const key = o.bizType === 'draw' ? `prize:${o.activityId}:${o.targetId}` : `goods:${o.targetId}`
        heldByTarget.set(key, (heldByTarget.get(key) || 0) + (o.stockHeld || 0))
        const rec = this.records.find((r) => r.id === o.recordId)
        if (!rec || rec.status !== 'frozen') {
          frozenItems.push({ key: `order-status-${o.id}`, orderId: o.id, kind: 'order-status',
            target: o.targetName, expect: '业务记录冻结中', actual: rec ? rec.status : '记录缺失', autoFixable: false })
        }
        const expectCost = o.bizType === 'draw'
          ? (this.activities.find((a) => a.id === o.activityId)?.costType === 'points'
              ? (this.activities.find((a) => a.id === o.activityId)?.cost || 0) : 0)
          : (this.goods.find((g) => g.id === o.targetId)?.cost || 0)
        if ((o.frozenPoints || 0) !== expectCost) {
          frozenItems.push({ key: `order-points-${o.id}`, orderId: o.id, kind: 'order-points',
            target: o.targetName, expect: expectCost, actual: o.frozenPoints || 0, autoFixable: false })
        }
      })
      // 预占库存 vs 账面 frozen（key 形如 prize:act-1:p1 / goods:g1）
      const checkHeld = (key, name, book) => {
        const held = heldByTarget.get(key) || 0
        if (held !== (book || 0)) {
          frozenItems.push({ key: `held-${key}`, kind: 'stock-held',
            target: name, expect: held, actual: book || 0, autoFixable: false })
        }
      }
      this.activities.forEach((a) => a.prizes.forEach((p) => {
        if (p.rarity !== 'none') checkHeld(`prize:${a.id}:${p.id}`, `${a.name} / ${p.name}`, p.frozen)
      }))
      this.goods.forEach((g) => checkHeld(`goods:${g.id}`, g.name, g.frozen))

      // —— P5 库存账实（当前态；应有 = 初始库存 - 有效消耗 + 已校正） ——
      const consumedAllOf = (test) => this.records.filter((r) => r.status !== 'revoked' && test(r)).length
      const stockItems = []
      const pushStock = (targetType, activityId, id, name, icon, item) => {
        const isPrize = targetType === 'prize'
        const heldKey = isPrize ? `prize:${activityId}:${id}` : `goods:${id}`
        const consumed = isPrize
          ? consumedAllOf((r) => r.type === 'draw' && r.activityId === activityId && r.prizeId === id)
          : consumedAllOf((r) => r.type === 'redeem' && r.goodsId === id)
        const adjusted = this.stockAdjustments
          .filter((x) => x.targetType === targetType && x.targetKey === heldKey)
          .reduce((s, x) => s + x.delta, 0)
        const expected = item.stock - consumed + adjusted
        const diff = expected - item.remain
        // 当日消耗/回补（展示用）：有效消耗按业务日，撤销回补按审核日
        const dayConsumed = this.records.filter(
          (r) => isPrize
            ? (r.type === 'draw' && r.activityId === activityId && r.prizeId === id)
            : (r.type === 'redeem' && r.goodsId === id)
        ).filter((r) => {
          if (r.status === 'revoked') return this._reviewDate(this._orderOfRecord(r.id)) === date
          return r.date === date
        }).reduce((n, r) => n + (r.status === 'revoked' ? -1 : 1), 0)
        if (diff !== 0 || dayConsumed !== 0) {
          stockItems.push({
            key: `stock-${heldKey}`, targetType, activityId, targetId: id, targetKey: heldKey,
            name, icon,
            stock: item.stock, consumed, adjusted, expected, actual: item.remain,
            diff, dayConsumed, frozenHeld: heldByTarget.get(heldKey) || 0, frozenBook: item.frozen || 0,
            autoFixable: diff !== 0
          })
        }
      }
      this.activities.forEach((a) => a.prizes.forEach((p) => {
        if (p.rarity !== 'none') pushStock('prize', a.id, p.id, `${a.name} / ${p.name}`, p.emoji, p)
      }))
      this.goods.forEach((g) => pushStock('goods', null, g.id, g.name, g.icon, g))

      const taskOpen = taskItems.length
      const stockOpen = stockItems.filter((x) => x.diff !== 0).length
      const openCount = (pointsResidual !== 0 ? 1 : 0) + taskOpen + (chainItem ? 1 : 0) +
        frozenItems.length + stockOpen

      return {
        date,
        generatedAt: Date.now(),
        points: { expectedNet, ledgerNet, compNet, residual: pointsResidual, autoFixable: pointsResidual > 0, detail: expectedDetail },
        tasks: taskItems,
        chain: chainItem,
        frozen: frozenItems,
        stock: stockItems,
        openCount
      }
    },

    // 差异指纹（残差/缺笔/不一致项完全相同即同一版本，重复执行幂等）
    _reconSignature(d) {
      return JSON.stringify({
        p: d.points.residual,
        t: d.tasks.map((x) => x.claimId).sort(),
        c: d.chain ? 1 : 0,
        f: d.frozen.map((x) => `${x.key}:${x.expect}/${x.actual}`),
        s: d.stock.filter((x) => x.diff !== 0).map((x) => `${x.targetType}:${x.targetId}:${x.diff}`)
      })
    },

    // 执行对账（一业务日一张单；历史日不触发业务日切换/兜底结算）
    runRecon(date, silent = false) {
      if (date === this.todayDate || !date) this.syncBusinessDay()
      const d = date || this.todayDate
      const diffs = this.computeReconDiffs(d)
      const signature = this._reconSignature(diffs)
      let bill = this.reconBills.find((b) => b.date === d)
      const runAt = { at: `${this.todayDate} ${nowTime()}`, ts: Date.now(),
        operator: this.role === 'operator' ? `运营(${this.user.name})` : this.user.name,
        openCount: diffs.openCount, balanced: diffs.openCount === 0 }

      if (!bill) {
        bill = {
          id: genId('rc'), date: d,
          status: diffs.openCount === 0 ? 'balanced' : 'pending',
          signature, diffs,
          runs: [runAt], compensations: [],
          firstAt: runAt.at, reviewedAt: '', reviewer: '', reviewNote: '',
          createdAt: this.todayDate
        }
        this.reconBills.unshift(bill)
      } else {
        const sameVersion = bill.signature === signature
        bill.diffs = diffs
        bill.signature = signature
        bill.runs.unshift(runAt)
        if (bill.runs.length > 50) bill.runs.pop()
        if (!sameVersion) {
          // 业务有变化导致残差改变：已平→待复核；曾经的复核/补偿结论保留在 reviewedAt/compensations
          if (diffs.openCount === 0) bill.status = bill.compensations.length ? 'compensated' : 'balanced'
          else bill.status = 'pending'
        }
        // 同版本但当前已平：已补偿单保持"已补偿平账"（重复执行幂等，不回退状态）
        if (sameVersion && diffs.openCount === 0 && bill.compensations.length && bill.status !== 'compensated') {
          bill.status = 'compensated'
        }
      }

      this.addAuditLog('recon-run', bill.id,
        diffs.openCount === 0
          ? `业务日 ${d} 对账完成：账实相符，无差异（积分应有净额 ${diffs.points.expectedNet}，流水净额 ${diffs.points.ledgerNet}）`
          : `业务日 ${d} 对账完成：发现 ${diffs.openCount} 项未平差异（积分残差 ${diffs.points.residual}、任务缺记 ${diffs.tasks.length} 笔、库存 ${diffs.stock.filter((x) => x.diff).length} SKU、冻结 ${diffs.frozen.length} 项${diffs.chain ? '、余额链断裂' : ''}）`)
      if (!silent) {
        if (diffs.openCount === 0) this.showToast(`🧮 ${d} 对账完成：账实相符`, 'success')
        else this.showToast(`🧮 ${d} 对账完成：${diffs.openCount} 项差异待运营复核`, 'warn')
      }
      return bill
    },

    // 运营复核差异单（确认差异属实，进入可补偿状态；不改动任何账目）
    reviewRecon(date, note = '') {
      if (this.role !== 'operator') {
        this.showToast('仅运营可复核对账差异单', 'warn')
        return false
      }
      const bill = this.reconBills.find((b) => b.date === date)
      if (!bill) { this.showToast('请先执行对账', 'warn'); return false }
      if (bill.diffs.openCount === 0) { this.showToast('该业务日账实相符，无需复核', 'info'); return false }
      bill.status = 'reviewed'
      bill.reviewedAt = `${this.todayDate} ${nowTime()}`
      bill.reviewer = this.user.name
      bill.reviewNote = note.trim()
      this.addAuditLog('recon-review', bill.id,
        `复核业务日 ${date} 的对账差异：${note.trim() || '确认差异属实，待补偿修正'}（原始记录保留，仅允许追加补偿流水）`)
      this.showToast(`已复核 ${date} 差异单，可执行补偿修正`, 'success')
      return true
    },

    // 复核通过后补偿：只追加补偿流水/库存校正，同步余额、库存；重复执行对已平项幂等跳过
    compensateRecon(date, note = '') {
      if (this.role !== 'operator') {
        this.showToast('仅运营可执行对账补偿', 'warn')
        return null
      }
      const bill0 = this.reconBills.find((b) => b.date === date)
      if (!bill0 || bill0.status === 'pending') { this.showToast('请先完成差异复核，再执行补偿', 'warn'); return null }
      if (bill0.status === 'balanced' && !bill0.diffs.openCount) { this.showToast('该业务日账实相符，无需补偿', 'info'); return null }
      // 以最新账实重新推导（防止复核后业务又有变化导致错补）
      const live = this.computeReconDiffs(date)
      const actions = []

      // 1) 任务奖励逐笔补记（余额与流水同步追加，保留原始记录）
      live.tasks.forEach((item) => {
        if (this.pointRecords.some((p) => p.kind === 'task-comp' && p.refId === item.claimId)) return // 幂等
        this.points += item.reward
        const cross = item.grantDate !== item.bizDate ? `（归属 ${item.bizDate} 跨日补计）` : ''
        this.addPointRecord(item.reward, `对账补偿：任务奖励补记【${item.label}】${cross}`, 'task-comp', {
          bizDate: item.bizDate, refId: item.claimId, refType: 'task-claim'
        })
        actions.push({ type: 'task', label: item.label, delta: item.reward })
      })

      // 2) 积分净额残差（>0 业务真实、流水少记 → 补流水并同步余额；<0 为长款/多记，需人工核查不自动扣减）
      const live2 = this.computeReconDiffs(date)
      const pr = live2.points.residual
      if (pr > 0) {
        this.points += pr
        this.addPointRecord(pr, `对账补偿：${date} 积分净额差异（业务流水少记，按差异单补记）`, 'recon-comp', {
          bizDate: date, refId: bill0.id, refType: 'recon-bill'
        })
        actions.push({ type: 'points', label: '积分净额残差', delta: pr })
      }
      const manualPoints = pr < 0 ? Math.abs(pr) : 0

      // 3) 库存校正：账实差异以调整凭证把"账面应有"对齐实物（盘亏记 -1、盘盈记 +1），
      //    不凭空回补/扣减实物；追加 append-only 库存校正台账
      live2.stock.filter((x) => x.diff !== 0).forEach((x) => {
        const target = x.targetType === 'prize'
          ? this.activities.find((a) => a.id === x.activityId)?.prizes.find((p) => p.id === x.targetId)
          : this.goods.find((g) => g.id === x.targetId)
        if (!target) return
        const before = target.remain
        // 注入一笔 -diff 的账存调整凭证：expected = stock - consumed + adjusted = actual
        this.stockAdjustments.unshift({
          id: genId('sa'), billId: bill0.id, bizDate: date,
          date: this.todayDate, time: nowTime(), ts: Date.now(),
          targetType: x.targetType, targetId: x.targetId, targetKey: x.targetKey,
          activityId: x.activityId || null, targetName: x.name,
          delta: -x.diff, before, after: before,
          reason: note.trim() || (x.diff > 0
            ? '对账差异补偿：实物盘亏，按差异单登记库存调整（账面核销）'
            : '对账差异补偿：实物盘盈，按差异单登记库存调整（账面补登）'),
          operator: this.user.name
        })
        actions.push({ type: 'stock', label: x.name, delta: -x.diff })
      })

      if (!actions.length && !manualPoints && !live2.chain && !live2.frozen.length) {
        this.showToast('账目已平，无需重复补偿', 'info')
        return null
      }

      const pointDelta = actions.filter((a) => a.type !== 'stock').reduce((s, a) => s + a.delta, 0)
      const stockCount = actions.filter((a) => a.type === 'stock').length
      if (actions.length) {
        bill0.compensations.unshift({
          id: genId('rcc'), at: `${this.todayDate} ${nowTime()}`,
          pointDelta, stockCount, note: note.trim(), reviewer: this.user.name,
          items: actions.map((a) => ({ ...a }))
        })
      }
      this.addAuditLog('recon-comp', bill0.id,
        `补偿业务日 ${date} 差异：` +
        actions.map((a) => a.type === 'stock'
          ? `库存【${a.label}】校正 ${a.delta > 0 ? '+' : ''}${a.delta}`
          : `【${a.label}】补记 +${a.delta} 积分`).join('；') +
        (manualPoints ? `；另有积分长款 ${manualPoints}（流水多记/来源不明），已标记需人工核查，未自动扣减` : '') +
        (live2.frozen.length ? `；${live2.frozen.length} 项冻结单据不一致需在风控申诉中处理` : '') +
        (note.trim() ? `；备注：${note.trim()}` : '') + '；原始记录保留未改写')

      // 重新对账刷新差异单（补偿流水/校正参与勾稽；P3 余额链随余额同步自愈）
      const refreshed = this.runRecon(date, true)
      if (refreshed.diffs.openCount === 0) bill0.status = 'compensated'
      else bill0.status = 'reviewed' // 仍有长款/冻结类等需人工处理的差异

      const parts = []
      if (pointDelta) parts.push(`补记积分 +${pointDelta}`)
      if (stockCount) parts.push(`校正 ${stockCount} 项库存`)
      this.showToast(parts.length ? `🧮 补偿完成：${parts.join('，')}，余额与库存已同步` : '🧮 补偿已记录，剩余差异需人工处理',
        refreshed.diffs.openCount === 0 ? 'success' : 'warn')
      return { pointDelta, stockCount, manualPoints, actions }
    },

    // ===== 演示用：注入账实差异（模拟漏记/盘亏，便于观察对账→复核→补偿闭环） =====
    // 仅制造"业务凭证存在、账目少记/实物缺失"，原始业务与库存规则保持完整，对账应能逐项检出
    injectTaskFlowGap() {
      // 模拟：一笔任务领奖台账已落、积分与流水却漏记（余额未加）→ P1 净额 + P2 台账缺笔
      this.syncBusinessDay()
      const d = this.todayDate
      const marker = `inject-gap-${d}`
      if (this.taskClaims.some((c) => c.id === marker)) {
        this.showToast('今日已注入过漏记差异，请勿重复注入', 'warn')
        return
      }
      this.taskClaims.push({
        id: marker, taskId: 't-checkin', taskLabel: '每日签到（漏记演示）', reward: 30,
        bizDate: d, grantDate: d, time: nowTime(), ts: Date.now(), source: 'manual-gap'
      })
      this.addAuditLog('recon-inject', null,
        `【演示注入】${d} 一笔 30 积分任务奖励台账已落但积分与流水漏记，等待对账检出`)
      this.showToast('🔧 已注入演示差异：30 积分任务奖励漏记（台账在、账目少）', 'warn')
    },
    injectStockLoss() {
      // 模拟：商品实物盘亏 1 件（实物 remain 少 1，业务消耗记录不变）
      this.syncBusinessDay()
      const g = this.goods.find((x) => x.id === 'g1')
      if (!g || g.remain <= 0) { this.showToast('g1 库存不足，无法注入盘亏', 'warn'); return }
      g.remain -= 1
      const d = this.todayDate
      this.addAuditLog('recon-inject', null,
        `【演示注入】${d} 商品【${g.name}】实物盘亏 1 件（业务记录完整、实物账少 1），等待对账检出`)
      this.showToast('🔧 已注入演示差异：满50减10优惠券盘亏 1 件', 'warn')
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
      a.prizes.forEach((p) => { p.remain = p.stock - (p.frozen || 0) })
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
      this.showToast(`活动【${act.name}】创建成功`, 'success')
      return act
    },

    // ===== 演示数据：预置审核单 / 冻结积分 / 预占库存 =====
    seedRiskData() {
      const uid = this.user.id
      const uname = this.user.name
      // —— 1) 待审核：传说大奖（10 积分成本 + 预占 iPhone） ——
      const a1 = this.activities.find((a) => a.id === 'act-1')
      const pLegend = a1?.prizes.find((p) => p.id === 'p1')
      if (pLegend) { pLegend.remain -= 1; pLegend.frozen += 1 }
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
      if (pEpic) { pEpic.remain -= 1; pEpic.frozen += 1 }
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
        id: 'seed-pr2', date: this.todayDate, time: '09:40:08', ts: todayAt(9, 40),
        delta: -10, balance: this.points, note: '冻结：参与【新人刮刮乐】待风控审核', kind: 'frozen'
      })

      // —— 3) 待审核：高价值兑换 盲盒福袋（200 积分冻结 + 预占 g4） ——
      const g4 = this.goods.find((g) => g.id === 'g4')
      if (g4) { g4.remain -= 1; g4.frozen += 1 }
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
        id: 'seed-pr3', date: this.todayDate, time: '09:15:22', ts: todayAt(9, 15),
        delta: -200, balance: this.points, note: '冻结：兑换【盲盒福袋】待风控审核', kind: 'frozen'
      })

      // —— 4) 已放行：500元购物卡（免费转盘，无积分冻结，库存已核销） ——
      const pEpicCard = a1?.prizes.find((p) => p.id === 'p2')
      if (pEpicCard) { pEpicCard.remain -= 1 }
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

      // —— 5) 已撤销：视频会员周卡（80 积分冻结后返还 + 库存预占后回补，业务记录保留为 revoked） ——
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
      // 撤销前的冻结成本（与正常 freezeRedeem 一致：先扣 80、预占库存），08:35 撤销时返还 80、回补库存
      this.points -= 80
      this.pointRecords.unshift({
        id: 'seed-pr5f', date: this.todayDate, time: '08:30:05', ts: todayAt(8, 30) + 1,
        delta: -80, balance: this.points, note: '冻结：兑换【视频会员周卡】待风控审核', kind: 'frozen'
      })
      this.points += 80
      this.pointRecords.unshift({
        id: 'seed-pr5', date: this.todayDate, time: '08:35:00', ts: todayAt(8, 35),
        delta: 80, balance: this.points, note: '撤销返还：兑换【视频会员周卡】', kind: 'refund'
      })

      // —— 6) 历史业务日台账：演示"按业务日保留进度与领奖记录 + 跨日审核补计" ——
      const DAY = 86400000
      const d1 = dateStr(-1)   // 上一业务日
      const d2 = dateStr(-2)   // 前两业务日
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
        id: 'seed-pr1', date: d2, time: '08:12:40', ts: todayAt(8, 12) - 2 * DAY,
        delta: 15, balance: 0, note: '任务结算：今日抽奖3次', kind: 'reward'
      })
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
      // 与待审核单一致：remain 已扣、frozen 预占 1（放行核销 / 撤销回补）
      if (pCardD1) { pCardD1.remain -= 1; pCardD1.frozen += 1 }
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

      // —— 7) 历史业务日对账差异（演示）：上一业务日一笔 5 积分任务领奖台账已落、积分与流水漏记 ——
      // 对账应在上一业务日差异单中检出（P1 净额 +5、P2 台账缺笔），运营复核后按跨日补偿补记，原始记录保留
      this.taskClaims.push({
        id: 'seed-tc-gap', taskId: 't-checkin', taskLabel: '每日签到（历史漏记）', reward: 5,
        bizDate: d1, grantDate: d1, time: '18:40:00', ts: todayAt(18, 40) - DAY, source: 'manual-gap'
      })

      // 初始可用积分 255（含一笔历史漏记：业务台账 +5 未入账）：种子实时扣减 -210
      // （在途冻结 -10/-200；已撤销兑换 -80 已 +80 返还，净 0），起点补 465 → 255。
      // 种子流水合计 -200，rebalanceSeedPoints 倒推重放后链连续、最新快照 255。
      // 对账检出并补偿历史漏记 +5 后余额 260，与补偿流水链配平。
      this.points += 465
      // 修正流水余额快照（append-only，重排后顺序写入当时余额）
      this.rebalanceSeedPoints()

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

    // 按时间正序重放种子流水，修正每行 balance 快照
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
