/**
 * AI原理图审查 - 类型定义
 */

// ============ 数据序列化格式 ============

/**
 * SCH-REVIEW-COMPACT v1 格式
 * 使用tuple数组节省Token
 */
export interface SchReviewChunk {
	schema: 'sch-review-compact-v1';
	summary: {
		totalComponents: number;
		totalPins: number;
		totalNets: number;
		chunkId: string;
		chunkCount: number;
	};
	// [位号, 名称, 制造商, 制造商编号, X, Y, 旋转]
	components: Array<[string, string, string, string, number, number, number]>;
	// [位号, 引脚编号, 引脚名称, 引脚类型, 网络名称]
	pins: Array<[string, string, string, string, string | null]>;
	// [网络名称, 连接引脚数]
	nets: Array<[string, number]>;
}

// ============ 原始数据结构 ============

/**
 * 原始器件数据
 */
export interface RawComponent {
	primitiveId: string;
	designator: string;
	name: string;
	manufacturer: string;
	manufacturerPartNumber: string;
	x: number;
	y: number;
	rotation: number;
	schematicPageUuid?: string;
}

/**
 * 原始引脚数据
 */
export interface RawPin {
	primitiveId: string;
	componentPrimitiveId: string;
	componentDesignator: string;
	pinNumber: string;
	pinName: string;
	pinType: string;
	netName: string | null;
	netBindingConfidence?: number; // 0-1，网络绑定置信度
	netBindingReason?: string; // 绑定来源：netlist/wire/netlabel/unresolved
}

/**
 * 原始网络数据
 */
export interface RawNet {
	netName: string;
	pinCount: number;
	pins: string[]; // pin primitive IDs
}

/**
 * 采集模式
 */
export type CollectionMode = 'per-page' | 'per-page-hybrid';

/**
 * 采集质量等级
 * - full: 所有页面均已成功采集
 * - partial: 部分页面采集成功，存在遗漏
 * - stale: 使用旧快照或完全降级
 */
export type CollectionQuality = 'full' | 'partial' | 'stale';

/**
 * 采集元信息（用于数据完整性追踪和前端提示）
 */
export interface CollectionMeta {
	mode: CollectionMode;
	quality: CollectionQuality;
	expectedPageCount: number;
	collectedPageCount: number;
	collectedPageUuids: string[];
	missingPageUuids: string[];
	errorMessage?: string;
}

/**
 * 原始文本标注数据
 */
export interface RawText {
	primitiveId: string;
	content: string;
	x: number;
	y: number;
	schematicPageUuid?: string;
}

/**
 * 原始总线数据
 */
export interface RawBus {
	primitiveId: string;
	busName: string;
	lines: number[][];
	schematicPageUuid?: string;
}

/**
 * 原始网络标记数据（GND、VCC 等标签）
 */
export interface RawNetLabel {
	primitiveId: string;
	netName: string;
	x: number;
	y: number;
	type: 'netflag' | 'netport';
	schematicPageUuid?: string;
}

/**
 * 采集的原始数据快照
 */
export interface CollectedData {
	components: RawComponent[];
	pins: RawPin[];
	nets: RawNet[];
	texts?: RawText[];
	buses?: RawBus[];
	netLabels?: RawNetLabel[]; // 网络标记（GND、VCC 等）
	netlistRaw?: string; // 原始网表字符串
	timestamp: number;
	meta?: CollectionMeta;
}

// ============ 审查结果 ============

/**
 * 问题严重程度
 */
export enum IssueSeverity {
	MUST_FIX = 'must_fix',
	SUGGESTION = 'suggestion',
}

/**
 * 问题证据
 */
export interface IssueEvidence {
	components?: string[]; // 器件位号
	pins?: string[]; // 引脚标识（格式：U1.32 或 U1_32）
	nets?: string[]; // 网络名称
	datasheet_urls?: string[]; // 数据手册链接
}

/**
 * 审查问题
 */
