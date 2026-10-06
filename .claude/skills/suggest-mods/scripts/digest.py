#!/usr/bin/env python3
"""Digest Claude Code transcripts into a short markdown report of habits and friction.

Reads ~/.claude/projects/<project>/<session>.jsonl (stdlib only) and prints counts, never raw
tool output. Run with --help for options.
"""
import argparse
import collections
import datetime as dt
import json
import os
import re
import sys

DEFAULT_DIR = os.path.expanduser("~/.claude/projects")
HISTORY = os.path.expanduser("~/.claude/history.jsonl")
PROMPT_SNIPPET = 160
STOPWORDS = set(
    "the a an and or to of in on for with is it this that be as at by from are was were i you we "
    "me my your our it's its can please just not do does did have has had will would should could "
    "if then than so but what which when how all any also into out up about there here let's lets "
    "make sure now use using used one two more some only same new need want like see get go run "
    "add set file files code line lines change changes work working".split()
)
# Tool-result phrases that mean the user or a policy stopped the agent.
FRICTION = {
    "rejected by user": "doesn't want to proceed with this tool use",
    "interrupted by user": "Request interrupted by user",
    "blocked by policy/classifier": "was denied by the Claude Code auto mode classifier",
}
SECRET = re.compile(r"(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,}|Bearer\s+\S+|xox[baprs]-\S+)")
# Older transcripts have no `origin`; these prefixes mark injected text that is not a human prompt.
INJECTED_PREFIXES = ("<", "[", "This session is being continued", "Continue from where you left off", "Base directory for this skill")
ERROR_HINT = re.compile(r"error|fail|not found|denied|cannot|unable|invalid|timed? ?out|refused|no such", re.I)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-")


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--projects-dir", default=DEFAULT_DIR, help="where the transcripts live")
    p.add_argument("--days", type=int, default=30, help="only sessions active in the last N days (0 = all)")
    p.add_argument("--project", default="", help="substring filter on the project directory name")
    p.add_argument("--top", type=int, default=12, help="rows per table")
    p.add_argument("--prompts", type=int, default=40, help="recent user prompts to list verbatim (0 = none)")
    p.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    return p.parse_args()


def project_label(path):
    if "scratch-workspaces" in path:
        return "scratch"
    parts = [x for x in re.split(r"[/-]" if "/" not in path else "/", path) if x]
    return "/".join(parts[-2:]) if len(parts) > 1 else path


def first_line(s, n=120):
    s = SECRET.sub("<redacted>", str(s)).strip().splitlines()
    return (s[0] if s else "")[:n]


def error_line(s, n=90):
    lines = [l.strip() for l in SECRET.sub("<redacted>", str(s)).splitlines() if l.strip()]
    for l in lines:
        if ERROR_HINT.search(l) and not l.startswith("Exit code"):
            return l[:n]
    return (lines[0] if lines else "")[:n]


def is_human(o, text):
    origin = o.get("origin")
    if isinstance(origin, dict):
        return origin.get("kind") == "human" and not text.startswith("<")
    return not o.get("isMeta") and not o.get("sourceToolUseID") and not text.startswith(INJECTED_PREFIXES)


def words(text):
    return [w for w in re.findall(r"[a-z][a-z0-9'+-]{2,}", text.lower()) if w not in STOPWORDS]


