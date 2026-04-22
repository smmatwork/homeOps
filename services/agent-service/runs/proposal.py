"""Proposal parsing + validation + fallback for the default chores.manage_v1
graph. The planner LLM returns text that may or may not be valid JSON; we
parse it strictly, re-validate that each action targets the `chores` table
and has the right args shape, and — as a last resort — extract a chore
title heuristically from the user's request.
"""

from __future__ import annotations

import re
import uuid
from typing import Any

from orchestrator.parsing import _safe_json_loads

from runs.models import ProposedAction, ProposalOutput


def _parse_proposal_from_raw_text(raw_text: str) -> ProposalOutput:
    data = _safe_json_loads(raw_text)
    proposal = ProposalOutput.model_validate(data)
    proposal.proposed_actions = _validate_chore_actions(proposal.proposed_actions)
    return proposal


def _validate_chore_actions(actions: list[ProposedAction]) -> list[ProposedAction]:
    out: list[ProposedAction] = []
    for a in actions:
        table = str(a.args.get("table", "")).strip()
        if table != "chores":
            raise ValueError("Only 'chores' table actions are allowed")
        if a.tool == "db.insert":
            record = a.args.get("record")
            if not isinstance(record, dict):
                raise ValueError("db.insert requires args.record")
            title = record.get("title")
            if not isinstance(title, str) or not title.strip():
                raise ValueError("Chore insert requires record.title")
        if a.tool == "db.update":
            if not isinstance(a.args.get("id"), str) or not str(a.args.get("id")).strip():
                raise ValueError("db.update requires args.id")
            patch = a.args.get("patch")
            if not isinstance(patch, dict):
                raise ValueError("db.update requires args.patch")
        if a.tool == "db.delete":
            if not isinstance(a.args.get("id"), str) or not str(a.args.get("id")).strip():
                raise ValueError("db.delete requires args.id")
        out.append(a)
    return out


def _fallback_chore_proposal(user_input: dict[str, Any]) -> ProposalOutput:
    """Last-resort extractor when the LLM returns non-parseable text.

    Pulls a chore title out of the user's request using a few common shapes
    (e.g. "Add a chore: Take out trash", quoted titles) and builds a single
    db.insert proposal, so the frontend has something coherent to confirm.
    """
    req = user_input.get("request")
    text = req if isinstance(req, str) else ""
    title = ""

    # Common patterns:
    # - "Add a chore: Take out trash. ..."
    # - "Add a chore called \"Take out trash\""
    # - Quoted title anywhere in the request.
    m = re.search(r"add\s+a\s+chore\s*:\s*([^\.\n\r]+)", text, re.IGNORECASE)
    if m:
        title = m.group(1).strip().strip('"')
    if not title:
        m = re.search(r"add\s+a\s+chore\s+called\s+\"([^\"]+)\"", text, re.IGNORECASE)
        if m:
            title = m.group(1).strip()
    if not title:
        m = re.search(r"\"([^\"]{3,100})\"", text)
        if m:
            title = m.group(1).strip()
    if not title:
        m = re.search(r"add\s+a\s+chore\s*:\s*([^,\n\r]+)", text, re.IGNORECASE)
        if m:
            title = m.group(1).strip().strip('"')
    if not title:
        title = "New chore"

    action = ProposedAction(
        id=f"tc_{uuid.uuid4().hex}",
        tool="db.insert",
        args={"table": "chores", "record": {"title": title}},
        reason=f"Fallback proposal (LLM did not return valid JSON). extracted_title={title}",
    )
    return ProposalOutput(
        confirm_text=f"I can add the chore '{title}'. Do you want me to apply this change?",
        proposed_actions=[action],
    )


__all__ = [
    "_parse_proposal_from_raw_text",
    "_validate_chore_actions",
    "_fallback_chore_proposal",
]
