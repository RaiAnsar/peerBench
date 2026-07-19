# peerBench

peerBench is a deliberately small Grok + MiMo review helper for Claude Code and Codex.
It provides one bounded advisory turn review, an optional native Git pre-push review, and
explicit read-only review/hunt commands. It does not run plan gates, file-write gates, merge
gates, background deep reviews, detached workers, or review queues.

## Reviewer policy

- **MiMo** reviews dirty worktrees at Stop. The evidence cap is 64 KiB and the model budget is
  15 seconds. A finding is advisory: it is shown once for that exact snapshot and never reopens
  or blocks the session.
- **Grok + MiMo** review an optional native pre-push update in parallel. The evidence cap is
  256 KiB and the entire hook has a 45-second deadline. A concrete model `BLOCK` stops the push;
  quota, authentication, network, timeout, or oversized-evidence failures are clearly reported as
  `UNREVIEWED` and do not trap the push.
- Grok is reserved for pushes and explicit commands, so routine Stop events do not consume its
  plan allowance.
- Kimi, Qwen, GLM, MiniMax, and Codex are not reviewer choices in this release.

Quota, authentication, rate-limit, timeout, and network failures enter bounded global cooldowns
before another model call is attempted.
Provider diagnostics are redacted before output or durable state. An unchanged successful or
blocking push verdict is cached by policy, reviewer identity, SHAs, and exact diff hash.

## Automatic behavior

The Claude and Codex plugin manifests contain one hook only:

| Event | Reviewer | Limit | Effect |
| --- | --- | ---: | --- |
| Stop with dirty worktree | MiMo | 15 seconds / 64 KiB | advisory, deduplicated, fail-open |

There is no SessionStart hook and no automatic native-hook installer. This is intentional: a
plugin update must never silently add Git hooks to unrelated repositories.

## Commands

- `/bench:review [--base <ref>]` — review current changes explicitly.
- `/bench:hunt [focus]` — bounded read-only repository bug hunt.
- `/bench:debug <failure>` — trace a specific failure to a root cause.
- `/bench:investigate <problem>` — deeper bounded read-only investigation.
- `/bench:health` — live-check only the active Grok/MiMo panel.
- `/bench:status [id]` — show recent traces for this workspace.
- `/bench:reviewers [grok mimo]` — show or select from the two supported reviewers.
- `/bench:off` / `/bench:on` — disable or enable one workspace; add `--global` for every workspace.

The Codex skill routes the requested subcommand directly. It does not rewrite `status`, `hunt`,
or other commands into `review`.

## Optional native pre-push review

Install it explicitly in the current repository:

```bash
node scripts/install-prepush.mjs
```

Inspect or remove it:

```bash
node scripts/install-prepush.mjs --status
node scripts/install-prepush.mjs --uninstall
```

The installer owns only a hook carrying peerBench's exact marker. If a pre-existing executable
hook exists, it is preserved as `pre-push.peerbench-original`, receives the same Git input first,
and is restored on uninstall. A global disable marker is checked by the shell dispatcher before it
starts Node.

The native reviewer consumes Git's four-field pre-push input rather than parsing an agent's shell
command. Existing destinations use the exact old-tree to new-tree transition. For a new branch on a
non-empty remote, it selects the nearest locally provable advertised ancestor/merge-base; it uses
Git's empty tree only when the remote genuinely advertises no heads. Missing remote objects yield
fetch guidance without launching a reviewer.

## Configuration

Shared state lives at:

```text
~/.claude/plugins/data/bench-shared/
```

`companion.json` holds the active reviewer list and MiMo endpoint settings. Keep credentials in the
gitignored `.keys` file and load them with:

```bash
node scripts/load-keys.mjs
```

Supported secret/config names are `MIMO_API_KEY`, `MIMO_BASE_URL`, `MIMO_MODEL`, and
`MIMO_THINKING`. Grok uses the locally installed `grok` CLI and its dedicated headless auth home.

## Install

Claude Code:

```text
/plugin marketplace add RaiAnsar/peerBench
/plugin install bench@aiwithrai
```

Codex:

```bash
codex plugin marketplace add RaiAnsar/peerBench
codex plugin add bench@aiwithrai
```

Local checkout:

```bash
npm test
npm run setup
```

The deployer removes peerBench-owned legacy plan/file/merge/deep/SessionStart/Bash-push hook
registrations while preserving unrelated Claude, Codex, and Git hooks. It never clears the global
disable marker and does not change the independent `openai/codex-plugin-cc` gate state.

## Safety and limits

- Reviewers receive no write tools. Grok is wrapped in macOS Seatbelt and its own nested sandbox is
  disabled only inside that stricter outer sandbox.
- Provider timeout kills the complete reviewer process group, not only its foreground child.
- Large evidence is never truncated and mislabeled clean; it becomes `UNREVIEWED`.
- No automatic path starts a background review after returning.
- `disabled-global` is authoritative across Claude, Codex, and native Git entrypoints.

Requires Node.js 20 or newer.
