// OCR 桥接：把选区图片写入临时文件，调 Windows 自带 WinRT OCR（经 PowerShell），返回逐行文本
// 依赖系统已安装 OCR 语言功能（中文系统默认具备），不引入第三方依赖
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const PS_SCRIPT = path.join(__dirname, 'ocr.ps1')

// WinRT OCR 会在汉字间插入空格（"截 屏 工 具"），折叠相邻 CJK 字符（含全角标点）之间的空格
const CJK_GAP = /([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/g
const tidyLine = (line) => line.replace(CJK_GAP, '$1')

function runOcr(dataUrl, langTag = 'zh-CN') {
  return new Promise((resolve) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '')
    if (!m) return resolve({ ok: false, code: 'bad_image' })

    const tmp = path.join(os.tmpdir(), `screenshot-assistant-ocr-${crypto.randomUUID()}.png`)
    try {
      fs.writeFileSync(tmp, Buffer.from(m[1], 'base64'))
    } catch (e) {
      return resolve({ ok: false, code: 'write_failed', detail: e.message })
    }

    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, '-ImagePath', tmp]
    if (langTag) args.push('-Lang', langTag)
    const ps = spawn('powershell.exe', args, { windowsHide: true })

    let out = ''
    let err = ''
    const timer = setTimeout(() => ps.kill(), 20000) // 兜底：OCR 卡死时结束

    ps.stdout.on('data', (d) => (out += d))
    ps.stderr.on('data', (d) => (err += d))
    ps.on('error', (e) => {
      clearTimeout(timer)
      fs.rmSync(tmp, { force: true })
      resolve({ ok: false, code: 'spawn_failed', detail: e.message })
    })
    ps.on('close', () => {
      clearTimeout(timer)
      fs.rmSync(tmp, { force: true })
      try {
        // 脚本保证最后一行 stdout 是单行 JSON
        const r = JSON.parse(out.trim().split(/\r?\n/).pop())
        if (r.ok && Array.isArray(r.lines)) r.lines = r.lines.map(tidyLine)
        resolve(r)
      } catch {
        resolve({ ok: false, code: 'parse_failed', detail: (err || out).slice(0, 300) })
      }
    })
  })
}

module.exports = { runOcr }
