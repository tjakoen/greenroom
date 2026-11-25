import { test, expect } from "bun:test";
import { mimeOf, resolveRunTarget, safeResolve, serveFileRanged } from "./binary.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("mimeOf", () => {
  expect(mimeOf("clip.webm")).toBe("video/webm");
  expect(mimeOf("shot.PNG")).toBe("image/png");
  expect(mimeOf("bundle.zip")).toBe("application/zip");
  expect(mimeOf("mystery.xyz")).toBe("application/octet-stream");
});

test("safeResolve blocks traversal + sibling-prefix escapes", () => {
  expect(safeResolve("/a/report", "../secret")).toBeNull();
  expect(safeResolve("/a/report", "../report-evil/x")).toBeNull();
  expect(safeResolve("/a/report", "sub/file.png")).toBe("/a/report/sub/file.png");
  expect(safeResolve("/a/report", ".")).toBe("/a/report");
});

const fp = join(tmpdir(), `gr-binary-spike-${process.pid}.bin`);
await Bun.write(fp, new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256)));

test("resolveRunTarget scopes on the RESOLVED run, not the raw first segment", () => {
  const root = "/a/runs";
  // The ordinary case.
  expect(resolveRunTarget(root, "own/index.html")).toEqual({ target: "/a/runs/own/index.html", runId: "own" });
  expect(resolveRunTarget(root, "own/")).toEqual({ target: "/a/runs/own/index.html", runId: "own" });
  expect(resolveRunTarget(root, "own")).toEqual({ target: "/a/runs/own/index.html", runId: "own" });
  // The bug: the raw first segment says "own" and the resolved one says "other", so the scope
  // check must read "other" or a private run is served to anyone who can name their own.
  expect(resolveRunTarget(root, "own/../other/index.html")).toEqual({
    target: "/a/runs/other/index.html",
    runId: "other",
  });
  // Escapes and malformed escapes are refused outright.
  expect(resolveRunTarget(root, "../escape")).toBeNull();
  expect(resolveRunTarget(root, "own/../../etc/passwd")).toBeNull();
  expect(resolveRunTarget(root, "own/%")).toBeNull();
});

test("full request serves all bytes (200)", async () => {
  const r = await serveFileRanged(new Request("http://x/f"), fp, "application/octet-stream");
  expect(r.status).toBe(200);
  expect(r.headers.get("Content-Length")).toBe("1000");
  expect(r.headers.get("Accept-Ranges")).toBe("bytes");
  const buf = new Uint8Array(await r.arrayBuffer());
  expect(buf.length).toBe(1000);
  expect(buf[0]).toBe(0);
  expect(buf[255]).toBe(255);
});

test("Range request returns the exact slice (206)", async () => {
  const r = await serveFileRanged(new Request("http://x/f", { headers: { range: "bytes=100-199" } }), fp);
  expect(r.status).toBe(206);
  expect(r.headers.get("Content-Range")).toBe("bytes 100-199/1000");
  expect(r.headers.get("Content-Length")).toBe("100");
  const buf = new Uint8Array(await r.arrayBuffer());
  expect(buf.length).toBe(100);
  expect(buf[0]).toBe(100);
});

test("open-ended Range bytes=990-", async () => {
  const r = await serveFileRanged(new Request("http://x/f", { headers: { range: "bytes=990-" } }), fp);
  expect(r.status).toBe(206);
  expect(r.headers.get("Content-Range")).toBe("bytes 990-999/1000");
  expect(r.headers.get("Content-Length")).toBe("10");
});

test("unsatisfiable Range → 416", async () => {
  const r = await serveFileRanged(new Request("http://x/f", { headers: { range: "bytes=2000-3000" } }), fp);
  expect(r.status).toBe(416);
  expect(r.headers.get("Content-Range")).toBe("bytes */1000");
});

test("missing file → 404", async () => {
  const r = await serveFileRanged(new Request("http://x/f"), join(tmpdir(), "gr-missing.bin"));
  expect(r.status).toBe(404);
});
