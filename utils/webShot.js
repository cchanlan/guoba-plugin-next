import dns from 'node:dns/promises'
import net from 'node:net'
import {createRequire} from 'module'

const require = createRequire(import.meta.url)

/**
 * 网页截图：群里发个网址，截一张图预览。
 *
 * 这个文件**只放纯逻辑**，配置由调用方（apps/webShot.js）读好传进来，
 * 不 import 任何 #guoba.* 别名 —— 那些一 import 就要拉起整个平台，没法脱机测。
 *
 * 截图之外的两件正事：
 *  1. 安全：链接是群友随手发的，等于让服务器去访问任意地址。内网、云元数据、
 *     会回显出口 IP 的站点全要拦，跳转和 iframe 也要跟着拦一遍。
 *  2. 有效性：截回来是人机验证转圈、登录墙、404 的话，这张图发出去纯刷屏，
 *     所以截完先照一眼页面长什么样，不值当的就不发。
 */

/** 默认配置。锅巴面板里改的是 defSet/config 的 webShot 段，这里只兜底 */
export const DEFAULT_CONFIG = {
  enable: false,
  loadTimeout: 25,
  extraWait: 2,
  proxy: '',
  proxyFirst: false,
  blockPrivate: true,
  autoScroll: true,
  skipUnworthy: true,
  blacklist: []
}

/** 会回显访问者出口 IP 的站点，截图等于把服务器 IP 发到群里 */
const IP_ECHO_HOSTS = [
  'ip.sb', 'ipinfo.io', 'ipip.net', 'ip138.com', 'ip.cn', 'myip.la', 'myip.com',
  'whatismyip.com', 'whatismyipaddress.com', 'ipchicken.com', 'icanhazip.com',
  'ifconfig.me', 'ifconfig.co', 'ipecho.net', 'checkip.amazonaws.com',
  'ipapi.co', 'ip-api.com', 'ipwho.is', 'ipleak.net', 'dnsleaktest.com',
  'browserleaks.com', 'whoer.net', 'speedtest.net', 'ping.pe', 'itdog.cn',
  'chaipip.com', 'tool.chinaz.com', 'ipplus360.com'
]

/** 直接触发下载的文件后缀，浏览器打不开，截图必然报 ERR_ABORTED */
const DOWNLOAD_EXT = /\.(exe|msi|dmg|apk|ipa|zip|rar|7z|tar|gz|tgz|bz2|xz|iso|img|deb|rpm|pkg|jar|bin|whl|pdf|docx?|xlsx?|pptx?|mp4|mkv|avi|mov|flv|m3u8|mp3|flac|wav|torrent)$/i

/** 数据库、缓存、容器接口这些不是网页的端口 */
const DANGER_PORTS = ['22', '23', '3306', '5432', '6379', '11211', '27017', '9200', '2375', '3389']

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 取出真实 hostname（去掉 IPv6 的方括号） */
function cleanHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

/** 判断 IP 是否为内网 / 本机 / 保留地址 */
export function isPrivateIP(ip) {
  if (net.isIPv6(ip)) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    // 链路本地
    if (v6.startsWith('fe80:')) return true
    // ULA
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIP(mapped[1])
    return false
  }
  const p = ip.split('.').map(Number)
  // 解析不出四段就当危险处理
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true
  return (
    p[0] === 0 ||
    p[0] === 10 ||
    p[0] === 127 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    // CGNAT
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    // 组播 / 保留
    p[0] >= 224
  )
}

/**
 * 链接安全校验。跳转和 iframe 也要走这一遍，所以它得能被反复调用且够快。
 * @param rawUrl 待校验的地址
 * @param cfg 配置（用到 blockPrivate、blacklist）
 * @returns {Promise<{ok: boolean, url?: string, reason?: string}>}
 */
