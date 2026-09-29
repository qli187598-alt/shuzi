import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js'
import type { Building } from '../types/community'
import { hashString, mulberry32 } from '../utils/random'
import { createFacadeTextures, facadeBayUs } from './facadeTexture'

export interface ProjectedPoint {
  x: number
  y: number
  visible: boolean
}

interface SceneHooks {
  onSelect: (buildingId: string | null) => void
  onProject: (gate: ProjectedPoint, building: ProjectedPoint) => void
}

interface Rect {
  x: number
  z: number
  w: number
  d: number
}

interface MovingCar {
  group: THREE.Group
  z: number
  x: number
  speed: number
  direction: number
  turning: boolean
  turnT: number
  fromX: number
  toX: number
  wheels: THREE.Object3D[]
}

interface Walker {
  group: THREE.Group
  z: number
  speed: number
  direction: number
  minZ: number
  maxZ: number
  phase: number
}

interface BuildingVisual {
  edge: THREE.LineBasicMaterial
  body: THREE.MeshStandardMaterial
  alarm: boolean
}

const STORAGE_KEY = 'smart-community-camera-v4'
const FLOOR_HEIGHT = 0.5
const PODIUM_HEIGHT = 1.55
const BASE_Y = 0.16

const ROADS: Rect[] = [
  { x: 0, z: 18, w: 6.6, d: 124 },
  { x: 0, z: -14, w: 72, d: 5.4 },
  { x: 0, z: 2, w: 72, d: 5.4 },
  { x: 0, z: 20, w: 34, d: 8 },
]

export class CommunityScene {
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly composer: EffectComposer
  private readonly controls: OrbitControls
  private readonly timer = new THREE.Timer()
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly projected = new THREE.Vector3()
  private readonly gateAnchor = new THREE.Vector3(0, 5.4, 29.8)
  private readonly beacons: THREE.MeshStandardMaterial[] = []
  private readonly focusPoint = new THREE.Vector3()
  private readonly buildingRoot = new THREE.Group()
  private readonly anchors = new Map<string, THREE.Vector3>()
  private readonly visuals = new Map<string, BuildingVisual>()
  private readonly pickables: THREE.Object3D[] = []
  private readonly tracked: Array<{ dispose: () => void }> = []
  private readonly buildingResources: Array<{ dispose: () => void }> = []
  private readonly cars: MovingCar[] = []
  private readonly walkers: Walker[] = []
  private readonly gatePickables: THREE.Object3D[] = []
  private readonly waterJets: THREE.Object3D[] = []
  private selectedId: string | null = null
  private focusActive = false
  private pointerDown = false
  private downX = 0
  private downY = 0
  private frame = 0
  private readonly canvas: HTMLCanvasElement
  private readonly hooks: SceneHooks

