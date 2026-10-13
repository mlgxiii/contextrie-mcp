// Recall of select_context against real work: each commit's subject is the task, the files it changed are
// the answer. Compared with a TF-IDF word-overlap ranking (roughly what grep-style search finds).
//
//   npx tsx scripts/bench.ts [repo] [--n 10] [--k 8]
//
// Pinned files (README, CLAUDE.md…) are left out of both answers and rankings. Only files that still exist
// and are candidates count, since the index reflects the current tree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { model } from '../src/model.ts';
import { Repo } from '../src/select.ts';

console.info = () => {};
const { values, positionals } = parseArgs({ allowPositionals: true, options: { n: { type: 'string', default: '10' }, k: { type: 'string', default: '8' } } });
const k = Number(values.k);
const repo = new Repo({ root: positionals[0] ?? process.cwd(), model, concurrency: Number(process.env.CONTEXTRIE_CONCURRENCY ?? 64) });
const candidates = new Set(repo.files().filter((p) => !repo.isPinned(p)));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, encoding: 'utf8' });

// Commits touching 2–20 candidate files, newest first.
const cases = git('log', '--no-merges', '--format=%H%x09%s')
	.trim()
	.split('\n')
	.map((line) => {
		const [sha, subject] = line.split('\t');
		const files = git('show', '--name-only', '--format=', sha).split('\n').filter((f) => candidates.has(f));
		return { sha: sha.slice(0, 7), task: subject, files };
	})
	.filter((c) => c.files.length >= 2 && c.files.length <= 20)
	.slice(0, Number(values.n));

// Baseline: TF-IDF over path + content, summed over the task's words.
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const docs = [...candidates].map((path) => {
	let text = '';
	try {
		text = readFileSync(join(repo.root, path), 'utf8').slice(0, 32_000);
	} catch {}
	const tf = new Map<string, number>();
	for (const w of tokens(`${path} ${path} ${text}`)) tf.set(w, (tf.get(w) ?? 0) + 1);
	return { path, tf, len: [...tf.values()].reduce((a, b) => a + b, 0) || 1 };
});
const df = new Map<string, number>();
for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
const baseline = (task: string) =>
	docs
		.map((d) => ({ path: d.path, score: tokens(task).reduce((s, w) => s + ((d.tf.get(w) ?? 0) / d.len) * Math.log(docs.length / (df.get(w) ?? docs.length)), 0) }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.slice(0, k)
		.map((d) => d.path);

const recall = (picked: string[], answer: string[]) => answer.filter((f) => picked.includes(f)).length / answer.length;
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);

let wins = 0, ties = 0, sumC = 0, sumB = 0;
console.log(`| Commit | Task | Files | Contextrie@${k} | Baseline@${k} | Time |\n| --- | --- | --- | --- | --- | --- |`);
for (const c of cases) {
	const t0 = Date.now();
	const s = await repo.select(c.task, { limit: k, confirm: true });
	const rc = recall(s.selected.map((f) => f.path), c.files);
	const rb = recall(baseline(c.task), c.files);
	sumC += rc;
	sumB += rb;
	if (rc > rb) wins++;
	else if (rc === rb) ties++;
	console.log(`| ${c.sha} | ${c.task.slice(0, 70).replace(/\|/g, '/')} | ${c.files.length} | ${pct(rc)} | ${pct(rb)} | ${((Date.now() - t0) / 1000).toFixed(1)} s${s.judgeFailed.length ? `, ${s.judgeFailed.length} failed` : ''} |`);
}
console.log(`\nMean recall@${k}: Contextrie ${pct(sumC / cases.length)}, baseline ${pct(sumB / cases.length)}. Contextrie wins ${wins}, ties ${ties}, loses ${cases.length - wins - ties} of ${cases.length}.`);
