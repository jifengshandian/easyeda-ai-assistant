/**
 * AI原理图审查 - MCP 工具编排器
 *
 * 职责：
 * 1. 拉取可用工具列表（Gateway -> /tools/list 或 JSON-RPC tools/list）
 * 2. 执行工具调用（Gateway -> /tools/call 或 JSON-RPC tools/call）
 * 3. 向 IFrame 发出可观测的工具事件
 *
 * 支持两种 Gateway 模式：
 * - REST Gateway: 自定义 REST API（/tools/list, /tools/call）
 * - MCP Streamable HTTP: JSON-RPC 2.0 协议（单一端点，如 /mcp）
 */
import type {
	ChatToolCall,
	ChatToolDefinition,
	ConfigStore,
	ToolEventMessage,
	ToolExecutionResultMessage,
} from './types';

interface ToolOrchestratorContext {
	requestId: string;
	sessionId: string;
}

interface ToolListResponseShape {
	tools?: unknown;
	result?: {
		tools?: unknown;
	};
	// JSON-RPC 格式
	jsonrpc?: string;
	id?: number | string;
}

interface ToolCallResponseShape {
	content?: unknown;
	result?: unknown;
	output?: unknown;
	isError?: boolean;
	error?: unknown;
	// JSON-RPC 格式
	jsonrpc?: string;
	id?: number | string;
}

/**
 * Gateway 类型
 */
enum GatewayType {
	REST = 'rest', // 自定义 REST API
	JSON_RPC = 'json-rpc', // MCP Streamable HTTP (JSON-RPC 2.0)
}

/**
 * JSON-RPC 请求
 */
interface JsonRpcRequest {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
	id: number;
}

/**
 * JSON-RPC 响应（预留类型定义，暂未直接使用）
 */
interface _JsonRpcResponse {
	jsonrpc: '2.0';
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
	id: number | string;
}

/**
 * 工具编排器
 */
export class ToolOrchestrator {
	private readonly gatewayBaseUrl: string;
	private readonly gatewayType: GatewayType;
	private jsonRpcIdCounter = 1;
	private mcpSessionId: string | null = null;
	private initializePromise: Promise<void> | null = null;

	constructor(
		private readonly config: ConfigStore,
		private readonly context: ToolOrchestratorContext,
		private readonly emitEvent: (event: ToolEventMessage) => void,
	) {
		this.gatewayBaseUrl = normalizeGatewayBaseUrl(config.mcpGatewayUrl || '');
		this.gatewayType = detectGatewayType(this.gatewayBaseUrl);
	}

	isEnabled(): boolean {
		return !!this.config.mcpEnabled && this.gatewayBaseUrl.length > 0;
	}

