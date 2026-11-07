// 主窗口：设置 + 历史记录 两个页签（由原 settings.* 与 history.* 合并而来）
(async () => {
  const api = window.shotAPI
  const $ = (s) => document.querySelector(s)

  // ---- 主题 ----
  const applyTheme = (effective) => {
    document.documentElement.dataset.theme = effective
  }

  // ---- 页签切换 ----
  const pages = { settings: $('#page-settings'), history: $('#page-history') }
  let activePage = 'settings'
  function switchPage(name) {
    if (!pages[name]) return
    activePage = name
    for (const [k, el] of Object.entries(pages)) el.classList.toggle('active', k === name)
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name))
    if (name === 'history') hLoad()
  }
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.addEventListener('click', () => switchPage(b.dataset.page))
  })
  api.on('main:page', ({ page }) => switchPage(page))

  // ================= 设置页 =================
  function bindSeg(box, value, onChange) {
    box.querySelectorAll('.seg-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.v === value)
      b.onclick = () => {
        box.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b))
        onChange(b.dataset.v)
      }
    })
  }

  function fillSettings(s) {
    bindSeg($('#saveModeSeg'), s.saveMode, (v) => api.settings.set({ saveMode: v }))
    bindSeg($('#themeSeg'), s.theme, (v) => api.settings.set({ theme: v }))
    $('#dirHint').textContent = s.saveDir || '（未设置则使用 图片\\截图助手）'
    const slider = $('#pinOpacity')
    slider.value = s.pinOpacity
    $('#pinOpacityVal').textContent = s.pinOpacity + '%'
  }

  $('#pinOpacity').addEventListener('input', (e) => {
    $('#pinOpacityVal').textContent = Number(e.target.value) + '%'
  })
  $('#pinOpacity').addEventListener('change', (e) => {
    api.settings.set({ pinOpacity: Number(e.target.value) })
  })
  $('#chooseDirBtn').addEventListener('click', async () => {
    const dir = await api.app.chooseSaveDir()
    if (dir) $('#dirHint').textContent = dir
  })
  $('#autostart').addEventListener('click', async (e) => {
    const next = !e.currentTarget.classList.contains('on')
    const applied = await api.app.setAutostart(next)
    e.currentTarget.classList.toggle('on', !!applied)
  })
  $('#openData').addEventListener('click', (e) => {
    e.preventDefault()
    api.app.openDataFolder()
  })

  // ================= 历史记录页 =================
  const hListEl = $('#hList')
  const hEmptyEl = $('#empty')
  const hBadge = $('#countBadge')

  const pad = (n) => String(n).padStart(2, '0')
  const fmtTime = (ts) => {
    const d = new Date(ts)
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const fmtSize = (bytes) =>
    bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB'

  function hFlash(text) {
    const btn = $('#clearBtn')
    btn.textContent = text
    setTimeout(() => (btn.textContent = '清空'), 900)
  }

  async function hCopy(id) {
    const ok = await api.history.copy(id)
    if (ok) hFlash('已复制')
  }

  async function hDel(item) {
    if (item.local && !confirm('确定删除该本地截图文件？此操作不可恢复。')) return
    await api.history.remove(item.id)
    await hLoad()
  }

  function hRow(item) {
    const el = document.createElement('div')
    el.className = 'item'

    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = item.thumb
    img.title = '点击复制'
    img.addEventListener('click', () => hCopy(item.id))
    el.appendChild(img)

    const meta = document.createElement('div')
    meta.className = 'meta'
    const time = document.createElement('div')
    time.className = 'time'
    time.textContent = fmtTime(item.ts)
    if (item.local) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.textContent = '本地'
      time.appendChild(chip)
    }
    const sub = document.createElement('div')
    sub.className = 'sub'
    const name = item.local ? item.file.split(/[\\/]/).pop() + ' · ' : ''
    sub.textContent = `${name}${item.w} × ${item.h} · ${fmtSize(item.bytes)}`
    meta.append(time, sub)
    el.appendChild(meta)

    const ops = document.createElement('div')
    ops.className = 'ops'
    const actions = item.local
      ? [
          ['复制', () => hCopy(item.id), ''],
          ['贴图', () => api.history.pin(item.id), ''],
          ['打开位置', () => api.history.openLocation(item.id), ''],
          ['删除', () => hDel(item), 'del'],
        ]
      : [
          ['复制', () => hCopy(item.id), ''],
          ['贴图', () => api.history.pin(item.id), ''],
          ['另存', () => api.history.save(item.id), ''],
          ['删除', () => hDel(item), 'del'],
        ]
    for (const [label, fn, cls] of actions) {
      const b = document.createElement('button')
      b.textContent = label
      if (cls) b.className = cls
      b.addEventListener('click', fn)
      ops.appendChild(b)
    }
    el.appendChild(ops)
    return el
  }

  async function hLoad() {
    const items = await api.history.list()
    hListEl.innerHTML = ''
    hEmptyEl.style.display = items.length ? 'none' : 'flex'
    $('#emptyText').innerHTML = items.length
      ? ''
      : '还没有截图记录<br /><span>完成一次截图（复制 / 保存 / 贴图）后会自动出现在这里</span>'
    hBadge.textContent = items.length ? `${items.length} / 20` : ''
    for (const it of items) hListEl.appendChild(hRow(it))
  }

  $('#clearBtn').addEventListener('click', async () => {
    const items = await api.history.list()
    if (!items.length) return
    if (!confirm(`确定清空全部 ${items.length} 条应用内历史记录？\n本地保存的文件不受影响。`)) return
    await api.history.clear()
    await hLoad()
  })

  // ================= 初始化 =================
  const [state, s, autostart, version] = await Promise.all([
    api.app.themeState(),
    api.settings.get(),
    api.app.getAutostart(),
    api.app.getVersion(),
  ])
  applyTheme(state.effective)
  api.on('theme:changed', ({ effective }) => applyTheme(effective))
  fillSettings(s)
  $('#autostart').classList.toggle('on', !!autostart)
  $('#version').textContent = `截图助手 v${version}`
  $('#closeBtn').addEventListener('click', () => window.close())
})()
