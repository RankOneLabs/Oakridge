import { useEffect, useRef, useState } from "react";

export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

type Status = "connecting" | "connected" | "disconnected";

export function App() {
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const seenIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    const es = new EventSource("/stream");
    es.onopen = () => setStatus("connected");
    es.onerror = () => setStatus("disconnected");
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as EnvelopeEvent;
        if (seenIds.current.has(evt.id)) return;
        seenIds.current.add(evt.id);
        setEvents((prev) => [...prev, evt]);
      } catch {
        // malformed frame; ignore
      }
    };
    return () => es.close();
  }, []);

  return (
    <div className="app">
      <header className="top-bar">
        <span className={`status status-${status}`}>{status}</span>
        <span className="event-count">{events.length} events</span>
      </header>
      <ul className="events">
        {events.map((e) => (
          <li key={e.id} className={`event event-${e.type}`}>
            <span className="event-id">#{e.id}</span>
            <span className="event-type">{e.type}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
