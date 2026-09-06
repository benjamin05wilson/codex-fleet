import { useEffect, useState } from "react";
import { api } from "../ui.jsx";
export function useCodexMetadata() {
  const [data, setData] = useState(null),
    [error, setError] = useState(null),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(`/codex${revision ? "?refresh=1" : ""}`)
      .then((value) => {
        if (!Array.isArray(value.models))
          throw new Error("Codex model discovery is unavailable.");
        if (alive) {
          setData(value);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) {
          setData(null);
          setError(e.message);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [revision]);
  return { data, error, loading, reload: () => setRevision((v) => v + 1) };
}
