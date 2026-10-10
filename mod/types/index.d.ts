// What the mod's panes draw from, kept by the host for the session ($.state): a reload of the module loses none of it.
// Every pane has `frame`, the count its timer adds to while something moves, and `at`, the frame its last change began.

/** The router pane: the test request to Jev, what the pane last said, and the figures its bars grow from. */
export type PlusPlusRouter = {
  frame: number
  at: number
  /** The figures as they stood before the last change, by name: a bar grows from here to its value. */
  from: Record<string, number>
  test: { phase: 'idle' | 'running' | 'ok' | 'fail'; cls?: string; ms?: number }
  said: string
}

/** The spec browser: the record selected, the records unfolded, the filter, and the first row its window shows. */
export type PlusPlusSpecs = {
  frame: number
  at: number
  sel: string
  open: string[]
  filter: string
  /** Whether the filter is what the person typed into the field: the field is then left as they have it. */
  typed: boolean
  top: number
  /** The record a person just accepted or dropped, marked for a moment. */
  flash: string
  busy: '' | 'accepting' | 'dropping'
  said: string
  /** The record a first press of drop asked about: a second press drops it, anything else takes the question back. */
  armed: string
}

/** The code-graph dialog: how far the download is. */
export type PlusPlusSetup = {
  frame: number
  phase: 'ask' | 'download' | 'verify' | 'unpack' | 'done' | 'failed'
  /** Bytes on disk, and the bytes the server announced (0 when it did not). */
  got: number
  of: number
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'plusplus': { router: PlusPlusRouter; specs: PlusPlusSpecs; setup: PlusPlusSetup }
  }
}
