export function errorMessage(error) {
  const raw = error?.reason || error?.shortMessage || error?.message || ''
  if (/not authorized for this case/i.test(raw)) {
    return "You don't have access to this case."
  }
  if (/not authorized for this case|missing revert data/i.test(raw)) {
    return "You don't have access to this case, or the contract rejected this request."
  }
  if (/user rejected|action_rejected/i.test(raw)) {
    return 'Transaction cancelled in MetaMask.'
  }
  const reason = raw.match(/reason="([^"]+)"/i)?.[1]
  if (reason) return reason
  const revert = raw.match(/execution reverted(?::\s*)?([^\n(]*)/i)?.[1]?.trim()
  if (revert) return revert
  return raw.length > 220 ? `${raw.slice(0, 217)}…` : raw || 'The request failed. Please try again.'
}
