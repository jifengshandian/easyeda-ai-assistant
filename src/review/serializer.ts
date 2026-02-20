/**
 * AI原理图审查 - 数据序列化模块
 *
 * 将CollectedData转换为SCH-REVIEW-COMPACT v1 tuple格式
 */
import type { CollectedData, SchReviewChunk } from './types';
import { ErrorCode, ReviewError } from './types';

/**
 * 序列化为紧凑格式
 */
export function serializeToCompactFormat(
	data: CollectedData,
	chunkId: string,
	chunkCount: number,
): SchReviewChunk {
	if (!data || !data.components || !data.pins || !data.nets) {
		throw new ReviewError(
			ErrorCode.SERIALIZE_INVALID_DATA,
			'数据格式无效',
		);
	}

	// 转换器件为tuple格式
	// [位号, 名称, 关键属性, 制造商, 制造商编号, X, Y, 旋转]
	const components = data.components.map(c => [
		c.designator,
		c.name,
		c.value,
		c.manufacturer,
		c.manufacturerPartNumber,
		c.x,
		c.y,
		c.rotation,
	] as [string, string, string, string, string, number, number, number]);

	// 转换引脚为tuple格式
	// [位号, 引脚编号, 引脚名称, 引脚类型, 网络名称]
	const pins = data.pins.map(p => [
		p.componentDesignator,
		p.pinNumber,
		p.pinName,
		p.pinType,
		p.netName,
	] as [string, string, string, string, string | null]);

	// 转换网络为tuple格式
	// [网络名称, 连接引脚数]
	const nets = data.nets.map(n => [
		n.netName,
		n.pinCount,
	] as [string, number]);

	return {
		schema: 'sch-review-compact-v1',
		summary: {
			totalComponents: data.components.length,
			totalPins: data.pins.length,
			totalNets: data.nets.length,
			chunkId,
			chunkCount,
		},
		components,
		pins,
		nets,
	};
}

/**
 * 估算序列化后的JSON字节大小（UTF-8编码）
 */
export function estimateJsonSize(chunk: SchReviewChunk): number {
	try {
		const json = JSON.stringify(chunk);
		// 使用TextEncoder计算UTF-8字节数
		const encoder = new TextEncoder();
		return encoder.encode(json).length;
	}
	catch {
		return 0;
	}
}