export async function checkUrl(rawUrl, cfg) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return {ok: false, reason: '链接格式不对哦'}
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return {ok: false, reason: '只支持 http/https 链接'}
  }

  const host = cleanHost(url.hostname)

  if (DOWNLOAD_EXT.test(url.pathname)) {
    return {ok: false, reason: '这是下载链接，截不了图哦'}
  }

  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (DANGER_PORTS.includes(port)) {
    return {ok: false, reason: '这个端口不像是网页，不解析'}
  }

  if (IP_ECHO_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    return {ok: false, reason: '这个网站会显示服务器 IP，不解析哦'}
  }

  for (const b of (cfg.blacklist || [])) {
    const bl = String(b).toLowerCase().trim()
    if (bl && (host === bl || host.endsWith('.' + bl.replace(/^\./, '')))) {
      return {ok: false, reason: '这个网址在黑名单里，不解析'}
    }
  }

  if (!cfg.blockPrivate) return {ok: true, url: url.href}

  // 直接写的 IP 字面量
  if (net.isIP(host)) {
    if (isPrivateIP(host)) return {ok: false, reason: '内网地址不解析，会暴露服务器信息'}
    return {ok: true, url: url.href}
  }

  // 常见的本机 / 内网域名
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')
  ) {
    return {ok: false, reason: '内网地址不解析，会暴露服务器信息'}
  }

  // 解析一遍再看，防的是「域名指向内网」这种绕法
  try {
    const records = await dns.lookup(host, {all: true, verbatim: true})
    if (!records.length) return {ok: false, reason: '域名解析失败'}
    for (const r of records) {
      if (isPrivateIP(r.address)) {
        return {ok: false, reason: '域名指向内网地址，不解析'}
      }
    }
  } catch {
    return {ok: false, reason: '域名解析失败'}
  }

  return {ok: true, url: url.href}
}

/* ── 下面这一套判断「这张图值不值得发」 ───────────────────────────── */

/** 人机验证 / 盾页的 DOM 特征，各家风控厂商的容器和 iframe */
const CHALLENGE_SELECTORS = [
  // Cloudflare：老的拦截页、错误页，以及新的 Turnstile
  '#challenge-running', '#challenge-form', '#challenge-stage',
  '#cf-challenge-running', '#cf-spinner-please-wait', '#cf-error-details',
  '.cf-turnstile', 'iframe[src*="challenges.cloudflare.com"]',
  // hCaptcha / reCAPTCHA
  '.h-captcha', 'iframe[src*="hcaptcha.com"]',
  '.g-recaptcha', 'iframe[src*="/recaptcha/"]',
  // 极验、阿里滑块、阿里安全
  '.geetest_holder', '.geetest_panel', '#nc_1_wrapper', '.nc-container', '#sec-container',
  // DataDome / PerimeterX / AWS WAF
  'iframe[src*="captcha-delivery.com"]', '#px-captcha', '#awswaf-captcha', 'iframe[src*="awswaf"]'
]

/** 盾页的标题特征 */
const CHALLENGE_TITLE_RE = /just a moment|attention required|checking your browser|安全验证|请稍候|人机验证|验证中/i

/** 盾页的正文特征。只在页面本来就没什么内容时才作数，免得误杀正文里提到验证码的正常页面 */
const CHALLENGE_TEXT_RE = /verifying you are human|verify you are human|checking your browser|needs to review the security|enable javascript and cookies|请完成(安全)?验证|请输入验证码|滑动完成验证|正在验证|verifying\.\.\./i

/** 错误页的标题特征 */
const ERROR_TITLE_RE = /^\s*(4\d{2}|5\d{2})\b|not found|forbidden|bad gateway|service unavailable|gateway time-?out|access denied|页面不存在|站点不存在|无法访问|访问被拒绝/i

/*
 * 登录页判定。**别拿「页面上有登录字样」当判据** —— 百度首页正文里就写着「设置登录」，
 * 而且它整页正文才 400 来字，靠「有登录字样 + 内容少」会把门户首页全误杀。
 * 实测能干净分开「登录页」和「内容少的正常首页」的只有两样：地址栏的路径、标题的开头。
 */
