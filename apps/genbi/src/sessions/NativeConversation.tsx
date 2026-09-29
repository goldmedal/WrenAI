import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input } from 'antd';
import { nativeSessionWebSocketUrl } from '@/bff/client';
import { nativeSessionCapability } from './capability';
// Browser projection; backend-only modules must not enter the frontend module graph.
type ConversationState = 'opening' | 'ready' | 'running' | 'closing' | 'closed' | 'failed';
type ConversationFrame = { type: 'state'; sequence: number; state: ConversationState } | {
  type: 'event'; sequence: number; event: { method: string; params: {
    turnId?: string; itemId?: string; delta?: string;
    item?: { id: string; type: string; text?: string; content?: { text: string }[]; status?: string; success?: boolean };
  } };
};
type ConversationReplay = { type: 'replay'; throughSequence: number; state: ConversationState; truncated: boolean };

interface Props { sessionId: string; reconnectNonce: number; onExit: (code: number) => void; onConnected: () => void; onConnectionLost: () => void }
type Message = { id: string; label: string; text: string };

function messages(frames: ConversationFrame[]): Message[] {
  const items = new Map<string, Message>();
  for (const frame of frames) {
    if (frame.type !== 'event') continue;
    const { method, params } = frame.event;
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item;
      if (!item) continue;
      const id = `${params.turnId}:${item.id}`;
      if (item.type === 'agentMessage') items.set(id, { id, label: 'Codex', text: item.text ?? '' });
      if (item.type === 'userMessage') items.set(id, { id, label: 'You', text: (item.content ?? []).map((part) => part.text).join('\n') });
      if (item.type === 'dynamicToolCall') items.set(id, { id, label: 'Analysis tool', text: item.status === 'inProgress' ? 'Working…' : item.success === false || item.status === 'failed' ? 'Failed' : 'Completed' });
    } else if (method === 'item/agentMessage/delta') {
      const id = `${params.turnId}:${params.itemId}`;
      const prior = items.get(id);
      items.set(id, { id, label: 'Codex', text: (prior?.text ?? '') + (params.delta ?? '') });
    }
  }
  return [...items.values()];
}

/** Direct events are plain React text, never terminal control sequences or HTML. */
export function NativeConversation({ sessionId, reconnectNonce, onExit, onConnected, onConnectionLost }: Props) {
  const socket = useRef<WebSocket | undefined>(undefined);
  const [frames, setFrames] = useState<ConversationFrame[]>([]);
  const [state, setState] = useState<ConversationState>('opening');
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const capability = nativeSessionCapability(sessionId);
    if (!capability) return;
    setFrames([]); setState('opening'); setTruncated(false); setError(undefined); setSubmitting(false);
    const url = new URL(nativeSessionWebSocketUrl(sessionId, capability));
    url.pathname = url.pathname.replace(/\/attach$/, '/conversation');
    url.searchParams.set('after', '0');
    const ws = new WebSocket(url.toString()); socket.current = ws;
    let disposed = false; let ended = false; let sequence = 0; let through = -1;
    let retained: { frame: ConversationFrame; bytes: number }[] = []; let bytes = 0;
    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const raw = String(event.data);
        if (new TextEncoder().encode(raw).length > 1_048_576) throw Error('frame too large');
        const frame = JSON.parse(raw) as ConversationFrame | ConversationReplay | { type: 'error'; code: string };
        if (frame.type === 'error') { setSubmitting(false); setError(frame.code === 'busy' ? 'A response is already in progress.' : 'The request could not complete.'); return; }
        if (frame.type === 'replay') {
          if (through !== -1 || !Number.isSafeInteger(frame.throughSequence) || frame.throughSequence < 0) throw Error('replay');
          through = frame.throughSequence; setState(frame.state); setTruncated(frame.truncated); onConnected();
          return;
        }
        if (through === -1 || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence || (frame.type !== 'event' && frame.type !== 'state')) throw Error('sequence');
        sequence = frame.sequence;
        const size = new TextEncoder().encode(raw).length;
        retained.push({ frame, bytes: size }); bytes += size;
        while (retained.length > 256 || bytes > 1_048_576) { bytes -= retained.shift()!.bytes; setTruncated(true); }
        setFrames(retained.map((entry) => entry.frame));
        if (frame.type === 'state') {
          if (frame.sequence > through) { setState(frame.state); setSubmitting(false); }
          if (frame.state === 'failed' || frame.state === 'closed') { ended = true; onExit(frame.state === 'failed' ? 1 : 0); }
        }
      } catch { setError('The conversation stream is invalid.'); ws.close(); }
    };
    ws.onerror = () => { if (!disposed && !ended) onConnectionLost(); };
    ws.onclose = () => { if (!disposed && !ended) onConnectionLost(); };
    return () => { disposed = true; retained = []; if (socket.current === ws) socket.current = undefined; ws.close(); };
  }, [sessionId, reconnectNonce, onExit, onConnected, onConnectionLost]);
  const send = () => {
    if (state !== 'ready' || submitting || !text.trim() || socket.current?.readyState !== WebSocket.OPEN) return;
    if (new TextEncoder().encode(text).length > 262_144) { setError('The question is too long.'); return; }
    setSubmitting(true); setError(undefined);
    socket.current.send(JSON.stringify({ type: 'prompt', text })); setText('');
  };
  return <section className="sessions-conversation" aria-label="Codex conversation">
    {truncated ? <Alert type="info" title="Earlier conversation was truncated; showing the retained tail." /> : null}
    {error ? <Alert type="error" title={error} /> : null}
    <div className="sessions-conversation-messages" role="log" aria-live="polite">
      {messages(frames).map((message) => <article key={message.id}><strong>{message.label}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</p></article>)}
    </div>
    <form onSubmit={(event) => { event.preventDefault(); send(); }}>
      <Input.TextArea aria-label="Message Codex" value={text} onChange={(event) => setText(event.target.value)} disabled={state !== 'ready' || submitting} rows={3} />
      <Button htmlType="submit" type="primary" disabled={state !== 'ready' || submitting || !text.trim()}>Send</Button>
      <Button disabled={state !== 'running'} onClick={() => socket.current?.send(JSON.stringify({ type: 'interrupt' }))}>Cancel response</Button>
    </form>
  </section>;
}
