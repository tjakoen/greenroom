'use strict';
// pages/login.js — the thin client module behind /login (P1 Gate 2). Plain, dependency-free
// browser JS (no bundler, no TS) served as-is by server.ts, same pattern as pages/settings.js.
// Posts straight to better-auth's HTTP sign-in route (mounted at /api/auth by auth.handler in
// server.ts) — NOT auth.api.signInEmail (that's the server-side call; the browser hits the route).
(() => {
  const $ = (id) => document.getElementById(id);

  function showError(msg) {
    const el = $('loginError');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }
  function hideError() {
    const el = $('loginError');
    if (el) el.hidden = true;
  }

  function init() {
    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      if (!email || !password) return showError('Enter your email and password.');

      const submitBtn = $('loginSubmit');
      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError((body && body.message) || 'Could not sign in. Check your email and password.');
          return;
        }
        window.location.href = '/';
      } catch {
        showError('Could not reach the server. Try again.');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
