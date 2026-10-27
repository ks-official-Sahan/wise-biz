"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { filterCommands } from "@/lib/nav.ts";

import s from "./shell.module.css";

/** Ctrl/Cmd+K palette over the navigation + actions registry. Native <dialog>: focus trap and Escape for free. */
export function CommandPalette() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = filterCommands(query);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const el = ref.current;
        if (el === null) return;
        if (el.open) el.close();
        else {
          setQuery("");
          setActive(0);
          el.showModal();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = (href: string): void => {
    ref.current?.close();
    router.push(href);
  };

  return (
    <dialog
      ref={ref}
      className={s.palette}
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <input
        className={s.paletteInput}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={
          results[active] === undefined ? undefined : `${listId}-${String(active)}`
        }
        aria-label="Search pages and actions"
        placeholder="Search pages and actions"
        value={query}
        autoFocus
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            const hit = results[active];
            if (hit !== undefined) go(hit.href);
          }
        }}
      />
      <ul id={listId} role="listbox" className={s.paletteList}>
        {results.length === 0 ? (
          <li className={s.paletteItem}>No matches. Try “people” or “branch”.</li>
        ) : (
          results.map((c, i) => (
            <li
              key={c.id}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              className={s.paletteItem}
              onMouseEnter={() => {
                setActive(i);
              }}
              onClick={() => {
                go(c.href);
              }}
            >
              {c.label}
            </li>
          ))
        )}
      </ul>
    </dialog>
  );
}
