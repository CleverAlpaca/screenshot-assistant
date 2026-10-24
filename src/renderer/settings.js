// 设置窗口：加载/写入设置 + 主题跟随 + 自启开关
(() => {
  const api = window.shotAPI
  const $ = (s) => document.querySelector(s)

  const applyTheme = (effective) => {
    document.documentElement.dataset.theme = effective
  }

  function bindSeg(box, value, onChange) {
    box.querySelectorAll('.seg-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.v === value)
      b.onclick = () => {
        box.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b))
        onChange(b.dataset.v)
      }
    })
  }

  function fill(s) {
    bindSeg($('#saveModeSeg'), s.saveMode, (v) => api.settings.set({ saveMode: v }))
    bindSeg($('#themeSeg'), s.theme, (v) => api.settings.set({ theme: v }))
    $('#dirHint').textContent = s.saveDir || '（未设置则使用 图片\\截图助手）'
    const slider = $('#pinOpacity')
    slider.value = s.pinOpacity
    $('#pinOpacityVal').textContent = s.pinOpacity + '%'
  }

  async function init() {
    const [state, s, autostart, version] = await Promise.all([
      api.app.themeState(),
      api.settings.get(),
      api.app.getAutostart(),
      api.app.getVersion(),
    ])
    applyTheme(state.effective)
    fill(s)
    $('#autostart').classList.toggle('on', !!autostart)
    $('#version').textContent = `截图助手 v${version}`

    api.on('theme:changed', ({ effective }) => applyTheme(effective))
  }

  $('#pinOpacity').addEventListener('input', (e) => {
    const v = Number(e.target.value)
    $('#pinOpacityVal').textContent = v + '%'
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
  $('#closeBtn').addEventListener('click', () => window.close())
  $('#openData').addEventListener('click', (e) => {
    e.preventDefault()
    api.app.openDataFolder()
  })

  init()
})()
