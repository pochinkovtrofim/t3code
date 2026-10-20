import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import {
  describeMcpElicitation,
  isAutoAcceptedT3ToolCallElicitation,
  toMcpElicitationResponse,
} from "./CodexMcpElicitation.ts";

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("T3 tool calls in a read-only orchestrating turn", () => {
  const orchestrating: ProviderAdapterV2RuntimePolicy = {
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/repo",
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    allowT3Orchestration: true,
  };
  const t3ToolCall = {
    mode: "form",
    message: 'Allow the t3-code MCP server to run tool "t3_thread_launch"?',
    serverName: "t3-code",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"] },
    requestedSchema: { type: "object", properties: {} },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("accepts T3's own tool calls without asking the user", () => {
    NodeAssert.equal(isAutoAcceptedT3ToolCallElicitation(orchestrating, t3ToolCall), true);
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(t3ToolCall, "accept"), {
      action: "accept",
      content: {},
    });
  });

  it("still asks the user for every other request", () => {
    const { allowT3Orchestration: _, ...ordinary } = orchestrating;
    const { _meta: __, ...withoutMetadata } = t3ToolCall;
    for (const [runtimePolicy, payload] of [
      [ordinary, t3ToolCall],
      [orchestrating, { ...t3ToolCall, serverName: "computer-use" }],
      [orchestrating, { ...t3ToolCall, _meta: { codex_approval_kind: "ordinary_form" } }],
      [orchestrating, withoutMetadata],
      [
        orchestrating,
        {
          mode: "url",
          message: "Finish signing in to continue.",
          serverName: "t3-code",
          threadId: "provider-thread-1",
          turnId: "turn-1",
          _meta: { codex_approval_kind: "mcp_tool_call" },
          elicitationId: "sign-in-1",
          url: "https://example.com/authorize",
        },
      ],
    ] satisfies ReadonlyArray<
      readonly [ProviderAdapterV2RuntimePolicy, EffectCodexSchema.McpServerElicitationRequestParams]
    >) {
      NodeAssert.equal(isAutoAcceptedT3ToolCallElicitation(runtimePolicy, payload), false);
    }
  });
});
