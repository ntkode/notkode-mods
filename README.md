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
| `jev` | Runs [jev-gateway](https://github.com/vinilana/jev-gateway) from inside Claude Code: Jev, TypeSafe's fast decision model, picks the next tool on each request, shown live and measured against a baseline. After installing, run `/jev-setup`. | [jevMod](https://github.com/tone-lotto/jevMod) |

## Adding a plugin

Each plugin lives in its own repository. Add an entry to `.claude-plugin/marketplace.json`:

```json
{
  "name": "my-plugin",
  "description": "One line on what it does",
  "source": { "source": "git-subdir", "url": "https://github.com/<owner>/<repo>.git", "path": "<folder with .claude-plugin/plugin.json>", "ref": "main" }
}
```

- Use the full `https://` URL. The `owner/repo` shorthand clones over SSH, which fails for anyone
  without an SSH key on GitHub.
- For a plugin at the root of its repository, use `{ "source": "github", "repo": "<owner>/<repo>" }`.
- Check it with `claude plugin validate .`, then push. Installed copies are cached by the plugin's
  `version` in its own `plugin.json`, so raise that for each release.
