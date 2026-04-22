"""`/v1/runs/start` handler and the three LangGraph sub-graphs it dispatches.

Dispatches on `req.graph_key`:
  - chores.visitors_cleaning_v1 → _run_visitors_cleaning_graph
  - signals.capture_v1          → _run_signals_capture_graph
  - chores.* (default)          → _run_default_chores_graph

All edge + LLM calls are injected so this module is import-test-friendly
and main.py keeps its shim pattern: test patches on agent_main._edge_post
/ _sarvam_chat propagate through the endpoint wrapper that forwards them
into `run_start_handler`.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any, Awaitable, Callable, Optional

from fastapi import HTTPException
from langgraph.graph import END, StateGraph

from orchestrator.parsing import _safe_json_loads

from runs.cleaning_templates import _pick_helper_for_cleaning, _visitor_cleaning_templates
from runs.models import ProposedAction, ProposalOutput, RunStartRequest
from runs.proposal import _fallback_chore_proposal, _parse_proposal_from_raw_text
from runs.time_parsing import ZoneInfo, _iso, _local_dt_to_utc_iso, _parse_event_time


EdgePostFn = Callable[..., Awaitable[Any]]
EdgeGetFn = Callable[..., Awaitable[Any]]
ChatFn = Callable[..., Awaitable[Any]]


async def run_start_handler(
    req: RunStartRequest,
    *,
    edge_post: EdgePostFn,
    edge_get: EdgeGetFn,
    chat_fn: ChatFn,
    sarvam_model_default: str,
    sarvam_api_key_set: bool,
) -> dict[str, Any]:
    """Run the selected graph and surface {ok: True, run_id} on success.

    Any exception inside the handler is reported to the edge runs/events
    channel (`runner_error`) and the run marked failed before re-raising as
    an HTTP 500 so FastAPI's error handler takes over.
    """
    try:
        if req.mode != "propose":
            raise RuntimeError("agent-service only supports mode=propose")

        await edge_post(
            "/agents/runs/events/append",
            {
                "run_id": req.run_id,
                "node_key": "runner",
                "level": "info",
                "event_type": "run_started",
                "payload": {
                    "graph_key": req.graph_key,
                    "trigger": req.trigger,
                    "mode": req.mode,
                },
            },
        )

        await edge_post(
            "/agents/runs/update",
            {
                "run_id": req.run_id,
                "status": "running",
                "started_at": datetime.now(timezone.utc).isoformat(),
            },
        )

        graph_key = req.graph_key.strip()
        if not (graph_key == "chores.manage_v1" or graph_key.startswith("chores.") or graph_key.startswith("signals.")):
            raise RuntimeError("Unsupported graph_key")

        if graph_key == "chores.visitors_cleaning_v1":
            await _run_visitors_cleaning_graph(
                req,
                edge_post=edge_post,
                edge_get=edge_get,
                chat_fn=chat_fn,
                sarvam_model_default=sarvam_model_default,
            )
            return {"ok": True, "run_id": req.run_id}

        if graph_key == "signals.capture_v1":
            await _run_signals_capture_graph(
                req,
                edge_post=edge_post,
                edge_get=edge_get,
                chat_fn=chat_fn,
                sarvam_model_default=sarvam_model_default,
                sarvam_api_key_set=sarvam_api_key_set,
            )
            return {"ok": True, "run_id": req.run_id}

        await _run_default_chores_graph(
            req,
            edge_post=edge_post,
            chat_fn=chat_fn,
            sarvam_model_default=sarvam_model_default,
        )
        return {"ok": True, "run_id": req.run_id}

    except Exception as e:
        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "runner",
                    "level": "error",
                    "event_type": "runner_error",
                    "payload": {"error": str(e)},
                },
            )
        except Exception:
            pass
        try:
            await edge_post(
                "/agents/runs/update",
                {
                    "run_id": req.run_id,
                    "status": "failed",
                    "ended_at": datetime.now(timezone.utc).isoformat(),
                    "error": str(e),
                },
            )
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=str(e))


# ── chores.visitors_cleaning_v1 ──────────────────────────────────────────────


async def _run_visitors_cleaning_graph(
    req: RunStartRequest,
    *,
    edge_post: EdgePostFn,
    edge_get: EdgeGetFn,
    chat_fn: ChatFn,
    sarvam_model_default: str,
) -> None:
    state: dict[str, Any] = {
        "input": req.input,
        "signals": None,
        "plan_items": [],
        "actions": [],
        "confirm_text": "",
        "llm_advice": "",
    }

    async def fetch_signals_node(s: dict[str, Any]) -> dict[str, Any]:
        data = await edge_get(
            "/agents/signals/chores-v1",
            {
                "household_id": req.household_id,
                "window_hours": "48",
            },
        )
        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "signals",
                    "level": "info",
                    "event_type": "signals_snapshot",
                    "payload": {
                        "has_visitors": bool(data.get("visitors_event")),
                        "has_feedback": bool(data.get("cleaning_feedback")),
                        "helpers_count": len(data.get("helpers") or []),
                        "time_off_count": len(data.get("helper_time_off") or []),
                    },
                },
            )
        except Exception:
            pass
        return {"signals": data}

    async def compute_plan_node(s: dict[str, Any]) -> dict[str, Any]:
        signals = s.get("signals") if isinstance(s.get("signals"), dict) else {}
        visitors = signals.get("visitors_event") if isinstance(signals.get("visitors_event"), dict) else None
        feedback = signals.get("cleaning_feedback") if isinstance(signals.get("cleaning_feedback"), dict) else None
        helpers = signals.get("helpers") if isinstance(signals.get("helpers"), list) else []
        time_off = signals.get("helper_time_off") if isinstance(signals.get("helper_time_off"), list) else []

        if not visitors:
            return {
                "plan_items": [],
                "confirm_text": "No visitor events found in the next 48 hours, so I won't add any cleaning chores.",
            }

        start_at = visitors.get("start_at")
        if not isinstance(start_at, str) or not start_at.strip():
            return {
                "plan_items": [],
                "confirm_text": "Visitor event is missing a start time, so I won't add any cleaning chores.",
            }

        try:
            visitor_dt = datetime.fromisoformat(start_at.replace("Z", "+00:00"))
        except Exception:
            visitor_dt = datetime.now(timezone.utc)

        due_dt = visitor_dt - timedelta(hours=6)  # 6 hours before visitors
        due_at = _iso(due_dt)

        rating: Optional[int] = None
        if feedback and isinstance(feedback.get("rating"), (int, float)):
            rating = int(feedback.get("rating"))
        visitors_meta = visitors.get("metadata") if isinstance(visitors.get("metadata"), dict) else {}

        helper_id, helper_unassigned_reason = _pick_helper_for_cleaning(
            helpers=helpers,
            helper_time_off=time_off,
        )

        templates = _visitor_cleaning_templates(
            feedback_rating=rating,
            visitors_metadata=visitors_meta,
        )

        plan_items: list[dict[str, Any]] = []
        for t in templates:
            meta: dict[str, Any] = {
                "category": "cleaning",
                "source": "visitors_cleaning_v1",
                "event_id": visitors.get("id"),
                "planned_minutes": t.get("minutes"),
                "tags": t.get("tags"),
                "helper_unassigned_reason": helper_unassigned_reason,
                "rationale": "Visitors arriving soon; prep cleaning.",
            }
            plan_items.append(
                {
                    "title": t.get("title"),
                    "priority": t.get("priority", 1),
                    "due_at": due_at,
                    "helper_id": helper_id,
                    "metadata": meta,
                }
            )

        preview = [p.get("title") for p in plan_items][:10]
        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "planner",
                    "level": "info",
                    "event_type": "plan_preview",
                    "payload": {"count": len(plan_items), "titles": preview, "due_at": due_at},
                },
            )
        except Exception:
            pass

        confirm = f"I can add {len(plan_items)} visitor-prep cleaning chores due before {start_at}. Do you want me to propose these chores?"
        return {"plan_items": plan_items, "confirm_text": confirm}

    async def llm_advice_node(s: dict[str, Any]) -> dict[str, Any]:
        plan_items = s.get("plan_items") if isinstance(s.get("plan_items"), list) else []
        signals = s.get("signals") if isinstance(s.get("signals"), dict) else {}
        visitors = signals.get("visitors_event") if isinstance(signals.get("visitors_event"), dict) else None
        feedback = signals.get("cleaning_feedback") if isinstance(signals.get("cleaning_feedback"), dict) else None
        if not visitors or not plan_items:
            # Explicitly carry forward plan_items/confirm_text so downstream nodes never lose them.
            confirm_text = s.get("confirm_text") if isinstance(s.get("confirm_text"), str) else ""
            return {"llm_advice": "", "plan_items": plan_items, "confirm_text": confirm_text}

        prompt = (
            "You are a home ops cleaning advisor. "
            "Given an upcoming visitors event and a draft visitor-prep cleaning plan, provide concise advice only. "
            "Do NOT output JSON. Do NOT propose tool calls. "
            "Return 3-6 short bullets: (a) missing tasks if any, (b) priority tweaks if needed, (c) a short rationale summary."
        )
        user_text = f"Visitors event: {visitors}\nLast cleaning feedback: {feedback}\nDraft plan titles: {[p.get('title') for p in plan_items]}"
        advice = await chat_fn(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_text},
            ],
            model=sarvam_model_default,
            temperature=0.2,
            max_tokens=300,
        )
        advice = advice.strip()
        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "advisor",
                    "level": "info",
                    "event_type": "llm_advice",
                    "payload": {"model": sarvam_model_default, "text_preview": advice[:800]},
                },
            )
        except Exception:
            pass
        confirm_text = s.get("confirm_text") if isinstance(s.get("confirm_text"), str) else ""
        return {"llm_advice": advice, "plan_items": plan_items, "confirm_text": confirm_text}

    async def compile_actions_node(s: dict[str, Any]) -> dict[str, Any]:
        plan_items = s.get("plan_items") if isinstance(s.get("plan_items"), list) else []
        if not plan_items:
            return {"actions": [], "confirm_text": s.get("confirm_text") or "No chores to propose."}

        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "compile",
                    "level": "info",
                    "event_type": "compile_inputs",
                    "payload": {
                        "plan_items_count": len(plan_items),
                        "first_item_keys": list(plan_items[0].keys()) if isinstance(plan_items[0], dict) else None,
                    },
                },
            )
        except Exception:
            pass

        llm_advice = s.get("llm_advice") if isinstance(s.get("llm_advice"), str) else ""
        actions: list[ProposedAction] = []
        for i, p in enumerate(plan_items):
            if not isinstance(p, dict):
                continue

            title = p.get("title")
            if title is None:
                continue

            if not isinstance(title, str):
                try:
                    title = str(title)
                except Exception:
                    continue

            if not title.strip():
                continue
            record: dict[str, Any] = {
                "title": title.strip(),
                "status": "pending",
                "due_at": p.get("due_at"),
                "priority": p.get("priority"),
                "metadata": p.get("metadata"),
            }

            helper_id_val = p.get("helper_id")
            if isinstance(helper_id_val, str) and helper_id_val.strip():
                record["helper_id"] = helper_id_val.strip()
            reason = "Visitor-prep cleaning plan."
            if llm_advice:
                reason = f"{reason} Advisor notes: {llm_advice[:220]}"
            actions.append(
                ProposedAction(
                    id=f"chores_visitors_cleaning_{i}_{uuid.uuid4().hex}",
                    tool="db.insert",
                    args={"table": "chores", "record": record},
                    reason=reason,
                )
            )

        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "compile",
                    "level": "info",
                    "event_type": "compile_outputs",
                    "payload": {"actions_count": len(actions)},
                },
            )
        except Exception:
            pass

        confirm_text = s.get("confirm_text") if isinstance(s.get("confirm_text"), str) else "Do you want me to propose these chores?"
        if llm_advice:
            confirm_text = f"{confirm_text}\n\nAdvisor notes:\n{llm_advice}".strip()

        return {"actions": actions, "confirm_text": confirm_text}

    g = StateGraph(dict)
    g.add_node("signals", fetch_signals_node)
    g.add_node("planner", compute_plan_node)
    g.add_node("advisor", llm_advice_node)
    g.add_node("compile", compile_actions_node)
    g.set_entry_point("signals")
    g.add_edge("signals", "planner")
    g.add_edge("planner", "advisor")
    g.add_edge("advisor", "compile")
    g.add_edge("compile", END)
    compiled = g.compile()

    result = await compiled.ainvoke(state)
    proposed_actions = result.get("actions")
    confirm_text = result.get("confirm_text")

    if not isinstance(proposed_actions, list):
        raise RuntimeError("Invalid proposal actions")
    if not isinstance(confirm_text, str):
        confirm_text = "Do you want me to apply these chore changes?"

    output = ProposalOutput(confirm_text=confirm_text, proposed_actions=proposed_actions)

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "proposed_actions_created",
            "payload": {"count": len(output.proposed_actions)},
        },
    )

    await edge_post(
        "/agents/runs/update",
        {
            "run_id": req.run_id,
            "status": "succeeded",
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "output": output.model_dump(),
        },
    )

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "awaiting_user_confirmation",
            "payload": {"mode": "propose"},
        },
    )

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "run_completed",
            "payload": {"status": "succeeded"},
        },
    )


# ── signals.capture_v1 ───────────────────────────────────────────────────────


async def _run_signals_capture_graph(
    req: RunStartRequest,
    *,
    edge_post: EdgePostFn,
    edge_get: EdgeGetFn,
    chat_fn: ChatFn,
    sarvam_model_default: str,
    sarvam_api_key_set: bool,
) -> None:
    state: dict[str, Any] = {
        "input": req.input,
        "timezone": "Asia/Kolkata",
        "actions": [],
        "confirm_text": "",
    }

    async def fetch_timezone_node(s: dict[str, Any]) -> dict[str, Any]:
        tz = "Asia/Kolkata"
        try:
            data = await edge_get(
                "/agents/household/timezone",
                {"household_id": req.household_id},
            )
            if isinstance(data, dict) and isinstance(data.get("timezone"), str) and data.get("timezone").strip():
                tz = data.get("timezone").strip()
        except Exception:
            tz = "Asia/Kolkata"
        # Preserve input so downstream nodes can read chat text.
        return {"timezone": tz, "input": s.get("input")}

    async def parse_and_compile_node(s: dict[str, Any]) -> dict[str, Any]:
        tz = s.get("timezone") if isinstance(s.get("timezone"), str) else "Asia/Kolkata"

        inp = s.get("input") if isinstance(s.get("input"), dict) else {}
        text = ""
        for k in ("text", "message", "user_text", "prompt"):
            v = inp.get(k)
            if isinstance(v, str) and v.strip():
                text = v.strip()
                break
        if not text:
            return {"actions": [], "confirm_text": "I didn't receive any text to record. Please describe the event or feedback."}

        lower = text.lower()
        actions: list[ProposedAction] = []

        if sarvam_api_key_set:
            now_utc = datetime.now(timezone.utc)
            if ZoneInfo is not None:
                try:
                    now_local = now_utc.astimezone(ZoneInfo(tz)).replace(tzinfo=None)
                except Exception:
                    now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
            else:
                now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
            schema_prompt = (
                "You extract household signals from chat into strict JSON. "
                "Return ONLY a <json> object.</json> block. "
                "If no signal is present, return {\"kind\":\"none\"}. "
                "Supported kinds: household_event, cleaning_feedback. "
                "For household_event, return: {"
                "\"kind\":\"household_event\",\"type\":string,\"start_local\":string,\"end_local\":string|null,\"title\":string|null,\"notes\":string|null,\"expected_count\":number|null,\"spaces\":array<string>|null}. "
                "For cleaning_feedback, return: {\"kind\":\"cleaning_feedback\",\"rating\":number,\"notes\":string|null,\"areas\":object|array|null}. "
                "Interpret relative dates like 'day after tomorrow' using the provided now_local. "
                "Time can be 24h like 19:31. "
                "start_local/end_local must be in format YYYY-MM-DDTHH:MM (no timezone). "
                "If the user mentions visiting/staying/guests, map to household_event type 'visitors'."
            )
            user_ctx = f"timezone={tz}; now_local={now_local.strftime('%Y-%m-%dT%H:%M')}; text={text}"
            try:
                raw = await chat_fn(
                    messages=[
                        {"role": "system", "content": schema_prompt},
                        {"role": "user", "content": user_ctx},
                    ],
                    model=sarvam_model_default,
                    temperature=0.0,
                    max_tokens=450,
                )
                parsed = _safe_json_loads(raw)
                if isinstance(parsed, dict) and parsed.get("kind") == "household_event":
                    start_local_raw = parsed.get("start_local")
                    end_local_raw = parsed.get("end_local")
                    if isinstance(start_local_raw, str) and start_local_raw.strip():
                        try:
                            start_local = datetime.fromisoformat(start_local_raw.strip())
                        except Exception:
                            start_local = None
                    else:
                        start_local = None
                    if isinstance(end_local_raw, str) and end_local_raw.strip():
                        try:
                            end_local = datetime.fromisoformat(end_local_raw.strip())
                        except Exception:
                            end_local = None
                    else:
                        end_local = None

                    if start_local is not None:
                        start_at = _local_dt_to_utc_iso(start_local, tz)
                        end_at = _local_dt_to_utc_iso(end_local, tz) if end_local is not None else None
                        meta: dict[str, Any] = {
                            "source": "chat",
                            "timezone_used": tz,
                            "raw_text": text,
                        }
                        title = parsed.get("title")
                        if isinstance(title, str) and title.strip():
                            meta["title"] = title.strip()
                        notes = parsed.get("notes")
                        if isinstance(notes, str) and notes.strip():
                            meta["notes"] = notes.strip()
                        expected_count = parsed.get("expected_count")
                        if isinstance(expected_count, (int, float)):
                            meta["expected_count"] = int(expected_count)
                        spaces = parsed.get("spaces")
                        if isinstance(spaces, list):
                            cleaned_spaces = [str(x).strip() for x in spaces if isinstance(x, (str, int, float)) and str(x).strip()]
                            if cleaned_spaces:
                                meta["spaces"] = cleaned_spaces

                        ev_type = parsed.get("type")
                        if not isinstance(ev_type, str) or not ev_type.strip():
                            ev_type = "visitors"

                        rec2: dict[str, Any] = {
                            "type": ev_type.strip(),
                            "start_at": start_at,
                            "end_at": end_at,
                            "metadata": meta,
                        }
                        actions.append(
                            ProposedAction(
                                id=f"signals_household_event_{uuid.uuid4().hex}",
                                tool="db.insert",
                                args={"table": "household_events", "record": rec2},
                                reason="Record household event from chat.",
                            )
                        )

                if isinstance(parsed, dict) and parsed.get("kind") == "cleaning_feedback":
                    rating = parsed.get("rating")
                    if isinstance(rating, (int, float)):
                        r_int = int(rating)
                        if 1 <= r_int <= 5:
                            rec: dict[str, Any] = {
                                "rating": r_int,
                                "notes": parsed.get("notes") if isinstance(parsed.get("notes"), str) else text,
                                "areas": parsed.get("areas"),
                                "metadata": {
                                    "source": "chat",
                                    "timezone_used": tz,
                                    "raw_text": text,
                                },
                            }
                            actions.append(
                                ProposedAction(
                                    id=f"signals_cleaning_feedback_{uuid.uuid4().hex}",
                                    tool="db.insert",
                                    args={"table": "cleaning_feedback", "record": rec},
                                    reason="Record cleaning feedback from chat.",
                                )
                            )
            except Exception:
                pass

        # Cleaning feedback capture.
        rating: Optional[int] = None
        m = re.search(r"\b([1-5])\s*/\s*5\b", lower)
        if m:
            rating = int(m.group(1))
        if rating is None:
            m2 = re.search(r"\brating\s*[:=]?\s*([1-5])\b", lower)
            if m2:
                rating = int(m2.group(1))

        if rating is not None and ("clean" in lower or "cleaning" in lower or "feedback" in lower or "house" in lower):
            rec: dict[str, Any] = {
                "rating": rating,
                "notes": text,
                "areas": None,
                "metadata": {
                    "source": "chat",
                    "timezone_used": tz,
                    "raw_text": text,
                },
            }
            actions.append(
                ProposedAction(
                    id=f"signals_cleaning_feedback_{uuid.uuid4().hex}",
                    tool="db.insert",
                    args={"table": "cleaning_feedback", "record": rec},
                    reason="Record cleaning feedback from chat.",
                )
            )

        # Household event capture (visitors by default if user mentions guests/visitors).
        if any(w in lower for w in ("visitor", "visitors", "guest", "guests", "people coming", "coming over")):
            now_utc = datetime.now(timezone.utc)
            if ZoneInfo is not None:
                try:
                    now_local = now_utc.astimezone(ZoneInfo(tz)).replace(tzinfo=None)
                except Exception:
                    now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
            else:
                now_local = now_utc.astimezone(timezone.utc).replace(tzinfo=None)
            start_local, end_local, note = _parse_event_time(text, now_local=now_local)
            if start_local is None:
                return {
                    "actions": actions,
                    "confirm_text": "I can record this visitors event, but I need a date/time. Try: 'Visitors tomorrow 7pm to 10pm'.",
                }
            start_at = _local_dt_to_utc_iso(start_local, tz)
            end_at = _local_dt_to_utc_iso(end_local, tz) if end_local else None
            meta: dict[str, Any] = {
                "source": "chat",
                "timezone_used": tz,
                "raw_text": text,
                "parse_note": note,
            }
            rec2: dict[str, Any] = {
                "type": "visitors",
                "start_at": start_at,
                "end_at": end_at,
                "metadata": meta,
            }
            actions.append(
                ProposedAction(
                    id=f"signals_household_event_{uuid.uuid4().hex}",
                    tool="db.insert",
                    args={"table": "household_events", "record": rec2},
                    reason="Record household event from chat.",
                )
            )

        if not actions:
            return {
                "actions": [],
                "confirm_text": "I can record (a) visitors/events or (b) cleaning feedback. Try: 'Visitors tomorrow 7pm to 10pm' or 'Cleaning feedback 3/5: bathrooms ok'.",
            }

        confirm = "I can record this as a household signal. Do you want me to propose these changes?"
        return {"actions": actions, "confirm_text": confirm}

    g = StateGraph(dict)
    g.add_node("tz", fetch_timezone_node)
    g.add_node("parse", parse_and_compile_node)
    g.set_entry_point("tz")
    g.add_edge("tz", "parse")
    g.add_edge("parse", END)
    compiled = g.compile()

    result = await compiled.ainvoke(state)
    proposed_actions = result.get("actions")
    confirm_text = result.get("confirm_text")
    if not isinstance(proposed_actions, list):
        raise RuntimeError("Invalid proposal actions")
    if not isinstance(confirm_text, str):
        confirm_text = "Do you want me to apply these changes?"

    output = ProposalOutput(confirm_text=confirm_text, proposed_actions=proposed_actions)

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "proposed_actions_created",
            "payload": {"count": len(output.proposed_actions)},
        },
    )

    await edge_post(
        "/agents/runs/update",
        {
            "run_id": req.run_id,
            "status": "succeeded",
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "output": output.model_dump(),
        },
    )

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "awaiting_user_confirmation",
            "payload": {"mode": "propose"},
        },
    )

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "run_completed",
            "payload": {"status": "succeeded"},
        },
    )


# ── chores.manage_v1 (default) ───────────────────────────────────────────────


async def _run_default_chores_graph(
    req: RunStartRequest,
    *,
    edge_post: EdgePostFn,
    chat_fn: ChatFn,
    sarvam_model_default: str,
) -> None:
    state: dict[str, Any] = {
        "input": req.input,
        "raw_text": "",
        "actions": [],
    }

    async def planner_node(s: dict[str, Any]) -> dict[str, Any]:
        prompt = (
            "You are a home operations assistant focused on chores. "
            "Generate a proposal ONLY (no execution). "
            "Return JSON ONLY. Do not include <think> tags, markdown, code fences, or commentary. "
            "Your entire response MUST be exactly one <json>...</json> block and nothing else. "
            "Inside <json>, return ONE JSON object only. "
            "The JSON object must have keys: proposed_actions (array), confirm_text (string). "
            "Each proposed action must have keys: id (string), tool (one of db.insert/db.update/db.delete), args (object), reason (string optional). "
            "Allowed table is ONLY 'chores'. "
            "For db.insert args must include: {table:'chores', record:{title:string, status?:string, due_at?:string, helper_id?:string, user_id?:string}}. "
            "For db.update args must include: {table:'chores', id:string, patch:{...}}. "
            "For db.delete args must include: {table:'chores', id:string}."
        )
        user_text = f"Input: {s.get('input', {})}"
        text = await chat_fn(
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_text},
            ],
            model=sarvam_model_default,
            temperature=0.2,
            max_tokens=700,
        )

        try:
            await edge_post(
                "/agents/runs/events/append",
                {
                    "run_id": req.run_id,
                    "node_key": "planner",
                    "level": "info",
                    "event_type": "llm_raw_preview",
                    "payload": {"model": sarvam_model_default, "text_preview": text[:500]},
                },
            )
        except Exception:
            pass

        return {"raw_text": text}

    async def parse_and_validate_node(s: dict[str, Any]) -> dict[str, Any]:
        raw_text = str(s.get("raw_text", ""))
        try:
            proposal = _parse_proposal_from_raw_text(raw_text)
        except Exception as e:
            # Second-pass formatter: force strict extraction by requiring <json>...</json>
            try:
                formatter_prompt = (
                    "You are a formatter. Output ONLY a <json>...</json> block and nothing else. "
                    "Do not include <think> tags, markdown, code fences, or commentary. "
                    "Inside <json>, output ONE JSON object with keys: proposed_actions (array), confirm_text (string). "
                    "Each proposed action must have keys: id (string), tool (db.insert/db.update/db.delete), args (object), reason (string optional). "
                    "Allowed table is ONLY 'chores'."
                )
                formatted = await chat_fn(
                    messages=[
                        {"role": "system", "content": formatter_prompt},
                        {"role": "user", "content": f"Rewrite the following into the required <json> block:\n\n{raw_text}"},
                    ],
                    model=sarvam_model_default,
                    temperature=0.0,
                    max_tokens=450,
                )

                try:
                    await edge_post(
                        "/agents/runs/events/append",
                        {
                            "run_id": req.run_id,
                            "node_key": "formatter",
                            "level": "info",
                            "event_type": "llm_formatter_preview",
                            "payload": {"model": sarvam_model_default, "text_preview": formatted[:500]},
                        },
                    )
                except Exception:
                    pass

                proposal2 = _parse_proposal_from_raw_text(formatted)
                return {"actions": proposal2.proposed_actions, "confirm_text": proposal2.confirm_text}
            except Exception:
                pass

            input_obj = s.get("input") if isinstance(s.get("input"), dict) else {}
            # LangGraph state should retain the original input, but if it doesn't,
            # fall back to the authoritative request input from the run start request.
            if (not isinstance(input_obj.get("request"), str) or not str(input_obj.get("request")).strip()) and isinstance(req.input, dict):
                input_obj = req.input

            fallback = _fallback_chore_proposal(input_obj)
            try:
                req_preview = ""
                if isinstance(input_obj, dict) and isinstance(input_obj.get("request"), str):
                    req_preview = str(input_obj.get("request"))[:200]

                await edge_post(
                    "/agents/runs/events/append",
                    {
                        "run_id": req.run_id,
                        "node_key": "validate",
                        "level": "warn",
                        "event_type": "guardrail_triggered",
                        "payload": {
                            "kind": "llm_non_json_fallback",
                            "error": str(e),
                            "request_preview": req_preview,
                            "input_keys": list(input_obj.keys()) if isinstance(input_obj, dict) else None,
                            "extracted_title": fallback.proposed_actions[0].args.get("record", {}).get("title")
                            if fallback.proposed_actions and isinstance(fallback.proposed_actions[0].args.get("record"), dict)
                            else None,
                        },
                    },
                )
            except Exception:
                pass
            return {"actions": fallback.proposed_actions, "confirm_text": fallback.confirm_text}
        return {"actions": proposal.proposed_actions, "confirm_text": proposal.confirm_text}

    g = StateGraph(dict)
    g.add_node("planner", planner_node)
    g.add_node("validate", parse_and_validate_node)
    g.set_entry_point("planner")
    g.add_edge("planner", "validate")
    g.add_edge("validate", END)
    compiled = g.compile()

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "graph",
            "level": "info",
            "event_type": "node_started",
            "payload": {"node": "planner"},
        },
    )

    result = await compiled.ainvoke(state)

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "graph",
            "level": "info",
            "event_type": "node_completed",
            "payload": {"node": "planner"},
        },
    )

    proposed_actions = result.get("actions")
    confirm_text = result.get("confirm_text")
    if not isinstance(proposed_actions, list):
        raise RuntimeError("Invalid proposal actions")
    if not isinstance(confirm_text, str):
        confirm_text = "Do you want me to apply these chore changes?"

    output = ProposalOutput(confirm_text=confirm_text, proposed_actions=proposed_actions)

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "proposed_actions_created",
            "payload": {"count": len(output.proposed_actions)},
        },
    )

    await edge_post(
        "/agents/runs/update",
        {
            "run_id": req.run_id,
            "status": "succeeded",
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "output": output.model_dump(),
        },
    )

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "awaiting_user_confirmation",
            "payload": {"mode": "propose"},
        },
    )

    await edge_post(
        "/agents/runs/events/append",
        {
            "run_id": req.run_id,
            "node_key": "runner",
            "level": "info",
            "event_type": "run_completed",
            "payload": {"status": "succeeded"},
        },
    )


__all__ = ["run_start_handler"]
