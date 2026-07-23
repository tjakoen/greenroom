// pages/editor-page.ts — the /editor page BODY (P4): the grain `code-editor` organism as a
// server-rendered skeleton that a thin client module (pages/editor.js) fills in and wires up.
// No data baked in — everything comes from /api/{tests,test-source,test-versions,test-version,
// validate}. Monaco is lazy-loaded by editor.js from the self-hosted /vs/ mount (server.ts) and
// injected into `.code-editor__mount`, so its weight lands only on THIS page.
//
// The chrome (frame/bar/status/diagnostics/history drawer) is the grain component's — this file
// only supplies the greenroom-specific bits: a file picker in the toolbar and the action buttons.
// data-state / data-dirty / data-history are toggled by editor.js (see the component's .md).
export function editorBody(): string {
  return `<div class="editor-page">
  <header class="board" style="margin-bottom:var(--space-4)">
    <h1 class="masthead">Editor</h1>
    <p class="lede">Edit a Playwright test in the browser with syntax highlighting and inline
      errors, check it compiles before you run it, and keep a version history — no local tooling,
      no code checkout.</p>
  </header>
  <div id="edNotice" class="callout" data-status="strong" hidden></div>

  <div class="code-editor" id="edRoot">
    <div class="code-editor__bar">
      <label class="field" data-size="sm" data-variant="inline" style="margin:0">
        <span class="field__label" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Test file</span>
        <select class="field__select" id="edFile"><option value="">Select a test…</option></select>
      </label>
      <span class="code-editor__title" id="edTitle" hidden></span>
      <span class="code-editor__dirty">• unsaved</span>
      <span class="code-editor__actions">
        <input class="field__input ed-msg" id="edMsg" placeholder="Describe this change (optional)" aria-label="Change message" disabled>
        <button class="btn" data-size="sm" data-variant="soft" type="button" id="edValidate" disabled>Validate</button>
        <button class="btn" data-size="sm" data-variant="soft" type="button" id="edHistory" disabled>History</button>
        <button class="btn" data-size="sm" data-variant="soft" type="button" id="edRun" disabled>Run this</button>
        <button class="btn" data-size="sm" type="button" id="edSave" disabled>Save</button>
      </span>
    </div>

    <div class="code-editor__mount" id="edMount">
      <p class="cat-intro" id="edPlaceholder" style="padding:var(--space-4)">Pick a test above to start editing.</p>
    </div>

    <div class="code-editor__status" id="edStatus">No test loaded</div>
    <div class="code-editor__diagnostics" id="edDiags"></div>

    <aside class="code-editor__history">
      <div class="code-editor__history-head">
        <span style="flex:1">History</span>
        <button class="btn" data-size="sm" data-variant="soft" type="button" id="edHistoryClose">Close</button>
      </div>
      <div id="edVersions"></div>
    </aside>

    <!-- Restore diff overlay (greenroom-specific chrome, styled in greenroom.css): compares a
         chosen version against the current buffer before you restore it. -->
    <div class="ed-diff" id="edDiff" hidden>
      <div class="ed-diff__head">
        <span class="ed-diff__label" id="edDiffLabel">Diff</span>
        <button class="btn" data-size="sm" type="button" id="edDiffRestore">Restore this version</button>
        <button class="btn" data-size="sm" data-variant="soft" type="button" id="edDiffClose">Close</button>
      </div>
      <div class="ed-diff__mount" id="edDiffMount"></div>
    </div>
  </div>
</div>
<script src="/editor.js" defer></script>`;
}
