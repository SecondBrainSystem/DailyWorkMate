import type { ComponentType } from 'react'
import {
  LayoutDashboard,
  Server,
  Settings2,
  FileText,
  Settings,
  Key,
  Cpu,
  Info,
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
      { titleKey: 'nav.dashboard', href: '/dashboard', icon: LayoutDashboard },
      { titleKey: 'nav.logs', href: '/logs', icon: FileText },
    ],
  },
  {
    labelKey: 'nav.groupGateway',
    items: [
      { titleKey: 'nav.providers', href: '/providers', icon: Server },
      { titleKey: 'nav.models', href: '/models', icon: Cpu },
      { titleKey: 'nav.ollama', href: '/ollama', icon: Network },
      { titleKey: 'nav.proxy', href: '/proxy', icon: Settings2 },
      { titleKey: 'nav.apiKeys', href: '/api-keys', icon: Key },
    ],
  },
  {
    labelKey: 'nav.groupSystem',
    items: [
      { titleKey: 'nav.settings', href: '/settings', icon: Settings },
      { titleKey: 'nav.about', href: '/about', icon: Info },
    ],
  },
]

export function findNavGroup(pathname: string): NavGroup | undefined {
  return navGroups.find(group => group.items.some(item => item.href === pathname))
}