/** 地址就是登录路径。要求是完整的一段，这样 /login-guide 这种文章页不会中招 */
const LOGIN_PATH_RE = /\/(?:login|logon|signin|sign_in|sign-in|signup|sign_up|register|auth|oauth|passport)(?:[/?#]|$)/i
/** 标题开头就是「登录」「注册」。实测 gitcode 登录页是「登录 - AtomGit」，一个密码框都没有 */
const LOGIN_TITLE_RE = /^\s*(?:请)?(?:登录|登陸|注册|註冊|会员登录|用户登录|sign\s?in|log\s?in|sign\s?up)\b/i
/** 只有登录墙才会说的话，兜住那些不在 /login 路径上的登录墙 */
const LOGIN_TEXT_RE = /请先登录|请登录后|登录后(?:即可)?(?:查看|可见|继续|使用)|需要登录|登录以继续|扫码登录|账号登录|密码登录|验证码登录|sign in to continue|log in to continue|please sign in|please log in/i

/*
 * 扫码登录（弹二维码那种）。跟上面几条分开判，因为它的页面**可能是有内容的** ——
 * 二维码盖在弹层里，背后的正文照样被 innerText 读到，字数一点都不「贫瘠」。
 *
 * 难点是**不能一见二维码就拦**：正常页面的页脚全是「扫码下载 App」「扫码关注公众号」。
 * 所以要两个条件凑齐：**有一个足够大的可见二维码**，而且（它在弹层里 ‖ 页面明说了是扫码登录）。
 */
/** 二维码元素。范围放宽，大小和位置在浏览器里再筛 */
const QR_SELECTORS = '[class*="qrcode" i],[id*="qrcode" i],[class*="qr-code" i],[class*="qrCode"],[id*="qrCode"],canvas[class*="qr" i]'
/** 一看就是扫码登录的硬信号：微信开放平台的登录 iframe、微信 JS SDK 那个登录框 */
const QR_HARD_SELECTORS = 'iframe[src*="qrconnect"],iframe[src*="open.weixin.qq.com/connect"],.impowerBox,.wx_qrcode'
/** 扫码措辞。**必须带「登录」二字** —— 「扫码下载」「扫码关注」「扫码支付」全是正常页面在说 */
const QR_LOGIN_RE = /扫[一码].{0,6}登录|扫描.{0,8}登录|二维码.{0,4}登录|scan (?:the )?qr ?code to (?:log|sign) ?in|scan to (?:log|sign) ?in/i

/** 不发图时给群里的说法 */
export const UNWORTHY_TIP = {
  challenge: '这个网站要过人机验证，截不到内容',
  login: '这个页面要登录才能看，就不发图了',
  error: '这个网页打不开，就不发图了',
  empty: '这个页面没什么内容，就不发图了'
}

/**
 * 页面截得出来但不值得发。
 *
 * retryable=true 表示换条线路可能就拿到真内容了 —— 盾页跟出口 IP 有关，
 * 直连被拦、走代理未必被拦，值得再试一次；登录墙和 404 换谁去都一样，不重试。
 */
export class UnworthyError extends Error {
  constructor(kind, reason, retryable = false) {
    super(reason)
    this.kind = kind
    this.unworthy = true
    this.retryable = retryable
  }
}

/** 等页面真正渲染完：滚动触发懒加载 → 等图片和字体 → 额外静置 */
async function settle(page, cfg) {
  if (cfg.autoScroll) {
    try {
      await page.evaluate(() => new Promise(res => {
        let y = 0
        const step = () => {
          const h = window.innerHeight
          window.scrollBy(0, h)
          y += h
          // 最多滚 30 屏，防的是无限流页面把截图拖死
          if (y >= document.body.scrollHeight || y > h * 30) {
            window.scrollTo(0, 0)
            return res()
          }
          setTimeout(step, 100)
        }
        step()
      }))
    } catch {}
  }

  // 等字体和图片，整段**必须有上限**：`document.fonts.ready` 在字体挂在墙外 CDN 上时
  // 永远不 resolve，而 goto 的 timeout 管不到 evaluate —— 实测微信网页版卡了 184 秒才回来。
  // race 掉之后那个 evaluate 还在页面里跑，但没人等它了，截图照常进行
  try {
    await Promise.race([
      page.evaluate(() => Promise.all([
        document.fonts ? document.fonts.ready : null,
        ...[...document.images].filter(i => !i.complete).map(i => new Promise(r => {
          i.addEventListener('load', r, {once: true})
          i.addEventListener('error', r, {once: true})
          setTimeout(r, 3000)
        }))
      ])),
      new Promise(r => setTimeout(r, 5000))
    ])
  } catch {}

  if (cfg.extraWait > 0) {
    await new Promise(r => setTimeout(r, cfg.extraWait * 1000))
  }
}

/**
 * 截图前照一眼页面，是盾页 / 登录墙 / 错误页 / 空白页就别发。
 *
 * ⚠️ 这里的人机验证基本没有过掉的可能：为了拦跳转开了 CDP 会话，
 * 而「有调试器 attach 着」本身就是各家风控判定机器人的依据之一。
 * 拦跳转是防 SSRF 的底线，所以宁可放弃这类站点的截图，也不摘掉那道拦截。
 *
 * @param page puppeteer 的 Page
 * @param status 主文档的 HTTP 状态码，拿不到传 0
 * @returns {Promise<UnworthyError|null>} 返回 null 表示这张图可以发
 */
export async function inspectPage(page, status = 0) {
  let snap
  try {
    snap = await page.evaluate((sels, qrSel, qrHardSel) => {
      const body = document.body
      const text = (body?.innerText || '').replace(/\s+/g, ' ').trim()
      // 只算**可见**的密码框：不少站点把登录表单预置在弹层里，没显示出来的不算登录墙
      const pwd = [...document.querySelectorAll('input[type="password"]')]
        .filter(i => i.offsetWidth > 0 && i.offsetHeight > 0)

      // 够大的可见二维码。60px 以下的当图标处理（有些站导航栏挂个小 qr 图标）
      const qr = [...document.querySelectorAll(qrSel)].filter(el => {
        const r = el.getBoundingClientRect()
        return r.width >= 60 && r.height >= 60
      })
      // 这些二维码有没有被弹层裹着 —— 弹层意味着「内容被盖住了」，截图没意义。
      // 判据是往上找到 fixed，或者 absolute 且 z-index 抬得很高
      const qrOverlay = qr.some(el => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const s = getComputedStyle(n)
          if (s.position === 'fixed') return true
          if (s.position === 'absolute' && (parseInt(s.zIndex) || 0) >= 100) return true
        }
        return false
      })

      return {
        title: (document.title || '').trim(),
        text: text.slice(0, 3000),
        textLen: text.length,
        hit: sels.filter(s => {
          try {
            return !!document.querySelector(s)
          } catch {
            return false
          }
        }),
        qrCount: qr.length,
        qrOverlay,
        qrHard: !!document.querySelector(qrHardSel),
        pwdCount: pwd.length,
        linkCount: document.querySelectorAll('a[href]').length,
        imgCount: [...document.images].filter(i => i.complete && i.naturalWidth > 2).length,
        bodyH: body?.scrollHeight || 0
      }
    }, CHALLENGE_SELECTORS, QR_SELECTORS, QR_HARD_SELECTORS)
  } catch (err) {
    // 页面正在跳转、已经关掉之类读不到的情况：不拦，让图照常发出去
    logger.debug(`[Guoba] 网页截图体检读不到: ${err.message}`)
    return null
  }

  const {title, text, textLen, hit, pwdCount, linkCount, imgCount, bodyH} = snap
  const {qrCount, qrOverlay, qrHard} = snap
  // 「内容贫瘠」的门槛。盾页和登录页正文都只有几十到几百字，正常网页轻松上千
  const thin = textLen < 600

  // 1. 人机验证 / 盾页。放最前面判：这类页面常常同时带着 403，
  //    按状态码先判会把它错报成「网页打不开」，换线路重试的机会也一起丢了
  if (hit.length || (thin && (CHALLENGE_TITLE_RE.test(title) || CHALLENGE_TEXT_RE.test(text)))) {
    return new UnworthyError('challenge', `人机验证页 [${hit.join(' ') || title}]`, true)
  }

  // 扫码登录墙。微信那套 iframe / .impowerBox 是硬信号，单独出现就算；
  // 其余要「够大的可见二维码」配上「在弹层里 ‖ 页面明说了扫码登录」才算，
  // 免得把页脚挂着「扫码下载 App」的正常页面一起拦掉
  const qrWall = qrHard || (qrCount > 0 && (qrOverlay || QR_LOGIN_RE.test(text)))

  // 2. 登录墙。五条各管一种情况：弹二维码的；地址就是 /login（最硬，页面本身就是登录墙）；
  //    标题开头是「登录」；有可见密码框而且除了表单没别的东西（光有密码框不算 ——
  //    论坛首页侧栏就带登录框，正文照样完整）；以及明说了「请先登录」这类话的
  if (
    qrWall ||
    LOGIN_PATH_RE.test(page.url()) ||
    LOGIN_TITLE_RE.test(title) ||
    (pwdCount > 0 && (textLen < 400 || linkCount < 8)) ||
    (thin && LOGIN_TEXT_RE.test(text))
  ) {
    return new UnworthyError('login', `需要登录 [${qrWall ? '扫码 · ' : ''}${title}]`)
  }

  // 3. 服务器自己说了这不是正常内容。
  //    **这里不看正文长短** —— 现在的 404 页都带着完整导航栏和推荐位，
  //    实测 gitcode 的 404 正文有 1300~1600 字还在来回浮动，
  //    按字数判会同一个链接两次两种结果。状态码才是稳的那个
  if (status >= 400 || (thin && ERROR_TITLE_RE.test(title))) {
    return new UnworthyError('error', `错误页 ${status || ''} [${title}]`.replace(/\s+/g, ' '))
  }

  // 4. 白板：没文字、没图、页面还很矮，截出来就是一片空白
  if (textLen < 40 && imgCount === 0 && bodyH < 400) {
    return new UnworthyError('empty', '页面没有可显示的内容')
  }

  return null
}

