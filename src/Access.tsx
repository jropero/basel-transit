import type { Access } from "./ojp.ts";

// Small wheelchair marker (never colour-only: aria-label + title) and a "replacement" tag.
export default function AccessMark({ level, replacement }: { level: Access; replacement?: boolean }) {
  return (
    <>
      {level === "step-free" && (
        <span className="acc" role="img" aria-label="step-free boarding" title="step-free boarding">{"\u267F\uFE0E"}</span>
      )}
      {level === "assisted" && (
        <span className="acc part" role="img" aria-label="boarding with assistance" title="boarding with assistance">
          {"\u267F\uFE0E"}<sup>+</sup>
        </span>
      )}
      {replacement && <span className="repl">replacement</span>}
    </>
  );
}
