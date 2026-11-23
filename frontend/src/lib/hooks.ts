import { useEffect, useState } from "react";
import { errText } from "./format";

export function navigate(path: string) {
  location.hash = path;
}

/** Runs `fn` on mount and when `deps` change; `reload()` runs it again. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: unknown) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

/** Wraps an async click handler: disables while running, reports errors. */
export function useAction(onError: (msg: string) => void) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
