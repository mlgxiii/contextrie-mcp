// Talk to the built server over stdio, like Claude Code does.
//   npx tsx scripts/smoke.ts [repo] "<task>"
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const [root = process.cwd(), task = 'add a new product'] = process.argv.slice(2);
const transport = new StdioClientTransport({
	command: 'node',
	args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
	cwd: root,
	env: process.env as Record<string, string>,
	stderr: 'inherit'
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
const t0 = Date.now();
const res = await client.callTool(
	{ name: 'select_context', arguments: { task } },
	undefined,
	{ timeout: 600_000, onprogress: (p) => process.stderr.write(`\r${p.progress}/${p.total} ${String(p.message).slice(0, 70).padEnd(70)}`) }
);
process.stderr.write('\n');
console.log(res.isError ? '[error]' : '', (res.content as { text: string }[])[0].text);
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
await client.close();
