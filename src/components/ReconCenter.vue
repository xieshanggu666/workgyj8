<template>
  <div class="recon-view">
    <!-- 顶部概览 -->
    <div class="recon-hero">
      <div class="hero-stats">
        <div class="hs-item">
          <span class="hs-num warn">{{ store.pendingDiffCount }}</span>
          <span class="hs-lab">待复核差异</span>
        </div>
        <div class="hs-item">
          <span class="hs-num">{{ store.reconJobs.length }}</span>
          <span class="hs-lab">已对账业务日</span>
        </div>
        <div class="hs-item">
          <span class="hs-num ok">{{ store.reconCompensations.filter((c) => c.kind === 'compensate').length }}</span>
          <span class="hs-lab">补偿流水</span>
        </div>
        <div class="hs-item">
          <span class="hs-num ice">{{ store.points }}</span>
          <span class="hs-lab">实时可用积分</span>
        </div>
        <div class="hs-item">
          <span class="hs-num ice">{{ store.frozenPoints }}</span>
          <span class="hs-lab">实时冻结积分</span>
        </div>
      </div>
      <div class="role-box">
        <span class="role-tip">当前视角</span>
        <div class="role-switch">
          <button :class="{ active: store.role === 'user' }" @click="store.setRole('user')">👤 用户（只读）</button>
          <button :class="{ active: store.role === 'operator' }" @click="store.setRole('operator')">🛡️ 运营（复核）</button>
        </div>
      </div>
    </div>

    <!-- 执行对账 -->
    <div class="card">
      <div class="card-title">🧮 按业务日执行对账</div>
      <div class="run-bar">
        <label>业务日</label>
        <select v-model="selectedDate">
          <option v-for="d in dateOptions" :key="d.value" :value="d.value">{{ d.label }}</option>
        </select>
        <button class="btn-run" :disabled="!store.isOperator" @click="runRecon">
          {{ existingJob(selectedDate) ? '🔁 重新执行对账（幂等）' : '▶ 执行对账' }}
        </button>
        <span v-if="!store.isOperator" class="role-warn">仅运营可执行对账 / 复核补偿，当前为用户只读视角</span>
        <span v-else-if="selectedDate !== store.todayDate" class="cross-tip">
          📅 跨日补核：差异补偿将计入执行日（{{ store.todayDate }}）流水，归属业务日 {{ selectedDate }} 保留，不串当日账
        </span>
      </div>
      <p class="rule-hint">
        三方独立来源交叉核对：① 业务台账（抽奖 / 兑换 / 任务奖励 / 风控冻结）② 积分流水（append-only，按归属业务日）
        ③ 库存流水与实时余量/预占。重复执行自动收敛：已补偿项把补偿流水计入账侧后必然核平，不重复补偿。
      </p>
    </div>

    <!-- 对账任务单 -->
    <div class="card">
      <div class="card-title">
        🗂️ 对账任务单（按业务日）
        <div class="filters">
          <button v-for="f in jobFilters" :key="f.key" :class="{ active: jobFilter === f.key }" @click="jobFilter = f.key">
            {{ f.label }}
            <em v-if="f.key !== 'all'">({{ jobCount(f.key) }})</em>
          </button>
        </div>
      </div>
      <div v-if="!visibleJobs.length" class="empty">暂无对账任务单，选择业务日执行对账</div>

      <div v-for="job in visibleJobs" :key="job.id" class="job" :class="job.status">
        <div class="j-head" @click="toggleJob(job.id)">
          <span class="j-date">{{ job.bizDate }}</span>
          <span v-if="job.bizDate === store.todayDate" class="j-today">当前业务日</span>
          <span v-else class="j-cross">历史补核</span>
          <span class="j-status" :class="job.status">{{ jobStatus(job.status).label }}</span>
          <span class="j-meta">
            核对 {{ job.summary.checks || 0 }} 项 ·
            <b :class="{ warn: (job.summary.diffs || 0) > 0 }">{{ job.summary.diffs || 0 }} 待复核</b> ·
            执行 {{ job.runs }} 次 · 末次 {{ job.lastRunAt || '—' }} · {{ job.operator }}
          </span>
          <span class="j-caret">{{ expanded[job.id] ? '▾' : '▸' }}</span>
        </div>

        <!-- 业务量汇总 -->
        <div v-if="job.summary && job.summary.checks" class="j-summary">
          <span>🎡 抽奖 {{ job.summary.drawCount || 0 }}</span>
          <span>🛍️ 兑换 {{ job.summary.redeemCount || 0 }}</span>
          <span>🎟️ 抽奖成本 {{ Math.abs(job.summary.drawCost || 0) }}</span>
          <span>🎁 抽奖积分奖品 {{ job.summary.drawReward || 0 }}</span>
          <span>💳 兑换成本 {{ Math.abs(job.summary.redeemCost || 0) }}</span>
          <span>🎯 任务奖励 {{ job.summary.taskReward || 0 }}</span>
          <span>📦 库存出库 {{ job.summary.stockOut || 0 }} 件</span>
        </div>

        <!-- 差异单 -->
        <div v-if="expanded[job.id]" class="diff-list">
          <div v-if="!diffsOf(job.id).length" class="no-diff">✅ 该业务日账实一致，无差异单</div>
          <div v-for="d in diffsOf(job.id)" :key="d.id" class="diff" :class="d.status">
            <div class="df-head">
              <span class="df-cat" :class="d.category">{{ categoryLabel(d.category) }}</span>
              <span class="df-metric">{{ d.metric }}</span>
              <span class="df-target">{{ d.targetName }}<i v-if="d.targetId"> · {{ d.targetId }}</i></span>
              <span class="df-status" :class="d.status">{{ diffStatus(d.status).label }}</span>
            </div>
            <div class="df-nums">
              <div><label>台账应有（业务事实）</label><b>{{ fmt(d.expected) }}</b></div>
              <div class="arrow">⇄</div>
              <div><label>账面实际（流水/实时）</label><b>{{ fmt(d.actual) }}</b></div>
              <div class="delta"><label>差异</label><b :class="d.delta > 0 ? 'plus' : 'minus'">{{ d.delta > 0 ? '+' : '' }}{{ fmt(d.delta) }}</b></div>
            </div>
            <ul class="df-evidence">
              <li v-for="(e, i) in (d.evidence || [])" :key="i">{{ e }}</li>
            </ul>
            <!-- 处理结论 -->
            <div v-if="d.status !== 'pending'" class="df-resolution" :class="d.status">
              <b>{{ d.status === 'compensated' ? '🛠️ 已补偿修正' : d.status === 'waived' ? '📌 已挂账保留' : '🔄 重核一致' }}：</b>
              {{ d.resolutionNote || '（无备注）' }}
              <span class="df-who">{{ d.reviewer }} · {{ d.resolvedAt }}</span>
            </div>
            <!-- 运营复核操作 -->
            <div v-if="store.isOperator && d.status === 'pending'" class="df-actions">
              <input v-model="reviewNotes[d.id]" placeholder="复核备注（可选），如：核实漏记，补偿修正" />
              <button class="btn-comp" @click="doCompensate(d)">🛠️ 补偿修正（写补偿流水）</button>
              <button class="btn-waive" @click="doWaive(d)">📌 挂账（保留差异不改账）</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 补偿流水 -->
    <div class="card">
      <div class="card-title">🧾 补偿流水（append-only，原始记录永不改写）</div>
      <div v-if="!store.reconCompensations.length" class="empty">暂无补偿流水</div>
      <div v-for="c in store.reconCompensations" :key="c.id" class="comp-row" :class="c.kind">
        <span class="c-icon">{{ c.kind === 'waive' ? '📌' : '🛠️' }}</span>
        <div class="c-main">
          <div class="c-title">
            {{ c.kind === 'waive' ? '差异挂账' : '对账补偿' }} · {{ c.targetName }}
            <em class="c-cat">{{ categoryLabel(c.nature) }}</em>
          </div>
          <div class="c-sub">
            归属业务日 <b>{{ c.bizDate }}</b>
            <template v-if="c.date !== c.bizDate"> · 执行日 {{ c.date }} <i class="c-cross">（跨日）</i></template>
            · {{ c.time }} · 单号 {{ c.id }} · 差异单 {{ c.refId }}
          </div>
          <div class="c-note">{{ c.note }}</div>
        </div>
        <span class="c-delta">
          <template v-if="c.kind === 'compensate'">
            <b v-if="c.delta" :class="c.delta > 0 ? 'plus' : 'minus'">{{ c.delta > 0 ? '+' : '' }}{{ c.delta }} 积分</b>
            <b v-else :class="(c.deltaHeld || c.deltaFrozen) > 0 ? 'plus' : 'minus'">
              {{ (c.deltaHeld || c.deltaFrozen) > 0 ? '+' : '' }}{{ c.deltaHeld || c.deltaFrozen }} 件
            </b>
          </template>
          <em v-else class="waive-txt">不改账</em>
        </span>
        <span class="c-op">{{ c.operator }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { usePlatformStore, RECON_JOB_STATUS, RECON_DIFF_STATUS, RECON_CATEGORY } from '@/store/platform'

const store = usePlatformStore()

const selectedDate = ref(store.todayDate)
const expanded = reactive({})
const reviewNotes = reactive({})
const jobFilter = ref('all')

const jobFilters = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待复核' },
  { key: 'balanced', label: '已核平' }
]

