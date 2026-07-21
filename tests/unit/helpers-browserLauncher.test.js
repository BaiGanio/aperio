// tests/lib/helpers/browserLauncher.test.js
//
// Tests for the pure browser-argument builder used by openBrowser() in
// server.js. Asserts the private/incognito flag matrix and isolated-profile
// flags across the firefox / chromium / app families.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, browserArgsFor } from "../../../lib/helpers/browserLauncher.js";

const URL = "https://localhost:1234";
const DIR = "/tmp/aperio-profile";

describe("browserArgsFor", () => {
  test("firefox family: private window, no profile", () => {
    assert.deepEqual(
      browserArgsFor(BROWSERS.firefox, URL, null),
      ["-private-window", URL]);
  });

  test("firefox family: isolated adds --profile before the private flag", () => {
    assert.deepEqual(
      browserArgsFor(BROWSERS.firefox, URL, DIR),
      ["--profile", DIR, "-private-window", URL]);
  });

  test("firefox-dev, librewolf and mullvad reuse the firefox flags", () => {
    for (const name of ["firefox-dev", "librewolf", "mullvad"]) {
      assert.deepEqual(
        browserArgsFor(BROWSERS[name], URL, null),
        ["-private-window", URL], name);
    }
  });

  test("chromium family: --incognito, no profile", () => {
    assert.deepEqual(
      browserArgsFor(BROWSERS.chrome, URL, null),
      ["--incognito", URL]);
  });

  test("chromium family: isolated adds --user-data-dir as one =arg", () => {
    assert.deepEqual(
      browserArgsFor(BROWSERS.chrome, URL, DIR),
      [`--user-data-dir=${DIR}`, "--incognito", URL]);
  });

  test("edge uses --inprivate instead of --incognito", () => {
    assert.deepEqual(
      browserArgsFor(BROWSERS.edge, URL, null),
      ["--inprivate", URL]);
    assert.deepEqual(
      browserArgsFor(BROWSERS.edge, URL, DIR),
      [`--user-data-dir=${DIR}`, "--inprivate", URL]);
  });

  test("brave and chromium are plain chromium-family", () => {
    for (const name of ["brave", "chromium"]) {
      assert.deepEqual(
        browserArgsFor(BROWSERS[name], URL, null),
        ["--incognito", URL], name);
    }
  });

  test("app family (tor/ddg): just the URL, even when a profile is passed", () => {
    for (const name of ["tor", "ddg"]) {
      assert.deepEqual(browserArgsFor(BROWSERS[name], URL, null), [URL], name);
      assert.deepEqual(browserArgsFor(BROWSERS[name], URL, DIR), [URL], name);
    }
  });

  test("every browser entry declares a known family", () => {
    for (const [name, b] of Object.entries(BROWSERS)) {
      assert.ok(["firefox", "chromium", "app"].includes(b.family),
        `${name} has unexpected family ${b.family}`);
      assert.ok(b.mac && b.bin && b.win, `${name} missing a platform name`);
    }
  });
});