	async listTools(signal?: AbortSignal): Promise<ChatToolDefinition[]> {
		if (!this.isEnabled()) {
			return [];
		}

		this.emit({
			stage: 'tools-list',
			status: 'running',
			title: '正在拉取 MCP 工具清单',
		});

		try {
			// JSON-RPC 模式需要先初始化会话
			if (this.gatewayType === GatewayType.JSON_RPC) {
				await this.ensureInitialized(signal);
			}

			let response: ToolListResponseShape;

			if (this.gatewayType === GatewayType.JSON_RPC) {
				// MCP Streamable HTTP (JSON-RPC)
				const jsonRpcRequest: JsonRpcRequest = {
					jsonrpc: '2.0',
					method: 'tools/list',
					id: this.jsonRpcIdCounter++,
				};
				response = await this.postJson<ToolListResponseShape>(
					'',
					jsonRpcRequest,
					signal,
				);
			}
			else {
				// REST Gateway
				response = await this.postJson<ToolListResponseShape>(
					'/tools/list',
					{
						sessionId: this.context.sessionId,
						requestId: this.context.requestId,
					},
					signal,
				);
			}

			const tools = normalizeToolDefinitions(response);

			this.emit({
				stage: 'tools-list',
				status: 'success',
				title: `已加载 ${tools.length} 个 MCP 工具`,
				detail: truncateText(tools.map(tool => tool.function.name).join(', '), 240),
			});

			return tools;
		}
		catch (error) {
			this.emit({
				stage: 'tools-list',
				status: 'error',
				title: '工具清单加载失败',
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async executeToolCalls(
		toolCalls: ChatToolCall[],
		signal?: AbortSignal,
	): Promise<ToolExecutionResultMessage[]> {
		const results: ToolExecutionResultMessage[] = [];

		for (const toolCall of toolCalls) {
			if (signal?.aborted) {
				throw new Error('工具调用已取消');
			}

			const toolName = toolCall.function.name;
			const argsPreview = truncateText(toolCall.function.arguments || '{}', 240);

			this.emit({
				stage: 'tool-call',
				status: 'running',
				toolCallId: toolCall.id,
				toolName,
				title: `调用工具 ${toolName}`,
				detail: argsPreview,
			});

			try {
				// JSON-RPC 模式需要先初始化会话
				if (this.gatewayType === GatewayType.JSON_RPC) {
					await this.ensureInitialized(signal);
				}

				const parsedArguments = parseToolArguments(toolCall.function.arguments);
				let response: ToolCallResponseShape;

				if (this.gatewayType === GatewayType.JSON_RPC) {
					// MCP Streamable HTTP (JSON-RPC)
					const jsonRpcRequest: JsonRpcRequest = {
						jsonrpc: '2.0',
						method: 'tools/call',
						params: {
							name: toolName,
							arguments: parsedArguments,
						},
						id: this.jsonRpcIdCounter++,
					};
					response = await this.postJson<ToolCallResponseShape>(
						'',
						jsonRpcRequest,
						signal,
					);
				}
				else {
					// REST Gateway
					response = await this.postJson<ToolCallResponseShape>(
						'/tools/call',
						{
							sessionId: this.context.sessionId,
							requestId: this.context.requestId,
							name: toolName,
							toolName,
							arguments: parsedArguments,
							autoApprove: this.config.mcpAutoApprove !== false,
						},
						signal,
					);
				}

				const content = coerceToolResultToText(response);
				const isError = detectToolError(response);

				results.push({
					toolCallId: toolCall.id,
					toolName,
					content,
					isError,
				});

				this.emit({
					stage: 'tool-call',
					status: isError ? 'error' : 'success',
					toolCallId: toolCall.id,
					toolName,
					title: isError ? `工具 ${toolName} 返回错误` : `工具 ${toolName} 执行成功`,
					resultPreview: truncateText(content, 320),
				});
			}
			catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				const fallback = JSON.stringify({
					error: true,
					tool: toolName,
					message: errorMessage,
				}, null, 2);

				results.push({
					toolCallId: toolCall.id,
					toolName,
					content: fallback,
					isError: true,
				});

				this.emit({
					stage: 'tool-call',
					status: 'error',
					toolCallId: toolCall.id,
					toolName,
					title: `工具 ${toolName} 执行失败`,
					error: errorMessage,
				});
			}
		}

		return results;
	}

	/**
	 * 确保 MCP 会话已初始化（仅 JSON-RPC 模式需要）
	 */
	private async ensureInitialized(signal?: AbortSignal): Promise<void> {
		if (this.mcpSessionId) {
			return; // 已初始化
		}

		// 防止并发初始化
		if (this.initializePromise) {
			return this.initializePromise;
		}

		this.initializePromise = this.performInitialize(signal);
		try {
			await this.initializePromise;
		}
		finally {
			this.initializePromise = null;
		}
	}

	/**
	 * 执行 MCP initialize 握手
	 */
	private async performInitialize(signal?: AbortSignal): Promise<void> {
		const initRequest: JsonRpcRequest = {
			jsonrpc: '2.0',
			method: 'initialize',
			params: {
				protocolVersion: '2025-03-26',
				capabilities: {},
				clientInfo: {
					name: 'easyeda-ai-assistant',
					version: '1.1.2',
				},
			},
			id: this.jsonRpcIdCounter++,
		};

		await this.postJson<any>(
			'',
			initRequest,
			signal,
			true, // skipSessionHeader = true（初始化时不带 session ID）
		);

		// 从响应中提取 session ID（已在 postJson 中设置到 this.mcpSessionId）
		if (!this.mcpSessionId) {
			throw new Error('MCP initialize 未返回 session ID');
		}
	}

	private async postJson<T>(
		path: string,
		payload: unknown,
		signal?: AbortSignal,
		skipSessionHeader = false,
	): Promise<T> {
		if (signal?.aborted) {
			throw new Error('请求已取消');
		}

		const url = `${this.gatewayBaseUrl}${path}`;
		let abortHandler: (() => void) | undefined;

		const abortPromise = signal
			? new Promise<never>((_, reject) => {
					const onAbort = (): void => {
						reject(new Error('Gateway 请求已取消'));
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
			const headers = buildGatewayHeaders(this.config, this.gatewayType);

			// JSON-RPC 模式：添加 MCP session ID（除非是 initialize 请求）
			if (this.gatewayType === GatewayType.JSON_RPC && !skipSessionHeader && this.mcpSessionId) {
				headers['Mcp-Session-Id'] = this.mcpSessionId;
			}

			const requestPromise = eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(payload),
				{ headers },
			) as Promise<unknown>;

			// 只支持用户主动取消，不设置超时限制（有些 MCP 工具执行时间很长）
			const response = abortPromise
				? await Promise.race([requestPromise, abortPromise]) as Response
				: await requestPromise as Response;
			if (!response.ok) {
				const text = await response.text();
				throw new Error(`Gateway HTTP ${response.status}: ${truncateText(text, 500)}`);
			}

			// JSON-RPC 模式：提取 MCP session ID（仅在 initialize 时）
			if (this.gatewayType === GatewayType.JSON_RPC && skipSessionHeader) {
				const sessionId = response.headers.get('mcp-session-id');
				if (sessionId) {
					this.mcpSessionId = sessionId;
				}
			}

			const rawText = await response.text();
			if (!rawText) {
				return {} as T;
			}

			// MCP Streamable HTTP 使用 SSE 格式
			if (this.gatewayType === GatewayType.JSON_RPC && rawText.startsWith('event:')) {
				return parseSSEResponse(rawText) as T;
			}

			try {
				return JSON.parse(rawText) as T;
			}
			catch {
				return { content: rawText } as T;
			}
		}
		finally {
			if (signal && abortHandler) {
				signal.removeEventListener('abort', abortHandler);
			}
		}
	}

	private emit(event: Omit<ToolEventMessage, 'requestId' | 'sessionId' | 'eventId' | 'timestamp'>): void {
		this.emitEvent({
			...event,
			requestId: this.context.requestId,
			sessionId: this.context.sessionId,
			eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
			timestamp: Date.now(),
		});
	}
}

// ============ 辅助函数 ============

function buildGatewayHeaders(config: ConfigStore, gatewayType: GatewayType): Record<string, string> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	// MCP Streamable HTTP 需要同时接受 JSON 和 SSE
	if (gatewayType === GatewayType.JSON_RPC) {
		headers.Accept = 'application/json, text/event-stream';
	}

	if (config.mcpGatewayApiKey && config.mcpGatewayApiKey.trim().length > 0) {
		headers.Authorization = `Bearer ${config.mcpGatewayApiKey.trim()}`;
	}

	// REST Gateway 专用头
	if (gatewayType === GatewayType.REST) {
		headers['X-MCP-Auto-Approve'] = config.mcpAutoApprove === false ? 'false' : 'true';
	}

	return headers;
}

function normalizeGatewayBaseUrl(url: string): string {
	const normalized = url.trim().replace(/\/+$/, '');
	return normalized;
}

/**
 * 检测 Gateway 类型
 *
 * 规则：
 * - 如果 URL 以 /mcp、/sse、/http 等 MCP 传输层路径结尾，判定为 JSON-RPC
 * - 否则判定为 REST Gateway
 */
function detectGatewayType(url: string): GatewayType {
	const lowerUrl = url.toLowerCase();

	// MCP Streamable HTTP 常见端点模式
	const jsonRpcPatterns = [
		'/mcp',
		'/sse',
		'/http',
		'/streamable',
		'/jsonrpc',
	];

	for (const pattern of jsonRpcPatterns) {
		if (lowerUrl.endsWith(pattern)) {
			return GatewayType.JSON_RPC;
		}
	}

	return GatewayType.REST;
}

function normalizeToolDefinitions(payload: unknown): ChatToolDefinition[] {
	const rawTools = extractRawTools(payload);
	const definitions: ChatToolDefinition[] = [];

	for (const item of rawTools) {
		if (!isRecord(item))
			continue;

		const name = typeof item.name === 'string' ? item.name : '';
		if (!name)
			continue;

		const description = typeof item.description === 'string' ? item.description : '';
		const inputSchema = isRecord(item.inputSchema)
			? item.inputSchema
			: (isRecord(item.input_schema) ? item.input_schema : (isRecord(item.parameters) ? item.parameters : undefined));

		definitions.push({
			type: 'function',
			function: {
				name,
				description: description || undefined,
				parameters: inputSchema || { type: 'object', additionalProperties: true },
			},
		});
	}

	return definitions;
}

function extractRawTools(payload: unknown): unknown[] {
	if (!isRecord(payload))
		return [];

	// JSON-RPC 响应格式：{ jsonrpc: "2.0", result: { tools: [...] }, id: 1 }
	if (payload.jsonrpc === '2.0' && isRecord(payload.result)) {
		if (Array.isArray(payload.result.tools)) {
			return payload.result.tools;
		}
		// 有些实现直接返回 result: [...]
		if (Array.isArray(payload.result)) {
			return payload.result;
		}
	}

	// REST 响应格式：{ tools: [...] } 或 { result: { tools: [...] } }
	if (Array.isArray(payload.tools)) {
		return payload.tools;
	}
	if (isRecord(payload.result) && Array.isArray(payload.result.tools)) {
		return payload.result.tools;
	}

	return [];
}

function parseToolArguments(argumentsText: string): unknown {
	const text = (argumentsText || '').trim();
	if (!text)
		return {};
	try {
		return JSON.parse(text) as unknown;
	}
	catch {
		return { _raw: text };
	}
}

function coerceToolResultToText(response: unknown): string {
	if (!isRecord(response)) {
		return stringifyUnknown(response);
	}

	// JSON-RPC 错误响应：{ jsonrpc: "2.0", error: {...}, id: 1 }
	if (response.jsonrpc === '2.0' && isRecord(response.error)) {
		const error = response.error;
		const message = typeof error.message === 'string' ? error.message : '';
		const code = typeof error.code === 'number' ? error.code : '';
		return `JSON-RPC Error ${code}: ${message}`;
	}

	// JSON-RPC 成功响应：{ jsonrpc: "2.0", result: {...}, id: 1 }
	if (response.jsonrpc === '2.0' && response.result !== undefined) {
		return coerceToolResultToText(response.result);
	}

	// 递归处理嵌套的 result
	if (isRecord(response.result)) {
		return coerceToolResultToText(response.result);
	}

	// MCP 标准 content 数组格式
	if (Array.isArray(response.content)) {
		return extractTextFromContentArray(response.content);
	}

	// 简单字符串 content
	if (typeof response.content === 'string') {
		return response.content;
	}

	// 其他字段
	if (response.output !== undefined) {
		return stringifyUnknown(response.output);
	}
	if (response.error !== undefined) {
		return stringifyUnknown(response.error);
	}

	return stringifyUnknown(response);
}

function extractTextFromContentArray(content: unknown[]): string {
	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
			parts.push(item.text);
		}
		else {
			parts.push(stringifyUnknown(item));
		}
	}
	return parts.join('\n').trim();
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}...`;
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2);
	}
	catch {
		return String(value);
	}
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}

/**
 * 解析 SSE 响应（MCP Streamable HTTP）
 *
 * 格式：
 * event: message
 * data: {"jsonrpc":"2.0","result":{...},"id":1}
 */
function parseSSEResponse(text: string): unknown {
	const lines = text.split(/\r?\n/);
	let dataLine = '';

	for (const line of lines) {
		if (line.startsWith('data:')) {
			dataLine = line.substring(5).trim();
			break;
		}
	}

	if (!dataLine) {
		throw new Error('SSE 响应中未找到 data 字段');
	}

	try {
		return JSON.parse(dataLine);
	}
	catch (error) {
		throw new Error(`SSE data 解析失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * 递归检测工具响应中的错误状态
 *
 * 支持两种格式：
 * 1. JSON-RPC 2.0: { jsonrpc: "2.0", error: {...}, id: 1 }
 * 2. MCP 规范: { result: { isError: true } } 或 { error: "..." }
 *
 * 递归检查所有嵌套的 result 层级，避免深层错误漏检
 */
function detectToolError(response: unknown, visited = new Set<any>()): boolean {
	if (!isRecord(response)) {
		return false;
	}

	// 防止循环引用导致无限递归
	if (visited.has(response)) {
		return false;
	}
	visited.add(response);

	// JSON-RPC 错误响应
	if (response.jsonrpc === '2.0' && response.error !== undefined) {
		return true;
	}

	// 检查顶层 isError
	if (response.isError === true) {
		return true;
	}

	// 检查顶层 error 字段（协议级错误）
	// 只有非空对象或有意义的字符串才算错误
	if (response.error !== undefined && response.error !== null && response.error !== false) {
		if (typeof response.error === 'string' && response.error.trim().length > 0) {
			return true;
		}
		if (typeof response.error === 'object') {
			return true;
		}
	}

	// 递归检查嵌套的 result
	if (isRecord(response.result)) {
		if (detectToolError(response.result, visited)) {
			return true;
		}
	}

	return false;
}
