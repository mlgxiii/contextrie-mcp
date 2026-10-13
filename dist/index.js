#!/usr/bin/env node

// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z as z3 } from "zod";

// src/format.ts
var confirmText = (r) => `${r.needsConfirm.files} files need indexing first (one model call each; the limit without confirmation is ${r.needsConfirm.limit}). Ask the user, then call \`index\` with \`confirm: true\`, or retry with \`paths\` to narrow the search (e.g. ["src/**"]). Files can also be excluded in \`.contextrieignore\`.`;
var failures = (label, list) => list.length ? [`${label} (${list.length}, left out):`, ...list.slice(0, 10).map((f) => `- ${f.path}: ${f.error}`), ...list.length > 10 ? [`- \u2026and ${list.length - 10} more`] : []] : [];
function formatSelection(s) {
  if (s.needsConfirm) return confirmText(s);
  return [
    `Contextrie picked ${s.selected.length} of ${s.total} files for: "${s.task}"`,
    ...s.pinned.length ? ["", "Project instructions (always listed):", ...s.pinned.map((p) => `- ${p}`)] : [],
    "",
    "Ranked (score 0\u20131: reason):",
    ...s.selected.map((f, i) => `${i + 1}. ${f.path} \xB7 ${f.score.toFixed(2)}: ${f.reason}`),
    ...s.selected.length ? [] : ["(nothing could be judged)"],
    "",
    `Index: ${s.indexed} file(s) (re)indexed now, the rest from cache.`,
    ...failures("Failed to index", s.failed),
    ...failures("Failed to judge", s.judgeFailed),
    "",
    "Scores come from file summaries, not full text: read the top files, and search beyond them if the task needs it."
  ].join("\n");
}
function formatIndex(r) {
  if (r.needsConfirm) return confirmText(r);
  return [`Indexed ${r.indexed} new or changed file(s); ${r.total - r.indexed - r.failed.length} from cache; ${r.total} candidates.`, ...failures("Failed to index", r.failed)].join("\n");
}

// src/model.ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel } from "ai";
var NO_KEY = "Contextrie needs a model key: set ANTHROPIC_API_KEY or OPENAI_API_KEY in the MCP server env.";
function model() {
  const { ANTHROPIC_API_KEY, OPENAI_API_KEY, CONTEXTRIE_MODEL } = process.env;
  const base = ANTHROPIC_API_KEY ? anthropic(CONTEXTRIE_MODEL ?? "claude-haiku-5-5") : OPENAI_API_KEY ? openai(CONTEXTRIE_MODEL ?? "gpt-4.1-mini") : void 0;
  if (!base) throw new Error(NO_KEY);
  return wrapLanguageModel({
    model: base,
    middleware: { specificationVersion: "v3", transformParams: async ({ params }) => ({ ...params, temperature: 0 }) }
  });
}

// node_modules/@contextrie/core/types/source.ts
var IndexedSourceBase = class {
  /**
   * @param id Unique source ID
   * @param metadata Optional metadata; missing metadata means source is draft.
   * @param path Optional source provenance path
   */
  constructor(id, metadata, path) {
    this.id = id;
    this.metadata = metadata;
    this.path = path;
  }
  id;
  metadata;
  path;
  /** True when source has not been indexed yet. */
  get isDraft() {
    return !this.metadata;
  }
};

// node_modules/@contextrie/core/sources/document.ts
var DocumentSource = class extends IndexedSourceBase {
  /**
   * @param id Unique source ID
   * @param metadata Generated metadata for the source
   * @param content Document text
   */
  constructor(id, metadata, content, path) {
    super(id, metadata, path);
    this.content = content;
  }
  content;
  kind = "document";
  get isIterable() {
    return false;
  }
  /** Returns the document text. */
  getContent = () => this.content;
  buildIndexInput() {
    return this.content;
  }
  buildDeepJudgeInput() {
    return this.content;
  }
};

// node_modules/@contextrie/core/agents/judge/index.ts
import { generateText, Output } from "ai";
import { z } from "zod";

// node_modules/@contextrie/core/agents/judge/types.ts
var JudgeTaskPromptRecord = {
  response: "Judge whether this source is useful for producing a direct, high-quality response to the input.",
  proof: "Judge whether this source materially supports, verifies, or grounds the input with evidence.",
  other: "Judge whether this source is meaningfully relevant to the input and objective."
};

