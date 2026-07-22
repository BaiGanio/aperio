// mcp/tools/files.js — MCP file-operation tools (barrel).
//
// ctx is kept for backward compatibility but path guards are now handled
// directly via the validators imported by each submodule.
//
// Implementation lives in mcp/tools/files/*: helpers (constants + secret-file
// gate), perform (the actual disk mutations), interrupt (confirm-before-write
// two-phase commit), read (read_file/scan_project/grep_files/read_docx),
// write (write_file/append_file/edit_file), delete (delete_file), generate
// (generate_xlsx/generate_docx).

import { z } from "zod";
import { READ_FILE_CHUNK_SIZE, READ_FILE_MAX_OFFSET } from "./files/helpers.js";
import { readFileHandler, scanProjectHandler, grepFilesHandler, readDocxHandler } from "./files/read.js";
import { writeFileHandler, appendFileHandler, editFileHandler } from "./files/write.js";
import { deleteFileHandler } from "./files/delete.js";
import { generateXlsxHandler, generateDocxHandler } from "./files/generate.js";

export {
  readFileHandler, scanProjectHandler, grepFilesHandler, readDocxHandler,
} from "./files/read.js";
export {
  writeFileHandler, appendFileHandler, editFileHandler,
} from "./files/write.js";
export { deleteFileHandler } from "./files/delete.js";
export { generateXlsxHandler, generateDocxHandler } from "./files/generate.js";
export { fileInterruptService, decideFileInterrupt } from "./files/interrupt.js";

// ─── MCP registration ─────────────────────────────────────────────────────────

