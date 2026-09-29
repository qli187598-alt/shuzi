import type { Building, CommunityData, DeviceItem } from '../types/community'
import { mulberry32 } from '../utils/random'

const ACCESS_SHAPE = [
  0.42, 0.28, 0.18, 0.14, 0.18, 0.4, 0.86, 1.55, 2.15, 1.72, 1.22, 1.08, 1.16, 1.08, 0.96, 1.22,
  1.95, 2.35, 2.05, 1.42, 0.92, 0.62, 0.46, 0.36,
]

const DEVICES: DeviceItem[] = [
  { name: '视频监控', rate: 98 },
  { name: '门禁道闸', rate: 96 },
  { name: '消防主机', rate: 100 },
  { name: '电梯系统', rate: 92 },
  { name: '公共照明', rate: 88 },
  { name: '给排水泵', rate: 95 },
]

function building(
  id: string,
  name: string,
  x: number,
  z: number,
  floors: number,
  households: number,
  alarm: boolean,
  width = 11,
  depth = 10,
): Building {
  return { id, name, x, z, floors, households, alarm, width, depth }
}

function scaleToTotal(weights: number[], total: number) {
  const sum = weights.reduce((totalWeight, weight) => totalWeight + weight, 0)
  const values = weights.map((weight) => Math.max(0, Math.round((weight / sum) * total)))
  const diff = total - values.reduce((totalValue, value) => totalValue + value, 0)
  const last = values.length - 1
  values[last] = Math.max(0, (values[last] ?? 0) + diff)
  return values
}

function metricsFromBuildings(buildings: Building[]) {
  const households = buildings.reduce((sum, item) => sum + item.households, 0)
  const alarms = buildings.filter((item) => item.alarm).length
  const tallTowers = buildings.filter((item) => item.floors >= 33).length
  return {
    households,
    alarms,
    todayVehicles: Math.round(households * 1.81),
    peopleOnSite: Math.round(households * 0.27),
    security: {
      normal: Math.round(households * 0.287),
      attention: tallTowers + alarms,
      alarm: alarms,
    },
    energy: [
      { name: '用电', value: Math.round(households * 14.88), unit: 'kWh', percent: 72 },
      { name: '用水', value: Math.round(households * 0.447), unit: 't', percent: 54 },
      { name: '用气', value: Math.round(households * 1.065), unit: 'm³', percent: 41 },
    ],
    devices: DEVICES.map((device) => ({
      ...device,
      rate: device.name === '电梯系统' || device.name === '公共照明' ? Math.max(80, device.rate - alarms) : device.rate,
    })),
  }
}

export function createInitialCommunity(): CommunityData {
  const buildings = [
    building('A1', '1号楼', -26, -22, 30, 80, false, 8.4, 7.2),
    building('A2', '2号楼', -11, -22, 34, 76, true, 8.4, 7.2),
    building('A3', '3号楼', 11, -22, 32, 72, false, 8.4, 7.2),
    building('A4', '4号楼', 26, -22, 28, 68, true, 8.4, 7.2),
    building('B1', '5号楼', -26, -6, 36, 84, false, 8.4, 7.2),
    building('B2', '6号楼', -11, -6, 27, 64, true, 8.4, 7.2),
    building('B3', '7号楼', 11, -6, 31, 60, false, 8.4, 7.2),
    building('B4', '8号楼', 26, -6, 35, 88, true, 8.4, 7.2),
    building('C1', '9号楼', -26, 10, 26, 56, true, 8.4, 7.2),
    building('C2', '10号楼', -11, 10, 33, 72, false, 8.4, 7.2),
    building('C3', '11号楼', 11, 10, 29, 76, true, 8.4, 7.2),
    building('C4', '12号楼', 26, 10, 24, 68, true, 8.4, 7.2),
  ]
  const metrics = metricsFromBuildings(buildings)
  return {
    patternSalt: 7,
    parkingSpaces: 328,
    buildings,
    gate: {
      name: '南门主通道',
      todayVehicles: metrics.todayVehicles,
      peopleOnSite: metrics.peopleOnSite,
    },
    security: metrics.security,
    accessHourly: scaleToTotal(ACCESS_SHAPE, metrics.todayVehicles),
    energy: metrics.energy,
    devices: metrics.devices,
  }
}

export function regenerateCommunity(current: CommunityData): CommunityData {
  const random = mulberry32((Date.now() ^ Math.floor(Math.random() * 1_000_000_000)) >>> 0)
  const buildings = current.buildings.map((item) => {
    const floors = 16 + Math.floor(random() * 18)
    const perFloor = 2 + Math.floor(random() * 3)
    return {
      ...item,
      floors,
      households: floors * perFloor,
      alarm: random() > 0.72,
    }
  })
  const noisyShape = ACCESS_SHAPE.map((weight) => weight * (0.72 + random() * 0.55))
  const metrics = metricsFromBuildings(buildings)
  return {
    patternSalt: Math.floor(random() * 1_000_000_000),
    buildings,
    parkingSpaces: 260 + Math.floor(random() * 140),
    gate: {
      name: '南门主通道',
      todayVehicles: metrics.todayVehicles,
      peopleOnSite: metrics.peopleOnSite,
    },
    security: metrics.security,
    accessHourly: scaleToTotal(noisyShape, metrics.todayVehicles),
    energy: metrics.energy,
    devices: metrics.devices,
  }
}
