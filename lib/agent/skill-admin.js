// Skill management surface (the Skills admin UI + autocomplete).
//
// Extracted from lib/agent/index.js. These are the read/write operations over
// the skill index and the writable user overlay — deliberately separate from
// the matching/injection path that runs inside a turn (ensureTurn →
// getSkillPrompts), which stays in the agent factory because it is entangled
// with turn state.
//
// The index is reassigned in place by the factory whenever an overlay is
// written, so this module reads it through getSkillIndex() rather than
// capturing the array — a stale capture would silently serve pre-edit skills.

import {
  writeOverlaySkill,
  deleteOverlaySkill,
  isValidSkillSlug,
} from "../workers/skills.js";

const LOAD_MODES = ["always", "on-demand", "never"];

/** Strip the YAML frontmatter block, leaving the editable/injectable body. */
function stripFrontmatter(content) {
  return (content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * @param {object} deps
 * @param {() => Array} deps.getSkillIndex  Reads the factory's live skill index.
 * @param {() => Array} deps.reloadSkills   Rebuilds the index after an overlay write.
 * @param {string} deps.overlayDir          Writable user-override directory.
 */
export function createSkillAdmin({ getSkillIndex, reloadSkills, overlayDir }) {
  const find = (name) => getSkillIndex().find((s) => s.name === name);

  /** Editable payload for a single skill (body with frontmatter stripped + fields). */
  function getSkillForEdit(name) {
    const s = find(name);
    if (!s) return null;
    return {
      name: s.name, description: s.description || "", keywords: s.keywords || "",
      load: s.load, body: stripFrontmatter(s.content), source: s.source,
      overridden: !!s.overridden,
    };
  }

  return {
    getSkillForEdit,

    getSkillDoc(name) {
      const s = find(name);
      if (!s) return null;
      return { name: s.name, content: stripFrontmatter(s.content) };
    },

    /** Returns all indexed skill names + descriptions (for autocomplete UIs). */
    getSkillList() {
      return getSkillIndex()
        .filter((s) => s.load !== "never")
        .map((s) => ({ name: s.name, description: s.description || "" }));
    },

    /** Full skill list for the management UI — includes disabled ones, with flags. */
    getSkillsForManagement() {
      return getSkillIndex()
        .map((s) => ({
          name: s.name,
          description: s.description || "",
          load: s.load,
          source: s.source,            // "bundled" | "user"
          overridden: !!s.overridden,  // user overlay shadows a shipped skill
          disabled: s.load === "never",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    /** Write a user overlay (create or edit) and hot-reload the index. */
    saveSkill({ name, description = "", keywords = "", load = "on-demand", body = "" }) {
      if (!isValidSkillSlug(name)) throw new Error("Skill name must be lowercase letters, numbers and hyphens.");
      if (!LOAD_MODES.includes(load)) throw new Error(`Invalid load value: ${load}`);
      writeOverlaySkill(overlayDir, { name, description, keywords, load, body });
      reloadSkills();
      return getSkillForEdit(name);
    },

    /** Flip a skill's load mode (always / on-demand / never) without re-sending
     *  its body — used by the always-on switch. Preserves the current content. */
    setSkillLoad(name, load) {
      if (!LOAD_MODES.includes(load)) throw new Error(`Invalid load value: ${load}`);
      const s = find(name);
      if (!s) throw new Error(`Skill not found: ${name}`);
      writeOverlaySkill(overlayDir, {
        name: s.name, description: s.description, keywords: s.keywords,
        load, body: stripFrontmatter(s.content),
      });
      reloadSkills();
      return getSkillForEdit(name);
    },

    /**
     * "Remove" a skill. A user-created skill (no bundled original) is deleted
     * outright; a shipped skill can't be removed from disk, so it's disabled via
     * an overlay (load: never) that hides it from matching + autocomplete but
     * stays restorable.
     */
    deleteSkill(name) {
      const s = find(name);
      if (!s) throw new Error(`Skill not found: ${name}`);
      const hasBundled = s.source === "bundled" || s.overridden;
      if (hasBundled) {
        writeOverlaySkill(overlayDir, {
          name: s.name, description: s.description, keywords: s.keywords,
          load: "never", body: stripFrontmatter(s.content),
        });
      } else {
        deleteOverlaySkill(overlayDir, name);
      }
      reloadSkills();
      return { removed: !hasBundled, disabled: hasBundled };
    },

    /** Reset a shipped skill back to its bundled default by dropping the overlay. */
    resetSkill(name) {
      deleteOverlaySkill(overlayDir, name);
      reloadSkills();
      return getSkillForEdit(name);
    },
  };
}
