/**
 * Chore Scheduler — Layer 2 of the chore state machine.
 *
 * Pure function: given room-based templates, existing chores, helpers,
 * and a scheduling horizon, produces chore instances to create.
 *
 * Key model: a template represents ONE ROOM's complete cleaning program.
 * Each template contains multiple tasks at different cadences.
 *
 * Properties:
 *  - Deterministic: same inputs → same outputs
 *  - Idempotent: running twice produces zero duplicates
 *  - No side effects: does not touch the database
 */

import { cadenceIntervalDays, type Cadence } from "./choreRecommendationEngine";
import type { HelperWorkPlan } from "./helperWorkPlan";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single task within a room routine (e.g. "Kitchen jhadu pocha · daily"). */
export interface TemplateTask {
  /** Stable key for this task within the template (e.g. "kitchen_daily_wipe"). */
  key: string;
  title: string;
  description?: string;
  cadence: Cadence;
  priority: number;
  estimatedMinutes: number;
  category?: string;
}

/**
 * A room-based chore template — one per room.
 * Contains all the tasks (at various cadences) for that room.
 */
export interface RoomTemplate {
  /** Template id (matches chore_templates.id in DB). */
  id: string;
  /** The room this template covers (e.g. "Kitchen", "Master Bedroom"). */
  space: string;
  /** The helper assigned to this room (all tasks). */
  defaultHelperId: string | null;
  /** The tasks that make up this room's cleaning program. */
  tasks: TemplateTask[];
  /** Extra metadata. */
  metadata: Record<string, unknown>;
}

/** Backwards-compatible flat template (used by engine auto-generation). */
export interface ChoreTemplate {
  id: string;
  title: string;
  space: string | null;
  cadence: Cadence;
  priority: number;
  estimatedMinutes: number | null;
  defaultHelperId: string | null;
  metadata: Record<string, unknown>;
}

export interface ExistingChore {
  id: string;
  templateId: string | null;
  title: string;
  dueAt: string | null;
  status: string;
  helperId: string | null;
  /** Person assigned (for user-only households). */
  assigneePersonId?: string | null;
  metadata: Record<string, unknown> | null;
}

export interface HelperInfo {
  id: string;
  name: string;
  capacityMinutes: number;
  /** Average feedback rating (null if no feedback). */
  averageRating: number | null;
  /** "helper" (default) or "person" — persons are household members. */
  kind?: "helper" | "person";
}

export interface TimeOffPeriod {
  helperId: string;
  startAt: string;
  endAt: string;
}

export interface SchedulerInput {
  /** Helper-based work plans (preferred). Each plan = one helper's full task list. */
  workPlans?: HelperWorkPlan[];
  /** Room-based templates (legacy). */
  roomTemplates?: RoomTemplate[];
  /** Flat templates (oldest legacy). Converted to room templates internally. */
  templates?: ChoreTemplate[];
  existingChores: ExistingChore[];
  helpers: HelperInfo[];
  timeOff: TimeOffPeriod[];
  /** Schedule from today to today + horizon days. Default 7. */
  horizon?: number;
  /** Override "today" for testing. Default: new Date(). */
  today?: Date;
}

export interface ChoreMutation {
  type: "create_chore";
  templateId: string;
  taskKey: string;
  title: string;
  space: string | null;
  cadence: Cadence;
  priority: number;
  estimatedMinutes: number | null;
  dueAt: string;
  helperId: string | null;
  /** Person assigned (for user-only households). */
  assigneePersonId?: string | null;
  status: "scheduled" | "assigned";
  metadata: Record<string, unknown>;
}

export interface SchedulerOutput {
  mutations: ChoreMutation[];
}

// ---------------------------------------------------------------------------
// Convert flat templates → room templates
// ---------------------------------------------------------------------------

