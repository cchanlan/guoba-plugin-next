import { get, set, unset } from 'lodash-es'
import type { FormSchema } from '@/types'

/**
 * 后端对纯数字的 key 会加此前缀，因为前端表单 field 不能是纯数字。
 * 见 framework/src/components/YamlReader.js 的 CONFIG_INTEGER_KEY。
 */
export const CONFIG_INTEGER_KEY = 'INTEGER__'

/** 分组起始标记，schema 里用它把后续字段归入一个新分组 */
export const GROUP_BEGIN = 'SOFT_GROUP_BEGIN'

/** 不绑定数据、只做展示的组件 */
export const DISPLAY_ONLY_COMPONENTS = new Set(['Divider', GROUP_BEGIN])

export interface SchemaGroup {
  /** 分组名，未分组时为空 */
  title: string
  schemas: FormSchema[]
}

/**
 * 把扁平 schema 列表按 SOFT_GROUP_BEGIN 切成若干分组。
 * 第一个标记之前的字段（如果有）归入一个无名分组。
 */
export function splitGroups(schemas: FormSchema[]): SchemaGroup[] {
  const groups: SchemaGroup[] = []
  let current: SchemaGroup = { title: '', schemas: [] }

  for (const schema of schemas ?? []) {
    if (schema.component === GROUP_BEGIN) {
      // 遇到新分组标记：把已积累的内容收进结果
      if (current.schemas.length) groups.push(current)
      current = { title: schema.label ?? '', schemas: [] }
      continue
    }
    current.schemas.push(schema)
  }
  if (current.schemas.length) groups.push(current)

  return groups
}

/** schema 里是否存在分组标记 */
export function hasGroups(schemas: FormSchema[]): boolean {
  return (schemas ?? []).some((s) => s.component === GROUP_BEGIN)
}

/** 读取嵌套字段值，field 支持 a.b.c */
export function getFieldValue(model: any, field?: string): any {
  if (!field) return undefined
  return get(model, field)
}

/** 写入嵌套字段值 */
export function setFieldValue(model: any, field: string, value: any): void {
  set(model, field, value)
}

/**
 * 按 schema 收集表单初始值。
 * 数据里没有的字段用 defaultValue 兜底，保证 v-model 有稳定引用。
 *
 * 另外会补齐嵌套字段的父级对象：antd 的 FormItem 用 strict 模式解析 name 路径，
 * 父级是 null/undefined 时会报 "please transfer a valid name path to form item!"。
 * 实际配置里就有这种情况（如 config.yaml 里 `https: null`，而 schema 有 https.url）。
 * 被补出来的父级路径记录在返回值上，保存时若仍是空对象则还原，避免把 null 改写成 {}。
 */
export const MATERIALIZED_PATHS = Symbol('gMaterializedPaths')

export function buildFormModel(schemas: FormSchema[], data: any): Record<string, any> {
  const model: Record<string, any> = structuredCloneSafe(data ?? {})
  const materialized: string[] = []

  for (const schema of schemas ?? []) {
    if (!schema.field || DISPLAY_ONLY_COMPONENTS.has(schema.component ?? '')) continue

    const existing = get(model, schema.field)
    if (existing === undefined && schema.defaultValue !== undefined) {
      set(model, schema.field, structuredCloneSafe(schema.defaultValue))
    }

    // 逐级补齐父对象
    const parts = schema.field.split('.')
    if (parts.length < 2) continue
    let cursor: any = model
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('.')
      const value = cursor?.[parts[i]]
      if (value == null) {
        set(model, path, {})
        materialized.push(path)
      } else if (typeof value !== 'object') {
        // 父级是标量，说明 schema 与实际数据结构不一致，不动它
        break
      }
      cursor = get(model, path)
      if (cursor == null || typeof cursor !== 'object') break
    }
  }

  Object.defineProperty(model, MATERIALIZED_PATHS, {
    value: materialized,
    enumerable: false,
    configurable: true,
  })
  return model
}

/**
 * 保存前还原「只为渲染而补出来的空父级」。
 * 用户真填了内容就保留，什么都没填则恢复成原始值（通常是 null），
 * 原始数据里压根没有这个键时直接删掉。
 */
export function pruneMaterialized(
  values: Record<string, any>,
  model: Record<string, any>,
  original: any,
): Record<string, any> {
  const paths: string[] = (model as any)?.[MATERIALIZED_PATHS] ?? []
  // 先长后短，避免删了外层导致内层判断失真
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const current = get(values, path)
    if (!current || typeof current !== 'object' || Object.keys(current).length) continue
    const originalValue = get(original ?? {}, path)
    if (originalValue === undefined) {
      unset(values, path)
    } else {
      set(values, path, originalValue)
    }
  }
  return values
}

/** structuredClone 在旧环境可能缺失，这里做一次降级 */
export function structuredCloneSafe<T>(value: T): T {
  if (value === undefined || value === null) return value
  try {
    if (typeof structuredClone === 'function') return structuredClone(value)
  } catch {
    // 含不可克隆内容时退回 JSON
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

/**
 * 规范化一组校验规则。
 *
 * 两件事：
 *  1. 拍平嵌套数组。锅巴自带配置里就有 `rules: [{...}, [{min: 5}]]` 这种写法
 *     （见 model/useMiaoConfig.js 的 addGroupPromptProps），直接交给 antd 会报错。
 *  2. 把字符串形式的 pattern 转成 RegExp。
 */
export function normalizeRules(rules: any): any[] {
  const flat = (Array.isArray(rules) ? rules : []).flat(Infinity)
  const result: any[] = []

  for (const rule of flat) {
    if (!rule || typeof rule !== 'object') continue
    const next: any = { ...rule }
    if (typeof next.pattern === 'string') {
      try {
        next.pattern = new RegExp(next.pattern)
      } catch {
        // 正则非法就丢掉这条，避免整个表单校验崩掉
        delete next.pattern
      }
    }
    result.push(next)
  }

  return result
}

/**
 * 把 schema.rules 转成 antd 可用的规则。
 */
export function toAntdRules(schema: FormSchema): any[] {
  const rules: any[] = []

  if (schema.required) {
    rules.push({
      required: true,
      message: `${schema.label ?? '该项'}不能为空`,
    })
  }

  rules.push(...normalizeRules(schema.rules))

  return rules
}

/**
 * 求值卡片标题里的模板表达式。
 *
 * 后端会下发形如
 *   `{{ form.key === 'default' ? '默认配置' : '群：' + form.key }}`
 * 的标题（见 server/service/v3/config/model/useConfig.js）。
 *
 * 这里用 new Function 在受控作用域里求值：表达式来源是本机后端与本地插件的
 * 配置声明，且只暴露 form 一个变量。求值失败时回退为原始字符串。
 */
export function evalTitleTemplate(title: string, form: any): string {
  if (!title || !title.includes('{{')) return title ?? ''
  return title.replace(/\{\{([\s\S]+?)\}\}/g, (_match, expr: string) => {
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('form', `"use strict"; return (${expr});`)
      const result = fn(form)
      return result == null ? '' : String(result)
    } catch {
      return ''
    }
  })
}

/** 还原后端加过前缀的数字 key，仅用于展示 */
export function displayKey(key: string): string {
  return key?.startsWith(CONFIG_INTEGER_KEY) ? key.slice(CONFIG_INTEGER_KEY.length) : key
}
