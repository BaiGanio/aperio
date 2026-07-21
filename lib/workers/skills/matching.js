/**
 * lib/workers/skills/matching.js — keyword-based skill matching and scoring.
 */

// Generic English function words and skill-doc boilerplate. These carry no
// topical signal, but verbose skill descriptions are full of them, so counting
// them lets unrelated skills clear the match threshold ("read the config file"
// scoring xlsx via "file"). Stripped before scoring. Includes 3-letter words:
// keyword tokens use minLen 3, so phrase glue inside curated keywords
// ("approve THE change", "WHAT did I write") would otherwise count as curated
// hits — satisfying the qualifies gate and matching skills on any message that
// contains "the"/"what". Function words inside keyword phrases are exactly
// what this strips; no skill's match may depend on them.
const SKILL_STOPWORDS = new Set([
  "this", "that", "these", "those", "there", "then", "than", "them", "they",
  "their", "your", "yours", "with", "from", "into", "onto", "while", "will",
  "would", "could", "should", "have", "been", "being", "about", "also", "even",
  "just", "like", "only", "very", "much", "many", "some", "such", "more", "most",
  "each", "used", "using", "user", "want", "wants", "need", "needs", "task",
  "tasks", "skill", "skills", "trigger", "triggers", "deliverable", "primary",
  "especially", "instead", "involved", "involving", "regardless", "whenever",
  "anything", "something", "between", "here", "does", "done", "make", "made",
  "both", "input", "output", "content", "proper", "other", "something",
  "the", "and", "for", "are", "was", "has", "can", "did", "not", "you",
  "all", "any", "but", "how", "who", "why",
  "what", "when", "where", "which", "know", "mean",
]);

// Tokens are matched as whole words against the message (see scoreSkill), not
// as substrings — so "api" no longer matches "therapist" and "data" no longer
// matches "database". Curated keywords keep their short, intentional tokens
// (api, csv, ocr, pdf), while prose descriptions stay at >3 chars to suppress
// stray short words.
export function skillTokens(text, minLen) {
  return new Set(
    (text ?? "").toLowerCase().split(/\W+/).filter(w => w.length >= minLen && !SKILL_STOPWORDS.has(w))
  );
}

// Crude suffix fold so inflections of one word count as ONE hit when scoring:
// "write"/"writing" or "test"/"tests"/"testing" are a single topical signal,
// not two — the match threshold means "two independent signals". Strips a
// common verb/plural suffix plus a trailing "e" ("write" and "writing" both
// fold to "writ"). False merges ("caring"/"cars" → "car") only make matching
// stricter, never looser. Folding applies to hit COUNTING only — whether a
// token matches the message is still exact whole-word.
export function foldToken(w) {
  const folded = w.replace(/(?:ing|ed|es|s)$/, "").replace(/e$/, "");
  return folded.length >= 3 ? folded : w;
}

// Curated keywords are authored as comma-separated entries, and many entries
// are phrases whose words are only meaningful together ("create skill",
// "code review", "which file mentions"). Treating the whole field as a bag of
// words lets unrelated prose assemble a match from fragments of different
// phrases. Legacy fields without commas (notably handoff) remain a list of
// independent one-word entries.
export function keywordEntries(text) {
  const raw = (text ?? "").trim().toLowerCase();
  if (!raw) return [];
  const entries = raw.includes(",") ? raw.split(",") : raw.split(/\s+/);
  return entries
    .map(entry => entry.split(/\W+/).filter(Boolean))
    .filter(entry => entry.length > 0);
}

