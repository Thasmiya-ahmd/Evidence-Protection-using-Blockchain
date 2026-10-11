const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
let sessionToken = localStorage.getItem('evidence-jwt') || ''
let authErrorHandler = null

export function setSessionToken(token) {
  sessionToken = token || ''
  if (sessionToken) localStorage.setItem('evidence-jwt', sessionToken)
  else localStorage.removeItem('evidence-jwt')
}

export function onUnauthorized(callback) {
  authErrorHandler = callback
}

async function request(route, options = {}) {
  const headers = new Headers(options.headers || {})
  if (sessionToken) headers.set('Authorization', `Bearer ${sessionToken}`)
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`${API_URL.replace(/\/+$/, '')}${route}`, {
    ...options,
    headers,
    body:
      options.body && !(options.body instanceof FormData)
        ? JSON.stringify(options.body)
        : options.body,
  })
  if (response.status === 401) {
    setSessionToken('')
    if (authErrorHandler) authErrorHandler()
  }
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    const err = new Error(result?.message || result?.error || `API request failed (${response.status})`)
    err.status = response.status
    err.code = result?.error
    throw err
  }
  return response
}

export async function loginWithWallet(address, signer) {
  const nonceResponse = await request('/api/auth/nonce', {
    method: 'POST',
    body: { address },
  })
  const { message } = await nonceResponse.json()
  const signature = await signer.signMessage(message)
  const loginResponse = await request('/api/auth/login', {
    method: 'POST',
    body: { address, signature },
  })
  const { token } = await loginResponse.json()
  setSessionToken(token)
  return token
}

export async function uploadEvidenceFile(file, kind = 'evidence') {
  const form = new FormData()
  form.set('file', file)
  form.set('kind', kind)
  const response = await request('/api/files', { method: 'POST', body: form })
  return response.json()
}

export async function linkEvidenceFile(fileHash, evidenceId) {
  const response = await request(`/api/files/${encodeURIComponent(fileHash)}/link`, {
    method: 'POST',
    body: { evidenceId: String(evidenceId) },
  })
  return response.json()
}

export async function downloadEvidenceFile(fileHash, evidenceId) {
  const query = evidenceId ? `?evidenceId=${encodeURIComponent(evidenceId)}` : ''
  const response = await request(`/api/files/${encodeURIComponent(fileHash)}${query}`)
  
  let filename = 'download.bin'
  const disposition = response.headers.get('Content-Disposition')
  if (disposition && disposition.includes('filename=')) {
    const match = disposition.match(/filename="?([^"]+)"?/)
    if (match) filename = match[1]
  }
  
  const blob = await response.blob()
  return { blob, filename }
}

export async function verifyEvidenceFile(fileHash) {
  const response = await request(`/api/files/${encodeURIComponent(fileHash)}/verify`)
  return response.json()
}

export async function tamperEvidenceFile(fileHash) {
  const response = await request(`/api/dev/tamper/${encodeURIComponent(fileHash)}`, {
    method: 'POST',
  })
  return response.json()
}

export function apiUrl() {
  return API_URL
}
