import { useApp } from '../store';
import { money } from '../lib';

/** Cost label. On a Claude plan nothing is billed per token, so it's shown as an estimate. */
export function Cost({ usd, className }: { usd: number; className?: string }) {
  const local = useApp((s) => s.settings?.authMode === 'local' && !s.settings?.mock);
  return (
    <span
      className={className}
      title={local ? 'What this would cost with an API key. On your Claude plan it uses your usage limit instead of money.' : 'Billed to your API key'}
    >
      {local ? '≈' : ''}
      {money(usd)}
    </span>
  );
}
