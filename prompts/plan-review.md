<task>
Review the implementation plan below that Claude Code is about to execute in the repository at the current working directory.
Verify the plan's claims and file references against the actual code where relevant.
Challenge correctness, completeness, missing edge cases, and risky design choices.
Do NOT implement anything or modify files. Review only.
</task>

<compact_output_contract>
Your first line must be exactly one of:
- ALLOW: <short reason>
- BLOCK: <short reason>
Do not put anything before that first line.
If you block, follow with a concise bullet list of the specific problems to fix in the plan.
</compact_output_contract>

<policy>
Use ALLOW when the plan is sound enough to execute, even if not perfect.
Use BLOCK only for issues that would cause wrong behavior, rework, or significant wasted effort.
</policy>

<plan_document>
{{PLAN}}
</plan_document>
