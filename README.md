# beook-mcp

An MCP server that lets Claude open, read and answer exercises in the [beook](https://beook.ch) desktop app.

Unofficial, not affiliated with ionesoft or any publisher. The AI's answers can be wrong.

## Setup

Requires Windows, the beook app, and Node.js 22.13 or newer.

```bash
git clone https://github.com/MarcBlattmann/beook-mcp.git
cd beook-mcp && npm install
claude mcp add beook --scope user -- node --no-warnings /path/to/beook-mcp/src/index.js
```

Then ask Claude something like "Solve the open exercises in chapter 2 of my workbook."

## Tools

| Tool | Purpose |
| --- | --- |
| `beook_launch` / `beook_status` | Start beook with the debug port and check its state |
| `beook_list_books` / `beook_list_exercises` | Browse books, chapters and exercises |
| `beook_open_exercise` / `beook_read_exercise` | Open an exercise and read it with marked answer fields |
| `beook_fill_answers` | Fill in text, choice, dropdown, drag & drop and ordering answers |
| `beook_screenshot` / `beook_click` | For drawing and image exercises |

## How it works

beook shows its pages in a built-in Chromium. The server starts beook with
`-Dchromium.remote_debugging_port=9222`, reads exercises through that port, and fills answers the
way the app does, so beook saves and syncs them itself.

While beook runs this way, any program on your PC can control it. Restart beook normally when you're done.

## License

MIT
