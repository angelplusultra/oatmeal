import { getLlama, LlamaChatSession, type Llama, type LlamaContext, type LlamaContextSequence, type LlamaGrammar, type LlamaModel } from 'node-llama-cpp'
import type { JsonSchema, LlmClient } from '@shared/summarize'
import { createCompactJsonGrammar } from './grammar'

/** llama.cpp via node-llama-cpp (Metal on Apple Silicon). Output is constrained by a JSON-schema grammar. */
export class LocalLlm implements LlmClient {
  private context: LlamaContext | null = null
  private sequence: LlamaContextSequence | null = null
  private contextSize = 0
  private readonly grammars = new Map<JsonSchema, LlamaGrammar>()

  private constructor(
    private readonly llama: Llama,
    private readonly model: LlamaModel,
    readonly modelName: string,
  ) {}

  static async load(modelPath: string, modelName: string): Promise<LocalLlm> {
    const llama = await getLlama()
    const model = await llama.loadModel({ modelPath })
    return new LocalLlm(llama, model, modelName)
  }

  countTokens(text: string): number {
    return this.model.tokenize(text).length
  }

  /** Sizes the context to the request instead of the model's maximum, which keeps KV-cache memory small. */
  // A context has a fixed pool of sequences and a disposed sequence is not returned to it, so we keep one
  // sequence per context and clear its history between calls.
  private async sequenceFor(tokens: number): Promise<LlamaContextSequence> {
    const needed = Math.min(this.model.trainContextSize, Math.ceil((tokens + 512) / 1024) * 1024)
    if (this.context && this.sequence && this.contextSize >= needed) {
      await this.sequence.clearHistory()
      return this.sequence
    }
    await this.context?.dispose()
    this.context = await this.model.createContext({ contextSize: needed })
    this.sequence = this.context.getSequence()
    this.contextSize = needed
    return this.sequence
  }

  async generateJson({ system, prompt, schema, maxTokens }: { system: string; prompt: string; schema: JsonSchema; maxTokens: number }) {
    let grammar = this.grammars.get(schema)
    if (!grammar) {
      grammar = await createCompactJsonGrammar(this.llama, schema)
      this.grammars.set(schema, grammar)
    }
    const sequence = await this.sequenceFor(this.countTokens(system) + this.countTokens(prompt) + maxTokens + 64)
    const session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system, autoDisposeSequence: false })
    try {
      const text = await session.prompt(prompt, { grammar, maxTokens, temperature: 0.2 })
      return JSON.parse(text)
    } finally {
      session.dispose({ disposeSequence: false })
    }
  }

  async dispose() {
    await this.context?.dispose()
    await this.model.dispose()
  }
}

/** Any OpenAI-compatible server: Ollama (which uses MLX on Apple Silicon), LM Studio, llama-server… */
export class EndpointLlm implements LlmClient {
  readonly modelName: string

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey: string,
  ) {
    this.modelName = `${model} @ ${new URL(baseUrl).host}`
  }

  /** Rough count; only used to size transcript chunks. */
  countTokens(text: string): number {
    return Math.ceil(text.length / 3.5)
  }

  async generateJson({ system, prompt, schema, maxTokens }: { system: string; prompt: string; schema: JsonSchema; maxTokens: number }) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'meeting_notes', schema } },
      }),
    })
    if (!res.ok) throw new Error(`Endpoint returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const content = body.choices?.[0]?.message?.content ?? ''
    const json = content.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')
    try {
      return JSON.parse(json)
    } catch {
      throw new Error(`Endpoint did not return valid JSON: ${content.slice(0, 200)}`)
    }
  }

  async dispose() {}
}
