/** Explicit semantic-proof fixture for tests whose subject is another stage. */
export function approvalResponse(request) {
  if (request.step !== 'approval-language-contract') return null;
  const payload = JSON.parse(request.messages.find(message => message.role === 'user').content);
  return { text: JSON.stringify({ language: payload.language, artifactHash: payload.artifactHash, verdict: 'pass', evidence: [], allowedExceptions: [] }) };
}

export function approvalFixtureProvider() {
  return { complete: async request => {
    const answer = approvalResponse(request);
    if (!answer) throw new Error(`Unexpected fixture request: ${request.step}`);
    return answer;
  } };
}
