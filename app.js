const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
const MONITORED_ADDRESSES = (process.env.MONITORED_ADDRESSES || '').split(',').filter(addr => addr.trim());

// 去重配置：同一市场在 dedupWindowMs 毫秒内重复推送将被忽略（默认30分钟）
const DEDUP_WINDOW_MS = parseInt(process.env.DEDUP_WINDOW_MS) || 30 * 60 * 1000;

// 去重缓存：记录每个 marketSlug 的最后推送时间
const lastPushCache = new Map();

// 清理过期缓存（每小时执行一次）
setInterval(() => {
    const now = Date.now();
    for (const [slug, timestamp] of lastPushCache.entries()) {
        if (now - timestamp > DEDUP_WINDOW_MS) {
            lastPushCache.delete(slug);
        }
    }
}, 60 * 60 * 1000);

// 稳定币识别配置
const STABLE_COIN_SYMBOLS = ['PUSD', 'USDC.E', 'USDC', 'USD COIN'];
const STABLE_COIN_ADDRESSES = [
    '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb',
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
];

function isStableCoin(asset, rawContract) {
    if (!asset && !rawContract) return false;
    if (asset && STABLE_COIN_SYMBOLS.includes(asset.toUpperCase())) return true;
    if (rawContract?.address && STABLE_COIN_ADDRESSES.includes(rawContract.address.toLowerCase())) return true;
    return false;
}

function extractStableCoinAmount(activities) {
    let totalAmount = 0;
    for (const tx of activities) {
        if (tx.category === 'token' && isStableCoin(tx.asset, tx.rawContract)) {
            let amount = typeof tx.value === 'string' ? parseFloat(tx.value) : tx.value;
            if (!isNaN(amount)) totalAmount += amount;
        }
        else if (tx.category !== 'erc1155' && tx.category !== 'internal' && typeof tx.value === 'number' && tx.value > 0) {
            let amount = tx.value / 1e18;
            if (!isNaN(amount)) totalAmount += amount;
        }
    }
    return totalAmount;
}

console.log('=== 飞书推送2.2（event链接修复） ===');
console.log('飞书Webhook:', FEISHU_WEBHOOK ? '✅ 已配置' : '❌ 未配置');
console.log('监控地址:', MONITORED_ADDRESSES.length > 0 ? MONITORED_ADDRESSES : '⚠️ 未配置');
console.log('端口:', PORT);
console.log('去重窗口:', DEDUP_WINDOW_MS / 1000 / 60, '分钟');
console.log('====================================');

async function sendToFeishu(message) {
    if (!FEISHU_WEBHOOK) return;
    try {
        const maxLength = 4000;
        const finalMessage = message.length > maxLength ? message.substring(0, maxLength) + '\n... (消息过长已截断)' : message;
        await axios.post(FEISHU_WEBHOOK, {
            msg_type: 'text',
            content: { text: finalMessage }
        });
        console.log('✅ 飞书推送成功');
    } catch (error) {
        console.error('❌ 飞书推送失败:', error.response?.data || error.message);
    }
}

// 通用金额格式化
function formatAmountNumber(value, decimals = 6, isRaw = false) {
    if (value === undefined || value === null) return NaN;
    let numValue;
    if (typeof value === 'string') {
        if (value.startsWith('0x')) {
            try {
                numValue = Number(BigInt(value));
                isRaw = true;
            } catch(e) {
                numValue = parseFloat(value);
            }
        } else {
            numValue = parseFloat(value);
        }
    } else {
        numValue = value;
    }
    if (isNaN(numValue)) return NaN;
    if (numValue == 0) return 0;
    if (isRaw) {
        return numValue / Math.pow(10, decimals);
    } else {
        return numValue;
    }
}

function hexToDecimal(hexString) {
    if (!hexString) return null;
    const cleanHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
    try {
        return BigInt('0x' + cleanHex).toString();
    } catch (error) {
        console.error('十六进制转换失败:', error.message);
        return null;
    }
}

/**
 * 从 market slug 中提取 event slug（去掉 game 后缀）
 * 例如: "cs2-prv-9z-2026-06-11-game2" -> "cs2-prv-9z-2026-06-11"
 *       "btc-updown-5m-1781200800" -> "btc-updown-5m-1781200800" (无变化)
 */
