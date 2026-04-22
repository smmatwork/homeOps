"""Run pipeline — the `/v1/runs/start` endpoint and everything it needs.

Each graph_key in the handler executes a different LangGraph compiled from
nodes that live in this package. The three supported graphs:

  - chores.visitors_cleaning_v1 — build a visitor-prep cleaning plan from
    signals + templates, emit db.insert proposals for household chores.
  - signals.capture_v1 — extract household events or cleaning feedback
    from chat text into db.insert proposals for signals tables.
  - chores.manage_v1 (default chores.*) — LLM-driven generic chore
    proposal with strict JSON parsing + two-pass repair + fallback.

The handler module is self-contained; it only takes injected edge/LLM
clients so main.py keeps the /v1/runs/start endpoint as a thin wrapper.
"""

from runs.handler import run_start_handler
from runs.models import (
    RunStartRequest,
    RunStatusResponse,
    ProposedAction,
    ProposalOutput,
)


__all__ = [
    "run_start_handler",
    "RunStartRequest",
    "RunStatusResponse",
    "ProposedAction",
    "ProposalOutput",
]
