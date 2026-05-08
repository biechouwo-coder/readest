import { embed, embedMany } from 'ai';
import { aiStore } from './storage/aiStore';
import { chunkSection, extractTextFromDocument } from './utils/chunker';
import { withRetryAndTimeout, AI_TIMEOUTS, AI_RETRY_CONFIGS } from './utils/retry';
import { getAIProvider } from './providers';
import { aiLogger } from './logger';
import type { AISettings, TextChunk, ScoredChunk, EmbeddingProgress, BookIndexMeta } from './types';

function isWebMode(): boolean {
  return typeof window !== 'undefined';
}

function needsProxy(settings: AISettings): boolean {
  return settings.provider === 'openai-compatible' || settings.provider === 'ai-gateway';
}

async function embedSingleViaApiRoute(query: string, settings: AISettings): Promise<number[]> {
  const response = await fetch('/api/ai/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      texts: [query],
      single: true,
      provider: settings.provider,
      apiKey:
        settings.provider === 'openai-compatible'
          ? settings.openaiCompatibleApiKey
          : settings.aiGatewayApiKey,
      model:
        settings.provider === 'openai-compatible'
          ? settings.openaiCompatibleEmbeddingModel || 'deepseek-embedding'
          : settings.aiGatewayEmbeddingModel || 'text-embedding-3-small',
      baseURL: settings.openaiCompatibleBaseUrl || 'https://api.deepseek.com',
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `Embed failed: ${response.status}`);
  }

  const data = await response.json();
  return data.embedding;
}

async function embedBatchViaApiRoute(texts: string[], settings: AISettings): Promise<number[][]> {
  const response = await fetch('/api/ai/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      texts,
      single: false,
      provider: settings.provider,
      apiKey:
        settings.provider === 'openai-compatible'
          ? settings.openaiCompatibleApiKey
          : settings.aiGatewayApiKey,
      model:
        settings.provider === 'openai-compatible'
          ? settings.openaiCompatibleEmbeddingModel || 'deepseek-embedding'
          : settings.aiGatewayEmbeddingModel || 'text-embedding-3-small',
      baseURL: settings.openaiCompatibleBaseUrl || 'https://api.deepseek.com',
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `Embed failed: ${response.status}`);
  }

  const data = await response.json();
  return data.embeddings;
}

// Simple stopwords set (English-only, sufficient for keyword extraction)
const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'by',
  'with',
  'from',
  'as',
  'is',
  'was',
  'are',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'he',
  'she',
  'we',
  'they',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'their',
  'our',
  'not',
  'no',
  'nor',
  'so',
  'up',
  'if',
  'about',
  'into',
  'over',
  'after',
  'before',
  'between',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'each',
  'every',
  'both',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'own',
  'same',
  'too',
  'very',
  'just',
  'also',
  'than',
  'what',
  'which',
  'who',
  'whom',
  'while',
]);

// Expand short queries via pseudo-relevance feedback from vector search results
function expandQuery(query: string, topChunks: ScoredChunk[]): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length >= 5) return query;

  // collect significant terms from top chunks
  const termFreq = new Map<string, number>();
  const chunkTexts = topChunks.slice(0, 3).map((c) => c.text.toLowerCase());

  for (const text of chunkTexts) {
    const tokens = text
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t) && /^[a-zA-Z]/.test(t));
    const seen = new Set<string>();
    for (const token of tokens) {
      if (!seen.has(token)) {
        termFreq.set(token, (termFreq.get(token) || 0) + 1);
        seen.add(token);
      }
    }
  }

  const expansions = Array.from(termFreq.entries())
    .filter(([, freq]) => freq >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([term]) => term)
    .filter((term) => !words.includes(term));

  if (expansions.length === 0) return query;
  const expanded = `${query} ${expansions.join(' ')}`;
  aiLogger.search.expanded(query, expanded);
  return expanded;
}