function extractEventSlug(marketSlug) {
    if (!marketSlug) return null;
    // 匹配 -game 或 -map 等后缀（不区分大小写）
    const patterns = [
        /-game\d+$/i,      // -game1, -game2, -game3
        /-map\d+$/i,       // -map1, -map2, -map3
        /-leg\d+$/i,       // -leg1, -leg2
        /-set\d+$/i        // -set1, -set2
    ];
    
    let eventSlug = marketSlug;
    for (const pattern of patterns) {
        if (pattern.test(eventSlug)) {
            eventSlug = eventSlug.replace(pattern, '');
            break;
        }
    }
    return eventSlug;
}

/**
 * 获取正确的 event slug（通过 API 查询父事件）
 */
async function getEventSlugFromAPI(marketSlug) {
    if (!marketSlug) return null;
    
    try {
        // 尝试获取父事件信息
        const url = `https://gamma-api.polymarket.com/events?slug=${marketSlug}`;
        const response = await axios.get(url, { timeout: 5000 });
        
        if (response.data && response.data.length > 0 && response.data[0].slug) {
            return response.data[0].slug;
        }
    } catch (error) {
        // API 调用失败，使用本地规则
        console.log(`⚠️ 无法通过 API 获取 event slug: ${marketSlug}`);
    }
    
    // 降级：使用本地规则
    return extractEventSlug(marketSlug);
}

async function getMarketInfo(tokenId) {
    if (!tokenId) return null;
    let decimalTokenId = tokenId;
    if (typeof tokenId === 'string' && tokenId.startsWith('0x')) {
        decimalTokenId = hexToDecimal(tokenId);
        if (!decimalTokenId) return null;
    }
    const apis = [
        `https://gamma-api.polymarket.com/markets?clob_token_ids=${decimalTokenId}`,
        `https://gamma-api.polymarket.com/markets/token-id/${decimalTokenId}`,
        `https://data-api.polymarket.com/markets?token_id=${decimalTokenId}`
    ];
    for (const url of apis) {
        try {
            const response = await axios.get(url, { timeout: 5000 });
            if (response.data) {
                let market = null;
                if (response.data.length > 0) market = response.data[0];
                else if (response.data.markets && response.data.markets.length > 0) market = response.data.markets[0];
                else if (response.data.question) market = response.data;
                if (market) {
                    let clobTokenIds = [];
                    if (market.clobTokenIds) {
                        if (typeof market.clobTokenIds === 'string') {
                            try { clobTokenIds = JSON.parse(market.clobTokenIds); } catch(e) { clobTokenIds = []; }
                        } else if (Array.isArray(market.clobTokenIds)) clobTokenIds = market.clobTokenIds;
                    } else if (market.markets && market.markets[0] && market.markets[0].clobTokenIds) {
                        const raw = market.markets[0].clobTokenIds;
                        if (typeof raw === 'string') {
                            try { clobTokenIds = JSON.parse(raw); } catch(e) { clobTokenIds = []; }
                        } else if (Array.isArray(raw)) clobTokenIds = raw;
                    }
                    let outcomes = [];
                    if (market.outcomes) {
                        if (typeof market.outcomes === 'string') {
                            try { outcomes = JSON.parse(market.outcomes); } catch(e) { outcomes = market.outcomes.split(','); }
                        } else if (Array.isArray(market.outcomes)) outcomes = market.outcomes;
                    } else if (market.markets && market.markets[0] && market.markets[0].outcomes) {
                        const od = market.markets[0].outcomes;
                        if (typeof od === 'string') {
                            try { outcomes = JSON.parse(od); } catch(e) { outcomes = od.split(','); }
                        } else if (Array.isArray(od)) outcomes = od;
                    }
                    clobTokenIds = clobTokenIds.map(id => String(id).trim());
                    
                    // 获取正确的 event slug（用于链接）
                    const marketSlug = market.slug;
                    const eventSlug = await getEventSlugFromAPI(marketSlug);
                    
                    return {
                        question: market.question || market.title,
                        slug: market.slug,
                        eventSlug: eventSlug || extractEventSlug(marketSlug), // 优先使用 API 返回的 event slug
                        endDate: market.endDate,
                        clobTokenIds,
                        outcomes
                    };
                }
            }
        } catch (error) {}
    }
    return null;
}

