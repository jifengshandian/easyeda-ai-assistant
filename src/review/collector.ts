/**
 * AI原理图审查 - 数据采集模块
 *
 * 从EDA API采集器件、引脚、导线、网络标记等数据
 */
import type { CollectedData, CollectionMeta, RawBus, RawComponent, RawNet, RawPin, RawText } from './types';
import { ErrorCode, ReviewError } from './types';

/**
 * 日志发送函数（通过 MessageBus 发送到前端）
 */
let logToIFrame: ((level: string, message: string, data?: any) => void) | null = null;

export function setLogToIFrame(fn: (level: string, message: string, data?: any) => void): void {
	logToIFrame = fn;
}

function log(level: string, message: string, data?: any): void {
	console.warn(`[${level.toUpperCase()}] ${message}`, data || '');
	if (logToIFrame) {
		logToIFrame(level, message, data);
	}
}

/**
 * 文本/总线采集选项
 */
interface CollectTextAndBusOptions {
	/** 当前采集页 UUID（逐页采集时填充） */
	schematicPageUuid?: string;
}

/**
 * 并发控制：限制同时执行的Promise数量
 */
async function promiseAllWithLimit<T>(
	tasks: Array<() => Promise<T>>,
	limit: number,
): Promise<T[]> {
	// 参数守卫
	if (limit < 1) {
		throw new Error('promiseAllWithLimit: limit must be >= 1');
	}
	if (tasks.length === 0) {
		return [];
	}

	const results: T[] = Array.from({ length: tasks.length });
	let index = 0;

	async function worker(): Promise<void> {
		while (index < tasks.length) {
			const currentIndex = index++;
			results[currentIndex] = await tasks[currentIndex]();
		}
	}

	const workers = Array.from(
		{ length: Math.min(limit, tasks.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}

/**
 * 采集原理图数据（完全逐页采集策略）
 *
 * 性能优化要点：
 * 1. 所有元素（Component/Wire/Text/Bus/Pin/NetLabel）均逐页采集（避免跨页 ID 失效）
 * 2. 每页内先采集 Wire+NetLabel，再采集 Component+Pin（Pin 需要 Wire+NetLabel 数据做网络绑定）
 * 3. 减少每个图元的属性获取次数
 */
export async function collectSchematicData(): Promise<CollectedData> {
	const startTime = Date.now();
	log('info', '[采集] 开始采集原理图数据...');

	// 检查是否有打开的原理图文档
	const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!docInfo || docInfo.documentType !== 1) { // EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1
		throw new ReviewError(
			ErrorCode.COLLECT_NO_DOCUMENT,
			'没有打开的原理图文档',
		);
	}

	const originalTabId = docInfo.tabId;
	const meta: CollectionMeta = {
		mode: 'per-page-hybrid',
		quality: 'full',
		expectedPageCount: 0,
		collectedPageCount: 0,
		collectedPageUuids: [],
		missingPageUuids: [],
	};

	try {
		// 获取当前原理图下的全部图页信息
		const pages = await eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo();
		meta.expectedPageCount = pages.length;
		log('info', `[采集] 检测到 ${pages.length} 个图页`);

		// 先采集网表（全局数据，无需逐页）
		const t0 = Date.now();
		const netlistRaw = await collectNetlist();
		log('info', `[采集] 网表采集完成 (耗时 ${Date.now() - t0}ms)`);

		// 解析网表构建 pin-net 映射（全局）
		const netlistMap = parseNetlist(netlistRaw);

		// 逐页采集所有元素（Component/Wire/Text/Bus/Pin/NetLabel）
		let components: RawComponent[] = [];
		let pins: RawPin[] = [];
		let allValidWires: Array<{ net: string; lines: number[][] }> = [];
		let allEmptyWires: Array<{ lines: number[][] }> = [];
		let texts: RawText[] = [];
		let buses: RawBus[] = [];
		let netLabels: RawNetLabel[] = [];

		if (pages.length === 1) {
			// 单页场景：无需切换
			const t1 = Date.now();
			const [wireData, pageTexts, pageBuses, pageNetLabels] = await Promise.all([
				collectWires(),
				collectTexts({ schematicPageUuid: pages[0].uuid }),
				collectBuses({ schematicPageUuid: pages[0].uuid }),
				collectNetLabels({ schematicPageUuid: pages[0].uuid }),
			]);

			allValidWires = wireData.validWires;
			allEmptyWires = wireData.emptyWires;

			// 采集器件+引脚（需要 Wire+NetLabel 数据）
			const { components: pageComponents, pins: pagePins } = await collectComponentsAndPins({
				schematicPageUuid: pages[0].uuid,
				netlistMap,
				wireData,
				netLabels: pageNetLabels,
			});

			components = pageComponents;
			pins = pagePins;
			texts = pageTexts;
			buses = pageBuses;
			netLabels = pageNetLabels;

			log('info', `[采集] 单页数据采集完成: ${components.length} 器件, ${pins.length} 引脚, ${allValidWires.length + allEmptyWires.length} 导线, ${texts.length} 文本, ${buses.length} 总线, ${netLabels.length} 网络标记 (耗时 ${Date.now() - t1}ms)`);
			meta.collectedPageUuids = [pages[0].uuid];
			meta.collectedPageCount = 1;
		}
		else {
			// 多页场景：逐页切换采集
			log('info', `[采集] 开始逐页采集所有元素...`);
			const t1 = Date.now();
			for (let i = 0; i < pages.length; i++) {
				const page = pages[i];
				const pageStartTime = Date.now();
				try {
					// 打开并激活页面
					const pageTabId = await eda.dmt_EditorControl.openDocument(page.uuid);
					if (!pageTabId) {
						log('warn', `[采集] 无法打开图页 ${i + 1}/${pages.length}: ${page.name}`);
						meta.missingPageUuids.push(page.uuid);
						continue;
					}

					await eda.dmt_EditorControl.activateDocument(pageTabId);

					// 先采集 Wire/Text/Bus/NetLabel
					const [wireData, pageTexts, pageBuses, pageNetLabels] = await Promise.all([
						collectWires(),
						collectTexts({ schematicPageUuid: page.uuid }),
						collectBuses({ schematicPageUuid: page.uuid }),
						collectNetLabels({ schematicPageUuid: page.uuid }),
					]);

					allValidWires.push(...wireData.validWires);
					allEmptyWires.push(...wireData.emptyWires);

					// 再采集器件+引脚（需要 Wire+NetLabel 数据做网络绑定）
					const { components: pageComponents, pins: pagePins } = await collectComponentsAndPins({
						schematicPageUuid: page.uuid,
						netlistMap,
						wireData,
						netLabels: pageNetLabels,
					});

					components.push(...pageComponents);
					pins.push(...pagePins);
					texts.push(...pageTexts);
					buses.push(...pageBuses);
					netLabels.push(...pageNetLabels);
					meta.collectedPageUuids.push(page.uuid);
					log('info', `[采集] 图页 ${i + 1}/${pages.length} (${page.name}): ${pageComponents.length} 器件, ${pagePins.length} 引脚, ${wireData.validWires.length + wireData.emptyWires.length} 导线, ${pageTexts.length} 文本, ${pageBuses.length} 总线, ${pageNetLabels.length} 网络标记 (耗时 ${Date.now() - pageStartTime}ms)`);
				}
				catch (pageError) {
					log('error', `[采集] 采集图页失败 ${i + 1}/${pages.length} (${page.name})`, pageError);
					meta.missingPageUuids.push(page.uuid);
				}
			}
			log('info', `[采集] 逐页采集完成: 总计 ${components.length} 器件, ${pins.length} 引脚, ${allValidWires.length + allEmptyWires.length} 导线, ${texts.length} 文本, ${buses.length} 总线, ${netLabels.length} 网络标记 (总耗时 ${Date.now() - t1}ms)`);

			meta.collectedPageCount = meta.collectedPageUuids.length;
			if (meta.missingPageUuids.length > 0) {
				meta.quality = 'partial';
			}
		}

		// 检查数据完整性
		if (components.length === 0 && allValidWires.length === 0) {
			meta.quality = 'stale';
		}

		// 恢复用户原始焦点页
		try {
			await eda.dmt_EditorControl.activateDocument(originalTabId);
		}
		catch (restoreError) {
			console.warn('[采集] 恢复原始文档焦点失败:', restoreError);
		}

		// 统计网络
		const nets = buildNetStatistics(pins);

		// 统计元件属性获取情况
		const stats = {
			total: components.length,
			withValue: components.filter(c => c.value).length,
			withPrefix: components.filter(c => c.prefix).length,
			withAddIntoPcb: components.filter(c => c.addIntoPcb).length,
			withLcscPart: components.filter(c => c.lcscPart).length,
			withJlcPart: components.filter(c => c.jlcPart).length,
			withBomInclude: components.filter(c => c.bomInclude).length,
			withManufacturer: components.filter(c => c.manufacturer).length,
			withManufacturerPartNumber: components.filter(c => c.manufacturerPartNumber).length,
		};

		log('info', `[采集] 元件属性统计`, {
			总元件数: stats.total,
			有Value: `${stats.withValue}/${stats.total} (${(stats.withValue / stats.total * 100).toFixed(1)}%)`,
			有Prefix: `${stats.withPrefix}/${stats.total} (${(stats.withPrefix / stats.total * 100).toFixed(1)}%)`,
			有AddIntoPcb: `${stats.withAddIntoPcb}/${stats.total} (${(stats.withAddIntoPcb / stats.total * 100).toFixed(1)}%)`,
			有LcscPart: `${stats.withLcscPart}/${stats.total} (${(stats.withLcscPart / stats.total * 100).toFixed(1)}%)`,
			有JlcPart: `${stats.withJlcPart}/${stats.total} (${(stats.withJlcPart / stats.total * 100).toFixed(1)}%)`,
			有BomInclude: `${stats.withBomInclude}/${stats.total} (${(stats.withBomInclude / stats.total * 100).toFixed(1)}%)`,
			有Manufacturer: `${stats.withManufacturer}/${stats.total} (${(stats.withManufacturer / stats.total * 100).toFixed(1)}%)`,
			有ManufacturerPartNumber: `${stats.withManufacturerPartNumber}/${stats.total} (${(stats.withManufacturerPartNumber / stats.total * 100).toFixed(1)}%)`,
		});

		// 显示第一个有 Value 的元件作为示例
		const sampleWithValue = components.find(c => c.value);
		if (sampleWithValue) {
			log('info', `[采集] 元件属性示例 (${sampleWithValue.designator})`, {
				Value: sampleWithValue.value || '(空)',
				Prefix: sampleWithValue.prefix || '(空)',
				AddIntoPcb: sampleWithValue.addIntoPcb || '(空)',
				LcscPart: sampleWithValue.lcscPart || '(空)',
				JlcPart: sampleWithValue.jlcPart || '(空)',
				BomInclude: sampleWithValue.bomInclude || '(空)',
			});
		}

		const totalTime = Date.now() - startTime;
		log('success', `[采集] 采集完成: ${components.length} 器件, ${pins.length} 引脚, ${nets.length} 网络, ${netLabels.length} 网络标记 (总耗时 ${totalTime}ms)`);

		return {
			components,
			pins,
			nets,
			texts,
			buses,
			netLabels,
			netlistRaw,
			timestamp: Date.now(),
			meta,
		};
	}
	catch (error) {
		// 确保恢复原始焦点页
		try {
			await eda.dmt_EditorControl.activateDocument(originalTabId);
		}
		catch {
			// ignore
		}

		console.error('[采集] 采集失败:', error);
		throw new ReviewError(
			ErrorCode.COLLECT_API_FAILED,
			`数据采集失败: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * 采集当前页的器件及其引脚（统一采集，避免跨页 ID 失效）
 *
 * 在同一个页面上下文中完成：
 * 1. 获取器件列表 → 分离 netflag/netport 和普通器件
 * 2. 获取普通器件的详细信息和引脚
 * 3. 绑定网络（L1:网表 → L2:导线坐标 → L3:网络标记坐标 → L4:导线拓扑）
 */
async function collectComponentsAndPins(options: {
	schematicPageUuid?: string;
	netlistMap: Map<string, string>;
	wireData: WireData;
	netLabels: RawNetLabel[];
}): Promise<{ components: RawComponent[]; pins: RawPin[] }> {
	const { schematicPageUuid, netlistMap, wireData, netLabels } = options;

	// 调试：函数入口日志（必定触发）
	log('info', `[采集] ========== 开始采集器件和引脚 ==========`, {
		时间戳: new Date().toISOString(),
		页面UUID: schematicPageUuid || '(单页模式)',
		网表映射数: netlistMap.size,
		有效导线数: wireData.validWires.length,
		空导线数: wireData.emptyWires.length,
		网络标记数: netLabels.length,
	});

	// 构建导线拓扑图（L4 策略）
	const wireClusters = buildWireTopology(wireData.validWires, wireData.emptyWires, netLabels);

	// 获取当前页的所有器件（allSchematicPages=false）
	const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

	// 第一阶段：仅获取 componentType 进行分类
	const filterTasks = primitives.map(primitive => async () => ({
		primitive,
		componentType: await primitive.getState_ComponentType(),
	}));
	const filtered = await promiseAllWithLimit(filterTasks, 100);

	// 过滤掉网络标记类器件（NET_FLAG/NET_PORT）— 它们已在 collectNetLabels() 中单独采集
	const validPrimitives = filtered.filter(
		item => item.componentType !== 'netflag' && item.componentType !== 'netport',
	);

	// 调试：输出器件采集统计
	log('info', `[采集] 器件采集统计`, {
		总器件数: primitives.length,
		过滤后: filtered.length,
		有效器件数: validPrimitives.length,
		网络标记数: filtered.length - validPrimitives.length,
	});

	// 第二阶段：获取器件详细信息 + 引脚
	const allComponents: RawComponent[] = [];
	const allPins: RawPin[] = [];

	const componentTasks = validPrimitives.map(({ primitive }, index) => async () => {
		// 调试：检查 primitive 对象的可用方法（仅第一个元件）
		if (index === 0) {
			try {
				const protoMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(primitive))
					.filter(m => m.startsWith('getState'))
					.slice(0, 30);

				log('info', `[采集] 检查 primitive 对象 (第一个元件)`, {
					primitiveType: typeof primitive,
					hasGetStateValue: typeof primitive.getState_Value === 'function',
					hasGetStatePrefix: typeof primitive.getState_Prefix === 'function',
					hasGetStateManufacturer: typeof primitive.getState_Manufacturer === 'function',
					hasGetStateLcscPart: typeof primitive.getState_LcscPart === 'function',
					hasGetStateDesignator: typeof primitive.getState_Designator === 'function',
					hasGetStateName: typeof primitive.getState_Name === 'function',
					availableMethodsCount: protoMethods.length,
					availableMethods: protoMethods.join(', '),
				});
			}
			catch (debugError) {
				log('error', `[采集] 检查 primitive 对象失败`, {
					error: debugError instanceof Error ? debugError.message : String(debugError),
				});
			}
		}

		// 并行获取器件基本信息 + 引脚列表
		let primitiveId = '';
		let designator = '';
		let name = '';
		let x = 0;
		let y = 0;
		let rotation = 0;
		let pinPrimitives: any[] = [];

		try {
			[primitiveId, designator, name, x, y, rotation, pinPrimitives] = await Promise.all([
				primitive.getState_PrimitiveId(),
				primitive.getState_Designator(),
				primitive.getState_Name(),
				primitive.getState_X(),
				primitive.getState_Y(),
				primitive.getState_Rotation(),
				eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(
					await primitive.getState_PrimitiveId(),
				),
			]);
		}
		catch (basicError) {
			log('error', `[采集] 获取基本信息失败`, {
				error: basicError instanceof Error ? basicError.message : String(basicError),
				errorStack: basicError instanceof Error ? basicError.stack?.substring(0, 500) : undefined,
			});
			// 基本信息获取失败，跳过这个元件
			return { component: null, pins: [] };
		}

		// 制造商信息和关键属性（可选）
		let manufacturer = '';
		let manufacturerPartNumber = '';
		let value = '';
		let prefix = '';
		let addIntoPcb = '';
		let lcscPart = '';
		let jlcPart = '';
		let bomInclude = '';

		try {
			const [mfr, mpn, val, pfx, aip, lcsc, jlc, bom] = await Promise.all([
				primitive.getState_Manufacturer(),
				primitive.getState_ManufacturerId(),
				primitive.getState_Value(),
				primitive.getState_Prefix(),
				primitive.getState_AddIntoPcb(),
				primitive.getState_LcscPart(),
				primitive.getState_JlcPart(),
				primitive.getState_BomInclude(),
			]);
			manufacturer = mfr || '';
			manufacturerPartNumber = mpn || '';
			value = val || '';
			prefix = pfx || '';
			addIntoPcb = aip || '';
			lcscPart = lcsc || '';
			jlcPart = jlc || '';
			bomInclude = bom || '';

			// 调试日志：记录第一个元件的属性获取情况（避免日志过多）
			if (allComponents.length === 0) {
				log('info', `[采集] 元件属性获取示例 (${designator})`, {
					hasValue: !!value,
					hasPrefix: !!prefix,
					hasAddIntoPcb: !!addIntoPcb,
					hasLcscPart: !!lcscPart,
					hasJlcPart: !!jlcPart,
					hasBomInclude: !!bomInclude,
					hasManufacturer: !!manufacturer,
					hasManufacturerPartNumber: !!manufacturerPartNumber,
					valuePreview: value ? value.substring(0, 20) : '(空)',
					prefixPreview: prefix || '(空)',
				});
			}
		}
		catch (error) {
			// 某些器件可能没有这些属性
			log('warn', `[采集] 获取元件属性失败 (${designator})`, {
				error: error instanceof Error ? error.message : String(error),
				errorStack: error instanceof Error ? error.stack?.substring(0, 500) : undefined,
			});
		}

		const component: RawComponent = {
			primitiveId,
			designator: designator || '',
			name: name || '',
			value,
			prefix,
			addIntoPcb,
			lcscPart,
			jlcPart,
			bomInclude,
			manufacturer,
			manufacturerPartNumber,
			x,
			y,
			rotation: rotation || 0,
			schematicPageUuid,
		};

		// 采集该器件的引脚
		const componentPins: RawPin[] = [];
		if (pinPrimitives && pinPrimitives.length > 0) {
			const pinTasks = pinPrimitives.map(pinPrimitive => async () => {
				const [
					pinPrimitiveId,
					pinNumber,
					pinName,
					electricalType,
					pinX,
					pinY,
				] = await Promise.all([
					pinPrimitive.getState_PrimitiveId(),
					pinPrimitive.getState_PinNumber(),
					pinPrimitive.getState_PinName(),
					pinPrimitive.getState_pinType(),
					pinPrimitive.getState_X(),
					pinPrimitive.getState_Y(),
				]);

				const pinKey = `${component.designator}_${pinNumber}`;

				// L1: 只使用网表映射（保守模式）
				// 禁用 L2/L3/L4 策略以避免假阳性（将 NC 引脚错误绑定到附近的导线）
				const netName: string | null = netlistMap.get(pinKey) || null;
				const confidence = netName ? 1.0 : 0;
				const reason = netName ? 'netlist' : 'unresolved';
				const debugInfo: any = {
					pin: pinKey,
					coord: `(${pinX}, ${pinY})`,
					L1_netlist: netName || 'miss',
				};

				// L2/L3/L4 策略已禁用（保守模式）
				// 原因：避免将 NC（悬空）引脚错误绑定到物理上接近但实际未连接的导线
				// 如果引脚不在网表中，则标记为未绑定（netName = null）
				//
				// 如需启用混合模式，取消以下注释：
				/*
				// L2: 如果网表未解析，尝试通过导线坐标匹配
				if (!netName) {
					const wireNet = _findNetByWireProximity(pinX, pinY, wireData.validWires);
					debugInfo.L2_wire = wireNet || 'miss';
					if (wireNet) {
						netName = wireNet;
						confidence = 0.8;
						reason = 'wire';
					}
				}

				// L3: 如果导线也没匹配到，尝试通过网络标记坐标匹配
				if (!netName) {
					const labelNet = _findNetByLabelProximity(pinX, pinY, netLabels);
					debugInfo.L3_netlabel = labelNet || 'miss';
					if (labelNet) {
						netName = labelNet;
						confidence = 0.7;
						reason = 'netlabel';
					}
				}

				// L4: 如果前三层都失败，尝试通过导线拓扑推断
				if (!netName) {
					const topologyResult = _findNetByWireTopology(pinX, pinY, wireClusters);
					debugInfo.L4_topology = topologyResult?.netName || 'miss';
					if (topologyResult) {
						netName = topologyResult.netName;
						confidence = topologyResult.confidence;
						reason = 'topology';
					}
				}
				*/

				// 输出未绑定引脚的调试信息（附带最近邻距离以诊断容差问题）
				if (!netName) {
					const nearestWire = findNearestWireDistance(pinX, pinY, wireData.validWires, wireData.emptyWires);
					const nearestLabel = findNearestLabelDistance(pinX, pinY, netLabels);
					const nearestTopo = findNearestTopoDistance(pinX, pinY, wireClusters);
					debugInfo.nearest = {
						wire: nearestWire ? `${nearestWire.distance.toFixed(1)}(${nearestWire.net || 'empty'})` : 'none',
						label: nearestLabel ? `${nearestLabel.distance.toFixed(1)}(${nearestLabel.net})` : 'none',
						topo: nearestTopo ? `${nearestTopo.distance.toFixed(1)}` : 'none',
					};

					if (electricalType === 'Power' || electricalType === 'Ground') {
						log('warn', `[Pin-Net] 电源/地引脚未绑定`, debugInfo);
					}
					else {
						log('debug', `[Pin-Net] 引脚未绑定`, debugInfo);
					}
				}

				return {
					primitiveId: pinPrimitiveId,
					componentPrimitiveId: component.primitiveId,
					componentDesignator: component.designator,
					pinNumber: pinNumber || '',
					pinName: pinName || '',
					pinType: electricalType || 'Passive',
					netName,
					netBindingConfidence: confidence,
					netBindingReason: reason,
				} as RawPin;
			});

			const pinResults = await promiseAllWithLimit(pinTasks, 50);
			componentPins.push(...pinResults);
		}

		return { component, pins: componentPins };
	});

	const results = await promiseAllWithLimit(componentTasks, 30);
	for (const result of results) {
		if (result.component === null)
			continue; // 基本信息获取失败的元件跳过
		allComponents.push(result.component);
		allPins.push(...result.pins);
	}

	return { components: allComponents, pins: allPins };
}

/**
 * 后台网表获取状态（用于延迟回填）
 */
interface BackgroundNetlistState {
	promise: Promise<string | undefined>;
	startTime: number;
	completed: boolean;
	result?: string;
	duration?: number;
}

let backgroundNetlistState: BackgroundNetlistState | null = null;

/**
 * 采集网表（带超时保护 + 后台继续获取）
 *
 * 策略：
 * 1. 启动网表获取，设置 10 秒超时
 * 2. 如果超时，返回 undefined 让主流程继续（使用 L2/L3/L4）
 * 3. 但网表获取在后台继续运行，记录实际耗时
 * 4. 如果最终成功，通过 orchestrator 触发重新绑定
 */
async function collectNetlist(): Promise<string | undefined> {
	try {
		const NETLIST_TIMEOUT_MS = 10000; // 10秒超时（主流程）
		const startTime = Date.now();
		log('info', `[采集] 开始获取网表...`);

		// 使用 PROTEL2 格式（实际返回 PROTEL NETLIST 2.0 格式）
		const netlistPromise = eda.sch_Netlist.getNetlist(ESYS_NetlistType.PROTEL2);

		// 保存到全局状态，供后续查询
		backgroundNetlistState = {
			promise: netlistPromise.then(
				(result) => {
					const duration = Date.now() - startTime;
					if (backgroundNetlistState) {
						backgroundNetlistState.completed = true;
						backgroundNetlistState.result = result;
						backgroundNetlistState.duration = duration;
					}
					log('success', `[采集] 网表后台获取成功 (耗时 ${duration}ms, 大小: ${result.length} 字符)`);
					return result;
				},
				(error) => {
					const duration = Date.now() - startTime;
					if (backgroundNetlistState) {
						backgroundNetlistState.completed = true;
						backgroundNetlistState.duration = duration;
					}
					log('error', `[采集] 网表后台获取失败 (耗时 ${duration}ms): ${error instanceof Error ? error.message : String(error)}`);
					return undefined;
				},
			),
			startTime,
			completed: false,
		};

		// 主流程等待超时
		const result = await Promise.race([
			netlistPromise,
			new Promise<undefined>((resolve) => {
				setTimeout(() => resolve(undefined), NETLIST_TIMEOUT_MS);
			}),
		]);

		if (result === undefined) {
			log('warn', `[采集] 网表获取超时 (${NETLIST_TIMEOUT_MS}ms)，跳过网表绑定（后台继续获取中...）`);
		}
		else {
			log('info', `[采集] 网表格式: Protel2, 大小: ${result.length} 字符 (耗时 ${Date.now() - startTime}ms)`);
		}

		return result;
	}
	catch (error) {
		log('error', `[采集] 网表获取异常: ${error instanceof Error ? error.message : String(error)}`);
		console.error('[采集] 网表获取异常详情:', error);
		return undefined;
	}
}

/**
 * 获取后台网表状态（供外部查询）
 */
export function getBackgroundNetlistState(): BackgroundNetlistState | null {
	return backgroundNetlistState;
}

/**
 * 清除后台网表状态
 */
export function clearBackgroundNetlistState(): void {
	backgroundNetlistState = null;
}

/**
 * 导线数据结构（包含有 net 和无 net 的导线）
 */
interface WireData {
	validWires: Array<{ net: string; lines: number[][] }>;
	emptyWires: Array<{ lines: number[][] }>;
}

/**
 * 采集导线（包括 net 为空的导线，用于拓扑分析）
 */
async function collectWires(): Promise<WireData> {
	const wirePrimitives = await eda.sch_PrimitiveWire.getAll();

	let emptyNetCount = 0;

	const wireTasks = wirePrimitives.map(wire => async () => {
		const [net, line] = await Promise.all([
			wire.getState_Net(),
			wire.getState_Line(),
		]);

		if (!line) {
			return null;
		}

		// 规范化line为二维数组
		const lines = Array.isArray(line[0]) ? line as number[][] : [line as number[]];

		if (!net) {
			emptyNetCount++;
			return { type: 'empty' as const, lines };
		}

		return { type: 'valid' as const, net, lines };
	});

	const results = await promiseAllWithLimit(wireTasks, 50);
	const validWires: Array<{ net: string; lines: number[][] }> = [];
	const emptyWires: Array<{ lines: number[][] }> = [];

	for (const result of results) {
		if (!result)
			continue;
		if (result.type === 'valid') {
			validWires.push({ net: result.net, lines: result.lines });
		}
		else {
			emptyWires.push({ lines: result.lines });
		}
	}

	// 输出导线采集统计
	log('info', `[采集] 导线统计: 总数=${wirePrimitives.length}, 有效=${validWires.length}, net为空=${emptyNetCount}`);

	return { validWires, emptyWires };
}

/**
 * 采集文本标注
 * 失败时降级为空数组，不阻塞主流程
 */
async function collectTexts(
	options: CollectTextAndBusOptions = {},
): Promise<RawText[]> {
	const { schematicPageUuid } = options;

	try {
		const textPrimitives = await eda.sch_PrimitiveText.getAll();

		const textTasks = textPrimitives.map(textPrimitive => async () => {
			try {
				const [primitiveId, content, x, y] = await Promise.all([
					textPrimitive.getState_PrimitiveId(),
					textPrimitive.getState_Content(),
					textPrimitive.getState_X(),
					textPrimitive.getState_Y(),
				]);

				return {
					primitiveId,
					content: content || '',
					x,
					y,
					schematicPageUuid,
				} as RawText;
			}
			catch (textError) {
				console.warn('采集单个文本图元失败:', textError);
				return null;
			}
		});

		const results = await promiseAllWithLimit(textTasks, 50);
		return results.filter((item): item is RawText => item !== null);
	}
	catch (error) {
		console.warn('采集文本标注失败，已降级为空数组:', error);
		return [];
	}
}

/**
 * 采集总线
 * 失败时降级为空数组，不阻塞主流程
 */
async function collectBuses(
	options: CollectTextAndBusOptions = {},
): Promise<RawBus[]> {
	const { schematicPageUuid } = options;

	try {
		const busPrimitives = await eda.sch_PrimitiveBus.getAll();

		const busTasks = busPrimitives.map(busPrimitive => async () => {
			try {
				const [primitiveId, busName, line] = await Promise.all([
					busPrimitive.getState_PrimitiveId(),
					busPrimitive.getState_BusName(),
					busPrimitive.getState_Line(),
				]);

				if (!line) {
					return null;
				}

				// 规范化 line 为二维数组
				const lines = Array.isArray(line[0])
					? line as number[][]
					: [line as number[]];

				return {
					primitiveId,
					busName: busName || '',
					lines,
					schematicPageUuid,
				} as RawBus;
			}
			catch (busError) {
				console.warn('采集单个总线图元失败:', busError);
				return null;
			}
		});

		const results = await promiseAllWithLimit(busTasks, 50);
		return results.filter((item): item is RawBus => item !== null);
	}
	catch (error) {
		console.warn('采集总线失败，已降级为空数组:', error);
		return [];
	}
}

/**
 * 采集网络标记（GND、VCC 等标签）
 * 失败时降级为空数组，不阻塞主流程
 */
async function collectNetLabels(
	options: CollectTextAndBusOptions = {},
): Promise<RawNetLabel[]> {
	const { schematicPageUuid } = options;

	try {
		// 获取当前页的所有器件
		const primitives = await eda.sch_PrimitiveComponent.getAll(undefined, false);

		// 第一阶段：仅获取 componentType 进行过滤
		const filterTasks = primitives.map(primitive => async () => ({
			primitive,
			componentType: await primitive.getState_ComponentType(),
		}));
		const filtered = await promiseAllWithLimit(filterTasks, 100);

		// 只保留网络标记类器件（NET_FLAG/NET_PORT）
		const netLabelPrimitives = filtered.filter(
			item => item.componentType === 'netflag' || item.componentType === 'netport',
		);

		// 第二阶段：获取网络标记的详细信息
		const netLabelTasks = netLabelPrimitives.map(({ primitive, componentType }) => async () => {
			try {
				const [primitiveId, designator, x, y] = await Promise.all([
					primitive.getState_PrimitiveId(),
					primitive.getState_Designator(),
					primitive.getState_X(),
					primitive.getState_Y(),
				]);

				// 网络标记的 designator 就是网络名称（如 "GND", "VCC_3V3"）
				return {
					primitiveId,
					netName: designator || '',
					x,
					y,
					type: componentType as 'netflag' | 'netport',
					schematicPageUuid,
				} as RawNetLabel;
			}
			catch (labelError) {
				console.warn('采集单个网络标记失败:', labelError);
				return null;
			}
		});

		const results = await promiseAllWithLimit(netLabelTasks, 50);
		return results.filter((item): item is RawNetLabel => item !== null);
	}
	catch (error) {
		console.warn('采集网络标记失败，已降级为空数组:', error);
		return [];
	}
}

/**
 * 解析网表字符串（支持 JLCEDA_PRO 和 Protel2 格式）
 */
export function parseNetlist(netlistRaw: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!netlistRaw)
		return map;

	try {
		// 诊断日志：显示网表前500字符和末尾500字符
		const preview = netlistRaw.substring(0, 500).replace(/\n/g, '\\n');
		log('info', `[采集] 网表预览 (前500字符): ${preview}`);
		if (netlistRaw.length > 1000) {
			const tail = netlistRaw.substring(netlistRaw.length - 500).replace(/\n/g, '\\n');
			log('info', `[采集] 网表预览 (末500字符): ${tail}`);
		}

		// 策略1：JLCEDA_PRO 格式（关键字 "NET:"）
		if (netlistRaw.includes('NET:')) {
			parseNetlistJlcedaPro(netlistRaw, map);
		}

		// 策略2：PROTEL NETLIST 2.0 格式（方括号器件 + 圆括号网络）
		if (map.size === 0 && netlistRaw.startsWith('PROTEL NETLIST 2.0')) {
			parseNetlistProtel2V2(netlistRaw, map);
		}

		// 策略3：Protel2 标准格式（关键字 "Net List" 或 "Component List"）
		if (map.size === 0 && (netlistRaw.includes('Net List') || netlistRaw.includes('Component List'))) {
			parseNetlistProtel2Standard(netlistRaw, map);
		}

		// 策略4：通用 Designator-Pin 格式（使用正则全局匹配）
		if (map.size === 0) {
			parseNetlistGeneric(netlistRaw, map);
		}

		log('info', `[采集] 网表解析完成: ${map.size} 个 pin-net 映射`);
	}
	catch (error) {
		log('warn', `[采集] 网表解析失败: ${error instanceof Error ? error.message : String(error)}`);
	}

	return map;
}

/**
 * 解析 JLCEDA_PRO 格式网表
 *
 * 格式：
 * NET: VCC_3V3
 *   U1-1
 *   C1-1
 */
function parseNetlistJlcedaPro(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let currentNet = '';

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('NET:')) {
			currentNet = trimmed.substring(4).trim();
		}
		else if (currentNet && trimmed.includes('-')) {
			const dashIdx = trimmed.indexOf('-');
			const designator = trimmed.substring(0, dashIdx).trim();
			const pinNumber = trimmed.substring(dashIdx + 1).trim();
			if (designator && pinNumber && /^[A-Z]/.test(designator)) {
				map.set(`${designator}_${pinNumber}`, currentNet);
			}
		}
	}
}

/**
 * 解析 PROTEL NETLIST 2.0 格式网表
 *
 * 格式特征：
 * - 第一行: "PROTEL NETLIST 2.0"
 * - Component 部分: 方括号 [...] 包裹，含 DESIGNATOR/FOOTPRINT/PARTTYPE 等
 * - Net 部分: 圆括号 (...) 包裹，含网络名和 Designator-Pin 连接
 *
 * 示例：
 * PROTEL NETLIST 2.0
 * [
 * DESIGNATOR
 * U1
 * FOOTPRINT
 * LQFP-48
 * ...
 * ]
 * (
 * GND
 * U1-14
 * C1-2
 * )
 * (
 * VCC_3V3
 * U1-1
 * C1-1
 * )
 */
function parseNetlistProtel2V2(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let inNetSection = false;
	let currentNet = '';
	let justOpenedParen = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed)
			continue;

		// 圆括号开始：标志 Net 部分的一个网络块
		if (trimmed === '(') {
			inNetSection = true;
			justOpenedParen = true;
			currentNet = '';
			continue;
		}

		// 圆括号结束：当前网络块结束
		if (trimmed === ')') {
			inNetSection = false;
			currentNet = '';
			justOpenedParen = false;
			continue;
		}

		// 方括号开始/结束：Component 部分（跳过）
		if (trimmed === '[' || trimmed === ']') {
			inNetSection = false;
			justOpenedParen = false;
			continue;
		}

		if (inNetSection) {
			// 圆括号后的第一个非空行是网络名
			if (justOpenedParen) {
				currentNet = trimmed;
				justOpenedParen = false;
				continue;
			}

			// 后续行是 Designator-Pin 连接
			// 格式：U4-18 RTL8723模组-CHIP_EN Input
			// 需要提取：Designator=U4, PinNumber=18（只取第一个空格前的部分）
			if (currentNet) {
				const dashIdx = trimmed.indexOf('-');
				if (dashIdx > 0) {
					const designator = trimmed.substring(0, dashIdx);
					const afterDash = trimmed.substring(dashIdx + 1);
					// 只取第一个空格之前的部分作为 pinNumber
					const spaceIdx = afterDash.indexOf(' ');
					const pinNumber = spaceIdx > 0 ? afterDash.substring(0, spaceIdx) : afterDash;
					if (designator && pinNumber && /^[A-Z]/.test(designator)) {
						map.set(`${designator}_${pinNumber}`, currentNet);
					}
				}
			}
		}
	}

	if (map.size > 0) {
		log('info', `[采集] 使用 PROTEL NETLIST 2.0 格式解析器`);
	}
}

/**
 * 解析 Protel2 标准格式网表
 *
 * 结构包含两个部分：
 * ( { Component List }
 *   ( U1 LQFP-48 )
 *   ( C1 C0402 )
 * )
 * ( { Net List }
 *   ( GND
 *     U1-14
 *     C1-2
 *   )
 *   ( VCC_3V3
 *     U1-1
 *     C1-1
 *   )
 * )
 */
function parseNetlistProtel2Standard(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let inNetListSection = false;
	let currentNet = '';

	for (const line of lines) {
		const trimmed = line.trim();

		// 检测 Net List 部分开始
		if (trimmed.includes('Net List')) {
			inNetListSection = true;
			currentNet = '';
			continue;
		}

		// 检测 Component List 部分（跳过）
		if (trimmed.includes('Component List')) {
			inNetListSection = false;
			currentNet = '';
			continue;
		}

		if (!inNetListSection)
			continue;

		// 匹配网络名称行：( GND 或 ( VCC_3V3 或 ( NET_LCD_DE
		// 网络名在 "(" 之后，可能独占一行或者和 "(" 在同一行
		const netOpenMatch = trimmed.match(/^\(\s*([^\s)]+)\s*$/);
		if (netOpenMatch && !trimmed.endsWith(')')) {
			const candidate = netOpenMatch[1];
			// 排除明显不是网络名的行（如大括号注释）
			if (candidate && !candidate.startsWith('{') && !candidate.startsWith('(')) {
				currentNet = candidate;
				continue;
			}
		}

		// 匹配引脚连接行：U1-14 或 R1-2 或 J1-3
		// Designator 格式：字母+数字，Pin 格式：数字（可能包含字母如 A1）
		if (currentNet) {
			const pinMatch = trimmed.match(/^([A-Z][A-Z0-9]*\d)-(\S+)\s*$/);
			if (pinMatch) {
				map.set(`${pinMatch[1]}_${pinMatch[2]}`, currentNet);
				continue;
			}
		}

		// 网络结束：单独的 )
		if (trimmed === ')') {
			currentNet = '';
		}
	}

	if (map.size > 0) {
		log('info', `[采集] 使用 Protel2 标准格式解析器`);
	}
}

/**
 * 通用网表解析器（正则全局匹配）
 *
 * 在整个网表文本中搜索 Designator-Pin 模式，
 * 结合上下文推断网络名称。
 * 支持多种变体格式。
 */
function parseNetlistGeneric(netlistRaw: string, map: Map<string, string>): void {
	const lines = netlistRaw.split('\n');
	let currentNet = '';
	let lastOpenParen = '';

	for (const line of lines) {
		const trimmed = line.trim();

		// 跟踪 "(" 开始的块——可能是网络名
		const parenMatch = trimmed.match(/^\(\s*([^\s)]+)\s*$/);
		if (parenMatch) {
			const content = parenMatch[1];
			// 如果内容不是大括号注释也不是 Designator-Pin 格式
			if (!content.startsWith('{') && !content.match(/^[A-Z]\S*-\d/)) {
				lastOpenParen = content;
			}
			continue;
		}

		// 匹配 Designator-Pin 模式（宽松）
		const pinMatch = trimmed.match(/^([A-Z][A-Z0-9]*\d)-(\S+)$/);
		if (pinMatch && lastOpenParen) {
			currentNet = lastOpenParen;
			map.set(`${pinMatch[1]}_${pinMatch[2]}`, currentNet);
			continue;
		}

		// 单独的 ) 结束当前块
		if (trimmed === ')') {
			lastOpenParen = '';
			currentNet = '';
		}
	}

	if (map.size > 0) {
		log('info', `[采集] 使用通用格式解析器`);
	}
}

/**
 * 通过导线坐标邻近性查找网络
 */
function _findNetByWireProximity(
	pinX: number,
	pinY: number,
	wires: Array<{ net: string; lines: number[][] }>,
): string | null {
	const TOLERANCE = 50; // 增大容差以匹配引脚偏移（50 * 0.01inch = 0.5 inch）

	for (const wire of wires) {
		if (!wire.net)
			continue;

		for (const line of wire.lines) {
			// line格式: [x1, y1, x2, y2, ...]
			for (let i = 0; i < line.length; i += 2) {
				const wx = line[i];
				const wy = line[i + 1];
				if (wx === undefined || wy === undefined)
					continue;

				const distance = Math.sqrt((pinX - wx) ** 2 + (pinY - wy) ** 2);
				if (distance <= TOLERANCE) {
					return wire.net;
				}
			}
		}
	}

	return null;
}

/**
 * 诊断辅助：查找最近导线端点的距离（用于判断容差是否合适）
 */
function findNearestWireDistance(
	pinX: number,
	pinY: number,
	validWires: Array<{ net: string; lines: number[][] }>,
	emptyWires: Array<{ lines: number[][] }>,
): { distance: number; net: string | null } | null {
	let nearest: { distance: number; net: string | null } | null = null;

	const allWires: Array<{ net: string | null; lines: number[][] }> = [
		...validWires.map(w => ({ net: w.net as string | null, lines: w.lines })),
		...emptyWires.map(w => ({ net: null as string | null, lines: w.lines })),
	];

	for (const wire of allWires) {
		for (const line of wire.lines) {
			for (let i = 0; i < line.length; i += 2) {
				const wx = line[i];
				const wy = line[i + 1];
				if (wx === undefined || wy === undefined)
					continue;

				const distance = Math.sqrt((pinX - wx) ** 2 + (pinY - wy) ** 2);
				if (!nearest || distance < nearest.distance) {
					nearest = { distance, net: wire.net };
				}
			}
		}
	}

	return nearest;
}

/**
 * 诊断辅助：查找最近网络标记的距离
 */
function findNearestLabelDistance(
	pinX: number,
	pinY: number,
	netLabels: RawNetLabel[],
): { distance: number; net: string } | null {
	let nearest: { distance: number; net: string } | null = null;

	for (const label of netLabels) {
		if (!label.netName)
			continue;

		const distance = Math.sqrt((pinX - label.x) ** 2 + (pinY - label.y) ** 2);
		if (!nearest || distance < nearest.distance) {
			nearest = { distance, net: label.netName };
		}
	}

	return nearest;
}

/**
 * 诊断辅助：查找最近导线拓扑点的距离
 */
function findNearestTopoDistance(
	pinX: number,
	pinY: number,
	wireClusters: WireCluster[],
): { distance: number } | null {
	let nearest: { distance: number } | null = null;

	for (const cluster of wireClusters) {
		for (const point of cluster.points) {
			const dist = Math.sqrt((pinX - point.x) ** 2 + (pinY - point.y) ** 2);
			if (!nearest || dist < nearest.distance) {
				nearest = { distance: dist };
			}
		}
	}

	return nearest;
}

/**
 * 通过网络标记坐标邻近性查找网络
 * 用于 pin-net 绑定的第三层策略（L3）
 */
function _findNetByLabelProximity(
	pinX: number,
	pinY: number,
	netLabels: RawNetLabel[],
): string | null {
	const TOLERANCE = 100; // 增大容差以覆盖导线中间连接的场景
	let bestNet: string | null = null;
	let bestDistance = TOLERANCE;

	for (const label of netLabels) {
		if (!label.netName)
			continue;

		const distance = Math.sqrt((pinX - label.x) ** 2 + (pinY - label.y) ** 2);
		if (distance <= bestDistance) {
			bestDistance = distance;
			bestNet = label.netName;
		}
	}

	return bestNet;
}

/**
 * 导线拓扑簇（L4 策略的数据结构）
 */
interface WireCluster {
	id: string;
	netName: string | null;
	points: Array<{ x: number; y: number }>;
	confidence: number; // 0.5=推断, 0.6=空导线, 0.7=标记, 0.8=导线net
}

/**
 * L4: 构建导线拓扑图
 * 通过导线的物理连接关系推断网络，即使导线的 net 属性为空
 */
function buildWireTopology(
	validWires: Array<{ net: string; lines: number[][] }>,
	emptyWires: Array<{ lines: number[][] }>,
	netLabels: RawNetLabel[],
): WireCluster[] {
	const CONNECT_TOLERANCE = 15; // 导线端点连接容差（增大以匹配栅格偏移）

	// 1. 收集所有导线段
	interface WireSegment {
		net: string | null;
		points: Array<{ x: number; y: number }>;
	}

	const allSegments: WireSegment[] = [];

	// 有 net 的导线
	for (const wire of validWires) {
		for (const line of wire.lines) {
			const points: Array<{ x: number; y: number }> = [];
			for (let i = 0; i < line.length; i += 2) {
				if (line[i] !== undefined && line[i + 1] !== undefined) {
					points.push({ x: line[i], y: line[i + 1] });
				}
			}
			if (points.length >= 2) {
				allSegments.push({ net: wire.net, points });
			}
		}
	}

	// net 为空的导线
	for (const wire of emptyWires) {
		for (const line of wire.lines) {
			const points: Array<{ x: number; y: number }> = [];
			for (let i = 0; i < line.length; i += 2) {
				if (line[i] !== undefined && line[i + 1] !== undefined) {
					points.push({ x: line[i], y: line[i + 1] });
				}
			}
			if (points.length >= 2) {
				allSegments.push({ net: null, points });
			}
		}
	}

	if (allSegments.length === 0) {
		return [];
	}

	// 2. 使用并查集构建连通分量
	const parent = new Map<number, number>();
	const rank = new Map<number, number>();

	function find(x: number): number {
		if (!parent.has(x)) {
			parent.set(x, x);
			rank.set(x, 0);
		}
		if (parent.get(x) !== x) {
			parent.set(x, find(parent.get(x)!));
		}
		return parent.get(x)!;
	}

	function union(x: number, y: number): void {
		const rootX = find(x);
		const rootY = find(y);
		if (rootX === rootY)
			return;

		const rankX = rank.get(rootX) || 0;
		const rankY = rank.get(rootY) || 0;

		if (rankX < rankY) {
			parent.set(rootX, rootY);
		}
		else if (rankX > rankY) {
			parent.set(rootY, rootX);
		}
		else {
			parent.set(rootY, rootX);
			rank.set(rootX, rankX + 1);
		}
	}

	// 3. 连接相邻的导线段
	for (let i = 0; i < allSegments.length; i++) {
		for (let j = i + 1; j < allSegments.length; j++) {
			const seg1 = allSegments[i];
			const seg2 = allSegments[j];

			// 检查两个线段的端点是否接近
			for (const p1 of seg1.points) {
				for (const p2 of seg2.points) {
					const dist = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
					if (dist < CONNECT_TOLERANCE) {
						union(i, j);
					}
				}
			}
		}
	}

	// 4. 按连通分量分组
	const clusters = new Map<number, number[]>();
	for (let i = 0; i < allSegments.length; i++) {
		const root = find(i);
		if (!clusters.has(root)) {
			clusters.set(root, []);
		}
		clusters.get(root)!.push(i);
	}

	// 5. 为每个连通分量确定网络名称
	const wireClusters: WireCluster[] = [];
	let clusterIndex = 0;

	for (const [_root, segmentIndices] of clusters.entries()) {
		// 收集该连通分量的所有点
		const allPoints: Array<{ x: number; y: number }> = [];
		let netFromWire: string | null = null;

		for (const idx of segmentIndices) {
			const seg = allSegments[idx];
			allPoints.push(...seg.points);
			if (seg.net && !netFromWire) {
				netFromWire = seg.net;
			}
		}

		// 优先使用导线自带的 net
		let netName = netFromWire;
		let confidence = netFromWire ? 0.8 : 0.6;

		// 如果导线没有 net，尝试从网络标记推断
		if (!netName) {
			const LABEL_TOLERANCE = 100;
			for (const label of netLabels) {
				for (const point of allPoints) {
					const dist = Math.sqrt((point.x - label.x) ** 2 + (point.y - label.y) ** 2);
					if (dist < LABEL_TOLERANCE) {
						netName = label.netName;
						confidence = 0.7;
						break;
					}
				}
				if (netName)
					break;
			}
		}

		// 如果还是没有，分配临时名称
		if (!netName) {
			netName = `WIRE_CLUSTER_${String(clusterIndex + 1).padStart(3, '0')}`;
			confidence = 0.5;
		}

		wireClusters.push({
			id: `cluster_${clusterIndex}`,
			netName,
			points: allPoints,
			confidence,
		});

		clusterIndex++;
	}

	log('info', `[L4拓扑] 构建了 ${wireClusters.length} 个导线簇`);

	return wireClusters;
}

/**
 * L4: 通过导线拓扑查找网络
 */
function _findNetByWireTopology(
	pinX: number,
	pinY: number,
	wireClusters: WireCluster[],
): { netName: string; confidence: number } | null {
	const TOLERANCE = 50; // 增大容差以匹配引脚偏移

	for (const cluster of wireClusters) {
		for (const point of cluster.points) {
			const dist = Math.sqrt((pinX - point.x) ** 2 + (pinY - point.y) ** 2);
			if (dist <= TOLERANCE) {
				return {
					netName: cluster.netName!,
					confidence: cluster.confidence,
				};
			}
		}
	}

	return null;
}

/**
 * 构建网络统计
 */
function buildNetStatistics(pins: RawPin[]): RawNet[] {
	const netMap = new Map<string, Set<string>>();

	for (const pin of pins) {
		if (!pin.netName)
			continue;

		if (!netMap.has(pin.netName)) {
			netMap.set(pin.netName, new Set());
		}
		netMap.get(pin.netName)!.add(pin.primitiveId);
	}

	return Array.from(netMap.entries()).map(([netName, pinSet]) => ({
		netName,
		pinCount: pinSet.size,
		pins: Array.from(pinSet),
	}));
}
