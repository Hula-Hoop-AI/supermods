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
  return fit
}

// `ui` is `$.ui.resolve(e)`: the validator follows `$` only inside the hooks module's own file,
// so the caller resolves the elements and supplies the handlers.
export function tabPane(ui: ElementTable, viewport: RenderViewport | undefined, m: PaneModel) {
  const { Box, Text, Button, Link } = ui
  const notes = m.notes ?? []
  const shown = fitRows(m.rows, (viewport?.rows ?? 24) - CHROME_ROWS - notes.length - (m.error ? 1 : 0))
  const labelWidth = widest(shown.map(r => r.label ?? ''), MAX_TITLE_PAD)
  const titleWidth = widest(shown.map(r => r.title), MAX_TITLE_PAD)
  const marks = shown.some(r => r.highlight)

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
        const color = r.state && STATE_COLORS[r.state]
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text wrap="truncate-end">
                {marks && <Text color="cyan">{r.highlight ? '› ' : '  '}</Text>}
                <Text color={color} dimColor={!color} bold={r.state !== 'idle'}>
                  {r.label === undefined ? DOT : r.label.padEnd(labelWidth)}
                </Text>{' '}
                {r.title.padEnd(titleWidth)}
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
      {m.rows.length > shown.length && <Text dimColor>…and {m.rows.length - shown.length} more</Text>}
      {m.checkedAt !== undefined && (
        <Text dimColor>
          updated {new Date(m.checkedAt).toLocaleTimeString()}
          {m.footer && <Text> · {m.footer}</Text>}
        </Text>
      )}
    </Box>
  )
}
