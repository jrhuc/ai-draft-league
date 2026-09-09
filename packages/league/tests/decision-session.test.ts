import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { DecisionSession } from "../src/decision-session.js";
import type { Completion, ProviderMessage } from "../src/types.js";

const tools = [
  {
    name: "lookup",
    description: "lookup",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

test("a decision session shares one finite budget across tool and repair loops", async () => {
  let providerCalls = 0;
  let lookups = 0;
  const finals: boolean[] = [];
  const session = new DecisionSession({
    messages: [{ role: "user", content: "decide" }],
    tools,
    lookup: () => {
      lookups += 1;
      return "fact";
    },
    budget: {
      maxProviderCalls: 4,
      maxToolRounds: 2,
      maxToolQueries: 2,
      maxOutputTokens: 100,
    },
  });
  const complete = async (_messages: ProviderMessage[], final: boolean): Promise<Completion> => {
    providerCalls += 1;
    finals.push(final);
    return final
      ? { text: "{}", usage: { output_tokens: 1 }, toolCalls: [] }
      : {
          text: "",
          usage: { output_tokens: 1 },
          toolCalls: [{ id: `call-${providerCalls}`, name: "lookup", arguments: {} }],
        };
  };
  const first = await session.completeToolLoop({
    maxToolRounds: 20,
    finalNotice: "commit",
    complete,
  });
  assert.deepEqual(finals, [false, false, true]);
  assert.equal(first.providerCalls, 3);
  assert.equal(first.toolRounds, 2);
  assert.equal(first.usage.output_tokens, 3);
  assert.equal(first.finalOutputTokens, 1);
  assert.equal(lookups, 2);

  await session.completeToolLoop({ maxToolRounds: 20, finalNotice: "commit", complete });
  assert.deepEqual(finals, [false, false, true, true]);
  assert.equal(session.messages.filter((message) => message.content === "commit").length, 1);
});
