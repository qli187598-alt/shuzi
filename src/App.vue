<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import RightPanel from './components/RightPanel.vue'
import { DESIGN_HEIGHT, DESIGN_WIDTH, useScreenScale } from './composables/useScreenScale'
import { createInitialCommunity } from './data/community'
import { CommunityScene, type ProjectedPoint } from './three/CommunityScene'

const { scale, style: screenStyle } = useScreenScale()
const canvasRef = ref<HTMLCanvasElement | null>(null)
const gateEl = ref<HTMLDivElement | null>(null)
const buildingEl = ref<HTMLDivElement | null>(null)
const data = ref(createInitialCommunity())
const selectedId = ref<string | null>(null)
const toast = ref('')
const showVideo = ref(false)
const now = ref(formatNow(new Date()))

let scene: CommunityScene | null = null
let clockTimer = 0
let toastTimer = 0

const selected = computed(() => data.value.buildings.find((item) => item.id === selectedId.value) ?? null)
const gateOpen = computed(() => selectedId.value === 'gate')
const selectedFlow = computed(() => (selected.value ? Math.max(12, Math.round(selected.value.households * 0.16)) : 0))
const selectedVisits = computed(() => (selected.value ? Math.round(selected.value.households * 1.81) : 0))
const householdCount = computed(() => data.value.buildings.reduce((sum, item) => sum + item.households, 0))
const alarmCount = computed(() => data.value.buildings.filter((item) => item.alarm).length)

function formatNow(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function place(el: HTMLElement | null, point: ProjectedPoint) {
  if (!el) return
  const currentScale = scale.value
  const boxLeft = (window.innerWidth - DESIGN_WIDTH * currentScale) / 2
  const boxTop = (window.innerHeight - DESIGN_HEIGHT * currentScale) / 2
  el.style.left = `${(point.x - boxLeft) / currentScale}px`
  el.style.top = `${(point.y - boxTop) / currentScale}px`
  el.style.opacity = point.visible ? '1' : '0'
}

function showToast(message: string) {
  toast.value = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 1600)
}

function openVideo() {
  showVideo.value = true
}

function closeVideo() {
  showVideo.value = false
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  scene = new CommunityScene(canvas, data.value.buildings, data.value.patternSalt, {
    onSelect: (id) => {
      selectedId.value = id
    },
    onProject: (gate, building) => {
      place(gateEl.value, gate)
      place(buildingEl.value, building)
    },
  })
  clockTimer = window.setInterval(() => {
    now.value = formatNow(new Date())
  }, 1000)
})

onBeforeUnmount(() => {
  window.clearInterval(clockTimer)
  window.clearTimeout(toastTimer)
  scene?.dispose()
  scene = null
})
</script>

