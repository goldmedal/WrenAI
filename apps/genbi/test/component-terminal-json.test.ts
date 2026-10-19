import { describe, expect, it } from "vitest";
import { parseTerminalJson } from "../harness/components/terminal-json.js";

const entries = [
  { slot_id: "a", columns: ["n"], rows: [[1672]], summary: "a answered", verified: true, definition: { query_id: "q1" } },
  { slot_id: "b", columns: ["n"], rows: [[100]], summary: "b answered", verified: true, definition: { query_id: "q2" } },
];
const pretty = JSON.stringify(entries, null, 2);
const fenced = (body: string) => "```json\n" + body + "\n```";

/** A terminal recorded from a hosted model: the same four-slot answer, fenced, printed twice in a row. */
const RECORDED_DUPLICATED_FENCED_BLOCK = "```json\n[\n  {\n    \"slot_id\": \"annual_revenue\",\n    \"columns\": [\"total_revenue\"],\n    \"rows\": [[1672]],\n    \"summary\": \"Total revenue across all orders in 2018 was $1,672 USD.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q1\"}\n  },\n  {\n    \"slot_id\": \"annual_order_count\",\n    \"columns\": [\"order_count\"],\n    \"rows\": [[99]],\n    \"summary\": \"99 orders were placed in 2018.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q2\"}\n  },\n  {\n    \"slot_id\": \"monthly_revenue\",\n    \"columns\": [\"month\", \"revenue\"],\n    \"rows\": [[1, 496], [2, 415], [3, 622], [4, 139]],\n    \"summary\": \"Monthly revenue in 2018 showed Q1 strength with March peaking at $622, followed by January at $496 and February at $415, while Q2 started softer with April at $139.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q3\"}\n  },\n  {\n    \"slot_id\": \"revenue_by_status\",\n    \"columns\": [\"status\", \"revenue\"],\n    \"rows\": [[\"completed\", 1103], [\"placed\", 284], [\"shipped\", 198], [\"returned\", 49], [\"return_pending\", 38]],\n    \"summary\": \"Revenue by order status in 2018 was led by completed orders at $1,103, followed by placed orders at $284, shipped orders at $198, returned orders at $49, and return pending orders at $38.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q4\"}\n  }\n]\n```\n```json\n[\n  {\n    \"slot_id\": \"annual_revenue\",\n    \"columns\": [\"total_revenue\"],\n    \"rows\": [[1672]],\n    \"summary\": \"Total revenue across all orders in 2018 was $1,672 USD.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q1\"}\n  },\n  {\n    \"slot_id\": \"annual_order_count\",\n    \"columns\": [\"order_count\"],\n    \"rows\": [[99]],\n    \"summary\": \"99 orders were placed in 2018.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q2\"}\n  },\n  {\n    \"slot_id\": \"monthly_revenue\",\n    \"columns\": [\"month\", \"revenue\"],\n    \"rows\": [[1, 496], [2, 415], [3, 622], [4, 139]],\n    \"summary\": \"Monthly revenue in 2018 showed Q1 strength with March peaking at $622, followed by January at $496 and February at $415, while Q2 started softer with April at $139.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q3\"}\n  },\n  {\n    \"slot_id\": \"revenue_by_status\",\n    \"columns\": [\"status\", \"revenue\"],\n    \"rows\": [[\"completed\", 1103], [\"placed\", 284], [\"shipped\", 198], [\"returned\", 49], [\"return_pending\", 38]],\n    \"summary\": \"Revenue by order status in 2018 was led by completed orders at $1,103, followed by placed orders at $284, shipped orders at $198, returned orders at $49, and return pending orders at $38.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q4\"}\n  }\n]\n```";
/** A terminal recorded from a hosted model: a fenced pretty-printed answer, then the same answer minified. */
const RECORDED_PRETTY_THEN_MINIFIED = "I'll now construct the final JSON response with all the verified results:\n\n```json\n[\n  {\n    \"slot_id\": \"total_customers\",\n    \"columns\": [\"value\"],\n    \"rows\": [[100]],\n    \"summary\": \"There are 100 customers in total.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q1\"}\n  },\n  {\n    \"slot_id\": \"total_orders\",\n    \"columns\": [\"value\"],\n    \"rows\": [[99]],\n    \"summary\": \"There are 99 orders in total.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q2\"}\n  },\n  {\n    \"slot_id\": \"total_revenue\",\n    \"columns\": [\"value\"],\n    \"rows\": [[1672]],\n    \"summary\": \"The total revenue across all orders is $1,672.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q3\"}\n  },\n  {\n    \"slot_id\": \"avg_order_value\",\n    \"columns\": [\"value\"],\n    \"rows\": [[16.88888888888889]],\n    \"summary\": \"The average order value is $16.89.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q4\"}\n  },\n  {\n    \"slot_id\": \"completed_revenue\",\n    \"columns\": [\"value\"],\n    \"rows\": [[1103]],\n    \"summary\": \"The total revenue from completed orders only is $1,103.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q5\"}\n  },\n  {\n    \"slot_id\": \"repeat_customers\",\n    \"columns\": [\"value\"],\n    \"rows\": [[29]],\n    \"summary\": \"29 customers have placed more than one order.\",\n    \"verified\": true,\n    \"definition\": {\"query_id\": \"q6\"}\n  }\n]\n```\n\n[{\"slot_id\":\"total_customers\",\"columns\":[\"value\"],\"rows\":[[100]],\"summary\":\"There are 100 customers in total.\",\"verified\":true,\"definition\":{\"query_id\":\"q1\"}},{\"slot_id\":\"total_orders\",\"columns\":[\"value\"],\"rows\":[[99]],\"summary\":\"There are 99 orders in total.\",\"verified\":true,\"definition\":{\"query_id\":\"q2\"}},{\"slot_id\":\"total_revenue\",\"columns\":[\"value\"],\"rows\":[[1672]],\"summary\":\"The total revenue across all orders is $1,672.\",\"verified\":true,\"definition\":{\"query_id\":\"q3\"}},{\"slot_id\":\"avg_order_value\",\"columns\":[\"value\"],\"rows\":[[16.88888888888889]],\"summary\":\"The average order value is $16.89.\",\"verified\":true,\"definition\":{\"query_id\":\"q4\"}},{\"slot_id\":\"completed_revenue\",\"columns\":[\"value\"],\"rows\":[[1103]],\"summary\":\"The total revenue from completed orders only is $1,103.\",\"verified\":true,\"definition\":{\"query_id\":\"q5\"}},{\"slot_id\":\"repeat_customers\",\"columns\":[\"value\"],\"rows\":[[29]],\"summary\":\"29 customers have placed more than one order.\",\"verified\":true,\"definition\":{\"query_id\":\"q6\"}}]";

