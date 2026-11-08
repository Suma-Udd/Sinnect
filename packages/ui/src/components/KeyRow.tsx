import { useState } from 'react';

/** A saved-key row for a provider that brings its own key (Gemini, OpenAI). */
export function KeyRow({ label, saved, models, placeholder, onSave, hint }: { label: string; saved: boolean; models: number; placeholder: string; onSave: (key: string) => void; hint: React.ReactNode }) {
  const [draft, setDraft] = useState('');
  const save = () => draft.trim() && (onSave(draft.trim()), setDraft(''));
  return (
    <>
      <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink-2">
        {label}
        <span className={`h-1.5 w-1.5 rounded-full ${saved ? 'bg-st-idle' : 'bg-ink-3'}`} />
        <span className="font-normal text-ink-3">{saved ? `Saved · ${models} models` : 'Optional'}</span>
      </div>
      <div className="mb-1.5 flex gap-2">
        <input className="field font-mono" type="password" placeholder={saved ? 'Key saved, paste to replace' : placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <button onClick={save} disabled={!draft.trim()} className="shrink-0 rounded-[10px] bg-accent px-3 text-[12.5px] font-semibold text-white disabled:opacity-40">
          Save
        </button>
        {saved && (
          <button onClick={() => onSave('')} className="shrink-0 rounded-[10px] border border-line px-3 text-[12.5px] text-ink-3 hover:border-line-hi hover:text-ink-2" title="Remove the saved key">
            Remove
          </button>
        )}
      </div>
      <div className="mb-4 text-[11.5px] leading-relaxed text-ink-3">{hint}</div>
    </>
  );
}