class Digest:
    def __init__(self, top):
        self.top = top
        self.sessions = {}
        self.tools = collections.Counter()
        self.mcp = collections.Counter()
        self.bash_verbs = collections.Counter()
        self.slash = collections.Counter()
        self.typed_slash = collections.Counter()
        self.mods = collections.Counter()
        self.skills = collections.Counter()
        self.tool_errors = collections.Counter()
        self.error_lines = collections.Counter()
        self.friction = collections.Counter()
        self.friction_tools = collections.Counter()
        self.compactions = 0
        self.hours = collections.Counter()
        self.bigrams = collections.Counter()
        self.unigrams = collections.Counter()
        self.prompts = []
        self.titles = []
        self.tool_use_names = {}

    def session(self, sid, project):
        return self.sessions.setdefault(sid, {"project": project, "prompts": 0, "tools": 0, "first": None, "last": None})

    def add_line(self, o, project):
        t = o.get("type")
        sid = o.get("sessionId") or "?"
        cwd = o.get("cwd")
        s = self.session(sid, project_label(cwd) if cwd else project)
        ts = o.get("timestamp")
        if ts:
            s["first"] = s["first"] or ts
            s["last"] = ts
        if t in ("custom-title", "agent-name", "ai-title"):
            title = o.get("customTitle") or o.get("agentName") or o.get("title")
            if title:
                self.titles.append((project, title))
            return
        if o.get("isCompactSummary"):
            self.compactions += 1
        m = o.get("message") or {}
        c = m.get("content")
        if t == "user":
            if isinstance(c, str):
                self.add_prompt(o, c, ts, s, project)
            elif isinstance(c, list):
                for p in c:
                    if p.get("type") == "text":
                        self.add_prompt(o, p.get("text", ""), ts, s, project)
                    elif p.get("type") == "tool_result":
                        self.add_result(p)
        elif t == "assistant" and isinstance(c, list):
            for p in c:
                if p.get("type") == "tool_use":
                    self.add_tool_use(p, s)

    def add_prompt(self, o, text, ts, s, project):
        origin = o.get("origin")
        if isinstance(origin, dict) and origin.get("kind") == "plugin":
            self.mods[origin.get("name", "?")] += 1
        for cmd in re.findall(r"<command-name>(/[\w:-]+)</command-name>", text or ""):
            self.slash[cmd] += 1
        if not text or not is_human(o, text):
            return
        project = s["project"]
        s["prompts"] += 1
        if ts:
            self.hours[dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().hour] += 1
        ws = words(text)
        self.unigrams.update(set(ws))
        self.bigrams.update({f"{a} {b}" for a, b in zip(ws, ws[1:])})
        self.prompts.append((ts or "", project, first_line(text, PROMPT_SNIPPET)))

    def add_tool_use(self, p, s):
        name = p.get("name", "?")
        s["tools"] += 1
        self.tools[name] += 1
        self.tool_use_names[p.get("id")] = name
        inp = p.get("input") or {}
        if name.startswith("mcp__"):
            server, _, tool = name[5:].partition("__")
            # claude.ai connectors are keyed by UUID; their tool names carry the product name.
            self.mcp[tool.split("_")[0] if UUID.match(server) else server] += 1
        elif name == "Bash":
            cmd = (inp.get("command") or "").strip()
            # Skip leading env assignments and `cd dir &&` so the real verb shows.
            cmd = re.sub(r"^(cd\s+\S+\s*(&&|;|\n)\s*)+", "", cmd)
            cmd = re.sub(r"^([A-Z_]+=\S+\s+)+", "", cmd)
            verb = cmd.split()[0] if cmd else ""
            if verb:
                self.bash_verbs[verb[:24]] += 1
        elif name == "Skill":
            self.skills[inp.get("skill", "?")] += 1
        elif name == "SlashCommand":
            self.slash[(inp.get("command") or "?").split()[0]] += 1

    def add_result(self, p):
        content = p.get("content")
        text = content if isinstance(content, str) else json.dumps(content)[:400]
        tool = self.tool_use_names.get(p.get("tool_use_id"), "?")
        for label, needle in FRICTION.items():
            if needle in text:
                self.friction[label] += 1
                self.friction_tools[f"{label}: {tool}"] += 1
                return
        if p.get("is_error"):
            self.tool_errors[tool] += 1
            self.error_lines[f"{tool}: {error_line(text)}"] += 1

    def report(self):
        top = self.top
        sess = self.sessions
        by_project = collections.Counter()
        prompts_by_project = collections.Counter()
        for s in sess.values():
            by_project[s["project"]] += 1
            prompts_by_project[s["project"]] += s["prompts"]
        total_prompts = sum(prompts_by_project.values())
        out = ["# Transcript digest", ""]
        out.append(f"Sessions: {len(sess)} · user prompts: {total_prompts} · tool calls: {sum(self.tools.values())} · compactions: {self.compactions}")
        out.append("")
        out += table("Projects", "project | sessions | prompts", [(p, n, prompts_by_project[p]) for p, n in by_project.most_common(top)])
        out += table("Tools", "tool | calls", self.tools.most_common(top))
        out += table("Shell verbs (first word of Bash commands)", "verb | calls", self.bash_verbs.most_common(top))
        out += table("MCP servers", "server | calls", self.mcp.most_common(top))
        out += table("Slash commands (in transcripts)", "command | uses", self.slash.most_common(top))
        out += table("Slash commands (typed in the terminal, history.jsonl)", "command | uses", self.typed_slash.most_common(top))
        out += table("Skills", "skill | loads", self.skills.most_common(top))
        out += table("Mods that sent prompts or commands", "mod | messages", self.mods.most_common(top))
        out += table("Friction (user or policy stopped the agent)", "kind | count", self.friction.most_common())
        out += table("Friction by tool", "kind: tool | count", self.friction_tools.most_common(top))
        out += table("Tool errors", "tool | errors", self.tool_errors.most_common(top))
        out += table("Most repeated error lines", "error | count", self.error_lines.most_common(top))
        out += table("Prompt themes (words appearing in the most prompts)", "word | prompts", self.unigrams.most_common(top * 2))
        out += table("Prompt themes (bigrams)", "bigram | prompts", self.bigrams.most_common(top))
        busy = sorted(self.hours.items())
        if busy:
            out.append("## Prompts by local hour")
            out.append("")
            out.append(" ".join(f"{h:02d}:{n}" for h, n in busy))
            out.append("")
        if self.titles:
            out.append("## Session titles")
            out.append("")
            seen = set()
            for project, title in self.titles[-top * 2:]:
                if title not in seen:
                    seen.add(title)
                    out.append(f"- {project}: {title}")
            out.append("")
        return "\n".join(out)

    def to_json(self):
        return {
            "sessions": len(self.sessions),
            "tools": self.tools.most_common(),
            "bash_verbs": self.bash_verbs.most_common(),
            "mcp": self.mcp.most_common(),
            "slash": self.slash.most_common(),
            "typed_slash": self.typed_slash.most_common(),
            "skills": self.skills.most_common(),
            "mods": self.mods.most_common(),
            "friction": self.friction.most_common(),
            "friction_tools": self.friction_tools.most_common(),
            "tool_errors": self.tool_errors.most_common(),
            "error_lines": self.error_lines.most_common(40),
            "unigrams": self.unigrams.most_common(60),
            "bigrams": self.bigrams.most_common(40),
            "compactions": self.compactions,
            "titles": self.titles,
            "prompts": self.prompts,
        }


