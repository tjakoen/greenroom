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

  // 'signin' (default) or 'signup'. The first account ever created becomes superadmin
  // (auth/bootstrap.ts). Post-SSO these can be gated/removed, but email+password sign-up is how
  // the platform is bootstrapped and how users are added before Entra SSO lands.
  let mode = 'signin';
  function applyMode() {
    const up = mode === 'signup';
    $('loginHeading').textContent = up ? 'Create your account' : 'Sign in';
    $('loginLede').textContent = up ? 'The first account becomes the superadmin.' : 'Use your Greenroom account to continue.';
    $('loginSubmit').textContent = up ? 'Create account' : 'Sign in';
    $('loginToggle').textContent = up ? 'Have an account? Sign in' : 'New here? Create an account';
    $('loginNameField').hidden = !up;
    $('loginPassword').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    hideError();
  }

  function init() {
    $('loginToggle').addEventListener('click', () => { mode = mode === 'signup' ? 'signin' : 'signup'; applyMode(); });

    $('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError();
      const email = $('loginEmail').value.trim();
      const password = $('loginPassword').value;
      if (!email || !password) return showError('Enter your email and password.');
      const signup = mode === 'signup';
      const name = signup ? ($('loginName').value.trim() || email.split('@')[0]) : '';
      if (signup && password.length < 8) return showError('Password must be at least 8 characters.');

      const submitBtn = $('loginSubmit');
      submitBtn.disabled = true;
      try {
        const res = await fetch(signup ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(signup ? { email, password, name } : { email, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showError((body && body.message) || (signup ? 'Could not create the account.' : 'Could not sign in. Check your email and password.'));
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
