#!/usr/bin/env node
import { init } from './init.ts'

const [command, ...args] = process.argv.slice(2)
if (command === 'init') {
  await init(args[0] ?? 'video')
} else if (command === 'record') {
  process.argv = [process.argv[0], process.argv[1], ...args]
  await import('./record.ts')
} else if (command === 'render') {
  process.argv = [process.argv[0], process.argv[1], ...args]
  await import('./render.ts')
} else if (command === 'snap') {
  process.argv = [process.argv[0], process.argv[1], ...args]
  await import('./toolkit/snap.ts')
} else if (command === 'check') {
  process.argv = [process.argv[0], process.argv[1], ...args]
  await import('./toolkit/check.ts')
} else {
  console.log('Usage: project-video <init [dir] | record <config> [clips...] | render <config> [--from=s] [--to=s] [--workers=n] | snap <config> <path> | check <video>>')
  if (command && command !== '--help' && command !== '-h') process.exitCode = 1
}
