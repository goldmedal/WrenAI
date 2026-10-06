/**
 * An offline OpenAI chat-completions endpoint for the `pi-ai` adapter's
 * `fetch` seam: each request gets the next scripted turn as a server-sent
 * event stream, and every request is recorded for assertions.
 */

export type ScriptedTurn =
  | { readonly text: string }
  | { readonly toolCall: { readonly id: string; readonly name: string; readonly input: unknown } }
  | { readonly status: number; readonly error: string };

export interface CapturedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface FakeGateway {
  readonly fetch: typeof fetch;
  readonly requests: CapturedRequest[];
}

const USAGE = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };

function chunk(choice: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): string {
  const payload = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: choice ? [choice] : [], ...extra };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sse(turn: Exclude<ScriptedTurn, { status: number }>): string {
  const events: string[] = [];
  if ("text" in turn) {
    const half = Math.ceil(turn.text.length / 2);
    events.push(chunk({ index: 0, delta: { role: "assistant", content: turn.text.slice(0, half) }, finish_reason: null }));
    events.push(chunk({ index: 0, delta: { content: turn.text.slice(half) }, finish_reason: null }));
    events.push(chunk({ index: 0, delta: {}, finish_reason: "stop" }));
  } else {
    const args = JSON.stringify(turn.toolCall.input);
    const half = Math.ceil(args.length / 2);
    events.push(chunk({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: turn.toolCall.id, type: "function", function: { name: turn.toolCall.name, arguments: "" } }] }, finish_reason: null }));
    events.push(chunk({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }, finish_reason: null }));
    events.push(chunk({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }));
    events.push(chunk({ index: 0, delta: {}, finish_reason: "tool_calls" }));
  }
  events.push(chunk(undefined, { usage: USAGE }));
  events.push("data: [DONE]\n\n");
  return events.join("");
}

/** A fake gateway that replays `script` in order; the last turn repeats once the script runs out when `repeatLast` is set. */
export function fakePiGateway(script: readonly ScriptedTurn[], options: { readonly repeatLast?: boolean } = {}): FakeGateway {
  const requests: CapturedRequest[] = [];
  let next = 0;
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const headers = new Headers(init?.headers ?? request?.headers);
    const rawBody = init?.body ?? (request ? await request.text() : undefined);
    requests.push({ url, headers, body: JSON.parse(String(rawBody)) as Record<string, unknown> });
    const turn = script[next] ?? (options.repeatLast ? script[script.length - 1] : undefined);
    next += 1;
    if (turn === undefined) throw new Error("fake pi gateway: no scripted turn left");
    if ("status" in turn) {
      return new Response(JSON.stringify({ error: { message: turn.error } }), { status: turn.status, headers: { "content-type": "application/json" } });
    }
    return new Response(sse(turn), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}
