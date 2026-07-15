import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshRequestModel } from "../../../../lib/handlers/wiki/regenerate.js";

test("routes a DB-configured main model through the resident alias", () => {
  assert.equal(
    refreshRequestModel("db-configured-main", {
      name: "llamacpp",
      model: "db-configured-main",
      requestModel: "aperio-main",
    }),
    "aperio-main",
  );
});

test("keeps a distinct refresh model as its configured model", () => {
  assert.equal(
    refreshRequestModel("separate-refresh-model", {
      name: "llamacpp",
      model: "db-configured-main",
      requestModel: "aperio-main",
    }),
    "separate-refresh-model",
  );
});
