// pages/login-page.ts — the /login page BODY (P1 Gate 2). Unlike every other page body, this one
// is rendered WITHOUT the app rail/nav shell: the user isn't signed in yet, so there is nothing to
// navigate to. server.ts serves it as a small standalone HTML document of its own (not wrapped in
// grainPage) — see the /login route comment there for why.
//
// Mirrors pages/settings-page.ts's pattern (server-rendered grain form + a thin client module that
// does the fetch): a centered card, email + password fields, a submit button, an error slot, and a
// disabled "Sign in with Microsoft" placeholder for P3's Entra SSO (plans/platform.md §2).
export function loginBody(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Greenroom</title>
  <script src="/scripts/theme-boot.js"></script>
  <link rel="stylesheet" href="/styles/variables.css">
  <link rel="stylesheet" href="/styles/global.css">
  <link rel="stylesheet" href="/styles/grain.css">
  <link rel="stylesheet" href="/components.css">
  <link rel="stylesheet" href="/greenroom.css">
</head>
<body class="app-window-backdrop">
  <div class="login-page">
    <section class="card login-card" data-pad="lg">
      <div class="login-card__brand"><span>Greenroom</span></div>
      <h1 class="masthead" style="margin-top:0" id="loginHeading">Sign in</h1>
      <p class="lede" id="loginLede">Use your Greenroom account to continue.</p>
      <div id="loginError" class="callout" data-status="danger" hidden></div>
      <form id="loginForm" class="login-form">
        <label class="field" id="loginNameField" hidden>
          <span class="field__label">Name</span>
          <input class="field__input" id="loginName" name="name" type="text" autocomplete="name">
        </label>
        <label class="field">
          <span class="field__label">Email</span>
          <input class="field__input" id="loginEmail" name="email" type="email" autocomplete="username" required>
        </label>
        <label class="field">
          <span class="field__label">Password</span>
          <input class="field__input" id="loginPassword" name="password" type="password" autocomplete="current-password" required>
        </label>
        <button class="btn" data-variant="primary" type="submit" id="loginSubmit">Sign in</button>
      </form>
      <button class="btn" data-variant="ghost" type="button" id="loginToggle" style="margin-top:var(--space-2)">New here? Create an account</button>
      <div class="login-card__divider"><span>or</span></div>
      <button class="btn" type="button" disabled title="Coming in a later phase">Sign in with Microsoft</button>
    </section>
  </div>
  <div id="toast" class="gr-toast" role="status" aria-live="polite"></div>
  <script src="/login.js" defer></script>
</body>
</html>`;
}