// Re-rank results with content overlap scoring and diversity enforcement
function rerankResults(query: string, results: ScoredChunk[], topK: number): ScoredChunk[] {
  if (results.length === 0) return [];

  // Build character-level 3-gram set for the query
  const queryGrams = new Set<string>();
  const q = query.toLowerCase();
  for (let i = 0; i < q.length - 2; i++) {
    queryGrams.add(q.slice(i, i + 3));
  }

  const maxVector = Math.max(
    ...results.map((r) =>
      r.searchMethod === 'vector' || r.searchMethod === 'hybrid' ? r.score : 0,
    ),
    0.001,
  );
  const maxBM25 = Math.max(
    ...results.map((r) => (r.searchMethod === 'bm25' || r.searchMethod === 'hybrid' ? r.score : 0)),
    0.001,
  );

  const scores = new Map<ScoredChunk, number>();
  for (const r of results) {
    const chunkGrams = new Set<string>();
    const ct = r.text.toLowerCase();
    for (let i = 0; i < ct.length - 2; i++) {
      chunkGrams.add(ct.slice(i, i + 3));
    }

    let overlap = 0;
    if (queryGrams.size > 0) {
      for (const g of queryGrams) {
        if (chunkGrams.has(g)) overlap++;
      }
    }
    const contentScore = queryGrams.size > 0 ? overlap / queryGrams.size : 0;

    const vecScore =
      r.searchMethod === 'vector' || r.searchMethod === 'hybrid' ? r.score / maxVector : 0;
    const bm25Score =
      r.searchMethod === 'bm25' || r.searchMethod === 'hybrid' ? r.score / maxBM25 : 0;

    scores.set(r, vecScore * 0.4 + bm25Score * 0.3 + contentScore * 0.3);
  }

  // Sort by rerank score descending
  results.sort((a, b) => (scores.get(b) || 0) - (scores.get(a) || 0));

  // Diversity: max 2 per section, remove near-duplicates
  const sectionCount = new Map<number, number>();
  const seenTexts = new Set<string>();
  const diverse: ScoredChunk[] = [];

  for (const r of results) {
    const secCount = sectionCount.get(r.sectionIndex) || 0;
    if (secCount >= 2) continue;

    // dedup: skip if text is >80% similar to an already-selected chunk
    const textKey = r.text.slice(0, 80);
    let isDuplicate = false;
    for (const seen of seenTexts) {
      let shared = 0;
      for (let i = 0; i < Math.min(textKey.length, seen.length); i++) {
        if (textKey[i] === seen[i]) shared++;
      }
      const ratio = shared / Math.max(textKey.length, seen.length);
      if (ratio > 0.8) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    sectionCount.set(r.sectionIndex, secCount + 1);
    seenTexts.add(textKey);
    diverse.push(r);
    if (diverse.length >= topK) break;
  }

  aiLogger.search.rerank(results.length, diverse.length);
  return diverse;
}

interface SectionItem {
  id: string;
  size: number;
  linear: string;
  createDocument: () => Promise<Document>;
}

interface TOCItem {
  id: number;
  label: string;
  href?: string;
}

export interface BookDocType {
  sections?: SectionItem[];
  toc?: TOCItem[];
  metadata?: { title?: string | { [key: string]: string }; author?: string | { name?: string } };
}

const indexingStates = new Map<string, IndexingState>();

export async function isBookIndexed(bookHash: string): Promise<boolean> {
  const indexed = await aiStore.isIndexed(bookHash);
  aiLogger.rag.isIndexed(bookHash, indexed);
  return indexed;
}

function extractTitle(metadata?: BookDocType['metadata']): string {
  if (!metadata?.title) return 'Unknown Book';
  if (typeof metadata.title === 'string') return metadata.title;
  return (
    metadata.title['en'] ||
    metadata.title['default'] ||
    Object.values(metadata.title)[0] ||
    'Unknown Book'
  );
}

function extractAuthor(metadata?: BookDocType['metadata']): string {
  if (!metadata?.author) return 'Unknown Author';
  if (typeof metadata.author === 'string') return metadata.author;
  return metadata.author.name || 'Unknown Author';
}

function getChapterTitle(toc: TOCItem[] | undefined, sectionIndex: number): string {
  if (!toc || toc.length === 0) return `Section ${sectionIndex + 1}`;
  for (let i = toc.length - 1; i >= 0; i--) {
    if (toc[i]!.id <= sectionIndex) return toc[i]!.label;
  }
  return toc[0]?.label || `Section ${sectionIndex + 1}`;
}

export async function indexBook(
  bookDoc: BookDocType,
  bookHash: string,
  settings: AISettings,
  onProgress?: (progress: EmbeddingProgress) => void,
): Promise<void> {
  const startTime = Date.now();
  const title = extractTitle(bookDoc.metadata);

  if (await aiStore.isIndexed(bookHash)) {
    aiLogger.rag.isIndexed(bookHash, true);
    return;
  }

  aiLogger.rag.indexStart(bookHash, title);
  const provider = getAIProvider(settings);
  const sections = bookDoc.sections || [];
  const toc = bookDoc.toc || [];

  // calculate cumulative character sizes like toc.ts does
  const sizes = sections.map((s) => (s.linear !== 'no' && s.size > 0 ? s.size : 0));
  let cumulative = 0;
  const cumulativeSizes = sizes.map((size) => {
    const current = cumulative;
    cumulative += size;
    return current;
  });

  const state: IndexingState = {
    bookHash,
    status: 'indexing',
    progress: 0,
    chunksProcessed: 0,
    totalChunks: 0,
  };
  indexingStates.set(bookHash, state);

  try {
    onProgress?.({ current: 0, total: 1, phase: 'chunking' });
    aiLogger.rag.indexProgress('chunking', 0, sections.length);
    const allChunks: TextChunk[] = [];

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      try {
        const doc = await section.createDocument();
        const text = extractTextFromDocument(doc);
        if (text.length < 100) continue;
        const sectionChunks = chunkSection(
          doc,
          i,
          getChapterTitle(toc, i),
          bookHash,
          cumulativeSizes[i] ?? 0,
        );
        aiLogger.chunker.section(i, text.length, sectionChunks.length);
        allChunks.push(...sectionChunks);
      } catch (e) {
        aiLogger.chunker.error(i, (e as Error).message);
      }
    }

    aiLogger.chunker.complete(bookHash, allChunks.length);
    state.totalChunks = allChunks.length;

    if (allChunks.length === 0) {
      state.status = 'complete';
      state.progress = 100;
      aiLogger.rag.indexComplete(bookHash, 0, Date.now() - startTime);
      return;
    }

    onProgress?.({ current: 0, total: allChunks.length, phase: 'embedding' });
    const embeddingModelName =
      settings.provider === 'ollama'
        ? settings.ollamaEmbeddingModel
        : settings.provider === 'openai-compatible'
          ? settings.openaiCompatibleEmbeddingModel || 'deepseek-embedding'
          : settings.aiGatewayEmbeddingModel || 'text-embedding-3-small';
    aiLogger.embedding.start(embeddingModelName, allChunks.length);

    const texts = allChunks.map((c) => c.text);
    try {
      let embeddings: number[][];

      if (isWebMode() && needsProxy(settings)) {
        embeddings = await withRetryAndTimeout(
          () => embedBatchViaApiRoute(texts, settings),
          AI_TIMEOUTS.EMBEDDING_BATCH,
          AI_RETRY_CONFIGS.EMBEDDING,
        );
      } else {
        const result = await withRetryAndTimeout(
          () =>
            embedMany({
              model: provider.getEmbeddingModel(),
              values: texts,
            }),
          AI_TIMEOUTS.EMBEDDING_BATCH,
          AI_RETRY_CONFIGS.EMBEDDING,
        );
        embeddings = result.embeddings;
      }

      for (let i = 0; i < allChunks.length; i++) {
        allChunks[i]!.embedding = embeddings[i];
        state.chunksProcessed = i + 1;
        state.progress = Math.round(((i + 1) / allChunks.length) * 100);
      }
      onProgress?.({ current: allChunks.length, total: allChunks.length, phase: 'embedding' });
      aiLogger.embedding.complete(embeddings.length, allChunks.length, embeddings[0]?.length || 0);
    } catch (e) {
      aiLogger.embedding.error('batch', (e as Error).message);
      // Non-fatal: proceed with BM25-only index when embeddings are unavailable
    }

    onProgress?.({ current: 0, total: 2, phase: 'indexing' });
    aiLogger.store.saveChunks(bookHash, allChunks.length);
    await aiStore.saveChunks(allChunks);

    onProgress?.({ current: 1, total: 2, phase: 'indexing' });
    aiLogger.store.saveBM25(bookHash);
    await aiStore.saveBM25Index(bookHash, allChunks);

    const meta: BookIndexMeta = {
      bookHash,
      bookTitle: title,
      authorName: extractAuthor(bookDoc.metadata),
      totalSections: sections.length,
      totalChunks: allChunks.length,
      embeddingModel: embeddingModelName,
      lastUpdated: Date.now(),
    };
    aiLogger.store.saveMeta(meta);
    await aiStore.saveMeta(meta);

    onProgress?.({ current: 2, total: 2, phase: 'indexing' });
    state.status = 'complete';
    state.progress = 100;
    aiLogger.rag.indexComplete(bookHash, allChunks.length, Date.now() - startTime);
  } catch (error) {
    state.status = 'error';
    state.error = (error as Error).message;
    aiLogger.rag.indexError(bookHash, (error as Error).message);
    throw error;
  }
}

