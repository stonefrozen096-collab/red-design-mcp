import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, extname, join, resolve, sep } from "node:path";
import { readBytes, safeFetch } from "./web.js";

export interface LoadedImage {
  base64: string;
  mediaType: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Identify an image by its file signature, never by its name. Returns null for anything else. */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head6 = buf.subarray(0, 6).toString("latin1");
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const isInside = (child: string, root: string) => {
  const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p);
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
};

/** Folders the server may read images from. Unset means anywhere, but only real image files. */
async function allowedRoots(): Promise<string[] | null> {
  const raw = process.env.RED_ALLOWED_DIRS?.trim();
  if (!raw) return null;
  const roots = [...raw.split(delimiter).filter(Boolean), join(tmpdir(), "red-design-mcp")];
  const real: string[] = [];
  for (const r of roots) {
    try {
      real.push(await realpath(resolve(r)));
    } catch {
      /* folder does not exist yet */
    }
  }
  return real;
}

/**
 * Load an image from a URL or a local path. Local reads are limited to PNG, JPEG, GIF and WebP files
 * (checked by extension and by file signature), so a prompt cannot use this to read arbitrary files.
 * Set RED_ALLOWED_DIRS to also confine reads to specific folders.
 */
export async function loadImage(source: string): Promise<LoadedImage> {
  if (/^https?:\/\//i.test(source)) {
    const res = await safeFetch(source);
    if (!res.ok) throw new Error(`Could not fetch image (${res.status})`);
    const buf = await readBytes(res, MAX_IMAGE_BYTES);
    const mediaType = sniffImage(buf);
    if (!mediaType) throw new Error("That URL did not return a PNG, JPEG, GIF or WebP image.");
    return { base64: buf.toString("base64"), mediaType };
  }

  const expanded = source.startsWith("~/") || source.startsWith("~\\") ? join(homedir(), source.slice(2)) : source;
  const real = await realpath(resolve(expanded)); // follows symlinks, so a link cannot point outside
  const name = basename(real);
  if (!IMAGE_EXTENSIONS.has(extname(real).toLowerCase())) {
    throw new Error(`Only image files (png, jpg, jpeg, gif, webp) can be read. "${name}" is not one.`);
  }
  const roots = await allowedRoots();
  if (roots && !roots.some((r) => isInside(real, r))) {
    throw new Error(`"${name}" is outside the folders allowed by RED_ALLOWED_DIRS.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`"${name}" is not a file.`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`"${name}" is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const buf = await readFile(real);
  const mediaType = sniffImage(buf);
  if (!mediaType) throw new Error(`"${name}" is not a PNG, JPEG, GIF or WebP image.`);
  return { base64: buf.toString("base64"), mediaType };
}

/* ---------------------------------- Providers ---------------------------------- */

export type ProviderId = "anthropic" | "openai" | "google" | "groq" | "openrouter" | "custom";
type Env = Record<string, string | undefined>;

export interface Provider {
  id: ProviderId;
  label: string;
  kind: "anthropic" | "openai-compat";
  baseUrl: string;
  key?: string;
  model: string;
  /** Name of the output-limit field this provider expects, or null to omit it. */
  tokenParam: "max_tokens" | "max_completion_tokens" | null;
}

// Everything except Anthropic speaks the OpenAI chat-completions format.
// Default models were checked against each provider's docs on 2026-10-31 and are the current
// balanced, image-capable picks. Providers rename models often: set RED_MODEL to choose your own,
// and run `npx red-design-mcp doctor --check` to confirm the model still exists.
const ANTHROPIC_DEFAULT = "claude-sonnet-5-5";
const PRESETS = {
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY"], model: "gpt-6.1-sol", tokenParam: null },
  google: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], model: "gemini-3.6-flash", tokenParam: "max_tokens" },
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY"], model: "qwen/qwen3.8-27b", tokenParam: "max_completion_tokens" },
  openrouter: { label: "OpenRouter", base: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY"], model: "anthropic/claude-sonnet-5.5", tokenParam: "max_tokens" },
} as const;

const AUTO_ORDER = ["anthropic", "openai", "google", "groq", "openrouter"] as const;

export const PROVIDER_HELP =
  "Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY, or set RED_BASE_URL (and RED_MODEL) for any OpenAI-compatible endpoint such as Ollama.";

/** Pick the model provider from the environment. Returns null for host mode (no provider). */
export function resolveProvider(env: Env = process.env): Provider | null {
  const model = env.RED_MODEL?.trim() || undefined;

  const anthropic = (): Provider | null =>
    env.ANTHROPIC_API_KEY
      ? { id: "anthropic", label: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", key: env.ANTHROPIC_API_KEY, model: model ?? ANTHROPIC_DEFAULT, tokenParam: "max_tokens" }
      : null;

  const preset = (id: keyof typeof PRESETS): Provider | null => {
    const p = PRESETS[id];
    const key = p.keys.map((k) => env[k]).find(Boolean);
    return key ? { id, label: p.label, kind: "openai-compat", baseUrl: p.base, key, model: model ?? p.model, tokenParam: p.tokenParam } : null;
  };

  const custom = (): Provider | null => {
    const base = env.RED_BASE_URL?.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
    return base
      ? { id: "custom", label: "Custom endpoint", kind: "openai-compat", baseUrl: base, key: env.RED_API_KEY, model: model ?? "", tokenParam: "max_tokens" }
      : null;
  };

  const forced = env.RED_PROVIDER?.trim().toLowerCase();
  if (forced) {
    if (forced === "anthropic") return anthropic();
    if (forced === "custom") return custom();
    return forced in PRESETS ? preset(forced as keyof typeof PRESETS) : null;
  }
  const c = custom();
  if (c) return c;
  for (const id of AUTO_ORDER) {
    const p = id === "anthropic" ? anthropic() : preset(id);
    if (p) return p;
  }
  return null;
}

export const hasApiKey = (): boolean => resolveProvider() !== null;

/* ------------------------------------ Calls ------------------------------------ */

const maxTokens = () => Number(process.env.RED_MAX_TOKENS) || 16000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(p: Provider, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const retryMs = Number(process.env.RED_RETRY_MS ?? 2000);
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await sleep(retryMs);
        continue;
      }
      if (!res.ok) throw new Error(`${p.label} error ${res.status}: ${(await res.text()).slice(0, 400)}`);
      return await res.json();
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new Error(`${p.label} timed out after 120s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${p.label} request failed`);
}

async function callAnthropic(p: Provider, image: LoadedImage | null, prompt: string): Promise<string> {
  const data = await post(
    p,
    `${p.baseUrl}/v1/messages`,
    { "x-api-key": p.key ?? "", "anthropic-version": "2023-06-01" },
    {
      model: p.model,
      max_tokens: maxTokens(),
      messages: [
        {
          role: "user",
          content: [
            ...(image ? [{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } }] : []),
            { type: "text", text: prompt },
          ],
        },
      ],
    }
  );
  return (data.content ?? []).map((b: any) => b.text ?? "").join("");
}