export interface ReviewIssue {
	id: string; // 唯一标识
	severity: IssueSeverity;
	title: string;
	reason: string;
	impact: string;
	confidence: number; // 0-1
	fix: string;
	evidence: IssueEvidence;
	source: 'rule-engine' | 'ai'; // 问题来源
	ruleId?: string; // 规则ID（如果来自规则引擎）
}

/**
 * 审查结果
 */
export interface ReviewResult {
	must_fix: ReviewIssue[];
	suggestions: ReviewIssue[];
	metadata: {
		timestamp: number;
		totalComponents: number;
		totalPins: number;
		totalNets: number;
		chunksProcessed: number;
		aiProvider?: string;
		aiModel?: string;
	};
}

// ============ 配置 ============

/**
 * AI Provider类型
 */
export enum AIProvider {
	OPENAI_COMPATIBLE = 'openai_compatible',
}

/**
 * 配置存储
 */
export interface ConfigStore {
	provider: AIProvider;
	apiKey: string;
	model: string;
	apiUrl?: string; // 自定义API地址
	maxPinsPerChunk?: number; // 默认1200
	timeout?: number; // 请求超时（秒），默认120
	windowWidth?: number; // 窗口宽度，默认960
	windowHeight?: number; // 窗口高度，默认700
	mcpEnabled?: boolean; // 是否启用 MCP 工具调用
	mcpGatewayUrl?: string; // MCP Gateway 地址
	mcpGatewayApiKey?: string; // MCP Gateway 鉴权 token（可选）
	mcpAutoApprove?: boolean; // 是否默认自动批准工具调用
}

// ============ 对话模式通信协议 ============

/**
 * MessageBus主题（对话模式）
 */
export const CHAT_TOPICS = {
	// IFrame -> 主扩展
	REQUEST_DATA: 'ai-chat/request-data',
	REQUEST_CONFIG: 'ai-chat/request-config',
	REQUEST_HISTORY: 'ai-chat/request-history',
	REQUEST_TOOLS: 'ai-chat/request-tools',
	USER_MESSAGE: 'ai-chat/user-message',
	ABORT_REQUEST: 'ai-chat/abort-request',
	REGENERATE_REQUEST: 'ai-chat/regenerate-request',
	LOCATE: 'ai-chat/locate',
	CONFIG_UPDATE: 'ai-chat/config-update',
	HISTORY_UPDATE: 'ai-chat/history-update',
	CLEAR_SESSION: 'ai-chat/clear-session',

	// 主扩展 -> IFrame
	SCHEMATIC_DATA: 'ai-chat/schematic-data',
	CONFIG_DATA: 'ai-chat/config-data',
	HISTORY_DATA: 'ai-chat/history-data',
	TOOLS_DATA: 'ai-chat/tools-data',
	AI_RESPONSE: 'ai-chat/ai-response',
	AI_THINKING: 'ai-chat/ai-thinking',
	AI_TEXT: 'ai-chat/ai-text',
	TOOL_EVENT: 'ai-chat/tool-event',
	ERROR: 'ai-chat/error',
} as const;

/**
 * 原理图数据摘要（发送给IFrame）
 */
export interface SchematicDataSummary {
	summary: {
		components: number;
		pins: number;
		nets: number;
	};
	timestamp: number;
}

/**
 * 用户消息（IFrame -> 主扩展）
 */
export interface UserMessage {
	text: string;
	images?: Array<{
		name: string;
		type: string;
		data: string; // base64
	}>;
	schematicData?: SchematicDataSummary | null;
	requestId: string; // 请求唯一标识，用于匹配响应
	sessionId: string; // 会话标识，防止串线
}

/**
 * AI响应（主扩展 -> IFrame）
 */
export interface AIResponse {
	content: string;
	timestamp: number;
	requestId: string; // 回传请求ID
	sessionId: string; // 回传会话ID
}

/**
 * 流式分块类型（参考 Cherry Studio ChunkType）
 */
