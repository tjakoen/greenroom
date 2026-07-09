import { test, expect } from "bun:test";
import { isLoopbackHost, isLoopbackOrigin, guardRequest } from "./guard.ts";

const post = (headers: Record<string, string> = {}, body?: string) =>
  new Request("http://127.0.0.1:4321/api/run", { method: "POST", headers, body });

test("isLoopbackHost accepts loopback + empty", () => {
  // Real Host headers for IPv6 loopback arrive bracketed ("[::1]" / "[::1]:4321"); the bare
  // "::1" form is not something the server sees (and the port-strip regex is verbatim from server.js).
  for (const h of ["localhost", "127.0.0.1:4321", "[::1]", "[::1]:4321", "0.0.0.0", "", null, undefined])
    expect(isLoopbackHost(h)).toBe(true);
  for (const h of ["evil.com", "example.com:4321", "10.0.0.5"]) expect(isLoopbackHost(h)).toBe(false);
});

test("isLoopbackOrigin", () => {
  expect(isLoopbackOrigin("http://localhost:4321")).toBe(true);
  expect(isLoopbackOrigin("http://127.0.0.1")).toBe(true);
  expect(isLoopbackOrigin("https://evil.com")).toBe(false);
  expect(isLoopbackOrigin("garbage")).toBe(false);
});

test("GET is always allowed", () => {
  expect(guardRequest(new Request("http://127.0.0.1:4321/api/state"))).toBeNull();
});

test("cross-origin write is refused (403)", () => {
  const r = guardRequest(post({ origin: "https://evil.com", "content-type": "application/json" }, "{}"));
  expect(r?.status).toBe(403);
});

test("bodied POST must declare JSON (415 otherwise)", () => {
  const r = guardRequest(post({ "content-type": "text/plain" }, "hello"));
  expect(r?.status).toBe(415);
});

test("loopback JSON POST is allowed", () => {
  expect(guardRequest(post({ origin: "http://localhost:4321", "content-type": "application/json" }, "{}"))).toBeNull();
});

test("bodyless POST (e.g. /api/stop) is allowed", () => {
  expect(guardRequest(post())).toBeNull();
});
