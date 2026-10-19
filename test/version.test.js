// 版本记录。
//
// 三处都带版本号，只有保持一致才有意义：
//   - package.json        npm 发布的内容
//   - lib/shared.js       运行中的面板报告的版本
//   - docs/CHANGELOG.md   publish.yml 从这里截取发布说明
// 前两处不一致会在打标签时让 CI 失败；第三处不一致不会让任何检查失败，只会悄悄
// 发布一段除“Release x.y.z”外没有内容的说明。这个测试让三处都发出声音。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { VERSION } from '../lib/shared.js'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

test('VERSION stays in lockstep with package.json', () => {
  assert.equal(VERSION, JSON.parse(read('../package.json')).version)
})

test('both CHANGELOGs contain the version being shipped', () => {
  // 只要求存在，不要求位置：publish.yml 从匹配 PKG_VERSION 的标题开始收集，因此
  // 在它上面放一个 `## Unreleased` 节没有影响。真正会破坏发布的是完全没有匹配
  // 的节，发布说明会是空的。
  const heading = new RegExp(`^## ${VERSION.replace(/\./g, '\\.')}(\\s|$)`)
  for (const file of ['../docs/CHANGELOG.md', '../docs/CHANGELOG.en.md']) {
    const sections = read(file).split('\n').filter((line) => line.startsWith('## '))
    assert.ok(
      sections.some((line) => heading.test(line)),
      `${file} has no ${VERSION} section; publish.yml would cut empty release notes`
    )
  }
})
