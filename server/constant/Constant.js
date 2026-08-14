/**
 * 一些公用常量
 */
export default {
  // header中传递的TokenKey
  TOKEN_KEY: 'guoba-access-token',

  // 弱令牌的Cookie名。自定义页面用 iframe 嵌插件的 HTML，
  // 里面的 css/js 是浏览器按相对路径直接请求的，带不上请求头和query，只能靠Cookie
  LITE_TOKEN_COOKIE: 'guoba-lite-token',

  // redis前缀
  REDIS_PREFIX: 'Yz:Guoba:',

  LOGIN_CAPTCHA_TTL: 300,
  LOGIN_CAPTCHA_COOLDOWN: 60,
  LOGIN_CAPTCHA_MAX_ATTEMPTS: 5,
  LOGIN_CAPTCHA_LOCK_TTL: 900,
  LOGIN_PASSWORD_MAX_ATTEMPTS: 10,
  LOGIN_PASSWORD_LOCK_TTL: 900,
  LOGIN_CAPTCHA_GLOBAL_LIMIT: 20,

  // 可信设备：浏览器里存一份长期凭证，换了IP也不用再走验证码
  // （手机流量的IPv6会漂移，只认IP的话验证码会没完没了）
  DEVICE_ID_HEADER: 'x-guoba-device-id',
  DEVICE_SECRET_HEADER: 'x-guoba-device-secret',
  // 指纹只用于展示与审计，不参与放行判定
  DEVICE_FP_HEADER: 'x-guoba-device-fp',
  DEVICE_INFO_HEADER: 'x-guoba-device-info',
  // 凭证有效期（秒），按“最后使用时间”算
  TRUSTED_DEVICE_TTL: 90 * 24 * 3600,
  // 最多记住几台，超了淘汰最久没用的
  TRUSTED_DEVICE_MAX: 10,
  // 最后使用时间的写盘节流（毫秒），配置是yaml文件，没必要每次请求都写
  TRUSTED_DEVICE_TOUCH_GAP: 3600 * 1000,

}
