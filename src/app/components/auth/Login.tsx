import { useState } from "react";
import { Box, Button, Card, CardContent, CardHeader, Divider, TextField, Typography, Checkbox, FormControlLabel, Alert } from "@mui/material";
import { Link, useLocation, useNavigate } from "react-router";
import { supabase } from "../../services/supabaseClient";
import { useI18n } from "../../i18n";
import { LanguageSwitcher } from "../LanguageSwitcher";

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const { t } = useI18n();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    setError(null);
    setBusy(true);
    const { error: authErr } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (authErr) {
      setError(authErr.message);
      return;
    }
    navigate(from, { replace: true });
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
              {t("auth.login.welcome_back")}
            </Typography>
          }
          subheader={
            <Typography variant="body2" color="textSecondary" align="center">
              {t("auth.login.subtitle")}
            </Typography>
          }
        />
        <CardContent>
          <Box display="flex" flexDirection="column" gap={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField label={t("auth.login.email")} type="email" placeholder="you@example.com" fullWidth value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField label={t("auth.login.password")} type="password" placeholder="••••••••" fullWidth value={password} onChange={(e) => setPassword(e.target.value)} />
            <Box display="flex" justifyContent="space-between" alignItems="center">
              <FormControlLabel control={<Checkbox />} label={t("auth.login.remember_me")} />
              <Link to="#">
                <Typography variant="body2" color="primary" sx={{ cursor: "pointer" }}>
                  {t("auth.login.forgot_password")}
                </Typography>
              </Link>
            </Box>
            <Button variant="contained" size="large" fullWidth disabled={busy} onClick={onSubmit}>
              {t("auth.login.sign_in")}
            </Button>
            <Divider>
              <Typography variant="caption" color="textSecondary">
                {t("common.or")}
              </Typography>
            </Divider>
            <Box display="flex" gap={2}>
              <Button variant="outlined" fullWidth>
                {t("auth.login.google")}
              </Button>
              <Button variant="outlined" fullWidth>
                {t("auth.login.microsoft")}
              </Button>
            </Box>
            <Typography variant="body2" color="textSecondary" align="center">
              {t("auth.login.no_account")}{" "}
              <Link to="/signup">
                <Typography component="span" color="primary" fontWeight="medium" sx={{ cursor: "pointer" }}>
                  {t("auth.login.sign_up")}
                </Typography>
              </Link>
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
