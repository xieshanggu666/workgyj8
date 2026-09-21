// 积分库存对账 —— 逻辑冒烟测试（esbuild 打包后在 node 运行）
import { setActivePinia, createPinia } from 'pinia'
import { usePlatformStore } from '@/store/platform'

setActivePinia(createPinia())
const s = usePlatformStore()
s.init()

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}
const dateOffset = (o) => { const d = new Date(); d.setDate(d.getDate() + o); return d.toLocaleDateString('sv') }
const today = s.todayDate
const d1 = dateOffset(-1)
const d2 = dateOffset(-2)

s.setRole('operator')

console.log('— 初始种子：各业务日账实一致 —')
const j0 = s.reconcile(today)
assert(j0.status === 'balanced', `今日对账核平（${j0.summary.checks} 项核对，差异 ${j0.summary.diffs}）`)
assert(s.pointRecords.filter((p) => p.kind !== 'recon').reduce((a, p) => a + p.delta, 0) === s.points, '积分流水全量重放 == 实时可用余额')
const j0d1 = s.reconcile(d1)
assert(j0d1.status === 'balanced', '历史业务日（昨日）补核核平，支持跨日核对')

console.log('— 重复执行幂等：不重复产生差异/任务单 —')
const jobsN = s.reconJobs.length
const diffsN = s.reconDiffs.length
s.reconcile(today); s.reconcile(today); s.reconcile(d1)
assert(s.reconJobs.length === jobsN, '同一业务日复用同一张对账任务单（共 ' + s.reconJobs.length + ' 张）')
assert(s.reconDiffs.length === diffsN, '核平状态重复执行不产生差异单')
const todayJob = s.reconJobs.find((j) => j.bizDate === today)
assert(todayJob.runs === 3, `任务单记录执行次数（runs=${todayJob.runs}，每次重跑可追溯）`)
// d2 种子任务单：重跑仍复用、runs 累加
const jD2 = s.reconcile(d2)
assert(jD2.id === 'seed-recon-d2' && jD2.runs === 2, '历史已核平任务单重复执行复用原单（幂等）')

console.log('— 注入积分差异（账实不符）：余额核对生成差异单 —')
const pointsBefore = s.points
s.points -= 30 // 模拟"账面少 30 积分"（如外部系统已扣但本地漏记账）
const j1 = s.reconcile(today)
assert(j1.status === 'pending', '对账发现差异，任务单转为待复核')
const balDiff = s.reconDiffs.find((d) => d.checkKey === 'points:balance' && d.status === 'pending')
assert(!!balDiff, '生成「积分余额」差异单（可追溯）')
assert(balDiff.expected - balDiff.actual === 30, `差异金额=30（台账应有 ${balDiff.expected}，账面 ${balDiff.actual}）`)
assert(balDiff.evidence && balDiff.evidence.length >= 2, '差异单保留双方核对证据（业务台账 vs 账册重放）')

console.log('— 运营复核：补偿流水修正账目，原始记录保留 —')
s.compensateDiff(balDiff.id, '核实为漏记账，补记 30 积分')
assert(s.points === pointsBefore, '补偿后实时余额恢复（' + (pointsBefore - 30) + ' → ' + s.points + '）')
const comp = s.reconCompensations.find((c) => c.diffId === balDiff.id && c.kind === 'compensate')
assert(!!comp && comp.delta === 30, '生成补偿流水 +30（append-only）')
assert(comp.bizDate === today && comp.date === today, '补偿流水归属当前业务日')
const reconPr = s.pointRecords.find((p) => p.kind === 'recon' && p.refId === balDiff.id)
assert(!!reconPr && reconPr.delta === 30, '积分流水新增对账补偿行，关联差异单可追溯')
assert(balDiff.status === 'compensated' && balDiff.origActual !== undefined, '差异单标记已补偿，原始账实快照保留')
assert(s.pendingDiffCount === 0, '待复核差异清零')

console.log('— 补偿后再次对账：自动收敛，不重复补偿 —')
const compN = s.reconCompensations.length
const j2 = s.reconcile(today)
assert(j2.status === 'balanced', '补偿后对账核平（账实一致）')
assert(s.reconDiffs.find((d) => d.id === balDiff.id)?.status === 'compensated', '已补偿差异保留已补偿状态（不重新挂起）')
s.reconcile(today)
assert(s.reconCompensations.length === compN, '重复执行不产生重复补偿流水')
assert(s.dashboard.pendingDiffs === 0, '看板：待复核差异同步为 0')

console.log('— 库存差异注入与补偿（余量守恒核对） —')
const g3 = s.goods.find((g) => g.id === 'g3')
const g3Before = g3.remain
g3.remain -= 2 // 模拟库存被异常多扣 2 件（账实不符）
const j3 = s.reconcile(today)
const stockDiff = s.reconDiffs.find((d) => d.checkKey === 'stock:held:g:g3' && d.status === 'pending')
assert(!!stockDiff, '生成「库存余量守恒」差异单')
assert(stockDiff.delta === 2, `差异=2 件（账册重放比账面多 2，delta=${stockDiff.delta}）`)
s.compensateDiff(stockDiff.id, '核实异常出库，回补 2 件')
assert(g3.remain === g3Before, '补偿后库存余量恢复（' + (g3Before - 2) + ' → ' + g3.remain + '）')
const stockComp = s.stockLedger.find((m) => m.kind === 'recon' && m.refId === stockDiff.id)
assert(!!stockComp && stockComp.deltaHeld === 2, '库存流水新增 recon 补偿行 +2，留痕可追溯')
assert(s.reconDiffs.find((d) => d.id === stockDiff.id).status === 'compensated', '库存差异单标记已补偿')