  constructor(canvas: HTMLCanvasElement, buildings: Building[], patternSalt: number, hooks: SceneHooks) {
    this.canvas = canvas
    this.hooks = hooks
    this.scene.background = new THREE.Color('#07111f')
    this.scene.fog = new THREE.FogExp2('#0b1830', 0.0115)
    this.scene.add(this.buildingRoot)

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.66
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))

    this.camera = new THREE.PerspectiveCamera(33, 1, 0.1, 420)
    this.camera.position.set(48, 56, 78)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.target.set(0, 4, 16)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.maxPolarAngle = Math.PI / 2.08
    this.controls.minPolarAngle = 0.38
    this.controls.minDistance = 32
    this.controls.maxDistance = 168
    this.controls.update()

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const envScene = new RoomEnvironment()
    const envTexture = pmrem.fromScene(envScene, 0.04).texture
    this.scene.environment = envTexture
    this.track(envTexture)
    envScene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach((material) => material.dispose())
      }
    })
    pmrem.dispose()

    this.buildLights()
    this.buildGround()
    this.buildRoads()
    this.buildSiteContext()
    this.buildEntrance()
    this.buildCommercialStreets()
    this.buildCommunityGarden()
    this.buildNature(buildings)
    this.buildTraffic()
    this.buildPeople()
    this.rebuildBuildings(buildings, patternSalt)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.composer.addPass(new SMAAPass())
    this.composer.addPass(new OutputPass())

    this.resize()
    this.restoreCamera()
    this.timer.connect(document)
    window.addEventListener('resize', this.resize)
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    this.frame = requestAnimationFrame(this.animate)
  }

  setBuildings(buildings: Building[], patternSalt: number) {
    this.selectedId = null
    this.focusActive = false
    this.rebuildBuildings(buildings, patternSalt)
    this.hooks.onSelect(null)
  }

  saveCamera() {
    const position = this.camera.position
    const target = this.controls.target
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        p: [position.x, position.y, position.z],
        t: [target.x, target.y, target.z],
      }),
    )
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    this.timer.disconnect()
    this.timer.dispose()
    window.removeEventListener('resize', this.resize)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    this.clearBuildings()
    this.tracked.forEach((resource) => resource.dispose())
    this.controls.dispose()
    this.composer.dispose()
    this.renderer.dispose()
  }

  private readonly resize = () => {
    const width = Math.max(window.innerWidth, 1)
    const height = Math.max(window.innerHeight, 1)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.setSize(width, height, false)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(width, height)
  }

  private readonly animate = (timestamp: number) => {
    this.frame = requestAnimationFrame(this.animate)
    this.timer.update(timestamp)
    const delta = Math.min(this.timer.getDelta(), 0.05)
    const elapsed = this.timer.getElapsed()

    for (const car of this.cars) this.stepCar(car, delta)
    for (const walker of this.walkers) {
      walker.z += walker.direction * walker.speed * delta
      if (walker.z > walker.maxZ || walker.z < walker.minZ) {
        walker.z = THREE.MathUtils.clamp(walker.z, walker.minZ, walker.maxZ)
        walker.direction *= -1
        walker.group.rotation.y = walker.direction > 0 ? Math.PI : 0
      }
      walker.group.position.z = walker.z
      walker.group.position.y = Math.abs(Math.sin(elapsed * 6 + walker.phase)) * 0.05
    }
    const jetPulse = 0.82 + Math.sin(elapsed * 2.6) * 0.18
    for (const jet of this.waterJets) jet.scale.y = jetPulse

    for (const [id, visual] of this.visuals) {
      const selected = id === this.selectedId
      visual.body.emissiveIntensity = selected ? 0.42 : 0.18
      visual.edge.opacity = selected ? 1 : 0
      visual.edge.color.set(visual.alarm ? '#ff8a4c' : '#f4efe4')
    }
    const beaconPulse = 1.5 + Math.sin(elapsed * 3.2) * 0.7
    for (const beacon of this.beacons) beacon.emissiveIntensity = beaconPulse

    if (this.focusActive) {
      this.controls.target.lerp(this.focusPoint, Math.min(1, delta * 2.4))
      if (this.controls.target.distanceTo(this.focusPoint) < 0.2) this.focusActive = false
    }

    this.controls.update()
    this.composer.render()

    const buildingAnchor = this.selectedId ? this.anchors.get(this.selectedId) : undefined
    this.hooks.onProject(
      this.project(this.gateAnchor),
      buildingAnchor ? this.project(buildingAnchor) : { x: 0, y: 0, visible: false },
    )
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pointerDown = true
    this.focusActive = false
    this.downX = event.clientX
    this.downY = event.clientY
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.canvas.style.cursor = this.hitBuilding(event) ? 'pointer' : ''
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    if (!this.pointerDown) return
    this.pointerDown = false
    const dx = event.clientX - this.downX
    const dy = event.clientY - this.downY
    if (dx * dx + dy * dy > 25) return
    const id = this.hitBuilding(event)
    this.selectedId = id
    if (id) {
      const anchor = this.anchors.get(id)
      if (anchor) {
        const focusY = id === 'gate' ? 3.2 : Math.min(anchor.y * 0.28, 12)
        this.focusPoint.set(anchor.x, focusY, anchor.z)
        this.focusActive = true
      }
    }
    this.hooks.onSelect(id)
  }

  private hitBuilding(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.pickables, false)
    for (const hit of hits) {
      const id = hit.object.userData.buildingId
      if (typeof id === 'string') return id
    }
    return null
  }

  private stepCar(car: MovingCar, delta: number) {
    const south = 70
    const north = -38
    if (car.turning) {
      car.turnT += delta * 0.72
      const t = Math.min(1, car.turnT)
      const ease = t * t * (3 - 2 * t)
      car.x = car.fromX + (car.toX - car.fromX) * ease
      const endZ = car.direction > 0 ? south : north
      car.z = endZ + car.direction * Math.sin(t * Math.PI) * 2.2
      const startYaw = car.direction > 0 ? Math.PI : 0
      const endYaw = car.direction > 0 ? Math.PI * 2 : -Math.PI
      car.group.rotation.y = startYaw + (endYaw - startYaw) * ease
      if (t >= 1) {
        car.turning = false
        car.direction *= -1
        car.z = endZ
        car.group.rotation.y = car.direction > 0 ? Math.PI : 0
      }
    } else {
      car.z += car.direction * car.speed * delta
      if (car.direction > 0 && car.z >= south) {
        car.z = south
        car.turning = true
        car.turnT = 0
        car.fromX = car.x
        car.toX = -1.55
      } else if (car.direction < 0 && car.z <= north) {
        car.z = north
        car.turning = true
        car.turnT = 0
        car.fromX = car.x
        car.toX = 1.55
      }
    }
    car.group.position.x = car.x
    car.group.position.z = car.z
    const spin = (car.speed * delta) / 0.3
    for (const wheel of car.wheels) wheel.rotation.x += spin
  }

  private markGate(mesh: THREE.Mesh) {
    mesh.userData.buildingId = 'gate'
    this.gatePickables.push(mesh)
    return mesh
  }

  private project(world: THREE.Vector3): ProjectedPoint {
    this.projected.copy(world).project(this.camera)
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: (this.projected.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-this.projected.y * 0.5 + 0.5) * rect.height + rect.top,
      visible: this.projected.z >= -1 && this.projected.z <= 1,
    }
  }

  private restoreCamera() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as { p?: number[]; t?: number[] }
      if (!saved.p || !saved.t || saved.p.length < 3 || saved.t.length < 3) return
      const [px, py, pz] = saved.p
      const [tx, ty, tz] = saved.t
      if ([px, py, pz, tx, ty, tz].some((value) => typeof value !== 'number' || Number.isNaN(value))) return
      this.camera.position.set(px, py, pz)
      this.controls.target.set(tx, ty, tz)
      this.controls.update()
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  private track<T extends { dispose: () => void }>(resource: T) {
    this.tracked.push(resource)
    return resource
  }

  private keep<T extends { dispose: () => void }>(resource: T) {
    this.buildingResources.push(resource)
    return resource
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight('#243656', '#2a1c12', 0.34))
    this.scene.add(new THREE.AmbientLight('#1a2740', 0.16))

    const sun = new THREE.DirectionalLight('#ffb27a', 0.58)
    sun.position.set(46, 24, -34)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -90
    sun.shadow.camera.right = 90
    sun.shadow.camera.top = 90
    sun.shadow.camera.bottom = -90
    sun.shadow.camera.near = 8
    sun.shadow.camera.far = 220
    sun.shadow.bias = -0.00035
    sun.shadow.normalBias = 0.04
    sun.target.position.set(0, 0, -8)
    this.scene.add(sun, sun.target)

    const fill = new THREE.DirectionalLight('#1d4f86', 0.28)
    fill.position.set(-30, 36, -10)
    this.scene.add(fill)
  }

  private buildGround() {
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const gradient = ctx.createRadialGradient(256, 256, 30, 256, 256, 256)
    gradient.addColorStop(0, '#24583a')
    gradient.addColorStop(0.22, '#173c2c')
    gradient.addColorStop(0.48, '#0a1c18')
    gradient.addColorStop(1, '#07111f')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 512, 512)
    const random = mulberry32(29)
    for (let index = 0; index < 420; index += 1) {
      const x = random() * 512
      const y = random() * 512
      const radius = 1 + random() * 6
      ctx.fillStyle = random() > 0.5 ? 'rgba(86, 168, 72, 0.22)' : 'rgba(28, 92, 48, 0.2)'
      ctx.beginPath()
      ctx.ellipse(x, y, radius * 1.8, radius, random() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    const texture = this.track(new THREE.CanvasTexture(canvas))
    texture.colorSpace = THREE.SRGBColorSpace
    const ground = new THREE.Mesh(
      this.track(new THREE.CircleGeometry(118, 64)),
      this.track(new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 })),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)
  }

  private buildRoads() {
    const sidewalk = this.track(new THREE.MeshStandardMaterial({ color: '#d9d5cc', roughness: 0.92 }))
    const curb = this.track(new THREE.MeshStandardMaterial({ color: '#b7b3aa', roughness: 0.78 }))
    const asphaltTexture = this.track(createRoadTexture())
    const asphalt = this.track(new THREE.MeshStandardMaterial({ map: asphaltTexture, color: '#ffffff', roughness: 0.94, metalness: 0.02 }))
    const paint = this.track(new THREE.MeshStandardMaterial({ color: '#f3f1ea', roughness: 0.55 }))

    for (const road of ROADS) {
      const horizontal = road.w > road.d
      this.addStaticBox(road.w + 2.6, 0.16, road.d + 2.6, sidewalk, road.x, 0.12, road.z)
      this.addStaticBox(road.w, 0.12, road.d, asphalt, road.x, 0.22, road.z)
      if (horizontal) {
        this.raise(this.addStaticBox(road.w, 0.32, 0.22, curb, road.x, 0.28, road.z - road.d / 2 - 0.04))
        this.raise(this.addStaticBox(road.w, 0.32, 0.22, curb, road.x, 0.28, road.z + road.d / 2 + 0.04))
      } else {
        this.raise(this.addStaticBox(0.22, 0.32, road.d, curb, road.x - road.w / 2 - 0.04, 0.28, road.z))
        this.raise(this.addStaticBox(0.22, 0.32, road.d, curb, road.x + road.w / 2 + 0.04, 0.28, road.z))
      }
    }
    for (const yard of [
      [-18.5, -22],
      [18.5, -22],
      [-18.5, -6],
      [18.5, -6],
      [-18.5, 10],
      [18.5, 10],
    ] as const) {
      this.addGrassPatch(5.2, 5.4, yard[0], yard[1])
    }

    const dashGeo = this.track(new THREE.BoxGeometry(0.14, 0.025, 1.35))
    const dashes: Array<{ x: number; z: number; alongX: boolean }> = []
    for (let z = -36; z <= 74; z += 3.6) {
      const crossing = Math.abs(z + 14) < 3.4 || Math.abs(z - 2) < 3.4 || Math.abs(z - 20) < 4.4 || Math.abs(z - 34) < 3.6
      if (!crossing) dashes.push({ x: 0, z, alongX: false })
    }
    for (const roadZ of [-14, 2]) {
      for (let x = -32; x <= 32; x += 3.6) {
        if (Math.abs(x) < 5) continue
        dashes.push({ x, z: roadZ, alongX: true })
      }
    }
    const dashMesh = new THREE.InstancedMesh(dashGeo, paint, dashes.length)
    const dummy = new THREE.Object3D()
    dashes.forEach((dash, index) => {
      dummy.position.set(dash.x, 0.3, dash.z)
      dummy.rotation.y = dash.alongX ? Math.PI / 2 : 0
      dummy.updateMatrix()
      dashMesh.setMatrixAt(index, dummy.matrix)
    })
    dashMesh.instanceMatrix.needsUpdate = true
    this.scene.add(dashMesh)

    for (let index = -3; index <= 3; index += 1) {
      this.addStaticBox(0.55, 0.03, 2.6, paint, index * 1.05, 0.3, 16.4)
    }
  }

  private buildSiteContext() {
    const sidewalk = this.track(new THREE.MeshStandardMaterial({ color: '#d4d0c7', roughness: 0.92 }))
    const curb = this.track(new THREE.MeshStandardMaterial({ color: '#b5b1a8', roughness: 0.8 }))
    const asphalt = this.track(new THREE.MeshStandardMaterial({ color: '#4c535b', roughness: 0.95 }))
    const lanePaint = this.track(new THREE.MeshStandardMaterial({ color: '#efece4', roughness: 0.55 }))
    const fence = this.track(new THREE.MeshStandardMaterial({ color: '#6d767e', roughness: 0.48, metalness: 0.62 }))

    const addOuterRoad = (width: number, depth: number, x: number, z: number) => {
      const horizontal = width > depth
      this.addStaticBox(width + 2.4, 0.16, depth + 2.4, sidewalk, x, 0.12, z)
      this.addStaticBox(width, 0.12, depth, asphalt, x, 0.22, z)
      if (horizontal) {
        this.raise(this.addStaticBox(width, 0.3, 0.2, curb, x, 0.27, z - depth / 2 - 0.04))
        this.raise(this.addStaticBox(width, 0.3, 0.2, curb, x, 0.27, z + depth / 2 + 0.04))
      } else {
        this.raise(this.addStaticBox(0.2, 0.3, depth, curb, x - width / 2 - 0.04, 0.27, z))
        this.raise(this.addStaticBox(0.2, 0.3, depth, curb, x + width / 2 + 0.04, 0.27, z))
      }
    }
    addOuterRoad(94, 5.2, 0, -39)
    addOuterRoad(94, 5.2, 0, 34)
    addOuterRoad(5.2, 68, -47, -2.5)
    addOuterRoad(5.2, 68, 47, -2.5)

    const outerDashes = this.track(new THREE.BoxGeometry(1.8, 0.05, 0.16))
    const dummy = new THREE.Object3D()
    const dashPositions: Array<[number, number, number]> = []
    for (let x = -42; x <= 42; x += 4.5) dashPositions.push([x, -39, 0], [x, 34, 0])
    for (let z = -33; z <= 29; z += 4.5) dashPositions.push([-47, z, Math.PI / 2], [47, z, Math.PI / 2])
    const dashes = new THREE.InstancedMesh(outerDashes, lanePaint, dashPositions.length)
    dashPositions.forEach(([x, z, rotation], index) => {
      dummy.position.set(x, 0.3, z)
      dummy.rotation.set(0, rotation, 0)
      dummy.updateMatrix()
      dashes.setMatrixAt(index, dummy.matrix)
    })
    dashes.instanceMatrix.needsUpdate = true
    this.scene.add(dashes)

    const railGeo = this.track(new THREE.BoxGeometry(0.11, 1.22, 0.11))
    const railTopGeo = this.track(new THREE.BoxGeometry(1, 0.1, 0.1))
    const fencePosts: Array<[number, number, boolean]> = []
    for (let x = -42; x <= 42; x += 3.4) {
      if (Math.abs(x) < 7) continue
      fencePosts.push([x, -34.7, true])
      if (x < -9.1 || x > -6.2) fencePosts.push([x, 29.7, true])
    }
    for (let z = -31.3; z <= 26.3; z += 3.4) fencePosts.push([-42.7, z, false], [42.7, z, false])
    const posts = new THREE.InstancedMesh(railGeo, fence, fencePosts.length)
    fencePosts.forEach(([x, z], index) => {
      dummy.position.set(x, 0.78, z)
      dummy.rotation.set(0, 0, 0)
      dummy.updateMatrix()
      posts.setMatrixAt(index, dummy.matrix)
    })
    posts.instanceMatrix.needsUpdate = true
    this.scene.add(posts)
    for (const [x, z, horizontal] of fencePosts) {
      const rail = new THREE.Mesh(railTopGeo, fence)
      rail.position.set(x, 1.28, z)
      rail.scale.x = 3.2
      rail.rotation.y = horizontal ? 0 : Math.PI / 2
      this.scene.add(rail)
    }

    const parkingSurface = this.track(new THREE.MeshStandardMaterial({ color: '#5a6168', roughness: 0.96 }))
    const parkingMark = this.track(new THREE.MeshStandardMaterial({ color: '#f4f1ea', roughness: 0.5 }))
    for (const [x, z] of [[-31.5, 22.7], [31.5, 22.7]] as const) {
      this.addStaticBox(15.4, 0.16, 10.2, parkingSurface, x, 0.22, z)
      for (let slot = -5; slot <= 5; slot += 1) {
        this.addStaticBox(0.08, 0.03, 3.65, parkingMark, x + slot * 1.24, 0.32, z)
      }
      this.addStaticBox(14.5, 0.03, 0.08, parkingMark, x, 0.32, z - 3.58)
      this.addStaticBox(14.5, 0.03, 0.08, parkingMark, x, 0.32, z + 3.58)
    }

    const cityPodium = this.track(new THREE.MeshStandardMaterial({ color: '#c9c3b6', roughness: 0.72, metalness: 0.04 }))
    const cityRoof = this.track(new THREE.MeshStandardMaterial({ color: '#e7eef3', roughness: 0.48 }))
    const cityEquipment = this.track(new THREE.MeshStandardMaterial({ color: '#6a737a', roughness: 0.55, metalness: 0.28 }))
    const cityLight = this.track(new THREE.MeshStandardMaterial({ color: '#f3e2c4', emissive: '#e7c48a', emissiveIntensity: 0.35, roughness: 0.4 }))
    const cityBlocks: Array<[number, number, number, number, number]> = [
      [-68, -42, 12, 8, 18], [-56, -48, 10, 9, 25], [-43, -50, 13, 7, 14], [43, -50, 13, 8, 16], [57, -47, 11, 9, 23], [70, -41, 12, 7, 17],
      [-67, -17, 10, 8, 22], [-63, 8, 15, 9, 15], [-69, 29, 12, 8, 20], [67, -18, 13, 8, 19], [63, 8, 12, 7, 25], [69, 29, 15, 9, 16],
      [-48, 48, 16, 8, 21], [-27, 49, 12, 8, 15], [29, 49, 13, 8, 18], [50, 47, 16, 9, 23],
    ]
    cityBlocks.forEach(([x, z, width, depth, height], index) => {
      const floors = Math.max(9, Math.round(height / 0.58))
      const { map, emissiveMap } = createFacadeTextures(floors, Math.max(4, Math.round(width / 2)), 801 + index * 43)
      this.track(map)
      this.track(emissiveMap)
      const facade = this.track(
        new THREE.MeshStandardMaterial({
          map,
          emissiveMap,
          color: '#ffffff',
          emissive: '#ffd7a8',
          emissiveIntensity: 0.1,
          roughness: 0.68,
          metalness: 0.02,
        }),
      )
      const podium = new THREE.Mesh(this.track(new THREE.BoxGeometry(width + 1.2, 1.15, depth + 1.2)), cityPodium)
      podium.position.set(x, 0.58, z)
      podium.castShadow = true
      podium.receiveShadow = true
      this.scene.add(podium)

      const mainHeight = height - 1.15
      const main = new THREE.Mesh(this.track(new THREE.BoxGeometry(width * 0.84, mainHeight, depth * 0.8)), facade)
      main.position.set(x, 1.15 + mainHeight / 2, z)
      main.castShadow = true
      main.receiveShadow = true
      this.scene.add(main)

      const wingHeight = mainHeight * (0.5 + (index % 3) * 0.1)
      const wing = new THREE.Mesh(this.track(new THREE.BoxGeometry(width * 0.26, wingHeight, depth * 0.88)), facade)
      wing.position.set(x + (index % 2 === 0 ? width * 0.34 : -width * 0.34), 1.15 + wingHeight / 2, z + depth * 0.04)
      wing.castShadow = true
      this.scene.add(wing)

      const roof = new THREE.Mesh(this.track(new THREE.BoxGeometry(width * 0.68, 0.2, depth * 0.62)), cityRoof)
      roof.position.set(x, height + 0.1, z)
      this.scene.add(roof)
      const equipment = new THREE.Mesh(this.track(new THREE.BoxGeometry(width * 0.22, 0.48, depth * 0.2)), cityEquipment)
      equipment.position.set(x - width * 0.12, height + 0.43, z)
      this.scene.add(equipment)

      for (const side of [-1, 1]) {
        const cornerLight = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.12, mainHeight * 0.9, 0.12)), cityLight)
        cornerLight.position.set(x + side * width * 0.42, 1.15 + mainHeight / 2, z + depth * 0.41)
        this.scene.add(cornerLight)
      }
    })
  }

  private buildEntrance() {
    const stone = this.track(new THREE.MeshStandardMaterial({ color: '#ddd6cb', roughness: 0.58, metalness: 0.06 }))
    const stoneDark = this.track(new THREE.MeshStandardMaterial({ color: '#b7aea2', roughness: 0.72 }))
    const trim = this.track(new THREE.MeshStandardMaterial({ color: '#f7f3ec', roughness: 0.42 }))
    const metal = this.track(new THREE.MeshStandardMaterial({ color: '#8e98a2', roughness: 0.3, metalness: 0.74 }))
    const roof = this.track(new THREE.MeshStandardMaterial({ color: '#4c565f', roughness: 0.42, metalness: 0.38 }))
    const glass = this.track(
      new THREE.MeshStandardMaterial({
        color: '#e7f4f8',
        roughness: 0.05,
        metalness: 0.52,
        transparent: true,
        opacity: 0.62,
        emissive: '#f3d7a6',
        emissiveIntensity: 0.16,
      }),
    )
    const lamp = this.track(
      new THREE.MeshStandardMaterial({ color: '#fff6dc', emissive: '#ffd98a', emissiveIntensity: 0.85, roughness: 0.3 }),
    )
    const signMap = this.track(createGateSignTexture())
    const sign = this.track(new THREE.MeshStandardMaterial({ map: signMap, roughness: 0.42, metalness: 0.12 }))
    const z = 29.75

    const addPier = (x: number) => {
      this.markGate(this.raise(this.addStaticBox(1.62, 0.46, 1.78, stoneDark, x, 0.46, z)))
      this.markGate(this.raise(this.addStaticBox(1.18, 3.42, 1.28, stone, x, 2.4, z)))
      this.markGate(this.raise(this.addStaticBox(1.52, 0.26, 1.58, trim, x, 4.24, z)))
      this.addStaticBox(0.1, 2.2, 0.06, metal, x, 2.45, z + 0.68)
      this.addStaticBox(0.32, 0.46, 0.12, lamp, x, 3.15, z + 0.74)
    }
    addPier(-5.25)
    addPier(5.25)

    this.markGate(this.raise(this.addStaticBox(12.4, 0.58, 1.72, stone, 0, 4.66, z)))
    this.markGate(this.raise(this.addStaticBox(12.9, 0.18, 2.15, roof, 0, 5.04, z)))
    this.markGate(this.raise(this.addStaticBox(6.6, 0.78, 0.08, sign, 0, 4.48, z + 0.92)))
    for (const x of [-2.4, 2.4]) this.addStaticBox(0.72, 0.08, 0.42, lamp, x, 4.32, z)

    for (const side of [-1, 1]) {
      this.raise(this.addStaticBox(0.28, 0.28, 0.28, metal, side * 4.2, 1.05, z + 0.2))
      this.raise(this.addStaticBox(0.1, 2.45, 0.08, metal, side * 4.2, 2.4, z + 0.2))
    }

    const boothX = -7.45
    this.markGate(this.raise(this.addStaticBox(2.85, 0.32, 2.45, stoneDark, boothX, 0.38, z)))
    this.markGate(this.raise(this.addStaticBox(2.55, 2.25, 2.1, stone, boothX, 1.66, z)))
    this.markGate(this.raise(this.addStaticBox(3.05, 0.16, 2.7, roof, boothX, 2.87, z)))
    this.addStaticBox(1.2, 0.82, 0.05, glass, boothX - 0.15, 1.72, z + 1.08)
    this.addStaticBox(0.62, 1.55, 0.05, glass, boothX + 0.78, 1.12, z + 1.1)
    this.addStaticBox(0.05, 0.78, 0.95, glass, boothX + 1.3, 1.72, z)
    this.raise(this.addStaticBox(0.7, 2.35, 1.15, stone, -5.95, 1.5, z))

    this.raise(this.addStaticBox(0.12, 2.05, 0.12, metal, 6.2, 1.28, z))
    this.raise(this.addStaticBox(0.12, 2.05, 0.12, metal, 8.55, 1.28, z))
    this.addStaticBox(2.5, 0.1, 0.1, metal, 7.38, 2.28, z)
    this.addStaticBox(0.95, 1.85, 0.05, glass, 6.82, 1.2, z)
    this.addStaticBox(0.95, 1.85, 0.05, glass, 7.95, 1.2, z)
    this.buildNorthGate(stone, stoneDark, trim, metal, roof, lamp)
  }

  private buildNorthGate(
    stone: THREE.Material,
    stoneDark: THREE.Material,
    trim: THREE.Material,
    metal: THREE.Material,
    roof: THREE.Material,
    lamp: THREE.Material,
  ) {
    const z = -34.7
    const signMap = this.track(createGateSignTexture('北门'))
    const sign = this.track(new THREE.MeshStandardMaterial({ map: signMap, roughness: 0.42, metalness: 0.12 }))
    for (const x of [-4.35, 4.35]) {
      this.raise(this.addStaticBox(1.28, 0.36, 1.35, stoneDark, x, 0.38, z))
      this.raise(this.addStaticBox(0.92, 2.45, 0.98, stone, x, 1.78, z))
      this.raise(this.addStaticBox(1.2, 0.2, 1.22, trim, x, 3.1, z))
      this.addStaticBox(0.22, 0.32, 0.08, lamp, x, 2.15, z - 0.54)
    }
    this.raise(this.addStaticBox(10.1, 0.42, 1.28, stone, 0, 3.38, z))
    this.raise(this.addStaticBox(10.5, 0.14, 1.55, roof, 0, 3.66, z))
    this.raise(this.addStaticBox(3.4, 0.62, 0.08, sign, 0, 3.28, z - 0.72))
    for (const side of [-1, 1]) {
      this.raise(this.addStaticBox(0.22, 0.22, 0.22, metal, side * 3.45, 0.85, z - 0.15))
      this.raise(this.addStaticBox(0.08, 1.7, 0.07, metal, side * 3.45, 1.75, z - 0.15))
    }
    this.raise(this.addStaticBox(0.1, 1.7, 0.1, metal, 5.15, 1.1, z))
    this.raise(this.addStaticBox(0.1, 1.7, 0.1, metal, 6.55, 1.1, z))
    this.addStaticBox(1.55, 0.08, 0.08, metal, 5.85, 1.92, z)
  }

  private buildCommercialStreets() {
    const labels = ['便利店', '咖啡', '药店', '面包房', '花店', '超市', '书店', '餐饮']
    const awningColors = ['#c4564a', '#2f6d62', '#c4a15a', '#3e628c', '#8a4e3c', '#5d7048']
    const pavement = this.track(new THREE.MeshStandardMaterial({ color: '#d7d2c8', roughness: 0.9 }))
    const stoneMat = this.track(new THREE.MeshStandardMaterial({ color: '#b7aea4', roughness: 0.82 }))
    const trimMat = this.track(new THREE.MeshStandardMaterial({ color: '#f7f3ec', roughness: 0.5 }))
    const leafMat = this.track(new THREE.MeshStandardMaterial({ color: '#3f7d45', roughness: 0.8 }))
    const planterMat = this.track(new THREE.MeshStandardMaterial({ color: '#a3836a', roughness: 0.7 }))
    const railMat = this.track(new THREE.MeshStandardMaterial({ color: '#d7dde2', roughness: 0.35, metalness: 0.45 }))
    const fasciaMat = this.track(new THREE.MeshStandardMaterial({ color: '#2a3138', roughness: 0.5, metalness: 0.25 }))
    const wallColors = ['#f4efe6', '#e8d3c0', '#efe7da', '#e3ebe4']
    const wallMaterials = wallColors.map((color) => this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.74 })))
    const recessMat = this.track(new THREE.MeshStandardMaterial({ color: '#1a242c', roughness: 0.9 }))
    const glassMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#ffe7c4',
        roughness: 0.16,
        metalness: 0.28,
        emissive: '#ffb15a',
        emissiveIntensity: 0.55,
      }),
    )
    const doorGlass = this.track(
      new THREE.MeshStandardMaterial({
        color: '#e7f6fb',
        roughness: 0.04,
        metalness: 0.55,
        transparent: true,
        opacity: 0.62,
        emissive: '#d7eef6',
        emissiveIntensity: 0.18,
      }),
    )
    const doorFrame = this.track(new THREE.MeshStandardMaterial({ color: '#e8eef2', roughness: 0.28, metalness: 0.72 }))
    const awningMaterials = awningColors.map((color) => this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.48 })))
    const signMaterials = labels.map((label, index) => {
      const texture = this.track(createShopSignTexture(label, awningColors[index % awningColors.length]!))
      return this.track(
        new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.42,
          emissive: '#fff4e4',
          emissiveMap: texture,
          emissiveIntensity: 0.35,
        }),
      )
    })
    const bushGeo = this.track(new THREE.SphereGeometry(0.28, 8, 6))

    const addShop = (x: number, z: number, frontage: number, depth: number, rotation: number, index: number) => {
      const group = new THREE.Group()
      group.position.set(x, 0, z)
      group.rotation.y = rotation
      const wall = wallMaterials[index % wallMaterials.length]!
      const accent = awningMaterials[index % awningMaterials.length]!
      const stories = index % 5 === 0 ? 1 : index % 3 === 0 ? 3 : 2
      const shopH = 3.15
      const baseY = 0.22
      const front = depth / 2
      const addPart = (width: number, partHeight: number, partDepth: number, material: THREE.Material, px: number, py: number, pz: number, cast = false) => {
        const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(width, partHeight, partDepth)), material)
        mesh.position.set(px, py, pz)
        mesh.castShadow = cast
        mesh.receiveShadow = true
        group.add(mesh)
        return mesh
      }

      addPart(frontage + 0.4, 0.26, depth + 0.3, stoneMat, 0, 0.16, 0, true)
      addPart(frontage, shopH, depth, wall, 0, baseY + shopH / 2, 0, true)
      for (const side of [-1, 1]) {
        addPart(0.28, shopH + 0.08, 0.36, stoneMat, side * (frontage / 2 - 0.08), baseY + shopH / 2, front - 0.04, true)
      }

      const glassW = frontage * 0.78
      const glassH = 2.05
      const glassY = baseY + 1.28
      addPart(glassW + 0.2, glassH + 0.16, 0.22, recessMat, 0, glassY, front - 0.1)
      addPart(glassW, glassH, 0.05, glassMat, 0, glassY, front + 0.02)
      for (const mx of [-glassW * 0.28, 0, glassW * 0.28]) {
        addPart(0.05, glassH, 0.07, doorFrame, mx, glassY, front + 0.06)
      }

      const doorSide = index % 2 === 0 ? -1 : 1
      const doorX = doorSide * glassW * 0.28
      const doorW = 1.05
      const doorH = 2.15
      addPart(doorW, doorH - 0.06, 0.04, doorGlass, doorX, baseY + doorH / 2, front + 0.09)
      addPart(0.07, doorH, 0.1, doorFrame, doorX - doorW / 2, baseY + doorH / 2, front + 0.12, true)
      addPart(0.07, doorH, 0.1, doorFrame, doorX + doorW / 2, baseY + doorH / 2, front + 0.12, true)
      addPart(doorW + 0.14, 0.07, 0.1, doorFrame, doorX, baseY + doorH - 0.02, front + 0.12, true)
      addPart(0.05, 0.26, 0.08, doorFrame, doorX - doorSide * 0.32, baseY + 1.1, front + 0.18, true)
      addPart(doorW + 0.4, 0.06, 0.42, stoneMat, doorX, baseY + 0.06, front + 0.2, true)

      addPart(frontage + 0.12, 0.46, 0.18, fasciaMat, 0, baseY + shopH - 0.08, front + 0.06, true)
      addPart(Math.min(3.6, frontage * 0.62), 0.72, 0.08, signMaterials[index % signMaterials.length]!, 0, baseY + shopH - 0.02, front + 0.16, true)

      const awning = new THREE.Mesh(this.track(new THREE.BoxGeometry(frontage * 0.86, 0.1, 1.25)), accent)
      awning.position.set(0, baseY + shopH - 0.42, front + 0.48)
      awning.rotation.x = -0.16
      awning.castShadow = true
      group.add(awning)
      addPart(frontage * 0.86, 0.16, 0.06, accent, 0, baseY + shopH - 0.62, front + 1.02)

      for (const side of [-1, 1]) {
        addPart(0.42, 0.32, 0.42, planterMat, side * (frontage * 0.34), 0.34, front + 0.55, true)
        const bush = new THREE.Mesh(bushGeo, leafMat)
        bush.position.set(side * (frontage * 0.34), 0.68, front + 0.55)
        bush.castShadow = true
        group.add(bush)
      }

      let roofY = baseY + shopH
      let roofW = frontage
      let roofD = depth
      let roofZ = 0
      if (stories >= 2) {
        const upperH = 2.2
        const upperW = frontage * 0.92
        const upperD = depth * 0.8
        const upperZ = -depth * 0.06
        addPart(upperW, upperH, upperD, wall, 0, roofY + upperH / 2, upperZ, true)
        const upperFront = upperZ + upperD / 2
        for (const wx of [-upperW * 0.28, 0, upperW * 0.28]) {
          addPart(0.72, 1.15, 0.16, recessMat, wx, roofY + 1.15, upperFront - 0.04)
          addPart(0.56, 0.92, 0.05, glassMat, wx, roofY + 1.18, upperFront + 0.05)
          addPart(0.7, 0.06, 0.12, trimMat, wx, roofY + 0.62, upperFront + 0.08, true)
        }
        addPart(upperW * 0.9, 0.06, 0.55, railMat, 0, roofY + 0.55, upperFront + 0.22)
        roofY += upperH
        roofW = upperW
        roofD = upperD
        roofZ = upperZ
      }
      if (stories >= 3) {
        const thirdH = 1.85
        const thirdW = roofW * 0.86
        const thirdD = roofD * 0.86
        const thirdZ = roofZ - 0.12
        addPart(thirdW, thirdH, thirdD, wall, 0, roofY + thirdH / 2, thirdZ, true)
        const thirdFront = thirdZ + thirdD / 2
        for (const wx of [-thirdW * 0.24, thirdW * 0.24]) {
          addPart(0.58, 0.95, 0.12, recessMat, wx, roofY + 1.0, thirdFront - 0.02)
          addPart(0.44, 0.74, 0.04, glassMat, wx, roofY + 1.02, thirdFront + 0.05)
        }
        roofY += thirdH
        roofW = thirdW
        roofD = thirdD
        roofZ = thirdZ
      }
      addPart(roofW + 0.16, 0.12, roofD + 0.12, stoneMat, 0, roofY + 0.08, roofZ, true)
      addPart(roofW + 0.2, 0.28, 0.12, trimMat, 0, roofY + 0.26, roofZ + roofD / 2, true)
      this.scene.add(group)
    }

    ;[-24, -16.6, -9.2, -1.8, 5.6, 13].forEach((z, index) => {
      addShop(-37.4, z, 6.8, 5.4, -Math.PI / 2, index)
      addShop(37.4, z, 6.8, 5.4, Math.PI / 2, index + 3)
    })
    ;[-32, -24.2, -16.4, 16.4, 24.2, 32].forEach((x, index) => {
      addShop(x, -30.8, 7.2, 5, Math.PI, index + 1)
    })
    ;[-30.5, -22.4, 22.4, 30.5].forEach((x, index) => {
      addShop(x, 38.4, 7.2, 4.2, Math.PI, index + 4)
    })
    ;[60, 68, 76].forEach((z, index) => {
      addShop(-12.5, z, 7.1, 5.1, Math.PI / 2, index + 2)
      addShop(12.5, z, 7.1, 5.1, -Math.PI / 2, index + 5)
      addShop(-25.5, z, 7.1, 5.1, Math.PI / 2, index + 1)
      addShop(25.5, z, 7.1, 5.1, -Math.PI / 2, index + 4)
    })

    this.addStaticBox(1.5, 0.1, 40, pavement, -32.6, 0.1, -5.5)
    this.addStaticBox(1.5, 0.1, 40, pavement, 32.6, 0.1, -5.5)
    this.addStaticBox(22, 0.1, 1.35, pavement, -23, 0.1, -27.4)
    this.addStaticBox(22, 0.1, 1.35, pavement, 23, 0.1, -27.4)
  }

  private buildCommunityGarden() {
    this.addGrassPatch(6, 5.2, 19.2, 27.8)

    const granite = this.track(new THREE.MeshStandardMaterial({ color: '#6d757c', roughness: 0.72, metalness: 0.08 }))
    const marble = this.track(new THREE.MeshStandardMaterial({ color: '#f4efe6', roughness: 0.42, metalness: 0.04 }))
    const brass = this.track(new THREE.MeshStandardMaterial({ color: '#c6a15a', roughness: 0.32, metalness: 0.72 }))
    const basinFloor = this.track(new THREE.MeshStandardMaterial({ color: '#12343c', roughness: 0.55, metalness: 0.08 }))
    const water = this.track(
      new THREE.MeshStandardMaterial({
        color: '#1c7484',
        roughness: 0.08,
        metalness: 0.28,
        transparent: true,
        opacity: 0.78,
        emissive: '#0c4450',
        emissiveIntensity: 0.35,
      }),
    )
    const jetMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#eef9ff',
        roughness: 0.12,
        transparent: true,
        opacity: 0.5,
        emissive: '#d5f3ff',
        emissiveIntensity: 0.45,
      }),
    )
    const wood = this.track(new THREE.MeshStandardMaterial({ color: '#6d5340', roughness: 0.72 }))

    const fountain = new THREE.Group()
    fountain.position.set(11.2, 0, 27.7)
    fountain.scale.set(0.92, 1.28, 0.92)

    const addStone = (mesh: THREE.Mesh, y: number) => {
      mesh.position.y = y
      mesh.castShadow = true
      mesh.receiveShadow = true
      fountain.add(mesh)
      return mesh
    }

    addStone(new THREE.Mesh(this.track(new THREE.CylinderGeometry(3.55, 3.7, 0.2, 40)), granite), 0.24)
    addStone(new THREE.Mesh(this.track(new THREE.CylinderGeometry(3.15, 3.28, 0.16, 36)), marble), 0.4)
    addStone(new THREE.Mesh(this.track(new THREE.CylinderGeometry(2.72, 2.9, 0.16, 36)), marble), 0.56)

    const basin = new THREE.Mesh(
      this.track(
        new THREE.LatheGeometry(
          [
            new THREE.Vector2(2.02, 0.7),
            new THREE.Vector2(2.28, 0.78),
            new THREE.Vector2(2.58, 1.08),
            new THREE.Vector2(2.78, 1.32),
            new THREE.Vector2(2.46, 1.46),
            new THREE.Vector2(2.18, 1.24),
            new THREE.Vector2(2.08, 0.9),
          ],
          40,
        ),
      ),
      marble,
    )
    basin.castShadow = true
    basin.receiveShadow = true
    fountain.add(basin)

    const floor = new THREE.Mesh(this.track(new THREE.CylinderGeometry(2.05, 2.05, 0.08, 32)), basinFloor)
    floor.position.y = 0.8
    fountain.add(floor)
    const surface = new THREE.Mesh(this.track(new THREE.CylinderGeometry(2.16, 2.16, 0.06, 32)), water)
    surface.position.y = 1.08
    fountain.add(surface)

    const rim = new THREE.Mesh(this.track(new THREE.TorusGeometry(2.52, 0.07, 10, 40)), brass)
    rim.rotation.x = Math.PI / 2
    rim.position.y = 1.4
    rim.castShadow = true
    fountain.add(rim)

    const pilasterGeo = this.track(new THREE.BoxGeometry(0.16, 0.62, 0.28))
    const studGeo = this.track(new THREE.SphereGeometry(0.09, 10, 8))
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2
      const pilaster = new THREE.Mesh(pilasterGeo, granite)
      pilaster.position.set(Math.cos(angle) * 2.48, 1.02, Math.sin(angle) * 2.48)
      pilaster.rotation.y = -angle
      pilaster.castShadow = true
      fountain.add(pilaster)
      const stud = new THREE.Mesh(studGeo, brass)
      stud.position.set(Math.cos(angle) * 2.52, 1.52, Math.sin(angle) * 2.52)
      fountain.add(stud)
    }

    addStone(new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.28, 0.42, 1.15, 16)), marble), 1.85)
    const lowerBowl = new THREE.Mesh(
      this.track(
        new THREE.LatheGeometry(
          [
            new THREE.Vector2(0.2, 0),
            new THREE.Vector2(0.62, 0.08),
            new THREE.Vector2(1.2, 0.3),
            new THREE.Vector2(1.42, 0.46),
            new THREE.Vector2(1.18, 0.54),
            new THREE.Vector2(0.22, 0.12),
          ],
          28,
        ),
      ),
      marble,
    )
    lowerBowl.position.y = 2.28
    lowerBowl.castShadow = true
    fountain.add(lowerBowl)
    const lowerWater = new THREE.Mesh(this.track(new THREE.CylinderGeometry(1.12, 1.12, 0.05, 24)), water)
    lowerWater.position.y = 2.68
    fountain.add(lowerWater)
    const lowerRim = new THREE.Mesh(this.track(new THREE.TorusGeometry(1.28, 0.045, 8, 28)), brass)
    lowerRim.rotation.x = Math.PI / 2
    lowerRim.position.y = 2.74
    fountain.add(lowerRim)

    addStone(new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.16, 0.24, 0.72, 12)), marble), 3.05)
    const upperBowl = new THREE.Mesh(
      this.track(
        new THREE.LatheGeometry(
          [
            new THREE.Vector2(0.12, 0),
            new THREE.Vector2(0.38, 0.06),
            new THREE.Vector2(0.72, 0.2),
            new THREE.Vector2(0.86, 0.32),
            new THREE.Vector2(0.68, 0.38),
            new THREE.Vector2(0.14, 0.08),
          ],
          24,
        ),
      ),
      marble,
    )
    upperBowl.position.y = 3.32
    upperBowl.castShadow = true
    fountain.add(upperBowl)
    const upperWater = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.62, 0.62, 0.04, 20)), water)
    upperWater.position.y = 3.6
    fountain.add(upperWater)
    addStone(new THREE.Mesh(this.track(new THREE.SphereGeometry(0.16, 16, 12)), brass), 3.92)

    const addJet = (x: number, y: number, z: number, height: number, radius = 0.045) => {
      const geometry = this.track(new THREE.CylinderGeometry(radius * 0.7, radius, height, 8))
      geometry.translate(0, height / 2, 0)
      const jet = new THREE.Mesh(geometry, jetMat)
      jet.position.set(x, y, z)
      const spray = new THREE.Mesh(this.track(new THREE.SphereGeometry(radius * 2.4, 8, 8)), jetMat)
      spray.position.y = height
      jet.add(spray)
      fountain.add(jet)
      this.waterJets.push(jet)
    }
    addJet(0, 4.02, 0, 1.55, 0.06)
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2 + 0.2
      addJet(Math.cos(angle) * 2.15, 1.16, Math.sin(angle) * 2.15, 0.95, 0.04)
    }
    for (let index = 0; index < 6; index += 1) {
      const angle = (index / 6) * Math.PI * 2
      addJet(Math.cos(angle) * 1.05, 2.7, Math.sin(angle) * 1.05, 0.62, 0.035)
    }

    const warm = new THREE.PointLight('#ffe1b0', 0.7, 16, 2)
    warm.position.set(0, 3.4, 0)
    const cool = new THREE.PointLight('#b7e4ee', 0.35, 12, 2)
    cool.position.set(0, 1.3, 0)
    fountain.add(warm, cool)
    this.scene.add(fountain)

    const legGeo = this.track(new THREE.BoxGeometry(0.12, 0.42, 0.5))
    const seatGeo = this.track(new THREE.BoxGeometry(2.2, 0.1, 0.48))
    const backGeo = this.track(new THREE.BoxGeometry(2.2, 0.42, 0.08))
    for (const [x, z, rotation] of [
      [-3.15, 0.2, Math.PI / 2],
      [3.15, 0.2, Math.PI / 2],
      [0, 3.05, 0],
    ] as const) {
      const bench = new THREE.Group()
      const seat = new THREE.Mesh(seatGeo, wood)
      seat.position.y = 0.62
      seat.castShadow = true
      const back = new THREE.Mesh(backGeo, wood)
      back.position.set(0, 0.86, -0.2)
      for (const side of [-0.9, 0.9]) {
        const leg = new THREE.Mesh(legGeo, granite)
        leg.position.set(side, 0.36, 0)
        bench.add(leg)
      }
      bench.add(seat, back)
      bench.position.set(x, 0.34, z)
      bench.rotation.y = rotation
      fountain.add(bench)
    }
  }

  private addGrassPatch(width: number, depth: number, x: number, z: number) {
    const soil = this.track(new THREE.MeshStandardMaterial({ color: '#6a5342', roughness: 1 }))
    const turf = this.track(
      new THREE.MeshStandardMaterial({
        map: this.track(createGrassTexture()),
        color: '#8d9a86',
        roughness: 1,
      }),
    )
    this.addStaticBox(width + 0.55, 0.22, depth + 0.55, soil, x, 0.16, z)
    const patch = new THREE.Mesh(this.track(new THREE.BoxGeometry(width, 0.34, depth)), turf)
    patch.position.set(x, 0.38, z)
    patch.castShadow = true
    patch.receiveShadow = true
    this.scene.add(patch)

    const grassBlade = this.track(new THREE.ConeGeometry(0.045, 0.42, 4))
    const grassMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: '#6d7c66',
        roughness: 0.92,
        vertexColors: true,
      }),
    )
    const bladeCount = Math.min(320, Math.max(80, Math.round(width * depth * 7)))
    const blades = new THREE.InstancedMesh(grassBlade, grassMaterial, bladeCount)
    const random = mulberry32(Math.round((x + 90) * 137 + (z + 90) * 61))
    const dummy = new THREE.Object3D()
    const color = new THREE.Color()
    for (let index = 0; index < bladeCount; index += 1) {
      const scale = 0.45 + random() * 0.7
      dummy.position.set(x + (random() - 0.5) * (width - 0.3), 0.52 + scale * 0.14, z + (random() - 0.5) * (depth - 0.3))
      dummy.rotation.set((random() - 0.5) * 0.35, random() * Math.PI, (random() - 0.5) * 0.35)
      dummy.scale.set(0.7 + random() * 0.6, scale, 0.7 + random() * 0.6)
      dummy.updateMatrix()
      blades.setMatrixAt(index, dummy.matrix)
      color.set(random() > 0.66 ? '#6eaa4b' : random() > 0.33 ? '#3f8a38' : '#2f6b2e')
      blades.setColorAt(index, color)
    }
    blades.instanceMatrix.needsUpdate = true
    if (blades.instanceColor) blades.instanceColor.needsUpdate = true
    blades.castShadow = false
    this.scene.add(blades)
  }

  private buildNature(buildings: Building[]) {
    const buildingRects: Rect[] = buildings.map((item) => ({
      x: item.x,
      z: item.z,
      w: item.width + 3.2,
      d: item.depth + 3.2,
    }))
    const blocked = [...buildingRects, ...ROADS]
    const random = mulberry32(11)
    const spots: Array<[number, number]> = []
    const pushLine = (x0: number, z0: number, x1: number, z1: number, step: number) => {
      const length = Math.hypot(x1 - x0, z1 - z0)
      const count = Math.max(1, Math.round(length / step))
      for (let index = 0; index <= count; index += 1) {
        const t = index / count
        const px = x0 + (x1 - x0) * t
        const pz = z0 + (z1 - z0) * t
        const occupied = blocked.some(
          (rect) => Math.abs(px - rect.x) < rect.w / 2 + 0.8 && Math.abs(pz - rect.z) < rect.d / 2 + 0.8,
        )
        if (!occupied) spots.push([px, pz])
      }
    }
    pushLine(-5.4, -32, -5.4, 15, 2.8)
    pushLine(5.4, -32, 5.4, 15, 2.8)
    pushLine(-34, -17.2, 34, -17.2, 3)
    pushLine(-34, -10.8, 34, -10.8, 3)
    pushLine(-34, -0.8, 34, -0.8, 3)
    pushLine(-34, 4.8, 34, 4.8, 3)
    pushLine(-34, -28, 34, -28, 3.2)
    pushLine(-34, 15, -8, 15, 3)
    pushLine(8, 15, 34, 15, 3)

    const trunkGeo = this.track(new THREE.CylinderGeometry(0.09, 0.14, 0.95, 6))
    const crownLowGeo = this.track(new THREE.SphereGeometry(0.58, 8, 6))
    const crownHighGeo = this.track(new THREE.SphereGeometry(0.38, 8, 6))
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ color: '#6d5138', roughness: 0.9 }))
    const crownMat = this.track(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.78 }))
    const dummy = new THREE.Object3D()
    if (spots.length > 0) {
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length)
      const crownsLow = new THREE.InstancedMesh(crownLowGeo, crownMat, spots.length)
      const crownsHigh = new THREE.InstancedMesh(crownHighGeo, crownMat, spots.length)
      const color = new THREE.Color()
      spots.forEach(([x, z], index) => {
        const scale = 0.85 + random() * 0.4
        dummy.position.set(x, 0.48 * scale, z)
        dummy.scale.set(scale, scale, scale)
        dummy.rotation.set(0, random() * Math.PI, 0)
        dummy.updateMatrix()
        trunks.setMatrixAt(index, dummy.matrix)
        dummy.position.set(x, 1.05 * scale, z)
        dummy.scale.set(scale * 1.15, scale * 0.72, scale * 1.15)
        dummy.updateMatrix()
        crownsLow.setMatrixAt(index, dummy.matrix)
        dummy.position.set(x + (random() - 0.5) * 0.12, 1.42 * scale, z + (random() - 0.5) * 0.12)
        dummy.scale.set(scale * 0.78, scale * 0.62, scale * 0.78)
        dummy.updateMatrix()
        crownsHigh.setMatrixAt(index, dummy.matrix)
        color.set(random() > 0.5 ? '#2f6b34' : '#4a8f42')
        crownsLow.setColorAt(index, color)
        color.offsetHSL(0.02, 0.04, 0.06)
        crownsHigh.setColorAt(index, color)
      })
      trunks.instanceMatrix.needsUpdate = true
      crownsLow.instanceMatrix.needsUpdate = true
      crownsHigh.instanceMatrix.needsUpdate = true
      if (crownsLow.instanceColor) crownsLow.instanceColor.needsUpdate = true
      if (crownsHigh.instanceColor) crownsHigh.instanceColor.needsUpdate = true
      this.scene.add(trunks, crownsLow, crownsHigh)
    }

    const poleGeo = this.track(new THREE.CylinderGeometry(0.045, 0.06, 2.5, 6))
    const headGeo = this.track(new THREE.SphereGeometry(0.16, 10, 8))
    const poleMat = this.track(new THREE.MeshStandardMaterial({ color: '#d5dee8', roughness: 0.4, metalness: 0.4 }))
    const headMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#fff4d2',
        emissive: '#ffd48a',
        emissiveIntensity: 3.2,
        roughness: 0.25,
      }),
    )
    const lamps: Array<[number, number]> = []
    for (let z = -30; z <= 14; z += 8) lamps.push([-4.2, z], [4.2, z])
    for (let z = 46; z <= 74; z += 14) lamps.push([-4.4, z], [4.4, z])
    for (let x = -28; x <= 28; x += 10) {
      lamps.push([x, -14], [x, 2])
    }
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lamps.length)
    const heads = new THREE.InstancedMesh(headGeo, headMat, lamps.length)
    const glowTexture = this.track(createGlowTexture())
    const glowMat = this.track(
      new THREE.SpriteMaterial({
        map: glowTexture,
        color: '#ffd9a2',
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    )
    lamps.forEach(([x, z], index) => {
      dummy.position.set(x, 1.35, z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      poles.setMatrixAt(index, dummy.matrix)
      dummy.position.set(x, 2.6, z)
      dummy.updateMatrix()
      heads.setMatrixAt(index, dummy.matrix)
      const sprite = new THREE.Sprite(glowMat)
      sprite.position.set(x, 2.6, z)
      sprite.scale.set(1.5, 1.5, 1)
      this.scene.add(sprite)
      if (index % 3 === 0) {
        const light = new THREE.PointLight('#ffd2a0', 0.85, 14, 2)
        light.position.set(x, 2.5, z)
        this.scene.add(light)
      }
    })
    poles.instanceMatrix.needsUpdate = true
    heads.instanceMatrix.needsUpdate = true
    this.scene.add(poles, heads)
  }

  private buildTraffic() {
    const paints = ['#f4f7fb', '#d5dce6', '#8ea0b5', '#2d6fe8', '#c9d0d8', '#3e4752'].map((color) =>
      this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.55 })),
    )
    const glass = this.track(
      new THREE.MeshStandardMaterial({
        color: '#163044',
        roughness: 0.08,
        metalness: 0.62,
        transparent: true,
        opacity: 0.78,
        emissive: '#0e2434',
        emissiveIntensity: 0.25,
      }),
    )
    const tireMat = this.track(new THREE.MeshStandardMaterial({ color: '#1a1e24', roughness: 0.72 }))
    const rimMat = this.track(new THREE.MeshStandardMaterial({ color: '#d5dde6', roughness: 0.32, metalness: 0.78 }))
    const lampMat = this.track(
      new THREE.MeshStandardMaterial({ color: '#fff6d8', emissive: '#fff1c2', emissiveIntensity: 2.4, roughness: 0.25 }),
    )
    const tailMat = this.track(
      new THREE.MeshStandardMaterial({ color: '#ff5a4a', emissive: '#ff3b32', emissiveIntensity: 0.7, roughness: 0.35 }),
    )
    const trimMat = this.track(new THREE.MeshStandardMaterial({ color: '#23282e', roughness: 0.45, metalness: 0.4 }))
    const shellGeo = this.track(createCarShellGeometry())
    const tireGeo = this.track(new THREE.CylinderGeometry(0.3, 0.3, 0.22, 16))
    tireGeo.rotateZ(Math.PI / 2)
    const rimGeo = this.track(new THREE.CylinderGeometry(0.16, 0.16, 0.24, 12))
    rimGeo.rotateZ(Math.PI / 2)
    const roofGeo = this.track(new THREE.BoxGeometry(0.96, 0.05, 1.12))
    const windshieldGeo = this.track(new THREE.BoxGeometry(1.0, 0.5, 0.04))
    const rearGlassGeo = this.track(new THREE.BoxGeometry(0.96, 0.36, 0.04))
    const sideGlassGeo = this.track(new THREE.BoxGeometry(0.04, 0.32, 0.95))
    const lampGeo = this.track(new THREE.BoxGeometry(0.26, 0.1, 0.06))
    const tailGeo = this.track(new THREE.BoxGeometry(0.24, 0.08, 0.05))
    const mirrorGeo = this.track(new THREE.BoxGeometry(0.14, 0.08, 0.18))

    const createCar = (paint: THREE.Material) => {
      const group = new THREE.Group()
      const shell = new THREE.Mesh(shellGeo, paint)
      shell.castShadow = true
      shell.receiveShadow = true
      group.add(shell)

      const windshield = new THREE.Mesh(windshieldGeo, glass)
      windshield.position.set(0, 0.92, -0.78)
      windshield.rotation.x = 0.55
      const rearGlass = new THREE.Mesh(rearGlassGeo, glass)
      rearGlass.position.set(0, 0.96, 0.72)
      rearGlass.rotation.x = -0.5
      const roof = new THREE.Mesh(roofGeo, glass)
      roof.position.set(0, 1.16, 0.05)
      group.add(windshield, rearGlass, roof)
      for (const x of [-0.64, 0.64]) {
        const side = new THREE.Mesh(sideGlassGeo, glass)
        side.position.set(x, 0.92, 0.02)
        group.add(side)
      }

      const grille = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.62, 0.14, 0.05)), trimMat)
      grille.position.set(0, 0.4, -1.64)
      group.add(grille)
      for (const x of [-0.38, 0.38]) {
        const lamp = new THREE.Mesh(lampGeo, lampMat)
        lamp.position.set(x, 0.55, -1.66)
        group.add(lamp)
        const tail = new THREE.Mesh(tailGeo, tailMat)
        tail.position.set(x, 0.58, 1.6)
        group.add(tail)
      }
      for (const x of [-0.78, 0.78]) {
        const mirror = new THREE.Mesh(mirrorGeo, paint)
        mirror.position.set(x, 0.84, -0.42)
        group.add(mirror)
      }

      const wheels: THREE.Object3D[] = []
      for (const [x, z] of [
        [-0.86, -1.02],
        [0.86, -1.02],
        [-0.86, 0.98],
        [0.86, 0.98],
      ] as const) {
        const wheel = new THREE.Group()
        wheel.add(new THREE.Mesh(tireGeo, tireMat), new THREE.Mesh(rimGeo, rimMat))
        wheel.position.set(x, 0.3, z)
        group.add(wheel)
        wheels.push(wheel)
      }
      group.userData.wheels = wheels
      return group
    }

    const lanes = [-1.55, 1.55]
    for (let index = 0; index < 6; index += 1) {
      const direction = index % 2 === 0 ? -1 : 1
      const car = createCar(paints[index % paints.length]!)
      car.rotation.y = direction > 0 ? Math.PI : 0
      const z = -30 + index * 14
      const lane = lanes[index % 2]!
      car.position.set(lane, 0.28, z)
      this.scene.add(car)
      this.cars.push({
        group: car,
        z,
        x: lane,
        speed: 6 + (index % 3) * 1.6,
        direction,
        turning: false,
        turnT: 0,
        fromX: lane,
        toX: lane,
        wheels: car.userData.wheels as THREE.Object3D[],
      })
    }

    for (let row = 0; row < 4; row += 1) {
      const parked = createCar(paints[row % paints.length]!)
      parked.rotation.y = Math.PI / 2
      parked.position.set(row < 2 ? -14 : 14, 0.28, 18.2 + (row % 2) * 2.4)
      this.scene.add(parked)
    }
  }

  private buildPeople() {
    const bodyGeo = this.track(new THREE.BoxGeometry(0.36, 0.78, 0.22))
    const headGeo = this.track(new THREE.SphereGeometry(0.13, 8, 6))
    const coats = ['#2c3c52', '#8a4e3c', '#d5d0c6', '#3e628c', '#5d7048'].map((color) =>
      this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.7 })),
    )
    const skin = this.track(new THREE.MeshStandardMaterial({ color: '#e2c2a4', roughness: 0.65 }))
    const routes = [
      { x: -5.5, minZ: -28, maxZ: 22, count: 3 },
      { x: 5.5, minZ: -26, maxZ: 22, count: 3 },
      { x: -8.5, minZ: 50, maxZ: 74, count: 2 },
      { x: 8.5, minZ: 52, maxZ: 74, count: 2 },
    ]
    let index = 0
    for (const route of routes) {
      for (let step = 0; step < route.count; step += 1) {
        const direction = index % 2 === 0 ? 1 : -1
        const group = new THREE.Group()
        const body = new THREE.Mesh(bodyGeo, coats[index % coats.length]!)
        body.position.y = 0.72
        body.castShadow = true
        const head = new THREE.Mesh(headGeo, skin)
        head.position.y = 1.22
        group.add(body, head)
        const span = route.maxZ - route.minZ
        const z = route.minZ + ((step + 0.35) / route.count) * span
        group.position.set(route.x, 0, z)
        group.rotation.y = direction > 0 ? Math.PI : 0
        this.scene.add(group)
        this.walkers.push({
          group,
          z,
          speed: 1.15 + (index % 3) * 0.28,
          direction,
          minZ: route.minZ,
          maxZ: route.maxZ,
          phase: index * 1.3,
        })
        index += 1
      }
    }
  }

  private rebuildBuildings(buildings: Building[], patternSalt: number) {
    this.clearBuildings()
    const podiumMat = new THREE.MeshStandardMaterial({ color: '#d8d0c3', roughness: 0.78, metalness: 0.02 })
    const padMat = new THREE.MeshStandardMaterial({ color: '#c4bbae', roughness: 0.9 })
    const roofMat = new THREE.MeshStandardMaterial({ color: '#c9c2b4', roughness: 0.72, metalness: 0.04 })
    const trimMat = new THREE.MeshStandardMaterial({ color: '#b7aea2', roughness: 0.7 })
    const acMat = new THREE.MeshStandardMaterial({ color: '#b7c0c6', roughness: 0.55, metalness: 0.25 })
    const lobbyMat = new THREE.MeshStandardMaterial({
      color: '#d5e4ea',
      roughness: 0.08,
      metalness: 0.4,
      transparent: true,
      opacity: 0.72,
      emissive: '#f0d2a4',
      emissiveIntensity: 0.12,
    })
    const antennaMat = new THREE.MeshStandardMaterial({ color: '#8d949a', metalness: 0.55, roughness: 0.35 })
    const balconyMat = new THREE.MeshStandardMaterial({ color: '#f3efe6', roughness: 0.74 })
    const railMat = new THREE.MeshStandardMaterial({ color: '#8b9399', roughness: 0.38, metalness: 0.55 })
    const plantMat = new THREE.MeshStandardMaterial({ color: '#c3bbb0', roughness: 0.7 })
    const warningMat = new THREE.MeshStandardMaterial({
      color: '#ff4d4f',
      emissive: '#ff4d4f',
      emissiveIntensity: 2.4,
    })
    this.keep(podiumMat)
    this.keep(padMat)
    this.keep(roofMat)
    this.keep(trimMat)
    this.keep(acMat)
    this.keep(lobbyMat)
    this.keep(antennaMat)
    this.keep(warningMat)
    this.keep(balconyMat)
    this.keep(railMat)
    this.keep(plantMat)

    const acGeo = this.keep(new THREE.BoxGeometry(1.05, 0.36, 0.7))
    const antennaGeo = this.keep(new THREE.CylinderGeometry(0.035, 0.045, 1.2, 6))
    const beaconGeo = this.keep(new THREE.SphereGeometry(0.12, 8, 8))
    const cornerGeo = this.keep(new THREE.BoxGeometry(0.28, 1, 0.28))
    const ledgeFrontGeo = this.keep(new THREE.BoxGeometry(1, 0.08, 0.16))
    const ledgeSideGeo = this.keep(new THREE.BoxGeometry(0.16, 0.08, 1))
    const slabGeo = this.keep(new THREE.BoxGeometry(1.15, 0.07, 0.78))
    const railGeo = this.keep(new THREE.BoxGeometry(1.15, 0.24, 0.04))
    const plantGeo = this.keep(new THREE.BoxGeometry(2.3, 0.72, 1.7))
    const tankGeo = this.keep(new THREE.BoxGeometry(1.05, 0.48, 0.75))

    for (const item of buildings) {
      const group = new THREE.Group()
      group.position.set(item.x, 0, item.z)
      const towerH = item.floors * FLOOR_HEIGHT
      const columns = 7
      const seed = (hashString(item.id) ^ patternSalt ^ item.floors * 17) >>> 0
      const { map, emissiveMap } = createFacadeTextures(item.floors, columns, seed)
      this.keep(map)
      this.keep(emissiveMap)
      const body = this.keep(
        new THREE.MeshStandardMaterial({
          map,
          emissiveMap,
          emissive: new THREE.Color('#ffd7a8'),
          emissiveIntensity: 0.18,
          roughness: 0.74,
          metalness: 0.02,
          color: '#ffffff',
        }),
      )
      const roof = roofMat
      const towerGeo = this.keep(new THREE.BoxGeometry(item.width, towerH, item.depth))
      const materials = [body, body, roof, podiumMat, body, body]
      const tower = new THREE.Mesh(towerGeo, materials)
      tower.position.y = BASE_Y + PODIUM_HEIGHT + towerH / 2
      tower.castShadow = true
      tower.receiveShadow = true
      tower.userData.buildingId = item.id

      const podium = new THREE.Mesh(
        this.keep(new THREE.BoxGeometry(item.width + 1.8, PODIUM_HEIGHT, item.depth + 1.8)),
        podiumMat,
      )
      podium.position.y = BASE_Y + PODIUM_HEIGHT / 2
      podium.castShadow = true
      podium.receiveShadow = true
      podium.userData.buildingId = item.id

      const pad = new THREE.Mesh(this.keep(new THREE.BoxGeometry(item.width + 3.4, 0.1, item.depth + 3.4)), padMat)
      pad.position.y = 0.1
      pad.receiveShadow = true
      pad.userData.buildingId = item.id

      const lobby = new THREE.Mesh(
        this.keep(new THREE.BoxGeometry(item.width * 0.46, PODIUM_HEIGHT * 0.62, 0.08)),
        lobbyMat,
      )
      lobby.position.set(0, BASE_Y + PODIUM_HEIGHT * 0.48, item.depth / 2 + 0.94)
      lobby.userData.buildingId = item.id
      const canopy = new THREE.Mesh(this.keep(new THREE.BoxGeometry(item.width * 0.52, 0.08, 0.7)), trimMat)
      canopy.position.set(0, BASE_Y + PODIUM_HEIGHT * 0.82, item.depth / 2 + 1.15)
      canopy.castShadow = true
      canopy.userData.buildingId = item.id

      const parapet = new THREE.Mesh(
        this.keep(new THREE.BoxGeometry(item.width + 0.28, 0.26, item.depth + 0.28)),
        roofMat,
      )
      parapet.position.y = BASE_Y + PODIUM_HEIGHT + towerH + 0.13
      parapet.userData.buildingId = item.id

      group.add(pad, podium, lobby, canopy, tower, parapet)

      const halfW = item.width / 2
      const halfD = item.depth / 2
      const towerCenterY = BASE_Y + PODIUM_HEIGHT + towerH / 2
      for (const [x, z] of [
        [halfW, halfD],
        [-halfW, halfD],
        [halfW, -halfD],
        [-halfW, -halfD],
      ] as const) {
        const corner = new THREE.Mesh(cornerGeo, trimMat)
        corner.scale.y = towerH
        corner.position.set(x, towerCenterY, z)
        corner.userData.buildingId = item.id
        group.add(corner)
      }

      const bays = facadeBayUs(columns)
      const faces = [
        { x: (bay: number) => -halfW + bay * item.width, z: () => halfD + 0.36, ox: 0, oz: 0.34 },
        { x: (bay: number) => halfW - bay * item.width, z: () => -halfD - 0.36, ox: 0, oz: -0.34 },
        { x: () => halfW + 0.36, z: (bay: number) => halfD - bay * item.depth, ox: 0.34, oz: 0 },
        { x: () => -halfW - 0.36, z: (bay: number) => -halfD + bay * item.depth, ox: -0.34, oz: 0 },
      ]
      const balconyCount = Math.max(0, item.floors - 2) * bays.length * faces.length
      if (balconyCount > 0) {
        const slabs = new THREE.InstancedMesh(slabGeo, balconyMat, balconyCount)
        const rails = new THREE.InstancedMesh(railGeo, railMat, balconyCount)
        const dummy = new THREE.Object3D()
        let slot = 0
        for (let floor = 1; floor < item.floors - 1; floor += 1) {
          const y = BASE_Y + PODIUM_HEIGHT + (floor + 0.7) * FLOOR_HEIGHT
          for (const bay of bays) {
            for (const face of faces) {
              const along = face.oz !== 0
              dummy.position.set(face.x(bay), y, face.z(bay))
              dummy.rotation.set(0, along ? 0 : Math.PI / 2, 0)
              dummy.updateMatrix()
              slabs.setMatrixAt(slot, dummy.matrix)
              dummy.position.set(face.x(bay) + face.ox, y + 0.16, face.z(bay) + face.oz)
              dummy.updateMatrix()
              rails.setMatrixAt(slot, dummy.matrix)
              slot += 1
            }
          }
        }
        slabs.instanceMatrix.needsUpdate = true
        rails.instanceMatrix.needsUpdate = true
        slabs.castShadow = true
        group.add(slabs, rails)
      }

      for (let floor = 6; floor < item.floors; floor += 6) {
        const y = BASE_Y + PODIUM_HEIGHT + floor * FLOOR_HEIGHT
        const front = new THREE.Mesh(ledgeFrontGeo, trimMat)
        front.scale.x = item.width
        front.position.set(0, y, halfD - 0.02)
        const back = new THREE.Mesh(ledgeFrontGeo, trimMat)
        back.scale.x = item.width
        back.position.set(0, y, -halfD + 0.02)
        const right = new THREE.Mesh(ledgeSideGeo, trimMat)
        right.scale.z = item.depth
        right.position.set(halfW - 0.02, y, 0)
        const left = new THREE.Mesh(ledgeSideGeo, trimMat)
        left.scale.z = item.depth
        left.position.set(-halfW + 0.02, y, 0)
        group.add(front, back, right, left)
      }

      const plant = new THREE.Mesh(plantGeo, plantMat)
      plant.position.set(-0.35, BASE_Y + PODIUM_HEIGHT + towerH + 0.52, 0.1)
      plant.castShadow = true
      const tank = new THREE.Mesh(tankGeo, acMat)
      tank.position.set(1.2, BASE_Y + PODIUM_HEIGHT + towerH + 0.38, -0.4)
      tank.castShadow = true
      group.add(plant, tank)

      for (let index = 0; index < 2; index += 1) {
        const ac = new THREE.Mesh(acGeo, acMat)
        ac.position.set(item.width * 0.18, BASE_Y + PODIUM_HEIGHT + towerH + 0.28, -0.55 + index * 0.85)
        ac.castShadow = true
        ac.userData.buildingId = item.id
        group.add(ac)
      }

      if (item.floors >= 30) {
        const antenna = new THREE.Mesh(antennaGeo, antennaMat)
        antenna.position.set(-0.35, BASE_Y + PODIUM_HEIGHT + towerH + 1.35, 0.1)
        antenna.userData.buildingId = item.id
        group.add(antenna)
      }
      if (item.alarm) {
        const beaconMat = warningMat.clone()
        this.keep(beaconMat)
        this.beacons.push(beaconMat)
        const beacon = new THREE.Mesh(beaconGeo, beaconMat)
        beacon.position.set(0, BASE_Y + PODIUM_HEIGHT + towerH + 1.7, 0)
        beacon.userData.buildingId = item.id
        group.add(beacon)
      }

      const edge = this.keep(
        new THREE.LineBasicMaterial({
          color: item.alarm ? '#ff8a4c' : '#f4efe4',
          transparent: true,
          opacity: 0,
        }),
      )
      const outline = new THREE.LineSegments(this.keep(new THREE.EdgesGeometry(towerGeo)), edge)
      tower.add(outline)

      this.visuals.set(item.id, { edge, body, alarm: item.alarm })
      this.anchors.set(item.id, new THREE.Vector3(item.x, BASE_Y + PODIUM_HEIGHT + towerH + 1.4, item.z))
      this.pickables.push(tower, podium, pad, lobby, parapet)
      this.buildingRoot.add(group)
    }
    this.pickables.push(...this.gatePickables)
    this.anchors.set('gate', this.gateAnchor)
  }

  private clearBuildings() {
    this.buildingRoot.clear()
    this.buildingResources.forEach((resource) => resource.dispose())
    this.buildingResources.length = 0
    this.pickables.length = 0
    this.visuals.clear()
    this.anchors.clear()
    this.beacons.length = 0
  }

  private addStaticBox(
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) {
    const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(width, height, depth)), material)
    mesh.position.set(x, y, z)
    mesh.receiveShadow = true
    this.scene.add(mesh)
    return mesh
  }

  private raise(mesh: THREE.Mesh) {
    mesh.castShadow = true
    return mesh
  }
}

function createRoadTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建道路贴图')
  ctx.fillStyle = '#4a5158'
  ctx.fillRect(0, 0, 256, 256)
  const random = mulberry32(71)
  for (let index = 0; index < 1800; index += 1) {
    const value = 55 + Math.floor(random() * 50)
    ctx.fillStyle = `rgba(${value}, ${value}, ${value - 4}, ${0.18 + random() * 0.35})`
    ctx.fillRect(random() * 256, random() * 256, 1 + random() * 2.2, 1 + random() * 2.2)
  }
  ctx.strokeStyle = 'rgba(30, 32, 34, 0.18)'
  ctx.lineWidth = 3
  for (let index = 0; index < 5; index += 1) {
    ctx.beginPath()
    ctx.moveTo(0, 40 + index * 48)
    ctx.lineTo(256, 36 + index * 48)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(3, 3)
  return texture
}

function createGlowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建光晕贴图')
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.35, 'rgba(255,220,170,0.55)')
  gradient.addColorStop(1, 'rgba(255,220,170,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 64, 64)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createCarShellGeometry() {
  const shape = new THREE.Shape()
  const profile: Array<[number, number]> = [
    [-1.58, 0.24],
    [-1.66, 0.42],
    [-1.48, 0.64],
    [-1.05, 0.8],
    [-0.55, 1.0],
    [-0.22, 1.1],
    [0.58, 1.1],
    [1.02, 0.76],
    [1.4, 0.64],
    [1.64, 0.48],
    [1.68, 0.24],
  ]
  shape.moveTo(profile[0]![0], profile[0]![1])
  for (let index = 1; index < profile.length; index += 1) {
    shape.lineTo(profile[index]![0], profile[index]![1])
  }
  const width = 1.12
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.045,
    bevelSegments: 2,
    curveSegments: 1,
  })
  geometry.translate(0, 0, -width / 2)
  geometry.rotateY(Math.PI / 2)
  geometry.computeVertexNormals()
  return geometry
}

