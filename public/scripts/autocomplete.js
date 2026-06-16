// ── Autocomplete: /skill and @ ───────────────────────────────────
(function initAutocomplete() {
  const inputBar = document.querySelector(".input-bar");
  if (!inputBar || !window.chatInput) return;

  // Create dropdown element
  const dropdown = document.createElement("div");
  dropdown.className = "autocomplete-dropdown";
  dropdown.id = "autocompleteDropdown";
  inputBar.appendChild(dropdown);

  const state = {
    mode: null,
    query: "",
    items: [],
    selectedIdx: -1,
    triggerStart: -1,
    fetchId: 0,
  };

  function hideDropdown() {
    dropdown.classList.remove("active");
    state.mode = null;
    state.items = [];
    state.selectedIdx = -1;
    state.query = "";
    state.triggerStart = -1;
  }

  function renderItems() {
    dropdown.innerHTML = "";
    if (state.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "autocomplete-empty";
      empty.textContent = state.mode === "skill"
        ? (state.query ? "No matching skills" : "Type to search skills\u2026")
        : (state.query.length < 2 ? "Type at least 2 characters\u2026" : "No matching files");
      dropdown.appendChild(empty);
      return;
    }
    for (let i = 0; i < state.items.length; i++) {
      const item = state.items[i];
      const div = document.createElement("div");
      div.className = "autocomplete-item" + (i === state.selectedIdx ? " selected" : "");
      const icon = document.createElement("span");
      icon.className = "autocomplete-icon";
      icon.textContent = state.mode === "skill" ? "\u26a1" : (item.isDir ? "\ud83d\udcc1" : "\ud83d\udcc4");
      const name = document.createElement("span");
      name.className = "autocomplete-name";
      name.textContent = item.name;
      div.appendChild(icon);
      div.appendChild(name);
      if (state.mode === "skill" && item.description) {
        const desc = document.createElement("span");
        desc.className = "autocomplete-desc";
        const s = item.description.split(/\.\s/)[0] + ".";
        desc.textContent = s.length > 60 ? s.slice(0, 57) + "\u2026" : s;
        div.appendChild(desc);
      }
      const idx = i;
      div.addEventListener("mousedown", function (e) { e.preventDefault(); selectItem(idx); });
      dropdown.appendChild(div);
    }
    dropdown.classList.add("active");
  }

  function selectItem(idx) {
    var item = state.items[idx];
    if (!item) return;
    var text = window.chatInput.value;
    if (state.mode === "skill") {
      var before = text.slice(0, state.triggerStart);
      var afterSlash = text.slice(state.triggerStart);
      var afterName = afterSlash.replace(/^\/skill\s+\S*/, "");
      var replacement = "/skill " + item.name;
      window.chatInput.value = before + replacement + (afterName.startsWith(" ") ? "" : " ") + afterName.trimStart();
      window.chatInput.setSelectionRange(before.length + replacement.length + 1, before.length + replacement.length + 1);
    } else {
      var before = text.slice(0, state.triggerStart);
      var afterAt = text.slice(state.triggerStart);
      var afterName = afterAt.replace(/^@\S*/, "");
      var replacement = "@" + item.name;
      window.chatInput.value = before + replacement + (afterName.startsWith(" ") ? "" : " ") + afterName.trimStart();
      window.chatInput.setSelectionRange(before.length + replacement.length + 1, before.length + replacement.length + 1);
    }
    hideDropdown();
    window.chatInput.focus();
    window.autoResize();
    window.sendBtn.disabled = window.chatInput.value.trim() === "";
  }

  async function fetchItems(mode, query) {
    state.fetchId++;
    var fetchId = state.fetchId;
    state.selectedIdx = -1;
    var url = mode === "skill" ? "/api/skills" : "/api/files?q=" + encodeURIComponent(query);
    try {
      var resp = await fetch(url);
      if (fetchId !== state.fetchId) return;
      var data = await resp.json();
      if (fetchId !== state.fetchId) return;
      var items = mode === "skill"
        ? (data.skills || []).filter(function (s) { return s.name.toLowerCase().includes(query.toLowerCase()); }).slice(0, 10)
        : (data.files || []).slice(0, 10);
      state.items = items;
      renderItems();
    } catch (e) {
      state.items = [];
      renderItems();
    }
  }

  window.checkAutocompleteTrigger = function () {
    var text = window.chatInput.value;
    var pos = window.chatInput.selectionStart;
    var slashMatch = text.slice(0, pos).match(/(?:^|\s)(\/skill\s+)([a-zA-Z][a-zA-Z0-9-]*)$/);
    if (slashMatch) {
      var query = slashMatch[2];
      var triggerStart = slashMatch.index + slashMatch[1].length - ("/skill ".length);
      if (state.mode !== "skill" || state.query !== query) {
        state.mode = "skill";
        state.query = query;
        state.triggerStart = triggerStart;
        fetchItems("skill", query);
      }
      return;
    }
    var atMatch = text.slice(0, pos).match(/(?:^|\s)(@)(\S*)$/);
    if (atMatch) {
      var query = atMatch[2];
      var triggerStart = atMatch.index + atMatch[1].length - 1;
      if (state.mode !== "file" || state.query !== query) {
        state.mode = "file";
        state.query = query;
        state.triggerStart = triggerStart;
        if (query.length >= 2) { fetchItems("file", query); }
        else { state.items = []; renderItems(); }
      }
      return;
    }
    if (state.mode) hideDropdown();
  };

  window.handleAutocompleteKeydown = function (e) {
    if (!dropdown.classList.contains("active")) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); state.selectedIdx = Math.min(state.selectedIdx + 1, state.items.length - 1); renderItems(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); state.selectedIdx = Math.max(state.selectedIdx - 1, 0); renderItems(); return true; }
    if (e.key === "Enter" || e.key === "Tab") {
      if (state.selectedIdx >= 0 && state.items.length > 0) { e.preventDefault(); selectItem(state.selectedIdx); return true; }
      if (state.items.length === 1 && e.key === "Tab") { e.preventDefault(); selectItem(0); return true; }
    }
    if (e.key === "Escape") { e.preventDefault(); hideDropdown(); return true; }
    return false;
  };

  document.addEventListener("click", function (e) {
    if (!dropdown.contains(e.target) && e.target !== window.chatInput) hideDropdown();
  });

  window.chatInput.addEventListener("blur", function () {
    setTimeout(function () { if (!dropdown.contains(document.activeElement)) hideDropdown(); }, 150);
  });
})();
