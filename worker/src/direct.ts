import { corsHeaders, jsonResponse, readBody, validBearer } from "./http.ts";
import { ReleaseError } from "./r2-objects.ts";
import { canonicalUri, mimeType, readDirectory, readResource, readSnapshot, resolveAlias } from "./release-reader.ts";
import { skillWrite, writeTools } from "./skill-writer.ts";
import { publisherFetch } from "./release-publisher.ts";
import { runWatch } from "./watch.ts";
import type { WatchEnv } from "./watch.ts";

export interface DirectEnv {
  SKILLS_BUCKET: R2Bucket;
  GISUL_BEARER_TOKEN: string;
  GISUL_PUBLISH_TOKEN?: string;
  GISUL_WRITE_TOKEN?: string;
  GISUL_GITHUB_TOKEN?: string;
  GISUL_SERVER_VERSION?: string;
  GISUL_ALLOWED_ORIGINS?: string;
}

const MODERN_VERSION = "2026-07-28";
const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_KEY = "io.modelcontextprotocol/clientCapabilities";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const cacheMethods = new Set(["server/discover", "skills/list", "skills/get", "resources/list", "resources/read", "tools/list"]);
function decodeHeader(value: string | null): string | null {
  if (!value?.startsWith("=?base64?")) return value;
  const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
  try {
    if (!match || btoa(atob(match[1])) !== match[1]) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(match[1]), c => c.charCodeAt(0)));
  } catch { return null; }
}
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

