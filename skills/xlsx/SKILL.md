---
name: xlsx
description: "Use this skill any time a spreadsheet file (Excel workbook) is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx or .xlsm file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between spreadsheet file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper Excel spreadsheets. The deliverable must be a spreadsheet file (.xlsx). Do NOT trigger when the primary deliverable is a CSV/TSV file, Word document, HTML report, standalone script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
license: Proprietary. LICENSE.txt has complete terms
metadata:
  keywords: "spreadsheet, xlsx, xlsm, excel, tabular, workbook, worksheet, formula, pivot, budget"
  category: "file-generation"
  load: "on-demand"
---

# Requirements for Outputs

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## IMPORTANT: Use the `generate_xlsx` Tool to Create Files

When the user asks you to **create** a new spreadsheet, budget, table, or Excel file, call the `generate_xlsx` MCP tool directly. Do NOT write code for the user to run. The tool generates the `.xlsx` binary, saves it, and surfaces a one-click download card in the chat.

```
Tool: generate_xlsx
Input: { filename, sheets: [{ name, headers, rows }] }
```

Strings in `rows` that start with `=` are treated as Excel formulas. Always use formulas for totals, percentages, and calculated fields — never hardcode calculated values.

After `generate_xlsx` succeeds, tell the user what was created and that the download card is ready below.

## LibreOffice for Formula Recalculation (advanced)

For recalculating formula values in existing files, the `scripts/recalc.js` script can be used. It automatically configures LibreOffice on first run, including in sandboxed environments where Unix sockets are restricted (handled by `scripts/soffice.js`).

## Reading and analyzing data

### Reading Excel files with ExcelJS

```javascript
import ExcelJS from "exceljs";

// Read a workbook
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("file.xlsx");

// Access a sheet by index (1-based) or name
const sheet = wb.getWorksheet(1);           // first sheet
const named = wb.getWorksheet("Revenue");  // by name

// Preview data — iterate rows and cells
sheet.eachRow((row, rowNumber) => {
  console.log(rowNumber, row.values); // row.values is 1-indexed
});

// Get a specific cell
const cell = sheet.getCell("B3");
console.log(cell.value, cell.formula);

// List all sheet names
wb.worksheets.forEach(s => console.log(s.name));
```

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in JavaScript and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```javascript
// Bad: calculating in JS and hardcoding result
const total = rows.reduce((s, r) => s + r.sales, 0);
sheet.getCell("B10").value = total; // hardcodes 5000

// Bad: computing growth in JS
const growth = (last - first) / first;
sheet.getCell("C5").value = growth; // hardcodes 0.15
```

### ✅ CORRECT - Using Excel Formulas
```javascript
// Good: let Excel calculate the sum
sheet.getCell("B10").value = { formula: "SUM(B2:B9)" };

// Good: growth rate as Excel formula
sheet.getCell("C5").value = { formula: "(C4-C2)/C2" };

// Good: average using Excel function
sheet.getCell("D20").value = { formula: "AVERAGE(D2:D19)" };
```

This applies to ALL calculations — totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## Common Workflow
1. **Load or create**: `new ExcelJS.Workbook()` then `readFile` or `addWorksheet`
2. **Modify**: add/edit data, formulas, and formatting
3. **Save**: `wb.xlsx.writeFile("output.xlsx")`
4. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: Use the scripts/recalc.js script
   ```bash
   node scripts/recalc.js output.xlsx
   ```
5. **Verify and fix any errors**:
   - The script returns JSON with error details
   - If `status` is `errors_found`, check `error_summary` for specific error types and locations
   - Fix the identified errors and recalculate again
   - Common errors to fix:
     - `#REF!`: Invalid cell references
     - `#DIV/0!`: Division by zero
     - `#VALUE!`: Wrong data type in formula
     - `#NAME?`: Unrecognized formula name

### Creating new Excel files

```javascript
import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet("Sheet1");

// Add data
sheet.getCell("A1").value = "Hello";
sheet.getCell("B1").value = "World";
sheet.addRow(["Row", "of", "data"]);

// Add formula
sheet.getCell("B2").value = { formula: "SUM(A1:A10)" };

// Formatting
sheet.getCell("A1").font = { bold: true, color: { argb: "FFFF0000" } };
sheet.getCell("A1").fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFFF00" },
};
sheet.getCell("A1").alignment = { horizontal: "center" };

// Column width
sheet.getColumn("A").width = 20;

await wb.xlsx.writeFile("output.xlsx");
```

### Editing existing Excel files

```javascript
import ExcelJS from "exceljs";

// Load existing file
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile("existing.xlsx");

// Access sheets
const sheet = wb.worksheets[0]; // first sheet
const named = wb.getWorksheet("Revenue"); // by name

wb.eachSheet(s => console.log(s.name)); // list all sheets

// Modify cells
sheet.getCell("A1").value = "New Value";
sheet.spliceRows(2, 0, []); // insert empty row at position 2
sheet.spliceColumns(3, 1);  // delete column 3

// Add a new sheet
const newSheet = wb.addWorksheet("NewSheet");
newSheet.getCell("A1").value = "Data";

await wb.xlsx.writeFile("modified.xlsx");
```

## Recalculating formulas

Excel files created or modified by ExcelJS contain formulas as strings but not calculated values. Use the provided `scripts/recalc.js` script to recalculate formulas:

```bash
node scripts/recalc.js <excel_file> [timeout_seconds]
```

Example:
```bash
node scripts/recalc.js output.xlsx 30
```

The script:
- Automatically sets up LibreOffice macro on first run
- Recalculates all formulas in all sheets
- Scans ALL cells for Excel errors (#REF!, #DIV/0!, etc.)
- Returns JSON with detailed error locations and counts
- Works on both Linux and macOS

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (array index 0 = header, row 1 = first data row)

### Common Pitfalls
- [ ] **Null handling**: Check for null/undefined cell values before using them
- [ ] **Far-right columns**: FY data often in columns 50+
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.js Output
The script returns JSON with error details:
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

## ExcelJS Reference

### Color format
ExcelJS uses ARGB hex strings (alpha + RGB): `"FFFF0000"` = opaque red.
- `argb: "FF0000FF"` → blue (inputs)
- `argb: "FF000000"` → black (formulas)
- `argb: "FF008000"` → green (cross-sheet links)
- `argb: "FFFF0000"` → red (external links)
- `argb: "FFFFFF00"` → yellow (key assumptions fill)

### Number formats
```javascript
cell.numFmt = "$#,##0";           // currency
cell.numFmt = "0.0%";             // percentage
cell.numFmt = "0.0x";             // multiples
cell.numFmt = "$#,##0;($#,##0);-"; // with negatives in parens and zeros as dash
```

### Cell address helpers
```javascript
// ExcelJS cell address: sheet.getCell("B3") or sheet.getCell(3, 2)
// row and column are 1-based

// Convert column number to letter
import { columnToLetter } from "exceljs/lib/utils/col-cache.js";
// Or build addresses manually:
const addr = `${String.fromCharCode(64 + colNum)}${rowNum}`; // works up to col 26
```

### Working with formulas
```javascript
// Set a formula
cell.value = { formula: "SUM(B2:B9)", result: 0 }; // result is the cached value

// Read a formula cell after recalc
const cell = sheet.getCell("B10");
if (cell.value?.formula) {
  console.log(cell.value.formula); // "SUM(B2:B9)"
  console.log(cell.value.result);  // cached numeric result
}
```

## Code Style Guidelines
**IMPORTANT**: When generating JavaScript code for Excel operations:
- Write minimal, concise code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary console.log statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections
