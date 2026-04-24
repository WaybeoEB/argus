import {authEnabled, getIdToken} from './auth'

const BASE = import.meta.env.VITE_API_URL || '/api'

async function request(path: string, opts?: RequestInit) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...opts?.headers as any }
  if (authEnabled) {
    const token = await getIdToken()
    if (token) headers['Authorization'] = token
  }
  const res = await fetch(BASE + path, { ...opts, headers })
  if (res.status === 401) {
    window.dispatchEvent(new Event('auth:expired'))
    throw new Error('Session expired')
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const api = {
  listQueues: (page = 1, pageSize = 20, search = '') =>
    request(`/queues?page=${page}&pageSize=${pageSize}${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  createQueue: (name: string, attributes?: Record<string, string>) =>
    request('/queues', { method: 'POST', body: JSON.stringify({ name, attributes }) }),
  deleteQueue: (name: string) => request(`/queues/${name}`, { method: 'DELETE' }),
  updateQueue: (name: string, attributes: Record<string, string>) =>
    request(`/queues/${name}`, { method: 'PUT', body: JSON.stringify({ attributes }) }),
  purgeQueue: (name: string) => request(`/queues/${name}/purge`, { method: 'POST' }),
  sendMessage: (name: string, messageBody: string, opts?: { messageGroupId?: string; messageDeduplicationId?: string; delaySeconds?: number }) =>
    request(`/queues/${name}/messages`, { method: 'POST', body: JSON.stringify({ messageBody, ...opts }) }),
  receiveMessages: (name: string, maxMessages = 5, waitTime = 0) =>
    request(`/queues/${name}/messages?maxMessages=${maxMessages}&waitTime=${waitTime}`),
  deleteMessage: (name: string, receiptHandle: string) =>
    request(`/queues/${name}/messages`, { method: 'DELETE', body: JSON.stringify({ receiptHandle }) }),
  redriveMessages: (name: string, maxMessages = 10) =>
    request(`/queues/${name}/redrive`, { method: 'POST', body: JSON.stringify({ maxMessages }) }),
  sendBatch: (name: string, messages: any[]) =>
    request(`/queues/${name}/messages/batch`, { method: 'POST', body: JSON.stringify({ messages }) }),
  exportMessages: (name: string, maxMessages = 100) =>
    request(`/queues/${name}/export`, { method: 'POST', body: JSON.stringify({ maxMessages }) }),
  importMessages: (name: string, messages: any[]) =>
    request(`/queues/${name}/import`, { method: 'POST', body: JSON.stringify({ messages }) }),
  moveMessages: (name: string, targetQueue: string, maxMessages = 100, receiptHandle?: string, body?: string, attributes?: any) =>
    request(`/queues/${name}/move`, { method: 'POST', body: JSON.stringify({ targetQueue, maxMessages, receiptHandle, body, attributes }) }),
}
