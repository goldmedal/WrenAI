import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Tag } from 'antd';
import { WorkLog } from '@/session/WorkLog';
import type { ToolStep } from '@/session/types';
import { EnvelopeView } from '@/envelope/EnvelopeView';
import type { RenderEnvelope } from '@/envelope/types';
import { bffBaseUrl } from '@/bff/env';
import { nativeSessionWebSocketUrl } from '@/bff/client';
import { nativeSessionCapability } from './capability';

type State = 'ready' | 'running' | 'cancelling' | 'stopping' | 'stopped' | 'interrupted';
type Event = { type: 'event'; sequence: number; requestId: string | null; kind: string; payload: {
  text?: string; state?: State; cleanup?: string; message?: string; reason?: string; fix?: string;
  steps?: ToolStep[]; answer?: { form: string; envelope?: RenderEnvelope };
} };
type Replay = { type: 'replay'; through: number; floor: number; truncated: boolean; state: State; events: Event[] };
interface Props { sessionId: string; reconnectNonce: number; readOnly?: boolean; onExit(code: number): void; onConnected(): void; onConnectionLost(): void }
const states = ['ready', 'running', 'cancelling', 'stopping', 'stopped', 'interrupted'];

/** A plain governed event view; no vendor terminal renderer or executable browser content. */
export function NativeScopedSession({ sessionId, reconnectNonce, readOnly = false, onExit, onConnected, onConnectionLost }: Props) {
  const socket = useRef<WebSocket | undefined>(undefined); const cursor = useRef(0); const currentSession = useRef(sessionId);
  const retained = useRef<Event[]>([]);
  const [events, setEvents] = useState<Event[]>([]); const [state, setState] = useState<State>('ready');
  const [connected, setConnected] = useState(false); const [truncated, setTruncated] = useState(false);
  const [text, setText] = useState(''); const [error, setError] = useState<string>(); const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (currentSession.current !== sessionId) { currentSession.current = sessionId; cursor.current = 0; retained.current = []; setEvents([]); setText(''); setTruncated(false); }
    let disposed = false, replayed = false, ended = false;
    setConnected(false); setSubmitting(false); setError(undefined);
    const ingest = (frame: Event) => {
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= 0 || frame.type !== 'event' || !frame.payload || typeof frame.payload !== 'object') throw Error('event');
      if (frame.sequence <= cursor.current) return;
      cursor.current = frame.sequence; retained.current.push(frame);
      let bytes = retained.current.reduce((n, row) => n + new TextEncoder().encode(JSON.stringify(row)).length, 0);
      while (retained.current.length > 512 || bytes > 4_194_304) { bytes -= new TextEncoder().encode(JSON.stringify(retained.current.shift()!)).length; setTruncated(true); }
      setEvents([...retained.current]);
      if (frame.kind === 'state' && frame.payload.state && states.includes(frame.payload.state)) { setState(frame.payload.state); setSubmitting(false);
        if (frame.payload.state === 'stopped' || frame.payload.state === 'interrupted') { ended = true; onExit(frame.payload.state === 'stopped' ? 0 : 1); }
      }
    };
    const replay = (value: Replay) => {
      if (replayed || value.type !== 'replay' || !Number.isSafeInteger(value.through) || value.through < 0 || !Number.isSafeInteger(value.floor) || !states.includes(value.state) || !Array.isArray(value.events) || value.events.length > 512) throw Error('replay');
      let prior = 0; for (const event of value.events) { if (event.sequence <= prior || event.sequence > value.through) throw Error('order'); prior = event.sequence; ingest(event); }
      replayed = true; setTruncated(prior => prior || value.truncated); setState(value.state);
    };
    const capability = nativeSessionCapability(sessionId);
    if (readOnly || !capability) {
      const base = bffBaseUrl();
      void fetch(`${base}/api/native-sessions/${encodeURIComponent(sessionId)}/scoped-history`).then(response => { if (!response.ok) throw Error(); return response.json(); }).then(value => { if (!disposed) replay(value); }).catch(() => { if (!disposed) setError('Session history could not be loaded.'); });
      return () => { disposed = true; };
    }
    const url = new URL(nativeSessionWebSocketUrl(sessionId, capability)); url.pathname = url.pathname.replace(/\/attach$/, '/scoped-events'); url.searchParams.set('after', String(cursor.current));
    const ws = new WebSocket(url.toString()); socket.current = ws;
    ws.onmessage = event => {
      if (disposed) return;
      try {
        const raw = String(event.data); if (new TextEncoder().encode(raw).length > 4_500_000) throw Error('frame');
        const frame = JSON.parse(raw);
        if (frame.type === 'error') { setSubmitting(false); setError(typeof frame.message === 'string' ? frame.message : 'The request could not complete.'); return; }
        if (frame.type === 'replay') { replay(frame); setConnected(true); onConnected(); }
        else { if (!replayed) throw Error('replay'); ingest(frame); }
      } catch { setError('The session stream is invalid. Reconnect to read its saved state.'); ws.close(); }
    };
    const lost = () => { if (disposed || ended) return; setConnected(false); onConnectionLost(); };
    ws.onerror = lost; ws.onclose = lost;
    return () => { disposed = true; ws.close(); if (socket.current === ws) socket.current = undefined; };
  }, [sessionId, reconnectNonce, readOnly, onExit, onConnected, onConnectionLost]);
  const cleanupState = events.filter(event => event.kind === 'state' && event.payload.cleanup).at(-1)?.payload.cleanup;
  const latestWorklog = events.filter(event => event.kind === 'worklog').at(-1);
  const send = () => {
    if (!connected || state !== 'ready' || submitting || !text.trim() || socket.current?.readyState !== WebSocket.OPEN) return;
    if (new TextEncoder().encode(text).length > 262_144) { setError('The question is too long.'); return; }
    setSubmitting(true); setError(undefined); socket.current.send(JSON.stringify({ type: 'prompt', requestId: crypto.randomUUID(), text })); setText('');
  };
  return <section className="sessions-conversation" aria-label="Scoped analysis session">
    <div><Tag>{state}</Tag>{!connected && !readOnly ? <span role="status">Browser disconnected; execution and saved events remain on the server.</span> : null}</div>
    {cleanupState ? <div role="status">{cleanupState === 'confirmed' ? 'Worker and query cleanup confirmed.' : 'Worker and query cleanup is pending.'}</div> : null}
    <Alert type="info" title="Scoped analysis" description="Questions use the same governed analysis tools as Ask. Official Claude TUI and server restart continuation are unavailable." />
    {truncated ? <Alert type="info" title="Showing the saved event tail; earlier events were truncated." /> : null}
    {error ? <Alert type="error" title={error} /> : null}
    <div className="sessions-conversation-messages" role="log" aria-live="polite">
      {events.filter(event => ['user', 'answer', 'refusal', 'error'].includes(event.kind)).map(event => <article key={event.sequence} data-cursor={event.sequence}>
        {event.kind === 'user' ? <><strong>You</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{event.payload.text}</p></> : event.kind === 'answer' && event.payload.answer?.envelope ? <EnvelopeView envelope={event.payload.answer.envelope} /> : event.kind === 'refusal' ? <><strong>Unable to answer from this dataset</strong><p>{event.payload.reason}</p><p>{event.payload.fix}</p></> : <Alert type="error" title={event.payload.message ?? 'The response could not complete.'} />}
      </article>)}
    </div>
    {latestWorklog?.payload.steps ? <WorkLog steps={latestWorklog.payload.steps} title="Analysis steps" defaultOpen={state === 'running'} /> : null}
    <form onSubmit={event => { event.preventDefault(); send(); }}>
      <Input.TextArea aria-label="Question for scoped analysis" value={text} onChange={event => setText(event.target.value)} disabled={readOnly || !connected || state !== 'ready' || submitting} rows={3} />
      <Button htmlType="submit" type="primary" disabled={readOnly || !connected || state !== 'ready' || submitting || !text.trim()}>Send question</Button>
      <Button disabled={readOnly || !connected || state !== 'running'} onClick={() => socket.current?.send(JSON.stringify({ type: 'cancel' }))}>Cancel response</Button>
    </form>
  </section>;
}
