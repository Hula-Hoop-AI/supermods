# git-account-hint

When GitHub refuses a git command for the account it authenticated as, this mod tells Claude
which other accounts are signed in to `gh` on the machine and how to run the command as one of
them. Claude can then retry on its own instead of stopping to ask you which account to use.

Example: `git push` fails with `Permission to org/repo.git denied to alice`. Claude also reads:

> git-account-hint: GitHub refused this git command for the account alice. Other accounts signed
> in to gh on this machine: bob. To run the command as one of them without changing the active
> account, use the repository's https URL and put these options right after `git`: …

## Install

```
/plugin marketplace add Hula-Hoop-AI/supermods
/plugin install git-account-hint@supermods
```

Needs the [`gh` CLI](https://cli.github.com), with the accounts you use signed in
(`gh auth login`, once per account).

## What triggers it

Any Bash command that runs `git` (push, fetch, pull, clone, ls-remote, submodule, …) whose
output has one of:

- `Permission to <repo> denied to <account>`
- `could not read Username for 'https://github.com'`
- `Authentication failed for 'https://github.com'`
- `The requested URL returned error: 403`
- `Repository not found`
- `Permission denied (publickey)`

The refused account is left out of the suggestions. With no other account signed in, or without
`gh`, the note says so.

## Configuration

None.

## What it touches

Events: `tool.call` for the Bash tool (it reads the command and its output after it ran, and
adds a note only Claude sees; the output itself is unchanged).

Capabilities: `$.process.run` for `gh auth status`, only after a refusal. It never reads a
token: the retry it describes asks `gh` for one at the moment git needs it. No network and no
file access.

It makes Claude more likely to retry a refused git command as another of your accounts. Claude
is told to say which account it used; your permission settings still decide whether the retry
runs.

## Limitations

- GitHub over `gh` only: other hosts and credential stores are not covered.
- It lists the signed-in accounts, not which of them has access to the repository.
- `Repository not found` is also what a mistyped URL prints, so the note can appear for a typo.
