import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runWatch } from "../src/watch.ts";
import worker from "../src/direct.ts";

const commit = "a".repeat(40);
const url = "https://cli.github.com/manual/gh_auth_switch";
const issueUrl = "https://github.com/foxion37/portwright/issues/7";
const hash = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const day = n => new Date(`2026-09-${n}T03:17:00.000Z`);

function fixture(t, sources = [{ skill: "github", url }]) {
  const objects = new Map([
    ["current.json", JSON.stringify({ commit })],
    [`releases/${commit}/watch-sources.json`, JSON.stringify({ sources })],
    [`releases/${commit}/github/SKILL.md`, "cached procedure private text"],
  ]);
  function sealRelease() {
    const files = [...objects].filter(([key]) => key.startsWith(`releases/${commit}/`) && !key.endsWith("/inventory.json")).map(([key, body]) => ({
      path: key.slice(`releases/${commit}/`.length), digest: hash(body), size: Buffer.byteLength(body),
    }));
    const inventory = JSON.stringify({ schema_version: 1, commit, release: "fixture.1", skills: [], files, aliases: {} });
    objects.set(`releases/${commit}/inventory.json`, inventory);
    objects.set("current.json", JSON.stringify({
      commit, release: "fixture.1", inventory_digest: hash(inventory), revision: 1, sequence: 1,
      high_water: { commit, sequence: 1 }, previous: null, operation: "promote", activated_at: day(21).toISOString(),
    }));
  }
  sealRelease();
  const calls = [], logs = [];
  const f = {
    document: "original document 한글", noul: 0.9, documentResponse: null, modelResponse: null, issueResponse: null, listResponse: null,
    objects, calls, logs, sealRelease, issues: [],
    env: {
      SKILLS_BUCKET: {
        async get(key) {
          const value = objects.get(key);
          return value === undefined ? null : {
            size: Buffer.byteLength(value), etag: hash(value),
            text: async () => value, json: async () => JSON.parse(value),
            arrayBuffer: async () => new TextEncoder().encode(value).buffer,
          };
        },
        async put(key, value) { objects.set(key, value); },
      },
      GISUL_BEARER_TOKEN: "fixture-mcp-token",
      TYPESAFE_API_KEY: "fixture-typesafe-token",
      GISUL_GITHUB_TOKEN: "fixture-github-token",
      GISUL_WATCH_REPO: "foxion37/portwright",
    },
    state: () => JSON.parse(objects.get("watch/state.json")),
    async run(n = 22) {
      const before = logs.length;
      const report = await runWatch(f.env, day(n));
      assert.equal(logs.length, before + 1);
      assert.deepEqual(JSON.parse(logs.at(-1)), report);
      return report;
    },
  };
  t.mock.method(console, "log", line => logs.push(line));
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const target = String(input);
    calls.push({ url: target, ...init });
    assert.equal(init.redirect, "manual");
    if (target === "https://api.typesafe.ai/v1/systemone") {
      return f.modelResponse ? f.modelResponse() : Response.json({ answers: { contradicts: { type: "noul", noul: f.noul } } });
    }
    if (target.startsWith("https://api.github.com/repos/foxion37/portwright/issues?")) {
      const page = Number(new URL(target).searchParams.get("page"));
      return f.listResponse ? f.listResponse(page) : Response.json(f.issues.slice((page - 1) * 100, page * 100));
    }
    if (target === "https://api.github.com/repos/foxion37/portwright/issues") {
      if (f.issueResponse) return f.issueResponse(JSON.parse(init.body));
      f.issues.push({ ...JSON.parse(init.body), html_url: issueUrl });
      return Response.json({ html_url: issueUrl }, { status: 201 });
    }
    assert.ok(sources.some(source => source.url === target), "unexpected outbound request");
    return f.documentResponse ? f.documentResponse() : new Response(f.document, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
  return f;
}

const apiCalls = f => f.calls.filter(call => call.method === "POST");

test("first collection records a UTF-8 baseline without judging it", async t => {
  const f = fixture(t);
  assert.deepEqual(await f.run(), { checked: 1, changed: [], contradicted: [], issues: [], failed: [] });
  assert.deepEqual(f.state(), { github: { url, sha256: hash(f.document), baseline_sha256: hash(f.document), checked_at: day(22).toISOString() } });
  assert.equal(apiCalls(f).length, 0);
});

test("returning to the first document is still a later content change", async t => {
  const f = fixture(t);
  const initial = f.document;
  await f.run();
  f.document = "second document";
  f.noul = 0.1;
  await f.run(23);
  f.document = initial;
  f.noul = 0.9;
  const report = await f.run(24);
  assert.deepEqual(report.contradicted, ["github"]);
  assert.deepEqual(report.issues, [issueUrl]);
  assert.equal(f.calls.filter(call => call.url === "https://api.typesafe.ai/v1/systemone").length, 2);
});

test("changed documents are judged once, issue metadata is sanitized, and unchanged hashes are skipped", async t => {
  const f = fixture(t);
  await f.run();
  const oldHash = hash(f.document);
  f.document = "new document private text".repeat(600);
  f.objects.set(`releases/${commit}/github/SKILL.md`, "cached procedure private text".repeat(600));
  f.sealRelease();
  assert.deepEqual(await f.run(23), { checked: 1, changed: ["github"], contradicted: ["github"], issues: [issueUrl], failed: [] });
  const [judge, issue] = apiCalls(f);
  assert.equal(apiCalls(f).length, 2);
  assert.equal(judge.headers.authorization, "Bearer fixture-typesafe-token");
  assert.deepEqual(JSON.parse(judge.body), {
    model: "jev-latest",
    state: { cached_procedure: ("cached procedure private text".repeat(600)).slice(0, 12000), current_document: f.document.slice(0, 12000) },
    questions: { contradicts: { type: "noul", instructions: "Does `current_document` contradict any step in `cached_procedure`?", criteria: { true: "a step, path, or command no longer matches", false: "steps still hold" } } },
  });
  const payload = JSON.parse(issue.body);
  assert.equal(payload.title, "[portwright] stale candidate: github");
  assert.deepEqual(payload.body.split("\n"), [
    `URL: ${url}`, `New sha256: ${hash(f.document)}`, `Previous sha256: ${oldHash}`, "noul: 0.9", `Release commit: ${commit}`,
  ]);
  assert.equal(issue.headers.authorization, "Bearer fixture-github-token");
  assert.equal(f.state().github.issue_sha256, hash(f.document));
  assert.equal(f.state().github.changed_at, day(23).toISOString());
  const before = apiCalls(f).length;
  assert.deepEqual(await f.run(24), { checked: 1, changed: [], contradicted: [], issues: [], failed: [] });
  assert.equal(apiCalls(f).length, before);
  assert.equal(f.state().github.checked_at, day(24).toISOString());
  assert.equal(f.state().github.changed_at, day(23).toISOString());
  assert.ok(!f.logs.join("").includes("private text"));
  assert.ok(!f.logs.join("").includes("fixture-typesafe-token"));
});

test("an existing issue marker prevents reissuing the same skill and hash", async t => {
  const f = fixture(t);
  f.objects.set("watch/state.json", JSON.stringify({ github: { url, sha256: hash("previous"), checked_at: day(21).toISOString(), issue_sha256: hash(f.document) } }));
  const report = await f.run();
  assert.deepEqual(report.issues, []);
  assert.equal(f.calls.filter(call => call.url.includes("/issues")).length, 0);
  assert.equal(f.state().github.issue_sha256, hash(f.document));
});

test("unsafe URLs are rejected before fetch, including empty query and fragment delimiters", async t => {
  const sources = ["http://example.com/doc", "https://user:pass@example.com/doc", "https://@example.com/doc", "https://example.com/doc?q=secret", "https://example.com/doc#part", "https://example.com/doc?", "https://example.com/doc#", "not a URL"].map((url, i) => ({ skill: `source-${i}`, url }));
  const f = fixture(t, sources);
  const report = await f.run();
  assert.deepEqual(report.failed, sources.map(({ skill }) => ({ skill, error: "invalid-url" })));
  assert.equal(f.calls.length, 0);
  assert.equal(report.checked, 0);
  assert.ok(!f.logs.join("").includes("secret"));
});

test("redirects, nontext, oversized streams, HTTP errors and network failures are categorized", async t => {
  const cases = [
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } })],
    ["http", () => new Response("error detail", { status: 503 })],
    ["http", () => new Response(new Uint8Array([0, 1]), { headers: { "content-type": "application/octet-stream" } })],
    ["too-large", () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "text/plain" } })],
    ["network", () => { throw new Error("private network detail"); }],
  ];
  for (const [error, response] of cases) {
    await t.test(error, async t => {
      const f = fixture(t);
      f.documentResponse = response;
      assert.deepEqual((await f.run()).failed, [{ skill: "github", error }]);
      assert.equal(f.calls.length, 1);
      assert.equal(f.objects.has("watch/state.json") && !!f.state().github, false);
      assert.ok(!f.logs.join("").includes("private network detail"));
    });
  }
});

