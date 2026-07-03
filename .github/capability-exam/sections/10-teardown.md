# §10 — Teardown  ·  §11 — Roundtable (optional)

## §10 Teardown — remove the fixture

Every fixture memory is tagged `aperio-exam`. Announce and confirm this one like any other
drill, then run it:

`Recall everything tagged "aperio-exam" and forget each one — clean up the exam fixture.`

✅ The agent recalls by tag and `forget`s the set. Also delete any `scratch/` files created
during the drills, and the Nimbus wiki article if the user doesn't want to keep it.

> Your `aperio-exam-progress` checkpoint lives in the **self**-memory store, which is separate
> from the user's memories — this teardown does **not** remove it. Once the exam is finished,
> `self_update` it to `status:completed` — **don't delete it.** A `completed` (or `abandoned`)
> status is what stops you from prompting the user to take the exam again on later sessions.
> Report a summary: per-section pass / fail / skipped counts.

## §11 Roundtable — multi-agent discussion (not scored)

> Requires `ROUNDTABLE_AGENTS` with ≥2 `provider:model` pairs and `ROUNDTABLE_MAX_ROUNDS` set
> (e.g. `ROUNDTABLE_AGENTS=anthropic:claude-haiku-4-5-20251001,deepseek:deepseek-chat
> ROUNDTABLE_MAX_ROUNDS=2`). If unconfigured, record as skipped.

`Start a roundtable discussion: two models should debate whether Nimbus should switch from NATS to Kafka, given what we know from memory about the original decision.`

✅ The agent spawns a roundtable; each model responds in turn, referencing the NATS decision
from memory. The final output is a synthesized discussion showing both perspectives, with
citations to the source memories.
