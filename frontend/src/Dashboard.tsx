import {useCallback, useEffect, useState} from 'react'
import {api} from './api'
import './Dashboard.css'

interface Queue {
  name: string
  url: string
  attributes: Record<string, string>
  dlqName?: string
  isDeadLetterQueue?: boolean
}

const PAGE_SIZE = 20

export default function Dashboard({ onSelectQueue, onCreateQueue }: { onSelectQueue: (q: Queue) => void, onCreateQueue?: () => void }) {
  const [queues, setQueues] = useState<Queue[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [dlqLoading, setDlqLoading] = useState<Record<string, boolean>>({})
  const [dlqError, setDlqError] = useState<Record<string, string>>({})

  const handleDlqClick = async (dlqName: string) => {
    const local = queues.find(x => x.name === dlqName)
    if (local) { onSelectQueue(local); return }
    setDlqLoading(prev => ({ ...prev, [dlqName]: true }))
    setDlqError(prev => { const n = { ...prev }; delete n[dlqName]; return n })
    try {
      const found = await api.getQueueByName(dlqName)
      if (found) { onSelectQueue(found) }
      else { setDlqError(prev => ({ ...prev, [dlqName]: 'DLQ not found' })) }
    } catch (e: any) {
      setDlqError(prev => ({ ...prev, [dlqName]: e.message || 'Failed to fetch DLQ' }))
    } finally {
      setDlqLoading(prev => ({ ...prev, [dlqName]: false }))
    }
  }

  const load = useCallback(async (p = page, s = search) => {
    setLoading(true)
    try {
      const data = await api.listQueues(p, PAGE_SIZE, s)
      setQueues(data.queues); setTotal(data.total); setError('')
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [page, search])

  useEffect(() => { load() }, [load])
  useEffect(() => { const id = setInterval(() => load(), 15000); return () => clearInterval(id) }, [load])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const handleSearch = (v: string) => { setSearch(v); setPage(1); load(1, v) }
  const goPage = (p: number) => { setPage(p); load(p) }

  const totalMsgs = queues.reduce((s, q) => s + Number(q.attributes.ApproximateNumberOfMessages || 0), 0)
  const totalInFlight = queues.reduce((s, q) => s + Number(q.attributes.ApproximateNumberOfMessagesNotVisible || 0), 0)
  const totalDelayed = queues.reduce((s, q) => s + Number(q.attributes.ApproximateNumberOfMessagesDelayed || 0), 0)
  const dlqs = queues.filter(q => q.isDeadLetterQueue)
  const totalDlqMsgs = dlqs.reduce((s, q) => s + Number(q.attributes.ApproximateNumberOfMessages || 0), 0)
  const fifoCount = queues.filter(q => q.attributes.FifoQueue === 'true').length

  return (
    <div className="dashboard">
      <div className="dash-header">
        <h2>📊 Dashboard</h2>
        <div className="dash-actions">
          {onCreateQueue && <button className="btn primary" onClick={onCreateQueue}>➕ Create Queue</button>}
          <input className="dash-search" value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="🔍 Search queues..." />
          <button className="btn" onClick={() => load()} disabled={loading}>{loading ? '...' : '↻ Refresh'}</button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      <div className="kpi-grid">
        <div className="kpi"><span className="kpi-value">{total}</span><span className="kpi-label">Total Queues</span></div>
        <div className="kpi"><span className="kpi-value">{fifoCount}</span><span className="kpi-label">FIFO (page)</span></div>
        <div className="kpi highlight-blue"><span className="kpi-value">{totalMsgs}</span><span className="kpi-label">Available (page)</span></div>
        <div className="kpi highlight-orange"><span className="kpi-value">{totalInFlight}</span><span className="kpi-label">In Flight (page)</span></div>
        <div className="kpi highlight-yellow"><span className="kpi-value">{totalDelayed}</span><span className="kpi-label">Delayed (page)</span></div>
        <div className="kpi highlight-red"><span className="kpi-value">{totalDlqMsgs}</span><span className="kpi-label">In DLQ (page)</span></div>
      </div>

      <div className="dash-table-header">
        <h3>Queues {search && `matching "${search}"`}</h3>
        <span className="page-info">Showing {queues.length} of {total}</span>
      </div>
      <table className="dash-table">
        <thead>
          <tr>
            <th>Queue</th>
            <th>Type</th>
            <th>Available</th>
            <th>In Flight</th>
            <th>Delayed</th>
            <th>DLQ Target</th>
            <th>Retention</th>
            <th>Visibility</th>
          </tr>
        </thead>
        <tbody>
          {queues.map(q => {
            const avail = Number(q.attributes.ApproximateNumberOfMessages || 0)
            const inflight = Number(q.attributes.ApproximateNumberOfMessagesNotVisible || 0)
            const delayed = Number(q.attributes.ApproximateNumberOfMessagesDelayed || 0)
            const isFifo = q.attributes.FifoQueue === 'true'
            const retention = Math.round(Number(q.attributes.MessageRetentionPeriod || 0) / 86400)
            return (
              <tr key={q.name} className={q.isDeadLetterQueue ? 'dlq-row' : ''}>
                <td>
                  <button className="link-btn" onClick={() => onSelectQueue(q)}>{q.name}</button>
                  {q.isDeadLetterQueue && <span className="badge badge-red">DLQ</span>}
                </td>
                <td>{isFifo ? <span className="badge badge-blue">FIFO</span> : 'Standard'}</td>
                <td className={avail > 0 ? 'num highlight-blue' : 'num'}>{avail}</td>
                <td className={inflight > 0 ? 'num highlight-orange' : 'num'}>{inflight}</td>
                <td className={delayed > 0 ? 'num highlight-yellow' : 'num'}>{delayed}</td>
                <td>{q.dlqName ? <>
                  <button className="link-btn" disabled={dlqLoading[q.dlqName]} onClick={() => handleDlqClick(q.dlqName!)}>{dlqLoading[q.dlqName] ? '⏳' : ''}{q.dlqName}</button>
                  {dlqError[q.dlqName] && <span className="badge badge-red" title={dlqError[q.dlqName]}>⚠</span>}
                </> : '—'}</td>
                <td className="num">{retention}d</td>
                <td className="num">{q.attributes.VisibilityTimeout || 30}s</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn small" onClick={() => goPage(page - 1)} disabled={page <= 1}>← Prev</button>
          <span className="page-info">Page {page} of {totalPages}</span>
          <button className="btn small" onClick={() => goPage(page + 1)} disabled={page >= totalPages}>Next →</button>
        </div>
      )}

      {dlqs.length > 0 && (
        <>
          <h3>⚠️ Dead Letter Queues</h3>
          <table className="dash-table">
            <thead><tr><th>DLQ</th><th>Messages</th><th>Source Queues</th></tr></thead>
            <tbody>
              {dlqs.map(dlq => {
                const sources = queues.filter(q => q.dlqName === dlq.name).map(q => q.name)
                const msgs = Number(dlq.attributes.ApproximateNumberOfMessages || 0)
                return (
                  <tr key={dlq.name}>
                    <td><button className="link-btn" onClick={() => onSelectQueue(dlq)}>{dlq.name}</button></td>
                    <td className={msgs > 0 ? 'num highlight-red' : 'num'}>{msgs}</td>
                    <td>{sources.length > 0 ? sources.join(', ') : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
