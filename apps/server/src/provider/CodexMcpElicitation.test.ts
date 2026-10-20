import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import {
  codexApprovalPolicyForTurn,
  codexMcpElicitationDisposition,
  describeMcpElicitation,
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
  const { allowT3Orchestration: _, ...ordinary } = orchestrating;
  const t3ToolCall = {
    mode: "form",
    message: 'Allow the t3-code MCP server to run tool "t3_thread_launch"?',
    serverName: "t3-code",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_description: "Create an ordinary TOP-LEVEL thread.",
      tool_params: { title: "Append to NOTES.md", message: "Append a line to NOTES.md." },
    },
    requestedSchema: { type: "object", properties: {} },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("lets only MCP approvals through Codex's never policy", () => {
    // Codex fails a non-read-only MCP tool call outright under "never".
    NodeAssert.deepStrictEqual(codexApprovalPolicyForTurn(orchestrating, "never"), {
      granular: {
        mcp_elicitations: true,
        request_permissions: false,
        rules: false,
        sandbox_approval: false,
        skill_approval: false,
      },
    });
    NodeAssert.equal(codexApprovalPolicyForTurn(ordinary, "never"), "never");
    NodeAssert.equal(codexApprovalPolicyForTurn(orchestrating, "on-request"), "on-request");
  });

  it("accepts T3's thread orchestration and read-only tool calls without asking the user", () => {
    for (const tool of ["t3_thread_launch", "t3_thread_list", "t3_project_read"]) {
      const payload = {
        ...t3ToolCall,
        message: `Allow the t3-code MCP server to run tool "${tool}"?`,
      };
      NodeAssert.equal(codexMcpElicitationDisposition(orchestrating, payload), "accept");
    }
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(t3ToolCall, "accept"), {
      action: "accept",
      content: {},
    });
  });

  it("declines every other elicitation in that turn, as never would", () => {
    const { _meta: __, ...withoutMetadata } = t3ToolCall;
    for (const payload of [
      { ...t3ToolCall, serverName: "computer-use" },
      {
        ...t3ToolCall,
        serverName: "computer-use",
        message: 'Allow the t3-code MCP server to run tool "t3_thread_list"?',
      },
      { ...t3ToolCall, message: 'Allow the t3-code MCP server to run tool "t3_project_delete"?' },
      { ...t3ToolCall, message: 'Allow the t3-code MCP server to run tool "schedule_task"?' },
      { ...t3ToolCall, message: "Allow the t3-code MCP server to run this tool?" },
      { ...t3ToolCall, _meta: { codex_approval_kind: "ordinary_form" } },
      withoutMetadata,
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
    ] satisfies ReadonlyArray<EffectCodexSchema.McpServerElicitationRequestParams>) {
      NodeAssert.equal(codexMcpElicitationDisposition(orchestrating, payload), "decline");
    }
  });

  it("leaves every other turn's elicitations to the user", () => {
    NodeAssert.equal(codexMcpElicitationDisposition(ordinary, t3ToolCall), "ask");
    NodeAssert.equal(
      codexMcpElicitationDisposition(ordinary, {
        ...t3ToolCall,
        message: 'Allow the t3-code MCP server to run tool "t3_thread_list"?',
      }),
      "ask",
    );
  });
});
