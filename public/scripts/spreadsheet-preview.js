// Generated XLSX preview. Workbooks are parsed server-side into a bounded JSON
// grid; this file only renders inert text, so formulas and cell contents cannot
// execute in the browser.

function resetSpreadsheetModal(modal) {
  modal.querySelector(".fpm-sheet-preview").hidden = true;
  modal.querySelector(".fpm-pathbar").hidden = true;
  modal.querySelector(".fpm-body").classList.remove("is-spreadsheet");
  modal.querySelector(".fpm-sheet-scroll").replaceChildren();
  modal.querySelector(".fpm-sheet-tabs").replaceChildren();
}

function _spreadsheetColumnLabel(index) {
  let label = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label;
  }
  return label;
}

function _renderSpreadsheetSheet(modal, workbook, sheetIndex) {
  const sheet = workbook.sheets[sheetIndex];
  const scroll = modal.querySelector(".fpm-sheet-scroll");
  const formula = modal.querySelector(".fpm-formula-value");
  const address = modal.querySelector(".fpm-cell-address");
  const table = document.createElement("table");
  table.className = "fpm-sheet-table";

  const head = document.createElement("thead");
  const letters = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "fpm-row-number";
  letters.appendChild(corner);
  for (let column = 0; column < sheet.previewColumnCount; column++) {
    const th = document.createElement("th");
    th.textContent = _spreadsheetColumnLabel(column);
    letters.appendChild(th);
  }
  head.appendChild(letters);
  table.appendChild(head);

  const body = document.createElement("tbody");
  sheet.rows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const rowNumber = document.createElement("td");
    rowNumber.className = "fpm-row-number";
    rowNumber.textContent = String(rowIndex + 1);
    tr.appendChild(rowNumber);
    row.forEach((cell, columnIndex) => {
      const td = document.createElement("td");
      td.textContent = cell.display;
      if (cell.bold) td.classList.add("is-bold");
      const cellAddress = `${_spreadsheetColumnLabel(columnIndex)}${rowIndex + 1}`;
      td.addEventListener("click", () => {
        table.querySelector(".is-selected")?.classList.remove("is-selected");
        td.classList.add("is-selected");
        address.textContent = cellAddress;
        formula.textContent = cell.formula ? `=${cell.formula}` : cell.display;
      });
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  scroll.replaceChildren(table);

  const meta = modal.querySelector(".fpm-sheet-meta");
  const clipping = sheet.truncated ? " · preview limited" : "";
  meta.textContent = `${sheet.rowCount} rows · ${sheet.columnCount} columns${clipping}`;
  formula.textContent = "Select a cell to inspect its value or formula";
  address.textContent = "A1";

  const tabs = modal.querySelector(".fpm-sheet-tabs");
  [...tabs.children].forEach((tab, index) => tab.classList.toggle("is-active", index === sheetIndex));
}

function _renderSpreadsheetWorkbook(modal, workbook) {
  const tabs = modal.querySelector(".fpm-sheet-tabs");
  workbook.sheets.forEach((sheet, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "fpm-sheet-tab";
    tab.textContent = sheet.name;
    tab.addEventListener("click", () => _renderSpreadsheetSheet(modal, workbook, index));
    tabs.appendChild(tab);
  });
  if (workbook.sheets.length) _renderSpreadsheetSheet(modal, workbook, 0);
  else modal.querySelector(".fpm-sheet-scroll").textContent = "This workbook contains no visible sheets.";
}

async function openGeneratedSpreadsheetModal(url, name) {
  ensureFileModal();
  const modal = document.getElementById("file-preview-modal");
  resetSpreadsheetModal(modal);
  modal.querySelector(".fpm-icon").innerHTML = '<i class="bi bi-file-earmark-spreadsheet"></i>';
  modal.querySelector(".fpm-filename").textContent = (name || "spreadsheet.xlsx").replace(/\.[^.]+$/, "");
  modal.querySelector(".fpm-ext-badge").textContent = "XLSX";
  const frameEl = modal.querySelector(".fpm-frame");
  frameEl.removeAttribute("src");
  frameEl.removeAttribute("srcdoc");
  frameEl.style.display = "none";
  modal.querySelector(".fpm-pre").style.display = "none";
  modal.querySelector(".fpm-view-tabs").hidden = true;
  modal.querySelector(".fpm-copy-btn").hidden = true;
  modal.querySelector(".fpm-sheet-preview").hidden = false;
  modal.querySelector(".fpm-body").classList.add("is-spreadsheet");
  modal.querySelector(".fpm-sheet-scroll").textContent = "Loading spreadsheet…";
  modal.dataset.artifactUrl = url;
  const browserBtn = modal.querySelector(".fpm-browser-btn");
  browserBtn.hidden = false;
  browserBtn.innerHTML = '<i class="bi bi-download"></i> <span>Download</span>';
  browserBtn.title = "Download the original spreadsheet";
  modal.querySelector(".fpm-folder-btn").hidden = false;
  modal.classList.add("open");

  try {
    const response = await fetch(`/api/artifact/preview?url=${encodeURIComponent(url)}`);
    const workbook = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(workbook.error || `HTTP ${response.status}`);
    const pathbar = modal.querySelector(".fpm-pathbar");
    pathbar.hidden = false;
    modal.querySelector(".fpm-path-value").textContent = workbook.path;
    _renderSpreadsheetWorkbook(modal, workbook);
  } catch (error) {
    modal.querySelector(".fpm-sheet-scroll").textContent = `Could not preview spreadsheet: ${error.message}`;
    modal.querySelector(".fpm-folder-btn").hidden = true;
  }
}
