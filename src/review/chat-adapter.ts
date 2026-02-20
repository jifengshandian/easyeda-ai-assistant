/**
 * AI原理图审查 - AI通信适配器
 *
 * 核心设计：
 * 1. 不使用流式传输（EDA API 不支持真正的 ReadableStream）
 * 2. 请求 stream: false，服务端返回标准 JSON
 * 3. 一次性接收完整响应，然后提取 thinking 和 text 内容
 * 4. 通过 onBlock 回调模拟流式事件，保持前端体验一致
 */

import type { CollectedData, ConfigStore, UserMessage } from './types';
import { chunkData } from './chunker';
import { extractReasoningFromDelta, getReasoningParams } from './reasoning-config';
import { ChunkType, ErrorCode, ReviewError } from './types';

/**
 * 调试日志发送函数（由 orchestrator 注入）
 */
let debugLog: ((level: string, message: string, data?: any) => void) | null = null;

export function setDebugLog(fn: (level: string, message: string, data?: any) => void): void {
	debugLog = fn;
}

function logDebug(level: string, message: string, data?: any): void {
	console.warn(`[chat-adapter] ${message}`, data || '');
	if (debugLog) {
		debugLog(level, `[chat-adapter] ${message}`, data);
	}
}

/**
 * 消息块处理器（用于模拟流式体验）
 */
export type MessageBlockHandler = (block: {
	type: ChunkType;
	content: string;
	accumulatedContent: string;
	status?: 'success' | 'paused';
}) => void;

/**
 * sendMessage 选项
 */
export interface SendMessageOptions {
	tools?: import('./types').ChatToolDefinition[];
	onToolCalls?: (toolCalls: import('./types').ChatToolCall[]) => Promise<import('./types').ToolExecutionResultMessage[]>;
	maxToolRounds?: number;
}

/**
 * Chat 完成结果
 */
export interface ChatCompletionResult {
	textContent: string;
	reasoningContent: string;
	toolCalls: import('./types').ChatToolCall[];
}

/**
 * Chat 消息
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
	tool_calls?: import('./types').ChatToolCall[];
	tool_call_id?: string;
	name?: string;
}

/**
 * Chat 会话类
 */
export class ChatSession {
	private history: ChatMessage[] = [];
	private schematicContext: string = '';

	constructor(schematicData?: CollectedData) {
		if (schematicData) {
			const chunks = chunkData(schematicData, { maxPinsPerChunk: 1200 });
			if (chunks.length > 0) {
				this.schematicContext = JSON.stringify(chunks[0]);
			}
		}
	}

	/**
	 * 设置原理图上下文（用于更新数据）
	 */
	setSchematicContext(data: CollectedData): void {
		const chunks = chunkData(data, { maxPinsPerChunk: 1200 });
		if (chunks.length > 0) {
			this.schematicContext = JSON.stringify(chunks[0]);
		}
	}

	/**
	 * 重置会话（清空历史）
	 */
	reset(): void {
		this.history = [];
	}

