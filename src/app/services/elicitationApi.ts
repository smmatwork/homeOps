import { supabase } from "./supabaseClient";

export type ElicitationTemplateId =
  | "specialty_kitchen"
  | "specialty_cleaning"
  | "specialty_outdoor"
  | "specialty_laundry";

/**
 * Human-friendly metadata for each template. The canonical area tags live
 * server-side (elicitation_area_tags SQL function) so the source of truth
 * for rule creation stays in one place.
 */
export const ELICITATION_QUESTIONS: Record<ElicitationTemplateId, {
  title: string;
  description: string;
}> = {
  specialty_kitchen: {
    title: "Who handles kitchen tasks?",
    description: "Cooking, dishwashing, kitchen cleaning, dining.",
  },
  specialty_cleaning: {
    title: "Who handles room / bathroom cleaning?",
    description: "Sweeping, mopping, dusting, bathrooms, bedrooms, common areas.",
  },
  specialty_outdoor: {
    title: "Who handles outdoor / garden tasks?",
    description: "Garden, balcony, garage, terrace.",
  },
  specialty_laundry: {
    title: "Who handles laundry / ironing?",
    description: "Washing clothes, ironing, folding.",
  },
};

export type StartElicitationResult =
  | { ok: true; totalCount: number; pendingCount: number; justSeeded: boolean }
  | { ok: false; error: string };

export async function startPatternElicitation(params: {
  householdId: string;
  actorUserId: string;
}): Promise<StartElicitationResult> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  if (!hid || !uid) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("start_pattern_elicitation", {
    p_household_id: hid,
    p_actor_user_id: uid,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "start_pattern_elicitation returned no row" };
  return {
    ok: true,
    totalCount: Number(row.total_count ?? 0),
    pendingCount: Number(row.pending_count ?? 0),
    justSeeded: Boolean(row.just_seeded),
  };
}

export type NextQuestionResult =
  | {
      ok: true;
      templateId: ElicitationTemplateId | null;
      status: string | null;
      askedAt: string | null;
      pendingCount: number;
      answeredCount: number;
    }
  | { ok: false; error: string };

export async function getNextElicitationQuestion(params: {
  householdId: string;
  actorUserId: string;
}): Promise<NextQuestionResult> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  if (!hid || !uid) return { ok: false, error: "Missing required arguments" };

  const { data, error } = await supabase.rpc("get_next_elicitation_question", {
    p_household_id: hid,
    p_actor_user_id: uid,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "get_next_elicitation_question returned no row" };
  return {
    ok: true,
    templateId: (row.template_id ?? null) as ElicitationTemplateId | null,
    status: row.status ?? null,
    askedAt: row.asked_at ?? null,
    pendingCount: Number(row.pending_count ?? 0),
    answeredCount: Number(row.answered_count ?? 0),
  };
}

export type AnswerElicitationResult =
  | { ok: true; status: "completed" | "skipped"; ruleId: string | null }
  | { ok: false; error: string };

export async function answerElicitationQuestion(params: {
  householdId: string;
  actorUserId: string;
  templateId: ElicitationTemplateId;
  helperId: string | null;
  skip?: boolean;
}): Promise<AnswerElicitationResult> {
  const hid = params.householdId.trim();
  const uid = params.actorUserId.trim();
  const tid = params.templateId;
  if (!hid || !uid || !tid) return { ok: false, error: "Missing required arguments" };

  const answer: Record<string, unknown> = {};
  if (params.skip) {
    answer.skip = true;
  } else if (params.helperId) {
    answer.helper_id = params.helperId;
  } else {
    answer.skip = true;
  }

  const { data, error } = await supabase.rpc("answer_elicitation_question", {
    p_household_id: hid,
    p_actor_user_id: uid,
    p_template_id: tid,
    p_answer: answer,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, error: "answer_elicitation_question returned no row" };
  const status = row.status === "completed" || row.status === "skipped"
    ? row.status
    : "skipped";
  return {
    ok: true,
    status,
    ruleId: row.rule_id ? String(row.rule_id) : null,
  };
}
