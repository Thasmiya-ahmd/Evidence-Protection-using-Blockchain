export default function StatusChip({ children, kind = '' }) {
  return <span className={`status-chip ${kind || String(children).toLowerCase().replaceAll(' ', '-')}`}>{children}</span>
}