describe("a prose terminal holding one JSON value", () => {
  it("parses the same answer printed twice, fenced both times", () => {
    expect(parseTerminalJson(`Here you go:\n\n${fenced(pretty)}\n${fenced(pretty)}`)).toEqual({ ok: true, value: entries });
  });
  it("parses the same answer printed twice in different layouts (pretty, then minified)", () => {
    expect(parseTerminalJson(`${fenced(pretty)}\n\n${JSON.stringify(entries)}`)).toEqual({ ok: true, value: entries });
  });
  it("parses the recorded duplicated terminals", () => {
    for (const recorded of [RECORDED_DUPLICATED_FENCED_BLOCK, RECORDED_PRETTY_THEN_MINIFIED]) {
      const parsed = parseTerminalJson(recorded);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(Array.isArray(parsed.value) && parsed.value.every((entry) => typeof entry.slot_id === "string")).toBe(true);
    }
    const first = parseTerminalJson(RECORDED_DUPLICATED_FENCED_BLOCK);
    expect(first.ok && Array.isArray(first.value) && first.value.map((entry) => entry.slot_id)).toEqual(["annual_revenue", "annual_order_count", "monthly_revenue", "revenue_by_status"]);
  });
  it("still refuses two different answers: ambiguous, so prose", () => {
    const changed = entries.map((entry) => entry.slot_id === "a" ? { ...entry, rows: [[1673]] } : entry);
    expect(parseTerminalJson(`${fenced(pretty)}\n${fenced(JSON.stringify(changed, null, 2))}`).ok).toBe(false);
    expect(parseTerminalJson(`${JSON.stringify(entries[0])} and ${JSON.stringify(entries[1])}`).ok).toBe(false);
  });
  it("still refuses pseudo-JSON and plain prose", () => {
    expect(parseTerminalJson('Now let me build the batch result:\n["completed_revenue": The total was $1,103.\n "completed_orders": 99]').ok).toBe(false);
    expect(parseTerminalJson("I ran the query; the total is 1672.").ok).toBe(false);
  });
  it("keeps a single value and a loose array without batch entries as before", () => {
    expect(parseTerminalJson(`Answer:\n${fenced(pretty)}`)).toEqual({ ok: true, value: entries });
    expect(parseTerminalJson("The totals are [1, 2, 3].").ok).toBe(false);
  });
});