	/**
	 * 发送用户消息并获取AI回复
	 *
	 * @param userMsg 用户消息对象
	 * @param config AI 配置
	 * @param onBlock 可选的分块回调，用于模拟流式体验（实际是一次性发送）
	 * @param signal 可选的 AbortSignal，用于取消请求
	 * @param options 可选的工具调用选项
	 */
	async sendMessage(
		userMsg: UserMessage,
		config: ConfigStore,
		onBlock?: MessageBlockHandler,
		signal?: AbortSignal,
		options?: SendMessageOptions,
	): Promise<string> {
		if (signal?.aborted) {
			throw createAbortReviewError('请求在发送前已取消', undefined, signal.reason);
		}

		const systemPrompt = buildChatSystemPrompt(this.schematicContext);
		const initialHistoryLength = this.history.length;

		// 构建用户消息内容
		const userContent = this.buildUserContent(userMsg);

		// 将用户消息加入历史
		this.history.push({ role: 'user', content: userContent });

		const availableTools = options?.tools && options.tools.length > 0
			? options.tools
			: undefined;
		const warnToolRounds = Math.max(1, options?.maxToolRounds || 6);
		const hardLimitRounds = 20; // 防止真正的死循环

		try {
			let round = 1;
			while (true) {
				if (signal?.aborted) {
					throw createAbortReviewError('请求已取消', undefined, signal.reason);
				}

				// 硬性上限保护（防止死循环）
				if (round > hardLimitRounds) {
					logDebug('warn', `工具调用轮次达到硬性上限（${hardLimitRounds}），强制终止`, { round });
					throw new Error(`工具调用轮次达到硬性上限（>${hardLimitRounds}），可能存在循环调用问题`);
				}

				// 软提醒（超过建议轮次时警告但继续）
				if (round > warnToolRounds) {
					logDebug('warn', `工具调用轮次超过建议值（${warnToolRounds}），当前第 ${round} 轮`, { round, warnToolRounds });
				}

				// 每轮都基于最新历史重建消息
				const messages: ChatMessage[] = [
					{ role: 'system', content: systemPrompt },
					...this.history,
				];

				const result = await callOpenAICompatibleChat(messages, config, onBlock, signal, availableTools);

				// 若模型要求调用工具，进入工具执行分支
				if (result.toolCalls.length > 0) {
					this.history.push({
						role: 'assistant',
						content: result.textContent || null,
						tool_calls: result.toolCalls,
					});

					if (!options?.onToolCalls) {
						// 无工具执行器时回退成普通文本提示，避免死循环
						const fallbackText = result.textContent || '模型请求了工具调用，但当前未启用工具执行。';
						this.history.pop();
						this.history.push({
							role: 'assistant',
							content: fallbackText,
						});
						return fallbackText;
					}

					const toolResults = await options.onToolCalls(result.toolCalls);
					if (!toolResults || toolResults.length === 0) {
						const firstCall = result.toolCalls[0];
						this.history.push({
							role: 'tool',
							tool_call_id: firstCall.id,
							name: firstCall.function.name,
							content: '工具执行器未返回结果。',
						});
						round++;
						continue;
					}

					for (const toolResult of toolResults) {
						this.history.push({
							role: 'tool',
							tool_call_id: toolResult.toolCallId,
							name: toolResult.toolName,
							content: toolResult.content,
						});
					}
					round++;
					continue;
				}

				// 普通文本回答结束
				const assistantContent = result.reasoningContent
					? `${result.reasoningContent}\n\n${result.textContent}`
					: result.textContent;
				this.history.push({ role: 'assistant', content: assistantContent });
				return result.textContent;
			}
		}
		catch (error) {
			// 出错回滚到本轮请求前状态，避免残留半成品 tool message
			this.history.splice(initialHistoryLength);
			throw error;
		}
	}

	/**
	 * 清除最后一轮对话（用于重新生成）
	 *
	 * 工具调用场景下一轮对话可能包含多条消息：
	 *   user → assistant(tool_calls) → tool × N → assistant(final)
	 * 因此从末尾向前找到最后一条 user 消息，将其及之后的所有消息一并移除。
	 */
	clear(): void {
		for (let i = this.history.length - 1; i >= 0; i--) {
			if (this.history[i].role === 'user') {
				this.history.splice(i);
				return;
			}
		}
	}

	/**
	 * 构建用户消息内容（支持文本+图片）
	 */
	private buildUserContent(userMsg: UserMessage): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
		// 如果没有图片，直接返回文本
		if (!userMsg.images || userMsg.images.length === 0) {
			return userMsg.text || '';
		}

		// 有图片时使用 multipart 格式
		const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

		for (const img of userMsg.images) {
			// img.data 可能是完整 data URL（data:image/...;base64,...）或纯 base64 字符串
			const url = img.data.startsWith('data:')
				? img.data
				: `data:${img.type};base64,${img.data}`;
			parts.push({
				type: 'image_url',
				image_url: { url },
			});
		}

		if (userMsg.text) {
			parts.push({ type: 'text', text: userMsg.text });
		}

		return parts;
	}
}

// ============ System Prompt ============

