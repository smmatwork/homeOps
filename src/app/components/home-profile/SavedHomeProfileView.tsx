import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Stack,
  Typography,
} from "@mui/material";
import { Edit, Refresh } from "@mui/icons-material";
import { useI18n } from "../../i18n";
import { groupRoomsByFloor, normalizeSpacesToRooms, floorLabel } from "../../config/homeProfileTemplates";
import { asNumberOrNull, type HomeProfileDraft } from "./useHomeProfileWizard";

interface SavedHomeProfileViewProps {
  draft: HomeProfileDraft;
  onEdit: () => void;
  onRefresh: () => void;
  busy?: boolean;
}

/**
 * Inline (non-modal) view of the saved home profile.
 * Renders the same data the wizard's view mode shows, but flat on the page
 * with prominent Edit and Refresh actions in the header.
 */
export function SavedHomeProfileView({ draft, onEdit, onRefresh, busy }: SavedHomeProfileViewProps) {
  const { t, lang: uiLang } = useI18n();

  const rec = draft.action.record as Record<string, unknown>;
  const rooms = normalizeSpacesToRooms(rec.spaces);
  const grouped = groupRoomsByFloor(rooms);
  const homeType = typeof rec.home_type === "string" ? rec.home_type : "apartment";
  const bhk = asNumberOrNull(rec.bhk);
  const squareFeet = asNumberOrNull(rec.square_feet);
  const floors = asNumberOrNull(rec.floors);
  const hasPets = rec.has_pets === true;
  const hasKids = rec.has_kids === true;
  const numBathrooms = asNumberOrNull(rec.num_bathrooms);
  const flooringType = typeof rec.flooring_type === "string" ? rec.flooring_type.trim() : "";

  return (
    <Card variant="outlined">
      <CardHeader
        title={t("home_profile.dialog_title")}
        subheader={t("home_profile.view_saved")}
        action={
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<Refresh />}
              onClick={onRefresh}
              disabled={busy}
            >
              {t("common.refresh")}
            </Button>
            <Button
              variant="contained"
              size="small"
              startIcon={<Edit />}
              onClick={onEdit}
              disabled={busy}
            >
              {t("home_profile.edit")}
            </Button>
          </Stack>
        }
      />
      <CardContent>
        <Stack spacing={2}>
          {/* Summary block */}
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, 1fr)" },
              gap: 1.5,
              p: 2,
              bgcolor: "action.hover",
              borderRadius: 1,
            }}
          >
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">{t("home_profile.label_type")}</Typography>
              <Typography variant="body2" fontWeight={600}>
                {homeType}{bhk ? ` · ${bhk} ${t("home_profile.label_bhk")}` : ""}
              </Typography>
            </Stack>
            {squareFeet !== null && (
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">{t("home_profile.label_area")}</Typography>
                <Typography variant="body2" fontWeight={600}>
                  {squareFeet.toLocaleString()} {t("home_profile.label_sq_ft")}
                </Typography>
              </Stack>
            )}
            {floors !== null && (
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">{t("home_profile.label_floors")}</Typography>
                <Typography variant="body2" fontWeight={600}>{floors}</Typography>
              </Stack>
            )}
            {numBathrooms !== null && (
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">{t("home_profile.label_bathrooms")}</Typography>
                <Typography variant="body2" fontWeight={600}>{numBathrooms}</Typography>
              </Stack>
            )}
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">{t("home_profile.label_pets")}</Typography>
              <Typography variant="body2" fontWeight={600}>
                {hasPets ? t("home_profile.label_yes") : t("home_profile.label_no")}
              </Typography>
            </Stack>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2" color="text.secondary">{t("home_profile.label_kids")}</Typography>
              <Typography variant="body2" fontWeight={600}>
                {hasKids ? t("home_profile.label_yes") : t("home_profile.label_no")}
              </Typography>
            </Stack>
            {flooringType && (
              <Stack direction="row" justifyContent="space-between" sx={{ gridColumn: "1 / -1" }}>
                <Typography variant="body2" color="text.secondary">{t("home_profile.label_flooring")}</Typography>
                <Typography variant="body2" fontWeight={600}>{flooringType}</Typography>
              </Stack>
            )}
          </Box>

          {/* Rooms grouped by floor */}
          {grouped.length > 0 ? (
            <Stack spacing={1.5}>
              {grouped.map(({ floor, rooms: fRooms }) => (
                <Box key={String(floor)}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    display="block"
                    mb={0.75}
                    sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}
                  >
                    {floorLabel(floor, uiLang as any)}
                  </Typography>
                  <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                    {fRooms.map((rm) => (
                      <Chip
                        key={rm.id}
                        size="small"
                        label={
                          rm.display_name !== rm.template_name
                            ? `${rm.display_name} (${rm.template_name})`
                            : rm.display_name
                        }
                        variant="outlined"
                      />
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              No rooms saved yet. Click Edit to add some.
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
