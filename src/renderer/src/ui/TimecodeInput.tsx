import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fmtTC, parseTC } from '@/lib/time'

// Monospace timecode field: free-form entry, validates on commit, shakes and
// reverts on bad input.
export function TimecodeInput({ value, onCommit, max, className = '' }: {
  value: number
  onCommit: (v: number) => void
  max?: number
  className?: string
}): ReactNode {
  const [text, setText] = useState(fmtTC(value))
  const [editing, setEditing] = useState(false)
  const [bad, setBad] = useState(false)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setText(fmtTC(value))
  }, [value, editing])

  const commit = (): void => {
    const parsed = parseTC(text)
    if (parsed === null || (max !== undefined && parsed > max + 0.001)) {
      setBad(true)
      window.setTimeout(() => setBad(false), 350)
      setText(fmtTC(value))
    } else if (Math.abs(parsed - value) > 0.0005) {
      onCommit(parsed)
      setText(fmtTC(parsed))
    }
    setEditing(false)
    ref.current?.blur()
  }

  return (
    <input
      ref={ref}
      className={`tc-input mono force-ltr ${bad ? 'is-bad' : ''} ${className}`}
      value={text}
      spellCheck={false}
      onFocus={(e) => { setEditing(true); e.target.select() }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') { setText(fmtTC(value)); setEditing(false); ref.current?.blur() }
      }}
    />
  )
}
