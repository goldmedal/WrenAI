import type { NativeSessionService } from "./native-sessions.js";
import type { ScopedAttachment } from "./openshell-native-sessions.js";

/** Closed event socket. Disconnect releases only subscription, never the worker. */
export function scopedSessionSocket(service: NativeSessionService | undefined, id: string, capability: string, cursor: string) {
  let attachment: ScopedAttachment | undefined;
  return {
    onOpen(_event: unknown, ws: { send(data: string): void; close(code?: number, reason?: string): void }) {
      if (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) { ws.close(1008, "Invalid cursor"); return; }
      attachment = service?.attachScoped(id, capability, frame => ws.send(JSON.stringify(frame)), Number(cursor));
      if (!attachment) ws.close(1008, "Scoped session unavailable");
    },
    onMessage(event: { data: unknown }, ws: { send(data: string): void; close(code?: number, reason?: string): void }) {
      try {
        if (!attachment || typeof event.data !== "string" || Buffer.byteLength(event.data) > 263_168) throw Error();
        const frame = JSON.parse(event.data);
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw Error();
        const operation = frame.type === "prompt" && Object.keys(frame).sort().join(",") === "requestId,text,type" && typeof frame.requestId === "string" && typeof frame.text === "string"
          ? attachment.submit(frame.requestId, frame.text)
          : frame.type === "cancel" && Object.keys(frame).join(",") === "type" ? attachment.cancel() : undefined;
        if (!operation) throw Error();
        void operation.catch(() => { try { ws.send(JSON.stringify({ type: "error", code: "request_unavailable", message: "This request could not complete. Check the session state before trying again." })); } catch { /* detached browser */ } });
      } catch { ws.close(1008, "Invalid scoped request"); }
    },
    onClose() { attachment?.detach(); attachment = undefined; },
  };
}
