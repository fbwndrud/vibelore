/**
 * What each parked model request carries, for the user: its sections with
 * character counts, and whether it can reuse the cached shared block. The
 * relay layout moves a declared shared text (the chapter prose) into a common
 * prefix when it occurs exactly once in a request; the same rule decides
 * `sharedPrefix` here.
 */
const SHARED = '\u0000shared\u0000';
const HEADING = /^##\s+(.+)$/;
// "라벨: 값" 줄. 목록·인용·괄호로 시작하는 줄과 응답 스키마(JSON:)는 절이 아니다.
const LABEL = /^([^\s\-*[(“"'0-9][^:\n]{0,29}):(?:\s|$)/;

function occurrences(haystack, needle) {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function sharedMembership(requests, sharedContexts) {
  const assigned = new Map();
  for (const context of sharedContexts) {
    if (!context?.text) continue;
    const members = requests.filter((request) => !assigned.has(request.id)
      && typeof request.user === 'string' && occurrences(request.user, context.text) === 1);
    if (members.length < 1) continue;
    for (const request of members) assigned.set(request.id, context);
  }
  return assigned;
}

function sections(user, sharedText) {
  const marked = sharedText && occurrences(user, sharedText) === 1 ? user.replace(sharedText, SHARED) : user;
  const out = [];
  let current = null;
  for (const line of marked.split('\n')) {
    const heading = line.match(HEADING)?.[1] ?? line.match(LABEL)?.[1];
    if (heading && heading.trim() !== 'JSON') {
      current = { heading: heading.trim(), chars: 0, shared: false };
      out.push(current);
    }
    if (!current) {
      current = { heading: '', chars: 0, shared: false };
      out.push(current);
    }
    if (line.includes(SHARED)) {
      current.shared = true;
      current.chars += line.length - SHARED.length + sharedText.length + 1;
    } else current.chars += line.length + 1;
  }
  return out.filter((section) => section.heading || section.chars > 1);
}

export function describeRequestInputs(requests = [], sharedContexts = []) {
  const assigned = sharedMembership(requests, sharedContexts);
  return requests.map((request) => {
    const user = String(request.user ?? '');
    const declared = sharedContexts.find((context) => context?.text && occurrences(user, context.text) === 1);
    return {
      id: request.id, step: request.step,
      chars: { system: String(request.system ?? '').length, user: user.length, shared: declared ? declared.text.length : 0 },
      sharedPrefix: assigned.has(request.id),
      sections: sections(user, declared?.text ?? ''),
    };
  });
}
