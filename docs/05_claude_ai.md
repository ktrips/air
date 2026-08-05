# 第5章: Claude AIの統合

## 5.1 Claude APIの実装基礎

### 5.1.1 APIキーの安全な管理

ブラウザ環境ではAPIキーを直接使用することは避け、バックエンド経由でAPIを呼び出す方法が推奨されます。しかし、簡易的なデモンストレーション用にはCORSプロキシを使用することもできます。

**セキュアな実装方法**: Node.jsバックエンド経由

```javascript
// バックエンド（Node.js）でのClaude API呼び出し
// backend/claude-api.js

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY
});

export async function generateTripDescription(tripData) {
  const prompt = `
トリップ情報:
- 位置: ${tripData.title}
- 緯度経度: ${tripData.location.lat}, ${tripData.location.lng}
- 既存説明: ${tripData.description || 'なし'}

このトリップについて、観光客向けの魅力的な説明を100字以内で生成してください。
`;

  const message = await client.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: prompt }
    ]
  });

  return message.content[0].text;
}
```

### 5.1.2 APIレスポンスの処理

Claude APIからのレスポンス構造：

```javascript
{
  "id": "msg_0123456789",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "レスポンスのテキスト"
    }
  ],
  "model": "claude-3-5-sonnet-20241022",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 123,
    "output_tokens": 456
  }
}
```

レスポンス処理の実装：

```javascript
async function callClaudeAPI(prompt) {
  try {
    // APIキーはサーバー側で管理されるため、クライアント側では不要
    const response = await fetch('/api/claude/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // レスポンスを処理
    if (data.error) {
      throw new Error(data.error);
    }

    return data.result;
  } catch (error) {
    console.error('Claude API呼び出しエラー:', error);
    throw error;
  }
}
```

## 5.2 プロンプトエンジニアリング

### 5.2.1 効果的なプロンプトの設計

トリップの説明を生成するプロンプト例：

```javascript
function createTripDescriptionPrompt(trip) {
  return `
##Context
You are a travel guide expert. You create engaging descriptions of tourist destinations.

## Location Information
- Place Name: ${trip.title}
- Coordinates: ${trip.location.lat}, ${trip.location.lng}
- Current Description: ${trip.description || 'None provided'}

## Task
Generate an engaging tourist description in ${trip.language || 'English'}.
- Length: Maximum 100 words
- Tone: Friendly and informative
- Include: What to see, best time to visit, estimated time needed

## Output Format
Return ONLY the description text, no additional commentary.
`;
}
```

### 5.2.2 複数のプロンプトパターン

```javascript
/**
 * トリップのタイトルを生成
 */
function createTitleGenerationPrompt(coordinates, nearbyPlaces) {
  return `
与えられた座標及び周辺情報から、魅力的なトリップタイトルを生成してください。
座標: ${coordinates.lat}, ${coordinates.lng}
周辺: ${nearbyPlaces.join(', ')}

要件:
- 20字以内
- 日本語
- 観光客の興味を引くもの
- ユニークで記憶に残るもの

タイトルのみを返してください。
`;
}

/**
 * トリップの分類を行う
 */
function createCategoryPrompt(tripTitle, tripDescription) {
  return `
以下のトリップを分類してください。

トリップ: ${tripTitle}
説明: ${tripDescription}

以下のカテゴリから最も適切なものを1つ選んでください:
- 自然/風景
- 歴史/文化
- グルメ
- アクティビティ
- 宗教施設
- 商業施設
- その他

カテゴリ名のみを返してください。
`;
}

/**
 * 複数トリップの最適なルートを提案
 */
function createRouteOptimizationPrompt(trips) {
  const tripList = trips.map((t, i) => 
    `${i + 1}. ${t.title} (${t.location.lat}, ${t.location.lng})`
  ).join('\n');

  return `
以下の観光地を訪問する最適なルートを提案してください。

観光地:
${tripList}

要件:
- 効率的な移動順序（総移動距離が最小）
- 各観光地の滞在時間の目安
- 所要時間の合計

JSON形式で以下の構造で返してください:
{
  "order": [観光地の番号],
  "totalDistance": "移動距離（km）",
  "totalTime": "所要時間",
  "segments": [
    {"from": "出発地", "to": "目的地", "distance": "km", "time": "時間"}
  ]
}
`;
}
```

## 5.3 AIの出力を地図に統合

### 5.3.1 AIが生成したデータの処理

