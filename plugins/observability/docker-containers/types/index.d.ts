export type DockerContainer = {
  id: string // short id
  image: string
  command: string // quoted and truncated, as `docker ps` prints it
  created: string // e.g. "3 hours ago" (the CREATED column)
  status: string // e.g. "Up 3 hours", "Exited (0) 2 minutes ago"
  ports: string // as `docker ps` prints them, e.g. "0.0.0.0:8080->80/tcp"
  name: string
}

export type DockerSnapshot = {
  containers: DockerContainer[]
  unavailable?: string // no CLI or no daemon: a normal state, shown as one dim line
  error?: string // the daemon answered with a failure
  checkedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'docker-containers': { docker: DockerSnapshot }
  }
}
