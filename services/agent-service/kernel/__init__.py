"""Kernel — low-level client modules shared by the orchestrator, domain
agents, and any future component that needs to talk to Sarvam or the edge
function.

The modules here are intentionally thin: they own the HTTP plumbing, the
retry/timeout policy, and the env-var resolution — nothing else. They do
NOT own business logic, conversation state, or domain-specific parsing.
"""
