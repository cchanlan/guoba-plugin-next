/**
 * 发送失败原因的翻译。
 *
 * 适配器抛上来的原文是给开发者看的（一整条 URL + 错误码 + 英文 stack），面板上直接弹这个
 * 没人看得懂。这里把最常撞到的几种翻成人话，并给出下一步该怎么做。
 *
 * 重点是官方 QQ 机器人（官bot）的**主动消息限制**：官方把消息分成「被动」（回复用户某条
 * 消息，带上它的 msg_id）和「主动」（bot 自己发起）。被动消息在用户发言后的窗口期内可以
 * 直接发；主动消息要单独申请权限，没有就报 40034105：
 *
 *   request "/v2/groups/xxx/messages" error with code(40034105): 主动消息失败, 无权限
 *
 * 面板里点发送默认就是主动消息，所以官bot 在面板里发不出去是常态，不是锅巴坏了。而带上
 * 「回复某条消息」会生成 reply 段，QQBot 适配器据此带上 msg_id、走被动消息 —— 这是面板里
 * 能稳定发出去的路子，所以提示要往那儿引导。
 *
 * 判据以官方返回的**中文描述**为主，只有 40034105 是日志实证过的码。原因是错误码表在
 * 各家适配器/官方版本之间并不统一，照猜的码去映射文案，撞上同码不同义就是误导；而返回体里
 * 的中文描述反而稳定。认不出来的错误一律原样透出，宁可看不懂也不能说错。
 */

/**
 * 按顺序匹配，先具体后笼统。
 * test 收的是错误里能读到的全部文字，命中就用这条的 reason/hint。
 */
const RULES = [
  {
    // 频率要放在权限前面：两者的描述里都带「主动消息」
    test: /主动消息[^。]{0,20}(频率|超限|限制|上限|额度)|(频率|超限)[^。]{0,10}主动消息/,
    reason: '官方机器人的「主动消息」条数用完了',
    hint: '官方对主动推送有额度限制，等额度恢复，或改用「回复」发被动消息。',
  },
  {
    // 日志实证：code(40034105): 主动消息失败, 无权限
    test: /\b40034105\b|主动消息[^。]{0,20}(无权限|没有权限|失败)/,
    reason: '官方机器人没有「主动消息」权限',
    hint: '对用户的某条消息点「回复」再发，走被动消息就能发出去；'
      + '要能主动推送得去 QQ 开放平台为该机器人申请主动消息权限。',
  },
  {
    test: /审核|拦截|敏感|违规/,
    reason: '内容被目标平台拦下了',
    hint: '文字或图片命中了内容审核，换个内容再试。',
  },
  {
    test: /rich ?media|富媒体|上传(图片|文件|失败)|upload.{0,20}fail/i,
    reason: '图片/文件上传失败',
    hint: '协议端或官方服务器拉取这个文件失败，换一个再试。',
  },
  {
    test: /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|超时/i,
    reason: '请求超时',
    hint: '协议端没在超时时间内响应，确认它还活着再试。',
  },
  {
    test: /ECONNREFUSED|ECONNRESET|socket hang up|not connected|未连接/i,
    reason: '连不上协议端',
    hint: '协议端可能已经掉线，检查它的运行状态。',
  },
  {
    test: /风控|禁言|freeze|banned|not in the group|不在群/i,
    reason: '被目标平台拒绝',
    hint: '账号可能被风控、禁言，或已经不在这个会话里了。',
  },
  {
    // 兜底的权限类：上面几条都没命中，但确实是权限问题
    test: /无权限|没有权限|no permission|forbidden|403/i,
    reason: '没有发送权限',
    hint: '确认这个账号在该会话有发言权限；官bot 请改用「回复」发被动消息。',
  },
]

/** 官方错误码，附在提示末尾方便对着文档查 */
const CODE_RE = /code[")\s]*[(:=\s]\s*"?(\d{3,10})"?/i

/** 把错误对象里能读到的文字都抠出来，错误码常常只在 message 里 */
function errText(err) {
  if (err == null) return ''
  if (typeof err === 'string') return err
  const parts = [err.message, err.msg, err.code, err.reason]
    .filter((i) => i != null && i !== '')
    .map(String)
  if (parts.length) return parts.join(' ')
  try {
    return String(err)
  } catch {
    return ''
  }
}

/**
 * 生成给面板用户看的发送失败提示。
 *
 * 认得出的：一句「为什么 + 怎么办」，带上官方错误码。原始报错不往提示里塞 ——
 * 调用方已经 logger.error 记了一份，塞进 toast 只会把有用的话顶掉（手机上尤其明显）。
 * 认不出的：原样透出，信息不丢。
 *
 * @param err 适配器抛出来的错误
 * @return {string}
 */
export function describeSendError(err) {
  const text = errText(err)
  const rule = RULES.find((r) => r.test.test(text))
  if (!rule) {
    return `发送失败：${text || '未知错误'}`
  }
  const code = text.match(CODE_RE)?.[1]
  return `发送失败：${rule.reason}${code ? `（错误码 ${code}）` : ''}。${rule.hint}`
}

/** 是不是官bot 的主动消息权限问题，调用方想单独处理时用 */
export function isActiveMsgDenied(err) {
  return /\b40034105\b|主动消息[^。]{0,20}(无权限|没有权限|失败)/.test(errText(err))
}
