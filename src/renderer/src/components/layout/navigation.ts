import type { ComponentType } from 'react'
import {
  LayoutDashboard,
  Server,
  Settings2,
  FileText,
  Settings,
  Key,
  Cpu,
  Network,
  Bot,
  Sparkles,
} from 'lucide-react'

export interface NavItem {
  titleKey: string
  href: string
  icon: ComponentType<{ className?: string }>
}

export interface NavGroup {
  labelKey: string
  items: NavItem[]
}

/** Single source for sidebar entries and the section label shown above each page title. */
export const navGroups: NavGroup[] = [
  {
    labelKey: 'nav.groupWorkspace',
    items: [
      { titleKey: 'nav.companion', href: '/', icon: Sparkles },
      { titleKey: 'nav.chat', href: '/chat', icon: Bot },
    ],
  },
  {
    labelKey: 'nav.groupMonitor',
    items: [
      { titleKey: 'nav.monitor', href: '/monitor', icon: LayoutDashboard },
    ],
  },
  {
    labelKey: 'nav.groupGateway',
    items: [
      { titleKey: 'nav.connections', href: '/connections', icon: Network },
      { titleKey: 'nav.apiService', href: '/api', icon: Settings2 },
    ],
  },
  {
    labelKey: 'nav.groupSystem',
    items: [
      { titleKey: 'nav.settings', href: '/settings', icon: Settings },
    ],
  },
]

export function findNavGroup(pathname: string): NavGroup | undefined {
  return navGroups.find(group => group.items.some(item => item.href === pathname || (item.href !== '/' && pathname.startsWith(item.href + '/'))))
}

export const sectionNavigation: Record<'monitor' | 'connections' | 'api', NavItem[]> = {
  monitor: [
    { titleKey: 'nav.usage', href: '/monitor/usage', icon: LayoutDashboard },
    { titleKey: 'logs.requestLogs', href: '/monitor/requests', icon: FileText },
    { titleKey: 'logs.appLogs', href: '/monitor/events', icon: FileText },
  ],
  connections: [
    { titleKey: 'nav.providers', href: '/connections/providers', icon: Server },
    { titleKey: 'nav.ollama', href: '/connections/ollama', icon: Network },
    { titleKey: 'nav.models', href: '/connections/models', icon: Cpu },
  ],
  api: [
    { titleKey: 'nav.proxy', href: '/api/service', icon: Settings2 },
    { titleKey: 'nav.apiKeys', href: '/api/keys', icon: Key },
  ],
}
