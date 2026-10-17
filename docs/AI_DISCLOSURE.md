# AI disclosure

## Tools used to build Stoop

- **Claude Code (Anthropic):**
  - architecture and planning
  - most of the code and tests
  - documentation drafts
  - The team reviewed, ran and tested everything. Commits carry a `Co-Authored-By` trailer where applicable.
- **Kiro:** planned for spec-first work on the Policy Kernel; see `AWS_BUILDER.md`.

## AI inside the product

- **Amazon Bedrock**, Nova 2 Lite (Claude Sonnet 4.6 if available):
  - Negotiator wording and decisions within guarded tools
  - photo identification
  - porch-frame vision (present / absent / unsure)
  - the simulator's planner
- **Offline mode:** a deterministic `ScriptedModel` drives the same Strands agents; the Ops header shows which mode is active.

## What AI never decides

Money movement, address release, deal acceptance and receipt signing are deterministic rules (`packages/policy`), enforced by the Settlement service.
