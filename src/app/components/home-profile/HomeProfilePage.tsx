import { useEffect, useState, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  Typography,
} from "@mui/material";
import { Home as HomeIcon, RestoreFromTrash } from "@mui/icons-material";
import { useAuth } from "../../auth/AuthProvider";
import { useI18n } from "../../i18n";
import { HomeProfileWizard } from "./HomeProfileWizard";
import { useHomeProfileWizard, hasPersistedDraft } from "./useHomeProfileWizard";
import { SavedHomeProfileView } from "./SavedHomeProfileView";

/**
 * Standalone page for managing the Home Profile.
 *  - When a saved profile exists, shows an inline read-only view with Edit / Refresh.
 *  - When no profile exists, shows an empty state CTA.
 *  - When an unsaved draft is found in localStorage, prompts the user to restore it.
 *  - The wizard dialog is reused for both create and edit flows.
 */
export function HomeProfilePage() {
  const { accessToken, householdId } = useAuth();
  const { t } = useI18n();

  const [toolBusy, setToolBusy] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolSuccess, setToolSuccess] = useState<string | null>(null);
  const [draftRestoredBanner, setDraftRestoredBanner] = useState(false);

  const wizard = useHomeProfileWizard({
    getAgentSetup: () => ({
      token: accessToken ?? "",
      householdId: householdId ?? "",
    }),
    memoryScope: "household",
    appendAssistantMessage: () => {
      // No-op outside chat — success is shown inline.
    },
    setToolBusy,
    setToolError,
    setToolSuccess,
  });

  // Detect any unsaved draft in localStorage on mount.
  const initialHasDraft = useMemo(() => hasPersistedDraft(householdId ?? ""), [householdId]);
  const [showDraftPrompt, setShowDraftPrompt] = useState(initialHasDraft);

  // Check if a profile exists, then auto-load it into view mode.
  useEffect(() => {
    if (!householdId) return;
    void wizard.refreshHomeProfileExists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  useEffect(() => {
    if (
      wizard.homeProfileExists &&
      !wizard.homeProfileDraft &&
      !wizard.homeProfileWizardOpen
    ) {
      void wizard.reviewHomeProfile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizard.homeProfileExists]);

  // When a successful save closes the wizard, hide the draft prompt.
  useEffect(() => {
    if (!wizard.homeProfileWizardOpen && wizard.homeProfileExists && wizard.homeProfileMode === "view") {
      setShowDraftPrompt(false);
    }
  }, [wizard.homeProfileWizardOpen, wizard.homeProfileExists, wizard.homeProfileMode]);

  const handleRestoreDraft = () => {
    const restored = wizard.restorePersistedDraft();
    if (restored) {
      setShowDraftPrompt(false);
      setDraftRestoredBanner(true);
    }
  };

  const handleDiscardDraft = () => {
    wizard.discardPersistedDraft();
    setShowDraftPrompt(false);
  };

  const handleEdit = () => {
    if (!wizard.homeProfileDraft) return;
    // The draft is already in state from reviewHomeProfile (view mode).
    // Switch to edit mode at the rooms step (skip template picker).
    wizard.setHomeProfileMode("edit");
    wizard.setHomeProfileWizardStep(1);
    wizard.setHomeProfileWizardOpen(true);
    setToolError(null);
    setToolSuccess(null);
  };

  const handleCreate = () => {
    wizard.openHomeProfileWizard();
  };

  // We're showing an inline saved view if we have a draft AND the profile exists
  // AND we're not currently in the wizard flow.
  const showInlineView =
    wizard.homeProfileExists &&
    Boolean(wizard.homeProfileDraft) &&
    !wizard.homeProfileWizardOpen;

  // Empty state: no profile yet, no draft loaded, not currently in wizard.
  const showEmptyState =
    !wizard.homeProfileExists &&
    !wizard.homeProfileDraft &&
    !wizard.homeProfileWizardOpen &&
    !wizard.homeProfileBusy;

  return (
    <Box sx={{ p: { xs: 2, sm: 3 }, maxWidth: 900, mx: "auto" }}>
      <Box mb={3}>
        <Typography variant="h4" fontWeight={700}>
          {t("home_profile.dialog_title")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("home_profile.subtitle")}
        </Typography>
      </Box>

      {/* Restore unsaved draft prompt */}
      {showDraftPrompt && (
        <Alert
          severity="info"
          icon={<RestoreFromTrash />}
          sx={{ mb: 2 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button size="small" color="inherit" onClick={handleDiscardDraft}>
                {t("home_profile.draft_discard")}
              </Button>
              <Button size="small" variant="contained" color="primary" onClick={handleRestoreDraft}>
                {t("home_profile.draft_restore")}
              </Button>
            </Stack>
          }
        >
          {t("home_profile.draft_found")}
        </Alert>
      )}

      {/* Save success / error banners */}
      {toolError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setToolError(null)}>
          {toolError}
        </Alert>
      )}
      {toolSuccess && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setToolSuccess(null)}>
          {toolSuccess}
        </Alert>
      )}
      {draftRestoredBanner && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setDraftRestoredBanner(false)}>
          {t("home_profile.draft_restored")}
        </Alert>
      )}

      {/* Inline saved view with Edit button */}
      {showInlineView && wizard.homeProfileDraft && (
        <SavedHomeProfileView
          draft={wizard.homeProfileDraft}
          onEdit={handleEdit}
          onRefresh={() => void wizard.reviewHomeProfile()}
          busy={wizard.homeProfileBusy || toolBusy}
        />
      )}

      {/* Empty state */}
      {showEmptyState && (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: "center", py: 6 }}>
            <HomeIcon sx={{ fontSize: 64, color: "text.disabled", mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              {t("home_profile.empty_title")}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480, mx: "auto", mb: 3 }}>
              {t("home_profile.pick_type")}
            </Typography>
            <Button
              variant="contained"
              size="large"
              startIcon={<HomeIcon />}
              onClick={handleCreate}
            >
              {t("home_profile.create_button")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* The wizard dialog (used for both create and edit flows) */}
      <HomeProfileWizard
        open={wizard.homeProfileWizardOpen}
        onClose={wizard.closeHomeProfileWizard}
        draft={wizard.homeProfileDraft}
        setDraft={wizard.setHomeProfileDraft}
        mode={wizard.homeProfileMode}
        setMode={wizard.setHomeProfileMode}
        step={wizard.homeProfileWizardStep}
        setStep={wizard.setHomeProfileWizardStep}
        newSpace={wizard.homeProfileNewSpace}
        setNewSpace={wizard.setHomeProfileNewSpace}
        busy={wizard.homeProfileBusy}
        error={wizard.homeProfileError}
        toolBusy={toolBusy}
        updateRecord={wizard.updateHomeProfileRecord}
        goNext={wizard.goNextHomeProfileStep}
        goBack={wizard.goBackHomeProfileStep}
        onSave={wizard.saveHomeProfileDraft}
      />
    </Box>
  );
}
