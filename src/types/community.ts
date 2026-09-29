export interface Building {
  id: string
  name: string
  x: number
  z: number
  floors: number
  households: number
  alarm: boolean
  width: number
  depth: number
}

export interface EnergyItem {
  name: string
  value: number
  unit: string
  percent: number
}

export interface DeviceItem {
  name: string
  rate: number
}

export interface CommunityData {
  patternSalt: number
  buildings: Building[]
  parkingSpaces: number
  gate: {
    name: string
    todayVehicles: number
    peopleOnSite: number
  }
  security: {
    normal: number
    attention: number
    alarm: number
  }
  accessHourly: number[]
  energy: EnergyItem[]
  devices: DeviceItem[]
}
