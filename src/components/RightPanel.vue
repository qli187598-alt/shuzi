<script setup lang="ts">
import * as echarts from 'echarts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommunityData } from '../types/community'

const props = defineProps<{
  security: CommunityData['security']
  accessHourly: number[]
  energy: CommunityData['energy']
  devices: CommunityData['devices']
}>()

const donutEl = ref<HTMLDivElement | null>(null)
const accessEl = ref<HTMLDivElement | null>(null)
let donutChart: ReturnType<typeof echarts.init> | null = null
let accessChart: ReturnType<typeof echarts.init> | null = null
let resizeObserver: ResizeObserver | null = null

const hours = Array.from({ length: 24 }, (_, hour) => hour.toString().padStart(2, '0'))

const normalRate = computed(() => {
  const total = props.security.normal + props.security.attention + props.security.alarm
  if (total === 0) return '0.0'
  return ((props.security.normal / total) * 100).toFixed(1)
})

function renderDonut() {
  donutChart?.setOption(
    {
      animationDuration: 500,
      series: [
        {
          type: 'pie',
          radius: ['64%', '82%'],
          center: ['50%', '50%'],
          silent: true,
          label: { show: false },
          data: [
            { name: '正常', value: props.security.normal, itemStyle: { color: '#3ecbff' } },
            { name: '关注', value: props.security.attention, itemStyle: { color: '#ffd15c' } },
            { name: '告警', value: props.security.alarm, itemStyle: { color: '#ff7a59' } },
          ],
        },
      ],
    },
    true,
  )
}

function renderAccess() {
  accessChart?.setOption(
    {
      animationDuration: 500,
      grid: { left: 36, right: 10, top: 16, bottom: 22 },
      xAxis: {
        type: 'category',
        data: hours,
        boundaryGap: false,
        axisLine: { lineStyle: { color: 'rgba(120, 190, 255, 0.28)' } },
        axisTick: { show: false },
        axisLabel: { color: '#8eb4d4', fontSize: 10, interval: 2 },
      },
      yAxis: {
        type: 'value',
        splitNumber: 3,
        axisLabel: { color: '#8eb4d4', fontSize: 10 },
        splitLine: { lineStyle: { color: 'rgba(120, 190, 255, 0.12)' } },
      },
      series: [
        {
          type: 'line',
          smooth: true,
          symbol: 'none',
          data: props.accessHourly,
          lineStyle: { color: '#3ecbff', width: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(62, 203, 255, 0.42)' },
              { offset: 1, color: 'rgba(62, 203, 255, 0.02)' },
            ]),
          },
        },
      ],
    },
    true,
  )
}

function mountCharts(attempt = 0) {
  const accessHeight = accessEl.value?.clientHeight ?? 0
  if (accessHeight === 0 && attempt < 30) {
    requestAnimationFrame(() => mountCharts(attempt + 1))
    return
  }
  if (donutEl.value) donutChart = echarts.init(donutEl.value, undefined, { renderer: 'canvas' })
  if (accessEl.value && accessHeight > 0) {
    accessChart = echarts.init(accessEl.value, undefined, { renderer: 'canvas' })
  }
  renderDonut()
  renderAccess()
  resizeObserver = new ResizeObserver(() => {
    donutChart?.resize()
    accessChart?.resize()
  })
  if (donutEl.value) resizeObserver.observe(donutEl.value)
  if (accessEl.value) resizeObserver.observe(accessEl.value)
}

onMounted(async () => {
  await nextTick()
  mountCharts()
})

watch(
  () => [props.security.normal, props.security.attention, props.security.alarm],
  () => renderDonut(),
)

watch(
  () => props.accessHourly,
  () => renderAccess(),
  { deep: true },
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  donutChart?.dispose()
  accessChart?.dispose()
})
</script>

<template>
  <section class="panel chart-card">
    <h3 class="panel-title">设备状态</h3>
    <div class="security-body">
      <div class="donut-wrap">
        <div ref="donutEl" class="donut"></div>
        <div class="donut-center">
          <strong>{{ normalRate }}%</strong>
          <span>在线率</span>
        </div>
      </div>
      <ul class="legend">
        <li><i class="dot normal"></i>正常设备<em>{{ security.normal }}</em></li>
        <li><i class="dot attention"></i>待检设备<em>{{ security.attention }}</em></li>
        <li><i class="dot alarm"></i>异常设备<em>{{ security.alarm }}</em></li>
      </ul>
    </div>
  </section>

  <section class="panel chart-card">
    <h3 class="panel-title">今日入园</h3>
    <div ref="accessEl" class="chart"></div>
  </section>

  <section class="panel chart-card">
    <h3 class="panel-title">监控状态</h3>
    <div class="monitor-grid">
      <div v-for="item in devices" :key="item.name" class="monitor-item">
        <i :class="{ warning: item.rate < 92 }"></i>
        <span>{{ item.name }}</span>
        <em>{{ item.rate }}%</em>
      </div>
    </div>
  </section>

  <section class="panel chart-card">
    <h3 class="panel-title">能耗统计</h3>
    <div class="energy-bars">
      <div v-for="item in energy" :key="item.name" class="energy-bar">
        <span class="bar-value">{{ item.value.toLocaleString('zh-CN') }}</span>
        <i :style="{ height: `${item.percent}%` }"></i>
        <em>{{ item.name }}</em>
      </div>
    </div>
  </section>
</template>
