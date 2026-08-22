#!/usr/bin/env node
/**
 * Excel Formula Recalculation Script
 * Recalculates all formulas in an Excel file using LibreOffice.
 *
 * Usage:
 *   node recalc.js <excel_file> [timeout_seconds]
 *
 * Returns JSON:
 *   { status, total_errors, total_formulas, error_summary? }
 */

import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, platform } from "os";
import { join, resolve } from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";
import { getSofficeEnv } from "./soffice.js";

const execFileAsync = promisify(execFile);

const MACRO_DIR = platform() === "darwin"
  ? join(homedir(), "Library/Application Support/LibreOffice/4/user/basic/Standard")
  : join(homedir(), ".config/libreoffice/4/user/basic/Standard");

const MACRO_FILE = join(MACRO_DIR, "Module1.xba");

const RECALCULATE_MACRO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub RecalculateAndSave()
      ThisComponent.calculateAll()
      ThisComponent.store()
      ThisComponent.close(True)
    End Sub
</script:module>`;

const EXCEL_ERRORS = ["#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A"];

async function hasGtimeout() {
  try {
    await execFileAsync("gtimeout", ["--version"], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

async function setupLibreOfficeMacro() {
  if (existsSync(MACRO_FILE)) {
    const content = readFileSync(MACRO_FILE, "utf-8");
    if (content.includes("RecalculateAndSave")) return true;
  }

  if (!existsSync(MACRO_DIR)) {
    try {
      await execFileAsync("soffice", ["--headless", "--terminate_after_init"], {
        timeout: 10_000,
        env: getSofficeEnv(),
      });
    } catch { /* ignore — just ensuring the profile dir is created */ }
    mkdirSync(MACRO_DIR, { recursive: true });
  }

  try {
    writeFileSync(MACRO_FILE, RECALCULATE_MACRO, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export async function recalc(filename, timeout = 30) {
  const absPath = resolve(filename);

  if (!existsSync(absPath)) {
    return { error: `File ${filename} does not exist` };
  }

  if (!await setupLibreOfficeMacro()) {
    return { error: "Failed to setup LibreOffice macro" };
  }

  const sofficArgs = [
    "--headless",
    "--norestore",
    "vnd.sun.star.script:Standard.Module1.RecalculateAndSave?language=Basic&location=application",
    absPath,
  ];

  let cmd, args;
  if (platform() === "linux") {
    cmd = "timeout"; args = [String(timeout), "soffice", ...sofficArgs];
  } else if (platform() === "darwin" && await hasGtimeout()) {
    cmd = "gtimeout"; args = [String(timeout), "soffice", ...sofficArgs];
  } else {
    cmd = "soffice"; args = sofficArgs;
  }

  let exitCode = 0;
  try {
    await execFileAsync(cmd, args, {
      env: getSofficeEnv(),
      timeout: (timeout + 5) * 1000,
    });
  } catch (err) {
    exitCode = err.code ?? -1;
    if (exitCode !== 124 /* gtimeout/timeout exit code */) {
      const msg = err.stderr || "Unknown error during recalculation";
      return { error: msg };
    }
  }

  // Scan the recalculated file for formula errors
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(absPath);

    const errorDetails = Object.fromEntries(EXCEL_ERRORS.map(e => [e, []]));
    let totalErrors = 0;
    let totalFormulas = 0;

    wb.eachSheet(sheet => {
      sheet.eachRow(row => {
        row.eachCell({ includeEmpty: false }, cell => {
          const val = cell.value;

          if (val && typeof val === "object" && val.formula !== undefined) {
            totalFormulas++;
            const result = String(val.result ?? "");
            for (const err of EXCEL_ERRORS) {
              if (result.includes(err)) {
                errorDetails[err].push(`${sheet.name}!${cell.address}`);
                totalErrors++;
                break;
              }
            }
          } else if (typeof val === "string") {
            for (const err of EXCEL_ERRORS) {
              if (val.includes(err)) {
                errorDetails[err].push(`${sheet.name}!${cell.address}`);
                totalErrors++;
                break;
              }
            }
          }
        });
      });
    });

    const output = {
      status: totalErrors === 0 ? "success" : "errors_found",
      total_errors: totalErrors,
      total_formulas: totalFormulas,
    };

    if (totalErrors > 0) {
      output.error_summary = {};
      for (const [errType, locations] of Object.entries(errorDetails)) {
        if (locations.length > 0) {
          output.error_summary[errType] = {
            count: locations.length,
            locations: locations.slice(0, 20),
          };
        }
      }
    }

    return output;
  } catch (err) {
    return { error: err.message };
  }
}

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [,, filename, timeoutArg] = process.argv;

  if (!filename) {
    console.log("Usage: node recalc.js <excel_file> [timeout_seconds]");
    console.log("\nRecalculates all formulas in an Excel file using LibreOffice");
    console.log("\nReturns JSON with error details:");
    console.log("  - status: 'success' or 'errors_found'");
    console.log("  - total_errors: Total number of Excel errors found");
    console.log("  - total_formulas: Number of formulas in the file");
    console.log("  - error_summary: Breakdown by error type with locations");
    console.log("    - #VALUE!, #DIV/0!, #REF!, #NAME?, #NULL!, #NUM!, #N/A");
    process.exit(1);
  }

  recalc(filename, timeoutArg ? parseInt(timeoutArg) : 30)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => { console.error(err); process.exit(1); });
}
