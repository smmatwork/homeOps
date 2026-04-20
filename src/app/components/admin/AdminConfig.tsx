import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import {
  Settings,
  Group,
  Home,
  Notifications,
  Lock,
  Palette,
  Language,
  Storage,
  Mail,
  Security,
  SmartToy,
} from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import {
  getAgentRegistry,
  getHouseholdSettings,
  getRecipeSettings,
  getYoutubeSettings,
  createHouseholdInvite,
  listHouseholdMembers,
  listHouseholdInvites,
  revokeHouseholdInvite,
  setHouseholdSettings,
  setRecipeSettings,
  setYoutubeSettings,
  updateAgentRegistryAgent,
  type AgentRegistryRow,
  type HouseholdMemberRow,
  type HouseholdInviteRow,
  type HouseholdSettings,
  type RecipeSettings,
} from "../../services/agentApi";
import { useI18n } from "../../i18n";

export function AdminConfig() {
  const { t } = useI18n();
  const { accessToken, householdId } = useAuth();
  const [tabValue, setTabValue] = useState("general");
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [autoAssignChores, setAutoAssignChores] = useState(false);
  const [emailDigest, setEmailDigest] = useState(true);
  const [twoFactorAuth, setTwoFactorAuth] = useState(false);

  const [generalBusy, setGeneralBusy] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [generalSaved, setGeneralSaved] = useState(false);
  const [generalName, setGeneralName] = useState<string>("");
  const [generalAddress, setGeneralAddress] = useState<string>("");
  const [generalTimezone, setGeneralTimezone] = useState<string>("ist");
  const [generalLanguage, setGeneralLanguage] = useState<string>("en");

  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRegistryRow[]>([]);
  const [agentEdits, setAgentEdits] = useState<Record<string, Partial<AgentRegistryRow>>>({});
  const [agentSaveBusyKey, setAgentSaveBusyKey] = useState<string | null>(null);

  const [membersBusy, setMembersBusy] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [members, setMembers] = useState<HouseholdMemberRow[]>([]);

  const [invitesBusy, setInvitesBusy] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const [invites, setInvites] = useState<HouseholdInviteRow[]>([]);
  const [inviteEmail, setInviteEmail] = useState<string>("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin" | "owner">("member");

  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [notifSaved, setNotifSaved] = useState(false);

  const [securityBusy, setSecurityBusy] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [securitySaved, setSecuritySaved] = useState(false);

  const [integrationsBusy, setIntegrationsBusy] = useState(false);
  const [integrationsError, setIntegrationsError] = useState<string | null>(null);
  const [integrationsSaved, setIntegrationsSaved] = useState(false);
  const [youtubeSettingsText, setYoutubeSettingsText] = useState<string>("");
  const [recipeAllowedSourcesText, setRecipeAllowedSourcesText] = useState<string>("");
  const [recipeMinRating, setRecipeMinRating] = useState<string>("4");
  const [recipeMinReviews, setRecipeMinReviews] = useState<string>("200");
  const [recipeLenientMissingReviews, setRecipeLenientMissingReviews] = useState<boolean>(true);

  const agentRows = useMemo(() => {
    const edits = agentEdits;
    return agents.map((a) => ({
      ...a,
      ...(edits[a.key] ?? {}),
    }));
  }, [agents, agentEdits]);

  const handleTabChange = (event: React.SyntheticEvent, newValue: string) => {
    setTabValue(newValue);
  };

  const loadGeneralSettings = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setGeneralBusy(true);
    setGeneralError(null);
    setGeneralSaved(false);

    const res = await getHouseholdSettings({ accessToken: token, householdId: hid });
    setGeneralBusy(false);
    if (!res.ok) {
      setGeneralError((res as { ok: false; error: string }).error);
      return;
    }

    const tz = res.settings?.timezone;
    const lang = res.settings?.language;
    const name = res.settings?.name;
    const address = res.settings?.address;
    const notifEnabled = res.settings?.notifications_enabled;
    const digest = res.settings?.email_digest;
    const twoFa = res.settings?.two_factor_auth;
    const autoAssign = res.settings?.auto_assign_chores;
    setGeneralName(typeof name === "string" ? name : "");
    setGeneralAddress(typeof address === "string" ? address : "");
    setGeneralTimezone(typeof tz === "string" && tz ? tz : "ist");
    setGeneralLanguage(typeof lang === "string" && lang ? lang : "en");
    setNotificationsEnabled(typeof notifEnabled === "boolean" ? notifEnabled : true);
    setEmailDigest(typeof digest === "boolean" ? digest : true);
    setTwoFactorAuth(typeof twoFa === "boolean" ? twoFa : false);
    setAutoAssignChores(typeof autoAssign === "boolean" ? autoAssign : false);
  };

  const saveGeneralSettings = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setGeneralBusy(true);
    setGeneralError(null);
    setGeneralSaved(false);

    const res = await setHouseholdSettings({
      accessToken: token,
      householdId: hid,
      settings: {
        name: generalName || null,
        address: generalAddress || null,
        timezone: generalTimezone || null,
        language: generalLanguage || null,
      },
    });

    setGeneralBusy(false);
    if (!res.ok) {
      setGeneralError((res as { ok: false; error: string }).error);
      return;
    }

    setGeneralSaved(true);
  };

  const loadAgents = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setAgentsBusy(true);
    setAgentsError(null);
    const res = await getAgentRegistry({ accessToken: token, householdId: hid });
    setAgentsBusy(false);

    if (!res.ok) {
      setAgents([]);
      setAgentEdits({});
      setAgentsError((res as { ok: false; error: string }).error);
      return;
    }

    setAgents(res.agents);
    setAgentEdits({});
  };

  useEffect(() => {
    if (tabValue !== "agents") return;
    void loadAgents();
  }, [tabValue, accessToken, householdId]);

  useEffect(() => {
    if (tabValue !== "general") return;
    void loadGeneralSettings();
  }, [tabValue, accessToken, householdId]);

  const loadMembers = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setMembersBusy(true);
    setMembersError(null);
    const res = await listHouseholdMembers({ accessToken: token, householdId: hid });
    setMembersBusy(false);
    if (!res.ok) {
      setMembers([]);
      setMembersError((res as { ok: false; error: string }).error);
      return;
    }
    setMembers(res.members);
  };

  const loadInvites = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setInvitesBusy(true);
    setInvitesError(null);
    const res = await listHouseholdInvites({ accessToken: token, householdId: hid });
    setInvitesBusy(false);
    if (!res.ok) {
      setInvites([]);
      setInvitesError((res as { ok: false; error: string }).error);
      return;
    }
    setInvites(res.invites);
  };

  useEffect(() => {
    if (tabValue !== "members") return;
    void loadMembers();
    void loadInvites();
  }, [tabValue, accessToken, householdId]);

  const createInvite = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setInvitesError(null);
    setInvitesBusy(true);
    const res = await createHouseholdInvite({
      accessToken: token,
      householdId: hid,
      invitedEmail: inviteEmail.trim(),
      role: inviteRole,
    });
    setInvitesBusy(false);
    if (!res.ok) {
      setInvitesError((res as { ok: false; error: string }).error);
      return;
    }
    setInviteEmail("");
    await loadInvites();
  };

  const revokeInvite = async (inviteId: string) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setInvitesError(null);
    setInvitesBusy(true);
    const res = await revokeHouseholdInvite({ accessToken: token, householdId: hid, inviteId });
    setInvitesBusy(false);
    if (!res.ok) {
      setInvitesError((res as { ok: false; error: string }).error);
      return;
    }
    await loadInvites();
  };

  const saveNotifications = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setNotifBusy(true);
    setNotifError(null);
    setNotifSaved(false);

    const patch: HouseholdSettings = {
      name: generalName || null,
      address: generalAddress || null,
      timezone: generalTimezone || null,
      language: generalLanguage || null,
      notifications_enabled: notificationsEnabled,
      email_digest: emailDigest,
    };

    const res = await setHouseholdSettings({ accessToken: token, householdId: hid, settings: patch });
    setNotifBusy(false);
    if (!res.ok) {
      setNotifError((res as { ok: false; error: string }).error);
      return;
    }
    setNotifSaved(true);
  };

  const saveSecurity = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setSecurityBusy(true);
    setSecurityError(null);
    setSecuritySaved(false);

    const patch: HouseholdSettings = {
      name: generalName || null,
      address: generalAddress || null,
      timezone: generalTimezone || null,
      language: generalLanguage || null,
      two_factor_auth: twoFactorAuth,
      auto_assign_chores: autoAssignChores,
    };

    const res = await setHouseholdSettings({ accessToken: token, householdId: hid, settings: patch });
    setSecurityBusy(false);
    if (!res.ok) {
      setSecurityError((res as { ok: false; error: string }).error);
      return;
    }
    setSecuritySaved(true);
  };

  const loadIntegrations = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setIntegrationsBusy(true);
    setIntegrationsError(null);
    setIntegrationsSaved(false);

    const [yt, recipes] = await Promise.all([
      getYoutubeSettings({ accessToken: token, householdId: hid }),
      getRecipeSettings({ accessToken: token, householdId: hid }),
    ]);

    setIntegrationsBusy(false);

    if (!yt.ok) {
      setIntegrationsError((yt as { ok: false; error: string }).error);
      return;
    }
    if (!recipes.ok) {
      setIntegrationsError((recipes as { ok: false; error: string }).error);
      return;
    }

    setYoutubeSettingsText(JSON.stringify(yt.settings ?? null, null, 2));

    const r = recipes.settings;
    const allowedSources = r?.allowed_sources ?? [];
    setRecipeAllowedSourcesText(Array.isArray(allowedSources) ? allowedSources.join(", ") : "");
    setRecipeMinRating(String(r?.thresholds?.min_rating ?? 4));
    setRecipeMinReviews(String(r?.thresholds?.min_reviews ?? 200));
    setRecipeLenientMissingReviews(Boolean(r?.thresholds?.lenient_missing_reviews ?? true));
  };

  useEffect(() => {
    if (tabValue !== "integrations") return;
    void loadIntegrations();
  }, [tabValue, accessToken, householdId]);

  const saveIntegrations = async () => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    setIntegrationsBusy(true);
    setIntegrationsError(null);
    setIntegrationsSaved(false);

    let ytSettings: unknown = null;
    try {
      ytSettings = youtubeSettingsText.trim() ? JSON.parse(youtubeSettingsText) : null;
    } catch {
      setIntegrationsBusy(false);
      setIntegrationsError(t("common.unknown_error"));
      return;
    }

    const allowed_sources = recipeAllowedSourcesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const min_rating = Number(recipeMinRating);
    const min_reviews = Math.trunc(Number(recipeMinReviews));
    const recipeSettings: RecipeSettings = {
      allowed_sources,
      thresholds: {
        min_rating: Number.isFinite(min_rating) ? min_rating : 4,
        min_reviews: Number.isFinite(min_reviews) ? min_reviews : 200,
        lenient_missing_reviews: recipeLenientMissingReviews,
      },
    };

    const [ytRes, recRes] = await Promise.all([
      setYoutubeSettings({ accessToken: token, householdId: hid, settings: ytSettings }),
      setRecipeSettings({ accessToken: token, householdId: hid, settings: recipeSettings }),
    ]);

    setIntegrationsBusy(false);
    if (!ytRes.ok) {
      setIntegrationsError((ytRes as { ok: false; error: string }).error);
      return;
    }
    if (!recRes.ok) {
      setIntegrationsError((recRes as { ok: false; error: string }).error);
      return;
    }
    setIntegrationsSaved(true);
  };

  const updateAgentEdit = (key: string, patch: Partial<AgentRegistryRow>) => {
    setAgentEdits((cur) => ({ ...cur, [key]: { ...(cur[key] ?? {}), ...patch } }));
  };

  const parseToolAllowlist = (s: string): string[] => {
    return s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  };

  const formatToolAllowlist = (arr: string[]): string => {
    return Array.isArray(arr) ? arr.join(", ") : "";
  };

  const saveAgent = async (row: AgentRegistryRow) => {
    const token = accessToken.trim();
    const hid = householdId.trim();
    if (!token || !hid) return;

    const patch = agentEdits[row.key] ?? {};
    if (!patch || Object.keys(patch).length === 0) return;

    setAgentSaveBusyKey(row.key);
    setAgentsError(null);

    const res = await updateAgentRegistryAgent({
      accessToken: token,
      householdId: hid,
      key: row.key,
      patch: patch as Partial<Pick<AgentRegistryRow, "display_name" | "enabled" | "model" | "system_prompt" | "tool_allowlist">>,
    });

    setAgentSaveBusyKey(null);

    if (!res.ok) {
      setAgentsError((res as { ok: false; error: string }).error);
      return;
    }

    setAgents((cur) => cur.map((a) => (a.key === row.key ? res.agent : a)));
    setAgentEdits((cur) => {
      const next = { ...cur };
      delete next[row.key];
      return next;
    });
  };

  return (
    <Box p={4}>
      {/* Header */}
      <Box mb={4}>
        <Typography variant="h4" fontWeight="bold">
          {t("admin.title")}
        </Typography>
        <Typography color="textSecondary">
          {t("admin.subtitle")}
        </Typography>
      </Box>

      {/* Tabs */}
      <Tabs value={tabValue} onChange={handleTabChange} variant="scrollable">
        <Tab label={t("admin.general")} value="general" />
        <Tab label={t("admin.members")} value="members" />
        <Tab label={t("admin.notifications")} value="notifications" />
        <Tab label={t("admin.security")} value="security" />
        <Tab label={t("admin.integrations")} value="integrations" />
        <Tab label={t("admin.agents")} value="agents" />
      </Tabs>

      {/* General Settings */}
      {tabValue === "general" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <Home fontSize="small" />
                  {t("admin.household_information")}
                </Box>
              }
              subheader={t("admin.household_information_subtitle")}
            />
            <CardContent>
              {generalError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {generalError}
                </Alert>
              ) : null}
              {generalSaved ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {t("common.save")}
                </Alert>
              ) : null}
              <Box mb={2}>
                <TextField
                  fullWidth
                  label={t("admin.household_name")}
                  value={generalName}
                  onChange={(e) => setGeneralName(e.target.value)}
                />
              </Box>
              <Box mb={2}>
                <TextField
                  fullWidth
                  label={t("admin.address")}
                  value={generalAddress}
                  onChange={(e) => setGeneralAddress(e.target.value)}
                />
              </Box>
              <Box display="flex" gap={2}>
                <FormControl fullWidth>
                  <InputLabel id="admin-timezone-label">{t("admin.timezone")}</InputLabel>
                  <Select
                    labelId="admin-timezone-label"
                    id="admin-timezone"
                    label={t("admin.timezone")}
                    value={generalTimezone}
                    onChange={(e) => setGeneralTimezone(String(e.target.value))}
                  >
                    <MenuItem value="ist">India (IST)</MenuItem>
                    <MenuItem value="est">Eastern (EST)</MenuItem>
                    <MenuItem value="cst">Central (CST)</MenuItem>
                    <MenuItem value="mst">Mountain (MST)</MenuItem>
                    <MenuItem value="pst">Pacific (PST)</MenuItem>
                  </Select>
                </FormControl>
                <FormControl fullWidth>
                  <InputLabel id="admin-language-label">{t("admin.language")}</InputLabel>
                  <Select
                    labelId="admin-language-label"
                    id="admin-language"
                    label={t("admin.language")}
                    value={generalLanguage}
                    onChange={(e) => setGeneralLanguage(String(e.target.value))}
                  >
                    <MenuItem value="en">English</MenuItem>
                    <MenuItem value="hi">Hindi</MenuItem>
                    <MenuItem value="kn">Kannada</MenuItem>
                  </Select>
                </FormControl>
              </Box>
              <Box mt={2}>
                <Button variant="contained" onClick={() => void saveGeneralSettings()} disabled={generalBusy}>
                  {t("admin.save_changes")}
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Box>
      )}

      {tabValue === "agents" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <SmartToy fontSize="small" />
                  {t("admin.agents")}
                </Box>
              }
              subheader={t("admin.agents_subtitle")}
              action={
                <Button variant="outlined" onClick={() => void loadAgents()} disabled={agentsBusy}>
                  {t("common.refresh")}
                </Button>
              }
            />
            <Divider />
            <CardContent>
              {agentsError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {agentsError}
                </Alert>
              ) : null}

              {agentRows.map((a, idx) => (
                <Box key={a.key}>
                  {idx > 0 ? <Divider sx={{ my: 2 }} /> : null}
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                    <Typography variant="h6">{a.display_name}</Typography>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={!!a.enabled}
                          onChange={(e) => updateAgentEdit(a.key, { enabled: e.target.checked })}
                        />
                      }
                      label={t("admin.agent_enabled")}
                    />
                  </Box>

                  <Box display="flex" gap={2} mb={2} flexWrap="wrap">
                    <TextField
                      label={t("admin.agent_key")}
                      value={a.key}
                      disabled
                      sx={{ minWidth: 220 }}
                    />
                    <TextField
                      label={t("admin.agent_display_name")}
                      value={a.display_name}
                      onChange={(e) => updateAgentEdit(a.key, { display_name: e.target.value })}
                      sx={{ minWidth: 260, flex: 1 }}
                    />
                    <TextField
                      label={t("admin.agent_model")}
                      value={a.model ?? ""}
                      onChange={(e) => updateAgentEdit(a.key, { model: e.target.value.trim() ? e.target.value : null })}
                      sx={{ minWidth: 260, flex: 1 }}
                    />
                  </Box>

                  <TextField
                    fullWidth
                    label={t("admin.agent_system_prompt")}
                    value={a.system_prompt}
                    onChange={(e) => updateAgentEdit(a.key, { system_prompt: e.target.value })}
                    multiline
                    minRows={4}
                    sx={{ mb: 2 }}
                  />

                  <TextField
                    fullWidth
                    label={t("admin.agent_tool_allowlist")}
                    value={formatToolAllowlist(a.tool_allowlist ?? [])}
                    onChange={(e) => updateAgentEdit(a.key, { tool_allowlist: parseToolAllowlist(e.target.value) })}
                    helperText={t("admin.agent_tool_allowlist_help")}
                    sx={{ mb: 2 }}
                  />

                  <Box display="flex" justifyContent="flex-end">
                    <Button
                      variant="contained"
                      onClick={() => void saveAgent(a)}
                      disabled={agentSaveBusyKey === a.key || !(agentEdits[a.key] && Object.keys(agentEdits[a.key] ?? {}).length > 0)}
                    >
                      {t("admin.save_changes")}
                    </Button>
                  </Box>
                </Box>
              ))}

              {!agentsBusy && agentRows.length === 0 ? (
                <Typography color="text.secondary">{t("admin.agents_empty")}</Typography>
              ) : null}
            </CardContent>
          </Card>
        </Box>
      )}

      {tabValue === "members" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <Group fontSize="small" />
                  {t("admin.members")}
                </Box>
              }
              subheader={t("admin.members_subtitle")}
              action={
                <Button variant="outlined" onClick={() => void loadMembers()} disabled={membersBusy}>
                  {t("common.refresh")}
                </Button>
              }
            />
            <Divider />
            <CardContent>
              {membersError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {membersError}
                </Alert>
              ) : null}

              {invitesError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {invitesError}
                </Alert>
              ) : null}

              <Box display="flex" gap={2} flexWrap="wrap" alignItems="center" sx={{ mb: 2 }}>
                <TextField
                  label={t("admin.invite_email")}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  sx={{ minWidth: 260 }}
                />
                <FormControl sx={{ minWidth: 180 }}>
                  <InputLabel id="invite-role-label">{t("admin.invite_role")}</InputLabel>
                  <Select
                    labelId="invite-role-label"
                    value={inviteRole}
                    label={t("admin.invite_role")}
                    onChange={(e) => setInviteRole(e.target.value as "member" | "admin" | "owner")}
                    size="small"
                  >
                    <MenuItem value="member">{t("admin.role_member")}</MenuItem>
                    <MenuItem value="admin">{t("admin.role_admin")}</MenuItem>
                    <MenuItem value="owner">{t("admin.role_owner")}</MenuItem>
                  </Select>
                </FormControl>
                <Button variant="contained" onClick={() => void createInvite()} disabled={invitesBusy || !inviteEmail.trim()}>
                  {t("admin.send_invite")}
                </Button>
              </Box>

              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                {t("admin.pending_invites")}
              </Typography>
              {invites.length === 0 && !invitesBusy ? (
                <Typography color="text.secondary" sx={{ mb: 2 }}>
                  {t("admin.invites_empty")}
                </Typography>
              ) : null}

              {invites.map((inv) => {
                const inviteUrl = `${window.location.origin}/invite?token=${encodeURIComponent(inv.token)}`;
                const status = inv.revoked_at
                  ? t("admin.invite_status_revoked")
                  : inv.accepted_at
                    ? t("admin.invite_status_accepted")
                    : t("admin.invite_status_pending");
                const canRevoke = !inv.revoked_at && !inv.accepted_at;
                return (
                  <Box key={inv.id} sx={{ mb: 2 }}>
                    <Box display="flex" justifyContent="space-between" alignItems="center" gap={2}>
                      <Box>
                        <Typography fontWeight={600}>{inv.invited_email}</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {inv.role} • {status}
                        </Typography>
                      </Box>
                      <Box display="flex" gap={1} alignItems="center">
                        <Button
                          variant="outlined"
                          size="small"
                          onClick={() => {
                            try {
                              void navigator.clipboard.writeText(inviteUrl);
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          {t("admin.copy_invite_link")}
                        </Button>
                        <Button
                          variant="outlined"
                          color="error"
                          size="small"
                          disabled={!canRevoke || invitesBusy}
                          onClick={() => void revokeInvite(inv.id)}
                        >
                          {t("admin.revoke_invite")}
                        </Button>
                      </Box>
                    </Box>
                    <TextField fullWidth size="small" value={inviteUrl} sx={{ mt: 1 }} inputProps={{ readOnly: true }} />
                  </Box>
                );
              })}

              <Divider sx={{ my: 2 }} />

              {members.length === 0 && !membersBusy ? (
                <Typography color="text.secondary">{t("admin.members_empty")}</Typography>
              ) : null}

              {members.map((m, idx) => (
                <Box key={m.user_id}>
                  {idx > 0 ? <Divider sx={{ my: 2 }} /> : null}
                  <Box display="flex" justifyContent="space-between" alignItems="center" gap={2}>
                    <Box>
                      <Typography fontWeight={600}>{m.full_name ?? m.user_id}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {m.role}
                      </Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      {new Date(m.created_at).toLocaleDateString()}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </CardContent>
          </Card>
        </Box>
      )}

      {tabValue === "notifications" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <Notifications fontSize="small" />
                  {t("admin.notifications")}
                </Box>
              }
              subheader={t("admin.notifications_subtitle")}
            />
            <Divider />
            <CardContent>
              {notifError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {notifError}
                </Alert>
              ) : null}
              {notifSaved ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {t("common.save")}
                </Alert>
              ) : null}

              <FormControlLabel
                control={<Switch checked={notificationsEnabled} onChange={(e) => setNotificationsEnabled(e.target.checked)} />}
                label={t("admin.notifications_enabled")}
              />
              <FormControlLabel
                control={<Switch checked={emailDigest} onChange={(e) => setEmailDigest(e.target.checked)} />}
                label={t("admin.email_digest")}
              />

              <Box mt={2}>
                <Button variant="contained" onClick={() => void saveNotifications()} disabled={notifBusy}>
                  {t("admin.save_changes")}
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Box>
      )}

      {tabValue === "security" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <Lock fontSize="small" />
                  {t("admin.security")}
                </Box>
              }
              subheader={t("admin.security_subtitle")}
            />
            <Divider />
            <CardContent>
              {securityError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {securityError}
                </Alert>
              ) : null}
              {securitySaved ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {t("common.save")}
                </Alert>
              ) : null}

              <FormControlLabel
                control={<Switch checked={twoFactorAuth} onChange={(e) => setTwoFactorAuth(e.target.checked)} />}
                label={t("admin.two_factor_auth")}
              />
              <FormControlLabel
                control={<Switch checked={autoAssignChores} onChange={(e) => setAutoAssignChores(e.target.checked)} />}
                label={t("admin.auto_assign_chores")}
              />

              <Box mt={2}>
                <Button variant="contained" onClick={() => void saveSecurity()} disabled={securityBusy}>
                  {t("admin.save_changes")}
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Box>
      )}

      {tabValue === "integrations" && (
        <Box mt={4}>
          <Card>
            <CardHeader
              title={
                <Box display="flex" alignItems="center" gap={1}>
                  <Storage fontSize="small" />
                  {t("admin.integrations")}
                </Box>
              }
              subheader={t("admin.integrations_subtitle")}
              action={
                <Button variant="outlined" onClick={() => void loadIntegrations()} disabled={integrationsBusy}>
                  {t("common.refresh")}
                </Button>
              }
            />
            <Divider />
            <CardContent>
              {integrationsError ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {integrationsError}
                </Alert>
              ) : null}
              {integrationsSaved ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {t("common.save")}
                </Alert>
              ) : null}

              <Typography variant="h6" sx={{ mb: 1 }}>
                {t("admin.youtube_settings")}
              </Typography>
              <TextField
                fullWidth
                multiline
                minRows={6}
                value={youtubeSettingsText}
                onChange={(e) => setYoutubeSettingsText(e.target.value)}
                sx={{ mb: 3 }}
              />

              <Typography variant="h6" sx={{ mb: 1 }}>
                {t("admin.recipe_settings")}
              </Typography>
              <TextField
                fullWidth
                label={t("admin.allowed_sources")}
                value={recipeAllowedSourcesText}
                onChange={(e) => setRecipeAllowedSourcesText(e.target.value)}
                sx={{ mb: 2 }}
              />
              <Box display="flex" gap={2} flexWrap="wrap" sx={{ mb: 1 }}>
                <TextField
                  label={t("admin.min_rating")}
                  value={recipeMinRating}
                  onChange={(e) => setRecipeMinRating(e.target.value)}
                  sx={{ minWidth: 180 }}
                />
                <TextField
                  label={t("admin.min_reviews")}
                  value={recipeMinReviews}
                  onChange={(e) => setRecipeMinReviews(e.target.value)}
                  sx={{ minWidth: 180 }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      checked={recipeLenientMissingReviews}
                      onChange={(e) => setRecipeLenientMissingReviews(e.target.checked)}
                    />
                  }
                  label={t("admin.lenient_missing_reviews")}
                />
              </Box>

              <Box mt={2}>
                <Button variant="contained" onClick={() => void saveIntegrations()} disabled={integrationsBusy}>
                  {t("admin.save_changes")}
                </Button>
              </Box>
            </CardContent>
          </Card>
        </Box>
      )}

      {/* ...existing code for other tabs (members, notifications, security, integrations)... */}
    </Box>
  );
}
