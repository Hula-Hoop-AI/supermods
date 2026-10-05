// Python run under the interpreter of the user's `modal` CLI, for what the CLI does not print:
// who created each app, and who the token belongs to. It prints { me, env, apps } for the
// running containers, grouped by app. It reaches into the modal client's private API
// (`_Client`, `modal_proto`), which may change in any release, so the caller falls back to
// `modal container list` when it fails.
export const HELPER_PY = `
import asyncio, json, sys
from modal.client import _Client
from modal.config import config
from modal_proto import api_pb2

async def running_apps(client, env):
    tasks = (await client.stub.TaskList(api_pb2.TaskListRequest(environment_name=env))).tasks
    apps = {}
    for t in tasks:
        app = apps.setdefault(t.app_id, {"app_id": t.app_id, "app_name": t.app_description, "containers": []})
        app["containers"].append({"container_id": t.task_id, "started_at": t.started_at})
    lifecycles = await asyncio.gather(*(
        client.stub.AppGetLifecycle(api_pb2.AppGetLifecycleRequest(app_id=a)) for a in apps
    ))
    for app, resp in zip(apps.values(), lifecycles):
        lc = resp.lifecycle
        app["created_by"] = lc.created_by or lc.deployed_by
    return list(apps.values())

async def main(env):
    env = env or config.get("environment") or ""
    client = await _Client.from_env()
    apps = await running_apps(client, env)
    tok = await client.stub.TokenInfoGet(api_pb2.TokenInfoGetRequest())
    print(json.dumps({"me": tok.user_identity.username, "env": env, "apps": apps}))

asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else ""))
`

// Finds the python that runs the user's \`modal\` CLI by reading the CLI script's shebang
// (pip, pipx and uv installs all write one), then runs the script on stdin under it.
// A pyenv shim is a bash script, so it is resolved to the real CLI first.
const FIND_PYTHON = [
  'm=$(command -v modal) || exit 127',
  'case "$(head -1 "$m")" in *python*) ;; *) m=$(pyenv which modal 2>/dev/null) || exit 127 ;; esac',
  'py=$(head -1 "$m" | cut -c3-)',
  'exec $py - "$@"',
].join('\n')

export const helperArgv = (env: string) => ['sh', '-c', FIND_PYTHON, 'modal-containers-helper', env]
