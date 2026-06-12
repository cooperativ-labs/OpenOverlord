import { GoogleGenAI } from '@google/genai';

import { readGeminiConfigFromEnv } from './config.js';

let cachedClient: GoogleGenAI | null | undefined;

export function getGeminiClient(env: NodeJS.ProcessEnv = process.env): GoogleGenAI | null {
  if (cachedClient !== undefined) {
    return cachedClient;
  }

  const config = readGeminiConfigFromEnv(env);
  cachedClient = config ? new GoogleGenAI({ apiKey: config.apiKey }) : null;
  return cachedClient;
}

export function resetGeminiClientForTests(): void {
  cachedClient = undefined;
}

export async function generateGeminiText(params: {
  prompt: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  env?: NodeJS.ProcessEnv;
  logPrefix?: string;
}): Promise<string | null> {
  const {
    prompt,
    systemInstruction,
    temperature = 0.3,
    maxOutputTokens = 256,
    env = process.env,
    logPrefix = '[automations/title-summarizer/gemini]'
  } = params;

  const client = getGeminiClient(env);
  const config = readGeminiConfigFromEnv(env);
  if (!client || !config) {
    console.warn(`${logPrefix} GEMINI_API_KEY not set`);
    return null;
  }

  try {
    const response = await client.models.generateContent({
      model: config.model,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        temperature,
        maxOutputTokens
      }
    });

    const text = (response.text ?? '').trim();
    return text || null;
  } catch (error) {
    console.warn(`${logPrefix} Gemini call failed:`, error);
    return null;
  }
}
