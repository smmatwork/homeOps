import { test, expect } from "./test";

// This E2E uses route stubs so it doesn't require a running Supabase.
// It verifies the UI flow stays inside chat and that confirmation messaging appears.

test("delete chores flow shows preview and persists confirmation message", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("homeops.agent.access_token", "token");
    localStorage.setItem("homeops.agent.household_id", "hid");
  });

  await page.route("**/functions/v1/server/chat/state**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        conversation_id: "c1",
        summary: "",
        messages: [],
      }),
    });
  });

  await page.route("**/functions/v1/server/chat/append", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, conversation_id: "c1" }),
    });
  });

  // Tool execution endpoint used by agentApi. We stub success.
  await page.route("**/functions/v1/server/tools/execute", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, tool_call_id: "t1", summary: "Deleted." }),
    });
  });

  // Supabase-js will query chores directly via PostgREST in the delete preview step.
  // Stub chores list so the preview card has items.
  await page.route("**/rest/v1/chores**", async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }

    const now = new Date().toISOString();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "c1",
          household_id: "hid",
          title: "Sweep kitchen",
          status: "overdue",
          due_at: past,
          helper_id: null,
          created_at: now,
        },
        {
          id: "c2",
          household_id: "hid",
          title: "Mop balcony",
          status: "overdue",
          due_at: past,
          helper_id: null,
          created_at: now,
        },
      ]),
    });
  });

  await page.goto("/chat");

  // Send a delete request.
  const textbox = page.getByPlaceholder(/ask anything about your home|कुछ भी पूछें|ಏನಾದರೂ ಕೇಳಿ/i);
  await textbox.fill("delete chores");
  await textbox.press("Enter");

  // Provide the scope.
  await textbox.fill("overdue");
  await textbox.press("Enter");

  // Expect a preview/confirmation UI to appear.
  await expect(page.getByText(/delete chores \(preview\)/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(page.getByRole("button", { name: /cancel/i })).toBeVisible();
});
