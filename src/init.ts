import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function init(directory: string) {
  const target = path.resolve(directory)
  if (existsSync(target)) throw new Error(`${target} already exists. Choose a new directory.`)
  const template = fileURLToPath(new URL('../template/', import.meta.url))
  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(template, target, { recursive: true })
  renameSync(path.join(target, 'video.gitignore'), path.join(target, '.gitignore'))
  console.log(`Created ${target}`)
  console.log(`Edit ${path.join(target, 'video.config.ts')}, then run:`)
  console.log(`  project-video record ${path.join(target, 'video.config.ts')}`)
  console.log(`  project-video render ${path.join(target, 'video.config.ts')}`)
}
