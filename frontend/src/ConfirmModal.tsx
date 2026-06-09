import { useState, useEffect } from 'react'

interface Props {
  title: string
  message: string
  confirmText?: string
  /** When set, user must type this exact string to enable the confirm button */
  typeToConfirm?: string
  onConfirm: () => void
  onCancel: () => void
}

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
            <input value={input} onChange={e => setInput(e.target.value)} autoFocus
              onPaste={e => e.preventDefault()}
              placeholder={typeToConfirm} />
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