function buildChatSystemPrompt(schematicContext: string): string {
	return `你是一个专业的硬件工程师助手，擅长分析原理图设计。

当前原理图数据：
${schematicContext || '（暂无数据）'}

请根据用户的问题，提供专业、准确的回答。`;
}

// ============ 文本规范化 ============

function normalizeChunkText(text: unknown): string {
	if (typeof text !== 'string')
		return '';
	// 不要 trim，保留空白和换行，避免文本粘连
	return text;
}

// ============ AI API 调用 ============

/**
 * 调用OpenAI兼容格式的Chat API
 */
async function callOpenAICompatibleChat(
	messages: ChatMessage[],
	config: ConfigStore,
	onBlock?: MessageBlockHandler,
	signal?: AbortSignal,
	tools?: import('./types').ChatToolDefinition[],
): Promise<ChatCompletionResult> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body: Record<string, unknown> = {
		model: config.model,
		messages: messages.map((m) => {
			const messageBody: Record<string, unknown> = {
				role: m.role,
				content: m.content,
			};

			if (m.tool_calls && m.tool_calls.length > 0) {
				messageBody.tool_calls = m.tool_calls;
			}
			if (m.tool_call_id) {
				messageBody.tool_call_id = m.tool_call_id;
			}
			if (m.name) {
				messageBody.name = m.name;
			}
			return messageBody;
		}),
		temperature: 0.4,
		stream: true, // 需要流式模式才能获取 reasoning_content（Grok 等模型）
		...getReasoningParams(config.model, 'medium'), // 🆕 添加模型特定的 reasoning 参数
	};

	if (tools && tools.length > 0) {
		body.tools = tools;
		body.tool_choice = 'auto';
	}

	return await makeRequest(url, config, body, onBlock, signal);
}

/**
 * 发送HTTP请求
 */
