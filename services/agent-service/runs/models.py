"""Pydantic models for the run pipeline — request/response envelopes and
the ProposedAction / ProposalOutput structures the LLM planner nodes fill
in and the handler returns via the edge runs/update channel.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class RunStartRequest(BaseModel):
    run_id: str
    household_id: str
    graph_key: str
    trigger: str = "chat"
    input: dict[str, Any] = Field(default_factory=dict)
    mode: Literal["propose", "commit"] = "propose"


class RunStatusResponse(BaseModel):
    ok: bool = True
    run_id: str
    status: Literal["queued", "running", "succeeded", "failed", "canceled"]
    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None


class ProposedAction(BaseModel):
    id: str
    tool: Literal["db.insert", "db.update", "db.delete"]
    args: dict[str, Any]
    reason: Optional[str] = None


class ProposalOutput(BaseModel):
    mode: Literal["propose"] = "propose"
    version: str = "proposal_v1"
    confirm_text: str
    proposed_actions: list[ProposedAction]


__all__ = [
    "RunStartRequest",
    "RunStatusResponse",
    "ProposedAction",
    "ProposalOutput",
]
