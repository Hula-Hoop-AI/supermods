// The logs and metrics panes the Modal and Docker tabs open. `ui` is `$.ui.resolve(e)`, as for tabPane.
import type { ElementTable } from 'claude-code'

import type { Logs, Metrics } from '../../types'

const CHROME_ROWS = 3 // the error, the footer and a spare
// One accent for every meter: the label says what it measures, the color does not.
const ACCENT = 'cyan'
const FILLED = '█'
const TRACK = '░'
const BAR_MAX = 20
const BAR_MIN = 8

const updated = (at: number, everyS: number) => `updated ${new Date(at).toLocaleTimeString()} · every ${everyS}s`

// The newest lines that fit the pane's body (`bodyRows`), oldest first.
export function logsPane(ui: ElementTable, bodyRows: number, l: Logs | null, everyS: number) {
  const { Box, Text } = ui
  if (!l) return <Text dimColor>Press logs on a container in /observe.</Text>
  const room = Math.max(1, bodyRows - CHROME_ROWS)
  return (
    <Box flexDirection="column">
      {l.error && <Text color="red">{l.error}</Text>}
      {l.checkedAt === undefined && <Text dimColor>Loading…</Text>}
      {l.checkedAt !== undefined && !l.error && l.lines.length === 0 && <Text dimColor>No logs yet.</Text>}
      {l.lines.slice(-room).map(line => (
        <Text wrap="truncate-end">{line}</Text>
      ))}
      {l.checkedAt !== undefined && (
        <Text dimColor>
          {updated(l.checkedAt, everyS)} · last {l.lines.length} entries
        </Text>
      )}
    </Box>
  )
}

// A bar `width` cells wide, filled to `fraction` (clamped to 0..1; not a number reads as 0).
export function meter(fraction: number, width: number): { filled: string; track: string } {
  const cells = Math.max(0, Math.floor(width))
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const n = Math.round(f * cells)
  return { filled: FILLED.repeat(n), track: TRACK.repeat(cells - n) }
}

// GiB with one decimal, whole above 100 (a host's 1024 GiB, not 1024.0).
export const gib = (bytes: number) => {
  const g = bytes / 2 ** 30
  return g >= 100 ? g.toFixed(0) : g.toFixed(1)
}
const pct = (f: number) => `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`.padStart(4)

// A labeled line: a meter and its figures, or the figures alone when there is no denominator.
type Line = { label: string; fraction?: number; text: string }

export function metricLines(m: Metrics): Line[] {
  const lines: Line[] = []
  for (const g of m.gpus ?? []) {
    const name = `GPU${g.index}`
    if (g.util !== undefined) lines.push({ label: `${name} util`, fraction: g.util / 100, text: pct(g.util / 100) })
    if (g.memUsedMiB !== undefined && g.memTotalMiB) {
      const f = g.memUsedMiB / g.memTotalMiB
      lines.push({ label: `${name} mem`, fraction: f, text: `${pct(f)}  ${gib(g.memUsedMiB * 2 ** 20)} / ${gib(g.memTotalMiB * 2 ** 20)} GiB` })
    }
  }
  if (m.memUsed === undefined) return lines
  const cpus = m.limits?.cpus
  if (m.cores !== undefined && cpus) {
    const f = m.cores / cpus
    const host = m.limits?.cpusHost ? ' host' : ''
    lines.push({ label: 'CPU', fraction: f, text: `${pct(f)}  ${m.cores.toFixed(1)} / ${+cpus.toFixed(2)} cores${host}` })
  } else if (m.cores !== undefined) lines.push({ label: 'CPU', text: `${m.cores.toFixed(2)} cores` })
  else if (m.load !== undefined) lines.push({ label: 'CPU', text: `load ${m.load.toFixed(2)}` })
  else lines.push({ label: 'CPU', text: 'measuring…' })
  // A limit counts only when it is below the machine's memory (on Modal the cgroup's is the host's).
  const host = m.limits?.memTotal
  // A Docker limit is only read when the container sets one (HostConfig.Memory), so it is real.
  const isReal = m.memLimit !== undefined && (m.source === 'docker' || (host !== undefined && m.memLimit < host))
  const limit = isReal ? m.memLimit : (host ?? m.memLimit)
  if (limit) {
    const f = m.memUsed / limit
    // Under 1 GiB, MiB: "128 / 512 MiB" reads better than "0.1 / 0.5 GiB".
    const [unit, scale] = limit < 2 ** 30 ? ['MiB', 2 ** 20] : ['GiB', 2 ** 30]
    const fmt = (b: number) => (unit === 'MiB' ? (b / scale).toFixed(0) : gib(b))
    lines.push({ label: 'RAM', fraction: f, text: `${pct(f)}  ${fmt(m.memUsed)} / ${fmt(limit)} ${unit}${isReal ? '' : ' host'}` })
  } else lines.push({ label: 'RAM', text: `${gib(m.memUsed)} GiB` })
  if (m.io) lines.push({ label: 'NET', text: m.io.net }, { label: 'BLOCK', text: m.io.block })
  return lines
}

// `columns` is the pane's body width: the bars narrow (to BAR_MIN) before the figures are cut.
export function metricsPane(ui: ElementTable, m: Metrics | null, everyS: number, columns: number) {
  const { Box, Text } = ui
  if (!m) return <Text dimColor>Press metrics on a container in /observe.</Text>
  const lines = metricLines(m)
  const labelWidth = Math.max(0, ...lines.map(l => l.label.length))
  const textWidth = Math.max(0, ...lines.map(l => l.text.length))
  const barWidth = Math.max(BAR_MIN, Math.min(BAR_MAX, columns - labelWidth - textWidth - 3))
  const line = (l: Line) => {
    if (l.fraction === undefined) {
      return (
        <Text wrap="truncate-end">
          {l.label.padEnd(labelWidth)} {l.text}
        </Text>
      )
    }
    const bar = meter(l.fraction, barWidth)
    return (
      <Text wrap="truncate-end">
        {l.label.padEnd(labelWidth)} <Text color={ACCENT}>{bar.filled}</Text>
        <Text dimColor>{bar.track}</Text> {l.text}
      </Text>
    )
  }
  return (
    <Box flexDirection="column">
      {m.error && <Text color="red">{m.error}</Text>}
      {m.checkedAt === undefined && <Text dimColor>Loading…</Text>}
      {m.gpuNote && <Text dimColor>{m.gpuNote}</Text>}
      {m.gpus?.map(g => (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold>GPU{g.index}</Text> {g.name}
            {g.powerW !== undefined && ` · ${g.powerW}/${g.powerCapW ?? '?'} W`}
            {g.tempC !== undefined && ` · ${g.tempC}°C`}
          </Text>
          {lines.filter(l => l.label.startsWith(`GPU${g.index} `)).map(line)}
        </Box>
      ))}
      {m.cpuMemNote && <Text dimColor>CPU/RAM: {m.cpuMemNote}</Text>}
      {lines.filter(l => !l.label.startsWith('GPU')).map(line)}
      {m.checkedAt !== undefined && <Text dimColor>{updated(m.checkedAt, everyS)}</Text>}
    </Box>
  )
}
