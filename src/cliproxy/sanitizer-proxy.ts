
import * as http from 'http';
import { ContentTransformer } from '../glmt/pipeline/content-transformer';
import { SSEParser } from '../glmt/sse-parser';
import { AnthropicTool } from '../glmt/pipeline/types';
import { GeminiService } from './gemini-service';

export class SanitizerProxy {
  private server: http.Server | null = null;
  private port: number | null = null;
  private targetPort: number;
  private transformer: ContentTransformer;
  private toolNameMap: Map<string, string> = new Map(); // Sanitized -> Original
  private geminiService: GeminiService;

  constructor(targetPort: number) {
    this.targetPort = targetPort;
    this.transformer = new ContentTransformer();
    this.geminiService = new GeminiService(targetPort);
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        // Silent startup
        resolve(this.port);
      });
      this.server.on('error', (err) => {
        // Critical error only
        console.error('[SanitizerProxy] Server error:', err);
        reject(err);
      });
    });
  }

  stop(): void {
    if (this.server) {
        this.server.close();
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // Only intercept POST /v1/messages
    if (req.method === 'POST' && req.url?.includes('/messages')) {
      await this.handleMessagesRequest(req, res);
    } else {
      // Pass through everything else - streaming body
      this.proxyRequest(req, res, Buffer.alloc(0), false);
    }
  }

  private async handleMessagesRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: Buffer;
    try {
      body = await this.readBody(req);
    } catch (e) {
      console.error('[SanitizerProxy] Error reading body:', e);
      // Can't do much if body read failed
      res.writeHead(500);
      res.end();
      return;
    }

    try {
      const json = JSON.parse(body.toString());

      // Check for WebSearch tool usage
      const hasWebSearch = json.tools?.some((t: any) => t.name === 'WebSearch');
      
      if (hasWebSearch) {
        // Silent interception
        const token = req.headers.authorization?.replace('Bearer ', '') || '';
        
        if (!token) {
             // Only log critical failure that prevents functionality
             console.error('[SanitizerProxy] No auth token found for WebSearch');
             throw new Error('No auth token');
        }

        try {
            const events = await this.geminiService.executeWebSearch(token, json.messages);
            
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });

            for (const event of events) {
                res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
            }
            res.end();
            return;
        } catch (searchError) {
            // Critical error
            console.error('[SanitizerProxy] Gemini WebSearch failed:', searchError);
        }
      }

      if (json.tools && Array.isArray(json.tools)) {
        // Map original names to sanitized names
        json.tools.forEach((tool: AnthropicTool) => {
          const sanitized = this.transformer['sanitizeToolName'](tool.name);
          if (sanitized !== tool.name) {
            this.toolNameMap.set(sanitized, tool.name);
          }
        });

        // Sanitize tools in request
        json.tools = this.transformer.sanitizeAnthropicTools(json.tools);
      }

      // Proxy modified request
      this.proxyRequest(req, res, Buffer.from(JSON.stringify(json)), true);
    } catch (e) {
      // Critical processing error
      console.error('[SanitizerProxy] Error parsing/processing JSON:', e);
      // Fallback to original body if parsing fails
      this.proxyRequest(req, res, body, true);
    }
  }

  private proxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    bodyModified: boolean
  ) {
    const headers = { ...req.headers };
    
    if (bodyModified) {
      headers['content-length'] = String(body.length);
      // Remove encoding if we modified body (it's now raw json buffer)
      delete headers['content-encoding'];
    }

    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: this.targetPort,
      path: req.url,
      method: req.method,
      headers: headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      // If streaming response, intercept and sanitize tool_use names
      if (bodyModified && proxyRes.headers['content-type']?.includes('text/event-stream')) {
        this.handleStreamingResponse(proxyRes, res);
      } else {
        // Passthrough response
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (e) => {
      console.error('[SanitizerProxy] Proxy error:', e);
      res.writeHead(502);
      res.end();
    });

    if (bodyModified) {
      proxyReq.write(body);
      proxyReq.end();
    } else {
      // If body not modified, pipe original request stream
      // Note: This only works if readBody wasn't called (i.e. handleMessagesRequest didn't run or we are in else block of handleRequest)
      // If we read body and decided to pass original (fallback), we pass bodyModified=true with original body buffer.
      req.pipe(proxyReq);
    }
  }

  private handleStreamingResponse(proxyRes: http.IncomingMessage, res: http.ServerResponse) {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    
    const parser = new SSEParser();
    
    proxyRes.on('data', (chunk) => {
      const events = parser.parse(chunk);
      for (const event of events) {
        if (event.event === 'content_block_start') {
          const data = event.data as any;
          if (data.content_block?.type === 'tool_use') {
            // Restore original tool name
            const sanitizedName = data.content_block.name;
            if (this.toolNameMap.has(sanitizedName)) {
              data.content_block.name = this.toolNameMap.get(sanitizedName);
            }
          }
          // Re-serialize
          res.write(`event: ${event.event}\ndata: ${JSON.stringify(data)}\n\n`);
        } else {
          // Pass through unmodified events
          // We must reconstruct the SSE format: event: ...\ndata: ...\n\n
          // SSEParser returns parsed event/data.
          // Note: SSEParser might swallow comments/ids if not careful, but for Claude it's usually fine.
          // A safer way is to just regex replace on the chunk if we are confident, but chunks can be split.
          // Using SSEParser is safer for logic but we re-serialize.
          res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      }
      
      // If parser has buffer, we wait for more data. 
      // But we must forward 'keep-alive' comments if they exist? SSEParser ignores them.
      // Claude might need them? Usually standard SSE is fine.
    });

    proxyRes.on('end', () => res.end());
  }

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}
