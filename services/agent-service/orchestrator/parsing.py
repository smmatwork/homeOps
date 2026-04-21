"""Generic LLM-output parsing and tool-call validation utilities.

Every domain agent's LLM output flows through these before the orchestrator
decides what to do with it:

  - Chain-of-thought stripping — remove `<think>` blocks, drop meta-reasoning
    paragraphs, never leak model scratchpad to users.
  - JSON candidate extraction — handle markdown fences, preambles, balanced-
    brace scanning, and malformed wrappers.
  - Tool-call validation — enforce our strict {id, tool, args} schema before
    anything is sent to the edge function.
  - Strict-payload parsing — turn the LLM's final_text-or-tool_calls envelope
    into a typed dict the orchestrator can route on.

These are pure functions with no external dependencies beyond `json` and `re`.
They live here (not inside a domain agent or main.py) because both ChoreAgent
and HelperAgent need them, as does any future Service/Procurement agent.
"""

from __future__ import annotations

import json
import re
from typing import Any


# ── Chain-of-thought stripping ───────────────────────────────────────────────

def _strip_think_blocks(text: str) -> str:
    """Remove common chain-of-thought wrappers returned by some chat models.

    Handles `<think>...</think>`, `<analysis>...</analysis>`, and leading
    `Thinking: ...` / `Thought: ...` / `Analysis: ...` / `Reasoning: ...`
    prefixes. Conservative: only strips well-formed wrappers; prose that
    resembles reasoning without tags is left alone here (see
    `_deterministic_trim_chain_of_thought` for the heavier pass).
    """
    s = text or ""
    try:
        s = re.sub(r"<think>.*?</think>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        s = re.sub(r"<analysis>.*?</analysis>\s*", "", s, flags=re.DOTALL | re.IGNORECASE)
        s = re.sub(r"^\s*(thinking|thought|analysis|reasoning)\s*:\s*", "", s, flags=re.IGNORECASE)
    except Exception:
        pass
    return s.strip()


def _looks_like_chain_of_thought(text: str) -> bool:
    """Heuristic: does `text` contain meta-reasoning phrases that must not
    reach the user? Checked against a list of regex patterns observed in
    real leaks (e.g., 'the user wants...', 'I should query...', 'step 1:').
    """
    s = (text or "").strip().lower()
    if not s:
        return False
    patterns = [
        r"\bokay,\s*the user\b",
        r"\bthe user (wants|asked|is asking)\b",
        r"\bthe user hasn\s*'\s*t\b",
        r"\bthe user has not\b",
        r"\bthe user hasn't confirmed\b",
        r"\bthe user's last message\b",
        r"\bthe latest user message\b",
        r"\blooking back\b",
        r"\bwait,\b",
        r"\bwait\s+no\b",
        r"\bbut wait,\b",
        r"\bbut wait\b",
        r"\blet me (think|break this down|figure|reason)\b",
        r"\bi need to\b",
        r"\bhere('?s)? (my|the) (plan|approach)\b",
        r"\bfirst,\b",
        r"\bnext,\b",
        r"\bnow, i need to\b",
        r"\bi should (add|do|create|return|start|use|query|check|find|look|fetch|call|emit|first|then)\b",
        r"\bi'?ll (start|use|query|check|find|look|fetch|call|emit|need)\b",
        r"\bhowever,\b.*\bbut\b",
        r"\bin the current (query|context|scenario)\b",
        r"\baccording to the (history|rules)\b",
        r"\bthe assistant should\b",
        r"\bthe correct approach is\b",
        r"\bquery(ing)? the database\b",
        r"\busing (a |the )?db\.\w+\b",
        r"\bthe (columns?|where) (clause|should|must)\b",
        r"\bstep\s*\d+\s*[:.\-]",
        r"\bto identify which records\b",
    ]
    try:
        return any(re.search(p, s) for p in patterns)
    except Exception:
        return False


def _deterministic_trim_chain_of_thought(text: str) -> str:
    """Heavier-handed CoT stripper for cases where the tag-based strip missed.

    Strategy, in order:
      1) Run `_strip_think_blocks` first.
      2) If the remaining text doesn't look like CoT, return as-is.
      3) If multiple paragraphs, drop any that `_looks_like_chain_of_thought`.
      4) Drop common meta-reasoning lead-in lines from the head.
      5) As a deterministic last resort, keep the final paragraph if it
         itself doesn't look like CoT.
      6) If everything was meta-reasoning, return empty string so the caller
         surfaces a generic fallback rather than leaking the scratchpad.
    """
    s = _strip_think_blocks(text)
    if not s:
        return s

    lower = s.lower()
    if not _looks_like_chain_of_thought(lower):
        return s

    parts = [p.strip() for p in re.split(r"\n\s*\n", s) if p.strip()]
    if len(parts) >= 2:
        kept: list[str] = []
        for p in parts:
            if _looks_like_chain_of_thought(p):
                continue
            kept.append(p)
        if kept:
            s = "\n\n".join(kept).strip()

    lines = [ln.strip() for ln in s.splitlines()]
    drop_prefixes = (
        "okay, the user",
        "the user wants",
        "the user asked",
        "the user hasn't",
        "the user has not",
        "the latest user message",
        "the user's last message",
        "looking back,",
        "wait,",
        "wait ",
        "but wait,",
        "but wait ",
        "let me break this down",
        "let me think",
        "first,",
        "next,",
        "now, i need to",
        "i need to",
        "here's my plan",
        "here is my plan",
        "alternatively,",
        "alternatively ",
        "maybe the system",
        "maybe this",
        "issues:",
        "i should",
        "i'll start",
        "i'll use",
        "i'll query",
        "step 1",
        "step 2",
        "step 3",
        "using a db.",
        "using db.",
        "the columns should",
        "the where clause",
    )
    while lines:
        head = lines[0].lower().lstrip("- ").strip()
        if any(head.startswith(p) for p in drop_prefixes):
            lines.pop(0)
            continue
        break
    s2 = "\n".join(lines).strip()

    if s2 and not _looks_like_chain_of_thought(s2):
        return s2

    if parts:
        last = parts[-1].strip()
        if last and not _looks_like_chain_of_thought(last.lower()):
            return last

    return ""


# ── JSON candidate extraction + tolerant loader ──────────────────────────────

def _extract_json_candidate(text: str) -> str | None:
    """Extract the first well-formed JSON object from `text` (strips CoT first).

    Prefers the body of a ```json fenced block; falls back to the first
    balanced `{...}` substring. Returns the candidate string (no `json.loads`
    yet) or None if no candidate is found. Caller is expected to run
    `_safe_json_loads` on the result.
    """
    raw = _strip_think_blocks(text or "").strip()
    if not raw:
        return None

    m = re.search(r"```json\s*([\s\S]*?)(?:\s*```|$)", raw, flags=re.IGNORECASE)
    if m and (m.group(1) or "").strip():
        return m.group(1).strip()

    first = raw.find("{")
    if first == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(first, len(raw)):
        ch = raw[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                cand = raw[first : i + 1].strip()
                return cand if cand.startswith("{") and cand.endswith("}") else None
    return None


def _safe_json_loads(raw: str) -> Any:
    """Tolerant JSON loader that tries multiple extraction strategies before
    giving up. Order: strip <think>, try <json>...</json> tag, try fenced
    ```...``` blocks, try raw, then balanced `{...}` with line-comment
    stripping. Raises ValueError if nothing parses.
    """
    s = raw.strip()

    if "<think>" in s:
        s = re.sub(r"<think>[\s\S]*?</think>", "", s, flags=re.IGNORECASE).strip()
        if s.lower().startswith("<think>"):
            s = re.sub(r"^<think>[\s\S]*", "", s, flags=re.IGNORECASE).strip()

    m = re.search(r"<json>([\s\S]*?)</json>", s, flags=re.IGNORECASE)
    if m:
        candidate = m.group(1).strip()
        try:
            return json.loads(candidate)
        except Exception:
            pass

    if "```" in s:
        parts = s.split("```")
        for i in range(1, len(parts), 2):
            candidate = parts[i].strip()
            if candidate.startswith("json"):
                candidate = candidate[4:].strip()
            if candidate.startswith("{") and candidate.endswith("}"):
                try:
                    return json.loads(candidate)
                except Exception:
                    pass

    try:
        return json.loads(s)
    except Exception:
        pass

    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        candidate = s[start : end + 1]
        try:
            return json.loads(candidate)
        except Exception:
            pass

        try:
            cleaned = "\n".join([ln for ln in candidate.splitlines() if not ln.strip().startswith("//")])
            return json.loads(cleaned)
        except Exception:
            pass
    raise ValueError("Could not parse JSON")


def _try_parse_json_obj(text: str) -> dict[str, Any] | None:
    """Strict JSON-object parse: returns the dict on success, None on any
    parse failure. Used by code paths that know they want an object and
    want to cheaply ignore invalid input."""
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        return None
    return None


# ── Tool-call validation ─────────────────────────────────────────────────────

_ALLOWED_TOOLS = ("db.select", "db.insert", "db.update", "db.delete", "query.rpc")


def _validate_tool_calls_list(v: Any) -> list[dict[str, Any]] | None:
    """Validate a list of tool_call objects against our schema.

    Required keys per tool_call: `id` (non-empty string), `tool` (one of
    db.{select,insert,update,delete} or query.rpc), `args` (dict).
    For query.rpc: args must have a non-empty `name` and (optional) `params`
    dict. For the db.* tools, further arg-shape checks are left to
    _validate_edge_tool_call_args (per-agent) or the edge function itself.
    Returns a normalized list (with `reason` preserved if present) or None
    if any element fails validation.
    """
    if not isinstance(v, list):
        return None
    if len(v) == 0:
        return []
    out: list[dict[str, Any]] = []
    for item in v:
        if not isinstance(item, dict):
            return None
        tid = item.get("id")
        tool = item.get("tool")
        args = item.get("args")
        if not isinstance(tid, str) or not tid.strip():
            return None
        if tool not in _ALLOWED_TOOLS:
            return None
        if not isinstance(args, dict):
            return None
        if tool == "query.rpc":
            name = args.get("name")
            params = args.get("params")
            if not isinstance(name, str) or not name.strip():
                return None
            if params is not None and not isinstance(params, dict):
                return None
        out.append({
            "id": tid,
            "tool": tool,
            "args": args,
            **({"reason": item.get("reason")} if isinstance(item.get("reason"), str) and item.get("reason").strip() else {}),
        })
    return out


def _actions_to_tool_calls(actions: Any) -> list[dict[str, Any]] | None:
    """Backward-compat: some models emit {"actions": [...]} instead of
    {"tool_calls": [...]}. Convert into our tool_calls schema so the edge
    function can execute deterministically.

    Known legacy shapes handled: select / create / update / delete with a
    `where.id` convention that we rewrite into our `id` + `patch` shape.
    """
    if not isinstance(actions, list) or len(actions) == 0:
        return None
    out: list[dict[str, Any]] = []
    for idx, a in enumerate(actions):
        if not isinstance(a, dict):
            return None
        typ = a.get("type")
        table = a.get("table")
        if not isinstance(typ, str) or not isinstance(table, str) or not table.strip():
            return None

        tool: str | None = None
        args: dict[str, Any] | None = None
        if typ == "select":
            tool = "db.select"
            cols = a.get("columns")
            if cols is None:
                cols = "*"
            args = {
                "table": table,
                "columns": cols,
            }
            if isinstance(a.get("where"), dict):
                args["where"] = a.get("where")
            if isinstance(a.get("limit"), int):
                args["limit"] = a.get("limit")
        elif typ == "create":
            tool = "db.insert"
            rec = a.get("record")
            if not isinstance(rec, dict):
                return None
            args = {"table": table, "record": rec}
        elif typ == "update":
            tool = "db.update"
            where = a.get("where")
            updates = a.get("updates")
            if not isinstance(where, dict) or not isinstance(updates, dict):
                return None
            legacy_id = where.get("id") if isinstance(where.get("id"), str) else None
            if not legacy_id or not legacy_id.strip():
                return None
            args = {"table": table, "id": legacy_id.strip(), "patch": updates}
        elif typ == "delete":
            tool = "db.delete"
            where = a.get("where")
            if not isinstance(where, dict):
                return None
            legacy_id = where.get("id") if isinstance(where.get("id"), str) else None
            if not legacy_id or not legacy_id.strip():
                return None
            args = {"table": table, "id": legacy_id.strip()}
        else:
            return None

        if tool is None or args is None:
            return None
        out.append({
            "id": str(a.get("id") or f"act_{idx+1}"),
            "tool": tool,
            "args": args,
            **({"reason": a.get("reason")} if isinstance(a.get("reason"), str) and a.get("reason").strip() else {}),
        })
    return out


def _ensure_tool_reason(tc: dict[str, Any], reason: str) -> dict[str, Any]:
    """Fill in a `reason` field on a tool call if the model omitted one.
    Reason is surfaced in audit logs and used by downstream formatters to
    reconstruct `(id, title)` pairs from update calls.
    """
    if not isinstance(tc, dict):
        return tc
    if isinstance(tc.get("reason"), str) and str(tc.get("reason") or "").strip():
        return tc
    tc2 = dict(tc)
    tc2["reason"] = reason
    return tc2


# ── Structured-payload parsing + normalization ───────────────────────────────

def _parse_strict_llm_payload(text: str) -> dict[str, Any] | None:
    """Parse the strict-JSON orchestrator envelope produced by the main LLM
    turn. Returns one of:

      {"kind": "final_text", "final_text": "..."}   direct user-facing reply
      {"kind": "tool_calls", "tool_calls": [...]}   tool invocation batch
      None                                          unparseable

    Accepts the model-emitted `actions` alias and rewrites it to tool_calls.
    Falls back to accepting non-JSON prose as a final_text when the model
    skips the envelope entirely — prevents UI fallback loops.
    """
    cand = _extract_json_candidate(text)
    if not cand:
        cleaned = _deterministic_trim_chain_of_thought(text or "").strip()
        if cleaned:
            return {"kind": "final_text", "final_text": cleaned}
        return None
    try:
        obj = _safe_json_loads(cand)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None

    if "final_text" in obj and isinstance(obj.get("final_text"), str) and obj.get("final_text").strip():
        return {"kind": "final_text", "final_text": _deterministic_trim_chain_of_thought(str(obj.get("final_text")))}

    tc = _validate_tool_calls_list(obj.get("tool_calls"))
    if tc is not None:
        return {"kind": "tool_calls", "tool_calls": tc}

    legacy = _actions_to_tool_calls(obj.get("actions"))
    if legacy is not None:
        return {"kind": "tool_calls", "tool_calls": legacy}
    return None


def _try_normalize_tool_calls_block(text: str) -> str:
    """If `text` contains a valid tool_calls JSON payload, re-emit it as a
    clean fenced ```json block. Prevents UI issues when the model opens a
    ```json fence without closing it or wraps the payload oddly.

    If the text doesn't contain a valid payload, returns the input unchanged.
    """
    raw = (text or "").strip()
    if not raw:
        return raw

    lowered = raw.lower()
    if "tool_calls" not in lowered:
        return raw

    obj: Any = None
    try:
        obj = _safe_json_loads(raw)
    except Exception:
        obj = None
    if not isinstance(obj, dict):
        return raw

    tc = obj.get("tool_calls")
    if not isinstance(tc, list) or not tc:
        return raw
    for t in tc:
        if not isinstance(t, dict):
            return raw
        if not isinstance(t.get("id"), str) or not str(t.get("id") or "").strip():
            return raw
        if t.get("tool") not in _ALLOWED_TOOLS:
            return raw
        args = t.get("args")
        if not isinstance(args, dict):
            return raw

    normalized = json.dumps(obj, ensure_ascii=False, indent=2)
    return f"```json\n{normalized}\n```"


def _contains_structured_tool_calls_payload(text: str) -> bool:
    """Return True only when `text` contains an actual tool_calls JSON payload.

    Important: we must NOT treat casual mentions of the word 'tool_calls'
    as a structured payload, otherwise sanitizer rewrites get skipped and
    chain-of-thought can leak.
    """
    raw = (text or "").strip()
    if not raw:
        return False

    lowered = raw.lower()
    if "tool_calls" not in lowered:
        return False

    try:
        obj = _safe_json_loads(raw)
    except Exception:
        obj = None
    return isinstance(obj, dict) and isinstance(obj.get("tool_calls"), list) and len(obj.get("tool_calls") or []) > 0


__all__ = [
    "_strip_think_blocks",
    "_looks_like_chain_of_thought",
    "_deterministic_trim_chain_of_thought",
    "_extract_json_candidate",
    "_safe_json_loads",
    "_try_parse_json_obj",
    "_validate_tool_calls_list",
    "_actions_to_tool_calls",
    "_ensure_tool_reason",
    "_parse_strict_llm_payload",
    "_try_normalize_tool_calls_block",
    "_contains_structured_tool_calls_payload",
]
