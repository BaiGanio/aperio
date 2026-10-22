import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures/aperio.js";

const toolLabels = {
  backfill_embeddings: "Generate missing embeddings",
  deduplicate_memories: "Find duplicate memories",
  export_data: "Back up Aperio data",
};

async function openAgents(page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("button", { name: /New job/ })).toBeVisible();
}

async function openNewJob(page, id) {
  await page.getByRole("button", { name: /New job/ }).click();
  await page.getByLabel("Job id").fill(id);
  await page.getByLabel("Trigger", { exact: true }).selectOption("manual");
  await expect(page.getByLabel("Enabled (interval/watcher scheduling fires)")).not.toBeChecked();
  await expect(page.getByLabel("Mode", { exact: true })).toHaveValue("steps");
  await page.getByText("Raw JSON — power users", { exact: true }).click();
  await expect(page.getByLabel("Raw JSON steps")).toBeVisible();
}

async function rawSteps(page) {
  return JSON.parse(await page.getByLabel("Raw JSON steps").inputValue());
}

async function expectToolOrder(page, names) {
  await expectVisualToolOrder(page, names);
  await expect.poll(() => rawSteps(page))
    .toEqual(names.map(name => expect.objectContaining({ tool: name, input: expect.any(Object) })));
}

async function expectVisualToolOrder(page, names) {
  const selects = page.getByRole("combobox", { name: /^Tool for step/ });
  await expect(selects).toHaveCount(names.length);
  await expect.poll(async () => selects.evaluateAll(nodes => nodes.map(node => node.value)))
    .toEqual(names);
}

async function dragStep(page, from, to) {
  const handle = page.getByTestId("agent-step-drag-handle").nth(from);
  const target = page.getByTestId("agent-step-card").nth(to);
  await handle.evaluate((source, targetElement) => {
    const dataTransfer = new DataTransfer();
    const options = { bubbles: true, cancelable: true, dataTransfer };
    source.dispatchEvent(new DragEvent("dragstart", options));
    targetElement.dispatchEvent(new DragEvent("dragover", options));
    targetElement.dispatchEvent(new DragEvent("drop", options));
    source.dispatchEvent(new DragEvent("dragend", options));
  }, await target.elementHandle());
}

async function deleteViaApi(baseURL, id) {
  const response = await fetch(new URL(`/api/agents/${encodeURIComponent(id)}`, baseURL), {
    method: "DELETE",
    headers: { "X-Aperio-Client": "e2e" },
  });
  expect([200, 404]).toContain(response.status);
}

