import http from './request'

/**
 * 老锅巴的 defHttp 兼容层。
 *
 * 插件的自定义组件里写的是 `defHttp.post({url, params}, {isTransformResponse: false})`：
 * url 是相对 API 根的路径、params 是请求体、拿到的是完整的 `{ok, code, result, message}`。
 * 这里直接走面板的 axios 实例，登录令牌与二级密码凭证都会自动带上。
 */
export const defHttp = {
  async post(config: { url: string; params?: any }, _options?: { isTransformResponse?: boolean }) {
    try {
      const resp = await http.request({
        url: config?.url,
        method: 'post',
        data: config?.params,
      })
      return resp.data
    } catch (error: any) {
      // 401/403 由全局拦截器负责跳转与提示，这里把后端返回体原样交给组件判断
      return error?.response?.data ?? { ok: false, code: -1, message: error?.message || '请求失败' }
    }
  },
  async get(config: { url: string; params?: any }, _options?: { isTransformResponse?: boolean }) {
    try {
      const resp = await http.request({
        url: config?.url,
        method: 'get',
        params: config?.params,
      })
      return resp.data
    } catch (error: any) {
      return error?.response?.data ?? { ok: false, code: -1, message: error?.message || '请求失败' }
    }
  },
}
