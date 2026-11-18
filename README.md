# OpenSCAD Studio

Local web GUI for creating, tracking and viewing OpenSCAD projects for 3D printing, driven by either
**agy** or **Claude Code** (each with model selection).

```
X
```

Requires OpenSCAD (`winget install OpenSCAD.OpenSCAD`), Node 18+, and the `agy` and/or `claude` CLIs.

## Features
- Project dashboard: search, status (idea/designing/printing/done/failed), tags, last backend/model.
- Per project: agent chat (choose backend + model per message), live output stream, code editor with
  save & render, 3D STL viewer (orbit, wireframe, bounding-box dimensions), STL download, NOTES.md.
- After each agent run the project is re-rendered to `renders/model.stl` automatically.
- Each project lives in `projects/<slug>/` (`main.scad`, `NOTES.md`, `project.json`, `renders/`) with
  `CLAUDE.md` + `AGENTS.md` giving the agent FDM-printing design rules.
- Conversations continue per backend (`--continue`) inside each project directory.

## Config (optional `config.json`)
`openscad`, `claude`, `agy` (paths; auto-detected), `claudeModels` (aliases or full IDs),
`claudePermissionMode`, `agyMode`, `agentTimeoutMin`. Env: `PORT`.
agy models come from `agy models`.

## agy permissions
agy headless mode can edit files but its command permission is auto-denied, so agy can't run openscad itself (the app renders after each run anyway). To allow it, add `--dangerously-skip-permissions` to `agyExtraArgs` in `config.json` (agent can then run any command).

## Security notes
Binds to 127.0.0.1 only; rejects non-localhost Host headers and cross-origin writes. Agents run
unattended in the project dir (Claude: `acceptEdits` + `Bash(openscad:*)` only; agy: `accept-edits`).

## Launching
Double-click `start.bat` (installs deps on first run, opens the browser; if it's already running it just opens the browser).
Run `powershell -File create-shortcut.ps1` once for a desktop shortcut. Closing the console window stops the server.

## Versions & conversations
- Every agent run and GUI "Save & render" that changes the code is saved to `projects/<slug>/versions/NNN/` (scad files, `model.stl`, prompt, agent reply). See the **History** tab: preview, view code, restore (current state is saved first), or "use as reference".
- Agents are told `versions/` is read-only and only consult it on request. Picking **Reference** in the Agent tab adds a pointer to that version to your prompt.
- **New conversation** starts a fresh agent context for the project (older messages aren't `--continue`d).