/** 浏览器启动参数。--no-sandbox 是 root 下跑必须的（容器和 VPS 上普遍如此） */
function launchArgs(proxy) {
  const args = [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-sandbox',
    '--hide-scrollbars',
    '--lang=zh-CN'
  ]
  if (proxy) args.push(`--proxy-server=${proxy}`)
  return args
}

/** 开一个页、设好视口和 UA、把导航请求接到安全校验上 */
async function preparePage(browser, cfg) {
  const page = await browser.newPage()
  await page.setViewport({width: 1920, height: 1080})
  await page.setUserAgent(UA)

  // 只拦「页面导航」请求，防止重定向 / iframe 打到内网绕过前置校验。
  // **不能用 page.setRequestInterception**：它会把全部静态资源都拦下来、
  // 请求被拖成串行，networkidle2 于是提前触发，截出来是骨架屏。
  // 实测同一个页面，带 setRequestInterception 61KB、不带 1450KB。
  const cdp = await page.createCDPSession()
  await cdp.send('Fetch.enable', {
    patterns: [{resourceType: 'Document', requestStage: 'Request'}]
  })
  cdp.on('Fetch.requestPaused', async ev => {
    const verdict = await checkUrl(ev.request.url, cfg)
    try {
      if (verdict.ok) {
        await cdp.send('Fetch.continueRequest', {requestId: ev.requestId})
      } else {
        logger.warn(`[Guoba] 网页截图已拦截跳转 ${ev.request.url} (${verdict.reason})`)
        await cdp.send('Fetch.failRequest', {requestId: ev.requestId, errorReason: 'BlockedByClient'})
      }
    } catch {}
  })

  return page
}

