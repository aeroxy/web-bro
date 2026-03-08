import { expect, test } from "@playwright/test";

test("renders the shell header", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Web Bro").first()).toBeVisible();
});
