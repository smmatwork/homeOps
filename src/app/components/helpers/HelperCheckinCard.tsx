/**
 * Helper check-in card — allows the owner to log a helper's daily check-in
 * with photo, thumbs-up, or voice note. Displays recent check-ins.
 *
 * Per the manifest: "The helper marks tasks done with a photo (proof of
 * completion), a thumbs-up, or a voice note. No multi-step forms."
 */

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  CameraAlt,
  ThumbUp,
  Mic,
  CheckCircle,
  Schedule,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { supabase } from "../../services/supabaseClient";

interface HelperCheckinCardProps {
  helperId: string;
  helperName: string;
}

interface CheckinRow {
  id: string;
  checkin_date: string;
  checkin_type: string;
  photo_url: string | null;
  voice_url: string | null;
  note: string | null;
  status: string;
  created_at: string;
}

export function HelperCheckinCard({ helperId, helperName }: HelperCheckinCardProps) {
  const { householdId } = useAuth();
  const [checkins, setCheckins] = useState<CheckinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [checkinType, setCheckinType] = useState<"photo" | "thumbs_up" | "voice_note" | "text">("thumbs_up");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadCheckins = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    const { data } = await supabase
      .from("helper_checkins")
      .select("id,checkin_date,checkin_type,photo_url,voice_url,note,status,created_at")
      .eq("household_id", householdId)
      .eq("helper_id", helperId)
      .order("checkin_date", { ascending: false })
      .limit(7);
    setCheckins((data ?? []) as CheckinRow[]);
    setLoading(false);
  }, [householdId, helperId]);

  useEffect(() => { void loadCheckins(); }, [loadCheckins]);

  const submitCheckin = async () => {
    if (!householdId) return;
    setSubmitting(true);
    const { error } = await supabase.from("helper_checkins").insert({
      household_id: householdId,
      helper_id: helperId,
      checkin_date: new Date().toISOString().split("T")[0],
      checkin_type: checkinType,
      note: note.trim() || null,
      status: "submitted",
    });
    setSubmitting(false);
    if (!error) {
      setDialogOpen(false);
      setNote("");
      void loadCheckins();
    }
  };

  const todayStr = new Date().toISOString().split("T")[0];
  const todayCheckin = checkins.find((c) => c.checkin_date === todayStr);

  const typeIcon = (type: string) => {
    switch (type) {
      case "photo": return <CameraAlt fontSize="small" color="primary" />;
      case "thumbs_up": return <ThumbUp fontSize="small" color="success" />;
      case "voice_note": return <Mic fontSize="small" color="secondary" />;
      default: return <CheckCircle fontSize="small" />;
    }
  };

  const typeLabel = (type: string) => {
    switch (type) {
      case "photo": return "Photo";
      case "thumbs_up": return "Thumbs up";
      case "voice_note": return "Voice note";
      case "text": return "Note";
      default: return type;
    }
  };

  if (loading) {
    return <CircularProgress size={16} />;
  }

  return (
    <>
      <Card variant="outlined" sx={{ mt: 1 }}>
        <CardContent sx={{ py: 1.5, "&:last-child": { pb: 1.5 } }}>
          <Stack spacing={1}>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="subtitle2" fontWeight={600}>
                Check-ins
              </Typography>
              {todayCheckin ? (
                <Chip
                  size="small"
                  icon={<CheckCircle />}
                  label="Checked in today"
                  color="success"
                  variant="outlined"
                  sx={{ fontSize: 11 }}
                />
              ) : (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<ThumbUp />}
                  onClick={() => setDialogOpen(true)}
                  sx={{ fontSize: 11 }}
                >
                  Log check-in
                </Button>
              )}
            </Stack>

            {checkins.length > 0 ? (
              <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                {checkins.slice(0, 7).map((c) => (
                  <Chip
                    key={c.id}
                    size="small"
                    icon={typeIcon(c.checkin_type)}
                    label={new Date(c.checkin_date).toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
                    variant={c.checkin_date === todayStr ? "filled" : "outlined"}
                    sx={{ fontSize: 10 }}
                  />
                ))}
              </Stack>
            ) : (
              <Typography variant="caption" color="text.secondary">
                No check-ins yet this week
              </Typography>
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* Check-in dialog */}
      <Dialog open={dialogOpen} onClose={() => !submitting && setDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Log check-in for {helperName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} mt={1}>
            <Typography variant="body2" color="text.secondary">
              How is {helperName} checking in today?
            </Typography>

            <Stack direction="row" spacing={1}>
              {(["thumbs_up", "photo", "voice_note", "text"] as const).map((type) => (
                <IconButton
                  key={type}
                  color={checkinType === type ? "primary" : "default"}
                  onClick={() => setCheckinType(type)}
                  sx={{
                    border: checkinType === type ? 2 : 1,
                    borderColor: checkinType === type ? "primary.main" : "divider",
                    borderRadius: 2,
                    p: 1.5,
                  }}
                >
                  {typeIcon(type)}
                </IconButton>
              ))}
            </Stack>

            <Typography variant="caption" color="text.secondary">
              {typeLabel(checkinType)}
            </Typography>

            <TextField
              label="Note (optional)"
              multiline
              rows={2}
              size="small"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., Cleaned kitchen and bathrooms"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={submitting}>Cancel</Button>
          <Button variant="contained" onClick={() => void submitCheckin()} disabled={submitting}>
            {submitting ? <CircularProgress size={16} /> : "Submit"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
