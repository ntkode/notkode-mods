# files

**A file browser inside Claude Code.** Walk the project in a pane, read Markdown rendered the way
Claude's replies are, code highlighted, and pictures drawn in the terminal. One view lists the
files Claude read or changed this session.

> **Status: v0.1.** Tested with `claude plugin test` (8 of 8) on the terminal and desktop surfaces.
> Picture drawing relies on macOS's `sips` for anything but PNG.

## What it does

- **`/files`** opens the pane at the project root; `/files <folder or file>` opens it there.
- **Folders first**, then files with their sizes. `.git`, `node_modules`, dotfiles and anything
  git ignores are hidden; `h` shows them.
- **Filter**: type in the field to narrow the folder; Enter opens the first match.
- **Markdown** renders the way Claude's replies do, tables included; `r` switches to the source.
  Other text files show as highlighted code. The pane docks 100 columns wide so tables fit; `w`
  switches between wide and narrow.
- **Edit** (`e`): opens the file in your editor, `$VISUAL` or `$EDITOR` when it is one with a window
  of its own (VS Code, Cursor, Zed, Sublime…), else the system's default text editor. The pane
  follows your saves.
- **Files it cannot show** (PDF, archives, audio, video, files over 4 MB, pictures on the desktop
  app) open in their default app as soon as you pick them; `o` opens them again.
- **Pictures** (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP):
  - real pixels in terminals with the kitty graphics protocol (kitty, Ghostty);
  - coloured blocks everywhere else (two pixels per character cell), through macOS's `sips`;
  - `i` cycles `auto` / `pixels` / `blocks`, for when `auto` guesses the terminal wrong.
  - The desktop app's Code tab has no picture element: the picture opens outside instead.
- **Touched** (`t`): every file Claude read (·) or changed (✎) this session, newest first.
- **Live**: the open file or folder is drawn again within about 1.5 s of changing on disk.
- **`a`** adds the open file to the prompt as an `@` mention; **`o`** opens it in its default app.

## Keys

| Where | Key | Does |
|---|---|---|
| folder | `u` | up one folder |
| folder | `t` | files Claude touched (and back) |
| folder | `h` | show or hide ignored and hidden files |
| file | `b` | back to the folder (or the touched list) |
| file | `a` | add to the prompt |
| file | `e` | edit in your editor |
| file | `w` | Markdown: wide or narrow dock |
| file | `r` | Markdown: rendered or source |
| file | `i` | pictures: auto, pixels, blocks |
| file | `o` | open outside Claude Code |

Tab walks the entries and Enter opens one; in fullscreen a click does too. The arrows scroll the
pane. Esc hands the keyboard back to the prompt.

## Limits

- It does not edit inside the pane: `e` hands the file to your editor (terminal editors such as
  vim cannot share the pane's terminal, so the default text editor opens instead).
- "Default app" means the computer Claude Code runs on.
- Files over 4 MB are not opened; text is shown up to about 90,000 characters.
- A folder shows its first 400 entries; the filter reaches the rest.
- Without `sips` (Linux, Windows) only PNG can be drawn, and only as real pixels.

## Install

```
/plugin marketplace add ntkode/notkode-mods
/plugin install files@notkode-mods
```
