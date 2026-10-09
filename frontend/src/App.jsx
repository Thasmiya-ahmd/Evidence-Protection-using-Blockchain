import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { useWallet } from './context/wallet'
import './App.css'

const Admin = lazy(() => import('./pages/Admin'))
const CaseDetail = lazy(() => import('./pages/CaseDetail'))
const CaseForm = lazy(() => import('./pages/CaseForm'))
const Connect = lazy(() => import('./pages/Connect'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const EvidenceDetail = lazy(() => import('./pages/EvidenceDetail'))
const Notifications = lazy(() => import('./pages/Notifications'))
const Verify = lazy(() => import('./pages/Verify'))

function Protected({ children }) {
  const { account, role, chainMismatch } = useWallet()
  if (!account || !role || role === 'None' || chainMismatch) return <Navigate to="/connect" replace />
  return children
}

export default function App() {
  return (
    <Suspense fallback={<main className="main-content"><div className="panel skeleton skeleton-large" /></main>}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/connect" element={<Connect />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
          <Route path="/cases" element={<Protected><Dashboard /></Protected>} />
          <Route path="/cases/new" element={<Protected><CaseForm /></Protected>} />
          <Route path="/cases/:caseId" element={<Protected><CaseDetail /></Protected>} />
          <Route path="/evidence/:id" element={<Protected><EvidenceDetail /></Protected>} />
          <Route path="/evidence/:id/verify" element={<Protected><Verify /></Protected>} />
          <Route path="/notifications" element={<Protected><Notifications /></Protected>} />
          <Route path="/admin" element={<Protected><Admin /></Protected>} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
