import { z } from "zod";
import type { NativeSessionService } from "./native-sessions.js";
import { CodexConversationError, type CodexConversationAttachment } from "./runtime-host/codex-conversation.js";

const command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), text: z.string().trim().min(1) }).strict(),
  z.object({ type: z.literal("interrupt") }).strict(),
]);
interface Socket { send(data: string): void; close(code?: number, reason?: string): void; raw?: unknown }

/** A socket owns exactly one attachment; a rejected socket cannot detach another. */
export function conversationSocket(service: NativeSessionService | undefined, id: string, capability: string, cursor: string) {
  let attachment: CodexConversationAttachment | undefined;
  let disposed = false;
  const detach = () => { disposed = true; attachment?.detach(); attachment = undefined; };
  const send = (ws: Socket, value: unknown) => {
    if (disposed) return;
    const raw = ws.raw as { bufferedAmount?: number } | undefined;
    const json = JSON.stringify(value);
    if ((raw?.bufferedAmount ?? 0) + Buffer.byteLength(json) > 2_097_152) throw new Error("conversation backpressure");
    ws.send(json);
  };
  const reject = (ws: Socket) => { detach(); ws.close(1008, "Conversation unavailable"); };
  return {
    onOpen(_event: unknown, ws: Socket) {
      if (disposed) return reject(ws);
      if (!/^(0|[1-9][0-9]{0,15})$/.test(cursor)) return reject(ws);
      attachment = service?.attachConversation(id, capability, (frame) => send(ws, frame), Number(cursor));
      if (!attachment) reject(ws);
    },
    onMessage(event: { data: unknown }, ws: Socket) {
      if (!attachment || disposed) return reject(ws);
      try {
        if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 270_000) return reject(ws);
        const value = command.parse(JSON.parse(event.data));
        const pending = value.type === "prompt" ? attachment.submit(value.text) : attachment.interrupt();
        void pending.catch((error: unknown) => {
          try { send(ws, { type: "error", code: error instanceof CodexConversationError && error.code === "busy" ? "busy" : "unavailable" }); }
          catch { reject(ws); }
        });
      } catch (error) {
        if (error instanceof CodexConversationError && error.code === "busy") {
          try { send(ws, { type: "error", code: "busy" }); } catch { reject(ws); }
        } else reject(ws);
      }
    },
    onClose() { detach(); },
    onError() { detach(); },
  };
}
