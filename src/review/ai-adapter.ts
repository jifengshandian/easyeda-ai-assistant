/**
 * AI原理图审查 - AI通信适配器
 *
 * 封装OpenAI兼容格式API通信，处理CORS、超时、重试
 */
import type { ConfigStore, SchReviewChunk } from './types';
import { buildSystemPrompt, buildUserPrompt } from './prompt-builder';
import { ErrorCode, ReviewError } from './types';

/**
 * AI响应接口
 */
interface AIResponse {
	must_fix: Array<{
		title: string;
		reason: string;
		impact: string;
		confidence: number;
		fix: string;
		evidence: {
			components?: string[];
			pins?: string[];
			nets?: string[];
			datasheet_urls?: string[];
		};
	}>;
	suggestions: Array<{
		title: string;
		reason: string;
		impact: string;
		confidence: number;
		fix: string;
		evidence: {
			components?: string[];
			pins?: string[];
			nets?: string[];
			datasheet_urls?: string[];
		};
	}>;
}

/**
 * 发送分块到AI进行审查
 */
export async function reviewChunkWithAI(
	chunk: SchReviewChunk,
	config: ConfigStore,
): Promise<AIResponse> {
	const systemPrompt = buildSystemPrompt();
	const userPrompt = buildUserPrompt(chunk);

	return await callOpenAICompatible(systemPrompt, userPrompt, config);
}

/**
 * 调用OpenAI兼容格式API
 */
async function callOpenAICompatible(
	systemPrompt: string,
	userPrompt: string,
	config: ConfigStore,
): Promise<AIResponse> {
	const url = config.apiUrl || 'https://api.openai.com/v1/chat/completions';

	const body = {
		model: config.model,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
		temperature: 0.3,
		response_format: { type: 'json_object' },
	};

	return await makeRequest(url, config.apiKey, body);
}

/**
 * 发送HTTP请求（带重试）
 */
async function makeRequest(
	url: string,
	apiKey: string,
	body: unknown,
): Promise<AIResponse> {
	const maxRetries = 3;
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const response = await eda.sys_ClientUrl.request(
				url,
				'POST',
				JSON.stringify(body),
				{
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${apiKey}`,
					},
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			const data = await response.json();
			return parseAIResponse(data);
		}
		catch (error) {
			// P1: ReviewError应该直接透传，不应该被重试逻辑吞掉
			if (error instanceof ReviewError) {
				throw error;
			}

			lastError = error instanceof Error ? error : new Error(String(error));

			// 判断错误类型
			if (lastError.message.includes('401') || lastError.message.includes('403')) {
				throw new ReviewError(
					ErrorCode.AI_AUTH_ERROR,
					'API Key无效或权限不足',
					lastError,
				);
			}

			if (lastError.message.includes('429')) {
				throw new ReviewError(
					ErrorCode.AI_RATE_LIMIT,
					'API请求频率超限',
					lastError,
				);
			}

			if (lastError.message.includes('CORS')) {
				throw new ReviewError(
					ErrorCode.AI_CORS_ERROR,
					'CORS错误，请检查API地址或使用代理',
					lastError,
				);
			}

			// 如果是最后一次尝试，抛出错误
			if (attempt === maxRetries) {
				throw new ReviewError(
					ErrorCode.AI_NETWORK_ERROR,
					`网络请求失败（已重试${maxRetries}次）: ${lastError.message}`,
					lastError,
				);
			}

			// 等待后重试
			await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
		}
	}

	throw new ReviewError(
		ErrorCode.AI_NETWORK_ERROR,
		'网络请求失败',
		lastError,
	);
}

/**
 * 解析AI响应
 */
function parseAIResponse(data: any): AIResponse {
	try {
		let contentText = '';

		// OpenAI兼容格式
		if (data.choices && data.choices[0]?.message?.content) {
			contentText = data.choices[0].message.content;
		}
		else {
			throw new Error('无法解析AI响应格式');
		}

		// 清理markdown code fence（如果存在）
		contentText = contentText.trim();
		if (contentText.startsWith('```json')) {
			contentText = contentText.replace(/^```json\s*/, '').replace(/```\s*$/, '');
		}
		else if (contentText.startsWith('```')) {
			contentText = contentText.replace(/^```\s*/, '').replace(/```\s*$/, '');
		}

		const content = JSON.parse(contentText);
		return normalizeResponse(content);
	}
	catch (error) {
		throw new ReviewError(
			ErrorCode.AI_INVALID_RESPONSE,
			`AI响应格式无效: ${error instanceof Error ? error.message : String(error)}`,
			data,
		);
	}
}

/**
 * 规范化响应格式
 */
function normalizeResponse(content: any): AIResponse {
	return {
		must_fix: Array.isArray(content.must_fix) ? content.must_fix : [],
		suggestions: Array.isArray(content.suggestions) ? content.suggestions : [],
	};
}