export function register(server, ctx) {
  server.registerTool(
    "read_file",
    {
      description: "Read a file from disk. Max 500 lines. Only reads code and text files.",
      inputSchema: z.object({
        path:      z.string().describe("Absolute path to the file"),
        max_lines: z.number().min(1).max(READ_FILE_CHUNK_SIZE).optional().describe(`Max lines to read, default ${READ_FILE_CHUNK_SIZE}`),
        offset:    z.number().min(0).max(READ_FILE_MAX_OFFSET).optional().describe("Line number to start reading from, default 0"),
      }),
    },
    readFileHandler
  );

  server.registerTool(
    "grep_files",
    {
      description: "Search code and text files under one allowed path and return matching lines with relative file paths and line numbers. Uses literal matching, skips secrets, symlinks, dependencies, build output, and files over 500KB.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Literal text to find"),
        path: z.string().describe("One file or directory to search"),
        case_sensitive: z.boolean().optional().describe("Match letter case. Default true."),
        max_results: z.number().int().min(1).max(200).optional().describe("Maximum matching lines to return. Default 50."),
      }),
    },
    grepFilesHandler
  );

  server.registerTool(
    "write_file",
    {
      description: "Write content to a file on disk. Creates the file if it doesn't exist, overwrites if it does. Confirm-before-write: a write outside the session workspace (or after reading untrusted content) is proposed for the user to confirm — just call once and end your turn; do NOT fabricate confirmation_token.",
      inputSchema: z.object({
        path:        z.string().describe("Absolute or ~ path to the file to write"),
        content:     z.string().optional().describe("Full content to write to the file"),
        create_dirs: z.boolean().optional().describe("Create parent directories if they don't exist. Default true."),
        confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing."),
      }).passthrough(),
    },
    (args) => writeFileHandler(ctx, args)
  );

  server.registerTool(
    "append_file",
    {
      description: "Append content to the end of an existing file without touching the rest. Content is appended verbatim — include a leading newline (\\n) if you want the content to start on a new line. Confirm-before-write applies as for write_file.",
      inputSchema: z.object({
        path:    z.string().describe("Absolute path to the file"),
        content: z.string().optional().describe("Content to append verbatim. Start with \\n to append on a new line; omit it to continue on the same line."),
        confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing."),
      }).passthrough(),
    },
    (args) => appendFileHandler(ctx, args)
  );

  server.registerTool(
    "edit_file",
    {
      description: "Replace an exact string in a file. Fails if old_string appears more than once unless replace_all is true. Use read_file first to confirm the exact text.",
      // old_string/new_string are the canonical params, but weaker models
      // frequently guess `old`/`new`, `oldText`/`newText`, etc. — those used to
      // fail schema validation and trigger a wasteful retry loop. We make the
      // canonical fields optional, declare the common aliases, and .passthrough()
      // any other key so the handler can normalize whatever the model sent
      // instead of bouncing the call. See editFileHandler.
      inputSchema: z.object({
        path:        z.string().describe("Absolute path to the file"),
        old_string:  z.string().optional().describe("Exact text to find (must be unique in the file unless replace_all is true)"),
        new_string:  z.string().optional().describe("Text to replace it with"),
        old:         z.string().optional().describe("Alias for old_string"),
        new:         z.string().optional().describe("Alias for new_string"),
        oldText:     z.string().optional().describe("Alias for old_string"),
        newText:     z.string().optional().describe("Alias for new_string"),
        replace_all: z.boolean().optional().describe("Replace every occurrence of old_string. Default false."),
      }).passthrough(),
    },
    (args) => editFileHandler(ctx, args)
  );

  server.registerTool(
    "read_docx",
    {
      description: "Read a .docx file from disk and return its content as HTML with full structure preserved (paragraphs, tables, headings, lists). Use this whenever you need to read or extract data from a Word document — do NOT use unpack.py or read_file for .docx files.",
      inputSchema: z.object({
        path: z.string().describe("Absolute path to the .docx file"),
      }),
    },
    readDocxHandler
  );

  server.registerTool(
    "scan_project",
    {
      description: "Scan a project folder. Returns file tree + reads key files. Skips node_modules, .git, build folders.",
      inputSchema: z.object({
        path:           z.string().describe("Absolute path to the project root"),
        read_key_files: z.boolean().optional().describe("Read key file contents, default true"),
      }),
    },
    scanProjectHandler
  );

  server.registerTool(
    "delete_file",
    {
      description: "Delete a file from disk. Confirm-before-write: call WITHOUT confirmation_token to propose; the user is shown a confirm button (or, in the terminal, a token to reply with) and the deletion runs when they confirm. Do NOT fabricate a token and do NOT call again yourself — just propose, then end your turn. Only pass confirmation_token if the user's own message contains a token like 'del_ab12cd'.",
      inputSchema: z.object({
        path:               z.string().optional().describe("Absolute path to the file to delete (required when proposing)."),
        confirmation_token: z.string().optional().describe("RESERVED for the confirm flow — leave empty when proposing. Only set it if the user's message contains a token."),
        token:              z.string().optional().describe("Alias for confirmation_token"),
        confirm:            z.string().optional().describe("Alias for confirmation_token"),
      }).passthrough(),
    },
    (args) => deleteFileHandler(args, ctx)
  );

  server.registerTool(
    "generate_xlsx",
    {
      description: "Generate a .xlsx Excel file in Aperio's protected artifact workspace and make it available for download. The filename is a display name, not a destination path; directory components are discarded. Always report the exact verified path returned by the tool. Use this whenever the user asks to create a spreadsheet, budget, table, or any Excel file. Strings starting with '=' in rows are treated as Excel formulas.",
      inputSchema: z.object({
        filename: z.string().describe("Display filename only, e.g. 'budget_2024.xlsx'. Do not include a directory; the tool returns the exact artifact path."),
        sheets: z.array(
          z.object({
            name:    z.string().describe("Sheet tab name"),
            headers: z.array(z.string()).describe("Column header labels (first row, bold)"),
            rows:    z.array(
              z.array(z.union([z.string(), z.number(), z.null()]))
            ).describe("Data rows. Strings starting with '=' are Excel formulas (omit the leading '=', e.g. '=SUM(B2:E2)' → pass '=SUM(B2:E2)')."),
          })
        ).describe("One or more worksheets to include in the workbook"),
      }),
    },
    generateXlsxHandler
  );

  server.registerTool(
    "generate_docx",
    {
      description: "Generate a .docx Word document and make it available for download. ONLY use this when the user explicitly asks for a Word document output. Do NOT call this as a side-effect of another task (e.g. converting DOCX→XLSX, reading a file, summarizing). If the user asked for an xlsx or any non-docx format, do NOT also call generate_docx.",
      inputSchema: z.object({
        filename: z.string().describe("Output filename, e.g. 'report.docx'"),
        sections: z.array(
          z.object({
            heading:    z.string().optional().describe("Section heading (rendered as Heading 1)"),
            paragraphs: z.array(
              z.union([
                z.string().describe("Plain text paragraph"),
                z.object({
                  type: z.literal("table"),
                  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe("Table rows, each row is an array of cell values"),
                }),
              ])
            ).describe("Paragraph texts or table objects"),
          })
        ).describe("Document sections, each with an optional heading and paragraphs"),
      }),
    },
    generateDocxHandler
  );
}
