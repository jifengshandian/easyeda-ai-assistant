import type { SendMessageOptions } from './chat-adapter';
/**
 * AI原理图审查 - 对话模式编排器
 *
 * 管理IFrame面板与AI对话的完整生命周期
 * 按 sessionId 隔离对话会话，支持流式 thinking/text 推送
 */
import type { AbortRequest, AIBlockResponse, ChatToolCall, CollectedData, MessageBlock, RegenerateRequest, ToolEventMessage, UserMessage } from './types';
import { ChatSession, setDebugLog } from './chat-adapter';
import { clearBackgroundNetlistState, collectSchematicData, getBackgroundNetlistState, parseNetlist, setLogToIFrame } from './collector';
import { loadChatHistory, loadConfig, saveChatHistory, saveConfig, validateConfig } from './config';
import { ToolOrchestrator } from './tool-orchestrator';
import { CHAT_TOPICS, ChunkType, ErrorCode, ReviewError } from './types';

// 初始化 collector 的日志发送函数
setLogToIFrame((level: string, message: string, data?: any) => {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
});

// 初始化 chat-adapter 的日志发送函数
setDebugLog((level: string, message: string, data?: any) => {
	publishToIFrame('ai-chat/debug-log', { level, message, data });
});

/**
 * 按 sessionId 维护对话会话（替代单一全局 chatSession）
 */
const chatSessions = new Map<string, ChatSession>();

/**
 * 进行中请求的状态（按 requestId 隔离）
 */
interface PendingRequestState {
	sessionId: string;
	abortController: AbortController;
	thinkingAccumulated: string;
	textAccumulated: string;
}

const pendingRequests = new Map<string, PendingRequestState>();

/**
 * 正在处理中的 requestId 集合（用于防止并发重复处理）
 */
const processingRequests = new Set<string>();

/**
 * 已完成的 requestId 缓存（用于防止重复处理）
 * 格式：{ requestId: timestamp }
 */
const completedRequests = new Map<string, number>();

/**
 * 已完成请求的缓存时间（毫秒）
 */
const COMPLETED_REQUEST_CACHE_TIME = 60000; // 60 秒

/**
 * 记录每个会话最后一条用户消息（用于重新生成）
 */
const lastUserMessageBySession = new Map<string, UserMessage>();

/**
 * 缓存的原理图数据
 */
let cachedSchematicData: CollectedData | null = null;

/**
 * MessageBus订阅引用
 */
const subscriptions: Array<{ cancel: () => void }> = [];

/**
 * 后台采集 single-flight 调度状态
 */
let backgroundCollectionInFlight: Promise<void> | null = null;
let backgroundCollectionRerunPending = false;
let backgroundCollectionRerunReason = '';
let backgroundCollectionRerunNotify = false;
let backgroundCollectionEpoch = 0;

/**
 * 检查是否正在采集中（用于外部抑制逻辑）
 */
export function isCollectionInProgress(): boolean {
	return backgroundCollectionInFlight !== null;
}

/**
 * 启动AI对话面板
 */
export async function startAIChat(): Promise<void> {
	// 从配置读取窗口尺寸
	const config = loadConfig();
	const width = config.windowWidth || 960;
	const height = config.windowHeight || 700;

	// 打开IFrame面板（不阻塞，不立即采集数据）
	try {
		await eda.sys_IFrame.openIFrame('/iframe/chat.html', width, height, 'ai-sch-chat', {
			maximizeButton: true,
			minimizeButton: true,
		});
	}
	catch {
		throw new ReviewError(ErrorCode.UI_IFRAME_FAILED, '无法打开对话面板');
	}

	// 打开新面板时重置会话容器，避免旧面板状态串入
	clearAllChatSessions();

	// 设置MessageBus监听
	setupChatListeners();

	// 异步触发后台采集（不阻塞UI）
	void triggerBackgroundCollection('start-ai-chat', true);
}

/**
 * 对外暴露：触发后台采集
 * - reason: 触发原因（便于日志追踪）
 * - notifyIFrame: 是否向 IFrame 发布采集中/完成状态
 */
export function triggerBackgroundCollection(
	reason = 'external-trigger',
	notifyIFrame = false,
): Promise<void> {
	if (backgroundCollectionInFlight) {
		backgroundCollectionRerunPending = true;
		backgroundCollectionRerunReason = reason;
		backgroundCollectionRerunNotify = backgroundCollectionRerunNotify || notifyIFrame;
		return backgroundCollectionInFlight;
	}

	const epoch = ++backgroundCollectionEpoch;
	backgroundCollectionInFlight = executeBackgroundCollection(epoch, reason, notifyIFrame)
		.finally(() => {
			backgroundCollectionInFlight = null;

			if (!backgroundCollectionRerunPending) {
				return;
			}

			const rerunReason = backgroundCollectionRerunReason || 'rerun';
			const rerunNotify = backgroundCollectionRerunNotify;
			backgroundCollectionRerunPending = false;
			backgroundCollectionRerunReason = '';
			backgroundCollectionRerunNotify = false;

			void triggerBackgroundCollection(`${rerunReason}:rerun`, rerunNotify);
		});

	return backgroundCollectionInFlight;
}

