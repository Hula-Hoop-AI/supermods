// The pane layout every tabbed mod draws: tabs, a summary line with actions, rows, a footer.
// Canonical copy: shared/tab-pane.tsx. Edit it there and run shared/sync.sh; a plugin
// installs alone, so each mod carries its own copy.
import type { ElementTable, RenderSurface, RenderViewport } from 'claude-code'

export type RowState = 'ok' | 'busy' | 'error' | 'idle'

export type Tag = { text: string; color?: string; dimColor?: boolean; bold?: boolean }

export type Row = {
  id: string
  state?: RowState
  label?: string // the state in words; a dot is drawn without one
  title: string
  tags?: Tag[]
  age?: string
  sub?: string // a second, dim line
  link?: string
  copyText?: string
  highlight?: boolean
  actions?: { key: string; label: string }[] // buttons beside the row; a press calls onRowAction
  heading?: boolean // a group's headline over the rows after it: its title in bold (a link when `link`), its copy button; nothing else
}

export type Action = { key: string; label: string; isActive?: boolean; onPress: () => void }

export type PaneModel = {
  tabs: { id: string; title: string }[]
  activeTab: string
  onTab: (id: string) => void
  summary: string
  context?: string
  actions?: Action[]
  error?: string
  notes?: string[]
  checkedAt?: number // undefined until the first answer
  empty: string
  rows: Row[]
  footer?: string
  onCopy: (text: string, surface: RenderSurface) => void
  onRowAction?: (row: Row, key: string) => void
  columns?: number // the pane's body width (`e.props.bodyColumns`); titles shrink to keep the rest of a row in view
}

const STATE_COLORS: Record<RowState, string | undefined> = {
  ok: 'green',
  busy: 'yellow',
  error: 'red',
  idle: undefined, // drawn dim
}
const DOT = '●'
const MAX_TITLE_PAD = 32
const MAX_SUB = 72
const CHROME_ROWS = 5 // tabs, summary, footer, the "more" line and a spare
const MIN_TITLE = 8
const BUTTON_CHROME = 5 // "[ " and " ]" around a button's label, and the gap before it

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const widest = (cells: string[], cap: number) => Math.min(cap, Math.max(0, ...cells.map(c => c.length)))

// As many rows as the viewport has lines for; a row with a sub-line takes two.
export function fitRows(rows: Row[], lines: number): Row[] {
  const fit: Row[] = []
  let left = Math.max(1, lines)
  for (const row of rows) {
    left -= row.sub ? 2 : 1
    if (left < 0 && fit.length) break
    fit.push(row)
  }
  if (fit.length > 1 && fit[fit.length - 1]!.heading) fit.pop() // no headline without a row under it
  return fit
}

// `ui` is `$.ui.resolve(e)`: the validator follows `$` only inside the hooks module's own file,
// so the caller resolves the elements and supplies the handlers.
export function tabPane(ui: ElementTable, viewport: RenderViewport | undefined, m: PaneModel) {
  const { Box, Text, Button, Link } = ui
  const notes = m.notes ?? []
  const shown = fitRows(m.rows, (viewport?.rows ?? 24) - CHROME_ROWS - notes.length - (m.error ? 1 : 0))
  const hidden = m.rows.slice(shown.length).filter(r => !r.heading).length
  const items = shown.filter(r => !r.heading) // headlines take no part in the columns
  const labelWidth = widest(items.map(r => r.label ?? ''), MAX_TITLE_PAD)
  const marks = items.some(r => r.highlight)
  // Everything on a row's line but its title.
  const rest = (r: Row) =>
    (marks ? 2 : 0) +
    (r.label === undefined ? 1 : labelWidth) +
    1 +
    (r.tags ?? []).reduce((n, t) => n + 1 + t.text.length, 0) +
    (r.age ? 1 + r.age.length : 0) +
    (r.copyText !== undefined ? 'copy'.length + BUTTON_CHROME : 0) +
    (r.actions ?? []).reduce((n, a) => n + a.label.length + BUTTON_CHROME, 0)
  const room = m.columns === undefined ? Infinity : Math.max(MIN_TITLE, m.columns - Math.max(0, ...items.map(rest)))
  const titleWidth = Math.min(room, widest(items.map(r => r.title), MAX_TITLE_PAD))
  const title = (r: Row) => (r.title.length > room ? truncate(r.title, room) : r.title).padEnd(titleWidth)

  return (
    <Box flexDirection="column">
      {m.tabs.length > 1 && (
        <Box flexDirection="row" gap={1}>
          {m.tabs.map(t => (
            <Button key={`tab:${t.id}`} variant={t.id === m.activeTab ? 'primary' : 'secondary'} onPress={() => m.onTab(t.id)}>
              {t.title}
            </Button>
          ))}
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Text bold>
          {m.summary}
          {m.context && <Text dimColor> · {m.context}</Text>}
        </Text>
        {(m.actions ?? []).map(a => (
          <Button key={a.key} variant={a.isActive ? 'primary' : 'secondary'} onPress={a.onPress}>
            {a.label}
          </Button>
        ))}
      </Box>
      {m.error && <Text color="red">{m.error}</Text>}
      {notes.map(n => (
        <Text dimColor>{n}</Text>
      ))}
      {m.checkedAt === undefined && !m.error && <Text dimColor>Checking…</Text>}
      {m.checkedAt !== undefined && !m.error && m.rows.length === 0 && <Text dimColor>{m.empty}</Text>}
      {shown.map(r => {
        if (r.heading) {
          return (
            <Box flexDirection="row" gap={1}>
              <Text bold wrap="truncate-end">
                {r.link ? <Link href={r.link}>{r.title}</Link> : r.title}
              </Text>
              {r.copyText !== undefined && (
                <Button key={`copy:${r.id}`} dimColor onPress={press => m.onCopy(r.copyText!, press.surface)}>
                  copy
                </Button>
              )}
            </Box>
          )
        }
        const color = r.state && STATE_COLORS[r.state]
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">
                {marks && <Text color="cyan">{r.highlight ? '› ' : '  '}</Text>}
                <Text color={color} dimColor={!color} bold={r.state !== 'idle'}>
                  {r.label === undefined ? DOT : r.label.padEnd(labelWidth)}
                </Text>{' '}
                {title(r)}
                {(r.tags ?? []).map(t => (
                  <Text color={t.color} dimColor={t.dimColor} bold={t.bold}>
                    {' '}
                    {t.text}
                  </Text>
                ))}
                {r.age && <Text dimColor> {r.age}</Text>}
              </Text>
              {r.copyText !== undefined && (
                <Button key={`copy:${r.id}`} dimColor onPress={press => m.onCopy(r.copyText!, press.surface)}>
                  copy
                </Button>
              )}
              {(r.actions ?? []).map(a => (
                <Button key={`${a.key}:${r.id}`} dimColor onPress={() => m.onRowAction?.(r, a.key)}>
                  {a.label}
                </Button>
              ))}
              {r.link && !r.sub && <Link href={r.link} />}
            </Box>
            {r.sub && (
              <Box flexDirection="row" gap={1}>
                <Text dimColor>
                  {'    '}
                  {truncate(r.sub, MAX_SUB)}
                </Text>
                {r.link && <Link href={r.link} />}
              </Box>
            )}
          </Box>
        )
      })}
      {hidden > 0 && <Text dimColor>…and {hidden} more</Text>}
      {m.checkedAt !== undefined && (
        <Text dimColor>
          updated {new Date(m.checkedAt).toLocaleTimeString()}
          {m.footer && <Text> · {m.footer}</Text>}
        </Text>
      )}
    </Box>
  )
}