<template>
  <div class="viewport">
    <canvas ref="canvasRef" class="webgl"></canvas>
    <div class="vignette"></div>
    <div class="screen" :style="screenStyle">
      <i class="frame-corner tl"></i>
      <i class="frame-corner tr"></i>
      <i class="frame-corner bl"></i>
      <i class="frame-corner br"></i>

      <header class="title-block">
        <div class="title-line"></div>
        <div class="titles">
          <h1>智慧小区3D可视化平台</h1>
          <p>Community 3D Visualization Dashboard</p>
        </div>
        <div class="title-line mirror"></div>
      </header>

      <aside class="left interactive">
        <article class="kpi">
          <div class="kpi-icon">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M8 42V20l16-10 16 10v22H8Z" fill="none" stroke="currentColor" stroke-width="2.4" />
              <path d="M20 42V28h8v14" fill="none" stroke="currentColor" stroke-width="2.4" />
            </svg>
          </div>
          <div>
            <div class="kpi-label">楼栋总数</div>
            <div class="kpi-value">{{ data.buildings.length }}<small>栋</small></div>
          </div>
        </article>

        <article class="kpi">
          <div class="kpi-icon">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <circle cx="24" cy="16" r="7" fill="none" stroke="currentColor" stroke-width="2.4" />
              <path d="M10 40c2.2-8 7.2-12 14-12s11.8 4 14 12" fill="none" stroke="currentColor" stroke-width="2.4" />
            </svg>
          </div>
          <div>
            <div class="kpi-label">住户总数</div>
            <div class="kpi-value">{{ householdCount.toLocaleString('zh-CN') }}<small>户</small></div>
          </div>
        </article>

        <article class="kpi">
          <div class="kpi-icon">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M8 30h24l4-8H18l-3-6H8v14Z" fill="none" stroke="currentColor" stroke-width="2.4" />
              <circle cx="16" cy="34" r="3" fill="none" stroke="currentColor" stroke-width="2.4" />
              <circle cx="32" cy="34" r="3" fill="none" stroke="currentColor" stroke-width="2.4" />
            </svg>
          </div>
          <div>
            <div class="kpi-label">车位总数</div>
            <div class="kpi-value">{{ data.parkingSpaces }}<small>个</small></div>
          </div>
        </article>

        <article class="kpi alarm">
          <div class="kpi-icon">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <path d="M24 8 40 38H8L24 8Z" fill="none" stroke="currentColor" stroke-width="2.4" />
              <path d="M24 20v9" stroke="currentColor" stroke-width="2.4" />
              <circle cx="24" cy="33" r="1.4" fill="currentColor" />
            </svg>
          </div>
          <div>
            <div class="kpi-label">告警事件</div>
            <div class="kpi-value">{{ alarmCount }}<small>起</small></div>
          </div>
        </article>
      </aside>

      <aside class="right interactive">
        <div class="status-bar">
          <div class="clock">{{ now }}</div>
          <div class="run-state"><i></i>系统运行正常</div>
        </div>
        <RightPanel
          :security="data.security"
          :access-hourly="data.accessHourly"
          :energy="data.energy"
          :devices="data.devices"
        />
      </aside>

      <section v-if="selected || gateOpen" class="overview-card">
        <div class="overview-heading">
          <span class="overview-dot"></span>
          <span>重点区域</span>
          <b>AI 智能分析</b>
        </div>
        <div class="overview-content">
          <div class="camera-preview">
            <span>社区实景监控</span>
          </div>
          <div v-if="gateOpen" class="overview-info">
            <strong>{{ data.gate.name }}</strong>
            <p><i></i>今日通行：{{ data.gate.todayVehicles.toLocaleString('zh-CN') }} 次</p>
            <p><i></i>在园人数：{{ data.gate.peopleOnSite.toLocaleString('zh-CN') }} 人</p>
            <p><i></i>状态：正常</p>
            <div class="overview-actions">
              <button type="button" @click="openVideo">实时监控</button>
              <button type="button" @click="showToast('已生成大门通行报告')">查看详情</button>
            </div>
          </div>
          <div v-else-if="selected" class="overview-info">
            <strong>{{ selected.name }} · {{ selected.floors }} 层</strong>
            <p><i></i>住户：{{ selected.households }} 户</p>
            <p><i></i>今日通行：{{ selectedVisits.toLocaleString('zh-CN') }} 次</p>
            <p><i></i>在楼人数：{{ selectedFlow }} 人</p>
            <p><i></i>状态：{{ selected.alarm ? '告警' : '正常' }}</p>
            <div class="overview-actions">
              <button type="button" @click="openVideo">实时监控</button>
              <button type="button" @click="showToast('已生成区域报告')">查看详情</button>
            </div>
          </div>
        </div>
      </section>

      <div ref="gateEl" class="gate-anchor" aria-hidden="true"></div>

      <div v-if="showVideo" class="video-dialog" @click.self="closeVideo">
        <section class="video-window" role="dialog" aria-modal="true" aria-label="实时监控视频">
          <header>
            <span><i></i>{{ selected?.name ?? data.gate.name }} · 实时监控</span>
            <button type="button" aria-label="关闭视频" @click="closeVideo">×</button>
          </header>
          <video controls autoplay muted playsinline>
            <source src="https://media.w3.org/2010/05/sintel/trailer.mp4" type="video/mp4" />
            当前浏览器不支持视频播放。
          </video>
          <footer><i></i>实时画面 · 演示视频源</footer>
        </section>
      </div>

      <div class="hint">拖拽旋转视角 · 滚轮缩放 · 点击楼栋或大门查看</div>
      <div v-if="toast" class="toast">{{ toast }}</div>
    </div>
  </div>
</template>
