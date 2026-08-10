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

}
