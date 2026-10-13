// contextrie-mcp: a stdio MCP server for coding agents (Claude Code, Cursor, Codex).
//
//   select_context(task)  → the files worth reading for a task, each with a score and a reason
//   index()               → index new or changed files ahead of time
//
// The repo is the server's working directory (or CONTEXTRIE_ROOT), widened to its git root.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatIndex, formatSelection } from './format.ts';
import { model } from './model.ts';
import { Repo, type RepoOptions } from './select.ts';

// stdout is the MCP channel: Contextrie's progress logs (console.info) would corrupt it.
console.info = console.log = (...args: unknown[]) => {
	if (process.env.DEBUG) console.error(...args);
};

const env = (name: string) => (process.env[name] ? Number(process.env[name]) : undefined);
const repoFor = (onProgress?: RepoOptions['onProgress']) =>
	new Repo({
		root: process.env.CONTEXTRIE_ROOT ?? process.cwd(),
		model,
		maxIndex: env('CONTEXTRIE_MAX_INDEX'),
		concurrency: env('CONTEXTRIE_CONCURRENCY'),
		onProgress
	});

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };
const progressOf = (extra: Extra): RepoOptions['onProgress'] => {
	const token = extra._meta?.progressToken;
	if (token === undefined) return;
	return (progress, total, message) => void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, total, message } }).catch(() => {});
};
const failure = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] });

const server = new McpServer({ name: 'contextrie', version: '0.1.0' });

server.registerTool(
	'select_context',
	{
		title: 'Select context',
		description:
			'Call this at the start of a task, before searching the codebase. Returns the files and docs in this repo worth reading for the task, ranked, each with a relevance score (0–1) and a reason. Project instructions (README, CLAUDE.md, AGENTS.md) are always listed. Pass the task as the user stated it, plus any detail you already know.',
		inputSchema: {
			task: z.string().min(3).describe('The task, in plain words (e.g. "add rate limiting to the upload endpoint").'),
			limit: z.number().int().min(1).max(30).optional().describe('Maximum ranked files (default 8).'),
			paths: z.array(z.string()).optional().describe('Globs to restrict the search to, e.g. ["src/**", "docs/**"].')
		},
		annotations: { readOnlyHint: false, openWorldHint: false }
	},
	async ({ task, limit, paths }, extra) => {
		try {
			const s = await repoFor(progressOf(extra)).select(task, { limit, paths });
			return { content: [{ type: 'text', text: formatSelection(s) }] };
		} catch (e) {
			return failure(e);
		}
	}
);

server.registerTool(
	'index',
	{
		title: 'Index repository',
		description:
			'Index new or changed files so select_context answers fast. select_context does this itself; call this to confirm a large first index (confirm: true) or to warm the cache.',
		inputSchema: {
			confirm: z.boolean().optional().describe('Allow indexing more files than CONTEXTRIE_MAX_INDEX (default 500). One model call per file.'),
			paths: z.array(z.string()).optional().describe('Globs to restrict indexing to.')
		},
		annotations: { readOnlyHint: false, openWorldHint: false }
	},
	async ({ confirm, paths }, extra) => {
		try {
			const { report } = await repoFor(progressOf(extra)).index({ confirm, paths });
			return { content: [{ type: 'text', text: formatIndex(report) }] };
		} catch (e) {
			return failure(e);
		}
	}
);

await server.connect(new StdioServerTransport());
