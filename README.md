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
| `jev` | Runs [jev-gateway](https://github.com/vinilana/jev-gateway) from inside Claude Code: Jev, TypeSafe's fast decision model, picks the next tool on each request, shown live and measured against a baseline. After installing, run `/jev-setup`. | [`jev/`](jev/) |

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
