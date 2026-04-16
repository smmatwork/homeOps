import { supabase } from "./supabaseClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Recipe {
  id: string;
  title: string;
  sourceUrl: string | null;
  householdId: string | null;
  metadata: RecipeMetadata;
  createdAt: string;
}

export interface RecipeMetadata {
  description?: string;
  category?: string;
  cuisine?: string;
  prepTime?: string;
  cookTime?: string;
  servings?: number;
  difficulty?: string;
  ingredients?: string[];
  instructions?: string;
  dietaryTags?: string[];
  isFavorite?: boolean;
}

export interface MealPlanEntry {
  id: string;
  householdId: string;
  planDate: string;
  mealType: "breakfast" | "lunch" | "snack" | "dinner";
  recipeId: string | null;
  customMeal: string | null;
  notes: string | null;
  recipe?: Recipe;
}

export interface PantryItem {
  id: string;
  householdId: string;
  name: string;
  quantity: number;
  lowStockThreshold: number | null;
}

export interface ShoppingListItem {
  ingredient: string;
  neededForRecipes: string[];
  inPantry: boolean;
  pantryQuantity: number;
}

export const MEAL_TYPES = ["breakfast", "lunch", "snack", "dinner"] as const;

export const RECIPE_CATEGORIES = [
  "Breakfast",
  "Lunch",
  "Dinner",
  "Snack",
  "Dessert",
  "Beverage",
] as const;

// ---------------------------------------------------------------------------
// Recipes CRUD
// ---------------------------------------------------------------------------

export async function fetchRecipes(householdId: string): Promise<{
  recipes: Recipe[];
  error: string | null;
}> {
  // Fetch both global recipes and household-specific ones
  const { data, error } = await supabase
    .from("recipes")
    .select("*")
    .or(`household_id.is.null,household_id.eq.${householdId}`)
    .order("created_at", { ascending: false });

  if (error) return { recipes: [], error: error.message };

  const recipes: Recipe[] = (data ?? []).map(mapRecipeRow);
  return { recipes, error: null };
}

export async function createRecipe(params: {
  householdId: string;
  title: string;
  sourceUrl?: string;
  metadata: RecipeMetadata;
}): Promise<{ ok: true; recipe: Recipe } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("recipes")
    .insert({
      household_id: params.householdId,
      title: params.title,
      source_url: params.sourceUrl ?? null,
      metadata: params.metadata,
    })
    .select()
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, recipe: mapRecipeRow(data) };
}