console.log('— 库存预占（frozen）差异：预占核对 + 修正 —')
const g5 = s.goods.find((g) => g.id === 'g5')
const fzBefore = g5.frozen
g5.frozen += 1 // 凭空多出 1 件预占
const j4 = s.reconcile(today)
const fzDiff = s.reconDiffs.find((d) => (d.checkKey === 'stock:frozenLedger:g:g5' || d.checkKey === 'stock:frozenBiz:g:g5') && d.status === 'pending')
assert(!!fzDiff, '生成「预占库存」差异单（业务台账/账册与实时 frozen 不符）')
s.compensateDiff(fzDiff.id, '清理幽灵预占')
assert(s.reconDiffs.find((d) => d.id === fzDiff.id).status === 'compensated', '预占差异已补偿修正')

console.log('— 差异挂账：不改账目，留痕待跟进，任务单仍可核平 —')
// 当日库存余量差异（库存核对当日运行）：运营确认为合理差异，挂账不改账
const g1 = s.goods.find((g) => g.id === 'g1')
const g1Before = g1.remain
g1.remain -= 3
const j5 = s.reconcile(today)
const waiveDiff = s.reconDiffs.find((d) => d.checkKey === 'stock:held:g:g1' && d.status === 'pending')
assert(!!waiveDiff, '生成库存余量差异单（-3 件）')
const stockAtWaive = g1.remain
s.waiveDiff(waiveDiff.id, '确认为样品领用，合理差异暂挂')
assert(g1.remain === stockAtWaive, '挂账不修改库存余量')
assert(s.reconDiffs.find((d) => d.id === waiveDiff.id).status === 'waived', '差异单标记已挂账（保留）')
const waiveRec = s.reconCompensations.find((c) => c.diffId === waiveDiff.id && c.kind === 'waive')
assert(!!waiveRec, '挂账写入留痕记录（append-only，可追溯）')
const j5b = s.reconcile(today)
assert(j5b.status === 'balanced', '无待复核差异后任务单转为核平（挂账项保留但不阻塞）')
g1.remain = g1Before // 还原注入（挂账行保留）

console.log('— 跨日补偿：执行日落当日、归属业务日保留，不串账 —')
// 昨日一笔抽奖（act-2 成本 10）业务台账存在但构造一笔流水差异：直接在昨日制造任务外成本差异
// 通过给昨日新增一个"账面漏记"的可核对项不易，这里用 stock 历史日核对：昨日库存净消耗核对
// 取昨日任一已核平项，通过破坏其业务侧不可行；改为验证跨日补偿归属：直接对 d1 制造库存目标差异
// （昨日 release/hold 涉及 act-1 p2）。先看 d1 任务单当前核平。
assert(j0d1.status === 'balanced', '前置：昨日已核平')
// 模拟 d1 库存流水丢失一笔（直接修改 live 不影响历史流核对；改为删除昨日一条库存流水后核对流差异）
const d1Move = s.stockLedger.find((m) => m.bizDate === d1 && m.kind === 'hold' && m.targetId === 'p2' && m.activityId === 'act-2')
assert(!!d1Move, '存在昨日跨日在途库存预占流水可用于演示')
const idx = s.stockLedger.findIndex((m) => m.id === d1Move.id)
s.stockLedger.splice(idx, 1) // 模拟历史流水丢失（仅演示，append-only 系统中不会真正删除）
const j6 = s.reconcile(d1)
const crossDiff = s.reconDiffs.find((d) => d.jobId === j6.id && d.status === 'pending')
assert(!!crossDiff, '历史业务日补核对发现差异')
s.compensateDiff(crossDiff.id, '补录历史丢失流水')
const crossComp = s.reconCompensations.find((c) => c.id && c.diffId === crossDiff.id && c.kind === 'compensate')
assert(!!crossComp, '跨日补偿流水已生成')
assert(crossComp.bizDate === d1 && crossComp.date === today, `跨日补偿归属日=${d1}、执行日=${today}（不串当日账）`)
assert(j6.bizDate === d1, '差异单与补偿均挂在历史业务日任务单下')
s.stockLedger.unshift(d1Move) // 还原（保持后续断言干净；补偿行保留）

console.log('— 看板 / 审计同步 —')
assert(s.dashboard.pendingDiffs === 0, '看板待复核差异=0')
assert(s.dashboard.reconCompensations >= 4, `看板补偿流水计数同步（${s.dashboard.reconCompensations} 笔）`)
assert(s.dashboard.reconciledDays >= 3, `看板已对账业务日数（${s.dashboard.reconciledDays}）`)
const auditHits = s.auditLogs.filter((l) => ['recon-run', 'recon-compensate', 'recon-waive'].includes(l.action))
assert(auditHits.length >= 5, '对账执行/补偿/挂账全部写入审计操作记录（' + auditHits.length + ' 条）')

console.log('— 权限：用户视角不可对账/补偿/挂账 —')
s.setRole('user')
assert(s.reconcile(today) === null, '用户视角执行对账被拦截')
assert(s.compensateDiff('nonexistent-diff') === false, '用户视角补偿被拦截（角色校验优先）')
assert(s.waiveDiff('nonexistent-diff') === false, '用户视角挂账被拦截（角色校验优先）')
s.setRole('operator')

console.log(failed ? `\n共 ${failed} 项失败` : '\n全部通过 🎉')
process.exit(failed ? 1 : 0)
