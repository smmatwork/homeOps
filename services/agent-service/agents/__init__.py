"""Domain agents — callees of the orchestrator router.

Each agent is a class that takes its infrastructure dependencies (LLM client,
JSON utilities, tool-call validators) at construction time and exposes a
domain-scoped public API. Agents do not import the orchestrator; the
orchestrator imports and dispatches to them.
"""

from agents.base import AgentContext, AgentResult, AgentResultKind
from agents.helper_agent import HelperAgent

__all__ = [
    "AgentContext",
    "AgentResult",
    "AgentResultKind",
    "HelperAgent",
]
