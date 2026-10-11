// Only an explicit new rate-limiting/PR instruction selects the tool. Questions,
// refusals and follow-ups stay conversational. No infrastructure action runs here.
export function requestedTool(messages) {
  const last = messages.at(-1);
  if (last?.role !== 'user' || typeof last.content !== 'string') return undefined;
  const text = last.content.toLowerCase();
  if (/\b(should we|whether|how to|how would|did you|have you)\b/.test(text)) return undefined;
  if (/\b(don't|do not|cancel|stop|hold off|wait|never)\b/.test(text)) return undefined;
  const rateLimit = /rate[ -]?limit(?:ing|s)?/.test(text);
  const pr = /\bpr\b|pull request|new branch/.test(text);
  const instruction = /\b(implement|add|code|create|open|put|set up|introduce|build)\b/.test(text);
  return rateLimit && pr && instruction ? 'open_rate_limit_pr' : undefined;
}
