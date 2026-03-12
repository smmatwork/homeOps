import { useState } from "react";
import { Box, Button, Card, CardContent, CardHeader, TextField, Typography, Checkbox, FormControlLabel, Alert } from "@mui/material";
import { Link, useNavigate } from "react-router";
import { supabase } from "../../services/supabaseClient";

export function Signup() {
  const navigate = useNavigate();
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
    navigate("/", { replace: true });
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
      <Card sx={{ width: "100%", maxWidth: 400 }}>
        <CardHeader
          title={
            <Typography variant="h5" fontWeight="bold" align="center">
              Create Account
            </Typography>
          }
          subheader={
            <Typography variant="body2" color="textSecondary" align="center">
              Join your household or start managing your home
            </Typography>
          }
        />
        <CardContent>
          <Box display="flex" flexDirection="column" gap={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField label="Full Name" type="text" placeholder="John Doe" fullWidth value={fullName} onChange={(e) => setFullName(e.target.value)} />
            <TextField label="Email" type="email" placeholder="you@example.com" fullWidth value={email} onChange={(e) => setEmail(e.target.value)} />
            <TextField
              label="Household Code (Optional)"
              type="text"
              placeholder="Enter existing household code"
              fullWidth
              helperText="Leave empty to create a new household"
            />
            <TextField label="Password" type="password" placeholder="••••••••" fullWidth value={password} onChange={(e) => setPassword(e.target.value)} />
            <TextField label="Confirm Password" type="password" placeholder="••••••••" fullWidth value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <FormControlLabel
              control={<Checkbox />}
              label={
                <Typography variant="body2" color="textSecondary">
                  I agree to the Terms of Service and Privacy Policy
                </Typography>
              }
            />
            <Button variant="contained" size="large" fullWidth disabled={busy} onClick={onSubmit}>
              Create Account
            </Button>
            <Typography variant="body2" color="textSecondary" align="center">
              Already have an account?{" "}
              <Link to="/login">
                <Typography component="span" color="primary" fontWeight="medium" sx={{ cursor: "pointer" }}>
                  Sign in
                </Typography>
              </Link>
            </Typography>
          </Box>
        </CardContent>
      </Card>
    </Box>
  );
}
