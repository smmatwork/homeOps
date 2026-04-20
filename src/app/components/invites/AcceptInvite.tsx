import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router";
import { Alert, Box, Button, Card, CardContent, CardHeader, CircularProgress, Typography } from "@mui/material";
import { useI18n } from "../../i18n";
import { useAuth } from "../../auth/AuthProvider";
import { acceptHouseholdInvite } from "../../services/agentApi";

export function AcceptInvite() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { accessToken, refreshHouseholdId } = useAuth();

  const token = useMemo(() => (search.get("token") ?? "").trim(), [search]);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (!accessToken.trim()) return;

    let cancelled = false;
    (async () => {
      setBusy(true);
      setError(null);
      setDone(false);

      const res = await acceptHouseholdInvite({ accessToken: accessToken.trim(), token });
      if (cancelled) return;
      setBusy(false);

      if (!res.ok) {
        setError((res as { ok: false; error: string }).error);
        return;
      }

      try {
        localStorage.setItem("homeops.agent.household_id", res.householdId);
      } catch {
        // ignore
      }
      try {
        await refreshHouseholdId();
      } catch {
        // ignore
      }
      setDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [token, accessToken, refreshHouseholdId]);

  return (
    <Box
      display="flex"
      justifyContent="center"
      alignItems="center"
      minHeight="100vh"
      sx={{
        background: "linear-gradient(to bottom right, #e3f2fd, #c5cae9)",
        padding: 2,
      }}
    >
      <Card sx={{ width: "100%", maxWidth: 520 }}>
        <CardHeader
          title={
            <Typography variant="h5" fontWeight="bold" align="center">
              {t("invite.accept.title")}
            </Typography>
          }
          subheader={
            <Typography variant="body2" color="textSecondary" align="center">
              {t("invite.accept.subtitle")}
            </Typography>
          }
        />
        <CardContent>
          {!token ? (
            <Alert severity="error">{t("invite.accept.missing_token")}</Alert>
          ) : null}

          {error ? <Alert severity="error">{error}</Alert> : null}

          {busy ? (
            <Box display="flex" justifyContent="center" alignItems="center" gap={2}>
              <CircularProgress size={22} />
              <Typography>{t("invite.accept.working")}</Typography>
            </Box>
          ) : null}

          {done ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              {t("invite.accept.success")}
            </Alert>
          ) : null}

          <Box display="flex" justifyContent="center" gap={2} sx={{ mt: 2 }}>
            <Button variant="contained" onClick={() => navigate("/", { replace: true })}>
              {t("invite.accept.go_home")}
            </Button>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
