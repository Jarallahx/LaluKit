import { cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Themed tooltip with a 400ms hover delay. Labels like "Mark in (I)" render
// the parenthesised part as a keyboard chip.
export function Tooltip({ text, children }: { text: string; children: ReactElement }): ReactNode {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<number | null>(null)
  const anchor = useRef<HTMLElement | null>(null)

  const clear = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    setPos(null)
  }

  useEffect(() => clear, [])

  const onEnter = (e: React.MouseEvent): void => {
    anchor.current = e.currentTarget as HTMLElement
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const el = anchor.current
      if (!el || !el.isConnected) return
      const r = el.getBoundingClientRect()
      setPos({ x: r.x + r.width / 2, y: r.bottom + 7 })
    }, 400)
  }

  const m = /^(.*?)\s*\(([^)]{1,14})\)\s*$/.exec(text)
  const label = m ? m[1] : text
  const kbd = m ? m[2] : null

  const child = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent) => {
      onEnter(e)
      ;(children.props as { onMouseEnter?: (e: React.MouseEvent) => void }).onMouseEnter?.(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      clear()
      ;(children.props as { onMouseLeave?: (e: React.MouseEvent) => void }).onMouseLeave?.(e)
    },
    onMouseDown: (e: React.MouseEvent) => {
      clear()
      ;(children.props as { onMouseDown?: (e: React.MouseEvent) => void }).onMouseDown?.(e)
    }
  } as never)

  return (
    <>
      {child}
      {pos !== null &&
        createPortal(
          <span className="tooltip" style={{ left: pos.x, top: pos.y }} role="tooltip">
            {label}
            {kbd && <kbd className="tooltip-kbd">{kbd}</kbd>}
          </span>,
          document.body
        )}
    </>
  )
}
