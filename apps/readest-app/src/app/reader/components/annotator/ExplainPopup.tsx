import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FaBrain } from 'react-icons/fa';
import Popup from '@/components/Popup';
import { Position } from '@/utils/sel';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { hybridSearch, isBookIndexed } from '@/services/ai/ragService';
import { aiStore } from '@/services/ai/storage/aiStore';
import { aiLogger } from '@/services/ai/logger';
import type { ScoredChunk } from '@/services/ai/types';

interface ExplainPopupProps {
  text: string;
  contextText?: string;
  position: Position;
  trianglePosition: Position;
  popupWidth: number;
  popupHeight: number;
  onDismiss?: () => void;
  bookKey: string;
  currentPage: number;
  bookTitle?: string;
  authorName?: string;
}

type ExplainState = 'idle' | 'loading' | 'streaming' | 'done' | 'error';

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

/** Parse a single SSE `data: ...` line and return the content delta. */
function parseSSEContent(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    return parsed.choices?.[0]?.delta?.content || null;
  } catch {
    return null;
  }
}

/** Parse an Ollama NDJSON line. */
function parseOllamaContent(line: string): { content: string | null; done: boolean } {
  try {
    const parsed = JSON.parse(line);
    return {
      content: parsed.message?.content || null,
      done: parsed.done === true,
    };
  } catch {
    return { content: null, done: false };
  }
}

/** Stream from an OpenAI-compatible /chat/completions SSE endpoint. */
async function* streamOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      stream: true,
    }),
    signal,
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
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const content = parseSSEContent(trimmed);
      if (content) yield content;
    }
  }
}