async function makeRequest(
	url: string,
	config: ConfigStore,
	body: unknown,
	onBlock?: MessageBlockHandler,
	signal?: AbortSignal,
): Promise<ChatCompletionResult> {
	let abortHandler: (() => void) | undefined;

	const abortPromise = signal
		? new Promise<never>((_, reject) => {
				const onAbort = (): void => {
					reject(createAbortReviewError('请求已取消', url, signal.reason));
				};

				if (signal.aborted) {
					onAbort();
					return;
				}

				abortHandler = onAbort;
				signal.addEventListener('abort', onAbort, { once: true });
			})
		: undefined;

	try {
		const requestPromise = eda.sys_ClientUrl.request(
			url,
			'POST',
			JSON.stringify(body),
			{
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${config.apiKey}`,
				},
			},
		) as Promise<unknown>;

		// 只支持用户主动取消，不设置超时限制（有些 AI 推理时间很长）
		const response = abortPromise
			? await Promise.race([requestPromise, abortPromise]) as Response
			: await requestPromise as Response;

		if (!response.ok) {
			const errorText = await response.text();
			handleHttpError(response.status, errorText, url);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('请求已取消', url, signal.reason);
		}

		// 读取完整响应（EDA API 不支持真正的流式传输）
		let responseText = '';
		try {
			const rawResponseText = await response.text();
			// 防御性类型转换：确保是字符串
			responseText = coerceToString(rawResponseText);
			logDebug('info', 'response.text() 成功', {
				url,
				textLength: responseText.length,
				textType: typeof rawResponseText,
				textPreview: responseText.substring(0, 200),
			});
		}
		catch (error) {
			console.error('[makeRequest] response.text() 失败:', error);
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				`读取响应内容失败: ${error instanceof Error ? error.message : String(error)}`,
				{ url, originalError: serializeUnknownError(error) },
			);
		}

		if (signal?.aborted) {
			throw createAbortReviewError('请求已取消', url, signal.reason);
		}

		// 检查是否是 SSE 格式
		const contentType = response.headers.get('content-type') || '';
		const isSSE = contentType.includes('text/event-stream')
			|| contentType.includes('text/plain')
			|| responseText.startsWith('data:')
			|| responseText.includes('\ndata:');

		logDebug('info', '响应格式检测', {
			contentType,
			isSSE,
			startsWithData: responseText.startsWith('data:'),
		});

		if (isSSE) {
			// SSE 格式：解析所有事件，累积 reasoning 和 content
			return parseSSEResponse(responseText, onBlock);
		}

		// 标准 JSON 响应
		let data: any;
		try {
			data = JSON.parse(responseText);
		}
		catch (parseError) {
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'AI响应解析失败：返回了非JSON内容',
				{
					url,
					responseBody: responseText.substring(0, 2000),
					parseError: serializeUnknownError(parseError),
				},
			);
		}

		// 提取 text、reasoning 和 tool_calls 内容
		const textContent = extractResponseText(data);
		const reasoningContent = extractReasoningText(data);
		const toolCalls = extractToolCalls(data);

		logDebug('info', '原始提取结果', {
			textLength: textContent.length,
			reasoningLength: reasoningContent.length,
			textPreview: textContent.substring(0, 100),
			reasoningPreview: reasoningContent.substring(0, 100),
			toolCallCount: toolCalls.length,
			hasThinkTag: /<think/i.test(textContent),
		});

		if (!textContent && !reasoningContent && toolCalls.length === 0) {
			throw new ReviewError(
				ErrorCode.AI_INVALID_RESPONSE,
				'AI响应中既没有 content/reasoning_content，也没有 tool_calls',
				{
					url,
					responseBody: JSON.stringify(data).substring(0, 2000),
				},
			);
		}

		// 提取 <think> 标签（如果 AI 在 content 中包含了思考过程）
		const { finalText, extractedReasoning } = extractThinkTags(textContent);

		// 合并提取的 reasoning（优先使用非空白的 reasoningContent）
		const finalReasoning = hasNonWhitespace(reasoningContent) ? reasoningContent : extractedReasoning;

		logDebug('info', '最终提取结果', {
			finalTextLength: finalText.length,
			finalReasoningLength: finalReasoning.length,
			reasoningSource: hasNonWhitespace(reasoningContent) ? 'API字段' : (extractedReasoning ? '<think>标签' : '无'),
			toolCallCount: toolCalls.length,
		});

		// 发送事件
		emitCompleteBlocks(finalText, finalReasoning, onBlock);

		return { textContent: finalText, reasoningContent: finalReasoning, toolCalls };
	}
	catch (error) {
		if (isAbortLikeError(error)) {
			throw createAbortReviewError('请求已取消', url, signal?.reason);
		}

		if (error instanceof ReviewError) {
			throw error;
		}

		// 捕获外部交互权限错误
		if (error instanceof Error) {
			const msg = error.message.toLowerCase();
			const permissionKeywords = [
				'外部交互权限',
				'外部交互',
				'external interaction',
				'permission denied',
				'access denied',
				'cors',
			];

			if (permissionKeywords.some(keyword => msg.includes(keyword.toLowerCase()))) {
				throw new ReviewError(
					ErrorCode.AI_NETWORK_ERROR,
					'未启用扩展的外部交互权限。请在扩展管理器中找到本扩展，勾选"允许外部交互"选项。',
					{
						url,
						originalError: serializeUnknownError(error),
					},
				);
			}
		}

		throw new ReviewError(
			ErrorCode.AI_NETWORK_ERROR,
			`网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
			{
				url,
				originalError: serializeUnknownError(error),
			},
		);
	}
	finally {
		if (signal && abortHandler) {
			signal.removeEventListener('abort', abortHandler);
		}
	}
}

// ============ SSE 解析 ============

/**
 * 解析 SSE 响应
 *
 * 策略：
 * 1. 解析所有 SSE 事件，累积完整的 text 和 reasoning 内容
 * 2. 提取 <think> 标签（如果有）
 * 3. 按正确顺序发送事件：THINKING → TEXT
 */
function parseSSEResponse(text: string, onBlock?: MessageBlockHandler): ChatCompletionResult {
	// 防御性检查
	if (!text || typeof text !== 'string') {
		logDebug('error', 'SSE响应为空或格式错误', {
			textType: typeof text,
			textValue: text,
		});
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, 'SSE响应为空或格式错误');
	}

	logDebug('info', '开始解析 SSE 响应', {
		textLength: text.length,
		textPreview: text.substring(0, 200),
	});

	const lines = text.split(/\r?\n/);

	let textContent = '';
	let reasoningContent = '';
	const toolCallsBuffer = new Map<number, { id: string; name: string; argumentsText: string }>();
	let currentEventData: string[] = [];

	// 第一阶段：解析所有 SSE 事件，累积内容
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// 空行表示事件结束
		if (line === '') {
			if (currentEventData.length > 0) {
				processEvent(currentEventData.join(''));
				currentEventData = [];
			}
			continue;
		}

		// 处理 data: 行
		if (line.startsWith('data:')) {
			const dataContent = line.substring(5).trim();

			// 跳过 [DONE] 标记
			if (dataContent === '[DONE]') {
				if (currentEventData.length > 0) {
					processEvent(currentEventData.join(''));
					currentEventData = [];
				}
				continue;
			}

			currentEventData.push(dataContent);
		}
	}

	// 处理最后一个事件
	if (currentEventData.length > 0) {
		processEvent(currentEventData.join(''));
	}

	// 解析单个 SSE 事件
	function processEvent(eventText: string): void {
		try {
			const chunk = JSON.parse(eventText);
			const delta = chunk?.choices?.[0]?.delta;
			if (!delta)
				return;

			// 累积 SSE 中的 tool_calls delta
			appendSseToolCalls(delta.tool_calls, toolCallsBuffer);

			// 🆕 使用统一的 reasoning 提取函数（支持所有模型）
			const reasoning = normalizeChunkText(extractReasoningFromDelta(delta));
			const content = normalizeChunkText(delta.content);

			if (reasoning) {
				reasoningContent += reasoning;
			}
			if (content) {
				textContent += content;
			}
		}
		catch {
			// 忽略解析错误
		}
	}

	logDebug('info', 'SSE 解析完成（累积阶段）', {
		textLength: textContent.length,
		reasoningLength: reasoningContent.length,
		textPreview: textContent.substring(0, 500),
	});

	// 第二阶段：提取标签
	if (!reasoningContent && textContent) {
		// 提取 <think> 标签（贪婪匹配，确保提取完整内容）
		const thinkTagRegex = /<think>[\s\S]*<\/think>|<thought>[\s\S]*<\/thought>|<thinking>[\s\S]*<\/thinking>/gi;
		const thinkMatches = textContent.match(thinkTagRegex);
		if (thinkMatches && thinkMatches.length > 0) {
			reasoningContent = thinkMatches.map((match) => {
				return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
			}).join('\n\n');
			textContent = textContent.replace(thinkTagRegex, '').trim();
			logDebug('info', '从 <think> 标签提取 reasoning', {
				extractedLength: reasoningContent.length,
				matchCount: thinkMatches.length,
				firstMatchPreview: thinkMatches[0].substring(0, 200),
			});
		}
		else {
			logDebug('warn', '未找到完整的 <think> 标签', {
				hasOpenTag: textContent.includes('<think>'),
				hasCloseTag: textContent.includes('</think>'),
			});
		}
	}

	logDebug('info', 'SSE 最终提取结果', {
		textLength: textContent.length,
		reasoningLength: reasoningContent.length,
		toolCallCount: toolCallsBuffer.size,
		reasoningSource: reasoningContent ? 'SSE delta' : '无',
	});

	const toolCalls = buildToolCallsFromBuffer(toolCallsBuffer);

	// 第三阶段：按正确顺序发送事件
	emitCompleteBlocks(textContent, reasoningContent, onBlock);

	if (!textContent && !reasoningContent && toolCalls.length === 0) {
		throw new ReviewError(ErrorCode.AI_INVALID_RESPONSE, '无法从SSE响应中提取内容');
	}

	return { textContent, reasoningContent, toolCalls };
}

