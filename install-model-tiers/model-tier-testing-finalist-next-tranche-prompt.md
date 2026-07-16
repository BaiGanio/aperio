# Next-session prompt: Gemma 4 E4B finalist exam tranche 2

Continue from the private audit at:

`var/benchmarks/model-tiers/32gb/gemma4-e4b-ud-q4kxl/20260716T130000Z-e4b-finalist-exam-tranche-01/audit.md`

Gemma 4 E4B remains the sole primary provisional finalist, not an approved
installer default. Preserve all existing artifacts. Do not rerun observations
1–28 and do not overwrite the excluded interrupted directory
`20260716T130000Z-e4b-finalist-exam-b03`.

## Tranche boundary

Execute exactly the next 25 required observations, numbered 29–53, then stop:

29. `code-callees:1`
30. `code-status:1`
31. `file-read:1`
32. `file-scan:1`
33. `file-write:1`
34. `file-edit:1`
35. `file-append:1`
36. `file-docx:1`
37. `file-xlsx:1`
38. `file-delete:1`
39. `file-pinned-memory:1`
40. `web-fetch:1`
41. `web-github-issue:1`
42. `web-image:1`
43. `shell-allowed:1`
44. `shell-git:1`
45. `shell-blocked-operator:1`
46. `shell-node:1`
47. `shell-python:1`
48. `shell-syntax:1`
49. `skill-pptx:1`
50. `skill-xlsx:1`
51. `skill-docx:1`
52. `skill-pdf:1`
53. `skill-canvas:1`

Use new, non-overwriting campaign IDs. Keep native recall scaffolding disabled,
the 16,384 served context, and the fixed 300-second deadline. Preserve every
attempt, `skills_matched` event, tool result, state assertion, exact model-round
token usage, context warning/trim event, RAM/swap sample, application log, and
llama.cpp log under ignored `var/benchmarks/model-tiers/`.

Before running, inspect tranche 1's context-pressure findings. In the tranche 2
audit, explicitly distinguish model behavior from application pressure:

- tool schemas are re-sent every stateless round and candidate sets were capped;
- some skill matches injected 4k+ tokens;
- a wiki attempt reached 16,524 tokens against a 16,384-token context;
- retry restoration appears to duplicate seeded baseline memories;
- the operator-stopped b03 cleanup hit a double-interrupt Metal assertion but
  left no process or listener.

After observation 53, stop all owned processes, remove only owned throwaway
state, verify no owned listener remains, and write a private tranche-2 audit
that links every raw run/log. Report cumulative progress as 53/81. Do not
generate finalist decisions, modify installer/runtime/catalog wiring, or call
E4B an approved default.
