import test from 'node:test'
import assert from 'node:assert/strict'
import {parseChangelog, parseGitLog} from '../../components/Changelog.js'

test('解析带日期的完整更新列表并保留顺序', () => {
  const logs = parseChangelog(`# Fork 更新记录

* [2026-08-19 12:30:00] feat：新增功能
* [2026-08-18 08:00:00] fix：修复问题`)

  assert.deepEqual(logs, [
    {date: '2026-08-19 12:30:00', version: '', message: 'feat：新增功能'},
    {date: '2026-08-18 08:00:00', version: '', message: 'fix：修复问题'},
  ])
})

test('版本标题可为没有日期的条目提供版本信息', () => {
  const logs = parseChangelog(`# 1.4.2

* 新增功能
* 修复问题`)

  assert.equal(logs.length, 2)
  assert.equal(logs[0].version, '1.4.2')
  assert.equal(logs[1].message, '修复问题')
})

test('Markdown 标记转成聊天可读纯文本', () => {
  const [log] = parseChangelog('* [2026-08-19] 新增 `#锅巴更新日志`，详见 [文档](https://example.com)')
  assert.equal(log.date, '2026-08-19')
  assert.equal(log.message, '新增 #锅巴更新日志，详见 文档（https://example.com）')
})

test('空内容与普通正文安全返回空数组', () => {
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog('# 说明\n普通正文'), [])
})

test('解析 Git 日志时间和提交说明', () => {
  const logs = parseGitLog([
    '2026-08-18T21:01:30+08:00\tfeat(备份): 新增功能',
    '2026-08-19T00:23:48Z\tfix: 修复问题',
  ].join('\n'))

  assert.deepEqual(logs, [
    {date: '2026-08-18 21:01:30', version: '', message: 'feat(备份): 新增功能'},
    {date: '2026-08-19 00:23:48', version: '', message: 'fix: 修复问题'},
  ])
})

test('Git 日志空行和缺少时间的记录可安全处理', () => {
  assert.deepEqual(parseGitLog('\n修复说明\n'), [
    {date: '', version: '', message: '修复说明'},
  ])
})
