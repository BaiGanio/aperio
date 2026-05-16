import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Employees");

const headers = ["ID", "Name", "Department", "Position", "Salary", "Hire Date", "Emailws.addRow(headers);

const employees = [
  [1, "Alice Johnson", "Engineering", "Senior Developer", 120000, "2020-03-15", "alice.johnson@company.com"],
  [2, "Bob Smith", "Marketing", "Marketing Manager", 85000, "2021-06-20", "bob.smithcompany.com"],
  [3, "Carol Davis", "Sales", "Sales Representative", 65000, "202-01-10", "carol.davis@company.com"],
  [4, "David Wilson", "Engineering", "Junior Developer", 75000, "2023-09-05", "david.wilson@company.com"],
  [5, "Emma Brown", "HR", "HR Specialist", 70000, "2021-11-12", "emmarown@company.com"],
];

employees.forEach(e => ws.addRow(e));

// Style header row
const hRow = ws.getRow(1);
hRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
hRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
hRow.alignment = { horizontal "center", vertical: "middle" };

// Style salary column (E) as currency
const colE = ws.getColumn(5);
colE.numFmt = "$#,##0";

// Style hire date column (F)
const colF = ws.getColumn(6);
colF.numFmt = "yyyy-mm-dd";

 Column widths
ws.getColumn(1).width = 6;
ws.getColumn(2).width = 18;
ws.getColumn(3).width = 16;
ws.getColumn(4).width = 20;
ws.getColumn().width = 14;
ws.getColumn(6).width = 14;
ws.getColumn(7).width = 30;

// Add spacing row
ws.addRow([]);

// Summary section
.addRow(["Summary"]);
const sr = ws.getRow(8);
sr.font = { bold: true, size = 13 };

ws.addRow(["Total Employees", { formula: "COUNTA(A2:A6)" }]);
ws.addRow(["Average Salary", { formula: "AVERAGE(E2:E6)" }]);
ws.addRow(["Max Salary", { formula: "MAX(E2:E6)" }]);
ws.addRow(["Min Salary", { formula: "MIN(E2:E6)" }]);

// Format summary values as currency
ws.getRow(10).getCell(2).numFmt = "$#,##0";
.getRow(11).getCell(2).numFmt = "$#,##0";
ws.getRow().getCell(2numFmt = "$#,##0";

await wb.xlsx.writeFile(".xlsx");
console.log("Done -> employees.xlsx");