/** 被安全策略拦下的错误特征（换线路重试也没用） */
const BLOCKED_RE = /最终地址被拦截|ERR_BLOCKED_BY_CLIENT/

/** 单次截图。proxy 为 null 表示直连；isLast=false 时用较短超时，好尽快换下一条线路 */
async function shootOnce(targetUrl, cfg, proxy, isLast = true) {
  const puppeteer = require('puppeteer')
  const timeout = (isLast ? cfg.loadTimeout : Math.min(cfg.loadTimeout, 10)) * 1000

  const browser = await puppeteer.launch({headless: true, args: launchArgs(proxy)})
  try {
    const page = await preparePage(browser, cfg)
    const resp = await page.goto(targetUrl, {waitUntil: 'networkidle2', timeout})

    await settle(page, cfg)

    // 二次确认：跳转后的最终地址仍然要合法
    const finalCheck = await checkUrl(page.url(), cfg)
    if (!finalCheck.ok) {
      throw new Error(`最终地址被拦截: ${finalCheck.reason}`)
    }

    // goto 碰上同页锚点跳转会返回 null，状态码要防空
    if (cfg.skipUnworthy) {
      const bad = await inspectPage(page, resp?.status?.() || 0)
      if (bad) throw bad
    }

    return await page.screenshot({fullPage: true})
  } finally {
    await browser.close()
  }
}