// node_modules/@contextrie/core/agents/judge/index.ts
var DEFAULT_JUDGE_PROMPT = `Judge source relevance for a task.

Return ONLY valid JSON with this exact shape:
{
  "score": number,
  "reason": string
}

Rules:
- score must be between 0 and 1
- reason must be concise and factual
- use only the provided task and source information
- no markdown, no code fences, no extra keys`;
var judgeDecisionSchema = z.object({
  score: z.number().min(0).max(1),
  reason: z.string()
});
var JudgeAgent = class {
  constructor(model2, prompt = DEFAULT_JUDGE_PROMPT) {
    this.model = model2;
    this.prompt = prompt;
  }
  model;
  prompt;
  queue = [];
  deepQueue = [];
  from = (source) => {
    if (Array.isArray(source)) this.queue.push(...source);
    else this.queue.push(source);
    return this;
  };
  fromDeep = (source) => {
    if (Array.isArray(source)) this.deepQueue.push(...source);
    else this.deepQueue.push(source);
    return this;
  };
  deep = () => {
    this.deepQueue.push(...this.queue);
    this.queue = [];
    return this;
  };
  clear = () => {
    this.queue = [];
    this.deepQueue = [];
    return this;
  };
  buildShallowPrompt = (task, source) => {
    const metadata = source.metadata;
    if (!metadata) {
      throw new Error(
        `[JudgeAgent] shallow source ${source.id} is missing metadata`
      );
    }
    return `${this.prompt}

Task objective: ${task.objective}
Task input: ${task.input}
Task guidance: ${JudgeTaskPromptRecord[task.objective]}

Source ID: ${source.id}
Source kind: ${source.kind}
Source title: ${metadata.title}
Source description: ${metadata.description}
Source keypoints:
${metadata.keypoints.map((point) => `- ${point}`).join("\n")}`;
  };
  buildDeepPrompt = async (task, source) => {
    const content = await source.buildDeepJudgeInput();
    return `${this.prompt}

Task objective: ${task.objective}
Task input: ${task.input}
Task guidance: ${JudgeTaskPromptRecord[task.objective]}

Source ID: ${source.id}
Source kind: ${source.kind}

Source content:
${content}`;
  };
  async judgeDeepSource(task, source) {
    console.info(
      `[JudgeAgent] starting deep judgment for source ${source.id} (${source.kind})`
    );
    try {
      const prompt = await this.buildDeepPrompt(task, source);
      const { output } = await generateText({
        model: this.model,
        output: Output.object({ schema: judgeDecisionSchema }),
        prompt
      });
      console.info(
        `[JudgeAgent] completed deep judgment for source ${source.id} with score ${output.score}`
      );
      return output;
    } catch (error) {
      console.error(
        `[JudgeAgent] deep judgment failed for source ${source.id} (${source.kind})`,
        error
      );
      throw error;
    }
  }
  async judgeShallowSource(task, source) {
    console.info(
      `[JudgeAgent] starting shallow judgment for source ${source.id} (${source.kind})`
    );
    try {
      const prompt = this.buildShallowPrompt(task, source);
      const { output } = await generateText({
        model: this.model,
        output: Output.object({ schema: judgeDecisionSchema }),
        prompt
      });
      console.info(
        `[JudgeAgent] completed shallow judgment for source ${source.id} with score ${output.score}`
      );
      return output;
    } catch (error) {
      console.error(
        `[JudgeAgent] shallow judgment failed for source ${source.id} (${source.kind})`,
        error
      );
      throw error;
    }
  }
  async run(task) {
    const shallowCount = this.queue.length;
    const deepCount = this.deepQueue.length;
    const totalCount = shallowCount + deepCount;
    const results = {};
    const failures2 = [];
    console.info(`[JudgeAgent] judging ${totalCount} source(s)`);
    try {
      const shallowJobs = this.queue.map(async (source) => {
        try {
          results[source.id] = await this.judgeShallowSource(task, source);
        } catch {
          failures2.push(source);
        }
      });
      const deepJobs = this.deepQueue.map(async (source) => {
        try {
          results[source.id] = await this.judgeDeepSource(task, source);
        } catch {
          failures2.push(source);
        }
      });
      await Promise.all([...shallowJobs, ...deepJobs]);
      if (failures2.length > 0) {
        console.error(
          `[JudgeAgent] ${failures2.length}/${totalCount} judgment(s) failed for task objective ${task.objective}: ${failures2.map((source) => `${source.id} (${source.kind})`).join(", ")}`
        );
        throw new Error(
          `[JudgeAgent] failed ${failures2.length} of ${totalCount} judgment(s)`
        );
      }
      console.info(`[JudgeAgent] completed judging ${totalCount} source(s)`);
      return results;
    } catch (error) {
      console.error(
        `[JudgeAgent] failed while judging sources for task objective ${task.objective}`,
        error
      );
      throw error;
    } finally {
      this.clear();
    }
  }
};