export async function updateRecipe(params: {
  recipeId: string;
  title?: string;
  sourceUrl?: string;
  metadata?: RecipeMetadata;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const updates: Record<string, unknown> = {};
  if (params.title !== undefined) updates.title = params.title;
  if (params.sourceUrl !== undefined) updates.source_url = params.sourceUrl;
  if (params.metadata !== undefined) updates.metadata = params.metadata;

  const { error } = await supabase
    .from("recipes")
    .update(updates)
    .eq("id", params.recipeId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteRecipe(recipeId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const { error } = await supabase
    .from("recipes")
    .delete()
    .eq("id", recipeId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Meal Plans
// ---------------------------------------------------------------------------

export async function fetchMealPlans(
  householdId: string,
  startDate: string,
  endDate: string,
): Promise<{ plans: MealPlanEntry[]; error: string | null }> {
  const { data, error } = await supabase
    .from("meal_plans")
    .select("*, recipes(*)")
    .eq("household_id", householdId)
    .gte("plan_date", startDate)
    .lte("plan_date", endDate)
    .order("plan_date")
    .order("meal_type");

  if (error) return { plans: [], error: error.message };

  const plans: MealPlanEntry[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    householdId: String(row.household_id),
    planDate: String(row.plan_date),
    mealType: String(row.meal_type) as MealPlanEntry["mealType"],
    recipeId: row.recipe_id ? String(row.recipe_id) : null,
    customMeal: row.custom_meal ? String(row.custom_meal) : null,
    notes: row.notes ? String(row.notes) : null,
    recipe: row.recipes ? mapRecipeRow(row.recipes as Record<string, unknown>) : undefined,
  }));

  return { plans, error: null };
}

export async function upsertMealPlan(params: {
  householdId: string;
  planDate: string;
  mealType: string;
  recipeId?: string;
  customMeal?: string;
  notes?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const row: Record<string, unknown> = {
    household_id: params.householdId,
    plan_date: params.planDate,
    meal_type: params.mealType,
  };
  if (params.recipeId) row.recipe_id = params.recipeId;
  if (params.customMeal) row.custom_meal = params.customMeal;
  if (params.notes) row.notes = params.notes;

  const { error } = await supabase
    .from("meal_plans")
    .upsert(row, { onConflict: "household_id,plan_date,meal_type" });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteMealPlan(planId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const { error } = await supabase
    .from("meal_plans")
    .delete()
    .eq("id", planId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pantry
// ---------------------------------------------------------------------------

export async function fetchPantryItems(householdId: string): Promise<{
  items: PantryItem[];
  error: string | null;
}> {
  const { data, error } = await supabase
    .from("pantry_items")
    .select("*")
    .eq("household_id", householdId)
    .order("name");

  if (error) return { items: [], error: error.message };

  const items: PantryItem[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    householdId: String(row.household_id),
    name: String(row.name),
    quantity: Number(row.quantity ?? 0),
    lowStockThreshold: row.low_stock_threshold != null ? Number(row.low_stock_threshold) : null,
  }));

  return { items, error: null };
}

export async function upsertPantryItem(params: {
  householdId: string;
  name: string;
  quantity: number;
  lowStockThreshold?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("pantry_items")
    .upsert(
      {
        household_id: params.householdId,
        name: params.name,
        quantity: params.quantity,
        low_stock_threshold: params.lowStockThreshold ?? null,
      },
      { onConflict: "household_id,name" },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deletePantryItem(itemId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const { error } = await supabase
    .from("pantry_items")
    .delete()
    .eq("id", itemId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shopping List (computed from meal plan recipes vs pantry)
// ---------------------------------------------------------------------------

export function generateShoppingList(
  mealPlans: MealPlanEntry[],
  pantryItems: PantryItem[],
): ShoppingListItem[] {
  const ingredientMap = new Map<string, Set<string>>();

  for (const plan of mealPlans) {
    const recipe = plan.recipe;
    if (!recipe?.metadata.ingredients) continue;
    for (const ing of recipe.metadata.ingredients) {
      const key = ing.toLowerCase().trim();
      if (!ingredientMap.has(key)) ingredientMap.set(key, new Set());
      ingredientMap.get(key)!.add(recipe.title);
    }
  }

  const pantryLookup = new Map(
    pantryItems.map((p) => [p.name.toLowerCase().trim(), p]),
  );

  const items: ShoppingListItem[] = [];
  for (const [ingredient, recipes] of ingredientMap) {
    const pantryItem = pantryLookup.get(ingredient);
    items.push({
      ingredient,
      neededForRecipes: Array.from(recipes),
      inPantry: !!pantryItem && pantryItem.quantity > 0,
      pantryQuantity: pantryItem?.quantity ?? 0,
    });
  }

  // Sort: items not in pantry first
  items.sort((a, b) => {
    if (a.inPantry !== b.inPantry) return a.inPantry ? 1 : -1;
    return a.ingredient.localeCompare(b.ingredient);
  });

  return items;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapRecipeRow(row: Record<string, unknown>): Recipe {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    sourceUrl: row.source_url ? String(row.source_url) : null,
    householdId: row.household_id ? String(row.household_id) : null,
    metadata: {
      description: typeof meta.description === "string" ? meta.description : undefined,
      category: typeof meta.category === "string" ? meta.category : undefined,
      cuisine: typeof meta.cuisine === "string" ? meta.cuisine : undefined,
      prepTime: typeof meta.prepTime === "string" ? meta.prepTime : undefined,
      cookTime: typeof meta.cookTime === "string" ? meta.cookTime : undefined,
      servings: typeof meta.servings === "number" ? meta.servings : undefined,
      difficulty: typeof meta.difficulty === "string" ? meta.difficulty : undefined,
      ingredients: Array.isArray(meta.ingredients) ? meta.ingredients as string[] : undefined,
      instructions: typeof meta.instructions === "string" ? meta.instructions : undefined,
      dietaryTags: Array.isArray(meta.dietaryTags) ? meta.dietaryTags as string[] : undefined,
      isFavorite: typeof meta.isFavorite === "boolean" ? meta.isFavorite : undefined,
    },
    createdAt: String(row.created_at ?? ""),
  };
}