function getOutcomeFromMarketInfo(tokenId, marketInfo) {
    if (!marketInfo || !marketInfo.clobTokenIds || marketInfo.clobTokenIds.length === 0) {
        return { outcome: null };
    }
    let inputDecimal = null;
    if (typeof tokenId === 'string' && tokenId.startsWith('0x')) {
        inputDecimal = hexToDecimal(tokenId);
        if (!inputDecimal) return { outcome: null };
    } else {
        inputDecimal = String(tokenId).trim();
    }
    let matchedIndex = -1;
    for (let i = 0; i < marketInfo.clobTokenIds.length; i++) {
        if (marketInfo.clobTokenIds[i] === inputDecimal) {
            matchedIndex = i;
            break;
        }
    }
    if (matchedIndex !== -1 && marketInfo.outcomes && marketInfo.outcomes.length > matchedIndex) {
        return { outcome: marketInfo.outcomes[matchedIndex] };
    }
    return { outcome: null };
}

function analyzeTradeType(activities, monitoredAddress) {
    let hasSendToken = false, hasReceiveToken = false;
    let hasSendCondition = false, hasReceiveCondition = false;
    for (const tx of activities) {
        const fromAddr = tx.fromAddress?.toLowerCase() || '';
        const toAddr = tx.toAddress?.toLowerCase() || '';
        const isFromMonitored = fromAddr === monitoredAddress.toLowerCase();
        const isToMonitored = toAddr === monitoredAddress.toLowerCase();
        if (tx.asset && tx.category === 'token') {
            if (isFromMonitored) hasSendToken = true;
            if (isToMonitored) hasReceiveToken = true;
        }
        if (tx.erc1155Metadata && tx.erc1155Metadata.length > 0) {
            if (isFromMonitored) hasSendCondition = true;
            if (isToMonitored) hasReceiveCondition = true;
        }
    }
    let type = '转账';
    if (hasSendToken && hasReceiveCondition) type = '买入';
    else if (hasSendCondition && hasReceiveToken) type = '卖出';
    return { type };
}

async function processTransaction(hash, activities) {
    if (!activities || activities.length === 0) return null;
    const firstTx = activities[0];
    const timestamp = firstTx.blockTimestamp ? parseInt(firstTx.blockTimestamp, 16) * 1000 : Date.now();
    const timeStr = new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' (北京时间)';
    
    let isMonitored = false, monitoredAddress = '';
    for (const tx of activities) {
        const fromAddr = tx.fromAddress?.toLowerCase() || '';
        const toAddr = tx.toAddress?.toLowerCase() || '';
        for (const addr of MONITORED_ADDRESSES) {
            const lowerAddr = addr.toLowerCase();
            if (toAddr === lowerAddr || fromAddr === lowerAddr) {
                isMonitored = true;
                monitoredAddress = lowerAddr;
                break;
            }
        }
        if (isMonitored) break;
    }
    if (!isMonitored && MONITORED_ADDRESSES.length > 0) return null;

    const tradeType = analyzeTradeType(activities, monitoredAddress).type;
      
     if (tradeType !== '买入') {
        console.log(`⏭️ 跳过非买入交易: ${hash.substring(0, 16)}..., 类型: ${tradeType}`);
        return null;
    }

    const totalStableAmount = extractStableCoinAmount(activities);
    const totalAmountNum = totalStableAmount;
    const formattedAmount = totalAmountNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '$';

    const items = [];

    for (const tx of activities) {
        if (tx.erc1155Metadata && tx.erc1155Metadata.length > 0) {
            for (const item of tx.erc1155Metadata) {
                const tokenId = item.tokenId;
                let rawValue = item.value;
                if (typeof rawValue === 'string' && rawValue.startsWith('0x')) rawValue = parseInt(rawValue, 16);
                const marketInfo = await getMarketInfo(tokenId);
                const outcome = getOutcomeFromMarketInfo(tokenId, marketInfo).outcome || '未知';
                const sharesNum = formatAmountNumber(rawValue, 6, true);
                const sharesDisplay = sharesNum.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 4 }) + ' shares';
                let avgPriceDisplay = '?';
                if (!isNaN(sharesNum) && sharesNum > 0 && !isNaN(totalAmountNum) && totalAmountNum > 0) {
                    const avgInDollar = totalAmountNum / sharesNum;
                    const avgInCents = avgInDollar * 100;
                    avgPriceDisplay = avgInCents.toFixed(1) + '¢';
                }
                items.push({
                    outcome,
                    marketQuestion: marketInfo?.question,
                    marketSlug: marketInfo?.slug,
                    eventSlug: marketInfo?.eventSlug,  // 使用正确的 event slug
                    sharesDisplay,
                    avgPriceDisplay
                });
            }
        }
    }

    if (items.length === 0) return null;

    // 去重检查
    const firstItem = items[0];
    const dedupKey = firstItem.eventSlug || firstItem.marketSlug;
    
    if (dedupKey) {
        const lastPushTime = lastPushCache.get(dedupKey);
        const now = Date.now();
        
        if (lastPushTime && (now - lastPushTime) < DEDUP_WINDOW_MS) {
            const remainingMinutes = Math.ceil((DEDUP_WINDOW_MS - (now - lastPushTime)) / 1000 / 60);
            console.log(`⏭️ 跳过重复推送: ${dedupKey}, 剩余冷却时间 ${remainingMinutes} 分钟`);
            return null;
        }
        
        lastPushCache.set(dedupKey, now);
        console.log(`📝 记录推送: ${dedupKey}, 下次推送需等待 ${DEDUP_WINDOW_MS / 1000 / 60} 分钟`);
    }

    // 构建消息 - 使用正确的 event slug 生成链接
    const detailsText = items.map(item => {
        let lines = [];
        if (item.marketQuestion) {
            lines.push(`   市场: ${item.marketQuestion}`);
            // +++ PM链接（原链接改名） +++
            const pmLinkSlug = item.eventSlug || item.marketSlug;
            lines.push(`   PM链接: https://polymarket.com/event/${pmLinkSlug}`);
            // +++ 新增 BetMoar 链接 +++
            if (item.marketSlug) {
                lines.push(`   BetMoar: https://www.betmoar.fun/market/${item.marketSlug}`);
            }
            // +++ 新增结束 +++
            if (item.marketSlug && item.marketSlug !== item.eventSlug) {
                console.log(`📎 链接转换: ${item.marketSlug} -> ${item.eventSlug}`);
            }
        }
        lines.push(`   ${tradeType} 【${item.outcome}】`);
        lines.push(`   份额: ${item.sharesDisplay}`);
        lines.push(`   金额: ${formattedAmount}`);
        lines.push(`   均价: ${item.avgPriceDisplay}`);
        return lines.join('\n');
    }).join('\n\n');

    const readableMessage = `【跟单信息】\n` +
        `📋 交易类型: ${tradeType}\n` +
        `📦 交易详情:\n${detailsText}\n` +
        `🕐 时间: ${timeStr}\n`;

    return readableMessage;
}

