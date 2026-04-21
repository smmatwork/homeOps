"""Agent contract — AgentContext and AgentResult.

The orchestrator router constructs an AgentContext once per request and hands
it to the domain agent it routes to. The agent returns an AgentResult that
the router renders into the final HTTP response.

These are pure schemas — no logic, no I/O. They exist so router.py and the
domain agents (HelperAgent, ChoreAgent, future Service/Procurement agents)
can agree on the handoff shape without importing each other.

Today only ChoreAgent will use this — HelperAgent keeps its legacy
`dict | None` return shape for now and the router adapts at the call site.
The HelperAgent migration to return AgentResult directly is a separate
follow-up commit, not part of the router extraction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from orchestrator.intent import ExtractedIntent


ChatFn = Callable[..., Awaitable[Any]]
EdgeExecuteFn = Callable[..., Awaitable[Any]]
TelemetryFn = Callable[..., None]


@dataclass(frozen=True)
class AgentContext:
    """Everything a domain agent needs for one conversational turn.

    Built once per request by the router. `frozen=True` signals that agents
    MUST NOT mutate context state — any stateful effect (stash a pending
    confirmation, increment a clarification counter) goes through
    orchestrator.state functions or is returned via AgentResult.

    `lf_span` and `chat_fn` / `edge_execute_tools` are injected callables
    rather than inlined clients so the module has no import dependency on
    main.py — same pattern as orchestrator.intent and orchestrator.context.
    """

    # ── Raw request inputs ───────────────────────────────────────────────
    messages: list[dict[str, Any]]
    model: str
    temperature: float | None
    max_tokens: int | None

    # ── Correlation / identity headers ───────────────────────────────────
    req_id: str
    conv_id: str
    sess_id: str
    user_id: str
    household_id: str

    # ── Router-derived state ─────────────────────────────────────────────
    pending_key: str           # conv_id if present, else "fallback:<user>:<hh>"
    last_user_text: str        # most recent user message, pre-extracted
    facts_section: str         # FACTS block (may be "" when Supabase is unreachable)
    is_onboarding: bool        # system-prompt-driven skip-routing flag

    # ── Injected infrastructure handles ──────────────────────────────────
    chat_fn: ChatFn
    edge_execute_tools: EdgeExecuteFn
    lf_span: TelemetryFn       # no-op when Langfuse is absent


AgentResultKind = Literal[
    "text",                 # final_text direct reply (no writes)
    "tool_calls_preview",   # plan-confirm preview; router stashes + returns preview text
    "tool_calls_execute",   # execute tool_calls now (LLM chose a tool-use path)
    "clarification",        # structured clarification payload for the UI
    "defer",                # this agent does not handle the turn; router falls through
]


@dataclass
class AgentResult:
    """The shape an agent returns. Exactly one of the payload fields is
    populated based on `kind`.

    Payload contract per kind:
      text                -> text: str
      tool_calls_preview  -> tool_calls: list[dict], preview_intent: ExtractedIntent,
                             preview_match_ids: list[tuple[str,str]], text: str
                             (preview text; the router stashes the confirmation
                             and returns this text unchanged)
      tool_calls_execute  -> tool_calls: list[dict]
      clarification       -> clarification: dict (key, question, options, allowMultiple)
      defer               -> (no payload; router routes to the next agent)
    """

    kind: AgentResultKind
    text: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    clarification: dict[str, Any] | None = None
    preview_intent: ExtractedIntent | None = None
    preview_match_ids: list[tuple[str, str]] | None = None
    # Free-form metadata the router may want to propagate (e.g., user_summary
    # when coming from HelperAgent). Intentionally loose — callers that care
    # read specific keys by name.
    metadata: dict[str, Any] = field(default_factory=dict)


__all__ = [
    "AgentContext",
    "AgentResult",
    "AgentResultKind",
    "ChatFn",
    "EdgeExecuteFn",
    "TelemetryFn",
]
