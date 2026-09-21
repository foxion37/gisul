import type { DirectEnv } from "./direct.ts";
import { BodyTooLargeError, readBody } from "./http.ts";
import { readSnapshot } from "./release-reader.ts";
import type { Snapshot } from "./release-reader.ts";
import { readVerifiedObject, releaseKey, sha256 } from "./r2-objects.ts";

export type WatchEnv = DirectEnv & {
  TYPESAFE_API_KEY?: string;
  GISUL_GITHUB_TOKEN?: string;
  GISUL_WATCH_REPO?: string;
};
export type WatchReport = {
  checked: number;
  changed: string[];
  contradicted: string[];
  issues: string[];
  failed: { skill: string; error: string }[];
};
type WatchSource = { skill: string; url: string };
type Judgment = { sha256: string; noul: number; commit: string };
type WatchEntry = {
  url: string;
  sha256: string;
  checked_at: string;
  changed_at?: string;
  baseline_sha256?: string;
  previous_sha256?: string;
  judgment?: Judgment;
  issue_sha256?: string;
};
type WatchState = Record<string, WatchEntry>;
type Failure = "invalid-url" | "redirect" | "http" | "network" | "too-large" | "unavailable";
class WatchError extends Error {
  readonly category: Failure;
  constructor(category: Failure) { super(category); this.category = category; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const limit = 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

function documentUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new WatchError("invalid-url"); }
  if (url.protocol !== "https:" || url.username || url.password || /^https:\/\/[^/?#]*@/i.test(value) || value.includes("?") || value.includes("#") || /[\\\x00-\x20\x7f]/.test(value)) throw new WatchError("invalid-url");
}

async function responseText(url: string, init?: RequestInit): Promise<string> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "manual" }); }
  catch { throw new WatchError("network"); }
  let error: Failure | undefined;
  if (response.status >= 300 && response.status < 400) error = "redirect";
  else if (!response.ok) error = "http";
  else if (!init && !/^text\//i.test(response.headers.get("content-type") ?? "")) error = "http";
  else if (Number(response.headers.get("content-length")) > limit) error = "too-large";
  if (error) {
    await response.body?.cancel().catch(() => {});
    throw new WatchError(error);
  }
  let bytes: ArrayBuffer;
  try { bytes = await readBody(response, limit); }
  catch (error) { throw new WatchError(error instanceof BodyTooLargeError ? "too-large" : "network"); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new WatchError("http"); }
}

async function releaseText(env: WatchEnv, snapshot: Snapshot, path: string): Promise<string> {
  const file = snapshot.inventory.files.find(file => file.path === path);
  if (!file) throw new WatchError("unavailable");
  const bytes = await readVerifiedObject(env.SKILLS_BUCKET, releaseKey(snapshot.identity.commit, path), file);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function contradiction(env: WatchEnv, snapshot: Snapshot, source: WatchSource, document: string): Promise<number> {
  if (!env.TYPESAFE_API_KEY) throw new WatchError("unavailable");
  const procedure = await releaseText(env, snapshot, `${source.skill}/SKILL.md`);
  const text = await responseText("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest",
      state: { cached_procedure: procedure.slice(0, 12000), current_document: document.slice(0, 12000) },
      questions: { contradicts: {
        type: "noul",
        instructions: "Does `current_document` contradict any step in `cached_procedure`?",
        criteria: { true: "a step, path, or command no longer matches", false: "steps still hold" },
      } },
    }),
  });
  const answer = JSON.parse(text)?.answers?.contradicts;
  if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new WatchError("unavailable");
  return answer.noul;
}

async function ensureIssue(env: WatchEnv, source: WatchSource, judgment: Judgment, previous: string): Promise<string> {
  const repo = env.GISUL_WATCH_REPO;
  if (!env.GISUL_GITHUB_TOKEN || !repo || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repo)) throw new WatchError("unavailable");
  const headers = {
    authorization: `Bearer ${env.GISUL_GITHUB_TOKEN}`,
    "content-type": "application/json",
    accept: "application/vnd.github+json",
    "user-agent": "gisul-watch",
  };
  const endpoint = `https://api.github.com/repos/${repo}/issues`;
  const title = `[portwright] stale candidate: ${source.skill}`;
  const identity = `New sha256: ${judgment.sha256}`;
  let issue: unknown;
  // Read all pages, including closed issues; search indexing can lag a lost POST response.
  for (let page = 1; ; page++) {
    const issues: unknown = JSON.parse(await responseText(`${endpoint}?state=all&per_page=100&page=${page}`, { method: "GET", headers }));
    if (!Array.isArray(issues)) throw new WatchError("unavailable");
    issue = issues.find(candidate => object(candidate) && !candidate.pull_request && candidate.title === title && typeof candidate.body === "string" && candidate.body.split(/\r?\n/).includes(identity));
    if (issue || issues.length < 100) break;
  }
  if (!issue) {
    issue = JSON.parse(await responseText(endpoint, {
      method: "POST", headers,
      body: JSON.stringify({
        title,
        body: [`URL: ${source.url}`, identity, `Previous sha256: ${previous}`, `noul: ${judgment.noul}`, `Release commit: ${judgment.commit}`].join("\n"),
      }),
    }));
  }
  const prefix = `https://github.com/${repo}/issues/`;
  if (!object(issue) || typeof issue.html_url !== "string" || !issue.html_url.startsWith(prefix) || !/^\d+$/.test(issue.html_url.slice(prefix.length))) throw new WatchError("unavailable");
  return issue.html_url;
}

