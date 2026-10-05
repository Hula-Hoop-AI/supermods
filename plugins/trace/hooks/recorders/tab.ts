import type { PaneModel } from '../tab-pane'

// What a recorder builds for its tab; register.tsx adds the tabs and the copy handler.
export type TabModel = Omit<PaneModel, 'tabs' | 'activeTab' | 'onTab' | 'onCopy'>
