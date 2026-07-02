// Bridges the <video> element with the rest of the app without dragging the
// React tree through 60 Hz updates. Time listeners receive rAF-rate ticks and
// write straight to the DOM (playhead, timecode readouts).

type TimeListener = (t: number) => void

class PlayerController {
  private video: HTMLVideoElement | null = null
  private listeners = new Set<TimeListener>()
  private raf = 0
  private shuttleTimer: number | null = null
  fps = 30
  shuttleRate = 0 // negative = backwards; 0 = no shuttle

  attach(video: HTMLVideoElement, fps: number): void {
    this.video = video
    this.fps = fps > 0 ? fps : 30
    this.stopShuttle()
    cancelAnimationFrame(this.raf)
    const tick = (): void => {
      if (this.video) this.emit(this.video.currentTime)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  detach(): void {
    cancelAnimationFrame(this.raf)
    this.stopShuttle()
    this.video = null
  }

  onTime(fn: TimeListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(t: number): void {
    for (const fn of this.listeners) fn(t)
  }

  get currentTime(): number {
    return this.video?.currentTime ?? 0
  }

  get duration(): number {
    return this.video?.duration ?? 0
  }

  get paused(): boolean {
    return this.video?.paused ?? true
  }

  seek(t: number): void {
    if (!this.video) return
    const d = Number.isFinite(this.video.duration) ? this.video.duration : t
    this.video.currentTime = Math.max(0, Math.min(t, Math.max(0, d - 0.001)))
    this.emit(this.video.currentTime)
  }

  play(): void {
    this.stopShuttle()
    void this.video?.play().catch(() => {})
  }

  pause(): void {
    this.stopShuttle()
    this.video?.pause()
  }

  toggle(): void {
    if (!this.video) return
    if (this.shuttleRate !== 0) { this.pause(); return }
    if (this.video.paused) this.play()
    else this.pause()
  }

  setRate(rate: number): void {
    if (this.video) this.video.playbackRate = rate
  }

  // Forward shuttle uses native playbackRate (1 -> 2 -> 4); backwards shuttle
  // steps currentTime on a timer since HTML video can't reverse-play.
  shuttleForward(): void {
    if (!this.video) return
    if (this.shuttleRate < 0) this.stopShuttle()
    const next = this.shuttleRate >= 1 ? (this.shuttleRate >= 4 ? 1 : this.shuttleRate * 2) : 1
    this.shuttleRate = next
    this.video.playbackRate = next
    void this.video.play().catch(() => {})
    this.notifyShuttle?.(next)
  }

  shuttleBack(): void {
    if (!this.video) return
    this.video.pause()
    this.video.playbackRate = 1
    const next = this.shuttleRate <= -1 ? (this.shuttleRate <= -4 ? -1 : this.shuttleRate * 2) : -1
    this.shuttleRate = next
    this.notifyShuttle?.(next)
    if (this.shuttleTimer !== null) window.clearInterval(this.shuttleTimer)
    this.shuttleTimer = window.setInterval(() => {
      if (!this.video) return
      const step = Math.abs(this.shuttleRate) * (1 / 30)
      const t = this.video.currentTime - step
      this.video.currentTime = Math.max(0, t)
      if (t <= 0) this.stopShuttle()
    }, 33)
  }

  stopShuttle(): void {
    if (this.shuttleTimer !== null) {
      window.clearInterval(this.shuttleTimer)
      this.shuttleTimer = null
    }
    if (this.shuttleRate !== 0) {
      this.shuttleRate = 0
      if (this.video) this.video.playbackRate = 1
      this.notifyShuttle?.(0)
    }
  }

  stepFrames(n: number): void {
    if (!this.video) return
    this.pause()
    const frame = Math.round(this.video.currentTime * this.fps) + n
    // Land slightly inside the frame to dodge boundary rounding.
    this.seek(frame / this.fps + 0.0001)
  }

  // UI badge subscription for shuttle speed changes.
  notifyShuttle: ((rate: number) => void) | null = null
}

export const playerCtl = new PlayerController()
