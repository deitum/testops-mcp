// Two things `npm run check:package` cannot prove about a release.
//
// First, that the binary in the tarball boots: a broken shebang, a missing
// dependency or an accidental `console.log` on stdout all pass every other
// check in CI. So this starts the built server over stdio and runs
// `initialize` + `tools/list` + one `tools/call` against it.
//
// Second, that the tarball carries `docs/` and `examples/`. The server reads
// those two files from the package root at runtime (see `markdownGuide.ts`),
// so dropping them from `files` would publish a package whose
// `testcase_markdown_guide` fails only on a user's machine.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

const GUIDE_FILES = ['docs/markdown-import.md', 'examples/testops-markdown-import-example.md'];
const EXPECTED_TOOL_COUNT = 22;

const server = spawn(process.execPath, ['dist/cli.js'], {
  env: {
    ...process.env,
    // Unreachable on purpose: the smoke test must never touch a real TestOps.
    TESTOPS_BASE_URL: 'http://127.0.0.1:1',
    TESTOPS_API_KEY: 'smoke',
    TESTOPS_PROJECT_ID: '1',
    TESTOPS_JIRA_BASE_URL: 'https://jira.example.com',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const lines = createInterface({ input: server.stdout });

const replies = new Map();
lines.on('line', (line) => {
  const message = JSON.parse(line);
  replies.get(message.id)?.(message);
});

const call = async (id, method, params = {}) => {
  const reply = new Promise((resolve) => replies.set(id, resolve));
  send({ jsonrpc: '2.0', id, method, params });
  return reply;
};

const timeout = setTimeout(() => {
  console.error('The server did not answer within 15s.');
  server.kill('SIGKILL');
  process.exit(1);
}, 15_000);

const initialized = await call(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'smoke', version: '0' },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const { result: listed } = await call(2, 'tools/list');
const names = listed.tools.map((tool) => tool.name);

// Reads docs/ and examples/ from the package root and touches no network, so it
// proves the guide files ship beside the built server.
const { result: guide } = await call(3, 'tools/call', {
  name: 'testcase_markdown_guide',
  arguments: {},
});

clearTimeout(timeout);
server.kill();
await once(server, 'exit');

console.log(`${initialized.result.serverInfo.name} ${initialized.result.serverInfo.version}`);
console.log(`${names.length} tools: ${names.slice(0, 3).join(', ')}, …`);

// 15 test-case tools, 6 launch tools and the project statistics one.
if (names.length !== EXPECTED_TOOL_COUNT) {
  console.error(`Expected ${EXPECTED_TOOL_COUNT} tools, got ${names.length}.`);
  process.exit(1);
}

if (guide.isError) {
  console.error(`testcase_markdown_guide failed: ${guide.content?.[0]?.text}`);
  process.exit(1);
}

const { rules, example } = JSON.parse(guide.content[0].text);
if (!rules?.startsWith('# ') || !example?.includes('[step 1]')) {
  console.error('testcase_markdown_guide returned no usable rules or example.');
  process.exit(1);
}
console.log(`guide: ${rules.length} chars of rules, ${example.length} chars of example`);

const packed = spawn('npm', ['pack', '--dry-run', '--json'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const chunks = [];
packed.stdout.on('data', (chunk) => chunks.push(chunk));
const [packExit] = await once(packed, 'exit');
if (packExit !== 0) {
  console.error('npm pack --dry-run failed.');
  process.exit(1);
}

const [tarball] = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const packedPaths = new Set(tarball.files.map((file) => file.path));
const missing = GUIDE_FILES.filter((file) => !packedPaths.has(file));
if (missing.length > 0) {
  console.error(`The tarball is missing ${missing.join(', ')} — check "files" in package.json.`);
  process.exit(1);
}
console.log(`tarball: ${tarball.files.length} files, guide files included`);