def table(title, header, rows):
    if not rows:
        return []
    cols = header.split(" | ")
    lines = [f"## {title}", "", "| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for r in rows:
        lines.append("| " + " | ".join(str(x).replace("|", "\\|") for x in r) + " |")
    return lines + [""]


def main():
    a = parse_args()
    cutoff = None
    if a.days:
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)).timestamp()
    d = Digest(a.top)
    scanned = 0
    for proj in sorted(os.listdir(a.projects_dir)) if os.path.isdir(a.projects_dir) else []:
        if a.project and a.project not in proj:
            continue
        pdir = os.path.join(a.projects_dir, proj)
        if not os.path.isdir(pdir):
            continue
        label = project_label(proj)
        for f in os.listdir(pdir):
            path = os.path.join(pdir, f)
            if not f.endswith(".jsonl") or (cutoff and os.path.getmtime(path) < cutoff):
                continue
            scanned += 1
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        d.add_line(json.loads(line), label)
                    except (json.JSONDecodeError, AttributeError, TypeError):
                        continue
    if os.path.exists(HISTORY):
        with open(HISTORY, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    h = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if cutoff and h.get("timestamp", 0) / 1000 < cutoff:
                    continue
                if a.project and a.project not in (h.get("project") or ""):
                    continue
                shown = (h.get("display") or "").strip()
                if shown.startswith("/"):
                    d.typed_slash[shown.split()[0]] += 1
    if not scanned:
        sys.exit(f"no transcripts found under {a.projects_dir} (days={a.days}, project={a.project!r})")
    if a.json:
        print(json.dumps(d.to_json(), indent=1))
        return
    print(d.report())
    if a.prompts:
        print(f"## Recent user prompts (last {a.prompts})\n")
        for ts, project, text in sorted(d.prompts)[-a.prompts:]:
            print(f"- {ts[:10]} {project}: {text}")


if __name__ == "__main__":
    main()
