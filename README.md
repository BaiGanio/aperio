<div align="center">
  <img src="docs/assets/mascot/robot-aurora-512.png" alt="Aperio" height="140">
  <h1>Aperio</h1>

  <strong>One brain. Every agent. Nothing forgotten.</strong>

  <p>A self-hosted memory layer and agent runtime for local or cloud AI.</p>

  <p>
    <a href="https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip">Download Aperio-lite</a>
    · <a href="https://github.com/BaiGanio/aperio/wiki">Wiki</a>
    · <a href="https://github.com/BaiGanio/aperio/discussions">Discussions</a>
  </p>
</div>

## What is Aperio?

Aperio keeps memories, conversations, and knowledge available to your AI agents.
It runs locally by default, stores data in SQLite, and exposes the same memory
through a web UI, terminal chat, and MCP-compatible tools.

## Quick start

### Easiest: Aperio-lite

For a guided installation, [download Aperio-lite](https://github.com/BaiGanio/aperio/releases/latest/download/aperio-lite.zip), unzip it, and double-click `START`.

### From source

Requirements: [Node.js 18+](https://nodejs.org/en/download). Docker is optional;
SQLite is the default and needs no separate database server.

```bash
git clone --depth 1 -b dev https://github.com/BaiGanio/aperio.git
cd aperio
npm install
npm run start:local
```

Open [http://localhost:31337](http://localhost:31337) when the server is ready.

On first use, Aperio downloads the local AI engine and model. This may take a
few minutes and several gigabytes of disk space. You do not need to install
llama.cpp separately.

That is enough for a private local setup. The Web UI can configure most other
settings after startup.

## Optional configuration

To configure a provider before starting, create `.env` from the example:

```bash
cp .env.example .env
```

Then set the values you need, for example:

```env
AI_PROVIDER=llamacpp
LLAMACPP_MODEL=unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL
```

Cloud providers require their own API key. Postgres, cloud embeddings, code/doc
graphs, encryption, path permissions, browser access, and other advanced options
are documented in the [advanced guide](docs/advanced-guide.md) and the
[Aperio Wiki](https://github.com/BaiGanio/aperio/wiki).

## Terminal chat

Prefer a terminal? Start a second interface with:

```bash
npm run chat:local
```

It uses the same database and memories as the Web UI.

## MCP and integrations

Aperio exposes memory, wiki, file, code-graph, document, and other tools over
MCP. See the [MCP Tools Guide](https://github.com/BaiGanio/aperio/wiki/MCP-Tools-Guide)
for connection instructions and examples.

## Help

- [Installation and use](https://github.com/BaiGanio/aperio/wiki/How-to-Install-&-Use-Aperio%E2%80%90lite%3F)
- [Troubleshooting](https://github.com/BaiGanio/aperio/wiki/Troubleshooting)
- [Commands](https://github.com/BaiGanio/aperio/wiki/Commands)
- [Architecture and design](https://github.com/BaiGanio/aperio/discussions/24)

## Contributing

```bash
npm test
```

Read the [testing guide](id/reference/testing.md) and the
[contributor/developer notes](docs/advanced-guide.md) before changing the
runtime, database, configuration, or agent loop.

The `id/` folder is where Aperio's own coding agents keep their working
notes: reference docs, plus small "identity" files (`whoami.md`,
`self-nature.md`, `characters/`) that shape how they behave. It is not
user-facing — safe to ignore unless you're curious how the agents that
build Aperio are set up.

## License

[MIT](LICENSE)