let pendingTransactions = new Map();
let processingTimer = null;

app.post('/webhook', async (req, res) => {
    res.status(200).send('OK');
    try {
        console.log(`📨 收到 webhook, ID: ${req.body.webhookId || 'unknown'}`);
        const event = req.body.event;
        if (!event?.activity) return;
        console.log(`📊 收到 ${event.activity.length} 条 activity`);
        for (const tx of event.activity) {
            const hash = tx.hash;
            if (!pendingTransactions.has(hash)) pendingTransactions.set(hash, []);
            pendingTransactions.get(hash).push(tx);
        }
        if (processingTimer) clearTimeout(processingTimer);
        processingTimer = setTimeout(async () => {
            const transactions = new Map(pendingTransactions);
            pendingTransactions.clear();
            for (const [hash, activities] of transactions) {
                console.log(`🔄 处理交易: ${hash.substring(0, 16)}..., ${activities.length} 条 activity`);
                const message = await processTransaction(hash, activities);
                if (message) await sendToFeishu(message);
            }
        }, 2000);
    } catch (error) {
        console.error('❌ 处理出错:', error.message);
    }
});

app.get('/health', (req, res) => res.send('OK'));

app.get('/test', async (req, res) => {
    const testMessage = '【测试】飞书推送2.2（event链接修复）运行正常 ✅\n\n' +
        '- 自动修复包含 game/map 后缀的市场链接\n' +
        '- 去重窗口: ' + (DEDUP_WINDOW_MS / 1000 / 60) + ' 分钟';
    await sendToFeishu(testMessage);
    res.json({ 
        status: 'ok', 
        version: '2.2 (event链接修复)', 
        dedupWindowMinutes: DEDUP_WINDOW_MS / 1000 / 60 
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 飞书推送2.2（event链接修复）已启动！端口: ${PORT}`);
    console.log(`✅ 自动修复包含 game/map 后缀的市场链接`);
    console.log(`✅ 同一事件在 ${DEDUP_WINDOW_MS / 1000 / 60} 分钟内重复推送将被忽略`);
});