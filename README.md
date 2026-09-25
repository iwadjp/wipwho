# wipwho v0.1

Splits mixed, uncommitted changes into per-request review patches, using the
evidence already sitting in your local Claude Code / Codex logs — and leaves
whatever it can't support with evidence as an explicit, unresolved patch. It
then verifies that applying every patch in order reproduces the exact working
tree it started from.

## What is wipwho

You've been going back and forth with Claude Code and/or Codex, maybe typing a
line or two by hand in between, and now `git status` shows a pile of dirty
files that answer several different requests at once. wipwho reads your local
agent transcripts (`~/.claude/projects`, `~/.codex/sessions`) next to the
current Git working tree and groups the uncommitted lines by which request
plausibly produced them, so you can review and commit them one request at a
time instead of as one undifferentiated blob.

It does not claim to know who wrote every line. Where the evidence doesn't
clearly support one request, it says so explicitly instead of guessing — see
[Unresolved / ambiguous behavior](#unresolved--ambiguous-behavior).

## Why

- It uses data you already have locally. No setup, no hooks, no API key, no
  change of habit — it works retroactively on today's mess.
- It groups by *request*, not by file or by tool. The prompt becomes the unit
  you review and commit against, instead of the diff.
- It is cross-agent. Neither vendor's own tooling can see the other's edits in
  the same working tree.

## Quick start

Windows / Git / Node.js 22+ (checked against Node 24.15, Git 2.51). No
dependencies, no install step.

```powershell
git clone https://github.com/iwadjp/wipwho.git
cd wipwho
$env:Path = (Resolve-Path .).Path + ';' + $env:Path
wipwho
```

That only changes `PATH` for the current PowerShell session. Move to any Git
repository and run `wipwho`. Without touching `PATH`, the equivalent is
`node <path-to-wipwho>\wipwho.cjs --repo <repo>`.

Try it without a real repository first: `node demo/run-demo.cjs` builds a
throwaway fixture and runs the real CLI end to end (see
[Demo](#demo)).

## Typical workflow

**1. See what's mixed together**

```
wipwho
```

Lists every group of dirty lines wipwho could tie to a request (title,
confidence, agent, session, files, resume command), plus an `AMBIGUOUS` group
and a `NO AGENT TRACE` group for everything it couldn't.

**2. Ask about one line**

```
wipwho why src/app.js:42
wipwho why src/app.js:42 --old
```

Shows confidence, agent, session, a short fixed-vocabulary request summary,
timestamps, the evidence fields that led to the verdict, and the exact
`claude --resume` / `codex resume` command to reopen that conversation.
`--old` reads the removed side of a line, and is used automatically for
deleted files.

**3. Split for review**

```
wipwho split --out <new-directory>
```

Writes one Git patch per request plus a separate `unresolved` patch for
everything without confirmed evidence, a `commit-plan.md`/`.json` (titles,
files, confidence, warnings, suggested subjects — no commit is run for you),
and self-verifies that applying every patch in order reproduces the exact
working tree byte-for-byte. See [Split verification](#split-verification).

`--repo DIR`, `--days N` (default 14), `--all`, `--json`, `--profile`
(timing to stderr), and `--no-cache` are available on the relevant commands.
Exit codes: `0` success, `2` input/read error, `3` `UNSAFE_TO_SPLIT`.

## Unresolved / ambiguous behavior

wipwho reports three states, and only one of them is a claim of authorship:

| Label | Meaning |
|---|---|
| `ESTIMATED` / `MEDIUM` | A changed line matches content the agent tool call wrote, with a successful tool result, a request that precedes the edit, and an on-disk save time inside that tool call's window. |
| `AMBIGUOUS` / `LOW` | Competing candidate requests, an unconfirmed tool result, a save outside the aligned window, or a time-only match. Not assigned to any request. |
| `NO AGENT TRACE` / `NONE` | No usable evidence was found in the available logs. |

v0.1 never emits `HIGH`. An mtime that merely falls near a shell command's
window is recorded but never used, by itself, as attribution
(`command=TIME_ONLY_NOT_ATTRIBUTION`). If a human retypes the exact bytes an
agent already wrote, inside the same tool interval, that is fundamentally
unobservable and stays `MEDIUM` at best — wipwho does not claim to resolve it.

`NO AGENT TRACE` does not mean "a human wrote this." It also covers edits
outside the scanned window, unsupported tools, dynamically assembled patches,
and missing or rotated logs. A short continuation message (e.g. "続けて" /
"continue") is treated as extending the prior request, not a new one.

## Split verification

- **The source repository is never modified.** The target is the full HEAD
  diff — staged, unstaged, and untracked combined — not just the index.
- Patches are ordered per request; unresolved lines go into their own
  `unresolved` patch and are never merged into a request's patch.
- If two different requests touch the same replacement/removal hunk in a way
  that can't be separated, `split` stops with `UNSAFE_TO_SPLIT` (exit 3)
  instead of guessing.
- The diffed set respects the repository's Git config and `.gitattributes`;
  it does not add changes for line endings Git itself treats as unchanged.
- Every patch is applied and checked in a temporary clone, changed-line counts
  are compared, and final bytes are hashed (SHA-256) before anything is
  written to the output directory.
- CRLF/LF base representation is recorded per file (`beforeTransform` and a
  `before` hash in the manifest). The raw HEAD blob and the checked-out bytes
  are not always the same; a patch applying cleanly under a different line
  ending is not proof the resulting content matches.
- Patches are scoped to the specific request's `+`/`-` lines even when
  unrelated changes appear as context in the same hunk.
- Patches are tied to the specific HEAD and hunk offsets used at export time;
  a different base or shifted offsets are outside what `split` guarantees.
  Successful `git apply` alone does not prove the same resulting content.
- Output always goes to a **new directory outside the source repository**,
  and an existing directory is never overwritten.
- Binary files, files over 4 MiB, and unsupported modes/links stop the
  default split; `--text-only` opts in to the supported subset explicitly and
  records the rest as omissions in the manifest.

```powershell
wipwho split --text-only --out "$env:TEMP\wipwho-review-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

**What the hash match does and does not prove.** A matching SHA-256 after
independently reapplying every patch in a fresh clone proves the patches
*recompose the same working-tree content* they were exported from. It says
nothing about whether the attribution attached to each patch is correct —
that judgment is entirely the `ESTIMATED` / `AMBIGUOUS` / `NO AGENT TRACE`
labels described above. `demo/run-demo.cjs` and
`test/verify-export.cjs` both run this check with an independent verifier,
separate from the code that generated the patches.

## Supported environment

- Windows, Node.js 22+ (checked with Node 24.15), Git 2.51+.
- Reads `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`
  (both real formats — see [Windows line-ending support](#windows-line-ending-support)
  and the demo for how a fixture reproduces the same schemas without needing
  a real session).
- No network access. No dependency on any specific project structure.

## Windows line-ending support

Verified with actual `git diff`/checkout output, not a hand-written model of
Git's behavior, under:

- `core.autocrlf=false`
- `core.autocrlf=true`
- `.gitattributes` with `text eol=lf`
- `.gitattributes` with `text eol=crlf`

In each case, split's exact-byte reconstruction was checked against the
real checked-out bytes for that configuration (`evidence/line-ending-validation.json`,
`test/line-endings.test.cjs`).

**Not covered**, and not guaranteed to work correctly:

- Arbitrary or inconsistent line endings within a single file.
- Custom Git filters (clean/smudge), `ident`, or `working-tree-encoding`
  attributes — files affected by these are reported as
  `UNSUPPORTED_CHECKOUT_FILTER`/`UNSUPPORTED_CHECKOUT_TRANSFORM` and excluded,
  not silently mishandled.
- Line-ending-only differences that Git itself does not consider a change.

## Limitations / check

- Attribution covers static `Edit`/`Write`/`MultiEdit`/`apply_patch` calls.
  Conditional, unawaited, or dynamically assembled `exec` patches are treated
  as unsupported, not interpreted.
- wipwho does not check syntax or test correctness, does not identify a
  non-agent human author, and does not reconstruct history absent from the
  local logs it can read.
- Renames are treated as delete + add; the tool does not guess line
  attribution across the rename.
- Unmerged index state, and a staged deletion overlapping an untracked file
  at the same path, are not supported.
- Large logs take a few seconds warm; a first run or `--no-cache` takes
  longer because nothing is cached yet.

Run `npm test` in this directory to check the current build (51 tests).
Full validation detail and the fixture matrix are in `invention-report.md`
and `evidence/`.

## Privacy

- No network access. wipwho reads only the target Git working tree and your
  local agent transcripts.
- Normal output, `--json`, and the commit plan never include full prompts,
  full command text, absolute paths, or your username. Request titles are a
  short, fixed vocabulary; open the original conversation with the printed
  `resume` command if you need the exact wording.
- Cache: `%LOCALAPPDATA%\wipwho\cache-v01`. It stores derived data only — line
  hashes, timestamps, session IDs, and safe classifications — never raw
  conversation text. Every cache hit re-hashes the source log and checks that
  the parser hasn't changed; a corrupted cache entry is ignored and
  re-parsed. `--no-cache` disables it entirely.
- **Split patches contain your real source, and can contain secrets.** Treat
  the output directory as sensitive: it isn't shared anywhere by wipwho, but
  it also isn't encrypted, and the verification clone and cache aren't
  automatically deleted.

## wipwho vs. ai-blame

Both tools attribute uncommitted or historical changes to an AI agent from
local logs. They produce different things, and neither is a strict superset
of the other:

| | wipwho | ai-blame |
|---|---|---|
| Unit of output | request (one group per prompt) | line / file (`blame`, `report`, `stats`, `timeline`) |
| Unresolved lines | explicit `AMBIGUOUS` / `NO AGENT TRACE` labels | shown as `-` (unattributed), no distinct label |
| Review artifact | `split` exports one patch per request + an `unresolved` patch, self-verified by byte hash | no patch/export command; `annotate` writes sidecar/comment metadata |
| Reconstruction check | yes (independent re-apply + hash) | not applicable (no split step) |

This is a difference in workflow and output shape, not a claim that one is
generally better than the other. The comparison was run against the same
fixture logs given to both tools (ai-blame 0.5.3), not a description from
memory of either tool's docs alone.

## Demo

```
node demo/run-demo.cjs
```

Builds a disposable Git repository and a disposable fake `HOME`
(`.claude/projects/…`, `.codex/sessions/…`) in a temp directory, points the
real `wipwho` CLI at them, and prints:

- one `ESTIMATED`/`MEDIUM` request reconstructed from a genuine Claude Code
  JSONL log,
- one `ESTIMATED`/`MEDIUM` request reconstructed from a Codex-format JSONL log
  that is a **controlled fixture built for this demo** (`auditOrigin:
  "CONTROLLED_REPLAY_NOT_AI_SESSION"`), not a captured real session,
- one manually edited line with no log entry anywhere (`NO AGENT TRACE`),
- one logged edit whose on-disk save time falls outside the tool's window,
  which is deliberately **not** credited to that request (`AMBIGUOUS`/`LOW`),
- a `split --out` run followed by an independent reconstruction check
  (`test/verify-export.cjs`) confirming the patches recompose the exact
  fixture bytes.

It never reads or writes your real `~/.claude` or `~/.codex` directories —
`HOME`/`USERPROFILE` are overridden only for the child process it spawns, for
the duration of the script. Pass `--keep` to leave the fixture and split
output on disk for inspection instead of deleting them afterward.

## Development status

Prototype, internal-use quality. Published at
[github.com/iwadjp/wipwho](https://github.com/iwadjp/wipwho). See
`invention-report.md` for the full validation history, known bugs found and
fixed during development, and remaining scope. Public v0.1.0 is a source-only
tagged release; there is no issue triage process and no npm package yet — treat
it as a working prototype, not a maintained product.

## Related tools

This project is part of a small set of tools for investigating AI-coding and
debugging problems that Git alone cannot explain.

- [Timewitness](https://github.com/iwadjp/timewitness) — check whether a regression test fails before a fix and passes after it.
- [wipwho](https://github.com/iwadjp/wipwho) — split mixed uncommitted Claude/Codex changes into request-level patches.
- [Ember](https://github.com/iwadjp/ember) — recover source retained by a still-running Node.js process.
- [Worldbisect](https://github.com/iwadjp/worldbisect) — reduce same-commit environment differences to an observed 1-minimal reproducing set.
- [Afterimage](https://github.com/iwadjp/afterimage) — inspect retained NTFS USN history after an agent run.

[Overview and articles](https://blog2020.iwadjp.com/2026/09/18/ai-coding-debugging-tools-portfolio/)

**Article:** [Claude CodeとCodexの変更が混ざった。未commitのdirty treeを依頼ごとに分けるwipwho](https://blog2020.iwadjp.com/2026/09/17/wipwho-split-mixed-dirty-tree-by-request/)
