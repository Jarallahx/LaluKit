import { forwardRef, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { Tooltip } from './Tooltip'

// ---------- Button ----------

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ai' | 'ghost' | 'subtle' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', icon, className = '', children, ...rest },
  ref
) {
  return (
    <button ref={ref} className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon && <span className="btn-icon">{icon}</span>}
      {children}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
}

// Icon-only buttons always carry a themed tooltip (400ms delay) built from
// their accessible label; "(X)" suffixes render as keyboard chips.
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, size = 'md', className = '', children, ...rest },
  ref
) {
  return (
    <Tooltip text={label}>
      <button
        ref={ref}
        className={`iconbtn iconbtn-${size} ${active ? 'is-active' : ''} ${className}`}
        aria-label={label}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
})

// ---------- Segmented control with animated thumb ----------

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  tone?: 'accent' | 'ai'
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md', tone = 'accent' }: SegmentedProps<T>): ReactNode {
  // The sliding thumb is pure CSS (translateX between equal-width slots).
  // No framer layout projection here: layoutId nodes inside exiting modals
  // can deadlock AnimatePresence and leave a dead overlay on screen.
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div className={`segmented segmented-${size} segmented-${tone}`} role="radiogroup">
      <span
        className="segment-thumb"
        style={{
          width: `calc((100% - 6px) / ${options.length})`,
          ['--seg-idx' as never]: idx
        } as never}
      />
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={`segment ${value === o.value ? 'is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          <span className="segment-label">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

// ---------- Toggle switch ----------

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: string
}): ReactNode {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}

// ---------- Slider ----------

export function Slider({ value, min, max, step = 1, onChange, width }: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  width?: number
}): ReactNode {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      className="slider"
      style={{ width, ['--pct' as never]: `${pct}%` } as never}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

// ---------- Progress bar ----------

export function ProgressBar({ value, tone = 'accent' }: { value: number | null; tone?: 'accent' | 'ai' }): ReactNode {
  return (
    <div className={`progress progress-${tone} ${value === null ? 'is-indeterminate' : ''}`}>
      <div className="progress-fill" style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }): ReactNode {
  return <span className="spinner" style={{ width: size, height: size }} />
}

// ---------- Kbd ----------

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <kbd className="kbd">{children}</kbd>
}

// ---------- Field (label + control row) ----------

export function Field({ label, hint, children, row }: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  row?: boolean
}): ReactNode {
  return (
    <div className={`field ${row ? 'field-row' : ''}`}>
      <div className="field-head">
        <span className="field-label">{label}</span>
        {row && <div className="field-control">{children}</div>}
      </div>
      {!row && <div className="field-control">{children}</div>}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

// ---------- Modal ----------

// The backdrop is always mounted and toggled with CSS classes, so an
// interrupted close animation can never strand an invisible overlay that
// swallows input (the v1.0 "app freezes after Settings" bug). Only the card
// itself uses AnimatePresence.
export function Modal({ open, onClose, title, children, width = 520, tone }: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  width?: number
  tone?: 'ai'
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  return (
    <div
      className={`modal-backdrop ${open ? 'is-open' : ''}`}
      aria-hidden={!open}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <AnimatePresence>
        {open && (
          <motion.div
            ref={ref}
            className={`modal ${tone === 'ai' ? 'modal-ai' : ''}`}
            style={{ width }}
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.13 } }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          >
            {title && (
              <div className="modal-head">
                <h2 className="modal-title">{title}</h2>
                <IconButton label="Close" size="sm" onClick={onClose}>
                  <X size={15} />
                </IconButton>
              </div>
            )}
            <div className="modal-body">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------- Searchable select ----------

export function SearchSelect({ value, options, onChange, placeholder, width = 220 }: {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  placeholder?: string
  width?: number
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()) || o.value.toLowerCase().includes(query.toLowerCase()))
    : options

  return (
    <div className="sselect" ref={rootRef} style={{ width }}>
      <button className="sselect-trigger" onClick={() => { setOpen((v) => !v); setQuery('') }}>
        <span className="sselect-value">{current?.label ?? value}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" className="sselect-caret"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="sselect-pop"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
          >
            {placeholder !== undefined && (
              <input
                autoFocus
                className="sselect-search"
                placeholder={placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div className="sselect-list">
              {filtered.map((o) => (
                <button
                  key={o.value}
                  className={`sselect-item ${o.value === value ? 'is-on' : ''}`}
                  onClick={() => { onChange(o.value); setOpen(false) }}
                >
                  {o.label}
                </button>
              ))}
              {filtered.length === 0 && <div className="sselect-empty">—</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---------- Dots rating (model speed/quality) ----------

export function Dots({ n, tone = 'accent' }: { n: number; tone?: 'accent' | 'ai' }): ReactNode {
  return (
    <span className={`dots dots-${tone}`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`dot ${i <= n ? 'is-on' : ''}`} />
      ))}
    </span>
  )
}