/**
 * 按「直连 → 代理」的顺序试，前者失败自动换后者。proxyFirst=true 时顺序相反。
 *
 * 不能无脑走代理：实测 gitcode、百度直连正常，github 直连必超时、走代理 11 秒出图。
 * 第一次尝试用短超时，否则 github 要白等满 25 秒。
 */
async function withFallback(cfg, fn) {
  const order = cfg.proxy
    ? (cfg.proxyFirst ? [cfg.proxy, null] : [null, cfg.proxy])
    : [null]

  let lastErr
  for (let i = 0; i < order.length; i++) {
    const p = order[i]
    try {
      return await fn(p, i === order.length - 1)
    } catch (err) {
      lastErr = err
      logger.warn(`[Guoba] 网页截图${p ? '走代理' : '直连'}失败: ${err.message}`)
      // 被安全策略拦下的，换线路也一样
      if (BLOCKED_RE.test(String(err.message))) throw err
      // 登录墙 / 错误页 / 空白页跟走哪条线路无关，别再白等第二条
      if (err.unworthy && !err.retryable) throw err
    }
  }
  throw lastErr
}

/** 截图入口：默认先直连（国内站快），失败再走代理重试（外网站） */
export function screenshot(targetUrl, cfg) {
  return withFallback(cfg, (p, isLast) => shootOnce(targetUrl, cfg, p, isLast))
}

/** 百度搜索截图。keyWd 为「列表」时截搜索结果页，否则跳进第一个匹配到的结果 */
async function baiduShoot(weburl, keyWd, cfg, proxy, isLast = true) {
  const puppeteer = require('puppeteer')
  const timeout = (isLast ? cfg.loadTimeout : Math.min(cfg.loadTimeout, 10)) * 1000

  const browser = await puppeteer.launch({headless: true, args: launchArgs(proxy)})
  try {
    const page = await preparePage(browser, cfg)
    let lastResp = await page.goto(weburl, {waitUntil: 'networkidle2', timeout})

    if (keyWd !== '列表') {
      let link = await page.evaluate(kw => {
        const found = [...document.querySelectorAll('.result a')]
          .filter(item => item.innerText && item.innerText.includes(kw))[0]
        return found ? found.href : ''
      }, keyWd)

      if (!link) link = weburl

      // 跳过去之前同样过一遍安全校验，不合法就留在搜索结果页
      const check = await checkUrl(link, cfg)
      if (check.ok) {
        lastResp = await page.goto(check.url, {waitUntil: 'networkidle2', timeout})
      } else {
        logger.warn(`[Guoba] 网页截图搜索结果跳转被拦截 ${link} (${check.reason})`)
      }
    }

    await settle(page, cfg)

    // 跳进去的目标站也可能是登录墙或盾页（百度自己被风控时，标题就是「百度安全验证」）
    if (cfg.skipUnworthy) {
      const bad = await inspectPage(page, lastResp?.status?.() || 0)
      if (bad) throw bad
    }

    return await page.screenshot({fullPage: true})
  } finally {
    await browser.close()
  }
}

/** 百度搜索截图入口 */
export function baiduScreenshot(weburl, keyWd, cfg) {
  return withFallback(cfg, (p, isLast) => baiduShoot(weburl, keyWd, cfg, p, isLast))
}


