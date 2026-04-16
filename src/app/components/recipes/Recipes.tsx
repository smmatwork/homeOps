import { useEffect, useMemo, useState, useCallback } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  Add,
  CheckCircle,
  Delete,
  Edit,
  Favorite,
  FavoriteBorder,
  People,
  Search,
  ShoppingCart,
  Timer,
} from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { useAuth } from "../../auth/AuthProvider";
import {
  MEAL_TYPES,
  RECIPE_CATEGORIES,
  createRecipe,
  deleteRecipe,
  deleteMealPlan,
  fetchMealPlans,
  fetchPantryItems,
  fetchRecipes,
  generateShoppingList,
  updateRecipe,
  upsertMealPlan,
  type MealPlanEntry,
  type PantryItem,
  type Recipe,
  type RecipeMetadata,
  type ShoppingListItem,
} from "../../services/recipesApi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mondayOfWeek(offset: number): Date {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) + offset * 7;
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateShort(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekDates(weekOffset: number): Date[] {
  const monday = mondayOfWeek(weekOffset);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function Recipes() {
  const { householdId } = useAuth();
  const { t } = useI18n();

  const [tab, setTab] = useState(0);
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  // ── Recipes state ──────────────────────────────────────────────
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipesLoading, setRecipesLoading] = useState(true);
  const [recipesError, setRecipesError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<Recipe | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  // Recipe form fields
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState("");
  const [formCuisine, setFormCuisine] = useState("");
  const [formPrepTime, setFormPrepTime] = useState("");
  const [formCookTime, setFormCookTime] = useState("");
  const [formServings, setFormServings] = useState("");
  const [formDifficulty, setFormDifficulty] = useState("");
  const [formIngredients, setFormIngredients] = useState("");
  const [formInstructions, setFormInstructions] = useState("");
  const [formSourceUrl, setFormSourceUrl] = useState("");

  // ── Meal planner state ─────────────────────────────────────────
  const [weekOffset, setWeekOffset] = useState(0);
  const [mealPlans, setMealPlans] = useState<MealPlanEntry[]>([]);
  const [mealsLoading, setMealsLoading] = useState(false);
  const [mealDialogOpen, setMealDialogOpen] = useState(false);
  const [mealDate, setMealDate] = useState("");
  const [mealType, setMealType] = useState<string>("lunch");
  const [mealRecipeId, setMealRecipeId] = useState<string | null>(null);
  const [mealCustom, setMealCustom] = useState("");
  const [mealNotes, setMealNotes] = useState("");
  const [mealBusy, setMealBusy] = useState(false);

  // ── Shopping list state ────────────────────────────────────────
  const [pantry, setPantry] = useState<PantryItem[]>([]);
  const [pantryLoading, setPantryLoading] = useState(false);

  // ── Data loading ───────────────────────────────────────────────

  const loadRecipes = useCallback(async () => {
    if (!householdId) { setRecipesLoading(false); return; }
    setRecipesLoading(true);
    setRecipesError(null);
    const result = await fetchRecipes(householdId);
    setRecipesLoading(false);
    if (result.error) {
      setRecipesError(result.error);
      return;
    }
    setRecipes(result.recipes);
  }, [householdId]);

  const dates = useMemo(() => weekDates(weekOffset), [weekOffset]);

  const loadMealPlans = useCallback(async () => {
    if (!householdId || dates.length === 0) return;
    setMealsLoading(true);
    const result = await fetchMealPlans(
      householdId,
      toIsoDate(dates[0]),
      toIsoDate(dates[6]),
    );
    setMealsLoading(false);
    if (!result.error) setMealPlans(result.plans);
  }, [householdId, dates]);

  const loadPantry = useCallback(async () => {
    if (!householdId) return;
    setPantryLoading(true);
    const result = await fetchPantryItems(householdId);
    setPantryLoading(false);
    if (!result.error) setPantry(result.items);
  }, [householdId]);

  useEffect(() => {
    void loadRecipes();
  }, [loadRecipes]);

  useEffect(() => {
    if (tab === 1) void loadMealPlans();
  }, [tab, loadMealPlans]);

  useEffect(() => {
    if (tab === 2) {
      void loadMealPlans();
      void loadPantry();
    }
  }, [tab, loadMealPlans, loadPantry]);

  // ── Recipe form helpers ────────────────────────────────────────

  const resetForm = () => {
    setFormTitle("");
    setFormDescription("");
    setFormCategory("");
    setFormCuisine("");
    setFormPrepTime("");
    setFormCookTime("");
    setFormServings("");
    setFormDifficulty("");
    setFormIngredients("");
    setFormInstructions("");
    setFormSourceUrl("");
    setEditingRecipe(null);
  };

  const openAddDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (recipe: Recipe) => {
    setEditingRecipe(recipe);
    const m = recipe.metadata;
    setFormTitle(recipe.title);
    setFormDescription(m.description ?? "");
    setFormCategory(m.category ?? "");
    setFormCuisine(m.cuisine ?? "");
    setFormPrepTime(m.prepTime ?? "");
    setFormCookTime(m.cookTime ?? "");
    setFormServings(m.servings?.toString() ?? "");
    setFormDifficulty(m.difficulty ?? "");
    setFormIngredients((m.ingredients ?? []).join("\n"));
    setFormInstructions(m.instructions ?? "");
    setFormSourceUrl(recipe.sourceUrl ?? "");
    setDialogOpen(true);
  };

  const handleSaveRecipe = async () => {
    if (!householdId || !formTitle.trim()) return;
    setSaveBusy(true);

    const metadata: RecipeMetadata = {
      description: formDescription || undefined,
      category: formCategory || undefined,
      cuisine: formCuisine || undefined,
      prepTime: formPrepTime || undefined,
      cookTime: formCookTime || undefined,
      servings: formServings ? parseInt(formServings, 10) : undefined,
      difficulty: formDifficulty || undefined,
      ingredients: formIngredients
        ? formIngredients.split("\n").map((s) => s.trim()).filter(Boolean)
        : undefined,
      instructions: formInstructions || undefined,
    };

    let result;
    if (editingRecipe) {
      result = await updateRecipe({
        recipeId: editingRecipe.id,
        title: formTitle,
        sourceUrl: formSourceUrl || undefined,
        metadata,
      });
    } else {
      result = await createRecipe({
        householdId,
        title: formTitle,
        sourceUrl: formSourceUrl || undefined,
        metadata,
      });
    }

    setSaveBusy(false);

    if (!result.ok) {
      setSnack({ msg: "error" in result ? result.error : "Failed to save", severity: "error" });
      return;
    }

    setDialogOpen(false);
    resetForm();
    setSnack({ msg: editingRecipe ? "Recipe updated" : "Recipe added", severity: "success" });
    await loadRecipes();
  };

  const handleDeleteRecipe = async (id: string) => {
    const result = await deleteRecipe(id);
    if (!result.ok) {
      setSnack({ msg: "error" in result ? result.error : "Failed to delete", severity: "error" });
      return;
    }
    setSnack({ msg: "Recipe deleted", severity: "success" });
    await loadRecipes();
  };

  const handleToggleFavorite = async (recipe: Recipe) => {
    await updateRecipe({
      recipeId: recipe.id,
      metadata: { ...recipe.metadata, isFavorite: !recipe.metadata.isFavorite },
    });
    await loadRecipes();
  };

  // ── Meal plan handlers ─────────────────────────────────────────

  const openMealDialog = (date: Date, meal: string) => {
    setMealDate(toIsoDate(date));
    setMealType(meal);
    setMealRecipeId(null);
    setMealCustom("");
    setMealNotes("");
    setMealDialogOpen(true);
  };

  const handleSaveMealPlan = async () => {
    if (!householdId || !mealDate) return;
    setMealBusy(true);
    const result = await upsertMealPlan({
      householdId,
      planDate: mealDate,
      mealType: mealType,
      recipeId: mealRecipeId ?? undefined,
      customMeal: mealCustom || undefined,
      notes: mealNotes || undefined,
    });
    setMealBusy(false);
    if (!result.ok) {
      setSnack({ msg: "error" in result ? result.error : "Failed to save", severity: "error" });
      return;
    }
    setMealDialogOpen(false);
    await loadMealPlans();
  };

  const handleDeleteMealPlan = async (planId: string) => {
    const result = await deleteMealPlan(planId);
    if (result.ok) await loadMealPlans();
  };

  // ── Shopping list (computed) ───────────────────────────────────

  const shoppingList: ShoppingListItem[] = useMemo(
    () => generateShoppingList(mealPlans, pantry),
    [mealPlans, pantry],
  );

  // ── Filtered recipes ──────────────────────────────────────────

  const filteredRecipes = recipes.filter((r) => {
    const matchesSearch =
      r.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (r.metadata.cuisine ?? "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory =
      category === "all" || r.metadata.category === category;
    return matchesSearch && matchesCategory;
  });

  // ── Render ────────────────────────────────────────────────────

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 1200, mx: "auto" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" mb={2}>
        <Box>
          <Typography variant="h4" fontWeight={700}>
            {t("recipes.title")}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("recipes.subtitle")}
          </Typography>
        </Box>
        {tab === 0 && (
          <Button variant="contained" startIcon={<Add />} onClick={openAddDialog}>
            {t("recipes.add_recipe")}
          </Button>
        )}
      </Stack>

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
        <Tab label={t("recipes.tab_recipes")} />
        <Tab label={t("recipes.tab_meal_plan")} />
        <Tab label={t("recipes.tab_shopping_list")} />
      </Tabs>

      {/* ── Tab 0: Recipes ─────────────────────────────────────── */}
      {tab === 0 && (
        <>
          <Box display="flex" gap={2} mb={3}>
            <TextField
              placeholder={t("recipes.search_placeholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              fullWidth
              size="small"
              InputProps={{ startAdornment: <Search sx={{ mr: 1, color: "action.active" }} /> }}
            />
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>{t("recipes.category")}</InputLabel>
              <Select value={category} label={t("recipes.category")} onChange={(e) => setCategory(e.target.value)}>
                <MenuItem value="all">{t("recipes.all")}</MenuItem>
                {RECIPE_CATEGORIES.map((c) => (
                  <MenuItem key={c} value={c}>{c}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {recipesLoading ? (
            <Box display="flex" justifyContent="center" py={4}>
              <CircularProgress />
            </Box>
          ) : recipesError ? (
            <Alert severity="error">{recipesError}</Alert>
          ) : filteredRecipes.length === 0 ? (
            <Box textAlign="center" py={6}>
              <Typography variant="h6">{t("recipes.no_recipes")}</Typography>
              <Typography color="text.secondary">{t("recipes.no_recipes_hint")}</Typography>
            </Box>
          ) : (
            <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={2}>
              {filteredRecipes.map((recipe) => (
                <Card key={recipe.id} variant="outlined">
                  <CardHeader
                    title={recipe.title}
                    subheader={recipe.metadata.description}
                    action={
                      <IconButton onClick={() => void handleToggleFavorite(recipe)}>
                        {recipe.metadata.isFavorite ? <Favorite color="error" /> : <FavoriteBorder />}
                      </IconButton>
                    }
                  />
                  <CardContent>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap mb={1}>
                      {recipe.metadata.prepTime && (
                        <Chip size="small" icon={<Timer />} label={recipe.metadata.prepTime} />
                      )}
                      {recipe.metadata.servings && (
                        <Chip size="small" icon={<People />} label={`${recipe.metadata.servings} servings`} />
                      )}
                      {recipe.metadata.difficulty && (
                        <Chip size="small" label={recipe.metadata.difficulty} />
                      )}
                      {recipe.metadata.category && (
                        <Chip size="small" variant="outlined" label={recipe.metadata.category} />
                      )}
                    </Stack>
                    {recipe.metadata.ingredients && recipe.metadata.ingredients.length > 0 && (
                      <Typography variant="caption" color="text.secondary">
                        {recipe.metadata.ingredients.slice(0, 4).join(", ")}
                        {recipe.metadata.ingredients.length > 4 &&
                          ` +${recipe.metadata.ingredients.length - 4} more`}
                      </Typography>
                    )}
                  </CardContent>
                  <Divider />
                  <Stack direction="row" justifyContent="flex-end" spacing={0.5} p={1}>
                    {recipe.householdId && (
                      <>
                        <IconButton size="small" onClick={() => openEditDialog(recipe)}>
                          <Edit fontSize="small" />
                        </IconButton>
                        <IconButton size="small" color="error" onClick={() => void handleDeleteRecipe(recipe.id)}>
                          <Delete fontSize="small" />
                        </IconButton>
                      </>
                    )}
                  </Stack>
                </Card>
              ))}
            </Box>
          )}
        </>
      )}

      {/* ── Tab 1: Meal Planner ────────────────────────────────── */}
      {tab === 1 && (
        <>
          <Stack direction="row" justifyContent="center" alignItems="center" spacing={2} mb={3}>
            <Button size="small" onClick={() => setWeekOffset((w) => w - 1)}>
              ← {t("recipes.prev_week")}
            </Button>
            <Typography variant="subtitle1" fontWeight={600}>
              {formatDateShort(dates[0])} — {formatDateShort(dates[6])}
            </Typography>
            <Button size="small" onClick={() => setWeekOffset((w) => w + 1)}>
              {t("recipes.next_week")} →
            </Button>
          </Stack>

          {mealsLoading ? (
            <Box display="flex" justifyContent="center" py={4}>
              <CircularProgress />
            </Box>
          ) : (
            <Box sx={{ overflowX: "auto" }}>
              <Box
                display="grid"
                gridTemplateColumns={`100px repeat(7, 1fr)`}
                gap={1}
                sx={{ minWidth: 800 }}
              >
                {/* Header row */}
                <Box />
                {dates.map((d) => (
                  <Box key={toIsoDate(d)} textAlign="center">
                    <Typography variant="caption" fontWeight={600}>
                      {formatDateShort(d)}
                    </Typography>
                  </Box>
                ))}

                {/* Meal type rows */}
                {MEAL_TYPES.map((meal) => (
                  <>
                    <Box
                      key={`label-${meal}`}
                      display="flex"
                      alignItems="center"
                      sx={{ textTransform: "capitalize" }}
                    >
                      <Typography variant="body2" fontWeight={600}>
                        {meal}
                      </Typography>
                    </Box>
                    {dates.map((d) => {
                      const dateStr = toIsoDate(d);
                      const plan = mealPlans.find(
                        (p) => p.planDate === dateStr && p.mealType === meal,
                      );
                      return (
                        <Card
                          key={`${dateStr}-${meal}`}
                          variant="outlined"
                          sx={{
                            minHeight: 60,
                            cursor: "pointer",
                            "&:hover": { bgcolor: "action.hover" },
                          }}
                          onClick={() => openMealDialog(d, meal)}
                        >
                          <CardContent sx={{ p: 1, "&:last-child": { pb: 1 } }}>
                            {plan ? (
                              <Stack spacing={0.5}>
                                <Typography variant="caption" fontWeight={600} noWrap>
                                  {plan.recipe?.title ?? plan.customMeal ?? "—"}
                                </Typography>
                                {plan.notes && (
                                  <Typography variant="caption" color="text.secondary" noWrap>
                                    {plan.notes}
                                  </Typography>
                                )}
                                <Box textAlign="right">
                                  <IconButton
                                    size="small"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleDeleteMealPlan(plan.id);
                                    }}
                                  >
                                    <Delete sx={{ fontSize: 14 }} />
                                  </IconButton>
                                </Box>
                              </Stack>
                            ) : (
                              <Typography variant="caption" color="text.disabled">
                                +
                              </Typography>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </>
                ))}
              </Box>
            </Box>
          )}
        </>
      )}

      {/* ── Tab 2: Shopping List ───────────────────────────────── */}
      {tab === 2 && (
        <>
          <Typography variant="body2" color="text.secondary" mb={2}>
            {t("recipes.shopping_list_hint")}
          </Typography>

          {pantryLoading || mealsLoading ? (
            <Box display="flex" justifyContent="center" py={4}>
              <CircularProgress />
            </Box>
          ) : shoppingList.length === 0 ? (
            <Box textAlign="center" py={6}>
              <ShoppingCart sx={{ fontSize: 64, color: "text.disabled", mb: 1 }} />
              <Typography color="text.secondary">{t("recipes.shopping_list_empty")}</Typography>
            </Box>
          ) : (
            <Stack spacing={1}>
              {shoppingList.map((item) => (
                <Card key={item.ingredient} variant="outlined">
                  <CardContent sx={{ py: 1, "&:last-child": { pb: 1 } }}>
                    <Stack direction="row" alignItems="center" spacing={2}>
                      {item.inPantry ? (
                        <CheckCircle color="success" fontSize="small" />
                      ) : (
                        <ShoppingCart color="warning" fontSize="small" />
                      )}
                      <Box flex={1}>
                        <Typography
                          variant="body2"
                          fontWeight={item.inPantry ? 400 : 600}
                          sx={item.inPantry ? { textDecoration: "line-through", color: "text.secondary" } : {}}
                        >
                          {item.ingredient}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          For: {item.neededForRecipes.join(", ")}
                        </Typography>
                      </Box>
                      {item.inPantry && (
                        <Chip size="small" label={`${item.pantryQuantity} in stock`} color="success" variant="outlined" />
                      )}
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}

      {/* ── Add/Edit Recipe Dialog ─────────────────────────────── */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {editingRecipe ? t("recipes.edit_recipe") : t("recipes.add_new_recipe")}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label={t("recipes.recipe_title")}
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              fullWidth
              size="small"
              required
            />
            <TextField
              label={t("recipes.description")}
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={2}
            />
            <Stack direction="row" spacing={2}>
              <FormControl size="small" fullWidth>
                <InputLabel>{t("recipes.category")}</InputLabel>
                <Select value={formCategory} label={t("recipes.category")} onChange={(e) => setFormCategory(e.target.value)}>
                  {RECIPE_CATEGORIES.map((c) => (
                    <MenuItem key={c} value={c}>{c}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <TextField
                label={t("recipes.cuisine")}
                value={formCuisine}
                onChange={(e) => setFormCuisine(e.target.value)}
                fullWidth
                size="small"
              />
            </Stack>
            <Stack direction="row" spacing={2}>
              <TextField label={t("recipes.prep_time")} value={formPrepTime} onChange={(e) => setFormPrepTime(e.target.value)} fullWidth size="small" />
              <TextField label={t("recipes.cook_time")} value={formCookTime} onChange={(e) => setFormCookTime(e.target.value)} fullWidth size="small" />
              <TextField label={t("recipes.servings")} value={formServings} onChange={(e) => setFormServings(e.target.value)} fullWidth size="small" type="number" />
            </Stack>
            <TextField
              label={t("recipes.ingredients")}
              value={formIngredients}
              onChange={(e) => setFormIngredients(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={3}
              helperText={t("recipes.ingredients_hint")}
            />
            <TextField
              label={t("recipes.instructions")}
              value={formInstructions}
              onChange={(e) => setFormInstructions(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={4}
            />
            <TextField
              label={t("recipes.source_url")}
              value={formSourceUrl}
              onChange={(e) => setFormSourceUrl(e.target.value)}
              fullWidth
              size="small"
              placeholder="https://..."
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={saveBusy}>
            {t("common.cancel")}
          </Button>
          <Button variant="contained" onClick={handleSaveRecipe} disabled={saveBusy || !formTitle.trim()}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Assign Meal Dialog ─────────────────────────────────── */}
      <Dialog open={mealDialogOpen} onClose={() => setMealDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("recipes.assign_meal")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField label={t("recipes.date")} value={mealDate} size="small" fullWidth InputProps={{ readOnly: true }} />
            <TextField label={t("recipes.meal_type")} value={mealType} size="small" fullWidth InputProps={{ readOnly: true }} />
            <Autocomplete
              options={recipes}
              getOptionLabel={(r) => r.title}
              value={recipes.find((r) => r.id === mealRecipeId) ?? null}
              onChange={(_, v) => {
                setMealRecipeId(v?.id ?? null);
                if (v) setMealCustom("");
              }}
              renderInput={(params) => (
                <TextField {...params} label={t("recipes.pick_recipe")} size="small" />
              )}
              size="small"
            />
            <Typography variant="caption" color="text.secondary" textAlign="center">
              — {t("recipes.or")} —
            </Typography>
            <TextField
              label={t("recipes.custom_meal")}
              value={mealCustom}
              onChange={(e) => {
                setMealCustom(e.target.value);
                if (e.target.value) setMealRecipeId(null);
              }}
              fullWidth
              size="small"
              placeholder="e.g. Order pizza"
            />
            <TextField
              label={t("recipes.notes")}
              value={mealNotes}
              onChange={(e) => setMealNotes(e.target.value)}
              fullWidth
              size="small"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMealDialogOpen(false)} disabled={mealBusy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="contained"
            onClick={handleSaveMealPlan}
            disabled={mealBusy || (!mealRecipeId && !mealCustom.trim())}
          >
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Snackbar ───────────────────────────────────────────── */}
      <Snackbar
        open={!!snack}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        message={snack?.msg}
      />
    </Box>
  );
}
