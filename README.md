# contextrie-mcp

Your coding agent calls `select_context("<task>")` and gets the files in your repo worth reading for that task, ranked, each with a score and a reason. Built on [Contextrie](https://github.com/feuersteiner/contextrie).

```
Contextrie picked 8 of 422 files for: "add a daily usage limit to TenderReply's draft endpoint"

Project instructions (always listed):
- CLAUDE.md
- README.md

Ranked (score 0–1: reason):
1. lastware/src/routes/api/tenderreply/draft/+server.ts · 1.00: The source directly implements daily usage limits on TenderReply's draft endpoint…
2. lastware/src/routes/api/run/+server.ts · 0.90: implements daily usage limits and rate limiting in an API endpoint…
3. lastware/src/lib/tenderreply/types.ts · 0.80: defines … constants for drafts per day…
```

**Status:** early (0.1.0). Not on npm yet: until it is, the commands below run it straight from GitHub. Node 22+.

## Install

It needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in its environment. The key is only read from the environment and never written to disk.

**Claude Code** (inherits your shell's environment):

```sh
claude mcp add contextrie -- npx -y github:mlgxiii/contextrie-mcp
```

**Cursor**: `~/.cursor/mcp.json` (keep keys out of the project's `.cursor/mcp.json`):

```json
{ "mcpServers": { "contextrie": { "command": "npx", "args": ["-y", "github:mlgxiii/contextrie-mcp"], "env": { "ANTHROPIC_API_KEY": "${env:ANTHROPIC_API_KEY}" } } } }
```

**Codex**: `~/.codex/config.toml`:

```toml
[mcp_servers.contextrie]
command = "npx"
args = ["-y", "github:mlgxiii/contextrie-mcp"]
env = { ANTHROPIC_API_KEY = "sk-ant-…" }
```

To make the agent use it on every task, add one line to `CLAUDE.md` / `AGENTS.md`: *"At the start of a task, call `select_context` with the task."*

## Tools

| Tool | Input | Does |
| --- | --- | --- |
| `select_context` | `task`, `limit?` (default 8), `paths?` (globs) | Indexes new or changed files, judges every file's summary against the task, returns the top 3 plus anything scoring ≥ 0.3, at most `limit`. `README`, `CLAUDE.md`, `AGENTS.md` and Cursor rules are always listed. |
| `index` | `confirm?`, `paths?` | Indexes ahead of time. Needed with `confirm: true` when more than `CONTEXTRIE_MAX_INDEX` files need indexing. |

## How it works

1. **Files:** `git ls-files` plus untracked files that aren't ignored. Lockfiles, binaries, minified files and build folders are skipped; add globs to `.contextrieignore` to skip more.
2. **Index:** Contextrie's `IndexingAgent` writes a title, description and keypoints per file (first 32 KB). Cached by content hash in `.contextrie/sources.json` (the `@contextrie/cli` format), so only new or changed files cost a model call. Commit it and teammates skip indexing.
3. **Judge:** Contextrie's `JudgeAgent` scores every file's summary against the task, at temperature 0. Judgments are cached by task and file content in `.contextrie/judgments.json` (git-ignored), so the same task returns the same list.
4. **Errors:** files that fail to index or judge are listed in the result and left out of the ranking, never dropped silently.

## Cost and speed

One model call per file to index (once, then only changed files), and one per file per new task to judge. On a 422-file repo with `gpt-4.1-mini`: first index 52 s; a new task 10–15 s; a repeated task 0.1 s.

| Variable | Default | |
| --- | --- | --- |
| `CONTEXTRIE_MODEL` | `claude-haiku-5-5` / `gpt-4.1-mini` | Model for indexing and judging |
| `CONTEXTRIE_MAX_INDEX` | 500 | Files indexed without `confirm` |
| `CONTEXTRIE_CONCURRENCY` | 64 | Model calls in flight. At 128, OpenAI rate limits started failing calls |
| `CONTEXTRIE_ROOT` | working directory | Repo to index (widened to its git root) |
| `DEBUG` | | Contextrie's logs on stderr |

## Benchmark

`npm run bench -- <repo> --n 10` takes the last 10 commits that touched 2–20 files: the commit subject is the task and the changed files are the answer. It compares recall@8 with a TF-IDF word-overlap ranking (roughly what grep finds).

On a 422-file TypeScript/SvelteKit monorepo (2026-10-13): **mean recall@8 58% vs 20%; Contextrie wins 9, ties 1 (both 0%), loses 0.** Caveats: commit subjects describe the finished change, and the index reflects today's tree, which helps both arms.

## Develop

```sh
npm install
npm run build                                  # dist/index.js, Contextrie bundled (it ships TypeScript only)
npx tsx scripts/smoke.ts <repo> "<task>"       # call the built server over stdio, like an agent does
npm run bench -- <repo>
```

## License

MIT. Contextrie (`@contextrie/core`, MIT) is bundled into `dist/`.
