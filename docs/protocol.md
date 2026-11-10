# Agent Feedback Protocol

**Version 0.1.0, draft, 10 November 2026**

This document specifies how a coding agent reports back to the person it works for when a workspace application sits between them: what the user sees, when an input counts as answered, how the agent asks a question that waits for the user, and how the workspace tells the agent where an input came from. It is written down from what [Savor](https://github.com/robinchoice/savor) does today, so that other workspaces and agents can implement it without reading Savor's code.

This is a draft. Anything here may change before 1.0. Version 1.0, a reference implementation as its own package and conformance tests are planned for 2027.

License: this specification is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Savor's code, including its implementation of this protocol, stays under AGPL-3.0.

## 1. Purpose

An agent CLI streams everything it produces: thoughts, tool calls, intermediate text, the final answer. A user who hands a task over and comes back later, possibly from a phone, does not want to read that stream. They want to know three things: did the agent pick the task up, what is the result, and does it need them.

The protocol makes these explicit. The agent calls a small set of tools for the messages meant for the user. Everything else it outputs is an activity log. The workspace can then show a reliable state per conversation (working, waiting for you, finished), send a notification only when something needs the user, and hold a question open across turns, process restarts and devices.

Non-goals: the protocol does not define how a workspace starts or drives an agent (that is the agent's own interface, see section 10), how it stores conversations, or how it renders messages.

## 2. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY" and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they appear in all capitals.

## 3. Roles and terms

- **User**: the person the work is for. They read messages and answer questions, on the computer the host runs on or on a paired device.
- **Host**: the workspace application. It starts agents, passes the user's inputs to them, offers the protocol's tools, stores the messages and shows them to the user. Savor is a host.
- **Agent**: a coding agent (an LLM with tools) that the host runs. It calls the protocol's tools.
- **Conversation**: a sequence of inputs and messages between the user and one agent at a time. The host may switch the agent of a conversation.
- **Input**: one message the host delivers to the agent: from the user, from another conversation's agent, or from a scheduled run.
- **Request**: an input together with everything the agent sends for it, until its conclusion.
- **Turn**: one run of the agent on an input, from delivery until the agent stops. A request usually takes one turn; it can take more (section 5.6).
- **Message**: what the agent sends to the user through the protocol: an **acknowledgement**, an **update** or a **conclusion**.
- **Question**: a decision the agent asks the user for in its conclusion. It **blocks**: the conversation waits for the user.

## 4. Transport and setup

The protocol is a set of tools of a [Model Context Protocol](https://modelcontextprotocol.io/specification/2025-11-25) (MCP) server that the host runs. The agent is its MCP client.

1. The host MUST offer the core tools (section 7) to the agent of each conversation through an MCP server. Savor runs one MCP endpoint over Streamable HTTP and binds each connection to a conversation through the URL (`/mcp?project=<id>&thread=<id>`), authenticated with a bearer token.
2. A tool call MUST apply to the conversation and request the agent works on. The agent MUST NOT need to pass a conversation or request id.
3. The host MUST tell the agent the rules of section 5 in its instructions, in a form the agent reads before every input (a system prompt, developer instructions, or the text in front of the first prompt of a session). Savor's wording is `PROTOCOL` in `server/session.ts`. Where an agent interface has no system prompt, the host SHOULD repeat a short reminder with each input.
4. The host MUST put a context object (section 6) in front of every input.
5. Tool results are MCP `CallToolResult`s with one text content item holding JSON. A call the host refuses MUST end as an MCP tool error (`isError: true`) whose text tells the agent what to do instead.

## 5. Lifecycle of an input

### 5.1 Acknowledgement and conclusion

1. Every request MUST get exactly one conclusion, through `send_conclusion_message`.
2. An agent that can answer right away SHOULD send the conclusion directly. Otherwise it MUST send exactly one acknowledgement through `send_acknowledgement_message` before it starts the work.
3. The first of these two calls for a request MUST carry a `summary`: one short sentence on what the input asks for. The host SHOULD show it in its list of conversations.
4. The host MUST accept a repeated acknowledgement with the same text as a retry and return the id of the first one. It MUST refuse an acknowledgement with different text for the same request.
5. The host MUST accept a repeated conclusion with identical `text`, `questions`, `suggestions` and `commits` as a retry, and MUST refuse a different second conclusion. `summary` does not count for this comparison.
6. After its conclusion, the agent MUST end its turn.
7. Text the agent outputs outside these tools is not a message. The host SHOULD keep it in an activity log and MUST NOT notify the user about it.

### 5.2 Updates

1. The agent SHOULD send updates through `send_user_requested_message` only when the user explicitly asked for them, e.g. progress reports. Updates are not for unsolicited status.
2. Each distinct update MUST carry its own `idempotencyKey`. A retry MUST reuse key and text. The host MUST return the first message's id for a repeated key with the same text and MUST refuse it with different text.

### 5.3 Inputs while the agent works

1. Input the user sends while the agent works on a request MUST, by default, wait in a queue and reach the agent as the next input after the current conclusion.
2. A host MAY let the user add an input to the running request instead. The host MUST then mark it as such (Savor starts it with `The user adds this to the current request while you work:`). It gets no acknowledgement of its own, and the agent MUST cover it in the conclusion of the current request.

### 5.4 Questions

1. The agent asks the user by putting `questions` into its conclusion. A conclusion MUST have `text`, `questions` or both.
2. Every question blocks. After a conclusion with questions, the agent MUST end its turn and wait for the answer as its next input.
3. A question has a `title`, an optional `body` and up to 8 `options`. An empty `options` list asks for a free-text answer. A conclusion holds up to 10 questions.
4. When a question offers options, the agent MUST set `recommended` to the index of the option it recommends and SHOULD explain why in `body`. The host MUST refuse a question with options and without a valid `recommended`.
5. The host MUST keep the questions open across turns and restarts until the user answers them, and MUST count the conversation as waiting for the user while any is open.
6. The host delivers the answers as the next input. Savor writes one block per question, separated by a blank line: `Decision: <title>` followed by `Selected: <option>`, `Answer: <text>` or `Not answered`, and a final `Comment: <text>` when the user wrote one.
7. When the user sends a new input instead of answering, the host SHOULD count the open questions of earlier conclusions as skipped. Input from another conversation's agent MUST NOT skip them.
8. The host SHOULD give the agent the recent questions and their answers in the context object (`decisions`).

### 5.5 Suggestions and commits

1. A conclusion MAY carry up to 3 `suggestions`: follow-up prompts in the user's voice that the host can offer as one-tap inputs.
2. A conclusion SHOULD list in `commits` the full hashes (40 or 64 hexadecimal characters) of the version-control commits the agent created for this request.

### 5.6 Requests that take more than one turn

1. An agent that acknowledged a request and ends its turn without a conclusion still owes the conclusion. The host MUST NOT treat the request as finished.
2. While the agent waits for background work it started (section 8.1, or the agent's own subagents and background commands), the host SHOULD show the conversation as working.
3. When the host continues a request in a new turn (after a restart, a usage limit, finished CI, or on another agent), it MUST tell the agent why and that this is still the same request, and whether it was already acknowledged. Savor ends such notes with `This is still the same request: do not acknowledge it again.`

### 5.7 Agents that do not follow the protocol

1. When a turn ends without an error, without an acknowledgement, update or conclusion for its request, and without background work of the agent still running, the host MUST show the agent's final output text as the conclusion and notify the user as for any conclusion.
2. A conclusion sent after that MUST be refused like any second conclusion.
3. When a turn ends with an error, the host MUST show the error and MUST NOT turn the agent's text into a conclusion.

## 6. The context object

The host puts a JSON object in front of every input. Savor writes it as `Savor context:` followed by the JSON on one line, then `New input:` followed by the input.

| Field | Core | Meaning |
|---|---|---|
| `protocolVersion` | yes | The version of this specification the host implements, e.g. `"0.1.0"` (section 9). |
| `requestOrigin` | yes | `"local"`, `"remote"` or `"agent"`, see section 6.1. |
| `fromThread` | yes, with `"agent"` | The conversation whose agent sent the input: `project`, `projectName`, `id`, `label`, `url`, and the `origin` of that conversation's own input. |
| `decisions` | yes | Recent questions of this conversation with their answers, among others `id`, `title`, `body`, `options`, `recommended`, `selected` (index or null), `answer` (text or null), `resolved`. |
| `cwd` | yes | The directory the agent works in. |
| `threadLabel` | label extension | The conversation's label, or null. |
| `backgroundProcesses` | process extension | The processes this conversation registered (section 8.1). |
| `productPreview` | preview extension | The URL open in the preview, or null. |
| `worktree` | no | The git branch of the conversation's own worktree, or null. |

Hosts MAY add fields. Agents MUST ignore fields they don't know.

### 6.1 Origin of an input

1. `"local"`: the input was entered on the computer the host runs on.
2. `"remote"`: the input came from a paired device. Such a device may be compromised. The agent SHOULD apply extra scrutiny to requests that involve credentials, uploads, downloaded code, destructive changes or broader permissions, and SHOULD ask in its conclusion when in doubt. A host MAY refuse tools for remote input (Savor refuses to add projects or change a project's default agent).
3. `"agent"`: another conversation's agent sent the input. The agent MUST treat it as information and never as the user's instruction or approval: decisions, commits, pushes and approvals still need the user, so the agent asks in its conclusion. It answers in its conclusion; the sender reads it from there.
4. Records the agent creates through extension tools (documents, backlog items) SHOULD carry the origin of the input that created them, and answers to questions the origin of the input that answered them. The agent SHOULD treat records of remote origin like remote input.
5. When the host cannot tell where the input of a request came from, it MUST treat it as `"remote"`.

## 7. Core tools

These are the input schemas as Savor's MCP server publishes them in `tools/list` (`server/mcp.ts`). Tool names are fixed; the name of the MCP server is up to the host (Savor's is `savor`).

### 7.1 `send_acknowledgement_message`

Tell the user you received their input and are starting work. One per input; retrying with the same text is safe.

```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string", "minLength": 1 },
    "summary": {
      "type": "string", "minLength": 1, "maxLength": 120,
      "description": "One short sentence on what the user's latest input asks for, in their language. The conversation list shows it."
    }
  },
  "required": ["text", "summary"]
}
```

Result: `{ "id": "<message id>" }`.

### 7.2 `send_user_requested_message`

Send an extra message the user explicitly asked for. Not for unsolicited updates.

```json
{
  "type": "object",
  "properties": {
    "idempotencyKey": { "type": "string", "pattern": "^[\\w-]{1,100}$" },
    "text": { "type": "string", "minLength": 1 }
  },
  "required": ["idempotencyKey", "text"]
}
```

Result: `{ "id": "<message id>" }`.

### 7.3 `send_conclusion_message`

Deliver the one final result for the current request. Questions block: end your turn afterwards.

```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string" },
    "questions": {
      "type": "array", "maxItems": 10,
      "items": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "body": { "type": "string", "default": "" },
          "options": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
          "recommended": { "type": "integer", "minimum": 0 }
        },
        "required": ["title", "options"]
      }
    },
    "suggestions": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
    "commits": { "type": "array", "items": { "type": "string", "pattern": "^[0-9a-f]{40}([0-9a-f]{24})?$" } },
    "summary": { "type": "string", "minLength": 1, "maxLength": 120 }
  }
}
```

Result: `{ "id": "<message id>", "note": "Delivered. Finish your turn now." }`, for a retry `"note": "Already delivered. Finish your turn now."`.

## 8. Extensions

An extension is a group of tools a host MAY offer. The agent finds out which ones a host offers from `tools/list`; a host that offers one tool of an extension SHOULD offer all of them. In v0.1 extensions are described, not yet specified normatively; their schemas are those in `server/mcp.ts`.

### 8.1 Background processes

`register_process` (`pid`, `name`, `command`, optional `cwd`, `url`, `log` matching `^\.savor-logs/[\w-]+\.log$`) and `unregister_process` (`pid`). The agent registers every process it starts that outlives the command, right after launch, and unregisters it after stopping it. The host shows them, keeps their logs, lists them in `backgroundProcesses` and counts an acknowledged request without conclusion as waiting while one runs (section 5.6).

### 8.2 Preview

`open_browser` (`url`) shows a web product beside the conversation, in a browser the agent controls: `browser_inspect` (text, controls with refs, console errors), `browser_click`, `browser_fill`, `browser_type`, `browser_pointer`, `browser_press`, `browser_scroll`, `browser_navigate`, `browser_screenshot`. The user sees the page the agent controls.

### 8.3 Conversation label

`set_thread_label` (`label`, 1–80 characters, 3–6 words). The agent calls it first when `threadLabel` is null.

### 8.4 CI

`watch_ci` (optional `commit`, `project`). After a push, the host watches the commit's CI runs. When they are not all finished, the agent ends its turn without a conclusion if its conclusion depends on them, and the host continues the request with their result (section 5.6).

### 8.5 Records

- Documents: `list_documents`, `read_document`, `create_document`, `update_document`.
- Backlog: `list_backlog`, `add_to_backlog`, `remove_from_backlog`.
- Workflows (saved prompts, scheduled and chained): `list_workflows`, `read_workflow`, `create_workflow`, `update_workflow`, `delete_workflow`, `run_workflow`, `list_workflow_runs`, and for runs `begin_workflow_step` and `report_workflow_result`. Updates and deletions carry the `revision` the agent read.

The agent uses these tools instead of editing the host's files. Results carry a URL the agent links in its messages.

### 8.6 Other conversations and projects

`list_projects`, `create_project`, `move_project`, `remove_project`, `list_conversations`, `read_conversation`, `start_conversation`, `send_to_conversation`, `complete_conversation`, `list_agents`, `set_project_agent`. Messages between agents arrive with origin `"agent"` (section 6.1). A turn set off by another agent's message cannot send one itself, so two agents cannot keep each other busy.

## 9. Versioning

1. This specification is versioned with [Semantic Versioning 2.0.0](https://semver.org). A change that a conforming agent or host would break on (removing or renaming a core tool or field, a stricter schema, a new MUST) raises the major version; a new optional field, tool or extension raises the minor version; clarifications raise the patch version. Before 1.0.0, minor versions MAY break.
2. A host MUST report the version it implements as `protocolVersion` in the context object (section 6).
3. A host SHOULD report its own name and version as `serverInfo` in the MCP `initialize` result. That is the implementation's version, not the protocol's.
4. Extensions are discovered through `tools/list`, not through the version.

## 10. Relation to MCP and ACP

The protocol builds on two open standards and adds only what they leave open.

**MCP** ([specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)) is the transport. Tools, their JSON Schemas, tool errors and the Streamable HTTP transport come from MCP unchanged; every agent with an MCP client can speak this protocol without new code. MCP defines how a model calls a tool, not what a conversation with a user owes: it has no notion of an input being answered, of a single result, or of model output the user doesn't see.

**MCP elicitation** ([client/elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)) lets a server ask the user through the client, during a request: form mode with a flat schema of strings, numbers, booleans and enums, URL mode for pages like a sign-in. The answer is `accept`, `decline` or `cancel`. It is synchronous: the tool call, and with it the agent's turn, waits for the user. That fits short questions while the user is present. The questions of section 5.4 are for the other case: the turn ends, the agent process may end, the user answers hours later from another device, and the answer becomes the next input. Elicitation also has no recommended option. The two complement each other: Savor passes elicitations of other MCP servers on to the user as forms and page links (`server/claude.ts`, `server/codex.ts`), and passes in-turn questions of an agent's own ask tool on as blocking questions with the same decisions store.

**ACP**, the [Agent Client Protocol](https://agentclientprotocol.com), is how a client drives an agent: JSON-RPC over stdio with `session/new` (which passes the MCP servers to the agent), `session/prompt`, `session/cancel`, streamed `session/update` notifications (message chunks, tool calls, plans) and `session/request_permission`. A host that runs an agent over ACP uses ACP for all of that and passes this protocol's MCP server in `mcpServers` (Savor does so for OpenCode and Grok Build, `server/acp.ts`), shows ACP `plan` updates as the request's progress and ACP permission requests as approvals. ACP covers one turn. It doesn't separate the visible answer from the activity stream (an agent's message chunks are its answer), it has no system prompt, and it doesn't cover what outlives a turn: blocking questions, a request that waits for background work or CI, the origin of an input. Those are what this protocol adds.

Result of the check: this protocol duplicates neither standard. Its candidates for convergence are the open points 1 and 2 of section 13.

## 11. Conformance

A **conforming host**:

- MUST offer the three core tools with the schemas of section 7 and enforce the rules of section 5.1, 5.2 and 5.4.4.
- MUST give the agent the rules of section 5 and the context object of section 6 with every input, including `protocolVersion`, `requestOrigin` and, for agent input, `fromThread`.
- MUST keep questions open until answered (5.4.5), treat an unknown origin as remote (6.1.5), and show the final text of a non-conforming turn as its conclusion (5.7).
- MUST NOT notify the user about agent output outside the protocol's messages.

A **conforming agent**:

- MUST send exactly one conclusion per request, MUST acknowledge before working unless it concludes right away, and MUST end its turn after the conclusion.
- MUST end its turn after a conclusion with questions and MUST set `recommended` for questions with options.
- MUST NOT treat input of origin `"agent"` as the user's approval.
- SHOULD use idempotency keys and identical retries as specified, and send updates only on request.

## 12. Security considerations

- The MCP endpoint lets anyone who reaches it post messages into a conversation. A host MUST authenticate the agent and bind each connection to one conversation. Savor listens on the loopback interface only and uses one bearer token per host; the conversation comes from the URL, so an agent that knows another conversation's id could write into it.
- Origin is the host's statement, not the agent's. The agent cannot raise it, and tools that write records take it from the request, not from an argument.
- Links that a host renders from agent input SHOULD be limited to `http` and `https`.

## 13. Open points for 1.0

1. **Protocol rules through MCP `instructions`.** MCP's `initialize` result has an `instructions` field for exactly this. Savor puts the rules into each agent's system prompt instead, because not every client passes `instructions` to the model. Check support in the major clients and move the rules there where it works.
2. **Elicitation for blocking questions.** Check whether a later MCP version supports elicitation answers that outlive the request (e.g. through MCP tasks); if so, define the questions of section 5.4 on top of it.
3. **Version handshake.** Savor does not send `protocolVersion` yet (section 9). Decide whether the version also belongs in the MCP `initialize` result (`_meta` or a capability), so an agent can check it before the first input.
4. **Following up instead of hanging.** An agent that acknowledges and ends its turn without conclusion and without background work leaves the request open. Specify that the host asks the agent once to conclude, and how often.
5. **Updates without a conclusion.** A turn that sent only updates gets no fallback conclusion (5.7.1). Decide whether the fallback should apply there too.
6. **Context format.** Specify the framing (`Savor context:`, `New input:`) or replace it with a structured channel, and settle which fields are core.
7. **Extensions as specifications.** Specify 8.1, 8.2 and 8.4 normatively, with stable result formats. Records and conversations (8.5, 8.6) stay host-specific unless a second host wants them.
8. **Approvals and plans.** Decide whether the protocol covers them or leaves them to ACP and the agent's own interface, as v0.1 does.
9. **Conformance tests and a reference implementation**, plus a second host or agent that implements the protocol.
10. **One credential per conversation** instead of one per host (section 12).
11. **Name.** "Agent Feedback Protocol" is a working title.

## References

- Savor's implementation: `server/session.ts` (rules), `server/mcp.ts` (tools), `server/agents.ts` (requests, questions, origin, fallback).
- [Model Context Protocol, specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25)
- [Agent Client Protocol](https://agentclientprotocol.com)
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174), [Semantic Versioning 2.0.0](https://semver.org)
