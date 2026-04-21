"""FACTS injection — fetch the household's real data and format it as a
system-prompt section that grounds every domain agent's response.

The returned block starts with "FACTS (real data from this household — do
NOT invent names or IDs):" followed by Helpers, Chores, People, and Spaces
sections. Downstream:
  - The router appends this to the system prompt before dispatching to any
    domain agent.
  - Regex-based hallucination detectors (main._needs_helpers_fetch_override
    etc.) scan for "invented" names the agent produced and force a fresh
    db.select when the agent's prose contradicts FACTS.
  - Keyword-match resolvers scan FACTS for chore IDs before falling back to
    the find_chores_matching_keywords RPC.

Row caps (Helpers=20, Chores=30, People=20, Spaces=25) and the 60-char
description truncation are tuned for sarvam-m's ~7K token budget. Changing
them requires re-validating the token budget upstream.

Per-domain FACTS scoping (e.g., Service agent only sees home_features +
services + vendors, not chores) is a future extension — this module would
grow a `scope: Literal["chore","service","helper"]` parameter that filters
which sections are included.
"""

from __future__ import annotations

import os
import urllib.parse
from typing import Any

import httpx


_DEFAULT_TIMEOUT_SECONDS = 5.0
_HELPERS_LIMIT = 20
_CHORES_LIMIT = 30
_PEOPLE_LIMIT = 20
_SPACES_CAP = 25
_DESCRIPTION_TRIM_CHARS = 60

# Local-dev service_role key emitted by `supabase start`. Only used when the
# service runs against 127.0.0.1 with no SUPABASE_SERVICE_ROLE_KEY configured.
_LOCAL_DEFAULT_SERVICE_ROLE_JWT = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0."
    "EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
)


def _resolve_supabase_credentials() -> tuple[str, str]:
    """Return (sb_url, sb_key) for the Supabase REST API.

    Prefers SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Falls back to parsing
    EDGE_BASE_URL if SUPABASE_URL is unset. Replaces host.docker.internal
    with 127.0.0.1 so the resolution works both inside a container and on
    the host. When running against local Supabase with no key configured,
    uses the well-known local service_role JWT.

    Returns ("", "") if no key can be resolved (caller must treat as
    no-FACTS available).
    """
    sb_url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    if not sb_url:
        edge = (os.environ.get("EDGE_BASE_URL") or "").strip()
        if edge:
            parsed = urllib.parse.urlparse(edge)
            host = parsed.hostname or "127.0.0.1"
            if host == "host.docker.internal":
                host = "127.0.0.1"
            port = parsed.port or 54321
            sb_url = f"{parsed.scheme or 'http'}://{host}:{port}"
        else:
            sb_url = "http://127.0.0.1:54321"

    sb_key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("EDGE_BEARER_TOKEN")
        or ""
    )
    if not sb_key and "127.0.0.1" in sb_url:
        sb_key = _LOCAL_DEFAULT_SERVICE_ROLE_JWT

    return sb_url, sb_key


