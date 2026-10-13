// Repo files → Contextrie sources → the files worth reading for a task.
//
// One DocumentSource per file with its path as a stable id, indexing
// metadata cached by content hash, shallow judging on that metadata. On top of it, this works around the
// Contextrie issues a server can't live with: per-file errors are returned (contextrie#58), judging runs at temperature 0
// and is cached so the same task gives the same list (contextrie#65), and project instructions are always listed (contextrie#62).
import { DocumentSource, IndexingAgent, JudgeAgent, type Metadata } from '@contextrie/core';
import type { LanguageModel } from 'ai';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, matchesGlob, relative } from 'node:path';

type JudgeDecision = { score: number; reason: string };

export interface Selected {
	path: string;
	score: number;
	reason: string;
}
export interface Failure {
	path: string;
	error: string;
}
export interface IndexReport {
	/** Files that are candidates for selection (after skips and `paths`). */
	total: number;
	/** Files indexed by this call (new or changed). */
	indexed: number;
	/** Files that failed to index; they are left out of the ranking. */
	failed: Failure[];
	/** Set when more files need indexing than CONTEXTRIE_MAX_INDEX allows without confirmation. */
	needsConfirm?: { files: number; limit: number };
}
export interface Selection extends IndexReport {
	task: string;
	pinned: string[];
	selected: Selected[];
	/** Judgments that failed; those files are left out of the ranking. */
	judgeFailed: Failure[];
}

export interface RepoOptions {
	root: string;
	/** Created only when a model call is needed, so a missing key fails late and writes nothing. */
	model: () => LanguageModel;
	/** Files that may be indexed in one call without `confirm` (default 500). */
	maxIndex?: number;
	/** Model calls in flight (default 64). */
	concurrency?: number;
	onProgress?: (done: number, total: number, message: string) => void;
}

const MAX_FILE = 1_000_000; // skip anything larger
const INDEX_CHARS = 32_000; // index the first ~8k tokens of a file
const PINNED = [/^readme(\.\w+)?$/i, /^claude\.md$/i, /^agents\.md$/i, /^\.cursorrules$/, /^\.cursor\/rules\//, /^\.github\/copilot-instructions\.md$/];
const SKIP_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'poetry.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', '.DS_Store']);
const SKIP_EXT = new Set(
	'png jpg jpeg gif webp avif ico bmp tiff psd svg pdf zip gz tgz bz2 xz 7z rar jar woff woff2 ttf otf eot mp3 mp4 wav ogg mov webm avi db sqlite sqlite3 wasm so dylib dll exe bin class pyc map lockb'
		.split(' ')
		.map((e) => `.${e}`)
);
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|\.next|\.svelte-kit|\.git|\.contextrie|vendor|coverage|__pycache__)\//;

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const normalise = (task: string) => task.trim().replace(/\s+/g, ' ').toLowerCase();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		})
	);
}

interface CachedSource {
	id: string;
	kind: 'document';
	format: 'markdown' | 'text';
	path: string;
	metadata: Metadata;
	hash: string;
}

export class Repo {
	readonly root: string;
	private readonly dir: string;
	private readonly opts: RepoOptions;
	private model?: LanguageModel;

	constructor(opts: RepoOptions) {
		this.opts = opts;
		this.root = gitRoot(opts.root) ?? opts.root;
		this.dir = join(this.root, '.contextrie');
	}

	private getModel = () => (this.model ??= this.opts.model());
	private progress = (done: number, total: number, msg: string) => this.opts.onProgress?.(done, total, msg);

	/** Text files worth indexing: git-tracked or untracked-but-not-ignored, minus binaries, lockfiles and build output. */
	files(): string[] {
		const listed = gitFiles(this.root) ?? walk(this.root);
		const ignore = readIgnore(this.root);
		return listed
			.filter((p) => !SKIP_DIRS.test(p) && !SKIP_NAMES.has(p.split('/').pop()!) && !SKIP_EXT.has(extname(p).toLowerCase()))
			.filter((p) => !/\.min\.(js|css)$/.test(p) && !ignore.some((g) => matchesGlob(p, g)))
			.sort();
	}

	isPinned = (path: string) => PINNED.some((re) => re.test(path));

	private loadIndex(): Map<string, CachedSource> {
		const file = join(this.dir, 'sources.json');
		try {
			const { sources } = JSON.parse(readFileSync(file, 'utf8')) as { sources?: CachedSource[] };
			return new Map((sources ?? []).filter((s) => s.hash && s.metadata).map((s) => [s.path, s]));
		} catch {
			return new Map();
		}
	}

	private save(name: string, data: unknown) {
		mkdirSync(this.dir, { recursive: true });
		// Commit the index (teammates skip re-indexing); never the judgment cache. No keys are ever written here.
		const ignore = join(this.dir, '.gitignore');
		if (!existsSync(ignore)) writeFileSync(ignore, 'judgments.json\nconfig.json\n');
		writeFileSync(join(this.dir, name), JSON.stringify(data, null, 2));
	}

	/** Read a candidate file; undefined for binaries, empty and oversized files. */
	private read(path: string): string | undefined {
		try {
			const full = join(this.root, path);
			const size = statSync(full).size;
			if (!size || size > MAX_FILE) return;
			const text = readFileSync(full, 'utf8');
			return text.includes('\0') ? undefined : text;
		} catch {
			return;
		}
	}

