"""Conversation-window management — rolling summary + hard truncation.

Every domain agent's messages flow through this before they hit the LLM, so
it's orchestrator-scope, not chore-agent-specific.

Two-stage compression:

  Stage 1 — rolling summary (summarize_history_if_needed):
    Keep the last SUMMARY_KEEP_RECENT_TURNS body turns verbatim. Fold older
    turns into a per-conversation summary cached in-process. On subsequent
    calls only the newly-aged-out turns are sent to the summarizer LLM; the
    accumulated summary is never re-generated from scratch.

  Stage 2 — hard truncation (truncate_messages_to_budget):
    Runs inside _sarvam_chat as the universal safety net. Drops oldest
    non-system, non-final-user turns until the message array fits
    char_budget. Last user message is always preserved (it's the question).

Persistence: the chat_summaries table from migration 20260309123000 exists
but writes are deferred — v1 is in-process only. On service restart the
summary regenerates lazily on the next over-budget call.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable


ChatFn = Callable[..., Awaitable[Any]]


# ── Budget + summary tuning ──────────────────────────────────────────────────
# Each int() wraps `(os.environ.get(...) or "").strip() or default` — the
# stripping is load-bearing. Pre-refactor main.py used a helper (_env) that
# stripped internally; os.environ.get returns "   " unchanged and "   " is
# truthy, so a naive `get(...) or default` would let whitespace through to
# int() and crash module load.

SARVAM_PROMPT_CHAR_BUDGET = int(
    (os.environ.get("SARVAM_PROMPT_CHAR_BUDGET") or "").strip() or "17000"
)

SUMMARY_KEEP_RECENT_TURNS = int(
    (os.environ.get("AGENT_SUMMARY_KEEP_RECENT_TURNS") or "").strip() or "2"
)
SUMMARY_MAX_TOKENS = int(
    (os.environ.get("AGENT_SUMMARY_MAX_TOKENS") or "").strip() or "200"
)
SUMMARY_FOLD_INPUT_CAP_CHARS = int(
    (os.environ.get("AGENT_SUMMARY_FOLD_INPUT_CAP") or "").strip() or "1500"
)

SUMMARIZER_SYSTEM_PROMPT = (
    "You are summarizing a conversation between a user and a home management assistant. "
    "Update the running summary by folding in the new exchange.\n\n"
    "Rules:\n"
    "- Output ONLY the new summary, no preamble or markdown.\n"
    "- Keep it under 100 words.\n"
    "- Focus on: user's goals, decisions made, named entities (chores, helpers, dates), pending questions.\n"
    "- Drop greetings, chit-chat, and tool-result blobs.\n"
    "- If a list of items (e.g. chores) was shown, mention only that 'a list of N items was shown' — do NOT enumerate.\n"
    "- Preserve specific keywords the user used to refer to records ('toy', 'clutter sweep') so the assistant can resolve them later."
)


@dataclass
class ConversationSummary:
    summary: str = ""
    summarized_count: int = 0  # how many body messages have been folded in


# Process-local cache. Not bounded — fine for typical workloads where
# conversations are short-lived. Persist to chat_summaries table as a
# follow-up if memory pressure becomes a concern.
summary_cache: dict[str, ConversationSummary] = {}


# ── Summarization ────────────────────────────────────────────────────────────

async def fold_summary(
    cached_summary: str,
    new_messages: list[dict[str, str]],
    model: str,
    *,
    chat_fn: ChatFn,
) -> str:
    """Fold new turns into an existing rolling summary via a focused LLM call.

    Returns the updated summary string. On any failure, returns the cached
    summary unchanged so we never lose accumulated context to a transient
    error.
    """
    lines: list[str] = []
    for m in new_messages:
        role = (m.get("role") or "").strip()
        content = (m.get("content") or "").strip()
        if not content or role == "system":
            continue
        if len(content) > SUMMARY_FOLD_INPUT_CAP_CHARS:
            content = content[:SUMMARY_FOLD_INPUT_CAP_CHARS] + "...[truncated]"
        lines.append(f"{role.upper()}: {content}")
    if not lines:
        return cached_summary
    new_block = "\n".join(lines)

    user_input = (
        f"Existing summary:\n{cached_summary or '(none yet)'}\n\n"
        f"New exchange to fold in:\n{new_block}\n\n"
        "Updated summary:"
    )
    try:
        raw = await chat_fn(
            messages=[
                {"role": "system", "content": SUMMARIZER_SYSTEM_PROMPT},
                {"role": "user", "content": user_input},
            ],
            model=model,
            temperature=0.0,
            max_tokens=SUMMARY_MAX_TOKENS,
        )
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    except Exception as e:
        logging.warning(f"summary fold failed for {len(new_messages)} turns: {e}")
    return cached_summary


async def summarize_history_if_needed(
    messages: list[dict[str, str]],
    *,
    conversation_id: str,
    model: str,
    chat_fn: ChatFn,
    char_budget: int = SARVAM_PROMPT_CHAR_BUDGET,
) -> list[dict[str, str]]:
    """Compress conversation history via rolling summary when over budget.

    Cheap fast path: if total chars are under budget, return as-is. Otherwise
    keep the system message + last SUMMARY_KEEP_RECENT_TURNS turns verbatim
    and fold older turns into a per-conversation rolling summary that's
    appended to the system message. Only the *new* turns since the last
    summarization are sent to the summarizer LLM.

    If conversation_id is missing (no caching key) we fall through unchanged
    and let truncate_messages_to_budget handle it downstream.
    """
    if not messages:
        return messages

    def total_chars(ms: list[dict[str, str]]) -> int:
        return sum(len(m.get("content", "")) + len(m.get("role", "")) + 16 for m in ms)

    initial = total_chars(messages)
    if initial <= char_budget:
        return messages

    print(
        "summarize_check",
        {
            "initial_chars": initial,
            "char_budget": char_budget,
            "msg_count": len(messages),
            "conv_id": (conversation_id[:8] + "...") if conversation_id else "",
        },
        flush=True,
    )

    if not conversation_id:
        print("summarize_skip", {"reason": "no_conv_id"}, flush=True)
        return messages

    has_system = messages[0].get("role") == "system"
    system_msg = messages[0] if has_system else None
    body = messages[1:] if has_system else list(messages)

    if len(body) <= SUMMARY_KEEP_RECENT_TURNS:
        print(
            "summarize_skip",
            {"reason": "body_too_short", "body_len": len(body), "keep": SUMMARY_KEEP_RECENT_TURNS},
            flush=True,
        )
        return messages

    to_consider = body[: -SUMMARY_KEEP_RECENT_TURNS]
    recent = body[-SUMMARY_KEEP_RECENT_TURNS:]

    cached = summary_cache.get(conversation_id, ConversationSummary())
    new_to_fold = to_consider[cached.summarized_count:]

    if new_to_fold:
        new_summary = await fold_summary(cached.summary, new_to_fold, model, chat_fn=chat_fn)
        cached = ConversationSummary(
            summary=new_summary,
            summarized_count=len(to_consider),
        )
        summary_cache[conversation_id] = cached

    if not cached.summary:
        return messages

    summary_note = f"\n\nConversation summary so far:\n{cached.summary}"
    if system_msg:
        merged_system = {
            "role": "system",
            "content": (system_msg.get("content", "") or "").rstrip() + summary_note,
        }
        result: list[dict[str, str]] = [merged_system] + recent
    else:
        result = [{"role": "system", "content": "Conversation summary so far:\n" + cached.summary}] + recent

    return result


# ── Hard truncation (no LLM) ─────────────────────────────────────────────────

def truncate_messages_to_budget(
    messages: list[dict[str, str]],
    char_budget: int = SARVAM_PROMPT_CHAR_BUDGET,
) -> list[dict[str, str]]:
    """Drop oldest non-system, non-final-user turns until under the char budget.

    Preserves the system message (if first) and the last user message in
    every case — those are the question being answered. Older history is
    discarded oldest-first when the total exceeds char_budget.
    """
    if not messages:
        return messages

    def total_chars(ms: list[dict[str, str]]) -> int:
        return sum(len(m.get("content", "")) + len(m.get("role", "")) + 16 for m in ms)

    initial_chars = total_chars(messages)
    if initial_chars <= char_budget:
        return messages

    print(
        "sarvam_truncate_fired",
        {"initial_chars": initial_chars, "char_budget": char_budget, "msg_count": len(messages)},
        flush=True,
    )

    has_system = messages[0].get("role") == "system"
    system_msg = messages[0] if has_system else None
    body = messages[1:] if has_system else list(messages)

    # Find the last user message — always preserve it.
    last_user_idx: int | None = None
    for i in range(len(body) - 1, -1, -1):
        if body[i].get("role") == "user":
            last_user_idx = i
            break

    if last_user_idx is None:
        keep = body
    else:
        protected_tail = body[last_user_idx:]
        droppable = body[:last_user_idx]
        keep = protected_tail
        for i in range(len(droppable) - 1, -1, -1):
            candidate = [droppable[i]] + keep
            probe = ([system_msg] if system_msg else []) + candidate
            if total_chars(probe) > char_budget:
                break
            keep = candidate

    result = ([system_msg] if system_msg else []) + keep
    if total_chars(result) > char_budget and system_msg is not None:
        # System message itself blew the budget — truncate its content as a
        # last resort. Keeps the head (FACTS + tool schemas) and marks the
        # truncation.
        sys_content = system_msg.get("content", "")
        overflow = total_chars(result) - char_budget
        if overflow > 0 and len(sys_content) > overflow + 64:
            new_len = max(64, len(sys_content) - overflow - 64)
            truncated_sys = {
                "role": "system",
                "content": sys_content[:new_len] + "\n...[truncated for context budget]",
            }
            result = [truncated_sys] + keep
    return result


__all__ = [
    "SARVAM_PROMPT_CHAR_BUDGET",
    "SUMMARY_KEEP_RECENT_TURNS",
    "SUMMARY_MAX_TOKENS",
    "SUMMARY_FOLD_INPUT_CAP_CHARS",
    "SUMMARIZER_SYSTEM_PROMPT",
    "ConversationSummary",
    "summary_cache",
    "fold_summary",
    "summarize_history_if_needed",
    "truncate_messages_to_budget",
]
