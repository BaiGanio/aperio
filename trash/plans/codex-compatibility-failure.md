The Codex integration has an API-key compatibility failure and can resume an
  unrelated provider thread during session restore. It also fails to suppress MCP
  tooling for explicitly tool-free work.

  Full review comments:

  - [P1] Map CODEX_API_KEY to the CLI's OpenAI key variable — /Users/lk/Projects/
    BaiGanio/aperio/lib/agent/providers/codex.js:344-347
    When a user follows the advertised CODEX_API_KEY configuration without an
    existing Codex login, this child inherits only CODEX_API_KEY; the Codex CLI's
    API-key flow uses OPENAI_API_KEY, so authentication fails despite a
    configured key. Set OPENAI_API_KEY from CODEX_API_KEY when it is not already
    present (while preserving an explicit OpenAI value).

  - [P1] Isolate Codex before generating a resumed-session context — /Users/lk/
    Projects/BaiGanio/aperio/lib/emitters/handlers/ws/session.js:79-84
    When a user resumes a saved session after using another Codex-backed chat,
    this call runs before providerSessionSourceId is switched to the target
    session. The wrapper therefore resumes the old Codex thread while also
    sending the saved session's compact context, leaking unrelated context into
    the answer and paying to process both histories. Pass the target session ID
    for this call or force an isolated/new Codex provider session.

  - [P2] Honor noTools in the Codex provider invocation — /Users/lk/Projects/
    BaiGanio/aperio/lib/agent/providers/codex.js:340-343
    For noTools:true calls such as conversation summaries and handoffs, this path
    still starts the required Aperio MCP server with its full tool catalog and
    grants its tools approval. Unlike the other provider loops, the option is
    never propagated, so these supposed text-only calls can spend context on tool
    schemas and may perform unnecessary tool turns. Omit/disable the MCP server
    when opts.noTools is set.