import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  ChevronFirst, ChevronLast, CornerDownLeft, CornerDownRight,
  Music2, Pause, Play, Volume2, VolumeX, FastForward, Rewind
} from 'lucide-react'
import { useStore } from '@/state/store'
import { useT } from '@/i18n'
import { playerCtl } from '@/lib/player-ctl'
import { fmtTC } from '@/lib/time'
import { IconButton, ProgressBar, Slider } from '@/ui/primitives'
import { SubtitleOverlay } from './SubtitleOverlay'
import { CropGuide } from './CropGuide'

export function Player(): ReactNode {
  const t = useT()
  const media = useStore((s) => s.media)
  const playbackUrl = useStore((s) => s.playbackUrl)
  const proxyJobId = useStore((s) => s.proxyJobId)
  const proxyProgress = useStore((s) => s.proxyProgress)
  const playing = useStore((s) => s.playing)
  const setPlaying = useStore((s) => s.setPlaying)
  const shuttleRate = useStore((s) => s.shuttleRate)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const patchSettings = useStore((s) => s.patchSettings)
  const retryViaProxy = useStore((s) => s.retryPlaybackViaProxy)
  const markIn = useStore((s) => s.markIn)
  const markOut = useStore((s) => s.markOut)

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const tcRef = useRef<HTMLSpanElement>(null)
  const frameRef = useRef<HTMLSpanElement>(null)
  const [flash, setFlash] = useState<'play' | 'pause' | null>(null)

  const fps = media?.video?.fps ?? 30
  const isAudio = media?.kind === 'audio'

  // Attach the controller whenever a new element/url mounts.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !playbackUrl) return
    playerCtl.attach(v, fps)
    v.volume = volume
    v.muted = muted
    return () => playerCtl.detach()
    // volume/muted intentionally applied in their own effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackUrl, fps])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [volume, muted])

  // Direct DOM timecode updates at rAF rate — no React re-renders.
  useEffect(() => {
    return playerCtl.onTime((time) => {
      if (tcRef.current) tcRef.current.textContent = fmtTC(time)
      if (frameRef.current) frameRef.current.textContent = `F ${Math.round(time * fps)}`
    })
  }, [fps])

  const togglePlay = useCallback(() => {
    playerCtl.toggle()
  }, [])

  const onVideoClick = (): void => {
    togglePlay()
  }

  useEffect(() => {
    if (!playing && shuttleRate === 0) return
    setFlash(playing ? 'play' : 'pause')
    const id = window.setTimeout(() => setFlash(null), 420)
    return () => window.clearTimeout(id)
  }, [playing, shuttleRate])

  if (!media) return null

  return (
    <div className="player">
      <div className={`player-stage ${isAudio ? 'is-audio' : ''}`} ref={stageRef}>
        {playbackUrl ? (
          <>
            <video
              key={playbackUrl}
              ref={videoRef}
              className="player-video"
              src={playbackUrl}
              onClick={onVideoClick}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onError={(e) => {
                const err = (e.target as HTMLVideoElement).error
                console.warn(`video element error code=${err?.code} msg="${err?.message ?? ''}" mode=${media.playback.mode}`)
                if (media.playback.mode === 'direct') void retryViaProxy()
              }}
              playsInline
            />
            {isAudio && (
              <div className="player-audio-banner" onClick={onVideoClick}>
                <Music2 size={42} strokeWidth={1.4} />
                <span>{t('player.audioOnly')}</span>
              </div>
            )}
            <SubtitleOverlay stageRef={stageRef} />
            <CropGuide stageRef={stageRef} />
            <AnimatePresence>
              {flash && (
                <motion.div
                  className="player-flash"
                  initial={{ opacity: 0.9, scale: 0.7 }}
                  animate={{ opacity: 0, scale: 1.15 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.45 }}
                >
                  {flash === 'play' ? <Play size={34} fill="currentColor" /> : <Pause size={34} fill="currentColor" />}
                </motion.div>
              )}
            </AnimatePresence>
            {shuttleRate !== 0 && (
              <div className="player-shuttle-badge mono force-ltr">
                {shuttleRate < 0 ? <Rewind size={13} /> : <FastForward size={13} />}
                {Math.abs(shuttleRate)}×
              </div>
            )}
          </>
        ) : (
          <div className="player-loading">
            <div className="player-loading-inner">
              <span className="player-loading-title">{t('player.preparing')}</span>
              {proxyJobId && <ProgressBar value={proxyProgress} />}
              <span className="player-loading-hint">{t('player.preparingHint')}</span>
            </div>
          </div>
        )}
      </div>

      <div className="player-controls force-ltr">
        <span className="player-tc mono" ref={tcRef}>0:00.000</span>
        <span className="player-frame mono" ref={frameRef}>F 0</span>

        <div className="player-transport">
          <IconButton label={t('player.stepBack')} onClick={() => playerCtl.stepFrames(-1)}>
            <ChevronFirst size={17} />
          </IconButton>
          <button
            className="player-play"
            onClick={togglePlay}
            title={playing ? t('player.pause') : t('player.play')}
          >
            {playing || shuttleRate > 0 ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" style={{ marginInlineStart: 2 }} />}
          </button>
          <IconButton label={t('player.stepFwd')} onClick={() => playerCtl.stepFrames(1)}>
            <ChevronLast size={17} />
          </IconButton>
        </div>

        <div className="player-marks">
          <IconButton label={t('player.markIn')} onClick={() => markIn(playerCtl.currentTime)}>
            <CornerDownRight size={15} />
          </IconButton>
          <IconButton label={t('player.markOut')} onClick={() => markOut(playerCtl.currentTime)}>
            <CornerDownLeft size={15} />
          </IconButton>
        </div>

        <div className="player-right">
          <span className="player-dur mono">{fmtTC(media.durationSec)}</span>
          <IconButton
            label={muted ? t('player.unmute') : t('player.mute')}
            onClick={() => patchSettings({ muted: !muted })}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </IconButton>
          <Slider value={muted ? 0 : volume} min={0} max={1} step={0.02} width={74}
            onChange={(v) => patchSettings({ volume: v, muted: v === 0 })} />
        </div>
      </div>
    </div>
  )
}
