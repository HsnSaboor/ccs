
import * as http from 'http';

export class GeminiService {
  private targetPort: number;
  private primaryModel = 'gemini-3-flash'; // User requested this
  private fallbackModel = 'gemini-2.5-flash';

  constructor(targetPort: number) {
    this.targetPort = targetPort;
  }

  async executeWebSearch(token: string, messages: any[]): Promise<any[]> {
    const contents = this.transformMessages(messages);
    
    const payload = {
      contents,
      tools: [{ googleSearch: {} }],
    };

    try {
        const response = await this.callGemini(token, payload, this.primaryModel);
        return this.transformResponse(response, this.primaryModel);
    } catch (e) {
        // Fallback
        const response = await this.callGemini(token, payload, this.fallbackModel);
        return this.transformResponse(response, this.fallbackModel);
    }
  }

  private transformMessages(messages: any[]): any[] {
    // Simple transformation: Merge user/assistant messages into Gemini contents
    // Gemini expects: { role: 'user'|'model', parts: [{ text: '...' }] }
    const contents: any[] = [];
    
    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user';
      let text = '';
      
      if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');
      } else {
        text = msg.content || '';
      }

      if (text) {
        contents.push({
          role,
          parts: [{ text }]
        });
      }
    }
    
    return contents;
  }

  private async callGemini(token: string, payload: any, model: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.targetPort,
        path: `/v1beta/models/${model}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Gemini API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private transformResponse(response: any, model: string): any[] {
    // Convert Gemini response to Anthropic SSE events
    // Gemini response: { candidates: [{ content: { parts: [...] } }] }
    // Anthropic SSE: message_start, content_block_start, ..., message_stop
    
    const events: any[] = [];
    
    // 1. Message Start
    events.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_' + Date.now(),
          type: 'message',
          role: 'assistant',
          content: [],
          model: model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    });

    // 2. Content
    const candidate = response.candidates?.[0];
    if (candidate?.content?.parts) {
      let fullText = '';
      for (const part of candidate.content.parts) {
        if (part.text) {
          fullText += part.text;
        }
      }

      // Handle grounding (search citations)
      if (candidate.groundingMetadata?.groundingChunks) {
        const chunks = candidate.groundingMetadata.groundingChunks;
        if (chunks.length > 0) {
          fullText += '\n\n--- Sources ---\n';
          chunks.forEach((chunk: any, i: number) => {
            if (chunk.web?.uri) {
              fullText += `[${i + 1}] ${chunk.web.title || 'Source'}: ${chunk.web.uri}\n`;
            }
          });
        }
      }

      if (fullText) {
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
          }
        });
        
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fullText }
          }
        });
        
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: 0 }
        });
      }
    }

    // 3. Message Stop
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 }
      }
    });
    
    events.push({
      event: 'message_stop',
      data: { type: 'message_stop' }
    });

    return events;
  }
}
