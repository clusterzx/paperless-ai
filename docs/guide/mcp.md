# AI agents (MCP server)

← [Documentation](README.md)

Paperless-AI has an MCP server (Model Context Protocol): AI assistants and agents – Claude, Hermes, OpenCode, Cursor, your own agents – search your documents, read them, ask questions about them and, if you allow it, change, delete or add them. You decide for each API key what an agent may do.

## Setting it up

1. *Settings → API keys → New key*. Pick a starting point such as **AI agent, reading** (MCP, read documents, ask & chat) or tick the permissions yourself (see below). Optional: limit the key to some libraries, let it expire, limit its requests per minute.
2. After *Create key*, the dialog shows the configuration for both kinds of clients, ready to copy.
3. Put it into your client.

### Clients that speak MCP over HTTP (Claude Code, Cursor, OpenCode …)

Address `https://paperless-ai.example.com/mcp`, the key as Bearer token:

```json
{
  "mcpServers": {
    "paperless-ai": {
      "type": "http",
      "url": "https://paperless-ai.example.com/mcp",
      "headers": { "Authorization": "Bearer pai_…" }
    }
  }
}
```

Claude Code: `claude mcp add --transport http paperless-ai https://paperless-ai.example.com/mcp --header "Authorization: Bearer pai_…"`

### Clients that start a local program (stdio – Claude Desktop, Hermes …)

Download the bridge from your instance – `https://paperless-ai.example.com/mcp/bridge.mjs`, also linked in the key dialog – and let the client start it (Node.js 18 or newer, nothing else):

```json
{
  "mcpServers": {
    "paperless-ai": {
      "command": "node",
      "args": ["/path/to/paperless-ai-mcp.mjs"],
      "env": { "PAPERLESS_AI_URL": "https://paperless-ai.example.com", "PAPERLESS_AI_API_KEY": "pai_…" }
    }
  }
}
```

Instead of the environment: `--url …`, `--key …` or `--key-file <file>` (`PAPERLESS_AI_API_KEY_FILE`), e.g. for a Docker secret. When the agent runs on the same host as the container: `docker exec -i -e PAPERLESS_AI_API_KEY=pai_… paperless-ai node dist/server/cli.js mcp`.

## Tools

The agent only sees the tools its key may use.

| Tool | What it does | Needs |
| --- | --- | --- |
| `search_documents` | Search with words and the [search syntax](search-and-metadata.md) (`tag:`, `correspondent:`, `created:2024` …), filters, pages | Read documents |
| `get_document` | Metadata, custom fields and the text of a document (long texts in parts) | Read documents |
| `list_labels` | Tags, correspondents, document types or custom fields with their numbers of documents | Read documents |
| `list_libraries` | The libraries and the role in each (built-in archive) | Read documents |
| `ask_documents` | A question answered from the documents with sources, like [Ask your archive](ask-your-archive.md) | Ask & chat |
| `find_similar_passages` | Search by meaning (the AI index) | Ask & chat |
| `update_document` | Title, date, correspondent, type, tags, custom fields, ASN – by name | Change documents (new labels: also Manage labels) |
| `delete_document` | Into the trash | Delete documents |
| `upload_document` | Add a file (base64), with the AI analysis | Upload documents |

Every change appears in the change log of the document under the key's user and can be undone there. `ask_documents` and `find_similar_passages` need *Ask your archive* to be switched on.

## Permissions of API keys

Each key has its own permissions; it can never do more than its user, and in each library the user's role there applies too (viewers cannot change anything, whatever the key says).

| Permission | Allows |
| --- | --- |
| Read documents | documents, their text and files, labels, libraries |
| Change documents | title, date, labels, fields and text of documents; restore from the trash |
| Delete documents | move to the trash, delete for good, delete file versions |
| Manage labels | create, rename, merge and delete tags, correspondents, types and custom fields |
| Upload documents | add documents and new file versions |
| Ask & chat | ask the AI about documents, search by meaning |
| MCP (AI agents) | use the MCP server – its tools follow the permissions above |
| Webhook | the document webhook |
| Administration | settings, users, libraries (administrators only) |

Besides: **libraries** (the key only sees these), **expiry** and **requests per minute** (above the limit the key gets `429 Too many requests` with `Retry-After`). The limits apply to the whole API, not only to MCP.

Keys created before 4.5 that could change documents keep deleting and managing labels (they were part of *Change documents* then).

## Good to know

- The MCP server takes personal API keys only – no sign-in sessions, not the old global key.
- Requests from web pages of other origins are refused.
- Transport: Streamable HTTP (MCP 2025-03-26 to 2025-11-25), answers as JSON, without sessions or server-sent events.
- It works with the built-in archive and with Paperless-ngx as the archive.
