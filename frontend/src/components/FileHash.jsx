import { shortHash } from '../utils/format'

export default function FileHash({ hash, label = 'SHA-256' }) {
  return (
    <div className="file-hash">
      <span>{label}</span>
      <code title={hash}>{shortHash(hash)}</code>
    </div>
  )
}
