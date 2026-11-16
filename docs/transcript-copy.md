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
- Keep source code indentation. The Markdown theme disables the toolkit's extra two-column code
  indent so it is not confused with source indentation; the existing speaker gutter still displays.
- Keep spaces between text, including a selection ending in spaces **inside** a rendered line.
  Do not call `trim()` or `trimEnd()` on each selected substring.
- Retain selected row boundaries and blank rows; do not collapse or join wrapped lines. Wide and
  combining graphemes are copied whole when the endpoint falls inside a cell.
- Right-edge ASCII spaces, including source trailing spaces indistinguishable from rendered fill,
  are omitted. This is rendered-text copy, not a source-preserving Markdown export. The `y` answer
  action bypasses display serialization and retains the full underlying answer.

## Optional manual verification (not run by automated checks)

**These steps replace the clipboard. Run only with the user's permission**, using a disposable
conversation with synthetic text and a scratch text editor. Do not read or log existing clipboard
contents, inspect personal session history, or run terminal escape probes.

1. In Apple Terminal and Ghostty, select prose and a multiline code block with a nested two-space
   indent, an empty line, and `界é🙂`. Paste into the scratch editor. Confirm only transcript text
   was copied, with indentation/blank lines intact and without continuation gutters/right fill.
2. Select part of a line ending in the internal double space of `one  two`. Confirm that the chosen
   two spaces remain. Resize and repeat, including a reverse-direction selection across panes.
3. Check that the local write clears the highlight, and `y` outside the composer copies the complete
   answer (including Markdown), using the same native transport. Repeat inside local tmux.
4. Optional SSH check: confirm no native write is attempted on the remote Mac. An OSC 52 submission
   must be labeled unconfirmed and must not clear the highlight, even if a supporting client actually
   accepts it. Known Apple Terminal clients should receive the unsupported-transport notice.
5. For a native Apple Terminal workaround, Command-R toggles **Allow Mouse Reporting**. With it off,
   use terminal selection and Command-C; Option-drag selects a rectangular block. Restore reporting
   afterward. This bypasses dchat cleanup, so rectangle padding or adjacent panes may still copy.

Apple's [Terminal keyboard shortcuts](https://support.apple.com/guide/terminal/keyboard-shortcuts-trmlshtcts/mac)
document Command-R, Command-C and Option-drag. Do not substitute an assumed Shift-drag convention
from another terminal.

Automated coverage uses mocked native helpers, child processes and escape sinks, plus synthetic
transcripts routed through the actual TUI mouse decoder. It does not access a real clipboard or
prove terminal receipt.
