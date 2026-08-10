import type { InjectionKey, Ref } from 'vue'

/**
 * schema 表单的上下文。
 *
 * GButtons 这类组件需要读取整张表单的当前值（用于 `#{field}` 插值），
 * 以及当前插件名（用于调用 /plugin/do/:name/action），
 * 通过 provide/inject 传递，避免层层透传 props。
 */

/** 当前表单的数据模型，由 SchemaForm 提供 */
export const FORM_MODEL_KEY: InjectionKey<Ref<Record<string, any>>> = Symbol('gFormModel')

/** 当前插件名，由插件详情页提供；配置管理页没有插件上下文 */
export const PLUGIN_NAME_KEY: InjectionKey<Ref<string>> = Symbol('gPluginName')
