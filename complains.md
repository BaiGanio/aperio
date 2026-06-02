There is an urgent request from some of our users. They have mentioned several issues and I'll try to describe them as best as I can.

1. They complain that they face so called "tokens burning". 
   - They do not understand why they have so many tokens loaded at startup. In the image the banned in the UI chat is showing
 "4,581 tokens at startup · · 20 memories" - why? what is loaded? what else is loaded? why exactly this has to be loaded? do really the system needs all those to be loaded - this stays unclear?!?! Also, the use of skills and tools here as edit_file as usage stays unclear?!?!?!
 
2. Here in this log from the terminal it shows that at startup all 20 skills are loaded. why? and the following:
   - [tools] turn=1 profiles=[memory] loaded=6/29 -  what is this? what is this turn 1? what is this profile=memories? what is this 6/29 loaded? what is loaded why? how many times will be loaded?
   -  🎯 Skills matched: conversation-lifecycle, codegraph, memory-learning - are those loades? aren't those loaded with the 20 skill at start? why we need to load them again?
   - [tools] turn=2 profiles=[memory,file-project,codegraph] loaded=14/29 - again memory? isn't this loaded in turn 1? why should we load it once again? wtf?
   - 🎯 Skills matched: conversation-lifecycle, codegraph, memory-learning - those ones again? how many time we load one and the same thing? do we need to load it always?
   - [tools] turn=3 profiles=[memory,file-project,codegraph] loaded=14/29 -  again? someone is burning tokens in purpose!?!?!

   ```txt
   2026-06-02 21:32:20.352 [info]: ✓ Already bootstrapped — starting app.
   2026-06-02 21:32:21.815 [info]: [aperio:db] Using SQLite (zero-config; single-file DB)
   2026-06-02 21:32:21.827 [info]: [sqlite-migrate] Nothing to apply.
   2026-06-02 21:32:21.829 [info]: ✅ Connected to Aperio database (SQLite + sqlite-vec)
   2026-06-02 21:32:21.832 [info]: 📊 Embeddings available (62/62 memories, all wiki) — semantic search active.
   2026-06-02 21:32:21.837 [info]: [agent] model="gemma4:26b" adapter="gemma" thinks=true noTools=false shell=true
   2026-06-02 21:32:21.938 [info]: 📚 Skills loaded: 20
   2026-06-02 21:32:22.601 [info]: 🦙 Ollama already running
   2026-06-02 21:32:22.601 [warn]: 💤 Idle shutdown armed (timeout: 180 s after closing the browser tab)
   2026-06-02 21:32:22.601 [info]: 🤖 Provider: Ollama (gemma4:26b) · thinking via gemma
   2026-06-02 21:32:22.601 [info]: ✅ MCP server connected
   2026-06-02 21:32:23.585 [info]: 🎯 Skills matched: conversation-lifecycle
   2026-06-02 21:32:23.585 [info]: [tools] turn=1 profiles=[memory] loaded=6/29
   2026-06-02 21:34:14.883 [info]: 🎯 Skills matched: conversation-lifecycle, codegraph, memory-learning
   2026-06-02 21:34:14.883 [info]: [tools] turn=2 profiles=[memory,file-project,codegraph] loaded=14/29
   2026-06-02 21:39:02.828 [info]: 🎯 Skills matched: conversation-lifecycle, codegraph, memory-learning
   2026-06-02 21:39:02.829 [info]: [tools] turn=3 profiles=[memory,file-project,codegraph] loaded=14/29
   2026-06-02 21:43:29.067 [info]: 🎯 Skills matched: conversation-lifecycle
   2026-06-02 21:43:29.067 [info]: [tools] turn=4 profiles=[memory] loaded=6/29
   ```

   ---
   You task is to make a full audit of the token usage and find any logic gaps, code issues and duplications, pointless calls and loads of skills and tools.
   You should provide a end-to-end plan how to solve the issues you'll find. We can't leave the users with the feeling that we rob them while we provide them a tool in their favor. The user should know on each step how much tokens are consumed.. as there is a feeling that the calculation we show is not accurate, but it could be because of the above issues. 