	/**
	 * Index new or changed files (one model call each), reusing cached metadata for the rest.
	 * Returns the indexed sources; failures are reported, not swallowed.
	 */
	async index({ paths, confirm = false }: { paths?: string[]; confirm?: boolean } = {}) {
		const cache = this.loadIndex();
		const candidates = this.files().filter((p) => !this.isPinned(p) && (!paths?.length || paths.some((g) => matchesGlob(p, g))));
		const entries = candidates
			.map((path) => {
				const text = this.read(path);
				if (text === undefined) return;
				const hash = sha(text);
				const hit = cache.get(path)?.hash === hash ? cache.get(path)!.metadata : undefined;
				const body = text.length > INDEX_CHARS ? `${text.slice(0, INDEX_CHARS)}\n[… truncated, ${text.length} chars]` : text;
				return { path, hash, source: new DocumentSource(path, hit, body, path) };
			})
			.filter((e) => e !== undefined);

		const report: IndexReport = { total: entries.length, indexed: 0, failed: [] };
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
			// Keep cached entries for files outside this call's `paths`, drop deleted files.
			const present = new Set(this.files());
			for (const e of entries) if (e.source.metadata) cache.set(e.path, { id: e.path, kind: 'document', format: /\.mdx?$/.test(e.path) ? 'markdown' : 'text', path: e.path, metadata: e.source.metadata, hash: e.hash });
			const sources = [...cache.values()].filter((s) => present.has(s.path)).sort((a, b) => a.path.localeCompare(b.path));
			// Same file and schema as @contextrie/cli (version 1), plus a content hash per source.
			this.save('sources.json', { version: 1, sources });
		}
		report.failed.sort((a, b) => a.path.localeCompare(b.path));
		return { report, sources: entries.filter((e) => e.source.metadata) };
	}

	/** Rank the files for a task. Keeps the top 3 plus anything scoring ≥ 0.3, at most `limit`. */
	async select(task: string, { limit = 8, paths, confirm }: { limit?: number; paths?: string[]; confirm?: boolean } = {}): Promise<Selection> {
		const pinned = this.files().filter(this.isPinned);
		const { report, sources } = await this.index({ paths, confirm });
		const base: Selection = { ...report, task, pinned, selected: [], judgeFailed: [] };
		if (report.needsConfirm) return base;

		// Judgments are cached by (task, file content), so repeating a task returns the same list (contextrie#65).
		const cacheFile = join(this.dir, 'judgments.json');
		let judgments: Record<string, JudgeDecision> = {};
		try {
			judgments = JSON.parse(readFileSync(cacheFile, 'utf8'));
		} catch {}
		const key = (hash: string) => sha(`${normalise(task)}|${hash}`);
		const todo = sources.filter((s) => !judgments[key(s.hash)]);

		if (todo.length) {
			const model = this.getModel();
			let done = 0;
			await pool(todo, this.opts.concurrency ?? 64, async (s) => {
				try {
					// One JudgeAgent per file: run() throws if any judgment in its queue fails, losing the others.
					const out = await new JudgeAgent(model).from(s.source).run({ objective: 'other', input: task });
					judgments[key(s.hash)] = out[s.path];
				} catch (err) {
					base.judgeFailed.push({ path: s.path, error: message(err) });
				}
				this.progress(++done, todo.length, `Judging ${s.path}`);
			});
			// Keep the cache bounded: newest entries win.
			this.save('judgments.json', Object.fromEntries(Object.entries(judgments).slice(-20_000)));
		}

		const ranked = sources
			.filter((s) => judgments[key(s.hash)])
			.map((s) => ({ path: s.path, ...judgments[key(s.hash)] }))
			.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		// The judge is literal and under-scores paraphrases, so always keep a few.
		base.selected = ranked.filter((r, i) => i < 3 || r.score >= 0.3).slice(0, Math.max(1, limit));
		base.judgeFailed.sort((a, b) => a.path.localeCompare(b.path));
		return base;
	}
}

function gitRoot(dir: string): string | undefined {
	try {
		return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return;
	}
}

function gitFiles(root: string): string[] | undefined {
	try {
		const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
			cwd: root,
			encoding: 'utf8',
			maxBuffer: 256 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return out.split('\0').filter((p) => p && existsSync(join(root, p)));
	} catch {
		return;
	}
}

/** Fallback for folders that aren't git repos: every file, minus dot folders and SKIP_DIRS. */
function walk(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, name.name);
			const rel = relative(root, full);
			if (name.isDirectory()) {
				if (!name.name.startsWith('.') && !SKIP_DIRS.test(`${rel}/`)) visit(full);
			} else if (name.isFile()) out.push(rel);
		}
	};
	visit(root);
	return out;
}

/** `.contextrieignore`: one glob per line, `#` comments. */
function readIgnore(root: string): string[] {
	try {
		return readFileSync(join(root, '.contextrieignore'), 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith('#'))
			.map((g) => (g.endsWith('/') ? `${g}**` : g));
	} catch {
		return [];
	}
}