export async function hybridSearch(
  bookHash: string,
  query: string,
  settings: AISettings,
  topK = 10,
  maxPage?: number,
): Promise<ScoredChunk[]> {
  aiLogger.search.query(query, maxPage);
  const provider = getAIProvider(settings);
  let queryEmbedding: number[] | null = null;

  try {
    if (isWebMode() && needsProxy(settings)) {
      queryEmbedding = await withRetryAndTimeout(
        () => embedSingleViaApiRoute(query, settings),
        AI_TIMEOUTS.EMBEDDING_SINGLE,
        AI_RETRY_CONFIGS.EMBEDDING,
      );
    } else {
      const { embedding } = await withRetryAndTimeout(
        () =>
          embed({
            model: provider.getEmbeddingModel(),
            value: query,
          }),
        AI_TIMEOUTS.EMBEDDING_SINGLE,
        AI_RETRY_CONFIGS.EMBEDDING,
      );
      queryEmbedding = embedding;
    }
  } catch {
    // bm25 only fallback
  }

  // Query expansion: for short queries, use vector top-results to augment BM25
  let effectiveQuery = query;
  if (queryEmbedding) {
    const previewResults = await aiStore.vectorSearch(bookHash, queryEmbedding, 3, maxPage);
    effectiveQuery = expandQuery(query, previewResults);
  }

  // Fetch more candidates for re-ranking (topK*3)
  const results = await aiStore.hybridSearch(
    bookHash,
    queryEmbedding,
    effectiveQuery,
    topK * 3,
    maxPage,
  );
  const reranked = rerankResults(query, results, topK);
  aiLogger.search.hybridResults(reranked.length, [...new Set(reranked.map((r) => r.searchMethod))]);
  return reranked;
}

export async function clearBookIndex(bookHash: string): Promise<void> {
  aiLogger.store.clear(bookHash);
  await aiStore.clearBook(bookHash);
  indexingStates.delete(bookHash);
}

// internal type for indexing state tracking
interface IndexingState {
  bookHash: string;
  status: 'idle' | 'indexing' | 'complete' | 'error';
  progress: number;
  chunksProcessed: number;
  totalChunks: number;
  error?: string;
}
