```txt
root/
├── mcp/
└── tests/
    ├── mockDb.js             ← shared pg mock + resetMockDb() + lastCall() - MISSING
    ├── mockStore.js          ← shared makeMockStore() factory - MISSING
    ├── tools/
    │   ├── memory.test.js
    │   ├── web.test.js
    │   ├── files.test.js
    │   ├── image.test.js
    └── store/
        ├── store.test.js     ← counts(), listWithoutEmbeddings(), setEmbedding() - MISSING
        └── backfill.test.js  ← backfillTool, runStartupBackfillBranch - MISSING
```

root/
├── skills/
    ├── coding-standards /
    ├── tool-integration /
    ├── .etc /