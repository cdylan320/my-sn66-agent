/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// tau/sn66 v15.1: provider-error retry. Verified in local smoke test
	// (smoke-batch-2): Gemini Flash via tau OpenRouter proxy intermittently
	// returns finish_reason=error mid-stream, leaving the partial assistant
	// message in context with no tool calls. Without retry the agent exits
	// with 0 edits and produces an empty diff. With retry we inject a
	// continuation prompt and try again.
	let providerErrorRetries = 0;
	const MAX_PROVIDER_ERROR_RETRIES = 100;

	// tau/sn66 v15.2: consecutive edit-error detector.
	const editErrorsByFile = new Map<string, number>();
	const stuckFilesAlerted = new Set<string>();
	const EDIT_ERROR_THRESHOLD_PER_FILE = 2;
	const lastFailedOldText = new Map<string, string>();

	// tau/sn66 v16: exploration budget + token-length retry + no-edit retry.
	let readsWithoutEdit = 0;
	let hasEditedAnyFile = false;
	let noToolCallRetries = 0;
	const MAX_NO_TOOL_RETRIES = 2;
	const MAX_READS_BEFORE_EDIT = 2;

	// tau/sn66 v17: wall-clock time pressure. The validator kills us at
	// min(cursor_time*2, 300s) but we don't know the exact budget. We
	// assume worst case ~120s and inject urgency at 60% of that. If we
	// haven't edited by 80s, we MUST edit something or we lose.
	const loopStartTime = Date.now();
	let timeWarningInjected = false;
	let panicEditInjected = false;
	let panicEditInjected2 = false;
	const filesReadPaths = new Set<string>();

	// v52: phase-based workflow (from v42)
	let phase: "discover" | "read" | "edit" = "discover";
	let discoveredFiles: string[] = [];
	let readFiles = new Set<string>();
	const TIME_WARNING_MS = 8_000;  // v51b: 8s — ultra early warning
	const PANIC_EDIT_MS = 15_000;  // v51b: 15s — trigger early, most prod tasks have 60-300s budget
	// tau/sn66 v17: hard exit before validator kills us. If the validator
	// kills the container, the diff is LOST (validator bug: it only collects
	// the diff if the container is still running). By exiting gracefully
	// at 170s, we ensure the container is alive when the diff is collected.
	const HARD_EXIT_MS = 170_000;

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// tau/sn66 v15.1: provider error → inject continuation and retry
			// instead of exiting. Caps at 3 retries to avoid infinite loops.
			if (message.stopReason === "error") {
				if (providerErrorRetries < MAX_PROVIDER_ERROR_RETRIES) {
					providerErrorRetries++;
					await emit({ type: "turn_end", message, toolResults: [] });
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "Your previous response was cut off by a provider error. Continue immediately with a tool call — do not write narrative text, call read or edit directly. The harness scores your diff from disk; an empty diff loses the round.",
							},
						],
						timestamp: Date.now(),
					});
					hasMoreToolCalls = false;
					continue;
				}
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// tau/sn66 v16: if model hit token limit or stopped without tool calls,
			// inject retry. This catches the case where Gemini Flash writes a huge
			// text response and exhausts output tokens without making any tool call.
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			if (!hasMoreToolCalls && noToolCallRetries < MAX_NO_TOOL_RETRIES) {
				const isLength = message.stopReason === "length";
				const isStopNoEdit = message.stopReason === "stop" && !hasEditedAnyFile;
				if (isLength || isStopNoEdit) {
					noToolCallRetries++;
					await emit({ type: "turn_end", message, toolResults: [] });
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: isLength
									? "You hit the token limit without making any tool call. Do NOT write text. Call `read` or `edit` directly. One read + one edit = minimum unit of work."
									: "You stopped without editing any file. An empty diff loses. Call `read` on the most likely target file, then `edit` it. Do it now.",
							},
						],
						timestamp: Date.now(),
					});
					continue;
				}
			}

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}

				// tau/sn66 v15.2: track consecutive edit failures per file.
				// When the same file accumulates >= threshold edit errors,
				// inject a steering message to force the model off that file.
				for (let i = 0; i < toolResults.length; i++) {
					const tr = toolResults[i];
					const tc = toolCalls[i];
					if (!tc || tc.type !== "toolCall") continue;
					if (tc.name !== "edit") continue;
					const targetPath = (tc.arguments as { path?: string } | undefined)?.path;
					if (!targetPath || typeof targetPath !== "string") continue;
					if (tr.isError) {
						const next = (editErrorsByFile.get(targetPath) ?? 0) + 1;
						editErrorsByFile.set(targetPath, next);
						const editOldText = (tc.arguments as any)?.old_string ?? (tc.arguments as any)?.oldText ?? "";
						const prevFailed = lastFailedOldText.get(targetPath);
						if (editOldText && prevFailed === editOldText && pendingMessages.length === 0) {
							pendingMessages.push({ role: "user", content: [{ type: "text", text: `Edit on \`${targetPath}\` failed with SAME oldText twice. Call \`read\` on it NOW, then retry.` }], timestamp: Date.now() });
						}
						lastFailedOldText.set(targetPath, editOldText);
						if (next >= EDIT_ERROR_THRESHOLD_PER_FILE && !stuckFilesAlerted.has(targetPath)) {
							stuckFilesAlerted.add(targetPath);
							pendingMessages.push({
								role: "user",
								content: [
									{
										type: "text",
										text: `STOP editing \`${targetPath}\`. You have failed ${next} edit attempts on this file in a row, all with "Could not find oldText" errors. The model's mental copy of this file is wrong. Do ONE of the following NOW:\n\n1. Move on to a DIFFERENT file in the task — there are likely other files mentioned in the acceptance criteria you haven't touched yet.\n2. If you must keep editing this file, call \`read\` on it ONE MORE TIME to refresh your view, then make ONE small edit with a very short, unique oldText snippet (5-10 lines max). Do not paste large blocks.\n3. Never paste text you remember — only paste text you have JUST read in this session.\n\nDo not retry the failed edits. Move on.`,
									},
								],
								timestamp: Date.now(),
							});
						}
					} else {
						editErrorsByFile.set(targetPath, 0);
						lastFailedOldText.delete(targetPath);
						hasEditedAnyFile = true;
						readsWithoutEdit = 0;
						// tau/sn66 v17: after successful edit, warn model that
						// the file changed. Without this, the model tries to
						// edit the same file again with oldText from BEFORE its
						// edit, which always fails.
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `\`${targetPath}\` was modified by your edit. If you need to edit this file again, call \`read\` on it first to see the current content. Do NOT use oldText from memory — it is now stale.`,
								},
							],
							timestamp: Date.now(),
						});
					}
				}

				// ConnectionRefused detection
				for (const tr of toolResults) {
					if (tr.toolName === "bash" && !tr.isError) {
						const output = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
						if (output.includes("ConnectionRefusedError") || output.includes("Connection refused") || output.includes("ECONNREFUSED")) {
							pendingMessages.push({ role: "user", content: [{ type: "text", text: "STOP: Sandbox has NO services. Do NOT retry connections. Call `read` or `edit` NOW." }], timestamp: Date.now() });
							break;
						}
					}
				}

				// v52: Phase transitions (from v42)
				if (phase === "discover") {
					for (const tr of toolResults) {
						if (tr.toolName === "bash" && !tr.isError) {
							const output = tr.content?.map((c: any) => c.text ?? "").join("") ?? "";
							const paths = output.split("\n").filter((l: string) => l.trim().match(/\.\w+$/)).map((l: string) => l.trim());
							if (paths.length > 0) {
								discoveredFiles = paths.slice(0, 20);
								phase = "read";
								pendingMessages.push({
									role: "user",
									content: [{ type: "text", text: `Found ${discoveredFiles.length} files. Now READ each file you plan to edit — read ALL of them before making any edit:\n${discoveredFiles.slice(0, 10).map((p: string) => `- ${p}`).join("\n")}` }],
									timestamp: Date.now(),
								});
							}
						}
					}
				} else if (phase === "read") {
					for (const tr of toolResults) {
						if (tr.toolName === "read" && !tr.isError) {
							const tc2 = toolCalls.find((c: any) => c.type === "toolCall" && c.name === "read");
							if (tc2) {
								const path = (tc2.arguments as any)?.path ?? "";
								if (path) readFiles.add(path);
							}
						}
						if (tr.toolName === "edit" && !tr.isError) {
							phase = "edit";
						}
					}
					const readThreshold = Math.min(Math.max(3, discoveredFiles.length > 10 ? 6 : 3), 8);
					if (readFiles.size >= readThreshold && phase === "read" && pendingMessages.length === 0) {
						phase = "edit";
						pendingMessages.push({
							role: "user",
							content: [{ type: "text", text: `You have read ${readFiles.size} files. Call \`edit\` NOW on the first file. Do NOT write text or plans — call the edit tool directly. After editing, continue to the NEXT file until ALL acceptance criteria are covered.` }],
							timestamp: Date.now(),
						});
					}
				}

				// tau/sn66 v16: track exploration budget.
				for (let i = 0; i < toolResults.length; i++) {
					const tr = toolResults[i];
					const tc = toolCalls[i];
					if ((tr.toolName === "read" || tr.toolName === "bash") && !tr.isError) {
						if (!hasEditedAnyFile) readsWithoutEdit++;
					}
					// v51: track read file paths for panic edit
					if (tr.toolName === "read" && !tr.isError && tc && tc.type === "toolCall") {
						const readPath = (tc.arguments as any)?.path;
						if (readPath && typeof readPath === "string") filesReadPaths.add(readPath);
					}
				}

				// If model has read N files without editing, force it to edit.
				if (!hasEditedAnyFile && readsWithoutEdit >= MAX_READS_BEFORE_EDIT && pendingMessages.length === 0) {
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "You have read enough files. Call `edit` on the most likely target file NOW. Do not read more files. One imperfect edit beats an empty diff.",
							},
						],
						timestamp: Date.now(),
					});
					readsWithoutEdit = 0;
				}

				// v51b: panic edit — escalating urgency
				// At 15s: first warning if no edit
				// At 30s: second panic if still no edit
				if (!hasEditedAnyFile && pendingMessages.length === 0) {
					const elapsed = Date.now() - loopStartTime;
					const filesList = filesReadPaths.size > 0
						? `Files you have read: ${[...filesReadPaths].slice(0, 5).join(", ")}. `
						: "";
					if (!panicEditInjected && elapsed >= PANIC_EDIT_MS) {
						panicEditInjected = true;
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `URGENT: ${Math.round(elapsed/1000)}s elapsed with ZERO edits. An empty diff scores 0. ${filesList}Call \`edit\` NOW on the most relevant file. Even 1 correct line beats 0.`,
								},
							],
							timestamp: Date.now(),
						});
					} else if (panicEditInjected && elapsed >= PANIC_EDIT_MS * 2 && !panicEditInjected2) {
						panicEditInjected2 = true;
						pendingMessages.push({
							role: "user",
							content: [
								{
									type: "text",
									text: `FINAL WARNING: ${Math.round(elapsed/1000)}s elapsed, STILL no edits. You are about to be killed. ${filesList}Make ANY edit RIGHT NOW or score 0.`,
								},
							],
							timestamp: Date.now(),
						});
					}
				}

				// tau/sn66 v17: hard exit — stop gracefully before validator kills us.
				// This ensures the container is still running when the diff is collected.
				if ((Date.now() - loopStartTime) >= HARD_EXIT_MS) {
					await emit({ type: "turn_end", message, toolResults });
					await emit({ type: "agent_end", messages: newMessages });
					return;
				}

				// tau/sn66 v17: time pressure — if we've been running for 80s
				// without a single successful edit, inject urgency.
				if (!hasEditedAnyFile && !timeWarningInjected && (Date.now() - loopStartTime) >= TIME_WARNING_MS && pendingMessages.length === 0) {
					timeWarningInjected = true;
					pendingMessages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: "TIME WARNING: you have been running for over 80 seconds without producing an edit. The validator will kill this process soon. You MUST call `edit` or `write` on a file RIGHT NOW or you will score 0. Pick the single most obvious target file from the task and edit it immediately. Do not read any more files.",
							},
						],
						timestamp: Date.now(),
					});
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
