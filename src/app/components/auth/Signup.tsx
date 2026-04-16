import { useState } from "react";
import { Box, Button, Card, CardContent, CardHeader, Divider, TextField, Typography, Checkbox, FormControlLabel, Alert } from "@mui/material";
import { Link, useNavigate } from "react-router";
import { supabase } from "../../services/supabaseClient";
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";

export function Signup() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "http://127.0.0.1:54321";

  const onSubmit = async () => {
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    const { data: signUpData, error: authErr } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: {
          full_name: fullName.trim(),
        },
      },
    });
    if (authErr) {
      setBusy(false);
      setError(authErr.message);
      return;
    }

    let token = signUpData.session?.access_token ?? "";
    if (!token) {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) {
        setBusy(false);
        setError(signInErr.message);
        return;
      }
      const { data: sessionData } = await supabase.auth.getSession();
      token = sessionData.session?.access_token ?? "";
    }
    if (!token) {
      setBusy(false);
      setError("Missing access token after signup. Try logging in.");
      navigate("/login", { replace: true });
      return;
    }

    try {
      const res = await fetch(`${baseUrl}/functions/v1/server/auth/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          full_name: fullName.trim(),
          household_name: fullName.trim() ? `${fullName.trim()}'s Home` : "My Home",
        }),
      });

      const text = await res.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (!res.ok) {
        const msg =
          json && typeof json === "object" && (json as { error?: unknown }).error
            ? String((json as { error?: unknown }).error)
            : text || res.statusText;
        setBusy(false);
        setError(msg);
        return;
      }

      const householdId =
        json && typeof json === "object" && typeof (json as { household_id?: unknown }).household_id === "string"
          ? String((json as { household_id?: unknown }).household_id)
          : "";
      if (householdId) {
        try {
          localStorage.setItem("homeops.agent.household_id", householdId);
        } catch {
          // ignore
        }
      }
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Bootstrap failed");
      return;
    }

    setBusy(false);
    navigate("/onboarding", { replace: true });
  };

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
      <Box sx={{ position: "fixed", top: 12, right: 12, zIndex: 10 }}>
        <LanguageSwitcher />
      </Box>
      <Card sx={{ width: "100%", maxWidth: 400 }}>
        <CardHeader
          title={
            <Typography variant="h5" fontWeight="bold" align="center">
              {t("auth.signup.create_account")}
            </Typography>
          }
          subheader={
            <Typography variant="body2" color="textSecondary" align="center">
              {t("auth.signup.subtitle")}
            </Typography>
          }
        />
        <CardContent>
          <Box display="flex" flexDirection="column" gap={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField label={t("auth.signup.full_name")} type="text" placeholder="John Doe" fullWidth value={fullName} onChange={(e) => setFullName(e.target.value)} />
            <TextField label={t("auth.login.email")} type="email" placeholder="you@example.com" fullWidth value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField
              label={t("auth.signup.household_code")}
              type="text"
              placeholder={t("auth.signup.household_code_placeholder")}
              fullWidth
              helperText={t("auth.signup.household_code_help")}
            />
            <TextField label={t("auth.login.password")} type="password" placeholder="••••••••" fullWidth value={password} onChange={(e) => setPassword(e.target.value)} />
            <TextField label={t("auth.signup.confirm_password")} type="password" placeholder="••••••••" fullWidth value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <FormControlLabel
              control={<Checkbox />}
              label={
                <Typography variant="body2" color="textSecondary">
                  {t("auth.signup.terms")}
                </Typography>
              }
            />
            <Button variant="contained" size="large" fullWidth disabled={busy} onClick={onSubmit}>
              {t("auth.signup.create")}
            </Button>
            <Typography variant="body2" color="textSecondary" align="center">
              {t("auth.signup.have_account")}{" "}
              <Link to="/login">
                <Typography component="span" color="primary" fontWeight="medium" sx={{ cursor: "pointer" }}>
                  {t("auth.signup.sign_in")}
                </Typography>
              </Link>
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
