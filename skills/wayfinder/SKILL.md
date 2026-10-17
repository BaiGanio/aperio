---
name: wayfinder
description: >
  Plan a huge chunk of work — more than one agent session can hold — as a map of
  decision tickets, then resolve them one at a time until the way to the destination
  is clear. Two backends: a local map in a slug folder under `trash/plans/`
  (incubation, no tracker noise), or a shared map on the GitHub issue tracker
  (`wayfinder:map` label, `[MAP] ` title prefix) when several sessions or people
  must coordinate. Use when the user invokes Wayfinder, or asks to chart a large,
  uncertain effort whose route is not yet visible.
metadata:
  keywords: "wayfinder, chart the way, chart a map, map this effort, wayfinder map, decision tickets, work the map, resume the map, frontier ticket, fog of war, too big for one session, plan a large effort, break down an epic, epic into tickets, uncertain effort, find the way, destination and route, promote to issues"
  category: "planning"
  load: "on-demand"
---

# Wayfinder

A loose idea has arrived — too big for one agent session, and wrapped in fog: the way
from here to the **destination** isn't visible yet. Wayfinding is about finding that way,
not charging at the destination. This skill charts the way as a **map**, then works its
**decision tickets** — questions whose resolution is a decision, not slices of a build to
execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes
every ticket. It might be a spec to hand off and iterate on, a decision to lock before
planning starts, or a change made in place like a data-structure migration. The map is
domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done
when the way is clear — nothing material left to decide before someone goes and does the
thing. The pull to just do the work is usually the signal you've reached the edge of the
map and it's time to hand off. An effort can override this in its **Notes** — carrying
execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket has a **name** — its title. In everything the human reads — narration,
the map's Decisions-so-far, the handoff — refer to it by that name, never by a bare id,
number, or slug. A wall of `#347, #348, #349` (or `tickets/audience.md`) is illegible;
names read at a glance. The id and URL don't vanish — a name wraps its link — but they ride
*inside* the name, never stand in for it.

## Two backends

The map is the canonical artifact either way. What differs is where it lives.

| | **Local map** | **Tracker map** |
|---|---|---|
| Home | `trash/plans/<map-slug>/` | GitHub issues, label `wayfinder:map` |
| Identity | filename slug | issue number |
| Blocking | `blocked_by:` frontmatter | native `--add-blocked-by` |
| Frontier | generated section in the map file | `gh issue list` query |
| Audit trail | git history | issue timeline |
| Good for | incubation, private/uncertain scope, solo charting | several sessions or people, visible frontier, cross-links to epics |

**Choose the local backend by default** when the effort is still incubating and the user
has not asked for tracker state. **Choose the tracker backend** when the user names an
issue/epic the map serves, points at an existing map URL, or explicitly wants the effort
scheduled and coordinated. When unsure, ask — one question, then chart.