async function callCompat(p: Provider, image: LoadedImage | null, prompt: string): Promise<string> {
  if (!p.model) throw new Error("Set RED_MODEL to a vision-capable model name for your custom endpoint.");
  const data = await post(
    p,
    `${p.baseUrl}/chat/completions`,
    p.key ? { authorization: `Bearer ${p.key}` } : {},
    {
      model: p.model,
      ...(p.tokenParam ? { [p.tokenParam]: maxTokens() } : {}),
      messages: [
        {
          role: "user",
          content: [
            ...(image ? [{ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } }] : []),
            { type: "text", text: prompt },
          ],
        },
      ],
    }
  );
  const content = data.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : content;
  if (!text) throw new Error(`${p.label} returned an empty response. Check that "${p.model}" supports images.`);
  return text;
}

/** Provider-agnostic call. Works for text-only prompts when image is null. */
export async function askVision(image: LoadedImage | null, prompt: string): Promise<string> {
  const p = resolveProvider();
  if (!p) throw new Error(`No model provider configured. ${PROVIDER_HELP}`);
  return p.kind === "anthropic" ? callAnthropic(p, image, prompt) : callCompat(p, image, prompt);
}

/** List the model ids the configured provider offers (used by `doctor --check`). */
export async function listModels(p: Provider): Promise<string[]> {
  const url = p.kind === "anthropic" ? `${p.baseUrl}/v1/models?limit=1000` : `${p.baseUrl}/models`;
  const headers: Record<string, string> =
    p.kind === "anthropic" ? { "x-api-key": p.key ?? "", "anthropic-version": "2023-06-01" } : p.key ? { authorization: `Bearer ${p.key}` } : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${p.label} model list failed (HTTP ${res.status})`);
    const data: any = await res.json();
    const list: any[] = Array.isArray(data) ? data : data.data ?? data.models ?? [];
    return list.map((m) => String(m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
