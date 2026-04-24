import {useCallback, useEffect, useState} from 'react'
import {api} from './api'
import Dashboard from './Dashboard'
import ConfirmModal from './ConfirmModal'

interface Queue {
  name: string
  url: string
  attributes: Record<string, string>
  dlqName?: string
  isDeadLetterQueue?: boolean
}

interface Message {
  MessageId: string
  Body: string
  ReceiptHandle: string
  Attributes?: Record<string, string>
  MD5OfBody?: string
}

interface EditMsgState {
  original: Message
  body: string
  groupId?: string
  dedupId?: string
}

interface ConfirmState {
  title: string
  message: string
  confirmText: string
  typeToConfirm?: string
  onConfirm: () => void
}

type View = 'dashboard' | 'queue'

export default function App({ onLogout }: { onLogout?: () => void }) {
  const [view, setView] = useState<View>('dashboard')
  const [queues, setQueues] = useState<Queue[]>([])
  const [selected, setSelected] = useState<Queue | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [newQueueName, setNewQueueName] = useState('')
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [msgBody, setMsgBody] = useState('')
  const [msgGroupId, setMsgGroupId] = useState('')
  const [msgDedup, setMsgDedup] = useState('')
  const [delaySeconds, setDelaySeconds] = useState('')
  const [editAttrs, setEditAttrs] = useState<Record<string, string>>({})
  const [batchJson, setBatchJson] = useState('')
  const [moveTarget, setMoveTarget] = useState('')
  const [filterText, setFilterText] = useState('')
  const [confirmModal, setConfirmModal] = useState<ConfirmState | null>(null)
  const [editMsgModal, setEditMsgModal] = useState<EditMsgState | null>(null)
  const [moveMsgState, setMoveMsgState] = useState<{ msg: Message, targetQueue: string } | null>(null)

  const showSuccess = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000) }

  const loadQueues = useCallback(async () => {
    try {
      const data = await api.listQueues(1, 1000)
      setQueues(data.queues); setError('')
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { loadQueues() }, [loadQueues])

  const selectQueue = (q: Queue) => {
    setSelected(q); setMessages([]); setView('queue'); setFilterText('')
    setEditAttrs({
      VisibilityTimeout: q.attributes.VisibilityTimeout || '30',
      MessageRetentionPeriod: q.attributes.MessageRetentionPeriod || '345600',
      RedrivePolicy: q.attributes.RedrivePolicy || '',
    })
  }


  const handleCreate = async () => {
    const trimmed = newQueueName.trim()
    if (!trimmed) {
      setError('Queue name is required')
      return
    }
    setError('')
    try {
      await api.createQueue(trimmed);
      showSuccess(`Queue "${trimmed}" created successfully`)
      setNewQueueName('');
      setIsCreateModalOpen(false);
      await loadQueues()
    }
    catch (e: any) {
      setError(e.message)
    }
  }

  const openCreateModal = () => {
    setIsCreateModalOpen(true)
    setNewQueueName('')
  }

  const handleDelete = async (name: string) => {
    setConfirmModal({
      title: '🗑️ Delete Queue',
      message: `This will permanently delete the queue and all its messages. This action cannot be undone.`,
      confirmText: 'Delete Queue',
      typeToConfirm: name,
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          await api.deleteQueue(name)
          if (selected?.name === name) { setSelected(null); setMessages([]) }
          await loadQueues()
        } catch (e: any) { setError(e.message) }
      },
    })
  }

  const handlePurge = async () => {
    if (!selected) return
    setConfirmModal({
      title: '🗑️ Purge Queue',
      message: `This will delete ALL messages from "${selected.name}". This action cannot be undone.`,
      confirmText: 'Purge Queue',
      typeToConfirm: selected.name,
      onConfirm: async () => {
        setConfirmModal(null)
        try { await api.purgeQueue(selected.name); setMessages([]); await loadQueues() }
        catch (e: any) { setError(e.message) }
      },
    })
  }

  const handleSaveAttrs = async () => {
    if (!selected) return
    try {
      const attrs = { ...editAttrs }
      if (!attrs.RedrivePolicy) delete attrs.RedrivePolicy
      await api.updateQueue(selected.name, attrs); await loadQueues()
      showSuccess('Attributes saved')
    } catch (e: any) { setError(e.message) }
  }

  const handleSend = async () => {
    if (!selected || !msgBody) return
    try {
      const opts: any = {}
      if (msgGroupId) opts.messageGroupId = msgGroupId
      if (msgDedup) opts.messageDeduplicationId = msgDedup
      if (delaySeconds) opts.delaySeconds = Number(delaySeconds)
      await api.sendMessage(selected.name, msgBody, opts)
      setMsgBody(''); await loadQueues(); showSuccess('Message sent')
    } catch (e: any) { setError(e.message) }
  }

  const handleReceive = async () => {
    if (!selected) return
    try { setMessages(await api.receiveMessages(selected.name, 10)) }
    catch (e: any) { setError(e.message) }
  }

  const handleDeleteMsg = async (receiptHandle: string) => {
    if (!selected) return
    try {
      await api.deleteMessage(selected.name, receiptHandle)
      setMessages(prev => prev.filter(m => m.ReceiptHandle !== receiptHandle))
      await loadQueues()
    } catch (e: any) { setError(e.message) }
  }

  const handleEditMsg = async () => {
    if (!selected || !editMsgModal) return
    const { original, body, groupId, dedupId } = editMsgModal
    try {
      const opts: any = {}
      if (isFifo) {
        if (groupId) opts.messageGroupId = groupId
        if (dedupId) opts.messageDeduplicationId = dedupId
      }
      await api.editMessage(selected.name, body, original.MessageId, opts)

      setEditMsgModal(null)
      showSuccess('Message updated (old deleted and new sent)')
      await handleReceive() // refresh messages
      await loadQueues()
    } catch (e: any) { setError(e.message) }
  }

  const handleRedrive = async () => {
    if (!selected) return
    setConfirmModal({
      title: '🔄 Redrive Messages',
      message: `This will move all messages from "${selected.name}" back to the source queue.`,
      confirmText: 'Redrive',
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          const r = await api.redriveMessages(selected.name, 100)
          setMessages([]); await loadQueues()
          showSuccess(`${r.moved} message(s) moved to "${r.sourceQueue}"`)
        } catch (e: any) { setError(e.message) }
      },
    })
  }

  // --- Feature 3: Batch Send ---
  const handleBatchSend = async () => {
    if (!selected || !batchJson.trim()) return
    try {
      let msgs: any[]
      try { msgs = JSON.parse(batchJson) } catch { setError('Invalid JSON — expected an array'); return }
      if (!Array.isArray(msgs)) { setError('Expected a JSON array'); return }
      // Support both [{messageBody:"..."}, ...] and ["string1", "string2"]
      const normalized = msgs.map(m => typeof m === 'string' ? { messageBody: m } : m)
      const r = await api.sendBatch(selected.name, normalized)
      setBatchJson(''); await loadQueues()
      showSuccess(`Batch: ${r.sent} sent, ${r.failed} failed`)
    } catch (e: any) { setError(e.message) }
  }

  // --- Feature 5: Export/Import ---
  const handleExport = async () => {
    if (!selected) return
    try {
      const data = await api.exportMessages(selected.name, 100)
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `${selected.name}-export.json`; a.click()
      URL.revokeObjectURL(url)
      showSuccess(`Exported ${data.length} message(s)`)
    } catch (e: any) { setError(e.message) }
  }

  const handleImport = async () => {
    if (!selected) return
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return
      try {
        const text = await file.text()
        const msgs = JSON.parse(text)
        if (!Array.isArray(msgs)) { setError('Expected a JSON array'); return }
        const r = await api.importMessages(selected.name, msgs)
        await loadQueues(); showSuccess(`Imported ${r.imported} message(s)`)
      } catch (e: any) { setError(e.message) }
    }
    input.click()
  }

  // --- Feature 1: Move Messages ---
  const handleMove = async () => {
    if (!selected || !moveTarget) return
    setConfirmModal({
      title: '🔀 Move Messages',
      message: `This will move all messages from "${selected.name}" to "${moveTarget}". Messages will be removed from the source queue.`,
      confirmText: 'Move All',
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          const r = await api.moveMessages(selected.name, moveTarget, 100)
          setMessages([]); await loadQueues()
          showSuccess(`${r.moved} message(s) moved to "${r.targetQueue}"`)
        } catch (e: any) { setError(e.message) }
      },
    })
  }

  const handleMoveSingle = async () => {
    if (!selected || !moveMsgState || !moveMsgState.targetQueue) return
    const { msg, targetQueue } = moveMsgState
    try {
      const r = await api.moveMessages(selected.name, targetQueue, 1, msg.MessageId)
      setMoveMsgState(null)
      setMessages(prev => prev.filter(m => m.MessageId !== msg.MessageId))
      await loadQueues()
      showSuccess(`Message moved to "${targetQueue}"`)
    } catch (e: any) { setError(e.message) }
  }

  const isFifo = selected?.attributes.FifoQueue === 'true'
  const filteredMessages = filterText
    ? messages.filter(m => m.Body.toLowerCase().includes(filterText.toLowerCase()) || m.MessageId.toLowerCase().includes(filterText.toLowerCase()))
    : messages

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>SQS Admin</h2>
        <button className={`btn sidebar-nav ${view === 'dashboard' ? 'active-nav' : ''}`}
          onClick={() => { setView('dashboard'); setSelected(null) }}>📊 Dashboard</button>
        <button className="btn sidebar-nav" onClick={openCreateModal}>➕ Create Queue</button>
        <ul className="queue-list">
          {queues.map(q => (
            <li key={q.name} className={selected?.name === q.name ? 'active' : ''} onClick={() => selectQueue(q)}>
              <span className="queue-name">{q.name}</span>
              <span className="queue-stats">
                {q.attributes.ApproximateNumberOfMessages || 0} / {q.attributes.ApproximateNumberOfMessagesNotVisible || 0} / {q.attributes.ApproximateNumberOfMessagesDelayed || 0}
              </span>
              <button className="btn danger small" onClick={e => { e.stopPropagation(); handleDelete(q.name) }}>✕</button>
            </li>
          ))}
        </ul>
        <button className="btn" onClick={loadQueues} style={{ width: '100%', marginTop: 8 }}>↻ Refresh</button>
        {onLogout && <button className="btn danger" onClick={onLogout} style={{ width: '100%', marginTop: 8 }}>Logout</button>}
      </aside>

      {isCreateModalOpen && (
        <div className="modal-overlay" onClick={() => setIsCreateModalOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>➕ Create New Queue</h3>
            <p>Enter the name for the new SQS queue. Use <code>.fifo</code> suffix for FIFO queues.</p>
            <div style={{ marginBottom: 16 }}>
              <input 
                className="filter-input"
                value={newQueueName} 
                onChange={e => setNewQueueName(e.target.value)}
                placeholder="queue-name (or .fifo)" 
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleCreate()} 
              />
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => { setIsCreateModalOpen(false); setError(''); }}>Cancel</button>
              <button className="btn primary" onClick={handleCreate}>Create</button>
            </div>
          </div>
        </div>
      )}

      {editMsgModal && (
        <div className="modal-overlay" onClick={() => setEditMsgModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>✏️ Edit Message</h3>
            <p>SQS messages cannot be modified in place. This will delete the current message and send a new one with the updated content.</p>
            <div className="send-form">
              <textarea 
                value={editMsgModal.body} 
                onChange={e => setEditMsgModal({ ...editMsgModal, body: e.target.value })} 
                placeholder="Message body" 
                rows={6} 
              />
              {isFifo && (
                <div className="fifo-fields">
                  <label>Group ID:
                    <input value={editMsgModal.groupId || ''} onChange={e => setEditMsgModal({ ...editMsgModal, groupId: e.target.value })} />
                  </label>
                  <label>Deduplication ID:
                    <input value={editMsgModal.dedupId || ''} onChange={e => setEditMsgModal({ ...editMsgModal, dedupId: e.target.value })} />
                  </label>
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditMsgModal(null)}>Cancel</button>
              <button className="btn primary" onClick={handleEditMsg}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {moveMsgState && (
        <div className="modal-overlay" onClick={() => setMoveMsgState(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>🔀 Move Message</h3>
            <p>Move this message to another queue. It will be deleted from the current queue.</p>
            <div className="move-form" style={{ marginBottom: 16 }}>
              <select 
                value={moveMsgState.targetQueue} 
                onChange={e => setMoveMsgState({ ...moveMsgState, targetQueue: e.target.value })}
                className="filter-input"
              >
                <option value="">Select target queue...</option>
                {queues.filter(q => q.name !== selected?.name).map(q => (
                  <option key={q.name} value={q.name}>{q.name}</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setMoveMsgState(null)}>Cancel</button>
              <button className="btn warning" onClick={handleMoveSingle} disabled={!moveMsgState.targetQueue}>Move</button>
            </div>
          </div>
        </div>
      )}

      <main className="content">
        {error && <div className="error">{error} <button onClick={() => setError('')}>✕</button></div>}
        {success && <div className="success">{success}</div>}

        {view === 'dashboard' ? (
          <Dashboard onSelectQueue={selectQueue} onCreateQueue={openCreateModal} />
        ) : !selected ? (
          <div className="empty">Select a queue or create one to get started.</div>
        ) : (
          <>
            <h2>{selected.name}</h2>
            <p className="queue-url">{selected.url}</p>

            {selected.isDeadLetterQueue && (
              <section className="redrive-section">
                <h3>⚠️ This is a Dead Letter Queue</h3>
                <p>Messages here failed processing from the source queue.</p>
                <button className="btn warning" onClick={handleRedrive}>🔄 Redrive all to source queue</button>
              </section>
            )}

            <section>
              <h3>Attributes</h3>
              <div className="attrs-form">
                <label>Visibility Timeout (s)
                  <input value={editAttrs.VisibilityTimeout || ''} onChange={e => setEditAttrs(p => ({ ...p, VisibilityTimeout: e.target.value }))} />
                </label>
                <label>Retention Period (s)
                  <input value={editAttrs.MessageRetentionPeriod || ''} onChange={e => setEditAttrs(p => ({ ...p, MessageRetentionPeriod: e.target.value }))} />
                </label>
                <label>Redrive Policy (JSON)
                  <input value={editAttrs.RedrivePolicy || ''} onChange={e => setEditAttrs(p => ({ ...p, RedrivePolicy: e.target.value }))} />
                </label>
                <div className="btn-row">
                  <button className="btn primary" onClick={handleSaveAttrs}>Save Attributes</button>
                  <button className="btn danger" onClick={handlePurge}>Purge Queue</button>
                </div>
              </div>
            </section>

            <section>
              <h3>Send Message</h3>
              <div className="send-form">
                <textarea value={msgBody} onChange={e => setMsgBody(e.target.value)} placeholder="Message body" rows={3} />
                {isFifo && (
                  <div className="fifo-fields">
                    <input value={msgGroupId} onChange={e => setMsgGroupId(e.target.value)} placeholder="Message Group ID" />
                    <input value={msgDedup} onChange={e => setMsgDedup(e.target.value)} placeholder="Deduplication ID" />
                  </div>
                )}
                <input value={delaySeconds} onChange={e => setDelaySeconds(e.target.value)} placeholder="Delay (seconds)" type="number" />
                <button className="btn primary" onClick={handleSend}>Send</button>
              </div>
            </section>

            <section>
              <h3>📦 Batch Send</h3>
              <div className="send-form">
                <textarea value={batchJson} onChange={e => setBatchJson(e.target.value)} rows={4}
                  placeholder={'["msg1", "msg2"] or [{"messageBody":"...","delaySeconds":5}]'} />
                <button className="btn primary" onClick={handleBatchSend}>Send Batch</button>
              </div>
            </section>

            <section>
              <h3>📤 Export / Import</h3>
              <div className="btn-row">
                <button className="btn primary" onClick={handleExport}>⬇ Export Messages (JSON)</button>
                <button className="btn primary" onClick={handleImport}>⬆ Import Messages (JSON)</button>
              </div>
            </section>

            <section>
              <h3>🔀 Move Messages</h3>
              <div className="move-form">
                <select value={moveTarget} onChange={e => setMoveTarget(e.target.value)}>
                  <option value="">Select target queue...</option>
                  {queues.filter(q => q.name !== selected.name).map(q => (
                    <option key={q.name} value={q.name}>{q.name}</option>
                  ))}
                </select>
                <button className="btn warning" onClick={handleMove} disabled={!moveTarget}>Move All</button>
              </div>
            </section>

            <section>
              <h3>Messages <button className="btn primary small" onClick={handleReceive}>Peek Messages</button></h3>
              {messages.length > 0 && (
                <>
                  <input className="filter-input" value={filterText} onChange={e => setFilterText(e.target.value)}
                    placeholder="🔍 Filter by body or message ID..." />
                  <table>
                    <thead><tr><th>ID</th><th>Body</th><th>Sent</th><th></th></tr></thead>
                    <tbody>
                      {filteredMessages.map(m => (
                        <tr key={m.MessageId}>
                          <td className="mono">{m.MessageId.slice(0, 12)}…</td>
                          <td className="mono">{m.Body.length > 100 ? m.Body.slice(0, 100) + '…' : m.Body}</td>
                          <td>{m.Attributes?.SentTimestamp ? new Date(Number(m.Attributes.SentTimestamp)).toLocaleString() : '-'}</td>
                          <td>
                            <div className="btn-row">
                              <button className="btn primary small" onClick={() => setEditMsgModal({
                                original: m,
                                body: m.Body,
                                groupId: m.Attributes?.MessageGroupId,
                                dedupId: m.Attributes?.MessageDeduplicationId
                              })}>Edit</button>
                              <button className="btn warning small" onClick={() => setMoveMsgState({ msg: m, targetQueue: '' })}>Move</button>
                              <button className="btn danger small" onClick={() => handleDeleteMsg(m.ReceiptHandle)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filterText && <p className="filter-count">{filteredMessages.length} of {messages.length} messages</p>}
                </>
              )}
            </section>
          </>
        )}
      </main>

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          typeToConfirm={confirmModal.typeToConfirm}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  )
}
