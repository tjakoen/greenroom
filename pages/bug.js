'use strict';
// pages/bug.js — the thin client module behind /bug (P5). Plain, dependency-free browser JS (no
// bundler, no TS), same pattern as pages/run.js (P4). Ported near-verbatim from interface/app.js's
// #/share logic (~702-964, 1401-1526) over the SAME endpoints (/api/{runs,pdf-data,moment,
// bug-summary,pdf-image,video,video-clip,bug-bundle,pdf,ffmpeg-available}) with the SAME request
// shapes — this file only changes the markup classes (grain) and the hand-off mechanism: the
// preselected run/test come from THIS page's URL query (?run=&test=&title=) instead of the SPA's
// in-page pendingShare global (History's "Report this" now navigates here with those params).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = (s) => (Number(s) || 0).toFixed(1) + 's';
  const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('is-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('is-show'), 2600);
  }
  const api = (path, opts) => fetch(path, opts).then((r) => r.json());
  const markShared = () => { try { localStorage.setItem('gr_shared', '1'); } catch { /* ignore */ } };

  // ---- a tiny, safe markdown renderer (ported verbatim from interface/app.js md()) ----
  function md(src) {
    const lines = String(src || '').split('\n');
    let html = '';
    let inList = null;
    let inCode = false;
    let para = [];
    let quote = [];
    const safeHref = (href) => (/^(https?:\/\/|\/|#|mailto:)/i.test(String(href).trim()) ? href : null);
    const inline = (s) =>
      esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/\b_([^_]+)_\b/g, '<em>$1</em>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, text, href) => {
          const h = safeHref(href);
          return h ? `<a href="${h}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
        });
    const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; } };
    const flushQuote = () => { if (quote.length) { html += '<blockquote>' + inline(quote.join(' ')) + '</blockquote>'; quote = []; } };
    const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
    for (const raw of lines) {
      if (raw.trim().startsWith('```')) {
        flushPara(); flushQuote(); closeList();
        if (!inCode) { html += '<pre><code>'; inCode = true; } else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(raw) + '\n'; continue; }
      const line = raw.trimEnd();
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushQuote(); closeList(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; }
      else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); flushQuote(); if (inList !== 'ul') { closeList(); html += '<ul>'; inList = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) { flushPara(); flushQuote(); if (inList !== 'ol') { closeList(); html += '<ol>'; inList = 'ol'; } html += `<li>${inline(m[1])}</li>`; }
      else if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); quote.push(m[1]); }
      else if (line.trim() === '') { flushPara(); flushQuote(); closeList(); }
      else { flushQuote(); para.push(line); }
    }
    flushPara(); flushQuote(); closeList();
    if (inCode) html += '</code></pre>';
    return html;
  }

  // ---- state ----
  let ffmpegAvailable = null;
  let pendingShare = null; // { run, test?, testTitle? } — seeded from the URL query on load
  let pdfData = [];
  let momentData = { consoleTimed: [], networkTimed: [], requests: [], console: [], network: [], durationMs: 0 };
  let curSnaps = [];
  let curSnapIdx = 0;

  async function refreshShare() {
    if (ffmpegAvailable === null) {
      ffmpegAvailable = await api('/api/ffmpeg-available').then((d) => !!d.available).catch(() => false);
    }
    const runs = await api('/api/runs').catch(() => []);
    const list = Array.isArray(runs) ? runs : (runs && runs.runs) || [];
    $('shareRun').innerHTML = ['<option value="latest">Latest run</option>']
      .concat(list.map((r) => `<option value="${encodeURIComponent(r.id)}">${esc(r.when)} · ${esc(r.env)} · ${esc(r.result)}</option>`))
      .join('');
    if (pendingShare && pendingShare.run && [...$('shareRun').options].some((o) => o.value === pendingShare.run)) {
      $('shareRun').value = pendingShare.run;
    }
    await loadShareTests();
  }

  async function loadShareTests() {
    const run = $('shareRun').value || 'latest';
    pdfData = await api('/api/pdf-data?run=' + run).catch(() => []);
    if (!Array.isArray(pdfData)) pdfData = (pdfData && pdfData.records) || [];
    const sel = $('shareTest');
    sel.innerHTML = '';
    const has = pdfData.length > 0;
    $('shareEmpty').style.display = has ? 'none' : 'block';
    $('shareBody').style.display = has ? 'block' : 'none';
    $('pdfCard').style.display = has ? 'block' : 'none';
    for (const t of pdfData) {
      const o = document.createElement('option');
      o.value = t.test;
      o.textContent = `${t.title}  [${t.status}]`;
      sel.appendChild(o);
    }
    if (pendingShare) {
      const wantTest = pendingShare.test || (pendingShare.testTitle && (pdfData.find((t) => t.title === pendingShare.testTitle) || {}).test);
      if (wantTest && pdfData.some((t) => t.test === wantTest)) sel.value = wantTest;
      pendingShare = null;
    }
    if (has) await onTestSelected();
  }

  async function onTestSelected() {
    const run = $('shareRun').value || 'latest';
    const test = $('shareTest').value;
    await loadFullLogs(run, test);
    if ($('shareTest').value !== test) return;
    await loadSummary(run, test);
    loadPdfSnaps(run, test);
  }

  async function loadSummary(run, test) {
    const raw = await fetch('/api/bug-summary?run=' + run + '&test=' + encodeURIComponent(test)).then((r) => r.text());
    const txt = stripAnsi(raw);
    $('shareSummary').innerHTML = md(txt);
    $('shareSummary').dataset.raw = txt;
  }

  function setMomentData(d) {
    momentData = {
      consoleTimed: (d && d.consoleTimed) || [],
      networkTimed: (d && d.networkTimed) || [],
      requests: (d && d.requests) || [],
      console: (d && d.console) || [],
      network: (d && d.network) || [],
      durationMs: (d && d.durationMs) || 0,
    };
  }
  async function loadFullLogs(run, test) {
    setMomentData(null);
    const d = await api('/api/moment?run=' + run + '&test=' + encodeURIComponent(test)).catch(() => null);
    if ($('shareTest').value !== test) return;
    setMomentData(d);
    renderTopLogs();
  }

  const classifyConsole = (line) => (/^\[(error|pageerror)\]/i.test(line) ? 'err' : /^\[warning\]/i.test(line) ? 'warn' : '');
  const shortUrl = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
  function logRow(e, cls) {
    const time = typeof e.t === 'number' ? fmtTime(e.t / 1000) : '';
    if (e.url !== undefined) {
      const bad = e.status === 0 || e.status >= 400;
      const status = e.status === 0 ? 'ERR' : e.status;
      const body = `<b>${esc(status)}</b> ${esc(e.method)} <span title="${esc(e.url)}">${esc(shortUrl(e.url))}</span>`;
      return `<div class="log-line ${bad ? 'err' : ''}"><span class="lt">${time}</span><span>${body}</span></div>`;
    }
    return `<div class="log-line ${cls || ''}"><span class="lt">${time}</span><span>${esc(stripAnsi(e.line))}</span></div>`;
  }
  function renderTopLogs() {
    const timedConsole = momentData.consoleTimed.length > 0;
    const timedNetwork = momentData.networkTimed.length > 0;
    const c = timedConsole ? momentData.consoleTimed : momentData.console.map((line) => ({ line }));
    const n = timedNetwork ? momentData.networkTimed : momentData.network.map((line) => ({ line }));
    $('topConsoleCount').textContent = c.length;
    $('topNetworkCount').textContent = n.length;
    const noTimingNote = '<div class="none">Timing not recorded for this run — re-run the test to add timestamps.</div>';
    $('topConsoleLogs').innerHTML = c.length
      ? (timedConsole ? '' : noTimingNote) + c.map((e) => logRow(e, classifyConsole(e.line))).join('')
      : '<div class="none">Nothing logged.</div>';
    $('topNetworkLogs').innerHTML = n.length
      ? (timedNetwork ? '' : noTimingNote) + n.map((e) => logRow(e)).join('')
      : '<div class="none">No failed or error responses.</div>';
  }

  function loadPdfSnaps(run, test) {
    run = run || $('shareRun').value || 'latest';
    test = test || $('shareTest').value;
    const t = pdfData.find((x) => x.test === test);
    if (!t) return;
    curSnaps = t.snapshots || [];
    curSnapIdx = 0;
    const range = $('snapRange');
    range.max = Math.max(0, curSnaps.length - 1);
    range.value = 0;
    range.disabled = curSnaps.length <= 1;
    const v = $('pdfVideo');
    if (t.hasVideo) {
      v.src = '/api/video?run=' + run + '&test=' + encodeURIComponent(t.test);
      primeVideo(v);
      $('pdfVideoDetails').style.display = '';
      $('downloadClipBtn').style.display = ffmpegAvailable ? '' : 'none';
      $('downloadFailClipBtn').style.display = ffmpegAvailable && t.status === 'failed' ? '' : 'none';
      $('clipNote').style.display = ffmpegAvailable ? 'none' : '';
    } else {
      v.removeAttribute('src');
      $('pdfVideoDetails').style.display = 'none';
    }
    showSnap(0);
  }

  function showSnap(i) {
    if (!curSnaps.length) {
      $('pdfPreview').innerHTML = '';
      $('snapLabel').textContent = 'No screenshots';
      $('pdfBtn').disabled = true;
      renderMomentLogs(null, null);
      return;
    }
    curSnapIdx = Math.min(Math.max(0, i), curSnaps.length - 1);
    $('snapRange').value = curSnapIdx;
    const s = curSnaps[curSnapIdx];
    const run = $('shareRun').value || 'latest';
    const test = $('shareTest').value;
    $('pdfPreview').innerHTML = `<img alt="Screenshot ${curSnapIdx + 1}" src="/api/pdf-image?run=${run}&test=${encodeURIComponent(test)}&i=${s.index}">`;
    $('snapLabel').textContent = `${curSnapIdx + 1} / ${curSnaps.length}` + (s.title ? ' · ' + s.title : s.url ? ' · ' + s.url : '') + (s.final ? ' (final)' : '');
    $('pdfBtn').disabled = false;
    if (typeof s.t === 'number') {
      const prev = curSnapIdx > 0 ? curSnaps[curSnapIdx - 1] : null;
      renderMomentLogs(prev && typeof prev.t === 'number' ? prev.t : 0, s.t);
    } else {
      renderMomentLogs(null, null);
    }
  }

  function currentInterval() {
    const s = curSnaps[curSnapIdx];
    if (!s || typeof s.t !== 'number') return null;
    const prev = curSnapIdx > 0 ? curSnaps[curSnapIdx - 1] : null;
    const fromMs = prev && typeof prev.t === 'number' ? prev.t : 0;
    return { fromMs, toMs: s.t, fromSec: fromMs / 1000, toSec: s.t / 1000 };
  }

  function primeVideo(v) {
    const onMeta = () => {
      if (isFinite(v.duration) && v.duration > 0) return;
      const onSeek = () => { v.removeEventListener('seeked', onSeek); v.currentTime = 0; };
      v.addEventListener('seeked', onSeek);
      try { v.currentTime = 1e6; } catch { /* browser clamps + resolves duration */ }
    };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
    v.load();
  }

  function renderMomentLogs(fromMs, toMs) {
    const el = $('momentLogs');
    if (!el) return;
    const hasReq = momentData.requests.length > 0;
    const timed = momentData.consoleTimed.length || momentData.networkTimed.length || hasReq;
    let c, net, netLabel, head;
    if (fromMs !== null && timed) {
      const within = (arr) => (arr || []).filter((e) => e.t >= fromMs && e.t <= toMs);
      c = within(momentData.consoleTimed);
      net = hasReq ? within(momentData.requests) : within(momentData.networkTimed);
      netLabel = hasReq ? 'Network requests' : 'Network issues';
      head = `<div class="mhead"><span>${fmtTime(fromMs / 1000)} – ${fmtTime(toMs / 1000)}</span><span class="win">— since the last screenshot (what the PDF will include)</span></div>`;
    } else {
      c = (momentData.console || []).map((line) => ({ line }));
      net = hasReq ? momentData.requests : (momentData.network || []).map((line) => ({ line }));
      netLabel = hasReq ? 'Network requests' : 'Network issues';
      head = `<div class="mhead"><span>All logs for this test</span><span class="win">— per-moment timing not recorded; re-run to pinpoint</span></div>`;
    }
    let html = head;
    if (!c.length && !net.length) {
      html += '<div class="none">No console or network activity in this window.</div>';
    } else {
      html += `<div class="log-group"><div class="glabel">Console</div>${c.length ? c.map((e) => logRow(e, classifyConsole(e.line))).join('') : '<div class="none">—</div>'}</div>`;
      html += `<div class="log-group"><div class="glabel">${netLabel}</div>${net.length ? net.map((e) => logRow(e)).join('') : '<div class="none">—</div>'}</div>`;
    }
    el.innerHTML = html;
  }

  // ---- exports: PDF, bundle, copy, video + clip ----
  function downloadVideo() {
    const run = $('shareRun').value || 'latest';
    const test = $('shareTest').value;
    window.location = '/api/video?run=' + run + '&test=' + encodeURIComponent(test) + '&download=1';
  }
  function downloadClip(fromSec, toSec) {
    const run = $('shareRun').value || 'latest';
    const test = $('shareTest').value;
    window.location = `/api/video-clip?run=${run}&test=${encodeURIComponent(test)}&from=${fromSec}&to=${toSec}`;
  }
  function downloadStepClip() {
    const iv = currentInterval();
    if (!iv) return toast('This run has no per-screenshot timing to clip — try the full video instead.');
    downloadClip(Math.max(0, iv.fromSec - 0.5), iv.toSec + 0.5);
  }
  function downloadFailClip() {
    const final = curSnaps.find((s) => s.final) || curSnaps[curSnaps.length - 1];
    const centerMs = final && typeof final.t === 'number' ? final.t : momentData.durationMs;
    if (!centerMs) return toast('No timing recorded for this run — try the full video instead.');
    downloadClip(Math.max(0, centerMs / 1000 - 4), centerMs / 1000 + 1);
  }
  function downloadBundle() {
    const run = $('shareRun').value || 'latest';
    const test = $('shareTest').value;
    window.location = '/api/bug-bundle?run=' + run + '&test=' + encodeURIComponent(test);
  }
  async function copySummary() {
    const raw = $('shareSummary').dataset.raw || '';
    try { await navigator.clipboard.writeText(raw); toast('Summary copied — paste into ClickUp, Slack or email.'); }
    catch { toast('Copy failed — select the text manually.'); }
  }
  async function downloadPdf() {
    const btn = $('pdfBtn');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Building…';
    try {
      const s = curSnaps[curSnapIdx];
      const body = { run: $('shareRun').value || 'latest', test: $('shareTest').value, i: s ? s.index : 0 };
      const iv = currentInterval();
      if (iv) { body.from = iv.fromMs; body.to = iv.toMs; }
      const res = await fetch('/api/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { toast('PDF failed: ' + (await res.text())); return; }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'report.pdf';
      a.click();
      URL.revokeObjectURL(a.href);
    } finally { btn.textContent = prev; btn.disabled = false; }
  }

  function init() {
    // Seed the run/test preselection from the URL query (History's "Report this" hand-off).
    const q = new URLSearchParams(location.search);
    if (q.get('run') || q.get('test')) {
      pendingShare = { run: q.get('run') || 'latest', test: q.get('test') || undefined, testTitle: q.get('title') || undefined };
    }

    $('shareRun').onchange = loadShareTests;
    $('shareTest').onchange = onTestSelected;
    $('snapRange').oninput = (e) => showSnap(Number(e.target.value));
    $('snapPrev').onclick = () => showSnap(curSnapIdx - 1);
    $('snapNext').onclick = () => showSnap(curSnapIdx + 1);
    $('bundleBtn').onclick = () => { markShared(); downloadBundle(); };
    $('bundleBtn2').onclick = () => { markShared(); downloadBundle(); };
    $('copySummaryBtn').onclick = () => { markShared(); copySummary(); };
    $('pdfBtn').onclick = downloadPdf;
    $('downloadVideoBtn').onclick = downloadVideo;
    $('downloadClipBtn').onclick = downloadStepClip;
    $('downloadFailClipBtn').onclick = downloadFailClip;

    const applyPdfLayout = (mode) => {
      $('pdfLayoutWrap').classList.toggle('grid2', mode === 'half');
      $('pdfLayoutToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.layout === mode));
    };
    applyPdfLayout(localStorage.getItem('pdfLayout') || 'full');
    $('pdfLayoutToggle').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      localStorage.setItem('pdfLayout', b.dataset.layout);
      applyPdfLayout(b.dataset.layout);
    }));

    refreshShare();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