Do not create GitHub issues, labels, milestones, or branches while charting or working a
**local** map unless the user explicitly asks to promote the effort (see
[Promote when work becomes active](#promote-when-work-becomes-active)).

A local map may be promoted to the tracker later. A tracker map is never demoted.

---

## Local artifact model

Keep the canonical artifacts in this repository:

```text
trash/plans/<map-slug>/
├── <map-slug>.md
├── tickets/
│   ├── <ticket-slug>.md
│   └── ...
└── assets/                  # only when tickets produce supporting artifacts
```

Use lowercase kebab-case slugs. Follow an established repository convention when it is
more specific, but keep every artifact inside the map folder. In Aperio, `trash/plans/`
already holds `write-plan` output (`<slug>/<slug>.md` + `<slug>-tests.md`); a Wayfinder
map is a sibling of those, not a replacement — a map *produces* a plan, and the plan
belongs to the implementation session that follows.

The map file is the canonical index. A ticket file is the canonical record for its
question and resolution. Relative Markdown links connect them. Git history provides the
audit trail; do not duplicate ticket content into the map.

### Map file

Create `trash/plans/<map-slug>/<map-slug>.md`:

````markdown
# <Map name>

## Destination

<What reaching the end of this map looks like. One or two lines; every session orients to
it before choosing a ticket.>

## Notes

<Domain, skills to consult, standing preferences, and any execution override.>

## Route

```mermaid
flowchart LR
  T_a["<ticket name>"] --> T_b["<ticket name>"]
```

## Frontier

- [<open, unblocked, unclaimed ticket name>](tickets/<ticket-slug>.md)

## Decisions so far

- [<resolved ticket name>](tickets/<ticket-slug>.md) — <one-line gist>

## Not yet specified

<In-scope fog that is not precise enough to become a ticket.>

## Out of scope

<Work consciously ruled beyond the destination, with links when a ticket was ruled out.>
````

The **Frontier** is a generated convenience index, not another source of truth. Rebuild it
from ticket metadata whenever ticket status, claims, or dependencies change. (The tracker
backend has no Frontier section — a query produces it live.)

### Ticket files

Create one file per ticket under `tickets/`:

```markdown
---
type: grilling
status: open
blocked_by: []
claimed_by: null
---

# <Ticket name>

## Question

<The decision or investigation this ticket resolves, sized to one agent session.>

## Resolution

<!-- Fill only when resolved. Link supporting files rather than pasting large artifacts. -->
```

Allowed metadata:

- `type`: `research`, `prototype`, `grilling`, or `task`.
- `status`: `open`, `resolved`, or `out-of-scope`.
- `blocked_by`: a list of ticket slugs. Use `[]` when unblocked.
- `claimed_by`: a stable agent/session identifier, or `null` when unclaimed.

The filename slug is the ticket's stable identity. In human-facing prose, refer to the
linked ticket name, never only to its slug. A ticket is unblocked when every slug in
`blocked_by` points to a resolved ticket. The **frontier** is all open, unblocked,
unclaimed tickets.

Claim a ticket by changing `claimed_by` before starting work. Re-read the file immediately
before writing the claim because concurrent sessions may share the repository. If it was
claimed meanwhile, do not overwrite the claim; choose another frontier ticket. Clear the
claim when resolving or abandoning the ticket.

---

## Tracker artifact model

The map is a single issue labelled `wayfinder:map`; its tickets are **child issues** of the
map (GitHub native sub-issues). Aperio's live maps use this backend.

Its title is prefixed **`[MAP] `** — `[MAP] Local-model Git co-pilot — charting the way to
an executable #343`. A tracker accumulates maps, tickets, bugs, and epics in one flat list,
and the label is invisible in notification emails, cross-references, and most compact list
views. The prefix makes a map identifiable as a map from the title text alone.

Use the prefix for *reading*, not for querying: title search tokenises `[MAP]` down to the
bare word, so it collides with any issue whose title says "map" or "mapper". **To enumerate
maps, query the `wayfinder:map` label** — that is exact.

The map is an **index**, not a store. It lists the decisions made and points at the tickets
that hold their detail; a decision lives in exactly one place — its ticket — so the map
never restates it, only gists it and links.

The map body is the same shape as the local map file, minus **Frontier** (a query produces
it) and minus the `# <Map name>` heading (the issue title is the name). Open tickets are
**not** repeated as a prose list — they are open child issues, found by query.

### Labels

Already provisioned in this repo:

| Label | Meaning |
|---|---|
| `wayfinder:map` | the map issue itself |
| `wayfinder:research` | research ticket (AFK) |
| `wayfinder:grilling` | grilling ticket (HITL) |
| `wayfinder:prototype` | prototype ticket (HITL) |
| `wayfinder:task` | task ticket (HITL or AFK) |

Repo-local labels (`muted`, `point-of-interest`) are orthogonal — apply them per repo
convention, not per this skill.

### Verified `gh` operations

These are checked against `gh` 2.96 on this repository. Re-verify before relying on any
flag not listed here.

```bash
# enumerate maps
gh issue list --label wayfinder:map --state all --json number,title

# create the map first — tickets reference it
gh issue create --label wayfinder:map --title "[MAP] <name>" --body-file map.md

# create a ticket as a child of the map, already blocked
gh issue create --parent 345 --label wayfinder:grilling \
  --title "<question>" --body-file ticket.md
gh issue create --parent 345 --blocked-by 350,354 --label wayfinder:grilling ...

# wire relationships after the fact
gh issue edit 351 --add-blocked-by 350 --add-blocking 352
gh issue edit 345 --add-sub-issue 356,357

# claim a ticket — the assignee IS the claim
gh issue edit 348 --add-assignee @me

# the frontier: open children of the map, unassigned, no OPEN blocker
gh issue list --state open --limit 100 \
  --json number,title,parent,assignees,blockedBy \
  -q '.[] | select(.parent.number==345)
          | select((.assignees|length)==0)
          | select([.blockedBy.nodes[]? | select(.state=="OPEN")]|length==0)
          | "\(.number)\t\(.title)"'

# resolve
gh issue comment 348 --body-file resolution.md
gh issue close 348
```

A session **claims** a ticket by assigning it to the dev driving the map, **first**, before
any work, so concurrent sessions skip it. That assignee *is* the claim: an open, unassigned
ticket is unclaimed. Blocking uses the tracker's **native** dependency relationship —
essential because it renders the frontier *visually* in GitHub's own UI, so the human sees
what's takeable without opening the map.

The answer isn't part of the ticket body — it's recorded as a **resolution comment** on
close. Assets created while resolving a ticket are linked from the issue, not pasted in.

### Wave prefixes

*Upstream convention. Aperio's live maps predate it — see [Field notes](#field-notes-from-aperios-live-maps)
before applying it to an existing map.*

Blocking edges encode order in the tracker's *data*, but a human scanning a list of titles
cannot see them. So every ticket title can carry both its parent map and its position in
the route as a prefix: `[#<map-id>W<wave>.<n>] ` — for example
`[#345W2.2] What is the v1 Git operation boundary?`.

The **map id** is there because a wave number alone is ambiguous the moment a repo holds
more than one map — and this repo holds three. Carrying the parent means **every ticket
traces home from its title alone**, with no lookup and no click. It also makes waves
searchable: `<map-id>W<wave>` is a whole token, so a title search for `345W1` returns
exactly that map's wave-1 tickets. A **partial** prefix does not work — trackers match
whole tokens, so `345W` alone returns nothing; to list all of a map's children use the
native child query above.

This is why the map is created **before** its tickets: tickets cannot be titled until the
map has an id.

The **wave** is the ticket's depth in the dependency graph. Every ticket with no *open*
blocker is wave 1; a ticket blocked only by wave-1 tickets is wave 2; in general a ticket's
wave is one more than the highest wave among its open blockers. `<n>` orders tickets
*within* a wave for reading only — a wave's tickets are mutually independent by
construction, so they may be worked in any order, or in parallel by several sessions.
**W1 is the frontier**, W2 is what opens next, and the highest wave is the last thing
standing before the destination.

The prefix is **derived, never authored**. Recompute it from dependency data and retitle
whenever tickets are added, deleted, closed, or rewired — in the same pass that refreshes
the Route diagram. Because waves count only *open* blockers, closing a ticket promotes its
dependents. Retitle only the tickets whose wave actually changed. Where a prefix and the
dependency data disagree, **the dependency data wins** and the prefix is stale.

The local backend has no title prefix — `blocked_by` is visible in the file — but the same
wave computation drives the Route layout.

---

## Route diagrams

**Every map carries a Mermaid Route diagram.** A one-ticket map gets a one-node diagram;
that is fine and still worth drawing, because the diagram is how a human sees the shape of
the effort before reading a word of it. It is non-negotiable when:

- repository instructions require a plan diagram (Aperio's `write-plan` does);
- any ticket has a blocking edge;
- the frontier branches or later converges; or
- three or more tickets are easier to scan as a relationship.

Omit it only for a genuinely flat, tiny map, and state that judgment in the handoff.

Generate the route from ticket files (local) or child/dependency data (tracker) **after**
tickets are created and wired. Never infer topology from creation order. Use stable node
ids, display ticket names rather than bare numbers, and link nodes to their tickets —
Mermaid `click` directives with relative links locally, issue URLs on the tracker — where
the renderer supports it. Lay the graph out by [wave](#wave-prefixes), left to right or as
labelled subgraphs, so the diagram and the titles tell the same story rather than two.
Distinguish frontier, claimed, blocked, and resolved tickets. Show the destination and a
single fog node when useful, but never invent precise tickets or edges for fog. Beyond
roughly 15–20 nodes, split by phase/domain or show the current frontier with its immediate
upstream and downstream context.

Refresh the diagram after any ticket is added, resolved, ruled out, deleted, claimed,
unclaimed, or rewired. Derive it again rather than hand-editing stale topology.

Detailed architecture, sequence, state, and data-flow diagrams belong with the ticket whose
decision they explain. Link them from the map; do not duplicate their decision detail in
the Route. If an animated explanatory diagram would help, use the `animated-sketch-diagram`
skill to produce a **standalone preview for approval** — never integrate or commit a visual
unseen (Aperio's Co-pilot Contract) — and keep the Mermaid Route as the text-based,
diffable map.

## Ticket types

Every ticket is either **HITL** — human in the loop, worked *with* a human who speaks for
themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that
live exchange; the agent never stands in for the human's side of it (a grilling agent that
answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources —
  including the codebase itself — to surface a fact a decision waits on. Resolve with a
  research subagent when the governing instructions permit one; otherwise inline. Use when
  knowledge outside the current head is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough,
  concrete artifact to react to — an outline, a stub, a UI or behaviour sketch. Save it
  under the map's `assets/` folder (local) or attach/link it (tracker). Use when "how
  should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Resolve an ambiguous decision through conversation, one question at
  a time, via `/grilling` and `/domain-modeling` where available. **This is the default.**
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made —
  nothing to decide, prototype, or research, but the discussion is blocked until it's done.
  Signing up for a service so its API can be judged, provisioning access, moving data so
  its shape can be seen. This is the one type that *does* rather than decides — and it
  earns its place by unblocking a decision, not by delivering the destination. The agent
  drives it alone where it can (AFK); otherwise it hands the human a precise checklist
  (HITL). The resolution records what was done and any resulting facts (credential
  location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is *deliberately* incomplete: don't chart what you can't yet see. Beyond the live
tickets lies the **fog of war** — the dim view of decisions you can tell are coming but
can't yet pin down, because they hang on questions still open. Resolving a ticket clears
the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a
time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the
suspected question, the area to revisit later. Everything here is in scope, just not sharp
enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost
for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — *not*
whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act yet.
- **Fog when** you can't yet phrase it that sharply. Don't pre-slice the fog into
  ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several
  tickets, or none, once the frontier reaches it.

Graduate a fog item into one or more tickets once its question becomes precise, then remove
the source item from the fog so it lives only as its new ticket. **Not yet specified**
excludes resolved decisions, live tickets, and out-of-scope work.

## Out of scope

Fog only ever gathers *toward* the destination. The destination fixes the scope, so work
beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet
specified**. Scope, not sharpness, lands it there. Out-of-scope work never graduates — the
frontier stops at the destination — so it returns only if the destination is redrawn, and
then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When an existing
ticket proves out of scope, take it unambiguously off the frontier — `status: out-of-scope`
and clear the claim (local), or close it (tracker) — and leave one linked line in the map's
**Out of scope** section: the gist plus why. Keep it out of **Decisions so far**, which
records the route actually walked; a scope boundary isn't a step on it.

---

## Invocation

Two modes. Either way, **never resolve more than one non-research ticket per session.**

### Chart the map

The user invokes with a loose idea.

1. **Name the destination.** Grill (and domain-model) to pin down what this map is finding
   its way to — the spec, decision, or change. The destination fixes the scope, so it's
   settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole
   space rather than deep on any one thread, surfacing the open decisions, the first steps
   takeable now, and the fog. **If this surfaces no fog** — the way is already clear, the
   whole journey small enough for one session — you don't need a map. Stop and ask the user
   how they'd like to proceed.
3. **Pick the backend** ([Two backends](#two-backends)). For a local map, inspect
   `trash/plans/` for naming conventions and choose a unique slug without disturbing
   existing or unrelated plans. For a tracker map, check `wayfinder:map` for a live map
   that already covers this ground.
4. **Create the map** — Destination and Notes filled in, Decisions-so-far empty, the fog
   sketched into **Not yet specified**. On the tracker this must happen *before* the
   tickets, so they can reference its id.
5. **Create the tickets you can specify now**, then wire blocking in a **second pass**
   (ids/files must exist before they can reference each other). Wiring sorts them into the
   frontier and the blocked; everything you can't yet specify stays in the fog.
6. **Number and draw in a third pass.** Compute each ticket's wave from the wired
   dependency data, apply title prefixes if the map uses them, then generate the Route.
   Derive the Frontier (local) the same way.
7. **Fire the research tickets** in parallel — subagents only where the user or governing
   instructions permit them. Store research output inside the map folder (local) or as a
   resolution comment (tracker), and link it from the ticket.
8. **Stop.** Charting is one session's work; it hand-resolves nothing.

### Work through the map

The user invokes with a map (slug, URL, or number). A ticket is **optional** — without one,
you pick the next decision, not the user.

1. Load the **map** — the low-res view, plus ticket metadata, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier
   ticket in map order. **Claim it before any work**, then refresh a Route that
   distinguishes claimed tickets.
3. Resolve it — **zoom as needed**: fetch the full body of any related or resolved ticket
   on demand; invoke the skills the **Notes** block names. If in doubt, grill.
4. Record the resolution: write the answer under **Resolution** and set `status: resolved`,
   clearing `claimed_by` (local); or post a resolution comment and close (tracker).
5. Append one linked gist under **Decisions so far**. Create newly-surfaced tickets
   (create-then-wire); graduate any fog the answer made specifiable, clearing each
   graduated patch from **Not yet specified**. If the answer reveals a ticket sits beyond
   the destination, **rule it out of scope** rather than resolving it on the route. If the
   decision invalidates parts of the map, update or delete those tickets rather than
   preserving stale topology.
6. Re-read all ticket metadata, **recompute waves, retitle whatever moved**, and regenerate
   the Frontier and Route. Closing a ticket promotes its dependents, so at minimum
   something moved into W1.

The user may run unblocked tickets in parallel, so **expect other sessions to be editing
the map concurrently.** Re-read immediately before you write.

### Promote when work becomes active

Local plans are an incubation backlog. Promote them to GitHub issues only when the user
explicitly decides the effort is ready to schedule or coordinate in the issue tracker.

On promotion:

1. Re-read the map and discard obsolete or already-resolved tickets.
2. Create the map issue first, then remote issues for the remaining actionable tickets
   only, preserving names and re-wiring dependencies with `--parent` / `--add-blocked-by`.
3. Apply `wayfinder:map` and the matching `wayfinder:<type>` labels; add the `[MAP] `
   prefix; compute wave prefixes if the effort will use them.
4. Add remote links to the corresponding local ticket files so local context stays
   discoverable, and note the promotion at the top of the local map.
5. Follow repository rules for retiring or retaining the local plan. **Never silently
   delete it.**

---

## Aperio house rules

These come from `AGENTS.md` and apply to every Wayfinder session in this repository.

- **Concurrent sessions are assumed.** Other agents may hold this repo. Touch only the map
  and ticket you claimed. Never stage, commit, revert, or clean files outside this task —
  including other maps under `trash/plans/`. Preserve a dirty worktree.
- **Never commit another session's work.** Keep any Git operation scoped to the map folder
  you touched, and only when the developer asks this session to commit.
- **No stray state.** Charting and grilling read code; they don't boot servers or MCP
  processes. If a ticket genuinely needs a live run, isolate it (throwaway workdir, scratch
  DB, non-default port), tear it down, and leave nothing in the repo tree.
- **The elenchus runs both ways.** A map often exists because an epic asserts things the
  codebase contradicts. Say so plainly in the resolution, with `file:line` citations.
  Ground truth beats the epic.
- **Fragile Zones** (`lib/config.js`, `db/migrations*`, `lib/context/`,
  `lib/routes/paths.js`, `mcp/index.js` ctx) — a ticket may *decide* about them; ask before
  touching them.
- **Steer by the idea.** When a ticket's answer is locally clever but drifts from recall
  woven into thinking, flag the drift before flying it.
- **Leftovers go to the notes files.** Suggestions to `A2D.md`, code depth to
  `id/reference/tech-debt.md` — announce in one line, then write. Delete on resolution.
- **Hand off, don't hoard.** One ticket per session means the next session is a stranger.
  Save a memory pointer for a live map (per `memory-protocol`): map name + URL/slug,
  destination, current frontier, and any "asked and answered, don't re-raise" decisions.
- **Docs.** A map is planning, so `sync-documentation` usually doesn't fire — but a
  resolution that changes a shipped config key, tool, or security posture does. Check when
  the resolution touches user-facing behaviour.
- **Commit message.** After changing map files, offer a ready-to-use message —
  `docs(wayfinder): ...` for map/ticket edits, `chore(plans): ...` for scaffolding.

## Field notes from Aperio's live maps

Observed on this repo as of 2026-08-11. Treat as ground truth about current practice, not
as aspiration:

- Three live tracker maps: **[MAP] Local-model Git co-pilot** (#345, charting an executable
  rewrite of #343), **[MAP] Multi-turn agent harness** (#355), **[MAP] Specify visible
  agent planning UX** (#361).
- The `[MAP] ` prefix is used **without a colon** here. Match the existing maps; don't
  reformat them.
- **Wave prefixes are not in use** on any live ticket, and the maps carry **no Route
  diagram**. Both are known drift from this skill. Do not mass-retitle or backfill an
  existing map as a side effect of another task — propose it to the developer as its own
  pass.
- Claiming works: #346 was assigned before work and closed with a full resolution comment
  citing `920f9c6`.
- `gh` 2.96 native sub-issues, `--parent`, `--blocked-by`, and `--add-blocked-by` all work
  against this repo; the frontier query above returns #347, #348, #349, #353 for map #345.
- A research ticket resolved with cited `file:line` ground truth is the highest-value
  ticket type here — #346 invalidated four premises of the epic it serves.

## Extending this skill

Known gaps, kept here so the next extension pass starts from a real list rather than a
blank page:

- **Backfill pass.** A documented, idempotent procedure for adding Route diagrams and wave
  prefixes to a map already in flight without churning notifications.
- **Frontier staleness.** Nothing detects a claim abandoned mid-session. A "claimed for
  more than N days" check belongs in the work-through flow.
- **Local↔tracker drift.** After promotion, both copies exist. Decide whether the local map
  becomes a stub pointer, and encode that instead of leaving it to per-session judgment.
- **Map-of-maps.** #345, #355, #361 are unrelated; a repo with interdependent maps needs a
  rule for cross-map blocking.
- **Aperio self-hosting.** Wayfinder maps are exactly the kind of long-lived context
  Aperio's own memory layer should carry. A map pointer as a `self_memory`, or map tickets
  surfaced through `recall`, is the natural next integration.
- **Autotune.** This skill's `metadata.keywords` have never been through the `autotune`
  loop; the eval set has no Wayfinder prompts yet.
- **Invocation guard.** Upstream ships this skill with `disable-model-invocation: true`
  (and an `agents/openai.yaml` carrying `allow_implicit_invocation: false`) so a map can
  only be started deliberately. Aperio's loader has no equivalent flag — here the skill is
  discoverable by keyword match alone. Keep that in mind when tuning keywords: a map is an
  expensive thing to start by accident.
