// Memory, skills and helpers for Gemini sessions, against the fake Gemini
// server. Runs the real Engine and MemoryStore, once with the default memory
// folder and once with an Obsidian vault picked in Settings.
// Run: npx tsx sim/gemini-memory-sim.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { WORKER_KINDS, type EngineMsg, type SessionConfig } from '../src/protocol.js';
import { call, lastUser, say, startFakeGemini, stepInTurn, userText, type GeminiRequest, type Policy } from './fake-gemini.js';

export interface MemoryRun {
  memoryPath: string;
  files: string[];
  index: string;
  /** What each session's model saw. */
  seen: Record<string, { system: string; tools: string[]; results: string[] }>;
  learned: number;
  costUsd: Record<string, number>;
}

const REFLECTION = '```json\n{"lessons":[{"type":"broke","title":"Engine tests need tsx loader","note":"Plain node fails on .ts imports; run npm test which adds --import tsx.","everywhere":false}],"skills":[]}\n```';

function results(req: GeminiRequest): string[] {
  return (lastUser(req)?.parts ?? []).filter((p) => p.functionResponse).map((p) => `${p.functionResponse!.name}: ${JSON.stringify(p.functionResponse!.response)}`);
}

export const memoryPolicy: Policy = (req, session) => {
  const step = stepInTurn(req);
  if (userText(req).includes('This session is wrapping up')) return [say('Here is what I learned.\n' + REFLECTION)];
  if (session === 'Learner') {
    if (step === 0)
      return [
        call('write_file', { path: 'notes.txt', content: 'hello' }),
        call('memory_save', { type: 'rule', title: 'Use npm test for engine tests', note: 'Run npm test -w packages/engine; there is no vitest here.' }),
        call('skill_save', { name: 'Ship a Sinnect release', description: 'Cut a signed release from GitHub Actions', steps: '1. Bump version\n2. Actions > Build and release > Run workflow\n3. Check latest.json' }),
      ];
    return [say('Saved what I learned.')];
  }
  if (session === 'Reader') {
    if (step === 0) return [call('skill_get', { name: 'Ship a Sinnect release' })];
    if (step === 1) return [call('memory_search', { query: 'engine tests' })];
    return [say('Got it.')];
  }
  if (session === 'Boss') {
    if (step === 0) return [call('spawn_workers', { workers: [{ task: 'Find where the hub wake limit lives', kind: 'search' }] })];
    return [say('Helper reported back.')];
  }
  // Helpers (and anything else) answer straight away.
  return [say('Found it in packages/engine/src/hub.ts line 162 (wakeBlocker).')];
};

export async function runMemory(opts: { vault: boolean; memoryOn?: boolean }): Promise<MemoryRun> {
  const seen: MemoryRun['seen'] = {};
  const fake = await startFakeGemini((req, session) => {
    const s = (seen[session] ??= { system: '', tools: [], results: [] });
    s.system = req.systemInstruction.parts.map((p) => p.text).join('');
    s.tools = req.tools[0].functionDeclarations.map((d) => d.name);
    s.results.push(...results(req));
    return memoryPolicy(req, session);
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-gmem-'));
  const repo = path.join(root, 'sinnect');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  process.env.GEMINI_API_KEY = 'fake-key';
  const msgs: EngineMsg[] = [];
  const engine = new Engine({ dataDir: path.join(root, 'data'), mock: false, broadcast: (m) => msgs.push(m) });
  // Helpers on Gemini too (by default they'd route to cheap Claude models).
  const patch: Record<string, unknown> = { askBeforeSpawn: false, workerRouting: Object.fromEntries(WORKER_KINDS.map((k) => [k, 'gemini-2.5-flash-lite'])) };
  if (opts.memoryOn === false) patch.memoryEnabled = false;
  if (opts.vault) {
    const vault = path.join(root, 'Agent Obsidian');
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    patch.memoryDir = vault;
  }
  await engine.handle({ t: 'settings.set', patch } as never);

  const turns = (id: string) => msgs.filter((m) => m.t === 'session.state' && m.state.id === id).at(-1);
  const waitIdle = async (id: string, n = 1) => {
    for (let i = 0; i < 300; i++) {
      const s = turns(id);
      if (s && s.t === 'session.state' && s.state.turns >= n && s.state.status === 'idle') return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${id} never went idle`);
  };
  const cfg = (name: string, prompt: string): SessionConfig => ({ name, cwd: repo, model: 'gemini-2.5-flash', prompt, priority: 3, awareness: 'everyone', permission: 'auto' });

  await engine.handle({ t: 'session.create', id: 'learner', config: cfg('Learner', 'Set up the engine tests') });
  await waitIdle('learner');
  // Stopping a session that did work makes it write down lessons first.
  await engine.handle({ t: 'session.stop', id: 'learner' });
  await engine.handle({ t: 'session.create', id: 'reader', config: cfg('Reader', 'Fix the engine tests') });
  await waitIdle('reader');
  await engine.handle({ t: 'session.create', id: 'boss', config: cfg('Boss', 'Explain the hub wake limit') });
  await waitIdle('boss');

  const memoryPath = engine.snapshot().settings.memoryPath;
  const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(memoryPath, path.join(d, e.name))])) : []);
  const indexFile = path.join(memoryPath, 'Sinnect Memory.md');
  const costUsd: Record<string, number> = {};
  for (const m of msgs) if (m.t === 'session.state') costUsd[m.state.config.name] = m.state.costUsd;
  const out: MemoryRun = {
    memoryPath,
    files: walk(memoryPath).sort(),
    index: fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '',
    seen,
    learned: msgs.filter((m) => m.t === 'memory.learned').reduce((a, m) => a + (m as { notes: unknown[] }).notes.length, 0),
    costUsd,
  };
  await engine.shutdown();
  await fake.close();
  return out;
}

if (process.argv[1]?.endsWith('gemini-memory-sim.ts')) {
  for (const vault of [false, true]) {
    const r = await runMemory({ vault });
    console.log(`\n== memory ${vault ? 'in an Obsidian vault' : 'in the default folder'}: ${r.memoryPath}`);
    console.log('files:', r.files);
    console.log('popup notes from reflection:', r.learned);
    console.log('Reader prompt has the lesson:', r.seen.Reader?.system.includes('Use npm test for engine tests'));
    console.log('Reader prompt lists the skill:', r.seen.Reader?.system.includes('Ship a Sinnect release'));
    console.log('Reader tool results:', r.seen.Reader?.results);
    console.log('Boss tool results:', r.seen.Boss?.results);
    console.log('cost so far:', r.costUsd);
    console.log('index:\n' + r.index);
  }
  const off = await runMemory({ vault: false, memoryOn: false });
  console.log('\n== memory off: Reader tools', off.seen.Reader?.tools, 'files', off.files);
}