// node_modules/@contextrie/core/agents/indexing/index.ts
import { generateText as generateText2, Output as Output2 } from "ai";
import { z as z2 } from "zod";
var DEFAULT_INDEXING_PROMPT = `Generate metadata for retrieval.

Return ONLY valid JSON with this exact shape:
{
  "title": string,
  "description": string,
  "keypoints": string[]
}

Rules:
- title: specific and concise (max 80 chars)
- description: 1-2 factual sentences about what this source contains and when to use it
- keypoints: 3-7 short strings with the most relevant facts, constraints, entities, or decisions
- prioritize information that helps relevance filtering
- use only provided content
- no markdown, no code fences, no extra keys`;
var metadataSchema = z2.object({
  title: z2.string(),
  description: z2.string(),
  keypoints: z2.array(z2.string())
});
var IndexingAgent = class {
  constructor(model2, prompt = DEFAULT_INDEXING_PROMPT) {
    this.model = model2;
    this.prompt = prompt;
  }
  model;
  prompt;
  queue = [];
  add = (source) => {
    if (Array.isArray(source)) this.queue.push(...source);
    else this.queue.push(source);
    return this;
  };
  clear = () => {
    this.queue = [];
    return this;
  };
  generateMetadata = async (source) => {
    const input = await source.buildIndexInput();
    const { output } = await generateText2({
      model: this.model,
      output: Output2.object({ schema: metadataSchema }),
      prompt: `${this.prompt}

Source ID: ${source.id}
Source kind: ${source.kind}

Source content:
${input}`
    });
    return output;
  };
  async run() {
    console.info(`[IndexingAgent] indexing ${this.queue.length} source(s)`);
    const failedSources = [];
    const successfulResults = [];
    await Promise.all(
      this.queue.map(async (source) => {
        try {
          console.info(`[IndexingAgent] indexing source ${source.id} (${source.kind})`);
          const metadata = await this.generateMetadata(source);
          source.metadata = metadata;
          successfulResults.push(source);
          console.info(`[IndexingAgent] indexed source ${source.id}`);
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error);
          console.error(`[IndexingAgent] failed to index source ${source.id}: ${message2}`);
          failedSources.push(source);
        }
      })
    );
    console.info(
      `[IndexingAgent] completed indexing ${successfulResults.length}/${this.queue.length} source(s), failed: ${failedSources.length}`
    );
    this.clear();
    return successfulResults;
  }
};

