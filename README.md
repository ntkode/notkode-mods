# notkode-mods

Claude Code plugins and mods by Notkode, in one marketplace.

```
/plugin marketplace add ntkode/notkode-mods
/plugin install <plugin>@notkode-mods
```

Update the list with `/plugin marketplace update notkode-mods`.

## Plugins

| Plugin | What it does | Source |
|---|---|---|
| `jev` | Jev, TypeSafe's fast decision model, picks the tool that fits Claude's next step, and Claude gets it as a hint. Shown live above the prompt, measured against a control group of turns without Jev. After installing, run `/jev-setup`. | [`jev/`](jev/) |
| `files` | A file browser pane: walk the project, read Markdown rendered, see pictures in the terminal, and the files Claude touched this session. Open it with `/files`. | [`files/`](files/) |
| `hig` | Apple's Human Interface Guidelines inside Claude Code: Claude designs with them, each UI edit is checked against them, and an audit pane shows which guidelines your app covers and which are still gaps, with a button to have Claude fix them. Open it with `/hig`. | [`hig/`](hig/) |

## Adding a plugin

Every Notkode mod lives in this repository, one top-level folder per mod (`jev/`, …). The folder
holds the mod's docs and research, and its plugin under `plugins/<plugin>/`. Add an entry to
`.claude-plugin/marketplace.json`:

```json
{
  "name": "my-plugin",
  "description": "One line on what it does",
  "source": "./my-mod/plugins/my-plugin"
}
```

- The path is relative to this repository's root and starts with `./`. Only that plugin folder is
  copied to users' machines, so keep research and private data outside it.
- Check it with `claude plugin validate .`, then push. Installed copies are cached by the plugin's
  `version` in its own `plugin.json`, so raise that for each release.
