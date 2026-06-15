// Cmd+F search bar: floats over the viewer, debounced whole-document
// search, Enter/Shift+Enter or arrows to step matches, Aa toggles case.
import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useActiveDoc, useApp } from "../store";

export default function SearchBar() {
  const doc = useActiveDoc();
  const closeSearch = useApp((s) => s.closeSearch);
  const runSearch = useApp((s) => s.runSearch);
  const stepSearch = useApp((s) => s.stepSearch);
  const hits = useApp((s) => s.searchHits);
  const current = useApp((s) => s.searchCurrent);
  const showToast = useApp((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Debounced re-search on query/case/document-revision change.
  const docId = doc?.info.id;
  const rev = doc?.info.rev;
  useEffect(() => {
    const timer = setTimeout(() => {
      void runSearch(query, matchCase).catch((e) => showToast(String(e)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, matchCase, docId, rev, runSearch, showToast]);

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        placeholder="Find in document…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") stepSearch(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") closeSearch();
        }}
      />
      <button
        className={`search-toggle ${matchCase ? "active" : ""}`}
        title="Match case"
        onClick={() => setMatchCase((v) => !v)}
      >
        <CaseSensitive size={15} />
      </button>
      <span className="search-count">
        {hits.length > 0 ? `${current + 1}/${hits.length}` : query.trim() ? "0" : ""}
      </span>
      <button title="Previous match" disabled={hits.length === 0} onClick={() => stepSearch(-1)}>
        <ChevronUp size={15} />
      </button>
      <button title="Next match" disabled={hits.length === 0} onClick={() => stepSearch(1)}>
        <ChevronDown size={15} />
      </button>
      <button title="Close (Esc)" onClick={closeSearch}>
        <X size={15} />
      </button>
    </div>
  );
}
