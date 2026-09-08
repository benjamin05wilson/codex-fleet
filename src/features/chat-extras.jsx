import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, Clock3 } from "lucide-react";
import "../chat.css";

export function CopyButton({ text, label = "Copy" }) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 2000);
    return () => clearTimeout(timer);
  }, [status]);
  return (
    <button
      type="button"
      className="chat-copy"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setStatus("Copied");
        } catch {
          setStatus("Copy failed");
        }
      }}
    >
      {status === "Copied" ? <Check size={13} /> : <Copy size={13} />}
      {status || label}
    </button>
  );
}

// Render tokens as React text: code is never interpreted as markup.
function highlight(code, language) {
  if (!language || ["text", "plain", "plaintext"].includes(language))
    return code;
  const pattern =
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|for|while|class|new|import|from|export|default|async|await|try|catch|throw|def|self|None|True|False|true|false|null|undefined|public|private|static|void|int|string|bool|interface|type|extends|implements|select|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|TABLE|AND|OR|as|in|of|with|yield|break|continue|switch|case)\b|\b\d+(?:\.\d+)?\b)/g;
  return code.split(pattern).map((part, index) => {
    if (!part) return null;
    let kind = "";
    if (/^(\/\/|\/\*|#|--)/.test(part)) kind = "comment";
    else if (/^["'`]/.test(part)) kind = "string";
    else if (/^\d/.test(part)) kind = "number";
    else if (index % 2) kind = "keyword";
    return kind ? (
      <span className={`syntax-${kind}`} key={index}>
        {part}
      </span>
    ) : (
      part
    );
  });
}

export function CodeBlock({ children }) {
  const child = React.Children.toArray(children)[0];
  const code = String(child?.props?.children ?? "").replace(/\n$/, "");
  const language =
    /language-([^\s]+)/.exec(child?.props?.className || "")?.[1] || "text";
  return (
    <div className="chat-code-block">
      <div className="chat-code-heading">
        <span>{language}</span>
        <CopyButton text={code} label="Copy code" />
      </div>
      <pre>
        <code>{highlight(code, language)}</code>
      </pre>
    </div>
  );
}

export function ChatProgress({ phase, since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(
    0,
    Math.floor((now - (Date.parse(since) || now)) / 1000),
  );
  return (
    <div className="working-message chat-progress" role="status">
      <span className="working-dot" />
      <strong>{phase}</strong>
      <span className="chat-elapsed">
        <Clock3 size={12} />
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
      </span>
    </div>
  );
}

export function useChatNavigation(
  feedRef,
  contentRef,
  detail,
  historyLoadingRef,
) {
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const pauseFollow = () => {
    follow.current = false;
    setAway(true);
  };
  const jumpLatest = () => {
    const feed = feedRef.current;
    if (feed) feed.scrollTop = feed.scrollHeight;
    follow.current = true;
    setAway(false);
  };
  const onScroll = () => {
    const feed = feedRef.current;
    if (!feed || historyLoadingRef.current) return;
    const atBottom =
      feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
    follow.current = atBottom;
    setAway(!atBottom);
  };
  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && follow.current && !historyLoadingRef.current)
      feed.scrollTop = feed.scrollHeight;
  }, [detail]);
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follow.current && !historyLoadingRef.current && feedRef.current)
        feedRef.current.scrollTop = feedRef.current.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [Boolean(detail)]);
  return { away, pauseFollow, jumpLatest, onScroll };
}

export function ChatSearch({
  feedRef,
  revision,
  onNavigate,
  loading,
  complete,
  loadAll,
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [index, setIndex] = useState(-1);
  const input = useRef(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const shortcut = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    const needle = query.trim().toLowerCase();
    const nodes =
      open && needle
        ? [
            ...(feedRef.current?.querySelectorAll("[data-chat-search]") || []),
          ].filter((node) => node.textContent.toLowerCase().includes(needle))
        : [];
    setMatches(nodes);
    setIndex((current) => Math.min(current, nodes.length - 1));
    nodes.forEach((node) => node.classList.add("chat-search-match"));
    return () =>
      nodes.forEach((node) =>
        node.classList.remove("chat-search-match", "chat-search-current"),
      );
  }, [query, revision, open]);
  useEffect(() => {
    setIndex(-1);
  }, [query, open]);
  const navigate = (direction) => {
    if (!matches.length) return;
    onNavigate();
    matches.forEach((node) => node.classList.remove("chat-search-current"));
    const next =
      index < 0
        ? direction > 0
          ? 0
          : matches.length - 1
        : (index + direction + matches.length) % matches.length;
    const node = matches[next];
    for (const details of node.querySelectorAll("details"))
      if (
        details.textContent.toLowerCase().includes(query.trim().toLowerCase())
      )
        details.open = true;
    for (
      let parent = node.parentElement;
      parent && parent !== feedRef.current;
      parent = parent.parentElement
    )
      if (parent.tagName === "DETAILS") parent.open = true;
    node.classList.add("chat-search-current");
    const feed = feedRef.current;
    if (feed)
      feed.scrollTop +=
        node.getBoundingClientRect().top -
        feed.getBoundingClientRect().top -
        24;
    setIndex(next);
  };
  if (!open)
    return (
      <div className="chat-search-launch">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          Search chat <kbd>Ctrl F</kbd>
        </button>
      </div>
    );
  return (
    <div className="chat-search-bar" role="search" aria-label="Search chat">
      <input
        ref={input}
        value={query}
        aria-label="Search chat messages"
        placeholder="Search messages, commands and files…"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            navigate(event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") setOpen(false);
        }}
      />
      <span aria-live="polite">
        {query ? `${index + 1}/${matches.length}` : ""}
      </span>
      <button
        type="button"
        disabled={!matches.length}
        aria-label="Previous match"
        onClick={() => navigate(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        disabled={!matches.length}
        aria-label="Next match"
        onClick={() => navigate(1)}
      >
        ↓
      </button>
      {!complete && (
        <button type="button" disabled={loading} onClick={loadAll}>
          {loading ? "Loading…" : "Search earlier history"}
        </button>
      )}
      <button
        type="button"
        aria-label="Close chat search"
        onClick={() => setOpen(false)}
      >
        ×
      </button>
    </div>
  );
}
