// Settings block for boss/helper sessions: routing rules and guardrails.

import { Workflow } from 'lucide-react';
import { DEFAULT_GEMINI_MODELS, DEFAULT_MODELS, DEFAULT_WORKER_ROUTING, WORKER_KINDS, WORKER_KIND_LABEL } from '@engine/protocol';
import { useApp } from '../store';
import { send } from '../engine';
import { modelLabel, openaiModelList, openaiReady } from '../lib';
import { Num, Switch } from './Toolbar';

const KIND_HINT: Record<string, string> = {
  search: 'finding files and code',
  read: 'reading and summarizing',
  test: 'running tests and builds',
  code: 'writing and fixing code',
  review: 'checking changes',
  plan: 'planning bigger work',
};

export function HelperSettings() {
  const settings = useApp((s) => s.settings);
  if (!settings) return null;
  const set = (patch: Record<string, unknown>) => send({ t: 'settings.set', patch });
  const routing = { ...DEFAULT_WORKER_ROUTING, ...(settings.workerRouting ?? {}) };
  const gemini = settings.hasGeminiKey || settings.mock ? (settings.geminiModels?.length ? settings.geminiModels : DEFAULT_GEMINI_MODELS) : [];
  const openai = openaiReady(settings) ? openaiModelList(settings) : [];
  const models = [...DEFAULT_MODELS, ...gemini, ...openai];
  return (
    <div className="mb-4 rounded-xl border border-line bg-field px-3 py-2.5">
      <div className="mb-0.5 flex items-center gap-1.5 text-[12.5px]">
        <Workflow size={13} className="text-accent" /> Helpers
      </div>
      <div className="mb-3 text-[11.5px] leading-snug text-ink-3">A session can hand side jobs to helper sessions. Each kind of job runs on the model you pick here.</div>
      <div className="mb-3 space-y-1.5">
        {WORKER_KINDS.map((k) => {
          const value = routing[k];
          const opts = models.some((m) => m.id === value) ? models : [{ id: value, label: modelLabel(value) }, ...models];
          return (
            <div key={k} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] text-ink-2">{WORKER_KIND_LABEL[k]}</div>
                <div className="truncate text-[10.5px] text-ink-3">{KIND_HINT[k]}</div>
              </div>
              <select value={value} onChange={(e) => set({ workerRouting: { [k]: e.target.value } })} className="field !w-[170px] !py-1.5 !text-[12px]">
                {opts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <div className="border-t border-line/70 pt-3">
        <Num label="Max helpers per session" value={settings.maxWorkersPerBoss ?? 4} onChange={(v) => set({ maxWorkersPerBoss: v })} step={1} />
        <Num label="Helper spend cap (USD, 0 = none)" value={settings.workerSpendCapUsd ?? 2} onChange={(v) => set({ workerSpendCapUsd: v })} step={0.5} />
        <Row label="Ask me before spawning" hint="The island asks before helpers start" on={!!settings.askBeforeSpawn} onChange={(v) => set({ askBeforeSpawn: v })} />
        <Row label="Helpers can spawn helpers" hint="Off keeps it to one level, cheaper and easier to follow" on={!!settings.workerNesting} onChange={(v) => set({ workerNesting: v })} />
      </div>
    </div>
  );
}

function Row({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12.5px] text-ink-2">{label}</div>
        <div className="text-[11.5px] leading-snug text-ink-3">{hint}</div>
      </div>
      <Switch on={on} onChange={onChange} />
    </div>
  );
}