test("builds, reorders, synchronizes, persists, reloads, and deletes a deterministic job", async ({ page, aperio }) => {
  const id = `browser-steps-${randomUUID().slice(0, 8)}`;
  try {
    await openAgents(page);
    await openNewJob(page, id);

    const firstTool = page.getByRole("combobox", { name: "Tool for step 1" });
    await expect(firstTool.locator("option")).toHaveText(Object.values(toolLabels));

    await firstTool.selectOption("backfill_embeddings");
    await expect(page.getByLabel("Maximum memories")).toBeVisible();
    await page.getByLabel("Maximum memories").fill("12");

    await firstTool.selectOption("deduplicate_memories");
    await expect(page.getByLabel("Similarity threshold")).toHaveValue("0.97");
    await expect(page.getByLabel("Preview only (do not merge)")).toBeChecked();

    await firstTool.selectOption("export_data");
    await expect(page.getByLabel("Output path")).toBeVisible();

    await firstTool.selectOption("backfill_embeddings");
    await page.getByLabel("Maximum memories").fill("12");
    await page.getByRole("button", { name: /Add step/ }).click();
    await page.getByRole("combobox", { name: "Tool for step 2" }).selectOption("deduplicate_memories");
    await page.getByRole("button", { name: /Add step/ }).click();
    await page.getByRole("combobox", { name: "Tool for step 3" }).selectOption("export_data");
    await page.getByLabel("Output path").fill("/tmp/aperio-browser-export.json");
    await expectToolOrder(page, ["backfill_embeddings", "deduplicate_memories", "export_data"]);

    await page.getByRole("button", { name: "Move step 3 up" }).click();
    await expectToolOrder(page, ["backfill_embeddings", "export_data", "deduplicate_memories"]);

    await dragStep(page, 0, 2);
    await expectToolOrder(page, ["export_data", "deduplicate_memories", "backfill_embeddings"]);

    await page.getByRole("button", { name: "Delete step 2" }).click();
    await expectToolOrder(page, ["export_data", "backfill_embeddings"]);

    const persistedSteps = [
      { tool: "deduplicate_memories", input: { threshold: 0.91, dry_run: true } },
      { tool: "export_data", input: { output_path: "/tmp/aperio-browser-export.json" } },
    ];
    const raw = page.getByLabel("Raw JSON steps");
    await raw.fill(JSON.stringify(persistedSteps, null, 2));
    await raw.blur();
    await expectToolOrder(page, persistedSteps.map(step => step.tool));
    await expect(page.getByLabel("Similarity threshold")).toHaveValue("0.91");

    const createResponse = page.waitForResponse(response =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Create job" }).click();
    expect((await createResponse).status()).toBe(201);

    const jobCard = page.getByRole("article", { name: `Job ${id}` });
    await expect(jobCard).toBeVisible();
    await jobCard.getByRole("button", { name: "Edit" }).click();
    await expect.poll(() => rawSteps(page)).toEqual(persistedSteps);

    await page.reload();
    await page.getByRole("button", { name: "Agents" }).click();
    const reloadedCard = page.getByRole("article", { name: `Job ${id}` });
    await expect(reloadedCard).toBeVisible();
    await reloadedCard.getByRole("button", { name: "Edit" }).click();
    await expect.poll(() => rawSteps(page)).toEqual(persistedSteps);

    await page.getByRole("button", { name: /Back to jobs/ }).click();
    await page.getByRole("article", { name: `Job ${id}` })
      .getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete scheduled job" });
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("article", { name: `Job ${id}` })).toHaveCount(0);
  } finally {
    await deleteViaApi(aperio.baseURL, id);
  }
});

test("malformed Raw JSON reports inline and remains recoverable", async ({ page }) => {
  await openAgents(page);
  await openNewJob(page, `browser-malformed-${randomUUID().slice(0, 8)}`);

  const raw = page.getByLabel("Raw JSON steps");
  const previous = await rawSteps(page);
  await raw.fill("[{");
  await expect(page.getByRole("alert")).toContainText("steps is not valid JSON");
  await expect(page.getByTestId("agent-step-card")).toHaveCount(1);
  await expectVisualToolOrder(page, previous.map(step => step.tool));

  const recovered = [{ tool: "deduplicate_memories", input: { threshold: 0.96, dry_run: true } }];
  await raw.fill(JSON.stringify(recovered));
  await raw.blur();
  await expect(page.getByRole("alert")).toBeEmpty();
  await expectToolOrder(page, ["deduplicate_memories"]);
  await expect(page.getByLabel("Similarity threshold")).toHaveValue("0.96");
});

test("server rejects an unknown tool without persisting the job", async ({ page, request, aperio, browserDiagnostics }) => {
  const id = `browser-unknown-${randomUUID().slice(0, 8)}`;
  try {
    browserDiagnostics.allowConsole(
      /^Failed to load resource: the server responded with a status of 400 \(Bad Request\)$/
    );
    await openAgents(page);
    await openNewJob(page, id);

    const raw = page.getByLabel("Raw JSON steps");
    await raw.fill(JSON.stringify([{ tool: "not_a_real_tool", input: {} }]));
    await raw.blur();
    const rejection = page.waitForResponse(response =>
      response.url().endsWith("/api/agents") &&
      response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Create job" }).click();
    expect((await rejection).status()).toBe(400);
    await expect(page.getByRole("alert")).toContainText(
      'steps[0].tool "not_a_real_tool" is not registered'
    );

    const jobsResponse = await request.get("/api/agents");
    expect(jobsResponse.ok()).toBe(true);
    expect((await jobsResponse.json()).jobs.map(job => job.id)).not.toContain(id);
  } finally {
    await deleteViaApi(aperio.baseURL, id);
  }
});
