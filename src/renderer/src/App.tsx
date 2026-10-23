import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { MainLayout } from '@/components/layout/MainLayout'
import { TrayView } from '@/components/Tray/TrayView'
import { Toaster } from '@/components/ui/toaster'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmationProvider } from '@/components/ui/confirmation-provider'
import { SectionLayout, LegacyRedirect } from '@/components/layout/SectionLayout'

const Dashboard = lazy(() => import('@/pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Providers = lazy(() => import('@/pages/Providers').then(m => ({ default: m.Providers })))
const ProxySettings = lazy(() => import('@/pages/ProxySettings').then(m => ({ default: m.ProxySettings })))
const Models = lazy(() => import('@/pages/Models').then(m => ({ default: m.Models })))
const ApiKeys = lazy(() => import('@/pages/ApiKeys'))
const Logs = lazy(() => import('@/pages/Logs'))
const Settings = lazy(() => import('@/pages/Settings').then(m => ({ default: m.Settings })))
const OllamaNodes = lazy(() => import('@/pages/OllamaNodes').then(m => ({ default: m.OllamaNodes })))
const Chat = lazy(() => import('@/pages/Chat').then(m => ({ default: m.Chat })))

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="space-y-4 w-full max-w-md">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  )
}

function App() {
  return (
    <ConfirmationProvider>
      <Routes>
        <Route path="/tray" element={<TrayView />} />
        <Route element={<MainLayout />}>
          <Route path="/" element={null} />
          <Route path="/chat" element={<Suspense fallback={<PageLoader />}><Chat /></Suspense>} />
          <Route path="/monitor" element={<SectionLayout section="monitor" />}>
            <Route index element={<Navigate to="usage" replace />} />
            <Route path="usage" element={<Dashboard />} />
            <Route path="requests" element={<Logs kind="request" />} />
            <Route path="events" element={<Logs kind="app" />} />
          </Route>
          <Route path="/connections" element={<SectionLayout section="connections" />}>
            <Route index element={<Navigate to="providers" replace />} />
            <Route path="providers" element={<Providers />} />
            <Route path="ollama" element={<OllamaNodes />} />
            <Route path="models" element={<Models />} />
          </Route>
          <Route path="/api" element={<SectionLayout section="api" />}>
            <Route index element={<Navigate to="service" replace />} />
            <Route path="service" element={<ProxySettings />} />
            <Route path="keys" element={<ApiKeys />} />
          </Route>
          <Route path="/dashboard" element={<LegacyRedirect to="/monitor/usage" />} />
          <Route path="/providers" element={<LegacyRedirect to="/connections/providers" />} />
          <Route path="/ollama" element={<LegacyRedirect to="/connections/ollama" />} />
          <Route path="/models" element={<LegacyRedirect to="/connections/models" />} />
          <Route path="/proxy" element={<LegacyRedirect to="/api/service" />} />
          <Route path="/api-keys" element={<LegacyRedirect to="/api/keys" />} />
          <Route path="/logs" element={<LegacyRedirect to="/monitor/requests" logs />} />
          <Route path="/session" element={<LegacyRedirect to="/api/service?tab=session" />} />
          <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
          <Route path="/about" element={<LegacyRedirect to="/settings?tab=about" />} />
        </Route>
      </Routes>
      <Toaster />
    </ConfirmationProvider>
  )
}

export default App
