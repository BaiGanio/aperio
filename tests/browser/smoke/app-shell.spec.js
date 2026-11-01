import { test, expect } from "../fixtures/aperio.js";

test("real app shell starts cleanly", async ({ page, request }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);

  await expect(page.getByRole("button", { name: "Agents" })).toBeVisible();
  await expect(page.getByPlaceholder(/Ask anything/)).toBeVisible();

  const [asset, tools] = await Promise.all([
    request.get("/scripts/agent-steps-builder.js"),
    request.get("/api/agents/tools"),
  ]);
  expect(asset.ok()).toBe(true);
  expect(await asset.text()).toContain("createAgentStepsBuilder");
  expect(tools.ok()).toBe(true);
  expect((await tools.json()).tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "backfill_embeddings" }),
    expect.objectContaining({ name: "deduplicate_memories" }),
    expect.objectContaining({ name: "export_data" }),
  ]));
});