// ============ 辅助函数 ============

/**
 * 从文本中提取 <think> 标签
 */
function extractThinkTags(text: string): { finalText: string; extractedReasoning: string } {
	if (!text) {
		return { finalText: '', extractedReasoning: '' };
	}

	// 提取 <think> 标签
	const thinkTagRegex = /<think>[\s\S]*?<\/think>|<thought>[\s\S]*?<\/thought>|<thinking>[\s\S]*?<\/thinking>/gi;
	const thinkMatches = text.match(thinkTagRegex);

	if (thinkMatches && thinkMatches.length > 0) {
		const extractedReasoning = thinkMatches.map((match) => {
			return match.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
		}).join('\n\n');
		const finalText = text.replace(thinkTagRegex, '').trim();
		return { finalText, extractedReasoning };
	}

	// 提取 Grok 格式
	const hasGrokMarkers = /\[(?:Agent\s+\d+|Grok)\]\[/.test(text) || /browse_page\s*\{/.test(text);
	if (hasGrokMarkers) {
		const contentLines = text.split('\n');
		const thinkingLines: string[] = [];
		const textLines: string[] = [];

		for (const line of contentLines) {
			const trimmed = line.trim();
			if (trimmed.match(/^\[(?:Agent\s+\d+|Grok)\]\[/) || trimmed.startsWith('browse_page')) {
				thinkingLines.push(line);
			}
			else if (trimmed.length > 0) {
				textLines.push(line);
			}
		}

		if (thinkingLines.length > 0) {
			return {
				finalText: textLines.join('\n').trim(),
				extractedReasoning: thinkingLines.join('\n').trim(),
			};
		}
	}

	return { finalText: text, extractedReasoning: '' };
}

function emitCompleteBlocks(
	textContent: string,
	reasoningContent: string,
	onBlock?: MessageBlockHandler,
): void {
	if (!onBlock) {
		logDebug('warn', 'onBlock 回调为空，跳过事件发送');
		return;
	}

	logDebug('info', '准备发送事件', {
		hasReasoning: !!reasoningContent,
		hasText: !!textContent,
		reasoningLength: reasoningContent.length,
		textLength: textContent.length,
	});

	if (reasoningContent) {
		logDebug('info', '发送 THINKING 事件', { length: reasoningContent.length });
		onBlock({ type: ChunkType.THINKING_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.THINKING_DELTA, content: reasoningContent, accumulatedContent: reasoningContent });
		onBlock({ type: ChunkType.THINKING_COMPLETE, content: '', accumulatedContent: reasoningContent, status: 'success' });
	}
	else {
		logDebug('warn', '没有 reasoning 内容，跳过 THINKING 事件');
	}

	if (textContent) {
		logDebug('info', '发送 TEXT 事件', { length: textContent.length });
		onBlock({ type: ChunkType.TEXT_START, content: '', accumulatedContent: '' });
		onBlock({ type: ChunkType.TEXT_DELTA, content: textContent, accumulatedContent: textContent });
		onBlock({ type: ChunkType.TEXT_COMPLETE, content: '', accumulatedContent: textContent, status: 'success' });
	}
	else {
		logDebug('warn', '没有 text 内容，跳过 TEXT 事件');
	}
}

function extractResponseText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.content
		|| data.choices?.[0]?.text
		|| data.content,
	);
}

function extractReasoningText(data: any): string {
	return normalizeChunkText(
		data.choices?.[0]?.message?.reasoning_content
		|| data.choices?.[0]?.message?.reasoning
		|| data.choices?.[0]?.reasoning_content,
	);
}

function extractToolCalls(data: any): import('./types').ChatToolCall[] {
	return normalizeToolCalls(data?.choices?.[0]?.message?.tool_calls);
}

function createAbortReviewError(message: string, url?: string, reason?: unknown): ReviewError {
	return new ReviewError(
		ErrorCode.AI_ABORTED,
		message,
		{
			aborted: true,
			url,
			reason: reason === undefined ? undefined : serializeUnknownError(reason),
		},
	);
}

function isAbortLikeError(error: unknown): boolean {
	if (error instanceof ReviewError && error.code === ErrorCode.AI_ABORTED) {
		return true;
	}
	if (error instanceof Error) {
		const msg = error.message.toLowerCase();
		return msg.includes('abort') || msg.includes('cancel');
	}
	return false;
}

function serializeUnknownError(error: unknown): any {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	}
	return String(error);
}