export enum ChunkType {
	THINKING_START = 'THINKING_START',
	THINKING_DELTA = 'THINKING_DELTA',
	THINKING_COMPLETE = 'THINKING_COMPLETE',
	TEXT_START = 'TEXT_START',
	TEXT_DELTA = 'TEXT_DELTA',
	TEXT_COMPLETE = 'TEXT_COMPLETE',
}

/**
 * 流式分块状态
 */
export type MessageBlockStatus = 'success' | 'paused' | 'streaming' | 'error';

/**
 * AI流式消息分块（后端内部使用）
 */
export interface MessageBlock {
	type: ChunkType;
	content: string; // 当前增量内容
	accumulatedContent: string; // 到当前为止的累计内容
	timestamp: number;
	status?: MessageBlockStatus;
}

/**
 * AI流式消息分块（主扩展 -> IFrame）
 */
export interface AIBlockResponse extends MessageBlock {
	requestId: string;
	sessionId: string;
}

// ============ MCP 工具调用类型 ============

/**
 * Chat Completions - 可供模型调用的工具定义（OpenAI function calling 格式）
 */
export interface ChatToolDefinition {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

/**
 * Chat Completions - 模型发起的工具调用
 */
export interface ChatToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON 字符串
	};
}

/**
 * 工具执行返回给模型的消息
 */
export interface ToolExecutionResultMessage {
	toolCallId: string;
	toolName: string;
	content: string;
	isError?: boolean;
}

/** 工具事件状态 */
export type ToolEventStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped';

/** 工具事件阶段 */
export type ToolEventStage = 'tools-list' | 'tool-call';

/**
 * 工具运行事件（主扩展 -> IFrame）
 */
export interface ToolEventMessage {
	requestId: string;
	sessionId: string;
	eventId: string;
	stage: ToolEventStage;
	status: ToolEventStatus;
	title: string;
	toolName?: string;
	toolCallId?: string;
	detail?: string;
	resultPreview?: string;
	error?: string;
	timestamp: number;
}

/**
 * 定位请求（IFrame -> 主扩展）
 */
export interface LocateRequest {
	reference: string; // 器件位号或网络名
}

/**
 * 停止生成请求（IFrame -> 主扩展）
 */
export interface AbortRequest {
	requestId: string;
	sessionId: string;
}

/**
 * 重新生成请求（IFrame -> 主扩展）
 */
export interface RegenerateRequest {
	requestId: string;
	sessionId: string;
}

/**
 * 错误消息（主扩展 -> IFrame）
 */
export interface ErrorMessage {
	message: string;
	code?: string;
	details?: unknown;
	requestId?: string; // 回传请求ID（如果有）
	sessionId?: string; // 回传会话ID（如果有）
}

// ============ 错误码 ============

export enum ErrorCode {
	// 采集错误
	COLLECT_NO_DOCUMENT = 'COLLECT_NO_DOCUMENT',
	COLLECT_API_FAILED = 'COLLECT_API_FAILED',

	// 序列化错误
	SERIALIZE_INVALID_DATA = 'SERIALIZE_INVALID_DATA',

	// AI通信错误
	AI_NO_CONFIG = 'AI_NO_CONFIG',
	AI_NETWORK_ERROR = 'AI_NETWORK_ERROR',
	AI_CORS_ERROR = 'AI_CORS_ERROR',
	AI_AUTH_ERROR = 'AI_AUTH_ERROR',
	AI_RATE_LIMIT = 'AI_RATE_LIMIT',
	AI_TIMEOUT = 'AI_TIMEOUT',
	AI_ABORTED = 'AI_ABORTED',
	AI_INVALID_RESPONSE = 'AI_INVALID_RESPONSE',
	AI_SERVER_ERROR = 'AI_SERVER_ERROR',

	// UI错误
	UI_IFRAME_FAILED = 'UI_IFRAME_FAILED',
	UI_MESSAGEBUS_FAILED = 'UI_MESSAGEBUS_FAILED',
}

/**
 * 审查错误
 */
export class ReviewError extends Error {
	constructor(
		public code: ErrorCode,
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = 'ReviewError';
	}
}
