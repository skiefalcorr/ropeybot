/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Safe integration test for the LLM agent.
 *
 * This does NOT connect to the live BC server. It only talks to the local
 * llama-server and exercises the real LLMClient + real tool definitions to
 * validate the full tool-calling loop:
 *
 *   system prompt + user message  ->  LLM returns a tool call
 *   -> we run the (connection-free) tool handler
 *   -> we feed the result back  ->  LLM produces a final answer.
 *
 * Run with:  npx tsx bin/llm/test.ts
 */

import { LLMClient, LLMMessage } from "./llmClient";
import { buildTools, Tool, ToolContext } from "./tools";

const LLM_URL = "http://localhost:8080";
const MODEL = "..\\Bloke\\Qwen3.8-27B-UD-IQ4_XS.gguf";

// Tools that are safe to run without a live BC connection (pure catalog reads).
const SAFE_TOOLS = new Set(["listItems", "listClothing", "listPoses"]);

// A minimal ToolContext. The connection-free tools never touch `conn`, so we
// pass a stub. (Connection-dependent tools are filtered out of the prompt.)
const stubCtx: ToolContext = {
    conn: undefined as never,
    config: { url: LLM_URL, persona: "test" },
    protectedMembers: [],
    suspended: new Map(),
    actionTimestamps: [],
    lastActionByTarget: new Map(),
    leashed: new Map(),
    participants: new Set(),
};

function onlySafe(tools: Tool[]): Tool[] {
    return tools.filter((t) => SAFE_TOOLS.has(t.name));
}

async function main() {
    const client = new LLMClient(LLM_URL, undefined, 120_000);
    const allTools = buildTools();
    const tools = onlySafe(allTools);

    console.log(
        `Loaded ${allTools.length} tools total; exposing ${tools.length} safe ones:`,
    );
    console.log("  " + tools.map((t) => t.name).join(", "));
    console.log("");

    const systemPrompt =
        "You are a helpful assistant in a Bondage Club chat room. " +
        "You can call tools to look up valid item and pose names. " +
        "When asked to find items, use the listItems tool, then summarise the results.";

    const messages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        {
            role: "user",
            content:
                "What gag items are available? Use the listItems tool to search for 'gag' and tell me.",
        },
    ];

    const toolDefs = tools.map((t) => t.definition);
    const handlerByName = new Map(tools.map((t) => [t.name, t.handler]));

    console.log(">>> Calling LLM (turn 1) with tools...");
    const t0 = Date.now();
    let result = await client.chat(messages, {
        model: MODEL,
        tools: toolDefs,
        temperature: 0.3,
        max_tokens: 512,
    });
    console.log(`<<< ${Date.now() - t0}ms, finish=${result.finishReason}`);

    // If the model called a safe tool, run it and feed the result back.
    if (result.toolCalls.length > 0) {
        for (const call of result.toolCalls) {
            const name = call.function.name;
            const args = LLMClient.parseToolArgs(call.function.arguments);
            console.log(`\n[tool_call] ${name}(${JSON.stringify(args)})`);

            messages.push({
                role: "assistant",
                content: result.content,
                tool_calls: [call],
            });

            const handler = handlerByName.get(name);
            let toolResult: string;
            if (!handler) {
                toolResult = `Error: unknown tool '${name}'.`;
            } else {
                try {
                    toolResult = await handler(args, stubCtx);
                } catch (e) {
                    toolResult = `Error running tool: ${String(e)}`;
                }
            }
            console.log(`[tool_result] ${toolResult.slice(0, 300)}`);

            messages.push({
                role: "tool",
                content: toolResult,
                tool_call_id: call.id,
                name,
            });
        }

        console.log("\n>>> Calling LLM (turn 2) with tool result...");
        const t1 = Date.now();
        result = await client.chat(messages, {
            model: MODEL,
            tools: toolDefs,
            temperature: 0.3,
            max_tokens: 512,
        });
        console.log(`<<< ${Date.now() - t1}ms, finish=${result.finishReason}`);
    }

    console.log("\n=== FINAL ANSWER ===");
    console.log(result.content ?? "(no content)");
    console.log("====================");

    if (result.usage) {
        console.log(
            `\nUsage: ${result.usage.prompt_tokens} prompt / ${result.usage.completion_tokens} completion tokens`,
        );
    }

    console.log(
        "\nTEST PASSED: LLM chat + native tool calling works end-to-end.",
    );
}

main().catch((e) => {
    console.error("TEST FAILED:", e);
    process.exit(1);
});