/** Group flat ChoreTemplate[] by space into RoomTemplate[]. */
export function flatToRoomTemplates(flat: ChoreTemplate[]): RoomTemplate[] {
  const bySpace = new Map<string, { templates: ChoreTemplate[] }>();

  for (const t of flat) {
    const space = t.space ?? "Unassigned";
    const existing = bySpace.get(space);
    if (existing) {
      existing.templates.push(t);
    } else {
      bySpace.set(space, { templates: [t] });
    }
  }

  const rooms: RoomTemplate[] = [];
  for (const [space, { templates }] of bySpace) {
    const firstHelper = templates.find((t) => t.defaultHelperId)?.defaultHelperId ?? null;
    rooms.push({
      id: templates[0]?.id ?? `room_${space.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
      space,
      defaultHelperId: firstHelper,
      tasks: templates.map((t) => ({
        key: t.id,
        title: t.title,
        cadence: t.cadence,
        priority: t.priority,
        estimatedMinutes: t.estimatedMinutes ?? 30,
        category: typeof t.metadata?.category === "string" ? t.metadata.category : undefined,
      })),
      metadata: {},
    });
  }

  return rooms;
}

// ---------------------------------------------------------------------------
// Deterministic cadence → date matching
// ---------------------------------------------------------------------------

function stableHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Map day suffix to JS Date.getUTCDay() value (0=Sun, 1=Mon, ..., 6=Sat) */
const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export function templateOccursOnDate(
  cadence: Cadence,
  date: Date,
  taskKey: string,
): boolean {
  const dow = date.getUTCDay();
  const cadenceStr = String(cadence);

  // ── Daily ──────────────────────────────────────────────────────
  if (cadenceStr === "daily") return true;

  // ── Alternate days ─────────────────────────────────────────────
  if (cadenceStr === "alternate_days") {
    const epoch = new Date("2026-01-01T00:00:00Z").getTime();
    const daysSinceEpoch = Math.floor((date.getTime() - epoch) / (24 * 60 * 60 * 1000));
    const offset = stableHash(taskKey) % 2;
    return (daysSinceEpoch + offset) % 2 === 0;
  }

  // ── Every N days ───────────────────────────────────────────────
  if (/^every_\d_days$/.test(cadenceStr)) {
    const interval = cadenceIntervalDays(cadence);
    const epoch = new Date("2026-01-01T00:00:00Z").getTime();
    const daysSinceEpoch = Math.floor((date.getTime() - epoch) / (24 * 60 * 60 * 1000));
    const offset = stableHash(taskKey) % interval;
    return (daysSinceEpoch + offset) % interval === 0;
  }

  // ── Weekly with specific day (weekly_mon, weekly_sat, etc.) ────
  if (cadenceStr.startsWith("weekly_")) {
    const daySuffix = cadenceStr.slice(7); // "mon", "sat", etc.
    const targetDow = DAY_MAP[daySuffix];
    return targetDow !== undefined ? dow === targetDow : false;
  }

  // ── Weekly (legacy — use stable hash for day) ──────────────────
  if (cadenceStr === "weekly") {
    const targetDow = stableHash(taskKey) % 7;
    return dow === targetDow;
  }

  // ── Biweekly with specific day (biweekly_mon, biweekly_sat) ───
  if (cadenceStr.startsWith("biweekly_")) {
    const daySuffix = cadenceStr.slice(9);
    const targetDow = DAY_MAP[daySuffix];
    if (targetDow === undefined || dow !== targetDow) return false;
    // Alternate weeks: use ISO week number parity
    const epoch = new Date("2026-01-01T00:00:00Z").getTime();
    const weekNum = Math.floor((date.getTime() - epoch) / (7 * 24 * 60 * 60 * 1000));
    const parity = stableHash(taskKey) % 2;
    return weekNum % 2 === parity;
  }

  // ── Biweekly (legacy) ──────────────────────────────────────────
  if (cadenceStr === "biweekly") {
    const targetDow = stableHash(taskKey) % 7;
    if (dow !== targetDow) return false;
    const dayOfMonth = date.getUTCDate();
    const weekOfMonth = Math.floor((dayOfMonth - 1) / 7);
    return weekOfMonth === 0 || weekOfMonth === 2;
  }

  // ── Monthly ────────────────────────────────────────────────────
  if (cadenceStr === "monthly") {
    const targetDom = (stableHash(taskKey) % 28) + 1;
    return date.getUTCDate() === targetDom;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Helper selection
// ---------------------------------------------------------------------------

function isOnLeave(helperId: string, date: Date, timeOff: TimeOffPeriod[]): boolean {
  const ms = date.getTime();
  for (const period of timeOff) {
    if (period.helperId !== helperId) continue;
    const start = new Date(period.startAt).getTime();
    const end = new Date(period.endAt).getTime();
    if (start <= ms && ms < end) return true;
  }
  return false;
}

const DEFAULT_MINUTES_PER_CHORE = 30;

export function pickHelper(
  room: RoomTemplate,
  task: TemplateTask,
  date: Date,
  helpers: HelperInfo[],
  timeOff: TimeOffPeriod[],
  dayLoads: Map<string, number>,
): string | null {
  const candidates = helpers.filter((h) => {
    if (isOnLeave(h.id, date, timeOff)) return false;
    const currentLoad = dayLoads.get(h.id) ?? 0;
    if (h.capacityMinutes > 0 && currentLoad + task.estimatedMinutes > h.capacityMinutes) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Prefer the room's default helper if available.
  if (room.defaultHelperId && candidates.some((c) => c.id === room.defaultHelperId)) {
    return room.defaultHelperId;
  }

  // Sort by: highest rating → lowest load → alphabetical.
  candidates.sort((a, b) => {
    const ratingA = a.averageRating ?? 0;
    const ratingB = b.averageRating ?? 0;
    if (ratingA !== ratingB) return ratingB - ratingA;
    const loadA = dayLoads.get(a.id) ?? 0;
    const loadB = dayLoads.get(b.id) ?? 0;
    if (loadA !== loadB) return loadA - loadB;
    return a.name.localeCompare(b.name);
  });

  return candidates[0].id;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function dateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function computeDueAt(date: Date): string {
  const d = new Date(date);
  d.setUTCHours(9, 0, 0, 0);
  return d.toISOString();
}

export function scheduleChores(input: SchedulerInput): SchedulerOutput {
  const {
    existingChores,
    helpers,
    timeOff,
    horizon = 7,
    today = new Date(),
  } = input;

  // If work plans provided, use the helper-based scheduling path.
  if (input.workPlans && input.workPlans.length > 0) {
    return scheduleFromWorkPlans(input.workPlans, existingChores, timeOff, horizon, today);
  }

  // Legacy: resolve room templates, fall back to converting flat templates.
  const rooms: RoomTemplate[] = input.roomTemplates
    ? input.roomTemplates
    : input.templates
      ? flatToRoomTemplates(input.templates)
      : [];

  // Build existing (taskKey, dateKey) pairs for dedup.
  const existingKeys = new Set<string>();
  for (const chore of existingChores) {
    if (!chore.dueAt) continue;
    const dk = dateKey(new Date(chore.dueAt));
    // Use templateId as taskKey for backward compat, or extract from metadata.
    const tk = chore.templateId ?? (chore.metadata as any)?.template_task_key ?? "";
    if (tk) existingKeys.add(`${tk}::${dk}`);
  }

  // Pre-compute per-day helper loads.
  const dailyLoads = new Map<string, number>();
  for (const chore of existingChores) {
    if (!chore.helperId || !chore.dueAt) continue;
    if (chore.status === "done" || chore.status === "skipped") continue;
    const dk = dateKey(new Date(chore.dueAt));
    const key = `${chore.helperId}::${dk}`;
    const minutes = (chore.metadata as any)?.estimated_minutes ?? DEFAULT_MINUTES_PER_CHORE;
    dailyLoads.set(key, (dailyLoads.get(key) ?? 0) + minutes);
  }

  const mutations: ChoreMutation[] = [];
  const startDate = new Date(today);
  startDate.setUTCHours(0, 0, 0, 0);

  for (let dayOffset = 0; dayOffset < horizon; dayOffset += 1) {
    const date = new Date(startDate);
    date.setUTCDate(startDate.getUTCDate() + dayOffset);
    const dk = dateKey(date);

    // Per-helper load for this day.
    const dayHelperLoad = new Map<string, number>();
    for (const h of helpers) {
      dayHelperLoad.set(h.id, dailyLoads.get(`${h.id}::${dk}`) ?? 0);
    }

    for (const room of rooms) {
      for (const task of room.tasks) {
        if (!templateOccursOnDate(task.cadence, date, task.key)) continue;

        const existKey = `${task.key}::${dk}`;
        if (existingKeys.has(existKey)) continue;

        const assigneeId = pickHelper(room, task, date, helpers, timeOff, dayHelperLoad);
        const assignee = assigneeId ? helpers.find((h) => h.id === assigneeId) : null;
        const isPerson = assignee?.kind === "person";

        if (assigneeId) {
          dayHelperLoad.set(assigneeId, (dayHelperLoad.get(assigneeId) ?? 0) + task.estimatedMinutes);
        }

        mutations.push({
          type: "create_chore",
          templateId: room.id,
          taskKey: task.key,
          title: task.title,
          space: room.space,
          cadence: task.cadence,
          priority: task.priority,
          estimatedMinutes: task.estimatedMinutes,
          dueAt: computeDueAt(date),
          helperId: isPerson ? null : assigneeId,
          assigneePersonId: isPerson ? assigneeId : null,
          status: assigneeId ? "assigned" : "scheduled",
          metadata: {
            template_id: room.id,
            template_task_key: task.key,
            auto_scheduled: true,
            cadence: task.cadence,
            space: room.space,
            category: task.category,
            estimated_minutes: task.estimatedMinutes,
          },
        });

        existingKeys.add(existKey);
      }
    }
  }

  return { mutations };
}

// ---------------------------------------------------------------------------
// Helper-based scheduling (preferred path)
// ---------------------------------------------------------------------------

function scheduleFromWorkPlans(
  workPlans: HelperWorkPlan[],
  existingChores: ExistingChore[],
  timeOff: TimeOffPeriod[],
  horizon: number,
  today: Date,
): SchedulerOutput {
  // Build existing (taskKey, dateKey) pairs for dedup.
  const existingKeys = new Set<string>();
  for (const chore of existingChores) {
    if (!chore.dueAt) continue;
    const dk = dateKey(new Date(chore.dueAt));
    const tk = chore.templateId ?? (chore.metadata as any)?.template_task_key ?? "";
    if (tk) existingKeys.add(`${tk}::${dk}`);
  }

  const mutations: ChoreMutation[] = [];
  const startDate = new Date(today);
  startDate.setUTCHours(0, 0, 0, 0);

  for (let dayOffset = 0; dayOffset < horizon; dayOffset += 1) {
    const date = new Date(startDate);
    date.setUTCDate(startDate.getUTCDate() + dayOffset);
    const dk = dateKey(date);

    for (const plan of workPlans) {
      // Skip this helper entirely if they're on leave this day.
      if (isOnLeave(plan.helperId, date, timeOff)) continue;

      for (const task of plan.tasks) {
        if (!templateOccursOnDate(task.cadence, date, task.key)) continue;

        const existKey = `${task.key}::${dk}`;
        if (existingKeys.has(existKey)) continue;

        mutations.push({
          type: "create_chore",
          templateId: plan.helperId, // Group by helper
          taskKey: task.key,
          title: task.title,
          space: task.space,
          cadence: task.cadence,
          priority: task.priority,
          estimatedMinutes: task.estimatedMinutes,
          dueAt: computeDueAt(date),
          helperId: plan.helperId,
          status: "assigned",
          metadata: {
            template_task_key: task.key,
            auto_scheduled: true,
            cadence: task.cadence,
            space: task.space,
            category: task.category,
            estimated_minutes: task.estimatedMinutes,
            helper_name: plan.helperName,
          },
        });

        existingKeys.add(existKey);
      }
    }
  }

  return { mutations };
}
