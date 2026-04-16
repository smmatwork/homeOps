import { supabase } from "./supabaseClient";
import { executeToolCall } from "./agentApi";

export type HouseholdEventType =
  | "guest_arrival"
  | "vacation"
  | "occasion"
  | "weather"
  | "member_health"
  | "helper_leave";

export interface HouseholdEvent {
  id: string;
  household_id: string;
  type: HouseholdEventType | string;
  start_at: string;
  end_at: string | null;
  metadata: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

export const HOUSEHOLD_EVENT_TYPES: HouseholdEventType[] = [
  "guest_arrival",
  "vacation",
  "occasion",
  "weather",
  "member_health",
  "helper_leave",
];

export async function fetchHouseholdEvents(householdId: string): Promise<{
  events: HouseholdEvent[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("household_events")
    .select("id,household_id,type,start_at,end_at,metadata,created_by,created_at")
    .eq("household_id", householdId)
    .order("start_at", { ascending: false });

  if (error) {
    return { events: [], error: error.message };
  }

  return {
    events: (data ?? []) as HouseholdEvent[],
    error: null,
  };
}

export async function createHouseholdEvent(params: {
  accessToken: string;
  householdId: string;
  type: string;
  startAt: string;
  endAt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const res = await executeToolCall({
    accessToken: params.accessToken,
    householdId: params.householdId,
    scope: "household",
    toolCall: {
      id: `event_${Date.now()}`,
      tool: "db.insert",
      args: {
        table: "household_events",
        record: {
          household_id: params.householdId,
          type: params.type,
          start_at: params.startAt,
          end_at: params.endAt ?? null,
          metadata: params.metadata ?? {},
        },
      },
      reason: `Create household event: ${params.type}`,
    },
  });

  if (!res.ok) {
    return { ok: false, error: "error" in res ? res.error : "Failed to create event" };
  }
  return { ok: true, summary: res.summary };
}

export async function deleteHouseholdEvent(params: {
  accessToken: string;
  householdId: string;
  eventId: string;
}): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const res = await executeToolCall({
    accessToken: params.accessToken,
    householdId: params.householdId,
    scope: "household",
    toolCall: {
      id: `event_del_${Date.now()}`,
      tool: "db.delete",
      args: {
        table: "household_events",
        id: params.eventId,
      },
      reason: "Delete household event",
    },
  });

  if (!res.ok) {
    return { ok: false, error: "error" in res ? res.error : "Failed to delete event" };
  }
  return { ok: true, summary: res.summary };
}
