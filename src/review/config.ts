import type { ConfigStore } from './types';
/**
 * AI原理图审查 - 配置管理
 *
 * 使用 eda.sys_Storage 持久化存储AI审查配置
 * 注意：扩展主上下文中 localStorage 不可用，必须使用 EDA 提供的存储 API
 */
import { AIProvider } from './types';

const CONFIG_KEY = 'ai-sch-review-config';
const HISTORY_KEY = 'ai-sch-chat-history';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: ConfigStore = {
	provider: AIProvider.OPENAI_COMPATIBLE,
	apiKey: '',
	model: 'gpt-4o',
	apiUrl: 'https://api.openai.com/v1/chat/completions',
	maxPinsPerChunk: 1200,
	timeout: 120,
	windowWidth: 960,
	windowHeight: 700,
	mcpEnabled: false,
	mcpGatewayUrl: '',
	mcpGatewayApiKey: '',
	mcpAutoApprove: true,
};

/**
 * 从 eda.sys_Storage 加载配置
 */
export function loadConfig(): ConfigStore {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
		if (!raw) {
			return { ...DEFAULT_CONFIG };
		}
		// raw 可能是对象或字符串
		const parsed = typeof raw === 'string' ? JSON.parse(raw) as Partial<ConfigStore> : raw as Partial<ConfigStore>;
		return { ...DEFAULT_CONFIG, ...parsed };
	}
	catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * 保存配置到 eda.sys_Storage
 */
export async function saveConfig(config: Partial<ConfigStore>): Promise<{ success: boolean; config: ConfigStore; error?: string }> {
	const current = loadConfig();
	const merged: ConfigStore = { ...current, ...config };
	try {
		const success = await eda.sys_Storage.setExtensionUserConfig(CONFIG_KEY, merged);
		if (!success) {
			return { success: false, config: current, error: '存储写入失败' };
		}
		// 返回实际保存的配置（从存储中重新读取）
		const saved = loadConfig();
		return { success: true, config: saved };
	}
	catch (e) {
		console.warn('保存配置失败:', e);
		return { success: false, config: current, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 校验配置是否可用于AI请求
 */
export function validateConfig(config: ConfigStore): string | null {
	if (!config.apiKey || config.apiKey.trim().length === 0) {
		return 'API Key未配置';
	}
	if (!config.model || config.model.trim().length === 0) {
		return 'Model未配置';
	}
	if (!config.apiUrl || config.apiUrl.trim().length === 0) {
		return 'API URL未配置';
	}

	// MCP 启用时验证 Gateway URL
	if (config.mcpEnabled) {
		if (!config.mcpGatewayUrl || config.mcpGatewayUrl.trim().length === 0) {
			return 'MCP Gateway URL未配置';
		}
		try {
			const gatewayUrl = new URL(config.mcpGatewayUrl);
			if (gatewayUrl.protocol !== 'http:' && gatewayUrl.protocol !== 'https:') {
				return 'MCP Gateway URL必须是http或https协议';
			}
		}
		catch {
			return 'MCP Gateway URL格式无效';
		}
	}

	return null;
}

/**
 * 加载对话历史记录
 */
export function loadChatHistory(): unknown[] {
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(HISTORY_KEY);
		if (!raw) {
			return [];
		}
		const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return Array.isArray(parsed) ? parsed : [];
	}
	catch {
		return [];
	}
}

/**
 * 保存对话历史记录
 */
export async function saveChatHistory(messages: unknown[]): Promise<{ success: boolean; error?: string }> {
	try {
		const success = await eda.sys_Storage.setExtensionUserConfig(HISTORY_KEY, messages);
		if (!success) {
			return { success: false, error: '存储写入失败' };
		}
		return { success: true };
	}
	catch (e) {
		console.warn('保存历史记录失败:', e);
		return { success: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 显示配置对话框
 */
export function showConfigDialog(): void {
	const config = loadConfig();

	// 使用简单的对话框提示用户配置
	eda.sys_Dialog.showInformationMessage(
		`当前配置：
Provider: ${config.provider}
Model: ${config.model}
API Key: ${config.apiKey ? '已配置' : '未配置'}

请在审查面板中点击"配置"按钮进行设置。`,
		'AI审查配置',
	);
}
