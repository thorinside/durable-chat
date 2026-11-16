# Copying out of the transcript

## Diagnosis and transport

The old dashboard had two independent OSC 52 writes (mouse selection and `y` answer copy).
Both reported success immediately. Selection could highlight correctly and disappear even when
Apple Terminal ignored the clipboard escape. The toolkit's fullscreen copier also documents this
failure mode; terminal image/color/hyperlink capabilities do not establish clipboard support.
No clipboard receipt can be inferred from a successful stdout write.

Both actions now share one transport:

- Local, interactive macOS: toolkit `getNativeClipboard().setText`, falling back to
  `/usr/bin/pbcopy` when the optional writer is missing or fails. Neither path reads the clipboard.
  `pbcopy` receives UTF-8 stdin, no content arguments, no shell, and a three-second process timeout.
  The locale is explicitly UTF-8, as required by `man pbcopy`. Completion requires a successful
  helper write or zero process exit without a stdin error, not just starting a process.
- Local macOS tmux: the same native route; it does not depend on OSC 52 forwarding.
- SSH (`SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY`): skip native writers and pbcopy, which would
  otherwise change the **remote host's** clipboard. Use OSC 52 when the terminal is not known to
  be Apple Terminal. Remote terminal identity is often absent, so unsupported clients cannot
  always be recognized. Copied text is base64-encoded; tmux sequences use its DCS passthrough
  envelope. The terminal must allow clipboard writes, and tmux must allow passthrough. No tmux
  settings are changed or probed.
- Other platforms: retain OSC 52 without claiming delivery. Non-TTY output is rejected.

A successful local write clears selection. Failures and unacknowledged OSC 52 submissions retain
it until another gesture, viewport/content change, or navigation invalidates its coordinates.
This does not promise which app eventually receives a paste or verify clipboard contents.
SSH detection relies on environment markers; unusual launchers that remove those markers are
not automatically detectable. Native GUI clipboard availability inside a detached/headless Mac
session is not guaranteed.

## Whitespace contract

Copy bounds are carried from transcript formatting through viewport slicing separately from the
padded/background-painted display rows. Serialization intersects selected cells with those bounds:

- Exclude the blank continuation speaker gutter, the outer blank before a visible speaker label,
  expanded-tool gutters, and right-side ASCII-space cell fill. Keep visible labels when selected.
- Inside code blocks, exclude enclosing quote/list rails and gutters and the displayed opening/
  closing fences, even when the gesture touches them. Preserve literal rail characters **in code**,
  source indentation, empty code rows, and selected whitespace-only code rows. The Markdown theme
  disables the toolkit's extra two-column code indent; the speaker gutter still displays.
- Keep spaces between text, including a selection ending in spaces **inside** a rendered line.
  Do not call `trim()` or `trimEnd()` on each selected substring.
- Rejoin adjacent soft-wrapped fragments of the **same code source line**, restoring spaces that
  word wrapping dropped between those fragments. Preserve real code newlines. Partial and reverse
  selections still copy only their selected range. Wide and combining graphemes are copied whole
  when the endpoint falls inside a cell. Prose still copies rendered row boundaries.
- Code trailing spaces are preserved when present inside the semantic code span, not confused
  with pane fill. Spaces removed by the toolkit at a wrapped line's final right edge are still
  omitted; a source-only tail has no selectable cells. Prose right-edge ASCII spaces remain
  indistinguishable from fill and are omitted.

Code identity comes from the toolkit's `codeBlock` / `codeBlockBorder` theme callbacks, not a regex
that strips rail characters. Temporary internal OSC 8 annotations let the toolkit carry that identity
through its own wrapping (including quote/list nesting). The annotations are consumed immediately
into per-row source offsets and bounds, before rendering, hyperlink hit testing or copy. They are
never emitted to the terminal. Source ranges that cannot be matched fall back to rendered-row copy
with code-only bounds, rather than guessing.

This is **not byte-exact Markdown/source export**: the toolkit normalizes tabs to three spaces,
normalizes Markdown container indentation and line endings, and does not expose the original final
code newline. Wrapped terminal whitespace may be lost as noted above. Extremely narrow panes where
nested list/quote prefixes leave no room for a whole grapheme can produce extra toolkit rows and
cannot promise exact reconstruction; widen the pane first. Selection covers only visible rows, not
unselected/offscreen code. The `y` answer action bypasses display serialization and retains the full
underlying answer, including Markdown fences, tabs and trailing whitespace.

## Optional manual verification (not run by automated checks)

**These steps replace the clipboard. Run only with the user's permission**, using a disposable
conversation with synthetic text and a scratch text editor. Do not read or log existing clipboard
contents, inspect personal session history, or run terminal escape probes.

1. In Apple Terminal and Ghostty, select prose and a multiline code block with a nested two-space
   indent, an empty line, and `界é🙂`. Paste into the scratch editor. Confirm only transcript text
   was copied, with indentation/blank lines intact and without continuation gutters/right fill.
2. Use a long synthetic command (for example `curl --header "界é🙂" --data "one  two" https://example.test/a/long/path --flag END`)
   that visibly wraps. Select across all its fragments and paste into the scratch editor: it should
   be one command line, with spaces between arguments intact. Include a real next code line and
   confirm that newline remains. Repeat after resizing, and reverse-drag from partway through the
   last fragment to partway through the first; only that code range should copy.
3. Repeat inside a quoted or list-nested code block, touching the rails and displayed fences at
   the gesture endpoints. Neither should paste. Include a literal `│` in the code: that must paste.
   Also select part of a line ending in the internal double space of `one  two`; both spaces remain.
4. Check that the local write clears the highlight, and `y` outside the composer copies the complete
   answer (including Markdown), using the same native transport. Repeat inside local tmux.
5. Optional SSH check: confirm no native write is attempted on the remote Mac. An OSC 52 submission
   must be labeled unconfirmed and must not clear the highlight, even if a supporting client actually
   accepts it. Known Apple Terminal clients should receive the unsupported-transport notice.
6. For a native Apple Terminal workaround, Command-R toggles **Allow Mouse Reporting**. With it off,
   use terminal selection and Command-C; Option-drag selects a rectangular block. Restore reporting
   afterward. This bypasses dchat cleanup, so rectangle padding or adjacent panes may still copy.

Apple's [Terminal keyboard shortcuts](https://support.apple.com/guide/terminal/keyboard-shortcuts-trmlshtcts/mac)
document Command-R, Command-C and Option-drag. Do not substitute an assumed Shift-drag convention
from another terminal.

Automated coverage uses mocked native helpers, child processes and escape sinks, plus synthetic
transcripts routed through the actual TUI mouse decoder. It does not access a real clipboard or
prove terminal receipt.