async def build_facts_section(household_id: str, _user_id: str = "") -> str:
    """Query the household's Helpers / Chores / People / Spaces and format
    them into a FACTS block for inclusion in the system prompt.

    `_user_id` is accepted for API compatibility with the pre-refactor
    signature but is unused — household_id is the only scope filter needed
    because the service_role key bypasses RLS. A future per-user FACTS scope
    would use this argument.

    Returns an empty string when household_id is missing or when Supabase
    credentials can't be resolved, which signals the caller to skip FACTS
    injection entirely (rather than inserting a misleading empty block).
    """
    if not household_id:
        return ""

    sb_url, sb_key = _resolve_supabase_credentials()
    if not sb_key:
        return ""

    facts_parts: list[str] = [
        "FACTS (real data from this household — do NOT invent names or IDs):"
    ]
    headers = {
        "apikey": sb_key,
        "Authorization": f"Bearer {sb_key}",
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(_DEFAULT_TIMEOUT_SECONDS)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            # Helpers
            r = await client.get(
                f"{sb_url}/rest/v1/helpers",
                params={
                    "household_id": f"eq.{household_id}",
                    "select": "id,name,type",
                    "limit": str(_HELPERS_LIMIT),
                },
                headers=headers,
            )
            helpers = r.json() if r.status_code == 200 and isinstance(r.json(), list) else []
            if helpers:
                helper_lines = [
                    f"  - {h['name']} (id={h['id']}, type={h.get('type', 'n/a')})"
                    for h in helpers
                ]
                facts_parts.append("Helpers:\n" + "\n".join(helper_lines))
            else:
                facts_parts.append("Helpers: none registered.")

            # Chores — include description so downstream resolvers can match
            # references to words that only appear in descriptions (e.g.
            # "toy", "clutter sweep"). Token budget is tight; cap count and
            # truncate descriptions.
            r2 = await client.get(
                f"{sb_url}/rest/v1/chores",
                params={
                    "household_id": f"eq.{household_id}",
                    "deleted_at": "is.null",
                    "select": "id,title,description,status,helper_id,metadata",
                    "order": "created_at.desc",
                    "limit": str(_CHORES_LIMIT),
                },
                headers=headers,
            )
            chores = r2.json() if r2.status_code == 200 and isinstance(r2.json(), list) else []
            if chores:
                chore_lines: list[str] = []
                for c in chores:
                    meta: Any = c.get("metadata") or {}
                    space = meta.get("space", "") if isinstance(meta, dict) else ""
                    cadence = meta.get("cadence", "") if isinstance(meta, dict) else ""
                    desc = (c.get("description") or "").strip().replace("\n", " ")
                    if len(desc) > _DESCRIPTION_TRIM_CHARS:
                        desc = desc[: _DESCRIPTION_TRIM_CHARS - 3] + "..."
                    desc_part = f", desc=\"{desc}\"" if desc else ""
                    chore_lines.append(
                        f"  - \"{c['title']}\" (id={c['id']}, status={c['status']}, "
                        f"space={space}, cadence={cadence}{desc_part})"
                    )
                facts_parts.append(
                    f"Chores (showing {len(chores)}):\n" + "\n".join(chore_lines)
                )
            else:
                facts_parts.append("Chores: none.")

            # Household people — family members. For user-only households
            # this prevents hallucinated person names from the LLM.
            r_people = await client.get(
                f"{sb_url}/rest/v1/household_people",
                params={
                    "household_id": f"eq.{household_id}",
                    "select": "id,display_name,person_type",
                    "limit": str(_PEOPLE_LIMIT),
                },
                headers=headers,
            )
            people = r_people.json() if r_people.status_code == 200 and isinstance(r_people.json(), list) else []
            if people:
                people_lines = [
                    f"  - {p['display_name']} (id={p['id']}, type={p.get('person_type', 'adult')})"
                    for p in people
                ]
                facts_parts.append("People (household members):\n" + "\n".join(people_lines))

            # Spaces (from the home_profile row, which stores an array of
            # space names or dicts with display_name).
            r3 = await client.get(
                f"{sb_url}/rest/v1/home_profiles",
                params={
                    "household_id": f"eq.{household_id}",
                    "select": "spaces",
                    "limit": "1",
                },
                headers=headers,
            )
            profiles = r3.json() if r3.status_code == 200 and isinstance(r3.json(), list) else []
            if profiles:
                spaces_raw = profiles[0].get("spaces") or []
                space_names: list[str] = []
                for s in (spaces_raw if isinstance(spaces_raw, list) else []):
                    if isinstance(s, str):
                        space_names.append(s)
                    elif isinstance(s, dict) and isinstance(s.get("display_name"), str):
                        space_names.append(s["display_name"])
                if space_names:
                    facts_parts.append("Spaces: " + ", ".join(space_names[:_SPACES_CAP]))
    except Exception as e:
        facts_parts.append(f"(Could not load household data: {str(e)[:100]})")

    return "\n".join(facts_parts)


__all__ = ["build_facts_section"]
