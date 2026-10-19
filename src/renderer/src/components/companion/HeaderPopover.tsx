import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'

/**
 * An icon button in the Assistant's control row that opens a small non-modal panel under it, so tips and
 * options take no rows of their own. Outside clicks and Esc close it. While open it is marked like other
 * open popups (role="dialog", data-state="open"), so focus mode leaves Esc to it.
 */
export function HeaderPopover({ icon, label, title, badge = false, rootProps, panelClassName = '', children }: {
  icon: ReactNode; label: string; title?: string
  /** A small dot on the button: there is something worth opening (an error or a limitation). */
  badge?: boolean
  rootProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>
  panelClassName?: string; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  return <div ref={root} {...rootProps} className={'header-popover' + (rootProps?.className ? ' ' + rootProps.className : '')}
    onKeyDown={event => { if (event.key !== 'Escape' || !open || event.nativeEvent.isComposing) return; event.stopPropagation(); setOpen(false); button.current?.focus() }}>
    <button ref={button} type="button" className="companion-icon-button header-popover-button" aria-label={label} title={title ?? label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {icon}{badge && <i className="header-popover-badge" aria-hidden="true" />}
    </button>
    <div id={id} role="dialog" aria-label={label} data-state={open ? 'open' : 'closed'} hidden={!open} className={'header-popover-panel' + (panelClassName ? ' ' + panelClassName : '')}>{children}</div>
  </div>
}
