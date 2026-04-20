import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    if (process.env.PW_NETWORK_LOG === "1") {
      page.on("request", (req) => {
        const method = req.method();
        const url = req.url();
        const postData = req.postData();
        const data = postData && postData.length < 500 ? ` data=${postData}` : "";
        console.log(`[pw][request] ${method} ${url}${data}`);
      });

      page.on("response", async (res) => {
        const req = res.request();
        const method = req.method();
        const url = res.url();
        const status = res.status();
        const ct = (res.headers()["content-type"] ?? "").toLowerCase();

        let bodySnippet = "";
        if (ct.includes("application/json")) {
          try {
            const text = await res.text();
            bodySnippet = text.length <= 500 ? ` body=${text}` : ` body=${text.slice(0, 500)}…`;
          } catch {
            // ignore
          }
        }

        console.log(`[pw][response] ${status} ${method} ${url}${bodySnippet}`);
      });
    }

    await use(page);
  },
});

export { expect };
