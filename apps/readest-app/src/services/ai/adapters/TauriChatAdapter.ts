import type { ChatModelAdapter, ChatModelRunResult } from '@assistant-ui/react';
import { hybridSearch, isBookIndexed } from '../ragService';
import { aiLogger } from '../logger';
import { buildSystemPrompt } from '../prompts';
import type { AISettings, ScoredChunk } from '../types';

let lastSources: ScoredChunk[] = [];

export function getLastSources(): ScoredChunk[] {
  return lastSources;
}

export function clearLastSources(): void {
  lastSources = [];
}

interface TauriAdapterOptions {
  settings: AISettings;
  bookHash: string;
  bookTitle: string;
  authorName: string;
  currentPage: number;
}

/** Parse a single SSE `data: ...` line and return the content delta, or null if done. */
function parseSSELine(line: string): { content: string | null; done: boolean } {
  if (!line.startsWith('data: ')) return { content: null, done: false };
  const data = line.slice(6).trim();
  if (data === '[DONE]') return { content: null, done: true };
  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta?.content;
    return { content: delta ?? null, done: false };
  } catch {
    return { content: null, done: false };
  }
}

/** Stream text from an OpenAI-compatible /chat/completions SSE endpoint. */
async function* streamOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const allMessages = [{ role: 'system', content: system }, ...messages];

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages: allMessages, stream: true }),
    signal: abortSignal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`API error ${response.status}: ${body}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const { content, done: streamDone } = parseSSELine(trimmed);
      if (streamDone) return;
      if (content) yield content;
    }
  }
}

/** Stream text from Ollama /api/chat NDJSON endpoint. */
async function* streamOllama(
  baseUrl: string,
  model: string,
  system: string,
  messages: Array<{ role: string; content: string }>,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/chat`;
  const allMessages = [{ role: 'system', content: system }, ...messages];

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: allMessages, stream: true }),
    signal: abortSignal,
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.done) return;
        if (parsed.message?.content) yield parsed.message.content;
      } catch {
        // skip malformed lines
      }
    }
  }
}

function buildErrorMessage(error: unknown, settings: AISettings): string {
  const msg = (error as Error).message;
  const name = (error as Error).name;

  if (name === 'AI_APICallError') {
    if (settings.provider === 'ollama') {
      return `Connection to Ollama failed.\n\nMake sure Ollama is running locally and the model "${settings.ollamaModel || 'llama3.2'}" is available.\n\nCheck: \`ollama serve\` then \`ollama list\``;
    }
    return `AI API call failed: ${msg}`;
  }

  if (msg.includes('API key') || msg.includes('apiKey')) {
    return `AI provider configuration error.\n\nPlease check your API key in Settings > AI.`;
  }

  return `Error: ${msg}`;
}

export function createTauriAdapter(getOptions: () => TauriAdapterOptions): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }): AsyncGenerator<ChatModelRunResult> {
      const options = getOptions();
      const { settings, bookHash, bookTitle, authorName, currentPage } = options;

      try {
        let chunks: ScoredChunk[] = [];

        const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
        const query =
          lastUserMessage?.content
            ?.filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join(' ') || '';

        aiLogger.chat.send(query.length, false);

        if (await isBookIndexed(bookHash)) {
          try {
            chunks = await hybridSearch(
              bookHash,
              query,
              settings,
              settings.maxContextChunks || 5,
              settings.spoilerProtection ? currentPage : undefined,
            );
            aiLogger.chat.context(chunks.length, chunks.map((c) => c.text).join('').length);
            lastSources = chunks;
          } catch (e) {
            aiLogger.chat.error(`RAG failed: ${(e as Error).message}`);
            lastSources = [];
          }
        } else {
          lastSources = [];
        }

        const systemPrompt = buildSystemPrompt(bookTitle, authorName, chunks, currentPage);

        const aiMessages = messages.map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        }));

        let text = '';
        const provider = settings.provider;

        if (provider === 'ollama') {
          const baseUrl = settings.ollamaBaseUrl || 'http://127.0.0.1:11434';
          const model = settings.ollamaModel || 'llama3.2';
          for await (const chunk of streamOllama(
            baseUrl,
            model,
            systemPrompt,
            aiMessages,
            abortSignal,
          )) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        } else if (provider === 'openai-compatible') {
          const baseUrl = settings.openaiCompatibleBaseUrl || 'https://api.deepseek.com';
          const apiKey = settings.openaiCompatibleApiKey || '';
          const model = settings.openaiCompatibleModel || 'deepseek-chat';
          if (!apiKey) throw new Error('API key is required for OpenAI Compatible provider');
          for await (const chunk of streamOpenAICompatible(
            baseUrl,
            apiKey,
            model,
            systemPrompt,
            aiMessages,
            abortSignal,
          )) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        } else if (provider === 'ai-gateway') {
          const apiKey = settings.aiGatewayApiKey || '';
          const model = settings.aiGatewayModel || 'google/gemini-2.5-flash-lite';
          if (!apiKey) throw new Error('API key is required for AI Gateway');
          // AI Gateway uses the same OpenAI-compatible format
          for await (const chunk of streamOpenAICompatible(
            'https://gateway.ai.cloudflare.com/v1',
            apiKey,
            model,
            systemPrompt,
            aiMessages,
            abortSignal,
          )) {
            text += chunk;
            yield { content: [{ type: 'text', text }] };
          }
        } else {
          throw new Error(`Unknown provider: ${provider}`);
        }

        aiLogger.chat.complete(text.length);
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;

        aiLogger.chat.error((error as Error).message);

        const friendlyMessage = buildErrorMessage(error, settings);
        yield { content: [{ type: 'text', text: friendlyMessage }] };
      }
    },
  };
}
