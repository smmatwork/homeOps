import type { HouseholdEvent } from "./householdEventsApi";
import type { CoverageGap, CoverageRow } from "./coverageApi";
import type { HelperWorkload } from "./helperWorkloadApi";

export type ProposalKind =
  | "reassign_helper"
  | "add_chore"
  | "skip_chore"
  | "balance_workload"
  | "coverage_gap";

export type ProposalSeverity = "info" | "warning" | "critical";

export interface Proposal {
  id: string;
  kind: ProposalKind;
  severity: ProposalSeverity;
  title: string;
  description: string;
  triggerType: string;
  triggerId?: string;
  // Suggested action params (optional - depends on kind)
  suggestedAction?: {
    type: "reassign" | "create_chore" | "skip" | "info_only";
    helperId?: string;
    space?: string;
    cadence?: string;
  };
}

export interface ReplanInputs {
  events: HouseholdEvent[];
  coverageRows?: CoverageRow[];
  coverageGaps?: CoverageGap[];
  workloads?: HelperWorkload[];
  helpers?: Array<{ id: string; name: string }>;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isWithinDays(iso: string, days: number): boolean {
  const target = new Date(iso);
  const now = startOfDay(new Date());
  const diff = (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 && diff <= days;
}

/**
 * Pure function that proposes adjustments based on current state.
 * No side effects — returns a list of proposals for the user to review.
 */
export function proposeAdjustments(inputs: ReplanInputs): Proposal[] {
  const proposals: Proposal[] = [];
  const { events, coverageGaps = [], workloads = [], helpers = [] } = inputs;
  const helpersById = new Map(helpers.map((h) => [h.id, h]));

  // 1. Upcoming events → propose adjustments
  for (const event of events) {
    if (!isWithinDays(event.start_at, 14)) continue;

    switch (event.type) {
      case "guest_arrival": {
        proposals.push({
          id: `event_${event.id}_guests`,
          kind: "add_chore",
          severity: "info",
          title: "Guests arriving — extra cleaning recommended",
          description: `Guests arriving on ${new Date(event.start_at).toLocaleDateString()}. Consider scheduling a deep clean of the kitchen and bathrooms beforehand.`,
          triggerType: "guest_arrival",
          triggerId: event.id,
          suggestedAction: { type: "create_chore" },
        });
        break;
      }

      case "vacation": {
        proposals.push({
          id: `event_${event.id}_vacation`,
          kind: "skip_chore",
          severity: "info",
          title: "Vacation — pause non-critical chores",
          description: `Vacation from ${new Date(event.start_at).toLocaleDateString()}${event.end_at ? ` to ${new Date(event.end_at).toLocaleDateString()}` : ""}. Skip cooking and cleaning during this period.`,
          triggerType: "vacation",
          triggerId: event.id,
          suggestedAction: { type: "skip" },
        });
        break;
      }

      case "helper_leave": {
        const meta = event.metadata as Record<string, unknown>;
        const helperId = typeof meta.helper_id === "string" ? meta.helper_id : null;
        const helper = helperId ? helpersById.get(helperId) : null;
        proposals.push({
          id: `event_${event.id}_helper_leave`,
          kind: "reassign_helper",
          severity: "warning",
          title: helper ? `${helper.name} on leave — reassign chores` : "Helper on leave — reassign chores",
          description: `Helper unavailable from ${new Date(event.start_at).toLocaleDateString()}. Reassign their active chores to another helper.`,
          triggerType: "helper_leave",
          triggerId: event.id,
          suggestedAction: { type: "reassign", helperId: helperId ?? undefined },
        });
        break;
      }

      case "occasion": {
        proposals.push({
          id: `event_${event.id}_occasion`,
          kind: "add_chore",
          severity: "info",
          title: "Special occasion approaching",
          description: `Special occasion on ${new Date(event.start_at).toLocaleDateString()}. Plan extra preparation chores.`,
          triggerType: "occasion",
          triggerId: event.id,
          suggestedAction: { type: "create_chore" },
        });
        break;
      }

      case "weather": {
        proposals.push({
          id: `event_${event.id}_weather`,
          kind: "skip_chore",
          severity: "info",
          title: "Weather event — adjust outdoor chores",
          description: `Weather event on ${new Date(event.start_at).toLocaleDateString()}. Skip outdoor cleaning (balcony, garden) on this day.`,
          triggerType: "weather",
          triggerId: event.id,
          suggestedAction: { type: "skip" },
        });
        break;
      }

      case "member_health": {
        proposals.push({
          id: `event_${event.id}_health`,
          kind: "balance_workload",
          severity: "warning",
          title: "Member health change — adjust workload",
          description: "A household member is unwell. Reduce their assigned chores temporarily.",
          triggerType: "member_health",
          triggerId: event.id,
          suggestedAction: { type: "info_only" },
        });
        break;
      }

      default:
        break;
    }
  }

  // 2. Coverage gaps → propose
  for (const gap of coverageGaps.slice(0, 5)) {
    proposals.push({
      id: `gap_${gap.space}_${gap.cadence}`,
      kind: "coverage_gap",
      severity: "warning",
      title: `Coverage gap: ${gap.space} (${gap.cadence})`,
      description: `${gap.reason}. Consider assigning a helper or adding automation.`,
      triggerType: "coverage_gap",
      suggestedAction: { type: "create_chore", space: gap.space, cadence: gap.cadence },
    });
  }

  // 3. Over-capacity helpers → propose rebalancing
  for (const w of workloads) {
    if (w.isOverCapacity) {
      proposals.push({
        id: `overcap_${w.helperId}`,
        kind: "balance_workload",
        severity: "critical",
        title: `${w.helperName} over capacity`,
        description: `${w.helperName} has ${w.estimatedMinutes} minutes assigned but only ${w.capacityMinutes} minutes capacity. Consider rebalancing chores to other helpers.`,
        triggerType: "over_capacity",
        suggestedAction: { type: "reassign", helperId: w.helperId },
      });
    }
  }

  return proposals;
}
