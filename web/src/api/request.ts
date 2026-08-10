import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { message } from 'ant-design-vue'
import { API_BASE, TOKEN_KEY } from '@/utils/env'

/** 后端统一返回结构，见 framework/src/components/Result.js 的 toJSON() */
export interface ApiResult<T = any> {
  ok: boolean
  code: number
  result: T
  message: string
}

export interface RequestOptions {
  /** 失败时是否自动弹出错误提示，默认 true */
  showError?: boolean
  /** 成功时是否自动弹出后端返回的 message，默认 false */
  showSuccess?: boolean
  /** 为 true 时返回完整 ApiResult，而不是只取 result */
  raw?: boolean
}

const http = axios.create({
  baseURL: API_BASE,
  timeout: 60_000,
})

/** token 由 auth store 注入，避免此处直接依赖 store 造成循环引用 */
let tokenGetter: () => string | undefined = () => undefined
/** 401 处理回调，由 store 注册 */
let unauthorizedHandler: () => void = () => undefined

export function setTokenGetter(fn: () => string | undefined) {
  tokenGetter = fn
}

export function setUnauthorizedHandler(fn: () => void) {
  unauthorizedHandler = fn
}

http.interceptors.request.use((config) => {
  const token = tokenGetter()
  if (token) {
    config.headers.set(TOKEN_KEY, token)
  }
  return config
})

http.interceptors.response.use(
  (resp) => resp,
  (error) => {
    // 401 统一跳登录，其余错误交给调用方处理
    if (error?.response?.status === 401) {
      unauthorizedHandler()
      return Promise.reject(new Error('登录已失效，请重新登录'))
    }
    return Promise.reject(error)
  },
)

/** 带 HTTP 状态码的请求异常，调用方可据此区分 404（如接口未注册）等情况 */
export class ApiError extends Error {
  status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** 从各种异常里提炼出可展示的文案 */
function normalizeError(error: any): string {
  const data = error?.response?.data
  if (data && typeof data === 'object' && typeof data.message === 'string') {
    return data.message
  }
  if (error?.code === 'ECONNABORTED') return '请求超时，请稍后重试'
  if (error?.response?.status === 404) return '接口不存在（404）'
  return error?.message || '请求失败'
}

export async function request<T = any>(
  config: AxiosRequestConfig,
  options: RequestOptions = {},
): Promise<T> {
  const { showError = true, showSuccess = false, raw = false } = options
  try {
    const resp: AxiosResponse<ApiResult<T>> = await http.request(config)
    const data = resp.data
    // 少数接口（如直接 sendFile）不返回标准结构，原样透出
    if (!data || typeof data !== 'object' || !('ok' in data)) {
      return data as unknown as T
    }
    if (!data.ok) {
      throw new ApiError(data.message || '请求失败', resp.status)
    }
    if (showSuccess && data.message && data.message !== 'ok') {
      message.success(data.message)
    }
    return (raw ? data : data.result) as T
  } catch (error: any) {
    const text = normalizeError(error)
    if (showError) {
      message.error(text)
    }
    throw new ApiError(text, error?.status ?? error?.response?.status)
  }
}

export const get = <T = any>(url: string, params?: any, options?: RequestOptions) =>
  request<T>({ url, method: 'get', params }, options)

export const post = <T = any>(url: string, data?: any, options?: RequestOptions) =>
  request<T>({ url, method: 'post', data }, options)

export const put = <T = any>(url: string, data?: any, options?: RequestOptions) =>
  request<T>({ url, method: 'put', data }, options)

export const del = <T = any>(url: string, data?: any, options?: RequestOptions) =>
  request<T>({ url, method: 'delete', data }, options)

export default http
