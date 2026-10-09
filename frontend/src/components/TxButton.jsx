import { useState } from 'react'
import { useWallet } from '../context/wallet'
import { errorMessage } from '../utils/errors'

export default function TxButton({
  children,
  onClick,
  onSuccess,
  className = 'button button-primary',
  disabled = false,
  type = 'button',
}) {
  const { notify } = useWallet()
  const [stage, setStage] = useState('')

  async function submit() {
    setStage('Confirm in MetaMask')
    try {
      const transaction = await onClick()
      setStage('Waiting for confirmation')
      const receipt = await transaction.wait()
      setStage('')
      notify('success', `Transaction confirmed: ${receipt.hash.slice(0, 10)}…${receipt.hash.slice(-6)}`)
      if (onSuccess) await onSuccess(receipt)
    } catch (error) {
      setStage('')
      notify('error', errorMessage(error))
    }
  }

  return (
    <div className="tx-button-wrap">
      <button
        type={type}
        className={className}
        disabled={disabled || Boolean(stage)}
        onClick={submit}
      >
        {stage || children}
      </button>
      {stage && <small className="tx-stage">{stage === 'Confirm in MetaMask' ? 'Approve this transaction in your wallet.' : 'Waiting for the transaction to be mined.'}</small>}
    </div>
  )
}
