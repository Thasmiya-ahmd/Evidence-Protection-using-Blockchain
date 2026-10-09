import { useState } from 'react'
import { copyText, shortAddress } from '../utils/format'

export default function AddressTag({ address }) {
  const [copied, setCopied] = useState(false)
  if (!address) return <span>—</span>
  return (
    <button
      className="address-tag"
      type="button"
      title={`Copy ${address}`}
      onClick={async () => {
        await copyText(address)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? 'Copied' : shortAddress(address)}
    </button>
  )
}
