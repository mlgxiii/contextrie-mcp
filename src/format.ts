// What the agent reads: a short Markdown list it can act on directly.
import type { IndexReport, Selection } from './select.ts';

const confirmText = (r: IndexReport) =>
	`${r.needsConfirm!.files} files need indexing first (one model call each; the limit without confirmation is ${r.needsConfirm!.limit}). ` +
	'Ask the user, then call `index` with `confirm: true`, or retry with `paths` to narrow the search (e.g. ["src/**"]). Files can also be excluded in `.contextrieignore`.';

const failures = (label: string, list: { path: string; error: string }[]) =>
	list.length ? [`${label} (${list.length}, left out):`, ...list.slice(0, 10).map((f) => `- ${f.path}: ${f.error}`), ...(list.length > 10 ? [`- …and ${list.length - 10} more`] : [])] : [];

export function formatSelection(s: Selection): string {
	if (s.needsConfirm) return confirmText(s);
	return [
		`Contextrie picked ${s.selected.length} of ${s.total} files for: "${s.task}"`,
		...(s.pinned.length ? ['', 'Project instructions (always listed):', ...s.pinned.map((p) => `- ${p}`)] : []),
		'',
		'Ranked (score 0–1: reason):',
		...s.selected.map((f, i) => `${i + 1}. ${f.path} · ${f.score.toFixed(2)}: ${f.reason}`),
		...(s.selected.length ? [] : ['(nothing could be judged)']),
		'',
		`Index: ${s.indexed} file(s) (re)indexed now, the rest from cache.`,
		...failures('Failed to index', s.failed),
		...failures('Failed to judge', s.judgeFailed),
		'',
		'Scores come from file summaries, not full text: read the top files, and search beyond them if the task needs it.'
	].join('\n');
}

export function formatIndex(r: IndexReport): string {
	if (r.needsConfirm) return confirmText(r);
	return [`Indexed ${r.indexed} new or changed file(s); ${r.total - r.indexed - r.failed.length} from cache; ${r.total} candidates.`, ...failures('Failed to index', r.failed)].join('\n');
}
