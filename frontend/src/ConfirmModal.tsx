import { useState, useEffect } from 'react'

/**
 * Accessibility warning text explaining why paste is disabled on the confirmation input.
 * To ensure users intentionally type the confirmation text rather than copying it,
 * we block pasting, drag-and-drop, autofill, and context-menu entry.
 */
const PASTE_DISABLED_EXPLANATION = 'Paste is disabled for safety; manual typing is required.'

interface Props {
  title: string
  message: string
  confirmText?: string
  /** When set, user must type this exact string to enable the confirm button */
  typeToConfirm?: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * ConfirmModal component displays a confirmation dialog.
 * For high-impact actions, it requires the user to manually type a specific queue/message name.
 * 
 * UX and Security Decision:
 * To prevent accidental confirmations (e.g., from muscle memory or copy-pasting),
 * the input blocks pasting, drag-and-drop, autofill, and context-menu operations.
 * To maintain accessibility, an aria-describedby attribute points to an explanation
 * of this behavior for screen reader users.
 */
export default function ConfirmModal({ title, message, confirmText = 'Confirm', typeToConfirm, onConfirm, onCancel }: Props) {
  const [input, setInput] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const canConfirm = !typeToConfirm || input === typeToConfirm

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        {typeToConfirm && (
          <div className="modal-type-confirm">
            <p>Type <strong>{typeToConfirm}</strong> to confirm:</p>
            <input 
              value={input} 
              onChange={e => setInput(e.target.value)} 
              autoFocus
              onPaste={e => e.preventDefault()}
              onDrop={e => e.preventDefault()}
              onContextMenu={e => e.preventDefault()}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="paste-disabled-explanation"
              placeholder={typeToConfirm} 
            />
            <span id="paste-disabled-explanation" style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              border: 0
            }}>
              {PASTE_DISABLED_EXPLANATION}
            </span>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onConfirm} disabled={!canConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  )
}