/**
 * 后台采集执行体
 * - single-flight 由 triggerBackgroundCollection 保证
 * - epoch/version 保证仅最新结果生效
 */
async function executeBackgroundCollection(
	epoch: number,
	reason: string,
	notifyIFrame: boolean,
): Promise<void> {
	const startTime = Date.now();
	try {
		if (notifyIFrame) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: -1, // -1 表示正在采集
					pins: -1,
					nets: -1,
				},
				timestamp: Date.now(),
			});
		}

		// 发送采集开始事件到 IFrame 调试日志
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `后台采集开始 (原因: ${reason}, epoch: ${epoch})`,
		});

		const collected = await collectSchematicData();

		// epoch/version：只接纳最新采集结果，过期结果直接丢弃
		if (epoch !== backgroundCollectionEpoch) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `采集结果被丢弃 (epoch ${epoch} 已过期, 当前 ${backgroundCollectionEpoch})`,
			});
			return;
		}

		cachedSchematicData = collected;

		// 将原理图数据注入所有已存在的会话
		for (const session of chatSessions.values()) {
			session.setSchematicContext(collected);
		}

		const elapsed = Date.now() - startTime;

		// 发送详细采集结果到 IFrame 调试日志
		publishToIFrame('ai-chat/debug-log', {
			level: 'success',
			message: `采集完成 (耗时 ${elapsed}ms)`,
			data: {
				components: collected.components.length,
				pins: collected.pins.length,
				nets: collected.nets.length,
				texts: collected.texts?.length || 0,
				buses: collected.buses?.length || 0,
				meta: collected.meta,
				elapsed,
			},
		});

		if (notifyIFrame) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: collected.components.length,
					pins: collected.pins.length,
					nets: collected.nets.length,
				},
				timestamp: collected.timestamp,
			});
		}

		// 如果网表超时但后台仍在获取，启动延迟回填
		void scheduleNetlistBackfill(epoch, collected);
	}
	catch (error) {
		// 过期任务失败不需要覆盖新任务状态
		if (epoch !== backgroundCollectionEpoch) {
			return;
		}

		const elapsed = Date.now() - startTime;
		const errorMsg = error instanceof Error ? error.message : String(error);
		console.warn(`后台采集数据失败(${reason}):`, error);

		// 发送错误日志到 IFrame
		publishToIFrame('ai-chat/debug-log', {
			level: 'error',
			message: `采集失败 (耗时 ${elapsed}ms): ${errorMsg}`,
		});

		if (notifyIFrame) {
			// 采集失败不阻塞 UI，对话仍可继续
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: -1,
					pins: -1,
					nets: -1,
				},
				timestamp: Date.now(),
			});
		}
	}
}

/**
 * 延迟回填网表数据（如果后台网表获取成功）
 *
 * 策略：
 * 1. 检查 backgroundNetlistState 是否存在且未完成
 * 2. 使用定时器轮询检查完成状态（每 2 秒检查一次，最多 60 秒）
 * 3. 当完成时，重新解析网表并更新引脚的 netName
 * 4. 更新 cachedSchematicData 并通知 IFrame
 * 5. 使用 epoch 版本控制，避免过期任务覆盖新任务
 */