test("missing TypeSafe key reports unavailable and never creates an issue", async t => {
  const f = fixture(t);
  await f.run();
  delete f.env.TYPESAFE_API_KEY;
  f.document = "changed";
  assert.deepEqual(await f.run(23), { checked: 1, changed: ["github"], contradicted: [], issues: [], failed: [{ skill: "github", error: "unavailable" }] });
  assert.equal(apiCalls(f).length, 0);
  assert.equal(f.state().github.sha256, hash("changed"));
  assert.equal(f.state().github.judgment, undefined);
  f.env.TYPESAFE_API_KEY = "fixture-typesafe-token";
  assert.deepEqual((await f.run(24)).issues, [issueUrl]);
  assert.equal(f.state().github.judgment.sha256, hash("changed"));
});

test("only valid Noul answers meeting the threshold can create issues", async t => {
  for (const noul of [0.69, 0.7, "0.9", 2, null]) {
    await t.test(String(noul), async t => {
      const f = fixture(t);
      await f.run();
      f.document = "changed";
      f.noul = noul;
      const report = await f.run(23);
      assert.deepEqual(report.issues, noul === 0.7 ? [issueUrl] : []);
      if (typeof noul !== "number" || noul > 1) assert.deepEqual(report.failed, [{ skill: "github", error: "unavailable" }]);
    });
  }
});