const dateOptions = computed(() => {
  const dates = new Set([store.todayDate])
  store.reconJobs.forEach((j) => dates.add(j.bizDate))
  store.records.forEach((r) => dates.add(r.date))
  return [...dates].sort().reverse().map((d) => ({
    value: d,
    label: d === store.todayDate ? `${d}（当前业务日）` : d
  }))
})

const visibleJobs = computed(() => {
  const list = jobFilter.value === 'all'
    ? store.reconJobs
    : store.reconJobs.filter((j) => j.status === jobFilter.value)
  return [...list].sort((a, b) => (a.bizDate < b.bizDate ? 1 : -1))
})
const jobCount = (k) => store.reconJobs.filter((j) => j.status === k).length

const existingJob = (date) => store.reconJobs.find((j) => j.bizDate === date)
const diffsOf = (jobId) => {
  const order = { pending: 0, compensated: 1, waived: 2, balanced: 3 }
  return [...store.reconDiffs.filter((d) => d.jobId === jobId)]
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.ts - a.ts)
}

const toggleJob = (id) => { expanded[id] = !expanded[id] }
const jobStatus = (s) => RECON_JOB_STATUS[s] || { label: s }
const diffStatus = (s) => RECON_DIFF_STATUS[s] || { label: s }
const categoryLabel = (c) => RECON_CATEGORY[c] || c
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(n))