/** Stream from Ollama /api/chat NDJSON endpoint. */
async function* streamOllama(
  baseUrl: string,
  model: string,
  systemPrompt: string,
  userText: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/chat`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ],
      stream: true,
    }),
    signal,
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
      const { content, done: streamDone } = parseOllamaContent(trimmed);
      if (streamDone) return;
      if (content) yield content;
    }
  }
}

const ExplainPopup: React.FC<ExplainPopupProps> = ({
  text,
  contextText,
  position,
  trianglePosition,
  popupWidth,
  popupHeight,
  onDismiss,
  bookKey,
  currentPage,
  bookTitle,
  authorName,
}) => {
  const _ = useTranslation();
  const { settings } = useSettingsStore();
  const abortRef = useRef<AbortController | null>(null);

  const [state, setState] = useState<ExplainState>('idle');
  const [explanation, setExplanation] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [chunks, setChunks] = useState<ScoredChunk[]>([]);

  const buildPrompt = useCallback(
    (selectedText: string, contextChunks: ScoredChunk[], paragraphContext: string) => {
      const hasContext = contextChunks.length > 0;
      const hasParagraph = paragraphContext.length > 0;
      const contextSection = hasContext
        ? `\n\n<BOOK_PASSAGES>\n${contextChunks
            .map(
              (c) =>
                `[${c.chapterTitle || `Section ${c.sectionIndex + 1}`}, Page ${c.pageNumber}]\n${c.text}`,
            )
            .join('\n\n')}\n</BOOK_PASSAGES>`
        : '';
      const paragraphSection = hasParagraph
        ? `\n\n<PARAGRAPH_CONTEXT>\nThe selected text appears within the following paragraph:\n${paragraphContext}\n</PARAGRAPH_CONTEXT>`
        : '';
      const bookInfo = [bookTitle, authorName].filter(Boolean).join(' by ');
      const wordCount = selectedText.split(/\s+/).filter(Boolean).length;
      const isTerm = wordCount < 3 && selectedText.length < 20;
      const constraints = hasParagraph
        ? `You have the full paragraph where the selected text appears. Use it as PRIMARY context to explain the meaning, tone, and role of the selected text within its surrounding passage.${hasContext ? ' Additional book passages are also provided for broader context.' : ''} If the paragraph context lacks sufficient detail, you may supplement with general knowledge about the book.`
        : hasContext
          ? `PREFER the provided book passages when they contain relevant information. If the passages don't fully cover the selected text, you may supplement with your general knowledge about ${bookInfo || 'the book'}.`
          : `No book passages are available for reference. Answer based on your general knowledge about ${bookInfo || 'the topic'}.`;
      const instruction = isTerm
        ? `Explain the selected word or phrase. Structure your response into two parts:\n1. Its general meaning and definition\n2. How it is used or what it means specifically in this context${hasParagraph ? ', based on the paragraph where it appears' : hasContext ? ', based on the provided passages' : ''}`
        : `Explain the selected passage. Structure your response into two parts:\n1. What this passage means${hasParagraph ? ' within its paragraph context' : ''}\n2. Its significance and role in the surrounding narrative${hasParagraph ? ', using the paragraph context to show how it connects to what comes before and after' : hasContext ? ', based on the provided passages' : ''}`;
      return `<SYSTEM>\nYou are a knowledgeable reading companion for "${bookInfo || 'the current book'}"\n\n${instruction}\n\n${constraints}\n- Keep explanations concise but thorough\n- Use the same language as the user's question when possible\n</SYSTEM>\n\n"""\n${selectedText}\n"${paragraphSection}${contextSection}`;
    },
    [bookTitle, authorName],
  );

  const fetchExplanation = async () => {
    if (!text.trim()) return;

    const abortController = new AbortController();
    abortRef.current = abortController;
    setState('loading');
    setExplanation('');
    setErrorMsg(null);

    // Check explanation cache (skip empty cached results)
    const cacheId = `${bookKey}:${hashText(text)}`;
    try {
      const cached = await aiStore.getExplanation(cacheId);
      if (cached && cached.explanation && cached.explanation.length > 0) {
        aiLogger.cache.hit(cacheId);
        setExplanation(cached.explanation);
        setState('done');
        return;
      }
    } catch {
      /* ignore cache errors */
    }
    aiLogger.cache.miss(cacheId);

    try {
      // 1. Retrieve RAG context if book is indexed
      let contextChunks: ScoredChunk[] = [];
      try {
        if (await isBookIndexed(bookKey)) {
          const searchQuery =
            text.split(/\s+/).filter(Boolean).length < 4 && bookTitle
              ? `${text} ${bookTitle}`
              : text;
          contextChunks = await hybridSearch(
            bookKey,
            searchQuery,
            settings.aiSettings,
            settings.aiSettings.maxContextChunks || 8,
            settings.aiSettings.spoilerProtection ? currentPage : undefined,
          );
        }
      } catch {
        /* RAG failure is non-fatal */
      }
      setChunks(contextChunks);

      // 2. Build prompt and stream from the AI provider
      const systemPrompt = buildPrompt(text, contextChunks, contextText || '');
      const aiSettings = settings.aiSettings;
      const providerName = aiSettings.provider;
      const userText = text;

      setState('streaming');
      let fullText = '';

      if (providerName === 'ollama') {
        const baseUrl = aiSettings.ollamaBaseUrl || 'http://127.0.0.1:11434';
        const model = aiSettings.ollamaModel || 'llama3.2';
        for await (const chunk of streamOllama(
          baseUrl,
          model,
          systemPrompt,
          userText,
          abortController.signal,
        )) {
          fullText += chunk;
          setExplanation(fullText);
        }
      } else if (providerName === 'openai-compatible') {
        const baseUrl = (aiSettings.openaiCompatibleBaseUrl || 'https://api.deepseek.com').replace(
          /\/+$/,
          '',
        );
        const apiKey = aiSettings.openaiCompatibleApiKey || '';
        const model = aiSettings.openaiCompatibleModel || 'deepseek-chat';
        if (!apiKey)
          throw new Error(_('API key is missing. Please configure it in Settings > AI.'));
        for await (const chunk of streamOpenAICompatible(
          baseUrl,
          apiKey,
          model,
          systemPrompt,
          userText,
          abortController.signal,
        )) {
          fullText += chunk;
          setExplanation(fullText);
        }
      } else if (providerName === 'ai-gateway') {
        const apiKey = aiSettings.aiGatewayApiKey || '';
        const model = aiSettings.aiGatewayModel || 'google/gemini-2.5-flash-lite';
        if (!apiKey) throw new Error(_('API key is missing for AI Gateway.'));
        for await (const chunk of streamOpenAICompatible(
          'https://gateway.ai.cloudflare.com/v1',
          apiKey,
          model,
          systemPrompt,
          userText,
          abortController.signal,
        )) {
          fullText += chunk;
          setExplanation(fullText);
        }
      } else {
        throw new Error(`Unknown provider: ${providerName}`);
      }

      if (!fullText) {
        throw new Error(_('AI returned an empty response. Please try again.'));
      }

      // Cache the explanation
      const modelName =
        providerName === 'openai-compatible'
          ? aiSettings.openaiCompatibleModel || 'deepseek-chat'
          : aiSettings.aiGatewayModel || 'google/gemini-2.5-flash-lite';
      aiStore
        .saveExplanation({
          id: cacheId,
          bookHash: bookKey,
          textHash: hashText(text),
          selectedText: text,
          explanation: fullText,
          model: modelName,
          timestamp: Date.now(),
        })
        .then(() => aiLogger.cache.save(cacheId));

      setState('done');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setState('idle');
        return;
      }
      console.error('[ExplainPopup]', err);
      setErrorMsg((err as Error).message || _('Failed to get explanation. Please try again.'));
      setState('error');
    }
  };

  useEffect(() => {
    fetchExplanation();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, bookKey]);

  const handleRegenerate = () => {
    fetchExplanation();
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(explanation);
  };

  return (
    <div>
      <Popup
        trianglePosition={trianglePosition}
        width={popupWidth}
        minHeight={popupHeight}
        maxHeight={720}
        position={position}
        className='not-eink:text-white grid h-full select-text grid-rows-[1fr,auto] bg-gray-600'
        triangleClassName='text-gray-600'
        onDismiss={onDismiss}
      >
        {/* Header: selected text */}
        <div className='overflow-y-auto p-4 font-sans'>
          <div className='mb-2 flex items-center justify-between'>
            <h1 className='text-sm font-normal'>{_('Selected Text')}</h1>
          </div>
          <p className='not-eink:text-white/90 line-clamp-3 text-base italic'>{text}</p>
        </div>

        <div className='mx-4 flex-shrink-0 border-t border-gray-500/30'></div>

        {/* Body: explanation or loading/error */}
        <div className='overflow-y-auto px-4 pb-8 pt-4 font-sans'>
          <div className='mb-2 flex items-center justify-between'>
            <h2 className='flex items-center gap-1.5 text-sm font-normal'>
              <FaBrain size={14} />
              {_('AI Explanation')}
            </h2>
          </div>

          {(state === 'loading' || state === 'streaming') && (
            <div className='prose prose-sm prose-invert prose-headings:text-white prose-p:text-white prose-strong:text-white prose-li:text-white max-w-none text-white'>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{explanation || ''}</ReactMarkdown>
              {!explanation && (
                <span className='italic text-gray-400'>{_('Waiting for response...')}</span>
              )}
              <span className='animate-pulse'>▌</span>
            </div>
          )}

          {state === 'done' && (
            <div>
              {explanation ? (
                <div className='prose prose-sm prose-invert prose-headings:text-white prose-p:text-white prose-strong:text-white prose-li:text-white max-w-none text-white'>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{explanation}</ReactMarkdown>
                </div>
              ) : (
                <span className='text-white'>{_('No explanation returned.')}</span>
              )}
            </div>
          )}

          {state === 'error' && (
            <div>
              <p className='text-base text-red-400'>{errorMsg}</p>
              <button
                className='mt-2 text-xs text-blue-400 hover:text-blue-300'
                onClick={handleRegenerate}
              >
                {_('Retry')}
              </button>
            </div>
          )}

          {chunks.length > 0 && state === 'done' && (
            <div className='mt-4 rounded bg-gray-500/20 p-2'>
              <p className='text-xs opacity-60'>
                {_('Context references: {{count}} passages', { count: String(chunks.length) })}
              </p>
            </div>
          )}
        </div>

        {/* Footer: action buttons */}
        <div className='absolute bottom-0 flex h-8 w-full items-center gap-2 px-4'>
          {state === 'done' && (
            <button
              className='text-xs opacity-60 hover:opacity-100'
              onClick={handleCopy}
              title={_('Copy explanation')}
            >
              {_('Copy')}
            </button>
          )}
          {(state === 'done' || state === 'error') && (
            <button
              className='text-xs opacity-60 hover:opacity-100'
              onClick={handleRegenerate}
              title={_('Regenerate')}
            >
              {_('Regenerate')}
            </button>
          )}
        </div>
      </Popup>
    </div>
  );
};

export default ExplainPopup;
