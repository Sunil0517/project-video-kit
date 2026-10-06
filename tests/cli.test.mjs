import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const bin = path.join(root, 'dist/cli.js')

test('init creates a usable project template without overwriting it', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'project-video-test-'))
  const target = path.join(temporary, 'video')
  try {
    execFileSync(process.execPath, [bin, 'init', target])
    assert.ok(existsSync(path.join(target, 'video.config.ts')))
    assert.ok(existsSync(path.join(target, 'compose/index.html')))
    assert.match(readFileSync(path.join(target, 'video.config.ts'), 'utf8'), /compose: '\.\/compose'/)
    assert.throws(() => execFileSync(process.execPath, [bin, 'init', target], { stdio: 'pipe' }))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('CLI reports available commands', () => {
  assert.match(execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8' }), /record.*render.*snap.*check/)
})
