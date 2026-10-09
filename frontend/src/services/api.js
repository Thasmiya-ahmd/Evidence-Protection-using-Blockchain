const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
let sessionToken = sessionStorage.getItem('evidence-jwt') || ''

export function setSessionToken(token) {
  sessionToken = token || ''
  if (sessionToken) sessionStorage.setItem('evidence-jwt', sessionToken)
  else sessionStorage.removeItem('evidence-jwt')
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
  if (!response.ok) {
    const result = await response.json().catch(() => null)
    throw new Error(result?.message || result?.error || `API request failed (${response.status})`)
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

export async function uploadEvidenceFile(file, caseId, kind = 'evidence') {
  const form = new FormData()
  form.set('file', file)
  form.set('caseId', caseId)
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
  return response.arrayBuffer()
}

export function apiUrl() {
  return API_URL
}