function createGateSignTexture(label = '智慧小区') {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 160
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建大门招牌')
  ctx.fillStyle = '#24303a'
  ctx.fillRect(0, 0, 640, 160)
  ctx.strokeStyle = '#d7b56a'
  ctx.lineWidth = 8
  ctx.strokeRect(10, 10, 620, 140)
  ctx.fillStyle = '#f8f1e4'
  ctx.font = `${label.length <= 2 ? 92 : 72}px "Microsoft YaHei", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 320, 86)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createShopSignTexture(label: string, color: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建商铺招牌')
  ctx.fillStyle = '#1c232a'
  ctx.fillRect(0, 0, 512, 128)
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 512, 12)
  ctx.fillRect(0, 116, 512, 12)
  ctx.fillStyle = '#fffaf3'
  ctx.font = '600 64px "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 256, 66)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createGrassTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建草坪贴图')
  ctx.fillStyle = '#3d8a3f'
  ctx.fillRect(0, 0, 256, 256)
  const random = mulberry32(43)
  for (let index = 0; index < 900; index += 1) {
    const tone = random()
    ctx.fillStyle = tone > 0.66 ? '#5aa64e' : tone > 0.33 ? '#2f7034' : '#67b15a'
    ctx.beginPath()
    ctx.ellipse(random() * 256, random() * 256, 2 + random() * 7, 1.2 + random() * 3, random() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(2, 2)
  return texture
}
