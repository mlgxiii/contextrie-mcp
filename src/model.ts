// The model behind indexing and judging: Anthropic if its key is set, otherwise OpenAI. Keys come from the
// environment (the MCP client's `env` block) and are never written anywhere.
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';

export const NO_KEY = 'Contextrie needs a model key: set ANTHROPIC_API_KEY or OPENAI_API_KEY in the MCP server env.';

export function model(): LanguageModel {
	const { ANTHROPIC_API_KEY, OPENAI_API_KEY, CONTEXTRIE_MODEL } = process.env;
	const base = ANTHROPIC_API_KEY
		? anthropic(CONTEXTRIE_MODEL ?? 'claude-haiku-5-5')
		: OPENAI_API_KEY
			? openai(CONTEXTRIE_MODEL ?? 'gpt-4.1-mini')
			: undefined;
	if (!base) throw new Error(NO_KEY);
	// Contextrie's agents take no model settings (contextrie#65), so force temperature 0 here: it narrows the judge's spread.
	return wrapLanguageModel({
		model: base as LanguageModelV3,
		middleware: { specificationVersion: 'v3', transformParams: async ({ params }) => ({ ...params, temperature: 0 }) }
	});
}