export function containsTokenSequence(messageTokens, phraseTokens) {
  if (phraseTokens.length > messageTokens.length) return false;
  outer: for (let i = 0; i <= messageTokens.length - phraseTokens.length; i++) {
    for (let j = 0; j < phraseTokens.length; j++) {
      if (messageTokens[i + j] !== phraseTokens[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Score a single skill against the message's word set.
 *
 *   score      — count of DISTINCT (deduped, stopword-filtered, suffix-folded)
 *                tokens from the skill's description + keywords present as
 *                whole words in the message. Deduping stops a skill that
 *                repeats "file"/"spreadsheet" in its description from
 *                out-scoring a genuinely relevant one.
 *   qualifies  — gate: a skill that declares curated keywords must match at
 *                least one complete keyword entry. Multi-word phrases must be
 *                contiguous and in order; fragments from separate phrases
 *                cannot assemble a false match. Skills without keywords keep
 *                the legacy description-only behaviour.
 */
export function scoreSkill(skill, msgWords, msgTokens) {
  const kwRaw = (skill.keywords ?? "").trim();
  const entries = keywordEntries(kwRaw);
  const matchedEntries = entries.filter(entry => containsTokenSequence(msgTokens, entry));
  // Only matched entries may contribute score. Once one entry qualified the
  // skill, pulling tokens from every other unmatched phrase recreated the same
  // cross-phrase false positive at the scoring layer.
  const matchedKeywordText = matchedEntries.flat().join(" ");
  const kwHits = [...skillTokens(matchedKeywordText, 3)].filter(t => msgWords.has(t));
  const descHits = [...skillTokens(skill.description, 4)].filter(t => msgWords.has(t));
  const hits = new Set([...kwHits, ...descHits].map(foldToken));
  const qualifies = kwRaw ? matchedEntries.length > 0 : true;
  const keywordScore = new Set(kwHits.map(foldToken)).size;
  return { score: hits.size, keywordScore, qualifies };
}

export function messageTerms(msg) {
  const tokens = msg.split(/\W+/).filter(Boolean);
  return { tokens, words: new Set(tokens) };
}

// Explicit skill names are a strong signal, but mentioning a skill in a
// negative phrase must not activate it (for example, "HTML, not PDF"). Keep
// this deliberately small and local to direct-name matching: ordinary
// keyword scoring already has its own qualification rules.
const SKILL_NEGATION_WORDS = new Set([
  "no", "not", "never", "without", "avoid", "avoiding", "exclude", "excluding",
]);

export function hasPositiveSkillName(msg, name) {
  // The word tokenizer below intentionally drops punctuation, so normalize
  // common negative contractions before apostrophes split them into fragments.
  msg = msg.replace(/\b[a-z]+n['’]t\b/g, "not");
  const tokenMatches = [...msg.matchAll(/[a-z0-9]+/g)];
  // Compare on folded stems so a naturally inflected mention ("these PDFs",
  // "a couple of web searches") still counts as naming the skill. foldToken's
  // 3-char floor keeps short names intact, so "cis" never folds onto "ci".
  const messageTokens = tokenMatches.map(match => foldToken(match[0]));
  const nameTokens = name.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean).map(foldToken);

  for (let i = 0; i < messageTokens.length; i++) {
    if (messageTokens[i] !== nameTokens[0]) continue;

    // Preserve the previous behavior for multi-word names: the name words
    // may be separated by connectors ("reasoning and planning").
    let cursor = i;
    let found = true;
    for (const token of nameTokens.slice(1)) {
      cursor = messageTokens.indexOf(token, cursor + 1);
      if (cursor === -1) {
        found = false;
        break;
      }
    }
    if (!found) continue;

    // Allow short intervening phrases such as "not a PDF" and "avoid using
    // PDF", while preventing a distant earlier negation from swallowing a
    // later independent mention.
    const matchEnd = tokenMatches[cursor].index;
    const clauseStart = Math.max(
      msg.lastIndexOf(".", matchEnd),
      msg.lastIndexOf(",", matchEnd),
      msg.lastIndexOf(";", matchEnd),
      msg.lastIndexOf(":", matchEnd),
      msg.lastIndexOf("!", matchEnd),
      msg.lastIndexOf("?", matchEnd),
    );
    const priorClauseWords = msg
      .slice(clauseStart + 1, matchEnd)
      .match(/[a-z0-9]+/g) ?? [];
    const negated = priorClauseWords
      .slice(-(nameTokens.length + 3))
      .some(token => SKILL_NEGATION_WORDS.has(token));
    if (!negated) return true;
  }
  return false;
}

/**
 * Find the best matching skill for a user message.
 *
 * Priority:
 *   1. Direct name match (hyphen/space normalized)
 *   2. Keyword scoring from description + metadata.keywords (see scoreSkill)
 *
 * @param {string} userMessage
 * @param {Array}  index         Result of loadSkillIndex()
 * @param {number} [threshold]   Min keyword hits to count as a match (default 2)
 * @returns {Object|null}        Best matching skill, or null
 */
export function matchSkill(userMessage, index, threshold = 2) {
  if (!index?.length) return null;

  // Merged/retired stubs declare `load: never` and must never be injected.
  index = index.filter(s => s.load !== "never");

  const msg = userMessage.toLowerCase();

  // 1. Direct name match (normalize hyphens to spaces for flexible matching)
  for (const skill of index) {
    if (hasPositiveSkillName(msg, skill.name)) {
      return skill;
    }
  }

  // 2. Keyword scoring
  const { tokens: msgTokens, words: msgWords } = messageTerms(msg);
  let best = null;
  let bestScore = 0;

  for (const skill of index) {
    const { score, qualifies } = scoreSkill(skill, msgWords, msgTokens);
    if (qualifies && score > bestScore) {
      bestScore = score;
      best = skill;
    }
  }

  return bestScore >= threshold ? best : null;
}

/**
 * Like matchSkill but returns up to `limit` skills whose score meets the
 * threshold, ordered by descending score. A direct name match always wins
 * the first slot. Used when a request legitimately spans multiple domains
 * (e.g. coding-standards + working-with-files).
 *
 * @param {string} userMessage
 * @param {Array}  index
 * @param {Object} [opts]
 * @param {number} [opts.threshold=2]
 * @param {number} [opts.limit=3]
 * @returns {Array} Matched skills, possibly empty.
 */
export function matchSkills(userMessage, index, { threshold = 2, limit = 3 } = {}) {
  if (!index?.length) return [];

  // Merged/retired stubs declare `load: never` and must never be injected.
  index = index.filter(s => s.load !== "never");

  const msg = userMessage.toLowerCase();
  const picked = [];
  const seen = new Set();

  // 1. Direct name matches first (preserve insertion order).
  for (const skill of index) {
    if (hasPositiveSkillName(msg, skill.name)) {
      picked.push({ skill, score: Infinity });
      seen.add(skill.name);
    }
  }

  // 2. Keyword scoring for everything else.
  const { tokens: msgTokens, words: msgWords } = messageTerms(msg);
  const scored = [];
  for (const skill of index) {
    if (seen.has(skill.name)) continue;
    const { score, keywordScore, qualifies } = scoreSkill(skill, msgWords, msgTokens);
    if (qualifies && score >= threshold) scored.push({ skill, score, keywordScore });
  }
  // Prefer the skill with more curated keyword evidence when total evidence
  // ties. Description prose remains useful for ranking, but cannot make a
  // broad base skill outrank a more specific sibling (docx vs docx-advanced).
  scored.sort((a, b) => b.score - a.score || b.keywordScore - a.keywordScore);

  return [...picked, ...scored].slice(0, limit).map(x => x.skill);
}
