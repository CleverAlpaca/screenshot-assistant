// 生成应用图标：
//   assets/icon.png（512×512）应用/任务栏/安装包图标：蓝→紫渐变圆角块 + 白色取景框四角 + 快门圆环
//   assets/tray.png（32×32）  托盘/通知专用：粗笔画简版，16px 显示下依然清晰
// 纯 Node 实现，无图像库依赖：SDF 绘制 + zlib PNG 编码（与时光助手 make-icon.mjs 同一套方案）
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---- SDF 基元 ----
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const dx = Math.abs(px - cx) - (hw - r)
  const dy = Math.abs(py - cy) - (hh - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r
}
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r
/** 环形：内圆 r-t / 外圆 r+t 的中轴距离（t = 半厚度） */
const sdRing = (px, py, cx, cy, r, t) => Math.abs(sdCircle(px, py, cx, cy, r)) - t
/** 圆角矩形描边带（沿轮廓一圈的带状区域，t = 半厚度） */
const sdRoundRectBand = (px, py, cx, cy, hw, hh, r, t) => Math.abs(sdRoundRect(px, py, cx, cy, hw, hh, r)) - t

const clamp01 = (v) => Math.min(1, Math.max(0, v))
const cov = (d) => clamp01(0.5 - d)
const mix = (a, b, t) => a + (b - a) * t
const over = (dst, src) => {
  const a = src[3] + dst[3] * (1 - src[3])
  if (a === 0) return [0, 0, 0, 0]
  return [
    (src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
    (src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
    (src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
    a,
  ]
}
const solid = (c, alpha) => [c[0], c[1], c[2], alpha]

// 应用主色：蓝 → 紫（与时光助手 --accent / 渐变一致）
const GRAD1 = [0x3d, 0x8b, 0xe9]
const GRAD2 = [0x8e, 0x6c, 0xf0]
const WHITE = [0xff, 0xff, 0xff]

/** 取景框角：矩形描边带与一个象限半平面区求交，形成 L 形角括号
 *  qx/qy = +1/-1 决定保留哪个象限（相对中心 cut 的内侧区域） */
const sdCorner = (px, py, cx, cy, hw, hh, r, t, cut, qx, qy) => {
  const band = sdRoundRectBand(px, py, cx, cy, hw, hh, r, t)
  const gate = Math.max((px - cx) * qx, (py - cy) * qy) - cut
  return Math.max(band, gate)
}

// ---- PNG 编码 ----
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(px, SIZE) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 通用绘制：渐变圆角块 + 取景框四角 + 快门圆环 + 中心点 ----
function drawShot(SIZE, geo) {
  const px = new Uint8Array(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let out = [0, 0, 0, 0]
      const t = (x + y) / (SIZE * 2)
      const bg = cov(sdRoundRect(x, y, SIZE / 2, SIZE / 2, geo.bg, geo.bg, geo.bgR))
      if (bg > 0) {
        out = over(out, solid([mix(GRAD1[0], GRAD2[0], t), mix(GRAD1[1], GRAD2[1], t), mix(GRAD1[2], GRAD2[2], t)], bg))
      }
      for (const [qx, qy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const c = cov(sdCorner(x, y, SIZE / 2, SIZE / 2, geo.fw, geo.fw, geo.fwR, geo.fwT, geo.cut, qx, qy))
        if (c > 0) out = over(out, solid(WHITE, c))
      }
      const ring = cov(sdRing(x, y, SIZE / 2, SIZE / 2, geo.lensR, geo.lensT))
      if (ring > 0) out = over(out, solid(WHITE, ring))
      const dot = cov(sdCircle(x, y, SIZE / 2, SIZE / 2, geo.dotR))
      if (dot > 0) out = over(out, solid(WHITE, dot))
      const i = (y * SIZE + x) * 4
      px[i] = Math.round(out[0])
      px[i + 1] = Math.round(out[1])
      px[i + 2] = Math.round(out[2])
      px[i + 3] = Math.round(out[3] * 255)
    }
  }
  return encodePNG(px, SIZE)
}

// 512 主图标：取景框 300×300，臂长到中心 40px 内缘，快门环 r58/t18，中心点 r16
function drawIcon512() {
  return drawShot(512, { bg: 244, bgR: 116, fw: 150, fwR: 48, fwT: 22, cut: 40, lensR: 58, lensT: 18, dotR: 16 })
}

// 32 托盘：粗笔画简版
function drawTray32() {
  return drawShot(32, { bg: 15.6, bgR: 8, fw: 9.6, fwR: 3, fwT: 1.5, cut: 2.6, lensR: 3.7, lensT: 1.15, dotR: 1.0 })
}

mkdirSync(path.join(root, 'assets'), { recursive: true })
const icon = drawIcon512()
writeFileSync(path.join(root, 'assets', 'icon.png'), icon)
console.log(`assets/icon.png 已生成 (${icon.length} 字节)`)
const tray = drawTray32()
writeFileSync(path.join(root, 'assets', 'tray.png'), tray)
console.log(`assets/tray.png 已生成 (${tray.length} 字节)`)
