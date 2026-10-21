import { useEffect, useState } from "react";

// Whole-document derivations (outline, counts) follow the text once typing pauses, not on every key.
// Switching to another document (new id) updates at once.
export function useSettled(value: string, id: string | undefined) {
  const [settled, setSettled] = useState({ id, value });
  const switched = settled.id !== id;
  useEffect(() => {
    if (switched) { setSettled({ id, value }); return; }
    if (value === settled.value) return;
    const timer = setTimeout(() => setSettled({ id, value }), value.length > 200_000 ? 600 : 150);
    return () => clearTimeout(timer);
  }, [id, value, settled, switched]);
  return switched ? value : settled.value;
}
