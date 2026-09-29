import * as THREE from 'three'
import { mulberry32 } from '../utils/random'

const CELL_W = 24
const CELL_H = 30
const PIER = 6
const BAND = 6

export function facadeBayUs(columns: number) {
  const texW = columns * CELL_W + (columns + 1) * PIER
  const bays = columns >= 7 ? [1, 3, 5] : [1, columns - 2]
  return bays
    .filter((column) => column > 0 && column < columns - 1)
    .map((column) => (PIER + column * (CELL_W + PIER) + CELL_W / 2) / texW)
}

export function createFacadeTextures(floors: number, columns: number, seed: number) {
  const width = columns * CELL_W + (columns + 1) * PIER
  const floorSpan = CELL_H + BAND
  const height = floors * floorSpan
  const pixelScale = 2
  const balconyBays = new Set(facadeBayUs(columns).map((u) => Math.round(u * width)))

  const colorCanvas = document.createElement('canvas')
  colorCanvas.width = width * pixelScale
  colorCanvas.height = height * pixelScale
  const emissiveCanvas = document.createElement('canvas')
  emissiveCanvas.width = colorCanvas.width
  emissiveCanvas.height = colorCanvas.height

  const ctx = colorCanvas.getContext('2d')
  const emissiveCtx = emissiveCanvas.getContext('2d')
  if (!ctx || !emissiveCtx) {
    throw new Error('无法创建楼体立面贴图')
  }

  ctx.scale(pixelScale, pixelScale)
  emissiveCtx.scale(pixelScale, pixelScale)

  ctx.fillStyle = '#e4ded2'
  ctx.fillRect(0, 0, width, height)
  emissiveCtx.fillStyle = '#000000'
  emissiveCtx.fillRect(0, 0, width, height)

  const random = mulberry32(seed)
  for (let speck = 0; speck < width * height * 0.04; speck += 1) {
    const shade = random()
    ctx.fillStyle = shade > 0.5 ? 'rgba(255,255,255,0.13)' : 'rgba(90,78,62,0.08)'
    ctx.fillRect(random() * width, random() * height, 1 + random() * 2, 1 + random() * 2)
  }

  ctx.fillStyle = '#cfc6b8'
  ctx.fillRect(0, 0, PIER, height)
  ctx.fillRect(width - PIER, 0, PIER, height)

  for (let floor = 0; floor < floors; floor += 1) {
    const y = floor * floorSpan
    ctx.fillStyle = floor % 5 === 0 ? '#b7aa9a' : '#d4cdc0'
    ctx.fillRect(0, y, width, BAND)

    for (let column = 0; column < columns; column += 1) {
      const x = PIER + column * (CELL_W + PIER)
      const center = Math.round(x + CELL_W / 2)
      const hasBalcony = balconyBays.has(center)
      const lit = random() > 0.78
      const curtain = !lit && random() > 0.55
      const frameX = x + 3
      const frameY = y + BAND + 4
      const frameW = CELL_W - 6
      const frameH = CELL_H - (hasBalcony ? 10 : 8)

      ctx.fillStyle = '#f6f2ea'
      ctx.fillRect(frameX - 1, frameY - 1, frameW + 2, frameH + 2)
      ctx.fillStyle = '#efeae1'
      ctx.fillRect(x, y + BAND, CELL_W, 3)

      if (lit) {
        ctx.fillStyle = '#f3d7a2'
        emissiveCtx.fillStyle = '#fff1d2'
      } else if (curtain) {
        ctx.fillStyle = '#c9d0d6'
        emissiveCtx.fillStyle = '#000000'
      } else {
        ctx.fillStyle = random() > 0.5 ? '#243640' : '#1a2832'
        emissiveCtx.fillStyle = '#000000'
      }
      ctx.fillRect(frameX, frameY, frameW, frameH)
      emissiveCtx.fillRect(frameX, frameY, frameW, frameH)

      ctx.fillStyle = '#f7f3ec'
      ctx.fillRect(frameX + frameW / 2 - 0.6, frameY, 1.2, frameH)
      ctx.fillRect(frameX, frameY + frameH * 0.42, frameW, 1.2)
      if (!lit) {
        ctx.fillStyle = 'rgba(255,255,255,0.28)'
        ctx.fillRect(frameX + 1.5, frameY + 1.5, frameW * 0.22, frameH * 0.35)
      }

      if (hasBalcony) {
        ctx.fillStyle = '#c8c2b6'
        ctx.fillRect(x + 1, y + floorSpan - 5, CELL_W - 2, 4)
        ctx.fillStyle = '#8e969c'
        ctx.fillRect(x + 1, y + floorSpan - 7, CELL_W - 2, 1.4)
      } else if (random() > 0.72) {
        ctx.fillStyle = '#c5ccd1'
        ctx.fillRect(frameX + frameW - 5, frameY + frameH - 6, 4.5, 3.2)
        ctx.strokeStyle = '#8d969c'
        ctx.strokeRect(frameX + frameW - 5, frameY + frameH - 6, 4.5, 3.2)
      }
    }
  }

  const map = new THREE.CanvasTexture(colorCanvas)
  const emissiveMap = new THREE.CanvasTexture(emissiveCanvas)
  map.colorSpace = THREE.SRGBColorSpace
  emissiveMap.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  emissiveMap.anisotropy = 8
  return { map, emissiveMap }
}