```javascript
class AITripManager {
  constructor(mapManager, markerManager, claudeAPI) {
    this.mapManager = mapManager;
    this.markerManager = markerManager;
    this.claudeAPI = claudeAPI;
  }

  /**
   * AIを使用してトリップの詳細を生成
   */
  async enhanceTrip(trip) {
    try {
      // 説明を生成
      const descriptionPrompt = createTripDescriptionPrompt(trip);
      const description = await this.claudeAPI.call(descriptionPrompt);

      // タイプ/カテゴリを分類
      const categoryPrompt = createCategoryPrompt(trip.title, description);
      const category = await this.claudeAPI.call(categoryPrompt);

      return {
        ...trip,
        description: description.trim(),
        category: category.trim(),
        aiGenerated: true,
        generatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('トリップ拡張エラー:', error);
      return trip; // エラー時は元のデータを返す
    }
  }

  /**
   * 複数のトリップを一括拡張
   */
  async enhanceTrips(trips) {
    const enhancedTrips = [];

    for (const trip of trips) {
      const enhanced = await this.enhanceTrip(trip);
      enhancedTrips.push(enhanced);

      // API呼び出し間隔を設ける（レート制限回避）
      await this.delay(500);
    }

    return enhancedTrips;
  }

  /**
   * 最適なルートを提案
   */
  async suggestOptimalRoute(trips) {
    try {
      const prompt = createRouteOptimizationPrompt(trips);
      const response = await this.claudeAPI.call(prompt);

      // JSON形式の応答をパース
      const routeData = JSON.parse(response);
      return routeData;
    } catch (error) {
      console.error('ルート提案エラー:', error);
      return null;
    }
  }

  /**
   * 提案されたルートを地図に表示
   */
  visualizeRoute(routeData, trips) {
    if (!routeData) return;

    // ルートの順序に基づいてマーカーをハイライト
    const markerIds = routeData.order.map(index => trips[index - 1].id);

    // ポリラインを描画（ルートを線で表現）
    this.mapManager.drawPolyline(markerIds, {
      strokeColor: '#4285F4',
      strokeOpacity: 0.8,
      strokeWeight: 3
    });

    // 地図をズーム調整
    this.mapManager.fitMarkers(markerIds);
  }

  /**
   * 遅延を設ける（ユーティリティ）
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## 5.4 ストリーミング処理

### 5.4.1 長い応答のストリーミング

Claude APIはストリーミング対応で、リアルタイムでレスポンスを処理できます：

```javascript
async function streamClaudeResponse(prompt, onChunk) {
  try {
    const response = await fetch('/api/claude/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ prompt })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      const chunk = decoder.decode(value);

      // SSE形式のデータをパース
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'content_block_delta') {
              onChunk(event.delta.text);
            }
          } catch (e) {
            // JSON解析エラーは無視
          }
        }
      }
    }
  } catch (error) {
    console.error('ストリーミングエラー:', error);
  }
}

// 使用例
const buffer = [];
streamClaudeResponse(prompt, (chunk) => {
  buffer.push(chunk);
  document.getElementById('output').textContent = buffer.join('');
});
```

## 5.5 エラーハンドリングと再試行

### 5.5.1 レート制限への対応

```javascript
class RateLimitedClaudeAPI {
  constructor(maxRetries = 3, initialDelayMs = 1000) {
    this.maxRetries = maxRetries;
    this.initialDelayMs = initialDelayMs;
  }

  /**
   * エクスポーネンシャルバックオフで再試行
   */
  async callWithRetry(prompt) {
    let lastError;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.callClaudeAPI(prompt);
      } catch (error) {
        lastError = error;

        // レート制限エラーの場合のみ再試行
        if (error.status === 429 && attempt < this.maxRetries - 1) {
          const delayMs = this.initialDelayMs * Math.pow(2, attempt);
          console.log(`レート制限に達しました。${delayMs}ms後に再試行します...`);
          await this.delay(delayMs);
        } else {
          throw error;
        }
      }
    }

    throw lastError;
  }

  async callClaudeAPI(prompt) {
    // Claude API呼び出し実装
    const response = await fetch('/api/claude/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      const error = new Error(`API error: ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## 5.6 費用監視とトークン計算

### 5.6.1 トークン使用量の追跡

```javascript
class TokenUsageTracker {
  constructor() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.costPerInputToken = 0.003 / 1000;    // $0.003 per 1K
    this.costPerOutputToken = 0.015 / 1000;   // $0.015 per 1K
  }

  /**
   * トークン使用量を記録
   */
  recordUsage(inputTokens, outputTokens) {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
  }

  /**
   * 推定費用を計算
   */
  getEstimatedCost() {
    const inputCost = this.totalInputTokens * this.costPerInputToken;
    const outputCost = this.totalOutputTokens * this.costPerOutputToken;
    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
      totalTokens: this.totalInputTokens + this.totalOutputTokens
    };
  }

  /**
   * 統計情報をリセット
   */
  reset() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}

// 使用例
const usageTracker = new TokenUsageTracker();

// APIレスポンス受信時
const response = await claudeAPI.call(prompt);
usageTracker.recordUsage(response.usage.input_tokens, response.usage.output_tokens);

console.log('推定費用:', usageTracker.getEstimatedCost());
```

## 5.7 UIでのAI機能の統用

### 5.7.1 ローディング状態の管理

```javascript
class UIFeedback {
  static showLoading(message = 'AI処理中...') {
    const loader = document.createElement('div');
    loader.id = 'loader';
    loader.className = 'loader';
    loader.innerHTML = `
      <div class="spinner"></div>
      <p>${message}</p>
    `;
    document.body.appendChild(loader);
    return loader;
  }

  static hideLoading() {
    const loader = document.getElementById('loader');
    if (loader) loader.remove();
  }

  static showSuccess(message) {
    this.showNotification(message, 'success');
  }

  static showError(message) {
    this.showNotification(message, 'error');
  }

  static showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => notification.remove(), 3000);
  }
}
```

### 5.7.2 AIボタンのUIパターン

```html
<div class="trip-actions">
  <button class="btn-ai" id="enhanceTripBtn">
    ✨ AIで説明を生成
  </button>
  <button class="btn-ai" id="suggestRouteBtn">
    🗺️ 最適なルートを提案
  </button>
</div>
```

```javascript
document.getElementById('enhanceTripBtn').addEventListener('click', async () => {
  UIFeedback.showLoading('トリップの説明を生成中...');

  try {
    const trip = getCurrentTrip();
    const enhanced = await aiTripManager.enhanceTrip(trip);
    UIFeedback.hideLoading();
    UIFeedback.showSuccess('説明を生成しました！');
    updateTripUI(enhanced);
  } catch (error) {
    UIFeedback.hideLoading();
    UIFeedback.showError('説明の生成に失敗しました');
    console.error(error);
  }
});
```

---

**次章へ**: 第6章では、Firebaseを使用したデータの永続化とリアルタイム同期を実装します。
