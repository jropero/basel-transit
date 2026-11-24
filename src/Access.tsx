import type { Access, Quay } from './ojp.ts';

// Small wheelchair marker (never colour-only: aria-label + title) and a "replacement" tag.
export default function AccessMark({
  level,
  replacement,
}: {
  level: Access;
  replacement?: boolean;
}) {
  return (
    <>
      {level === 'step-free' && (
        <span
          className="acc"
          role="img"
          aria-label="step-free boarding"
          title="step-free boarding"
        >
          {'\u267F\uFE0E'}
        </span>
      )}
      {level === 'assisted' && (
        <span
          className="acc part"
          role="img"
          aria-label="boarding with assistance"
          title="boarding with assistance"
        >
          {'\u267F\uFE0E'}
          <sup>+</sup>
        </span>
      )}
      {replacement && <span className="repl">replacement</span>}
    </>
  );
}

// "quay 5", or the old quay struck through and the new one highlighted when it changed.
export function QuayMark({ quay }: { quay: Quay }) {
  if (!quay.planned) return null;
  if (quay.actual === quay.planned) return <>quay {quay.planned}</>;
  return (
    <span aria-label={`platform changed from ${quay.planned} to ${quay.actual}`}>
      quay <s className="quay-old">{quay.planned}</s> <b className="quay-new">{quay.actual}</b>
    </span>
  );
}

export const Diverted = ({ on }: { on: boolean }) =>
  on ? <span className="tag warn">diverted</span> : null;
