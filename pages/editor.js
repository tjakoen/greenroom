'use strict';
// pages/editor.js — the thin client behind /editor (P4). Plain dependency-free browser JS (no
// bundler, no TS), same pattern as pages/tests.js. Lazy-loads Monaco from the self-hosted /vs/
// mount (server.ts) into the grain code-editor organism's `.code-editor__mount`, and talks to
// /api/{tests,test-source,test-versions,test-version,validate}.
//
// Validation is layered (plans/platform.md §5): Monaco gives live squiggles here (layer 1); Save
// is gated by the server parse guard (layer 2, PUT /api/test-source); the Validate button runs the
// real `playwright test --list` compile (layer 3, POST /api/validate). Server diagnostics from
// layers 2/3 are painted back as Monaco markers so both surfaces agree.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Never rejects: a transport failure or a non-JSON body (a 302/500 HTML page) resolves to a
  // defined {status,j} so every caller's status/notice() handling still runs instead of throwing
  // an unhandled rejection that silently wedges the editor.
  const api = (path, opts) =>
    fetch(path, opts)
      .then((r) => r.json().then((j) => ({ status: r.status, j })).catch(() => ({ status: r.status, j: {} })))
      .catch(() => ({ status: 0, j: { error: 'Network error — could not reach the server.' } }));

  const root = $('edRoot');
  const els = {
    file: $('edFile'), title: $('edTitle'), mount: $('edMount'), placeholder: $('edPlaceholder'),
    status: $('edStatus'), diags: $('edDiags'), versions: $('edVersions'), notice: $('edNotice'),
    save: $('edSave'), validate: $('edValidate'), history: $('edHistory'), historyClose: $('edHistoryClose'),
    msg: $('edMsg'), run: $('edRun'),
    diff: $('edDiff'), diffLabel: $('edDiffLabel'), diffMount: $('edDiffMount'),
    diffRestore: $('edDiffRestore'), diffClose: $('edDiffClose'),
  };

  // ---- state ----
  let editor = null;          // the Monaco editor instance (created on first file open)
  let model = null;           // its text model
  let currentFile = '';       // repo-relative spec path being edited
  let savedSource = '';       // last-persisted source, for the dirty check
  let monacoPromise = null;   // memoised loader
  let diffEditor = null;      // lazily-created Monaco diff editor (restore overlay)
  let pendingRestore = '';    // the version source the overlay's Restore button will apply

  const setState = (s) => { if (s) root.dataset.state = s; else root.removeAttribute('data-state'); };
  const setDirty = (d) => root.dataset.dirty = d ? 'true' : 'false';
  const status = (msg) => { els.status.textContent = msg; };
  function notice(msg) {
    if (!msg) { els.notice.hidden = true; return; }
    els.notice.textContent = msg; els.notice.hidden = false;
  }

  // ---- Monaco lazy-load (classic AMD self-host, proven in spike/monaco) ----
  function loadMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vs/loader.js';
      s.onload = () => {
        // eslint-disable-next-line no-undef
        require.config({ paths: { vs: '/vs' } });
        // eslint-disable-next-line no-undef
        require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
      };
      s.onerror = () => reject(new Error('Failed to load the editor.'));
      document.head.appendChild(s);
    }).then((monaco) => { configureMonaco(monaco); return monaco; });
    return monacoPromise;
  }

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function configureMonaco(monaco) {
    // An on-brand light theme matching grain's Sourdough paper/ink tokens (memory: restrained pro
    // SaaS, not "AI vibe") — restrained syntax colours, warm-paper surface. Dark falls back to vs-dark.
    monaco.editor.defineTheme('greenroom', {
      base: 'vs', inherit: true,
      rules: [
        { token: 'comment', foreground: '6E6C64', fontStyle: 'italic' },
        { token: 'keyword', foreground: '1C1B17', fontStyle: 'bold' },
        { token: 'string', foreground: '3A5A40' },
        { token: 'number', foreground: '6E6C64' },
      ],
      colors: { 'editor.background': '#E8E6DF', 'editor.foreground': '#1C1B17', 'editorLineNumber.foreground': '#ABA89F' },
    });
    const ts = monaco.languages.typescript.typescriptDefaults;
    ts.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true, esModuleInterop: true, strict: false, noEmit: true,
    });
    // Monaco can't resolve node_modules — 2307 "cannot find module" for relative helper imports is
    // noise (the SERVER --list check is the real module-resolution authority). Silence just that
    // code; keep every other type diagnostic. @playwright/test is given real types below so it still
    // autocompletes.
    ts.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [2307] });
    ts.addExtraLib(PLAYWRIGHT_DTS, 'file:///node_modules/@playwright/test/index.d.ts');
  }

  // A compact ambient stub so `import { test, expect } from '@playwright/test'` autocompletes and
  // type-checks the common surface — not the full .d.ts, just the handles specs actually touch.
  const PLAYWRIGHT_DTS = `declare module '@playwright/test' {
    export interface Locator { click(): Promise<void>; fill(v: string): Promise<void>; textContent(): Promise<string|null>; getByRole(r: string, o?: any): Locator; getByText(t: any, o?: any): Locator; getByTestId(t: string): Locator; first(): Locator; nth(i: number): Locator; }
    export interface Page { goto(url: string, o?: any): Promise<any>; click(s: string): Promise<void>; fill(s: string, v: string): Promise<void>; waitForSelector(s: string, o?: any): Promise<any>; getByRole(r: string, o?: any): Locator; getByText(t: any, o?: any): Locator; getByTestId(t: string): Locator; getByLabel(t: any, o?: any): Locator; locator(s: string): Locator; title(): Promise<string>; url(): string; screenshot(o?: any): Promise<any>; }
    export interface TestArgs { page: Page; [k: string]: any; }
    export interface Expect { (actual: any): any; soft(actual: any): any; }
    export const expect: Expect;
    interface TestFn { (name: string, fn: (args: TestArgs) => Promise<void> | void): void; only: TestFn; skip: TestFn; fixme: TestFn; describe(name: string, fn: () => void): void; beforeEach(fn: (args: TestArgs) => any): void; afterEach(fn: (args: TestArgs) => any): void; }
    export const test: TestFn;
  }`;

  async function ensureEditor() {
    const monaco = await loadMonaco();
    if (editor) return monaco;
    if (els.placeholder) els.placeholder.remove();
    editor = monaco.editor.create(els.mount, {
      value: '', language: 'typescript', automaticLayout: true,
      theme: prefersDark() ? 'vs-dark' : 'greenroom',
      minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, tabSize: 2, renderWhitespace: 'none',
    });
    editor.onDidChangeModelContent(() => {
      if (!model) return;
      setDirty(model.getValue() !== savedSource);
      setState(''); // editing clears the last save/validate verdict
    });
    // Ctrl/Cmd-S saves.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
    return monaco;
  }

  // ---- file list ----
  async function loadFiles() {
    const { j } = await api('/api/tests');
    const files = [...new Set((j.tests || []).map((t) => t.file))].sort();
    els.file.innerHTML = '<option value="">Select a test…</option>' +
      files.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    return files;
  }

  // ---- open / save / validate / history ----
  async function openFile(rel) {
    if (!rel) return;
    const monaco = await ensureEditor();
    const { status: st, j } = await api('/api/test-source?file=' + encodeURIComponent(rel));
    if (st !== 200) { notice(j.error || 'Could not open that test.'); return; }
    notice('');
    currentFile = rel;
    els.file.value = rel;
    monaco.editor.setModelMarkers(editor.getModel(), 'gr', []);
    // Fresh model per file so TS treats each spec as its own module (URI-keyed).
    const uri = monaco.Uri.parse('file:///' + rel);
    const existing = monaco.editor.getModel(uri);
    model = existing || monaco.editor.createModel(j.source, 'typescript', uri);
    if (existing) model.setValue(j.source);
    editor.setModel(model);
    savedSource = j.source;
    setDirty(false); setState('');
    els.diags.innerHTML = '';
    [els.save, els.validate, els.history, els.run].forEach((b) => b.disabled = false);
    els.msg.disabled = false;
    status(j.versionCount ? `${j.versionCount} version${j.versionCount === 1 ? '' : 's'} saved` : 'No versions yet');
    history.replaceState(null, '', '/editor?file=' + encodeURIComponent(rel));
  }

  async function save() {
    if (!currentFile || !editor) return;
    const source = model.getValue();
    const message = els.msg.value.trim();
    setState('validating'); status('Saving…');
    const { status: st, j } = await api('/api/test-source', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: currentFile, source, message: message || undefined }),
    });
    if (j && j.demo) { notice('Demo mode is read-only — saving is disabled.'); setState(''); status('Read-only'); return; }
    if (st !== 200 || !j.ok) {
      paintDiagnostics(j.diagnostics || [], j.error || 'Save failed.');
      return;
    }
    clearDiagnostics();
    savedSource = source; setDirty(false); setState('saved'); els.msg.value = '';
    status(`Saved — ${j.versionCount} version${j.versionCount === 1 ? '' : 's'}`);
    if (root.dataset.history === 'open') refreshVersions();
  }

  // "Run this" — trigger a run of just this spec (default env) and go watch it live on /run. A save
  // is offered first if there are unsaved edits, since the runner executes the file ON DISK.
  async function runThis() {
    if (!currentFile) return;
    if (root.dataset.dirty === 'true' && !confirm('You have unsaved edits — the run uses the saved file on disk. Run the last saved version anyway?')) return;
    els.run.disabled = true; status('Starting a run…');
    const { j } = await api('/api/run', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [currentFile] }),
    });
    els.run.disabled = false;
    if (j && j.demo) { notice('Demo mode is read-only — running is disabled.'); status('Read-only'); return; }
    // 409 = a run is already in progress; either way /run shows the live dashboard.
    if (j && j.ok === false && !j.error) { notice('A run is already in progress — opening the Run page.'); }
    location.href = '/run';
  }

  async function validate() {
    if (!currentFile) return;
    setState('validating'); status('Validating — compiling the spec…'); els.validate.disabled = true;
    try {
      const { j } = await api('/api/validate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: currentFile }),
      });
      if (j && j.demo) { notice('Demo mode is read-only — validation is disabled.'); setState(''); status('Read-only'); return; }
      if (j.valid) { clearDiagnostics(); setState('valid'); status('Compiles — no problems found'); }
      else { paintDiagnostics(j.diagnostics || [], `${(j.diagnostics || []).length || ''} problem(s) — see below`); }
    } finally {
      els.validate.disabled = false;
    }
  }

  // ---- diagnostics <-> Monaco markers ----
  function clearDiagnostics() {
    els.diags.innerHTML = '';
    if (editor && window.monaco) window.monaco.editor.setModelMarkers(editor.getModel(), 'gr', []);
  }
  function paintDiagnostics(list, statusMsg) {
    setState('invalid'); status(statusMsg || 'Problems found');
    els.diags.innerHTML = list.map((d, i) => {
      const loc = d.line ? `${d.line}:${d.col || 1}` : '—';
      return `<div class="code-editor__diag" data-i="${i}"${d.line ? ' data-clickable' : ''}>
        <span class="code-editor__diag-loc">${esc(loc)}</span><span>${esc(d.message)}</span></div>`;
    }).join('') || '<div class="code-editor__diag"><span>Could not read the error detail.</span></div>';
    // Monaco markers for the ones that carry a location.
    if (editor && window.monaco) {
      const m = window.monaco;
      m.editor.setModelMarkers(editor.getModel(), 'gr', list.filter((d) => d.line).map((d) => ({
        severity: m.MarkerSeverity.Error, message: d.message,
        startLineNumber: d.line, startColumn: d.col || 1, endLineNumber: d.line, endColumn: (d.col || 1) + 1,
      })));
    }
    els.diags.querySelectorAll('[data-clickable]').forEach((row) => {
      row.addEventListener('click', () => {
        const d = list[Number(row.dataset.i)];
        if (d && d.line && editor) { editor.revealLineInCenter(d.line); editor.setPosition({ lineNumber: d.line, column: d.col || 1 }); editor.focus(); }
      });
    });
  }

  // ---- history drawer ----
  async function refreshVersions() {
    const { j } = await api('/api/test-versions?file=' + encodeURIComponent(currentFile));
    const vs = j.versions || [];
    els.versions.innerHTML = vs.length ? vs.map((v, i) => {
      const when = v.createdAt ? new Date(v.createdAt).toLocaleString() : '';
      return `<div class="code-editor__version" data-id="${esc(v.id)}"${i === 0 ? ' data-current' : ''}>
        <div class="code-editor__version-msg">${esc(v.message || '(no message)')}</div>
        <div class="code-editor__version-meta"><span>${esc((v.authorId || '').slice(0, 8))}</span><span>${esc(when)}</span></div>
      </div>`;
    }).join('') : '<p class="cat-intro" style="padding:var(--space-3)">No versions yet — Save to create the first.</p>';
    els.versions.querySelectorAll('.code-editor__version').forEach((row) => {
      row.addEventListener('click', () => openDiff(row.dataset.id, row.querySelector('.code-editor__version-meta')?.textContent || ''));
    });
  }

  // Clicking a version opens a diff (that version vs the current buffer) so you see what restoring
  // would change BEFORE it touches your buffer. Restore then loads it in as an edit; Save persists
  // it as a NEW version (history is never mutated).
  async function openDiff(id, label) {
    const monaco = await loadMonaco();
    const { j } = await api('/api/test-version?id=' + encodeURIComponent(id));
    if (typeof j.source !== 'string') { notice('Could not load that version.'); return; }
    pendingRestore = j.source;
    els.diffLabel.textContent = 'Version ' + (label ? '· ' + label.trim() : '') + '  (left) vs current (right)';
    els.diff.hidden = false;
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(els.diffMount, {
        automaticLayout: true, readOnly: true, renderSideBySide: true,
        theme: prefersDark() ? 'vs-dark' : 'greenroom', minimap: { enabled: false }, fontSize: 13,
      });
    }
    // Fresh models each open; dispose the previous pair to avoid leaks.
    const prev = diffEditor.getModel();
    diffEditor.setModel({
      original: monaco.editor.createModel(j.source, 'typescript'),
      modified: monaco.editor.createModel(model.getValue(), 'typescript'),
    });
    if (prev) { prev.original?.dispose(); prev.modified?.dispose(); }
  }
  function closeDiff() { els.diff.hidden = true; }
  function restorePending() {
    model.setValue(pendingRestore); // loads into the buffer as an edit — Save persists it as a NEW version
    setDirty(true); setState(''); status('Loaded an older version — review, then Save to keep it as a new version');
    closeDiff();
    root.removeAttribute('data-history');
    editor.focus();
  }
  function toggleHistory() {
    const open = root.dataset.history === 'open';
    if (open) { root.removeAttribute('data-history'); return; }
    root.dataset.history = 'open';
    refreshVersions();
  }

  // ---- wire up ----
  els.file.addEventListener('change', () => openFile(els.file.value));
  els.save.addEventListener('click', save);
  els.validate.addEventListener('click', validate);
  els.run.addEventListener('click', runThis);
  els.history.addEventListener('click', toggleHistory);
  els.historyClose.addEventListener('click', () => root.removeAttribute('data-history'));
  els.diffClose.addEventListener('click', closeDiff);
  els.diffRestore.addEventListener('click', restorePending);
  window.addEventListener('beforeunload', (e) => { if (root.dataset.dirty === 'true') { e.preventDefault(); e.returnValue = ''; } });

  (async () => {
    await loadFiles();
    const q = new URLSearchParams(location.search).get('file');
    if (q) openFile(q);
  })();
})();
