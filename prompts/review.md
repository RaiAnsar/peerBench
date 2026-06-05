<task>
Run a code review of the git changes below from the repository at the current working directory.
Challenge correctness, second-order failures, empty-state behavior, and design tradeoffs.
Untracked files listed below are part of the change set — review their full content.
Do NOT implement anything or modify files. Review only.
</task>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
If you block, follow with a concise bullet list of specific findings (file:line where possible).
</compact_output_contract>

GIT STATUS:
{{GIT_STATUS}}

GIT DIFF:
{{GIT_DIFF}}

UNTRACKED FILES:
{{UNTRACKED}}