export async function runWatch(env: WatchEnv, now: Date): Promise<WatchReport> {
  const report: WatchReport = { checked: 0, changed: [], contradicted: [], issues: [], failed: [] };
  const fail = (skill: string, error: unknown) => report.failed.push({ skill, error: error instanceof WatchError ? error.category : "unavailable" });
  let stage = "current";
  try {
    const snapshot = await readSnapshot(env.SKILLS_BUCKET);
    stage = "watch-sources";
    const manifestValue: unknown = JSON.parse(await releaseText(env, snapshot, "watch-sources.json"));
    if (!object(manifestValue) || !Array.isArray(manifestValue.sources)) throw new WatchError("unavailable");
    stage = "watch-state";
    const stored = await env.SKILLS_BUCKET.get("watch/state.json");
    const value: unknown = stored ? await stored.json() : {};
    if (!object(value)) throw new WatchError("unavailable");
    for (const entry of Object.values(value)) {
      if (!object(entry) || typeof entry.url !== "string" || typeof entry.sha256 !== "string" || !digestPattern.test(entry.sha256) || typeof entry.checked_at !== "string") throw new WatchError("unavailable");
      for (const key of ["baseline_sha256", "previous_sha256", "issue_sha256"]) {
        if (entry[key] !== undefined && (typeof entry[key] !== "string" || !digestPattern.test(entry[key]))) throw new WatchError("unavailable");
      }
      if (entry.judgment !== undefined) {
        const judgment = entry.judgment;
        if (!object(judgment) || typeof judgment.sha256 !== "string" || !digestPattern.test(judgment.sha256) || typeof judgment.noul !== "number" || !Number.isFinite(judgment.noul) || judgment.noul < 0 || judgment.noul > 1 || typeof judgment.commit !== "string" || !/^[a-f0-9]{40}$/.test(judgment.commit)) throw new WatchError("unavailable");
      }
    }
    const state: WatchState = Object.assign(Object.create(null), value);
    const checkedAt = now.toISOString();
    stage = "watch-sources";
    const seen = new Set<string>();
    for (const source of manifestValue.sources) {
      if (!object(source) || typeof source.skill !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(source.skill) || typeof source.url !== "string" || seen.has(source.skill)) throw new WatchError("unavailable");
      seen.add(source.skill);
    }
    for (const source of manifestValue.sources as WatchSource[]) {
      try {
        documentUrl(source.url);
        const document = await responseText(source.url);
        const digest = await sha256(document);
        report.checked++;
        const previous = state[source.skill];
        const changed = !!previous && previous.sha256 !== digest;
        const next: WatchEntry = {
          ...previous, url: source.url, sha256: digest, checked_at: checkedAt,
          ...(!previous ? { baseline_sha256: digest } : {}),
          ...(changed ? { changed_at: checkedAt, previous_sha256: previous.sha256 } : {}),
        };
        if (changed) delete next.baseline_sha256;
        state[source.skill] = next;
        if (changed) report.changed.push(source.skill);
        // Observation is not completion. Persist it before any paid or mutating call.
        await env.SKILLS_BUCKET.put("watch/state.json", JSON.stringify(state));
        if (next.issue_sha256 === digest || next.baseline_sha256 === digest) continue;
        if (next.judgment?.sha256 !== digest) {
          const noul = await contradiction(env, snapshot, source, document);
          next.judgment = { sha256: digest, noul, commit: snapshot.identity.commit };
          await env.SKILLS_BUCKET.put("watch/state.json", JSON.stringify(state));
        }
        if (next.judgment.noul < 0.7) continue;
        report.contradicted.push(source.skill);
        const issueUrl = await ensureIssue(env, source, next.judgment, next.previous_sha256 ?? previous.sha256);
        next.issue_sha256 = digest;
        await env.SKILLS_BUCKET.put("watch/state.json", JSON.stringify(state));
        report.issues.push(issueUrl);
      } catch (error) { fail(source.skill, error); }
    }
  } catch (error) { fail(stage, error); }
  console.log(JSON.stringify(report));
  return report;
}
