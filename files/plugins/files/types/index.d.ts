/** One file Claude read or changed this session, newest first in the list. */
export type Touch = { path: string; how: 'read' | 'edit'; at: number }

/** How pictures are drawn: real pixels (kitty, Ghostty), coloured blocks (any terminal), or picked from the terminal. */
export type ImageMode = 'auto' | 'pixels' | 'blocks'

declare module 'claude-code' {
  interface PluginState {
    files: {
      /** The folder shown, relative to the project root ('' is the root), or absolute outside it. */
      dir: string
      /** The file open in the viewer, absolute; null shows the folder. */
      open: string | null
      /** The folder, or the files Claude touched this session. */
      view: 'tree' | 'touched'
      /** Markdown as source instead of rendered. */
      isRaw: boolean
      /** Dotfiles and gitignored entries shown too. */
      showHidden: boolean
      imageMode: ImageMode
      /** Typed into the filter field: entries whose name holds it. */
      filter: string
      touched: Touch[]
      /** Raised when the open file or folder changed on disk, so the pane draws it again. */
      stamp: number
    }
  }
}