async function scheduleNetlistBackfill(
	epoch: number,
	collected: CollectedData,
): Promise<void> {
	const netlistState = getBackgroundNetlistState();

	// 如果没有后台网表任务，或者已经完成，直接返回
	if (!netlistState || netlistState.completed) {
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `网表回填检查: ${!netlistState ? '无后台网表任务' : '网表已完成（无需回填）'}`,
		});
		return;
	}

	publishToIFrame('ai-chat/debug-log', {
		level: 'info',
		message: '网表后台获取中，将在完成后自动回填引脚绑定...',
	});

	let pollCount = 0;
	const MAX_POLL_COUNT = 30; // 最多轮询 30 次（60 秒）
	const POLL_INTERVAL_MS = 2000; // 每 2 秒检查一次
	const TIMER_ID = `netlist-backfill-epoch-${epoch}`;

	eda.sys_Timer.setIntervalTimer(TIMER_ID, POLL_INTERVAL_MS, async () => {
		pollCount++;

		// 检查是否超过最大轮询次数
		if (pollCount > MAX_POLL_COUNT) {
			eda.sys_Timer.clearIntervalTimer(TIMER_ID);
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: '网表后台获取超时（60秒），放弃回填',
			});
			clearBackgroundNetlistState();
			return;
		}

		// 检查 epoch 是否过期
		if (epoch !== backgroundCollectionEpoch) {
			eda.sys_Timer.clearIntervalTimer(TIMER_ID);
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `网表回填任务被取消（epoch ${epoch} 已过期）`,
			});
			return;
		}

		// 检查网表是否完成
		const currentState = getBackgroundNetlistState();
		if (!currentState || !currentState.completed) {
			return; // 继续等待
		}

		// 网表已完成，停止轮询
		eda.sys_Timer.clearIntervalTimer(TIMER_ID);

		// 如果网表获取失败，直接返回
		if (!currentState.result) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'warn',
				message: `网表后台获取失败（耗时 ${currentState.duration}ms），无法回填`,
			});
			clearBackgroundNetlistState();
			return;
		}

		// 网表获取成功，开始回填
		publishToIFrame('ai-chat/debug-log', {
			level: 'info',
			message: `网表后台获取成功（耗时 ${currentState.duration}ms），开始回填引脚绑定...`,
		});

		try {
			// 解析网表
			const netlistMap = parseNetlist(currentState.result);

			if (netlistMap.size === 0) {
				publishToIFrame('ai-chat/debug-log', {
					level: 'warn',
					message: '网表解析结果为空，无法回填',
				});
				clearBackgroundNetlistState();
				return;
			}

			// 统计回填效果
			let reboundCount = 0;
			let improvedCount = 0;

			// 更新引脚的 netName（使用 L1 策略）
			for (const pin of collected.pins) {
				const pinKey = `${pin.componentDesignator}_${pin.pinNumber}`;
				const netNameFromNetlist = netlistMap.get(pinKey);

				if (netNameFromNetlist) {
					// 如果原来没有绑定，现在绑定了
					if (!pin.netName) {
						reboundCount++;
					}
					// 如果原来有绑定，但置信度较低（L2/L3/L4），现在用 L1 覆盖
					else if (pin.netBindingConfidence && pin.netBindingConfidence < 1.0) {
						improvedCount++;
					}

					// 更新引脚的网络绑定
					pin.netName = netNameFromNetlist;
					pin.netBindingConfidence = 1.0;
					pin.netBindingReason = 'netlist-backfill';
				}
			}

			// 重新构建网络统计
			const netMap = new Map<string, Set<string>>();
			for (const pin of collected.pins) {
				if (pin.netName) {
					if (!netMap.has(pin.netName)) {
						netMap.set(pin.netName, new Set());
					}
					netMap.get(pin.netName)!.add(pin.primitiveId);
				}
			}

			// 更新网络数据
			collected.nets = Array.from(netMap.entries()).map(([netName, pinIds]) => ({
				netName,
				pinCount: pinIds.size,
				pins: Array.from(pinIds),
			}));

			// 更新缓存数据（如果 epoch 仍然有效）
			if (epoch === backgroundCollectionEpoch) {
				cachedSchematicData = collected;

				// 将更新后的数据注入所有已存在的会话
				for (const session of chatSessions.values()) {
					session.setSchematicContext(collected);
				}

				// 通知 IFrame 数据已更新
				publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
					summary: {
						components: collected.components.length,
						pins: collected.pins.length,
						nets: collected.nets.length,
					},
					timestamp: collected.timestamp,
				});

				publishToIFrame('ai-chat/debug-log', {
					level: 'success',
					message: `网表回填完成：新绑定 ${reboundCount} 个引脚，改进 ${improvedCount} 个引脚绑定`,
					data: {
						reboundCount,
						improvedCount,
						totalNetlistMappings: netlistMap.size,
						totalPins: collected.pins.length,
						totalNets: collected.nets.length,
					},
				});
			}
			else {
				publishToIFrame('ai-chat/debug-log', {
					level: 'warn',
					message: `网表回填被丢弃（epoch ${epoch} 已过期）`,
				});
			}
		}
		catch (error) {
			publishToIFrame('ai-chat/debug-log', {
				level: 'error',
				message: `网表回填失败: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
		finally {
			clearBackgroundNetlistState();
		}
	}, POLL_INTERVAL_MS);
}

/**
 * 设置MessageBus监听器
 */
function setupChatListeners(): void {
	cleanupSubscriptions();

	// 监听IFrame请求原理图数据
	subscribe(CHAT_TOPICS.REQUEST_DATA, () => {
		if (cachedSchematicData) {
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: cachedSchematicData.components.length,
					pins: cachedSchematicData.pins.length,
					nets: cachedSchematicData.nets.length,
				},
				timestamp: cachedSchematicData.timestamp,
			});
		}
		else {
			// 如果数据尚未采集或采集失败，返回采集中状态
			publishToIFrame(CHAT_TOPICS.SCHEMATIC_DATA, {
				summary: {
					components: -1,
					pins: -1,
					nets: -1,
				},
				timestamp: Date.now(),
			});
		}
	});

	// 监听IFrame请求配置数据
	subscribe(CHAT_TOPICS.REQUEST_CONFIG, () => {
		const config = loadConfig();
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: config.apiUrl,
			apiKey: config.apiKey || '',
			model: config.model,
			windowWidth: config.windowWidth || 960,
			windowHeight: config.windowHeight || 700,
			mcpEnabled: !!config.mcpEnabled,
			mcpGatewayUrl: config.mcpGatewayUrl || '',
			mcpGatewayApiKey: config.mcpGatewayApiKey || '',
			mcpAutoApprove: config.mcpAutoApprove !== false,
		});
	});

	// 监听IFrame请求历史记录
	subscribe(CHAT_TOPICS.REQUEST_HISTORY, () => {
		const history = loadChatHistory();
		publishToIFrame(CHAT_TOPICS.HISTORY_DATA, { messages: history });
	});

	// 监听IFrame请求工具列表
	subscribe(CHAT_TOPICS.REQUEST_TOOLS, async (data: any) => {
		const requestId = typeof data?.requestId === 'string'
			? data.requestId
			: `tool-preview-${Date.now()}`;
		const sessionId = typeof data?.sessionId === 'string'
			? data.sessionId
			: 'tool-preview';

		const config = loadConfig();
		// 使用 no-op emitter 避免预览事件污染对话流
		const noopEmitter = (): void => { /* 预览模式不发送工具事件 */ };
		const toolOrchestrator = new ToolOrchestrator(
			config,
			{ requestId, sessionId },
			noopEmitter,
		);

		if (!toolOrchestrator.isEnabled()) {
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, { enabled: false, tools: [] });
			return;
		}

		try {
			const tools = await toolOrchestrator.listTools();
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
				enabled: true,
				tools: tools.map(tool => ({
					name: tool.function.name,
					description: tool.function.description || '',
				})),
			});
		}
		catch (error) {
			publishToIFrame(CHAT_TOPICS.TOOLS_DATA, {
				enabled: true,
				tools: [],
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	// 监听用户消息
	subscribe(CHAT_TOPICS.USER_MESSAGE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		await handleUserMessage(data as UserMessage);
	});

	// 监听停止生成请求
	subscribe(CHAT_TOPICS.ABORT_REQUEST, (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		handleAbortRequest(data as AbortRequest);
	});

	// 监听重新生成请求
	subscribe(CHAT_TOPICS.REGENERATE_REQUEST, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;
		await handleRegenerateRequest(data as RegenerateRequest);
	});

	// 监听定位请求
	subscribe(CHAT_TOPICS.LOCATE, async (data: any) => {
		if (!data?.reference)
			return;
		await handleLocateRequest(data.reference);
	});

	// 监听配置更新
	subscribe(CHAT_TOPICS.CONFIG_UPDATE, async (data: any) => {
		if (!data || typeof data !== 'object')
			return;

		// 验证字段类型和长度
		if (data.apiUrl && (typeof data.apiUrl !== 'string' || data.apiUrl.length > 500)) {
			console.warn('无效的 apiUrl');
			return;
		}
		if (data.apiKey && (typeof data.apiKey !== 'string' || data.apiKey.length > 500)) {
			console.warn('无效的 apiKey');
			return;
		}
		if (data.model && (typeof data.model !== 'string' || data.model.length > 100)) {
			console.warn('无效的 model');
			return;
		}
		if (data.mcpEnabled !== undefined && typeof data.mcpEnabled !== 'boolean') {
			console.warn('无效的 mcpEnabled');
			return;
		}
		if (data.mcpAutoApprove !== undefined && typeof data.mcpAutoApprove !== 'boolean') {
			console.warn('无效的 mcpAutoApprove');
			return;
		}
		if (data.mcpGatewayUrl && (typeof data.mcpGatewayUrl !== 'string' || data.mcpGatewayUrl.length > 500)) {
			console.warn('无效的 mcpGatewayUrl');
			return;
		}
		if (data.mcpGatewayApiKey && (typeof data.mcpGatewayApiKey !== 'string' || data.mcpGatewayApiKey.length > 500)) {
			console.warn('无效的 mcpGatewayApiKey');
			return;
		}

		// 验证 URL 格式
		if (data.apiUrl) {
			try {
				const url = new URL(data.apiUrl);
				if (url.protocol !== 'http:' && url.protocol !== 'https:') {
					console.warn('apiUrl 必须是 http 或 https 协议');
					return;
				}
			}
			catch {
				console.warn('apiUrl 格式无效');
				return;
			}
		}
		if (typeof data.mcpGatewayUrl === 'string' && data.mcpGatewayUrl.trim().length > 0) {
			try {
				const gatewayUrl = new URL(data.mcpGatewayUrl);
				if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') {
					console.warn('mcpGatewayUrl 必须是 http 或 https 协议');
					return;
				}
			}
			catch {
				console.warn('mcpGatewayUrl 格式无效');
				return;
			}
		}

		const result = await saveConfig(data);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `配置保存失败: ${result.error || '未知错误'}`,
				code: 'CONFIG_SAVE_FAILED',
			});
			return;
		}

		// 保存成功后回传配置
		publishToIFrame(CHAT_TOPICS.CONFIG_DATA, {
			apiUrl: result.config.apiUrl,
			apiKey: result.config.apiKey || '',
			model: result.config.model,
			windowWidth: result.config.windowWidth || 960,
			windowHeight: result.config.windowHeight || 700,
			mcpEnabled: !!result.config.mcpEnabled,
			mcpGatewayUrl: result.config.mcpGatewayUrl || '',
			mcpGatewayApiKey: result.config.mcpGatewayApiKey || '',
			mcpAutoApprove: result.config.mcpAutoApprove !== false,
		});
	});

	// 监听历史记录更新
	subscribe(CHAT_TOPICS.HISTORY_UPDATE, async (data: any) => {
		if (!data || !Array.isArray(data.messages))
			return;

		// 验证数组大小
		if (data.messages.length > 100) {
			console.warn('历史会话数量过多（最大 100）');
			return;
		}

		// 验证每个会话的结构
		for (const session of data.messages) {
			if (!session || typeof session !== 'object') {
				console.warn('无效的会话结构');
				return;
			}
			if (!session.id || typeof session.id !== 'string' || session.id.length > 100) {
				console.warn('无效的会话 ID');
				return;
			}
			if (!Array.isArray(session.messages) || session.messages.length > 1000) {
				console.warn('无效的会话消息列表');
				return;
			}
			// 验证消息结构
			for (const msg of session.messages) {
				if (!msg || typeof msg !== 'object') {
					console.warn('无效的消息结构');
					return;
				}
				if (!msg.role || (msg.role !== 'user' && msg.role !== 'ai')) {
					console.warn('无效的消息角色');
					return;
				}
				if (typeof msg.content !== 'string' || msg.content.length > 100000) {
					console.warn('无效的消息内容');
					return;
				}
			}
		}

		const result = await saveChatHistory(data.messages);

		if (!result.success) {
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: `历史记录保存失败: ${result.error || '未知错误'}`,
				code: 'HISTORY_SAVE_FAILED',
			});
		}
	});

	// 监听清空会话请求（支持按 sessionId 清空或全部清空）
	subscribe(CHAT_TOPICS.CLEAR_SESSION, (data: any) => {
		const sessionId = typeof data?.sessionId === 'string'
			? data.sessionId
			: '';

		if (sessionId) {
			abortPendingRequestsBySession(sessionId);
			lastUserMessageBySession.delete(sessionId);

			const session = chatSessions.get(sessionId);
			if (session) {
				session.reset();
				chatSessions.delete(sessionId);
			}
			return;
		}

		// 无 sessionId 时清空所有会话
		clearAllChatSessions();
	});

	// 监听恢复会话请求（从历史记录恢复上下文）
	subscribe('ai-chat/restore-session', (data: any) => {
		if (!data || typeof data !== 'object') {
			return;
		}

		const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
		const messages = Array.isArray(data.messages) ? data.messages : [];

		if (!sessionId || messages.length === 0) {
			return;
		}

		// 获取或创建会话
		const session = getOrCreateChatSession(sessionId);

		// 重建历史记录
		session.reset(); // 先清空
		for (const msg of messages) {
			if (!msg || typeof msg !== 'object') {
				continue;
			}

			const role = msg.role === 'user' ? 'user' : 'assistant';
			const content = typeof msg.content === 'string' ? msg.content : '';

			// 如果是 assistant 消息且有 thinkingSummary，合并到 content
			let finalContent = content;
			if (role === 'assistant' && msg.thinkingSummary) {
				finalContent = `${msg.thinkingSummary}\n\n${content}`;
			}

			// 直接操作 history（绕过 sendMessage 的验证）
			(session as any).history.push({
				role,
				content: finalContent,
			});
		}

		console.warn(`[restoreSession] 恢复会话 ${sessionId}，历史消息数: ${messages.length}`);
	});
}

/**
 * 处理用户消息
 */
async function handleUserMessage(msg: UserMessage): Promise<void> {
	// 验证消息结构
	if (!msg || typeof msg !== 'object') {
		return;
	}

	// 验证必需字段
	if (!msg.requestId || !msg.sessionId) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '消息格式错误：缺少 requestId 或 sessionId',
		});
		return;
	}

	console.warn(`[handleUserMessage] 收到消息: requestId=${msg.requestId}, sessionId=${msg.sessionId}, text=${msg.text?.substring(0, 50)}`);

	// 检查是否已完成（防止重复处理）
	if (completedRequests.has(msg.requestId)) {
		const completedTime = completedRequests.get(msg.requestId)!;
		const elapsed = Date.now() - completedTime;
		console.warn(`[handleUserMessage] 忽略已完成的请求 requestId: ${msg.requestId}（${elapsed}ms 前已完成）`);
		return;
	}

	// 防重复提交：使用 Set 实现同步锁，防止并发重复处理
	if (processingRequests.has(msg.requestId)) {
		console.warn(`[handleUserMessage] 忽略重复的请求 requestId: ${msg.requestId}`);
		return;
	}

	// 立即标记为处理中（同步操作，防止竞态条件）
	processingRequests.add(msg.requestId);
	console.warn(`[handleUserMessage] 开始处理 requestId=${msg.requestId}, 当前处理中队列大小: ${processingRequests.size}`);

	// 验证文本长度
	if (msg.text && msg.text.length > 50000) {
		processingRequests.delete(msg.requestId);
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '消息过长（最大 50000 字符）',
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
		return;
	}

	// 验证图片数量和大小
	if (msg.images) {
		if (msg.images.length > 10) {
			processingRequests.delete(msg.requestId);
			publishToIFrame(CHAT_TOPICS.ERROR, {
				message: '图片数量过多（最大 10 张）',
				requestId: msg.requestId,
				sessionId: msg.sessionId,
			});
			return;
		}

		for (const img of msg.images) {
			if (img.data && img.data.length > 10 * 1024 * 1024) {
				processingRequests.delete(msg.requestId);
				publishToIFrame(CHAT_TOPICS.ERROR, {
					message: '图片过大（单张最大 10MB）',
					requestId: msg.requestId,
					sessionId: msg.sessionId,
				});
				return;
			}
		}
	}

	const config = loadConfig();
	const configError = validateConfig(config);

	if (configError) {
		processingRequests.delete(msg.requestId);
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: `请先配置AI: ${configError}`,
			code: ErrorCode.AI_NO_CONFIG,
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
		return;
	}

	// 创建新的 AbortController
	const abortController = new AbortController();
	pendingRequests.set(msg.requestId, {
		sessionId: msg.sessionId,
		abortController,
		thinkingAccumulated: '',
		textAccumulated: '',
	});

	try {
		// 按 sessionId 获取或创建会话（核心隔离机制）
		const session = getOrCreateChatSession(msg.sessionId);

		// 创建工具编排器
		const toolOrchestrator = new ToolOrchestrator(
			config,
			{ requestId: msg.requestId, sessionId: msg.sessionId },
			publishToolEvent,
		);

		// 如果启用 MCP，拉取工具列表
		let availableTools: import('./types').ChatToolDefinition[] = [];
		if (toolOrchestrator.isEnabled()) {
			try {
				availableTools = await toolOrchestrator.listTools(abortController.signal);
			}
			catch (toolListError) {
				publishToolEvent({
					requestId: msg.requestId,
					sessionId: msg.sessionId,
					eventId: `tool-list-error-${Date.now()}`,
					stage: 'tools-list',
					status: 'error',
					title: '加载工具清单失败，继续纯文本对话',
					error: toolListError instanceof Error ? toolListError.message : String(toolListError),
					timestamp: Date.now(),
				});
			}
		}

		// 构建 sendMessage 选项
		const sendOptions: SendMessageOptions | undefined = toolOrchestrator.isEnabled()
			? {
					tools: availableTools,
					onToolCalls: async (toolCalls: ChatToolCall[]) => {
						return await toolOrchestrator.executeToolCalls(toolCalls, abortController.signal);
					},
					maxToolRounds: 6,
				}
			: undefined;

		console.warn(`[handleUserMessage] 调用 session.sendMessage, requestId=${msg.requestId}`);

		const reply = await session.sendMessage(
			msg,
			config,
			(block) => {
				if (abortController.signal.aborted)
					return;

				// 记录累积内容
				const pending = pendingRequests.get(msg.requestId);
				if (pending) {
					if (isThinkingBlock(block.type))
						pending.thinkingAccumulated = block.accumulatedContent;
					else
						pending.textAccumulated = block.accumulatedContent;
				}

				publishMessageBlock(msg.requestId, msg.sessionId, block);
			},
			abortController.signal,
			sendOptions,
		);

		if (abortController.signal.aborted) {
			console.warn(`[handleUserMessage] 请求已中止, requestId=${msg.requestId}`);
			return;
		}

		console.warn(`[handleUserMessage] session.sendMessage 完成, requestId=${msg.requestId}, replyLength=${reply.length}`);

		// 保存最后一条用户消息（用于重新生成）
		lastUserMessageBySession.set(msg.sessionId, cloneUserMessage(msg));

		publishToIFrame(CHAT_TOPICS.AI_RESPONSE, {
			content: reply,
			timestamp: Date.now(),
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});

		console.warn(`[handleUserMessage] AI_RESPONSE 已发送, requestId=${msg.requestId}`);
	}
	catch (error) {
		console.error(`[handleUserMessage] 处理失败, requestId=${msg.requestId}:`, error);

		// 如果是中止错误，静默处理
		if (isAbortError(error)) {
			console.warn(`[handleUserMessage] 中止错误，静默处理, requestId=${msg.requestId}`);
			return;
		}

		const payload = buildErrorPayload(error);
		publishToIFrame(CHAT_TOPICS.ERROR, {
			...payload,
			requestId: msg.requestId,
			sessionId: msg.sessionId,
		});
	}
	finally {
		// 清理状态
		console.warn(`[handleUserMessage] 清理状态, requestId=${msg.requestId}, 清理前队列大小: ${processingRequests.size}`);
		pendingRequests.delete(msg.requestId);
		processingRequests.delete(msg.requestId);

		// 记录已完成的请求（防止重复处理）
		completedRequests.set(msg.requestId, Date.now());

		// 清理过期的已完成请求（避免内存泄漏）
		cleanupCompletedRequests();

		console.warn(`[handleUserMessage] 清理完成, requestId=${msg.requestId}, 清理后队列大小: ${processingRequests.size}`);
	}
}

/**
 * 清理过期的已完成请求缓存
 */
function cleanupCompletedRequests(): void {
	const now = Date.now();
	for (const [requestId, completedTime] of completedRequests.entries()) {
		if (now - completedTime > COMPLETED_REQUEST_CACHE_TIME) {
			completedRequests.delete(requestId);
		}
	}
}

/**
 * 处理定位请求
 */
async function handleLocateRequest(reference: string): Promise<void> {
	try {
		// 判断是器件位号还是网络名
		const isComponent = /^[URCLDQJK]\d+$/i.test(reference);

		if (isComponent) {
			await eda.sch_SelectControl.doCrossProbeSelect(
				[reference], // components
				[], // pins
				[], // nets
				true, // clearSelection
				true, // zoomToFit
			);
		}
		else {
			await eda.sch_SelectControl.doCrossProbeSelect(
				[],
				[],
				[reference],
				true,
				true,
			);
		}
	}
	catch (error) {
		console.warn('定位失败:', error);
	}
}

// ============ 会话管理（按 sessionId 隔离） ============

/**
 * 获取或创建指定 sessionId 的对话会话
 */
function getOrCreateChatSession(sessionId: string): ChatSession {
	const existing = chatSessions.get(sessionId);
	if (existing)
		return existing;

	const session = new ChatSession();
	if (cachedSchematicData) {
		session.setSchematicContext(cachedSchematicData);
	}

	chatSessions.set(sessionId, session);
	return session;
}

/**
 * 清空所有对话会话
 */
function clearAllChatSessions(): void {
	abortAllPendingRequests();

	for (const session of chatSessions.values()) {
		session.reset();
	}
	chatSessions.clear();
	lastUserMessageBySession.clear();
}

// ============ 中止管理 ============

/**
 * 处理停止生成请求
 */
function handleAbortRequest(data: AbortRequest): void {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId)
		return;

	const pending = pendingRequests.get(requestId);
	if (!pending)
		return;
	if (pending.sessionId !== sessionId)
		return;

	pending.abortController.abort();
	publishPausedCompleteBlocks(requestId, sessionId, pending);
	pendingRequests.delete(requestId);
}

/**
 * 处理重新生成请求
 */
async function handleRegenerateRequest(data: RegenerateRequest): Promise<void> {
	const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
	const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';

	if (!requestId || !sessionId) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '重新生成请求格式错误',
			code: 'REGENERATE_REQUEST_INVALID',
		});
		return;
	}

	// 如果当前会话还有进行中的请求，先中止
	abortPendingRequestsBySession(sessionId);

	const session = chatSessions.get(sessionId);
	if (!session) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '未找到可重新生成的会话',
			code: 'REGENERATE_SESSION_NOT_FOUND',
			requestId,
			sessionId,
		});
		return;
	}

	const lastUserMessage = lastUserMessageBySession.get(sessionId);
	if (!lastUserMessage) {
		publishToIFrame(CHAT_TOPICS.ERROR, {
			message: '当前会话没有可重新生成的用户消息',
			code: 'REGENERATE_NO_MESSAGE',
			requestId,
			sessionId,
		});
		return;
	}

	// 回滚最后一轮对话，再重新发送
	session.clear();

	const regenerateMessage: UserMessage = {
		...cloneUserMessage(lastUserMessage),
		requestId,
		sessionId,
	};
	await handleUserMessage(regenerateMessage);
}

/**
 * 中止全部进行中请求
 */
function abortAllPendingRequests(): void {
	for (const pending of pendingRequests.values()) {
		pending.abortController.abort();
	}
	pendingRequests.clear();
}

/**
 * 中止指定会话的所有进行中请求
 */
function abortPendingRequestsBySession(sessionId: string): void {
	for (const [requestId, pending] of pendingRequests.entries()) {
		if (pending.sessionId !== sessionId)
			continue;

		pending.abortController.abort();
		pendingRequests.delete(requestId);
	}
}

/**
 * 发送 paused 状态的 COMPLETE 事件（中止时使用）
 */
function publishPausedCompleteBlocks(
	requestId: string,
	sessionId: string,
	pending: PendingRequestState,
): void {
	if (pending.thinkingAccumulated) {
		publishMessageBlock(requestId, sessionId, {
			type: ChunkType.THINKING_COMPLETE,
			content: '',
			accumulatedContent: pending.thinkingAccumulated,
			timestamp: Date.now(),
			status: 'paused',
		});
	}
	publishMessageBlock(requestId, sessionId, {
		type: ChunkType.TEXT_COMPLETE,
		content: '',
		accumulatedContent: pending.textAccumulated,
		timestamp: Date.now(),
		status: 'paused',
	});
}

/**
 * 判断是否为中止错误
 */
function isAbortError(error: unknown): boolean {
	return error instanceof ReviewError && error.code === ErrorCode.AI_ABORTED;
}

/**
 * 构建错误消息的 payload
 */
function buildErrorPayload(error: unknown): { message: string; code?: string; details?: unknown } {
	if (error instanceof ReviewError) {
		return {
			message: error.message,
			code: error.code,
			details: error.details,
		};
	}

	if (error instanceof Error) {
		return {
			message: `AI请求失败: ${error.message}`,
			details: { name: error.name, message: error.message },
		};
	}

	return {
		message: `AI请求失败: ${String(error)}`,
	};
}

/**
 * 深拷贝用户消息（用于重新生成）
 */
function cloneUserMessage(msg: UserMessage): UserMessage {
	return {
		...msg,
		images: msg.images?.map(img => ({ ...img })),
		schematicData: msg.schematicData
			? {
					summary: { ...msg.schematicData.summary },
					timestamp: msg.schematicData.timestamp,
				}
			: msg.schematicData,
	};
}

// ============ 流式 Block 推送 ============

/**
 * 将 MessageBlock 推送到 IFrame
 * thinking 类型使用 AI_THINKING topic，text 类型使用 AI_TEXT topic
 */
function publishMessageBlock(
	requestId: string,
	sessionId: string,
	block: MessageBlock,
): void {
	const topic = isThinkingBlock(block.type)
		? CHAT_TOPICS.AI_THINKING
		: CHAT_TOPICS.AI_TEXT;

	const payload: AIBlockResponse = {
		...block,
		requestId,
		sessionId,
	};

	publishToIFrame(topic, payload);
}

/**
 * 推送工具运行事件到 IFrame
 */
function publishToolEvent(event: ToolEventMessage): void {
	publishToIFrame(CHAT_TOPICS.TOOL_EVENT, event);
}

/**
 * 判断是否为 thinking 类型的 block
 */
function isThinkingBlock(type: ChunkType): boolean {
	return type === ChunkType.THINKING_START
		|| type === ChunkType.THINKING_DELTA
		|| type === ChunkType.THINKING_COMPLETE;
}

// ============ MessageBus 通信 ============

/**
 * 发布消息到IFrame
 */
function publishToIFrame(topic: string, data: unknown): void {
	try {
		eda.sys_MessageBus.publishPublic(topic, data);
	}
	catch {
		console.warn('发布消息失败:', topic);
	}
}

/**
 * 订阅MessageBus
 */
function subscribe(topic: string, handler: (data: any) => void | Promise<void>): void {
	const task = eda.sys_MessageBus.subscribePublic(topic, handler);
	subscriptions.push(task);
}

/**
 * 清理所有订阅
 */
function cleanupSubscriptions(): void {
	for (const sub of subscriptions) {
		try {
			sub.cancel();
		}
		catch {
			// ignore cleanup errors
		}
	}
	subscriptions.length = 0;
}