function runRecon() {
  const job = store.reconcile(selectedDate.value)
  if (job) expanded[job.id] = true
}
function doCompensate(d) {
  if (store.compensateDiff(d.id, reviewNotes[d.id] || '')) reviewNotes[d.id] = ''
}
function doWaive(d) {
  if (store.waiveDiff(d.id, reviewNotes[d.id] || '')) reviewNotes[d.id] = ''
}
</script>

<style scoped>
.recon-view { display: flex; flex-direction: column; gap: 16px; max-width: 1040px; margin: 0 auto; }
.recon-hero {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  background: linear-gradient(135deg, #103a3a, #15305a);
  border: 1px solid rgba(77,208,205,0.3); border-radius: 14px; padding: 18px 22px; flex-wrap: wrap;
}
.hero-stats { display: flex; gap: 26px; flex-wrap: wrap; }
.hs-item { display: flex; flex-direction: column; }
.hs-num { font-size: 26px; font-weight: 800; line-height: 1; }
.hs-num.warn { color: #ffb74d; }
.hs-num.ok { color: #7ef0c9; }
.hs-num.ice { color: #81d4fa; }
.hs-lab { font-size: 11px; color: #9db0d0; margin-top: 5px; }
.role-box { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.role-tip { font-size: 11px; color: #9db0d0; }
.role-switch { display: flex; background: rgba(0,0,0,0.25); border-radius: 10px; padding: 3px; }
.role-switch button {
  background: transparent; border: none; color: #aebadd; font-size: 12px;
  padding: 7px 14px; border-radius: 8px; cursor: pointer;
}
.role-switch button.active {
  background: linear-gradient(135deg,#009688,#1565c0); color: #fff;
  box-shadow: 0 3px 8px rgba(0,150,136,0.4);
}

.card { background: #0f1b38; border: 1px solid rgba(120,160,220,0.16); border-radius: 14px; padding: 16px; }
.card-title {
  font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 14px;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
}
.filters { display: flex; gap: 5px; margin-left: auto; flex-wrap: wrap; }
.filters button {
  background: #13233f; border: 1px solid rgba(120,160,220,0.18); color: #8ba2c8;
  font-size: 11px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
}
.filters button.active { background: #009688; color: #fff; border-color: transparent; }
.filters em { font-style: normal; opacity: 0.8; }

.run-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.run-bar label { font-size: 12px; color: #8ba2c8; }
.run-bar select {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25); color: #dbe4f3;
  border-radius: 8px; padding: 8px 10px; font-size: 12px;
}
.btn-run {
  background: linear-gradient(135deg,#26c6da,#009688); color: #042622; border: none;
  border-radius: 9px; padding: 8px 16px; font-size: 12px; font-weight: 700; cursor: pointer;
}
.btn-run:disabled { background: #2a3a5e; color: #6f84ab; cursor: not-allowed; }
.role-warn { font-size: 11px; color: #ffb74d; }
.cross-tip { font-size: 11px; color: #ffd54f; background: rgba(255,193,7,0.1); border: 1px solid rgba(255,193,7,0.25); padding: 4px 10px; border-radius: 7px; }
.rule-hint { font-size: 11px; color: #6f84ab; margin: 12px 0 0; line-height: 1.6; }

.empty { color: #5b6f94; text-align: center; padding: 24px; font-size: 12px; }

.job {
  background: rgba(20,34,66,0.5); border: 1px solid rgba(120,160,220,0.14);
  border-left-width: 3px; border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;
}
.job.pending { border-left-color: #ff9800; }
.job.balanced { border-left-color: #4caf50; }
.j-head { display: flex; align-items: center; gap: 10px; cursor: pointer; flex-wrap: wrap; }
.j-date { font-size: 14px; font-weight: 800; color: #eef3fc; }
.j-today { font-size: 9px; background: rgba(41,98,255,0.2); color: #82b1ff; padding: 2px 8px; border-radius: 4px; }
.j-cross { font-size: 9px; background: rgba(255,193,7,0.15); color: #ffd54f; padding: 2px 8px; border-radius: 4px; }
.j-status { font-size: 11px; padding: 3px 10px; border-radius: 6px; font-weight: 600; }
.j-status.pending { background: rgba(255,152,0,0.18); color: #ffb74d; }
.j-status.balanced { background: rgba(76,175,80,0.18); color: #7ef0c9; }
.j-meta { font-size: 11px; color: #8ba2c8; margin-left: auto; }
.j-meta b { color: #c6d2e6; }
.j-meta b.warn { color: #ffb74d; }
.j-caret { color: #6f84ab; }

.j-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.j-summary span {
  font-size: 10px; color: #aebadd; background: rgba(120,160,220,0.1);
  border: 1px solid rgba(120,160,220,0.15); padding: 3px 9px; border-radius: 6px;
}
.no-diff { font-size: 12px; color: #7ef0c9; padding: 10px 2px; }

.diff-list { margin-top: 12px; display: flex; flex-direction: column; gap: 9px; }
.diff {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 9px; padding: 11px 12px;
}
.diff.pending { border-color: rgba(255,152,0,0.4); }
.diff.compensated { border-color: rgba(76,175,80,0.35); }
.diff.waived { border-color: rgba(129,212,250,0.3); }
.diff.balanced { border-color: rgba(120,160,220,0.2); opacity: 0.85; }
.df-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.df-cat { font-size: 10px; padding: 2px 8px; border-radius: 5px; font-weight: 600; }
.df-cat.points { background: rgba(255,193,7,0.18); color: #ffd54f; }
.df-cat.frozenPoints { background: rgba(129,212,250,0.18); color: #81d4fa; }
.df-cat.stock { background: rgba(0,188,212,0.18); color: #4dd0e1; }
.df-metric { font-size: 12px; color: #eef3fc; font-weight: 700; }
.df-target { font-size: 11px; color: #aebadd; }
.df-target i { color: #6f84ab; font-style: normal; }
.df-status { margin-left: auto; font-size: 10px; padding: 2px 9px; border-radius: 5px; font-weight: 600; }
.df-status.pending { background: rgba(255,152,0,0.18); color: #ffb74d; }
.df-status.compensated { background: rgba(76,175,80,0.18); color: #7ef0c9; }
.df-status.waived { background: rgba(129,212,250,0.16); color: #81d4fa; }
.df-status.balanced { background: rgba(120,160,220,0.12); color: #aebadd; }

.df-nums { display: flex; align-items: center; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
.df-nums > div { display: flex; flex-direction: column; gap: 2px; }
.df-nums label { font-size: 9px; color: #6f84ab; }
.df-nums b { font-size: 15px; color: #dbe4f3; }
.df-nums .arrow { color: #6f84ab; font-size: 14px; }
.df-nums .delta { margin-left: auto; }
.df-nums .delta b { font-size: 17px; }
.plus { color: #7ef0c9 !important; }
.minus { color: #ef9a9a !important; }

.df-evidence { margin: 9px 0 0; padding-left: 16px; }
.df-evidence li { font-size: 10px; color: #8ba2c8; line-height: 1.6; }
.df-resolution {
  margin-top: 9px; font-size: 11px; border-radius: 8px; padding: 8px 10px; line-height: 1.5;
}
.df-resolution.compensated { background: rgba(76,175,80,0.09); border: 1px solid rgba(76,175,80,0.25); color: #bfe8c8; }
.df-resolution.waived { background: rgba(129,212,250,0.08); border: 1px solid rgba(129,212,250,0.25); color: #c5e6f5; }
.df-resolution.balanced { background: rgba(120,160,220,0.08); border: 1px solid rgba(120,160,220,0.2); color: #c6d2e6; }
.df-who { display: block; font-size: 10px; color: #84a094; margin-top: 2px; }

.df-actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.df-actions input {
  flex: 1; min-width: 200px;
  background: #0c1730; border: 1px solid rgba(120,160,220,0.2); color: #dbe4f3;
  border-radius: 8px; padding: 8px 11px; font-size: 12px;
}
.df-actions button { border: none; border-radius: 8px; padding: 8px 13px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.btn-comp { background: linear-gradient(135deg,#26c6da,#009688); color: #042622; }
.btn-waive { background: linear-gradient(135deg,#5c7ea8,#3d5680); color: #eef3fc; }

.comp-row {
  display: flex; align-items: flex-start; gap: 10px; padding: 9px 0;
  border-bottom: 1px dashed rgba(120,160,220,0.1);
}
.comp-row:last-child { border-bottom: none; }
.c-icon { font-size: 18px; }
.c-main { flex: 1; min-width: 0; }
.c-title { font-size: 12px; color: #e8eefb; font-weight: 700; display: flex; align-items: center; gap: 7px; }
.c-cat { font-style: normal; font-size: 9px; background: rgba(120,160,220,0.14); color: #aebadd; padding: 1px 7px; border-radius: 4px; font-weight: 400; }
.c-sub { font-size: 10px; color: #6f84ab; margin-top: 2px; }
.c-sub b { color: #aebadd; }
.c-cross { color: #ffd54f; font-style: normal; }
.c-note { font-size: 11px; color: #9db0d0; margin-top: 3px; }
.c-delta { flex-shrink: 0; font-size: 12px; }
.c-delta .waive-txt { color: #81d4fa; font-size: 11px; }
.c-op { font-size: 10px; color: #6f84ab; flex-shrink: 0; }
.comp-row.waive { opacity: 0.85; }
</style>
