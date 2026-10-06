const footage = document.getElementById('footage')
const caption = document.getElementById('caption')
let data
let currentClip

window.__setup = async input => {
  data = input
  return true
}

window.__seek = async time => {
  const beat = Object.values(data.beats).find(item => time >= item.start && time < item.end)
    ?? Object.values(data.beats).at(-1)
  if (!beat) return true
  const clip = data.clips[beat.clip]
  caption.textContent = beat.narration
  if (!clip) {
    footage.style.display = 'none'
    return true
  }
  footage.style.display = ''
  if (currentClip !== beat.clip) {
    currentClip = beat.clip
    footage.src = clip.src
    await new Promise((resolve, reject) => {
      footage.addEventListener('loadedmetadata', resolve, { once: true })
      footage.addEventListener('error', reject, { once: true })
    })
  }
  const target = Math.min(Math.max(0, time - beat.start), Math.max(0, footage.duration - 1 / data.fps))
  if (Math.abs(footage.currentTime - target) > 0.01) {
    await new Promise(resolve => {
      footage.addEventListener('seeked', resolve, { once: true })
      footage.currentTime = target
    })
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  return true
}
