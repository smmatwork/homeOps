import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Alert,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
  IconButton,
  Chip,
  Stack,
} from "@mui/material";
import {
  Add,
  Search,
  Timer,
  People,
  Favorite,
  FavoriteBorder,
  Edit,
  Delete,
} from "@mui/icons-material";
import { executeToolCall, getYoutubeSettings, setYoutubeSettings } from "../../services/agentApi";
import { useI18n } from "../../i18n";
import { useAuth } from "../../auth/AuthProvider";

type YoutubeSettings = {
  queryTemplate: string;
  preferredChannels: string;
  includeShorts: boolean;
};

const DEFAULT_YT_SETTINGS: YoutubeSettings = {
  queryTemplate: "{recipe} recipe",
  preferredChannels: "",
  includeShorts: false,
};

function buildYoutubeQuery(params: {
  recipe: string;
  settings: YoutubeSettings;
}): string {
  const { recipe, settings } = params;
  const base = (settings.queryTemplate || "{recipe} recipe").split("{recipe}").join(recipe.trim());
  const parts = [base.trim()];
  if (settings.preferredChannels.trim()) parts.push(settings.preferredChannels.trim());
  if (settings.includeShorts) parts.push("shorts");
  return parts.filter(Boolean).join(" ");
}

export function Recipes() {
  const { householdId, accessToken } = useAuth();
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);

  const [agentAccessToken, setAgentAccessToken] = useState("");
  const [agentHouseholdId, setAgentHouseholdId] = useState("");

  const [ytSearchText, setYtSearchText] = useState("");
  const [ytSettings, setYtSettings] = useState<YoutubeSettings>(DEFAULT_YT_SETTINGS);
  const [ytSettingsOpen, setYtSettingsOpen] = useState(false);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytError, setYtError] = useState<string | null>(null);
  const [ytSuccess, setYtSuccess] = useState<string | null>(null);

  // Load saved agent setup (shared with chat)
  useEffect(() => {
    try {
      const savedToken = localStorage.getItem("homeops.agent.access_token") ?? "";
      const savedHousehold = localStorage.getItem("homeops.agent.household_id") ?? "";
      if (savedToken) setAgentAccessToken(savedToken);
      if (savedHousehold) setAgentHouseholdId(savedHousehold);
    } catch {
      // ignore
    }
  }, []);

  // Load per-household YouTube settings
  useEffect(() => {
    const token = agentAccessToken.trim();
    const householdId = agentHouseholdId.trim();
    if (!token || !householdId) return;

    let cancelled = false;
    (async () => {
      setYtError(null);
      setYtBusy(true);
      const res = await getYoutubeSettings({ accessToken: token, householdId });
      setYtBusy(false);
      if (cancelled) return;
      if (!res.ok) {
        setYtError("error" in res ? res.error : "Failed to load YouTube settings");
        return;
      }
      const raw = res.settings;
      if (raw && typeof raw === "object") {
        const obj = raw as Partial<YoutubeSettings>;
        setYtSettings({
          queryTemplate: typeof obj.queryTemplate === "string" ? obj.queryTemplate : DEFAULT_YT_SETTINGS.queryTemplate,
          preferredChannels: typeof obj.preferredChannels === "string" ? obj.preferredChannels : DEFAULT_YT_SETTINGS.preferredChannels,
          includeShorts: typeof obj.includeShorts === "boolean" ? obj.includeShorts : DEFAULT_YT_SETTINGS.includeShorts,
        });
      } else {
        setYtSettings(DEFAULT_YT_SETTINGS);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentAccessToken, agentHouseholdId]);

  const ytEffectiveQuery = useMemo(() => {
    const recipe = ytSearchText.trim();
    if (!recipe) return "";
    return buildYoutubeQuery({ recipe, settings: ytSettings });
  }, [ytSearchText, ytSettings]);

  const openYoutubeSearch = () => {
    if (!ytEffectiveQuery) return;
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(ytEffectiveQuery)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const saveYoutubeSettings = async () => {
    setYtError(null);
    setYtSuccess(null);
    const token = agentAccessToken.trim();
    const householdId = agentHouseholdId.trim();
    if (!token) {
      setYtError("Missing access token. Set it in Chat → Agent Setup first.");
      return;
    }
    if (!householdId) {
      setYtError("Missing household_id. Set it in Chat → Agent Setup first.");
      return;
    }

    setYtBusy(true);
    const res = await setYoutubeSettings({ accessToken: token, householdId, settings: ytSettings });
    setYtBusy(false);
    if (!res.ok) {
      setYtError("error" in res ? res.error : "Failed to save YouTube settings");
      return;
    }
    setYtSuccess("Saved YouTube search settings.");
    setYtSettingsOpen(false);
  };

  const recipes = [
    {
      id: 1,
      title: "Spaghetti Carbonara",
      category: "Dinner",
      cuisine: "Italian",
      prepTime: "15 min",
      cookTime: "20 min",
      servings: 4,
      difficulty: "Medium",
      description: "Classic Italian pasta dish with eggs, cheese, and pancetta",
      ingredients: ["400g spaghetti", "200g pancetta", "4 eggs", "100g parmesan", "Black pepper"],
      isFavorite: true,
    },
    {
      id: 2,
      title: "Avocado Toast",
      category: "Breakfast",
      cuisine: "Modern",
      prepTime: "5 min",
      cookTime: "5 min",
      servings: 2,
      difficulty: "Easy",
      description: "Simple and healthy breakfast option",
      ingredients: ["2 slices bread", "1 avocado", "Salt", "Pepper", "Lemon juice"],
      isFavorite: false,
    },
  ];

  const filteredRecipes = recipes.filter((recipe) => {
    const matchesSearch =
      recipe.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      recipe.cuisine.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = category === "all" || recipe.category === category;
    return matchesSearch && matchesCategory;
  });

  return (
    <Box p={4}>
      {/* Header */}
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={4}>
        <Box>
          <Typography variant="h4" fontWeight="bold">
            {t("recipes.title")}
          </Typography>
          <Typography color="textSecondary">
            {t("recipes.subtitle")}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<Add />}
          onClick={() => setDialogOpen(true)}
        >
          {t("recipes.add_recipe")}
        </Button>
      </Box>

      {/* YouTube Recipe Search */}
      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardHeader
          title={t("recipes.youtube_search")}
          subheader={t("recipes.youtube_search_subtitle")}
          action={
            <Button variant="outlined" size="small" onClick={() => setYtSettingsOpen(true)}>
              {t("recipes.search_options")}
            </Button>
          }
        />
        <Divider />
        <CardContent>
          <Stack spacing={1.5}>
            {ytError && <Alert severity="error">{ytError}</Alert>}
            {ytSuccess && <Alert severity="success">{ytSuccess}</Alert>}
            {(!agentAccessToken.trim() || !agentHouseholdId.trim()) && (
              <Alert severity="warning">
                To save search options per household, set your <strong>access_token</strong> and <strong>household_id</strong> in Chat → Agent Setup.
              </Alert>
            )}

            <TextField
              label={t("recipes.recipe")}
              value={ytSearchText}
              onChange={(e) => setYtSearchText(e.target.value)}
              placeholder="e.g. paneer butter masala"
              fullWidth
              size="small"
            />

            <TextField
              label={t("recipes.generated_query")}
              value={ytEffectiveQuery}
              fullWidth
              size="small"
              InputProps={{ readOnly: true }}
            />

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
              <Button variant="contained" onClick={openYoutubeSearch} disabled={!ytEffectiveQuery}>
                {t("recipes.search_youtube")}
              </Button>
              <Button variant="text" onClick={() => setYtSearchText(searchQuery)} disabled={!searchQuery.trim()}>
                {t("recipes.use_current_search")}
              </Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {/* Search and Filter */}
      <Box display="flex" gap={2} mb={4}>
        <TextField
          placeholder={t("recipes.search_placeholder")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          fullWidth
          InputProps={{
            startAdornment: <Search sx={{ mr: 1, color: "action.active" }} />,
          }}
        />
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>{t("recipes.category")}</InputLabel>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            <MenuItem value="all">{t("recipes.all")}</MenuItem>
            <MenuItem value="Breakfast">{t("recipes.breakfast")}</MenuItem>
            <MenuItem value="Lunch">{t("recipes.lunch")}</MenuItem>
            <MenuItem value="Dinner">{t("recipes.dinner")}</MenuItem>
            <MenuItem value="Dessert">{t("recipes.dessert")}</MenuItem>
          </Select>
        </FormControl>
      </Box>

      {/* Recipes Grid */}
      <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={2}>
        {filteredRecipes.map((recipe) => (
          <Card key={recipe.id}>
            <CardHeader
              title={recipe.title}
              subheader={recipe.description}
              action={
                <IconButton>
                  {recipe.isFavorite ? <Favorite color="error" /> : <FavoriteBorder />}
                </IconButton>
              }
            />
            <CardContent>
              <Box display="flex" gap={1} mb={2}>
                <Chip label={`${recipe.prepTime} + ${recipe.cookTime}`} icon={<Timer />} />
                <Chip label={`${recipe.servings} servings`} icon={<People />} />
                <Chip label={recipe.difficulty} />
              </Box>
              <Typography variant="body2" color="textSecondary">
                {t("recipes.ingredients")}
              </Typography>
              <ul>
                {recipe.ingredients.slice(0, 3).map((ingredient, idx) => (
                  <li key={idx}>
                    <Typography variant="body2">{ingredient}</Typography>
                  </li>
                ))}
                {recipe.ingredients.length > 3 && (
                  <Typography variant="caption" color="textSecondary">
                    + {recipe.ingredients.length - 3} {t("recipes.more")}
                  </Typography>
                )}
              </ul>
            </CardContent>
            <Divider />
            <Box display="flex" justifyContent="space-between" p={2}>
              <Button variant="outlined" size="small">
                {t("recipes.view_full")}
              </Button>
              <Box>
                <IconButton>
                  <Edit />
                </IconButton>
                <IconButton color="error">
                  <Delete />
                </IconButton>
              </Box>
            </Box>
          </Card>
        ))}
      </Box>

      {filteredRecipes.length === 0 && (
        <Box textAlign="center" py={4}>
          <Typography variant="h6">{t("recipes.no_recipes")}</Typography>
          <Typography color="textSecondary">
            {t("recipes.no_recipes_hint")}
          </Typography>
        </Box>
      )}

      {/* Add Recipe Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogTitle>{t("recipes.add_new_recipe")}</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2}>
            <TextField label={t("recipes.recipe_title")} fullWidth />
            <TextField label={t("recipes.description")} fullWidth multiline rows={2} />
            <Box display="flex" gap={2}>
              <TextField label={t("recipes.category")} fullWidth />
              <TextField label={t("recipes.cuisine")} fullWidth />
            </Box>
            <Box display="flex" gap={2}>
              <TextField label={t("recipes.prep_time")} fullWidth />
              <TextField label={t("recipes.cook_time")} fullWidth />
              <TextField label={t("recipes.servings")} fullWidth type="number" />
            </Box>
            <TextField label={t("recipes.ingredients")} fullWidth multiline rows={4} />
            <TextField label={t("recipes.instructions")} fullWidth multiline rows={6} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="contained">{t("recipes.save_recipe")}</Button>
        </DialogActions>
      </Dialog>

      {/* YouTube Settings Dialog */}
      <Dialog open={ytSettingsOpen} onClose={() => setYtSettingsOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t("recipes.youtube_options")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <TextField
              label={t("recipes.query_template")}
              value={ytSettings.queryTemplate}
              onChange={(e) => setYtSettings((prev) => ({ ...prev, queryTemplate: e.target.value }))}
              helperText='Use "{recipe}" placeholder. Example: "{recipe} hebbars kitchen"'
              fullWidth
              size="small"
            />
            <TextField
              label={t("recipes.preferred_channels")}
              value={ytSettings.preferredChannels}
              onChange={(e) => setYtSettings((prev) => ({ ...prev, preferredChannels: e.target.value }))}
              helperText='Example: "Hebbars Kitchen" or "Ranveer Brar"'
              fullWidth
              size="small"
            />
            <FormControl fullWidth size="small">
              <InputLabel>{t("recipes.include_shorts")}</InputLabel>
              <Select
                value={ytSettings.includeShorts ? "yes" : "no"}
                label={t("recipes.include_shorts")}
                onChange={(e) => setYtSettings((prev) => ({ ...prev, includeShorts: e.target.value === "yes" }))}
              >
                <MenuItem value="no">{t("recipes.no")}</MenuItem>
                <MenuItem value="yes">{t("recipes.yes")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setYtSettingsOpen(false)}>{t("common.cancel")}</Button>
          <Button variant="contained" onClick={saveYoutubeSettings} disabled={ytBusy}>
            {t("common.save")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
