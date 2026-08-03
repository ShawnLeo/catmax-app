/**
 * SKILL.md frontmatter 解析。
 *
 * 它读的是**第三方内容**（用户和各种安装器写的技能），所以每条用例的重点都是
 * "读不懂时会不会把整个技能列表带崩"，而不是"YAML 支持得全不全"。
 */
import { parseSkillFrontmatter } from '@shared/skills/frontmatter'
import { describe, expect, test } from 'vitest'

describe('parseSkillFrontmatter', () => {
  test('取出 name 和 description', () => {
    const result = parseSkillFrontmatter(
      `---\nname: lark-base\ndescription: 飞书多维表格\n---\n\n正文\n`,
    )
    expect(result).toEqual({ name: 'lark-base', description: '飞书多维表格' })
  })

  test('剥掉引号', () => {
    expect(parseSkillFrontmatter(`---\nname: "foo"\ndescription: 'bar'\n---\n`)).toEqual({
      name: 'foo',
      description: 'bar',
    })
  })

  test('折叠块拼成一行，字面块保留换行', () => {
    const folded = parseSkillFrontmatter(`---\nname: a\ndescription: >-\n  第一行\n  第二行\n---\n`)
    expect(folded.description).toBe('第一行 第二行')

    const literal = parseSkillFrontmatter(`---\nname: a\ndescription: |\n  第一行\n  第二行\n---\n`)
    expect(literal.description).toBe('第一行\n第二行')
  })

  test('块标量后面的同级 key 仍能被读到', () => {
    // 回归：块标量的"吃到哪停"算错的话，后面的 name 会被吞进 description。
    const result = parseSkillFrontmatter(
      `---\ndescription: |\n  一段说明\nname: after-block\n---\n`,
    )
    expect(result.name).toBe('after-block')
    expect(result.description).toBe('一段说明')
  })

  /*
   * 下面这些都不该抛异常——扫描一个目录时任何一条 SKILL.md 抛出来，
   * 整个技能列表就打不开了，而用户根本不知道是哪一个文件的问题。
   */
  test('没有 frontmatter 时返回空，不抛', () => {
    expect(parseSkillFrontmatter('# 只是一篇 markdown\n')).toEqual({
      name: null,
      description: null,
    })
  })

  test('正文里的 --- 不会被当成 frontmatter', () => {
    expect(parseSkillFrontmatter('前言\n\n---\nname: nope\n---\n')).toEqual({
      name: null,
      description: null,
    })
  })

  test('frontmatter 没有结束标记时返回空', () => {
    expect(parseSkillFrontmatter('---\nname: unterminated\n')).toEqual({
      name: null,
      description: null,
    })
  })

  test('带 BOM 的文件照样能解析', () => {
    // BOM 会顶掉开头的 `---`，不剥的话整份 frontmatter 被当成不存在。
    expect(parseSkillFrontmatter('﻿---\nname: bom\n---\n').name).toBe('bom')
  })

  test('空值当作缺失（调用方好退化成目录名）', () => {
    expect(parseSkillFrontmatter('---\nname:\ndescription:   \n---\n')).toEqual({
      name: null,
      description: null,
    })
  })
})
