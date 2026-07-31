import { test, expect } from "../fixtures/aperio.js";

// The mascot is wired through CSS and static assets, so the failure mode is a
// silent 404 or a stale selector rather than a thrown error — assert the bytes
// arrive and the elements actually carry the image.

test("mascot assets are served to the app", async ({ request }) => {
  for (const asset of [
    "/assets/mascot/avatar-56.png",
    "/assets/mascot/avatar-112.png",
    "/assets/mascot/mono.png",
    "/assets/mascot/body-256.webp",
    "/assets/mascot/favicon-32.png",
    "/assets/mascot/apple-touch-icon.png",
  ]) {
    const response = await request.get(asset);
    expect(response.ok(), `${asset} should be served`).toBe(true);
    expect((await response.body()).length, `${asset} should not be empty`).toBeGreaterThan(0);
  }
});

test("the AI avatar renders the mascot instead of a letter", async ({ page }) => {
  await page.goto("/");
  const avatar = page.locator(".avatar.ai").first();
  await expect(avatar).toBeAttached();

  const styles = await avatar.evaluate(node => {
    const computed = getComputedStyle(node);
    return {
      backgroundImage: computed.backgroundImage,
      color: computed.color,
      width: computed.width,
    };
  });
  expect(styles.backgroundImage).toContain("avatar-56.png");
  // The letter stays in the DOM for assistive tech but must not be visible.
  expect(styles.color).toBe("rgba(0, 0, 0, 0)");
  expect(styles.width).toBe("48px");
});

test("the empty memories list shows the quiet mascot", async ({ page }) => {
  await page.goto("/");
  // The fixture DB ships seeded memories, so render the empty list explicitly
  // rather than racing the seed.
  await page.waitForFunction(() => typeof window.renderMemories === "function");
  await page.evaluate(() => window.renderMemories([]));

  const mascot = page.locator("#memoriesList .empty-mascot");
  await expect(mascot).toBeVisible();
  await expect(mascot).toHaveAttribute("src", "assets/mascot/mono.png");
  // Decorative: it must not announce itself to a screen reader.
  await expect(mascot).toHaveAttribute("alt", "");
  expect(await mascot.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
});

test("the offline banner appears with the mascot when the socket drops", async ({ page }) => {
  await page.goto("/");
  const banner = page.locator("#offlineBanner");
  await expect(banner).toBeHidden();

  // Close the live socket the way a server restart would.
  await page.evaluate(() => window.ws.close());
  await expect(banner).toBeVisible();
  await expect(banner.locator(".offline-banner-mascot")).toBeVisible();

  // …and it clears itself once the client reconnects.
  await expect(banner).toBeHidden({ timeout: 15_000 });
});

test("setup and help pages lead with the mascot", async ({ page, request }) => {
  // A bootstrapped app sends /setup straight back to the chat, so check the
  // wizard's own markup over HTTP instead of driving the page.
  const setup = await request.get("/setup.html");
  expect(setup.ok()).toBe(true);
  expect(await setup.text()).toContain('class="setup-mascot" src="assets/mascot/body-256.webp"');

  await page.goto("/help.html");
  const helpMascot = page.locator(".page-mascot");
  await expect(helpMascot).toBeVisible();
  expect(await helpMascot.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
});
