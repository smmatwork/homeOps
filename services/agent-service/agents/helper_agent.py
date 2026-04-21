"""Helper Agent — manages helpers (cleaners/maids), time off, feedback, rewards,
and chore assignment/reassignment via chores.helper_id changes.

Contract: the orchestrator decides routing via is_intent() and, when matched,
calls run() with the same messages it would have sent to the Chore Agent.
The return payload is either a clarifications list OR tool_calls (never both
— invariant enforced by _parse_payload), plus a user_summary string.

Infrastructure dependencies (LLM client, JSON utilities, tool-call validator)
are injected at construction time so this module has no import dependency on
main.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable


ChatFn = Callable[..., Awaitable[Any]]
ExtractJsonCandidateFn = Callable[[str], "str | None"]
SafeJsonLoadsFn = Callable[[str], Any]
ValidateToolCallsFn = Callable[[Any], "list[dict[str, Any]] | None"]


_HELPER_SYSTEM_CLAUSE = (
    "You are the Helper Agent for a home management app.\n"
    "Manage helpers (cleaners/maids), their time off, feedback, and rewards; and assign/unassign/reassign chores via chores.helper_id changes.\n\n"
    "CRITICAL INVARIANTS:\n"
    "- Never write to chore_helper_assignments directly. Assignment history is logged ONLY when chores.helper_id changes.\n"
    "- Rewards creation is admin-only (server enforces).\n"
    "- Never invent IDs or names. Fetch helpers/chores via db.select if needed.\n\n"
    "OUTPUT CONTRACT: Return ONLY JSON with EXACT keys: clarifications, tool_calls, user_summary.\n"
    "- clarifications: array of objects with keys {key, question, options, allowMultiple}. (may be empty).\n"
    "- tool_calls: array of tool calls (may be empty).\n"
    "- user_summary: short string.\n"
    "Rules: If clarifications is non-empty, tool_calls must be empty.\n\n"
    "Allowed tools: db.select, db.insert, db.update, db.delete.\n"
    "Tool call args shapes:\n"
    "- db.select: { table: string, columns?: string|array, where?: object, limit?: number }\n"
    "- db.insert: { table: string, record: object }\n"
    "- db.update: { table: string, id: string, patch: object }\n"
    "- db.delete: { table: string, id: string }\n"
    "Allowed tables: helpers, member_time_off, helper_feedback, helper_rewards, helper_reward_snapshots, chores.\n"
)


_REPAIR_SYSTEM_CLAUSE = (
    "Rewrite the INPUT into ONLY a single JSON object with EXACT keys: "
    "clarifications, tool_calls, user_summary. "
    "Tool calls must use db.select/db.insert/db.update/db.delete with args shapes: "
    "db.select={table,columns?,where?,limit?}; db.insert={table,record}; "
    "db.update={table,id,patch}; db.delete={table,id}."
)


_HELPER_TERMS = ("helper", "helpers", "cleaner", "cleaners", "maid", "househelp", "house help")
_HELPER_OPS = (
    "time off", "leave", "vacation", "availability", "feedback",
    "rating", "reward", "bonus", "assign", "reassign", "unassign",
)
_ASSIGN_PHRASES_ROUTE_TO_CHORE = (
    "assign chores", "assign them", "assign my", "unassigned chores", "help me assign",
    "assign tasks", "distribute chores", "assignment pattern", "assignment preference",
)


def _validate_edge_tool_call_args(item: dict[str, Any]) -> bool:
    tool = item.get("tool")
    args = item.get("args")
    if tool not in ("db.select", "db.insert", "db.update", "db.delete", "query.rpc"):
        return False
    if not isinstance(args, dict):
        return False

    if tool == "query.rpc":
        name = args.get("name")
        params = args.get("params")
        if not isinstance(name, str) or not name.strip():
            return False
        if params is not None and not isinstance(params, dict):
            return False
        return True

    table = args.get("table")
    if not isinstance(table, str) or not table.strip():
        return False

    if tool == "db.select":
        if "where" in args and not isinstance(args.get("where"), dict):
            return False
        if "limit" in args and not isinstance(args.get("limit"), int):
            return False
        return True
    if tool == "db.insert":
        return isinstance(args.get("record"), dict)
    if tool == "db.update":
        return isinstance(args.get("id"), str) and bool(str(args.get("id") or "").strip()) and isinstance(args.get("patch"), dict)
    if tool == "db.delete":
        return isinstance(args.get("id"), str) and bool(str(args.get("id") or "").strip())
    return False


@dataclass
class HelperAgent:
    """Domain agent for helper/cleaner management.

    Instantiate once at orchestrator startup with infrastructure dependencies,
    then call `.is_intent(messages)` for routing and `.run(...)` for execution.
    """

    chat_fn: ChatFn
    extract_json_candidate: ExtractJsonCandidateFn
    safe_json_loads: SafeJsonLoadsFn
    validate_tool_calls_list: ValidateToolCallsFn

    def is_intent(self, messages: list[dict[str, Any]]) -> bool:
        """Lightweight pre-dispatch check: does the user's most recent message
        look like a helper-management request (vs. a chore-management request)?

        False when the message is an analytics-style chore question that happens
        to contain "assigned" (e.g. "how many chores are assigned?") or when it
        references assignment setup ("assign chores", "assignment pattern").
        """
        last_user = ""
        for m in reversed(messages or []):
            if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
                last_user = str(m.get("content") or "").strip()
                break
        s = last_user.lower()
        if not s:
            return False

        # Analytics questions about chores shouldn't route to the helper agent
        # just because they contain "assign".
        if ("chore" in s or "chores" in s) and ("assign" in s):
            if ("how many" in s) or ("count" in s) or ("number of" in s) or ("total" in s):
                return False

        if any(p in s for p in _ASSIGN_PHRASES_ROUTE_TO_CHORE):
            return False

        if any(t in s for t in _HELPER_TERMS):
            return True
        if any(op in s for op in _HELPER_OPS) and ("chore" in s or "chores" in s) and any(t in s for t in _HELPER_TERMS):
            return True
        return False

    async def run(
        self,
        *,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float | None,
        max_tokens: int | None,
    ) -> dict[str, Any] | None:
        """Execute the Helper Agent turn. Returns parsed payload dict
        (clarifications, tool_calls, user_summary) or None if the LLM output
        could not be parsed even after a single repair attempt.
        """
        sarvam_messages: list[dict[str, str]] = []
        if (
            messages
            and isinstance(messages[0], dict)
            and messages[0].get("role") == "system"
            and isinstance(messages[0].get("content"), str)
        ):
            sarvam_messages.append({
                "role": "system",
                "content": str(messages[0]["content"]).rstrip() + "\n\n" + _HELPER_SYSTEM_CLAUSE,
            })
            rest = messages[1:]
        else:
            sarvam_messages.append({"role": "system", "content": _HELPER_SYSTEM_CLAUSE.strip()})
            rest = messages

        for m in rest:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            content = m.get("content")
            if isinstance(role, str) and isinstance(content, str):
                sarvam_messages.append({"role": role, "content": content})

        effective_temp = float(temperature) if isinstance(temperature, (int, float)) else 0.0
        effective_max = min(int(max_tokens or 768), 768)

        raw = await self.chat_fn(
            messages=sarvam_messages,
            model=model,
            temperature=effective_temp,
            max_tokens=effective_max,
        )
        parsed = self._parse_payload(raw)
        if parsed is not None:
            return parsed

        # One repair attempt — re-prompt with schema-only instruction.
        repair = await self.chat_fn(
            messages=[
                {"role": "system", "content": _REPAIR_SYSTEM_CLAUSE},
                {"role": "user", "content": str(raw)},
            ],
            model=model,
            temperature=0.0,
            max_tokens=effective_max,
        )
        return self._parse_payload(repair)

    def _parse_payload(self, text: Any) -> dict[str, Any] | None:
        if not isinstance(text, str):
            return None
        cand = self.extract_json_candidate(text)
        if not cand:
            return None
        try:
            obj = self.safe_json_loads(cand)
        except Exception:
            return None
        if not isinstance(obj, dict):
            return None

        clarifications = obj.get("clarifications")
        tool_calls_raw = obj.get("tool_calls")
        user_summary = obj.get("user_summary")

        if clarifications is None:
            clarifications = []
        if not isinstance(clarifications, list):
            return None

        clarifications_clean: list[dict[str, Any]] = []
        for c in clarifications:
            if not isinstance(c, dict):
                return None
            key = c.get("key")
            question = c.get("question")
            allow_multiple = c.get("allowMultiple")
            options = c.get("options")
            if not isinstance(key, str) or not key.strip():
                return None
            if not isinstance(question, str) or not question.strip():
                return None
            if not isinstance(allow_multiple, bool):
                return None
            if options is not None:
                if not isinstance(options, list):
                    return None
                if not all(isinstance(o, str) and o.strip() for o in options):
                    return None
            clarifications_clean.append(
                {
                    "key": key.strip(),
                    "question": question.strip(),
                    **(
                        {"options": [str(o).strip() for o in options if isinstance(o, str) and o.strip()]}
                        if isinstance(options, list)
                        else {}
                    ),
                    "allowMultiple": allow_multiple,
                }
            )

        tool_calls: list[dict[str, Any]] = []
        if tool_calls_raw is not None:
            tc_validated = self.validate_tool_calls_list(tool_calls_raw)
            if tc_validated is None:
                return None
            for item in tc_validated:
                if not _validate_edge_tool_call_args(item):
                    return None
            tool_calls = tc_validated

        # Invariant: clarifications XOR tool_calls.
        if clarifications_clean and tool_calls:
            return None

        if not isinstance(user_summary, str):
            user_summary = ""

        return {
            "clarifications": clarifications_clean,
            "tool_calls": tool_calls,
            "user_summary": user_summary.strip(),
        }


__all__ = ["HelperAgent"]
