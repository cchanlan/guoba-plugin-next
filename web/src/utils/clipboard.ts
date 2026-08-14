/**
 * 剪贴板。
 *
 * 面板常常是 http://ip:port 这种非安全上下文，`navigator.clipboard` 要么是 undefined
 * 要么被权限直接拒掉，所以每条路都准备了 `execCommand('copy')` 的退路：
 * 文本走隐藏 textarea，带图的走隐藏 contenteditable（选区里的 HTML 会被浏览器
 * 一并放进剪贴板，图片也在里面）。
 *
 * 函数只返回成功与否，提示文案留给调用方 —— 不同页面的说法不一样。
 */

/** 复制纯文本 */
export async function writeText(text: string): Promise<boolean> {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 退回老接口：塞一个隐藏 textarea，选中再 copy
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(ta)
    return ok
  }
}

/**
 * 复制一整条消息：文本和图片一起进剪贴板。
 *
 * images 必须是 dataURL —— 粘贴的目标（QQ、文档、聊天框）不一定能访问面板的资源地址，
 * 字节得嵌在 HTML 里跟着走。同时写 text/plain 与 text/html，纯文本编辑器粘到文字、
 * 富文本编辑器粘到图文；另附一份 image/png（一个 ClipboardItem 只放得下一张），
 * 让只认图片格式的地方也能粘上第一张。
 */
export async function writeRich(text: string, images: string[]): Promise<boolean> {
  if (!images.length) return writeText(text)
  const html = buildHtml(text, images)

  if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      const items: Record<string, Blob> = {
        'text/html': new Blob([html], { type: 'text/html' }),
      }
      // 纯图消息不写 text/plain：写了粘到输入框就是一行「[图片]」，图片反而被挡在后面
      if (text) items['text/plain'] = new Blob([text], { type: 'text/plain' })
      const png = await toPngBlob(images[0])
      if (png) items['image/png'] = png
      await navigator.clipboard.write([new ClipboardItem(items)])
      return true
    } catch {
      // 权限或格式被拒，落到下面的老接口
    }
  }
  return copyHtml(html)
}

/** 把图片地址读成 dataURL，跨端粘贴要靠它把字节带上 */
export async function toDataUrl(src: string): Promise<string | null> {
  if (!src) return null
  if (src.startsWith('data:')) return src
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * 从粘贴进来的 HTML 里把图片抠出来。
 *
 * http 下复制带图消息只能走选区那条路（见 copyHtml），剪贴板里不会有 image/* 的文件项，
 * 图片全藏在 `text/html` 的 `<img src="data:…">` 里 —— 所以面板自己的输入框得自己扒一遍，
 * 不然粘进来只剩文字。外站图片的直链多半不给跨域，读不到就跳过。
 */
export async function filesFromHtml(html: string, max = 9): Promise<File[]> {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const srcs = [...doc.querySelectorAll('img')]
    .map((img) => img.getAttribute('src') ?? '')
    .filter(Boolean)
    .slice(0, max)

  const files = await Promise.all(srcs.map((src, i) => toFile(src, i)))
  return files.filter((f): f is File => !!f)
}

async function toFile(src: string, index: number): Promise<File | null> {
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    const ext = blob.type.split('/')[1] || 'png'
    return new File([blob], `paste-${Date.now()}-${index}.${ext}`, { type: blob.type })
  } catch {
    return null
  }
}

const escapeHtml = (str: string) =>
  str.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

function buildHtml(text: string, images: string[]) {
  const parts = images.map((src) => `<img src="${src}" />`)
  if (text) parts.unshift(`<div>${escapeHtml(text).replace(/\n/g, '<br />')}</div>`)
  return parts.join('')
}

/** 选中一段隐藏的富文本再 copy —— http 下唯一能把图片放进剪贴板的办法 */
function copyHtml(html: string): boolean {
  const holder = document.createElement('div')
  holder.contentEditable = 'true'
  holder.innerHTML = html
  // display:none / opacity:0 的内容选不中，只能挪出视口
  holder.style.position = 'fixed'
  holder.style.left = '-9999px'
  holder.style.top = '0'
  document.body.appendChild(holder)

  const range = document.createRange()
  range.selectNodeContents(holder)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)

  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  sel?.removeAllRanges()
  document.body.removeChild(holder)
  return ok
}

/** 剪贴板只有 png 是各浏览器都认的，jpeg/webp 先过一遍 canvas */
async function toPngBlob(src: string): Promise<Blob | null> {
  try {
    const res = await fetch(src)
    if (!res.ok) return null
    const blob = await res.blob()
    if (blob.type === 'image/png') return blob
    return await transcode(blob)
  } catch {
    return null
  }
}

function transcode(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d')?.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob((out) => resolve(out), 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}