function handleHttpError(status: number, errorText: unknown, url: string): never {
	let errorMessage = `HTTP ${status}`;
	let errorCode = ErrorCode.AI_NETWORK_ERROR;

	if (status === 401 || status === 403) {
		errorMessage = 'API Key 无效或权限不足';
		errorCode = ErrorCode.AI_AUTH_ERROR;
	}
	else if (status === 429) {
		errorMessage = 'API 请求频率超限，请稍后重试';
		errorCode = ErrorCode.AI_RATE_LIMIT;
	}
	else if (status >= 500) {
		errorMessage = 'AI 服务暂时不可用';
		errorCode = ErrorCode.AI_SERVER_ERROR;
	}

	throw new ReviewError(
		errorCode,
		errorMessage,
		{
			url,
			status,
			responseBody: coerceToString(errorText).substring(0, 500),
		},
	);
}

/**
 * 检查字符串是否包含非空白字符
 */
function hasNonWhitespace(text: string): boolean {
	return text.trim().length > 0;
}

/**
 * 将未知类型强制转换为字符串
 */
function coerceToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'object') {
		try {
			return JSON.stringify(value);
		}
		catch {
			return String(value);
		}
	}
	return String(value);
}

// ============ Tool Calls 辅助函数 ============

function normalizeToolCalls(rawToolCalls: unknown): import('./types').ChatToolCall[] {
	if (!Array.isArray(rawToolCalls)) {
		return [];
	}

	const calls: import('./types').ChatToolCall[] = [];
	for (let i = 0; i < rawToolCalls.length; i++) {
		const rawCall = rawToolCalls[i];
		if (!isRecord(rawCall))
			continue;
		if (rawCall.type !== 'function')
			continue;

		const rawFunction = isRecord(rawCall.function) ? rawCall.function : null;
		const name = rawFunction && typeof rawFunction.name === 'string'
			? rawFunction.name
			: '';
		if (!name)
			continue;

		const argumentsText = rawFunction && typeof rawFunction.arguments === 'string'
			? rawFunction.arguments
			: '{}';
		const id = typeof rawCall.id === 'string' && rawCall.id
			? rawCall.id
			: `tool_call_${i + 1}`;

		calls.push({
			id,
			type: 'function',
			function: {
				name,
				arguments: argumentsText,
			},
		});
	}
	return calls;
}

