export const DEFAULT_ANSARI_API_BASE = 'https://api.askansari.ai';
export const DEFAULT_ANSARI_CLIENT = 'ansari-faithful-answers';

export type AnsariCompleteRequest = {
  question: string;
};

export type AnswerCompleter = {
  complete(request: AnsariCompleteRequest): Promise<string>;
};

export type AnsariHttpOptions = {
  baseUrl?: string;
  clientName?: string;
  fetchImpl?: typeof fetch;
  authorization?: string;
};

/**
 * Direct POST /api/v2/mcp-complete. Returns the exact text/plain body,
 * including Ansari attribution. No hosted-MCP forwarding.
 */
export function createAnsariHttpCompleter(options: AnsariHttpOptions = {}): AnswerCompleter {
  const baseUrl = (options.baseUrl ?? process.env.ANSARI_API_BASE_URL ?? DEFAULT_ANSARI_API_BASE).replace(
    /\/$/,
    '',
  );
  const clientName = options.clientName ?? process.env.ANSARI_CLIENT ?? DEFAULT_ANSARI_CLIENT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = options.authorization ?? process.env.ANSARI_API_AUTHORIZATION;

  return {
    async complete({ question }) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'X-Ansari-Client': clientName,
      };
      if (authorization) {
        headers.authorization = authorization;
      }
      const response = await fetchImpl(`${baseUrl}/api/v2/mcp-complete`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [{ role: 'user', content: question }],
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Ansari mcp-complete failed: ${response.status}`);
      }
      return text;
    },
  };
}
