export function errorMessage(error) {
  if (!window.navigator.onLine) {
    return 'Your network is offline. Please check your connection.'
  }
  
  if (error?.status) {
    switch (error.status) {
      case 401: return 'Session expired. Please sign in again.'
      case 403: return "You don't have access to this case."
      case 409: return 'This file already exists or there is a conflict.'
      case 413: return 'The file is too large to upload.'
      case 429: return 'Too many requests. Please slow down and try again later.'
      case 503: return 'The blockchain node is currently unreachable.'
      default: return error.message || `An error occurred (${error.status})`
    }
  }

  const raw = error?.reason || error?.shortMessage || error?.message || ''
  
  if (error?.code === 4001 || error?.code === 'ACTION_REJECTED' || /user rejected|action_rejected/i.test(raw)) {
    return 'Transaction cancelled in MetaMask.'
  }
  
  if (/wrong network|chain id/i.test(raw)) {
    return 'You are on the wrong network in MetaMask. Please switch to the local network.'
  }

  if (/not authorized for this case/i.test(raw)) {
    return "You don't have access to this case."
  }
  if (/not authorized for this case|missing revert data/i.test(raw)) {
    return "You don't have access to this case, or the contract rejected this request."
  }

  const reason = raw.match(/reason="([^"]+)"/i)?.[1]
  if (reason) return reason
  const revert = raw.match(/execution reverted(?::\s*)?([^\n(]*)/i)?.[1]?.trim()
  if (revert) return revert
  return raw.length > 220 ? `${raw.slice(0, 217)}…` : raw || 'The request failed. Please try again.'
}
