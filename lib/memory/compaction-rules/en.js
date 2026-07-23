// lib/memory/compaction-rules/en.js
// English deterministic compaction rule pack for the memory-compaction EPIC
// (#286, WS1). Three intensity tiers, each an ordered [pattern, replacement]
// array. Rules are fixed, literal, multi-word discourse phrases — never
// generic single-word trimming — so a proper noun can only be damaged if it
// happens to spell one of these exact phrases (see compact.js's masking pass
// for the other half of that safety story: numbers/paths/URLs/code/quoted
// strings never reach these patterns at all).

export const TIER_1_FILLER = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bat this point in time\b/gi, "now"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bin the event that\b/gi, "if"],
  [/\bin spite of the fact that\b/gi, "although"],
  [/\ba (?:large|significant) (?:number|amount) of\b/gi, "many"],
  [/\bplease note that\s*/gi, ""],
  [/\bit is important to note that\s*/gi, ""],
  [/\bkeep in mind that\s*/gi, ""],
  [/\bit should be noted that\s*/gi, ""],
];

export const TIER_2_CONTEXT = [
  [/\bvery\s+/gi, ""],
  [/\breally\s+/gi, ""],
  [/\bquite\s+/gi, ""],
  [/\brather\s+(?!than\b)/gi, ""],
  [/(^|\. )Additionally,\s*/g, "$1"],
  [/(^|\. )Furthermore,\s*/g, "$1"],
  [/(^|\. )Moreover,\s*/g, "$1"],
  [/(^|\. )Actually,\s*/g, "$1"],
  [/(^|\. )Basically,\s*/g, "$1"],
];

export const TIER_3_STRUCTURAL = [
  [/(^|\. )To summarize,\s*/g, "$1"],
  [/(^|\. )In summary,\s*/g, "$1"],
  [/(^|\. )To sum up,\s*/g, "$1"],
  [/(^|\. )Overall,\s*/g, "$1"],
  [/(^|\. )All in all,\s*/g, "$1"],
];

export const RULE_PACK = [TIER_1_FILLER, TIER_2_CONTEXT, TIER_3_STRUCTURAL];