test("missing watch sources reports unavailability without outbound requests", async t => {
  const f = fixture(t);
  f.objects.delete(`releases/${commit}/watch-sources.json`);
  assert.deepEqual(await f.run(), { checked: 0, changed: [], contradicted: [], issues: [], failed: [{ skill: "watch-sources", error: "unavailable" }] });
  assert.equal(f.calls.length, 0);
});

test("failed issue creation never records an issue marker", async t => {
  const f = fixture(t);
  await f.run();
  f.document = "changed";
  f.issueResponse = () => new Response("private API detail", { status: 403 });
  const report = await f.run(23);
  assert.deepEqual(report.failed, [{ skill: "github", error: "http" }]);
  assert.deepEqual(report.issues, []);
  assert.equal(f.state().github.issue_sha256, undefined);
  assert.equal(f.state().github.judgment.sha256, hash("changed"));
  f.issueResponse = null;
  assert.deepEqual((await f.run(24)).issues, [issueUrl]);
  assert.equal(f.calls.filter(call => call.url.includes("systemone")).length, 1);
});

test("scheduled handler attaches the watch operation to waitUntil", async t => {
  const f = fixture(t);
  const tasks = [];
  worker.scheduled({}, f.env, { waitUntil: promise => tasks.push(promise) });
  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.equal(f.state().github.sha256, hash(f.document));
  assert.equal(f.logs.length, 1);
});

test("watch retries the same observed hash after a judgment HTTP failure", async t => {
  const f = fixture(t);
  await f.run();
  f.document = "changed";
  f.modelResponse = () => new Response("private failure", { status: 503 });
  assert.deepEqual((await f.run(23)).failed, [{ skill: "github", error: "http" }]);
  assert.equal(f.state().github.sha256, hash("changed"));
  assert.equal(f.state().github.judgment, undefined);
  f.modelResponse = null;
  assert.deepEqual((await f.run(24)).issues, [issueUrl]);
  assert.equal(f.calls.filter(call => call.url.includes("systemone")).length, 2);
});

test("watch reconciles a lost issue response without another POST, including closed issues on later pages", async t => {
  const f = fixture(t);
  await f.run();
  f.document = "changed";
  f.issues = Array.from({ length: 100 }, (_, n) => ({ title: `unrelated ${n}`, body: "", html_url: issueUrl }));
  f.issueResponse = payload => {
    f.issues.push({ ...payload, state: "closed", html_url: issueUrl });
    throw new Error("response lost");
  };
  assert.deepEqual((await f.run(23)).failed, [{ skill: "github", error: "network" }]);
  assert.equal(f.state().github.issue_sha256, undefined);
  assert.deepEqual((await f.run(24)).issues, [issueUrl]);
  assert.equal(f.state().github.issue_sha256, hash("changed"));
  assert.equal(f.calls.filter(call => call.method === "POST" && call.url.endsWith("/issues")).length, 1);
  assert.equal(f.calls.filter(call => call.url.includes("systemone")).length, 1);
});

test("watch fails closed on issue lookup errors rather than risking duplicate creation", async t => {
  const f = fixture(t);
  await f.run();
  f.document = "changed";
  f.listResponse = () => new Response("private error", { status: 503 });
  assert.deepEqual((await f.run(23)).failed, [{ skill: "github", error: "http" }]);
  assert.equal(f.calls.filter(call => call.method === "POST" && call.url.endsWith("/issues")).length, 0);
  f.listResponse = null;
  assert.deepEqual((await f.run(24)).issues, [issueUrl]);
});

test("watch refuses unbound or tampered source lists and corrupt release inventories", async t => {
  for (const corruption of ["body", "unlisted", "inventory"]) {
    await t.test(corruption, async t => {
      const f = fixture(t);
      const key = `releases/${commit}/watch-sources.json`;
      if (corruption === "body") f.objects.set(key, JSON.stringify({ sources: [{ skill: "github", url: "https://untrusted.example" }] }));
      if (corruption === "unlisted") {
        const body = f.objects.get(key);
        f.objects.delete(key);
        f.sealRelease();
        f.objects.set(key, body);
      }
      if (corruption === "inventory") {
        const key = `releases/${commit}/inventory.json`;
        f.objects.set(key, f.objects.get(key).replace("fixture.1", "fixture.2"));
      }
      const report = await f.run();
      assert.deepEqual(report.failed, [{ skill: corruption === "inventory" ? "current" : "watch-sources", error: "unavailable" }]);
      assert.equal(f.calls.length, 0);
      assert.equal(f.objects.has("watch/state.json"), false);
    });
  }
});
