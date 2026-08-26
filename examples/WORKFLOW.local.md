---
version: 1
project:
  name: personal
  agent_profile: default
tracker:
  kind: local
  provider:
    project_id: personal
    context_label: Personal
  required_labels: []
  active_states: [Todo, In Progress, Human Review]
  terminal_states: [Done, Canceled]
policy:
  polling:
    interval_ms: 5000
  workspace:
    root: .dsh-dashboard/workspaces
  hooks:
    timeout_ms: 60000
    # Git projects are already materialized as detached worktrees here.
  agent:
    max_concurrent_agents: 3
    max_concurrent_agents_by_state: {}
    max_turns: 20
    max_retry_backoff_ms: 300000
  lifecycle:
    enabled: true
    # Use this exact pipeline for both Personal and Work projects.
    state_roles:
      Todo: [planning, implementation, qa, review, delivery]
      In Progress: [planning, implementation, qa, review, delivery]
      Human Review: [qa, review, delivery]
    roles:
      planning: { permission_preset: read-only, max_turns: 2 }
      implementation: { permission_preset: workspace-write }
      qa: { permission_preset: workspace-write, max_turns: 3 }
      review: { permission_preset: read-only, max_turns: 2 }
      delivery: { permission_preset: workspace-write, max_turns: 3 }
      escalation: { permission_preset: read-only, max_turns: 2 }
    escalate_after_failures: 2
    high_risk_labels: [security, high-risk, architecture]
  dashboard:
    visible_states: [Backlog, Todo, In Progress, Human Review, User Test]
---

Work on {{ issue.identifier }}: {{ issue.title }}.

{{ issue.description }}

Use the available local task integration to keep the task workpad and state current. Continue until the task leaves an active state or a true external blocker prevents progress.

User Test requires structured, same-commit evidence recorded through the local
task tool: passing automated tests, passing automated review with zero unresolved
blocking findings, PR number/URL/head SHA, deployed SHA, and passing live
verification timestamp/URL/SHA. Tests and review happen before PR/manual testing.
Changing the commit starts a new attempt; Personal and Work use this same rule.
