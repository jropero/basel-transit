import { useState } from "react";
import type { Situation } from "./ojp.ts";

// Service alerts relevant to what is on screen; tap one to expand its details.
export default function Alerts({ situations, ids }: { situations: Situation[]; ids: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = situations.filter((s) => s.id.some((i) => ids.includes(i)));
  return (
    <>
      {shown.map((s) => (
        <section key={s.id[0]} className="alert">
          <button aria-expanded={open === s.id[0]} onClick={() => setOpen(open === s.id[0] ? null : s.id[0])}>
            ⚠ {s.summary}
          </button>
          {open === s.id[0] && s.details.map((d, i) => <p key={i}>{d}</p>)}
        </section>
      ))}
    </>
  );
}

export const AlertMark = ({ on }: { on: boolean }) =>
  on ? <span className="warn-mark" role="img" aria-label="service alert" title="service alert">⚠</span> : null;