function rpcError(request: Request, id: Rpc["id"], code: number, message: string, status = 200, data?: unknown): Response {
  return jsonResponse(request, { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(runWatch(env, new Date()));
  },
  async fetch(request: Request, env: DirectEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/")) return publisherFetch(request, env);
    if (url.pathname === "/healthz") return jsonResponse(request, { ok: true, service: "gisul-worker", storage: "r2" });
    if (url.pathname !== "/mcp") return jsonResponse(request, { error: "Not Found" }, 404);
    const origin = request.headers.get("origin");
    const allowedOrigins = [url.origin, ...(env.GISUL_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean)];
    if (origin && !allowedOrigins.includes(origin)) return jsonResponse(request, { error: "Invalid origin" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (!env.GISUL_BEARER_TOKEN) return jsonResponse(request, { error: "MCP authentication is not configured" }, 503);
    const canWrite = !!env.GISUL_GITHUB_TOKEN && await validBearer(request, env.GISUL_WRITE_TOKEN ?? "");
    if (!canWrite && !await validBearer(request, env.GISUL_BEARER_TOKEN)) return jsonResponse(request, { error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
    if (request.method !== "POST") return jsonResponse(request, { error: "Method Not Allowed" }, 405, { allow: "POST" });
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return jsonResponse(request, { error: "Expected application/json" }, 415);
    const protocol = request.headers.get("mcp-protocol-version");
    let bytes: ArrayBuffer;
    try { bytes = await readBody(request, canWrite ? 1024 * 1024 : 64 * 1024); } catch { return jsonResponse(request, { error: "Request body is too large" }, 413); }
    let rpc: Rpc;
    try { rpc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return rpcError(request, null, -32700, "Parse error", 400); }
    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || (rpc.id !== undefined && rpc.id !== null && typeof rpc.id !== "string" && typeof rpc.id !== "number") || (rpc.params !== undefined && (!rpc.params || typeof rpc.params !== "object" || Array.isArray(rpc.params)))) return rpcError(request, null, -32600, "Invalid Request", 400);
    const params = rpc.params ?? {};
    const meta = object(params._meta) ? params._meta : {};
    const modern = rpc.method === "server/discover" || VERSION_KEY in meta || CAPS_KEY in meta || !!(protocol && protocol >= MODERN_VERSION);
    if (modern) {
      const accept = request.headers.get("accept") ?? "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return jsonResponse(request, { error: "Expected JSON and event-stream accept types" }, 406);
      if (typeof meta[VERSION_KEY] !== "string" || !object(meta[CAPS_KEY])) return rpcError(request, rpc.id, -32602, "Required request metadata is missing or invalid", 400);
      const named = ["tools/call", "resources/read", "prompts/get"].includes(rpc.method);
      if (protocol !== meta[VERSION_KEY] || request.headers.get("mcp-method") !== rpc.method || (named && decodeHeader(request.headers.get("mcp-name")) !== (params.name ?? params.uri))) return rpcError(request, rpc.id, -32020, "Request headers do not match the body", 400);
      if (meta[VERSION_KEY] !== MODERN_VERSION) return rpcError(request, rpc.id, -32022, "Unsupported protocol version", 400, { supported: [MODERN_VERSION], requested: meta[VERSION_KEY] });
    } else if (protocol && !versions.includes(protocol)) return rpcError(request, rpc.id, -32600, "Unsupported MCP protocol version", 400);
    if (rpc.id === undefined) return jsonResponse(request, undefined, 202);
    const serverInfo = { name: "gisul", version: env.GISUL_SERVER_VERSION ?? "0.2.0" };
    const capabilities = { ...(canWrite ? { tools: { listChanged: false } } : {}), resources: { listChanged: false }, extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } } };
    const respond = (result: Record<string, unknown>) => jsonResponse(request, { jsonrpc: "2.0", id: rpc.id, result: modern ? {
      ...result, resultType: "complete",
      ...(cacheMethods.has(rpc.method) ? { ttlMs: 30_000, cacheScope: "private" } : {}),
      _meta: { ...(object(result._meta) ? result._meta : {}), "io.modelcontextprotocol/serverInfo": serverInfo },
    } : result });
    if (rpc.method === "server/discover") return respond({ supportedVersions: [MODERN_VERSION], capabilities });
    if (rpc.method === "initialize") return respond({
      protocolVersion: versions.includes(String(params.protocolVersion)) ? params.protocolVersion : versions[0],
      serverInfo: { name: "gisul", version: env.GISUL_SERVER_VERSION ?? "0.2.0" },
      capabilities,
      instructions: "Remote workflow skills. Discover metadata with skills/list, load a selected manifest with skills/get, then read supporting resources only when needed. Keep the returned commit in params._meta['io.gisul/commit'] for subsequent resource reads.",
    });
    if (rpc.method === "ping") return respond({});
    if (rpc.method === "tools/list") return respond({ tools: canWrite ? writeTools : [] });
    if (rpc.method === "tools/call") {
      if (!canWrite) return rpcError(request, rpc.id, -32001, "A configured write credential is required", 403);
      try {
        const result = await skillWrite(env, String(params.name), params.arguments);
        return respond({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      } catch (error) {
        return respond({ content: [{ type: "text", text: error instanceof ReleaseError ? error.message : "Skill write failed" }], isError: true });
      }
    }
    if (!["skills/list", "skills/get", "resources/list", "resources/read", "resources/directory/read"].includes(rpc.method)) return rpcError(request, rpc.id, -32601, "Method not found", modern ? 404 : 200);
    try {
      if (params._meta !== undefined && (!params._meta || typeof params._meta !== "object" || Array.isArray(params._meta))) throw new ReleaseError("Invalid request metadata", 400);
      const pin = (params._meta as Record<string, unknown> | undefined)?.["io.gisul/commit"];
      const snapshot = await readSnapshot(env.SKILLS_BUCKET, pin);
      const _meta = { release: snapshot.identity.release, commit: snapshot.identity.commit, server_version: env.GISUL_SERVER_VERSION ?? "0.2.0" };
      if (rpc.method === "skills/list") {
        if (params.cursor !== undefined) throw new ReleaseError("This catalog is complete and has no cursor", 400);
        return respond({ resultType: "complete", skills: snapshot.inventory.skills, _meta });
      }
      if (rpc.method === "resources/list") return respond({ resources: [...snapshot.files.keys()].sort().map(uri => ({ uri, name: decodeURIComponent(uri.split("/").at(-1)!), mimeType: mimeType(uri) })), _meta });
      const uri = canonicalUri(params.uri);
      if (rpc.method === "skills/get") {
        const target = resolveAlias(snapshot.inventory, uri);
        const skill = snapshot.inventory.skills.find(skill => skill.uri === target)!;
        return respond({ resultType: "complete", skill, _meta: { ..._meta, ...(target !== uri ? { movedFrom: uri } : {}) } });
      }
      if (rpc.method === "resources/directory/read") return respond({ resultType: "complete", resources: readDirectory(snapshot, uri), _meta });
      return respond({ contents: [await readResource(env.SKILLS_BUCKET, snapshot, uri)], _meta });
    } catch (error) {
      const invalid = error instanceof ReleaseError && [400, 404].includes(error.status);
      return rpcError(request, rpc.id, invalid ? -32602 : -32603, error instanceof ReleaseError ? error.message : "Release could not be read or verified", modern ? (invalid ? 400 : 500) : 200);
    }
  },
} satisfies ExportedHandler<WatchEnv>;