function appendSseToolCalls(
	rawDeltaToolCalls: unknown,
	buffer: Map<number, { id: string; name: string; argumentsText: string }>,
): void {
	if (!Array.isArray(rawDeltaToolCalls)) {
		return;
	}

	for (let i = 0; i < rawDeltaToolCalls.length; i++) {
		const rawToolCall = rawDeltaToolCalls[i];
		if (!isRecord(rawToolCall))
			continue;

		const index = typeof rawToolCall.index === 'number'
			? rawToolCall.index
			: i;
		const existing = buffer.get(index) || {
			id: '',
			name: '',
			argumentsText: '',
		};

		if (typeof rawToolCall.id === 'string' && rawToolCall.id) {
			existing.id = rawToolCall.id;
		}

		const rawFunction = isRecord(rawToolCall.function) ? rawToolCall.function : null;
		if (rawFunction) {
			if (typeof rawFunction.name === 'string' && rawFunction.name) {
				existing.name = rawFunction.name;
			}
			if (typeof rawFunction.arguments === 'string') {
				existing.argumentsText += rawFunction.arguments;
			}
		}

		buffer.set(index, existing);
	}
}

function buildToolCallsFromBuffer(buffer: Map<number, { id: string; name: string; argumentsText: string }>): import('./types').ChatToolCall[] {
	const calls: import('./types').ChatToolCall[] = [];
	const entries = Array.from(buffer.entries()).sort((a, b) => a[0] - b[0]);

	for (const [index, value] of entries) {
		if (!value.name) {
			continue;
		}
		calls.push({
			id: value.id || `tool_call_${index + 1}`,
			type: 'function',
			function: {
				name: value.name,
				arguments: value.argumentsText || '{}',
			},
		});
	}

	return calls;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}