// src/select.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, matchesGlob, relative } from "node:path";
var MAX_FILE = 1e6;
var INDEX_CHARS = 32e3;
var PINNED = [/^readme(\.\w+)?$/i, /^claude\.md$/i, /^agents\.md$/i, /^\.cursorrules$/, /^\.cursor\/rules\//, /^\.github\/copilot-instructions\.md$/];
var SKIP_NAMES = /* @__PURE__ */ new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum", ".DS_Store"]);
var SKIP_EXT = new Set(
  "png jpg jpeg gif webp avif ico bmp tiff psd svg pdf zip gz tgz bz2 xz 7z rar jar woff woff2 ttf otf eot mp3 mp4 wav ogg mov webm avi db sqlite sqlite3 wasm so dylib dll exe bin class pyc map lockb".split(" ").map((e) => `.${e}`)
);
var SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|\.next|\.svelte-kit|\.git|\.contextrie|vendor|coverage|__pycache__)\//;
var sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
var normalise = (task) => task.trim().replace(/\s+/g, " ").toLowerCase();
var message = (e) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    })
  );
}
var Repo = class {
  root;
  dir;
  opts;
  model;
  constructor(opts) {
    this.opts = opts;
    this.root = gitRoot(opts.root) ?? opts.root;
    this.dir = join(this.root, ".contextrie");
  }
  getModel = () => this.model ??= this.opts.model();
  progress = (done, total, msg) => this.opts.onProgress?.(done, total, msg);
  /** Text files worth indexing: git-tracked or untracked-but-not-ignored, minus binaries, lockfiles and build output. */
  files() {
    const listed = gitFiles(this.root) ?? walk(this.root);
    const ignore = readIgnore(this.root);
    return listed.filter((p) => !SKIP_DIRS.test(p) && !SKIP_NAMES.has(p.split("/").pop()) && !SKIP_EXT.has(extname(p).toLowerCase())).filter((p) => !/\.min\.(js|css)$/.test(p) && !ignore.some((g) => matchesGlob(p, g))).sort();
  }
  isPinned = (path) => PINNED.some((re) => re.test(path));
  loadIndex() {
    const file = join(this.dir, "sources.json");
    try {
      const { sources } = JSON.parse(readFileSync(file, "utf8"));
      return new Map((sources ?? []).filter((s) => s.hash && s.metadata).map((s) => [s.path, s]));
    } catch {
      return /* @__PURE__ */ new Map();
    }
  }
  save(name, data) {
    mkdirSync(this.dir, { recursive: true });
    const ignore = join(this.dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "judgments.json\nconfig.json\n");
    writeFileSync(join(this.dir, name), JSON.stringify(data, null, 2));
  }
  /** Read a candidate file; undefined for binaries, empty and oversized files. */
  read(path) {
    try {
      const full = join(this.root, path);
      const size = statSync(full).size;
      if (!size || size > MAX_FILE) return;
      const text = readFileSync(full, "utf8");
      return text.includes("\0") ? void 0 : text;
    } catch {
      return;
    }
  }
  /**
   * Index new or changed files (one model call each), reusing cached metadata for the rest.
   * Returns the indexed sources; failures are reported, not swallowed.
   */
  async index({ paths, confirm = false } = {}) {
    const cache = this.loadIndex();
    const candidates = this.files().filter((p) => !this.isPinned(p) && (!paths?.length || paths.some((g) => matchesGlob(p, g))));
    const entries = candidates.map((path) => {
      const text = this.read(path);
      if (text === void 0) return;
      const hash = sha(text);
      const hit = cache.get(path)?.hash === hash ? cache.get(path).metadata : void 0;
      const body = text.length > INDEX_CHARS ? `${text.slice(0, INDEX_CHARS)}
[\u2026 truncated, ${text.length} chars]` : text;
      return { path, hash, source: new DocumentSource(path, hit, body, path) };
    }).filter((e) => e !== void 0);
    const report = { total: entries.length, indexed: 0, failed: [] };
    const stale = entries.filter((e) => e.source.isDraft);
    const limit = this.opts.maxIndex ?? 500;
    if (stale.length > limit && !confirm) return { report: { ...report, needsConfirm: { files: stale.length, limit } }, sources: [] };
    if (stale.length) {
      const indexer = new IndexingAgent(this.getModel());
      let done = 0;
      await pool(stale, this.opts.concurrency ?? 64, async (e) => {
        try {
          e.source.metadata = await indexer.generateMetadata(e.source);
          report.indexed++;
        } catch (err) {
          report.failed.push({ path: e.path, error: message(err) });
        }
        this.progress(++done, stale.length, `Indexing ${e.path}`);
      });
      const present = new Set(this.files());
      for (const e of entries) if (e.source.metadata) cache.set(e.path, { id: e.path, kind: "document", format: /\.mdx?$/.test(e.path) ? "markdown" : "text", path: e.path, metadata: e.source.metadata, hash: e.hash });
      const sources = [...cache.values()].filter((s) => present.has(s.path)).sort((a, b) => a.path.localeCompare(b.path));
      this.save("sources.json", { version: 1, sources });
    }
    report.failed.sort((a, b) => a.path.localeCompare(b.path));
    return { report, sources: entries.filter((e) => e.source.metadata) };
  }
  /** Rank the files for a task. Keeps the top 3 plus anything scoring ≥ 0.3, at most `limit`. */
  async select(task, { limit = 8, paths, confirm } = {}) {
    const pinned = this.files().filter(this.isPinned);
    const { report, sources } = await this.index({ paths, confirm });
    const base = { ...report, task, pinned, selected: [], judgeFailed: [] };
    if (report.needsConfirm) return base;
    const cacheFile = join(this.dir, "judgments.json");
    let judgments = {};
    try {
      judgments = JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch {
    }
    const key = (hash) => sha(`${normalise(task)}|${hash}`);
    const todo = sources.filter((s) => !judgments[key(s.hash)]);
    if (todo.length) {
      const model2 = this.getModel();
      let done = 0;
      await pool(todo, this.opts.concurrency ?? 64, async (s) => {
        try {
          const out = await new JudgeAgent(model2).from(s.source).run({ objective: "other", input: task });
          judgments[key(s.hash)] = out[s.path];
        } catch (err) {
          base.judgeFailed.push({ path: s.path, error: message(err) });
        }
        this.progress(++done, todo.length, `Judging ${s.path}`);
      });
      this.save("judgments.json", Object.fromEntries(Object.entries(judgments).slice(-2e4)));
    }
    const ranked = sources.filter((s) => judgments[key(s.hash)]).map((s) => ({ path: s.path, ...judgments[key(s.hash)] })).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    base.selected = ranked.filter((r, i) => i < 3 || r.score >= 0.3).slice(0, Math.max(1, limit));
    base.judgeFailed.sort((a, b) => a.path.localeCompare(b.path));
    return base;
  }
};
function gitRoot(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return;
  }
}
function gitFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.split("\0").filter((p) => p && existsSync(join(root, p)));
  } catch {
    return;
  }
}
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      const rel = relative(root, full);
      if (name.isDirectory()) {
        if (!name.name.startsWith(".") && !SKIP_DIRS.test(`${rel}/`)) visit(full);
      } else if (name.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out;
}
function readIgnore(root) {
  try {
    return readFileSync(join(root, ".contextrieignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((g) => g.endsWith("/") ? `${g}**` : g);
  } catch {
    return [];
  }
}

// src/index.ts
console.info = console.log = (...args) => {
  if (process.env.DEBUG) console.error(...args);
};
var env = (name) => process.env[name] ? Number(process.env[name]) : void 0;
var repoFor = (onProgress) => new Repo({
  root: process.env.CONTEXTRIE_ROOT ?? process.cwd(),
  model,
  maxIndex: env("CONTEXTRIE_MAX_INDEX"),
  concurrency: env("CONTEXTRIE_CONCURRENCY"),
  onProgress
});
var progressOf = (extra) => {
  const token = extra._meta?.progressToken;
  if (token === void 0) return;
  return (progress, total, message2) => void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message: message2 } }).catch(() => {
  });
};
var failure = (e) => ({ isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
var server = new McpServer({ name: "contextrie", version: "0.1.0" });
server.registerTool(
  "select_context",
  {
    title: "Select context",
    description: "Call this at the start of a task, before searching the codebase. Returns the files and docs in this repo worth reading for the task, ranked, each with a relevance score (0\u20131) and a reason. Project instructions (README, CLAUDE.md, AGENTS.md) are always listed. Pass the task as the user stated it, plus any detail you already know.",
    inputSchema: {
      task: z3.string().min(3).describe('The task, in plain words (e.g. "add rate limiting to the upload endpoint").'),
      limit: z3.number().int().min(1).max(30).optional().describe("Maximum ranked files (default 8)."),
      paths: z3.array(z3.string()).optional().describe('Globs to restrict the search to, e.g. ["src/**", "docs/**"].')
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ task, limit, paths }, extra) => {
    try {
      const s = await repoFor(progressOf(extra)).select(task, { limit, paths });
      return { content: [{ type: "text", text: formatSelection(s) }] };
    } catch (e) {
      return failure(e);
    }
  }
);
server.registerTool(
  "index",
  {
    title: "Index repository",
    description: "Index new or changed files so select_context answers fast. select_context does this itself; call this to confirm a large first index (confirm: true) or to warm the cache.",
    inputSchema: {
      confirm: z3.boolean().optional().describe("Allow indexing more files than CONTEXTRIE_MAX_INDEX (default 500). One model call per file."),
      paths: z3.array(z3.string()).optional().describe("Globs to restrict indexing to.")
    },
    annotations: { readOnlyHint: false, openWorldHint: false }
  },
  async ({ confirm, paths }, extra) => {
    try {
      const { report } = await repoFor(progressOf(extra)).index({ confirm, paths });
      return { content: [{ type: "text", text: formatIndex(report) }] };
    } catch (e) {
      return failure(e);
    }
  }
);
await server.connect(new StdioServerTransport());
