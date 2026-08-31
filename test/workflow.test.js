import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('PowerShell compat URLs delimit the base variable before query strings', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/compat.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /"\$base\?action=/)
  assert.match(workflow, /"\$\{base\}\?action=snapshot"/)
})
